/**
 * 检查：用插件自己的作品识别逻辑跑一遍一个库，确认没有灾难性回归。
 *
 * 用法：
 *   node tools/checks/check-vault.js [--vault <路径>]     # 默认 ../..（即插件所在的库）
 *   WT_VAULT=/path/to/vault node tools/checks/check-vault.js
 *
 * 为什么要这个：作品/章节识别是所有统计与权限判定的地基（「算不算正文」）。
 * 改动 project.ts / chapterOrder.ts / outlineText.ts 之后，跑一次就知道
 * 有没有把整部作品识别没了——这类回归在界面上往往只表现为「数字不对」，很难定位。
 *
 * 注意：这是**冒烟级**检查（数量与边界样本），不是逐章快照对比。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const args = process.argv.slice(2);
const vaultArgIdx = args.indexOf("--vault");

/** 默认库路径：插件在 <库>/.obsidian/plugins/<插件>/，所以要往上三层。 */
function resolveDefaultVault() {
  let p = path.resolve(H.ROOT, "..", "..");
  // 防御：万一算出来是 .obsidian 本身，再往上一层
  if (path.basename(p) === ".obsidian") p = path.dirname(p);
  return p;
}
const VAULT = path.resolve(
  vaultArgIdx >= 0 ? args[vaultArgIdx + 1] : process.env.WT_VAULT || resolveDefaultVault()
);

class TAbstractFile {
  constructor(p, parent) { this.path = p; this.parent = parent; this.name = p.split("/").pop() || ""; }
}
class TFile extends TAbstractFile {
  constructor(p, parent) {
    super(p, parent);
    this.extension = (p.split(".").pop() || "").toLowerCase();
    this.basename = this.name.replace(/\.[^.]+$/, "");
    this.stat = { ctime: 0, mtime: 0 };
  }
}
class TFolder extends TAbstractFile {
  constructor(p, parent) { super(p, parent); this.children = []; }
}

/** 从磁盘重建带 parent/children 的目录树（插件靠向上遍历找作品根）。 */
function buildTree(root) {
  const rootFolder = new TFolder("", null);
  const all = [];
  (function walk(dir, parent) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // 内部目录（.obsidian/.trash/.wt-*）插件本就会排除
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) {
        const f = new TFolder(rel, parent);
        parent.children.push(f); all.push(f); walk(full, f);
      } else {
        const f = new TFile(rel, parent);
        parent.children.push(f); all.push(f);
      }
    }
  })(root, rootFolder);
  return { rootFolder, all };
}

function main() {
  if (!fs.existsSync(VAULT)) {
    console.log("跳过：找不到库路径 " + VAULT + "（用 --vault 指定）");
    return true;
  }
  const { rootFolder, all } = buildTree(VAULT);

  const vault = {
    getRoot: () => rootFolder,
    getAllLoadedFiles: () => [rootFolder].concat(all),
    getMarkdownFiles: () => all.filter((f) => f instanceof TFile && f.extension === "md"),
    getAbstractFileByPath: (p) => all.find((f) => f.path === p) || (p === "" ? rootFolder : null),
    cachedRead: async () => "",
    read: async () => "",
  };

  // 先装桩再编译：编译产物会 require("obsidian")
  const restore = H.stubObsidian({
    TFile, TFolder, Platform: { isMobile: false }, normalizePath: (p) => p,
  });
  let project, projects;
  try {
    project = H.compile("src/project.ts", "project");
    projects = project.discoverProjects(
      { vault, metadataCache: { getFileCache: () => null } },
      {
        draftKeywords: "正文草稿, 正文, 章节, 草稿, 卷, draft, chapter",
        excludeNames: "Agent, AGENTS, CLAUDE, README",
      }
    );
  } finally {
    restore();
  }

  const r = H.createReporter("作品识别冒烟（src/project.ts 真实实现）");
  const details = projects.map((p) => ({
    name: p.name,
    root: p.root,
    volumes: p.volumes.length,
    chapters: project.allChapters(p).length,
    resources: p.resourceCount,
  }));
  const totalChapters = details.reduce((n, d) => n + d.chapters, 0);

  console.log("  库：" + VAULT);
  for (const d of details) {
    console.log("    《" + d.name + "》 卷 " + d.volumes + " | 章 " + d.chapters + " | 资料 " + d.resources);
  }
  console.log("    —— 合计 " + details.length + " 部作品 / " + totalChapters + " 章");

  r.check("至少识别到 1 部作品", details.length > 0, "识别失败通常意味着结构判定被改坏");
  r.check("至少识别到 1 个章节", totalChapters > 0);

  // 边界样本：辅助文件与批注伴随文件不应被当成章节
  const isChapter = (p) =>
    projects.some((pr) => project.allChapters(pr).some((c) => c.file.path === p));
  const sidecars = all.filter((f) => /\.批注\.md$/.test(f.path)).map((f) => f.path);
  const aux = all.filter((f) => /(AGENTS|README)\.md$/.test(f.path)).map((f) => f.path);
  const leaked = sidecars.concat(aux).filter((p) => isChapter(p));
  r.check(
    "批注伴随文件 / 辅助文件未被当成章节",
    leaked.length === 0,
    leaked.length ? "误纳: " + leaked.slice(0, 3).join(", ") : ""
  );

  return r.finish();
}

try {
  const ok = main();
  H.cleanup();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error("运行失败：" + e.stack);
  H.cleanup();
  process.exit(2);
}
