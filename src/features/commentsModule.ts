import {
  MarkdownView,
  Notice,
  TFile,
  TFolder,
  type App,
  type TAbstractFile,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { CommentStore } from "../commentStore";
import {
  AnchorLocator,
  LOCATE_VIA_LABELS,
  SUGGESTION_PROBLEM_LABELS,
  WtComment,
  buildReplyPrompt,
  buildReviewPrompt,
  commentTurn,
  commentsFolder,
  detectCommentTampering,
  docPathForSidecar,
  formatTimestamp,
  isSidecarPath,
  latestSuggestionIndex,
  legacySidecarPathFor,
  locateAll,
  nextCommentId,
  paragraphAt,
  rejectedLine,
  restoreTamperedComments,
  sidecarPathFor,
  suggestionTarget,
  type AgentChannel,
  type CommentFileData,
} from "../comments";
import {
  AgentToolError,
  buildAgentComment,
  buildAgentReply,
  describeComment,
  normalizeAgentPath,
  type AgentToolsPort,
} from "../agentTools";
import {
  anchorReplaceEffect,
  buildCommentExtensions,
  dispatchCommentRefresh,
  type AnchorEdit,
} from "../commentDecor";
import {
  CommentPanelBody,
  type CommentPanelHost,
  type CommentPanelItem,
  type CommentPanelModel,
  type CommentPanelSuggestion,
} from "../commentView";
import {
  buildCommentDiagReport,
  recordLocate,
} from "../diagnostics";
import type {
  FeatureContext,
  FeatureModule,
} from "../host/pluginHost";
import { isInternalPath } from "../project";
import { CommentDraftModal } from "../promptModal";
import { UI_SLOT_SIDEBAR_COMMENTS } from "../uiSlots";

export interface CommentPanelHandle {
  refresh(): void;
  destroy(): void;
  revealCard(id: number, scroller?: HTMLElement | null): Promise<void>;
}

export interface CommentStoreAdapter {
  getCached(docPath: string): WtComment[] | undefined;
  reload(docPath: string): Promise<WtComment[]>;
  load(docPath: string): Promise<WtComment[]>;
  ensureLoaded(docPath: string): void;
  invalidate(docPath: string): void;
  invalidatePrefix(prefix: string): void;
  /** rejected 省略时沿用最近一次读到的「已否决」区。 */
  save(
    docPath: string,
    comments: readonly WtComment[],
    rejected?: readonly string[]
  ): Promise<void>;
  /** 最近一次读到的「已否决」区（可选，测试桩可省略，视为空）。 */
  getRejected?(docPath: string): string[];
  handleModified(path: string): string | null;
  handleDeleted(path: string): string | null;
  handleRenamed(oldPath: string, newPath: string): string[];
  /** 存放位置切换后整张缓存作废（可选，测试桩可省略）。 */
  invalidateAll?(): void;
  /** 启动时把旧版同目录批注收进 `.wt-comments/`（可选，测试桩可省略）。 */
  migrateLegacySidecars?(): Promise<number>;
  /** 正文目录改名时同步搬镜像目录（可选，测试桩可省略）。 */
  migrateFolderPrefix?(oldFolder: string, newFolder: string): Promise<number>;
  /** 有批注文件的文档路径（批注工具「列出所有」用；可选，测试桩可省略）。 */
  listCommentDocs?(): Promise<string[]>;
}

export interface CommentsChange {
  docPath: string | null;
}

export interface CommentsOperations extends CommentPanelHost {
  activeDocPath(): string | null;
  getCached(docPath: string): WtComment[] | undefined;
  prime(docPath: string): void;
  refreshAllDecors(): void;
  refreshPanels(): void;
  addCommentForView(view: EditorView): void;
  revealInPanel(path: string, id: number): void;
  buildDiagnosticReport(): string;
  flush(): Promise<void>;
  subscribe(listener: (change: CommentsChange) => void): () => void;
  /** 本机批注工具（MCP）落到这里读写批注。 */
  readonly agentTools: AgentToolsPort;
}

export interface CommentsModule extends FeatureModule {
  readonly operations: CommentsOperations;
}

export interface CommentsModuleOptions {
  /** 侧栏获得焦点时拿不到 activeFile，用主入口记录的最近文档兜底。 */
  getRecentMarkdownPath(): string | null;
  /** 打开工具箱侧栏；正文标记点击后由模块负责定位卡片。 */
  openSidebar(): Promise<void>;
  /** 格式工具条的适用范围；批注总开关不受范围限制。 */
  isFormatScopeAllowed(path: string): boolean;
  /** 数据变化后通知 UI Shell 更新徽标等外围信息。 */
  onChanged?(): void;
  /**
   * 这台设备上关掉批注：移动端且用户关了「在手机和平板上使用批注」
   * （批注文件不随同步时，手机上写的批注会孤立在手机里）。为真时不画批注痕迹、不给添加入口。
   */
  isMobile?(): boolean;
  /** 复制给 Agent 的指令走哪条路：本机批注工具开着就用工具，否则直接写批注文件。 */
  agentChannel?(): AgentChannel;
}

type CommentPanelFactory = (
  container: HTMLElement,
  host: CommentPanelHost
) => CommentPanelHandle;

type CommentStoreFactory = (app: App) => CommentStoreAdapter;
type CommentExtensionBuilder = typeof buildCommentExtensions;
type CommentDecorRefresher = (
  view: EditorView | undefined
) => void;

type DraftPresenter = (
  app: App,
  title: string,
  initial: string,
  onSave: (content: string) => void,
  onCancel?: () => void
) => { open(): void };

type ConfirmPresenter = (
  app: App,
  title: string,
  message: string,
  cta: string,
  onConfirm: () => void,
  dangerous?: boolean
) => { open(): void };

export interface CommentsModuleFactories {
  readonly createPanel?: CommentPanelFactory;
  readonly createStore?: CommentStoreFactory;
  readonly buildExtensions?: CommentExtensionBuilder;
  readonly refreshDecor?: CommentDecorRefresher;
  readonly createDraft?: DraftPresenter;
  readonly createConfirm?: ConfirmPresenter;
}

function createDefaultPanel(
  container: HTMLElement,
  host: CommentPanelHost
): CommentPanelBody {
  return new CommentPanelBody(container, host);
}

function toDocPath(path: string): string {
  return isSidecarPath(path) ? docPathForSidecar(path) : path;
}

/**
 * 批注完整功能模块。
 *
 * 数据、缓存、编辑器装饰、右键入口、伴随文件迁移、侧栏面板和所有管理操作
 * 共用同一个生命周期。UI Shell 只负责挂载插槽与展示标签，不再认识批注实现。
 */
export function createCommentsModule(
  options: CommentsModuleOptions,
  factories: CommentsModuleFactories = {}
): CommentsModule {
  const createPanel = factories.createPanel ?? createDefaultPanel;
  const createStore = factories.createStore ?? ((app) => new CommentStore(app));
  const buildExtensions = factories.buildExtensions ?? buildCommentExtensions;
  const refreshDecor = factories.refreshDecor ?? dispatchCommentRefresh;
  const createDraft = factories.createDraft ?? ((...args) => new CommentDraftModal(...args));

  let active = false;
  let acceptingCalls = false;
  let disposed = false;
  let app: App | null = null;
  let services: FeatureContext["services"] | null = null;
  let events: FeatureContext["events"] | null = null;
  let store: CommentStoreAdapter | null = null;
  let operations: CommentsOperations | null = null;
  let mutationChain: Promise<void> = Promise.resolve();
  const mountedPanels = new Set<CommentPanelHandle>();
  const listeners = new Set<(change: CommentsChange) => void>();

  function requireRuntime(): {
    app: App;
    services: FeatureContext["services"];
    events: FeatureContext["events"];
    store: CommentStoreAdapter;
  } {
    if (!app || !services || !events || !store) {
      throw new Error("批注模块尚未激活");
    }
    return { app, services, events, store };
  }

  function assertAcceptingCalls(): void {
    if (!acceptingCalls || disposed) {
      throw new Error("批注模块尚未激活");
    }
  }

  function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = mutationChain.then(task);
    mutationChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function notifyChanged(docPath: string | null): void {
    for (const listener of [...listeners]) {
      try {
        listener({ docPath });
      } catch (error) {
        console.error("[Writing Toolkit:comments] 批注变化监听器失败", error);
      }
    }
    options.onChanged?.();
  }

  function refreshPanels(): void {
    if (!active) return;
    for (const panel of [...mountedPanels]) {
      try {
        panel.refresh();
      } catch (error) {
        console.error("[Writing Toolkit:comments] 批注面板刷新失败", error);
      }
    }
  }

  function activeCommentDocPath(): string | null {
    const runtime = requireRuntime();
    const file = runtime.app.workspace.getActiveFile();
    if (file && file.extension === "md") return toDocPath(file.path);
    const view = currentMarkdownView();
    if (view?.file) return toDocPath(view.file.path);
    return null;
  }

  function currentMarkdownView(): MarkdownView | null {
    const runtime = requireRuntime();
    const direct = runtime.app.workspace.getActiveViewOfType(MarkdownView);
    if (direct) return direct;
    const leaves = runtime.services.ui.leaves("markdown");
    if (leaves.length === 0) return null;
    const recentPath = options.getRecentMarkdownPath();
    if (recentPath) {
      for (const leaf of leaves) {
        const view = leaf.view as MarkdownView;
        if (view.file?.path === recentPath) return view;
      }
    }
    return leaves.length === 1 ? (leaves[0].view as MarkdownView) : null;
  }

  function markdownViewForPath(path: string): MarkdownView | null {
    const runtime = requireRuntime();
    for (const leaf of runtime.services.ui.leaves("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === path) return view;
    }
    return null;
  }

  function refreshDocDecor(docPath: string): void {
    if (!active) return;
    const runtime = requireRuntime();
    for (const leaf of runtime.services.ui.leaves("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path !== docPath) continue;
      refreshDecor(runtime.services.editor.getViewForEditor(view.editor));
    }
  }

  function refreshAllDecors(): void {
    if (!active) return;
    const runtime = requireRuntime();
    for (const leaf of runtime.services.ui.leaves("markdown")) {
      const view = leaf.view as MarkdownView;
      refreshDecor(runtime.services.editor.getViewForEditor(view.editor));
    }
  }

  function onCommentsChanged(docPath: string): void {
    if (!active) return;
    refreshDocDecor(docPath);
    refreshPanels();
    notifyChanged(docPath);
  }

  function primeComments(docPath: string): void {
    if (!active) return;
    const runtime = requireRuntime();
    if (runtime.store.getCached(docPath)) return;
    void runtime.store
      .load(docPath)
      .then(() => onCommentsChanged(docPath))
      .catch((error) => {
        console.error("[Writing Toolkit:comments] 预加载批注失败", error);
      });
  }

  function rejectedOf(docPath: string): string[] {
    return requireRuntime().store.getRejected?.(docPath) ?? [];
  }

  /**
   * 读盘 → 改 → 写回整份批注文件（批注 + 「已否决」区）。
   * 写前一定重读：内存里的列表可能是 Agent 改写之前的，拿它整份覆盖会冲掉 Agent 的回复。
   */
  async function mutateFile(
    docPath: string,
    mutator: (data: CommentFileData) => CommentFileData
  ): Promise<boolean> {
    const runtime = requireRuntime();
    try {
      await enqueueMutation(async () => {
        const before = runtime.store.getCached(docPath);
        const list = await runtime.store.reload(docPath);
        if (before) checkTampering(docPath, before, list);
        const next = mutator({
          comments: [...list],
          rejected: rejectedOf(docPath),
        });
        await runtime.store.save(docPath, next.comments, next.rejected);
      });
      onCommentsChanged(docPath);
      return true;
    } catch (error) {
      console.error("[Writing Toolkit:comments] 保存批注失败", error);
      new Notice("批注保存失败（详见控制台）");
      return false;
    }
  }

  function mutateComments(
    docPath: string,
    mutator: (list: WtComment[]) => WtComment[]
  ): Promise<boolean> {
    return mutateFile(docPath, (data) => ({
      ...data,
      comments: mutator(data.comments),
    }));
  }

  /**
   * 批注文件被外部改写后检查越权：条目消失（只有作者能结案）或已有消息被改。
   * 只提示并给「恢复」，不自动回滚。
   */
  function checkTampering(
    docPath: string,
    before: readonly WtComment[],
    after: readonly WtComment[]
  ): void {
    const report = detectCommentTampering(before, after);
    if (report.removed.length === 0 && report.altered.length === 0) return;
    const ids = (list: readonly WtComment[]) =>
      list.map((c) => `#${c.id}`).join("、");
    const parts: string[] = [];
    if (report.removed.length > 0) parts.push(`删除了批注 ${ids(report.removed)}`);
    if (report.altered.length > 0) {
      parts.push(`改动了批注 ${ids(report.altered)} 的已有消息`);
    }
    showActionNotice(
      `批注文件被外部${parts.join("，")}（只有你能结案）`,
      "恢复",
      15000,
      () => {
        if (!acceptingCalls) return;
        void mutateComments(docPath, (list) =>
          restoreTamperedComments(list, report)
        ).then((ok) => {
          if (ok) new Notice("已恢复");
        });
      }
    );
  }

  /** 外部改写后重读并检查越权（回到窗口、vault modify 时用）。 */
  async function reloadAndCheck(docPath: string): Promise<void> {
    const runtime = requireRuntime();
    const before = runtime.store.getCached(docPath);
    const after = await runtime.store.reload(docPath);
    if (!active) return;
    if (before) checkTampering(docPath, before, after);
    onCommentsChanged(docPath);
  }

  async function readDocTextForLocate(
    docPath: string
  ): Promise<string | null> {
    const runtime = requireRuntime();
    for (const leaf of runtime.services.ui.leaves("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === docPath && view.editor) {
        return view.editor.getValue();
      }
    }
    const file = runtime.app.vault.getAbstractFileByPath(docPath);
    if (!(file instanceof TFile)) return null;
    try {
      return await runtime.app.vault.cachedRead(file);
    } catch {
      return null;
    }
  }

  async function getCommentPanelModel(): Promise<CommentPanelModel> {
    const runtime = requireRuntime();
    const docPath = activeCommentDocPath();
    if (!docPath) {
      return {
        docPath: null,
        docName: null,
        loading: false,
        items: [],
        rejectedCount: 0,
      };
    }
    const activeFile = runtime.app.workspace.getActiveFile();
    const base = (docPath.split("/").pop() ?? docPath).replace(/\.md$/i, "");
    const docName =
      activeFile && isSidecarPath(activeFile.path)
        ? `${base}（批注文件）`
        : base;
    let loading = false;
    if (!runtime.store.getCached(docPath)) {
      loading = true;
      try {
        await runtime.store.load(docPath);
      } catch (error) {
        console.error("[Writing Toolkit:comments] 读取批注失败", error);
      }
      loading = false;
    }
    const comments = runtime.store.getCached(docPath) ?? [];
    const docText = await readDocTextForLocate(docPath);
    const tLocate = performance.now();
    const located = docText === null ? [] : locateAll(docText, comments);
    const locateMs = performance.now() - tLocate;
    recordLocate(locateMs);
    runtime.services.diagnostics.recordTiming("comments:locate", locateMs);
    const byId = new Map(located.map((item) => [item.comment.id, item]));
    const blocked = runtime.services.editor.writeBlockReason?.(docPath) ?? null;
    const items: CommentPanelItem[] = comments.map((comment) => {
      const hit = byId.get(comment.id);
      const suggestion = panelSuggestion(docText, comment, blocked);
      return {
        id: comment.id,
        origin: comment.origin,
        quote: comment.quote,
        messages: comment.messages.map((m) => ({ ...m })),
        turn: commentTurn(comment),
        gone: comment.gone === true,
        lineHint: comment.lineHint,
        createdAt: comment.createdAt,
        locatedLine: hit ? hit.lineFrom : null,
        via: hit ? hit.via : null,
        ...(suggestion ? { suggestion } : {}),
      };
    });
    return {
      docPath,
      docName,
      loading,
      items,
      rejectedCount: rejectedOf(docPath).length,
    };
  }

  /** 最新一条修改建议现在能不能采纳（面板据此显示按钮或原因）。 */
  function panelSuggestion(
    docText: string | null,
    comment: WtComment,
    blocked: string | null
  ): CommentPanelSuggestion | null {
    const index = latestSuggestionIndex(comment);
    if (index < 0) return null;
    const suggestion = comment.messages[index].suggestion;
    if (!suggestion) return null;
    const fallback = suggestion.original || comment.current || comment.quote;
    if (suggestion.adopted) {
      return { index, status: "adopted", reason: "", before: fallback };
    }
    if (docText === null) {
      return {
        index,
        status: "missing",
        reason: SUGGESTION_PROBLEM_LABELS.missing,
        before: fallback,
      };
    }
    const target = suggestionTarget(docText, comment, suggestion);
    if ("problem" in target) {
      return {
        index,
        status: target.problem,
        reason: SUGGESTION_PROBLEM_LABELS[target.problem],
        before: fallback,
      };
    }
    const before = docText.slice(target.from, target.to);
    if (blocked) return { index, status: "locked", reason: blocked, before };
    return { index, status: "ready", reason: "", before };
  }

  /**
   * 采纳最新一条修改建议：在编辑器里把原句换成建议的写法（作者的一次输入，⌘Z 可撤回），
   * 批注标记跟到新文字上；再把那一行标成「已采纳」。批注不会因此结案。
   */
  async function adoptSuggestion(path: string, id: number): Promise<boolean> {
    const runtime = requireRuntime();
    const blocked = runtime.services.editor.writeBlockReason?.(path) ?? null;
    if (blocked) {
      new Notice(blocked);
      return false;
    }
    let comment: WtComment | undefined;
    try {
      comment = (await runtime.store.reload(path)).find((item) => item.id === id);
    } catch (error) {
      console.error("[Writing Toolkit:comments] 读取批注失败", error);
      new Notice("读取批注失败（详见控制台）");
      return false;
    }
    if (!comment) {
      new Notice(`批注 #${id} 已经不在了`);
      return false;
    }
    const index = latestSuggestionIndex(comment);
    const suggestion = index >= 0 ? comment.messages[index].suggestion : undefined;
    if (!suggestion) return false;
    if (suggestion.adopted) {
      new Notice("这条建议已经采纳过了");
      return false;
    }
    const file = runtime.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("找不到这篇文档");
      return false;
    }
    const view = await openDocView(file);
    const cm = runtime.services.editor.getViewForEditor(view?.editor);
    if (!cm) {
      new Notice("打不开这篇文档的编辑器，没法采纳");
      return false;
    }
    const target = suggestionTarget(cm.state.doc.toString(), comment, suggestion);
    if ("problem" in target) {
      new Notice(SUGGESTION_PROBLEM_LABELS[target.problem]);
      refreshPanels();
      return false;
    }
    const end = target.from + suggestion.replacement.length;
    cm.dispatch({
      changes: { from: target.from, to: target.to, insert: suggestion.replacement },
      effects: anchorReplaceEffect.of({ id, from: target.from, to: target.to }),
      selection: { anchor: target.from, head: end },
      scrollIntoView: true,
      // 走作者输入的口径：定稿锁认得出、批注位置跟踪会跟着走、能撤销
      userEvent: "input.adopt",
    });
    const ok = await mutateComments(path, (list) =>
      list.map((item) =>
        item.id !== id
          ? item
          : {
              ...item,
              messages: item.messages.map((m, k) =>
                k === index && m.suggestion
                  ? { ...m, suggestion: { ...m.suggestion, adopted: true } }
                  : m
              ),
            }
      )
    );
    if (ok) new Notice(`已采纳批注 #${id} 的修改建议（⌘/Ctrl + Z 可撤回正文）`);
    return ok;
  }

  function copyText(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => new Notice("已复制"),
      () => new Notice("复制到剪贴板失败")
    );
  }

  /* ---------- 本机批注工具（MCP）的读写端口 ---------- */

  function agentDocPath(raw: unknown): string {
    const runtime = requireRuntime();
    if (!runtime.services.settings.get().commentsEnabled) {
      throw new AgentToolError("作者关掉了批注功能（设置 → 批注），现在不能读写批注。");
    }
    const adapter = runtime.app.vault.adapter as { getBasePath?: () => string } | undefined;
    const path = normalizeAgentPath(raw, adapter?.getBasePath?.() ?? null);
    if (isSidecarPath(path) || isInternalPath(path)) {
      throw new AgentToolError("path 要给正文文档本身，不是批注文件或插件的内部文件。");
    }
    const file = runtime.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
      throw new AgentToolError(`库里没有「${path}」这篇文档。请给出库内相对路径，比如「作品/正文/第3章.md」。`);
    }
    return path;
  }

  async function agentDocText(path: string): Promise<string> {
    const text = await readDocTextForLocate(path);
    if (text === null) throw new AgentToolError(`读不到「${path}」的正文。`);
    return text;
  }

  async function agentSave(
    path: string,
    mutator: (list: WtComment[]) => WtComment[]
  ): Promise<void> {
    const ok = await mutateComments(path, mutator);
    if (!ok) throw new AgentToolError("保存批注失败，请稍后再试一次。");
  }

  const agentTools: AgentToolsPort = {
    async list(input) {
      assertAcceptingCalls();
      const runtime = requireRuntime();
      if (input.path === undefined) {
        if (!runtime.services.settings.get().commentsEnabled) {
          throw new AgentToolError("作者关掉了批注功能（设置 → 批注），现在不能读写批注。");
        }
        const docs = (await runtime.store.listCommentDocs?.()) ?? [];
        const documents = [];
        for (const docPath of docs) {
          const list = await runtime.store.load(docPath);
          if (list.length === 0) continue;
          documents.push({
            path: docPath,
            comments: list.length,
            yourTurn: list.filter((c) => commentTurn(c) === "agent").length,
          });
        }
        return { documents };
      }
      const path = agentDocPath(input.path);
      const all = await runtime.store.reload(path);
      const list = input.onlyYourTurn
        ? all.filter((c) => commentTurn(c) === "agent")
        : all;
      const docText = await readDocTextForLocate(path);
      return {
        path,
        comments: list.map((comment) => describeComment(docText, comment)),
        rejected: rejectedOf(path),
      };
    },
    async create(input) {
      assertAcceptingCalls();
      const runtime = requireRuntime();
      const path = agentDocPath(input.path);
      const docText = await agentDocText(path);
      // 先按最新的盘上内容校验一次，错误原样返回给 Agent；写入时再按写入那一刻的列表编号
      const draft = buildAgentComment(docText, await runtime.store.reload(path), input);
      let id = draft.id;
      await agentSave(path, (list) => {
        id = nextCommentId(list);
        return [...list, { ...draft, id }];
      });
      return { ok: true, id, message: `已发起第 ${id} 条批注` };
    },
    async reply(input) {
      assertAcceptingCalls();
      const runtime = requireRuntime();
      const path = agentDocPath(input.path);
      const docText = await readDocTextForLocate(path);
      const list = await runtime.store.reload(path);
      const message = buildAgentReply(
        docText,
        list.find((c) => c.id === input.id),
        input
      );
      let appended = false;
      await agentSave(path, (fresh) =>
        fresh.map((item) => {
          // 写盘前重读过：这一刻仍轮到 Agent 才追加，免得连发两条
          if (item.id !== input.id || commentTurn(item) !== "agent") return item;
          appended = true;
          return { ...item, messages: [...item.messages, message] };
        })
      );
      if (!appended) {
        throw new AgentToolError(`第 ${input.id} 条刚刚变了（被结案或已经回复过），先用 list_comments 再看一次。`);
      }
      return { ok: true, id: input.id, message: `已回复第 ${input.id} 条批注` };
    },
  };

  /** 编辑作者自己的最后一条消息；Agent 已回复（最后一条不是作者）时不能改。 */
  function openCommentEditor(path: string, comment: WtComment): void {
    const runtime = requireRuntime();
    const index = comment.messages.length - 1;
    const last = comment.messages[index];
    if (!last || last.by !== "author") {
      new Notice("Agent 已经回复，前面的消息不能再改了；有补充请直接回复");
      return;
    }
    createDraft(
      runtime.app,
      `批注 ${comment.id} · 修改你的消息`,
      last.text,
      (text) => {
        if (!acceptingCalls) return;
        const trimmed = text.trim();
        if (!trimmed && comment.messages.length === 1) {
          new Notice("这是唯一一条消息，不能清空；不需要这条批注就点「已解决」");
          return;
        }
        void mutateComments(path, (list) =>
          list.map((item) => {
            if (item.id !== comment.id) return item;
            // 写盘前已重读：只在最后一条仍是这条作者消息时才改，免得改到 Agent 刚追加的回复
            const at = item.messages.length - 1;
            const current = item.messages[at];
            if (at !== index || current?.by !== "author") return item;
            const messages = trimmed
              ? item.messages.map((m, k) => (k === at ? { ...m, text } : m))
              : item.messages.slice(0, at);
            return { ...item, messages };
          })
        );
      }
    ).open();
  }

  async function replyToComment(
    path: string,
    id: number,
    text: string
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;
    let found = false;
    const ok = await mutateComments(path, (list) =>
      list.map((item) => {
        if (item.id !== id) return item;
        found = true;
        return {
          ...item,
          messages: [...item.messages, { by: "author", text: trimmed }],
        };
      })
    );
    if (ok && !found) {
      new Notice(`批注 #${id} 已经不在了（可能刚被改动），回复没有保存`);
      return false;
    }
    return ok;
  }

  function showActionNotice(
    text: string,
    buttonText: string,
    duration: number,
    onClick: () => void
  ): void {
    const fragment = createFragment();
    const label = createSpan({ text });
    const actionBtn = createEl("button", {
      cls: "wt-notice-undo",
      text: buttonText,
    });
    fragment.append(label, actionBtn);
    const notice = new Notice(fragment, duration);
    // 按钮寿命 = Notice 节点寿命（到时整体回收），用 onclick 避免登记一个
    // 脱离 EventScope 的全局监听器。
    actionBtn.onclick = () => {
      notice.hide();
      onClick();
    };
  }

  /**
   * 结案：已解决 = 整条删除（不归档）；不采纳 = 删除并在「已否决」区追加一行。
   * 两者都给 6 秒撤销（撤销只存在内存里）。
   */
  async function closeComment(
    path: string,
    id: number,
    reject: boolean
  ): Promise<void> {
    let removed: WtComment | null = null;
    let removedIndex = 0;
    let line = "";
    const ok = await mutateFile(path, (data) => {
      const index = data.comments.findIndex((comment) => comment.id === id);
      if (index < 0) return data;
      removedIndex = index;
      removed = data.comments[index];
      line = reject ? rejectedLine(removed) : "";
      return {
        comments: data.comments.filter((comment) => comment.id !== id),
        rejected: reject ? [...data.rejected, line] : data.rejected,
      };
    });
    if (!ok || !removed) return;
    const closed = removed;
    showActionNotice(
      reject ? `批注 #${id} 不采纳，已记进「已否决」` : `批注 #${id} 已解决`,
      "撤销",
      6000,
      () => {
        if (!acceptingCalls) return;
        void mutateFile(path, (data) => {
          if (data.comments.some((comment) => comment.id === id)) return data;
          const comments = [...data.comments];
          comments.splice(Math.min(removedIndex, comments.length), 0, closed);
          let rejected = data.rejected;
          if (reject) {
            const at = rejected.lastIndexOf(line);
            if (at >= 0) rejected = rejected.filter((_, k) => k !== at);
          }
          return { comments, rejected };
        });
      }
    );
  }

  /** 把这篇文档显示出来（已打开就切过去，没打开就新开一个标签页）。 */
  async function openDocView(file: TFile): Promise<MarkdownView | null> {
    const runtime = requireRuntime();
    let target = markdownViewForPath(file.path)?.leaf ?? null;
    if (!target) {
      for (const leaf of runtime.services.ui.leaves("markdown")) {
        if ((leaf.view as MarkdownView).file?.path === file.path) {
          target = leaf;
          break;
        }
      }
    }
    if (!target) {
      target = runtime.services.ui.getLeaf("tab");
      if (!target) return null;
      await target.openFile(file);
    }
    runtime.services.ui.reveal(target);
    return target.view instanceof MarkdownView ? target.view : null;
  }

  async function revealCommentInDoc(
    file: TFile,
    comment: WtComment
  ): Promise<void> {
    const view = await openDocView(file);
    if (!view) return;
    const editor = view.editor;
    const span = new AnchorLocator(editor.getValue()).locate(comment);
    if (!span) {
      new Notice(
        "找不到这条批注对应的原文（正文改动较大）——可在批注面板点「重新绑定」"
      );
      return;
    }
    const from = editor.offsetToPos(span.from);
    const to = editor.offsetToPos(span.to);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    editor.focus();
    if (span.via !== "exact" && span.via !== "present") {
      new Notice(LOCATE_VIA_LABELS[span.via]);
    }
  }

  function revealMountedCard(id: number): boolean {
    let found = false;
    for (const panel of [...mountedPanels]) {
      found = true;
      void panel.revealCard(id);
    }
    return found;
  }

  async function revealInPanel(_path: string, id: number): Promise<void> {
    if (!active) return;
    try {
      await options.openSidebar();
    } catch {
      new Notice("没打开工具箱侧栏，可在左侧栏打开「工具箱」看批注列表");
      return;
    }
    revealMountedCard(id);
    // 新挂载的侧栏 DOM 可能晚一帧就绪；和旧行为一样补一次重试。
    events?.setTimeout(() => revealMountedCard(id), 120);
  }

  async function addCommentForView(view: EditorView): Promise<void> {
    const runtime = requireRuntime();
    const settings = runtime.services.settings.get();
    if (options.isMobile?.()) return;
    if (!settings.commentsEnabled) {
      new Notice("批注功能已关闭（设置 → 批注）");
      return;
    }
    const path = runtime.services.editor.getFilePath(view);
    if (!path || isSidecarPath(path)) return;
    const selection = view.state.selection.main;
    const quote = view.state.sliceDoc(selection.from, selection.to).trim();
    if (!quote) {
      new Notice("先选中要批注的文字");
      return;
    }
    const lineHint = view.state.doc.lineAt(selection.from).number;
    const paragraph = paragraphAt(
      view.state.doc.toString(),
      selection.from
    );
    const sidecarPath = sidecarPathFor(path);
    let createdId: number | null = null;
    const created = await mutateComments(path, (list) => {
      const id = nextCommentId(list);
      createdId = id;
      return [
        ...list,
        {
          id,
          origin: "author",
          quote,
          paragraph: paragraph?.text.trim() ?? "",
          paragraphHint: paragraph?.index ?? 0,
          lineHint,
          createdAt: formatTimestamp(),
          messages: [],
          current: "",
        },
      ];
    });
    if (!created || createdId === null || !acceptingCalls) return;
    const id = createdId;
    createDraft(
      runtime.app,
      "添加批注",
      "",
      (content) => {
        if (!acceptingCalls) return;
        const text = content.trim();
        void mutateComments(path, (list) =>
          text
            ? list.map((comment) =>
                comment.id === id
                  ? { ...comment, messages: [{ by: "author", text }] }
                  : comment
              )
            : list.filter(
                (comment) => comment.id !== id || comment.messages.length > 0
              )
        );
        new Notice(`批注已保存到「${sidecarPath}」`);
      },
      () => {
        if (!acceptingCalls) return;
        void mutateComments(path, (list) =>
          list.filter(
            (comment) => comment.id !== id || comment.messages.length > 0
          )
        );
      }
    ).open();
  }

  /**
   * 作者在编辑器里改了批注对应的文字：把现在的文字写进「现文」并更新段落；
   * 整段删掉的标「原文已删除」，定位到删除处所在的段落。「原文」保持不动，
   * 留给 Agent 看当初说的是哪句。
   */
  function applyAnchorEdits(path: string, edits: readonly AnchorEdit[]): void {
    if (!acceptingCalls || edits.length === 0) return;
    const byId = new Map(edits.map((edit) => [edit.id, edit]));
    void mutateComments(path, (list) =>
      list.map((item) => {
        const edit = byId.get(item.id);
        if (!edit) return item;
        const next: WtComment = {
          ...item,
          current: edit.gone ? "" : edit.text,
          paragraph: edit.paragraph || item.paragraph,
          paragraphHint: edit.paragraphHint || item.paragraphHint,
          lineHint: edit.lineHint || item.lineHint,
        };
        if (edit.gone) next.gone = true;
        else delete next.gone;
        return next;
      })
    );
  }

  function rebindComment(docPath: string | null, id: number): void {
    const runtime = requireRuntime();
    const path = docPath || activeCommentDocPath();
    if (!path) return;
    const comment = (runtime.store.getCached(path) ?? []).find(
      (item) => item.id === id
    );
    if (!comment) return;
    const view = markdownViewForPath(path) ?? currentMarkdownView();
    const cm = runtime.services.editor.getViewForEditor(view?.editor);
    const selection = cm?.state.selection.main ?? null;
    const picked =
      cm && selection && !selection.empty
        ? cm.state.sliceDoc(selection.from, selection.to).trim()
        : "";
    if (!cm || !selection || !picked) {
      new Notice(
        `先在正文里选中批注 #${id} 现在对应的文字，再点一次「重新绑定」`
      );
      view?.editor?.focus();
      return;
    }
    const paragraph = paragraphAt(cm.state.doc.toString(), selection.from);
    const lineHint = cm.state.doc.lineAt(selection.from).number;
    void mutateComments(path, (list) =>
      list.map((item) =>
        item.id === id
          ? {
              ...item,
              quote: picked,
              paragraph: paragraph?.text.trim() ?? "",
              paragraphHint: paragraph?.index ?? 0,
              lineHint,
              current: "",
              gone: undefined,
            }
          : item
      )
    );
    new Notice(`已把批注 #${id} 重新绑定到选中的文字`);
  }

  function copyPrompt(
    docPath: string | undefined,
    build: (path: string, list: WtComment[]) => { text: string; done: string } | null
  ): void {
    const runtime = requireRuntime();
    const path = docPath || activeCommentDocPath();
    if (!path) {
      new Notice("先打开一篇文档");
      return;
    }
    void runtime.store
      .reload(path)
      .then((list) => {
        const prompt = build(path, list);
        if (!prompt) return;
        navigator.clipboard.writeText(prompt.text).then(
          () => new Notice(prompt.done),
          () => new Notice("复制到剪贴板失败")
        );
      })
      .catch((error) => {
        console.error("[Writing Toolkit:comments] 读取批注失败", error);
        new Notice("读取批注失败（详见控制台）");
      });
  }

  function copyReviewPrompt(docPath?: string): void {
    copyPrompt(docPath, (path, list) => ({
      text: buildReviewPrompt(
        path,
        {
          open: list.length,
          rejected: rejectedOf(path).length,
        },
        options.agentChannel?.() ?? "file"
      ),
      done: "已复制批注指令：发给 Agent，它会通读全文、把意见写成批注",
    }));
  }

  function copyReplyPrompt(docPath?: string): void {
    copyPrompt(docPath, (path, list) => {
      const waiting = list
        .filter((c) => commentTurn(c) === "agent")
        .map((c) => c.id)
        .sort((a, b) => a - b);
      if (waiting.length === 0) {
        new Notice("没有等 Agent 回复的批注");
        return null;
      }
      return {
        text: buildReplyPrompt(path, waiting, options.agentChannel?.() ?? "file"),
        done: `已复制回复指令（${waiting.length} 条等 Agent）：发到和它聊批注的那个对话里，它会接着回`,
      };
    });
  }

  async function pathExists(path: string): Promise<boolean> {
    const runtime = requireRuntime();
    if (runtime.app.vault.getAbstractFileByPath(path)) return true;
    const adapter = runtime.app.vault.adapter;
    if (!adapter) return false;
    return adapter.exists(path);
  }

  async function ensureParentFolder(path: string): Promise<void> {
    const runtime = requireRuntime();
    const dir = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    if (!dir) return;
    const adapter = runtime.app.vault.adapter;
    if (!adapter) return;
    let current = "";
    for (const part of dir.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      try {
        if (!(await adapter.exists(current))) await adapter.mkdir(current);
      } catch {
        /* 已存在或并发创建，忽略 */
      }
    }
  }

  async function renameSidecar(from: string, to: string): Promise<void> {
    const runtime = requireRuntime();
    await ensureParentFolder(to);
    const file = runtime.app.vault.getAbstractFileByPath(from);
    if (file instanceof TFile) {
      await runtime.app.vault.rename(file, to);
      return;
    }
    const adapter = runtime.app.vault.adapter;
    if (!adapter) throw new Error(`找不到批注文件：${from}`);
    await adapter.rename(from, to);
  }

  async function migrateCommentSidecar(
    oldPath: string,
    newPath: string
  ): Promise<void> {
    const runtime = requireRuntime();
    if (!oldPath || !newPath || oldPath === newPath) return;
    const newSidecarPath = sidecarPathFor(newPath);
    if (await pathExists(newSidecarPath)) return;
    // 新布局优先；旧版同目录文件作为兜底，顺便完成迁移。
    for (const candidate of [
      sidecarPathFor(oldPath),
      legacySidecarPathFor(oldPath),
    ]) {
      if (!(await pathExists(candidate))) continue;
      await renameSidecar(candidate, newSidecarPath);
      runtime.store.invalidate(oldPath);
      runtime.store.invalidate(newPath);
      return;
    }
  }

  async function migrateCommentFolder(
    oldFolder: string,
    newFolder: string
  ): Promise<void> {
    const runtime = requireRuntime();
    if (!oldFolder || !newFolder || oldFolder === newFolder) return;
    const migrate = runtime.store.migrateFolderPrefix;
    if (typeof migrate === "function") {
      await migrate.call(runtime.store, oldFolder, newFolder);
    }
  }

  function handleSidecarChanged(path: string): void {
    if (!active) return;
    const runtime = requireRuntime();
    if (!isSidecarPath(path)) return;
    const docPath = docPathForSidecar(path);
    const before = runtime.store.getCached(docPath);
    runtime.store.handleModified(path);
    if (!before) {
      onCommentsChanged(docPath);
      return;
    }
    void runtime.store
      .load(docPath)
      .then((after) => {
        if (!active) return;
        checkTampering(docPath, before, after);
        onCommentsChanged(docPath);
      })
      .catch((error) => {
        console.error("[Writing Toolkit:comments] 重读批注文件失败", error);
        onCommentsChanged(docPath);
      });
  }

  function handleSidecarDeleted(path: string): void {
    if (!active) return;
    const runtime = requireRuntime();
    const docPath = runtime.store.handleDeleted(path);
    if (docPath) onCommentsChanged(docPath);
  }

  async function handleVaultRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    if (!active) return;
    const runtime = requireRuntime();
    for (const docPath of runtime.store.handleRenamed(oldPath, file.path)) {
      onCommentsChanged(docPath);
    }
    if (file instanceof TFolder) {
      // 批注文件现在镜像在 .wt-comments/ 下，目录改名要同步搬这一段。
      await enqueueMutation(() =>
        migrateCommentFolder(oldPath, file.path)
      );
      runtime.store.invalidatePrefix(oldPath);
      refreshPanels();
      notifyChanged(activeCommentDocPath());
      return;
    }
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
      return;
    }
    if (
      isInternalPath(oldPath) ||
      isInternalPath(file.path) ||
      isSidecarPath(oldPath) ||
      isSidecarPath(file.path)
    ) {
      return;
    }
    await enqueueMutation(() =>
      migrateCommentSidecar(oldPath, file.path)
    );
    onCommentsChanged(oldPath);
    onCommentsChanged(file.path);
  }

  function handleVaultDelete(file: TAbstractFile): void {
    if (!active) return;
    const runtime = requireRuntime();
    if (isSidecarPath(file.path)) {
      handleSidecarDeleted(file.path);
      return;
    }
    if (file instanceof TFolder) {
      runtime.store.invalidatePrefix(file.path);
    } else if (file instanceof TFile && file.extension === "md") {
      runtime.store.invalidate(file.path);
    }
    refreshPanels();
    notifyChanged(activeCommentDocPath());
  }

  function buildDiagnosticReport(): string {
    const runtime = requireRuntime();
    const settings = runtime.services.settings.get();
    const docPath = activeCommentDocPath();
    const sidecarPath = docPath ? sidecarPathFor(docPath) : "（无）";
    const sidecarFile = docPath
      ? runtime.app.vault.getAbstractFileByPath(sidecarPath)
      : null;
    return buildCommentDiagReport({
      commentsEnabled: settings.commentsEnabled,
      bubbleEverywhere: settings.commentBubbleEverywhere,
      docPath,
      cached: docPath ? runtime.store.getCached(docPath) : undefined,
      sidecarExists: sidecarFile instanceof TFile,
      sidecarPath,
      sidecarSize: sidecarFile instanceof TFile ? sidecarFile.stat.size : null,
    });
  }

  return {
    id: "comments",
    activate(context) {
      app = context.app;
      services = context.services;
      events = context.events;
      store = createStore(context.app);
      // 旧版把批注放在正文同目录；启动时一次性收进批注目录。
      const migrateLegacy = store.migrateLegacySidecars;
      if (typeof migrateLegacy === "function") {
        void migrateLegacy
          .call(store)
          .then((moved) => {
            if (moved > 0) {
              new Notice(
                `写作工具箱：已把 ${moved} 个批注文件移到 ${commentsFolder()}/`
              );
            }
          })
          .catch((error) => {
            console.error("[Writing Toolkit:comments] 迁移批注文件失败", error);
          });
      }
      active = true;
      acceptingCalls = true;
      disposed = false;

      const localStore = store;
      operations = {
        activeDocPath() {
          assertAcceptingCalls();
          return activeCommentDocPath();
        },
        getCached(docPath) {
          assertAcceptingCalls();
          return localStore.getCached(docPath);
        },
        prime(docPath) {
          assertAcceptingCalls();
          primeComments(docPath);
        },
        refreshAllDecors() {
          assertAcceptingCalls();
          refreshAllDecors();
        },
        refreshPanels() {
          assertAcceptingCalls();
          refreshPanels();
        },
        addCommentForView(view) {
          assertAcceptingCalls();
          void addCommentForView(view);
        },
        revealInPanel(path, id) {
          assertAcceptingCalls();
          void revealInPanel(path, id);
        },
        buildDiagnosticReport() {
          assertAcceptingCalls();
          return buildDiagnosticReport();
        },
        async flush() {
          await mutationChain;
        },
        subscribe(listener) {
          if (!active || disposed) {
            throw new Error("批注模块尚未激活");
          }
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        getCommentPanelModel() {
          assertAcceptingCalls();
          return getCommentPanelModel();
        },
        jumpToComment(docPath, id) {
          assertAcceptingCalls();
          const path = docPath || activeCommentDocPath();
          if (!path) return;
          const comment = (localStore.getCached(path) ?? []).find(
            (item) => item.id === id
          );
          if (!comment) return;
          const file = app?.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            void revealCommentInDoc(file, comment);
          }
        },
        replyToComment(docPath, id, text) {
          assertAcceptingCalls();
          const path = docPath || activeCommentDocPath();
          if (!path) return Promise.resolve(false);
          return replyToComment(path, id, text);
        },
        editComment(docPath, id) {
          assertAcceptingCalls();
          const path = docPath || activeCommentDocPath();
          if (!path) return;
          const comment = (localStore.getCached(path) ?? []).find(
            (item) => item.id === id
          );
          if (comment) openCommentEditor(path, comment);
        },
        resolveComment(docPath, id) {
          assertAcceptingCalls();
          const path = docPath || activeCommentDocPath();
          if (path) void closeComment(path, id, false);
        },
        rejectComment(docPath, id) {
          assertAcceptingCalls();
          const path = docPath || activeCommentDocPath();
          if (path) void closeComment(path, id, true);
        },
        rebindComment(docPath, id) {
          assertAcceptingCalls();
          rebindComment(docPath, id);
        },
        adoptSuggestion(docPath, id) {
          assertAcceptingCalls();
          const path = docPath || activeCommentDocPath();
          if (!path) return Promise.resolve(false);
          return adoptSuggestion(path, id);
        },
        copyText(text) {
          assertAcceptingCalls();
          copyText(text);
        },
        agentTools,
        copyReviewPrompt(docPath) {
          assertAcceptingCalls();
          copyReviewPrompt(docPath);
        },
        copyReplyPrompt(docPath) {
          assertAcceptingCalls();
          copyReplyPrompt(docPath);
        },
      };

      context.effects.add(() => {
        active = false;
        acceptingCalls = false;
        disposed = true;
        for (const panel of [...mountedPanels]) panel.destroy();
        mountedPanels.clear();
        listeners.clear();
        events = null;
        void mutationChain.finally(() => {
          app = null;
          services = null;
          store = null;
          operations = null;
        });
      });

      context.effects.add(
        context.services.settings.subscribe((change) => {
          if (!active) return;
          if (
            change.keys.includes("commentsEnabled") ||
            change.keys.includes("commentsOnMobile")
          ) {
            refreshAllDecors();
            refreshPanels();
            notifyChanged(activeCommentDocPath());
          }
        })
      );

      context.events.onWorkspace("active-leaf-change", () => {
        refreshPanels();
        notifyChanged(activeCommentDocPath());
      });

      context.events.onWorkspace("file-open", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        primeComments(isSidecarPath(file.path) ? docPathForSidecar(file.path) : file.path);
        refreshPanels();
      });

      context.events.onWorkspace("editor-menu", (menu, editor) => {
        const settings = context.services.settings.get();
        if (!settings.commentsEnabled || options.isMobile?.()) return;
        const view = context.services.editor.getViewForEditor(editor);
        if (!view) return;
        const path = context.services.editor.getFilePath(view);
        if (!path || isSidecarPath(path)) return;
        if (
          !settings.commentBubbleEverywhere &&
          !options.isFormatScopeAllowed(path)
        ) {
          return;
        }
        if (editor.getSelection().trim() === "") return;
        menu.addItem((item) =>
          item
            .setTitle("添加批注")
            .setIcon("wt-comment")
            .onClick(() => {
              if (acceptingCalls) void addCommentForView(view);
            })
        );
      });

      context.events.onVault("modify", (file) => {
        handleSidecarChanged(file.path);
      });
      context.events.onVault("create", (file) => {
        handleSidecarChanged(file.path);
      });
      context.events.onVault("rename", (file, oldPath) => {
        void handleVaultRename(file, oldPath).catch((error) => {
          console.error("[Writing Toolkit:comments] 同步批注伴随文件失败", error);
          new Notice("批注伴随文件同步失败，请检查系统日志");
        });
      });
      context.events.onVault("delete", (file) => {
        handleVaultDelete(file);
      });

      // .wt-comments 是隐藏目录，Obsidian 的 Vault 事件看不到它；回到窗口时
      // 主动重读一次当前文档的批注，保证 Agent 在外部改完文件后能及时看到。
      if (
        typeof context.events.onDom === "function" &&
        typeof window !== "undefined"
      ) {
        context.events.onDom(window, "focus", () => {
          if (!active) return;
          const docPath = activeCommentDocPath();
          if (!docPath) return;
          void reloadAndCheck(docPath)
            .catch((error) => {
              console.error("[Writing Toolkit:comments] 重读批注文件失败", error);
            });
        });
      }

      context.registrations.registerEditorExtension(
        buildExtensions({
          enabled: () =>
            context.services.settings.get().commentsEnabled &&
            !options.isMobile?.(),
          getComments: (path) => localStore.getCached(path),
          ensureLoaded: (path) => primeComments(path),
          onRevealComment: (path, comment) => {
            if (acceptingCalls) void revealInPanel(path, comment.id);
          },
          onAnchorsEdited: (path, edits) => applyAnchorEdits(path, edits),
        })
      );

      const unregister = context.services.ui.registerPanel(
        UI_SLOT_SIDEBAR_COMMENTS,
        (container) => {
          if (!active || disposed || !operations) {
            throw new Error("批注模块已停用");
          }
          const panel = createPanel(container, operations);
          const handle: CommentPanelHandle = {
            refresh: () => panel.refresh(),
            destroy: () => panel.destroy(),
            revealCard: (id, scroller) => panel.revealCard(id, scroller),
          };
          mountedPanels.add(handle);
          let destroyed = false;
          return {
            refresh: () => handle.refresh(),
            destroy: () => {
              if (destroyed) return;
              destroyed = true;
              mountedPanels.delete(handle);
              handle.destroy();
            },
          };
        }
      );
      context.effects.add(unregister);
    },
    deactivate() {
      acceptingCalls = false;
    },
    get operations() {
      if (!operations) throw new Error("批注模块尚未激活");
      return operations;
    },
  };
}
