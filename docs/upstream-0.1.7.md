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

## 已完成

### `2df79ac` — preset 兼容层

- `src/preset-compat.ts`：两行共用的结构类型（`id/name/description/order/broken` ＋ 可选的 `path`/`trust`），
  并把 `preset.yml` 读取/渲染（原包里的 ~25 行）**内联**进来——那个包在新线上不存在。
- `/preset` 在没有目录的宿主上以新拒绝码 `managed` 拒绝（不再谎称 "system preset"）；`/mode` 把无 `trust`
  的预设归入自带组（否则新线上 `/mode` 会**空**）；`recompose` 做成特性探测。
- 三个 preset peer 变可选，且只有新线存在的两个带 `>=0.1.7-rc.1 <0.1.8`；守卫测试学会"两行规则"。

### `d466853` — 设置接缝（27 处编译错误 → 0）

- `readSettingsSection`：老线 `get(ns)`，新线用 `describe()` 的 descriptor（`value` = 活跃合并值，只投影
  volatile 字段）。descriptor 列表按 250ms 缓存，因为 `describe()` 会重投影每个 entry 的 schema。
- `settingsDocument`：新线没有 `settings.document`，用 descriptor 的 `user` 层重建。语义上必须分开：
  `readSettingsSection` 给的是合并值（含 base/默认），回答不了"用户配置过吗"。
- `liveField`：新线只有 volatile 字段可见可写；老线 schemastery 3.18.2 没有这个 builder，所以是运行时特性探测。
- `installSettingsSection`：老线两条路径原样保留；新线只把 `setSource`/`onChange` 接到 `readSettingsSection`
  与 `settings/document-updated`（在 service 自己的 ctx 上监听，事件不在我们的 fiber 上冒泡）。
- **命名空间不变**：`ssh-tui` 就是插件 entry id（我们 bundle patch 里正是这个名字），`ssh-tui-routes` /
  `ssh-tui-subagent` 变成 bundle patch 里两行只带 schema 的 entry。这正是宿主那一次性
  `settings.yaml → .imported` 迁移能落地的原因：没有同名 entry 的 section 会被丢弃。
- 其余：`plugin` 消息 kind 用模块增强声明回来；`isError` 从 block 或 message 读；默认模型命名空间内联；
  `schemastery` 的 **published** spec 改成 `3.18.2 || ~3.18.4`（两条线各自的版本，避免嵌套第二份——
  另一份 copy 造出的 schema 是另一个类）。

### `926329c` — roster 行按宿主线分叉

- 0.1.5：三行原样（复数 presets / code-runtime / subagent-model-selection-settings）。
- 0.1.7：**没有 roster 可挂**（preset 变成会话级、由 surface 组合；终端 profile 由 base 在进程级组合代理）。
  需要自挂的是 upstream `dsh-web-app/presets/standard.patch.yml` 里超出 base 的那三行：`persona`、
  `tool-ask-user`、`present`。已核验：standard preset 的 27 个插件里，其余全部已在 base 组合中。
- `/mode fix`、`/doctor --fix`、`scripts/profile-rows.mjs` 都按 `hostSettingsGeneration` 选行；脚本侧用
  `--dump-config` 里有无 `- id: config-editor` 判线。
- 提示语：0.1.7 上不再说"名单缺席 / `/mode fix` 能恢复切换"，而是"本宿主在进程级组合代理；缺的是
  persona / ask_user_question / present，`/mode fix` 写这三行"；footer chip 分两种措辞。

## 已核验（0.1.7-rc.1 真机）

| 项 | 证据 |
|---|---|
| 编译 | 同一份 `src/`：0.1.5-rc.3 → 0 错；0.1.7-rc.1 → 0 错（移植前 27 错） |
| 设置 API 运行时语义 | `/root/host-017/FINDINGS.md`：`get`/`document` 不存在；ns = loader entry id；只有 volatile 字段可读可写；schema 无 volatile 字段的 entry 根本不进 `describe()`；legacy 导入只跑一次 |
| 组合 | `/root/probe017`：授权 exact-version exemption 后，我们 4 行 + 三行 agent-plane 行都组合成功 |
| PTY 探针 | `tui-probe.mjs` 在 0.1.7 上 **OK**（boot / resize / diag / doctor / copy / preset / mouse / typing / exit） |
| 老线回归 | 套件 904 项 / 901 通过 / 0 失败（3 skip），`tsc` 干净 |

## 剩余

1. ~~**CI 腿 ＋ 放宽范围**~~ **已完成**：矩阵加 `0.1.7-rc.1`（该腿自行改写 devDeps、把复数 presets 换成新的两个包、
   换四个根钉版；安装用 `--legacy-peer-deps`，因为家族里仍有 `^0.1.5-rc.3` 这类预发布 caret 范围会走 `latest`
   标签把旧线拖进来）；声明同步放宽（14 个 dsh peer ＋ `dsh.compatibility.dsh`），`dshReleases` 加
   `0.1.7-rc.1: compatible`，快照进 `docs/release.md`。**复数 presets 的 peer 保持旧窗口**（新线不存在该包，
   它是 optional；继任的两个包各自带 `>=0.1.7-rc.1 <0.1.8`）。
   注意：不给 exemption 时 0.1.7 的 launcher 会直接跳过我们的 bundle，所以这次放宽是升级路径的硬前提。
2. ~~`tui-mock-probe`~~ **已完成**：真机 PASS（真跑一轮 ＋ 拖选复制 ＋ `/find` 高亮）。
3. ~~真实迁移演练~~ **已完成**：PTY 下四段全部导入并被 `describe()` 认到，`!!js` 启动表达式保留；
   headless 下 `ssh-tui` 不导入是插件自己的 TTY 守卫（fiber 非 ACTIVE）导致，不是导入缺陷。
4. **真机新发现的 P1-4 缺陷**：`src/display-sock.ts:178-186` 不校验 AF_UNIX 路径总长 → 深 `DSH_HOME` 下
   `listen()` EINVAL，用户只看到 "host display socket did not appear"。已记进 `docs/platform.md`。
5. **取消 0.1.2-rc**（用户决定）——见下一节。

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
