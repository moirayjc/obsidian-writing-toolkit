import { Prec } from "@codemirror/state";
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
function inFencedCode(view: EditorView, pos: number): boolean {
  const { doc } = view.state;
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
function inFrontmatter(view: EditorView, pos: number): boolean {
  const { doc } = view.state;
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
  if (inFencedCode(view, sel.head)) return false;
  // frontmatter 内：保留默认换行
  if (inFrontmatter(view, sel.head)) return false;

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

export function buildHardBreakExtensions(isActive: () => boolean) {
  return Prec.highest(
    keymap.of([
      {
        // 只拦截裸 Enter；Shift+Enter / Ctrl(Cmd)+Enter / Alt+Enter 走默认行为
        key: "Enter",
        run: createHardBreakInputHandler(isActive),
      },
    ])
  );
}
