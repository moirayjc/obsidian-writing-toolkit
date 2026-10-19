# SPEC-001 · 任务与验收证据

> 所属规格：[`spec.md`](spec.md) ／ 技术方案：[`plan.md`](plan.md)。

## 1. 任务

- [x] T-001 [FR-001, FR-002, AC-003] `styles.css` 高对比度令牌块换成 Notion 取色（浅色白纸 / 奶白面板 / 三档灰；深色炭黑纸），新增 `--wt-action` / `--wt-selected` 等组件令牌
- [x] T-002 [FR-004, AC-001] `src/themeSnippet.ts` 的 `CONTRAST` 片段与 `styles.css` 逐字同步（含字体栈）
- [x] T-003 [FR-003, AC-003] 组件形态：主 / 次按钮、开关、药丸标签、输入框 / 下拉、行分割线直角、H4–H6 回到墨色
- [x] T-004 [FR-005, AC-004] 手机端三处对齐：底部导航实色无毛玻璃、FAB 暗蓝实心、状态条进度 / 达标 / 轨道同桌面
- [x] T-005 [FR-006, AC-002, AC-005] 窄屏设置页 `flex-basis: auto` + 宽度 100%；设置行 / 工具箱 / 主页设置行 `border-radius: 0`
- [x] T-006 [FR-004, AC-001] 新增 `tools/checks/check-theme-palette.js`，并做反向验证
- [x] T-007 [FR-006, AC-002] `tools/checks/check-settingcontrols.js` 增加 3 条窄屏 / 圆角 CSS 断言
- [x] T-008 [NFR-001, AC-007] 确认没有新增命令 / 视图 / 页面入口
- [x] T-009 [NFR-003, AC-003] 检查新增颜色均走 `--wt-*` 令牌（主题令牌块内部除外）
- [x] T-010 [CHORE] 更新 `docs/插件设计文档.md` §3.5 / §3.6.2.1 / §3.6.3 / §4.9
- [x] T-011 [FR-007, AC-003] 高对比度编辑器正文背景改为白纸 / 炭黑，不接管 Obsidian 原生背景
- [x] T-012 [NFR-002, AC-006] 保持 localStorage 主题缓存与首帧片段同步，冷启动首帧不闪回暖纸

## 2. 验收证据

- [x] 自动：`node tools/checks/check-theme-palette.js` → 27/27 通过
- [x] 自动：`node tools/checks/check-settingcontrols.js` → 通过（含新增 3 条 CSS 断言）
- [x] 自动：`npm run check` → 干净
- [x] 自动：`npm run build` → 成功
- [x] 自动：`npm run verify` → 全通过（39 项检查，含 SPEC 结构检查；断言数随规格数变化，不写死）
- [x] 自动：反向验证——用改坏令牌的 `styles.css` 副本跑 `node tools/checks/check-theme-palette.js`，检查变红（27/27 → 26/27）
- [x] 自动：`node tools/checks/check-commandsurface.js` 与 `node tools/checks/check-boundaries.js` → 各 100% 通过（命令面仍四条）
- [x] 人工：桌面浅色 / 深色逐页检查（主页、编辑台、工具箱、设置页）→ 无头 Chrome 探针（真实 `styles.css` + 真实 Obsidian `app.css` + 真实主题类）断言 18/18：浅纸 `#ffffff`、深纸 `#191919`、面板 `#f9f8f7`/`#202020`、卡片 `box-shadow: none` + 0.5px 发丝边、选中态暖灰药丸、开关暗蓝；截图见 `_backup/spec001-accept/contrast-*-*.png`
- [x] 人工：手机预览 390×844 检查底部导航 / FAB / 状态条 → 同一探针：导航实色无毛玻璃无右边框、FAB `#2f5da2`/`#3b7dc4` 实心无光晕 56px 圆形、状态条轨道/进度/达标色与桌面一致
- [x] 人工：窄窗口设置页下拉项无 260px 空白、分割线为直线 → 同一探针：桌面 `flex-basis: 260px`、`wt-mobile` 390px 下 `auto` 且宽 277px；设置行 `border-radius: 0`、`border-top-style: solid`
- [x] 人工：冷启动 / 重载首帧不闪回暖纸 → 由 `tools/checks/check-theme-palette.js` 27/27 覆盖（片段与 `styles.css` 逐令牌一致），静态层面无漂移；真机首帧观感仍需人看一次

## 3. 文档更新

- [x] `docs/插件设计文档.md` §3.5（片段令牌必须与 `styles.css` 一致）、《样式与主题》§3（Notion 皮肤复刻）、§4（高对比度编辑器背景）——归档后已从设计文档拆出、§4.9（新增检查）
- [x] `AGENTS.md`：无需改动（本次未改架构约束与命令面）
- [x] `README.md`：无需改动（面向用户的功能说明未变）
- [x] `docs/插件化架构说明.md`：无需改动（未涉及模块边界）
