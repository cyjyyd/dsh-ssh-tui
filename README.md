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
  身份里始终带 `sub:<子代理模型>`（如 `sub:grok-4.5(xhigh)`）：`/submodel` 选模型、`/subeffort` 选档位（带括号后缀）；
  只显示模型名——提供商与完整路由在顶栏与 `/status`；
- 恢复旧会话会切到该会话记录的工作目录；新建会话用启动时的当前目录；
- 历史会话启动选择器：`dsh --profile tui --resume`（或 `resume`）先选会话再进入；
- 终端窗口标题栏：运行中旋转图标 + `运行中 · 工具 N`，完成后 `✓ 已完成`，并响
  一声终端铃（`DSH_TUI_NO_BELL=1` 关闭）；
- 审批、`ask_user_question`、计划模式、子代理进度、`/mode` 模式切换、`/model` 模型切换、
  `/disconnect` 断线策略等完整支持；
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

- 0.7 起：模型回复可**拖选自由复制**（按住拖过一段，走 OSC 52 写回本机剪贴板；工具卡仍是点击展开）；
  底栏收敛成一条带优先级的芯片带（先丢文字后丢组，`⚠` 可点击打开 `/doctor`）；**额度条常驻**并标注窗口
  （`5Hr`/`1Wk`/`1Mo`，默认显示最小窗口，未取到时显示 `?%` 并每 15 秒重试）；`/mode` 分组显示并可用 `/` 过滤；
  极简视图逐文件列 `+/-`；工具 diff 为**行级**、只高亮变化字符、≥100 列时并排显示；
  `DSH_TUI_LINE_MODE=1` 纯行模式（屏幕阅读器 / `tee`）；`ssh-tui.keys` 可改键位（冲突会明确拒绝）；
  `DSH_TUI_COLOR_DEPTH` 指定色深（truecolor / 256 / 8 / none）。

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

按键可改：`ssh-tui.keys`（动作 `pageUp` / `pageDown` / `toggleCard` / `copy` / `cancel`，如 `keys: { pageUp: ctrl+b }`）。
冲突或未知的名字**不会静默生效**：启动时提示，且该键保持默认或变成无操作。
纯行模式：`DSH_TUI_LINE_MODE=1`（或 `ssh-tui.lineMode: true`）——不画帧，逐事件追加纯文本行，
适合屏幕阅读器、`tee` 与录屏；代价是全屏交互（鼠标拖选、卡片展开、`/find` 高亮）不可用。
就自行退出并让出锁：这段时间够原窗口重连接入，之后 `--resume` 重新打开已落盘的日志。
完全没有显示器且一直空闲的兜底仍由 `DSH_TUI_DETACHED_IDLE_MS`（默认 6 小时）负责。可选：用 tmux 包一层。
常驻与接管的可复制配方（tmux / screen / systemd --user / 长任务）见 [`docs/remote-ops.md`](docs/remote-ops.md)；重连后转录里的「已重连 N 次 · 断开 Xs」与「离开 …」两行的语义也在那里。

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
把插件链接进 profile，自动把 `dsh-ssh-tui` 加入该 profile 的 `dsh.profile.bundles`，
最后把 `/mode` 需要的 preset 名单行写进该 profile 的 `cordis.patch.yml`（见下节）。

### `/mode` 的 preset 名单（agent-presets 行）

`dsh-base` 的终端 profile 不组合 preset 名单（只有 Web 端的 `dsh-web-app` 组合包会），
而 DSH STORE 只接受「附加式、插件自有 id、不出现 `@deepseek-ai/*` 名字」的 Bundle Patch，
所以插件自己的 patch 不能挂载官方行 —— 名单行归 profile 的用户层。名单不只是
`/mode` 的菜单：`ask_user_question`、`present`、PTC 的呈现层、`subagent` 的模型选择
这些工具行都由 preset 提供，缺席时它们都不在 Agent 的工具目录里。

三种修复方式（幂等，选一即可）：

1. **运行中的应用内修复**：`/mode fix` 写入下面这段并提示重启。npm 安装和
   「现在更新」走的是 `dsh plugin add`，不会执行仓库脚本，所以这是最通用的一条。
2. 仓库安装：`bash scripts/ensure-profile-rows.sh [profile]`（默认 `tui`）。
3. 手动在该 profile 的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里加入：

```yaml
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
```

