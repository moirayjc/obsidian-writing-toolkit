/**
 * 检查：CommentStore 的缓存语义。
 *
 * 跑的是**构建产物里的真实实现**（从 main.js 切出 src/commentStore.ts 段落），
 * 只把 obsidian 的两个类型桩掉；parse/serialize/路径换算用单独编译的 comments.ts 真实实现。
 *
 * 覆盖：批注文件删除后缓存是否失效、外部重建后能否恢复、modify/save/并发读取的回归。
 * 对应设计文档 §7 第 11 条（曾因「删除后写空缓存」造成无边界粘滞）。
 */
const path = require("path");
const H = require("./_harness");

class TFile {
  constructor(p) { this.path = p; this.extension = "md"; }
}

function makeVault() {
  const files = new Map();
  const vault = {
    files,
    getAbstractFileByPath(p) {
      return files.has(p) ? new TFile(p) : null;
    },
    async read(file) { return files.get(file.path); },
    async create(p, text) { files.set(p, text); },
    async modify(file, text) { files.set(file.path, text); },
    async rename(file, target) {
      const text = files.get(file.path);
      files.delete(file.path);
      file.path = target;
      files.set(target, text);
    },
    getFiles() {
      return [...files.keys()].map((p) => new TFile(p));
    },
  };
  /**
   * CommentStore 读的是 `app.fileManager.trashFile`（删批注走它，
   * 以尊重用户「删除到回收站」的设置）——所以桩必须在 app 层，不在 vault 层。
   */
  const app = {
    vault,
    fileManager: {
      async trashFile(file) { files.delete(file.path); },
    },
  };
  return { vault, app };
}

const SAMPLE = [
  "# 批注 · 第1章",
  "",
  "### 批注 1",
  "- 状态：待处理",
  "- 原文：他走了",
  "- 内容：这里要改",
  "",
].join("\n");

const DOC = "正文/第1章.md";
const SIDECAR = ".wt-comments/正文/第1章.批注.md";

