# dsh-tui（dsh-ssh-tui）

DeepSeek Harness（`dsh`）的 SSH 友好交互终端插件：纯 ANSI 聊天式转录、流式输出、
工具卡片、git 风格 diff、历史会话选择、滚动回看与鼠标点击展开，并带终端标题栏
进度与完成提示音。

English: [README.md](README.md)

## 功能一览

- 纯终端渲染，无需浏览器/鼠标/重量级终端框架，适合慢速或远程 SSH；
- 模型思考流默认折叠，显示 `▸ 思考中 ⠹ · N 字 · Ns` 动画；结束后折叠为
  `▸ 已思考 · N 行`，可单独展开；思考过程中也能实时展开/收起查看原文；
- 工具调用卡片化：彩色状态点（运行黄 / 成功绿 / 失败红）、shell 命令友好展示、
  编辑工具 git 风格 diff（`-` 红 / `+` 绿 / 文件统计）、JSON 参数与结果自动转可读内容；
- 转录区滚动回看（`PgUp`/`PgDn`、鼠标滚轮），点击思考/工具标题行直接展开收起；
- 输入框下方会话统计行：轮次/步数、模型与工具耗时、TTFT、tok/s、缓存命中率、
  输入/输出 token（与 web 端口径一致）；
- 历史会话启动选择器：`dsh --profile tui --resume`（或 `resume`）先选会话再进入；
- 终端窗口标题栏：运行中旋转图标 + `运行中 · 工具 N`，完成后 `✓ 已完成`，并响
  一声终端铃（`DSH_TUI_NO_BELL=1` 关闭）；
- 审批、`ask_user_question`、子代理进度、`/mode` 模式切换、`/model` 模型切换、
  `/resume` 会话切换等完整支持。

## 环境要求

- Node.js ≥ 22.19
- DeepSeek Harness CLI：`npm i -g @deepseek-ai/dsh`
- pnpm（`dsh plugin` 通过 pnpm 管理 profile 依赖）
- 支持 ANSI 的终端（推荐 SSH 直连；Windows 用 PowerShell / Windows Terminal）

## 部署指南

### 方式一：一键脚本（推荐）

```bash
git clone https://github.com/cyjyyd/dsh-tui.git
cd dsh-tui
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
cd dsh-tui
npm install --no-audit --no-fund
npm run build
dsh plugin --profile tui add "link:$(pwd)"
```

### 方式三：npm 安装（发布后）

```bash
dsh plugin --profile tui add dsh-ssh-tui
```

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
| `Enter` | 发送；运行中则 steer 当前轮次；输入为空且有选中块时展开/收起 |
| `↑` / `↓` | 输入为空时在思考/工具块间移动选择；有输入时切换历史 |
| `Ctrl+N` / `Ctrl+P` | 在思考/工具块间移动选择 |
| `Ctrl+R` | 展开/收起选中块（未选中时切换最近一块） |
| 鼠标左键 | 点击思考/工具标题行直接展开/收起 |
| `PgUp` / `PgDn`、滚轮 | 转录区滚动回看 |
| `Esc` | 取消选择 / 回到底部 / 取消当前轮次 |
| `Ctrl+C` | 中断当前轮次；空闲时退出 |
| `Ctrl+D` | 退出 |
| `Ctrl+L` | 重绘 |

斜杠命令：`/help`、`/model`、`/mode`、`/resume`、`/status`、`/subagents`、
`/setup`、`/clear`，以及 harness 自带命令（`/goal`、`/plan`、`/compact` 等）。

## 配置

### 模型默认值（`$DSH_HOME/settings.yaml`）

```yaml
agent-default-model:
  provider: opencode-go
  model: deepseek-v4-pro
  reasoningEffort: max
agent-presets:
  default: standard
```

`/model` 与 `/mode` 的修改会写回这里，web 端与 TUI 共用同一份设置。

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
- 插件本身不收集、不上传任何数据；会话日志仅按需读写于本机 `$DSH_HOME`。

## 开发与目录结构

```text
src/index.ts        插件入口：启动选择器、会话创建/恢复/切换
src/startup.ts      命令行参数解析（--resume / --new / --model ...）
src/picker.ts       启动历史会话选择器
src/session-list.ts 历史会话扫描与标签（共享给 /resume）
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

## License

MIT，见 [LICENSE](LICENSE)。
