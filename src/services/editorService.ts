import {
  editorInfoField,
  MarkdownView,
  type App,
  type Editor,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

interface EditorWithView extends Editor {
  cm?: EditorView;
}

interface ActiveEditorView {
  editor?: Editor | null;
}

export interface EditorRegistrationAdapter {
  registerEditorExtension(extension: Extension): void;
}

/**
 * Host-managed adapter for Obsidian's public Editor API and CodeMirror view.
 *
 * Obsidian does not type `Editor.cm`, so all access to the CodeMirror view
 * stays behind this service. Extension registration and workspace refreshes
 * also share this entry point without changing their existing timing.
 */
export interface EditorService {
  registerExtension(extension: Extension): void;
  refresh(): void;
  getActiveEditor(): Editor | null;
  getActiveEditorText(): string | null;
  getActiveEditorSelection(): string;
  isEditorValid(editor: Editor): boolean;
  getViewForEditor(editor: Editor | null | undefined): EditorView | undefined;
  getMarkdownEditorViews(): EditorView[];
  getFilePath(view: EditorView | null | undefined): string | null;
  getFilePathForEditor(editor: Editor | null | undefined): string | null;
  findViewFromDom(element: HTMLElement | null): EditorView | null;
}

export class DefaultEditorService implements EditorService {
  constructor(
    private readonly app: App,
    private readonly registration: EditorRegistrationAdapter
  ) {}

  registerExtension(extension: Extension): void {
    this.registration.registerEditorExtension(extension);
  }

  refresh(): void {
    this.app.workspace.updateOptions();
  }

  getActiveEditor(): Editor | null {
    return this.activeView()?.editor ?? null;
  }

  getActiveEditorText(): string | null {
    return this.activeView()?.editor?.getValue() ?? null;
  }

  getActiveEditorSelection(): string {
    return this.activeView()?.editor?.getSelection() ?? "";
  }

  isEditorValid(editor: Editor): boolean {
    let valid = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as unknown as ActiveEditorView;
      if (view?.editor === editor) valid = true;
    });
    return valid;
  }

  getViewForEditor(
    editor: Editor | null | undefined
  ): EditorView | undefined {
    return editor ? (editor as EditorWithView).cm : undefined;
  }

  getMarkdownEditorViews(): EditorView[] {
    const views: EditorView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const markdownView = leaf.view;
      if (!(markdownView instanceof MarkdownView)) continue;
      const view = this.getViewForEditor(markdownView.editor);
      if (view) views.push(view);
    }
    return views;
  }

  getFilePath(view: EditorView | null | undefined): string | null {
    return view?.state.field(editorInfoField, false)?.file?.path ?? null;
  }

  getFilePathForEditor(editor: Editor | null | undefined): string | null {
    return this.getFilePath(this.getViewForEditor(editor));
  }

  findViewFromDom(element: HTMLElement | null): EditorView | null {
    return element ? EditorView.findFromDOM(element) : null;
  }

  private activeView(): ActiveEditorView | null {
    const view = this.app.workspace.activeEditor;
    if (!view || !("editor" in view)) return null;
    return view;
  }
}
