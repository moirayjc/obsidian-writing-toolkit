import type { App } from "obsidian";
import {
  allChapters,
  discoverProjects,
  isInternalPath,
  projectForPath,
  type NovelProject,
} from "../project";

export interface ProjectIndexConfig {
  draftKeywords: string;
  chapterExcludeNames: string;
  extraExcluded?: readonly string[];
}

export type ProjectIndexConfigProvider = () => ProjectIndexConfig;

/**
 * Stable project capability shared by Host-managed features.
 *
 * Callers must not mutate returned arrays or sets. invalidate() is called when
 * vault structure or project-recognition settings change.
 */
export interface ProjectService {
  projects(): readonly NovelProject[];
  chapterPaths(): ReadonlySet<string>;
  isDailyCountFile(path: string): boolean;
  projectRootForPath(path: string): string | null;
  invalidate(): void;
}

/**
 * Lazy, invalidatable cache over the existing project discovery rules.
 *
 * The service deliberately delegates to discoverProjects() instead of owning
 * recognition rules, so moving the cache out of main.ts cannot change what
 * counts as a chapter.
 */
export class ProjectIndexService implements ProjectService {
  private projectsCache: NovelProject[] | null = null;
  private chapterPathsCache: Set<string> | null = null;

  constructor(
    private readonly app: App,
    private readonly getConfig: ProjectIndexConfigProvider
  ) {}

  projects(): readonly NovelProject[] {
    if (!this.projectsCache) {
      const config = this.getConfig();
      this.projectsCache = discoverProjects(this.app, {
        draftKeywords: config.draftKeywords,
        excludeNames: config.chapterExcludeNames,
        extraExcluded: config.extraExcluded
          ? [...config.extraExcluded]
          : undefined,
      });
      this.chapterPathsCache = null;
    }
    return this.projectsCache;
  }

  chapterPaths(): ReadonlySet<string> {
    if (!this.chapterPathsCache) {
      const paths = new Set<string>();
      for (const project of this.projects()) {
        for (const chapter of allChapters(project)) {
          paths.add(chapter.file.path);
        }
      }
      this.chapterPathsCache = paths;
    }
    return this.chapterPathsCache;
  }

  isDailyCountFile(path: string): boolean {
    if (isInternalPath(path)) return false;
    return this.chapterPaths().has(path);
  }

  projectRootForPath(path: string): string | null {
    if (isInternalPath(path)) return null;
    return projectForPath(path, this.projects())?.root ?? null;
  }

  invalidate(): void {
    this.projectsCache = null;
    this.chapterPathsCache = null;
  }
}
