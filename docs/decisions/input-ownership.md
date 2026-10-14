# 输入归属契约（Input Ownership Contract）

> 状态：**提案，供 0.8.4 实现**（审计日期 2026-10-13，基线 **0.8.3**）。
> 本文**不含实现**：它定义契约、记录现状（每条都有实测）、列出泄漏与丢失风险、给出实现依据。
> 实现顺序与拆解见 [`../plans/0.8.4-input-ownership.md`](../plans/0.8.4-input-ownership.md)。
>
> 编号 **AD-20**。AD-1…AD-19 属 B2，**已冻结**；本文不修改它们，只在其上补"输入"这一层。
> 与 B2 的接口见第 7 节。
>
> **契约一句话**：一次 read 不是一次输入；**一个事件只有一个 owner**；owner 之外，
> **任何 consumer 都不许读 `screen` / `dialog` 来决定自己该不该处理**。

---

## 1. 现状（0.8.3 实测）

### 1.1 唯一漏斗（entry points）

| 入口 | 代码位置 | 说明 |
|---|---|---|
| 直接 TTY | `process.stdin.on('data', this.handleData)` | 本地/SSH 直接跑（`start()` 里注册，校准绘制间隔之后） |
| Host relay | `display-sock.ts` 的 `FRAME_STDIN` → `handlers.onStdin` → `this.handleData(bytes)` | 桌面端/Host 模式：**按键是走 socket 过来的字节**，与 TTY 完全同路 |
| 行模式直接跑 | 同上 `handleData` | 行模式没有帧；**向导仍然是 Screen**（按键路由与框模式同路），报告类则改为转写行（`reportRowKind`） |
| 探测回复 | `TerminalInputGuard` 的 `TerminalInputFilter` | `CSI row;col R` 在**到达 `handleInputText` 之前**被剥掉（30ms 尾窗） |

```text
stdin / FRAME_STDIN
   └→ handleData(chunk: Buffer)
        └→ StringDecoder('utf8')            // 只在这里处理"字节被切开"
             └→ TerminalInputGuard.push()   // 剥 CSI 6n 回复 + 30ms 尾部持有
                  └→ handleInputText(text)  // ← 唯一的决策点
```

**已经是单漏斗**：所有字节入口都汇到 `handleInputText`。缺陷不在入口数量，而在 `handleInputText`
**之后**的分发方式（每个 consumer 自己读 `screen`/`dialog`）。

### 1.2 `handleInputText` 的决策阶梯（照抄现状，顺序即优先级）

| # | 判定 | 归属 | 备注 |
|---|---|---|---|
| 0 | `combined = escapeBuffer + text` | Reader | `\x1b` / CSI 前缀最多持有 **60ms**（`escapeTimer`） |
| 1 | 有 `\x1b[200~`/`\x1b[201~` 或 `inPaste` | Reader → paste | `processPasteChunk` 拆标记；标记内 → `handlePasteText`，标记外 → `handlePlainText` |
| 2 | `moved = keymap.sequences.get(combined)` | Keymap | **整段字符串相等**才算一次绑定命中 |
| 3 | `screen !== undefined` | **Screen** | `handleScreenInput`；`moved` 只被用于 `copy` |
| 4 | `dialog === undefined` 时的 keymap 覆盖 / suppressed | Keymap | `runKeyAction`；被 suppressed 的键在此丢弃 |
| 5 | `^\x1b\[[A-D]$` | Surface / Composer / Workspace | 依次问：question 光标 → dialog → 命令建议 → 焦点环（仅空字段）→ 历史 |
| 6 | SGR 鼠标 `\x1b[<b;x;yM/m` | Workspace / Screen | 滚轮 → `scrollActiveSurface`；拖拽/点击 → 选区（`selection.ts`） |
| 7 | `\x1b[5~` / `\x1b[6~` | Workspace / Screen | `scrollActiveSurface` |
| 8 | `parseCursorPositionReply` | Reader | 漏网的 CPR 在此再丢一次 |
| 9 | Home/End/Delete/`\x1b[99;6u` | Composer | 行首/行尾/前删/复制 |
| 10 | SS3 `\x1bO[A-Z]` + 尾巴 | Reader → 尾巴当文本 | `handlePlainText(rest)` |
| 11 | `isEscapePrefix(combined)` | Reader | 持有 60ms；**分片的粘贴标记靠这一步才拼得回来** |
| 12 | 未知 `\x1b[` / `\x1bO` 开头 | 无 | **静默吞掉**（focus 事件目前靠这条兜住） |
| 13 | `\x1b` + 其余 | Workspace | Alt+1…4（跳类别）、Alt+n/p（搜索步进）、Alt+f/F//（`/find`），其余当文本输入 |
| 14 | 其它 | Composer | `handlePlainText` → 多换行即粘贴 → 逐字符 `handleChar` |

### 1.3 `handleChar` 阶梯

| # | 判定 | 归属 |
|---|---|---|
| 1 | `screen !== undefined` | **Screen**（0.8.3 提到最前；此前只在 setup 时生效） |
| 2 | `switch`：Esc / Enter / DEL / Ctrl+C / Ctrl+D / Ctrl+L / Ctrl+A·E / Ctrl+U·K / Ctrl+N·P / Ctrl+R / Ctrl+T | Composer（`Ctrl+D` 额外看 `screen`/`dialog`） |
| 3 | `screen !== undefined`（**已不可达**） | — 死代码，见 G-6 |
| 4 | `dialog !== undefined` → `handleDialogChar` | Surface |
| 5 | Ctrl+G / Ctrl+_ / Tab（命令补全）/ 可打印字符 | Composer |

### 1.4 `handleScreenInput` 阶梯（0.8.3 之后）

| # | 判定 | 说明 |
|---|---|---|
| 1 | `\x0c`（Ctrl+L） | Screen 级全局：整屏重画 |
| 2 | `looksLikePasteBurst` | 无括号粘贴的控制台：一次 read 多个换行 = 粘贴 |
| 3 | `screenKeys` 拆分 | 一次 read 拆成多个键，逐个重入本函数 |
| 4 | `setup` | `handleSetupKey`：自己的字段、自己的九步 |
| 5 | `screenSurface` | Screen 自己问的确认（y/n/Esc） |
| 6 | `moved === 'copy'` | 复制当前 Screen 的 `copyText` |
| 7 | SGR 鼠标 | **只认滚轮**（64/65）；点击与拖拽一律无视 |
| 8 | 方向键 / PgUp·PgDn / Home·End | 滚 Screen 自己的 `offset` |
| 9 | `inspectClosesOn`（Esc / Ctrl+C / q / Q / Enter） | 关 Screen |
| 10 | 可打印字符 | 不吞：在 hint 行回一句"这里不能输入" |

### 1.5 跨 read 状态（为什么"分片"是常态而不是边角）

| 状态 | 位置 | 生命周期 |
|---|---|---|
| `inPaste` | TUI | 从 `\x1b[200~` 到 `\x1b[201~`（可能跨多次 read） |
| `escapeBuffer` + `escapeTimer` | TUI | 60ms；持有 `\x1b`、`\x1b[`、未完成的 CSI |
| `TerminalInputFilter.held` + 30ms 定时器 | `terminal-input.ts` | 持有"可能是 CPR 回复"的尾巴 |
| `StringDecoder` | TUI + pump | UTF-8 码点被切开时补齐 |
| `pendingMouseClick` / `mouseAnchor` | TUI | 按下到松开之间 |

