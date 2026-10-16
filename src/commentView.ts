/**
 * 批注面板：当前文档的批注列表与管理入口。
 *
 * 渲染逻辑在 CommentPanelBody 里，挂在工具箱侧栏的「批注」标签上
 * （标签上有计数徽标）。批注面板不单独做视图：入口统一在工具箱里。
 *
 * 与 main 之间通过 CommentPanelHost 接口对接（避免循环 import）。
 */
import { setIcon } from "obsidian";
import {
  COMMENT_STATUS_LABELS,
  CommentStatus,
  LOCATE_VIA_LABELS,
  LocateVia,
} from "./comments";

export interface CommentPanelItem {
  id: number;
  status: CommentStatus;
  quote: string;
  content: string;
  reply: string;
  lineHint: number;
  createdAt: string;
  /** 当前定位到的行号；null 表示找不到原文 */
  locatedLine: number | null;
  /** 定位方式；null 表示锚点失效（原文已改写，需要重新绑定） */
  via: LocateVia | null;
}

export interface CommentPanelModel {
  docPath: string | null;
  docName: string | null;
  /** 批注还在异步读取中 */
  loading: boolean;
  items: CommentPanelItem[];
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
export interface CommentPanelHost {
  /** 读当前活动文档的批注（异步，含定位信息）。 */
  getCommentPanelModel(): Promise<CommentPanelModel>;
  jumpToComment(docPath: string, id: number): void;
  toggleCommentResolved(docPath: string, id: number): void;
  /** 编辑某条批注（屏幕居中的输入框）。 */
  editComment(docPath: string, id: number): void;
  /** 删除某条批注（删掉后可在提示里撤销）。 */
  deleteComment(docPath: string, id: number): void;
  /** 锚点失效的批注：进入「重新绑定」流程（在正文里选中新位置）。 */
  rebindComment(docPath: string, id: number): void;
  /** 清除已处理批注；docPath 省略时作用于当前活动文档（命令面板入口用）。 */
  clearResolvedComments(docPath?: string): void;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/**
 * 面板展示顺序：待处理在前、已处理垫底；组内按正文位置排（找不到原文的排最后），
 * 同一位置按编号。只影响面板展示，批注文件里仍按编号排列。
 */
function byDisplayOrder(a: CommentPanelItem, b: CommentPanelItem): number {
  const la = a.locatedLine ?? Number.MAX_SAFE_INTEGER;
  const lb = b.locatedLine ?? Number.MAX_SAFE_INTEGER;
  return la !== lb ? la - lb : a.id - b.id;
}

/**
 * 批注面板渲染体：往给定容器里画「标题 + 计数 + 卡片列表 + 底部按钮」。
 * 数据一律经 host 获取；独立视图与工具箱标签都复用它。
 */
export class CommentPanelBody {
  /** 渲染代数：异步读取晚到时，若已有更新的渲染启动就丢弃本次结果 */
  private renderSeq = 0;
  /**
   * 最近一次渲染的内容签名：内容没变时跳过重绘。
   * 焦点切换、切回侧栏都会触发刷新，但数据往往没变；重建 DOM 会把用户
   * 正点着的卡片从文档里换掉，吃掉这次点击（表现为「要点两次才跳」）。
   */
  private lastSig: string | null = null;

  /** 「只看待处理」筛选（面板实例级状态，重建面板后复位） */
  private pendingOnly = false;
  /** 「已处理」分组是否折叠：默认折叠，把已处理项沉到底部 */
  private resolvedCollapsed = true;
  /**
   * 最近一次渲染对应的文档路径。
   * 面板上的所有操作都带这个路径回传给宿主，**不依赖「当前活动文档」**——
   * 否则焦点一飘走（侧栏、别的标签页）就可能操作到另一篇文档的批注。
   */
  private docPath: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: CommentPanelHost
  ) {}

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

