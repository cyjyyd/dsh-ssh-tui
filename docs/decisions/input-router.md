# 输入 Router 契约（Input Router Contract）

> 状态：**W-2 已实现并冻结**（2026-10-13，基线 0.8.3 + W-0 安全网 + W-1 Reader）。
> 编号 **AD-22**，接在 [AD-20 归属契约](input-ownership.md) 与 [AD-21 Reader 契约](input-reader.md) 之后。
>
> 一句话：**Reader 决定"到了什么"，Router 决定"交给谁"，Owner 决定"怎么处理"。**
> 三者相邻，不互相替代：Reader 里没有 `screen`/`dialog`/keymap，Router 里没有状态写入，
> Owner 里没有跨 Owner 的归属判定。

---

## 1. 三层调用链（W-2 之后，W-3a 补齐切分）

```text
stdin / FRAME_STDIN
   │ bytes
   ▼
InputReader（AD-21）            decode · 回复过滤 · ESC 组装 · 粘贴边界 · **单元切分**（W-3a）
   │ InputFrame: key | burst | literal | paste | escape | reply
   │ 一个 read 可以出多帧：完整 CSI/SS3、Alt 和弦、控制字节、CR/LF、一段文本各一帧
   ▼
tui.ts
   ├─ handleInputText          assemble → read() → 逐帧 consumeFrame（Screen 关闭后余下丢弃）
   ├─ route()                  **绑定表与解析**（keymap、Alt 和弦、SS3 尾巴、hold、未知 CSI）
   │      │  每个单元问一次 Router
   │      ▼
   │  InputRouter（AD-22）     route(kind, unit, ownershipView) → Owner
   │      │
   │      ▼
   └─ dispatchWith(owner)  ──► ownerScreen / ownerSurface / ownerComposer / ownerWorkspace
                                  │
                                  ▼
                            现有执行体（handleScreenInput / handleDialogChar /
                            composerUnit / scrollWorkspace / 选区 …）
```

**W-3a 之后**：切分只发生在 Reader，Router 看到的**永远是完整单元**——各 Owner 的适配器不再自己拆
read（0.8.3 里只有 Screen 这么做，`screenKeys` 已在 W-3a 删除）。Screen 把整次 read 视为自己的：
它关闭后，同一 read 里余下的单元丢弃；Surface 相反，答案之后的单元继续按 Owner 判定。

**一次判定**：每个单元只问一次 Router；`route()` 在 Screen 归属时直接交给 Screen 适配器，
其余情况才继续走绑定表与解析分支。绑定表不决定归属（AD-20 F-5：一个键只有一张表）。

## 2. Router API

```ts
type Owner = 'screen' | 'surface' | 'composer' | 'workspace'
type UnitKind = 'text' | 'control' | 'sequence' | 'paste' | 'escape'

interface OwnershipSnapshot {          // 只读视图，调用方复用一个对象（零分配）
  screenKind: string | undefined
  surfaceKind: string | undefined
  surfaceHasField: boolean
  composerEmpty: boolean
  workspaceCards: boolean
}

route(kind: UnitKind, unit: string, view: OwnershipSnapshot): Owner
```

纯函数式判定：不读应用状态、不写、不绘制、不推转写。`ownershipView` 由 `tui.ts` 持有并逐字段覆写；
`collapsibleRows()`（唯一昂贵的一项）只在**箭头**且**工作区无任何层叠**时才计算，避免输入热路径的开销。

## 3. 决策规则（照抄既有语义）

| 顺序 | 条件 | 归属 |
|---|---|---|
| 1 | `screenKind !== undefined` | **Screen**（独占键盘；它不用的单元由它自己丢弃，绝不外传） |
| 2 | `kind === 'paste'` | Surface（若在）→ 否则 Composer；**Screen 已在第 1 步终结粘贴** |
| 3 | `surfaceKind !== undefined` | **Surface**，除两个记录在案的例外（§4） |
| 4 | 其余（无层叠） | 序列：鼠标 / 翻页 → **Workspace**；上下箭头仅在"字段为空且有可折叠卡片"时 → Workspace，否则 → Composer；其余 → **Composer** |

`key`/`burst` 的逐字符语义：`burst` 永远先过一次粘贴判定（多换行即粘贴），再**逐字符**问 Router ——
所以一次 read 里归属可以变化（Surface 用 `y` 作答后，后面的 `es` 归 Composer）。这条由
`yes-typed-at-dialog` 轨迹钉住。

## 4. 两个记录在案的例外（不是决定，是债）

| 例外 | 现状 | 为什么保留 |
|---|---|---|
| `Ctrl+L` | Screen 在时由 Screen 重绘（`screenNeedsFullPaint`），否则由 Composer 重绘（`repaintNow()`） | AD-20 §6：两份实现只有在测试证明"不同 Owner 下重绘行为一致"后才能合并；W-2 只给它起了名字并让 Router 显式说出来 |
| Surface 无字段时 `Home`/`End`/`Delete`/kitty-`Ctrl+Shift+C` | 仍到达 Composer（移动/编辑**隐藏草稿**的光标） | 与 W-0 在 Screen 后面发现的泄漏同类；W-2 不改变行为，把它写进 `SURFACE_COMPOSER_KEYS` 让 W-3 能看见并决定 |

W-2 **没有**把这两条修掉：它们不是 W-2 授权范围（§"不修复 G 系列"），而且修复会改变可观察行为。

## 5. 四个 Owner 适配器

