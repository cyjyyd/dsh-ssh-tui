# CHANGELOG

面向用户的变更记录。每个版本的**发版说明**（含头等事、兼容矩阵与已知问题）在
`docs/release-notes-<version>.md`；本文件只记一行一条的变更，按版本倒序。

变更分类：**Added** / **Changed** / **Fixed** / **Removed** / **Docs** / **Internal**。

> 本文件随包发布（`package.json` → `files`），发版说明也在包里（`docs/release-notes-*.md`）；
> 指向 `docs/decisions/`、`docs/plans/`、`docs/checkpoints.md` 的链接是**仓库内**文档，只有 GitHub 上可读。

---

## 0.8.2-rc.1 — 2026-10-04（候选版，只上 `next`；`latest` 保持 0.8.1）

发版说明：[`docs/release-notes-0.8.2-rc.1.md`](release-notes-0.8.2-rc.1.md)。

B2（"what deserves to exist"）的六个阶段 B2.1 – B2.6 已完成并通过最终审计，本节汇总用户能看到的
部分。详细证据与冻结记录见 [`docs/checkpoints.md`](checkpoints.md) 与
[`docs/decisions/b2-architecture-decisions.md`](decisions/b2-architecture-decisions.md) §20。

### Added

- **报告是 Screen**：`/status`、`/help`、`/doctor`、`/subagents`、`/diag` 等报告不再写进转写、
  不再改变历史窗口，翻页只重画正文区，Esc 回到原处。
- **计划 artifact 投影**：计划模式下的待办与评审从会话日志折叠出来；一份计划一行引用、一个 dock、
  一个评审 Surface，resume 后身份一致。
- **工具卡片的审批状态**：卡片自己拥有 `waiting / approved / rejected / unknown`（以及来源：
  live / policy / durable / inferred）；不再有独立的审批行。
- **首启向导是 Screen**：9 步向导不再是"借工作区 composer 的对话框"，中途 detach/reattach 不丢步骤，
  也不再清空读者已经打了一半的草稿。
- **`npm run freeze`**：一条命令跑完 B2 的八条冻结不变量与七条退役路径扫描（CI 在 Linux 与
  Windows 两条腿上各跑一次）。
- **`npm run bench`**：五个动作（流式 delta / 等待时钟 / 报告翻页 / 菜单移动 / 向导打字）的性能基线，
  并断言这五个动作都不整屏重画。

### Changed

- **反馈分流**：控制面的确认去页脚（echo，最低优先级，直到下一次输入），警告/失败去身份行（notice），
  只有会改变历史的事实才进转写（[`docs/checkpoints.md`](checkpoints.md) B2.3b）。
- **`/copy` 语法**：`/copy` 或 `/copy reply` 复制模型最后一条回复（默认）；`/copy highlight` 复制焦点卡片；
  `/copy error` 复制最新的错误/诊断行。复制键保留"取不到焦点就退回回复"的语义。
- **工作区在方向键后的停留**：resume 进来不再从窗口中间开始滚动，直接停在最新内容。

### Fixed

- **工具卡内容有多行代码时会窜到输入区**。`bash` 的摘要就是命令行原文，所以 heredoc 会带着换行进入
  卡片标题行；而单行裁剪器（`truncateToWidth`）保留 LF/CR，于是一"行"里含多个换行 —— 终端会因此换行，
  而按绝对行号定位的帧随后把下面每一行都写错位，卡片内容落到输入框和页脚上，还会出现两段文字拼在同一行。
  实测：31 行的一帧里有 11 行含裸换行；修复后为 0。
- **Windows Terminal 下输入法的预输入字符不再在处理中卡片那一行的最右边闪烁**。终端把 IME 预输入画在
  光标处，而写一行会把光标留在该行文本末尾；跑一轮时实时区域每 tick 重画、且位于输入框上方，于是光标停在
  处理中卡片上、预输入就闪在那里。现在除光标自己所在行外，每写一行都把光标交还输入框。
- **命令提示不再一直占着位置**：确认（"已复制 412 字"）与警告（命令失败）显示 6 秒后自动让位、恢复原来的
  遥测行（提交仍会立即清掉）；**"将在下个步骤生效"的排队提示例外** —— 它显示到那条消息真正被提交为止，
  因为它是"你有话在排队"的唯一标记。
- **全新安装不再跳过配置向导**。前端拉起后台 Host 时永远带 `--resume=<id>`（连它刚生成的新 id 也带），
  而首启判定把 `resume` 当成"这台机器配置过"，于是**新机器永远不会自动出现向导**，也没有任何提示。
  判定现在只看凭据存不存在。
