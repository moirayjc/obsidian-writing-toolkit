/**
 * 批注：数据模型、批注文件（`文档名.批注.md`）的解析与序列化、原文定位。
 *
 * 设计背景：作者的创作流程是「Agent 通读稿子发起一批批注 → 作者在
 * 面板里逐条回复 → Agent 再回一轮 → …… → 作者逐条点已解决 / 不采纳」。
 * 每条批注是一串对话，作者与 Agent 都能发起；结案只能由作者在面板里点。
 * Agent 不直接改正文：它在消息里附「修改建议」，作者点「采纳」才替换。
 * 批注存放在库根 `.wt-comments/` 下的独立伴随文件里（镜像正文的相对路径），
 * 正文一个字都不动。旧版同目录 `文档名.批注.md` 会自动迁移过来，读取时
 * 仍兼容旧位置。
 *
 * 定位（Agent 改稿后「原文」往往已经不在了）按四层来：
 *   1. 现文——作者改正文 / 采纳建议后插件写回的当前文字（最可靠）；
 *   2. 原文——精确匹配，其次是忽略空白的弹性匹配；
 *   3. 段内残余——用建批注时那一段里「原文前后还在的文字」夹出被改写的位置；
 *   4. 段落——整段文本匹配 / 相似度匹配（结合段落序号就近取舍）。
 * 四层都不中时返回 null，界面上标「锚点失效」，用户可以手动重新绑定。
 *
 * 本模块是纯逻辑（不依赖 Obsidian API），方便单测。
 */
import {
  SIDECAR_FOLDERS,
  otherLocation,
  sidecarFolder,
  sidecarFoldersOf,
} from "./sidecarLocation";

/** 说话人：作者 / Agent */
export type CommentSpeaker = "author" | "agent";

/**
 * Agent 消息附带的修改建议：「把正文里的 original 改成 replacement」。
 * Agent 不直接改正文，由作者在面板里点「采纳」，插件在编辑器里替换。
 */
export interface CommentSuggestion {
  /** 要替换的正文；空串 = 这条批注现在圈住的文字 */
  original: string;
  /** 改成什么；空串 = 删掉 */
  replacement: string;
  /** 作者已采纳（插件写入，留给 Agent 下一轮看） */
  adopted: boolean;
}

/** 对话里的一条消息 */
export interface CommentMessage {
  by: CommentSpeaker;
  text: string;
  /** 只有 Agent 的消息才可能带 */
  suggestion?: CommentSuggestion;
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
   * 现文：这处原文现在的样子。作者在编辑器里改正文、采纳建议时由插件写回
   * （Agent 不改正文，也不写它）；定位时最优先。
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
        (m, i) =>
          next.messages[i].by === m.by &&
          next.messages[i].text === m.text &&
          sameSuggestion(m.suggestion, next.messages[i].suggestion)
      );
    if (!kept) altered.push(old);
  }
  return { removed, altered };
}

/** 建议内容没被改（「已采纳」只由插件改，不算越权）。 */
function sameSuggestion(
  a: CommentSuggestion | undefined,
  b: CommentSuggestion | undefined
): boolean {
  if (!a || !b) return !a && !b;
  return a.original === b.original && a.replacement === b.replacement;
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

/**
 * 隐藏档的批注目录（镜像正文路径，和 `.wt-outlines` / `.wt-snapshots` 同级）。
 * 当前实际用哪个目录看存放位置设置：一律用 commentsFolder()，别直接用这个常量拼路径。
 */
export const COMMENTS_FOLDER = SIDECAR_FOLDERS.hidden.comments;

/** 当前存放位置下的批注目录。 */
export function commentsFolder(): string {
  return sidecarFolder("comments");
}

/** 路径在哪个批注目录下（两档都认）；不在任何一个下返回 null。 */
function commentsFolderOf(path: string): string | null {
  return sidecarFoldersOf("comments").find((f) => path.startsWith(`${f}/`)) ?? null;
}

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
  return `${commentsFolder()}/${docPath.replace(/\.md$/i, ".批注.md")}`;
}

