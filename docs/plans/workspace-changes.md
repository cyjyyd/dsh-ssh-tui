# 接入 `workspace/changes`：回合改动卡片

> 状态：**已落地，未发版**（2026-09-25）。这是 0.1.7 接入的第一项，也是最小的一项。
> 做完再谈 `pluginManager` 与 Agent Teams。
>
> 与方案的两处偏离，都是写的时候才看清的：
>
> - 卡片行上存的是渲染好的 `header` / `files` / `more`，不是 `summary` 本身。
>   摘要每帧不会变，存原文只会让 `paint()` 再算一遍。
> - 「再按一次回车看 diff」只对**展开后的**卡片生效，而且只在卡片恰有一个文件时
>   直接打开它。多个文件时按光标所在行定位，光标不在任何文件行上就打开第一个。
>   方案没写光标不在文件行上的情形。
>
> 验收里的两棵树 `tsc --noEmit` 都是 0 错，`npm test` 937 过、0 失败
> （3 个跳过是原有的 Windows 用例）。真机对照 `git diff` 仍留到发版前。

## 为什么做、为什么先做

0.1.7 的 `@deepseek-ai/dsh-workspace-changes` 在每个顶层回合结束时记下一份「这一轮改了哪些文件」：
git 工作区快照对比，加上对 `write` / `edit` / `str_replace_editor` 这类文件工具的整文件拷贝
（没有 git 仓库时只剩后者）。Web 端已经有一张改动卡片在读它，TUI 没有。

它是最小的一项，因为：

- **只读、不发请求、不碰模型。** 事件是 log-only，服务端不注册任何模型可见的东西，KV cache 不受影响。
- **对 0.1.5 完全无感。** 那条线没有这个包，也没有这个事件；探测不到服务就什么都不做。
- **最贴这个插件的场景。** 人在跳板机上，最想确认的就是「刚才那一轮到底动了哪些文件」，
  而现在这些改动散在一张张工具卡片里，shell 改的文件更是根本不出现。

## 上游契约（0.1.7-rc.1 实测，`/root/leg-017`）

事件 `workspace/changes` 的 `data` **只有 `{ turn: number }`**。摘要和对比都留在 Host 上，
随 Session 销毁，**重启 Host 之后回放旧日志拿不到**——这是上游定下的行为：打不开内容的卡片就不显示。

```ts
ctx.workspaceChanges.summary(sessionId, seq): WorkspaceChangesSummary | undefined
ctx.workspaceChanges.diff(sessionId, seq, index, signal): Promise<WorkspaceFileDiff | undefined>
```

`seq` 是**事件自己的序号**，不是回合号。摘要含 `turn`、`cwd`、`files`（按 `display` 排序，受 `maxFiles`
封顶）、`total` / `added` / `deleted`（封顶前的完整数）。单个文件有 `path`、`display`、`added`、`deleted`，
以及可选的 `binary` / `oversized`。

`diff` 返回三种：`text`（带 `hunks`，每行保留 `+`/`-`/空格 前缀，上下文三行；`coarse` 表示对比超时、
退化成整文件替换）、`binary`、`oversized`。同一回合可能先来一条事件、再来一条**替换**它
（`turn/end` 时补记），所以卡片按回合号归并，后来的覆盖先前的。

覆盖边界（卡片文案不必解释，但实现不能假设更多）：子代理会话不记录；只有 shell 改动且不在快照
覆盖范围内的文件不会出现；用户在回合中途自己改的文件会被算进这一轮。

## 设计

### 卡片

转录里一张可折叠卡片，默认收起：

```text
▸ 本轮改动 · 3 个文件  +42 -7
```

展开后每个文件一行，`display` 路径加行数；`binary` 标「二进制」，`oversized` 标「过大」，
`total` 大于 `files.length` 时末行补「另有 N 个未列出」：

```text
▾ 本轮改动 · 3 个文件  +42 -7
    src/tui.ts            +30 -5
    README.md             +12 -2
    assets/logo.png       二进制
```

回车走现有的卡片展开（`toggleCard`），与工具卡片一致。**再按一次回车**对光标所在文件打开全览，
复用 `inspect` 对话框：正文由 `diff()` 渲染成 `diff-add` / `diff-del` / `tool-result` 行，
因此配色、折行、`/find` 都是现成的。`binary` 与 `oversized` 没有正文，全览里只留一行说明。

空摘要（这一轮没有任何改动）**不建卡片**。

### 归并与生命周期

- 卡片记 `turn`、`seq`、`summary`。同一 `turn` 再来事件时，更新 `seq` 与 `summary`，
  卡片位置不动（它代表的就是这一轮）。
