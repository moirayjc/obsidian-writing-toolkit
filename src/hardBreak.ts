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

  const line = state.doc.lineAt(sel.head);
  const lineText = line.text;
  // 空行：保留默认行为（不叠加多余空行）
  if (lineText.trim().length === 0) return false;
  // 块级语法行：保留默认行为（新建列表项/引用续行/表格行等）
  if (BLOCK_START_RE.test(lineText)) return false;

  // 插入段落分隔（两个换行符）：一次回车 = 常规 Markdown 编辑器
  // （如 Typora）的一次回车，阅读视图与导出均为标准段落换行。
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: "\n\n" },
    selection: { anchor: sel.from + 2 },
  });
  return true;
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
