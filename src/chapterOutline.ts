import {
  App,
  Component,
  MarkdownRenderer,
  Notice,
  TFile,
  type TAbstractFile,
  setIcon,
} from "obsidian";
import {
  attachOutlineEditing,
  countChars,
} from "./outlineText";

/** 输入停顿多久后自动写盘（毫秒） */
const AUTOSAVE_DELAY = 800;

/** 章纲面板的两种状态：阅读态渲染 Markdown，编辑态显示/编辑源码。 */
export type OutlinePanelMode = "read" | "edit";

/**
 * 打开章纲时的默认状态：
 * - 有内容 → 阅读态，先把 Markdown 渲染出来（这一版的核心诉求）；
 * - 空章纲 → 直接进编辑态，免得空面板还要再点一次。
 */
export function defaultOutlineMode(text: string): OutlinePanelMode {
  return text.trim() ? "read" : "edit";
}

function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/**
 * Vault 事件里的路径是否会影响当前章节目录：目录内文件、目录本身，
 * 或目录的任意祖先（例如「小说/正文」整体改名）。
 */
export function isOutlineFolderAffected(
  currentFolder: string,
  eventPath: string
): boolean {
  if (!currentFolder || !eventPath) return false;
  return (
    parentPath(eventPath) === currentFolder ||
    currentFolder === eventPath ||
    currentFolder.startsWith(eventPath + "/")
  );
}

export interface OutlinePanelEditorHandle {
  close(): void;
  flush(): Promise<void>;
  getFilePath(): string | null;
  onVaultRename(file: TAbstractFile, oldPath: string): Promise<void>;
  onVaultDelete(file: TAbstractFile): void;
  isAffected(path: string): boolean;
}

export interface OutlinePanelRuntime {
  readonly app: App;
  /** 章节识别统一由 Project Service 决定，面板不再复制路径规则。 */
  isChapter(file: TFile): boolean;
  /** 侧栏获得焦点后 getActiveFile() 可能为空，用最近章节兜底。 */
  fallbackFile(): TFile | null;
  /** 返回该章所属卷内的章节（按 Project Service 的顺序）。 */
  chapterFiles(file: TFile): TFile[];
  loadOutline(file: TFile): Promise<string>;
  saveOutline(file: TFile, value: string): Promise<void>;
  openEditor(
    file: TFile,
    chapters: TFile[],
    onDone: (file: TFile) => void
  ): OutlinePanelEditorHandle | null;
}

export interface ChapterOutlinePanelHandle {
  refresh(): void;
  flush(): Promise<void>;
  destroy(): void;
  onActiveLeafChange(): void;
  onVaultCreate(file: TAbstractFile): void;
  onVaultRename(file: TAbstractFile, oldPath: string): Promise<void>;
  onVaultDelete(file: TAbstractFile): void;
  onOutlineChanged(paths: readonly string[]): void;
}

/**
 * 侧栏「章纲」面板：
 * - 纯粹的章节便签文档形式，支持大段剧情速记、场景构思与零碎想法；
 * - 默认使用「独立伴生文件（.wt-outlines）」存储，完全不修改正文 YAML，保护正文纯净；
 * - 智能跟随正文章节，查阅设定卡/资料等非章节文件时保留当前章纲、不清空；
 * - 顶部只有章节标题（纯展示，不提供手动跳转），把宽度留给章纲正文。
 */
export class ChapterOutlinePanel implements ChapterOutlinePanelHandle {
  private readonly el: HTMLElement;
  private readonly runtime: OutlinePanelRuntime;

  /** 当前编辑目标文件 */
  private file: TFile | null = null;
  /** 文本内容 */
  private rawText = "";
  /** 最后一次确认已落盘的内容；只有 save 成功才推进。 */
  private persistedText = "";

  private textarea: HTMLTextAreaElement | null = null;
  private stateEl: HTMLElement | null = null;
  private editorModal: OutlinePanelEditorHandle | null = null;

  /** 阅读态 / 编辑态；阅读态 = Markdown 渲染结果，编辑态 = 源码 textarea */
  private mode: OutlinePanelMode = "read";
  /** 主内容区容器（head / foot 之外），切换模式时只重画它 */
  private bodyEl: HTMLElement | null = null;
  private modeBtn: HTMLButtonElement | null = null;
  /** 阅读态渲染的 Component：切章/切模式/销毁时必须 unload，否则链接与嵌入监听器泄漏 */
  private previewComponent: Component | null = null;
  /** 阅读态渲染代数：异步渲染晚到时丢弃旧结果 */
  private previewSeq = 0;
  /** 「退出编辑态」防重入：blur 与按钮点击可能同时触发 */
  private exitingEdit = false;
  /** 编辑态收到外部刷新：先挂起，等退出编辑态之后再 render（不能中途重建 DOM） */
  private pendingReload = false;
  /** 在途保存：blur 与按钮 click 可能各发一次，同文件同内容复用同一个 Promise */
  private inflightSave: {
    filePath: string;
    value: string;
    promise: Promise<boolean>;
  } | null = null;

