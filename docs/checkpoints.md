# 验收检查点（A / B / C 批）

每个批次（C 批为每个功能）留下一个可独立复核的检查点：**一条命令 + 一张人工核对清单 + 该批次所有 mutation 记录**。
命令都从仓库根目录执行，全部不消耗模型额度（`tui-mock-probe` 使用合成 profile 与脚本化模型）。
> **工作约定（2026-10-01 起）**：开工前先 `git pull --ff-only` —— 远端是权威副本，人在这台机器之外
> （Windows 实机、桌面版）也会改它；本地领先不代表远端还是上次那个样子。

一键复核全部证据：

```bash
node scripts/verify-batch.mjs --batch <A|B|C>     # typecheck + 全量测试 + 真机探针
node scripts/verify-batch.mjs --home <dir>        # 把读 profile 的三步指向这个 DSH_HOME
```

## A 批 · 界面基础（已交付）

| 项 | 人工核对（在自己的 SSH 会话里） | 自动证据 |
|---|---|---|
| A-1 模型回复**自由复制** | 在回复上**按住拖过一段**（可跨行、可含中文/emoji）→ 到别处粘贴，内容应恰为拖过的那段；在工具卡上单击仍应展开/收起（按下不动 = 点击） | `tests/mouse-selection.test.mjs`、`tests/selection.test.mjs`；`tui-mock-probe.mjs` 真机拖选并断言剪贴板内容 |
| A-2 计划条进度 | 让模型跑一次多步任务：卡片首行应形如 `⣿⣿⣀⣀… 2 已完成 · 1 进行中 · 1 待处理`；模型写 `failed/skipped` 时单独计数 | `tests/todo-progress.test.mjs`（含 24/30/40/80 列窄屏） |
| A-3 错误块复制 | 制造一次失败（如 `/doctor` 报缺行）→ `/copy error` → 粘贴：**整份**报告，长路径不因折行被插入换行 | `tests/copy-error.test.mjs`；`tui-probe.mjs` 断言 OSC 52 实际发出 |
| A-4 `/find` 高亮 | `/find 某词`：只有该词反色（同行多处都亮），窄屏折行后不错位；`NO_COLOR` 下命中行前有 `»` | `tests/find-highlight.test.mjs`；`tui-mock-probe.mjs` 真机反色断言 |
| A-5 回复可选中、可复制 | 在**有卡片**的会话里空输入按一次 **↑**：当前最新的一条（回复或卡片）行首出现 `▶`；用 `Alt+4` 选中最新回复后 `/copy`（或 `Ctrl+Shift+C`）粘出来的是**该条回复原文**而不是折行后的屏幕文本；再按 ↑ 沿屏幕顺序往上走，标记跟着走；在选中的回复上按 **Enter**：开「回复全文」覆盖层（`Esc` 返回），工具卡**不会**被顺手展开；覆盖层里按复制键同样有效（工具卡/改动卡复制的是屏幕上那份正文），并在覆盖层底部回显「已复制 …（全文）」；**连按两次复制键拿到同一条**；从选中回复第一行起拖选，复制内容**不含** `▶`；选中回复后 `Ctrl+R` 展开全部卡片但**不抢走**选中。（诚实提示：纯问答会话、或刚 `/clear` 时 ↑ 仍是历史召回——这是刻意保留的；那种会话用 `Alt+4`/`Ctrl+N` 选回复。另外 `Ctrl+Shift+C` 在把该键折叠成 `Ctrl+C` 的老终端上等于关闭覆盖层，那里请先 `/keys` 改绑复制键，覆盖层内改绑键同样生效）| `tests/reply-focus.test.mjs`（全部走真实按键字节 `handleData`：焦点环 / 标记 / 现场思考卡 / Enter / 无卡片会话 / 覆盖层内复制 / 改绑键 / 覆盖层不夺焦点 / 首行不截断 / Ctrl+R / 拖选不含标记）、`tests/selection.test.mjs`（gutter 语义）、`tests/copy-text.test.mjs`（复制后保留选中）、`scripts/tui-mock-probe.mjs`（真 PTY：拖选复制 + 选中回复后复制键复制原文） |

## B 批 · 底栏、模式与配色（本轮交付）

| 项 | 人工核对 | 自动证据 |
|---|---|---|
| B-1 底栏状态区收敛（**布局已被 E 批取代**，仅保留「无转义正文 / 暗色 / 点击 ⚠」三条不变式） | 底栏第一行（状态区）应为：`⚠ 名单缺席（/doctor） │ SSH ○○○○ 160ms │ 2 轮 · 5 步 │ …`，整行**与第二行同色（暗）**，只有链路圆点/⚠ 着色；额度条与上下文环仍留在**第二行**（身份行）模型之后；**把终端缩窄**：先丢文字、保留图形，⚠ 最后才丢；**点击 ⚠** 应打开 `/doctor` | `tests/footer-chips.test.mjs`（含 3/12/24 列、点击、样式与行位）、`scripts/capture-footer-frames.mjs`（渲染帧断言，见下） |
| B-2 `/mode` 分组与过滤 | `/mode`：官方在前、本地在后，每行带组名/`第 N 位`，broken 行显示原因；按 **`/`** 进入过滤（字母是快选键，故需显式进入），输入即筛；**Enter 应用**、再 Enter 作答；**Esc 只清过滤**不取消提问 | `tests/preset-picker.test.mjs`、`tests/mode-command.test.mjs` |
| B-3 配色三档 | `DSH_TUI_COLOR_DEPTH=8` 启动：diff 行应为**绿/红**（不是灰）；`=none`：完全无颜色但仍能看出 +/−、●/⚠/✖ | `tests/color-depth.test.mjs`（含 8 色帧内无 `38;2`/`38;5`、单色帧内无颜色参数） |

**B-3 调色板矩阵**（本轮补测）：全量测试在 `none / 8 / 256 / truecolor` 四档下**各 676 通过 / 0 失败**；真机探针在 `8` 与 `none` 下同样通过。
补测过程发现三处**测试不够密封**——它们只设置 `NO_COLOR`/`TERM`，而 `DSH_TUI_COLOR_DEPTH` 覆盖优先级更高，导致"我说我是彩色终端"的断言在外部强制 `none` 时静默失效。
这些测试现在**显式声明自己的调色板**（并在结束后恢复），`tui-mock-probe` 同理（它刻意断言反色，故声明 truecolor；单色下的 `»` 标记由进程内用例覆盖）。

## 隐藏 bug 修复 · 待办提醒重复触发（用户实机发现，2026-09-16）

**现象**：模型一轮结束时，TUI 的"请补一次待办"提醒（`plan.nudge`）**反复触发**——用户连续收到多条同样的
提醒文本，每条提醒都会**再开一个模型轮次**，而那一轮结束又会再提醒一次，形成循环（每次都是真金白银的 token）。

**根因**：这个提醒的契约写在文案里——`plan.nudgeQueued` = "（本轮只问一次）"、`plan.ts` 注释
"One per open list"。但去重标志放在 TUI 实例上，且**任何 `todo_write` 补丁都会把它清掉**：
模型的回答本身就是 `todo_write`，只要回答后**还剩未完成项**，下一次 `turn/end` 就再问一遍。
于是"提醒 → 模型更新待办但没做完 → 再提醒"无限循环。

**修复**（契约落在数据上，而不是放在会被清掉的实例标志里）：
- 计划行新增 `nudged?: boolean`（纯显示状态，不写会话日志）：一条待办列表**只提醒一次**；
- **列表全部完成**才结束本轮 episode（`nudged` 与待办标志一起复位）——之后列表再开，允许**新的一次**；
- **恢复的会话不再重复提醒**：重放 transcript 时，若日志里已有这条提醒的 notice 行（`plan.nudgeQueued`），
  就把当前计划行标记为已提醒；
- 发送失败时回滚：撤掉那条"已请模型补一次待办"的 notice 行（否则它会假装已经问过），允许以后再试。

**人工核对**：让模型做一件留了未完成待办的事，正常结束后应**只**出现一条"已请模型补一次待办状态"；
模型补了待办但仍留未完成项时，**不再**追问；若模型把所有项标成 completed，之后再新开一列表，才允许再提醒一次。

**自动证据**：`tests/helpers.test.mjs` 新增 2 条
（`a todo_write that leaves the list open does not buy a second nudge` 覆盖"留在开着不重复问 + 关闭后重开可再问一次"；
`a transcript that already carries the reminder does not send another` 覆盖恢复会话）。

**mutation（3 组，全部验红，恢复后与备份逐字节一致）**：
① 去掉 `nudged` 判据 → 红；② 关闭列表时不复位 episode（重开的列表永远不会被提醒）→ 红；
③ 重放 notice 时不标记已提醒 → 红。

## 状态行不再显示 `提供商/模型`（用户要求，2026-09-16）

**要求**：部分提供商的模型 id 带厂商前缀（`xai/grok-4.6`、`deepseek-official/deepseek-v4-flash`），
在状态行里白占格子；这种格式要截断成模型名。

**实现**：`shortModelName()`（`src/footer.ts`）取最后一个 `/` 之后的部分并 trim；没有 `/` 原样返回；
`/` 之后为空（如 `trailing/`）也原样返回，避免把模型名变成空串。`footerIdentityParts()` 用它，
`effort` 为空白时不再留下尾随空格。

**范围**：顶栏与会话头部的完整路由、`/status` 的完整路由不变；`sub:` 也一并截断
（`sub:xai/grok-4.5` → `sub:grok-4.5`，用户要求）——第一版只改了主模型，子模型仍占位；现在父子两处一致，
提供商在前者由顶栏/`/status`/`/submodel` 报告。

**人工核对**：模型为 `xai/grok-4.6` 时，状态行应显示 `grok-4.6 xhigh`，且同一行不出现 `xai/grok-4.6`。

**自动证据**：`tests/helpers.test.mjs` 新增 1 条（含多级路径、无斜杠、尾斜杠、空白 effort、`sub:` 保留前缀）；
`scripts/capture-footer-frames.mjs` 新增 `footer-model-route` 帧（真实 painter，断言存在 `grok-4.6 xhigh`、不存在 `xai/grok-4.6`）。

**截图证据**：`docs/screenshots/footer-model-route.png`。

**mutation（2 组，均 unit+帧双红）**：① 状态行退回直接用 `input.model`；② 取第一个 `/` 之前而不是之后。

## 预防 · 平台敏感改动的护栏（用户提问"如何避免以后再出现"，2026-09-16，只提交不发版）

**问题**：Windows 只能靠用户实测发现（本轮两个 bug：`spawn dsh ENOENT`、空 `TERM` 判成单色）。装本机 PowerShell 有用吗？

**结论：不装**。Linux 上的 `pwsh` 是 POSIX 进程——有 `TERM`、走 POSIX spawn、没有 `.cmd` 垫片与命名管道，
这两个 bug 它一个都复现不了。真正的缺口不是"没有 Windows 可跑"，而是**从没在 Windows 上执行过的那几行判断**。

**落地的三道护栏**（`tests/platform-guards.test.mjs` + `docs/platform.md`）：
1. **静态扫描**：`src/` 里任何 `spawn/execFile/exec` 的**裸命令名**都必须登记在
   `BARE_SPAWN_ALLOWED` 并写明理由；名单**双向校验**（新增会红，代码里没了却还挂着也会红）——
   写这条时它当场抓出自己名单里的过期项。Linux 上即可变红，正是 `spawn('dsh')` 那一类。
2. **平台分支断言**：`colorDepth(env, platform)`、`resolveDshInvocation({platform,…})` 已改为可注入纯函数，
   用例显式跑 win32 分支；`platform-guards` 还在**真实环境**上断言"Windows 下色深不为 none""本平台调用可执行"。
3. **真实平台交给 CI**：`test-windows` 腿跑同一套用例（含上面两条），所以这些断言在真 Windows 上也会执行。

**规则**（写进 `docs/platform.md`，README 两语言指过去）：平台判断写成可注入纯函数并断言 Windows 分支；
起进程不用裸命令名（首选 `process.execPath` + 自身入口）；环境语义按平台读（`TERM` 是 POSIX 习惯，
Windows 看 `WT_SESSION`/`COLORTERM`）；无法纯化的（ConPTY、命名管道）在 PR 里写明只能靠 CI 腿与真机。

**证据**：套件 **739 项 / 737 通过 / 0 失败 / 2 跳过**（新增 3 条平台护栏用例）。

## 修复 · Windows 上颜色丢失（只有黑白）（用户实测发现，2026-09-16，只提交不发版）

**现象**：0.7.0 在 Windows + PowerShell 7.6.6 下完全没有颜色。

**根因**：色深推断把**空的 `TERM`** 当成"没有终端"（`term === '' → 'none'`）。这条规则来自 POSIX 的管道/CI 场景，
但 **Windows 上 `TERM` 默认就是不设置的**（PowerShell、ConHost、Windows Terminal 都不设；`TERM` 是 POSIX 习惯），
于是彩色终端被判定成单色。`/diag` 之前也不报色深，所以只能靠猜。

**修复**（`src/color-depth.ts`）：`colorDepth(env, platform)` 增加平台参数——**空 `TERM` 的含义按平台区分**：
POSIX 仍是"无终端 → none"，Windows 则继续按能力提示判定：`COLORTERM=truecolor` → truecolor；
`TERM=*256color` / `screen*` / `tmux*` → 256；`WT_SESSION`（Windows Terminal，支持 24 位）→ truecolor；
否则 16 色（ConHost 能正确解释这些转义，diff 的绿/红仍在）。`TERM=dumb`、`NO_COLOR`、
`DSH_TUI_COLOR_DEPTH` 与 `--no-color` 的语义一律不变。

**顺带**：`/diag` 新增**配色**一行——实际色深 + `TERM` / `COLORTERM` / `WT_SESSION` 三个依据（未设置显示"（未设置）"），
这类"看不到颜色"的报告以后一眼可判。

**人工核对**（Windows）：不设任何环境变量启动，界面应有颜色（16 色档）；Windows Terminal 里应更多
（truecolor）；`--no-color` 与 `DSH_TUI_COLOR_DEPTH=none` 仍为黑白；`/diag` 的配色一行与预期一致。

**自动证据**：`tests/color-depth.test.mjs` 新增 1 条（空 TERM 在 linux/darwin 为 none、在 win32 为 8；
`WT_SESSION` → truecolor；`TERM=*256color`/`COLORTERM` 压过平台默认；`dumb`/`NO_COLOR` 仍为 none；
显式覆盖优先）；`tests/diag.test.mjs` 新增 1 条（配色行的 POSIX / Windows / Windows Terminal 三种形态）。

**mutation（2 组，全部验红）**：① 空 TERM 一律 none（即原缺陷）；② 忽略 `WT_SESSION` 提示。

## 修复 · Windows 应用内更新 `spawn dsh ENOENT`（用户实测发现，2026-09-16，只提交不发版）

**现象**：Windows 上点应用内更新 → `spawn dsh ENOENT`。

**根因**：`installPluginLatest()` 直接 `spawn('dsh', ['plugin', '--profile', …])`。Windows 上没有可执行的 `dsh`：
全局安装给的是 `dsh.cmd` 垫片，而 `CreateProcess` **不会**按 `PATHEXT` 解析裸名字（Node 文档明说 `.cmd`/`.bat`
必须经 shell 或显式 `cmd.exe /c`）。同一份代码在 POSIX 上一直正常，所以只在 Windows 暴露——与宿主进程的启动方式对比更清楚：
`spawnDetachedHost()` 用的是 `process.execPath` + `process.argv.slice(1)`（所以 Windows 上启动 TUI 没问题）。

**修复**：新增 `resolveDshInvocation()` —— **重跑我们自己所在的这个 CLI**：同样的 node 可执行文件 + 同样的入口脚本
（`process.argv[1]`），不需要 PATH 查找、更不需要 shell；只有在看不到自身入口（打包成单体可执行文件之类）时才退回
`dsh` + `shell: process.platform === 'win32'`（这种形态下 Windows **必须**经 shell 才能解析 `.cmd`）。
另外带上 `windowsHide: true`，避免更新时在 TUI 上闪一个控制台窗口。`installPluginLatest()` 增加可注入的
`invocation` / `spawnFn`，便于测试而不触发真实安装。

**人工核对**（Windows）：升级到含本修复的版本后，点应用内更新应正常完成（写入 `update.installed` 行）；
若仍失败，用命令行 `dsh plugin --profile tui add dsh-ssh-tui@latest` 兜底（README QA 已写）。

**自动证据**：`tests/update-check.test.mjs` 新增 2 条：`resolveDshInvocation` 在「有入口 / 无入口」×「linux / win32」
四种组合下的结论（有入口时一律 `execPath + [entry]`、`shell: false`；无入口时 win32 才 `shell: true`）；
`installPluginLatest` 用注入的 spawn 断言命令、参数、`shell`、`windowsHide`，以及 spawn 直接报错（正是用户看到的
ENOENT 形态）时返回 `ok: false` 且把错误文本交给界面。

**mutation（3 组，全部验红）**：① 退回裸 `dsh`；② Windows 兜底去掉 shell；③ 丢掉 spawn 的 `shell`/`windowsHide`。

## 额度条常驻 + 未获取到时的 ?% 占位与定期重试（用户要求，2026-09-16）

**要求**：进 TUI 时额度条就要在（此前要等首次请求成功才出现）；请求失败或还没拿到时，用**0% 状态的空条**占位，
数字写 **`?%`（不猜）**；并**定期重试直到拿到**，然后回到正常刷新节奏。

**实现**：
- `providerHasQuotaSurface(provider, llmPiAi)`（`src/footer.ts`，纯同步、只读 settings）：判断该提供商**有没有额度面**——
  xai/SuperGrok、OpenCode Go、Command Code 有；DeepSeek 是余额行、Zen 是计量制，**不显示额度条**（避免无中生有条）。
- `formatQuotaUnknown()` → `░░░░░░░░ ?%`：空条 + 问号。**刻意不写 `0%`**——接口不可达不等于额度用尽，写一个无法支撑的数字比不写更糟。
- 身份行：有读数→`SuperGrok 1Wk ███ 82%`；有额度面但无读数（含切换提供商后的旧快照）→`░░░░░░░░ ?%`；
  无额度面→不显示（余额行仍照旧）。
- 重试：`QUOTA_RETRY_MS = 15s`（私有字段，测试可改）。**在 `refreshQuota` 的 `finally` 里统一布防**——
  抛异常、返回空、拿到的是别家快照，三种结局都会重新布防；拿到本家读数则 `clearQuotaRetry()` 取消，
  交回步进/空闲的正常节奏；`dispose()` 也会清掉定时器。

**人工核对**：进 TUI 立刻看底栏第二行——额度条应已在，形如 `░░░░░░░░ ?%`；接口不通时保持 `?%` 并每 ~15s 重试；
一旦拿到就变成 `SuperGrok 1Wk …`/`OC·GO 5Hr …`/`CC·GOAT 5Hr …`；DeepSeek 会话**不应**出现额度条。

**自动证据**：`tests/footer-chips.test.mjs` 新增 4 条：占位格式与"哪些提供商有条"（含 Zen/DeepSeek/空 provider）、
开机帧即含 `░░░░░░░░ ?%` 且**不含任何数字**、重试**自行取回**迟到读数、正常节奏取到读数会**取消**待发的重试。
`scripts/capture-footer-frames.mjs` 增 `footer-quota-pending` 帧（断言占位在身份行、且没有 `[█░]{8} 数字%`）。

**截图证据**：`docs/screenshots/footer-quota-pending.png`。

**mutation（4 组，全部验红）**：① 去掉占位（无读数时不显示）→ 红；② 不布防重试 → 红；③ 取到读数后不取消重试 → 红
（为此把用例拆成"正常节奏取到会取消"与"重试自行取回"两条，单条无法区分这两种缺陷）；
④ 占位写成 `0%` → 红。

## 隐藏 bug 修复 · 256 色下 diff 行绿底绿字（用户实机发现，2026-09-16）

**现象**：展开的 `write`（写入）工具卡预览**整块全绿、看不到任何内容**。

**根因**：B-3 的 256 色降级把**前景与背景分别**按"色相族"映射，两者落到同一个 256 色号：
`38;2;122;168;116;48;2;18;42;24`（柔和绿字 + 深绿底）→ `38;5;2;48;5;2` = **纯绿字压纯绿底**；
删除行同理 `38;5;1;48;5;1` 红压红。8 色档没这个问题（背景被强制为黑 `40`），所以只在 256 色终端暴露——
而这正是最常见的 SSH 终端（`TERM=xterm-256color`、无 `COLORTERM`）。

**修复**（`src/color-depth.ts`）：
- 前景改为**最近 256 立方色**（保留亮度）：`38;5;108`（#87af87）而非 `38;5;2`；
- 背景改为**中性深灰 `48;5;234`**（#1c1c1c）。曾试"取同色族的暗角"（`#005f00`），但实测对比度只有 **3.2:1**，
  低于代码行所需的 4.5:1；256 立方最暗的一档就是 `#005f00`/`#5f0000`，给不出"深色带彩"的底，故放弃底色着色、
  把色相留在文字上（8 色档本来就是黑底 + 绿/红字，语义一致）。
- 结构性结论：**背景永远不可能与自己的前景同色**。

**人工核对**：`DSH_TUI_COLOR_DEPTH=256` 启动，展开一个 `write`/`edit` 卡片：`+`/`-` 行应能看清文字，
不是色块；`=8` 与 `=truecolor` 下同样可读。

**自动证据**：`tests/color-depth.test.mjs` 新增 1 条：256 档下两组 diff 配色必须 ①前景≠背景、
②对比度 ≥ 4.5:1、③色相仍可辨（绿仍是绿、红仍是红）。

**截图证据**：`docs/screenshots/write-preview-256.png`（同一 `write` 卡片在 256 色下的修复前后）。

**mutation**：把 256 档退回"前后景同族映射"（即原缺陷）→ 该用例红（前景=背景、对比度 1:1）。

## 额度显示细化（用户要求，2026-09-16）

**要求**：底栏额度只显示**套餐名**（`SuperGrok` / `OC·GO`＝OpenCode Go / `CC·GOAT`＝Command Code Goat），
额度条**按时间窗口细分**：默认显示**最小时间窗口**那一档，并标注窗口（`5Hr` / `1Wk` / `1Mo`）。

**各套餐真实窗口（不许猜）**：
- **SuperGrok：只有周额度**（用户确认）→ `SuperGrok 1Wk 82%`；
- **OpenCode Go：5 小时 / 1 周 / 1 月**（用户确认；本机该订阅已失效，实测接口返回 HTTP 403，无实时数据）；
- **Command Code：实测**（2026-09-16 直连 `api.commandcode.ai`）：滚动 5 小时 94.2%、本周 76.3%、
  月度额度余额 88.1%（$61.69）→ `CC·GOAT 5Hr 94%`。套餐档位（`GOAT`）来自 `/alpha/billing/subscriptions`，
  这次该接口 TLS 中断，取不到时徽标诚实降级为 `CC`。
- 实测方式：用插件自己的 URL 常量/凭据名/解析器（`parseSuperGrokBilling` / `parseOpenCodeGoQuota` /
  `parseCommandCodeQuota`）读真实响应；本沙箱需 **IPv4 + HTTP 代理**，Node 的 fetch 不走该代理，故用 curl 取回原始
  JSON、再用插件解析器判定窗口。SuperGrok 的 `cli-chat-proxy.grok.com` 在本沙箱经代理仍不通（TLS 中断），
  故按用户口径。

**教训**：上一版夹具里我把 SuperGrok 写成"5Hr+1Wk"、把 OC·GO 写成"只有周窗口"，是**编造**，已按上面的真实形状改正；
夹具现在写着每档的数据来源。

**实现**：
- `QuotaSnapshot.source`（`supergrok` / `opencode-go` / `command-code`）由三个解析器各自标注；
  `shortQuotaPlanName()` 给出短徽标（`CC·` 前缀 + 档位，如 `CC·GOAT` / `CC·PRO`；无 `source` 的手工快照按文案兜底）。
- `preferredQuotaWindow()`：**按窗口精细度**取（hourly → weekly → monthly → unknown），同档取剩余更低者；
  与原有的 `tightestQuotaWindow()`（取剩余最低，供告警与刷新节奏使用）并存、互不影响。
- `formatFooterQuota(percent, badge, period)` → `SuperGrok 5Hr ███████░ 91%`；
  窗口标签是固定技术串（`5Hr`/`1Wk`/`1Mo`），**不随语言变化**——它要在截图与问题报告里保持可读。
- 窄行丢失顺序不变，但**标签不跟着徽标一起丢**：`SuperGrok 5Hr ███ 82%` → `5Hr ███ 82%`（`dropFooterQuotaPlanName` 已更新）。

**人工核对**（三种套餐各看一眼底栏身份行）：
`SuperGrok 5Hr ███████░ 91%`（同时有 1Wk 12% 时**仍显示 5Hr**）、`OC·GO 1Wk …`、`CC·GOAT 5Hr …`；
把终端收窄：先丢套餐名，`5Hr` 与额度条必须留下。

**自动证据**：`tests/helpers.test.mjs` 新增 1 条（窗口优选六种情形 + 三个徽标 + 无 source 兜底 + 标签格式 + 窄行保标签）；
`tests/footer-chips.test.mjs` 的身份行帧用例改为"两窗口、更紧的是粗窗口"，断言渲染出 `SuperGrok 5Hr … 91%`。

**截图证据**：`docs/screenshots/footer-quota.png`（四段：SuperGrok / OC·GO / CC·GOAT / 窄行丢徽标保标签）。
`scripts/capture-footer-frames.mjs` 扩到 **9 帧**（新增三种套餐 + 窄行），断言徽标与标签，并进了 `verify-batch`。

**mutation（4 组，全部验红）**：① 窗口优选退回"取剩余最低"（unit+帧双红）；② command-code 不归一化徽标（unit 红，
用 `PRO` 档区分——`GOAT` 与文案兜底等价）；③ 丢徽标时把标签一起丢（unit+帧双红）；④ `weekly` 标成 `1Mo`（unit+帧双红）。
过程中发现两处**等价变异**（`known` 过滤是死代码、`GOAT` 走兜底与走 source 同结果），已删掉死代码并改用真正有区分度的变异。

## 0.7.0-rc.2 · B-1 两个回归的修复（用户复验发现）

**用户看到的现象**：底栏状态行出现 `[33m⚠[0m`、`[90m●●●●[0m` 一类**乱码**（颜色序列的转义符被吃掉、只剩 `[32m` 这种字面量）；且**额度条不见了**——终端拉宽后才看到它跑到了上面一行。

**根因**：B-1 把状态区改成"带样式的芯片拼接"，却仍用**纯文本**截断器 `truncateToWidth` 收尾。它先做 `sanitizeTerminalText()`（只删 `ESC` 控制符、留下 `[32m` 正文），于是每个着色芯片都变成可见乱码；同一提交又把**额度条与上下文环**从身份行挪进了状态区。单元测试全部通过，因为它们喂给 fitter 的都是**无样式**芯片——这个洞只有渲染出来的帧才看得见。

**修复**：
- `truncateAnsiToWidth`（`src/term-text.ts`）：按**单元格**裁剪带样式的行，保留存活部分的转义、裁断处补 `[0m`；footer 三个 fitter 改用 `visibleWidth` 计量，样式序列**不占格**。
- 状态区整体**沿用身份行的暗色**（分隔符也在暗色内），链路芯片与 ⚠ 保持默认前景、只给强调部分上色——即 0.6.4 的样子。
- 额度条与上下文环**回到身份行**原位置（模型之后、`sub:` 之前）。

**人工核对**（重启 `dsh` 后看一眼底栏即可）：
- 第一行不应出现任何 `[32m` / `[0m` 字面量；
- 第一行与第二行同为暗色，圆点/⚠ 仍着色；
- 拉宽终端：额度条与上下文环在**第二行**模型右侧（`… grok-4.6 xhigh · SuperGrok ███████░ 82% · ⠟ 120K/200K 60% · sub:…`）；
- 缩窄终端：状态区先丢文字保住图形，身份行按原有顺序从尾部丢。

**自动证据**：
- `tests/footer-chips.test.mjs` 新增 3 条：带样式芯片的**计量与裁剪**（13 格的行不会被 20 个字符吓短、裁剪处不残留序列正文）、**配色帧内不出现转义正文**（对整帧逐行扫描 `\[(\d+;?)*m` 字面量）、**额度条与上下文环在身份行且不在状态区**；另**改严**一条：状态区每个计数分组都必须**紧跟暗色序列**（只断言"整行含 `\x1b[90m`"会被暗色分隔符蒙混过关）。
- `scripts/capture-footer-frames.mjs`（新，已进 `verify-batch`）：用真实 painter 渲染 5 个宽度/名单状态的真帧并 PNG 归档，断言：无转义正文、状态区保持暗色且链路芯片领头、额度条与环在身份行、**恰好放得下时一个分组都不许丢**（专门盯"把样式序列当格子算"的计量错误）。
- **与 0.6.4 逐像素比对**：在 `21f60c5^`（B-1 之前）建 worktree，用同一脚本渲染同一状态，`compare -metric AE` 对**状态行与身份行**均为 **0 像素差**（身份行连字节都相同）。
- 截图流水线本身也修了：`scripts/ansi-to-png.py` 改为**逐格绘制**并按 fontconfig 选字体——CJK 字体没有盲文块（上下文环、计划条进度条原本在 PNG 里是**空白**），而它有的 `●`/`░` 是双宽字形（链接圆点会挤在一起）。

**mutation 记录（4 组，全部确认变异真的生效，unit 与帧脚本同时转红）**：
① 计量退回 `displayWidth`（把样式序列当格子）→ 红；
② 裁剪退回 `truncateToWidth`（剥 ESC 留正文）→ 红；
③ 额度条/上下文环放回状态区（即 B-1 原样）→ 红；
④ 状态区失去暗色（`mutedSgr()` 返回空）→ 红。

**CI 复现与修复（同批）**：rc.2 推上去后 CI 四条腿全红，而本机（Node 22/24、含/不含 SSH 环境变量）全绿。
从 GitHub Actions 原始日志定位到唯一失败用例：`quota and the context ring live on the identity line,
never the strip` —— 它**靠链路芯片文案**找状态行（`SSH|本地|local`），而 CI runner **没有 SSH 环境**，
同一个芯片显示`本机`（en 为 `Local`），于是找不到该行。修复：状态行改为**按位置定位**
（身份行恒为最后一行、状态区为倒数第二行），期望文案由 `formatLinkQualityChip()` 现场生成；
`scripts/capture-footer-frames.mjs` 同样改为按位置定位。两处在"有/无 SSH 环境"下均验证通过。

**回归对照图**：`docs/screenshots/footer-regression.png`（上=rc.1 坏、下=修复后；同一渲染器、同一状态）。
生成方式：`21f60c5^`（B-1 之前）与 `cfb9079`（rc.1）各建 worktree，跑同一个 `capture-footer-frames.mjs`。

**CI 与状态（截至本轮结束）**：`385689d` 四条腿全绿；npm **未动**（`dist-tags = { latest: '0.6.4', next: '0.7.0-rc.1' }`）；
GitHub 无 `v0.7.0-rc.2` tag（误建后已删除，等用户指令再发）。C 批仍待用户逐项验收。

**B 批 mutation 记录**：B-1 共 7 组（芯片优先级/裁剪/点击行/事实采集等）· B-2 共 10 组（分组顺序、`order`、broken 原因优先、过滤忽略查询、大小写、移动越界、光标回夹、`/` 不进入、Enter 直接提交、Esc 取消提问）· B-3 共 4 组（不降级、色深恒真彩、none 仍留色、8 色放行真彩对）。每条变异都确认过**真的生效**（编译产物锚点不符时会静默不改，已按真实形状重做）。

## C 批 · 极简视图、diff、纯行模式、键位（逐项落地，每项一个检查点）

每项完成后在此追加一行：人工核对方式 + 自动证据 + mutation 记录。当前状态：

### C-1 极简视图对齐 Codex —— 已完成（检查点）

**人工核对**（`/view compact` 切到极简视图，跑一个会改文件并可能失败的任务）：
- 折叠的工具条目前应**逐一点名改过的文件**及其 `+/-`（超过 4 个文件时余下以「+N 个文件」收尾）；
- **失败的工具不展开也能看到**：折叠行下方以错误色单独列出（`bash  $ npm test`）；
- **默认（详细）视图不受影响**：工具卡照旧逐行渲染，不出现极简摘要。

**自动证据**：`tests/compact-summary.test.mjs`（6 条：按文件聚合与首次出现顺序、无路径工具跳过、仅失败成行、折叠行点名文件、折叠行显示失败、默认视图无摘要）。

**mutation**：① 按工具而非按文件聚合 → 红；② 折叠行不列失败工具 → 红；③ 折叠行不列文件名 → 红。
诚实说明：④「默认视图不变」这条**已断言但未找到单点变异**——把 `isCompactView()` 强制为真并不会改变帧，说明极简渲染另有前置条件（纵深防御），该性质目前由用例本身守护。

### C-2 diff 增强 —— 已完成（含并排视图）

**已交付**：工具卡不再"整文件替换"（旧行为把一行改动渲染成两百行），改为**行级 diff**：改动带上下文成对显示、相距较远的改动各自成段并**计数省略**、被替换的一对**只高亮真正变化的字符**；预算放不下正文时折叠为`路径 + 计数 + 「Enter 看全文」`，依次尝试 3 行上下文 → 1 行 → 仅改动行。
**人工核对**：编辑一个文件（一行改动即可）展开卡片：应看到 `- 原行` / `+ 新行` 成对、变化字符反色、远处未变行以 `⋯ N 行未变` 计数；把终端缩到很窄再展开：正文折叠为计数与 `Enter 看全文`。
**自动证据**：`tests/line-diff.test.mjs`（10 条：LCS 行 diff、上下文分段的省略计数、纯增/纯删、空文本、词级 span 与 emoji 不切半、紧/宽两种预算下的渲染、强调 span 位置、折叠行内容）。
**mutation**：① 不做行级 diff（整块替换）→ 5 红；② 词级裁剪 off-by-one → 1 红；③ 去掉紧凑档（紧预算下不渲染正文）→ 1 红；④ 强制折叠（永不渲染正文）→ 2 红。
**并排视图（C-2b，已补）**：终端宽度 ≥ **100 列**时，改动以左右两栏呈现（`- 原行 │ + 新行`），
栏内**变化字符仍反色**；不足 100 列自动回到堆叠——两栏会窄到每行都折行，反而更难读。
一个"改动块"按**位次**配对（diff 先输出全部删除行、再输出全部插入行，"紧邻配对"会漏掉块的其余部分，
这是我实现时踩到并修掉的）；上下文行两栏同文，便于任选一栏跟读。
**C-2b mutation**：⑤ 阈值失效（永远并排）→ 2 红；⑥ 不做配对 → 2 红；⑦ 列不补宽（竖线不对齐）→ 1 红；
⑧ 只配块内第一对（丢掉其余改动）→ 1 红。

### C-3 纯行模式（可访问性）—— 已完成（检查点）

**人工核对**：
```bash
DSH_TUI_LINE_MODE=1 dsh --profile tui --resume
```
- 启动横幅、命令报告、回复都应是**追加的纯文本行**（无备用屏切换、无原地重绘、无动画）；
- 用 `... | tee session.log` 收一遍：日志里每个事件恰好一次、顺序与发生顺序一致；
- `DSH_TUI_LINE_MODE=1 dsh --profile tui --resume | cat -v` 不应出现 `^[[?1049h`、`^[[<行>;<列>H` 或裸 `^M`。

**自动证据**：`tests/line-mode.test.mjs`（9 条：环境开关、各类行的事件行、屏幕专用行不输出、追加不含 CR/ESC、真机外的流断言：无寻址/无备用屏/无裸 CR/事件恰好一次且有序、行模式下不组帧）；
真机探针 `node scripts/tui-probe.mjs --line-mode`（已纳入 `verify-batch` 第六/七步）。

