/**
 * 一条批注的「对话体」：原文引用、完整对话、修改建议、回复框、结案按钮。
 *
 * 侧栏详情页（commentView.ts）和正文旁边的页边卡（commentMargin.ts）共用这一份渲染，
 * 两处的按钮、文案、确认方式完全一致；回复草稿也共用一张表（按文档 + 批注号），
 * 在页边写了一半、到侧栏打开同一条还在。
 *
 * 所有操作都带上调用方给的 docPath，不去猜「当前活动文档」（见 CommentPanelHost 的说明）。
 */
import {
  COMMENT_SPEAKER_LABELS,
  CommentMessage,
  LOCATE_VIA_LABELS,
  diffChars,
} from "./comments";
import type { CommentPanelItem } from "./commentView";

/** 对话体用到的宿主操作（CommentPanelHost 的子集）。 */
export interface CommentThreadHost {
  /** 作者在某条批注下追加一条消息；保存成功返回 true。 */
  replyToComment(docPath: string, id: number, text: string): Promise<boolean>;
  /** 编辑作者自己的最后一条消息（屏幕居中的输入框）；Agent 回复后不能再改。 */
  editComment(docPath: string, id: number): void;
  /** 已解决：整条删除（不归档，6 秒内可撤销）。 */
  resolveComment(docPath: string, id: number): void;
  /** 不采纳：整条删除并记进「已否决」区（6 秒内可撤销）。 */
  rejectComment(docPath: string, id: number): void;
  /** 采纳这条批注最新的修改建议；成功返回 true。 */
  adoptSuggestion(docPath: string, id: number): Promise<boolean>;
  /** 复制一段文字到剪贴板（复制建议用）。 */
  copyText(text: string): void;
  /** 锚点失效的批注：进入「重新绑定」流程（在正文里选中新位置）。 */
  rebindComment(docPath: string, id: number): void;
}

/** 没发出去的回复草稿：键是 draftKey(文档, 批注号)。 */
export type CommentDrafts = Map<string, string>;

export function draftKey(docPath: string, id: number): string {
  return `${docPath}\u0001${id}`;
}

export interface CommentThreadContext {
  host: CommentThreadHost;
  docPath: string;
  drafts: CommentDrafts;
  /** 点了「已解决 / 不采纳」之后（侧栏回列表、页边收起） */
  onClosed(): void;
  /**
   * 刚在页边新建、还没写第一条消息：只画原文和输入框（占位文字换成「写批注…」），
   * 不画位置说明和结案按钮。侧栏里的空白注不走这条，照旧能「已解决」。
   */
  composing?: boolean;
}

/** 这一条在列表 / 详情里的位置说明。 */
export function locationText(item: CommentPanelItem): string {
  if (item.gone) {
    return `原文已删除${
      item.locatedLine === null ? "" : ` · 第 ${item.locatedLine} 行附近`
    } · 改完了就点「已解决」`;
  }
  if (item.locatedLine === null) return "无法定位（原文对不上）";
  if (item.suggestion?.status === "adopted" && item.turn === "author") {
    return `第 ${item.locatedLine} 行附近 · 已采纳 · 满意就点「已解决」`;
  }
  return `第 ${item.locatedLine} 行附近${
    item.via && item.via !== "exact" ? ` · ${LOCATE_VIA_LABELS[item.via]}` : ""
  }`;
}

/**
 * 对话体：位置说明、原文、对话（含建议）、回复框、结案按钮。
 * 内容可选中复制，点了不跳转。
 */
export function renderThreadBody(
  box: HTMLElement,
  item: CommentPanelItem,
  ctx: CommentThreadContext
): void {
  const fresh = ctx.composing === true && item.messages.length === 0;
  if (!fresh) {
    box.createDiv({
      cls: "wt-comment-card-loc",
      text: `${item.origin === "agent" ? "Agent 发起 · " : ""}${locationText(item)}`,
    });
  }
  box.createDiv({ cls: "wt-comment-quote", text: item.quote });

  if (!fresh) {
    const thread = box.createDiv({ cls: "wt-comment-thread" });
    item.messages.forEach((message, index) =>
      renderMessage(thread, message, index, item, ctx)
    );
  }

  renderReplyBox(box, item, ctx);
  if (fresh) return;

  const row = box.createDiv({ cls: "wt-comment-card-actions" });
  confirmButton(row, "已解决", "再点一次：删除这条批注", () => {
    ctx.host.resolveComment(ctx.docPath, item.id);
    ctx.onClosed();
  });
  confirmButton(row, "不采纳", "再点一次：删除并记进「已否决」", () => {
    ctx.host.rejectComment(ctx.docPath, item.id);
    ctx.onClosed();
  });
  if (item.messages[item.messages.length - 1]?.by === "author") {
    const editBtn = row.createEl("button", {
      text: "编辑",
      attr: { title: "修改你的最后一条消息（Agent 回复后就不能改了）" },
    });
    editBtn.addEventListener("click", () =>
      ctx.host.editComment(ctx.docPath, item.id)
    );
  }
  if (item.locatedLine === null || item.gone) {
    const rebindBtn = row.createEl("button", {
      cls: "mod-cta",
      text: "重新绑定",
      attr: { title: "先在正文里选中这条批注现在对应的文字，再点这里" },
    });
    rebindBtn.addEventListener("click", () =>
      ctx.host.rebindComment(ctx.docPath, item.id)
    );
  }
}

/**
 * 「一次确认」按钮：第一次只把文案换成「确认」，3 秒内再点一次才执行；
 * 执行后由宿主给 6 秒撤销（不叠弹窗）。
 */
