import { App, TFile, TFolder } from "obsidian";
import {
  DEFAULT_CHAPTER_EXCLUDE_NAMES,
  isExcludedChapterName,
} from "./outlineText";
import {
  compareChapters,
  compareVolumes,
  isChapterFileName,
  looksLikeDraftFolder,
  looksLikeVolumeFolder,
  parseChapterName,
  sortIndexFor,
} from "./chapterOrder";

/**
 * 「作品」识别：把散落在目录树里的章节聚合成本书 → 卷 → 章 的三级结构。
 *
 * 识别规则（两种常见的仓库组织方式都支持）：
 * A. 正文草稿目录：`P3-示例作品/P3.3-正文草稿/第1章.md`
 *    → 作品 = 正文草稿目录的上一级，卷 = 正文草稿目录本身
 * B. 按卷分目录：`《书名》/第1卷·第一卷名/第10章 章节标题.md`
 *    → 作品 = 《书名》，卷 = 第1卷·第一卷名
 *
 * 章节直接放在某个目录里（`《书名》/第1章.md`）时，该目录自身即为作品。
 */

export interface ChapterEntry {
  file: TFile;
  /** 解析出的章号；null 表示没有编号 */
  number: number | null;
  /** 去掉「第N章」前缀后的标题；可能为空 */
  title: string;
  /** 番外序号（番外一 → 1），仅用于排序 */
  tail: number | null;
  /**
   * frontmatter 里的 `sort_index`（没写就是 null）。
   * 只影响排序，但**章节重编号必须跳过它**——作者显式定制的顺序会被重新编号打乱。
   */
  sortIndex: number | null;
  /** 所属卷目录路径 */
  volumePath: string;
}

export interface VolumeEntry {
  path: string;
  name: string;
  chapters: ChapterEntry[];
}

/** 资料分类：人设 / 设定 / 其他 */
export type ResourceKind = "character" | "setting" | "other";

/** 作品里的非正文资料分组（人物档案、前期准备、作品相关…） */
export interface ResourceGroup {
  path: string;
  name: string;
  kind: ResourceKind;
  files: TFile[];
}

export interface NovelProject {
  /** 作品根目录路径 */
  root: string;
  /** 显示名 */
  name: string;
  volumes: VolumeEntry[];
  /** 全作品章节总数 */
  chapterCount: number;
  /** 设定 / 人设 / 资料分组 */
  resources: ResourceGroup[];
  /** 资料文件总数 */
  resourceCount: number;
}

export interface ProjectScanOptions {
  /** 正文目录关键词（与章纲面板共用 settings.draftKeywords） */
  draftKeywords: string;
  /** 「不算章节」的辅助文件名（与章纲面板共用 settings.chapterExcludeNames） */
  excludeNames?: string;
  /** 额外排除的目录路径前缀（如自定义快照目录） */
  extraExcluded?: string[];
}

/** 路径中任意一段以 `.` 开头即视为内部目录（.obsidian / .trash / .wt-*）。 */
export function isInternalPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function isRootFolder(folder: TFolder): boolean {
  return folder.parent === null || folder.path === "/";
}

function excluded(path: string, options: ProjectScanOptions): boolean {
  if (isInternalPath(path)) return true;
  for (const raw of options.extraExcluded ?? []) {
    const prefix = raw.replace(/^\/+|\/+$/g, "");
    if (prefix && (path === prefix || path.startsWith(prefix + "/"))) return true;
  }
  return false;
}

interface Placement {
  root: string;
  volumePath: string;
  volumeName: string;
  files: TFile[];
}

/** 判断某个目录在作品结构中的位置；不属于任何作品返回 null。 */
function resolvePlacement(
  folder: TFolder,
  options: ProjectScanOptions
): Placement | null {
  if (excluded(folder.path, options)) return null;
  const mdFiles = (folder.children as (TFile | TFolder)[]).filter(
    (c): c is TFile =>
      c instanceof TFile &&
      c.extension === "md" &&
      !isExcludedChapterName(
        c.basename,
        options.excludeNames ?? DEFAULT_CHAPTER_EXCLUDE_NAMES
      )
  );

  const volumeLike = looksLikeVolumeFolder(folder.name);
  const draftLike = looksLikeDraftFolder(folder.name, options.draftKeywords);
  // 空的正文目录 / 空卷也要出现（方便看到「这本书还没写」）
  if (mdFiles.length === 0 && !volumeLike && !draftLike) return null;
  const hasChapterNames = mdFiles.some((f) => isChapterFileName(f.basename));
  if (!volumeLike && !draftLike && !hasChapterNames) return null;

  if (!volumeLike && !draftLike) {
    // 章节直接放在这个目录里：它自己就是作品根
    return {
      root: folder.path,
      volumePath: folder.path,
      volumeName: folder.name,
      files: mdFiles,
    };
  }

  // 向上找到第一个「既不像卷、也不像正文目录」的祖先作为作品根
  let cursor: TFolder | null = folder.parent;
  let volume: TFolder = folder;
  while (cursor && !isRootFolder(cursor)) {
    const isVol = looksLikeVolumeFolder(cursor.name);
    const isDraft = looksLikeDraftFolder(cursor.name, options.draftKeywords);
    if (!isVol && !isDraft) break;
    if (isVol) volume = cursor;
    cursor = cursor.parent;
  }

  const parent = folder.parent;
  const topLevel =
    !cursor || isRootFolder(cursor)
      ? parent && !isRootFolder(parent)
        ? parent.path
        : folder.path
      : cursor.path;

  return {
    root: topLevel,
    volumePath: volume.path,
    volumeName: volume.name,
    files: mdFiles,
  };
}