**mutation**：① 行模式仍绘帧 → 1 红；② 事件不追加（被合并/丢弃）→ 1 红；③ 追加带裸 CR → 2 红；④ 屏幕专用行也输出 → 1 红；
⑤ **接入时不清刷缓冲** → 真机探针失败（启动横幅丢失）。

**真机运行抓到的三个真实缺陷**（都已修，正是这个模式最不能有的"丢事件/留备用屏"）：宿主在显示接入前就产生了启动事件，而宿主 stdout 是被丢弃的管道 → 这些行**原本全丢**，现缓冲到接入时清刷；启动器的开机 splash 会进备用屏 → 行模式下不画；relay 的临时状态行用裸 `\r` 自擦 → 行模式下不发。

### C-4 键位可配置 —— 已完成（检查点）

**人工核对**：在 `$DSH_HOME/settings.yaml` 写入
```yaml
ssh-tui:
  keys: { pageUp: ctrl+b }      # 也可试 toggleCard: ctrl+t / cancel: ctrl+g
```
重启 TUI：`Ctrl+B` 应翻页，而**原来的 PageUp 变为无操作**（不是回落旧行为）；把两个动作指到同一个键（如 `pageDown: pgup`）时，
启动应出现一行「键位配置有问题…」提示，且该键**什么都不做**而不是做错事；未改动的键（Enter/Esc/PageDown…）行为与以往一致。

**自动证据**：`tests/keymap.test.mjs`（12 条：默认键位、名称→序列、覆盖生效、冲突拒绝并上报、位移后旧键仍可被他人认领、未知动作/键上报、仅被移动的动作走查表、被顶掉的旧键被抑制、TUI 级：新键生效+旧键无操作/未改默认仍可用/冲突时启动提示且键无操作）。
**mutation**：① 冲突被接受（后者胜出）→ 3 红；② 未知动作静默接受 → 1 红；③ 被顶掉的旧键不再抑制 → 2 红；④ 覆盖动作不走查表 → 1 红。
**顺带修正**：`ctrl+shift+c` 的默认映射最初被我写成 0x03，与 Ctrl+C 撞车；改为 TUI 实际监听的 kitty 序列 `\x1b[99;6u`。

- C 批收尾：**四个功能全部完成**（C-1 极简视图 / C-2 diff 增强含并排 / C-3 纯行模式 / C-4 键位），
  七步 `verify-batch --batch C` 全绿；等用户逐项复核。
- C-3 纯行模式（可访问性）—— 待开工
- C-4 键位可配置 —— 待开工

## D 批 · 桌面兼容与管道宿主

一句话：桌面版那条路（Electron-as-Node 启动器无 console）早已按"插件保持惰性、不弄坏宿主"处理
（`docs/desktop.md`）；本轮补的是**另一条路**——宿主自己会开终端控件时，怎么把这个 TUI 当子进程用。

一键复核：

```bash
node scripts/probe-home.mjs --probe --script tui-stdio-probe.mjs   # 真 profile、全程无 PTY
node --test tests/stdio-pipe-e2e.test.mjs tests/display-mode.test.mjs
```

| 项 | 人工核对 | 自动证据 |
|---|---|---|
| D-1 管道宿主可用 | 任何"能喂字节 + 解 ANSI"的宿主（xterm.js 面板、GUI 里嵌的终端）按 `docs/display-mode.md` 起 `DSH_TUI_DISPLAY=stdio`：应看到完整画面、按键有反应、`/exit` 正常退出；宿主不回答 `CSI 6n` 时也能跑，只是接入慢约 0.7s | `tests/stdio-pipe-e2e.test.mjs`（真 relay + 真 Host，两端都是管道：attach、初始尺寸、按键、goodbye）、`scripts/tui-stdio-probe.mjs`（CI Linux/Windows 两条腿） |
| D-2 面板尺寸 | 宿主发 `CSI 8 ; rows ; cols t`：画面按新宽度重画（分隔线长度跟着变），且这串字节**不会**出现在输入框里 | `tests/display-mode.test.mjs`（含跨读暂存）、`tui-stdio-probe.mjs` 的 120 列断言 |
| D-3 曾经不可用 | 修前：管道上 attach 直接 `TypeError: stdin.setRawMode is not a function`（`display-sock.ts` 未加 `?.`）——整个模式从一开始就起不来 | `tui-stdio-probe.mjs` 修前失败即此异常 |

**mutation**：① `stdin.setRawMode?.(true)` 还原为未加 `?.` → 管道 e2e 红（TypeError）；② 尺寸报告不从输入里剔除 → `display-mode` 单位测试 2 红 + 探针"不许画成按键"红；③ 报告组下标写回 `match[2]/match[3]`（差一位）→ 尺寸测试 4 红。

**同时修掉的两类残留**（用户已验收 ①，②等复现）：① 渲染缓存把"活尾巴"（等待卡/流式缓冲/无回复突发）收进最后一行条目 → 每帧重放出冻结在旧秒数的"处理中"；② 光标探针的两处痕迹：探针行自己不清（`①—…“”·•Ⅰ` 留在提示符前）、回答在归还终端后被 tty 回显成 `^[[25;1R`。另外极简视图单文件编辑卡不再重复自己的标题、失败行补回状态球。

## E 批 · 底栏架构（状态行重排，本轮交付）

一句话：底栏从"telemetry dump"改成一排仪表——第一行只回答五个问题（链路健康 / 正在做什么 /
tok/s / 额度余量 / 上下文占用），第二行只留 workspace 元数据；轮数、步数、模型时间、工具时间、
缓存命中退出常驻区（数据与统计逻辑一行未删，全部收进 `/status` 与 `/diag`）。

一键复核：

```bash
node --test tests/footer-strip.test.mjs tests/footer-chips.test.mjs tests/helpers.test.mjs tests/paint-budget.test.mjs
node scripts/footer-windows-probe.mjs                                       # 8 个 Windows 终端档位（强制 win32）
DSH_TUI_ASCII=1 node scripts/probe-home.mjs --probe --script tui-term-probe.mjs   # 真 PTY，ASCII 档
node scripts/footer-samples.mjs all zh                                      # 72/88/100/120/160 全状态渲染样例（人看的）
node scripts/footer-samples.mjs all en                                      # 英文同一套样例
```

**缩放卡顿（E-15，用户实机反馈）**：`paint-budget.test.mjs` 里 `a drag renders the tail of the transcript` /
`the frame after a drag is the whole transcript again` / `a reader who scrolled back keeps their view` /
`the work one resize event costs does not grow with the transcript` 四条把这一轮的行为钉住——拖动中渲染的是
transcript 尾部、停下后整屏恢复、滚动位置不被折叠、单事件代价不随会话长度增长。宽度语义由 `helpers.test.mjs`
的 `displayWidth` 用例守着（`charCellWidth` 只是把策略查找从"每字符"提到"每字符串"，一格都没有改）。

**尺寸变化（E-10）**：状态行的自适应依赖 relay 把"现在的"终端尺寸报给 Host。0.8.1 的 relay 在 attach 时
快照一次 `relayTerminalSize` 并在防抖回调里反复上报那份快照，所以第一次 resize 之后 Host 看到的尺寸永远
没变、`changed === false`、直接跳过重绘——拖窗口什么都不会发生（`tui-probe.mjs` 只断言"产生了字节"，而陈旧
尺寸照样产生字节，所以一直没被发现）。更糟的是**半屏错位**：Host 按它以为的宽度排版，于是比它窄的终端只被
重画左边一部分、右边留着上一帧的字形（"窗口变大后半屏是旧的"），比它宽的终端则被终端截断在右边。
修法分三层：

1. `display-sock.ts`：管道父进程声明的尺寸仍归父进程（`reportedSize`），**自己持有的终端每次发送时现读**；
2. `display-sock.ts` 再加 `SIZE_RECHECK_MS = 1s` 的兜底轮询：事件漏了（多路复用器不转发、窗口跨显示器、
   conhost 只报初始尺寸）也能自愈，只在几何真的变了时才发帧；
3. `tui.ts`：resize 不再"一事件一帧"。每个事件只推后一个 deadline——
   `min(最新事件 + 60ms, 上次绘制 + budget)`，其中 `budget = clamp(2 × 上一帧实测耗时, 60ms, 400ms)`；
   帧在**真正绘制的那一刻**读取终端尺寸，所以永远不会出现"新几何晚于旧几何被画出来"。
   拖动 400 行会话：60 个事件 60 帧 → **6–7 帧**（270KB → 26–32KB）；单个 resize 约 60ms 落地。

证据：`tui-probe.mjs` 新增 2b 段（真 PTY，无需模型，CI 两条腿都跑）——扫 `60/120/60/120` 四个尺寸，断言每次
都重绘、**120 列的帧明显大于 60 列**、并且回到同一尺寸时状态行逐字相同；`tui-mock-probe.mjs` 第 6 步断言跨 8 个
尺寸的重排与回返；`tests/paint-budget.test.mjs` 三条策略用例；`tests/display-sock.test.mjs` 两条 relay 用例
（现读 + 轮询兜底）。变异：把 relay 改回冻结快照并关掉轮询 → 真 PTY 探针 4 次 resize 全部 0 字节、"
帧必须随终端缩放"失败。

| 项 | 人工核对 | 自动证据 |
|---|---|---|
| E-1 第一行信息优先级 | 底栏第一行应为 `SSH ●●●● 31ms │ ⠹ <动作> · 28s │ 158 tok/s │ 5Hr ███████░ 82% │ CTX █████░░░ 61% · 610K/1M │ Tok 36.8M`（顺序固定：链路 → 动作 → 速度 → 额度 → 上下文 → 会话总量）；**不要再出现** `2 轮 · 5 步` / `模型 4s` / `缓存命中 28%` / `输入… 输出…` | `tests/footer-strip.test.mjs`（宽行逐字断言 + 顺序断言） |
| E-2 越窄越简洁 | 依次把终端缩到 100 / 88 / 72 / 60 / 48 / 40 列：应依次丢掉 `Tok 36.8M` → 上下文比 `· 610K/1M` → 上下文进度格 → 额度进度格 → 空闲动作 → `5Hr`/`CTX`/`tok/s` 缩写 → 最后才是 SSH 圆点；每一步都比上一步**窄**，绝不换行、绝不加挤 | `tests/footer-strip.test.mjs`（8 个宽度的逐字样例 + 单调性断言）、`tests/footer-chips.test.mjs`（24 列仍保住 ⚠） |
| E-3 tok/s 语义与颜色 | `tok/s` 只有两种形态：运行中 `~160 tok/s`（字符速率 × 本会话标定比，估算），空闲 `158 tok/s`（上一轮精确值）；**任何模型、任何数值都不着色**；没有数据时不显示（运行中宽屏显示 `— tok/s`） | `tests/footer-strip.test.mjs`（`performanceValue` 中性、`~` 标记、四档速率无 SGR）、`tests/throughput.test.mjs` 的平滑/标定用例 |
| E-4 额度与上下文阈值同源 | 额度色板取 `quota.ts` 的 `QUOTA_ALERT_THRESHOLDS` 前两档（剩余 50% / 25%）；上下文色板取 harness 自己的 `contextPressure` 压力档（80% / 95%，即压缩告警那两档）。同一个数字在 footer 与告警里必须是同一个颜色 | `tests/footer-strip.test.mjs`（`capacityLevel` 断言两套档位）、`tests/helpers.test.mjs` |
| E-5 一次性复用组件 | 三个 primitive：`healthMeter`（离散格，SSH 圆点就是它）、`capacityMeter`（used / remaining 双向 + 段数 + percent-only + ASCII + 状态色）、`performanceValue`（中性 / 实时 / 历史 / 不可用）；额度与上下文共用 `capacityMeter`，不是两套字符串拼接 | `tests/footer-strip.test.mjs` |
| E-14 缩放即时化 | 拖动不再受固定帧率下限约束：Host 直接读**真实背压**（直连 `stdout.writableLength`；relay 新增 `DisplayHost.pendingBytes()`），线通畅时**一个 resize 一帧**（仅用 16ms 合并同一毫秒的连发事件），线积压时才退到 deadline；保守 budget（200ms）**只在未探测链路**生效。实测：12 事件→12 帧且末帧尺寸正确；模拟积压 64KB 时 31→9 帧、排空后补画末帧 | `tests/paint-budget.test.mjs`（`linkRedrawBudgetMs` 表、通畅=每事件一帧、积压跳过、排空后补画）、`scripts/tui-probe.mjs`（真 PTY 尺寸扫描） |
| **E-15 缩放不再随会话变长而变卡**（用户实机反馈） | 实机症状："快速拖窄再还原，排版慢慢窄再恢复，且必须等重排完成才能操作输入框"。定位到**两处**，都不是节流参数：**① 每帧重排整个 transcript** —— 宽度是每行渲染指纹的一部分，拖动时**全部行**都要重新换行裁剪；同机 A/B 单事件同步耗时（中位 / 峰值）：803 行 **126.1 / 149.1ms**、2403 行 **380.2 / 589.0ms**、5000 行 **793.0 / 1137.2ms**，而这段同步时间就是按键送达延迟（30 个事件累计阻塞 **3.8s / 11.7s / 24.0s**）。改为拖动中只渲染 transcript 尾部（复用 `--resume` 已有的 `paintTailBudget`，`RESIZE_TAIL_MIN_ROWS`），指针停下后**自动抬升并整屏重画一次**（`widenPastResizeTail` 必须带 settle 重挂，否则折叠永久留下——E-m17）；**② 逐字符策略查找** —— `displayWidth(char)` 在裁剪/换行循环里逐字符调用，每次重建 55 字节策略 key，CPU profile 里占拖动样本的 **56%**。改为每次字符串解析一次策略并下传（`charCellWidth(cp, policy)` / `unitCellWidth(mappedUnit, policy)`）。修后同机同条件：单事件中位 **6.2 / 0.6 / 6.2ms**、峰值 **27.3 / 24.2 / 25.4ms**，30 事件累计阻塞 **130 / 148 / 143ms**（**29× / 79× / 168×**），拖动中按键回显 **11.6–18.1ms**，帧字节数**比 HEAD 少约 25%**，最终画面尺寸与不折叠时逐格一致 | `tests/paint-budget.test.mjs` 四条新用例（尾窗、拖动后整屏恢复、滚动位置不被折叠、单事件代价不随 transcript 增长）、`tests/helpers.test.mjs`（宽度语义不变）、**逐字节 parity 实测**：420 个字符串 × 4 个宽度 × 5 种策略（默认/窄/宽/reserve/CJK locale）× 2 种 tty × 2 种 ASCII = `displayWidth` / `visibleWidth` / `truncateToWidth` / `clipAnsiToWidth` 与 HEAD **完全一致**（首轮曾发现 50 处差异：tab 当 0 格、`▶`→`> ` 这类多字符 ASCII 映射按首码点量成一个格，已修）、`scripts/tui-probe.mjs`（真 PTY 尺寸扫描 60→1595B / 120→4184B）、`capture-footer-frames.mjs`（19 帧）、`footer-windows-probe.mjs`（8/8）、`tui-term-probe.mjs`（8/8）。变异 E-m16/E-m17/E-m18 |
| **E-16 变大方向的拖沓**（用户实机复验后追加） | 实机反馈：最大化/还原已经很快，连续拖拽**大→小非常流畅，小→大略显拖沓**。定位：两方向的 CPU 与总字节基本对称（中位 6.6 vs 12.2ms、88.7KB vs 91.8KB），不对称的是**每帧字节数与宽度成正比**——60 列 3.7KB、140 列 7.3KB，且 140 列那帧 89% 是 transcript 文本（实测 padding 为 0 字节，没有可裁的肥肉）。终端按字节/格消费，所以**变大的方向每帧都比上一帧大、积压一路累积**：字节速率限流消费者模型下，指针停下后还要排空 **30–44ms**（变小方向 0–10ms）——这正是"手停了画面还在动"。两条修法（用户选 C=都做）：**① 拖动帧只画 chrome**（分隔线/输入框/统计行/状态行）：新增 `PaintOptions.dirtyFrom`，带它的帧不清屏、不碰其上任何行；帧大小 3.7–7.3KB → **556–988B**，且**不随列数增长**；**② 拖动背压门槛改为"一帧为界"**（`resizeWireBehind` = `pending > max(2KB, 上一帧字节数)`，取代固定的 32KB——那是节奏路径的问题，不是拖动的问题）。实测（20 事件 @16ms，同机同条件）：整场拖动 **110KB → 9.3–12.7KB**；**两方向"指针停下后排空"都是 0ms**（0.4MB/s 与 0.2MB/s 两档）。拖动帧只画 chrome 期间，transcript 由终端自己的 reflow 呈现，指针停下后的整屏帧把它校正回我们的模型（`paintTailBudget` 早已决定何时可以把 transcript 留下，`dirtyFrom` 只是这件事在帧上的另一半） | `tests/paint-budget.test.mjs` 六条新用例（拖动帧只寻址 chrome 行且不 `\x1b[J`、chrome 帧 < 完整帧的 1/3、收尾帧从第 0 行整屏重画、背压 4KB 时跳过、低于 2KB 地板不跳过、**chrome 帧不得把它没画的行记成已画**）、`scripts/tui-probe.mjs`（真 PTY 尺寸扫描仍 60→1595B / 120→4184B：短会话不折叠，仍是完整帧）、`capture-footer-frames.mjs`（19 帧）、`footer-windows-probe.mjs`（8/8）、`tui-term-probe.mjs`（8/8）。变异 E-m19/E-m20/E-m21 |
| E-13 债务清理 + 冻结 | 六项按 `docs/plans/footer-debt.md` 执行：**D-3** 只在 harness 自己报了 total 时才画 `Tok`（口径不一致宁可不画）；**D-4** 首轮 `~tok/s` 按当前流式文本的 **CJK 码点占比**在 0.32/0.85 之间**连续插值**（无硬阈值），首条 settled usage 后交给既有 session calibration；**D-5** 未探测到 DSR 的链路用 `RESIZE_UNKNOWN_LINK_BUDGET_MS = 200` 作拖动 redraw budget（**不是** RTT，底栏仍画 `SSH ○○○○ 160ms`）；**D-6** `⚠` 并入 budget 阶梯（`priority: -1`），状态行只剩一条 width convergence path；**D-1** `accent` 移入 `color-depth.ts`，删除 `footer-accents.ts`；**D-7** 八个 legacy 导出标 `@deprecated ... removed in 0.9`（0.8.x 不删） | `tests/footer-strip.test.mjs`（含首轮英/中/混排估算、`note(text)` API）、`tests/footer-chips.test.mjs`（⚠ 点击与窄屏）、`tests/paint-budget.test.mjs`（拖动节流）、`scripts/capture-footer-frames.mjs`（19 帧）、`scripts/tui-probe.mjs`、`tui-term-probe.mjs`、`footer-windows-probe.mjs` |
| E-12 第二行按优先级排序 | 第二行**本身就是优先级顺序**，裁切仍从右边开始（一套机制）：`[极简] · 目录:… · 余额 … · 搜索 i/n · 多行输入 · 排队 n · sub:… · OpenCode-GO/CommandCode-GOAT`。`标准模式`不再出现在底栏（顶部横幅已永久显示）；订阅徽章只给两个有具名套餐的路由——`OpenCode-GO`、`CommandCode-GOAT`（首次 billing 回复落地前只报厂商名 `CommandCode`，不猜 tier；SuperGrok 的窗口标签已说明、DeepSeek 是余额制，都不加徽章），且排在最末、最先被窄屏丢掉 | `tests/footer-strip.test.mjs`（`planRouteBadge` 全表 + 行内位置 + 窄屏先丢徽章）、`tests/helpers.test.mjs`（第二行逐字顺序、28/18 列裁切） |
| E-11 活动芯片只报状态 | 状态行活动芯片只显示"在做什么"（`终端` / `edit` / `思考中`）+ 秒表：**不显示具体命令、不显示路径**（`⠹ 终端 · 28s`，不是 `⠹ 终端 · command: npm run build · 28s`）。具体是哪条命令、哪个文件，由上一行的卡片负责 | `tests/footer-strip.test.mjs`（活动芯片只降级字形与秒表）、`scripts/capture-footer-frames.mjs` 的 `footer-running-tool` 帧 |
| E-9 模块分层 | `src/footer.ts` 只做 barrel，实现按四层拆开且只向下依赖：`footer-format.ts`（值 → 文本，含上下文压力读数）→ `footer-meters.ts`（三个 primitive，不知道行/宽度/顺序）→ `footer-budget.ts`（退化阶梯与状态行，只有它能决定丢弃/缩写）→ `footer-layout.ts`（两行 chrome + `/status`）；另加 `footer-accents.ts` 打断 meters↔budget 的唯一环 | `npm run typecheck`；导出面比对（拆前 87 个导出，拆后 87 个，无缺失/无重复） |
| E-6 终端兼容 | truecolor / 256 / 8 / no-color 与 Unicode / ASCII 六种组合下都是同一行、同一套语义：ASCII 用项目既有字形表（`*` `o` `#` `.`），单元格数与 Unicode 一致；`?%` 不被画成 `0%` | `tests/footer-strip.test.mjs`（ASCII 行逐字 + 等宽断言、无色行无转义、8 色降级无 `38;2`）、`scripts/footer-windows-probe.mjs` |
| E-7 Windows 档位 | Windows Terminal（含无 `COLORTERM`、含 SSH 回来）、conhost、conhost 旧代码页（自动 ASCII）、VS Code 终端、纯管道（桌面）、`NO_COLOR`：每一档画出的行都必须落在该终端能解码的字形/颜色范围内，且 24bit 不进 8/256 色终端 | `scripts/footer-windows-probe.mjs`（8/8 档位）、`scripts/tui-term-probe.mjs` 的 `win32Only` 档（含新增"旧代码页 conhost"，在 Windows CI 腿上跑） |
| E-8 `/status` 不丢信息 | `/status` 继续打印轮数、步数、输入/输出/缓存 token、会话总量（并注明口径：harness `totalTokens` 还是分段相加）、模型时间、工具时间、TTFT、缓存命中率，以及 tok/s 的定义与跨度（最近一轮精确值 + 运行中估算） | `tests/footer-strip.test.mjs`（`formatStatusStats` / `formatStatusThroughput`） |

**mutation 记录**（改 `lib/` 编译产物后跑 `node --test tests/footer-strip.test.mjs`，每次恢复原文）：

| # | 变异 | 变红用例数 |
|---|---|---|
| E-m1 | 收敛循环写死 `level <= 0`（永远不降级） | 9 |
| E-m2 | 实时 tok/s 不再用 `~` 标记 | 3 |
| E-m3 | `tok/s` 实时值被涂成绿色 | 3 |
| E-m4 | `Tok` 总量不再第一批被裁掉 | 9 |
| E-m5 | 额度/上下文表不再给读数着色 | 5 |
| E-m6 | ASCII 档不再自选字形（`ascii: true` 被忽略） | 5 |
| E-m7 | 窄屏时 `activity` 不再降级（永远保持 level 3 形态） | 7 |
| E-m8 | 运行中一律按 `live` 处理（陈旧估算不再回退到精确值） | 3 |
| E-m9 | relay 恢复成"attach 时快照一次尺寸"（`currentSize` 返回冻结值） | `tests/display-sock.test.mjs` 红；真 PTY 探针 7 次 resize 里 6 次 0 字节 |
| E-m10 | 拖动预算忽略链路节奏（`resizeBudgetMs` 去掉 `paintIntervalMs` 项） | 慢链路上帧按 40ms 堆叠、屏上落后于指针 |
| E-m11 | 第二行改回"预设在前、状态在后"的顺序 | `tests/helpers.test.mjs` 的 28/18 列裁切用例红（排队先于目录被删） |
| E-m12 | `Tok` 不再看口径（`parts only` 也画） | `rz-d3` 实测 `parts only` 那行多出 `Tok`；`footer-chips` 3 条红 |
| E-m13 | 首轮估算回到固定 0.32 | 中文首轮掉到 `~37 tok/s`（实测应为 `~98`），混排 `~67` 退化；`footer-strip` 3 条红 |
| E-m14 | 拖动预算忽略"未探测"来源 | 未探测链路按 160ms 节奏堆帧；`paint-budget` 3 条红 |
| E-m15 | `⚠` 退回 `fitFooterChips` 二段拟合 | `⚠` 从阶梯移除 → `footer-strip`+`footer-chips` 7 条红 |
| E-m16 | 拖动不再收窄重排窗口（`narrowToResizeTail()` 不调用） | `paint-budget` 3 条红（尾窗/抬升/单事件代价） |
| E-m17 | 收窄后不再在安静时重试抬升（去掉 settle 重挂） | `paint-budget` 2 条红：折叠会永久留下 |
| E-m18 | 逐字符循环回到 `displayWidth(char)`（语义完全等价，纯性能） | `paint-budget`+`helpers` **220 条全绿**（宽度语义确实没变），但 `truncateToWidth` 1225→15861ms（**12.9×**）、`clipAnsiToWidth` 709→16319ms（**23.0×**） |
| E-m19 | 拖动帧不再只画 chrome（去掉 `dirtyFrom`） | `paint-budget` 1 条红（拖动帧寻址到 transcript 行） |
| E-m20 | 拖动背压退回固定 32KB | `paint-budget` 1 条红（4KB 积压时 12 个事件全画了） |
| E-m21 | chrome 帧把整屏快照记成"已画" | `paint-budget` 1 条红。**注意**：这条测试我写错过一次——第一版先抬折叠再检查，而抬折叠本身改变了 `paintRows`，于是每一行都算脏，变异体照样全绿；改成"同一折叠态 + 同一宽度 + 不强制重画"后才能真正区分 |

---

## B0 批 · Interaction Surface 第一阶段：durability 与语义所有权

一句话：**先让状态有唯一的真相、输入有唯一的主人，再谈任何像素。** 本轮只做 B0a（durability/correctness）
与 B0b（semantic ownership / focus），不动任何可见布局。

### B0a-1 · ask-user 的 durable 状态接进 replay

Assessment 的结论是：问题只作为**活请求**存在（对话框 + 它推的那张卡），而 Session 早就记下了真相——
`tool/call`(name=ask_user_question) 带问题、`tool/result`（或迟到的 `user-question-reply`）带答案，
`@deepseek-ai/dsh-user-questions` 把两者折成 **session projection**。实测 live 与 resume 的差异是
`[tool + question]` vs `[tool]`——同一个会话，活着看和回放看不一样。

接法：`ctx.sessionProjections.stateOf(session, 'userQuestions')` 读 `{active, settled}`，落到
`src/question-state.ts`（纯函数：view + `questionsOf(callId)` → 每题的记录），`tui.ts` 在
`QUESTION_FOLD_EVENTS`（`request/header`/`tool/call`/`tool/result`/`user/message`）之后重建卡片。
**卡片从此只有一条写入口**（`ensureQuestionCard`），live 与 replay 走同一条。

两条 Harness 自带的限制，按真实 API 实现并记录：

1. projection 只跟踪**timed** 的 `ask_user_question`（`request/header` 里带 wait 参数的那套 schema）；
   旧 blocking schema 两边都不出现 → 这种情况保留 **live 请求自己拥有卡片** 的回退路径（`durable` 未置位）。
2. projection 服务可能根本没注册（裸 Context、没有 `dsh-session-projection` 的嵌入方）→ 同上回退。

`continued`（窗口关闭但 Session 仍接受答案）按官方通道 `ctx.userQuestions.answer(agent, callId, batch)`
做成**可再回答**：卡片保留原选项（否则第二次回答会退化成自由文本、且 batch 与调用的形状不符），
在卡片上按 Enter 打开同一个问题对话框，答案经 service 回流（那条 `user-question-reply` 才是关闭它的事件）。
**不**在 resume 时自动弹窗。

### B0a-2 · 四个已证实的 input 缺陷

| 缺陷 | 修法 |
|---|---|
| 对话框里按 Ctrl+D 走到进程退出 | 只有 composer 拥有退出键；surface 拥有键盘时忽略 |
| confirm 下 ↑/↓ 泄漏到背后的 transcript（移动 selection、非空时还会被 history 覆写） | 任何 surface 拥有键盘时，它不使用的方向键**消费并丢弃**，不再 fall through |
| paste 无视模式写进隐藏的 composer buffer | paste 与普通文本走同一个 ownership 判断：有文本框的 surface 收进自己的 field，没有的**丢弃** |
| inspect overlay 的 PgUp / 滚轮方向与 ↑/↓ 相反 | `scrollActiveSurface(up)` 统一"正 = 向上"；transcript 与 overlay 各自换算，非 inspect 的 surface 不收滚动 |

### B0b · Interaction 与 Picker 的语义拆分

`this.dialog` 过去同时承载两者，而状态行读的是**形状**：`/model` 菜单让底栏说"等待回答"，approval（`confirm`）
让底栏说"空闲"。现在**打开者声明角色**（`SurfaceRole`：`interaction{ask}` / `picker` / `dedicated`），
队列也带角色；状态行只认 `interaction`，且 `confirm`（本地确认，agent 并未被阻塞）不算等待。
新增 `等待审批`；`continued` 的问题不再被当成"agent 在等"。

### B0b · composer draft 的所有权

composer 的 `input` 同时是每个对话框的文本框（自由文本答案、setup 字段、picker 过滤）。现在需要文字的
surface **借一个自己的字段**（`borrowedText`），composer 的 draft 直到 composer 自己是被输入的对象为止都不动。
绘制仍在同一行、同一几何（这是所有权，不是布局）。

### 验收

| 项 | 结果 |
|---|---|
| 全量测试 | **1168 · 1164 pass · 0 fail · 4 skipped**（新增 `tests/question-fold.test.mjs` 6 条、`tests/interaction-surface.test.mjs` 20 条） |
| 真 PTY | `tui-probe`：尺寸扫描 60→1595B / 120→4184B + boot/diag/doctor/copy/preset/exit 全过 |
| 终端档位 | `tui-term-probe` 8/8、`footer-windows-probe` 8/8、`capture-footer-frames` PASS(19) |
| 行模式 | 交互仍被文本化（新增用例），framed 与 line mode 共用同一套 semantic state |
| Standard / Compact | 同一语义状态（新增用例：两种视图下 question / picker 的状态文字逐字相同） |

变异（每条都真跑）：

| # | 变异 | 结果 |
|---|---|---|
| B0-m1 | picker 声明成 interaction（回到按形状判断） | `interaction-surface` 1 条红 |
| B0-m2 | paste / 文本 fall through 到 composer | 2 条红 |
| B0-m3 | Ctrl+D 从 surface 内也退出 | 1 条红 |
| B0-m4 | 方向键重新泄漏到 transcript | 1 条红。**注意**：第一版测试是假绿——`↑` 之后又按 `↓` 把泄漏还原了；改成单键断言才真正区分 |
| B0-m5 | 关掉 durable fold（`syncQuestionRows` 不跑） | `question-fold` 4 条红 |
| B0-m6 | overlay 滚动符号回到"两边加同一个 delta" | 1 条红 |
| B0-m7 | 再回答时丢掉原选项 | 1 条红 |

**一处实现期自查**：`askQuestion` 的 role 包装最初写成 `resolve => resolve`（恒等函数），
promise 永不 resolve——被 `mode-command` / `preset-command` 两个既有用例立刻抓住（4s 超时），
修好后全绿。**测试先于信任**。

---

## B1.1 批 · Interaction Region Separation

一句话：**interaction 可以盖住历史，但不能重新定义历史。**

### 之前为什么会挤压

`paintFrame` 把 dialog 直接拼进 `paintRows`，并从 transcript 自己的预算里扣掉它：

```ts
const reserved = RESERVED_BOTTOM_LINES + (inputRows - 1) + headerLines.length + suggestionLines.length + planDockLines.length + 1
const available = Math.max(0, height - reserved - dialogLines.length)   // ← 这里
const window = windowTranscript({ lines, available, scrollOffset })
```

后果不止"少几行"：窗口换了，`start` 就变，`transcriptScrolled` 变真，`sizeChanged` 变真——于是**打开一个提问会触发整屏清屏 + 全量重画**（真 PTY 实测：30 行 / ~3.6KB）。读者看到的是历史被推走，而 interaction 看起来就是 workspace 的一部分。

### 现在的模型

```
transcript window = 只由自身几何决定：height - reserved - pickerLines（picker 仍挤压，B1.2）
base rows         = [header, …transcript, …planDock, …picker, divider, …suggestions, …composer, stats, status]
interaction layer = 从 divider 往上占 N 行，**覆写** base 上对应的行（那些是 transcript / plan dock 的行）
```

`windowInteractionLines(lines, cap, focus)`（`src/dialogs.ts`）负责窗口化：够高就整段画；不够高就围绕**当前高亮行**开窗，首行写 `… N`，并**保留最后一行**（键位提示）——矮终端上仍然可回答。这不是 InteractionViewport 框架，只是一个局部 helper。

### 谁拥有什么

| 层 | 拥有 | 说明 |
|---|---|---|
| transcript window | 自己的 `available` / `scrollOffset` / `start` | interaction 的存在不进入这些计算 |
| interaction layer | divider 以上的最后 N 行 | 只覆写，不重排；`interactionRegion = {top, rows}` 记录覆盖范围 |
| plan dock | 仍由 plan 行驱动 | z-order：transcript < plan dock < **interaction**（interaction 优先可操作） |
| composer / footer | 几何与位置一字未动 | interaction 直接贴在输入分隔线之上 |
| inspect overlay | 仍整帧替换（早退） | 未改 |

### 验收

| 项 | 结果 |
|---|---|
| 窗口锚点 | ask-user / approval / plan-review 打开与关闭：`lastTranscriptStart` 与 `scrollOffset` **不变**（approval 与"卡片已在日志"的 ask-user 实测 `73 → 73`、`71 → 71`、滚动回看 `64 → 64`） |
| 覆盖而非重排 | layer 之上的每一行与 base 帧**逐行相同**（用例按同一行号比对） |
| 对照组 | picker 仍然挤压（`71 → 75`，无追加）；transcript 真实追加仍然 tail-follow（`+1`） |
| 命中测试 | 被覆盖的行不再是 clickable / link / 可拖选目标；`selectableLineAt` 在 region 内返回 undefined |
| 增量重绘 | 打开 8 行 1125B、移动选择 8 行 1125B、输入自由文本 7 行 977B —— **均无清屏**（120×30，200 行会话）；滚轮在 layer 打开时 0 行 |
| 真 PTY | 新增 6c 段：`/dialog-test` 起真实问答 → `↑/↓` 只重画 ≤12 行且起始行 ≥5、无 `\x1b[H\x1b[J` → Enter 回答后状态行离开"等待回答"、`dialog answer` 回流 |
| 全量测试 | **1187 · 1183 pass · 0 fail · 4 skipped**（新增 `tests/interaction-region.test.mjs` 19 条） |
| 渲染样例 | `scripts/interaction-samples.mjs`（72/120 列 ×20 行，`--short` 另加 12/10 行）：base 与 layer 帧并排，`▸` 标出被覆写的行，并分别打印 window start / scrollOffset / layer / model rows |

变异（真跑）：

| # | 变异 | 结果 |
|---|---|---|
| B1.1-m1 | `available` 重新减去 interaction 行数（回到挤压模型） | `interaction-region` **7 条红** |
| B1.1-m2 | 被覆盖的行仍是点击/拖选目标 | **2 条红** |
| B1.1-m3 | interaction 变化时强制整帧重画（`chromeStart = 0`） | **1 条红** |
| B1.1-m4 | picker 也归入 interaction layer | 对照组 **1 条红** |

**两处实现期自查**：① 测试 helper 写成 `async` 且 `return pending`，会 await「用户回答」这个永不 resolve 的 promise——整个文件静默超时；改为只等 dialog。② "卡片追加"与"层挤压"必须分开量：新提问第一次出现时会追加它自己的卡（durable 事件的正常 tail-follow），那一次整屏重画不是 B1.1 的锅，样例里已用 `model rows N → M` 显式区分。

