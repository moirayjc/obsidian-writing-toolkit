/**
 * 章节定稿锁的编辑器部分（CodeMirror 6）。
 *
 * 定位是「防手痒的软约束」：只拦作者在编辑器里的编辑动作，不拦 Obsidian 自己
 * 加载文件、把外部修改同步进编辑器——拦了会让编辑器与磁盘对不上，之后一保存
 * 就可能把 Agent 的修改盖掉。所以过滤器只认 CodeMirror 的作者输入事件：
 *   input.*（打字、输入法 input.type.compose、粘贴 input.paste、拖入 input.drop）、
 *   delete.*（退格、剪切 delete.cut……）、undo、redo、move.drop（编辑器内拖动）。
 *
 * 「锁不锁」每次都从 config.isLocked(路径) 现问，不依赖缓存；
 * chapterLockedField 只用来驱动顶部提示条，晚一拍也只影响提示条，不影响拦截。
 *
 * 本文件不 import obsidian，路径怎么取由调用方传进来，方便检查脚本直接跑真实实现。
 */
import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import {
  EditorView,
  showPanel,
  ViewPlugin,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";

export interface ChapterLockConfig {
  /** 这个文件此刻是否锁定（定稿且没有临时解锁）。 */
  isLocked(path: string | null): boolean;
  /** 从编辑器状态取当前文件路径。 */
  pathOf(state: EditorState): string | null;
  /** 点了提示条上的「临时解锁」。 */
  onUnlockRequest(path: string): void;
  /** 一次编辑被拦下（用来闪一下提示条，告诉作者为什么没反应）。 */
  onBlocked?(path: string): void;
  /** 给提示条按钮画图标（由调用方用 Obsidian 的 setIcon 实现）。 */
  setIcon?(el: HTMLElement, icon: string): void;
}

/** 作者在编辑器里的编辑动作（CodeMirror 真实发出的 userEvent 前缀）。 */
const AUTHOR_EDIT_EVENTS = ["input", "delete", "undo", "redo", "move.drop"];

export function isAuthorEdit(tr: Transaction): boolean {
  return tr.docChanged && AUTHOR_EDIT_EVENTS.some((event) => tr.isUserEvent(event));
}

export const setChapterLocked = StateEffect.define<boolean>();

/** 当前编辑器是否显示「本章已定稿」提示条。 */
export const chapterLockedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setChapterLocked)) return effect.value;
    }
    return value;
  },
});

/** 把编辑器的提示条状态对齐到「此刻锁不锁」；拼字中不 dispatch，交给下一次更新。 */
export function syncChapterLock(view: EditorView, config: ChapterLockConfig): void {
  if (view.composing) return;
  const want = config.isLocked(config.pathOf(view.state));
  if (view.state.field(chapterLockedField, false) === want) return;
  view.dispatch({ effects: setChapterLocked.of(want) });
}

/** 正在显示的提示条：被拦下时按路径找到它们闪一下。 */
const livePanels = new Set<{ path: () => string | null; dom: HTMLElement }>();

/** 闪一下这个文件的提示条（编辑被拦时调用）。 */
export function flashChapterLockPanels(path: string): void {
  for (const panel of livePanels) {
    if (panel.path() !== path) continue;
    panel.dom.removeClass("is-flash");
    // 强制重排，让同一个动画可以连续触发
    void panel.dom.offsetWidth;
    panel.dom.addClass("is-flash");
  }
}

function createLockPanel(view: EditorView, config: ChapterLockConfig): Panel {
  const dom = createDiv({ cls: "wt-lock-panel" });
  const icon = dom.createSpan({ cls: "wt-lock-panel-icon" });
  config.setIcon?.(icon, "wt-lock");
  dom.createSpan({ cls: "wt-lock-panel-text", text: "本章已定稿" });
  const button = dom.createEl("button", {
    cls: "wt-lock-panel-btn",
    text: "临时解锁",
    attr: { type: "button", title: "临时解锁本章；关闭这章的标签页后自动重新锁上" },
  });
  const entry = { path: () => config.pathOf(view.state), dom };
  button.addEventListener("click", () => {
    const path = config.pathOf(view.state);
    if (path) config.onUnlockRequest(path);
  });
  dom.addEventListener("animationend", () => dom.removeClass("is-flash"));
  return {
    dom,
    top: true,
    mount: () => livePanels.add(entry),
    destroy: () => livePanels.delete(entry),
  };
}

/**
 * 定稿锁的全部编辑器扩展：拦截过滤器 + 顶部提示条 + 提示条状态同步。
 */
export function buildChapterLockExtension(config: ChapterLockConfig): Extension {
  const filter = EditorState.transactionFilter.of((tr) => {
    if (!isAuthorEdit(tr)) return tr;
    const path = config.pathOf(tr.startState);
    if (!config.isLocked(path)) return tr;
    if (path) config.onBlocked?.(path);
    return [];
  });

  const panel = showPanel.from(chapterLockedField, (locked) =>
    locked ? (view: EditorView) => createLockPanel(view, config) : null
  );

  // Obsidian 会在同一个标签页里复用编辑器打开别的文件；每次更新都核对一遍，
  // 不一致就推迟到下一帧再 dispatch（更新过程中不能 dispatch）。
  const sync = ViewPlugin.fromClass(
    class {
      private frame: number | null = null;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate): void {
        const want = config.isLocked(config.pathOf(update.state));
        if (want !== update.state.field(chapterLockedField, false)) this.schedule();
      }

      destroy(): void {
        this.destroyed = true;
        if (this.frame !== null) window.cancelAnimationFrame(this.frame);
      }

      private schedule(): void {
        if (this.frame !== null) return;
        this.frame = window.requestAnimationFrame(() => {
          this.frame = null;
          if (this.destroyed) return;
          if (this.view.composing) {
            this.schedule();
            return;
          }
          syncChapterLock(this.view, config);
        });
      }
    }
  );

  return [chapterLockedField, filter, panel, sync];
}