- `summary()` 返回 `undefined`（Session 已销毁，或这条日志是上一个 Host 留下的）时不建卡片。
  回放路径因此自然得到上游要的行为：旧回合没有卡片，而不是一张打不开的卡片。
- 卡片是纯展示，不进会话日志，所以也不存在「重启后残留一张坏卡片」。

### 为什么几乎不改 `tui.ts`

事件进 `applySessionEvent` 的 `switch (event.type)`。**不能加 `case 'workspace/changes'`**：
0.1.5 的 `SessionEventMap` 没有这个键，`strict` 下直接编译失败。处理放在 switch 之前，
照 `tui.ts` 里 `team/` 事件的做法按字符串比较：

```ts
if (String(event.type) === 'workspace/changes') {
  this.noteWorkspaceChanges(session.id, event.seq)
  return
}
```

`noteWorkspaceChanges` 只做三件事：探测服务、取摘要、建或更新卡片。取不到就返回。

## 落点

| 文件 | 改动 |
|---|---|
| `src/workspace-changes.ts` | **新建**，纯函数：服务探测、摘要与 diff 的本地类型、`changesHeader` / `changesFileLine` / `renderChangesDiff`。不 import `tui.ts`。 |
| `src/transcript-types.ts` | `Row` 加 `kind: 'changes'`；`CollapsibleBlock` 纳入它。 |
| `src/tui.ts` | switch 前的字符串分支；`noteWorkspaceChanges`；`paint()` 里一个分支；`collapsibleRows()` 的两处过滤各加一项。 |
| `src/line-mode.ts` | 纯行模式下一行文本，不画卡片。 |
| `src/i18n/zh.ts`、`src/i18n/en.ts` | `changes.*` 共 6 个键，两边同时加。 |
| `tests/workspace-changes.test.mjs` | 纯函数的渲染，加一个 `SshTui` 用例走事件到卡片。 |

### `tui.ts` 的预算

字符串分支约 5 行，`noteWorkspaceChanges` 约 30 行，`paint()` 分支约 25 行，过滤两处各 1 行。
合计约 60 行。渲染、行文案、diff 文本全部留在新文件里，便于单测，也避免 `paint()` 继续长大。

### 服务探测

```ts
export interface WorkspaceChangesSource {
  summary(sessionId: string, seq: number): ChangesSummary | undefined
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<ChangesFileDiff | undefined>
}

export function workspaceChangesOf(ctx: { get(name: string): unknown }): WorkspaceChangesSource | undefined
```

`ctx.get('workspaceChanges')` 取到的对象要同时有函数形态的 `summary` 与 `diff` 才算数，
否则返回 `undefined`。本地类型不从上游包 import：那个包在 0.1.5 的依赖树里不存在，
而 `skipLibCheck` 也覆盖不了「模块找不到」。

### diff 渲染

`renderChangesDiff` 把 `text` 结果的 hunk 直接映射成 `DiffDisplayLine`：前缀 `+` 为 `diff-add`、
`-` 为 `diff-del`、空格为 `tool-result`，hunk 之间一行 `diff-path` 标出起止行号。
`coarse` 时在开头加一行说明「改动过大，按整文件显示」。不重新做行对比——上游已经对比好了，
再算一遍既慢又会和它的结论不一致。

## 明确不做

- **不挂载这个插件。** 它随 0.1.7 的 Web bundle 到来；TUI 只消费。0.1.5 上没有它，
  我们也不在自己的 bundle patch 里加一行去要求它。
- **不持久化卡片。** 上游把「重启后不显示」定为行为，跟它保持一致。
- **不做逐文件的侧栏或独立命令。** 卡片加全览足够；`/changes` 之类等真有人需要再加。
- **不解释覆盖边界。** 「shell 改的文件可能不在列表里」写进 `docs/terminals.md` 不合适，
  它不是终端问题；最多在 `/diag` 不提。

## 验收

- `tsc --noEmit` 在 **0.1.5-rc.3 与 0.1.7-rc.1 两棵树上都是 0 错**（字符串分支就是为了这个）。
- 纯函数测试：摘要渲染（含 binary、oversized、封顶余数）、空摘要不出卡片、diff 行的前缀映射、
  `coarse` 的说明行。
- `SshTui` 测试：喂一条伪造的 `workspace/changes` 事件加上一个假服务，断言卡片出现且行数正确；
  同一回合第二条事件更新原卡片而不是新增；服务缺失时事件被静默忽略。
- 全套 `npm test` 0 失败。
- 真机（0.1.7）留到发版前：跑一轮会改文件的回合，确认卡片与 `git diff` 一致。0.1.5 上确认无卡片、无报错。
