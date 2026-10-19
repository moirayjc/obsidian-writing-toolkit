# SPEC-005 · 任务与验收证据

> 所属规格：[`spec.md`](spec.md)。任务格式：`- [ ] T-001 [FR-001, AC-001] 做什么（改哪个文件 / 模块）`；
> 纯杂务用 `[CHORE]`（不许夹带不存在的 ID）。每个 FR / AC 至少要有一条非 CHORE 任务覆盖。

## 1. 任务

- [x] T-001 [AC-001, AC-002, AC-003, AC-004, NFR-007] `tools/checks/check-mobilepreview-module.js` + `tools/checks/run-all.sh`：新增源码级检查（常量 / DOM 契约 / 端口 / 单一文本管线 / 只读守卫 / 命令面 / 设置键），注册进 run-all.sh，先跑红测（11/55）
- [x] T-002 [FR-003, AC-003] `src/formatWrap.ts` + `src/main.ts`：抽出并共用 `cleanChapterText()`，`copyCleanChapter` 行为不变；再把「读一章实时正文 + 空/缺失提示」抽成 `readChapterText()` 供复制与预览共用
- [x] T-003 [FR-002, FR-003, FR-004, FR-006, AC-002] `src/mobilePreview.ts`（新）：`MobilePreviewModal`、`PHONE_FONTS` / `PHONE_THEMES`、手机外框与阅读器结构、按行分段、切换即时生效且不丢滚动位置（需求变更后移除机型切换）
- [x] T-004 [FR-005, FR-006] `src/mobilePreview.ts` + `src/main.ts`：章节序列解析与上一章/下一章翻章、首末章禁用、单篇文档退化（复验 F-1 后改为可变游标）
- [x] T-005 [FR-001, AC-001, AC-004] `src/uiShellContext.ts` + `src/main.ts`：`UiShellActions.openPhonePreview(path)` 端口与实现（含「找不到文档」「文档为空」提示与真机兜底）
- [x] T-006 [FR-001, AC-001] `src/workbench.ts` + `src/icons.ts`：书头手机图标按钮（`Platform.isMobile` 隐藏）、书头菜单项、章节行右键/长按菜单项；`wt-phone` 图标
- [x] T-007 [FR-002, FR-004, NFR-005, AC-007] `styles.css`：`.wt-phone-*` 全部样式（外框/状态栏/阅读顶栏/正文排版/底栏/工具栏/三底纹/四字号；弹窗自带颜色令牌，见踩坑 52）；需求变更后外框改为**单一形态 + 高度自适应**（`aspect-ratio: 390/844`、`height: min(calc(100vh - 170px), 72vh, 720px)`），保证整台手机一屏可见
- [x] T-012 [FR-002, FR-004, AC-002, AC-007, AC-008] 需求变更（用户真机反馈）：去掉苹果/安卓机型切换（`PHONE_DEVICES` / `data-device` 全删，检查脚本改为反向守卫「不许再出现机型标识」）；手机框改为一屏可见的自适应尺寸
- [x] T-008 [AC-007] 渲染证据：`~/Documents/WT-Test-Vault/_backup/spec005-accept/` 下用无头 Chrome 出图（三底纹 × 浅/暗宿主 + 四档字号 + 工具栏特写 + 两张「一屏可见」验证图），并按首轮结果修掉辅助文字对比度与暗色选中态
- [x] T-009 [AC-005, AC-006] 跑 `npm run check`、`npm run build`、`npm run verify`，确认命令面与模块契约未变、全部检查通过
- [x] T-010 [AC-008] 真机回归：桌面端点书头手机图标、切字号/底纹、翻章、`esc`；真实手机端入口不出现
- [x] T-011 [CHORE] 文档：`docs/插件设计文档.md`（视图表 + 踩坑 52/53）、`README.md` 功能列表（`specs/README.md` §9 归档表在归档时补）

## 2. 验收证据

