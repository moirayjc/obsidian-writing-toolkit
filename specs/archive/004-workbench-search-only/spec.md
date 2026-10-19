---
id: "004"
title: "编辑台只保留全书搜索"
slug: "workbench-search-only"
size: M
status: done
created: "2026-10-19"
updated: "2026-10-19"
owners: ["Maureen"]
related:
  - AGENTS.md
  - docs/插件设计文档.md
  - src/workbench.ts
  - styles.css
---

# SPEC-004 · 编辑台只保留全书搜索

> 一句话：把编辑台搜索面板里的**替换**整条摘掉（替换输入、替换当前、全部替换，及其实现与样式），只保留**跨全书的关键字搜索**——因为 Obsidian 编辑器自带 Ctrl/Cmd+H 已经覆盖替换，插件内再养一套重复入口，却要为「直接改写全书正文」负责。
>
> 分级：M ｜ 状态：done ｜ 创建：2026-10-19

## 1. 问题与动机

编辑台的搜索面板当前是两行（`src/workbench.ts` 的 `renderSearchBar()`）：第一行搜索，第二行「替换为…」+「替换」+「全部」。用户实测后发现 Obsidian 编辑器自带搜索替换，插件内这一套是重复入口。用户原话：

> 我刚才试了一下，发现 Obsidian 的编辑器内自己就带了搜索替换功能，那么我编辑台那里的搜索替换功能其实就显得有点多余了。不过我打算保留这个搜索功能。但只有搜索功能。

替换与搜索的取舍并不对称，这是本次只砍替换的原因：

- **替换是编辑台里唯一会直接改写正文的功能**：`replaceAll()` 一次可跨文件改写全书命中（`src/workbench.ts`），风险与维护成本都远高于只读的搜索；真要批量改字，编辑器自带的 Ctrl/Cmd+H 有它自己的撤销与范围语义。
- **搜索不能一起砍**：编辑台的搜索是**跨全书**的（正文模式扫全部章节、设定模式扫全部资料，命中给片段与「全书 N 处」计数），与编辑器内的单文件查找不是一回事。
- **检查缺口**：`tools/checks/` 里没有任何脚本覆盖编辑台的搜索/替换，砍掉一半能力也没有回归防线。本次顺手补一条源码级检查，把「搜索在、替换无」固定住。

## 2. 用户场景

- 当我想知道某个人名 / 设定在全书哪些章节出现过时，我在编辑台搜索框输入关键字，看命中片段与「全书 N 处」，用 ↑↓ 一处一处跳过去。
- 当我要把某处用词统一改掉时，我在正文编辑器里用 Obsidian 自带的 Ctrl/Cmd+H，插件不再提供第二套替换入口。
- 当我点开编辑台的搜索面板时，我希望面板只有一行搜索框，不再有多出来的「替换」行占高度、也不再担心误点「全部」改写正文。

## 3. 需求

### 功能需求

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-001 | 编辑台搜索面板收缩为**一行**：搜索输入、清空按钮、命中片段、全书命中计数、上一处 / 下一处（含键盘）保持不变 | 必须 |
| FR-002 | 彻底移除替换能力：替换输入框、「替换」「全部」按钮，以及 `replaceCurrent` / `replaceAll` / `doReplaceAll` / `collectMatchOffsets` / `replaceAllInText` / `findMatchOffset` 等替换专有实现，不留不可达代码 | 必须 |
| FR-003 | 清理只服务于替换的状态与外围痕迹：`replaceQuery` 字段、`searchRevealAfterScan` 及其在 `scheduleSearch` / `scanSearch` / `clearSearchState` 里的分支、书头按钮提示语「搜索全书 / 替换」；`styles.css` 里桌面与手机端的替换规则一并删除 | 必须 |
| FR-004 | 搜索行为零回归：正文 / 设定两种范围的防抖扫描、命中片段、`全书 N 处`与`第 N 处`计数、↑↓ / Enter / Shift+Enter 循环定位、点击结果跳到命中并选中、`esc` 先清空再收起、书头按钮开合与 `is-active` 高亮 | 必须 |

### 非功能需求

| ID | 需求 | 说明 |
| --- | --- | --- |
| NFR-001 | 不新增 / 不修改设置项，`data.json` 不新增键、不改默认值 | 见宪法 #5 |
| NFR-002 | 不新增命令，命令面板仍是四条白名单 | 见宪法 #3 |
| NFR-003 | 模块边界不动：只改 UI Shell 的编辑台视图与其样式，不碰 Host / Services / 其它 Shell | 见宪法 #4 |
| NFR-004 | 样式外科手术式最小改动：只删替换规则，搜索规则与 `--wt-*` 令牌一律不动 | 见宪法 #8 |
| NFR-005 | 新增的自动检查必须做一次反向验证（把替换改回去，确认检查变红） | 见宪法 #12、[`../README.md`](../README.md) §7 |

## 4. 验收标准

