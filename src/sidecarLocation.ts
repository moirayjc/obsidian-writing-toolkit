/**
 * 伴随数据（批注 / 快照 / 章纲）的存放位置。
 *
 * 两档（specs/sidecar-location.md）：
 *   · hidden（默认）：`.wt-comments/`、`.wt-snapshots/`、`.wt-outlines/`；
 *   · visible：库根 `_写作工具箱/批注|快照|章纲/`。
 * 为什么要有第二档：Obsidian 官方同步不同步以 `.` 开头的目录（`.obsidian` 除外，没有开关），
 * 用它的人批注、快照、章纲到不了第二台设备，而且没有任何提示。
 *
 * 当前档位是进程内的一个值，由主入口在读完设置后、以及设置变化时写入；
 * 各处取路径一律经这里，不要再写死目录名。本模块是纯逻辑（不依赖 Obsidian API）。
 */

export type SidecarLocation = "hidden" | "visible";

export type SidecarKind = "comments" | "snapshots" | "outlines";

/** 可同步目录的根：下划线开头，在文件列表里排最前、一眼看出不是正文 */
export const VISIBLE_DATA_ROOT = "_写作工具箱";

export const SIDECAR_FOLDERS: Record<SidecarLocation, Record<SidecarKind, string>> = {
  hidden: {
    comments: ".wt-comments",
    snapshots: ".wt-snapshots",
    outlines: ".wt-outlines",
  },
  visible: {
    comments: `${VISIBLE_DATA_ROOT}/批注`,
    snapshots: `${VISIBLE_DATA_ROOT}/快照`,
    outlines: `${VISIBLE_DATA_ROOT}/章纲`,
  },
};

/** 快照文件夹设置的默认值；用户改过别的值时，那个值优先于存放位置 */
export const DEFAULT_SNAPSHOT_FOLDER = SIDECAR_FOLDERS.hidden.snapshots;

let current: SidecarLocation = "hidden";

export function setSidecarLocation(location: SidecarLocation): void {
  current = location === "visible" ? "visible" : "hidden";
}

export function getSidecarLocation(): SidecarLocation {
  return current;
}

export function otherLocation(location: SidecarLocation = current): SidecarLocation {
  return location === "visible" ? "hidden" : "visible";
}

/** 当前档位下某类数据的目录。 */
export function sidecarFolder(
  kind: SidecarKind,
  location: SidecarLocation = current
): string {
  return SIDECAR_FOLDERS[location][kind];
}

/** 两档里某类数据的全部目录（当前档在前；读取兜底、路径反推时用）。 */
export function sidecarFoldersOf(kind: SidecarKind): string[] {
  return [sidecarFolder(kind, current), sidecarFolder(kind, otherLocation())];
}

/** 路径是否在某个目录之下（含目录本身）。 */
export function isUnder(path: string, folder: string): boolean {
  const f = folder.replace(/^\/+|\/+$/g, "");
  return !!f && (path === f || path.startsWith(f + "/"));
}

/** 在 `_写作工具箱/` 之下：不管当前档位，都不是正文。 */
export function isVisibleDataPath(path: string): boolean {
  return isUnder(path, VISIBLE_DATA_ROOT);
}

/** 用户改过「快照文件夹」（不是空、也不是默认的 `.wt-snapshots`）。 */
export function isCustomSnapshotFolder(setting: string | undefined): boolean {
  const value = normalizeFolder(setting ?? "");
  return value !== "" && value !== DEFAULT_SNAPSHOT_FOLDER;
}

/** 实际使用的快照文件夹：用户自定义的优先，否则跟着存放位置。 */
export function effectiveSnapshotFolder(
  setting: string | undefined,
  location: SidecarLocation = current
): string {
  return isCustomSnapshotFolder(setting)
    ? normalizeFolder(setting ?? "")
    : sidecarFolder("snapshots", location);
}

function normalizeFolder(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}
