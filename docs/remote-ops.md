# 远程运维手册：断线、接管与常驻

这份文档回答一个问题：**在一条会断的 SSH 链路上，怎么让会话按你的预期活下来、又怎么把它接回来。**
它只描述当前实现的行为与可复制的配方；机制本身写在 README 的排障一节。

> 语言：本手册目前只有中文。README 的中英两版都指向这里，若要英文版请提 issue。

## 1. 断线时会发生什么

| 掉线时的状态 | 行为 |
|---|---|
| **空闲**（没有轮次在跑） | launcher 交还终端并退出，会话日志已落盘。回来 `--resume` 从日志恢复，**没有 Host 在等你** |
| **忙碌**（思考 / 回复 / 工具 / 子代理在跑），默认策略 `pause` | 取消当前轮次、flush 日志，**Host 留下**并持有会话写锁，等你回来接入 |
| **忙碌**，`/disconnect continue` | 不取消，Host 在后台把这一轮跑完；你回来时结果已经在转录里（可能还带着子代理的进度） |
| 你开了第二个窗口去接同一个会话 | 如果那个会话正被别的窗口接入，选择器会把它标成「已占用 · pid N」：选中它先问一句，按 `y` / Enter 才接管——新窗口接管显示，旧窗口退出（`replaced`）。`--resume <session-id>` 跳过选择器，所以这种情况**会被拒绝**，不会静默踢掉对方；断线留下的 Host（标「可接入」）仍是一键接入。**不要为同一个会话起第二份 Host** |
| 断线残留（SSH 悄悄断了，服务端还没发现） | launcher 还连着显示通道、锁里还写着 `attached`，但那个窗口其实已经没了（sshd 要等 TCP keepalive 才发现，可能几小时）。Host 会经 relay 向**终端本身**做一次光标往返：答不上来就判定为残留——选择器直接标「可接入」，`--resume <session-id>` 与 Enter 都直接接入，不再需要接管确认。这个判断在**首帧之前**完成，所以列表不会先显示「已占用」再改口 |

会话写锁是内核锁：同一时刻只有一个写者。这是为什么"再开一个窗口"和"再起一份 Host"是两件不同的事——前者是接管，后者会失败（`already owned by an active write handle`）。

## 2. 三个时间旋钮

| 旋钮 | 默认 | 作用 |
|---|---|---|
| `DSH_TUI_IDLE_EXIT_MS`（或 settings.yaml 的 `ssh-tui.idleExit`） | `60000`（60s） | 忙碌掉线留下的 Host，在**轮次结束后**再等多久无人接入就自行退出并让出锁。`0`/`off` 恢复旧的"长时间保留"行为 |
| `DSH_TUI_DETACHED_IDLE_MS` | `21600000`（6h） | 完全没有显示器、且一直空闲的兜底上限；轮次在跑时会自动续期 |
| `/disconnect pause\|continue` | `pause` | 掉线时是否取消当前轮次（见上表） |

**推荐**：留在默认。60s 足够你重连；把它调大只在一种场景下有意义——你确定自己会离开很久、且希望**轮次继续跑完**，那就配 `/disconnect continue`，而不是无限期留住锁。

`DSH_TUI_NO_SESSION_LOCK=1` 会关掉锁，仅用于调试：两个 Host 同时写一个会话日志会互相覆盖。

## 3. 回来后你会看到什么

重连成功时，转录里会多出两行（都是 Host 侧写的，launcher 写不了——屏幕由 TUI 拥有并会立刻重绘）：

```
已重连 1 次 · 断开 1m
离开 1m：自动审批 1 次放行 / 1 次拒绝 · 其中 1 次因无人确认被拒 · 1 条提问待回答
```

- **计数按 Host 计**：新起的 Host 从 1 开始，它确实不知道更早的 Host。
- **摘要是增量**：只统计这次离开期间发生的事，不重复会话的总量。
- 只有真发生过的部分才会出现；链路只是抖一下，就只有第一行。
- 断线期间到达的**未识别审批会被拒绝**并把理由写进转录（模型据此调整）。这是有意的：挂起的轮次会撞上 idle-exit 兜底，最后既没跑完也没人确认。
- 有提问还在等时，摘要会多一句「这个问题等了你 Xm」，从它开始等算起，而不是从断线算起。

