import {
  Editor,
  editorInfoField,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import {
  DEFAULT_SETTINGS,
  WritingToolkitSettings,
  WritingToolkitSettingTab,
  type AgentBridgeClient,
  type AgentBridgeSettingsStatus,
} from "./settings";
import { getElectron } from "./electron";
import { PluginHost } from "./host/pluginHost";
import {
  createTypewriterModule,
  type TypewriterModule,
} from "./features/editorTypewriterModule";
import {
  createPunctuationModule,
  type PunctuationModule,
} from "./features/editorPunctuationModule";
import {
  createHardBreakModule,
  type HardBreakModule,
} from "./features/editorHardBreakModule";
import {
  createHemingwayModule,
  type HemingwayModule,
} from "./features/editorHemingwayModule";
import {
  createTypographyModule,
  type TypographyModule,
} from "./features/typographyModule";
import {
  createFormatToolbarModule,
  type FormatToolbarModule,
} from "./features/formatToolbarModule";
import {
  createSnapshotModule,
  type SnapshotModule,
} from "./features/snapshotModule";
import {
  createSnapshotUiModule,
  type SnapshotUiModule,
} from "./features/snapshotUiModule";
import {
  createOutlineModule,
  type OutlineChange,
  type OutlineLoadResult,
  type OutlineModule,
} from "./features/outlineModule";
import {
  createCommentsModule,
  type CommentsModule,
} from "./features/commentsModule";
import {
  createAgentBridgeModule,
  type AgentBridgeModule,
} from "./features/agentBridgeModule";
import {
  createPomodoroModule,
  LOCKED_NOTICE,
  parsePomodoroSession,
  type FocusModes,
  type PomodoroOperations,
  type PomodoroModule,
} from "./features/pomodoroModule";
import { createPomodoroLockEnv } from "./pomodoroLockEnv";
import {
  createCalendarModule,
  type CalendarHandle,
  type CalendarModule,
} from "./features/calendarModule";
import {
  createChapterStatusModule,
  type ChapterStatusModule,
} from "./features/chapterStatusModule";
import { effectiveSnapshotFolder } from "./sidecarLocation";
import {
  createPlanBoardModule,
  type PlanBoardModule,
} from "./features/planBoardModule";
import { DefaultDiagnosticsService } from "./services/diagnosticsService";
import { DefaultEditorService } from "./services/editorService";
import {
  DefaultEventsService,
  type EventScope,
  type TimerHandle,
} from "./services/eventsService";
import { DefaultPersistenceService } from "./services/persistenceService";
import { ProjectIndexService } from "./services/projectIndexService";
import { DefaultSettingsService } from "./services/settingsService";
import {
  DefaultUiService,
  type UiPanelGroup,
} from "./services/uiService";
import { DefaultWordCountService } from "./services/wordCountService";
import { WritingStatusBar } from "./statusbar";
import type { WordCountMode } from "./wordcount";
import { formatToolbarDiag } from "./formatToolbar";
import { registerWtIcons } from "./icons";
import {
  buildStatsDiagReport,
  recordStatusRefresh,
  statsApplied,
  statsDiag,
} from "./diagnostics";
import type {
  CommentPanelModel,
} from "./commentView";
import { WRITING_TOOLKIT_SIDEBAR, WritingToolkitSidebar } from "./sidebar";
import {
  ChapterEntry,
  NovelProject,
  allChapters,
  isInternalPath,
} from "./project";
import {
  WRITING_TOOLKIT_WORKBENCH,
  WritingToolkitWorkbench,
  type WorkbenchMode,
} from "./workbench";
import {
  WRITING_TOOLKIT_HOME,
  WritingToolkitHome,
  type HomePage,
  type LibraryView,
} from "./home";
import type { SnapshotEntry } from "./snapshot";
import { ConfirmModal } from "./promptModal";
import { cleanChapterText } from "./formatWrap";
import {
  MobilePreviewModal,
  type ReaderPreviewModel,
} from "./mobilePreview";
import type { PomodoroPhase, PomodoroState } from "./pomodoro";
import {
  createSidecarLocationModule,
  migrateLegacySidecars,
  type SidecarLocationModule,
} from "./features/sidecarLocationModule";
import {
  applyPlatformMobileClass,
  handleSuppressedClick,
} from "./mobile";
import { MobileStatusBar } from "./mobileStatusBar";
import type { UiShellContext } from "./uiShellContext";
import type { WorkbenchStatus } from "./uiShellShared";
import { NavigationService } from "./services/navigationService";
import { StatsService } from "./services/statsService";
import { buildEditorOriginTracker, isNonAuthorDoc } from "./editorOrigin";
import {
  DeviceStatsBook,
  LEGACY_DEVICE_ID,
  LEGACY_FILE,
  STATS_FOLDER,
  buildLedger,
  computeDay,
  emptyStatsMaps,
  hasAnyStats,
  isLedgerFileName,
  ledgerPath,
  newDeviceId,
  parseLedger,
  pruneLedgerDays,
  readStatsMaps,
  type DayResult,
  type DayStart,
  type LedgerFile,
  type StatsMaps,
} from "./deviceStats";
import { WorkspacePrefsService } from "./services/workspacePrefsService";
import {
  UI_SLOT_SIDEBAR_COMMENTS,
  UI_SLOT_SIDEBAR_OUTLINE,
  UI_SLOT_SIDEBAR_SNAPSHOT,
} from "./uiSlots";

/** 「算不算正文」不再靠路径里的「正文草稿」字样，改用作品识别（见 isDailyCountFile）。 */

/** 两次在正文里动笔的间隔不超过它，整段算写作时长；超过算休息，整段不计。
 *  2026-10-20 由「停顿只算 30 秒」改为「10 分钟内整段计入」（SPEC-006）：
 *  思考、回看前文、查资料也是创作时间，只算手指在动的时间过于严苛。
 *  （2026-08-13 曾由 120s 收紧为 30s，理由是不让思考计入；作者已推翻这一口径。） */
const BREAK_GAP_MS = 10 * 60_000;

interface DailyHistory {
  [date: string]: number;
}

interface DailyPomodoro {
  count: number;
  words: number;
}

export default class WritingToolkitPlugin extends Plugin {
  settings!: WritingToolkitSettings;
  dailyHistory: DailyHistory = {};
  dailyDurationHistory: DailyHistory = {};
  /** 各作品（按正文草稿的上一级目录）的每日净增字数 */
  projectHistory: Record<string, DailyHistory> = {};
  /** 各作品的每日写作时长（10 分钟内的停顿整段计入，见 BREAK_GAP_MS） */
  projectDurationHistory: Record<string, DailyHistory> = {};
  /** 每日完成的番茄数与本番茄累计字数 */
  dailyPomodoroHistory: Record<string, DailyPomodoro> = {};
  /** 每日各文件的净增明细：出问题时能查出"这个数是哪个文件贡献的" */
  dailyFileDeltas: Record<string, DailyHistory> = {};
  /** 每日写下的字：手动输入的正增量累计（时速的分子），删除不抵减、粘贴不计 */
  dailyTypedHistory: DailyHistory = {};
  /**
   * 旧版存在 data.json 的章节定稿表（2026-10-22 起状态改存章节 frontmatter）。
   * 只读：启动后由定稿模块搬进 frontmatter，搬完置空，data.json 里随之删掉该键。
   */
  private legacyChapterStatus: Record<string, unknown> | null = null;
  /** 阶段 6：界面偏好 Service（主页 / 书架 / 编辑台的界面记忆）。 */
  private prefs!: WorkspacePrefsService;
  /** 阶段 6：统计读模型与状态栏更新广播。 */
  private stats!: StatsService;
  /** 阶段 6：页面导航与刷新扇出。 */
  private nav!: NavigationService;
  /** 状态栏订阅的解绑函数。 */
  private disposeStatusBarState: (() => void) | null = null;
  /** 各文件最近一次已知字数（键为文件路径） */
  fileBaselines: Record<string, number> = {};
  /** 上次建立基线档案的时间戳 */
  baselinesAt = 0;
  /** 上次已生效的章节识别设置（变化时让作品列表立即重建） */
  private lastDraftKeywords: string | null = null;
  private lastChapterExcludeNames: string | null = null;
  dailyTotal: number = 0;
  dailyDurationSeconds = 0;
  private lastDurationTotal = 0;
  private knownProjects = new Set<string>();
  private statusBar!: WritingStatusBar;
  private mobileStatusBar!: MobileStatusBar;
  private settingTab!: WritingToolkitSettingTab;
  private activeDay: string = "";
  private dailySaveTimer: TimerHandle | null = null;
  private typedSettleTimer: TimerHandle | null = null;
  private lastWritingActivityAt = 0;
  private previousTypewriterMode: boolean | null = null;
  private snapshotModule!: SnapshotModule;
  private snapshotUiModule!: SnapshotUiModule;
  /** 阶段 4：章纲存储、编辑弹窗、侧栏面板与伴随文件迁移。 */
  private outlineModule!: OutlineModule;
  /** 阶段 4：批注存储、装饰、文件事件、侧栏面板与管理操作。 */
  private commentsModule!: CommentsModule;
  /** 本机批注工具（给 Agent 用的 MCP）：开关、端口、口令与监听。 */
  private agentBridgeModule!: AgentBridgeModule;
  /** 阶段 4：计时器、番茄历史、自动快照与全部用户动作。 */
  private pomodoroModule!: PomodoroModule;
  /** 阶段 4：写作日历的数据绑定、设置热更新和实例生命周期。 */
  private calendarModule!: CalendarModule;
  private sidecarLocationModule!: SidecarLocationModule;
  /** 章节定稿锁：草稿 / 定稿状态、编辑器锁定与临时解锁。 */
  private chapterStatusModule!: ChapterStatusModule;
  private planBoardModule!: PlanBoardModule;
  private immersiveHintEl: HTMLElement | null = null;
  private hintHideTimer: TimerHandle | null = null;
  // 最近一次活动的文件信息：侧栏获得焦点时 workspace.getActiveFile() 会返回 null，
  // 这些字段让快照操作不依赖「当前焦点」。
  private lastEditor: Editor | null = null;
  private lastKnownPath: string | null = null;
  /** data.json 里读到的 pomodoroSession 原值：手机端不处理，写盘时原样带回。 */
  private loadedPomodoroSession: unknown = null;
  private lastKnownText: string | null = null;
  /** 外部修改（AI/脚本）处理队列：保证串行，避免异步竞态 */
  private externalModifyQueue: Promise<void> = Promise.resolve();
  /** 外部修改队列中尚未处理完的文件数 */
  private externalModifyPending = 0;
  private dayRolloverTimer: TimerHandle | null = null;
  /** 卸载标记：挂起的外部修改任务读到文件后直接返回，不操作已销毁对象 */
  private unloaded = false;
  /** 最近一次外部修改写入的内容：用于识别编辑器同步刷新触发的 editor-change */
  private lastExternalSyncText: string | null = null;
  /**
   * 跨设备分账（specs/cross-device-stats.md）：本机的统计写进
   * `_写作工具箱/统计/<设备ID>.json`，别的设备的只读、用来加总和认领同步来的版本。
   */
  private deviceId = "";
  private statsBook: DeviceStatsBook = new DeviceStatsBook("");
  /** 上次写盘的本机统计（不含 updatedAt）：内容没变就不写，免得同步工具来回传 */
  private lastLedgerJson = "";
  /** 上次写盘的 data.json：内容没变就不写（统计搬走后它只在改设置时才变） */
  private lastPersistedJson = "";
  /** 旧统计没能迁进 legacy.json 时先留在 data.json，下次启动再迁，不能丢 */
  private carryLegacyStats: StatsMaps | null = null;
  private othersReloadTimer: TimerHandle | null = null;
  /**
   * 今日净增 = 书稿现在的字数 − 今日起点（specs/cross-device-stats.md）。
   * bookCounts：各正文章节现在的字数（正在编辑的章节按编辑器里的文字）；
   * ownStarts / ownResults：本机记的起点与算出的结果，写进本机统计文件。
   */
  private bookCounts = new Map<string, number>();
  private bookCountsReady = false;
  private bookCountsToken = 0;
  private ownStarts: Record<string, DayStart> = {};
  private ownResults: Record<string, DayResult> = {};
  /** 待忽略统计的程序化编辑（快照恢复/应用），按编辑器和最终文本精确匹配。 */
  private pendingProgrammaticEdit: { editor: Editor; text: string } | null = null;
  /** 内部 Host：统一注册面与模块生命周期 */
  private host!: PluginHost;
  /** 阶段 5：UI Shell 的唯一宿主上下文（视图与手机状态条共用） */
  private uiShellContext!: UiShellContext;
  /** 阶段 4：打字机、光标位置与当前段落高亮。 */
  private typewriterModule!: TypewriterModule;
  /** 阶段 3 首个完整 Feature Module：中文标点辅助。 */
  private punctuationModule!: PunctuationModule;
  /** 阶段 4 首个编辑器功能模块：回车硬换行。 */
  private hardBreakModule!: HardBreakModule;
  /** 阶段 4：只允许文档末尾追加的海明威模式。 */
  private hemingwayModule!: HemingwayModule;
  /** 阶段 4：排版设置与配色主题。 */
  private typographyModule!: TypographyModule;
  /** 阶段 4：编辑工具条、生效范围与设置热更新。 */
  private formatToolbarModule!: FormatToolbarModule;
  /** 插件主实例的运行时事件与定时器作用域 */
  private eventScope!: EventScope;

  private createHost(): PluginHost {
    const diagnostics = new DefaultDiagnosticsService();
    const eventsLogger = {
      error: (...args: unknown[]) => {
        console.error(...args);
        const last = args[args.length - 1];
        diagnostics.recordError(
          "events",
          last instanceof Error
            ? last
            : new Error(args.map((value) => String(value)).join(" "))
        );
      },
    };
    const host = new PluginHost(this, {
      diagnostics,
      editor: new DefaultEditorService(this.app, this),
      events: new DefaultEventsService(this.app, eventsLogger),
      persistence: new DefaultPersistenceService(this),
      project: new ProjectIndexService(this.app, () => ({
        draftKeywords: this.settings.draftKeywords,
        chapterExcludeNames: this.settings.chapterExcludeNames,
        extraExcluded: [this.snapshotFolder()],
      })),
      settings: new DefaultSettingsService(),
      ui: new DefaultUiService(this.app, this),
      wordcount: new DefaultWordCountService(),
    });
    diagnostics.setLatest("vault:modify:pending", 0);
    return host;
  }

  /**
   * 阶段 5：构建 UI Shell 的宿主上下文。
   *
   * Shell 只依赖 `src/uiShellContext.ts` 里的窄接口；这里把已有的 Services、
   * 统计读模型、界面偏好和功能模块操作端口分组接进去。上下文在模块激活后创建，
   * 其中回调都是惰性的，视图真正显示时才读取最新状态。
   */
  private createUiShellContext(): UiShellContext {
    return {
      app: this.app,
      services: this.host.services,
      // 迁移期：SettingsService 持有的实时对象；Shell 改完字段后调用 actions.saveSettings()。
      settings: this.host.services.settings.get(),
      stats: {
        total: () => this.todayTotalsAllDevices().total,
        durationSeconds: () => this.todayTotalsAllDevices().durationSeconds,
        getTodayDurationSeconds: () => this.stats.getTodayDurationSeconds(),
        getTodayPomodoroSummary: () => this.stats.getTodayPomodoroSummary(),
        dailyForDisplay: () => this.stats.dailyForDisplay(),
        projectForDisplay: (key) => this.stats.projectForDisplay(key),
        getProjects: (keepKey) => this.stats.getProjects(keepKey),
        todaySpeed: () => this.stats.todaySpeed(),
        showDailyBreakdown: () => this.stats.showDailyBreakdown(),
        setWordCountMode: (mode) => this.setWordCountMode(mode),
      },
      prefs: this.prefs,
      nav: this.nav,
      recent: {
        path: () => this.getLastKnownFilePath(),
        text: () => this.getLastKnownText(),
        editor: () => this.getLastEditor(),
      },
      caps: {
        panels: {
          mountSnapshotPanels: (container) =>
            this.mountSnapshotPanels(container),
          mountOutlinePanels: (container) => this.mountOutlinePanels(container),
          mountCommentsPanels: (container) =>
            this.mountCommentsPanels(container),
        },
        outline: {
          load: (file) => this.loadOutline(file),
          save: (file, value) => this.saveOutline(file, value),
          has: (file) => this.hasOutline(file),
          subscribe: (listener) => this.subscribeOutlineChanges(listener),
        },
        snapshots: {
          list: (path) => this.listSnapshotEntries(path),
          openDiff: (path) => this.openSnapshotDiffFor(path),
        },
        comments: {
          panelModel: () => this.getCommentPanelModel(),
        },
        calendar: {
          create: (container, initialYear) =>
            this.createCalendar(container, initialYear),
        },
        chapterStatus: {
          isFinal: (path) => this.chapterStatusModule.operations.isFinal(path),
          setFinal: (path, final) =>
            this.chapterStatusModule.operations.setFinal(path, final),
          subscribe: (listener) =>
            this.chapterStatusModule.operations.subscribe(listener),
        },
        planBoard: this.planBoardModule.operations,
        pomodoro: {
          getPomodoroState: () => this.getPomodoroState(),
          getTodayPomodoroSummary: () => this.getTodayPomodoroSummary(),
          startPomodoro: () => this.startPomodoro(),
          stopPomodoro: () => this.stopPomodoro(),
          togglePomodoroPause: () => this.togglePomodoroPause(),
          skipPomodoroBreak: () => this.skipPomodoroBreak(),
        },
      },
      editorOptions: {
        setTypewriterMode: (on) => this.setTypewriterMode(on),
        setTypewriterOffset: (offset) => this.setTypewriterOffset(offset),
        setPunctuationAssist: (on) => this.setPunctuationAssist(on),
        setImmersiveMode: (on) => this.switchImmersiveMode(on),
        setParagraphHighlight: (on) => this.setParagraphHighlight(on),
        setHemingwayMode: (on) => this.switchHemingwayMode(on),
      },
      actions: {
        saveSettings: () => this.saveSettings(),
        revealPathInSystem: (path) => this.revealPathInSystem(path),
        updateStatusBarVisibility: () => this.updateStatusBarVisibility(),
        copyCleanChapter: (path) => this.copyCleanChapter(path),
        openPhonePreview: (path) => void this.openPhonePreview(path),
        countWords: (text, mode) => this.countWords(text, mode),
      },
    };
  }

  async onload() {
    // 自定义图标先注册，后面所有 setIcon / ribbon / 视图图标才认 wt-* 名字。
    registerWtIcons();
    this.host = this.createHost();
    this.eventScope = this.host.services.events.createScope(
      "writing-toolkit:main"
    );
    this.settings = this.host.services.settings.get();
    this.typographyModule = createTypographyModule();
    // 必须在第一个 await 之前同步执行：先套上上次的配色主题，避免首帧闪成暖纸
    this.typographyModule.applyCachedThemeTone();
    this.prefs = new WorkspacePrefsService({
      persistNow: () => void this.savePluginData(),
      schedulePersist: () => this.scheduleDailySave(),
      refreshHome: () => this.refreshHome(),
    });
    this.nav = new NavigationService({
      app: this.app,
      ui: this.host.services.ui,
      getSettings: () => this.settings,
      setWorkbenchProject: (root) => this.prefs.setWorkbenchProject(root),
    });
    this.stats = this.createStatsService();
    await this.loadPluginData();

    // Obsidian 手机端自动套用手机版布局；桌面端可用命令手动预览。
    applyPlatformMobileClass();
    // 手机端：把误开在中间编辑区的编辑台 / 工具箱挪回左右抽屉。
    this.eventScope.onLayoutReady(() => {
      if (Platform.isMobile) this.migrateMobileViewsToDrawers();
    });
    this.registerStartupReconcile();

    this.settingTab = new WritingToolkitSettingTab(this.app, this);
    this.host.addSettingTab(this.settingTab);

    this.statusBar = new WritingStatusBar(
      this.app,
      this.host.services.wordcount,
      () => this.host.addStatusBarItem(),
      this.stats.currentState(),
      () => void this.saveSettings(),
      {
        onStart: () => this.startPomodoro(),
        onTogglePause: () => this.togglePomodoroPause(),
        onSkipBreak: () => this.skipPomodoroBreak(),
        onStop: () => this.stopPomodoro(),
        onOpenOutline: () => this.activePomodoro()?.openLockedOutline(),
      }
    );
    this.disposeStatusBarState = this.stats.subscribe((state) =>
      this.statusBar.setState(state)
    );
    this.register(() => this.disposeStatusBarState?.());
    this.statusBar.loadBaselines(this.fileBaselines);
    this.statusBar.baselineListener = (path, words) => {
      if (words === null) delete this.fileBaselines[path];
      else this.fileBaselines[path] = words;
      this.scheduleDailySave();
    };
    this.statusBar.baselineSeedListener = () => {
      statsDiag.baselineSeeded++;
      this.host.services.diagnostics.increment("baseline:seeded");
    };
    this.statusBar.baselineMigrateListener = () => {
      statsDiag.baselineMigrated++;
      this.host.services.diagnostics.increment("baseline:migrated");
    };
    this.statusBar.baselineDropListener = () => {
      statsDiag.baselineDropped++;
      this.host.services.diagnostics.increment("baseline:dropped");
    };
    // 记下本次建立基线档案的时刻：之后新建的文件才按「整份内容」计入当天
    const previousScan = this.baselinesAt;
    this.baselinesAt = Date.now();
    this.scheduleDailySave();
    void this.scanNewFilesOnLoad(previousScan);

    this.snapshotModule = createSnapshotModule({
      getActiveFilePath: () => this.lastKnownPath,
      getActiveText: () => this.lastKnownText,
    });
    this.snapshotUiModule = createSnapshotUiModule({
      core: this.snapshotModule,
      getEditor: () => this.lastEditor,
      getActiveFilePath: () => this.lastKnownPath,
      getActiveText: () => this.lastKnownText,
      isEditorValid: (editor) => this.isEditorValid(editor),
      markProgrammaticEdit: (editor, text) =>
        this.markProgrammaticEdit(editor, text),
    });
    this.outlineModule = createOutlineModule({
      getRecentMarkdownPath: () => this.lastKnownPath,
    });
    // 跨天兜底：即使一直没有输入/切换，也刷新状态栏与侧栏到新的一天
    this.dayRolloverTimer = this.eventScope.setInterval(() => {
      if (this.todayStr !== this.activeDay) {
        this.ensureCurrentDay();
        this.stats.publish();
        this.refreshSidebar();
      }
    }, 60_000);

    this.immersiveHintEl = document.body.createDiv({
      cls: "wt-immersive-hint",
      text: "按 Esc 退出沉浸模式",
    });

    this.typewriterModule = createTypewriterModule();
    this.punctuationModule = createPunctuationModule();
    this.hardBreakModule = createHardBreakModule();
    this.hemingwayModule = createHemingwayModule();
    this.formatToolbarModule = createFormatToolbarModule({
      onAddComment: (view) =>
        this.commentsModule.operations.addCommentForView(view),
      isMobile: () => this.commentsOffOnThisDevice(),
    });
    this.commentsModule = this.buildCommentsModule();
    this.agentBridgeModule = this.buildAgentBridgeModule();
    this.sidecarLocationModule = createSidecarLocationModule();
    this.pomodoroModule = this.buildPomodoroModule();
    this.calendarModule = createCalendarModule({
      allWords: () => this.dailyForDisplay(),
      allDuration: () =>
        this.statsBook.mergeDaily("dailyDurationHistory", {
          ...this.dailyDurationHistory,
          ...(this.activeDay ? { [this.activeDay]: this.dailyDurationSeconds } : {}),
        }),
      projectWords: (key) => this.projectForDisplay(key),
      projectDuration: (key) =>
        this.statsBook.mergeProjectDuration(this.projectDurationHistory)[key] || {},
    });
    this.chapterStatusModule = this.buildChapterStatusModule();
    this.planBoardModule = createPlanBoardModule();
    await this.host.activateModules([
      this.typographyModule,
      this.typewriterModule,
      this.punctuationModule,
      this.hardBreakModule,
      this.hemingwayModule,
      this.formatToolbarModule,
      this.commentsModule,
      this.agentBridgeModule,
      this.snapshotModule,
      this.snapshotUiModule,
      this.outlineModule,
      this.pomodoroModule,
      this.calendarModule,
      this.chapterStatusModule,
      this.planBoardModule,
      this.sidecarLocationModule,
    ]);

    // 阶段 5：模块就绪后再构建 Shell 上下文；视图创建时只依赖这个上下文。
    this.uiShellContext = this.createUiShellContext();

    this.host.registerView(
      WRITING_TOOLKIT_SIDEBAR,
      (leaf) => new WritingToolkitSidebar(leaf, this.uiShellContext)
    );
    this.host.registerView(
      WRITING_TOOLKIT_WORKBENCH,
      (leaf) => new WritingToolkitWorkbench(leaf, this.uiShellContext)
    );
    this.host.registerView(
      WRITING_TOOLKIT_HOME,
      (leaf) => new WritingToolkitHome(leaf, this.uiShellContext)
    );
    this.setHemingwayMode(this.settings.hemingwayMode);
    this.setImmersiveMode(this.settings.immersiveMode);
    this.updateStatusBarVisibility();

    // 手机端屏幕底部的常驻状态条（桌面端 CSS 隐藏，不挂也没关系）。
    this.mobileStatusBar = new MobileStatusBar(
      this.uiShellContext,
      this.host.services.events.createScope("writing-toolkit:mobile-status-bar")
    );
    this.mobileStatusBar.mount();

    this.registerCommands();



    this.registerCommentInteractions();


    this.registerWorkspaceEvents();

    this.eventScope.onDom(document, "selectionchange", () => {
      this.statusBar.setSelectionText(this.getActiveEditorSelection());
    });

    this.registerEditorChangeTracking();


    this.registerVaultEvents();


    this.restoreInitialDocument();
  }

  /**
   * 产品硬约束：Command + P 永远只有三个主页面与设置页四个入口。
   * 其余功能留在侧栏、右键菜单、设置页或编辑工具条里。
   * `check-commandsurface.js` 固定这份白名单，不能在其他地方补注册命令。
   *
   * 2026-10-16 从 onload 里**原样搬出来**的：onload 原来 478 行、什么都干，
   * 拆开后每个注册面各归一处；调用位置与顺序保持不变，初始化时序不受影响。
   */
  private registerCommands(): void {
  this.host.addCommand({
    id: "open-workbench-home",
    name: "打开主页",
    callback: () => void this.openHome(),
  });

  this.host.addCommand({
    id: "open-sidebar",
    name: "打开工具箱",
    callback: () => void this.openSidebar(),
  });

  this.host.addCommand({
    id: "open-writing-workbench",
    name: "打开编辑台",
    callback: () => void this.openWorkbench(),
  });

  this.host.addCommand({
    id: "open-settings",
    name: "打开设置",
    callback: () => this.openSettings(),
  });

  this.host.addRibbonIcon("wt-toolbox", "打开工具箱", () => {
    void this.openSidebar();
  });

  this.host.addRibbonIcon("wt-editor", "打开编辑台", () => {
    void this.openWorkbench();
  });

  this.host.addRibbonIcon("wt-home", "打开主页", () => {
    void this.openHome();
  });
  }

  /**
   * 长按吞掉 click、Esc 退出沉浸。
   *
   * 2026-10-16 从 onload 里**原样搬出来**的：onload 原来 478 行、什么都干，
   * 拆开后每个注册面各归一处；调用位置与顺序保持不变，初始化时序不受影响。
   */
  private registerCommentInteractions(): void {
  // 长按出菜单后吞掉紧随其后的 click；由事件作用域统一撤销。
  this.eventScope.onDom(document, "click", handleSuppressedClick, true);
  this.eventScope.onDom(document, "keydown", (event: KeyboardEvent) => {
    // 锁定中短按 Esc 不退出；长按的紧急出口由番茄钟模块处理。
    if (event.key === "Escape" && this.settings.immersiveMode && !this.isPomodoroLocked()) {
      this.switchImmersiveMode(false);
      this.refreshImmersiveControls();
      void this.saveSettings();
    }
  });
  }

  /**
   * 文件切换 / 选中变化 / 编辑输入。
   *
   * 2026-10-16 从 onload 里**原样搬出来**的：onload 原来 478 行、什么都干，
   * 拆开后每个注册面各归一处；调用位置与顺序保持不变，初始化时序不受影响。
   */
  private registerWorkspaceEvents(): void {
  this.eventScope.onWorkspace("active-leaf-change", () => {
      this.ensureCurrentDay();
      // 切换文件不打断写作计时：切去设定 / 资料再回来，这段也算写作时长。
      const file = this.app.workspace.getActiveFile();
      const text = this.getActiveEditorText();
      if (file && text !== null) {
        this.lastKnownPath = file.path;
        this.lastKnownText = text;
        this.lastEditor = this.getActiveEditor();
        // 每次编辑已在 handleEditorChange 中结算；切文件只重设基线，
        // 不再依赖 active-leaf-change 与 editor-change 的先后顺序。
        this.activePomodoro()?.rebaseBaseCount();
        this.statusBar.onFileChange(file.path, text);
        this.statusBar.setSelectionText(this.getActiveEditorSelection());
        this.stats.publish();
      }
    });
  }

  /**
   * 库文件增删改：批注缓存、基线、作品索引、章纲。
   *
   * 2026-10-16 从 onload 里**原样搬出来**的：onload 原来 478 行、什么都干，
   * 拆开后每个注册面各归一处；调用位置与顺序保持不变，初始化时序不受影响。
   */
  private registerVaultEvents(): void {
  this.eventScope.onVault("modify", (file) => {
      if (!(file instanceof TFile)) return;
      if (this.isOtherLedgerPath(file.path)) {
        this.scheduleReloadOthers();
        return;
      }
      this.handleVaultModify(file);
    });

  // 外部工具新建的章节文件：Obsidian 有时只发 create 不发 modify
  this.eventScope.onVault("create", (file) => {
      if (this.isOtherLedgerPath(file.path)) {
        this.scheduleReloadOthers();
        return;
      }
      this.invalidateProjectIndex();
      if (file instanceof TFile) {
        this.handleVaultModify(file);
      }
    });

  // 源文件/文件夹重命名或移动时，同步迁移所有按路径记录的状态：
  // 快照镜像、项目统计 key、活动文件引用、字数基线
  this.eventScope.onVault("rename", (file, oldPath) => {
      this.invalidateProjectIndex();
      if (file instanceof TFile) {
        if (this.lastKnownPath === oldPath) this.lastKnownPath = file.path;
        this.statusBar.onFileRename(oldPath, file.path);
        this.migrateBaselineKey(oldPath, file.path);
        // 书稿字数：旧路径不再算；新路径还算正文的话按新路径记
        this.dropBookCount(oldPath);
        if (this.isDailyCountFile(file.path)) {
          void this.app.vault.cachedRead(file).then((text) => {
            if (!this.unloaded) this.updateBookCount(file.path, this.countWords(text));
          });
        }
        this.migrateCoverPaths(oldPath, file.path);
      } else if (file instanceof TFolder) {
        this.migrateProjectKeysOnRename(file.path, oldPath);
        void this.rebuildBookCounts();
        this.migrateCoverPaths(oldPath, file.path);
        this.migrateBaselinePrefix(oldPath, file.path);
      }
    });

  // 文件删掉后旧基线一起清掉，避免同路径重建时拿旧数字做差
  this.eventScope.onVault("delete", (file) => {
      if (this.isOtherLedgerPath(file.path)) {
        this.scheduleReloadOthers();
        return;
      }
      this.invalidateProjectIndex();
      if (file instanceof TFile) {
        this.statusBar.dropBaseline(file.path);
        this.dropBookCount(file.path);
      } else if (file instanceof TFolder) {
        this.migrateBaselinePrefix(file.path, null);
        this.dropProjectKeys(file.path);
        void this.rebuildBookCounts();
      }
    });
  }

  /**
   * 把最先打开的文件记成当前文档，状态栏立刻有数。
   *
   * 2026-10-16 从 onload 里**原样搬出来**的：onload 原来 478 行、什么都干，
   * 拆开后每个注册面各归一处；调用位置与顺序保持不变，初始化时序不受影响。
   */
  private restoreInitialDocument(): void {
  const initialFile = this.app.workspace.getActiveFile();
  if (initialFile) {
    const text = this.getActiveEditorText();
    if (text !== null) {
      this.lastKnownPath = initialFile.path;
      this.lastKnownText = text;
      this.lastEditor = this.getActiveEditor();
      this.statusBar.onFileChange(initialFile.path, text);
      this.statusBar.setSelectionText(this.getActiveEditorSelection());
      this.stats.publish();
    }
  }
  }

  onunload() {
    this.unloaded = true;
    this.host?.dispose();
    // 面板销毁会同步把最后一笔 dirty 章纲塞进模块队列；卸载体只能异步等它，
    // 但至少要在这里显式消费并记录错误，不能让 Promise 悬空。
    try {
      void this.outlineModule?.operations.flush().catch((error) => {
        console.error("写作工具箱：卸载时刷新章纲写盘队列失败", error);
      });
    } catch {
      // 章纲模块可能因启动失败而没有公开 operations。
    }
    try {
      void this.commentsModule?.operations.flush().catch((error) => {
        console.error("写作工具箱：卸载时刷新批注写盘队列失败", error);
      });
    } catch {
      // 批注模块可能因启动失败而没有公开 operations。
    }
    this.immersiveHintEl?.remove();
    this.statusBar?.destroy();
    this.mobileStatusBar?.destroy();
    document.body.classList.remove("wt-status-only-immersive");
    void this.savePluginData();
  }

  setTypewriterMode(on: boolean) {
    this.typewriterModule?.setEnabled(on);
  }

  setTypewriterOffset(offset: number) {
    this.typewriterModule?.setOffset(offset);
  }

  setPunctuationAssist(on: boolean) {
    this.punctuationModule?.setEnabled(on);
  }

  setHardBreakOnEnter(on: boolean) {
    this.hardBreakModule?.setEnabled(on);
  }

  setHemingwayMode(on: boolean) {
    this.hemingwayModule?.setEnabled(on);
  }

  /**
   * 用户切换海明威模式：开启时一并进入沉浸模式，关闭时一并退出。
   * 只用于用户操作；onload 按存盘值分别恢复，不走联动。
   */
  private switchHemingwayMode(on: boolean): void {
    if (this.rejectWhileLocked()) return;
    this.settings.hemingwayMode = on;
    this.setHemingwayMode(on);
    if (this.settings.immersiveMode === on) return;
    this.settings.immersiveMode = on;
    this.setImmersiveMode(on);
    this.refreshImmersiveControls();
  }

  /** 用户切换沉浸模式：退出时一并关闭海明威模式（侧栏开关与 Esc 共用）。 */
  private switchImmersiveMode(on: boolean): void {
    if (this.rejectWhileLocked()) return;
    this.settings.immersiveMode = on;
    this.setImmersiveMode(on);
    if (on || !this.settings.hemingwayMode) return;
    this.settings.hemingwayMode = false;
    this.setHemingwayMode(false);
    this.refreshImmersiveControls();
  }

  private activePomodoro(): PomodoroOperations | null {
    try {
      return this.pomodoroModule?.operations ?? null;
    } catch {
      return null;
    }
  }

  /** 侧栏「开启番茄钟」按钮与命令共用入口；桌面端先选锁定方式。 */
  startPomodoro(): void {
    const pomodoro = this.activePomodoro();
    if (!pomodoro) {
      new Notice("番茄钟模块未启动，请重载插件后重试");
      return;
    }
    pomodoro.requestStart();
  }

  /** 番茄钟锁定中（SPEC-007）：沉浸 / 海明威开关、短按 Esc、番茄设置都不生效。 */
  isPomodoroLocked(): boolean {
    return this.activePomodoro()?.isLocked() ?? false;
  }

  /** 锁定中拒绝切换模式：侧栏开关已先改了设置对象，按锁定方式套回去。 */
  private rejectWhileLocked(): boolean {
    if (!this.isPomodoroLocked()) return false;
    this.activePomodoro()?.reassertLock();
    new Notice(LOCKED_NOTICE);
    return true;
  }

  private buildChapterStatusModule(): ChapterStatusModule {
    return createChapterStatusModule({
      legacyFinals: () => this.legacyChapterStatus,
      clearLegacy: () => {
        if (!this.legacyChapterStatus) return;
        this.legacyChapterStatus = null;
        void this.savePluginData();
      },
    });
  }

  private buildPomodoroModule(): PomodoroModule {
    return createPomodoroModule({
      getWordCount: () => this.getPomodoroCount(),
      getTodayKey: () => this.todayStr,
      getHistory: () => this.dailyPomodoroHistory,
      onHistoryChanged: () => {
        this.scheduleDailySave();
        this.refreshSidebar();
      },
      onStateChange: (state) => this.handlePomodoroState(state),
      saveSnapshot: () => this.snapshotModule.operations.saveSnapshotNow(false),
      supportsLock: () => !Platform.isMobile,
      loadSession: () => parsePomodoroSession(this.loadedPomodoroSession),
      requestSave: () => this.scheduleDailySave(),
      lockEnv: createPomodoroLockEnv(this.app, {
        recentMarkdownPath: () => this.lastKnownPath,
        getModes: () => ({
          immersive: this.settings.immersiveMode,
          hemingway: this.settings.hemingwayMode,
        }),
        applyModes: (modes) => this.applyFocusModes(modes),
        openOutline: (file) => this.outlineModule.operations.openEditor(file),
      }),
    });
  }

  /** 番茄钟锁定 / 解锁时直接设定两个开关（不走用户切换的联动）。 */
  private applyFocusModes(modes: FocusModes): void {
    if (this.settings.hemingwayMode !== modes.hemingway) {
      this.settings.hemingwayMode = modes.hemingway;
      this.setHemingwayMode(modes.hemingway);
    }
    if (this.settings.immersiveMode !== modes.immersive) {
      this.settings.immersiveMode = modes.immersive;
      this.setImmersiveMode(modes.immersive);
    }
    if (this.isPomodoroLocked()) this.showImmersiveHint();
    this.refreshImmersiveControls();
    void this.saveSettings();
  }

  /** 结束番茄钟：侧栏按钮与命令共用入口。 */
  stopPomodoro(): void {
    this.activePomodoro()?.stop();
  }

  /** 暂停/继续番茄钟：状态栏菜单与命令共用入口。 */
  togglePomodoroPause(): void {
    this.activePomodoro()?.togglePause();
  }

  /** 跳过休息：状态栏菜单与命令共用入口。 */
  skipPomodoroBreak(): void {
    this.activePomodoro()?.skipBreak();
  }

  getPomodoroPhase(): PomodoroPhase {
    return this.activePomodoro()?.getPhase() ?? "idle";
  }

  getPomodoroState(): PomodoroState {
    const state = this.activePomodoro()?.getState();
    if (state) return state;
    const totalMs = this.settings.pomodoroFocusMinutes * 60000;
    return {
      phase: "idle",
      totalMs,
      remainingMs: totalMs,
      words: 0,
      paused: false,
    };
  }

  updateSidebarPomodoro(state: PomodoroState): void {
    for (const leaf of this.host.services.ui.leaves(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as WritingToolkitSidebar).updatePomodoro?.(state);
    }
  }

  private handlePomodoroState(state: PomodoroState): void {
    this.statusBar.setPomodoro(state);
    this.updateSidebarPomodoro(state);
  }

  private getPomodoroCount(): number {
    // 用 lastKnownText：从侧栏/状态栏启动番茄时活动编辑器可能为 null，
    // 用焦点无关的最近文档内容做基线，避免把整个章节字数当成番茄增量。
    const text = this.lastKnownText ?? this.getActiveEditorText();
    return text ? this.countWords(text) : 0;
  }

  /** 今日番茄汇总：供侧栏番茄钟卡片显示。 */
  getTodayPomodoroSummary(): { count: number; words: number } | null {
    return this.stats.getTodayPomodoroSummary();
  }

  /** 设置里切换「手机端常驻状态条」后立即生效。 */
  refreshMobileStatusBar(): void {
    this.mobileStatusBar?.syncVisibility();
  }

  setWordCountMode(mode: WordCountMode) {
    this.settings.wordCountMode = mode;
    // 先同步状态栏模式，再重建基线；否则 rebaseCurrentDocument 会按旧模式计数。
    this.stats.publish();
    // 清空所有文件基线：其余文件的基线仍是旧统计模式的计数，
    // 不清空会让后续 delta 变成「新模式计数 − 旧模式基线」的巨大误差。
    this.statusBar.resetBaselines();
    // 基线清空后要重置「建档时刻」，否则今天新建的章节会被当成新文件再算一次
    this.baselinesAt = Date.now();
    this.scheduleDailySave();
    // 番茄专注中：同步重设番茄基线，避免本番茄字数被新模式计数污染
    this.activePomodoro()?.rebaseBaseCount();
    const text = this.getActiveEditorText();
    if (text !== null) {
      this.statusBar.rebaseCurrentDocument(text);
      this.statusBar.setSelectionText(this.getActiveEditorSelection());
    }
  }

  setImmersiveMode(on: boolean): void {
    if (on && this.previousTypewriterMode === null) {
      this.previousTypewriterMode = this.settings.typewriterMode;
      if (!this.settings.typewriterMode) {
        this.settings.typewriterMode = true;
        this.setTypewriterMode(true);
      }
    }
    if (!on && this.previousTypewriterMode !== null) {
      const shouldRestore = this.previousTypewriterMode;
      this.previousTypewriterMode = null;
      if (this.settings.typewriterMode !== shouldRestore) {
        this.settings.typewriterMode = shouldRestore;
        this.setTypewriterMode(shouldRestore);
      }
    }
    document.body.classList.toggle("wt-immersive", on);
    if (on) {
      this.showImmersiveHint();
    } else {
      this.immersiveHintEl?.removeClass("is-visible");
    }
    this.setParagraphHighlight(this.settings.immersiveParagraphHighlight);
  }

  /** 进入沉浸模式时的退出提示：几秒后淡出。 */
  private showImmersiveHint(): void {
    if (!this.immersiveHintEl) return;
    this.immersiveHintEl.setText(
      this.isPomodoroLocked() ? "锁定中 · 长按 Esc 紧急退出" : "按 Esc 退出沉浸模式"
    );
    this.immersiveHintEl.addClass("is-visible");
    this.hintHideTimer?.dispose();
    this.hintHideTimer = this.eventScope.setTimeout(() => {
      this.immersiveHintEl?.removeClass("is-visible");
    }, 4000);
  }

  setParagraphHighlight(on: boolean): void {
    this.typewriterModule?.setParagraphHighlight(on);
  }

  updateStatusBarVisibility(): void {
    const onlyImmersive = this.settings.statusBarOnlyImmersive ?? true;
    document.body.classList.toggle("wt-status-only-immersive", onlyImmersive);
  }

  private refreshImmersiveControls(): void {
    this.settingTab.display();
    for (const leaf of this.host.services.ui.leaves(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as WritingToolkitSidebar).refreshSettings();
    }
  }

  /**
   * 迁移期兼容入口：现有 UI 仍持有插件对象，统一从这里进入 WordCount Service。
   * 新 Feature Module 应直接使用 Host Context 的 services.wordcount。
   */
  countWords(
    text: string,
    mode: WordCountMode = this.settings.wordCountMode
  ): number {
    return this.host.services.wordcount.count(text, mode);
  }

  async openSidebar(): Promise<void> {
    await this.nav.openSidebar();
  }

  /** 手机端启动时的一次自愈：把开在中间编辑区的视图挪回对应抽屉。 */
  private migrateMobileViewsToDrawers(): void {
    this.nav.migrateMobileViewsToDrawers();
  }


  /** 直接打开本插件的设置页（设置窗口 → 左侧列表要滚到底才能点到，太绕）。 */
  private openSettings(): void {
    this.nav.openSettings(this.manifest.id);
  }

  // ---------- 编辑台 ----------

  /** 打开「编辑台」：默认开在左侧栏（正文与章节列表并排）。 */
  async openWorkbench(): Promise<void> {
    await this.nav.openWorkbench();
  }

  /** 打开「主页」：中间主区里的内嵌小软件（书库 / 数据统计 / 资料库）。 */
  async openHome(): Promise<void> {
    await this.nav.openHome();
  }

  /** 主页：上次停留的页面。 */
  getHomePage(): HomePage {
    return this.prefs.getHomePage();
  }

  setHomePage(page: HomePage): void {
    this.prefs.setHomePage(page);
  }

  /** 书架：某个作品的自定义封面（仓库内图片路径）；没有返回 null。 */
  getProjectCover(root: string): string | null {
    return this.prefs.getProjectCover(root);
  }

  setProjectCover(root: string, path: string | null): void {
    this.prefs.setProjectCover(root, path);
  }

  getLibraryView(): LibraryView {
    return this.prefs.getLibraryView();
  }

  setLibraryView(view: LibraryView): void {
    this.prefs.setLibraryView(view);
  }

  /** 主页书桌用：今日写作时长（秒）。 */
  getTodayDurationSeconds(): number {
    return this.stats.getTodayDurationSeconds();
  }

  /** 主页（书库 / 资料库）整体刷新。 */
  refreshHome(): void {
    this.nav.refreshHome();
  }

  /** 编辑台：全部重建（切作品、建作品后调用）。 */
  refreshWorkbenches(): void {
    this.nav.refreshWorkbenches();
  }

  /** 新建作品：统一位置建目录，建完把工作台切到新作品。 */
  openNewProjectDialog(): void {
    this.nav.openNewProjectDialog();
  }

  /** 工作台轻量刷新：编辑器每次输入都会调用。 */
  refreshWorkbench(): void {
    this.nav.refreshWorkbench();
  }

  /** 工作台：当前作品根目录（重启后恢复用）。 */
  getWorkbenchProject(): string | null {
    return this.prefs.getWorkbenchProject();
  }

  setWorkbenchProject(root: string): void {
    this.prefs.setWorkbenchProject(root);
  }

  /** 工作台：正文 / 资料 视图模式。 */
  getWorkbenchMode(): WorkbenchMode {
    return this.prefs.getWorkbenchMode();
  }

  setWorkbenchMode(mode: WorkbenchMode): void {
    this.prefs.setWorkbenchMode(mode);
  }

  /** 工作台：某个作品的连载状态；未标注返回 null。 */
  getWorkbenchStatus(root: string): WorkbenchStatus | null {
    return this.prefs.getWorkbenchStatus(root);
  }

  setWorkbenchStatus(root: string, status: WorkbenchStatus | null): void {
    this.prefs.setWorkbenchStatus(root, status);
  }

  /** 工作台：某个作品是否在切换面板里被隐藏。 */
  isProjectHidden(root: string): boolean {
    return this.prefs.isProjectHidden(root);
  }

  setProjectHidden(root: string, hidden: boolean): void {
    this.prefs.setProjectHidden(root, hidden);
  }

  /** 侧栏只提供快照面板的挂载容器，具体实现由 snapshots.ui 注册。 */
  mountSnapshotPanels(container: HTMLElement): UiPanelGroup {
    return this.host.services.ui.mountPanels(
      UI_SLOT_SIDEBAR_SNAPSHOT,
      container
    );
  }

  /** 侧栏只提供章纲面板的挂载容器，具体实现由 outlines 注册。 */
  mountOutlinePanels(container: HTMLElement): UiPanelGroup {
    return this.host.services.ui.mountPanels(
      UI_SLOT_SIDEBAR_OUTLINE,
      container
    );
  }

  /** 侧栏只提供批注面板的挂载容器，具体实现由 comments 注册。 */
  mountCommentsPanels(container: HTMLElement): UiPanelGroup {
    return this.host.services.ui.mountPanels(
      UI_SLOT_SIDEBAR_COMMENTS,
      container
    );
  }

  /** 编辑台等 UI Shell 通过窄端口读写章纲，不再直接依赖 outlineText 存储实现。 */
  async loadOutline(file: TFile): Promise<OutlineLoadResult> {
    return this.outlineModule.operations.load(file);
  }

  async saveOutline(file: TFile, value: string): Promise<void> {
    await this.outlineModule.operations.save(file, value);
  }

  async hasOutline(file: TFile): Promise<boolean> {
    return this.outlineModule.operations.has(file);
  }

  subscribeOutlineChanges(
    listener: (change: OutlineChange) => void
  ): () => void {
    return this.outlineModule.operations.subscribe(listener);
  }

  /** 工作台：某个文件的快照列表。 */
  async listSnapshotEntries(path: string): Promise<SnapshotEntry[]> {
    return this.snapshotUiModule.listSnapshots(path);
  }

  /** 工作台：打开指定文件最近快照的对比窗口。 */
  async openSnapshotDiffFor(path: string): Promise<void> {
    await this.snapshotUiModule.openLatestDiff(path);
  }

  /** 在系统文件管理器中显示某个库内路径。 */
  revealPathInSystem(path: string): void {
    try {
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) {
        new Notice("无法在系统文件管理器中显示");
        return;
      }
      const full = adapter.getFullPath(path);
      const { shell } = getElectron();
      shell.showItemInFolder(full);
    } catch {
      new Notice("无法在系统文件管理器中显示");
    }
  }

  private refreshSidebar(text?: string): void {
    for (const leaf of this.host.services.ui.leaves(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as WritingToolkitSidebar).refresh(text);
    }
    this.refreshWorkbench();
    for (const leaf of this.host.services.ui.leaves(WRITING_TOOLKIT_HOME)) {
      (leaf.view as WritingToolkitHome).refreshLive?.();
    }
  }

  /** 最近一次活动文件的路径（侧栏聚焦时仍可用）。 */
  getLastKnownFilePath(): string | null {
    return this.lastKnownPath;
  }

  /** 最近一次活动文件的内容（侧栏聚焦时仍可用）。 */
  getLastKnownText(): string | null {
    return this.lastKnownText;
  }

  /** 最近一次活动文件的编辑器引用（侧栏聚焦时仍可用）。 */
  getLastEditor(): Editor | null {
    return this.lastEditor;
  }

  /** 标记下一次指定编辑器的指定内容变化不计入写作统计。 */
  markProgrammaticEdit(editor: Editor, text: string): void {
    this.pendingProgrammaticEdit = { editor, text };
  }

  private getActiveEditor(): Editor | null {
    return this.host.services.editor.getActiveEditor();
  }

  /** 校验编辑器引用是否仍挂在工作区（文件关闭后 lastEditor 会失效）。 */
  isEditorValid(editor: Editor): boolean {
    return this.host.services.editor.isEditorValid(editor);
  }

  private getActiveEditorText(): string | null {
    return this.host.services.editor.getActiveEditorText();
  }

  private getActiveEditorSelection(): string {
    return this.host.services.editor.getActiveEditorSelection();
  }

  /**
   * 编辑器变化统计：editor-change 事件 + 记录「这次变化是不是作者改的」的编辑器扩展
   * （打开着的章节被同步工具改写时，编辑器重载的变化不能算作者写的，见 editorOrigin.ts）。
   */
  private registerEditorChangeTracking(): void {
    this.host.registerEditorExtension(buildEditorOriginTracker());
    this.eventScope.onWorkspace("editor-change", () => {
      this.handleEditorChange();
    });
  }

  private handleEditorChange(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    const text = this.getActiveEditorText();
    if (text === null) return;

    const editor = this.getActiveEditor();
    const composing =
      this.host.services.editor.getViewForEditor(editor)?.composing ?? false;
    const pending = this.pendingProgrammaticEdit;
    const isProgrammatic =
      pending !== null && pending.editor === editor && pending.text === text;
    if (pending !== null) this.pendingProgrammaticEdit = null;

    // 外部同步刷新：AI 修改后 Obsidian 刷新编辑器内容触发的 editor-change，
    // 字数已在 processVaultModify 统计过，且不应计入用户写作时长。
    const isExternalSync = this.lastExternalSyncText === text;
    if (isExternalSync) this.lastExternalSyncText = null;
    // 这次变化不是作者改的（Obsidian 把磁盘上的新内容重载进编辑器：同步工具、
    // 外部工具改写了打开着的章节）。不算写下的字、不计时长。
    const view = this.host.services.editor.getViewForEditor(editor);
    const fromDisk =
      !isProgrammatic && !isExternalSync && !!view && isNonAuthorDoc(view.state.doc);
    // 诊断计数（内部字数统计诊断报告用）
    statsDiag.editorChanges++;
    if (isProgrammatic) statsDiag.programmaticIgnored++;
    if (isExternalSync) statsDiag.externalSyncIgnored++;

    const previousPath = this.lastKnownPath;
    this.lastKnownPath = file.path;
    this.lastKnownText = text;
    this.lastEditor = editor;
    if (!isProgrammatic && !isExternalSync && previousPath === file.path) {
      // 重载进来的变化不是这个番茄写的：跟上基数，不算进本番茄字数
      if (fromDisk) this.activePomodoro()?.rebaseBaseCount();
      else this.activePomodoro()?.captureCurrentWords();
    }
    this.ensureCurrentDay();
    // 插件刚加载、编辑器还没就绪时（没触发过 active-leaf-change），状态栏并不知道
    // "当前是哪个文件"。先补建一次基线再算增量，否则会拿别的文档的基线做差。
    if (!this.statusBar.hasCurrentFile()) {
      this.statusBar.onFileChange(file.path, text);
    }
    // 全新文件的第一笔内容（粘贴整章、AI 通过编辑器写入）整份算新增。
    // 今天新建的文件即使走程序化写入也要跟踪，否则只记删除、不记新增，
    // 会出现「今天才建的第 2 章，今日净增却是负数」的假数据。
    const dailyFile = this.isDailyCountFile(file.path);
    const programmaticNewFile =
      isProgrammatic &&
      dailyFile &&
      this.isCreatedToday(file);
    const freshFile =
      !isProgrammatic &&
      !this.statusBar.hasBaseline(file.path) &&
      this.isFreshlyCreated(file);
    let delta: number;
    let typed = 0;
    if (isProgrammatic) {
      if (programmaticNewFile) {
        const target = this.countWords(text);
        const already =
          this.dailyFileDeltas[this.todayStr]?.[file.path] ?? 0;
        delta = target - already;
      } else {
        delta = 0;
      }
      this.statusBar.rebaseCurrentDocument(text);
    } else {
      ({ delta, typed } = this.statusBar.onEditorChange(
        text,
        freshFile,
        !isExternalSync && !fromDisk && dailyFile,
        composing
      ));
    }
    this.statusBar.setSelectionText(this.getActiveEditorSelection());

    // 今日净增按书稿字数算：这一章现在的字数以编辑器里的文字为准
    if (dailyFile) this.updateBookCount(file.path, this.countWords(text));

    if (dailyFile) {
      if (isProgrammatic && !programmaticNewFile) {
        this.activePomodoro()?.rebaseBaseCount();
      } else {
        if (typed > 0) this.recordTyped(typed);
        if (composing && !isExternalSync && !isProgrammatic) {
          this.scheduleTypedSettle(file.path);
        }
        this.applyDailyStats(
          file,
          delta,
          !isExternalSync && !isProgrammatic && !fromDisk
        );
      }
    } else {
      // 在非正文（设定、大纲等）里打字不计时，但也不打断正文的写作计时。
      statsDiag.skippedNotChapter++;
    }

    const tStatus = performance.now();
    this.stats.publish();
    const statusRefreshMs = performance.now() - tStatus;
    recordStatusRefresh(statusRefreshMs);
    this.host.services.diagnostics.recordTiming(
      "statusbar:refresh",
      statusRefreshMs
    );
    this.refreshSidebar(text);
  }

  /**
   * 外部修改统计：AI 代理、脚本等直接改写文件时，
   * Obsidian 只触发 vault 的 modify 事件，不触发编辑器输入。
   * 这里按文件基线累计每日净增字数（不计入用户写作时长）。
   */
  private handleVaultModify(file: TFile): void {
    if (!file.extension || file.extension.toLowerCase() !== "md") return;
    if (!this.isDailyCountFile(file.path)) {
      statsDiag.skippedNotChapter++;
      return;
    }
    statsDiag.vaultModifies++;
    this.host.services.diagnostics.increment("vault:modify");
    // 串行处理：AI 连续多次写入时，避免多个异步读盘交错导致漏计或基线倒退
    this.externalModifyPending++;
    this.host.services.diagnostics.increment("vault:modify:pending");
    this.externalModifyQueue = this.externalModifyQueue
      .then(() => this.processVaultModify(file))
      .catch((e) => {
        this.host.services.diagnostics.recordError("vault:modify", e);
        console.error("写作工具箱：外部修改统计失败", e);
      })
      .finally(() => {
        this.externalModifyPending = Math.max(
          0,
          this.externalModifyPending - 1
        );
        this.host.services.diagnostics.setLatest(
          "vault:modify:pending",
          this.externalModifyPending
        );
      });
  }

  /**
   * 启动时补建基线档案：上次退出后新出现的正文文件（比如 AI 趁 Obsidian
   * 关着写完的一章）整份内容计入当天；更早的文件只建档、不追溯。
   */
  private async scanNewFilesOnLoad(since: number): Promise<void> {
    if (!since) return; // 首次启用该版本：没有历史基线，不做任何追溯
    const today = this.todayStr;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.statusBar.hasBaseline(file.path)) continue;
      if (!this.isDailyCountFile(file.path)) continue;
      if (file.stat.ctime <= since) continue;
      const text = await this.app.vault.cachedRead(file);
      if (this.unloaded) return;
      const created = new Date(file.stat.ctime);
      const createdDay = `${created.getFullYear()}-${String(
        created.getMonth() + 1
      ).padStart(2, "0")}-${String(created.getDate()).padStart(2, "0")}`;
      if (createdDay !== today) {
        this.statusBar.seedBaseline(file.path, text);
        continue;
      }
      const delta = this.statusBar.countAsNewFile(file.path, text);
      this.applyDailyStats(file, delta, false);
    }
  }

  private async processVaultModify(file: TFile): Promise<void> {
    if (this.unloaded) return;
    const text = await this.app.vault.cachedRead(file);
    if (this.unloaded) return;
    // 当前活动文件：以编辑器最近已知文本为参照计算外部净变化，
    // 避免先 rebase 更新基线导致 delta 恒为 0；首次外部修改也能统计。
    let delta: number;
    if (file.path === this.lastKnownPath && this.lastKnownText !== null) {
      delta = this.countWords(text) - this.countWords(this.lastKnownText);
      this.lastKnownText = text;
      // 记录外部写入内容，供 editor-change 识别同步刷新
      this.lastExternalSyncText = text;
      this.statusBar.rebaseCurrentDocument(text);
      // 番茄钟专注中：把外部字数变化同步进基线，避免 AI 的增删算进本番茄字数
      this.activePomodoro()?.adjustBaseCount(delta);
    } else {
      delta = this.statusBar.hasBaseline(file.path)
        ? this.statusBar.onExternalFileChange(file.path, text)
        : this.handleUnknownFile(file, text);
    }
    // 今日净增按书稿字数算：同步、外部工具、本机保存都只是更新这一章的字数
    this.updateBookCount(file.path, this.countWords(text));
    this.applyDailyStats(file, delta, false);
    this.stats.publish();
    this.refreshSidebar(text);
  }

  /**
   * 把一次字数变化计入每日/作品/时长统计（调用方保证是正文草稿文件）。
   * countDuration=false 用于外部/AI 修改：只统计字数，不虚增用户写作时长。
   */
  private applyDailyStats(file: TFile, delta: number, countDuration = true): void {
    statsApplied(file.path, delta, countDuration);
    this.ensureCurrentDay();
    // 跨天结算后，内存里的今日数值属于 activeDay；键也必须用它。
    const day = this.activeDay;
    if (countDuration) this.recordWritingActivity();
    const project = this.getProjectForPath(file.path) ?? "未分组";
    if (!this.knownProjects.has(project)) {
      this.knownProjects.add(project);
      this.refreshSidebarSettings();
    }
    // 今日净增 / 作品 / 明细不再由这里按事件累加：改为书稿字数 − 今日起点（recomputeToday），
    // 这里只记写作时长。dailyHistory / projectHistory / dailyFileDeltas 是切换前的历史，只读。
    this.dailyDurationHistory[day] = this.dailyDurationSeconds;
    const durationInc = this.dailyDurationSeconds - this.lastDurationTotal;
    if (durationInc > 0) {
      const projectDay = this.projectDurationHistory[project]
        ?? (this.projectDurationHistory[project] = {});
      projectDay[day] = (projectDay[day] || 0) + durationInc;
    }
    this.lastDurationTotal = this.dailyDurationSeconds;
    this.scheduleDailySave();
  }

  /**
   * 输入法拼字结束后补结算写下的字。选词上屏时不一定还有一次 editor-change，
   * 所以拼字期间每 300ms 看一眼，拼字结束就按上屏后的字数结算一次。
   */
  private scheduleTypedSettle(path: string): void {
    this.typedSettleTimer?.dispose();
    this.typedSettleTimer = this.eventScope.setTimeout(() => {
      this.typedSettleTimer = null;
      const editor = this.getActiveEditor();
      if (!editor || this.app.workspace.getActiveFile()?.path !== path) return;
      if (this.host.services.editor.getViewForEditor(editor)?.composing) {
        this.scheduleTypedSettle(path);
        return;
      }
      const typed = this.statusBar.settleTyped(editor.getValue());
      if (typed > 0) {
        this.recordTyped(typed);
        this.scheduleDailySave();
        this.stats.publish();
      }
    }, 300);
  }

  /** 累计今日写下的字（时速的分子）；键用 activeDay，与今日净增记在同一天。 */
  private recordTyped(words: number): void {
    this.ensureCurrentDay();
    const day = this.activeDay;
    this.dailyTypedHistory[day] = (this.dailyTypedHistory[day] || 0) + words;
  }

  /**
   * 第一次见到某个正文文件时怎么算：
   * - 文件是在上次建立基线之后新建的（AI 现写的一章）→ 整份内容算新增；
   * - 其他情况（旧章节、插件刚启用）→ 只建档，这次增量记 0。
   * 这样「先写后改」的章节不会被漏掉，也不会把库里的老文章算成今天写的。
   */
  private handleUnknownFile(file: TFile, text: string): number {
    if (this.isFreshlyCreated(file)) {
      return this.statusBar.countAsNewFile(file.path, text);
    }
    this.statusBar.seedBaseline(file.path, text);
    return 0;
  }

  /** 文件是否是在上次建立基线档案之后才出现的（= 新写的章节）。 */
  private isFreshlyCreated(file: TFile): boolean {
    return this.baselinesAt > 0 && file.stat.ctime > this.baselinesAt;
  }

  /** 文件是否创建于今天（按本地日期）。 */
  private isCreatedToday(file: TFile): boolean {
    const d = new Date(file.stat.ctime);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")}`;
    return day === this.todayStr;
  }

  private buildCommentsModule(): CommentsModule {
    return createCommentsModule({
      getRecentMarkdownPath: () => this.lastKnownPath,
      openSidebar: () => this.openCommentsSidebar(),
      isFormatScopeAllowed: (path) =>
        this.formatToolbarModule.allowsPath(path),
      onChanged: () => this.refreshCommentBadges(),
      isMobile: () => this.commentsOffOnThisDevice(),
      // 本机批注工具在运行就让 Agent 走工具，否则直接写批注文件
      agentChannel: () =>
        this.agentBridgeModule?.operations.status().running ? "tools" : "file",
    });
  }

  private buildAgentBridgeModule(): AgentBridgeModule {
    return createAgentBridgeModule({
      isDesktop: () => Platform.isDesktopApp,
      tools: () => this.commentsModule.operations.agentTools,
      version: this.manifest.version,
    });
  }

  /** 这台设备上关掉批注：移动端且没开「在手机和平板上使用批注」。 */
  private commentsOffOnThisDevice(): boolean {
    return Platform.isMobile && !this.settings.commentsOnMobile;
  }

  /* ---------- 本机批注工具：设置页端口 ---------- */

  agentBridgeStatus(): AgentBridgeSettingsStatus {
    return this.agentBridgeModule.operations.status();
  }

  async setAgentBridgeEnabled(on: boolean): Promise<void> {
    await this.agentBridgeModule.operations.setEnabled(on);
    this.settingTab.display();
  }

  async setAgentBridgePort(port: number): Promise<void> {
    try {
      await this.agentBridgeModule.operations.setPort(port);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
    this.settingTab.display();
  }

  async regenerateAgentBridgeToken(): Promise<void> {
    await this.agentBridgeModule.operations.regenerateToken();
    new Notice("已换新口令：旧的配置失效了，请在 Agent 那边重新配一次");
    this.settingTab.display();
  }

  setAgentBridgeClient(client: AgentBridgeClient): void {
    this.agentBridgeModule.operations.setClient(client);
  }

  copyAgentBridgeCommand(): void {
    const config = this.agentBridgeModule.operations.connectionConfig();
    navigator.clipboard.writeText(config.text).then(
      () => new Notice(config.done, 12000),
      () => new Notice("复制到剪贴板失败")
    );
  }

  /** 设置页：把可同步目录加进 Obsidian 的排除列表。 */
  addSidecarFolderToExcluded(): void {
    this.sidecarLocationModule.operations.addToObsidianExcluded();
  }

  private snapshotFolder(): string {
    return effectiveSnapshotFolder(this.settings.snapshotFolder);
  }

  /** 是否位于快照文件夹内（快照镜像路径可能含「正文草稿」，不应计入正文统计）。 */
  private isSnapshotPath(path: string): boolean {
    const folder = this.snapshotFolder();
    if (!folder) return false;
    return path === folder || path.startsWith(folder + "/");
  }

  // ---------- 作品索引（判断"算不算正文"的依据） ----------

  /** 兼容包装：迁移期保留旧调用名，实际索引由 Host 的 project Service 管理。 */
  private projectIndex(): readonly NovelProject[] {
    return this.host.services.project.projects();
  }

  private invalidateProjectIndex(): void {
    this.host.services.project.invalidate();
  }

  /** 全部正文章节的路径集合（判断取用 O(1)）。 */
  private chapterPaths(): ReadonlySet<string> {
    return this.host.services.project.chapterPaths();
  }

  /**
   * 这个文件算不算「正文」。
   *
   * 以前是"路径里有没有『正文草稿』四个字"，会把 .wt-outlines 下镜像的章纲
   * 也算进来（它的路径同样含正文草稿），还会漏掉按「第N卷」分目录的存档长篇。
   * 现在直接用作品识别的结果：只有被认作章节的文件才算。
   */
  private isDailyCountFile(path: string): boolean {
    return this.host.services.project.isDailyCountFile(path);
  }

  /** 作品标识：该文件所属作品的根目录；不属于任何作品返回 null。 */
  private getProjectForPath(path: string): string | null {
    return this.host.services.project.projectRootForPath(path);
  }

  /* ---------- 批注：UI Shell 兼容端口 ---------- */

  refreshAllCommentDecors(): void {
    this.commentsModule.operations.refreshAllDecors();
  }

  getCommentPanelModel(): Promise<CommentPanelModel> {
    return this.commentsModule.operations.getCommentPanelModel();
  }

  jumpToComment(docPath: string, id: number): void {
    this.commentsModule.operations.jumpToComment(docPath, id);
  }

  replyToComment(docPath: string, id: number, text: string): Promise<boolean> {
    return this.commentsModule.operations.replyToComment(docPath, id, text);
  }

  editComment(docPath: string, id: number): void {
    this.commentsModule.operations.editComment(docPath, id);
  }

  resolveComment(docPath: string, id: number): void {
    this.commentsModule.operations.resolveComment(docPath, id);
  }

  rejectComment(docPath: string, id: number): void {
    this.commentsModule.operations.rejectComment(docPath, id);
  }

  rebindComment(docPath: string, id: number): void {
    this.commentsModule.operations.rebindComment(docPath, id);
  }

  copyReviewPrompt(docPath?: string): void {
    this.commentsModule.operations.copyReviewPrompt(docPath);
  }

  copyReplyPrompt(docPath?: string): void {
    this.commentsModule.operations.copyReplyPrompt(docPath);
  }

  /** 批注模块变化后只刷新工具箱标签徽标；列表由插槽自行刷新。 */
  private refreshCommentBadges(): void {
    for (const leaf of this.host.services.ui.leaves(
      WRITING_TOOLKIT_SIDEBAR
    )) {
      const view = leaf.view as unknown as Partial<WritingToolkitSidebar> | null;
      if (typeof view?.refreshCommentsBadge === "function") {
        view.refreshCommentsBadge();
      }
    }
  }

  /** 打开工具箱并切到批注页；卡片定位由 comments 模块的插槽句柄完成。 */
  private async openCommentsSidebar(): Promise<void> {
    await this.openSidebar();
    for (const leaf of this.host.services.ui.leaves(
      WRITING_TOOLKIT_SIDEBAR
    )) {
      const view = leaf.view as unknown as Partial<WritingToolkitSidebar> | null;
      if (typeof view?.activateCommentsTab === "function") {
        view.activateCommentsTab();
      }
    }
  }

  /** 编辑台复制正文时，优先使用该文档已打开编辑器里的实时内容。 */
  private markdownViewForPath(path: string): MarkdownView | null {
    for (const leaf of this.host.services.ui.leaves("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === path) return view;
    }
    return null;
  }

  /**
   * 读取一章的实时正文（「一键复制纯净正文」与「读者手机预览」共用）。
   *
   * 批注内容在 `.wt-comments/` 的伴随文件里，正文里的标记只是编辑器装饰，
   * 因此文件文本本身就是干净正文；文档开着时优先读编辑器实时内容。
   * 路径不可读 / 找不到 / 为空时给出提示并返回 null。
   */
  private async readChapterText(path: string): Promise<string | null> {
    if (isInternalPath(path)) return null;
    let text: string | null = null;
    const open = this.markdownViewForPath(path);
    if (open?.editor) {
      text = open.editor.getValue();
    } else {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        new Notice("找不到这篇文档");
        return null;
      }
      try {
        text = await this.app.vault.cachedRead(file);
      } catch (error) {
        console.error("写作工具箱：读取正文失败", error);
        new Notice("读取正文失败（详见控制台）");
        return null;
      }
    }
    if (text === null || text.trim() === "") {
      new Notice("这篇文档是空的");
      return null;
    }
    return text;
  }

  /**
   * 复制某篇文档的干净正文（编辑台章节列表里的复制按钮调用）。
   * 载荷处理走 `cleanChapterText`，与「读者手机预览」是同一份。
   */
  async copyCleanChapter(path: string): Promise<void> {
    const text = await this.readChapterText(path);
    if (text === null) return;
    const payload = cleanChapterText(text);
    const name = path.split("/").pop()?.replace(/\.md$/i, "") ?? "本章";
    try {
      await navigator.clipboard.writeText(payload);
      new Notice(
        `已复制「${name}」正文 ${payload.length} 字（批注标记只在编辑器里显示，不会带出去）`
      );
    } catch (error) {
      console.error("写作工具箱：复制正文失败", error);
      new Notice("复制到剪贴板失败（详见控制台）");
    }
  }

  /* ---------- 读者手机预览（SPEC-005） ---------- */

  /**
   * 打开「读者手机预览」：把交稿载荷放进手机外框里，按阅读器排版呈现。
   *
   * 入口只在桌面端（编辑台书头按钮与菜单）；真机上不显示，这里再兜一次底。
   * 预览**只读**：不写正文、不写伴随文件、不写 data.json。
   */
  private async openPhonePreview(path: string): Promise<void> {
    if (Platform.isMobile) {
      new Notice("读者手机预览只在桌面端提供");
      return;
    }
    const chapters = this.readerChaptersFor(path);
    const index = chapters.findIndex((item) => item.path === path);
    const model = await this.buildReaderModel(path, index, chapters.length);
    if (!model) return;
    // 游标必须跟着每次成功翻章推进：弹窗只回调 offset，闭包里读不到它自己的
    // model.index，用固定的 index 会让「下一章」永远停在同一个位置。
    let cursor = index;
    new MobilePreviewModal(this.app, model, {
      load: async (offset) => {
        if (cursor < 0) return null;
        const nextIndex = cursor + offset;
        const target = chapters[nextIndex];
        if (!target) return null;
        const next = await this.buildReaderModel(
          target.path,
          nextIndex,
          chapters.length
        );
        if (next) cursor = nextIndex;
        return next;
      },
    }).open();
  }

  /** 文档所属作品的章节序列（按阅读顺序）；不属于任何作品时返回空数组。 */
  private readerChaptersFor(
    path: string
  ): Array<{ path: string; title: string }> {
    const project = this.projectForDocument(path);
    if (!project) return [];
    return allChapters(project).map((entry) => ({
      path: entry.file.path,
      title: this.chapterDisplayTitle(entry),
    }));
  }

  /** 章节显示名：有标题用标题，否则「序章 / 第 N 章 / 文件名」。 */
  private chapterDisplayTitle(entry: ChapterEntry): string {
    const title = entry.title?.trim();
    if (title) return title;
    if (entry.number === 0) return "序章";
    if (entry.number !== null && entry.number > 0) {
      return `第 ${entry.number} 章`;
    }
    return entry.file.basename;
  }

  /** 文档所属作品；不在任何作品目录里时返回 null（预览退化为「单篇」）。 */
  private projectForDocument(path: string): NovelProject | null {
    const root = this.host.services.project.projectRootForPath(path);
    if (!root) return null;
    return (
      this.host.services.project
        .projects()
        .find((item) => item.root === root) ?? null
    );
  }

  /** 组装一章的预览模型：正文与复制同管线，字数按当前统计口径。 */
  private async buildReaderModel(
    path: string,
    index: number,
    total: number
  ): Promise<ReaderPreviewModel | null> {
    const raw = await this.readChapterText(path);
    if (raw === null) return null;
    const text = cleanChapterText(raw);
    const project = this.projectForDocument(path);
    const entry = project
      ? allChapters(project).find((item) => item.file.path === path)
      : undefined;
    return {
      path,
      title: entry
        ? this.chapterDisplayTitle(entry)
        : path.split("/").pop()?.replace(/\.md$/i, "") ?? "本章",
      text,
      words: this.countWords(text),
      index,
      total,
    };
  }

  /* ---------- 格式工具条 · 自检（排查气泡不出现） ---------- */

  /**
   * 开发排查入口：一次性检查浮出工具条的各环节并生成报告。
   * 该能力刻意不注册到命令面板，避免命令面板膨胀。
   */
  private async runFormatSelfCheck(): Promise<void> {
    await this.writeDiagnosticReport(this.buildFormatSelfCheckText("开发排查"), true);
  }

  /** 组装自检报告文本（开发排查 / 回归检查共用）。 */
  private buildFormatSelfCheckText(trigger: string): string {
    const lines: string[] = [];
    const push = (s: string) => lines.push(s);
    push("# 写作工具箱 · 格式工具条自检报告");
    push("");
    try {
      push(`- 代码版本标记：fmt-diag-2026-10-15-h（批注卡只留确认按钮）`);
      push(`- 触发方式：${trigger}`);
      push(`- 生成时间：${new Date().toLocaleString()}`);
      push(`- 开关 formatToolbarEnabled：${String(this.settings.formatToolbarEnabled)}`);
      push(`- 范围 formatToolbarScope：${String(this.settings.formatToolbarScope)}`);
      push(`- obsidian.editorInfoField 运行时存在：${String(editorInfoField !== undefined)}`);

      push("");
      push("## 活动编辑器");
      const mview = this.app.workspace.getActiveViewOfType(MarkdownView);
      push(`- 活动 MarkdownView：${mview?.file?.path ?? "（无）"}`);
      const cmFromEditor =
        this.host.services.editor.getViewForEditor(mview?.editor);
      push(`- editor.cm 可用：${String(cmFromEditor !== undefined)}`);
      const domEl = document.querySelector(".cm-editor");
      const cmFromDom = this.host.services.editor.findViewFromDom(
        domEl as HTMLElement | null
      );
      push(`- 页面有 .cm-editor 元素：${String(domEl !== null)}；findFromDOM：${cmFromDom ? "可用" : "不可用"}`);
      const ae = document.activeElement as HTMLElement | null;
      const aeDesc = ae
        ? `${ae.tagName.toLowerCase()}${typeof ae.className === "string" && ae.className ? ` class="${ae.className}"` : ""}`
        : "（无）";
      push(`- document.activeElement：${aeDesc}`);
      const cm = cmFromEditor ?? cmFromDom ?? undefined;
      if (cm) {
        const st = cm.state;
        const info = st.field(editorInfoField, false);
        const path = info?.file?.path ?? null;
        push(`- editorInfoField 字段值：${info ? "有" : "无（undefined）"}`);
        push(`- 字段中的路径：${path ?? "（null）"}`);
        try {
          const chapters = this.chapterPaths();
          push(`- 章节集合规模：${chapters.size}；当前文件在其中：${path ? String(chapters.has(path)) : "-"}`);
        } catch (error) {
          push(`- ‼️ chapterPaths() 抛异常：${String(error)}`);
        }
        try {
          push(`- formatToolbarAllowed：${String(this.formatToolbarModule.allowsPath(path))}`);
        } catch (error) {
          push(`- ‼️ formatToolbarAllowed 抛异常：${String(error)}`);
        }
        const r = st.selection.main;
        push(`- 选区：${st.selection.ranges.length} 段；主选区 ${r.from}–${r.to}（${r.to - r.from} 字符）`);
        push(`- composing=${String(cm.composing)}；hasFocus=${String(cm.hasFocus)}`);
        try {
          const c = cm.coordsAtPos(r.head);
          push(`- coordsAtPos(主选区头)：${c ? `OK（${Math.round(c.left)}, ${Math.round(c.top)}）` : "null"}`);
        } catch (error) {
          push(`- ‼️ coordsAtPos 抛异常：${String(error)}`);
        }
      }

      push("");
      push("## 气泡元素（document.body 下）");
      const bubbles = document.querySelectorAll(".wt-format-bubble");
      push(`- 数量：${bubbles.length}`);
      for (let i = 0; i < Math.min(bubbles.length, 3); i++) {
        const bubble = bubbles[i] as HTMLElement;
        const cs = getComputedStyle(bubble);
        const rect = bubble.getBoundingClientRect();
        push(`- 气泡#${i + 1}：class="${bubble.className}"；inline left/top="${bubble.style.left || "-"} / ${bubble.style.top || "-"}"`);
        push(`  计算样式：display=${cs.display}；visibility=${cs.visibility}；opacity=${cs.opacity}；position=${cs.position}；z-index=${cs.zIndex}`);
        push(`  尺寸：offset=${bubble.offsetWidth}×${bubble.offsetHeight}；rect=(${Math.round(rect.left)}, ${Math.round(rect.top)}) ${Math.round(rect.width)}×${Math.round(rect.height)}`);
      }

      push("");
      push("## 刷新统计（本次运行累计）");
      push(`- 扩展注册次数（buildFormatToolbar 调用）：${formatToolbarDiag.extensionBuilds}`);
      push(`- 工具条实例创建：${formatToolbarDiag.created} 个`);
      push(`- 工具条 refresh 调用：${formatToolbarDiag.refreshes} 次；其中显示：${formatToolbarDiag.shown} 次`);
      push(`- updateListener 探针：${formatToolbarDiag.listenerUpdates} 次更新（其中选区变化 ${formatToolbarDiag.listenerSelSet} 次）`);
      push(`- 最近一次刷新结果：${formatToolbarDiag.lastReason}（路径：${formatToolbarDiag.lastPath ?? "-"}）`);
      push(`- 隐藏原因统计：${JSON.stringify(formatToolbarDiag.hid)}`);
      push(
        `- 最近异常：${
          formatToolbarDiag.lastError
            ? formatToolbarDiag.lastError.split("\n").slice(0, 8).join(" ⏎ ")
            : "无"
        }`
      );
    } catch (error) {
      push("");
      push(`‼️ 自检过程中出现异常：${String((error as Error)?.stack ?? error)}`);
    }
    push("");
    push("（本文件为排查用的诊断报告，看完可删。）");
    return lines.join("\n");
  }

  /**
   * 把诊断文本写进库里的报告文件；interactive=true 时给通知并复制剪贴板。
   * 文件名带时间戳，所以每次自检都留一份、不会覆盖上一次（排查问题时常要看前后对比）。
   */
  private async writeDiagnosticReport(
    text: string,
    interactive: boolean,
    kind = "格式工具条"
  ): Promise<void> {
    // 文件名要文件系统安全：不能用 formatTimestamp（含空格与冒号）
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
      `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const name = `写作工具箱-${kind}自检报告-${stamp}.md`;
    const inbox = "0-收件箱";
    const reportPath = this.app.vault.getAbstractFileByPath(inbox)
      ? `${inbox}/${name}`
      : name;
    try {
      const existing = this.app.vault.getAbstractFileByPath(reportPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, text);
      } else {
        await this.app.vault.create(reportPath, text);
      }
      if (interactive) {
        new Notice(`${kind}自检完成，报告已写入「${reportPath}」`, 8000);
      }
    } catch (error) {
      console.error("写作工具箱：自检报告写入失败", error);
      if (interactive) {
        new Notice("自检完成，但报告写入失败（完整结果见开发者控制台）", 8000);
      }
    }
    if (interactive) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // 剪贴板失败无妨，报告文件是主要途径
      }
    }
  }

  /* ---------- 自检：批注 / 字数统计 ---------- */

  /** 采集批注相关的现场状态，组装报告文本。 */
  private buildCommentDiagText(): string {
    return this.commentsModule.operations.buildDiagnosticReport();
  }

  /** 采集字数统计相关的现场状态，组装报告文本。 */
  private buildStatsDiagText(): string {
    const cur = this.statusBar.getCurrentDoc();
    const path = cur.path || this.lastKnownPath;
    // 番茄模块启动失败不应连带破坏统计自检。
    const pomodoroBaseCount = this.activePomodoro()?.getBaseCount() ?? null;
    return buildStatsDiagReport({
      wordCountMode: this.settings.wordCountMode,
      dailyGoal: this.settings.dailyGoal,
      todayStr: this.todayStr,
      dailyTotal: this.dailyTotal,
      dailyDurationSeconds: this.dailyDurationSeconds,
      fileBaselineCount: Object.keys(this.fileBaselines).length,
      baselinesAt: this.baselinesAt,
      isCountedFile: path ? this.isDailyCountFile(path) : false,
      currentPath: path,
      currentWords: cur.words,
      pomodoroBaseCount,
      pendingExternal: this.externalModifyPending,
      todayBasis: this.todayBasisLines(),
    });
  }

  /** 生成单份报告并落盘（开发入口用）。 */
  private async runDiagnostic(kind: "批注" | "字数统计" | "全部"): Promise<void> {
    if (kind === "全部") {
      const text = [
        this.buildFormatSelfCheckText("「全部自检」命令"),
        "",
        "---",
        "",
        this.buildCommentDiagText(),
        "",
        "---",
        "",
        this.buildStatsDiagText(),
      ].join("\n");
      await this.writeDiagnosticReport(text, true, "全部");
      return;
    }
    if (kind === "批注") {
      await this.writeDiagnosticReport(this.buildCommentDiagText(), true, "批注");
      return;
    }
    await this.writeDiagnosticReport(this.buildStatsDiagText(), true, "字数统计");
  }

  /**
   * 侧栏「统计范围」下拉框的作品列表。
   * keepKey 传当前选中的作品，即使它已被隐藏也保留一行，避免选中项从下拉框里消失。
   */
  getProjects(keepKey?: string | null): { key: string; label: string }[] {
    return this.stats.getProjects(keepKey);
  }

  /**
   * 热力图 / 今日目标显示用的每日数字（净增口径：新增为正、删除为负）。
   */
  dailyForDisplay(): Record<string, number> {
    return this.stats.dailyForDisplay();
  }

  /** 同上，但限定某个作品（用于「统计范围」下拉）。 */
  projectForDisplay(key: string): Record<string, number> {
    return this.stats.projectForDisplay(key);
  }

  /** UI Shell 的迁移期入口：日历模块负责数据绑定与销毁。 */
  createCalendar(
    container: HTMLElement,
    initialYear?: number
  ): CalendarHandle {
    return this.calendarModule.operations.create(container, initialYear);
  }

  /** 今日字数明细：查出"今天这个数是怎么来的"。 */
  showDailyBreakdown(): void {
    this.stats.showDailyBreakdown();
  }

  /** 侧栏整体重绘（统计范围下拉等依赖作品列表的部分需要跟着刷新）。 */
  refreshSidebarSettings(): void {
    this.nav.refreshSidebarSettings();
  }

  /**
   * 作品目录改名后迁移按作品统计的 key（projectHistory / projectDurationHistory），
   * 避免历史字数/时长"消失"在新目录名下。
   */
  /** 作品目录或封面图片改名 / 移动后，封面记录（键和图片路径）跟着搬。 */
  private migrateCoverPaths(oldPath: string, newPath: string): void {
    this.prefs.migrateCoverPaths(oldPath, newPath);
  }

  private migrateProjectKeysOnRename(newPath: string, oldPath: string): void {
    if (!oldPath || oldPath === newPath) return;
    const prefix = oldPath + "/";
    let changed = false;
    const migrate = (map: Record<string, DailyHistory>): void => {
      for (const key of Object.keys(map)) {
        if (key === oldPath || key.startsWith(prefix)) {
          map[newPath + key.slice(oldPath.length)] = map[key];
          delete map[key];
          changed = true;
        }
      }
    };
    migrate(this.projectHistory);
    migrate(this.projectDurationHistory);
    if (this.knownProjects.has(oldPath)) {
      this.knownProjects.delete(oldPath);
      this.knownProjects.add(newPath);
    }
    if (changed) {
      this.refreshSidebarSettings();
      this.refreshSidebar();
      this.scheduleDailySave();
    }
  }

  /**
   * 手动修复：文件夹改名已经发生后，项目统计 key 指向不存在的目录。
   * 按路径相似度在库内找出最可能的同名/近似目录，确认后迁移历史数据。
   */
  async repairProjectStatPaths(): Promise<void> {
    const missing: string[] = [];
    const addIfMissing = (key: string): void => {
      if (
        !this.app.vault.getAbstractFileByPath(key) &&
        !missing.includes(key)
      ) {
        missing.push(key);
      }
    };
    for (const key of Object.keys(this.projectHistory)) addIfMissing(key);
    for (const key of Object.keys(this.projectDurationHistory)) {
      addIfMissing(key);
    }

    if (missing.length === 0) {
      new Notice("写作工具箱：没有失联的项目统计路径");
      return;
    }

    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map((f) => f.path);

    let migrated = 0;
    for (const key of missing) {
      const best = bestFolderCandidate(key, folders);
      if (!best) {
        new Notice(`找不到「${key}」对应的新目录，已跳过`);
        continue;
      }
      const ok = await new Promise<boolean>((resolve) => {
        new ConfirmModal(
          this.app,
          "修复项目统计路径",
          `项目「${key}」的统计记录在当前库中找不到对应目录。\n是否迁移到「${best}」？`,
          "迁移",
          () => resolve(true),
          false,
          () => resolve(false)
        ).open();
      });
      if (!ok) continue;
      this.migrateStatKey(key, best);
      migrated++;
    }
    if (migrated > 0) {
      this.refreshSidebarSettings();
      this.refreshSidebar();
      this.scheduleDailySave();
      new Notice(`写作工具箱：已迁移 ${migrated} 个项目统计路径`);
    }
  }

  /** 把单个项目统计 key 从旧路径迁到新路径。 */
  private migrateStatKey(oldKey: string, newKey: string): void {
    if (this.projectHistory[oldKey]) {
      this.projectHistory[newKey] = this.projectHistory[oldKey];
      delete this.projectHistory[oldKey];
    }
    if (this.projectDurationHistory[oldKey]) {
      this.projectDurationHistory[newKey] = this.projectDurationHistory[oldKey];
      delete this.projectDurationHistory[oldKey];
    }
    if (this.knownProjects.has(oldKey)) {
      this.knownProjects.delete(oldKey);
      this.knownProjects.add(newKey);
    }
  }

  private get todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** 文件改名/移动时把基线跟着搬走，避免新路径被当成新文件重复计数。 */
  private migrateBaselineKey(oldPath: string, newPath: string): void {
    const words = this.fileBaselines[oldPath];
    if (words === undefined) return;
    delete this.fileBaselines[oldPath];
    this.fileBaselines[newPath] = words;
    this.scheduleDailySave();
  }

  /** 目录改名/删除时批量搬运或清理该目录下的基线；newPrefix 为 null 表示删除。 */
  private migrateBaselinePrefix(oldPrefix: string, newPrefix: string | null): void {
    let changed = false;
    for (const path of Object.keys(this.fileBaselines)) {
      if (path !== oldPrefix && !path.startsWith(oldPrefix + "/")) continue;
      const words = this.fileBaselines[path];
      delete this.fileBaselines[path];
      if (newPrefix) {
        this.fileBaselines[newPrefix + path.slice(oldPrefix.length)] = words;
      }
      changed = true;
    }
    if (changed) this.scheduleDailySave();
  }

  /**
   * 作品目录被删除后，清掉该项目前缀下的统计 key，
   * 避免「统计范围」下拉框里出现已经不存在的幽灵作品。
   */
  private dropProjectKeys(prefix: string): void {
    const sub = prefix + "/";
    let changed = false;
    const drop = (map: Record<string, DailyHistory>): void => {
      for (const key of Object.keys(map)) {
        if (key === prefix || key.startsWith(sub)) {
          delete map[key];
          changed = true;
        }
      }
    };
    drop(this.projectHistory);
    drop(this.projectDurationHistory);
    for (const key of [...this.knownProjects]) {
      if (key === prefix || key.startsWith(sub)) {
        this.knownProjects.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.refreshSidebarSettings();
      this.scheduleDailySave();
    }
  }

  private ensureCurrentDay(): void {
    const today = this.todayStr;
    if (today === this.activeDay) return;
    const previous = this.activeDay;
    this.activeDay = today;
    this.onDayRollover(previous, today);
    this.dailyDurationSeconds = this.dailyDurationHistory[today] || 0;
    this.lastDurationTotal = this.dailyDurationSeconds;
    this.lastWritingActivityAt = 0;
  }

  private recordWritingActivity(): void {
    const now = Date.now();
    const gap = now - this.lastWritingActivityAt;
    if (this.lastWritingActivityAt > 0 && gap <= BREAK_GAP_MS) {
      this.dailyDurationSeconds += gap / 1000;
    }
    this.lastWritingActivityAt = now;
  }

  private scheduleDailySave(): void {
    this.dailySaveTimer?.dispose();
    this.dailySaveTimer = this.eventScope.setTimeout(() => {
      this.dailySaveTimer = null;
      this.pruneDailyFileDeltas();
      void this.savePluginData();
    }, 2000);
  }

  /** 每日明细与写下的字只留最近 60 天，避免插件数据无限膨胀。 */
  private pruneDailyFileDeltas(): void {
    for (const map of [this.dailyFileDeltas, this.dailyTypedHistory]) {
      const days = Object.keys(map).sort();
      const excess = days.length - 60;
      for (let i = 0; i < excess; i++) delete map[days[i]];
    }
  }

  /**
   * 布局就绪后统计书稿字数（文件树 / 作品索引此时才完整），据此记今日起点、算今日净增。
   * 旧的「今天新建文件不应为负」校正已删除：它按文件创建时间判断，而同步工具会把旧章节的
   * 创建时间刷成今天（2026-10-24 真机：−22 被改成了全文 3270 字）；新口径也不需要它。
   */
  private registerStartupReconcile(): void {
    this.eventScope.onLayoutReady(() => {
      void this.rebuildBookCounts();
    });
  }

  private async loadPluginData() {
    const loaded: unknown = await this.host.services.persistence.load();
    /** 只认对象；其余（null/字符串等）一律当作没有数据（与旧版 if (data) 等价）。 */
    const asRecord = <T extends object>(value: unknown): T | null =>
      value && typeof value === "object" ? (value as T) : null;
    /** 与 `value ?? fallback` 等价的最小型读取器。 */
    const pick = <T>(value: unknown, fallback: T): T =>
      value === undefined || value === null ? fallback : (value as T);
    const data = asRecord<Record<string, unknown>>(loaded);
    this.settings = this.host.services.settings.load(data);
    // 伴随数据（批注 / 快照 / 章纲）固定在 `_写作工具箱/`：模块激活、读任何伴随文件之前，
    // 先把旧版隐藏目录里的收进来
    await migrateLegacySidecars(this.app, this.settings);
    if (data) {
      // 老格式（顶层扁平设置）与新格式共用同名字段；旧版设置由 SettingsService
      // 统一迁移。老格式如有历史数据则保留，不主动清空。
        // 旧版定稿表：留着等定稿模块搬进 frontmatter（搬完前写盘也原样带回）
        this.legacyChapterStatus = asRecord<Record<string, unknown>>(data.chapterStatus);
        this.loadedPomodoroSession = data.pomodoroSession ?? null;
        this.prefs.load(data);
    }
    // 每日统计与字数基线按设备存在 `_写作工具箱/统计/`，不再放 data.json
    // （data.json 会被同步工具在设备间整份覆盖，见设计文档 §5.2 第 58 条）。
    await this.loadDeviceStats(data, {
      fileBaselines: asRecord<Record<string, number>>(data?.fileBaselines) ?? {},
      baselinesAt: pick(data?.baselinesAt, 0),
    });
    // 书稿字数还没统计完之前，先显示最近一次算出的今日结果
    this.dailyTotal = this.statsBook.latestResult(this.todayStr, this.ownResults)?.total ?? 0;
    this.dailyDurationSeconds = this.dailyDurationHistory[this.todayStr] || 0;
    this.lastDurationTotal = this.dailyDurationSeconds;
    this.activeDay = this.todayStr;
    this.knownProjects = new Set([
      ...Object.keys(this.projectHistory),
      ...Object.keys(this.projectDurationHistory),
    ]);
    this.sanitizeBaselines();
    this.lastDraftKeywords = this.settings.draftKeywords;
    this.lastChapterExcludeNames = this.settings.chapterExcludeNames;
  }

  /**
   * 清理字数基线里的脏数据：
   * - 结构上就不合法的：空路径（历史上 currentFilePath 还没建立时被写进去的）、
   *   非 md、位于 .wt-outlines / .wt-snapshots 等内部目录；
   * - 文件已经不存在的（只在仓库索引就绪时才判断，免得索引没加载完把有效基线误删）。
   * 这些键一旦被当成"上一个文档的字数"参与做差，就会凭空产出几千字的增减。
   */
  private sanitizeBaselines(): void {
    const vault = this.app.vault;
    // 除了根目录还有别的节点，才认为索引可用
    const vaultReady = vault.getAllLoadedFiles().length > 1;
    let dropped = 0;
    for (const path of Object.keys(this.fileBaselines)) {
      const structuralBad =
        !path || !path.endsWith(".md") || isInternalPath(path);
      const missing =
        !structuralBad &&
        vaultReady &&
        !(vault.getAbstractFileByPath(path) instanceof TFile);
      if (!structuralBad && !missing) continue;
      this.statusBar?.forgetBaseline?.(path);
      delete this.fileBaselines[path];
      dropped++;
    }
    if (dropped > 0) {
      console.warn(`写作工具箱：清理了 ${dropped} 条无效字数基线`);
      this.scheduleDailySave();
    }
  }

  async saveSettings() {
    this.stats.publish();
    this.refreshSidebar();
    // 正文关键词等设置可能变了：作品索引作废，下次判断重新扫描
    this.invalidateProjectIndex();
    // 章节识别设置（关键词 / 排除名单）真的变了：作品列表立即跟上，不等下次文件事件
    if (
      this.lastDraftKeywords !== this.settings.draftKeywords ||
      this.lastChapterExcludeNames !== this.settings.chapterExcludeNames
    ) {
      this.lastDraftKeywords = this.settings.draftKeywords;
      this.lastChapterExcludeNames = this.settings.chapterExcludeNames;
      this.refreshWorkbenches();
      this.refreshHome();
    }
    await this.persistPluginData();
    this.host.services.settings.publishChanges();
  }

  private async savePluginData() {
    // 内存里的今日数值属于 activeDay，不是写盘这一刻的日期：零点后、跨天结算前
    // 落盘（防抖、睡眠唤醒、卸载）若按实时日期回填，会把昨天的总数写进今天。
    const day = this.activeDay || this.todayStr;
    this.dailyDurationHistory[day] = this.dailyDurationSeconds;
    await this.writeOwnLedger();
    await this.persistPluginData();
  }

  /** 桌面端写实时会话；手机端原样带回读到的值，不覆盖桌面端同步过来的会话。 */
  private pomodoroSessionForPersistence(): unknown {
    const live = this.pomodoroModule?.sessionForPersistence();
    return live === undefined ? this.loadedPomodoroSession : live;
  }

  /** data.json 的内容：设置、界面偏好、番茄会话。统计在各设备自己的统计文件里。 */
  private pluginDataPayload(): Record<string, unknown> {
    return {
      settings: this.settings,
      pomodoroSession: this.pomodoroSessionForPersistence(),
      // 旧版定稿表搬进 frontmatter 之前原样带回，免得搬完前写盘把它丢了
      ...(this.legacyChapterStatus ? { chapterStatus: this.legacyChapterStatus } : {}),
      ...this.prefs.forPersistence(),
      // 旧统计迁移失败时原样带回，下次启动再迁
      ...(this.carryLegacyStats ?? {}),
    };
  }

  private async persistPluginData(): Promise<void> {
    const payload = this.pluginDataPayload();
    const json = JSON.stringify(payload);
    // 内容没变就不写：data.json 一写，同步工具就要传给另一台设备
    if (json === this.lastPersistedJson) return;
    this.lastPersistedJson = json;
    await this.host.services.persistence.save(payload);
  }

  /**
   * 另一台设备改的设置被同步工具带过来了：重新读进来，并当作「已写过」，
   * 免得下一次保存拿内存里的旧值把它盖回去。统计不在 data.json 里，不受影响。
   */
  async onExternalSettingsChange(): Promise<void> {
    const loaded: unknown = await this.host.services.persistence.load();
    if (!loaded || typeof loaded !== "object") return;
    const data = loaded as Record<string, unknown>;
    this.host.services.settings.load(data);
    this.prefs.load(data);
    if (Platform.isMobile) this.loadedPomodoroSession = data.pomodoroSession ?? null;
    this.lastPersistedJson = JSON.stringify(this.pluginDataPayload());
    this.host.services.settings.publishChanges();
    this.stats.publish();
    this.refreshSidebar();
    this.refreshWorkbenches();
    this.refreshHome();
  }

  // ---------- 跨设备分账：本机统计文件的读写 ----------

  /** 本机设备 ID：存在 app.saveLocalStorage（按库、按设备，不同步）。 */
  private loadOrCreateDeviceId(): string {
    const key = "writing-toolkit:device-id";
    const saved = this.app.loadLocalStorage(key) as unknown;
    if (typeof saved === "string" && /^[a-z0-9]+$/.test(saved)) return saved;
    const id = newDeviceId(Date.now());
    this.app.saveLocalStorage(key, id);
    return id;
  }

  private deviceName(): string {
    if (Platform.isIosApp) return "iPhone / iPad";
    if (Platform.isAndroidApp) return "Android";
    if (Platform.isMacOS) return "Mac";
    if (Platform.isWin) return "Windows";
    if (Platform.isLinux) return "Linux";
    return Platform.isMobile ? "手机" : "电脑";
  }

  private async readLedger(path: string, fallbackId: string): Promise<LedgerFile | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(path))) return null;
      return parseLedger(await adapter.read(path), fallbackId);
    } catch (error) {
      console.error(`写作工具箱：读取统计文件失败 ${path}`, error);
      return null;
    }
  }

  private async writeStatsFile(path: string, content: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(STATS_FOLDER))) {
      if (!(await adapter.exists("_写作工具箱"))) await adapter.mkdir("_写作工具箱");
      await adapter.mkdir(STATS_FOLDER);
    }
    await adapter.write(path, content);
  }

  private currentStatsMaps(): StatsMaps {
    return {
      dailyHistory: this.dailyHistory,
      dailyDurationHistory: this.dailyDurationHistory,
      projectHistory: this.projectHistory,
      projectDurationHistory: this.projectDurationHistory,
      dailyFileDeltas: this.dailyFileDeltas,
      dailyTypedHistory: this.dailyTypedHistory,
      dailyPomodoroHistory: this.dailyPomodoroHistory,
    };
  }

  private applyStatsMaps(maps: StatsMaps): void {
    this.dailyHistory = maps.dailyHistory;
    this.dailyDurationHistory = maps.dailyDurationHistory;
    this.projectHistory = maps.projectHistory;
    this.projectDurationHistory = maps.projectDurationHistory;
    this.dailyFileDeltas = maps.dailyFileDeltas;
    this.dailyTypedHistory = maps.dailyTypedHistory;
    this.dailyPomodoroHistory = maps.dailyPomodoroHistory;
  }

  /**
   * 启动时读本机统计文件；没有就说明是第一次跑这个版本：
   * 把旧 data.json 里的历史统计迁进 legacy.json（别的设备已迁过就跳过，避免翻倍），
   * 本机从空账开始，基线沿用 data.json 里的。
   */
  private async loadDeviceStats(
    data: Record<string, unknown> | null,
    legacyBaselines: { fileBaselines: Record<string, number>; baselinesAt: number }
  ): Promise<void> {
    this.deviceId = this.loadOrCreateDeviceId();
    this.statsBook = new DeviceStatsBook(this.deviceId);
    const own = await this.readLedger(ledgerPath(this.deviceId), this.deviceId);
    if (own) {
      this.applyStatsMaps(own);
      this.ownStarts = own.starts;
      this.ownResults = own.results;
      // 字数基线不再参与今日净增，只在本次运行里给编辑器用，不再存盘
      this.fileBaselines = { ...legacyBaselines.fileBaselines };
      this.baselinesAt = legacyBaselines.baselinesAt;
    } else {
      this.applyStatsMaps(emptyStatsMaps());
      this.fileBaselines = { ...legacyBaselines.fileBaselines };
      this.baselinesAt = legacyBaselines.baselinesAt;
    }
    if (data && hasAnyStats(data)) {
      try {
        if (!(await this.app.vault.adapter.exists(LEGACY_FILE))) {
          const legacy = buildLedger(
            { deviceId: LEGACY_DEVICE_ID, deviceName: "旧版统计（迁移前）", now: Date.now() },
            readStatsMaps(data),
            {},
            {}
          );
          await this.writeStatsFile(LEGACY_FILE, JSON.stringify(legacy));
        }
        this.carryLegacyStats = null;
      } catch (error) {
        console.error("写作工具箱：旧统计迁移失败，先留在 data.json，下次启动再迁", error);
        this.carryLegacyStats = readStatsMaps(data);
      }
    }
    // data.json 里还带着旧统计 / 基线时，下一次保存要把它们去掉
    this.lastPersistedJson =
      data && (hasAnyStats(data) || "fileBaselines" in data) && !this.carryLegacyStats
        ? ""
        : JSON.stringify(this.pluginDataPayload());
    await this.reloadOtherLedgers(false);
  }

  /** 写本机统计文件；内容没变（不算更新时间）就不写。 */
  private async writeOwnLedger(): Promise<void> {
    if (!this.deviceId) return;
    pruneLedgerDays(this.ownStarts, this.ownResults, this.activeDay || this.todayStr);
    const meta = { deviceId: this.deviceId, deviceName: this.deviceName(), now: 0 };
    const json = JSON.stringify(
      buildLedger(meta, this.currentStatsMaps(), this.ownStarts, this.ownResults)
    );
    if (json === this.lastLedgerJson) return;
    this.lastLedgerJson = json;
    const ledger = buildLedger(
      { ...meta, now: Date.now() },
      this.currentStatsMaps(),
      this.ownStarts,
      this.ownResults
    );
    try {
      await this.writeStatsFile(ledgerPath(this.deviceId), JSON.stringify(ledger));
    } catch (error) {
      this.lastLedgerJson = "";
      console.error("写作工具箱：写入本机统计文件失败", error);
    }
  }

  /** 统计目录里别的设备的文件变了（同步工具带过来的）：稍等再整体重读。 */
  private scheduleReloadOthers(): void {
    this.othersReloadTimer?.dispose();
    this.othersReloadTimer = this.eventScope.setTimeout(() => {
      this.othersReloadTimer = null;
      void this.reloadOtherLedgers(true);
    }, 800);
  }

  /** 重读其他设备的统计文件，核对待核对列表，并刷新界面上的加总。 */
  private async reloadOtherLedgers(refresh: boolean): Promise<void> {
    const adapter = this.app.vault.adapter;
    const others: LedgerFile[] = [];
    try {
      if (await adapter.exists(STATS_FOLDER)) {
        const listed = await adapter.list(STATS_FOLDER);
        for (const filePath of listed.files) {
          const name = filePath.split("/").pop() ?? filePath;
          if (!isLedgerFileName(name)) continue;
          const id = name.replace(/\.json$/, "");
          if (id === this.deviceId) continue;
          const ledger = await this.readLedger(filePath, id);
          if (ledger) others.push(ledger);
        }
      }
    } catch (error) {
      console.error("写作工具箱：读取其他设备的统计失败", error);
      return;
    }
    if (this.unloaded) return;
    this.statsBook.setOthers(others);
    // 别的设备可能更早记了今日起点：重算一次今日净增
    this.recomputeToday();
    if (!refresh) return;
    this.stats.publish();
    this.refreshSidebar();
    this.refreshWorkbench();
    this.refreshHome();
  }

  /** 统计目录里别的设备的文件（本机自己的不算）。 */
  private isOtherLedgerPath(path: string): boolean {
    return (
      path.startsWith(`${STATS_FOLDER}/`) &&
      path !== ledgerPath(this.deviceId) &&
      isLedgerFileName(path)
    );
  }

  /** 统计读模型。显示的数字一律是「本机 + 其他设备」的加总（跨设备分账，见 deviceStats.ts）。 */
  private createStatsService(): StatsService {
      return new StatsService({
        dailyHistory: () => this.statsBook.netDaily(this.ownResults, this.dailyHistory),
        projectHistory: () =>
          this.statsBook.netProjects(this.ownResults, this.projectHistory),
        projectDurationHistory: () =>
          this.statsBook.mergeProjectDuration(this.projectDurationHistory),
        dailyFileDeltas: () =>
          this.statsBook.netFiles(this.ownResults, this.dailyFileDeltas),
        todayTotals: () => this.todayTotalsAllDevices(),
        todayKey: () => this.todayStr,
        getSettings: () => this.settings,
        getPomodoroSummary: () => this.pomodoroSummaryAllDevices(),
        isProjectHidden: (root) => this.prefs.isProjectHidden(root),
        projectRootForFile: (path) => this.getProjectForPath(path),
        listMarkdownPaths: () =>
          this.app.vault.getMarkdownFiles().map((file) => file.path),
        typedToday: () =>
          (this.dailyTypedHistory[this.activeDay] || 0) +
          this.statsBook.othersDay("dailyTypedHistory", this.activeDay),
      });
  }

  /** 今日字数 / 时长：本机 + 其他设备。 */
  private todayTotalsAllDevices(): { total: number; durationSeconds: number } {
    const day = this.activeDay || this.todayStr;
    return {
      // 净增是书稿的变化，各设备算的是同一个数，不加总
      total: this.dailyTotal,
      durationSeconds:
        this.dailyDurationSeconds + this.statsBook.othersDay("dailyDurationHistory", day),
    };
  }

  /** 今日番茄：本机 + 其他设备；都没有时返回 null（与番茄模块的约定一致）。 */
  private pomodoroSummaryAllDevices(): { count: number; words: number } | null {
    const local = this.activePomodoro()?.getTodaySummary() ?? null;
    const others = this.statsBook.othersPomodoro(this.activeDay || this.todayStr);
    const count = (local?.count ?? 0) + others.count;
    if (count === 0) return null;
    return { count, words: (local?.words ?? 0) + others.words };
  }

  // ---------- 今日净增 = 书稿字数 − 今日起点 ----------

  /** 某一章现在的字数变了（编辑器输入、保存、同步、外部工具改写都走这里）。 */
  private updateBookCount(path: string, words: number): void {
    if (this.bookCounts.get(path) === words) return;
    this.bookCounts.set(path, words);
    this.recomputeToday();
  }

  /** 某一章不再算正文（删了、移出正文目录）。 */
  private dropBookCount(path: string): void {
    if (!this.bookCounts.delete(path)) return;
    this.recomputeToday();
  }

  /** 重新统计全部正文章节的字数（启动、文件夹改名 / 删除、章节识别设置变化、换统计口径）。 */
  private async rebuildBookCounts(): Promise<void> {
    const token = ++this.bookCountsToken;
    const counts = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isDailyCountFile(file.path)) continue;
      let text: string;
      if (file.path === this.lastKnownPath && this.lastKnownText !== null) {
        text = this.lastKnownText;
      } else {
        try {
          text = await this.app.vault.cachedRead(file);
        } catch {
          continue;
        }
      }
      if (this.unloaded || token !== this.bookCountsToken) return;
      counts.set(file.path, this.countWords(text));
    }
    this.bookCounts = counts;
    this.bookCountsReady = true;
    this.recomputeToday();
    this.stats.publish();
    this.refreshSidebar();
    this.refreshWorkbench();
    this.refreshHome();
  }

  /** 诊断报告里的「今日净增怎么来的」。 */
  private todayBasisLines(): string[] {
    const day = this.activeDay || this.todayStr;
    const mode = this.settings.wordCountMode;
    const start = this.statsBook.effectiveStart(day, mode, this.ownStarts[day]);
    const from =
      !start
        ? "（还没有）"
        : start === this.ownStarts[day]
          ? "本机"
          : this.statsBook.otherLedgers().find((l) => l.starts[day] === start)?.deviceName || "其他设备";
    const sum = (map: Iterable<number>): number => [...map].reduce((a, b) => a + b, 0);
    return [
      `书稿字数已统计：${this.bookCountsReady ? "是" : "否"}（正文章节 ${this.bookCounts.size} 个，共 ${sum(this.bookCounts.values())} 字）`,
      `今日起点：来自${from}${start ? `，记于 ${new Date(start.at).toLocaleString()}，共 ${sum(Object.values(start.files))} 字` : ""}`,
      `本机设备 ID：${this.deviceId}（${this.deviceName()}）；其他设备 ${this.statsBook.otherLedgers().length} 份统计`,
    ];
  }

  /** 现在各章字数的快照（记今日起点用）。 */
  private snapshotBook(): DayStart {
    return {
      at: Date.now(),
      mode: this.settings.wordCountMode,
      files: Object.fromEntries(this.bookCounts),
    };
  }

  /**
   * 重算今日净增：现在的书稿字数 − 今日起点（各设备里最早记的那份）。
   * 本机今天还没记起点、或口径变了，就以现在为起点。
   */
  private recomputeToday(): void {
    if (!this.bookCountsReady) return;
    const day = this.activeDay || this.todayStr;
    const mode = this.settings.wordCountMode;
    if (this.ownStarts[day]?.mode !== mode) this.ownStarts[day] = this.snapshotBook();
    const start =
      this.statsBook.effectiveStart(day, mode, this.ownStarts[day]) ?? this.ownStarts[day];
    const result = computeDay(
      start.files,
      this.bookCounts,
      (path) => this.getProjectForPath(path) ?? "未分组"
    );
    this.ownResults[day] = { at: Date.now(), ...result };
    this.dailyTotal = result.total;
    for (const project of Object.keys(result.projects)) {
      if (!this.knownProjects.has(project)) {
        this.knownProjects.add(project);
        this.refreshSidebarSettings();
      }
    }
    this.scheduleDailySave();
  }

  /**
   * 跨过零点：今天以此刻的书稿为起点（recomputeToday 发现今天还没有本机起点就会记）。
   * 昨天的结果不用另外结算——每次字数变化都已经按当天算过、写进了结果。
   */
  private onDayRollover(_previous: string, today: string): void {
    if (!this.bookCountsReady) {
      this.dailyTotal = this.statsBook.latestResult(today, this.ownResults)?.total ?? 0;
      return;
    }
    this.recomputeToday();
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * 在库内目录中找出与失联项目 key 最相似的目录。
 * 路径段相等记 1 分、互相包含（如「1-1-3-示例作品」vs「P3-示例作品」）记 0.5 分，
 * 只接受得分 > 0.5 的唯一最佳候选，避免误迁移。
 */
function bestFolderCandidate(
  missingKey: string,
  folders: string[]
): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const folder of folders) {
    const score = folderSimilarity(missingKey, folder);
    if (score > bestScore) {
      bestScore = score;
      best = folder;
    }
  }
  return bestScore > 0.5 ? best : null;
}

function folderSimilarity(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  const maxLen = Math.max(as.length, bs.length);
  if (maxLen === 0) return 0;
  let score = 0;
  for (let i = 0; i < maxLen; i++) {
    const x = as[i] ?? "";
    const y = bs[i] ?? "";
    if (!x || !y) continue; // 缺段不贡献分数，避免段数不同的目录误匹配
    if (x === y) score += 1;
    else score += commonSubstringRatio(x, y);
  }
  return score / maxLen;
}

/** 两段共享的最长子串占较长段的比例（匹配「P3-示例作品」vs「1-1-3-示例作品」这类近似段）。 */
function commonSubstringRatio(x: string, y: string): number {
  const long = x.length >= y.length ? x : y;
  const short = x.length >= y.length ? y : x;
  let best = 0;
  for (let i = 0; i < short.length; i++) {
    for (let j = i + 1; j <= short.length; j++) {
      if (j - i <= best) continue;
      if (long.includes(short.slice(i, j))) best = j - i;
    }
  }
  return long.length > 0 ? best / long.length : 0;
}
