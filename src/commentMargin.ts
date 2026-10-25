/**
 * 批注页边对话卡（specs/comment-margin-cards.md）：正文右侧一条页边，每条批注一张卡。
 *
 * 为什么不会「跳」（§5.3 被否掉的是跟随浮层）：
 *   卡片挂在编辑器的滚动容器（.cm-scroller）里、绝对定位在它的内容坐标上，
 *   滚动时由浏览器和正文一起原生地滚，不需要任何脚本跟随；只有锚点所在的行真的移动了
 *   （上面打字、回车、删段，或屏幕外的行高从估算变成实测），卡片才换位置。
 *   CodeMirror 自己的光标层、选区层也是这么挂的。
 *
 * 版心让位：本文有批注时，如果正文右边放不下一张卡，给滚动容器右侧加内边距，
 * 正文在剩下的宽度里照旧居中；放不下又挤不出（窗口太窄）就不显示页边，
 * 点标记时退回侧栏详情页（由批注模块判断 reveal() 的返回值）。
 *
 * 读写分离：位置、尺寸都在 requestMeasure 的 read 里量，write 里只写样式，
 * 不在 ViewPlugin.update 里 dispatch（会抛错），展开 / 收起的加深显示在用户点击时才发出。
 * 输入法拼字中（正文或卡片回复框）不重绘卡片，拼完再补。
 *
 * Esc 收起不在这里接：Obsidian 的快捷键系统在 window 的捕获阶段先拿到按键，
 * 有面板认领 Esc 时直接拦掉，编辑器和卡片都收不到（2026-10-25 作者实测「按 Esc 收不起」）。
 * 改由批注模块在同一层（window 捕获）监听，见 collapseMarginCards / closeOnEscape。
 */
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import {
  COMMENT_SPEAKER_LABELS,
  COMMENT_TURN_LABELS,
  isSidecarPath,
} from "./comments";
import {
  commentAnchorPositions,
  commentRefreshEffect,
  setActiveCommentEffect,
} from "./commentDecor";
import {
  CommentDrafts,
  CommentThreadHost,
  draftKey,
  renderThreadBody,
} from "./commentThread";
import type { CommentPanelItem, CommentPanelModel } from "./commentView";

/* ---------- 尺寸 ---------- */

/** 卡片宽度 */
export const MARGIN_CARD_WIDTH = 280;
/** 正文右边缘到卡片的距离 */
export const MARGIN_GAP = 24;
/** 卡片到编辑区右边缘的距离 */
export const MARGIN_EDGE = 16;
/** 上下相邻两张卡的间距 */
export const MARGIN_CARD_GAP = 8;
/** 让位后正文至少还要这么宽，否则不显示页边（退回侧栏） */
export const MARGIN_MIN_TEXT = 420;

/* ---------- 纯函数：版心让位 / 卡片排布（检查脚本直接测） ---------- */

export interface MarginSpaceInput {
  /** 滚动容器可见宽度（含内边距、不含滚动条） */
  clientWidth: number;
  padLeft: number;
  /** 没加让位时的右内边距 */
  padRight: number;
  /** 可读行宽上限（关掉「可读行宽」时为 Infinity） */
  lineWidth: number;
}

export interface MarginSpacePlan {
  /** 页边放得下 */
  available: boolean;
  /** 需要额外加在右侧的内边距（正文在剩下的宽度里居中） */
  reserve: number;
}

/**
 * 页边需要的宽度 = 间距 + 卡片 + 右边距。正文居中在内容区里：
 * 右侧空白 = 右内边距 + (内容宽 − 正文宽) / 2。不够时加最少的右内边距让它够；
 * 让完正文窄于 MARGIN_MIN_TEXT（或可读行宽本身更窄时的行宽）就算放不下。
 */
