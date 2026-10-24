/**
 * 本机批注工具（给 Agent 用的 MCP）：工具定义、参数校验、JSON-RPC 分发、请求守门。
 *
 * 为什么有它：以前 Agent 直接读写批注文件，「只有作者能结案」「原文必须逐字复制」
 * 都只能写在说明里，管不住。现在 Agent 只能调这三个工具——列出 / 发起 / 回复，
 * 没有结案、删除、改正文的工具；每次写入前当场校验，不合格就把原因返回给 Agent 重来。
 *
 * 本模块是纯逻辑（不依赖 Obsidian API、不碰网络），方便检查脚本直接跑：
 * 真正读写批注由 comments 模块实现 AgentToolsPort，监听端口在 agentBridgeServer.ts。
 */
import {
  AnchorLocator,
  WtComment,
  commentTurn,
  findOccurrences,
  formatTimestamp,
  lineOfOffset,
  locateAll,
  nextCommentId,
  paragraphAt,
  suggestionTarget,
  type CommentSuggestion,
} from "./comments";

/* ---------- 工具参数 ---------- */

export interface AgentSuggestionInput {
  /** 要替换的正文（逐字）；省略 = 这条批注圈住的文字 */
  original?: string;
  /** 改成什么；空串 = 删掉 */
  replacement: string;
}

export interface AgentListInput {
  path?: string;
}

export interface AgentCreateInput {
  path: string;
  quote: string;
  message: string;
  suggestion?: AgentSuggestionInput;
}

export interface AgentReplyInput {
  path: string;
  id: number;
  message: string;
  suggestion?: AgentSuggestionInput;
}

/** comments 模块实现的读写端口（工具调用最终落到这里）。 */
export interface AgentToolsPort {
  list(input: AgentListInput): Promise<unknown>;
  create(input: AgentCreateInput): Promise<unknown>;
  reply(input: AgentReplyInput): Promise<unknown>;
}

/** 给 Agent 看的错误：原样返回，让它按提示重来。 */
export class AgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolError";
  }
}

const MAX_QUOTE = 300;
const MAX_MESSAGE = 4000;
const MAX_REPLACEMENT = 2000;

function clip(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/* ---------- 参数校验（纯函数） ---------- */

/**
 * Agent 给的路径 → 库内相对路径：去掉库的绝对路径前缀、`./`、开头的 `/`，
 * 反斜杠换成 `/`，没有扩展名时补 `.md`。是不是真有这篇文档由调用方查。
 */
export function normalizeAgentPath(
  raw: unknown,
  vaultBasePath: string | null
): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new AgentToolError("缺少 path：请给出文档在库里的路径，比如「作品/正文/第3章.md」。");
  }
  let path = raw.trim().replace(/\\/g, "/");
  const base = vaultBasePath?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && (path === base || path.startsWith(`${base}/`))) {
    path = path.slice(base.length);
  }
  path = path.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  if (!path) throw new AgentToolError("path 指向的是库的根目录，请给出具体文档。");
  if (!/\.[^/.]+$/.test(path)) path += ".md";
  return path;
}

export function checkMessage(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) throw new AgentToolError("message 不能为空。");
  if (text.length > MAX_MESSAGE) {
    throw new AgentToolError(`message 太长（${text.length} 字，上限 ${MAX_MESSAGE}），请拆开或精简。`);
  }
  return text;
}

/**
 * 发起批注要圈的文字：必须在当前正文里逐字存在、只出现一次，
 * 且不和进行中的批注重叠（重叠就该回复那一条）。
 */
