import {
  EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

/** 启用/禁用海明威模式（只进不退）的状态效果 */
export const setHemingway = StateEffect.define<boolean>();

/**
 * 新建编辑器时读取模块当前状态。
 *
 * Facet 由 Feature Module 注入，`hemingway.ts` 本身不保存可变全局状态；
 * 同一编辑器后续的切换仍使用 `setHemingway` 状态效果。
 */
const hemingwayInitialValue = Facet.define<
  () => boolean,
  () => boolean
>({
  combine: (values) =>
    values.length > 0 ? values[values.length - 1] : () => false,
});

/** 查询指定编辑器当前是否处于海明威模式。 */
export function isHemingwayActive(view: EditorView): boolean {
  return (
    view.state.facet(hemingwayInitialValue)() &&
    (view.state.field(hemingwayField, false) ?? false)
  );
}

/** 每个编辑器的启用状态 */
const hemingwayField = StateField.define<boolean>({
  create: (state) => state.facet(hemingwayInitialValue)(),
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
  if (
    !tr.startState.facet(hemingwayInitialValue)() ||
    !tr.startState.field(hemingwayField, false)
  ) {
    return tr;
  }
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
    private pendingSelectionFrame: number | null = null;
    private destroyed = false;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (
        this.view.composing ||
        !update.state.facet(hemingwayInitialValue)() ||
        !update.state.field(hemingwayField, false)
      ) {
        this.cancelPendingSelectionSync();
        return;
      }
      const main = update.state.selection.main;
      if (!main.empty || main.head === update.state.doc.length) {
        this.cancelPendingSelectionSync();
        return;
      }
      if (this.pendingSelectionFrame !== null) return;

      // Defer the corrective transaction instead of dispatching during update.
      this.pendingSelectionFrame = window.requestAnimationFrame(() => {
        this.pendingSelectionFrame = null;
        if (
          this.destroyed ||
          this.view.composing ||
          !this.view.state.facet(hemingwayInitialValue)() ||
          !this.view.state.field(hemingwayField, false)
        ) {
          return;
        }
        const selection = this.view.state.selection.main;
        if (!selection.empty || selection.head === this.view.state.doc.length) {
          return;
        }
        this.view.dispatch({
          selection: { anchor: this.view.state.doc.length },
          userEvent: "select",
        });
      });
    }

    destroy(): void {
      this.destroyed = true;
      this.cancelPendingSelectionSync();
    }

    private cancelPendingSelectionSync(): void {
      if (this.pendingSelectionFrame === null) return;
      window.cancelAnimationFrame(this.pendingSelectionFrame);
      this.pendingSelectionFrame = null;
    }
  }
);

/**
 * Obsidian 的撤销/重做快捷键可能先于事务过滤处理历史动作。
 * 海明威模式启用时在最高优先级吞掉这些键，保证“只进不退”不依赖历史实现。
 */
const hemingwayHistoryGuard = Prec.highest(
  keymap.of(
    ["Mod-z", "Mod-Shift-z", "Mod-y"].map((key) => ({
      key,
      run: (view: EditorView) => isHemingwayActive(view),
    }))
  )
);

export function buildHemingwayExtensions(
  isActive: () => boolean
): Extension[] {
  return [
    hemingwayInitialValue.of(isActive),
    hemingwayField,
    hemingwayFilter,
    hemingwayView,
    hemingwayHistoryGuard,
  ];
}