export function planMarginSpace(input: MarginSpaceInput): MarginSpacePlan {
  const need = MARGIN_GAP + MARGIN_CARD_WIDTH + MARGIN_EDGE;
  const content = input.clientWidth - input.padLeft - input.padRight;
  if (!(content > 0)) return { available: false, reserve: 0 };
  const line = Math.min(input.lineWidth, content);
  const freeRight = input.padRight + (content - line) / 2;
  let reserve = 0;
  if (freeRight < need) {
    // 正文仍是满行宽时，每加 1px 内边距右侧空白多 0.5px；正文开始变窄后，加多少多多少
    const keepLine = 2 * (need - input.padRight) - (content - input.lineWidth);
    reserve =
      Number.isFinite(input.lineWidth) && keepLine <= content - input.lineWidth
        ? Math.max(0, keepLine)
        : need - input.padRight;
  }
  reserve = Math.ceil(reserve);
  const textWidth = Math.min(input.lineWidth, content - reserve);
  if (textWidth < Math.min(MARGIN_MIN_TEXT, input.lineWidth)) {
    return { available: false, reserve: 0 };
  }
  return { available: true, reserve };
}

export interface CardSlot {
  id: number;
  /** 锚点所在行的顶端（滚动内容坐标）；null = 无法定位 */
  desired: number | null;
  height: number;
}

/**
 * 卡片排布：按锚点从上到下，挨得近的依次往下错开、不重叠。
 * 展开的那张优先对齐原文：它上面的卡往上让，让到顶还不够才整体往下排（它就对不齐了）。
 * 无法定位的排在最下面，按编号。
 */
export function layoutCards(
  slots: readonly CardSlot[],
  expandedId: number | null,
  gap = MARGIN_CARD_GAP
): Map<number, number> {
  const located = slots
    .filter((s): s is CardSlot & { desired: number } => s.desired !== null)
    .sort((a, b) => a.desired - b.desired || a.id - b.id);
  const lost = slots.filter((s) => s.desired === null).sort((a, b) => a.id - b.id);
  const tops: number[] = new Array<number>(located.length);

  const forward = (from: number, floor: number) => {
    for (let i = from; i < located.length; i++) {
      tops[i] = Math.max(located[i].desired, floor);
      floor = tops[i] + located[i].height + gap;
    }
  };

  const k = located.findIndex((s) => s.id === expandedId);
  if (k < 0) {
    forward(0, 0);
  } else {
    tops[k] = Math.max(0, located[k].desired);
    forward(k + 1, tops[k] + located[k].height + gap);
    for (let i = k - 1; i >= 0; i--) {
      tops[i] = Math.min(located[i].desired, tops[i + 1] - located[i].height - gap);
    }
    if (located.length > 0 && tops[0] < 0) forward(0, 0);
  }

  const result = new Map<number, number>();
  located.forEach((s, i) => result.set(s.id, tops[i]));
  let floor =
    located.length > 0
      ? tops[located.length - 1] + located[located.length - 1].height + gap
      : 0;
  for (const s of lost) {
    result.set(s.id, floor);
    floor += s.height + gap;
  }
  return result;
}

/* ---------- 编辑器扩展 ---------- */

export interface CommentMarginConfig {
  /** 批注总开关（含「这台设备不用批注」）；关时不显示页边 */
  enabled(): boolean;
  /** 某篇文档的批注模型（和侧栏同一份数据） */
  getModel(path: string): Promise<CommentPanelModel>;
  host: CommentThreadHost;
  /** 回复草稿（和侧栏共用） */
  drafts: CommentDrafts;
  /** 页边新建、一个字没写就收起：删掉这条空批注 */
  discardEmpty(path: string, id: number): void;
}

/** 批注模块用的页边操作。 */
export interface CommentMarginApi {
  /** 页边现在放得下 */
  available(): boolean;
  /** 展开这条（它在正文里定位得到、页边放得下时）；成功返回 true */
  reveal(id: number): boolean;
  /** 新建批注：这条刚写进批注文件、还没有消息，展开成输入框 */
  beginCompose(id: number): boolean;
  /** 有一张卡展开着 */
  expanded(): boolean;
  /** 收起展开的卡；焦点在卡里时交回正文 */
  collapse(): void;
}

interface CardEntry {
  el: HTMLElement;
  sig: string;
  /** 上次写下的位置：没变就不再写样式（滚动时视口一变就会测一轮） */
  top?: number;
  left?: number;
}

