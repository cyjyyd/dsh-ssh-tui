# B2 架构决策记录（Architecture Decision Record）

> **状态**：FROZEN — 本文件冻结 B2 阶段的语义边界；实现顺序见 §14。
> **范围**：只写文档。本轮不改 production code、不改 tests、不进入 B2.1。
> **前序文档**：
> - `docs/plans/b2-architecture-plan.md` — B2 规划（分析、度量、候选方案）
> - `docs/checkpoints.md` — B0 / B1.1 / B1.2 的实现记录与变异结果（本文件的事实基线）
>
> **核心原则**：B0–B1 冻结 *where things are drawn*；B2 冻结 *what deserves to exist*。
> 本文件的每一条决策都有稳定编号（`AD-n`），后续轮次以编号引用，不再改语义。

---

## 0. 决策总览

| ID | 决策 | 归属阶段 |
|---|---|---|
| AD-1 | Screen 与 Surface 是两个概念；各自生命周期、键盘归属、像素归属不同 | B2.1 |
| AD-2 | Screen depth = 1；Screen 内部可以有 tabs / sections / detail，但不得 Screen push Screen | B2.1 |
| AD-3 | Screen 与 Surface 走两条独立通道，不共用队列；不引入 SurfaceManager / OverlayManager / FocusStack | B2.1 |
| AD-4 | `/clear` 只是 presentation operation；不触碰 session log / agent context / artifacts / durable events | B2.3b |
| AD-5 | 取消 `/reset` 方向；长期会话管理走 Context Lifecycle / Pruning | 未来 |
| AD-6 | Context segment 以 user turn 为 candidate boundary；Active → Compressed → Archived → Deleted；默认不自动删、不 destructive prune | 未来 |
| AD-7 | 报告类命令默认进 Dedicated Screen，不进 transcript；默认 ephemeral，不自动落盘 | B2.1 |
| AD-8 | Dedicated Screen 不保留普通聊天 composer；保留 compact global runtime/status strip | B2.1 |
| AD-9 | Search 两级：local `/find` = Workspace Surface；历史搜索 = Dedicated Search Screen | B2.1 / 未来 |
| AD-10 | Renderer does not decide existence；Event/Command → Representation Policy → Representation → Renderer | B2.3a |
| AD-11 | 同一 semantic event 最多一个 primary transcript representation；表示分 A/B/C/D 四类并带 durability 标签 | B2.3a |
| AD-12 | 实时变化（streaming / tool running / reconnecting / waiting）默认不进 transcript，进 runtime-live layer 或 footer | B2.2 |
| AD-13 | Narrative / causal → transcript；Runtime state → footer；Immediate action feedback → ephemeral notice；Operational warning → footer / notice / OS notification，只有影响未来因果理解时才留 transcript summary | B2.3b |
| AD-14 | Approval 不拥有独立 transcript identity；它是所属 Tool representation 的状态 | B2.4 |
| AD-15 | Plan 是 Artifact；artifact = durable session events 的 projection，不是第二套持久化 | B2.5 |
| AD-16 | Completion 属于 Composer 子区域；其挤压 transcript 是 Composer layout debt，不在 B2.1 处理 | 未来 |
| AD-17 | Remote-first invariants：任何新 Screen / Surface 默认必须满足六条 | 全部 |
| AD-18 | B2 roadmap 与阶段边界（B2.1 → B2.6） | — |

---

## 1. Screen / Surface（AD-1 / AD-2 / AD-3）

### 1.1 Surface（借用）

必须**全部**满足：

- 仍属于当前 workspace；
- 用户完成后**回到原上下文**：`scrollOffset`、focus、composer 草稿、search 位置都不变；
- **不改变 transcript identity**（不增减 source rows、不改变窗口几何）；
- 生命周期 = 一次动作（answer / choose / cancel / preview）；
- 没有自己的导航语义（不拥有滚动、翻页、搜索）。

**用于**：ask-user、approval、picker（model / provider / submodel / effort / mode / view / theme / preset）。

### 1.2 Screen（替换）

- 独立工作模式；
- 有**自己的**导航 / scroll / state；
- **不进入 transcript**（进入与退出都不产生行）；
- **必须能纯函数重画**：`(state, width, height) → rows`，且 detach/reattach 后能重建同一视觉状态。

**用于**：reports（`/status` `/usage` `/diag` `/doctor` `/help` `/subagents`）、inspect（tool / reply / subagent / plan 详情）、setup（onboarding）、未来的 historical search。

### 1.3 判据（一句话）

> **"用户是在工作区里被问了一句，还是离开了工作区？"**

### 1.4 Screen depth = 1（FROZEN）

- 任意时刻**至多一个** Screen，**独占**主视图；
- Screen **内部**可以有 tabs / sections / detail mode（由该 Screen 自己管理自己的状态）；
- **不允许** Screen push Screen（没有屏幕栈、没有深度 2）；
- "在报告里打开一个详情" = 该 Screen 内部的 detail mode，而不是第二层屏幕。

### 1.5 通道分离

```
排他通道：  Screen  >  Workspace            （至多一个，替换而非叠加）
Screen 内部： screenSurface                 （Screen 自己的动作 Surface，与工作区队列隔离）
工作区队列： Interaction > Picker            （FIFO + 优先级；至多一个活动）
不参与仲裁： Composer（含 completion）· Footer · Transcript
```

- **活动 Surface 永不被替换**（B1.2 的 M4 变异已证明抢占会丢掉一个正在等待人类的 promise）；
- 优先级只决定**排队顺序**，同级保持到达顺序；
- **不引入** SurfaceManager / OverlayManager / FocusStack。"至多一个"这个约束本身就是最强的管理器。

### 1.6 今天的事实（只记录，不在本轮修）