## B1.2 批 · Picker Overlay & Composer Boundary

一句话：**共享 layer，不共享语义。**

picker（`/model`、`/view`、`/theme`、preset 向导……）不是 agent 的提问：没有人被它挡住，它改的是运行环境而不是任务。B1.1 把 task interaction 从 transcript 的尺寸计算里摘了出来，picker 当时明确留着挤压（对照组用例守着）。这一轮把 `SurfaceRole === picker` 的 framed renderer 全部并入同一个 transient layer，并给 composer 画出属于它自己的上边界。

### 迁移

```ts
// before（B1.1）
const interactionLines = this.dialogRole.kind === 'interaction' ? dialogLines : []
const pickerLines      = this.dialogRole.kind === 'interaction' ? [] : dialogLines
const available = Math.max(0, height - reserved - pickerLines.length)   // ← picker 仍在预算里

// after（B1.2）
const dedicatedLines = this.dialogRole.kind === 'dedicated' ? dialogLines : []   // onboarding 仍挤压
const layerLines     = this.dialogRole.kind === 'dedicated' ? [] : dialogLines   // interaction 与 picker 都走 layer
const available      = Math.max(0, height - reserved)
```

复用的全是 B1.1 的机制，没有第二套 overlay：`windowInteractionLines` 开窗、`interactionRegion` 几何、`dividerIndex - rows` 定位、命中测试剪枝（`clickableRows` / `paintedLinkHitsByRow` 删除 `>= coveredFrom`）、`chromeStart = min(baseChromeStart, layerTop)` 的局部脏区。**没有** `SurfaceManager` / `OverlayManager` / `FocusStack`。

### Composer boundary

`inputDivider`（`─`×width，与 banner 分隔线同形）换成 composer 自己的上边界：

```
╭────────────────────────────────────────
>
SSH ○○○○ 160ms │ 空闲
目录:dsh-ssh-tui · sub:deepseek-v4-flash
```

`╭` 只占一格，`ASCII_CHROME` 已有映射（→ `+`，见 `term-text.ts` 里那句"边界是眼睛用来找输入行的那条线"）。输入行高、prompt 字形、光标、多行、配色、footer 全部未动。边界行**永远在 layer 之下**：`interactionRegion.top + rows === boundaryRow`，五种状态（plain / interaction / picker / completion / compact）逐一用例固定。

### 冲突策略

一个 transient surface 永远不被另一个替换（`openDialog` 只在空位时直接接管，否则排队）；`surfacePriority()`（`src/dialogs.ts`：dedicated 2 > interaction 1 > picker 0）只决定**排队顺序**，同级保持到达顺序。于是：

- interaction 活跃 + picker 请求 → picker 排队，键盘仍属于提问；
- picker 活跃 + interaction 到达 → 提问排队（**不覆盖**正在做的选择），footer 已按 B0 语义报出"有人被挡住"（`queuedQuestions`）；
- 提问已在排队 + picker 请求 → 提问插到 picker 之前。

### 验收

| 项 | 结果 |
|---|---|
| 锚点 | `/view`（真命令）与 `askQuestion`（所有菜单共用的入口）打开/关闭：`lastTranscriptStart` 与 `scrollOffset` 不变；关闭后 base 帧**逐行相同**（100×20, 6 选项 `window start 55 → 55`，`model rows 46 → 46`） |
| 历史模式 | `scrollOffset = 12` 打开菜单：offset 不变、不被拉回底部、layer 之上逐行相同 |
| resize | 120/80/72 × 20 行 + 72×12 + 72×8：菜单可用（高亮行与键位提示都在 region 内）、整帧恰好 height 行、每行 `visibleWidth <= columns`、无重复行 |
| 增量重绘（100×20） | 打开 12 行 1762B、移动选择 12 行 1762B、滚轮 0 行 23B、关闭 12 行 1707B —— **全部无清屏**；脏区 `[9..20]`，layer 之上的历史一行都没重发 |
| 矮终端 | 72×10 + 14 选项：10 行 1169B，`… N` 标记 + 高亮行 + 键位提示都在，仍无清屏 |
| 输入归属 | 方向键归菜单、draft 不变、history 不被浏览、滚轮不滚动背后 transcript、被覆盖行不可点击/不可拖选/不是 link 目标 |
| footer | 菜单打开时状态行仍是"空闲"（真 PTY 6d 断言）；`/view` 的取消通告是 durable 追加，那一次清屏按 §16 属于既有 tail-follow 例外，probe 里把这条理由打了出来 |
| 真 PTY | 新增 6d 段：`/view` 起真实菜单 → `↑/↓` 只重画 ≤12 行且起始行 ≥3、无清屏、边界 `╭` 已画 → Esc 关闭后菜单从最后一帧消失 |
| 全量测试 | **1205 · 1201 pass · 0 fail · 4 skipped**（新增 `tests/picker-layer.test.mjs` 19 条，含 dock 与 detach 两组；B1.1 的"picker 仍挤压"对照组用例已按其去向删除，改为在 B1.2 里正向固定） |
| 渲染样例 | `scripts/interaction-samples.mjs`（picker 已是 layer，并加长列表）、`scripts/composer-boundary-samples.mjs`（五种状态打印边界/composer/footer 三段） |

变异（真跑）：

| # | 变异 | 结果 |
|---|---|---|
| B1.2-m1 | picker 重新参与 `available` | `picker-layer` **11 条红** |
| B1.2-m2 | 被覆盖的行仍是点击目标（去掉剪枝） | **1 条红** |
| B1.2-m3 | layer 变化强制整帧重画（`chromeStart = 0`） | **1 条红** |
| B1.2-m4 | picker 可以替换正在提问的 surface | **3 条红（其中 2 条是超时）**——提问的 promise 再也不会 settle，比"画错"更严重 |

**一处实现期自查**：M4 第一次跑用默认测试超时，整个文件挂死（被覆盖的提问 promise 永不 resolve）。第二次带 `--test-timeout=8000` 才拿到可读的红色结果；这条变异本身也说明了为什么"活动 surface 永不被替换"必须用排队而不是抢占——抢占会把一个正在等待人类的 promise 直接丢掉。

### 未做（明确留给后续）

- **slash completion / autocomplete 仍挤压**：它是 composer 块自己的行（在边界**之下**），不属于 `SurfaceRole === picker`。改成 layer 意味着补全列表要盖住最新若干行历史；实测 100×20 下 `/m` 打开补全 = 20 行 2954B **带清屏**，window start 移动 4 行。这是既有行为，但已从"没人提"变成"记录了代价"，需要单独决定。
- reports（`/status` `/diag` `/doctor` `/usage`/`/help` 仍是 transcript 行）、setup（onboarding 仍是 dedicated，按 §20 未动）、notification system、transcript cleanup、`SurfaceManager`：均未做。
- `plan dock` 在任一 dialog 打开时本来就不画（`yieldPlanDock`），所以 picker 活跃时 dock 是"没画"而不是"被压住"——本轮沿用，未引入三层叠加。

## B2.1 批 · Screen Contract + Report Screens

一句话：**报告不再属于 transcript，Screen 也不再是 dialog。**

B0–B1 冻结的是"东西画在哪"；这一轮开始冻结"什么东西值得存在"。第一批只动一件事：把 **Screen**（替换整个工作区、有自己的导航、必须能纯函数重画）与 **Surface**（借工作区几行、用完还回去）分成两条通道，并把六个报告命令从 `pushRow` 迁到 Screen。依据 `docs/decisions/b2-architecture-decisions.md` 的 AD-1 / AD-2 / AD-3 / AD-7 / AD-8 / AD-17。

### 新模块

`src/screen.ts`（纯函数，无终端）：

- `ScreenState` —— Screen 的全部状态（title / lines / offset / copyText / notice / subagentSessionId）；**没有任何东西只活在 renderer 里**，这是能 detach/reattach 重画同一画面的前提；
- `screenFromDialog()` —— **唯一判定入口**。合法的 `Dialog` 里已经没有 inspect；这个函数只用于把"旧的 inspect 形状"转成 Screen，`openDialog` 在入口处调用它，于是**未来的调用点无法把 Screen 塞进 dialogQueue**；
- `screenLayout(height)` —— 行预算：`h>=5` 是 title/divider/body/hint/strip，往下依次放弃 divider → title → body，`strip` 是最后一个走的；
- `clampScreenOffset` / `screenPositionText` —— 位置读数（`0/0` 而不是 `1–0/0`）。

`src/footer-budget.ts` 新增 `screenRuntimeStrip()`：Screen 的 compact strip 用的是**状态行自己的 chip 函数**（`linkChipText` / `activityMeter` / `contextChip` / `quotaChip`），只是子集与不同的适配顺序（从后往前整组丢：quota → context → link → queued）。放进这个模块是刻意的——strip 与 footer 必须共用同一套语义与视觉，否则就是第二份真相。

### 通道分离

```
排他：  Screen（至多一个，替换工作区）
Screen 内：screenSurface（Screen 自己的确认，如 /doctor 的修复确认）
工作区：dialog / dialogQueue（interaction + picker，FIFO + 优先级）
不参与：composer（含 completion）· footer · transcript
```

两条方向都堵死了：Screen 不会进队列（`openDialog` 判定），**工作区 Surface 也不会在 Screen 期间抢屏**——它进队列等着，Screen 关闭时 `showNextDialog()` 交给它；期间 strip 会说"有东西在等"。没有 Screen stack、没有 SurfaceManager。

### 渲染

`paintInspectOverlay`（每帧 `sizeChanged: true` + `chromeStart: 0`）→ `paintScreen`：

- **只有**开屏第一帧 / resize / reattach 允许 clear；
- 之后的帧按行比较，`chromeChanged` 只在 strip 文本变化时为真；
- 复用 `composePaintFrame` 的 byte budget 与 `paintResume`。

实测（100×20，200 行会话，真实 wire 字节）：

| 操作 | rows | bytes | clear | 范围 |
|---|---|---|---|---|
| 开屏（首帧，允许 clear） | 20 | 2672 | YES | [1..20] |
| PgDn | 17 | 2099 | **no** | [3..19] |
| 单行 ↓ | 17 | 2369 | **no** | [3..19] |
| 滚轮 | 17 | 2091 | **no** | [3..19] |
| 退出（工作区回来，一次性） | 20 | 2872 | YES | [1..20] |
| 退出后静置 | 0 | 23 | no | — |

**旧行为**：inspect 每一次按键 21 行 + clear（2.7 KB）。现在滚动只地址 body + hint 行（title/divider 不重发）且从不 clear；退出的一次全量重画是刻意的（期间 transcript 可能已经增长），已量化。

### 报告迁移

| 命令 | 之前 | 现在 |
|---|---|---|
| `/status` | `system` 行 | Screen |
| `/usage` | `system` 行（quota/balance/none） | Screen（失败仍写 `error` 行） |
| `/diag` | `diag` 行 | Screen |
| `/doctor` | `diag` 行 + 修复结果行 | Screen；`--fix` 的确认走 `screenSurface`，结果写回 Screen 的 notice + body |
| `/help` | `system` 行（53 行的窗口位移） | Screen |
| `/subagents` | `system` 行 | Screen（"当前没有子代理"也是 Screen 的正文） |

失败路径不变：`error` 行照写（AD-7）。line mode 不变：`openReport` 先判 `this.lineMode`，报告继续以原来的行 kind（diag/system）进日志。

### 验收

| 项 | 结果 |
|---|---|
| 全量测试 | **1226 · 1222 pass · 0 fail · 4 skipped**（新增 `tests/screen-contract.test.mjs` **21 条**） |
| 报告不污染 transcript | `/status` 打开前后 `rows.length` 不变、无 `diag` 行、`scrollOffset` 与 `lastTranscriptStart` 不变 |
| Screen depth = 1 | 连续开两个报告：第二个替换第一个；一次 Esc 回到工作区（不是回到上一个报告） |
| 通道分离 | Screen 不进队列（含把 legacy inspect 交给 `openDialog` 的用例）；Surface 在 Screen 期间进队列、关闭后接管 |
| workspace 恢复 | draft / cursor / scrollOffset / search 在进出 Screen 前后不变；退出是重建一帧而非重建 transcript |
| strip | 20/40/72/80/120 列 × 2/3/4/6/8/12/20 行：整帧恰好 height 行、每行不超宽、strip 永远在、`运行中` 在任何宽度都在 |
| detach/reattach | Screen 的 offset/report/draft 保留；reattach 首帧允许 clear，随后回到局部重绘 |
| 真 PTY | 新增 6e：`/help` 开屏 → `PgDn` **27 行 / 3780B / 无 clear**、起始行 ≥ 3 → 72×24 resize 后仍在 → Esc 关闭且 composer 回来；`/diag`、`/doctor` 步改为 Screen 语义（Esc 关闭、`/copy` 键在屏内复制正文并在屏内确认） |
| 断线/恢复 | `tui-drop-probe` 全过（窗口被 SIGHUP 关闭 → 恢复 transcript → Host 崩溃后自动接管） |
| 终端档位 | `tui-term-probe` 8/8；`footer-windows-probe` 8/8；`capture-footer-frames` PASS（19 帧，连跑 3 次） |
| 未改动 | footer 两行、completion、onboarding 首启动路径、`display-sock` 生命周期 |

变异（真跑）：

| # | 变异 | 结果 |
|---|---|---|
| B2.1-m1 | 报告重新 pushRow 进 transcript | **15 条红** |
| B2.1-m2 | Screen 每键整帧重画（`chromeChanged: true, chromeStart: 0`） | **1 条红** |
| B2.1-m3 | Screen 退出丢 draft/scroll/search | **1 条红** |
| B2.1-m4 | Screen 与工作区共用活跃通道（Surface 在 Screen 期间直接接管） | 首跑 **0 红** → 补用例后 **1 条红** |
| B2.1-m5 | 窄屏整条丢掉 runtime strip | 首跑 **0 红**（原变异并未表达缺陷：兜底行又把 activity 加了回来）→ 改成"直接返回空行"后 **1 条红** |

**两条假绿已记录并修掉**：m4 缺的是"Surface 在 Screen 期间必须排队"这条用例（补 `a Surface that arrives while a Screen is up waits for it`）；m5 缺的是变异本身的诚实性（旧变异被 `screenRuntimeStrip` 的兜底掩盖）。

### 临时例外（记录在案）

- **onboarding 仍是 `DEDICATED_ROLE` + dialog 通道**：它挂在 `dialogRole` 上、仍挤压 transcript。这是 B2.6 的 temporary compatibility exception，本轮按 §11 未动首启动路径；`screenFromDialog()` 只认 inspect，因此不会误吞它。
- **`InspectDialog` 类型保留**：已从 `Dialog` 联合里移出（否则每处 `dialog.kind` 都要为一种不再存在的形状做收窄），标为 deprecated，仅供 `screenFromDialog` 认形状与 0.8.x 的导入方使用；本插件已无任何构造点。
- **line mode / no-TTY**：报告在 line mode 仍走文本行；desktop/no-TTY 的 host-safe 行为未改。

### 未做（明确留给后续）

- **B2.2 Live Tail**：streaming 仍住在 transcript 源行里、仍每帧清屏（本轮按要求没有顺手修）；
- **completion 仍挤压 transcript**（Composer layout debt，AD-16）；
- `/clear` semantics、notification 下沉、approval 字段、plan artifact、setup 迁移：均未动。
- 一处**既有 flake**（本轮发现并修）：`capture-footer-frames.mjs` 的"上下文环已退役"守卫用的是单字形正则，而活动 spinner 的某一帧 `⠋` 同时是环的字形之一，于是它约每十次运行误报一次（本轮第一次运行就撞上）。已改成"两个连续字形才算环"——环是 meter（`⣿⣿⣀⣀`），spinner 永远是单个。与 B2.1 无关，但不修就会在别的轮次里继续假红。
- 一处 UX 观察：Screen 期间键入普通字符会被忽略（这是"Screen 独占键盘"的直接后果）。读者在报告界面里敲 `/doctor` 不会发生任何事、也不会得到提示——**记为待决项**，不在本轮临时发明行为。

## B2.2 批 · Live Tail Ownership

一句话：**live != history。**

B2.1 把报告从 transcript 里请了出去；这一轮请出去的是 **live 内容**——正在流式写出的回复、流式推理、等待卡、紧凑视图里还没有回复的 burst。它们原本被追加进 transcript 的 `display` 源行，于是**每多一行源行，窗口就后移一行**，`transcriptScrolled` 成真、`sizeChanged` 成真——**模型每说一句就整屏清一次**。

### 根因链（before）

```
stream tick → addDisplay(...) 追加进 display（源行）
            → lines.length +1
            → windowTranscript 的 start +1
            → transcriptScrolled = true → sizeChanged = true
            → composePaintFrame: \x1b[H\x1b[J + 整帧重画
```

实测（100×20，200 行历史，真实 wire）：**每个 tick 20 行 / 2.9–3.2 KB / clear YES**，`start` 每 tick +1。

### 现在的模型

```
display / displayRefs / displayGutters   ← 只由 rows 产出（历史）
liveTail: string[]                       ← 由 runtime state 投影（streaming 正文、推理头、等待卡、open burst）
window = windowTranscript({ lines: display, ... })          ← 只算历史 ⇒ start 与 live 无关
paintRows[contentEnd - |T| .. contentEnd) = liveTail 末 |T| 行 ← 覆盖，不重排
```

- `liveTail` 不写进 `display`，因此**不进 source rows、不进 `displayRowCache`、不参与 `available`**；
- z-order：`Transcript < Plan Dock < Live Tail < Transient Surface < Composer < Footer`（tail 在 interaction layer **之前**写入 paintRows，所以 Surface 永远赢）；
- 覆盖的行从 `clickableRows` / `paintedLinkHitsByRow` 剪掉，`selectableLineAt` / `lastSelectableLine` 同时看两个 region（live tail 与 interaction layer）。

### Backscroll

`scrollOffset === 0` 才画 tail。读者回看时：tail 完全不画（activity 仍由 footer/strip 表达），新 tick 不会把读者拉回底部；回到 0 时按当前 runtime state 重新画出来。

### 验收（100×20，200 行历史，真实 wire）

| 操作 | rows | bytes | clear | start |
|---|---|---|---|---|
| streaming tick 1 | 5 | 910 | **no** | 211（const） |
| tick 2..6 | 6–9 | 1065–1566 | **no** | 211（const） |
| settle（durable append） | 20 | 3064 | YES | 211 → 216 |
| settle 后一帧 | 0 | 23 | no | const |
| waiting tick ×4（逐秒） | 5 | 880 | **no** | 211（const） |
| 回看 12 行时的新 tick | 4 | 755 | no | const，offset 仍 12 |
| reasoning+正文+等待卡同时 | 6 | 1007 | no | const |

- **settle 的一次全量重画是刻意的**：durable 行落进历史，窗口按既有 tail-follow 规则前移 5 行（正文 wrap 的行数）。按 brief 要求量化而不扩散到通用 tail-follow 重构。
- 真 PTY：`live stream: 30 row writes, 1 full clears, 4190B`（那一次 clean 是 settle）。

### 已知代价（写进文档，不藏）

tail 覆盖的是窗口**最新的若干行**（因为 `start` 必须不动）。后果：agent 运行期间，最新的 1–N 行历史在 tail 后面；**向上滚动看不到它们**（窗口后移，它们仍在窗口末端之外），它们要等 tail 消失（settle / 卡片结束）才回来。这是"anchor 不动 + 只发 tail 字节"这两个冻结要求的必然结果，已用 `the tail covers the newest settled rows, and hides itself when the reader scrolls` 一例把它固定成**行为契约**而不是意外。若要改成"历史在 tail 之上、最新行可见"，必须允许窗口随 tail 高度前移，那会让每个 tick 重发整个正文（回到 B2.2 之前的成本）——属于 tail-follow 模型变更，留给后续单独评估。

### 测试

**1246 · 1242 pass · 0 fail · 4 skipped**（新增 `tests/live-tail.test.mjs` **20 条**：首 tick、连续增长、覆盖而非重排、wrap 增行、推理/正文双投影、等待卡逐秒、运行时状态不产行、settle 原子性 ×2、覆盖契约、backscroll ×2、命中测试、Surface 优先、Screen 关系、detach/reattach、resize 矩阵、双视图、line mode、row-cache 回归）。

`live-tail-cache` 的三条既有保证继续成立（live 块不写入任何行的缓存）；新增的 `live lines are never written into a row cache entry` 用 WeakMap 逐行读回缓存内容来证明。

### 变异（真跑）

| # | 变异 | 结果 |
|---|---|---|
| B2.2-m1 | live 行重新进入 transcript 源行 | **16 条红** |
| B2.2-m2 | live tick 强制整帧清屏 | **4 条红** |
| B2.2-m3 | live tail 在 settle 后仍保留 | **13 条红** |
| B2.2-m4 | 回看时仍画 tail | **3 条红** |
| B2.2-m5 | 被覆盖的 live 行仍是点击目标 | 首跑 **0 红** → 修用例后 **2 条红** |
| B2.2-m6 | live 行写进行缓存 | **6 条红** |

**一处假绿已修**：m5 的用例原本是**空的**——它推的 tool 行没有 `expanded` 字段，从来就不是点击目标（`clickableRows` 只登记可展开的行），于是"所有点击行都在 tail 之上"恒真。改成先断言基帧确有目标、再断言那个目标恰好落在 tail 覆盖区，变异才红。

### 两处 B2.1 遗留在本轮暴露（探针 + 一个真实缺陷）

1. **探针会把命令打进 Screen 里**：`tui-drop-probe` 的崩溃恢复循环敲 `/status`（现在是 Screen，AD-7），`tui-term-probe` 的剪贴板步骤敲 `/diag`；两者在 Screen 打开后继续敲 `/exit`，于是被 Screen 吞掉、窗口不退出。两个探针都已改成"报告之后先 Esc"（Screen 自己的提示键）。
2. **Screen 内的复制提示看不见**：`copyPlainText` 把"本终端不接收 OSC 52 写入"写成一个**行**，而这一行位于 Screen 之后——读者按复制键时看不到它，终端档位矩阵的 7 个档因此失败。修法是在 Screen 通道内把它放到 Screen 自己的提示行，并且**让警告排在前面**（确认信息在前时，警告正好被右边缘裁掉一个字符）。这条属于 B2.1 的 Screen 通道缺陷，本轮顺手修掉并重新验证 8/8 档位。

两条都是"Screen 独占键盘 + 不写 transcript"的直接后果，进一步说明 B2.3b 要处理的"Screen 期间键入命令静默无反应"值得优先解决。

### 一处工具链自查

变异脚本恢复源码后**没有重建 `lib/`**，导致紧随其后的一次未变异测试跑在变异的构建上、报出错的红。已在脚本的 `finally` 里补上重建，并把这条写进注释——`lib/` 才是测试实际加载的东西。

### 未做

B2.3 Representation metadata、`/clear`、notification、approval、Plan Artifact、completion、setup：均未动。line mode 保持文本语义（不引入 overlay）。

## B2.3a 批 · Representation Metadata + Correctness Preflight

一句话：**每个 transcript 表示都必须自己说清它是什么，而且绕不过去。**

B2.2 之后，"live 不再进 source rows" 已经成立，但**source rows 里仍有大量无法从日志重建的行**（display-only 的 system 行、动作反馈、changes 卡、报告回声……）。这一轮把"这条信息是什么"从 renderer 的猜测变成一个**有类型的策略表**，并顺手修掉 `sawUserInput` 的真相来源。

### checkpoint（本轮开工前）

`git stash create` 产生的**不改工作树**的提交对象：`f23e2bf80005db058d9181d9fa797ff2700a013b`（B2.2 状态）。

查看 B2.2 → B2.3a 的 diff：

```bash
git diff f23e2bf8 -- src/            # 生产代码
git diff f23e2bf8 --stat             # 总览
```

**注意（本轮实测发现）**：`git stash create` 只收录**已跟踪**文件的改动；B0–B2.2 期间新增的未跟踪文件（`src/screen.ts`、`src/question-state.ts`、`src/footer-*.ts`、`src/throughput.ts` 等）**不在该对象里**。要把它当作可构建的基线，需要把这些文件补进去（本轮做行为等价对照时就是这么补的，见下）。

### 策略表：`src/representation.ts`（新）

```ts
durable = 能从权威 session log 重建（resume 后回来）
display = 只属于当前 Host/display 生命周期（resume 后消失是对的）
live    = runtime 投影（每 tick 可变；**不得**成为 source row）
```

34 个 source id（15 durable / 19 display / 0 live），每个带 A/B/C/D 类别：

- **A** 常驻条目、**C** 摘要（question 卡）、**D** artifact 引用（后续）；
- **B 从不产生 source row**（live tail 与 Surface），这条在测试里被断言（表里没有 class B）。

**为什么不能按 `Row.kind` 分类**：同样是 `system` 行，`plan/mode` 的"进入计划模式"来自日志（durable），`/theme` 的"配色已切换"是本机动作（display），`重连`通告来自 display 生命周期（display），`changes` 卡看起来最像历史却**不可重建**（display）。kind 描述的是外观，durability 描述的是来源，二者正交——一刀切会让 resume 的预测失效。

### 不可绕过的边界

1. **`pushRow` 只接受 `Representation`**（= row + 策略），不接受 `Row`。裸 row 是**编译错误**（M1b 实测：`error TS2353`）。
2. **`RepresentationSource` 是策略表的键**（`keyof typeof REPRESENTATION_POLICY`）。编造一个 source id 同样是编译错误；新增创建点**必须**同时新增策略条目。
3. **没有默认值**：没有任何 `durability ??= 'durable'` 之类的兜底。JS 调用方（测试夹具、embedder）绕过类型时，该 row 会被**原样推入但带不上 metadata**，`auditRepresentations()` 把它记成 `unclassified`，测试断言其恒为 0（M1 实测：3 条红）。
4. **策略在 `pushRow` 里落到 row 上**（`row.representation`），所以审计读的是**真实 transcript**，而不是"表里写了什么"。

### 完整审计计数（254 个创建点）

| durability | 创建点 | 说明 |
|---|---|---|
| **durable** | **32** | user 1 / assistant 1 / reasoning 1 / tool 2 / turn-error 1 / session-notice 5 / compaction 2 / goal 4 / prompt 1 / plan-row 3 / subagent 2 / command-event 4 / retry-notice 3 / session-route 1 / question-card 1 |
| **display** | **222** | command-notice 87 / command-error 48 / onboarding 23 / preset 10 / boot 10 / surface-echo 8 / update 6 / copy 5 / find 5 / auth 4 / doctor 4 / runtime 4 / attach 2 / plan-notice 2 / error-surface 1 / report-echo 1 / approval-notice 1 / changes-card 1 |
| **live** | **0** | B2.2 已把 live 投影移出 source rows；本轮不变 |
| **unknown** | **0** | 边界保证 |

> 那 222 个 display 里，`command-notice` + `command-error` 就占了 135 个——正是 B2.3b 要下沉到 footer/notice 的那批。现在它们是**已经贴好标签的**，B2.3b 不再需要逐句判断。

### `changes` 卡（canonical case）

`changes-card: display`。它**看起来**像历史（描述某一轮的改动），但摘要不在 session log 里、Host 重启后无法重开——所以不能让它在 resume 后假装还在。显示行为一字未改，只贴标签 + 用例锁住（M2 实测：改标 durable → 1 条红）。

### `sawUserInput` correctness fix

- **问题**：reducer 里有一个**不可达**的重复 `case 'user/message'`（第二个 case label 永远不执行），其职责是 `this.sawUserInput = true`。于是这个事实只由 composer 的提交路径设置，**resume 后的会话会声称"没有人输入过"**——`/cleanup` 正是按这个语义删会话的。
- **修法**：把标记放进**真正可达**的 `user/message` 分支（replay 也会走到），删掉重复 case；composer 路径保留（它在事件回环之前就标记）。
- **测试**：fresh=false / composer submit=true / **replay 含 user turn=true** / replay 不含 user turn=false / reducer 只有一个可达 case（静态扫源码）。M5a（恢复重复 case）红 1 条，M5b（删掉可达路径的标记）红 2 条。

### 行为等价（zero-behavior-change 证据）

`scripts/representation-equivalence.mjs` 用 13 个固定场景（boot / user / assistant / tool 往返 / turn 失败 / plan+todos / changes 卡 / 主题切换 / /status / streaming tail / wait card / 问题弹窗 / compact 视图）驱动一个构建，打印每帧的**文本摘要（sha256）**与 row kind 列表。时钟被冻结（否则 spinner 与 elapsed 每次运行都不同——实测噪声就是这 4 个场景）。

```
B2.2 基线（f23e2bf8 + 未跟踪模块补齐后构建）  vs  当前：
IDENTICAL: every scenario's rendered frame and row kinds match the B2.2 build
（同时验证：同一构建连跑两次逐行相同 ⇒ 对照本身稳定）
```

### 测试

**1262 · 1258 pass · 0 fail · 4 skipped**（新增 `tests/representation.test.mjs` **16 条**：边界、审计语义、durable/display 分类、changes canonical、resume 重建 durable 而不重建 display、sawUserInput 三条、静态 guard、live 不变量）。既有 32 处测试夹具改经 `pushRow(tui, row)` 助手（显式 `fixture` source），B2.1/B2.2 全量回归保持绿。

### 变异（真跑）

| # | 变异 | 结果 |
|---|---|---|
| M1 | 某个创建点绕过类型、丢掉策略 | **3 条红**（audit unclassified、静态 guard、replay 用例） |
| M1b | 直接去掉 `represent(...)` 包装 | **编译失败**（`TS2353`）——编译期守卫 |
| M2 | `changes` 改标 durable | **1 条红** |
| M3 | 控制平面回声改标 durable | **1 条红** |
| M4 | live 投影重新变成 source row | **12 条红**（B2.2 不变量） |
| M5a | 恢复重复不可达 `case 'user/message'` | **1 条红** |
| M5b | 删掉可达路径里的 `sawUserInput` | **2 条红** |

### 审计产物（开发侧，不是用户命令）

- `node scripts/representation-audit.mjs`：打印一份真实 transcript 的分类表 + `unclassified` / `live source rows` 两个必须为 0 的数字；
- `SshTui.representationAudit()` / `formatRepresentationAudit()`：同一份数据，供测试与将来的 `/diag` 用。

### 未做

B2.3b（echo 下沉）、`/clear`、notification UX、approval cleanup、Plan Artifact、completion、setup 均未动。特别地：**Screen 期间键入命令静默无反应**这条已知 UX debt 本轮**没有修**（按 brief 要求留给 B2.3b）。

## B2.3b 批 · 反馈路由 + /clear 语义

一句话：**分类定了"是什么"，这一轮定"去哪"。**

B2.3a 把每个 transcript 表示都贴上了 durability（durable/display/live）。这一轮给同一条政策表加上 **destination**（transcript / echo / notice），让"这条反馈显示在哪里"也由中央策略决定，而不是由 253 个调用点各自 `pushRow`。顺带把 `/clear` 改成真正的 presentation-only cutoff，并修掉 Screen 内静默吞键。

### 路由模型

```
Event / Command → Representation source → Policy(source) → { durability, class, destination } → sink
```

`pushRow(represent(...))` 是唯一入口，destination 在**那里**被消费：

| destination | 落点 | 生命周期 |
|---|---|---|
| `transcript` | 行（`appendRow`） | 与既有语义一致（durable 重放可重建；display 随 Host 消失） |
| `echo` | footer 状态行的**最低优先级 chip** | 新 echo 覆盖旧 echo；**下一次用户提交**清除；detach/reattach 保留（Host 活着）；resume 不恢复；不写日志；不改变 transcript 几何 |
| `notice` | footer **身份行**（`目录:` 那一行）临时替换 | 同上生命周期；比 chip 长，可读一句完整的话 |

放身份行而不是覆盖 transcript 行，是因为覆盖会藏住最新内容（实测：覆盖版会把刚结算的回复挡住）；身份行永远在屏、不占几何、也不盖任何内容。

**行号空间不变**：echo/notice 都只复用已有的两行 footer，所以任何反馈都不改变 `available`、`start`、`scrollOffset`。

### source → destination（46 个 source / 253 个创建点）

| destination | 创建点 | 主要 source |
|---|---|---|
| **echo** | **66** | command-feedback 40 · find-feedback 7 · update-feedback 5 · preset-feedback 5 · copy-feedback 4 · quota-report 3 · plan-notice 2 |
| **notice** | **22** | command-misuse 16 · command-usage 3 · update-error 1 · error-surface 1 · copy-caveat 1 |
| **transcript** | **165** | display 133（onboarding 24 · command-error 40 · preset-error 12 · boot 11 …）+ durable 32 |

### command-error 三类（brief §6）

| 类 | source | destination | 数量 | 例子 |
|---|---|---|---|---|
| A 本地控制面**用法**错误 | `command-misuse` | notice | 16 | 未知命令、缺参数、表外的值 |
| B 会改变因果理解的失败 | `command-error` / `preset-error` / `repair-result` | transcript | 40 + 12 + 2 | 命令执行失败（带错误链）、计划被拒（说明原因）、`/mode fix` 的写入结果 |
| C 已由 durable source 表达 | —（不重复） | — | — | `turn/error`、`tool/result` 已各有 durable 表示 |

同一条线还切出了：`command-status`（`/retryauth`、`/notify` 的状态是**报告**不是确认 → transcript）、`copy-caveat`（OSC 52 警告是 operational warning → notice）、`away-summary`（离开期间发生了什么 → transcript，AD-13 的因果例外）、`attach-notice`（重连通告 → transcript）。

### `/clear` = presentation-only cutoff（AD-4）

- 实现：`clearedRows`（一个**从前端数的计数**），视图 = `rows.slice(clearedRows)`；**不做 `rows.length = 0`**；
- 稳定性：新行永远追加在末尾、更新就地改对象，所以计数边界不会被 upsert 穿过（有用例：把一个隐藏行改内容，它不会重新出现）；`boundTranscriptRows` 裁掉前端时计数同步递减；
- 不删任何 source truth：session log / agent context / artifacts / rows 全部不动；
- **resume 后旧历史重新出现是预期行为**（host-local 计数，不落盘）；
- 反馈：身份行的 notice 说明"只清理显示：会话历史与模型上下文保持不变"，**不写行**（否则要么被 cutoff 立刻吃掉，要么让 `/clear` 看起来失败）；
- scroll/focus/search 的处置：`scrollOffset = 0`、`focusedRow = null`、search 命中清空；draft/cursor/Surface 队列/Screen 状态/agent 运行态**不受影响**（`/clear` 由命令路径输入，composer 的行内容当然由那次提交清掉——那是 composer 自己的契约）。

### local `/find` 与 cutoff（AD-9）

`/find` 搜 `visibleRows()`：cutoff 之前的内容不命中（有用例），新内容可搜。命中为空且视图被切过时，身份行给出边界提示（"只搜索当前可见的内容…"）。跨 cutoff / 跨 resume 的搜索属于 Search Screen，未实现。

### Screen 内静默吞键（§11）

Screen 收到 printable 字符 → 设 Screen 自己的 notice hint（"这是报告视图，没有输入行：Esc 返回工作区后即可输入命令"）：不进 transcript、不进 workspace draft、不进 dialogQueue；重复键入只是同一条 hint（不累积）；Esc/q 仍正常退出。**没有**为它实现 Screen composer。

### line mode（§12）

line mode 没有 footer/notice：路由到 echo/notice 的反馈在 line mode 下仍 `appendRow` 写日志（保持文本反馈），no-TTY/desktop 路径不变。

### 顺手修掉的两个卡片缺陷（用户本轮报告）

