# 平台敏感改动：怎么不把 Windows 弄坏

本插件的开发与探针都在 POSIX 上跑，Windows 只能靠 CI 的 `test-windows` 腿（`windows-latest`，跑全套 `node --test`）。
历史教训很集中：出问题的从来不是"Windows 跑不了"，而是**从没在 Windows 上执行过的那几行判断**。

## 已经踩过的三类

| 现象 | 根因 | 为什么 Linux 测试看不见 |
|---|---|---|
| 应用内更新 `spawn dsh ENOENT` | 直接 `spawn('dsh', …)`；Windows 上全局安装是 `dsh.cmd` 垫片，`CreateProcess` 不按 `PATHEXT` 解析裸名字 | POSIX 上 `dsh` 就是可执行脚本，同一个调用永远成功 |
| 界面只有黑白 | 色深推断把**空 `TERM`** 当成"没有终端" | POSIX 上空的 `TERM` 确实等于管道/CI；Windows 上（PowerShell / ConHost / Windows Terminal）默认就不设 `TERM` |
| AI 每调用一次工具就闪一个终端窗口 | 宿主进程用 `detached: true` 起（Windows 上是 `DETACHED_PROCESS`）→ **宿主自己没有控制台**；而 `DETACHED_PROCESS` 存在时 Windows 会**忽略** `windowsHide` 设的 `CREATE_NO_WINDOW`。宿主每起一个控制台子进程（每次工具调用、每个 shell/node/git）都得自己分配一个控制台，那就是一闪而过的窗口 | Linux 上没有"控制台窗口"这回事；`detached` 只影响会话组，永远看不出问题 |

## 四条规则

1. **平台判断必须可注入、可断言，而且只准住在一个文件里。**
   不要写 `process.platform === 'win32' ? … : …` 藏在 IO 深处；写成纯函数参数（例：`colorDepth(env, platform)`、
   `resolveDshInvocation({ platform, argv, exists })`、`hostSpawnOptions(platform)`），然后在用例里把 Windows
   那一支**显式跑一遍**——这样在 Linux 上也能变红，而不是等用户在 Windows 上撞见。
   `src/platform.ts` 是唯一的"决策"归属地（`IS_WINDOWS`、`usesSigwinch`、`envFileName`、`shellName`、
   `hostSpawnOptions`、`displayHomePath`、`usesProcessIdentity`）；`tests/platform-guards.test.mjs` 会扫描
   `src/`，**任何 `process.platform` 比较出现在该文件之外就红**（把 `process.platform` 当默认参数是允许的，
   那正是可注入的形状）。

2. **起进程不要用裸命令名。**
   `spawn('dsh')` / `execFile('dsh')` 在 Windows 上要么找不到、要么必须过 shell。首选
   `process.execPath` + 自己的入口脚本（宿主进程就是这么起的）；只在看不到自身入口时才退回
   `dsh` + `shell: process.platform === 'win32'`。
   `tests/platform-guards.test.mjs` 会**静态扫描** `src/`：任何新的裸名 spawn 都必须显式登记并写出理由，
   名单还会反向校验（代码里没有了却还挂着也会红），防止它腐化。

3. **起进程要保证整棵进程树都看不见窗口。**
   宿主进程在 Windows 上必须**不 detach**（`detached: false` + `windowsHide: true`）：这样它拿到一个
   自己的隐形控制台，后代继承它，于是任何一次工具调用都不会再分配新控制台。反过来
   `detached: true`（`DETACHED_PROCESS`）会让 Windows 忽略 `CREATE_NO_WINDOW`，宿主变成"无控制台"，
   它的每个控制台子进程都会弹窗。判定写成纯函数 `hostSpawnOptions(platform)`
   （`src/display-sock.ts`），`tests/platform-guards.test.mjs` 会在 Linux 上把 Windows 那一支跑一遍；
   同一条用例还静态扫描 `src/`，任何新 spawn 少了 `windowsHide` 都会红。
   注意宿主"脱离启动器存活"在 Windows 上靠的是**系统不会随父进程杀子进程**，不是 `DETACHED_PROCESS`，
   而它自带控制台也让它不受用户关掉终端的影响。