/**
 * 另一档存放位置下的批注文件路径（两台设备选得不一样时，数据可能还在那边）。
 * 只用于读取兜底，不往那里写新文件。
 */
export function otherSidecarPathFor(docPath: string): string {
  const folder = sidecarFolder("comments", otherLocation());
  return `${folder}/${docPath.replace(/\.md$/i, ".批注.md")}`;
}

/** 旧版同目录批注文件路径（只用于迁移与兼容读取）。 */
export function legacySidecarPathFor(docPath: string): string {
  if (isSidecarPath(docPath)) return docPath;
  return docPath.replace(/\.md$/i, ".批注.md");
}

/** 是否是旧版「正文同目录」的批注文件。 */
export function isLegacySidecarPath(path: string): boolean {
  return isSidecarPath(path) && commentsFolderOf(path) === null;
}

/** 批注文件路径 → 源文档路径。新旧两种布局都认。 */
export function docPathForSidecar(sidecarPath: string): string {
  const folder = commentsFolderOf(sidecarPath);
  const rel = folder ? sidecarPath.slice(folder.length + 1) : sidecarPath;
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

/* ---------- 修改建议 ---------- */

/** 正文里某段文字的所有出现位置（批注工具校验「逐字存在且只出现一次」用）。 */
export function findOccurrences(docText: string, needle: string): number[] {
  return findAll(docText, needle);
}

/**
 * 最新一条带建议的消息下标；没有返回 -1。
 * 只有它能采纳，更早的建议算「已被新建议取代」。
 */
export function latestSuggestionIndex(
  comment: Pick<WtComment, "messages">
): number {
  for (let i = comment.messages.length - 1; i >= 0; i--) {
    if (comment.messages[i].suggestion) return i;
  }
  return -1;
}

/** 建议采纳不了的原因 */
export type SuggestionProblem = "missing" | "ambiguous";

export const SUGGESTION_PROBLEM_LABELS: Record<SuggestionProblem, string> = {
  missing: "这处已经改过，建议过期了",
  ambiguous: "正文里有多处相同的文字，无法确定改哪一处",
};

export type SuggestionTarget =
  | { from: number; to: number }
  | { problem: SuggestionProblem };

/**
 * 建议要替换的正文区间。
 * 写了「建议原句」：正文里逐字找，只出现一次才算数；出现多次时只看批注所在的那一段。
 * 没写：替换批注现在圈住的文字（必须是按现文 / 原文精确命中的，迁移定位不算）。
 */
export function suggestionTarget(
  docText: string,
  comment: WtComment,
  suggestion: CommentSuggestion
): SuggestionTarget {
  const anchor = new AnchorLocator(docText).locate(comment);
  const original = suggestion.original;
  if (!original) {
    if (
      !anchor ||
      (anchor.via !== "present" && anchor.via !== "exact") ||
      anchor.to <= anchor.from
    ) {
      return { problem: "missing" };
    }
    return { from: anchor.from, to: anchor.to };
  }
  const hits = findAll(docText, original);
  if (hits.length === 0) return { problem: "missing" };
  if (hits.length === 1) return { from: hits[0], to: hits[0] + original.length };
  if (anchor) {
    const paragraph = paragraphAt(docText, anchor.from);
    if (paragraph) {
      const inside = hits.filter(
        (at) => at < paragraph.to && at + original.length > paragraph.from
      );
      if (inside.length === 1) {
        return { from: inside[0], to: inside[0] + original.length };
      }
    }
  }
  return { problem: "ambiguous" };
}

/** 字级差异的一段：相同 / 删掉 / 新增 */
export interface DiffPiece {
  kind: "same" | "del" | "add";
  text: string;
}

/** 超过这个规模（中段字数之积）就不逐字比，整段算替换，免得卡界面。 */
const DIFF_CELL_LIMIT = 250_000;

/** 两段文字的字级差异（详情页显示建议用；按码点比，不拆代理对）。 */
export function diffChars(before: string, after: string): DiffPiece[] {
  const a = Array.from(before);
  const b = Array.from(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const pieces: DiffPiece[] = [];
  const push = (kind: DiffPiece["kind"], text: string) => {
    if (!text) return;
    const last = pieces[pieces.length - 1];
    if (last && last.kind === kind) last.text += text;
    else pieces.push({ kind, text });
  };
  push("same", a.slice(0, head).join(""));
  if (midA.length * midB.length > DIFF_CELL_LIMIT) {
    push("del", midA.join(""));
    push("add", midB.join(""));
  } else {
    // 最长公共子序列，从后往前回溯成删 / 增 / 同
    const n = midA.length;
    const m = midB.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () =>
      new Array<number>(m + 1).fill(0)
    );
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] =
          midA[i] === midB[j]
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        push("same", midA[i]);
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        // 同一处先删后增，读起来是「把 A 换成 B」
        push("del", midA[i]);
        i++;
      } else {
        push("add", midB[j]);
        j++;
      }
    }
  }
  push("same", a.slice(a.length - tail).join(""));
  return pieces;
}

