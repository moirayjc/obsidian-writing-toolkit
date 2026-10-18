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
  WtComment,
  buildAgentPrompt,
  docPathForSidecar,
  formatTimestamp,
  isSidecarPath,
  legacySidecarPathFor,
  locateAll,
  nextCommentId,
  paragraphAt,
  sidecarPathFor,
} from "../comments";
import {
  buildCommentExtensions,
  dispatchCommentRefresh,
} from "../commentDecor";
import {
  CommentPanelBody,
  type CommentPanelHost,
  type CommentPanelItem,
  type CommentPanelModel,
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
import {
  CommentDraftModal,
  ConfirmModal,
} from "../promptModal";
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
  save(docPath: string, comments: readonly WtComment[]): Promise<void>;
  handleModified(path: string): string | null;
  handleDeleted(path: string): string | null;
  handleRenamed(oldPath: string, newPath: string): string[];
  /** 启动时把旧版同目录批注收进 `.wt-comments/`（可选，测试桩可省略）。 */
  migrateLegacySidecars?(): Promise<number>;
  /** 正文目录改名时同步搬镜像目录（可选，测试桩可省略）。 */
  migrateFolderPrefix?(oldFolder: string, newFolder: string): Promise<number>;
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
  const createConfirm =
    factories.createConfirm ?? ((...args) => new ConfirmModal(...args));

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

  async function mutateComments(
    docPath: string,
    mutator: (list: WtComment[]) => WtComment[]
  ): Promise<boolean> {
    const runtime = requireRuntime();
    try {
      await enqueueMutation(async () => {
        const list = await runtime.store.reload(docPath);
        const next = mutator([...list]);
        await runtime.store.save(docPath, next);
      });
      onCommentsChanged(docPath);
      return true;
    } catch (error) {
      console.error("[Writing Toolkit:comments] 保存批注失败", error);
      new Notice("批注保存失败（详见控制台）");
      return false;
    }
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
      return { docPath: null, docName: null, loading: false, items: [] };
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
    const items: CommentPanelItem[] = comments.map((comment) => {
      const hit = byId.get(comment.id);
      return {
        id: comment.id,
        status: comment.status,
        quote: comment.quote,
        content: comment.content,
        reply: comment.reply,
        lineHint: comment.lineHint,
        createdAt: comment.createdAt,
        locatedLine: hit ? hit.lineFrom : null,
        via: hit ? hit.via : null,
      };
    });
    return { docPath, docName, loading, items };
  }

  function openCommentEditor(path: string, comment: WtComment): void {
    const runtime = requireRuntime();
    createDraft(
      runtime.app,
      `批注 ${comment.id}`,
      comment.content,
      (content) => {
        if (!acceptingCalls) return;
        void mutateComments(path, (list) =>
          list.map((item) =>
            item.id === comment.id ? { ...item, content } : item
          )
        );
      }
    ).open();
  }

  async function toggleCommentResolvedFor(
    path: string,
    id: number
  ): Promise<void> {
    await mutateComments(path, (list) =>
      list.map((comment) =>
        comment.id === id
          ? {
              ...comment,
              status:
                comment.status === "resolved" ? "pending" : "resolved",
            }
          : comment
      )
    );
  }

  function showUndoNotice(text: string, onUndo: () => void): void {
    const fragment = createFragment();
    const label = createSpan({ text });
    const undoBtn = createEl("button", {
      cls: "wt-notice-undo",
      text: "撤销",
    });
    fragment.append(label, undoBtn);
    const notice = new Notice(fragment, 6000);
    // 按钮寿命 = Notice 节点寿命（6 秒后整体回收），用 onclick 避免登记一个
    // 脱离 EventScope 的全局监听器。
    undoBtn.onclick = () => {
      notice.hide();
      onUndo();
    };
  }

  async function deleteCommentById(path: string, id: number): Promise<void> {
    let removed: WtComment | null = null;
    let removedIndex = 0;
    const ok = await mutateComments(path, (list) => {
      const index = list.findIndex((comment) => comment.id === id);
      if (index < 0) return list;
      removedIndex = index;
      removed = list[index];
      return list.filter((comment) => comment.id !== id);
    });
    if (!ok || !removed) return;
    const deleted = removed;
    showUndoNotice(`已删除批注 #${id}`, () => {
      void mutateComments(path, (list) => {
        if (list.some((comment) => comment.id === id)) return list;
        const next = [...list];
        next.splice(Math.min(removedIndex, next.length), 0, deleted);
        return next;
      });
    });
  }

  async function runClearResolvedComments(
    docPath?: string
  ): Promise<void> {
    const runtime = requireRuntime();
    const path = docPath || activeCommentDocPath();
    if (!path) {
      new Notice("先打开一篇文档");
      return;
    }
    const list = await runtime.store.load(path);
    const resolved = list.filter(
      (comment) => comment.status === "resolved"
    ).length;
    if (resolved === 0) {
      new Notice("这篇文档还没有已处理的批注");
      return;
    }
    createConfirm(
      runtime.app,
      "清除已处理的批注",
      `将删除这篇文档里的 ${resolved} 条已处理批注（Agent 的回复会一起删掉），正文不受影响。此操作不能撤销。`,
      "清除",
      () => {
        if (!acceptingCalls) return;
        void mutateComments(path, (comments) =>
          comments.filter((comment) => comment.status !== "resolved")
        ).then((ok) => {
          if (ok) new Notice(`已清除 ${resolved} 条已处理批注`);
        });
      },
      true
    ).open();
  }

  async function revealCommentInDoc(
    file: TFile,
    comment: WtComment
  ): Promise<void> {
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
      if (!target) return;
      await target.openFile(file);
    }
    runtime.services.ui.reveal(target);
    const view = target.view instanceof MarkdownView ? target.view : null;
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
    if (!settings.commentsEnabled) {
      new Notice("批注功能已关闭（设置 → 写作 → 批注）");
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
          status: "pending",
          quote,
          paragraph: paragraph?.text.trim() ?? "",
          paragraphHint: paragraph?.index ?? 0,
          lineHint,
          createdAt: formatTimestamp(),
          content: "",
          reply: "",
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
        void mutateComments(path, (list) =>
          list.map((comment) =>
            comment.id === id ? { ...comment, content } : comment
          )
        );
        new Notice(`批注已保存到「${sidecarPath}」`);
      },
      () => {
        if (!acceptingCalls) return;
        void mutateComments(path, (list) =>
          list.filter(
            (comment) =>
              comment.id !== id || comment.content.trim() !== ""
          )
        );
      }
    ).open();
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
            }
          : item
      )
    );
    new Notice(`已把批注 #${id} 重新绑定到选中的文字`);
  }

  function copyAgentPrompt(docPath?: string): void {
    const runtime = requireRuntime();
    const path = docPath || activeCommentDocPath();
    if (!path) {
      new Notice("先打开一篇文档");
      return;
    }
    void runtime.store
      .load(path)
      .then((list) => {
        const pending = list.filter(
          (comment) => comment.status === "pending"
        ).length;
        if (pending === 0) {
          new Notice("这篇文档没有待处理的批注");
          return;
        }
        const prompt = buildAgentPrompt(path, {
          pending,
          resolved: list.length - pending,
        });
        navigator.clipboard.writeText(prompt).then(
          () =>
            new Notice(
              `已复制处理指令（${pending} 条待处理）：发给 Agent，它会按批注文件改稿`
            ),
          () => new Notice("复制到剪贴板失败")
        );
      })
      .catch((error) => {
        console.error("[Writing Toolkit:comments] 读取批注失败", error);
        new Notice("读取批注失败（详见控制台）");
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
    const docPath = runtime.store.handleModified(path);
    if (docPath) onCommentsChanged(docPath);
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
      // 旧版把批注放在正文同目录；启动时一次性收进 .wt-comments/。
      const migrateLegacy = store.migrateLegacySidecars;
      if (typeof migrateLegacy === "function") {
        void migrateLegacy
          .call(store)
          .then((moved) => {
            if (moved > 0) {
              new Notice(
                `写作工具箱：已把 ${moved} 个批注文件移到 .wt-comments/`
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
        toggleCommentResolved(docPath, id) {
          assertAcceptingCalls();
          const path = docPath || activeCommentDocPath();
          if (path) void toggleCommentResolvedFor(path, id);
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
        deleteComment(docPath, id) {
          assertAcceptingCalls();
          const path = docPath || activeCommentDocPath();
          if (path) void deleteCommentById(path, id);
        },
        rebindComment(docPath, id) {
          assertAcceptingCalls();
          rebindComment(docPath, id);
        },
        copyAgentPrompt(docPath) {
          assertAcceptingCalls();
          copyAgentPrompt(docPath);
        },
        clearResolvedComments(docPath) {
          assertAcceptingCalls();
          void runClearResolvedComments(docPath);
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
          if (change.keys.includes("commentsEnabled")) {
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
        if (!settings.commentsEnabled) return;
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
          void localStore
            .reload(docPath)
            .then(() => {
              if (!active) return;
              onCommentsChanged(docPath);
            })
            .catch((error) => {
              console.error("[Writing Toolkit:comments] 重读批注文件失败", error);
            });
        });
      }

      context.registrations.registerEditorExtension(
        buildExtensions({
          enabled: () => context.services.settings.get().commentsEnabled,
          getComments: (path) => localStore.getCached(path),
          ensureLoaded: (path) => primeComments(path),
          onRevealComment: (path, comment) => {
            if (acceptingCalls) void revealInPanel(path, comment.id);
          },
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
