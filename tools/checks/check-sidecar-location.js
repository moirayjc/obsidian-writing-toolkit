/**
 * 检查：伴随数据存放位置（specs/sidecar-location.md），跑真实实现。
 *
 * 覆盖：两档下批注 / 快照 / 章纲的路径换算与反推；`_写作工具箱/` 不算正文；
 * 切换搬家（目标已有跳过、单个失败留原处、自定义快照文件夹不搬、搬空的旧目录删掉、能切回）；
 * 两台设备选得不一样时就地读写另一档里的文件、不来回搬；
 * 启动时以库里的实际数据为准（data.json 会被同步工具覆盖）、旧位置只剩空壳时整棵删；
 * 模块：确认后才搬并改设置、两处都有数据时提示合并（「不再提示」后不再出现）。
 *
 * 存放位置是进程内状态：各文件必须打进**同一个**产物，所以这里临时生成一个入口统一导出。
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
      `export { createSidecarLocationModule, resolveStartupSidecarLocation } from ${src("features/sidecarLocationModule.ts")};`,
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
  M.setSidecarLocation("hidden");
  r.check(
    "隐藏档：批注 / 章纲 / 快照路径与现在一致",
    M.sidecarPathFor("正文/第1章.md") === ".wt-comments/正文/第1章.批注.md" &&
      M.getOutlinePath("正文/第1章.md") === ".wt-outlines/正文/第1章.md" &&
      M.effectiveSnapshotFolder(".wt-snapshots") === ".wt-snapshots"
  );
  M.setSidecarLocation("visible");
  r.check(
    "可同步档：都落在 _写作工具箱/ 下",
    M.sidecarPathFor("正文/第1章.md") === "_写作工具箱/批注/正文/第1章.批注.md" &&
      M.getOutlinePath("正文/第1章.md") === "_写作工具箱/章纲/正文/第1章.md" &&
      M.effectiveSnapshotFolder(".wt-snapshots") === "_写作工具箱/快照" &&
      M.effectiveSnapshotFolder("") === "_写作工具箱/快照"
  );
  r.check(
    "自定义过的快照文件夹优先于存放位置",
    M.effectiveSnapshotFolder("我的快照") === "我的快照" && M.isCustomSnapshotFolder("我的快照")
  );
  r.check(
    "批注文件反推正文路径：两档都认，都不算旧版同目录批注",
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
      ".wt-outlines/正文/甲.md": "o1",
      ".wt-snapshots/正文/甲/1.md": "s1",
      "_写作工具箱/批注/正文/乙.批注.md": "已存在",
    });
    disk.failOn.add(".wt-outlines/正文/甲.md");
    const plan = await M.planSidecarMigration(disk, "hidden", "visible", ".wt-snapshots");
    r.check("计划列出三类全部文件", plan.moves.length === 4, M.describePlan(plan));
    const res = await M.runSidecarMigration(disk, plan);
    r.check(
      "搬过去：目标已有的跳过不覆盖，单个失败留原处",
      res.moved === 2 &&
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

    disk.failOn.clear();
    const back = await M.planSidecarMigration(disk, "visible", "hidden", ".wt-snapshots");
    await M.runSidecarMigration(disk, back);
    r.check(
      "能切回隐藏目录；两边都有的那份仍跳过不覆盖，其余搬空的目录删掉",
      disk.files.get(".wt-comments/正文/甲.批注.md") === "c1" &&
        disk.files.get(".wt-snapshots/正文/甲/1.md") === "s1" &&
        disk.files.get(".wt-comments/正文/乙.批注.md") === "c2" &&
        [...disk.files.keys()].filter((k) => k.startsWith("_写作工具箱/")).join() ===
          "_写作工具箱/批注/正文/乙.批注.md" &&
        !disk.dirs.has("_写作工具箱/快照") && !disk.dirs.has("_写作工具箱/章纲")
    );
    disk.files.delete("_写作工具箱/批注/正文/乙.批注.md");
    await M.runSidecarMigration(disk, await M.planSidecarMigration(disk, "visible", "hidden", ".wt-snapshots"));
    r.check("可同步目录全空时整个删掉", !disk.dirs.has("_写作工具箱"));

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

  /* ── 4) 两台设备选得不一样：就地读写另一档里的文件，不来回搬 ── */
  {
    M.setSidecarLocation("visible");
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
      "批注：当前档没有、另一档有 → 读写那一份，不新建、不搬",
      list.length === 1 &&
        disk.files.get(".wt-comments/正文/甲.批注.md").includes("再看") &&
        !disk.files.has("_写作工具箱/批注/正文/甲.批注.md")
    );
    r.check(
      "章纲：当前档没有、另一档有 → 用那一份",
      (await M.resolveOutlinePath(disk, "正文/甲.md")) === ".wt-outlines/正文/甲.md" &&
        (await M.resolveOutlinePath(disk, "正文/乙.md")) === "_写作工具箱/章纲/正文/乙.md"
    );
  }

  /* ── 5) 启动时以库里的实际数据为准（data.json 会被同步工具覆盖） ── */
  {
    const settingsOf = (loc) => ({ sidecarLocation: loc, snapshotFolder: ".wt-snapshots" });
    const appOf = (disk) => ({
      vault: { adapter: disk, getAbstractFileByPath: () => null },
      fileManager: { trashFile: async () => {} },
    });
    // 工作库实测：手机把 data.json 覆盖成「隐藏目录」，数据其实在可同步目录
    const s1 = settingsOf("hidden");
    await M.resolveStartupSidecarLocation(
      appOf(makeDisk({ "_写作工具箱/快照/正文/甲/1.md": "s" })),
      s1
    );
    r.check(
      "data.json 说隐藏、数据只在可同步目录 → 用可同步目录（不搬文件）",
      s1.sidecarLocation === "visible" && M.getSidecarLocation() === "visible"
    );
    const s2 = settingsOf("visible");
    await M.resolveStartupSidecarLocation(appOf(makeDisk({ ".wt-comments/甲.批注.md": "c" })), s2);
    r.check("数据只在隐藏目录 → 用隐藏目录", s2.sidecarLocation === "hidden");
    const s3 = settingsOf("visible");
    await M.resolveStartupSidecarLocation(appOf(makeDisk({})), s3);
    r.check("两处都没数据 → 沿用 data.json 里记的", s3.sidecarLocation === "visible");
    const shellDisk = makeDisk({ ".wt-comments/甲.批注.md": "c", "_写作工具箱/.DS_Store": "j" });
    await shellDisk.mkdir("_写作工具箱/快照/1-写作/甲");
    const s4 = settingsOf("visible");
    await M.resolveStartupSidecarLocation(appOf(shellDisk), s4);
    r.check("可同步目录只剩空文件夹和 .DS_Store 不算数据", s4.sidecarLocation === "hidden");
  }

  /* ── 6) 模块：确认后才搬并改设置；两处都有数据时提示合并 ── */
  {
    M.setSidecarLocation("hidden");
    const disk = makeDisk({ ".wt-comments/正文/甲.批注.md": "c" });
    const settings = { sidecarLocation: "hidden", snapshotFolder: ".wt-snapshots", sidecarLocationPromptDismissed: false };
    let saves = 0;
    let switched = 0;
    let confirm = null;
    const layoutReady = [];
    const mod = M.createSidecarLocationModule(
      { saveSettings: async () => { saves++; }, onSwitched: () => { switched++; } },
      (_app, title, message, _cta, onConfirm) => ({ open() { confirm = { title, message, onConfirm }; } })
    );
    // Obsidian 的索引：可见目录里的文件夹它知道；删文件夹要走 fileManager.trashFile，否则侧栏留下空文件夹
    const trashed = [];
    const vault = {
      adapter: disk,
      getAbstractFileByPath(p) {
        if (p.startsWith(".")) return null;
        if (disk.files.has(p)) return new TFile(p);
        if (disk.dirs.has(p)) return new TFolder(p);
        return null;
      },
      async createFolder(p) { await disk.mkdir(p); },
      async rename(file, to) { await disk.rename(file.path, to); },
    };
    const fileManager = {
      async trashFile(folder) {
        trashed.push(folder.path);
        await disk.rmdir(folder.path, true);
      },
    };
    const context = {
      app: { vault, fileManager },
      services: { settings: { get: () => settings } },
      events: { onLayoutReady: (fn) => layoutReady.push(fn) },
      effects: { add() {} },
    };
    mod.activate(context);
    mod.operations.switchTo("visible");
    await new Promise((res) => setTimeout(res, 10));
    r.check(
      "切换先弹确认（写明要搬几个），确认前不动文件和设置",
      confirm && confirm.message.includes("将搬 1 个文件") &&
        disk.files.has(".wt-comments/正文/甲.批注.md") && settings.sidecarLocation === "hidden" && saves === 0
    );
    confirm.onConfirm();
    await new Promise((res) => setTimeout(res, 10));
    r.check(
      "确认后：搬家、切进程内位置、写设置、通知设置页重画；隐藏目录的空壳整棵删掉",
      disk.files.has("_写作工具箱/批注/正文/甲.批注.md") &&
        settings.sidecarLocation === "visible" && M.getSidecarLocation() === "visible" &&
        saves === 1 && switched === 1 &&
        ![...disk.dirs].some((d) => d.startsWith(".wt-"))
    );

    // 切回隐藏目录：可见目录经 fileManager.trashFile 整棵删（让 Obsidian 索引知道）；.DS_Store 挡不住
    await disk.write("_写作工具箱/.DS_Store", "junk");
    await disk.write("_写作工具箱/批注/正文/.DS_Store", "junk");
    mod.operations.switchTo("hidden");
    await new Promise((res) => setTimeout(res, 10));
    confirm.onConfirm();
    await new Promise((res) => setTimeout(res, 10));
    r.check(
      "切回后：可见目录经 fileManager.trashFile 整棵删掉（不留在 Obsidian 侧栏里）",
      disk.files.has(".wt-comments/正文/甲.批注.md") &&
        !disk.dirs.has("_写作工具箱") && trashed.includes("_写作工具箱")
    );

    // 只有一处有数据：不提示
    const quietBefore = notices.length;
    for (const fn of layoutReady) fn();
    await new Promise((res) => setTimeout(res, 10));
    r.check("只有一处有数据：不提示", notices.length === quietBefore);

    // 两处都有真实文件（两台设备各自写过）：提示合并
    await disk.write("_写作工具箱/批注/正文/乙.批注.md", "另一台设备写的");
    const before = notices.length;
    for (const fn of layoutReady) fn();
    await new Promise((res) => setTimeout(res, 10));
    const prompt = notices[notices.length - 1];
    r.check(
      "两处都有数据 → 提示合并（合并到可同步目录 / 合并到隐藏目录 / 不再提示）",
      notices.length === before + 1 &&
        ["合并到可同步目录", "合并到隐藏目录", "不再提示"].every((t) =>
          prompt.children.some((c) => c.text === t)
        )
    );
    confirm = null; // 别复用上一次的确认框：合并必须自己弹一个
    prompt.children.find((c) => c.text === "合并到隐藏目录").onclick();
    await new Promise((res) => setTimeout(res, 10));
    r.check("点「合并」先弹确认", confirm !== null && confirm.message.includes("将搬 1 个文件"));
    if (confirm) confirm.onConfirm();
    await new Promise((res) => setTimeout(res, 10));
    r.check(
      "合并到当前档：另一处的文件搬过来，当前档不变",
      disk.files.get(".wt-comments/正文/乙.批注.md") === "另一台设备写的" &&
        disk.files.has(".wt-comments/正文/甲.批注.md") &&
        settings.sidecarLocation === "hidden" && !disk.dirs.has("_写作工具箱")
    );

    await disk.write("_写作工具箱/批注/正文/丙.批注.md", "又冲突了");
    for (const fn of layoutReady) fn();
    await new Promise((res) => setTimeout(res, 10));
    notices[notices.length - 1].children.find((c) => c.text === "不再提示").onclick();
    const before2 = notices.length;
    for (const fn of layoutReady) fn();
    await new Promise((res) => setTimeout(res, 10));
    r.check(
      "点了「不再提示」后不再出现",
      settings.sidecarLocationPromptDismissed === true && notices.length === before2
    );
  }

  return r.finish();
}

main()
  .then((ok) => { H.cleanup(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error("运行失败：" + e.stack); H.cleanup(); process.exit(2); });
