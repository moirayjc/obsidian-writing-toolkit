# SPEC-003 · 任务与验收证据

> 所属规格：[`spec.md`](spec.md)。任务格式：`- [x] T-001 [FR-001, AC-001] 做什么（改哪个文件 / 模块）`；
> 纯杂务用 `[CHORE]`（不许夹带不存在的 ID）。每个 FR / AC 至少要有一条非 CHORE 任务覆盖。

## 1. 任务

- [x] T-001 [FR-001, FR-002, FR-003, NFR-001, AC-002] `src/snapshotDiff.ts`：弹窗改为左右两栏连续滚动；左栏只读、`user-select: text`；右栏 `contenteditable="plaintext-only"`，去掉逐段 `data-unit-index` 单元
- [x] T-002 [FR-004, NFR-001, NFR-004, AC-001] `src/snapshotDiff.ts`：新增 `diffHighlightRanges()` 计算左右字符区间（单段改写用字符级收窄），编辑后防抖重算；用 CSS Custom Highlight API 注册，不支持时降级为无高亮
- [x] T-003 [FR-005, FR-006, AC-002] `src/snapshotDiff.ts` + `src/snapshot.ts`：导出统一剪贴板写入；新增「复制选中」（无选区给提示），保留「复制快照」
- [x] T-004 [FR-007, FR-008, FR-009, AC-003] `src/snapshotDiff.ts`：应用到文档前比对打开时的基线文本，外部改动则拒绝；重置为快照与关窗在存在未写入修改时先确认
- [x] T-005 [NFR-002, NFR-003, AC-004] `styles.css`：新增 `.wt-diff-pane` 与 `::highlight(wt-diff-*)`，删除已无引用的逐行 diff 样式；补手机端两栏叠放；确认未新增命令与设置
- [x] T-006 [AC-001, AC-002, AC-003] `tools/checks/check-snapshotdiff.js`：补差异区间用例与结构 / 样式 / 基线保护断言，并做反向验证
- [x] T-007 [AC-005] 跑 `npm run check`、`npm run build`、`npm run verify`，确认类型 / 构建 / 全部检查干净
- [x] T-008 [AC-006, AC-007] 真机回归：选中复制、右栏编辑、高亮随输入更新、自动保存与撤销、关窗行为；暗色 / 高对比度 / 手机宽度下两栏可读可用
- [x] T-009 [CHORE] 更新 `docs/插件设计文档.md` §2.4（对比窗新结构）与 §5.2 踩坑 46–48；`README.md` 快照描述改为「两栏自由编辑 + 选中复制」
- [x] T-011 [FR-007, FR-010, FR-011, AC-009, AC-010, AC-011] `src/snapshotDiff.ts`：右栏输入停顿 1 秒自动写回；按钮改「保存」；`Cmd/Ctrl+S` 立即保存；meta 行显示保存状态并分色；会话级 `backedUp` 只备份一次快照；关窗先尝试保存、失败才确认
- [x] T-012 [AC-009, AC-010, AC-011] `tools/checks/check-snapshotdiff.js`：补自动保存 / 保存状态 / 单次备份 / 关窗兜底断言，并做反向验证
- [x] T-013 [FR-010] `styles.css`：`.wt-diff-save` 四种状态配色（未保存 / 保存失败可辨识）
- [x] T-010 [NFR-005, AC-008] `src/snapshotDiff.ts`：`supportsPlaintextOnly()` 运行时探测 + `readEditableText()` 按模式读全文，避免不支持时右栏静默变只读

## 2. 验收证据

- [x] 自动：`npm run check` → 干净（tsc --noEmit 无输出）
- [x] 自动：`node tools/checks/check-snapshotdiff.js` → 38/38 通过（差异块对齐 7 条 + 高亮区间 8 条 + 结构与样式 10 条 + 写回 / 自动保存 13 条）
- [x] 自动：`npm run verify` → 全部通过（39 项检查，含 SPEC 结构检查 57/57）
- [x] 自动：`node tools/checks/check-snapshotdiff.js` 反向验证——六处改坏后检查分别变红（每处验完立即还原，最终回到 38/38）：①去掉单段改写的字符级收窄（`singlePair = null`）→ 37/38，「改动只在被改的那一行内」变红；②把右栏 `contenteditable` 写死为 `"plaintext-only"`（去掉运行时探测）→ 「右栏是 plaintext-only 可编辑容器」变红，再加回 `data-unit-index` 后结构断言再红一条；③把 `::highlight(wt-diff-right-add)` 改名 + 手机端 `grid-template-columns` 改回 `1fr 1fr` → 两条样式断言变红；④删掉自动保存的防抖写回 → 「停止输入后自动保存」变红；⑤把 `backup = !this.backedUp` 改成恒 `true` → 「一次会话只备份一次」变红；⑥把关窗兜底改成不尝试保存 → 「关窗先尝试保存」变红
- [x] 人工：真机 Obsidian 回归（AC-006 / AC-007 / AC-009）——用户在 Obsidian 里手测通过（2026-10-19，原话「我手测过了，这个快照功能现在已经改好了」）：左栏选中复制、右栏编辑、高亮随输入更新、停止输入后自动保存、关窗重开文档改动已在正文里、Cmd/Ctrl+S 立即保存、Ctrl+Z 可撤销；暗色 / 高对比度 / 窄窗口下两栏可读可用。无头 Chrome 的结构与主题证据见 `_backup/spec003-accept/*.png`

## 3. 文档更新

- [x] `docs/插件设计文档.md` §2.4、§5.2 踩坑 46–48
- [x] `README.md` 快照功能描述
- [x] `AGENTS.md`：无：本次未改架构约束、命令面与数据约定
