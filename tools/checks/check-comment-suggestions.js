/**
 * 检查：批注的修改建议、采纳，以及复制给 Agent 的指令与每轮快捷命令（/pizhu）。
 *
 * 1. 建议两行的解析 / 写回往返、「已采纳」标记、旧文件不变、作者消息里的同名行不被吞；
 * 2. 建议要替换的正文：唯一命中 / 找不到 / 多处（同段可区分）/ 省略原句时用批注圈住的文字；
 * 3. 指令：Agent 直接读写批注文件，写建议两行、不改正文；/pizhu 一种通用写法；
 * 4. 批注模块：采纳（替换正文、带作者输入标记、标「已采纳」、定稿锁 / 过期不改正文）、复制指令；
 * 5. 本机批注工具（MCP）2026-10-27 已去掉：源码里不能留下它的服务、工具和设置。
 *
 * 前身是 check-agent-tools.js（随 MCP 一起拆掉，与 MCP 无关的检查搬到这里）。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const DOC = "正文/第一章.md";
const TEXT = [
  "风停了，渡口的船都歇了。",
  "",
  "他直接把人从地上提溜了起来。",
  "",
  "他把灯放下，转身出门。灯还亮着。灯还亮着。",
].join("\n");

function mk(id, quote, extra = {}) {
  return {
    id,
    origin: "agent",
    quote,
    paragraph: "",
    paragraphHint: 0,
    lineHint: 1,
    createdAt: "2026-10-23 10:00",
    messages: [{ by: "agent", text: "意见" }],
    current: "",
    ...extra,
  };
}

function checkPure(r) {
  const C = H.compile("src/comments.ts", "comment-suggestions-comments");

  /* ---------- 1. 建议两行往返 ---------- */
  const withSuggestion = mk(1, "提溜了起来", {
    messages: [
      { by: "agent", text: "太口语", suggestion: { original: "直接把人从地上提溜了起来", replacement: "一把将人从地上拎了起来", adopted: false } },
      { by: "author", text: "行" },
      { by: "agent", text: "再短点", suggestion: { original: "", replacement: "", adopted: true } },
    ],
  });
  const fileText = C.serializeCommentFile(DOC, [withSuggestion]);
  const back = C.parseCommentFile(fileText)[0];
  r.check(
    "建议两行写进文件：建议原句 / 建议改为 / 建议改为（已采纳）",
    fileText.includes("- 建议原句：直接把人从地上提溜了起来") &&
      fileText.includes("- 建议改为：一把将人从地上拎了起来") &&
      fileText.includes("- 建议改为（已采纳）："),
    fileText
  );
  r.check(
    "建议往返一致（含空原句、空改写、已采纳）",
    JSON.stringify(back.messages) === JSON.stringify(withSuggestion.messages),
    JSON.stringify(back.messages)
  );
  const plain = mk(2, "转身出门", { messages: [{ by: "agent", text: "意见" }, { by: "author", text: "好" }] });
  const plainText = C.serializeCommentFile(DOC, [plain]);
  r.check(
    "没有建议的旧条目写回不多出任何行",
    !plainText.slice(plainText.indexOf("### 批注 2")).includes("建议") &&
      JSON.stringify(C.parseCommentFile(plainText)[0].messages) === JSON.stringify(plain.messages)
  );
  const authorLine = [
    "### 批注 3",
    "- 原文：转身出门",
    "- 作者：第一行",
    "  - 建议改为：这是作者自己写的一行",
  ].join("\n");
  const parsedAuthor = C.parseCommentFile(authorLine)[0];
  r.check(
    "作者消息里碰巧有「- 建议改为」也按续行留在消息里，不被吞掉",
    parsedAuthor.messages.length === 1 &&
      !parsedAuthor.messages[0].suggestion &&
      parsedAuthor.messages[0].text.includes("这是作者自己写的一行"),
    JSON.stringify(parsedAuthor.messages)
  );
  const onlyOriginal = C.parseCommentFile(
    ["### 批注 4", "- 原文：转身出门", "- Agent：意见", "- 建议原句：转身出门"].join("\n")
  )[0];
  r.check("只有「建议原句」没有「建议改为」不算建议", !onlyOriginal.messages[0].suggestion);

  const tampered = C.detectCommentTampering(
    [withSuggestion],
    [{ ...withSuggestion, messages: withSuggestion.messages.map((m, i) => i === 0 ? { ...m, suggestion: { ...m.suggestion, replacement: "被偷偷改了" } } : m) }]
  );
  r.check("外部改了已有建议也算越权", tampered.altered.length === 1);
  const adoptedOnly = C.detectCommentTampering(
    [withSuggestion],
    [{ ...withSuggestion, messages: withSuggestion.messages.map((m, i) => i === 0 ? { ...m, suggestion: { ...m.suggestion, adopted: true } } : m) }]
  );
  r.check("只改「已采纳」不算越权", adoptedOnly.altered.length === 0);

  /* ---------- 2. 建议要替换的正文 ---------- */
  const c2 = mk(5, "提溜了起来");
  const target = C.suggestionTarget(TEXT, c2, { original: "提溜了起来", replacement: "拎了起来", adopted: false });
  r.check("原句唯一：命中那一处", !("problem" in target) && TEXT.slice(target.from, target.to) === "提溜了起来");
  r.check(
    "原句找不到：过期",
    C.suggestionTarget(TEXT, c2, { original: "不存在的句子", replacement: "x", adopted: false }).problem === "missing"
  );
  const lamp = mk(6, "转身出门");
  r.check(
    "原句在全文多处、批注所在段里也多处：无法确定",
    C.suggestionTarget(TEXT, lamp, { original: "灯还亮着", replacement: "灯灭了", adopted: false }).problem === "ambiguous"
  );
  const twice = TEXT + "\n\n他又一次把人从地上提溜了起来。";
  const t3 = C.suggestionTarget(twice, c2, { original: "提溜了起来", replacement: "拎了起来", adopted: false });
  r.check(
    "原句在全文多处、批注所在段只有一处：取那一处",
    !("problem" in t3) && t3.from === TEXT.indexOf("提溜了起来"),
    JSON.stringify(t3)
  );
  const t4 = C.suggestionTarget(TEXT, c2, { original: "", replacement: "拎了起来", adopted: false });
  r.check("省略原句：替换批注圈住的文字", !("problem" in t4) && TEXT.slice(t4.from, t4.to) === "提溜了起来");
  r.check("最新一条建议的下标", C.latestSuggestionIndex(withSuggestion) === 2 && C.latestSuggestionIndex(plain) === -1);

  const diff = C.diffChars("直接把人从地上提溜了起来", "一把将人从地上拎了起来");
  const rebuilt = (kind) => diff.filter((p) => p.kind !== kind).map((p) => p.text).join("");
  r.check(
    "字级差异能拼回改前 / 改后两段",
    rebuilt("add") === "直接把人从地上提溜了起来" && rebuilt("del") === "一把将人从地上拎了起来" &&
      diff.some((p) => p.kind === "same" && p.text.includes("从地上")),
    JSON.stringify(diff)
  );

  /* ---------- 3. 指令 ---------- */
  const replyPrompt = C.buildReplyPrompt(DOC, [2, 5]);
  const reviewPrompt = C.buildReviewPrompt(DOC, { open: 1, rejected: 0 });
  r.check(
    "指令：直接读写批注文件，写建议两行，不改正文、不写现文，也不再提批注工具",
    replyPrompt.includes(".批注.md") && reviewPrompt.includes(".批注.md") &&
      /建议原句/.test(replyPrompt) && /不要直接改《第一章》/.test(replyPrompt) &&
      !/覆盖进「现文」/.test(replyPrompt) &&
      ![replyPrompt, reviewPrompt].some((p) => /MCP|list_comments|reply_comment|create_comment/.test(p))
  );
  r.check(
    "指令的语气：先邀请聊感受和整体看法，建议是可选的，不再叫「修改意见」",
    /像聊天一样/.test(reviewPrompt) && /整篇给你的感觉/.test(reviewPrompt) &&
      /不用硬给方案/.test(reviewPrompt) && !/修改意见/.test(reviewPrompt) &&
      reviewPrompt.indexOf("像聊天一样") < reviewPrompt.indexOf(".批注.md")
  );
  r.check(
    "回复指令发到同一个对话里：点明哪几条，不再整段重复读稿邀请",
    replyPrompt.includes("#2、#5") && replyPrompt.includes("2 条") && !/被打动/.test(replyPrompt)
  );

  /* ---------- 4. 每轮的快捷命令 ---------- */
  const body = C.buildReplyCommandPrompt();
  r.check(
    "快捷命令的那段话：先邀请接着聊，再说去批注目录找最后一条是作者的；只追加不改",
    /像聊天一样/.test(body) && body.includes("_写作工具箱/批注/") && body.includes(".批注.md") &&
      /最后一条消息是「- 作者：」/.test(body) && /不要改、不要删/.test(body) &&
      !/MCP|list_comments/.test(body) &&
      body.indexOf("像聊天一样") < body.indexOf("_写作工具箱")
  );
  const copied = C.buildReplyCommand();
  r.check(
    "快捷命令只有一种通用写法：复制的就是那段话，提示存成快捷短语 / 自定义命令",
    copied.text === body && /\/pizhu/.test(copied.done) && /快捷短语/.test(copied.done) &&
      !/mkdir|~\/\.claude|~\/\.gemini/.test(copied.text)
  );
}

