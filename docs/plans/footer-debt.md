# 底栏剩余 UI 债务：解决方案研究

> 状态：**已执行（2026-10-01）**。D-1 / D-3 / D-4 / D-5 / D-6 / D-7 按选定方案落地；
> D-2 **不改，记为 accepted debt**。底栏布局与响应式语法自本轮起冻结（见文末）。
>
> 每一节给出：现状（有出处）→ 问题是否真的咬人（有实测）→ 方案 A/B/C（成本 / 风险 / 验证）
> → 我的建议 → 需要你拍板的地方。**已执行项的结论按实际实现回填在各节末尾。**
>
> 前一轮（E 批）已落地：状态行重排、三段式退化阶梯、拖动节流（链路感知）、
> `footer.ts` 拆成 format / meters / budget / layout 四层 + barrel。本文只谈**还没动**的部分。

---

## D-1 · `footer-accents.ts`：为打断循环依赖而存在的模块

**现状**：`src/footer-accents.ts` 只有 28 行、一个函数：

```ts
export function accent(text: string, token: string, depth: ColorDepth): string
```

拆模块时 `footer-meters.ts`（`capacityMeter` 画填充格）和 `footer-budget.ts`（`linkPips` 画圆点）都要它，
而 meters 被 budget 依赖，于是单独抽成一个叶子模块。

**问题是否咬人**：不咬人，但它是**唯一一个"为了依赖图而存在"的模块**——读代码的人会问"为什么这点东西要单独一个文件"。
`color-depth.ts` 本身是叶子（只 import 类型/自身逻辑），而且已经拥有 `downgradeSgr`——`accent` 正是它的下一步。

**方案**

