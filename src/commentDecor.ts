/**
 * 编辑器内的批注层：
 *  - 原文上的底色标记 + 行尾的脚注序号（点它们打开批注弹层）；
 *  - 正文里不再挂任何卡片：批注列表、编辑、删除、标记已处理都集中在
 *    工具箱侧栏的「批注」标签，避免同一批批注在正文旁与侧栏里重复出现。
 *
 * 实现要点（踩过坑，别改回去）：
 * 1. 装饰一律由 StateField 提供：块级装饰不允许来自 ViewPlugin（CM6 会抛
 *    RangeError），状态字段还保证装饰在视口计算之前就已确定；数据变化时
 *    由 dispatchCommentRefresh 触发重建；
 * 2. 输入法拼字（composing）期间不能 dispatch，dispatchCommentRefresh
 *    会稍后重试，否则会打断正在输入的拼音。
 * 3. 作者在编辑器里改正文时，批注位置靠 CodeMirror 的改动映射跟着走
 *    （anchorField），而不是每次按键都拿「原文」重新全文找——原文一改就找不到了。
 *    停手一会儿 / 失焦 / 换文件时，把这处现在的文字交给 onAnchorsEdited 写进「现文」；
 *    整段删掉的记为「原文已删除」。不是用户输入产生的改动（外部改文件后重载）
 *    不做映射，回到按文字定位。
 */
