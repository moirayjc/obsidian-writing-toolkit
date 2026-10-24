/**
 * 检查：批注页边对话卡（specs/comment-margin-cards.md）。
 *
 * 1. 版心让位（planMarginSpace）：宽屏不让、窄一些让最少的、太窄不显示、关掉可读行宽时的让法；
 * 2. 卡片排布（layoutCards）：挨得近的错开不重叠、展开的那张对齐原文、上面的卡往上让、
 *    让到顶不够才整体往下、无法定位的排最下面；
 * 3. 对话体（commentThread.ts）：页边新建只画原文和输入框；侧栏里的空白注照旧能「已解决」；
 * 4. 批注模块的接线：点标记先展开页边卡、放不下退回侧栏；侧栏列表行优先在页边打开；
 *    选中文字新建时页边放得下就不弹居中框；新建没写就收起会删掉空批注、有消息的不动；
 *    草稿表侧栏和页边共用；Esc 在 window 捕获阶段收起（Obsidian 快捷键系统会先拦）、
 *    真收起了才吃掉这次 Esc；进沉浸模式（番茄钟锁定也走这里）时主入口收起所有卡。
 *
 * 滚动是否跟手、会不会抖、输入法、各主题下的样子验证不了，只能进 Obsidian 手点。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("./_harness");

/* ---------- 最小假 DOM（只实现对话体 / 面板用到的方法） ---------- */
class FakeEl {
  constructor(tag = "div", opts = {}) {
    this.tag = tag;
    this.classes = new Set((opts.cls || "").split(" ").filter(Boolean));
    this.attrs = { ...(opts.attr || {}) };
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.text = opts.text || "";
    this.value = "";
    this.disabled = false;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.scrollTop = 0;
    this.ownerDocument = { activeElement: null };
  }
  get isConnected() { return true; }
  createDiv(opts = {}) { return this.createEl("div", opts); }
  createSpan(opts = {}) { return this.createEl("span", opts); }
  createEl(tag, opts = {}) {
    const el = new FakeEl(tag, opts);
    el.parent = this;
    el.ownerDocument = this.ownerDocument;
    this.children.push(el);
    return el;
  }
  empty() { this.children = []; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
  }
  addClass(c) { this.classes.add(c); }
  removeClass(c) { this.classes.delete(c); }
  hasClass(c) { return this.classes.has(c); }
  setText(t) { this.text = t; }
  setAttr(k, v) { this.attrs[k] = v; }
  get parentElement() { return this.parent; }
  scrollTo() {}
  focus() {}
  setSelectionRange() {}
  querySelector() { return null; }
  contains() { return false; }
  all(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.all(pred, out);
    }
    return out;
  }
  byClass(c) { return this.all((e) => e.classes.has(c)); }
  byText(t) { return this.all((e) => e.text === t)[0] || null; }
}
global.HTMLTextAreaElement = class {};
global.window = global.window || { setTimeout: () => 0, clearTimeout() {} };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