  private autoSaveTimer = 0;
  private reloadTimer = 0;
  private renderSeq = 0;
  private destroyed = false;
  /** 文件被删除时丢弃 dirty 内容，避免把已删章纲重新写回来。 */
  private discardChanges = false;

  constructor(el: HTMLElement, runtime: OutlinePanelRuntime) {
    this.el = el;
    this.runtime = runtime;
  }

  destroy(): void {
    this.destroyed = true;
    this.renderSeq++;
    if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = 0;
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = 0;
    if (this.editorModal) {
      this.editorModal.close();
      this.editorModal = null;
    }
    this.unloadPreview();
    if (!this.discardChanges) void this.flush();
    this.el.empty();
    this.file = null;
    this.mode = "read";
    this.pendingReload = false;
    this.inflightSave = null;
    this.textarea = null;
    this.stateEl = null;
    this.bodyEl = null;
    this.modeBtn = null;
  }

  private isDirty(): boolean {
    return this.textarea !== null && this.textarea.value !== this.persistedText;
  }

  refresh(): void {
    this.scheduleReload();
  }

  async flush(): Promise<void> {
    this.flushAutoSave();
    await this.saveIfDirty();
  }

  /** 活动文件切换：智能识别章节 */
  onActiveLeafChange(): void {
    const active = this.runtime.app.workspace.getActiveFile();
    if (!(active instanceof TFile)) return;
    if (!this.runtime.isChapter(active)) {
      // 打开非章节文件（设定集、大纲、人物卡等），保留当前章纲，绝对不清空！
      return;
    }
    if (this.file && this.file.path === active.path) return;
    void this.selectFile(active);
  }

  onVaultCreate(file: TAbstractFile): void {
    if (file instanceof TFile && this.inChapterFolder(file.path)) {
      this.scheduleReload();
    }
  }

