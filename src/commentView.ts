/**
 * 批注面板：当前文档的批注列表与管理入口。
 *
 * 渲染逻辑在 CommentPanelBody 里，挂在工具箱侧栏的「批注」标签上
 * （标签上有计数徽标）。批注面板不单独做视图：入口统一在工具箱里。
 *
 * 两层：列表页（「等你 / 等 Agent / 全部」标签 + 每条一行，点一行跳正文并进详情）
 * 与单条详情页（原文、完整对话、回复框、结案按钮；内容可选中复制，点了不跳转）。
 * 结案只有两种，都只能在详情页点：「已解决」（整条删掉）与「不采纳」
 * （删掉并记进「已否决」区，让 Agent 别再提）。
 *
 * 与 main 之间通过 CommentPanelHost 接口对接（避免循环 import）。
 */
import {
  COMMENT_SPEAKER_LABELS,
  COMMENT_TURN_LABELS,
  CommentMessage,
  CommentSpeaker,
  CommentTurn,
  LocateVia,
} from "./comments";
import {
  CommentDrafts,
  CommentThreadHost,
  locationText,
  renderThreadBody,
} from "./commentThread";

/** 最新一条建议现在能不能采纳 */
export type SuggestionStatus =
  | "ready"
  | "adopted"
  | "missing"
  | "ambiguous"
  | "locked";

/** 最新一条修改建议的状态（只有它能采纳，更早的显示「已被新建议取代」）。 */
export interface CommentPanelSuggestion {
  /** 带建议的那条消息在对话里的下标 */
  index: number;
  status: SuggestionStatus;
  /** 采纳不了时给作者看的原因；能采纳时为空 */
  reason: string;
  /** 要被替换的正文（差异块左侧）；没写「建议原句」时是批注现在圈住的文字 */
  before: string;
}

export interface CommentPanelItem {
  id: number;
  origin: CommentSpeaker;
  quote: string;
  messages: CommentMessage[];
  /** 轮到谁（由最后一条消息推出） */
  turn: CommentTurn;
  /** 原文已被作者删掉 */
  gone: boolean;
  lineHint: number;
  createdAt: string;
  /** 当前定位到的行号；null 表示找不到原文 */
  locatedLine: number | null;
  /** 定位方式；null 表示锚点失效（原文已改写，需要重新绑定） */
  via: LocateVia | null;
  /** 最新一条修改建议；没有建议时省略 */
  suggestion?: CommentPanelSuggestion;
}

export interface CommentPanelModel {
  docPath: string | null;
  docName: string | null;
  /** 批注还在异步读取中 */
  loading: boolean;
  items: CommentPanelItem[];
  /** 「已否决」区的条数 */
  rejectedCount: number;
}

/**
 * 批注面板与宿主的接口。
 *
 * ⚠️ **所有操作都必须带上文档路径**（`docPath`），不要依赖「当前活动文档」。
 * 历史上这里只传 `id`，宿主便各自去问 `activeCommentDocPath()`——一旦焦点不在
 * 正文上（侧栏、工具箱、别的标签页），那个函数可能返回**另一篇文档**，
 * 于是「删除」会删到别的文档的批注。路径由面板在 `getCommentPanelModel()`
 * 时拿到并存下来，操作时原样传回，天然与列表内容一致。
 */