| ID | 验收标准 | 验证方式 |
| --- | --- | --- |
| AC-001 | 面板结构：`src/workbench.ts` 里不再出现 `wt-wb-search-replace` / `wt-wb-replace` / `wt-wb-replace-btn` 与「替换为…」文案；`styles.css` 里不再有 `.wt-wb-replace` / `.wt-wb-search-replace` 规则（桌面与手机端都算） | 自动：`tools/checks/check-workbench-search.js` |
| AC-002 | 替换实现无残留：`replaceCurrent` / `replaceAll` / `doReplaceAll` / `collectMatchOffsets` / `replaceAllInText` / `findMatchOffset` / `replaceQuery` / `searchRevealAfterScan` 在 `src/workbench.ts` 里全部不存在 | 自动：`tools/checks/check-workbench-search.js` |
| AC-003 | 搜索能力保留：搜索输入与清空、`scanSearch` 全书扫描（读已打开编辑器的实时文本或 `cachedRead`）、`renderSearchSummary` 与命中计数、`stepSearchMatch` 上下定位、`revealSearchMatch` / `applyEditorSelection` 跳转选中、`toggleSearchPanel` 开合，均在源码中可查；`styles.css` 仍保留 `.wt-wb-search` / `.wt-wb-search-summary` / `.wt-wb-search-nav` | 自动：`tools/checks/check-workbench-search.js` |
| AC-004 | 命令面与数据面未被动到：命令仍为四条白名单；`data.json` 的数据键与设置加载约定不变 | 自动：`tools/checks/check-commandsurface.js`；自动：`tools/checks/check-module-contract.js` |
| AC-005 | 类型检查、构建与全部逻辑检查通过 | 自动：`npm run check`；`npm run verify` |
| AC-006 | 真机：Obsidian 打开编辑台 → 点书头搜索图标，面板只有一行搜索框（没有「替换为…」输入框，也没有「替换」「全部」按钮）；输入关键字后出现命中片段与「全书 N 处」，箭头按钮与 Enter / Shift+Enter 能在命中处循环定位并选中正文；`esc` 第一次清空、第二次收起；命令面板（Ctrl/Cmd+P）里仍只有四个插件入口 | 人工：Obsidian 中打开编辑台，按上述步骤逐项操作并观察（含鼠标悬停书头按钮，提示语应为「搜索全书」） |
| AC-007 | 真机：手机宽度（390×844 或 `body.wt-mobile`）下搜索面板为单行、高度正常，没有替换行移除后留下的空白；暗色 / 高对比度主题下搜索框、命中片段与上下定位按钮可读 | 人工：Obsidian 中用手机预览（或开发者工具收窄到 390 宽），分别在浅色、深色、高对比度主题下打开编辑台的搜索面板复看 |

## 5. 非目标

- 不改 Obsidian 编辑器自带的搜索替换（那是 Obsidian 的能力，不是本插件的）。
- 不把编辑台搜索从「跨全书扫描」改成「只搜当前文件」，也不新增正则 / 大小写 / 全词匹配等搜索选项。
- 不保留「隐藏的替换入口」或「替换开关」等变通做法——本次是彻底移除。
- 不动主页 / 工具箱 / 设置页，不动快照、批注、章纲等其它模块。

## 6. 影响面与约束

- 模块归属：UI Shell 的「编辑台」视图（`src/workbench.ts`）与其样式；不新增 Feature Module / Service，接口与边界不变。见宪法 #4。
- 数据与设置：无变化；`data.json` 不新增键。见宪法 #5。
- 命令面：不新增、不删除命令。见宪法 #3。
- 样式与手机端：只删替换规则（桌面 3 组 + `body.wt-mobile` 3 条），搜索规则与令牌不动；渲染与手机形态必须人工复看。见宪法 #8、#12。
- 自动检查：新增 `tools/checks/check-workbench-search.js` 并注册进 `tools/checks/run-all.sh`，需要反向验证。见宪法 #12。
- 回退成本：无数据迁移；要恢复替换，`git revert` 本次提交即可。

## 7. 开放问题

| 问题 | 结论 |
| --- | --- |
| 保留搜索会不会和编辑器内搜索重复 | 不重复：编辑台搜索跨全书（全部章节 / 设定）并给命中片段与全书计数，编辑器内搜索只针对当前文件 |
| 是否留一个隐藏替换入口 | 不留：用户明确「只有搜索功能」；需要替换时用 Obsidian 自带的 Ctrl/Cmd+H |

## 8. 评审记录

| 日期 | 状态变化 | 结论 / 备注 |
| --- | --- | --- |
| 2026-10-19 | — → draft | 用户提出：编辑器自带搜索替换，编辑台里的替换显得多余，只保留搜索 |
| 2026-10-19 | draft → approved | 用户确认范围与流程：按 M 级走 spec，摘掉替换 UI / 实现 / 样式，保留全书搜索，并新增一条自动检查 |
| 2026-10-19 | approved → implementing | 开工：改 `src/workbench.ts`（替换 UI / 6 个替换方法 / `replaceQuery` / `searchRevealAfterScan` / 书头提示语）与 `styles.css`（桌面 7 条 + 手机 3 条替换规则 + 2 处注释），并新增 `tools/checks/check-workbench-search.js` 注册进 `run-all.sh` |
| 2026-10-19 | implementing → verifying → done | 新检查 25/25（红测 11/24）、`npm run verify` 41 项全绿、独立复验通过（替换符号零残留、搜索链路逐条对齐基线）；用户真机确认「搜索面板确实只有一行，没有替换，已经可以了」；证据与文档更新全部勾选，归档 |