interface Measured {
  plan: MarginSpacePlan;
  padRight: number;
  show: boolean;
  left: number;
  slots: CardSlot[];
}

function readDocPath(view: EditorView): string | null {
  try {
    return view.state.field(editorInfoField, false)?.file?.path ?? null;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** 一张卡的内容签名：没变就不重建 DOM（免得吃掉点击、清掉回复框焦点）。 */
function cardSignature(
  item: CommentPanelItem,
  expanded: boolean,
  composing: boolean,
  draft: string
): string {
  return [
    expanded ? "E" : "c",
    composing ? "N" : "-",
    expanded ? "" : draft,
    item.turn,
    item.origin,
    item.gone ? "g" : "-",
    item.quote,
    item.locatedLine === null ? "x" : item.locatedLine,
    item.via ?? "none",
    item.messages
      .map(
        (m) =>
          `${m.by}:${m.text}` +
          (m.suggestion
            ? `\u0005${m.suggestion.original}\u0005${m.suggestion.replacement}\u0005${m.suggestion.adopted ? 1 : 0}`
            : "")
      )
      .join("\u0004"),
    item.suggestion
      ? `${item.suggestion.index}:${item.suggestion.status}:${item.suggestion.before}:${item.suggestion.reason}`
      : "",
  ].join("\u0001");
}

/** 最近一次 buildMarginExtension 建的插件（批注模块找某个编辑器的页边用）。 */
let currentMarginPlugin: ViewPlugin<MarginView> | null = null;

export function marginFor(view: EditorView | null | undefined): CommentMarginApi | null {
  // 拿到的不一定是真的 EditorView（测试桩、别的插件塞进来的视图），可选方法先看在不在
  if (!view || !currentMarginPlugin || typeof view.plugin !== "function") return null;
  return view.plugin(currentMarginPlugin) ?? null;
}

class MarginView implements CommentMarginApi {
  private readonly root: HTMLElement;
  private readonly cards = new Map<number, CardEntry>();
  private model: CommentPanelModel | null = null;
  private path: string | null;
  private expandedId: number | null = null;
  /** 页边新建、还没写第一条消息的那条 */
  private composingId: number | null = null;
  private focusPending = false;
  private plan: MarginSpacePlan = { available: false, reserve: 0 };
  private appliedReserve = 0;
  private shown = false;
  private seq = 0;
  /** 卡片回复框里正在用输入法拼字 */
  private imeInCard = false;
  /** 拼字期间来了新数据，拼完再重绘 */
  private dirty = false;
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly config: CommentMarginConfig
  ) {
    this.root = createDiv({ cls: "wt-margin is-hidden" });
    view.scrollDOM.appendChild(this.root);
    this.root.addEventListener("compositionstart", () => {
      this.imeInCard = true;
    });
    this.root.addEventListener("compositionend", () => {
      this.imeInCard = false;
      if (this.dirty) {
        this.dirty = false;
        this.render();
        this.schedule();
      }
    });
    this.path = readDocPath(view);
    void this.load();
  }

  update(update: ViewUpdate): void {
    const path = readDocPath(this.view);
    if (path !== this.path) {
      // 换文件：旧文档的展开 / 新建状态作废（加深显示由装饰字段自己按文件清掉）
      this.abandonCompose();
      this.path = path;
      this.expandedId = null;
      this.model = null;
      this.clearCards();
      void this.load();
      return;
    }
    if (
      update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(commentRefreshEffect))
      )
    ) {
      void this.load();
    }
    if (
      update.docChanged ||
      update.geometryChanged ||
      update.heightChanged ||
      update.viewportChanged
    ) {
      this.schedule();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.seq++;
    if (this.appliedReserve > 0) {
      this.view.scrollDOM.style.removeProperty("padding-right");
    }
    this.root.remove();
  }

  /* ---------- 批注模块用的操作 ---------- */

  available(): boolean {
    return this.plan.available && this.config.enabled();
  }

  reveal(id: number): boolean {
    if (!this.available()) return false;
    const located = commentAnchorPositions(this.view.state).some((p) => p.id === id);
    if (!located) return false;
    this.expand(id);
    return true;
  }

  beginCompose(id: number): boolean {
    if (!this.available()) return false;
    this.abandonCompose();
    this.composingId = id;
    this.focusPending = true;
    this.expand(id);
    return true;
  }

  expanded(): boolean {
    return this.expandedId !== null;
  }

  collapse(): void {
    if (this.expandedId === null) return;
    const id = this.expandedId;
    this.expandedId = null;
    // 焦点在卡里（回复框、按钮）：卡片收起后交回正文，接着写
    const focusInCard = this.root.contains(this.root.ownerDocument.activeElement);
    if (this.composingId === id) this.abandonCompose();
    this.render();
    this.setActive(null);
    this.schedule();
    if (focusInCard) this.view.focus();
  }

  /* ---------- 内部 ---------- */

  private expand(id: number): void {
    if (this.expandedId !== id && this.composingId !== null && this.composingId !== id) {
      this.abandonCompose();
    }
    this.expandedId = id;
    this.render();
    this.setActive(id);
    this.schedule();
  }

  /** 新建的那条还一个字没写（也没草稿）：删掉，不留空白注。 */
  private abandonCompose(): void {
    const id = this.composingId;
    this.composingId = null;
    this.focusPending = false;
    if (id === null || !this.path) return;
    const item = this.model?.items.find((i) => i.id === id);
    const draft = this.config.drafts.get(draftKey(this.path, id)) ?? "";
    if ((!item || item.messages.length === 0) && !draft.trim()) {
      this.config.discardEmpty(this.path, id);
    }
  }

  private setActive(id: number | null): void {
    // 用户点击里调用，不会撞上编辑器正在更新；输入法拼字中稍后再发
    const send = () => {
      if (this.destroyed) return;
      if (this.view.composing) {
        window.setTimeout(send, 300);
        return;
      }
      try {
        this.view.dispatch({ effects: setActiveCommentEffect.of(id) });
      } catch {
        // 视图已销毁：忽略
      }
    };
    send();
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    const path = this.path;
    if (!path || isSidecarPath(path) || !this.config.enabled()) {
      this.model = null;
      this.render();
      this.schedule();
      return;
    }
    let model: CommentPanelModel | null = null;
    try {
      model = await this.config.getModel(path);
    } catch (error) {
      console.error("[Writing Toolkit:comments] 页边读取批注失败", error);
    }
    if (seq !== this.seq || this.destroyed || path !== this.path) return;
    this.model = model && model.docPath === path ? model : null;
    this.render();
    this.schedule();
  }

  private items(): CommentPanelItem[] {
    return this.model?.items ?? [];
  }

  private clearCards(): void {
    for (const entry of this.cards.values()) entry.el.remove();
    this.cards.clear();
  }

  private render(): void {
    if (this.destroyed) return;
    if (this.imeInCard) {
      this.dirty = true;
      return;
    }
    const path = this.path;
    const items = this.items();
    if (this.composingId !== null) {
      const fresh = items.find((i) => i.id === this.composingId);
      // 第一条消息发出去了：从此是普通批注
      if (fresh && fresh.messages.length > 0) this.composingId = null;
    }
    if (
      this.expandedId !== null &&
      this.expandedId !== this.composingId &&
      this.model &&
      !items.some((i) => i.id === this.expandedId)
    ) {
      // 展开的那条被结案 / 删掉了（刚新建的那条可能还没读进来，不算）
      this.expandedId = null;
      this.setActive(null);
    }
    const keep = new Set<number>();
    for (const item of items) {
      keep.add(item.id);
      const expanded = item.id === this.expandedId;
      const composing = item.id === this.composingId;
      const draft = path ? this.config.drafts.get(draftKey(path, item.id)) ?? "" : "";
      const sig = cardSignature(item, expanded, composing, draft);
      const entry = this.cards.get(item.id);
      if (entry && entry.sig === sig) continue;
      const focus = entry ? this.captureFocus(entry.el) : null;
      const el = this.buildCard(item, expanded, composing, draft);
      if (entry) entry.el.replaceWith(el);
      else this.root.appendChild(el);
      this.cards.set(item.id, { el, sig });
      if (focus) this.restoreFocus(el, focus);
    }
    for (const [id, entry] of [...this.cards]) {
      if (keep.has(id)) continue;
      entry.el.remove();
      this.cards.delete(id);
    }
  }

  /**
   * 新建那条的输入框：等 write 把卡片挪到原文旁边再给焦点。
   * 卡片在滚动容器里，刚建出来还在默认位置（文档下方）；这时 focus 会让浏览器
   * 把正文滚过去，作者看到的是正文跳走、卡片要往下翻才找得到。
   */
  private focusComposeInput(): void {
    if (!this.focusPending || this.composingId === null) return;
    const entry = this.cards.get(this.composingId);
    if (!entry || entry.top === undefined) return;
    const input = entry.el.querySelector<HTMLTextAreaElement>(".wt-comment-reply-input");
    if (!input) return;
    this.focusPending = false;
    input.focus({ preventScroll: true });
  }

  private captureFocus(el: HTMLElement): { caret: number } | null {
    const focused = el.ownerDocument.activeElement;
    if (
      focused instanceof HTMLTextAreaElement &&
      focused.hasClass("wt-comment-reply-input") &&
      el.contains(focused)
    ) {
      return { caret: focused.selectionStart ?? focused.value.length };
    }
    return null;
  }

  private restoreFocus(el: HTMLElement, focus: { caret: number }): void {
    const input = el.querySelector<HTMLTextAreaElement>(".wt-comment-reply-input");
    if (!input) return;
    // 重建的卡还没写位置，同样不能让浏览器跟着滚
    input.focus({ preventScroll: true });
    const pos = Math.min(focus.caret, input.value.length);
    input.setSelectionRange(pos, pos);
  }

  private buildCard(
    item: CommentPanelItem,
    expanded: boolean,
    composing: boolean,
    draft: string
  ): HTMLElement {
    const fresh = composing && item.messages.length === 0;
    const classes = ["wt-mcard", item.turn === "author" ? "is-your-turn" : "is-agent-turn"];
    if (expanded) classes.push("is-expanded");
    const card = createDiv({
      cls: classes.join(" "),
      attr: { "data-wt-cid": String(item.id) },
    });
    const head = card.createDiv({ cls: "wt-mcard-head" });
    head.createSpan({ cls: "wt-mcard-id", text: `#${item.id}` });
    head.createSpan({
      cls:
        item.turn === "agent" && !fresh ? "wt-comment-chip is-resolved" : "wt-comment-chip",
      text: fresh
        ? "新批注"
        : item.gone
          ? "原文已删除"
          : item.locatedLine === null
            ? "无法定位"
            : COMMENT_TURN_LABELS[item.turn],
    });
    if (!expanded && item.suggestion?.status === "ready") {
      head.createSpan({
        cls: "wt-mcard-flag",
        text: "建议",
        attr: { title: "有一条修改建议等你采纳" },
      });
    }

    if (expanded) {
      const close = head.createEl("button", {
        cls: "wt-mcard-close",
        text: "收起",
        attr: { title: "收起（Esc）" },
      });
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        this.collapse();
      });
      const path = this.path;
      if (path) {
        renderThreadBody(card, item, {
          host: this.config.host,
          docPath: path,
          drafts: this.config.drafts,
          onClosed: () => this.collapse(),
          composing,
        });
      }
      return card;
    }

    const last = item.messages[item.messages.length - 1];
    card.createDiv({
      cls: "wt-mcard-last",
      text: last
        ? `${COMMENT_SPEAKER_LABELS[last.by]}：${truncate(last.text, 120)}`
        : draft
          ? `草稿：${truncate(draft, 120)}`
          : "（空白注）",
    });
    card.setAttr("role", "button");
    card.setAttr("tabindex", "0");
    card.setAttr("title", "展开这条批注");
    card.addEventListener("click", () => this.expand(item.id));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.expand(item.id);
      }
    });
    return card;
  }

  /* ---------- 测量与排布 ---------- */

  private schedule(): void {
    if (this.destroyed) return;
    this.view.requestMeasure<Measured>({
      key: this,
      read: () => this.read(),
      write: (measured) => this.write(measured),
    });
  }

  private read(): Measured {
    const view = this.view;
    const scroller = view.scrollDOM;
    const style = getComputedStyle(scroller);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = (parseFloat(style.paddingRight) || 0) - this.appliedReserve;
    const maxWidth = getComputedStyle(view.contentDOM).maxWidth;
    const lineWidth =
      maxWidth && maxWidth !== "none" && Number.isFinite(parseFloat(maxWidth))
        ? parseFloat(maxWidth)
        : Infinity;
    const plan = planMarginSpace({
      clientWidth: scroller.clientWidth,
      padLeft,
      padRight,
      lineWidth,
    });
    const wanted =
      this.config.enabled() &&
      this.path !== null &&
      !isSidecarPath(this.path) &&
      (this.cards.size > 0 || this.composingId !== null);
    const empty: Measured = { plan, padRight, show: false, left: 0, slots: [] };
    if (!wanted || !plan.available) return empty;

    const scrollRect = scroller.getBoundingClientRect();
    const originTop = scrollRect.top - scroller.scrollTop;
    const originLeft = scrollRect.left - scroller.scrollLeft;
    // 让位刚改过时正文还没挪：按规划推算正文右边缘，下一轮测量再按实测校正
    const contentRect = view.contentDOM.getBoundingClientRect();
    const left = contentRect.right - originLeft + MARGIN_GAP;
    const positions = new Map(
      commentAnchorPositions(view.state).map((p) => [p.id, p])
    );
    const docTop = view.documentTop - originTop;
    const slots: CardSlot[] = [];
    for (const [id, entry] of this.cards) {
      const pos = positions.get(id);
      const desired =
        pos === undefined
          ? null
          : docTop + view.lineBlockAt(Math.min(pos.from, view.state.doc.length)).top;
      slots.push({ id, desired, height: entry.el.offsetHeight });
    }
    return { plan, padRight, show: true, left, slots };
  }

  private write(measured: Measured): void {
    if (this.destroyed) return;
    this.plan = measured.plan;
    const reserve = measured.show ? measured.plan.reserve : 0;
    let again = false;
    if (reserve !== this.appliedReserve) {
      // 沉浸模式给滚动容器写了带 !important 的内边距，这里也得带上才压得过
      if (reserve > 0) {
        this.view.scrollDOM.style.setProperty(
          "padding-right",
          `${measured.padRight + reserve}px`,
          "important"
        );
      } else {
        this.view.scrollDOM.style.removeProperty("padding-right");
      }
      this.appliedReserve = reserve;
      again = true;
    }
    this.root.toggleClass("is-hidden", !measured.show);
    if (measured.show !== this.shown) {
      // 刚显示出来：卡片高度之前量不到（display: none），再量一轮
      this.shown = measured.show;
      again = again || measured.show;
    }
    if (measured.show) {
      const tops = layoutCards(measured.slots, this.expandedId);
      const left = Math.round(measured.left);
      for (const [id, rawTop] of tops) {
        const entry = this.cards.get(id);
        if (!entry) continue;
        const top = Math.round(rawTop);
        if (entry.top !== top) {
          entry.el.style.top = `${top}px`;
          entry.top = top;
        }
        if (entry.left !== left) {
          entry.el.style.left = `${left}px`;
          entry.el.style.width = `${MARGIN_CARD_WIDTH}px`;
          entry.left = left;
        }
      }
      this.focusComposeInput();
    }
    if (again) this.schedule();
  }
}

/** 页边卡的编辑器扩展：插件本体 + 点回正文收起（Esc 由批注模块在 window 层接）。 */
export function buildMarginExtension(config: CommentMarginConfig): Extension {
  const plugin = ViewPlugin.define((view) => new MarginView(view, config));
  currentMarginPlugin = plugin;
  const handlers = EditorView.domEventHandlers({
    mousedown: (event, view) => {
      // 点批注标记 / 脚注号是要展开别的卡，交给标记的点击处理；点别处 = 回到正文写作
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(".wt-comment-mark, .wt-cnote")
      ) {
        return false;
      }
      view.plugin(plugin)?.collapse();
      return false;
    },
  });
  return [plugin, handlers];
}
