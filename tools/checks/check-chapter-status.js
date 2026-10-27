/**
 * 章节定稿锁检查（specs/chapter-final-lock.md）。
 *
 * 跑的都是真实实现：
 *   A. 编译 src/chapterLock.ts，用真实的 CodeMirror EditorState 跑过滤器：
 *      作者编辑事件（含输入法真实事件名 input.type.compose）被拦，
 *      没有作者事件标注的事务（Obsidian 加载文件、外部修改同步进编辑器）放行。
 *   B. 编译 src/features/chapterStatusModule.ts，注入假上下文（假元数据缓存、
 *      假 processFrontMatter、最小假 DOM）：
 *      定稿 / 改回草稿只改 frontmatter 的 wt-status、另一台设备同步来的状态不重启就生效、
 *      写入守卫、确认后临时解锁、标签页全部关闭才重新锁上、提示条挂在标题栏与正文之间、
 *      改名 / 删除后状态跟着文件走、旧 data.json 定稿表迁移、外部修改提示（只看正文、节流）、
 *      正文零写入、停用后全部放行。
 *   C. 交稿载荷去掉 frontmatter；源码级接线：data.json 旧表只读、快照写回守卫、
 *      对比窗口只读、编辑工具条只留批注、硬换行 / 标点辅助带 userEvent、编辑台右键菜单。
 *
 * 反向验证（每条都实际跑过）：
 *   · 过滤器去掉 isAuthorEdit 判断（任何改动都拦）→「加载 / 外部同步放行」变红；
 *   · AUTHOR_EDIT_EVENTS 把 "input" 收窄成 "input.type" → 粘贴 / 拖入变红；
 *   · relockClosed 不看标签页、一有布局变化就锁 →「两个标签页只关一个仍解锁」变红；
 *   · refreshBanners 不再摘掉解锁章节的提示条 →「临时解锁后提示条摘掉」变红；
 *   · 去掉元数据 changed 订阅 →「另一台设备同步来的定稿不重启就生效」变红；
 *   · cleanChapterText 不再去掉 frontmatter →「交稿载荷去掉 frontmatter」变红；
 *   · 手机悬浮标题栏规则去掉 top 偏移 →「提示条放到安全区 + 标题栏下方」变红；
 *   · 去掉 hardBreak 的 userEvent →「硬换行带 userEvent」变红。
 *
 * 不启动 Obsidian、不依赖 main.js、不联网。
 */
const fs = require("fs");
const path = require("path");

// 临时编译产物位于系统临时目录；让外置的 CodeMirror 解析回仓库依赖（同 check-hemingway-module.js）。
process.env.NODE_PATH = [
  path.resolve(__dirname, "..", "..", "node_modules"),
  process.env.NODE_PATH,
]
  .filter(Boolean)
  .join(path.delimiter);
require("module").Module._initPaths();

const H = require("./_harness");
const { EditorState } = require("@codemirror/state");

/** CodeMirror 外置：检查和被测代码必须用同一份 @codemirror/state，否则 instanceof 失效。 */
const CODEMIRROR_EXTERNALS = ["@codemirror/state", "@codemirror/view"];

