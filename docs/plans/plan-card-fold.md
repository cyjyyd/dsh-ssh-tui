# 计划卡的折叠语义（待实施，排在 P-1 之后）

> 来源：维护者 2026-10-14 的要求 —— **计划卡默认折叠**，并且**用户切换过折叠状态后，该状态不再被自动改变**。
> 本轮（P-1）的约束是"只碰探针、不动 runtime"，所以这里只做登记与设计，实施另起一轮。

## 要求

1. **默认折叠**：计划卡（`row.kind === 'plan'`）第一次出现时是折叠的，不再因为"计划还活着"而自己展开。
2. **用户意图优先**：用户对该卡按过折叠键（或"全部折叠/全部展开"）之后，任何**自动**路径都不得再改它的
   `expanded`——包括 artifact 更新、步骤状态翻转、turn 结束、卡片归档、焦点环移动、重绘窗口变化。
3. 没被用户碰过的卡，仍按第 1 条的默认走（即"默认折叠"是默认值，不是一次性初始化）。

## 现状（实测，供实施轮直接改）

| 位置 | 现在做什么 |
|---|---|
| `src/rows.ts:88` `planShouldDefaultExpand()` | 默认展开的**唯一**判据：`active` / `pending` / 有 `in_progress` 步骤 → `true` |
| `src/tui.ts:4482` | 建卡时用上面这个判据决定初始 `expanded` |
| `src/tui.ts:4454-4457` | **自动改写路径**：artifact 更新时，`!live` → `row.expanded = false`；`live` 且当前折叠且判据为真 → `row.expanded = true` |
| `src/tui.ts:5546` / `5608` | 用户的折叠键：`toggleCollapsible()` → `target.expanded = !target.expanded` |
| `src/tui.ts:5627` / `5639` / `5701` | "全部折叠 / 全部展开"与焦点相关路径也会写 `row.expanded` |

被钉住的地方：`tests/rows.test.mjs:142-147` 直接断言 `planShouldDefaultExpand` 的四种输入；实施轮要连同
这些断言一起改，并检查 `tests/plan-*.test.mjs`、`tests/representation-*.test.mjs` 与
`npm run freeze` 里的 representation 不变式（`collapsibleRows()`、`lastPaintRows`、行模式输出）。

## 设计（待授权）

- 用**每卡记录的用户意图**（例如 `expandedPinned?: boolean`，或 `expandedBy: 'user' | 'auto'`）替代"当前值"
  作为自动路径的判据：`toggleCollapsible`/全部折叠/全部展开把该标记置为用户态；`src/tui.ts:4454-4457`
  与任何"跟随 live 状态"的写入都先看这个标记。
- `planShouldDefaultExpand()` 的语义从"是否展开"降级为"默认值"（恒定 `false`），或整体删除、由建卡处写死
  `expanded: false` —— 选哪条取决于 `tests/rows.test.mjs` 想保留多少函数面。
- 需要明确的边界（实施轮里逐条写进测试）：
  - **归档**（`archiveStalePlans`）是否允许折叠一张用户展开过的旧卡？按第 2 条：不允许自动改（旧卡保持用户
    最后一次选择）。
  - **新计划**（新 artifact、同一会话里的第二张卡）按默认折叠，不继承上一张卡的粘性。
  - **行模式**（`DSH_TUI_LINE_MODE=1`）没有折叠概念，保持原样，并在文档里说明"默认折叠"只作用于框模式。

## 验证（实施轮的门）

1. `tests/rows.test.mjs` 改成"默认恒为折叠"，并新增：粘性卡在 artifact 更新 / 步骤翻转 / 归档 / 焦点移动后
   `expanded` 不变；未碰过的卡仍按默认。
2. `npm test`、`npm run freeze`、`npm run freeze:input`、`npm run bench`（折叠变化会改绘制字节数，记录而不
   当退化）、真机探针（框模式：折叠卡的首屏形态；行模式不变）。
3. 视觉确认：计划卡首次出现即折叠；展开后触发一次计划更新（步骤翻绿/翻红）仍保持展开。

## 不做

- 不改计划**数据**（artifact/步骤/状态），只改折叠的呈现与粘性；
- 不与 P-1 的探针判定混在一轮（P-1 只碰 `scripts/`、`tests/` 与文档）。
