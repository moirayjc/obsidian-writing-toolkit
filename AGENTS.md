# AGENTS.md — Writing Toolkit 插件仓库

这是 **Writing Toolkit**（Obsidian 中文网文写作插件）的**开发检出**。开工前请按顺序读：

1. [`docs/插件化架构说明.md`](docs/插件化架构说明.md)——单 Obsidian 插件内的 Host + Services + Feature Modules 架构、模块边界和硬约束。
2. [`docs/插件设计文档.md`](docs/插件设计文档.md)——当前代码的模块地图、数据模型、必须遵守的约定和踩坑清单。

如果正在做插件化迁移，再读 [`docs/插件化迁移计划.md`](docs/插件化迁移计划.md)。README 讲功能；设计文档讲当前代码为什么这么写、哪里不能碰。

## ⚠️ 硬约束

1. **只有在「测试库」这个检出里才能构建。**
   本目录是开发检出（含 `src/`、`package.json`、`node_modules/`、`.git`）。
   工作库 `~/Documents/Workbench/` 里的插件目录**只放产物**（`main.js` / `manifest.json` / `styles.css` / `data.json`），
   那里**没有** `package.json`——**绝不要为了"方便"把它加回去，也不要在那里面执行 `npm run build`**。
   原因：构建会直接覆盖**正在被 Obsidian 加载的插件**，而候选构建只要被加载就可能改写
   `data.json`（覆盖写、无版本历史、不可回滚）。

2. **换装到工作库前必须备份 `data.json`。**
   `main.js` 坏了换回来就行；**`data.json` 写坏了没有历史可回**。流程见设计文档 §6.5。

3. **注释、文档示例、测试数据里一律用虚构名，绝不用真实作品名。**
   这个仓库是**公开**的。曾经因为把真实作品名写进 `src/project.ts` / `src/main.ts` 的示例注释，
   连续 3 个 release 都把它推到了 GitHub（清理很费劲，见设计文档 §6.1）。
   提交前会自动跑 `tools/release-check.sh` 体检（pre-commit 钩子），命中真实名会**直接拦下提交**；
   也**不要用 `--no-verify` 绕过**。真实名词表在 `.git/wt-blocklist.txt`（不进版本库）。

4. **命令面板永远只有四个入口：打开主页、打开工具箱、打开编辑台、打开设置。**
   这是产品硬约束，不是“尽量少”。三个页面和设置页就是唯一允许出现在 Command + P
   里的插件命令；新增功能、格式命令、批注操作、自检、调试入口、移动端预览、章节重编号、
   数据清理等，一律不得注册成 Obsidian 命令。它们应进入现有三页、侧栏、右键菜单、
   设置页或编辑工具条。`tools/checks/check-commandsurface.js` 固定了命令 ID 与显示名称，
   新增第五条命令必须被视为回归。

## 插件化架构约束

本项目是**单 Obsidian 插件内的插件化架构**：

- 用户只安装一个 `writing-toolkit`；功能以内部 Feature Module 组织，不是多个 Obsidian 插件。
- 不新增第二个 `manifest.json` / `main.js`，不把 `app.plugins` 当作内部模块加载器，不在运行时加载外部功能 bundle。
- `main.ts` 的长期职责是启动 Host 和装配模块，不是继续承载新功能；新功能优先进入 Feature Module。
- Feature Module 通过 Host Context 使用 Services，不直接 import `main.ts` 或兄弟模块内部实现。
- 所有命令、视图、监听器、定时器、DOM 和编辑器扩展都必须可撤销；数据只由 Host 的持久化入口写入。
- UI Shell 只依赖 `src/uiShellContext.ts` 的窄接口与 Services：`home` / `workbench` /
  `sidebar` / `mobileStatusBar` 通过 `UiShellContext`，`statusbar` 只依赖
  `WordCountService`；都不 import `main.ts`、不 import `features/` 实现、不互相
  import；新增 Shell 能力先加显式端口，视图 id、四命令白名单和手机抽屉路径不得改。

## 常规动作

```bash
npm run check     # 类型检查 tsc --noEmit（必须干净，strict: true）
npm run build     # 生产构建 → 原地覆盖本目录的 main.js
npm run verify    # 逻辑检查（跑的是构建产物，所以要先 build）
npm run release   # 发布：自检 + 构建 + 打包到 release/（见设计文档 §6.1）
npm run dev       # 监听构建（常驻进程，用完记得关）
```

**项目没有测试框架**；已有 eslint 配置和本地审核脚本。逻辑检查以 `npm run verify` 为准
（`tools/checks/run-all.sh` 统一调度，覆盖批注缓存、设置加载、作品识别等，用 Node 直接跑**真实实现**，
不必启动 Obsidian；跑之前先构建）。办法见设计文档 §4.9。

**加新检查时顺手做一次反向验证**：把修复改回坏的样子，确认检查会报警。否则你不知道它是不是永远绿。

渲染、布局、主题、输入法、移动端**验证不了**，只能进 Obsidian 手点。

## 改代码前请确认

- 改样式 → 最小改动 + `--wt-*` 令牌，检查暗色/冷淡/高对比/`body.wt-mobile`；**不要大范围重写 `styles.css`**
- 编辑器内 UI → **不要做跟随文字滚动的浮层**（历史上因此删掉了整个 `commentPopover.ts`）
- 「是不是正文」→ 用 `isDailyCountFile()` / `chapterPaths()`，不要写路径关键词匹配
- 新增写入正文的记号 → 同步更新 `stripInlineFormatting`，否则字数统计虚增
- 新增设置项 → 照 `loadPluginData` 里 `data.x ?? DEFAULT_SETTINGS.x` 的写法（**曾因漏写而丢掉用户 17 项配置**）
- 新增计时器/监听器 → 配 `onunload` 清理；body 级监听用 `registerDomEvent`
- 新增任何操作入口 → **不要注册新命令**；先放进三个主页面、侧栏、右键菜单、设置页或编辑工具条
- 版本号 → `manifest.json`、git tag、`versions.json` **三处同步**

## 发布

照设计文档 §6.1（自检清单）与 §6.5（换装流程）。`main.js` 不进 git，作为 Release 附件上传。