脚本会一并挂载 `code-runtime`（PTC 模式需要的 TypeScript 运行时）和
`subagent-model-selection-settings`（宿主侧子代理委派设置），并跳过已经组合了名单的
profile（例如同时装了 `@deepseek-ai/dsh-web-app` 的 profile）。改完重启 TUI 生效。
反过来，已经写了这段的 profile 之后再装 `dsh-web-app` 会让名单行出现两次（第二次挂载
会以 `service "agentPresets" has been registered` 失败），先把 profile 补丁里的这段删掉。

名单缺席时，TUI 启动会打一行提示（中文界面：「未挂载 agent-presets 名单…」），
`/mode` 会打印补丁路径和 `/mode fix` 修复入口，`scripts/verify.sh` 也会给出提示。
另外，preset 的 scope 身份按模块实例判定：一个 dsh 安装树里若存在两份
`@deepseek-ai/dsh-scope`（npm 嵌套安装的 checkout 可能如此），名单挂载会以
`refusing to compose an unscoped context` 失败；全局安装（`npm i -g`）不受影响。

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

选择器操作：一页固定 9 条，空筛选时 `1-9` 对应屏幕上每一项，`0` 新建。`↑`/`↓`（或 `Ctrl+P`/`Ctrl+N`）移动高亮，`Enter` 恢复当前项。输入文字（或 `/` / `Ctrl+F`）按标题、会话 ID、工作目录筛选；`PgUp`/`PgDn` 翻页，`Esc` 先退出筛选再取消。历史列表本身不截断。**读取是懒加载的**：首批固定 9 条，全部拿到标题后才上屏（屏幕上不会出现先显示会话 id、过一会儿又变成标题的行）；更早的会话只有你去够的时候才读——在最后一条继续按 `↓`/`PgDn`，或按 `End`，或输入筛选（筛选会自己往更早的历史里找）。标签缓存在 `$DSH_HOME/tui-session-index.json`。新建/恢复会立刻画出启动屏，前端不再等插件加载完才拉 Host。恢复历史会话时跳过 token chunk，首屏只排可见尾部。

## 交互与快捷键

| 键 | 作用 |
| --- | --- |
| `Enter` | 发送；运行中则插入指示；空输入且已选卡片时展开/收起。工具正文超出窗口则单独全览，`Esc` 返回 |
| `1..9` / `Enter` | 回答 `ask_user_question` 提问：`1..9` 直接选，`Enter` 取当前高亮项（默认第一项），`Esc` 才取消 |
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

`/mode` 切换官方 preset：标准 (`standard`)、PTC (`ptc`；dsh 0.1.1 上仍是 `code`)、极简 (`minimal`)、创造 (`cordis`)，以及本地安装的其它模式（如 `routing-suite`）。
官方 preset 的名字跟 `/language` 走（中文下显示“标准模式 / 极简模式 / PTC 模式 / 创造模式”，
英文下显示 Standard / Minimal / PTC / Cordis）；`$DSH_HOME/.agent-presets` 里自己写的
preset 保留它 `preset.yml` 里的名字不翻译。`/mode <id|名字>` 直接切，比如
`/mode minimal`、`/mode 极简模式`；当前会话已经跑过一轮时只记住选择，下次启动生效。
名单没挂载时启动会打一行提示，`/mode` 会打印 profile 补丁路径和 `/mode fix` 修复入口（见「`/mode` 的 preset 名单」）。

斜杠命令：`/help`、`/find`、`/copy`、`/model`、`/effort`、`/provider`、`/language`（`/lang`）、`/view`、`/disconnect`、`/approval`（`auto` / `off` / `status`）、`/submodel`、`/subeffort`、`/mode`、
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
- **Command Code**：官方 `/alpha/billing/credits`，滚动 5 小时 / 本周剩余% + 月度额度余额（USD）；
- **OpenCode Zen**：按量计费、没有固定额度，提示到 `https://opencode.ai/zen`。

OpenCode Go / Command Code / SuperGrok 启动和运行中都静默查询，底栏显示套餐名 + 剩余条 + 百分比；窄屏先丢掉套餐名，只留条和百分比。DeepSeek 官方和可查询的 OpenAI 兼容网关把剩余余额画进底栏（`余额 86.42 CNY`）。跨过 50% / 25% / 10% / 5% 才往工作区打 ⚠。`/usage` 或 `/balance` 仍打印完整结果。查询默认每 **10 步**一次；小时窗口接近阈值时改 4 步。

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

