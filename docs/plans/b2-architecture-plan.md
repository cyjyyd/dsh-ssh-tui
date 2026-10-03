# B2 架构规划 · What Deserves To Exist

> 状态：**规划冻结稿（planning only）**。本轮不改任何生产代码、测试、renderer、reducer。
> 前情：B0 冻结语义归属，B1.1 冻结 interaction 的像素归属，B1.2 冻结 picker 的像素归属并画出 composer 边界。
> B0–B1 回答的是 **"东西画在哪"**；B2 回答的是 **"什么东西值得存在"**。
>
> 本文的每一条事实都来自当前 HEAD `a295ee95` 的代码或本轮实测（附录 A 给了度量方法）。
> 本轮发现的代码限制集中记录在 §12，**按要求不顺手修**。

---

## 0. 冻结结论摘要

| # | 结论 | 依据 |
|---|---|---|
| 1 | 引入 **Screen**（替换 workspace 的独占画面）与 **Surface**（借用工作区一块像素与键盘）两个概念，**不是**两个管理器 | §2 |
| 2 | Screen 与 Surface 走**两条独立通道**，不再共用 `dialogQueue`；`surfacePriority` 的 `dedicated` 档删除 | §2.4 / §5.5 |
| 3 | 报告类命令（`/status` `/usage` `/diag` `/doctor` `/help` `/subagents`）**离开 transcript，改为 Screen** | §3 |
| 4 | transcript 只保留**叙事**：用户、模型、工具结果、错误、压缩、目标、以及"人类动作的摘要" | §4 / §10 |
| 5 | 引入 **RepresentationPolicy**（纯函数），renderer 不再决定事件是否存在；每个表示必须带 `durable` / `display` / `live` 标签 | §4 |
| 6 | **live 尾部**（streaming 回复、等待卡）当前住在 transcript 源行里，导致**每个流式帧整屏 clear**（实测 2.9–3.2 KB/tick）→ 必须改为覆盖式 tail block | §1.6 / §8 |
| 7 | **Completion 属于 composer 的子区域**，不是 transient、不是 Screen | §5.4 |
| 8 | **Plan 成为 artifact**，transcript 只留 `created / approved / completed` 三类引用行，dock 是它的投影而非第二份数据 | §5.3 |
| 9 | **Approval 不再需要独立 transcript 行**（今天也没有），状态挂到 tool card 上，弹窗只是编辑该状态的 Surface | §5.2 |
| 10 | 下一步最值得编码的是 **B2.1 Report Screens + Screen 渲染契约**，紧随 **B2.2 live 尾部归属**（唯一"每帧都在花钱"的问题） | §8 / §10 |

---

# 第一部分 · Current State Audit（事实）

## 1.1 Workspace Screen 的组成

`paintFrame()`（`src/tui.ts:4598`）今天在**一个函数**里组装全部像素。自顶向下：

| 段 | 内容 | 归属 |
|---|---|---|
| header | banner 行、横幅分隔线、`↑ 已回看 n 行` | 工作区 chrome |
| transcript window | `windowTranscript()` 切出的 `available` 行 | **transcript**（唯一有 scroll anchor 的东西） |
| plan dock | 活跃 plan 的钉底行（`paintPlanDock`） | chrome 投影 |
| dedicated 块 | onboarding 的 9 步对话框（`dialogRole === 'dedicated'`，**仍挤压**窗口） | dedicated（未迁移） |
| **composer boundary** | `╭───…` | composer |
| suggestions | slash completion / autocomplete | composer 子区域 |
| composer input | 多行 + 光标 | composer |
| stats row / status row | 冻结的两行 footer | footer |

`paintRows.length` 必须等于（或小于）终端高度；`windowTranscript` 的 `start = lines.length - available - scrollOffset`（`src/rows.ts:144`）。

## 1.2 "Dedicated" 今天不是一个东西，是三个

| 名字 | 实现 | 画面 | 键盘 | 是否挤压 transcript |
|---|---|---|---|---|
| **inspect** | `paintInspectOverlay()`（`tui.ts:4109`）在 `paintFrame` 开头**早退** | 整帧替换：自己的 header / 分隔线 / 正文 / 提示 / **自己的位置页脚** | 全部 | 不适用（工作区完全不画） |
| **onboarding** | `dialog.kind === 'onboarding'` + `DEDICATED_ROLE`，走 `dialogLines` | 挤压式对话框（transcript 仍可见） | 全部 | **是** |
| **boot** | `pushRow({kind:'brand-logo'})` + banner + help 行（`tui.ts:2279`） | 就是普通 transcript 行 | 无 | 本身就在 transcript 里 |

> **修正一个假设**：代码里**没有 boot splash 这个 dedicated screen**。启动画面是 transcript 的三行。真正的整帧替换只有 `inspect` 一处。

inspect 的实测代价（100×20，300 行输出的工具卡）：

```
inspect open           rows 21  bytes 2702  clear YES
inspect scroll down    rows 21  bytes 2703  clear YES
inspect scroll down 2  rows 21  bytes 2703  clear YES
inspect close          rows 20  bytes 2900  clear YES
```

原因是 `paintInspectOverlay` 每帧都写 `sizeChanged: true, chromeStart: 0`（`tui.ts:4153`），而 `composePaintFrame` 见到 `sizeChanged` 就发 `\x1b[H\x1b[J`（`src/paint.ts:376`）。**今天唯一的 Screen，是弱网上最贵的一屏。**

## 1.3 Transcript 的表示清单

`Row` 联合类型 16 种（`src/transcript-types.ts:33`）：`user` `assistant` `reasoning` `brand` `brand-logo` `tool` `subagent` `plan` `question` `goal` `compaction` `prompt` `changes` `system` `diag` `error`。

构造点（grep 计数，非穷尽）：`this.pushRow(` **262 处**；写成单行 `kind: 'system'` 的 **96 处**、`kind: 'error'` 的 **90 处**，另有跨行写法（按 `this.pushRow({` 后一行的 kind 统计：system 140、error 101）。
`this.askQuestion(` 16 处（全部是控制平面菜单 → picker role）。

**可重建性**（`replayHistory()` 走 `applySessionEvent`，`tui.ts:2792`）：reducer 的 switch 有 **11 个 case 标签**（10 个不同；`user/message` 出现两次，第二个在 `tui.ts:6781`，**不可达**）—— `user/message` `assistant/message` `tool/call` `tool/result` `step/start` `step/end` `sandbox/mode` `approval/policy` `turn/start` `turn/end`（外加字符串比较的 `workspace/changes`）。详见 §12 第 13 条。

于是**同一语义事件可能有 1–4 个表示**：

