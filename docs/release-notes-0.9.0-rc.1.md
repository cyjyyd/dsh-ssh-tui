# 0.9.0-rc.1 — Freeze Candidate（未发布）

> **UNRELEASED CANDIDATE — NOT A RELEASE.** 本文档随 `0.9.0-rc.1` 候选源码树一起准备，
> 但该候选**尚未**创建 Git tag、GitHub Release 或 npm 版本，也**没有**改动 `latest` /
> `next`。它的技术状态最多是 `CANDIDATE_PREP_COMPLETE`；只有独立 exact-SHA + artifact
> 评审给出 `TECH_PASS`、且 #81 的全部 MUST gate 满足后，才可能标为 `RC_CUT_READY`。
> 真正的发布还需要 Owner 单独签署 `RC_RELEASE_GO`，并绑定精确 SHA、tarball 哈希与
> GitHub/npm 发布事务。
>
> 源码基线：PR #91 OPEN/Draft head `bdb36cd5889a7c1d65f0b6bf7a1bbd75d34208a3`
> （tree `54d030dfae606645305126698034cfb244bedcd4`）；本候选只在其上增加版本身份、
> 文档、发版材料与必要的候选测试，不改产品运行时行为。精确候选 SHA、CI run、tarball
> 哈希记录在 #81 的 canonical 完成回执中；包内文档不能自引用发布后的哈希。

本候选来自 `0.9.0` 主线开发栈（9 Host 候选），**不是**已发布 Stable `0.8.6` 的重新打包，
也不是 `release/0.8.4` 维护线。

## 为什么是 0.9.0-rc.1

相对已发布 Stable `0.8.6`，0.9 主线汇入了三项面向会话现场的能力，并把兼容矩阵从七个
冻结 Host 扩展到九个精确 Host 版本。这个 RC 的目标是冻结候选身份与证据，不是新增功能：

- **W6B `/terminal`**：Terminal Doctor 的**快照屏**，报告当前 attach 已知的终端能力与
  证据年龄；不包含 W6C 的主动重新探测协议。
- **TITLE.G1 `/rename`**：只重命名**当前会话**的标题，写回 Host title 服务并刷新本地
  元数据；不包含归档、历史会话搜索或批量重命名。
- **cache-only `/context`**：Overview + Composition 两层视图，20/40/80 列分级与 18 cell
  有界回退；只读取一次 header-keyed `sessionProjectionCache` 的 `cachedSnapshot`，不读取
  event log、projection registry 或历史正文。STALE / UNKNOWN / `routeUnverified` 均如实
  展示，provider  provenance 使用 `modelSelection.lastUsed`（不是 `next`）。

没有新的用户功能超出上述已评审范围；本 RC 不重开 Reader、Search V09、Picker/F2、
archive/restore/delete/reset 或 AgentTeam deep。

## 兼容范围：九个精确 Host

Node.js 要求 `>=24.9.0`。声明窗口是精确并集，不是无界 semver：

```text
0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.5 || 0.2.2-rc.1 || 0.2.2-rc.2 || 0.2.2-rc.3 || 0.2.2-rc.4 || 0.2.2-rc.5
```

| Host pin | rc.1 候选状态 | 证据性质 |
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
conhost。CI 在 GitHub Windows runner 的 ConPTY 上覆盖六条 Host 线（`0.2.1-rc.5`、
`0.2.2-rc.1` / `rc.2` / `rc.3` / `rc.4` / `rc.5`）；该 runner 是测试基础设施，不构成对
Windows Server 的支持。真机 Windows 11、特定终端/IME 组合、以及“所有桌面 Windows 组合”
仍为 `NOT_MEASURED` 或未覆盖，本候选不作通过声明。

