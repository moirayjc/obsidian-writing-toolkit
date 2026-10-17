/**
 * Project Service 检查。
 *
 * 用真实 ProjectIndexService + project.ts 识别规则验证：
 *   - 作品、章节和作品根目录查询
 *   - 作品缓存只扫描一次
 *   - invalidate() 后按新配置重新扫描
 *   - 批注伴随文件、辅助文件、快照目录和资料文件不算正文
 */
const H = require("./_harness");

class TAbstractFile {
  constructor(filePath, parent) {
    this.path = filePath;
    this.parent = parent;
    this.name = filePath.split("/").pop() || "";
  }
}

class TFile extends TAbstractFile {
  constructor(filePath, parent) {
    super(filePath, parent);
    this.extension = (filePath.split(".").pop() || "").toLowerCase();
    this.basename = this.name.replace(/\.[^.]+$/, "");
    this.stat = { ctime: 0, mtime: 0, size: 0 };
  }
}

class TFolder extends TAbstractFile {
  constructor(filePath, parent) {
    super(filePath, parent);
    this.children = [];
  }
}

function createFixture() {
  const root = new TFolder("", null);
  const all = [root];
  const folders = new Map([["", root]]);

  function addFolder(folderPath) {
    const parentPath = folderPath.includes("/")
      ? folderPath.slice(0, folderPath.lastIndexOf("/"))
      : "";
    const parent = folders.get(parentPath);
    if (!parent) throw new Error("缺少父目录：" + parentPath);
    const folder = new TFolder(folderPath, parent);
    parent.children.push(folder);
    folders.set(folderPath, folder);
    all.push(folder);
    return folder;
  }

  function addFile(filePath) {
    const parentPath = filePath.slice(0, filePath.lastIndexOf("/"));
    const parent = folders.get(parentPath);
    if (!parent) throw new Error("缺少父目录：" + parentPath);
    const file = new TFile(filePath, parent);
    parent.children.push(file);
    all.push(file);
    return file;
  }

  addFolder("作品甲");
  addFolder("作品甲/正文草稿");
  addFolder("作品甲/人物档案");
  addFolder("作品甲/自定义快照");
  addFolder("作品甲/自定义快照/正文草稿");
  addFolder("随笔");
  addFolder("作品乙");
  addFolder("作品乙/第1卷 第一卷");

  addFile("作品甲/正文草稿/第1章 开端.md");
  addFile("作品甲/正文草稿/第2章-发展.md");
  addFile("作品甲/正文草稿/第1章 开端.批注.md");
  addFile("作品甲/正文草稿/AGENTS.md");
  addFile("作品甲/人物档案/主角.md");
  addFile("作品甲/自定义快照/正文草稿/第99章 旧稿.md");
  addFile("随笔/今天.md");
  addFile("作品乙/第1卷 第一卷/第1章 初见.md");

  return { root, all };
}

async function main() {
  const H = require("./_harness");
  const fixture = createFixture();
  let vaultScanCount = 0;
  const vault = {
    getRoot: () => fixture.root,
    getAllLoadedFiles() {
      vaultScanCount++;
      return fixture.all;
    },
    getMarkdownFiles: () =>
      fixture.all.filter((file) => file instanceof TFile && file.extension === "md"),
    getAbstractFileByPath: (filePath) =>
      fixture.all.find((file) => file.path === filePath) || null,
  };
  const app = {
    vault,
    metadataCache: { getFileCache: () => null },
  };

  const config = {
    draftKeywords: "正文草稿, 卷",
    chapterExcludeNames: "AGENTS, README",
    extraExcluded: ["作品甲/自定义快照"],
  };
  let configReadCount = 0;
  const restore = H.stubObsidian({ TFile, TFolder });
  let ProjectIndexService;
  try {
    ({ ProjectIndexService } = H.compile(
      "src/services/projectIndexService.ts",
      "project-index-service"
    ));
  } finally {
    restore();
  }

  const service = new ProjectIndexService(app, () => {
    configReadCount++;
    return config;
  });
  const r = H.createReporter("作品索引 Project Service");

  const projects = service.projects();
  const chapterPaths = service.chapterPaths();
  r.check(
    "识别到两部作品",
    projects.length === 2,
    projects.map((project) => project.root).join(", ")
  );
  r.check(
    "章节集合只包含正文章节",
    chapterPaths.size === 3,
    [...chapterPaths].join(", ")
  );
  r.check(
    "正文文件判定正确",
    service.isDailyCountFile("作品甲/正文草稿/第1章 开端.md")
  );
  r.check(
    "按卷组织的正文文件判定正确",
    service.isDailyCountFile("作品乙/第1卷 第一卷/第1章 初见.md")
  );
  r.check(
    "批注伴随文件不算正文",
    !service.isDailyCountFile("作品甲/正文草稿/第1章 开端.批注.md")
  );
  r.check(
    "辅助文件不算正文",
    !service.isDailyCountFile("作品甲/正文草稿/AGENTS.md")
  );
  r.check(
    "资料文件不算正文",
    !service.isDailyCountFile("作品甲/人物档案/主角.md")
  );
  r.check(
    "自定义快照目录不算正文",
    !service.isDailyCountFile("作品甲/自定义快照/正文草稿/第99章 旧稿.md")
  );
  r.check(
    "作品外文件不算正文",
    !service.isDailyCountFile("随笔/今天.md")
  );
  r.check(
    "内部目录文件不算正文",
    !service.isDailyCountFile(".wt-outlines/作品甲/正文草稿/第1章 开端.md")
  );
  r.check(
    "资料文件仍能查到所属作品根目录",
    service.projectRootForPath("作品甲/人物档案/主角.md") === "作品甲"
  );
  r.check(
    "作品外文件没有作品根目录",
    service.projectRootForPath("随笔/今天.md") === null
  );
  r.check("多次查询只扫描一次作品库", vaultScanCount === 1, String(vaultScanCount));
  r.check("作品缓存只读取一次配置", configReadCount === 1, String(configReadCount));

  config.chapterExcludeNames = "AGENTS, README, 第2章-发展";
  service.invalidate();
  const rebuiltPaths = service.chapterPaths();
  r.check("invalidate() 后重新扫描", vaultScanCount === 2, String(vaultScanCount));
  r.check("重新扫描读取最新配置", configReadCount === 2, String(configReadCount));
  r.check(
    "重新扫描应用新的排除名单",
    rebuiltPaths.size === 2 &&
      !rebuiltPaths.has("作品甲/正文草稿/第2章-发展.md"),
    [...rebuiltPaths].join(", ")
  );

  return r.finish();
}

main()
  .then((ok) => {
    H.cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error("运行失败：" + error.stack);
    H.cleanup();
    process.exit(2);
  });
