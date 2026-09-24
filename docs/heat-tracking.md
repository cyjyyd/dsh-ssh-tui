# 热度基线与发版节奏

> 目的：把「发哪个版本、什么时候发」从拍脑袋变成看曲线。
> 入口只有一个脚本：`scripts/heat-report.mjs`。凭证与数据都留在本机，不进仓库。

## 为什么需要连续采样

- GitHub 的 traffic 接口只保留 **14 天**（views / clones / referrers / paths），过期即永久丢失；
- npm 的每日下载要 **滞后 1–2 天** 才聚合，且镜像/批量拉取会把老版本的数字抬高；
- 发版脉冲 **24–48 小时** 就衰减回基线（0.7.1：09-16 视图 39 → 09-17 视图 14）。
  所以「再等几天看热度」拿不到新信息，只有连续采样才能看出地板有没有被抬高。

## 用法

```bash
node scripts/heat-report.mjs                  # 采一次样本 → 追加到 store → 打印报告
node scripts/heat-report.mjs --report         # 只读 store 打印；不联网、不写盘
node scripts/heat-report.mjs --md --days 14   # markdown（贴 Release 正文 / issue）
node scripts/heat-report.mjs --json           # 机器可读，便于二次分析或画图
node scripts/heat-report.mjs --store /path/samples.jsonl   # 换存储位置
node scripts/heat-report.mjs --no-directory   # 跳过 dshfind 查询
```

**节奏：每周一次。** 14 天窗口配 7 天间隔，每天至少被两次采样覆盖，永不漏日。
间隔过长会在报告顶部出现 `warning: no data for …`；超过 14 天的空洞补不回来。
## 定时采样（已部署）

挂在本机的 openclaw automation 上（用户空间，不写系统 crontab）：

```bash
openclaw cron add --name dsh-ssh-tui-heat --display-name "dsh-ssh-tui heat baseline" \
  --description "Weekly popularity sample for cyjyyd/dsh-ssh-tui (see docs/heat-tracking.md)" \
  --cron '10 9 * * 1' --tz Asia/Shanghai --no-deliver \
  --command 'cd /root/dsh-ssh-tui && /usr/bin/node scripts/heat-report.mjs >> /root/.dsh/heat/weekly.log 2>&1 && tail -n 12 /root/.dsh/heat/weekly.log' \
  --timeout-seconds 300
```

- 任务名 `dsh-ssh-tui heat baseline`，每周一 09:10（Asia/Shanghai），首次执行 2026-09-21；
- `--no-deliver`：不往 WeCom / Telegram 推送；想每周收一条摘要就换成显式的 `--channel`（本机有多个频道时必须指定）；
- 查看 / 手动跑 / 历史：`openclaw cron list | grep heat`、`openclaw cron run <id> --wait`、`openclaw cron runs <id>`；
- 日志 `/root/.dsh/heat/weekly.log`：每次追加一份完整报告；命令末尾的 `tail` 让运行历史里也留下最新一行数据；
- 替代方案（系统 crontab / 面板计划任务，开机由系统拉起）：
  `10 9 * * 1 cd /root/dsh-ssh-tui && /usr/bin/node scripts/heat-report.mjs >> /root/.dsh/heat/weekly.log 2>&1`

脚本不依赖任何环境变量：token 走文件查找，`env -i /bin/sh -c '…'` 下已实测可采集；无 token 时仍会采集公开仓库信息与 npm 数据。

## 存储与合并规则

- 默认 `$DSH_HOME/heat/samples.jsonl`（本机 `~/.dsh/heat/samples.jsonl`），一行一个采样快照，append-only；
- 只在采集时创建：目录 0700、文件 0600；
- 报告按天合并：同一天被多个样本覆盖时**取最新样本的数**（traffic 数字会随结算修正）；
- 某个数据源失败时，失败的条目写进快照的 `errors`，报告里显示为 warning，已有日子的数据不受影响；
- 全部数据源都失败时不写盘，直接以退出码 1 结束；
- 数据不进仓库：clone / referrer 是 owner 可见的数字，默认不公开。要公开就 `--store docs/heat/samples.jsonl`，自行确认。

## 凭证

读 traffic 需要带 `Administration: read` 的 fine-grained PAT，其他权限的 token 会返回 403
（响应头 `x-accepted-github-permissions` 会写明缺什么）。查找顺序：

1. `$GITHUB_TOKEN` / `$GH_TOKEN`
2. `~/.config/dsh-publish/github.token`
3. 同目录的 `git-credentials`（`https://user:token@host`）

token 只发给 `api.github.com`（不随重定向外发），不打印、不写入 store；错误信息经过 `redact`。
无 token 时仍会采集公开仓库信息与 npm 数据，只是 traffic 两项会失败。

## 读表须知