export interface CommentPanelHost extends CommentThreadHost {
  /** 读当前活动文档的批注（异步，含定位信息）。 */
  getCommentPanelModel(): Promise<CommentPanelModel>;
  jumpToComment(docPath: string, id: number): void;
  /**
   * 在正文旁边的页边卡里打开这条（滚到那处并展开）；页边放不下 / 没有这篇的编辑器时返回 false，
   * 面板就自己进详情页。可选：测试桩可省略。
   */
  openInMargin?(docPath: string, id: number): boolean;
  /** 复制「请 Agent 通读并发起批注」的指令；docPath 省略时作用于当前活动文档。 */
  copyReviewPrompt(docPath?: string): void;
  /** 复制「请 Agent 回复轮到它的批注」的指令；docPath 省略时作用于当前活动文档。 */
  copyReplyPrompt(docPath?: string): void;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** 列表页的标签：等你 / 等 Agent / 全部 */
type ListTab = "author" | "agent" | "all";

const TAB_LABELS: Record<ListTab, string> = {
  author: "等你",
  agent: "等 Agent",
  all: "全部",
};

/** 列表顺序：按正文位置排（找不到原文的排最后），同一位置按编号。 */
function byPosition(a: CommentPanelItem, b: CommentPanelItem): number {
  const la = a.locatedLine ?? Number.MAX_SAFE_INTEGER;
  const lb = b.locatedLine ?? Number.MAX_SAFE_INTEGER;
  return la !== lb ? la - lb : a.id - b.id;
}

/**
 * 批注面板渲染体：列表页或单条详情页。数据一律经 host 获取。
 */
export class CommentPanelBody {
  /** 渲染代数：异步读取晚到时，若已有更新的渲染启动就丢弃本次结果 */
  private renderSeq = 0;
  /**
   * 最近一次渲染的内容签名：内容没变时跳过重绘。
   * 焦点切换、切回侧栏都会触发刷新，但数据往往没变；重建 DOM 会吃掉正在进行的点击、
   * 打断选中复制，也会把正在写的回复框清空。
   */
  private lastSig: string | null = null;
  /**
   * 最近一次渲染对应的文档路径。
   * 面板上的所有操作都带这个路径回传给宿主，**不依赖「当前活动文档」**——
   * 否则焦点一飘走（侧栏、别的标签页）就可能操作到另一篇文档的批注。
   */
  private docPath: string | null = null;
  /** 没发出去的回复草稿（和页边卡共用一张表）；数据变化重绘时填回去 */
  private readonly drafts: CommentDrafts;
  /** 列表页选中的标签；null = 还没选过，按「有等你的就等你，否则全部」 */
  private tab: ListTab | null = null;
  /** 正在看的那条批注；null = 列表页 */
  private detailId: number | null = null;
  /**
   * 正文里点标记打开详情：那篇文档往往刚成为活动文档（面板还显示着上一篇），
   * 这一次渲染不能按「换了文档」把详情冲掉。
   */
  private keepDetailOnDocChange = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: CommentPanelHost,
    drafts?: CommentDrafts
  ) {
    this.drafts = drafts ?? new Map<string, string>();
  }

  /** 重建面板内容（活动文件、批注数据变化时调用）。 */
  refresh(): void {
    void this.renderAsync();
  }

  /** 当前面板对应的文档路径（供宿主判断操作对象）。 */
  getDocPath(): string | null {
    return this.docPath;
  }

  /**
   * 渲染期取文档路径：卡片只会在有文档时才会被画出来（没文档时走空状态），
   * 所以这里必然是字符串。写成断言型取值器，是为了让每个回调都显式带上路径，
   * 而不是各自去猜「当前活动文档」。
   */
  private requireDocPath(): string {
    if (!this.docPath) {
      throw new Error("批注面板：没有文档路径却要操作批注（不应发生）");
    }
    return this.docPath;
  }

  /** 打开某条批注的详情页（正文里点标记 / 脚注号时用）。 */
  async revealCard(id: number, _scroller?: HTMLElement | null): Promise<void> {
    this.detailId = id;
    this.keepDetailOnDocChange = true;
    // 新的一次渲染必须重画（视图状态变了），别被签名挡掉
    this.lastSig = null;
    await this.renderAsync();
    this.scrollContainer()?.scrollTo({ top: 0 });
  }

  /** 让还在路上的异步渲染失效（视图关闭 / 容器重建时调用）。 */
  destroy(): void {
    this.renderSeq++;
  }

  private openDetail(id: number): void {
    this.detailId = id;
    this.refresh();
  }

  private backToList(): void {
    this.detailId = null;
    this.refresh();
  }

  /** 面板内容签名：文档路径 / 名称 / 读取状态 / 视图状态 + 每条批注的全部展示字段。 */
  private modelSignature(model: CommentPanelModel): string {
    const itemSig = model.items
      .map((i) =>
        [
          i.id,
          i.origin,
          i.turn,
          i.gone ? "g" : "-",
          i.quote,
          i.messages
            .map(
              (m) =>
                `${m.by}:${m.text}` +
                (m.suggestion
                  ? `\u0005${m.suggestion.original}\u0005${m.suggestion.replacement}\u0005${m.suggestion.adopted ? 1 : 0}`
                  : "")
            )
            .join("\u0004"),
          i.locatedLine === null ? "x" : i.locatedLine,
          i.via ?? "none",
          i.suggestion
            ? `${i.suggestion.index}:${i.suggestion.status}:${i.suggestion.before}`
            : "",
        ].join("\u0001")
      )
      .join("\u0002");
    return [
      model.docPath ?? "",
      model.docName ?? "",
      model.loading ? "1" : "0",
      model.rejectedCount,
      this.tab ?? "",
      this.detailId ?? "",
      itemSig,
    ].join("\u0003");
  }

