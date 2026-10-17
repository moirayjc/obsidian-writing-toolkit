/**
 * 界面偏好 Service：主页/书架/编辑台的界面记忆。
 *
 * 这些字段只影响「上次停在哪、怎么摆」，不参与正文统计。集中到 Service 后，
 * main.ts 只负责初始化和读写盘接线，UI Shell 通过 Host Context 的 prefs 端口访问。
 * 数据格式保持不变（仍是 data.json 顶层的同名键）。
 */
import type { HomePage, LibraryView } from "../home";
import type { WorkbenchMode } from "../workbench";
import type { WorkbenchStatus } from "../uiShellShared";

export interface WorkspacePrefsSnapshot {
  workbenchProject: string | null;
  workbenchMode: WorkbenchMode;
  workbenchStatus: Record<string, WorkbenchStatus>;
  hiddenProjects: Record<string, true>;
  homePage: HomePage;
  projectCovers: Record<string, string>;
  libraryView: LibraryView;
}

export interface WorkspacePrefsServiceHost {
  /** 立即排队写盘（对应旧 savePluginData）。 */
  persistNow(): void;
  /** 延后写盘（对应旧 scheduleDailySave）。 */
  schedulePersist(): void;
  refreshHome(): void;
}

function asRecord<T extends object>(value: unknown): T | null {
  return value && typeof value === "object" ? (value as T) : null;
}

function normalizeHomePage(value: unknown): HomePage {
  return value === "library" || value === "stats" || value === "docs"
    ? value
    : "desk";
}

export class WorkspacePrefsService {
  private state: WorkspacePrefsSnapshot = {
    workbenchProject: null,
    workbenchMode: "chapters",
    workbenchStatus: {},
    hiddenProjects: {},
    homePage: "desk",
    projectCovers: {},
    libraryView: "grid",
  };

  constructor(private readonly host: WorkspacePrefsServiceHost) {}

  load(data: Record<string, unknown> | null): void {
    if (!data) return;
    this.state = {
      workbenchProject:
        (data.workbenchProject as string | null | undefined) ?? null,
      workbenchMode:
        data.workbenchMode === "resources" ? "resources" : "chapters",
      workbenchStatus:
        asRecord<Record<string, WorkbenchStatus>>(data.workbenchStatus) ?? {},
      hiddenProjects:
        asRecord<Record<string, true>>(data.hiddenProjects) ?? {},
      homePage: normalizeHomePage(data.homePage),
      projectCovers:
        asRecord<Record<string, string>>(data.projectCovers) ?? {},
      libraryView: data.libraryView === "list" ? "list" : "grid",
    };
  }

  /** 写盘时使用的快照；对象由 Service 持有，Host 只序列化。 */
  forPersistence(): WorkspacePrefsSnapshot {
    return this.state;
  }

  getHomePage(): HomePage {
    return normalizeHomePage(this.state.homePage);
  }

  setHomePage(page: HomePage): void {
    if (this.state.homePage === page) return;
    this.state.homePage = page;
    this.host.persistNow();
  }

  getLibraryView(): LibraryView {
    return this.state.libraryView === "list" ? "list" : "grid";
  }

  setLibraryView(view: LibraryView): void {
    if (this.state.libraryView === view) return;
    this.state.libraryView = view;
    this.host.persistNow();
  }

  getProjectCover(root: string): string | null {
    return this.state.projectCovers[root] ?? null;
  }

  setProjectCover(root: string, path: string | null): void {
    const covers = this.state.projectCovers;
    if (path === null) {
      if (!(root in covers)) return;
      delete covers[root];
    } else {
      if (covers[root] === path) return;
      covers[root] = path;
    }
    this.host.persistNow();
    this.host.refreshHome();
  }

  isProjectHidden(root: string): boolean {
    return this.state.hiddenProjects[root] === true;
  }

  setProjectHidden(root: string, hidden: boolean): void {
    const hiddenMap = this.state.hiddenProjects;
    if (hidden) {
      if (hiddenMap[root]) return;
      hiddenMap[root] = true;
    } else {
      if (!(root in hiddenMap)) return;
      delete hiddenMap[root];
    }
    this.host.persistNow();
    this.host.refreshHome();
  }

  getWorkbenchProject(): string | null {
    return this.state.workbenchProject;
  }

  setWorkbenchProject(root: string): void {
    if (this.state.workbenchProject === root) return;
    this.state.workbenchProject = root;
    this.host.persistNow();
  }

  getWorkbenchMode(): WorkbenchMode {
    return this.state.workbenchMode === "resources" ? "resources" : "chapters";
  }

  setWorkbenchMode(mode: WorkbenchMode): void {
    if (this.state.workbenchMode === mode) return;
    this.state.workbenchMode = mode;
    this.host.persistNow();
  }

  getWorkbenchStatus(root: string): WorkbenchStatus | null {
    return this.state.workbenchStatus[root] ?? null;
  }

  setWorkbenchStatus(root: string, status: WorkbenchStatus | null): void {
    const map = this.state.workbenchStatus;
    if (status === null) {
      if (!(root in map)) return;
      delete map[root];
    } else {
      if (map[root] === status) return;
      map[root] = status;
    }
    this.host.persistNow();
  }

  /** 作品目录或封面图片改名 / 移动后，封面记录（键和图片路径）跟着搬。 */
  migrateCoverPaths(oldPath: string, newPath: string): void {
    if (!oldPath || oldPath === newPath) return;
    const prefix = oldPath + "/";
    const moved = (path: string): string | null =>
      path === oldPath
        ? newPath
        : path.startsWith(prefix)
          ? newPath + path.slice(oldPath.length)
          : null;
    let changed = false;
    const next: Record<string, string> = {};
    for (const [root, image] of Object.entries(this.state.projectCovers)) {
      const nextRoot = moved(root) ?? root;
      const nextImage = moved(image) ?? image;
      if (nextRoot !== root || nextImage !== image) changed = true;
      next[nextRoot] = nextImage;
    }
    if (!changed) return;
    this.state.projectCovers = next;
    this.host.schedulePersist();
  }
}