/* ---------- 批注文件：序列化 ---------- */

/**
 * 批注文件抬头：写给 Agent 的协议（HTML 注释，阅读视图不显示）。
 * ⚠️ 与 parseCommentFileData 必须同改；多行示例不能删（历史上两者脱节导致整条批注被静默丢弃）。
 */
const SIDECAR_HELP_HEADER = [
  "<!-- 写作工具箱 · 批注文件",
  "这里是作者和 Agent 一起聊这篇作品的地方：说真实的感受和想法就好，用你自己的语气。下面只是让插件读得懂的格式约定。",
  "每条批注 = 一处原文 + 一串对话，对话一行一条：「- 作者：……」或「- Agent：……」，按出现顺序就是先后顺序。",
  "多于一行的消息，从第二行起每行缩进两格，例如：",
  "- Agent：第一点",
  "  第二点",
  "",
  "格式约定（能用「写作工具箱」的批注工具 / MCP 服务 writing-toolkit 时，请改用工具，不要直接编辑本文件）：",
  "1. 发起批注：在文件末尾（「## 已否决」之前）新增「### 批注 N」（N 取现有最大编号 + 1），依次写「- 发起：Agent」「- 原文：……」「- 段落：……」「- 位置：第 X 段 · 约第 Y 行」「- 创建：YYYY-MM-DD HH:mm」「- Agent：你想说的」。「原文」必须从源文档逐字复制，取一句里有区分度的短片段；「段落」照抄原文所在的整段。同一处已有批注时，在那条里追加消息，不要新开；不要重复提出「已否决」里的意见。",
  "2. 找位置：先在源文档里找「现文」（作者改正文时插件会自动写回），没有现文或找不到再找「原文」。都找不到就在回复里说明，绝不要改写「原文」「段落」「现文」去指向别的句子。有「- 原文已删除：是」的，说明作者已经删掉了那句，按「段落」理解上下文。",
  "3. 回复：只回复最后一条消息是「作者」的批注，在该条末尾追加一行「- Agent：……」。不要修改或删除任何已有消息，不要删除批注条目，不要改「已否决」。",
  "4. 改正文：请不要直接修改源文档。修改建议是可选的，大多数批注说感受和想法就够了；真想到了具体写法，就在你的 Agent 消息下面紧跟两行：「- 建议原句：……」（要替换的正文，从源文档逐字复制，在全文只出现一次；省略这一行表示替换这条批注圈住的文字）和「- 建议改为：……」（改成什么；留空表示删掉）。作者在插件里点「采纳」后，插件替换正文，并把那一行标成「建议改为（已采纳）」。",
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
      if (m.suggestion) {
        if (m.suggestion.original) {
          writeField(lines, "建议原句", m.suggestion.original);
        }
        writeField(
          lines,
          m.suggestion.adopted ? "建议改为（已采纳）" : "建议改为",
          m.suggestion.replacement
        );
      }
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

/** 建议两行的标签：「建议原句」与「建议改为」/「建议改为（已采纳）」 */
const SUGGEST_ORIGINAL_LABEL = "建议原句";
const SUGGEST_REPLACEMENT_RE = /^建议改为\s*(?:[（(]\s*(已采纳)\s*[）)])?$/;

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
  | "suggestOriginal"
  | "suggestReplacement"
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
  /** 写了「建议改为」的消息：只有「建议原句」没有「建议改为」的不算建议 */
  const withReplacement = new WeakSet<CommentMessage>();

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
      case "suggestOriginal":
      case "suggestReplacement": {
        const suggestion =
          current.messages[current.messages.length - 1]?.suggestion;
        if (!suggestion) break;
        if (field === "suggestOriginal") suggestion.original += value;
        else suggestion.replacement += value;
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
      const suggestion =
        m.suggestion && withReplacement.has(m)
          ? {
              original: trimLineBreaks(m.suggestion.original),
              replacement: trimLineBreaks(m.suggestion.replacement),
              adopted: m.suggestion.adopted,
            }
          : undefined;
      if (!text.trim() && !suggestion) continue;
      messages.push(suggestion ? { by: m.by, text, suggestion } : { by: m.by, text });
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
    const replacementLabel = field ? SUGGEST_REPLACEMENT_RE.exec(label) : null;
    if (field && (label === SUGGEST_ORIGINAL_LABEL || replacementLabel)) {
      const last = current.messages[current.messages.length - 1];
      // 建议只挂在 Agent 消息下；作者消息里碰巧有这样一行，照普通续行拼回去
      if (last && last.by === "agent") {
        const suggestion =
          last.suggestion ??
          (last.suggestion = { original: "", replacement: "", adopted: false });
        if (replacementLabel) {
          suggestion.replacement = field[2] ?? "";
          suggestion.adopted = Boolean(replacementLabel[1]);
          withReplacement.add(last);
          lastField = "suggestReplacement";
        } else {
          suggestion.original = field[2] ?? "";
          lastField = "suggestOriginal";
        }
        continue;
      }
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
 * Agent 怎么写批注：tools = 通过插件在本机提供的批注工具（MCP）；
 * file = 直接编辑批注文件（没开批注工具、或 Agent 接不了 MCP 时）。
 */
export type AgentChannel = "tools" | "file";

/** 本机批注工具在 Agent 那边登记的服务名（连接命令与指令里共用）。 */
export const AGENT_TOOLS_SERVER_NAME = "writing-toolkit";

/**
 * 两份指令的写法（2026-10-23 作者试用后调整）：先说想和 Agent 聊什么，规矩压到最后一小段。
 * 规矩写多了，Agent 会把批注当成一份照章办事的作业，只剩客观、机械的挑错；
 * 作者要的是有温度的共创者。格式上的硬要求交给工具当场校验（工具连接）或批注文件抬头（直接写文件），
 * 这里只点一句。修改建议是可选的：大多数批注说感受和想法就够了。
 */
const TOOLS_NOTE = `用「写作工具箱」的批注工具（MCP 服务 ${AGENT_TOOLS_SERVER_NAME}）：先 list_comments 看看已有的讨论，同一处就接着那条聊，我否决过的就别再提了；用 create_comment 留新批注，quote 从正文原样复制，工具不认的话会告诉你怎么调。没有这些工具的话先停下来告诉我，别直接改批注文件或正文。`;

const SUGGESTION_NOTE_TOOLS =
  "真想到了具体的写法，就在批注里附一个 suggestion（original 是要换掉的原文，原样复制；replacement 是你的写法），我来决定用不用；不想改的地方就只聊，不用硬给方案";

const SUGGESTION_NOTE_FILE =
  "真想到了具体的写法，就在你那条消息下面跟两行「- 建议原句：……」（原样复制要换掉的原文，省略就是这条批注圈住的那句）和「- 建议改为：……」，我来决定用不用；不想改的地方就只聊，不用硬给方案";

/** 两份指令共用的那段「想和你聊什么」 */
const REVIEW_INVITATION =
  `不用拘着，就像一位真正读进去了的朋友、也是懂行的编辑那样，把读的时候冒出来的念头留在正文旁边：被打动的地方、读着出戏的地方、人物让你在意的地方、你好奇的、你不同意的，都可以说；可以提问，可以夸，可以跟我争。用你自己的语气，像聊天一样就好。`;

/**
 * 「复制批注指令」：请 Agent 读全文、在正文旁边留批注。
 * 文章已有批注时同样适用，Agent 只补新的。
 */
export function buildReviewPrompt(
  docPath: string,
  counts?: { open: number; rejected: number },
  channel: AgentChannel = "file"
): string {
  const base = docBaseName(docPath).replace(/\.md$/i, "");
  const existing =
    counts && (counts.open > 0 || counts.rejected > 0)
      ? `这篇已经有 ${counts.open} 条在聊的批注${
          counts.rejected > 0 ? `、${counts.rejected} 条我否决过的意见` : ""
        }，先看一眼再动笔。`
      : "";
  const closing = `批注留完以后，回到这边跟我聊聊整篇给你的感觉，还有你最想和我讨论的一两件事。`;
  if (channel === "tools") {
    return [
      `想请你读一读《${base}》（库内路径：${docPath}）。`,
      ``,
      REVIEW_INVITATION,
      `${SUGGESTION_NOTE_TOOLS}。`,
      ``,
      closing,
      ``,
      `（${existing}${TOOLS_NOTE}）`,
    ].join("\n");
  }
  const sidecar = sidecarPathFor(docPath);
  return [
    `想请你读一读《${base}》。`,
    ``,
    REVIEW_INVITATION,
    `${SUGGESTION_NOTE_FILE}。`,
    ``,
    closing,
    ``,
    `（${existing}批注写进「${sidecar}」，格式照文件开头的说明；没有这个文件就新建，每条写成「### 批注 N」，下面依次是「- 发起：Agent」「- 原文：……」（从正文逐字复制）「- 段落：……」（原文所在整段）「- 位置：第 X 段 · 约第 Y 行」「- 创建：YYYY-MM-DD HH:mm」「- Agent：你想说的」。同一处已有批注就接着那条聊，我否决过的别再提；请不要直接改《${base}》。）`,
  ].join("\n");
}

/** 「复制回复指令」：请 Agent 接着聊轮到它的那些批注。 */
export function buildReplyPrompt(
  docPath: string,
  waiting: number,
  channel: AgentChannel = "file"
): string {
  const base = docBaseName(docPath).replace(/\.md$/i, "");
  const invitation = [
    `我在《${base}》的批注里回你了，现在有 ${waiting} 条在等你，去看看我说了什么，接着聊吧。`,
    ``,
    `想法不一样就直说，讲讲你的理由，也可以反问我；我说「改」的地方，就把你的写法附上，我来采纳。不必每条都给方案，像聊天一样回就好；读的时候有新冒出来的想法，也可以另开一条。`,
  ];
  if (channel === "tools") {
    return [
      ...invitation,
      ``,
      `（库内路径：${docPath}。用 list_comments 找轮到你的那些，reply_comment 回复，附写法就带上 suggestion；没有这些工具的话先停下来告诉我，别直接改批注文件或正文。）`,
    ].join("\n");
  }
  const sidecar = sidecarPathFor(docPath);
  return [
    ...invitation,
    ``,
    `（批注在「${sidecar}」：轮到你的是最后一条消息是「作者」的那些，在那条末尾加一行「- Agent：……」回复；附写法就在下面跟「- 建议原句」「- 建议改为」两行。已有的消息和条目请不要改、不要删；找位置先看「现文」再看「原文」，找不到就跟我说，别把它们改去指向别的句子；请不要直接改《${base}》。）`,
  ].join("\n");
}