| 现状 | 位置 |
|---|---|
| `DEDICATED_ROLE` 与 picker **共用** `dialogQueue`，只靠 `surfacePriority` 排序 | `src/tui.ts:8495`、`src/dialogs.ts:144` |
| Screen 判断散落：`kind === 'inspect'` 特判 **10 处** | `src/tui.ts` 多处 |
| 唯一的真实 Screen（inspect）每帧 `sizeChanged: true, chromeStart: 0` → 恒全清 | `paintInspectOverlay` `src/tui.ts:4109`，参数在 `:4153` |
| onboarding 挂 `DEDICATED_ROLE` 却**仍挤压** transcript 窗口 | `src/tui.ts:5325` |
| 代码里没有 boot splash Screen：启动是三行 transcript | `src/tui.ts:2279` |

---

## 2. `/clear`（AD-4）

### 2.1 冻结语义

**`/clear` 只是 presentation operation。**

它可以：

- 隐藏当前可见的 transcript；
- 为**当前 Host**设置一个 **view cutoff**。

它**绝不**修改：

- session log（一个字节都不写、不删）；
- agent context（模型看到的东西不变）；
- artifacts；
- durable events。

**执行后必须明确告知用户**：

> 「只清理显示，历史和模型上下文仍保留。」

**不要设计 destructive reset。** 不存在"清空一切"的入口；需要销毁历史时，那是 Context Lifecycle 的显式、可预览、可恢复的操作（§3），不是 `/clear`。

### 2.2 今天的事实

- 实现是 `this.rows.length = 0`（`src/tui.ts:12775`）——**内存行数组被丢弃**，日志未动；
- notice 文案已接近正确语义：「转录已清空。子代理、计划与提问卡片会在新事件到达时重新出现。」（`src/i18n/zh.ts:729`）；
- 因此 **resume 后被清掉的历史回来** —— 在 AD-4 之下这是**预期行为**，不是 bug；
- 真正的缺口是：① 没有 cutoff 概念（Host 内无法回到被清理前的位置）；② 文案没有说明"历史与模型上下文仍保留"。

### 2.3 推论（写入契约）

- **cutoff 是 Host 内存态**，不写日志；resume 后历史重新可见（预期）；
- `/clear` **不影响** `searchHits` 之外的工作区状态：focus / draft / scrollOffset 必须被明确处理（今天 focus 与 search 被重置）；
- 历史搜索（AD-9 的 Search Screen）读的是 **durable session log**，因此**可以跨 `/clear`**。

---

## 3. Context Lifecycle（AD-5 / AD-6）

### 3.1 取消 `/reset`

**正式取消 `/reset` 方向。** 未来长期会话管理使用 **Context Lifecycle / Pruning**。

事实：`/reset` **从未作为命令存在**于本插件（`src/commands.ts` 无此条目；`reset` 只作为思考强度的别名词出现在 `src/tui.ts:1413` / `:9655`）。因此这是一次**规划方向**的取消，不是已有功能的移除。

### 3.2 Segment 模型（第一版语义）

- 每个 **user turn 开启一个 candidate context segment**；
- 直到**下一个 user turn 之前**的 assistant / tool / result / artifact references 默认归属这个**候选段**；
- **user turn 只是 candidate boundary，不保证每条用户输入最终独立成段**（短促的连续追问、被合并的回合、工具回合都会并入相邻段）。

### 3.3 生命周期

```
Active ──▶ Compressed ──▶ Archived ──▶ Deleted
```

**默认**：

- 不自动删除；
- 不自动 destructive prune；
- 由用户主动操作；
- 可预览；
- **优先可恢复**。

### 3.4 UX 词汇（未来，不是现在）

`/context`（看状态与段边界）、`/compact`（压缩）、`/archive`（归档）、`/restore`（恢复）。

事实：`/compact` **已存在**，且是 **host 命令**（不在 `src/commands.ts` 的 `LOCAL_COMMANDS`；走 `default:` 分支转发给 host）。因此 Context Lifecycle 的词汇是**在既有 host 能力上加语义**，而不是另起一套压缩机制。

### 3.5 本轮不实现

不写代码、不定存储格式、不设计界面。此节冻结的是**方向与默认值**：任何"自动清理/自动删除"的设计都与 AD-6 冲突。

---

## 4. Report policy（AD-7）

### 4.1 冻结

以下命令**默认进入 Dedicated Screen**，**不进入 transcript**：

`/status`、`/usage`、`/diag`、`/doctor`、`/help`、`/subagents`。

- Report **默认 ephemeral**，**不自动落盘**；
- 未来允许**显式** `export` / `--save <path>`；
- 命令**失败**仍写 `error` 行（错误属于叙事，需要长期可见）。

### 4.2 理由（实测，100×20，200 行会话）

| 命令 | 地址行 | 字节 | 清屏 | window start 位移 |
|---|---|---|---|---|
| `/status` | 20 | 2882 | YES | +1 |
| `/diag` | 20 | 3049 | YES | +18 |
| `/help` | 20 | 3244 | YES | **+53** |

三条独立理由：**不可重建**（不是 session event → resume 后消失 → "历史被吃掉了"的结论）、**体积**（把叙事挤出视野）、**成本**（每次整屏 clear，弱网下"看一眼状态"不该是全屏刷新）。

### 4.3 Screen 的强制契约（B2.1）

1. **纯函数重画**：`(state, width, height) → rows`；不得有只活在 renderer 里的隐藏状态；
2. **默认局部重画**：滚动报告时只有正文区变化（`dirtyFrom`）；**不做无理由的 full-screen clear**（今天 inspect 违反此条）；
3. **继承 byte budget**：复用 `composePaintFrame` 的 `maxBytes` / `paintResume`，弱网分片送达；
4. **页脚保留工作区状态**（见 §5）；
5. 退出后工作区**原位恢复**（scrollOffset / focus / draft / search 不变）；
6. **line mode** 保持文本路径（`echoInspectToLog`），不引入 ANSI overlay。

