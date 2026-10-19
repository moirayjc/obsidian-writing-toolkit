# SPEC-004 · 任务与验收证据

> 所属规格：[`spec.md`](spec.md)。任务格式：`- [ ] T-001 [FR-001, AC-001] 做什么（改哪个文件 / 模块）`；
> 纯杂务用 `[CHORE]`（不许夹带不存在的 ID）。每个 FR / AC 至少要有一条非 CHORE 任务覆盖。

## 1. 任务

- [x] T-001 [FR-001, FR-004, AC-001] `src/workbench.ts`：`renderSearchBar()` 去掉整行替换 UI（`wt-wb-search-replace` / `wt-wb-replace` / `wt-wb-replace-btn`），面板只剩搜索一行；`toggleSearchPanel()` 去掉替换复位与「查找替换」措辞
- [x] T-002 [FR-002, AC-002] `src/workbench.ts`：删除 `replaceCurrent` / `replaceAll` / `doReplaceAll` / `collectMatchOffsets` / `replaceAllInText` / `findMatchOffset` 与 `replaceQuery` 字段
- [x] T-003 [FR-002, FR-003, AC-002, AC-003] `src/workbench.ts`：删除只服务于替换后自动定位的 `searchRevealAfterScan` 及其在 `scheduleSearch` / `scanSearch` / `clearSearchState` 里的分支；确认 `stepSearchMatch` → `revealSearchMatch` → `applyEditorSelection` 链路不受影响
- [x] T-004 [FR-003, NFR-004, AC-001] `styles.css`：删除桌面 3 组替换规则（`.wt-wb-search-replace` / `.wt-wb-replace` / `.wt-wb-replace-btn`）与 `body.wt-mobile` 下 3 条替换规则；搜索规则与 `--wt-*` 令牌不动
- [x] T-005 [FR-003, AC-006] `src/workbench.ts`：书头搜索按钮 title 由「搜索全书 / 替换」改为「搜索全书」，同步类注释与该面板的文档注释措辞
- [x] T-006 [AC-001, AC-002, AC-003, NFR-005] `tools/checks/check-workbench-search.js` + `tools/checks/run-all.sh`：新增源码级检查（保留项 11 + 移除项 14，含按复验 F1 补的「替换为…」文案断言）并注册；先跑红测（反向验证）再跑绿测
- [x] T-007 [AC-005] 跑 `npm run check`、`npm run build`、`npm run verify`，确认类型 / 构建 / 全部检查干净
- [x] T-008 [AC-006, AC-007] 真机回归：编辑台搜索面板单行、命中片段 / 全书计数 / 上下定位 / `esc`；手机宽度与暗色 / 高对比度复看
- [x] T-009 [CHORE] 文档：`docs/插件设计文档.md` §5.2 补踩坑 51（编辑台只保留全书搜索、替换交给 Obsidian 自带 Ctrl/Cmd+H）；`README.md` 编辑台段未提搜索 / 替换，无需改
- [x] T-010 [AC-004] 复核命令面与数据面未动：命令仍是四条白名单、`data.json` 数据键与设置加载约定不变（由 `check-commandsurface.js` / `check-module-contract.js` 覆盖，未新增命令或设置项）

## 2. 验收证据

- [x] 自动：`node tools/checks/check-workbench-search.js`（反向验证）→ 实现前跑同一条命令退出码 1、`→ 11/24 通过`：11 条保留项全绿、13 条移除项全部变红（报错行点名 `replaceCurrent` / `replaceAll` / `doReplaceAll` / `collectMatchOffsets` / `replaceAllInText` / `findMatchOffset` / `replaceQuery` / `searchRevealAfterScan` / `wt-wb-replace` / `wt-wb-search-replace` / 「全部替换」及 `styles.css` 两处选择器），证明该检查真的抓得住替换功能
- [x] 自动：`node tools/checks/check-workbench-search.js`（实现后）→ `→ 25/25 通过`、exit 0（保留 11 + 移除 14）；24 条版本先绿，之后按独立复验的 F1 又补了「替换为…」文案断言
- [x] 自动：`node tools/checks/check-workbench-search.js` 反向验证（补断言后）→ `/tmp/wt-check-f1` 最小同构副本：基线 `→ 25/25 通过`；注入一行 `placeholder: "替换为…",` 后 `→ 24/25 通过`、exit 1（新断言变红）（报错行「移除：workbench.ts 不再含「替换为…」 — 仍出现在第 805 行」）；删掉注入行回到 25/25 且与真仓库 `src/workbench.ts` diff 0 行——证明新断言不是空转
- [x] 自动：`npm run check` → 干净（`tsc --noEmit` 无输出；eslint 仅剩改前就存在的 `workbench.ts` `ref` unused 一条 warning，替换相关那条随代码删除消失）
- [x] 自动：`npm run verify` → 全部通过（40 项检查，含新增的「编辑台全书搜索（源码级）」；其中 SPEC 结构检查 75/75）
- [x] 自动：独立复验（verifier，零文件改动；revision 冻结 `workbench.ts` `62ff9032` / `styles.css` `cd2b6691` / `main.js` `ab868fe4`）→ 复跑 check / `npm run check` / `npm run verify` 全绿（40 项、SPEC 75/75），加跑 commandsurface 24/24、boundaries 10/10、module-contract 10/10；对抗性审计：`src/**` + `styles.css` 替换符号 0 命中、`searchRevealAfterScan` 7 处全删且 `scanSearch` 无悬空分支、Enter/↑↓ → `stepSearchMatch` → `revealSearchMatch` → `applyEditorSelection` 链路逐条对齐基线、`data.json` / 设置项 / 命令面 / 其它 Shell 零改动；证伪实验 6 组（基线复现 11/24、注入 `replaceQuery`、改名跳转链路、改坏扫描数据源、删光 summary 样式均能变红），并据此提出 F1
- [x] 人工：真机 Obsidian 回归（AC-006 / AC-007）——用户在 Obsidian 里实测后确认（2026-10-19 原话「搜索面板确实只有一行，没有替换，已经可以了」）：编辑台搜索面板只有一行搜索框、没有「替换为…」输入框与「替换」「全部」按钮。命中片段 / 全书计数 / ↑↓ 与 Enter 定位 / `esc` 先清空后收起沿用改前链路，由源码级检查与独立复验逐条核对，本次未改其行为

## 3. 文档更新

- [x] `docs/插件设计文档.md` §5.2：补踩坑 51（编辑台只保留全书搜索、替换交给 Obsidian 自带 Ctrl/Cmd+H）
- [x] `AGENTS.md`：无：本次未改架构约束、命令面与数据约定
- [x] `README.md`：无：编辑台段未提搜索 / 替换，本次无需改
