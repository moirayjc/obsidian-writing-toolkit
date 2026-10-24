/**
 * 编辑器里这次变化是谁改的：作者，还是 Obsidian 自己（从磁盘重载、外部同步进编辑器）。
 *
 * Obsidian 的 editor-change 事件不带事务，分不出这两种；而跨设备统计必须分清——
 * 打开着的章节被 Syncthing 改写时，编辑器重载产生的变化看起来和作者按退格一样
 * （2026-10-24 真机：手机上删 22 字，同步到电脑后电脑又记了 −22）。
 *
 * 判据与定稿锁同一套：作者的编辑带 CodeMirror 的 userEvent（input / delete / undo /
 * redo / move.drop），Obsidian 重载文件不带（见 chapterLock.ts 的 isAuthorEdit）。
 * 用 transactionExtender 在事务生成时记下，按「改动后的文档对象」存，
 * 不依赖 editor-change 与其他监听器的先后顺序。
 */
import { EditorState, type Extension, type Text } from "@codemirror/state";
import { isAuthorEdit } from "./chapterLock";

const authoredByDoc = new WeakMap<Text, boolean>();

export function buildEditorOriginTracker(): Extension {
  return EditorState.transactionExtender.of((tr) => {
    if (tr.docChanged) authoredByDoc.set(tr.newDoc, isAuthorEdit(tr));
    return null;
  });
}

/** 当前文档是不是由「非作者」的改动产生的。没记录（比如刚打开）返回 false。 */
export function isNonAuthorDoc(doc: Text): boolean {
  return authoredByDoc.get(doc) === false;
}