---

## 5. Screen composer policy（AD-8）

### 5.1 冻结

- Dedicated Screen **默认不保留普通聊天 composer**：Screen 独占主视图。
- **保留 compact global runtime/status strip**，使用户在 Screen 内仍能看到例如：
  - agent 是否仍在运行；
  - SSH / link 状态；
  - quota / context 等关键状态。
- Screen 自己可以有**底部操作提示**，或发起一个 **Screen 内 Surface**（`screenSurface`）。

**具体显示内容留 B2.1 决定**（见 §17 Deferred · DF-1）。

### 5.2 要求（不是建议）

Screen 期间用户看不到 footer 两行，因此：

- 该 strip 必须能回答"**代理还在跑吗**"与"**有没有东西在等**"（复用 B0 的 `footerActivity` / `queuedQuestions` 语义）；
- 宽度不足时**优先保该 strip**，再裁 Screen 自己的提示行。

---

## 6. Search（AD-9）

### 6.1 两级模型（FROZEN）

**Local `/find`**

- 属 **Workspace Surface**；
- 搜**当前可见 / 当前 workspace transcript**；
- 改变的是 `scrollOffset`（reveal 到命中行）+ footer 的 `search {index,total}` chip；
- 不改变 transcript identity。

**Future historical search**

- 属 **Dedicated Search Screen**；
- 可以读 **durable session log**；
- **可以跨 `/clear`**（因为读的是 log，不是内存行）与 **跨 resume**；
- 结果是**索引**（seq / 时间 / 来源 / 片段），本身不是叙事 → 不进 transcript。

### 6.2 今天的事实

`/find` 只搜内存 `rows`（`runFindCommand`，`src/tui.ts:4550`）；`/clear` 之后命中清零（实测 `search hits after clear: 0`）；不读 session log。Local 语义在 AD-4 之下仍然自洽（cutoff 之后不可见即不搜），但**用户需要知道这个边界**：Screen 版才跨 `/clear`。

---

## 7. Representation policy（AD-10 / AD-11）

### 7.1 核心原则（FROZEN）

> **Renderer does not decide existence.**

```
Event / Command
      │
      ▼
Representation Policy      ← 纯函数：唯一的"该不该存在"决定处
      │
      ▼
Representation             ← A / B / C / D + durability 标签
      │
      ▼
Renderer                   ← 只回答"怎么画"
```

### 7.2 唯一性

**同一 semantic event 最多一个 primary transcript representation**（可以有任意个 transient representation）。

### 7.3 四类表示

| 类 | 名称 | 特点 | durability | 例 |
|---|---|---|---|---|
| **A** | Persistent Transcript Entry | 长期可见；为后续回合提供上下文 | `durable`（可从 session log 重建） | user / assistant / reasoning / tool 结果摘要 / error / compaction / goal |
| **B** | Ephemeral Transient | 当前需要动作或注意力，完成后消失 | 无 | interaction layer、picker、completion、ephemeral notice |
| **C** | Summary Entry | 事件重要，但完整交互不长期占空间 | `durable` | question 的"问 + 答"摘要、审批结论、plan 的三行生命周期 |
| **D** | Artifact | 独立对象（有 id / 状态 / 详情）；transcript 只**引用** | 取决于 projection 源（见 AD-15） | plan、未来的 report artifact |

### 7.4 durability / display / live 语义

每个表示必须能回答三个问题：

- **durable**：能否只从 session log 重建？（resume 后必须一致）
- **display**：是否只活在本次 Host 生命周期？（resume 后消失是**正确的**，但必须显式标注，不得伪装成 durable）
- **live**：是否每帧重算？（不得写进任何 source row，不得占用窗口几何——见 AD-12）

**判据**：resume 前后"哪些行会回来"，必须能由标签**预测**，而不是靠经验或文档记忆。

### 7.5 今天的事实

- `this.pushRow(` **262 处**（单行 `kind: 'system'` 96 处、`kind: 'error'` 90 处；按跨行统计 system 140、error 101）；
- `Row` 联合类型 **16 种**（`src/transcript-types.ts:33`）；
- **没有** policy 层：每个调用点各自决定"这条信息要不要长期存在"；
- 反例（伪装成 durable 的 display）：`changes` 卡（源码注释明确"a restarted Host cannot reopen it"）；
- 旁证（同类病、属性归属错位）：`sawUserInput` 本该由 `user/message` 事件推导，实际只由 composer 提交路径赋值（见 §14 B2.3a）。

---

## 8. Runtime state（AD-12）

### 8.1 冻结

**实时变化默认不进入 transcript。** 例如：

- streaming（正文 / 推理）；
- tool running；
- reconnecting；
- waiting（等待回答 / 等待审批的**活动**状态）。

它们应进入 **runtime / live layer** 或 **footer**，而不是**不断制造 source rows**。

### 8.2 为什么这条是 B2.2 的契约

实测（100×20，200 行会话，流式回复）：

```
stream tick 1   rows 20  bytes 2925  clear YES  start 213
stream tick 2   rows 20  bytes 2972  clear YES  start 214
stream tick 3   rows 20  bytes 3019  clear YES  start 215
stream tick 4   rows 20  bytes 3066  clear YES  start 216
stream tick 5   rows 20  bytes 3113  clear YES  start 217
stream tick 6   rows 20  bytes 3160  clear YES  start 218
stream settled  rows 20  bytes 2884  clear YES  start 212
```

原因链：streaming 文本与等待卡是**源行**（`src/tui.ts:4966` 起 `addDisplay`）→ `lines.length` +1 → `start` +1 → `transcriptScrolled` → `sizeChanged` → `\x1b[H\x1b[J` + 全量重画。

**即：今天 TUI 最贵的行为不是弹窗，而是模型正在说话。**

### 8.3 契约（B2.2）

