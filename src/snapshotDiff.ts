import { Editor, Modal, Notice, type App } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  copyTextToClipboard,
  pathBasename,
  type SnapshotOperations,
} from "./snapshot";
import { isHemingwayActive, setHemingway } from "./hemingway";
import { ConfirmModal } from "./promptModal";

export type DiffKind = "same" | "change";

/** Snapshot UI needs this narrow editor surface, not the plugin instance. */
export interface SnapshotDiffHost {
  readonly app: App;
  getEditor(): Editor | null;
  getActiveFilePath(): string | null;
  isEditorValid(editor: Editor): boolean;
  countWords(text: string): number;
  markProgrammaticEdit?(editor: Editor, text: string): void;
}

/** 一个非空行，以及它后面属于同一段的空行。 */
export interface TextUnit {
  body: string;
  lineNo: number;
  tailLines: string[];
  unitIndex: number;
  /** 该行在原文里的起始偏移（含） */
  start: number;
  /** 该行在原文里的结束偏移（不含，不含行尾换行） */
  end: number;
}

export interface TextStructure {
  leadingLines: string[];
  units: TextUnit[];
}

/**
 * 一次连续改写。左右各自保留整段原文，不再把无关段落强行配成「修改」。
 */
export interface DiffBlock {
  kind: DiffKind;
  left: TextUnit[];
  right: TextUnit[];
}

/** 纯文本偏移区间：高亮只记偏移，不往正文里塞标记。 */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * 一次对比需要标色的四类区间。
 *
 * 拆成四个数组而不是「左右各一组」，是因为两侧的颜色含义不同：
 * 左栏只有「被删」和「被改写」，右栏只有「新增」和「被改写」。
 */
export interface DiffSpans {
  leftDeleted: TextSpan[];
  leftChanged: TextSpan[];
  rightAdded: TextSpan[];
  rightChanged: TextSpan[];
}

export interface DiffView {
  blocks: DiffBlock[];
  spans: DiffSpans;
  /** 连续改动块数量 */
  changeCount: number;
  /** 旧稿里参与改动的段数 */
  oldUnits: number;
  /** 新稿里参与改动的段数 */
  newUnits: number;
}

const MAX_DIFF_CELLS = 4_000_000;

function isBlankLine(line: string): boolean {
  return line.trim() === "";
}

/**
 * 空行只作为段落间隔保存，不参与对齐。
 * 真实数据里两版可能句句都改过，但空行处处相同；把空行当 LCS 锚点会让
 * 所有正文段落按位置硬配对，正是旧版「右边全空 / 后半段乱配」的来源。
 */
export function parseTextStructure(text: string): TextStructure {
  const lines = text.split("\n");
  const leadingLines: string[] = [];
  let i = 0;
  let offset = 0;
  while (i < lines.length && isBlankLine(lines[i])) {
    leadingLines.push(lines[i]);
    offset += lines[i].length + 1;
    i++;
  }

  const units: TextUnit[] = [];
  while (i < lines.length) {
    const body = lines[i];
    const start = offset;
    const end = start + body.length;
    const lineNo = i + 1;
    offset = end + 1; // 跳过行尾换行
    i++;
    const tailLines: string[] = [];
    while (i < lines.length && isBlankLine(lines[i])) {
      tailLines.push(lines[i]);
      offset += lines[i].length + 1;
      i++;
    }
    units.push({
      body,
      lineNo,
      tailLines,
      unitIndex: units.length,
      start,
      end,
    });
  }
  return { leadingLines, units };
}

function unitKey(unit: TextUnit): string {
  // 行尾空格不算正文变化；行首缩进仍保留（代码块、列表等依赖它）。
  return unit.body.trimEnd();
}

function sameBlock(left: TextUnit, right: TextUnit): DiffBlock {
  return { kind: "same", left: [left], right: [right] };
}

/**
 * 先对齐完全相同的非空行，再把每个连续改动区作为一个整体。
 *
 * 关键约束：改动区内部不再按位置逐行配对。旧稿 40 段、新稿 13 段时，
 * 整块左右并列显示即可；强行两两合并只会制造虚假的「修改」。
 */