function projectName(root: string): string {
  if (root === "/" || root === "") return "仓库根目录";
  const parts = root.split("/");
  return parts[parts.length - 1] || root;
}

/** 资料分组分类：人设 / 设定 / 其他 */
function classifyResource(folderName: string): ResourceKind {
  const name = folderName.toLowerCase();
  if (/人物|角色|人设|档案|character|cast/.test(name)) return "character";
  if (
    /设定|世界观|背景|资料|前期|准备|大纲|细纲|纲|时间轴|事件表|地图|地理|灵感|笔记|备忘|memo|素材|参考|相关|setting|world/.test(
      name
    )
  ) {
    return "setting";
  }
  return "other";
}

const KIND_ORDER: Record<ResourceKind, number> = {
  character: 0,
  setting: 1,
  other: 2,
};

/** 扫描整个仓库，返回所有识别到的作品。 */
export function discoverProjects(
  app: App,
  options: ProjectScanOptions
): NovelProject[] {
  const projects = new Map<string, NovelProject>();
  const volumeIndex = new Map<string, VolumeEntry>();
  /** 已经属于正文结构的目录（不再作为资料分组） */
  const chapterFolders = new Set<string>();

  const folders = app.vault
    .getAllLoadedFiles()
    .filter((f): f is TFolder => f instanceof TFolder);

  for (const folder of folders) {
    const placement = resolvePlacement(folder, options);
    if (!placement) continue;

    const sortable = placement.files.map((file) => {
      const parsed = parseChapterName(file.basename);
      return {
        file,
        number: parsed.number,
        tail: parsed.tail,
        title: parsed.title,
        sortIndex: sortIndexFor(app, file),
      };
    });
    sortable.sort(compareChapters);

    let project = projects.get(placement.root);
    if (!project) {
      project = {
        root: placement.root,
        name: projectName(placement.root),
        volumes: [],
        chapterCount: 0,
        resources: [],
        resourceCount: 0,
      };
      projects.set(placement.root, project);
    }

    const key = `${placement.root}\u0000${placement.volumePath}`;
    let volume = volumeIndex.get(key);
    if (!volume) {
      volume = { path: placement.volumePath, name: placement.volumeName, chapters: [] };
      volumeIndex.set(key, volume);
      project.volumes.push(volume);
    }
    chapterFolders.add(folder.path);

    for (const item of sortable) {
      volume.chapters.push({
        file: item.file,
        number: item.number,
        title: item.title,
        tail: item.tail,
        sortIndex: item.sortIndex,
        volumePath: placement.volumePath,
      });
      project.chapterCount++;
    }
  }

  const list = [...projects.values()];
  for (const project of list) {
    project.volumes.sort(compareVolumes);
  }

  // 第二遍：把作品里除正文以外的目录（人物档案 / 前期准备 / 作品相关…）收成资料分组
  for (const folder of folders) {
    if (excluded(folder.path, options)) continue;
    if (chapterFolders.has(folder.path)) continue;
    const owner = projectForPath(folder.path, list);
    if (!owner) continue;
    const files = (folder.children as (TFile | TFolder)[])
      .filter((c): c is TFile => c instanceof TFile && c.extension === "md")
      .sort((a, b) => a.basename.localeCompare(b.basename, "zh-Hans-CN"));
    const isRoot = folder.path === owner.root;
    // 空的根级目录也留一个分组：刚新建的设定分类要能立刻看到（0 篇）
    const isRootChild = folder.parent?.path === owner.root;
    if (files.length === 0 && !isRootChild) continue;
    owner.resources.push({
      path: folder.path,
      name: isRoot ? "本书根目录" : folder.name,
      kind: isRoot ? "other" : classifyResource(folder.name),
      files,
    });
    owner.resourceCount += files.length;
  }

  for (const project of list) {
    project.resources.sort((a, b) => {
      const ka = KIND_ORDER[a.kind];
      const kb = KIND_ORDER[b.kind];
      if (ka !== kb) return ka - kb;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
  }

  list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return list;
}

/** 某个文件属于哪个作品（取最长匹配的作品根）。 */
export function projectForPath(
  path: string,
  projects: readonly NovelProject[]
): NovelProject | null {
  let best: NovelProject | null = null;
  for (const project of projects) {
    if (project.root === "/" || project.root === "") continue;
    if (path === project.root || path.startsWith(project.root + "/")) {
      if (!best || project.root.length > best.root.length) best = project;
    }
  }
  return best;
}

/** 展开作品的全部章节（按卷顺序）。 */
export function allChapters(project: NovelProject): ChapterEntry[] {
  const out: ChapterEntry[] = [];
  for (const volume of project.volumes) out.push(...volume.chapters);
  return out;
}