- live 内容**不占用** transcript 的 `available` 计算，**不移动** `start`；
- settle 时**一次性提交**为一条 A 类行（内容是权威的 durable 文本）；
- 等待卡的 elapsed 可以逐秒刷新而窗口不动；
- detach/reattach 后 live 层可重建（deterministic redraw）。

---

## 9. Notification policy（AD-13）

### 9.1 分流表（FROZEN）

| 类型 | 去处 | 例 |
|---|---|---|
| **Narrative / causal event** | transcript | 用户输入、模型回复、工具结果、错误、压缩、目标变化 |
| **Runtime state** | footer | streaming、tool running、reconnecting、waiting、重试 |
| **Immediate action feedback** | ephemeral notice | "Model switched"、"Copied"、"主题已切换" |
| **Operational warning** | footer / notice / OS notification | 链路劣化、配额告警、认证失败 |
| **Operational warning（只在此情形留 transcript）** | transcript **summary** | **只有当它会影响未来任务的因果理解时** |

### 9.2 判据示例（FROZEN）

- `Model switched` → **不需要**永久 transcript；
- `Copied` → **不需要** transcript；
- **SSH 断线导致 tool outcome unknown** → **可以**留下 durable causal summary（因为它改变了"这次工具到底做了什么"的因果理解，后续回合必须能读到）。

### 9.3 今天的事实

96 处单行 `system` push 中，多数属于 immediate action feedback（B 类）。它们每一个都在弱网上换来一次报告级重画，并且稀释 history 的可信度（resume 后消失）。

**副作用提醒（B2.3b 必须处理）**：回声下沉后，"我刚才那条命令成功了吗"只剩 footer 一闪 → 建议 footer 的 echo chip 保留到**下一次用户输入**为止（而不是定时消失）：看得见，但不留痕。

---

## 10. Approval（AD-14）

### 10.1 冻结

**Approval 不拥有独立 transcript identity。** 它属于对应 Tool representation 的**状态**：

```
waiting approval  |  approved  |  rejected  |  unknown
```

**不要额外制造永久 approval row**，除非事件本身具有独立因果价值（该判定的分类留在 B2.4，见 §17 Deferred · DF-5）。

### 10.2 目标形态

```ts
// Row: { kind: 'tool', ... }
approval?: {
  state: 'waiting' | 'approved' | 'rejected' | 'unknown'
  reason: string
  decidedAt?: number
  policy?: string
}
```

- 收起的 tool card 直接显示状态（`⏸ 待批准` / `✓ 已批准`），**不弹窗也知道状态**；
- 弹窗只是**编辑**这个状态的 Surface；
- resume：`approval/policy` 事件可重建**策略**事实；单次决定若日志未记，标 `display` 并诚实降级为 **unknown**（**不得**假装 approved）。

### 10.3 今天的事实

今天 approval 是 interaction（`ask: 'approval'`），layer 显示工具名 + 理由，footer 说「等待审批」，决定后**没有独立 transcript 行**（已符合 AD-14 的方向）。缺口：tool card 上没有 `approval` 字段，因此收起态无法显示审批状态。

---

## 11. Plan Artifact（AD-15）

### 11.1 冻结

- **Plan 是 Artifact，不是普通 transcript row。**
- **但"Artifact"不等于新增第二套持久化文件。**

优先模型：

```
durable Harness session events
      │
      ▼
Plan projection            ← 重建（无第二 truth source）
      │
      ▼
Plan Artifact view
      │
      ├── transcript 引用行
      ├── dock（活跃 plan 的投影）
      └── review interaction
```

**transcript / dock / review 都只是 projection。**

### 11.2 B2.5 开工前**必须**先审计

审计对象：`plan/mode`、`todo/write`、review / approval / progress 等 durable events **是否足以重建完整生命周期**（draft → reviewing → approved/rejected → completed）。

**只有存在真实缺口时才考虑新增 durable persistence。禁止先创建第二套 truth source。**

### 11.3 本轮的只读预审（已完成的读代码结论，供 B2.5 使用）

**今天实际消费的 durable 来源（4 个）**：

| 来源 | 事件 / 载体 | 消费点 |
|---|---|---|
| 计划模式进出 | `plan/mode { active }` | `src/tui.ts:7025`（主会话）、`:7504`（子代理日志） |
| 待办内容与修订 | `todo/write { todos }` | `src/tui.ts:7037` |
| 计划评审请求 | `ask_user_question` 工具调用的 `intent.kind === 'plan-review'` + `detail`（计划正文） | `planReviewOf`，`src/tool-present.ts:298` |
| 评审结论 | 上述调用的**工具结果**（选中的选项） | 工具卡 / 结果归并路径 |

**已识别的真实缺口（属于"身份与归因"，不属于"原始数据不足"）**：

1. **没有 plan identity**：没有任何东西给一份计划命名。今天的行选择靠启发式 —— `upsertPlanRow` 找"当前 live 行"（`planIsLive`），`archiveStalePlans` 按显示顺序把旧的标灰。**同一会话里两份计划只能靠顺序区分**。
2. **没有 revision 关联**：某次 `todo/write` 与批准它的那次 review **没有引用关系**，"被批准的是哪一版"无法回答。
3. **没有显式的 decision / completion 事件**：`approved` / `rejected` 需从工具结果的选中项**推断**；`completed` / `abandoned` 需从 todo 状态**推断**；`pending`（模式切换中）也是推断。
4. **plan review 的"身份"在 replay 时被丢弃**（本轮实测，见下）：这不是数据缺口，而是**解析器缺口** —— durable 的工具调用参数里**有** `intent`，但 TUI 自己的解析器丢掉了它。

#### 11.3.1 第 4 项缺口的实测证据（只读探针，未改代码）

