# 在 Windows 上使用

> 这份文件是给**使用者**的。维护者视角的平台决策、断言和欠债记录在
> [platform.md](platform.md)；每个终端允许发什么在 [terminals.md](terminals.md)。
>
> 下面每条都是已经落地的行为，不是计划。文末单独标出**只能在真机上确认、CI 证明不了**的两项。

## 30 秒装上

推荐走 npm，Windows 和 Linux 是同一条命令，不需要仓库、也不需要 bash：

```powershell
npm i -g @deepseek-ai/dsh
dsh plugin --profile tui add dsh-ssh-tui@latest
dsh --profile tui
```

`dsh` 必须在真实终端里启动（Windows Terminal 或 PowerShell 窗口）。管道、任务计划里的
无窗口任务会报 `both stdin and stdout must be TTYs`。

从 git 检出安装时，用 Node 脚本而不是 `bash`（Windows 上没有 bash）：

```powershell
git clone https://github.com/cyjyyd/dsh-ssh-tui.git
cd dsh-ssh-tui
node scripts/install.mjs          # 默认 tui profile；node scripts/install.mjs work 装到别的
node scripts/verify.mjs           # 检查组合是否生效
```

`scripts/*.sh` 仍然可用，但只是转去调用同名的 `.mjs`：在 Git Bash 里
`bash scripts/install.sh` 与 `node scripts/install.mjs` 做的是同一件事。校验、卸载、
冒烟、路由套件同理：`verify.mjs`、`uninstall.mjs`、`smoke-headless.mjs`、
`install-routing-suite.mjs`。

## 装不上，先看这里

按报错对号入座，从上到下。

| 你看到的 | 含义 | 怎么办 |
|---|---|---|
| `both stdin and stdout must be TTYs` | 没有分配到终端 | 在 Windows Terminal / PowerShell 窗口里启动，不要用管道或后台任务 |
| `'dsh' not found on PATH` | CLI 没装上 | `npm i -g @deepseek-ai/dsh`，新开一个窗口再试 |
| `host display socket did not appear` | 显示通道没建起来 | 先升级：`dsh plugin --profile tui add dsh-ssh-tui@latest`。仍失败就贴 `/diag` 提 issue |
| 应用内更新报 `spawn dsh ENOENT` | 旧版本直接 `spawn dsh`，而 Windows 上装的是 `dsh.cmd` 垫片 | 在命令行跑一次同样的升级，之后应用内更新就正常 |
| 完全没有颜色，只有黑白 | 旧版本把「没设 TERM」当成没有终端 | `set DSH_TUI_COLOR_DEPTH=8`（或 `256` / `truecolor`），`/diag` 的「配色」一行能看到判定 |
| 框线、圆点变成乱码 | 控制台代码页不是 UTF-8 | `chcp 65001`，或改用 Windows Terminal。详见下面「字符」一节 |
| `/mode` 报服务不可用、preset 工具消失 | profile 没挂上需要的行 | 敲 `/doctor`，再 `/doctor --fix`，然后重启 |
| 关窗口后正在跑的回合也没了 | 这台机器没有 PowerShell，宿主退回成直接子进程 | 启动横幅下会有一行提示；装上系统自带的 PowerShell 5 即恢复保活 |

## `/doctor` 怎么读

`/doctor` 回答的是「这个 profile 组合得对不对」，`/diag` 回答的是「这次会话为什么进不去」。
报 issue 时两段都贴。

报告是纯文本，第一行是标题，接着三行上下文：

```text
DeepSeek Harness — 部署体检（/doctor）
profile tui · 插件 0.7.3 · dsh 0.1.5-rc.3 · node v22.x
profile 补丁：C:\Users\you\.dsh\profiles\tui\cordis.patch.yml
结论：8 项正常 · 1 项注意 · 0 项失败
```

然后每项一行，行首的符号就是结论：

| 符号 | 含义 |
|---|---|
| `●` | 正常 |
| `⚠` | 能用，但有东西缺了，通常附带修复办法 |
| `✖` | 失败，启动或某个命令会报错 |

