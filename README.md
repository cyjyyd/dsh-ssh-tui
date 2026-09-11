# dsh-ssh-tui

[![npm](https://img.shields.io/npm/v/dsh-ssh-tui?style=flat-square&color=4b6fff)](https://www.npmjs.com/package/dsh-ssh-tui)
[![npm downloads](https://img.shields.io/npm/dm/dsh-ssh-tui?style=flat-square)](https://www.npmjs.com/package/dsh-ssh-tui)
[![CI](https://github.com/cyjyyd/dsh-ssh-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/cyjyyd/dsh-ssh-tui/actions/workflows/ci.yml)
[![dshfind](https://dshfind.com/api/badge/cyjyyd/dsh-ssh-tui)](https://dshfind.com/zh/plugins/cyjyyd/dsh-ssh-tui?ref=badge)

给跳板机、无桌面服务器、高延迟 SSH 用的 DeepSeek Harness 终端。纯 ANSI、增量重绘，
不需要浏览器。

English: [README.en.md](README.en.md)

如果你主要在 SSH 里写代码——公司跳板、测试机、只有键盘的会话——可以从这里开始。
本机桌面终端若更在意主题和布局，也可以继续用你已经习惯的界面。

SuperGrok / X Premium 订阅走配套插件 [dsh-llm-xai-oauth](https://github.com/cyjyyd/dsh-llm-xai-oauth)，复用本机 grok-bridge token，不需要 xAI API Key。

本插件已被 [dshfind 插件目录](https://dshfind.com/zh/plugins/cyjyyd/dsh-ssh-tui) 收录：

[![dshfind](https://dshfind.com/api/card/cyjyyd/dsh-ssh-tui?lang=zh)](https://dshfind.com/zh/plugins/cyjyyd/dsh-ssh-tui?ref=badge)

安装（官方 CLI，无需 clone）：

```bash
dsh plugin --profile tui add dsh-ssh-tui@latest
dsh --profile tui
```

当前 `dsh` 必须带 `--profile`（`dsh plugin add …` 会报缺选项）。装进别的 profile 把 `tui` 换成那个名字即可。

**更新必须带 `@latest`。** `dsh plugin` 只是把后面的参数转给 profile 目录里的 pnpm。写成 `add dsh-ssh-tui`（没有版本）时，pnpm 会沿用 `pnpm-lock.yaml` 里已经钉死的版本（常见就是一直停在 0.3.7）。也不要把 `--profile` 写到 `add` 后面：`dsh plugin add --profile tui add dsh-ssh-tui` 不是合法用法。卸载：`dsh plugin --profile tui remove dsh-ssh-tui`。

## 官方 headless 和这个 TUI

官方没有预置 TUI。远程机器上的默认终端入口是 `dsh --profile headless`：跑完一个任务，把**最后一条助手回复**打到 stdout 就退出。思考、工具调用、子代理、计划都在会话日志里，终端上看不到。

下面两帧是**同一条任务**。上：官方 headless 的 stdout（按 `@deepseek-ai/dsh-headless` 的契约：只打印最终文本）。下：本插件把同一组事件画进 88 列 SSH 窗口。

![官方 headless stdout 对照 dsh-ssh-tui](docs/screenshots/compare.png)

上：`$ dsh --profile headless "…"` 之后只有最终 Markdown。  
下：思考默认折叠、`edit` 整行红/绿 diff、两个子代理各自一张卡、计划条钉在输入框上方。

单独看：[headless stdout](docs/screenshots/headless.png) · [dsh-ssh-tui](docs/screenshots/workspace.png)

## 弱网 SSH 上过程还在

同一条任务，按 **2 kB/s** 限速回放真实增量绘制（88×30，一帧一次 `stdout.write`）。官方 headless 这条链路上只会在全部结束后突然打出最终 Markdown；这里思考、`edit` diff、子代理卡和计划条是随着字节到达逐步出现的。

![2 kB/s SSH 上回放同一任务](docs/screenshots/slow-link.gif)

协议（可复现，不靠模型估）：`npm run screenshots:slow` → `docs/screenshots/slow-link.json`。这次回放 14 次绘制、约 **18.0 KB**，在 2 kB/s 上大约 **8.8 s** 画完。数字是这条固定事件序的 stdout 字节账。

## 功能一览

- 纯终端渲染，无需浏览器/鼠标/重量级终端框架，适合慢速或远程 SSH；
- 模型思考流默认折叠，显示 `▸ 思考中 ⠹ · N 字 · Ns` 动画；结束后折叠为
  `▸ 已思考 · N 行`，可单独展开；思考过程中也能实时展开/收起查看原文；
- 工作区支持 markdown 渲染：多级标题（H1 放大/下划线、H2 下划线、H3 着色）、
  粗体、斜体、行内代码、代码块、列表、引用与链接；模型最终回复以普通白色显示，行内 `**粗体**` 用更亮的粗体区分；
- 系统提示词 / `system-reminder` / `AGENTS.md` 等注入折叠为「提示词注入:系统预设 AGENTS.MD」卡片，默认收起，Enter 展开看全文；
- 工具调用卡片化：标题默认色，状态球绿/黄/红表示成功/运行中/失败（成功不再跟 `[ok]` 重复；失败仍标 `[error]`）；
  连续读/编辑同一路径会叠成一张卡（`×N` + 累计字数/行数，编辑 diff 跟随追加，合并时翻牌动画）；
  shell 命令浅灰、路径 cyan；编辑工具 git 风格 diff（`-` 暗红底 / `+` 暗绿底 /
  文件统计），头部带 git 红绿增删行数（如 ` -13 +24`），默认收起，Enter 展开；
  正文超出窗口时单独全览（Esc 返回）；JSON 参数与结果自动转可读内容；
- 转录区滚动回看（`PgUp`/`PgDn`、鼠标滚轮），点击思考/工具标题行直接展开收起；
- 输入框下方两行底栏：第一行链路芯片 + 按宽度丢组的会话数字（轮次、入/出 token、速度）；
  第二行只留一个活动词（运行中 / 工具 N / 子代理 N / 压缩中…），身份收到右侧（含 `目录:srv`；点击打印完整工作目录）；
  身份里始终带 `sub:<子代理模型>`：`/submodel` 选模型、`/subeffort` 选档位（带括号后缀）；提供商前缀只在
  设置里固定过子代理提供商时出现（如 `sub:xai/grok-4.5(xhigh)`，`settings.yaml` 的 `ssh-tui-subagent.provider`）；
- 恢复旧会话会切到该会话记录的工作目录；新建会话用启动时的当前目录；
- 历史会话启动选择器：`dsh --profile tui --resume`（或 `resume`）先选会话再进入；
- 终端窗口标题栏：运行中旋转图标 + `运行中 · 工具 N`，完成后 `✓ 已完成`，并响
  一声终端铃（`DSH_TUI_NO_BELL=1` 关闭）；
- 审批、`ask_user_question`、计划模式、子代理进度、`/mode` 模式切换、`/model` 模型切换、
  `/resume` 会话切换、`/disconnect` 断线策略等完整支持；
- `/approval auto` 自动审批模式（Codex 式）：读类/构建/测试、工作区 `edit`/`write`/`read` 自动放行；
  `rm -rf`、`sudo`、`curl|sh`、`git push --force`、敏感路径只读等危险命令自动**拒绝**，并把原因
  回给模型由其自行调整；`npm publish`、解释器 `-c`/`-e` 等未识别形状交给**子代理模型 AI 复核**
  （用户消息 + args/reason/sandbox，英文界面走英文审核员；`authorization=yes` 才放行）；
  仍未可判定时接入才询问、断开时自动拒绝——配合 `/disconnect continue` 断线后回合不停摆；
  `/approval status` 另报本轮 AI 复核次数；
- 每个子代理都是独立可折叠卡片，默认收起，运行中带旋转动画；多个子代理互不混排；
- 进入计划模式、待审计划、提问用户都会显示对应卡片和底部提示，而不是只塞进系统消息。
- 工作区底部有 Codex 式「处理中」动画卡：思考里第一个闭合的 `**加粗**` 作为 shimmer
  标题（还没出现就保持「处理中」），运行中的工具摘要在 `└` 下自动折行（最多 3 行，末行
  加省略号），带计时和 Esc 中断；回复开始流式输出时自动让位。

## 环境要求

- Node.js ≥ 22.19
- DeepSeek Harness CLI：`npm i -g @deepseek-ai/dsh`（已验证 `0.1.2-rc.1` 与 `0.1.5-rc.1`。`0.1.5-alpha.1` / `0.1.5-alpha.2` / `0.1.3-alpha.2` 走同一套 handle API + `agent/assistant-stream` 兼容层。`0.1.3-alpha.1` 只在 GitHub 有 tag，npm 未发布，无法本地装包验证）
- pnpm（`dsh plugin` 通过 pnpm 管理 profile 依赖）
- 支持 ANSI 的终端（推荐 SSH 直连；Windows 用 PowerShell / Windows Terminal）
- Windows：Host 与显示端之间的本地通道使用命名管道
  `\\.\pipe\dsh-tui-<DSH_HOME 摘要 8 位>-<会话名>-<会话摘要 8 位>`（Windows 只能监听命名管道，
  不能监听 `.sock` 文件；名字里同时带 DSH_HOME 与会话 id 的摘要，所以不同 home、不同会话都不会撞名，
  结束进程即自动回收）。Host 的 stderr 记录在 `%USERPROFILE%\.dsh\tui-socks\<会话名>-<摘要>.err`，
  会话锁仍在 `%USERPROFILE%\.dsh\tui-locks\`。

## 部署指南

推荐安装就是文首那条 `dsh plugin --profile tui add dsh-ssh-tui@latest`。CLI 会从 npm 拉包、写入 profile 依赖，并把本插件加入 `dsh.profile.bundles`（因为包内声明了 `dsh.bundle`）。

可选：本机已有 SuperGrok / grok-bridge token 时再装配套 OAuth：

```bash
dsh plugin --profile tui add dsh-llm-xai-oauth
dsh plugin --profile headless add dsh-llm-xai-oauth
```

SuperGrok 的 access token 大约 1 小时过期。TUI 打开时会刷新即将过期的 token，`/usage` 遇到 401 也会再刷一次。机器长时间不开 dsh 时，请另开刷新进程，否则一打开就是 401：

```bash
npx dsh-llm-xai-oauth daemon --install
```

说明见 [dsh-llm-xai-oauth](https://github.com/cyjyyd/dsh-llm-xai-oauth)。

先确认链路再开 TUI（无 TTY 时 TUI 会直接退出）：

```bash
dsh --profile headless "Reply with exactly: tui-install-ok. Do not use tools."
dsh --profile tui          # 必须在真实终端 / SSH 会话里
```

### SSH 断了之后

合盖、跳板 idle、换网会拆掉当前 TTY。TUI 把 SIGHUP / stdin 关闭 / 写 TTY 失败
当成挂断：放下显示器并 flush 日志。**空闲断线不保活**（Host 退出，下次从日志
`--resume`）；模型思考 / 回复 / 工具 / 子代理等忙碌状态则 **Host 留下**。
重新 SSH 后同一条命令会优先接入那个进程（选择器标「可接入」），不要再开第二份 Host：

```bash
dsh --profile tui --resume                 # 选择器（活进程优先接入）
dsh --profile tui --resume <session-id>    # 有活进程则接入，否则从日志恢复
```

同一 `sessionId` 不能同时开第二份 Host（会抢 jsonl 和审批）。锁在
`$DSH_HOME/tui-locks/`，显示通道在 `$DSH_HOME/tui-socks/`。进程死后残留锁会在
下次启动时核对 pid，已死则自动从日志接管。调试可设 `DSH_TUI_NO_SESSION_LOCK=1`。

一个会话同时只有一块屏幕：新窗口接入时 Host 会通知旧窗口「你已被接管」（`FRAME_REPLACED`），
旧窗口退出，不会两个窗口互相抢显示。

链路探测（`CSI 6n`，终端回 `CSI row;col R`）做了三层防护：Host 收到 HELLO 之前就先测（不把
整屏重绘的时间算成链路）；每次重问前等链路安静**一整个应答窗口**（350ms，超时后放宽到
800ms），这样「上一个请求的回复」必然已经落地并被丢掉；采样取中位数，并丢掉比中位数快 4
倍以上的（那是别人请求的回复，相对判定所以 `ssh localhost` 的 2ms 链路照样算得出来）。
代价是每次接入多约 0.4–0.6 秒探测时间，换来的是 50ms 链路不再出现 2ms / 1900ms 的跳变。

这些回复也不可能再进输入框：relay 整条 stdin 管道常驻过滤（含跨 read 拆分的），Host 键
处理前再过滤一次；连 Host 启动那几百毫秒里敲的键也会被暂存、接入后补发，不再被丢掉。
`DSH_TUI_DEBUG=1` 时会打印每次采样与丢弃原因。

忙碌时默认断线会暂停当前轮次（取消），接上后再发一句才会继续。`/disconnect continue` 或
`ssh-tui.disconnect: continue`（也可用 `DSH_TUI_DISCONNECT=continue`）则不取消，
Host 在后台跑完这一轮；审批和提问等接上后再弹。空闲断线直接退出，不占后台。
留下的 Host 持有该会话的内核写锁（`session.lock`），而 Web 端打开同一会话时正是被这把锁挡下的
（`resume failed for session … is already owned by an active write handle`）。所以它**跑完留下来的那一轮后最多再等 1 分钟**
（`DSH_TUI_IDLE_EXIT_MS`，或 settings.yaml 的 `ssh-tui.idleExit`，毫秒；设 `0`/`off` 恢复旧行为）
就自行退出并让出锁：这段时间够原窗口重连接入，之后 `--resume` 重新打开已落盘的日志。
完全没有显示器且一直空闲的兜底仍由 `DSH_TUI_DETACHED_IDLE_MS`（默认 6 小时）负责。可选：用 tmux 包一层。

启动时若 npm 上有更新，会弹出选单（类似 Codex / Claude Code 首启）：**现在更新 / 稍后 / 跳过此版本**。选「现在更新」会运行 `dsh plugin --profile tui add dsh-ssh-tui@latest`，完成后提示退出再启动。`DSH_TUI_NO_UPDATE_CHECK=1` 可关掉。`/status` 里也能看到当前插件版本、链路芯片、额度窗口，以及子代理模型是否与父路由同族。

仓库内也可：`bash scripts/smoke-headless.sh`（记录出口摘要，不打印 token）。

### 方式一：从 git clone 安装

```bash
git clone https://github.com/cyjyyd/dsh-ssh-tui.git
cd dsh-ssh-tui
bash scripts/install.sh            # 默认安装到 tui profile
```

安装到其它 profile（例如自定义 `work` profile）：

```bash
bash scripts/install.sh work
```

脚本会依次：安装依赖 → 构建 `lib/` → 通过 `dsh plugin --profile <name> add link:<repo>`
把插件链接进 profile，并自动把 `dsh-ssh-tui` 加入该 profile 的 `dsh.profile.bundles`。

### 方式二：手动安装

```bash
cd dsh-ssh-tui
npm install --no-audit --no-fund
npm run build
dsh plugin --profile tui add "link:$(pwd)"
```

Windows（PowerShell）等价写法；仓库里的 `scripts/*.sh` 是 POSIX 脚本，Windows 直接用下面三条命令：

```powershell
cd dsh-ssh-tui
npm install --no-audit --no-fund
npm run build
dsh plugin --profile tui add "link:$((Get-Location).Path)"
```

### 方式三：指定其它 profile

```bash
dsh plugin --profile work add dsh-ssh-tui
# 或仓库脚本
bash scripts/install-npm.sh work
```

### 智能路由模式（dsh-routing-suite）

需要“智能路由模式”时，安装 `dsh-routing-suite` 并注册其 preset：

```bash
bash scripts/install-routing-suite.sh          # 默认 tui profile
bash scripts/install-routing-suite.sh work     # 其它 profile
```

脚本会执行 `dsh plugin --profile <name> add dsh-routing-suite`，并把包内的
`preset/routing-suite` 复制到 `$DSH_HOME/.agent-presets/routing-suite`，
这样 TUI 的 `/mode` 菜单才能选择“智能路由模式”。该插件需要 `webServer`
服务，脚本会在 profile 的 `cordis.patch.yml` 中挂载一个仅监听
`127.0.0.1` 随机端口的 `dsh-host-webserver`，不会对外开放端口。

## 启动与命令行参数

```bash
dsh --profile tui                          # 直接进入主界面（新建会话）
dsh --profile tui --resume                 # 打开历史会话选择器
dsh --profile tui resume                   # 同上（选择器）
dsh --profile tui --resume <session-id>    # 直接恢复指定会话
dsh --profile tui resume <session-id>      # 等价写法
dsh --profile tui --new                    # 显式新建会话（默认即新建，供脚本使用）
dsh --profile tui --model deepseek-v4-flash
dsh --profile tui --provider <id>
dsh --profile tui --no-color
```

选择器操作：一页固定 9 条，空筛选时 `1-9` 对应屏幕上每一项，`0` 新建。`↑`/`↓`（或 `Ctrl+P`/`Ctrl+N`）移动高亮，`Enter` 恢复当前项。输入文字（或 `/` / `Ctrl+F`）按标题、会话 ID、工作目录筛选；`PgUp`/`PgDn` 翻页，`Esc` 先退出筛选再取消。历史列表本身不截断。选择器先用会话头画出列表，标题在后台补齐；标签缓存在 `$DSH_HOME/tui-session-index.json`。新建/恢复会立刻画出启动屏，前端不再等插件加载完才拉 Host。恢复历史会话时跳过 token chunk，首屏只排可见尾部。

## 交互与快捷键

| 键 | 作用 |
| --- | --- |
| `Enter` | 发送；运行中则插入指示；空输入且已选卡片时展开/收起。工具正文超出窗口则单独全览，`Esc` 返回 |
| `↑` / `↓` | 空输入：在卡片间移动；有输入：历史（↓ 越过最新一条会回到当前草稿）。与 `Ctrl+N` / `Ctrl+P` 相同 |
| `Ctrl+R` | 展开最新一条卡片；已用 ↑/↓ 选中时全部展开或全部收起 |
| `Ctrl+T` | 折叠输入框（只影响显示） |
| `Alt+1` / `2` / `3` / `4` | 跳到最新思考 / 计划 / 子代理 / 回复 |
| `/find [类] 关键字` | 搜索并跳到该条完整消息（反色高亮）。类：`思考` `计划` `子代理` `回复` `提示词`。`Ctrl+/` 或 `Alt+/` 打开 |
| `Ctrl+G` / `Alt+N` | 下一条搜索结果；`Alt+P` 上一条 |
| `/copy` | 把焦点卡片纯文本写入本机剪贴板（无焦点则最近一条回复；支持 OSC 52 的终端/tmux） |
| 鼠标左键 | 点击卡片标题展开/收起；点 markdown 链接则复制 URL |
| `PgUp` / `PgDn`、滚轮 | 转录回看 |
| `Esc` | 取消选择 → 回底部 → 取消当前轮次 |
| `Ctrl+C` | 中断当前轮次；空闲连按两次退出 |
| `Ctrl+D` | 退出 |
| `Ctrl+L` | 重绘整个画面 |

`/mode` 切换官方 preset：标准 (`standard`)、PTC (`ptc`；dsh 0.1.1 上仍是 `code`)、极简 (`minimal`)、创造 (`cordis`)，以及本地安装的其它模式。

斜杠命令：`/help`、`/find`、`/copy`、`/model`、`/effort`、`/provider`、`/language`（`/lang`）、`/view`、`/disconnect`、`/approval`（`auto` / `off` / `status`）、`/submodel`、`/subeffort`、`/mode`、`/resume`、
`/status`、`/diag`、`/subagents`、`/usage`（`/balance`、`/quota` 同义）、`/setup`、`/clear`，
界面语言：`/language` 打开选择器，或 `/language zh` / `/language en` 直接切。优先 `DSH_TUI_LANG`，其次 `$DSH_HOME/settings.yaml` 的 `ssh-tui.language`，再跟 `LANG`/`LC_MESSAGES`。未知和 `C` locale 默认中文。
工作区视图：`/view` 在 **详细**（默认，看见思考和单条工具）和 **极简** 之间切换，写入
`ssh-tui.view`。极简对齐 Codex：藏思考，按「回复 → 已调用 N 个工具 → 已编辑 N 个文件 →
下一段回复」交错绘制；合并卡头部带 git 红绿增删行数（`-13 +24`），Enter 展开条目（编辑
展开后画 diff），状态球只有全失败才红；进行中的计划仍钉在输入框上方。这和 `/mode`
（agent preset）不是一回事。
以及 harness 自带命令（`/goal`、`/plan`、`/compact` 等）。底栏第二行（身份行）在剩余额度
后面用 1 列 Braille 圆环显示当前模型窗口占用（来自 DSH `contextPressure`，与提供商无关），
绿 / 黄 / 红对应正常 / 80% / 95%。占用到约 80%/95% 会提示；空闲且占用到约 72% 时
自动跑 `/compact`，避免等回合中途再压才撞窗。
`/compact` 进行中会显示「压缩上下文」卡片和底栏转圈，结束时写出回收的 token 数。
模型请求失败会显示重试进度；会话标题由模型生成后写到窗口标题。harness 命令若声明
支持图片附件，会在命令列表和补全提示中标注“可附图”。

`/model` 只换**当前提供商**的模型和思考强度。已经在 SuperGrok 时，直接选
`grok-4.6` / `grok-4.5`（`grok-4.6` 含 `xhigh`）。要换 DeepSeek / OpenCode /
其它路由用 `/provider`：先选提供商，再选模型，**下一步请求生效，不用重启**。
每个提供商上次的模型和思考强度会分开记住。`/setup` 只新增或更新当前这条
API Key 提供商，不会冲掉其它路由。SuperGrok / X Premium 走本机 OAuth，不需要填 Key。

子代理默认跟随父会话的提供方，并尽量选同一家的轻量模型：按父会话所选模型名
近似匹配，`flash` 结尾的优先——DeepSeek 用 `deepseek-v4-flash`，xAI 用
`grok-4.5`。`/model` 或 `/provider` 换提供商（OAuth / API Key 都一样）时会
**自动落盘**子代理模型（不弹窗；想手动改再用 `/submodel`）：

- `/submodel [model-id]`：打开子代理模型选择器；带参数时直接指定模型；
- `/subeffort`：选择子代理思考强度，或恢复为“跟随提供商默认”；
- `/subagents`：列出活动子代理；`/subagents kill <session-id> [更多 id...]`
  可释放指定的 continuable 子代理（harness 0.1.1 新增的定向回收能力）。

中断的流式输出会保留已生成的部分，并显示 `⚠ 已中断` 标记；团队协作类会话事件
（`team/*`）也会以系统消息形式显示在转录区。

子代理不再把子会话内容平铺进主转录：每个子代理一张卡片，默认折叠，只显示
`子代理 spawn [id] 运行中 · Ns · 最近活动`。`Enter` / 鼠标点击展开该子代理自己的
用户消息、工具调用和结果；没有选中卡片时 `Ctrl+R` 展开最新一条，选中后才全部展开/收起。运行中的卡片带旋转
动画，状态栏和窗口标题显示 `⠋ 子代理 N`。

计划条只钉**最新一条未完成的计划**。同一轮次里模型再开新计划时，旧计划归档进
工作区随转录上滚，底栏换成新计划。任务全部完成后计划条会说「计划任务已全部完成」，
不再误报「计划模式已关闭」。一轮结束时若待办仍是进行中/待处理，计划条改成「本轮未收尾」并停止转圈，
同时自动追问模型补一次 `todo_write`（同一列表只问一次，不改会话里的旧状态）。
打开 `/` 命令选单或批准/提问对话框时，计划条让出底栏。
`exit_plan_mode` 按 markdown 渲染。`ask_user_question` 仍弹对话框，并留下折叠的
`提问用户` 卡片。`/goal` 是折叠的 `目标` 卡片。`/find 思考 padAnsi` 或 `Alt+1..4`
可跳到对应类别的最新卡片。

`/usage`（`/balance` 同义，旧名 `/quota` 仍可用）按**当前提供商**查额度或余额：

- **DeepSeek 官方**：`GET {baseURL}/user/balance`（文档接口），显示可用/赠送/充值余额；
- **OpenAI Completions 兼容网关**：按配置的 base URL 探测 `/user/balance`、`/dashboard/billing/credit_grants` 等；
- **SuperGrok**：`GET cli-chat-proxy.grok.com/v1/billing`，显示本周剩余%；
- **OpenCode Go**：官方 `/v1/usage`，滚动 5 小时 / 本周 / 本月剩余%；
- **OpenCode Zen**：按量计费、没有固定额度，提示到 `https://opencode.ai/zen`。

OpenCode Go / SuperGrok 启动和运行中都静默查询，底栏显示套餐名 + 剩余条 + 百分比；窄屏先丢掉套餐名，只留条和百分比。DeepSeek 官方和可查询的 OpenAI 兼容网关把剩余余额画进底栏（`余额 86.42 CNY`）。跨过 50% / 25% / 10% / 5% 才往工作区打 ⚠。`/usage` 或 `/balance` 仍打印完整结果。查询默认每 **10 步**一次；小时窗口接近阈值时改 4 步。

## 配置

### 模型默认值（`$DSH_HOME/settings.yaml`）

```yaml
agent-default-model:
  provider: opencode-go
  model: deepseek-v4-pro
  reasoningEffort: max
agent-presets:
  default: standard
ssh-tui-subagent:
  model: deepseek-v4-flash
  # provider 可省略：省略时子代理跟随父会话提供方
  # reasoningEffort 可省略：省略时跟随提供商/模型默认
ssh-tui:
  language: zh   # 或 en；/language 写入这里。DSH_TUI_LANG 优先
  view: detailed # 或 compact；/view 写入这里
```

`/model`、`/mode`、`/submodel` 与 `/subeffort` 的修改会写回这里，
web 端与 TUI 共用同一份设置。`/model` 换提供商后**下一步请求生效**，不必重启。
每个提供商上次的模型和思考强度记在 `ssh-tui-routes` 里，切回 SuperGrok / 官方 / Go 时会预填。
`/setup` 只更新当前这条提供商（模型列表会合并），不会删掉其它路由的 Key 和模型。

对 OpenCode 和其他第三方提供商，`/model` 会先调用提供商的端点
（`GET {baseURL}/models`）获取实时模型列表；端点不可达时回退到已配置的
模型列表。若选中的模型尚未写入提供商配置，会自动追加到
`llm-pi-ai.providers.<id>.models`，保证 Harness 可以正常调用。

首次配置向导的自定义/OpenCode 提供商步骤中，输入模型 ID 前可按
`Ctrl+F` 直接从端点拉取模型列表，免去手动输入。

### profile 用户层

每个 profile 的 `cordis.patch.yml` 是用户覆盖层，可覆盖插件 patch 的任何行；
`--patch <file>` 可临时叠加。

## 验证

```bash
bash scripts/verify.sh              # 检查 profile 组合与 CLI 语法
npm test                            # 单元 + 集成（含屏幕网格护栏、重连接管、选择器首帧）
python3 scripts/pty-acceptance.py   # 真 PTY：模拟 40ms SSH 链路 + 滞留的光标回复
node scripts/tui-probe.mjs          # 真 PTY：真 dsh --profile tui 走一遍启动/缩放//diag/打字//exit
```

或手动：

```bash
dsh --profile tui --dump-config | grep -A12 'id: ssh-tui'
dsh --profile tui --help
```

`pty-acceptance.py` 用真 PTY 跑一遍接入：终端像 SSH 客户端那样隔一个 RTT 才回
`CSI 6n`，并且有两条「上一个 launcher 发出、仍在路上」的滞留回复（一条已在队列里，一条
落在探测窗口中间），按键在探测还没结束时就敲下去。脚本检查输入是否原样（且只送一次）
送达 Host、测得的 RTT 是否接近模拟值、屏幕上有没有被回显的 `^[[17;1R`。第一个参数可改
模拟延迟（秒）：`python3 scripts/pty-acceptance.py 0.12`。

`tui-probe.mjs` 直接用真 PTY 驱动 `dsh --profile tui`：等启动横幅与空闲状态、缩放窗口后
断言刚才那一帧不是已结束的选择器的重绘、跑 `/diag` 并检查判定链、打字是否上屏、`/exit`
是否把终端（含备用屏）交还。`npm test` 里的屏幕级用例用 `@xterm/headless` 断言**屏幕网格**
（残留行、越界寻址、光标越界、缩放风暴、选择器交还备用屏、footer 链路芯片），探针补的是
只在真宿主上才存在的部分。跑探针请用一次性 home，避免碰到真实会话：

```bash
H=$(mktemp -d); mkdir -p "$H/sessions" "$H/tui-locks" "$H/tui-socks"
ln -s ~/.dsh/profiles "$H/profiles"; cp ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml "$H/"
PROBE_HOME=$H node scripts/tui-probe.mjs           # 自建会话，退出时删掉
PROBE_HOME=$H node scripts/tui-probe.mjs --session <id>   # 只读式驱动已存在会话，绝不删除
```

探针拒绝在 `sessions/`、`tui-locks/`、`tui-socks/` 分居两处（含符号链接）的 home 上运行——
那种布局会让 Host 持有真实会话的写锁却对用户的选择器不可见（2026-09-11 事故形态）。

## 卸载

```bash
bash scripts/uninstall.sh           # 默认 tui profile
bash scripts/uninstall.sh work      # 指定 profile
```

卸载只移除 profile 中的插件依赖与 bundle 层，不会删除会话数据。

## 隐私与上传安全

- 所有会话、凭据、设置都保存在 `$DSH_HOME`（默认 `~/.dsh`），**不落在本仓库**；
- `.gitignore` 已排除 `node_modules/`、`lib/`、`.env*`、`*.key`、`session*.jsonl*`、
  `sessions/`、日志与临时文件；
- 上传前请自查：`find . -type f | grep -Ei 'credential|\.env|\.key|session'`；
- 插件本身不收集、不上传任何数据；会话日志仅按需读写于本机 `$DSH_HOME`；
- 首次配置可能会在 shell rc（`.bashrc` / `.zshrc` 等）写入 `env.sh` 引用以便启动环境覆盖生效；
  若不希望改动 rc，可设置 `DSH_TUI_NO_RC_HOOK=1` 跳过。

## 开发与目录结构

```text
src/index.ts        插件入口：启动选择器、会话创建/恢复/切换、session lock
src/startup.ts      命令行参数解析（--resume / --new / --model ...）
src/picker.ts       启动历史会话选择器（可见页 9 条，列表不截断，可筛选）
src/session-list.ts 历史会话扫描与标签（共享给 /resume）
src/session-lock.ts 同会话防双开
src/update-check.ts npm 最新版提示（不自动升级）
src/tui.ts          终端渲染、交互、标题/铃声（SshTui；叶子函数再导出）
src/paint.ts        增量绘制、SSH 节拍、选择器窗口
src/term-text.ts    宽度/折行/markdown
src/footer.ts       底栏、占用环、/status
src/stats.ts        会话统计（回合/步数、LLM 与工具耗时、TTFT、tok/s、用量去重）
src/rows.ts         转录行存储与可见窗口（保留上限、工具卡合并、计划行、滚动切片）
src/dialogs.ts      对话框状态机（问题列表/确认/查看覆盖层的按键规则）
src/commands.ts     斜杠命令目录与补全建议
src/plan.ts         计划条、待办、/find
src/tool-present.ts 工具卡、diff
src/auto-approval.ts 规则初审
src/approval-reviewer.ts AI 复核提示词与 JSON 解析
src/i18n/           中英界面字典（/language、DSH_TUI_LANG）
cordis.patch.yml    dsh bundle patch（仅 insert ssh-tui-startup / ssh-tui）
scripts/            安装 / 卸载 / 验证脚本
```

```bash
npm install
npm run typecheck
npm run build
```

## 常见问题

- **`dsh-ssh-tui: both stdin and stdout must be TTYs`**：必须从真实终端/SSH 会话启动。
- **Windows 报 `dsh-ssh-tui: host display socket did not appear`**：0.5.7 及更早版本把显示通道
  当成 Unix socket（`$DSH_HOME/tui-socks/*.sock`），而 Windows 只能监听 `\\.\pipe\` 命名管道，
  Host 进程绑定失败；旧版本还用 `fs.access()` 判断通道是否就绪，而 Windows 的文件 API 看不到
  命名管道，所以即使 Host 已经起来也只会等到 15 秒超时。0.5.8 起 Windows 自动改用命名管道
  （按 `DSH_HOME` + 会话 id 生成唯一管道名），就绪判断改为真实连接探测，并在 Host 提前退出时
  立即报错并附带其 stderr。升级到 0.5.8 即可：`dsh plugin --profile tui add dsh-ssh-tui@latest`。
- **pnpm 拒绝 git 依赖的构建脚本**：git 安装的插件需要把 pnpm 打印的 key 加入
  profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`。
- **标题栏或铃声不生效**：确认终端支持 OSC 0 与 BEL；铃声可用
  `DSH_TUI_NO_BELL=1` 关闭。
- **滚轮误触取消**：已加入转义序列缓冲，网络拆包也不会把 `ESC` 当取消。
- **跳板机 / 多层代理 SSH 发画**：每一帧只发脏行，并且拼成一次 `stdout.write`。本机 80 ms；SSH 启动时用 CSI 6n 测往返，按 RTT 选 80/160/250/400 ms。`DSH_TUI_PAINT_MS` 始终优先（40–1000）。统计行最左是 `SSH ●●●○ 90ms`（一格红、两格黄、三格及以上绿）。探测不写进转录。
- **SSH 断了**：空闲则 flush 后退出（不保活）。忙碌（思考/回复/工具/子代理）则默认取消当前轮次、flush 日志，Host 留下。`/disconnect continue` 则不取消，后台跑完。回来 `--resume` 会接入那个进程（见上文）。不要再开第二份 Host。
- **提示会话已在 pid 运行 / 可接入**：那份 Host 还活着。用 `--resume` 接入；只有 pid 已死、显示通道也连不上时才删 `$DSH_HOME/tui-locks/` 再从日志恢复。
  Windows 没有 `/proc`，0.5.8 起会用 `Get-Process` 核对 pid 的镜像名与创建时间：pid 被系统回收给
  别的进程时会被判定为陈旧并自动接管，不再出现「明明没有 Host 却报 zombie」。
- **状态栏没有速度指标（`tok/s`）**：第一行统计里的速度只在该轮有模型 token 时出现；只有首字耗时可算
  时显示 `首字 1.2s`。0.5.8 修复了两处：实时流的 chunk 帧不带 turn/step，旧版会把它们归到第 0 步
  导致速度永远是 0（顺带把 token 数重复计了一次）；`--resume` 重放日志时也不再用实时增量，而是从
  日志里的 `assistant/chunk`（0.1.2）或消息内嵌的打包流（0.1.5）重建首字时间，恢复会话同样显示速度。
- **断线后第一次 `--resume` 报 `write EPIPE`、第二次才接上**：三处互相叠加。其一，Host 掉线时按"掉线那一刻"的状态
  决定去留，若它正在取消/落盘收尾，这时重连进来的显示端会被连同进程一起 dispose（表现就是第一次接入 EPIPE）；
  现在收尾期间若有新 relay 完成 HELLO，就保留 Host 不退出。其二，就绪判断过去用 `fs.access` 看 `.sock` 文件在不在——
  被杀的 Host 留下的空文件也算"就绪"，relay 往死 socket 写 HELLO 就 EPIPE，而且这种条目会被选择器当成
  「可接入」优先排在最前面；现在就绪一律以真实连接探测为准，死会话判陈旧并连残留文件一起清掉。
  其三，launcher 首次接入若立刻 EPIPE/ECONNRESET，会自动等待并重试一次，不必手动再跑一遍。
- **断线重连会多出一行提示、还会闪出 `^[[17;1R` 之类的字符、延迟芯片变四个空心圆**：0.5.9 的自动重试会把
  "正在收尾，稍候重试"打到屏幕上，而两次尝试之间终端回到 cooked 模式，上一次探测的 DSR 回复正好被回显；
  同时重连时的整屏重绘会让终端的回复错过探测窗口，Host 收到"未知"就把已有测量擦成 `SSH ○○○○`。
  现在：自动重试默认**静默**（`DSH_TUI_DEBUG=1` 才打印）；重试/等 Host 启动期间保持 raw 模式并丢弃排队字节，
  不再回显；探测失败会自动补测一次，Host 侧也不会用"未知"覆盖已知测量。
- **resume 选择器第一批列表出现不认识的会话**：第一轮列表是"骨架"（活着的 Host 只拿会话 id 当标题）。
  现在列表压到标题读出来之后再画：期间显示「正在读取历史会话…」，标题全空时最终列表仍会画出以便选择。
- **要给支持者一份可读的排障信息**：在会话里敲 `/diag`。它只读本地信息、不外传，输出
  插件/dsh/node 版本、平台、会话 id、当前进程是启动器还是后台 Host、`DSH_HOME`、显示通道地址与
  可连接性（含"残留 socket 文件"判定）、Host 的 pid/身份核对/锁状态/agent 状态、锁文件路径、
  链路 RTT 与绘制间隔、会话日志格式与大小、本机其它会话的锁，最后是**判定链**——例如
  "会接入后台 Host（pid N），不要另起第二个窗口"、"pid 被回收成别的程序"、
  "通道上留着不响应的 socket 文件，这正是第一次接 EPIPE 的来源"。报 issue 时贴这段即可。
- **TUI 里进得去、Web 里打不开同一个会话**：会话的写锁（`session.lock`）是内核锁，同时只允许一个写者。
  SSH 断开时那个还在跑轮的 Host 会留着锁，于是 Web 端打开时报
  `resume failed for session "…" is already owned by an active write handle`——从 0.5.10 起
  该 Host 在轮次结束后最多再等 1 分钟就退出并放锁（`DSH_TUI_IDLE_EXIT_MS`/`ssh-tui.idleExit`）。
  若锁仍被某个 Host 占着，`--resume` 接入它即可正常继续（选择器里那条会话会标「可接入」）。
- **断线重连后锁被标成「已暂停」/「接入中」，但窗口其实已经关了**：0.5.10 修掉了一个状态机 bug。
  重连接的 relay 在 hangup 收尾期间 HELLO 后，Host 会记下"这次 hangup 要采纳它"的标记；但 hangup
  走保留 Host 分支时没有清掉这个标记，于是**下一次真实掉线整个被忽略**：锁仍写着上一个状态
  （例如「已暂停」），空闲退出计时器也不会武装。现在只要轮次重新开始（说明那场竞争早已结束），
  标记就会归零，掉线、锁状态与空闲退出都以真实事件为准。
- **状态栏看不到子代理模型**：0.3.6 起 `sub:<模型>` 只在子代理模型与父模型不同时才拼进身份行，
  而默认子代理模型就是 `deepseek-v4-flash`，父模型也是它时整段消失；0.5.8 起恢复为始终显示，
  并找回提供商前缀与 `/subeffort` 的括号后缀（提供商要先在 `settings.yaml` 的 `ssh-tui-subagent.provider`
  里固定过）。查看或修改：`/status`、`/submodel`、`/subeffort`。
- **缩放终端窗口时整屏闪烁、还闪出历史会话选择器**：启动选择器注册 `resize` 监听时用的是匿名函数，
  退出时却按 `render` 这个引用去注销，于是监听器一直留在中继进程里（中继要活整个会话）。之后每次
  缩放终端，那张已经结束的选择器都会被整屏重画一遍（`\x1b[H\x1b[J` + 整屏内容），紧接着再被 TUI
  的整屏重画覆盖——看起来就是闪两下并闪出选择器内容。0.5.8 起改用命名监听器注销，并给已结束的
  选择器加 `done` 守卫：结算后再触发 `resize` 一个字节都不会写（有回归测试）。

## License

MIT，见 [LICENSE](LICENSE)。