1. **展开的卡片不再丢高亮**：工具卡展开分支的 header 没有走 `selectLine`（compact burst 分支有），于是被选中的卡片一展开就不再"看起来被选中"。已补上。
2. **高亮"跑到别的卡片上"的真正原因**：行缓存的基础 key 只记了**焦点行的 kind**（`displayBaseKey`），同类两张卡片之间移动焦点时 key 不变 → 回放旧卡片的缓存行（带着旧高亮）。改成记焦点行的**位置/身份**，焦点移动必然换 key。这是一个既存 bug（不是本轮引入），也是"高亮外溢"的机制。
3. **思考中卡片在流式输出时不能展开**：`applyStreamChunk` 在每个新的推理阶段重建 block（`expanded: false`），读者刚展开就被折回；另外 compact 视图里它根本不在 `collapsibleRows()` 里（compact 的契约就是隐藏思考，未改）。已改成：同一 turn 内复用 block（保留读者的选择），`turn/start`（新 turn）才重置。三处都有用例。

### 验收

| 项 | 结果 |
|---|---|
| 全量测试 | **1278 · 1274 pass · 0 fail · 4 skipped**（新增 `tests/feedback-routing.test.mjs` 16 条） |
| 审计 | `unclassified 0 · live source rows 0 · unknown destination 0`（`scripts/representation-audit.mjs` 现在也打印 destination） |
| 弱网度量 | 每次控制平面反馈 **+0 source row、start 不变**；`/effort`、`/copy`、`/nope`、`/find`、Screen hint 都是 4–5 行 / 0.76–0.9 KB / 无清屏；`/theme`、`/view`、`/clear` 仍是整屏重画（它们确实改变了整幅画面），但模型行数不变 |
| 真 PTY | `tui-probe` OK（含新增的 Screen/交互/流式断言）；`tui-drop-probe` OK |
| 卡片修复 | 高亮用例 3 态（A 选中 / B 选中 / 展开后仍选中）+ 思考卡跨阶段保留展开 |

### 变异（真跑）

| # | 变异 | 结果 |
|---|---|---|
| M1 | control-plane 反馈重新写 transcript | **3 条红** |
| M2 | echo 永不在下次提交清除 | **2 条红** |
| M3 | `/clear` 恢复 `rows.length = 0` | **3 条红** |
| M4 | local `/find` 搜 cutoff 之前 | **1 条红** |
| M5 | Screen 静默吞 printable | **1 条红** |
| M6 | 某个 display source 没有 destination | **编译失败**（`TS2741`，策略表的 `satisfies` 守卫） |
| M6b | 用 `as unknown as` 骗过编译器 | **1 条红**（运行时穷尽守卫） |

### 迁移过程中的两类判断（记录）

- **不能一锅端**：`display` 只表示"Host 本地、resume 不保证回来"，不等于"一律移出 transcript"。inspection 一轮后把 **状态报告**（`/approval status`、`/retryauth`）、**因果失败**（命令失败、计划被拒、`/mode fix` 结果）、**离开摘要**、**子代理起止**、**上下文告警** 都留在了 transcript —— 它们是信息，不是确认。
- **测试的观察通道**：63 个既有用例此前通过"读 transcript 行"来观察反馈。新增 `feedbackText` / `lastFeedback` / `waitForFeedback`（读三个 sink），把这些用例改成**与通道无关**地断言"这条消息出现了"，而不是断言它出现在哪一行。

### 未做

Search Screen（跨 cutoff/resume 的历史搜索）、Screen composer 相关 UX、approval cleanup（B2.4）、Plan Artifact（B2.5）、completion layout、setup（B2.6）、Context Lifecycle / pruning。`approval-notice` 与 `onboarding` 的 destination 明确保持 `transcript`，等各自轮次决定。


---

## B2.3c 批 · 复制语义 + 工作区区域所有权

一句话：**实时区是"区域"，不是"覆盖层"。**

用户报告三件事：① `/copy` 复制不到回复了；② 思考卡流式期间不能展开；③ 高亮工具卡片时会渲染出侵入其他卡片的内容（鼠标点出来的）；④ 进入 TUI 工作区的视图不在最底部。前三条与 B2.2 的 live tail **覆盖**实现直接相关——覆盖层把卡片内容切断、把点击目标挖掉、把最新历史挡住。这一轮把它改成有资格的行区域，并让 `/copy` 明确指定目标。

### `/copy`：目标显式化

| 写法 | 目标 | 空的情况 |
|---|---|---|
| `/copy`（默认） | **模型最后一条回复** | "这个视图里还没有回复"（不回退到卡片） |
| `/copy reply` | 同上 | 同上 |
| `/copy highlight` | **高亮卡片**（旧规则） | "当前没有高亮的卡片"（**不再**回退到回复） |
| `/copy error` | 最近 error/diag 行 | 不变 |

旧规则是"有焦点取焦点，否则取最近回复"——点过任何一张卡（点一下就是展开）之后，`/copy` 就静默改取卡片，回复变得拿不到，而且没有任何提示。现在两个目标互斥：命令说哪个就是哪个。**复制键**（Ctrl+Shift+C / 屏内复制）保持一贯语义：有焦点取焦点，无焦点取最近回复（键不能"没有可复制的内容"）。

`copyTextFromTranscript(rows, focused, target)` 增加第三个参数；`copyFocusedCard()` 拆成 `copyErrorRow()` / `copyHighlighted(fallback)` / `copyLatestReply()`，键路径统一走 `copyKey()`。

### live tail → live region（工作区区域所有权）

```
工作区行数 = height - header - footer(3) - inputRows - suggestions - boundary
优先级（高 → 低）：  交互 Surface  >  active Plan Dock  >  Live Region  >  transcript 历史
```

- **Live Region 有自己的行**，插在 transcript 与 plan dock 之间，不再覆盖窗口底部：原来被覆盖的那几行会从窗口里消失（卡片被拦腰截断、被覆盖的行不再是点击目标 → 鼠标点不住），现在窗口让出同样多的行，最新结算的内容永远在区域**上方**。
- **高度压力**：dock 先压（上限 = 工作区一半，且保留自己的标题行 + "还有 N 行计划"），region 从**最前面**裁（保留第一行 = 实时思考卡的标题，它是"这里在干什么"和点击折叠的落点），transcript 保留 `MIN_TRANSCRIPT_ROWS = 3` 的下限（`contentBudget` 为 0 时 region 仍保留 1 行，否则没有任何东西说明会话在工作）。
- **Surface 最高**：它最后绘制，永远不会被 dock / region 覆盖；同时 dock 与 region 都从它下面让位。
- **不再因为流式而整屏重画**：region 的行按字符串差异判定（原来把 region 塞进 `chromeStart` 的强制重画里，每个 tick 重写整个 region ≈1.3KB）；窗口因 region 长高而后移时，`transcriptScrolled` 只把"上一帧快照"置空以重画全部行，**不**再借道 `sizeChanged` 触发 `ESC[2J`（尺寸变化才需要清屏，窗口平移不需要）。
- 实测（100×20，200 行历史）：稳定 tick **638B / 0 清屏**，跨行 tick **2.3KB**（整窗重画）/ 0 清屏；静止帧 0 行。

### 思考卡：整个 turn 保持展开 + 可点击

- 展开选择记在 **turn 级**（`reasoningExpandedChoice`），不再只挂在那一块 block 上：一个 turn 里"思考 → 工具 → 再思考"，每阶段重建 block 时都从该选择出发；`turn/start` 才清空。
- 实时思考卡进入 region 后**可点击**（`tailRefs` 在覆盖清扫之后登记），header 行是落点：点一下展开、再点折叠——用户是"用鼠标点的"，之前 region 只能靠键盘进去。
- region 被裁剪时保留 header 行（见上）。

### 计划卡不再吃掉输入行 / IME 预编辑

`/view` 计划 dock 之前行数无上限，短终端下把输入框、footer **连字符**一起挤出画面；光标被 clamp 到最后一行 → 终端把 IME 预编辑画在计划卡的第一行上（用户报的"输入法待输入内容显示在计划卡第一行"）。现在 dock 有预算（工作区一半）、超出部分裁剪并显示"还有 N 行计划"。

### 进入工作区 = 最新内容在屏

区域改成保留行之后，"进入工作区"（`attachRelayDisplay` / 首帧）时最新结算的行一定在区域**上方**；用例 `entering the workspace mid-turn opens on the newest content, not on covered history` 直接驱动这条路径。

### 测试

**1286 · 1282 pass · 0 fail · 4 skipped**。新增/改写：

| 文件 | 内容 |
|---|---|
| `tests/copy-text.test.mjs` | 目标互斥四态（默认/reply/highlight/error）、highlight 无焦点时不回退、**复制键**仍有回退 |
| `tests/copy-error.test.mjs` | 高亮卡片时 `/copy` 仍取回复；`/copy highlight` 取卡片 |
| `tests/live-tail.test.mjs` | 区域保留行（不再是覆盖）、裁剪保留 header、点击实时思考卡、跨阶段/跨 step 保留展开、`turn/start` 清空 |
| `tests/workspace-regions.test.mjs`（新，5 条） | Surface > Dock > Region 三层优先级、6 种高度下 region 不覆盖 dock、高度压力下 dock 压缩 + region 裁最旧 + transcript 有下限、每个高度输入行/光标在屏、中途进入工作区落在最新内容 |

### 变异（真跑，全部被抓）

| # | 变异 | 结果 |
|---|---|---|
| M1 | `/copy` 默认回退到焦点卡片 | 红（copy-error） |
| M2 | `highlight` 无焦点时回退到回复 | 红（copy-text / copy-error） |
| M3 | plan dock 不设上限 | 红 ×3（workspace-regions） |
| M4 | region 裁剪时连 header 一起丢 | 红（live-tail ×2） |
| M5 | 实时思考卡忽略 turn 级展开选择 | 红（feedback-routing） |
| M6 | region 不登记点击目标 | 红（live-tail） |
| M7 | region 无下限地吃满工作区 | 红（workspace-regions / live-tail） |

### 真 PTY

`tui-probe` **OK**（`live stream: 30 row writes, 0 full clears, 4256B`；`resize sweep 60→1595B 120→4184B`；Screen 滚动 27 行无清屏）；`tui-drop-probe` **OK**。`tui-mock-probe`（含 `--busy`）在本机**跑不通**：脚本模型请求走到 `DeepSeek Messages ... (404)`，用 HEAD 的干净 worktree 复跑得到同样结果 → **既有环境/harness 版本问题，与本轮改动无关**（未修，留给 probe 自己一轮）。

### 未做 / 未复现

- **"进入工作区不在最底部"**：直接 PTY（30/50 行，含 40 轮历史会话）实测首帧精确填满终端、最新内容在底、光标在输入行。已按"最新内容被 live region 盖住"这一机制修掉并加用例；若用户指的是别的情形（例如桌面窗口尺寸未上报），需要在下一轮拿到具体窗口/尺寸信息再定位。
- Search Screen、Screen composer、approval cleanup（B2.4）、Plan Artifact（B2.5）、completion layout、setup（B2.6）、Context Lifecycle / pruning。

---

## B2.4 批 · ask / approval 表示归属

一句话：**一个问题一个主要表示，一次审批是那张卡片的状态。**

### 事实来源审计（改代码之前）

完整表格在 `docs/plans/b2-4-ask-approval-audit.md`。要点：

| 事实 | 来源 | 持久 | 可重放 |
|---|---|---|---|
| question/callId/question/options | `tool/call` 的 parameters（`askQuestions()` 与 Harness 自己的 `questionsOf()` 各读一遍） | durable | 是 |
| active/continued/settled | `ctx.sessionProjections.stateOf(session,'userQuestions')` | 由 durable 事件折叠 | 是 |
| answer | `tool/result` 的 JSON 或迟到的 `user-question-reply` | durable | 是 |
| **approval required** | `approval/asked {id, toolName, callId?, reason?}`（Harness 写） | **durable** | 是 |
| **approval decision** | `approval/decided {id, outcome}`，`outcome ∈ allowed-once/rejected/cancelled/unavailable` | **durable** | 是 |
| 自动审批（规则/缓存/AI 复核） | 插件自己的判定，但**写日志的是同一对 Harness 事件**；插件的 `approval-notice` 只是展示 | 判定是 / notice 不是 | 判定可 |

`intent`（plan-review）在两边的投影里都被丢掉（B2.5 的账）；**plan-review 根本不是 `ask_user_question`**：`dsh-plan-mode` 在 `exit_plan_mode` 工具内部调 `interaction.ask(...)`。

### ask：一个语义问题 = 一个主要表示

- `ask_user_question` 进 `QUESTION_TOOL_NAMES`：**不再生成通用 tool 卡片**，问题卡由**调用参数**直接建（live/重放/无投影都成立），投影只负责更新状态。
- 已完成卡片现在同时带问题和答案：`● 提问用户 · 已回答 · 要部署到哪个环境？ → 预发 · Enter 展开`（以前答案一出现，问题就从折叠行上消失了）。
- 回答/多选/自定义文本都走同一摘要函数；答案存在 `summary` 里，只有渲染会截断。
- 继续提问：Enter 重开交互（空输入 Enter 是"行动"不是折叠），再答后同一张卡更新，不追加新卡；没有 `ctx.userQuestions.answer` 时明说不能回答。
- **plan-review 完全没动**：`exit_plan_mode` 的卡片与审阅卡都还在（回归 guard）。

### approval：卡片上的字段 + 证据强度

```
approval: { state: waiting|approved|rejected|unknown, provenance: live|policy|durable|inferred, auto?, reason? }
```

- **live**：`handleApproval` 在提问前写 `waiting`，判定后写 `live`（人工）或 `policy`（规则/缓存/复核）。
- **durable**：读 Harness 的 `approval/asked` + `approval/decided`。`allowed-once → approved`，`rejected → rejected`，`cancelled/unavailable → unknown`（读者按的 Esc 不是"拒绝这个工具"）。
- **inferred**：老日志没有审计对时，只认 Harness 自己的拒绝句式（`the user rejected tool "X"` / `approval for tool "X" was cancelled`），且**永远不会推出 approved**（跑成功不等于有人批准过）；普通权限拒绝不挂徽标。
- **不新增第二套真相**：插件不写任何 approval 事件，只读。
- 自动审批：允许 → footer chip，拒绝 → notice 行；都不再是 transcript 行，状态在卡片上（`auto` 标记）。
- Host 死亡/重放：`waiting` 只在**活着的 Host**里出现；日志里只有 `asked` 没有 `decided` → `unknown`，绝不伪造成 approved。

### 顺带修掉的四个缺陷（用户本轮报告）

| 现象 | 机制 | 修法 |
|---|---|---|
| resume 进来工作区"从某个位置滚到底部" | 重放是分片让出的，渲染定时器在**读日志途中**逐帧绘制（20k 事件实测 1.2s/51 帧，窗口从 `回答 3775` 爬到 `19976`） | `loadingHistory` 期间不合成任何帧，读完后**一帧落地**（同时把 1.2s 降到 268ms） |
| 输入法预编辑字符在处理中卡片行闪烁（Windows Terminal） | 每个 tick 的 chrome 强制重画**包含输入行**，而终端把 IME 合成串画在光标处 → 被擦掉重画 | 强制重画范围起点移到输入块**之下**；输入行只在自己文本变化时才写 |
| 状态栏出现字面量 `[90m`（Esc 返回后，查额度时抓到） | `screenHintLine` 把**带样式**的分隔符拼进纯文本行，随后 `styleLine` 的消毒器只删 ESC 字节、留下 `[90m` | 该行用纯分隔符；带样式的分隔符只属于直写终端的 `runtimeStrip` |
| 中途输入的"（将在下个步骤生效）"卡片不见了 | B2.3b 把它路由成 footer chip，而 chip 在繁忙状态行里**第一个被丢** | 改走 notice 行（永远在屏、零几何）；记录仍是 Harness 在下一步写的 `user/message` |

### 验收

| 项 | 结果 |
|---|---|
| 全量测试 | **1312 · 1308 pass · 0 fail · 4 skipped**（新增 `tests/ask-approval-representation.test.mjs` 26 条） |
| 类型 | `tsc --noEmit` 干净 |
| 审计 | `unclassified 0 · live source rows 0 · duplicate calls 0 · generic question tool rows 0`（`policy sources: 48`） |
| 变异 | 12/12 全红（M1 通用卡回归、M2 追加答案行、M3 重放丢答案、M4 approval 独立行、M5 无证据默认 approved、M6 plan-review 被吞、M7 挂错卡片、M8 推断出 approved、M9 读日志期间作画、M10 输入行强制重画、M11 带样式分隔符进消毒器、M12 中途输入回落到 chip） |
| 真 PTY | `tui-probe` OK（含读取层/输入层/Screen/流式断言）· `tui-drop-probe` OK · `tui-probe --line-mode` OK · `tui-term-probe` 见下 |
| 快照 | `fc7cf575ed1d87f06ab86113416667be4461ed76`（tag `b2.3c-snapshot`，含 tracked+untracked，worktree/index 未动） |

---

## B2.5 批 · Plan Artifact Projection

一句话：**计划是产物（artifact），不是一行 UI 状态。**

审计（`docs/plans/b2-5-plan-artifact-audit.md`）先于一切改动：把 plan 的全部权威事件来源重新核了一遍，发现两处与既有假设不符的事实。

### 审计发现的缺口

**A. `intent.kind='plan-review'` 根本不在 durable 日志里。**
`dsh-plan-mode` 是在 **`exit_plan_mode` 工具内部**调 `ctx.get('userQuestions').ask(...)`，而 `UserQuestionService.ask()` **不写任何事件**（只有 `ask_user_question` 工具才有 `tool/call`+`tool/result` 对）。所以"从 durable args 里修回 intent"这条路不存在——**但也不需要**：review 的身份就是那次 `exit_plan_mode` 调用（`callId` + `arguments.plan` 都在日志里）。B2.4 从问题侧识别不了的事，这里从工具调用侧识别得了。

**B. 没有 plan id，也没有 todo 与 review 的关联。**
旧实现靠显示顺序（`planIsLive` + `archiveStalePlans`），是渲染器持有的真相（AD-15 禁止）。可从事件确定性推导：

```
artifact  id       = plan@<打开它的那个事件的 seq>
          revision = plan@<openSeq>#<todo/write 的 seq>
打开：plan/mode{active:true}，或某个 turn 的第一次 todo/write（Harness 自己的 todos 投影在 turn/start 清空，所以"这个 turn 的第一次写"就是新列表）
关闭：plan/mode{active:false}，或下一次从全完成列表开始的写
review：exit_plan_mode 的 callId 与 result（成功=批准；Harness 自己的拒绝句式=退回/搁置）
```

**C. `completed` / `abandoned` 是推断。** 没有事件这么说；只能从最后一份快照（全部完成）与模式切换读出来，因此带 `inferred` 标记，绝不冒充事实。

### 实现

- **`src/plan-projection.ts`（纯函数）**：`foldPlanArtifacts(events, {live})` → `PlanArtifact[]`；状态 `draft|reviewing|approved|rejected|executing|completed|abandoned|unknown` + `provenance`；`live` 逐事件记录，所以同一份日志里"活着的审阅"是 `reviewing`、"重放的未决审问"是 `unknown`（沿用 B2.4 对审批的规则）。
- **单一投影真相**：TUI 只保留事件日志并重折叠；每个 artifact 一行（reference），dock 画活着的那份，review 是 Surface，生命周期每settle 一条行。`upsertPlanRow`、按显示顺序归档、`exit_plan_mode` 的通用工具卡都从 plan 路径移除。
- **transcript 只留 lifecycle/reference**：进入/退出计划模式、审阅被批准/退回（带读者原话）/搁置各一行；正文属于 artifact（dock 展开时显示，归档后由该行自己承载）。
- **plan review 不再生成 question 卡片**（B2.4 的临时守卫转正）：审阅是 artifact 的交互，Surface 照旧提问。
- **Dock 三级退让**：FULL（标题+进度+步骤）→ COMPACT（`▾ 计划模式 · 1 进行中 · 2 待处理 · › 第 1 步`）→ MINIMAL（`▾ 计划模式 · 1 进行中 · 2 待处理`），**永远存在**；live region 只会裁自己（几何顺序：transcript → live → dock → composer）。
- **line mode**：`plan-row` 是原地更新的行，line mode 只追加，所以每次 revision 只打印**变化**的步骤（`[status] content`）；生命周期行本来就是新行 ✓。

### 顺带修的回归（用户报告）

**部分命令执行后没有任何提示**：acknowledgement 走 footer echo chip，而 chip 是状态行里**最低优先级**的一组——工作状态下正是最满的时候，于是整条被丢掉。现在：chip 放不下时改由**身份行**显示同一条消息（一条消息、一个位置、零几何）。实测 160/120/100/80/72 列全部可见。

> **后续修正（W-3b.2a）**：这条只做到一半——`chip 放不下时`才改由身份行显示，放得下时仍在**状态行**（底栏第一行）上，于是"一个位置"实际是**两个位置**，由消息长度与窗口宽度决定：同一条 `/copy` 的短文案 `已复制 412 字…（最近回复）` 落在底栏第一行、长文案 `还没有可复制的回复…` 落在最后一行（用户报告"copy 提示跑到第一行"）。现在 acknowledgement **永远**在身份行（最后一行），状态行只留仪表（E-1）；`FooterStripInput.echo` 与 budget 里的 `echo` 组一并删除（唯一调用点只有一个），notice 仍优先于 echo。

### 验收

| 项 | 结果 |
|---|---|
| 全量测试 | **1344 · 1340 pass · 0 fail · 4 skipped**（新增 `tests/plan-projection.test.mjs` 19 条、`tests/plan-artifact.test.mjs` 13 条） |
| 类型 | `tsc --noEmit` 干净 |
| 审计 | `unclassified 0 · live source rows 0 · duplicate calls 0 · generic question tool rows 0` |
| 变异 | **10/10 全红**：M1 重放丢 review 身份、M2 两份计划合并、M3 两个 revision 合并、M4 无证据报 completed、M5 transcript 第二份完整 plan、M6 dock 回到显示顺序、M7 live region 盖住 dock、M8 矮终端丢 plan、M9 plan-review 被普通 ask 接管、M10 放不下的提示继续丢 |
| 真 PTY | `tui-probe` OK · `tui-drop-probe` OK · `--line-mode` OK · `tui-term-probe` OK（详见报告） |
| live/replay | 每行 kind+state+text 全等（用例 + 样本脚本都断言） |

### 未做 / 留给后续

- **protocol gap 只报告不扩**：plan id、`completed/abandoned` 事件、审阅问题文本的 durable 记录（三处，见 audit §7）。按 §21 停在设计结论，没有新增任何插件私有持久化。
- setup（B2.6）、completion layout、Context Lifecycle、Search Screen、通用 transcript redesign。

---

## B2.6 批 · Setup / Onboarding Screen 迁移（B2 收尾）

一句话：**安装向导是一个 Screen，不再是一段借用 workspace 的对话。**

### 迁移前的架构（审计结论）

| 项 | 迁移前 |
|---|---|
| 载体 | `dialog = {kind:'onboarding'}` + `dialogRole = DEDICATED_ROLE`，进入 `dialogQueue` |
| 空间 | `dedicatedLines` 从 transcript 预算里**切出行**（挤走历史），composer 仍在下方 |
| 输入 | 借 workspace composer 的字段（`setField/fieldText/insertIntoField`），进入时 `setField('',0)` **清掉读者的草稿** |
| 消息 | 校验失败/抓取结果/保存结果都是 `pushRow(represent('onboarding', …))` → **transcript 行** |
| 渲染 | `paintFrame` 里一段 `addDialog(...)` 分支（约 120 行），字段行复用 composer 行 |
| Esc | `handleEscape` → `stepBackOnboarding() || cancelOnboarding()` |

9 步、默认值、校验、provider/model 选择、确认与写入全部不变（`tests/onboarding.test.mjs`、`context-window`、`provider-family`、`reasoning-declare` 继续覆盖业务语义）。

### 迁移后

- **Screen**：`openScreen({ kind: 'setup' })`；`ScreenKind` 增加 `'setup'`；`renderScreenBody` 分派到 `renderSetupBody()`（每帧由状态机生成），复用 B2.1 的 `screenLayout` / paint 管线（dirtyFrom / 字节预算 / paintResume），深度仍为 1。
- **输入归属**：`OnboardingState.field/fieldCursor`；`handleChar` 在 setup Screen 时把**所有键**交给 `handleSetupKey`（Enter 也归它，Ctrl+C 保持全局中断语义），因此 composer 草稿、history、agent 都不会收到向导的输入。
- **消息归属**：`setupMessage()` —— framed 模式写 Screen 自己的 notice 行，line mode 仍 `pushRow`（保留文本路径）。
- **几何**：body = 步骤指示 + 说明 + 控件（字段/notice/按键）；高度压力下**先裁说明**，字段和按键永远在（`windowSetupBody`）。
- **旧路清除**：`DEDICATED_ROLE` 与其在 `surfacePriority` 的档位、`dedicatedLines`、`dialog.kind==='onboarding'` 的渲染与按键分支全部删除；`OnboardingDialog` 只是 **deprecated 形状**（0.8.x 导入兼容），落在 `isSurfaceDialog()` 之外、**不可达**。

### 行为差异（单独报告）

1. 向导的**完成提示**（`onboard.officialDone` / `customDone`）不再写 transcript，改为 Screen 内 notice —— 按 §13 默认不留向导历史；配置结果由随后 workspace 的页眉/页脚如实呈现。
2. 向导的**校验失败/抓取结果/保存失败**同理，只在 Screen 内显示（framed）。line mode 一字不变。
3. Esc 在 setup Screen 内语义不变（picker 步回退，其余取消）；Ctrl+C 仍是全局中断（不消费）。
4. 向导不再清空/借用 composer 草稿 —— 这是修 bug，不是行为变更。

### 验收

| 项 | 结果 |
|---|---|
| 全量测试 | **1359 · 1355 pass · 0 fail · 4 skipped**（新增 `tests/setup-screen.test.mjs` 15 条） |
| 审计 | `unclassified 0 · live source rows 0 · duplicate calls 0 · generic question tool rows 0`；framed onboarding 创建点 = 0 |
| 变异 | 见报告（M1–M9） |
| PTY | `tui-probe` / `tui-drop-probe` / `--line-mode` / `tui-term-probe` OK；新增 `scripts/tui-setup-probe.mjs`（本机因 home 已配置而 SKIP，见报告） |

---

## B2 FINAL AUDIT 批 · 冻结、遗留路径清除与性能基线

**日期**：2026-10-03 · **性质**：审计与冻结，**不加新功能**（completion layout / Search Screen /
Context pruning 均不在范围内，一个都没碰）。

快照：`b2.6-snapshot` = `3f1cd855ad0e781dc298bedd1d1c4a3c7970f216`
（tracked + untracked 工作树状态，用临时 `GIT_INDEX_FILE` 造的提交，真实 index 与工作树未被改动）。

### 1. 静态审计（五个目标，逐条结论）

| 目标 | 结论 |
|---|---|
| `DEDICATED_ROLE` | **0 处**。`SurfaceRole` 只剩 `interaction \| picker`；`dedicatedLines` 与 `surfacePriority` 的第三档都不在。`src/tui.ts` 里那条"dedicated 视图（onboarding）仍从窗口里取行"的注释是**过时的**（B2.6 已删掉那条路径），本轮改成如实描述。 |
| legacy onboarding renderer | **0 处**。`OnboardingDialog` 只剩 interface 形状（0.8.x 导入兼容），没有赋给 `this.dialog` 的生产路径；`represent('onboarding', …)` 只剩 `setupMessage` 的 line-mode 分支一处。 |
| generic ask-user duplicate | **0 处**。`ask_user_question` 的两个决策点都在 question-card 路径上（`askQuestions` 记批次 / `ensureQuestionCard` 画卡）；通用工具卡路径被 `QUESTION_TOOL_NAMES` 挡住。 |
| legacy plan row truth | **发现并修掉一处**（见 §2）+ 删掉一个**没有调用者**的第二写入者 `upsertPlanRow`。 |
| live source rows | **0 行**（`live source rows 0`）；运行时状态是投影，不进源行。 |

### 2. 修掉的那一处：`plan-row` 包着一行 system 文本

`src/tui.ts` 的 turn-end 待办通知（"本轮未收尾…"）走的是 `represent('plan-row', { kind: 'system', text })`。
`plan-row` 是**计划 artifact 的转写引用**（有 `artifactId` 与 steps），于是：

- 审计的 `plan-row` 计数与它声称的 artifact 对不上；
- 一行没有 `todos` 的 `kind:'plan'` 行落在了计划卡的绘制路径上（今天不炸，是因为它带着 `text` 而没有
  `artifactId`；但这是运气，不是契约）。

改为 `represent('plan-notice', …)`（echo）。**读者看到的没有减少**：dock 自己的 `planDockNote` 仍然把
同一句话画在屏幕上（实测：去掉那行后屏幕上仍有 3 行"本轮未收尾"），而它本来就同时存在于 dock 与转写里
是重复的。新增 `tests/plan-artifact.test.mjs` 的 "the leftover-todo notice is not a plan row" 钉住运行时规则
（plan-row ⇒ 必须 `kind === 'plan'` 且有 `artifactId`）。

### 3. `npm run freeze`：把冻结变成一条命令

新增 `scripts/b2-freeze-audit.mjs`（+ `npm run freeze`，Linux 与 Windows 两条 CI 腿各跑一次）。
它把**表示审计**（未分类 / 未知 destination / live 源行 / 重复 primary）与**退役路径扫描**（上表五条 +
`plan-row` kind 一致性 + 通用 ask-user 卡）一次跑完，并复述 PTY 门槛（Screen 深度、流式每 tick 全清、
Screen 翻页全清、setup 打字全清）让两边不会各说各话。

**变异检验（5/5 红）**：注入 `DEDICATED_ROLE` → `dedicated-role` 命中；在 `syncPlanArtifacts` 外加一个
`upsertPlanRow(...)` 调用 → `plan-row-second-writer` 命中；加一个 `represent('plan-row', { kind: 'system' })`
→ `plan-row-kind-mismatch` 命中（这条查询第一版**漏报**过：它在几行窗口里找 `createPlanRow` 的踪迹，
于是被同一个方法里无关的提及放行；现在只匹配**调用参数本身**的两种合法形状）；在 `handleStatus` 外加一个
onboarding 生产者 → `onboarding-transcript-producer` 命中；加一个只判 `name === 'ask_user_question'`
而不碰 card 的决策点 → `generic-ask-user-card` 命中。

### 4. 契约矩阵（按契约分组，全部绿）

| 契约 | 套件 | 结果 |
|---|---|---|
| Screen | `screen-contract` | 21 · 21 pass |
| Live | `live-tail` | 21 · 21 pass |
| Representation | `representation` | 16 · 16 pass |
| Routing | `feedback-routing` | 16 · 16 pass |
| Clear | 同上（`/clear` 隐藏视图、resume 复原、`/find` 可见边界） | 5 条在内 |
| Ask / Approval | `ask-approval-representation` | 26 · 26 pass |
| Plan | `plan-projection` / `plan-artifact` | 19 + 14 = 33 pass |
| Setup | `setup-screen` | 16 · 16 pass |
| 区域所有权 | `workspace-regions` | 5 · 5 pass |
| **全量** | `npm test` | **1361 · 1357 pass · 0 fail · 4 skipped** |

（B2.6 基线 1360/1356；本轮 +1 条新用例，0 失败。）

### 5. 性能基线（`npm run bench`，100×20，15 次中位数）

| 动作 | ms（15 次） | ms（25 次） | bytes | 寻址行 | 全清 |
|---|---|---|---|---|---|
| stream tick（流式 delta） | 1.81 | 1.60 | 478 | 3 | 0 |
| waiting tick（等待卡时钟） | 1.05 | 1.30 | 442 | 3 | 0 |
| Screen scroll（报告屏翻页，上下交替） | 1.43 | 2.48 | 2457 | 17 | 0 |
| picker move（菜单光标，上下交替） | 0.92 | 0.84 | 558 | 4 | 0 |
| setup typing（向导字段打字） | 0.27 | 0.18 | 140 | 1 | 0 |

bytes 与寻址行在两轮之间**完全一致**（同一份夹具、同一条绘制路径）；毫秒是宿主机噪声的量级，
`screen-scroll` 那 1 ms 的差别就是它——所以这两个数字只用来比较"同一台机器上的两次提交"。

`npm run bench` 断言五个动作**都没有全清**。方向交替是刻意的：单向动作在到底之后的帧本就什么都不画，
那是契约，不是成本。

**PTY**：`tui-probe` OK（`live stream: 30 row writes, 0 full clears, 4256B`；`screen scroll: 27 rows,
3771B, no clear`；resize sweep 60→1595B / 120→4184B）、`--line-mode` OK、`tui-term-probe` OK（8 个剖面）。

**`tui-drop-probe` 是 flaky（约 1/7）**：7 次里 5 次 OK、2 次 FAIL，两次失败形状完全相同——
`the /status Screen must close on Esc`，随后 `/exit` 被 Screen 吃掉、备用屏没交还。原因在探针自身：
它在等 Host 复活时**最多连打 10 次 `/status\r`**，Esc 之后迟到的那次会把 Screen 重新打开。产品侧的
Screen/Esc 路径本轮未改，且 `screen-contract` / `tui-probe` 的同一组行为都是绿的。**如实记录，未修**
（修探针属于本轮范围外的改动；已在 §7 债务里列出）。

### 6. 文档

- `docs/decisions/b2-architecture-decisions.md`：新增 **§20 B2 FROZEN**（八条不变量 + 命令、七条退役路径表、
  "表示分类必须与内容一致"的规则、未验证项、结论）。
- `docs/release.md`：新增 **"发布前人工门槛"**（Windows 实机清单、fresh-home 探针命令、`npm run freeze`
  / `npm run bench` 两条自检）。
- 本节。

### 7. 剩余债务

1. **fresh-home 真 PTY 首启**：本沙箱建不出未配置的 home（pnpm store 在 workspace 之外且只读，
   `dsh plugin add` 报 `ERR_SQLITE_ERROR`；把 `XDG_*` 指进 workspace 可以建成，但建成的那份 home 上向导
   没有自动打开，原因未查清）。探针 `scripts/tui-setup-probe.mjs` 已就位，并修掉了它的**两段式探测窗口**
   （旧版把"首帧画了工作区 composer"当成"已配置"，而启动时工作区本来就先画一帧——它因此会对新 home
   误报 SKIP）。
2. `tui-drop-probe` 的 `/status` 重试竞态（§5），应改为"发一次、等一帧、必要时再发"。
3. Windows / ConPTY 实机：本机不可覆盖，已列为发布前人工门槛。

---

## 0.8.2 RC 准备收尾 · 现场报告的三处修复与验收

**日期**：2026-10-03 · **性质**：发版加固 + 现场缺陷修复，**不加新功能**。

从 0.8.1 的现场报告出发，本轮修掉三处，并把其中两处变成 CI 上的门。

### 1. 三处修复（各自的根因与证据）

| 现象 | 根因 | 证据 |
|---|---|---|
| resume 进入时 1–3 秒黑屏 | 前端在备用屏打出加载提示后，relay 接入时 Host 又写了一次 `?1049h`——终端已在备用屏时会**清屏**，而回放期间按 B2.4 不合成任何帧 | 20k 事件实测：9.1 s 清屏、12.6 s 首帧，中间 3.5 s 全黑。修法是把进屏序列搭在第一帧上（`37dda1e`），实测 12.07 s 清屏 / 12.15 s 落地 |
| 思考卡片文字发白（256 色终端，折叠与展开皆是） | `reasoning` 角色只写 `2;3`（属性，无颜色），"暗"完全靠 faint；不实现 faint 的终端退回默认前景色 | 打帧实测修复前 `ESC[2;3m`、修复后 `ESC[2;3;90m`；新增断言：带颜色的调色板必须写出颜色，只有 `mono` 可以只写属性（`774ac3f`） |
| `q` / `Q` 关不掉报告屏 | `inspectClosesOn` 声明接受它们，但可打印字符的提示分支在它之前 return | 变异校验：把顺序改回去，测试立刻失败（`8c33635`） |

