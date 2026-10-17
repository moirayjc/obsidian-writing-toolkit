import {
  Notice,
  TFile,
  TFolder,
  type App,
  type TAbstractFile,
} from "obsidian";
import {
  ChapterOutlinePanel,
  type ChapterOutlinePanelHandle,
  type OutlinePanelEditorHandle,
  type OutlinePanelRuntime,
} from "../chapterOutline";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import {
  OutlineEditorModal,
  type OutlineEditorStorage,
} from "../outlineModal";
import {
  getOutlinePath,
  hasOutline as hasOutlineContent,
  loadOutline,
  migrateOutlineSidecar,
  OUTLINES_FOLDER,
  saveOutline,
} from "../outlineText";
import { isInternalPath } from "../project";
import type {
  SettingsKey,
  SettingsService,
} from "../services/settingsService";
import type { ProjectService } from "../services/projectIndexService";
import { UI_SLOT_SIDEBAR_OUTLINE } from "../uiSlots";

const REFRESH_KEYS = [
  "draftKeywords",
  "chapterExcludeNames",
  "snapshotFolder",
  "outlineStorageMode",
] as const satisfies readonly SettingsKey[];

const REFRESH_KEY_SET = new Set<SettingsKey>(REFRESH_KEYS);

export interface OutlineLoadResult {
  value: string;
  hasKey: boolean;
  isLegacyFm: boolean;
}

export interface OutlineOperations {
  load(file: TFile): Promise<OutlineLoadResult>;
  save(file: TFile, value: string): Promise<void>;
  has(file: TFile): Promise<boolean>;
  flush(): Promise<void>;
  subscribe(listener: (change: OutlineChange) => void): () => void;
  migrateSidecar(oldPath: string, newPath: string): Promise<void>;
  removeSidecar(sourcePath: string): Promise<void>;
}

export interface OutlineChange {
  kind: "save" | "rename" | "delete" | "external";
  paths: readonly string[];
  cause: "panel" | "editor" | "workbench" | "vault" | "module" | "external";
  hasContent?: boolean;
}

export interface OutlineModule extends FeatureModule {
  readonly operations: OutlineOperations;
}

type OutlinePanelFactory = (
  container: HTMLElement,
  runtime: OutlinePanelRuntime
) => ChapterOutlinePanelHandle;

type OutlineEditorFactory = (
  app: App,
  file: TFile,
  chapters: TFile[],
  storage: OutlineEditorStorage,
  onDone: (file: TFile) => void
) => OutlinePanelEditorHandle & { open(): void };

type OutlineMigration = (
  app: App,
  oldPath: string,
  newPath: string
) => Promise<void>;

type OutlineSidecarRemover = (
  app: App,
  sourcePath: string
) => Promise<void>;

export interface OutlineModuleFactories {
  readonly createPanel?: OutlinePanelFactory;
  readonly createEditor?: OutlineEditorFactory;
  readonly migrateSidecar?: OutlineMigration;
  readonly removeSidecar?: OutlineSidecarRemover;
}

export interface OutlineModuleOptions {
  readonly getRecentMarkdownPath?: () => string | null;
}

function createDefaultPanel(
  container: HTMLElement,
  runtime: OutlinePanelRuntime
): ChapterOutlinePanelHandle {
  return new ChapterOutlinePanel(container, runtime);
}

function createDefaultEditor(
  app: App,
  file: TFile,
  chapters: TFile[],
  storage: OutlineEditorStorage,
  onDone: (file: TFile) => void
): OutlinePanelEditorHandle & { open(): void } {
  return new OutlineEditorModal(app, file, chapters, storage, onDone);
}

async function removeOutlineSidecar(
  app: App,
  sourcePath: string
): Promise<void> {
  const outlinePath = getOutlinePath(sourcePath);
  const stat = await app.vault.adapter.stat(outlinePath);
  if (!stat) return;
  try {
    await app.vault.adapter.trashLocal(outlinePath);
  } catch {
    if (stat.type === "folder") {
      await app.vault.adapter.rmdir(outlinePath, true);
    } else {
      await app.vault.adapter.remove(outlinePath);
    }
  }
}