import {
  EditorState,
  Extension,
  Range,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import {
  COMMENT_SPEAKER_LABELS,
  COMMENT_TURN_LABELS,
  commentTurn,
  lastMessage,
  LOCATE_VIA_LABELS,
  LocateVia,
  LocatedComment,
  WtComment,
  isSidecarPath,
  locateAll,
  paragraphAt,
} from "./comments";
import {
  commentBuilt,
  commentDecorDiag,
  commentError,
  commentRefreshDispatched,
  commentSkip,
} from "./diagnostics";

export interface CommentDecorConfig {
  /** 批注功能总开关（关闭时正文里不显示任何批注痕迹）。 */
  enabled(): boolean;
  /** 取某文档已缓存的批注（未加载返回 undefined）。 */
  getComments(path: string): WtComment[] | undefined;
  /** 触发异步加载（加载完成后由 main 调 dispatchCommentRefresh）。 */
  ensureLoaded(path: string): void;
  /** 点击原文标记 / 脚注号：在侧栏批注面板里定位到这张卡片。 */
  onRevealComment(path: string, comment: WtComment): void;
  /** 作者在编辑器里改动了批注对应的文字（停手后批量交付）。 */
  onAnchorsEdited?(path: string, edits: AnchorEdit[]): void;
}

/** 编辑器里跟踪到的一处批注位置变化。 */
export interface AnchorEdit {
  id: number;
  /** 这处现在的文字；gone 时为空 */
  text: string;
  /** 原文被整段删掉 */
  gone: boolean;
  /** 现在所在（或删除处所在）的整段 */
  paragraph: string;
  paragraphHint: number;
  lineHint: number;
}

/** 编辑器里正在跟踪的一条批注位置。 */
interface TrackedAnchor {
  from: number;
  to: number;
  /** 上次同步（按文字定位）时这一处的文字；不同就说明作者改过 */
  base: string;
  /** 被整段删掉；at 是删除处 */
  gone: boolean;
}

/** 停手多久后把改动写回「现文」 */
const ANCHOR_FLUSH_DELAY = 1500;

/** 外部数据变化时，用它让打开的编辑器重建标记与脚注号。 */
export const commentRefreshEffect = StateEffect.define<null>();

export function dispatchCommentRefresh(view: EditorView | undefined): void {
  if (!view) return;
  if (view.composing) {
    // 输入法拼字期间 dispatch 会打断输入，稍后重试
    commentDecorDiag.composingDeferred++;
    window.setTimeout(() => dispatchCommentRefresh(view), 400);
    return;
  }
  const t0 = performance.now();
  try {
    view.dispatch({ effects: commentRefreshEffect.of(null) });
    commentRefreshDispatched(performance.now() - t0);
  } catch (error) {
    // 视图已销毁等情况：忽略，但要留痕（自检报告里能看到）
    commentError("dispatchCommentRefresh", error);
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** 读当前编辑器对应的文档路径；编辑器信息字段尚未就绪时返回 null。 */
function readDocPath(state: EditorState): string | null {
  try {
    return state.field(editorInfoField, false)?.file?.path ?? null;
  } catch {
    // 极端初始化顺序下字段可能还没就绪；loaderPlugin 稍后会补发刷新
    return null;
  }
}

/** 迁移定位（原文已被改写）的批注：标记用虚线，提示文案也不同。 */
function isMigrated(via: LocateVia): boolean {
  return via === "residue" || via === "paragraph";
}

function commentTitle(comment: WtComment, via: LocateVia | null): string {
  const last = lastMessage(comment);
  const base = `批注 ${comment.id}（${COMMENT_TURN_LABELS[commentTurn(comment)]}）${
    last
      ? `\n${COMMENT_SPEAKER_LABELS[last.by]}：${truncate(last.text, 90)}`
      : "：（空白注）"
  }`;
  return via && isMigrated(via)
    ? `${base}\n${LOCATE_VIA_LABELS[via]}`
    : base;
}

function sameMessages(a: WtComment, b: WtComment): boolean {
  if (a.messages.length !== b.messages.length) return false;
  return a.messages.every(
    (m, i) => m.by === b.messages[i].by && m.text === b.messages[i].text
  );
}

/* ---------- 行尾脚注序号（正文里唯一的批注入口） ---------- */

class CommentChipWidget extends WidgetType {
  constructor(
    private readonly comment: WtComment,
    private readonly via: LocateVia,
    private readonly config: CommentDecorConfig
  ) {
    super();
  }

  eq(other: CommentChipWidget): boolean {
    return (
      other.comment.id === this.comment.id &&
      other.via === this.via &&
      // tooltip（title）里含最后一条消息、class 由轮到谁决定，对话变了必须重建，
      // 否则续用旧 DOM、悬停看到的还是改前的文字。
      sameMessages(other.comment, this.comment)
    );
  }

  toDOM(): HTMLElement {
    // 用 Obsidian 的全局 createSpan()（它**不**自动 append，只建元素）——
    // 官方审查规则 prefer-create-el 要求别用 document.createElement
    const span = createSpan();
    const classes = ["wt-cnote"];
    // 等作者的高亮（is-pending），等 Agent 的变淡（沿用旧「已处理」样式）
    if (commentTurn(this.comment) === "agent") classes.push("is-resolved");
    else classes.push("is-pending");
    if (isMigrated(this.via)) classes.push("is-migrated");
    span.className = classes.join(" ");
    span.setAttribute("data-wt-cid", String(this.comment.id));
    span.textContent = String(this.comment.id);
    span.title = commentTitle(this.comment, this.via);
    return span;
  }
}

/* ---------- 装饰集合构建（由状态字段调用） ---------- */

/** 按文字定位，建立这篇文档的跟踪表（只跟踪真正圈住了一段文字的批注）。 */
function syncAnchors(
  state: EditorState,
  config: CommentDecorConfig
): Map<number, TrackedAnchor> {
  const anchors = new Map<number, TrackedAnchor>();
  if (!config.enabled()) return anchors;
  const path = readDocPath(state);
  if (!path || isSidecarPath(path)) return anchors;
  const comments = config.getComments(path);
  if (!comments || comments.length === 0) return anchors;
  const docText = state.doc.toString();
  for (const item of locateAll(docText, comments)) {
    if (item.comment.gone || item.via === "paragraph" || item.to <= item.from) {
      continue;
    }
    anchors.set(item.comment.id, {
      from: item.from,
      to: item.to,
      base: docText.slice(item.from, item.to),
      gone: false,
    });
  }
  return anchors;
}

/** 作者亲手造成的改动（打字、删除、粘贴、拖放、撤销……）才做位置映射。 */
function isUserEdit(tr: Transaction): boolean {
  return ["input", "delete", "move", "undo", "redo"].some((event) =>
    tr.isUserEvent(event)
  );
}

function mapAnchors(
  anchors: Map<number, TrackedAnchor>,
  tr: Transaction
): Map<number, TrackedAnchor> {
  const next = new Map<number, TrackedAnchor>();
  for (const [id, anchor] of anchors) {
    if (anchor.gone) {
      const at = tr.changes.mapPos(anchor.from, -1);
      next.set(id, { ...anchor, from: at, to: at });
      continue;
    }
    // 两头往里收：在原文紧前 / 紧后打的字不算进批注
    const from = tr.changes.mapPos(anchor.from, 1);
    const to = tr.changes.mapPos(anchor.to, -1);
    if (to <= from) {
      next.set(id, { ...anchor, from, to: from, gone: true });
    } else {
      next.set(id, { ...anchor, from, to });
    }
  }
  return next;
}

/** 跟踪表里和上次同步不一样的那些批注 → 交给宿主写回现文。 */
function collectAnchorEdits(
  state: EditorState,
  anchors: ReadonlyMap<number, TrackedAnchor>
): AnchorEdit[] {
  const edits: AnchorEdit[] = [];
  let docText: string | null = null;
  for (const [id, anchor] of anchors) {
    const text = anchor.gone ? "" : state.sliceDoc(anchor.from, anchor.to);
    if (!anchor.gone && text === anchor.base) continue;
    docText ??= state.doc.toString();
    const paragraph = paragraphAt(docText, anchor.from);
    edits.push({
      id,
      text,
      gone: anchor.gone,
      paragraph: paragraph?.text.trim() ?? "",
      paragraphHint: paragraph?.index ?? 0,
      lineHint: state.doc.lineAt(Math.min(anchor.from, state.doc.length)).number,
    });
  }
  return edits;
}

/** 最近一次 buildCommentExtensions 建的跟踪表字段（检查脚本读跟踪结果用）。 */
let currentAnchorField: StateField<Map<number, TrackedAnchor>> | null = null;

/** 这个编辑器状态里，作者改过、还没写回的批注位置（只读，不交付）。 */
export function pendingAnchorEdits(state: EditorState): AnchorEdit[] {
  const anchors = currentAnchorField
    ? state.field(currentAnchorField, false)
    : undefined;
  return anchors ? collectAnchorEdits(state, anchors) : [];
}

function buildDecorations(
  state: EditorState,
  config: CommentDecorConfig,
  anchors?: ReadonlyMap<number, TrackedAnchor>
): DecorationSet {
  // 诊断：每条「为什么没走到构建」的判据都记一笔，供内部批注诊断报告使用
  const startedAt = performance.now();
  const finish = (reason: string | null, set: DecorationSet, extra?: {
    located: number; via: Record<string, number>; marks: number; chips: number;
  }): DecorationSet => {
    const path = readDocPath(state);
    if (reason) commentSkip(reason, path);
    else if (extra) {
      commentBuilt({ path: path ?? "（未知）", ms: performance.now() - startedAt, ...extra });
    }
    return set;
  };

  if (!config.enabled()) return finish("批注总开关关闭", Decoration.none);
  const path = readDocPath(state);
  if (!path) return finish("拿不到文档路径（editorInfoField 未就绪）", Decoration.none);
  if (isSidecarPath(path)) return finish("当前文件是批注文件本身", Decoration.none);
  const comments = config.getComments(path);
  if (!comments) return finish("缓存未加载（还没预加载过这篇的批注）", Decoration.none);
  if (comments.length === 0) return finish("这篇文档没有批注", Decoration.none);

  const docText = state.doc.toString();
  // 正在跟踪的批注用映射后的位置（作者改了字也跟得住），其余照旧按文字定位
  const untracked = anchors
    ? comments.filter((c) => !anchors.has(c.id))
    : comments;
  const located: LocatedComment[] = locateAll(docText, untracked);
  if (anchors) {
    for (const c of comments) {
      const anchor = anchors.get(c.id);
      if (!anchor) continue;
      const at = Math.min(anchor.from, state.doc.length);
      located.push({
        comment: c,
        from: at,
        to: anchor.gone ? at : Math.min(anchor.to, state.doc.length),
        via: anchor.gone ? "paragraph" : "present",
        lineFrom: state.doc.lineAt(at).number,
        lineTo: state.doc.lineAt(Math.min(anchor.to, state.doc.length)).number,
      });
    }
  }
  if (located.length === 0) {
    return finish(`定位失败：${comments.length} 条批注都没找到锚点`, Decoration.none);
  }

  const ranges: Range<Decoration>[] = [];
  const viaCount: Record<string, number> = {};
  let marks = 0;
  let chips = 0;

  // 正文里只有这两样痕迹：原文底色标记 + 行尾脚注序号；卡片都在工具箱面板。
  for (const item of located) {
    const c = item.comment;
    const migrated = isMigrated(item.via);
    viaCount[item.via] = (viaCount[item.via] ?? 0) + 1;
    if (item.to > item.from && item.via !== "paragraph") {
      const classes = ["wt-comment-mark"];
      if (commentTurn(c) === "agent") classes.push("is-resolved");
      if (migrated) classes.push("is-migrated");
      ranges.push(
        Decoration.mark({
          class: classes.join(" "),
          attributes: {
            "data-wt-cid": String(c.id),
            title: commentTitle(c, item.via),
          },
        }).range(item.from, item.to)
      );
      marks++;
    }
    const chipPos = item.to > item.from ? item.to : item.from;
    ranges.push(
      Decoration.widget({
        widget: new CommentChipWidget(c, item.via, config),
        side: 1,
      }).range(chipPos)
    );
    chips++;
  }

  return finish(null, Decoration.set(ranges, true), {
    located: located.length,
    via: viaCount,
    marks,
    chips,
  });
}

/* ---------- 扩展入口 ---------- */

export function buildCommentExtensions(config: CommentDecorConfig): Extension {
  // 批注位置跟踪表：数据刷新 / 换文件 / 外部改动时按文字重新同步，作者输入时按改动映射。
  const anchorField = StateField.define<Map<number, TrackedAnchor>>({
    create: (state) => syncAnchors(state, config),
    update(value, tr) {
      const refresh = tr.effects.some((e) => e.is(commentRefreshEffect));
      if (refresh || readDocPath(tr.startState) !== readDocPath(tr.state)) {
        return syncAnchors(tr.state, config);
      }
      if (!tr.docChanged) return value;
      return isUserEdit(tr) ? mapAnchors(value, tr) : syncAnchors(tr.state, config);
    },
  });

  currentAnchorField = anchorField;

  // 标记 + 脚注号都由状态字段提供，数据变化时由 dispatchCommentRefresh 重建。
  const decorField = StateField.define<DecorationSet>({
    create: (state) => {
      commentDecorDiag.createCalls++;
      return buildDecorations(state, config, state.field(anchorField, false));
    },
    update(value, tr) {
      const refresh = tr.effects.some((e) => e.is(commentRefreshEffect));
      if (
        tr.docChanged ||
        refresh ||
        readDocPath(tr.startState) !== readDocPath(tr.state)
      ) {
        commentDecorDiag.eligible++;
        return buildDecorations(
          tr.state,
          config,
          tr.state.field(anchorField, false)
        );
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // 停手 / 失焦 / 换文件 / 关闭时，把作者改过的批注位置交给宿主写回「现文」。
  const anchorFlusher = ViewPlugin.fromClass(
    class {
      private timer = 0;
      /** 有改动还没交付 */
      private pending = false;
      /** 已交付过的结果（id → 文字 / 已删除），避免同样的改动反复写盘 */
      private sent = new Map<number, string>();
      constructor(private readonly view: EditorView) {}
      update(update: ViewUpdate): void {
        const oldPath = readDocPath(update.startState);
        if (oldPath !== readDocPath(update.state)) {
          // 换文件：旧文档的跟踪表在 startState 里，先把它交付掉
          window.clearTimeout(this.timer);
          this.flush(update.startState);
          this.sent.clear();
          return;
        }
        const resynced = update.transactions.some(
          (tr) =>
            tr.effects.some((e) => e.is(commentRefreshEffect)) ||
            (tr.docChanged && !isUserEdit(tr))
        );
        if (resynced) {
          // 跟踪表刚按文字重新同步过：还没交付的改动在 startState 里，先交付再作废去重记录
          if (this.pending) {
            window.clearTimeout(this.timer);
            this.pending = false;
            this.flush(update.startState);
          }
          this.sent.clear();
        }
        if (update.docChanged && update.transactions.some(isUserEdit)) {
          window.clearTimeout(this.timer);
          this.pending = true;
          this.timer = window.setTimeout(() => {
            this.pending = false;
            this.flush(this.view.state);
          }, ANCHOR_FLUSH_DELAY);
        }
      }
      flushNow(): void {
        window.clearTimeout(this.timer);
        this.pending = false;
        this.flush(this.view.state);
      }
      destroy(): void {
        window.clearTimeout(this.timer);
        this.flush(this.view.state);
      }
      private flush(state: EditorState): void {
        if (!config.onAnchorsEdited) return;
        const path = readDocPath(state);
        if (!path || isSidecarPath(path)) return;
        const anchors = state.field(anchorField, false);
        if (!anchors || anchors.size === 0) return;
        const edits = collectAnchorEdits(state, anchors).filter((edit) => {
          const key = edit.gone ? "\u0000gone" : edit.text;
          if (this.sent.get(edit.id) === key) return false;
          this.sent.set(edit.id, key);
          return true;
        });
        if (edits.length === 0) return;
        try {
          config.onAnchorsEdited(path, edits);
        } catch (error) {
          commentError("onAnchorsEdited", error);
        }
      }
    },
    {
      eventHandlers: {
        blur() {
          this.flushNow();
        },
      },
    }
  );

  // 不产出装饰的小插件，只做两件事：
  //  - 预加载当前文档的批注（加载完成后 main 会刷新）；
  //  - 编辑器刚就绪 / 换文件时，稍后补发一次刷新，保证批注不依赖
  //    状态字段 create 时「编辑器信息是否已就绪」的初始化顺序。
  const loaderPlugin = ViewPlugin.fromClass(
    class {
      private lastPath: string | null | undefined;
      constructor(private readonly view: EditorView) {}
      update(): void {
        const path =
          this.view.state.field(editorInfoField, false)?.file?.path ?? null;
        const pathChanged = path !== this.lastPath;
        this.lastPath = path;
        if (!path || isSidecarPath(path)) return;
        if (!config.getComments(path)) config.ensureLoaded(path);
        if (pathChanged) {
          const view = this.view;
          window.setTimeout(() => dispatchCommentRefresh(view), 0);
        }
      }
    }
  );

  // 点击标记 / 脚注号跳转到侧栏卡片：mousedown 记位置，mouseup 时若没拖动过才认作一次点击，
  // 避免「拖动选择被批注的文字」时误触发跳转。
  let down: { x: number; y: number; t: number; cid: number | null } = {
    x: 0,
    y: 0,
    t: 0,
    cid: null,
  };
  const handlers = EditorView.domEventHandlers({
    mousedown: (event) => {
      down = {
        x: event.clientX,
        y: event.clientY,
        t: Date.now(),
        cid: commentIdFromEvent(event.target),
      };
      return false;
    },
    mouseup: (event, view) => {
      const cid = commentIdFromEvent(event.target);
      if (cid === null || cid !== down.cid) return false;
      if (
        Math.abs(event.clientX - down.x) + Math.abs(event.clientY - down.y) > 4
      ) {
        return false;
      }
      if (Date.now() - down.t > 600) return false;
      const path = view.state.field(editorInfoField, false)?.file?.path ?? null;
      if (!path) return false;
      const comments = config.getComments(path) ?? [];
      const found = comments.find((c) => c.id === cid);
      if (!found) return false;
      config.onRevealComment(path, found);
      return false;
    },
  });

  return [anchorField, decorField, anchorFlusher, loaderPlugin, handlers];
}

function commentIdFromEvent(target: EventTarget | null): number | null {
  if (!(target instanceof HTMLElement)) return null;
  const el = target.closest(".wt-comment-mark, .wt-cnote");
  if (!el) return null;
  const raw = el.getAttribute("data-wt-cid");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}