**上一轮的错误尝试**（`6cf7311`，已 `32730f5` 回退）：同样是黑屏，做法是"加载期间由 Host 补画一行"，
写进了 relay 的测速窗口，读者的链路灯变成四个空心圆并停在 160 ms。教训写进了代码注释：**加载期间不要
多写字节，而是不要擦掉已经在屏上的东西**。

### 2. 变成门的两件事

- **链路探针补上"带历史的 resume"**（`9bba38b`）：`scripts/tui-rtt-probe.mjs` 第二段自己写一份
  20k 事件的持久化日志并 resume，同时断言"画面上出现过加载行之后不得再变空 + 转写落地 + chip 落在
  真实测量值"。两条断言都做过变异校验：改回"接入即写"报 4 秒黑屏；关掉 RTT 应用报 chip 停在
  `○○○○ 160ms`。
- **`verify-batch.mjs` 不再把 SKIP 说成 PASS**（`9bba38b`）：有步骤跳过时收尾 `RESULT: INCOMPLETE`
  （exit 2），与 `FAIL`（exit 1）、`PASS`（exit 0）三分。`link` 已进验收步骤表。

### 3. 验收（提交 `9bba38b`）

| 门 | 结果 |
|---|---|
| GitHub CI（五条腿：0.2.0-rc.2 / rc.1、0.1.7-rc.2 / rc.1、test-windows） | **全绿**（run 37109091641）；**这是 Windows 腿自 0.8.1 以来第一次绿** |
| 干净检出 `npm install` + `npx tsc --noEmit` | 0 错 |
| 干净检出全套测试 | 1376 项 · 1373 通过 · 0 失败 · 3 跳过 |
| `npm run freeze` | 八条不变量 + 七条退役路径全绿 |
| `npm run bench` | 五个动作 0 次全清，1.4 / 1.3 / 1.2 / 0.9 / 0.2 ms |
| 干净检出 `verify-batch`（自建 home 的八步） | PASS（typecheck、home、term、**link**、mock、busy、busycrash、footer） |
| 干净检出 `verify-batch` 中需读 `~/.dsh` 的四步 | 沙箱内 `~/.dsh` 只读（`EROFS …/cordis.yml`），**未测**——非产品缺陷 |

### 4. 剩余门槛（本节写于 Windows 轮之前；逐条现状见下）

1. ~~**Windows / ConPTY 实机 12 项清单**~~ —— **已完成**（2026-10-03，维护者，见下一节「Windows 实机轮」：
   12 PASS · 2 SKIP · 0 FAIL，两目人眼项确认通过）。
2. ~~**链路 chip 在读者 256 色终端上的间歇性空圆**~~ —— **已定案**：`/diag` 显示 `探测 未知（终端未回
   DSR）`，即那台终端多数时候不回答 `CSI 6n`；空心圆是正确表态，真正的缺陷是**旁边印着绘制节奏
   `160ms`**（看起来像延迟），已修（`52417b9` → `SSH ○○○○ 未测`），并由
   `scripts/tui-unmeasured-probe.mjs` 覆盖"从没测到过"这条形状（CI 两条腿）。
3. ~~**链路探针只在默认 Linux 腿跑**~~ —— Windows 腿现在跑 `tui-unmeasured-probe.mjs`（管道父进程）；
   `tui-rtt-probe.mjs` 的**第一段**（慢链路形状）在 ConPTY 上按 `SKIP:` 处理，因为它无法被扮演。
4. 4 个 `.xdg-*` 文件自 `6be9960` 起被跟踪，属遗留清理，未在本轮处理。

**结论（本节写于当轮）**：`RC PREP COMPLETE, BLOCKED BEFORE TAG` —— 自动化门全绿，当时还剩两件只能人工
完成的门槛（上面 1、2）。**两件都已闭合**，见下一节。

## Windows 实机轮 · 0.8.2 RC 前的五处探针缺陷（2026-10-03）

在 Windows 实机上用**单独拉的一份 CLI dsh**（`npm i @deepseek-ai/dsh@0.2.0-rc.2` 到一份独立前缀，不动
PATH、不用桌面版 runtime）逐条走 12 项清单，跑出一批"看起来像产品缺陷、其实是探针"的失败。逐条定位与
修法如下；**产品代码零改动**，改的全是探针与门。

| # | 现象（实机） | 定位 | 修法 |
|---|---|---|---|
| 1 | `verify-batch` 的 `typecheck`/`full suite` 在 0 秒内 `FAIL (exit 127)` | `spawn('npm', …)`：Windows 上装的是 `npm.cmd`，Node 不带 shell 不会执行它（CVE-2024-27980） | 优先用 `$npm_execpath` + `process.execPath`，退路是整行交给 shell（单字符串，避开 DEP0190） |
| 2 | `tui-route-probe` 直接崩：`mkdtemp '\tmp\…' ENOENT` | `join(process.env.TMPDIR ?? '/tmp', …)`：`/tmp` 在 Windows 是**驱动器相对路径** | 换 `os.tmpdir()`（`tui-mock-probe` 早就修过同一处，这个漏了） |
| 3 | `tui-route-probe` 接着崩：`symlink … EPERM` | 目录符号链接要 `SeCreateSymbolicLinkPrivilege` | Windows 用 `junction`（与 `tui-mock-probe` 一致） |
| 4 | `footer-windows-probe` 的 8 个档案全是"已测量" | 该探针从没喂过 `probed: false` | 加两个档案（SSH/旧代码页 × 未测量），并逐格断言 chip 的**时长槽**：`未测` 而非 `160ms`；旧代码页下空心圆是 `o`（`○→o`） |
| 5 | `tui-mock-probe`：拖选复制偏移、`160→…→160` 行不相等 | ① 拖选坐标由**字节流里解析 `ESC[<row>;1H`** 得来，而 ConPTY 把帧重发成换行批次 ⇒ 回复被"找到"在字符 8065、按下列 8151；② 行恒等断言把链路芯片的**活值**（8 秒时的重测）算进去了 | ① 坐标改由**真实终端网格**（`tests/screen.mjs`）给出，按单元格映射；② 比对前把 chip 的活值归一化（`SSH ●●●● …`），并在日志里保留对比力 |

**这不是"探针运气不好"**：第 5 条的前半曾经被我报成产品缺陷（`selection.ts` 的 gutter/列走查）。实际是
探针读了一行被 ConPTY 拼出来的伪行——把坐标交给真实网格后，同一次拖选逐字复制出
`TOKEN-ALPHA-9 --dry-ru`，`/copy` 与 Alt+4 选中复制本来就是精确的。定位手段：临时打开
`DSH_TUI_SELECTION_DEBUG=1`（调试补丁**未提交**，只在本地编译过、随即 `git checkout` 还原）。

### ConPTY 盲区：显式 SKIP，而不是硬判

同一份字节流经 ConPTY 会被改形（一次 boot 加 `/diag`：`ESC[<row>;1H` **3** 个 vs 管道 **95** 个，
`ESC[2J` **1** vs **0**），而且 ConPTY **自己回 `CSI 6n`**。于是四类断言在 Windows 上无信号，四者现在都
打印 `SKIP:` 并附理由（`SKIP` 永远不算 PASS，整轮收尾 `INCOMPLETE`）：

- `tui-cut-probe`：无法扮"终端静默但没断连"（live 那一半照跑）
- `tui-rtt-probe` 第一段：无法扮慢链路（第二段"带历史的 resume"照跑，且它才是有回归历史的那段）
- `tui-setup-probe` / `tui-probe --line-mode` / `tui-probe` 的流式帧粒度：读不到逐行寻址与清屏

**新增覆盖**：`scripts/tui-unmeasured-probe.mjs`（管道父进程，两条腿）——**"从没测到过"这一格本机在
ConPTY 上根本摸不到**，而这个形状是被读者报过两次的那个。它断言：不回 DSR ⇒ `SSH ○○○○ 未测` 且
`/diag` 的 `绘制间隔 160ms` 另起一行；每条必答 ⇒ `SSH ●●●● <n>ms` 且 `/diag` 写"已测量"。已进
`verify-batch`（`unmeasured`）与 CI 两条腿。

**另一个真发现的同类问题**：真实 home 未配置时，0.8.2 会（正确地）进配置向导，于是 `tui-probe` /
`tui-drop-probe` / `tui-route-probe` 的断言全部打在"没有工作区"上而超时报红。三处改为识别向导并
`SKIP:`（`scripts/probe-onboarding.mjs` 一处判定），并在需要真跑时用 `verify-batch --home <dir>` 把
`probe`/`drop`/`linemode` 三步指向自建 home。

### 本机验收（`52417b9` + 本轮改动）

| 门 | 结果 |
|---|---|
| `npm run typecheck` | 0 错 |
| 全套测试（本机 Windows） | 1376 项 · **1365 通过 · 0 失败 · 11 跳过**（跳过均为平台互斥用例；`python3` 用运行时自带 Python 的 shim 后，原先那条环境性失败也过了） |
| 全套测试（Linux，发版候选 `c2fe073` 复跑） | 1376 项 · **1372 通过 · 0 失败 · 4 跳过** |
| `npm run freeze` | 八条不变量 + 七条退役路径全绿（0 命中） |
| `npm run bench` | 五个动作 **0 次全清**：1.43 / 1.25 / 1.19 / 0.97 / 0.22 ms |
| `npm pack --dry-run`（`c2fe073` + 本文档提交） | **243 个文件** · tarball **1.4 MB** · 解包 **4.2 MB** · shasum `92b7f517…` · 无凭据 / 无 home / 无 sqlite |
| `verify-batch --home F:\dsh-win-verify-home` | **12 PASS · 2 SKIP · 0 FAIL**（SKIP = `link` 第一段、`linemode`，均为 ConPTY 盲区并附理由） |
| 12 项人工清单中可自动化的部分 | 启动 / resize / 字形回退 / Screen / picker / 流式（clear 数）/ setup 向导 / detach-reattach / 断链恢复 全部通过 |
| 12 项人工清单中**只能人眼**的两目 | **已确认通过**（2026-10-03，维护者实机）：微软拼音 IME 组合（预输入串不出现在处理中卡片/计划卡上，上屏完整、光标位置正确）、多行中文粘贴（含换行与中文，不截断、不误提交） |
| 拖选高亮起点 | 由修好后的 `tui-mock-probe` 按**真实终端网格**逐格断言（此前那条"拖选偏移"是探针在 ConPTY 字节流里解出的伪行，见上表第 5 条） |

**结论**：Windows 实机人工验收**已完成**——12 项清单逐条走过，可自动化部分全绿、两处 ConPTY 盲区有名字有
理由（这两个形状在 Linux 腿上真跑，`SKIP` 不算 PASS）、两目人眼确认通过。**发版前不再欠人眼项**；剩下的
两条 `SKIP` 是**覆盖边界**，同时写在 [`release.md`](release.md) 与发版说明里。

---

## DSH Relay 软品牌（P0/P1，2026-10-04）

**性质**：命名与呈现层，**不改运行时行为、不改发布坐标**。ADR 与冻结原则：
[`decisions/brand-dsh-relay.md`](decisions/brand-dsh-relay.md)。

### 1. P0 基线（改动前实测）

| 项 | 值 |
|---|---|
| HEAD / 版本 | `0fb8156` · `0.8.2-rc.1` |
| 工作树 | 干净 |
| GitHub slug | `cyjyyd/dsh-ssh-tui`（P1 不动） |
| npm 包名 | `dsh-ssh-tui`（P1 不动） |
| 安装命令 | `dsh plugin --profile tui add dsh-ssh-tui@latest`（P1 不动） |
| `description` | `SSH-friendly interactive terminal TUI plugin for DeepSeek Harness` |
| `keywords` | `deepseek-harness` `dsh` `dsh-plugin` `plugin` `tui` `terminal` `ssh` `cordis` |
| README 首屏 | `# dsh-ssh-tui` + 徽章 + "A resilient terminal frontend for DeepSeek Harness." |
| 截图/动图脚本 | `capture-readme-frames.mjs`（`screenshots`）、`capture-slow-link.mjs`（`screenshots:slow`）、`capture-footer-frames.mjs` |
| issue 模板 | **一个都没有**（`.github/` 下只有 `workflows/`） |
| `docs/terminals.md` | 179 行：为什么需要它 / 矩阵 / 覆盖方式 / 键盘与输入 / 已知限制 / 字符宽度 |

### 2. 命名出现审计（A/B/C/D）

口径：`git grep` 全树（tracked 文件），分类规则见 ADR「Naming boundary」。

| 类 | 含义 | 数量（改动前） | 处置 |
|---|---|---|---|
| **A** | 安装/包坐标：`package.json.name`、`src/update-check.ts` 的 `PLUGIN_PACKAGE`、`scripts/install-npm.mjs`、README/文档里的 `dsh plugin add dsh-ssh-tui@…`、i18n 的模块副本提示、对应测试断言 | **35 行 / 16 个文件** | **不动**（原则 2、9） |
| **B** | GitHub URL：`repository.url`、`homepage`、`bugs.url`、徽章、文档链接 | **15 行 / 7 个文件** | **P1 冻结**（原则 3） |
| **C** | 人读到的产品名：README 首屏与正文、发版说明、About、本 ADR、本文件 | README 18 + README.en 21 + 文档若干 | **P1 改为 DSH Relay**（只改这一类） |
| **D** | 协议/配置标识：`cordis.patch.yml` 的 4 条 entry id（`dsh-ssh-tui/startup` 等）、`TUI_SOURCE_KIND`、日志包装器 `kind`、设置行 `dsh-ssh-tui/settings-*`、`DSH_TUI_*`（96 处）、错误前缀 `dsh-ssh-tui: `（30 处）、`@module dsh-ssh-tui/…`（31 处） | 约 **165 处** | **不动**（原则 9）：改了会破坏老会话日志、profile 文件与既有 bug report 的可搜索性 |

`src/` 的 88 处里**没有一处是人读的产品名**——全部是 doc 标签、错误前缀、标识符字面量与注释里的包名。
这正是"改 C 不动 D"能成立的原因：**运行时不认识产品名，只认识坐标。**

### 3. P1 改了什么

| 项 | 内容 |
|---|---|
| README 首屏（中/英） | `# DSH Relay` + `A resilient terminal workspace for DeepSeek Harness.`；紧跟"npm 包名与安装命令未变"的提示；安装命令原样 |
| Hero 语义 | 中：**SSH 断了。会话还在跑。接回来就是了。** 英：**SSH drops. The agent keeps working. Reconnect. Reattach. Continue.** |
| 重连演示 | `docs/screenshots/reconnect.gif`（**4 帧 · 11.8 秒 · 824×660 · 106 KB**），由 `scripts/capture-reconnect.mjs` 真机拍摄：真 PTY、真宿主、真 SIGHUP、真 `--resume`；`npm run screenshots:reconnect` 可重放 |
| 实测块 | README 中英各一段，由 `scripts/bench-report.mjs` 从 `npm run bench -- --json` 生成（`npm run bench:report`）；`--check` 只比字节/行数/清屏数，**毫秒列不比**（否则就是一个 flaky 门） |
| CTA | 每条 README 一个：提交终端兼容报告；外加一句点 star（不弹窗、不遥测、CLI 内不求 star） |
| 贡献入口 | `.github/ISSUE_TEMPLATE/terminal-compatibility.yml`（9 字段：OS / 终端 / 本地或 SSH / TERM / dsh 版本 / Relay 版本 / 8 项能力自选 / 备注 / 可选 `/diag`） |
| 兼容矩阵 | `docs/terminals.md` 新增「证据等级」：作者/CI 实测与社区实测**分两栏**，社区栏附贡献方式与升级规则 |
| 包元数据 | `description` 改为 remote-first；`keywords` 加 `coding-agent` `cli` `remote-development` `windows-terminal` `conpty`，保留原有 8 个 |
| GitHub 元数据 | `docs/github-metadata.md`：建议 About 描述 + 10 个 topics，标注**需维护者在 UI/API 手工应用** |
| 观察模板 | `docs/brand-metrics.md`：字段、star conversion 定义、采集节奏；**无数据、无遥测** |
| 发版说明政策 | `docs/release.md` §三：0.8.x 后续版本首次带一句"presented as DSH Relay；包名与安装命令未变"，明确**不要叫 rename**、不要制造 breaking 感 |

### 4. 门（改动后实测）

| 门 | 结果 |
|---|---|
| `npm run typecheck` | 0 错 |
| `npm test` | 1376 项 · **1372 通过 · 0 失败 · 4 跳过**（与改动前逐项相同） |
| `npm run freeze` | 八条不变量 + 七条退役路径全绿（0 命中） |
| `npm run bench` | 五个动作 **0 次整屏清屏** |
| `npm run bench:report -- --check` | 两条 README 的数字与当前树一致 |
| `npm pack --dry-run` | **244 个文件**（243 + `reconnect.gif`） · tarball **1.5 MB** · 解包 **4.3 MB** · shasum `cfbde58b…`；ADR / brand-metrics / github-metadata **不进包** |
| 运行时 | **零改动**：本轮没有触碰 `src/` 的任何执行路径 |

### 5. 未做（P2/P3）

1. **P2 观察**：`docs/brand-metrics.md` 是空模板，需维护者手工填 GitHub Insights 数据；集满一个窗口前不评估 P3。
2. **P3 GitHub relaunch**（若 P2 支持）：repo rename + 徽章/链接/About 一次性改写。
3. **P4 npm 迁移**：独立决策，不与 P3 绑定。
4. **CLI 里的产品名**（`/diag` 的 `plugin: dsh-ssh-tui <version>`、启动横幅、错误前缀）**故意保留**：它们属于 D 类，是搜索结果与既有 bug report 的锚点。
5. `npm run bench:report` 由人工在发布前跑一次（不进 CI：它比较的是提交内容，放进 CI 只会在毫秒抖动上浪费时间）。

---

## 粘贴被工作区草稿吞掉 · Screen 输入所有权补全（2026-10-05）

现场报告：**首启向导里粘贴 API Key 没有反应，只能手敲。** 本轮把这一类问题一次查干净。

**影响面**：首次安装（`stored === false` 时的首启向导）与 `/setup` 是**同一个 Screen**，所以首次安装
一次不落地全部受影响 —— 而首启向导是唯一能把会话配置到可用的东西。粘贴与手敲的差别在这里不是
便利性，是能不能装好。

### 1. 根因

向导自 0.8.2 起是 Screen（B2.6）：它有自己的字段（`OnboardingState.field`）和自己的按键处理
（`handleSetupKey`）。但"文本输入归谁"此前只有两个答案：composer 的草稿，或对话框借来的字段。

- `textIsEditable()` 只问 `this.dialog`：Screen 不是 dialog，于是它答"可编辑"（true）；
- `handlePasteText()` 于是把粘贴交给 `fieldText()/setField()` —— 也就是 Screen **背后**那个
  看不见的 composer 草稿。

粘贴没有丢，它进了读者看不见的输入区；等向导结束，草稿里躺着一整串 Key。这正是"被输入区捕获"。

### 2. 同类：`handleChar` 的控制键在 Screen 之前就分流了

`handleChar()` 的 `switch` 在 Screen 分支**之前**，而那张表里的守卫全是 `this.dialog === undefined`
—— Screen 不是 dialog，所以一个都拦不住：

| 键 | 修复前（`/diag`、diff 全览等 Screen，经 burst/Alt 路径可达） |
|---|---|
| Enter | 把看不见的草稿**当消息发了出去**，并清空它 |
| Ctrl+U / Ctrl+K | 清空 / 从光标处截断草稿 |
| Backspace / Ctrl+H | 删掉草稿里的字 |
| Ctrl+A / Ctrl+E | 移动草稿光标 |
| Ctrl+R / Ctrl+T | 折叠背后转写的卡片 / 切换草稿折叠 |

另外 `Ctrl+L`（整屏重画）此前只有向导认，其它 Screen 直接丢弃 —— 同一张所有权表里的不一致，本轮一并统一。

### 3. 改动（`src/tui.ts`，无接口变更、无配置变更）

1. `handlePasteText()`：**Screen 优先** —— 有字段的 Screen 收下，没有字段的 Screen 丢弃，绝不落到草稿；
2. 新增 `pasteIntoScreen()`：只让 `SETUP_FIELD_STEPS` 的步骤收；行尾换行折叠（网页/`.env` 复制来的
   Key 都带一个换行），多行按分隔拼接（模型列表、`.env` 块），字段永远是一行；
3. `textIsEditable()`：Screen 一律 false —— "草稿可编辑"从此不对 Screen 成立；
4. `handleChar()`：Screen 门提到 `switch` 之前，与 `handleInputText()` 的门位置一致 —— 两条能送字符
   进来的路径由构造保持一致，而不是各写一份守卫；
5. `looksLikePasteBurst()`：把 `handlePlainText()` 里"多换行即粘贴"的启发式提成一条规则，并让 Screen
   路径也用它（老 conhost 不发括号粘贴时，粘贴的 Key 与模型列表同样进字段）；
6. `handleScreenInput()`：`Ctrl+L` 归所有 Screen（从 `handleSetupKey` 移上来，不留两处实现）。

### 4. 证据

| 证据 | 结果 |
|---|---|
| 新增单测（`tests/setup-screen.test.mjs` 5 项 · `tests/interaction-surface.test.mjs` 2 项） | 修复前 **6 项红**，修复后全绿 |
| 泄漏表（3 种 Screen × 13 键 × 2 条投递路径 = 78 格） | 修复前 **21 格命中**；修复后 **no leaks** |
| 真机探针 `scripts/tui-setup-probe.mjs`（新增粘贴阶段，真 PTY 发括号粘贴） | 修复前 FAIL：`the pasted key is masked in the field (1 → 1 bullets)`、`the paste never reached the composer behind the wizard`；修复后 OK |
| 真机探针 `scripts/tui-probe.mjs`（启动/缩放/报告/退出） | OK |
| 门 | `npm run typecheck` 0 · `npm test` 1382 项 · **1378 通过 · 0 失败 · 4 跳过** · `npm run freeze` 八条不变量全绿 · `npm run bench:report -- --check` 两条 README 一致 |

真机探针的粘贴阶段落在**密钥步（4/9，掩码字段）**，正是首次安装的场景：粘贴显示为圆点、明文从不出现在
帧里、Esc 回到工作区后草稿里没有它。

### 5. 未做

1. **没有改版本号、没有发版**：`CHANGELOG.md` 的 `## Unreleased` 记了这一条，进哪个补丁版由发版时决定。
2. 真机 drop 探针（`tui-drop-probe.mjs`）本轮未跑：它要 CI 那套洁净 checkout 里的固定 mock 模型，
   本机 `node_modules` 是旧的符号链接农场；它与输入路由无关（CI 两条腿都会跑它）。
3. 向导字段的**左右光标键**仍未实现（`handleSetupKey` 只认上下）：粘贴因此总是追加在末尾。这不是缺陷，
   只是"掩码字段 + 中间光标"这条组合目前不存在；要做就得连掩码渲染一起补，不在本轮范围。

---

## 现场复测后的收尾 · 向导"存完要退场"与"一次 read 不是一键"（2026-10-13）

用户复测 0.8.2 后报：**走完设置向导（从 resume 进入）没有退回工作区**。修这个的过程中，真机探针又逼出
第三处同类缺陷（一次 read 里的多个按键）。三处都在向导 / Screen 的输入所有权这条线上，一并收掉，作为
**0.8.3 紧急补丁**发布。

### 1. 走完向导不退回工作区

`saveOnboarding()` 的 `finally` 只清 `this.onboarding` 并 `showNextDialog()`，**没有 `closeScreen()`**；
而 `cancelOnboarding()`（Esc 路径）有。于是保存成功后 Screen 仍然占着屏，读者要随便按一个键，才由
`handleSetupKey()` 开头那句"Screen 背后没有向导 → 关掉它"兜底退场。**保存本身就是退场**，现在两条路径对称。

同一处还修了失败路径：原来无论成功失败都清 `this.onboarding`，于是"保存失败"的错误写在了一个**立刻被丢掉**
的 state 上——Screen 留着、错误没了、答案也没了，下一次按键还把这整套流程当作没发生过。现在失败**保留向导
和错误**（`saving` 复位，可以改完重试），成功才关屏。

配套：向导自己的提示行会随 Screen 一起消失，所以完成语改为**转写行**（`onboardDone` → `command-status`；
`credSaved` 那条是 footer echo，会过期），读者在工作区还能读到"配置完成，已记住 X / Y"。

### 2. 一次 read 不是一键（真机探针发现）

`handleScreenInput()` 把一次 read 当成**一个键**：`text\r` 这样的读取（慢链路上的快速输入、终端合并写入）
里那个 `\r` 会被丢掉——字段收下了文字、步骤却不动。实测探针在型号步骤卡住（帧里 `› deepseek-v4-pro_`、
仍停在 5/9）。新增 `screenKeys()`：转义序列保持完整（一个方向键就是一个键）、CRLF 当作一个 Enter、
控制字节各自成键、**可打印文本连成一段**（所以没有括号粘贴的 "yes" 仍然不会替读者按下确认）。
composer 路径一直就是这么做的（`handlePlainText` 逐字符），Screen 现在与它一致。

### 3. 证据

| 证据 | 结果 |
|---|---|
| 新增单测 3 项（`tests/setup-screen.test.mjs` 2 · `tests/interaction-surface.test.mjs` 1） | 修复前红：`actual: { kind: 'setup', … }`（Screen 停在向导上）；修复后全绿 |
| 真机探针 `scripts/tui-setup-probe.mjs` 新增第 7 阶段（**resume 进入 → 走完向导 → 保存**） | 修复前 FAIL（型号步骤卡在 5/9，`text\r` 的 Enter 被丢）；修复后 `resumed first run: wizard saved on step 9, workspace back with no extra keypress` |
| 真机探针 `scripts/tui-probe.mjs`（启动/缩放/报告/退出） | OK |
| 门 | `npm run typecheck` 0 · `npm test` **1385 项 · 1381 通过 · 0 失败 · 4 跳过** · `npm run freeze` 全绿 · `npm run bench:report -- --check` 两条 README 一致 |

探针第 7 阶段是**真 resume**：用同一 home 里最新的 session id 启动 `--resume=<id>`（首启判定只看凭据，
所以仍然进向导），粘贴 Key、走完九步、按 `y`，**之后不再发任何按键**，断言工作区自己回来。
它把"保存成功却停在向导上"钉成了回归门。

### 4. 发版（0.8.3，紧急补丁）

| 项 | 值 |
|---|---|
| 修复提交 | `f1195fe`（修复 + 测试 + 探针第 7 阶段） |
| 版本提交 / tag 所指 | `8483538`（`package.json` + `package-lock.json` 只动版本字段） |
| CI | run [38403856392](https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/38403856392) **五条腿全 success**（tag 不触发新的一轮，这是核对 tag 所指 SHA 得来的那条） |
| tag | `v0.8.3` → `8483538` |
| GitHub Release | <https://github.com/cyjyyd/dsh-ssh-tui/releases/tag/v0.8.3>（非 prerelease） |
| npm | `npm publish --tag latest` → `+ dsh-ssh-tui@0.8.3`；`npm dist-tag add dsh-ssh-tui@0.8.3 next` |
| 实收 | shasum `616541ff7cb5826d8a4f30478b3bc98b0924f8ee` · integrity `sha512-GB/0cJ6WMvmiq…8wYNvCKFGUcyQ==` · **246 个文件 / tarball 1.5 MB / 解包 4.4 MB** |
| 发布后校验 | 从 registry 重新下载 tarball，sha1 与上传值相同；包内 `lib/tui.js` 与本地构建树 `diff` 无差异；`docs/release-notes-0.8.3.md` 在包内 |
| dist-tags | **`latest` = `0.8.3`，`next` = `0.8.3`** |

完整回执同时写在 [`release.md`](release.md) 顶部（规则文件的第一段就是最近一次发版）。

---

## 0.8.4 规划轮 · 输入归属审计与契约（2026-10-13）

> **本轮不改运行时**：只审计、只写契约与路线图。`git diff` 里没有 `src/`。

产出：

| 文件 | 内容 |
|---|---|
| [`decisions/input-ownership.md`](decisions/input-ownership.md) | **AD-20 输入归属契约**：现状阶梯（照抄实测顺序）、事件 × 路由 × owner × 风险表、owner 能力矩阵、目标模型（Reader → Router → Owner）、禁止模式 F-1…F-6、测试要求 T-1…T-7、与 B2 不变量的接口 |
| [`plans/0.8.4-input-ownership.md`](plans/0.8.4-input-ownership.md) | 0.8.4 路线图建议：W-0 安全网 → W-1 Reader → W-2 Router → W-3 合并 read 修复；W-4 Completion 迁移 / W-5 Search Screen / W-6 Terminal Doctor 只规划不实现 |

审计方法与证据（`.pf/input-audit.mjs`、`.pf/input-audit2.mjs`，git 排除，不进仓库）：
用真实 `SshTui`（0.8.3 构建）喂入具体字节序列，对
`{input, cursor, historyIndex, scrollOffset, screen.offset, dialog, focusedRow}` 取前后快照。

**本轮实测发现的缺陷**（契约 §3 有完整表）：

| ID | 现象 | 触发序列 | 实测 |
|---|---|---|---|
| G-1 | composer 里一次 read 的多个键**全丢** | `\x1b[5~\x1b[5~` / `\x1b[B\x1b[B` | `no change`（单键 PgUp 滚 12 行） |
| G-2 | rebind 的键与别的键同 read 时绑定失效 | `keys: {pageUp:'ctrl+p'}` + `\x10\x10` | `no change`（单发滚 12 行） |
| G-3 | Alt 和弦与下一字符同 read：和弦丢失、字符泄漏成文本 | `\x1b1x` | 输入变成 `1x` |
| G-4 | `0x16`（Ctrl+V）无处理 | `\x16` | `no change`（不泄漏） |
| G-5 | Screen 内不能拖拽选择 | Screen 内 button 32/0 | `no change`（有意拒绝，`/copy` 是唯一路径） |
| G-6 | 两份实现 / 死代码 | `handleChar` 第二个 Screen 门已不可达；Ctrl+L 两套；`picker.ts` 自带 guard | 代码审阅 |
| G-7 | focus 事件靠"未知序列"兜住 | `\x1b[I` / `\x1b[O` | `no change` ✅ 但**无测试** |
| G-8 | Screen 内 rebind 的复制键同 read 失效 | 同 G-2 | 与 G-1 同源 |
| G-9 | 两个 hold 窗口做同一件事 | Guard 30ms vs TUI 60ms | 代码审阅 |
| G-10 | **任何复制路径都清空 composer 草稿** | `/copy`、复制键、Screen 内复制、拖拽选择、链接点击 | 输入 `我打了一半的消息` → 三条路径实测全变 `""`（`copyPlainText` 里的 `this.input = ''`，可追到 0.5.5） |

**没有发现的泄漏**（当基线写下来）：Screen 打开时草稿不被任何键改写；dialog 打开时转写不滚；
Surface 无字段时粘贴不改草稿；Screen 内的点击数不到背后行（`handleMouseClick` 明确拒绝）。
反过来，唯一一处**越权写**就是 G-10：复制是 Workspace/Surface 的动作，却改了 Composer 的草稿。

本轮未做：不改 `src/`、不改测试、不改冻结审计、不发版（契约与路线图落地在 0.8.4）。

---

## 0.8.4 W-0 · 输入归属安全网（2026-10-13）

> 目标：**破坏 event ownership 就必须红**。本轮不实现 InputRouter、不重构 Reader、不改路由行为。

产出：

| 件 | 内容 |
|---|---|
| `tests/input-ownership-regression.test.mjs` | **18 项 · 15 绿 · 3 todo**。全部经 `handleData` 真实路径（解码 → 回复过滤 → ESC 持有 → 粘贴标记 → 路由）；不直接调 `handleSetupKey`/`handleChar`，不设 owner 状态凑断言 |
| `scripts/input-freeze-audit.mjs` | 静态棘轮：router / dispatcher / owner 读取点 / **危险写者** / 粘贴与鼠标入口 / todo 计数，只降不升；`npm run freeze:input` |
| `npm run freeze` 新增段 | CI 现有两条平台腿都会跑 input ownership 计数（不改 workflow） |
| G-10 护栏 | `copyPlainText` 不再写 composer 草稿（删 4 行）；命令行消费仍归 `runCommand`，`/copy` 可见行为不变 |

覆盖（G 系列）：

| ID | 状态 | 说明 |
|---|---|---|
| G-1 | **todo（红）** | composer 路径一次 read 两个 PgUp/PgDn 仍会全丢；Screen 路径已能拆（绿灯对照用例） |
| G-2/G-8 | **todo（红）** | rebind（`ctrl+p`）同 read 两次仍丢；单发正常，且不会被当文本 |
| G-3 | **todo（红）** | `\x1b1x`：和弦丢失、`1x` 泄漏成文本 |
| G-4 | 绿（锁定） | `0x16` 在 composer / Screen / dialog 三处都无副作用 |
| G-5 | 绿（锁定） | Screen 内只认滚轮；press/motion/release 一律拒绝；向导（真 `runOnboarding` 入口）同样 |
| G-6 | 静态 | 第二 router、死 Screen 门由棘轮记录（`deadScreenGate` 基线 1）；G-6 用例本身会跑一次棘轮 |
| G-7 | 绿（锁定） | `CSI I` / `CSI O` 在 composer / Screen / dialog 全部无副作用（本轮只锁 ignore，不启用 focus） |
| G-9 | 文档 | 契约 §8.3 说明 30ms（回复，超时**交还**输入）与 60ms（按键，超时**变成按键**）为何并存，本轮不合并 |
| G-10 | **绿（护栏）** | 复制键 / Screen 复制键 / 拖拽 / 链接点击四条路径都不再动草稿；`/copy` 命令仍消费自己的命令行 |
| 额外 | 绿 | "粘贴 + 控制键同 read"的 Screen 门（0.8.3 修的那个缺陷，走 char 路径） |

门与 mutation：

| 项 | 结果 |
|---|---|
| `npm run freeze:input` 基线 | routers 2 · dispatchers 1 · mouseParsers 2 · rawBranches 13 · pasteConsumers 3 · mouseConsumers 3 · knownGaps 3 · ownerReads screen 31 / dialog 59 |
| M1 新写者（`handleMouseClick` 写草稿） | ✗ 棘轮红：`new writer: handleMouseClick writes the composer draft` |
| M2 删 `handleChar` 的 Screen 门 | ✗ 新网 + 0.8.3 网同时红 |
| M3 新文件里加第二 router | ✗ `routers 3 > baseline 2`；**首跑没红**（棘轮只扫两个已知文件）→ 已改成扫全 `src/`，mutation 即其回归证据 |
| M4 恢复复制清空草稿 | ✗ 四条 G-10 用例 + 棘轮新写者同时红 |

本轮未做：不实现 InputRouter、不重构 Reader/ESC/paste 解析、不进 Completion/Search/Doctor、不发版；
除 G-10 的护栏外无任何运行时改动。

---

## 0.8.4 W-1 · Reader 抽取（2026-10-13）

> 目标：**搬家，不装修**。建立唯一 Reader，行为逐字节等价；不实现 Router、不改优先级、不修缺口。

产出：