4. **环境语义按平台读，别按 POSIX 习惯读。**
   `TERM` 是 POSIX 习惯；Windows 上要用 `WT_SESSION` / `COLORTERM` / 平台默认值判断能力。
   同理：路径分隔符与 `\\.\pipe\` 命名管道、`PATHEXT`、`/proc` 不存在、`Get-Process` 核对 pid、
   控制台窗口隐藏（`windowsHide`）——这些都已有先例代码可参照。

## 在 Linux 上如何自检（不装 Windows）

```bash
node --test tests/platform-guards.test.mjs   # 静态扫描 + 平台分支断言
node --test "tests/*.test.mjs"               # 全套；Windows 专属分支用注入的平台跑
node scripts/probe-home.mjs --probe          # 真 PTY 端到端：自己造一个 profile，不碰 ~/.dsh
node scripts/probe-home.mjs --probe --script tui-drop-probe.mjs   # 断连/重连 + 宿主崩溃恢复
node scripts/tui-mock-probe.mjs --busy         # 回合进行中关窗：宿主必须活着（Windows 上就是 ConPTY 拆除）
node scripts/tui-mock-probe.mjs --busy --crash # 同一场景，但启动器是被 SIGKILL/TerminateProcess 打死的
```

`scripts/probe-home.mjs` 是这一批新增的地基：它用 Node（不是 bash）造一个一次性 `DSH_HOME` +
`tui` profile（`--from-default-profile headless` → 去掉模板自带的 headless app → `dsh plugin add link:<repo>`
→ 挂 preset 名单），跑完探针再删掉。**CI 的 Windows 腿与 Linux rc.2 腿都跑它**，所以"真 Windows 生命周期"
从这一批起有 CI 覆盖；`PROBE_REQUIRE_PTY=1` 让探针在 node-pty 缺失时**失败而不是跳过**——跳过的探针不是覆盖。

`test-windows` 腿会在真实 Windows 上跑同一套用例，其中：

- `platform-guards` 用**真实环境**断言"Windows 下色深不为 none"与"`resolveDshInvocation` 在本平台可执行"，
  并静态扫描每个 spawn 的 `windowsHide`（这条在 Linux 也红）；
- `update-check` / `color-depth` / `diag` 的用例覆盖各自的 Windows 分支；
- 真 ConPTY 上跑 `tui-drop-probe`（关窗/重连 + 杀宿主后自动换一个）与 `tui-mock-probe --busy`
  （回合进行中关窗，宿主必须活着）——"关掉终端窗口"这条承诺过去只有手工验证，现在由这条腿证伪。
  `tests/workflow.test.mjs` 会把这三个探针步骤钉在 `test-windows` 里，删掉就红。

因此：**改到环境变量、子进程、路径、终端能力时，先想"这条在 Windows 上哪个分支会被走到"**，
把那个分支写成可注入的纯函数并断言它；实在无法纯化的（真 PTY、ConPTY、命名管道），就在 PR 里说明
只能靠 `test-windows` 腿与实际 Windows 机器验证。

## 为什么不在本机装 PowerShell / Wine

`pwsh` 在 Linux 上是 POSIX 进程：有 `TERM`、走 POSIX `spawn`、没有 `.cmd` 垫片与命名管道——
上面两个 bug 它一个都复现不了，只会多一套需要维护的环境。Wine 能跑 `cmd.exe` 与 `.cmd`，但装 Windows 版
Node + 真宿主链路成本高且脆弱。**性价比最高的是把 Windows 的分支变成可在 Linux 变红的断言**，
真实平台交给 CI 的那条腿。

## 四种死法：期望与断言（0.7.3 起）

"关掉终端窗口之后宿主还活着"曾经只是在一台机器上手工验证过的一句话。这一节是规范，四条各配一个断言；
探针里"怎么让窗口死"只有一个归属地（`scripts/pty-window.mjs`），免得两个探针各模拟各的。

四条都守同一条原则：**判活不靠信号**。Windows 发不出信号（`term.kill('SIGHUP')` 直接抛
"Signals not supported on windows."；`process.kill(pid, 'SIGHUP')` 同样不行），能用的只有通道 EOF
（socket / 命名管道关闭）与 pid 判活（POSIX `kill(pid, 0)`、Windows `Get-Process`）。

| 情况 | 平台交付的机制 | 启动器（relay） | 宿主（Host） | 用户看到什么 | 断言在哪 |
|---|---|---|---|---|---|
| **SSH 断连** | POSIX：控制终端消失 → 内核对前台进程组发 SIGHUP，stdin 读 EIO/EOF。Windows：SSH 客户端那一侧就是 ConPTY 被拆，没有 SIGHUP 可发 | `detachFromSshSession()` 先摘掉默认处置（不摘的话 `dsh` 会在插件反应过来之前拆掉整棵树），之后由 relay 自己的处理器收尾：`finish('signal')` → `quiet()` 还原终端 → 退出 0 | 显示通道 `close` → `handleDisplayDetach` → `handleHangup`。**忙** → `hostKeptAlive` + 保留计时器（`armDetachedIdleTimer`），回合继续跑；**闲** → flush 会话日志后退出 129 | shell 拿回 TTY；`--resume` 时转录还在；宿主被保留时重连多一行"已重连 1 次" | `tui-drop-probe.mjs`（POSIX 腿断言退出码 0）、`tui-mock-probe.mjs --busy`、`tests/idle-exit.test.mjs` |
| **关掉终端窗口** | Windows：窗口关闭 → ConPTY 拆除 → 控制台关闭事件。**关键不对称**：宿主是用 `windowsHide: true`（`CREATE_NO_WINDOW`）起的，因此它有自己的隐形控制台、不附着在用户那个控制台上（那段推理写在 `hostSpawnOptions` 的注释里），收不到关闭事件。POSIX：与上一行同一个 SIGHUP | 同 SSH 断连。差别只在 Windows：启动器是被终止的，没有优雅退出的机会——所以那条腿只承诺"退出了"，**不承诺退出码** | 忙则留下、闲则按 idle-exit 退出（`DSH_TUI_IDLE_EXIT_MS`） | 另一个窗口 `--resume` 接着用；关窗前正在跑的回合会跑完 | `tui-drop-probe.mjs`（关窗路径）、**`tui-mock-probe.mjs --busy`：回合进行中关窗 → 宿主进程必须还在，重连窗口要报"已重连"且转录里有跑完的回合**——两个探针都在 `test-windows` 腿上跑 |
| **TUI 崩溃** | POSIX：SIGKILL。Windows：TerminateProcess（没有信号，与关窗是同一个调用） | 进程直接消失：没有 goodbye、没有终端还原、没有锁更新 | 只看到一次没有 goodbye 的通道 `close`，与 SSH 断连走同一条路——宿主分不出、也不需要分出这两者 | 同上；当时在跑的回合由宿主跑完 | `tui-mock-probe.mjs --busy --crash`；`verify-batch` 的 `busycrash` 步 |
| **宿主崩溃** | 宿主进程消失（`kill -9` / TerminateProcess）。锁文件会留下一个死 pid | relay 看到通道 `close` → `finish('host-closed')`；5 秒恢复窗口（`ATTACH_RECOVERY_WINDOW_MS`）内自动重起宿主并重放转录；超窗或反复失败 → `flapping` 报告 + 还原终端退出（有界，不挂死） | 进程没了；死 pid 由 `session-lock.ts` 判活识破，不会被当成"还在跑" | 窗口留着、转录重放、还能继续输入；坏情况下退回 shell 并给出提示 | `tui-drop-probe.mjs`（杀宿主 → 窗口必须自己回来）、`tests/attach.test.mjs`、`tests/session-lock.test.mjs` |

两条贯穿四条的不变量：

1. **不许留下僵尸启动器。** 终端没了以后启动器必须退出：它是唯一持有显示器的人，留着就会和下一个窗口
   抢（历史 bug：两个窗口互相踢，每圈全屏重绘，还在 cooked 模式下把光标回包 `^[[17;1R` 回显到屏幕上）。
   Windows 上"退出了"就是全部承诺——控制台被拆时进程是被终止的，退出码没有意义。
2. **"离开"序列无条件发。** 还原终端（`?1049l` 等）只由启动器写，且不因为"我没进过备用屏"而跳过：
   漏发的代价是把用户留在备用屏里，而未进过备用屏时多发一次是无害的。
3. **忙的定义只有一处**（`isBusyForHangupKeepalive`）：正在跑的回合 / 活着的子代理 / 流式输出 /
   打开的工具调用 / LLM 重试 / 压缩中。空闲——包括回合已结算后停在审批对话框上——**不算忙**，
   直接退出，不留残留进程。

## Windows 欠债清单（0.7.3 起）

这一批（0.7.2 之后的 P0）只做了"地基"：把 Windows 的 bug 从"用户发现"变成"CI 发现"，并把平台判断收进
`src/platform.ts`。下面这些是**已知、未做**的，按建议顺序排；每条都写成可验收的形式，做完才从清单里删。

### P1：先补有风险的

1. ~~**文件权限在 Windows 上是空操作。**~~ **已完成（P1-2）**：`restrictPathToUser()` /
   `restrictPathToUserSync()`（`src/platform.ts`）把同一意图在两端都落实——POSIX 是 `chmod`，
   Windows 是 `icacls <path> /inheritance:r /grant:r <user>:F`（目录加 `(OI)(CI)`，这样目录里新建的文件
   也继承）。argv 由纯函数 `restrictPathArgs()` 生成因此在 Linux 可断言；
   **效果**由 `tests/platform-permissions.test.mjs` 里一条只在 `win32` 跑的用例在真实 Windows 上验证
   （断言 ACL 里没有 `Users` / `Everyone` / `Authenticated Users`，且当前用户在里面）。
   **发版前审查（对抗性子代理）修掉的两件事**：`restrictPathToUserSync` 在 ES module 里用了 `require`
   （抛错被 best-effort 吞掉 → 静默无效）；`icacls` 的授权对象改用 `%USERDOMAIN%\%USERNAME%`，
   否则域机器上裸用户名可能解析到同名的本机账户，去掉继承后用户自己反而读不到密钥。
   接入点：`env.cmd`/`env.sh`（API Key）、`.credentials.yaml`（`/setup` 写完之后）、
   SuperGrok token（OAuth refresh token）、`tui-locks/`、`tui-socks/` 与其 `*.err`、
   `tui-session-routes.json`、`tui-session-index.json`。全部 best-effort：收紧失败绝不让刚写成功的配置丢失。
   *顺带修掉的 POSIX 缺陷*：宿主 stderr 日志过去用 `openSync(path,'w')` 创建、**没有任何 mode**，
   在默认 umask 下是 0644——那段 stderr 可能引用 provider 报错；现在与目录一起收紧到 0600/0700。
2. ~~**Windows 生命周期写成规范 + 断言。**~~ **已完成（P1-3）**：四种情况（SSH 断连、关掉终端窗口、
   TUI 崩溃、宿主崩溃）的期望写在下面《四种死法》一节，触发器与断言一起；"关掉终端窗口后宿主还活着"
   不再是手工验证——`tui-mock-probe.mjs --busy` 在**回合进行中**按平台关窗（POSIX 发 SIGHUP，
   Windows 拆 ConPTY）并断言宿主进程还在、重连后的窗口报"已重连"且转录里有跑完的回合，这一条已进
   `test-windows` 腿；`tui-drop-probe.mjs` 另外补了"宿主崩溃 → 启动器自己把它换回来"。
   Windows 上没有 SIGHUP 可发（`kill('SIGHUP')` 直接抛错），判活一律靠通道 EOF + pid 判活
   （POSIX `kill(pid,0)`、Windows `Get-Process`）。
3. **路径与编码。** 带空格/非 ASCII/长路径的 `DSH_HOME`；`\.\pipe\` 名字长度与字符约束；CRLF 对转录与补丁文件的影响；
   `%USERPROFILE%` 与 `$HOME` 不一致时的行为（`displayHomePath` 已有分支，但没在真机上断言过）。

### P2：体验与分发

4. ~~**终端能力矩阵。**~~ **已完成（P1-1）**：`src/terminal-caps.ts` 一处判定、`docs/terminals.md` 一张表
   （Windows Terminal / conhost / VTE 系 / Konsole / xterm / tmux / screen / Linux 控制台 / dumb），
   `tests/terminal-caps.test.mjs` 一终端一 fixture，`scripts/tui-term-probe.mjs` 每种终端真起一次 TUI
   断言实际发出的序列（Windows 两个 profile 只在 `test-windows` 腿上跑）。剩余：不支持的终端上的
   **ASCII 回退渲染**（代码页非 UTF-8 的 conhost、非 UTF-8 locale）。
5. **分发与脚本去 bash 化。** `scripts/*.sh`（install / verify / uninstall / smoke）在 Windows 上等于不存在。
   照 `probe-home.mjs` 的样子给 Node 或 PowerShell 等价物，README 补 Windows 快速上手（含"装不上先看什么"）。
6. **用户可见的 Windows 文档。** 本文件是维护者视角；普通用户需要的是已知限制清单与 `/doctor` 的读法。

### 这一批已经做完的（P0）

- Windows 腿与 Linux rc.2 腿跑**真 ConPTY 端到端探针**（boot/resize/diag/doctor/copy/preset/输入/退出 + 断连重连）；
- `scripts/probe-home.mjs`：不碰开发者 `~/.dsh` 的一次性 profile，CI 与本地同一条路；
- `ensure-profile-rows` 逻辑从 bash 迁到 `scripts/profile-rows.mjs`（Windows 也能挂名单）；
- `src/platform.ts` + "比较只准在这里"的静态守卫；`detached`/`windowsHide` 的控制台窗口修复进了 `hostSpawnOptions`。
