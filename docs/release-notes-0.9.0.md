# 0.9.0 — Stable Candidate in preparation（未发布）

> **STABLE CANDIDATE IN PREPARATION — NOT A RELEASE.** 本文档随 `0.9.0` 稳定候选源码树
> 一起准备，但该候选**尚未**创建 `v0.9.0` Git tag、GitHub Release 或 npm `0.9.0` 版本，
> 也**没有**改动 `latest` / `next`。当前 `latest` 仍指向已发布 Stable `0.8.6`，`next`
> 仍指向已发布预发布 `0.9.0-rc.1`。本文档不是 Stable 发布声明，也不构成任何发布承诺。
>
> 源码基线：`368baeac6636709d81c08e87455a56d3be91a22c`
> （tree `b20db899f3a786943d66721ea7e8533c22c5f025`，即已发布 `0.9.0-rc.1` 的精确
> commit）。本准备单只在其上增加版本身份、状态文案与候选材料，不改产品运行时行为；
> 精确候选 SHA、CI run 与 tarball 哈希记录在 #81 的 `REL090-STABLE.PREP4_R1` 回执中。
> 包内文档不能自引用发布后的哈希。

本候选来自 `0.9.0` 主线开发栈（9 Host 候选），**不是**已发布 Stable `0.8.6` 的重新打包，
也不是 `release/0.8.4` 维护线。

## 当前发布状态

| 对象 | 状态 |
|---|---|
| 已发布 Stable | `0.8.6`（npm `latest`；七个冻结 Host） |
| 已发布预发布 / 历史 | `0.9.0-rc.1`（2026-11-24 的 GitHub prerelease 与 npm `next`；历史材料见 [docs/release-notes-0.9.0-rc.1.md](release-notes-0.9.0-rc.1.md)） |
| 本文档候选 | `0.9.0` — **stable candidate in preparation / not published** |

`0.9.0` 与已发布 `0.9.0-rc.1` 的内容一致；本准备单只把候选身份从 `0.9.0-rc.1` 转正为
`0.9.0`，并让 README、CHANGELOG、发版说明与版本钉死测试跟随状态。没有新增用户功能，
没有新运行时源码，也没有重新打包。

## 为什么是 0.9.0

相对已发布 Stable `0.8.6`，0.9 主线汇入了三项面向会话现场的能力，并把兼容矩阵从七个
冻结 Host 扩展到九个精确 Host 版本。这个稳定候选的目标是冻结候选身份与证据，不是新增
功能：

- **W6B `/terminal`**：Terminal Doctor 的**快照屏**，报告当前 attach 已知的终端能力与
  证据年龄；不包含 W6C 的主动重新探测协议。
- **TITLE.G1 `/rename`**：只重命名**当前会话**的标题，写回 Host title 服务并刷新本地
  元数据；不包含归档、历史会话搜索或批量重命名。
- **cache-only `/context`**：Overview + Composition 两层视图，20/40/80 列分级与 18 cell
  有界回退；只读取一次 header-keyed `sessionProjectionCache` 的 `cachedSnapshot`，不读取
  event log、projection registry 或历史正文。STALE / UNKNOWN / `routeUnverified` 均如实
  展示，provider provenance 使用 `modelSelection.lastUsed`（不是 `next`）。

没有新的用户功能超出上述已评审范围；本候选不重开 Reader、Search V09、Picker/F2、
archive/restore/delete/reset 或 AgentTeam deep。

## 兼容范围：九个精确 Host

Node.js 要求 `>=24.9.0`。声明窗口是精确并集，不是无界 semver：

```text
0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.5 || 0.2.2-rc.1 || 0.2.2-rc.2 || 0.2.2-rc.3 || 0.2.2-rc.4 || 0.2.2-rc.5
```

| Host pin | 0.9.0 候选状态 | 证据性质 |
|---|---|---|
| `0.2.0-rc.1` | 候选范围有限技术准入 | Linux exact install + probes；旧线保留 |
| `0.2.0-rc.2` | 候选范围有限技术准入 | Linux exact install + probes；旧线保留 |
| `0.2.1-rc.2` | 候选范围有限技术准入；默认开发线 | 提交的 manifest/lock 安装它，默认 Linux leg 跑全量探针 |
| `0.2.1-rc.5` | 候选范围有限技术准入 | Linux 全量腿 + Windows ConPTY 腿 |
| `0.2.2-rc.1` | 候选范围有限技术准入 | Linux 全量腿 + Windows ConPTY 腿 |
| `0.2.2-rc.2` | 候选范围有限技术准入 | Linux + Windows ConPTY；上游来源 `EVIDENCE_LIMITED` |
| `0.2.2-rc.3` | 候选范围有限技术准入 | Linux + Windows ConPTY；上游来源 `EVIDENCE_LIMITED` |
| `0.2.2-rc.4` | 候选范围有限技术准入 | Linux + Windows ConPTY + rc.4/rc.5 synthetic characterization；上游来源 `EVIDENCE_LIMITED` |
| `0.2.2-rc.5` | 候选范围有限技术准入 | Linux + Windows ConPTY + rc.4/rc.5 synthetic characterization；上游来源 `EVIDENCE_LIMITED` |

**这是候选范围内的 qualified technical admission，不是已公开发布的 Host 支持，也不是
`0.9.0` 已发布的声明。** `0.2.2-rc.2` / `rc.3` / `rc.4` / `rc.5` 的上游 source-to-artifact
证据均为 `EVIDENCE_LIMITED`：保留既有 qualified Owner exceptions，不声称完整 npm
`gitHead` / attestation 或 `FULL_PASS`；#42 的 provenance Gate 状态不因本候选改写。

