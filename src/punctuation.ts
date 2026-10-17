import { EditorView } from "@codemirror/view";

const PAIRS: Record<string, string> = {
  "“": "”",
  "‘": "’",
  "（": "）",
  "【": "】",
  "｛": "｝",
  "《": "》",
};

const CLOSERS: Record<string, string> = Object.fromEntries(
  Object.entries(PAIRS).map(([open, close]) => [close, open])
);

export type PunctuationInputHandler = (
  view: EditorView,
  from: number,
  to: number,
  text: string
) => boolean;

export function createPunctuationInputHandler(
  isActive: () => boolean
): PunctuationInputHandler {
  return (view, from, to, text) => {
    if (!isActive() || text.length !== 1) return false;
    return applyPunctuationInput(view, from, to, text);
  };
}

export function buildPunctuationExtensions(isActive: () => boolean) {
  return EditorView.inputHandler.of(
    createPunctuationInputHandler(isActive)
  );
}

/** 单步输入变换，便于不启动编辑器直接验证括号配对语义。 */
export function applyPunctuationInput(
  view: EditorView,
  from: number,
  to: number,
  text: string
): boolean {
  // 输入右括号：若光标后就是同一个右括号，直接跳过，避免出现重复（如（内容）））
  if (text in CLOSERS) {
    if (from === to && view.state.sliceDoc(from, from + 1) === text) {
      view.dispatch({ selection: { anchor: from + 1 } });
      return true;
    }
    return false;
  }

  const closer = PAIRS[text];
  if (!closer) return false;

  // 有选区：用括号包裹选中文本，并保持选中，方便继续修改
  if (from !== to) {
    const selected = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: text + selected + closer },
      selection: { anchor: from + 1, head: from + 1 + selected.length },
    });
    return true;
  }

  if (view.state.sliceDoc(from, from + 1) === closer) {
    view.dispatch({ selection: { anchor: from + 1 } });
    return true;
  }

  view.dispatch({
    changes: { from, to, insert: text + closer },
    selection: { anchor: from + text.length },
  });
  return true;
}
