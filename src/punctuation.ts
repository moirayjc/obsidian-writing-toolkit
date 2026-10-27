import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/** 方向明确的成对符号：左右是两个键，输入什么就是什么。 */
const BRACKETS: Record<string, string> = {
  "（": "）",
  "【": "】",
  "｛": "｝",
  "《": "》",
  "〈": "〉",
  "「": "」",
  "『": "』",
  "〔": "〕",
};

/**
 * 中文引号：输入法用同一个键轮流出左 / 右引号，状态还会被切换窗口、改光标位置打乱，
 * 所以收到的“或”都不可信，一律按上下文重新判断方向。
 */
const QUOTES: Record<string, string> = {
  "“": "”",
  "‘": "’",
};

const QUOTE_OF: Record<string, string> = Object.fromEntries(
  Object.entries(QUOTES).flatMap(([open, close]) => [
    [open, open],
    [close, open],
  ])
);

const ALL_PAIRS: Record<string, string> = { ...BRACKETS, ...QUOTES };

const BRACKET_OPEN_OF: Record<string, string> = Object.fromEntries(
  Object.entries(BRACKETS).map(([open, close]) => [close, open])
);

const CLOSERS = new Set(Object.values(ALL_PAIRS));

/** 光标右侧是这些字符（或行尾）时才自动补右半边；正文前面插左括号不该凭空多出一个右括号。 */
const AUTO_CLOSE_BEFORE = /^(|\s|[，。！？；：、…—,.!?;:])$/;

export type PunctuationInputHandler = (
  view: EditorView,
  from: number,
  to: number,
  text: string
) => boolean;

export interface PunctuationOptions {
  /**
   * 能否自动补右半边。海明威模式会把光标拉回文末，补出来的右半边会把光标挤到外面，
   * 那时只插左半边，收尾仍靠上下文判断。
   */
  canAutoClose?: () => boolean;
}

export function createPunctuationInputHandler(
  isActive: () => boolean,
  options: PunctuationOptions = {}
): PunctuationInputHandler {
  return (view, from, to, text) => {
    if (!isActive() || text.length !== 1) return false;
    if (view.state.selection.ranges.length > 1) return false;
    return applyPunctuationInput(view, from, to, text, options);
  };
}

export function buildPunctuationExtensions(
  isActive: () => boolean,
  options: PunctuationOptions = {}
) {
  return [
    EditorView.inputHandler.of(createPunctuationInputHandler(isActive, options)),
    Prec.high(
      keymap.of([
        {
          key: "Backspace",
          run: (view) => isActive() && applyPunctuationBackspace(view),
        },
      ])
    ),
  ];
}

/** 单步输入变换，便于不启动编辑器直接验证配对语义。 */
export function applyPunctuationInput(
  view: EditorView,
  from: number,
  to: number,
  text: string,
  options: PunctuationOptions = {}
): boolean {
  const canAutoClose = options.canAutoClose ?? (() => true);
  const quoteOpen = QUOTE_OF[text];
  if (quoteOpen) return applyQuote(view, from, to, text, quoteOpen, canAutoClose);

  const bracketOpen = BRACKET_OPEN_OF[text];
  if (bracketOpen) {
    // 输入右括号：只有前面确实有没闭合的左括号、且右侧正好是它的右半边时才跳过，
    // 否则（比如给已有的孤立右括号前再补一个）照常插入。
    if (
      from === to &&
      charAt(view, from) === text &&
      openDepth(view, from, bracketOpen, text) > 0
    ) {
      moveCursor(view, from + 1);
      return true;
    }
    return false;
  }

  const closer = BRACKETS[text];
  if (!closer) return false;
  if (from !== to) return wrap(view, from, to, text, closer);
  // 括号可以嵌套：右侧已有右括号也照样补一对
  insert(view, from, to, text, canAutoClose() && autoClose(view, from) ? closer : "");
  return true;
}

function applyQuote(
  view: EditorView,
  from: number,
  to: number,
  text: string,
  open: string,
  canAutoClose: () => boolean
): boolean {
  const close = QUOTES[open];
  if (from !== to) return wrap(view, from, to, open, close);

  const next = charAt(view, from);
  if (openDepth(view, from, open, close) > 0) {
    // 引号里：这一下是收尾
    if (next === close) moveCursor(view, from + 1);
    else insert(view, from, to, close, "");
    return true;
  }

  // 英文里的撇号（it’s）不是引号
  if (open === "‘" && /[A-Za-z0-9]/.test(charAt(view, from - 1))) {
    insert(view, from, to, text, "");
    return true;
  }

  // 引号外：这一下是开头。右侧已是孤立的右引号就只补左边，让它们配上
  const pair = next !== close && canAutoClose() && autoClose(view, from);
  insert(view, from, to, open, pair ? close : "");
  return true;
}

/** 在空的一对符号中间退格时连右半边一起删掉。 */
export function applyPunctuationBackspace(view: EditorView): boolean {
  const { ranges } = view.state.selection;
  if (ranges.length !== 1 || !ranges[0].empty) return false;
  const pos = ranges[0].head;
  const closer = ALL_PAIRS[charAt(view, pos - 1)];
  if (!closer || charAt(view, pos) !== closer) return false;
  view.dispatch({
    changes: { from: pos - 1, to: pos + 1 },
    selection: { anchor: pos - 1 },
    userEvent: "delete.backward",
  });
  return true;
}

/** 本段光标之前还没闭合的左符号个数。只看当前段，前面段落的漏配不会一路带下来。 */
function openDepth(
  view: EditorView,
  pos: number,
  open: string,
  close: string
): number {
  const lineStart = view.state.doc.lineAt(pos).from;
  let depth = 0;
  for (const ch of view.state.sliceDoc(lineStart, pos)) {
    if (ch === open) depth++;
    else if (ch === close && depth > 0) depth--;
  }
  return depth;
}

function autoClose(view: EditorView, pos: number): boolean {
  const next = charAt(view, pos);
  return CLOSERS.has(next) || AUTO_CLOSE_BEFORE.test(next);
}

function charAt(view: EditorView, pos: number): string {
  if (pos < 0) return "";
  return view.state.sliceDoc(pos, pos + 1);
}

function moveCursor(view: EditorView, pos: number) {
  view.dispatch({ selection: { anchor: pos } });
}

/** 有选区：用符号包裹选中文本，并保持选中，方便继续修改。 */
function wrap(
  view: EditorView,
  from: number,
  to: number,
  open: string,
  close: string
): boolean {
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: open + selected + close },
    selection: { anchor: from + 1, head: from + 1 + selected.length },
    userEvent: "input.type",
  });
  return true;
}

/** 插入 before + after，光标停在两者之间。 */
function insert(
  view: EditorView,
  from: number,
  to: number,
  before: string,
  after: string
) {
  view.dispatch({
    changes: { from, to, insert: before + after },
    selection: { anchor: from + before.length },
    // 标成作者输入：撤销分组、定稿锁等过滤器都靠它识别
    userEvent: "input.type",
  });
}
