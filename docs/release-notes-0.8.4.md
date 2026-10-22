# 0.8.4 — Input Ownership & Release Hardening (Stable)

> **稳定版：`0.8.4-rc.1` 的转正。** 本版不新增 runtime 功能，不改变协议、配置存储、
> 凭据格式或会话格式。升级即生效，不需要迁移动作。
>
> 这是 `0.8.4-rc.1` 的稳定版发版说明。候选版的历史、逐项证据和当时的实测记录保留在
> [`release-notes-0.8.4-rc.1.md`](release-notes-0.8.4-rc.1.md)，不因转正而改写。
>
> `dsh-ssh-tui` 现在以 **DSH Relay** 为产品名展示；npm 包名与安装命令没有变化。

## 稳定版关系

- `0.8.4-rc.1` 的 tag 指向 `0e1342a9f4a7cbb922971891e9b26a311a7c7026`。
- 稳定版从 `83a8c7e827c4458ace3fdb4aa6de42c01e4c7921` 切出；它比 RC 多且只多一个
  `docs/release.md` 发布回执提交。
- `release/0.8.4` 只把包版本从 `0.8.4-rc.1` 改为 `0.8.4`，补稳定版发版材料，并做一次
  仅扩展分支触发条件的 CI 例外；不包含 W-4 Completion 或 W-5 Search Screen 的产品代码。
- 同一份 `src/` 清理构建出的 `lib/` 与已发布的 `0.8.4-rc.1` registry tarball 逐字节一致。
- 正式发布后 `latest` 指向 `0.8.4`；只有在确认没有更新候选占用 `next` 时，才把 `next`
  同步到 `0.8.4`。

## 本版包含

### 输入归属

一次终端 read 里往往不止一个键。0.8.4 把输入路径拆成 Reader（分帧）→ Router（归属）→
Owner（执行），并修复了合并 read 丢键、Screen 边界、Surface 编辑键、借用字段光标、
非 BMP 输入崩溃、跨 Owner 状态写入和反馈行漂移。

### 粘贴与字段

- 首次安装向导和工作区都能接收括号粘贴，粘贴内容不会被当成命令或对话提交。
- 向导中的 API Key 全程掩码；粘贴、resize 和保存后的交接都有真实 PTY/ConPTY 证据。
- 粘贴结束标记跨 read 被切开时，Reader 会补齐；粘贴长时间不结束时不会永久占住键盘。
- 粘贴里的 Esc 形尾巴保持字面，不会误关当前层。

### 发布安全门

`0.8.4` 继续保留三道发布阻塞门：

1. Fresh-home setup wizard（真实 PTY / ConPTY，含粘贴 API Key）。
2. Paste probe（Composer / Screen / picker / 跨 read 标记）。
3. Packed-artifact smoke（`npm pack` → 清单 → 仓库外安装 → 在产物上重跑向导、工作区与粘贴）。

## 兼容性

声明窗口与 `0.8.4-rc.1` 相同：

```text
>=0.2.0-rc.1 <0.2.1 || >=0.2.1-rc.2 <0.2.2
```

- 新增于 0.8.4-rc.1 的 `0.2.1-rc.2` 仍是默认开发线。
- `0.2.0-rc.1` / `0.2.0-rc.2` 继续保留兼容表态与 CI 腿。
- `0.1.7` 线自 `0.8.4-rc.1` 起为 `incompatible`，由 launcher 的版本检查拒绝。
- `0.1.5` 及更早从 `0.8.0` 起不再支持。

## 验证记录

稳定候选在 `release/0.8.4` 上执行：

- `npm run build` / `npm run typecheck`：通过。
- `npm test`：**1509 项，1505 通过，0 失败，4 跳过**。
- `npm run freeze` / `npm run freeze:input`：通过。
- `npm run bench`：五个动作均为增量绘制，0 次整屏清屏。
- `npm run bench:report -- --check`：通过。
- `scripts/artifact-smoke.mjs`：在稳定候选 tarball 上通过（**251 files / 1,537,703 B**）。
- `scripts/upgrade-smoke.mjs --from 0.8.3 --pack`：通过（凭据、会话、bundle 入口均保留）。
- `scripts/upgrade-smoke.mjs --from 0.8.4-rc.1 --pack`：通过（凭据、会话、bundle 入口均保留）。
- `scripts/verify-batch.mjs --home <probe-home>`：**RESULT: PASS**，typecheck、完整套件、真实 PTY、
  terminal/link/unmeasured/paste/drop/mock/route/busy/line-mode/footer 全部 PASS，无 `SKIP:`。
- 清理构建的 `lib/` 与 `0.8.4-rc.1` registry tarball：**228 个文件逐字节一致**。

Windows Terminal、conhost、IME 中文输入、多行中文粘贴、鼠标复制与 SSH 恢复仍按
[`release.md`](release.md) 的人工验收清单执行；本轮未实际人工执行的项目保持
**PENDING**，不引用旧版本结果冒充本版验收。

## 已知限制

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

稳定版走 `latest`：

```bash
dsh plugin --profile tui add dsh-ssh-tui@latest
dsh --profile tui
```

已安装 `0.8.3` 或 `0.8.4-rc.1` 的用户可以直接升级；配置、凭据和会话记录不需要迁移。
