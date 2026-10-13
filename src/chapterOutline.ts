import { Menu, Notice, TFile, setIcon } from "obsidian";
import { OutlineEditorModal } from "./outlineModal";
import {
  DEFAULT_DRAFT_KEYWORDS,
  attachOutlineEditing,
  countChars,
  getOutlinePath,
  isDraftPath,
  loadOutline,
  saveOutline,
  naturalCompare,
} from "./outlineText";

export * from "./outlineText";

/** 输入停顿多久后自动写盘（毫秒） */
const AUTOSAVE_DELAY = 800;

/**
 * 侧栏「章纲」面板：
 * - 纯粹的章节便签文档形式，支持大段剧情速记、场景构思与零碎想法；
 * - 默认使用「独立伴生文件（.wt-outlines）」存储，完全不修改正文 YAML，保护正文纯净；
 * - 智能跟随正文章节，查阅设定卡/资料等非章节文件时，章纲自动锁定保留；
 * - 支持图钉（Pin）锁定：锁定后查阅任何文件都不切换；
 * - 顶部紧凑导航胶囊：上一章 / 章节快速跳转菜单 / 下一章，不抢占垂直空间。
 */
export class ChapterOutlinePanel {
  private readonly el: HTMLElement;
  private readonly plugin: any;

  /** 当前编辑目标文件 */
  private file: TFile | null = null;
  /** 是否处于图钉锁定状态（锁定后打开任何文件都不跳走） */
  private isPinned = false;
  /** 文本内容 */
  private rawText = "";
  private loadedText = "";

  private textarea: HTMLTextAreaElement | null = null;
  private stateEl: HTMLElement | null = null;
  private editorModal: OutlineEditorModal | null = null;

  private autoSaveTimer = 0;
  private reloadTimer = 0;
  private renderSeq = 0;
  private destroyed = false;
  private cleanups: Array<() => void> = [];

  constructor(el: HTMLElement, plugin: any) {
    this.el = el;
    this.plugin = plugin;

    // 活动文件切换：章节自动跟随；非章节保留当前章纲（方便对照查阅）
    const ws = plugin.app.workspace;
    const activeRef = ws.on("active-leaf-change", () => this.onActiveFileChange());
    this.cleanups.push(() => ws.offref(activeRef));

    // 监听重命名：跟着切换当前章；章纲文件的搬迁由插件级监听统一处理
    const vault = plugin.app.vault;
    const renRef = vault.on("rename", async (file: TFile, oldPath: string) => {
      if (file instanceof TFile && this.file && this.file.path === oldPath) {
        this.file = file;
      }
      if (this.inChapterFolder(file?.path) || this.inChapterFolder(oldPath)) {
        this.scheduleReload();
      }
    });
    this.cleanups.push(() => vault.offref(renRef));

    // 监听删除：同步清理关联章纲
    const delRef = vault.on("delete", async (file: TFile) => {
      if (file instanceof TFile) {
        const outlinePath = getOutlinePath(file.path);
        if (await vault.adapter.exists(outlinePath)) {
          try {
            await vault.adapter.trashLocal(outlinePath);
          } catch {
            await vault.adapter.remove(outlinePath);
          }
        }
      }
      if (this.inChapterFolder(file?.path)) this.scheduleReload();
    });
    this.cleanups.push(() => vault.offref(delRef));

    const createRef = vault.on("create", (file: TFile) => {
      if (this.inChapterFolder(file?.path)) this.scheduleReload();
    });
    this.cleanups.push(() => vault.offref(createRef));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = 0;
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = 0;
    if (this.editorModal) {
      this.editorModal.close();
      this.editorModal = null;
    }
    void this.saveIfDirty();
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
    this.el.empty();
    this.file = null;
    this.textarea = null;
    this.stateEl = null;
  }

  focusEditor(): void {
    this.textarea?.focus();
  }

  private isFocused(): boolean {
    return this.textarea !== null && document.activeElement === this.textarea;
  }

  private isDirty(): boolean {
    return this.textarea !== null && this.textarea.value !== this.loadedText;
  }

  /** 活动文件切换：智能识别章节 */
  private onActiveFileChange(): void {
    if (this.isPinned) return; // 图钉锁定中，不跟随切换
    const active = this.plugin.app.workspace.getActiveFile() as TFile | null;
    if (!(active instanceof TFile)) return;
    const snapshotFolder = this.plugin.settings?.snapshotFolder ?? ".wt-snapshots";
    const keywords = this.plugin.settings?.draftKeywords ?? DEFAULT_DRAFT_KEYWORDS;
    if (!isDraftPath(active.path, snapshotFolder, keywords)) {
      // 打开非章节文件（设定集、大纲、人物卡等），保留当前章纲，绝对不清空！
      return;
    }
    if (this.file && this.file.path === active.path) return;
    void this.selectFile(active);
  }

