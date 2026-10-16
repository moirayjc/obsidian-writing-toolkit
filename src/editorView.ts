import type { Editor } from "obsidian";
import type { EditorView } from "@codemirror/view";

/**
 * Obsidian 的 Editor 在桌面端内部挂着 CodeMirror 6 的 EditorView，
 * `cm` 不在公开类型里。越界断言统一集中在这里，别再各写各的 `as any`。
 */
interface EditorWithCm extends Editor {
  cm?: EditorView;
}

export function getEditorView(
  editor: Editor | null | undefined
): EditorView | undefined {
  return editor ? (editor as EditorWithCm).cm : undefined;
}
