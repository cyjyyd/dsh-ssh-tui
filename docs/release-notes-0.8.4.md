# 0.8.4 — Input Ownership & Release Hardening (Stable Candidate, Unpublished)

> **状态：`0.8.4` 尚未发布。** 当前包版本是 `0.8.4`，但还没有 `v0.8.4` tag、GitHub Release
> 或 npm publish。`0.8.4-rc.1` 是 2026-10-17 已发布的候选版，其历史记录保留在
> [`release-notes-0.8.4-rc.1.md`](release-notes-0.8.4-rc.1.md)，不因本轮材料修正而改写。
>
> 自 RC.1 之后，`release/0.8.4` 维护分支合入了四项修复（FI1、WIN-CI1.H3、APPR.BP1、DOC.R1）。
> 因此 Stable runtime 与 RC.1 **不相同**，也不能再声称 `lib/` 与 RC.1 tarball 逐字节一致。
> 后续必须由获授权的 `0.8.4-rc.2` 重新生成版本、tarball、哈希、CI 和升级收据；RC.1 的旧收据
> 不能转用为本候选的发布证据。
>
> `dsh-ssh-tui` 现在以 **DSH Relay** 为产品名展示；npm 包名与安装命令没有变化。

## 版本状态

- `0.8.4-rc.1` 的 annotated tag 是 `a2645c9134646f83d8a5db758743476285f9840b`，其指向的提交是
  `0e1342a9f4a7cbb922971891e9b26a311a7c7026`（2026-10-17）。
- 本轮材料核对时的候选代码基线为 `release/0.8.4` 的
  `e1eccf42495d31a5212acafc8589bd8758f63f3c`（2026-10-24）；本材料修正只改文档，不改变代码或版本。
  该基线从 RC.1 发布提交之后继续维护，包含下列四项修复。
- 当前没有 `v0.8.4` tag、GitHub Release 或 `0.8.4` npm 包；`latest` / `next` 仍以上一次 RC.1
  发布记录为准，不能把本候选写成已经发布。
- Stable 维护线的发版来源是 `release/0.8.4`，不是 `main`。`main` 上的 W-4 Completion 或
  W-5 Search Screen 不属于本线，不得混入本候选。
- `0.8.4-rc.2` 是待授权的后续候选，不是已发布版本。新 RC 必须使用自己的版本号、候选 SHA、
  CI 四条腿和升级冒烟收据；正式 tag 必须指向经过测试的精确候选 SHA。

## 本版包含（RC.1 之后）

### FI1 — 首次安装的 Agent Plane 自动补齐

首次向导保存后、以及旧或不完整 profile 启动时，TUI 只补当前组合缺少的 Agent Plane 工具行；
已存在的行不重复写入，写入前保留备份，重复启动保持幂等。若行已经写入但当前进程尚未组合它们，
界面会明确提示重启，而不是把“已保存”误报成“已生效”。这不是安装钩子，也不会把所有缺失行
无条件重写。

### WIN-CI1.H3 — RTT 探针的 Drain 不再丢弃按住的 Esc

RTT/liveness 探针开始时，输入过滤器可能正扣着一个单字节，因为它还可能是光标应答 `CSI ... R`
的开头。`TerminalInputPump.drain()` 不再重置过滤器并丢掉这个字节，而是保留它并重新安排释放：
如果后续应答到达，字节合并为应答；如果窗口结束仍不完整，就按原有规则交还为键入。切开的应答
仍不会被误认成 Escape。

### APPR.BP1 — AI Reviewer 传递真实授权 Session

Reviewer 的 `GenerateOptions` 现在携带授权 Agent 的真实 `sessionId`。同一 Session 的复核共享
身份，不同 Session 或子 Agent 不共享。Reviewer prompt、400-token budget、15 秒 deadline、
reasoning effort、授权策略、缓存与 fail-closed 行为均未改变；该修复不写入用户对话记录。

### DOC.R1 — `/doctor` 纳入已注册 Adapter

`doctorRouting()` 保留 `llm-pi-ai.providers`，并合并 `ctx.llm.listProviders()` 返回的实际注册
Adapter ID，去重后用于路由自洽性检查。已注册的 `deepseek-official` 不再被误报为“不在已配置
路由里”；第三方 Provider 缺失、已配置 Provider 的非法模型、以及子代理跨 Provider Family
仍会继续告警。LLM 服务缺失或 `listProviders()` 抛错时回退到已配置集合，`/doctor` 不会崩溃。

