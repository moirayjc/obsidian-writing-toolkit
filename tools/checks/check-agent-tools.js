/**
 * 检查：修改建议 + 本机批注工具（MCP）。
 *
 * 1. 建议两行的解析 / 写回往返、「已采纳」标记、旧文件不变、作者消息里的同名行不被吞；
 * 2. 建议要替换的正文：唯一命中 / 找不到 / 多处（同段可区分）/ 省略原句时用批注圈住的文字；
 * 3. 工具参数校验：原文找不到、出现多次、和已有批注重叠、不轮到 Agent、建议原句不合格；
 * 4. MCP 分发：只有三个工具，没有结案 / 删除 / 改正文；出错时 isError；通知不回包；
 * 5. 请求守门：口令、Host、Origin、方法、路径；真实起一个 127.0.0.1 监听验一遍；
 * 6. 批注模块：采纳（替换正文、带作者输入标记、标「已采纳」、定稿锁 / 过期不改正文）、
 *    工具写入（发起 / 回复）、两套复制指令随通道切换。
 */
const http = require("http");
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

function throwsWith(fn, pattern) {
  try {
    fn();
    return false;
  } catch (error) {
    return error && error.name === "AgentToolError" && pattern.test(error.message);
  }
}

function request(port, { method = "POST", path = "/mcp", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function checkPure(r) {
  const C = H.compile("src/comments.ts", "agent-tools-comments");
  const T = H.compile("src/agentTools.ts", "agent-tools");

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

  /* ---------- 3. 工具参数校验 ---------- */
  const existing = [mk(1, "渡口的船都歇了")];
  r.check(
    "发起：原文找不到时拒绝并说明",
    throwsWith(() => T.checkQuote(TEXT, existing, "凭印象概括的一句"), /找不到/)
  );
  r.check(
    "发起：原文出现多次时拒绝并提示加长",
    throwsWith(() => T.checkQuote(TEXT, existing, "灯还亮着"), /出现了 2 次/)
  );
  r.check(
    "发起：和进行中的批注重叠时拒绝并提示回复那一条",
    throwsWith(() => T.checkQuote(TEXT, existing, "船都歇"), /第 1 条/)
  );
  const created = T.buildAgentComment(TEXT, existing, {
    path: DOC,
    quote: "提溜了起来",
    message: "太口语",
    suggestion: { replacement: "拎了起来" },
  });
  r.check(
    "发起：编号、段落、行号由插件填；省略原句时存成显式原句",
    created.id === 2 && created.origin === "agent" &&
      created.paragraph === "他直接把人从地上提溜了起来。" && created.lineHint === 3 &&
      created.messages[0].suggestion.original === "提溜了起来" &&
      created.messages[0].suggestion.adopted === false,
    JSON.stringify(created)
  );
  r.check(
    "建议原句不在批注所在段里：拒绝",
    throwsWith(
      () => T.buildAgentComment(TEXT, existing, { path: DOC, quote: "提溜了起来", message: "x", suggestion: { original: "转身出门", replacement: "走了" } }),
      /所在的那一段/
    )
  );
  r.check(
    "建议原句出现多次：拒绝",
    throwsWith(
      () => T.buildAgentComment(TEXT, existing, { path: DOC, quote: "转身出门", message: "x", suggestion: { original: "灯还亮着", replacement: "灯灭了" } }),
      /出现了 2 次/
    )
  );
  r.check(
    "建议和原文一样：拒绝",
    throwsWith(
      () => T.buildAgentComment(TEXT, existing, { path: DOC, quote: "转身出门", message: "x", suggestion: { replacement: "转身出门" } }),
      /一模一样/
    )
  );
  const waitingAuthor = mk(7, "转身出门");
  r.check(
    "回复：轮到作者时拒绝",
    throwsWith(() => T.buildAgentReply(TEXT, waitingAuthor, { path: DOC, id: 7, message: "补一句" }), /轮到作者/)
  );
  r.check(
    "回复：编号不存在时拒绝",
    throwsWith(() => T.buildAgentReply(TEXT, undefined, { path: DOC, id: 99, message: "x" }), /找不到第 99 条/)
  );
  const yourTurn = { ...waitingAuthor, messages: [...waitingAuthor.messages, { by: "author", text: "怎么改" }] };
  const reply = T.buildAgentReply(TEXT, yourTurn, { path: DOC, id: 7, message: "这样", suggestion: { replacement: "推门出去" } });
  r.check(
    "回复：轮到 Agent 时可以附建议",
    reply.by === "agent" && reply.suggestion.original === "转身出门" && reply.suggestion.replacement === "推门出去"
  );
  r.check(
    "路径：去掉库的绝对路径、补 .md",
    T.normalizeAgentPath("/srv/作者/库/正文/第一章", "/srv/作者/库") === DOC &&
      T.normalizeAgentPath("./正文/第一章.md", null) === DOC
  );

  /* ---------- 4. MCP 分发 ---------- */
  const calls = [];
  const port = {
    async list(input) {
      calls.push(["list", input]);
      return { ok: true };
    },
    async create(input) {
      calls.push(["create", input]);
      throw new T.AgentToolError("原文找不到");
    },
    async reply(input) {
      calls.push(["reply", input]);
      return { ok: true, id: input.id };
    },
  };
  const info = { name: "writing-toolkit", version: "test" };
  const init = await T.handleMcpBody(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    port,
    info
  );
  r.check(
    "initialize：回同一个协议版本、声明工具能力",
    init.result.protocolVersion === "2025-06-18" && init.result.capabilities.tools && init.result.serverInfo.name === "writing-toolkit"
  );
  const listed = await T.handleMcpBody({ jsonrpc: "2.0", id: 2, method: "tools/list" }, port, info);
  const names = listed.result.tools.map((t) => t.name).sort();
  r.check(
    "只有三个工具：列出 / 发起 / 回复",
    names.join(",") === "create_comment,list_comments,reply_comment",
    names.join(",")
  );
  r.check(
    "没有结案、删除、改正文的工具",
    !names.some((n) => /resolve|reject|delete|remove|edit|close|write|adopt/.test(n))
  );
  const failed = await T.handleMcpBody(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_comment", arguments: { path: DOC } } },
    port,
    info
  );
  r.check(
    "工具报错：isError 并把原因原样返回给 Agent",
    failed.result.isError === true && failed.result.content[0].text === "原文找不到"
  );
  const replied = await T.handleMcpBody(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "reply_comment", arguments: { path: DOC, id: "#3", message: "x" } } },
    port,
    info
  );
  r.check(
    "回复：编号写成 \"#3\" 也认",
    !replied.result.isError && calls.some(([n, a]) => n === "reply" && a.id === 3)
  );
  const unknown = await T.handleMcpBody(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "resolve_comment", arguments: {} } },
    port,
    info
  );
  r.check("不存在的工具（比如结案）：JSON-RPC 报错", unknown.error && unknown.error.code === -32602);
  await T.handleMcpBody(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_comments", arguments: { path: DOC, only_your_turn: true } } },
    port,
    info
  );
  const listCall = calls.find(([n]) => n === "list");
  r.check(
    "列出：only_your_turn 传到读写端口，工具说明里写着",
    listCall && listCall[1].onlyYourTurn === true && listCall[1].path === DOC &&
      listed.result.tools.find((t) => t.name === "list_comments").inputSchema.properties.only_your_turn
  );
  const note = await T.handleMcpBody({ jsonrpc: "2.0", method: "notifications/initialized" }, port, info);
  r.check("通知不回包", note === null);

  /* ---------- 5. 请求守门 ---------- */
  const ok = { method: "POST", url: "/mcp", headers: { host: "127.0.0.1:27183", authorization: "Bearer secret-token" } };
  const guard = (patch) => T.checkBridgeRequest({ ...ok, ...patch, headers: { ...ok.headers, ...(patch.headers || {}) } }, "secret-token", 27183);
  r.check("口令正确的本机 POST 放行", guard({}) === null);
  r.check("没口令 / 口令错：401", guard({ headers: { authorization: "" } })?.status === 401 && guard({ headers: { authorization: "Bearer nope" } })?.status === 401);
  r.check("带浏览器来源头：403", guard({ headers: { origin: "https://evil.example" } })?.status === 403);
  r.check("Host 不是本机这个端口：403", guard({ headers: { host: "evil.example:27183" } })?.status === 403);
  r.check("GET：405；别的路径：404", guard({ method: "GET" })?.status === 405 && guard({ url: "/other" })?.status === 404);
  r.check(
    "连接命令：用户级、只连 127.0.0.1、带口令",
    /--scope user/.test(T.buildConnectionCommand("writing-toolkit", 27183, "abc")) &&
      T.buildConnectionCommand("writing-toolkit", 27183, "abc").includes("http://127.0.0.1:27183/mcp") &&
      T.buildConnectionCommand("writing-toolkit", 27183, "abc").includes("Bearer abc")
  );

  /* ---------- 各家 Agent 的连接配置 ---------- */
  const cfg = (client) => T.buildConnectionConfig(client, "writing-toolkit", 27183, "abc");
  const gemini = cfg("gemini").text;
  r.check(
    "Gemini CLI：用户级、http 传输、带口令请求头、名字在地址前",
    /^gemini mcp add --scope user --transport http --header "Authorization: Bearer abc" writing-toolkit http:\/\/127\.0\.0\.1:27183\/mcp$/.test(gemini),
    gemini
  );
  const anti = cfg("antigravity").text;
  let antiParsed = null;
  try {
    antiParsed = JSON.parse("{" + anti + "}");
  } catch {}
  r.check(
    "Antigravity：mcpServers 里的一项，字段是 serverUrl（不是 httpUrl）+ headers",
    antiParsed &&
      antiParsed["writing-toolkit"].serverUrl === "http://127.0.0.1:27183/mcp" &&
      antiParsed["writing-toolkit"].headers.Authorization === "Bearer abc" &&
      !("httpUrl" in antiParsed["writing-toolkit"]) &&
      /mcp_config\.json/.test(cfg("antigravity").done),
    anti
  );
  r.check(
    "Claude Code 沿用原命令；通用只给地址和请求头",
    cfg("claude").text === T.buildConnectionCommand("writing-toolkit", 27183, "abc") &&
      cfg("generic").text.includes("http://127.0.0.1:27183/mcp") &&
      cfg("generic").text.includes("Authorization: Bearer abc")
  );

  /* ---------- 指令 ---------- */
  const toolsPrompt = C.buildReplyPrompt(DOC, [2, 5], "tools");
  const filePrompt = C.buildReplyPrompt(DOC, [2, 5], "file");
  const reviewTools = C.buildReviewPrompt(DOC, { open: 1, rejected: 0 }, "tools");
  r.check(
    "工具通道的指令：用工具，没有就停下，不提批注文件路径",
    /没有这些工具的话先停下来/.test(toolsPrompt) && /reply_comment/.test(toolsPrompt) &&
      !toolsPrompt.includes(".批注.md") && /create_comment/.test(reviewTools)
  );
  r.check(
    "文件通道的指令：写建议两行，不再让 Agent 改正文、写现文",
    /建议原句/.test(filePrompt) && !/覆盖进「现文」/.test(filePrompt) && /不要直接改《第一章》/.test(filePrompt)
  );
  r.check(
    "指令的语气：先邀请聊感受和整体看法，建议是可选的，不再叫「修改意见」",
    /像聊天一样/.test(reviewTools) && /整篇给你的感觉/.test(reviewTools) &&
      /不用硬给方案/.test(reviewTools) && !/修改意见/.test(reviewTools) &&
      reviewTools.indexOf("像聊天一样") < reviewTools.indexOf("create_comment")
  );
  r.check(
    "回复指令发到同一个对话里：点明哪几条、只读这几条，不再整段重复读稿邀请",
    toolsPrompt.includes("#2、#5") && toolsPrompt.includes("2 条") &&
      /only_your_turn/.test(toolsPrompt) && !/被打动/.test(toolsPrompt) &&
      filePrompt.includes("#2、#5") && !/被打动/.test(filePrompt)
  );
  r.check(
    "批注指令（工具通道）先说好以后怎么接着聊：只看轮到你的、可能敲 /pizhu",
    /only_your_turn/.test(reviewTools) && reviewTools.includes("/" + C.REPLY_COMMAND_NAME)
  );

  /* ---------- 每轮的快捷命令 ---------- */
  const cmd = (client) => T.buildReplyCommand(client, "writing-toolkit");
  const body = T.buildReplyCommandPrompt("writing-toolkit");
  r.check(
    "快捷命令的那段话：先邀请接着聊，再说只看轮到你的；没有工具就停下",
    /像聊天一样/.test(body) && /only_your_turn/.test(body) && /yourTurn/.test(body) &&
      /MCP 服务 writing-toolkit/.test(body) && /没有这些工具的话先停下来/.test(body) &&
      body.indexOf("像聊天一样") < body.indexOf("list_comments")
  );
  r.check(
    "Claude Code：写进用户级 ~/.claude/commands/pizhu.md，带 description",
    cmd("claude").text.startsWith("mkdir -p ~/.claude/commands && cat > ~/.claude/commands/pizhu.md <<'EOF'\n---\ndescription: ") &&
      cmd("claude").text.endsWith("\nEOF") && cmd("claude").text.includes(body) && /\/pizhu/.test(cmd("claude").done)
  );
  r.check(
    "Gemini CLI：写进 ~/.gemini/commands/pizhu.toml，prompt 用三引号多行串",
    cmd("gemini").text.includes("cat > ~/.gemini/commands/pizhu.toml <<'EOF'") &&
      cmd("gemini").text.includes('prompt = """\n' + body + '\n"""\nEOF') &&
      !body.includes('"""') && !body.includes("\\")
  );
  r.check(
    "其他 Agent：只复制那段话",
    cmd("antigravity").text === body && cmd("generic").text === body
  );

  return { C, T };
}