async function main() {
  // 直接编译模块（esbuild 会把 comments/diagnostics 一并打进来），只桩掉 obsidian。
  // 早先的写法是从 main.js 切段落，但 commentStore 一旦新增内部依赖就会缺模块——
  // 编译整个模块更健壮，代价是验的是源码而非产物（两者由 npm run build 保证一致）。
  const restore = H.stubObsidian({ TFile, TFolder: class {} });
  let comments, CommentStore;
  try {
    comments = H.compile("src/comments.ts", "comments");
    ({ CommentStore } = H.compile("src/commentStore.ts", "commentStore"));
  } finally {
    restore();
  }

  const r = H.createReporter("CommentStore 缓存语义（src/commentStore.ts 真实实现）");

  // 1) 删除后失效；外部重建后能恢复
  {
    const { vault, app } = makeVault();
    vault.files.set(SIDECAR, SAMPLE);
    const store = new CommentStore(app);
    r.check("首次读到 1 条批注", (await store.load(DOC)).length === 1);

    vault.files.delete(SIDECAR);
    store.handleDeleted(SIDECAR);
    // 注意顺序：先断言「是失效而非写空缓存」，再 load——load 本身会把结果缓存起来
    r.check("handleDeleted 是「失效」而非写空缓存", store.getCached(DOC) === undefined);
    r.check("删除后读到空列表", (await store.load(DOC)).length === 0);

    // Obsidian 在文件被重新创建时会发 create 事件，main.ts 对批注文件调 handleModified
    vault.files.set(SIDECAR, SAMPLE);
    store.handleModified(SIDECAR);
    r.check("外部重建批注文件后能重新读到", (await store.load(DOC)).length === 1);
  }

  // 2) modify 刷新缓存
  {
    const { vault, app } = makeVault();
    vault.files.set(SIDECAR, SAMPLE);
    const store = new CommentStore(app);
    await store.load(DOC);
    vault.files.set(SIDECAR, SAMPLE + "\n### 批注 2\n- 状态：待处理\n- 原文：x\n- 内容：y\n");
    store.handleModified(SIDECAR);
    r.check("modify 后拿到 2 条", (await store.load(DOC)).length === 2);
  }

  // 3) save 空列表 → 删文件
  {
    const { vault, app } = makeVault();
    vault.files.set(SIDECAR, SAMPLE);
    const store = new CommentStore(app);
    await store.load(DOC);
    await store.save(DOC, []);
    r.check("空列表写入后删除批注文件", !vault.files.has(SIDECAR));
    r.check("再读为空", (await store.load(DOC)).length === 0);
  }

  // 4) save 非空 → 落盘可读回
  {
    const { vault, app } = makeVault();
    const store = new CommentStore(app);
    await store.save(DOC, [{
      id: 1, status: "pending", quote: "原文", paragraph: "", paragraphHint: 0,
      lineHint: 1, createdAt: "2026-10-16 10:00", content: "内容", reply: "", current: "",
    }]);
    r.check("批注文件已创建", vault.files.has(SIDECAR));
    r.check("读回 1 条", (await store.load(DOC)).length === 1);
  }

  // 5) 并发 load 复用同一请求
  {
    const { vault, app } = makeVault();
    vault.files.set(SIDECAR, SAMPLE);
    let reads = 0;
    const origRead = vault.read.bind(vault);
    vault.read = async (f) => { reads++; return origRead(f); };
    const store = new CommentStore(app);
    await Promise.all([store.load(DOC), store.load(DOC), store.load(DOC)]);
    r.check("并发读盘只发生 1 次", reads === 1, "实际 " + reads);
  }

  // 6) 改名：侧车与源文档都要失效
  {
    const { vault, app } = makeVault();
    vault.files.set(SIDECAR, SAMPLE);
    const store = new CommentStore(app);
    await store.load(DOC);
    const affected = store.handleRenamed(SIDECAR, ".wt-comments/正文/第2章.批注.md");
    r.check("handleRenamed 返回受影响的文档路径", affected.length >= 1, JSON.stringify(affected));
    r.check("缓存已失效", store.getCached(DOC) === undefined);
  }

  // 7) 目录改名/删除：整段缓存一起失效
  {
    const { vault, app } = makeVault();
    const second = ".wt-comments/正文/第2章.批注.md";
    vault.files.set(SIDECAR, SAMPLE);
    vault.files.set(second, SAMPLE.replace("第1章", "第2章"));
    const store = new CommentStore(app);
    await store.load(DOC);
    await store.load("正文/第2章.md");
    store.invalidatePrefix("正文");
    r.check(
      "invalidatePrefix 清空目录下全部缓存",
      store.getCached(DOC) === undefined &&
        store.getCached("正文/第2章.md") === undefined
    );
  }

  // 8) 写盘失败不能把未落盘内容留在缓存里
  {
    const { vault, app } = makeVault();
    vault.files.set(SIDECAR, SAMPLE);
    const store = new CommentStore(app);
    await store.load(DOC);
    const originalModify = vault.modify;
    vault.modify = async () => {
      throw new Error("disk full");
    };
    let rejected = false;
    try {
      await store.save(DOC, [{
        id: 9,
        status: "pending",
        quote: "未落盘",
        paragraph: "",
        paragraphHint: 0,
        lineHint: 1,
        createdAt: "2026-10-16 10:00",
        content: "不应留在缓存",
        reply: "",
        current: "",
      }]);
    } catch {
      rejected = true;
    }
    r.check(
      "写盘失败向调用方报错且缓存失效",
      rejected && store.getCached(DOC) === undefined
    );
    vault.modify = originalModify;
    r.check(
      "写盘失败后下次读取回到磁盘真值",
      (await store.load(DOC)).length === 1
    );
  }

  // 9) 失效期间不能把旧的「读取中」任务复用给新读取
  {
    const { vault, app } = makeVault();
    vault.files.set(SIDECAR, SAMPLE);
    const gates = [];
    let reads = 0;
    vault.read = async (file) => {
      reads++;
      const snapshot = vault.files.get(file.path);
      await new Promise((resolve) => gates.push(resolve));
      return snapshot;
    };
    const store = new CommentStore(app);
    const first = store.load(DOC);
    await new Promise((resolve) => setImmediate(resolve));
    const updated = SAMPLE + "\n### 批注 2\n- 状态：待处理\n- 原文：x\n- 内容：y\n";
    vault.files.set(SIDECAR, updated);
    store.handleModified(SIDECAR);
    const second = store.load(DOC);
    await new Promise((resolve) => setImmediate(resolve));
    const readCountBeforeRelease = reads;
    gates[0]();
    const firstItems = await first;
    if (gates[1]) gates[1]();
    const secondItems = await second;
    r.check(
      "失效后新读取不复用旧的 in-flight 结果",
      readCountBeforeRelease === 2 &&
        firstItems.length === 1 &&
        secondItems.length === 2 &&
        (store.getCached(DOC) ?? []).length === 2
    );
  }

  // 10) 写盘期间启动的读取不能把旧内容回写到缓存
  {
    const { vault, app } = makeVault();
    vault.files.set(SIDECAR, SAMPLE);
    let releaseWrite;
    let releaseRead;
    vault.modify = async (file, text) => {
      await new Promise((resolve) => {
        releaseWrite = resolve;
      });
      vault.files.set(file.path, text);
    };
    vault.read = async (file) => {
      const snapshot = vault.files.get(file.path);
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
      return snapshot;
    };
    const store = new CommentStore(app);
    const next = [{
      id: 9,
      status: "pending",
      quote: "新内容",
      paragraph: "",
      paragraphHint: 0,
      lineHint: 1,
      createdAt: "2026-10-17 12:00",
      content: "只保留新缓存",
      reply: "",
      current: "",
    }];
    const save = store.save(DOC, next);
    await new Promise((resolve) => setImmediate(resolve));
    const staleRead = store.load(DOC);
    await new Promise((resolve) => setImmediate(resolve));
    releaseWrite();
    await save;
    releaseRead();
    const staleItems = await staleRead;
    const cached = store.getCached(DOC) ?? [];
    r.check(
      "写盘期间启动的旧读取不会覆盖新缓存",
      staleItems.length === 1 &&
        staleItems[0].id === 1 &&
        cached.length === 1 &&
        cached[0].id === 9
    );
  }

  // 11) 旧版同目录批注：读取时自动迁到 .wt-comments/
  {
    const { vault, app } = makeVault();
    const doc = "正文/旧章.md";
    const legacy = "正文/旧章.批注.md";
    const target = ".wt-comments/正文/旧章.批注.md";
    vault.files.set(legacy, SAMPLE);
    const store = new CommentStore(app);
    const items = await store.load(doc);
    r.check(
      "旧版同目录批注读取时自动迁移",
      items.length === 1 && vault.files.has(target) && !vault.files.has(legacy)
    );
  }

  // 12) 启动时批量迁移旧版批注
  {
    const { vault, app } = makeVault();
    const legacyA = "正文/甲章.批注.md";
    const legacyB = "正文/乙章.批注.md";
    vault.files.set(legacyA, SAMPLE);
    vault.files.set(legacyB, SAMPLE.replace("第1章", "第2章"));
    const store = new CommentStore(app);
    const moved = await store.migrateLegacySidecars();
    r.check(
      "启动迁移把旧批注搬进 .wt-comments/",
      moved === 2 &&
        vault.files.has(".wt-comments/正文/甲章.批注.md") &&
        vault.files.has(".wt-comments/正文/乙章.批注.md") &&
        !vault.files.has(legacyA) &&
        !vault.files.has(legacyB)
    );
  }

  // 13) 正文目录改名：镜像目录一起搬
  {
    const { app } = makeVault();
    const disk = new Map([
      [".wt-comments/正文/第1章.批注.md", SAMPLE],
      [".wt-comments/正文/第2章.批注.md", SAMPLE],
    ]);
    app.vault.adapter = {
      async exists(p) {
        return disk.has(p) || [...disk.keys()].some((k) => k.startsWith(p + "/"));
      },
      async mkdir() {},
      async read(p) { return disk.get(p); },
      async write(p, text) { disk.set(p, text); },
      async remove(p) { disk.delete(p); },
      async rename(from, to) {
        const text = disk.get(from);
        disk.delete(from);
        disk.set(to, text);
      },
      async list(folder) {
        const prefix = folder + "/";
        const keys = [...disk.keys()].filter((k) => k.startsWith(prefix));
        return {
          files: keys.filter((k) => !k.slice(prefix.length).includes("/")),
          folders: [...new Set(keys.filter((k) => k.slice(prefix.length).includes("/"))
            .map((k) => prefix + k.slice(prefix.length).split("/")[0]))],
        };
      },
    };
    const store = new CommentStore(app);
    const moved = await store.migrateFolderPrefix("正文", "改名正文");
    r.check(
      "正文目录改名同步搬 .wt-comments 镜像",
      moved === 2 &&
        disk.has(".wt-comments/改名正文/第1章.批注.md") &&
        disk.has(".wt-comments/改名正文/第2章.批注.md") &&
        !disk.has(".wt-comments/正文/第1章.批注.md")
    );
  }

  // 14) 新布局：隐藏目录走 adapter 写入与读回
  {
    const { app } = makeVault();
    const disk = new Map();
    app.vault.adapter = {
      async exists(p) {
        return disk.has(p) || [...disk.keys()].some((k) => k.startsWith(p + "/"));
      },
      async mkdir() {},
      async read(p) { return disk.get(p); },
      async write(p, text) { disk.set(p, text); },
      async remove(p) { disk.delete(p); },
      async rename(from, to) {
        const text = disk.get(from);
        disk.delete(from);
        disk.set(to, text);
      },
      async list(folder) {
        const prefix = folder + "/";
        const keys = [...disk.keys()].filter((k) => k.startsWith(prefix));
        return {
          files: keys.filter((k) => !k.slice(prefix.length).includes("/")),
          folders: [...new Set(keys.filter((k) => k.slice(prefix.length).includes("/"))
            .map((k) => prefix + k.slice(prefix.length).split("/")[0]))],
        };
      },
    };
    const store = new CommentStore(app);
    await store.save(DOC, [{
      id: 1, status: "pending", quote: "原文", paragraph: "", paragraphHint: 0,
      lineHint: 1, createdAt: "2026-10-18 10:00", content: "内容", reply: "", current: "",
    }]);
    const target = ".wt-comments/正文/第1章.批注.md";
    r.check("新批注写入 .wt-comments 走 adapter", disk.has(target));
    store.invalidate(DOC);
    r.check("从隐藏目录读回批注", (await store.load(DOC)).length === 1);
  }

  // 顺手确认编译出来的是真实现（防止抽样到空模块）
  r.check("comments.ts 真实实现可用",
    typeof comments.parseCommentFile === "function" &&
    comments.parseCommentFile(SAMPLE).length === 1);

  return r.finish();
}

main()
  .then((ok) => { H.cleanup(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error("运行失败：" + e.stack); H.cleanup(); process.exit(2); });
