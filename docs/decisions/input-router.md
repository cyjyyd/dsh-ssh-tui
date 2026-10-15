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
   │                           └ 文本单元内部同理：逐字符投递时 Screen 一关闭即停（W-3a.1）
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

**W-3a.1 之后**：这条规则在**单元内部**同样成立。文本单元是多字符的，而多字符单元是**逐字符**投递并
逐字符重新判定 Owner 的（这正是 Surface 能"答一个字符、余下交给 Composer"的原因），所以 Screen 的
关闭必须同样终止这次投递：`ESC` 关掉 Screen 后，同一个文本单元剩下的字符既不能进它背后的 Composer，
也不能被重新路由给别的 Owner。粘贴尾巴（`\x1b[201~` 之后的 `\x1bq`）就是这条路径唯一的现实入口。

**W-3b.1 之后**：Surface 的**编辑键**也归 Surface。`Home`/`End`/`Delete` 与 kitty-`Ctrl+Shift+C`
都是序列，曾经在 Surface 打开时被 `SURFACE_COMPOSER_KEYS` 放行给 Composer——于是 Home/End 移动**看不见的**
草稿光标、Delete 编辑它。现在 Router 只回答"Surface 拥有"，`ownerSurface` 再决定：有借用字段就编辑**读者
看得见**的那一行（`textIsEditable()` 判定），没有就消费掉。复制键因此也归 Surface 并被丢弃，与它原来的
可观察行为一致（Composer 的复制在 Surface 打开时本来就拒绝）。

**W-3b.2 之后**：`Ctrl+L` 的两份实现**经审核后保留**（§10，独立审核采纳 KEEP_DUAL）。审核结论是它们并不
重复：帧合成器只有 `composePaintFrame` 一个，"下一帧整屏"通道只有 `forceFullPaint` 一条（两个 painter 各自
消费它），真正不同的是两条**前置语句**与两个 painter 自己的光标/几何/chrome 策略。Router 的表因此一字未改：
Screen 在时归 Screen，否则归 Composer —— 含 Surface 在时那个记录在案的例外（§4）。

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
| 3 | `surfaceKind !== undefined` | **Surface**，除一个记录在案的例外（§4：Ctrl+L） |
| 4 | 其余（无层叠） | 序列：鼠标 / 翻页 → **Workspace**；上下箭头仅在"字段为空且有可折叠卡片"时 → Workspace，否则 → Composer；其余 → **Composer** |

`key`/`burst` 的逐字符语义：`burst` 永远先过一次粘贴判定（多换行即粘贴），再**逐字符**问 Router ——
所以一次 read 里归属可以变化（Surface 用 `y` 作答后，后面的 `es` 归 Composer）。这条由
`yes-typed-at-dialog` 轨迹钉住。

## 4. 记录在案的例外（不是决定，是债）

| 例外 | 现状 | 状态 |
|---|---|---|
| `Ctrl+L` | Screen 在时由 Screen 重绘（`screenNeedsFullPaint`），否则由 Composer 重绘（`repaintNow()`） | **仍在，且已决定保留**（W-3b.2 审核采纳 KEEP_DUAL，见 §10）：这不是"两份实现只有证明一致才能合并"的悬案，而是两个 painter 按各自策略实施同一个 terminal action；Router 的归属一字未改 |
| Surface 在时的 `Home`/`End`/`Delete`/kitty-`Ctrl+Shift+C` | 曾经到达 Composer（移动/编辑**隐藏草稿**的光标），由 `SURFACE_COMPOSER_KEYS` 显式放行 | **W-3b.1 已关闭**：这四个单元现在是 Surface 的，由 Surface 适配器决定语义（编辑它借来的字段，或消费掉） |

W-2 两条都保留（不是它的授权范围，且修复会改变可观察行为）。W-3b.1 关掉第二条。W-3b.2 审核了第一条并按
§10 决定**保留**——它记的是归属，不是实现；例外本身没有消失，也不得被描述成已经消失。

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
| B · 真实路径 | `tests/input-ownership-matrix.test.mjs` | 每个状态 × 每个单元：**恰好一个适配器**被调用；Screen 背后草稿不被任何单元改写（单元清单含"既关屏又带尾巴"的两条粘贴 read——W-3a.1）；无字段 Surface 拒绝文本与粘贴；无人认领的事件不产生状态变化；关屏后草稿与焦点原样回来；resume → 向导；粘贴的 `yes` 不作答 |
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
W-3 可以开始的地方（W-3a / W-3a.1 与 W-3b.1 已走完前两条）：G-1/G-2/G-8/G-3 的逐键规范化
（`burst` 拆分，落在 Reader 或 Router 的 `sequence` 判定上）——**已完成**；Surface 侧的
`SURFACE_COMPOSER_KEYS` 债 —— **W-3b.1 已关闭**；Ctrl+L 的两份实现 —— **W-3b.2 已审核并决定保留**（§10）。

---

## 10. W-3b.2 决策 · KEEP_DUAL（2026-10-14）

