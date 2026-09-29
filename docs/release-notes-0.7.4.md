# 0.7.4 发版说明（草稿）

> **状态：未发版。** 版本号、tag、GitHub Release、npm 都还没动（`docs/release.md` 第 1 条）。
> 本文件是发版时要粘进 GitHub Release 的正文草稿 + 当次核对清单，写完就不必临场回想。
> 上一次发版：**0.7.3**（2026-09-24，commit `e505768` / tag `v0.7.3` / npm `latest`+`next`）。

## 头等事

这一版是「把已经做出来的东西做对」：0.7.3 之后落的六个功能各自被真机与对抗式审查拧了一遍，
修掉了 8 个实际缺陷（含两个只有读代码才看得见的：现场思考卡被挤出焦点环、覆盖层里的复制
拿到的是另一份正文）。行为上最明显的变化是**回复变成了可选中的卡片**。

## 回复可以选中、可以复制（本版主线）

`/copy` 取的是"被选中的那一行"，而可选列表里**从来没有回复**——所以只要按过一次 ↑/↓ 选中
任何卡片，`/copy` 就再也拿不到回复，最新回复只是"没有选中时"的兜底。现在：

- 空输入 `↑`/`↓` 在**回复与卡片**之间按屏幕顺序走，选中的那一行带 `▶` 标记；`Alt+4` 直接选中最新回复。
- `/copy`（或 `Ctrl+Shift+C`）复制的是**选中的那一条的原文**——不是折行后的屏幕文本；
  复制后保留选中，连按两次拿到的是同一条。
- 在选中的回复上按 `Enter`：打开「回复全文」（可滚动、`Esc` 返回），长回复里的表格与代码块
  不再被窗口宽度切碎。**覆盖层里也能复制**，取的是屏幕上那份正文，并在覆盖层底部回显「已复制 …」。
- 工具卡 / 子代理 / 改动卡的「全文」覆盖层里，复制键取的同样是**屏幕上那份正文**（工具全文、那份 diff、
  子代理日志），不再是卡片摘要。
- **拖选**照旧：被选中回复第一行前面的 `▶` 是装饰，拖过它不会把标记复制进去。

## 底栏与链路

- 链路质量**在会话运行中持续重测**并按中位数读数：进会话那一瞬间的网络抖动不再把整场会话钉在最低档
  （绘制节奏与每帧字节预算都跟着这档走）。
- 选择器把「可接入 / 已占用」两个词固定下来，并且**在首帧之前**就把"已经挂掉的窗口"判完——列表不会先
  显示「已占用」再改口。判定走一次真实往返（光标探针），因为断掉的 SSH 链路会让 launcher 还连着显示通道。
- 接管（把别人的窗口接过来）现在**要确认**，`Esc` 是取消而不是退出。

## 空回合不再被误读为完成

上游网关偶尔只回思考、`finish_reason: stop`、正文为零（实测某网关 10/35 个回合如此），
宿主如实组装成"只有思考的助手消息"，状态栏显示完成/空闲。现在转录里会补一行明确提示
（含 `finish_reason: stop` 与"按 Enter 继续"），回放/中断/报错的回合不提示。

## 上游兼容

- `dsh` 声明窗口：`>=0.1.7-rc.1 <0.1.8`（`next`）与本条线并行；`0.1.7-rc.2` 已按完整流程验过并声明
  `compatible`（干净树安装、`tsc` 0 错、套件全绿、六个真 PTY 探针全过），CI 里单独一条腿。
- CI 现有 5 条腿：`0.1.7-rc.1`（默认，提交的 manifest）、`0.1.7-rc.2`、`0.1.5-rc.3`、`0.1.5-rc.1`
  （只跑类型与单元）、`test-windows`（ConPTY 真机）。默认腿新增一条 **Reply copy probe**：真 PTY 跑一轮
  脚本化模型，断言拖选复制、`/find` 高亮、以及**选中回复后按复制键拿到原文**。

## 发版核对清单（执行时逐条打勾）

```sh
# 0. 版本号（改这一处，然后重新生成锁）
#    package.json "version": 0.7.4
npm install --package-lock-only --cache <可写目录>   # 只重算锁，不动 node_modules

# 1. 门禁（本地）
npx tsc --noEmit -p tsconfig.json
node --test "tests/*.test.mjs"                       # 期望：1009 pass / 0 fail / 4 skip
node scripts/tui-mock-probe.mjs                      # 脚本化一轮：拖选 + 选中回复复制 + /find
node scripts/tui-mock-probe.mjs --busy                # 窗口中途关闭
node scripts/probe-home.mjs --probe                   # boot/resize/diag/doctor/copy/preset/exit
node scripts/probe-home.mjs --probe --script tui-term-probe.mjs
node scripts/probe-home.mjs --probe --script tui-cut-probe.mjs
node scripts/probe-home.mjs --probe --script tui-rtt-probe.mjs
node scripts/probe-home.mjs --probe --script tui-drop-probe.mjs
npm pack --dry-run                                    # 189 个文件、无 tgz 落盘

# 2. GitHub（先）
git commit -am "Release 0.7.4"
git push origin main
git tag -a v0.7.4 -m "0.7.4" && git push origin v0.7.4
#    → 建 GitHub Release（正文用本文件"头等事"起的那几段 + 当日热度基线）
#    → 等 CI 五条腿全 success（tag 与 main 都要看）

# 3. npm（CI 全绿之后；token 需先刷新）
npm whoami --registry https://registry.npmjs.org/      # 必须是登录态，否则不要往下走
npm publish --registry https://registry.npmjs.org/ --tag latest
npm dist-tag add dsh-ssh-tui@0.7.4 next                # 0.7.3 时 latest 与 next 同值
```

**注意**：本机 `~/.npmrc` 的默认 registry 是 npmmirror，发布必须显式
`--registry=https://registry.npmjs.org/`；`_authToken` 目前是过期状态（`npm whoami` → `E401` /
`ENEEDAUTH`），刷新之前不要执行第 3 步。

## 已知限制（写进 Release）

- 真实 Windows 上仍只能人工确认的两条：宿主控制台窗口确实隐藏；`%USERPROFILE%` 与 `$HOME` 不一致的账户行为。
- 纯问答会话（尚无任何卡片）或刚 `/clear` 时，空输入 `↑` 仍是**历史召回**而不是选中回复——这是刻意保留的；
  那种会话用 `Alt+4` / `Ctrl+N` / `Ctrl+P` 选回复。选中后 `Enter` 正常打开全文。
- 把 `Ctrl+Shift+C` 折叠成 `Ctrl+C` 的老终端上，覆盖层里那个键等于关闭；请用 `ssh-tui.keys` 改绑 `copy`
  （改绑后的键在覆盖层内同样生效）。
