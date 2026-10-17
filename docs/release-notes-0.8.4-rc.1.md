# 0.8.4-rc.1 — Input Ownership & Release Hardening Candidate

> **发布方式：只上 `next`。** `latest` 保持 **0.8.3**（候选版不占 `latest`）。
> 上一次发版：**0.8.3**（2026-10-13，`latest` + `next`）。本文件描述的是**候选版**，
> 是否转正由独立审核与后续发版决定。
>
> 本版同时是：**输入可靠性的修复批次**、**内部输入路由的结构整理**、以及**发布安全门的加固**。
> 与 0.8.3 相比**有** runtime 行为变化（见「修复」），这一点如实写在最前面；本轮"发布准备"
> 这个动作本身没有再改 runtime。

> `dsh-ssh-tui` is now presented as DSH Relay.
> The npm package name and the install command have not changed.

> **`dsh-ssh-tui` 现在以 DSH Relay 为产品名展示；npm 包名与安装命令没有变化。**

没有协议变更、没有配置迁移、没有数据格式变更。升级即生效，不需要任何迁移动作。

## 概览

`0.8.4-rc.1` 的主线是**输入归属**：一次终端 read 里往往不止一个键（粘贴、合并读取、带尾巴的序列），
0.8.3 及以前由一串顺序判断逐段消费它们，于是同一类缺陷反复出现在不同 Owner 上——Screen 背后的草稿被
粘贴改写、Surface 的编辑键去改看不见的草稿、一次 read 里的第二个键被丢掉。这一版把这条路径拆成三层
（Reader 分帧 → Router 判定归属 → Owner 执行），并把每一层的行为用轨迹、归属矩阵与变异测试钉住。

同时，0.8.3 的真实事故（**首次安装时向导收不下粘贴的 API Key**）暴露了发布流程本身的缺口：CI 从来没有
跑过"未配置 home 的首启向导"，也从来没有跑过 **npm 发布包本身**。这一版把两者都变成阻塞门。

## 修复

### 一次 read 不是一个键（W-3a / W-3a.1）

终端的粘贴、合并读取、以及"序列 + 尾巴"都会把多个键塞进同一次 read。此前合并 read 里的第二个键会被
整段匹配失败吞掉（`two arrows in one read` 两个都没移动、`PgUp` 连按只滚一次、改绑键与其它键同 read
时绑定丢失）。现在 Reader 把 read 切成**单元**（完整序列、Alt 和弦、控制字节、CR/LF、一段文本），
每个单元各问一次归属，于是"同一次 read"与"分两次 read"到达同一位置、同一终态。
Screen 的边界在**单元内部**同样成立：关闭 Screen 的那个字符之后的同一单元剩余部分被丢弃，而不是
落到它背后的 Composer（真实入口是粘贴尾巴 `\x1bq`）。

- 提交：`f7e5849`（W-3a）、`f44b56c`（W-3a.1）
- 证据：`tests/input-reader.test.mjs`（成对轨迹）、`tests/input-ownership-regression.test.mjs`、
  `tests/input-reader-traces.json`（参考轨迹 72 → 109 条，逐条追加、零改写）

### Surface 的编辑键归 Surface，编辑的是读者看得见的那一行（W-3b.1）

Surface 打开时，`Home`/`End`/`Delete` 与 kitty 的复制序列此前被放行给 Composer：Home/End 移动**看不见的**
草稿光标，Delete 编辑它。现在这几个单元归 Surface——有借用字段就编辑**屏幕上那一行**，没有就消费掉。
复制键在 Surface 下保持无操作（与它原来的可观察行为一致）。

- 提交：`5ad6290`
- 证据：`tests/input-ownership-matrix.test.mjs`、`tests/interaction-surface.test.mjs`

### 借用字段的终端光标跟随它自己（W-3b.1a）

绘制时终端光标取的是**隐藏草稿**的列号，于是借用字段（自由文本问题）里光标会落在错误位置——中文与
宽字符下尤其明显。现在光标跟随正在绘制的字段。

- 提交：`fd3f638`
- 证据：`tests/borrowed-field-caret.test.mjs`（真实终端网格）

### 输入一个 emoji 会直接崩溃（W-3b.1b）

在 Composer 里输入 `🚀`、`𠮷` 等**非 BMP 字符**会抛 `RangeError: Maximum call stack size exceeded`：
判定"这是不是一段文本"用的是 UTF-16 长度（`🚀`.length 是 2，但它是一个码点），于是同一个码点被无限次
送回自己。借用字段与确认框同样命中。现在按**码点**判定，ASCII 热路径零分配；多字符单元仍逐码点重新判定
（`yes` 在确认框上仍然由第一个字符作答、随后的 `es` 仍交给它当时的 Owner）。
同一根因的第二处（借用字段的 grapheme 编辑切的是隐藏草稿而不是借用字段）一并修掉。

