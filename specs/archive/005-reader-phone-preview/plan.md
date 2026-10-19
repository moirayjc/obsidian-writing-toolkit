# SPEC-005 · 技术方案

> 只在 **L 级**规格使用。需求与验收在 [`spec.md`](spec.md)，任务与证据在 [`tasks.md`](tasks.md)。
> 本文件只写「怎么做」，三节必填。

## 1. 方案概述

**整体做法**：新增一个自包含的 UI 文件 `src/mobilePreview.ts`（`MobilePreviewModal extends Modal`），Host 负责把「章节 → 模型」的取数拼好再打开它。数据流是单向的：

```text
编辑台（UI Shell）                     Host（main.ts）                      预览弹窗
书头手机按钮 / 菜单项  ──actions.openPhonePreview(path)──▶  解析章节序列 + 读正文  ──▶  MobilePreviewModal
                                                           cleanChapterText()          三组偏好只存实例字段
                                                           countWords()
```

- **取数**：`openPhonePreview(path)` 复用 `copyCleanChapter` 的数据源选择（打开中的编辑器取实时文本，否则 `cachedRead`），失败/为空时用与复制一致的 `Notice` 提示并中止；章节序列与序号来自 `ProjectIndexService` + `allChapters()`，找不到作品时退化为「单篇、无翻章」。
- **文本**：`copyCleanChapter` 里那两行载荷处理抽成 `formatWrap.ts` 的 `cleanChapterText()`，复制与预览共用，避免两套清洗逻辑漂移。预览只按行切段（空行合并），段首缩进交给 CSS（`text-indent: 2em`），**不改动文本本身**。
- **渲染**：弹窗自己维护 `device / theme / font` 三个实例字段与一个 `model`，任何切换只更新已建 DOM 的属性（`data-device` / `data-theme` / `data-font` 与 `is-active` 类），不重建正文 DOM，因此滚动位置天然不丢。
- **样式**：`styles.css` 追加一段 `.wt-phone-*`，只服务这个弹窗。机身/底纹三色是**阅读器自己的配色**（不跟随 Obsidian 主题，否则就不是「读者的手机」了），弹窗外壳与工具栏仍走 `--wt-*` 令牌，保证暗色下不脏。

**淘汰过的方案**：

1. **做成新的 Feature Module**（`features/mobilePreviewModule.ts`）——淘汰。预览是无状态、短生命周期的弹窗，没有需要 `activate/deactivate` 的资源；而 `check-module-contract.js` 把「12 个模块」写成了稳定契约，为一次 UI 功能改动去动模块契约不划算。改为「UI Shell → `UiShellActions` 显式端口 → Host 装配 → 独立 UI 文件」，与既有 `outlineModal.ts` / `snapshotDiff.ts` 同级。
2. **复用 `body.wt-mobile` 那套预览**——淘汰。它预览的是插件自己的界面形态（抽屉/底栏/FAB），与「读者手机里的正文」不是一回事；套上去还会把整个 Obsidian 界面挤成手机布局。
3. **渲染 Markdown（`MarkdownRenderer`）**——淘汰。读者在平台上看到的是纯文本；渲染反而会掩盖 `#`、`**` 这类会被平台原样显示的东西。
4. **做成第三个主页/侧栏面板**——淘汰。预览是临时看一眼的动作，弹窗最轻；主页面是常驻工作区，会挤占布局与工作区状态。
5. **把字号/底纹存进 `data.json`**——淘汰。为一个观感工具动数据面（还要处理默认值与迁移）不值，本次偏好只存内存。

## 2. 影响与兼容

- **旧版本升级**：无数据结构变化，`loadPluginData` 与 `DEFAULT_SETTINGS` 一字不动，不存在丢配置风险。
- **模块禁用 / 插件重载**：弹窗是 `Modal`，关闭即销毁；不注册全局监听、不注册编辑器扩展、不注册视图，重载后无残留。真机判断在渲染入口处，桌面/手机行为不同但不互相影响。
- **桌面 / 手机**：桌面显示入口；`Platform.isMobile` 时按钮与菜单项都不渲染（真机上点不到）。`body.wt-mobile` 的桌面模拟态不是真机，仍可打开预览——不额外拦，因为它同样在看「正文」，不会误导。
- **多端同步（三方同步盘）**：不产生任何新文件，无冲突面。
- **风险 → 防线 / 回退**：
  - 复制行为被抽函数改坏 → 抽函数必须**逐字搬运**原两行处理，并由 `check-mobilepreview-module.js` 断言 `copyCleanChapter` 仍走 `cleanChapterText`；人工回归里保留「复制一章正文」一步。
  - 大章节卡顿 → 只做一次 `textContent` 级渲染，不做逐字测量；滚动交给浏览器原生滚动容器（`overflow: auto`）。
  - 暗色主题下手机框发脏 → 框内三底纹用固定色，弹窗外壳走令牌；无头 Chrome 各出一张浅/暗截图对比。
  - 样式影响面溢出 → 所有选择器都以 `.wt-phone` 前缀限定在弹窗内，不改既有 `.wt-wb-*` / `body.wt-mobile` 规则。
  - 整体回退 → 移除书头按钮与端口即可停用；`git revert` 可完全回退（无数据迁移）。

## 3. 实施与验证顺序

1. **契约先行**：先写 `tools/checks/check-mobilepreview-module.js` 并注册（队友执行），跑一次**红测**——`src/mobilePreview.ts` 尚不存在时必须红，作为反向验证证据。
2. **文本管线**：`src/formatWrap.ts` 抽出 `cleanChapterText()`，`main.ts` 的 `copyCleanChapter` 改为调用它（行为字节级不变）。
3. **预览弹窗**：`src/mobilePreview.ts`（模型接口、三组常量、DOM 构建、切换与翻章）。
4. **端口与取数**：`src/uiShellContext.ts` 加 `openPhonePreview`；`main.ts` 实现取数 + 打开，含空/缺文档提示。
5. **入口**：`src/icons.ts` 加 `wt-phone`；`src/workbench.ts` 加书头按钮（真机隐藏）、书头菜单项、章节行菜单项。
6. **样式**：`styles.css` 追加 `.wt-phone-*`（外框/状态栏/阅读顶栏/正文/底栏/工具栏/三底纹/四字号/两机型/暗色适配）。
7. **验证**：
   - 自动：`node tools/checks/check-mobilepreview-module.js`（红→绿）、`npm run check`、`npm run build`、`npm run verify`（含 `check-commandsurface` / `check-module-contract` / `spec:check`）。
   - 渲染证据：队友用无头 Chrome 按 `_backup/spec005-accept/` 的 harness 出图（iPhone/安卓 × 白纸/米黄/夜间 + 浅/暗外壳）。
   - 独立复验：另一名队友只读复跑 + 对抗性审计（只读性、边界、入口真机判断、模块契约）。
   - 覆盖不了、必须人眼看的：真机点按手感、字号观感是否合适、`esc` 与滚动位置、真实手机端入口不出现（AC-007 / AC-008）。
8. **收尾**：回填 `tasks.md` 证据、更新 `docs/插件设计文档.md` 与 `README.md`、推进状态并归档。
