/**
 * 伴随数据存放位置（specs/sidecar-location.md）：切换 + 整体搬家 + 多设备不一致提示
 * + 「加入 Obsidian 排除列表」。
 *
 * 路径本身由 src/sidecarLocation.ts 统一换算；这里只管「什么时候换、换的时候搬什么」。
 * 不注册命令：入口在设置页。
 */
import { Notice, TFile, TFolder, type App, type DataAdapter } from "obsidian";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import { ConfirmModal } from "../promptModal";
import {
  VISIBLE_DATA_ROOT,
  getSidecarLocation,
  setSidecarLocation,
  type SidecarLocation,
} from "../sidecarLocation";
import {
  describePlan,
  detectSidecarLocation,
  planSidecarMigration,
  runSidecarMigration,
  type MigrationFs,
} from "../sidecarMigration";

export interface SidecarLocationModuleOptions {
  /** 写盘并广播设置变化（各模块据此按新位置重读）。 */
  saveSettings(): Promise<void>;
  /** 搬家前清空还在排队的写入（批注的读改写队列）。 */
  flushPending?(): Promise<void>;
  /** 切换完成后（设置页据此重画，显示新值）。 */
  onSwitched?(): void;
}

export interface SidecarLocationOperations {
  /** 切换存放位置：先确认（写明搬多少文件），确认后整体搬家再改设置。 */
  switchTo(target: SidecarLocation): void;
  /** 把 `_写作工具箱/` 加进「设置 → 文件与链接 → 排除的文件」。 */
  addToObsidianExcluded(): void;
}

export interface SidecarLocationModule extends FeatureModule {
  readonly operations: SidecarLocationOperations;
}

type ConfirmPresenter = (
  app: App,
  title: string,
  message: string,
  cta: string,
  onConfirm: () => void
) => { open(): void };

const LOCATION_LABELS: Record<SidecarLocation, string> = {
  hidden: "隐藏目录",
  visible: "可同步目录",
};

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
      // 一头在隐藏目录时 vault.rename 不保证可用（目标进不了索引）：搬家两头总有一头是隐藏的，
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