/* ---------- 1 + 2：纯函数 ---------- */
function checkPure(r, M) {
  const need = M.MARGIN_GAP + M.MARGIN_CARD_WIDTH + M.MARGIN_EDGE;
  const pad = 32;
  // 宽屏：正文 700 居中后右边本来就够
  const wide = M.planMarginSpace({ clientWidth: 1600, padLeft: pad, padRight: pad, lineWidth: 700 });
  r.check("宽屏：右边本来放得下，不让位", wide.available && wide.reserve === 0, JSON.stringify(wide));

  // 中等：要让，让完右侧空白刚好够一张卡，正文仍是满行宽
  const mid = { clientWidth: 1100, padLeft: pad, padRight: pad, lineWidth: 700 };
  const midPlan = M.planMarginSpace(mid);
  const content = mid.clientWidth - pad - pad - midPlan.reserve;
  const textW = Math.min(700, content);
  const freeRight = pad + midPlan.reserve + (content - textW) / 2;
  r.check(
    "中等宽度：只让最少的右内边距，让完右侧空白够一张卡、正文仍满行宽",
    midPlan.available && midPlan.reserve > 0 && freeRight >= need && freeRight < need + 1 && textW === 700,
    JSON.stringify({ midPlan, freeRight, need, textW })
  );

  // 再窄：正文开始变窄，但还不到下限
  const narrow = M.planMarginSpace({ clientWidth: 860, padLeft: pad, padRight: pad, lineWidth: 700 });
  const narrowText = Math.min(700, 860 - pad - pad - narrow.reserve);
  r.check(
    "较窄：正文变窄让出页边，仍不低于下限",
    narrow.available && narrow.reserve === need - pad && narrowText >= M.MARGIN_MIN_TEXT,
    JSON.stringify({ narrow, narrowText })
  );

  // 太窄：放不下就不显示（退回侧栏），也不让位
  const tiny = M.planMarginSpace({ clientWidth: 700, padLeft: pad, padRight: pad, lineWidth: 700 });
  r.check("太窄：不显示页边、不让位", !tiny.available && tiny.reserve === 0, JSON.stringify(tiny));

  // 关掉「可读行宽」：正文铺满，只能整块让出页边
  const free = M.planMarginSpace({ clientWidth: 1400, padLeft: pad, padRight: pad, lineWidth: Infinity });
  r.check(
    "关掉可读行宽：让出一整张卡的位置",
    free.available && free.reserve === need - pad,
    JSON.stringify(free)
  );

  const H40 = 40;
  const gap = M.MARGIN_CARD_GAP;
  const noOverlap = (tops, slots) => {
    const sorted = slots
      .map((s) => ({ top: tops.get(s.id), h: s.height }))
      .sort((a, b) => a.top - b.top);
    return sorted.every((s, i) => i === 0 || s.top >= sorted[i - 1].top + sorted[i - 1].h + gap);
  };

  const spread = [
    { id: 1, desired: 0, height: H40 },
    { id: 2, desired: 300, height: H40 },
  ];
  const spreadTops = M.layoutCards(spread, null);
  r.check(
    "离得远的卡各自对齐自己的行",
    spreadTops.get(1) === 0 && spreadTops.get(2) === 300
  );

  const crowd = [
    { id: 3, desired: 100, height: H40 },
    { id: 1, desired: 100, height: H40 },
    { id: 2, desired: 110, height: H40 },
  ];
  const crowdTops = M.layoutCards(crowd, null);
  r.check(
    "挨得近的依次往下错开、不重叠，同一行按编号",
    crowdTops.get(1) === 100 && crowdTops.get(3) === 100 + H40 + gap &&
      crowdTops.get(2) === 100 + 2 * (H40 + gap) && noOverlap(crowdTops, crowd),
    JSON.stringify([...crowdTops])
  );

  const big = [
    { id: 1, desired: 200, height: H40 },
    { id: 2, desired: 210, height: 300 },
    { id: 3, desired: 220, height: H40 },
  ];
  const bigTops = M.layoutCards(big, 2);
  r.check(
    "展开的那张对齐原文，上面的卡往上让，下面的往下排",
    bigTops.get(2) === 210 && bigTops.get(1) === 210 - H40 - gap &&
      bigTops.get(3) === 210 + 300 + gap && noOverlap(bigTops, big),
    JSON.stringify([...bigTops])
  );

  const top = [
    { id: 1, desired: 0, height: H40 },
    { id: 2, desired: 10, height: H40 },
    { id: 3, desired: 20, height: 200 },
  ];
  const topTops = M.layoutCards(top, 3);
  r.check(
    "上面让到顶也不够：整体往下排，不出现负坐标",
    [...topTops.values()].every((t) => t >= 0) && noOverlap(topTops, top) && topTops.get(1) === 0,
    JSON.stringify([...topTops])
  );

  const lost = [
    { id: 5, desired: null, height: H40 },
    { id: 1, desired: 50, height: H40 },
    { id: 4, desired: null, height: H40 },
  ];
  const lostTops = M.layoutCards(lost, null);
  r.check(
    "无法定位的排在最下面，按编号",
    lostTops.get(1) === 50 && lostTops.get(4) === 50 + H40 + gap &&
      lostTops.get(5) === 50 + 2 * (H40 + gap),
    JSON.stringify([...lostTops])
  );
}