> 独立审核的范围是只读的：**不改运行时、不改 Router、不改时序、不合并 painter、不改参考轨迹**。
> 结论经 Independent Gate 采纳为 **KEEP_DUAL — DOCUMENT AND FREEZE**。本节是那份决策的正式记录；
> 证据在 `tests/ctrl-l-repaint.test.mjs` 与 `docs/checkpoints.md` 的 W-3b.2a 节。

### 10.1 合同（冻结）

| 项 | 冻结内容 |
|---|---|
| `Ctrl+L` 是什么 | **terminal repaint action**，不是文本编辑：它不插入、不删除、不移动光标、不改历史、不改滚动、不改焦点、不改任何 dialog 字段 |
| Screen 在时 | 归 **Screen**；由 **Screen painter**（`paintScreen` → `composePaintFrame`）执行完整重绘，`markDirty()` 后由**绘制节奏**取走 |
| Composer 在时 | 归 **Composer**；由 **workspace painter**（`paintFrame` 的工作区体）执行，`repaintNow()` 同步尝试立即绘制 |
| Surface 在时 | Router **仍返回 `composer`**（§4 的例外，保留）；**只使用它的 repaint 执行路径**。Surface 没有自己的 painter，它的行本来就是工作区帧的一部分（`windowInteractionLines` 合成进 `paintRows`） |
| Surface 的文本所有权 | **没有**移交给 Composer：`case '\x0c'` 在 `composerUnit` 的 `dialog` 早返回**之前** `return`，`handleDialogChar` 不会被调用，字段/过滤/借用文本都不被读写 |
| 光标 | 两个 painter 的策略**不同且都正确**：Screen 帧 `hideCursor: true`（帧尾不发 `?25h`），workspace 帧写回 field caret 并发 `?25h` |
| 绘制时机 | 两者**不同且都冻结**：Screen 走 cadence（本地 80 ms / SSH ≤400 ms），workspace 同步尝试立即绘制（背压时 `dirty` 保留，下一拍补画） |
| 清屏 | **允许一次**有意的完整清屏（`\x1b[H\x1b[J`）；**不允许**此后持续整屏清除 —— 两个 painter 都在帧尾恢复尺寸缓存，标志都是一次性的 |

### 10.2 为什么是"保留"而不是"合并"

1. **不是两份实现**：帧合成器只有 `composePaintFrame`；"下一帧整屏"通道只有 `forceFullPaint`
   （17 个设置点，两个 painter 各消费一次）。`Ctrl+L` 的两条路径只差两句前置 + 各自 painter 的策略。
2. **Surface 没有 painter**：把归属改判给 Surface，`ownerSurface` 的兜底仍会转发到同一行
   `case '\x0c'` —— 行为差异为零，却把"实现重绘"的义务搬进 W-3b.3 将要拆分的 Surface 执行体。
   即"搬债"，不是"还债"。
3. **两个 painter 有意不等价**（光标、chrome diff 粒度、`partial`/`dirtyFrom`、分片预算、
   `lastTranscriptStart` 毒化）：合并等于把两套策略取并集参数化，会引入额外清屏/错误光标/调度变化
   的风险；而真正该共用的东西已经共用了。
4. **代码重复本身不是理由**：这里重复的是两条前置语句，不是重绘实现。

### 10.3 一轮清理掉的"半成品"（B2.5 → W-3b.2a）

B2.5 的意图是"一条消息、一个位置"，实现却留了两个位置：`footerEcho` 先放在**状态行**（底栏第一行）
最低优先级处，放不下才退到身份行 —— 于是同一条消息的行号由**它的长度与窗口宽度**决定（`/copy` 的短文案
在第一行、长文案在最后一行，用户报告"copy 提示跑到第一行"）。现在 acknowledgement 恒在身份行，状态行只留
仪表（E-1），`FooterStripInput.echo` 与 budget 的 `echo` 组一并删除。这条与 Router 无关，但它和 §10.1
的"清屏一次、位置固定"是同一种可预测性，故一并记在这里。

### 10.4 未采纳的替代方案

| 方案 | 结论 |
|---|---|
| B1 把 Surface 时的归属改判为 `surface` | 行为等价（`ownerSurface` 兜底到同一行），但把义务搬进 W-3b.3 的拆分；**不在本轮或 RC 前做** |
| B3 Screen 侧改用 `forceFullPaint`（一句、零行为变化） | 可选后续；本轮不做（会动运行时） |
| C 合并为单一 repaint 实现 | **明确否决**：两个 painter 有意不等价，且 ConPTY 腿只能证明"能起能画"，合并的回归面在真机不可见 |

### 10.5 与 W-3b.3 的接口

W-3b.3 拆 `composerUnit` 时，`Ctrl+L` 必须继续由 Composer 执行体持有（Router 现在就这么判）；Surface 侧
**不要**顺手加 `case '\x0c'`，也不要删 `ownerSurface` 对未认领单元的兜底转发 —— W-3b.3 的两条必测风险
（R-HISTORY / R-ALT）与 Ctrl+L 无关，见 `docs/checkpoints.md` 的 W-3b.2a 节。