/**
 * 章纲完整功能模块。
 *
 * 存储协议、伴随文件迁移与删除、设置热更新、文件事件和侧栏面板共用同一
 * 生命周期。侧栏只认识稳定的 UI 插槽，不再 import 章纲面板或编辑弹窗。
 */
export function createOutlineModule(
  options: OutlineModuleOptions = {},
  factories: OutlineModuleFactories = {}
): OutlineModule {
  const createPanel = factories.createPanel ?? createDefaultPanel;
  const createEditor = factories.createEditor ?? createDefaultEditor;
  const migrateSidecar = factories.migrateSidecar ?? migrateOutlineSidecar;
  const removeSidecar = factories.removeSidecar ?? removeOutlineSidecar;

  let active = false;
  let acceptingCalls = false;
  let disposed = false;
  let app: App | null = null;
  let settings: SettingsService | null = null;
  let project: ProjectService | null = null;
  let services: FeatureContext["services"] | null = null;
  let operations: OutlineOperations | null = null;
  let mutationChain: Promise<void> = Promise.resolve();
  const mountedPanels = new Set<ChapterOutlinePanelHandle>();
  const openEditors = new Set<OutlinePanelEditorHandle>();
  const listeners = new Set<(change: OutlineChange) => void>();

  function requireRuntime(): {
    app: App;
    settings: SettingsService;
    project: ProjectService;
    services: FeatureContext["services"];
  } {
    if (!app || !settings || !project || !services) {
      throw new Error("章纲模块尚未激活");
    }
    return { app, settings, project, services };
  }

  function assertAcceptingCalls(): void {
    if (!acceptingCalls || disposed) {
      throw new Error("章纲模块尚未激活");
    }
  }

  /**
   * 所有写盘、迁移和删除走同一条串行队列。
   * 章纲文件很小，全局串行换来的是重命名/删除时不再出现“后发先至”的覆盖。
   */
  function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = mutationChain.then(task);
    mutationChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function flushMutations(): Promise<void> {
    await mutationChain;
  }

  function notifyChange(change: OutlineChange): void {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error("[Writing Toolkit:outlines] 章纲变化监听器失败", error);
      }
    }
  }

  async function loadInternal(file: TFile): Promise<OutlineLoadResult> {
    if (disposed) throw new Error("章纲模块已停用");
    await flushMutations();
    const runtime = requireRuntime();
    return loadOutline(
      runtime.app,
      file,
      runtime.settings.get().outlineStorageMode
    );
  }

  async function hasInternal(file: TFile): Promise<boolean> {
    if (disposed) throw new Error("章纲模块已停用");
    await flushMutations();
    const runtime = requireRuntime();
    return hasOutlineContent(
      runtime.app,
      file,
      runtime.settings.get().outlineStorageMode
    );
  }

  function fallbackFile(): TFile | null {
    const runtime = requireRuntime();
    const recentPath = options.getRecentMarkdownPath?.();
    if (recentPath) {
      const recent = runtime.app.vault.getAbstractFileByPath(recentPath);
      if (
        recent instanceof TFile &&
        runtime.project.isDailyCountFile(recent.path)
      ) {
        return recent;
      }
    }

    for (const leaf of runtime.services.ui.leaves("markdown")) {
      const file = (leaf.view as { file?: unknown }).file;
      if (
        file instanceof TFile &&
        runtime.project.isDailyCountFile(file.path)
      ) {
        return file;
      }
    }
    return null;
  }

  async function saveInternal(
    file: TFile,
    value: string,
    cause: OutlineChange["cause"] = "external"
  ): Promise<void> {
    if (disposed) throw new Error("章纲模块已停用");
    await enqueueMutation(async () => {
      const runtime = requireRuntime();
      await saveOutline(
        runtime.app,
        file,
        value,
        runtime.settings.get().outlineStorageMode
      );
    });
    notifyChange({
      kind: "save",
      paths: [file.path],
      cause,
      hasContent: value.trim().length > 0,
    });
  }

  function notifyActiveLeafChange(): void {
    if (!active) return;
    for (const panel of [...mountedPanels]) panel.onActiveLeafChange();
  }

  function notifyVaultCreate(file: TAbstractFile): void {
    if (!active) return;
    for (const panel of [...mountedPanels]) panel.onVaultCreate(file);
  }

  async function notifyVaultRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    if (!active) return;
    await Promise.allSettled(
      [...mountedPanels].map((panel) => panel.onVaultRename(file, oldPath))
    );
    await Promise.allSettled(
      [...openEditors]
        .filter(
          (editor) =>
            editor.isAffected(file.path) || editor.isAffected(oldPath)
        )
        .map((editor) => editor.onVaultRename(file, oldPath))
    );
  }

  function notifyVaultDelete(file: TAbstractFile): void {
    if (!active) return;
    for (const panel of [...mountedPanels]) panel.onVaultDelete(file);
    for (const editor of [...openEditors]) editor.onVaultDelete(file);
  }

  function refreshPanels(paths?: readonly string[]): void {
    if (!active) return;
    for (const panel of [...mountedPanels]) {
      if (paths) panel.onOutlineChanged(paths);
      else panel.refresh();
    }
  }

  function sourcePathForInternal(path: string): string | null {
    const prefix = OUTLINES_FOLDER + "/";
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
  }

  async function handleVaultRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    project?.invalidate();
    await notifyVaultRename(file, oldPath);
    if (
      oldPath &&
      oldPath !== file.path &&
      !isInternalPath(oldPath) &&
      !isInternalPath(file.path)
    ) {
      const isMarkdown =
        file instanceof TFile && file.extension.toLowerCase() === "md";
      const isFolder = file instanceof TFolder;
      if (isMarkdown || isFolder) {
        try {
          const runtime = requireRuntime();
          await enqueueMutation(() =>
            migrateSidecar(runtime.app, oldPath, file.path)
          );
        } catch (error) {
          console.error("[Writing Toolkit:outlines] 章纲迁移失败", error);
          new Notice("章纲伴生文件迁移失败，请检查系统日志");
        }
      }
    }
    refreshPanels();
    notifyChange({
      kind: "rename",
      paths: [oldPath, file.path],
      cause: "module",
    });
  }

  function handleVaultDelete(file: TAbstractFile): void {
    project?.invalidate();
    notifyVaultDelete(file);
    if (
      isInternalPath(file.path) ||
      (file instanceof TFile && file.extension.toLowerCase() !== "md")
    ) {
      return;
    }
    const path = file.path;
    void enqueueMutation(async () => {
      const runtime = requireRuntime();
      await removeSidecar(runtime.app, path);
    })
      .then(() => {
        refreshPanels();
        notifyChange({
          kind: "delete",
          paths: [path],
          cause: "module",
          hasContent: false,
        });
      })
      .catch((error) => {
        console.error("[Writing Toolkit:outlines] 章纲清理失败", error);
        new Notice("章纲伴生文件清理失败，请检查系统日志");
      });
  }

  async function handleVaultModify(file: TAbstractFile): Promise<void> {
    const sourcePath = sourcePathForInternal(file.path);
    if (!sourcePath && isInternalPath(file.path)) return;
    const path = sourcePath ?? file.path;
    if (!path.endsWith(".md")) return;
    let hasContent = false;
    try {
      const runtime = requireRuntime();
      const target = sourcePath
        ? runtime.app.vault.getAbstractFileByPath(path)
        : file;
      if (target instanceof TFile) hasContent = await hasInternal(target);
    } catch {
      /* 外部变化只负责通知，读取失败不阻断 */
    }
    notifyChange({
      kind: "external",
      paths: [path],
      cause: "vault",
      hasContent,
    });
  }

  return {
    id: "outlines",
    activate(context) {
      app = context.app;
      settings = context.services.settings;
      project = context.services.project;
      services = context.services;
      active = true;
      acceptingCalls = true;
      disposed = false;

      operations = {
        async load(file) {
          assertAcceptingCalls();
          return loadInternal(file);
        },
        async save(file, value) {
          assertAcceptingCalls();
          await saveInternal(file, value, "workbench");
        },
        async has(file) {
          assertAcceptingCalls();
          return hasInternal(file);
        },
        async flush() {
          await flushMutations();
        },
        subscribe(listener) {
          if (!active || disposed) {
            throw new Error("章纲模块尚未激活");
          }
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async migrateSidecar(oldPath, newPath) {
          assertAcceptingCalls();
          await enqueueMutation(async () => {
            const runtime = requireRuntime();
            await migrateSidecar(runtime.app, oldPath, newPath);
          });
        },
        async removeSidecar(sourcePath) {
          assertAcceptingCalls();
          await enqueueMutation(async () => {
            const runtime = requireRuntime();
            await removeSidecar(runtime.app, sourcePath);
          });
        },
      };

      context.effects.add(() => {
        active = false;
        acceptingCalls = false;
        for (const editor of [...openEditors]) editor.close();
        openEditors.clear();
        for (const panel of [...mountedPanels]) panel.destroy();
        mountedPanels.clear();
        listeners.clear();
        disposed = true;
        // destroy() 会同步把最后一次 dirty 输入送进串行写盘队列。
        // 等队列跑完再清运行时引用，避免卸载时丢最后一个字。
        void mutationChain.finally(() => {
          app = null;
          settings = null;
          project = null;
          services = null;
          operations = null;
        });
      });

      context.effects.add(
        settings.subscribe((change) => {
          if (
            active &&
            change.keys.some((key) => REFRESH_KEY_SET.has(key))
          ) {
            project?.invalidate();
            refreshPanels();
          }
        })
      );
      context.effects.add(
        operations.subscribe((change) => {
          if (change.cause === "panel") return;
          refreshPanels(change.paths);
        })
      );

      context.events.onWorkspace("active-leaf-change", () => {
        notifyActiveLeafChange();
      });
      context.events.onVault("create", (file) => {
        project?.invalidate();
        notifyVaultCreate(file);
      });
      context.events.onVault("rename", (file, oldPath) => {
        void handleVaultRename(file, oldPath);
      });
      context.events.onVault("delete", (file) => {
        handleVaultDelete(file);
      });
      context.events.onVault("modify", (file) => {
        void handleVaultModify(file);
      });

      const unregister = context.services.ui.registerPanel(
        UI_SLOT_SIDEBAR_OUTLINE,
        (container) => {
          if (!active || disposed || !app || !settings) {
            throw new Error("章纲模块已停用");
          }
          const runtimeSettings = settings;
          const runtimeApp = app;
          const runtimeProject = project;
          if (!runtimeProject) throw new Error("章纲模块已停用");
          const runtime: OutlinePanelRuntime = {
            app: runtimeApp,
            isChapter(file) {
              return runtimeProject.isDailyCountFile(file.path);
            },
            fallbackFile,
            chapterFiles(file) {
              for (const novel of runtimeProject.projects()) {
                for (const volume of novel.volumes) {
                  if (
                    volume.chapters.some(
                      (chapter) => chapter.file.path === file.path
                    )
                  ) {
                    return volume.chapters.map((chapter) => chapter.file);
                  }
                }
              }
              return [file];
            },
            async loadOutline(file) {
              return (await loadInternal(file)).value;
            },
            saveOutline(file, value) {
              return saveInternal(file, value, "panel");
            },
            openEditor(file, chapters, onDone) {
              if (disposed) return null;
              const storage: OutlineEditorStorage = {
                async load(target) {
                  return (await loadInternal(target)).value;
                },
                save(target, value) {
                  return saveInternal(target, value, "editor");
                },
              };
              const editor = createEditor(runtimeApp, file, chapters, storage, (finalFile) => {
                openEditors.delete(editor);
                onDone(finalFile);
              });
              openEditors.add(editor);
              editor.open();
              return editor;
            },
          };

          const panel = createPanel(container, runtime);
          const wrapped: ChapterOutlinePanelHandle = {
            refresh: () => panel.refresh(),
            flush: () => panel.flush(),
            destroy: () => {
              if (!mountedPanels.delete(wrapped)) return;
              panel.destroy();
            },
            onActiveLeafChange: () => panel.onActiveLeafChange(),
            onVaultCreate: (file) => panel.onVaultCreate(file),
            onVaultRename: (file, oldPath) =>
              panel.onVaultRename(file, oldPath),
            onVaultDelete: (file) => panel.onVaultDelete(file),
            onOutlineChanged: (paths) => panel.onOutlineChanged(paths),
          };
          mountedPanels.add(wrapped);
          return wrapped;
        }
      );
      context.effects.add(unregister);
    },
    deactivate() {
      acceptingCalls = false;
    },
    get operations() {
      if (!operations) throw new Error("章纲模块尚未激活");
      return operations;
    },
  };
}