**这是当前架构最重要的性质**：`handleInputText` 收到的是"**一次 read**"，不是"一个键"。
0.8.3 修好的三个缺陷（粘贴、`text\r`、Screen 内的多键）全部是这条性质的直接后果。

### 1.6 owner 能力矩阵（现状）

| 能力 | Screen | Surface（dialog） | Composer | Workspace |
|---|---|---|---|---|
| 可打印字符 | setup：进自己的字段；report/inspect：只回 hint | 无选项的 question：借字段；其它：忽略 | 插入草稿 | — |
| Enter | setup：下一步；report/inspect：关闭 Screen | picker/confirm：作答 | 提交消息 | — |
| Esc | 关 Screen（setup 里先退一步） | 取消/关闭 | 取消当前动作 | — |
| Ctrl+C | 关 Screen（setup 里退一步/取消向导） | 交给 `handleEscape` | 取消回合 / 二次退出 | — |
| 方向键 | 滚 Screen / 移动高亮 | 移动光标或选项 | 历史或焦点环 | 焦点环 |
| PgUp/PgDn | 滚 Screen | 丢弃（不穿透） | 滚转写 | 滚转写 |
| 滚轮 | 滚 Screen | 丢弃 | 滚转写 | 滚转写 |
| 点击 | 无 | 无 | 链接/卡片 | 链接/卡片/聚焦 |
| 拖拽选择 | **无**（G-5） | 无 | 有（`selection.ts`） | 有（复制后清空草稿，G-10） |
| 粘贴 | setup：进字段；其它：丢弃 | 有字段则进字段；否则丢弃 | 进草稿 | — |
| Ctrl+L | 整屏重画 | 无 | 整屏重画（另一套实现，G-6） | 同左 |
| resize | 任何 owner 都不拥有：Renderer 处理 | | | |
| focus 事件 | 未启用；意外收到时被"未知序列"吞掉（G-7） | | | |
| Ctrl+V（`0x16`） | 无人处理（现代终端自己粘贴，G-4） | | | |

---

## 2. 事件表：事件 → 现路由 → owner → 风险

「实测」列来自本轮审计脚本（`.pf/input-audit.mjs`、`.pf/input-audit2.mjs`，见 §3 说明）。

### 2.1 键盘

| 事件 | 现路由 | owner | 实测 / 风险 |
|---|---|---|---|
| 可打印字符（单键一次 read） | `handleInputText` → 阶梯 3/14 → `handleChar` | Composer / setup 字段 | ✅ 正常 |
| 可打印 + Enter 同一次 read（composer） | 阶梯 14 → 逐字符 | Composer | ✅ 提交成功（`historyIndex` 增长） |
| 可打印 + Enter 同一次 read（setup） | `screenKeys` 拆分 | setup 字段 | ✅ 0.8.3 修好（此前丢 Enter） |
| 方向键（单独） | 阶梯 5 | Workspace / Screen | ✅ |
| **两次方向键同一次 read** | 阶梯 5 的**整段相等**失败 → 阶梯 11/12 | **无人** | ❌ **两个键全丢**（实测 `no change`） |
| **两次 PgUp 同一次 read** | 阶梯 7 失败 → 阶梯 12 | **无人** | ❌ **全丢**（单键 PgUp 滚 12 行，双键 0 行） |
| PgUp 在 Screen 内（双键同 read） | `screenKeys` 拆分 | Screen | ✅ 两次都生效（40→2） |
| Ctrl+字母（单键） | `handleChar` switch | Composer | ✅ |
| **rebind 后的键 + 同 read 其它键** | 阶梯 2 **整段相等**失败 | 无人 | ❌ 绑定丢失（`ctrl+p` 单独滚 12 行，两次同 read 全丢） |
| Esc（单独） | 阶梯 0 持有 60ms → 阶梯 13 | Composer / Screen | ✅（见 `tests/terminal-input.test.mjs`「a lone escape is released after the hold」） |
| Esc + 后续键同一次 read | 阶梯 13 的 Alt 分支 | Workspace | ⚠️ 见下一行 |
| **Alt+1 与下一个字符同一次 read** | 阶梯 13：`alt='1x'` 不匹配 → 当文本 | Composer | ❌ Alt 和弦丢失且**字符泄漏成文本**（实测输入 `1x`） |
| Alt+1（单独） | 阶梯 13 | Workspace | ✅ 跳类别 + `find-feedback` 行 |
| Ctrl+Shift+C（kitty 协议） | 阶梯 9 | Composer | ✅（未启用 kitty 协议，仅兼容已开启的终端） |
| Ctrl+V（`0x16`） | 无人匹配 | 无人 | ⚠️ 无动作（不泄漏）；见 G-4 |

### 2.2 粘贴

| 事件 | 现路由 | owner | 实测 / 风险 |
|---|---|---|---|
| 括号粘贴（完整） | 阶梯 1 → `handlePasteText` | setup → 字段；有字段的 Surface → 借字段；其它 → 丢弃 | ✅ 0.8.3 修好 |
| 括号粘贴（**标记跨 read 分片**） | 阶梯 11 拼回标记 → 阶梯 1 | 同上 | ✅（实测 `\x1b[20` + `0~sk-live\x1b[201~` → 草稿得到 `sk-live`） |
| 无括号粘贴、多换行 burst | `looksLikePasteBurst` → `pasteIntoScreen` / `handlePasteText` | 同上 | ✅ |
| 无括号粘贴、单行 | 逐字符 → `handleChar` | Composer / setup 字段 | ✅（老控制台单行粘贴本来就能用） |
| 拒绝粘贴的 Surface/Screen | `textIsEditable()` / `pasteIntoScreen` | 丢弃 | ✅（确认框、picker 不接收；实测 `no change`） |

### 2.3 鼠标

| 事件 | 现路由 | owner | 实测 / 风险 |
|---|---|---|---|
| 滚轮（composer） | 阶梯 6 → `scrollActiveSurface` | Workspace | ✅ 上滚 3 行 |
| 滚轮（Screen） | `handleScreenInput` 7 | Screen | ✅ 40→43 |
| 滚轮（Surface 打开） | `scrollActiveSurface` 里 `dialog !== undefined` 直接返回 | Surface | ✅ 不穿透 |
| 拖拽（composer，可复制行） | 阶梯 6 → `begin/extend/endMouseSelection` → `copyPlainText` | Workspace | ✅ 选择语义见 `tests/mouse-selection.test.mjs`；**复制后草稿被清空**（G-10） |
| 拖拽（Screen 内） | 两个分支都拒绝 | **无人** | ⚠️ 设计如此（G-5）：Screen 里只有 `/copy` 与 `Ctrl+Shift+C` |
| 点击（composer） | 阶梯 6：链接优先（复制链接），其次卡片展开 | Workspace | ✅（链接点击会清空草稿，G-10） |
| 点击（Screen 内） | 显式拒绝 | 无人 | ✅ 设计（"Screen 背后不是目标"） |
| Motion 无按键（`?1002h` 之外的 35+） | 无匹配 | 无人 | ⚠️ 未定义（当前终端只开 1002，不会发） |