“已注册或已配置”只表示路由存在，**不表示网络或 API 调用成功**。官方模型目录的实时校验仍是
**OPEN**：`routeModels` 为空时继续按“目录未知”处理，不会伪造 Model Missing。

## 兼容性

声明窗口与 `0.8.4-rc.1` 相同，没有新增兼容声明：

```text
>=0.2.0-rc.1 <0.2.1 || >=0.2.1-rc.2 <0.2.2
```

- `0.2.1-rc.2` 仍是默认开发线。
- `0.2.0-rc.1` / `0.2.0-rc.2` 继续保留兼容表态与 CI 腿。
- `0.1.7` 线自 `0.8.4-rc.1` 起为 `incompatible`。
- `0.1.5` 及更早从 `0.8.0` 起不再支持。

## 验证记录

以下是当前 `release/0.8.4@e1eccf4` 候选代码的本地/CI 收据，不是未来 RC.2 的收据：

- `npm run build`：通过。
- `npm run typecheck`：通过。
- `npm test`：**1540 项，1536 通过，0 失败，4 跳过**。
- `npm run freeze` / `npm run freeze:input`：通过。
- `npm run bench`：五个动作均为增量绘制，0 次整屏清屏。
- `npm run bench:report -- --check`：通过。
- `scripts/artifact-smoke.mjs`：当前候选 tarball 通过；包清单 **251 files**。精确 tarball
  bytes、shasum 和 integrity 必须由获授权的 RC.2 重新生成后记录，本文件不沿用旧值。
- 当前 `release/0.8.4` 的 Push CI **40057666773**：四条腿全部 success。
- `scripts/upgrade-smoke.mjs --from 0.8.4-rc.1 --to <current-candidate.tgz>`：通过
  （manifest、bundle 入口、凭据与会话存储均保留）。这是当前候选 tarball 的验证，不是 RC.2 的
  升级收据；RC.2 必须重新执行并绑定自己的 tarball。
- 清理构建的 `lib/` 与 RC.1 tarball **不再是**逐字节相同；本候选明确不引用旧版的
  `228 个文件逐字节一致` 收据。

Windows Terminal、conhost、IME 中文输入、多行中文粘贴、鼠标复制与 SSH 恢复仍按
[`release.md`](release.md) 的人工验收清单执行；本轮未实际人工执行的项目保持 **PENDING**，
不引用旧版本结果冒充本版验收。自动化 PASS 不是人工 Gate PASS。

## 已知限制

- **官方模型目录校验仍 OPEN**：`/doctor` 可以看到已注册的官方 Provider，但尚未异步读取
  `llm.listModels('deepseek-official')` 来校验官方模型成员；自定义官方 Catalog 缺少所选模型时
  仍可能漏诊。
- **过滤框对非 BMP 字符的限制（未修）**：picker 的过滤框仍以 `text.length === 1` 判单字符，
  `'🚀'.length === 2`，因此星平面字符在过滤框中会被丢弃。Composer、借用字段与向导字段正常。
- **陈旧 `lib/` 的打包风险（未修）**：`tsc` 不清理旧输出，`prepack` 也不跑 `clean`；发布必须从
  干净树构建。`artifact-smoke` 的清单检查是纪律证据，但脚本本身不阻止脏树打包。
- **时间敏感的 Windows 单元测试**：`session-list.test.mjs` 中 150ms mock 竞速用例在慢跑器上可能
  失败；这是测试 oracle 问题，不是产品行为，本版未修。
- **ConPTY 无法覆盖的帧级断言**：ConPTY 会重写行寻址并自行插入清屏，逐行寻址/不清屏类检查在
  Windows 上标记为 `NOT_MEASURED`；功能断言照常执行。
- **发布后 registry 比对仍是人工步骤**：发布前自动化 pack → 清单 → 安装 → 探针；发布后从
  registry 取回 tarball、核对 shasum/integrity 与 `lib/` 仍按 `docs/release.md` 执行。

## 安装

`0.8.4` 还未发布，因此当前**没有**可用的 `@latest` 安装命令。RC.1 用户的历史安装仍是：

```bash
dsh plugin --profile tui add dsh-ssh-tui@0.8.4-rc.1
```

只有获授权的 `0.8.4-rc.2` 或最终 `0.8.4` 完成版本、产物、CI、升级和人工 Gate 后，才更新
`latest` / `next` 与安装说明。配置、凭据和会话记录不需要迁移；但不要从本文件推断尚未发生的发布。
