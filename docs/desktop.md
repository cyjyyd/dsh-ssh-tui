# 桌面版 Harness 与这个插件

> 起因：2026-09-29 收到一份**桌面版缺陷报告**（Windows 11 + 桌面正式版，运行时 CLI `0.2.0-rc.2`），
> 两个问题都借本插件的报错暴露出来。文件在这里把结论固定下来，附我们**核实过的**事实、我们改了什么、
> 以及用户当下能怎么做。报告人自己给出的两处诊断与修复方向，我们复核后同意（P1 的根因无法在本机复现，
> 因为这里没有 Windows 桌面版；下面标注了哪些是"复核一致"、哪些是"无法复核"）。

## 一句话结论

**桌面版用户不需要这个插件。** 桌面版是 GUI 应用（`dsh web` / 它自己的界面），而本插件是**终端 UI**：
它必须在真实 TTY 里跑。桌面版的 PATH 启动器不提供 TTY，所以 `dsh --profile tui` 这类终端配置在桌面版下
**架构上不可用**——这不是插件的 bug，也不是用户终端的 bug。

## 但"宿主自己会开终端控件"是另一条路（2026-10-01 补）

上面说的是**桌面版自己**当宿主、且它没有 console 的情形。若宿主愿意在自己的界面里放一个终端控件
（PTY 面板 / xterm.js / GUI 里嵌的终端），它可以把这个插件当子进程用：声明 `DSH_TUI_DISPLAY=stdio`，
插件就不再要求 TTY——画面走 stdout、按键走 stdin、面板尺寸由宿主用 `CSI 8 ; rows ; cols t` 报告。
协议、父进程的五个必备动作、最小示例与限制写在 [`docs/display-mode.md`](display-mode.md)；
可执行规格是 `tests/stdio-pipe-e2e.test.mjs`（两端都是管道）与 `scripts/tui-stdio-probe.mjs`
（真 profile、完全不用 PTY 的端到端，CI 的 Linux 与 Windows 两条腿都跑）。

这条路的**边界**同样要记住：它能跑，是因为宿主提供了终端。若宿主就是那个 Electron-as-Node 启动器，
它连这条通道也开不出来——那种情况走下面"用户可以怎么做"的第一行。

## 策略：没有终端时，插件**保持惰性**，绝不弄坏宿主

> 2026-09-29 起生效（`0.8.x`）。这是本节最重要的一条：**插件不应该有能力让宿主崩掉。**

旧行为是 `apply()` 里直接 `throw`。后果有两层：桌面版的插件管理器把它显示成
「1 entry did not activate / 插件失败」（用户会理解成**我们的插件坏了**），而在桌面版里它还会把 GUI 应用带崩。
新行为按"能不能画"分四种情况，只有真正能画时才挂载：

| 情形 | 判定 | 行为 |
|---|---|---|
| 本进程就是分离的 TUI Host（`isTuiHostProcess()`） | `host-relay` | **照常服务**——它的终端在随后接入会话的那个窗口里，这里没有 TTY 是正常的 |
| stdin 与 stdout 都是 TTY | `terminal` | 照常挂载 TUI |
| 桌面版启动器（`electron-as-node` / `app.asar` / `DeepSeek Harness.exe`） | `desktop` | **不挂载任何东西**（不取锁、不装定时器、不查更新），经 `ctx.logger('ssh-tui')` 记**一行**说明，措辞是"此处不启用"，不是报错 |
| 其它没有 TTY 的情形（管道 `… | tee`、cron、服务） | `no-tty` | 同上，文案换成"没有终端"。**不再抛错** |

那行日志（桌面版）：

```
ssh-tui: inactive here — the desktop Harness launcher has no console (Electron-as-Node), and this plugin is a
terminal UI, so nothing from it is running in this app. The desktop app needs nothing from it: use the app
itself or `dsh web`. For the terminal UI, install the npm CLI (`npm i -g @deepseek-ai/dsh`) and run
`dsh --profile tui` in a terminal or an SSH session (docs/desktop.md).
```

要"没终端就报错"的场合（脚本断言某个终端 profile 真能起来），在 profile 行里加
`requireTerminal: true` —— 那是唯一会抛错的路径，而且只在显式要求时。

**为什么"惰性"是对的策略**（不只对桌面版）:

1. **插件不能弄坏宿主**。宿主可能是 GUI 应用、可能是别人跑批的管道——任何一种都不该因为一个终端 UI
   找不到终端而失败。
2. **不误导用户**。条目"未激活"会被读成插件坏了；"此处不启用"+ 一条可用命令，才是用户能执行的结论。
3. **仍然诚实**。没有任何东西被静默吞掉：终端用户看到的是同一句话，并且能立刻照做。
4. **代价可接受**。`dsh --profile tui | tee` 这类用法现在安静退出（退出码 0）——需要非零退出就用
   `requireTerminal: true`。

## P1：桌面启动器没有终端（TTY 不可用）