### 2.4 其它

| 事件 | 现路由 | owner | 实测 / 风险 |
|---|---|---|---|
| resize（直接） | `stdout.on('resize')` / `SIGWINCH` → `requestResizePaint` | Renderer | ✅ 与输入路径无关 |
| resize（relay） | `onResize` → `attachRelayDisplay` / `requestResizePaint` | Renderer | ✅ |
| resize + 正在粘贴 | 无耦合 | — | ⚠️ 无测试（T-5） |
| CPR 回复（`CSI r;c R`） | Guard 剥掉；阶梯 8 兜底 | Prober | ✅ |
| CPR 回复分片跨 read | Guard 的 30ms 持有 | Prober | ✅ `tests/terminal-input.test.mjs` |
| focus in/out（`CSI I` / `CSI O`） | 阶梯 12 未知序列吞掉 | 无人 | ⚠️ **靠巧合**：没有显式分支、没有测试（G-7） |
| 未知 CSI / 函数键 | 阶梯 12 / 9 | 无人 | ✅ 静默丢弃（有意） |
| UTF-8 码点跨 read 分片 | `StringDecoder` | Reader | ✅ |
| read 里的 `\x1b` 前缀分片 | 60ms 持有 | Reader | ✅ |

---

## 3. 实测缺陷清单

> 全部用真实 `SshTui`（`lib/`，即 0.8.3 的构建）跑出，脚本在 `.pf/`（git 排除，不进仓库）。
> 复现方式：构造 fixture → `tui.handleData(Buffer.from(<序列>))` → 对比
> `{input, cursor, historyIndex, scrollOffset, screen.offset, dialog, focusedRow}` 的前后差异。
> 这些序列就是 0.8.4 要变成用例的清单（§5 T-2/T-3）。

| ID | 现象 | 触发 | 实测 | 性质 |
|---|---|---|---|---|
| **G-1** | composer 里一次 read 的多个键**全部丢失** | `\x1b[5~\x1b[5~`、`\x1b[B\x1b[B`、`\x1b[A\x1b[A` | `no change`（单键 PgUp 滚 12 行） | 丢失（用户按键无反应）——**W-3a 已修**，见 §12 |
| **G-2** | rebind 的键与别的键同 read 时绑定失效 | `keys: {pageUp: 'ctrl+p'}` + `\x10\x10` | `no change`（单发滚 12 行） | 丢失——**W-3a 已修**，见 §12 |
| **G-3** | Alt 和弦与下一字符同 read：和弦丢失、字符当文本 | `\x1b1x` | 输入变成 `1x` | 丢失 + **泄漏**（本该跳类别）——**W-3a 已修**，见 §12 |
| **G-4** | `0x16`（Ctrl+V）无任何处理 | `\x16` | `no change` | 未定义（不泄漏；终端自己粘贴） |
| **G-5** | Screen 内不能拖拽选择 | Screen 内 button 32/0 | `no change`（有意拒绝） | 能力缺口（`/copy` 是唯一路径） |
| **G-6** | 同一件事有两份实现 / 死代码 | `handleChar` 第二个 Screen 门（`A Screen owns the keyboard here too`）已不可达；Ctrl+L 在 composer 是 `render()`、在 Screen 是 `screenNeedsFullPaint`；`picker.ts` 自带一套 guard+escapeBuffer+escapeTimer | 代码审阅 | 结构债（下一轮最容易改错的地方） |
| **G-7** | focus 事件靠"未知序列"兜住 | `\x1b[I` / `\x1b[O`（composer、Screen、dialog 三种 owner 下） | `no change` ✅ | **无测试的隐式契约**：将来加一条 `CSI ... I` 分支就可能误吞/误判 |
| **G-8** | Screen 内粘贴/复制的 rebind 键同 read 失效 | 同 G-2（`moved === 'copy'` 只在整段相等时成立） | 代码审阅 + G-1 同源 | 丢失——**W-3a 已修**，见 §12 |
| **G-9** | 两个 hold 窗口做同一种事 | Guard 30ms（CPR 尾） vs TUI 60ms（ESC 前缀） | 代码审阅 | 结构债：分片规则分散在两处 |
| **G-10** | **任何复制路径都清空 composer 草稿**（**W-0 已修**，见 §8） | `/copy`、rebind 的复制键、Screen 内的复制键、拖拽选择、链接点击（都汇到 `copyPlainText`） | 修复前：`我打了一半的消息`（caret 3）→ 三条路径全变 `""` / caret 0；修复后原样保留 | **越权写**：Workspace/Surface 的动作改了 Composer 的状态。清空本是给"`/copy` 这条命令提交后别留在输入框里"写的（`git log -L` 追到 0.5.5 时代），但复制键与鼠标手势没有命令文本要清；命令行的消费现在只由 `runCommand` 负责 |

**没有发现的泄漏**（本轮逐格测过，值得写下来当基线）：Screen 打开时 composer 草稿不被任何键改写；
dialog 打开时转写不滚动；Surface 无字段时粘贴不改草稿；Screen 内的点击数不到背后行。

---

## 4. 目标模型

### 4.1 三层

```text
        bytes ─────────────► Reader ─────────────► Router ─────────────► Owner
   (stdin / FRAME_STDIN)   decode · 剥离回复      唯一读 screen/dialog    处理自己的事件
                           ESC 组装 · 分片        决定"谁来处理"          写自己的状态
                           粘贴标记 · 拆键
```

- **Reader**：唯一允许接触原始字节的地方。拥有 `StringDecoder`、回复剥离、`escapeBuffer`/hold 窗口、
  `inPaste`、以及**拆键**（`screenKeys` 的推广）。它输出 **Raw Input Event**，一个事件一个对象/一个标签。
- **Router**：唯一允许读 `screen` / `dialog` 来决定归属的地方。纯函数式判定：
  `route(event, { screen, surface, composer }) → Owner`。它不改状态、不写行、不绘制。
- **Owner**：Screen / Surface / Composer / Workspace 四选一，实现窄接口；**只处理自己的事件**，
  未处理的事件由 Router 决定丢弃（不转发给下一个 owner）。

### 4.2 Raw Input Event

```ts
type InputEvent =
  | { kind: 'key';     key: KeyId; raw: string; mods: Mods }        // KeyId: 'enter' | 'escape' | 'ctrl+u' | 'pgup' | 'char:a' | ...
  | { kind: 'text';    text: string }                                // 一段可打印文本（可能多字符）
  | { kind: 'paste';   text: string; lineBreaks: boolean }           // 已完成标记解析
  | { kind: 'mouse';   action: 'press'|'release'|'motion'|'wheel'; button: number; x: number; y: number }
  | { kind: 'resize';  columns: number; rows: number }
  | { kind: 'focus';   focused: boolean }
  | { kind: 'reply';   reply: CursorReply }                          // 探测答案，永不进 owner
  | { kind: 'unknown'; raw: string }                                 // 有记录，无动作
```

要点：
1. **`paste` 是事件类型，不是文本**：一个粘贴永远是一个事件，无论它跨了多少次 read、里面有多少换行。
2. **`text` 与 `key` 分开**：这样"粘贴不算作答"（confirm / picker）这条既有规则在新模型里是**类型系统**的结论，
   而不是每个 owner 各自记得的判断。