function diffUnits(a: TextUnit[], b: TextUnit[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let start = 0;
  while (
    start < a.length &&
    start < b.length &&
    unitKey(a[start]) === unitKey(b[start])
  ) {
    blocks.push(sameBlock(a[start], b[start]));
    start++;
  }

  let endA = a.length;
  let endB = b.length;
  while (
    endA > start &&
    endB > start &&
    unitKey(a[endA - 1]) === unitKey(b[endB - 1])
  ) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > 0 || midB.length > 0) {
    if (midA.length * midB.length > MAX_DIFF_CELLS) {
      blocks.push({ kind: "change", left: midA, right: midB });
    } else {
      const n = midA.length;
      const m = midB.length;
      const dp: Uint32Array[] = Array.from(
        { length: n + 1 },
        () => new Uint32Array(m + 1)
      );
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] =
            unitKey(midA[i]) === unitKey(midB[j])
              ? dp[i + 1][j + 1] + 1
              : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }

      let i = 0;
      let j = 0;
      let changeLeft: TextUnit[] = [];
      let changeRight: TextUnit[] = [];
      const flushChange = () => {
        if (changeLeft.length === 0 && changeRight.length === 0) return;
        blocks.push({ kind: "change", left: changeLeft, right: changeRight });
        changeLeft = [];
        changeRight = [];
      };
      while (i < n && j < m) {
        if (unitKey(midA[i]) === unitKey(midB[j])) {
          flushChange();
          blocks.push(sameBlock(midA[i], midB[j]));
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          changeLeft.push(midA[i]);
          i++;
        } else {
          changeRight.push(midB[j]);
          j++;
        }
      }
      while (i < n) changeLeft.push(midA[i++]);
      while (j < m) changeRight.push(midB[j++]);
      flushChange();
    }
  }

  for (let k = 0; endA + k < a.length; k++) {
    blocks.push(sameBlock(a[endA + k], b[endB + k]));
  }
  return blocks;
}

/** 字符级差异：标记两侧各自需要高亮的字符位置。 */
function charDiff(
  a: string,
  b: string
): { left: boolean[]; right: boolean[] } | null {
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) return null;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const left = new Array<boolean>(n).fill(true);
  const right = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left[i] = false;
      right[j] = false;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { left, right };
}

