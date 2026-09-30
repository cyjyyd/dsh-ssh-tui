# 终端兼容矩阵

> 这份文件回答一个问题：**这个 TUI 在你面前那块终端上，允许发什么、承诺什么。**
> 判定代码只有一处：`src/terminal-caps.ts`（`terminalCapabilities()`），
> 一张终端一个 fixture 的用例在 `tests/terminal-caps.test.mjs`，
> 端到端断言（每种终端真起一次 TUI，看它到底发了哪些转义序列）在 `scripts/tui-term-probe.mjs`。

## 为什么需要它

"能发"和"该发"是两件事，判错了两个方向都有代价：

| 判错的方向 | 实际后果 |
|---|---|
| **不该发却发了**（过度承诺） | `?1000h` 在不能识别 SGR 坐标的终端上会**吞掉鼠标**；OSC 52 没人接时 `/copy` 看起来成功了，用户粘贴时才发现是空的 |
| **该发却没发**（欠承诺） | 在其实支持的终端上悄悄少掉鼠标/拖选、少掉备用屏恢复、多行粘贴被拆成多次提交 |

所以规则是**按能力发**，而不是"保守全关"或"乐观全开"：
模式设置类（鼠标、括号粘贴、备用屏）发错了最多被忽略，**发漏了会真的少功能**，因此默认给基线；
而**用户无法当场验证的承诺**（剪贴板、超链接）宁可不承诺，并在 `/copy` 之后明确说明。

## 矩阵

`✓` = 启用 · `—` = 不启用 · `?` = 启用但**不承诺**（可能生效，取决于配置）

| 终端 | 识别依据 | 配色 | 鼠标(1000/1002/1006) | 括号粘贴 | 备用屏 | OSC 52 剪贴板 | OSC 8 超链接 | 标题 |
|---|---|---|---|---|---|---|---|---|
| **Windows Terminal** | `WT_SESSION` | truecolor | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Windows 控制台（conhost）** | win32、无 `WT_SESSION`、`TERM` 为空 | 16 色（`TERM` 为空是正常的） | ✓ | — | ✓ | — | — | ✓ |
| **Git-Bash / MSYS2 / mintty** | win32 但 `TERM` 有名字（如 `xterm-256color`） | truecolor（`COLORTERM` 决定） | ✓ | ✓ | ✓ | ? | ✓ | ✓ |
| **GNOME Terminal** | `VTE_VERSION` 有值 | truecolor | ✓ | ✓ | ✓ | —（VTE 从未实现） | ✓ | ✓ |
| **XFCE Terminal / MATE / Tilix / Terminator** | 同上（同一套 VTE） | truecolor | ✓ | ✓ | ✓ | —（同上） | ✓ | ✓ |
| **旧 VTE（< 0.50）** | `VTE_VERSION` < 5000 | truecolor | ✓ | ✓ | ✓ | — | — | ✓ |
| **Konsole ≥ 24.12** | `KONSOLE_VERSION` ≥ 241200 | truecolor | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **旧 Konsole（< 24.12）** | `KONSOLE_VERSION` < 241200 | truecolor | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| **xterm / rxvt / kitty / wezterm / alacritty** | `TERM` 含对应名字 | truecolor（`COLORTERM` 决定） | ✓ | ✓ | ✓ | ?（xterm 受 `allowWindowOps` 限制） | ✓ | ✓ |
| **tmux** | `TMUX` / `TERM=tmux*` | 256（设了 `COLORTERM=truecolor` 则真彩） | ✓ | ✓ | ✓ | ?（需 `set -g set-clipboard on`） | ✓ | ✓ |
| **screen** | `STY` / `TERM=screen*` | 256（同上） | ✓ | ✓ | ✓ | — | — | ✓ |
| **Linux 虚拟控制台（tty1）** | `TERM=linux` | 8 色 | — | — | —（保留滚动回看） | — | — | — |
| **`TERM=dumb`／未标注** | `TERM=dumb` | 无 | ✓（基线） | ✓ | ✓ | — | — | — |

配色一列是**该终端在默认环境变量下的结果**：`COLORTERM=truecolor` 会把任何一行的真彩打开，`NO_COLOR` 会全部关掉
（判定在 `src/color-depth.ts`，与终端家族无关）。

关于最后三行的取舍：

- **Linux 虚拟控制台**关掉备用屏，是因为在那里进备用屏等于让用户丢掉 `Shift+PgUp` 的滚动回看，
  而它本来也没有真正的备用屏；