  private async renderAsync(): Promise<void> {
    const seq = ++this.renderSeq;
    let model: CommentPanelModel;
    try {
      model = await this.host.getCommentPanelModel();
    } catch (error) {
      console.error("写作工具箱：批注面板读取失败", error);
      model = {
        docPath: null,
        docName: null,
        loading: false,
        items: [],
        rejectedCount: 0,
      };
    }
    if (seq !== this.renderSeq) return;
    const root = this.root;
    // 换了文档：回到列表、标签重新按默认选
    if (model.docPath !== this.docPath) {
      if (!this.keepDetailOnDocChange) this.detailId = null;
      this.tab = null;
    }
    this.keepDetailOnDocChange = false;
    // 先记住本次渲染对应的文档：即使下面因签名相同而跳过重绘，
    // 后续操作的 docPath 也必须是新的（签名里含 docPath，换文档不会命中同一签名）。
    this.docPath = model.docPath;
    const detail =
      this.detailId === null
        ? null
        : model.items.find((i) => i.id === this.detailId) ?? null;
    // 正在看的那条已经不在了（结案 / 被删）：回列表
    if (this.detailId !== null && !detail && !model.loading) this.detailId = null;

    const sig = this.modelSignature(model);
    if (sig === this.lastSig && root.children.length > 0) return;
    this.lastSig = sig;
    const scroller = this.scrollContainer();
    const keepTop = scroller?.scrollTop ?? 0;
    // 详情页原地刷新时保住回复框的焦点与光标
    const focused = root.ownerDocument.activeElement;
    const hadReplyFocus =
      focused instanceof HTMLTextAreaElement &&
      focused.hasClass("wt-comment-reply-input") &&
      root.contains(focused);
    const caret = hadReplyFocus ? focused.selectionStart : 0;
    root.empty();

    if (!model.docPath) {
      root.createDiv({
        cls: "wt-comments-empty",
        text: "打开一篇文档后，这里会显示它的批注。",
      });
      this.restoreScroll(scroller, keepTop);
      return;
    }

    if (detail) {
      this.renderDetail(root, detail);
      if (hadReplyFocus) {
        const input = root.querySelector<HTMLTextAreaElement>(
          ".wt-comment-reply-input"
        );
        if (input) {
          input.focus();
          const pos = Math.min(caret ?? input.value.length, input.value.length);
          input.setSelectionRange(pos, pos);
        }
      }
      this.restoreScroll(scroller, keepTop);
      return;
    }

    this.renderList(root, model);
    this.restoreScroll(scroller, keepTop);
  }

  /* ---------- 列表页 ---------- */

  private renderList(root: HTMLElement, model: CommentPanelModel): void {
    const items = [...model.items].sort(byPosition);
    const counts: Record<ListTab, number> = {
      author: items.filter((i) => i.turn === "author").length,
      agent: items.filter((i) => i.turn === "agent").length,
      all: items.length,
    };
    const tab = this.tab ?? (counts.author > 0 ? "author" : "all");

    const head = root.createDiv({ cls: "wt-comments-head" });
    head.createDiv({ cls: "wt-comments-title", text: model.docName ?? "" });
    if (model.loading) {
      head.createDiv({ cls: "wt-comments-sub", text: "读取中…" });
      return;
    }
    if (model.rejectedCount > 0) {
      head.createDiv({
        cls: "wt-comments-sub",
        text: `已否决 ${model.rejectedCount}`,
        attr: { title: "不采纳的意见记在批注文件末尾，Agent 不会再提" },
      });
    }

    if (items.length === 0) {
      root.createDiv({
        cls: "wt-comments-empty",
        text: "还没有批注。选中文字后点气泡上的批注按钮、右键「添加批注」，或点下方「复制批注指令」请 Agent 来批注。",
      });
    } else {
      const tabs = root.createDiv({ cls: "wt-comments-tabs" });
      for (const key of ["author", "agent", "all"] as const) {
        const btn = tabs.createEl("button", {
          cls: key === tab ? "wt-comments-tab is-active" : "wt-comments-tab",
          text: `${TAB_LABELS[key]} ${counts[key]}`,
        });
        btn.addEventListener("click", () => {
          this.tab = key;
          this.refresh();
        });
      }

      const shown =
        tab === "all" ? items : items.filter((i) => i.turn === tab);
      if (shown.length === 0) {
        root.createDiv({
          cls: "wt-comments-empty is-small",
          text: tab === "author" ? "没有等你回复的批注。" : "没有等 Agent 回复的批注。",
        });
      }
      const list = root.createDiv({ cls: "wt-comments-list" });
      for (const item of shown) this.renderRow(list, item);
    }

    // 底部工具行：随时可请 Agent 批注；有等 Agent 的条目时可请它回复。
    const foot = root.createDiv({ cls: "wt-comments-footer" });
    const reviewBtn = foot.createEl("button", { text: "复制批注指令" });
    reviewBtn.addEventListener("click", () =>
      this.host.copyReviewPrompt(model.docPath ?? undefined)
    );
    if (counts.agent > 0) {
      const replyBtn = foot.createEl("button", { text: "复制回复指令" });
      replyBtn.addEventListener("click", () =>
        // 传面板自己的文档路径：不能让它去猜「当前活动文档」（可能已经飘到别处）
        this.host.copyReplyPrompt(model.docPath ?? undefined)
      );
    }
  }