> **⚠️ Windows Server 系列（含 Server 2025）不在 0.9.0-rc.1 支持范围。历史 Windows Server 2025 question-wait 双换行 CI RED 仍保留，根因未明；不保证 Server 兼容性。**
>
> **Windows Server family (including Server 2025) is outside the supported scope of 0.9.0-rc.1. The historical Windows Server 2025 question-wait double-newline CI RED remains, with root cause unknown; Server compatibility is not guaranteed.**
>
> 原始 RED：[Actions 44881356855 / job 136777141174](https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/44881356855/job/136777141174)。
> 独立 bounded D5 审计：[PR #89 comment 7090676703](https://github.com/cyjyyd/dsh-ssh-tui/pull/89#issuecomment-7090676703)。
> 这条历史 RED 是 out-of-support 的 **NON_BLOCKING** 记录，不因 rc.1 被改写为 GREEN 或
> “已修复”。Server 兼容性只可能在 rc.2 之后按新反馈/新测试另行调查，不是 rc.1 的发布
> 承诺，也不是 rc.1 的阻塞项。

## 明确排除（不在本候选范围）

- **Historical Context Reader**：PR #49 / #50 / #73 的只读历史 Reader；不会读取冷同步
  历史或历史正文。
- **`/search` V09**：不包含 V09 搜索能力。
- **Picker / F2**：不包含 Picker 重构或 F2 行为变更。
- **Archive / Restore / Delete / Reset**：不包含会话归档、恢复、删除、重置。
- **AgentTeam deep**：不包含 AgentTeam 深层集成。

这些排除项是候选边界，不是“以后自动包含”的承诺。

## 验证与证据状态

- **RED → GREEN**：先在 S1-E 源树上运行新的 release-identity / README / disclosure
  断言，得到 6/6 RED（package 仍为 `0.8.5`、README 仍写 `COMPAT_ADMISSION_PENDING`、
  缺少 OS 披露与发版材料）；完成最小身份/文档修正后同一套断言 GREEN。
- **本地**：`npm run typecheck`、full `npm test`、`npm run freeze`、`npm run freeze:input`、
  `npm run bench`；built/packed PTY/stdio、synthetic SSH detach/re-attach、Context
  resize End/PageDown 回归与 cached snapshot 单次读取检查。具体结果与 SKIP 记录在 #81
  回执；没有执行真实付费 Provider 调用。
- **新 SHA CI**：目标为 Linux 9 Host + Windows ConPTY 6 + rc.4/rc.5 synthetic
  characterization（16 jobs），只使用 synthetic fixture / fake key / loopback。旧 S1-E
  run 45175221540 **不**作为本候选的冻结证据。精确 run/job URL 记录在 #81 回执。
- **两包一致**：同一 RC 源树在干净隔离路径中独立执行两次 `npm pack`，比较 SHA256、
  字节、shasum/integrity/`gitHead`/manifest/pack list，并做 clean-clone reinstall/pack
  复核。若不一致则 `HOLD`，不伪造 PASS。
- **升级/回滚**：synthetic `0.8.6` Stable → `0.9.0-rc.1`（以及范围内回滚），覆盖
  persistence、rename、Context、TUI、SSH（fake credentials）；不写真实 registry，不改
  `latest` / `next`。
- **安全**：测试只使用 fake key、loopback/mock HTTP 与 `fetch` tripwire；tarball 检查
  确认不含生产 Home、私有数据或 credential endpoint。未发现默认 Search credential
  泄漏时，仍保留默认 provider/API/credential outlet 的既有警告。

## 已知限制

- 上游 `0.2.2-rc.4` / `rc.5` 的 source-to-artifact 证据为 `EVIDENCE_LIMITED`，不是
  完整 attestation / `FULL_PASS`；qualified Owner exceptions 原样保留。
- `rc.5` 的 Windows 尾换行 flake 仍记 `INCONCLUSIVE`，不写成已修复。
- 真机 Windows 11、IME、所有桌面终端组合、Windows-side H11 等未在本候选全部重测，
  标为 `NOT_MEASURED`；ConPTY capability row 或 boot-only 检查不等于 IME PASS。
- 超长会话冷恢复、极慢分片粘贴 Esc 歧义等既有性能/输入限制不因本 RC 改变。
- 本文档不包含自己发布后的哈希、run ID 或 dist-tag 状态；这些只能由 #81 回执和发布后
  read-back 提供。

## 发布边界

本候选**不**创建 tag、GitHub Release、npm publish，不修改 dist-tags，不合并 `main`，
不把 PR 转为 Ready，不代签 Owner 签名。合并 `main` 仍需 Owner `MAIN_INTEGRATION_GO`
绑定已评审 commit/PR 图；发布仍需独立的 `RC_RELEASE_GO` 绑定精确未来 SHA、tarball
哈希与发布事务。`RC_CUT_READY` 表示候选已备好，不等于 `RC_RELEASE_GO`，也不启动 T0 /
24h 时钟。
