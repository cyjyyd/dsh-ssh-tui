# 验收检查点（A / B / C 批）

每个批次（C 批为每个功能）留下一个可独立复核的检查点：**一条命令 + 一张人工核对清单 + 该批次所有 mutation 记录**。
命令都从仓库根目录执行，全部不消耗模型额度（`tui-mock-probe` 使用合成 profile 与脚本化模型）。

一键复核全部证据：

```bash
node scripts/verify-batch.mjs --batch <A|B|C>     # typecheck + 全量测试 + 四条真机探针
```

## A 批 · 界面基础（已交付）

| 项 | 人工核对（在自己的 SSH 会话里） | 自动证据 |
|---|---|---|
| A-1 模型回复**自由复制** | 在回复上**按住拖过一段**（可跨行、可含中文/emoji）→ 到别处粘贴，内容应恰为拖过的那段；在工具卡上单击仍应展开/收起（按下不动 = 点击） | `tests/mouse-selection.test.mjs`、`tests/selection.test.mjs`；`tui-mock-probe.mjs` 真机拖选并断言剪贴板内容 |
| A-2 计划条进度 | 让模型跑一次多步任务：卡片首行应形如 `⣿⣿⣀⣀… 2 已完成 · 1 进行中 · 1 待处理`；模型写 `failed/skipped` 时单独计数 | `tests/todo-progress.test.mjs`（含 24/30/40/80 列窄屏） |
| A-3 错误块复制 | 制造一次失败（如 `/doctor` 报缺行）→ `/copy error` → 粘贴：**整份**报告，长路径不因折行被插入换行 | `tests/copy-error.test.mjs`；`tui-probe.mjs` 断言 OSC 52 实际发出 |
| A-4 `/find` 高亮 | `/find 某词`：只有该词反色（同行多处都亮），窄屏折行后不错位；`NO_COLOR` 下命中行前有 `»` | `tests/find-highlight.test.mjs`；`tui-mock-probe.mjs` 真机反色断言 |

## B 批 · 底栏、模式与配色（本轮交付）

| 项 | 人工核对 | 自动证据 |
|---|---|---|
| B-1 底栏状态区收敛 | 底栏应是一行：`⚠ 名单缺席（/doctor） │ SSH ○○○○ 160ms │ … │ ⣿⣿ 3% │ pro ███ 84%`；**把终端缩窄**：先丢文字、保留图形，⚠ 最后才丢；**点击 ⚠** 应打开 `/doctor` | `tests/footer-chips.test.mjs`（含 3/12/24 列与点击） |
| B-2 `/mode` 分组与过滤 | `/mode`：官方在前、本地在后，每行带组名/`第 N 位`，broken 行显示原因；按 **`/`** 进入过滤（字母是快选键，故需显式进入），输入即筛；**Enter 应用**、再 Enter 作答；**Esc 只清过滤**不取消提问 | `tests/preset-picker.test.mjs`、`tests/mode-command.test.mjs` |
| B-3 配色三档 | `DSH_TUI_COLOR_DEPTH=8` 启动：diff 行应为**绿/红**（不是灰）；`=none`：完全无颜色但仍能看出 +/−、●/⚠/✖ | `tests/color-depth.test.mjs`（含 8 色帧内无 `38;2`/`38;5`、单色帧内无颜色参数） |

**B 批 mutation 记录**：B-1 共 7 组（芯片优先级/裁剪/点击行/事实采集等）· B-2 共 10 组（分组顺序、`order`、broken 原因优先、过滤忽略查询、大小写、移动越界、光标回夹、`/` 不进入、Enter 直接提交、Esc 取消提问）· B-3 共 4 组（不降级、色深恒真彩、none 仍留色、8 色放行真彩对）。每条变异都确认过**真的生效**（编译产物锚点不符时会静默不改，已按真实形状重做）。

## C 批 · 极简视图、diff、纯行模式、键位（逐项落地，每项一个检查点）

每项完成后在此追加一行：人工核对方式 + 自动证据 + mutation 记录。当前状态：

- C-1 极简视图对齐 Codex —— 待开工
- C-2 diff 增强 —— 待开工
- C-3 纯行模式（可访问性）—— 待开工
- C-4 键位可配置 —— 待开工
