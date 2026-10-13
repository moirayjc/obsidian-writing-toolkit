import { App, Modal, Setting } from "obsidian";

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