| 语义事件 | 表示 1 | 表示 2 | 表示 3 | 表示 4 | 可重建？ |
|---|---|---|---|---|---|
| 模型回答 | streaming tail block（live） | `assistant` 行（durable） | — | — | 是 |
| 工具调用 | `tool` 卡（durable） | 展开后的正文行 | inspect Screen（临时） | — | 是 |
| 提问 | `question` 卡（B0 durable fold） | interaction layer（B1.1） | `/status` 里的 waiting 计数 | footer「等待回答」 | 卡是，layer 否 |
| 审批 | tool 卡（无审批字段） | interaction layer | footer「等待审批」 | — | **否**（无独立行，见 §5.2） |
| 计划 | `plan` 卡 | plan dock（同一对象的第二投影） | plan-review interaction | footer「计划模式」/`/status` plan 字段 | 卡与 dock 是 |
| 上下文/提示注入 | `prompt` 行 | `system` 行 | — | — | 是 |
| 工作区改动 | `changes` 卡 | — | — | — | **否**（源码注释明确："a restarted Host cannot reopen it"） |
| 报告（`/status` 等） | `system` / `diag` 行 | — | — | — | **否** |
| 控制平面回声 | `system` 行（96 处） | footer 状态 | — | — | **否** |
| 重连 / 离开摘要 | `system` 行 | footer 链路 chip | notify 通道 | — | **否** |
| 启动 | `brand-logo` + 2 行 | — | — | — | **否** |

关键是最后一列：**transcript 里混着 durable 与 display 两类行，而画面上完全看不出区别**。resume 后"有些行回来了、有些没回来"，这不是 bug，是缺一层表示策略。

## 1.4 今天已经不成立的四个旧问题（B0–B1.2 的成果）

| 项 | 状态 | 实测 |
|---|---|---|
| transcript geometry stability | 成立 | picker / interaction 打开：`window start 55 → 55`、`scrollOffset` 不变 |
| 输入归属 | 成立 | 方向键归 surface、draft 与 history 不动、滚轮丢弃、被覆盖行不可点/不可拖选 |
| 重放边界 | 成立 | question 卡由 session projection 重建；`continued` 可再回答 |
| 弱网局部刷新 | **对 transient 成立，对别的都不成立** | transient：12 行 / 1.7 KB / **无清屏**；报告 20 行 / 2.9 KB / **清屏**；流式 20 行 / 3.0 KB **每帧清屏**；inspect 每键清屏 |

## 1.5 报告命令的实测代价（100×20，200 行会话）

```
/status   rows 20  bytes 2882  clear YES  start 231   modelRows 204
/diag     rows 20  bytes 3049  clear YES  start 249   modelRows 205
/help     rows 20  bytes 3244  clear YES  start 302   modelRows 206
/clear    rows 20  bytes 2888  clear YES  start 0     modelRows 1
```

`/help` 一次把窗口起点推走 **53 行**；`/diag` 推走 **18 行**。它们既不可重建，又把真正的叙事挤出视野。

## 1.6 live 尾部的实测代价（本轮最重要的发现）

流式回复（100×20，200 行会话）：

```
stream tick 1   rows 20  bytes 2925  clear YES  start 213
stream tick 2   rows 20  bytes 2972  clear YES  start 214
stream tick 3   rows 20  bytes 3019  clear YES  start 215
stream tick 4   rows 20  bytes 3066  clear YES  start 216
stream tick 5   rows 20  bytes 3113  clear YES  start 217
stream tick 6   rows 20  bytes 3160  clear YES  start 218
stream settled  rows 20  bytes 2884  clear YES  start 212
```

原因链：streaming 文本与等待卡是**源行**（`display.push` / `addDisplay`，`tui.ts:4966` 起）→ 每次多换一行 `lines.length` +1 → `start` +1 → `transcriptScrolled` → `sizeChanged` → **整屏 clear + 20 行重画**。

也就是说：**今天 TUI 最贵的行为不是弹窗，而是模型正在说话。** 一个 3 秒的回复在弱网上可能花掉几十 KB，而这一条与 B0/B1 的任何决定都无关——它是表示归属的问题（live 内容住进了只该存叙事的地方），正是 B2 的题目。

---

# 第二部分 · Screen 与 Surface

## 2.1 判定规则

**一句话**："用户是在工作区里被问了一句，还是离开了工作区？"

### Surface（借用）

必须**全部**满足：

1. 完成后回到**同一个上下文**：同一 `scrollOffset`、同一 focus、同一 composer 草稿；
2. 借用键盘，但**没有自己的导航**（不拥有滚动/翻页/搜索语义）；
3. 只占**已知的一小块**像素（layer 的 N 行，或 composer 的子区域）；
4. 生命周期 = 一次动作（answer / choose / cancel / preview）；
5. **不改变 transcript identity**（B1.1 / B1.2 已把这条做成了可测的不变量）。

### Screen（替换）

至少满足 3 条：

1. 有**停留期**：用户会滚动、翻页、搜索、比较；
2. 拥有**自己的导航状态**（offset / query / cursor），与工作区导航状态无关；
3. **整帧替换**工作区（期间 transcript 不可见，但仍在增长）；
4. **不写 transcript**：进入与退出都不产生行；
5. 必须能在 **reconnect 后重建同一画面**（纯函数式重绘）。

### 反例边界

| 候选 | 判 | 理由 |
|---|---|---|
| `/theme` 实时预览 | Surface | 预览改的是工作区自身的配色，用户必须看着工作区才能选 |
| `/model` | Surface | 与 `/theme` 同构（B1.2 已定） |
| `/find` 高亮跳转 | Surface | 它就是工作区的滚动，改了 identity 就不对了 |
| inspect | Screen | 有自己的滚动与位置页脚（虽是今天唯一的 Screen） |
| plan dock | 都不是 | 它是 chrome **投影**，不借键盘 |
| completion | 都不是 | composer 的**子区域**（§5.4），不接受"谁先拿键盘"的仲裁 |

## 2.2 分类表

| Feature | Workspace Surface | Dedicated Screen | Hybrid | 理由 |
|---|---|---|---|---|
| ask-user | ✅ | | | 人类动作、答完回原位；摘要由 B0 的 durable fold 负责 |
| approval | ✅ | | | 同上；且已无独立行，弹窗只编辑 tool card 的字段（§5.2） |
| /model | ✅ | | | 环境切换，一次选择，必须回原位 |
| /status | | ✅ | | 只读、多行、不可重建、要能滚动 |
| /usage | | ✅ | | 与 /status 同构；比 footer 更长的窗口历史需要停留期 |
| /diag | | ✅ | | 一次 18 行、要能滚动与复制 |
| /doctor | | | ✅ | 报告=Screen；`--fix` 触发的确认=Surface，且**结束后回到 Screen** |
| /help | | ✅ | | 目录式、53 行、要能滚动；内容可静态生成，无需 durable |
| /subagents | | ✅ | | 列表 + 逐项操作（kill）→ 有自己的导航与动作 |
| setup (onboarding) | | ✅ | | 9 步状态机、全键盘、进入前没有工作区语境 |
| inspect | | ✅ | | 已有 Screen 骨架（tool / reply / subagent / plan 详情） |
| /find（工作区内） | ✅ | | | 高亮 + reveal = 工作区导航 |
| /find --all（跨日志） | | ✅ | | 要读 session log、要结果列表与预览 |
| /clear | — | — | | 它是**视图操作**，不是界面（§12 记录其语义缺口） |

**Hybrid 的定义**：一个命令入口，两条退出路径——"看完就走"（Screen）与"顺手做一个动作"（Screen 内的 Surface）。这要求 Screen 能发起一个 Surface 并等它，且 Surface 结束后**回到 Screen，而不是回到 Workspace**。

