# Writing Toolkit（写作工具箱）

Writing Toolkit is an Obsidian plugin for writing long-form Chinese web fiction. It provides word counting (three modes), writing speed and daily goals, a Pomodoro timer, automatic draft snapshots with diff and restore, chapter outlines, margin-note comments for agent collaboration, one-click copying of clean chapter text, a project workbench, and writing aids such as focus and typewriter modes.

> **Note:** The interface and default folder names are in Chinese. Settings and labels are not translated.

为中文网络小说、长篇写作准备的 Obsidian 插件。

## 功能

- **字数统计**：番茄（含标点）、标准（汉字+字母+数字）、原生（分词）三种模式，自动跳过 YAML frontmatter。
- **码字时速与每日目标**：按今日新增字数计算速度，状态栏显示进度。
- **番茄钟**：专注 / 休息循环，可选自动快照。
- **快照**：按时间间隔与空闲时长自动保存草稿快照，支持对比差异与恢复。
- **章纲**：独立伴生文件存储章纲，不修改正文 YAML。
- **工作台与首页**：按作品管理章节，支持章节连号自动前移。
- **写作辅助**：沉浸模式、打字机模式、段落高亮、半角标点修正、回车硬换行。
- **编辑工具条**：编辑器里选中文字浮出小工具条——加粗、斜体、下划线、删除线、高亮、字色（命令面板里也有对应命令）；格式记号不计入字数统计。
- **批注**：像稿子上的助手批注一样在文档上留批注——被批注的原文带淡标记，行尾跟一枚脚注序号；编辑器里不放任何浮层卡片，批注列表集中在工具箱侧栏的「批注」标签（计数徽标 + 待处理在前、已处理沉底），点正文标记会跳到对应卡片，阅读、编辑、删除、标记已处理都在侧栏完成，正文保持干净。批注存在同目录的伴随文件里（正文一个字不动），适合「Agent 写稿 → 你批注 → Agent 读批注改稿」的协作流程。
- **一键复制正文**：编辑台章节列表搜索框右侧有个复制图标，点一下把当前章节的干净正文复制到剪贴板——批注标记只存在于编辑器渲染层，不会跟着复制出去，粘到别处就是纯净稿子。
- **手机版**：Obsidian 手机端自动套用手机布局，状态栏与抽屉式面板。

## 安装

1. 在 Obsidian 设置 → 第三方插件中关闭「安全模式」。
2. 将 `main.js`、`manifest.json`、`styles.css` 放入 `<库>/.obsidian/plugins/writing-toolkit/`。
3. 在第三方插件列表中启用「Writing Toolkit」。

## 设置

- **新作品位置**：「新建作品」时项目的创建目录，默认 `写作/新作品`。
- **共用资料库位置**：工作台「资料库」页展示的目录，默认 `写作/资料库`。
- **快照文件夹**：默认 `.wt-snapshots`（隐藏）。如需随网盘同步，可改为普通文件夹。
- **不算章节的文件名**：正文目录里这些辅助文件（如 `Agent.md`）不会被当成章节，也不计入字数统计与章节列表。逗号分隔、忽略大小写，默认 `Agent, AGENTS, CLAUDE, README`。
- **编辑工具条范围**：浮出工具条可在全库 / 全库排除正文（默认）/ 仅自己作品与共用资料库三档中切换，也可用总开关一键关闭。
- **批注**：批注功能总开关；「批注按钮全库可用」决定批注按钮是否受上面的工具条范围限制。正文里只显示原文标记与行尾脚注序号，编辑器里不弹浮层（点标记跳到侧栏对应卡片）；批注的列表、编辑、删除、标记已处理都在工具箱侧栏的「批注」标签里。

## 批注（与 Agent 协作）

选中文字后，点浮出气泡上的批注按钮（或右键「添加批注」，或命令面板「批注：为选中文字添加批注」），在居中的输入框里写下内容。批注不会写进正文，而是存到同目录的伴随文件里：

```
正文草稿/第1章.md          ← 正文，一个字不动
正文草稿/第1章.批注.md     ← 批注文件（与 Agent 的沟通渠道）
```

批注文件里每条批注包含：状态（待处理 / 已处理）、原文引用、所在段落、现文、位置（第 N 段 · 约第 M 行）、创建时间、内容、回复。文件开头还写着给 Agent 的处理说明。在正文里，批注只是看得见的标记：

- 有批注的原文带一层淡标记（已处理的是灰色虚线下划线），行尾跟着一枚**脚注序号**（如 `²`）；
- **编辑器里不弹任何浮层**：跟随文字的卡片会随正文滚动而「跳」，看着累，所以正文里只有标记。点标记或脚注序号 = 跳到工具箱侧栏「批注」标签里对应的那张卡片，并闪一下帮你找到它；批注的内容、原文引用、Agent 的回复都在侧栏看；
- 写批注、改内容都在**屏幕居中**的输入框里完成（位置固定、不跟随光标），⌘/Ctrl + Enter 保存。

工具箱侧栏（pen-line 图标 / 命令「打开工具箱」）里还有「批注」标签：标签上带当篇文档的批注计数徽标（有待处理时走当前配色主题的强调色，全部处理完变灰），点开就是这篇文档的批注列表——点卡片的任意位置（引用、内容都可以）会跳到正文对应位置，卡片的操作（悬停显示）都在这里完成：

