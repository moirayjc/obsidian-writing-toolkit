import { ViewPlugin, EditorView, Decoration } from "@codemirror/view";
import type { DecorationSet, PluginValue, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, Transaction } from "@codemirror/state";

export const DEFAULT_TYPEWRITER_OFFSET = 0.4;
const MIN_TYPEWRITER_OFFSET = 0.2;
const MAX_TYPEWRITER_OFFSET = 0.7;

export interface TypewriterRuntime {
  isActive(): boolean;
  getOffset(): number;
  isParagraphHighlightActive(): boolean;
}

export interface TypewriterDocument {
  readonly lines: number;
  line(number: number): {
    readonly from: number;
    readonly text: string;
  };
}

export interface ParagraphLineRange {
  firstLine: number;
  lastLine: number;
}

export interface TypewriterMetrics {
  margin: number;
  bottomPadding: number;
}

export function normalizeTypewriterOffset(offset: number): number {
  if (!Number.isFinite(offset)) return DEFAULT_TYPEWRITER_OFFSET;
  return Math.min(MAX_TYPEWRITER_OFFSET, Math.max(MIN_TYPEWRITER_OFFSET, offset));
}

export function typewriterMetrics(
  viewportHeight: number,
  lineHeight: number,
  offset: number
): TypewriterMetrics {
  const height = Number.isFinite(viewportHeight)
    ? Math.max(0, viewportHeight)
    : 0;
  const safeLineHeight = Number.isFinite(lineHeight)
    ? Math.max(0, lineHeight)
    : 0;
  const margin = Math.max(
    0,
    Math.round(height * normalizeTypewriterOffset(offset) - safeLineHeight / 2)
  );
  return {
    margin,
    bottomPadding: Math.max(0, height - margin),
  };
}

export function isStandaloneMarkdownBlock(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    /^#{1,6}(?:\s|$)/.test(trimmed) ||
    /^(?:[-+*]|\d+[.)])\s+/.test(trimmed)
  );
}

export function paragraphLineRange(
  doc: TypewriterDocument,
  lineNumber: number
): ParagraphLineRange | null {
  if (
    !Number.isInteger(lineNumber) ||
    lineNumber < 1 ||
    lineNumber > doc.lines
  ) {
    return null;
  }

  const currentText = doc.line(lineNumber).text;
  if (currentText.trim() === "") return null;

  // Markdown headings and list items are independent blocks even when there
  // are no blank lines around them. Keep each structural line from absorbing
  // the surrounding prose into one large highlighted paragraph.
  if (isStandaloneMarkdownBlock(currentText)) {
    return { firstLine: lineNumber, lastLine: lineNumber };
  }

  let firstLine = lineNumber;
  let lastLine = lineNumber;

  while (firstLine > 1) {
    const previousText = doc.line(firstLine - 1).text;
    if (
      previousText.trim() === "" ||
      isStandaloneMarkdownBlock(previousText)
    ) {
      break;
    }
    firstLine--;
  }
  while (lastLine < doc.lines) {
    const nextText = doc.line(lastLine + 1).text;
    if (nextText.trim() === "" || isStandaloneMarkdownBlock(nextText)) break;
    lastLine++;
  }
  return { firstLine, lastLine };
}

function paragraphHighlightPlugin(runtime: TypewriterRuntime) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;
      private highlightActive: boolean;

      constructor(view: EditorView) {
        this.highlightActive = runtime.isParagraphHighlightActive();
        this.decorations = buildParagraphDecorations(view, runtime);
      }

      update(update: ViewUpdate) {
        const highlightActive = runtime.isParagraphHighlightActive();
        if (highlightActive !== this.highlightActive) {
          this.highlightActive = highlightActive;
          this.decorations = highlightActive
            ? buildParagraphDecorations(update.view, runtime)
            : Decoration.none;
          return;
        }
        if (
          highlightActive &&
          (update.docChanged || update.selectionSet || update.viewportChanged)
        ) {
          this.decorations = buildParagraphDecorations(update.view, runtime);
        } else if (!highlightActive) {
          this.decorations = Decoration.none;
        }
      }
    },
    { decorations: (value) => value.decorations }
  );
}

