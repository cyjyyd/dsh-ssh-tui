# 验收检查点（A / B / C 批）

每个批次（C 批为每个功能）留下一个可独立复核的检查点：**一条命令 + 一张人工核对清单 + 该批次所有 mutation 记录**。
命令都从仓库根目录执行，全部不消耗模型额度（`tui-mock-probe` 使用合成 profile 与脚本化模型）。

一键复核全部证据：

```bash
node scripts/verify-batch.mjs --batch <A|B|C>     # typecheck + 全量测试 + 四条真机探针
```

## A 批 · 界面基础（已交付）

| 项 | 人工核对（在自己的 SSH 会话里） | 自动证据 |
|---|---|---|
| A-1 模型回复**自由复制** | 在回复上**按住拖过一段**（可跨行、可含中文/emoji）→ 到别处粘贴，内容应恰为拖过的那段；在工具卡上单击仍应展开/收起（按下不动 = 点击） | `tests/mouse-selection.test.mjs`、`tests/selection.test.mjs`；`tui-mock-probe.mjs` 真机拖选并断言剪贴板内容 |
| A-2 计划条进度 | 让模型跑一次多步任务：卡片首行应形如 `⣿⣿⣀⣀… 2 已完成 · 1 进行中 · 1 待处理`；模型写 `failed/skipped` 时单独计数 | `tests/todo-progress.test.mjs`（含 24/30/40/80 列窄屏） |
| A-3 错误块复制 | 制造一次失败（如 `/doctor` 报缺行）→ `/copy error` → 粘贴：**整份**报告，长路径不因折行被插入换行 | `tests/copy-error.test.mjs`；`tui-probe.mjs` 断言 OSC 52 实际发出 |
| A-4 `/find` 高亮 | `/find 某词`：只有该词反色（同行多处都亮），窄屏折行后不错位；`NO_COLOR` 下命中行前有 `»` | `tests/find-highlight.test.mjs`；`tui-mock-probe.mjs` 真机反色断言 |

## B 批 · 底栏、模式与配色（本轮交付）

| 项 | 人工核对 | 自动证据 |
|---|---|---|
| B-1 底栏状态区收敛 | 底栏第一行（状态区）应为：`⚠ 名单缺席（/doctor） │ SSH ○○○○ 160ms │ 2 轮 · 5 步 │ …`，整行**与第二行同色（暗）**，只有链路圆点/⚠ 着色；额度条与上下文环仍留在**第二行**（身份行）模型之后；**把终端缩窄**：先丢文字、保留图形，⚠ 最后才丢；**点击 ⚠** 应打开 `/doctor` | `tests/footer-chips.test.mjs`（含 3/12/24 列、点击、样式与行位）、`scripts/capture-footer-frames.mjs`（渲染帧断言，见下） |
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
