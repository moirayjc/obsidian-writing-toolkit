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
import { EditorView } from "@codemirror/view";
import {
  DEFAULT_SETTINGS,
  WritingToolkitSettings,
  WritingToolkitSettingTab,
} from "./settings";
import { applyCachedThemeTone, injectTypography, removeTypography } from "./typography";
import { syncThemeSnippet } from "./themeSnippet";
import {
  buildTypewriterExtensions,
  setTypewriterActive,
  setTypewriterOffset as applyTypewriterOffset,
  setParagraphHighlight,
} from "./typewriter";
import { WritingStatusBar } from "./statusbar";
import { getWordCount, WordCountMode } from "./wordcount";
import { buildPunctuationExtensions, setPunctuationAssist } from "./punctuation";
import { buildHardBreakExtensions, setHardBreakOnEnter } from "./hardBreak";
import {
  buildHemingwayExtensions,
  setHemingway,
  setHemingwayDesired,
} from "./hemingway";
import { buildFormatToolbar, applyFormatOnView, formatToolbarDiag } from "./formatToolbar";
import { FormatKind } from "./formatWrap";
import {
  AnchorLocator,
  formatTimestamp,
  nextCommentId,
  LOCATE_VIA_LABELS,
  WtComment,
  buildAgentPrompt,
  docPathForSidecar,
  isSidecarPath,
  locateAll,
  paragraphAt,
  sidecarPathFor,
} from "./comments";
import { CommentStore } from "./commentStore";
import { buildCommentExtensions, dispatchCommentRefresh } from "./commentDecor";
import {
  type CommentPanelHost,
  type CommentPanelItem,
  type CommentPanelModel,
} from "./commentView";
import { WRITING_TOOLKIT_SIDEBAR, WritingToolkitSidebar } from "./sidebar";
import { migrateOutlineSidecar } from "./outlineText";
import {
  NovelProject,
  allChapters,
  discoverProjects,
  isInternalPath,
  projectForPath,
} from "./project";
import {
  WRITING_TOOLKIT_WORKBENCH,
  WritingToolkitWorkbench,
  type WorkbenchMode,
  type WorkbenchStatus,
} from "./workbench";
import {
  WRITING_TOOLKIT_HOME,
  WritingToolkitHome,
  type HomePage,
  type LibraryView,
} from "./home";
import { SnapshotEntry } from "./snapshot";
import { DraftSnapshotManager } from "./snapshot";
import { showSnapshotDiff } from "./snapshotDiff";
import { CommentDraftModal, ConfirmModal } from "./promptModal";
import { showNewProjectModal } from "./newProject";
import {
  PomodoroTimer,
  type FocusResult,
  type PomodoroConfig,
  type PomodoroPhase,
  type PomodoroState,
} from "./pomodoro";
import {
  applyPlatformMobileClass,
  handleSuppressedClick,
  isPhoneDevice,
  toggleMobilePreview,
} from "./mobile";
import { MobileStatusBar } from "./mobileStatusBar";

/** 「算不算正文」不再靠路径里的「正文草稿」字样，改用作品识别（见 isDailyCountFile）。 */

/** 仅在 Electron 桌面端可用（用于「在系统文件管理器中显示」）。 */
declare function require(name: string): any;

/** 两次输入间隔超过该毫秒数即视为停止写作，间隔不计入时长。
 *  2026-08-13 由 120s 收紧为 30s：避免停顿（喝水/切走/思考）被全额算作写作时间。 */
const MAX_IDLE_GAP_MS = 30_000;

interface DailyHistory {
  [date: string]: number;
}

interface DailyPomodoro {
  count: number;
  words: number;
}

export default class WritingToolkitPlugin extends Plugin implements CommentPanelHost {
  settings!: WritingToolkitSettings;
  dailyHistory: DailyHistory = {};
  /** 每日毛新增（不会为负）：今日目标、热力图用它，避免"重写一天显示 0 或负数" */
  dailyGrossHistory: DailyHistory = {};
  dailyDurationHistory: DailyHistory = {};
  /** 各作品（按正文草稿的上一级目录）的每日净增字数 */
  projectHistory: Record<string, DailyHistory> = {};
  /** 各作品的每日毛新增字数 */
  projectGrossHistory: Record<string, DailyHistory> = {};
  /** 各作品的每日有效写作时长 */
  projectDurationHistory: Record<string, DailyHistory> = {};
  /** 每日完成的番茄数与本番茄累计字数 */
  dailyPomodoroHistory: Record<string, DailyPomodoro> = {};
  /** 每日各文件的净增明细：出问题时能查出"这个数是哪个文件贡献的" */
  dailyFileDeltas: Record<string, DailyHistory> = {};
  /** 编辑台：当前作品根目录 */
  workbenchProject: string | null = null;
  /** 编辑台：正文 / 资料 视图模式 */
  workbenchMode: WorkbenchMode = "chapters";
  /** 编辑台：各作品的连载状态（键为作品根目录） */
  workbenchStatus: Record<string, WorkbenchStatus> = {};
  /** 编辑台：切换面板里被隐藏的作品（键为作品根目录） */
  hiddenProjects: Record<string, true> = {};
  /** 主页：上次停留的页面（书桌 / 书架 / 数据统计 / 资料库） */
  homePage: HomePage = "desk";
  /** 书架：各作品的自定义封面（作品根目录 → 仓库内图片路径） */
  projectCovers: Record<string, string> = {};
  /** 书架：卡片网格 / 列表 */
  libraryView: LibraryView = "grid";
  /** 各文件最近一次已知字数（键为文件路径） */
  fileBaselines: Record<string, number> = {};
  /** 上次建立基线档案的时间戳 */
  baselinesAt = 0;
  /** 作品索引缓存（库结构变化时失效） */
  private projectIndexCache: NovelProject[] | null = null;
  /** 正文章节路径集合缓存 */
  private chapterPathCache: Set<string> | null = null;
  /** 上次已生效的章节识别设置（变化时让作品列表立即重建） */
  private lastDraftKeywords: string | null = null;
  private lastChapterExcludeNames: string | null = null;
  /** 上次已生效的编辑工具条设置（开关/范围变化时让已浮出的工具条即时退出） */
  private lastFormatToolbarSig: string | null = null;
  /** 上次已生效的批注总开关（变化时刷新正文里的批注痕迹） */
  private lastCommentsEnabled: boolean | null = null;
  dailyTotal: number = 0;
  /** 今日毛新增（只累加变多的部分） */
  dailyGross: number = 0;
  dailyDurationSeconds = 0;
  private lastDurationTotal = 0;
  private knownProjects = new Set<string>();
  private statusBar!: WritingStatusBar;
  private mobileStatusBar!: MobileStatusBar;
  private settingTab!: WritingToolkitSettingTab;
  private activeDay: string = "";
  private dailySaveTimer: number = 0;
  private lastWritingActivityAt = 0;
  private previousTypewriterMode: boolean | null = null;
  private snapshotManager!: DraftSnapshotManager;
  private snapshotTickTimer: number = 0;
  private pomodoro!: PomodoroTimer;
  private lastPomodoroPhase: PomodoroPhase = "idle";
  private immersiveHintEl: HTMLElement | null = null;
  private hintHideTimer: number = 0;
  // 最近一次活动的文件信息：侧栏获得焦点时 workspace.getActiveFile() 会返回 null，
  // 这些字段让快照操作不依赖「当前焦点」。
  private lastEditor: Editor | null = null;
  private lastKnownPath: string | null = null;
  private lastKnownText: string | null = null;
  /** 外部修改（AI/脚本）处理队列：保证串行，避免异步竞态 */
  private externalModifyQueue: Promise<void> = Promise.resolve();
  private dayRolloverTimer: number = 0;
  /** 卸载标记：挂起的外部修改任务读到文件后直接返回，不操作已销毁对象 */
  private unloaded = false;
  /** 最近一次外部修改写入的内容：用于识别编辑器同步刷新触发的 editor-change */
  private lastExternalSyncText: string | null = null;
  /** 待忽略统计的程序化编辑（快照恢复/应用），按编辑器和最终文本精确匹配。 */
  private pendingProgrammaticEdit: { editor: Editor; text: string } | null = null;
  /** 批注：批注文件的读写与缓存（按源文档路径） */
  private commentStore!: CommentStore;