/** 把布尔标记压成连续区间，并整体平移到原文偏移。 */
function spansFromMarks(marks: boolean[], offset: number): TextSpan[] {
  const spans: TextSpan[] = [];
  let runStart = -1;
  for (let k = 0; k < marks.length; k++) {
    if (marks[k]) {
      if (runStart < 0) runStart = k;
    } else if (runStart >= 0) {
      spans.push({ start: offset + runStart, end: offset + k });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    spans.push({ start: offset + runStart, end: offset + marks.length });
  }
  return spans;
}

/** 连续若干段的整段区间；空数组返回 null。 */
function spanOfUnits(units: TextUnit[]): TextSpan | null {
  if (units.length === 0) return null;
  return {
    start: units[0].start,
    end: units[units.length - 1].end,
  };
}

/**
 * 一次对比的完整结果：对齐块（用于统计改动处数）+ 四类高亮区间。
 *
 * 只有「左右各一段」时才做字符级收窄——多段并列时整块标色更诚实，
 * 强行逐字对齐只会把不相关的句子配在一起。
 */
export function diffView(
  snapshotText: string,
  currentText: string
): DiffView {
  const leftUnits = parseTextStructure(snapshotText).units;
  const rightUnits = parseTextStructure(currentText).units;
  const blocks = diffUnits(leftUnits, rightUnits);

  const spans: DiffSpans = {
    leftDeleted: [],
    leftChanged: [],
    rightAdded: [],
    rightChanged: [],
  };
  let changeCount = 0;
  let oldUnits = 0;
  let newUnits = 0;

  for (const block of blocks) {
    if (block.kind !== "change") continue;
    changeCount++;
    oldUnits += block.left.length;
    newUnits += block.right.length;

    const leftKind: "del" | "chg" = block.right.length === 0 ? "del" : "chg";
    const rightKind: "add" | "chg" = block.left.length === 0 ? "add" : "chg";

    const singlePair =
      block.left.length === 1 && block.right.length === 1
        ? charDiff(block.left[0].body, block.right[0].body)
        : null;

    if (singlePair) {
      const leftSpans = spansFromMarks(singlePair.left, block.left[0].start);
      const rightSpans = spansFromMarks(
        singlePair.right,
        block.right[0].start
      );
      pushSpans(spans, leftKind === "del" ? "leftDeleted" : "leftChanged", leftSpans);
      pushSpans(
        spans,
        rightKind === "add" ? "rightAdded" : "rightChanged",
        rightSpans
      );
      continue;
    }

    const leftSpan = spanOfUnits(block.left);
    const rightSpan = spanOfUnits(block.right);
    if (leftSpan) {
      pushSpans(
        spans,
        leftKind === "del" ? "leftDeleted" : "leftChanged",
        [leftSpan]
      );
    }
    if (rightSpan) {
      pushSpans(
        spans,
        rightKind === "add" ? "rightAdded" : "rightChanged",
        [rightSpan]
      );
    }
  }

  return { blocks, spans, changeCount, oldUnits, newUnits };
}

function pushSpans(
  spans: DiffSpans,
  key: keyof DiffSpans,
  items: TextSpan[]
): void {
  for (const item of items) {
    if (item.end > item.start) spans[key].push(item);
  }
}

/** 供界面和检查脚本共用的入口：空行不参与 diff。 */
export function diffSnapshotBlocks(
  snapshotText: string,
  currentText: string
): DiffBlock[] {
  return diffView(snapshotText, currentText).blocks;
}

/** 供界面和检查脚本共用的入口：四类高亮区间。 */
export function diffHighlightSpans(
  snapshotText: string,
  currentText: string
): DiffSpans {
  return diffView(snapshotText, currentText).spans;
}

/* ────────────────────────── 高亮（不污染 DOM） ────────────────────────── */

/** CSS Custom Highlight API 的窄接口：lib.dom 只声明了 forEach，这里按需收窄。 */
interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

type HighlightCtor = new (...ranges: Range[]) => unknown;

function highlightApi(root: HTMLElement): {
  registry: HighlightRegistryLike;
  ctor: HighlightCtor;
} | null {
  // 用元素所属窗口而不是 globalThis：Obsidian 的弹出窗口（popout）各有自己的
  // window 与 CSS.highlights，注册到主窗口上不会生效。
  const view = root.ownerDocument.defaultView as
    | (Window & {
        CSS?: { highlights?: HighlightRegistryLike };
        Highlight?: HighlightCtor;
      })
    | null;
  const registry = view?.CSS?.highlights;
  const ctor = view?.Highlight;
  if (!registry || typeof ctor !== "function") return null;
  return { registry, ctor };
}

/** 把纯文本偏移区间映射成 DOM Range：逐文本节点切分，不拆分节点。 */
function rangesFromSpans(root: HTMLElement, spans: TextSpan[]): Range[] {
  if (spans.length === 0) return [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }

  const out: Range[] = [];
  let offset = 0;
  for (const textNode of nodes) {
    const length = textNode.nodeValue?.length ?? 0;
    const nodeStart = offset;
    const nodeEnd = offset + length;
    for (const span of spans) {
      const from = Math.max(span.start, nodeStart);
      const to = Math.min(span.end, nodeEnd);
      if (from < to) {
        const range = doc.createRange();
        range.setStart(textNode, from - nodeStart);
        range.setEnd(textNode, to - nodeStart);
        out.push(range);
      }
    }
    offset = nodeEnd;
  }
  return out;
}

/** 四类高亮在 CSS.highlights 里的注册名（styles.css 的 ::highlight() 必须一致）。 */
export const HIGHLIGHT_NAMES = {
  leftDeleted: "wt-diff-left-del",
  leftChanged: "wt-diff-left-chg",
  rightAdded: "wt-diff-right-add",
  rightChanged: "wt-diff-right-chg",
} as const;

function applyHighlight(
  root: HTMLElement,
  name: string,
  spans: TextSpan[]
): void {
  const api = highlightApi(root);
  if (!api) return;
  const ranges = rangesFromSpans(root, spans);
  if (ranges.length === 0) {
    api.registry.delete(name);
    return;
  }
  api.registry.set(name, new api.ctor(...ranges));
}

function clearHighlights(root: HTMLElement): void {
  const api = highlightApi(root);
  if (!api) return;
  for (const name of Object.values(HIGHLIGHT_NAMES)) {
    api.registry.delete(name);
  }
}

/* ────────────────────────── 写回与恢复 ────────────────────────── */

/**
 * 打开「快照 vs 当前」对比弹窗（右侧可直接编辑）。
 * host 是快照模块的窄编辑器端口：通过最近活动文件信息工作，
 * 不依赖当前焦点（点击侧栏后 workspace 的活动文件会变成侧栏视图）。
 */
export function showSnapshotDiff(
  host: SnapshotDiffHost,
  operations: SnapshotOperations,
  sourcePath: string,
  snapshotPath: string,
  snapshotName: string,
  onChanged: () => void
): void {
  void (async () => {
    const editor = host.getEditor();
    if (
      host.getActiveFilePath() !== sourcePath ||
      !editor ||
      !host.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：当前没有可对比的活动文件（文件可能已关闭，请重新打开）");
      return;
    }
    const current = editor.getValue();
    let snapshot = "";
    try {
      snapshot = await operations.readSnapshot(snapshotPath);
    } catch (e) {
      new Notice(`写作工具箱：读取快照失败：${String(e)}`);
      return;
    }
    if (
      host.getActiveFilePath() !== sourcePath ||
      host.getEditor() !== editor ||
      !host.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：活动文件已切换，请重新打开对比");
      return;
    }
    if (editor.getValue() !== current) {
      new Notice("写作工具箱：文档内容已变化，请重新打开对比");
      return;
    }
    new SnapshotDiffModal(
      host,
      operations,
      sourcePath,
      snapshotPath,
      snapshotName,
      current,
      snapshot,
      onChanged
    ).open();
  })();
}

/** 执行恢复：先备份当前内容，再把快照内容写回编辑器（可撤销）。返回是否成功。 */
export async function performRestore(
  host: SnapshotDiffHost,
  operations: SnapshotOperations,
  sourcePath: string,
  snapshotPath: string,
  baselineText?: string
): Promise<boolean> {
  const editor = host.getEditor();
  if (
    host.getActiveFilePath() !== sourcePath ||
    !editor ||
    !host.isEditorValid(editor)
  ) {
    new Notice("写作工具箱：当前没有可恢复的活动文件（文件可能已关闭，请重新打开）");
    return false;
  }
  try {
    const currentText = editor.getValue();
    if (baselineText !== undefined && currentText !== baselineText) {
      new Notice("写作工具箱：文档在对比期间已被修改，请重新打开对比后再恢复");
      return false;
    }
    await operations.snapshotFileSilently(sourcePath, currentText);
    const content = await operations.readSnapshot(snapshotPath);
    if (
      host.getActiveFilePath() !== sourcePath ||
      host.getEditor() !== editor ||
      !host.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：活动文件已切换，请重新执行恢复");
      return false;
    }
    if (editor.getValue() !== currentText) {
      new Notice("写作工具箱：文档内容已变化，请重新执行恢复");
      return false;
    }
    host.markProgrammaticEdit?.(editor, content);
    replaceEditorText(editor, content);
    new Notice(`写作工具箱：已恢复为 ${pathBasename(snapshotPath)}（Ctrl+Z 可撤销）`);
    return true;
  } catch (e) {
    new Notice(`写作工具箱：恢复失败：${String(e)}`);
    return false;
  }
}

/**
 * 把内容写回编辑器：先静默备份当前状态，再替换（可撤销）。返回是否成功。
 *
 * baselineText 是「上次成功写回后文档的内容」：如果此刻编辑器里的内容已经和它不同，
 * 说明文档被别处改过（另一个窗口、同步、外部脚本），直接写回会覆盖那些改动，
 * 所以拒绝写入并提示重新打开对比。
 *
 * backup：本次对比会话是否还需要先存一份快照备份。自动保存每次输入都会调用，
 * 若每次都备份，20 份的保留上限会被一次会话挤光——所以由调用方控制成「一次会话只备份一次」。
 */
export async function applySnapshotContent(
  host: SnapshotDiffHost,
  operations: SnapshotOperations,
  sourcePath: string,
  content: string,
  baselineText?: string,
  backup = true
): Promise<boolean> {
  const editor = host.getEditor();
  if (
    host.getActiveFilePath() !== sourcePath ||
    !editor ||
    !host.isEditorValid(editor)
  ) {
    new Notice("写作工具箱：当前没有可编辑的活动文件（文件可能已关闭，请重新打开）");
    return false;
  }
  const currentText = editor.getValue();
  if (baselineText !== undefined && currentText !== baselineText) {
    new Notice("写作工具箱：文档在对比期间已被修改，请重新打开对比后再写回");
    return false;
  }
  if (content === currentText) {
    new Notice("写作工具箱：内容没有变化，未应用");
    return false;
  }
  try {
    if (backup) await operations.snapshotFileSilently(sourcePath, currentText);
    if (
      host.getActiveFilePath() !== sourcePath ||
      host.getEditor() !== editor ||
      !host.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：活动文件已切换，请重新执行应用");
      return false;
    }
    if (editor.getValue() !== currentText) {
      new Notice("写作工具箱：文档内容已变化，请重新执行应用");
      return false;
    }
    host.markProgrammaticEdit?.(editor, content);
    replaceEditorText(editor, content);
    return true;
  } catch (e) {
    new Notice(`写作工具箱：应用失败：${String(e)}`);
    return false;
  }
}

function replaceEditorText(editor: Editor, text: string): void {
  // 海明威模式会拦截一切非「末尾追加」的修改，恢复/应用前临时关闭、
  // 写回后再恢复，避免快照恢复功能在海明威模式下静默失效。
  const cm = (editor as any).cm as EditorView | undefined;
  const wasHemingway = cm ? isHemingwayActive(cm) : false;
  if (wasHemingway && cm) {
    cm.dispatch({ effects: setHemingway.of(false) });
  }
  try {
    const end = editor.offsetToPos(editor.getValue().length);
    editor.replaceRange(text, { line: 0, ch: 0 }, end);
  } finally {
    if (wasHemingway && cm) {
      cm.dispatch({ effects: setHemingway.of(true) });
    }
  }
}

/* ────────────────────────── 对比弹窗 ────────────────────────── */

const HIGHLIGHT_DEBOUNCE_MS = 180;
/**
 * 自动保存的空闲阈值。
 *
 * 写回只能整篇替换编辑器内容，每次写回都会在撤销栈里留一条「整篇替换」。
 * 阈值太短，撤销粒度会碎成一两个字；太长又像没保存。约 1 秒时，
 * 一次撤销大致对应「刚写完的这一句 / 这一段」。
 */
const AUTOSAVE_IDLE_MS = 1000;

/**
 * 环境是否支持 `contenteditable="plaintext-only"`。
 *
 * 不支持时该属性会**退化成不可编辑**（实测：`isContentEditable === false`），
 * 右栏直接变成只读，用户会以为功能坏了。所以先探测再决定用哪种可编辑模式：
 * 支持的浏览器里回车是纯文本换行（`textContent` 就是全文），
 * 退化模式用 `innerText` 读，避免块级 `<div>` 把换行吃掉。
 */
function supportsPlaintextOnly(): boolean {
  let probe: HTMLElement | null = null;
  try {
    // createDiv() 会挂到 body 上：探测完立刻 detach，不留任何节点。
    probe = createDiv();
    probe.setAttribute("contenteditable", "plaintext-only");
    return probe.isContentEditable === true;
  } catch {
    return false;
  } finally {
    // 用标准 remove()：detach() 是 Obsidian 的扩展，探测失败路径上不保证存在。
    probe?.remove();
  }
}

/** 读可编辑区全文：plaintext-only 下 textContent 即全文；退化模式必须用 innerText。 */
function readEditableText(pane: HTMLElement): string {
  if (pane.getAttribute("contenteditable") === "plaintext-only") {
    return pane.textContent ?? "";
  }
  return pane.innerText ?? pane.textContent ?? "";
}

class SnapshotDiffModal extends Modal {
  private readonly host: SnapshotDiffHost;
  private readonly operations: SnapshotOperations;
  private readonly sourcePath: string;
  private readonly snapshotPath: string;
  private readonly snapshotName: string;
  private readonly snapshot: string;
  private readonly onChanged: () => void;

  /** 打开时编辑器里的内容：既是「未写入修改」的比较基线，也是外部改动的判据。 */
  private baseline: string;
  private leftPane!: HTMLElement;
  private rightPane!: HTMLElement;
  private metaEl!: HTMLElement;
  /** meta 行里「字数 · 改动」那一段（保存状态拼在它后面，便于单独刷新）。 */
  private metaBaseText: string | null = null;
  private highlightTimer = 0;
  private autosaveTimer = 0;
  private saving = false;
  private saveError = false;
  /** 本次对比会话是否已为「写回前备份」存过快照（只存一次，避免挤光历史版本）。 */
  private backedUp = false;
  private discardConfirmed = false;
  /** 最后按下的那一栏：左栏不可编辑，点空白处不一定留下选区，Cmd+A 靠它兜底。 */
  private lastPointerPane: HTMLElement | null = null;
  private readonly docKeyDown: (ev: KeyboardEvent) => void;

  constructor(
    host: SnapshotDiffHost,
    operations: SnapshotOperations,
    sourcePath: string,
    snapshotPath: string,
    snapshotName: string,
    current: string,
    snapshot: string,
    onChanged: () => void
  ) {
    super(host.app);
    this.host = host;
    this.operations = operations;
    this.sourcePath = sourcePath;
    this.snapshotPath = snapshotPath;
    this.snapshotName = snapshotName;
    this.baseline = current;
    this.snapshot = snapshot;
    this.onChanged = onChanged;
    this.docKeyDown = (ev) => this.handleKeyDown(ev);
  }

  onOpen(): void {
    const { modalEl, contentEl } = this;
    modalEl.addClass("wt-diff-modal");
    // 弹窗尺寸由 styles.css 的 .wt-diff-modal 控制

    const header = contentEl.createDiv({ cls: "wt-diff-header" });
    header.createDiv({ cls: "wt-diff-title", text: `对比 · ${this.snapshotName}` });

    const actions = contentEl.createDiv({ cls: "wt-diff-actions" });
    actions.appendChild(
      this.actionButton("复制选中", () => void this.copySelection())
    );
    actions.appendChild(
      this.actionButton("复制快照", () =>
        void this.operations.copySnapshot(this.snapshotPath)
      )
    );
    actions.appendChild(
      this.actionButton("重置为快照", () => this.resetToSnapshot())
    );
    const saveBtn = this.actionButton("保存", () => this.saveNow());
    saveBtn.addClass("wt-snap-primary");
    saveBtn.setAttr("title", "立即保存到文档（Ctrl/Cmd+S）。停止输入约 1 秒后也会自动保存");
    actions.appendChild(saveBtn);
    const restoreBtn = this.actionButton("恢复", () => this.restore());
    restoreBtn.addClass("wt-diff-danger");
    actions.appendChild(restoreBtn);
    actions.appendChild(this.actionButton("关闭", () => this.close()));

    this.metaEl = contentEl.createDiv({ cls: "wt-diff-meta" });

    contentEl.createDiv({
      cls: "wt-diff-hint",
      text: "左栏是快照（只读）：可以像普通文档一样选中任意文字复制。右栏是当前正文，可直接编辑，改动处用颜色标出；停止输入约 1 秒后自动保存到文档（也可按 Ctrl/Cmd+S 立即保存），保存前自动存一份当前版本为快照，Ctrl+Z 可撤销。「恢复」则直接把文档替换为快照内容。",
    });

    const legend = contentEl.createDiv({ cls: "wt-diff-legend" });
    this.legendItem(legend, "is-del", "删除");
    this.legendItem(legend, "is-add", "新增");
    this.legendItem(legend, "is-chg", "修改");

    const body = contentEl.createDiv({ cls: "wt-diff-body" });

    const leftCol = body.createDiv({ cls: "wt-diff-col is-left" });
    leftCol.createDiv({ cls: "wt-diff-colhead", text: "快照（只读 · 可选中复制）" });
    this.leftPane = leftCol.createDiv({ cls: "wt-diff-pane is-left" });
    this.leftPane.setText(this.snapshot);

    const rightCol = body.createDiv({ cls: "wt-diff-col is-right" });
    rightCol.createDiv({ cls: "wt-diff-colhead", text: "当前（可直接编辑）" });
    this.rightPane = rightCol.createDiv({
      cls: "wt-diff-pane is-right",
      attr: {
        contenteditable: supportsPlaintextOnly() ? "plaintext-only" : "true",
        spellcheck: "false",
        "aria-label": "当前正文（可编辑）",
      },
    });
    this.rightPane.setText(this.baseline);
    this.rightPane.addEventListener("input", () => this.onRightInput());

    // 左栏不可编辑，点空白处不会留下选区；记住最后按下的那一栏，
    // 让 Cmd/Ctrl+A 在左栏也能「全选本栏」。
    for (const pane of [this.leftPane, this.rightPane]) {
      pane.addEventListener("pointerdown", () => {
        this.lastPointerPane = pane;
      });
    }
    this.leftPane.setAttr("tabindex", "-1");

    // 弹窗打开期间接管「复制选中 / 全选本栏」：Obsidian 的复制命令作用于编辑器，
    // 焦点在弹窗里时会被吞掉，所以这里在捕获阶段先处理，只在本弹窗的选区上生效。
    this.contentEl.ownerDocument.addEventListener(
      "keydown",
      this.docKeyDown,
      true
    );

    this.refreshHighlights();
  }

  onClose(): void {
    if (this.highlightTimer) {
      window.clearTimeout(this.highlightTimer);
      this.highlightTimer = 0;
    }
    if (this.autosaveTimer) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = 0;
    }
    this.contentEl.ownerDocument.removeEventListener(
      "keydown",
      this.docKeyDown,
      true
    );
    // 高亮是文档级的注册，不随 DOM 消失；关窗必须清掉，否则残留的 Range
    // 会指向已移除的节点，并且会在下次打开时叠在旧位置上。
    clearHighlights(this.rightPane ?? this.contentEl);
    this.contentEl.empty();
  }

  /**
   * 关窗前拦一道。
   *
   * 正常情况下自动保存已经落盘，这里只是兜底：还有未写入的修改（自动保存还没到点、
   * 或写回失败过）就先尝试保存一次；保存成功直接关，失败才问用户是否放弃，
   * 不静默丢改动，也不平白弹一个「要不要放弃」。
   */
  close(): void {
    if (this.discardConfirmed || !this.hasUnwrittenChanges()) {
      super.close();
      return;
    }
    if (this.autosaveTimer) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = 0;
    }
    void this.writeBack(false).then(() => {
      if (!this.hasUnwrittenChanges()) {
        super.close();
        return;
      }
      new ConfirmModal(
        this.host.app,
        "未保存的修改",
        "右栏的修改还没能写入文档（可能文档已关闭或被别处改动）。关闭后这些改动会丢失。",
        "放弃修改",
        () => {
          this.discardConfirmed = true;
          this.close();
        },
        true
      ).open();
    });
  }

  private hasUnwrittenChanges(): boolean {
    return this.rightText() !== this.baseline;
  }

  private rightText(): string {
    if (!this.rightPane) return "";
    return readEditableText(this.rightPane);
  }

  private scheduleHighlight(): void {
    if (this.highlightTimer) window.clearTimeout(this.highlightTimer);
    this.highlightTimer = window.setTimeout(() => {
      this.highlightTimer = 0;
      this.refreshHighlights();
    }, HIGHLIGHT_DEBOUNCE_MS);
  }

  /**
   * 右栏每次输入：立即把状态改成「未保存」（不等防抖，否则用户会以为已经存了），
   * 停顿后自动写回。
   */
  private onRightInput(): void {
    this.saveError = false;
    this.updateSaveStateLabel();
    this.scheduleHighlight();
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = 0;
      if (this.hasUnwrittenChanges()) void this.writeBack(false);
    }, AUTOSAVE_IDLE_MS);
  }

  /** 只刷「保存状态」这一小段文案，不重算 diff（输入瞬间要立刻有反馈）。 */
  private updateSaveStateLabel(): void {
    if (!this.metaEl) return;
    const current = this.rightText();
    const { text, cls } = this.saveState(current);
    this.metaEl.setText(`${this.metaBaseText ?? ""} · `);
    this.metaEl.createSpan({ cls: `wt-diff-save ${cls}`, text });
  }

  /** 保存状态：文案 + 颜色类名。 */
  private saveState(current: string): { text: string; cls: string } {
    if (this.saveError) {
      return { text: "保存失败（文档可能已关闭或被改动）", cls: "is-error" };
    }
    if (this.saving) return { text: "正在保存…", cls: "is-saving" };
    if (current === this.baseline) return { text: "已保存", cls: "is-saved" };
    return { text: "未保存", cls: "is-dirty" };
  }

  /** 重算高亮与统计。输入过程中会频繁调用，只做纯文本计算 + Range 注册。 */
  private refreshHighlights(): void {
    const current = this.rightText();
    const view = diffView(this.snapshot, current);
    applyHighlight(
      this.leftPane,
      HIGHLIGHT_NAMES.leftDeleted,
      view.spans.leftDeleted
    );
    applyHighlight(
      this.leftPane,
      HIGHLIGHT_NAMES.leftChanged,
      view.spans.leftChanged
    );
    applyHighlight(
      this.rightPane,
      HIGHLIGHT_NAMES.rightAdded,
      view.spans.rightAdded
    );
    applyHighlight(
      this.rightPane,
      HIGHLIGHT_NAMES.rightChanged,
      view.spans.rightChanged
    );

    const snapCount = this.host.countWords(this.snapshot);
    const curCount = this.host.countWords(current);
    this.metaBaseText =
      `快照 ${formatNumber(snapCount)} 字 · 当前 ${formatNumber(curCount)} 字 · ` +
      (view.changeCount === 0
        ? "内容一致"
        : `改动 ${view.changeCount} 处（旧 ${view.oldUnits} 段 / 新 ${view.newUnits} 段）`);
    const state = this.saveState(current);
    this.metaEl.setText(`${this.metaBaseText} · `);
    this.metaEl.createSpan({ cls: `wt-diff-save ${state.cls}`, text: state.text });
  }

  /**
   * 手动保存（按钮 / Cmd+S）。自动保存失败后用户也能在这里重试。
   */
  private saveNow(): void {
    void this.writeBack(true);
  }

  /**
   * 写回文档。
   *
   * 自动保存与手动保存共用同一条通道：写回前比对 baseline（外部改动就拒绝），
   * 成功后把 baseline 前移，于是「未保存 → 已保存」的状态与关窗确认都跟着一致。
   *
   * backup 只在一次会话里第一次写回时为 true：否则每输入一次就存一份快照，
   * 20 份的保留上限会被一次会话挤光，真正的历史版本反而没了。
   */
  private async writeBack(showNotice: boolean): Promise<void> {
    if (this.saving) return;
    const content = this.rightText();
    if (content === this.baseline) {
      if (showNotice) new Notice("写作工具箱：内容没有变化，未保存");
      return;
    }
    this.saving = true;
    this.saveError = false;
    this.refreshHighlights();
    const backup = !this.backedUp;
    const ok = await applySnapshotContent(
      this.host,
      this.operations,
      this.sourcePath,
      content,
      this.baseline,
      backup
    );
    this.saving = false;
    if (ok) {
      this.backedUp = true;
      this.baseline = content;
      if (showNotice) new Notice("写作工具箱：已保存到文档（Ctrl+Z 可撤销）");
      this.onChanged();
    } else {
      // 失败原因（外部改动 / 文件已关闭）已经由 applySnapshotContent 提示过，
      // 这里只标记状态，让 meta 行和关窗确认能反映出「还没写进去」。
      this.saveError = true;
    }
    this.refreshHighlights();
  }

  private resetToSnapshot(): void {
    const doReset = () => {
      this.rightPane.setText(this.snapshot);
      this.refreshHighlights();
    };
    if (!this.hasUnwrittenChanges()) {
      doReset();
      return;
    }
    new ConfirmModal(
      this.host.app,
      "重置为快照",
      "右栏的修改还没有写回文档，重置后这些改动会丢失。",
      "重置",
      doReset,
      true
    ).open();
  }

  /** 恢复：把文档直接替换为快照内容（恢复前自动备份当前版本）。 */
  private restore(): void {
    new ConfirmModal(
      this.host.app,
      "恢复快照",
      `确定把当前文档内容替换为「${this.snapshotName}」吗？\n恢复前会先自动保存当前内容为快照；恢复后可用 Ctrl+Z 撤销。`,
      "恢复",
      () => {
        void performRestore(
          this.host,
          this.operations,
          this.sourcePath,
          this.snapshotPath,
          this.baseline
        ).then((ok) => {
          if (ok) {
            this.discardConfirmed = true;
            this.onChanged();
            this.close();
          }
        });
      },
      true
    ).open();
  }

  /** 复制当前选区；没有选区时明确提示，而不是静默复制整篇。 */
  private async copySelection(): Promise<void> {
    const selection = this.docSelection();
    const text = selection?.toString() ?? "";
    if (!text) {
      new Notice("写作工具箱：先在左栏或右栏选中要复制的文字");
      return;
    }
    try {
      await copyTextToClipboard(text);
      new Notice(`写作工具箱：已复制选中内容 ${text.length} 字`);
    } catch (e) {
      new Notice(`写作工具箱：复制失败：${String(e)}`);
    }
  }

  private docSelection(): Selection | null {
    const doc = this.contentEl.ownerDocument;
    return typeof doc.getSelection === "function" ? doc.getSelection() : null;
  }

  /** 选区是否落在本弹窗的两个栏里（用于判断快捷键要不要接管）。 */
  private selectionInPanes(selection: Selection): boolean {
    return this.paneOfSelection(selection) !== null;
  }

  /** 选区所在的那一栏；不在栏里返回 null。 */
  private paneOfSelection(selection: Selection): HTMLElement | null {
    // 左栏是普通 div，点一下不一定留下选区（anchorNode 可能为空），
    // 所以先看选区，再退回「最后按下的那一栏」。
    const node = selection.anchorNode ?? selection.focusNode;
    if (node) {
      if (this.leftPane?.contains(node)) return this.leftPane;
      if (this.rightPane?.contains(node)) return this.rightPane;
    }
    return this.lastPointerPane;
  }

  private handleKeyDown(ev: KeyboardEvent): void {
    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod || ev.altKey || ev.shiftKey) return;
    const key = ev.key.toLowerCase();

    // Cmd/Ctrl+S：立即保存。Obsidian 默认把 Cmd+S 绑到「保存当前文件」，
    // 焦点在弹窗里时那命令作用于编辑器（内容还是旧的），所以必须在这里拦下来。
    if (key === "s") {
      ev.preventDefault();
      ev.stopPropagation();
      this.saveNow();
      return;
    }

    if (key !== "c" && key !== "a") return;
    const selection = this.docSelection();
    if (!selection) return;

    if (key === "c") {
      // 有选区就交给统一的复制通道（桌面走 Electron、移动端走 Web Clipboard）；
      // 无选区时放行，让 Obsidian 自己处理。
      if (selection.isCollapsed || !this.selectionInPanes(selection)) return;
      ev.preventDefault();
      ev.stopPropagation();
      void this.copySelection();
      return;
    }

    const pane = this.paneOfSelection(selection);
    if (!pane) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.selectPaneContents(pane);
  }

  private selectPaneContents(pane: HTMLElement): void {
    const doc = this.contentEl.ownerDocument;
    const selection = doc.getSelection();
    if (!selection) return;
    const range = doc.createRange();
    range.selectNodeContents(pane);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private actionButton(text: string, onClick: () => void): HTMLButtonElement {
    // 全局 createEl()（不自动 append；调用方负责挂载）
    const btn = createEl("button");
    btn.addClass("wt-snap-btn");
    btn.setText(text);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private legendItem(container: HTMLElement, cls: string, label: string): void {
    container.createSpan({ cls: `wt-diff-swatch ${cls}` });
    container.appendText(label);
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}