缩进的行是证据（缺的是哪一行、补丁的第几行、声明的版本范围）。带
`修复：/doctor --fix（写前备份）` 的项是**可以自动修**的：

```text
/doctor --fix
```

它会先写一份 `cordis.patch.yml.bak-<时间戳>`，再补上缺的行，然后提示你重启
（`/exit` 之后重新 `dsh --profile tui`）。只想修某一行用 `/fix <行名>`。

常见的几项对号入座：

- **名单未组合 / 代理平面行缺失**：`/mode` 不能切换，`ask_user_question`、`present` 这些
  工具也不在目录里。`/doctor --fix` 就是修这个。
- **行被挂载两次**：profile 补丁和某个 bundle 各挂了一次同一行，第二次以「服务已注册」失败。
  删掉补丁里重复的那段。
- **dsh 版本不在声明表内**：宿主版本超出本插件声明的范围，先升级宿主或插件里较旧的那个。
- **发现多份 `@deepseek-ai/dsh-scope`**：插件和宿主各解析到一份，preset 会拒绝组合。常见于
  profile 里用软链指向一份 checkout、而 CLI 装在另一处。改成
  `dsh plugin --profile tui add dsh-ssh-tui@latest`，让两边用同一份。
- **路由自洽性**：默认提供商、模型、子代理模型对不上。`/provider`、`/model`、`/submodel` 里改。

底栏里一个可点击的 `⚠` 打开的就是 `/doctor`。

## 已知限制

**显示通道是命名管道，不是文件。** Windows 不能监听 `.sock` 文件，所以 Host 和界面之间走
`\\.\pipe\dsh-tui-<DSH_HOME 摘要>-<会话名>-<会话摘要>`。管道在进程结束时由系统回收；
Host 的 stderr 记在 `%USERPROFILE%\.dsh\tui-socks\`，锁在 `%USERPROFILE%\.dsh\tui-locks\`。

**关窗口不会丢掉正在跑的回合。** 宿主由系统自带的 PowerShell
（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，不是 PowerShell 7）
以隐藏窗口启动，所以它不在你的窗口里，关窗带不走它。找不到这份 PowerShell 时才退回直接子进程，
那种情况下关窗会结束正在跑的回合——会话本身不坏，`--resume` 从日志恢复，而且启动时会有一行提示。

**文件权限走 ACL。** `env.cmd`（含 API Key）、`.credentials.yaml`、SuperGrok token、锁和
管道目录在 Windows 上是「去掉继承、只授权当前用户」的 ACL，等价于 POSIX 的 `0600`/`0700`。
把 `DSH_HOME` 放到共享目录时这一点尤其重要。

**字符。** 代码页不是 UTF-8 的控制台显示不了框线和圆点。本插件**不改你的代码页**（那是全局状态），
而是自动改画 ASCII：横线变 `-`，状态点变 `*`，警告号变 `!`。`/diag` 的「终端」一行会写明
「字符 ASCII 回退」。想要原来的字形：`chcp 65001`，或直接用 Windows Terminal。
强制开关是 `DSH_TUI_ASCII=1`（总是 ASCII）和 `=0`（总是 Unicode）。
中文界面在非 UTF-8 代码页下仍然是中文——字符回退只替换装饰符号，不翻译文字；那种控制台请同时
`/language en`。

**终端能力。** Windows Terminal 与老的 conhost 能力不同（剪贴板写入、超链接只在 Windows Terminal 上承诺）。
判定写在 `/diag` 的「终端」一行，判错了用 `DSH_TUI_TERM_CAPS` 覆盖，详见 [terminals.md](terminals.md)。

## CI 证明不了、需要你自己看一眼的

这两项在自动化里只能证明一半：

1. **宿主那个控制台窗口确实是隐藏的。** CI 能证明宿主有一个独立于启动器的控制台；至于它在你的桌面上
   不可见，只能亲眼确认。正常情况是：启动后任务栏不出现额外的控制台窗口。
2. **`%USERPROFILE%` 和 `$HOME` 不一致的账户。** 两者指向不同目录时，界面上显示的 `~` 路径以
   `%USERPROFILE%` 为准。这种账户很少见，没有放进自动化断言。