- **`TERM=dumb` 与未知终端保留基线**：说自己是 dumb 的终端常常只是被包装层挡住了名字（CI 的 pty 也是如此），
  而它不认识的模式设置序列会被忽略——此时"少发"才是真正的损失。剪贴板与超链接则反过来不承诺；
- **VTE（GNOME / XFCE / …）没有 OSC 52**：上游 issue 至今未实现（GNOME/vte#125），
  而它是 Linux 桌面最常见的终端——所以这一格是 `—`，不是 `?`。Konsole 的写入支持要 **24.12** 才有。
- **`?` 的含义**：该终端*可能*生效但需要用户配置（xterm 的 `allowWindowOps`、tmux 的 `set-clipboard on`），
  所以仍然**照发**；而 `—` 的终端上一次会话只提醒一次，告诉你剪贴板可能没写进去。

## 覆盖方式（用户可强制指定）

自动判定错了就手动覆盖，两个环境变量都长期有效：

```sh
# 单项开关：no-<能力> 或 <能力>=false；逗号/空格分隔
DSH_TUI_TERM_CAPS='no-mouse,osc52=false' dsh --profile tui

# 反过来：在判定为不支持的地方强行打开。两个真实场景：
#   ① tmux 里配了 `set -g set-clipboard on`，OSC 52 其实能用 → 打开并取消提示；
#   ② 老 conhost（无 VT 处理）反而要关掉，见下面「已知限制」。
DSH_TUI_TERM_CAPS='osc52' dsh --profile tui
DSH_TUI_TERM_CAPS='no-alternateScreen,no-mouse' dsh --profile tui   # 无 VT 的旧控制台

# 先前的两个开关继续有效
DSH_TUI_NO_ALT_SCREEN=1     # 等价于 no-alternateScreen
DSH_TUI_OSC8=0              # 等价于 osc8=false
DSH_TUI_COLOR_DEPTH=none    # 只影响配色（见 color-depth.ts）
```

可写的名字：`mouse`、`mouseSgr`、`mouseDrag`、`bracketedPaste`、`alternateScreen`、`osc52`、`osc8`、`title`。
`=` 两边的空格可有可无（`mouse = false` 等同 `mouse=false`）；**看不懂的写法会被拒绝而不是猜**——
写错的名字/取值不会生效，但会出现在 `/diag` 的「终端」行末尾，好过默默无效：

- 打开 `mouse`（或 `mouseSgr`）会连带打开 `mouseSgr` 与 `mouseDrag`：输入解析器只认 SGR 报告，
  只开 `?1000h` 会「吞掉鼠标却收不到事件」，比不开更糟；想只要点击不要拖拽就写 `mouse,no-mouseDrag`；
- 反过来，`no-mouseSgr`（或 `mouseSgr=false`）等于关掉鼠标——没有 SGR 就没有可用的事件；
- 提示只在 `osc52` 为假时出现，且每会话一次；`DSH_TUI_TERM_CAPS=osc52` 表示你确认终端支持，提示随之消失。

判断依据写在 `/diag` 里，报障时直接贴那一行：

```
终端：gnome-terminal (VTE 7000)（vte）· 鼠标 是 · 括号粘贴 是 · 备用屏 是 · OSC52 是 · OSC8 是
```

## 键盘与输入

键位这一侧不按终端分家：解析器同时吃传统 xterm 序列（`\x1b[H`、`\x1b[3~`、SS3 `\x1bO…`）
与 kitty/CSI-u 编码（例如 `\x1b[99;6u` 是 Ctrl+Shift+C，kitty、wezterm、foot 等默认或可开启），
粘贴走 `?2004h` 的括号标记（不支持的终端退化成逐行输入，见上表）。
Windows 与 Linux 的差异只在**改键**文件里：`/keys` 写出的键名与各终端实际发出的字节一一对应。

## 已知限制

- **PowerShell / cmd.exe 的 `TERM` 为空**：那正是 conhost 的特征；Git-Bash / MSYS2 / mintty 会设 `TERM`，因此走 xterm 基线。
- **旧版 Windows 控制台（无 VT 处理）**：Windows 10 之前的 conhost 不认这些转义序列，
  用 `DSH_TUI_NO_ALT_SCREEN=1` 或 `DSH_TUI_TERM_CAPS=no-alternateScreen,no-mouse` 退到最朴素模式。