`0.2.1-rc.5` 与 `0.2.1-rc.2` 在退役裁决前继续保留；`0.1.7` 及更早仍由 `dshReleases`
标为 `incompatible`，启动器会拒绝。

## Windows 桌面范围与 Windows Server 排除

**支持的桌面 Windows 范围**：Windows 10 / Windows 11 桌面版，使用 Windows Terminal 或
conhost。Windows 10 仅在既有 CI / 真机范围内做**有界实测**，不等于所有 Windows 10
配置通过。CI 在 GitHub Windows runner 的 ConPTY 上覆盖六条 Host 线（`0.2.1-rc.5`、
`0.2.2-rc.1` / `rc.2` / `rc.3` / `rc.4` / `rc.5`）；该 runner 是测试基础设施，不构成对
Windows Server 的支持。真机 Windows 11、特定终端/IME 组合、以及“所有桌面 Windows 组合”
仍为 `NOT_MEASURED` 或未覆盖，本候选不作通过声明。

> **⚠️ Windows Server 系列（含 Server 2025）不在 0.9.0 支持范围。历史 Windows Server 2025 question-wait 双换行 CI RED 仍保留，根因未明；不保证 Server 兼容性。**
>
> **Windows Server family (including Server 2025) is outside the supported scope of 0.9.0. The historical Windows Server 2025 question-wait double-newline CI RED remains, with root cause unknown; Server compatibility is not guaranteed.**
>
> 原始 RED：[Actions 44881356855 / job 136777141174](https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/44881356855/job/136777141174)。
> 独立 bounded D5 审计：[PR #89 comment 7090676703](https://github.com/cyjyyd/dsh-ssh-tui/pull/89#issuecomment-7090676703)。
> 这条历史 RED 是 out-of-support 的 **NON_BLOCKING** 记录，不因 0.9.0 候选被改写为 GREEN
> 或“已修复”。Server 兼容性只可能按新反馈/新测试另行调查，不是 0.9.0 的发布承诺，也不是
> 0.9.0 的阻塞项。

## Search 出口、计费与 credential 警告

`0.2.2-rc.5` 的 DeepSeek 模型路由（`deepseek-official` / `deepseek-account`）默认走
**Messages Search**；其他路由或没有模型请求时可选择 **Search API**。
`llm-deepseek.baseURL` 只是模型网关，**不会自动约束搜索端点**。legacy Messages Search
使用独立的 `web-search-deepseek.baseURL` / `DEEPSEEK_SEARCH_BASE_URL`（官方默认
`https://api.deepseek.com/anthropic/v1/messages`）和对应密钥；Search API 则使用其自身
来源（source）的 origin 与 key，不继承模型网关。

搜索请求可能被上游单独计费，但 Relay 的 token 统计只汇总对话 turn 的 usage；辅助搜索
请求事件不携带 usage，也不进入 `/status` 的 Relay totals。默认 provider / API /
credential outlet 的既有警告继续保留：不要把真实生产 credential 写入测试或仓库；
相关测试只使用 fake key、loopback/mock HTTP 和 `fetch` tripwire，**不会向真实官方或
网关发起请求**。

## 明确排除（不在本候选范围）

- **Historical Context Reader**：PR #49 / #50 / #73 的只读历史 Reader；不会读取冷同步
  历史或历史正文。
- **`/search` V09**：不包含 V09 搜索能力。
- **Picker / F2**：不包含 Picker 重构或 F2 行为变更。
- **Archive / Restore / Delete / Reset**：不包含会话归档、恢复、删除、重置。
- **AgentTeam deep**：不包含 AgentTeam 深层集成。

这些排除项是候选边界，不是“以后自动包含”的承诺。

## 验证与证据状态

- **RED → GREEN**：版本从 `0.9.0-rc.1` 转正为 `0.9.0`、文案跟随状态后，两个版本钉死
  测试先按旧身份断言失败（RED）；把测试按状态忠实更新为“rc.1 历史 / 0.9.0 候选未发布 /
  0.8.6 当前 stable”后同一套断言 GREEN。没有删除、跳过或削弱功能断言；具体断言与
  实际/期望值记录在 #81 回执。
- **本地**：本准备单运行 `npm run build`、full `npm test`、`npm run typecheck`、
  `npm run freeze`；命令摘要与结果记录在 #81 `REL090-STABLE.PREP4_R1` 回执。没有执行
  真实付费 Provider 调用。
- **CI**：Draft PR 跑完整 16-job 矩阵（Linux 九 Host + Windows ConPTY 六线 + synthetic
  characterization），只使用 synthetic fixture / fake key / loopback。精确 run/job URL
  记录在 #81 回执；本文件不写死未来 run ID。
- **未发布**：本准备单不创建 tag、GitHub Release 或 npm 版本，不修改 dist-tags，不合并
  `main`，不把 PR 转为 Ready，不 repack，不代签 Owner 签名。任何发布事务都需要 Owner
  单独的精确授权，并以干净 checkout 的 exact SHA 为前提。

## 已知限制

- 上游 `0.2.2-rc.4` / `rc.5` 的 source-to-artifact 证据为 `EVIDENCE_LIMITED`，不是
  完整 attestation / `FULL_PASS`；qualified Owner exceptions 原样保留。
- `rc.5` 的 Windows 尾换行 flake 仍记 `INCONCLUSIVE`，不写成已修复。
- 真机 Windows 11、IME、所有桌面终端组合、Windows-side H11 等未在本候选全部重测，
  标为 `NOT_MEASURED`；ConPTY capability row 或 boot-only 检查不等于 IME PASS。
- 超长会话冷恢复、极慢分片粘贴 Esc 歧义等既有性能/输入限制不因本候选改变。
- 本文档不包含自己发布后的哈希、run ID 或 dist-tag 状态；这些只能由 #81 回执和发布后
  read-back 提供。
