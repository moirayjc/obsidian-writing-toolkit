import type { App, ViewCreator, WorkspaceLeaf } from "obsidian";

export type ViewLocation = "left" | "right" | "tab";
export type DrawerSide = "left" | "right";

/**
 * A feature-owned panel mounted into a stable UI shell slot.
 *
 * The shell owns where the panel lives, while the registering feature owns
 * the panel implementation and all of its business state.
 */
export interface UiPanelHandle {
  refresh(): void;
  updateLive?(text?: string | null): void;
  destroy(): void;
}

export type UiPanelFactory = (container: HTMLElement) => UiPanelHandle;

export type UiPanelGroup = Required<UiPanelHandle>;

export interface UiRegistrationAdapter {
  registerView(type: string, viewCreator: ViewCreator): void;
}

/**
 * Host-managed adapter for view registration and workspace leaves.
 *
 * Feature modules provide their own view classes, while this service owns the
 * repeated Obsidian mechanics: finding leaves, opening drawers, revealing
 * collapsed sidebars and opening the plugin's settings tab.
 */
export interface UiService {
  registerView(type: string, viewCreator: ViewCreator): void;
  registerPanel(slot: string, factory: UiPanelFactory): () => void;
  mountPanels(slot: string, container: HTMLElement): UiPanelGroup;
  leaves(type: string): WorkspaceLeaf[];
  firstLeaf(type: string): WorkspaceLeaf | null;
  getLeaf(location: ViewLocation, fallback?: DrawerSide): WorkspaceLeaf | null;
  showView(
    leaf: WorkspaceLeaf,
    type: string,
    active?: boolean
  ): Promise<void>;
  reveal(leaf: WorkspaceLeaf): void;
  openInDrawer(type: string, side: DrawerSide): Promise<WorkspaceLeaf | null>;
  moveToDrawer(
    type: string,
    side: DrawerSide,
    active?: boolean
  ): Promise<boolean>;
  openPluginSettings(pluginId: string): boolean;
}

interface PanelRegistration {
  readonly factory: UiPanelFactory;
  readonly mounted: Set<UiPanelHandle>;
}

interface PluginSettingsApi {
  open(): void;
  openTabById(id: string): void;
}

export class DefaultUiService implements UiService {
  private readonly panelSlots = new Map<string, Set<PanelRegistration>>();

  constructor(
    private readonly app: App,
    private readonly registration: UiRegistrationAdapter
  ) {}

  registerView(type: string, viewCreator: ViewCreator): void {
    this.registration.registerView(type, viewCreator);
  }

  registerPanel(slot: string, factory: UiPanelFactory): () => void {
    const registration: PanelRegistration = {
      factory,
      mounted: new Set(),
    };
    let registrations = this.panelSlots.get(slot);
    if (!registrations) {
      registrations = new Set();
      this.panelSlots.set(slot, registrations);
    }
    registrations.add(registration);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      registrations?.delete(registration);
      if (registrations?.size === 0) this.panelSlots.delete(slot);
      for (const panel of [...registration.mounted]) {
        try {
          panel.destroy();
        } catch (error) {
          console.error(
            `[Writing Toolkit] UI 插槽 ${slot} 面板销毁失败`,
            error
          );
        }
      }
      registration.mounted.clear();
    };
  }

  mountPanels(slot: string, container: HTMLElement): UiPanelGroup {
    const mounted: UiPanelHandle[] = [];
    const registrations = [...(this.panelSlots.get(slot) ?? [])];
    for (const registration of registrations) {
      try {
        const panel = registration.factory(container);
        let destroyed = false;
        const managed: UiPanelHandle = {
          refresh: () => {
            if (!destroyed) panel.refresh();
          },
          updateLive: (text?: string | null) => {
            if (!destroyed) panel.updateLive?.(text);
          },
          destroy: () => {
            if (destroyed) return;
            destroyed = true;
            panel.destroy();
          },
        };
        mounted.push(managed);
        registration.mounted.add(managed);
      } catch (error) {
        console.error(
          `[Writing Toolkit] UI 插槽 ${slot} 面板挂载失败`,
          error
        );
      }
    }

    let destroyed = false;
    return {
      refresh: () => {
        if (destroyed) return;
        for (const panel of mounted) panel.refresh();
      },
      updateLive: (text?: string | null) => {
        if (destroyed) return;
        for (const panel of mounted) panel.updateLive?.(text);
      },
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        for (const panel of mounted) {
          try {
            panel.destroy();
          } catch (error) {
            console.error(
              `[Writing Toolkit] UI 插槽 ${slot} 面板销毁失败`,
              error
            );
          }
          for (const registration of registrations) {
            registration.mounted.delete(panel);
          }
        }
        mounted.length = 0;
      },
    };
  }

  leaves(type: string): WorkspaceLeaf[] {
    return [...this.app.workspace.getLeavesOfType(type)];
  }

  firstLeaf(type: string): WorkspaceLeaf | null {
    return this.app.workspace.getLeavesOfType(type)[0] ?? null;
  }

  getLeaf(
    location: ViewLocation,
    fallback?: DrawerSide
  ): WorkspaceLeaf | null {
    if (location === "tab") return this.app.workspace.getLeaf("tab");
    const leaf =
      location === "left"
        ? this.app.workspace.getLeftLeaf(false)
        : this.app.workspace.getRightLeaf(false);
    if (leaf || !fallback || fallback === location) return leaf;
    return fallback === "left"
      ? this.app.workspace.getLeftLeaf(false)
      : this.app.workspace.getRightLeaf(false);
  }

  async showView(
    leaf: WorkspaceLeaf,
    type: string,
    active = true
  ): Promise<void> {
    await leaf.setViewState({ type, active });
    this.reveal(leaf);
  }

  reveal(leaf: WorkspaceLeaf): void {
    const workspace = this.app.workspace;
    const root = leaf.getRoot();
    if (root === workspace.leftSplit && workspace.leftSplit.collapsed) {
      workspace.leftSplit.expand();
    } else if (root === workspace.rightSplit && workspace.rightSplit.collapsed) {
      workspace.rightSplit.expand();
    }
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  async openInDrawer(
    type: string,
    side: DrawerSide
  ): Promise<WorkspaceLeaf | null> {
    const target = this.getLeaf(side);
    if (!target) return null;
    const workspace = this.app.workspace;
    for (const leaf of this.leaves(type)) {
      if (leaf !== target && leaf.getRoot() === workspace.rootSplit) {
        leaf.detach();
      }
    }
    await this.showView(target, type);
    return target;
  }

  async moveToDrawer(
    type: string,
    side: DrawerSide,
    active = false
  ): Promise<boolean> {
    const workspace = this.app.workspace;
    const strays = this.leaves(type).filter(
      (leaf) => leaf.getRoot() === workspace.rootSplit
    );
    if (strays.length === 0) return false;

    const target = this.getLeaf(side);
    if (!target) return false;
    try {
      await target.setViewState({ type, active });
      for (const leaf of strays) {
        if (leaf !== target) leaf.detach();
      }
      return true;
    } catch {
      // Keep mobile views where they are if the workspace rejects the move.
      return false;
    }
  }

  openPluginSettings(pluginId: string): boolean {
    const setting = (
      this.app as unknown as { setting?: PluginSettingsApi }
    ).setting;
    if (!setting) return false;
    setting.open();
    setting.openTabById(pluginId);
    return true;
  }
}
