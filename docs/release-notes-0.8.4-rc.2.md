# 0.8.4-rc.2 — First-install, Input & Doctor Reliability Candidate

> **发布通道：仅 npm `next`，不得触及 `latest`。**
> 此文档是候选版的发版说明；它本身不表示已经创建 Tag、GitHub Release 或完成 npm 发布。
> 候选来源：从 `release/0.8.4@127617b99101820ff548f6fa8b61f319b5084d24` 切出的独立发行准备分支。
>
> DSH Relay 仍使用 npm 包名 `dsh-ssh-tui`，没有改名、没有存储格式迁移。

## 为什么需要 RC.2

`0.8.4-rc.1`（2026-10-17）已经作为 prerelease 发布；它提供 Reader → Router → Owner 输入归属整理，以及首次安装向导、工作区粘贴和发布 tarball 的 CI 门禁。

此后维护分支进行了四项**实际运行时修复**，因此 RC.2 **不是** RC.1 的无变化重打包，不能沿用 RC.1 的字节、哈希、测试或人工验收收据。

## RC.1 之后的修复

### FI1 — First-install Agent Plane Repair

全新安装或旧的不完整 Profile 可能缺少 `tool-ask-user` 与 `present` 的 Agent Plane 组合行。TUI 现在能检测并定向补齐缺失项，写前备份、不覆盖已存在行、重复启动幂等。已写入但本进程尚未组合的工具会明确提示**重启才生效**，不把保存成功误报为运行时就绪。

### WIN-CI1.H3 — RTT Probe 不再丢弃 Esc

Launcher 的 `TerminalInputPump.drain()` 原先会把正在等待判别的 ESC 通过 `filter.reset()` 丢弃：用户按下 Esc 后，恰逢 RTT/存活探测，`/view` 选择器可能无法取消。现在保留暂存字节、重新安排释放；完整或分片的光标应答仍由过滤器识别，不以强制转发半截应答换取按键恢复。

### APPR.BP1 — Reviewer 绑定授权 Session

AI Reviewer 的直接 `llm.stream()` 调用携带 `request.agent.session.id`，保留同一会话身份、隔离不同 Agent Session 和子代理。Reviewer prompt、400-token 输出预算、15 秒 deadline、`reasoningEffort: off`、授权策略、缓存与 fail-closed 保持原样。未对完整真实线上审批延迟作保证。

### DOC.R1 — 官方 Provider 路由诊断

`/doctor` 的路由事实来自 `llm-pi-ai.providers` 与实际注册的 `ctx.llm.listProviders()` 的并集。官方 `deepseek-official` 已注册时不再被误报为“既未注册也未配置”，仍保留第三方非法模型与子代理不同族警告。**注册不等于联网调用成功**，官方模型目录的实时成员校验仍为 OPEN。

## 未纳入本候选

- W-4 Completion / W-5 Search Screen（`main` 开发线），未进入 `release/0.8.4`；
- PR #8 的独立 InputReader 粘贴尾部 Esc 边界修复（慢粘贴 payload ESC 语义权衡仍未收口）；
- PR #9 的 Host/Relay 诊断插桩；
- 官方模型目录实时校验、Reviewer 延迟预算重设计，以及其他未获授权的兼容范围变化。

## 兼容范围

与 RC.1 一致：

```text
>=0.2.0-rc.1 <0.2.1 || >=0.2.1-rc.2 <0.2.2
```

默认宿主开发线为 `0.2.1-rc.2`，兼容测试仍覆盖 `0.2.0-rc.1` / `0.2.0-rc.2`。0.1.7 及更旧宿主不在本候选支持范围内。

## 发布前证据门槛

以下证据**必须绑定最终候选 Commit 与其 tarball**，不能沿用 RC.1 或 Stable 的旧收据：

| Gate | 必需结果 |
|---|---|
| 源码与包身份 | `package.json` 和 lockfile 同为 `0.8.4-rc.2`；候选 Git SHA 冻结 |
| 四条 CI | Linux 三线及 Windows `test-windows` 全部 SUCCESS |
| 三道阻塞门 | Fresh-home 向导、Paste Probe、Packed Artifact 在默认 Linux 和 Windows 真实执行 |
| 产物可重复性 | 干净构建、`npm pack` 文件清单、bytes、shasum、integrity 与候选 SHA 对应 |
| 升级验证 | `upgrade-smoke --from 0.8.4-rc.1 --pack`；并核对 `0.8.3 → RC.2` |
| Windows 人工 | 真正 Windows Terminal / conhost、IME、中文粘贴、复制、重连、首次安装，H-1～H-11 逐项 PASS |
| 最终发布许可 | 维护者明确授权 Tag / GitHub prerelease / `npm publish --tag next` |

本文件不预先给出未生成的 RC.2 tarball 哈希、文件数或 CI 成功结论，人工 Gate 亦不得由 ConPTY 自动探针代替。

## 安装与发布通道

在 RC.2 正式发布之前，registry 的可用版本请以实际 packument 为准；既有历史记录中 `latest` 为 `0.8.3`，`next` 为 `0.8.4-rc.1`。

获得正式 RC.2 发布授权后，候选用户才能通过 `dsh plugin --profile tui add dsh-ssh-tui@0.8.4-rc.2` 或更新后的 `@next` 安装。正式 `0.8.4` 发布另走 `latest`，不在这次候选动作范围内。

历史候选记录：[0.8.4-rc.1](release-notes-0.8.4-rc.1.md)。正式稳定版准备说明：[0.8.4](release-notes-0.8.4.md)。
