/**
 * 伴随数据（批注 / 快照 / 章纲）的存放位置（specs/sidecar-location.md，2026-10-24 修订）。
 *
 *   · visible（唯一的写入位置）：库根 `_写作工具箱/批注|快照|章纲/`，和 `统计/` 放在一起；
 *   · hidden（旧版）：`.wt-comments/`、`.wt-snapshots/`、`.wt-outlines/`。
 *     启动时整体收进 visible（features/sidecarLocationModule.ts）；没搬走的（失败 / 同名冲突）
 *     仍按「另一档」兜底读取，不往里写新文件。
 * 为什么不再给隐藏目录选项：Obsidian 官方同步不同步以 `.` 开头的目录，且统计本来就在
 * `_写作工具箱/`，两档并存只会让库根同时出现两套文件夹。
 *
 * 各处取路径一律经这里，不要再写死目录名。本模块是纯逻辑（不依赖 Obsidian API）。
 */

export type SidecarLocation = "hidden" | "visible";

export type SidecarKind = "comments" | "snapshots" | "outlines";

/** 伴随数据的根：下划线开头，在文件列表里排最前、一眼看出不是正文 */
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

/**
 * 快照文件夹设置的默认值（老设置里存的就是它）；用户改过别的值时，那个值优先。
 * 设置值保持原样不改，免得没升级的设备把它当成「自定义」。
 */
export const DEFAULT_SNAPSHOT_FOLDER = SIDECAR_FOLDERS.hidden.snapshots;

/** 写入位置：固定为 visible。 */
const current: SidecarLocation = "visible";

export function otherLocation(location: SidecarLocation = current): SidecarLocation {
  return location === "visible" ? "hidden" : "visible";
}

/** 某类数据的目录（默认是写入位置；传 "hidden" 取旧版目录）。 */
export function sidecarFolder(
  kind: SidecarKind,
  location: SidecarLocation = current
): string {
  return SIDECAR_FOLDERS[location][kind];
}

/** 某类数据的全部目录（写入位置在前、旧版在后；读取兜底、路径反推时用）。 */
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

/** 用户改过「快照文件夹」（不是空、不是旧默认 `.wt-snapshots`、也不是 `_写作工具箱/快照`）。 */
export function isCustomSnapshotFolder(setting: string | undefined): boolean {
  const value = normalizeFolder(setting ?? "");
  return (
    value !== "" &&
    value !== DEFAULT_SNAPSHOT_FOLDER &&
    value !== SIDECAR_FOLDERS.visible.snapshots
  );
}

/** 实际使用的快照文件夹：用户自定义的优先，否则 `_写作工具箱/快照`。 */
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
