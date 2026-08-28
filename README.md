# dsh-ssh-tui

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
dsh plugin --profile tui add dsh-ssh-tui
dsh --profile tui
```

当前 `dsh` 必须带 `--profile`（`dsh plugin add …` 会报缺选项）。装进别的 profile 把 `tui` 换成那个名字即可。更新同一条命令。卸载：`dsh plugin --profile tui remove dsh-ssh-tui`。

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

协议（可复现，不靠模型估）：`npm run screenshots:slow` → `docs/screenshots/slow-link.json`。这次回放 14 次绘制、约 **15.5 KB**，在 2 kB/s 上大约 **7.6 s** 画完。数字是这条固定事件序的 stdout 字节账。

## 功能一览

- 纯终端渲染，无需浏览器/鼠标/重量级终端框架，适合慢速或远程 SSH；
- 模型思考流默认折叠，显示 `▸ 思考中 ⠹ · N 字 · Ns` 动画；结束后折叠为
  `▸ 已思考 · N 行`，可单独展开；思考过程中也能实时展开/收起查看原文；
- 工作区支持 markdown 渲染：多级标题（H1 放大/下划线、H2 下划线、H3 着色）、
  粗体、斜体、行内代码、代码块、列表、引用与链接；模型最终回复以粗体白色显示；
- 工具调用卡片化：彩色状态点（运行黄 / 成功绿 / 失败红）、shell 命令友好展示、
  编辑工具 git 风格 diff（`-` 浅红底 / `+` 浅绿底 / 文件统计，编辑卡片默认展开且
  diff 内容不截断）、JSON 参数与结果自动转可读内容；
- 转录区滚动回看（`PgUp`/`PgDn`、鼠标滚轮），点击思考/工具标题行直接展开收起；
- 输入框下方两行底栏：第一行链路芯片 + 按宽度丢组的会话数字（轮次、入/出 token、速度）；
  第二行只留一个活动词（运行中 / 工具 N / 子代理 N / 压缩中…），身份收到右侧；
- 历史会话启动选择器：`dsh --profile tui --resume`（或 `resume`）先选会话再进入；
- 终端窗口标题栏：运行中旋转图标 + `运行中 · 工具 N`，完成后 `✓ 已完成`，并响
  一声终端铃（`DSH_TUI_NO_BELL=1` 关闭）；
- 审批、`ask_user_question`、计划模式、子代理进度、`/mode` 模式切换、`/model` 模型切换、
  `/resume` 会话切换等完整支持；
- 每个子代理都是独立可折叠卡片，默认收起，运行中带旋转动画；多个子代理互不混排；
- 进入计划模式、待审计划、提问用户都会显示对应卡片和底部提示，而不是只塞进系统消息。

## 环境要求

- Node.js ≥ 22.19
- DeepSeek Harness CLI：`npm i -g @deepseek-ai/dsh`
- pnpm（`dsh plugin` 通过 pnpm 管理 profile 依赖）
- 支持 ANSI 的终端（推荐 SSH 直连；Windows 用 PowerShell / Windows Terminal）

## 部署指南

推荐安装就是文首那条 `dsh plugin --profile tui add dsh-ssh-tui`。CLI 会从 npm 拉包、写入 profile 依赖，并把本插件加入 `dsh.profile.bundles`（因为包内声明了 `dsh.bundle`）。

可选：本机已有 SuperGrok / grok-bridge token 时再装配套 OAuth：

```bash
dsh plugin --profile tui add github:cyjyyd/dsh-llm-xai-oauth
dsh plugin --profile headless add github:cyjyyd/dsh-llm-xai-oauth
```

先确认链路再开 TUI（无 TTY 时 TUI 会直接退出）：

```bash
dsh --profile headless "Reply with exactly: tui-install-ok. Do not use tools."
dsh --profile tui          # 必须在真实终端 / SSH 会话里
```

### SSH 断线后续跑（tmux）

弱网友好不等于断线后还能跑。合盖、跳板 idle、换网会杀掉当前 TTY 上的进程。
把 TUI 放进 tmux，断 SSH 只丢显示器，不丢 Agent：

```bash
tmux new -s dsh -- dsh --profile tui
# 断线后重新 SSH 进来
tmux attach -t dsh
```

同一 `sessionId` 不能开第二份 TUI（会抢 stdin 和审批）。第二份启动会退出并提示
`tmux attach`。锁在 `$DSH_HOME/tui-locks/`；进程异常退出后残留锁会在下次启动时
核对 pid，已死则自动接管。调试可设 `DSH_TUI_NO_SESSION_LOCK=1`。

启动时会查一次 npm 上的 `dsh-ssh-tui` 最新版，有更新只提示、不自动升级：

```text
发现新版本 dsh-ssh-tui 0.3.5（当前 0.3.4）。更新：dsh plugin --profile tui add dsh-ssh-tui
```

`DSH_TUI_NO_UPDATE_CHECK=1` 可关掉。`/status` 里也能看到当前插件版本。

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

选择器操作：`1-9` 选择历史会话；`0` / `Enter` 新建；`Esc` 取消退出。

## 交互与快捷键

| 键 | 作用 |
| --- | --- |
| `Enter` | 发送；运行中则插入指示；空输入且已选卡片时展开/收起 |
| `↑` / `↓` | 空输入：在卡片间移动；有输入：历史。与 `Ctrl+N` / `Ctrl+P` 相同 |
| `Ctrl+R` | 全部展开或全部收起 |
| `Ctrl+T` | 折叠输入框（只影响显示） |
| `Alt+1` / `2` / `3` / `4` | 跳到最新思考 / 计划 / 子代理 / 回复 |
| `/find [类] 关键字` | 搜索并跳到该条完整消息（反色高亮）。类：`思考` `计划` `子代理` `回复`。`Ctrl+/` 或 `Alt+/` 打开 |
| `Ctrl+G` / `Alt+N` | 下一条搜索结果；`Alt+P` 上一条 |
| 鼠标左键 | 点击卡片标题展开/收起 |
| `PgUp` / `PgDn`、滚轮 | 转录回看 |
| `Esc` | 取消选择 → 回底部 → 取消当前轮次 |
| `Ctrl+C` | 中断当前轮次；空闲退出 |
| `Ctrl+D` | 退出 |
| `Ctrl+L` | 重绘整个画面 |

斜杠命令：`/help`、`/find`、`/model`、`/provider`、`/submodel`、`/subeffort`、`/mode`、`/resume`、
`/status`、`/subagents`、`/usage`（`/balance` 同义）、`/setup`、`/clear`，
以及 harness 自带命令（`/goal`、`/plan`、`/compact` 等）。`/compact` 进行中会显示
「压缩上下文」卡片和底栏转圈，结束时写出回收的 token 数。模型请求失败会显示重试
进度；会话标题由模型生成后写到窗口标题。harness 命令若声明
支持图片附件，会在命令列表和补全提示中标注“可附图”。

`/model` 只换**当前提供商**的模型和思考强度。已经在 SuperGrok 时，直接选
`grok-4.6` / `grok-4.5`（`grok-4.6` 含 `xhigh`）。要换 DeepSeek / OpenCode /
其它路由用 `/provider`：先选提供商，再选模型，**下一步请求生效，不用重启**。
每个提供商上次的模型和思考强度会分开记住。`/setup` 只新增或更新当前这条
API Key 提供商，不会冲掉其它路由。SuperGrok / X Premium 走本机 OAuth，不需要填 Key。

子代理默认跟随父会话的提供方，并尽量选同一家的轻量模型：DeepSeek 用
`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`，xAI 用 `grok-4.5`。
`/model` 或 `/setup` 换提供商（OAuth / API Key 都一样）时会自动同步子代理：

- `/submodel [model-id]`：打开子代理模型选择器；带参数时直接指定模型；
- `/subeffort`：选择子代理思考强度，或恢复为“跟随提供商默认”；
- `/subagents`：列出活动子代理；`/subagents kill <session-id> [更多 id...]`
  可释放指定的 continuable 子代理（harness 0.1.1 新增的定向回收能力）。

中断的流式输出会保留已生成的部分，并显示 `⚠ 已中断` 标记；团队协作类会话事件
（`team/*`）也会以系统消息形式显示在转录区。

子代理不再把子会话内容平铺进主转录：每个子代理一张卡片，默认折叠，只显示
`子代理 spawn [id] 运行中 · Ns · 最近活动`。`Enter` / 鼠标点击展开该子代理自己的
用户消息、工具调用和结果；`Ctrl+R` 可一次展开或收起全部卡片。运行中的卡片带旋转
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

OpenCode Go / SuperGrok 启动和运行中都静默查询，底栏只显示剩余%；跨过 50% / 25% / 10% / 5% 才往工作区打 ⚠。`/usage` 或 `/balance` 仍打印完整结果。查询节奏按最紧窗口：5 小时额度每 10 轮（接近改 4 轮），周额度每 50 轮（接近改 10 轮），月额度每 80 轮（接近改 20 轮）。

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
```

或手动：

```bash
dsh --profile tui --dump-config | grep -A12 'id: ssh-tui'
dsh --profile tui --help
```

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
src/picker.ts       启动历史会话选择器
src/session-list.ts 历史会话扫描与标签（共享给 /resume）
src/session-lock.ts 同会话防双开
src/update-check.ts npm 最新版提示（不自动升级）
src/tui.ts          终端渲染、交互、统计、标题/铃声
cordis.patch.yml    dsh bundle patch（挂载 TUI 与 agent-presets）
scripts/            安装 / 卸载 / 验证脚本
```

```bash
npm install
npm run typecheck
npm run build
```

## 常见问题

- **`dsh-ssh-tui: both stdin and stdout must be TTYs`**：必须从真实终端/SSH 会话启动。
- **pnpm 拒绝 git 依赖的构建脚本**：git 安装的插件需要把 pnpm 打印的 key 加入
  profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`。
- **标题栏或铃声不生效**：确认终端支持 OSC 0 与 BEL；铃声可用
  `DSH_TUI_NO_BELL=1` 关闭。
- **滚轮误触取消**：已加入转义序列缓冲，网络拆包也不会把 `ESC` 当取消。
- **跳板机 / 多层代理 SSH 发画**：每一帧只发脏行，并且拼成一次 `stdout.write`。本机 80 ms；SSH 启动时用 CSI 6n 测往返，按 RTT 选 80/160/250/400 ms。`DSH_TUI_PAINT_MS` 始终优先（40–1000）。统计行最左是 `SSH ●●●○ 90ms`（一格红、两格黄、三格及以上绿）。探测不写进转录。
- **SSH 断了任务也没了**：用 tmux 开 TUI（见上文）。不要在另一个 SSH 窗口再开同一会话。
- **提示会话已在 pid 运行**：那份 TUI 还活着。`tmux attach -t dsh`；确认进程已死再删 `$DSH_HOME/tui-locks/` 对应文件。

## License

MIT，见 [LICENSE](LICENSE)。
