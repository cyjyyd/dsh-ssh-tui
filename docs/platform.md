# 平台敏感改动：怎么不把 Windows 弄坏

本插件的开发与探针都在 POSIX 上跑，Windows 只能靠 CI 的 `test-windows` 腿（`windows-latest`，跑全套 `node --test`）。
历史教训很集中：出问题的从来不是"Windows 跑不了"，而是**从没在 Windows 上执行过的那几行判断**。

## 已经踩过的两类

| 现象 | 根因 | 为什么 Linux 测试看不见 |
|---|---|---|
| 应用内更新 `spawn dsh ENOENT` | 直接 `spawn('dsh', …)`；Windows 上全局安装是 `dsh.cmd` 垫片，`CreateProcess` 不按 `PATHEXT` 解析裸名字 | POSIX 上 `dsh` 就是可执行脚本，同一个调用永远成功 |
| 界面只有黑白 | 色深推断把**空 `TERM`** 当成"没有终端" | POSIX 上空的 `TERM` 确实等于管道/CI；Windows 上（PowerShell / ConHost / Windows Terminal）默认就不设 `TERM` |

## 三条规则

1. **平台判断必须可注入、可断言。**
   不要写 `process.platform === 'win32' ? … : …` 藏在 IO 深处；写成纯函数参数（例：`colorDepth(env, platform)`、
   `resolveDshInvocation({ platform, argv, exists })`），然后在用例里把 Windows 那一支**显式跑一遍**——
   这样在 Linux 上也能变红，而不是等用户在 Windows 上撞见。

2. **起进程不要用裸命令名。**
   `spawn('dsh')` / `execFile('dsh')` 在 Windows 上要么找不到、要么必须过 shell。首选
   `process.execPath` + 自己的入口脚本（宿主进程就是这么起的）；只在看不到自身入口时才退回
   `dsh` + `shell: process.platform === 'win32'`。
   `tests/platform-guards.test.mjs` 会**静态扫描** `src/`：任何新的裸名 spawn 都必须显式登记并写出理由，
   名单还会反向校验（代码里没有了却还挂着也会红），防止它腐化。

3. **环境语义按平台读，别按 POSIX 习惯读。**
   `TERM` 是 POSIX 习惯；Windows 上要用 `WT_SESSION` / `COLORTERM` / 平台默认值判断能力。
   同理：路径分隔符与 `\\.\pipe\` 命名管道、`PATHEXT`、`/proc` 不存在、`Get-Process` 核对 pid、
   控制台窗口隐藏（`windowsHide`）——这些都已有先例代码可参照。

## 在 Linux 上如何自检（不装 Windows）

```bash
node --test tests/platform-guards.test.mjs   # 静态扫描 + 平台分支断言
node --test "tests/*.test.mjs"               # 全套；Windows 专属分支用注入的平台跑
```

`test-windows` 腿会在真实 Windows 上跑同一套用例，其中：

- `platform-guards` 用**真实环境**断言"Windows 下色深不为 none"与"`resolveDshInvocation` 在本平台可执行"；
- `update-check` / `color-depth` / `diag` 的用例覆盖各自的 Windows 分支。

因此：**改到环境变量、子进程、路径、终端能力时，先想"这条在 Windows 上哪个分支会被走到"**，
把那个分支写成可注入的纯函数并断言它；实在无法纯化的（真 PTY、ConPTY、命名管道），就在 PR 里说明
只能靠 `test-windows` 腿与实际 Windows 机器验证。

## 为什么不在本机装 PowerShell / Wine

`pwsh` 在 Linux 上是 POSIX 进程：有 `TERM`、走 POSIX `spawn`、没有 `.cmd` 垫片与命名管道——
上面两个 bug 它一个都复现不了，只会多一套需要维护的环境。Wine 能跑 `cmd.exe` 与 `.cmd`，但装 Windows 版
Node + 真宿主链路成本高且脆弱。**性价比最高的是把 Windows 的分支变成可在 Linux 变红的断言**，
真实平台交给 CI 的那条腿。
