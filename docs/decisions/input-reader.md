# 输入 Reader 契约（Input Reader Contract）

> 状态：**W-1 已实现并冻结**（2026-10-13，基线 0.8.3 + W-0 安全网）。
> 编号 **AD-21**，是 [AD-20 输入归属契约](input-ownership.md) 的实现第一步：
> AD-20 定"事件归谁"，AD-21 定"事件从哪来"。
>
> 一句话：**Reader 只负责"到了什么"，不负责"它是什么意思"。**
> 它不读 `screen` / `dialog` / composer / workspace，不查 keymap，不改任何 owner 状态。

---

## 1. 位置

```text
stdin / FRAME_STDIN
      │  bytes
      ▼
┌─────────────────────────────────────────────┐
│ InputReader（src/input-reader.ts, AD-21）    │
│  · UTF-8 解码（跨 read 的码点补齐）           │
│  · 设备回复过滤（Guard 30ms 尾窗）            │
│  · 转义序列组装（60ms 持有 + 释放判定）        │
│  · 粘贴边界（\x1b[200~ … \x1b[201~，burst 兜底）│
│  · 单元分类（key / burst / literal / paste）  │
└─────────────────────────────────────────────┘
      │  InputFrame（本文件 §3）
      ▼
handleInputText → consumeFrame → route（今天的阶梯；W-2 变成 Router）
      │
      ▼
owner（Screen / Surface / Composer / Workspace）
```

Reader 是**唯一**允许接触原始字节的地方（除了各投影/探针自己的 stdin 读取，见 §6）。

## 2. 责任表（W-1 审计，逐条落地）

| 责任 | 归 Reader？ | 现在的家 | 备注 |
|---|---|---|---|
| UTF-8 解码 | **是** | `InputReader.decoder`（`StringDecoder`） | 跨 read 切开的码点补齐；trace fixture `utf8-split-code-point` 钉住 |
| 设备回复过滤（CPR） | **是** | `TerminalInputGuard` · `TerminalInputFilter` | 剥 `CSI r;c R`；可能的尾巴持有 **30ms** 后交还输入 |
| 回复尾巴释放 | **是** | 同上 | 分片的 `ESC [ 1` + `7;1R` 不会变成输入框里的 `[17;1R` |
| 转义序列组装（持有/释放） | **是** | `InputReader.held` + `ESCAPE_HOLD_MS = 60` | 释放判定逐字照搬旧的定时器回调 |
| 粘贴标记与框架 | **是** | `InputReader.inPaste` · `frames()` | 标记可跨 read 分片（`paste-split-*` 三个 fixture） |
| 无标记粘贴兜底（burst） | **是** | `InputReader.looksLikePasteBurst()` | 一次 read 里 >1 个换行 = 粘贴；调用方只有两个 |
| 单元分类（形状） | **是** | `InputReader.classify()` | 控制字节 / 完整 CSI/SS3 / burst / 回复；**不认键位** |
| Screen / Surface 判断 | **否** | `tui.ts`（`route`）、W-2 的 Router | Reader 里没有 `screen`/`dialog` 字样 |
| owner 优先级 | **否** | `tui.ts` 的 `route()` | AD-20 §4.3 的表；W-2 抽出 |
| keymap 查表 | **否** | `tui.ts` | `moved = keymap.sequences.get(combined)` 仍在路由侧 |
| 状态变更（草稿/字段/滚动/转写） | **否** | 各 owner | Reader 不写任何 owner 状态 |

**判据**：`src/input-reader.ts` 里出现 `this.screen` / `this.dialog` / `keymap` / `this.input` 任何一个，
就是越界。`npm run freeze:input` 的 `pasteFraming` / `escapeAssembly` / `rawDecoders` 三行是它的门。

## 3. 事件输出（最小集合）

```ts
type InputFrame =
  | { kind: 'key';     sequence: string }  // 一个完整单元：控制字节 / 完整 CSI / 完整 SS3 / 孤立 ESC
  | { kind: 'burst';   text: string }      // 一次 read 的普通输入（可能含多个键——W-3 拆它）
  | { kind: 'literal'; text: string }      // 按原样输入：序列尾巴、Alt 余下部分、持有释放
  | { kind: 'paste';   text: string }      // 标记之间的载荷
  | { kind: 'escape' }                     // 持有结束，确认就是 Esc 键
  | { kind: 'reply';   sequence: string }  // 设备回复（探测器的输入，永不进 owner）
```

设计约束（W-1 冻结）：

1. **不引入事件框架**：没有 emitter、没有优先级数字、没有 `meta`。就是六种 tag 的 union。
2. **`key` 与 `burst` 今天走同一条路由**，区分是为了 W-2：G-1/G-2 这两个"一次 read 多个键"的缺口，
   正是 Router 需要"这是一个键还是几个键"的地方。形状判定放在 Reader（它是唯一理解终端框架的人），
   语义判定留在 Router。
3. **`literal` 是一个真实存在的类别，不是补丁**：SS3 尾巴（`\x1bOAx` 的 `x`）、Alt 余下部分
   （`\x1b1x` 的 `x`）、持有释放（`\x1bO` → `O`）三处旧代码都是**直接** `handlePlainText(text)`——
   不查 keymap、不做 Alt 处理。把它们标成 `literal` 才能保证"搬家"两字成立。
4. **`reply` 永不进 owner**：今天在路由侧被丢弃（`consumeFrame` 里 `case 'reply': return`），
   W-2 接给真正问它的探测器。