3. **`reply` 永不进 owner**：它由 Reader 直接交给 Prober（现在就是这样，契约只是把它写死）。
4. **`resize` 不是输入**：Router 直接交给 Renderer，任何 owner 都看不到它。

### 4.3 路由优先级（一次判定，命中即停）

| 优先级 | 事件 | 目标 | 理由 |
|---|---|---|---|
| 0 | `reply` | Prober | 终端自己对探测的回答，不是用户输入 |
| 0 | `resize` | Renderer | 环境变化，不是意图 |
| 1 | `paste` | Screen(有字段) → Surface(有字段) → Composer → 丢弃 | 粘贴是文本输入；谁有字段谁收；都没有就丢（不许落到别人的草稿） |
| 2 | `key: ctrl+l` | 当前最大 owner，动作固定为"整屏重画" | 终端级键，与终端状态有关，与 owner 无关 |
| 3 | 其它 `key`/`text` | `screen` 若在 → Screen | Screen 独占屏幕，也独占键盘（B2.6 §4） |
| 4 | 否则 `surface`（dialog）若在 | Surface | 对话框存在时不允许穿透 |
| 5 | 否则 | Composer（有焦点）或 Workspace | 箭头/滚轮/拖拽按"composer 有没有内容"细分（现有规则） |

Owner 内部的二次路由（例如 Screen 里 setup vs report vs inspect）**留在 owner 实现里**：
Router 只回答到"四个 owner 之一"，不再往下猜。

### 4.4 owner 接口（实现阶段落地）

```ts
interface InputOwner {
  readonly owner: 'screen' | 'surface' | 'composer' | 'workspace'
  /** 处理一个事件；返回 false = 我没用它（由 Router 丢弃，绝不转交）。 */
  handle(event: InputEvent): boolean
  /** 该 owner 是否拥有可编辑字段（决定 paste 的落点）。 */
  readonly hasField: boolean
}
```

### 4.5 禁止模式（forbidden patterns）

| ID | 禁止 | 为什么 | 检查方式（可进 freeze 审计） |
|---|---|---|---|
| **F-1** | owner 实现之外读 `this.screen` / `this.dialog` 来决定处理与否 | 这正是 0.8.2→0.8.3 三处缺陷的共同形状 | 扫描 `tui.ts`：`this.screen !== undefined` / `this.dialog !== undefined` 只允许出现在 router 段与各 owner 的方法体内（白名单行号/方法名） |
| **F-2** | 在 owner 之外直接写 `this.input` / `this.cursor` | 草稿只有 composer 拥有（B2.6 §5） | 扫描：`this.input =` / `this.cursor =` 只允许在 composer 段 |
| **F-3** | 在输入处理里 `pushRow` / 写 notice（除 owner 自己的消息通道） | Screen 不许写转写（B2.6 §12/§13）；输入路径只做输入 | 沿用现有 freeze 审计（`onboarding-transcript-producer` 等） |
| **F-4** | 第二个 router（例如 `picker.ts` 自带的一套 guard + escape 组装） | 两份实现必然漂移（0.8.3 的 `text\r` 就是只修了一处） | 扫描：`new TerminalInputGuard(` 只允许出现在 Reader 里 |
| **F-5** | 一个键在两处被处理（硬编码分支 + keymap 表） | 优先级表必须唯一（G-1/G-2 的根因） | 扫描：`combined === '\x1b[` 只允许出现在 Reader 的拆键里 |
| **F-6** | owner 之间转交事件（"我不处理就给别人"） | 转交是 0.8.1 之前泄漏的机制；现在的规则是丢弃 | 代码审阅 + T-2 的"其它 owner 状态不变"断言 |

### 4.6 迁移映射（现状 → 目标）

| 现状 | 目标位置 |
|---|---|
| `handleData` + `decoder` + `inputGuard` | Reader（`src/input-reader.ts`，建议） |
| `escapeBuffer` / `escapeTimer` / `isEscapePrefix` | Reader |
| `inPaste` / `processPasteChunk` | Reader |
| `screenKeys` / `looksLikePasteBurst` | Reader（`screenKeys` 推广到所有 owner） |
| SGR 鼠标解析（`handleScreenInput` 第 7 步 与 `handleInputText` 阶梯 6 各一份） | Reader（解析成 `mouse` 事件） |
| `handleInputText` 的阶梯 2–14 | Router（判定）+ 四个 owner adapter |
| `handleChar` 的 switch | Composer owner + keymap 表（一份） |
| `handleSetupKey` / `handleScreenInput` | Screen owner |
| `handleDialogChar` / `handlePasteText` 的借字段分支 | Surface owner |
| `submit` / `backspace` / `moveCursor` / `insertIntoField` / 历史 | Composer owner（`fieldText`/`setField` 收成 owner 私有） |
| `scrollActiveSurface` / `begin·extend·endMouseSelection` / `copyKey` | Workspace owner（Screen 版本留给 Screen owner） |
| `picker.ts` 的 guard/escape 组装 | Reader（共享），picker 只保留自己的 owner 逻辑 |

---

## 5. 测试要求

| ID | 要求 | 落点 |
|---|---|---|
| **T-1** | **事件 × owner 全表**：每个事件在每个 owner 下"恰好一个 owner 消费"，并断言其它 owner 的状态不变 | 扩写 `tests/interaction-surface.test.mjs` 的 `one owner per key` 表；新增 `tests/input-router.test.mjs` |
| **T-2** | **状态指纹断言**：每次按键前后对 `{draft, caret, historyIndex, scrollOffset, screen.offset, dialog.cursor, focusedRow, rows.length, notice/echo}` 取快照，除预期字段外必须逐项相等 | 新增共享 helper（`tests/input-fingerprint.mjs`），上面那张表里复用 |
| **T-3** | **合并 read 矩阵**：1/2/3 键打包、`text\r`、CRLF、粘贴标记跨 read 分片、UTF-8 码点分片、ESC 前缀分片 | `tests/terminal-input.test.mjs`（Reader）+ 新表 |
| **T-4** | **探测回复注入**：在每个 owner 下注入 `CSI r;c R`（完整/分片/迟到的），断言不进任何字段、不改任何状态 | 扩写 `tests/terminal-input.test.mjs` |
| **T-5** | **真 PTY 才产得出来的**：向导里粘贴（已有）、Screen 内拖拽、粘贴过程中 resize、ConPTY 下合并 read（Windows 腿） | `scripts/tui-setup-probe.mjs`（已有）、`scripts/tui-probe.mjs`、Windows 腿 |
| **T-6** | **冻结审计扩写**：F-1 / F-2 / F-4 / F-5 变成 `npm run freeze` 的计数器（0 容忍） | `scripts/b2-freeze-audit.mjs` |
| **T-7** | **一次性回归门**：G-1…G-3、G-8 的触发序列成为用例；修好前后各跑一次（红→绿） | 新增用例，落点同 T-1 |

原则：**先加 T-1/T-2 的表，再动实现**（否则重构没有安全网）；T-6 与实现同批落地。

---

## 6. 未决问题

