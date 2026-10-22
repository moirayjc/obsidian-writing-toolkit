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

/**
 * 写入守卫：返回拒绝写入的原因（给用户看的一句话），允许写入返回 null。
 * 插件内会改正文的功能（快照恢复、对比写回、编辑工具条）写之前先问一次，
 * 由具体模块（如章节定稿锁）注册，避免功能模块之间互相 import。
 */
export type WriteGuard = (path: string) => string | null;

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
  /** 注册写入守卫；返回撤销函数（模块停用时调用）。 */
  registerWriteGuard(guard: WriteGuard): () => void;
  /** 这个文件此刻能不能由插件写正文：能返回 null，不能返回原因。 */
  writeBlockReason(path: string | null | undefined): string | null;
}

export class DefaultEditorService implements EditorService {
  private readonly writeGuards = new Set<WriteGuard>();

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

  registerWriteGuard(guard: WriteGuard): () => void {
    this.writeGuards.add(guard);
    return () => {
      this.writeGuards.delete(guard);
    };
  }

  writeBlockReason(path: string | null | undefined): string | null {
    if (!path) return null;
    for (const guard of this.writeGuards) {
      const reason = guard(path);
      if (reason) return reason;
    }
    return null;
  }

  private activeView(): ActiveEditorView | null {
    const view = this.app.workspace.activeEditor;
    if (!view || !("editor" in view)) return null;
    return view;
  }
}