- `views` / `clones` 可相加；`uniq` / `cuniq` 是**每日独立数，不能相加**——窗口级独立访客只看
  「14-day window」那一行（API 自己的口径）；
- 7 天窗口对齐到**最后一个有 traffic 的日期**（GitHub 的窗口止于昨天），否则 6 天 vs 7 天会被读成涨跌；
- npm 当天/前一天常返回 0，报告标 `npm pending`，两天后才算数；老版本的量主要是镜像噪声；
- `notes` 列的 tag 来自 GitHub Releases，发版脉冲可以直接在日表上对日期。

## 首次基线（2026-09-18 采集）

| 指标 | 数值 |
|---|---|
| 视图（14 天） | 204 / 独立 120 |
| 克隆（14 天） | 1034 / 独立 246（09-15 单日 520/122，机器/索引流量为主） |
| 发版日 09-16 | 39 视图 / 16 独立（14 天最高）；09-17 回落到 14/12 |
| 发版前基线（09-04…09-09） | 1–11 视图/天 |
| 近 7 天 vs 前 7 天 | 视图 133 vs 71（+87%），克隆 849 vs 185（+359%，被 09-15 峰值拉高） |
| npm 上周（09-10…09-16） | 2750；分版本 0.6.2 284 · 0.5.7 224 · 0.6.3 203 · **0.7.1 167**（镜像噪声） |
| 来源 | github.com 49 · Google 15 · npmjs.com 2 · Bing 1 · **dshfind 1** |
| 落地页 | 仓库首页 156/119 · commits 13 · releases 7 · issues 2 |

读出来的结论：

1. 真实注意力规模约 **8–9 独立访客/天**，发版脉冲真实存在但 48 小时内回到基线；
2. 0.7.1 首个完整日（09-17）的 14/12 高于 09-10 之前的基线，地板可能被抬高了一点，但样本只有一天；
3. 目录几乎不送人（14 天 1 次），搜索是第二大来源，releases/issues 页几乎没人看；
4. dshfind 卡片仍挂 **0.6.3**，是最大的静默流失点，发版后要催一次收录刷新。

## 0.7.2 已发布（2026-09-21）

> 发版完成：`e08c1d7` → tag `v0.7.2` → npm `latest`/`next` = `0.7.2` → GitHub Release（正文含当日基线）。
> 下面是当时的计划，保留作为记录；下一批见文末「0.7.3」。

### 当日计划（存档）

- 依据：发版脉冲 48 小时衰减 → 等更久不会多出信号，只多了主分支未验收的风险；工作日曝光好于周末；
- 门禁：`node scripts/verify-batch.mjs` 全绿（typecheck · 全套单测 · 6 个 PTY 探针）、CI 四条腿全绿、0 issue；
- 当天顺序按 [release.md](release.md)：版本号提交 → 推 `main` → tag `v0.7.2` → CI 全绿 → `npm publish` → GitHub Release；
- 发布日当天用 `node scripts/heat-report.mjs --md --days 14` 出一份基线，放进 Release 正文
  （releases 页会被搜索引擎收录，是能沉淀的落地页）；
- 比发版日期更划算的三件事：① 催 dshfind 刷新卡片；② README 首屏（独立访客几乎只看首页）；
  ③ Release 正文按「子代理界面 / 会话级路由 / 渲染与配色 / CI 可靠性」分块写。

### 候选内容与已验收状态（2026-09-20 冻结）

`dbf4563`「一个网关就是一个提供商 + 向导选模型 + 底栏状态」已推 `main`，CI 四条腿全绿
（`test (0.1.5-rc.2)` / `test (0.1.5-rc.1)` / `test (0.1.2-rc.1)` / `test-windows`），
`verify-batch` 九步 PASS：**851 项 / 849 通过 / 0 失败 / 2 跳过**。发版前只需要再把版本号提到 `0.7.2`。

Release 正文建议按这批的四个用户可见变化分块（本批比原来的「子代理界面 / 会话级路由 /
渲染与配色 / CI 可靠性」多了一条主线）：

1. **一个网关就是一个提供商**——Command Code / OpenCode Go 这类跨协议网关不再在
   `/provider` 里按协议拆成多行；模型列表取并集，选中后自动落到能发该协议的线路；
2. **向导让你选模型**——`/setup` 的模型步骤回车打开勾选列表（模板模型默认勾选），
   再选一次「本次会话用哪个模型」，不再把端点的整个列表替你写进配置；
3. **底栏状态不再卡住**——重试结束即退出「重试 n/m」，压缩结束回到运行中，
   空闲自动压缩也会驱动标题；
4. **CI 可靠性**——`ROUTE_MEMORY_SCHEMA` 补上类型标注，`tsc` 不再依赖本机
   node_modules 的符号链接布局（TS2742）。

> 日期是用户确认的窗口；版本号、tag 与 npm 仍按 [release.md](release.md) 的规则执行。