## 2.3 Screen 生命周期

### 进入

```
Workspace ──(命令/点击)──▶ Screen
  • workspace 的 paintFrame 不再执行（整帧替换）
  • workspace 的 scrollOffset / focus / draft / search 全部冻结，不清理
  • session 事件继续进 rows（applySessionEvent 与屏幕无关）
  • rows 长度变化 ⇒ 退出时必须重算 window（今天用 lastTranscriptStart = -1 强制全量重画）
```

### 返回

```
Screen ──(Esc / q / 动作完成)──▶ Workspace
  • 重算 window（一次），从 Screen 的最后一帧切回
  • scrollOffset / focus / draft / search 原样恢复（不进 Screen 的导航状态）
  • 不写 transcript（除非 Screen 的动作显式产生了一条叙事，例如 /doctor --fix 的结果）
```

### 四个必答问题

| 问题 | 结论 | 依据与要求 |
|---|---|---|
| **transcript 是否暂停？** | 绘制暂停，**数据不暂停** | `applySessionEvent` 不检查 dialog；因此退出时必须重算窗口，且不能假设"行数没变" |
| **agent 是否继续运行？** | 继续；Screen 不改变 `agent.status` | 只有 `stallsTask(role)`（interaction 且非 confirm）才代表人类被等待。**但**：Screen 打开期间到达的 interaction 必须让用户知道——今天 `queuedQuestions` 已经在 footer 里报，Screen 的页脚必须保留这一格（见 §3.4） |
| **detach / reattach？** | Screen 状态驻留内存，重连后重画同一画面 | 今天 dialog 不丢（行为正确），但 `paintInspectOverlay` 用 `sizeChanged: true` 重画 ⇒ 弱网下每次重连 3 KB。**Screen 的渲染必须是纯函数**：`(state, width, height) → rows`，且支持 `dirtyFrom`（§3.3） |
| **resume？** | Screen **不跨 Host 死亡**；resume 后回到 Workspace，不假装恢复报告 | 报告是"当时的事实"，日志里没有它。可选：把"运行过 /doctor --fix"写一行 durable 记录（artifact 路的入口，B2.3 再定） |

## 2.4 通道分离（关键结构决定）

今天 `openDialog(dialog, role)` 把 inspect（`DEDICATED_ROLE`）、提问、picker 放进**同一个 FIFO 队列**，只用 `surfacePriority` 排序（`dedicated 2 > interaction 1 > picker 0`，`src/dialogs.ts:144`）。这带来三个问题：

1. **语义混装**："整屏替换"和"借用一块像素"在同一个队列里排队，于是"onboarding 后面排着一个 picker"这种组合在结构上被允许；
2. **Screen 内的动作无处安放**：`/doctor --fix` 的确认框应该属于 Doctor Screen 的上下文，排进工作区队列意味着它可能在 Screen 关闭后弹出来；
3. **优先级档位成了谎言**：Screen 不走"谁先拿键盘"的仲裁，它压根不参与仲裁。

**B2 的决定**：

```
状态：
  screen        : ScreenState | undefined     // 至多一个，独占，替换 workspace
  screenSurface : Dialog | undefined          // Screen 内部的动作 Surface（至多一个）
  dialog        : Dialog | undefined          // Workspace 的 Surface（至多一个）
  dialogQueue   : {dialog, role}[]            // 只装 interaction 与 picker

纯函数：
  surfacePriority(role)   // interaction 1 > picker 0（删除 dedicated 档）
  screenOf(kind)          // 判定哪些 dialog 是 Screen
```

不引入 SurfaceManager / OverlayManager / FocusStack：**两个字段 + 两个纯函数**就够，因为"至多一个"这个约束本身就是最强的管理器。

---

# 第三部分 · Report View Model

## 3.1 目标形态

```
/status ─▶ Report Screen ─▶ Esc/q ─▶ Workspace（原位：scrollOffset / focus / draft 不变）
```

Screen 结构复用今天已经验证过的 inspect 骨架：

```
┌ header   : 报告标题 + 生成时间 + 数据来源（provider/session）
│ divider  : ─────
│ body     : 自己的滚动窗口（offset 独立于 transcript）
│ footer   : 位置 x–y/n  ｜ 右侧保留工作区状态格（运行中/有东西在等）★新增
└ hint     : Esc 返回 · ↑↓/PgUp/PgDn 滚动 · 复制键复制全文
```

## 3.2 是否进入 transcript？——**不进入**

按重要性排序的四条理由：

1. **可信度**：报告不可重建（不是 session event）。resume 后它会消失，而它前后的历史还在，用户会得出"历史被吃掉了"的结论。transcript 的价值建立在"这里的东西都还在"。
2. **体积**：`/help` 一次推走窗口起点 **53 行**，`/diag` **18 行**（§1.5 实测）。它们把真正的叙事（用户说了什么、模型做了什么）挤出视野。
3. **成本**：每次报告 = 整屏 clear + 20 行重画（2.9–3.2 KB @100×20）。SSH 弱网下"看一眼状态"不该是一次全屏刷新。
4. **可及性**：报告是"查一下就走"的信息。让它住在滚动历史里，等于把"翻回去找"变成主要交互方式。

**出口保留**：复制键（今天 inspect 已有）、未来 `--save` 落盘（artifact）。**例外**：命令**失败**仍写 `error` 行——错误属于叙事，需要长期可见。

## 3.3 Screen 渲染契约（B2.1 必须先做的一条）

```ts
interface ScreenRenderer {
  (state: ScreenState, width: number, height: number): {
    rows: string[]
    dirtyFrom?: number   // 相对上一帧的脏起点；undefined = 全量
    cursor?: { row: number; column: number }
  }
}
```

要求：

- **默认局部重画**：滚动报告时只有正文区变化，header/footer/hint 不重发；
- **不做无理由的 clear**：`sizeChanged` 只在宽高真的变了时为真；
- **byte budget 继承**：复用 `composePaintFrame` 的 `maxBytes` 与 `paintResume`，弱网下报告滚动按预算分片送达；
- **重连重放**：`onDisplayAttach` 时用同一纯函数重画整屏（一次全量是允许的，因为终端确实空了）。

今天 inspect 违反了其中三点（每帧 `sizeChanged: true`、无 `dirtyFrom`、无预算），B2.1 落地时一并修正。

## 3.4 Screen 的页脚必须保留"工作区还在动"

inspect 今天的页脚只有自己的位置图例。Screen 期间用户看不到 footer，于是**不知道代理是否还在跑、有没有东西在等**。要求：Screen 的页脚右侧固定一格状态（复用 `footerActivity` 的语义：运行中 / 等待回答 / 重试中 / 空闲），宽度不足时优先保它。

---

# 第四部分 · Transcript Representation Model（本轮最重要）

## 4.1 管线

```
Event / Command
      │
      ▼
RepresentationPolicy      ← 纯函数，erery 表示的唯一定义处（新增）
      │
      ▼
Representation            ← A/B/C/D 四类 + durability 标签
      │
      ▼
Renderer                  ← 只负责"怎么画"，不再决定"是否存在"
```