function source(relPath) {
  return fs.readFileSync(path.join(H.ROOT, relPath), "utf8");
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

/** 最小假 DOM：只实现提示条用到的 Obsidian DOM 扩展方法。 */
class FakeEl {
  constructor(tag = "div", cls = "") {
    this.tag = tag;
    this.classes = new Set(cls ? cls.split(" ") : []);
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.text = "";
    this.offsetWidth = 0;
  }
  createSpan(opts = {}) {
    return this.createEl("span", opts);
  }
  createEl(tag, opts = {}) {
    const el = new FakeEl(tag, opts.cls || "");
    el.text = opts.text || "";
    el.parent = this;
    this.children.push(el);
    return el;
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  addClass(cls) {
    this.classes.add(cls);
  }
  removeClass(cls) {
    this.classes.delete(cls);
  }
  hasClass(cls) {
    return this.classes.has(cls);
  }
  insertBefore(el, ref) {
    el.parent = this;
    const at = this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, el);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  find(cls) {
    for (const child of this.children) {
      if (child.classes.has(cls)) return child;
      const hit = child.find(cls);
      if (hit) return hit;
    }
    return null;
  }
}

async function main() {
  const r = H.createReporter("章节定稿锁（真实实现）");

  // ── A. 过滤器（真实 CodeMirror） ─────────────────────────────
  {
    const lock = H.compile("src/chapterLock.ts", "chapter-lock", [
      "electron",
      ...CODEMIRROR_EXTERNALS,
    ]);
    let currentPath = "作品甲/正文/第1章.md";
    const lockedPaths = new Set([currentPath]);
    const blocked = [];
    const ext = lock.buildChapterLockExtension({
      isLocked: (p) => !!p && lockedPaths.has(p),
      pathOf: () => currentPath,
      onBlocked: (p) => blocked.push(p),
    });
    const base = EditorState.create({ doc: "第一段。", extensions: [ext] });
    const tryEdit = (userEvent) =>
      base.update({
        changes: { from: base.doc.length, insert: "多写一句" },
        ...(userEvent ? { userEvent } : {}),
      }).state.doc.toString();

    const authorEvents = [
      "input.type",
      "input.type.compose",
      "input.paste",
      "input.drop",
      "input",
      "delete.backward",
      "delete.cut",
      "undo",
      "redo",
      "move.drop",
    ];
    const leaked = authorEvents.filter((ev) => tryEdit(ev) !== "第一段。");
    r.check(
      "定稿章节：打字、输入法、粘贴、拖入、回车、删除、剪切、撤销、重做、拖动都改不了正文",
      leaked.length === 0,
      "漏过：" + leaked.join(", ")
    );
    r.check("被拦时回调 onBlocked（用来闪提示条）", blocked.length === authorEvents.length);
    r.check(
      "没有作者事件标注的事务放行（Obsidian 加载文件 / 外部修改同步进编辑器）",
      tryEdit(null) === "第一段。多写一句"
    );
    r.check("选区移动等非编辑事件放行", tryEdit("select") === "第一段。多写一句");
    lockedPaths.clear();
    r.check("临时解锁（不再锁定）后可以编辑", tryEdit("input.type") === "第一段。多写一句");
    lockedPaths.add(currentPath);
    currentPath = "作品甲/正文/第2章.md";
    r.check("草稿章节不受影响", tryEdit("input.type") === "第一段。多写一句");
    const selectOnly = base.update({ selection: { anchor: 0 }, userEvent: "select" });
    r.check("isAuthorEdit 只认真的改了文档的事务", lock.isAuthorEdit(selectOnly) === false);
  }

  // ── B. 模块（假上下文：元数据缓存 + processFrontMatter + 假 DOM） ──
  {
    const notices = [];
    const opened = [];
    const writes = [];
    const fmWrites = [];
    class TFile {}
    class Modal {
      constructor(app) {
        this.app = app;
      }
      open() {
        opened.push(this);
      }
      close() {}
    }
    global.createDiv = (opts = {}) => new FakeEl("div", opts.cls || "");
    const restore = H.stubObsidian({
      editorInfoField: {},
      Notice: class {
        constructor(message) {
          notices.push(message);
        }
      },
      setIcon() {},
      TFile,
      Modal,
      Setting: class {},
    });
    let mod;
    try {
      mod = H.compile("src/features/chapterStatusModule.ts", "chapter-status-module", [
        "electron",
        ...CODEMIRROR_EXTERNALS,
      ]);
    } finally {
      restore();
    }
    const KEY = mod.CHAPTER_STATUS_KEY;
    const FINAL = mod.CHAPTER_FINAL_VALUE;

    /** 假库：每个文件 = frontmatter 对象 + 正文；序列化成真实的 md 文本供 cachedRead。 */
    const files = {};
    const addFile = (p, body, fm = {}) => {
      files[p] = { fm: { ...fm }, body };
    };
    const serialize = (f) => {
      const keys = Object.keys(f.fm);
      if (keys.length === 0) return f.body;
      return `---\n${keys.map((k) => `${k}: ${f.fm[k]}`).join("\n")}\n---\n${f.body}`;
    };
    const fileObj = (p) => (p in files ? Object.assign(new TFile(), { path: p }) : null);
    const handlers = { vault: {}, workspace: {}, metadata: {}, layout: [] };
    const fireMeta = (name, p) => (handlers.metadata[name] || []).forEach((fn) => fn(fileObj(p) || { path: p }));
    let legacy = null;
    let legacyCleared = 0;
    const guards = [];
    const disposers = [];
    let leaves = [];
    const spy = (name) => async () => {
      writes.push(name);
    };
    const context = {
      app: {
        vault: {
          getAbstractFileByPath: fileObj,
          getMarkdownFiles: () => Object.keys(files).map(fileObj),
          cachedRead: async (file) => serialize(files[file.path]),
          modify: spy("vault.modify"),
          process: spy("vault.process"),
          create: spy("vault.create"),
          adapter: { write: spy("adapter.write") },
        },
        metadataCache: {
          getFileCache: (file) => (files[file.path] ? { frontmatter: files[file.path].fm } : null),
        },
        fileManager: {
          async processFrontMatter(file, fn) {
            const f = files[file.path];
            const before = f.body;
            fn(f.fm);
            fmWrites.push({ path: file.path, fm: { ...f.fm }, bodyKept: f.body === before });
            // 真实 Obsidian：写盘后元数据缓存更新并发 changed
            await tick();
            fireMeta("changed", file.path);
          },
        },
      },
      services: {
        editor: {
          registerWriteGuard(guard) {
            guards.push(guard);
            return () => guards.splice(guards.indexOf(guard), 1);
          },
        },
        ui: { leaves: () => leaves },
      },
      registrations: { registerEditorExtension() {} },
      events: {
        onVault(name, fn) {
          handlers.vault[name] = fn;
          return () => {};
        },
        onWorkspace(name, fn) {
          (handlers.workspace[name] = handlers.workspace[name] || []).push(fn);
          return () => {};
        },
        onMetadata(name, fn) {
          (handlers.metadata[name] = handlers.metadata[name] || []).push(fn);
          return () => {};
        },
        onLayoutReady(fn) {
          handlers.layout.push(fn);
          return () => {};
        },
      },
      effects: { add: (fn) => disposers.push(fn) },
      log: console,
    };
    const fire = (name) => (handlers.workspace[name] || []).forEach((fn) => fn());
    const guardReason = (p) => guards.map((g) => g(p)).find(Boolean) || null;
    const tab = (p) => ({ view: { file: { path: p } } });
    const noteTab = (p) => {
      const containerEl = new FakeEl("div", "workspace-leaf-content");
      containerEl.createEl("div", { cls: "view-header" });
      const contentEl = containerEl.createEl("div", { cls: "view-content" });
      return { view: { file: { path: p }, containerEl, contentEl } };
    };
    const bannerOf = (leaf) => leaf.view.containerEl.find("wt-lock-banner");

    // 旧版 data.json 定稿表（迁移用）
    addFile("作品甲/旧定稿.md", "旧定稿正文。", { outline: "旧章纲" });
    addFile("作品甲/旧草稿.md", "旧草稿正文。");
    legacy = {
      "作品甲/旧定稿.md": "final",
      "作品甲/已删除.md": "final",
      "作品甲/旧草稿.md": "draft",
    };

    const module = mod.createChapterStatusModule({
      legacyFinals: () => legacy,
      clearLegacy: () => {
        legacy = null;
        legacyCleared++;
      },
    });
    module.activate(context);
    const ops = module.operations;
    let notified = 0;
    ops.subscribe(() => notified++);
    handlers.layout.forEach((fn) => fn());
    await settle();

    r.check(
      "旧 data.json 定稿表搬进对应章节 frontmatter（只搬 final、跳过已删除的），然后清掉旧表",
      files["作品甲/旧定稿.md"].fm[KEY] === FINAL &&
        files["作品甲/旧定稿.md"].fm.outline === "旧章纲" &&
        !(KEY in files["作品甲/旧草稿.md"].fm) &&
        legacy === null &&
        legacyCleared === 1 &&
        ops.isFinal("作品甲/旧定稿.md")
    );

    // 定稿 / 改回草稿：只动 frontmatter 的 wt-status
    const ch1 = "作品甲/第1卷/第1章.md";
    addFile(ch1, "第一章正文。", { outline: "开端" });
    const notifiedBefore = notified;
    ops.setFinal(ch1, true);
    await settle();
    const lastWrite = fmWrites[fmWrites.length - 1];
    r.check(
      "设为定稿：frontmatter 写 wt-status: 定稿，别的字段与正文不动，通知订阅者",
      files[ch1].fm[KEY] === FINAL &&
        files[ch1].fm.outline === "开端" &&
        files[ch1].body === "第一章正文。" &&
        lastWrite.bodyKept &&
        notified > notifiedBefore
    );
    r.check(
      "定稿章节锁定，写入守卫给出原因",
      ops.isLocked(ch1) && guardReason(ch1) === mod.CHAPTER_LOCKED_REASON
    );
    r.check(
      "草稿章节不锁、守卫放行",
      !ops.isLocked("作品甲/旧草稿.md") && guardReason("作品甲/旧草稿.md") === null
    );

    // 另一台设备同步过来
    const ch2 = "作品甲/第1卷/第2章.md";
    addFile(ch2, "第二章正文。");
    const noteSync = noteTab(ch2);
    leaves = [noteSync];
    fire("file-open");
    const notifiedSync = notified;
    files[ch2].fm[KEY] = FINAL; // 手机端设了定稿，网盘把文件同步过来
    fireMeta("changed", ch2);
    r.check(
      "另一台设备同步来的定稿：不重启就锁上、挂提示条、通知编辑台刷新",
      ops.isLocked(ch2) && !!bannerOf(noteSync) && notified > notifiedSync
    );
    delete files[ch2].fm[KEY]; // 手机端改回草稿
    fireMeta("changed", ch2);
    r.check("另一台设备同步来的改回草稿：不重启就解锁、摘提示条", !ops.isLocked(ch2) && !bannerOf(noteSync));

    // 临时解锁 / 重新锁上
    ops.requestUnlock(ch1);
    r.check("点临时解锁先弹一次确认，确认前仍锁定", opened.length === 1 && ops.isLocked(ch1));
    opened[0].onConfirm();
    r.check(
      "确认后临时解锁：可编辑、守卫放行、状态仍是定稿",
      !ops.isLocked(ch1) && guardReason(ch1) === null && ops.isFinal(ch1)
    );
    leaves = [tab(ch1), tab(ch1)];
    fire("layout-change");
    leaves = [tab(ch1)];
    fire("layout-change");
    r.check("两个标签页都开着这章，只关一个：仍是解锁", !ops.isLocked(ch1));
    leaves = [tab("作品甲/旧草稿.md")];
    fire("file-open");
    r.check("同一标签页跳到别的文件（这章不再开着）：重新锁上", ops.isLocked(ch1));
    opened[0].onConfirm();
    leaves = [];
    fire("layout-change");
    r.check("标签页全部关闭：重新锁上", ops.isLocked(ch1));

    // 改名 / 删除：状态在 frontmatter，跟着文件走
    const renamed = "作品甲/第2卷/第一章 开端.md";
    files[renamed] = files[ch1];
    delete files[ch1];
    handlers.vault.rename({ path: renamed }, ch1);
    r.check("章节改名 / 挪卷：状态跟着文件走", ops.isLocked(renamed) && !ops.isFinal(ch1));
    delete files[renamed];
    handlers.vault.delete({ path: renamed });
    r.check("删除章节：不再是定稿", !ops.isFinal(renamed));

    // 外部修改提示
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const ch3 = "作品丙/正文/第3章.md";
      addFile(ch3, "第三章正文。", { outline: "章纲一" });
      ops.setFinal(ch3, true);
      await settle();
      const noticeStart = notices.length;
      await handlers.vault.modify({ path: ch3, name: "第3章.md" }); // 设定稿那次写盘本身
      await settle();
      r.check("设为定稿时那次写 frontmatter：不算外部修改", notices.length === noticeStart, notices.join(" | "));
      files[ch3].fm.outline = "章纲二";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await settle();
      r.check("只改了 frontmatter（如章纲存在 frontmatter）：不提示", notices.length === noticeStart);
      files[ch3].body = "第三章正文，被 Agent 改过。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await settle();
      r.check(
        "定稿章节正文被外部改了：提示一次，状态仍是定稿",
        notices.length === noticeStart + 1 && /第3章/.test(notices[notices.length - 1]) && ops.isFinal(ch3),
        notices.join(" | ")
      );
      now += 10_000;
      files[ch3].body += "又改一句。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await settle();
      r.check("1 分钟内同一章再被改：不重复提示", notices.length === noticeStart + 1);
      now += 61_000;
      files[ch3].body += "再改一句。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await settle();
      r.check("超过 1 分钟再被改：再提示一次", notices.length === noticeStart + 2);

      ops.unlock(ch3);
      now += 120_000;
      files[ch3].body += "作者自己改。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await settle();
      r.check("临时解锁期间作者自己改（Obsidian 保存）：不提示", notices.length === noticeStart + 2);
      leaves = [];
      fire("layout-change");
      now += 2_000;
      files[ch3].body += "关标签页时补存。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await settle();
      r.check("刚重新锁上时 Obsidian 补存解锁期间的改动：不提示", notices.length === noticeStart + 2);

      await handlers.vault.modify({ path: "作品甲/旧草稿.md", name: "旧草稿.md" });
      await settle();
      r.check("草稿章节被改：不提示", notices.length === noticeStart + 2);

      ops.setFinal(ch3, false);
      await settle();
      r.check(
        "改回草稿：删掉 wt-status，别的 frontmatter 保留，不再锁定",
        !(KEY in files[ch3].fm) && files[ch3].fm.outline === "章纲二" && !ops.isLocked(ch3)
      );
    } finally {
      Date.now = realNow;
    }

    r.check(
      "全程只经 processFrontMatter 改 wt-status，从没整文件写过（正文零写入）",
      writes.length === 0 && fmWrites.every((w) => w.bodyKept),
      writes.join(", ")
    );

    // 提示条
    const ch9 = "作品丁/第9章.md";
    addFile(ch9, "第九章。");
    addFile("作品丁/第10章.md", "第十章。");
    const noteA = noteTab(ch9);
    const noteB = noteTab("作品丁/第10章.md");
    leaves = [noteA, noteB];
    fire("file-open");
    r.check("草稿章节：没有提示条", !bannerOf(noteA) && !bannerOf(noteB));
    ops.setFinal(ch9, true);
    await settle();
    const banner = bannerOf(noteA);
    const shell = noteA.view.containerEl.children.map((el) => [...el.classes][0]);
    r.check(
      "设为定稿：提示条挂在标题栏与正文区之间，外壳打上让位标记",
      !!banner &&
        shell.join(",") === "view-header,wt-lock-banner,view-content" &&
        noteA.view.containerEl.hasClass("wt-has-lock-banner") &&
        !bannerOf(noteB),
      shell.join(",")
    );
    r.check(
      "提示条写着「本章已定稿」并有「临时解锁」按钮",
      !!banner.find("wt-lock-banner-btn") && banner.children.some((el) => el.text === "本章已定稿")
    );
    const openedBefore = opened.length;
    banner.find("wt-lock-banner-btn").listeners.click();
    r.check("点「临时解锁」弹确认", opened.length === openedBefore + 1);
    opened[opened.length - 1].onConfirm();
    r.check(
      "临时解锁后提示条摘掉、让位标记去掉",
      !bannerOf(noteA) && !noteA.view.containerEl.hasClass("wt-has-lock-banner")
    );
    leaves = [noteB];
    fire("layout-change");
    leaves = [noteA, noteB];
    fire("file-open");
    r.check("关掉再打开：重新锁上，提示条回来", ops.isLocked(ch9) && !!bannerOf(noteA));
    noteA.view.file = { path: "作品丁/第10章.md" };
    fire("file-open");
    r.check("同一标签页跳到草稿章节：提示条摘掉", !bannerOf(noteA));
    noteA.view.file = { path: ch9 };
    fire("file-open");
    r.check("再跳回定稿章节：提示条回来", !!bannerOf(noteA));

    for (const dispose of disposers.splice(0).reverse()) dispose();
    r.check(
      "模块停用：不再锁定，写入守卫撤掉，提示条全部摘掉",
      !ops.isLocked(ch9) && guards.length === 0 && !bannerOf(noteA)
    );
  }

  // ── C. 交稿载荷 + 源码级接线 ────────────────────────────────
  {
    const { cleanChapterText } = H.compile("src/formatWrap.ts", "format-wrap-clean");
    const raw = "---\nwt-status: 定稿\noutline: 主角离开故乡\n---\n\n第一段。  \n第二段。\n\n\n";
    r.check(
      "交稿载荷（复制纯净正文 / 读者手机预览）去掉 frontmatter，状态与章纲不会被粘出去",
      cleanChapterText(raw) === "第一段。\n第二段。\n",
      JSON.stringify(cleanChapterText(raw))
    );

    const mainSource = source("src/main.ts");
    const persist = H.extractMethod(mainSource, "private pluginDataPayload()");
    const load = H.extractMethod(mainSource, "private async loadPluginData()");
    r.check(
      "data.json 旧定稿表只读：读进来等迁移，搬完前原样带回，不再写新状态",
      /this\.legacyChapterStatus = asRecord/.test(load) &&
        /\.\.\.\(this\.legacyChapterStatus \? \{ chapterStatus: this\.legacyChapterStatus \} : \{\}\)/.test(persist) &&
        !/chapterStatus: this\.chapterStatus/.test(persist)
    );

    const moduleSource = source("src/features/chapterStatusModule.ts");
    r.check(
      "状态读写走 frontmatter：读元数据缓存、写只用 processFrontMatter、订阅元数据变化",
      /metadataCache\.getFileCache/.test(moduleSource) &&
        /fileManager\.processFrontMatter/.test(moduleSource) &&
        /onMetadata\("changed"/.test(moduleSource) &&
        !/vault\.(modify|process|create)\(/.test(moduleSource)
    );

    const lockSource = source("src/chapterLock.ts");
    r.check(
      "过滤器只拦作者编辑事件，不一刀切拦所有改动",
      /if \(!isAuthorEdit\(tr\)\) return tr;/.test(lockSource) &&
        /"input", "delete", "undo", "redo", "move\.drop"/.test(lockSource)
    );
    r.check("锁定状态每次现问 isLocked，不靠缓存拦截", /config\.isLocked\(path\)/.test(lockSource));
    r.check(
      "提示条挂在笔记视图上（不在 CodeMirror 面板里，手机端面板不显示），正文区让出高度",
      !/showPanel/.test(lockSource) &&
        /host\.insertBefore\(el, content\)/.test(moduleSource) &&
        /\.wt-has-lock-banner\s*>\s*\.view-content\s*\{[^}]*flex: 1 1 0;[^}]*min-height: 0;/.test(
          source("styles.css")
        )
    );
    const css = source("styles.css");
    const phoneBanner = css.match(
      /\.is-phone\.is-floating-nav \.workspace-leaf-content\.wt-has-lock-banner > \.wt-lock-banner,\s*\.is-phone\.auto-full-screen [^{]*\{([^}]*)\}/
    );
    r.check(
      "手机悬浮标题栏模式：提示条放到「安全区 + 标题栏」下方，正文留白加上提示条高度（否则钻到状态栏下面点不到）",
      !!phoneBanner &&
        /position: absolute;/.test(phoneBanner[1]) &&
        /top: calc\(var\(--safe-area-inset-top\) \+ var\(--view-header-height\)\);/.test(phoneBanner[1]) &&
        /padding-top: calc\(var\(--view-top-spacing-markdown\) \+ var\(--wt-lock-banner-height\)\);/.test(css) &&
        /body:not\(\.is-floating-nav\):not\(\.auto-full-screen\)\s*\.workspace-leaf-content\.wt-has-lock-banner/.test(css)
    );

    const diffSource = source("src/snapshotDiff.ts");
    const restoreFn = H.extractMethod(diffSource, "export async function performRestore(");
    const applyFn = H.extractMethod(diffSource, "export async function applySnapshotContent(");
    const guarded = (fn) =>
      fn.indexOf("writeBlockReason") >= 0 &&
      fn.indexOf("writeBlockReason") < fn.indexOf("replaceEditorText(");
    r.check("快照「恢复」与对比窗口写回：写之前先问写入守卫", guarded(restoreFn) && guarded(applyFn));
    r.check(
      "对比窗口：定稿锁定中右栏只读",
      /const locked = this\.host\.writeBlockReason\?\.\(this\.sourcePath\)/.test(diffSource) &&
        /setAttr\("contenteditable", "false"\)/.test(diffSource)
    );
    r.check(
      "快照 UI 把写入守卫接进 host",
      /writeBlockReason: \(path\) => context\.services\.editor\.writeBlockReason\(path\)/.test(
        source("src/features/snapshotUiModule.ts")
      )
    );
    const toolbar = source("src/formatToolbar.ts");
    r.check(
      "编辑工具条：锁定中收起格式按钮，批注照常",
      /const formatOk = scopeOk && !\(config\.isWriteBlocked\?\.\(path\) \?\? false\)/.test(toolbar) &&
        /\(scopeOk \|\| \(config\.commentBubbleEverywhere/.test(toolbar) &&
        /isWriteBlocked: \(path\) =>\s*context\.services\.editor\.writeBlockReason\(path\) !== null/.test(
          source("src/features/formatToolbarModule.ts")
        )
    );
    r.check(
      "硬换行写入带 userEvent（过滤器才认得出是作者输入）",
      /insert: plan\.insert \},[\s\S]{0,120}userEvent: "input"/.test(source("src/hardBreak.ts"))
    );
    const punctuationSource = source("src/punctuation.ts");
    r.check(
      "标点辅助每处改文档写入都带 userEvent",
      (punctuationSource.match(/changes: \{/g) || []).length ===
        (punctuationSource.match(/userEvent: "(input\.type|delete\.backward)"/g) || []).length &&
        /userEvent: "delete\.backward"/.test(punctuationSource)
    );
    const workbench = source("src/workbench.ts");
    r.check(
      "编辑台右键菜单切换「设为定稿 / 改回草稿」，行上有锁标记",
      /isFinal \? "改回草稿" : "设为定稿"/.test(workbench) &&
        /caps\.chapterStatus\.setFinal\(/.test(workbench) &&
        /wt-wb-ch-lock/.test(workbench)
    );
    r.check("定稿模块不注册命令", !/addCommand\(/.test(moduleSource));
  }

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