- [x] 自动：`node tools/checks/check-mobilepreview-module.js`（反向验证）→ 实现前 `src/mobilePreview.ts` 尚不存在，退出码 1、`→ 11/55 通过`（44 条全部变红）；补 F-2/F-3 断言后又在 `/tmp/wt-check-f2` 同构副本做过两次突变：删一处 `new Notice("找不到这篇文档")` → `57/58`、新断言变红（报错行「缺少 new Notice：找不到这篇文档」）；把 `if (!Platform.isMobile) {` 改成 `if (true) {` → `57/58` 红（「只有 2 处 gate」）；还原后副本与真仓库 diff 0 行
- [x] 自动：`node tools/checks/check-mobilepreview-module.js`（实现后）→ `→ 56/56 通过`、exit 0（A 5 + B 24 + C 7 + D 7 + E 10 + F 3；需求变更去掉机型后由 58 条收敛为 56 条，机型相关三条断言改成一条反向守卫）
- [x] 自动：`npm run check` → 干净（`tsc --noEmit` 无输出）
- [x] 自动：`npm run verify` → 全部通过 41 项（spec:check 90/90）；其中 `check-commandsurface.js` 24/24（命令仍四条）、`check-module-contract.js` 10/10（12 模块、DEFAULT_SETTINGS 33+6、data.json 18 顶层键）、SPEC-004 回归 `check-workbench-search.js` 25/25
- [x] 自动：独立复验（verifier，只读、零改动）→ 复跑 check 55/55→58/58、`npm run check` 干净、`npm run verify` 41 项全绿；DOM↔CSS 双向 1:1（21 个类名无单向缺失、`.wt-phone-p` 确在 `<p>` 上、`[data-theme]`/`[data-font]` 挂载点正确）；切换只走 `applyVisualState()` 不重建正文 DOM；只读边界成立（`mobilePreview.ts` 不引用 app/vault/editor）；证伪：重建实现前树 → `11/55` 与红测数字一致。**并抓出 F-1（翻章游标）**：修复后重放 6 章序列实测 `3→4→5→4→3`、首末章停住、单篇无翻章、出错不推进游标；`step()` catch 注入 reject 后不抛错、busy 正常复位、出错后可继续翻章
- [x] 人工：渲染证据（AC-007）→ `~/Documents/WT-Test-Vault/_backup/spec005-accept/`（`harness.html` + `shoot.sh` + `fit-check.py` + `README.md` + `manifest.txt` + 11 张 PNG，绑定 Chrome 155 与 styles.css sha `5511b4db1607`）：**一屏可见实测通过**——`fit-900`（视口 1280×900）机身 648 高、底栏底边 y=806 < 900；`fit-800`（1280×800）机身 576 高、底栏底边 y=720 < 800，两张里「上一章 / 第 1/24 章 / 下一章」完整可见、机身圆角未被裁、弹窗未触底未滚动；**去机型已到位**（工具栏只剩字号 + 底纹两组，无 `data-device` / iPhone / 安卓残留，9 张 tight 图尺寸完全一致：机身 333×720、屏幕 315×702）；宽高比恒 0.462 等比缩放不压扁；对比度全 AA（正文 14.68 / 9.88 / 10.45，顶栏副行与底栏 info 5.13 / 5.12 / 6.32，hint 5.97 / 8.21）。首轮还抓出两处并已修：辅助文字原 2.4–3.7:1 不达小字 AA、暗色下 chip 选中态仅 1.07:1：像素量机身 = 844 / 800（屏幕 822 / 778）、三底纹正文对比度 15.18 / 10.50 / 11.24:1、四档字号 15/17/19/22 与行距 1.78–1.86、2em 缩进、两机型无横向溢出、暗色宿主下手机框不脏；**首轮抓出两处并已修**：辅助文字（阅读顶栏副行、底栏章节号）原 2.55 / 2.41 / 3.65:1 不达小字 AA → 加深 `--wt-phone-sub` 并抬到 12px；暗色宿主下 chip 选中态与组底仅 1.07:1 → 新增 `--wt-phone-chip-on`（暗色用 hover 档）+ 内描边；hint 行 11px 用 `--text-faint` 仅 2.30 / 2.90:1 → 抬到 12px 并改用 `--wt-ink-2`）。**最终轮（`styles.css` sha `252e55dc0f62`，Chrome 155）实测**：辅助行 5.13 / 5.12 / 6.32:1、hint 6.69 / 7.95:1、选中胶囊文字 9.71:1、正文 15.18 / 10.50 / 11.24:1 —— AA 小字无剩余不达标项；15 张机身尺寸与标称一致（探针不一致数 0），无破版与横向溢出
- [x] 人工：真机回归（AC-008）——用户在 Obsidian 里实测后确认（2026-10-19 原话「可以了」，此前已反馈「有是有了」并据此完成两轮需求变更：去掉机型、改成一屏可见）：桌面端书头手机图标可打开预览、整台手机一屏可见、字号与底纹切换即时生效、翻章可用；真机入口隐藏由 `Platform.isMobile` 三处 gate 与 `check-mobilepreview-module.js` 的 F3 断言共同守住

## 3. 文档更新

- [x] `docs/插件设计文档.md` §3.3 视图表补「读者手机预览」；§5.2 补踩坑 52（颜色令牌只挂在四个页面上，弹窗里取不到）与 53（预览是纯文本阅读器、三底纹不跟随主题、桌面端专属、只读）
- [x] `AGENTS.md`：无：本次未改架构约束、命令面与数据约定
- [x] `README.md` §2 编辑台功能列表补「📱 读者手机预览」