**现象**：真实终端里执行 `dsh --profile tui --new` 得到

```
dsh: warning: 1 entry did not activate
ssh-tui (dsh-ssh-tui): Error: dsh-ssh-tui: both stdin and stdout must be TTYs; use a terminal/SSH session
```

**根因（报告的诊断，我们复核一致）**：桌面版的 `resources\runtime\cli\bin\dsh.cmd` 用
`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1` 充当 Node 运行时。那是 **GUI 子系统**进程，从 console
启动时未 attach 到父 console，于是 `process.stdin.isTTY` / `process.stdout.isTTY` 恒为 `undefined`。
`dsh web` / `dsh headless` 不受影响，因为它们不要求 TTY。

**我们改了什么**（这是本仓库能做的部分）：**先改成惰性（见上节），再把那一行说清楚**——认出桌面启动器后：

```
dsh-ssh-tui: this launcher has no terminal — the desktop Harness runs Electron as Node (GUI subsystem,
no console attached), so stdin/stdout are not TTYs and no terminal profile can start under it. Run this
profile from a real terminal or an SSH session with the npm CLI: npm i -g @deepseek-ai/dsh, then
dsh --profile tui. The desktop app itself does not need this plugin. See docs/desktop.md.
```

判定见 `src/platform.ts` 的 `desktopLauncher()`：`process.versions.electron` 存在，或 `execPath`/`argv`
里出现 `DeepSeek Harness.exe` / `app.asar`。**普通 node 用户的文案不变**（不会把终端问题误报成桌面问题）。

**用户可以怎么做**：

| 你的目标 | 做法 |
|---|---|
| 在终端里用这个 TUI | 用 **npm 安装的 CLI**：`npm i -g @deepseek-ai/dsh`，然后在真实终端或 SSH 会话里 `dsh --profile tui`（不要用桌面版写入 PATH 的那个 `dsh`） |
| 从远端连进来 | 走 SSH 会话，同样用 npm 的 CLI |
| 在桌面版里干活 | 用桌面版自己的界面或 `dsh web`——**不需要**这个插件 |

**留给上游的**（报告的 1/2/3 条我们同意）：终端类 profile 的启动器应改用真正的 console 子系统 Node
（把 asar 内的 CLI 解包到磁盘、随附 `node.exe`），或先 `AttachConsole(ATTACH_PARENT_PROCESS)` 再以
`ELECTRON_RUN_AS_NODE` 启动。

## P2：两个内部包没有 0.2.0 发布版（而官方 TUI profile 的注释仍在推荐它们）

官方 TUI profile 的 `cordis.patch.yml` 注释建议用户加这两行：

```yaml
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'
```

**核实结果（npm registry 实测，2026-09-29）**：

| 包 | dist-tags | 0.2.x |
|---|---|---|
| `@deepseek-ai/dsh-agent-presets` | `latest=0.0.1-rc.1` · `next=0.1.5-rc.3` · `alpha=0.1.6-alpha.2` | **无** |
| `@deepseek-ai/dsh-code-runtime-worker-thread` | `latest=0.0.1-rc.3` · `next=0.1.5-rc.3` | **无** |
| `@deepseek-ai/dsh-base@0.2.0-rc.2` | — | 依赖 93 个族包，**不含**上面两个；preset 相关只剩 `@deepseek-ai/dsh-permission-presets`（是"权限"预置，不是 agent 名单） |

所以：**那两行是 0.1.5 时代的配方，在 0.2.0 线上不该照抄**——照抄的结果就是"包不存在"或"incompatible"。

**本插件在 0.2.0 线上不需要它们**：我们的 profile 行是 `tool-ask-user` 与 `present`（0.1.7 起终端 profile
在进程级组合代理，没有 preset 名单这个概念），`/doctor` 的 agent-plane 检查会告诉你缺哪几行，`/doctor --fix`
写进去。我们的声明窗口里也不含这两个包——`@deepseek-ai/dsh-agent-presets` 从 0.8.0 起已从 peer 里摘除。

**留给上游的**：要么给 0.2.0 线发布这两个包（peer 对齐 `dsh-base@0.2.0-rc.*`），要么把 roster / code-runtime
并回 `dsh-base` 或对应终端 bundle，**并且把 TUI profile 模板注释里那两行删掉**——否则每个照做的用户都会撞墙。

## 另外两条观察（报告里"非主体"部分）

- `dsh plugin --profile <name> …` 把参数透传给 profile 目录里的 pnpm，所以 `dsh plugin --help` 打的是 pnpm
  的帮助。这是**有意**的（插件安装就是 pnpm 的包装），`allow-version` 之类豁免不在它的能力范围内——文档里
  应写清"改 profile 依赖请直接用 pnpm 或桌面版插件管理器"。
- Windows 上把启动器写入 PATH 的机制（`command-path.ps1` + `command-manager.js`）与本次两个缺陷无关，
  报告人已确认其行为符合预期。
