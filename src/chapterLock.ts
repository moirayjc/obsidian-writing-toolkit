/**
 * 章节定稿锁的编辑器部分（CodeMirror 6）：只负责拦截。
 *
 * 定位是「防手痒的软约束」：只拦作者在编辑器里的编辑动作，不拦 Obsidian 自己
 * 加载文件、把外部修改同步进编辑器——拦了会让编辑器与磁盘对不上，之后一保存
 * 就可能把 Agent 的修改盖掉。所以过滤器只认 CodeMirror 的作者输入事件：
 *   input.*（打字、输入法 input.type.compose、粘贴 input.paste、拖入 input.drop）、
 *   delete.*（退格、剪切 delete.cut……）、undo、redo、move.drop（编辑器内拖动）。
 *
 * 「锁不锁」每次都从 config.isLocked(路径) 现问，不依赖任何缓存状态。
 * 顶部提示条不在这里：它挂在笔记视图上（标题栏与正文之间），由章节状态模块维护。
 * 2026-10-22 起从 CodeMirror 顶部面板挪出来，因为手机端面板不显示。
 *
 * 本文件不 import obsidian，路径怎么取由调用方传进来，方便检查脚本直接跑真实实现。
 */
import { EditorState, type Extension, type Transaction } from "@codemirror/state";

export interface ChapterLockConfig {
  /** 这个文件此刻是否锁定（定稿且没有临时解锁）。 */
  isLocked(path: string | null): boolean;
  /** 从编辑器状态取当前文件路径。 */
  pathOf(state: EditorState): string | null;
  /** 一次编辑被拦下（用来闪一下提示条，告诉作者为什么没反应）。 */
  onBlocked?(path: string): void;
}

/** 作者在编辑器里的编辑动作（CodeMirror 真实发出的 userEvent 前缀）。 */
const AUTHOR_EDIT_EVENTS = ["input", "delete", "undo", "redo", "move.drop"];

export function isAuthorEdit(tr: Transaction): boolean {
  return tr.docChanged && AUTHOR_EDIT_EVENTS.some((event) => tr.isUserEvent(event));
}

/** 定稿锁的编辑器扩展：锁定中的章节拦下作者编辑事务。 */
export function buildChapterLockExtension(config: ChapterLockConfig): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!isAuthorEdit(tr)) return tr;
    const path = config.pathOf(tr.startState);
    if (!config.isLocked(path)) return tr;
    if (path) config.onBlocked?.(path);
    return [];
  });
}
