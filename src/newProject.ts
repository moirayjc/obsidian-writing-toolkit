import { App, Modal, Notice, Setting, TFolder } from "obsidian";

/**
 * 「新建作品」：在统一位置建一本新书。
 *
 * 规则（与书库/目录约定保持一致）：
 * - 位置固定，默认 `写作/新作品`（可在设置里改）；
 * - 代号自动接续现有最大编号（如 001/002/003 → 004），可手动修改；
 * - 名称可选：填了文件夹叫 `004-示例`，留空就叫 `004`；
 * - 自动建三个子目录：`前期准备`、`人物档案`、`正文草稿`；
 * - 不生成模板文件、不写任何元信息。
 */

const SUBFOLDER_NAMES = ["前期准备", "人物档案", "正文草稿"];

export interface NewProjectModalOptions {
  app: App;
  /** 统一创建位置（仓库相对路径），显示与创建都用它 */
  parent: string;
  /** 创建成功后：由调用方负责切换工作台并刷新 */
  onCreated: (rootPath: string) => void;
}

/** 打开「新建作品」对话框。 */
export function showNewProjectModal(options: NewProjectModalOptions): void {
  new NewProjectModal(options).open();
}

function normalizePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").trim();
}

function sanitizeName(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, "");
}

/** 扫描目录里的作品文件夹，返回下一个建议代号（如 004）。 */
export function suggestProjectCode(app: App, parent: string): string {
  const folder = app.vault.getAbstractFileByPath(normalizePath(parent));
  let max = 0;
  if (folder instanceof TFolder) {
    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;
      const m = /^(\d+)/.exec(child.name.trim());
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return String(max + 1).padStart(3, "0");
}

/** 代号是否已被现有目录占用（004 / 004-名称 / 004 名称 都算占用）。 */
export function isProjectCodeTaken(
  app: App,
  parent: string,
  code: string
): boolean {
  const folder = app.vault.getAbstractFileByPath(normalizePath(parent));
  if (!(folder instanceof TFolder)) return false;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}(?:$|[-·\\s])`, "i");
  return folder.children.some(
    (child) => child instanceof TFolder && re.test(child.name.trim())
  );
}

/** 依次补齐每一级目录（vault.createFolder 只建一层）。 */
async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
      await app.vault.createFolder(current);
    }
  }
}

/** 建作品目录 + 三个子目录；返回作品根目录路径。 */
export async function createNovelProject(
  app: App,
  parent: string,
  code: string,
  name: string
): Promise<string> {
  const base = normalizePath(parent);
  await ensureFolder(app, base);
  const folderName = name ? `${code}-${name}` : code;
  const root = `${base}/${folderName}`;
  await app.vault.createFolder(root);
  const digits = code.match(/\d+/)?.[0] ?? "";
  const prefix = digits ? `1-1-${digits}-` : "";
  for (let i = 0; i < SUBFOLDER_NAMES.length; i++) {
    await app.vault.createFolder(
      `${root}/${prefix}${i + 1} ${SUBFOLDER_NAMES[i]}`
    );
  }
  return root;
}

class NewProjectModal extends Modal {
  private readonly options: NewProjectModalOptions;
  private code = "";
  private name = "";
  private previewEl: HTMLElement | null = null;
  private busy = false;

  constructor(options: NewProjectModalOptions) {
    super(options.app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wt-np");
    this.titleEl.setText("新建作品");
    contentEl.createDiv({
      cls: "wt-np-sub",
      text: "代号和目录都会自动接上现有的编号规律，建完直接打开开写。",
    });

    this.code = suggestProjectCode(this.app, this.options.parent);

    new Setting(contentEl)
      .setName("代号")
      .setDesc("自动接续现有编号，可修改")
      .addText((text) => {
        text.setValue(this.code).onChange((value) => {
          this.code = value;
          this.updatePreview();
        });
        text.inputEl.addEventListener("focus", () => text.inputEl.select());
        window.setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        }, 0);
      });

    new Setting(contentEl)
      .setName("名称（可选）")
      .setDesc("留空就用代号；填了就拼成「004-名称」这样的格式")
      .addText((text) => {
        text.setPlaceholder("留空也行").onChange((value) => {
          this.name = value;
          this.updatePreview();
        });
      });

    new Setting(contentEl)
      .setName("位置")
      .setDesc("新作品统一建在这里，不用选")
      .addText((text) => text.setValue(this.options.parent).setDisabled(true));

    this.previewEl = contentEl.createDiv({ cls: "wt-np-preview" });
    this.updatePreview();

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()))
      .addButton((btn) =>
        btn
          .setButtonText("创建并打开")
          .setCta()
          .onClick(() => void this.submit())
      );

    contentEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (!(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      void this.submit();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updatePreview(): void {
    if (!this.previewEl) return;
    const code = sanitizeName(this.code) || "…";
    const name = sanitizeName(this.name);
    const folder = name ? `${code}-${name}` : code;
    const digits = code.match(/\d+/)?.[0] ?? "";
    const prefix = digits ? `1-1-${digits}-` : "";
    this.previewEl.empty();
    this.previewEl.createDiv({
      cls: "wt-np-preview-title",
      text: "点击创建后，自动做好这些：",
    });
    const book = this.previewEl.createDiv({ cls: "wt-np-preview-row" });
    book.createSpan({ cls: "wt-np-preview-name", text: folder });
    book.createSpan({ cls: "wt-np-preview-dim", text: "（作品文件夹）" });
    const subs = this.previewEl.createDiv({
      cls: "wt-np-preview-row wt-np-preview-dim",
    });
    subs.setText(
      SUBFOLDER_NAMES.map((label, i) => `${prefix}${i + 1} ${label}`).join("　")
    );
    this.previewEl.createDiv({
      cls: "wt-np-preview-note",
      text: "不塞模板；目录里先保持空白。",
    });
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const code = sanitizeName(this.code);
    const name = sanitizeName(this.name);
    if (!code) {
      new Notice("先填一个代号吧");
      return;
    }
    if (isProjectCodeTaken(this.app, this.options.parent, code)) {
      new Notice(`代号「${code}」已经被用了，换一个吧`);
      return;
    }
    const folderName = name ? `${code}-${name}` : code;
    const root = `${normalizePath(this.options.parent)}/${folderName}`;
    if (this.app.vault.getAbstractFileByPath(root)) {
      new Notice(`「${folderName}」已经存在了`);
      return;
    }
    this.busy = true;
    try {
      await createNovelProject(this.app, this.options.parent, code, name);
      this.close();
      new Notice(`已创建《${folderName}》`);
      this.options.onCreated(root);
    } catch (error) {
      console.error("写作工具箱：新建作品失败", error);
      new Notice("新建作品失败，请重试");
      this.busy = false;
    }
  }
}
