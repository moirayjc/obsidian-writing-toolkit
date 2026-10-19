# Writing Toolkit（写作工具箱）

> **专为中文网络小说与长篇写作者打造的 Obsidian 沉浸式创作套件。**  
> 拒绝臃肿弹窗与视觉干扰，极致尊重写作者的专注心流，保持正文 Markdown 源码百分之百纯净。

---

## 🎯 核心设计哲学

1. **正文零污染**：快照、章纲、批注全部采用伴随文件或独立隐藏目录（`.wt-comments/`、`.wt-snapshots/`）隔离存储，正文不加任何脏标签，随时可直接交付出版或发布。
2. **拒绝编辑器浮层**：正文内无任何跟随光标晃动的悬浮窗，所有交互操作均收拢于固定侧栏或屏幕居中模态框，视线不跳跃。
3. **原生网文基因**：内建符合中文网文交稿习惯的标点字数统计、分卷目录管理与一键导出纯净稿能力。

---

## 🌟 核心功能特性

### 1. 📊 写作大厅与数据看板 (Home & Stats)
- **年度打卡热力图**：类 GitHub 风格的全年写作日历，实时统计打卡天数、连续天数与达标天数。
- **三种专业字数统计**：
  - **网文模式**（汉字+标点，贴合网络文学交稿与计费标准）；
  - **标准模式**（汉字+字母+数字）；
  - **原生模式**（分词统计）。
  - *全模式均自动剥离 YAML Frontmatter 与排除辅助文档。*
- **作品横向进度**：清晰汇总各长篇作品的历史字数、今日净增字数与写作时速。

### 2. 🗂️ 小说编辑台 (Novel Workbench)
- **单行极简顶栏**：集成作品切换与连载状态胶囊，最大化释放章节纵向视野。
- **卷章分级管理**：卷标头自动汇总字数，章节定宽三段式对齐，智能侦测未达标草稿。
- **智能连号维护**：章节重排或删除时，后续章节序号自动平滑前移。
- **📋 一键复制纯净正文**：章节列表内建一键提取按钮，自动剥离所有编辑器渲染标记，一键粘入各大网文平台后台。

### 3. ⏱️ 极简胶囊番茄钟 (Zen Capsule Pomodoro)
- **横向单胶囊架构**：彻底重构原本臃肿的垂直大表盘，侧栏高度缩减 60%，所有工具箱选项首屏尽收眼底。
- **内置环形操控**：左侧环心直接集成播放/暂停/跳过按键，居中展示大字号倒计时与底轨细进度条，右侧快速结束。
- **主题双向适配**：无缝跟随 Obsidian 的浅色暖纸与暗色深邃模式，毫秒级状态同步。

### 4. 🤖 Agent 协同批注系统 (AI Collaborative Annotations)
专为「作者审阅 ➔ 批注指引 ➔ AI Agent 定位改稿 ➔ 作者验收」深度定制的现代写作协作协议：

- **正文零污染存储**：批注文件隔离保存在 `.wt-comments/<作品路径>/<章节名>.批注.md`，正文 Markdown 源码一个字不动。
- **视觉轻量化**：正文仅以极淡色块与行尾上标序号（如 `²`）呈现，点击直跳侧栏对应卡片，彻底消灭文字跟随浮层。
- **侧栏聚合管理**：工具箱「批注」标签实时汇总当前篇目批注，支持待处理/已解决过滤、一键正文定位、防误触确认删除。
- **四层自适应重锚点**：即使 AI Agent 大幅度重写了正文，系统仍能通过现文、上下文残余文本与相似度自动跟住批注锚点；原文大改时支持一键正文重新绑定。

#### 典型协作流程：
```text
┌──────────────┐      选中文本添加批注      ┌──────────────────────┐
│  作者阅读审稿  │ ───────────────────────> │ .wt-comments/伴随文件 │
└──────────────┘                            └──────────────────────┘
       ▲                                               │
       │                                               ▼
┌──────────────┐    读取批注/修改正文/回写说明     ┌──────────────────────┐
│  作者查阅验收  │ <─────────────────────── │  AI Agent (CLI/API)  │
└──────────────┘                            └──────────────────────┘
```