- 提交：`d0db720`
- 证据：`tests/unicode-input-safety.test.mjs`（12 条：Composer/借用字段/拒绝方、UTF-8 逐字节分片、
  粘贴与键入等价、grapheme 编辑），与修复前构建 40 个场景逐字节等价

### 一个 Surface 借走字段后，不再改写 Composer 的历史与草稿（W-3b.3a）

两条实际可达的越权路径：借用字段里的退格 / Delete / Ctrl+U / Ctrl+K / **粘贴**会经
`leaveHistoryBrowse()` 结束 **Composer 的**历史浏览，并把正在浏览的那条历史写进 `historyDraft`——
读者原先未发送的草稿再也回不来；Surface 打开时 `Alt+f` / `Alt+F` / `Alt+/` 会把 `/find ` 直接写进
**看不见的**草稿。现在历史浏览只由 Composer 自己的字段结束，`/find` 种子只写进 Composer 拥有的字段
（Surface 内该和弦被消费），`Alt+1…4` / `Alt+n/p` 的既有语义保持不变。

- 提交：`48efd24`
- 证据：`tests/surface-state-isolation.test.mjs`（真实 ↑ 进入浏览的完整流程）、
  `scripts/input-freeze-audit.mjs` 新增 `composer history` 写入类与 `historyGuards` 检查

### 反馈行不再随消息长度漂移（W-3b.2a）

`/copy` 之类的回执此前是状态行上最低优先级的一组，放得下就画在**第一行**、放不下才退到最后一行——
同一条消息的行号由它的长度与窗口宽度决定（真实报告："copy 提示跑到第一行"）。现在回执恒在身份行，
状态行只留仪表；警告（notice）仍优先于回执。

- 提交：`915578f`
- 证据：`tests/feedback-routing.test.mjs`（短/长回执、notice、160/100/60/40 列）
- Ctrl+L 的重绘归属经独立审核后**保留双 Painter**（`KEEP_DUAL`），合同与理由见 AD-22 §10；
  证据 `tests/ctrl-l-repaint.test.mjs`（一次有意的完整清屏，之后回到增量）

### 跨宿主线的兼容垫片（0.2.1-rc.2）

`/subagents kill <id>` 调用 subagent 服务的 `drainContinuableChildren(parent, ids)`；0.2.1-rc.2 把它
改名为 `drainChildren(parent, ids)`（同义、签名一致），旧名不再存在。窗口里同时有两条线，所以调用点
改走 `src/dsh-compat.ts` 的 `drainChildSubagents()`：它按宿主实际拥有的名字调用，两者都没有时解析为
`Promise.resolve()`。这是本版唯一一处**为兼容而改的 runtime 代码**。

- 证据：`npm run typecheck` 在 0.2.1-rc.2 上 0 error；0.2.0 两条腿在 CI 上同样编译（它们只认旧名）。

## 内部结构

- **Reader**（`src/input-reader.ts`，新文件，W-1）：解码、探测回复过滤、ESC 组装、粘贴边界、单元切分。
- **Router**（`src/input-router.ts`，新文件，W-2）：`route(kind, unit, ownershipView) → screen | surface |
  composer | workspace`，纯函数、无状态；`handleInputText` 变成 Reader → Router → owner 三行能读完。
- **共享执行体的合同**：`composerUnit` 仍是 Composer 与 Surface 的共用执行体，经必要性审核后**保留**
  （`KEEP_SHARED_WITH_INVARIANTS`，S-1…S-6，AD-20 §19）。**本版没有做 executor split**，也不打算在
  0.8.4 里做；完整拆分留给后续的独立结构轮。
- **W-3b ownership / input-routing 合同已收口（CLOSED）**：G1–G4 证据（Surface × 共享体敏感键、
  options question / filtering picker 进归属矩阵、两条 `/find` 种子路径、Ctrl+N/P 的焦点环记录）
  与 M1–M7 变异全部实测为红。
- 参考轨迹 **109 条**（0 条改写）：新增只追加，旧读法以台账形式记录在
  `tests/input-reader.test.mjs` 的 `GAP_FIXTURES` / `W3A1_FIXTURES` / `W3B1_FIXTURES` / `W3B1B_FIXTURES`。

## 发布安全门（Release Hardening）

这一版新增两道**阻塞门**，在 CI 的默认腿（`0.2.0-rc.2`）与 `test-windows` 上各跑一次：