export function checkQuote(
  docText: string,
  comments: readonly WtComment[],
  raw: unknown
): { from: number; to: number; quote: string } {
  const quote = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (!quote) throw new AgentToolError("quote 不能为空：请从正文里逐字复制要批注的那段文字。");
  if (quote.length > MAX_QUOTE) {
    throw new AgentToolError(
      `quote 太长（${quote.length} 字）：取一句里有区分度的短片段就够了（${MAX_QUOTE} 字以内）。`
    );
  }
  const hits = findOccurrences(docText, quote);
  if (hits.length === 0) {
    throw new AgentToolError(
      `在现在的正文里找不到「${clip(quote)}」。请从正文逐字复制（包括标点和空格），不要凭印象概括；正文可能刚被作者改过，先重新读一遍。`
    );
  }
  if (hits.length > 1) {
    throw new AgentToolError(
      `「${clip(quote)}」在正文里出现了 ${hits.length} 次，无法确定是哪一处。请加长一点（带上前后几个字）再试。`
    );
  }
  const from = hits[0];
  const to = from + quote.length;
  for (const item of locateAll(docText, comments)) {
    if (item.via === "paragraph" || item.to <= item.from) continue;
    if (item.from < to && item.to > from) {
      throw new AgentToolError(
        `这一处已经有第 ${item.comment.id} 条批注在讨论了：请用 reply_comment 回复第 ${item.comment.id} 条，不要新开。`
      );
    }
  }
  return { from, to, quote };
}

/**
 * 修改建议：original 写了就必须逐字存在、全文只出现一次、落在批注所在的那一段；
 * 没写就用批注现在圈住的文字（存成显式原句：作者之后改过这处，建议就算过期）。
 */
export function checkSuggestion(
  docText: string,
  comment: WtComment,
  raw: unknown
): CommentSuggestion {
  if (typeof raw !== "object" || raw === null) {
    throw new AgentToolError("suggestion 要是一个对象：{ original?: 要替换的正文, replacement: 改成什么 }。");
  }
  const input = raw as { original?: unknown; replacement?: unknown };
  if (typeof input.replacement !== "string") {
    throw new AgentToolError("suggestion.replacement 必须是字符串（改成什么；空串表示删掉）。");
  }
  const replacement = input.replacement.replace(/\r\n?/g, "\n");
  if (replacement.length > MAX_REPLACEMENT) {
    throw new AgentToolError(
      `suggestion.replacement 太长（${replacement.length} 字）：建议只改一处，大段重写请直接和作者商量。`
    );
  }
  if (input.original !== undefined && typeof input.original !== "string") {
    throw new AgentToolError("suggestion.original 必须是字符串。");
  }
  const anchor = new AnchorLocator(docText).locate(comment);
  let original = (input.original ?? "").replace(/\r\n?/g, "\n");
  if (original) {
    const hits = findOccurrences(docText, original);
    if (hits.length === 0) {
      throw new AgentToolError(
        `suggestion.original「${clip(original)}」在现在的正文里找不到。请从正文逐字复制。`
      );
    }
    if (hits.length > 1) {
      throw new AgentToolError(
        `suggestion.original「${clip(original)}」在正文里出现了 ${hits.length} 次。请加长一点，让它只出现一次。`
      );
    }
    const paragraph = anchor ? paragraphAt(docText, anchor.from) : null;
    const at = hits[0];
    if (!paragraph || at >= paragraph.to || at + original.length <= paragraph.from) {
      throw new AgentToolError(
        "suggestion.original 要在这条批注所在的那一段里；想改别处，请另开一条批注。"
      );
    }
  } else {
    if (
      !anchor ||
      anchor.to <= anchor.from ||
      (anchor.via !== "present" && anchor.via !== "exact")
    ) {
      throw new AgentToolError(
        "这条批注现在定位不到原文，请在 suggestion.original 里写明要替换的正文（逐字复制）。"
      );
    }
    original = docText.slice(anchor.from, anchor.to);
  }
  if (original === replacement) {
    throw new AgentToolError("suggestion.replacement 和原文一模一样，没有要改的。");
  }
  const suggestion: CommentSuggestion = { original, replacement, adopted: false };
  const target = suggestionTarget(docText, comment, suggestion);
  if ("problem" in target) {
    throw new AgentToolError(
      "批注圈住的文字在这一段里出现了不止一次，请在 suggestion.original 里写一段更长、只出现一次的原文。"
    );
  }
  return suggestion;
}

