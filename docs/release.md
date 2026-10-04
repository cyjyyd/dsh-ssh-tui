# 发版流程（硬性规则）

> 本文件是**规则**，不是建议。任何自动化助手、脚本或维护者在发版前都必须先读它。

> **0.8.2-rc.1 已发布（2026-10-04，只上 `next`）**：候选树 `7c0f3b2` → tag `v0.8.2-rc.1` →
> CI 五条腿全 success（run [37180154532](https://github.com/cyjyyd/dsh-ssh-tui/actions/runs/37180154532)，
> `head_sha` = tag 所指 SHA；**推 tag 不触发新的一轮**，这是核对来的那条）→ GitHub Release
> <https://github.com/cyjyyd/dsh-ssh-tui/releases/tag/v0.8.2-rc.1>（prerelease）→
> `npm publish --tag next`：立即回 `+ dsh-ssh-tui@0.8.2-rc.1`，约 90 秒后 packument 出现该版本；
> **shasum `8ea5e24111d29718e6b6b71ef65963e9bb5a403e`**、integrity `sha512-7VT5BXeyZ…`、
> **243 个文件 / tarball 1.4 MB / 解包 4.2 MB**。发布后从 registry 重新下载 tarball，sha1 与上面**逐字节
> 相同**。dist-tags：`next` = `0.8.2-rc.1`，**`latest` 保持 `0.8.1`**（候选版不动 `latest`）。
> 发版说明：[`release-notes-0.8.2-rc.1.md`](release-notes-0.8.2-rc.1.md)。
> 本版头等事：**全新安装第一次就会出现配置向导**；此外 resume 不再黑屏、思考卡片不再发白、
> 链路芯片不再把绘制节奏当延迟。

> **上一候选版前的状态（2026-10-03，留档）**：发版候选 `c2fe073` 自检：全量套件（Linux）1376 项
> **1372 通过 / 0 失败 / 4 跳过**、（Windows 实机）1376 项 **1365 通过 / 0 失败 / 11 跳过**；
> `tsc --noEmit` 干净；`npm run freeze` 八条不变量全绿、七条退役路径 **0 命中**；`npm run bench`
> 五个动作 **0 次整屏清屏**。逐条证据见 [`checkpoints.md`](checkpoints.md) 末两节与
> [`decisions/b2-architecture-decisions.md`](decisions/b2-architecture-decisions.md) §20。
> **发布前的两件人工事都已闭合**：fresh-home 首启有探针（`tui-setup-probe.mjs` +
> `probe-onboarding.mjs`，见下「发布前人工门槛」第二节），Windows / ConPTY 实机人工验收已完成
> （2026-10-03，12 PASS · 2 SKIP · 0 FAIL，两目人眼项确认通过；`SKIP` 是覆盖边界、不算通过）。

> **0.8.1 已发布（2026-09-30，`latest` + `next`）**：版本提交 `5edb033` → 推 `main` → tag `v0.8.1` →
> CI 五条腿全 success（`test (0.2.0-rc.2)` / `0.2.0-rc.1` / `0.1.7-rc.2` / `0.1.7-rc.1` / `test-windows`）→
> GitHub Release <https://github.com/cyjyyd/dsh-ssh-tui/releases/tag/v0.8.1> → `npm publish --tag latest`
> （registry 回 **202 Accepted**，约 4 分钟后 packument 出现 0.8.1；shasum `1c03d62d…`、205 个文件）→
> `npm dist-tag add dsh-ssh-tui@0.8.1 next`。发版说明：[`release-notes-0.8.1.md`](release-notes-0.8.1.md)。
> 本版头等事：**没有终端时插件保持惰性**（0.8.0 会抛错，桌面版会把它读成"插件失败"并把 GUI 带崩）。
> 用户在本机 Windows 实机测过这一版后才要求发布。

> **0.8.0 已发布（2026-09-29，只上 `next`）**：tag `v0.8.0` → CI 全绿 → GitHub Release
> <https://github.com/cyjyyd/dsh-ssh-tui/releases/tag/v0.8.0> → npm `next` = `0.8.0`。
> **`latest` 仍是 0.7.4，按用户要求等 2026-10-01 再提升**（已完成，见下一节）。
> 发版说明：[`release-notes-0.8.0.md`](release-notes-0.8.0.md)；更早一版的草稿留在
> [`release-notes-0.7.4.md`](release-notes-0.7.4.md)。

## 已完成：0.8.0 提升为 `latest`（2026-09-29，提前于原定的 10-01）

原因：**桌面版 Harness 发布**，其基线是 0.2.0-rc 线，而 0.7.4 的声明窗口不含 0.2.x —— 桌面版用户装不上它。

```sh
npm dist-tag add dsh-ssh-tui@0.8.0 latest    # 实测生效：latest=0.8.0、next=0.8.0
```

> **上游随后又发了 `0.2.0-rc.2`，并把 `latest` 与 `next` 都指向它。** 该版本已按完整流程验过并进声明表与
> CI（现在是**默认腿**：提交的 manifest 与锁、`test-windows` 都装它）；`0.2.0-rc.1` 仍保留兼容表态与腿。
> 当前窗口 `>=0.1.7-rc.1 <0.1.8 || >=0.2.0-rc.1 <0.2.1` 已覆盖这两个 rc，**不含 0.1.5**。上游再发
> `0.2.0` 正式版时按同样流程跑一遍再决定是否加 comparator。

## 三条规则

1. **只有用户明确要求发版时才发版。**
   用户的指令里**没有**"发版 / 发布 / release / 发 npm / 打 tag"这类字样时，
   **不得**执行任何发版动作：不改版本号、不打 tag、不推 Release、不动 npm。
   修完 bug、跑完验收、推送到 GitHub 分支——到此为止，然后等指令。

2. **顺序固定：先 GitHub，后 npm。**
   发版请求先落到 GitHub：版本号提交 → 推送 `main` → 打 `vX.Y.Z` tag → 推 tag → GitHub Release。
   **候选版（`-rc.N`）只上 `next`**：`npm publish --tag next`（`latest` 留给正式版；把 rc 提成
   `latest` 会让所有默认安装的用户拿到候选）。正式版才 `npm publish --tag latest`，并按需
   `npm dist-tag add dsh-ssh-tui@X.Y.Z next`。

3. **CI 全部腿全绿，才允许碰 npm。**
   当前五条腿（2026-10-03 起）：`test (0.2.0-rc.2)`、`test (0.2.0-rc.1)`、`test (0.1.7-rc.2)`、
   `test (0.1.7-rc.1)`、`test-windows` —— **全部 success** 才 `npm publish`。
   CI 红着就把包发出去，等于把一个未验证的版本交给所有 `@next` / `@latest` 用户。
   **tag 不触发 CI**：workflow 只监听 `main` 的 push 与 PR（`.github/workflows/ci.yml` 的 `on:`），
   所以打 tag 前后要做的是**核对 tag 所指的那个 SHA 的 run 是否 success**（`main` 上的推送已经跑过
   一次同一个 SHA），而不是指望推 tag 自己长出一轮。查法：
   `curl -s "https://api.github.com/repos/cyjyyd/dsh-ssh-tui/actions/runs?head_sha=$(git rev-parse vX.Y.Z)"`。

## 允许 / 不允许

| 动作 | 未要求发版时 | 已要求发版时 |
|---|---|---|
| 改 `package.json` 版本号 | ✗ | ✓ |
| 推 `main`（提交修复/文档） | ✓ | ✓ |
| 打 `vX.Y.Z` tag | ✗ | ✓（CI 绿之前只是 tag，不发 npm） |
| 建 GitHub Release | ✗ | ✓ |
| `npm publish` / 改 dist-tag | ✗ | 仅 CI 全绿后 |

## 事故记录：0.7.0-rc.2 的 npm 误发（2026-09-16）

B-1 回归修复完成后，助手在用户给出"先不急着发 npm"的指示**之前**已经执行了
`npm publish --tag next`（0.7.0-rc.2），并把 tag 推到了 GitHub。用户随后明确要求：
**先只提交 GitHub，C 批尚未验收，不要动 npm。**

处置：
- `npm dist-tag add dsh-ssh-tui@0.7.0-rc.1 next` —— `next` 已回退到 rc.1，
  用户不会通过任何 tag 拿到 rc.2（注册表实测 `{ latest: '0.6.4', next: '0.7.0-rc.1' }`）；
- `0.7.0-rc.2` 的 tarball 仍存在于 npm（无 tag 指向），是否 `npm unpublish` 由用户决定
  （注意：unpublish 后该版本号 24 小时内不可重用）；
- GitHub 侧保留提交与 tag（用户明确允许"只提交 github"）。

教训：把"发版"当成**需要显式授权的动作**，而不是"交付完成的自然收尾"。

## 上游发新版本了怎么办（兼容矩阵）

宿主的发行节奏比本插件快：0.1.5 的 rc 线一周内走过 rc.1 → rc.2 → rc.3，同时 0.1.6、0.1.7 的
alpha 也在发。**声明兼容是一个承诺，不是一个猜测**，所以规则是：

- 唯一的真相在 `package.json` → `dsh.compatibility`：`dsh` 是 semver 范围，`dshReleases` 是逐版本的
  明确表态（`compatible` / `incompatible` / `unknown`）。`tests/bundle-patch.test.mjs` 会校验两者一致：
  标了 `compatible` 的版本必须落在范围里，范围内的每个 `@deepseek-ai/dsh-*` peer 必须与它同值。
- **跑过了才准标 `compatible`**：`npm install`（切到该版本）→ `npx tsc --noEmit` → `node --test` →
  `probe-home --probe`、`probe-home --probe --script tui-drop-probe.mjs`、`tui-mock-probe --busy`。
  只做了类型层面的判断、或者只看了上游 changelog 的，写 `unknown`。
- **根部的 `@deepseek-ai` 规格必须跟着族的钉版走。** rc.3 把 cordis、四个 cordis 插件、schemastery
  从 caret 改成了精确钉版，而这些我们也在根部声明（或被 cordis 作为 optional peer 拉进来）。根上写
  `^4.0.1` 会解析到比钉版更高的版本，npm 就再也满足不了族里的精确 peer，安装直接 ERESOLVE——
  **2026-09-22 15:36–15:37 上游同时发了 cordis 4.0.3/4.0.4、loader 1.0.4/1.0.5、schemastery 3.18.3/
  3.18.4，几分钟后四条 CI 腿全部倒在 `npm install` 上**（在那之前 25 分钟还是绿的）。第一轮修完
  cordis/loader/schemastery 之后，当时最老的 0.1.2-rc.1 腿又因为 **cordis-plugin-include 被 npm 拿到 1.0.9**
  而挂——1.0.9 的 peer 是 `cordis ~4.0.4`，与钉住的 4.0.2 天然冲突（rc.3 族里它是被精确钉成 1.0.7 的，
  老族里没人钉）。那条腿已随 0.1.2 支持一起摘除，教训留在根部的钉版上：默认线（2026-09-26 起是
  `0.1.7-rc.1`，2026-10-03 起是 **`0.2.0-rc.2`**）写死 `cordis 4.0.4`、
  `cordis-plugin-{include 1.0.9, loader 1.0.5, hmr 1.0.17, timer 1.1.6}`、
  `cordis-plugin-group 1.0.4`（launcher 组装用，不是我们 import 的）、`schemastery 3.18.2 || ~3.18.4`。
  （0.1.5 的两条腿曾由 `scripts/ci-pin-line.mjs` 改写成那一族的 `4.0.2` / `1.0.7` / `1.0.3` / `1.1.4`；
  该线已摘除，改写表里不再有它们的条目。）
  `peerDependencies` 里保持区间（消费者那边由宿主提供）。`tests/bundle-patch.test.mjs` 钉住树上实际装到
  的那条线，`tests/ci-pin-line.test.mjs` 钉住改写表；要动它们就跟族一起动。
- **范围不要提前放宽。** 只有在真跑绿之后才把新版本纳入范围与 CI 腿；没跑过的版本宁可让
  `dsh` 拒绝加载（明确的"还不支持"），也不要静默地放进来。未验证就声明兼容，等于把
  "反正没测过"翻译成"用户装得上但没人知道会怎样"。
- **prerelease 的 semver 规则要记住**：`0.1.6-alpha.2` 字面上小于 `0.1.6`，但它**不**满足
  我们的范围——node-semver 只在某个 comparator 带有**同一** `[major, minor, patch]` 的 prerelease 时
  才放行 prerelease。所以 `>=0.1.5-alpha.1 <0.1.6` 既排除 `0.1.6-alpha.x`，也排除 `0.1.7-alpha.x`；
  这条已被 `tests/bundle-patch.test.mjs` 钉住，别靠感觉改。
- **CI 腿的取舍**：`matrix.dsh` 里每个"能启动宿主"的版本都跑全套单元测试 + 真 PTY 探针。当前四条
  （`0.2.0-rc.2` / `0.2.0-rc.1` / `0.1.7-rc.2` / `0.1.7-rc.1`）+ `test-windows`：默认腿跟着
  `package.json` 的 pin 走（= 当前要重点验的那一版，现在是 **`0.2.0-rc.2`**；这条腿原样安装提交的
  manifest，`test-windows` 也是），其余线由 `scripts/ci-pin-line.mjs` 改写 manifest 后从零安装
  （顺带删锁），改写的正确性由 `tests/ci-pin-line.test.mjs` + `tests/workflow.test.mjs` 的守卫断言守住。
  **0.1.5 的两条腿已随该线摘除**（`--legacy-peer-deps` 安装步骤、复数 `dsh-agent-presets` 的 peer 一并
  删除）：`matrix.dsh` 里不再有 `0.1.5-*`，`dshReleases` 里它们仍留 `incompatible` 表态。
- **摘除一条旧线要成套做**（0.1.2-rc 的先例）：范围里的 comparator、`dshReleases` 表态、CI 腿、
  固定装置（`tests/` 里的合成 facts）、只服务该线的源码分支、文档里的腿列表，一次改完。
  被摘版本在 `dshReleases` 里留 **`incompatible`** 而不是删条目：还在那条线的用户看到的是
  "不兼容，请升级"这种明确结论，比"没有表态"更有用；范围里则不能留任何能匹配它的 comparator。

### 当前快照（2026-10-03 · `0.8.1` = `latest` + `next`）

| 通道 | 版本 | 我们的表态 |
|---|---|---|
| `latest` | **`0.2.0-rc.2`** | `compatible`：**默认线**（提交的 manifest、锁与 `test-windows` 腿都装它），跑完整探针 |
| `next` | **`0.2.0-rc.2`** | 同上（上游把 `latest` 与 `next` 都指向它） |
| `0.2.0` 线 | `0.2.0-rc.1` | `compatible`：见 [upstream-0.2.0.md](upstream-0.2.0.md)（干净树安装、`tsc` 0 错、真 PTY 探针全过）；CI 里由 `ci-pin-line.mjs` 改写 manifest 后从零安装 |
| `0.1.7` 线 | `0.1.7-rc.1` / **`0.1.7-rc.2`** | `compatible`：两条都在 CI 里（rc.2 完整探针，rc.1 typecheck + 套件；同一代际） |
| 旧线 | `0.1.5-alpha.1` … `0.1.5-rc.3` | **`incompatible`**：0.8.0 随用户决定摘除（范围不再有 comparator、CI 两条腿与 legacy-peers 安装步骤删除、复数 `dsh-agent-presets` 的 peer 删除；`dshReleases` 保留明确表态） |
| 已摘 | `0.1.2-rc.1`、`0.1.3-alpha.1`/`alpha.2` | `incompatible`：**支持已取消**（范围不再有 comparator，`dshReleases` 保留明确表态，让还在该线的用户看到"不兼容，请升级"而不是沉默） |
| `alpha` | `0.1.7-alpha.2` | 范围外，不声明 |
| — | `0.1.6-alpha.1`/`alpha.2` | 范围外，不声明（**0.1.6 从未有 rc**；复数 `dsh-agent-presets` 正是停在 0.1.6-alpha.2） |

当前声明窗口：`>=0.1.7-rc.1 <0.1.8 || >=0.2.0-rc.1 <0.2.1`（**不含 0.1.5 与更早**）。上游再发 `0.2.0`
正式版时，按同样流程跑一遍（干净树安装 → `tsc` → 全套 → 探针）再决定是否加 comparator。

> **2026-09-28**：上游 `next` 的 **`0.1.7-rc.2`** 已按完整流程验过并声明 `compatible`：干净树安装（族全部 rc.2）、
> `tsc --noEmit` 0 错、套件 988 项 985 通过 / 0 失败 / 3 skip、六个真 PTY 探针（boot / drop / cut / rtt / busy-drop）全过。
> 它不是重钉版：272 个族包里 59 个类型面有变化，其中 14 个落在本插件自己的接缝上（dsh-agent-loop、dsh-llm、
> dsh-session、dsh-subagent、dsh-user-approval、dsh-tools、dsh-agent-default-model、dsh-agent-preset-registry、
> dsh-atomic-write、dsh-sandbox 等，均为新增：新错误码 `ACCOUNT_QUOTA_EXCEEDED_CODE`、`projectToolUpdates`、原生工具声明等）。
> 因此 CI 里 **另开一条 rc.2 腿**（当时默认腿仍是 rc.1；**自 `0.2.0-rc.2` 起它成了默认腿**——提交的
> manifest、锁与 `test-windows` 都装它）；rc.2 那一线唯一装不上的东西是
> `@deepseek-ai/dsh-llm-mock-server`（该线没发这个包），由 `scripts/ci-pin-line.mjs` 把它钉在 rc.1（独立 HTTP mock，无族内 peer）。

**0.1.7 与旧线的三处结构性差异（适配期踩过的）：**

1. **设置接缝**：`settings.get` / `installSection` / `SettingsSectionHooks` / `settings.document` 全部删除。
   表单由 loader entry 自己的 `Config` schema 投影，**只有 `.volatile()` 字段可读可写**，
   命名空间 = profile 里的 entry id。插件因此把自己的三段落成三条 entry（`ssh-tui` 就是插件本体的 row）。
2. **presets 改名**：复数包没有 0.1.7 版本，拆成 `dsh-agent-preset`（组合行）＋ `dsh-agent-preset-registry`（服务）。
   `devDeps` 里要**替换**而不是改版本号（否则 ETARGET）。
3. **终端不再有 roster**：preset 变成会话级、由 surface 组合；终端 profile 由 base 在进程级组合代理。
   `/mode fix` 在 0.1.7 上写的是 `persona` / `tool-ask-user` / `present` 三行，不再是名单那三行。

**还有一个 launcher 门槛**：声明范围没放宽之前，0.1.7 宿主会**直接跳过**我们的 bundle
（`Plugin dsh-ssh-tui@x is incompatible with dsh 0.1.7-rc.1 … grant the exact-version exemption`）。
验证期用 `dsh plugin --profile <p> allow-version dsh-ssh-tui@<v> --dsh-version 0.1.7-rc.1 --accept-risk` 绕过；
对用户来说，这意味着**升级路径依赖这次放宽**，不是可选项。

**结论：0.1.6 目前只有 alpha，没有 rc。** 但 alpha 已经把 0.1.6 会带什么说清楚了，所以"规划兼容"有实事可做：

- rc.3 是一次**纯元数据重钉**（31 个包逐一比对：改动的文件全是 `package.json`，`.d.ts` 与成员级 API
  零变化，没有任何 GitHub Release 或 tag）。唯一对消费者有意义的改动是 cordis / schemastery 从
  caret 变成精确钉版——我们的 devDep `@deepseek-ai/cordis: ^4.0.1` 仍然吃 4.0.2，不会因此多出一份副本。
- **0.1.6-alpha.2 里 `agent/created` 从广播变成串行，返回类型变成 `undefined | Promise<undefined>`。**
  这不是从 changelog 猜的：把本仓库的 `src/tui.ts` 直接对着已发布的 alpha.2 类型树编译，
  得到 `error TS2322: Type 'void' is not assignable to type 'Promise<undefined> | undefined'`。
  **修法已经落在代码里**（`mountTui` 里那个 handler 显式 `return undefined`）——注意"加一对花括号"
  并不够，`void` 依然不可赋值，必须真的返回 `undefined`（这一点是编译验证过的，不是推断）。
  将来 `0.1.6-rc.1` 出现时，这条已经不会再挡编译。
- **要盯的弃用**：alpha.2 给 `dsh-session` 的 `Session.eventAt()` / `snapshotEvents()` / `ownEvents()`
  加了 `@deprecated`（"new calls are prohibited"），而本插件的兼容层 `src/dsh-compat.ts` 正是靠前两个
  做事件回放的。今天不报错，alpha.2 的导出面里也看不到替代 API——等 rc 出来时如果还没有替代品，
  需要向上游问清楚迁移路径，别等到它们被删。

等 `0.1.6-rc.1` 出现时按上面那份清单走即可（切版本 → 跑全套与探针 → 绿了才放宽范围、加 CI 腿、
写 `dshReleases`；红了就修，修不动就记 `incompatible`，用户那边仍然是明确的拒绝而不是误装）。

## 发布前人工门槛（0.8.2 RC 起）

**CI 的 Windows 腿不是 ConPTY 人工通过。** `test-windows` 跑的是脚本化探针（boot、drop、busy-drop、
term、stdio）与单元套件：它能证明生命周期代码在 win32 上不炸，**不能**证明一个人用起来没问题。
下面两栏是自动化覆盖不到的，发布前必须有人做，并在发版说明里写清结论（做了 / 没做 / 部分）：

### 一、Windows / ConPTY 实机（至少 Windows Terminal + conhost）

逐条走，每条记「通过 / 不通过 / 未测」：

> **本轮（2026-10-03）已完成**，用的是单独安装的一份 CLI dsh（`npm i @deepseek-ai/dsh@0.2.0-rc.2` 到
> 独立前缀）。逐项结论、五处探针缺陷与两处 ConPTY 盲区记在 [`checkpoints.md`](checkpoints.md)
> 「Windows 实机轮」一节。汇总：可自动化的部分由 `verify-batch --home <dir>` 一次跑完
> （**12 PASS · 2 SKIP · 0 FAIL**）；**没有自动化、只能人眼的两目（IME 组合、多行中文粘贴）已确认
> 通过**；两处 `SKIP` 是覆盖边界（ConPTY 自己回 `CSI 6n`，慢链路与"静默但没断连"扮演不了——这两个形状
> 在 Linux 腿上真跑），**`SKIP` 不算通过**。下一轮仍按下面的清单走，并把结论追加到同一节。
>
> 剩下的勾选状态保持"未勾"，因为它们是**模板**：每一轮实机验收都从这份清单开始，勾选记在 checkpoints
> 的那一节里，而不是把模板永久勾上。

- [ ] **启动**：`dsh --profile tui` 在 Windows Terminal 里正常进入工作区，字形与颜色正确
- [ ] **IME 组合**：微软拼音输入中文时，**预输入串不得**出现在处理中卡片或计划卡上；
      组合上屏后文本完整、光标位置正确
- [ ] **粘贴**：多行粘贴进 composer（含中文与换行），不被截断、不触发意外提交
- [ ] **鼠标拖选 + 复制**：拖选一段回复 → 复制键 / `/copy` 拿到的是拖选内容；点击卡片可折叠/展开
- [ ] **resize**：拖动窗口改变大小时重画正确，光标行（composer）始终在屏
- [ ] **字形回退**：`conhost` 与 `dumb` 控制台下状态行不出现替换字符（`DSH_TUI_ASCII=1` 也对）
- [ ] **Screen 开/关**：`/status`、`/help` 打开报告屏，`PgUp/PgDn` 翻页不整屏闪，Esc 回工作区
- [ ] **picker**：`/model`、`/view` 菜单能用上下键选、Esc 取消，取消后 composer 还在
- [ ] **流式**：一轮对话流式输出期间画面持续更新、**不逐 tick 整屏重画**（弱链路上尤其明显）
- [ ] **setup**：`/setup` 能打开向导并走完（首启自动出现见第二栏）
- [ ] **SSH detach / reattach**：关闭窗口再重开（ConPTY teardown）→ Host 还活着，重接后正在跑的一轮没丢
- [ ] **ConPTY 断链恢复**：`tui-drop-probe.mjs` 对应的路径在实机上手工验一遍（本机 CI 只跑脚本版）。
      **"终端静默但没断连"这一半自动化覆盖不到**：ConPTY 代答 `CSI 6n`，`tui-cut-probe.mjs` 在本机
      会打印 `SKIP:`（它只验了"应答的终端读作 attached"）。要人眼确认的是：把网络掐掉（不要关窗口，
      让宿主以为窗口还在），再恢复时正在跑的一轮没丢、画面自己回来

背景与已知差异见 [`windows.md`](windows.md)、[`terminals.md`](terminals.md)。
- [ ] **IME 组合**：微软拼音输入中文时，**预输入串不得**出现在处理中卡片或计划卡上；
      组合上屏后文本完整、光标位置正确
- [ ] **粘贴**：多行粘贴进 composer（含中文与换行），不被截断、不触发意外提交
- [ ] **鼠标拖选 + 复制**：拖选一段回复 → 复制键 / `/copy` 拿到的是拖选内容；点击卡片可折叠/展开
- [ ] **resize**：拖动窗口改变大小时重画正确，光标行（composer）始终在屏
- [ ] **字形回退**：`conhost` 与 `dumb` 控制台下状态行不出现替换字符（`DSH_TUI_ASCII=1` 也对）
- [ ] **Screen 开/关**：`/status`、`/help` 打开报告屏，`PgUp/PgDn` 翻页不整屏闪，Esc 回工作区
- [ ] **picker**：`/model`、`/view` 菜单能用上下键选、Esc 取消，取消后 composer 还在
- [ ] **流式**：一轮对话流式输出期间画面持续更新、**不逐 tick 整屏重画**（弱链路上尤其明显）
- [ ] **setup**：`/setup` 能打开向导并走完（首启自动出现见第二栏）
- [ ] **SSH detach / reattach**：关闭窗口再重开（ConPTY teardown）→ Host 还活着，重接后正在跑的一轮没丢
- [ ] **ConPTY 断链恢复**：`tui-drop-probe.mjs` 对应的路径在实机上手工验一遍（本机 CI 只跑脚本版）。
      **"终端静默但没断连"这一半自动化覆盖不到**：ConPTY 代答 `CSI 6n`，`tui-cut-probe.mjs` 在本机
      会打印 `SKIP:`（它只验了"应答的终端读作 attached"）。要人眼确认的是：把网络掐掉（不要关窗口，
      让宿主以为窗口还在），再恢复时正在跑的一轮没丢、画面自己回来

背景与已知差异见 [`windows.md`](windows.md)、[`terminals.md`](terminals.md)。

### 二、fresh-home 首启（没有任何配置的 `DSH_HOME`）

```sh
node scripts/probe-home.mjs --keep --unconfigured    # 建一份**未配置**的 home
PROBE_HOME=<上面打印的路径> node scripts/tui-setup-probe.mjs
```

探针断言两件事：向导**自动**出现（不画工作区 composer）、列表步按键只重画正文、字段步打字只重画一行
且**不清屏**、resize 后字段与按键仍在、Esc 交还工作区；随后写入一份凭据再启动，断言**第二次启动不再
出现向导**。若向导没有出现，探针会打印 `SKIP: this home is already configured` —— **那不是通过，是没有覆盖**。

> **为什么这条必须人工确认**：它曾经是一条真实缺陷（0.8.1 及以前）。前端拉起的 Host 永远带
> `--resume=<id>`（连它自己刚铸的 id 也带），而首启判定把 `resume` 当成「这台机器配置过」，于是
> **全新安装永远不会出现向导**、也没有任何提示。修复见 `src/tui.ts` 的 `maybeRunOnboarding`。

### 三、B2 冻结自检（任何平台，一条命令）

```sh
npm run build && npm run freeze      # 八条不变量 + 七条退役路径，必须 exit 0
npm run bench                        # 五个动作的中位数 + 「无全清」断言
```

数字写进发版说明；`unclassified / unknown destination / live source rows / duplicate primary`
有一项不是 0，就不要发版。

### 四、一条命令跑完验收（`verify-batch`）

```sh
node scripts/verify-batch.mjs                    # typecheck + 全套 + 全部真 PTY 探针
node scripts/verify-batch.mjs --only link --batch RC   # 只跑某一项，迭代用
node scripts/verify-batch.mjs --home <dir>       # 把读 profile 的三步指向这个 DSH_HOME
```

它按顺序跑完 typecheck、全套测试与真 PTY 探针，每步一行结论，最后给一条 `RESULT:`。两种"不是通过"
的收尾必须分清：

- `RESULT: FAIL`（exit 1）：有步骤真的失败，会附带该步最后 25 行输出；
- `RESULT: INCOMPLETE`（exit 2）：有步骤打印了 `SKIP:`（例如机器上没有 node-pty），**这条不是通过、
  也不是失败，是"没测到"**。修好环境重跑，别把 INCOMPLETE 当成 PASS 引用。

**`--home <dir>` 的用途**：`probe` / `drop` / `linemode` 三步默认读**本机真实的 `~/.dsh`**——那才是
读者手里的安装。但一个**没配置过**的 home 开机进的是配置向导（0.8.2 起，这是修好"向导永远不出现"的
结果），向导占着键盘，`/diag` 和 `/status` 都不应答，这三步只能打印 `SKIP:`，整轮收尾 `INCOMPLETE`。
`--home` 把它们指向 `probe-home.mjs` 建好的 home，于是"工作区契约"与"断链重连契约"是**真跑过**而不是
跳过；**不带** `--home` 跑一遍仍然有意义——它测的是本机那份安装。同一台机器上两次都值得跑。

其中 **链路探针（`tui-rtt-probe.mjs`）** 覆盖两种形状，缺一不可：新会话在"先慢后快"的链路上让
chip 追上真实值；以及**带历史的 resume**——回放期间不合成任何帧（B2.4），relay 恰好在这个窗口里接入，
所以这一段既可能被别的写入清成黑屏，也可能让 chip 永远停在 `○○○○ 160ms`。两个断言都做过变异校验：
把进屏序列改回"接入即写"会报 4 秒黑屏，把 RTT 应用关掉会报 chip 停在占位值。

**"从没测到过"是第三种形状，由 `tui-unmeasured-probe.mjs` 覆盖**（管道父进程，两条腿：不回 DSR 读
`未测`、每条必答读真值）。它必须单列，因为**PTY 探针在 ConPTY 上摸不到这个状态**：ConPTY 自己回
`CSI 6n`，探针既看不到请求、也没法扮一个沉默的终端（`tui-cut-probe.mjs` 同理，它在本机只能报
`SKIP:`）。同一份字节流经 ConPTY 还会被改形——一次 boot 加 `/diag`，`ESC[<row>;1H` 在 ConPTY 上是
**3** 个、在管道上是 **95** 个，`ESC[2J` 是 **1** 对 **0**——所以断言"逐行寻址""不许清屏""只重画高亮
那一行"的检查（`tui-setup-probe.mjs` 的 list 步、`tui-probe.mjs --line-mode`）在 ConPTY 上会打印
`SKIP:` 而不是硬判。**`SKIP` 永远不是通过**：`verify-batch` 见到它收尾 `INCOMPLETE`。

## 发版窗口怎么定

选日期看的是热度曲线，不是感觉：GitHub 的 traffic 只留 14 天，发版脉冲 24–48 小时就衰减，
所以「再等几天」换不到信号。采集与读表方式见 [heat-tracking.md](heat-tracking.md)
（`node scripts/heat-report.mjs`，每周一次，数据落在 `$DSH_HOME/heat/`，不进仓库）。