```
1) parser keeps `intent` from the durable args?   false
   keys the parser keeps: id, question, header, detail, options
2) replayed card  intent: "ask" | title: "Approve this plan and leave plan mode?"
   detail survived: true | options survived: 2
   → reconstructed as: ORDINARY QUESTION
3) resume frame shows:
        ▸ ● 提问用户  Approve this plan and leave plan mode?  [running…]
        ▸ ● 提问用户 ⠧ · 等待回答 · Approve this plan and leave plan mode? · Enter 展开
```

- 解析器是 `askQuestions()`（`src/plan.ts:409`）：它只保留 `id / question / header / detail / options / multiSelect`，**不保留 `intent`**；
- 计划评审卡的意图来自 `planReviewOf(question)`（`src/tool-present.ts:298`：`intent?.kind === 'plan-review' && detail !== ''`），在**实时**请求上成立（`tests/helpers.test.mjs:4445` 断言过），在**重放**的卡上恒为假；
- 后果是**用户可见的**：resume 之后，一次计划评审显示成普通的「提问用户」，评审标题与意图丢失（`detail` 与 `options` 仍在，因此过程看起来"像"但不"是"）。

**结论**：完整生命周期**可以近似重建，但无法归因**（无 id / 无 revision / 无显式转移），并且**其中的 review 阶段在 replay 后连身份都不保**。B2.5 的第一件事就是确认这份判断，并区分两类修法：

- **projection 修法**（优先，符合 AD-15）：让解析器保留 durable args 里已有的 `intent`，并给计划补一个可由事件推导的身份/修订号；
- **新增 durable 事件**（仅当 projection 确实无法归因时）：不得作为第一步，**更不得先建第二套 truth source**。

---

## 12. Completion（AD-16）

### 12.1 冻结

**Slash completion / autocomplete 属于 Composer 子区域。**

- **不是** Transient Layer；
- **不是** Dedicated Screen；
- 不参与 Surface 优先级仲裁。

未来 Composer 可以包含：input、completion、history / search assistance。

### 12.2 理由

| 维度 | 结论 |
|---|---|
| 输入 ownership | 焦点不转移。completion 是**建议**：用户继续打字它就过滤，不"拿键盘"，只在列表可见时借用 ↑↓ |
| 模态性 | 不是模态。它不阻塞输入、不需要"完成"、用户常常忽略它继续打字 |
| 与 transient 的区别 | transient 的语义是"覆盖历史、暂时接管、完成后回原位"——completion 不满足任何一条 |
| 与 dedicated 的区别 | 它与"正在打字"互斥，而 completion 的存在前提**就是**用户正在打字 |

### 12.3 Composer layout debt（记录，不在 B2.1 处理）

**现状**：completion 渲染在 composer 边界**之下**（`suggestionLines`），出现/消失会挤压 transcript：实测 `/m` 打开补全 = **20 行 / 2954 B / 有清屏 / window start 移动 4 行**。

**归属**：这是 **Composer layout debt**，**不在 B2.1 处理**。终局形态是 composer 块向上生长时**覆盖** transcript 尾部而不挤压窗口（与 layer 同源机制）。

---

## 13. Remote-first invariants（AD-17）

**任何新 Screen / Surface 默认必须满足**（违反即视为缺陷，而不是优化项）：

1. **deterministic redraw** —— 同一状态在同样宽高下必须画出同样的行；
2. **detach / reattach 可恢复同一视觉状态**；
3. **no unexplained full-screen clear** —— 全屏 clear 只能是显式例外（例如重连后的第一帧）；
4. **local repaint preferred** —— 默认只重画变化区域，并遵守 link 的 byte budget；
5. **no hidden state only living in renderer** —— 状态必须能由纯函数重画（禁止"只存在于画里的状态"）；
6. **Host / display lifecycle 不因 UI 重构受破坏** —— 不改 `display-sock.ts` 的 attach / detach / handshake 语义，不改会话锁与 relay 行为。

**为什么这是硬约束**：dsh-ssh-tui 的核心场景是长任务 + 弱网 + detach + reconnect。断线重连不是边缘情况，是主路径。

---

## 14. B2 roadmap（AD-18，FROZEN）

| 阶段 | 内容 | 完成判据（最低） |
|---|---|---|
| **B2.1** | **Screen Contract + Report Screens**；用 **inspect 验证** Screen renderer / incremental redraw | 报告不再改变 `window start`、不再 clear；Esc 回原位；detach/reattach 重画一致且不重复全清；inspect 滚动只重画正文区 |
| **B2.2** | **Live Tail Ownership** | 流式每 tick **无 clear**、脏区从尾部起点往下；settle 后与今天逐字相同；等待卡刷新不动窗口 |
| **B2.3a** | **Representation metadata + correctness preflight** | 每条表示带 durability 标签；**审计并修复重复不可达的 `case 'user/message'`**（`src/tui.ts:6781`；`sawUserInput` 现仅由 `src/tui.ts:12595` 设置，读取方 `src/index.ts:781`） |
| **B2.3b** | **control-plane echo 下沉 + `/clear` semantics** | 回声只进 footer（保留到下次输入）；`/clear` 是 presentation operation 且有明确告知；`/find` 的可见边界被说明 |
| **B2.4** | **Ask / Approval representation cleanup** | question 收起态契约（问 + 状态 + 一行答案）；tool card 拥有 `approval` 字段且可显示；无独立 approval row；不确定性用 `unknown` 表达 |
| **B2.5** | **Plan Artifact projection** | §11.3 的审计结论落地；identity / revision / 显式转移的缺口被解决（优先 projection）；transcript 只留引用行；**无第二 truth source** |
| **B2.6** | **Setup migration** | 9 步状态机在 Screen 契约下走通；中途 detach/reattach 不丢步骤；保留旧路径直到真 PTY 全绿 |

**阶段纪律**：