| 件 | 内容 |
|---|---|
| `src/input-reader.ts` | **AD-21**：UTF-8 解码 · 设备回复过滤（Guard 30ms）· 转义组装（60ms 持有+释放判定）· 粘贴边界（标记/burst）· 单元分类 |
| `InputFrame` | `key` / `burst` / `literal` / `paste` / `escape` / `reply`——六个 tag 的 union，没有事件框架 |
| `tui.ts` | 移出 `decoder`/`inputGuard`/`escapeBuffer`/`escapeTimer`/`inPaste`/`processPasteChunk`/`looksLikePasteBurst`；`handleInputText` = assemble → paste 帧 / `route()`；新增 `consumeFrame()` |
| `docs/decisions/input-reader.md` | Reader 契约：位置、责任表（13 行）、事件集与四条约束、两个 hold 窗口为何不合并、行为等价方式、相邻件（picker/探针/relay/`screenKeys`） |
| `tests/input-trace.mjs` + `tests/fixtures/input-reader-traces.json` | 54 个 fixture 的**抽取前**消费者轨迹与终态指纹（参考答案） |
| `tests/input-reader.test.mjs` | 8 项：逐 fixture 比对轨迹与终态 · 分片粘贴（三个）· "粘贴的 yes 不算作答" · 两个 hold 数字 · 孤立 Esc 释放 |
| `scripts/input-freeze-audit.mjs` | 新增 `readers` / `rawRouters` / `rawDecoders` / `pasteFraming` / `escapeAssembly` 五行；`pasteConsumers` 由 3 降到 2 |

**行为等价（本轮核心验收）**：以 HEAD 的 `tui.ts`（无 Reader）构建跑一遍 fixture 表，存下轨迹；
抽取后重跑，**54/54 逐字节相同**（调用序列 + 参数 + 终态指纹）。G-1/G-2/G-3 三条缺口的轨迹
**故意保持为坏**——在搬家轮里顺手修好它们，就是把行为变更藏在搬家底下。

**补齐 W-0 指出的缺口**：`paste-split-*` 三个 fixture（标记跨 read 分片）现在有轨迹 + 专项断言；
参考轨迹还纠正了一个假设——分开的 close marker 会被 Guard 的 30ms 尾窗**重新拼回**，
所以碎片不会变成载荷内容（`paste-split-close-marker` 终态为 `pasted`）。

**Mutation**：

| # | 变异 | 结果 |
|---|---|---|
| M1 | 新文件里再写一个 decoder/parser | ✗ `rawDecoders 5 > baseline 4` |
| M2 | 改粘贴框架（close marker → 终端不会发的字节） | ✗ 轨迹比对 + 两个分片粘贴用例 |
| M3 | 改 ESC 持有窗口（60 → 200） | ✗ 轨迹比对 + 两个窗口数字 + 孤立 Esc 释放用例 |

**门**：`npm test` **1411 项 · 1404 通过 · 0 失败 · 4 跳过 · 3 todo** · `npm run freeze` 全绿
（14 条 input 计数）· `npm run bench` 五个动作**字节/行数/清屏与基线逐项相同**（ms 只记录）·
真机探针（setup 含 resume 阶段 + 主探针）全过。

**CI 抓到的两件事（都已修，且都是"证据自身"的问题，不是 Reader 的问题）**：

1. **等价轨迹依赖运行环境**：第一次提交五条腿全红——轨迹记的是转写的**绝对行数**，CI 的启动转写比
   开发机多一行提示（3 → 4）。改成"本次 fixture 新增几行"（`rowsAdded`），并用"本地多注入一行启动
   提示"的验证钉住。教训进契约 §5：轨迹必须与运行环境无关，否则它比的是环境。
2. **Windows 的反斜杠让归属过滤失效**：四条 Linux 腿转绿后 Windows 仍红——`relative()` 在 Windows 上
   给 `src\input-reader.ts`，而过滤器比的是 `src/input-reader.ts`，于是 **Reader 自己的标记被算成
   "Reader 之外"**（`rawRouters 2 > 1`、`pasteFraming 5 > 0`、`escapeAssembly 3 > 1`）。修法是把
   归一化放到边界（`posix()`：读取与比较都过它），并用"让 walker 返回反斜杠"的本地模拟复现+验证
   （模拟在修前就是 CI 的三个数字，修后全绿）。

**本轮未做**：InputRouter、owner 优先级、Screen/Surface 行为、keymap、G-1/G-2/G-3 修复、
ESC/paste 语义、picker 架构、Completion/Search/Doctor、UI。

---

## 0.8.4 W-2 · InputRouter 与四类 Owner 适配器（2026-10-13）

> 目标：把"事件归谁"收敛到唯一 Router，四类 Owner 各就各位，**外部可观察行为不变**。

产出：

| 件 | 内容 |
|---|---|
| `src/input-router.ts` | **AD-22**：`route(kind, unit, ownershipView) → Owner`，纯函数式、零分配（视图对象复用、`collapsibleRows()` 只在箭头且无层叠时计算） |
| `docs/decisions/input-router.md` | Router 契约：三层调用链、API、决策规则表、两个记录在案的例外、四个适配器职责、G-6 结果、before/after、与 AD-20/21 的关系 |
| `src/tui.ts` | 四个适配器（`ownerScreen`/`ownerSurface`/`ownerComposer`/`ownerWorkspace`）+ `composerUnit`（Composer/Surface 共用兼容体）+ `arrowHistory`/`mouseGesture`/`repaintNow`/`scrollWorkspace`；`handleChar` 变成逐字符派发 |
| `tests/input-router.test.mjs` | **层 A**：7 项纯决策测试（含全组合扫描"永远是四个 Owner 之一"、快照冻结验证纯函数、两条债的显式锁定） |
| `tests/input-ownership-matrix.test.mjs` | **层 B**：7 项真实路径测试——每状态 × 每单元"恰好一个适配器"、Screen 背后草稿不被任何单元改写、无字段 Surface 拒绝文本与粘贴、无人认领的事件零状态变化、关屏后草稿与焦点原样回来、resume → 向导、粘贴的 `yes` 不作答 |
| 轨迹门 | 参考轨迹扩到 **72 条**（新增 18 条：Surface 的箭头/Esc/Enter/Ctrl+C/Ctrl+L/Ctrl+U/Home/End/Delete/翻页滚轮/未知 CSI、两种 Ctrl+L、report Screen 可打印键、自由文本问题的输入/退格/回车/粘贴/箭头），并在**抽取前构建**上采集；追踪点改为**Owner 边界**（W-2 允许重命名内部方法，不允许改变行为） |

**行为等价**：72 条 fixture / **246 次边界调用 + 终态**与抽取前构建逐字节一致（W-1 的 54 条一条未改，
新增 18 条同样取自抽取前构建）。G-1/G-2/G-8/G-3 三条缺口的轨迹**保持为坏**（3 条 todo 未动）。

**参考轨迹的独立复现**（证明 fixture 不是"改写过的期望"）：把本轮的 `tests/input-trace.mjs` 复制进
一个检出在 `dfbfb47`（W-0 收尾，Reader/Router 都还不存在）的 worktree，`npm run build` 后重跑同一份
比对：**72/72 逐字节相同 · 246 次边界调用**——这份答案任何人在重构前的树上都能重新推导出来。
一次校准：先试的 `b8ec354`（B2 落地）只有 68/72，差的 4 条（`paste-at-screen`、`screen-keys`、
`screen-paste-and-ctrl-u`、`screen-copy-key`）正是 0.8.3 紧急补丁 `a5f489f`/`f1195fe` 动过的
Screen + 粘贴/复制语义，所以"抽取前"要取到补丁**之后**的那个提交。

**G-6**：不可达的第二个 Screen 门**删除**（`deadScreenGate` 1 → 0）；`scrollActiveSurface` 的
screen/dialog 分支**删除**（拆成 Router 判定 + `scrollWorkspace` / `handleScreenInput`）；
两处 SGR 解析**合并**为一个匹配器；**Ctrl+L 的两份实现保留**并显式路由（合并需要"两份重绘行为一致"
的测试，本轮没有，按 AD-20 §6 记录为剩余债）。

**Freeze Ratchet（before → after）**：

| 计数 | before | after |
|---|---|---|
| `ownerReads.screen` / `.dialog` | 31 / 59 | **25 / 54** |
| `rawBranches` | 13 | **8** |
| `mouseParsers` | 2 | **1** |
| `deadScreenGate` | 1 | **0** |
| `routers` / `routerCallSites`（新行） | — | 1 / 3 |
| `guards` / `readers` / `pasteFraming` / `escapeAssembly` / `rawDecoders` / `rawRouters` | 2 / 1 / 0 / 1 / 4 / 1 | 不变（picker 债仍是 W-7） |

未新增白名单；`BASELINE_WRITERS` 只是把 W-0 记录的三处写入**改了方法名**
（`handleInputText`/`handleChar` → `route`/`ownerComposer`/`composerUnit`），写入的种类与归属未变——
顺带补上了 W-1 漏扫的 `route`（Alt 和弦的 `/find ` 种子），所以扫描面是**变严**而不是变松。

**Mutation（全部实测会红并已恢复）**：

| # | 变异 | 结果 |
|---|---|---|
| M1 | 删掉 Router 的 Screen 归属门 | ✗ 6 个测试红（矩阵、Screen 背后草稿、无人认领、关屏恢复、向导、层 A） |
| M2 | 粘贴穿透 Screen 边界 | ✗ 轨迹门（`pasteIntoScreen` 消失）+ `setup-screen` 两条粘贴用例 |
| M3 | 第二个 ownership dispatcher（`handleInputText` 里再读 `this.screen`） | ✗ `ownerReads.screen 26 > baseline 25` |
| M3b | `ownerWorkspace` 写 composer 草稿 | ✗ `new writer: ownerWorkspace writes the composer draft` |

**门**：`npm test` **1425 项 · 1418 通过 · 0 失败 · 4 跳过 · 3 todo** · `typecheck` 0 ·
`npm run freeze` 全绿（20 条 input 计数）· `npm run bench` 三次运行字节/行数/清屏**逐项与 W-1 相同**
（ms 单跑抖动，未出现可重复退化）· 真机探针（setup 含 resume 阶段 + 主探针）全过。

**CI**：`c654153` 五条腿里四条绿，红的只有 `test (0.1.7-rc.1)` 的真机探针 6c 一条断言：

```
resize sweep: 60→2008B 120→4833B 60→2008B 120→4833B
live stream: 63 row writes, 0 full clears, 10017B
menu close: partial repaint
screen scroll: 27 rows, 4018B, no clear
  - the repaint must start at the layer, not at the top of the frame (rows 2,1,30,29,25,24)
```

那条腿的测试套件本身是 **1425 项 · 1419 通过 · 0 失败**（`fail 0`）——红的是断言，不是测试。

**P-1（先于 W-2 存在，已定位到探针的测量窗口，不是产品）**：6c 在固定的 500ms 窗口里统计窗口内
**全部** `ESC[<row>;1H`，而"等待回答"期间的画布本来就有**时钟驱动**的重绘：`startRenderTimer()`
在 `row.kind === 'question' && row.status === 'waiting'`（spinner、wait card）时周期性置 `dirty`，
`armFeedbackExpiry()` 另有 TTL 到点重绘；当第 1 行（标题规则：banner + 模式 + 路由标签）的内容恰好
在那一瞬间变化时，它会和箭头引发的那一帧**并进同一次重绘**，窗口里就出现了 `< 5` 的行。

用只跑 6c 的本地仪器（`.pf/dlg-probe.mjs`，不入库）按 **pty chunk = 帧**逐块归属，红灯窗口的真实结构是：

```
run 6: FAIL rows=1,30,29,25,24 (foreign 1)
  [162B rows=1 | ────DeepSeek Harness — SSH TUI [标准模式] deepseek-official/deepseek-flash]
  [551B rows=30,29,25,24 | 目录:w1 · sub:deepseek-v4-flash SSH ○○○○ 未测 │ 等待回答 ›2 ● Option B …]
```

层帧（30/29/25/24，从层的上沿往下）本身完全正常；多出来的是另一块只重绘第 1 行的 chrome 帧。

**对照实验（决定性）**：同一支仪器指向 **W-2 之前的构建**——`git worktree` 检出 `b03de16`，
profile 的 `link:` 改指 `.pf/w1`，并用 `require.resolve('dsh-ssh-tui')` 验证解析到
`.pf/w1/lib/index.js`——同一断言以**同样的形态**变红（`rows=1,30,29,25,24`，同一块 162B 的第 1 行帧）。
两套仪器、两棵树的统计：

| 构建 | 全量探针（含 6c 的完整流程） | 只跑 6c 的仪器 |
|---|---|---|
| W-2 `c654153` | 1/11 | 1/13 |
| W-1 `b03de16`（对照） | 0/13 | 1/10 |

两棵树在同一断言上同形态、同量级偶发（W-2 合计 2/24，W-1 1/23）；`git diff b03de16..c654153 --stat`
是 13 个文件（新增 `src/input-router.ts`、`src/tui.ts` 的派发改造、四个测试、轨迹 fixture、两支审计、
四份文档），**没有一行绘制路径**。结论：这是**测量窗口的归属问题**，先于 W-2 存在，与输入归属无关。

本轮**没有**为了让它变绿去动断言、探针或加 skip——那会把 W-2 的验收变成运气。修法（把行数检查限定在
"承载层内容的那一帧 chunk"上，并用"整帧重绘"的变异证明它仍会红）单列为 **P-1 · 探针窗口归属**，
建议在 W-3 之前单独处理。

**收尾**：docs 提交 `e0c67a6` 的 run `38504428734` **5/5 全绿**——`test (0.1.7-rc.1)`、`test (0.1.7-rc.2)`、
`test (0.2.0-rc.1)`、`test (0.2.0-rc.2)`、`test-windows`，其中就有上一条红灯的那条腿：同一棵树、
同一条腿，这次是绿的，与"偶发、与产品无关"的结论一致。

**本轮未做**：G-1/G-2/G-3 修复、`burst` 逐键规范化、Reader hold 窗口、keymap 默认值、picker 重构、
Completion/Search/Doctor、版本与品牌。`scripts/bench-b2.mjs` 的 `tui.inputGuard.release()` →
`tui.reader.releaseReplyTail()` 是上一个提交（`8b1d732`，W-1 收尾）做的：同一个操作，拥有者搬了家。

---

## 0.8.4 P-1 · 探针 6c 的绘制归属（2026-10-14）

> 目标：让 6c 的绘制归属判定**稳定**（不再随机变红），同时**不削弱**它——不修 G 系列、不动 runtime、
> 不放宽断言、不加 retry/skip/无条件 sleep。旧断言在 `c654153` 的 `test (0.1.7-rc.1)` 上随机变红，
> 而那条腿的测试套件是 `fail 0`。

**根因**：6c 在固定的 500ms 窗口里统计窗口内**全部** `ESC[<row>;1H`，于是把三件不同的事混成一个数字：

1. 方向键引起的**层重绘**（应当发生）；
2. 绘制器**故意整块重画**的 chrome —— `src/paint.ts` 的
   `if (current === prev[index] && !(chromeChanged && index >= dirtyChromeStart)) continue`：
   `chromeChanged` 的帧会重画 chrome 块里**没变**的行（"半个输入框比晚一帧更糟"）；
3. **独立**的后台更新（第 1 行身份行的模式/路由标签）恰好落进同一窗口。

用 `scripts/paint-attribution.mjs` 按 pty chunk 逐块归属后，红灯窗口的真实结构是
「一块只重画第 1 行的 chrome 帧」+「一块 `sync` 的层帧（行 30,29,25,24）」——层帧本身完全正常。

**旧规则还太松**：它的判据是"每一行 ≥ 5"，所以一次**从第 5 行开始**的 transcript 重绘会被放行——而那
正是这条断言存在的理由。两条都在 `tests/paint-attribution.test.mjs` 里做成了可执行的对照：
`the old rule rejected an identity tick…`（旧红新绿）与 `the old rule accepted a transcript repaint…`
（旧绿新红）。

**新判定**（`judgeInteractionWindow`，六项检查各自报名字，见 AD-20 §11）：

| 检查 | 依据 |
|---|---|
| `composer` | 输入框上沿（`╭` 行）在屏上，chrome 块才定位得到 |
| `move` | `●`/`○` 在两条选项行之间真的换了位 |
| `repaint` | 确实有帧重画了层 |
| `scope` | **没有帧重画它没有改变的行**（chrome 块除外）——不涉及任何行号阈值 |
| `transcript` | 层上方没有整条带移动（独立 tick 允许 ≤2 行，写在 `transcriptTickBudget`） |
| `clear` | 窗口内没有 `2J`/`3J`/`H J`/擦除到行尾 |

**不依赖 pty chunk**：`term.onData` 的切分是 pty 的决定（ConPTY 还会把整帧压成换行批并改写行寻址）。
判定读的是绘制器写进字节里的界标：每帧的行批被 `ESC[?7l … ESC[?7h` 包住（>2 行时外面再套
`ESC[?2026h/l`），每行是 `ESC[<row>;1H ESC[0m ESC[2K <内容>`。`tests/paint-attribution.test.mjs`
有一条用例把同一段流按 7 字节步长切开重判，结论必须逐项相同。

**前置条件**：窗口从"回合已停"开始——探针等状态条不再报 `运行中/回复中/思考中/已等待`（有界 20s，
把结果打进日志），并且窗口边界取在这次等待**之后**，所以忙碌回合在等待期间的绘制不算在方向键头上。
等待层的卡片仍会 tick（一行），由 tick 预算覆盖。

**变体验证**（临时改 `src/tui.ts`、重建、跑完即恢复；`git diff` 事后为空）：

| # | 变异 | 结果 |
|---|---|---|
| M1 | 方向键不再移动高亮（`ownerSurface` 的 `moveQuestionCursor` 去掉） | ✗ 真机 6c 三条红（`must repaint the layer`、`move: … ● → ●`、`repaint: did not repaint the layer`）+ 在机测试 2 红 |
| M2 | 方向键让整屏重绘（`lastPaintRows = []`，无清屏） | ✗ `scope` 逐行点名 24 行未变却重画；旧的行数上限也同时红 |
| M3 | 方向键触发整屏清除（`forceFullPaint = true`） | ✗ `clear: ["\u001b[H\u001b[J"]` + `scope` + 旧的无清屏断言 |
| M4 | 独立 chrome tick 与方向键同窗 | ✓ 不误判：单测用真实 `composePaintFrame` 造出"第 1 行变了 + 层帧"的同窗，在机测试用 wait card 时钟做同样的对照，两者都绿 |

**ConPTY 的证据边界**：Windows 腿拿不到行寻址，6c 在那里只断言仍可读的一半（高亮移动、无清屏），
探针日志明确打印"frame attribution is not readable through ConPTY"，范围判定由
`tests/dialog-paint-scope.test.mjs` 在**组合帧**上补足（真实 `SshTui` + 显式 `paint()`，平台无关）。

**重复稳定性**（`.pf/stability.sh`，逐次记录；结论在每行末尾）：

| 路径 | 次数 | 结果 | 窗口形态 |
|---|---|---|---|
| **0.1.7-rc.1 真机全量探针**（`.pf/rc1` worktree，`scripts/ci-pin-line.mjs 0.1.7-rc.1` + 独立 home） | **20** | **20 PASS**（`dialog window: turn settled`） | 每次都 `frames=1 layer=1 painted=24,25,29,30 changed=24,25 chrome=27`——层帧只画了两条**变了**的选项行，另有 chrome 块两行（`paint.ts` 允许整块重画），**没有**任何越界帧、没有清屏、没有整带移动 |
| **W-2 当前实现**（窗口仪器，同一时间线只跑 6c） | 20 | 旧判据 0 红 / 新模型 0 红 | `unjustified=2`（就是 chrome 块那两行）、`clears=0`、非层帧 0 |
| **W-1 基线 `b03de16`**（同一仪器，`link:` 指向 `.pf/w1`） | 20 | 旧判据 0 红 / 新模型 0 红 | 同上，逐字段相同 |

这 60 次里**没有一次**出现"额外 chrome 更新落进窗口"（`other=0`），所以稳定性本身是干净的；chrome tick 的
容忍度由 M4 的两条用例与 `c654153` 那次红灯的窗口形态（第 1 行单独一帧）钉住。旧判据在本轮的
0.1.7-rc.1 上同样 20/20 绿——**复现率本来就低**（W-2 轮记录：全量探针 1/11、只跑 6c 1/13），因此
"这次没红"不能当证据：**证据是判定模型本身**（规则对照做成用例、M1–M3 会红、chunk 切分不变性）。

**门**：`npm test` **1442 项 · 1435 通过 · 0 失败 · 4 跳过 · 3 todo**（新增 14 条归属用例 + 3 条在机用例）·
`typecheck` 0 · `npm run freeze` 全绿（PTY 事实新增 `dialog-scope` 一行）· `npm run freeze:input` 无超基线
（G-1/G-2/G-8/G-3 仍是 3 条 todo）· `npm run bench` 字节/行数/清屏与基线逐项相同（501/465/2457/588/140、
3/3/17/4/1、0 清屏）· 真机探针（setup 含 resume 阶段 + 主探针）全过。

**修改的文件**（runtime 一行未动，`git diff --stat src/` 为空）：

| 件 | 内容 |
|---|---|
| `scripts/paint-attribution.mjs` | 新增：帧解析（产品界标）+ 逐行变更归属 + `judgeInteractionWindow` 六检查 |
| `scripts/tui-probe.mjs` | 6c：`settled` 前置条件、窗口边界、六项命名断言、ConPTY 边界说明；保留原有行数上限与无清屏断言 |
| `tests/paint-attribution.test.mjs` | 14 条：帧解析、chunk 切分不变性、chrome 块豁免、M1/M2a/M2b/M3/M4 形状、旧规则对照 |
| `tests/dialog-paint-scope.test.mjs` | 3 条在机用例（真实 `SshTui` + `paint()`）：方向键只画层、独立 tick 不误判、整屏重绘被抓 |
| `scripts/b2-freeze-audit.mjs` | PTY 事实新增 `dialog-scope` |
| `docs/decisions/input-ownership.md` §11、本文件 | 判定模型与复核过程 |

**剩余风险**：

1. **6d（菜单高亮）仍是同类的行号规则**（`every row >= 3`）：它同源、同弱点，本轮没红过所以没动它。
   它的选项标签不同，需要自己的 fixture 与对照；记为下一步的小项，不藏在 P-1 里一起改。
2. **ConPTY 无法归属帧**：Windows 腿只断言"高亮移动 + 无清屏"，范围由在机用例补足（日志明说边界）。
3. **回合未停**（`dialog window: turn still busy after 20s`）时，`transcript` 检查可能报"移动"——日志会写明
   原因；本轮 60 次里没有出现。
4. 判定依赖 `╭`（输入框上沿）与选项标签文本：它们变了下标就要跟着改，但那时 `composer` 检查会直接
   报"定位不到 chrome 块"，不会静默放过。
**CI**：run `38522822510`（commit `b4a1e47`）**5/5 全绿**——`test (0.1.7-rc.1)`、`test (0.1.7-rc.2)`、
`test (0.2.0-rc.1)`、`test (0.2.0-rc.2)`、`test-windows`。上一轮红过的那条腿这次给出
`tests 1442 · pass 1436 · fail 0`、`dialog window: turn settled`、
`dialog scope: frames=1 layer=1 painted=24,25,29,30 changed=24,25 chrome=27`——与本机 20 次逐字相同。

---

## 0.8.4 W-3a · 一次 read 里的多个输入事件（2026-10-14）

> 目标：修 **G-1**（合并的翻页/方向键被整段吞掉）、**G-2/G-8**（改绑键合并时绑定失效）、
> **G-3**（Alt 和弦与后一字符同 read：和弦丢失、字符当文本泄漏）。不动 W-3b 的条目。

**G-3 语义审查（先审查，后实施）**：两个 read `ESC 1` + `x` 与一个 read `ESC 1 x` 必须产生**相同**的
事件消费结果。实测三个落点（修复后）：composer 里和弦执行、`x` 落在光标处（`我打了x一半的消息`，
**不是** `1x`）；无字段 Surface 上和弦照跑、`x` 被 Surface **拒绝**（草稿原样——拒绝是 Owner 的决定，
不是 Reader 抹掉事件）；Screen 上 `x` 归 Screen。产品里已有的同类先例是 SS3 尾巴（`\x1bOAx` 一直
"序列 + 尾巴各自处理"），所以这条原则**不与其他契约冲突，无需裁决**；旧断言"丢弃后面的字符"确实被
改了——这是本轮授权的语义变更，记录在此而不是静默改绿。

**Reader 修改**（`src/input-reader.ts`）：新增 `read(text)`（唯一取帧入口：粘贴流量走既有标记/整段规则，
其余走 `units`）与 `units(text)`：

| 单元 | 规则 |
|---|---|
| 完整 CSI / SS3 | 一帧（`\x1b[5~\x1b[5~` = 两个 PgUp） |
| "还可能长大"的转义前缀 | **整段**一帧 → 交给既有的 60ms hold（`\x1b[<0;1` 因此仍被拼回鼠标报告，轨迹抓到了这一条） |
| Alt 和弦 | `ESC` + 一个可打印字符 = 一帧（`\x1b1`），后续字符另起 |
| 控制字节 / CR-LF | 各自一帧，CRLF 算一个 Enter |
| 连续可打印文本 | 一帧（`yes` 不会被拆成 `y`+`es`） |
| 无标记的换行粘贴 | 整段一帧（`looksLikePasteBurst` 优先，否则一次粘贴会变成一串 Enter） |

**Router / Owner 修改**（`src/tui.ts`）：`handleInputText` 变成"逐帧 `consumeFrame`"，每个单元刚好问一次
Router（keymap 因此按单键查表）；**删除** `screenKeys`（Screen 专用的第二份拆键器，W-3a 后由 Reader 统一）；
`handleScreenInput` / `ownerScreen` 的注释改成"一个单元进"。两条边界保留并测住：

- **Screen 拥有它收到的那次 read**：它关闭后同一 read 余下的单元**丢弃**（0.8.3 规则）。实现用
  `screenDismissals` 计数而不是再读一次 `this.screen`——`ownerReads.screen` 基线 25 不能涨。
- **Surface 相反**：答案后的单元继续按 Owner 判定（`yes-typed-at-dialog` 轨迹钉住）。

**G-1 / G-2+G-8 / G-3 红→绿**（W-2 构建上先证明红，`.pf/gaps-red.test.mjs` 去掉 todo 标记后跑）：

| 缺口 | 红（修复前） | 绿（修复后） |
|---|---|---|
| G-1 `\x1b[5~\x1b[5~` | ✖ 两键全丢（scroll 0） | ✔ scroll 24；PgDn×2 / ↑×2 / ↓×2 / 混合 / 三键 / 拆成多次 read 逐一同值 |
| G-2/G-8 `\x10\x10` | ✖ 无动作，且**掉进焦点环** `moveFocus(-1)`×2 | ✔ scroll 24、焦点不动；混文本 `ab\x10cd`、混默认键、suppressed 默认键同 read 全部同值 |
| G-3 `\x1b1x` | ✖ 输入变 `1x`、和弦丢失 | ✔ 和弦执行 + 只输入 `x`；Surface 上 `x` 被拒；`\x1b1\x1b[5~` 与两次 read 同值 |

**72 → 98 条参考轨迹**：只改 **4** 条（授权范围内，逐条 old→new 在 `GAP_FIXTURES` 与下表），新增 26 条
成对/安全用例，其余 **68 条逐字节一致**（更新脚本对未授权差异直接抛错）。

| fixture | 旧 | 新 |
|---|---|---|
| `arrow-left-right` (`\x1b[C\x1b[D`) | 当作未知转义**丢弃**（无调用） | `moveCursor(1)`、`moveCursor(-1)`（末态相同） |
| `pgup-twice-one-read` | scroll 0（两键全丢） | scroll 24 |
| `rebound-coalesced` | `moveFocus(-1)`×2、scroll 0 | scroll 24、无 `moveFocus` |
| `alt-1-batched` | `insertIntoField('1')`、`insertIntoField('x')`、input `1x` | `jumpToCategory('thinking')`、`insertIntoField('x')`、input `x`、echo「已跳到最新思考。」 |

**Input ownership matrix**：新增 8 条在机用例——合并 read 在 Screen 内**不得**碰到背后的 Composer；
Surface 上只到 Surface；括号粘贴即使内容是键字节也是文本；无标记粘贴不拆成 Enter；向导字段与草稿隔离；
以及"一个 read 与多次 read 同值"的成对断言（13 对）。

**Freeze before → after**（`npm run freeze:input`）：`knownGaps` **3 → 0**，`ownerReads.screen` **25 → 24**
（删掉 Screen 专用的拆键器顺带少一处 owner 读取），两处基线都**同步下调**（只收紧、不放大）；`ownerReads.dialog` 54 不变（新检查用计数而非再读 owner）；`rawBranches` 8、`mouseParsers` 1、
`routers` 1、`routerCallSites` 3 均不变；无新增白名单。移除 `screenKeys` 没有新增任何计数器。

**Mutation（全部实测红后恢复，`src/` 事后无差异）**：

| # | 变异 | 结果 |
|---|---|---|
| M1 | 不再切分完整 CSI/SS3（合并翻页键又被吞） | ✗ G-1 用例红 + 轨迹门红 |
| M2 | 控制字节折回整段（keymap 恢复整段查表） | ✗ G-2/G-8 用例红 + 轨迹门红 |
| M3 | Alt 和弦当普通文本 | ✗ G-3 三条红 + 轨迹门红 |
| M4 | 括号粘贴被拆成键盘事件 | ✗ 粘贴四条红（含"粘贴的 yes 不作答"）+ 轨迹门红 |
| M5 | Screen 关闭后同 read 余下单元继续投递 | ✗ "Screen 内合并 read 不穿透"红 |

**门**：`npm test` **1453 项 · 1449 通过 · 0 失败 · 4 跳过 · 0 todo** · `typecheck` 0 ·
`npm run freeze` 全绿 · `npm run freeze:input` 无超基线 · `npm run bench` 字节/行数/清屏与基线逐项相同 ·
四条真机探针（setup / main / drop / terminal）全过。

**本轮未做（W-3b 起）**：`SURFACE_COMPOSER_KEYS`、Ctrl+L 的两份实现、`composerUnit` 共用体拆分、
Completion/Search/Doctor、picker 自带 reader、计划卡默认折叠（已单独登记 `docs/plans/plan-card-fold.md`）。

**CI**：W-3a 提交 `f7e5849` 的 run `38537258218` **5/5 全绿**（`test (0.1.7-rc.1)`、`test (0.1.7-rc.2)`、
`test (0.2.0-rc.1)`、`test (0.2.0-rc.2)`、`test-windows`）；收紧基线后的提交 `80f9a23` 的 run
`38538601786` 同样 **5/5**。含 Windows 腿在内，`screenKeys` 删除、逐单元路由与五条变体都在真机腿上验过。

## 0.8.4 W-3a.1 · Screen read ownership 收口（2026-10-14）

> 目标：只验证并（必要时）修复一个边界——**同一个文本单元内部**关闭 Screen 之后继续投递字符的路径。
> 不重构 Reader/Router、不改默认 keymap、不动 30ms/60ms 持有窗口、不进 W-3b、不发版。

**结论：已复现**。真实 `handleData(Buffer)`，Report Screen 打开 + 非空草稿时输入
`\x1b[200~pasted\x1b[201~\x1bq`：粘贴**没有**进被隐藏的 Composer（正确），Esc 关闭了 Screen（正确），
但同一 read 的 `q` **进了** Composer 草稿——`我打了一半的消息`（cursor 3）→ `我打了q一半的消息`（cursor 4）。
红灯证据来自修复前的构建（46d09d9 工作树），四条路径逐条实测：

| 路径 | 修复前的读法 |
|---|---|
| Report Screen + 粘贴 + `\x1bq` | 轨迹 `… handleScreenInput('\x1b','cancel')`、**`insertIntoField('q')`**；草稿 `我打了q一半的消息` |
| Setup Screen + 同一 read | `pasteIntoScreen('pasted')`（进向导自己的字段）→ Esc 取消向导 → **`insertIntoField('q')`** 进 Composer 草稿 |
| `\x1bq` **在**粘贴标记之前 | **`insertIntoField('q')`** 进草稿；其后的粘贴已被帧间检查正确丢弃（无 `handlePasteText`） |
| 更长的尾巴 `\x1b[201~\x1bqhello` | **五个字符**全部落进草稿（`草qhello稿`） |

**事件链**：`isPasteTraffic` 为真 → `InputReader.frames()` 把标记之外的部分整段出成**一个** `literal` 帧
（`\x1bq`）→ `consumeFrame('literal')` → `handlePlainText()` **逐字符**循环 → `handleChar('\x1b')` →
Router 判为 Screen → `handleScreenInput` → `closeScreen()`（`screenDismissals++`）→ 同一循环的
`handleChar('q')` → Router 这次判为 Composer（Screen 已不在）→ `insertIntoField('q')`。
`handleInputText` 的 `screenDismissals` 检查只发生在**帧与帧之间**，而逐字符投递发生在**帧内**。
逐字符投递本身是必需的（Surface 答 `y`、后面 `es` 进 Composer 就靠它），所以缺的不是这条机制，
而是这条机制里的 Screen 检查。核对过 `handlePasteText` 是单次编辑、不再逐字符路由，因此这是**唯一**入口。

**最小修复**（`src/tui.ts`，+10 行，无接口变更）：在 `handlePlainText()` 进入投递循环时记下
`screenDismissals`，**每投递一个字符前**重新比较，Screen 在这次投递中被关闭就结束这次投递。
即把读取循环里那条规则原样下沉一层：没有第二个 Reader/Router、没有改 keymap、没有改持有窗口、
没有改 Surface 的尾部语义（`screenDismissals` 只随 **Screen** 关闭递增）。

**未复现的相邻路径（已加正向用例钉住，不是缺陷）**：帧间尾部（`\rq`、`\x03q`、`q\x1b[5~` 在 read 里
Screen 关闭后余下丢弃——W-3a 已修，本轮不能破坏）；标记内的 `\x1bq` 是**载荷**（`\x1b[200~a\x1bqb\x1b[201~`
草稿不动）；标记前的关闭使**整段粘贴**被丢弃；无 Screen 时同一条粘贴 read 的尾巴照常落进草稿
（`草pastedq稿`——守卫是 Screen 归属，不是"Escape 之后不输入"）；Surface 上 `y` 作答、`es` 进草稿。

**98 → 102 条参考轨迹**：W-3a 留下的 **98 条逐字节不变**（修复是边界收口，不是重新取帧；用
`git stash` 实测 46d09d9 为 **1454 项 · 1450 通过 · 4 跳过**，本轮 1460 项即 +6 条新用例）。
参考集新增 4 条**安全用例**（旧读法逐条记录在 `tests/input-reader.test.mjs` 的 `W3A1_FIXTURES`）：

| fixture | 旧（46d09d9） | 新 |
|---|---|---|
| `screen-paste-tail-escape` | `… handleScreenInput('\x1b','cancel')`、`insertIntoField('q')`；input `我打了q一半的消息` | `… handleScreenInput('\x1b','cancel')`**结束**；input `我打了一半的消息`、cursor 3 |
| `screen-escape-then-paste` | `handleScreenInput('\x1b','cancel')`、`insertIntoField('q')` | `handleScreenInput('\x1b','cancel')` 一条，`q` 与粘贴都不落地 |
| `wizard-paste-tail-escape` | `pasteIntoScreen('pasted')`、`handleSetupKey('\x1b','cancel')`、`insertIntoField('q')` | 同上但**没有** `insertIntoField`；向导字段拿到 `pasted`、Composer 草稿原样 |
| `surface-paste-tail-typing` | `handleDialogChar('y')`、`insertIntoField('e')`、`insertIntoField('s')` | **逐字节相同**——Surface 的尾部语义没被这次修复碰到 |