1. **`Ctrl+C` 的归属**：现在是"Screen 里关 Screen、dialog 里取消、composer 里取消回合"，三条分支分别写在
   三个地方。契约建议：Ctrl+C 是**终端级键**（与 Ctrl+L 同类），动作由 Router 统一给出，
   "关 Screen / 取消回合"是它的策略。需要产品侧确认（0.8.3 之前的行为即现状，见 §1.6）。
2. **Screen 内的选择（G-5）**：搜索 Screen 需要"结果可选可复制"，这会第一次要求 Screen 拥有选区。
   建议先在契约里把选择定义成 Workspace 的能力，Search Screen 通过 Workspace 的只读视图使用它。
3. **focus 事件（G-7）**：是否启用 `?1004h`？启用后 `CSI I/O` 会变成常态事件。
   建议本轮**只显式吞掉 + 测试**，不启用。
4. **`0x16`（G-4）**：无法从进程内读系统剪贴板（除 OSC 52 读回，终端普遍禁用）。
   建议保持"不处理"，但在 hint 里说明"用终端自己的粘贴快捷键"。
5. **`unknown` 事件的去处**：建议记录（`/diag` 计数）而不是静默丢弃——用户报"某键没用"时才有数据。

---

## 7. 与 B2 的关系（不得破坏的不变量）

| B2 不变量 | 本契约如何保持 |
|---|---|
| Screen 深度 ≤ 1 | Router 只做"四个 owner 之一"，不引入新的层叠 |
| Screen 不许写转写（`setupMessage` 是唯一例外且只在行模式） | F-3：输入处理不许 `pushRow` |
| 草稿只属于 composer | F-2 + composer owner 私有 `fieldText`/`setField` |
| Surface 在 Screen 后面排队，不穿透 | 优先级 3 → 4 的顺序，且 owner 之间不许转交（F-6） |
| 表示（representation）路由不变 | 本契约只碰输入；输出仍走 `pushRow(represent(...))` |
| `npm run freeze` 八条不变量 + 七条退役路径 | 不动；只**新增** F 系列计数器（T-6） |

**审计轮不动运行时**：以上全部是契约与要求，路由改动在 0.8.4 按
[`../plans/0.8.4-input-ownership.md`](../plans/0.8.4-input-ownership.md) 的顺序执行。

---

## 8. W-0 Status（2026-10-13）

**W-0 建立了可执行的安全网，没有实现 InputRouter。** 契约的判定逻辑（Reader / Router / owner
adapter）一行未动：`handleInputText` 的阶梯、keymap 查表、ESC 前缀持有、粘贴标记解析全部原样。

### 8.1 建立了什么

| 件 | 位置 | 作用 |
|---|---|---|
| 行为安全网 | `tests/input-ownership-regression.test.mjs`（18 项 · 15 绿 · 3 todo） | 每个事件都走 `handleData` 真实路径；**不直接调 `handleSetupKey`/`handleChar`，不设 owner 状态来让断言通过** |
| 静态棘轮 | `scripts/input-freeze-audit.mjs`（`npm run freeze:input`） | router / dispatcher / owner 读取点 / 危险写者 / 粘贴与鼠标入口 / 已知缺口计数，**只能降不能升** |
| 门接线 | `npm run freeze` 新增 "input ownership" 段 | CI 现有的两条平台腿都会跑，不需要改 workflow |
| 已知缺口登记 | 回归套件里的 `{ todo: … }`（3 条） | 今天**是红的**，node 报为 todo 而非失败；W-1/W-3 修好后必须去掉标记 |

**W-0 唯一的行为改动**：G-10 的护栏——`copyPlainText` 不再写 composer 的草稿（`this.input` /
`this.cursor` / `this.inputFolded` / `leaveHistoryBrowse` 四行删除）。这是"**状态写入所有权**"的
修正（F-2），不是路由改动：哪个键归哪个 owner 一个字节没变。命令行的消费仍由 `runCommand` 负责
（它对每条命令都清），所以 `/copy` 的可见行为不变。

### 8.2 基线（`npm run freeze:input` 实测，2026-10-13）

| 计数 | 基线 | 说明 |
|---|---|---|
| `routers` | 2 | `tui.ts` + `picker.ts`（G-6：第二套 router，W-7 处理） |
| `dispatchers` | 1 | `handleInputText` |
| `mouseParsers` | 2 | 同一份 SGR 解析存在两处（W-1 收进 Reader） |
| `rawBranches` | 13 | owner 自己比较原始字节序列（F-5；W-1/W-3 降它） |
| `ownerReads` | screen 31 · dialog 59 | **记录而非归零**：Router 抽取（W-2）之前它们本来就该在 |
| `pasteConsumers` | 3 | `handlePasteText` · `pasteIntoScreen` · `processPasteChunk` |
| `mouseConsumers` | 3 | `begin` · `extend` · `endMouseSelection`（`handleMouseClick` 是 public，人工计数） |
| `knownGaps` | 3 | 回归套件里的 todo（G-1 · G-2/G-8 · G-3） |
| `deadScreenGate` | 1 | `src/tui.ts` 里 `handleChar` 第二个 Screen 门（不可达；W-2 删） |

### 8.3 两个 hold 窗口为什么都在（G-9）

| 窗口 | 位置 | 守的是什么 | 合并的代价 |
|---|---|---|---|
| **30ms** | `TerminalInputGuard`（`INPUT_HOLD_MS`） | **探测回复**：`CSI r;c R` 可能被终端切成 `ESC [ 1` + `7;1R`，尾巴必须扣住，否则坐标会变成输入框里的 `[17;1R`（`tests/terminal-input.test.mjs` 有专项） | 它扣的是"**可能是回复**"的字节，超时后要**交还**给输入 |
| **60ms** | TUI 的 `escapeTimer` | **按键**：孤立的 `ESC` 与"Alt 和弦 / 功能键的开头"只能靠时间区分；这条决定了 Alt+1…4、Alt+N/P、`/find` 的 Alt+F 是否成立 | 它扣的是"**可能是按键序列**"的字节，超时后按 ESC 或按文本处理 |

两者**语义相反**（一个交还给输入、一个变成按键），只是都用了"等一小会儿"这个手段。合并需要
Reader 先把"回复"与"按键"分成两类事件（W-1），在那之前合并只会把两种超时语义搅在一起。
W-0 只记录，不合并。

### 8.4 仍然存在的架构债（本轮只记录）

1. **第二套 router**（`picker.ts` 自带 guard + escape 组装）——W-7，或至少共用 Reader。
2. **`handleChar` 的第二个 Screen 门不可达**——W-2 删除（现在有计数钉住，删掉会让 `deadScreenGate`
   变成 0，棘轮允许下降）。
3. **13 处原始序列分支**（`combined === '\x1b…'`）——W-1/W-3 之后应显著下降。
4. **owner 读取点 90 处**（screen 31 + dialog 59）——W-2 收敛到 Router 与 owner 白名单；本轮
   **不要求归零**。
5. **G-1/G-2/G-8/G-3 仍是红的**（3 条 todo）：一次 read 多键在 composer 路径仍会丢，Alt 和弦与下一
   字符同 read 仍会泄漏成文本。W-3 修，修完删标记。

### 8.5 W-0 ≠ Router 实现