## 3.1 提问在等、而你不在

模型问了一个问题、当时没有人看着屏幕时，回合会停在那里。过去这只在**你重连之后**才看得出，所以一次等了很久的提问要到回来才发现。现在有两层，都不需要新依赖。

**标记文件，不用配置。** 等待一开始就在 `$DSH_HOME/tui-socks/` 写一个 `<会话>.waiting`，内容是会话 id、在等的提问数、开始时间和提问原文，权限 `0600`。回到跳板机、还没开 TUI 时 `ls` 就能看见。提问被回答、取消，或 Host 退出时删掉，所以留下的文件一定对应一个还活着的等待。

等待中的提问也算「忙」：Host 不会被 60 秒的空闲退出杀掉，否则提问会跟着进程一起消失。

**一条命令，可选。** `ssh-tui.notify`（或 `DSH_TUI_NOTIFY`，环境变量优先）放一条命令，提问开始等待时跑一次。消息从标准输入进去，细节在环境变量里：`DSH_TUI_NOTIFY_SESSION`、`DSH_TUI_NOTIFY_COUNT`、`DSH_TUI_NOTIFY_QUESTION`、`DSH_TUI_NOTIFY_WAITED_MS`、`DSH_TUI_NOTIFY_RESUME`（接回这条会话的命令）。10 秒不返回就杀掉，失败不进转录、不拖回合。只在**开始等待时**发一次，不是每分钟一次。

不用手写 settings。`/notify` 直接配，三种走邮件的方式：

```text
/notify                              查看当前配置
/notify off                          关闭
/notify mail you@example.com         本机 mail / mailx
/notify smtp smtp.example.com from@a.c you@b.c alice 密码
/notify local from@a.c you@b.c       本机邮局，127.0.0.1:25
```

`smtp` 的端口默认 587，写在主机后面就换（`smtp.example.com:465`）；账号和密码省略时按不登录发送。`local` 的端口默认 25，要换就放第一个（`/notify local 2525 from to`）。密码存在 `ssh-tui.notifySmtpPassword`，不进命令字符串，也不出现在转录里；发送时经 `DSH_TUI_NOTIFY_SMTP_PASSWORD` 交给命令。SMTP 和本机邮局都用 python3 标准库的 `smtplib`，跳板机有 Node 就有它。

`DSH_TUI_NOTIFY` 仍可用，适合一条自己写的命令。企业微信等待下一轮。

## 4. 配方

### 4.1 tmux（最省事）

```bash
tmux new -As dsh            # 有就接入，没有就新建
# 会话里：
dsh --profile tui --resume  # 选择器；活着的 Host 优先接入
# 断开终端：Ctrl-b d        下次 SSH 回来：tmux new -As dsh
```

tmux 保证的是**终端会话**不断；dsh 保证的是**会话日志与（忙碌时的）Host**不断。两者叠加，链路抖动就不再等于丢进度。

### 4.2 screen

```bash
screen -S dsh
dsh --profile tui --resume
# Ctrl-a d 断开；回来 screen -r dsh
```

### 4.3 systemd --user：登录即有 tmux

`~/.config/systemd/user/dsh-tui.service`：

```ini
[Unit]
Description=Persistent tmux session for the dsh TUI
After=default.target

[Service]
Type=forking
Environment=DSH_HOME=%h/.dsh
ExecStart=/usr/bin/tmux new-session -d -s dsh 'dsh --profile tui --resume'
ExecStop=/usr/bin/tmux kill-session -t dsh
Restart=no

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-tui.service
loginctl enable-linger "$USER"     # 未登录时也保留（按需）
```

注意：unit 只是把 tmux 会话带起来，**dsh 的断线语义不变**——空闲掉线仍然会退出 Host，`--resume` 从日志恢复。不要把 `Restart=always` 配上：那会在你退出 `/exit` 后不断重开一个会话。

### 4.4 长任务跨休眠 / 跨通勤

```bash
/disconnect continue           # 掉线不取消当前轮次
DSH_TUI_IDLE_EXIT_MS=600000 dsh --profile tui --resume
```

轮次在跑时 `DSH_TUI_DETACHED_IDLE_MS` 会自动续期，空闲后按 `DSH_TUI_IDLE_EXIT_MS` 退出并让锁——把上限设大是为了"回来还能接上"，不是为了让 Host 常驻。

