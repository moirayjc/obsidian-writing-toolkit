import { EditorState, Prec, type Text, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

export type HardBreakInputHandler = (view: EditorView) => boolean;

/**
 * 行首属于块级语法起始的标记：引用、列表、任务列表、标题、围栏、表格。
 * 这类行按回车应保留 Obsidian 默认行为（续行/新建列表项/新建表格行）。
 */
const BLOCK_START_RE =
  /^\s*(?:>|[-+*]\s|\d+[.)]\s|#{1,6}\s|```|~~~|\|)|^\s*[-=]{3,}$/;

/**
 * 位置 pos 是否位于 fenced code block（``` 或 ~~~ 围栏）内。
 */
function inFencedCode(doc: Text, pos: number): boolean {
  const current = doc.lineAt(pos);
  let open: { char: string; length: number } | null = null;
  for (let n = 1; n <= current.number; n++) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(doc.line(n).text);
    if (!match) continue;
    const marker = match[1];
    const rest = match[2];
    if (!open) {
      open = { char: marker[0], length: marker.length };
    } else if (
      marker[0] === open.char &&
      marker.length >= open.length &&
      rest.trim().length === 0
    ) {
      open = null;
    }
  }
  return open !== null;
}

/**
 * 位置 pos 是否位于文件开头的 YAML frontmatter 内（含首尾两行 ---）。
 * 源码模式下在属性里回车若插成空行，会把 YAML 拆坏。
 */
function inFrontmatter(doc: Text, pos: number): boolean {
  if (doc.line(1).text !== "---") return false;
  const current = doc.lineAt(pos).number;
  for (let n = 2; n <= doc.lines; n++) {
    if (doc.line(n).text === "---") return current <= n;
  }
  return false;
}

export function createHardBreakInputHandler(
  isActive: () => boolean
): HardBreakInputHandler {
  return (view) => {
    if (!isActive()) return false;
    return applyHardBreakOnEnter(view);
  };
}

export function applyHardBreakOnEnter(view: EditorView): boolean {
  // 中文输入法组合确认期间的回车不拦截，避免破坏候选词确认
  if ((view as EditorView & { composing?: boolean }).composing) {
    return false;
  }
  const { state } = view;
  const sel = state.selection.main;
  // 代码块内：保留默认换行
  if (inFencedCode(state.doc, sel.head)) return false;
  // frontmatter 内：保留默认换行
  if (inFrontmatter(state.doc, sel.head)) return false;

  const { doc } = state;
  const startLine = doc.lineAt(sel.from);
  const endLine = doc.lineAt(sel.to);
  // 块级语法行：保留默认行为（新建列表项/引用续行/表格行等）
  if (BLOCK_START_RE.test(startLine.text)) return false;

  const plan = planParagraphBreak({
    before: startLine.text.slice(0, sel.from - startLine.from),
    after: endLine.text.slice(sel.to - endLine.from),
    prevHasText:
      startLine.number > 1 && hasText(doc.line(startLine.number - 1).text),
    nextHasText:
      endLine.number < doc.lines && hasText(doc.line(endLine.number + 1).text),
  });

  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: plan.insert },
    selection: { anchor: sel.from + plan.cursor },
    // 和 CodeMirror 自带的回车一样标成作者输入：撤销分组、定稿锁等过滤器都靠它识别
    userEvent: "input",
  });
  return true;
}