## 4. 两个 hold 窗口（明确不合并）

| 窗口 | 位置 | 守什么 | 超时后 |
|---|---|---|---|
| **30 ms** | `TerminalInputGuard`（`INPUT_HOLD_MS`） | **设备回复**：`ESC [ 1` + `7;1R` 可能是一个 CPR 的前后半 | **交还给输入**（当作按键） |
| **60 ms** | `InputReader`（`ESCAPE_HOLD_MS`） | **按键**：孤立 `ESC` 与"Alt 和弦 / 功能键的开头"只能靠时间区分 | **变成 Esc 键或文本**（两条不同出路） |

语义相反（一个"可能是回复"、一个"可能是按键序列"），只是手段相同。合并需要先有"回复/按键"的
事件分类——W-1 已经把分类放进 Reader，但**合并窗口本身不在本轮**（`tests/input-reader.test.mjs`
把两个数字都钉住：`ESCAPE_HOLD_MS === 60`、`INPUT_HOLD_MS === 30`）。

## 5. 行为等价（W-1 的验收方式）

`tests/fixtures/input-reader-traces.json` 是**抽取之前**的构建（HEAD 的 `tui.ts`，没有 Reader）
跑出来的**消费者调用轨迹**：54 个 fixture，每个记录"哪个消费者入口被调用、按什么顺序、带什么参数"，
外加该次运行的终态指纹。`tests/input-reader.test.mjs` 用同一个 fixture 表在新构建上重跑并**逐字节比对**。

覆盖（§6 要求逐项）：printable · UTF-8（含跨 read 切开的码点）· ESC 序列 · 方向键 · PgUp/PgDn ·
鼠标序列 · 粘贴（整段/多行/带 Enter/三种分片）· CPR 回复 · 分片 read · 控制字节 · Alt 和弦 ·
合并 read（G-1/G-2/G-3 必须**保持坏的**）。

三个已知缺口的轨迹被**故意**保留为"坏"（`pgup-twice-one-read`、`rebound-coalesced`、`alt-1-batched`）：
在搬家轮里顺手修好它们，等于把行为变更藏在搬家底下。W-3 修的时候连同 fixture 一起改，并在
commit message 里说清楚。

**轨迹必须与运行环境无关**，否则它比的是环境不是行为。终态记的是"这次 fixture **新增**了几行"
（`rowsAdded`）而不是行数总和——第一次提交时记的是绝对行数，CI 的启动转写比开发机多一行提示，
五条腿全红。这条由 `tests/input-trace.mjs` 的注释与一次"多注入一行启动提示"的本地验证钉住；
`scrollOffset` 之所以仍记绝对值，是因为轨迹把 `screenRows()` 钉成 24，页大小与上限都与环境无关。

## 6. 不归 Reader 的相邻件（记录，不在本轮）

| 件 | 位置 | 为什么不是 Reader |
|---|---|---|
| session picker 自己的 reader | `src/picker.ts`（`TerminalInputGuard` + `escapeBuffer` + `decoder`） | 它跑在 TUI 之前、没有 Screen/dialog；W-7 让它共用 Reader，而不是共用 TUI |
| 探测器 stdin 泵 | `src/terminal-input.ts`（`TerminalInputPump`，自带 decoder） | 它测 RTT/glyph，顺带转发输入；与"读键盘"是两件事 |
| relay 帧解码 | `src/display-sock.ts` | 解的是 socket 帧，不是键盘字节 |
| `screenKeys()` | `src/tui.ts` | Screen 侧的**按键迭代**（0.8.3 加的）；W-3 把它折进 Reader 的 `burst` 拆分 |

## 7. 测试与门（W-1 交付）

| 件 | 作用 |
|---|---|
| `tests/input-trace.mjs` | fixture 表 + 轨迹采集器（观察消费者调用，不替换任何东西） |
| `tests/fixtures/input-reader-traces.json` | 抽取前的参考轨迹（**只增不改**；W-3 那三个按需更新） |
| `tests/input-reader.test.mjs` | 逐 fixture 比对轨迹与终态；分片粘贴；"粘贴的 yes 不算作答"；两个 hold 数字 |
| `npm run freeze:input` 新行 | `readers` 1 · `rawRouters` 1（picker，债）· `rawDecoders` 4 · `pasteFraming` 0 · `escapeAssembly` 1（picker，债） |
| `npm run freeze` | 同一组计数进 CI 两条平台腿 |

Mutation 验证（M1/M2/M3 全部实测会红）：

| # | 变异 | 红的门 |
|---|---|---|
| M1 | 新文件里再写一个 decoder/parser（绕过 Reader） | `rawDecoders 5 > baseline 4` |
| M2 | 改粘贴框架（close marker 换成终端不会发的字节） | 轨迹比对 + 两个分片粘贴用例 |
| M3 | 改 ESC 持有窗口（60 → 200） | 轨迹比对 + 两个窗口数字 + 孤立 Esc 释放用例 |

## 8. 与 AD-20 的关系

AD-20 的优先级表（paste → Ctrl+L → Screen → Surface → Composer/Workspace）**没有改动**，
F-1…F-6 的禁止模式也**没有放宽**：W-1 只是把"读字节"这件事从 `tui.ts` 搬进一个不读 owner 状态的模块，
让 W-2 可以在一个**事件**而不是一段字节上做路由判定。