  /**
   * 滚动到某条批注的卡片并闪一下（正文里点标记 / 脚注号时用）。
   * 卡片可能被「只看待处理」或「已处理」折叠挡住，先把这些过滤放开。
   */
  async revealCard(id: number, scroller?: HTMLElement | null): Promise<void> {
    let needsRender = false;
    if (this.pendingOnly) {
      this.pendingOnly = false;
      needsRender = true;
    }
    if (this.resolvedCollapsed) {
      // 已处理的项可能就藏在这个折叠分组里，先把它展开
      this.resolvedCollapsed = false;
      needsRender = true;
    }
    if (needsRender) await this.renderAsync();

    const card = this.root.querySelector<HTMLElement>(`[data-wt-cid="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "nearest" });
    void scroller?.scrollHeight;
    card.addClass("is-revealed");
    card.addEventListener(
      "animationend",
      () => card.removeClass("is-revealed"),
      { once: true }
    );
  }

  /** 让还在路上的异步渲染失效（视图关闭 / 容器重建时调用）。 */
  destroy(): void {
    this.renderSeq++;
  }

  /** 面板内容签名：文档路径 / 名称 / 读取状态 + 每条批注的全部展示字段。 */
  private modelSignature(model: CommentPanelModel): string {
    const itemSig = model.items
      .map((i) =>
        [
          i.id,
          i.status,
          i.quote,
          i.content,
          i.reply,
          i.locatedLine === null ? "x" : i.locatedLine,
          i.via ?? "none",
        ].join("\u0001")
      )
      .join("\u0002");
    return [
      model.docPath ?? "",
      model.docName ?? "",
      model.loading ? "1" : "0",
      this.pendingOnly ? "p" : "-",
      this.resolvedCollapsed ? "c" : "-",
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
      model = { docPath: null, docName: null, loading: false, items: [] };
    }
    if (seq !== this.renderSeq) return;
    const root = this.root;
    // 先记住本次渲染对应的文档：即使下面因签名相同而跳过重绘，
    // 后续操作的 docPath 也必须是新的（签名里含 docPath，换文档不会命中同一签名）。
    this.docPath = model.docPath;
    const sig = this.modelSignature(model);
    if (sig === this.lastSig && root.children.length > 0) return;
    this.lastSig = sig;
    const scroller = this.scrollContainer();
    const keepTop = scroller?.scrollTop ?? 0;
    root.empty();

    if (!model.docPath) {
      root.createDiv({
        cls: "wt-comments-empty",
        text: "打开一篇文档后，这里会显示它的批注。",
      });
      this.restoreScroll(scroller, keepTop);
      return;
    }

    const pending = model.items
      .filter((i) => i.status === "pending")
      .sort(byDisplayOrder);
    const resolved = model.items
      .filter((i) => i.status === "resolved")
      .sort(byDisplayOrder);
    const head = root.createDiv({ cls: "wt-comments-head" });
    head.createDiv({ cls: "wt-comments-title", text: model.docName ?? "" });
    head.createDiv({
      cls: "wt-comments-sub",
      text: model.loading
        ? "读取中…"
        : `共 ${model.items.length} 条 · 待处理 ${pending.length} · 已处理 ${
            resolved.length
          }`,
    });

    if (!model.loading && model.items.length === 0) {
      root.createDiv({
        cls: "wt-comments-empty",
        text: "还没有批注。选中文字后点气泡上的批注按钮，或右键「添加批注」。",
      });
    }

    // 「只看待处理」筛选：有已处理项时才给这个开关
    if (!model.loading && resolved.length > 0) {
      const tools = root.createDiv({ cls: "wt-comments-tools" });
      const filterBtn = tools.createEl("button", {
        cls: "wt-comments-filter",
        text: this.pendingOnly ? "显示全部" : "只看待处理",
      });
      filterBtn.addEventListener("click", () => {
        this.pendingOnly = !this.pendingOnly;
        this.refresh();
      });
    }

    // 待处理在前（组内按正文位置）；已处理收进底部折叠分组
    if (!model.loading && model.items.length > 0) {
      if (pending.length === 0) {
        root.createDiv({
          cls: "wt-comments-empty is-small",
          text: this.pendingOnly
            ? "没有待处理的批注（已处理项已隐藏）。"
            : "没有待处理的批注。",
        });
      } else {
        for (const item of pending) {
          this.renderCard(root, item);
        }
      }
    }

    if (!this.pendingOnly && resolved.length > 0) {
      this.renderResolvedGroup(root, resolved);
    }

    // 底部工具行：只有「清除已处理」，没有已处理批注时不占位
    if (resolved.length > 0) {
      const foot = root.createDiv({ cls: "wt-comments-footer" });
      const clearBtn = foot.createEl("button", { text: "清除已处理" });
      clearBtn.addEventListener("click", () =>
        // 传面板自己的文档路径：不能让它去猜「当前活动文档」（可能已经飘到别处）
        this.host.clearResolvedComments(model.docPath ?? undefined)
      );
    }
    this.restoreScroll(scroller, keepTop);
  }

  /** 已处理分组：标题带数量、点击展开 / 收起（默认折叠）。 */
  private renderResolvedGroup(
    root: HTMLElement,
    items: readonly CommentPanelItem[]
  ): void {
    const group = root.createDiv({ cls: "wt-comments-group" });
    if (this.resolvedCollapsed) group.addClass("is-collapsed");
    const head = group.createDiv({
      cls: "wt-comments-group-head",
      attr: { title: "展开 / 收起已处理的批注" },
    });
    setIcon(
      head.createSpan({ cls: "wt-comments-group-chevron" }),
      "chevron-down"
    );
    head.createSpan({
      cls: "wt-comments-group-title",
      text: `已处理 ${items.length} 条`,
    });
    head.addEventListener("click", () => {
      this.resolvedCollapsed = !this.resolvedCollapsed;
      group.toggleClass("is-collapsed", this.resolvedCollapsed);
    });
    const body = group.createDiv({ cls: "wt-comments-group-body" });
    for (const item of items) {
      this.renderCard(body, item);
    }
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

  private renderCard(root: HTMLElement, item: CommentPanelItem): void {
    const resolved = item.status === "resolved";
    const card = root.createDiv({
      cls: resolved ? "wt-comment-card is-resolved" : "wt-comment-card",
      attr: {
        title: "点击跳到正文里的这条批注位置",
        // 正文里点批注标记时靠它找到这张卡片
        "data-wt-cid": String(item.id),
      },
    });
    // 整卡可点：引用、内容……任意位置都跳到正文对应位置
    card.addEventListener("click", () => this.host.jumpToComment(this.requireDocPath(), item.id));
    const head = card.createDiv({ cls: "wt-comment-card-head" });
    head.createSpan({
      cls: resolved ? "wt-comment-chip is-resolved" : "wt-comment-chip",
      text: COMMENT_STATUS_LABELS[item.status],
    });
    head.createSpan({
      cls: "wt-comment-card-loc",
      text:
        item.locatedLine === null
          ? "锚点失效（原文已大改）"
          : `第 ${item.locatedLine} 行附近${
              item.via && item.via !== "exact"
                ? ` · ${LOCATE_VIA_LABELS[item.via]}`
                : ""
            }`,
    });
    head.createSpan({ cls: "wt-comment-card-id", text: `#${item.id}` });

    card.createDiv({
      cls: "wt-comment-quote",
      text: `「${truncate(item.quote, 80)}」`,
    });

    card.createDiv({ cls: "wt-comment-content", text: item.content });
    if (item.reply.trim()) {
      this.renderReply(card, item.reply.trim());
    }

    // 卡片操作：标记已处理 / 重新打开、编辑、删除（编辑复用正文标记那套弹层，
    // 所以「找不到原文」的批注也能在面板里改）。点按钮不触发整卡的跳转。
    const row = card.createDiv({ cls: "wt-comment-card-actions" });
    const toggleBtn = row.createEl("button", {
      text: resolved ? "重新打开" : "标记已处理",
    });
    toggleBtn.addEventListener("click", (ev) => {
      // 吃掉冒泡，免得连带触发整卡的「跳转」
      ev.stopPropagation();
      this.host.toggleCommentResolved(this.requireDocPath(), item.id);
    });

    const editBtn = row.createEl("button", { text: "编辑" });
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.host.editComment(this.requireDocPath(), item.id);
    });