- 每个阶段独立可发布、可回滚；
- 不做跨阶段的"顺手重构"（B2.3a 的重复 case 修复是**明确列入**的例外）；
- 任何阶段都不得引入 §15 非目标中的结构。

---

## 15. Non-goals（本轮与 B2 的非目标）

本轮不做：

- production code changes；
- SurfaceManager / OverlayManager / FocusStack；
- reset command；
- automatic context pruning；
- automatic deletion；
- Plan persistence implementation；
- Report Screen implementation；
- Live Tail implementation。

---

## 16. Locked decisions

以下项目**已冻结**，后续轮次以其编号引用，不再讨论语义（只讨论实现）：

1. **AD-1** Screen 与 Surface 是两个概念；ask-user / approval / picker 是 Surface；reports / inspect / setup / historical search 是 Screen。
2. **AD-2** Screen depth = 1；Screen 内可有 tabs / sections / detail mode；禁止 Screen push Screen。
3. **AD-3** 两条独立通道（排他通道 vs 工作区队列）+ Screen 内部 `screenSurface`；活动 Surface 永不被替换；**不引入** SurfaceManager / OverlayManager / FocusStack。
4. **AD-4** `/clear` 是 presentation operation；不触碰 session log / agent context / artifacts / durable events；必须有"历史与模型上下文仍保留"的告知；**没有** destructive reset。
5. **AD-5** 取消 `/reset` 方向（该命令在本插件从未存在）。
6. **AD-6** Context segment：user turn = candidate boundary（不保证独立成段）；Active → Compressed → Archived → Deleted；默认不自动删除、不 destructive prune、用户主动、可预览、优先可恢复。
7. **AD-7** `/status` `/usage` `/diag` `/doctor` `/help` `/subagents` 默认进 Screen、不进 transcript、默认 ephemeral 不自动落盘；未来允许显式 `--save`；命令失败仍写 error 行。
8. **AD-8** Screen 不保留普通聊天 composer；保留 compact global runtime/status strip（至少能答"还在跑吗 / 有没有在等"）；strip 优先于 Screen 自身提示行。
9. **AD-9** Search 两级：local `/find` = Workspace Surface（当前可见 transcript）；historical search = Dedicated Search Screen（可读 durable log、可跨 `/clear` 与 resume、结果是索引不进 transcript）。
10. **AD-10** Renderer does not decide existence；Representation Policy 是唯一的"该不该存在"决定处。
11. **AD-11** 同一 semantic event 最多一个 primary transcript representation；表示分 A/B/C/D 四类并带 durability 标签；durable / display / live 必须可分且可预测。
12. **AD-12** 实时变化默认不进 transcript，进 runtime-live layer 或 footer；live 内容不占用窗口几何、不移动 `start`；settle 时一次性提交为 A 类行。
13. **AD-13** Narrative / causal → transcript；runtime state → footer；immediate action feedback → ephemeral notice；operational warning → footer / notice / OS notification，仅在影响未来因果理解时留 transcript summary。
14. **AD-14** Approval 无独立 transcript identity；它是所属 Tool representation 的状态（waiting / approved / rejected / unknown）；不得为未知假装已批准。
15. **AD-15** Plan 是 Artifact；artifact = durable session events 的 projection，**不是**第二套持久化；transcript / dock / review 都是 projection；B2.5 前必须先审计 durable events 是否够用（§11.3 已列出四个缺口，其中"plan review 身份在 replay 时被丢弃"已实测确认，属解析器缺口而非数据缺口）。
16. **AD-16** Completion 属 Composer 子区域；其挤压 transcript 记为 Composer layout debt，不在 B2.1 处理。
17. **AD-17** Remote-first invariants 六条对新 Screen / Surface 强制生效。
18. **AD-18** Roadmap 与阶段边界（B2.1 → B2.6）冻结。

---

## 17. Deferred decisions

以下**尚未决定**，不属于本轮范围；在此登记以免被当成已定：

| # | 问题 | 何时决定 |
|---|---|---|
| DF-1 | Screen 的 compact strip **具体**显示哪几格、如何降级 | B2.1（AD-8 只冻结"必须有、且优先保留"） |
| DF-2 | Report 的 export 形态：`--save <path>` 的路径默认值、格式（纯文本 / Markdown / JSON）、失败处理 | B2.1 之后 |
| DF-3 | Historical search 的入口（`/find --all` vs `/search`）与选中后的动作（回工作区 reveal vs 开详情） | Search Screen 立项时 |
| DF-4 | Plan 身份与归因缺口的**解法**：projection 补 id/revision，还是确有必要时新增 durable 事件（§11.3 已给出缺口清单） | B2.5 开工前审计之后 |
| DF-5 | 哪些 approval 事件"具有独立因果价值"（例如策略变更 vs 单次决定） | B2.4 |
| DF-6 | Context Lifecycle 的存储形态、`/context` `/archive` `/restore` 的最终词汇与交互、`/compact` 与 segment 的对齐方式 | Context Lifecycle 立项时 |
| DF-7 | `/clear` 的 cutoff 是否需要持久化（跨 resume 记住"隐藏到哪"），或永远保持 Host 内存态 | B2.3b 之后；**当前冻结为 Host 内存态** |
| DF-8 | footer echo chip 的最终寿命（"保留到下次输入"是 B2.3b 的候选，不是冻结值） | B2.3b |
| DF-9 | `/find` 是否升级为读 log（在 AD-9 的两级模型之下，Local 是否也读 log） | Search Screen 立项时 |

---

## 18. Implementation consequences

### 18.1 对 B2.1（Screen Contract + Report Screens）

**必须做**：