export function createSidecarLocationModule(
  options: SidecarLocationModuleOptions,
  createConfirm: ConfirmPresenter = (...args) => new ConfirmModal(...args)
): SidecarLocationModule {
  let context: FeatureContext | null = null;
  let operations: SidecarLocationOperations | null = null;
  let busy = false;

  function requireContext(): FeatureContext {
    if (!context) throw new Error("存放位置模块尚未激活");
    return context;
  }

  /**
   * 把 from 档的数据搬到 target 档并以 target 为当前档。
   * 切换：from = 当前档；合并（两处都有数据）：from = 另一档、target 可以就是当前档。
   */
  async function switchTo(
    target: SidecarLocation,
    from: SidecarLocation = requireContext().services.settings.get().sidecarLocation
  ): Promise<void> {
    const ctx = requireContext();
    const settings = ctx.services.settings.get();
    if (from === target || busy) return;
    const fs = migrationFs(ctx.app);
    const plan = await planSidecarMigration(fs, from, target, settings.snapshotFolder);
    const where =
      target === "visible"
        ? `库根的「${VISIBLE_DATA_ROOT}/」（批注、快照、章纲各一个子目录）`
        : "隐藏目录（.wt-comments / .wt-snapshots / .wt-outlines）";
    createConfirm(
      ctx.app,
      `存放位置改为「${LOCATION_LABELS[target]}」`,
      `批注、快照、章纲会整体搬到${where}。${describePlan(plan)}\n` +
        "目标处已有同名文件的会跳过、不覆盖。之后可以随时切回去。",
      "搬过去",
      () => void runSwitch(from, target)
    ).open();
  }

  async function runSwitch(from: SidecarLocation, target: SidecarLocation): Promise<void> {
    if (!context || busy) return;
    const ctx = context;
    busy = true;
    try {
      await options.flushPending?.();
      const settings = ctx.services.settings.get();
      const fs = migrationFs(ctx.app);
      // 确认框开着的时候可能又写了新文件：按确认那一刻重新列一遍
      const plan = await planSidecarMigration(fs, from, target, settings.snapshotFolder);
      const result = await runSidecarMigration(fs, plan);
      // 先切进程内的位置，再写设置：保存时广播变化，各模块重读用的就是新位置
      setSidecarLocation(target);
      settings.sidecarLocation = target;
      await options.saveSettings();
      options.onSwitched?.();
      const tail: string[] = [];
      if (result.skipped.length > 0) {
        tail.push(`${result.skipped.length} 个因目标处已有同名文件而跳过（留在原处）`);
      }
      if (result.failed.length > 0) {
        tail.push(`${result.failed.length} 个没搬成（留在原处，照常能读）`);
      }
      new Notice(
        `存放位置已改为「${LOCATION_LABELS[target]}」，搬了 ${result.moved} 个文件` +
          (tail.length ? `；${tail.join("；")}` : ""),
        tail.length ? 12000 : 5000
      );
      if (tail.length) {
        console.warn("[Writing Toolkit:sidecar-location] 存放位置切换未搬的文件", result);
      }
      if (result.cleanupFailed.length) {
        // 不影响功能（旧位置已没有真实文件），但要留下原因，下次能直接看
        const failed = result.cleanupFailed;
        console.warn("[Writing Toolkit:sidecar-location] 旧位置的空文件夹没删掉", failed);
      }
    } catch (error) {
      console.error("[Writing Toolkit:sidecar-location] 切换存放位置失败", error);
      new Notice("切换存放位置失败（详见控制台），设置没有改");
    } finally {
      busy = false;
    }
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

  /**
   * 两处都有真实文件（多半是两台设备各自写过）：提示合并。
   * 当前档位启动时已按库里的实际数据定好（resolveStartupSidecarLocation），这里只处理冲突。
   */
  async function maybePromptConflict(): Promise<void> {
    if (!context) return;
    const ctx = context;
    const settings = ctx.services.settings.get();
    if (settings.sidecarLocationPromptDismissed) return;
    let conflict = false;
    try {
      const detected = await detectSidecarLocation(
        migrationFs(ctx.app),
        settings.sidecarLocation,
        settings.snapshotFolder
      );
      conflict = detected.conflict;
    } catch {
      /* 读不到就当没有 */
    }
    if (!conflict || !context) return;

    const fragment = createFragment();
    fragment.append(
      createSpan({
        text: `写作工具箱：隐藏目录和「${VISIBLE_DATA_ROOT}/」里都有批注 / 快照 / 章纲（多半是两台设备各自写过），现在用的是「${LOCATION_LABELS[getSidecarLocation()]}」。合并到一处吗？同名文件跳过、不覆盖。`,
      })
    );
    const toVisible = createEl("button", { cls: "wt-notice-undo", text: "合并到可同步目录" });
    const toHidden = createEl("button", { cls: "wt-notice-undo", text: "合并到隐藏目录" });
    const dismissBtn = createEl("button", { cls: "wt-notice-undo", text: "不再提示" });
    fragment.append(toVisible, toHidden, dismissBtn);
    const notice = new Notice(fragment, 0);
    toVisible.onclick = () => {
      notice.hide();
      void switchTo("visible", "hidden");
    };
    toHidden.onclick = () => {
      notice.hide();
      void switchTo("hidden", "visible");
    };
    dismissBtn.onclick = () => {
      notice.hide();
      if (!context) return;
      context.services.settings.get().sidecarLocationPromptDismissed = true;
      void options.saveSettings();
    };
  }

  return {
    id: "sidecar-location",
    activate(ctx) {
      context = ctx;
      operations = {
        switchTo: (target) => {
          void switchTo(target).catch((error) => {
            console.error("[Writing Toolkit:sidecar-location] 准备切换存放位置失败", error);
            new Notice("准备切换存放位置失败（详见控制台）");
          });
        },
        addToObsidianExcluded: () => addToObsidianExcluded(),
      };
      ctx.events.onLayoutReady(() => {
        void maybePromptConflict();
      });
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
 * 启动时（读完设置、模块激活之前）定下当前档位：以库里的实际数据为准，
 * `data.json` 里记的只当缓存——它会被同步工具在设备间互相覆盖。
 * 定下来的值写回内存里的设置（下次存盘时缓存跟着更新），不搬任何文件。
 */
export async function resolveStartupSidecarLocation(
  app: App,
  settings: { sidecarLocation: SidecarLocation; snapshotFolder: string }
): Promise<SidecarLocation> {
  let location = settings.sidecarLocation;
  try {
    const detected = await detectSidecarLocation(
      migrationFs(app),
      settings.sidecarLocation,
      settings.snapshotFolder
    );
    location = detected.location;
  } catch (error) {
    console.error("[Writing Toolkit:sidecar-location] 判断存放位置失败，沿用设置里的值", error);
  }
  settings.sidecarLocation = location;
  setSidecarLocation(location);
  return location;
}