| | 做法 | 成本 | 风险 | 验证 |
|---|---|---|---|---|
| A | 不动 | 0 | 0 | — |
| **B（推荐）** | `accent` 移进 `color-depth.ts`（它已经有 `downgradeSgr`，且不依赖 footer/*），删掉 `footer-accents.ts` | ~30 行改动，2 个文件 | 极低：纯搬移，无行为变化 | `npm run typecheck` + 全量测试（色板相关：`tests/color-depth.test.mjs`、`tests/footer-strip.test.mjs` 的 accent 断言） |
| C | 由调用方传 `paint: (text, level) => string` 回调进 meters（依赖倒置） | ~60 行 + 两个调用点改造 | 中：把颜色策略从 meters 里赶出去，但调用方要知道"哪一格该上色" | 新增注入用例 |

**建议 B**。顺手把注释里"为什么单独一个模块"的说明搬成 `color-depth.ts` 里"`accent` 的语义"。

**已执行（B）**：`accent` 移入 `color-depth.ts`，`footer-accents.ts` 删除；名字**未改**（沿用时确认现名未失真）。
`footer.ts` 的 barrel 文档补了一句"共用件住在 `color-depth.ts`"。

---

## D-2 · 退化阶梯：全局整数级 vs 按 chip 分配预算

**现状**：`runtimeStrip()` 从 level 0 试到 17，取**第一个能放下**的 level；level 是一张全局表，
决定每个 chip 此刻的形态（`src/footer-budget.ts`）。当初这样设计是为了让"先丢什么"成为一条可测的**顺序**。

**实测（40–200 列，161 个宽度，`runtimeStrip` 直接调用）**：

```
distinct rows: 9
  40- 41   37 cells     52- 57   52 cells     67- 79   67 cells     92-200   92 cells
  42- 44   42 cells     58- 63   58 cells     80- 91   80 cells
  45- 51   45 cells     64- 66   64 cells
相邻形态的跳变：5, 3, 7, 6, 6, 3, 13, 12 格
有 110/161 个宽度剩下 >= 8 格未用；最宽的一档（92 列以上）最多闲着 108 格
```

**问题是否真的咬人**：**只咬一半**。

- 不咬的那半：首次适配（first-fit）在**这套形态词汇内是紧的**——不存在"某个宽度明明还能显示更丰富的形态，
  阶梯却先降级了"。实测已经证明：选中的 level 一定是能放下的最小 level。
- 咬的那半：**形态跳变不均匀**（3 格一跳和 13 格一跳混在一起），且**分配是全局的**——
  最贵的那一段（`Tok` 总量 11 格、上下文比值 `· 610K/1M` 10 格）一次跳掉，
  而同期另一个 chip 可能只需要 1–2 格就能多显示一段。92 列以上闲着 108 格是因为"已经是最全形态"，
  这一点不是缺陷，是设计（默认行本来就只有 6 个 chip）。

**方案**

| | 做法 | 成本 | 风险 | 验证 |
|---|---|---|---|---|
| A | 不动 | 0 | 0 | 现有 9 档形态表（`tests/footer-strip.test.mjs` 逐字钉住） |
| **B（推荐先做）** | **只平滑分段数**：把 `CAPACITY_SEGMENTS_*` 从三个档位改成"按本 chip 剩余预算算段数"（3–8 格连续可调），其余阶梯不动 | ~40 行，`footer-meters.ts` + `footer-budget.ts` | 低：只影响两个 meter 的格数；形态表要重录（9 档 → 十几档） | 重跑 `scripts/capture-footer-frames.mjs`（19 帧）+ 逐字表更新 + 单调性用例 |
| C | 真正的 per-chip 预算分配：按优先级顺序为每个 chip 分配剩余预算，各自选形态 | 重写 `runtimeStrip` 核心（~60 → ~120 行），形态表与优先级策略要重新推导 | 中高：**视觉结果在每个宽度都会变**；要重新证明单调性（更窄一定不更宽）与"高价值 chip 不被低价值 chip 挤掉" | 现有 33 条 `footer-strip` 用例大半要重写；需要新的宽度扫描验收 |

**建议**：先做 **B**（可见收益/风险比最好），**C 暂不做**——现值"9 档形态 + 逐字表"是一次性成本，而 C 会把它变成长期维护面，
换来的排布精度在 40–92 列这一段本来就够用（相邻档差 5–7 格，即一个 chip 的细节）。

**决定：不改（accepted debt）**。当前证据是"退化单调、且不存在错误提前降级"（首次适配在形态词汇内是紧的），
跳变不均匀本身不足以支撑扩大 shape / exact-test 面积。**除非后续在真实宽度下出现用户痛点，否则不重开此项。**

---

## D-3 · `Tok` 的统计口径只在 `/status` 可见

**现状**：`sessionTokenTotal()`（`src/stats.ts`）优先累加 harness 自己报的 `totalTokens`，
只有在某一步没报时才退回"计费分段相加"，并返回 `basis: 'harness' | 'sum'`。
底栏只画数字（`Tok 36.8M`），口径写在 `/status` 的一行里。

**实测（两个真实适配器）**：

- `@deepseek-ai/dsh-llm-pi-ai`：`mapUsage()` 直接带上 `totalTokens: usage.totalTokens`；
- `@deepseek-ai/dsh-llm-deepseek`：在 `usage` 分片里自己算 `inputTokens + outputTokens + cacheRead + cacheWrite`。

也就是说 `basis === 'sum'` 只在**手工构造的 usage**（老日志、第三方适配器缺字段）时出现。

**问题是否咬人**：几乎不咬。真正会误导的是"口径不同却画成同一个数字"，而现在的口径**优先取权威值**；
剩下的是"少数情况下这个数字是拼出来的，但底栏没说"。

**方案**

| | 做法 | 成本 | 风险 | 验证 |
|---|---|---|---|---|
| A | 不动 | 0 | 0 | — |
| **B（推荐）** | `basis === 'sum'` 时**不画这个 chip**（和"读不到额度就画 `?%` 而不是 `0%`"同一条规则：拿不出证据就不报数） | ~5 行 + 1 条用例 | 极低：真实路由下 `basis` 恒为 `harness`，画面上不会有变化——等于给边缘情况上了保险 | 新增 1 条单测（构造 `basis: 'sum'` 的 usage → 断言行里没有 `Tok`） |
| C | 底栏标出口径（`Tok ~36.8M`） | ~5 行 | 低，但 `~` 在速度 chip 里已经表示"估算速率"，同一行里一个符号两种含义 | 逐字表更新 |
| D | 换成只画输出 token（`out 112K`） | ~5 行 | 低 | 逐字表更新 + 语义文档 |

**建议 B**。C 的符号冲突是实打实的（同一个 row 里 `~46 tok/s` 和 `Tok ~36.8M` 的 `~` 含义不同）；
D 则违背 E 批定下的"默认行只保留一个总量"。

**已执行（B）**：`basis === 'harness'` 才把 `totalTokens` 交给行；实测
`harness total → … │ Tok 74.4K`、`parts only → …`（该 chip 不出现）。`/status` 两种口径都打印并标注。

---

## D-4 · 流式期间的 `tok/s` 是估算

**现状**：harness 不在流式期间给任何 token 计数（两个适配器都只在收尾时给 `usage`，
已在 E 批核实），所以流式速率是"字符速率 × 本会话标定比"，前缀 `~`，并按 `THROUGHPUT_FRESH_MS` 判定陈旧。

**实测（标定收敛，半衰步进）**：

```
会话真实比值 0.30（英文/代码）: 0.32 → 0.31 → 0.305 → 0.302  （每步误差 3% → 1%）
会话真实比值 0.95（中文）      : 0.635 → 0.792 → 0.871 → 0.911（每步误差 33% → 8% → 4%）
首轮回复（尚未 settle）        : 英文误差 7%，中文误差 66%
```

**问题是否咬人**：咬一次，且只咬**每个会话的第一轮**：中文会话第一条回复的 `~tok/s` 会低报到三分之一左右，
两轮之后收敛到 5% 以内。之后整条会话都准。

**方案**

| | 做法 | 成本 | 风险 | 验证 |
|---|---|---|---|---|
| A | 不动（已有 `~` 标记 + 陈旧回退 + 半步标定） | 0 | 0 | 现有用例 |
| **B（推荐）** | **按脚本猜初始比值**：在 `ThroughputTracker` 里统计流式字符中 CJK 码点占比，>30% 用 ~0.85，否则用 0.30；标定照旧覆盖它 | ~25 行 + 3 条用例 | 低：只影响"本轮首个 settle 之前"的显示；中英混排会选其中一个（误差 < 2 倍，优于现在中文的 3 倍） | 单测：纯中文流 / 纯英文流 / 混排；样例帧确认 `~` 值量级 |
| C | 把标定值按模型持久化（`$DSH_HOME` 下一个小 cache） | ~80 行 + 新持久化面 + 失败路径 | 中：多一个要清理/迁移的状态文件，收益只在"每个会话第一轮" | 新增持久化用例 + 损坏文件用例 |
| D | 流式期间不显示速率（只显示 `—`），settle 后给精确值 | 删代码 | 低 | 逐字表 + 用例删除 |

**建议 B**（性价比最高），**C 不做**（为一个带 `~` 的显示值引入持久化状态不划算）；D 与"运行中要看到速率"的原始要求相悖。

**已执行（B，但连续化）**：没有采用 30% 硬阈值。`ThroughputTracker` 按**当前流式文本**的 CJK 码点占比
在 `DEFAULT_TOKENS_PER_CHAR_LATIN = 0.32` 与 `DEFAULT_TOKENS_PER_CHAR_CJK = 0.85` 之间**连续插值**；
首条 settled usage 落地后交给既有的 session calibration（半衰步进），`~` 标记不变。API 从
`note(chars, time)` 改为 `note(text, time)`——脚本占比必须从文本本身量出来。实测（同样 20 字符/帧）：

```
English  ~37 tok/s      Chinese  ~98 tok/s      mixed 50/50  ~67 tok/s
```

**遗留**：插值是"按码点占比"的线性近似，不代表真实 tokenizer；它对**首轮**的量级误差从中文 66% 收进约 10%，
settle 之后由标定接管（与之前一致）。

---

## D-5 · 拖动节流现在依赖 `paintIntervalMs`（即依赖 CSI-6n 探测）

**现状**：E 批把拖动预算改成 `clamp(max(2×合成成本, paintIntervalMs), 40, 400)`，
其中 `paintIntervalMs` 来自 `paintIntervalForRtt()`：

```
RTT 未测到 → 160ms | <50ms → 80ms | <150ms → 160ms | <350ms → 250ms | 其余 → 400ms
```

**问题是否咬人**：**在"终端不回答 DSR"的链路上会**。那种情况 `paintProbed === false`，底栏显示
`SSH ○○○○ 160ms`，拖动预算按 160 ms 走——比真实链路可能快（若链路其实 400ms 档，仍会堆几帧）
或慢（若链路其实 80 ms 档，拖动比该有的更钝）。你自己的 WT+SSH 目前是 `SSH ●●●● 29ms`（已测到），所以这一条对你是"未来风险"。

**方案**

| | 做法 | 成本 | 风险 | 验证 |
|---|---|---|---|---|
| A | 不动（探测不到就用项目既有的 SSH 默认档 160ms） | 0 | 0 | — |
| **B（推荐）** | **未探测时保守化**：`paintProbed === false` 时拖动预算的下界取 `min(paintIntervalMs, 200ms)` 之外的**更保守值**（例如 200ms），避免在未知链路上把帧堆起来 | ~6 行 | 低：只在"没测到 RTT"的链路上改变拖动节奏 | 单测：`paintProbed=false` + 假 `paintIntervalMs` → 断言拖动帧率落在保守档 |
| C | 用**实测链路吞吐**替代节奏：记录"一帧 N 字节 → 终端消费完用了多久"（socket 写回调 + ACK 语义） | ~120 行，跨 relay/Host 协议 | 高：socket 写回调只说明"离开本进程缓冲"，不等于"终端画完了"；测出来的量需要平滑与退化路径 | 需要新的协议字段 + 真机对照 |
| D | 让 byte budget 参与：既然有 `FRAME_BYTE_BUDGETS[quality]`（每档每帧字节上限），就用 `本帧字节 / 预算档` 估算落地时间 | ~30 行 | 中：这是"每帧字节上限"，不是吞吐量；换算出来的是上界而非实测 | 单测 + 慢链路样例 |

**建议 B**（把未知链路当慢链路处理，一行策略），**C 不做**（协议面变大、语义还不干净），D 留作将来有真实吞吐数据时再谈。

**已执行（B），并按"即时感知"重做了节流模型**：策略提成纯函数 `linkRedrawBudgetMs()`（`paint.ts`），
`paintCadence: 'measured' | 'configured' | 'local' | 'unprobed'` 表明节奏来源。只有 `ssh && unprobed` 走
`RESIZE_UNKNOWN_LINK_BUDGET_MS = 200` 的兜底，且**它只是一个 redraw budget，不是 RTT**——底栏照样画
`SSH ○○○○ 160ms`（未测到就不声称测到）。`DSH_TUI_PAINT_MS` 显式指定时按用户的值，本地 TTY 按本地常量。

**同轮追加的模型修正（Windows Terminal 实测"缩放依旧拖延"）**：原先的拖动节流用一个*固定链路节奏*
（`paintIntervalMs`）当帧率下限，于是**即使链路很快、帧很便宜，一次拖动也只能 12.5 帧/秒**——用户看到的是画面追着指针跑。
现在改为**按真实背压节流**：

- Host 直接问**拥有那条线的人**还有多少字节没送出去（直连路径 `stdout.writableLength`，
  relay 路径新增 `DisplayHost.pendingBytes()`，读 relay socket 的 `writableLength`）；
- 只要线没积压（且距上一帧 > 16ms，仅用于合并同一毫秒内的连发事件），**来一个 resize 就画一帧**——
  和终端自己重排网格一样即时；
- 线积压时才退到 deadline（`min(最新事件+40ms, 上次绘制+budget)`），且 budget 只在**未探测**链路上保守，
  已探测链路交给背压判断。

实测（`rz-immediate`，220 行/30 行转录，事件间隔 16ms）：

```
线通畅   : 12 事件 → 12 帧，末帧尺寸 = 终端尺寸
线积压64K: 31 事件 →  9 帧（220 行）/ 39 → 19（30 行）
积压排空后: 最后那个尺寸补画，尺寸正确
```

---

## D-6 · 状态行上仍是两套 fitter（`⚠` 走老的 `fitFooterChips`）

**现状**：`src/tui.ts` 画底栏第一行时是二选一：

```ts
const stripText = health === undefined
  ? runtimeStrip(stripInput, width, this.mutedSeparator(), this.spinnerFrame())
  : fitFooterChips([ health, runtimeStrip(...) ], width, this.mutedSeparator())
```

`fitFooterChips`（老的"先丢文字、再丢整组"算法）现在**只服务 `⚠` 安装健康芯片**；行上其余部分都走 `runtimeStrip` 的阶梯。

**问题是否咬人**：咬得不多，但是**两套机制在同一行上并存**——`⚠` 的宽度预算要靠调用方手工
`width - visibleWidth(health.short) - 1` 传给 `runtimeStrip`，`runtimeStrip` 内部再跑一遍自己的阶梯。
新增任何 chip 时，这一行有两个地方可能出问题。

**方案**

| | 做法 | 成本 | 风险 | 验证 |
|---|---|---|---|---|
| A | 不动（可用，`⚠` 优先级已被测试钉住） | 0 | 0 | `tests/footer-chips.test.mjs` 点击/宽度用例 |
| **B（推荐）** | 让 `⚠` 成为 **budget 里的一个 chip**（`priority: -1`，`render` 返回长/短两形态），整行只走 `runtimeStrip` | ~40 行（budget + tui 调用点） | 中低：需要保证 24 列时 `⚠` 仍保留（现有用例）、并且 `⚠` 的点击行号仍然对得上（`healthChipRow` 的计算依赖 `paintRows.length`，不受影响） | 现有 `footer-chips` 的 ⚠ 用例全绿 + 新增"⚠ + 其余 chip 同阶梯"用例 + 19 帧渲染检查 |
| C | 保持两套，但把 `fitFooterChips` 收进 budget 模块，至少共用一个文件/词汇 | ~30 行 | 低：只是把代码搬到一起，机制仍两套 | 现有用例 |

**建议 B**。若你不想再动状态行的收敛逻辑，C 是"低风险半步"。

**已执行（B）**：`⚠` 成为 budget 的一等 chip（`priority: -1`，`WARNING_TEXT_LEVEL = 5` 时收成字形，
且永不从渲染里消失），`tui.ts` 不再调用 `fitFooterChips`；`runtimeStrip` 的最后兜底改为"先保 ⚠、再保链路"。
状态行现在**只有一条收敛路径**。实测 200→12 列扫描：warning 全程在场、无溢出（见 `docs/checkpoints.md` E-13）。

---

## D-7 · 老 footer 留下的公开面（无生产调用点）

**现状**（`src/*.ts` 内的**生产**调用点计数；测试计数另列）：

| 符号 | 生产调用点 | 测试引用 | 说明 |
|---|---|---|---|
| `fitFooterStatsLine` | **0**（只在 `tui.ts` 的 re-export 列表里） | 4 | 老第一行的整行 fitter，E 批后无人调用 |
| `formatFooterQuota` | **0** | 8 | `SuperGrok 5Hr ███ 82%` 这种带徽章的额度串，默认行改成分离 chip 后没人用 |
| `formatQuotaUnknown` | **0** | 3 | 同上（`?%` 现在由 `capacityMeter` 画） |
| `formatTokensPerSecond` | **0**（仅被 `footerStatsGroups` 调用） | 6 | 老 `tok/s` 文本 |
| `dropFooterQuotaPlanName` | **0** | 2 | 老"窄屏丢徽章"逻辑 |
| `footerStatsGroups` | 1（`tui.ts:5409` 的 `statsText()`） | 3 | 而 `statsText()` 本身**没有生产调用点**（grep 全仓只有定义处），是留给测试的口子 |
| `FooterChip` / `fitFooterChips` / `footerHealthChip` | 见 D-6 | 11/8 | 若做 D-6/B，这三个会一起消失 |

**问题是否咬人**：`footer.ts` 现在是 barrel，`export *` 四个模块，于是这个"公开面"看起来像 API，
实际是**上一版底栏的化石**。维护者会在里面找当前语义，可能照着 `formatFooterQuota` 去拼一行新的额度文本。
而 `src/index.ts`（插件入口）并不导出这些。

**方案**

| | 做法 | 成本 | 风险 | 验证 |
|---|---|---|---|---|
| A | 不动 | 0 | 0 | — |
| **B（推荐）** | 只保留**仍被使用或仍被 `/status`、`/quota`、测试依赖**的符号；给确认为化石的函数加 `@deprecated` 并在注释里指向替代实现（不删导出，避免破坏外部引用） | ~30 行注释 | 极低 | `npm run typecheck` + 全量测试 |
| C | 直接删除（含相关测试） | ~120 行删除（含 6 组测试） | 中：若外部有人 `import { formatFooterQuota } from 'dsh-ssh-tui/lib/footer.js'` 会断（`package.json` 的 `exports` 只暴露入口与三个子路径，理论上不承诺 `lib/footer.js`） | 全量测试 + `npm pack` 后检查产物 |
| D | 把化石移进 `src/footer-legacy.ts` 并在 barrel 里不导出 | ~80 行搬移 | 中：测试要改 import 路径 | 全量测试 |

**建议 B 立刻做、C 留到下一个 breaking 版本**。理由：`0.8.x` 已是发布线，`lib/footer.js` 虽未承诺但确实存在；
`@deprecated` 能立刻止住误用，删除要等版本窗口。

**已执行（B）**：`FooterChip` / `fitFooterChips` / `fitFooterStatsLine` / `footerStatsGroups` /
`formatTokensPerSecond` / `formatFooterQuota` / `formatQuotaUnknown` / `dropFooterQuotaPlanName`
全部标注 `@deprecated Legacy surface, removed in 0.9` 并写明替代物。**0.8.x 内不删除。**

---

## 汇总：我的执行建议与顺序

| 顺序 | 项 | 方案 | 规模 | 收益 |
|---|---|---|---|---|
| 1 | D-3 `Tok` 口径 | B：不可靠就不画 | ~5 行 | 消除"数字口径不同却长得一样"的唯一场景 |
| 2 | D-1 accent 模块 | B：搬进 `color-depth.ts` | ~30 行 | 少一个模块、依赖图少一条边 |
| 3 | D-4 流式速率 | B：按脚本猜初始比值 | ~25 行 | 中文会话首轮的 `~tok/s` 从错 66% 收进 ~15% |
| 4 | D-6 `⚠` 合并 | B：成为 budget 的 chip | ~40 行 | 状态行只留一套收敛机制 |
| 5 | D-5 未探测链路 | B：保守档 | ~6 行 | 未知链路上不再堆帧 |
| 6 | D-7 化石 API | B：`@deprecated` 标注 | ~30 行注释 | 止住误用；删除留给 0.9 |
| — | D-2 阶梯分配 | **B（只平滑分段数）**，C 不做 | ~40 行 + 形态表扩容 | 相邻档差从 3–13 格拉平 |

**如果只做一件**：D-3（成本 5 行，消除一处分歧）。
**如果只做一件"看得见"的**：D-2/B（窄宽度下 meter 的格数会跟着预算连续变化，比现在 3/5/8 三档自然）。

**贯穿所有项的一条原则**（沿用 E 批）：*能拿出证据才画数字，拿不出就不画*——D-3 与 D-4 都是在同一条规则上做的取舍。

---

## 冻结声明（2026-10-01）

本轮之后，**底栏布局与响应式语法冻结**：

- 第一行（状态行）的 chip 顺序、组件类型（health meter / capacity meter / performance value）、
  退化阶梯（17 级）与颜色语法（阈值来源）**不再扩张**；
- 第二行只按优先级排序 + 从右裁切，**不再新增 part**；
- 0.8.x 只接受 bugfix；本清单里的结构性改动（含 D-2/C、D-7/C 的删除）排到 0.9。

已执行的六项与一条 accepted debt 见上；验收记录见 `docs/checkpoints.md` 的 E 批 E-13。

---

## 冻结之后的例外：E-15（缩放卡顿，用户实机复验后追加）

实机反馈"拖动缩放排版滞后、必须等重排完成才能打字"落在冻结范围**之外**：它不碰底栏的布局、阶梯、
颜色或第二行顺序，改的是**一帧渲染多少行 transcript**。按 0.8.x 的 bugfix 口径处理，理由与范围：

1. **症状可复现、可量化**：拖动中每个 resize 事件的同步耗时随会话长度线性增长（803 / 2403 / 5000 行
   → 131.6 / 437.6 / 767.5 ms），而这段同步时间就是按键送达延迟——event loop 被占住，输入框自然"没反应"。
2. **两处根因都与冻结无关**：① 宽度属于每行渲染指纹，所以拖动时全部行都要重排；② `displayWidth(char)`
   在裁剪循环里逐字符重建策略 key（profile 占拖动样本 56%）。修法是渲染范围与调用次数，不是视觉语法。
3. **视觉结果不变**：帧字节数不变，最终画面尺寸正确；拖动中间帧只画可见的 transcript 尾部，
   指针停下即整屏恢复（`widenPastResizeTail` 必须带 settle 重挂——E-m17：去掉重挂后折叠会永久留下）。

所以冻结声明仍然成立：**底栏形态没有扩张一格**，本轮只改了它出现之前正在做什么。

### E-16（同一轮的追加）：为什么"变大"比"变小"拖沓

用户实机复验后给了方向性反馈：大→小非常流畅，小→大略显拖沓。测量把原因指到了**每帧字节数与宽度成正比**
（60 列 3.7KB、140 列 7.3KB，其中 89% 是 transcript 文本，padding 为 0 字节）：终端按字节/格消费，于是变大的
方向每帧都比上一帧大，积压累积，指针停下后还要排空 30–44ms（变小方向 0–10ms）。

两条修法都已落地（用户选"都做"）：拖动帧只画 chrome（`PaintOptions.dirtyFrom`，帧降到 556–988B 且不随列数增长），
拖动背压门槛从固定 32KB 改为"一帧为界"（`resizeWireBehind`）。整场拖动 110KB → 9.3–12.7KB，两个方向的排空都是 0ms。

**这里有一条边界要记住**：拖动帧不画 transcript，是在赌终端会 reflow 它自己持有的网格（Windows Terminal、
VTE、Konsole、iTerm2、kitty 会；旧 conhost、部分多路复用器不会）。不会 reflow 的终端上，拖动过程中
transcript 更新更少，指针停下后的整屏帧才校正。`--resume` 式的折叠已经决定了"什么时候可以把 transcript 留下"，
`dirtyFrom` 只是同一决定在帧上的另一半——所以这条边界和折叠本身一样宽，没有新增风险面。