**三条铁律**

1. **renderer 不决定事件是否存在。** 今天 262 处 `pushRow` 就是反例：命令处理器直接构造行，于是"这个信息该不该长期存在"这个决定散落在 262 个地方，没有任何一处能回答。
2. **每个表示必须带 durability 标签**：`durable`（可从 session log 重建）/ `display`（只活在本次 Host 生命周期）/ `live`（每帧重算的尾部）。画面上可以一样，语义上必须可分。
3. **同一语义事件最多一个 transcript 表示 + 任意个 transient 表示。** 今天的 plan 有四重（§5.3），question 有三重（§5.1），都违反这条。

> 旁证：`sawUserInput`（「这个 session 有没有被输入过」）本该由 `user/message` 事件推导，实际由 composer 的提交路径赋值（§12 第 13 条）。**属性归属错位**与表示归属错位是同一个病的两种形态。

## 4.2 四类表示

### A. Persistent Transcript Entry

- 特点：为后续回合提供上下文；用户会翻回去看；resume 必须重建。
- durability：`durable`
- 例：`user` / `assistant` / `reasoning` / `tool`（调用 + 结果摘要）/ `compaction` / `goal` / `prompt` 注入
- 反常成员：`changes` 卡（工作区改动）——它**看起来**是 A，实际是 `display`（源码注释：restarted Host 无法重开）。**这类"伪装成 A 的 display 行"是 B2 要消灭的第一个对象**。

### B. Ephemeral Transient

- 特点：当前需要用户动作或注意力；完成后消失；**不进 transcript**。
- durability：无（layer 状态在内存里）
- 例：interaction layer、picker、completion、live 尾部（streaming / 等待卡）、notice
- 例外：动作的**结果**要留下摘要 → 变成 C。

### C. Summary Entry

- 特点：事件重要，但完整交互不该长期占空间。
- durability：`durable`（从 session log / projection 重建）
- 例：question 的"问 + 答"摘要（B0 已有）、plan 的三行生命周期（§5.3）、审批结果（挂在 tool card 上，§5.2）
- 判据：**"三个月后翻回来，我想看到什么？"** —— 不是完整过程，是一行结论。

### D. Artifact

- 特点：独立对象（有 id、有状态、有详情页），transcript 只引用它。
- durability：取决于存放位置（内存 / 工作区文件 / session log 自定义事件）——**这是 §11 的 open question 之一**
- 例：plan（§5.3）、未来的 report artifact、diff 集
- 引用行形如：`▸ 计划已创建 · 7 项` / `▸ 计划已批准`，可展开/可打开 Screen。

## 4.3 event → representation 决策树

```
1. 它写进 session log 了吗？
     否 → display 类。必须显式标注，且不得伪装成 durable（今天 96 处 system 回声 + changes 卡都在这里）
     是 → 2
2. 它要求人类动作吗？
     是 → B（动作期间，layer）+ C（动作结束后写一行摘要，durable）
     否 → 3
3. 它是可被再次打开的产物吗？（有 id、有状态、有详情）
     是 → D（artifact）+ 一行引用
     否 → 4
4. 它为后续回合提供上下文吗？（对话 / 工具结果 / 错误 / 压缩 / 目标）
     是 → A（durable）
     否 → 不进 transcript（footer 一行 / notice / Screen）
```

## 4.4 durability × 场景矩阵

| 表示 | 写日志 | resume 后 | reconnect 后 | 弱网重画 | 进 transcript |
|---|---|---|---|---|---|
| A Persistent | 是 | **重建** | 局部重画 | 按脏区 | 是 |
| B Transient | 否 | 不重建（layer 消失，卡仍在） | 重画 layer | **只重画 layer**（B1.1/B1.2 已达成） | 否 |
| B' Live（streaming / 等待） | 否（settle 后才写） | 不重建 | 重画尾部 | **当前每帧全清 ← B2.2 要修** | 否（尾部覆盖） |
| C Summary | 是（间接，来自事件） | 重建 | 局部重画 | 按脏区 | 是（一行） |
| D Artifact | 待定 | 取决于存放 | 重画引用行 | 引用行变化才重画 | 只引用行 |

---

# 第五部分 · 具体模型

## 5.1 Ask User Model（需求 §11）

现状管线：`tool/call`（durable）→ `question` 卡（B0 durable fold，带 `callId`/`continued`/`durable`）→ interaction layer（B1.1）→ 答案经 `ctx.userQuestions.answer` 回流 → projection 标 settled。

用户建议的未来形态评估：**合理，但要修两点**。

```
答题前    Transcript : question 摘要（收起态：问句 + 状态）
          Transient  : 答题 UI（layer）
答题后    Transcript : question + answer 摘要（同一行，不新增）
          Transient  : 移除 layer（**不删 transcript 行**）
```

1. **"Transient: remove" 只能指 layer 移除**，不能指行移除。删行会破坏 tail-follow、破坏"我答过什么"的可信度，也会让 B0 的 `continued` 再回答失去锚点。
2. **"question summary" 必须就是 B0 那张 durable 卡**，不是新加的第二行。收起态 = 摘要（问句 + 已答/等待 + 一行答案），展开态 = 选项详情。今天已经基本是这个形态，B2.4 只需要把"收起态的内容"明确定义成契约。

## 5.2 Approval Model（需求 §12）

现状：approval 是 interaction（`ask: 'approval'`），layer 显示工具名 + 理由；footer 说「等待审批」；决定后**没有任何独立 transcript 行**（好）。

**建议：approval 由 tool card 拥有状态。**

```ts
// Row: { kind: 'tool', ... }
approval?: {
  state: 'pending' | 'approved' | 'denied' | 'expired'
  reason: string          // 弹窗里给用户看的那句
  decidedAt?: number
  policy?: string         // 命中哪条策略（auto-allow / reviewer / user）
}
```

理由：

- 审批天然属于**那一次工具调用**（同一 `callId`），是它的一个状态，不是独立事件；
- 收起的 tool card 可以显示 `⏸ 待批准` / `✓ 已批准`，**不弹窗也知道状态**；
- 避免"独立 approval 行"这种把状态当事件的反模式；
- resume：`approval/policy` 事件在 reducer 里已有 case（`tui.ts:6777` 的 `case 'approval/policy'`），可以重建**策略**事实；单次决定若日志没记，就标 `display` 并诚实降级为"未知"。

**结论：不要引入独立 transcript approval 行**（今天也没有，保持并写进契约）。

## 5.3 Plan Model（需求 §13）

### 现状四重表示

| 表示 | 载体 | 生命周期 |
|---|---|---|
| 1. plan 卡 | `Row.kind === 'plan'`（`todos` / `planMarkdown` / `expanded` / `archived`） | 从第一个 `todo_write` 到被归档 |
| 2. plan dock | `paintPlanDock` + `findLivePlanRow`（**同一个对象的第二投影**，不是第二份数据） | 活跃期间钉在 transcript 下方 |
| 3. plan review | `question` 卡（`intent: 'plan-review'`）+ interaction layer | 一次审批动作 |
| 4. 模式状态 | footer「计划模式」/ `/status` 的 plan 字段 / `yieldPlanDock` | 由 harness 的 plan 模式驱动 |