### 4.5 一次性任务：官方 headless

不需要交互、只要最后一条回复时，用官方 `dsh --profile headless "…"`：跑完把最终文本打到 stdout 就退出。思考、工具调用、子代理都在会话日志里，终端上看不到——这正是本 TUI 存在的理由（同一条任务的对照图见 README）。

### 4.6 纯行模式（屏幕阅读器与日志录制）

```bash
DSH_TUI_LINE_MODE=1 dsh --profile tui --resume      # 每个事件追加若干纯文本行
DSH_TUI_LINE_MODE=1 ssh host 'dsh --profile tui --resume' | tee session.log
```

行模式**不画帧**：不进备用屏、不做绝对光标寻址、不用回车原地重绘、不出动画。每个事件按顺序追加一次，
多行内容（报告、diff、工具输出）按其自身结构展开，因此 `tee`、`script(1)`、屏幕阅读器都能完整读到。
状态符号（● ⚠ ✖、diff 的 `+`/`-`）仍然保留，语义不依赖颜色。全屏交互（鼠标拖选、卡片展开、
`/find` 高亮）在行模式下不可用——那是画帧的代价，需要时用普通模式。

## 4.7 让 dsh 自己走网络代理

插件跑在 dsh 进程里，所以"TUI 的网络"就是"dsh 的网络"。Node **不会**自动读 `HTTP_PROXY` /
`HTTPS_PROXY`：`NODE_USE_ENV_PROXY=1` 单独在 v24.19 上不生效，必须给 Node 传
**`--use-env-proxy`**（启动包装脚本里加，别用 `NODE_OPTIONS`——那会把模型跑测试、跑工具的
每个 Node 子进程也一起塞进代理）。

按域名分流用 `NO_PROXY`（后缀匹配，`deepseek.com` 覆盖整域）。国内直连更快、或直连比代理更稳的域名放这里，
例如：

```bash
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}deepseek.com,api.deepseek.com,commandcode.ai,api.commandcode.ai"
exec /path/to/node --use-env-proxy /path/to/@deepseek-ai/dsh/lib/bin.js "$@"
```

`cli-chat-proxy.grok.com` / `api.x.ai` / `auth.x.ai` **不要**放进 `NO_PROXY`：这台机器上 Grok 直连会被 RST，必须走代理。

容器/沙箱里如果只有代理出口，直连会成片超时——那种"直连失败"是出口的噪音，不能当成
"某家必须走代理"的证据；判断标准应该是**该域名直连是否稳定**，而不是一次超时。
`127.0.0.1` / 本机网段务必留在 `NO_PROXY` 里：显示通道虽然走 AF_UNIX，但别把本地流量也绕出去。

## 4.8 401/403「凭据失效」怎么判断是谁的问题

会话里突然出现 `Turn N failed: OpenAI API error (403): {...}` 时，先别改 key——**同样是 403/401，来源可能是
提供商、也可能是本机没配凭据，两者的处置相反**。照着下面三步走，两分钟能定性（2026-09-29 实测过一次）。

**第一步：看错误体长什么样。** 三种形状对应三个不同的层：

| 你看到的 | 含义 |
|---|---|
| `{"success":false,"error":{"code":"UNAUTHORIZED",...}}`（HTTP 401） | **提供商自己的鉴权层**：请求带的 key 为空/无效。先查本机凭据。 |
| `{"message":"Authentication failed. Please check your credentials.","type":"permission_error"}`（HTTP 403） | 这个信封不是提供商鉴权层的格式——通常是它把请求转给上游后，**上游的鉴权失败被原样转回**（瞬时故障或上游凭据问题）。 |
| `{"type":"error","error":{"type":"permission_error","message":"MODEL_NOT_IN_PLAN: …"}}`（HTTP 403） | **套餐/权限**：这个模型不在你的计划内。换模型或升级套餐，与 key 无关。 |

**第二步：确认本机凭据还在（而不是"插件把配置弄丢了"）。**

```bash
# 路由声明是否完整（apiKeyEnv 指向哪个变量、baseURL 是什么）
grep -A6 'command-code:' ~/.dsh/profiles/tui/cordis.patch.yml | head -12
# 凭据库里那个变量有没有值（只打印名字与长度，不打印内容）
node -e "const y=require('js-yaml'),fs=require('fs');const d=y.load(fs.readFileSync(process.env.HOME+'/.dsh/.credentials.yaml','utf8'));console.log(Object.keys(d.refs))"
```