向导会尽量自动填好上下文窗口：先读端点 `/models` 的容量字段，查不到再按模型名
去内置 pi-ai 目录匹配（会剥离提供商写进模型名的思考档位后缀 `-high` / `-low` /
`-thinking`，以及 `vendor/` 前缀、`:free` 标签、日期戳），命中后逐模型写入
`contextWindow`。只有仍有模型查不到容量时，才多出一个「路由默认上下文窗口」步骤，
并把推导值预填好（取本路由已探明窗口的最小值，避免超声明）——直接回车采用，也可
输入其它数字；全部命中时该步骤自动跳过，不需要任何输入。保存的是路由级
`defaultContextWindow`，之后用 `/model` 新加的模型会继承它；而且 `/model` 追加
模型时本身也会先查一遍目录，命中就直接写入该模型的 `contextWindow`。

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
src/index.ts        插件入口：启动选择器、会话创建/恢复、session lock
src/startup.ts      命令行参数解析（--resume / --new / --model ...）
src/picker.ts       启动历史会话选择器（可见页 9 条，列表不截断，可筛选）
src/session-list.ts 历史会话扫描与标签（共享给启动选择器）
src/session-lock.ts 同会话防双开
src/update-check.ts npm 最新版提示（不自动升级）
src/tui.ts          终端渲染、交互、标题/铃声（SshTui；叶子函数再导出）
src/paint.ts        增量绘制、SSH 节拍、选择器窗口
src/term-text.ts    宽度/折行/markdown
src/footer.ts       底栏、占用环、/status
src/stats.ts        会话统计账本（回合/步数、LLM 与工具耗时、TTFT、decode 计数、用量去重）
src/rows.ts         转录行操作与可见窗口（内存上限、工具卡合并、计划行、滚动切片；行数组仍在 tui.ts）
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

## 常见问题（QA）

按现象查；每条只讲怎么办，不讲版本历史。

### 启动与安装

- **`dsh-ssh-tui: both stdin and stdout must be TTYs`**：必须在真实终端 / SSH 会话里启动；管道、CI、`&` 后台都不行。
- **Windows 报 `host display socket did not appear`**：升级到最新版：
  `dsh plugin --profile tui add dsh-ssh-tui@latest`。仍失败请附 `/diag` 输出提 issue。
- **Windows 上应用内更新报 `spawn dsh ENOENT`**：旧的更新器直接 `spawn dsh`，而 Windows 上装的是 `dsh.cmd` 垫片；
  在命令行跑一次同样的升级即可（`dsh plugin --profile tui add dsh-ssh-tui@latest`），之后应用内更新正常。
- **pnpm 拒绝 git 依赖的构建脚本**：把 pnpm 打印的 key 加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，再重装。
- **升级后 `/mode` 报「服务不可用」、preset 工具消失**：敲 `/doctor`。它逐项判定部署组合（补丁能否解析、
  名单与 code-runtime 是否组合、有没有行被挂载两次、dsh 版本是否在兼容表内、是否装着两份 `@deepseek-ai/dsh-scope`），
  每项给「结论 + 证据 + 修复命令」；`/doctor --fix` 会补齐 patch、写前留 `.bak-<时间戳>` 备份，重启 TUI 生效。
- **提示「会话已在 pid 运行 / 可接入」**：那个 Host 还活着，用 `dsh --profile tui --resume` 接入。
  **不要**再开第二个窗口；只有 pid 确实已死时才清 `$DSH_HOME/tui-locks/` 再从日志恢复。

### 会话与锁

- **Web 端打不开同一会话（`already owned by an active write handle`）**：SSH 断开时仍在跑轮的 Host 会持有写锁，
  轮次结束后最多 1 分钟自动退出并放锁（`DSH_TUI_IDLE_EXIT_MS` / `ssh-tui.idleExit` 可调）；也可以直接 `--resume` 接入它继续。
- **`--resume` 第一次报 `write EPIPE`、第二次才接上**：launcher 会自动等待并重试一次。若持续失败，
  用 `/diag` 看显示通道与锁的判定链（含"残留 socket 文件"这一常见来源）。
- **历史会话太多、认不出哪条是哪个**：在 `--resume` 选择器里按标题 / session id / 工作目录筛选（`/` 或 `Ctrl+F`），
  更早的历史会在筛选或翻到末尾时按需读取；计数行会显示还有多少条未加载。

### 显示与终端

