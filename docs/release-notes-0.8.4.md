# 0.8.4 — Input Ownership & Release Hardening (Stable)

> **稳定版：`0.8.4-rc.2` 观察期结束后的正式转正。** 包版本为 `0.8.4`；产品代码与最终 RC.2
> 相同，只有版本元数据和发布材料变化，没有新增功能、兼容范围变化或存储迁移。
> 正式 tag、GitHub Release 与 npm `latest` 在最终四腿 CI 和规范 tarball 验证通过后创建；
> `next` 同步到 `0.8.4`，不再停留在旧候选。
>
> `0.8.4-rc.2` 的候选说明与收据保留在
> [`release-notes-0.8.4-rc.2.md`](release-notes-0.8.4-rc.2.md)；`0.8.4-rc.1` 的历史记录保留在
> [`release-notes-0.8.4-rc.1.md`](release-notes-0.8.4-rc.1.md)，不追溯改写。
>
> `dsh-ssh-tui` 现在以 **DSH Relay** 为产品名展示；npm 包名与安装命令没有变化。

## 版本状态

- `0.8.4-rc.1` 的 annotated tag 是 `a2645c9134646f83d8a5db758743476285f9840b`，其指向的提交是
  `0e1342a9f4a7cbb922971891e9b26a311a7c7026`（2026-10-17）。
- `0.8.4-rc.2` 的 annotated tag 是 `aa1688264c9ae246eb20651caced38bfd69d68d1`，其指向的提交是
  `5795f6052cdaba565b0db9bf1982aa622f40ac05`（2026-10-24），已作为候选发布到 npm `next`。
- `0.8.4` 从该 RC.2 转正；稳定版只把包版本改为 `0.8.4` 并更新发布材料，没有产品代码变化。
  Stable 维护来源是 `release/0.8.4`，不是 `main`；`main` 上的 W-4 Completion 或 W-5 Search Screen
  不属于本线。
- 正式发布后 npm `latest` 和 `next` 都指向 `0.8.4`。RC.2 的 tarball 哈希和测试收据保留为历史，
  不作为 `0.8.4` 稳定 tarball 的哈希。

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

0.8.4 与最终 RC.2 的产品代码相同；以下测试收据来自 RC.2 的最终验证，稳定版只改版本和发布材料：

- `npm run build`：通过。
- `npm run typecheck`：通过。
- `npm test`：**1540 项，1536 通过，0 失败，4 跳过**。
- `npm run freeze` / `npm run freeze:input`：通过。
- `npm run bench`：五个动作均为增量绘制，0 次整屏清屏。
- `npm run bench:report -- --check`：通过。
- `scripts/artifact-smoke.mjs`：RC.2 候选 tarball 通过，包清单 **252 files**。
- `scripts/upgrade-smoke.mjs --from 0.8.4-rc.1 --pack` 与 `--from 0.8.3 --pack`：通过
  （manifest、bundle 入口、凭据与会话存储均保留）。
- 最终 `0.8.4` 的四腿 CI、规范 tarball 的 bytes / SHA1 / SHA256 / integrity 与 Registry
  回读结果记录在独立发布回执中；本文件不把 RC.2 的哈希写成稳定 tarball 的哈希。

Windows Terminal、conhost、IME 中文输入、多行中文粘贴、鼠标复制与 SSH 恢复仍按
[`release.md`](release.md) 的人工验收清单执行；H-2 的 conhost / ASCII 边框确认已由维护者完成，
其余未实际人工执行的项目仍保持 **PENDING**，不引用旧版本结果冒充本版验收。自动化 PASS 不是
人工 Gate PASS。

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

稳定版走 `latest`，当前正式版本为 `0.8.4`：

```bash
dsh plugin --profile tui add dsh-ssh-tui@latest
dsh --profile tui
```

`@next` 也已同步到 `0.8.4`；需要固定版本时可显式使用 `dsh-ssh-tui@0.8.4`。

历史候选仍可按精确版本安装：

```bash
# 历史 RC.2
dsh plugin --profile tui add dsh-ssh-tui@0.8.4-rc.2

# 历史 RC.1
dsh plugin --profile tui add dsh-ssh-tui@0.8.4-rc.1
```

已安装 `0.8.3`、`0.8.4-rc.1` 或 `0.8.4-rc.2` 的用户可以升级；配置、凭据和会话记录不需要迁移。
