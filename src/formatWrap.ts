/**
 * 行内格式切换的核心逻辑（纯函数，不 import Obsidian / CodeMirror，方便单测）。
 *
 * 六种格式（与「编辑工具条」一致）：
 *   加粗 **文字** ｜ 斜体 *文字* ｜ 高亮 ==文字== ｜
 *   删除线 ~~文字~~ ｜ 下划线 <u>文字</u> ｜ 字色 <span style="color: #hex">文字</span>
 *
 * 切换语义（对每段选区单独计算，多光标时逐段应用）：
 * - 选区两侧已带成对标记（含标记被一起选中的情况）→ 摘掉标记（再点一次即取消）；
 * - 其余情况 → 包上标记，选区保持在正文文字上，方便接着加别的格式；
 * - 空光标：恰好夹在一对标记中间 → 删掉整对；否则插入一对，光标停在中间。
 *
 * 返回值里的 changes 是原文档坐标下的一或两段连续改动；
 * selFrom / selTo 是应用这些改动后（新文档坐标）的新选区。
 */

export type FormatKind = "bold" | "italic" | "highlight" | "strike" | "underline" | "color";

export interface FormatChange {
  from: number;
  to: number;
  insert: string;
}

export interface ToggleResult {
  changes: FormatChange[];
  selFrom: number;
  selTo: number;
}

export interface FormatColor {
  /** 中文色名，用于按钮提示 */
  name: string;
  hex: string;
}

/** 色板：正文纸上的中彩度色，浅色主题下都看得清 */
export const FORMAT_COLORS: FormatColor[] = [
  { name: "红", hex: "#c94f4f" },
  { name: "橙", hex: "#c77d2e" },
  { name: "绿", hex: "#3d8b4f" },
  { name: "蓝", hex: "#3f72c8" },
  { name: "紫", hex: "#8a5bd6" },
  { name: "灰", hex: "#8a8378" },
];

export const DEFAULT_FORMAT_COLOR = FORMAT_COLORS[0].hex;

export const FORMAT_LABELS: Record<FormatKind, string> = {
  bold: "加粗",
  italic: "斜体",
  highlight: "高亮",
  strike: "删除线",
  underline: "下划线",
  color: "字色",
};

/** 工具条按钮顺序 */
export const FORMAT_BUTTON_ORDER: FormatKind[] = [
  "bold",
  "italic",
  "underline",
  "strike",
  "highlight",
  "color",
];

interface MarkerSpec {
  open: string;
  close: string;
}

const MARKERS: Record<Exclude<FormatKind, "color">, MarkerSpec> = {
  bold: { open: "**", close: "**" },
  italic: { open: "*", close: "*" },
  highlight: { open: "==", close: "==" },
  strike: { open: "~~", close: "~~" },
  underline: { open: "<u>", close: "</u>" },
};

/** 是否为「同一字符重复」的记号（*、**、==、~~；<u>/</u> 不是） */
function isRepeatedCharMarker(spec: MarkerSpec): boolean {
  return spec.open === spec.close && spec.open === spec.open[0].repeat(spec.open.length);
}

/** 选区两侧连续同一符号的层数（*** 即 3 层星号）。 */
function countMarkerRun(
  doc: string,
  from: number,
  to: number,
  ch: string
): { before: number; after: number } {
  let before = 0;
  while (from - before - 1 >= 0 && doc[from - before - 1] === ch) before++;
  let after = 0;
  while (to + after < doc.length && doc[to + after] === ch) after++;
  return { before, after };
}

/**
 * 记号层数是否够得上这种格式：
 * 单星斜体只认奇数层——`**` 是加粗、`***` 是加粗+斜体、`****` 又是加粗；
 * `**` / `==` / `~~` 这类双字符记号够需要的层数即可。
 */
function layerMatch(runLen: number, L: number): boolean {
  return L === 1 ? runLen % 2 === 1 : runLen >= L;
}

interface MarkerEdges {
  openIn: boolean;
  closeIn: boolean;
  openOut: boolean;
  closeOut: boolean;
}

