import {
  App,
  Modal,
  Notice,
  TFile,
  type TAbstractFile,
  setIcon,
} from "obsidian";
import {
  attachOutlineEditing,
  countChars,
  countPoints,
} from "./outlineText";

/** 输入停顿多久后自动写盘（毫秒），与侧栏面板保持一致 */
const AUTOSAVE_DELAY = 800;

export interface OutlineEditorStorage {
  load(file: TFile): Promise<string>;
  save(file: TFile, value: string): Promise<void>;
}

function iconButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void
): HTMLButtonElement {
  const btn = parent.createEl("button", {
    cls: "wt-outline-icon-btn",
    attr: { type: "button", "aria-label": label, title: label },
  });
  setIcon(btn, icon);
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * 章纲大窗口编辑器：侧栏太窄时，用它在宽敞的浮窗里整理一整章要点。
 * 自动保存、回车续写要点、Tab 缩进、⌘↑/↓ 切章节等手感与侧栏完全一致。
 */
export class OutlineEditorModal extends Modal {
  private readonly chapters: TFile[];
  private readonly storage: OutlineEditorStorage;
  private readonly onDone: (file: TFile) => void;
  private file: TFile;
  private textarea: HTMLTextAreaElement | null = null;
  private posEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private stateEl: HTMLElement | null = null;
  private prevBtn: HTMLButtonElement | null = null;
  private nextBtn: HTMLButtonElement | null = null;
  private persistedText = "";
  private autoSaveTimer = 0;
  private renderSeq = 0;
  private closed = false;
  private discardChanges = false;
  private suppressSaveOnClose = false;
  private doneNotified = false;

  constructor(
    app: App,
    file: TFile,
    chapters: TFile[],
    storage: OutlineEditorStorage,
    onDone: (file: TFile) => void
  ) {
    super(app);
    this.file = file;
    this.chapters = chapters.some((c) => c.path === file.path)
      ? chapters
      : [...chapters, file];
    this.storage = storage;
    this.onDone = onDone;
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.modalEl.addClass("wt-outline-modal");
    this.contentEl.addClass("wt-outline-modal-body");
    await this.renderFile(this.file, true);
  }

  onClose(): void {
    this.closed = true;
    this.renderSeq++;
    if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = 0;
    const file = this.file;
    const saving =
      this.discardChanges || this.suppressSaveOnClose
        ? Promise.resolve(true)
        : this.saveIfDirty();
    this.contentEl.empty();
    this.textarea = null;
    this.posEl = null;
    this.statsEl = null;
    this.stateEl = null;
    this.prevBtn = null;
    this.nextBtn = null;
    void saving.finally(() => {
      if (this.doneNotified) return;
      this.doneNotified = true;
      this.onDone(file);
    });
  }

  async flush(): Promise<void> {
    this.flushAutoSave();
    await this.saveIfDirty();
  }

  getFilePath(): string | null {
    return this.file.path;
  }

  isAffected(path: string): boolean {
    return (
      this.file.path === path ||
      this.file.path.startsWith(path + "/") ||
      path.startsWith(this.file.path + "/")
    );
  }

  async onVaultRename(
    file: TFile | TAbstractFile,
    oldPath: string
  ): Promise<void> {
    if (!this.isAffected(file.path) && !this.isAffected(oldPath)) return;
    this.flushAutoSave();
    if (file instanceof TFile && this.file.path === oldPath) this.file = file;
    const saved = await this.saveIfDirty();
    if (!saved || this.closed) return;
    this.suppressSaveOnClose = true;
    this.close();
  }

  onVaultDelete(file: TFile | TAbstractFile): void {
    if (!this.isAffected(file.path)) return;
    this.discardChanges = true;
    this.flushAutoSave();
    this.close();
  }

  /** 读章纲：优先读取伴生文件，兼容旧 Frontmatter */
  private async readOutline(file: TFile): Promise<string | null> {
    try {
      return await this.storage.load(file);
    } catch (error) {
      console.error("写作工具箱：读取章纲失败", error);
      new Notice("写作工具箱：读取章纲失败");
      return null;
    }
  }

  private async saveIfDirty(): Promise<boolean> {
    const ta = this.textarea;
    if (!ta || this.discardChanges) return true;
    const value = ta.value;
    if (value === this.persistedText) return true;
    const file = this.file;
    this.setState("保存中…");
    try {
      await this.storage.save(file, value);
      this.persistedText = value;
      if (file.path === this.file.path && this.textarea?.value === value) {
        this.setState(value.trim() ? "已保存" : "未填写");
      } else if (file.path === this.file.path) {
        this.setState("未保存");
      }
      return true;
    } catch (e) {
      console.error("写作工具箱：章纲保存失败", e);
      new Notice("写作工具箱：章纲保存失败");
      this.setState("保存失败");
      return false;
    }
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

  private setState(text: string): void {
    const el = this.stateEl;
    if (!el) return;
    el.setText(text);
    el.toggleClass("is-dirty", text === "未保存");
    el.toggleClass("is-empty", text === "未填写");
  }

  private refreshStats(): void {
    const el = this.statsEl;
    const ta = this.textarea;
    if (!el || !ta) return;
    const points = countPoints(ta.value);
    if (points === 0) {
      el.setText("还没有要点");
      return;
    }
    el.setText(`${points} 条要点 · ${countChars(ta.value)} 字`);
  }

  /** 键入相关反馈：字数统计 + 保存状态。 */
  private onChange(): void {
    this.refreshStats();
    this.setState(
      this.textarea && this.textarea.value !== this.persistedText
        ? "未保存"
        : "已保存"
    );
    this.scheduleAutoSave();
  }

  private refreshNav(): void {
    const idx = this.chapters.findIndex((c) => c.path === this.file.path);
    if (this.posEl) {
      this.posEl.setText(
        idx >= 0 && this.chapters.length > 1
          ? `${idx + 1}/${this.chapters.length}`
          : ""
      );
    }
    this.prevBtn?.toggleClass("is-disabled", idx <= 0);
    this.nextBtn?.toggleClass(
      "is-disabled",
      idx < 0 || idx >= this.chapters.length - 1
    );
  }

  private async switchBy(delta: number): Promise<void> {
    const idx = this.chapters.findIndex((c) => c.path === this.file.path);
    const next = idx >= 0 ? this.chapters[idx + delta] : undefined;
    if (!next) return;
    const saved = await this.saveIfDirty();
    if (!saved || this.closed) return;
    await this.renderFile(next, true);
  }

  private async renderFile(file: TFile, focus: boolean): Promise<void> {
    const seq = ++this.renderSeq;
    const saved = await this.saveIfDirty();
    if (!saved || this.closed || seq !== this.renderSeq) return;
    this.file = file;
    const value = await this.readOutline(file);
    if (value === null || this.closed || seq !== this.renderSeq) return;

    this.contentEl.empty();
    const head = this.contentEl.createDiv({ cls: "wt-outline-modal-head" });
    this.prevBtn = iconButton(head, "wt-chevron-left", "上一章（⌘/Ctrl+↑）", () =>
      void this.switchBy(-1)
    );
    head.createSpan({
      cls: "wt-outline-modal-name",
      text: file.basename,
      attr: { title: file.path },
    });
    this.posEl = head.createSpan({ cls: "wt-outline-modal-pos" });
    head.createDiv({ cls: "wt-outline-modal-spacer" });
    head.createSpan({
      cls: "wt-outline-modal-hint",
      text: "⌘/Ctrl + ↵ 保存并关闭",
    });
    this.nextBtn = iconButton(head, "wt-chevron-right", "下一章（⌘/Ctrl+↓）", () =>
      void this.switchBy(1)
    );

    const ta = this.contentEl.createEl("textarea", { cls: "wt-outline-textarea" });
    ta.value = value;
    ta.spellcheck = false;
    ta.placeholder = "写下这一章的剧情要点，每行一条…";
    this.textarea = ta;
    this.persistedText = value;

    const foot = this.contentEl.createDiv({ cls: "wt-outline-foot" });
    this.statsEl = foot.createSpan({ cls: "wt-outline-stats" });
    this.stateEl = foot.createSpan({ cls: "wt-outline-state" });

    ta.addEventListener("input", () => this.onChange());
    attachOutlineEditing(ta, () => this.onChange());
    ta.addEventListener("blur", () => {
      this.flushAutoSave();
      void this.saveIfDirty();
    });
    ta.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        this.flushAutoSave();
        void this.saveIfDirty().then((ok) => {
          if (ok) this.close();
        });
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        this.flushAutoSave();
        void this.switchBy(e.key === "ArrowUp" ? -1 : 1);
      }
    });

    this.refreshStats();
    this.setState(value.trim() ? "已保存" : "未填写");
    this.refreshNav();

    if (focus) {
      window.setTimeout(() => {
        if (this.closed || this.textarea !== ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, 0);
    }
  }
}
