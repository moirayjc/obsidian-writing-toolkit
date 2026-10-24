/**
 * 伴随数据存放位置（specs/sidecar-location.md，2026-10-24 修订）：启动时把旧版隐藏目录
 * 收进 `_写作工具箱/` + 「加入 Obsidian 排除列表」。
 *
 * 路径本身由 src/sidecarLocation.ts 统一换算；这里只管搬。
 * 不注册命令：排除列表的入口在设置页。
 */
import { Notice, TFile, TFolder, type App, type DataAdapter } from "obsidian";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import { VISIBLE_DATA_ROOT } from "../sidecarLocation";
import {
  planSidecarMigration,
  runSidecarMigration,
  type MigrationFs,
} from "../sidecarMigration";

export interface SidecarLocationOperations {
  /** 把 `_写作工具箱/` 加进「设置 → 文件与链接 → 排除的文件」。 */
  addToObsidianExcluded(): void;
}

export interface SidecarLocationModule extends FeatureModule {
  readonly operations: SidecarLocationOperations;
}

/** 隐藏目录（任意一段以 `.` 开头）：Obsidian 不索引，只能走 adapter。 */
function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

/**
 * 搬家用的文件接口。可见目录（`_写作工具箱/`）里的文件和文件夹 Obsidian 会索引：
 * 必须走 vault API，否则索引不知道，文件列表里会留下已经删掉的空文件夹
 * （2026-10-23 测试库实测：切回隐藏目录后磁盘上没了，侧栏还显示 `_写作工具箱`）。
 * 隐藏目录不进索引，照旧走 adapter。
 */
function migrationFs(app: App): MigrationFs {
  const vault = app.vault;
  const adapter: DataAdapter = vault.adapter;
  return {
    exists: (path) => adapter.exists(path),
    read: (path) => adapter.read(path),
    list: (path) => adapter.list(path),
    remove: (path) => adapter.remove(path),
    async mkdir(path) {
      if (!isHiddenPath(path) && !vault.getAbstractFileByPath(path)) {
        try {
          await vault.createFolder(path);
          return;
        } catch {
          /* 并发创建或索引还没跟上：退回 adapter */
        }
      }
      await adapter.mkdir(path);
    },
    async rename(from, to) {
      // 一头在隐藏目录时 vault.rename 不保证可用（目标进不了索引）：搬家的源头总在隐藏目录，
      // 所以实际都走 adapter；文件本身的增删 Obsidian 能跟上，跟不上的是空文件夹（见 rmdir）。
      const file = isHiddenPath(from) || isHiddenPath(to) ? null : vault.getAbstractFileByPath(from);
      if (file instanceof TFile) {
        await vault.rename(file, to);
        return;
      }
      await adapter.rename(from, to);
    },
    /**
     * 只在调用方已按磁盘确认「没有真实文件」之后才调。可见目录走 fileManager.trashFile
     * 让 Obsidian 索引知道（尊重用户「删到回收站」的设置；里面只剩空文件夹和系统垃圾）；
     * 索引对不上删不掉时退回 adapter。隐藏目录不进索引，直接走 adapter。
     */
    async rmdir(path, recursive) {
      const folder = vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder) {
        try {
          await app.fileManager.trashFile(folder);
          return;
        } catch {
          /* 索引与磁盘对不上：退回 adapter */
        }
      }
      await adapter.rmdir(path, recursive);
    },
  };
}

/** Obsidian 没公开的配置读写；拿不到就返回 null，由调用方提示手动操作。 */
interface VaultConfigApi {
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}

function vaultConfig(app: App): VaultConfigApi | null {
  const vault = app.vault as unknown as Partial<VaultConfigApi>;
  return typeof vault.getConfig === "function" && typeof vault.setConfig === "function"
    ? (vault as VaultConfigApi)
    : null;
}

export function createSidecarLocationModule(): SidecarLocationModule {
  let context: FeatureContext | null = null;
  let operations: SidecarLocationOperations | null = null;

  function requireContext(): FeatureContext {
    if (!context) throw new Error("存放位置模块尚未激活");
    return context;
  }

  function addToObsidianExcluded(): void {
    const ctx = requireContext();
    const entry = `${VISIBLE_DATA_ROOT}/`;
    const config = vaultConfig(ctx.app);
    if (!config) {
      new Notice(
        `请手动在「设置 → 文件与链接 → 排除的文件」里加入 ${entry}`,
        10000
      );
      return;
    }
    const raw = config.getConfig("userIgnoreFilters");
    const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    if (list.includes(entry) || list.includes(VISIBLE_DATA_ROOT)) {
      new Notice(`${entry} 已经在 Obsidian 的排除列表里了`);
      return;
    }
    config.setConfig("userIgnoreFilters", [...list, entry]);
    new Notice(`已把 ${entry} 加进 Obsidian 的排除列表：搜索、关系图、快速切换不再显示它`);
  }

  return {
    id: "sidecar-location",
    activate(ctx) {
      context = ctx;
      operations = {
        addToObsidianExcluded: () => addToObsidianExcluded(),
      };
      ctx.effects.add(() => {
        context = null;
        operations = null;
      });
    },
    get operations() {
      if (!operations) throw new Error("存放位置模块尚未激活");
      return operations;
    },
  };
}

/**
 * 启动时（读完设置、模块激活之前）把旧版隐藏目录里的批注 / 快照 / 章纲收进 `_写作工具箱/`，
 * 各模块激活后直接读新位置。同名且内容相同的删掉旧的；内容不同的留在原处（照常兜底读取），
 * 提示一次条数。用户自定义过快照文件夹的，快照不搬。失败只记日志，不挡启动。
 */
export async function migrateLegacySidecars(
  app: App,
  settings: { snapshotFolder: string }
): Promise<void> {
  try {
    const fs = migrationFs(app);
    const plan = await planSidecarMigration(fs, "hidden", "visible", settings.snapshotFolder);
    if (plan.moves.length === 0 && !(await anyExists(fs, plan.sourceFolders))) return;
    const result = await runSidecarMigration(fs, plan);
    const left = result.skipped.length + result.failed.length;
    if (result.moved > 0 || left > 0) {
      new Notice(
        `写作工具箱：已把 ${result.moved} 个批注 / 快照 / 章纲文件收进 ${VISIBLE_DATA_ROOT}/` +
          (left > 0 ? `；${left} 个和那边的同名文件内容不同或没搬成，留在原处（详见控制台）` : ""),
        left > 0 ? 12000 : 5000
      );
    }
    if (left > 0) {
      console.warn("[Writing Toolkit:sidecar-location] 旧目录里没搬走的文件", result);
    }
    if (result.cleanupFailed.length) {
      // 不影响功能（旧位置已没有真实文件），但要留下原因，下次能直接看
      console.warn("[Writing Toolkit:sidecar-location] 旧位置的空文件夹没删掉", result.cleanupFailed);
    }
  } catch (error) {
    console.error("[Writing Toolkit:sidecar-location] 收拢旧目录失败", error);
  }
}

async function anyExists(fs: MigrationFs, paths: readonly string[]): Promise<boolean> {
  for (const path of paths) if (await fs.exists(path)) return true;
  return false;
}