W-0 交付的是"**破坏归属就会红**"的能力，不是新的归属实现。判断标准：把 `handleChar` 的 Screen 门
删掉、把 `copyPlainText` 的草稿写入加回来、在任何新文件里 `new TerminalInputGuard(`，三种破坏都会
被门拦下（见 §8.6 的 mutation 记录）。

### 8.6 Mutation 记录（本轮实测）

| # | 变异 | 期望红的门 | 实测 |
|---|---|---|---|
| M1 | 让 `handleMouseClick` 写 composer 草稿 | 静态棘轮 | ✗ `FAIL: new writer: handleMouseClick writes the composer draft` |
| M2 | 删掉 `handleChar` 顶部的 Screen 门 | 行为安全网 | ✗ 新网 `a Screen gate holds for keys that arrive beside a paste` + 0.8.3 网 `a Screen owns the composer's own keys` 同时红 |
| M3 | 在**新文件**里 `new TerminalInputGuard(` | 静态棘轮 | ✗ `routers 3 > baseline 2`（第一次跑**没红**——棘轮只扫两个已知文件；已修成扫全 `src/`，这条 mutation 就是它的回归证据） |
| M4 | 恢复 `copyPlainText` 清空草稿 | G-10 行为测试 + 静态棘轮 | ✗ 四条 G-10 用例全红 + `new writer: copyPlainText writes the composer draft` |

M1/M4 是同一类破坏的两种形状（前者是"新写者"，后者是"回归旧写者"），分别由静态与行为两个门抓住；
M3 抓的是门自身的盲区，这正是 mutation 检查存在的意义。

---

## 9. W-1 Status（2026-10-13）

**W-1 把"读字节"搬进了唯一的 Reader**（[`input-reader.md`](input-reader.md)，AD-21）。
`handleInputText` 的阶梯与 owner 优先级**一个字节没改**：本轮是搬家，不是装修。

| 项 | 结果 |
|---|---|
| 新模块 | `src/input-reader.ts`：UTF-8 解码 · 设备回复过滤（30ms）· 转义组装（60ms）· 粘贴边界 · 单元分类 |
| 事件 | `InputFrame`：`key` / `burst` / `literal` / `paste` / `escape` / `reply`（六个 tag 的 union，无框架） |
| tui.ts 变化 | `decoder` / `inputGuard` / `escapeBuffer` / `escapeTimer` / `inPaste` / `processPasteChunk` / `looksLikePasteBurst` 移出；`handleInputText` = assemble → paste 帧 / `route()`，新增 `consumeFrame()` |
| 行为等价 | **54 个 fixture 的消费者轨迹与终态逐字节相同**（参考轨迹取自抽取前的构建，`tests/fixtures/input-reader-traces.json`） |
| 保住的东西 | G-1/G-2/G-3 三个已知缺口**保持坏的**（轨迹钉住；W-3 连同 fixture 一起改）；两个 hold 窗口数字不变（30 / 60） |
| 新增门 | `readers` 1 · `rawRouters` 1（picker 债）· `rawDecoders` 4 · `pasteFraming` 0 · `escapeAssembly` 1（picker 债）；`pasteConsumers` 由 3 降到 2 |
| Mutation | M1 第二 parser → ✗ `rawDecoders 5 > 4`；M2 改粘贴框架 → ✗ 轨迹 + 两个分片用例；M3 改 ESC 窗口 → ✗ 轨迹 + 两个数字 + 孤立 Esc 用例 |

**W-1 之后仍未做**（W-2/W-3/W-7）：`route()` 里仍是 90 处 `this.screen`/`this.dialog` 读取（W-2 抽
Router）；13 处原始序列分支与 `screenKeys()` 的按键迭代仍归消费者（W-2/W-3）；picker 仍自带 reader
（W-7）；G-1/G-2/G-8/G-3 仍红（W-3）。

---

## 10. W-2 Status（2026-10-13）

**W-2 把"交给谁"收敛到了唯一的 Router**（[`input-router.md`](input-router.md)，AD-22）。
四类 Owner 各有适配器；`handleInputText` 的阶梯只剩**绑定表与解析**，跨 Owner 判定一个都不留。

| 项 | 结果 |
|---|---|
| 新模块 | `src/input-router.ts`：`route(kind, unit, ownershipView) → Owner`，纯函数式、零分配（视图对象复用） |
| 适配器 | `ownerScreen` / `ownerSurface` / `ownerComposer` / `ownerWorkspace`；`composerUnit` 是 Composer 与 Surface 共用的兼容执行体（旧 `handleChar` 的 switch，`dialog` 分支就是 Surface 的行为；W-3 拆） |
| 事件 | 每个单元**恰好一个**适配器被调用（`tests/input-ownership-matrix.test.mjs` 逐格断言） |
| 行为等价 | **72 条 fixture / 246 次边界调用 + 终态**与抽取前构建逐字节一致（W-1 的 54 条 + W-2 补齐的 18 条 Surface / Ctrl+L / 光标键） |
| G-6 | 不可达的第二个 Screen 门删除（`deadScreenGate` 1 → 0）；`scrollActiveSurface` 的两处 owner 分支删除；两处 SGR 解析合并；Ctrl+L 的两份实现**保留**并显式路由（记录在案） |
| 棘轮 | `ownerReads` 31/59 → **25/54**；`rawBranches` 13 → **8**；`mouseParsers` 2 → **1**；新增 `routers` 1、`routerCallSites` 3、`deadScreenGate` 0；无新增白名单 |
| Mutation | M1 删 Screen 归属门 → ✗ 六个测试红；M2 粘贴穿透 Screen → ✗ 轨迹 + 向导粘贴用例；M3 第二个 dispatcher → ✗ `ownerReads.screen 26 > 25`；M3b workspace 适配器写草稿 → ✗ `new writer` |
| 保住的东西 | G-1/G-2/G-8/G-3 仍红（3 条 todo 未动）；G-10 仍绿；两个 hold 窗口未动；Reader 未改 |

**W-2 之后仍未做**（W-3/W-7）：`burst` 的逐键规范化与 G 系列修复（W-3）；`SURFACE_COMPOSER_KEYS`
与 Ctrl+L 两份实现的收口（W-3）；`screenKeys()` 的按键迭代折进 Reader（W-3）；picker 自带 reader（W-7）；
`composerUnit` 的 Composer/Surface 共用体拆分（W-3）。

---

## 11. P-1：6c 的绘制归属（2026-10-14）

**问题**：W-2 的 CI 里 `test (0.1.7-rc.1)` 红了一条断言——`the repaint must start at the layer, not at
the top of the frame (rows 2,1,30,29,25,24)`，而那条腿的测试套件本身是 `fail 0`。原因是 6c 在固定的
500ms 窗口里统计**全部** `ESC[<row>;1H`，把三件不同的事混成了一个数字：方向键引起的层重绘、绘制器
**故意整块重画**的 chrome（[`input-router.md`](input-router.md) 之外的 `src/paint.ts`：`chromeChanged`
的帧会重画 `chromeStart` 及以下每一行，哪怕内容没变），以及**独立**的后台更新（第 1 行身份行的路由
标签）恰好落进同一窗口。旧规则还**太松**：只要有问题的重绘从第 5 行开始，"每行 ≥ 5"就放行——而那
正是这条断言要抓的回归。