- **Windows 下完全没有颜色（只有黑白）**：0.7.0 在 Windows 上把"未设置 `TERM`"误判为无终端。指定色深即可恢复：
  `set DSH_TUI_COLOR_DEPTH=8`（或 `256` / `truecolor`），也可以先看 `/diag` 的**配色**一行确认判定结果。
- **颜色不对，或 diff 整块一个颜色、看不清字**：显式指定色深 `DSH_TUI_COLOR_DEPTH=truecolor|256|8|none`。
  `256` 下 diff 是深灰底 + 绿/红字；`none` 完全没有颜色，但 `+`/`-`、`●`、`⚠`、`✖` 仍在，状态不只靠颜色表达。
- **中文 / emoji 挤压相邻字符**：换一款覆盖这些字形的等宽字体（如 Noto Sans Mono CJK）。程序按 2 格预算这些符号
  并请求文本字形；字体缺字时终端会回退到彩色 emoji 字形，视觉上仍可能偏宽。
- **弱网下画面跟不上**：`DSH_TUI_PAINT_MS` 控制发画间隔（40–1000 ms，越小越快也越费流量）；
  不设时按启动测得的 RTT 自动取 80 / 160 / 250 / 400 ms。
- **要给屏幕阅读器或日志用**：`DSH_TUI_LINE_MODE=1` 启动纯行模式——只追加纯文本行、不发光标控制，可直接 `tee` 存档。
- **标题栏 / 铃声不生效**：终端需支持 OSC 0 与 BEL；`DSH_TUI_NO_BELL=1` 可关闭铃声。
- **深色终端下整行底色太抢眼**：`DSH_TUI_COLOR_DEPTH=none` 去掉底色，diff 仍用 `+`/`-` 区分。

### 状态栏与额度

- **额度条显示 `░░░░░░░░ ?%`**：**还没拿到读数**（接口慢或不通），不是 0%。TUI 每 15 秒重试一次，拿到后自动替换成
  真实数值与窗口；一直不变成数值时用 `/quota` 看具体报错。
- **没有额度条**：只有 SuperGrok / OpenCode Go / Command Code 有额度；DeepSeek 显示的是余额行，Zen 是计量制。
- **`5Hr` / `1Wk` / `1Mo` 是什么**：该数值所属的额度窗口。默认显示**最小窗口**（5 小时 → 周 → 月），
  `/quota` 列出全部窗口、剩余比例与重置时间。告警仍按"最紧的那个窗口"触发。
- **状态栏模型名没有提供商前缀**：状态行只显示模型名（`provider/model` 会截断成模型名），完整路由在顶栏与 `/status`；
  `sub:` 子代理同理，只显示模型名。
- **看不到子代理模型 / 想换子代理**：`/submodel` 选模型、`/subeffort` 选思考档位，`/status` 查看当前值。
- **没有 `tok/s`**：该轮没有可统计的模型 token；只有首字耗时时显示 `首字 1.2s`。
- **计划条只提醒一次"补待办"**：有意如此——一条待办列表只问一次，避免每轮结束都开一个新回合。
  想再次触发，先把列表全部标成完成，再新开一列待办。

### 断线与代理

- **SSH 断了会怎样**：空闲则落盘后退出；忙碌（思考 / 回复 / 工具 / 子代理）默认取消当轮、保留 Host，
  回来 `dsh --profile tui --resume` 接入；`/disconnect continue` 则让它在后台跑完当前轮。**不要**再开第二个 Host。
- **重连后多出一行提示、闪出 `^[[17;1R` 之类的字符、链路芯片变空心**：升级到最新版；自动重试期间保持 raw 模式
  并丢弃排队字节，这些字符不会再被回显。
- **模型请求要走公司 / 本机代理**：给 dsh 进程加 `--use-env-proxy`（不要用 `NODE_OPTIONS`），并用 `NO_PROXY`
  按域名分流——国内直连更快的域名放进去，本地 / 内网地址务必保留在列表里。做法与回退见
  [docs/remote-ops.md §4.7](docs/remote-ops.md)。

### 排障入口

- **要给支持者一份可读的排障信息**：在会话里敲 **`/diag`**（只读本地信息、不外传）：版本、平台、会话 id、
  `DSH_HOME`、显示通道与可连接性、Host 的 pid / 锁状态、链路 RTT、日志格式与大小，最后是**判定链**
  （例如"会接入后台 Host（pid N），不要另起第二个窗口"）。部署组合问题用 **`/doctor`**。报 issue 时贴这两段即可。

## License

MIT，见 [LICENSE](LICENSE)。