## 0.7.3 已发布（2026-09-24）

> 发版完成：`e505768`（Release 0.7.3）→ tag `v0.7.3` → npm `latest`/`next` = `0.7.3` →
> GitHub Release <https://github.com/cyjyyd/dsh-ssh-tui/releases/tag/v0.7.3>（正文含当日基线）。
> 发版前 CI 四条腿全绿：run **35983017141**（`test (0.1.5-rc.3)` / `(0.1.5-rc.1)` / `(0.1.7-rc.1)` / `test-windows`）。
> 下一条主线（0.7.4 候选）：P2 三项——非 UTF-8 控制台/locale 的 ASCII 回退渲染、脚本去 bash 化、
> 面向用户的 Windows 文档；外加两条只能真机确认的 Windows 项。

**上游兼容放在第一位。** 0.1.7-rc.1（`next`）的三处结构性变化全部适配：设置表单由 loader entry 自己的
`Config` 投影（只有 `.volatile()` 字段可写、命名空间 = entry id）、复数 `dsh-agent-presets` 拆成
`dsh-agent-preset` + `dsh-agent-preset-registry`、终端不再有 roster（preset 变会话级、base 在进程级组合代理）。
`dsh.compatibility.dsh` 与 14 条 peer 纳入 `>=0.1.7-rc.1 <0.1.8`——**launcher 会逐条读 peer 范围（optional
也算），所以放宽是升级路径的硬前提**——CI 加 `test (0.1.7-rc.1)` 腿，真机核验＝同源 `tsc` 两条线 0 错、
mock 轮次探针 PASS、`settings.yaml` 四段迁移演练通过。同批按用户决定**摘除 0.1.2-rc**：范围去掉
comparator、CI 删腿、只服务该 API 代的兼容分支与测试固定装置删除，`dshReleases` 把 `0.1.2-rc.1` 改判
`incompatible`（让旧用户看到明确结论而不是沉默）。

**Windows 地基与 P1（全部落地）：**

1. ~~文件权限在 Windows 上是空操作~~ **P1-2**：`restrictPathToUser()` 在 Windows 走
   `icacls /inheritance:r /grant:r`，接入 env 文件、`.credentials.yaml`、SuperGrok token、锁/套接字目录、
   宿主 stderr 日志（顺带修掉 POSIX 下 stderr 日志 0644）。
2. ~~生命周期规范 + 断言~~ **P1-3**：四种死法（SSH 断连 / 关窗 / TUI 崩溃 / 宿主崩溃）的期望写进
   `docs/platform.md`，`tui-mock-probe.mjs --busy` 进 `test-windows` 腿。
3. ~~宿主活过"关掉终端窗口"~~ **P1-4**：经系统 PowerShell `Start-Process -WindowStyle Hidden -PassThru`
   起宿主（自己的隐形控制台、不在启动器的 job 里），pid 通过文件回传。
4. ~~路径与编码~~ **P1-4-4**：`sessionSockPath` 改为按 `sun_path` **字节预算**截断（39 字符 home 的 113 字节
   地址过去 `listen()` EINVAL，现在同配置给出 107 字节且内核接受；深到放不下时抛出点明"DSH_HOME 太深"的错误），
   `\\.\pipe\` 名字按 256 字符上限收口，非 ASCII/空格路径的引号与 `-EncodedCommand` 往返进测试，
   `displayHomePath` 在 `DSH_HOME == $HOME` 时不再误显示 `~/.dsh/…`。证据与验收见 `docs/platform.md`。

**P2 仍未做（视 Windows 用户量定）**：非 UTF-8 conhost/locale 的 ASCII 回退渲染；脚本去 bash 化
（`scripts/*.sh` 在 Windows 上等于不存在）；用户向 Windows 文档。
**真实 Windows 上仍只能人工确认的两条**：宿主那个控制台窗口确实是隐藏的；`%USERPROFILE%` 与 `$HOME`
不一致的账户行为。

**发版窗口**：兼容驱动的发版不必等热度窗口——0.1.7 宿主的 launcher 闸门会拒绝 0.7.2，所以 0.7.3 越早越好；
这一版按此执行：CI 全绿当天（2026-09-24）即发。

**dshfind 卡片（已解决）**：曾长期挂 0.6.3。机制：`probe:install` 只重探 `install_probed_at` 超过 7 天、
按 stars DESC 排序的行（8 分钟上限），那段时间又撞上连续 cancelled 的每日同步，于是旧版本被留在卡片上。
2026-09-24 复查，页面已显示 **版本 0.7.2**，说明自然重探追上了。下次发版后同样先观察一两天；若超过一周
仍不动，再用 `gh workflow run sync-plugins.yml -f only=cyjyyd/dsh-ssh-tui` 点名重探。
