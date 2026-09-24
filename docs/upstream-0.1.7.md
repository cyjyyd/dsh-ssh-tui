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
   换四个根钉版，并用 `overrides` 把整棵依赖树钉在该线——见下）；声明同步放宽（14 个 dsh peer ＋
   `dsh.compatibility.dsh`），`dshReleases` 加 `0.1.7-rc.1: compatible`，快照进 `docs/release.md`。
   **复数 presets 的 peer 保持旧窗口**（新线不存在该包，它是 optional；继任的两个包各自带 `>=0.1.7-rc.1 <0.1.8`）。
   注意：不给 exemption 时 0.1.7 的 launcher 会直接跳过我们的 bundle，所以这次放宽是升级路径的硬前提。
   **安装策略修正（2026-09-24）**：这条腿原来用 `--legacy-peer-deps` 绕开"家族里 `^0.1.5-rc.3` 这类预发布
   caret 会走 `latest` 标签"的问题，但那个标志连 peer 一起跳过，装出来的树**缺 37 个 peer-only 包**，
   base 里 25 行（`llm-deepseek`、`tool-fs`、`subagent` …）导入失败且被 loader 静默吞掉 → 这条腿上
   根本没有可用的模型适配器（`no adapter registered for provider "deepseek-official"`）。现在改成
   **`overrides` 把每个直接 `@deepseek-ai/dsh*` 依赖钉在 0.1.7-rc.1（peer-only 的复数 presets 除外，
   覆盖根 peer 会 EOVERRIDE）＋ 普通 `npm install`**：树完整、peer 保留，busy-drop 探针因此能在该腿跑。
   本地实测：`tsc` 0 错、套件 916/913/0/3、`probe-home`、`tui-term-probe`、`tui-mock-probe --busy` 全 PASS；
   CI 四条腿全绿（run **35962992401**），其中 0.1.7 腿的 `Busy-drop probe` 步骤为 OK。
2. ~~`tui-mock-probe`~~ **已完成**：真机 PASS（真跑一轮 ＋ 拖选复制 ＋ `/find` 高亮）。
3. ~~真实迁移演练~~ **已完成**：PTY 下四段全部导入并被 `describe()` 认到，`!!js` 启动表达式保留；
   headless 下 `ssh-tui` 不导入是插件自己的 TTY 守卫（fiber 非 ACTIVE）导致，不是导入缺陷。
4. ~~**真机新发现的 P1-4 缺陷**~~ **已修复**：`sessionSockPath` 过去不校验 AF_UNIX 地址总长 → 深 `DSH_HOME` 下
   `listen()` EINVAL，用户只看到 "host display socket did not appear"。现在按 `sun_path` 字节预算截断标签、
   深到不可用时抛出点明原因的错误，复现配置（39 字符 home）的 mock 探针已 PASS。细节与测试见 `docs/platform.md`。
5. ~~**取消 0.1.2-rc**（用户决定）~~ **已完成**——见下一节。

## 取消 0.1.2-rc 适配（用户决定 2026-09-23；2026-09-24 完成）

理由：兼容层包袱。0.1.2-rc.1 是最老的一条腿，靠它保住的用户与维护成本不成比例。

- [x] `package.json`：`dsh.compatibility.dsh` 与 14 条 peer 去掉 `>=0.1.2-rc.1 <0.1.6` comparator（共 15 处）；
      `dshReleases` 的 `0.1.2-rc.1` **保留条目并改判 `incompatible`**（比删条目更有用：还在该线的用户
      在 STORE 里看到的是明确拒绝，而不是"没有表态"）；`tests/bundle-patch.test.mjs` 改成断言
      "`0.1.2-rc.1` 不在范围内且为 `incompatible`"，并要求 `maxSatisfying` 在两条存活线里挑最新。
- [x] `.github/workflows/ci.yml`：删 `0.1.2-rc.1` 腿（五条 → 四条：`test (0.1.5-rc.3)` /
      `test (0.1.5-rc.1)` / `test (0.1.7-rc.1)` / `test-windows`），相关 `if:` 条件与注释同步；
      `docs/release.md` 的腿列表、快照表与 `README{,.en}.md` 的环境要求同步。
- [x] 源码/测试：删掉只服务 0.1.2 及更早 API 代的代码——`dsh-compat.ts` 的自由函数
      `installSettingsSection` 兜底、`session.events` 兜底、裸 header `list()`、`inspect()` 分支、
      `images` 标志、`assistant/chunk` 持久化应用链（含 `isAssistantStreamEvent` / `sessionEventType`）、
      `discoverModels` 请求体内 `signal` 双写、`registerProvider` 分支；注释统一改写成
      "0.1.5-rc / 0.1.7-rc 两条存活线"的说法。`tests/` 里约 20 个 `inspect` ＋裸 header 的 fake
      迁移成 snapshot `list()` + `open()`/`read()`，durable-chunk 用例迁移到 packed settlement stream。
- [x] **保留**（有运行时证据证明两条存活线仍然活着，不是 0.1.2 遗留）：`persistenceLocate`
      （0.1.5/0.1.7 的 JSONL 后端仍实现 `locate(meta)`，只是 `.d.ts` 把它标成 private）、
      `PresetAuthoringApi` 的全可选成员与调用点探测（0.1.7 registry 确实没有
      `copy` / `remove` / `read` / `authorable`）。
- [x] 验证：两棵树各 909 项、0 失败（0.1.5-rc.3 → 906 通过 / 3 skip；0.1.7-rc.1 → 905 通过 / 4 skip），
      `tsc --noEmit` 两条线 0 错；CI 四条腿全绿（run **35947920556**：`test (0.1.5-rc.3)` /
      `test (0.1.5-rc.1)` / `test (0.1.7-rc.1)` / `test-windows`）。
- [x] 老线仍保：`0.1.5-rc.1` / `0.1.5-rc.3`（`latest`）/ `0.1.7-rc.1`（`next`）。

**已知取舍（记录在案）**：0.1.2 时代的旧会话日志把 token 计时写成独立的 `assistant/chunk` 事件；
那部分**回放统计**（resume 后为旧会话重建 TTFT / tok/s）随该线一起删掉了。文本本身仍由
`assistant/message` 的 `content` 回放，所以旧会话照常显示，只是底栏不再为它们重建速率数字。
