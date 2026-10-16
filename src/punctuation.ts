import { EditorView } from "@codemirror/view";

let punctuationAssistActive = true;

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

export function setPunctuationAssist(active: boolean): void {
  punctuationAssistActive = active;
}

export function buildPunctuationExtensions() {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (!punctuationAssistActive || text.length !== 1) return false;

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
  });
}
