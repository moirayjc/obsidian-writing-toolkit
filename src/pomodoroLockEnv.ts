import { App, MarkdownView, Modal, Setting, TFile, type WorkspaceLeaf } from "obsidian";
import type { PomodoroLockMode } from "./pomodoro";
import type { FocusModes, PomodoroLockEnv } from "./features/pomodoroModule";

/** 插件提供的开关与章纲能力；Workspace / Modal 细节留在本文件。 */
export interface PomodoroLockEnvDeps {
  recentMarkdownPath(): string | null;
  getModes(): FocusModes;
  applyModes(modes: FocusModes): void;
  openOutline(file: TFile): void;
}

const START_CHOICES: { mode: PomodoroLockMode; name: string; desc: string }[] = [
  { mode: "none", name: "不锁定", desc: "普通番茄，可以暂停、结束、切换文档" },
  { mode: "immersive", name: "锁定沉浸", desc: "专注结束前停在沉浸模式和当前章节" },
  { mode: "hemingway", name: "锁定海明威", desc: "同上，并且只能往下写、不能删字" },
];

class PomodoroStartModal extends Modal {
  constructor(app: App, private readonly onPick: (mode: PomodoroLockMode) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("开始番茄钟");
    for (const choice of START_CHOICES) {
      new Setting(contentEl)
        .setName(choice.name)
        .setDesc(choice.desc)
        .addButton((btn) => {
          btn.setButtonText("开始").onClick(() => {
            this.close();
            this.onPick(choice.mode);
          });
          if (choice.mode === "none") btn.setCta();
        });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class EmergencyExitModal extends Modal {
  constructor(app: App, private readonly onConfirm: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("紧急退出锁定？");
    contentEl.createEl("p", {
      text: "退出后本番茄作废，不计入今日番茄数；已写的字数照常统计。",
    });
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("退出锁定")
          .setDestructive()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      )
      .addButton((btn) => btn.setButtonText("继续写").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 主编辑区里正在显示 path 的叶子。 */
function findRootLeaf(app: App, path: string): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateRootLeaves((leaf) => {
    if (found) return;
    if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) found = leaf;
  });
  return found;
}

export function createPomodoroLockEnv(app: App, deps: PomodoroLockEnvDeps): PomodoroLockEnv {
  return {
    recentMarkdownPath: () => deps.recentMarkdownPath(),
    getModes: () => deps.getModes(),
    applyModes: (modes) => deps.applyModes(modes),
    chooseStart(onPick) {
      new PomodoroStartModal(app, onPick).open();
    },
    confirmEmergencyExit(onConfirm) {
      new EmergencyExitModal(app, onConfirm).open();
    },
    enforceFile(path) {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return false;
      // 只看主编辑区最近的叶子：焦点落在侧栏（沉浸时本就隐藏）不算切文档。
      const activeView = app.workspace.getMostRecentLeaf()?.view;
      if (activeView instanceof MarkdownView && activeView.file?.path === path) return false;
      const target = findRootLeaf(app, path);
      if (target) {
        app.workspace.setActiveLeaf(target, { focus: true });
      } else {
        // 在主编辑区原地打开：点链接、打开主页 / 编辑台都会被换回锁定的章节。
        const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf(true);
        void leaf.openFile(file);
      }
      return true;
    },
    openOutline(path) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) deps.openOutline(file);
    },
  };
}
