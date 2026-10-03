# CHANGELOG

面向用户的变更记录。每个版本的**发版说明**（含头等事、兼容矩阵与已知问题）在
`docs/release-notes-<version>.md`；本文件只记一行一条的变更，按版本倒序。

变更分类：**Added** / **Changed** / **Fixed** / **Removed** / **Docs** / **Internal**。

> 本文件随包发布（`package.json` → `files`），发版说明也在包里（`docs/release-notes-*.md`）；
> 指向 `docs/decisions/`、`docs/plans/`、`docs/checkpoints.md` 的链接是**仓库内**文档，只有 GitHub 上可读。

---

## 0.8.2-rc.1 — 2026-10-03（候选版；本版本地已就位，未打 tag、未发布）

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

### Docs

- [`docs/release.md`](release.md) 新增"发布前人工门槛"：Windows 实机清单、fresh-home 首启探针命令、
  以及 `npm run freeze` / `npm run bench` 两条发版自检。
- [`docs/decisions/b2-architecture-decisions.md`](decisions/b2-architecture-decisions.md) §20 记录 B2 冻结：
  八条不变量、七条退役路径、以及"表示的分类必须与它包裹的行一致"这条规则。

### Internal

- 表示管线：每条转写行都带 durability / class / destination；审计对未分类行、未知 destination、
  live 源行与重复 primary 表示各自计数，四个数字都必须为 0。
- 退役并在 CI 上禁止复活：`dedicated` Surface 角色、onboarding 的对话框渲染路径、
  `upsertPlanRow`（计划行的第二个写入者）、`ask_user_question` 的通用工具卡。

### 已知问题

- Windows / ConPTY **实机**未在本轮覆盖（CI 只跑探针）：发布前需按
  [`docs/release.md`](release.md) 的清单人工走一遍。
- fresh-home 首启的真 PTY 走查在只读 pnpm store 的沙箱里建不出 home，未跑通；探针
  `scripts/tui-setup-probe.mjs` 已就位，命令在 [`docs/release.md`](release.md)。
- ~~`scripts/tui-drop-probe.mjs` 约 1/7 概率因自身的 `/status` 重试竞态误报~~ —— **本版已修**：
  改为一次请求在飞、按每次请求的输出判定、并按"当前是否真有 Screen"决定关闭，连跑 20 次无失败。
- 打包：`npm pack` 239 个文件 / 1.36 MB（tarball），CHANGELOG 随包发布；无凭据、无 home、无 sqlite、
  无 scratch（`npm pack --dry-run` 实测）。

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
