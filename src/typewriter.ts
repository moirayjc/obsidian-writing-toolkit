import { ViewPlugin, EditorView, Decoration } from "@codemirror/view";
import { RangeSetBuilder, Transaction } from "@codemirror/state";

const DEFAULT_TYPEWRITER_OFFSET = 0.4;

let typewriterActive = false;
let typewriterOffset = DEFAULT_TYPEWRITER_OFFSET;
let paragraphHighlightActive = false;

export function isTypewriterActive(): boolean {
  return typewriterActive;
}

export function setTypewriterActive(active: boolean): void {
  typewriterActive = active;
}

export function setTypewriterOffset(offset: number): void {
  typewriterOffset = Math.min(0.7, Math.max(0.2, offset));
}

export function setParagraphHighlight(active: boolean): void {
  paragraphHighlightActive = active;
}

function paragraphHighlightPlugin() {
  return ViewPlugin.fromClass(class {
    decorations;

    constructor(view: EditorView) {
      this.decorations = buildParagraphDecorations(view);
    }

    update(update: any) {
      if (paragraphHighlightActive && (update.docChanged || update.selectionSet || update.viewportChanged)) {
        this.decorations = buildParagraphDecorations(update.view);
      } else if (!paragraphHighlightActive) {
        this.decorations = Decoration.none;
      }
    }
  }, { decorations: (value: any) => value.decorations });
}

function buildParagraphDecorations(view: EditorView) {
  if (!paragraphHighlightActive) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const head = view.state.selection.main.head;
  const currentLine = view.state.doc.lineAt(head).number;
  const currentText = view.state.doc.line(currentLine).text;
  if (currentText.trim() === "") return Decoration.none;

  // Markdown headings and list items are independent blocks even when there
  // are no blank lines around them. Keep each structural line from absorbing
  // the surrounding prose into one large highlighted paragraph.
  if (isStandaloneMarkdownBlock(currentText)) {
    builder.add(view.state.doc.line(currentLine).from, view.state.doc.line(currentLine).from, Decoration.line({ class: "wt-active-paragraph" }));
    return builder.finish();
  }

  let firstLine = currentLine;
  let lastLine = currentLine;

  while (firstLine > 1) {
    const previousText = view.state.doc.line(firstLine - 1).text;
    if (previousText.trim() === "" || isStandaloneMarkdownBlock(previousText)) break;
    firstLine--;
  }
  while (lastLine < view.state.doc.lines) {
    const nextText = view.state.doc.line(lastLine + 1).text;
    if (nextText.trim() === "" || isStandaloneMarkdownBlock(nextText)) break;
    lastLine++;
  }
  for (let line = firstLine; line <= lastLine; line++) {
    builder.add(view.state.doc.line(line).from, view.state.doc.line(line).from, Decoration.line({ class: "wt-active-paragraph" }));
  }
  return builder.finish();
}

function isStandaloneMarkdownBlock(text: string): boolean {
  const trimmed = text.trimStart();
  return /^#{1,6}(?:\s|$)/.test(trimmed)
    || /^(?:[-+*]|\d+[.)])\s+/.test(trimmed);
}

function paddingPlugin() {
  return ViewPlugin.fromClass(class {
    view: EditorView;
    constructor(view: EditorView) { this.view = view; }
    destroy() {
      this.view.contentDOM.style.paddingTop = "";
      this.view.contentDOM.style.paddingBottom = "";
    }
    update(update: any) {
      if (!typewriterActive) {
        if (this.view.contentDOM.style.paddingTop || this.view.contentDOM.style.paddingBottom) {
          this.view.contentDOM.style.paddingTop = "";
          this.view.contentDOM.style.paddingBottom = "";
        }
        return;
      }

      if (!update.docChanged && !update.selectionSet && !update.geometryChanged && !update.viewportChanged) {
        return;
      }

      const h = this.view.dom.clientHeight;
      if (!h) return;
      const target = Math.max(0, Math.round(h * typewriterOffset - this.view.defaultLineHeight / 2));
      this.view.contentDOM.style.paddingTop = "";
      this.view.contentDOM.style.paddingBottom = `${Math.max(0, h - target)}px`;
    }
  });
}

function scrollPlugin() {
  return ViewPlugin.fromClass(class {
    view: EditorView;
    busy: boolean;
    constructor(view: EditorView) { this.view = view; this.busy = false; }
    update(update: any) {
      if (!typewriterActive || this.busy) return;

      const isEditing = update.transactions.some((tr: Transaction) => {
        const event = tr.annotation(Transaction.userEvent);
        return event !== undefined && (
          event.startsWith("input") ||
          event.startsWith("delete") ||
          event === "undo" ||
          event === "redo"
        );
      });
      if (!isEditing || !update.docChanged) return;

      this.busy = true;
      const self = this;
      requestAnimationFrame(function () {
        self.busy = false;
        if (!typewriterActive) return;
        const head = self.view.state.selection.main.head;
        const h = self.view.dom.clientHeight;
        if (!h) return;
        const margin = Math.max(0, Math.round(h * typewriterOffset - self.view.defaultLineHeight / 2));
        self.view.dispatch({
          effects: EditorView.scrollIntoView(head, { y: "start", yMargin: margin }),
        });
      });
    }
  });
}

export function buildTypewriterExtensions() {
  return [paddingPlugin(), scrollPlugin(), paragraphHighlightPlugin()];
}
