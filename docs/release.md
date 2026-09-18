# 发版流程（硬性规则）

> 本文件是**规则**，不是建议。任何自动化助手、脚本或维护者在发版前都必须先读它。

## 三条规则

1. **只有用户明确要求发版时才发版。**
   用户的指令里**没有**"发版 / 发布 / release / 发 npm / 打 tag"这类字样时，
   **不得**执行任何发版动作：不改版本号、不打 tag、不推 Release、不动 npm。
   修完 bug、跑完验收、推送到 GitHub 分支——到此为止，然后等指令。

2. **顺序固定：先 GitHub，后 npm。**
   发版请求先落到 GitHub：版本号提交 → 推送 `main` → 打 `vX.Y.Z` tag → 推 tag。

3. **CI 四条腿全绿，才允许碰 npm。**
   tag 推上去后确认 CI（`test (0.1.5-rc.2)`、`test (0.1.5-rc.1)`、`test (0.1.2-rc.1)`、
   `test-windows`）**全部 success**，再 `npm publish`。
   CI 红着就把包发出去，等于把一个未验证的版本交给所有 `@next` / `@latest` 用户。

## 允许 / 不允许

| 动作 | 未要求发版时 | 已要求发版时 |
|---|---|---|
| 改 `package.json` 版本号 | ✗ | ✓ |
| 推 `main`（提交修复/文档） | ✓ | ✓ |
| 打 `vX.Y.Z` tag | ✗ | ✓（CI 绿之前只是 tag，不发 npm） |
| 建 GitHub Release | ✗ | ✓ |
| `npm publish` / 改 dist-tag | ✗ | 仅 CI 全绿后 |

## 事故记录：0.7.0-rc.2 的 npm 误发（2026-09-16）

B-1 回归修复完成后，助手在用户给出"先不急着发 npm"的指示**之前**已经执行了
`npm publish --tag next`（0.7.0-rc.2），并把 tag 推到了 GitHub。用户随后明确要求：
**先只提交 GitHub，C 批尚未验收，不要动 npm。**

处置：
- `npm dist-tag add dsh-ssh-tui@0.7.0-rc.1 next` —— `next` 已回退到 rc.1，
  用户不会通过任何 tag 拿到 rc.2（注册表实测 `{ latest: '0.6.4', next: '0.7.0-rc.1' }`）；
- `0.7.0-rc.2` 的 tarball 仍存在于 npm（无 tag 指向），是否 `npm unpublish` 由用户决定
  （注意：unpublish 后该版本号 24 小时内不可重用）；
- GitHub 侧保留提交与 tag（用户明确允许"只提交 github"）。

教训：把"发版"当成**需要显式授权的动作**，而不是"交付完成的自然收尾"。

## 发版窗口怎么定

选日期看的是热度曲线，不是感觉：GitHub 的 traffic 只留 14 天，发版脉冲 24–48 小时就衰减，
所以「再等几天」换不到信号。采集与读表方式见 [heat-tracking.md](heat-tracking.md)
（`node scripts/heat-report.mjs`，每周一次，数据落在 `$DSH_HOME/heat/`，不进仓库）。