    const deleteBtn = row.createEl("button", {
      cls: "mod-warning",
      text: "删除",
    });
    let confirming = false;
    let resetTimer = 0;
    deleteBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!confirming) {
        // 第一次：只把文案换成同样两个字的「确认」（宽度不变），
        // 再点一次才删；3 秒不动手就自动退回「删除」。
        confirming = true;
        deleteBtn.setText("确认");
        deleteBtn.addClass("is-confirming");
        deleteBtn.setAttr("title", "再点一次删除这条批注");
        resetTimer = window.setTimeout(() => {
          confirming = false;
          deleteBtn.setText("删除");
          deleteBtn.removeClass("is-confirming");
          deleteBtn.setAttr("title", "");
        }, 3000);
        return;
      }
      window.clearTimeout(resetTimer);
      confirming = false;
      deleteBtn.setText("删除");
      deleteBtn.removeClass("is-confirming");
      this.host.deleteComment(this.requireDocPath(), item.id);
    });

    if (item.locatedLine === null) {
      const rebindBtn = row.createEl("button", {
        cls: "mod-cta",
        text: "重新绑定",
        attr: { title: "在正文里选中这条批注现在对应的位置" },
      });
      rebindBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.host.rebindComment(this.requireDocPath(), item.id);
      });
    }
  }

  /** Agent 的回复：太长时先折起来，避免一条长回复把面板撑得没法扫。 */
  private renderReply(card: HTMLElement, reply: string): void {
    const limit = 140;
    const replyEl = card.createDiv({ cls: "wt-comment-reply" });
    const textEl = replyEl.createSpan();
    if (reply.length <= limit) {
      textEl.setText(`回复：${reply}`);
      return;
    }
    let expanded = false;
    const render = () =>
      textEl.setText(expanded ? `回复：${reply}` : `回复：${reply.slice(0, limit)}…`);
    render();
    const moreBtn = replyEl.createEl("button", {
      cls: "wt-comment-reply-more",
      text: "展开",
    });
    moreBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      expanded = !expanded;
      moreBtn.setText(expanded ? "收起" : "展开");
      render();
    });
  }
}

/** 独立侧栏视图「批注」：本体只是把 CommentPanelBody 挂到视图容器上。 */
