import {
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import {
  describeRenumberPlan,
  looksLikeDraftFolder,
  looksLikeVolumeFolder,
  parseChapterName,
  planBookRenumber,
  planPathFor,
  renumberChapterName,
  volumeNumber,
} from "./chapterOrder";
import {
  ChapterEntry,
  NovelProject,
  ResourceGroup,
  VolumeEntry,
  allChapters,
  isInternalPath,
  projectForPath,
} from "./project";
import { ConfirmModal, TextPromptModal } from "./promptModal";
import {
  bindContextMenu,
  isMobileUI,
  showMenuAt,
  type MenuPoint,
} from "./mobile";
import type { UiShellContext } from "./uiShellContext";
import { WRITING_TOOLKIT_WORKBENCH } from "./uiSlots";
import {
  STATUS_LABEL,
  displayFolderName,
  displayProjectName,
  fileStatCache,
  parseResourceName,
  splitWords,
  type WorkbenchStatus,
} from "./uiShellShared";

export { WRITING_TOOLKIT_WORKBENCH } from "./uiSlots";

/** 后台统计每处理多少篇刷新一次聚合数字 */
const AGGREGATE_EVERY = 8;
/** 外部（AI/脚本）改动后的统计防抖 */
const MODIFY_DEBOUNCE = 1500;

export type WorkbenchMode = "chapters" | "resources";

/** 迁移期别名：统计缓存已移到 uiShellShared，内部沿用旧名字。 */
const statCache = fileStatCache;

/** 卷折叠状态（会话内跨视图重建保留）：true = 折叠 */
const volumeCollapse = new Map<string, boolean>();

/** 设定分类折叠状态；默认全部展开 */
const resourceGroupCollapse = new Map<string, boolean>();

/** 卷数超过这个值时，默认只展开「当前卷」和「最后一卷」 */
const AUTO_COLLAPSE_VOLUMES = 3;

interface RowRef {
  entry: ChapterEntry;
  rowEl: HTMLElement;
  wordsEl: HTMLElement;
  dotEl: HTMLElement;
  known: boolean;
  words: number;
}

interface ResourceRowRef {
  file: TFile;
  rowEl: HTMLElement;
  wordsEl: HTMLElement;
  known: boolean;
  words: number;
}

interface VolumeRef {
  volume: VolumeEntry;
  metaEl: HTMLElement;
  barEl: HTMLElement;
}

/** 全书关键字搜索的一条命中：出现次数 + 第一处片段 + 第一处字符位置。 */
interface SearchHit {
  count: number;
  snippet: string;
  /** 第一处命中的字符偏移；只命中标题时为 -1 */
  offset: number;
  /** 扫描时的关键字（打开文件后用它校验/重新定位） */
  query: string;
}

/** 全书命中序列里的一处（用于 ↑/↓ 连续定位）。 */
interface SearchMatch {
  path: string;
  offset: number;
  length: number;
}

/** 书头里需要随统计刷新的节点 */
interface HeadRefs {
  infoEl: HTMLElement;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** 大数字紧凑显示：31.2 万 */
function formatCompact(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return formatNumber(n);
}

/** 名字是否已经以排序码开头（1-1-5-4 / P3.4 / P4 这种）。 */
function startsWithOrderCode(name: string): boolean {
  return /^[A-Za-z]{0,2}\d+(?:[.-]\d+)*(\s|[.·-]|$)/.test(name);
}

function joinPath(folder: string, name: string): string {
  if (!folder || folder === "/") return name;
  return `${folder}/${name}`;
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分钟`;
}

/** 书名显示：去掉外层《》，过长时交给 CSS 省略号 */

/** 输入框里的按键不交给列表键盘导航处理 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "TEXTAREA" ||
    target.tagName === "INPUT" ||
    target.isContentEditable
  );
}

/**
 * 「编辑台」：以作品为单位的窄栏写作面板（兼顾美感、明确交互与窄侧栏宽度）。
 *
 * 三段结构：
 * 1. 书头 —— 书名与连载状态点、全书字数与章节数、正文/设定切换与轻量新建按钮
 * 2. 台面 —— 全书关键字搜索框（含清空、命中片段）+ 独立的一键复制正文按钮 + 正文章节（分卷可折叠、卷头快速+章、当前章高亮）或设定资料
 * 3. 今日状态 —— 紧凑的今日码字进度细条 + 番茄 / 时长 / 快照速览（可点击交互）
 */
export class WritingToolkitWorkbench extends ItemView {
  private readonly host: UiShellContext;

  private headEl!: HTMLElement;
  private searchEl!: HTMLElement;
  private searchInputEl: HTMLInputElement | null = null;
  private searchClearBtn: HTMLButtonElement | null = null;
  private noticeEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private footEl!: HTMLElement;
  /** 手机版右下角主操作按钮（新章节 / 新分类） */
  private fabEl!: HTMLButtonElement;

  private projects: readonly NovelProject[] = [];
  private project: NovelProject | null = null;
  private mode: WorkbenchMode = "chapters";
  /** 全书关键字搜索的输入（搜正文 / 设定内容，不再只搜标题与章号） */
  private searchQuery = "";
  /** 当前搜索结果：文件路径 → 命中次数与片段 */
  private searchHits = new Map<string, SearchHit>();
  /** 全书命中序列（按阅读顺序）；↑/↓ 在它上面循环 */
  private searchMatches: SearchMatch[] = [];
  /** 当前选中的是第几处（-1 = 还没开始定位） */
  private searchMatchIndex = -1;
  /** 命中序列对应的关键字，换词时重置位置 */
  private searchMatchesQuery = "";
  /** 搜索扫描的代数：输入变化后旧扫描结果作废 */
  private searchScanToken = 0;
  private searchScanTimer = 0;
  private searchScanning = false;
  /** 搜索面板是否展开（默认收起成标题栏的搜索按钮） */
  private searchOpen = false;
  private searchActionEl: HTMLElement | null = null;
  private copyActionEl: HTMLElement | null = null;

  private rows = new Map<string, RowRef>();
  private resourceRows = new Map<string, ResourceRowRef>();
  private volumeRefs: VolumeRef[] = [];
  /** 当前渲染的卷：路径 → 卷容器 + 本卷可见章节 */
  private volumeViews: Array<{ path: string; el: HTMLElement | null; entries: ChapterEntry[] }> = [];
  /** 当前渲染的设定分类：路径 → 分组容器 + 组内可见文件 */
  private resourceGroupEls: Array<{ path: string; el: HTMLElement; files: TFile[] }> = [];
  private listPaths: string[] = [];

  private headRefs: HeadRefs | null = null;

  private currentPath: string | null = null;
  private keyboardIndex: number | null = null;
  /** 正在拖拽的章节路径（HTML5 拖拽期间有值） */
  private dragPath: string | null = null;
  /** 删除章节后的重编号队列（串行执行，避免连续删除时互相踩踏） */
  private renumberChain: Promise<void> = Promise.resolve();
  /** 整卷移入废纸篓期间，忽略卷内文件触发的逐章重编号事件。 */
  private deletingVolumePaths = new Set<string>();

  private statsToken = 0;
  private refreshTimer = 0;
  private footTimer = 0;
  private modifyTimer = 0;
  private copyFeedbackTimer = 0;
  private pendingModify = new Set<string>();

  private footSignature = "";

  constructor(leaf: WorkspaceLeaf, host: UiShellContext) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return WRITING_TOOLKIT_WORKBENCH;
  }

  getDisplayText(): string {
    return "编辑台";
  }

  getIcon(): string {
    return "wt-editor";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("wt-wb");
    this.mode = this.host.prefs.getWorkbenchMode();

    this.headEl = this.contentEl.createDiv({ cls: "wt-wb-head" });
    this.searchEl = this.contentEl.createDiv({ cls: "wt-wb-searchbar" });
    this.searchEl.toggleClass("is-collapsed", !this.searchOpen);
    this.renderSearchBar();
    // 「当前文件属于另一本书」提示条（为空时 CSS 隐藏）
    this.noticeEl = this.contentEl.createDiv({ cls: "wt-wb-notice" });
    this.bodyEl = this.contentEl.createDiv({ cls: "wt-wb-body" });
    this.bodyEl.setAttr("tabindex", "-1");
    this.bodyEl.addEventListener("keydown", (e) => this.onKeydown(e));
    this.bodyEl.addEventListener("click", (e) => {
      if (e.target === this.bodyEl) this.bodyEl.focus();
    });
    this.footEl = this.contentEl.createDiv({ cls: "wt-wb-foot" });

    // 手机版右下角主操作：正文 = 新章节，设定 = 新分类（桌面端 CSS 隐藏）
    this.fabEl = this.contentEl.createEl("button", {
      cls: "wt-wb-fab",
      attr: { type: "button", "aria-label": "新建" },
    });
    setIcon(this.fabEl, "wt-plus");
    this.fabEl.addEventListener("click", () => this.onFab());

    // 结构变化（增删改名）才重建列表；内部目录（快照 / 章纲伴生文件）全部忽略
    const structural = (file: TAbstractFile): void => {
      if (isInternalPath(file.path)) return;
      this.refresh();
    };
    this.registerEvent(this.app.vault.on("create", structural));
    this.registerEvent(this.app.vault.on("delete", structural));
    this.registerEvent(this.app.vault.on("rename", structural));
    // 删除章节后，把后面连号的章节整体前移一位。
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const deletingWithVolume = [...this.deletingVolumePaths].some(
          (path) => file.path.startsWith(`${path}/`)
        );
        if (file instanceof TFile && !deletingWithVolume) {
          // 只在删掉的是「有编号的章节」时才重排：否则删快照/资料/番外也会无谓地跑一遍
          const n = parseChapterName(file.basename).number;
          if (n !== null && n >= 1) this.queueChapterRenumber();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onFileModified(file))
    );
    // 切换标签页 / 打开章节后，把「当前章」高亮跟着活动文件走。
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.syncActive())
    );
    this.footTimer = window.setInterval(() => this.renderFoot(), 1000);
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    if (this.footTimer) window.clearInterval(this.footTimer);
    if (this.modifyTimer) window.clearTimeout(this.modifyTimer);
    if (this.copyFeedbackTimer) window.clearTimeout(this.copyFeedbackTimer);
    if (this.searchScanTimer) window.clearTimeout(this.searchScanTimer);
    this.searchScanToken++;
    this.statsToken++;
    this.rows.clear();
    this.resourceRows.clear();
    this.volumeRefs = [];
    this.contentEl.empty();
  }

  // ---------- 对外刷新入口 ----------

  /** 结构变化后的重建（防抖）。 */
  private refresh(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = 0;
      this.render();
    }, 200);
  }

  /** 立即重建（新建作品后要马上认出新目录，不等防抖）。 */
  refreshNow(): void {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = 0;
    }
    this.render();
  }

  /**
   * 手动触发「全书章节重编号」（卷右键菜单入口）。
   * 会先弹预览确认——这一步会改文件名，不该静默发生。
   */
  renumberBookNow(): void {
    void this.applyBookRenumber(true);
  }

  /**
   * 轻量刷新：编辑器每次输入都会调用。
   * 只更新当前章字数与今日仪表，不重建列表。
   */
  refreshLive(): void {
    this.updateCurrentPath();
    const path = this.host.recent.path();
    const text = this.host.recent.text();
    if (path && text !== null) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const words = this.host.actions.countWords(text);
        const ref = this.rows.get(path);
        const resRef = this.resourceRows.get(path);
        statCache.set(path, {
          mtime: file.stat.mtime,
          size: file.stat.size,
          words,
        });
        if (ref) this.applyChapterStats(ref, words);
        if (resRef) this.applyResourceStats(resRef, words);
      }
    }
    this.recomputeTotals();
    this.renderFoot();
  }

  /** 外部（AI/脚本）改写了某一篇：只重算那一篇，不重建 DOM。 */
  private onFileModified(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!this.rows.has(file.path) && !this.resourceRows.has(file.path)) return;
    // 正在编辑器里输入的文件由 refreshLive 负责，避免重复读盘
    if (file.path === this.host.recent.path()) return;
    this.pendingModify.add(file.path);
    if (this.modifyTimer) return;
    this.modifyTimer = window.setTimeout(() => {
      this.modifyTimer = 0;
      void this.flushModify();
    }, MODIFY_DEBOUNCE);
  }

  private async flushModify(): Promise<void> {
    const paths = [...this.pendingModify];
    this.pendingModify.clear();
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      try {
        const content = await this.app.vault.cachedRead(file);
        const words = this.host.actions.countWords(content);
        const ref = this.rows.get(path);
        statCache.set(path, {
          mtime: file.stat.mtime,
          size: file.stat.size,
          words,
        });
        const chapterRef = this.rows.get(path);
        if (chapterRef) this.applyChapterStats(chapterRef, words);
        const resRef = this.resourceRows.get(path);
        if (resRef) this.applyResourceStats(resRef, words);
      } catch {
        /* 读取失败忽略 */
      }
    }
    this.recomputeTotals();
  }

  // ---------- 渲染 ----------

  private render(): void {
    this.projects = this.host.services.project.projects();
    this.project = this.pickProject();
    this.updateCurrentPath();
    this.keyboardIndex = null;

    this.renderHead();
    // 搜索中重建（切作品 / 文件结构变化）时重扫当前标签，避免旧命中粘住。
    if (this.searchQuery) {
      this.searchMatchIndex = -1;
      this.scheduleSearch();
    } else this.renderBody();
    this.renderNotice();
    this.renderFoot();
    this.updateFab();

    if (this.project) {
      const token = ++this.statsToken;
      void this.loadStats(this.project, token);
    }
  }

  /** 选择当前作品：记住的 > 当前文件所属 > 最近写过章节的 > 第一个有章节的。 */
  private pickProject(): NovelProject | null {
    if (this.projects.length === 0) return null;

    const remembered = this.host.prefs.getWorkbenchProject();
    if (remembered) {
      const hit = this.projects.find((p) => p.root === remembered);
      if (hit) return hit;
    }

    const active =
      this.app.workspace.getActiveFile()?.path ??
      this.host.recent.path();
    if (active) {
      const hit = projectForPath(active, this.projects);
      if (hit) return hit;
    }

    let best: NovelProject | null = null;
    let bestMtime = -1;
    for (const project of this.projects) {
      for (const chapter of allChapters(project)) {
        if (chapter.file.stat.mtime > bestMtime) {
          bestMtime = chapter.file.stat.mtime;
          best = project;
        }
      }
    }
    if (best) return best;

    return this.projects.find((p) => p.chapterCount > 0) ?? this.projects[0];
  }

  private updateCurrentPath(): void {
    const active =
      this.app.workspace.getActiveFile()?.path ??
      this.host.recent.path();
    let path: string | null = null;
    if (this.project && active) {
      const hit = allChapters(this.project).find((c) => c.file.path === active);
      if (hit) path = hit.file.path;
    }
    if (!path) {
      const last = this.lastModifiedChapter();
      path = last ? last.file.path : null;
    }
    this.currentPath = path;
  }

  /** 切换标签页后的轻量同步：高亮当前章、刷新提示条与底部仪表。 */
  private syncActive(): void {
    const prev = this.currentPath;
    this.updateCurrentPath();
    const activePath = this.app.workspace.getActiveFile()?.path ?? null;
    for (const [path, ref] of this.rows) {
      ref.rowEl.toggleClass("is-current", path === this.currentPath);
    }
    for (const [path, ref] of this.resourceRows) {
      ref.rowEl.toggleClass("is-current", path === activePath);
    }
    if (this.mode === "chapters") {
      if (prev !== this.currentPath && !this.searchQuery && this.currentPath) {
        // 换到折叠卷里的章节时自动展开那一卷
        this.expandVolumeOf(this.currentPath);
        this.scrollToCurrent("nearest");
      }
    }
    this.renderNotice();
    this.renderFoot();
  }

  /** 当前打开的文件属于另一本书时，给一个一键切换的提示条。 */
  private renderNotice(): void {
    this.noticeEl.empty();
    if (!this.project) return;
    const active = this.app.workspace.getActiveFile();
    if (!active) return;
    const other = projectForPath(active.path, this.projects);
    if (!other || other.root === this.project.root) return;

    const icon = this.noticeEl.createSpan({ cls: "wt-wb-notice-icon" });
    setIcon(icon, "wt-info");
    const text = this.noticeEl.createSpan({ cls: "wt-wb-notice-text" });
    text.appendText("正在编辑");
    text.createSpan({
      cls: "wt-wb-notice-book",
      text: `《${displayProjectName(other.name)}》`,
    });
    const btn = this.noticeEl.createEl("button", {
      cls: "wt-wb-notice-btn",
      text: "切换过去",
      attr: { type: "button" },
    });
    btn.addEventListener("click", () => {
      this.host.prefs.setWorkbenchProject(other.root);
      this.render();
      this.host.nav.refreshHome();
    });
  }

  // ---------- ① 书头 ----------

  private renderHead(): void {
    this.headEl.empty();
    this.headRefs = null;

    if (!this.project) {
      this.headEl.createDiv({
        cls: "wt-wb-empty-title",
        text: "还没有识别到作品",
      });
      return;
    }

    const top = this.headEl.createDiv({ cls: "wt-wb-head-top" });
    const bookGroup = top.createDiv({ cls: "wt-wb-book-group" });
    // 书名：作品切换统一去主页；这里只保留右键管理菜单
    const bookEl = bookGroup.createDiv({
      cls: "wt-wb-book",
      attr: { title: `${this.project.name}（右键更多操作）` },
    });
    bookEl.createSpan({
      cls: "wt-wb-book-name",
      text: displayFolderName(displayProjectName(this.project.name)),
    });

    bindContextMenu(bookEl, (pt) => {
      const menu = new Menu();
      if (this.mode === "chapters") {
        menu.addItem((item) =>
          item.setTitle("写新章节").onClick(() => void this.createNextChapter())
        );
        menu.addItem((item) =>
          item.setTitle("新建一卷").onClick(() => this.createVolume())
        );
        if (!Platform.isMobile) {
          menu.addItem((item) =>
            item.setTitle("手机预览本章").onClick(() =>
              this.previewCurrentChapterOnPhone()
            )
          );
        }
      } else {
        menu.addItem((item) =>
          item.setTitle("新建分类").onClick(() => this.createResourceCategory())
        );
      }
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle("打开书房主页").onClick(() => void this.host.nav.openHome())
      );
      menu.addItem((item) =>
        item.setTitle("在系统文件管理器中显示").onClick(() => {
          if (this.project) this.host.actions.revealPathInSystem(this.project.root);
        })
      );
      menu.addItem((item) =>
        item.setTitle("重新扫描作品").onClick(() => {
          // 项目索引现在是带缓存的 Service：手动重扫必须先失效缓存，
          // 否则文件系统在 Obsidian 事件之外被改动时看不到新作品。
          this.host.services.project.invalidate();
          this.render();
        })
      );
      showMenuAt(menu, pt);
    });

    // 状态点跟书名绑定；标题行右侧只留搜索 / 复制（桌面端再加手机预览）三个常驻小按钮
    this.renderBookStatus(bookGroup);
    const headRight = top.createDiv({ cls: "wt-wb-head-right" });
    this.searchActionEl = this.headIconButton(
      headRight,
      "wt-search",
      "搜索全书",
      () => this.toggleSearchPanel()
    );
    this.searchActionEl.toggleClass("is-active", this.searchOpen);
    this.copyActionEl = this.headIconButton(
      headRight,
      "wt-copy",
      "一键复制本章正文",
      () => this.copyCurrentChapter()
    );
    // 读者手机预览只在桌面端有意义：真机上人已经在手机上了，不占位置。
    if (!Platform.isMobile) {
      this.headIconButton(headRight, "wt-phone", "手机预览本章", () =>
        this.previewCurrentChapterOnPhone()
      );
    }

    // 标题下方一行紧凑说明：全书字数 · 章节数
    const infoEl = this.headEl.createDiv({ cls: "wt-wb-status-info" });
    this.headRefs = { infoEl };
    this.updateHeadInfo();

    // 正文 / 设定 切换；新章节 / 新卷 紧凑排列在同一行右侧
    const segRow = this.headEl.createDiv({ cls: "wt-wb-seg-row" });
    const seg = segRow.createDiv({ cls: "wt-wb-seg" });
    const tabs: Array<{ key: WorkbenchMode; label: string }> = [
      { key: "chapters", label: "正文" },
      { key: "resources", label: "设定" },
    ];
    for (const tab of tabs) {
      const btn = seg.createEl("button", {
        cls: `wt-wb-seg-btn ${this.mode === tab.key ? "is-active" : ""}`,
        attr: { type: "button" },
      });
      btn.createSpan({ text: tab.label });
      const count =
        tab.key === "chapters"
          ? this.project.chapterCount
          : this.project.resourceCount;
      if (count > 0) {
        btn.createSpan({ cls: "wt-wb-seg-count", text: String(count) });
      }
      btn.addEventListener("click", () => this.switchMode(tab.key));
    }

    const segActions = segRow.createDiv({ cls: "wt-wb-seg-actions" });
    if (this.mode === "chapters") {
      this.addHeadAction(
        segActions,
        "+ 新章节",
        this.nextChapterHint(this.project),
        true,
        () => void this.createNextChapter()
      );
      this.addHeadAction(
        segActions,
        "新卷",
        "在正文草稿下新建一卷",
        false,
        () => this.createVolume()
      );
    } else {
      this.addHeadAction(
        segActions,
        "+ 新分类",
        "在作品文件夹下新建一个设定分类",
        true,
        () => this.createResourceCategory()
      );
    }
  }

  /** 书头右上角的图标按钮（搜索 / 复制）。 */
  private headIconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    cb: () => void
  ): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: "wt-wb-head-tool",
      attr: { type: "button", "aria-label": label, title: label },
    });
    setIcon(btn, icon);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      cb();
    });
    return btn;
  }

  /** 头部轻量胶囊按钮：紧凑不占宽，但比纯文字明确可点。 */
  private addHeadAction(
    parent: HTMLElement,
    label: string,
    tip: string,
    primary: boolean,
    cb: () => void
  ): void {
    const btn = parent.createEl("button", {
      cls: `wt-wb-new${primary ? " is-primary" : ""}`,
      text: label,
      attr: { type: "button", title: tip },
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      cb();
    });
  }

  /** 书头说明行：全书字数 · 章节数。 */
  private updateHeadInfo(): void {
    const refs = this.headRefs;
    if (!this.project || !refs) return;
    let totalWords = 0;
    for (const chapter of allChapters(this.project)) {
      const row = this.rows.get(chapter.file.path);
      if (row && row.known) {
        totalWords += row.words;
      } else {
        const cached = statCache.get(chapter.file.path);
        if (cached) totalWords += cached.words;
      }
    }
    const [num, unit] = splitWords(totalWords);
    refs.infoEl.setText(
      `${num} ${unit} · ${this.project.chapterCount} 章`
    );
    refs.infoEl.toggleClass("is-empty", false);
  }

  /** 书名旁的小状态点：颜色表示连载状态，点一下设置。 */
  private renderBookStatus(parent: HTMLElement): void {
    if (!this.project) return;
    const status = this.host.prefs.getWorkbenchStatus(this.project.root);
    const label = status ? STATUS_LABEL[status] : "未标注";
    const btn = parent.createEl("button", {
      cls: `wt-wb-book-status is-${status ?? "unset"}`,
      attr: {
        type: "button",
        "aria-label": `连载状态：${label}（点击设置）`,
        title: `连载状态：${label}（点击设置）`,
      },
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      this.showStatusMenu({ x: rect.left, y: rect.bottom + 4 });
    });
  }

  private showStatusMenu(pt: MenuPoint): void {
    const root = this.project?.root;
    if (!root) return;
    const current = this.host.prefs.getWorkbenchStatus(root);
    const menu = new Menu();
    const order: WorkbenchStatus[] = ["ongoing", "completed", "hiatus"];
    for (const key of order) {
      menu.addItem((item) =>
        item
          .setTitle(STATUS_LABEL[key])
          .setChecked(current === key)
          .onClick(() => this.applyStatus(root, key))
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("清除标注")
        .setDisabled(current === null)
        .onClick(() => this.applyStatus(root, null))
    );
    showMenuAt(menu, pt);
  }

  private applyStatus(root: string, status: WorkbenchStatus | null): void {
    this.host.prefs.setWorkbenchStatus(root, status);
    this.renderHead();
    this.host.nav.refreshHome();
  }

  private switchMode(mode: WorkbenchMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.host.prefs.setWorkbenchMode(mode);
    this.keyboardIndex = null;
    this.searchMatchIndex = -1;
    this.searchMatches = [];
    this.renderHead();
    this.renderSearchBar();
    this.scheduleSearch();
    this.updateFab();
  }

  // ---------- 搜索栏 ----------

  /** 搜索按钮打开的面板：只有一行搜索；收起时不占高度。 */
  private renderSearchBar(): void {
    this.searchEl.empty();
    this.searchEl.toggleClass("is-collapsed", !this.searchOpen);
    if (!this.searchOpen) return;

    const searchRow = this.searchEl.createDiv({ cls: "wt-wb-search-row" });
    const wrap = searchRow.createDiv({ cls: "wt-wb-search-wrap" });
    const icon = wrap.createSpan({ cls: "wt-wb-search-icon" });
    setIcon(icon, "wt-search");
    const input = wrap.createEl("input", {
      cls: "wt-wb-search",
      type: "search",
      placeholder:
        this.mode === "chapters" ? "搜索全书关键字" : "搜索设定关键字",
      attr: {
        title: "↑↓ / Enter 上下定位，Shift+Enter 上一处，esc 清空 / 关闭搜索",
      },
    });
    this.searchInputEl = input;
    input.value = this.searchQuery;

    const clearBtn = wrap.createEl("button", {
      cls: `wt-wb-search-clear${this.searchQuery ? "" : " is-hidden"}`,
      attr: { type: "button", "aria-label": "清空搜索", title: "清空搜索 (esc)" },
    });
    setIcon(clearBtn, "wt-close");
    this.searchClearBtn = clearBtn;
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      input.value = "";
      this.clearSearchState();
      clearBtn.addClass("is-hidden");
      input.focus();
    });

    input.addEventListener("input", () => {
      this.searchQuery = input.value.trim();
      this.searchClearBtn?.toggleClass("is-hidden", !this.searchQuery);
      this.keyboardIndex = null;
      this.scheduleSearch();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.searchQuery) {
          input.value = "";
          this.clearSearchState();
          this.searchClearBtn?.addClass("is-hidden");
          input.focus();
        } else {
          this.toggleSearchPanel(false);
        }
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!this.searchScanning && this.searchMatches.length > 0) {
          this.stepSearchMatch(e.key === "ArrowDown" ? 1 : -1);
        } else {
          this.moveKeyboard(e.key);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!this.searchScanning && this.searchMatches.length > 0) {
          this.stepSearchMatch(e.shiftKey ? -1 : 1);
        } else {
          this.openKeyboardTarget(e.metaKey || e.ctrlKey);
        }
      }
      e.stopPropagation();
    });
  }

  /** 标题栏搜索按钮：展开 / 收起搜索面板。 */
  private toggleSearchPanel(force?: boolean): void {
    const open = force ?? !this.searchOpen;
    if (open === this.searchOpen) {
      if (open) this.searchInputEl?.focus();
      return;
    }
    this.searchOpen = open;
    this.searchActionEl?.toggleClass("is-active", open);
    this.searchEl.toggleClass("is-collapsed", !open);
    if (open) {
      this.renderSearchBar();
      this.searchInputEl?.focus();
    } else {
      this.clearSearchState();
    }
  }

  /** 标题栏复制按钮：一键复制当前章节干净正文。 */
  private copyCurrentChapter(): void {
    const target = this.currentPath ?? this.firstChapterPath();
    if (!target) {
      new Notice("先打开一章，或在这篇作品里建一章");
      return;
    }
    void this.host.actions.copyCleanChapter(target);
    const el = this.copyActionEl;
    if (!el) return;
    setIcon(el, "wt-check");
    if (this.copyFeedbackTimer) window.clearTimeout(this.copyFeedbackTimer);
    this.copyFeedbackTimer = window.setTimeout(() => {
      this.copyFeedbackTimer = 0;
      setIcon(el, "wt-copy");
    }, 1300);
  }

  /** 桌面端：以读者手机形态预览当前章（没打开任何正文时用第一章兜底）。 */
  private previewCurrentChapterOnPhone(): void {
    const target = this.currentPath ?? this.firstChapterPath();
    if (!target) {
      new Notice("先打开一章，或在这篇作品里建一章");
      return;
    }
    this.host.actions.openPhonePreview(target);
  }

  /** 清空搜索：输入框、命中缓存、进行中的扫描全部复位。 */
  private clearSearchState(): void {
    this.searchQuery = "";
    this.searchHits.clear();
    this.searchMatches = [];
    this.searchMatchIndex = -1;
    this.searchMatchesQuery = "";
    this.searchScanning = false;
    this.searchScanToken++;
    if (this.searchScanTimer) {
      window.clearTimeout(this.searchScanTimer);
      this.searchScanTimer = 0;
    }
    this.keyboardIndex = null;
    this.renderBody();
  }

  /** 输入后防抖扫描整本书；扫描期间列表显示「正在搜索」。 */
  private scheduleSearch(): void {
    if (this.searchScanTimer) {
      window.clearTimeout(this.searchScanTimer);
      this.searchScanTimer = 0;
    }
    const token = ++this.searchScanToken;
    if (!this.searchQuery) {
      this.searchHits.clear();
      this.searchMatches = [];
      this.searchMatchIndex = -1;
      this.searchMatchesQuery = "";
      this.searchScanning = false;
      this.renderBody();
      return;
    }
    this.searchScanning = true;
    this.renderBody();
    this.searchScanTimer = window.setTimeout(() => {
      this.searchScanTimer = 0;
      void this.scanSearch(this.searchQuery, token);
    }, 180);
  }

  /** 在当前标签的范围内扫描全文：正文 = 全书章节，设定 = 全部设定资料。 */
  private async scanSearch(query: string, token: number): Promise<void> {
    const q = query.toLowerCase();
    const project = this.project;
    if (!project) {
      this.searchHits = new Map();
      this.searchMatches = [];
      this.searchMatchIndex = -1;
      this.searchMatchesQuery = query;
      this.searchScanning = false;
      this.renderBody();
      return;
    }
    // 换关键字时重新从头找；同一个词重扫（文件变化）则保留当前位置。
    if (query !== this.searchMatchesQuery) {
      this.searchMatchesQuery = query;
      this.searchMatchIndex = -1;
    }
    const chapters = this.mode === "chapters" ? allChapters(project) : [];
    const chapterByPath = new Map(chapters.map((c) => [c.file.path, c]));
    const files =
      this.mode === "chapters"
        ? chapters.map((c) => c.file)
        : project.resources.flatMap((group) => group.files);
    const hits = new Map<string, SearchHit>();
    const matches: SearchMatch[] = [];
    // 已打开的编辑器可能有未保存内容，搜索以编辑器里的实时文本为准。
    const openText = new Map<string, string>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        openText.set(view.file.path, view.editor.getValue());
      }
    }
    for (const file of files) {
      if (token !== this.searchScanToken) return;
      let text = openText.get(file.path);
      if (text === undefined) {
        try {
          text = await this.app.vault.cachedRead(file);
        } catch {
          continue;
        }
      }
      const lower = text.toLowerCase();
      let index = lower.indexOf(q);
      let count = 0;
      let first = -1;
      while (index !== -1 && count < 999) {
        if (first < 0) first = index;
        matches.push({ path: file.path, offset: index, length: q.length });
        count++;
        index = lower.indexOf(q, index + q.length);
      }
      const entry = chapterByPath.get(file.path);
      const titleHay = `${entry?.title ?? ""} ${entry?.number ?? ""} ${
        file.basename
      }`.toLowerCase();
      if (count > 0 || titleHay.includes(q)) {
        hits.set(file.path, {
          count,
          snippet: count > 0 ? this.searchSnippet(text, first, q.length) : "",
          offset: count > 0 ? first : -1,
          query,
        });
      }
    }
    if (token !== this.searchScanToken) return;
    this.searchHits = hits;
    this.searchMatches = matches;
    if (this.searchMatchIndex >= matches.length) {
      this.searchMatchIndex = matches.length > 0 ? 0 : -1;
    }
    this.searchScanning = false;
    this.renderBody();
  }

  private searchSnippet(text: string, index: number, length: number): string {
    const radius = 24;
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + length + radius);
    const body = text.slice(start, end).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
  }

  /** 上一处 / 下一处：在全书命中序列里循环，并定位选中。 */
  private stepSearchMatch(direction: 1 | -1): void {
    const matches = this.searchMatches;
    if (matches.length === 0) return;
    const current = this.searchMatchIndex;
    const next =
      current < 0
        ? direction > 0
          ? 0
          : matches.length - 1
        : (current + direction + matches.length) % matches.length;
    this.searchMatchIndex = next;
    this.revealSearchMatch(matches[next]);
    this.updateSearchSummary();
    this.updateSearchTargetHighlight();
  }

  /** 打开 / 定位到指定命中（不改变 searchMatchIndex）。 */
  private revealSearchMatch(match: SearchMatch): void {
    const view = this.markdownViewForPath(match.path);
    if (view) {
      this.applyEditorSelection(view, match.offset, this.searchMatchesQuery);
      this.focusSearchInput();
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(match.path);
    if (!(file instanceof TFile)) return;
    this.openFile(
      file,
      false,
      {
        count: 1,
        snippet: "",
        offset: match.offset,
        query: this.searchMatchesQuery,
      },
      false
    );
  }

  /** 找文件对应的 Markdown 视图：优先当前活动视图，其次已打开的同文件视图。 */
  private markdownViewForPath(path: string): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === path) return active;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) {
        return view;
      }
    }
    return null;
  }

  /** 把命中位置写进编辑器选区；文件可能变过，对不上就重新找第一次出现。 */
  private applyEditorSelection(
    view: MarkdownView,
    offset: number,
    query: string
  ): void {
    const editor = view.editor;
    const text = editor.getValue();
    const needle = query;
    const isMatchAt = (at: number): boolean =>
      at >= 0 &&
      text.slice(at, at + needle.length).toLowerCase() === needle.toLowerCase();
    let at = offset;
    if (!isMatchAt(at)) at = text.toLowerCase().indexOf(needle.toLowerCase());
    if (at < 0) return;
    const from = editor.offsetToPos(at);
    const to = editor.offsetToPos(at + needle.length);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  private focusSearchInput(): void {
    this.searchInputEl?.focus({ preventScroll: true });
  }

  /** 搜索框下方的一行命中计数 + 上一处 / 下一处按钮。 */
  private renderSearchSummary(): void {
    if (this.searchMatches.length === 0) return;
    const summary = this.bodyEl.createDiv({ cls: "wt-wb-search-summary" });
    const text = summary.createSpan({ cls: "wt-wb-search-summary-text" });
    this.updateSearchSummaryText(text);
    const nav = summary.createDiv({ cls: "wt-wb-search-nav" });
    const addNav = (
      direction: 1 | -1,
      icon: string,
      label: string
    ): void => {
      const btn = nav.createEl("button", {
        cls: "wt-wb-search-nav-btn",
        attr: { type: "button", "aria-label": label, title: label },
      });
      setIcon(btn, icon);
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.stepSearchMatch(direction);
        this.focusSearchInput();
      });
    };
    addNav(-1, "wt-chevron-up", "上一处（Shift+Enter）");
    addNav(1, "wt-chevron-down", "下一处（Enter）");
  }

  private updateSearchSummary(): void {
    const el = this.bodyEl.querySelector<HTMLElement>(
      ".wt-wb-search-summary-text"
    );
    if (el) this.updateSearchSummaryText(el);
  }

  private updateSearchSummaryText(el: HTMLElement): void {
    const total = this.searchMatches.length;
    const current = this.searchMatchIndex >= 0 ? this.searchMatchIndex + 1 : 0;
    el.setText(
      current > 0 ? `全书 ${total} 处 · 第 ${current} 处` : `全书 ${total} 处`
    );
  }

  /** 高亮当前命中所在的章节 / 资料行，并把它滚进视野。 */
  private updateSearchTargetHighlight(): void {
    const target =
      this.searchMatchIndex >= 0
        ? this.searchMatches[this.searchMatchIndex]?.path ?? null
        : null;
    for (const ref of this.rows.values()) {
      ref.rowEl.toggleClass("is-search-current", ref.entry.file.path === target);
    }
    for (const ref of this.resourceRows.values()) {
      ref.rowEl.toggleClass("is-search-current", ref.file.path === target);
    }
    const row = target
      ? this.rows.get(target)?.rowEl ?? this.resourceRows.get(target)?.rowEl
      : null;
    row?.scrollIntoView({ block: "nearest" });
  }

  /** 点击某条结果时，把「当前第几处」同步到这个文件的第一处命中。 */
  private syncSearchIndex(file: TFile, hit: SearchHit): void {
    // 只有标题命中时没有正文位置，清掉上一处的高亮，避免摘要指错文件。
    if (hit.offset < 0) {
      this.searchMatchIndex = -1;
      return;
    }
    const index = this.searchMatches.findIndex(
      (match) => match.path === file.path && match.offset === hit.offset
    );
    if (index >= 0) this.searchMatchIndex = index;
  }

  /** 当前作品的第一章（没打开任何文档时，复制按钮兜底用）。 */
  private firstChapterPath(): string | null {
    if (!this.project) return null;
    return allChapters(this.project)[0]?.file?.path ?? null;
  }

  private matchesSearch(entry: ChapterEntry): boolean {
    if (!this.searchQuery) return true;
    return this.searchHits.has(entry.file.path);
  }

  // ---------- ② 台面 ----------

  private renderBody(): void {
    this.updateCurrentPath();
    this.bodyEl.empty();
    this.rows.clear();
    this.resourceRows.clear();
    this.volumeRefs = [];
    this.volumeViews = [];
    this.resourceGroupEls = [];
    this.listPaths = [];

    if (!this.project) {
      this.renderEmpty(
        "没有在这仓库里找到作品",
        "把章节放进「正文草稿」目录，或放进「第N卷·卷名」这样的卷目录，就会被识别为作品。"
      );
      return;
    }

    if (this.mode === "resources") {
      this.renderResourceBody(this.project);
      return;
    }

    const chapters = allChapters(this.project);
    const explicitVolumes = this.project.volumes.filter((v) =>
      looksLikeVolumeFolder(v.name)
    );
    if (chapters.length === 0 && explicitVolumes.length === 0) {
      this.renderEmpty(
        "这本书还没有章节",
        "点上方的「+ 新章节」按钮开始写第一章。"
      );
      return;
    }

    const filtering = this.searchQuery.length > 0;
    if (filtering && this.searchScanning) {
      this.renderEmpty(
        "正在搜索全书…",
        "正在读取当前标签下的全部内容"
      );
      this.listPaths = [];
      this.keyboardIndex = null;
      return;
    }
    if (filtering) this.renderSearchSummary();

    // 搜索时：卷内没有命中的章节就不显示这一卷
    const visible: ChapterEntry[] = [];
    const showVolumeHeader =
      this.project.volumes.length > 1 || explicitVolumes.length > 0;
    // 有分卷时，空着的「正文草稿」容器不再单独成组，免得列表底部挂一个空行
    const isSpareContainer = (volume: VolumeEntry): boolean =>
      !filtering && this.isSpareContainer(volume, explicitVolumes.length);
    const renderable = this.project.volumes.filter(
      (v) => !isSpareContainer(v)
    );
    const lastVolumePath = renderable[renderable.length - 1]?.path ?? null;
    for (const volume of renderable) {
      const matched = filtering
        ? volume.chapters.filter((c) => this.matchesSearch(c))
        : volume.chapters;
      if (matched.length === 0 && filtering) continue;
      const volumeEl = this.bodyEl.createDiv({ cls: "wt-wb-volume" });
      this.volumeViews.push({
        path: volume.path,
        el: showVolumeHeader ? volumeEl : null,
        entries: matched,
      });
      // 拖拽落点：把章节拖到这一卷的任意位置都可以放下
      this.wireDropTarget(volumeEl, volume);
      if (showVolumeHeader) {
        const collapsed =
          !filtering && this.isVolumeCollapsed(volume, lastVolumePath);
        volumeEl.toggleClass("is-collapsed", collapsed);
        const header = volumeEl.createDiv({ cls: "wt-wb-volume-head" });
        header.setAttr("title", "点击折叠 / 展开；右键打开卷菜单");
        const chevron = header.createSpan({ cls: "wt-wb-volume-chevron" });
        setIcon(chevron, "wt-chevron-down");
        header.createSpan({
          cls: "wt-wb-volume-name",
          text: displayFolderName(volume.name),
        });
        const metaEl = header.createSpan({ cls: "wt-wb-volume-meta" });
        metaEl.setText(
          filtering
            ? `${matched.length} 章`
            : volume.chapters.length === 0
            ? "还没有章节"
            : "…"
        );
        // 卷头**不再**放「+」新建按钮（2026-10-16 去掉）：
        // 章号是**全书连续**的，而「在指定卷里新建」会拿全书最大章号 +1 塞进那一卷，
        // 于是第1卷会拿到「第3章」、而第2章在第2卷——顺序与编号立刻对不上
        // （用户报的就是这个：第1卷有第1章、第2卷有第2章，往第1卷加却得到第3章）。
        // 新建统一走顶部「+ 新章节」（落在最后一个**有章节的**卷），编号自然接在末尾。
        // 需要往中间插章时用章节右键菜单的「在下方插入一章」，那条会顺延后面的编号。

        if (!filtering) {
          header.addEventListener("click", () => this.toggleVolume(volume.path));
        }
        bindContextMenu(header, (pt) => this.showVolumeMenu(volume, pt));
        const bar = volumeEl.createDiv({ cls: "wt-wb-volume-bar" });
        const fill = bar.createDiv({ cls: "wt-wb-volume-fill" });
        if (!filtering) this.volumeRefs.push({ volume, metaEl, barEl: fill });
      }
      const listEl = volumeEl.createDiv({ cls: "wt-wb-volume-list" });
      for (const entry of matched) {
        visible.push(entry);
        this.renderChapterRow(listEl, entry);
      }
    }

    if (visible.length === 0 && filtering) {
      this.renderEmpty(`没有找到「${this.searchQuery}」`);
      this.listPaths = [];
      this.keyboardIndex = null;
      return;
    }

    if (chapters.length === 0) {
      this.rebuildListPaths();
      this.finalizeKeyboard();
      this.recomputeTotals();
      return;
    }

    this.rebuildListPaths();
    this.finalizeKeyboard();
    // 搜索时不抢滚动位置，否则结果列表会被拉回当前章
    if (!filtering) this.scrollToCurrent("center");
    else this.updateSearchTargetHighlight();
    this.hydrateFromCache();
    this.recomputeTotals();
  }

  // ---------- 卷折叠 ----------

  /** 用户手动折叠过就听用户的；否则卷多时只展开当前卷和最后一卷。 */
  private isVolumeCollapsed(volume: VolumeEntry, lastVolumePath: string | null): boolean {
    const stored = volumeCollapse.get(volume.path);
    if (stored !== undefined) return stored;
    if (!this.project || this.project.volumes.length <= AUTO_COLLAPSE_VOLUMES) return false;
    if (this.currentPath && volume.chapters.some((c) => c.file.path === this.currentPath)) {
      return false;
    }
    return volume.path !== lastVolumePath;
  }

  private setVolumeCollapsed(path: string, collapsed: boolean): void {
    volumeCollapse.set(path, collapsed);
    const view = this.volumeViews.find((v) => v.path === path);
    view?.el?.toggleClass("is-collapsed", collapsed);
  }

  private toggleVolume(path: string): void {
    const view = this.volumeViews.find((v) => v.path === path);
    if (!view?.el) return;
    this.setVolumeCollapsed(path, !view.el.hasClass("is-collapsed"));
    this.afterCollapseChange();
  }

  private expandVolumeOf(chapterPath: string): void {
    const view = this.volumeViews.find((v) =>
      v.entries.some((c) => c.file.path === chapterPath)
    );
    if (view?.el?.hasClass("is-collapsed")) {
      this.setVolumeCollapsed(view.path, false);
      this.afterCollapseChange();
    }
  }

  /** 折叠变化后：键盘导航只走展开的章节，并尽量保持原来选中的那一章。 */
  private afterCollapseChange(): void {
    const selected =
      this.keyboardIndex !== null ? this.listPaths[this.keyboardIndex] : null;
    this.rebuildListPaths();
    const idx = selected ? this.listPaths.indexOf(selected) : -1;
    this.keyboardIndex = idx >= 0 ? idx : null;
    this.finalizeKeyboard();
  }

  private rebuildListPaths(): void {
    this.listPaths = [];
    for (const view of this.volumeViews) {
      if (view.el?.hasClass("is-collapsed")) continue;
      for (const entry of view.entries) this.listPaths.push(entry.file.path);
    }
    for (const group of this.resourceGroupEls) {
      if (group.el.hasClass("is-collapsed")) continue;
      for (const file of group.files) this.listPaths.push(file.path);
    }
  }

  /** 折叠 / 展开一个设定分类；折叠状态会话内保留。 */
  private toggleResourceGroup(path: string): void {
    const entry = this.resourceGroupEls.find((g) => g.path === path);
    if (!entry) return;
    const collapsed = !entry.el.hasClass("is-collapsed");
    resourceGroupCollapse.set(path, collapsed);
    entry.el.toggleClass("is-collapsed", collapsed);
    this.afterCollapseChange();
  }

  private showVolumeMenu(volume: VolumeEntry, pt: MenuPoint): void {
    const menu = new Menu();
    // 「在本卷末尾新建一章」已移除（2026-10-16）：它走的是 createChapterIn(兜底到活动卷)，
    // 在非末卷上会生成一个**全书最大章号**的章节塞进这一卷，顺序与编号对不上。
    // 新建统一用顶部「+ 新章节」；要在中间插章用章节行的「在下方插入一章」。
    menu.addItem((item) =>
      item.setTitle("只展开本卷").setIcon("wt-fold").onClick(() => {
        for (const view of this.volumeViews) {
          this.setVolumeCollapsed(view.path, view.path !== volume.path);
        }
        this.afterCollapseChange();
      })
    );
    menu.addItem((item) =>
      item.setTitle("展开全部卷").setIcon("wt-unfold").onClick(() => {
        for (const view of this.volumeViews) this.setVolumeCollapsed(view.path, false);
        this.afterCollapseChange();
      })
    );
    menu.addItem((item) =>
      item.setTitle("折叠全部卷").setIcon("wt-fold").onClick(() => {
        for (const view of this.volumeViews) this.setVolumeCollapsed(view.path, true);
        this.afterCollapseChange();
      })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("全书章节重编号…")
        .setIcon("wt-list-ordered")
        .onClick(() => this.renumberBookNow())
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("在系统文件管理器中显示").setIcon("wt-folder").onClick(() => {
        this.host.actions.revealPathInSystem(volume.path);
      })
    );
    if (this.canDeleteVolume(volume)) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("删除卷（移到废纸篓）")
          .setIcon("wt-trash")
          .onClick(() => this.confirmDeleteVolume(volume))
      );
    }
    showMenuAt(menu, pt);
  }

  /** 只允许删除作品目录内明确命名的卷，避免误删作品根目录或正文容器。 */
  private canDeleteVolume(volume: VolumeEntry): boolean {
    const project = this.project;
    return (
      !!project &&
      volume.path !== project.root &&
      volume.path.startsWith(`${project.root}/`) &&
      looksLikeVolumeFolder(volume.name)
    );
  }

  private confirmDeleteVolume(volume: VolumeEntry): void {
    if (!this.canDeleteVolume(volume)) {
      new Notice("只能删除作品目录内的卷目录");
      return;
    }
    const name = displayFolderName(volume.name);
    new ConfirmModal(
      this.app,
      "删除卷",
      `确定删除「${name}」及其中的所有文件和子目录吗？\n本卷包含 ${volume.chapters.length} 章。\n（按你 Obsidian 的「删除文件」设置进系统废纸篓或库内 .trash，可恢复）`,
      "删除",
      () => void this.trashVolume(volume),
      true
    ).open();
  }

  private async trashVolume(volume: VolumeEntry): Promise<void> {
    if (!this.canDeleteVolume(volume)) {
      new Notice("卷目录已变化，请刷新工作台后重试");
      return;
    }
    const folder = this.app.vault.getAbstractFileByPath(volume.path);
    if (!(folder instanceof TFolder)) {
      new Notice("卷目录不存在，请刷新工作台后重试");
      return;
    }
    this.deletingVolumePaths.add(folder.path);
    try {
      await this.app.fileManager.trashFile(folder);
      new Notice(`已删除「${displayFolderName(volume.name)}」（按你的删除设置进废纸篓）`);
    } catch {
      new Notice("删除卷失败");
    } finally {
      this.deletingVolumePaths.delete(folder.path);
    }
  }

  /** 空状态：一句话 + 可选的补充说明。 */
  private renderEmpty(title: string, hint = ""): void {
    const empty = this.bodyEl.createDiv({ cls: "wt-wb-empty" });
    empty.createDiv({ cls: "wt-wb-empty-hint", text: title });
    empty.createDiv({ cls: "wt-wb-empty-sub", text: hint });
  }

  /** 章节完整称呼：有标题「第 3 章 · 标题」，没标题就「第 3 章」。 */
  private chapterLabel(entry: ChapterEntry): string {
    const num = entry.number;
    const prefix = num === null || num === 0 ? "" : `第 ${num} 章`;
    if (!entry.title) return prefix || entry.file.basename;
    return prefix ? `${prefix} · ${entry.title}` : entry.title;
  }

  private renderChapterRow(parent: HTMLElement, entry: ChapterEntry): void {
    const row = parent.createDiv({ cls: "wt-wb-ch" });
    row.setAttr("data-path", entry.file.path);
    row.setAttr("tabindex", "-1");
    // 触屏没有 HTML5 拖拽，手机上改用长按菜单里的「移到…」调整分卷。
    if (!isMobileUI()) row.setAttr("draggable", "true");

    const numEl = row.createSpan({ cls: "wt-wb-ch-num" });
    numEl.setText(
      entry.number === null
        ? "·"
        : entry.number === 0
        ? "序"
        : String(entry.number)
    );

    const hit = this.searchQuery
      ? this.searchHits.get(entry.file.path)
      : undefined;
    const titleWrap = row.createDiv({ cls: "wt-wb-ch-titlewrap" });
    const titleEl = titleWrap.createSpan({ cls: "wt-wb-ch-title" });
    if (entry.title) {
      titleEl.setText(entry.title);
    } else {
      // 没起标题的章节：显示「第 N 章」而不是一排「（无标题）」
      titleEl.addClass("is-untitled");
      titleEl.setText(
        entry.number !== null && entry.number > 0
          ? `第 ${entry.number} 章`
          : entry.file.basename
      );
    }
    titleEl.setAttr("title", entry.file.basename);
    if (hit?.snippet) {
      titleWrap.createSpan({
        cls: "wt-wb-ch-snippet",
        text: hit.snippet,
      });
    }
    if (hit && hit.count > 0) {
      row.createSpan({ cls: "wt-wb-ch-hits", text: `${hit.count} 处` });
    }

    const wordsEl = row.createSpan({ cls: "wt-wb-ch-words", text: "…" });

    const dotEl = row.createSpan({ cls: "wt-wb-ch-dot" });
    dotEl.setAttr("title", "状态");

    const ref: RowRef = {
      entry,
      rowEl: row,
      wordsEl,
      dotEl,
      known: false,
      words: 0,
    };
    this.rows.set(entry.file.path, ref);

    if (entry.file.path === this.currentPath) row.addClass("is-current");

    row.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      if (e.ctrlKey && Platform.isMacOS) return;
      const idx = this.listPaths.indexOf(entry.file.path);
      if (idx >= 0) this.keyboardIndex = idx;
      this.renderKeyboardFocus();
      this.openFile(
        entry.file,
        e.metaKey || (e.ctrlKey && !Platform.isMacOS),
        hit,
        true
      );
    });

    bindContextMenu(row, (pt) => this.showFileMenu(entry.file, pt, entry));

    // 拖拽：把章节拖到别的卷上即可移动（高亮可放的卷）
    row.addEventListener("dragstart", (e) => {
      this.dragPath = entry.file.path;
      row.addClass("is-dragging");
      for (const view of this.volumeViews) {
        view.el?.toggleClass("is-drop-candidate", view.path !== entry.volumePath);
      }
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-wt-chapter", entry.file.path);
      }
    });
    row.addEventListener("dragend", () => {
      row.removeClass("is-dragging");
      this.clearDropMarks();
      this.dragPath = null;
    });
  }

  // ---------- 资料（设定 / 人设） ----------

  private renderResourceBody(project: NovelProject): void {
    if (project.resources.length === 0) {
      this.renderEmpty(
        "这本书还没有设定 / 人设资料",
        "在作品目录下建「人物档案」「前期准备」这类子目录并放入笔记，就会出现在这里。"
      );
      return;
    }

    const activePath = this.app.workspace.getActiveFile()?.path ?? null;
    const filtering = this.searchQuery.length > 0;
    if (filtering && this.searchScanning) {
      this.renderEmpty("正在搜索设定…", "正在读取当前标签下的全部内容");
      this.listPaths = [];
      this.keyboardIndex = null;
      return;
    }
    if (filtering) this.renderSearchSummary();
    const matchedGroups: Array<{ group: ResourceGroup; files: TFile[] }> = [];
    for (const group of project.resources) {
      const files = filtering
        ? group.files.filter((f) => this.searchHits.has(f.path))
        : group.files;
      if (files.length === 0 && filtering) continue;
      matchedGroups.push({ group, files });
    }

    if (matchedGroups.length === 0) {
      this.renderEmpty(`没有找到「${this.searchQuery}」`);
      this.listPaths = [];
      this.keyboardIndex = null;
      return;
    }

    for (const { group, files } of matchedGroups) {
      const collapsed =
        !filtering && resourceGroupCollapse.get(group.path) === true;
      const groupEl = this.bodyEl.createDiv({
        cls: `wt-wb-volume wt-wb-res-group is-${group.kind}`,
      });
      groupEl.toggleClass("is-collapsed", collapsed);
      this.resourceGroupEls.push({ path: group.path, el: groupEl, files });

      const head = groupEl.createDiv({ cls: "wt-wb-volume-head" });
      head.setAttr("title", "点击折叠 / 展开本分类；右键或点 + 新建笔记");
      const chevron = head.createSpan({ cls: "wt-wb-volume-chevron" });
      setIcon(chevron, "wt-chevron-down");
      head.createSpan({
        cls: "wt-wb-volume-name",
        text: displayFolderName(group.name),
      });
      const metaEl = head.createSpan({ cls: "wt-wb-volume-meta" });
      metaEl.setText(`${files.length} 篇`);

      // 分类头悬停浮现「+」按钮，一键在此分类新建笔记
      const addBtn = head.createEl("button", {
        cls: "wt-wb-vol-add",
        attr: {
          type: "button",
          "aria-label": "新建笔记",
          title: `在「${displayFolderName(group.name)}」中新建笔记`,
        },
      });
      setIcon(addBtn, "wt-plus");
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.createNoteIn(group.path);
      });

      if (!filtering) {
        head.addEventListener("click", () => this.toggleResourceGroup(group.path));
      }
      bindContextMenu(head, (pt) => {
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("新建笔记").setIcon("wt-file-plus").onClick(() => {
            this.createNoteIn(group.path);
          })
        );
        menu.addItem((item) =>
          item.setTitle("在系统文件管理器中显示").setIcon("wt-folder").onClick(() => {
            this.host.actions.revealPathInSystem(group.path);
          })
        );
        showMenuAt(menu, pt);
      });

      const listEl = groupEl.createDiv({ cls: "wt-wb-volume-list" });
      for (const file of files) {
        this.renderResourceRow(listEl, file, file.path === activePath);
      }
    }

    this.rebuildListPaths();
    this.finalizeKeyboard();
    if (this.searchQuery) this.updateSearchTargetHighlight();
    this.hydrateFromCache();
    this.recomputeTotals();
  }

  private createNoteIn(folderPath: string): void {
    new TextPromptModal(this.app, "新建笔记", "未命名", (value) => {
      const clean = value.trim().replace(/[\\/:*?"<>|]/g, "");
      if (!clean) return;
      const path = joinPath(folderPath, `${clean}.md`);
      if (this.app.vault.getAbstractFileByPath(path)) {
        new Notice("同名笔记已存在");
        return;
      }
      void this.app.vault
        .create(path, "")
        .then((file) => {
          if (file instanceof TFile) this.openFile(file, false);
        })
        .catch(() => new Notice("新建笔记失败"));
    }).open();
  }

  private renderResourceRow(
    parent: HTMLElement,
    file: TFile,
    isActive: boolean
  ): void {
    const row = parent.createDiv({ cls: "wt-wb-res" });
    row.setAttr("data-path", file.path);
    row.setAttr("tabindex", "-1");
    if (isActive) row.addClass("is-current");

    const { tag, name } = parseResourceName(file.basename);
    const hit = this.searchQuery
      ? this.searchHits.get(file.path)
      : undefined;
    const titleWrap = row.createDiv({ cls: "wt-wb-res-titlewrap" });
    const titleEl = titleWrap.createSpan({ cls: "wt-wb-res-title", text: name });
    titleEl.setAttr("title", file.basename);
    if (hit?.snippet) {
      titleWrap.createSpan({ cls: "wt-wb-res-snippet", text: hit.snippet });
    }
    if (hit && hit.count > 0) {
      row.createSpan({ cls: "wt-wb-res-hits", text: `${hit.count} 处` });
    }
    if (tag) {
      const tagEl = row.createSpan({ cls: "wt-wb-res-tag", text: tag });
      tagEl.setAttr("data-tag", tag);
    }
    const wordsEl = row.createSpan({ cls: "wt-wb-res-words", text: "…" });

    const ref: ResourceRowRef = {
      file,
      rowEl: row,
      wordsEl,
      known: false,
      words: 0,
    };
    this.resourceRows.set(file.path, ref);

    row.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      if (e.ctrlKey && Platform.isMacOS) return;
      const idx = this.listPaths.indexOf(file.path);
      if (idx >= 0) this.keyboardIndex = idx;
      this.renderKeyboardFocus();
      this.openFile(
        file,
        e.metaKey || (e.ctrlKey && !Platform.isMacOS),
        hit,
        true
      );
    });

    bindContextMenu(row, (pt) => this.showFileMenu(file, pt, null));
  }

  // ---------- 后台统计 ----------

  /** 重建后立即用缓存回填已知字数。 */
  private hydrateFromCache(): void {
    for (const ref of this.rows.values()) {
      const cached = statCache.get(ref.entry.file.path);
      if (cached) this.applyChapterStats(ref, cached.words);
    }
    for (const ref of this.resourceRows.values()) {
      const cached = statCache.get(ref.file.path);
      if (cached) this.applyResourceStats(ref, cached.words);
    }
  }

  private async loadStats(project: NovelProject, token: number): Promise<void> {
    const chapters = allChapters(project);
    const files: TFile[] = chapters.map((c) => c.file);
    const seen = new Set(files.map((f) => f.path));
    for (const group of project.resources) {
      for (const file of group.files) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        files.push(file);
      }
    }

    const pending: TFile[] = [];
    for (const file of files) {
      const cached = statCache.get(file.path);
      if (
        cached &&
        cached.mtime === file.stat.mtime &&
        cached.size === file.stat.size
      ) {
        this.applyByPath(file.path, cached.words);
      } else {
        pending.push(file);
      }
    }
    this.recomputeTotals();

    let done = 0;
    for (const file of pending) {
      if (token !== this.statsToken) return;
      let words = 0;
      try {
        const content = await this.app.vault.cachedRead(file);
        words = this.host.actions.countWords(content);
      } catch {
        /* 读取失败按空处理 */
      }
      if (token !== this.statsToken) return;
      statCache.set(file.path, {
        mtime: file.stat.mtime,
        size: file.stat.size,
        words,
      });
      this.applyByPath(file.path, words);
      if (++done % AGGREGATE_EVERY === 0) this.recomputeTotals();
    }
    this.recomputeTotals();
  }

  private applyByPath(path: string, words: number): void {
    const chapterRef = this.rows.get(path);
    if (chapterRef) this.applyChapterStats(chapterRef, words);
    const resRef = this.resourceRows.get(path);
    if (resRef) this.applyResourceStats(resRef, words);
  }

  private applyChapterStats(ref: RowRef, words: number): void {
    ref.known = true;
    ref.words = words;
    ref.wordsEl.setText(words > 0 ? formatNumber(words) : "—");
    ref.wordsEl.toggleClass("is-empty", words === 0);
    ref.dotEl.toggleClass("is-written", words > 0);
    ref.dotEl.toggleClass("is-blank", words === 0);
    ref.dotEl.setAttr("title", words > 0 ? `已写 ${formatNumber(words)} 字` : "还没写");
  }

  private applyResourceStats(ref: ResourceRowRef, words: number): void {
    ref.known = true;
    ref.words = words;
    ref.wordsEl.setText(words > 0 ? `${formatNumber(words)} 字` : "空");
    ref.wordsEl.toggleClass("is-empty", words === 0);
  }

  private recomputeTotals(): void {
    this.updateHeadInfo();

    for (const item of this.volumeRefs) {
      let vKnown = 0;
      let vWords = 0;
      let vWritten = 0;
      for (const chapter of item.volume.chapters) {
        const row = this.rows.get(chapter.file.path);
        if (!row || !row.known) continue;
        vKnown++;
        vWords += row.words;
        if (row.words > 0) vWritten++;
      }
      const vTotal = item.volume.chapters.length;
      item.metaEl.setText(
        `${vWritten}/${vTotal} 章 · ${formatCompact(vWords)} 字` +
          (vKnown < vTotal ? " …" : "")
      );
      const pct = vTotal > 0 ? Math.round((vWritten / vTotal) * 100) : 0;
      item.barEl.style.width = `${pct}%`;
      item.barEl.toggleClass("is-complete", vTotal > 0 && vWritten === vTotal);
    }
  }

  // ---------- ③ 今日仪表 ----------

  private renderFoot(): void {
    const pomo = this.host.stats.getTodayPomodoroSummary();
    const duration = Math.round(this.host.stats.durationSeconds() || 0);
    const todayNet = this.host.stats.total() || 0;
    const todayWords = Math.max(0, todayNet);
    const dailyGoal = Math.max(1, this.host.settings.dailyGoal || 2000);
    const showSpeed = !!this.host.settings.showSpeed;
    const speed = showSpeed ? this.host.stats.todaySpeed() : null;

    const signature = [
      !!this.project,
      todayNet,
      dailyGoal,
      pomo?.count ?? 0,
      duration,
      showSpeed,
      speed ?? "",
      this.currentPath ?? "",
    ].join("|");
    if (signature === this.footSignature) return;
    this.footSignature = signature;

    this.footEl.empty();
    if (!this.project) {
      this.footEl.addClass("wt-wb-foot-empty");
      return;
    }

    const details: Array<{ text: string; title: string; onClick: () => void }> = [];
    if (todayNet !== 0) {
      details.push({
        text: `今日 ${formatNumber(todayNet)} 字`,
        title:
          todayNet < 0
            ? `今日净增 ${formatNumber(todayNet)} 字（新增为正，删除会抵减）· 点击查看明细`
            : `今日目标 ${formatNumber(dailyGoal)} 字（点击查看明细）`,
        onClick: () => this.host.stats.showDailyBreakdown(),
      });
    }
    if (pomo && pomo.count > 0) {
      details.push({
        text: `${pomo.count} 番茄`,
        title: "点击打开工具箱侧栏",
        onClick: () => void this.host.nav.openSidebar(),
      });
    }
    if (duration > 0) {
      details.push({
        text: `码字 ${formatDuration(duration)}`,
        title: "点击打开工具箱侧栏",
        onClick: () => void this.host.nav.openSidebar(),
      });
    }
    if (showSpeed) {
      details.push({
        text: speed !== null ? `时速 ${formatNumber(speed)} 字` : "时速 —",
        title:
          "今日平均时速：今天写下的字 ÷ 写作时长（删除不抵减，粘贴不计入；10 分钟内的停顿算作思考，计入时长）；写满 1 分钟后开始显示",
        onClick: () => void this.host.nav.openSidebar(),
      });
    }

    if (details.length > 0) {
      const pct = Math.min(100, Math.round((todayWords / dailyGoal) * 100));
      if (todayWords > 0) {
        const bar = this.footEl.createDiv({ cls: "wt-wb-foot-bar" });
        const fill = bar.createDiv({
          cls: `wt-wb-foot-fill${todayWords >= dailyGoal ? " is-done" : ""}`,
        });
        fill.style.width = `${pct}%`;
      }
      const detailEl = this.footEl.createDiv({ cls: "wt-wb-foot-detail" });
      for (const item of details) {
        const span = detailEl.createSpan({
          cls: "wt-wb-foot-item is-clickable",
          text: item.text,
          attr: { title: item.title },
        });
        span.addEventListener("click", item.onClick);
      }
    }
    this.footEl.toggleClass("wt-wb-foot-empty", details.length === 0);
  }

  /** 手机版主操作按钮：按当前模式给出动作，没有作品时隐藏。 */
  private updateFab(): void {
    if (!this.fabEl) return;
    const hasProject = !!this.project;
    this.fabEl.toggleClass("is-hidden", !hasProject);
    this.fabEl.setAttr(
      "title",
      this.mode === "chapters" ? "写新章节" : "新建分类"
    );
  }

  private onFab(): void {
    if (!this.project) return;
    if (this.mode === "chapters") {
      void this.createNextChapter();
    } else {
      this.createResourceCategory();
    }
  }

  // ---------- 键盘导航 ----------

  private finalizeKeyboard(): void {
    if (this.listPaths.length === 0) {
      this.keyboardIndex = null;
      return;
    }
    if (
      this.keyboardIndex === null ||
      this.keyboardIndex >= this.listPaths.length
    ) {
      const idx = this.currentPath ? this.listPaths.indexOf(this.currentPath) : -1;
      if (this.searchQuery) this.keyboardIndex = 0;
      else this.keyboardIndex = idx >= 0 ? idx : null;
    }
    this.renderKeyboardFocus();
  }

  private renderKeyboardFocus(): void {
    const target =
      this.keyboardIndex !== null ? this.listPaths[this.keyboardIndex] : null;
    for (const [path, ref] of this.rows) {
      ref.rowEl.toggleClass("is-keyboard", path === target);
    }
    for (const [path, ref] of this.resourceRows) {
      ref.rowEl.toggleClass("is-keyboard", path === target);
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      this.openKeyboardTarget(e.metaKey || e.ctrlKey);
      return;
    }
    if (this.moveKeyboard(e.key)) e.preventDefault();
  }

  /** 方向键 / Home / End 移动列表选中项；返回是否处理了该按键。 */
  private moveKeyboard(key: string): boolean {
    const n = this.listPaths.length;
    if (n === 0) return false;
    const start = this.keyboardIndex;
    let idx = start ?? 0;
    switch (key) {
      case "ArrowDown":
        idx = start === null ? 0 : Math.min(idx + 1, n - 1);
        break;
      case "ArrowUp":
        idx = Math.max(idx - 1, 0);
        break;
      case "Home":
        idx = 0;
        break;
      case "End":
        idx = n - 1;
        break;
      default:
        return false;
    }
    this.keyboardIndex = idx;
    this.renderKeyboardFocus();
    const row =
      this.rows.get(this.listPaths[idx])?.rowEl ??
      this.resourceRows.get(this.listPaths[idx])?.rowEl;
    row?.scrollIntoView({ block: "nearest" });
    return true;
  }

  private openKeyboardTarget(newTab: boolean): void {
    const path = this.listPaths[this.keyboardIndex ?? 0];
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!(file instanceof TFile)) return;
    this.openFile(
      file,
      newTab,
      this.searchQuery ? this.searchHits.get(file.path) : undefined
    );
  }

  private scrollToCurrent(block: ScrollLogicalPosition): void {
    if (!this.currentPath) return;
    this.rows.get(this.currentPath)?.rowEl.scrollIntoView({ block });
  }

  // ---------- 章节定位 ----------

  private lastModifiedChapter(): ChapterEntry | null {
    if (!this.project) return null;
    let best: ChapterEntry | null = null;
    for (const chapter of allChapters(this.project)) {
      if (!best || chapter.file.stat.mtime > best.file.stat.mtime) best = chapter;
    }
    return best;
  }

  // ---------- 菜单与动作 ----------

  private showFileMenu(
    file: TFile,
    pt: MenuPoint,
    entry: ChapterEntry | null
  ): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("打开").onClick(() => this.openFile(file, false))
    );
    menu.addItem((item) =>
      item.setTitle("在新标签页打开").onClick(() => this.openFile(file, true))
    );
    if (entry) {
      menu.addItem((item) =>
        item.setTitle("在下方插入一章").onClick(() => {
          void this.insertChapterAfter(entry);
        })
      );
      menu.addItem((item) =>
        item.setTitle("对比最近快照").onClick(() => {
          void this.host.caps.snapshots.openDiff(entry.file.path);
        })
      );
      // 读者手机预览只在桌面端提供（真机上人已经在手机上了）。
      if (!Platform.isMobile) {
        menu.addItem((item) =>
          item.setTitle("手机预览这一章").onClick(() => {
            this.host.actions.openPhonePreview(entry.file.path);
          })
        );
      }
      const targets = (this.project?.volumes ?? []).filter(
        (v) => v.path !== entry.volumePath
      );
      if (targets.length > 0) {
        menu.addSeparator();
        for (const target of targets) {
          menu.addItem((item) =>
            item
              .setTitle(`移到「${displayFolderName(target.name)}」`)
              .onClick(() => {
                void this.moveChapterTo(entry, target);
              })
          );
        }
      }
    }
    menu.addItem((item) =>
      item.setTitle("在系统文件管理器中显示").onClick(() => {
        this.host.actions.revealPathInSystem(file.path);
      })
    );
    menu.addItem((item) =>
      item.setTitle("重命名").onClick(() => this.renameFile(file))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("删除").onClick(() => {
        void this.app.fileManager.trashFile(file).catch(() => {
          new Notice("删除失败");
        });
      })
    );
    showMenuAt(menu, pt);
  }

  /** 打开文件；带搜索命中时，打开后定位并选中第一处关键字。 */
  private openFile(
    file: TFile,
    newTab: boolean,
    searchHit?: SearchHit,
    focusEditor = false
  ): void {
    const workspace = this.app.workspace;
    const leaf = newTab
      ? workspace.getLeaf("tab")
      : Platform.isMobile
      ? workspace.getMostRecentLeaf(workspace.rootSplit) ??
        workspace.getLeaf("tab")
      : workspace.getLeaf(false);
    const opened = leaf.openFile(file, { active: true });
    if (Platform.isMobile && !newTab) workspace.leftSplit.collapse();
    if (searchHit) this.syncSearchIndex(file, searchHit);
    if (searchHit && searchHit.offset >= 0) {
      void opened
        .then(() =>
          this.selectSearchHit(leaf, file, searchHit, focusEditor)
        )
        .catch((error) => {
          console.error("写作工作台：定位搜索命中失败", error);
        });
    }
  }

  /** 等 Markdown 视图就绪后，把光标移到第一处命中并选中。 */
  private async selectSearchHit(
    leaf: WorkspaceLeaf,
    file: TFile,
    hit: SearchHit,
    focusEditor: boolean
  ): Promise<void> {
    const view = await this.waitForMarkdownView(leaf, file.path);
    if (!view) return;
    this.applyEditorSelection(view, hit.offset, hit.query);
    if (focusEditor) view.editor.focus();
    else this.focusSearchInput();
    this.updateSearchSummary();
    this.updateSearchTargetHighlight();
  }

  /** 打开文件后视图可能晚一拍挂上，最多等 1s。 */
  private async waitForMarkdownView(
    leaf: WorkspaceLeaf,
    path: string
  ): Promise<MarkdownView | null> {
    for (let i = 0; i < 50; i++) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) {
        return view;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    }
    return null;
  }

  private nextChapterNumber(): number {
    if (!this.project) return 1;
    let max = 0;
    for (const chapter of allChapters(this.project)) {
      if (chapter.number !== null && chapter.number > max) max = chapter.number;
    }
    return max + 1;
  }

  private async createNextChapter(): Promise<void> {
    const project = this.project;
    if (!project) return;
    await this.createChapterIn(this.pickTargetVolume(project));
  }

  /**
   * 「新章节」落进哪一卷：**最后一个卷**。
   *
   * 2026-10-16 简化为「末卷」：章号是**全书连续**的（`nextChapterNumber` 取全书最大 +1），
   * 所以只有落在最后一卷，编号与阅读顺序才天然一致。
   * 旧逻辑优先挑「最后一个非空卷之后的空编号卷」，于是出现
   * 「第1卷拿到第3章、而第2章在第2卷」这种顺序与编号对不上的情况。
   *
   * 唯一例外：末尾的空**容器**目录（`正文草稿` 这类）不算数——
   * 已经有显式分卷时，往那里塞章节等于丢出阅读顺序之外。
   */
  private pickTargetVolume(project: NovelProject): string {
    const explicitCount = project.volumes.filter((v) =>
      looksLikeVolumeFolder(v.name)
    ).length;
    const volumes = project.volumes.filter(
      (v) => !this.isSpareContainer(v, explicitCount)
    );
    if (volumes.length === 0) return project.root;
    // 倒数第一个「有章节的」卷；一个都没有时就用最后一卷
    for (let i = volumes.length - 1; i >= 0; i--) {
      if (volumes[i].chapters.length > 0) return volumes[i].path;
    }
    return volumes[volumes.length - 1].path;
  }

  /** 「正文草稿」这类容器目录：已经有显式分卷时，空着的它不再单独成卷。 */
  private isSpareContainer(volume: VolumeEntry, explicitCount: number): boolean {
    return (
      explicitCount > 0 &&
      volume.chapters.length === 0 &&
      !looksLikeVolumeFolder(volume.name) &&
      looksLikeDraftFolder(volume.name, this.host.settings.draftKeywords)
    );
  }

  /** 「新章节」按钮的提示：把目标卷名写出来，免得点完才发现落错卷。 */
  private nextChapterHint(project: NovelProject): string {
    const path = this.pickTargetVolume(project);
    const volume = project.volumes.find((v) => v.path === path);
    if (!volume) return "新建一章";
    return `在「${displayFolderName(volume.name)}」新建一章`;
  }

  /** 在指定卷目录里新建一章并打开：章号取全书最大 + 1，追加在卷末尾。 */
  private async createChapterIn(volumePath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(volumePath);
    if (!(folder instanceof TFolder)) {
      new Notice("卷目录不存在，先刷新一下工作台");
      return;
    }
    let number = this.nextChapterNumber();
    const spaced = this.usesSpacedChapterNames(volumePath);
    const fileName = (n: number): string => (spaced ? `第 ${n} 章.md` : `第${n}章.md`);
    let path = joinPath(volumePath, fileName(number));
    while (this.app.vault.getAbstractFileByPath(path)) {
      number++;
      path = joinPath(volumePath, fileName(number));
    }
    try {
      const file = await this.app.vault.create(path, "");
      if (file instanceof TFile) {
        this.setVolumeCollapsed(volumePath, false);
        this.openFile(file, false);
        new Notice(`已新建「${file.basename}」`);
      }
    } catch {
      new Notice("新建章节失败");
    }
  }

  private async insertChapterAfter(entry: ChapterEntry): Promise<void> {
    const project = this.project;
    if (!project) return;
    const number = entry.number;
    if (number === null || number < 1) {
      new Notice("这一章没有章号，先改成「第n章」再插入");
      return;
    }

    const chapters = allChapters(project).filter((c) => this.isLive(c));
    const startIndex = chapters.findIndex(
      (c) => c.file.path === entry.file.path
    );
    if (startIndex < 0) return;

    const tail: ChapterEntry[] = [];
    let expected = number + 1;
    for (let i = startIndex + 1; i < chapters.length; i++) {
      const c = chapters[i];
      if (c.number === null || c.number !== expected) break;
      tail.push(c);
      expected++;
    }

    const moving = new Set(tail.map((c) => c.file.path));
    const finals = new Set<string>();
    const plans: Array<{ from: string; to: string }> = [];
    for (const c of [...tail].reverse()) {
      const n = c.number;
      if (n === null) break;
      const targetName = renumberChapterName(c.file.basename, n + 1);
      if (!targetName) {
        new Notice(
          `「${c.file.basename}」的编号写法认不出来，已取消（没有改动任何文件）`
        );
        return;
      }
      const to = joinPath(c.file.parent?.path ?? "", `${targetName}.md`);
      if (finals.has(to)) {
        new Notice("顺延后会撞出同名文件，已取消（没有改动任何文件）");
        return;
      }
      finals.add(to);
      if (!moving.has(to) && this.app.vault.getAbstractFileByPath(to)) {
        new Notice(`「${targetName}」已经存在，已取消（没有改动任何文件）`);
        return;
      }
      plans.push({ from: c.file.path, to });
    }

    let renamed = 0;
    for (const plan of plans) {
      const file = this.app.vault.getAbstractFileByPath(plan.from);
      if (!(file instanceof TFile)) break;
      try {
        await this.app.fileManager.renameFile(file, plan.to);
        renamed++;
      } catch {
        break;
      }
    }
    if (renamed < plans.length) {
      new Notice(
        `顺延中断：只改了 ${renamed}/${plans.length} 章，没有新建章节，请检查编号`
      );
      return;
    }

    const fileName = this.usesSpacedChapterNames(entry.volumePath)
      ? `第 ${number + 1} 章.md`
      : `第${number + 1}章.md`;
    const path = joinPath(entry.volumePath, fileName);
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`「${fileName.replace(/\.md$/, "")}」已存在，没有新建`);
      return;
    }
    try {
      const file = await this.app.vault.create(path, "");
      if (file instanceof TFile) this.openFile(file, false);
      new Notice(
        renamed > 0
          ? `已插入第 ${number + 1} 章，后面 ${renamed} 章已顺延`
          : `已插入第 ${number + 1} 章`
      );
      // 收尾：把全书编号过一遍。本卷之后的**其它卷**本来不在这段顺延的扫描范围内
      // （比如从第1卷末插入、第2卷还有章节），只靠上面的顺延会漏掉它们。
      // 编号本来就连续时这一步是空操作，不会白改文件。
      void this.renumberBookQuietly();
    } catch {
      new Notice("插入章节失败");
    }
  }

  /** 静默跑一次全书编号（不弹确认、不打扰；有改动才提示）。 */
  private async renumberBookQuietly(): Promise<void> {
    try {
      await this.applyBookRenumber(false);
    } catch (error) {
      console.error("写作工具箱：章节重编号失败", error);
    }
  }

  private usesSpacedChapterNames(volumePath: string): boolean {
    if (!this.project) return false;
    const numbered = allChapters(this.project).filter(
      (c) => c.number !== null && c.number > 0 && /^第/.test(c.file.basename)
    );
    const sameVolume = numbered.filter((c) => c.volumePath === volumePath);
    const pool = sameVolume.length > 0 ? sameVolume : numbered;
    const sample = pool[pool.length - 1];
    return !!sample && /^第\s+\d+\s+章/.test(sample.file.basename);
  }

  private draftFolderPath(project: NovelProject): string | null {
    const keywords = this.host.settings.draftKeywords;
    const hit = project.volumes
      .filter(
        (v) =>
          v.path !== project.root &&
          !looksLikeVolumeFolder(v.name) &&
          looksLikeDraftFolder(v.name, keywords)
      )
      .sort((a, b) => a.path.length - b.path.length)[0];
    return hit ? hit.path : null;
  }

  private createVolume(): void {
    const project = this.project;
    if (!project) return;
    const draft = this.draftFolderPath(project);
    const suggested = this.suggestVolumeName(project, draft);
    new TextPromptModal(this.app, "新建卷", suggested, (value) => {
      const clean = value.trim().replace(/[\\/:*?"<>|]/g, "");
      if (!clean) {
        new Notice("卷名无效");
        return;
      }
      const name = looksLikeVolumeFolder(clean)
        ? clean
        : `${suggested}·${clean}`;
      const path = joinPath(draft ?? project.root, name);
      if (this.app.vault.getAbstractFileByPath(path)) {
        new Notice("同名卷已存在");
        return;
      }
      void this.app.vault
        .createFolder(path)
        .then(() => new Notice(`已新建「${name}」`))
        .catch(() => new Notice("新建卷失败"));
    }).open();
  }

  private suggestVolumeName(
    project: NovelProject,
    draft: string | null
  ): string {
    const base = draft ?? project.root;
    const baseDepth = base.split("/").length;
    let max = 0;
    for (const volume of project.volumes) {
      if (!volume.path.startsWith(`${base}/`)) continue;
      if (volume.path.split("/").length !== baseDepth + 1) continue;
      const n = volumeNumber(volume.name);
      if (n !== null && n > max) max = n;
    }
    return `第${max + 1}卷`;
  }

  private createResourceCategory(): void {
    const project = this.project;
    if (!project) return;
    const prefix = this.suggestCategoryPrefix(project);
    new TextPromptModal(this.app, "新建分类", prefix, (value) => {
      const clean = value.trim().replace(/[\\/:*?"<>|]/g, "");
      if (!clean) {
        new Notice("分类名无效");
        return;
      }
      const name =
        !prefix || startsWithOrderCode(clean) ? clean : `${prefix} ${clean}`;
      const path = joinPath(project.root, name);
      if (this.app.vault.getAbstractFileByPath(path)) {
        new Notice("同名分类已存在");
        return;
      }
      void this.app.vault
        .createFolder(path)
        .then(() => new Notice(`已新建分类「${name}」`))
        .catch(() => new Notice("新建分类失败"));
    }).open();
  }

  private suggestCategoryPrefix(project: NovelProject): string {
    const root = this.app.vault.getAbstractFileByPath(project.root);
    if (!(root instanceof TFolder)) return "";
    const families = new Map<
      string,
      { head: string; last: number; count: number }
    >();
    for (const child of root.children) {
      if (!(child instanceof TFolder)) continue;
      const m = /^([A-Za-z]{0,2}\d+(?:[.-]\d+)*)[\s.·-]/.exec(child.name);
      if (!m) continue;
      const tail = /^(.*[.-])(\d+)$/.exec(m[1]);
      if (!tail) continue;
      const key = tail[1];
      const fam = families.get(key) ?? { head: key, last: 0, count: 0 };
      fam.last = Math.max(fam.last, parseInt(tail[2], 10));
      fam.count++;
      families.set(key, fam);
    }
    let best: { head: string; last: number; count: number } | null = null;
    for (const fam of families.values()) {
      if (!best || fam.count > best.count) best = fam;
    }
    if (!best) return "";
    return `${best.head}${best.last + 1}`;
  }

  private renameFile(file: TFile): void {
    new TextPromptModal(this.app, "重命名", file.basename, (value) => {
      const clean = value.trim().replace(/[\\/:*?"<>|]/g, "");
      if (!clean || clean === file.basename) return;
      const folder = file.parent?.path ?? "";
      const target = joinPath(folder, `${clean}.md`);
      if (this.app.vault.getAbstractFileByPath(target)) {
        new Notice("同名文件已存在");
        return;
      }
      void this.app.fileManager
        .renameFile(file, target)
        .catch(() => new Notice("重命名失败"));
    }).open();
  }

  private async moveChapterTo(
    entry: ChapterEntry,
    target: VolumeEntry
  ): Promise<void> {
    const file = entry.file;
    if (target.path === entry.volumePath) return;
    const newPath = joinPath(target.path, file.name);
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      new Notice(`「${displayFolderName(target.name)}」里已有同名文件`);
      return;
    }
    try {
      await this.app.fileManager.renameFile(file, newPath);
    } catch {
      new Notice("移动失败");
      return;
    }
    this.setVolumeCollapsed(target.path, false);
    new Notice(
      `已把「${this.chapterLabel(entry)}」移到「${displayFolderName(
        target.name
      )}」`
    );
  }

  private dragEntry(): ChapterEntry | null {
    if (!this.dragPath || !this.project) return null;
    return (
      allChapters(this.project).find((c) => c.file.path === this.dragPath) ??
      null
    );
  }

  private clearDropMarks(): void {
    for (const view of this.volumeViews) {
      view.el?.removeClass("is-drop-target");
      view.el?.removeClass("is-drop-candidate");
    }
  }

  private wireDropTarget(volumeEl: HTMLElement, volume: VolumeEntry): void {
    const accepts = (): ChapterEntry | null => {
      const dragged = this.dragEntry();
      if (!dragged || dragged.volumePath === volume.path) return null;
      return dragged;
    };
    volumeEl.addEventListener("dragover", (e) => {
      if (!accepts()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      volumeEl.addClass("is-drop-target");
    });
    volumeEl.addEventListener("dragleave", (e) => {
      const related = e.relatedTarget as Node | null;
      if (related && volumeEl.contains(related)) return;
      volumeEl.removeClass("is-drop-target");
    });
    volumeEl.addEventListener("drop", (e) => {
      e.preventDefault();
      volumeEl.removeClass("is-drop-target");
      const dragged = accepts();
      if (dragged) void this.moveChapterTo(dragged, volume);
    });
  }

  // ---------- 删除章节后的自动重编号 ----------

  private isLive(entry: ChapterEntry): boolean {
    return this.app.vault.getAbstractFileByPath(entry.file.path) === entry.file;
  }

  /**
   * 按「全书阅读顺序」重新规划并执行章节编号。
   *
   * **这是章节编号的唯一实现**——删除后重排、插入后顺延、手动命令都调它，
   * 免得三处各写一套、行为不一致（历史上删除与插入就是两套，导致插入的
   * 顺延漏掉了「当前章之后」以外的章节）。
   *
   * @param interactive true 时先弹预览确认，改完给通知
   * @returns 实际改名的章节数
   */
  private async applyBookRenumber(interactive: boolean): Promise<number> {
    const project = this.project;
    if (!project) return 0;

    const live = allChapters(project).filter((c) => this.isLive(c));
    // 传「库里全部路径」：规划函数要据此判断目标路径上是否站着**不参与编号**的文件
    // （资料、番外、未命名稿…），否则会撞名覆盖。
    const existingPaths = new Set(
      this.app.vault.getAllLoadedFiles().map((f) => f.path)
    );
    const plan = planBookRenumber(live, existingPaths);
    if (plan.renames === 0) {
      if (interactive) {
        new Notice(
          plan.conflicts > 0
            ? `编号已连续；有 ${plan.conflicts} 章的目标名被占用，已跳过`
            : "全书章节编号已经连续，无需改动"
        );
      }
      return 0;
    }

    if (interactive) {
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (v: boolean) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        new ConfirmModal(
          this.app,
          "全书章节重编号",
          `将按全书阅读顺序重新编号，共 ${plan.renames} 章需要改名` +
            (plan.conflicts > 0 ? `（另有 ${plan.conflicts} 章目标名被占用，会跳过）` : "") +
            `。章纲与批注伴随文件会跟着一起迁移，正文内容不受影响。\n\n` +
            describeRenumberPlan(plan),
          "开始重编号",
          () => done(true),
          true,
          () => done(false)
        ).open();
      });
      if (!ok) return 0;
    }

    let renamed = 0;
    for (const item of plan.items) {
      if (item.conflict) continue; // 计划里只有要改的条目；冲突项跳过，绝不覆盖
      const file = this.app.vault.getAbstractFileByPath(item.path);
      if (!(file instanceof TFile)) continue;
      const targetPath = planPathFor(item.path, item.newName);
      // 执行前再确认一次目标没被占（计划与执行之间用户可能动过文件）
      if (this.app.vault.getAbstractFileByPath(targetPath)) continue;
      try {
        await this.app.fileManager.renameFile(file, targetPath);
        renamed++;
      } catch {
        // 单章失败不中断其余：编号重排是幂等的，用户可以再跑一次
      }
    }

    if (renamed > 0) new Notice(`已重新编号 ${renamed} 章`);
    return renamed;
  }

  private queueChapterRenumber(): void {
    this.renumberChain = this.renumberChain
      .then(async () => {
        await this.applyBookRenumber(false);
      })
      .catch(() => {
        // 单次失败不影响后面的删除事件
      });
  }

}
