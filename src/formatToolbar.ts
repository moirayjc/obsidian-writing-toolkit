/**
 * 编辑工具条：选中文字后浮出的小工具条（加粗 / 斜体 / 下划线 / 删除线 / 高亮 / 字色）。
 *
 * 以 CodeMirror 6 视图插件实现，挂在每个编辑器上；气泡本体是
 * document.body 下的一个 fixed 定位元素，随选区出现、移动、消失。
 * 具体怎么改文本由 ./formatWrap 的纯函数决定，这里只负责：
 *  - 从当前文件路径问「生效范围」回调，决定要不要浮出；
 *  - 把某个格式应用到当前视图（浮出工具条按钮走这个入口）；
 *  - 画气泡、定位、点亮当前生效的格式按钮。
 */

import { EditorSelection } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { editorInfoField, setIcon } from "obsidian";
import {
  DEFAULT_FORMAT_COLOR,
  detectActiveKinds,
  detectColorAt,
  computeToggle,
  FORMAT_BUTTON_ORDER,
  FORMAT_COLORS,
  FORMAT_LABELS,
  FormatKind,
} from "./formatWrap";

export interface FormatToolbarConfig {
  /** 总开关 */
  isEnabled(): boolean;
  /** 该路径是否允许浮出（正文排除等范围设置） */
  allowsPath(path: string | null): boolean;
  /** 检测到非空选区时回调（自动诊断用，调用方自行节流；可选） */
  onSelectionCapture?(): void;
  /** 批注总开关（开启时气泡里多一个批注按钮） */
  commentsEnabled?(): boolean;
  /** 批注按钮是否不受「生效范围」限制（全库文件都可批注） */
  commentBubbleEverywhere?(): boolean;
  /** 点批注按钮：为当前选区添加批注 */
  onAddComment?(view: EditorView): void;
}

const ICONS: Record<FormatKind, string> = {
  bold: "wt-bold",
  italic: "wt-italic",
  underline: "wt-underline",
  strike: "wt-strike",
  highlight: "wt-highlight",
  color: "wt-color",
};

/** 格式工具条「字色」按钮用的最近色（本次会话内记忆） */
let lastUsedColor = DEFAULT_FORMAT_COLOR;

/* ---------- 自检统计（内部格式工具条诊断报告读取） ---------- */

export interface FormatToolbarDiagData {
  /** 工具条实例创建次数（进构造器就 +1） */
  created: number;
  /** refresh 总次数 */
  refreshes: number;
  /** 实际显示出气泡的次数 */
  shown: number;
  /** 按原因统计的隐藏次数 */
  hid: Record<string, number>;
  /** 最近一次刷新的结果描述 */
  lastReason: string;
  /** 最近一次刷新涉及的文件路径 */
  lastPath: string | null;
  /** 最近一次异常（含堆栈） */
  lastError: string;
  /** 最近一次异常的时间戳 */
  lastErrorTime: number;
  /** 扩展被注册的次数（buildFormatToolbar 每调用一次 +1） */
  extensionBuilds: number;
  /** updateListener 探针收到的视图更新次数 */
  listenerUpdates: number;
  /** 其中带选区变化的次数（与 refresh 计数对照，排查 update 是否被触发） */
  listenerSelSet: number;
}

export const formatToolbarDiag: FormatToolbarDiagData = {
  created: 0,
  refreshes: 0,
  shown: 0,
  hid: {},
  lastReason: "（还没有刷新记录）",
  lastPath: null,
  lastError: "",
  lastErrorTime: 0,
  extensionBuilds: 0,
  listenerUpdates: 0,
  listenerSelSet: 0,
};

function diagNote(reason: string, path: string | null): void {
  formatToolbarDiag.lastReason = reason;
  formatToolbarDiag.lastPath = path;
}

function diagHide(reason: string, path: string | null): void {
  formatToolbarDiag.hid[reason] = (formatToolbarDiag.hid[reason] ?? 0) + 1;
  diagNote(`隐藏：${reason}`, path);
}

/**
 * 对编辑器视图应用一次格式切换（工具条按钮与格式命令共用）。
 * 多光标时对每段选区分别计算；极端重叠的情况下静默放弃。
 */
export function applyFormatOnView(
  view: EditorView,
  kind: FormatKind,
  colorHex?: string
): boolean {
  const hex = kind === "color" ? colorHex ?? lastUsedColor : undefined;
  try {
    const doc = view.state.doc.toString();
    view.dispatch(
      view.state.changeByRange((range) => {
        const result = computeToggle(doc, range.from, range.to, kind, hex);
        return {
          changes: result.changes,
          range: EditorSelection.range(result.selFrom, result.selTo),
        };
      })
    );
    return true;
  } catch (error) {
    console.error("写作工具箱：格式切换失败", error);
    return false;
  }
}