/** 选区的四个边缘分别有没有该格式的记号（选区内侧 / 紧贴选区外侧）。 */
function markerEdges(doc: string, from: number, to: number, spec: MarkerSpec): MarkerEdges {
  const { open, close } = spec;
  const L = open.length;
  const R = close.length;
  const text = doc.slice(from, to);
  const textLen = text.length;

  if (isRepeatedCharMarker(spec)) {
    // 重复符号：按层数判定，避免把 ** 的星号当成斜体层
    const run = countMarkerRun(doc, from, to, open[0]);
    let inStart = 0;
    while (inStart < textLen && text[inStart] === open[0]) inStart++;
    let inEnd = 0;
    while (inEnd < textLen && text[textLen - 1 - inEnd] === open[0]) inEnd++;
    return {
      openIn: layerMatch(inStart, L),
      closeIn: layerMatch(inEnd, R),
      openOut: layerMatch(run.before, L),
      closeOut: layerMatch(run.after, R),
    };
  }

  return {
    openIn: textLen >= L + R && text.startsWith(open),
    closeIn: textLen >= L + R && text.endsWith(close),
    openOut: from >= L && doc.slice(from - L, from) === open,
    closeOut: doc.slice(to, to + R) === close,
  };
}

/** 字色标签统一用这个写法（统计剥离、再点取消都按同一形状识别） */
function colorTag(hex: string): string {
  return `<span style="color: ${hex}">`;
}

function sameColor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 切换主入口：doc 传全文，from/to 是选区；color 时从 colorHex 取色。 */
export function computeToggle(
  doc: string,
  from: number,
  to: number,
  kind: FormatKind,
  colorHex?: string
): ToggleResult {
  if (kind === "color") {
    return toggleColor(doc, from, to, colorHex ?? DEFAULT_FORMAT_COLOR);
  }
  return toggleMarker(doc, from, to, MARKERS[kind]);
}

function toggleMarker(doc: string, from: number, to: number, spec: MarkerSpec): ToggleResult {
  const { open, close } = spec;
  const L = open.length;
  const R = close.length;
  const text = doc.slice(from, to);
  const textLen = text.length;
  const edges = markerEdges(doc, from, to, spec);

  if (textLen === 0) {
    // 空光标：夹在一对标记中间 → 删掉一层（保留下面的其它层）；否则插入一对，光标停中间
    if (edges.openOut && edges.closeOut) {
      return {
        changes: [{ from: from - L, to: to + R, insert: "" }],
        selFrom: from - L,
        selTo: from - L,
      };
    }
    return {
      changes: [{ from, to, insert: open + close }],
      selFrom: from + L,
      selTo: from + L,
    };
  }

  if ((edges.openIn || edges.openOut) && (edges.closeIn || edges.closeOut)) {
    // 两侧都有标记：摘掉这一层，选中原来的正文文字
    const coreFrom = edges.openIn ? from + L : from;
    const coreTo = edges.closeIn ? to - R : to;
    const spanFrom = edges.openIn ? from : from - L;
    const spanTo = edges.closeIn ? to : to + R;
    const core = doc.slice(coreFrom, coreTo);
    return {
      changes: [{ from: spanFrom, to: spanTo, insert: core }],
      selFrom: spanFrom,
      selTo: spanFrom + core.length,
    };
  }

  // 其余情况一律视为「要加格式」：包一层，选区仍留在正文文字上
  return {
    changes: [{ from, to, insert: open + text + close }],
    selFrom: from + L,
    selTo: from + L + textLen,
  };
}

