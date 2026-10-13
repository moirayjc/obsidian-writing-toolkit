import { EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/** 启用/禁用海明威模式（只进不退）的状态效果 */
export const setHemingway = StateEffect.define<boolean>();

/** 模块级期望状态：新建的编辑器按此初始化 */
let hemingwayDesired = false;

export function setHemingwayDesired(on: boolean): void {
  hemingwayDesired = on;
}

/** 查询指定编辑器当前是否处于海明威模式。 */
export function isHemingwayActive(view: EditorView): boolean {
  return view.state.field(hemingwayField, false) ?? false;
}

/** 每个编辑器的启用状态 */
const hemingwayField = StateField.define<boolean>({
  create: () => hemingwayDesired,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHemingway)) return effect.value;
    }
    return value;
  },
});

/**
 * 事务过滤：启用时只允许「在文档末尾追加」的修改，
 * 删除、替换、中间插入都会被拒绝（撤销/重做同样因回改而被拦下）。
 */
const hemingwayFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.startState.field(hemingwayField, false)) return tr;
  if (!tr.docChanged) return tr;
  let ok = true;
  const docLength = tr.startState.doc.length;
  // 中文输入法的组词更新会替换文档末尾已有的 composing 区间：
  // 例如先插入「n」，再把末尾的「n」替换为「ni」。
  // 这仍属于「只向后写」，不能按普通回改拦截；但中间位置的组词仍拒绝。
  const isComposition = (tr.annotation(Transaction.userEvent) ?? "").startsWith(
    "input.compose"
  );
  tr.changes.iterChanges((fromA, toA) => {
    if (isComposition ? toA !== docLength : fromA !== docLength || toA !== docLength) {
      ok = false;
    }
  });
  return ok ? tr : [];
});

/**
 * 光标守卫：启用时任何「单击定位」都会把主光标拉回文档末尾；
 * 拖选（查看/复制旧内容）保留，松手后下次点击再回到末尾。
 */
const hemingwayView = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate): void {
      if (!update.state.field(hemingwayField, false)) return;
      const docLength = update.state.doc.length;
      const main = update.state.selection.main;
      if (main.empty && main.head !== docLength) {
        update.view.dispatch({
          selection: { anchor: docLength },
          userEvent: "select",
        });
      }
    }
  }
);

export function buildHemingwayExtensions() {
  return [hemingwayField, hemingwayFilter, hemingwayView];
}