外加两条策略：`archiveStalePlans`（旧计划变灰留在 transcript）、`planNudgeQueued`（收尾提醒，带 `nudged` 防重）。

### 未来：Plan 是 artifact

```
Plan Artifact
  planId, revision, createdAt, updatedAt
  state: draft | reviewing | approved | rejected | completed | abandoned
  todos: [{ id, content, status }]
  body : planMarkdown
  origin: turn / session
```

Transcript 只留三行（D 类引用）：

```
▸ 计划已创建 · 7 项待办
▸ 计划已批准 · 开始执行
▸ 计划已完成 · 7/7
```

- **详情**：点击引用行 → Plan Screen（复用 inspect 骨架：正文 + todo 列表 + 历史状态）；
- **dock**：活跃 plan 的**投影**（今天已经是同一对象，这一点已经对了；B2 只是把投影变成唯一表示，删掉"第二个行对象"的可能）；
- **review interaction**：仍是 interaction（人类动作），但**结果写 artifact 的 state**，不再依赖"重放一行 question"来重建事实；
- **nudge**：属于策略（"回合结束仍有未完成待办 → 提醒一次"），迁进 plan 状态机，与表示无关；
- **`archived` 语义**：变成 artifact 的 `completed/abandoned` 状态，transcript 引用行不再需要折叠态。

**迁移顺序（B2.5）**：① 引入 artifact 对象，让卡与 dock 都从它渲染（行为不变）→ ② 收敛 transcript 为三行引用 → ③ 删旧路径。**本轮不实现。**

## 5.4 Completion Ownership（需求 §14）

**结论：A —— composer 的子区域（Composer child）。**

| 维度 | 分析 |
|---|---|
| 输入 ownership | 焦点不转移。completion 是"建议"，用户继续打字它就过滤；它不"拿键盘"，只是在列表可见时借用 ↑↓（今天 `suggestionsVisible()` 分支已是这个语义） |
| transcript stability | 终局要求：出现/消失**不改变 transcript 窗口**。B1.2 记录了今天的代价（`/m` 打开：20 行 / 2954 B / **有清屏** / window start 移动 4 行） |
| resize | 随 composer 重排；不需要 scroll anchor 语义，只需重排自己的窗口 |
| keyboard | ↑↓ 在"列表可见 且 草稿非空"时归列表；Tab 接受；Esc 关闭。规则集中在 composer 一处，不参与 Surface 仲裁 |

**为什么不选 B（Transient）**：transient 的语义是"覆盖历史、暂时接管、完成后回到原位"——是一个**模态**。completion 不是模态：它不阻塞输入、不需要"完成"、用户常常忽略它继续打字。

**为什么不选 C（Dedicated）**：它与"打字"互斥，而 completion 的存在前提就是"用户正在打字"。

**B2 的落地形态**（B2.2 或独立小项）：completion 与输入行同属 composer 块，边界行在其上（B1.2 已把 completion 放在边界**之下**——方向正确，保持）；composer 块向上生长时**覆盖** transcript 尾部而**不挤压**窗口（与 layer 同源机制）。这样 §1.6 记录的那次清屏也会一并消失。

## 5.5 Surface Priority Future（需求 §15）

今天：`Dedicated > Interaction > Picker > Composer > Transcript`。

评估：这个链条把两种不同的问题混在了一行字里——**"替换"（Dedicated）** 与 **"排队"（Interaction/Picker）**。加入 Report / Setup / Search / Help 之后必须拆开：

```
排他通道（不进队列，至多一个）：
    Screen  >  Workspace
    （Screen 内部另有自己的 Screen-Surface 槽位，与工作区队列隔离）

排队通道（工作区内的 Surface，FIFO + 优先级）：
    Interaction > Picker > （composer 的 completion 不参与）

从不参与仲裁：
    Composer（含 completion） · Footer · Transcript
```

- `surfacePriority` 删除 `dedicated: 2`（它不再是队列成员）；
- 不需要新档位：Report / Setup / Search / Help 全是 Screen，走排他通道；
- **不做 stack**：Screen 深度固定为 1。Screen 想再开一层，就把它做成 Screen 内部的视图（自己管 navigation），而不是再压一层屏幕。

## 5.6 Search Model（需求 §16）

**两级，Hybrid。**

**一级 —— 工作区内跳转（今天已有，保留）**
`/find <q>`：在已加载的 `rows` 上匹配 → 高亮命中行 → `revealRow` 滚动到它 → footer chip `search {index,total}`；`n`/`N` 步进。
它属于 Surface：改的是 `scrollOffset`，不改变 transcript identity。

已知缺口（记录，不在本轮修）：只搜内存 `rows`；`/clear` 之后搜索目标消失（实测 `search hits after clear: 0`）；不搜 session log，因此**搜不到 resume 之前的、已被 `/clear` 或 5000 行上限丢掉的历史**。

**二级 —— 跨日志搜索（新增 Screen）**
`/find --all` 或 `/search`：

```
Query 输入 ─▶ 结果列表（seq / 时间 / 来源 kind / 片段） ─▶ 选中 ─▶ 回 Workspace + revealRow
```

为什么必须是 Screen：要读 session log（几千事件）、要有自己的列表导航与预览、结果本身是**索引**而不是叙事（不该进 transcript）。

## 5.7 Notification Model（需求 §17）

三分法，判据只有一句：**"用户会不会想翻回去找它？"**

| 类 | 例 | 去处 | durability |
|---|---|---|---|
| **A 叙事结果** | 模型回复、工具结果、错误、压缩、目标变化、问答摘要 | transcript | durable / 或显式 display |
| **B 控制平面回声** | 已切换到 X 模型、主题已换、视图已切、通知目标已保存、模式选择已取消 | **footer only**（短 chip，数秒后回落到常规状态） | 无 |
| **C 需要注意但可能不在看** | 重连（第 N 次，离开 m 秒）、离开期间摘要、认证失败、配额告警、**有东西在等** | transcript 一行（display 类，因为它不是 session event）+ 长时间离开走已有 notify 通道 | display |

关键判断：今天 96 处 `system` push 里，**B 类占大多数**。它们每一个都在弱网上换来一次 2.9 KB 的全屏重画，并且稀释 history 的可信度（resume 后消失）。B2.3 的目标就是把它们降级到 footer。

**副作用提醒**：B 类下沉后，"我刚才那条命令成功了吗"只剩 footer 一闪。需要一个可发现性兜底——建议 footer 的 echo chip 保留到**下一次用户输入**为止（而不是定时消失），这样"看得见但不留痕"。

## 5.8 Remote / SSH 硬约束（需求 §18）

每个设计都要能回答四个问题。汇总：