export function buildFormatToolbar(config: FormatToolbarConfig) {
  formatToolbarDiag.extensionBuilds++;
  const plugin = ViewPlugin.fromClass(
    class {
      private view: EditorView;
      private bubble: HTMLElement;
      private commentBtn: HTMLElement;
      private buttons = new Map<FormatKind, HTMLElement>();
      private swatches: { el: HTMLElement; hex: string }[] = [];
      private paletteOpen = false;
      /** 正在点气泡上的按钮（手机端点按会让编辑器失焦，期间不要收起气泡） */
      private interacting = false;
      private disposeListeners: () => void = () => {};
      /** 是否已有一次被推迟的刷新（CM6 禁止在 update 期间读布局） */
      private refreshScheduled = false;
      /** 视图已销毁（推迟的测量回调可能晚到） */
      private destroyed = false;

      constructor(view: EditorView) {
        formatToolbarDiag.created++;
        this.view = view;
        const ownerDoc = view.dom.ownerDocument;
        this.bubble = ownerDoc.body.createDiv({ cls: "wt-format-bubble" });

        for (const kind of FORMAT_BUTTON_ORDER) {
          const btn = this.bubble.createDiv({ cls: "wt-format-btn" });
          setIcon(btn, ICONS[kind]);
          btn.setAttribute(
            "aria-label",
            kind === "color" ? "字色（点开选颜色）" : FORMAT_LABELS[kind]
          );
          this.buttons.set(kind, btn);

          if (kind !== "color") {
            btn.addEventListener("click", () => this.apply(kind));
            continue;
          }

          // 字色按钮：点开/收起右侧色板
          const palette = this.bubble.createDiv({ cls: "wt-format-palette" });
          btn.addEventListener("click", () => {
            this.paletteOpen = !this.paletteOpen;
            this.bubble.toggleClass("is-palette-open", this.paletteOpen);
          });
          for (const color of FORMAT_COLORS) {
            const swatch = palette.createDiv({ cls: "wt-format-swatch" });
            swatch.style.backgroundColor = color.hex;
            swatch.dataset.hex = color.hex;
            swatch.setAttribute("aria-label", `${color.name}字（${color.hex}）`);
            swatch.addEventListener("click", () => {
              lastUsedColor = color.hex;
              this.paletteOpen = false;
              this.bubble.removeClass("is-palette-open");
              this.apply("color", color.hex);
            });
            this.swatches.push({ el: swatch, hex: color.hex });
          }
        }

        // 批注按钮：贴在格式按钮后面，点击时收起气泡并回调（由 main 打开批注输入框）
        this.bubble.createDiv({ cls: "wt-comment-sep" });
        this.commentBtn = this.bubble.createDiv({ cls: "wt-comment-btn" });
        setIcon(this.commentBtn, "wt-comment");
        this.commentBtn.setAttribute("aria-label", "添加批注");
        this.commentBtn.addEventListener("click", () => {
          this.hide();
          config.onAddComment?.(this.view);
        });

        // 在气泡上按下时不把焦点/选区从编辑器抢走（桌面鼠标主要靠这个）
        this.bubble.addEventListener("mousedown", (event) => event.preventDefault());
        this.bubble.addEventListener("pointerdown", () => {
          this.interacting = true;
        });
        const onPointerUp = () => {
          this.interacting = false;
        };
        ownerDoc.addEventListener("pointerup", onPointerUp, true);
        this.disposeListeners = () =>
          ownerDoc.removeEventListener("pointerup", onPointerUp, true);
      }

      update(_update: ViewUpdate): void {
        this.scheduleRefresh();
      }

      destroy(): void {
        this.destroyed = true;
        this.disposeListeners();
        this.bubble.remove();
      }

      /**
       * 把刷新推迟到「测量时机」再执行：CM6 不允许在 update 期间读取编辑区
       * 布局，此时调 coordsAtPos 会直接抛
       * "Reading the editor layout isn't allowed during an update"。
       * requestMeasure 的 read 阶段是官方指定可安全读布局的窗口。
       */
      private scheduleRefresh(): void {
        if (this.refreshScheduled || this.destroyed) return;
        this.refreshScheduled = true;
        this.view.requestMeasure({
          read: () => {
            this.refreshScheduled = false;
            this.refresh();
          },
        });
      }

      private currentPath(): string | null {
        const info = this.view.state.field(editorInfoField, false);
        return info?.file?.path ?? null;
      }

      /** 是不是（带文件信息的）Markdown 编辑器；搜索框等其它 CM6 编辑器不参与。 */
      private isMarkdownEditor(): boolean {
        return this.view.state.field(editorInfoField, false) !== undefined;
      }

      private apply(kind: FormatKind, colorHex?: string): void {
        applyFormatOnView(this.view, kind, colorHex);
        this.scheduleRefresh();
      }

      private hide(): void {
        this.bubble.removeClass("is-visible");
        this.paletteOpen = false;
        this.bubble.removeClass("is-palette-open");
      }

      /** 按当前状态决定气泡的显示、位置与点亮状态（任何视图更新后都会走一遍）。 */
      private refresh(): void {
        if (this.destroyed) return;
        let sawSelection = false;
        try {
          sawSelection = this.view.state.selection.ranges.some((range) => !range.empty);
          this.refreshInner();
        } catch (error) {
          // 任何意外都不能静默：记入自检统计并在控制台留日志
          formatToolbarDiag.lastError = String((error as Error)?.stack ?? error);
          formatToolbarDiag.lastErrorTime = Date.now();
          diagNote(`异常：${String(error)}`, null);
          console.error("写作工具箱：工具条刷新出错", error);
        } finally {
          if (sawSelection) {
            try {
              config.onSelectionCapture?.();
            } catch {
              // 诊断回调绝不能影响编辑器
            }
          }
        }
      }

      /** 记一笔「为什么隐藏」，再隐藏。 */
      private hideWith(reason: string, path: string | null): void {
        diagHide(reason, path);
        this.hide();
      }

      private refreshInner(): void {
        formatToolbarDiag.refreshes++;
        const view = this.view;
        if (view.composing) return this.hideWith("输入法拼字中", null);
        if (!this.isMarkdownEditor()) return this.hideWith("非 Markdown 编辑器（无 editorInfoField）", null);
        const path = this.currentPath();
        // 格式按钮与批注按钮分开判断：批注可以「全库浮出」（不受格式生效范围限制）
        const formatOk = config.isEnabled() && config.allowsPath(path);
        const commentOk =
          (config.commentsEnabled?.() ?? false) &&
          (formatOk || (config.commentBubbleEverywhere?.() ?? false));
        if (!formatOk && !commentOk) return this.hideWith("开关关闭或范围排除", path);
        this.bubble.toggleClass("is-comments-only", !formatOk);
        this.bubble.toggleClass("is-comment-off", !commentOk);
        const state = view.state;
        if (state.selection.ranges.every((range) => range.empty)) return this.hideWith("没有选中文字", path);
        if (!view.hasFocus && !this.interacting) return this.hideWith("编辑器没有焦点", path);

        const coords = view.coordsAtPos(state.selection.main.head);
        if (!coords) return this.hideWith("拿不到选区坐标", path);

        this.bubble.addClass("is-visible");
        formatToolbarDiag.shown++;
        diagNote("已显示", path);
        // 先显示量尺寸，再在视口内收边定位（默认在选区下方，贴底时翻到上方）
        const win = view.dom.ownerDocument.defaultView ?? window;
        const width = this.bubble.offsetWidth;
        const height = this.bubble.offsetHeight;
        let top = coords.bottom + 8;
        if (top + height > win.innerHeight - 8 && coords.top - height - 8 >= 8) {
          top = coords.top - height - 8;
        }
        top = Math.max(8, Math.min(top, win.innerHeight - height - 8));
        let left = (coords.left + coords.right) / 2 - width / 2;
        left = Math.min(Math.max(8, left), Math.max(8, win.innerWidth - width - 8));
        this.bubble.style.left = `${Math.round(left)}px`;
        this.bubble.style.top = `${Math.round(top)}px`;

        this.renderStates();
      }

      /** 点亮当前选区已生效的格式按钮；色板里标出当前字色。 */
      private renderStates(): void {
        const state = this.view.state;
        const doc = state.doc.toString();
        const from = state.selection.main.from;
        const to = state.selection.main.to;
        const active = detectActiveKinds(doc, from, to);
        for (const [kind, btn] of this.buttons) {
          btn.toggleClass("is-active", active.has(kind));
        }
        const current = detectColorAt(doc, from, to);
        this.buttons.get("color")?.toggleClass("is-active", current !== null);
        for (const swatch of this.swatches) {
          swatch.el.toggleClass(
            "is-current",
            current !== null && current.trim().toLowerCase() === swatch.hex.trim().toLowerCase()
          );
        }
      }
    }
  );
  // 诊断探针：与工具条自身的 update 计数对照，排查「update 是否被触发」
  const probe = EditorView.updateListener.of((update: ViewUpdate) => {
    formatToolbarDiag.listenerUpdates++;
    if (update.selectionSet) {
      formatToolbarDiag.listenerSelSet++;
    }
  });
  return [plugin, probe];
}
