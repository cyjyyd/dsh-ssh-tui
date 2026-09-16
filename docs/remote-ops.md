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
| 你开了第二个窗口去接同一个会话 | 新窗口接管显示，旧窗口退出（`replaced`）。**不要为同一个会话起第二份 Host** |

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

## 5. 明确不做（以及为什么）

- **内置 `--daemon` 常驻模式**：Host 不是服务。它是"某个会话的写者"，靠 idle-exit 把写锁交还；把它变成常驻服务会让 Web UI 与其它窗口长期打不开同一会话。
- **`detachedApproval = pause`（断线时挂起审批等用户回来）**：看似更"尊重用户"，实际会与第 2 节的兜底打架——轮次停在一个没人能确认的审批上，直到 idle-exit 把它带走，结果既没执行也没拒绝。当前行为（拒绝 + 写清理由）让轮次能收尾，模型会在你回来前调整做法。
- **多窗口同屏 / 只读旁观**：锁语义与收益都未验证，不做。

## 6. 排障入口

- `/diag`：这条会话的通道、锁、Host 身份、判定链（"会接入后台 Host，不要另开第二个窗口"）。
- `/doctor`：profile 组合、依赖、兼容与 `dsh-scope` 副本数；`/doctor --fix` 修 profile 补丁（写前备份）。
- 真机验收脚本：`node scripts/tui-probe.mjs`（启动/缩放//diag//doctor//copy error//preset/鼠标模式/退出）、
  `node scripts/tui-drop-probe.mjs`（杀掉窗口再接管，断言转录保留、可输入、无乱码）与
  `node scripts/tui-mock-probe.mjs`（**合成临时 profile + 脚本化模型**，跑一个真实轮次后验证"拖选复制"
  与 `/find` 高亮；不碰你的 profile、不花额度）、同一脚本的 `--busy`（**忙碌断线**：轮次在飞时杀掉窗口，
  断言 Host 仍持有会话、重连窗口打出「已重连 N 次」）；`node scripts/verify-batch.mjs --batch <批>` 一次跑完全部证据。
