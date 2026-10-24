/**
 * 检查：批注面板的「标签 → 列表 → 单条详情」（src/commentView.ts 真实实现 + 最小假 DOM）。
 *
 * 覆盖：默认标签（有等你的选等你，否则全部）、标签切换、点列表行跳正文并进详情、
 * 详情页内容不挂点击跳转、「定位」才跳、已解决后回列表、正文点标记直接进详情
 * （即使同时换了活动文档）、换文档回列表、详情原地刷新时保留回复草稿。
 * 渲染外观、选中复制的手感验证不了，只能进 Obsidian 手点。
 */
const H = require("./_harness");

/** 最小假 DOM：只实现面板用到的 Obsidian DOM 扩展方法。 */
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
  get isConnected() {
    return true;
  }
  createDiv(opts = {}) {
    return this.createEl("div", opts);
  }
  createSpan(opts = {}) {
    return this.createEl("span", opts);
  }
  createEl(tag, opts = {}) {
    const el = new FakeEl(tag, opts);
    el.parent = this;
    el.ownerDocument = this.ownerDocument;
    this.children.push(el);
    return el;
  }
  empty() {
    this.children = [];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
  }
  addClass(c) { this.classes.add(c); }
  removeClass(c) { this.classes.delete(c); }
  hasClass(c) { return this.classes.has(c); }
  toggleClass(c, on) { on ? this.classes.add(c) : this.classes.delete(c); }
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
  textAll() { return this.all(() => true).map((e) => e.text).join("|"); }
}

// 面板用 instanceof 判断焦点是不是回复框；假 DOM 里给个空类即可
global.HTMLTextAreaElement = class {};
// 「一次确认」按钮的 3 秒复位计时器
global.window = { setTimeout: () => 0, clearTimeout() {} };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