export function confirmButton(
  row: HTMLElement,
  label: string,
  confirmTitle: string,
  onConfirm: () => void
): void {
  const btn = row.createEl("button", { text: label });
  let confirming = false;
  let resetTimer = 0;
  const reset = () => {
    confirming = false;
    btn.setText(label);
    btn.removeClass("is-confirming");
    btn.setAttr("title", "");
  };
  btn.addEventListener("click", () => {
    if (!confirming) {
      confirming = true;
      btn.setText("确认");
      btn.addClass("is-confirming");
      btn.setAttr("title", confirmTitle);
      resetTimer = window.setTimeout(reset, 3000);
      return;
    }
    window.clearTimeout(resetTimer);
    reset();
    onConfirm();
  });
}

/** 一条消息：作者 / Agent 用不同底色区分；完整显示，可选中复制。 */
function renderMessage(
  thread: HTMLElement,
  message: CommentMessage,
  index: number,
  item: CommentPanelItem,
  ctx: CommentThreadContext
): void {
  const el = thread.createDiv({
    cls: `wt-comment-msg is-${message.by}`,
  });
  el.createDiv({
    cls: "wt-comment-msg-who",
    text: COMMENT_SPEAKER_LABELS[message.by],
  });
  if (message.text) {
    el.createDiv({ cls: "wt-comment-msg-text", text: message.text });
  }
  if (message.suggestion) renderSuggestion(el, message, index, item, ctx);
}

/**
 * 修改建议：删掉的字划线、新增的字高亮。只有最新一条能采纳；
 * 采纳不了时按钮变灰并写明原因，任何时候都能复制。
 */
function renderSuggestion(
  parent: HTMLElement,
  message: CommentMessage,
  index: number,
  item: CommentPanelItem,
  ctx: CommentThreadContext
): void {
  const suggestion = message.suggestion;
  if (!suggestion) return;
  const latest = item.suggestion && item.suggestion.index === index
    ? item.suggestion
    : null;
  const superseded = !latest && !suggestion.adopted;
  const box = parent.createDiv({
    cls: superseded ? "wt-comment-suggest is-superseded" : "wt-comment-suggest",
  });
  const label = suggestion.adopted
    ? "修改建议 · 已采纳"
    : superseded
      ? "修改建议 · 已被新建议取代"
      : "修改建议";
  box.createDiv({ cls: "wt-comment-suggest-label", text: label });
  const before = latest
    ? latest.before
    : suggestion.original || item.quote;
  const diff = box.createDiv({ cls: "wt-comment-suggest-diff" });
  if (!suggestion.replacement && !before) {
    diff.setText("（空）");
  }
  for (const piece of diffChars(before, suggestion.replacement)) {
    diff.createSpan({
      cls:
        piece.kind === "del"
          ? "wt-comment-suggest-del"
          : piece.kind === "add"
            ? "wt-comment-suggest-add"
            : undefined,
      text: piece.text,
    });
  }
  const actions = box.createDiv({ cls: "wt-comment-suggest-actions" });
  if (latest && !suggestion.adopted) {
    const adoptBtn = actions.createEl("button", {
      cls: latest.status === "ready" ? "mod-cta" : undefined,
      text: "采纳",
      attr: {
        title:
          latest.status === "ready"
            ? "把正文里的这句换成建议的写法（⌘/Ctrl + Z 可撤回）"
            : latest.reason,
      },
    });
    adoptBtn.disabled = latest.status !== "ready";
    let adopting = false;
    adoptBtn.addEventListener("click", () => {
      if (adopting || latest.status !== "ready") return;
      adopting = true;
      adoptBtn.disabled = true;
      void ctx.host.adoptSuggestion(ctx.docPath, item.id).finally(() => {
        adopting = false;
        if (adoptBtn.isConnected) adoptBtn.disabled = false;
      });
    });
  }
  const copyBtn = actions.createEl("button", {
    text: "复制",
    attr: { title: "复制建议的写法" },
  });
  copyBtn.addEventListener("click", () =>
    ctx.host.copyText(suggestion.replacement)
  );
  if (latest && !suggestion.adopted && latest.status !== "ready") {
    actions.createSpan({
      cls: "wt-comment-suggest-reason",
      text: latest.reason,
    });
  }
}

/** 回复框：多行输入，回车换行，⌘/Ctrl + 回车或「发送」按钮发出。 */
function renderReplyBox(
  parent: HTMLElement,
  item: CommentPanelItem,
  ctx: CommentThreadContext
): void {
  const box = parent.createDiv({ cls: "wt-comment-reply-box" });
  const key = draftKey(ctx.docPath, item.id);
  const input = box.createEl("textarea", {
    cls: "wt-comment-reply-input",
    attr: {
      rows: "3",
      placeholder:
        ctx.composing === true && item.messages.length === 0
          ? "写批注…（⌘/Ctrl + 回车发送）"
          : "回复…（⌘/Ctrl + 回车发送）",
    },
  });
  input.value = ctx.drafts.get(key) ?? "";
  const sendBtn = box.createEl("button", {
    cls: "mod-cta",
    text: "发送",
  });
  let sending = false;
  const send = async () => {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    sendBtn.disabled = true;
    const ok = await ctx.host.replyToComment(ctx.docPath, item.id, text);
    sending = false;
    sendBtn.disabled = false;
    // 只在保存成功后清草稿；失败时留着，免得白写
    if (ok) {
      ctx.drafts.delete(key);
      if (input.isConnected) input.value = "";
    }
  };
  input.addEventListener("input", () => {
    if (input.value) ctx.drafts.set(key, input.value);
    else ctx.drafts.delete(key);
  });
  input.addEventListener("keydown", (ev) => {
    // 输入法拼字中的回车是选词，不能当发送
    if (ev.isComposing) return;
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void send();
    }
  });
  sendBtn.addEventListener("click", () => void send());
}