/** Agent 发起的新批注（已校验）。 */
export function buildAgentComment(
  docText: string,
  comments: readonly WtComment[],
  input: AgentCreateInput,
  now: Date = new Date()
): WtComment {
  const message = checkMessage(input.message);
  const { from, quote } = checkQuote(docText, comments, input.quote);
  const paragraph = paragraphAt(docText, from);
  const comment: WtComment = {
    id: nextCommentId(comments),
    origin: "agent",
    quote,
    paragraph: paragraph?.text.trim() ?? "",
    paragraphHint: paragraph?.index ?? 0,
    lineHint: lineOfOffset(docText, from),
    createdAt: formatTimestamp(now),
    messages: [],
    current: "",
  };
  const suggestion =
    input.suggestion === undefined
      ? undefined
      : checkSuggestion(docText, comment, input.suggestion);
  comment.messages.push(
    suggestion ? { by: "agent", text: message, suggestion } : { by: "agent", text: message }
  );
  return comment;
}

/** 回复前的检查：批注还在、轮到 Agent。返回要追加的消息。 */
export function buildAgentReply(
  docText: string | null,
  comment: WtComment | undefined,
  input: AgentReplyInput
): WtComment["messages"][number] {
  if (!comment) {
    throw new AgentToolError(
      `找不到第 ${input.id} 条批注（可能已被作者结案）。先用 list_comments 看现在还有哪些。`
    );
  }
  if (commentTurn(comment) !== "agent") {
    throw new AgentToolError(
      `第 ${comment.id} 条现在轮到作者（最后一条消息是你的），等作者回复后再说。`
    );
  }
  const text = checkMessage(input.message);
  if (input.suggestion === undefined) return { by: "agent", text };
  if (docText === null) throw new AgentToolError("读不到这篇文档的正文，没法附修改建议。");
  return { by: "agent", text, suggestion: checkSuggestion(docText, comment, input.suggestion) };
}

/** list_comments 里一条批注的样子（给 Agent 看）。 */
export function describeComment(
  docText: string | null,
  comment: WtComment
): Record<string, unknown> {
  const span = docText === null ? null : new AnchorLocator(docText).locate(comment);
  const paragraph =
    docText !== null && span ? paragraphAt(docText, span.from)?.text.trim() ?? "" : "";
  return {
    id: comment.id,
    origin: comment.origin === "agent" ? "agent" : "author",
    turn: commentTurn(comment) === "agent" ? "agent（轮到你）" : "author（等作者）",
    quote: comment.quote,
    current:
      docText !== null && span && span.to > span.from && span.via !== "paragraph"
        ? docText.slice(span.from, span.to)
        : null,
    located: span !== null,
    gone: comment.gone === true,
    paragraph: paragraph || comment.paragraph,
    line: docText !== null && span ? lineOfOffset(docText, span.from) : comment.lineHint,
    messages: comment.messages.map((m) => ({
      by: m.by === "agent" ? "agent" : "author",
      text: m.text,
      ...(m.suggestion
        ? {
            suggestion: {
              original: m.suggestion.original,
              replacement: m.suggestion.replacement,
              adopted: m.suggestion.adopted,
            },
          }
        : {}),
    })),
  };
}

/* ---------- MCP（JSON-RPC 2.0） ---------- */

