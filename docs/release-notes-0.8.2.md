# 0.8.2 发版说明

> **发布方式：`latest` + `next`。** 上一次发版：**0.8.1**（2026-09-30，`latest` + `next`）。
> 本版由 **0.8.2-rc.1**（2026-10-04 只上 `next`）沉淀一周后转正：候选版期间没有收到新的回归报告，
> CI 五条腿与全部真 PTY 探针持续全绿，Windows / ConPTY 实机人工验收也已完成（见
> [`checkpoints.md`](checkpoints.md)「Windows 实机轮」）。**内容与 0.8.2-rc.1 完全相同**，
> 逐项说明见 [`release-notes-0.8.2-rc.1.md`](release-notes-0.8.2-rc.1.md)。

> `dsh-ssh-tui` is now presented as DSH Relay.
> The npm package name and the install command have not changed.
>
> **`dsh-ssh-tui` 现在以 DSH Relay 为产品名展示；npm 包名与安装命令没有变化。**
> 发布坐标仍是 `dsh-ssh-tui`，安装命令仍是
> `dsh plugin --profile tui add dsh-ssh-tui@latest`。依据：[`decisions/brand-dsh-relay.md`](decisions/brand-dsh-relay.md)。

## 头等事：全新安装**第一次就会出现配置向导**（此前根本不会出现）

0.8.1 及以前，一台没有任何配置的机器上装好插件、启动 `dsh --profile tui`，看到的是一个空工作区、
一行提示都没有，模型调用必然失败——**配置向导永远不会自动出现**。原因是前端拉起的 Host 永远带
`--resume=<id>`（连它自己刚铸的新 id 也带），而首启判定把 `resume` 当成"这台机器配置过"。
0.8.2 起只看凭据存不存在。详见候选版说明第一节。

## 另外两件用户直接看得见的事

- **resume 不再有一段 1–3 秒黑屏**：进屏序列现在跟着第一帧一起发出，加载提示全程在屏
  （20k 事件实测：清屏与落地同一 tick，此前中间有 3.5 秒全黑）。
- **思考卡片不再发白**：`reasoning` 角色此前只写属性、不写颜色，"暗"完全靠 faint；不实现 faint 的终端
  会退回默认前景色。四个调色板现在各自给出 muted 颜色。
- **链路那一格不再把"绘制节奏"当延迟**：终端不回 `CSI 6n` 时显示 `未测` / `n/a`，不再印一个看起来像
  测量值的 160ms。

## 兼容

上游兼容窗口与 0.8.1 相同：`0.2.0-rc.1` / `0.2.0-rc.2` / `0.1.7-rc.1` / `0.1.7-rc.2`。
**0.1.5 及更早的宿主不再支持。** 本版不改协议、不加命令、不动上游接口。

## 安装 / 升级

```sh
dsh plugin --profile tui add dsh-ssh-tui@latest
```

装完退出再启动。`/status` 可确认当前版本；装不上先看 `/doctor`。
更新时请显式带 `@latest`，否则已有 lockfile 可能继续沿用旧版本。

## 实测数字（本版，100×20）

| 动作 | 毫秒（中位） | 字节 | 寻址行 | 全屏清屏 |
|---|---|---|---|---|
| 流式 delta | 1.47 | 501 | 3 | **0** |
| 等待卡时钟 | 1.26 | 465 | 3 | **0** |
| 报告屏翻页 | 1.40 | 2457 | 17 | **0** |
| 菜单光标移动 | 1.09 | 588 | 4 | **0** |
| 向导字段打字 | 0.25 | 140 | 1 | **0** |

复现：`npm run bench`；README 里的同一张表由 `npm run bench:report` 从这次真跑生成。

## 已知问题

见候选版说明的「已知限制」一节。要点：Windows / ConPTY 实机人工验收**已完成**（12 项清单；
两处 ConPTY 盲区在探针里显式 `SKIP` 并在 Linux 腿上真跑，`SKIP` 不算通过）；`未测` 那一格在
Windows 本机看不到（ConPTY 代答光标位置），由管道父进程形状的探针覆盖。
