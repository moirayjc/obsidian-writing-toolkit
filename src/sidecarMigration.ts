/**
 * 伴随数据存放位置切换时的整体搬家（specs/sidecar-location.md）。
 *
 * 只依赖一个最小文件接口（Obsidian 的 DataAdapter 天然满足），方便用内存假盘检查。
 * 规矩：
 *   · 目标处已有同名文件 → 跳过、不覆盖，结束时列出来；
 *   · 单个文件搬失败 → 原样留在旧位置（读取时新旧两档都认，数据不丢）；
 *   · 用户自定义过快照文件夹的，快照不搬（那是他主动选的位置）；
 *   · 搬完确认旧位置里没有任何真实文件，再整棵删掉（删不掉就留着并报出错误，不影响功能）。
 */
import {
  SIDECAR_FOLDERS,
  VISIBLE_DATA_ROOT,
  isCustomSnapshotFolder,
  type SidecarKind,
  type SidecarLocation,
} from "./sidecarLocation";

export interface MigrationFs {
  exists(path: string): Promise<boolean>;
  /** 删文件（清掉 .DS_Store 这类系统垃圾用；可选） */
  remove?(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rmdir?(path: string, recursive: boolean): Promise<void>;
}

export interface SidecarMove {
  kind: SidecarKind;
  from: string;
  to: string;
}

export interface SidecarMigrationPlan {
  from: SidecarLocation;
  to: SidecarLocation;
  moves: SidecarMove[];
  /** 参与搬家的源目录（搬完尝试删掉空目录） */
  sourceFolders: string[];
}

export interface SidecarMigrationResult {
  moved: number;
  /** 目标处已有同名文件而跳过的（源路径） */
  skipped: string[];
  /** 搬失败、留在原处的（源路径） */
  failed: string[];
  /** 清理旧目录失败的（目录 + 错误），调用方写进控制台 */
  cleanupFailed: string[];
}

/**
 * 系统自动生成的垃圾文件：不算数据、不搬，判断「文件夹空没空」时也不算。
 * macOS 的 Finder 看过一眼就会留下 .DS_Store（2026-10-23 工作库实测：它让 `_写作工具箱/` 删不掉）。
 */
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export function isJunkFile(path: string): boolean {
  return JUNK_FILES.has(path.split("/").pop() ?? "");
}

export const SIDECAR_KIND_LABELS: Record<SidecarKind, string> = {
  comments: "批注",
  snapshots: "快照",
  outlines: "章纲",
};

/** 列出某目录下全部文件（递归）；不同平台 list 可能返回完整路径或裸名，两种都兜住。 */
async function listDeep(fs: MigrationFs, folder: string): Promise<string[]> {
  if (!(await fs.exists(folder))) return [];
  let listed: { files: string[]; folders: string[] };
  try {
    listed = await fs.list(folder);
  } catch {
    return [];
  }
  const join = (child: string): string =>
    child === folder || child.startsWith(`${folder}/`) ? child : `${folder}/${child}`;
  const out = listed.files.map(join);
  for (const child of listed.folders) out.push(...(await listDeep(fs, join(child))));
  return out;
}

export async function planSidecarMigration(
  fs: MigrationFs,
  from: SidecarLocation,
  to: SidecarLocation,
  snapshotFolderSetting: string | undefined
): Promise<SidecarMigrationPlan> {
  const kinds: SidecarKind[] = ["comments", "outlines"];
  if (!isCustomSnapshotFolder(snapshotFolderSetting)) kinds.push("snapshots");
  const moves: SidecarMove[] = [];
  const sourceFolders: string[] = [];
  if (from === to) return { from, to, moves, sourceFolders };
  for (const kind of kinds) {
    const source = SIDECAR_FOLDERS[from][kind];
    const target = SIDECAR_FOLDERS[to][kind];
    sourceFolders.push(source);
    for (const file of await listDeep(fs, source)) {
      if (isJunkFile(file)) continue;
      moves.push({ kind, from: file, to: `${target}${file.slice(source.length)}` });
    }
  }
  return { from, to, moves, sourceFolders };
}

async function ensureFolder(fs: MigrationFs, folder: string): Promise<void> {
  let current = "";
  for (const part of folder.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    try {
      if (!(await fs.exists(current))) await fs.mkdir(current);
    } catch {
      /* 已存在或并发创建，忽略 */
    }
  }
}

export async function runSidecarMigration(
  fs: MigrationFs,
  plan: SidecarMigrationPlan
): Promise<SidecarMigrationResult> {
  const result: SidecarMigrationResult = {
    moved: 0,
    skipped: [],
    failed: [],
    cleanupFailed: [],
  };
  for (const move of plan.moves) {
    try {
      if (await fs.exists(move.to)) {
        result.skipped.push(move.from);
        continue;
      }
      await ensureFolder(fs, move.to.slice(0, move.to.lastIndexOf("/")));
      await fs.rename(move.from, move.to);
      result.moved++;
    } catch {
      result.failed.push(move.from);
    }
  }
  // 搬空的旧目录整棵删：先确认里面没有任何真实文件（系统垃圾不算），再递归删。
  // 逐层删在真机上会失败（2026-10-23 工作库实测留下整棵空文件夹），所以不再逐层删。
  const roots = [...plan.sourceFolders];
  if (plan.from === "visible") roots.push(VISIBLE_DATA_ROOT);
  for (const root of roots) {
    const error = await removeIfNoRealFiles(fs, root);
    if (error) result.cleanupFailed.push(`${root}：${error}`);
  }
  return result;
}

/** 目录（递归）里有没有真实文件；找到第一个就停。 */
export async function hasRealFiles(fs: MigrationFs, folder: string): Promise<boolean> {
  if (!(await fs.exists(folder))) return false;
  let listed: { files: string[]; folders: string[] };
  try {
    listed = await fs.list(folder);
  } catch {
    return false;
  }
  const join = (child: string): string =>
    child === folder || child.startsWith(`${folder}/`) ? child : `${folder}/${child}`;
  if (listed.files.some((f) => !isJunkFile(join(f)))) return true;
  for (const child of listed.folders) {
    if (await hasRealFiles(fs, join(child))) return true;
  }
  return false;
}

/** 没有真实文件就整棵删；返回错误说明（没删或删成功返回 null）。 */
async function removeIfNoRealFiles(fs: MigrationFs, folder: string): Promise<string | null> {
  if (!fs.rmdir || !(await fs.exists(folder))) return null;
  if (await hasRealFiles(fs, folder)) return null;
  try {
    await fs.rmdir(folder, true);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 某一档位里有没有真实数据（用户自定义了快照文件夹的，快照不算这一档的）。 */
export async function locationHasData(
  fs: MigrationFs,
  location: SidecarLocation,
  snapshotFolderSetting: string | undefined
): Promise<boolean> {
  const kinds: SidecarKind[] = ["comments", "outlines"];
  if (!isCustomSnapshotFolder(snapshotFolderSetting)) kinds.push("snapshots");
  for (const kind of kinds) {
    if (await hasRealFiles(fs, SIDECAR_FOLDERS[location][kind])) return true;
  }
  return false;
}

export interface DetectedLocation {
  location: SidecarLocation;
  /** 两处都有真实文件（需要提示用户合并） */
  conflict: boolean;
}

/**
 * 启动时决定读写哪一档：以库里的实际数据为准，`data.json` 里记的只当缓存。
 * 为什么不信 `data.json`：它会被同步工具在设备间互相覆盖（工作库实测，Remotely Save 同步配置目录）。
 * 只有一处有数据 → 用那一处；都没有 → 沿用缓存；两处都有 → 沿用缓存并标记冲突。
 */
export async function detectSidecarLocation(
  fs: MigrationFs,
  cached: SidecarLocation,
  snapshotFolderSetting: string | undefined
): Promise<DetectedLocation> {
  const [visible, hidden] = await Promise.all([
    locationHasData(fs, "visible", snapshotFolderSetting),
    locationHasData(fs, "hidden", snapshotFolderSetting),
  ]);
  if (visible && !hidden) return { location: "visible", conflict: false };
  if (hidden && !visible) return { location: "hidden", conflict: false };
  return { location: cached, conflict: visible && hidden };
}

/** 确认框里的一句话：「将搬 12 个文件：批注 3、快照 8、章纲 1」。 */
export function describePlan(plan: SidecarMigrationPlan): string {
  if (plan.moves.length === 0) return "目前没有需要搬的文件。";
  const counts = new Map<SidecarKind, number>();
  for (const move of plan.moves) counts.set(move.kind, (counts.get(move.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => `${SIDECAR_KIND_LABELS[kind]} ${n}`);
  return `将搬 ${plan.moves.length} 个文件：${parts.join("、")}。`;
}