`.credentials.yaml` 的 mtime 也是个线索：如果它很久没被动过，而 TUI 每次都按会话重写 `cordis.patch.yml`
（里面的 `!!js ctx.sshTuiStartup.sessionId` 每启动都会变），那么"配置被插件改坏"基本可以排除。

**第三步：拿同一把 key 直接打提供商**（这一步才能真正分清"key 死了"和"上游抖了"）：

```bash
KEY=$(node -e "const y=require('js-yaml'),fs=require('fs');const d=y.load(fs.readFileSync(process.env.HOME+'/.dsh/.credentials.yaml','utf8'));process.stdout.write(d.refs.COMMAND_CODE_API_KEY)")
# 需要鉴权的端点：200 = key 有效；401 = 本机凭据问题；403+permission_error = 上游/套餐
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.commandcode.ai/provider/v1/responses \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"deepseek/deepseek-v4.1-flash","input":"hi","max_output_tokens":16,"stream":true,"reasoning":{"effort":"max"}}'
```

注意 `GET /provider/v1/models` 是**公开**的：带不带 key 都返回 200，用它判断鉴权会得出错误结论。

**结论怎么读**：第三步 200 + 会话里是第二种信封 ⇒ **提供商侧瞬时故障**，直接重发即可（那次实测：同一会话 37 轮
在同一条路由上成功，失败只有间隔 45 秒的两次，而随后同一把 key 打同一模型 200）。第三步 401 ⇒ 本机凭据要重配。
第三种信封 ⇒ 套餐/模型权限。

**插件替你做的事**：失败时除了原始错误行，还会补一行来源判断——`提供商拒绝了请求（HTTP 403）…{ENV} 已配置`
（意思是别改 key，重发即可）或 `本机没有可用的 {ENV}`（意思是先去配）。原因是宿主的 `llm/retry` **不重试
AUTH 类错误**，所以一次瞬时 403 会直接终结整轮。要让它在"提供商侧鉴权失败"时**自动重试一次**：

```
/retryauth on      # 默认关；重试会把整段上下文再发一遍，长会话请自己权衡
```

重试**每次发送最多一次**（重试自己那一轮不会再触发），且只对"提供商拒绝 + 本机有凭据"这一类生效——
本机缺凭据时重试毫无意义。

## 4.9 两种 400:一种是我们能压的,一种是上游的 bug

2026-09-29 在一个长会话里数出 **6 次 400**,全部落在同一条路由(`command-code` + `deepseek/deepseek-v4.1-flash`,
effort=max),但**分两族、两个不同的成因**:

| 族 | 正文 | 次数与时间(UTC) | 归属 |
|---|---|---|---|
| A | `json: unknown field "summary"`(HTTP 400 `InvalidParameter`) | 1 次(09-28 01:45,turn 26) | pi-ai 的 `openai-responses` 适配器在设了强度时会发 `reasoning.summary`,而这家的 Go 网关不认这个字段 |
| B | `The reasoning_text in the thinking mode must be passed back to the API.`(`invalid_request_error`) | **5 次**(09-29 07:24 turn 36;14:02 / 14:05 / 14:13 / 14:16 turn 45–48) | **上游 harness 的 bug**:多轮会话把上一轮的 reasoning 块丢了,而思考模式下网关要求回传 |

**A 族**:全局 CLI 里的 pi-ai 副本被本机打过一个补丁(一直在,`.bak` 也在),
`dist/api/openai-responses.js` 第 260 行:

```js
- summary: options?.reasoningSummary || "auto",              // 原文:没设也会发 "auto"
+ ...(options?.reasoningSummary ? { summary: options.reasoningSummary } : {}),   // 补丁:只在显式设置时才发
```

单轮探针也验证过:带 `reasoning:{effort:"max"}`(不含 `summary`)打 `/provider/v1/responses` 返回 200。
**升级 dsh 族会覆盖这个文件,补丁会丢**——补丁丢了的症状就是 A 族 400 重新出现,照上面这行重新打即可
(打之前先 `cp openai-responses.js openai-responses.js.bak`)。