async function checkModule(r) {
  class TFile {
    constructor(p) {
      this.path = p;
      this.name = p.split("/").pop();
      this.extension = this.name.split(".").pop();
      this.stat = { size: 1, mtime: 1 };
    }
  }
  class TFolder {}
  class MarkdownView {}
  const notices = [];
  class Notice {
    constructor(message) {
      notices.push(String(message));
    }
    hide() {}
  }
  global.createFragment = () => ({ append() {} });
  global.createSpan = () => ({});
  global.createEl = () => ({});
  const restore = H.stubObsidian({ Modal: class {}, Notice, TFile, TFolder, MarkdownView, editorInfoField: {}, setIcon() {} });
  let createCommentsModule;
  try {
    ({ createCommentsModule } = H.compile("src/features/commentsModule.ts", "comment-suggestions-module", ["electron"]));
  } finally {
    restore();
  }
  const { EffectScope } = H.compile("src/host/effectScope.ts", "comment-suggestions-scope");

  const chapter = new TFile(DOC);
  let text = TEXT;
  const dispatched = [];
  const cm = {
    state: { doc: { toString: () => text } },
    dispatch(spec) {
      dispatched.push(spec);
      const { from, to, insert } = spec.changes;
      text = text.slice(0, from) + insert + text.slice(to);
    },
  };
  const view = new MarkdownView();
  view.file = chapter;
  view.editor = { getValue: () => text, __cm: cm };
  const leaf = { view };
  view.leaf = leaf;

  const disk = new Map();
  const cache = new Map();
  const clone = (list) => JSON.parse(JSON.stringify(list));
  const store = {
    getCached: (p) => cache.get(p),
    async reload(p) {
      cache.delete(p);
      return this.load(p);
    },
    async load(p) {
      if (!cache.has(p)) cache.set(p, clone(disk.get(p) ?? []));
      return cache.get(p);
    },
    ensureLoaded() {},
    invalidate: (p) => cache.delete(p),
    invalidatePrefix() {},
    getRejected: () => [],
    async save(p, list) {
      disk.set(p, clone(list));
      cache.set(p, clone(list));
    },
    handleModified: () => null,
    handleDeleted: () => null,
    handleRenamed: () => [],
  };
  let locked = null;
  const settings = { commentsEnabled: true, commentBubbleEverywhere: true };
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
        writeBlockReason: () => locked,
      },
      ui: { leaves: (type) => (type === "markdown" ? [leaf] : []), getLeaf: () => leaf, reveal() {}, registerPanel: () => () => {} },
      diagnostics: { recordTiming() {} },
    },
    registrations: { registerEditorExtension() {} },
    events: { onWorkspace: () => () => {}, onVault: () => () => {}, setTimeout: (cb) => (cb(), 1) },
    effects: new EffectScope("comment-suggestions-test"),
  };
  const module = createCommentsModule(
    {
      getRecentMarkdownPath: () => DOC,
      async openSidebar() {},
      isFormatScopeAllowed: () => true,
    },
    {
      createStore: () => store,
      buildExtensions: () => ({}),
      refreshDecor() {},
      createPanel: () => ({ refresh() {}, destroy() {}, async revealCard() {} }),
    }
  );
  await module.activate(context);
  const ops = module.operations;

  // 批注文件里已有一条 Agent 发起、带建议的批注（Agent 直接写文件的结果）
  disk.set(DOC, [
    mk(1, "提溜了起来", {
      messages: [{ by: "agent", text: "太口语", suggestion: { original: "", replacement: "拎了起来", adopted: false } }],
    }),
  ]);

  // 面板模型：最新建议可采纳
  let model = await ops.getCommentPanelModel();
  r.check(
    "面板：最新建议可采纳，显示要被替换的正文",
    model.items[0].suggestion && model.items[0].suggestion.status === "ready" && model.items[0].suggestion.before === "提溜了起来",
    JSON.stringify(model.items[0] && model.items[0].suggestion)
  );

  // 定稿锁定：不改正文
  locked = "本章已定稿";
  model = await ops.getCommentPanelModel();
  const lockedOk = await ops.adoptSuggestion(DOC, 1);
  r.check(
    "定稿锁定：面板显示原因，采纳不改正文",
    model.items[0].suggestion.status === "locked" && lockedOk === false && dispatched.length === 0 && text === TEXT
  );
  locked = null;

  // 采纳
  const adoptedOk = await ops.adoptSuggestion(DOC, 1);
  await ops.flush();
  const spec = dispatched[0];
  r.check(
    "采纳：编辑器里替换正文",
    adoptedOk === true && text.includes("他直接把人从地上拎了起来。") && !text.includes("提溜"),
    text
  );
  r.check(
    "采纳：作为作者输入（定稿锁认得出、可撤销），并带批注位置的替换效果",
    spec && /^input\./.test(spec.userEvent) && spec.effects && spec.selection
  );
  r.check(
    "采纳：那一行标成「已采纳」，批注不结案",
    disk.get(DOC).length === 1 && disk.get(DOC)[0].messages[0].suggestion.adopted === true
  );
  model = await ops.getCommentPanelModel();
  r.check("采纳后面板显示已采纳", model.items[0].suggestion.status === "adopted");
  const again = await ops.adoptSuggestion(DOC, 1);
  r.check("已采纳的不能再采纳一次", again === false && dispatched.length === 1);

  // 作者回复 → Agent 在文件里再给一版 → 作者改了那处 → 建议过期
  await ops.replyToComment(DOC, 1, "还是不够利落");
  await ops.flush();
  const thread = disk.get(DOC)[0];
  disk.set(DOC, [
    {
      ...thread,
      messages: [
        ...thread.messages,
        { by: "agent", text: "换个动作", suggestion: { original: "从地上拎了起来", replacement: "从地上拽了起来", adopted: false } },
      ],
    },
  ]);
  store.invalidate(DOC);
  text = text.replace("从地上拎了起来", "从地上提了起来");
  model = await ops.getCommentPanelModel();
  const stale = await ops.adoptSuggestion(DOC, 1);
  r.check(
    "作者改过那处：建议过期，按钮给原因，采纳不改正文",
    model.items[0].suggestion.status === "missing" && model.items[0].suggestion.index === 2 &&
      stale === false && dispatched.length === 1,
    JSON.stringify(model.items[0].suggestion)
  );

  // 复制指令：一律让 Agent 直接写批注文件
  const copied = [];
  // Node 自带只读的 navigator，得用 defineProperty 换掉
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (t) => copied.push(t) } },
    configurable: true,
  });
  ops.copyReviewPrompt(DOC);
  await ops.replyToComment(DOC, 1, "那就这样吧");
  ops.copyReplyPrompt(DOC);
  await new Promise((resolve) => setTimeout(resolve, 5));
  r.check(
    "复制批注指令 / 回复指令：都写批注文件路径",
    copied.length === 2 && copied.every((t) => t.includes(".批注.md")),
    JSON.stringify(copied)
  );

  context.effects.dispose?.();
}