  async onVaultRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    if (!this.inChapterFolder(file.path, oldPath)) return;
    this.flushAutoSave();
    if (file instanceof TFile && this.file && this.file.path === oldPath) {
      this.file = file;
    }
    await this.saveIfDirty();
  }

  onVaultDelete(file: TAbstractFile): void {
    if (!this.inChapterFolder(file.path)) return;
    if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = 0;
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = 0;

    const currentPath = this.file?.path;
    if (
      currentPath === file.path ||
      (currentPath !== undefined && currentPath.startsWith(file.path + "/"))
    ) {
      // 作废在途 render：否则它晚到后会把已删的 TFile 写回 this.file、清掉 discardChanges。
      this.renderSeq++;
      this.pendingReload = false;
      this.discardChanges = true;
      this.file = null;
      this.editorModal?.onVaultDelete(file);
      this.editorModal = null;
    }
  }

  onOutlineChanged(paths: readonly string[]): void {
    const currentPath = this.file?.path;
    if (
      currentPath &&
      paths.some(
        (path) =>
          path === currentPath ||
          currentPath.startsWith(path + "/") ||
          path.startsWith(currentPath + "/")
      )
    ) {
      this.scheduleReload();
    }
  }

  scheduleReload(): void {
    if (this.destroyed) return;
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = 0;
      if (this.mode === "edit" && this.textarea) {
        // 编辑态绝不重建 DOM：重建会丢焦点/光标/滚动位置，还会把正在输入的内容
        // 当成“已保存”渲染出去。先保存挂起，等 exitEditMode 回阅读态时再统一 render。
        void this.saveIfDirty();
        this.pendingReload = true;
        return;
      }
      void this.saveIfDirty().then((saved) => {
        if (saved) void this.render();
      });
    }, 60);
  }

  private async selectFile(file: TFile): Promise<void> {
    const saved = await this.saveIfDirty();
    if (!saved) return;
    if (this.destroyed) return;
    this.file = file;
    this.discardChanges = false;
    await this.render();
  }

  private async saveIfDirty(): Promise<boolean> {
    if (!this.file || !this.textarea || this.discardChanges) return true;
    const file = this.file;
    const valueToSave = this.textarea.value;
    if (valueToSave === this.persistedText) {
      // 输入后又撤销回已保存内容：状态别停在「未保存」。
      this.setState(valueToSave.trim() ? "已保存" : "未填写");
      return true;
    }

    const inflight = this.inflightSave;
    if (
      inflight &&
      inflight.filePath === file.path &&
      inflight.value === valueToSave
    ) {
      return inflight.promise;
    }

    const promise = this.writeOutline(file, valueToSave);
    this.inflightSave = { filePath: file.path, value: valueToSave, promise };
    void promise.finally(() => {
      if (this.inflightSave?.promise === promise) this.inflightSave = null;
    });
    return promise;
  }

  /** 真正写盘。抽出来是为了 saveIfDirty 能在途去重、避免同一内容写两次。 */
  private async writeOutline(file: TFile, valueToSave: string): Promise<boolean> {
    this.rawText = valueToSave;
    this.setState("保存中…");
    try {
      await this.runtime.saveOutline(file, valueToSave);
      this.persistedText = valueToSave;
      this.setState(
        this.textarea?.value === valueToSave
          ? valueToSave.trim()
            ? "已保存"
            : "未填写"
          : "未保存"
      );
      return true;
    } catch (e) {
      console.error("保存章纲失败", e);
      this.setState("保存失败");
      new Notice("章纲保存失败");
      return false;
    }
  }

  private setState(text: string): void {
    if (!this.stateEl) return;
    this.stateEl.setText(text);
    this.stateEl.toggleClass(
      "is-dirty",
      text === "未保存" || text === "保存中…" || text === "保存失败"
    );
    this.stateEl.toggleClass("is-empty", text === "未填写");
  }

  private scheduleAutoSave(): void {
    if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = 0;
      void this.saveIfDirty();
    }, AUTOSAVE_DELAY);
  }

  private flushAutoSave(): void {
    if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = 0;
  }

  private resolveTarget(): TFile | null {
    const app = this.runtime.app;
    if (this.file) {
      const still = app.vault.getAbstractFileByPath(this.file.path);
      if (still instanceof TFile) return still;
    }
    const active = app.workspace.getActiveFile();
    if (active instanceof TFile && this.runtime.isChapter(active)) return active;
    return this.runtime.fallbackFile();
  }

  private async render(): Promise<void> {
    if (this.reloadTimer) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = 0;
    }
    this.pendingReload = false;
    if (this.destroyed) return;
    const seq = ++this.renderSeq;
    const target = this.resolveTarget();

    if (!target) {
      this.file = null;
      this.freshContainer();
      this.renderEmpty("在主编辑区打开正文章节，即可在此记录本章章纲。");
      return;
    }
    this.file = target;

    let loaded = "";
    try {
      loaded = await this.runtime.loadOutline(target);
    } catch {
      loaded = "";
    }
    if (this.destroyed || seq !== this.renderSeq) return;

    this.rawText = loaded;
    this.persistedText = loaded;
    this.discardChanges = false;
    this.mode = defaultOutlineMode(loaded);

    const chapters = this.runtime.chapterFiles(target);

    this.freshContainer();
    this.renderHead(target, chapters);

    const mainWrap = this.el.createDiv({ cls: "wt-outline-body" });
    this.bodyEl = mainWrap;
    this.renderBody();

    this.renderFoot();
  }

  private freshContainer(): void {
    this.unloadPreview();
    this.el.empty();
    this.el.addClass("wt-outline");
    this.textarea = null;
    this.stateEl = null;
    this.bodyEl = null;
    this.modeBtn = null;
  }

  private inChapterFolder(...paths: Array<string | undefined>): boolean {
    const folder = this.file?.parent?.path;
    if (!folder) return false;
    return paths.some(
      (path) => path !== undefined && isOutlineFolderAffected(folder, path)
    );
  }

  /** 顶部栏：左侧章节标题（纯展示） + 右侧统一规格工具栏 */
  private renderHead(file: TFile, chapters: TFile[]): void {
    const head = this.el.createDiv({ cls: "wt-outline-head" });
    const idx = chapters.findIndex((c) => c.path === file.path);

    // 1. 左侧章节标题：面板自动跟随当前正文章节，不提供手动跳转
    const title = head.createDiv({ cls: "wt-outline-head-title" });
    title.createSpan({ cls: "wt-outline-title-text", text: file.basename });
    if (chapters.length > 1 && idx >= 0) {
      title.createSpan({
        cls: "wt-outline-title-pos",
        text: `${idx + 1}/${chapters.length}`,
      });
    }

    // 2. 右侧统一尺寸的工具栏按钮组 [ ✎ ] [ ⛶ ]
    const toolbar = head.createDiv({ cls: "wt-outline-toolbar" });

    // ✎ 阅读 / 编辑切换
    const modeBtn = toolbar.createEl("button", {
      cls: "wt-outline-tb-btn wt-outline-mode-btn",
      attr: { type: "button" },
    });
    this.modeBtn = modeBtn;
    this.updateModeButton();
    this.keepEditingFocus(modeBtn);
    modeBtn.addEventListener("click", () => this.toggleMode());

    // ⛶ 放大浮窗编辑
    const expandBtn = toolbar.createEl("button", {
      cls: "wt-outline-tb-btn",
      attr: { type: "button", title: "在大窗口浮窗中编辑章纲" },
    });
    setIcon(expandBtn, "maximize-2");
    this.keepEditingFocus(expandBtn);
    expandBtn.addEventListener("click", () => void this.openEditorModal());
  }

  /**
   * 让工具栏按钮不要抢走 textarea 的焦点。
   * 否则点击时顺序是 blur → exitEditMode 开始保存 → click 里再保存一次：
   * 同一内容会写两遍，而且会先把旧章节的阅读态渲染出来闪一下。
   * 键盘 Tab 在编辑态被 attachOutlineEditing 拦成缩进，所以只影响鼠标/触摸。
   */
  private keepEditingFocus(btn: HTMLElement): void {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
  }

  /** 章节便签文档编辑器 */
  private renderEditor(container: HTMLElement, value: string): void {
    const ta = container.createEl("textarea", { cls: "wt-outline-textarea" });
    ta.value = value;
    ta.placeholder = "在此记录本章剧情梗概、场景构思、要点备忘…\n（支持标准 Markdown 语法，自动保存）";
    ta.spellcheck = false;
    this.textarea = ta;

    ta.addEventListener("input", () => {
      this.rawText = ta.value;
      this.updateStatsDirectly();
      this.setState("未保存");
      this.scheduleAutoSave();
    });

    attachOutlineEditing(ta, () => {
      this.rawText = ta.value;
      this.updateStatsDirectly();
      this.setState("未保存");
      this.scheduleAutoSave();
    });

    ta.addEventListener("blur", () => {
      // 失焦 = 本次编辑结束：先落盘，再回阅读态（保存失败则留在编辑态，避免丢内容）。
      this.flushAutoSave();
      void this.exitEditMode();
    });

    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        // ⌘/Ctrl + ↵ = 保存并回到阅读态（与失焦同一条路径）。
        void this.exitEditMode();
      }
    });
  }

  /** 按当前模式重画主内容区；顶栏与底栏保持不动。 */
  private renderBody(): void {
    const body = this.bodyEl;
    if (!body) return;
    this.unloadPreview();
    this.textarea = null;
    body.empty();
    if (this.mode === "edit") {
      this.renderEditor(body, this.rawText);
    } else {
      this.renderPreview(body);
    }
    this.updateStatsDirectly();
  }

  /**
   * 阅读态：把章纲当 Markdown 渲染。
   * 渲染是异步的，用 previewSeq 丢弃过期结果；component 必须随面板卸载，
   * 否则每次切章都会遗留一批链接/嵌入监听器。
   */
  private renderPreview(container: HTMLElement): void {
    const preview = container.createDiv({
      cls: "wt-outline-preview markdown-rendered",
    });
    preview.addEventListener("dblclick", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("a, button, input, textarea, select")) return;
      this.enterEditMode();
    });
    preview.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      // 任务列表复选框只是渲染结果：这里没有可回写的正文文件，勾了也不会保存，
      // 拦掉默认勾选，避免让人以为改动生效（要勾选请进编辑态改 `- [ ]`）。
      if (target?.closest('input[type="checkbox"]')) event.preventDefault();
    });

    if (!this.rawText.trim()) {
      const empty = preview.createDiv({ cls: "wt-outline-preview-empty" });
      const icon = empty.createDiv({ cls: "wt-outline-empty-icon" });
      setIcon(icon, "pencil");
      empty.createDiv({
        text: "这一章还没有章纲。写下剧情梗概、场景要点或备忘，阅读时会自动渲染 Markdown。",
      });
      const start = empty.createEl("button", {
        cls: "wt-outline-preview-start",
        text: "开始写章纲",
        attr: { type: "button" },
      });
      start.addEventListener("click", () => this.enterEditMode());
      return;
    }

    const component = new Component();
    component.load();
    this.previewComponent = component;
    const seq = ++this.previewSeq;
    const app = this.runtime.app;
    // sourcePath 用正文章节路径，[[双链]] 与图片等相对路径才按章节所在目录解析。
    const sourcePath = this.file?.path ?? "";
    const markdown = this.rawText;
    void MarkdownRenderer.render(app, markdown, preview, sourcePath, component)
      .then(() => {
        // 过期渲染（切章/切模式/销毁）已由 unloadPreview 统一卸载，这里不重复 unload。
        if (this.destroyed || seq !== this.previewSeq) return;
      })
      .catch((error) => {
        if (this.destroyed || seq !== this.previewSeq) return;
        console.error("写作工具箱：章纲 Markdown 渲染失败", error);
        component.unload();
        if (this.previewComponent === component) this.previewComponent = null;
        preview.empty();
        preview.createEl("pre", {
          cls: "wt-outline-preview-fallback",
          text: markdown,
        });
      });
  }

  /** 卸载当前阅读态渲染（切模式、切章、销毁时都必须调用）。 */
  private unloadPreview(): void {
    this.previewSeq++;
    const component = this.previewComponent;
    this.previewComponent = null;
    if (component) component.unload();
  }

  private toggleMode(): void {
    if (this.mode === "edit") void this.exitEditMode();
    else this.enterEditMode();
  }

  private enterEditMode(): void {
    if (this.mode === "edit" || !this.file) return;
    this.mode = "edit";
    this.renderBody();
    this.updateModeButton();
    const ta = this.textarea;
    if (ta) {
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    }
  }

  /** 保存后回到阅读态；保存失败就留在编辑态，不丢用户正在写的内容。 */
  private async exitEditMode(): Promise<void> {
    if (this.mode !== "edit" || this.exitingEdit) return;
    this.exitingEdit = true;
    try {
      this.flushAutoSave();
      const saved = await this.saveIfDirty();
      if (!saved || this.destroyed) return;
      if (this.mode !== "edit" || !this.bodyEl) return;
      this.mode = "read";
      if (this.pendingReload) {
        // 编辑期间攒下的外部刷新：现在才重建（render 会按最新磁盘内容重画）。
        this.pendingReload = false;
        void this.render();
      } else {
        this.renderBody();
        this.updateModeButton();
      }
    } finally {
      this.exitingEdit = false;
    }
  }

  private updateModeButton(): void {
    const btn = this.modeBtn;
    if (!btn) return;
    const editing = this.mode === "edit";
    setIcon(btn, editing ? "check" : "pencil");
    const label = editing ? "完成编辑，回到渲染后的章纲" : "编辑本章章纲";
    btn.setAttr("title", label);
    btn.setAttr("aria-label", label);
    btn.toggleClass("is-active", editing);
  }

  /** 底部统计与状态 */
  private renderFoot(): void {
    const foot = this.el.createDiv({ cls: "wt-outline-foot" });

    const statsEl = foot.createDiv({ cls: "wt-outline-stats-text" });
    const chars = countChars(this.rawText);
    const paragraphs = this.rawText.split("\n").filter((l) => l.trim().length > 0).length;
    statsEl.setText(paragraphs === 0 ? "未填写" : `${paragraphs} 段 · ${chars} 字`);

    this.stateEl = foot.createSpan({
      cls: "wt-outline-state",
      text: this.rawText.trim() ? "已保存" : "未填写",
    });
  }

  private updateStatsDirectly(): void {
    const statsEl = this.el.querySelector<HTMLElement>(".wt-outline-stats-text");
    if (statsEl) {
      const chars = countChars(this.rawText);
      const paragraphs = this.rawText.split("\n").filter((l) => l.trim().length > 0).length;
      statsEl.setText(paragraphs === 0 ? "未填写" : `${paragraphs} 段 · ${chars} 字`);
    }
  }

  private async openEditorModal(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const chapters = this.runtime.chapterFiles(file);
    this.flushAutoSave();
    const saved = await this.saveIfDirty();
    if (!saved) return;
    if (this.destroyed || this.editorModal) return;
    this.editorModal = this.runtime.openEditor(
      file,
      chapters,
      (finalFile) => {
        this.editorModal = null;
        if (finalFile instanceof TFile) this.file = finalFile;
        this.scheduleReload();
      }
    );
  }

  private renderEmpty(text: string): void {
    const empty = this.el.createDiv({ cls: "wt-outline-empty" });
    const icon = empty.createDiv({ cls: "wt-outline-empty-icon" });
    setIcon(icon, "file-text");
    empty.createDiv({ text });
  }
}