const SUGGESTION_SCHEMA = {
  type: "object",
  description:
    "可选：你想到的具体写法。大多数批注说感受和想法就够了，不用硬给；附上后由作者决定要不要采纳（你不能直接改正文）。",
  properties: {
    original: {
      type: "string",
      description:
        "要替换的正文，从正文逐字复制，全文只出现一次，且在这条批注所在的段落里；省略表示替换这条批注圈住的文字。",
    },
    replacement: {
      type: "string",
      description: "改成什么；空串表示删掉。",
    },
  },
  required: ["replacement"],
} as const;

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: "list_comments",
    description:
      "列出批注。给 path：返回这篇文档每条批注的编号、原文 / 现文、所在段落、完整对话、轮到谁、建议状态，以及作者否决过的意见（rejected，不要再提）。不给 path：返回所有有批注的文档。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文档在库里的路径，如「作品/正文/第3章.md」。" },
      },
    },
  },
  {
    name: "create_comment",
    description:
      "在正文旁边留一条批注：读到这里的感受、想法、疑问、喜欢或不同意的地方都可以，用你自己的语气。quote 是你想聊的那段正文，原样复制、在全文里只出现一次；那里已经有批注在聊时，请用 reply_comment 接着聊。作者否决过的（rejected）就别再提了。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文档在库里的路径。" },
        quote: {
          type: "string",
          description: "你想聊的那段正文，原样复制（工具不认的话会告诉你怎么调）。",
        },
        message: { type: "string", description: "你想对作者说的话。" },
        suggestion: SUGGESTION_SCHEMA,
      },
      required: ["path", "quote", "message"],
    },
  },
  {
    name: "reply_comment",
    description:
      "接着聊一条批注：可以回应作者、讲你的理由、反问，或附上你的写法。只能回复轮到你的（最后一条消息是作者的）那些；聊完了没有，由作者决定。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文档在库里的路径。" },
        id: { type: "integer", description: "批注编号。" },
        message: { type: "string", description: "你想回作者的话。" },
        suggestion: SUGGESTION_SCHEMA,
      },
      required: ["path", "id", "message"],
    },
  },
] as const;

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const SERVER_INSTRUCTIONS =
  "写作工具箱的批注工具：你和作者在正文旁边一起聊这篇作品——说真实的感受和想法就好，用你自己的语气。你可以看、留、回批注，但不能直接改正文；真想到了具体写法，就附 suggestion，由作者决定用不用。quote 和 suggestion.original 要从正文原样复制，不对的话工具会告诉你怎么调。";

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export interface McpServerInfo {
  name: string;
  version: string;
}