| 设计 | durable？ | reconnect？ | resume？ | repaint？ |
|---|---|---|---|---|
| Surface（layer） | 否 | 状态在内存 → 重画 layer | 消失（卡还在） | **已局部化**（12 行/1.7 KB/无清屏） |
| Live 尾部 | 否 | 重画尾部 | 不重建 | **当前每帧全清（2.9–3.2 KB/tick）← B2.2** |
| Screen | 否 | **必须纯函数重画**；禁止无理由 clear | 回到 Workspace，不假装恢复 | 目标：滚动时只重画正文区 |
| Report artifact（可选） | 取决于落盘 | 重画引用行 | 可恢复（若落盘） | 引用行变化才重画 |
| Plan artifact | 待定（§11 open question） | 重画引用行 + dock | 待定 | 引用行变化才重画 |
| Footer echo | 否 | 重画 footer 两行 | 不重建 | 最便宜（23 B 空帧基线） |
| transcript 追加 | 是 | 局部重画 | 重建 | 追加即 tail-follow（既有规则） |

**两条硬性工程要求**（写进 B2 契约）：

1. **任何新界面默认局部重画**；"全量重画"必须是显式例外（比如重连后的第一帧），不能是默认值（今天 inspect 的默认就是错的）。
2. **任何新界面的状态必须能从内存纯函数地重画出同一画面**——因为 detach/reattach 是这个产品的核心场景，不是边缘情况。

---

# 第六部分 · 与 Claude Code / Codex 类产品比较（需求 §19）

不做复制，只对照它们解决的问题。

| 它们解决的问题 | 做法 | dsh 是否适合 | 原因 |
|---|---|---|---|
| transcript readability | 折叠工具块、diff 着色、长输出摘要 | **适合，且已有** | tool card 合并/折叠、diff 高亮已在；B2 只补"摘要一行"的纪律 |
| interaction clarity | 权限框贴在工具卡上、待批准状态可见 | **适合，建议采纳** | 与 §5.2 的 tool-card-owned approval 完全同构；SSH 下更省一次弹窗往返 |
| artifact separation | todo/plan 作为独立卡片，不塞进对话流 | **适合，但要克制** | dsh 是"离开再回来"，不是"同屏多面板"；plan 做 artifact 可行，但**不做侧栏/多面板** |
| 全屏 alt-buffer 面板 | 整屏 TUI 面板（设置、统计） | **部分不适合** | 断线重连后必须能重建同一画面（成本高）；且 detach 期间面板占屏，用户看不到代理在做什么。dsh 只保留**短停留**的只读 Screen |
| 富交互（hover / 右键 / 拖拽） | 鼠标驱动 UI | **不适合** | 终端档位跨 VTE/tmux/screen/Windows Console/哑终端（`tui-term-probe` 8 档）；鼠标已是尽力而为，不能作为主要交互 |
| 报告回写 transcript（类 `/status` 输出） | 命令输出进历史 | **不适合** | 实测 2.9–3.2 KB/次 + 清屏 + resume 后消失（§1.5） |
| 常驻状态行 / 遥测条 | 底部固定两行 | **已采纳并冻结** | 这正是 B-1/B0 的 footer 两行 |

一句话：**借鉴它们的"信息分级"（什么该折叠、什么该摘要、什么该独立），不借鉴它们的"屏幕数量"与"输入方式"。**

---

# 第七部分 · 最终架构建议（需求 §20）

## 7.1 结构

```
Application
│
├── Workspace Screen（唯一常驻；composer 是它的心脏）
│   │
│   ├── Header            banner · 分隔线 · 已回看 n 行
│   ├── Transcript        A 类叙事 + C 类摘要 + D 类引用行（唯一有 scroll anchor）
│   │     └── Tail block  live：streaming / 等待卡（B2.2 后不再进源行）
│   ├── Plan dock         活跃 plan artifact 的投影（无键盘、无状态）
│   ├── Transient Surface （至多一个）
│   │     ├── Interaction  ask / plan-review / approval / confirm
│   │     └── Picker       model · provider · submodel · effort · mode · view · theme · preset
│   ├── Composer
│   │     ├── Boundary     ╭───  （B1.2 已建立，永不被覆盖）
│   │     ├── Completion   补全列表（composer 子区域，非模态）
│   │     └── Input        草稿 + 光标
│   └── Footer            两行，冻结
│
└── Overlay Screens（至多一个；替换 Workspace；各自带 Screen-Surface 槽位）
      ├── Setup      onboarding 9 步状态机
      ├── Reports    /status /usage /diag /doctor /help /subagents
      ├── Inspect    tool / reply / subagent / plan artifact 详情
      └── Search     跨 session log 的检索（/find --all）
```

## 7.2 模块边界（不引入 SurfaceManager）

| 关注点 | 归属 | 形态 |
|---|---|---|
| 谁拥有键盘 | `screen` / `dialog` / `screenSurface` 三个字段 | 数据，不是对象 |
| 谁先排队 | `surfacePriority(role)` | 纯函数（删 dedicated 档） |
| 这是不是 Screen | `screenOf(kind)` | 纯函数（今天散落 10 处 `kind === 'inspect'` 判断） |
| 这个事件该不该存在 | `representationOf(eventOrCommand)` | **新增纯函数**，B2.3 落地 |
| 像素怎么切 | `paintFrame` 的段模型（B1.1/B1.2 已建立） | 保持 |
| 局部重画 | `dirtyFrom` + `chromeStart` + byte budget | 已存在，Screen 必须复用 |

## 7.3 与今天代码的差距（不做，只记）

1. `screen` 字段不存在：inspect 靠 `dialog?.kind === 'inspect'` 在 10 处特判；
2. `DEDICATED_ROLE` 与 picker 共用队列；
3. `paintInspectOverlay` 每帧 `sizeChanged: true`；
4. 262 处 `pushRow` 没有 policy 层；
5. live 尾部住在源行里。

---

# 第八部分 · Migration Roadmap（需求 §21）

用户建议顺序：B2.1 Reports → B2.2 transcript cleanup → B2.3 plan → B2.4 setup。
**调整**：把 live 尾部（原属 cleanup）拆成独立的 B2.2 提前，理由见下；其余顺序保持。每一步独立可发布、可回滚。

### B2.1 · Dedicated Report Screens（含 Screen 契约）

- **范围**：引入 `screen` 字段与 `screenOf()`；把 `/status` `/usage` `/diag` `/doctor` `/help` `/subagents` 从 `pushRow` 迁到 Report Screen；修 inspect 的渲染契约（`dirtyFrom` + 不做无理由 clear + byte budget）；Screen 页脚右侧保留工作区状态格；Screen 内的动作走 `screenSurface` 槽位。
- **验收**：`/status` 不再改变 `window start`（今天 +1）；不再 clear（今天 2882 B 全清）；Esc 回到原位（scrollOffset/focus/draft 不变）；120/80/72 × 20/12/8 档位下可读可滚动；detach/reattach 后画面一致且只重画一次；line mode 仍走 `echoInspectToLog` 文本路径。
- **回滚**：每条命令一行开关（Screen ↔ pushRow），失败即回退旧行为。

### B2.2 · Live Tail Ownership（唯一"每帧都在花钱"的问题）