- **代码页不是 UTF-8 的 Windows 控制台**：框线与 emoji 会花。TUI 不改你的控制台代码页
  （那是全局状态），而是把界面骨架改画成 ASCII（横线 `-`、状态点 `*`、警告 `!`，判定见
  `src/platform.ts` 的 `asciiFallbackEnabled`）。`/diag` 的「终端」一行会注明；
  想要原字形用 `chcp 65001` 或改用 Windows Terminal。`DSH_TUI_ASCII=1` 强制 ASCII，`=0` 强制 Unicode。
- **`/copy` 与拖选都依赖 OSC 52**：VTE 系（GNOME / XFCE / MATE / Tilix / Terminator）、conhost、screen、
  Linux 控制台都不接收；Konsole 要 24.12+；xterm / tmux 需要自身配置。这些终端上 TUI 每会话提示一次。
  **SSH 会话不提示**：能力表读的是远端 tty，而 OSC 52 写到的是你本机的终端，复制实际落到本机剪贴板，
  再警告就是误报。提示里说的退路是终端自己的选择：按住 Shift 时多数终端不转发鼠标、留给原生选择；
  少数终端照样转发，那种情况下 Shift+拖选 与直接拖选做同一件事（SGR 的按钮码带上 Shift 的 +4）。
- **选中标记 `▶` 不算正文**：被选中的回复第一行前面有 `▶ `（`▶` 按本项目的宽度表算两格，所以是三格；
  ASCII 回退下它是 `> `，仍是三格），这一行仍然可以拖选。反色高亮与复制都从第四格开始算，粘出来的文本里
  没有标记；起点落在标记上也不算「没选中」——拖过它就会带上该行的正文。被选中的那条回复按**窄三格**排版，
  所以和未选中时相比会重新折行——代价是换来"标记不会吃掉首行末尾的字"。
- **覆盖层里的复制键**：`Ctrl+Shift+C` 在 kitty / CSI-u 终端上会到达 TUI 并复制「全文」；但把该键折叠成
  `Ctrl+C` 的老终端上，它只是 Ctrl+C（在覆盖层里等于关闭）。那里用 `ssh-tui.keys` 把 `copy` 改绑到别的键
  ——改绑后的键在覆盖层内同样生效（旧版本只在没有对话框时查改绑表，覆盖层里按不动）。
- **旧版 Windows 控制台的括号粘贴**：`?2004` 到 2022-11（Windows 11 22H2）才进 conhost，
  更早的 PowerShell/cmd 没有；粘贴仍然可用（多行 burst 会被当成一次粘贴），只是没有括号标记。
- **tmux / screen 里的鼠标**：需要 tmux `set -g mouse on`、screen 亦然；TUI 会照发，转发与否由它们决定。
- **不是 UTF-8 的 locale**：自动改画 ASCII 骨架。`LC_ALL` / `LC_CTYPE` / `LANG` 写明了非 UTF-8
  字符集（或裸 `C` / `POSIX`）即触发，与 Windows 代码页走同一条回退；没写字符集的 locale 不动，
  因为一条 UTF-8 的 SSH 会话经常什么都不导出。中文翻译不会被替换成 ASCII——那种控制台请同时 `/language en`。
- **`/diag` 的终端行来自 Host 的环境**：重新接入（reattach）后它描述的是 Host 启动时所处的终端。
  退出时的「离开备用屏」序列因此**无条件发出**——它落在没进过备用屏的终端上会被忽略，
  而漏发会把用户留在无法滚动的屏幕里。

## 字符宽度：哪些算两格,以及为什么

终端里"一个字符占几格"没有统一答案,这个 TUI 的口径是:

| 类别 | 例子 | 预算 | 说明 |
|---|---|---|---|
| CJK / 全角 | `中`、`，`、`（` | 2 | 无争议 |
| emoji 符号 | `✖`、`⚠`、`▶`、`✅` | 2 | 终端用彩色 emoji 字形画它,比等宽字体宽;`pinEmojiCells` 用 VS15 + 预留空格把它**钉**在 2 格里 |
| **带圈/带括号的字母数字** | `①`-`⑳`、`⑴`、`⒈`、`ⓐ`、`❶`、`➀`、`Ⅰ` | **看终端** | 见下 |
| 本 TUI 自己的装饰 | `─`、`●`、`❯`、`·`、`▸`、`✓`、`⠋` | **1** | 它们来自等宽字体,按 2 格算会画出半宽横线、把光标挪到文字右边一格 |

**这两行(带圈字符、标点)是 2026-09-29 修的一个真实缺陷**:模型会写 `①`-`⑩`,而 CJK 字体的终端把它们画成两格,我们却按一格预算——于是每一行都比实际短一格。
与 emoji 不同,这类字符**没有变体选择符**可以"钉"宽度,只能跟着终端走。判定规则:

