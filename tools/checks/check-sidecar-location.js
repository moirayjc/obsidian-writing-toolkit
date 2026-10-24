/**
 * 检查：伴随数据存放位置（specs/sidecar-location.md，2026-10-24 修订），跑真实实现。
 *
 * 覆盖：批注 / 快照 / 章纲路径固定在 `_写作工具箱/` 下、反推新旧都认；`_写作工具箱/` 不算正文；
 * 搬家（同名内容相同删旧、不同跳过、单个失败留原处、自定义快照文件夹不搬、搬空的旧目录整棵删）；
 * 旧目录里没搬走的文件照常兜底读写、不新建；
 * 启动收拢：有旧数据就搬并提示、再启动不重复、没有旧目录什么都不做；
 * 模块只剩「加入 Obsidian 排除列表」，不再有切换入口。
 *
 * 各文件必须打进**同一个**产物，所以这里临时生成一个入口统一导出。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("./_harness");

/* ---------- 内存假盘：同时充当 DataAdapter 与 MigrationFs ---------- */
function makeDisk(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const addDirs = (p) => {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  };
  for (const p of files.keys()) addDirs(p);
  const failOn = new Set();
  const failRmdir = new Set();
  return {
    files,
    dirs,
    failOn,
    failRmdir,
    async exists(p) { return files.has(p) || dirs.has(p); },
    async read(p) { if (!files.has(p)) throw new Error("no " + p); return files.get(p); },
    async write(p, t) { addDirs(p); files.set(p, t); },
    async remove(p) { files.delete(p); },
    async mkdir(p) { dirs.add(p); addDirs(p + "/x"); },
    async rmdir(p, recursive) {
      if (failRmdir.has(p)) throw new Error("EPERM: operation not permitted");
      const under = (k) => k.startsWith(p + "/");
      if (!recursive && [...files.keys(), ...dirs].some(under)) throw new Error("not empty");
      for (const k of [...files.keys()]) if (under(k)) files.delete(k);
      for (const k of [...dirs]) if (under(k)) dirs.delete(k);
      dirs.delete(p);
    },
    async rename(from, to) {
      if (failOn.has(from)) throw new Error("rename failed");
      if (!files.has(from)) throw new Error("no " + from);
      addDirs(to);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async stat(p) { return files.has(p) ? { type: "file", mtime: 1 } : dirs.has(p) ? { type: "folder" } : null; },
    async list(folder) {
      const prefix = folder + "/";
      const direct = (k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/");
      return { files: [...files.keys()].filter(direct), folders: [...dirs].filter(direct) };
    },
  };
}

async function main() {
  const r = H.createReporter("伴随数据存放位置（真实实现）");

  // 一个入口统一导出，保证存放位置状态只有一份
  const src = (p) => JSON.stringify(path.join(H.ROOT, "src", p));
  const entryDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-sidecar-entry-"));
  const entry = path.join(entryDir, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * from ${src("sidecarLocation.ts")};`,
      `export * from ${src("sidecarMigration.ts")};`,
      `export { sidecarPathFor, docPathForSidecar, isLegacySidecarPath, otherSidecarPathFor } from ${src("comments.ts")};`,
      `export { getOutlinePath, resolveOutlinePath, isDraftPath } from ${src("outlineText.ts")};`,
      `export { isInternalPath } from ${src("project.ts")};`,
      `export { CommentStore } from ${src("commentStore.ts")};`,
      `export { createSidecarLocationModule, migrateLegacySidecars } from ${src("features/sidecarLocationModule.ts")};`,
    ].join("\n")
  );

  const notices = [];
  class TFile { constructor(p) { this.path = p; } }
  class TFolder { constructor(p) { this.path = p; } }
  class Notice {
    constructor(message) { notices.push(message); }
    hide() {}
  }
  global.createFragment = () => ({ children: [], append(...n) { this.children.push(...n); } });
  global.createSpan = (o) => ({ text: o?.text ?? "" });
  global.createEl = (_t, o) => ({ text: o?.text ?? "", onclick: null });
  const restore = H.stubObsidian({
    TFile, TFolder, Notice, Modal: class {}, Setting: class {},
    Platform: { isMobile: false },
  });
  let M;
  try {
    M = H.compile(path.relative(H.ROOT, entry), "sidecar-location");
  } finally {
    restore();
    fs.rmSync(entryDir, { recursive: true, force: true });
  }

  /* ── 1) 路径换算 ── */
  r.check(
    "批注 / 章纲 / 快照都落在 _写作工具箱/ 下",
    M.sidecarPathFor("正文/第1章.md") === "_写作工具箱/批注/正文/第1章.批注.md" &&
      M.getOutlinePath("正文/第1章.md") === "_写作工具箱/章纲/正文/第1章.md" &&
      M.effectiveSnapshotFolder(".wt-snapshots") === "_写作工具箱/快照" &&
      M.effectiveSnapshotFolder("") === "_写作工具箱/快照" &&
      M.effectiveSnapshotFolder("_写作工具箱/快照") === "_写作工具箱/快照"
  );
  r.check(
    "旧默认 .wt-snapshots 与 _写作工具箱/快照 都不算自定义",
    !M.isCustomSnapshotFolder(".wt-snapshots") && !M.isCustomSnapshotFolder("_写作工具箱/快照/") &&
      !M.isCustomSnapshotFolder("")
  );
  r.check(
    "自定义过的快照文件夹优先",
    M.effectiveSnapshotFolder("我的快照") === "我的快照" && M.isCustomSnapshotFolder("我的快照")
  );
  r.check(
    "批注文件反推正文路径：新旧目录都认，都不算旧版同目录批注",
    M.docPathForSidecar("_写作工具箱/批注/正文/第1章.批注.md") === "正文/第1章.md" &&
      M.docPathForSidecar(".wt-comments/正文/第1章.批注.md") === "正文/第1章.md" &&
      !M.isLegacySidecarPath("_写作工具箱/批注/正文/第1章.批注.md") &&
      !M.isLegacySidecarPath(".wt-comments/正文/第1章.批注.md") &&
      M.isLegacySidecarPath("正文/第1章.批注.md")
  );

  /* ── 2) 不算正文 ── */
  r.check(
    "_写作工具箱/ 下的文件不算正文（内部路径 + 章节识别都排除）",
    M.isInternalPath("_写作工具箱/快照/正文草稿/第1章.md") &&
      !M.isDraftPath("_写作工具箱/快照/正文草稿/第1章.md", ".wt-snapshots", undefined, undefined, ".obsidian") &&
      !M.isInternalPath("写作/正文草稿/第1章.md")
  );

  /* ── 3) 搬家 ── */
  {
    const disk = makeDisk({
      ".wt-comments/正文/甲.批注.md": "c1",
      ".wt-comments/正文/乙.批注.md": "c2",
      ".wt-comments/正文/丙.批注.md": "同一份",
      ".wt-outlines/正文/甲.md": "o1",
      ".wt-snapshots/正文/甲/1.md": "s1",
      "_写作工具箱/批注/正文/乙.批注.md": "已存在",
      "_写作工具箱/批注/正文/丙.批注.md": "同一份",
    });
    disk.failOn.add(".wt-outlines/正文/甲.md");
    const plan = await M.planSidecarMigration(disk, "hidden", "visible", ".wt-snapshots");
    r.check("计划列出三类全部文件", plan.moves.length === 5, JSON.stringify(plan.moves));
    const res = await M.runSidecarMigration(disk, plan);
    r.check(
      "搬过去：同名内容相同删旧的，不同跳过不覆盖，单个失败留原处",
      res.moved === 2 && res.deduped === 1 &&
        !disk.files.has(".wt-comments/正文/丙.批注.md") &&
        res.skipped.length === 1 && disk.files.get("_写作工具箱/批注/正文/乙.批注.md") === "已存在" &&
        disk.files.get(".wt-comments/正文/乙.批注.md") === "c2" &&
        res.failed.length === 1 && disk.files.get(".wt-outlines/正文/甲.md") === "o1" &&
        disk.files.get("_写作工具箱/批注/正文/甲.批注.md") === "c1" &&
        disk.files.get("_写作工具箱/快照/正文/甲/1.md") === "s1",
      JSON.stringify(res)
    );
    r.check(
      "搬空的旧目录删掉，没搬空的留着",
      !disk.dirs.has(".wt-snapshots") && disk.dirs.has(".wt-comments") && disk.dirs.has(".wt-outlines")
    );

    // 工作库实测的残留：旧位置只剩一整棵空文件夹 + .DS_Store → 整棵删掉
    const shell = makeDisk({ ".wt-snapshots/1-写作/甲/乙/1.md": "s", ".wt-snapshots/1-写作/.DS_Store": "j" });
    await shell.mkdir(".wt-snapshots/1-写作/丙/丁");
    const shellRes = await M.runSidecarMigration(
      shell,
      await M.planSidecarMigration(shell, "hidden", "visible", ".wt-snapshots")
    );
    r.check(
      "旧位置只剩空文件夹树 + .DS_Store：整棵删掉",
      shellRes.moved === 1 && ![...shell.dirs].some((d) => d.startsWith(".wt-snapshots")) &&
        !shell.files.has(".wt-snapshots/1-写作/.DS_Store")
    );
    const stuck = makeDisk({ ".wt-comments/甲.批注.md": "c" });
    stuck.failRmdir.add(".wt-comments");
    const stuckRes = await M.runSidecarMigration(
      stuck,
      await M.planSidecarMigration(stuck, "hidden", "visible", ".wt-snapshots")
    );
    r.check(
      "删不掉旧目录时把错误交给调用方（写进控制台）",
      stuckRes.moved === 1 && stuckRes.cleanupFailed.length === 1 &&
        stuckRes.cleanupFailed[0].includes(".wt-comments") && stuckRes.cleanupFailed[0].includes("EPERM")
    );

    const custom = makeDisk({ "我的快照/正文/甲/1.md": "s", ".wt-snapshots/x.md": "s" });
    const plan2 = await M.planSidecarMigration(custom, "hidden", "visible", "我的快照");
    r.check("自定义过快照文件夹：快照不搬", !plan2.moves.some((m) => m.kind === "snapshots"));
  }

  /* ── 4) 旧目录里没搬走的：就地读写那一份，不新建、不搬 ── */
  {
    const disk = makeDisk({
      ".wt-comments/正文/甲.批注.md": "### 批注 1\n- 原文：他走了\n- 作者：改一下\n",
      ".wt-outlines/正文/甲.md": "旧章纲",
    });
    const app = {
      vault: {
        adapter: disk,
        getAbstractFileByPath: () => null,
        read: async () => "",
      },
      fileManager: { trashFile: async () => {} },
    };
    const store = new M.CommentStore(app);
    const list = await store.load("正文/甲.md");
    await store.save("正文/甲.md", list.map((c) => ({ ...c, messages: [...c.messages, { by: "author", text: "再看" }] })));
    r.check(
      "批注：新位置没有、旧目录有 → 读写那一份",
      list.length === 1 &&
        disk.files.get(".wt-comments/正文/甲.批注.md").includes("再看") &&
        !disk.files.has("_写作工具箱/批注/正文/甲.批注.md")
    );
    r.check(
      "章纲：新位置没有、旧目录有 → 用那一份；都没有 → 新位置",
      (await M.resolveOutlinePath(disk, "正文/甲.md")) === ".wt-outlines/正文/甲.md" &&
        (await M.resolveOutlinePath(disk, "正文/乙.md")) === "_写作工具箱/章纲/正文/乙.md"
    );
  }

  /* ── 5) 启动收拢 ── */
  {
    const appOf = (disk) => ({
      vault: {
        adapter: disk,
        getAbstractFileByPath: () => null,
        async createFolder(p) { await disk.mkdir(p); },
      },
      fileManager: { trashFile: async () => {} },
    });
    const disk = makeDisk({
      ".wt-comments/正文/甲.批注.md": "c",
      ".wt-snapshots/正文/甲/1.md": "s",
      ".wt-outlines/正文/甲.md": "o",
    });
    const before = notices.length;
    await M.migrateLegacySidecars(appOf(disk), { snapshotFolder: ".wt-snapshots" });
    r.check(
      "有旧数据：三类都搬进 _写作工具箱/、旧目录删掉、提示一次",
      disk.files.get("_写作工具箱/批注/正文/甲.批注.md") === "c" &&
        disk.files.get("_写作工具箱/快照/正文/甲/1.md") === "s" &&
        disk.files.get("_写作工具箱/章纲/正文/甲.md") === "o" &&
        ![...disk.dirs].some((d) => d.startsWith(".wt-")) &&
        notices.length === before + 1 && String(notices[notices.length - 1]).includes("3 个")
    );
    const again = notices.length;
    await M.migrateLegacySidecars(appOf(disk), { snapshotFolder: ".wt-snapshots" });
    r.check("再启动：没有旧目录，什么都不做、不提示", notices.length === again);

    const conflict = makeDisk({
      ".wt-comments/甲.批注.md": "这台设备写的",
      "_写作工具箱/批注/甲.批注.md": "另一台设备写的",
    });
    await M.migrateLegacySidecars(appOf(conflict), { snapshotFolder: ".wt-snapshots" });
    r.check(
      "内容不同的同名文件：留在旧目录、不覆盖，提示里写明",
      conflict.files.get(".wt-comments/甲.批注.md") === "这台设备写的" &&
        conflict.files.get("_写作工具箱/批注/甲.批注.md") === "另一台设备写的" &&
        String(notices[notices.length - 1]).includes("留在原处")
    );

    const custom = makeDisk({ ".wt-snapshots/甲/1.md": "s" });
    await M.migrateLegacySidecars(appOf(custom), { snapshotFolder: "我的快照" });
    r.check("自定义过快照文件夹：启动不碰 .wt-snapshots", custom.files.has(".wt-snapshots/甲/1.md"));
  }

  /* ── 6) 模块：只剩「加入排除列表」 ── */
  {
    let filters = ["别的/"];
    const mod = M.createSidecarLocationModule();
    mod.activate({
      app: {
        vault: {
          getConfig: (k) => (k === "userIgnoreFilters" ? filters : undefined),
          setConfig: (k, v) => { if (k === "userIgnoreFilters") filters = v; },
        },
      },
      effects: { add() {} },
    });
    mod.operations.addToObsidianExcluded();
    mod.operations.addToObsidianExcluded();
    r.check(
      "加入排除列表：追加一次 _写作工具箱/，不重复、不动别的",
      filters.join() === "别的/,_写作工具箱/"
    );
    r.check("不再有切换入口", typeof mod.operations.switchTo === "undefined");
  }

  return r.finish();
}

main()
  .then((ok) => { H.cleanup(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error("运行失败：" + e.stack); H.cleanup(); process.exit(2); });