- 待处理的批注按正文位置排在前面；标记已处理后自动沉到底部的「已处理 N 条」分组里（默认折叠，点分组标题展开 / 收起，点「重新打开」回到上面）；
- 「编辑」弹出居中的输入框改内容（原文定位失败的批注也能这样改）、「删除」会先弹确认框，删掉后 6 秒内可以在提示里点「撤销」找回；
- 有已处理项时，列表顶部会出现「只看待处理」开关，专注改稿时可以只留待处理项。
- Agent 的回复太长时默认折起，点「展开」看全文。

正文里只有标记与脚注序号，编辑、删除、「标记已处理 / 重新打开」都集中在面板里。切换文档时列表与计数自动跟随。

**和 Agent 的协作流程**

1. 你读稿，选中不满意的地方，写批注（可以先写多条）。
2. 用命令面板的「批注：复制给 Agent 的处理指令」把现成指令复制出来，粘给 Agent（指令里会写明待处理条数，避免 Agent 重复处理）。
3. Agent 读同目录的 `.批注.md` 文件：按「原文」定位、按「批注」修改正文，然后把每条的状态改成「已处理」、在「回复」里写它改了什么；如果改动了原文对应的文字，把改完后该处现在的文字照抄进「现文」（文件抬头里写着这条协议）。
4. 你回到文档：改过的原文标记变成灰色，点开能看到 Agent 的回复；确认满意后，用「批注：清除已处理的批注」或面板里的「清除已处理」清理（会先弹确认，Agent 的回复会一起删掉）。

**Agent 改稿后，批注怎么跟住原文**：位置按四层找——① Agent 写回的「现文」；② 原「原文」精确匹配，其次忽略空白差异；③ 用建批注时那一段里原文前后的文字夹出被改写的位置（段内残余）；④ 整段匹配 / 按头尾相似度找最像的段落（结合段落序号就近取舍）。靠后面三层找到的，界面会标出「已迁移」或一句定位说明，让你知道位置是推断的。四层都找不到时，面板里该条会标「锚点失效（原文已大改）」并出现「重新绑定」按钮：在正文里选中这条批注现在该对应的文字，再点一次「重新绑定」，批注就会重新挂上去。批注文件不会被当成章节，也不计入字数统计。

## 开发

```bash
npm install
npm run dev      # 监听构建
npm run build    # 生产构建（类型检查后输出 main.js）
```

> **动手改代码之前，先读 [docs/插件设计文档.md](docs/插件设计文档.md)**：里面有模块地图、数据与存储模型、必须遵守的约定、以及一份「踩过的坑」清单（含已知 bug）。README 讲功能，那份文档讲代码为什么这么写、哪里不能碰。

## 许可证

[MIT](LICENSE)

---

## English summary

- **Word count**: three modes (Chinese-friendly "Tomato" mode counting all non-blank characters, a "Standard" mode, and a native word-based mode). YAML frontmatter is skipped.
- **Writing speed and goals**: speed is based on words added today; progress is shown in the status bar.
- **Pomodoro timer**: focus/break cycles with optional automatic snapshots.
- **Snapshots**: automatic draft snapshots by interval and idle time, with diff view and restore.
- **Outlines**: chapter outlines are stored in separate sidecar files, leaving the manuscript's YAML untouched.
- **Workbench and home**: manage chapters by project; chapter numbering shifts forward automatically after a deletion.
- **Non-chapter file exclusions**: helper files in draft folders (e.g. `Agent.md`) are never treated as chapters; comma-separated configurable list, default `Agent, AGENTS, CLAUDE, README`.
- **Writing aids**: focus mode, typewriter mode, paragraph highlight, half-width punctuation fix, and hard line breaks on Enter.
- **Editing toolbar**: a floating bubble appears when you select text in an editor (bold, italic, underline, strikethrough, highlight, font color), with matching commands; formatting marks are never counted in word statistics.
- **Comments**: Margin-note style annotations for collaborating with an AI agent. Annotated text gets a soft highlight plus a superscript footnote number at the end of the line — clicking either reveals the matching card in the Toolkit sidebar and flashes it. Nothing floats over the editor (hover-anchored cards drift around as you scroll), so the manuscript stays clean; writing and editing happen in a screen-centred input dialog. A tab in the Toolkit sidebar lists the current document's comments with a count badge and one-click jumping: pending comments come first (ordered by position in the manuscript), resolved ones sink into a collapsed "已处理 N 条" group at the bottom, and every card offers hover actions to edit, delete (with a confirmation dialog, undoable for 6 seconds) and resolve/reopen; a "只看待处理" filter hides resolved items while you work. A "clear resolved" action asks for confirmation first. Comments live in a sidecar file (`Chapter.批注.md`) next to the document; the manuscript itself is never modified. The agent reads the sidecar, edits the manuscript, and writes replies, a resolved status, and the rewritten text ("现文") per comment. If the prose changes so much that a comment can no longer be anchored (five passes: present text → exact quote → whitespace-insensitive quote → in-paragraph residue → paragraph similarity), the panel marks it as orphaned and offers a "重新绑定" (re-bind) button: select the new spot in the document and click it again.
- **Mobile**: uses a mobile layout with a status bar and drawer panels.

**Installation:** Turn off Restricted mode in Settings → Community plugins, then install and enable "Writing Toolkit".