- 引入 Screen 状态与 `screenOf()` 判定，把散落的 10 处 `kind === 'inspect'` 特判收敛成一处**纯函数**；
- Screen 渲染契约：纯函数 + `dirtyFrom` + 不做无理由 clear + 继承 byte budget；
- **用 inspect 验证契约**（它是已有 Screen，且今天每键全清）：滚动报告时只重画正文区；
- compact global runtime/status strip（AD-8），含"还在跑吗 / 有没有在等"；
- Screen 内动作走 `screenSurface`，与工作区队列隔离；
- Screen 退出后工作区原位恢复（scrollOffset / focus / draft / search）；
- line mode 保持 `echoInspectToLog` 文本路径。

**禁止**：

- 不得引入 Screen 栈（AD-2）；
- 不得把 completion 一起搬进来（AD-16）；
- 不得在 Screen 里保留普通 composer（AD-8）；
- 不得改 `display-sock.ts` 的 attach / detach / handshake（AD-17 第 6 条）。

**验收**：报告不再改变 `window start`、不再 clear；detach/reattach 后画面一致且只一次全清；120 / 80 / 72 列 × 20 / 12 / 8 行档位下可读可滚动。

### 18.2 对 B2.2（Live Tail Ownership）

**契约来源**：AD-12。

**必须做**：

- streaming（正文 / 推理）、等待卡、tool running 等 live 内容移出 source rows，成为不占窗口几何的 tail block；
- settle 时**原子地**提交为一条 A 类行；
- 等待卡的 elapsed 刷新**不得**移动 `start`；
- deterministic redraw（AD-17 第 1、2 条）——detach 后 live 层能重建。

**禁止**：

- 不得让 live 内容重新进入 `available` 计算；
- 不得用"每帧清屏"掩盖增量逻辑（AD-17 第 3 条）。

**注意**：`live-tail-cache` 的既有约束（"live 块不得写进任何行的缓存"）在新方案下仍然有效，B2.2 必须保留该保证。

### 18.3 对 B2.3a（Representation metadata + correctness preflight）

**必须做**：

- 为表示引入 durability 标签（`durable` / `display` / `live`）并覆盖 262 处 `pushRow` 的分类；
- 首个必须显式标注的伪装 durable：`changes` 卡；
- **审计并修复重复不可达的 `case 'user/message'`**（`src/tui.ts:6781`）：该 case 的职责是 `this.sawUserInput = true`，但今天 `sawUserInput` 只由 composer 提交路径（`src/tui.ts:12595`）设置，**没有从 durable 日志推导**；读取方 `src/index.ts:781`（今天由 `config.resume !== true` 兜住，故无可见 bug，但对 `/cleanup` 语义与任何新用途是错的）；
- B2.3a 必须是**零行为变化**的一步（除上述修复）。

**禁止**：

- 不得在同一阶段顺手做 echo 文案或 `/clear` 语义（那是 B2.3b）。

### 18.4 对 B2.5（Plan Artifact projection）

**必须做**：

- **先审计**（§11.3 已给出预审与四个缺口：无 identity / 无 revision 关联 / 无显式 decision-completion 事件 / **plan review 身份在 replay 时被解析器丢弃**）；
- 第 4 个缺口是**前置条件**：plan artifact 的 `reviewing / approved / rejected` 三个状态能否重建，取决于这次评审能否在 resume 后仍被认作评审；
- 用 projection 从既有 durable events 重建生命周期；**transcript / dock / review 都从同一个 projection 读**；
- 缺口解决后，transcript 只保留引用行（created / approved / completed 等），dock 仍是投影。

**禁止**：

- **不得先创建第二套 truth source**（AD-15）；
- 不得为"看起来更整齐"新增持久化文件；
- 不得在审计结论出来之前假定需要新增 durable 事件;
- 不得在本阶段之外改动 plan review 的主流程（churn 风险最高）。

### 18.5 对其他阶段（简要）

- **B2.3b**：echo 下沉 + `/clear` 语义 + `/find` 可见边界说明；受 AD-4 / AD-13 约束；DF-7 / DF-8 需在此决定。
- **B2.4**：tool card 增加 `approval` 状态，弹窗只编辑它；受 AD-14 约束；DF-5 需在此决定。
- **B2.6**：setup 迁到 Screen 契约；受 AD-1 / AD-2 / AD-8 / AD-17 约束；**无工作区兜底**，故以真 PTY 全绿为门槛，旧路径保留至最后一刻。

---

## 20. B2 FROZEN — 冻结不变量与退役路径（AD-19）

**2026-10-03，B2 FINAL AUDIT。** B2 的六个阶段（B2.1 – B2.6）全部完成并通过最终审计；本节是**冻结记录**，
不是新的规划。此后任何改动都不得违反这里的条目；要改，先改本节并给出理由。

### 20.1 冻结不变量（每条都有一个可重跑的命令）

| # | 不变量 | 门槛 | 测量方式 |
|---|---|---|---|
| 1 | 未分类表示行 | `unclassified = 0` | `npm run freeze` |
| 2 | 未知 destination | `unknown destination = 0` | `npm run freeze` |
| 3 | live 源行 | `live source rows = 0` | `npm run freeze` |
| 4 | 重复 primary 表示 | `duplicate primary = 0` | `npm run freeze` |
| 5 | Screen 深度 | `<= 1` | `tests/screen-contract.test.mjs` |
| 6 | 流式每 tick 全清 | `addressed >= 4 × clears`（settle 允许清零） | `scripts/tui-probe.mjs` 第 6b 步 |
| 7 | Screen 翻页全清 | `= 0` | `scripts/tui-probe.mjs` 第 6e 步 |
| 8 | setup 打字全清 | `= 0` | `tests/setup-screen.test.mjs`（真 PTY 见 §20.4） |

`npm run freeze`（`scripts/b2-freeze-audit.mjs`）同时扫描**退役路径**（下一节）与 1–4 条；它在 Linux 与
Windows 两条 CI 腿上各跑一次。性能基线不再靠一次性测量：`npm run bench`（`scripts/bench-b2.mjs`）
以 100×20 的固定夹具给出五个动作的中位数（stream tick / waiting tick / Screen scroll / picker move /
setup typing），并断言这五个动作**都没有全清**。