1. **首次安装向导**（`probe-home.mjs --probe --unconfigured --script tui-setup-probe.mjs`）：
   在真实 PTY / ConPTY 上用**未配置**的 home 启动 → 向导自动出现 → 列表步 → 字段步 →
   **括号粘贴一段 API Key** → 字段收下且**全程掩码**（掩码按 `•` 计数断言，密钥既不出现在画面、
   也不出现在原始字节流里）→ resize → Esc 交还工作区 → 写入凭据后再启动**不再出现向导** →
   **resumed 首启保存**：走完九步按 `y`，**不需要任何额外按键**工作区自己回来。
2. **发布产物冒烟**（`scripts/artifact-smoke.mjs`）：`npm pack` 出真实 tarball → 检查包内清单
   （必须有 `package.json` / `lib/index.js` / `lib/tui.js` / `cordis.patch.yml` / `README.md` /
   `LICENSE`；**不得**有 `src`/`tests`/`scripts`/`.github`/本地缓存/嵌套 tgz/node_modules）→
   把 tarball 装进**仓库之外**的临时 home（不是 `link:<repo>`）→ 证明 `dependencies` 记录的是
   `file:<tgz>`、安装实体不是指向 checkout 的符号链接、realpath 在 profile 内且不等于仓库 →
   `--dump-config` 通过 → **在上述安装产物上**再跑一遍向导探针与工作区探针。

另外：

- **`scripts/upgrade-smoke.mjs`**（基础设施）：装上一个已发布版本 → 写凭据与会话 → 装候选 →
  断言 bundle 条目、凭据、会话存储存活、`--dump-config` 仍通过。**同版本互换不算升级**，脚本会明确
  拒绝（`--allow-same-version` 才跑机制，并把自己标成 reinstall smoke）；真正的升级验证是**版本
  bump 之后的必跑项**，本版即按此执行（见发版记录）。
- 两道门都有**负向证明**：清单门对"缺 `lib/tui.js`"与"夹带 `tests/`"两种坏 tarball 均判红；
  向导门在"home 明明是未配置的、向导却没出现"时从 SKIP 改为 **FAIL**（0.8.1 那类首启缺陷不再能伪装成绿）。

## 实测（本候选版准备时，本机 100×20）

```
场景                          毫秒    字节   寻址行  整屏清屏
流式输出时的一次重绘          1.68     501      3       0
等待卡片时钟走一格            1.13     465      3       0
报告屏翻一页（PgDn / PgUp）   1.40    2457     17       0
菜单里移动一次光标            0.91     588      4       0
向导字段里打一个字符          0.19     140      1       0
```

五个动作**合计 0 次整屏清屏**（`npm run bench`，`OK: every measured action was incremental`）。
毫秒列是本机数字，只有**字节 / 寻址行 / 清屏数**是跨机器可比的合同值。README 里的实测块由
`npm run bench:report` 单独跑一次生成（因此毫秒列与本表可能相差零点几毫秒，字节/行数/清屏数逐项相同），
`npm run bench:report -- --check` 校验提交的数字与当前树一致。

同一轮的本机收据：

- `npm run typecheck` → 0 error
- `npm test` → **1506 项 · 1502 通过 · 0 失败 · 4 跳过**
- `npm run freeze` / `npm run freeze:input` → 全绿（八条不变量 + 七条退役路径；输入归属无基线超限）
- 参考轨迹 **109 条**（0 改写）
- `scripts/artifact-smoke.mjs` → **PASS**（`0.8.4-rc.1` · 250 文件 · 1 531 289 B）
- `scripts/upgrade-smoke.mjs --from 0.8.3 --pack` → **PASS**（真实 `0.8.3 → 0.8.4-rc.1`）
- `scripts/verify-batch.mjs --home <新建的探针 home>` → **RESULT: PASS**：typecheck、1506 项套件、
  九类真 PTY/ConPTY 探针（含 `tui-unmeasured-probe` 的两条 leg）、footer 帧检查全过，无 `SKIP:`
- `npm run bench:report -- --check` → **PASS**（README 两个语种的实测块与当前树一致）

## 兼容性

声明窗口本版**变了**，两条线一进一出：

```
>=0.2.0-rc.1 <0.2.1 || >=0.2.1-rc.2 <0.2.2
```

- **新增 `0.2.1-rc.2`**（上游 `next`）：整族随之移动到这条线，族的 root pins 各前进一个 patch
  （cordis 4.0.5、include 1.0.10、loader 1.0.6、group 1.0.5），默认线（提交的 manifest / 锁 /
  `test-windows`）改为它。
