# SPEC-001 · 技术方案

> 需求与验收见 [`spec.md`](spec.md)，任务与证据见 [`tasks.md`](tasks.md)。

## 1. 方案概述

高对比度主题有两层实现：

1. `styles.css` 里的 `body.wt-theme-contrast` 令牌块与组件规则（插件视图渲染后的主样式）；
2. `src/themeSnippet.ts` 生成的首帧 CSS 片段（在插件 JS 生效前压住底色，防止闪回暖纸）。

换肤时**两边必须同步**：片段带 `!important` 且先于插件生效，只改 `styles.css` 等于没改。
因此方案是「一套令牌、两处写入、一处检查」：令牌在 `styles.css` 定义；片段只镜像首帧需要的
15 个主令牌、热力图与面板底色；新增 `check-theme-palette.js` 解析两边并逐令牌比对。
新增的组件令牌（`--wt-action` / `--wt-selected` 等）只留在 `styles.css`，不进片段。

**模块归属**：只动 `styles.css` 与 `src/themeSnippet.ts`；`appearance.typography`（Feature Module）
不改，仍负责挂载 / 停用片段；不涉及 Host、Services、UI Shell。
**数据与设置**：无 `data.json` 结构变化，无新增设置项；`themeTone` 取值仍为 `warm | cool | contrast`；
首帧缓存仍用 `localStorage["wt-theme-tone-cache"]`，不新增键。

手机端与窄屏问题是同一个根因的两面：桌面组件规则只覆盖 `.wt-*` 页面，手机端有独有的 DOM；
窄屏下 Obsidian 的容器查询会把 `.setting-item` 改成 `column` 布局，`flex-basis` 从「宽」变成「高」。
修法都是**在 `body.wt-mobile` 段补覆盖**，而不是改桌面规则。

**淘汰的方案**：① 只把令牌抽成一份、运行时注入——片段必须在首帧前生效，运行时注入来不及；
② 新增第五种配色主题——用户要的是「高对比度换皮」，不是新主题。

## 2. 影响与兼容

- **旧版本升级**：主题设置值不变，无迁移。
- **模块禁用**：`appearance.typography` 停用时片段被移除，页面回落到 `styles.css` 默认暖纸；既有行为，本次不改。
- **桌面 / 手机**：桌面组件规则 + `body.wt-mobile` 覆盖；手机端无法自动验证，必须人工预览。
- **多端同步（三方同步盘）**：只改样式与片段，不写 `data.json`，无冲突面。

| 风险 | 防线 / 回退 |
| --- | --- |
| 只改 `styles.css` 忘了同步片段 | `check-theme-palette.js` 逐令牌比对；反向验证确认会变红 |
| 组件令牌误进片段，首帧出现不应有的形态 | 只把首帧需要的纸面 / 文字 / 热力图令牌写进片段；其余留 `styles.css` |
| 窄屏覆盖选择器特异性不够 | `body.wt-mobile` + `.modal.mod-settings` 前缀；`check-settingcontrols.js` 断言兜底 |
| 手机端漏改独有 DOM | Console 里给 `body` 加 `wt-mobile` 后逐页检查底部导航 / FAB / 状态条 |
| 样式大范围重写 | 按宪法 #8：最小改动 + `_backup/` 快照 |

## 3. 实施与验证顺序

1. `styles.css` 高对比度令牌块换成 Notion 取色（浅 / 深），补组件令牌。
2. `themeSnippet.ts` 的 `CONTRAST` 片段同步。
3. 组件形态规则（按钮 / 开关 / 标签 / 选中态 / 输入框 / 行分割线）。
4. 手机端三处对齐（底部导航 / FAB / 状态条）。
5. 窄屏设置页 `flex-basis` 与 `border-radius` 修正。
6. 新增 `check-theme-palette.js`；`check-settingcontrols.js` 补 3 条 CSS 断言；做反向验证。
7. 更新设计文档 §3.5 / §3.6.2.1 / §3.6.3 / §4.9，并在 Obsidian 做人工回归。

**验证策略**：自动——`check-theme-palette.js`（令牌同步）、`check-settingcontrols.js`（窄屏 / 圆角）、
`check-commandsurface.js` / `check-boundaries.js`（命令面未被顺手改动）。
反向验证——拿一份改坏令牌的 `styles.css` 副本跑 `check-theme-palette.js`（`WT_THEME_CSS` 环境变量），
确认从 27/27 变红。人工——桌面浅色 / 深色四页、手机 390×844 三处、窄屏设置页、冷启动首帧。
**覆盖不了**：真实手机、不同输入法、第三方主题下的观感——只能人工确认。
