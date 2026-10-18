/**
 * 阶段 5：UI Shell 的最小宿主上下文。
 *
 * 主页 / 编辑台 / 工具箱 / 手机状态条只依赖这个文件里声明的窄接口，
 * 不再 import `main.ts` 的类型。接口按能力分组：
 *
 * - `services`：Host 已迁移到 Services 的基础能力（项目索引、设置、字数、UI、事件、诊断）。
 * - `stats` / `prefs` / `recent`：统计读模型、界面偏好、最近文档的稳定读取面。
 * - `caps`：功能模块（章纲 / 快照 / 批注 / 日历 / 番茄钟）的窄操作端口，Shell 不 import 模块实现。
 * - `editorOptions` / `actions`：编辑辅助设置与宿主动作。
 *
 * 迁移期约定：`settings` 仍是实时对象，Shell 可以按旧方式直接改字段，
 * 但改完必须调用 `actions.saveSettings()`（它会写盘并广播设置变更）。
 * 后续阶段若把统计/偏好完全搬进 Service，只需改这里的实现，不改 Shell。
 */
import type { App, Editor, TFile } from "obsidian";
import type { HostServices } from "./host/pluginHost";
import type { WritingToolkitSettings } from "./settingsSchema";
import type { WordCountMode } from "./wordcount";
import type { CommentPanelModel } from "./commentView";
import type { SnapshotEntry } from "./snapshot";
import type { PomodoroState } from "./pomodoro";
import type { UiPanelGroup } from "./services/uiService";
import type { HomePage, LibraryView } from "./home";
import type { WorkbenchMode } from "./workbench";
import type { WorkbenchStatus } from "./uiShellShared";
import type { CalendarHandle } from "./services/uiTypes";
import type { OutlineChange, OutlineLoadResult } from "./features/outlineModule";

/** 日历只暴露窄句柄类型，Shell 不 import 日历模块实现。 */
export type { CalendarHandle } from "./services/uiTypes";

/** UI Shell 需要的基础 Services 子集。 */
export type UiShellServices = Pick<
  HostServices,
  "diagnostics" | "events" | "project" | "settings" | "ui" | "wordcount"
>;

/** 统计读模型：数字由 main.ts 维护，Shell 只读、不自己重算。 */
export interface UiShellStats {
  total(): number;
  durationSeconds(): number;
  getTodayDurationSeconds(): number;
  getTodayPomodoroSummary(): { count: number; words: number } | null;
  dailyForDisplay(): Readonly<Record<string, number>>;
  projectForDisplay(key: string): Readonly<Record<string, number>>;
  getProjects(keepKey?: string | null): { key: string; label: string }[];
  statusBarSpeed(): number;
  showDailyBreakdown(): void;
  setWordCountMode(mode: WordCountMode): void;
}

/** 界面偏好：页面、书架、封面、隐藏作品与编辑台的界面记忆。 */
export interface UiShellPrefs {
  getHomePage(): HomePage;
  setHomePage(page: HomePage): void;
  getLibraryView(): LibraryView;
  setLibraryView(view: LibraryView): void;
  getProjectCover(root: string): string | null;
  setProjectCover(root: string, path: string | null): void;
  isProjectHidden(root: string): boolean;
  setProjectHidden(root: string, hidden: boolean): void;
  getWorkbenchProject(): string | null;
  setWorkbenchProject(root: string): void;
  getWorkbenchMode(): WorkbenchMode;
  setWorkbenchMode(mode: WorkbenchMode): void;
  getWorkbenchStatus(root: string): WorkbenchStatus | null;
  setWorkbenchStatus(root: string, status: WorkbenchStatus | null): void;
}

/** 页面导航与刷新扇出。 */
export interface UiShellNavigation {
  openHome(): Promise<void>;
  openWorkbench(): Promise<void>;
  openSidebar(): Promise<void>;
  refreshHome(): void;
  refreshWorkbenches(): void;
  openNewProjectDialog(): void;
}

/** 最近一次活动文档：侧栏获得焦点时 workspace 的“当前文件”会丢失，这里读最后一次已知值。 */
export interface UiShellRecentDocument {
  path(): string | null;
  text(): string | null;
  editor(): Editor | null;
}

/** 功能模块的窄操作端口：UI Shell 不直接 import 模块实现。 */
export interface UiShellCapabilities {
  panels: {
    mountSnapshotPanels(container: HTMLElement): UiPanelGroup;
    mountOutlinePanels(container: HTMLElement): UiPanelGroup;
    mountCommentsPanels(container: HTMLElement): UiPanelGroup;
  };
  outline: {
    load(file: TFile): Promise<OutlineLoadResult>;
    save(file: TFile, value: string): Promise<void>;
    has(file: TFile): Promise<boolean>;
    subscribe(listener: (change: OutlineChange) => void): () => void;
  };
  snapshots: {
    list(path: string): Promise<SnapshotEntry[]>;
    openDiff(path: string): Promise<void>;
  };
  comments: {
    panelModel(): Promise<CommentPanelModel>;
  };
  calendar: {
    create(container: HTMLElement, initialYear?: number): CalendarHandle;
  };
  pomodoro: {
    getPomodoroState(): PomodoroState | null;
    getTodayPomodoroSummary(): { count: number; words: number } | null;
    startPomodoro(): void;
    stopPomodoro(): void;
    togglePomodoroPause(): void;
    skipPomodoroBreak(): void;
  };
}

/** 编辑辅助设置：改完设置对象后调用，立即作用到现有编辑器。 */
export interface UiShellEditorOptions {
  setTypewriterMode(on: boolean): void;
  setTypewriterOffset(offset: number): void;
  setPunctuationAssist(on: boolean): void;
  setImmersiveMode(on: boolean): void;
  setParagraphHighlight(on: boolean): void;
  setHemingwayMode(on: boolean): void;
}

/** 宿主动作：写盘、系统定位、字数与移动端可见性。 */
export interface UiShellActions {
  saveSettings(): Promise<void>;
  revealPathInSystem(path: string): void;
  updateStatusBarVisibility(): void;
  copyCleanChapter(path: string): Promise<void>;
  countWords(text: string, mode?: WordCountMode): number;
}

/** UI Shell 构造函数的唯一入参（main.ts 在模块激活后构建一次）。 */
export interface UiShellContext {
  readonly app: App;
  readonly services: UiShellServices;
  readonly settings: WritingToolkitSettings;
  readonly stats: UiShellStats;
  readonly prefs: UiShellPrefs;
  readonly nav: UiShellNavigation;
  readonly recent: UiShellRecentDocument;
  readonly caps: UiShellCapabilities;
  readonly editorOptions: UiShellEditorOptions;
  readonly actions: UiShellActions;
}
