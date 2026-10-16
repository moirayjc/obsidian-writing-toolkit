/**
 * 批注：数据模型、批注文件（`文档名.批注.md`）的解析与序列化、原文定位。
 *
 * 设计背景：Maureen 的创作流程是「Agent 写稿 → 她在文档上批注 → Agent
 * 读批注改稿」。批注存放在源文档同目录的伴随文件 `文档名.批注.md` 里，
 * 正文一个字都不动。
 *
 * 定位（Agent 改稿后「原文」往往已经不在了）按四层来：
 *   1. 现文——Agent 改完写回的当前文字（协议见文件抬头，最可靠）；
 *   2. 原文——精确匹配，其次是忽略空白的弹性匹配；
 *   3. 段内残余——用建批注时那一段里「原文前后还在的文字」夹出被改写的位置；
 *   4. 段落——整段文本匹配 / 相似度匹配（结合段落序号就近取舍）。
 * 四层都不中时返回 null，界面上标「锚点失效」，用户可以手动重新绑定。
 *
 * 本模块是纯逻辑（不依赖 Obsidian API），方便单测。
 */

/** 批注状态：待处理 / 已处理 */
export type CommentStatus = "pending" | "resolved";

export interface WtComment {
  /** 批注编号（文件内唯一，从 1 起；删除后不重排，新批注取最大号 + 1） */
  id: number;
  status: CommentStatus;
  /** 引用的原文（建立批注时选中的文字） */
  quote: string;
  /** 建立时所在的整段（空行分隔的块；她的稿子基本一段一行） */
  paragraph: string;
  /** 建立时这一段在文档里的序号（1 起，用于定位时就近取舍） */
  paragraphHint: number;
  /** 建立时的行号（1 起，用于在多个相同原文里就近定位） */
  lineHint: number;
  /** 建立时间 "YYYY-MM-DD HH:mm" */
  createdAt: string;
  /** 批注内容 */
  content: string;
  /** 写批注的人（预留，暂只用不上） */
  author?: string;
  /** Agent 的回复（处理完后由 Agent 写入） */
  reply: string;
  /** 现文：Agent 改稿后写回的「改完后对应位置的文字」 */
  current: string;
}

/** 一条批注是怎么定到的位（界面据此区分「精确命中」和「上下文迁移」） */
export type LocateVia = "present" | "exact" | "fuzzy" | "residue" | "paragraph";

export interface LocateSpan {
  /** 匹配到的起点（文档字符偏移） */
  from: number;
  /** 匹配到的终点（文档字符偏移） */
  to: number;
  /** 定位方式；exact / present 算精确命中，其余属于「迁移定位」 */
  via: LocateVia;
}

export const COMMENT_STATUS_LABELS: Record<CommentStatus, string> = {
  pending: "待处理",
  resolved: "已处理",
};

/** 定位方式的中文说明（面板 / 弹层共用）。 */
export const LOCATE_VIA_LABELS: Record<LocateVia, string> = {
  present: "按现文定位",
  exact: "精确命中",
  fuzzy: "已自动重新定位",
  residue: "原文已改写，按上下文定位",
  paragraph: "原文已改写，定位到这一段",
};

/* ---------- 伴随文件路径 ---------- */

/** 批注伴随文件名后缀（正则）：`xxx.批注.md`，也匹配不带 .md 的 basename */
const SIDECAR_RE = /\.批注(\.md)?$/i;

export function isSidecarPath(path: string): boolean {
  return /\.批注\.md$/i.test(path);
}

export function isCommentSidecarName(name: string): boolean {
  return SIDECAR_RE.test(name.trim());
}

/** 源文档路径 → 批注文件路径（已传入批注文件的路径则原样返回）。 */
export function sidecarPathFor(docPath: string): string {
  if (isSidecarPath(docPath)) return docPath;
  return docPath.replace(/\.md$/i, ".批注.md");
}

/** 批注文件路径 → 源文档路径。 */
export function docPathForSidecar(sidecarPath: string): string {
  return sidecarPath.replace(/\.批注\.md$/i, ".md");
}

/* ---------- 小工具 ---------- */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 时间戳："2026-10-15 11:20" */
export function formatTimestamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
}

