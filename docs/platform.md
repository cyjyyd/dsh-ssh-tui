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
node scripts/probe-home.mjs --probe --script tui-drop-probe.mjs   # 断连/重连
```

`scripts/probe-home.mjs` 是这一批新增的地基：它用 Node（不是 bash）造一个一次性 `DSH_HOME` +
`tui` profile（`--from-default-profile headless` → 去掉模板自带的 headless app → `dsh plugin add link:<repo>`
→ 挂 preset 名单），跑完探针再删掉。**CI 的 Windows 腿与 Linux rc.2 腿都跑它**，所以"真 Windows 生命周期"
从这一批起有 CI 覆盖；`PROBE_REQUIRE_PTY=1` 让探针在 node-pty 缺失时**失败而不是跳过**——跳过的探针不是覆盖。

`test-windows` 腿会在真实 Windows 上跑同一套用例，其中：

- `platform-guards` 用**真实环境**断言"Windows 下色深不为 none"与"`resolveDshInvocation` 在本平台可执行"，
  并静态扫描每个 spawn 的 `windowsHide`（这条在 Linux 也红）；
- `update-check` / `color-depth` / `diag` 的用例覆盖各自的 Windows 分支。

因此：**改到环境变量、子进程、路径、终端能力时，先想"这条在 Windows 上哪个分支会被走到"**，
把那个分支写成可注入的纯函数并断言它；实在无法纯化的（真 PTY、ConPTY、命名管道），就在 PR 里说明
只能靠 `test-windows` 腿与实际 Windows 机器验证。

## 为什么不在本机装 PowerShell / Wine

`pwsh` 在 Linux 上是 POSIX 进程：有 `TERM`、走 POSIX `spawn`、没有 `.cmd` 垫片与命名管道——
上面两个 bug 它一个都复现不了，只会多一套需要维护的环境。Wine 能跑 `cmd.exe` 与 `.cmd`，但装 Windows 版
Node + 真宿主链路成本高且脆弱。**性价比最高的是把 Windows 的分支变成可在 Linux 变红的断言**，
真实平台交给 CI 的那条腿。

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
2. **Windows 生命周期写成规范 + 断言。** 明确四种情况的期望：SSH 断连、用户关掉终端窗口、TUI 崩溃、Host 崩溃。
   Windows 没有 SIGHUP，正确信号是管道 EOF + `Get-Process` 判活；"关掉终端后 Host 还活着"这条**目前只有手工验证过**。
   *验收*：`tui-drop-probe` 在 ConPTY 上覆盖"关掉终端窗口"这一条；规范落在本文件。
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
