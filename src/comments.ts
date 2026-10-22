/**
 * 批注：数据模型、批注文件（`文档名.批注.md`）的解析与序列化、原文定位。
 *
 * 设计背景：Maureen 的创作流程是「Agent 通读稿子发起一批批注 → 她在
 * 面板里逐条回复 → Agent 再回一轮 → …… → 她逐条点已解决 / 不采纳」。
 * 每条批注是一串对话，作者与 Agent 都能发起；结案只能由作者在面板里点。
 * 批注存放在库根 `.wt-comments/` 下的独立伴随文件里（镜像正文的相对路径），
 * 正文一个字都不动。旧版同目录 `文档名.批注.md` 会自动迁移过来，读取时
 * 仍兼容旧位置。
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

/** 说话人：作者 / Agent */
export type CommentSpeaker = "author" | "agent";

/** 对话里的一条消息 */
export interface CommentMessage {
  by: CommentSpeaker;
  text: string;
}

/**
 * 轮到谁：由最后一条消息的说话人推出（文件里没有状态字段，Agent 改不了）。
 * 最后是 Agent → 等作者；最后是作者（或还没有消息）→ 等 Agent。
 */
export type CommentTurn = "author" | "agent";

export interface WtComment {
  /** 批注编号（文件内唯一，从 1 起；删除后不重排，新批注取最大号 + 1） */
  id: number;
  /** 谁发起的（只用于显示） */
  origin: CommentSpeaker;
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
  /** 对话：按文件里出现的顺序 */
  messages: CommentMessage[];
  /**
   * 现文：这处原文现在的样子。作者在编辑器里改正文时由插件自动写回，
   * Agent 改稿后也要写回；定位时最优先。
   */
  current: string;
  /**
   * 原文已被作者整段删掉（编辑器里跟踪到的）：只按「段落」定位到删除处，
   * 不再拿原文去全文找（同样的字可能出现在别处，会指错地方）。
   */
  gone?: boolean;
}

/** 批注文件的全部内容：进行中的批注 + 作者否决过的意见（给 Agent 看，别再提）。 */
export interface CommentFileData {
  comments: WtComment[];
  rejected: string[];
}

export const COMMENT_SPEAKER_LABELS: Record<CommentSpeaker, string> = {
  author: "作者",
  agent: "Agent",
};

export const COMMENT_TURN_LABELS: Record<CommentTurn, string> = {
  author: "等你",
  agent: "等 Agent",
};

export function commentTurn(comment: WtComment): CommentTurn {
  const last = comment.messages[comment.messages.length - 1];
  return last?.by === "agent" ? "author" : "agent";
}

/** 最后一条消息（没有消息时为 null）。 */
export function lastMessage(comment: WtComment): CommentMessage | null {
  return comment.messages[comment.messages.length - 1] ?? null;
}

/**
 * 批注文件被外部改写后，找出越权的改动：条目消失（只有作者能结案），
 * 或已有消息被改 / 删（对话只许往后追加）。追加消息、新开批注、改现文都算正常。
 */
export interface CommentTamperReport {
  /** 消失的条目（改写前的版本） */
  removed: WtComment[];
  /** 已有消息被改动的条目（改写前的版本） */
  altered: WtComment[];
}

export function detectCommentTampering(
  before: readonly WtComment[],
  after: readonly WtComment[]
): CommentTamperReport {
  const afterById = new Map(after.map((c) => [c.id, c]));
  const removed: WtComment[] = [];
  const altered: WtComment[] = [];
  for (const old of before) {
    const next = afterById.get(old.id);
    if (!next) {
      removed.push(old);
      continue;
    }
    const kept =
      next.messages.length >= old.messages.length &&
      old.messages.every(
        (m, i) => next.messages[i].by === m.by && next.messages[i].text === m.text
      );
    if (!kept) altered.push(old);
  }
  return { removed, altered };
}