export function nextCommentId(comments: readonly WtComment[]): number {
  let max = 0;
  for (const c of comments) if (c.id > max) max = c.id;
  return max + 1;
}

/** 第 line 行（1 起）的行首在文档中的偏移；越界时返回文档长度。 */
export function offsetOfLine(docText: string, line: number): number {
  let offset = 0;
  for (let i = 1; i < line; i++) {
    const nl = docText.indexOf("\n", offset);
    if (nl === -1) return docText.length;
    offset = nl + 1;
  }
  return offset;
}

/** 文档偏移 → 行号（1 起）。 */
export function lineOfOffset(docText: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, docText.length));
  for (let i = 0; i < end; i++) {
    if (docText.charCodeAt(i) === 10) line++;
  }
  return line;
}

function nearest(values: number[], target: number): number {
  let best = values[0];
  let bestDist = Math.abs(best - target);
  for (const v of values) {
    const dist = Math.abs(v - target);
    if (dist < bestDist) {
      best = v;
      bestDist = dist;
    }
  }
  return best;
}

function findAll(haystack: string, needle: string, limit = 200): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i !== -1 && out.length < limit) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

/* ---------- 段落 ---------- */

export interface DocParagraph {
  /** 段落在文档里的起点（字符偏移） */
  from: number;
  /** 终点（不含段尾换行） */
  to: number;
  text: string;
  /** 段落序号（1 起；空行分隔的块，标题、列表行也算独立段落） */
  index: number;
}