- **摘除 `0.1.7` 线**（`0.1.7-rc.1` / `0.1.7-rc.2`）：`dshReleases` 改为 `incompatible`、两条 CI 腿删除。
  原因是实打实的范围判断而不是喜新：0.2.1-rc.2 移动了族的 root pins，并把 subagent 的 wind-down 调用
  改名（`drainContinuableChildren` → `drainChildren`——**签名一致，但旧名在新宿主上不存在**）；
  一个构建同时面向两代 seam，就得在类型面上各写一份分支。0.2.0 的两个 rc 仍在窗口内，仍各有一条腿。
- `0.1.5` 及更早仍**不支持**（`dshReleases` 保留 `incompatible` 表态）。
- `0.2.1-alpha.x` **不在**声明承诺内：承诺的是**跑过并表态**的 rc。
- 默认线现在是 `0.2.1-rc.2`；`0.2.0-rc.2` 与 `0.2.0-rc.1` 继续跑既有的兼容性回归。

## 已知限制

- **过滤框对非 BMP 字符的限制（R4，未修）**：picker 的过滤框以 `text.length === 1` 判单字符，
  `'🚀'.length === 2`，因此星平面字符在过滤框里被丢弃。**与上面已修复的 Composer emoji 崩溃不是同一件
  事**——Composer / 借用字段 / 向导字段输入 emoji 都是正常的。属"过滤字段模型"，留待后续。
- **陈旧 `lib/` 的打包风险（未修）**：`tsc` 不清理旧输出、`prepack` 也不跑 `clean`，从**脏** `lib/`
  打包会带上已删除源文件的陈旧模块（实测：本机 252 文件，干净重建与 CI 都是 249）。本版发布必须从
  **干净树**打包；`artifact-smoke` 的清单检查是这道纪律的证据，但脚本本身不阻止脏树打包。
- **一个时间敏感的 Windows 单元测试**：`tests/session-list.test.mjs` 的
  "a title is cached and painted as soon as it resolves" 用 150ms 的 mock 竞速，在慢跑器上会失败
  （同一用例在 192–244ms 通过、638ms 失败）。是**测试 oracle** 的问题，不是产品行为，本版未修。
- **ConPTY 无法覆盖的帧级断言**：ConPTY 会重写行寻址并自行插入清屏，所以"逐行寻址/不清屏/只重画
  高亮那一行"这类**帧字节**检查在 Windows 上标记为 `NOT_MEASURED`（探针会打印出来，`verify-batch`
  见到 `SKIP:` 收尾为 `INCOMPLETE`，不算通过）；**功能断言**（粘贴、字段、掩码、进度、保存、返回、
  二次启动）在 ConPTY 上照常执行并通过。
- **（已定位并修复，不再是限制）`tui-unmeasured-probe` 的竞态**：该探针此前取"屏幕上第一个 link chip"
  并断言它已经是测量值。应答链路上 chip 本来就是**两帧**——引导帧先画延迟槽（`○○○○ 未测`），
  测量落地后的下一帧才画 `●●●● 7ms`；快的机器上第一次轮询就已经是第二帧，慢的机器上读到的是第一帧，
  于是同一个探针在 CI 绿、在本机红（实测 `+4018ms 未测` → `+4119ms 7ms`，产品行为正确）。
  现在按"本 leg 关心的状态"等待（未应答 leg 等 `未测`、应答 leg 等 `\d+ms`），并把这一跳打印出来；
  另做了一次反向验证：把 chip 的 `probed` 强制成 false，探针**仍然判红**（两条断言）。
- **`tui-route-probe.mjs` 不在 CI 里**：本机在同步到提交的依赖树后 13 项断言全绿；它的失败模式
  （mock 版本落后于宿主协议）已知，但它目前只有本地证据。
- **发布后的 registry tarball 比对仍是人工步骤**：本版自动化的是**发布前**的产物（pack → 清单 →
  安装 → 探针）；发布后从 registry 取回 tarball 与上传值逐字节比对、`lib/` 与构建树 `diff` 仍按
  `docs/release.md` 的记录由人工完成。

## 安装（候选版）

RC 只走 `next`，**不要**用 `@latest` 取候选版（`latest` 仍是 0.8.3）：

```bash
dsh plugin --profile tui add dsh-ssh-tui@next
```

已经装过 0.8.3 的用户可以直接装 `@next` 换到候选版；配置、凭据与会话记录不需要迁移。
`dsh-ssh-tui` 现在以 **DSH Relay** 为产品名展示；npm 包名与安装命令没有变化。