**判定模型**（`scripts/paint-attribution.mjs`，AD-20 的这张门从此按它执行）：

| 检查 | 问题 |
|---|---|
| `composer` | 输入框在屏上吗（chrome 块的位置由 `╭` 行定位，定位不到就是探针自己的错） |
| `move` | 高亮**真的**从 A 移到了 B（`●`/`○` 互换） |
| `repaint` | 层的帧确实重画了层 |
| `scope` | **没有任何帧重画一行它没有改变的内容**，chrome 块（输入框整块重画是记录在案的行为）除外 |
| `transcript` | 层**上方**的行没有移动（重新开窗会把整条带挪走；独立的一次时钟 tick 允许 2 行以内） |
| `clear` | 窗口里没有 `2J`/`3J`/`H J`/擦除到行尾的整屏清除 |

**为什么不用 pty chunk**：`term.onData(chunk)` 的切分是 pty 的决定，一次 `write` 可以分成三块，ConPTY
还会把整帧压成换行分隔的一批并改写行寻址。判定读的是**绘制器自己写在字节里**的界标——每个画行的帧
用 `ESC[?7l … ESC[?7h` 包住它的行批（多行时外面再套 `ESC[?2026h/l`），每行是
`ESC[<row>;1H ESC[0m ESC[2K <内容>`——所以帧就是产品说的帧。`tests/paint-attribution.test.mjs` 有一条
用例把同一段流按 7 字节步长切开重判，结论必须不变。

**ConPTY 的证据边界**：Windows 腿拿不到行寻址，6c 在那里只断言仍然可读的部分（高亮移动、无清屏），
并把范围判定交给 `tests/dialog-paint-scope.test.mjs` —— 它用真实 `SshTui` + 显式 `paint()` 在
**组合出来的帧**上判，平台无关，因此 Windows 腿也有这项证据（探针日志会打印边界说明，不假装测到了）。

**过程与复核**：见 `docs/checkpoints.md` 的 P-1 节（复现、W-1/W-2 对照、M1–M4、重复稳定性）。

---

## 12. W-3a Status（2026-10-14）· 一次 read 里的多个事件

**做了什么**：把"一个 read 里有几个单元"从消费者手里收回 **Reader**（AD-21 的位置），
`InputReader.read(text)` 成为唯一的取帧入口：粘贴流量走既有的标记/整段规则，其余走 `units(text)` 拆成
**完整单元**——完整 CSI/SS3、Alt 和弦（`ESC` + 一个可打印字符）、控制字节、CR/LF（CRLF 算一个 Enter）、
一段连续可打印文本（保持整段，`yes` 不会被拆成一个字符一个字符），以及"还可能长大的转义前缀"整段交给
60ms hold。`tui.ts` 的 `handleInputText` 只做"逐帧 → `consumeFrame`"，每个单元**恰好一次** Router 判定，
keymap 因此按**单键**查表（AD-22 的 Router 契约不变：它仍然只对完整单元判一次，不解析字节）。

**G-3 的语义**（本轮先审查后实施）：两个 read `ESC 1` + `x` 与一个 read `ESC 1 x` 必须产生**相同**的
事件消费结果——Alt+1 作为完整和弦执行，后面的 `x` 作为**独立事件**重新判定 Owner。实测三个落点：
composer 里 `x` 落在光标处（`我打了x一半的消息`，绝不是 `1x`）；无字段 Surface 上和弦照跑而 `x` 被
**Surface 拒绝**（草稿原样，拒绝是 Owner 的决定）；Screen 上 `x` 归 Screen。产品里已有的同类先例是
SS3 尾巴（`\x1bOAx` 一直是"序列 + 尾巴各自处理"），因此这条原则不与其他契约冲突，无需裁决。

**保留的两条边界**：

- **Screen 拥有它收到的那次 read**：Screen 关闭后，同一 read 里剩下的单元**丢弃**（0.8.3 的规则，
  `handleScreenInput` 的 `if (this.screen === undefined) return` 原位；W-3a 用 `screenDismissals` 计数
  在 `handleInputText` 里保持，避免新增 owner 读取点）。
- **Surface 相反**：答案就是一个字符，read 里剩下的部分继续按 Owner 判定（`yes` 打在 confirm 上被拒、
  草稿不动——`yes-typed-at-dialog` 轨迹钉住）。

**轨迹**：98 条（72 + 26 条新增的"单 read / 多 read 成对"与安全用例）。W-3a 只改 4 条，逐条记录在
`tests/input-reader.test.mjs` 的 `GAP_FIXTURES` 与 `docs/checkpoints.md` 的 W-3a 节；其余 68 条由
更新脚本**拒绝非法改动**（任何未授权的差异会直接抛错），并由 `every fixture frames identically` 比对。

**仍未做（W-3b / W-7）**：`SURFACE_COMPOSER_KEYS`（Surface 在时 Home/End/Delete/复制键仍到 Composer；
**W-3b.1 已关闭**，见 §14）、Ctrl+L 的两份重绘实现（W-3b.2）、`composerUnit` 的 Composer/Surface 共用体
拆分（W-3b.3）、picker 自带 reader（W-7）。

## 13. W-3a.1 Status（2026-10-14）· Screen read ownership 的收口

**缺陷**：W-3a 把"Screen 拥有整次 read"实现为 `handleInputText` 读取循环里的
`screenDismissals` 检查——它只发生在**帧之间**。而文本单元是**帧内**逐字符投递的
（`handlePlainText` → `handleChar` → Router 重新判定，这正是 Surface"答一个字符、余下进 Composer"的
机制）。于是粘贴尾巴 `\x1b[200~pasted\x1b[201~\x1bq` 里，`\x1b` 关掉 Screen、`q` 落进它背后被隐藏的
Composer 草稿。复现（真实 `handleData(Buffer)`，Report Screen + 非空草稿）：
`我打了一半的消息` → `我打了q一半的消息`（cursor 3 → 4）。四条路径都已实测命中：

| 路径 | 旧读法 |
|---|---|
| Report Screen + 粘贴 + `\x1bq` | 草稿被写成 `我打了q一半的消息`（`insertIntoField('q')`） |
| Setup Screen + 同一 read | 粘贴进向导自己的字段，Esc 取消向导，`q` 仍进 Composer 草稿 |
| `\x1bq` **在**标记之前 | `q` 进草稿；其后的粘贴已被帧间检查正确丢弃 |
| 更长的尾巴（`\x1bqhello`） | 五个字符全部泄漏进草稿 |

**最小修复**：`handlePlainText` 在进入投递循环时记下 `screenDismissals`，每投递一个字符前重新比较，
一旦 Screen 在这次投递中被关闭就**结束这次投递**（`src/tui.ts`，+10 行）。这是把读取循环里那条规则
原样下沉一层，不是新增机制：没有第二个 Reader/Router、没有改 keymap、没有碰 30ms/60ms 持有窗口、
没有改 Surface 的尾部语义（`screenDismissals` 只随 Screen 关闭递增，Surface 结算不动它）。
`handlePasteText` 是单次编辑、不再逐字符路由，所以它是这条路径的**唯一**入口（已核对）。