/* ---------- 3：对话体 ---------- */
function checkThread(r, T, Panel) {
  const host = {
    replyToComment: async () => true,
    editComment() {},
    resolveComment() {},
    rejectComment() {},
    adoptSuggestion: async () => true,
    copyText() {},
    rebindComment() {},
  };
  const blank = {
    id: 9, origin: "author", quote: "灯还亮着", messages: [], turn: "agent", gone: false,
    lineHint: 1, createdAt: "", locatedLine: 1, via: "exact",
  };
  const composing = new FakeEl();
  T.renderThreadBody(composing, blank, {
    host, docPath: "正文/甲.md", drafts: new Map(), onClosed() {}, composing: true,
  });
  const input = composing.byClass("wt-comment-reply-input")[0];
  r.check(
    "页边新建：只有原文和输入框，占位写「写批注」，没有结案按钮",
    input && /写批注/.test(input.attrs.placeholder) &&
      composing.byClass("wt-comment-card-actions").length === 0 &&
      composing.byClass("wt-comment-quote").length === 1
  );
  const sidebar = new FakeEl();
  T.renderThreadBody(sidebar, blank, {
    host, docPath: "正文/甲.md", drafts: new Map(), onClosed() {},
  });
  r.check(
    "侧栏里的空白注：照旧有「已解决」，占位仍是「回复」",
    sidebar.byText("已解决") !== null &&
      /回复/.test(sidebar.byClass("wt-comment-reply-input")[0].attrs.placeholder)
  );

  const drafts = new Map();
  const typed = new FakeEl();
  T.renderThreadBody(typed, { ...blank, messages: [{ by: "agent", text: "x" }] }, {
    host, docPath: "正文/甲.md", drafts, onClosed() {},
  });
  const box = typed.byClass("wt-comment-reply-input")[0];
  box.value = "写了一半";
  box.fire("input");
  r.check("回复草稿写进共用的草稿表（按文档 + 批注号）", drafts.get(T.draftKey("正文/甲.md", 9)) === "写了一半");

  // 侧栏列表：页边打开成功就留在列表，不进详情、不另跳正文
  const model = {
    docPath: "正文/甲.md", docName: "甲", loading: false, rejectedCount: 0,
    items: [{ ...blank, id: 1, messages: [{ by: "agent", text: "意见" }], turn: "author" }],
  };
  let marginOk = true;
  const calls = { margin: [], jump: [] };
  const panelHost = {
    ...host,
    getCommentPanelModel: async () => model,
    jumpToComment: (p, id) => calls.jump.push([p, id]),
    openInMargin: (p, id) => {
      calls.margin.push([p, id]);
      return marginOk;
    },
    copyReviewPrompt() {},
    copyReplyPrompt() {},
  };
  return { panelHost, model, calls, setMargin: (v) => (marginOk = v), Panel };
}

async function checkPanelRow(r, ctx) {
  const root = new FakeEl();
  const panel = new ctx.Panel(root, ctx.panelHost, new Map());
  panel.refresh();
  await settle();
  root.byClass("wt-comment-row")[0].fire("click");
  await settle();
  r.check(
    "侧栏列表行：页边打开了就留在列表（不进详情、不另跳正文）",
    ctx.calls.margin.length === 1 && ctx.calls.jump.length === 0 &&
      root.byClass("wt-comment-detail").length === 0
  );
  ctx.setMargin(false);
  root.byClass("wt-comment-row")[0].fire("click");
  await settle();
  r.check(
    "侧栏列表行：页边放不下就照旧跳正文并进详情",
    ctx.calls.jump.length === 1 && root.byClass("wt-comment-detail").length === 1
  );
}