- **裸 400 现在会说明它是什么**：网关拒收的是请求本身（不是 key），并给出这一族的上游记录与绕法
  （`/effort off` 或换 messages 风味路线）；**不自动重试**（实测这类失败成串出现，重发由读者决定）。
- 流式输出不再每个 tick 整屏重画（B2.2：live 区是投影，不是转写行）。
- 高亮的工具卡片不再把内容画进相邻卡片；处理中卡片遇到长内容不再折断成一行。
- 计划卡不再吃掉输入法的预输入字符（dock 高度不得超过工作区一半，光标行永远在屏）。
- resume 的历史回放不再逐帧重画（20k 事件从 51 帧 / 1.2 s 降到一次重建）。
- 部分命令执行后没有任何提示（页脚放不下的确认现在退到身份行显示）。
- 待办未收尾的提醒不再伪装成一条"计划转写引用"（B2 最终审计：`plan-row` → `plan-notice`）。
- **resume 进入时不再有一段黑屏（1–3 秒）**：前端先在备用屏打出"正在载入历史会话…"，relay 接入时
  宿主又写了一次 `?1049h` —— 终端已在备用屏时这个序列会**清屏**，而回放期间按 B2.4 不合成任何帧，
  于是读者面对的是一块空白，直到日志重建完（实测 20k 事件：9.1 s 清屏、12.6 s 首帧，中间 3.5 s 全黑）。
  这条"进屏"序列现在搭在第一帧上发出，与它要清出来的内容同一个 tick；没有东西要等的 reattach 行为不变。
  （上一版试过相反的做法 —— 加载期间由宿主补画一行 —— 结果写进了 relay 的测速窗口，那版已回退。）
- **思考卡片的文字不再发白**：`reasoning` 角色是 `2;3`，只有属性 —— "暗"完全靠 faint，不实现 faint 的
  终端（报告的 256 色终端）就退回**默认前景色**，与旁边的回复一样亮。四个调色板现在各自给出 muted 颜色
  （default `90`，catppuccin / gruvbox 用各自 `md-muted` 的色，mono 仍然只用属性），属性保留给支持的终端。
- **状态行不再把"绘制节奏"当成"链路延迟"**：终端不回 `CSI 6n` 时（现场 `/diag`：Linux + xterm-256color
  + SSH，`探测 未知`），这一格显示的是**回退的绘制节奏** 160ms，读者无法分辨它和真实延迟。现在改为
  `SSH ○○○○ 未测` / `n/a`；测到过的链路照旧显示测量值，绘制节奏仍留在 `/diag` 那一行（写明是"绘制"）。
- **`q` / `Q` 真的能关掉报告**：`inspectClosesOn` 一直声明接受它们（"全屏报告理应响应 q"），
  但可打印字符的提示分支在它之前返回，于是这两个键只会打印"这是报告视图，按 Esc 返回"。

### Docs

- [`docs/release.md`](release.md) 新增"发布前人工门槛"：Windows 实机清单、fresh-home 首启探针命令、
  以及 `npm run freeze` / `npm run bench` 两条发版自检。
- [`docs/decisions/b2-architecture-decisions.md`](decisions/b2-architecture-decisions.md) §20 记录 B2 冻结：
  八条不变量、七条退役路径、以及"表示的分类必须与它包裹的行一致"这条规则。

### Internal

- **链路验收补齐"带历史的 resume"**：`scripts/tui-rtt-probe.mjs` 现在有两个阶段——新会话（先慢后快的
  链路）与**带历史的 resume**（探针自己写一份 20k 事件的持久化日志，回放期间不合成帧）。后者同时断言
  三件事：读者画面上出现过加载行之后**不得再变空**、转写落地、chip 落在真实测量值而不是 `○○○○ 160ms`
  占位。两条断言都做过变异校验（改回"接入即写"报 4 秒黑屏；关掉 RTT 应用报 chip 停在占位）。
- **`verify-batch.mjs` 不再把 SKIP 说成 PASS**：有步骤跳过时收尾为 `RESULT: INCOMPLETE`（exit 2），
  与 `FAIL`（exit 1）分开；`link` 已加入验收步骤表（`--only link` 可单跑）。
- 表示管线：每条转写行都带 durability / class / destination；审计对未分类行、未知 destination、
  live 源行与重复 primary 表示各自计数，四个数字都必须为 0。
