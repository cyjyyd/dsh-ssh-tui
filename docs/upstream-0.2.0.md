# 上游 0.2.0-rc 线：验证记录与适配

> 上游 2026-09-29 把 `next` 指向 **`0.2.0-rc.1`**，`latest` 仍是 `0.1.7-rc.2`。
> 本文件记录"我们跑过什么、结论是什么、还欠什么"，供下次发版或升级复用。

## 结论

| 项 | 结果 |
|---|---|
| 声明 | `0.2.0-rc.1` = `compatible`；窗口 `>=0.1.7-rc.1 <0.1.8 \|\| >=0.2.0-rc.1 <0.2.1` |
| 默认线 | 提交的 manifest 与 Windows 腿都装 `0.2.0-rc.1`（`scripts/ci-pin-line.mjs` 的 `DEFAULT_LINE`） |
| 源代码改动 | **零**。类型面 0 错，运行期接缝全部是探针式判定（`settings.get` 的有无、`config-editor` 行、会话事件形状），不认版本号 |
| 需要改的 | 只有"行判定"：测试助手、真机探针、profile 行写入三处原来用 `^0\.1\.(?:[7-9]|\d{2,})` 这类前缀判断，`0.2.x` 会被判成 legacy → 现在统一读 `scripts/host-line.mjs` |

## 跑过的验证（2026-09-29，干净树）

```sh
# 干净树：只有提交的 manifest 与锁，无 node_modules
npm install --no-audit --no-fund            # 族 279 个包全部 0.2.0-rc.1，无 ETARGET/ERESOLVE
npx tsc --noEmit -p tsconfig.json           # 0 错
node --test "tests/*.test.mjs"              # 1012 项 / 1009 通过 / 0 失败 / 3 skip
node scripts/tui-mock-probe.mjs             # 脚本化一轮 + 拖选复制 + 选中回复复制 + /find
node scripts/tui-mock-probe.mjs --busy      # 窗口中途关闭，回合活下来并出现在重连窗口
node scripts/probe-home.mjs --probe         # boot/resize//diag//doctor//copy error//preset/退出
node scripts/probe-home.mjs --probe --script tui-term-probe.mjs   # 8 档终端能力
node scripts/probe-home.mjs --probe --script tui-cut-probe.mjs    # 活窗口=attached、断链=detached
node scripts/probe-home.mjs --probe --script tui-rtt-probe.mjs    # 链路挡位跟着重测走
node scripts/probe-home.mjs --probe --script tui-drop-probe.mjs   # 崩溃/断开后自动回来
```

七条探针全过（`tui-cut-probe` 与 `tui-rtt-probe` 在 CI 里只跑默认腿，本次在本地对 0.2.0-rc.1 也各跑了一遍）。

## 那条线变了什么（对消费者有意义的）

- **根部钉版没变**：`dsh@0.2.0-rc.1` 依赖 `cordis ~4.0.4`、`cordis-plugin-{include ~1.0.9, loader ~1.0.5, timer ~1.1.6}`，
  `dsh-app-boot` 仍 peer `cordis-plugin-group ~1.0.4` —— 与 0.1.7 线逐字相同，所以两条线共用一张 roots 表。
- **族变大了**：树上 `@deepseek-ai/*` 有 291 个目录、279 个是 `0.2.0-rc.1`（0.1.7 线是 272 个族包）。
  新增的包（`dsh-client-ui-cordis`、`dsh-cordis-client-runner`、`dsh-tool-cordis`…）**没有被本插件 import**，
  所以只是安装体积，不是接口面。
- **设置/代理代际接缝没变**：仍是"loader entry 自带 `Config` schema 投影表单、没有 `settings.get`"，
  以及"终端 profile 在进程级组合代理、没有 preset 名单"。本插件靠 `settings` 服务有没有 `get`
  以及 profile 组合里有没有 `config-editor` 行判定，两条线走同一段代码。
- **复数 `dsh-agent-presets` 在 0.2.0 线也不存在**（它停在 0.1.6-alpha.2），这本来就是 0.1.7 拆分后的状态。

## 还没做的（有意留给下一版）

- **`0.1.5` 已经按用户决定在 0.8.0 摘除**：范围去掉其 comparator、`dshReleases` 保留 `incompatible`、
  两条 CI 腿与它们的钉版表/roots 表/`--legacy-peer-deps` 安装步骤一起删除、复数 presets 的 peer 与
  optional 标记删除。**运行期那条 legacy 分支仍在代码里**（`hostSettingsGeneration` 返回 `'legacy'` 时的
  `settings.get`/`installSection` 路径、`rosterRows('legacy')` 等）：它不是按版本号分支，而是特性探测，
  删掉它换不来任何用户可见的东西，却要动很多测试。要不要清理是一个独立决定——若清理，记得同时更新
  `docs/release.md` 的"摘除一条旧线要成套做"清单。
- 0.2.0 **正式版**尚未发布（只有 rc.1）。等 `0.2.0` 出来按同样流程跑一遍再决定是否加 comparator；
  rc 线的表态不自动覆盖正式版（prerelease 的 semver 语义）。
