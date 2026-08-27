# 竞争力提升计划

社区 TUI 已经有明确赢家（`dsh-TUI` 两千星、周下载两万）。本仓库不和它比皮肤、官网、星标。
要守住的是更窄、更硬的场景：**慢速 SSH / 远程机器上的原生终端 dsh**。

`dsh-llm-xai-oauth` 不单独做爆款。社区同类 Grok OAuth 插件已经很多，独立发布几乎没有分发优势。它应作为 TUI 的远程订阅附件：本机已有 SuperGrok token 时，SSH 会话能像官方 DeepSeek 一样选 `xai/grok-4.6`。

## 现在就能做（0.2.x）

1. 把子代理独立折叠卡、计划/提问/目标显示发到 GitHub 和 npm。这是相对 `dsh-TUI` 的真实差异，不发就等于没有。
2. README 把第一句话改成场景，而不是功能清单：远程 SSH、无浏览器、增量重绘。补一张慢链路截图或录屏。
3. 发布说明写清「适合谁」：跳板机、无桌面服务器、高延迟终端；不写「Claude Code 平替」。
4. xAI 插件保持窄：复用 `~/.grok-bridge/auth.json`，不重做 Web 一键登录和额度大盘。

## 随后一个版本（0.3）

1. TUI `/model` 能切 provider，而不只切当前路由下的模型。远程机器上这比主题更重要。
2. `/status` 和帮助里标明当前是 DeepSeek 还是 Grok 订阅，避免用户以为没接上。
3. 给 xAI 插件一个公开仓库，但 README 指向 TUI 安装路径，不单独做品牌站。
4. CI：typecheck + `node --test`。门面比再堆功能先有用。

## 明确不做

- 不用 Ink/React 重写成第二个 `dsh-TUI`。
- 不追 16 套主题、独立官网、公众号运营去抢第一名。
- 不把 xAI 插件做成「全订阅聚合」（Codex + Claude + Grok）。那条赛道已经拥挤，且 TUI 场景用不上那么多登录 UI。

## 成功标准

- SSH 会话里子代理/计划/提问卡片默认折叠、可快捷键展开，状态栏有运行动画。
- `dsh --profile tui` 能直接走本机 Grok OAuth，headless 冒烟通过。
- npm 有对应稳定版本；GitHub README 能让人 30 秒判断这是不是自己要的 SSH 插件。