  /** 列表里的一行：点了跳到正文并进详情。 */
  private renderRow(list: HTMLElement, item: CommentPanelItem): void {
    const row = list.createDiv({
      cls: item.turn === "agent" ? "wt-comment-row is-agent-turn" : "wt-comment-row",
      attr: {
        role: "button",
        tabindex: "0",
        title: "跳到正文这一处，并打开这条批注",
        "data-wt-cid": String(item.id),
      },
    });
    const head = row.createDiv({ cls: "wt-comment-row-head" });
    head.createSpan({ cls: "wt-comment-row-id", text: `#${item.id}` });
    head.createSpan({
      cls: "wt-comment-row-quote",
      text: `「${truncate(item.quote, 40)}」`,
    });
    if (item.gone || item.locatedLine === null) {
      head.createSpan({
        cls: "wt-comment-row-flag",
        text: item.gone ? "已删" : "失效",
        attr: { title: locationText(item) },
      });
    } else if (item.suggestion?.status === "ready") {
      head.createSpan({
        cls: "wt-comment-row-flag is-suggest",
        text: "建议",
        attr: { title: "有一条修改建议等你采纳" },
      });
    }
    const last = item.messages[item.messages.length - 1];
    if (last) {
      row.createDiv({
        cls: "wt-comment-row-last",
        text: `${COMMENT_SPEAKER_LABELS[last.by]}：${truncate(last.text, 60)}`,
      });
    }
    const open = () => {
      const docPath = this.requireDocPath();
      // 页边卡放得下：在正文旁边展开，侧栏留在列表；放不下才进详情页
      if (this.host.openInMargin?.(docPath, item.id)) return;
      this.host.jumpToComment(docPath, item.id);
      this.openDetail(item.id);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
  }

  /* ---------- 详情页 ---------- */

  /** 单条详情：内容可选中复制，点了不跳转；跳转只走「定位」按钮。 */
  private renderDetail(root: HTMLElement, item: CommentPanelItem): void {
    const box = root.createDiv({
      cls: "wt-comment-detail",
      attr: { "data-wt-cid": String(item.id) },
    });
    const bar = box.createDiv({ cls: "wt-comment-detail-bar" });
    const backBtn = bar.createEl("button", {
      cls: "wt-comment-detail-back",
      text: "← 返回",
    });
    backBtn.addEventListener("click", () => this.backToList());
    bar.createSpan({ cls: "wt-comment-card-id", text: `#${item.id}` });
    bar.createSpan({
      cls:
        item.turn === "agent" ? "wt-comment-chip is-resolved" : "wt-comment-chip",
      text: item.gone ? "原文已删除" : COMMENT_TURN_LABELS[item.turn],
    });
    const locateBtn = bar.createEl("button", {
      cls: "wt-comment-detail-locate",
      text: "定位",
      attr: { title: "回到正文里的这一处" },
    });
    locateBtn.addEventListener("click", () =>
      this.host.jumpToComment(this.requireDocPath(), item.id)
    );

    renderThreadBody(box, item, {
      host: this.host,
      docPath: this.requireDocPath(),
      drafts: this.drafts,
      onClosed: () => this.backToList(),
    });
  }

  /**
   * 面板的滚动容器：独立视图里是面板自身（overflow-y: auto），
   * 工具箱「批注」标签里是外层公共容器，往上找第一个可滚动的祖先。
   */
  private scrollContainer(): HTMLElement | null {
    let el: HTMLElement | null = this.root;
    while (el) {
      if (el.scrollHeight > el.clientHeight + 1) return el;
      el = el.parentElement;
    }
    return null;
  }

  /** 重建 DOM 后还原滚动位置，避免列表刷新时「视线被拽走」。 */
  private restoreScroll(el: HTMLElement | null, top: number): void {
    if (!el || !el.isConnected || top <= 0) return;
    el.scrollTop = top;
  }
}
