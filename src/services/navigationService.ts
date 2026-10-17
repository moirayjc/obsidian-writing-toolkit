/**
 * 页面导航 Service：三个主视图的打开路径、Ribbon/命令点击后的落点与刷新扇出。
 * 手机端路由与启动自愈集中在这里，main.ts 只保留兼容包装。
 */
import { Platform } from "obsidian";
import type { App } from "obsidian";
import { showNewProjectModal } from "../newProject";
import {
  DEFAULT_SETTINGS,
  type WritingToolkitSettings,
} from "../settingsSchema";
import {
  WRITING_TOOLKIT_HOME,
  WRITING_TOOLKIT_SIDEBAR,
  WRITING_TOOLKIT_WORKBENCH,
} from "../uiSlots";
import type { UiService } from "./uiService";

/** 只依赖 view 的可选刷新方法，避免 Service 反向 import UI Shell 实现。 */
interface RefreshableView {
  refreshNow?: () => void;
  refreshLive?: () => void;
  refreshSettings?: () => void;
}

export interface NavigationServiceOptions {
  app: App;
  ui: UiService;
  getSettings(): WritingToolkitSettings;
  setWorkbenchProject(root: string): void;
}

export class NavigationService {
  constructor(private readonly options: NavigationServiceOptions) {}

  async openSidebar(): Promise<void> {
    const ui = this.options.ui;
    if (Platform.isMobile) {
      await ui.openInDrawer(WRITING_TOOLKIT_SIDEBAR, "right");
      return;
    }
    const leaf =
      ui.firstLeaf(WRITING_TOOLKIT_SIDEBAR) ?? ui.getLeaf("right");
    if (!leaf) return;
    await ui.showView(leaf, WRITING_TOOLKIT_SIDEBAR);
  }

  async openWorkbench(): Promise<void> {
    const ui = this.options.ui;
    if (Platform.isMobile) {
      await ui.openInDrawer(WRITING_TOOLKIT_WORKBENCH, "left");
      return;
    }
    const existing = ui.firstLeaf(WRITING_TOOLKIT_WORKBENCH);
    if (existing) {
      ui.reveal(existing);
      return;
    }
    const leaf = ui.getLeaf("left", "right");
    if (!leaf) return;
    await ui.showView(leaf, WRITING_TOOLKIT_WORKBENCH);
  }

  async openHome(): Promise<void> {
    const ui = this.options.ui;
    const existing = ui.firstLeaf(WRITING_TOOLKIT_HOME);
    if (existing) {
      ui.reveal(existing);
      (existing.view as RefreshableView).refreshNow?.();
      return;
    }
    const leaf = ui.getLeaf("tab");
    if (!leaf) return;
    await ui.showView(leaf, WRITING_TOOLKIT_HOME);
  }

  openSettings(pluginId: string): void {
    this.options.ui.openPluginSettings(pluginId);
  }

  /** 手机端启动时的一次自愈：把开在中间编辑区的视图挪回对应抽屉。 */
  migrateMobileViewsToDrawers(): void {
    const ui = this.options.ui;
    void ui.moveToDrawer(WRITING_TOOLKIT_WORKBENCH, "left");
    void ui.moveToDrawer(WRITING_TOOLKIT_SIDEBAR, "right");
  }

  refreshHome(): void {
    for (const leaf of this.options.ui.leaves(WRITING_TOOLKIT_HOME)) {
      (leaf.view as RefreshableView).refreshNow?.();
    }
  }

  refreshWorkbenches(): void {
    for (const leaf of this.options.ui.leaves(WRITING_TOOLKIT_WORKBENCH)) {
      (leaf.view as RefreshableView).refreshNow?.();
    }
  }

  /** 工作台轻量刷新：编辑器每次输入都会调用。 */
  refreshWorkbench(): void {
    for (const leaf of this.options.ui.leaves(WRITING_TOOLKIT_WORKBENCH)) {
      (leaf.view as RefreshableView).refreshLive?.();
    }
  }

  /** 侧栏整体重绘（统计范围下拉等依赖作品列表的部分需要跟着刷新）。 */
  refreshSidebarSettings(): void {
    for (const leaf of this.options.ui.leaves(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as RefreshableView).refreshSettings?.();
    }
    this.refreshHome();
  }

  /** 新建作品：统一位置建目录，建完把工作台切到新作品。 */
  openNewProjectDialog(): void {
    const settings = this.options.getSettings();
    const parent =
      (settings.newProjectFolder || DEFAULT_SETTINGS.newProjectFolder).trim() ||
      DEFAULT_SETTINGS.newProjectFolder;
    showNewProjectModal({
      app: this.options.app,
      parent,
      onCreated: (root) => {
        this.options.setWorkbenchProject(root);
        void this.openWorkbench().then(() => {
          this.refreshWorkbenches();
        });
        this.refreshHome();
      },
    });
  }
}