function hasText(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * 段与段之间永远正好一个空行（作者的约定）：回车后光标所在的新段落，
 * 上下有文字的一侧都隔一个空行，已经隔着空行的一侧不再叠加。
 *
 * - 行中间：拆成两段，中间一个空行，光标在后一段开头。
 * - 行尾 / 空行：开一个新段落；上方紧贴文字就补空行，下方紧贴文字也补空行。
 * - 行首：上方紧贴文字时只补一个空行把两段拆开；上方已有空行时在上面开一个新段落。
 *
 * 返回要插入的文本和插入后光标相对插入点的偏移；insert 为空时回车什么也不做
 * （光标已经在一个上下都隔好空行的空段落里）。
 */
export function planParagraphBreak(context: {
  before: string;
  after: string;
  prevHasText: boolean;
  nextHasText: boolean;
}): { insert: string; cursor: number } {
  const { before, after, prevHasText, nextHasText } = context;
  if (hasText(before) && hasText(after)) return { insert: "\n\n", cursor: 2 };
  if (hasText(after)) {
    return prevHasText ? { insert: "\n", cursor: 1 } : { insert: "\n\n", cursor: 0 };
  }
  const above = hasText(before) ? "\n\n" : prevHasText ? "\n" : "";
  const below = nextHasText ? "\n" : "";
  return { insert: above + below, cursor: above.length };
}

/** 正文段落行：有文字，且不是标题 / 列表 / 引用 / 表格 / 围栏等块级语法行。 */
function isProse(text: string): boolean {
  return hasText(text) && !BLOCK_START_RE.test(text);
}

/** 代码块、frontmatter 里不动空行。 */
function inRawBlock(doc: Text, pos: number): boolean {
  return inFencedCode(doc, pos) || inFrontmatter(doc, pos);
}

function singleCursor(view: EditorView): number | null {
  if ((view as EditorView & { composing?: boolean }).composing) return null;
  const { ranges } = view.state.selection;
  if (ranges.length !== 1 || !ranges[0].empty) return null;
  return ranges[0].head;
}

/**
 * 退格，按「段与段之间正好一个空行」理解：
 * - 回车开出的空段落里（上方隔一个空行、再往上是文字）：一次退回上一段行尾；
 *   下方紧接文字时保留一个空行。
 * - 段首（上方隔一个空行、再往上是正文）：一次把这段接到上一段末尾，
 *   不经过「两段紧贴」的中间状态。
 */
export function applyHardBreakBackspace(view: EditorView): boolean {
  const head = singleCursor(view);
  if (head === null) return false;
  const { doc } = view.state;
  const line = doc.lineAt(head);
  if (line.number < 3 || hasText(doc.line(line.number - 1).text)) return false;
  const textLine = doc.line(line.number - 2);
  if (!hasText(textLine.text) || inRawBlock(doc, head)) return false;

  if (!hasText(line.text)) {
    const nextHasText =
      line.number < doc.lines && hasText(doc.line(line.number + 1).text);
    view.dispatch({
      changes: { from: textLine.to, to: line.to, insert: nextHasText ? "\n" : "" },
      selection: { anchor: textLine.to },
      userEvent: "delete.backward",
    });
    return true;
  }

  if (head !== line.from || !isProse(line.text) || !isProse(textLine.text)) return false;
  view.dispatch({
    changes: { from: textLine.to, to: line.from },
    selection: { anchor: textLine.to },
    userEvent: "delete.backward",
  });
  return true;
}

/** 段尾向前删除（fn+Delete）：下方隔一个空行是正文时，一次把下一段接上来。 */
export function applyHardBreakDelete(view: EditorView): boolean {
  const head = singleCursor(view);
  if (head === null) return false;
  const { doc } = view.state;
  const line = doc.lineAt(head);
  if (head !== line.to || line.number + 2 > doc.lines) return false;
  if (hasText(doc.line(line.number + 1).text)) return false;
  const textLine = doc.line(line.number + 2);
  if (!isProse(line.text) || !isProse(textLine.text) || inRawBlock(doc, head)) {
    return false;
  }
  view.dispatch({
    changes: { from: line.to, to: textLine.from },
    selection: { anchor: line.to },
    userEvent: "delete.forward",
  });
  return true;
}

/**
 * 删除 / 剪切选区之后：光标落在一串空行里、上下都是正文时，把这串空行收成一个，
 * 光标回到上一段行尾。列表 / 表格等块级语法行旁边的空行不动。
 */
export function collapseBlankRunAt(doc: Text, pos: number): TransactionSpec | null {
  const line = doc.lineAt(pos);
  if (hasText(line.text)) return null;
  let first = line.number;
  let last = line.number;
  while (first > 1 && !hasText(doc.line(first - 1).text)) first--;
  while (last < doc.lines && !hasText(doc.line(last + 1).text)) last++;
  if (first === 1 || last === doc.lines || last - first < 1) return null;
  const above = doc.line(first - 1);
  const below = doc.line(last + 1);
  if (!isProse(above.text) || !isProse(below.text) || inRawBlock(doc, pos)) return null;
  return {
    changes: { from: above.to, to: below.from, insert: "\n\n" },
    selection: { anchor: above.to },
  };
}

/**
 * 粘贴进来的文字统一成「段与段之间正好一个空行」：
 * 紧贴的两行正文之间补一个空行，正文之间的多个空行收成一个。
 * 列表 / 表格 / 引用 / 标题 / 代码块 / 公式块原样保留，它们和旁边的空行也不动；
 * 首尾的空行不动。网页小说段首自带的全角空格 / 不换行空格去掉——段首缩进由
 * 「段首缩进」开关纯视觉显示，正文里不留缩进字符。
 */
export function normalizePastedParagraphs(text: string): string {
  if (!text.includes("\n")) return stripPastedIndent(text);
  const out: string[] = [];
  let fence: string | null = null;
  let blanks = 0;
  let prevProse: boolean | null = null;
  const flushBlanks = (keep: number) => {
    for (let i = 0; i < keep; i++) out.push("");
    blanks = 0;
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      out.push(line);
      if (line.trim().startsWith(fence)) {
        fence = null;
        prevProse = false;
      }
      continue;
    }
    if (!hasText(line)) {
      blanks++;
      continue;
    }
    const opener = /^\s*(`{3,}|~{3,}|\$\$)/.exec(line)?.[1] ?? null;
    // 半角空格 / Tab 缩进的行多半是列表续行或缩进代码，不当正文（全角空格开头的中文段落照常算）
    const prose = opener === null && isProse(line) && !/^( {2,}|\t)/.test(line);
    if (prevProse && prose) flushBlanks(1);
    else flushBlanks(blanks);
    out.push(prose ? stripPastedIndent(line) : line);
    prevProse = prose;
    // 公式块的 $$ 写在同一行（$$ x $$）时不算开块
    if (opener && !(opener === "$$" && line.trim().length > 2 && line.trim().endsWith("$$"))) {
      fence = opener;
    }
  }
  flushBlanks(blanks);
  return out.join("\n");
}

/** 去掉段首的全角空格（U+3000）/ 不换行空格（U+00A0），及夹在其中的半角空格。 */
function stripPastedIndent(line: string): string {
  return line.replace(/^[\u3000\u00a0][\u3000\u00a0 ]*/, "");
}

/** 删除选区、粘贴之后整理空行；附加改动和原事务合成一次撤销。 */
function buildSpacingFilter(isActive: () => boolean, isPasting: () => boolean) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !isActive()) return tr;
    const changed: { fromA: number; fromB: number; toB: number }[] = [];
    tr.changes.iterChanges((fromA, _toA, fromB, toB) => {
      changed.push({ fromA, fromB, toB });
    });
    if (changed.length !== 1) return tr;
    const [{ fromA, fromB, toB }] = changed;
    const doc = tr.newDoc;

    if (tr.isUserEvent("input.paste") || isPasting()) {
      const startLine = tr.startState.doc.lineAt(fromA).text;
      if (BLOCK_START_RE.test(startLine) || inRawBlock(tr.startState.doc, fromA)) return tr;
      const pasted = doc.sliceString(fromB, toB);
      const normalized = normalizePastedParagraphs(pasted);
      if (normalized === pasted) return tr;
      return [
        tr,
        {
          changes: { from: fromB, to: toB, insert: normalized },
          selection: { anchor: fromB + normalized.length },
          sequential: true,
        },
      ];
    }

    const deletedSelection =
      tr.isUserEvent("delete") && tr.startState.selection.ranges.some((r) => !r.empty);
    if (!deletedSelection) return tr;
    const fix = collapseBlankRunAt(doc, tr.newSelection.main.head);
    return fix ? [tr, { ...fix, sequential: true }] : tr;
  });
}

export function buildHardBreakExtensions(isActive: () => boolean) {
  // Obsidian 自己处理的粘贴（如网页富文本转 Markdown）未必带 input.paste，
  // 所以在 paste 事件里先记一下，同一轮里发生的改动都当粘贴处理。
  let pasting = false;
  return [
    Prec.highest(
      keymap.of([
        {
          // 只拦截裸 Enter；Shift+Enter / Ctrl(Cmd)+Enter / Alt+Enter 走默认行为
          key: "Enter",
          run: createHardBreakInputHandler(isActive),
        },
        {
          key: "Backspace",
          run: (view) => isActive() && applyHardBreakBackspace(view),
        },
        {
          key: "Delete",
          run: (view) => isActive() && applyHardBreakDelete(view),
        },
      ])
    ),
    Prec.highest(
      EditorView.domEventHandlers({
        paste() {
          pasting = true;
          window.setTimeout(() => {
            pasting = false;
          }, 0);
          return false;
        },
      })
    ),
    buildSpacingFilter(isActive, () => pasting),
  ];
}
