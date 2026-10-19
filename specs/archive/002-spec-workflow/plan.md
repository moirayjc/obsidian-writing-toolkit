# SPEC-002 · 技术方案

> 需求与验收见 [`spec.md`](spec.md)，任务与证据见 [`tasks.md`](tasks.md)。

## 1. 方案概述

补上「按次改动」的规格层，不引入外部工具、不改运行时：

- **目录即状态**：`specs/NNN-slug/` 一次改动一个目录，`spec.md`（为什么 / 做什么 / 验收）+
  `tasks.md`（任务 / 证据 / 文档更新），L 级另加 `plan.md`（怎么做）；完成后整个目录 `git mv` 进
  `specs/archive/`——归档动作本身就是「做完了」的证据，不需要额外的状态表。
- **分级而不是一刀切**：S 级明确不写 spec，避免「改错字也要立项」；M / L 的差别只在
  「要不要写技术方案」，不增加第三种模板。
- **门槛可执行**：`tools/checks/check-specs.js` 只做结构与证据校验（格式、ID 映射、占位符、
  证据空话、归档位置、引用有效性），并把「工作区有源码改动但没有在途规格」作为提示打印。
  它不判断需求好坏——那是评审的事。
- **接入既有闸门而不是另起一套**：`check-specs.js` 进 `run-all.sh`，`npm run verify` 自带；
  `tools/release.sh` 在打包前拦下仍在 `implementing` / `verifying` 的规格（可用
  `--allow-pending-spec` 显式放行）。

**淘汰的方案**：① 引入 GitHub Spec Kit / 外部 CLI——多了 node 之外的依赖，且它的模板面向
绿地项目，与本仓库「文档已经很强、只缺按次改动」的现状不匹配；② 只在设计文档里加一章流程——
没有模板与门禁，等于又一条靠自觉的约定（这正是要解决的问题）；③ 用 issue / 项目看板——
数据在仓库外，Agent 读不到。

**模块归属**：不触碰 `src/`；新增 `specs/`、`tools/spec/new.js`、`tools/checks/check-specs.js`；
改 `package.json`、`tools/checks/run-all.sh`、`tools/release.sh` 与四份长期文档。
**数据与设置**：不改 `data.json`、不加设置项。

## 2. 影响与兼容

- **对既有流程**：`npm run check` / `build` 不变；`npm run verify` 多一项文档级检查（不编译源码，几毫秒）；
  `npm run release` 多一道「未完成规格」闸门。绝对项数见设计文档 §4.9 的快照。
- **对已发布版本**：不涉及 `manifest.json`、`styles.css`、`main.js`，无用户可见变化。
- **对旧文档**：设计文档加 §4.11 与计数；架构说明 §14 加一条开工检查；迁移计划冻结为历史记录。
- **多端 / 手机 / 数据**：无影响；不改 `data.json`，无迁移。

| 风险 | 防线 / 回退 |
| --- | --- |
| 流程被当成形式，写空话凑模板 | 门禁剥注释后判实质内容、判证据空话；模板章节砍到最少 |
| 门禁与代码脱节，删掉规格也全绿 | 工作区改动 ↔ 在途规格对照提示；`check-specs.js` 自检是否在 `run-all.sh` 里 |
| 规格与文档两处漂移 | README 红线：长期知识必须沉淀回 docs，spec 只留结论；宪法条款只引用不抄写 |
| 门禁误伤正常中文（如「自动保存」） | 验证方式改为「自动：/ 人工：」前缀协议，不做子串关键词匹配 |
| 编号被并发写坏 | `spec:new` 先渲染、再非递归 `mkdir`、失败回滚；门禁查重复编号 |

## 3. 实施与验证顺序

1. 建 `specs/` 结构与三份模板；写 `specs/README.md`（分级 / 状态机 / 门槛）与 `constitution.md`。
2. 实现 `tools/checks/check-specs.js`，加进 `run-all.sh` 与 `package.json`。
3. 实现 `tools/spec/new.js` 脚手架（参数校验、模板渲染、并发安全、失败回滚）。
4. 回填 `001-theme-tone-contrast`（L 级真实示例）与 `002-spec-workflow`（本规格）。
5. 接入 `AGENTS.md`、`README.md`、设计文档 §4.11、架构说明 §14、迁移计划冻结说明。
6. `tools/release.sh` 加未完成规格闸门与 `--allow-pending-spec`。
7. 验证：`npm run spec:check` 全绿 → 五类反向验证（无效 check 引用、done 未归档、任务引用不存在 FR、
   approved 残留模板标记、verifying 证据全空）→ `npm run check` / `build` / `verify` 全绿 →
   脚手架边界用例（非法 slug、缺取值、并发）→ 人工按 README 走一遍完整流程。

**覆盖不了**：流程是否「好用到愿意长期用」只能由人判断；门禁无法验证需求本身是否值得做。