async function checkServer(r) {
  const T = H.compile("src/agentTools.ts", "agent-tools-server-tools");
  const restore = H.stubObsidian({ Platform: { isDesktopApp: true } });
  let startBridgeServer;
  try {
    ({ startBridgeServer } = H.compile("src/agentBridgeServer.ts", "agent-bridge-server", ["http"]));
  } finally {
    restore();
  }
  const port = 40000 + Math.floor(Math.random() * 20000);
  const token = "t".repeat(48);
  const server = await startBridgeServer({
    port,
    token,
    handle: (body) =>
      T.handleMcpBody(body, {
        list: async () => ({ ok: true }),
        create: async () => ({}),
        reply: async () => ({}),
      }, { name: "writing-toolkit", version: "test" }),
  });
  try {
    const host = `127.0.0.1:${port}`;
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const noAuth = await request(port, { headers: { host, "content-type": "application/json" }, body: init });
    const good = await request(port, {
      headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: init,
    });
    const fromPage = await request(port, {
      headers: { host, authorization: `Bearer ${token}`, origin: "https://example.com" },
      body: init,
    });
    const notification = await request(port, {
      headers: { host, authorization: `Bearer ${token}` },
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    const broken = await request(port, { headers: { host, authorization: `Bearer ${token}` }, body: "{not json" });
    r.check("真实监听：没口令 401", noAuth.status === 401);
    r.check(
      "真实监听：带口令的 initialize 回 200 + JSON-RPC 结果",
      good.status === 200 && JSON.parse(good.body).result.serverInfo.name === "writing-toolkit",
      good.body
    );
    r.check("真实监听：网页来源 403", fromPage.status === 403);
    r.check("真实监听：通知回 202", notification.status === 202);
    r.check("真实监听：坏 JSON 回 400 + parse error", broken.status === 400 && /-32700/.test(broken.body));
    let refused = false;
    try {
      await startBridgeServer({ port, token, handle: async () => null });
    } catch (error) {
      refused = error.code === "EADDRINUSE";
    }
    r.check("端口被占用：启动失败并带 EADDRINUSE", refused);
  } finally {
    await server.close();
  }
  let closed = false;
  try {
    await request(port, { headers: { host: `127.0.0.1:${port}` }, body: {} });
  } catch {
    closed = true;
  }
  r.check("关闭后端口不再监听", closed);
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
    ({ createCommentsModule } = H.compile("src/features/commentsModule.ts", "agent-tools-module", ["electron"]));
  } finally {
    restore();
  }
  const { EffectScope } = H.compile("src/host/effectScope.ts", "agent-tools-scope");

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
    async listCommentDocs() {
      return [...disk.keys()];
    },
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
    effects: new EffectScope("agent-tools-test"),
  };
  let channel = "file";
  const module = createCommentsModule(
    {
      getRecentMarkdownPath: () => DOC,
      async openSidebar() {},
      isFormatScopeAllowed: () => true,
      agentChannel: () => channel,
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

  // 工具：发起（带建议）→ 作者回复 → Agent 回复
  const made = await ops.agentTools.create({
    path: "/库/正文/第一章",
    quote: "提溜了起来",
    message: "太口语",
    suggestion: { replacement: "拎了起来" },
  });
  await ops.flush();
  const afterCreate = disk.get(DOC) ?? [];
  r.check(
    "工具发起：写进批注文件，带建议",
    made.id === 1 && afterCreate.length === 1 && afterCreate[0].messages[0].suggestion.replacement === "拎了起来",
    JSON.stringify(afterCreate)
  );
  let notYourTurn = false;
  try {
    await ops.agentTools.reply({ path: DOC, id: 1, message: "再补一句" });
  } catch (error) {
    notYourTurn = /轮到作者/.test(error.message);
  }
  r.check("工具回复：没轮到 Agent 时拒绝、不写盘", notYourTurn && (disk.get(DOC)[0].messages.length === 1));
  let badPath = false;
  try {
    await ops.agentTools.list({ path: "不存在/的文档.md" });
  } catch (error) {
    badPath = /库里没有/.test(error.message);
  }
  r.check("工具：文档不存在时说明", badPath);
  const listedAll = await ops.agentTools.list({});
  r.check("工具：不给 path 列出所有有批注的文档", listedAll.documents.length === 1 && listedAll.documents[0].path === DOC);

  // 面板模型：最新建议可采纳
  let model = await ops.getCommentPanelModel();
  r.check(
    "面板：最新建议可采纳，显示要被替换的正文",
    model.items[0].suggestion && model.items[0].suggestion.status === "ready" && model.items[0].suggestion.before === "提溜了起来",
    JSON.stringify(model.items[0].suggestion)
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

  // 作者回复 → Agent 再给一版 → 作者改了那处 → 建议过期
  const beforeTurn = await ops.agentTools.list({ path: DOC, onlyYourTurn: true });
  await ops.replyToComment(DOC, 1, "还是不够利落");
  const afterTurn = await ops.agentTools.list({ path: DOC, onlyYourTurn: true });
  const everything = await ops.agentTools.list({ path: DOC });
  r.check(
    "工具列出 only_your_turn：只给轮到 Agent 的，不带时照旧全给",
    beforeTurn.comments.length === 0 && afterTurn.comments.length === 1 &&
      afterTurn.comments[0].id === 1 && everything.comments.length === 1,
    JSON.stringify({ beforeTurn, afterTurn })
  );
  await ops.agentTools.reply({
    path: DOC,
    id: 1,
    message: "换个动作",
    suggestion: { original: "一把将人", replacement: "x" },
  }).catch(() => null);
  const replied = await ops.agentTools.reply({
    path: DOC,
    id: 1,
    message: "换个动作",
    suggestion: { original: "从地上拎了起来", replacement: "从地上拽了起来" },
  });
  r.check("工具回复：原句不合格先被拒，合格的写入", replied.ok === true && disk.get(DOC)[0].messages.length === 3);
  text = text.replace("从地上拎了起来", "从地上提了起来");
  model = await ops.getCommentPanelModel();
  const stale = await ops.adoptSuggestion(DOC, 1);
  r.check(
    "作者改过那处：建议过期，按钮给原因，采纳不改正文",
    model.items[0].suggestion.status === "missing" && model.items[0].suggestion.index === 2 &&
      stale === false && dispatched.length === 1,
    JSON.stringify(model.items[0].suggestion)
  );

  // 复制指令随通道切换
  const copied = [];
  // Node 自带只读的 navigator，得用 defineProperty 换掉
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (t) => copied.push(t) } },
    configurable: true,
  });
  ops.copyReviewPrompt(DOC);
  await new Promise((resolve) => setTimeout(resolve, 5));
  channel = "tools";
  ops.copyReviewPrompt(DOC);
  await new Promise((resolve) => setTimeout(resolve, 5));
  r.check(
    "复制批注指令：工具没开时写文件，开着时用工具",
    copied.length === 2 && copied[0].includes(".批注.md") && /create_comment/.test(copied[1]) && !copied[1].includes(".批注.md")
  );

  context.effects.dispose?.();
}