/** 按报告把越权改动恢复成改写前的样子；其余（Agent 正常追加的内容）保留。 */
export function restoreTamperedComments(
  current: readonly WtComment[],
  report: CommentTamperReport
): WtComment[] {
  const restore = new Map(
    [...report.removed, ...report.altered].map((c) => [c.id, c])
  );
  const next = current.map((c) => restore.get(c.id) ?? c);
  for (const c of report.removed) {
    if (!next.some((item) => item.id === c.id)) next.push(c);
  }
  return next.sort((a, b) => a.id - b.id);
}

/** 「已否决」区的一行：原文 + 首条意见，压成一行。 */
export function rejectedLine(comment: WtComment): string {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  const quote = flat(comment.quote);
  const first = flat(comment.messages[0]?.text ?? "");
  const brief = first.length > 60 ? first.slice(0, 60) + "…" : first;
  return brief ? `「${quote}」：${brief}` : `「${quote}」`;
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

/** 定位方式的中文说明（面板 / 弹层共用）。 */
export const LOCATE_VIA_LABELS: Record<LocateVia, string> = {
  present: "按现文定位",
  exact: "精确命中",
  fuzzy: "已自动重新定位",
  residue: "原文已改写，按上下文定位",
  paragraph: "原文已改写，定位到这一段",
};

/* ---------- 伴随文件路径 ---------- */

/** 独立批注目录（镜像正文路径，和 `.wt-outlines` / `.wt-snapshots` 同级）。 */
export const COMMENTS_FOLDER = ".wt-comments";

/** 批注伴随文件名后缀（正则）：`xxx.批注.md`，也匹配不带 .md 的 basename */
const SIDECAR_RE = /\.批注(\.md)?$/i;

export function isSidecarPath(path: string): boolean {
  return /\.批注\.md$/i.test(path);
}

export function isCommentSidecarName(name: string): boolean {
  return SIDECAR_RE.test(name.trim());
}

/** 源文档路径 → 新目录下的批注文件路径（已传入批注文件的路径则原样返回）。 */
export function sidecarPathFor(docPath: string): string {
  if (isSidecarPath(docPath)) return docPath;
  return `${COMMENTS_FOLDER}/${docPath.replace(/\.md$/i, ".批注.md")}`;
}

/** 旧版同目录批注文件路径（只用于迁移与兼容读取）。 */
export function legacySidecarPathFor(docPath: string): string {
  if (isSidecarPath(docPath)) return docPath;
  return docPath.replace(/\.md$/i, ".批注.md");
}

/** 是否是旧版「正文同目录」的批注文件。 */
export function isLegacySidecarPath(path: string): boolean {
  return isSidecarPath(path) && !path.startsWith(`${COMMENTS_FOLDER}/`);
}

/** 批注文件路径 → 源文档路径。新旧两种布局都认。 */
export function docPathForSidecar(sidecarPath: string): string {
  const rel = sidecarPath.startsWith(`${COMMENTS_FOLDER}/`)
    ? sidecarPath.slice(COMMENTS_FOLDER.length + 1)
    : sidecarPath;
  return rel.replace(/\.批注\.md$/i, ".md");
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

    // 原文已被作者删掉：直接落到删除处所在的段落
    if (comment.gone) {
      return this.locateParagraph(comment, hintCompact);
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

/**
 * 批注文件抬头：写给 Agent 的协议（HTML 注释，阅读视图不显示）。
 * ⚠️ 与 parseCommentFileData 必须同改；多行示例不能删（历史上两者脱节导致整条批注被静默丢弃）。
 */
const SIDECAR_HELP_HEADER = [
  "<!-- 写作工具箱 · 批注文件",
  "这是作者与 Agent 针对源文档的逐条讨论。每条批注 = 一处原文 + 一串对话，对话一行一条：「- 作者：……」或「- Agent：……」，按出现顺序就是先后顺序。",
  "多于一行的消息，从第二行起每行缩进两格，例如：",
  "- Agent：第一点",
  "  第二点",
  "",
  "给 Agent 的规则：",
  "1. 发起批注：在文件末尾（「## 已否决」之前）新增「### 批注 N」（N 取现有最大编号 + 1），依次写「- 发起：Agent」「- 原文：……」「- 段落：……」「- 位置：第 X 段 · 约第 Y 行」「- 创建：YYYY-MM-DD HH:mm」「- Agent：你的意见」。「原文」必须从源文档逐字复制，取一句里有区分度的短片段；「段落」照抄原文所在的整段。同一处已有批注时，在那条里追加消息，不要新开；不要重复提出「已否决」里的意见。",
  "2. 找位置：先在源文档里找「现文」（作者改正文时插件会自动写回），没有现文或找不到再找「原文」。都找不到就在回复里说明，绝不要改写「原文」「段落」去指向别的句子。有「- 原文已删除：是」的，说明作者已经删掉了那句，按「段落」理解上下文。",
  "3. 回复：只回复最后一条消息是「作者」的批注，在该条末尾追加一行「- Agent：……」。不要修改或删除任何已有消息，不要删除批注条目，不要改「已否决」。",
  "4. 改正文：讨论中只在消息里给改写方案，不要动源文档；作者在消息里明确要求改（如「改」「就这样改」）时，才修改源文档，并把改完后该处现在的文字照抄进「现文」（- 现文：……，不加引号、不换行；已有就覆盖），再追加一条 Agent 消息说明改了什么。",
  "5. 批注是否解决只由作者在插件里决定：没有状态字段，不要自己添加，也不要删除条目来表示解决。",
  "6. 其余文字（包括本说明）请勿改动。",
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

/** 把批注列表（和「已否决」区）序列化成批注文件全文。 */
export function serializeCommentFile(
  docPath: string,
  comments: readonly WtComment[],
  rejected: readonly string[] = []
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
    writeField(lines, "发起", COMMENT_SPEAKER_LABELS[c.origin]);
    writeField(lines, "原文", c.quote);
    if (c.paragraph.trim()) writeField(lines, "段落", c.paragraph);
    if (c.current.trim()) writeField(lines, "现文", c.current);
    if (c.gone) writeField(lines, "原文已删除", "是");
    writeField(
      lines,
      "位置",
      c.paragraphHint > 0
        ? `第 ${c.paragraphHint} 段 · 约第 ${c.lineHint} 行`
        : `约第 ${c.lineHint} 行`
    );
    writeField(lines, "创建", c.createdAt);
    for (const m of c.messages) {
      writeField(lines, COMMENT_SPEAKER_LABELS[m.by], m.text);
    }
  }
  const rejectedLines = rejected
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (rejectedLines.length > 0) {
    lines.push("");
    lines.push("## 已否决");
    for (const line of rejectedLines) lines.push(`- ${line}`);
  }
  lines.push("");
  return lines.join("\n");
}

/* ---------- 批注文件：解析 ---------- */

const HEADER_RE = /^\s*(?:#{2,6}\s*|\*\*\s*)批注\s*(\d+)/;
/** 「已否决」区标题；必须在条目解析之前判断，否则会被当成上一条的续行。 */
const REJECTED_HEAD_RE = /^\s*#{1,6}\s*已否决/;
const LIST_ITEM_RE = /^\s*[-*+]\s+(.*)$/;
const FIELD_RE = /^\s*[-*+]\s*\**\s*([^：:*]+?)\s*\**\s*[：:]\s?(.*)$/;
const KNOWN_LABELS = new Set([
  "发起",
  "状态",
  "原文",
  "段落",
  "现文",
  "原文已删除",
  "位置",
  "创建",
  "时间",
  "内容",
  "批注",
  "回复",
]);

/** 消息标签 → 说话人；不是消息标签返回 null。 */
function speakerOf(label: string): CommentSpeaker | null {
  if (label === "作者") return "author";
  if (/^(agent|ai|助手)$/i.test(label)) return "agent";
  return null;
}

/** 续行去掉开头的缩进（两个以上空格或 Tab）；无缩进的行原样保留。 */
function stripIndent(raw: string): string {
  return raw.replace(/^(?: {2,}|\t+)/, "");
}

/** 去掉字段值首尾的换行（首行为空、续行结尾的空行都会留下换行）。 */
function trimLineBreaks(value: string): string {
  return value.replace(/^\n+/, "").replace(/\n+$/, "");
}

type ContinuableField =
  | "quote"
  | "paragraph"
  | "current"
  | "message"
  | "legacyContent"
  | "legacyReply";

interface ParsingComment extends WtComment {
  /** 旧格式「内容」：转成第一条消息 */
  legacyContent: string;
  /** 旧格式「回复」：转成一条 Agent 消息 */
  legacyReply: string;
}

/**
 * 解析批注文件全文。刻意容错：字段顺序、列表符号（- * +）、未知字段、多余说明都能接受。
 * 旧格式（状态 / 内容 / 回复）读进来转成对话：内容 → 第一条消息，回复 → Agent 消息，状态忽略。
 */
export function parseCommentFileData(text: string): CommentFileData {
  const comments: WtComment[] = [];
  const rejected: string[] = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let current: ParsingComment | null = null;
  let lastField: ContinuableField | null = null;
  let inRejected = false;

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
      case "message": {
        const last = current.messages[current.messages.length - 1];
        if (last) last.text += value;
        break;
      }
      case "legacyContent":
        current.legacyContent += value;
        break;
      case "legacyReply":
        current.legacyReply += value;
        break;
    }
  };

  const flush = () => {
    if (!current) return;
    // 块与块之间的空行会被当作续行计入，收尾时清掉末尾多余换行
    const c = current;
    const messages: CommentMessage[] = [];
    const legacyContent = trimLineBreaks(c.legacyContent);
    if (legacyContent.trim()) messages.push({ by: c.origin, text: legacyContent });
    for (const m of c.messages) {
      const text = trimLineBreaks(m.text);
      if (text.trim()) messages.push({ by: m.by, text });
    }
    const legacyReply = trimLineBreaks(c.legacyReply);
    if (legacyReply.trim()) messages.push({ by: "agent", text: legacyReply });
    const comment: WtComment = {
      id: c.id,
      origin: c.origin,
      quote: trimLineBreaks(c.quote),
      paragraph: trimLineBreaks(c.paragraph),
      paragraphHint: c.paragraphHint,
      lineHint: c.lineHint,
      createdAt: c.createdAt,
      messages,
      current: trimLineBreaks(c.current),
      ...(c.gone ? { gone: true } : {}),
    };
    if (
      comment.quote.trim() !== "" ||
      comment.paragraph.trim() !== "" ||
      messages.length > 0
    ) {
      comments.push(comment);
    }
    current = null;
    lastField = null;
  };

  for (const raw of lines) {
    const header = HEADER_RE.exec(raw);
    if (header) {
      flush();
      inRejected = false;
      current = {
        id: Number(header[1]),
        origin: "author",
        quote: "",
        paragraph: "",
        paragraphHint: 0,
        lineHint: 0,
        createdAt: "",
        messages: [],
        current: "",
        legacyContent: "",
        legacyReply: "",
      };
      continue;
    }
    if (REJECTED_HEAD_RE.test(raw)) {
      flush();
      inRejected = true;
      continue;
    }
    if (inRejected) {
      const item = LIST_ITEM_RE.exec(raw);
      if (item) {
        const line = item[1].trim();
        if (line) rejected.push(line);
      } else if (raw.trim() && /^(?: {2,}|\t+)/.test(raw) && rejected.length > 0) {
        // 缩进续行：拼回上一行（「已否决」每条只占一行）
        rejected[rejected.length - 1] += " " + raw.trim();
      }
      continue;
    }
    if (!current) continue;

    const field = FIELD_RE.exec(raw);
    const label = field?.[1].trim() ?? "";
    const speaker = field ? speakerOf(label) : null;
    if (field && speaker) {
      current.messages.push({ by: speaker, text: field[2] ?? "" });
      lastField = "message";
      continue;
    }
    if (field && KNOWN_LABELS.has(label)) {
      const value = field[2] ?? "";
      lastField = null;
      switch (label) {
        case "发起":
          current.origin = speakerOf(value.trim()) ?? "author";
          break;
        case "状态":
          // 旧格式字段：轮到谁由对话推出，这里忽略
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
        case "原文已删除":
          current.gone = /是|true|yes/i.test(value);
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
          current.legacyContent = value;
          lastField = "legacyContent";
          break;
        case "回复":
          current.legacyReply = value;
          lastField = "legacyReply";
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
  return { comments, rejected };
}

/** 只要批注列表时用（定位、诊断等）。 */
export function parseCommentFile(text: string): WtComment[] {
  return parseCommentFileData(text).comments;
}

/* ---------- 给 Agent 的现成指令 ---------- */

/**
 * 「复制批注指令」：请 Agent 通读全文、发起批注。
 * 文章已有批注时同样适用，Agent 只补新的。
 */
export function buildReviewPrompt(
  docPath: string,
  counts?: { open: number; rejected: number }
): string {
  const base = docBaseName(docPath);
  const sidecar = sidecarPathFor(docPath);
  const existing =
    counts && (counts.open > 0 || counts.rejected > 0)
      ? `批注文件里已有 ${counts.open} 条进行中的批注${
          counts.rejected > 0 ? `、${counts.rejected} 条已否决的意见` : ""
        }：同一处已有批注的，在那条里追加消息，不要新开；已否决的意见不要再提。`
      : "";
  return [
    `请通读《${base}》，把你的修改意见逐条写成批注，写进「${sidecar}」（没有就新建）。`,
    ``,
    `格式和规则以批注文件开头的说明为准（新建文件时照下面写）：`,
    `1. 每处意见一条：「### 批注 N」下依次写「- 发起：Agent」「- 原文：……」「- 段落：……」「- 位置：第 X 段 · 约第 Y 行」「- 创建：YYYY-MM-DD HH:mm」「- Agent：意见」；`,
    `2. 「原文」必须从《${base}》逐字复制，取一句里有区分度的短片段；「段落」照抄所在整段；`,
    `3. 这一轮只提意见，不要修改《${base}》；`,
    `4. 已有批注定位时先找「现文」，找不到再找「原文」；都找不到也不要改写它们；`,
    ...(existing ? [`5. ${existing}`] : []),
  ].join("\n");
}

/** 「复制回复指令」：请 Agent 回复所有轮到它的批注。 */
export function buildReplyPrompt(docPath: string, waiting: number): string {
  const base = docBaseName(docPath);
  const sidecar = sidecarPathFor(docPath);
  return [
    `请处理「${sidecar}」里轮到你的批注（目前 ${waiting} 条：最后一条消息是「作者」的那些）。`,
    ``,
    `1. 只回复这些批注，在每条末尾追加一行「- Agent：……」；其他批注、已有消息、「已否决」一律不动；`,
    `2. 讨论中只在消息里给改写方案，不要修改《${base}》；`,
    `3. 作者明确要求改（如「改」「就这样改」）的，修改《${base}》，把改完后该处的文字覆盖进「现文」，再追加一条 Agent 消息说明改了什么；`,
    `4. 定位时先找「现文」（作者自己改过的地方插件会写回），找不到再找「原文」；都找不到就在回复里说明，不要改写「原文」「段落」去指向别的句子；`,
    `5. 不要新开批注，不要删除批注条目，不要添加状态字段。`,
  ].join("\n");
}