function buildParagraphDecorations(
  view: EditorView,
  runtime: TypewriterRuntime
): DecorationSet {
  if (!runtime.isParagraphHighlightActive()) return Decoration.none;

  const head = view.state.selection.main.head;
  const currentLine = view.state.doc.lineAt(head).number;
  const range = paragraphLineRange(view.state.doc, currentLine);
  if (!range) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  for (let line = range.firstLine; line <= range.lastLine; line++) {
    const lineFrom = view.state.doc.line(line).from;
    builder.add(
      lineFrom,
      lineFrom,
      Decoration.line({ class: "wt-active-paragraph" })
    );
  }
  return builder.finish();
}

function clearTypewriterPadding(view: EditorView): void {
  view.contentDOM.removeClass("wt-typewriter-pad");
  view.contentDOM.setCssProps({ "--wt-typewriter-pad-bottom": "" });
}

function paddingPlugin(runtime: TypewriterRuntime) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      view: EditorView;
      paddingApplied = false;
      private activeSnapshot = false;
      private offsetSnapshot = DEFAULT_TYPEWRITER_OFFSET;

      constructor(view: EditorView) {
        this.view = view;
        this.syncPadding();
      }

      destroy() {
        this.clearPadding();
      }

      update(update: ViewUpdate) {
        const active = runtime.isActive();
        const offset = runtime.getOffset();
        if (!active) {
          this.clearPadding();
          this.activeSnapshot = false;
          this.offsetSnapshot = offset;
          return;
        }

        if (
          this.activeSnapshot &&
          this.offsetSnapshot === offset &&
          !update.docChanged &&
          !update.selectionSet &&
          !update.geometryChanged &&
          !update.viewportChanged
        ) {
          return;
        }
        this.syncPadding();
      }

      private syncPadding(): void {
        const active = runtime.isActive();
        const offset = runtime.getOffset();
        this.activeSnapshot = active;
        this.offsetSnapshot = offset;
        if (!active) {
          this.clearPadding();
          return;
        }

        const height = this.view.dom.clientHeight;
        if (!height) return;
        const { bottomPadding } = typewriterMetrics(
          height,
          this.view.defaultLineHeight,
          offset
        );
        this.view.contentDOM.addClass("wt-typewriter-pad");
        this.view.contentDOM.setCssProps({
          "--wt-typewriter-pad-bottom": `${bottomPadding}px`,
        });
        this.paddingApplied = true;
      }

      private clearPadding(): void {
        if (!this.paddingApplied) return;
        clearTypewriterPadding(this.view);
        this.paddingApplied = false;
      }
    }
  );
}

function scrollPlugin(runtime: TypewriterRuntime) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      view: EditorView;
      busy: boolean;
      frameId: number | null;
      destroyed: boolean;

      constructor(view: EditorView) {
        this.view = view;
        this.busy = false;
        this.frameId = null;
        this.destroyed = false;
      }

      destroy() {
        this.destroyed = true;
        if (this.frameId !== null) {
          window.cancelAnimationFrame(this.frameId);
          this.frameId = null;
        }
        this.busy = false;
      }

      update(update: ViewUpdate) {
        if (!runtime.isActive()) {
          if (this.frameId !== null) {
            window.cancelAnimationFrame(this.frameId);
            this.frameId = null;
          }
          this.busy = false;
          return;
        }
        if (this.busy) return;

        const isEditing = update.transactions.some((tr: Transaction) => {
          const event = tr.annotation(Transaction.userEvent);
          return (
            event !== undefined &&
            (event.startsWith("input") ||
              event.startsWith("delete") ||
              event === "undo" ||
              event === "redo")
          );
        });
        if (!isEditing || !update.docChanged) return;

        this.busy = true;
        this.frameId = window.requestAnimationFrame(() => {
          this.frameId = null;
          this.busy = false;
          if (this.destroyed || !runtime.isActive()) return;

          const head = this.view.state.selection.main.head;
          const height = this.view.dom.clientHeight;
          if (!height) return;
          const { margin } = typewriterMetrics(
            height,
            this.view.defaultLineHeight,
            runtime.getOffset()
          );
          this.view.dispatch({
            effects: EditorView.scrollIntoView(head, {
              y: "start",
              yMargin: margin,
            }),
          });
        });
      }
    }
  );
}

export function buildTypewriterExtensions(runtime: TypewriterRuntime) {
  return [
    paddingPlugin(runtime),
    scrollPlugin(runtime),
    paragraphHighlightPlugin(runtime),
  ];
}
