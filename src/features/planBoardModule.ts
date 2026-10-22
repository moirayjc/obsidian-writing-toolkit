import { normalizePath, TFile, TFolder } from "obsidian";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import {
  addPlanItem,
  editPlanItem,
  movePlanItem,
  parsePlanBoard,
  planDayKey,
  PLAN_BOARD_TEMPLATE,
  removePlanItem,
  resolvePlanBoardPath,
  restorePlanItem,
  type PlanColumn,
  type PlanItem,
  type PlanItemPatch,
  type PlanPlacement,
  type RemovedPlanItem,
} from "../planBoard";

/**
 * 写作计划看板：「待写 / 在写 / 完成」三列，全局一份。
 *
 * - 数据就是库里的一份 Markdown（默认「写作」文件夹根目录的 `写作看板.md`），
 *   随网盘同步跨设备；不写 data.json（data.json 只在启动时读、整份覆盖写，两端会互相盖掉）。
 * - 每次修改都走 `vault.process`：现读文件 → 按条目原文定位 → 改 → 写回，
 *   页面上的旧数据不会盖掉别处的手改或同步。
 * - 文件被改（本机、手改、同步）、改名、删除，或设置里的路径变了，都通知订阅者重画。
 * - 文件不存在时只读为空，第一次添加条目才创建。
 */
export interface PlanBoardOperations {
  /** 看板文件路径（仓库相对） */
  path(): string;
  load(): Promise<PlanItem[]>;
  add(column: PlanColumn, text: string, extra?: { due?: string | null; book?: string | null }): Promise<void>;
  move(key: string, column: PlanColumn, place?: PlanPlacement): Promise<void>;
  edit(key: string, patch: PlanItemPatch): Promise<void>;
  remove(key: string): Promise<RemovedPlanItem | null>;
  restore(removed: RemovedPlanItem): Promise<void>;
  /** 在 Obsidian 里打开看板文件（手改用） */
  openFile(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface PlanBoardModule extends FeatureModule {
  readonly operations: PlanBoardOperations;
}

export function createPlanBoardModule(): PlanBoardModule {
  let context: FeatureContext | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[Writing Toolkit:plan-board] 订阅回调失败", error);
      }
    }
  }

  function boardPath(): string {
    const settings = context?.services.settings.get();
    return normalizePath(
      resolvePlanBoardPath(settings?.planBoardFile ?? "", settings?.sharedLibraryFolder ?? "")
    );
  }

  function boardFile(): TFile | null {
    const file = context?.app.vault.getAbstractFileByPath(boardPath());
    return file instanceof TFile ? file : null;
  }

  async function ensureFile(): Promise<TFile> {
    if (!context) throw new Error("看板模块未启动");
    const existing = boardFile();
    if (existing) return existing;
    const path = boardPath();
    const vault = context.app.vault;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir && !(vault.getAbstractFileByPath(dir) instanceof TFolder)) {
      await vault.createFolder(dir);
    }
    return vault.create(path, PLAN_BOARD_TEMPLATE);
  }

  /** 现读 → 改 → 写回；文件不在且不允许创建时什么都不做。 */
  async function mutate(
    change: (content: string, today: string) => string,
    create = false
  ): Promise<void> {
    if (!context) return;
    const file = create ? await ensureFile() : boardFile();
    if (!file) return;
    await context.app.vault.process(file, (content) =>
      change(content, planDayKey(new Date()))
    );
  }

  const operations: PlanBoardOperations = {
    path: boardPath,
    async load() {
      const file = boardFile();
      if (!file || !context) return [];
      return parsePlanBoard(await context.app.vault.cachedRead(file));
    },
    add: (column, text, extra = {}) =>
      mutate(
        (content, today) =>
          addPlanItem(content, column, text, extra.due ?? null, today, extra.book ?? null),
        true
      ),
    move: (key, column, place) =>
      mutate((content, today) => movePlanItem(content, key, column, today, place)),
    edit: (key, patch) => mutate((content) => editPlanItem(content, key, patch)),
    async remove(key) {
      let removed: RemovedPlanItem | null = null;
      await mutate((content) => {
        const result = removePlanItem(content, key);
        removed = result.removed;
        return result.content;
      });
      return removed;
    },
    restore: (removed) => mutate((content) => restorePlanItem(content, removed), true),
    async openFile() {
      if (!context) return;
      const file = await ensureFile();
      await context.app.workspace.getLeaf("tab").openFile(file);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    id: "plan-board",
    activate(ctx) {
      context = ctx;
      ctx.effects.add(() => {
        context = null;
        listeners.clear();
      });

      const touches = (path: string): boolean => path === boardPath();
      ctx.events.onVault("modify", (file) => {
        if (touches(file.path)) notify();
      });
      ctx.events.onVault("create", (file) => {
        if (touches(file.path)) notify();
      });
      ctx.events.onVault("delete", (file) => {
        if (touches(file.path)) notify();
      });
      ctx.events.onVault("rename", (file, oldPath) => {
        if (touches(file.path) || touches(oldPath)) notify();
      });
      ctx.effects.add(
        ctx.services.settings.subscribe((change) => {
          if (
            change.keys.includes("planBoardFile") ||
            change.keys.includes("sharedLibraryFolder")
          ) {
            notify();
          }
        })
      );
    },
    operations,
  };
}