### 5. ✍️ 沉浸排版与安全快照 (Writing Aids & Safety)
- **打字机模式**：支持自定义视线垂直偏移（如 60% 黄金黄金分割线）。
- **视线聚焦**：当前段落高亮弱化背景、中文标点智能修正、回车硬换行。
- **轻量浮动格式条**：选中文本浮出加粗/高亮/字色等轻量工具，排版标记不影响字数统计。
- **自动快照机**：基于定时与空闲双触发自动保存草稿快照；对比窗左右两栏连续滚动，左栏旧稿可任意选中复制、右栏当前正文可直接编辑，改动处行内高亮，一键写回或时光回溯。
- **移动端深度适配**：手机端自动切换为底部抽屉与响应式状态栏。

---

## ⌨️ 命令入口 (Command Palette)

本插件极度克制，全局仅占用 **4 个快捷命令**，拒绝污染 `Cmd / Ctrl + P` 列表：

| 命令名称 | 功能说明 |
| --- | --- |
| `Writing Toolkit: 打开主页` | 打开全库作品大厅与数据看板 (`wt-home`) |
| `Writing Toolkit: 打开编辑台` | 打开当前长篇分卷目录与章节管理 (`wt-wb`) |
| `Writing Toolkit: 打开工具箱` | 打开右侧专注番茄钟、批注与排版侧栏 (`wt-sidebar`) |
| `Writing Toolkit: 打开设置` | 进入插件偏好设置页 |

---

## ⚙️ 核心配置项

- **新作品位置**：新建项目默认根目录（默认：`写作/新作品`）。
- **共用资料库位置**：工作台资料库挂载目录（默认：`写作/资料库`）。
- **快照保存路径**：默认 `.wt-snapshots`（隐藏），可改为普通路径以兼容坚果云等三方同步。
- **非章节文件过滤**：正文目录下的辅助文档（默认：`Agent, AGENTS, CLAUDE, README`），自动排除在章节列表与字数统计之外。
- **批注生效范围**：可配置全库启用、全库排除正文、或仅在指定作品目录中启用。

---

## 📦 安装与启用

### 手动安装
1. 下载 Release 中的产物包（`main.js`, `manifest.json`, `styles.css`）；
2. 解压放入 Obsidian 库目录：`<Vault>/.obsidian/plugins/writing-toolkit/`；
3. 打开 Obsidian 设置 ➔ **第三方插件** ➔ 重新加载并启用 **Writing Toolkit**。

---

## 🛠️ 本地开发

```bash
npm install
npm run dev      # 监听模式构建
npm run build    # 生产模式打包
npm run check    # TypeScript 类型检查
npm run verify   # 全量逻辑闸门测试（含 SPEC 结构检查）

npm run spec:new -- <slug> "<标题>" --size M|L   # 新建 M / L 级改动规格
npm run spec:check                               # 只跑 SPEC 结构检查
npm run spec:list                                # 查看当前规格与状态
```

> ⚠️ 改动代码前，请务必参阅 [`docs/插件设计文档.md`](docs/插件设计文档.md)，内含架构红线约束、令牌系统规范与踩坑记录。
> M / L 级改动请先按 [`specs/README.md`](specs/README.md) 写规格（S 级不用）。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。

---

## 🌐 English Summary

**Writing Toolkit** is an Obsidian plugin tailored for writing long-form Chinese web fiction and novels.

- **Dashboard & Stats**: GitHub-style annual writing calendar, daily streak, and 3 word count modes (Webnovel, Standard, Native).
- **Novel Workbench**: Volume and chapter hierarchy, automatic chapter renumbering, clean copy button (strips annotations/markers for direct pasting to publisher portals).
- **Zen Capsule Pomodoro**: Sleek horizontal pill-shaped timer taking minimal vertical space, integrated ring buttons, and full dark/light theme awareness.
- **AI Agent Annotation System**: Annotations are stored separately in `.wt-comments/` to keep your markdown manuscript 100% clean. Zero popovers inside editor; full sidebar management; 4-tier anchor recovery after agent rewrites.
- **Writing Aids & Snapshots**: Typewriter mode with customizable vertical position, paragraph highlighting, and automated draft snapshotting with visual diff & restore.