async function checkBridgeModule(r) {
  const restore = H.stubObsidian({ Notice: class {} });
  let createAgentBridgeModule;
  try {
    ({ createAgentBridgeModule } = H.compile(
      "src/features/agentBridgeModule.ts",
      "agent-bridge-module",
      ["http"]
    ));
  } finally {
    restore();
  }
  const { EffectScope } = H.compile("src/host/effectScope.ts", "agent-bridge-scope");
  let saved = null;
  const storage = { load: () => saved, save: (data) => (saved = JSON.parse(JSON.stringify(data))) };
  const make = () =>
    createAgentBridgeModule(
      { isDesktop: () => true, tools: () => ({}), version: "test" },
      { createStorage: () => storage, startServer: async () => ({ close: async () => {} }) }
    );
  const first = make();
  await first.activate({ app: {}, effects: new EffectScope("bridge-1") });
  r.check("没选过时默认 Claude Code", first.operations.status().client === "claude");
  first.operations.setClient("antigravity");
  // 选完立刻就要存下（别靠后面复制时生成口令顺带写盘）
  const savedRightAway = saved?.client === "antigravity";
  const config = first.operations.connectionConfig();
  r.check(
    "选了 Antigravity：选完就记在这台电脑上，复制的是它的配置",
    savedRightAway && config.text.includes("serverUrl")
  );
  first.operations.setClient("not-a-client");
  r.check("不认识的值不会写进去", saved.client === "antigravity");
  const second = make();
  await second.activate({ app: {}, effects: new EffectScope("bridge-2") });
  r.check("重新加载后还记得上次选的", second.operations.status().client === "antigravity");
}

async function main() {
  const r = H.createReporter("修改建议 + 本机批注工具（MCP）");
  await checkPure(r);
  await checkServer(r);
  await checkModule(r);
  await checkBridgeModule(r);
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