  async onload() {
    // 必须在第一个 await 之前同步执行：先套上上次的配色主题，避免首帧闪成暖纸
    applyCachedThemeTone();
    await this.loadPluginData();
    // 让片段文件与当前设置一致（首次安装、或设置被外部修改后都会生效）
    void syncThemeSnippet(this.app, this.settings.themeTone);

    // Obsidian 手机端自动套用手机版布局；桌面端可用命令手动预览。
    applyPlatformMobileClass();
    // 手机端：把误开在中间编辑区的编辑台 / 工具箱挪回左右抽屉。
    this.app.workspace.onLayoutReady(() => {
      if (Platform.isMobile) this.migrateMobileViewsToDrawers();
    });

    this.settingTab = new WritingToolkitSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    injectTypography(this.settings);

    this.statusBar = new WritingStatusBar(
      this.app,
      () => this.addStatusBarItem(),
      {
        dailyTotal: this.dailyTotal,
        dailyGross: this.dailyGross,
        dailyGoal: this.settings.dailyGoal,
        wordCountMode: this.settings.wordCountMode,
        showSpeed: this.settings.showSpeed,
      },
      () => void this.saveSettings(),
      {
        onStart: () => this.startPomodoro(),
        onTogglePause: () => this.togglePomodoroPause(),
        onSkipBreak: () => this.skipPomodoroBreak(),
        onStop: () => this.stopPomodoro(),
      }
    );
    this.statusBar.loadBaselines(this.fileBaselines);
    this.statusBar.baselineListener = (path, words) => {
      if (words === null) delete this.fileBaselines[path];
      else this.fileBaselines[path] = words;
      this.scheduleDailySave();
    };
    // 记下本次建立基线档案的时刻：之后新建的文件才按「整份内容」计入当天
    const previousScan = this.baselinesAt;
    this.baselinesAt = Date.now();
    this.scheduleDailySave();
    void this.scanNewFilesOnLoad(previousScan);

    this.snapshotManager = new DraftSnapshotManager(
      this.app.vault,
      () => this.settings,
      () => this.lastKnownPath,
      () => this.lastKnownText,
      () => this.refreshSnapshotPanel()
    );
    this.snapshotTickTimer = window.setInterval(
      () => this.snapshotManager.tick(),
      30_000
    );
    // 跨天兜底：即使一直没有输入/切换，也刷新状态栏与侧栏到新的一天
    this.dayRolloverTimer = window.setInterval(() => {
      if (this.todayStr !== this.activeDay) {
        this.ensureCurrentDay();
        this.statusBar.setState({
          dailyTotal: this.dailyTotal,
          dailyGross: this.dailyGross,
          dailyGoal: this.settings.dailyGoal,
          wordCountMode: this.settings.wordCountMode,
          showSpeed: this.settings.showSpeed,
        });
        this.refreshSidebar();
      }
    }, 60_000);

    this.immersiveHintEl = document.body.createDiv({
      cls: "wt-immersive-hint",
      text: "按 Esc 退出沉浸模式",
    });

    this.registerEditorExtension(buildTypewriterExtensions());
    this.registerEditorExtension(buildPunctuationExtensions());
    this.registerEditorExtension(buildHardBreakExtensions());
    this.registerEditorExtension(buildHemingwayExtensions());
    this.commentStore = new CommentStore(this.app);
    this.registerEditorExtension(
      buildFormatToolbar({
        isEnabled: () => this.settings.formatToolbarEnabled,
        allowsPath: (path) => this.formatToolbarAllowed(path),
        commentsEnabled: () => this.settings.commentsEnabled,
        commentBubbleEverywhere: () => this.settings.commentBubbleEverywhere,
        onAddComment: (view) => this.addCommentForView(view),
      })
    );
    // 批注痕迹：原文底色标记 + 行尾脚注序号。编辑器里不弹任何浮层
    // （跟随光标的卡片会随正文滚动而「跳」），点标记只是跳到侧栏对应卡片。
    this.registerEditorExtension(
      buildCommentExtensions({
        enabled: () => this.settings.commentsEnabled,
        getComments: (path) => this.commentStore.getCached(path),
        ensureLoaded: (path) => this.primeComments(path),
        onRevealComment: (path, comment) =>
          this.revealCommentInPanel(path, comment.id),
      })
    );
    this.pomodoro = new PomodoroTimer(
      () => this.pomodoroConfig(),
      () => this.getPomodoroCount(),
      {
        onUpdate: (state) => {
          this.statusBar.setPomodoro(state);
          this.updateSidebarPomodoro(state);
          if (state.phase !== this.lastPomodoroPhase) {
            this.lastPomodoroPhase = state.phase;
            this.updateSidebarPomodoroButton(state.phase);
          }
        },
        onFocusComplete: (result) => this.handlePomodoroComplete(result),
        onBreakComplete: () => new Notice("休息结束，开始下一个番茄吧"),
      }
    );
    // 初始渲染：空闲时状态栏也常驻显示可点击的「🍅 开始」
    this.statusBar.setPomodoro(this.pomodoro.getState());

    this.registerView(
      WRITING_TOOLKIT_SIDEBAR,
      (leaf) => new WritingToolkitSidebar(leaf, this)
    );
    this.registerView(
      WRITING_TOOLKIT_WORKBENCH,
      (leaf) => new WritingToolkitWorkbench(leaf, this)
    );
    this.registerView(
      WRITING_TOOLKIT_HOME,
      (leaf) => new WritingToolkitHome(leaf, this)
    );
    this.setTypewriterOffset(this.settings.typewriterOffset);
    setPunctuationAssist(this.settings.punctuationAssist);
    setHardBreakOnEnter(this.settings.hardBreakOnEnter);
    this.setHemingwayMode(this.settings.hemingwayMode);
    this.setImmersiveMode(this.settings.immersiveMode);
    this.setParagraphHighlight(this.settings.immersiveParagraphHighlight);
    this.updateStatusBarVisibility();

    // 手机端屏幕底部的常驻状态条（桌面端 CSS 隐藏，不挂也没关系）。
    this.mobileStatusBar = new MobileStatusBar(this);
    this.mobileStatusBar.mount();

    if (this.settings.typewriterMode) {
      this.setTypewriterMode(true);
    }

    this.addCommand({
      id: "open-sidebar",
      name: "打开工具箱",
      callback: () => void this.openSidebar(),
    });

    this.addCommand({
      id: "open-writing-workbench",
      name: "打开编辑台",
      callback: () => void this.openWorkbench(),
    });

    this.addCommand({
      id: "open-workbench-home",
      name: "打开主页",
      callback: () => void this.openHome(),
    });

    this.addCommand({
      id: "open-settings",
      name: "打开设置",
      callback: () => this.openSettings(),
    });

    this.addCommand({
      id: "toggle-mobile-preview",
      name: "切换手机版布局预览（桌面调试）",
      checkCallback: (checking) => {
        if (isPhoneDevice()) return false;
        if (!checking) {
          const on = toggleMobilePreview();
          new Notice(
            on
              ? "已开启手机版布局预览，随时再执行本命令关闭"
              : "已关闭手机版布局预览"
          );
        }
        return true;
      },
    });

    // 格式命令：与浮出工具条同一套逻辑，选中文字后从命令面板 / 快捷键调用
    const formatCommands: { id: string; name: string; kind: FormatKind }[] = [
      { id: "format-bold", name: "格式：加粗", kind: "bold" },
      { id: "format-italic", name: "格式：斜体", kind: "italic" },
      { id: "format-underline", name: "格式：下划线", kind: "underline" },
      { id: "format-strike", name: "格式：删除线", kind: "strike" },
      { id: "format-highlight", name: "格式：高亮", kind: "highlight" },
      { id: "format-color", name: "格式：字色（上次使用的颜色）", kind: "color" },
    ];
    for (const cmd of formatCommands) {
      this.addCommand({
        id: cmd.id,
        name: cmd.name,
        editorCallback: (editor) => this.applyFormatToEditor(editor, cmd.kind),
      });
    }

    // 诊断命令：气泡不出现时用它一键收集各环节状态（报告写到库里的文件）
    this.addCommand({
      id: "format-selfcheck",
      name: "格式：自检（排查工具条不出现）",
      callback: () => {
        void this.runFormatSelfCheck();
      },
    });

    // 批注：与 Agent 协作的核心工作流（你批注 → Agent 读批注文件改稿）
    this.addCommand({
      id: "comment-add",
      name: "批注：为选中文字添加批注",
      editorCallback: (editor) => {
        const view = (editor as any).cm as EditorView | undefined;
        if (view) this.addCommentForView(view);
      },
    });

    this.addCommand({
      id: "comment-copy-agent-prompt",
      name: "批注：复制给 Agent 的处理指令",
      callback: () => this.copyAgentPrompt(),
    });

    this.addCommand({
      id: "comment-clear-resolved",
      name: "批注：清除已处理的批注",
      checkCallback: (checking) => {
        if (!this.activeCommentDocPath()) return false;
        if (!checking) void this.clearResolvedComments();
        return true;
      },
    });

    this.addRibbonIcon("pen-line", "打开工具箱", () => {
      void this.openSidebar();
    });

    this.addRibbonIcon("library-big", "打开编辑台", () => {
      void this.openWorkbench();
    });

    this.addRibbonIcon("layout-dashboard", "打开主页", () => {
      void this.openHome();
    });


    // 右键菜单：选中文字后可直接添加批注（批注文件自身、未选中文字时不出现）
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (!this.settings.commentsEnabled) return;
        const view = (editor as any).cm as EditorView | undefined;
        if (!view) return;
        const path =
          view.state.field(editorInfoField, false)?.file?.path ?? null;
        if (!path || isSidecarPath(path)) return;
        if (
          !this.settings.commentBubbleEverywhere &&
          !this.formatToolbarAllowed(path)
        ) {
          return;
        }
        if (editor.getSelection().trim() === "") return;
        menu.addItem((item) =>
          item
            .setTitle("添加批注")
            .setIcon("message-square")
            .onClick(() => this.addCommentForView(view))
        );
      })
    );

    // 长按出菜单后吞掉紧随其后的 click；经 registerDomEvent 注册，卸载时自动移除
    this.registerDomEvent(document, "click", handleSuppressedClick, true);
    this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.settings.immersiveMode) {
        this.settings.immersiveMode = false;
        this.setImmersiveMode(false);
        this.refreshImmersiveControls();
        void this.saveSettings();
      }
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.ensureCurrentDay();
        this.lastWritingActivityAt = 0;
        this.snapshotManager.onFileSwitch();
        this.refreshSnapshotPanel();
        const file = this.app.workspace.getActiveFile();
        const text = this.getActiveEditorText();
        if (file && text !== null) {
          // 先用旧文件内容结算本番茄增量，再切换 getCount() 所依赖的最近文本。
          this.pomodoro?.rebaseBaseCount(true);
          this.lastKnownPath = file.path;
          this.lastKnownText = text;
          this.lastEditor = this.getActiveEditor();
          // 再以新文件字数设基线，避免把两份文档的总字数相减。
          this.pomodoro?.rebaseBaseCount();
          this.statusBar.onFileChange(file.path, text);
          this.statusBar.setSelectionText(this.getActiveEditorSelection());
          this.statusBar.setState({
            dailyTotal: this.dailyTotal,
            dailyGross: this.dailyGross,
            dailyGoal: this.settings.dailyGoal,
            wordCountMode: this.settings.wordCountMode,
            showSpeed: this.settings.showSpeed,
          });
        }
      })
    );

    this.registerDomEvent(document, "selectionchange", () => {
      this.statusBar.setSelectionText(this.getActiveEditorSelection());
    });

    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.handleEditorChange();
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        // 批注文件被外部（Agent / 手动编辑）改写：缓存失效并刷新标记与面板
        const commentDoc = this.commentStore.handleModified(file.path);
        if (commentDoc) this.onCommentsChanged(commentDoc);
        this.handleVaultModify(file);
      })
    );

    // 打开文件时预加载它的批注（批注文件则预加载对应源文档的）
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.primeComments(
            isSidecarPath(file.path)
              ? docPathForSidecar(file.path)
              : file.path
          );
        }
        this.refreshCommentViews();
      })
    );

    // 外部工具新建的章节文件：Obsidian 有时只发 create 不发 modify
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.invalidateProjectIndex();
        if (file instanceof TFile) {
          // 外部（Agent）新写的批注文件：同样让缓存失效并刷新
          const commentDoc = this.commentStore.handleModified(file.path);
          if (commentDoc) this.onCommentsChanged(commentDoc);
          this.handleVaultModify(file);
        }
      })
    );

    // 源文件/文件夹重命名或移动时，同步迁移所有按路径记录的状态：
    // 快照镜像、项目统计 key、活动文件引用、字数基线
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.invalidateProjectIndex();
        if (file instanceof TFile) {
          if (this.lastKnownPath === oldPath) this.lastKnownPath = file.path;
          this.statusBar.onFileRename(oldPath, file.path);
          this.migrateBaselineKey(oldPath, file.path);
          this.migrateCoverPaths(oldPath, file.path);
          // 批注：侧车本身改名 → 缓存失效；源文档改名 → 把批注文件一起搬走
          for (const docPath of this.commentStore.handleRenamed(
            oldPath,
            file.path
          )) {
            this.onCommentsChanged(docPath);
          }
          if (
            file.extension === "md" &&
            !isSidecarPath(oldPath) &&
            !isSidecarPath(file.path) &&
            !isInternalPath(oldPath) &&
            !isInternalPath(file.path)
          ) {
            void this.migrateCommentSidecar(oldPath, file.path);
          }
        } else if (file instanceof TFolder) {
          this.migrateProjectKeysOnRename(file.path, oldPath);
          this.migrateCoverPaths(oldPath, file.path);
          this.migrateBaselinePrefix(oldPath, file.path);
        }
        this.snapshotManager.onRename(file, oldPath);
      })
    );

    // 正文改名/移动（不论从哪触发）后，把 .wt-outlines 下的章纲一起搬走，
    // 否则章纲会按新路径找不到，表现为「脱钩」。
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!oldPath || isInternalPath(oldPath) || isInternalPath(file.path)) return;
        const isMarkdown = file instanceof TFile && file.extension === "md";
        const isFolder = file instanceof TFolder;
        if (!isMarkdown && !isFolder) return;
        void migrateOutlineSidecar(this.app, oldPath, file.path);
      })
    );

    // 文件删掉后旧基线一起清掉，避免同路径重建时拿旧数字做差
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.invalidateProjectIndex();
        if (file instanceof TFile) {
          this.statusBar.dropBaseline(file.path);
          // 批注文件被删：对应文档的批注视为清空
          const commentDoc = this.commentStore.handleDeleted(file.path);
          if (commentDoc) this.onCommentsChanged(commentDoc);
        } else if (file instanceof TFolder) {
          this.migrateBaselinePrefix(file.path, null);
          this.dropProjectKeys(file.path);
        }
      })
    );

    const initialFile = this.app.workspace.getActiveFile();
    if (initialFile) {
      const text = this.getActiveEditorText();
      if (text !== null) {
        this.lastKnownPath = initialFile.path;
        this.lastKnownText = text;
        this.lastEditor = this.getActiveEditor();
        this.statusBar.onFileChange(initialFile.path, text);
        this.statusBar.setSelectionText(this.getActiveEditorSelection());
        this.statusBar.setState({
          dailyTotal: this.dailyTotal,
          dailyGross: this.dailyGross,
          dailyGoal: this.settings.dailyGoal,
          wordCountMode: this.settings.wordCountMode,
          showSpeed: this.settings.showSpeed,
        });
      }
    }
  }

  onunload() {
    this.unloaded = true;
    if (this.dailySaveTimer) window.clearTimeout(this.dailySaveTimer);
    if (this.snapshotTickTimer) window.clearInterval(this.snapshotTickTimer);
    if (this.dayRolloverTimer) window.clearInterval(this.dayRolloverTimer);
    if (this.hintHideTimer) window.clearTimeout(this.hintHideTimer);
    this.immersiveHintEl?.remove();
    // 停掉番茄钟定时器，避免插件禁用/重载后旧定时器继续 tick
    this.pomodoro?.stop();
    this.snapshotManager?.unload();
    removeTypography();
    this.statusBar?.destroy();
    this.mobileStatusBar?.destroy();
    document.body.classList.remove("wt-status-only-immersive");
    setTypewriterActive(false);
    void this.savePluginData();
  }

  setTypewriterMode(on: boolean) {
    setTypewriterActive(on);
    this.app.workspace.updateOptions();
  }

  setTypewriterOffset(offset: number) {
    applyTypewriterOffset(offset);
    this.app.workspace.updateOptions();
  }

  setPunctuationAssist(on: boolean) {
    setPunctuationAssist(on);
    this.app.workspace.updateOptions();
  }

  setHardBreakOnEnter(on: boolean) {
    setHardBreakOnEnter(on);
  }

  setHemingwayMode(on: boolean) {
    setHemingwayDesired(on);
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      const cm = (view.editor as any).cm as EditorView | undefined;
      cm?.dispatch({ effects: setHemingway.of(on) });
    });
    this.app.workspace.updateOptions();
  }

  private pomodoroConfig(): PomodoroConfig {
    return {
      focusMinutes: this.settings.pomodoroFocusMinutes,
      breakMinutes: this.settings.pomodoroBreakMinutes,
      longBreakEvery: this.settings.pomodoroLongBreakEvery,
      longBreakMinutes: this.settings.pomodoroLongBreakMinutes,
    };
  }

  /** 侧栏「开启番茄钟」按钮与命令共用入口。 */
  startPomodoro(): void {
    if (this.pomodoro.start()) {
      new Notice(`番茄钟开始：专注 ${this.settings.pomodoroFocusMinutes} 分钟`);
    } else {
      new Notice("番茄钟已在进行中");
    }
  }

  /** 结束番茄钟：侧栏按钮与命令共用入口。 */
  stopPomodoro(): void {
    this.pomodoro.stop();
    new Notice("番茄钟已结束");
  }

  /** 暂停/继续番茄钟：状态栏菜单与命令共用入口。 */
  togglePomodoroPause(): void {
    const paused = this.pomodoro.getState().paused;
    this.pomodoro.togglePause();
    new Notice(paused ? "番茄钟已继续" : "番茄钟已暂停");
  }

  /** 跳过休息：状态栏菜单与命令共用入口。 */
  skipPomodoroBreak(): void {
    this.pomodoro.skipBreak();
    new Notice("已跳过休息");
  }

  getPomodoroPhase(): PomodoroPhase {
    return this.pomodoro.getState().phase;
  }

  getPomodoroState(): PomodoroState {
    return this.pomodoro.getState();
  }

  updateSidebarPomodoro(state: PomodoroState): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as WritingToolkitSidebar).updatePomodoro?.(state);
    }
  }

  private updateSidebarPomodoroButton(phase: PomodoroPhase): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as WritingToolkitSidebar).updatePomodoroButton(phase);
    }
  }

  private getPomodoroCount(): number {
    // 用 lastKnownText：从侧栏/状态栏启动番茄时活动编辑器可能为 null，
    // 用焦点无关的最近文档内容做基线，避免把整个章节字数当成番茄增量。
    const text = this.lastKnownText ?? this.getActiveEditorText();
    return text ? getWordCount(text, this.settings.wordCountMode) : 0;
  }

  private handlePomodoroComplete(result: FocusResult): void {
    const entry = this.dailyPomodoroHistory[this.todayStr]
      ?? { count: 0, words: 0 };
    entry.count += 1;
    entry.words += result.words;
    this.dailyPomodoroHistory[this.todayStr] = entry;
    this.refreshSidebar();
    if (this.settings.pomodoroAutoSnapshot) {
      void this.snapshotManager.saveSnapshotNow(false);
    }
    new Notice(
      `番茄完成！本番茄写了 ${formatNumber(result.words)} 字` +
        (this.settings.pomodoroAutoSnapshot ? "，已自动保存快照" : "")
    );
  }

  /** 今日番茄汇总：供侧栏番茄钟卡片显示。 */
  getTodayPomodoroSummary(): { count: number; words: number } | null {
    const entry = this.dailyPomodoroHistory[this.todayStr];
    return entry && entry.count > 0 ? entry : null;
  }

  /** 手机端常驻状态条：复用状态栏里已经算好的码字时速。 */
  statusBarSpeed(): number {
    return this.statusBar?.getSpeed() ?? 0;
  }

  /** 设置里切换「手机端常驻状态条」后立即生效。 */
  refreshMobileStatusBar(): void {
    this.mobileStatusBar?.syncVisibility();
  }

  setWordCountMode(mode: WordCountMode) {
    this.settings.wordCountMode = mode;
    // 先同步状态栏模式，再重建基线；否则 rebaseCurrentDocument 会按旧模式计数。
    this.statusBar.setState({
      dailyTotal: this.dailyTotal,
      dailyGross: this.dailyGross,
      dailyGoal: this.settings.dailyGoal,
      wordCountMode: mode,
      showSpeed: this.settings.showSpeed,
    });
    // 清空所有文件基线：其余文件的基线仍是旧统计模式的计数，
    // 不清空会让后续 delta 变成「新模式计数 − 旧模式基线」的巨大误差。
    this.statusBar.resetBaselines();
    // 基线清空后要重置「建档时刻」，否则今天新建的章节会被当成新文件再算一次
    this.baselinesAt = Date.now();
    this.scheduleDailySave();
    // 番茄专注中：同步重设番茄基线，避免本番茄字数被新模式计数污染
    this.pomodoro.rebaseBaseCount();
    const text = this.getActiveEditorText();
    if (text !== null) {
      this.statusBar.rebaseCurrentDocument(text, true);
      this.statusBar.setSelectionText(this.getActiveEditorSelection());
    }
    // 快照列表中的字数也依赖统计模式，需要重新读取。
    this.refreshSnapshotPanel();
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
    this.immersiveHintEl.addClass("is-visible");
    if (this.hintHideTimer) window.clearTimeout(this.hintHideTimer);
    this.hintHideTimer = window.setTimeout(() => {
      this.immersiveHintEl?.removeClass("is-visible");
    }, 4000);
  }

  setParagraphHighlight(on: boolean): void {
    setParagraphHighlight(on);
    this.app.workspace.updateOptions();
  }

  updateStatusBarVisibility(): void {
    const onlyImmersive = this.settings.statusBarOnlyImmersive ?? true;
    document.body.classList.toggle("wt-status-only-immersive", onlyImmersive);
  }

  private refreshImmersiveControls(): void {
    this.settingTab.display();
    for (const leaf of this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as WritingToolkitSidebar).refreshSettings();
    }
  }

  async openSidebar(): Promise<void> {
    if (Platform.isMobile) {
      await this.openInMobileDrawer(WRITING_TOOLKIT_SIDEBAR, "right");
      return;
    }
    const leaf =
      this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_SIDEBAR)[0] ??
      this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: WRITING_TOOLKIT_SIDEBAR, active: true });
    this.revealLeafCompat(leaf);
  }

  /**
   * 把视图所在的标签页切到前台；侧边栏收起时先展开。
   * 用 setActiveLeaf 代替 revealLeaf，以兼容 minAppVersion 1.4.0。
   */
  private revealLeafCompat(leaf: WorkspaceLeaf): void {
    const workspace = this.app.workspace;
    const root = leaf.getRoot();
    if (root === workspace.leftSplit && workspace.leftSplit.collapsed) {
      workspace.leftSplit.expand();
    } else if (root === workspace.rightSplit && workspace.rightSplit.collapsed) {
      workspace.rightSplit.expand();
    }
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  /**
   * 手机端：把视图放进左 / 右抽屉（与文件列表、搜索、反向链接并列成标签），
   * 而不是占据中间的编辑器位置。顺带清掉早前误开在中间编辑区的同类型标签。
   */
  private async openInMobileDrawer(
    type: string,
    side: "left" | "right"
  ): Promise<void> {
    const workspace = this.app.workspace;
    const target =
      side === "left"
        ? workspace.getLeftLeaf(false)
        : workspace.getRightLeaf(false);
    if (!target) return;
    for (const leaf of workspace.getLeavesOfType(type)) {
      if (leaf !== target && leaf.getRoot() === workspace.rootSplit) {
        leaf.detach();
      }
    }
    await target.setViewState({ type, active: true });
    this.revealLeafCompat(target);
  }

  /** 手机端启动时的一次自愈：把开在中间编辑区的视图挪回对应抽屉。 */
  private migrateMobileViewsToDrawers(): void {
    const workspace = this.app.workspace;
    const move = (type: string, side: "left" | "right"): void => {
      const strays = workspace
        .getLeavesOfType(type)
        .filter((leaf) => leaf.getRoot() === workspace.rootSplit);
      if (strays.length === 0) return;
      const target =
        side === "left"
          ? workspace.getLeftLeaf(false)
          : workspace.getRightLeaf(false);
      if (!target) return;
      void target
        .setViewState({ type, active: false })
        .then(() => {
          for (const leaf of strays) {
            if (leaf !== target) leaf.detach();
          }
        })
        .catch(() => {
          /* 迁移失败就保持原样，不影响使用 */
        });
    };
    move(WRITING_TOOLKIT_WORKBENCH, "left");
    move(WRITING_TOOLKIT_SIDEBAR, "right");
  }


  /** 直接打开本插件的设置页（设置窗口 → 左侧列表要滚到底才能点到，太绕）。 */
  private openSettings(): void {
    const setting = (this.app as any).setting;
    if (!setting) return;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  // ---------- 编辑台 ----------

  /** 打开「编辑台」：默认开在左侧栏（正文与章节列表并排）。 */
  async openWorkbench(): Promise<void> {
    // 手机端：编辑台放左侧抽屉，和文件列表 / 搜索一样，不占中间编辑区。
    if (Platform.isMobile) {
      await this.openInMobileDrawer(WRITING_TOOLKIT_WORKBENCH, "left");
      return;
    }
    const existing = this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_WORKBENCH)[0];
    if (existing) {
      this.revealLeafCompat(existing);
      return;
    }
    const leaf =
      this.app.workspace.getLeftLeaf(false) ??
      this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: WRITING_TOOLKIT_WORKBENCH, active: true });
    this.revealLeafCompat(leaf);
  }

  /** 打开「主页」：中间主区里的内嵌小软件（书库 / 数据统计 / 资料库）。 */
  async openHome(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_HOME)[0];
    if (existing) {
      this.revealLeafCompat(existing);
      (existing.view as WritingToolkitHome).refreshNow?.();
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: WRITING_TOOLKIT_HOME, active: true });
    this.revealLeafCompat(leaf);
  }

  /** 主页：上次停留的页面。 */
  getHomePage(): HomePage {
    return normalizeHomePage(this.homePage);
  }

  setHomePage(page: HomePage): void {
    if (this.homePage === page) return;
    this.homePage = page;
    void this.savePluginData();
  }

  /** 书架：某个作品的自定义封面（仓库内图片路径）；没有返回 null。 */
  getProjectCover(root: string): string | null {
    return this.projectCovers[root] ?? null;
  }

  setProjectCover(root: string, path: string | null): void {
    if (path === null) {
      if (!(root in this.projectCovers)) return;
      delete this.projectCovers[root];
    } else {
      if (this.projectCovers[root] === path) return;
      this.projectCovers[root] = path;
    }
    void this.savePluginData();
    this.refreshHome();
  }

  getLibraryView(): LibraryView {
    return this.libraryView === "list" ? "list" : "grid";
  }

  setLibraryView(view: LibraryView): void {
    if (this.libraryView === view) return;
    this.libraryView = view;
    void this.savePluginData();
  }

  /** 主页书桌用：今日写作时长（秒）。 */
  getTodayDurationSeconds(): number {
    return this.dailyDurationSeconds;
  }

  /** 主页（书库 / 资料库）整体刷新。 */
  refreshHome(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_HOME)) {
      (leaf.view as WritingToolkitHome).refreshNow?.();
    }
  }

  /** 编辑台：全部重建（切作品、建作品后调用）。 */
  refreshWorkbenches(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(
      WRITING_TOOLKIT_WORKBENCH
    )) {
      (leaf.view as WritingToolkitWorkbench).refreshNow?.();
    }
  }

  /** 新建作品：统一位置建目录，建完把工作台切到新作品。 */
  openNewProjectDialog(): void {
    const parent =
      (this.settings.newProjectFolder || DEFAULT_SETTINGS.newProjectFolder).trim() ||
      DEFAULT_SETTINGS.newProjectFolder;
    showNewProjectModal({
      app: this.app,
      parent,
      onCreated: (root) => {
        this.setWorkbenchProject(root);
        void this.openWorkbench().then(() => {
          this.refreshWorkbenches();
        });
        this.refreshHome();
      },
    });
  }

  /** 工作台轻量刷新：编辑器每次输入都会调用。 */
  refreshWorkbench(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(
      WRITING_TOOLKIT_WORKBENCH
    )) {
      (leaf.view as WritingToolkitWorkbench).refreshLive?.();
    }
  }

  /** 工作台：当前作品根目录（重启后恢复用）。 */
  getWorkbenchProject(): string | null {
    return this.workbenchProject;
  }

  setWorkbenchProject(root: string): void {
    if (this.workbenchProject === root) return;
    this.workbenchProject = root;
    void this.savePluginData();
  }

  /** 工作台：正文 / 资料 视图模式。 */
  getWorkbenchMode(): WorkbenchMode {
    return this.workbenchMode === "resources" ? "resources" : "chapters";
  }

  setWorkbenchMode(mode: WorkbenchMode): void {
    if (this.workbenchMode === mode) return;
    this.workbenchMode = mode;
    void this.savePluginData();
  }

  /** 工作台：某个作品的连载状态；未标注返回 null。 */
  getWorkbenchStatus(root: string): WorkbenchStatus | null {
    return this.workbenchStatus[root] ?? null;
  }

  setWorkbenchStatus(root: string, status: WorkbenchStatus | null): void {
    if (status === null) {
      if (!(root in this.workbenchStatus)) return;
      delete this.workbenchStatus[root];
    } else {
      if (this.workbenchStatus[root] === status) return;
      this.workbenchStatus[root] = status;
    }
    void this.savePluginData();
  }

  /** 工作台：某个作品是否在切换面板里被隐藏。 */
  isProjectHidden(root: string): boolean {
    return this.hiddenProjects[root] === true;
  }

  setProjectHidden(root: string, hidden: boolean): void {
    if (hidden) {
      if (this.hiddenProjects[root]) return;
      this.hiddenProjects[root] = true;
    } else {
      if (!(root in this.hiddenProjects)) return;
      delete this.hiddenProjects[root];
    }
    void this.savePluginData();
    this.refreshHome();
  }

  /** 工作台：某个文件的快照列表。 */
  async listSnapshotEntries(path: string): Promise<SnapshotEntry[]> {
    return this.snapshotManager.listSnapshots(path, this.settings.wordCountMode);
  }

  /** 工作台：打开指定文件最近快照的对比窗口。 */
  async openSnapshotDiffFor(path: string): Promise<void> {
    const entries = await this.snapshotManager.listSnapshots(
      path,
      this.settings.wordCountMode
    );
    if (entries.length === 0) {
      new Notice("写作工具箱：当前章节还没有快照");
      return;
    }
    showSnapshotDiff(this, path, entries[0].path, entries[0].name, () =>
      this.refreshSnapshotPanel()
    );
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
      const { shell } = require("electron");
      shell.showItemInFolder(full);
    } catch {
      new Notice("无法在系统文件管理器中显示");
    }
  }

  private refreshSidebar(text?: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as WritingToolkitSidebar).refresh(text);
    }
    this.refreshWorkbench();
    for (const leaf of this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_HOME)) {
      (leaf.view as WritingToolkitHome).refreshLive?.();
    }
  }

  private refreshSnapshotPanel(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as WritingToolkitSidebar).refreshSnapshotList();
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
    const view = this.app.workspace.activeEditor;
    if (!view || !("editor" in view)) return null;
    return view.editor ?? null;
  }

  /** 校验编辑器引用是否仍挂在工作区（文件关闭后 lastEditor 会失效）。 */
  isEditorValid(editor: Editor): boolean {
    let valid = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as unknown as { editor?: Editor };
      if (view && view.editor === editor) valid = true;
    });
    return valid;
  }

  private getActiveEditorText(): string | null {
    const view = this.app.workspace.activeEditor;
    if (!view || !("editor" in view)) return null;
    const editor = view.editor;
    if (!editor) return null;
    return editor.getValue();
  }

  private getActiveEditorSelection(): string {
    const view = this.app.workspace.activeEditor;
    if (!view || !("editor" in view) || !view.editor) return "";
    return view.editor.getSelection();
  }

  private handleEditorChange(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    const text = this.getActiveEditorText();
    if (text === null) return;

    const editor = this.getActiveEditor();
    const pending = this.pendingProgrammaticEdit;
    const isProgrammatic =
      pending !== null && pending.editor === editor && pending.text === text;
    if (pending !== null) this.pendingProgrammaticEdit = null;

    // 外部同步刷新：AI 修改后 Obsidian 刷新编辑器内容触发的 editor-change，
    // 字数已在 processVaultModify 统计过，且不应计入用户写作时长。
    const isExternalSync = this.lastExternalSyncText === text;
    if (isExternalSync) this.lastExternalSyncText = null;

    this.lastKnownPath = file.path;
    this.lastKnownText = text;
    this.lastEditor = editor;
    this.snapshotManager.onEditorChange(file, text);
    this.ensureCurrentDay();
    // 插件刚加载、编辑器还没就绪时（没触发过 active-leaf-change），状态栏并不知道
    // "当前是哪个文件"。先补建一次基线再算增量，否则会拿别的文档的基线做差。
    if (!this.statusBar.hasCurrentFile()) {
      this.statusBar.onFileChange(file.path, text);
    }
    // 全新文件的第一笔内容（粘贴整章、AI 通过编辑器写入）整份算新增
    const freshFile =
      !isProgrammatic &&
      !this.statusBar.hasBaseline(file.path) &&
      this.isFreshlyCreated(file);
    const delta = isProgrammatic
      ? (this.statusBar.rebaseCurrentDocument(text), 0)
      : this.statusBar.onEditorChange(text, freshFile);
    this.statusBar.setSelectionText(this.getActiveEditorSelection());

    if (this.isDailyCountFile(file.path)) {
      if (isProgrammatic) {
        this.lastWritingActivityAt = 0;
        this.pomodoro.rebaseBaseCount();
      } else {
        this.applyDailyStats(file, delta, !isExternalSync);
      }
    } else {
      this.lastWritingActivityAt = 0;
    }

    this.statusBar.setState({
      dailyTotal: this.dailyTotal,
      dailyGross: this.dailyGross,
      dailyGoal: this.settings.dailyGoal,
      wordCountMode: this.settings.wordCountMode,
      showSpeed: this.settings.showSpeed,
    });
    this.refreshSidebar(text);
  }

  /**
   * 外部修改统计：AI 代理、脚本等直接改写文件时，
   * Obsidian 只触发 vault 的 modify 事件，不触发编辑器输入。
   * 这里按文件基线累计每日净增字数（不计入用户写作时长）。
   */
  private handleVaultModify(file: TFile): void {
    if (!file.extension || file.extension.toLowerCase() !== "md") return;
    if (!this.isDailyCountFile(file.path)) return;
    // 串行处理：AI 连续多次写入时，避免多个异步读盘交错导致漏计或基线倒退
    this.externalModifyQueue = this.externalModifyQueue
      .then(() => this.processVaultModify(file))
      .catch((e) => console.error("写作工具箱：外部修改统计失败", e));
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
      delta =
        getWordCount(text, this.settings.wordCountMode) -
        getWordCount(this.lastKnownText, this.settings.wordCountMode);
      this.lastKnownText = text;
      // 记录外部写入内容，供 editor-change 识别同步刷新
      this.lastExternalSyncText = text;
      this.statusBar.rebaseCurrentDocument(text);
      // 番茄钟专注中：把外部字数变化同步进基线，避免 AI 的增删算进本番茄字数
      this.pomodoro.adjustBaseCount(delta);
    } else {
      delta = this.statusBar.hasBaseline(file.path)
        ? this.statusBar.onExternalFileChange(file.path, text)
        : this.handleUnknownFile(file, text);
    }
    this.applyDailyStats(file, delta, false);
    this.statusBar.setState({
      dailyTotal: this.dailyTotal,
      dailyGross: this.dailyGross,
      dailyGoal: this.settings.dailyGoal,
      wordCountMode: this.settings.wordCountMode,
      showSpeed: this.settings.showSpeed,
    });
    this.refreshSidebar(text);
  }

  /**
   * 把一次字数变化计入每日/作品/时长统计（调用方保证是正文草稿文件）。
   * countDuration=false 用于外部/AI 修改：只统计字数，不虚增用户写作时长。
   */
  private applyDailyStats(file: TFile, delta: number, countDuration = true): void {
    this.ensureCurrentDay();
    if (countDuration) this.recordWritingActivity();
    const project = this.getProjectForPath(file.path) ?? "未分组";
    if (!this.knownProjects.has(project)) {
      this.knownProjects.add(project);
      this.refreshSidebarSettings();
    }
    if (delta !== 0) {
      this.dailyTotal += delta;
      this.dailyHistory[this.todayStr] = this.dailyTotal;
      const projectDay = this.projectHistory[project]
        ?? (this.projectHistory[project] = {});
      projectDay[this.todayStr] = (projectDay[this.todayStr] || 0) + delta;

      // 明细：今天这个数是哪个文件贡献的（负数是删除/回退）
      const fileDay = this.dailyFileDeltas[this.todayStr]
        ?? (this.dailyFileDeltas[this.todayStr] = {});
      fileDay[file.path] = (fileDay[file.path] || 0) + delta;

      // 毛新增：只累加变多的部分，重写一天也不会显示 0 或负数
      if (delta > 0) {
        this.dailyGross += delta;
        this.dailyGrossHistory[this.todayStr] = this.dailyGross;
        const projectGross = this.projectGrossHistory[project]
          ?? (this.projectGrossHistory[project] = {});
        projectGross[this.todayStr] = (projectGross[this.todayStr] || 0) + delta;
      }
    }
    this.dailyDurationHistory[this.todayStr] = this.dailyDurationSeconds;
    const durationInc = this.dailyDurationSeconds - this.lastDurationTotal;
    if (durationInc > 0) {
      const projectDay = this.projectDurationHistory[project]
        ?? (this.projectDurationHistory[project] = {});
      projectDay[this.todayStr] = (projectDay[this.todayStr] || 0) + durationInc;
    }
    this.lastDurationTotal = this.dailyDurationSeconds;
    this.scheduleDailySave();
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

  /** 快照文件夹（规范化路径，去首尾斜杠）。 */
  private snapshotFolder(): string {
    return (
      this.settings.snapshotFolder.trim() ||
      ".wt-snapshots"
    ).replace(/^\/+|\/+$/g, "");
  }

  /** 是否位于快照文件夹内（快照镜像路径可能含「正文草稿」，不应计入正文统计）。 */
  private isSnapshotPath(path: string): boolean {
    const folder = this.snapshotFolder();
    if (!folder) return false;
    return path === folder || path.startsWith(folder + "/");
  }

  // ---------- 作品索引（判断"算不算正文"的依据） ----------

  /** 作品索引：按需重建，库结构变化时失效。 */
  private projectIndex(): NovelProject[] {
    if (!this.projectIndexCache) {
      this.projectIndexCache = discoverProjects(this.app, {
        draftKeywords: this.settings.draftKeywords,
        excludeNames: this.settings.chapterExcludeNames,
        extraExcluded: [this.snapshotFolder()],
      });
      this.chapterPathCache = null;
    }
    return this.projectIndexCache;
  }

  private invalidateProjectIndex(): void {
    this.projectIndexCache = null;
    this.chapterPathCache = null;
  }

  /** 全部正文章节的路径集合（判断取用 O(1)）。 */
  private chapterPaths(): Set<string> {
    if (!this.chapterPathCache) {
      const set = new Set<string>();
      for (const project of this.projectIndex()) {
        for (const chapter of allChapters(project)) set.add(chapter.file.path);
      }
      this.chapterPathCache = set;
    }
    return this.chapterPathCache;
  }

  /**
   * 这个文件算不算「正文」。
   *
   * 以前是"路径里有没有『正文草稿』四个字"，会把 .wt-outlines 下镜像的章纲
   * 也算进来（它的路径同样含正文草稿），还会漏掉按「第N卷」分目录的存档长篇。
   * 现在直接用作品识别的结果：只有被认作章节的文件才算。
   */
  private isDailyCountFile(path: string): boolean {
    if (isInternalPath(path)) return false;
    return this.chapterPaths().has(path);
  }

  /** 作品标识：该文件所属作品的根目录；不属于任何作品返回 null。 */
  private getProjectForPath(path: string): string | null {
    if (isInternalPath(path)) return null;
    return projectForPath(path, this.projectIndex())?.root ?? null;
  }

  /** 编辑工具条 / 格式命令：该路径是否在生效范围内（按设置里的范围三选一）。 */
  private formatToolbarAllowed(path: string | null): boolean {
    const scope = this.settings.formatToolbarScope;
    if (scope === "all") return true;
    if (!path || isInternalPath(path)) return scope !== "library-only";
    if (scope === "library-only") {
      if (this.getProjectForPath(path)) return true;
      const library = this.settings.sharedLibraryFolder.replace(/\/+$/, "");
      return library !== "" && path.startsWith(library + "/");
    }
    // all-except-chapters：正文（草稿目录里的章节）里不浮出
    return !this.chapterPaths().has(path);
  }

  /** 格式命令入口：作用于当前编辑器的主选区（范围设置与浮出工具条一致）。 */
  private applyFormatToEditor(editor: Editor, kind: FormatKind): void {
    const view = (editor as any).cm as EditorView | undefined;
    if (!view) return;
    const path = view.state.field(editorInfoField, false)?.file?.path ?? null;
    if (!this.formatToolbarAllowed(path)) {
      new Notice("这个文件不在格式工具的生效范围里（设置 → 写作 → 编辑工具条）");
      return;
    }
    applyFormatOnView(view, kind);
  }

  /* ---------- 批注（与 Agent 协作的核心工作流） ---------- */

  /**
   * 活动文档的批注归属路径：普通文档 → 自身；批注文件 → 其源文档。
   * 焦点在工具箱 / 批注面板等侧栏上时 getActiveFile 可能拿不到文件，
   * 统一回退到「最近活动的 Markdown 文档」。
   */
  private activeCommentDocPath(): string | null {
    const toDocPath = (path: string): string =>
      isSidecarPath(path) ? docPathForSidecar(path) : path;
    const file = this.app.workspace.getActiveFile();
    if (file && file.extension === "md") return toDocPath(file.path);
    const view = this.currentMarkdownView();
    if (view?.file) return toDocPath(view.file.path);
    return null;
  }

  /** 预加载某文档的批注；加载完成后刷新标记与面板。 */
  private primeComments(docPath: string): void {
    if (this.commentStore.getCached(docPath)) return;
    void this.commentStore
      .load(docPath)
      .then(() => this.onCommentsChanged(docPath))
      .catch((error) => console.error("写作工具箱：预加载批注失败", error));
  }

  /** 某文档的批注有变化：刷新打开中的编辑器标记 + 侧栏批注面板。 */
  private onCommentsChanged(docPath: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path !== docPath) continue;
      dispatchCommentRefresh(
        ((view.editor as any)?.cm ?? undefined) as EditorView | undefined
      );
    }
    this.refreshCommentViews();
  }

  /**
   * 刷新所有打开的批注面板（独立视图 + 工具箱「批注」标签）。
   *
   * 逐项检查方法是否存在：侧栏叶子上的视图实例不一定是这两个类
   * （视图被替换 / 尚未初始化完时也在 getLeavesOfType 的结果里），
   * 直接调用会抛 "refreshComments is not a function"，
   * 把「保存批注」这一步带着一起失败。
   */
  private refreshCommentViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(
      WRITING_TOOLKIT_SIDEBAR
    )) {
      const view = leaf.view as unknown as Partial<WritingToolkitSidebar> | null;
      if (typeof view?.refreshComments === "function") view.refreshComments();
    }
  }

  /** 刷新所有打开编辑器里的批注痕迹（开关变化等全局场景用）。 */
  refreshAllCommentDecors(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      dispatchCommentRefresh(
        ((view.editor as any)?.cm ?? undefined) as EditorView | undefined
      );
    }
  }

  /** 修改某文档的批注列表：读 → 改 → 存 → 刷新（批注变更的统一入口）。 */
  private async mutateComments(
    docPath: string,
    mutator: (list: WtComment[]) => WtComment[]
  ): Promise<void> {
    try {
      const list = await this.commentStore.reload(docPath);
      const next = mutator([...list]);
      await this.commentStore.save(docPath, next);
      this.onCommentsChanged(docPath);
    } catch (error) {
      console.error("写作工具箱：保存批注失败", error);
      new Notice("批注保存失败（详见控制台）");
    }
  }

  /** 「当前工作的 Markdown 编辑器」：焦点在侧栏时回退到最近活动的文档。 */
  private currentMarkdownView(): MarkdownView | null {
    const direct = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (direct) return direct;
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    if (leaves.length === 0) return null;
    if (this.lastKnownPath) {
      for (const leaf of leaves) {
        const view = leaf.view as MarkdownView;
        if (view.file?.path === this.lastKnownPath) return view;
      }
    }
    return leaves.length === 1 ? (leaves[0].view as MarkdownView) : null;
  }

  /**
   * 气泡批注按钮 / 右键菜单 / 命令 / 面板按钮：为编辑器选区添加批注。
   *
   * 编辑器里不再弹跟随光标的浮层（它会随正文滚动而「跳」），
   * 改成屏幕居中的输入框：位置固定，写完直接落进批注文件。
   */
  addCommentForView(view: EditorView): void {
    if (!this.settings.commentsEnabled) {
      new Notice("批注功能已关闭（设置 → 写作 → 批注）");
      return;
    }
    const path = view.state.field(editorInfoField, false)?.file?.path ?? null;
    if (!path || isSidecarPath(path)) return;
    const sel = view.state.selection.main;
    const quote = view.state.sliceDoc(sel.from, sel.to).trim();
    if (!quote) {
      new Notice("先选中要批注的文字");
      return;
    }
    const lineHint = view.state.doc.lineAt(sel.from).number;
    // 段落与段落序号：Agent 改稿后靠它把批注迁回原文（见 comments.ts 的四层定位）
    const paragraph = paragraphAt(view.state.doc.toString(), sel.from);
    const sidecarName = sidecarPathFor(path).split("/").pop() ?? "";

    // 先把锚点信息落盘拿到新 id；用户取消就把它删掉，不留空批注
    let created: number | null = null;
    void this.mutateComments(path, (list) => {
      const id = nextCommentId(list);
      created = id;
      return [
        ...list,
        {
          id,
          status: "pending" as const,
          quote,
          paragraph: paragraph?.text.trim() ?? "",
          paragraphHint: paragraph?.index ?? 0,
          lineHint,
          createdAt: formatTimestamp(),
          content: "",
          reply: "",
          current: "",
        },
      ];
    });

    const isMyComment = (c: { id: number }) => c.id === created;

    new CommentDraftModal(
      this.app,
      "添加批注",
      "",
      (content) => {
        // created 到这里必然已赋值（落盘是同步排队的，弹窗要点两下才可能保存）
        void this.mutateComments(path, (list) =>
          list.map((c) => (isMyComment(c) ? { ...c, content } : c))
        );
        new Notice(`批注已保存到「${sidecarName}」`);
      },
      () => {
        // 取消：把刚建的空批注撤掉（只删自己建的那条，不碰别人的）
        void this.mutateComments(path, (list) =>
          list.filter((c) => !isMyComment(c) || c.content.trim() !== "")
        );
      }
    ).open();
  }

  /** 文档当前开着（且在编辑区）时的视图；没有则 null。 */
  private markdownViewForPath(path: string): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === path) return view;
    }
    return null;
  }

  /** 打开「编辑这条批注」的输入框（屏幕居中，不再跟随光标）。 */
  private openCommentEditor(path: string, comment: WtComment): void {
    new CommentDraftModal(
      this.app,
      `批注 ${comment.id}`,
      comment.content,
      (content) => {
        void this.mutateComments(path, (list) =>
          list.map((c) => (c.id === comment.id ? { ...c, content } : c))
        );
      }
    ).open();
  }

  /** 标记/取消标记某条批注为「已处理」。 */
  private async toggleCommentResolvedFor(
    path: string,
    id: number
  ): Promise<void> {
    await this.mutateComments(path, (list) =>
      list.map((c) =>
        c.id === id
          ? { ...c, status: c.status === "resolved" ? "pending" : "resolved" }
          : c
      )
    );
  }

  /**
   * 删除某条批注。
   *
   * 只保留「点两次」这一道确认（按钮上的「删除 → 确认」，3 秒内有效），
   * 不再另弹居中确认框：两道确认叠在一起要连点三次才删得掉，太绕。
   * 删掉后 6 秒内可以在提示里点「撤销」恢复，误删也有退路。
   */
  private async deleteCommentById(path: string, id: number): Promise<void> {
    const list = await this.commentStore.load(path);
    const index = list.findIndex((c) => c.id === id);
    if (index < 0) return;
    const removed = list[index];
    await this.mutateComments(path, (l) => l.filter((c) => c.id !== id));
    this.showUndoNotice(`已删除批注 #${id}`, () => {
      void this.mutateComments(path, (l) => {
        if (l.some((c) => c.id === id)) return l;
        const next = [...l];
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      });
    });
  }

  /** 顶部提示 + 「撤销」按钮（批注删除用）。 */
  private showUndoNotice(text: string, onUndo: () => void): void {
    const fragment = document.createDocumentFragment();
    const label = document.createElement("span");
    label.textContent = text;
    const undoBtn = document.createElement("button");
    undoBtn.className = "wt-notice-undo";
    undoBtn.textContent = "撤销";
    fragment.append(label, undoBtn);
    const notice = new Notice(fragment, 6000);
    undoBtn.addEventListener("click", () => {
      notice.hide();
      onUndo();
    });
  }

  /** 清除当前文档里所有已处理的批注（先确认；Agent 的回复会一起清掉）。 */
  async clearResolvedComments(): Promise<void> {
    const path = this.activeCommentDocPath();
    if (!path) {
      new Notice("先打开一篇文档");
      return;
    }
    const list = await this.commentStore.load(path);
    const resolved = list.filter((c) => c.status === "resolved").length;
    if (resolved === 0) {
      new Notice("这篇文档还没有已处理的批注");
      return;
    }
    new ConfirmModal(
      this.app,
      "清除已处理的批注",
      `将删除这篇文档里的 ${resolved} 条已处理批注（Agent 的回复会一起删掉），正文不受影响。此操作不能撤销。`,
      "清除",
      () => void this.doClearResolvedComments(path, resolved),
      true
    ).open();
  }

  /** 面板卡片：编辑某条批注（居中输入框；原文定位失败的批注也能编辑）。 */
  editComment(id: number): void {
    const docPath = this.activeCommentDocPath();
    if (!docPath) return;
    const comment = (this.commentStore.getCached(docPath) ?? []).find(
      (c) => c.id === id
    );
    if (!comment) return;
    this.openCommentEditor(docPath, comment);
  }

  /** 面板卡片：删除某条批注。 */
  deleteComment(id: number): void {
    const docPath = this.activeCommentDocPath();
    if (!docPath) return;
    void this.deleteCommentById(docPath, id);
  }

  /**
   * 锚点失效的批注：把正文里当前选中的文字重新绑给它。
   * 没有选区时先提示选中（选区在编辑器里会保留，用户选完再点一次即可）。
   */
  rebindComment(id: number): void {
    const docPath = this.activeCommentDocPath();
    if (!docPath) return;
    const comment = (this.commentStore.getCached(docPath) ?? []).find(
      (c) => c.id === id
    );
    if (!comment) return;
    const view = this.markdownViewForPath(docPath) ?? this.currentMarkdownView();
    const cm = ((view?.editor as any)?.cm ?? undefined) as
      | EditorView
      | undefined;
    const sel = cm?.state.selection.main ?? null;
    const picked =
      cm && sel && !sel.empty
        ? cm.state.sliceDoc(sel.from, sel.to).trim()
        : "";
    if (!cm || !sel || !picked) {
      new Notice(`先在正文里选中批注 #${id} 现在对应的文字，再点一次「重新绑定」`);
      view?.editor?.focus();
      return;
    }
    const paragraph = paragraphAt(cm.state.doc.toString(), sel.from);
    const lineHint = cm.state.doc.lineAt(sel.from).number;
    void this.mutateComments(docPath, (list) =>
      list.map((c) =>
        c.id === id
          ? {
              ...c,
              quote: picked,
              paragraph: paragraph?.text.trim() ?? "",
              paragraphHint: paragraph?.index ?? 0,
              lineHint,
              // 旧的「现文」已经对不上了，清掉，免得下次定位又被它带偏
              current: "",
            }
          : c
      )
    );
    new Notice(`已把批注 #${id} 重新绑定到选中的文字`);
  }

  /** 确认弹窗点「清除」后执行：删掉该文档全部已处理批注。 */
  private async doClearResolvedComments(
    path: string,
    resolved: number
  ): Promise<void> {
    await this.mutateComments(path, (l) =>
      l.filter((c) => c.status !== "resolved")
    );
    new Notice(`已清除 ${resolved} 条已处理批注`);
  }

  /** 复制「让 Agent 处理批注」的现成指令到剪贴板。 */
  copyAgentPrompt(): void {
    const docPath = this.activeCommentDocPath();
    if (!docPath) {
      new Notice("先打开一篇文档");
      return;
    }
    void this.commentStore
      .load(docPath)
      .then((list) => {
        const pending = list.filter((c) => c.status === "pending").length;
        if (pending === 0) {
          new Notice("这篇文档没有待处理的批注");
          return;
        }
        const prompt = buildAgentPrompt(docPath, {
          pending,
          resolved: list.length - pending,
        });
        navigator.clipboard.writeText(prompt).then(
          () =>
            new Notice(
              `已复制处理指令（${pending} 条待处理）：发给 Agent，它会按批注文件改稿`
            ),
          () => new Notice("复制到剪贴板失败")
        );
      })
      .catch((error) => {
        console.error("写作工具箱：读取批注失败", error);
        new Notice("读取批注失败（详见控制台）");
      });
  }

  /**
   * 点正文里的批注标记 / 脚注号：打开工具箱侧栏的「批注」标签，
   * 滚到那条批注的卡片并闪一下。编辑器里不再弹任何浮层。
   */
  revealCommentInPanel(path: string, id: number): void {
    const reveal = () => {
      const leaves = this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_SIDEBAR);
      for (const leaf of leaves) {
        (leaf.view as WritingToolkitSidebar).revealCommentCard?.(id);
      }
      return leaves.length > 0;
    };
    void this.openSidebar()
      .then(() => {
        // 刚 setViewState 时侧栏 DOM 可能还没建好，没有就稍后再试一次
        if (reveal()) return;
        window.setTimeout(reveal, 120);
      })
      .catch(() => {
        // 侧栏打不开（极少数布局情况）：提示一下，批注面板就在工具箱里
        new Notice("没打开工具箱侧栏，可在左侧栏打开「工具箱」看批注列表");
      });
    void path;
  }



  /**
   * 复制某篇文档的干净正文（编辑台章节列表里的复制按钮调用）。
   *
   * 正文里的批注标记（淡色底、行尾脚注序号）是编辑器渲染层（CM6 装饰），
   * 不在文档文本里；批注内容另存在同目录的「.批注.md」里 —— 所以取文件文本
   * 就是干净的正文，不需要做任何剥离。文档开着就用编辑器里正在编辑的内容。
   */
  async copyCleanChapter(path: string): Promise<void> {
    if (isSidecarPath(path) || isInternalPath(path)) return;
    let text: string | null = null;
    const open = this.markdownViewForPath(path);
    if (open?.editor) {
      text = open.editor.getValue();
    } else {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        new Notice("找不到这篇文档");
        return;
      }
      try {
        text = await this.app.vault.cachedRead(file);
      } catch (error) {
        console.error("写作工具箱：读取正文失败", error);
        new Notice("读取正文失败（详见控制台）");
        return;
      }
    }
    if (text === null || text.trim() === "") {
      new Notice("这篇文档是空的");
      return;
    }
    // 去掉尾部多余空行，粘到别处不带一串空白
    const payload = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}$/g, "\n");
    const name = path.split("/").pop()?.replace(/\.md$/i, "") ?? "本章";
    try {
      await navigator.clipboard.writeText(payload);
      new Notice(`已复制「${name}」正文 ${payload.length} 字（批注标记只在编辑器里显示，不会带出去）`);
    } catch (error) {
      console.error("写作工具箱：复制正文失败", error);
      new Notice("复制到剪贴板失败（详见控制台）");
    }
  }

  /** 侧栏面板：取当前活动文档的批注模型（含定位信息，异步）。 */
  async getCommentPanelModel(): Promise<CommentPanelModel> {
    const docPath = this.activeCommentDocPath();
    if (!docPath) {
      return { docPath: null, docName: null, loading: false, items: [] };
    }
    const active = this.app.workspace.getActiveFile();
    const base = (docPath.split("/").pop() ?? docPath).replace(/\.md$/i, "");
    const docName =
      active && isSidecarPath(active.path) ? `${base}（批注文件）` : base;
    let loading = false;
    if (!this.commentStore.getCached(docPath)) {
      loading = true;
      try {
        await this.commentStore.load(docPath);
      } catch (error) {
        console.error("写作工具箱：读取批注失败", error);
      }
      loading = false;
    }
    const comments = this.commentStore.getCached(docPath) ?? [];
    const docText = await this.readDocTextForLocate(docPath);
    const located =
      docText === null ? [] : locateAll(docText, comments);
    const byId = new Map(located.map((l) => [l.comment.id, l]));
    const items: CommentPanelItem[] = comments.map((c) => {
      const hit = byId.get(c.id);
      return {
        id: c.id,
        status: c.status,
        quote: c.quote,
        content: c.content,
        reply: c.reply,
        lineHint: c.lineHint,
        createdAt: c.createdAt,
        locatedLine: hit ? hit.lineFrom : null,
        via: hit ? hit.via : null,
      };
    });
    return { docPath, docName, loading, items };
  }

  /** 面板定位用：文档正开在编辑器里就用编辑器文本，否则读盘。 */
  private async readDocTextForLocate(docPath: string): Promise<string | null> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === docPath && view.editor) {
        return view.editor.getValue();
      }
    }
    const file = this.app.vault.getAbstractFileByPath(docPath);
    if (file instanceof TFile) {
      try {
        return await this.app.vault.cachedRead(file);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 侧栏面板：跳到某条批注对应的原文位置。 */
  jumpToComment(id: number): void {
    const docPath = this.activeCommentDocPath();
    if (!docPath) return;
    const comment = (this.commentStore.getCached(docPath) ?? []).find(
      (c) => c.id === id
    );
    if (!comment) return;
    const file = this.app.vault.getAbstractFileByPath(docPath);
    if (!(file instanceof TFile)) return;
    void this.revealCommentInDoc(file, comment);
  }

  /** 在指定路径的文档里选中这条批注的原文（面板「点击引用」跳转用）。 */
  private revealCommentByPath(path: string, comment: WtComment): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    void this.revealCommentInDoc(file, comment);
  }

  private async revealCommentInDoc(
    file: TFile,
    comment: WtComment
  ): Promise<void> {
    let target: WorkspaceLeaf | null = null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if ((leaf.view as MarkdownView).file?.path === file.path) {
        target = leaf;
        break;
      }
    }
    if (!target) {
      // 文档没开着：新开一个标签页，避免顶掉当前视图（面板本身占着焦点）
      target = this.app.workspace.getLeaf("tab");
      await target.openFile(file);
    }
    this.revealLeafCompat(target);
    const view = target.view instanceof MarkdownView ? target.view : null;
    if (!view) return;
    const editor = view.editor;
    const span = new AnchorLocator(editor.getValue()).locate(comment);
    if (!span) {
      new Notice(
        "找不到这条批注对应的原文（正文改动较大）——可在批注面板点「重新绑定」"
      );
      return;
    }
    const from = editor.offsetToPos(span.from);
    const to = editor.offsetToPos(span.to);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    editor.focus();
    if (span.via !== "exact" && span.via !== "present") {
      new Notice(LOCATE_VIA_LABELS[span.via]);
    }
  }

  /** 侧栏面板：标记/取消标记已处理。 */
  toggleCommentResolved(id: number): void {
    const path = this.activeCommentDocPath();
    if (!path) return;
    void this.toggleCommentResolvedFor(path, id);
  }

  /** 源文档改名/移动时，把它的批注文件一起搬走（不覆盖新位置已存在的文件）。 */
  private async migrateCommentSidecar(
    oldPath: string,
    newPath: string
  ): Promise<void> {
    try {
      const oldSidecar = this.app.vault.getAbstractFileByPath(
        sidecarPathFor(oldPath)
      );
      if (!(oldSidecar instanceof TFile)) return;
      const newSidecarPath = sidecarPathFor(newPath);
      if (this.app.vault.getAbstractFileByPath(newSidecarPath)) return;
      await this.app.vault.rename(oldSidecar, newSidecarPath);
      this.commentStore.invalidate(oldPath);
      this.commentStore.invalidate(newPath);
    } catch (error) {
      console.error("写作工具箱：迁移批注文件失败", error);
    }
  }

  /* ---------- 格式工具条 · 自检（排查气泡不出现） ---------- */

  /**
   * 「格式：自检」：一次性检查浮出工具条的各环节，把结果写到库里的报告文件，
   * 气泡不出现时用它收集排查信息（报告看完可删）。
   */
  private async runFormatSelfCheck(): Promise<void> {
    await this.writeDiagnosticReport(this.buildFormatSelfCheckText("手动命令"), true);
  }

  /** 组装自检报告文本（手动命令 / 启动快照 / 选中自动捕获共用） */
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
      const cmFromEditor = ((mview?.editor as any)?.cm ?? undefined) as EditorView | undefined;
      push(`- editor.cm 可用：${String(cmFromEditor !== undefined)}`);
      const domEl = document.querySelector(".cm-editor");
      const cmFromDom = domEl ? EditorView.findFromDOM(domEl as HTMLElement) : null;
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
          push(`- formatToolbarAllowed：${String(this.formatToolbarAllowed(path))}`);
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

  /** 把诊断文本写进库里的报告文件；interactive=手动命令时给通知并复制剪贴板 */
  private async writeDiagnosticReport(text: string, interactive: boolean): Promise<void> {
    console.log(text);
    const inbox = "0-收件箱";
    const reportPath = this.app.vault.getAbstractFileByPath(inbox)
      ? `${inbox}/写作工具箱-自检报告.md`
      : "写作工具箱-自检报告.md";
    try {
      const existing = this.app.vault.getAbstractFileByPath(reportPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, text);
      } else {
        await this.app.vault.create(reportPath, text);
      }
      if (interactive) {
        new Notice(`格式工具条自检完成，报告已写入「${reportPath}」`, 8000);
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

  /**
   * 侧栏「统计范围」下拉框的作品列表。
   * keepKey 传当前选中的作品，即使它已被隐藏也保留一行，避免选中项从下拉框里消失。
   */
  getProjects(keepKey?: string | null): { key: string; label: string }[] {
    const keys = new Set<string>();
    // 过滤早期版本可能残留的快照目录键（如 .wt-snapshots）
    for (const key of Object.keys(this.projectHistory)) {
      if (!this.isSnapshotPath(key)) keys.add(key);
    }
    for (const key of Object.keys(this.projectDurationHistory)) {
      if (!this.isSnapshotPath(key)) keys.add(key);
    }
    // 从库内扫描「正文草稿」目录：还没有数据的作品也列出来，保证下拉框可用
    for (const file of this.app.vault.getMarkdownFiles()) {
      const project = this.getProjectForPath(file.path);
      if (project) keys.add(project);
    }
    const list = [...keys].map((key) => ({
      key,
      label: key.split("/").pop() || key,
    }));
    list.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    // 工作台里隐藏的作品不进统计范围下拉（当前正选中的那个除外，避免选中项消失）
    return list.filter(
      (item) => !this.isProjectHidden(item.key) || item.key === keepKey
    );
  }

  /**
   * 热力图 / 今日目标显示用的每日数字。
   * 新数据用「毛新增」（只累加变多的部分，不会为负）；毛新增还没有记录的
   * 历史日期回落到净增，免得老数据凭空消失。
   */
  dailyForDisplay(): DailyHistory {
    const out: DailyHistory = { ...this.dailyHistory };
    for (const [day, gross] of Object.entries(this.dailyGrossHistory)) {
      out[day] = gross;
    }
    return out;
  }

  /** 同上，但限定某个作品（用于「统计范围」下拉）。 */
  projectForDisplay(key: string): DailyHistory {
    const out: DailyHistory = { ...(this.projectHistory[key] || {}) };
    const gross = this.projectGrossHistory[key] || {};
    for (const [day, value] of Object.entries(gross)) out[day] = value;
    return out;
  }

  /** 今日字数明细：查出"今天这个数是怎么来的"。 */
  showDailyBreakdown(): void {
    const day = this.todayStr;
    const deltas = this.dailyFileDeltas[day] || {};
    const entries = Object.entries(deltas)
      .filter(([, value]) => value !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (entries.length === 0) {
      new Notice("今天还没有字数变化记录");
      return;
    }
    const lines = entries.slice(0, 8).map(([path, value]) => {
      const name = path.split("/").pop() ?? path;
      return `${value > 0 ? "+" : ""}${formatNumber(value)}  ${name}`;
    });
    const net = entries.reduce((sum, [, value]) => sum + value, 0);
    new Notice(
      `今日新增 ${formatNumber(this.dailyGross)} 字 · 净增 ${formatNumber(net)} 字\n` +
        lines.join("\n") +
        (entries.length > 8 ? `\n…另有 ${entries.length - 8} 个文件` : ""),
      12000
    );
  }

  /** 侧栏整体重绘（统计范围下拉等依赖作品列表的部分需要跟着刷新）。 */
  refreshSidebarSettings(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WRITING_TOOLKIT_SIDEBAR)) {
      (leaf.view as WritingToolkitSidebar).refreshSettings();
    }
    this.refreshHome();
  }

  /**
   * 作品目录改名后迁移按作品统计的 key（projectHistory / projectDurationHistory），
   * 避免历史字数/时长"消失"在新目录名下。
   */
  /** 作品目录或封面图片改名 / 移动后，封面记录（键和图片路径）跟着搬。 */
  private migrateCoverPaths(oldPath: string, newPath: string): void {
    if (!oldPath || oldPath === newPath) return;
    const prefix = oldPath + "/";
    const moved = (p: string): string | null =>
      p === oldPath
        ? newPath
        : p.startsWith(prefix)
          ? newPath + p.slice(oldPath.length)
          : null;
    let changed = false;
    const next: Record<string, string> = {};
    for (const [root, image] of Object.entries(this.projectCovers)) {
      const r = moved(root) ?? root;
      const i = moved(image) ?? image;
      if (r !== root || i !== image) changed = true;
      next[r] = i;
    }
    if (!changed) return;
    this.projectCovers = next;
    this.scheduleDailySave();
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
    this.activeDay = today;
    this.dailyTotal = this.dailyHistory[today] || 0;
    this.dailyGross = this.dailyGrossHistory[today] || 0;
    // 给今天落一个 0：热力图优先用毛新增，别让"今天"回落到历史上那条净增值
    if (this.dailyGrossHistory[today] === undefined) {
      this.dailyGrossHistory[today] = 0;
    }
    this.dailyDurationSeconds = this.dailyDurationHistory[today] || 0;
    this.lastDurationTotal = this.dailyDurationSeconds;
    this.lastWritingActivityAt = 0;
  }

  private recordWritingActivity(): void {
    const now = Date.now();
    if (this.lastWritingActivityAt > 0) {
      this.dailyDurationSeconds +=
        Math.min(now - this.lastWritingActivityAt, MAX_IDLE_GAP_MS) / 1000;
    }
    this.lastWritingActivityAt = now;
  }

  private scheduleDailySave(): void {
    if (this.dailySaveTimer) window.clearTimeout(this.dailySaveTimer);
    this.dailySaveTimer = window.setTimeout(() => {
      this.dailySaveTimer = 0;
      this.pruneDailyFileDeltas();
      void this.savePluginData();
    }, 2000);
  }

  /** 每日明细只留最近 60 天，避免插件数据无限膨胀。 */
  private pruneDailyFileDeltas(): void {
    const days = Object.keys(this.dailyFileDeltas).sort();
    const excess = days.length - 60;
    for (let i = 0; i < excess; i++) delete this.dailyFileDeltas[days[i]];
  }

  private async loadPluginData() {
    const data: any = await super.loadData();
    if (data) {
      if (data.lineHeight !== undefined || data.paragraphSpacing !== undefined) {
        this.settings = {
          themeTone: DEFAULT_SETTINGS.themeTone,
          lineHeight: data.lineHeight ?? DEFAULT_SETTINGS.lineHeight,
          paragraphSpacing: data.paragraphSpacing ?? DEFAULT_SETTINGS.paragraphSpacing,
          letterPaperMode: data.letterPaperMode ?? DEFAULT_SETTINGS.letterPaperMode,
          paragraphIndent: data.paragraphIndent ?? DEFAULT_SETTINGS.paragraphIndent,
          snapshotEnabled: data.snapshotEnabled ?? DEFAULT_SETTINGS.snapshotEnabled,
          snapshotFolder: data.snapshotFolder ?? DEFAULT_SETTINGS.snapshotFolder,
          snapshotIntervalMinutes: data.snapshotIntervalMinutes ?? DEFAULT_SETTINGS.snapshotIntervalMinutes,
          snapshotIdleMinutes: data.snapshotIdleMinutes ?? DEFAULT_SETTINGS.snapshotIdleMinutes,
          snapshotMaxPerFile: data.snapshotMaxPerFile ?? DEFAULT_SETTINGS.snapshotMaxPerFile,
          snapshotOnlyDrafts: data.snapshotOnlyDrafts ?? DEFAULT_SETTINGS.snapshotOnlyDrafts,
          immersiveMode: data.immersiveMode ?? DEFAULT_SETTINGS.immersiveMode,
          immersiveParagraphHighlight: data.immersiveParagraphHighlight ?? DEFAULT_SETTINGS.immersiveParagraphHighlight,
          hemingwayMode: data.hemingwayMode ?? DEFAULT_SETTINGS.hemingwayMode,
          dailyDisplayMode: data.dailyDisplayMode ?? DEFAULT_SETTINGS.dailyDisplayMode,
          typewriterMode: data.typewriterMode ?? DEFAULT_SETTINGS.typewriterMode,
          typewriterOffset: data.typewriterOffset ?? DEFAULT_SETTINGS.typewriterOffset,
          punctuationAssist: data.punctuationAssist ?? DEFAULT_SETTINGS.punctuationAssist,
          hardBreakOnEnter: data.hardBreakOnEnter ?? DEFAULT_SETTINGS.hardBreakOnEnter,
          dailyGoal: data.dailyGoal ?? DEFAULT_SETTINGS.dailyGoal,
          wordCountMode: data.wordCountMode ?? DEFAULT_SETTINGS.wordCountMode,
          showSpeed: data.showSpeed ?? DEFAULT_SETTINGS.showSpeed,
          pomodoroFocusMinutes: DEFAULT_SETTINGS.pomodoroFocusMinutes,
          pomodoroBreakMinutes: DEFAULT_SETTINGS.pomodoroBreakMinutes,
          pomodoroLongBreakEvery: DEFAULT_SETTINGS.pomodoroLongBreakEvery,
          pomodoroLongBreakMinutes: DEFAULT_SETTINGS.pomodoroLongBreakMinutes,
          pomodoroAutoSnapshot: DEFAULT_SETTINGS.pomodoroAutoSnapshot,
          statusBarOnlyImmersive: DEFAULT_SETTINGS.statusBarOnlyImmersive,
          mobileStatusBar: DEFAULT_SETTINGS.mobileStatusBar,
          draftKeywords: DEFAULT_SETTINGS.draftKeywords,
          chapterExcludeNames: DEFAULT_SETTINGS.chapterExcludeNames,
          formatToolbarEnabled: DEFAULT_SETTINGS.formatToolbarEnabled,
          formatToolbarScope: DEFAULT_SETTINGS.formatToolbarScope,
          commentsEnabled: DEFAULT_SETTINGS.commentsEnabled,
          commentBubbleEverywhere: DEFAULT_SETTINGS.commentBubbleEverywhere,
          outlineStorageMode: DEFAULT_SETTINGS.outlineStorageMode,
          newProjectFolder: DEFAULT_SETTINGS.newProjectFolder,
          sharedLibraryFolder: DEFAULT_SETTINGS.sharedLibraryFolder,
        };
        // 老格式如有历史数据则保留，不主动清空
        this.dailyHistory = data.dailyHistory || {};
        this.dailyGrossHistory = data.dailyGrossHistory || {};
        this.dailyDurationHistory = data.dailyDurationHistory || {};
        this.projectHistory = data.projectHistory || {};
        this.projectGrossHistory = data.projectGrossHistory || {};
        this.projectDurationHistory = data.projectDurationHistory || {};
        this.dailyFileDeltas = data.dailyFileDeltas || {};
        this.dailyPomodoroHistory = data.dailyPomodoroHistory || {};
        this.workbenchProject = data.workbenchProject ?? null;
        this.workbenchMode = data.workbenchMode === "resources" ? "resources" : "chapters";
        this.workbenchStatus = data.workbenchStatus ?? {};
        this.hiddenProjects = data.hiddenProjects ?? {};
        this.homePage = normalizeHomePage(data.homePage);
        this.projectCovers = data.projectCovers ?? {};
        this.libraryView = data.libraryView === "list" ? "list" : "grid";
        this.fileBaselines = data.fileBaselines ?? {};
        this.baselinesAt = data.baselinesAt ?? 0;
      } else {
        // 白名单合并：只取 DEFAULT_SETTINGS 里存在的键，顺带清理已废弃字段（fontSize 等）
        const loaded: any = data.settings || {};
        const merged: any = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (loaded[key] !== undefined) merged[key] = loaded[key];
        }
        this.settings = merged;
        this.dailyHistory = data.dailyHistory || {};
        this.dailyGrossHistory = data.dailyGrossHistory || {};
        this.dailyDurationHistory = data.dailyDurationHistory || {};
        this.projectHistory = data.projectHistory || {};
        this.projectGrossHistory = data.projectGrossHistory || {};
        this.projectDurationHistory = data.projectDurationHistory || {};
        this.dailyFileDeltas = data.dailyFileDeltas || {};
        this.dailyPomodoroHistory = data.dailyPomodoroHistory || {};
        this.workbenchProject = data.workbenchProject ?? null;
        this.workbenchMode = data.workbenchMode === "resources" ? "resources" : "chapters";
        this.workbenchStatus = data.workbenchStatus ?? {};
        this.hiddenProjects = data.hiddenProjects ?? {};
        this.homePage = normalizeHomePage(data.homePage);
        this.projectCovers = data.projectCovers ?? {};
        this.libraryView = data.libraryView === "list" ? "list" : "grid";
        this.fileBaselines = data.fileBaselines ?? {};
        this.baselinesAt = data.baselinesAt ?? 0;
      }
    } else {
      this.settings = { ...DEFAULT_SETTINGS };
      this.dailyHistory = {};
      this.dailyDurationHistory = {};
      this.projectHistory = {};
      this.projectDurationHistory = {};
      this.dailyPomodoroHistory = {};
    }
    this.dailyTotal = this.dailyHistory[this.todayStr] || 0;
    this.dailyGross = this.dailyGrossHistory[this.todayStr] || 0;
    // 今天必须有毛新增记录（哪怕还是 0），否则热力图会回落到净增，把历史脏数又显示出来
    if (this.dailyGrossHistory[this.todayStr] === undefined) {
      this.dailyGrossHistory[this.todayStr] = 0;
    }
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
    this.lastFormatToolbarSig = `${this.settings.formatToolbarEnabled}|${this.settings.formatToolbarScope}`;
    this.lastCommentsEnabled = this.settings.commentsEnabled;
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

  /** 设置页的“立即保存快照”按钮入口 */
  saveSnapshotNow(): Promise<void> {
    return this.snapshotManager.saveSnapshotNow();
  }

  /** 设置页的“打开快照文件夹”按钮入口 */
  openSnapshotFolder(): Promise<void> {
    return this.snapshotManager.openSnapshotFolder();
  }

  async saveSettings() {
    void syncThemeSnippet(this.app, this.settings.themeTone);
    this.statusBar.setState({
      dailyTotal: this.dailyTotal,
      dailyGross: this.dailyGross,
      dailyGoal: this.settings.dailyGoal,
      wordCountMode: this.settings.wordCountMode,
      showSpeed: this.settings.showSpeed,
    });
    this.refreshSidebar();
    injectTypography(this.settings);
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
    // 编辑工具条开关/范围变了：重建编辑器扩展，已浮出的工具条立即退出
    const formatSig = `${this.settings.formatToolbarEnabled}|${this.settings.formatToolbarScope}`;
    if (this.lastFormatToolbarSig !== formatSig) {
      this.lastFormatToolbarSig = formatSig;
      this.app.workspace.updateOptions();
    }
    // 批注总开关变了：刷新已打开文档里的批注痕迹（标记 / 脚注序号）
    if (this.lastCommentsEnabled !== this.settings.commentsEnabled) {
      this.lastCommentsEnabled = this.settings.commentsEnabled;
      this.refreshAllCommentDecors();
    }
    await super.saveData({
      settings: this.settings,
      dailyHistory: this.dailyHistory,
      dailyGrossHistory: this.dailyGrossHistory,
      dailyDurationHistory: this.dailyDurationHistory,
      projectHistory: this.projectHistory,
      projectGrossHistory: this.projectGrossHistory,
      projectDurationHistory: this.projectDurationHistory,
      dailyFileDeltas: this.dailyFileDeltas,
      dailyPomodoroHistory: this.dailyPomodoroHistory,
      workbenchProject: this.workbenchProject,
      workbenchMode: this.workbenchMode,
      workbenchStatus: this.workbenchStatus,
      hiddenProjects: this.hiddenProjects,
      homePage: this.homePage,
      projectCovers: this.projectCovers,
      libraryView: this.libraryView,
      fileBaselines: this.fileBaselines,
      baselinesAt: this.baselinesAt,
    });
  }

  private async savePluginData() {
    this.dailyHistory[this.todayStr] = this.dailyTotal;
    this.dailyDurationHistory[this.todayStr] = this.dailyDurationSeconds;
    await super.saveData({
      settings: this.settings,
      dailyHistory: this.dailyHistory,
      dailyGrossHistory: this.dailyGrossHistory,
      dailyDurationHistory: this.dailyDurationHistory,
      projectHistory: this.projectHistory,
      projectGrossHistory: this.projectGrossHistory,
      projectDurationHistory: this.projectDurationHistory,
      dailyFileDeltas: this.dailyFileDeltas,
      dailyPomodoroHistory: this.dailyPomodoroHistory,
      workbenchProject: this.workbenchProject,
      workbenchMode: this.workbenchMode,
      workbenchStatus: this.workbenchStatus,
      hiddenProjects: this.hiddenProjects,
      homePage: this.homePage,
      projectCovers: this.projectCovers,
      libraryView: this.libraryView,
      fileBaselines: this.fileBaselines,
      baselinesAt: this.baselinesAt,
    });
  }
}

/** 主页的页面白名单：未知值一律回到「书库」。 */
function normalizeHomePage(value: unknown): HomePage {
  return value === "library" || value === "stats" || value === "docs"
    ? value
    : "desk";
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * 在库内目录中找出与失联项目 key 最相似的目录。
 * 路径段相等记 1 分、互相包含（如「1-1-3-重生帝后」vs「P3-重生帝后」）记 0.5 分，
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

/** 两段共享的最长子串占较长段的比例（匹配「P3-重生帝后」vs「1-1-3-重生帝后」这类近似段）。 */
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
