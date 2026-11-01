# 0.8.5-rc.1 — Completion, Local Search, Input Reliability & Long-session Replay

> **CANDIDATE / UNRELEASED — 0.8.5-rc.1 候选已通过工程验收，尚未发布。**
> 此文件位于隔离准备分支，不表示候选包、Tag、GitHub Prerelease、npm `next` 已创建或发布。
> 基线：`main@35e62ebc564970ee8f9a20d966bc4f9c1b4de116`（合并 PR #34 之后）；版本 `0.8.5-rc.1`。
> 最终提交 SHA 与 tarball 哈希记录在 PR #35 的候选收据中：本文档随包发布，不能自引用包自身的哈希。
> 本候选来自新的 `main`，**不是** `release/0.8.4` 稳定维护分支。
>
> DSH Relay 继续使用 npm 包名 `dsh-ssh-tui`；本候选未计划改变会话持久化格式、已有 Host 生命周期合同或正式支持的默认上游版本。

## 为什么是 0.8.5

相对于已发布的 0.8.4，本候选汇入了开发主线的 W-4 命令补全、W-5 本地搜索、Relay 连接归属防护，以及 R2/R3/R4.A 的长会话回放优化；同时修复了括号粘贴丢失结束标记时 Esc 被当作文本吞掉的独立缺陷。

这**不是** 0.8.4 的重新打包：新增产品功能与运行时行为改变都必须在 `0.8.5-rc.1` 的精确候选提交上重新测试，不能借用 0.8.4 或此前的主线 CI 收据。

## 用户可见改进

### W-4 — Composer 拥有的命令补全

补全状态集中在 `src/completion.ts`，输入框草稿、命令目录变更、语言切换和 Screen/Surface 抢占通过统一刷新路径更新。建议列表的 ↑/↓、Tab、Enter、Esc 等行为保持既定归属，不因一次 read 合并多个键而把补全指令错误送入历史或隐藏输入框。绘制只读取已派生状态，不在每一帧重新查询命令列表。

### W-5 — `/find` 本地 Search Screen

在有帧终端中，`/find` 提供独立的 Search Screen，包含搜索字段、结果列表及只读预览；结果跟随当前工作区可见转写和 `/clear` 截断范围，不建立永久全文索引，也不会搜索已持久化但不在当前可见工作区的历史。行模式保留文本搜索行为。

搜索输入、滚动、预览、复制和退出遵守现有 Screen 单层深度与键盘所有权；被隐藏的 Composer 草稿不应因搜索操作被修改。

### Esc 与括号粘贴的输入可靠性

PR #34 修复了失去或截断 `ESC[201~` 结束标记时，后续 Esc 可能在 2 秒粘贴标记窗口后被当作 `paste` / `literal` 文本释放、无法取消 Screen 的问题。

- 裸 `ESC` 按键采用原有 60 ms 判别窗口；较长的半截标记继续保留原标记等待语义。
- 若在粘贴仍打开时，裸 `ESC` 已先交给输入路由器，随后分片补完的 `[201~` 会被识别并消耗，不泄漏到屏幕或草稿。
- 未补完片段有固定截止时间；`stop()` 在 detach 时清空暂存输入并撤销计时器，重连后复用 Reader，不永久禁用输入。

**不可消除的字节歧义：** 单独的 `ESC` 既可能是真正的 Esc 键，也可能是被慢速分片的粘贴结束标记前缀。如果补全超过按键窗口，已经发出的 Esc 无法撤回；后续有效标记字节仍会被消费，尽量避免进入 Composer。此取舍已单独验收，不应宣传为所有极慢终端上零误判。

### Relay 连接归属隔离

W6B.F0 的 current-socket 防护阻止被后续连接替换的旧 Relay 继续向当前 Host 注入输入、尺寸、RTT、metrics 或 probe 回答；只读的连接状态查询保持原有非抢占语义。这是连接安全修复，**不是** W-6 Terminal Doctor 功能交付。

## 长会话恢复性能

开发主线合入三个独立的定向优化：R2 限制无关 plan 投影回放，R3 优化问题卡投影与 canonical `toolCallId` 关联，R4.A 避免普通 `tool/result` 重复扫描子代理卡，同时保留未知调用关联的保守回退。

独立私有冻结前缀上，在各自同机器同口径的 A/B 测试中测得 replay 与首次可接受输入改善；这些数据**不是**跨平台或所有会话的速度保证。R4.C0 指出剩余主要冷启动时间属于 Node/DSH 启动及上游 `sessionPersistence.open('write')` 的完整日志物化，因写入所有权、事件校验及中断回合修复风险，未在插件本地实施绕过。

**仍为已知限制：** 54,519 事件级别的超长会话冷恢复仍约需 11 秒到首次完整画面，未达到早期的 5 秒目标。Warm attach 与冷 Host resume 不能混为同一基准。

## 上游兼容状态（必须在发布前再次核对）

当前候选计划保留现行已验收宿主及默认开发线：

