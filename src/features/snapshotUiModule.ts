import { Notice, type Editor } from "obsidian";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import type { SnapshotEntry, SnapshotOperations } from "../snapshot";
import {
  createSnapshotPanel,
  type SnapshotPanelHandle,
  type SnapshotPanelRuntime,
} from "../snapshotPanel";
import {
  showSnapshotDiff,
  type SnapshotDiffHost,
} from "../snapshotDiff";
import { UI_SLOT_SIDEBAR_SNAPSHOT } from "../uiSlots";
import type { SnapshotModule } from "./snapshotModule";
import type { WordCountMode } from "../wordcount";

export interface SnapshotUiModuleOptions {
  readonly core: SnapshotModule;
  getEditor(): Editor | null;
  getActiveFilePath(): string | null;
  getActiveText(): string | null;
  isEditorValid(editor: Editor): boolean;
  markProgrammaticEdit(editor: Editor, text: string): void;
}

type SnapshotPanelFactory = (
  container: HTMLElement,
  operations: SnapshotOperations,
  runtime: SnapshotPanelRuntime
) => SnapshotPanelHandle;

type SnapshotDiffPresenter = typeof showSnapshotDiff;

export interface SnapshotUiFactories {
  readonly createPanel?: SnapshotPanelFactory;
  readonly showDiff?: SnapshotDiffPresenter;
}

export interface SnapshotUiModule extends FeatureModule {
  listSnapshots(sourcePath: string): Promise<SnapshotEntry[]>;
  openLatestDiff(sourcePath: string): Promise<void>;
}

/**
 * Snapshot panels and diff windows.
 *
 * The core module stays responsible for persistence and automatic snapshots.
 * This module owns all snapshot-facing UI and mounts it through the stable
 * sidebar slot, so the UI shell never imports the panel implementation.
 */
export function createSnapshotUiModule(
  options: SnapshotUiModuleOptions,
  factories: SnapshotUiFactories = {}
): SnapshotUiModule {
  const createPanel = factories.createPanel ?? createSnapshotPanel;
  const showDiff = factories.showDiff ?? showSnapshotDiff;
  const mountedPanels = new Set<SnapshotPanelHandle>();
  let active = false;
  let diffHost: SnapshotDiffHost | null = null;
  let wordCountMode: (() => WordCountMode) | null = null;

  function assertActive(): void {
    if (!active || !diffHost || !wordCountMode) {
      throw new Error("快照 UI 模块尚未激活");
    }
  }

  function refreshPanels(): void {
    if (!active) return;
    for (const panel of [...mountedPanels]) {
      try {
        panel.refresh();
      } catch (error) {
        console.error("[Writing Toolkit:snapshots.ui] 快照面板刷新失败", error);
      }
    }
  }

  function activate(context: FeatureContext): void {
    const settings = context.services.settings;
    const operations = options.core.operations;

    const countWords = (text: string): number =>
      context.services.wordcount.count(text, settings.get().wordCountMode);
    const getWordCountMode = (): WordCountMode =>
      settings.get().wordCountMode;
    wordCountMode = getWordCountMode;
    diffHost = {
      app: context.app,
      getEditor: options.getEditor,
      getActiveFilePath: options.getActiveFilePath,
      isEditorValid: options.isEditorValid,
      countWords,
      markProgrammaticEdit: options.markProgrammaticEdit,
      writeBlockReason: (path) => context.services.editor.writeBlockReason(path),
    };
    const runtime: SnapshotPanelRuntime = {
      ...diffHost,
      getActiveText: options.getActiveText,
      getWordCountMode,
      getSnapshotMaxPerFile: () => settings.get().snapshotMaxPerFile,
    };

    context.effects.add(
      options.core.subscribe(() => {
        refreshPanels();
      })
    );
    context.effects.add(
      settings.subscribe((change) => {
        if (
          change.keys.includes("wordCountMode") ||
          change.keys.includes("snapshotMaxPerFile") ||
          change.keys.includes("snapshotFolder") ||
          change.keys.includes("sidecarLocation")
        ) {
          refreshPanels();
        }
      })
    );

    const unregister = context.services.ui.registerPanel(
      UI_SLOT_SIDEBAR_SNAPSHOT,
      (container) => {
        const panel = createPanel(container, operations, runtime);
        const wrapped: SnapshotPanelHandle = {
          refresh: () => panel.refresh(),
          updateLive: (text) => panel.updateLive?.(text),
          destroy: () => {
            if (!mountedPanels.delete(wrapped)) return;
            panel.destroy();
          },
        };
        mountedPanels.add(wrapped);
        return wrapped;
      }
    );
    context.effects.add(unregister);
    context.effects.add(() => {
      for (const panel of [...mountedPanels]) panel.destroy();
      mountedPanels.clear();
    });
    active = true;
  }

  return {
    id: "snapshots.ui",
    dependsOn: ["snapshots.core"],
    activate,
    deactivate() {
      active = false;
      diffHost = null;
      wordCountMode = null;
    },
    async listSnapshots(sourcePath) {
      assertActive();
      return options.core.operations.listSnapshots(
        sourcePath,
        wordCountMode!()
      );
    },
    async openLatestDiff(sourcePath) {
      assertActive();
      const entries = await options.core.operations.listSnapshots(
        sourcePath,
        wordCountMode!()
      );
      if (entries.length === 0) {
        new Notice("写作工具箱：当前章节还没有快照");
        return;
      }
      showDiff(
        diffHost!,
        options.core.operations,
        sourcePath,
        entries[0].path,
        entries[0].name,
        refreshPanels
      );
    },
  };
}
