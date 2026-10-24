/**
 * 伴随数据的整体搬家：启动时把旧版隐藏目录收进 `_写作工具箱/`（specs/sidecar-location.md）。
 *
 * 只依赖一个最小文件接口（Obsidian 的 DataAdapter 天然满足），方便用内存假盘检查。
 * 规矩：
 *   · 目标处已有同名文件 → 内容相同就删掉旧的；不同就跳过、不覆盖，结束时列出来；
 *   · 单个文件搬失败 → 原样留在旧位置（读取时新旧两档都认，数据不丢）；
 *   · 用户自定义过快照文件夹的，快照不搬（那是他主动选的位置）；
 *   · 搬完确认旧位置里没有任何真实文件，再整棵删掉（删不掉就留着并报出错误，不影响功能）。
 */
import {
  SIDECAR_FOLDERS,
  isCustomSnapshotFolder,
  type SidecarKind,
  type SidecarLocation,
} from "./sidecarLocation";

export interface MigrationFs {
  exists(path: string): Promise<boolean>;
  /** 读文本（同名文件比对内容用；可选，没有就一律跳过） */
  read?(path: string): Promise<string>;
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
  /** 目标处已有内容相同的同名文件、删掉了旧的那份 */
  deduped: number;
  /** 目标处已有内容不同的同名文件而跳过的（源路径） */
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

/** 两个文件内容是否完全相同；读不了就当不同（宁可留着）。 */
async function sameContent(fs: MigrationFs, a: string, b: string): Promise<boolean> {
  if (!fs.read) return false;
  try {
    return (await fs.read(a)) === (await fs.read(b));
  } catch {
    return false;
  }
}

export async function runSidecarMigration(
  fs: MigrationFs,
  plan: SidecarMigrationPlan
): Promise<SidecarMigrationResult> {
  const result: SidecarMigrationResult = {
    moved: 0,
    deduped: 0,
    skipped: [],
    failed: [],
    cleanupFailed: [],
  };
  for (const move of plan.moves) {
    try {
      if (await fs.exists(move.to)) {
        if (fs.remove && (await sameContent(fs, move.from, move.to))) {
          await fs.remove(move.from);
          result.deduped++;
        } else {
          result.skipped.push(move.from);
        }
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
  for (const root of plan.sourceFolders) {
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