/* ---------- 4：批注模块接线 ---------- */
async function checkModule(r, entryPath) {
  const DOC = "正文/第一章.md";
  class TFile {
    constructor(p) {
      this.path = p;
      this.name = p.split("/").pop();
      this.extension = this.name.split(".").pop();
      this.stat = { size: 1, mtime: 1 };
    }
  }
  class MarkdownView {}
  global.createFragment = () => ({ append() {} });
  global.createSpan = () => ({});
  global.createEl = () => ({});
  const restore = H.stubObsidian({
    Modal: class {}, Notice: class { hide() {} }, TFile, TFolder: class {}, MarkdownView,
    editorInfoField: {}, setIcon() {},
  });
  let E;
  try {
    E = H.compile(entryPath, "comment-margin-entry", ["electron"]);
  } finally {
    restore();
  }
  const { EffectScope } = H.compile("src/host/effectScope.ts", "comment-margin-scope");

  const chapter = new TFile(DOC);
  const text = "风停了，渡口的船都歇了。\n\n他把灯放下，转身出门。";
  const margin = {
    ok: true,
    reveals: [],
    composes: [],
    available() { return this.ok; },
    reveal(id) { this.reveals.push(id); return this.ok; },
    beginCompose(id) { this.composes.push(id); return this.ok; },
    open: false,
    collapses: 0,
    expanded() { return this.open; },
    collapse() { this.collapses++; this.open = false; },
  };
  const dispatched = [];
  const cm = {
    state: {
      doc: {
        toString: () => text,
        length: text.length,
        lineAt: () => ({ number: 3 }),
      },
      selection: { main: { from: 14, to: 18 } },
      sliceDoc: (a, b) => text.slice(a, b),
      field: () => ({ anchors: [{ id: 1, from: 4, to: 8 }] }),
    },
    plugin: () => margin,
    dispatch: (spec) => dispatched.push(spec),
  };
  const view = new MarkdownView();
  view.file = chapter;
  view.editor = { getValue: () => text, __cm: cm };
  const leaf = { view };
  view.leaf = leaf;

  const disk = new Map([[DOC, [{
    id: 1, origin: "agent", quote: "渡口", paragraph: "", paragraphHint: 0, lineHint: 1,
    createdAt: "", messages: [{ by: "agent", text: "意见" }], current: "",
  }]]]);
  const cache = new Map();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const store = {
    getCached: (p) => cache.get(p),
    async reload(p) { cache.delete(p); return this.load(p); },
    async load(p) {
      if (!cache.has(p)) cache.set(p, clone(disk.get(p) ?? []));
      return cache.get(p);
    },
    ensureLoaded() {},
    invalidate: (p) => cache.delete(p),
    invalidatePrefix() {},
    getRejected: () => [],
    async save(p, list) { disk.set(p, clone(list)); cache.set(p, clone(list)); },
    handleModified: () => null,
    handleDeleted: () => null,
    handleRenamed: () => [],
  };
  const settings = { commentsEnabled: true, commentBubbleEverywhere: true };
  const domListeners = [];
  let sidebarOpened = 0;
  const revealed = [];
  let draftsSeen = null;
  let decorCfg = null;
  let marginCfg = null;
  const drafts = [];
  const context = {
    app: {
      vault: {
        getAbstractFileByPath: (p) => (p === DOC ? chapter : null),
        cachedRead: async () => text,
        adapter: { getBasePath: () => "/库" },
      },
      workspace: { getActiveFile: () => chapter, getActiveViewOfType: () => view },
    },
    services: {
      settings: { get: () => settings, subscribe: () => () => {} },
      editor: {
        getFilePath: () => DOC,
        getViewForEditor: (editor) => editor?.__cm,
        writeBlockReason: () => null,
      },
      ui: {
        leaves: (type) => (type === "markdown" ? [leaf] : []),
        getLeaf: () => leaf,
        reveal() {},
        registerPanel: (_slot, factory) => {
          factory(new FakeEl());
          return () => {};
        },
      },
      diagnostics: { recordTiming() {} },
    },
    registrations: { registerEditorExtension() {} },
    events: {
      onWorkspace: () => () => {},
      onVault: () => () => {},
      onDom: (target, type, fn, options) => {
        domListeners.push({ target, type, fn, options });
        return () => {};
      },
      setTimeout: (cb) => (cb(), 1),
    },
    effects: new EffectScope("comment-margin-test"),
  };
  const module = E.createCommentsModule(
    {
      getRecentMarkdownPath: () => DOC,
      async openSidebar() { sidebarOpened++; },
      isFormatScopeAllowed: () => true,
    },
    {
      createStore: () => store,
      buildExtensions: (cfg) => { decorCfg = cfg; return E.buildCommentExtensions(cfg); },
      buildMargin: (cfg) => { marginCfg = cfg; return E.buildMarginExtension(cfg); },
      refreshDecor() {},
      createPanel: (_c, _h, d) => {
        draftsSeen = d;
        return { refresh() {}, destroy() {}, async revealCard(id) { revealed.push(id); } };
      },
      createDraft: (...args) => ({ open() { drafts.push(args[1]); } }),
    }
  );
  await module.activate(context);
  const ops = module.operations;
  await store.load(DOC);

  r.check("草稿表：侧栏面板和页边卡拿到的是同一张", draftsSeen !== null && draftsSeen === marginCfg.drafts);
  const esc = domListeners.find((l) => l.type === "keydown");
  r.check(
    "Esc：挂在 window 的捕获阶段（Obsidian 快捷键系统会先拦掉，编辑器和卡片里收不到）",
    esc && esc.target === global.window && (esc.options === true || esc.options?.capture === true)
  );
  const press = (extra = {}) => {
    let stopped = false;
    esc.fn({ key: "Escape", isComposing: false, stopPropagation: () => (stopped = true), ...extra });
    return stopped;
  };
  margin.open = true;
  const stoppedOpen = press();
  r.check(
    "Esc：有展开的卡就收起，并吃掉这次 Esc（不顺带退出沉浸）",
    margin.collapses === 1 && stoppedOpen === true
  );
  const stoppedClosed = press();
  r.check("Esc：没有展开的卡就放行（照旧退出沉浸等）", margin.collapses === 1 && stoppedClosed === false);
  margin.open = true;
  press({ isComposing: true });
  press({ key: "Enter" });
  r.check("Esc：输入法拼字中的 Esc、别的键都不管", margin.collapses === 1 && margin.open === true);
  ops.collapseMarginCards();
  r.check("收起所有页边卡的操作（给沉浸模式用）", margin.collapses === 2 && margin.open === false);

  const comment = (await store.load(DOC))[0];
  decorCfg.onRevealComment(DOC, comment, cm);
  await settle();
  r.check(
    "点标记：页边放得下就展开页边卡，不开侧栏",
    margin.reveals.join(",") === "1" && sidebarOpened === 0
  );
  margin.ok = false;
  decorCfg.onRevealComment(DOC, comment, cm);
  await settle();
  r.check(
    "点标记：页边放不下退回侧栏详情页",
    sidebarOpened === 1 && revealed.includes(1)
  );

  margin.ok = true;
  margin.reveals = [];
  const opened = ops.openInMargin(DOC, 1);
  r.check(
    "侧栏行 → 页边：滚到那处（不动光标）并展开",
    opened === true && margin.reveals.join(",") === "1" &&
      dispatched.length === 1 && dispatched[0].effects && !dispatched[0].selection
  );
  r.check("侧栏行 → 页边：正文里定位不到的那条不走页边", ops.openInMargin(DOC, 99) === false);
  margin.ok = false;
  r.check("侧栏行 → 页边：页边放不下返回 false", ops.openInMargin(DOC, 1) === false);

  margin.ok = true;
  ops.addCommentForView(cm);
  await settle();
  const afterAdd = disk.get(DOC);
  const fresh = afterAdd.find((c) => c.id === 2);
  r.check(
    "新建批注：页边放得下就在页边出空白卡，不弹居中输入框",
    fresh && fresh.messages.length === 0 && margin.composes.join(",") === "2" && drafts.length === 0,
    JSON.stringify({ afterAdd, composes: margin.composes, drafts })
  );
  marginCfg.discardEmpty(DOC, 2);
  marginCfg.discardEmpty(DOC, 1);
  await ops.flush();
  r.check(
    "新建没写就收起：删掉那条空批注，有消息的不动",
    disk.get(DOC).map((c) => c.id).join(",") === "1"
  );

  margin.ok = false;
  ops.addCommentForView(cm);
  await settle();
  r.check("新建批注：页边放不下仍用居中输入框", drafts.length === 1);
}