/** 把文档切成段落（空行分隔的块）。 */
export function collectParagraphs(docText: string): DocParagraph[] {
  const result: DocParagraph[] = [];
  let from = -1;
  let to = 0;
  let lineStart = 0;
  for (;;) {
    const nl = docText.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? docText.length : nl;
    const blank = docText.slice(lineStart, lineEnd).trim() === "";
    if (!blank) {
      if (from === -1) from = lineStart;
      to = lineEnd;
    } else if (from !== -1) {
      result.push({
        from,
        to,
        text: docText.slice(from, to),
        index: result.length + 1,
      });
      from = -1;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (from !== -1) {
    result.push({
      from,
      to,
      text: docText.slice(from, to),
      index: result.length + 1,
    });
  }
  return result;
}

/** offset 所在的段落；正好落在空行上时，取它前面最近的一段（其次后面最近的一段）。 */
export function paragraphAt(
  docText: string,
  offset: number
): DocParagraph | null {
  const paragraphs = collectParagraphs(docText);
  let before: DocParagraph | null = null;
  for (const p of paragraphs) {
    if (offset >= p.from && offset <= p.to) return p;
    if (p.to < offset) before = p;
    else break;
  }
  if (before) return before;
  return paragraphs.length > 0 ? paragraphs[0] : null;
}

/* ---------- 忽略空白的紧凑索引 ---------- */

interface Compact {
  /** 去掉所有空白后的文本 */
  text: string;
  /** map[i] = 紧凑文本第 i 个字在原文里的偏移；map[len] = 原文长度 */
  map: number[];
}

const WS_RE = /\s/;

function compact(input: string): Compact {
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (
      WS_RE.test(ch) ||
      ch === "\u3000" ||
      ch === "\u200b" ||
      ch === "\ufeff"
    ) {
      continue;
    }
    chars.push(ch);
    map.push(i);
  }
  map.push(input.length);
  return { text: chars.join(""), map };
}

/** 两段文本「头尾还一样」的程度（0~1）：整段被改写时用它找最像的段落。 */
function commonEndsScore(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  let head = 0;
  const headMax = Math.min(a.length, b.length);
  while (head < headMax && a[head] === b[head]) head++;
  let tail = 0;
  const tailMax = Math.min(a.length - head, b.length - head);
  while (
    tail < tailMax &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  return (head + tail) / max;
}

/* ---------- 定位 ---------- */

/**
 * 为一份文档预建索引，批注都在这上面定位。
 * 装饰层、面板、跳转共用同一个定位实现，保证三处结果一致。
 */
export class AnchorLocator {
  private readonly docText: string;
  private readonly compactDoc: Compact;
  private paragraphs: DocParagraph[] | null = null;
  private paragraphCompacts: Compact[] | null = null;

  constructor(docText: string) {
    this.docText = docText;
    this.compactDoc = compact(docText);
  }

  locate(comment: WtComment): LocateSpan | null {
    const hintOffset = offsetOfLine(
      this.docText,
      Math.max(1, comment.lineHint)
    );
    const hintCompact = this.compactIndexNear(hintOffset);

    // 1) 现文（Agent 写回）
    const present = comment.current.trim();
    if (present) {
      const span = this.locateText(present, hintCompact);
      if (span) return { from: span.from, to: span.to, via: "present" };
    }

    // 2) 原文：精确 → 忽略空白
    const quote = comment.quote.trim();
    if (quote) {
      const exact = findAll(this.docText, quote);
      if (exact.length > 0) {
        const from = nearest(exact, hintOffset);
        return { from, to: from + quote.length, via: "exact" };
      }
      const span = this.locateText(quote, hintCompact);
      if (span) return { from: span.from, to: span.to, via: "fuzzy" };
    }

    // 3) 段内残余
    const residue = this.locateResidue(comment, hintCompact);
    if (residue) return residue;

    // 4) 段落
    const paragraph = this.locateParagraph(comment, hintCompact);
    if (paragraph) return paragraph;

    return null;
  }

  /** 在紧凑文本里找一段文字；返回原文偏移。 */
  private locateText(
    needle: string,
    hintCompact: number
  ): { from: number; to: number } | null {
    const n = compact(needle).text;
    if (!n) return null;
    const hits = findAll(this.compactDoc.text, n);
    if (hits.length === 0) return null;
    const best = nearest(hits, hintCompact);
    return this.docRange(best, best + n.length);
  }

  /**
   * 段内残余：建批注时那一段里，原文前后的文字还活着 → 用它们夹出被改写的区间。
   * 头尾都太短（原文几乎占了整段）时放弃，交给段落相似度那一层。
   */
  private locateResidue(
    comment: WtComment,
    hintCompact: number
  ): LocateSpan | null {
    const paragraph = compact(comment.paragraph.trim());
    const quote = compact(comment.quote.trim());
    if (!paragraph.text || !quote.text) return null;
    const idx = paragraph.text.indexOf(quote.text);
    if (idx < 0) return null;
    const head = paragraph.text.slice(0, idx).slice(-28);
    const tail = paragraph.text.slice(
      idx + quote.text.length,
      idx + quote.text.length + 28
    );
    if (head.length < 4 && tail.length < 4) return null;

    const docText = this.compactDoc.text;

    /**
     * head 不可用（原文就贴着段首）时**直接放弃残余层**，交给段落层。
     *
     * 为什么不用 hint 兜底：hint 来自行号提示，可能已经不准；而 head 缺失时
     * 没有任何东西能验证它。赌对了只多一点点精度，赌错了就是「从某个错误位置
     * 一直画到 tail」——曾经这里用 `[0]` 兜底，结果 `start = 0`，一篇长稿
     * 会被从**文档开头**整段涂上底色（实测 21 字文档得 0..209，一个批注盖住整篇）。
     *
     * 段落层是安全的替代：它能定位到整段，而 `commentDecor` 对 `paragraph`
     * 不画底色（只出行尾脚注号），所以最坏情况是「少了底色」，不会「涂错一大片」。
     */
    if (head.length < 4) return null;

    const headHits = findAll(docText, head, 120);
    if (headHits.length === 0) return null;

    let best: { from: number; to: number; distance: number } | null = null;
    for (const hit of headHits) {
      const start = hit + head.length;
      const candidate =
        tail.length >= 4
          ? (() => {
              const at = docText.indexOf(tail, start);
              if (at === -1 || at - start > 600) return null;
              return { from: start, to: at, distance: Math.abs(start - hintCompact) };
            })()
          : // 只有头部活着：产生零宽锚点（正文里只有脚注号、没有底色）
            { from: start, to: start, distance: Math.abs(start - hintCompact) };
      if (!candidate) continue;
      if (!best || candidate.distance < best.distance) best = candidate;
    }
    if (!best) return null;
    const range = this.docRange(best.from, best.to);
    return { from: range.from, to: range.to, via: "residue" };
  }

  /** 段落：先整段匹配，再按「头尾相似度」找最像的段落（结合段落序号就近）。 */
  private locateParagraph(
    comment: WtComment,
    hintCompact: number
  ): LocateSpan | null {
    const paragraph = compact(comment.paragraph.trim());
    if (!paragraph.text || paragraph.text.length < 6) return null;

    const hits = findAll(this.compactDoc.text, paragraph.text, 120);
    if (hits.length > 0) {
      const best = nearest(hits, hintCompact);
      const range = this.docRange(best, best + paragraph.text.length);
      return { from: range.from, to: range.to, via: "paragraph" };
    }

    const list =
      this.paragraphs ?? (this.paragraphs = collectParagraphs(this.docText));
    const compacts =
      this.paragraphCompacts ??
      (this.paragraphCompacts = list.map((p) => compact(p.text)));
    let best: { index: number; score: number; distance: number } | null = null;
    for (let i = 0; i < list.length; i++) {
      const text = compacts[i].text;
      if (text.length < 6) continue;
      const score = commonEndsScore(paragraph.text, text);
      if (score < 0.55) continue;
      const distance = Math.abs(
        list[i].index - Math.max(1, comment.paragraphHint || 1)
      );
      if (
        !best ||
        score > best.score + 1e-6 ||
        (Math.abs(score - best.score) <= 1e-6 && distance < best.distance)
      ) {
        best = { index: i, score, distance };
      }
    }
    if (!best) return null;
    const p = list[best.index];
    return { from: p.from, to: p.to, via: "paragraph" };
  }

  /** 紧凑下标：返回与 docOffset 最近（落在前方）的紧凑下标。 */
  private compactIndexNear(docOffset: number): number {
    const map = this.compactDoc.map;
    let lo = 0;
    let hi = map.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (map[mid] < docOffset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 紧凑区间 [a, b) → 原文区间；空区间返回零宽。
   * 末尾取「最后一个命中的字 + 1」，不把匹配之后的空白（换行等）圈进标记里。
   */
  private docRange(a: number, b: number): { from: number; to: number } {
    const map = this.compactDoc.map;
    const start = map[Math.max(0, Math.min(a, map.length - 1))];
    if (b <= a) return { from: start, to: start };
    const last = Math.max(0, Math.min(b, map.length - 1) - 1);
    // 末尾停在最后一个命中的字之后（按码点算宽度，避免把一个字符切两半）
    const end = Math.min(
      this.docText.length,
      map[last] + ((this.docText.codePointAt(map[last]) ?? 0) > 0xffff ? 2 : 1)
    );
    return { from: start, to: Math.max(start, end) };
  }
}

/** 单条批注定位（内部按需建索引；批量请直接用 AnchorLocator）。 */
export function locateComment(
  docText: string,
  comment: WtComment
): LocateSpan | null {
  return new AnchorLocator(docText).locate(comment);
}

/* ---------- 批量定位与分组（正文批注层用） ---------- */

export interface LocatedComment {
  comment: WtComment;
  /** 匹配到的起点（文档字符偏移） */
  from: number;
  /** 匹配到的终点（文档字符偏移） */
  to: number;
  /** 定位方式 */
  via: LocateVia;
  /** 匹配起点所在的行号（1 起）。 */
  lineFrom: number;
  /** 匹配终点所在的行号（1 起）；脚注号与旧版卡片用 */
  lineTo: number;
}

/** 批量定位（找不到的批注直接跳过）。 */
export function locateAll(
  docText: string,
  comments: readonly WtComment[]
): LocatedComment[] {
  const locator = new AnchorLocator(docText);
  const result: LocatedComment[] = [];
  for (const comment of comments) {
    const span = locator.locate(comment);
    if (!span) continue;
    result.push({
      comment,
      from: span.from,
      to: span.to,
      via: span.via,
      lineFrom: lineOfOffset(docText, span.from),
      lineTo: lineOfOffset(docText, span.to),
    });
  }
  return result;
}

/* ---------- 批注文件：序列化 ---------- */

/** 批注文件抬头：写给 Agent 的处理说明（HTML 注释，阅读视图不显示）。 */
const SIDECAR_HELP_HEADER = [
  "<!-- 写作工具箱 · 批注文件",
  "这是作者写给「负责修改本文档的 Agent」的批注。",
  "",
  "给 Agent 的处理方式：",
  "1. 逐条阅读下方批注，对照每条里的「原文」在源文档中找到对应位置，按「批注」的要求修改源文档；",
  "2. 每条处理完后，只修改该条批注的这些地方——「状态」改为：已处理；在「回复」后写明你做了什么改动（回复多于一行时，从第二行起每行都缩进两格，例如：- 回复：第一点\\n  第二点）；",
  "3. 如果你改写了「原文」对应的文字（哪怕只是挪了位置），就把改完后该处现在的文字照抄进「现文」（新增一行：- 现文：……，不要加引号、不要换行）；如果原文一个字都没动，可以不写；",
  "4. 其余文字（包括本说明）请勿改动，也不要删除批注条目。",
  "-->",
].join("\n");

function docBaseName(docPath: string): string {
  return docPath.split("/").pop() ?? docPath;
}

function writeField(lines: string[], label: string, value: string): void {
  const parts = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  lines.push(`- ${label}：${parts[0] ?? ""}`);
  // 多行内容用两格缩进的续行表示（解析时会拼回去）
  for (let i = 1; i < parts.length; i++) {
    lines.push(`  ${parts[i]}`);
  }
}

/** 把批注列表序列化成批注文件全文。 */
export function serializeCommentFile(
  docPath: string,
  comments: readonly WtComment[]
): string {
  const base = docBaseName(docPath);
  const title = base.replace(/\.md$/i, "");
  const lines: string[] = [];
  lines.push(SIDECAR_HELP_HEADER);
  lines.push("");
  lines.push(`# 批注 · ${title}`);
  for (const c of comments) {
    lines.push("");
    lines.push(`### 批注 ${c.id}`);
    writeField(lines, "状态", COMMENT_STATUS_LABELS[c.status]);
    writeField(lines, "原文", c.quote);
    if (c.paragraph.trim()) writeField(lines, "段落", c.paragraph);
    if (c.current.trim()) writeField(lines, "现文", c.current);
    writeField(
      lines,
      "位置",
      c.paragraphHint > 0
        ? `第 ${c.paragraphHint} 段 · 约第 ${c.lineHint} 行`
        : `约第 ${c.lineHint} 行`
    );
    writeField(lines, "创建", c.createdAt);
    writeField(lines, "内容", c.content);
    writeField(lines, "回复", c.reply);
  }
  lines.push("");
  return lines.join("\n");
}

/* ---------- 批注文件：解析 ---------- */

const HEADER_RE = /^\s*(?:#{2,6}\s*|\*\*\s*)批注\s*(\d+)/;
const FIELD_RE = /^\s*[-*+]\s*\**\s*([^：:*]+?)\s*\**\s*[：:]\s?(.*)$/;
const KNOWN_LABELS = new Set([
  "状态",
  "原文",
  "段落",
  "现文",
  "位置",
  "创建",
  "时间",
  "内容",
  "批注",
  "回复",
]);

/** 续行去掉开头的缩进（两个以上空格或 Tab）；无缩进的行原样保留。 */
function stripIndent(raw: string): string {
  return raw.replace(/^(?: {2,}|\t+)/, "");
}

/** 去掉字段值首尾的换行（首行为空、续行结尾的空行都会留下换行）。 */
function trimLineBreaks(value: string): string {
  return value.replace(/^\n+/, "").replace(/\n+$/, "");
}

/** 状态文字 → 待处理 / 已处理；认不出来的一律当待处理，宁可多看一眼也不漏。 */
function parseStatus(value: string): WtComment["status"] {
  if (/未|待|pending|todo/i.test(value)) return "pending";
  if (/已|完成|解决|改完|改好|改了|resolved|done/i.test(value)) return "resolved";
  return "pending";
}

type ContinuableField = "quote" | "paragraph" | "current" | "content" | "reply";

/**
 * 解析批注文件全文。刻意容错：字段顺序、列表符号（- * +）、
 * Agent 改过的「状态」「回复」「现文」、未知字段、多余说明都能接受。
 */
export function parseCommentFile(text: string): WtComment[] {
  const comments: WtComment[] = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let current: WtComment | null = null;
  let lastField: ContinuableField | null = null;

  const appendTo = (field: ContinuableField, value: string) => {
    if (!current) return;
    switch (field) {
      case "quote":
        current.quote += value;
        break;
      case "paragraph":
        current.paragraph += value;
        break;
      case "current":
        current.current += value;
        break;
      case "content":
        current.content += value;
        break;
      case "reply":
        current.reply += value;
        break;
    }
  };

  const flush = () => {
    if (!current) return;
    // 块与块之间的空行会被当作续行计入，收尾时清掉末尾多余换行
    current.quote = trimLineBreaks(current.quote);
    current.paragraph = trimLineBreaks(current.paragraph);
    current.current = trimLineBreaks(current.current);
    current.content = trimLineBreaks(current.content);
    current.reply = trimLineBreaks(current.reply);
    if (
      current.quote.trim() !== "" ||
      current.content.trim() !== "" ||
      current.paragraph.trim() !== ""
    ) {
      comments.push(current);
    }
    current = null;
    lastField = null;
  };

  for (const raw of lines) {
    const header = HEADER_RE.exec(raw);
    if (header) {
      flush();
      current = {
        id: Number(header[1]),
        status: "pending",
        quote: "",
        paragraph: "",
        paragraphHint: 0,
        lineHint: 0,
        createdAt: "",
        content: "",
        reply: "",
        current: "",
      };
      continue;
    }
    if (!current) continue;

    const field = FIELD_RE.exec(raw);
    const label = field?.[1].trim() ?? "";
    if (field && KNOWN_LABELS.has(label)) {
      const value = field[2] ?? "";
      lastField = null;
      switch (label) {
        case "状态":
          current.status = parseStatus(value);
          break;
        case "原文":
          current.quote = value;
          lastField = "quote";
          break;
        case "段落":
          current.paragraph = value;
          lastField = "paragraph";
          break;
        case "现文":
          current.current = value;
          lastField = "current";
          break;
        case "位置": {
          const para = /第\s*(\d+)\s*段/.exec(value);
          if (para) current.paragraphHint = Number(para[1]);
          const line = /第\s*(\d+)\s*行/.exec(value) ?? /(\d+)/.exec(value);
          if (line) current.lineHint = Number(line[1]);
          break;
        }
        case "创建":
        case "时间":
          current.createdAt = value.trim();
          break;
        case "内容":
        case "批注":
          current.content = value;
          lastField = "content";
          break;
        case "回复":
          current.reply = value;
          lastField = "reply";
          break;
      }
      continue;
    }

    if (lastField) {
      if (raw.trim() === "") {
        appendTo(lastField, "\n");
        continue;
      }
      appendTo(lastField, "\n" + stripIndent(raw));
    }
  }
  flush();

  comments.sort((a, b) => a.id - b.id);
  return comments;
}

/* ---------- 给 Agent 的现成指令 ---------- */

/**
 * 「批注：复制给 Agent 的处理指令」命令用的话术（命令面板里调用）。
 * 传入当前文档的批注统计后，指令里会写明待处理条数，避免 Agent 重复处理。
 */
export function buildAgentPrompt(
  docPath: string,
  counts?: { pending: number; resolved: number }
): string {
  const base = docBaseName(docPath);
  const sidecar = sidecarPathFor(docPath);
  const sidecarName = docBaseName(sidecar);
  const scope = counts
    ? `（目前待处理 ${counts.pending} 条；已处理 ${counts.resolved} 条不用重复处理）`
    : "";
  return [
    `请处理《${base}》里的批注${scope}。`,
    ``,
    `打开同目录的「${sidecarName}」，里面每条批注都有「原文 / 段落 / 状态 / 回复」几项。请逐条来：`,
    `1. 对照每条批注的「原文」，在《${base}》里找到对应位置，按「批注」的要求修改；`,
    `2. 改完后，把该条批注的「状态」改为「已处理」，并在「回复」里写明你做了什么改动；`,
    `3. 如果你改写了「原文」对应的文字，请把改完后该处现在的文字照抄进「现文」（新增一行：- 现文：……）。这样作者回到正文时，批注能跟到新的位置上；`,
    `4. 请保留批注的编号与格式，不要删除任何批注条目。`,
  ].join("\n");
}