1. `DSH_TUI_AMBIGUOUS_WIDTH=1|2` 明确指定(覆盖一切);
2. 否则看 locale:`LC_ALL` / `LC_CTYPE` / `LANG` 是 **zh / ja / ko** ⇒ 按 2 格(该终端极可能用 CJK 字体);
3. 其它 ⇒ 按 1 格。

**UI 语言不参与判定**:一个中文读者在纯西文终端上看到的仍是窄字形,输入中文并不会改变字体度量。
若你的终端在英文 locale 下也把这类字符画成两格(或在中文 locale 下画成一格),用上面那个环境变量显式纠正即可。

### 先实测,再回落(2026-09-30 起)

locale 只是**猜测**,而"① 渲染错位"报了三次都出在猜上。现在由**显示中继**(持有终端的那一侧)直接问终端:
把 `①—…“”·•Ⅰ` 打到刚清空的一行上,发 `CSI 6n`,读回光标列——那个列就是终端刚刚花掉的格数(`src/glyph-measure.ts`)。

测量走 `TerminalInputPump.askPosition`,**应答由 pump 吞掉**——这不是实现细节:没人消费的光标应答会被终端回显成字面量 `^[[1;5R`,
第一版把探测放在启动器里裸写,就在进入 TUI 的过程中把这类异常字符重新漏了出来。测完的结论经**协议帧 `FRAME_METRICS`(12)** 交给
正在绘制的 Host,所以已在运行的旧 Host、resume 会话也能当场采纳并整体重绘(旧帧的行是按旧表算的,必须重绘而不是增量)。

- 终端推进 **2 格** → 按 2 格预算,不补空格;
- 终端推进 **1 格**(字形却画得更宽 → 就是你看到的"①和后一个字挤在一起") → 仍按 2 格预算,但**补一个预留空格**:
  渲染时在字形后插一个空格,让终端实际花掉两格。这正是 emoji 那套"钉住"的另一半;圈号没有变体选择符可用,所以只剩这半招。
  **宽度契约**:钉住前后 `displayWidth` 必须相等(那个空格算作同一个两格单元),否则填/截/光标会集体偏一格。
- 终端不答或答得既不匹配"全宽"也不匹配"全窄"(混排字体) → 什么都不决定,回落 locale 猜测。
- 想让探针完全不写字节(给断言 attach 字节序列的 harness):`DSH_TUI_NO_GLYPH_PROBE=1`。

另外两处必须留意:**绘制发生在分离 Host 里,而 Host 的 stdout 是中继 socket、不是终端**——所以实测由持有终端的窗口进程做,
结论经 `DSH_TUI_AMBIGUOUS_WIDTH` 传给 Host(spawn 时注入,见 `hostChildEnv`);没终端时一律按窄的一侧算(管道、日志、测试)。
手工纠正仍然可用: `DSH_TUI_AMBIGUOUS_WIDTH=1|2`。

涉及范围(`src/term-text.ts` 的 `AMBIGUOUS_WIDE_RANGES`),两类:

1. **圈号/字母数字**:Enclosed Alphanumerics(U+2460–U+24FF,`①`-`⑳`/`⑴`/`⒈`/`ⓐ`)、Dingbat 圈号(U+2776–U+2793,`❶`/`➀`)、罗马数字(U+2160–U+217F,`Ⅰ`)、
   Enclosed Alphanumeric Supplement(含区域指示符,U+1F100–U+1F1FF)、Enclosed Ideographic Supplement(U+1F200–U+1F2FF)。
2. **CJK 全角标点**:`—` `–`(U+2013–U+2014)、`‘ ’ “ ”`(U+2018–U+201D)、`…`(U+2025–U+2026)、`•`(U+2022)、`‹ ›`(U+2039–U+203A)、`·`(U+00B7)。
   这一类在中文语料里出现得比圈号多几个数量级——实测某会话里 `—` 出现 **31855 次**。

**刻意不算宽**的:Box-drawing(`─`)、几何装饰(`●` `▸`)、`❯` `✓` `✗` `★` 等 —— 它们是本 TUI 自己的字符或早已按真实终端实测为窄字形,
按两格算会把横线画成半宽、把光标挪到文字右边。

顺带修掉的一个连带缺陷:`foldInputView`(输入行折叠)原来把省略号标记硬写成 1 格,而 `…` 现在是 2 格 —— 折叠后的行会**溢出预算**、光标偏移一格。现在按标记的实测宽度计算。