function checkMainSource(r) {
  const main = fs.readFileSync(path.join(H.ROOT, "src", "main.ts"), "utf8");
  const start = main.indexOf("setImmersiveMode(on: boolean)");
  const body = start >= 0 ? main.slice(start, main.indexOf("\n  }\n", start)) : "";
  r.check(
    "进沉浸模式（番茄钟锁定也走 setImmersiveMode）时收起页边卡",
    /if \(on\) \{[\s\S]*?this\.collapseCommentMargins\(\)/.test(body) &&
      /commentsModule\?\.operations\.collapseMarginCards\(\)/.test(main)
  );
}

async function main() {
  const r = H.createReporter("批注页边对话卡");
  const restore = H.stubObsidian({ editorInfoField: {}, setIcon() {} });
  let M, T, Panel;
  try {
    M = H.compile("src/commentMargin.ts", "comment-margin");
    T = H.compile("src/commentThread.ts", "comment-thread");
    ({ CommentPanelBody: Panel } = H.compile("src/commentView.ts", "comment-margin-panel"));
  } finally {
    restore();
  }
  checkPure(r, M);
  checkMainSource(r);
  const ctx = checkThread(r, T, Panel);
  await checkPanelRow(r, ctx);

  // 模块和两组编辑器扩展要编进同一个包（页边要读同一份装饰字段），临时写一个入口
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-margin-entry-"));
  const entry = path.join(dir, "entry.ts");
  const src = (p) => JSON.stringify(path.join(H.ROOT, "src", p));
  fs.writeFileSync(
    entry,
    [
      `export { createCommentsModule } from ${src("features/commentsModule")};`,
      `export { buildCommentExtensions } from ${src("commentDecor")};`,
      `export { buildMarginExtension } from ${src("commentMargin")};`,
    ].join("\n")
  );
  try {
    await checkModule(r, path.relative(H.ROOT, entry));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
