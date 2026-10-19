# 开发宪法（SPEC 不可协商条款）

> 这是 [`specs/`](README.md) 的「不可协商条款」索引：每条只写**结论**与**权威出处**，不复制正文。
> 冲突时以权威出处为准；增删或修改条款本身需要一份 **L 级 spec**。
> 面向对象：写 spec 的人、实现代码的 Agent、评审的人。

---

## 条款

| # | 条款 | 权威出处 | 自动防线 |
| --- | --- | --- | --- |
| 1 | **永远只有一个 Obsidian 插件、一个安装入口**：不新增第二个 `manifest.json` / `main.js`，不把 `app.plugins` 当加载器，不在运行时加载外部 bundle | 架构说明 §0、§6、§9 | `check-boundaries.js` |
| 2 | **正文零污染**：快照 / 章纲 / 批注放伴随文件，正文 Markdown 不加任何标记；新增写入正文的记号必须同步 `stripInlineFormatting` | 设计文档 §2.2、§4.1 禁忌 1 | 人工回归（无自动检查） |
| 3 | **命令面板永久四入口**：只允许「打开主页 / 打开工具箱 / 打开编辑台 / 打开设置」，新增功能不得注册命令 | AGENTS.md 硬约束 4、设计文档 §4.1 禁忌 10 | `check-commandsurface.js`、`check-boundaries.js` |
| 4 | **模块边界**：Feature Module 不 import `main.ts`、不 import 兄弟模块内部实现；只通过 Host Context / Services；UI Shell 只依赖窄接口 | 架构说明 §5、§6、§9 | `check-boundaries.js`、`check-ui-shell.js` |
| 5 | **数据只有一个写入者**（Persistence Service）；改 `data.json` 字段/结构必须写迁移并保留旧数据；设置项走白名单合并 | 架构说明 §8、设计文档 §4.1 禁忌 6 | `check-persistence-service.js`、`check-module-contract.js`、`check-loaddata.js` |
| 6 | **一切注册都可撤销**：命令、视图、监听器、定时器、DOM、编辑器扩展都配 disposer；`reload` 幂等；body 级监听用 `registerDomEvent` | 架构说明 §7、设计文档 §4.1 禁忌 7/9 | `check-host.js`、`check-events-service.js`、各模块检查 |
| 7 | **编辑器内不做跟随文字滚动的浮层**；破坏性操作只做「一次确认 + 可撤销」，不叠弹窗 | 设计文档 §4.1 禁忌 4/5 | 人工回归 |
| 8 | **样式外科手术式最小改动**：颜色走 `--wt-*` 令牌，改前留 `_backup/` 快照；检查明暗 / 冷淡 / 高对比四主题 + `body.wt-mobile` | 设计文档 §3.5、§4.1 禁忌 1；《样式与主题》§0–§8 | `check-theme-palette.js`、`check-headingstyle.js`、`check-settingcontrols.js`（部分）+ 人工 |
| 9 | **注释、文档、测试数据一律虚构名**；隐私体检不得用 `--no-verify` 绕过；真实词表放 `.git/wt-blocklist.txt`（不进版本库） | AGENTS.md 硬约束 3、设计文档 §6.1 | `tools/release-check.sh` + pre-commit |
| 10 | **只在开发检出构建**；工作库只收 `main.js` / `manifest.json` / `styles.css` / `data.json` 四个产物，换装前先备份 `data.json` 到开发库 `_backup/` | AGENTS.md 硬约束 1/2、设计文档 §6.4、§6.5 | 人工流程（`tools/release.sh` 不碰工作库） |
| 11 | **版本号三处同步**：`manifest.json` = git tag = `versions.json` 的键，`package.json` 保持一致；发布只走 `tools/release.sh` | AGENTS.md、设计文档 §6.1、§6.2 | `tools/release.sh`、`check-boundaries.js` |
| 12 | **没有测试框架**：每条验收标准必须可判定；新增检查必须反向验证；渲染、布局、主题、输入法、移动端必须人工回归 | 设计文档 §4.7、§4.9 | `npm run verify` + 人工 |
| 13 | **每个 M / L 级改动都有 spec**；状态推进与验收证据必须真实，不造假、不提前勾 | 本目录 [`README.md`](README.md) | `npm run spec:check`（结构与证据）+ `spec:new` 后工作区对照提示（**不能自动证明每个改动都有 spec**，仍需评审） |

---

## 用法

1. **写 spec 之前**先读本表，确认方案没有违反任何一条。
2. spec 的「影响面与约束」只写 `见宪法 #n` 或具体章节号，**不要抄条文**（抄了就会漂移）。
3. 如果这次改动必须突破某一条：先在 spec 的「评审记录」里写明**例外、理由、补偿措施**，
   由评审人确认；没有记录的例外视为回归。
4. 自动化防线只是最后一道；**条款 2、7、10 没有自动检查**，只能靠人工流程与评审。
5. 新增条款 = 改宪法本身，按 L 级 spec 走。