function checkRemoved(r) {
  const read = (rel) => fs.readFileSync(path.join(H.ROOT, rel), "utf8");
  const gone = ["src/agentBridgeServer.ts", "src/agentTools.ts", "src/features/agentBridgeModule.ts"];
  r.check(
    "MCP 的服务、工具与模块文件都已删除",
    gone.every((rel) => !fs.existsSync(path.join(H.ROOT, rel)))
  );
  const srcDir = path.join(H.ROOT, "src");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(srcDir);
  const leftovers = files.filter((file) =>
    /agentBridge|AgentChannel|list_comments|reply_comment|create_comment|允许 Agent 通过批注工具连接/.test(
      fs.readFileSync(file, "utf8")
    ) && !/main\.ts$/.test(file)
  );
  r.check("src 里没有 MCP 工具、通道与设置的残留", leftovers.length === 0, leftovers.join(", "));
  const main = read("src/main.ts");
  r.check(
    "主入口启动时清掉旧的本机工具存储",
    /this\.clearLegacyAgentBridge\(\);/.test(main) &&
      /saveLocalStorage\(LEGACY_AGENT_BRIDGE_KEY, null\)/.test(main) &&
      /LEGACY_AGENT_BRIDGE_KEY = "writing-toolkit-agent-bridge"/.test(main) &&
      !/createAgentBridgeModule|agentBridgeModule/.test(main)
  );
  const settings = read("src/settings.ts");
  r.check(
    "设置页只留「每轮的快捷命令」（一个复制按钮，不用选 Agent），只在电脑上出现",
    /this\.group\("Agent 快捷命令", section, \(el\) => this\.buildReplyCommandSettings\(el\)\)/.test(settings) &&
      /if \(Platform\.isDesktopApp\)/.test(settings) &&
      !/端口|口令|连接到 Agent/.test(settings) &&
      !/addDropdown/.test(settings.slice(settings.indexOf("private buildReplyCommandSettings"), settings.indexOf("private activeTabIndex")))
  );
}

async function main() {
  const r = H.createReporter("修改建议、采纳与给 Agent 的指令");
  checkPure(r);
  await checkModule(r);
  checkRemoved(r);
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