async function main() {
  const r = H.createReporter("批注面板：标签 / 列表 / 详情");
  const restore = H.stubObsidian({ setIcon() {} });
  let CommentPanelBody;
  try {
    ({ CommentPanelBody } = H.compile("src/commentView.ts", "comment-panel"));
  } finally {
    restore();
  }

  const item = (id, turn, extra = {}) => ({
    id,
    origin: "agent",
    quote: `原文${id}`,
    messages:
      turn === "author"
        ? [{ by: "agent", text: `意见${id}` }]
        : [{ by: "agent", text: `意见${id}` }, { by: "author", text: `回复${id}` }],
    turn,
    gone: false,
    lineHint: id,
    createdAt: "",
    locatedLine: id,
    via: "exact",
    ...extra,
  });
  let model = {
    docPath: "正文/甲.md",
    docName: "甲",
    loading: false,
    rejectedCount: 0,
    items: [item(1, "author"), item(2, "agent"), item(3, "author", { gone: true })],
  };
  const calls = { jump: [], resolve: [], adopt: [], copy: [] };
  const host = {
    getCommentPanelModel: async () => model,
    jumpToComment: (p, id) => calls.jump.push([p, id]),
    replyToComment: async () => true,
    editComment() {},
    resolveComment: (p, id) => calls.resolve.push([p, id]),
    rejectComment() {},
    rebindComment() {},
    copyReviewPrompt() {},
    copyReplyPrompt() {},
    adoptSuggestion: async (p, id) => {
      calls.adopt.push([p, id]);
      return true;
    },
    copyText: (text) => calls.copy.push(text),
  };
  const root = new FakeEl();
  const panel = new CommentPanelBody(root, host);
  const rows = () => root.byClass("wt-comment-row");
  const activeTab = () => root.byClass("wt-comments-tab").find((t) => t.hasClass("is-active"))?.text;
  const inDetail = () => root.byClass("wt-comment-detail").length === 1;

  panel.refresh();
  await settle();
  r.check("默认选「等你」，只列等你的", activeTab() === "等你 2" && rows().length === 2);
  r.check("原文已删除的行带标记", root.textAll().includes("已删"));

  root.byClass("wt-comments-tab").find((t) => t.text.startsWith("全部")).fire("click");
  await settle();
  r.check("切到「全部」列出所有", activeTab() === "全部 3" && rows().length === 3);

  rows()[1].fire("click");
  await settle();
  r.check("点列表行：跳正文并进详情", calls.jump.length === 1 && calls.jump[0][1] === 2 && inDetail());
  r.check(
    "详情页内容不挂点击跳转",
    root.all((e) => (e.listeners.click || []).length > 0 && e.tag !== "button").length === 0
  );
  root.byText("定位").fire("click");
  r.check("「定位」才跳正文", calls.jump.length === 2);

  // 回复草稿：详情原地刷新（Agent 追加了消息）后还在
  const input = root.byClass("wt-comment-reply-input")[0];
  input.value = "还没写完";
  input.fire("input");
  model = { ...model, items: model.items.map((i) => (i.id === 2 ? { ...i, messages: [...i.messages, { by: "agent", text: "新回复" }], turn: "author" } : i)) };
  panel.refresh();
  await settle();
  r.check(
    "数据变化时详情原地刷新、草稿保留",
    inDetail() && root.textAll().includes("新回复") &&
      root.byClass("wt-comment-reply-input")[0].value === "还没写完"
  );

  const resolveBtn = root.byText("已解决");
  resolveBtn.fire("click");
  resolveBtn.fire("click");
  await settle();
  r.check("已解决（两次确认）后回到列表", calls.resolve.length === 1 && !inDetail() && rows().length > 0);

  // 正文里点标记：直接进详情，同时换了活动文档也不被冲掉
  model = { ...model, docPath: "正文/乙.md", docName: "乙", items: [item(7, "author")] };
  await panel.revealCard(7);
  await settle();
  r.check("正文点标记直接进详情（同时换了文档）", inDetail() && root.textAll().includes("#7"));

  model = { ...model, docPath: "正文/丙.md", docName: "丙", items: [item(9, "agent")] };
  panel.refresh();
  await settle();
  r.check("切换文档回到列表；没有等你的默认选「全部」", !inDetail() && activeTab() === "全部 1");

  // 修改建议：差异块、只有最新一条能采纳、采纳不了时按钮变灰并写原因
  const suggested = (status) =>
    item(11, "author", {
      messages: [
        { by: "agent", text: "旧方案", suggestion: { original: "提溜了起来", replacement: "提了起来", adopted: false } },
        { by: "author", text: "再想想" },
        { by: "agent", text: "新方案", suggestion: { original: "提溜了起来", replacement: "拎了起来", adopted: false } },
      ],
      suggestion: {
        index: 2,
        status,
        reason: status === "ready" ? "" : "这处已经改过，建议过期了",
        before: "提溜了起来",
      },
    });
  model = { ...model, docPath: "正文/丁.md", docName: "丁", items: [suggested("ready")] };
  panel.refresh();
  await settle();
  r.check("列表行：有待采纳的建议时带「建议」标记", root.byClass("is-suggest").length === 1);
  rows()[0].fire("click");
  await settle();
  const adoptBtns = root.all((e) => e.tag === "button" && e.text === "采纳");
  r.check(
    "详情：两条建议，只有最新一条有「采纳」，旧的标「已被新建议取代」",
    adoptBtns.length === 1 && root.textAll().includes("修改建议 · 已被新建议取代") &&
      root.byClass("wt-comment-suggest").length === 2
  );
  const dels = root.byClass("wt-comment-suggest-del").map((e) => e.text).join("");
  const adds = root.byClass("wt-comment-suggest-add").map((e) => e.text).join("");
  r.check("差异块：删掉的与新增的分开标", dels.includes("提溜") && adds.includes("拎"), dels + " / " + adds);
  adoptBtns[0].fire("click");
  await settle();
  r.check("点「采纳」交给宿主（带文档路径）", calls.adopt.length === 1 && calls.adopt[0][0] === "正文/丁.md" && calls.adopt[0][1] === 11);
  root.all((e) => e.tag === "button" && e.text === "复制").at(-1).fire("click");
  r.check("「复制」复制建议的写法", calls.copy[0] === "拎了起来");

  model = { ...model, items: [suggested("missing")] };
  panel.refresh();
  await settle();
  const staleBtn = root.all((e) => e.tag === "button" && e.text === "采纳")[0];
  r.check(
    "建议过期：「采纳」变灰并写明原因",
    staleBtn && staleBtn.disabled === true && root.textAll().includes("这处已经改过，建议过期了")
  );
  staleBtn.fire("click");
  await settle();
  r.check("变灰的「采纳」点了也不动", calls.adopt.length === 1);

  return r.finish();
}

main()
  .then((ok) => { H.cleanup(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error("运行失败：" + e.stack); H.cleanup(); process.exit(2); });