function toggleColor(doc: string, from: number, to: number, hex: string): ToggleResult {
  const newTag = colorTag(hex);
  const text = doc.slice(from, to);
  const textLen = text.length;

  if (textLen === 0) {
    return {
      changes: [{ from, to, insert: newTag + "</span>" }],
      selFrom: from + newTag.length,
      selTo: from + newTag.length,
    };
  }

  // 选区开头（或紧邻之前）是否有字色开始标签
  let tagFrom = -1;
  let tagTo = -1;
  let tagColor = "";
  const inside = text.match(/^<span style="color:\s*([^"]+?)">/);
  if (inside) {
    tagFrom = from;
    tagTo = from + inside[0].length;
    tagColor = inside[1];
  } else {
    const tail = doc.slice(Math.max(0, from - 96), from);
    const match = tail.match(/<span style="color:\s*([^"]+?)">$/);
    if (match) {
      tagFrom = from - match[0].length;
      tagTo = from;
      tagColor = match[1];
    }
  }

  const openLen = inside ? inside[0].length : 0;
  const closeInside = textLen >= openLen + 7 && text.endsWith("</span>");
  const closeOut = doc.slice(to, to + 7) === "</span>";
  const hasOpen = tagFrom >= 0;
  const hasClose = closeInside || closeOut;

  if (hasOpen && hasClose && sameColor(tagColor, hex)) {
    // 同色：整对摘掉（再点一次取消）
    const coreFrom = inside ? tagTo : from;
    const coreTo = closeInside ? to - 7 : to;
    const closeFrom = closeInside ? to - 7 : to;
    const closeTo = closeInside ? to : to + 7;
    const core = doc.slice(coreFrom, coreTo);
    return {
      changes: [
        { from: tagFrom, to: tagTo, insert: "" },
        { from: closeFrom, to: closeTo, insert: "" },
      ],
      selFrom: tagFrom,
      selTo: tagFrom + core.length,
    };
  }

  if (hasOpen) {
    // 已有字色（颜色不同，或没配到闭合标签）：只把开始标签换成新颜色
    const coreFrom = inside ? tagTo : from;
    const coreTo = closeInside ? to - 7 : to;
    const newCoreFrom = tagFrom + newTag.length;
    return {
      changes: [{ from: tagFrom, to: tagTo, insert: newTag }],
      selFrom: newCoreFrom,
      selTo: newCoreFrom + (coreTo - coreFrom),
    };
  }

  // 没有任何字色标签：包一层
  return {
    changes: [{ from, to, insert: newTag + text + "</span>" }],
    selFrom: from + newTag.length,
    selTo: from + newTag.length + textLen,
  };
}

/** 按六种标记的「成对规则」判断选区当前处于哪些格式之下（工具条点亮状态用）。 */
export function detectActiveKinds(doc: string, from: number, to: number): Set<FormatKind> {
  const active = new Set<FormatKind>();
  for (const kind of Object.keys(MARKERS) as Exclude<FormatKind, "color">[]) {
    const edges = markerEdges(doc, from, to, MARKERS[kind]);
    if ((edges.openIn || edges.openOut) && (edges.closeIn || edges.closeOut)) {
      active.add(kind);
    }
  }
  return active;
}

/** 选区当前的字色（取选区开头/紧邻之前的 span 颜色），没有则 null。 */
export function detectColorAt(doc: string, from: number, to: number): string | null {
  const text = doc.slice(from, to);
  if (text.length === 0) return null;
  const inside = text.match(/^<span style="color:\s*([^"]+?)">/);
  if (inside) return inside[1].trim();
  const tail = doc.slice(Math.max(0, from - 96), from);
  const match = tail.match(/<span style="color:\s*([^"]+?)">$/);
  return match ? match[1].trim() : null;
}

/* ---------- 字数统计前的剥离 ---------- */

const HTML_TAG_RE = /<\/?(?:u|span|font|mark|br|div|center|p|sub|sup)(?:\s[^<>]*)?>/gi;
const BOLD_PAIR_RE = /\*\*(.*?)\*\*/gs;
const STRIKE_PAIR_RE = /~~(.*?)~~/gs;
const HIGHLIGHT_PAIR_RE = /==(.*?)==/gs;
// 斜体：星号后面必须紧贴非空白、非星号字符，避免把 `* * *` 场景分隔线
//（作者手写的内容）和 `* 列表项` 误当成斜体剥掉
const ITALIC_PAIR_RE = /\*([^\s*][^*\n]*?)\*/g;

/**
 * 从文本里剥离行内格式记号，供字数统计用，
 * 让加粗/斜体/高亮/删除线/下划线/字色不产生虚增字数。
 * 成对标记只去记号、保留内容；HTML 标签整体去掉。
 */
export function stripInlineFormatting(text: string): string {
  return text
    .replace(HTML_TAG_RE, "")
    .replace(BOLD_PAIR_RE, "$1")
    .replace(STRIKE_PAIR_RE, "$1")
    .replace(HIGHLIGHT_PAIR_RE, "$1")
    .replace(ITALIC_PAIR_RE, "$1");
}

/**
 * 「交稿载荷」处理：去掉每行行尾空白、收尾多余空行。
 *
 * 「一键复制纯净正文」（复制 → 粘贴到平台后台）与「读者手机预览」共用这一份处理，
 * 保证**预览到的就是粘出去的**；两处各写一套清洗逻辑迟早会漂移。
 */
export function cleanChapterText(text: string): string {
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}$/g, "\n");
}
