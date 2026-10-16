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
 */
import {
  EditorState,
  Extension,
  Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import {
  COMMENT_STATUS_LABELS,
  LOCATE_VIA_LABELS,
  LocateVia,
  WtComment,
  isSidecarPath,
  locateAll,
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
}

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
  const base = `批注 ${comment.id}（${COMMENT_STATUS_LABELS[comment.status]}）：${truncate(
    comment.content || "（空白注）",
    90
  )}`;
  return via && isMigrated(via)
    ? `${base}\n${LOCATE_VIA_LABELS[via]}`
    : base;
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
      other.comment.status === this.comment.status &&
      other.via === this.via &&
      // tooltip（title）里含批注内容，所以内容/回复变了必须重建，
      // 否则续用旧 DOM、悬停看到的还是改前的文字。
      other.comment.content === this.comment.content &&
      other.comment.reply === this.comment.reply
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    const classes = ["wt-cnote"];
    if (this.comment.status === "resolved") classes.push("is-resolved");
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

function buildDecorations(
  state: EditorState,
  config: CommentDecorConfig
): DecorationSet {
  // 诊断：每条「为什么没走到构建」的判据都记一笔，供「批注：自检」报告使用
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
  const located = locateAll(docText, comments);
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
      if (c.status === "resolved") classes.push("is-resolved");
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
  // 标记 + 脚注号都由状态字段提供，数据变化时由 dispatchCommentRefresh 重建。
  const decorField = StateField.define<DecorationSet>({
    create: (state) => {
      commentDecorDiag.createCalls++;
      return buildDecorations(state, config);
    },
    update(value, tr) {
      const refresh = tr.effects.some((e) => e.is(commentRefreshEffect));
      if (
        tr.docChanged ||
        refresh ||
        readDocPath(tr.startState) !== readDocPath(tr.state)
      ) {
        commentDecorDiag.eligible++;
        return buildDecorations(tr.state, config);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

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

  return [decorField, loaderPlugin, handlers];
}

function commentIdFromEvent(target: EventTarget | null): number | null {
  if (!(target instanceof HTMLElement)) return null;
  const el = target.closest(".wt-comment-mark, .wt-cnote");
  if (!el) return null;
  const raw = el.getAttribute("data-wt-cid");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}
