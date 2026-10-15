import { App, Modal, Notice, Setting } from "obsidian";

/**
 * 原生文本输入弹窗：替代 window.prompt（Obsidian 的 Electron 环境不支持 prompt()）。
 * 回车确认，Esc 关闭。
 */
export class TextPromptModal extends Modal {
  private inputEl: HTMLInputElement | null = null;

  constructor(
    app: App,
    private readonly title: string,
    private readonly defaultValue: string,
    private readonly onSubmit: (value: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    new Setting(contentEl).addText((text) => {
      text.setValue(this.defaultValue);
      this.inputEl = text.inputEl;
      text.inputEl.select();
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("确定").setCta().onClick(() => this.submit())
      )
      .addButton((btn) =>
        btn.setButtonText("取消").onClick(() => this.close())
      );

    // 弹窗完全渲染后再聚焦输入框
    window.setTimeout(() => {
      this.inputEl?.focus();
    }, 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const value = this.inputEl?.value ?? "";
    this.close();
    this.onSubmit(value);
  }
}

/**
 * 原生确认弹窗：替代 window.confirm（Obsidian 的 Electron 环境不支持 confirm()）。
 * danger 为 true 时确认按钮显示为警示样式（删除等操作）。
 */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly onConfirm: () => void,
    private readonly danger = false,
    private readonly onCancel?: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { cls: "wt-confirm-message", text: this.message });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText(this.confirmText);
        if (this.danger) btn.setWarning();
        btn.onClick(() => {
          this.close();
          this.onConfirm();
        });
      })
      .addButton((btn) =>
        btn
          .setButtonText("取消")
          .onClick(() => {
            this.close();
            this.onCancel?.();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 写/改批注内容的输入弹窗。
 *
 * 编辑器里不再有跟随文字的浮层卡片（会随正文滚动"跳"），
 * 新建与编辑批注统一走这个屏幕居中的输入框：位置固定、不跟随光标。
 * ⌘/Ctrl + Enter 保存，Esc 或「取消」放弃（onCancel 用来清理没写内容的新批注）。
 */
export class CommentDraftModal extends Modal {
  private textareaEl: HTMLTextAreaElement | null = null;
  /** 是否点过「保存」；没点就关掉（Esc / 点外部 / 取消）算放弃 */
  private submitted = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly initial: string,
    private readonly onSubmit: (value: string) => void,
    private readonly onCancel?: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    this.textareaEl = contentEl.createEl("textarea", {
      cls: "wt-comment-draft-input",
      attr: {
        rows: "5",
        placeholder: "写批注，例如：这里节奏太慢，压缩成两段…",
      },
    });
    this.textareaEl.value = this.initial;
    this.textareaEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.submit();
      }
    });

    const row = contentEl.createDiv({ cls: "wt-comment-draft-buttons" });
    const saveBtn = row.createEl("button", { cls: "mod-cta", text: "保存" });
    const cancelBtn = row.createEl("button", { text: "取消" });
    saveBtn.addEventListener("click", () => this.submit());
    cancelBtn.addEventListener("click", () => this.close());

    // 弹窗完全渲染后再聚焦，光标落在已有内容末尾
    window.setTimeout(() => {
      const el = this.textareaEl;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 50);
  }

  onClose(): void {
    this.contentEl.empty();
    // 没点「保存」就关掉（Esc / 点外部 / 取消）：放弃，交给调用方收拾
    if (!this.submitted) this.onCancel?.();
  }

  private submit(): void {
    const value = this.textareaEl?.value ?? "";
    if (!value.trim()) {
      new Notice("批注内容不能为空");
      return;
    }
    this.submitted = true;
    this.close();
    this.onSubmit(value.trim());
  }
}
