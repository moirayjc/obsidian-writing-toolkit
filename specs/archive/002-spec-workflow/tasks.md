# SPEC-002 · 任务与验收证据

> 所属规格：[`spec.md`](spec.md)。

## 1. 任务

- [x] T-001 [FR-001, AC-005] 建立 `specs/` → `_template/` → `archive/` 结构，写 `spec.md` / `plan.md` / `tasks.md` 模板
- [x] T-002 [FR-002, AC-006] 在 `specs/README.md` 写清 S / M / L 分级、目录规范、状态机与每道门槛、完整流程、提交信息约定
- [x] T-003 [FR-002, AC-006] 写 `specs/constitution.md`：13 条不可协商条款、权威出处、自动防线
- [x] T-004 [FR-003, AC-004] 实现 `tools/spec/new.js`（脚手架）与 `spec:new` 脚本
- [x] T-005 [FR-004, AC-001, AC-002] 实现 `tools/checks/check-specs.js`（目录 / frontmatter / 章节 / ID 映射 / 证据质量 / archive / 引用有效性 / 围栏与表格口径）；`_harness.js` 临时目录改惰性创建，verify 不再泄漏 temp 目录
- [x] T-006 [FR-005, AC-003] 把 `check-specs.js` 加入 `tools/checks/run-all.sh` 与 `package.json`（`spec:check` / `spec:list`），并在 `tools/release.sh` 加未完成规格闸门
- [x] T-007 [FR-006, AC-006] 接入 `AGENTS.md`（分级 + 开工顺序 + 常规动作）、`README.md`（本地开发）、设计文档（§4.11 + 计数）、架构说明（§14 + 计数）
- [x] T-008 [FR-007, AC-005] 回填 `001-theme-tone-contrast`（L 级三件套）作为真实示例
- [x] T-009 [AC-002] 对 `check-specs.js` 做五类反向验证（失效检查引用 / done 未归档 / 任务引用不存在 FR / approved 残留模板标记 / verifying 证据全空）

## 2. 验收证据

- [x] 自动：`npm run spec:check` → 通过
- [x] 自动：`node tools/checks/check-specs.js` 反向验证（`WT_SPECS_ROOT` 临时副本）→ 27 类破坏全部变红、3 类假阳性回归保持绿：
  无效检查引用 / done 未归档 / 任务引用不存在 FR / approved 残留模板标记 / verifying 证据全空 /
  done 证据写空话 / 空勾选证据 / 小写占位词 / CHORE 夹带假 ID / 自动项指 `npm run dev`、`release`
  或 `check-evil` / 自动项只写裸文件名、不存在路径、加 `.bak` 后缀或加前缀目录 /
  证据写否定结论「未通过」或不存在的检查 / AC 段里藏第二个标记 / 验收表混入 AC-01 与无 ID 行 /
  related 越界（含符号链接）/ archive 散装 md / `--pending` 对不存在或形态错误的根目录 /
  run-all 里被注释掉的检查；
  假阳性回归（必须保持通过）：「注释 / 代码围栏里的表格与占位符不算正文」「围栏里的示例代码不触发占位符」「人工步骤含中文分号不被误切」
- [x] 自动：`npm run check` → 干净
- [x] 自动：`npm run build` → 成功
- [x] 自动：`npm run verify` → 全通过（39 项检查、1006 条断言，含 SPEC 结构检查）
- [x] 自动：`node tools/checks/check-specs.js --pending` → 有 `verifying` 规格时返回 1、全部归档后返回 0（`release.sh` 据此拦下发布）
- [x] 人工：跑 `node tools/spec/new.js` 边界用例 → 缺 `--owner` 取值 / 连续连字符 slug / 尾随连字符 / 多余位置参数 / 标题带 `{}` 均被拒绝；模板缺失时不留半成品目录；5 个并发调用拿到 5 个不同编号
- [x] 人工：`npm run spec:new` 实测生成 M（`003-demo-scaffold`）与 L（`004-demo-scaffold-l`）两套规格并通过 `spec:check`；非法 slug 被拒绝；临时规格已删除
- [x] 人工：按 `specs/README.md` 用本规格（002）走一遍完整流程并归档 → 001 走完 `draft → approved → implementing → verifying → done` 并移入 `specs/archive/`；002 自身同样归档，`spec:check` 41/41 通过
- [x] 人工：确认 `specs/README.md` / `constitution.md` 没有复制设计文档正文，只引用章节 / 条款号

## 3. 文档更新

- [x] `AGENTS.md`：新增「改动分级与 SPEC」；开工阅读顺序加入 `specs/README.md`；常规动作加入 `spec:new` / `spec:check`
- [x] `README.md`：本地开发加入 SPEC 命令与入口
- [x] `docs/插件设计文档.md`：新增 §4.11 SPEC 工作流，更新检查计数（39 项 / 1006 条断言）
- [x] `docs/插件化架构说明.md`：§14「Agent 开工检查」加入 M / L 级先建规格一条
