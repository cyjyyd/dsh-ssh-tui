# 发版流程（硬性规则）

> 本文件是**规则**，不是建议。任何自动化助手、脚本或维护者在发版前都必须先读它。

## 三条规则

1. **只有用户明确要求发版时才发版。**
   用户的指令里**没有**"发版 / 发布 / release / 发 npm / 打 tag"这类字样时，
   **不得**执行任何发版动作：不改版本号、不打 tag、不推 Release、不动 npm。
   修完 bug、跑完验收、推送到 GitHub 分支——到此为止，然后等指令。

2. **顺序固定：先 GitHub，后 npm。**
   发版请求先落到 GitHub：版本号提交 → 推送 `main` → 打 `vX.Y.Z` tag → 推 tag。

3. **CI 全部腿全绿，才允许碰 npm。**
   tag 推上去后确认 CI（`test (0.1.5-rc.3)`、`test (0.1.5-rc.1)`、`test (0.1.2-rc.1)`、
   `test-windows`）**全部 success**，再 `npm publish`。
   CI 红着就把包发出去，等于把一个未验证的版本交给所有 `@next` / `@latest` 用户。

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
  cordis/loader/schemastery 之后，0.1.2-rc.1 那条腿又因为 **cordis-plugin-include 被 npm 拿到 1.0.9**
  而挂——1.0.9 的 peer 是 `cordis ~4.0.4`，与钉住的 4.0.2 天然冲突（rc.3 族里它是被精确钉成 1.0.7 的，
  老族里没人钉）。所以现在根部写死 **六个**：`cordis 4.0.2`、
  `cordis-plugin-{include 1.0.7, loader 1.0.3, hmr 1.0.17, timer 1.1.4}`、`schemastery 3.18.2`
  （后四个不是我们 import 的，纯粹是钉住 npm 的选择），`peerDependencies` 里保持区间（消费者那边由宿主提供）。
  `tests/bundle-patch.test.mjs` 会把这条钉住；要动它们就跟族一起动。
- **范围不要提前放宽。** 只有在真跑绿之后才把新版本纳入范围与 CI 腿；没跑过的版本宁可让
  `dsh` 拒绝加载（明确的"还不支持"），也不要静默地放进来。未验证就声明兼容，等于把
  "反正没测过"翻译成"用户装得上但没人知道会怎样"。
- **prerelease 的 semver 规则要记住**：`0.1.6-alpha.2` 字面上小于 `0.1.6`，但它**不**满足
  我们的范围——node-semver 只在某个 comparator 带有**同一** `[major, minor, patch]` 的 prerelease 时
  才放行 prerelease。所以 `>=0.1.5-alpha.1 <0.1.6` 既排除 `0.1.6-alpha.x`，也排除 `0.1.7-alpha.x`；
  这条已被 `tests/bundle-patch.test.mjs` 钉住，别靠感觉改。
- **CI 腿的取舍**：`matrix.dsh` 里每个"能启动宿主"的版本都跑全套单元测试 + 真 PTY 探针；
  最老的两条（0.1.5-rc.1 的 peer 解析不了、0.1.2-rc.1 太旧）只跑 typecheck 与单元套件。
  默认腿跟着 `package.json` 的 pin 走（= 当前要重点验的那一版），`latest` 单独留一条腿。

### 当前快照（2026-09-22）

| 通道 | 版本 | 我们的表态 |
|---|---|---|
| `latest` | `0.1.5-rc.2` | `compatible`（0.7.2 就是对着它发的，CI 绿）；rc.3 发布后这条腿**取消了**：rc.2 自己的 caret 兄弟范围会解析成混版族，npm 直接 ERESOLVE，而它与 rc.3 的 API 逐字节相同（见下） |
| `next` | `0.1.5-rc.3`（09-22 发布） | `compatible`：本地全套 888 项（885 通过 / 0 失败）+ 三个探针全绿后声明，并进了 CI 腿 |
| `alpha` | `0.1.7-alpha.1`（09-22） | 范围外，不声明 |
| — | `0.1.6-alpha.1`（09-15）、`0.1.6-alpha.2`（09-17） | 范围外，不声明；**0.1.6 还没有 rc**。alpha.2 已证实会破 `agent/created` 的编译，修法已在代码里 |

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

## 发版窗口怎么定

选日期看的是热度曲线，不是感觉：GitHub 的 traffic 只留 14 天，发版脉冲 24–48 小时就衰减，
所以「再等几天」换不到信号。采集与读表方式见 [heat-tracking.md](heat-tracking.md)
（`node scripts/heat-report.mjs`，每周一次，数据落在 `$DSH_HOME/heat/`，不进仓库）。