- **范围**：把 streaming 文本、streaming reasoning、等待卡、compact burst 从 transcript **源行**移到 transcript **尾部覆盖块**（覆盖最后 N 行、不进 `available` 计算、不移动 `start`）；settle 时再作为 A 类行落进 transcript（今天的行为）。
- **验收**：流式每 tick **无 clear**、脏区从一个尾部起点往下（今天 20 行/2.9–3.2 KB 全清）；回复结束后行内容与今天逐字相同；等待卡的 elapsed 仍逐秒刷新而窗口不动；`live-tail-cache` 的既有用例（"live 块不得写进任何行的缓存"）继续通过。
- **依赖**：无（与 B2.1 并行安全；都只动 `paintFrame` 的段模型）。

### B2.3 · Transcript Representation Policy（原"cleanup"，分两步）

- **B2.3a 标注**（不改行为）：引入 `durability: 'durable' | 'display' | 'live'` 标签，先把 262 处构造点归类；`changes` 卡与所有 B 类回声显式标 `display`；用一个只读断言（测试期）暴露"未标注的新行"。
- **B2.3b 收敛**：B 类回声下沉 footer（保留至下次输入）；`/clear` 语义收敛为"隐藏视图、保留日志"，footer 标注"已隐藏 N 行（日志仍在）"。
- **验收**：`/clear` 后 resume 不再出现"消失了又回来"的矛盾观感；`system` 行构造点数量显著下降且每一处都有标签；resume 前后"哪些行会回来"可由标签预测。
- **风险**：触面最广（262 处）→ 必须拆成 a/b 两步，a 步零行为变化。

### B2.4 · Ask / Approval Representation

- 明确 question 卡的收起态契约（问句 + 状态 + 一行答案）；
- tool card 增加 `approval` 字段，弹窗只编辑它；收起的卡显示 `⏸/✓`；
- 审批策略从 `approval/policy` 事件重建，单次决定缺失时诚实标"未知"。
- **验收**：无独立 approval 行；resume 后审批结果不撒谎；审批期间 footer 语义不变（B0 已测）。

### B2.5 · Plan Artifact

- 引入 artifact 对象；卡与 dock 从它渲染（行为不变）→ 收敛 transcript 为三类引用行 → review 结果写 artifact state → 迁 nudge 策略 → 删 `archived` 旧语义。
- **验收**：同一 plan 在 transcript/dock/Screen 三处读到的 todo 状态一致；resume 后引用行与 dock 一致；删除 artifact 时无悬挂引用。

### B2.6 · Setup Migration

- onboarding 迁到 Screen（9 步状态机 → 每步一个 ScreenRenderer），复用 B2.1 契约；首次启动路径最后动。
- **依赖**：B2.1（Screen 契约）、B2.3a（表示标签）。
- **验收**：9 步全部可走通（含 catalog 加载、Ctrl+F 批量、确认页）；首启动无 workspace 语境时行为与今天一致；中途 detach/reattach 不丢步骤；setup 的确认动作走 `screenSurface`。

---

# 第九部分 · 风险评估（需求 §22）

| 迁移 | 收益 | 风险 | 依赖 | 回滚成本 |
|---|---|---|---|---|
| B2.1 Report Screens | 报告不再污染/清屏；resume 语义一致；Screen 契约成型供后续复用 | Screen 是"另一个画面"，键盘路由与新特判可能重演旧的 10 处特判 → 必须先把 `screenOf()` 抽成纯函数；页脚状态格若被裁掉会让用户以为代理停了 | 无（inspect 骨架已存在） | 低（每命令一个开关） |
| B2.2 Live tail | 消除**每帧**全清（2.9–3.2 KB/tick）；流式在弱网下第一次变得可接受 | 尾部覆盖与 transcript 窗口的交互复杂；settle 瞬间可能有一次窗口变化（需要"提交行"的原子语义）；与 `live-tail-cache` 的行缓存规则必须一致 | 无 | 中（渲染段模型改动，但可回到源行方案） |
| B2.3a 标注 | 让"哪些会回来"可预测；为后续所有收敛提供依据 | 262 处分类是体力活且容易漏（需要断言兜底） | 无 | 低（纯标注） |
| B2.3b 回声下沉 | 弱网成本、history 可信度、可读性 | 用户可能依赖"命令成功"的回声 → 必须保留 footer chip 到下次输入；有回声偏好的用户可能反对 | B2.3a | 中（每条回声一行代码） |
| B2.4 Ask/Approval | 审批状态可见且属于工具；少一次弹窗往返 | `approval/policy` 事件在不同 Host 版本可用性不一，重建可能不完整 → 必须允许"未知" | 无 | 低 |
| B2.5 Plan Artifact | 消灭四重表示；引用行取代大卡；dock 成为唯一投影 | artifact 存放位置（内存/文件/日志）决定 resume 语义，选错会造成新的不一致；review 流程回归风险高 | B2.3a | 中高（涉及 plan review 主流程） |
| B2.6 Setup | 首启动不再是挤压式对话框；步骤状态可重画 | 首启动路径无 workspace 兜底，出错即无法开始使用；9 步状态机边界多 | B2.1 / B2.3a | 高（保留旧路径直到新路径通过全部真 PTY 用例） |

---

# 第十部分 · 必须回答的八个问题（需求 §23）

**1. dsh-ssh-tui 是否应该继续保持 transcript-heavy 设计？**
**是，但要把"heavy"重新定义。** transcript 是唯一 durable、可 resume、可搜索、可复制的表面——在 SSH/长任务/断线重连的场景里，这是产品的核心资产。要改的是**内容纪律**：transcript 只放叙事（用户、模型、工具结果、错误、状态摘要），不放控制平面回声、不放报告正文、不放 live 预览。**transcript-heavy ≠ transcript-everything。**

**2. 哪些信息应该永久进入 history？**
用户输入；模型回复与推理（可折叠）；工具调用的结果摘要（成功/失败/退出码）；工具产生的 diff；失败与诊断（error 行）；压缩（compaction）；目标（goal）状态变化；人类动作的摘要（问答一对、审批结论、计划三行）；重连/离开摘要（display 类，但值得留在叙事里）。

**3. 哪些信息应该永远 ephemeral？**
picker 与任何菜单；completion；审批弹窗本体；transient layer；live 尾部（streaming / 等待卡）；搜索高亮与命中索引；报告正文；footer 状态与 echo；进度动画（flip/burst）。

**4. Plan 是否应该成为 artifact？**
**是。** 它已经有 id 化的所有特征（状态机、多视图、生命周期），唯一缺的是"身份"与"唯一真相"。transcript 保留三类引用行，dock 保留为投影，详情进 Screen。

**5. Completion 是否属于 composer？**
**是，composer 的子区域。** 它不拿键盘（只是在列表可见时借用 ↑↓）、不是模态、不能改变 transcript 窗口；终局要求是出现/消失不动窗口（B1.2 已记录今天的代价）。

**6. Reports 是否应该离开 transcript？**
**是。** 不可重建（resume 后消失）+ 体积（`/help` 53 行）+ 成本（每次 2.9–3.2 KB 全清）+ 可及性（查一下就走）。出口留给复制键与 `--save`。

**7. Dedicated Screen 是否值得引入统一模型？**
**值得，但"统一"指的是契约而不是渲染器**：统一生命周期（进入/返回/重连重放/resume 丢弃）、统一渲染契约（纯函数 + `dirtyFrom` + byte budget + 页脚状态格）、统一键盘归属（Screen 独占，内部动作走 `screenSurface`）。**不统一**的是每个 Screen 的画法（报告、setup、搜索、inspect 各自渲染）。也**不引入** ScreenManager：一个字段 + 一个纯函数即可。

