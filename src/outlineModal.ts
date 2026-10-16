import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import {
  attachOutlineEditing,
  countChars,
  countPoints,
  loadOutline,
  saveOutline,
} from "./outlineText";

/** 输入停顿多久后自动写盘（毫秒），与侧栏面板保持一致 */
const AUTOSAVE_DELAY = 800;

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
  private readonly onDone: (file: TFile) => void;
  private file: TFile;
  private textarea: HTMLTextAreaElement | null = null;
  private posEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private stateEl: HTMLElement | null = null;
  private prevBtn: HTMLButtonElement | null = null;
  private nextBtn: HTMLButtonElement | null = null;
  private loadedText = "";
  private autoSaveTimer = 0;

  constructor(app: App, file: TFile, chapters: TFile[], onDone: (file: TFile) => void) {
    super(app);
    this.file = file;
    this.chapters = chapters.some((c) => c.path === file.path)
      ? chapters
      : [...chapters, file];
    this.onDone = onDone;
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("wt-outline-modal");
    this.contentEl.addClass("wt-outline-modal-body");
    await this.renderFile(this.file, true);
  }

  async onClose(): Promise<void> {
    if (this.autoSaveTimer) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = 0;
    await this.saveIfDirty();
    this.onDone(this.file);
    this.contentEl.empty();
    this.textarea = null;
  }

  /** 读章纲：优先读取伴生文件，兼容旧 Frontmatter */
  private async readOutline(file: TFile): Promise<string> {
    try {
      const res = await loadOutline(this.app, file);
      return res.value;
    } catch {
      return "";
    }
  }

  private async saveIfDirty(): Promise<void> {
    const ta = this.textarea;
    if (!ta) return;
    const value = ta.value;
    if (value === this.loadedText) return;
    const file = this.file;
    this.loadedText = value; // 先标记，避免重复触发
    this.setState("保存中…");
    try {
      await saveOutline(this.app, file, value);
      if (file.path === this.file.path && this.textarea?.value === value) {
        this.setState(value.trim() ? "已保存" : "未填写");
      }
    } catch (e) {
      console.error("写作工具箱：章纲保存失败", e);
      new Notice("写作工具箱：章纲保存失败");
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
      this.textarea && this.textarea.value !== this.loadedText ? "未保存" : "已保存"
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
    await this.renderFile(next, true);
  }

  private async renderFile(file: TFile, focus: boolean): Promise<void> {
    await this.saveIfDirty();
    this.file = file;
    const value = await this.readOutline(file);

    this.contentEl.empty();
    const head = this.contentEl.createDiv({ cls: "wt-outline-modal-head" });
    this.prevBtn = iconButton(head, "chevron-left", "上一章（⌘/Ctrl+↑）", () =>
      void this.switchBy(-1)
    );
    head.createEl("span", {
      cls: "wt-outline-modal-name",
      text: file.basename,
      attr: { title: file.path },
    });
    this.posEl = head.createEl("span", { cls: "wt-outline-modal-pos" });
    head.createDiv({ cls: "wt-outline-modal-spacer" });
    head.createEl("span", {
      cls: "wt-outline-modal-hint",
      text: "⌘/Ctrl + ↵ 保存并关闭",
    });
    this.nextBtn = iconButton(head, "chevron-right", "下一章（⌘/Ctrl+↓）", () =>
      void this.switchBy(1)
    );

    const ta = this.contentEl.createEl("textarea", { cls: "wt-outline-textarea" });
    ta.value = value;
    ta.spellcheck = false;
    ta.placeholder = "写下这一章的剧情要点，每行一条…";
    this.textarea = ta;
    this.loadedText = value;

    const foot = this.contentEl.createDiv({ cls: "wt-outline-foot" });
    this.statsEl = foot.createEl("span", { cls: "wt-outline-stats" });
    this.stateEl = foot.createEl("span", { cls: "wt-outline-state" });

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
        void this.saveIfDirty().then(() => this.close());
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
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, 0);
    }
  }
}