async function handleOne(
  message: JsonRpcMessage,
  port: AgentToolsPort,
  info: McpServerInfo
): Promise<Record<string, unknown> | null> {
  if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const isNotification = message.id === undefined;
  const method = typeof message.method === "string" ? message.method : "";
  if (!method) {
    // 客户端发来的响应（服务端没发过请求）或空方法：通知类直接忽略
    return isNotification ? null : rpcError(message.id, -32600, "Invalid Request");
  }
  if (isNotification) return null;
  const id = message.id;
  const params = (typeof message.params === "object" && message.params !== null
    ? message.params
    : {}) as Record<string, unknown>;

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: info,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: AGENT_TOOL_DEFINITIONS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (typeof params.arguments === "object" && params.arguments !== null
        ? params.arguments
        : {}) as Record<string, unknown>;
      let run: (() => Promise<unknown>) | null = null;
      if (name === "list_comments") {
        run = () => port.list({ path: typeof args.path === "string" ? args.path : undefined });
      } else if (name === "create_comment") {
        run = () => port.create(args as unknown as AgentCreateInput);
      } else if (name === "reply_comment") {
        run = () => {
          const raw = args.id;
          const num = typeof raw === "string" ? Number(raw.replace(/^#/, "")) : raw;
          if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) {
            throw new AgentToolError("id 必须是批注编号（正整数）。");
          }
          return port.reply({ ...(args as unknown as AgentReplyInput), id: num });
        };
      }
      if (!run) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        return rpcResult(id, textResult(await run()));
      } catch (error) {
        if (error instanceof AgentToolError) return rpcResult(id, textResult(error.message, true));
        console.error("[Writing Toolkit:agent-bridge] 批注工具执行失败", error);
        return rpcResult(id, textResult("插件内部出错了，请告诉作者看一下控制台。", true));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * 处理一次 POST 的请求体（单条或批量）。只有通知时返回 null（回 202、不带正文）。
 */
export async function handleMcpBody(
  body: unknown,
  port: AgentToolsPort,
  info: McpServerInfo
): Promise<unknown> {
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcError(null, -32600, "Invalid Request");
    const out: unknown[] = [];
    for (const message of body) {
      const reply = await handleOne(message as JsonRpcMessage, port, info);
      if (reply) out.push(reply);
    }
    return out.length > 0 ? out : null;
  }
  return handleOne(body as JsonRpcMessage, port, info);
}

/* ---------- 请求守门（纯函数，服务端每个请求先过它） ---------- */

export interface BridgeRequestHead {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

function header(head: BridgeRequestHead, name: string): string {
  const value = head.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

/** 等长比较，避免按字符提前返回泄露口令长度以外的信息。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 只放行：路径 /mcp、Host 是本机这个端口、没有浏览器来源头、口令正确、POST。
 * 放行返回 null，否则返回状态码与原因。
 */
export function checkBridgeRequest(
  head: BridgeRequestHead,
  token: string,
  port: number
): { status: number; message: string } | null {
  const path = head.url.split("?")[0];
  if (path !== "/mcp") return { status: 404, message: "Not Found" };
  const host = header(head, "host").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { status: 403, message: "Forbidden host" };
  }
  // 浏览器发起的跨源请求一定带 Origin：网页不许调用
  if (header(head, "origin")) return { status: 403, message: "Forbidden origin" };
  const auth = header(head, "authorization");
  if (!token || !safeEqual(auth, `Bearer ${token}`)) {
    return { status: 401, message: "Unauthorized" };
  }
  if (head.method !== "POST") return { status: 405, message: "Method Not Allowed" };
  return null;
}

/** 给 Claude Code 用的连接命令（用户级：这台电脑上任何目录都能用）。 */
export function buildConnectionCommand(
  serverName: string,
  port: number,
  token: string
): string {
  return `claude mcp add --scope user --transport http ${serverName} http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`;
}

/** 设置页「复制给」的几种 Agent */
export type AgentClient = "claude" | "gemini" | "antigravity" | "generic";

export const AGENT_CLIENT_LABELS: Record<AgentClient, string> = {
  claude: "Claude Code",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  generic: "通用（地址 + 口令）",
};

export function isAgentClient(value: unknown): value is AgentClient {
  return typeof value === "string" && value in AGENT_CLIENT_LABELS;
}

/**
 * 某个 Agent 的连接配置：text 复制到剪贴板，done 是复制后的提示（告诉作者下一步）。
 * 各家格式（2026-10 查证）：
 *   - Claude Code：`claude mcp add --transport http`，用户级；
 *   - Gemini CLI：`gemini mcp add --transport http --header`，写进 ~/.gemini/settings.json 的 httpUrl；
 *   - Antigravity：没有命令，手动在 ~/.gemini/config/mcp_config.json 的 mcpServers 里加，
 *     远程服务的字段是 serverUrl（不是 httpUrl）。
 */
export function buildConnectionConfig(
  client: AgentClient,
  serverName: string,
  port: number,
  token: string
): { text: string; done: string } {
  const url = `http://127.0.0.1:${port}/mcp`;
  const auth = `Bearer ${token}`;
  switch (client) {
    case "claude":
      return {
        text: buildConnectionCommand(serverName, port, token),
        done: "已复制 Claude Code 的连接命令：粘到终端里运行一次，再重开 Claude Code",
      };
    case "gemini":
      return {
        text: `gemini mcp add --scope user --transport http --header "Authorization: ${auth}" ${serverName} ${url}`,
        done: "已复制 Gemini CLI 的连接命令：粘到终端里运行一次，再重开 Gemini CLI，用 /mcp 能看到批注工具",
      };
    case "antigravity":
      return {
        text: JSON.stringify(
          { [serverName]: { serverUrl: url, headers: { Authorization: auth } } },
          null,
          2
        )
          // 只要 mcpServers 里的那一项：去掉最外层花括号，方便直接粘进去
          .replace(/^\{\n/, "")
          .replace(/\n\}$/, ""),
        done: "已复制 Antigravity 的配置：打开 ~/.gemini/config/mcp_config.json（Antigravity 里 MCP 设置的「View raw config」），粘进 mcpServers 里（前后注意逗号），保存后重启 Antigravity",
      };
    case "generic":
      return {
        text: `地址：${url}\n传输方式：Streamable HTTP\n请求头：Authorization: ${auth}`,
        done: "已复制地址和口令：按你用的 Agent 的 MCP 配置方式填进去",
      };
  }
}

export const DEFAULT_BRIDGE_PORT = 27183;

export function isValidBridgePort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}