- 退役并在 CI 上禁止复活：`dedicated` Surface 角色、onboarding 的对话框渲染路径、
  `upsertPlanRow`（计划行的第二个写入者）、`ask_user_question` 的通用工具卡。
- **Windows 实机轮（2026-10-03）修掉五处探针缺陷，产品代码未改**：`verify-batch` 在 Windows 上
  因 `spawn('npm')` 必然 `ENOENT`（改用 `$npm_execpath`）；`tui-route-probe` 的 `/tmp` 字面量
  （改 `os.tmpdir()`）与目录符号链接（Windows 改 junction）；`footer-windows-probe` 补了**未测量
  链路**档案并逐格断言时长槽（`未测` 而非 `160ms`）；`tui-mock-probe` 的鼠标坐标改由真实终端网格
  给出（此前从字节流解析 `ESC[<row>;1H`，ConPTY 下拼出伪行，拖选看起来偏了两格——**是探针缺陷，
  不是选择缺陷**）。
- **新增 `scripts/tui-unmeasured-probe.mjs`**（管道父进程，进 `verify-batch` 与 CI）：ConPTY 自己回
  `CSI 6n`，所以"终端不回 DSR"这一格在 Windows 本机摸不到，而这个形状正是读者报过两次的那个。两条腿
  分别断言 `SSH ○○○○ 未测`（绘制节奏只留在 `/diag`）与 `SSH ●●●● <n>ms`。
- **ConPTY 盲区改为显式 `SKIP:`**（不再是"读错就判红"）：`tui-cut-probe` 的静默半场、
  `tui-rtt-probe` 的慢链路半场、`tui-setup-probe`/`--line-mode` 的字节形状检查。SKIP 仍收尾
  `INCOMPLETE`。真实 home 未配置时（会进配置向导）同样 `SKIP:` 而不是超时报红；
  `verify-batch --home <dir>` 可把读 profile 的三步指向自建 home。

### 已知问题

- Windows / ConPTY **实机人工验收已完成**（2026-10-03，维护者逐条走过 12 项清单，结论见
  [`docs/checkpoints.md`](checkpoints.md)「Windows 实机轮」）：可自动化的部分由 `verify-batch --home
  <dir>` 覆盖（12 PASS · 2 SKIP · 0 FAIL），**没有自动化、只能人眼的两目（输入法组合、多行中文粘贴）
  已确认通过**。两处 `SKIP` 是覆盖边界、不是通过：ConPTY 自己回 `CSI 6n`，"慢链路"与"静默但没断连"
  这两个形状它扮演不了（这两个形状在 Linux 腿上真跑）。
- fresh-home 首启有两条探针覆盖（`scripts/tui-setup-probe.mjs` 断言向导自动出现 + 第二次启动不再出现；
  `scripts/probe-onboarding.mjs` 供工作区探针识别"这是首启"并 `SKIP:` 而不是误报），命令在
  [`docs/release.md`](release.md)。只读 pnpm store 的沙箱建不出 home，那是环境限制，不是覆盖缺口。
- ~~`scripts/tui-drop-probe.mjs` 约 1/7 概率因自身的 `/status` 重试竞态误报~~ —— **本版已修**：
  改为一次请求在飞、按每次请求的输出判定、并按"当前是否真有 Screen"决定关闭，连跑 20 次无失败。
- 打包：`npm pack --dry-run` 实测 **243 个文件 / 1.4 MB（tarball）/ 解包 4.2 MB**，CHANGELOG 随包发布；
  无凭据、无 home、无 sqlite、无 scratch。

---

## 0.8.1 — 2026-09-30（`latest` + `next`）

发版说明：[`docs/release-notes-0.8.1.md`](release-notes-0.8.1.md)。

### Fixed

- 没有终端的进程（桌面版 Electron-as-Node、管道、cron）不再抛错退出，而是保持惰性：不取锁、
  不装定时器、不查更新，记一行说明，退出码 0。

### Added

- `DSH_TUI_DISPLAY=stdio`（或 `--display stdio`）：宿主自带终端控件时可以把 TUI 当子进程用，
  画面走 stdout、按键走 stdin、尺寸由 `CSI 8 ; rows ; cols t` 报告。

---

## 0.8.0 — 2026-09-29（`next`，随后提升为 `latest`）

发版说明：[`docs/release-notes-0.8.0.md`](release-notes-0.8.0.md)。基线切到上游 `0.2.0-rc` 线
（桌面版 Harness 的基线），兼容窗口与 CI 腿随之上移。
