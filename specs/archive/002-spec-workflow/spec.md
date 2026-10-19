---
id: "002"
title: "引入 SPEC 规格驱动开发流程"
slug: "spec-workflow"
size: L
status: done
created: "2026-10-19"
updated: "2026-10-19"
owners: ["Maureen"]
related:
  - AGENTS.md
  - README.md
  - docs/插件设计文档.md
  - docs/插件化迁移计划.md
  - specs/README.md
  - specs/constitution.md
---

# SPEC-002 · 引入 SPEC 规格驱动开发流程

> 一句话：给仓库补上「按次改动」的规格层——分级、模板、状态机、可执行门禁——把需求与验收标准前置，让 Agent 和人按同一份契约推进。
>
> 分级：L ｜ 状态：verifying ｜ 创建：2026-10-19

## 1. 问题与动机

仓库已经有架构说明、设计文档、迁移计划、一整套自动检查与发布脚本，但这些资产回答的是
「系统整体怎么运转」，回答不了「**这一次**改动为什么做、边界在哪、什么算做完」：

1. **需求只在对话里**：功能为什么做、验收标准是什么，没有落到仓库；换人或隔一段时间就只剩提交信息。
2. **验收标准后置**：通常是先改代码再想怎么验；渲染 / 手机端这类自动检查覆盖不了的部分，
   容易「自动检查全绿就发布」。
3. **没有状态与证据**：一次改动是提案中、实现中还是待人工回归，仓库里看不出来；
   人工回归做过没有、结论是什么，也没有记录。
4. **文档会漂移**：设计文档里的数字与约定靠自觉维护；没有「这次改动必须更新哪些文档」的清单。

已有做法里其实已经有 SPEC 的雏形（迁移计划的阶段 + 验收、设计文档的 60 秒自检、`tools/checks/` 的可执行断言），
缺的是**统一到每个改动、并用门禁逼着走完**。

## 2. 用户场景

- 当我（作者）想加一个功能时，我希望先写清「为什么做、做到什么算完」，再让 Agent 动手，
  以便不在实现完才发现范围不对。
- 当 Agent 接手一个任务时，我希望它读到一份带验收标准和验证方式的规格，而不是从对话里猜需求。
- 当改动做完时，我希望有一份证据说明「跑了哪些命令、人工回归了哪些路径、更新了哪些文档」，
  以便发布前能快速确认，而不是凭记忆。
- 当改动是改错字这类 S 级小事时，我希望不受流程拖累。

## 3. 需求

### 功能需求

| ID | 需求 | 优先级 |
| --- | --- | --- |
| FR-001 | 建立 `specs/` 目录与 `spec.md` / `plan.md` / `tasks.md` 模板；L 级三件套、M 级两件套 | 必须 |
| FR-002 | 定义 S / M / L 分级标准与 `draft → approved → implementing → verifying → done / dropped` 状态机，写清每道门槛 | 必须 |
| FR-003 | 提供 `npm run spec:new` 脚手架：自动取下一个编号、套模板、替换标题 / 日期 / 归属 | 必须 |
| FR-004 | 提供 `npm run spec:check` 门禁：目录命名、frontmatter、章节、FR / AC / 任务映射、证据完整度、archive 位置、失效引用 | 必须 |
| FR-005 | `spec:check` 纳入 `npm run verify`；结构不合法的规格会拦住发布 | 必须 |
| FR-006 | 把流程接入 `AGENTS.md`、`README.md`、设计文档与迁移计划，且不重复现有文档正文 | 必须 |
| FR-007 | 用真实改动回填 `001-theme-tone-contrast` 作为 L 级示例，证明模板可用 | 必须 |

### 非功能需求

| ID | 需求 | 说明 |
| --- | --- | --- |
| NFR-001 | 门禁是纯 Node 实现，不联网、不启动 Obsidian、不依赖新 npm 包 | 与现有 `tools/checks/` 一致 |
| NFR-002 | 流程不膨胀：S 级不写 spec；M 级只有两个文件；模板里的每一个必填章节都必须能对应一个真实问题 | 避免为了格式写空话 |
| NFR-003 | 隐私：spec 示例与测试数据一律虚构名，不出现真实作品名 / 角色名 / 本机路径 | 宪法 #9 |

## 4. 验收标准

