# 上游 0.1.7 适配计划（含放弃 0.1.2-rc 的决定）

> 本文件是**工作清单**，做完一项划掉一项；完成 0.1.7-rc 适配后按最后一节删掉 0.1.2-rc 的兼容。

## 已核验的事实（2026-09-23）

| 项 | 事实 |
|---|---|
| `next` | **0.1.7-rc.1**（2026-09-23T13:44Z 发布） |
| `latest` | 0.1.5-rc.3（08-22 之后从 rc.2 移过来） |
| `alpha` | 0.1.7-alpha.2 |
| 族完整性 | **`dsh-agent-presets`（复数）没有 0.1.7 版本**（停在 0.1.6-alpha.2）；0.1.7 把它拆成 `dsh-agent-preset`（组合行）＋ `dsh-agent-preset-registry`（`agentPresets` 服务） |
| 族自己的钉版 | cordis `4.0.4`、cordis-plugin-loader `1.0.5`、include `1.0.9`、hmr `1.0.19`、timer `1.1.6`、schemastery `3.18.4`（我们根上仍是 rc.3 那一套 4.0.2/1.0.3/1.0.7/1.0.17/1.1.4/3.18.2） |
| 声明范围 | 仍是 `... <0.1.6`：0.1.7-rc.1 **被明确拒绝**（比静默放行安全）；**在适配完成前不要放宽** |
| Windows 安装 | 把 31 个 devDep 整体改写成 0.1.7-rc.1 会 ERESOLVE：复数 presets 不存在 + 我们根上的 cordis 钉版过旧 |

## 已完成（`2df79ac`）

- `src/preset-compat.ts`：两行共用的结构类型（`id/name/description/order/broken` ＋ 可选的 `path`/`trust`），
  并把 `preset.yml` 读取/渲染（原包里的 ~25 行）**内联**进来——那个包在新线上不存在。
- `/preset` 在没有目录的宿主上以新拒绝码 `managed` 拒绝（不再谎称 "system preset"）；`/mode` 把无 `trust`
  的预设归入自带组（否则新线上 `/mode` 会**空**）；`recompose` 做成特性探测。
- 三个 preset peer 变可选，且只有新线存在的两个带 `>=0.1.7-rc.1 <0.1.8`；守卫测试学会"两行规则"。
- 老线复验：901 项 / 898 通过 / 0 失败，`tsc` 干净。

## 剩余适配（按依赖顺序）

1. **设置读取 API**：`dsh-settings` 去掉了 `SettingsForms.get(ns)` 与 `SettingsSectionHooks` 导出；
   新类是 `configure / prepareDocument / describe / update / replace / mutate`。
   我们约 15 处 `ctx.get('settings')?.get(ns)` 要改成"新 API ＋ 老 API 特性探测"的单一 helper
   （读路径仍在 `describe()`/document 一侧，待确认后落地）。**这是最大的一块，先做它。**
2. **`AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE`** 在 `dsh-agent-default-model` 里没了：找到新名字
   （或就地内联常量），保持两行可用。
3. **`ContentBlock.isError`** 收窄了（不再在 `ContentBlock`/`FileBlock` 上，只在特定块上）：
   用类型守卫取，3 处（`src/tui.ts:5483/5511/6221`）。
4. **用户消息来源 `kind: 'plugin'`** 不在新联合里（3 处：`src/tui.ts:3115/6553/6645`）：换成新线接受的
   kind（队列通知的语义不变）。
5. **隐式 any**：`src/i18n/index.ts:98`、`src/subagent-model.ts:328`（签名变了，补参数类型）。
6. **roster 行名**：`src/preset-rows.ts` 的 `@deepseek-ai/dsh-agent-presets` 在新线要写
   `@deepseek-ai/dsh-agent-preset-registry`；顺带确认另两行（`dsh-code-runtime-worker-thread`、
   `dsh-tool-subagent/model-selection-settings`）在 0.1.7 仍在。**按运行中的宿主版本选行，不要盲写。**
7. **CI 腿**：矩阵加 `0.1.7-rc.1`；pin 步骤要能把复数 presets 换成新的两个包，并按腿改写根上六个钉版
   （rc.3 一套 / 0.1.7 一套）。
8. **验完才放宽**：套件＋三个探针在 0.1.7 上跑绿之后，才把 `|| >=0.1.7-rc.1 <0.1.8` 加进范围、
   `dshReleases` 加 `0.1.7-rc.1: compatible`、`docs/release.md` 更新快照。

## 0.1.7 适配完成后：取消 0.1.2-rc 适配（用户决定，2026-09-23）

理由：兼容层包袱。0.1.2-rc.1 是最老的一条腿，靠它保住的用户与维护成本不成比例。清单：

- [ ] `package.json`：范围去掉 `>=0.1.2-rc.1 <0.1.6`；`dshReleases` 去掉 `0.1.2-rc.1` 条目
      （`tests/bundle-patch.test.mjs` 里那条"必须存在且为 compatible"的断言一并删）。
- [ ] `.github/workflows/ci.yml`：删 `0.1.2-rc.1` 腿；`docs/release.md` 的腿列表同步。
- [ ] 源码里为 0.1.2-rc.1 写的特性探测与注释：`src/preset-authoring.ts` 的
      "0.1.2-rc.1 may predate"/`PresetAuthoringApi` 全可选成员的措辞、`src/tui.ts` 里
      "works on both 0.1.1-rc.2 and 0.1.2-rc.1" 的模型发现双写、`src/dsh-compat.ts` 的老分支——
      逐个判断"新下线是 0.1.5-rc.1 还是 0.1.7-rc.1"，能删的删、该留的改注释。
- [ ] 老线仍要保：`0.1.5-rc.1` / `0.1.5-rc.3`（`latest`）/ `0.1.7-rc.1`（`next`）。