**新增用例**（`tests/input-ownership-regression.test.mjs` 5 条 + `tests/input-reader.test.mjs` 1 条 +
`tests/input-ownership-matrix.test.mjs` 的单元清单 2 项）：
帧内关闭（三种尾巴 `\x1bq` / `\x1bqhello` / `\x1bq\rx`）、标记前关闭、向导字段与草稿隔离、
普通 read 的帧间尾部仍丢弃 + 无 Screen 时尾巴照常输入、Surface 尾部仍进 Composer、上面那张轨迹表，
以及矩阵里"**Screen 背后的草稿不被任何单元改写**"这一条补上的两个单元
（`\x1b[200~pasted\x1b[201~\x1bq` 与 `\x1bq\x1b[200~pasted\x1b[201~`）——原来那份清单只有"单独的粘贴"，
没有"既结束 Screen 又带尾巴"的单元，这正是缺陷能躲过去的地方。

**Mutation（实测红后恢复，`src/` 事后与提交一致）**：

| # | 变异 | 结果 |
|---|---|---|
| M6 | 删掉守卫（穿透路径恢复） | ✗ 三条 W-3a.1 在机用例 + 矩阵"Screen 背后草稿"条 + 轨迹门 `every fixture frames identically` 红 |
| M7 | 守卫放在循环**之前**（检查了，但只检查一次） | ✗ 同上——位置错也红，说明测的是行为不是"有没有那行" |

**门**：`npm test` **1460 项 · 1456 通过 · 0 失败 · 4 跳过 · 0 todo** · `typecheck` 0 ·
`npm run freeze` 全绿 · `npm run freeze:input` 无超基线（`knownGaps` 0/0、`ownerReads.screen` 24/24、
`dialog` 54/54、`rawBranches` 8、`routers` 1、`routerCallSites` 3，**全部不变**，本轮没有新增计数器）·
`npm run bench` 字节 501/465/2457/588/140、行 3/3/17/4/1、清屏 0（与基线逐项相同）·
四条真机探针（setup / main / drop / terminal）全过。

**CI**：W-3a.1 提交 `f44b56c` 的 run `38545614393` **5/5 全绿**（`test (0.1.7-rc.1)`、`test (0.1.7-rc.2)`、
`test (0.2.0-rc.1)`、`test (0.2.0-rc.2)`、`test-windows`）——逐字符投递的守卫、四条新安全轨迹与五条在机
用例都在含 Windows 的真机腿上验过。收据与矩阵补充两个提交同样 5/5：`3e42e89` 的 run `38546335317`、
`735a2f9` 的 run `38548044940`（各含 `test-windows` 与四条 0.1.7/0.2.0 rc 腿）。

**本轮未做**：W-3b 全部条目与 W-7；版本仍为 `0.8.3`，未发 npm。

## 0.8.4 W-3b.1 · Surface 编辑键的输入归属收口（2026-10-14）

> 目标：只做 W-3b.1——Surface 打开时 `Home`/`End`/`Delete`/复制键的归属。不动 W-3b.2（Ctrl+L）与
> W-3b.3（`composerUnit` 拆分），不发版。

**审计矩阵（先审计，后修改；真实 `handleData(Buffer)`，草稿 `我打了一半的消息` cursor 3）**：

| Surface 形态 | `Home`/`End`（`ESC[H`/`ESC[1~`/`ESC[F`/`ESC[4~`） | `Delete`（`ESC[3~`） | `Ctrl+Shift+C`（`ESC[99;6u`） |
|---|---|---|---|
| confirm / approval（无字段） | owner=**Composer**，隐藏 `cursor` 3→0 / 3→8 | owner=**Composer**，草稿 `我打了一半的消息`→`我打了半的消息` | owner=Composer，**无操作**（`copyKey` 在 dialog 下直接拒绝） |
| 自由文本 question（borrowedText） | owner=**Composer**，改**隐藏** `cursor`；可见字段停在 `ab\|2` | owner=Composer，`deleteAtCursor()` **field-aware** → 编辑可见字段（本身正确） | 无操作 |
| 有选项 question（无过滤） | 隐藏 `cursor` 移动 | 草稿被删一字符 | 无操作 |
| 过滤中的 question（`/` 进入） | 隐藏 `cursor` 移动 | 草稿被删一字符 | 无操作 |

三者**不可归为一类**：Home/End 是**绕过** `fieldText/fieldCursor/setField` 的直接写（`this.cursor = 0`、
`this.input.length`）；Delete 用的 `deleteAtCursor()` 本来就是 field-aware，只是无字段时落回草稿；
复制键**已经**是拒绝语义。过滤形态**没有**过滤光标模型（只有 append/backspace），按合同不新增过滤编辑。
picker 走 `src/picker.ts` 自带 decoder/reader，不经过 `handleData`（W-7 债，本轮不动）。

**修复**（`src/input-router.ts` −10/+8、`src/tui.ts` +26/−4）：

- Router：删除 `SURFACE_COMPOSER_KEYS` 与那条分支——Surface 拥有**全部**单元；记录在案的例外只剩
  Ctrl+L 一条（W-3b.2）。`surfaceHasField` 保留在快照里但已无规则依赖它（注释写明）。
- `ownerSurface`：`Home`/`End` → `moveFieldCursor('start'|'end')`；`Delete` →
  `if (this.textIsEditable()) this.deleteAtCursor()`；复制键随其余序列被丢弃（与既有可观察行为一致）。
- 新增 `moveFieldCursor(target)`：走 `fieldText()`/`setField()`，与 Ctrl+A/Ctrl+E 同一条路；`ownerComposer`
  的 Home/End 也改用它（无层叠时 `fieldText()` 就是草稿，逐字节不变），于是"Composer 只在真正拥有
  Composer 时用这些键"从约定变成结构。

**红 → 绿**：先写用例并实测红（`tests/input-ownership-regression.test.mjs` 5 条红、
`tests/input-ownership-matrix.test.mjs` 2 条红、`tests/input-router.test.mjs` 1 条红），修复后全绿。
新增用例：无字段 Surface 五种键 × 四种形态全部丢弃（草稿/光标/历史/滚动/焦点/行数逐项不变）、
借用字段的 Home/End/Delete **编辑可见字段**（`ab|2` → Home → `ab|0` → Delete → `b|0` → End → `b|1`）、
`ESC[1~`/`ESC[4~` 别名、复制键在四种 Surface 形态下都无操作而 **Screen 的复制合同不变**、
混合 read（`\x1b[3~x` 等五种）不穿透、回答/拒绝后草稿与光标原样回来、`\x1b[3~yes` 的
"Delete 被丢弃 + `y` 作答 + `es` 进草稿"、以及矩阵与层 A 的归属断言。

**参考轨迹 102 → 106**：两条**授权变更**（旧读法逐条留在 `tests/input-reader.test.mjs` 的 `W3B1_FIXTURES`
与下表），四条**新增安全用例**，其余 **100 条逐字节不变**（更新脚本对未授权差异直接抛错）。

| fixture | 旧（ed38c20） | 新 |
|---|---|---|
| `dialog-home-end` | 末态 `cursor` **8**（隐藏草稿光标被 Home/End 移到末尾） | `cursor` **3**（不动） |
| `dialog-delete` | 轨迹含 **`deleteAtCursor`**，input `我打了半的消息` | 无 `deleteAtCursor`，input `我打了一半的消息` |
| `surface-edit-keys-no-field`（新） | 旧构建：`deleteAtCursor` + `copyKey`，草稿被删、cursor 8 | 无任何消费者调用，草稿与光标原样 |
| `surface-field-home-delete`（新，`record: ['borrowed']`） | 旧构建：`borrowed {ab,2}`（Home/Delete 对可见字段无效） | `borrowed {b,1}`（Home→0、Delete 删 `a`、End→末尾） |
| `surface-filter-edit-keys`（新） | 旧构建：`deleteAtCursor`，草稿 `打了一半的消息` | 无 `deleteAtCursor`，草稿原样、过滤串不动 |
| `surface-edit-then-answer`（新） | 旧构建：`我打了es半的消息`（Delete 吃掉一个字符） | `我打了es一半的消息`（Delete 被丢弃、尾部仍进草稿） |

轨迹状态里的 `borrowed` 是**逐 fixture 可选**的记录项（`record: ['borrowed']`）：只有新用例打开它，
其余 102 条状态键一字未动——否则就等于整体重录参考。

**Mutation（全部实测红后恢复，`src/` 事后与提交一致）**：

| # | 变异 | 结果 |
|---|---|---|
| M1 | Home/End 又直接写隐藏 `this.cursor` | ✗ 借用字段用例 3 条 + 矩阵用例 + 轨迹门 |
| M2 | 无字段 Surface 的 Delete 又编辑隐藏草稿 | ✗ 4 条用例（含 interaction-surface 的键表）+ 轨迹门 |
| M3 | Router 恢复 `SURFACE_COMPOSER_KEYS`（Surface 事件又给 Composer） | ✗ 层 A + 矩阵 2 条 + 回归 4 条 + interaction-surface + 轨迹门 |
| M4 | 借用字段的合法编辑被丢弃（整块字段键删除） | ✗ 借用字段用例 + 混合 read + 轨迹门 |
| M5 | Screen 关闭后同 read 继续投递 | ✗ 矩阵"Screen 背后草稿"条 + W-3a/W-3a.1 三条 + 轨迹门 |

**门**：`npm test` **1469 项 · 1465 通过 · 0 失败 · 4 跳过 · 0 todo**（基线 1460 · 1456，+9 = 本轮新增
用例）· `typecheck` 0 · `npm run freeze` 全绿 · `npm run freeze:input` 无超基线且**全部不变**
（`knownGaps` 0/0、`ownerReads.screen` 24/24、`dialog` 54/54、`rawBranches` 8、`routers` 1、
`routerCallSites` 3；本轮没有新增计数器、也没有放宽基线）· `npm run bench` 字节 501/465/2457/588/140、
行 3/3/17/4/1、清屏 0（与基线逐项相同）· 四条真机探针（main / setup / drop / terminal）全过。

**CI**：W-3b.1 提交 `5ad6290` 的 run `38588615683` **5/5 全绿**（`test (0.1.7-rc.1)`、`test (0.1.7-rc.2)`、
`test (0.2.0-rc.1)`、`test (0.2.0-rc.2)`、`test-windows`）——引用字段的编辑、四个 Surface 形态的丢弃语义与
100 条未变轨迹都在含 Windows 的真机腿上验过。

**本轮未做**：W-3b.2（Ctrl+L 两份实现）、W-3b.3（`composerUnit` 拆分）、Surface 内左右箭头编辑借用字段
（范围外，现状丢弃）、picker 自带 reader（W-7）。版本仍为 `0.8.3`，未发 npm。

## 0.8.4 W-3b.1a · 借用字段的终端光标（2026-10-14）

> 目标：W-3b.1 的定向验收收口——**读者看得见的那一行拥有文本，就必须拥有终端实际光标**。
> 不动 Ctrl+L、不拆 `composerUnit`、不加 Surface 左右箭头、不发版。

**Preflight**：HEAD `e288ae989beccec74c6fe46790d0d24459e8f4c6`，工作树干净，version `0.8.3`，
`1469 · 1465 · 0 · 4 · 0`，参考轨迹 106，CI `38589629248` 5/5——与 brief 完全一致。

**红灯复现（真实终端，`@xterm/headless` 渲染器跑真实帧）**：草稿 `我打了一半的消息`@3，自由文本
Surface 输入 `ab` 后：

| 操作 | 终端光标 | 应在 | 判定 |
|---|---|---|---|
| 输入 `ab`（借用字段 `ab`@2） | (4,15) | 4（`> ab` 之后） | ok（巧合：行文本恰好结束在正确位置） |
| **Home**（`ab`@0） | (4,15) | **2**（`> \|ab`） | **BAD** |
| Home→End（`ab`@2） | (4,15) | 4 | ok（同样的巧合） |
| **Home→Delete**（`b`@0） | (3,15) | **2**（`> \|b`） | **BAD** |
| End→`x`（`abx`@3） | (5,15) | 5 | ok（巧合） |
| 24 列窄屏 + 长草稿，Home | (4,15) | **2** | **BAD** |
| 无 Surface，Home（草稿@0） | (2,15) | 2 | ok ✓ |

**根因**：`src/tui.ts` 的输入行绘制里，`fieldText`/`fieldCursor`/`fieldFolded` 都取自
`fieldText()`/`fieldCursor()`（正确），`inputView` 也用它们（正确），但**未折叠**分支算终端位置时写的是
`cursorVisualPosition(inputView.text, this.cursor, inputTextWidth)`——`this.cursor` 是**隐藏 Composer 草稿**
的光标。有借用字段时两者是不同的数（例：`borrowedText.cursor = 0`、`this.cursor = 3`）。折叠分支与
masked 分支用的是 `inputView.cursorOffset`（来自 `fieldCursor`），本来就正确；`masked` 恒为 false。
终端在这里画 IME 预编辑，所以错的位置不只是"看着别扭"：后续输入与预编辑会出现在草稿的偏移上。

**最小修复**（1 行 + 注释）：

```ts
- const pos = cursorVisualPosition(inputView.text, this.cursor, inputTextWidth)
+ const pos = cursorVisualPosition(inputView.text, fieldCursor, inputTextWidth)
```

没有触及 Router / Reader / Surface ownership / `term-text.ts` 宽度算法 / `paint.ts` 结构；没有引入
新的字段状态模型。**纯光标移动的帧本身会被发出**（`\x1b[?25l\x1b[R;CH\x1b[?25h`），所以不需要额外
的"仅光标变化"帧修复；核实过 `composePaintFrame` 会在每一行之后把光标送回 caret 行。

**新增测试** `tests/borrowed-field-caret.test.mjs`（8 条，全部走真实 `handleData` → 真实 `paint()` →
真实终端网格，断言 `term.cursor()`；期望值由 `displayWidth` + `cursorVisualPosition`/`foldInputView`
契约推出，ASCII 用例另有手算值）：借用字段矩阵（输入/Home/End/Home→Delete/End→`x`）、`ESC[1~`/`ESC[4~`、
Unicode 与宽度矩阵（ASCII / 中文 / emoji / 组合字符 / 换行 / 窄屏跨行 / 恰好占满一行 / 刚过一行）、
"草稿光标再深也不能带动借用字段的光标"、Composer 等价矩阵（Home/End/Ctrl+A/Ctrl+E/Delete/Backspace/
输入）、折叠与多行、Surface 生命周期（回答/取消后光标回到草稿；下一个 Surface 不继承）。

**Composer 逐字节等价**（`.pf/w3b1a-frames.mjs`，同一脚本对修复前 `e288ae9` 与修复后各跑一次，
逐帧比较）：**40 帧里 33 帧逐字节相同，其中 13 个 Composer 场景全部逐字节相同**；7 帧（全部是借用字段）
不同，且**把光标定位 `CSI r;cH` 归一化后差异为 0**——差异只是光标位置：

| 帧 | 旧 | 新 |
|---|---|---|
| `borrowed: Home` | `\x1b[14;5H` | `\x1b[14;3H`（`> \|ab`） |
| `borrowed: Home then Delete`（Delete 后） | `\x1b[14;4H` | `\x1b[14;3H`（`> \|b`） |
| `borrowed: wrapped field`（36 字符粘贴后） | `\x1b[14;6H` | `\x1b[14;39H`（字段真正末尾） |
| `borrowed: long draft Home` | `\x1b[14;5H` | `\x1b[14;3H` |

**参考轨迹：106/106 原样保留**（修复在绘制层，InputFrame/Router/Owner 调用/字段状态/粘贴/Screen
dismissal/Surface 尾部语义都不经过这里；`fieldCursor()` 在无借用字段时恒等于 `this.cursor`）。

**Mutation（实测红后恢复，`src/` 事后与提交一致）**：

| # | 变异 | 结果 |
|---|---|---|
| M1 | 绘制位置恢复用 `this.cursor` | **RED** — 借用字段 5 条（`> \|ab`、`ESC[1~`、mid-field、深草稿、生命周期） |
| M2 | 借用字段 cursor 正确，但定位固定在字段末尾 | **RED** — 8 条全红（含 Composer 等价矩阵） |
| M3 | 修复顺手写隐藏 Composer cursor 让数字对上 | **RED** — 4 条（"草稿光标未被触碰"类断言） |
| M4 | 光标固定放在第一显示行（窄屏跨行错误） | **RED** — 2 条（恰好占满一行 / 多行草稿） |

**门**：`npm test` **1477 项 · 1473 通过 · 0 失败 · 4 跳过 · 0 todo**（+8 = 本轮新用例）· `typecheck` 0 ·
`npm run freeze` 全绿 · `npm run freeze:input` 无超基线（全部计数与 W-3b.1 相同：`knownGaps` 0/0、
`ownerReads` 24/54、`rawBranches` 8、`routers` 1、`routerCallSites` 3）· `npm run bench` 字节
501/465/2457/588/140、行 3/3/17/4/1、清屏 0（与基线逐项相同）· 四条真机探针（main / setup / drop /
terminal）全过。

**本轮发现、未修（需单独授权）**：**输入一个星光平面字符（emoji）会让进程栈溢出**——
`composerUnit` 用 `unit.length > 1` 判断"这是多字符文本"，而一个 emoji 的 UTF-16 长度就是 2，于是
`composerUnit('🚀')` → `handlePlainText('🚀')` → `handleChar('🚀')` → `dispatch` → `ownerSurface`/
`ownerComposer` → `composerUnit('🚀')` 无限递归。**这是既有缺陷**：在 W-3b.1 之前的构建（`ed38c20`）上
同样复现，且**在裸 Composer 上也复现**（不是 Surface 特有）；按码点计数的单行修复即可，但它属于输入
路径而不是绘制光标，本轮按"不得扩大范围"只记录不修。本轮的 emoji 覆盖走**粘贴**路径（完整真实路径，
已绿）。ConPTY 的能力边界同前：帧字节层面的断言在进程内完成，真机腿只覆盖"能渲染、不报错"。

**CI**：W-3b.1a 提交 `fd3f638` 的 run `38595871434` **5/5 全绿**（`test (0.1.7-rc.1)`、`test (0.1.7-rc.2)`、
`test (0.2.0-rc.1)`、`test (0.2.0-rc.2)`、`test-windows`）——含 Windows 腿。帧字节层面的断言在进程内完成
（`@xterm/headless` 网格），真机腿覆盖的是"能渲染、不报错、光标可用"；ConPTY 会重写行寻址，所以**不声称**
原始字节已完整覆盖 ConPTY 的光标行为。

**本轮未做**：W-3b.2、W-3b.3、Surface 左右箭头、过滤字段模型、picker Reader；版本仍 `0.8.3`，未发 npm。

## 0.8.4 W-3b.1b · Unicode 标量输入安全（2026-10-14）

> 目标：Release Blocker 定向修复——直接输入一个 Unicode 非 BMP 字符（`🚀`、`𠮷`）不得崩溃。
> 不进入 W-3b.2/W-3b.3，不发版。

**Preflight**：HEAD `3edf737a0576cfbcad9dfde80c9b219cb3ab6910`，工作树干净，version `0.8.3`，
`1477 · 1473 · 0 · 4 · 0`，参考轨迹 106，`knownGaps` 0，InputRouter 1，CI `38596866193` 5/5——与 brief 一致。

**历史归因（隔离 worktree，未改动任何历史版本）**：

| 构建 | 裸 Composer `🚀` | 借用字段 `🚀` | confirm `🚀` | Report Screen | Setup Screen |
|---|---|---|---|---|---|
| `v0.8.3`（`8483538`） | ✔ `"🚀"@2` | ✔ | ✔ 不作答 | ✔ | ✔ |
| W-1（`b03de16`） | ✔ | ✔ | ✔ | ✔ | ✔ |
| W-2（`c654153`） | ✖ **RangeError** | ✖ **RangeError** | ✖ **RangeError** | ✔ | ✔ |
| 当前（`3edf737`） | ✖ **RangeError** | ✖ **RangeError** | ✖ **RangeError** | ✔ | ✔ |

与 brief 的假设一致：**W-2 首次引入**（`composerUnit` 的 `unit.length > 1`），`v0.8.3`/W-1 正常。
Screen 一直安全——Router 第一步就把单元交给 Screen，永远走不到 `composerUnit`。

**递归链（取自抛出的错误自身的 stack）**：

```
composerUnit('🚀') → handlePlainText('🚀') → handleChar('🚀') → dispatch → InputRouter.route
  → ownerComposer/ownerSurface → composerUnit('🚀') → … （无限；W-2 上同一链，只是还没有独立 Router 模块）
```

`.length` 是 2（UTF-16 code unit），`for...of` 只迭代一次（code point），于是"多字符"分支把同一个码点
无限次送回自己。`🚀` 以**两个 read** 的字节分片送入也一样命中（Reader 先正确拼回码点，然后递归）。

**修复 1（本轮主修）**：`composerUnit` 改按 **code point** 判定。新增模块级
`carriesMultipleCodePoints(unit)`：`unit.length <= 1` 直接 false；否则用 `codePointAt(0)` 判断首个码点占
1 还是 2 个 code unit，再比较剩余长度——**零分配**（ASCII 热路径与 `length > 1` 等价）。单个 BMP/非 BMP
码点落进原有 switch/尾部分支（插入），多码点仍走 `handlePlainText` 逐码点拆分。**多字符分支保留**：
confirm 上 `yes` 的首个 `y` 作答、剩余 `es` 仍逐字符重新判定 Owner。

**修复 2（同一根因类的第二处，本轮一并修）**：`graphemeBefore`/`graphemeAfter` 原来对 `this.input`（隐藏
草稿）分段，而 `backspace`/`deleteAtCursor` 编辑的是 `fieldText()`（借用字段）——range 来自**另一个字符串**。
改为切分 `this.fieldText()`。**这是既有缺陷**：`v0.8.3` 上已复现（`a🚀` + Backspace → `a\uD83D`@2，留下
半个代理对、光标停在代理对内部），只是 emoji 递归挡住才没被发现；ASCII 场景下两个字符串的偏移常常巧合相同
（W-3b.1 的用例因此没抓到）。修后借用字段的 Backspace/Delete 与 Composer 走同一套 grapheme 规则。

**矩阵与证据**：`tests/unicode-input-safety.test.mjs`（12 条，全部真实 `handleData(Buffer)` → Reader →
Router → Owner；递归用包装器量化为**深度**，红的时候报
`handleChar re-entered itself 9 deep for "🚀": one code point is not a run of text` 而不是栈溢出）：

- **Composer**：`🚀`/`𠮷`/`𝄞`/`a🚀b`/`🚀🚀`/`🚀a`/`a𠮷`/`你好`/`hello`——不抛异常、文本完整不重复、
  cursor 等于 UTF-16 offset、无 U+FFFD、不提交、不推行、不动历史/滚动/焦点/echo；投递深度 ≤ 4、
  `composerUnit` 进入次数 ≤ 1 + 码点数；混杂脚本长串（`ASCII 中文 🚀𠮷 𝄞 e\u0301 👩💻 done`）逐码点精确；
- **借用字段**：`🚀`/`𠮷`/`a🚀b` 进 `borrowedText`，隐藏草稿与光标不动；Backspace/Delete 按**它自己的**
  grapheme 规则删除（`a🚀` → `a`、`🚀🚀` → `🚀`、`👩💻`/`🇨🇳`/`e\u0301`/`👍🏽` 各删一个 grapheme），
  插入中段（`a🚀b` → Home → `𠮷` → Backspace 回到原样）不留半个代理对、不留 U+FFFD；
- **拒绝方**：confirm + `🚀`（不崩溃、不作答、草稿不动）、Report Screen + `🚀`（不穿透）、
  **向导自己的字段** + `🚀`（字符落在向导字段里，草稿不动）——确认它没有独立路径绕过本次修复；
- **UTF-8 分片**：`Buffer.from('🚀','utf8')` 在 1/2/3 处切开分两次送入 → 无半字符、无替代字符、终态与整读
  **逐字段相同**；`a🚀b` 一读 vs 三读 vs 字节切片（在 emoji 中间切）三者终态相同；30ms/60ms 窗口未动；
- **粘贴 vs 键入**：Composer 与借用字段上，三种文本的粘贴/键入终态一致；confirm 上粘贴 `yes` 不作答、
  键入 `yes` 仍逐字符作答（`我打了es一半的消息`@5）；Screen 拒绝非 BMP 且 W-3a.1 的尾部丢弃仍生效。

**参考轨迹 106 → 109**：**0 条改写**（更新脚本 `CHANGED = []`，任何非新增差异直接抛错），新增 3 条
Unicode fixture；旧构建上三条都抛 `RangeError`，读法记在 `W3B1B_FIXTURES`：

| fixture | 旧（`3edf737`） | 新 |
|---|---|---|
| `unicode-astral-typing`（`a🚀b`） | RangeError | `insertIntoField('a')`、`insertIntoField('🚀')`、`insertIntoField('b')`；input `我打了a🚀b一半的消息`@7 |
| `unicode-astral-split-bytes`（`🚀` 两片字节） | RangeError | 一个 `handleInputText('🚀')` + 一次 `insertIntoField('🚀')`；input `我打了🚀一半的消息`@5 |
| `unicode-astral-borrowed`（`a🚀b`，`record: ['borrowed']`） | RangeError | 三次 `handleDialogChar`+`insertIntoField`；`borrowed {a🚀b,4}`、草稿 `我打了一半的消息`@3 |

**等价性证据**：同一脚本对修复前后（`3edf737` worktree）各跑 40 个场景的**真实帧字节**，
**40/40 逐字节相同**——包括全部 Composer、借用字段、折叠、历史召回、粘贴场景。唯一变化的行为是原本抛
`RangeError` 的那一个：现在正常输入并绘制（`🚀`@2，caret 落在 `\x1b[14;5H`，宽字符两格）。

**Mutation（全部实测红后恢复，`src/` 事后与提交一致）**：

| # | 变异 | 结果 |
|---|---|---|
| M1 | 恢复 `unit.length > 1` | **RED** — 10 条 Unicode 用例 + 轨迹门 |
| M2 | 非 BMP 字符直接丢弃以规避递归 | **RED** — 9 条（文本完整性）+ 轨迹门 |
| M3 | 多字符当块插入（不再逐码点重新判定 Owner） | **RED** — `yes` 语义 2 条 + 轨迹门 + W-3a/W-3a.1/W-3b.1 尾部 6 条 |
| M4 | Reader 逐 read 解码（分片产生替代字符） | **RED** — 分片等价用例 + 轨迹门 |
| M5 | 插入落到隐藏草稿而非借用字段 | **RED** — Ownership 4 条 + 轨迹门 + 借用字段光标 6 条 |

**门**：`npm test` **1490 项 · 1486 通过 · 0 失败 · 4 跳过 · 0 todo**（基线 1477 · 1473，+13 = 12 条新用例
+ 1 条轨迹断言）· `typecheck` 0 · `npm run freeze` 全绿 · `npm run freeze:input` 无超基线且计数全不变
（`knownGaps` 0/0、`ownerReads` 24/54、`rawBranches` 8、`routers` 1、`routerCallSites` 3）· `npm run bench`
**字节 501/465/2457/588/140、行 3/3/17/4/1、清屏 0**——与 W-3b.1a 基线逐项相同 · 四条真机探针
（main / setup / drop / terminal）全过 · 默认 keymap、peer 范围与配置均未改动（`git diff` 只含
`src/tui.ts` 与测试/文档）。

**CI**：W-3b.1b 提交 `d0db720` 的 run `38685247496` **5/5 全绿**（`test (0.1.7-rc.1)`、`test (0.1.7-rc.2)`、
`test (0.2.0-rc.1)`、`test (0.2.0-rc.2)`、`test-windows`）。`tests/unicode-input-safety.test.mjs` 是纯进程内
node 测试（不依赖 pty），因此**在 Windows 腿上同样执行**——非 BMP 输入、UTF-8 分片与借用字段 grapheme 编辑
都在 ConPTY 那一侧跑过；真机腿覆盖的是"能启动、能渲染、不报错"，光标/帧字节层面的断言仍以进程内网格为准。

**剩余风险**：Surface 内左右箭头仍被丢弃（与 Home/End 已支持不一致，范围外）；过滤串没有光标模型；
picker 仍走自带 reader（W-7）；ConPTY 会重写行寻址，帧字节层面的断言只在进程内成立。

> **补充（W-3b.3c · R4）**："过滤串没有光标模型"之外还有一条既有限制：picker 的过滤框**丢弃非 BMP 字符**
> （`handleDialogChar` 的过滤分支以 `text.length === 1` 判单字符，而 `'🚀'.length === 2`）。不是所有权问题、
> 不是 RC blocker，修复属"过滤字段模型"；准确记录见 AD-20 §19.4，矩阵实测格为
> filtering picker + `🚀` → 无状态变化。

---

## 0.8.4 W-3b.2 / W-3b.2a · Ctrl+L 重绘归属：只读审核 → KEEP_DUAL 收口（2026-10-14）

> 目标：审核 `Ctrl+L` 在 Screen / Surface / Composer 三种场景下的所有权与完整重绘语义，把结论冻结成合同与
> 证据。**运行时一行未改**（决策与测试除外）；不进入 W-3b.3，不发版。
> 本节的"审核"部分对应 W-3b.2，"修复 + 证据"部分对应 W-3b.2a。

**Preflight**：HEAD `5ee20da58d7f565ba2e0c8250d446438f23aa61c`，version `0.8.3`（42 tag），参考轨迹 **109**，
`knownGaps` 0，InputRouter 1，CI `38685747657` **5/5**（`test-windows` + 四条 rc 腿）——与 brief 一致。

**漂移一处，按维护者确认的 A 方案处理**：工作树里带着上一轮**授权暂存**的 `/copy` 提示修复（4 个文件）。
先以独立提交落地再开始本轮收口——`915578f`「an acknowledgement is the last row, wherever it fits」，
`npm test` 因此从 1490·1486 变 **1492·1488**（+2 条回执行号用例）；本轮自身的所有验收数字都建立在它之上。

### 审核（只读）

三条链在 `src/` 只有三个落点：`input-router.ts:90`（Surface 时的例外）、`tui.ts:12344`（Screen 的
`screenNeedsFullPaint` + `markDirty()`）、`tui.ts:12847`（共享执行体的 `case '\x0c'` → `repaintNow()`）。

| 结论 | 依据 |
|---|---|
| **不是两份重绘实现** | 帧合成器只有 `composePaintFrame`；"下一帧整屏"只有 `forceFullPaint` 一条通道（`paintScreen:5101`、`paintFrame:6904` 各消费一次，17 个设置点）。两条 `Ctrl+L` 路径的差别是**两句前置** + 两个 painter 自己的策略 |
| **Surface 没有 painter** | 它的行由 `windowInteractionLines` 合成进工作区帧的 `paintRows`（`tui.ts:6797-6807`）——"重绘 Surface"物理上就是重绘工作区帧 |
| **例外只借道执行路径** | `case '\x0c'` 在 `composerUnit` 的 `dialog` 早返回（`12879`）**之前** `return`，`handleDialogChar` 不会被调用；写入集合只有 6 个绘制缓存 |
| **改判给 `surface` 行为等价** | `ownerSurface` 的兜底（`12739`）仍会走到同一行 `case '\x0c'`：标签级例外，不是行为差异 |
| **没有持续整屏清除的结构路径** | 两个 painter 都在帧尾恢复尺寸缓存（`5137-5138` / `6960-6961`），标志一次性（`5104-5105` / `6907`） |
| **两条真实差异** | 光标（Screen 隐藏且不发 `?25h` vs 工作区写回 field caret 并发 `?25h`）与时机（Screen 走 cadence 80–400 ms vs 工作区同步尝试立即绘制） |

**决策**（Independent Gate 采纳）：**KEEP_DUAL — DOCUMENT AND FREEZE**。保留两个 painter、继续共用
`composePaintFrame`；Router 归属一字未改，Surface 的例外**保留并明确记录**（不得描述为已消失）。
合同正本：`docs/decisions/input-router.md` §10；AD-20 侧：§4.3 优先级 2 的落地读法 + §1.6 表行 + §17 Status。
**未采纳**：B1（改判 Surface——行为等价但把义务搬进 W-3b.3）、B3（Screen 侧改用 `forceFullPaint`，可选后续）、
C（合并为单一 repaint 实现——两个 painter 有意不等价，且 ConPTY 腿看不到这类回归）。

### 证据：`tests/ctrl-l-repaint.test.mjs`（4 条，真实 `handleData(Buffer)` + 真实 `write()` 字节）

| 用例 | 场景 | 断言 |
|---|---|---|
| T1a 作曲家 | 非空草稿 + 非零 cursor | 恰好 **1 次 `ESC[H ESC[J`**；**1..24 行逐行寻址**（全帧重建）；指纹不变；caret 列由 `fieldText`/`fieldCursor` 独立推出且等于帧尾 `ESC[r;cH`；下一帧（键入 `x`）**0 清屏**且只重画部分行、含 caret 行 |
| T1b Surface（三种） | confirm（无字段）、question（借用字段）、picker（过滤态） | 归属仍是 `ownerComposer`（记录的例外）；**各 1 次清屏 + 全帧重建**；Surface 仍在画面上；草稿/光标/history/scroll/focus/borrowedText/dialog.cursor/dialog.filter/rows/yank **逐项不变**；下一帧 0 清屏且为增量 |
| T2a 调度边界 | Report Screen | 按键本身 **0 字节** + `dirty === true` → **真实 `startRenderTimer()` 的 cadence** 取走该帧（不等额外输入）→ 1 次清屏 + 全帧重建 |
| T2b 三种 Screen | report / setup / inspect | 各 1 次清屏 + 全帧重建 + Screen 内容回来；Screen offset / 向导字段 / 隐藏草稿不变；下一次真实局部更新 **0 清屏**且增量；退出 Screen 后 workspace 正确恢复（1 次重建 + 之后 0 清屏） |

**不强制两条路径字节相同**：Screen 帧 `hideCursor` 且不发 `?25h`，工作区帧发 caret + `?25h`——这正是
KEEP_DUAL 记录下来的有意差异。断言的是**清屏次数、寻址行集合、状态指纹、调度边界**。

**帧字节（100×24，实测）**：

| 场景 | Ctrl+L 帧 | 之后的真实变化帧 |
|---|---|---|
| T1 composer（草稿） | 3033 B · **清屏 1** · 寻址 **24/24 行** | 417 B · 清屏 0 · 3 行 |
| T1 confirm Surface | 3024 B · **清屏 1** · 24/24 | 281 B · 清屏 0 · 2 行 |
| T1 question（借用字段） | 2997 B · **清屏 1** · 24/24 | 422 B · 清屏 0 · 3 行 |
| T1 picker（过滤态） | 2999 B · **清屏 1** · 24/24 | 426 B · 清屏 0 · 3 行 |
| T2 report Screen | 按键 **0 B** → 节奏帧 2833 B · **清屏 1** · 24/24 | 2474 B · 清屏 0 · 21 行（翻页=正文带移动） |
| T2 setup Screen | 按键 **0 B** → 节奏帧 2842 B · **清屏 1** · 24/24 | 138 B · 清屏 0 · 1 行（向导字段一个字符） |
| T2 inspect Screen | 按键 **0 B** → 节奏帧 2790 B · **清屏 1** · 24/24 | 2434 B · 清屏 0 · 21 行 |

### Mutation（`.pf/mutations-ctrll.mjs`，逐条改源码 → build → 跑上面的用例 → 还原）

| # | 变异（针对对应执行路径） | 结果 |
|---|---|---|
| M1 | Screen 去掉 `markDirty()`（标志仍在、调度不再知道） | **RED** — T2a + T2b（**调度边界**用例是唯一能抓住它的那条） |
| M2 | 工作区去掉强制整屏机制（不再清尺寸缓存） | **RED** — T1a + T1b |
| M3 | 工作区帧尾不记录尺寸 → 以后每帧都清 | **RED** — T1a + T1b（增量恢复断言） |
| M4 | Screen 只置 dirty、不置整屏标志 | **RED** — T2a + T2b（清屏与全帧重建断言） |
| M5 | Surface 在时 `Ctrl+L` 变无操作 | **RED** — 仅 T1b（作曲家用例保持绿：变异是定向的） |