| 适配器 | 入口 | 职责 | 内部仍读自己的状态（白名单） |
|---|---|---|---|
| `ownerScreen` | `handleScreenInput(unit, moved)` | 整段 read 交给 Screen（`screenKeys` 拆键、0.8.3 的 burst 规则都在里面） | `screen === undefined` 兜底（拆卸竞态） |
| `ownerSurface` | 箭头 → `moveQuestionCursor`；鼠标 → 既有拒绝路径；其余 → `composerUnit` | Surface 拥有键盘；无字段时自己的分支就是"拒绝" | `handleDialogChar` 内的 `dialog` 读取 |
| `ownerComposer` | 箭头 → `arrowHistory`（补全 → 历史）、光标键、`composerUnit` | 草稿、历史、补全、编辑键 | `textIsEditable()`（`dialog`/`borrowedText`） |
| `ownerWorkspace` | 滚轮/翻页 → `scrollWorkspace`；拖拽 → 选区；上下箭头 → `moveFocus` | 转写、选区、链接、焦点环 | 选区方法里的 `dialog`/`screen` 兜底（记录在案） |

`composerUnit` 是 Composer 与 Surface 共用的**兼容执行体**（旧 `handleChar` 的 switch 与尾巴）：
它的 `dialog` 分支就是 Surface 对这些键的行为，拆开它们是 W-3 的事。Router 保证的是
**Screen 永远不会进入它**，因此其中的键只可能花在读者看得见的字段上（自己的或借来的）。

## 6. G-6 去重结果

| 项 | 处理 |
|---|---|
| `handleChar` 里不可达的第二个 Screen 门 | **删除**（连它所在的方法体一起被适配器取代） |
| `handleChar` 顶部的 Screen 门 | **删除**：归属判定移到 Router |
| `scrollActiveSurface` 的两处 `screen`/`dialog` 分支 | **删除**：拆成 Router 判定 + `scrollWorkspace`（转写）与 `handleScreenInput`（报告屏） |
| 两处 SGR 鼠标解析 | **合并**成一个 `SGR_MOUSE_RE`，两个适配器共用 |
| Ctrl+L 的两份实现 | **保留**（§4），但抽出 `repaintNow()` 命名，Router 显式路由 |

## 7. 测试与门

| 层 | 文件 | 内容 |
|---|---|---|
| A · 纯决策 | `tests/input-router.test.mjs` | 每条规则一张断言；全组合扫描保证"永远是四个 Owner 之一"；快照冻结验证纯函数 |
| B · 真实路径 | `tests/input-ownership-matrix.test.mjs` | 每个状态 × 每个单元：**恰好一个适配器**被调用；Screen 背后草稿不被任何单元改写；无字段 Surface 拒绝文本与粘贴；无人认领的事件不产生状态变化；关屏后草稿与焦点原样回来；resume → 向导；粘贴的 `yes` 不作答 |
| B · 轨迹等价 | `tests/input-reader.test.mjs` | **72 条 fixture / 246 次边界调用 + 终态**，与抽取前构建逐字节一致 |
| 静态棘轮 | `scripts/input-freeze-audit.mjs` | 见 §8 |

## 8. Freeze Ratchet：before → after

| 计数 | W-0/W-1 | W-2 | 说明 |
|---|---|---|---|
| `ownerReads.screen` | 31 | **25** | Screen 归属判定集中到 Router；`scrollActiveSurface` 的两处、`handleChar` 的两道门消失 |
| `ownerReads.dialog` | 59 | **54** | 同上（`scrollActiveSurface` 的 dialog 分支、`handleChar` 覆盖的判定） |
| `rawBranches` | 13 | **8** | 序列形状识别集中到 `isSequenceShape` 与适配器 |
| `mouseParsers` | 2 | **1** | 两处 SGR 解析合并 |
| `deadScreenGate` | 1 | **0** | 不可达的第二个 Screen 门删除 |
| `guards`（原 `routers`） | 2 | 2 | Reader 的 + picker 自己的（W-7 债，未动） |
| `routers`（新） | — | **1** | `src/input-router.ts` 是唯一 Router 模块 |
| `routerCallSites`（新） | — | **3** | `route()` 的整段判定、`dispatch()` 的逐单元判定、`dispatchPaste()` 的粘贴判定；第四个就是第二个 dispatcher |
| `pasteFraming` / `escapeAssembly` / `readers` | 0 / 1 / 1 | 不变 | Reader 侧边界未动 |
| `knownGaps` | 3 | 3 | G-1/G-2/G-3 仍是 W-3 的事 |

未新增任何白名单：四个适配器对**自身**状态的读取（`handleScreenInput` 的兜底、`handleDialogChar` 的
`dialog`、`textIsEditable()`、选区方法的兜底）本来就是既有行为，仍在计数里，只是不再由路由读取主导。

## 9. 与 AD-20 / AD-21 的关系

AD-20 的优先级表与 F-1…F-6 全部保持：F-1 现在由 Router 独家回答；F-4 的"第二套 router"仍是
picker（W-7）；F-5 的"一个键一处处理"由 `route()` 的绑定表唯一持有。
AD-21 的 Reader 一个字节未改（`tests/input-reader.test.mjs` 的 72 条轨迹是证据）。
W-3 可以开始的地方：G-1/G-2/G-8/G-3 的逐键规范化（`burst` 拆分，落在 Reader 或 Router 的 `sequence`
判定上）、Surface 侧的 `SURFACE_COMPOSER_KEYS` 债、Ctrl+L 的两份实现。