  scheduleReload(): void {
    if (this.destroyed) return;
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = 0;
      void this.saveIfDirty().then(() => this.render());
    }, 60);
  }

  private async selectFile(file: TFile): Promise<void> {
    await this.saveIfDirty();
    this.file = file;
    await this.render();
  }

  private async saveIfDirty(): Promise<void> {
    if (!this.file || !this.textarea) return;
    const valueToSave = this.textarea.value;
    if (valueToSave === this.loadedText) return;

    this.loadedText = valueToSave;
    this.rawText = valueToSave;
    this.setState("保存中…");
    try {
      await saveOutline(
        this.plugin.app,
        this.file,
        valueToSave,
        this.plugin.settings?.outlineStorageMode ?? "sidecar"
      );
      this.setState(valueToSave.trim() ? "已保存" : "未填写");
    } catch (e) {
      console.error("保存章纲失败", e);
      this.setState("保存失败");
      new Notice("章纲保存失败");
    }
  }

  private setState(text: string): void {
    if (!this.stateEl) return;
    this.stateEl.setText(text);
    this.stateEl.toggleClass("is-dirty", text === "未保存");
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

  private resolveTarget(snapshotFolder: string): TFile | null {
    const app = this.plugin.app;
    if (this.file) {
      const still = app.vault.getAbstractFileByPath(this.file.path);
      if (still instanceof TFile) return still;
    }
    const active = app.workspace.getActiveFile();
    const keywords = this.plugin.settings?.draftKeywords ?? DEFAULT_DRAFT_KEYWORDS;
    if (active instanceof TFile && isDraftPath(active.path, snapshotFolder, keywords)) {
      return active;
    }
    return null;
  }

  private chapterFiles(file: TFile): TFile[] {
    const folder = file.parent;
    if (!folder) return [file];
    const snapshotFolder = this.plugin.settings?.snapshotFolder ?? ".wt-snapshots";
    const keywords = this.plugin.settings?.draftKeywords ?? DEFAULT_DRAFT_KEYWORDS;
    const out = (folder.children ?? []).filter(
      (c: unknown): c is TFile =>
        c instanceof TFile &&
        c.extension === "md" &&
        isDraftPath(c.path, snapshotFolder, keywords)
    );
    out.sort((a, b) => naturalCompare(a.basename, b.basename));
    return out.length > 0 ? out : [file];
  }

  private async render(): Promise<void> {
    if (this.destroyed) return;
    const seq = ++this.renderSeq;
    const app = this.plugin.app;
    const snapshotFolder = this.plugin.settings?.snapshotFolder ?? ".wt-snapshots";
    const target = this.resolveTarget(snapshotFolder);

    if (!target) {
      this.file = null;
      this.freshContainer();
      this.renderEmpty("在主编辑区打开正文章节，即可在此记录本章章纲。");
      return;
    }
    this.file = target;

    let loaded = "";
    try {
      const res = await loadOutline(
        app,
        target,
        this.plugin.settings?.outlineStorageMode ?? "sidecar"
      );
      loaded = res.value;
    } catch {
      loaded = "";
    }
    if (seq !== this.renderSeq) return;

    this.rawText = loaded;
    this.loadedText = loaded;

    const chapters = this.chapterFiles(target);

    this.freshContainer();
    this.renderHead(target, chapters);

    const mainWrap = this.el.createDiv({ cls: "wt-outline-body" });
    this.renderEditor(mainWrap, loaded);

    this.renderFoot();
  }

  private freshContainer(): void {
    this.el.empty();
    this.el.addClass("wt-outline");
    this.textarea = null;
    this.stateEl = null;
  }

  private inChapterFolder(path?: string): boolean {
    const folder = this.file?.parent?.path;
    if (path === undefined || folder === undefined) return false;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return parent === folder;
  }

  /** 顶部栏：左侧章节标题 + 右侧统一规格工具栏 */
  private renderHead(file: TFile, chapters: TFile[]): void {
    const head = this.el.createDiv({ cls: "wt-outline-head" });
    const idx = chapters.findIndex((c) => c.path === file.path);

    // 1. 左侧章节标题按钮（点击弹出快速切换菜单）
    const titleBtn = head.createEl("button", {
      cls: "wt-outline-title-btn",
      attr: { type: "button", title: "点击切换章节" },
    });
    titleBtn.createSpan({ cls: "wt-outline-title-text", text: file.basename });
    if (chapters.length > 1 && idx >= 0) {
      titleBtn.createSpan({
        cls: "wt-outline-title-pos",
        text: `${idx + 1}/${chapters.length}`,
      });
    }
    const chevron = titleBtn.createSpan({ cls: "wt-outline-title-chevron" });
    setIcon(chevron, "chevron-down");
    titleBtn.addEventListener("click", (e) => {
      this.showChapterMenu(chapters, e);
    });

    // 2. 右侧统一尺寸的工具栏按钮组 [ ◀ ] [ ▶ ] [ 📌 ] [ ↗ ] [ ⛶ ]
    const toolbar = head.createDiv({ cls: "wt-outline-toolbar" });

    // ◀ 上一章
    const prevBtn = toolbar.createEl("button", {
      cls: "wt-outline-tb-btn",
      attr: {
        type: "button",
        title: idx > 0 ? `上一章: ${chapters[idx - 1].basename}` : "已是第一章",
      },
    });
    setIcon(prevBtn, "chevron-left");
    if (idx <= 0) prevBtn.disabled = true;
    prevBtn.addEventListener("click", () => {
      if (idx > 0) void this.selectFile(chapters[idx - 1]);
    });

    // ▶ 下一章
    const nextBtn = toolbar.createEl("button", {
      cls: "wt-outline-tb-btn",
      attr: {
        type: "button",
        title: idx >= 0 && idx < chapters.length - 1 ? `下一章: ${chapters[idx + 1].basename}` : "已是最后一章",
      },
    });
    setIcon(nextBtn, "chevron-right");
    if (idx < 0 || idx >= chapters.length - 1) nextBtn.disabled = true;
    nextBtn.addEventListener("click", () => {
      if (idx >= 0 && idx < chapters.length - 1) void this.selectFile(chapters[idx + 1]);
    });

    // 📌 图钉锁定
    const pinBtn = toolbar.createEl("button", {
      cls: `wt-outline-tb-btn wt-outline-pin-btn ${this.isPinned ? "is-pinned" : ""}`,
      attr: {
        type: "button",
        title: this.isPinned ? "取消锁定当前章纲" : "锁定当前章纲（查阅其他文件时不切换）",
      },
    });
    setIcon(pinBtn, "pin");
    pinBtn.addEventListener("click", () => {
      this.isPinned = !this.isPinned;
      pinBtn.toggleClass("is-pinned", this.isPinned);
      pinBtn.setAttr("title", this.isPinned ? "取消锁定当前章纲" : "锁定当前章纲（查阅其他文件时不切换）");
      new Notice(this.isPinned ? "已锁定当前章纲，查阅设定集不会离开" : "已解除锁定，将自动跟随正在编辑的章节");
    });

    // ↗ 在主编辑区打开本章正文
    const openBtn = toolbar.createEl("button", {
      cls: "wt-outline-tb-btn",
      attr: { type: "button", title: "在主编辑区打开本章正文" },
    });
    setIcon(openBtn, "external-link");
    openBtn.addEventListener("click", () => void this.openFile(file));

    // ⛶ 放大浮窗编辑
    const expandBtn = toolbar.createEl("button", {
      cls: "wt-outline-tb-btn",
      attr: { type: "button", title: "在大窗口浮窗中编辑章纲" },
    });
    setIcon(expandBtn, "maximize-2");
    expandBtn.addEventListener("click", () => void this.openEditorModal());
  }

  /** 弹出轻量章节切换菜单 */
  private showChapterMenu(chapters: TFile[], e: MouseEvent): void {
    const menu = new Menu();
    chapters.forEach((ch, i) => {
      const isCurrent = ch.path === this.file?.path;
      menu.addItem((item) => {
        item
          .setTitle(`${i + 1}. ${ch.basename}`)
          .setChecked(isCurrent)
          .onClick(() => {
            if (ch.path !== this.file?.path) {
              void this.selectFile(ch);
            }
          });
      });
    });
    menu.showAtMouseEvent(e);
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
      this.flushAutoSave();
      void this.saveIfDirty();
    });

    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.flushAutoSave();
        void this.saveIfDirty();
      }
    });
  }

  /** 底部统计与状态 */
  private renderFoot(): void {
    const foot = this.el.createDiv({ cls: "wt-outline-foot" });

    const statsEl = foot.createDiv({ cls: "wt-outline-stats-text" });
    const chars = countChars(this.rawText);
    const paragraphs = this.rawText.split("\n").filter((l) => l.trim().length > 0).length;
    statsEl.setText(paragraphs === 0 ? "未填写" : `${paragraphs} 段 · ${chars} 字`);

    this.stateEl = foot.createEl("span", {
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
    const chapters = this.chapterFiles(file);
    this.flushAutoSave();
    await this.saveIfDirty();
    if (this.editorModal) return;
    this.editorModal = new OutlineEditorModal(
      this.plugin.app,
      file,
      chapters,
      (finalFile) => {
        this.editorModal = null;
        if (finalFile instanceof TFile) this.file = finalFile;
        this.scheduleReload();
      }
    );
    this.editorModal.open();
  }

  private async openFile(file: TFile): Promise<void> {
    await this.saveIfDirty();
    const leaf = this.plugin.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  private renderEmpty(text: string): void {
    const empty = this.el.createDiv({ cls: "wt-outline-empty" });
    const icon = empty.createDiv({ cls: "wt-outline-empty-icon" });
    setIcon(icon, "file-text");
    empty.createDiv({ text });
  }
}