| ID | 验收标准 | 验证方式 |
| --- | --- | --- |
| AC-001 | `npm run spec:check` 对 `001` / `002` 两个规格全部通过，且报告断言数 | 自动：`tools/checks/check-specs.js` |
| AC-002 | 反向验证：AC 指向不存在的检查脚本、`done` 但未归档、任务引用不存在的 FR、`approved` 但残留双花括号模板标记、`verifying` 证据全空——五类破坏都能让检查变红 | 自动：`tools/checks/check-specs.js`（`WT_SPECS_ROOT` 指向临时副本） |
| AC-003 | `npm run verify` 包含 `spec:check` 且全绿；`npm run check` 干净；`release.sh` 的未完成规格闸门能拦下 `verifying` 规格（`--allow-pending-spec` 可显式放行） | 自动：`tools/checks/check-specs.js`（已加入 `tools/checks/run-all.sh`）；自动：`npm run check` |
| AC-004 | `npm run spec:new` 能生成合法的 M / L 规格（M 两件套、L 三件套）；连续创建自动递增编号，非法 slug 被拒绝 | 人工：实际创建 / 检查 / 删除临时规格，并试一次非法 slug |
| AC-005 | 按 `specs/README.md` 的流程能走通一次改动：建规格 → approved → 实现 → verifying → 证据 → done → archive | 人工：用本规格自身（002）走完整流程，每推进一个状态都跑一次 `npm run spec:check`，确认该状态要求的检查项真的生效，最后 `git mv` 归档 |
| AC-006 | `specs/README.md` 与 `specs/constitution.md` 不复制设计文档正文，只引用章节 / 条款号 | 人工：逐条打开两份文档里引用的设计文档章节，确认正文没有整段搬过来、只保留了结论与出处链接 |

## 5. 非目标

- 不引入 GitHub Spec Kit / 外部 CLI 或运行时依赖；只借鉴「先规格后实现、验收可执行」的结构。
- 不把 S 级小事也纳管；不改现有提交习惯之外的发布流程。
- 不自动判定「需求是否合理」——评审仍由人负责。
- 不为已有全部功能回填 spec（迁移计划继续作为历史记录）。

## 6. 影响面与约束

- **新增目录 / 文件**：`specs/`、`tools/spec/new.js`、`tools/checks/check-specs.js`；
  `tools/checks/_harness.js` 的临时目录改为惰性创建（不编译东西的检查不再每次泄漏一个 temp 目录）。
- **修改文件**：`package.json`（3 个脚本）、`tools/checks/run-all.sh`（新增一项）、
  `tools/release.sh`（未完成规格闸门 + `--allow-pending-spec`）、
  `AGENTS.md`、`README.md`、`docs/插件设计文档.md`、`docs/插件化架构说明.md`（§14 开工检查）。
- **不涉及**：`src/`、`styles.css`、`manifest.json`、`data.json`、命令面。
- **约束**：门禁必须能反向验证（宪法 #12）；文档计数需同步（设计文档 §0、§1.1、§4.9、§7）。

## 7. 开放问题

| 问题 | 结论 |
| --- | --- |
| 要不要强制「approved 之前不许改代码」？ | 规则写入 README；门禁只能检查文档结构，无法检查代码是否先改，靠评审记录。 |
| spec 完成后是否保留下载？ | 保留在 `specs/archive/`，作为决策历史；不删除。 |
| 要不要给 pre-commit 加 spec 检查？ | 暂不。pre-commit 保持轻量（只做隐私体检）；spec 检查挂在 `npm run verify` / 发布流程。 |

## 8. 评审记录

| 日期 | 状态变化 | 结论 / 备注 |
| --- | --- | --- |
| 2026-10-19 | — → draft | 用户提出按 SPEC 形式规范开发流程 |
| 2026-10-19 | draft → approved | 范围：目录 + 模板 + 分级 + 门禁 + 回填示例；不引入外部工具 |
| 2026-10-19 | approved → implementing | 开始写文档、模板与门禁 |
| 2026-10-19 | implementing → verifying | 文档、模板、门禁、接入完成，待人工验收 |
| 2026-10-19 | verifying → done | 三轮独立复核的阻断项全部关闭；27 类反向验证 + 3 类假阳性回归通过；001 与本规格均已走完流程并归档 |