**证据**：`tests/input-ownership-regression.test.mjs` 新增 5 条在机用例（帧内关闭、标记前关闭、向导字段
+ 草稿隔离、普通 read 的帧间尾部仍被丢弃 / 无 Screen 时粘贴尾巴照常落入草稿、Surface 尾部仍交给
Composer）；`tests/input-trace.mjs` 新增 4 条安全轨迹（`screen-paste-tail-escape` ·
`screen-escape-then-paste` · `wizard-paste-tail-escape` · `surface-paste-tail-typing`），旧读法逐条记在
`tests/input-reader.test.mjs` 的 `W3A1_FIXTURES` 与 `docs/checkpoints.md` 的 W-3a.1 节。

**轨迹**：W-3a 留下的 98 条**逐字节不变**（修复是边界收口，不是重新取帧），参考集 98 → **102** 条，
新增的四条是上面这组安全用例。变异 M6（删掉守卫）与 M7（守卫放在循环之前）都在回归套件与轨迹门转红。

**仍未做**：W-3b 的其余两项（Ctrl+L 两份实现、`composerUnit` 拆分）与 W-7（picker 自带 reader）。
本轮不发版。

## 14. W-3b.1 Status（2026-10-14）· Surface 编辑键的归属收口

**缺陷（三条，彼此不同）**：Surface 打开时，`Home`/`End`/`Delete` 与 kitty-`Ctrl+Shift+C` 是**序列**，
Router 在问 Surface 之前先用 `SURFACE_COMPOSER_KEYS` 把它们放行给 Composer。三个键落在三个不同的点上：

| 键 | 原行为 | 性质 |
|---|---|---|
| `Home`/`End` | `ownerComposer` 直接写 `this.cursor` / `this.input.length`——**绕过** `fieldText/fieldCursor/setField` | 无字段 Surface：移动**隐藏草稿**的光标；有借用字段：移动的仍是隐藏草稿，读者看得见的那一行纹丝不动 |
| `Delete` | `deleteAtCursor()` **本来就是 field-aware** | 有借用字段时它编辑的是**可见字段**（正确）；无字段 Surface 时它落回隐藏草稿（泄漏） |
| kitty-`Ctrl+Shift+C` | `copyKey()` 在 `dialog !== undefined && screen === undefined` 时**直接返回 false** | 已经拒绝：无字段 Surface、有字段 Surface 都是无操作。本轮只收正归属，不发明 Surface 复制 UX |

**审计矩阵**（真实 `handleData(Buffer)`，五种 Surface 形态 × 六个键）确认了上面的分类：confirm /
approval / 无过滤列表 / **过滤中**列表四种形态下，Home/End 改 `cursor`（3→0 / 3→8），Delete 把草稿
`我打了一半的消息` 改成 `我打了半的消息`；借用字段形态下 Home/End 改的是隐藏 `cursor` 而 `borrowed`
停在 `ab|2`。**过滤形态没有过滤光标模型**（`dialog.filter` 只有 append/backspace 两个操作，
`typeQuestionFilter`/`backspaceQuestionFilter`），所以按合同**不新增**过滤编辑：这些键在这里只能是
"消费并丢弃"。picker 走 `src/picker.ts` 自带的 decoder/reader（W-7 债），根本不经过 `handleData`。

**修复**：
- `src/input-router.ts`：删除 `SURFACE_COMPOSER_KEYS` 及其分支——Surface 拥有**全部**单元，只剩 Ctrl+L
  一条记录在案的例外（W-3b.2）。
- `src/tui.ts` `ownerSurface`：`Home`/`End` → `moveFieldCursor('start'|'end')`；`Delete` →
  `if (this.textIsEditable()) this.deleteAtCursor()`；其余序列照旧丢弃（复制键因此归 Surface 并被丢弃，
  与既有可观察行为一致）。
- `src/tui.ts` 新增 `moveFieldCursor(target)`（+15 行）：走 `fieldText/setField`——与 Ctrl+A/Ctrl+E 同一条
  路；`ownerComposer` 的 Home/End 改用它，于是"Composer 只在真正拥有 Composer 时使用这些键"从**约定**
  变成**结构**（无层叠时 `fieldText()` 就是草稿，行为逐字节不变）。
- 没有第二套路由、没有新的 draft writer（`input`/`cursor` 的写入仍只在 `setField` 里）、没有直接清空/
  恢复草稿来伪造隔离。

**证据**：`tests/input-router.test.mjs`（层 A：六个单元对 `SURFACE`/`SURFACE_FIELD` 都答 `surface`）、
`tests/input-ownership-matrix.test.mjs`（新用例"a Surface keeps the composer behind it: its own editing keys
included"：三种形态 × 九个单元，草稿/光标/历史/滚动/焦点/行数全不动；借用字段那一行断言答案落在
**可见字段**里）、`tests/input-ownership-regression.test.mjs` 新增 6 条、`tests/interaction-surface.test.mjs`
新增 1 条（confirm 与 picker 两个 Surface 形态 × 十一个键）。参考轨迹 **102 → 106**：`dialog-home-end`
与 `dialog-delete` **两条授权变更**（旧读法记在 `W3B1_FIXTURES` 与检查点），新增 4 条安全用例。

**变异**：M1（Home/End 又直接写隐藏 `cursor`）、M2（无字段 Surface 的 Delete 又编辑隐藏草稿）、M3（Router
又把 Surface 事件放行给 Composer）、M4（借用字段的合法编辑被丢弃）、M5（Screen 输入穿透）全部实测红。

**仍未做**：Ctrl+L 的两份重绘实现（W-3b.2）、`composerUnit` 的 Composer/Surface 共用体拆分（W-3b.3）、
Surface 内左右箭头编辑借用字段（本轮范围外，现状是被丢弃）、picker 自带 reader（W-7）。
输入路径上另有一处**既有**缺陷（W-3b.1a 发现、未修）：输入星光平面字符（emoji）会因 `composerUnit`
的 `unit.length > 1` 判断而无限递归——裸 Composer 上也复现，需单独授权修。

## 15. W-3b.1a Status（2026-10-14）· 借用字段的终端光标

**原则**：**当前可见字段拥有文本，也必须拥有终端实际光标。** W-3b.1 保证"键编辑正确的字段"，
W-3b.1a 保证"光标显示在该字段正确的位置"。

**缺陷**：输入行绘制取 `fieldText()`/`fieldCursor()` 是正确的（那一行画的就是可见字段），但未折叠分支
计算终端光标坐标时用的是 `this.cursor`——**隐藏 Composer 草稿**的光标。Surface 借用字段时两者不同，
于是字段内部编辑位置正确、终端可见光标停在草稿的偏移上（终端在这里画 IME 预编辑）。折叠/masked 分支
用的是 `inputView.cursorOffset`（来自 `fieldCursor`），本来就正确。

**修复**：一处，`cursorVisualPosition(inputView.text, fieldCursor, inputTextWidth)`；不触及 Router、
Reader、Surface 归属、宽度算法或 `paint.ts` 结构。证据是**真实终端网格**（`@xterm/headless`）里的
`cursor()`，不是字符串断言：`tests/borrowed-field-caret.test.mjs`；Composer 路径逐帧比较**逐字节不变**
（40 帧中 13 个 Composer 场景全同，7 帧借用字段差异经归一化后**只在光标定位**上）。106 条 Input
Reader 参考轨迹原样保留。
