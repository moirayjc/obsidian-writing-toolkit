import { TFile, type TAbstractFile } from "obsidian";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import {
  DraftSnapshotManager,
  type SnapshotOperations,
} from "../snapshot";

const SNAPSHOT_TICK_INTERVAL_MS = 30_000;

export interface SnapshotModuleOptions {
  /** 侧栏聚焦时 app.workspace.getActiveFile() 可能为空，这里读主入口的最近文档。 */
  getActiveFilePath(): string | null;
  getActiveText(): string | null;
}

type SnapshotManagerFactory = (
  context: FeatureContext,
  options: SnapshotModuleOptions,
  onSaved: () => void
) => SnapshotManagerRuntime;

interface SnapshotManagerRuntime extends SnapshotOperations {
  onEditorChange(file: TFile, text: string): void;
  onFileSwitch(): void;
  onRename(file: TAbstractFile, oldPath: string): void;
  tick(): void;
  unload(): void;
}

export interface SnapshotModule extends FeatureModule {
  /**
   * 侧栏快照面板和差异恢复只依赖实际使用到的能力，不拥有自动保存心跳。
   */
  readonly operations: SnapshotOperations;
  /** 其他快照功能模块订阅保存、切换等变化；不暴露管理器生命周期。 */
  subscribe(listener: () => void): () => void;
}

function createDefaultManager(
  context: FeatureContext,
  options: SnapshotModuleOptions,
  onSaved: () => void
): DraftSnapshotManager {
  return new DraftSnapshotManager(
    context.app.vault,
    context.services.wordcount,
    () => context.services.settings.get(),
    options.getActiveFilePath,
    options.getActiveText,
    onSaved
  );
}

/**
 * 草稿快照的核心生命周期。
 *
 * 本阶段只接管管理器的创建、自动保存心跳、文件事件和卸载清理；快照侧栏
 * 与差异恢复仍通过兼容端口使用同一个管理器，避免一次迁移吞掉整个快照系统。
 */
export function createSnapshotModule(
  options: SnapshotModuleOptions,
  managerFactory: SnapshotManagerFactory = createDefaultManager
): SnapshotModule {
  let active = false;
  let manager: SnapshotManagerRuntime | null = null;
  let operations: SnapshotOperations | null = null;
  const listeners = new Set<() => void>();

  function activeManager(): SnapshotManagerRuntime {
    if (!active || !manager) {
      throw new Error("快照模块尚未激活");
    }
    return manager;
  }

  function notifyChanged(): void {
    if (!active) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[Writing Toolkit:snapshots.core] 快照变化监听器失败", error);
      }
    }
  }

  return {
    id: "snapshots.core",
    activate(context) {
      active = true;
      manager = managerFactory(context, options, () => {
        notifyChanged();
      });
      operations = {
        saveSnapshotNow: (showNotice) =>
          activeManager().saveSnapshotNow(showNotice),
        openSnapshotFolder: () => activeManager().openSnapshotFolder(),
        listSnapshots: (sourcePath, mode) =>
          activeManager().listSnapshots(sourcePath, mode),
        readSnapshot: (snapshotPath) =>
          activeManager().readSnapshot(snapshotPath),
        copySnapshot: (snapshotPath) =>
          activeManager().copySnapshot(snapshotPath),
        snapshotFileSilently: (sourcePath, text) =>
          activeManager().snapshotFileSilently(sourcePath, text),
      };

      context.effects.add(() => {
        if (!active) return;
        active = false;
        const current = manager;
        manager = null;
        operations = null;
        listeners.clear();
        current?.unload();
      });

      context.events.onWorkspace("editor-change", (editor) => {
        if (!active || !manager) return;
        const path = context.services.editor.getFilePathForEditor(editor);
        if (!path) return;
        const file = context.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
          return;
        }
        manager.onEditorChange(file, editor.getValue());
      });

      context.events.onWorkspace("active-leaf-change", () => {
        if (!active || !manager) return;
        manager.onFileSwitch();
        notifyChanged();
      });

      context.events.onVault("rename", (file, oldPath) => {
        if (!active || !manager) return;
        manager.onRename(file, oldPath);
      });

      context.events.setInterval(() => {
        if (active) manager?.tick();
      }, SNAPSHOT_TICK_INTERVAL_MS);
    },
    get operations() {
      if (!operations) {
        throw new Error("快照模块尚未激活");
      }
      return operations;
    },
    subscribe(listener) {
      if (!active) {
        throw new Error("快照模块尚未激活");
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