源码事后还原并重建，`git status` 确认 `src/` 无改动。

### W-3b.2a 顺带修的"半成品"（B2.5 遗留）

`/copy` 的短文案 `已复制 412 字…（最近回复）` 落在**底栏第一行**、长文案 `还没有可复制的回复…` 落在最后一行
（用户报告"copy 提示跑到第一行"）。根因不是 `Ctrl+L`，而是 B2.5 只做了一半：echo 曾是**状态行**上最低优先级的
一组，放不下才退到身份行——于是**同一条消息的行号由它的长度与窗口宽度决定**。现在 acknowledgement **恒在
身份行**，状态行只留仪表（E-1），`FooterStripInput.echo` 与 budget 的 `echo` 组删除；notice 仍优先于 echo。
证据：`tests/feedback-routing.test.mjs`（短/长 echo × notice × 160/100/60/40 列 + "notice 压过 echo"），
M1–M4 全红；14 项真 PTY 提示审计（`.pf/hint-audit.mjs`）显示修复后所有回执都在最后一行、状态行保持
`SSH ○○○○ 未测 │ 空闲`。提交：`915578f`。

### 验收

| 项 | 结果 |
|---|---|
| `typecheck` | 干净 |
| `npm test` | **1496 · 1492 pass · 0 fail · 4 skipped · 0 todo**（基线 1492·1488，+4 = 本轮的 Ctrl+L 专项） |
| 参考轨迹 | **109 条不变**（`tests/fixtures/` 无 diff，0 改写） |
| `npm run freeze` | 全绿 |
| `npm run freeze:input` | 无基线超限（`knownGaps` 0/0、`ownerReads` 24/54、`rawBranches` 8、`routers` 1、`routerCallSites` 3 全不变） |
| `npm run bench` | 字节 **501/465/2457/588/140**、行 **3/3/17/4/1**、**clears 0**——与基线逐项相同。**`Ctrl+L` 的有意清屏没有、也不得加进 `bench-b2.mjs` 的常规场景**（那里的全局断言就是 `clears === 0`） |
| 真机探针 | `tui-probe` OK（含交互层/选择器/Screen/退出交接）；`tui-setup-probe` OK（未配置 home：向导 Screen 画自己的帧、经 resize、Esc 与保存两次交回工作区）；`tui-drop-probe` OK；`tui-term-probe` OK（8/8 终端 profile） |
| 运行时 | **未改**：`src/` 在本轮收口提交中零 diff（唯一的 src 改动属于先落的 `915578f`） |

### W-3b.3 风险台账（正式登记，本轮只登记不修复）

| ID | 风险 | 可达条件（源码定位） | 影响 | W-3b.3 必测 |
|---|---|---|---|---|
| **R-HISTORY**（**W-3b.3a 已复现并修复**：浏览态下借用字段的 Backspace/Delete/Ctrl+U/Ctrl+K/粘贴把 `historyDraft` 覆盖成正在浏览的条目；守卫落在 `leaveHistoryBrowse()` 共同入口，见 §18.1） | 借用字段编辑时 `leaveHistoryBrowse()` 可能改隐藏 Composer 的 `historyIndex`/`historyDraft` | `leaveHistoryBrowse`（`tui.ts:15230-15235`）写 `historyIndex = this.history.length` 与 `historyDraft = this.input`；由 `backspace`(`15163`)、`deleteAtCursor`(`15174`)、`composerUnit` 的 `\x15`(`12852`)/`\x0b`(`12859`) 调用，四者都先过 `textIsEditable()`（借用字段时为真） | Surface 打开**之前**正处于历史浏览时，在**借用字段**里 Backspace/Delete/Ctrl+U/Ctrl+K 会把 `historyDraft` 覆盖成**正在浏览的历史条目文本**，用户原先的半截草稿在 Surface 关闭后经 ↑↓ 回不去；`moveFieldCursor`（`9760`）与 `handleDialogChar` 的输入路径（`13159-13164`）**不**调用它 → 同一字段上"打字不重置、退格重置"的不对称 | 用**真实历史浏览流程**（先 ↑ 进入浏览，再开 Surface，再编辑）复现，不得只构造孤立的 `historyIndex`；并断言借用字段编辑后 `historyDraft` 未被覆盖 |
| **R-ALT**（**W-3b.3a 已复现并修复**：`Alt+f`/`Alt+F`/`Alt+/` 现在只在 Composer 拥有字段时写入 `/find `，Surface 内被消费；`Alt+1…4`/`Alt+n/p` 的 W-3a 语义保持不变，见 §18.2） | Surface 中 `Alt+f` / `Alt+/` 可能直接覆盖隐藏 Composer 的 `input`/`cursor` | `route()` 的 Alt 分支（`12594-12611`）在 `12564` 的 `if (this.dialog === undefined …)` **之后**，且该门只挡 keymap 分支；`Alt+f`/`Alt+/` 写 `this.input = '/find '` + `this.cursor` | Surface 打开时按 `Alt+f` 会静默改写看不见的草稿（Screen 不受影响：`12560` 提前返回） | 与 W-3a 已锁定的 **Alt+1 行为**区分开（`input-ownership-regression.test.mjs:314-321` 明确断言和弦照跑、dialog 仍在、草稿不动）；**不得统一禁止全部 Alt 和弦**；`Alt+1` 另会改 `scrollOffset`（Workspace 状态），一并进入矩阵 |

**建议的 W-3b.3 矩阵**：`{confirm 无字段, picker 有选项, question 借用字段, picker+filtering}` ×
`historyIndex ∈ {-1, 0, k, history.length}` × `{Backspace, Delete, Ctrl+U, Ctrl+K, 打字, Home/End, Ctrl+A/E,
Alt+f, Alt+1, Ctrl+L}`，逐项断言 `{input, cursor, historyIndex, historyDraft, scrollOffset, borrowedText,
dialog.cursor, dialog.filter}` 不变（`Ctrl+L` 一行现在已是绿的，正好作对照格）。
另注：`scripts/input-freeze-audit.mjs` 的 `OWNED_WRITES` 虽含 `historyDraft`，但 `INPUT_HANDLERS` **不含**
`leaveHistoryBrowse`，且 `methodBody()` 只扫单方法体 → 该写入对棘轮**不可见**，建议 W-3b.3 顺手补计数。

**仍未做**：W-3b.3（`composerUnit` 拆分，未授权）、Surface 左右箭头、过滤字段模型、picker Reader（W-7）、
Screen 侧 `Ctrl+L` 的时序对齐（可选 B3）。

**CI**：`915578f`（`/copy` 回执行号修复）的 run `38711083667` **5/5 全绿**；`949b5fe`（本轮决策收口 +
`tests/ctrl-l-repaint.test.mjs`）的 run `38712968560` **5/5 全绿**——两条都含 `test-windows` 与四条
0.1.7/0.2.0 rc 腿。帧字节层面的断言是纯进程内 node 测试（`tests/ctrl-l-repaint.test.mjs` 不依赖 pty），
**因此 Windows 腿上同样执行**；真机腿覆盖的是"能启动、能渲染、不报错"与交互窗口归属。

---

## 0.8.4 W-3b.3a · 跨 Owner 状态隔离：R-HISTORY / R-ALT（2026-10-14）

> 目标：复现并定向修复 W-3b.2 审核登记的两条风险——借用字段的编辑写隐藏 Composer 的历史状态，以及 Surface
> 内 Alt 和弦写隐藏草稿。**先红后绿**；不做 `composerUnit` 结构拆分（W-3b.3b），不改 Ctrl+L，不发版。

**Preflight**：HEAD `e5842bd5e767100ffe13d502731fb82cfb6481d5`，工作树干净，version `0.8.3`（42 tag），
`1496 · 1492 · 0 · 4 · 0`，参考轨迹 109，`knownGaps` 0，Router 1，CI `38714764214` 5/5——与 brief 一致；
上一轮独立提交的 `/copy` 底栏回执修复（`915578f`）保留未回退。

### R-HISTORY

**入口审计**（`leaveHistoryBrowse()` 写 `historyIndex` + `historyDraft`）：

| 调用点 | 借用字段可达 | 前置条件 | 影响 |
|---|---|---|---|
| `backspace()`（`\x7f`/`\x08`） | ✔ | 字段非空 | 结束浏览 + 覆盖 `historyDraft` |
| `deleteAtCursor()`（`\x1b[3~`） | ✔ | 光标不在末尾 | 同上 |
| `composerUnit` `\x15`（Ctrl+U） | ✔ | `textIsEditable()` | 同上 |
| `composerUnit` `\x0b`（Ctrl+K） | ✔ | `textIsEditable()` | 同上 |
| `handlePasteText()`（粘贴） | ✔ | `textIsEditable()` | 同上（brief 特别点出） |
| `composerUnit` 尾部可打印分支 | ✘ | `dialog` 早返回之后 | Composer 专属 |

**红（实测，真实 ↑ 进入浏览、历史由两次真实提交建立，未伪造 `historyIndex`）**：浏览态下任一条借用字段编辑后
`historyIndex` 1 → **2**、`historyDraft` `'我打了一半的消息'` → **`'历史二'`**；Surface 关闭后按真实 ↓ 被
`historyForward` 的 `historyIndex >= history.length` 吃掉，**草稿再也回不来**。非浏览态与 Composer 自身语义
**红前即绿**（对照格）。

**最小修复**：`leaveHistoryBrowse()` 共同入口加 `if (this.borrowedText !== undefined) return`——历史浏览属于
Composer；Composer 自己的路径 `borrowedText === undefined`，行为一字未变。

### R-ALT

**红**：confirm Surface + `Alt+f` → `input` `'我打了一半的消息'` → **`'/find '`**（隐藏草稿被改写，F-2）。

**最小修复**：Alt 分支的种子只在 `textIsEditable() && this.borrowedText === undefined` 时写入，其余情况消费掉
和弦。`textIsEditable()` 单独不够（借来的答案也是字段）。

**合同对照（保留不变）**：`Alt+1…4`（跳类别）、`Alt+n/p`（搜索步进）在 Surface 内照旧执行——W-3a 已锁定
（`input-ownership-regression.test.mjs` 的 surface 用例），本轮只记录不重定义；Screen 仍在 Router 第一步吃掉
全部单元；Composer 单独拥有键盘时 `Alt+f` 仍写 `/find ` 且光标落在 6。

### 证据：`tests/surface-state-isolation.test.mjs`（6 条）

| 用例 | 内容 |
|---|---|
| R-HISTORY 借用字段 | 六条编辑路径（Backspace / Delete / Ctrl+U / Ctrl+K / 输入 / 粘贴）× 完整流程：两次真实提交 → 未发送草稿 → **真实 ↑** → 打开自由文本 Question → 编辑 → Esc → **真实 ↓**；断言借用字段只影响自己、Composer 指纹（`input/cursor/historyIndex/historyDraft/folded/history`）全程不变、关闭后仍在原浏览位置、↓ 交回原草稿、`history` 未被改写 |
| R-HISTORY 非浏览态 | ↑ 后 ↓ 回到末尾的形态下，六条编辑同样零写入，且此后 ↑ 仍召回、↓ 仍交回草稿 |
| R-HISTORY Composer 对照 | 浏览时在 Composer 打字**仍然**结束浏览（修复不得越界） |
| R-ALT 种子归属 | 四种 Surface 形态（confirm / 自由文本 Question / 有选项 Question / 过滤态 picker）× `Alt+f`・`Alt+F`・`Alt+/`：隐藏草稿/光标/Surface 状态零变化；Composer 形态仍写 `/find ` |
| R-ALT W-3a 锁 | `Alt+1`・`Alt+4`・`Alt+n`・`Alt+p` 在 Surface 内仍执行（记录其回执行文案），草稿与 Surface 不动 |
| R-ALT Ctrl+L | W-3b.2 冻结的路由与"恰好一次清屏"不变（`ownerComposer` + `\x1b[H\x1b[J` ×1） |

**指纹**：Composer 侧 `{input, cursor, historyIndex, historyDraft, folded, history[]}`，Surface 侧另加
`{dialog.kind/cursor/filter/filtering, borrowedText, focusedRow, scrollOffset, rows.length}`。

### Mutation（`.pf/mutations-w3b3a.mjs`，逐条改源码 → build → 跑用例 + 静态审计 → 还原）

| # | 变异 | 结果 |
|---|---|---|
| M1 | 借用字段 Backspace 重新触发历史退出 | **RED**（用例）＋静态审计 `new writer: backspace writes the composer history` |
| M2 | 借用字段 Delete/Ctrl+U/Ctrl+K 重新写历史 | **RED**（用例）＋`new writer: deleteAtCursor/composerUnit writes the composer history` |
| M3 | 借用字段粘贴重新写历史 | **RED**（用例）＋`new writer: handlePasteText writes the composer history` |
| M4 | Surface 内 `Alt+f/F//` 重新写隐藏草稿 | **RED**（用例） |
| M5 | 错误地禁用 Surface 的 `Alt+1` | **RED**（用例）＋静态审计 `ownerReads.dialog 55 > baseline 54` |
| M6 | Composer 自身浏览不再保存草稿 | **RED**（3 条用例） |
| M7 | 守卫过宽：Composer 的 `/find` 种子不再写入 | **RED**（用例） |

源码事后还原并重建，`git status` 确认 `src/tui.ts` 只剩本轮两处修复。

### Freeze 审计强化（`scripts/input-freeze-audit.mjs`）

写入类别拆出 **`composer history`**（`this.(historyIndex|historyDraft) =`）；`INPUT_HANDLERS` 加入
`leaveHistoryBrowse`，允许列表登记该对与 `submit` 的历史写入；新增结构化检查 **`historyGuards`**：历史写入者
必须读 `this.borrowedText`（注释剥离后再读），否则 `unguarded history writer` 失败。**未放大任何既有基线**
（`knownGaps` 0/0、`ownerReads` 24/54、`rawBranches` 8、`routers` 1、`routerCallSites` 3 不变）。
**能力边界**：静态扫描能说"谁写了什么""有没有守卫"，**不能**说"守卫是否覆盖全部借用字段入口"——后者由行为矩阵
与 M1–M3 固定，已写入 AD-20 §18.4。

### 验收

| 项 | 结果 |
|---|---|
| `typecheck` | 干净 |
| `npm test` | **1502 · 1498 pass · 0 fail · 4 skipped · 0 todo**（基线 1496·1492，+6 = 本轮专项） |
| 参考轨迹 | **109 条不变、零改写**（`tests/fixtures/` 无 diff；`alt-f` 无 Surface、Screen 在 Router 第一步被吃掉，两条受影响路径都被既有 fixture 形态排除） |
| `npm run freeze` / `freeze:input` | 全绿 / 无基线超限（含新增守卫检查） |
| `npm run bench` | 字节 **501/465/2457/588/140**、行 **3/3/17/4/1**、**clears 0**——与基线逐项相同，未新增完整清屏 |
| 真机探针 | `tui-probe` / `tui-drop-probe` / `tui-term-probe`（8/8 profile）/ `tui-setup-probe`（未配置 home）**全部 OK** |
| 其它既有套件 | Input Ownership Matrix、Ctrl+L Repaint、Unicode Input Safety 全绿（全量套件的一部分） |
| 默认 keymap / 上游兼容 / release 配置 | 未改 |

**仍未做**：W-3b.3b（`composerUnit` 结构拆分）、Surface 左右箭头、过滤字段模型、picker Reader（W-7）、
Completion/Search Screen/Terminal Doctor、Plan Card Fold。

**CI**：W-3b.3a 提交 `48efd24` 的 run `38719694935` **5/5 全绿**（`test-windows` 与四条 0.1.7/0.2.0 rc 腿）。
`tests/surface-state-isolation.test.mjs` 是纯进程内 node 测试（不依赖 pty），**在 Windows 腿上同样执行**——
两条风险的行为矩阵、指纹断言与 W-3a 的 Alt+1 锁都在 ConPTY 那一侧跑过；真机腿覆盖的是"能启动、能渲染、
不报错"与交互窗口归属。

---

## 0.8.4 W-3b.3c · `KEEP_SHARED_WITH_INVARIANTS` 合同加固与 Gate 收口（2026-10-14）

> 维护者架构裁决：**`KEEP_SHARED_WITH_INVARIANTS`** —— 保留共享执行体 `composerUnit`，0.8.4 不做
> executor split，完整拆分仅作 W-4 之后的独立结构轮候选；`Ctrl+L` 的 `KEEP_DUAL` 继续冻结。
> 本轮**只补证据与合同**：G1–G4 测试、freeze 审计两处盲区、AD-20/22 与 roadmap 文字。
> **运行时零改动**（`src/` 无 diff），未拆 `composerUnit`，未动 Router / keymap / 版本 / tag / npm。
>
> **编号说明**：W-3b.3b 报告的 A/B/C 有过错位（§5 的 B = 拆 Surface 执行体；§6/§12 的 B =
> `KEEP_SHARED_WITH_INVARIANTS`）。本轮起一律使用完整决策名，不再使用 A/B/C 简称。

**Preflight**：HEAD `1f599eaec4084d9498f66a3359c999e4648bd109`，工作树干净、与远端一致，version `0.8.3`
（42 tag），参考轨迹 109，`knownGaps` 0，Router 1，CI `38720419101` 5/5。

### G1–G4（`tests/input-ownership-matrix.test.mjs`，全部绿灯锁定）

| 组 | 格子 | 断言 |
|---|---|---|
| **G1** | 4 种 Surface（confirm / 借用字段 question / options question / filtering picker）× 8 键（`\x0e` `\x10` `\x12` `\x14` `\t` `\x04` `\x07` `\x1f`）= **32 格**，另加每形态 Ctrl+L | 恰好一个 owner（`ownerSurface`）；owner 状态 14 字段全不变；Surface 不离开；过滤态不丢；`appExit` 未被调用。Ctrl+L 行：仍归 `ownerComposer`（KEEP_DUAL）且零写入 |
| **G2** | options question（9 格）与 filtering picker（5 格）进入矩阵 + 逐格具名期望 | 归属唯一；`input/cursor/historyIndex/historyDraft/borrowed/focused/rows/scroll/yank/dialog/echo` 不变；Surface 自有状态按具名期望变化（`2` 移动高亮、`/` 打开过滤、`x` 进过滤、空过滤退格 no-op…）。**热键是 `123456789abc…`（`QUESTION_OPTION_KEYS`），不是选项首字母**——实测 `x`/`y`/`A` 在该列表里都不是热键 |
| **G3** | Composer `\x1f`/`Alt+f`/`Alt+/` 三条 `/find ` 路径 + Ctrl+G；四种 Surface × 4 键 | Composer：种子写入且光标落 6；Ctrl+G 不写文本、只报搜索。Surface：全部零写入，且**区分消费者**——`\x1f`/`\x07` 由 Surface 适配器消费（`ownerSurface`），Alt 和弦由 `route()` 分支消费（**任何适配器都看不到**） |
| **G4** | Composer（有卡片）× `\x0e`/`\x10`；Surface / Screen × 同键 | Composer：焦点环移动（**记录既有行为**，`/copy` 依赖它），草稿/光标/历史/行数/滚动不变；Surface 与 Screen 下同一写入不出现 |

**关于两处 RED 的处理（诚实记录）**：首次运行 G2/G3 各有 RED，**全部是我新写测试的期望错误**，实现侧从未存疑：
G3 断言 Alt 和弦会到达适配器（实际由 `route()` 在分派前消费 —— 正是 W-3b.3a 的修复形状）、G2 把选项首字母当成热键、
还把"空过滤退格"当成会变化。三处都先用 216 格矩阵探针（`.pf/executor-matrix.txt`）核对实现的实际行为，再改测试；
未修改任何运行时。（`\x1b` 也从 G1/G2 的格子里移出：孤立的 ESC 被 Reader 持有 60 ms，同步循环里 owner 尚未被调用。）

### Freeze 审计两处盲区（`scripts/input-freeze-audit.mjs`）

| 盲区 | 修法 | 证明 |
|---|---|---|
| 赋值匹配只认 `=` | 引入 `const ASSIGN = '\\s*[-+]?='`，`composer draft` 与 `composer history` 两类都改用它 | 复现品：`this.cursor += 2`（Tab）、`this.historyIndex -= 1`（`historyBack`）、`this.historyIndex += 1`（`historyForward`）此前**全部不可见** |
| `historyBack`/`historyForward` 不在扫描范围 | 加入 `INPUT_HANDLERS`，并在 `BASELINE_WRITERS` 登记其**真实**类别 | 二者是 Composer **自有**字段的合法写入者（与 `submit` 同类）；登记让它们进入逐对比较，任何**别的**方法写历史仍是 `new writer: … writes the composer history` |

**不是"用白名单消红"**：没有任何红灯被消除——登记的是既有合法写入者；`writerProblems()` 对未登记 `(方法, 类别)`
仍报错（W-3b.3a 的 M1–M3 重跑实测三条 `new writer` 依旧触发）。

**新旧扫描对照（一次性 git-excluded 探针 `.pf/prove-scanner.mjs`，重建的旧扫描器在 `.pf/old-audit.mjs`）**：

```
=== 未变异源码 ===
pre-round scanner    writers of composer history: submit, leaveHistoryBrowse      ← historyBack/Forward 不可见
this round’s scanner writers of composer history: submit, leaveHistoryBrowse, historyBack, historyForward
=== 变异：ownerSurface 里加一句 this.historyIndex += 0 ===
pre-round scanner    exit=0  problems=[]                                          ← 盲区确实存在
this round’s scanner exit=1  problems=["new writer: ownerSurface writes the composer history"]
```

探针自带**对照**：重建的旧扫描器必须仍能看见 `submit` 的草稿写入，否则说明测的是"重建坏了"而不是"盲区存在"。
（第一版探针正是栽在这里——过度转义的替换式让旧扫描器什么都看不见却仍然 exit 0；这正是"看不见的匹配器也是绿的"。）

**未放大任何基线**：`knownGaps` 0/0、`ownerReads` 24/54、`rawBranches` 8、`routers` 1、`routerCallSites` 3 不变；
`freeze` 与 `freeze:input` 均绿。

### 文档（`KEEP_SHARED_WITH_INVARIANTS` 的正式落点）

- **AD-20 §19**（新）：决策摘要（含"共享体不是越权来源"的四条依据与"同结构的 `\x1f` 被 `dialog` 早返回挡住"
  这条反证）、**S-1…S-6** 合同表（各自的行者与证据）、G1–G4 落点、**R4 已知限制**（过滤态非 BMP 被丢弃：
  `text.length === 1` vs `'🚀'.length === 2`；不是所有权问题、不是 RC blocker、本轮不修）。历史审计原文未动。
- **AD-22 §10.5**：改写为"与执行体拆分的接口（W-3b.3c 定稿）"——0.8.4 不拆、完整拆分延期至 W-4 之后的独立结构轮
  （**不写死 0.8.5**）、`Ctrl+L` KEEP_DUAL 继续冻结、Surface 侧不加 `case '\x0c'`。
- **0.8.4 roadmap**：0.8.4-b 行标记 W-3b.3b 由必要性 Gate 裁定 + W-3b.3c 内容；**验收判据第 2 条**由
  "`ownerReads` 计数为 0"改为"归属判定只在 Router（`dispatchers 1`/`routers 1`/`deadScreenGate 0`）；
  owner 自身状态读取由 `ownerReads` 记录，不设归零目标"——并说明 `ownerReads = 0` 是过时文字，
  **未删除任何合法的 paint/lifecycle 读取**（`paintFrame` 的 10 处 dialog 读等一律保留）。

### 验收

| 项 | 结果 |
|---|---|
| `typecheck` | 干净（0 error） |
| `npm test` | **1506 · 1502 pass · 0 fail · 4 skipped · 0 todo**（基线 1502·1498，+4 = G1–G4） |
| 参考轨迹 | **109 条不变、零改写**（`tests/fixtures/` 无 diff） |
| `npm run freeze` / `freeze:input` | 全绿 / 无基线超限（含加宽后的匹配器与两个新历史写入者） |
| `npm run bench` | 字节 **501/465/2457/588/140**、行 **3/3/17/4/1**、**clears 0**——与基线逐项相同；`Ctrl+L` 的有意清屏仍未进入 bench |
| M1–M7 | **全部 RED**（`.pf/mutations-w3b3a.mjs`；M1–M3 同时触发加宽后的 `new writer` 检测） |
| 真机探针 | `tui-probe` / `tui-drop-probe` / `tui-term-probe`（8/8 profile）/ `tui-setup-probe`（未配置 home）**全部 OK** |
| 既有专项 | Input Ownership Matrix（12 条，含 G1–G4）、Ctrl+L Repaint、Unicode Input Safety、Surface State Isolation、Borrowed Field Caret、Screen ownership regression 全绿（全量套件的一部分） |
| 默认 keymap / 上游兼容 / release 配置 / version / tag | 未改（`0.8.3`、42 tag、无 npm 动作） |

**仍未做**：executor split（延期至 W-4 之后的独立结构轮）、Surface 左右箭头、过滤字段模型（含 R4）、
picker Reader（W-7）、Completion / Search Screen / Terminal Doctor、Plan Card Fold。

**CI**：W-3b.3c 提交 `cdd85c4` 的 run `38847235769` **5/5 全绿**（`test-windows` 与四条 0.1.7/0.2.0 rc 腿）。
G1–G4 与加宽后的 freeze 审计都是纯进程内执行（不依赖 pty），**在 Windows 腿上同样跑过**；真机腿覆盖的是
"能启动、能渲染、不报错"与交互窗口归属。**本轮 `src/` 零改动**（`git status src/` 空），未拆 `composerUnit`、
未动 Router / keymap / 版本 / tag / npm。

---

## 0.8.4 W-3b.3c · Evidence Repair — G1 的 `inputFolded` oracle 缺口（2026-10-14）

> Independent Gate 的判定：**C.FAIL——W-3b 暂不能 CLOSED**。唯一 blocker 是**证据错误**，不是运行时错误：
> G1 的 `ownerState()` 不含 Composer 状态 `inputFolded`，因此一个既有的、能改变隐藏草稿状态的 mutation
> 仍然被 G1 判为绿。本轮只修这个 oracle 缺口。

**Preflight**：HEAD `c440d60eec9ffc5f6202c51558357dcaec3859e3`，version `0.8.3`（42 tag），工作树干净、
与远端一致，参考轨迹 109。

### Gate 的 mutation（复述，未改仓库文件）

移除 `composerUnit` 里 Ctrl+T 的 `dialog === undefined` guard：

```ts
case '\x14': if (this.dialog === undefined) this.inputFolded = !this.inputFolded; this.markDirty(); return
```

Gate 的观察：confirm / 借用字段 question / options question / filtering picker 下，**隐藏 Composer 的
`inputFolded` 均 false → true**，而当时的 G1 仍 GREEN。**运行时 guard 本身没有问题**（未变异时四种 Surface 下
`inputFolded` 都保持 false，见下），问题在于 G1 的 oracle 没有观测这个字段。

### 修复（一处，`tests/input-ownership-matrix.test.mjs`）

`ownerState()` 增加 `inputFolded: tui.inputFolded`（并写明它为什么在这里）。G1 的 4 Surface × 8 keys 结构、
G2/G3/G4 的覆盖范围、测试数量都**未改变**：本轮的测试文件 diff 只有这一个字段 + 注释。

### 证明（先未变异、再内存变异、再还原）

**未变异（GREEN）**——四种 Surface 的 Ctrl+T 格子，直接读 `inputFolded`：

```
✔ confirm                    owner=ownerSurface   inputFolded false → false  input="我打了一半的消息"
✔ question (borrowed field)  owner=ownerSurface   inputFolded false → false  input="我打了一半的消息"
✔ question (options)         owner=ownerSurface   inputFolded false → false  input="我打了一半的消息"
✔ picker (filtering)         owner=ownerSurface   inputFolded false → false  input="我打了一半的消息"
```

**内存变异（RED）**——`lib/tui.js`（git-ignored 构建产物，**未触碰任何 tracked 文件**）里删掉那两行 guard 后，
用**既有**测试跑：`tests/input-ownership-matrix.test.mjs` → **11 pass · 1 fail**，唯一失败就是 G1，四个格子
全部报出 `inputFolded: false → true`（诊断文本逐字记录在提交信息与本节；其余三个 G 用例保持绿，说明变异被
精确定位到该 oracle 而不是被别处顺带抓到）。未变异时同一套用例 **12 pass · 0 fail**。

**还原**：从备份恢复 `lib/tui.js` 并重建，`cmp` 确认与变异前的构建逐字节相同；`git status` 只剩本轮的测试改动，
`git diff -- src/` 为空。

### 证据

| 项 | 结果 |
|---|---|
| 定向用例 | `node --test tests/input-ownership-matrix.test.mjs`（12 条，含 G1–G4）**全绿**；连同 `surface-state-isolation` / `ctrl-l-repaint` / `unicode-input-safety` / `borrowed-field-caret` / `interaction-surface` 共 **66 · 66 pass · 0 fail** |
| `typecheck` | 干净（0 error） |
| `npm run freeze` / `freeze:input` | 全绿 / 无基线超限（`composer history` 写入者与 `leaveHistoryBrowse` 守卫检查不变） |
| `npm run bench` | 字节 **501/465/2457/588/140**、行 **3/3/17/4/1**、**clears 0** —— 与基线逐项相同（本轮无 runtime 改动，基线不应变化） |
| 参考轨迹 | **109 条不变、零改写**（`tests/fixtures/` 无 diff） |
| 测试数量 | 未新增任何 `test(` 声明（diff 只有字段 + 注释），总数保持 **1506**；全量回归由本轮的 CI run 提供 |
| `git diff -- src/` | **空**（未动 runtime / Router / keymap / `composerUnit` / guard） |

### 边界

- 本轮**不宣称 W-3b CLOSED**：它只关闭 Gate 指出的这一个 oracle 缺口，是否 CLOSED 由 Independent Gate 判定。
- 历史审计文字未重写：W-3b.3c 节的 G1 描述保持原样，本节作为**补充记录**说明它当时的 oracle 少了一个字段
  （不把历史写成"原本就完整"）。
- `KEEP_SHARED_WITH_INVARIANTS` 与 **S-1…S-6** 的含义未改变；executor split、R4、RC、npm 均未触及。

**CI**：证据修复提交 `093dc28` 的 run `38865066776` **5/5 全绿**（`test-windows` 与四条 0.1.7/0.2.0 rc 腿）。
本轮**未在本地强跑全量套件**（按维护者指示）；全量回归证据取自该 run 的日志：`ℹ tests 1506 · pass 1503 ·
fail 0 · skipped 3 · todo 0`（`test (0.1.7-rc.1)` 腿，日志中 `✔ G1: the keys the shared executor guards…`、
`✔ G2/G3/G4` 逐条在场），**测试总数仍是 1506**、无新增用例。`git status` 干净，`git diff -- src/` 为空。

---

## 0.8.4 W-3b.3c · Evidence Repair 2 — G1 的 Ctrl+R fixture/oracle 缺口（2026-10-16）

> Independent Gate 的第二次判定：上一轮的 `inputFolded` 缺口已正确修复；**当前 runtime 的 Ctrl+R guard 本身
> 正确**；但 G1 的 `SURFACE_FORMS` 里没有任何 collapsible row，因此**移除 `case '\x12'` 的
> `dialog !== undefined` guard 也可能是 no-op**（`collapsibleRows().length === 0` → `toggleCollapsible()`
> 直接返回），现有 oracle 无法证明这个 guard。本轮只修这个证据缺口。

**Preflight**：HEAD `aa0199dd8f2c3da3d28f3c92d06c4a1ec7a87d9`，version `0.8.3`（42 tag），工作树干净、
与远端一致，参考轨迹 109。

### 修复（只改 `tests/input-ownership-matrix.test.mjs`）

| 改动 | 说明 |
|---|---|
| `ownerState()` 增加 **`folds`** | `"${index}:${kind}:${open\|folded}"`（按行位置列出每张带 `expanded` 的卡）。不绑定某一种卡：fixture 多一张卡也仍然有效 |
| 新增 helper **`collapsibleCardBehind(tui)`** | 推入**一张真实可折叠的 tool 卡**（`expanded: false`），并**断言前置条件**：恰好一张卡、初始 folded、`focusedRow === null`。G1 的两个循环（8 键循环与 Ctrl+L 行）在 `open(tui)` **之前**各调用一次；四种 Surface 的打开方式未变 |
| G1 结构 | 4 Surface × 8 keys 与 Ctrl+L 行**结构不变**；`test(` 声明数量不变（矩阵文件仍 12 条，全仓 1503 条声明 / 运行器 1506） |

**为什么前置条件要断言**：这些格子只有在"卡存在、初始 folded、`focusedRow === null`"时才是证据——若有 ring
选中项，`Ctrl+R` 折的是那一项（Composer 自己的路径），观察到的就不是这个 guard。

### 证明

**原实现（GREEN）**：`node --test tests/input-ownership-matrix.test.mjs` → **12 pass · 0 fail**；四种 Surface 的
Ctrl+R 格子：`owner=ownerSurface`、`folds="3:tool:folded"` 不变、`focused=null` 不变、Composer state 不变、
dialog 不退出、filtering 不丢。

**内存变异（RED）**——只在 git-ignored 的 `lib/tui.js`（构建产物）里删掉 `case '\x12'` 的两行 guard，
**不触碰任何 tracked 文件**，跑**既有**测试：

```
✖ G1: the keys the shared executor guards for a Surface never reach the composer behind it   ← 唯一失败
ℹ tests 12 · pass 11 · fail 1        （未变异时 12/12；G2/G3/G4 在变异下仍全绿）
```

失败行**恰好 4 条，全部是 `+ Ctrl+R`**（四种 Surface 各一），状态变化逐字如下（confirm 一例，其余三例同形）：

```
folds:   "3:tool:folded" → "3:tool:open"      ← 隐藏转录上的卡被展开
focused: null            → "tool"             ← 焦点环也被移动
（input / cursor / inputFolded / historyIndex / historyDraft / borrowed / dialog /
  dialogCursor / filtering / filter / rows / scroll / yank / echo 全部不变）
```

即：该 mutation 只被 Ctrl+R 这一个格子的 oracle 抓到，未被其它 key 或其它用例顺带抓到——这正是本轮要建立的
定位能力。

**还原**：从备份恢复 `lib/tui.js` → 重新 `npm run build` → `cmp` 与恢复前构建**逐字节相同**；guard 文本复原；
`git status` 只剩本轮的测试改动；`git diff -- src/` 为空。

### 证据

| 项 | 结果 |
|---|---|
| 定向用例 | 矩阵 12/12；连同 `surface-state-isolation` / `ctrl-l-repaint` / `unicode-input-safety` / `borrowed-field-caret` / `interaction-surface` 共 **66 · 66 pass · 0 fail** |
| `typecheck` | 干净（0 error） |
| `npm run freeze` / `freeze:input` | 全绿 / 无基线超限 |
| `npm run bench` | 字节 **501/465/2457/588/140**、行 **3/3/17/4/1**、**clears 0** —— 与基线逐项相同 |
| 参考轨迹 | **109 条不变、零改写** |
| 测试数量 | **未新增 `test(`**（矩阵 12 条不变）；全量回归取自本轮 CI |
| `git diff -- src/` | **空** |

### 边界

- 本轮**不宣称 W-3b CLOSED**：只关闭 Gate 指出的第二个证据缺口，是否 CLOSED 由 Independent Gate 判定。
- 历史审计文字未重写：上一节（Evidence Repair 1）与 W-3b.3c 主体保持原样，本节作为**补充**说明 G1 当时既缺
  `inputFolded`、也缺"面背后有一张卡"这一前提。
- `KEEP_SHARED_WITH_INVARIANTS` 与 **S-1…S-6** 语义未改；executor split、R4、RC、release 均未触及。