**B 族不是我们的问题,而且已被上游记录**:

- <https://github.com/deepseek-ai/deepseek-harness/discussions/1780>(切到第三方模型后多轮对话报同一个错)
- <https://github.com/deepseek-ai/deepseek-harness/discussions/231>(多轮会话丢 reasoning 块 → 400,
  openai-responses 自定义提供商 —— 与我们的路由形态一致)

本机实验支持"是客户端丢块,不是网关挑剔":同一模型、同一 `effort=max`,第一轮拿到 `reasoning` 项(id `rs_…`),
第二轮**带上/不带**它都成功(两轮短对话测不出差异);失败只出现在长会话的**续写**上,正是"历史重建时丢块"的特征。

绕开办法:把这条路由的**思考关掉**(`/effort off`,没有思考就没有要回传的东西),或改用同一网关的
**`command-code-messages`**(anthropic-messages 风味,思考块带签名、harness 会正确回传),或者等上游修。

**插件会在失败时直接说这句话**(与 A 族同理):B 族 400 一到,TUI 会补一行
「这是上游的已知缺陷…绕开办法:`/effort off` 或 `command-code-messages`」并附 #1780/#231——它**不会**触发
`/retryauth` 的自动重试,因为这个 400 是确定性的(重发必然再失败)。

**A 族要主动维护**:补丁在依赖里,升级族就会丢。升级后跑一次

```bash
node scripts/patch-pi-ai-summary.mjs --check   # 退出码 1 = 有文件需要修
node scripts/patch-pi-ai-summary.mjs           # 修,自动留 <file>.bak(幂等)
```

它覆盖 `openai-responses.js` 与 `azure-openai-responses.js`,并会在"上游改了形状、既不匹配原文也不匹配补丁后"
时**拒绝动手**并让你先读文件(而不是假装已经好了)。2026-09-29 首次运行修好了 `azure-*`(三处安装各一份)
与 `/usr/lib/node_modules` 那份未打的副本。

## 5. 明确不做（以及为什么）

- **内置 `--daemon` 常驻模式**：Host 不是服务。它是"某个会话的写者"，靠 idle-exit 把写锁交还；把它变成常驻服务会让 Web UI 与其它窗口长期打不开同一会话。
- **`detachedApproval = pause`（断线时挂起审批等用户回来）**：看似更"尊重用户"，实际会与第 2 节的兜底打架——轮次停在一个没人能确认的审批上，直到 idle-exit 把它带走，结果既没执行也没拒绝。当前行为（拒绝 + 写清理由）让轮次能收尾，模型会在你回来前调整做法。
- **多窗口同屏 / 只读旁观**：锁语义与收益都未验证，不做。

## 6. 排障入口

- `/diag`：这条会话的通道、锁、Host 身份、判定链（"会接入后台 Host，不要另开第二个窗口"）。
- `/retryauth [on|off]`：要不要在"提供商侧鉴权失败"时自动重试一次（见 4.8）；`/doctor` 看路由与凭据是否就位。
- 桌面版(官方 GUI 应用)与终端配置的关系、两个上游缺陷:见 [`desktop.md`](desktop.md)。
- **400 先分族**:`unknown field "summary"` 是本地 pi-ai 补丁丢了(4.9 A 族),`reasoning_text must be passed back` 是上游 harness 的 bug(4.9 B 族)。
- `/doctor`：profile 组合、依赖、兼容与 `dsh-scope` 副本数；`/doctor --fix` 修 profile 补丁（写前备份）。
- 真机验收脚本：`node scripts/tui-probe.mjs`（启动/缩放//diag//doctor//copy error//preset/鼠标模式/退出）、
  `node scripts/tui-drop-probe.mjs`（杀掉窗口再接管，断言转录保留、可输入、无乱码）与
  `node scripts/tui-mock-probe.mjs`（**合成临时 profile + 脚本化模型**，跑一个真实轮次后验证"拖选复制"
  与 `/find` 高亮；不碰你的 profile、不花额度）、同一脚本的 `--busy`（**忙碌断线**：轮次在飞时杀掉窗口，
  断言 Host 仍持有会话、重连窗口打出「已重连 N 次」）；`node scripts/verify-batch.mjs --batch <批>` 一次跑完全部证据。