### 20.2 退役路径（不得以任何形式复活）

| 路径 | 退役于 | 今天的替代 |
|---|---|---|
| `dedicated` Surface 角色、`dedicatedLines`、`surfacePriority` 的第三档 | B2.6 | Screen 契约；`SurfaceRole = interaction \| picker` |
| onboarding 的 dialog 渲染与按键分支（`dialog.kind === 'onboarding'`） | B2.6 | `ScreenState{kind:'setup'}` → `renderSetupBody` / `handleSetupKey` |
| `OnboardingDialog` 作为**可用**路径 | B2.6 | 只作 deprecated 形状（0.8.x 导入兼容）；`isSurfaceDialog()` 认不出它，落在 dialog 路径即被丢弃 |
| `upsertPlanRow`（第二个 plan row 写入者） | B2 final audit | `syncPlanArtifacts` → `createPlanRow`（唯一写入者） |
| `represent('plan-row', …)` 用于非 plan 行（turn-end 的待办通知） | B2 final audit | `represent('plan-notice', …)`（echo），句子仍由 dock 的 `planDockNote` 画在屏幕上 |
| `ask_user_question` 的通用工具卡 | B2.4 | question card（`ensureQuestionCard`）；`askQuestions` 只用来记住批次 |
| live durability 的源行 | B2.2 / B2.3a | live 是**投影**，不进源行（`live source rows = 0`） |

### 20.3 表示的分类必须与内容一致

B2 final audit 修掉的那条（`plan-row` 包着一行 system 文本）之所以危险，不在于它当时画错了什么——它画的
就是一行普通文本——而在于它让**审计的数字**与它声称的东西不符：`plan-row` 是"计划的转写引用"，它必须
有 `artifactId` 与 steps。规则因此写死为：**一个表示的分类必须与它包裹的行一致**；`npm run freeze` 的
`plan-row-kind-mismatch` 查询会拒绝任何既不是 fold 工厂、又不是显式 plan 行的 `plan-row` 调用点，而
`tests/plan-artifact.test.mjs` 在运行时钉住同一条（"the leftover-todo notice is not a plan row"）。

### 20.4 未验证项（发布前人工门槛）

- **fresh-home 真 PTY 首启走查 —— 已查清、已修、已在本机通过（2026-10-03，0.8.2-rc.1）。**
  审计当时只看到"向导不出现"，没看到原因；真因是一条**产品缺陷**，与 home 或探针无关：
  前端拉起后台 Host 时**永远**带 `--resume=<id>`（`hostArgvForSession`，连它自己刚铸的新 id 也带），
  而首启判定把 `resume` 读成"这台机器配置过"，于是 `maybeRunOnboarding` 对新机器直接返回 ——
  **全新安装永远不会出现向导，也没有任何提示**。判定现在只看凭据（`stored`）。
  证据链：Host 侧 trace 打印 `{"at":"enter","resume":true,"envKey":0}` → `{"verdict":"skip"}`，
  而同一进程的 `startup.provide` 显示 `resume:false`（前端）与 `resume:true`（Host 的 argv 被改写）。
  修后在本机真 PTY 上：未配置 home → 向导**自动出现**、列表步按键只重画正文、字段步打字只重画 1 行、
  resize 后字段与按键仍在、Esc 交还工作区；再写入凭据重启 → **不再出现向导**（两项都 PASS）。
  跑法：`node scripts/probe-home.mjs --keep --unconfigured` 建 home，再
  `PROBE_HOME=<home> node scripts/tui-setup-probe.mjs`。
  顺带修掉的探针问题：`probe-home.mjs` 现在为探针 home 写入**占位凭据**（否则工作区类探针会一头撞进
  向导 —— 它们此前只是被这条缺陷"顺带"放行），`--unconfigured` 保留未配置路径。
- **Windows / ConPTY 实机**：本机无法覆盖。它是**发布前人工验证项**，清单见
  [`docs/release.md`](../release.md) 的"发布前人工门槛"一节；CI 的 `test-windows` 腿只覆盖
  ConPTY 上的探针（boot / drop / busy-drop / term / stdio），不覆盖人手输入法、鼠标选择与真实
  Windows Terminal 的画质。

### 20.5 结论

**B2 冻结完成，可以进入下一个 0.8.x release candidate 的准备。** 判据：全量套件 1361 项
1357 通过 / 0 失败 / 4 跳过；`tsc --noEmit` 干净；`npm run freeze` 八条不变量全绿、七条退役路径
0 命中；五个性能动作全部增量（0 全清）；B0–B2.6 的既有套件全绿。**唯一的未验证项是 §20.4 的
一键一机**（fresh-home PTY 与 Windows 实机），它们不阻塞 RC 的准备，但阻塞**发布**——按
`docs/release.md` 的规则，未覆盖的平台要在发版说明里如实写明。


---

## 19. 本轮的证据与范围声明

- **本轮改动**：仅新增本文件（`docs/decisions/` 目录为本文件新建）；**未修改任何 production code、tests、renderer、event reducer**。
- **本轮读取/度量**：`src/tui.ts`、`src/commands.ts`、`src/tool-present.ts`、`src/transcript-types.ts`、`src/index.ts`、`src/i18n/zh.ts` 的只读检索；上一轮已完成的 headless 度量（报告 / 流式 / inspect 的 rows·bytes·clear）沿用，方法见 `docs/plans/b2-architecture-plan.md` 附录 A。
- **行号引用**：基于 HEAD `a295ee9543565afc94227a7d6537935dabf28ba8`（B1.2 完成时的树）；实现推进后行号会漂移，届时以符号名（`paintInspectOverlay`、`planReviewOf`、`sawUserInput` 等）为准。
