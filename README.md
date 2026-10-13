# Writing Toolkit（写作工具箱）

Writing Toolkit is an Obsidian plugin for writing long-form Chinese web fiction. It provides word counting (three modes), writing speed and daily goals, a Pomodoro timer, automatic draft snapshots with diff and restore, chapter outlines, a project workbench, and writing aids such as focus and typewriter modes.

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
- **手机版**：Obsidian 手机端自动套用手机布局，状态栏与抽屉式面板。

## 安装

1. 在 Obsidian 设置 → 第三方插件中关闭「安全模式」。
2. 将 `main.js`、`manifest.json`、`styles.css` 放入 `<库>/.obsidian/plugins/writing-toolkit/`。
3. 在第三方插件列表中启用「Writing Toolkit」。

## 设置

- **新作品位置**：「新建作品」时项目的创建目录，默认 `写作/新作品`。
- **共用资料库位置**：工作台「资料库」页展示的目录，默认 `写作/资料库`。
- **快照文件夹**：默认 `.wt-snapshots`（隐藏）。如需随网盘同步，可改为普通文件夹。

## 开发

```bash
npm install
npm run dev      # 监听构建
npm run build    # 生产构建（类型检查后输出 main.js）
```

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
- **Writing aids**: focus mode, typewriter mode, paragraph highlight, half-width punctuation fix, and hard line breaks on Enter.
- **Mobile**: uses a mobile layout with a status bar and drawer panels.

**Installation:** Turn off Restricted mode in Settings → Community plugins, then install and enable "Writing Toolkit".