**8. 下一步最值得编码的是哪一个？为什么？**
**B2.1（Report Screens + Screen 渲染契约），紧随 B2.2（live 尾部）。**
理由：① 收益立即可见且可测（报告不再推走窗口、不再清屏、resume 语义不再自相矛盾）；② 风险最低（只读、无新状态机、每条命令可单独回退）；③ 它把 Screen 契约（`dirtyFrom` / 纯函数重画 / 页脚状态格 / Screen 内 Surface 槽位）一次性立起来，B2.5 与 B2.6 直接复用；④ 它顺手修掉今天唯一的 Screen（inspect）的每键全清——那是当前弱网下最贵的交互之一。
**B2.2 紧随**的原因不同：它是唯一一个**每一帧都在花钱**的问题（流式每 tick 整屏清屏），而且它与 B1 的 layer 机制同源，做完 B1.2 之后再动它的边际成本最低。

---

# 第十一部分 · Open Questions（需要裁决）

1. **`/clear` 的语义**：保持"清视图"（日志仍在，resume 会回来）还是改成"清历史"（写日志）？建议前者 + footer 明示"已隐藏 N 行（日志仍在）"。
2. **Report artifact 要不要落盘**（`--save`）？落哪里（工作区 `.dsh/reports/`？session 目录？）。这决定报告能否跨 resume。
3. **Screen 是否保留 composer**？本文建议：Screen 全帧替换，但页脚保留一行工作区状态（运行中 / 等待中）。若用户希望"读报告时也能回一句话"，则需要"半屏 Screen"（保留 composer）——那是另一个设计。
4. **`/find` 是否要读 session log**（跨 `/clear`、跨 resume）？影响 Search Screen 的优先级。
5. **Plan artifact 存放在哪**：内存 / 工作区文件 / session log 自定义事件？决定 resume 后计划是否还在（也决定 B2.5 的实现形态）。
6. **回声开关**：B 类下沉 footer 后，是否需要给"我就想看到每条确认"的用户一个配置项？
7. **Screen 的深度**：本文固定为 1（Screen 内不再压 Screen）。若未来确需"报告里打开一个详情"，是复用 Screen 内部视图，还是允许深度 2？

---

# 第十二部分 · 代码限制记录（本轮发现，**未修**）

按本轮规格的 §2（禁止事项）要求，只记录，不动手。

| # | 限制 | 位置 | 影响 |
|---|---|---|---|
| 1 | inspect Screen 每帧 `sizeChanged: true, chromeStart: 0` → 恒全清 | `tui.ts:4153` | 弱网下每次滚动 = 整屏 2.7 KB |
| 2 | Screen 判断散落：`kind === 'inspect'` 特判 10 处 | `tui.ts` 多处 | 新 Screen 会复制这 10 处 |
| 3 | `DEDICATED_ROLE` 与 picker 共用 `dialogQueue`，`surfacePriority` 混装两类语义 | `tui.ts:8495`、`dialogs.ts:144` | Screen 内动作无处安放 |
| 4 | 262 处 `pushRow` 直接构造行，无 representation policy | `tui.ts` | "该不该存在"无处可回答 |
| 5 | `changes` 卡明确不可重建（`display` 伪装成 durable） | `transcript-types.ts` 注释 | 首个必须标注的对象 |
| 6 | `/clear` 清 `rows` 不清日志 → resume 后"被清掉的历史"回来 | `tui.ts:12775` | 语义不一致 |
| 7 | `/find` 只搜内存 `rows`；`/clear` 后命中清零 | `tui.ts:4550` | 搜索不可靠 |
| 8 | plan 无 id/无 state 机，只有 `active/pending/archived/turnLeftOpen` | `transcript-types.ts` | artifact 化必须先补身份 |
| 9 | live 尾部（streaming/wait/burst）写进 transcript 源行 | `tui.ts:4966` 起 | 每帧全清（§1.6） |
| 10 | line mode 用 `echoInspectToLog` 把 Screen 内容写进 log——同一种信息在两种模式有两种表示 | `tui.ts:4249` | 表示策略必须覆盖 line mode |
| 11 | onboarding 是 dedicated 但仍挤压窗口 | `tui.ts:5325` | "dedicated" 名不副实 |
| 12 | 无 boot splash Screen（启动是三行 transcript） | `tui.ts:2279` | 文档假设与代码不符（已修正） |
| 13 | **reducer 有不可达的重复 `case 'user/message'`**（第二个在 `tui.ts:6781`，职责是 `this.sawUserInput = true`）→ 该标志只由 composer 提交路径（`tui.ts:12595`）设置，**没有从 durable 日志推导** | `tui.ts:6516` / `6781` / `12595`，读取方 `src/index.ts:781` | 今天无可见 bug（`index.ts:781` 用 `config.resume !== true` 兜住了 resume），但这是一颗雷：任何「这个 session 有没有被用过」的新用途（`/cleanup` 的语义正是如此，而且它要判断的是**别的** session）都会答错。**同一类病**：本该由事件推导的属性，挂在了渲染路径上 |

---

# 附录 A · 度量方法

所有数字来自本机 `lib/`（HEAD `a295ee95` 构建产物），在无 TTY 的 headless fixture 上直接驱动 `tui.paint()` 并捕获 `tui.write` 的字节：

```js
// rows 被寻址的行号 / bytes 实际写入字节 / clear 是否出现 \x1b[H\x1b[J 或 \x1b[2J
function wire(tui, cols, rows) {
  const w = []
  const real = tui.write.bind(tui)
  tui.write = c => { w.push(c); real(c) }
  process.stdout.columns = cols; process.stdout.rows = rows
  tui.paint()
  tui.write = real
  const s = w.join('')
  return {
    rows: [...s.matchAll(/\u001b\[(\d+);1H/gu)].map(m => Number(m[1])),
    clear: /\u001b\[[HJ]|\u001b\[2J/u.test(s),
    bytes: Buffer.byteLength(s),
  }
}
```

- 会话 fixture：200 行交替 `assistant`/`user`，100×20（`/status` `/diag` `/help` 用 200 行；inspect 用 60 行 + 一张 300 行输出的 tool card）。
- transient 对比数据来自 B1.1/B1.2 的既有度量（120×30 与 100×20），口径相同。
- 真 PTY 数据来自 `scripts/tui-probe.mjs`（`/dialog-test` 6c、`/view` 6d）。

# 附录 B · 与既有文档的关系

- `docs/checkpoints.md`：B0 / B1.1 / B1.2 的实现记录与变异结果（本文的事实基线）。
- `docs/plans/footer-debt.md`：footer 两行的冻结与降级梯度（B2 中 footer 仍不动，只增加"echo 保留到下次输入"这一条待议项）。
- `docs/plans/workspace-changes.md`：`changes` 卡的来源与不可重建性（§4.2 A 类反常成员的依据）。
- 本文：B2 的语义冻结；实现顺序见 §八。
