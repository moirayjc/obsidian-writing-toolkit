# AGENTS.md — Writing Toolkit 插件仓库

这是 **Writing Toolkit**（Obsidian 中文网文写作插件）的**开发检出**。开工前请先读
[`docs/插件设计文档.md`](docs/插件设计文档.md)——里面有模块地图、数据模型、必须遵守的约定，
以及一份「踩过的坑」清单（含已修 bug 的根因）。README 讲功能，那份文档讲代码为什么这么写、哪里不能碰。

## ⚠️ 两条硬约束

1. **只有在「测试库」这个检出里才能构建。**
   本目录是开发检出（含 `src/`、`package.json`、`node_modules/`、`.git`）。
   工作库 `~/Documents/Workbench/` 里的插件目录**只放产物**（`main.js` / `manifest.json` / `styles.css` / `data.json`），
   那里**没有** `package.json`——**绝不要为了"方便"把它加回去，也不要在那里面执行 `npm run build`**。
   原因：构建会直接覆盖**正在被 Obsidian 加载的插件**，而候选构建只要被加载就可能改写
   `data.json`（覆盖写、无版本历史、不可回滚）。

2. **换装到工作库前必须备份 `data.json`。**
   `main.js` 坏了换回来就行；**`data.json` 写坏了没有历史可回**。流程见设计文档 §6.5。

## 常规动作

```bash
./node_modules/.bin/tsc --noEmit    # 类型检查（必须干净，strict: true）
npm run build                       # 生产构建 → 原地覆盖本目录的 main.js
npm run dev                         # 监听构建（常驻进程，用完记得关）
```

**项目没有测试框架、没有 eslint**，所以验证只能靠：类型检查 + 构建 + 进 Obsidian 实际点一遍。
纯逻辑/存储层可以按设计文档 §4.9 的办法用 Node 直接跑真实实现（不必启动 Obsidian）。

## 改代码前请确认

- 改样式 → 最小改动 + `--wt-*` 令牌，检查暗色/冷淡/高对比/`body.wt-mobile`；**不要大范围重写 `styles.css`**
- 编辑器内 UI → **不要做跟随文字滚动的浮层**（历史上因此删掉了整个 `commentPopover.ts`）
- 「是不是正文」→ 用 `isDailyCountFile()` / `chapterPaths()`，不要写路径关键词匹配
- 新增写入正文的记号 → 同步更新 `stripInlineFormatting`，否则字数统计虚增
- 新增设置项 → 照 `loadPluginData` 里 `data.x ?? DEFAULT_SETTINGS.x` 的写法（**曾因漏写而丢掉用户 17 项配置**）
- 新增计时器/监听器 → 配 `onunload` 清理；body 级监听用 `registerDomEvent`
- 版本号 → `manifest.json`、git tag、`versions.json` **三处同步**

## 发布

照设计文档 §6.1（自检清单）与 §6.5（换装流程）。`main.js` 不进 git，作为 Release 附件上传。