| DSH Host | 声明 | 证据性质 |
|---|---|---|
| `0.2.0-rc.1` | 已声明支持 | 标准 CI 旧线 |
| `0.2.0-rc.2` | 已声明支持 | 标准 CI 旧线 |
| `0.2.1-rc.2` | 已声明支持、默认开发/Windows 线 | 标准 CI |
| `0.2.1-rc.3` / `rc.4` | 未完成兼容验收 | 不从历史实验继承 PASS |
| `0.2.1-rc.5` | **EXPERIMENTAL / NOT DECLARED COMPATIBLE** | 独立 Linux/Windows 实验 CI 通过部分覆盖，非正式声明 |
| `0.2.2-alpha.*` | 未验收 | 不属于 RC 支持范围 |

**发布前必须裁决的兼容策略：** 当前 `peerDependencies` 与 `dsh.compatibility.dsh` 的版本范围在 npm semver 下可匹配 `0.2.1-rc.5`，但 `dshReleases` 只明确标记 rc.2 已兼容；且 `dshReleases` 是诊断表态，不能视作阻止新 RC 加载的门禁。必须在“完整验证后晋升 rc.5 / 明确接受实验宿主风险 / 收紧兼容范围”中选定并验收方案，不能以默认开发线仍为 rc.2 代替决策。

## 明确不包含

- W6B `/terminal` Terminal Doctor 快照屏与 W6C 主动重新探测协议；
- W-7 picker/router 重构、其他未合并的实验性 UI 工作；
- R4.C1 本地 Host 启动或 `agents.resume` 优化，以及上游持久化绕过；
- rc.5 正式兼容晋升、默认宿主升级、Provider 实时模型目录完整校验；
- 任何会话持久化格式迁移承诺。

## 候选发布 Gate（在最终候选提交上执行）

| Gate | 当前记录 |
|---|---|
| 版本身份 | **PASS** — `package.json` 与 `package-lock.json` 同为 `0.8.5-rc.1`；锁文件根 peer 元数据与 manifest 同步 |
| 四腿 CI | **PASS** — 最终候选 SHA 的 `0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-rc.2` 与 Windows 四条腿全绿；run 记录在 PR #35 收据 |
| 输入与首装 | **PASS（自动）** — 真 PTY/ConPTY 粘贴、首装向导、stdio、busy-drop、断线重连均在候选或 rc.5 实验腿执行成功 |
| 真正的 tarball | **PASS** — 干净构建后 `npm pack`，包内 `lib/` 与构建树 `diff` 为空；文件数、bytes 与 SHA-1/SHA-256/integrity 记录在 PR #35 收据 |
| 升级冒烟 | **PASS** — 已发布 `0.8.4` → 候选 tarball，manifest、bundle 条目、凭据与会话存储保持 |
| Windows 人工验收 | **PENDING（所有者）** — Windows Terminal/conhost、输入法、中文粘贴、复制和断线恢复；不能以 ConPTY 自动 CI 替代 |
| 宿主兼容策略 | **RC 阶段采用 B** — 保留 peer 范围并明确披露 rc.5 为 EXPERIMENTAL；不写入 `dshReleases`；稳定 0.8.5 前复核 A |
| 发布动作 | **NOT AUTHORIZED** — Tag、GitHub Prerelease、`npm publish --tag next` |

历史 PR #34 的 4/4 CI、rc.5 实验 2/2 CI 与合并后 main 的验证只是候选准备依据，不能冒充版本化 tarball 的最终验收数据；此前的旧版本哈希、文件数量和安装回执不得复制为 0.8.5 的结果。

### rc.5 兼容策略（RC 阶段：B，实验披露）

当前 `peerDependencies` 与 `dsh.compatibility.dsh` 的 semver 范围可以匹配上游当前的 `0.2.1-rc.5`，但 `dshReleases` 只声明 `0.2.1-rc.2` 及两条 `0.2.0` RC 兼容。本候选采用**方案 B**：保留现有 peer 范围，在文档和发布说明中明确 `0.2.1-rc.5` 为 **EXPERIMENTAL / NOT DECLARED COMPATIBLE**，允许用户在自行承担实验宿主风险的前提下试用；不把它写入 `dshReleases`，也不改动默认开发线。

rc.5 已通过 Linux/Windows 两条独立实验 CI（含首装、tarball、stdio、粘贴、busy-drop、断线重连），但仍缺真实 SSH 慢链路、Windows 人工终端与实时 Provider 验收，因此不足以宣称 `compatible`。稳定 `0.8.5` 发布前应复核方案 A（补齐剩余 Gate 后正式支持）或收紧范围；实验宿主的风险接受由所有者最终确认。

## 安装通道

在最终发行授权前，`0.8.5-rc.1` **尚未发布，不能声称可从 npm 安装**。若之后批准正式候选发布，仅进入 npm `next`，不得变更 `latest`。观察期结束后是否发布稳定 `0.8.5`，另行独立决策。
