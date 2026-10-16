import {
  ItemView,
  Menu,
  Notice,
  Platform,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { getWordCount } from "./wordcount";
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
  countChars,
  getOutlinePath,
  loadOutline,
  readOutlineFromContent,
  saveOutline,
} from "./outlineText";
import {
  ChapterEntry,
  NovelProject,
  ResourceGroup,
  VolumeEntry,
  allChapters,
  discoverProjects,
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
import type WritingToolkitPlugin from "./main";

export const WRITING_TOOLKIT_WORKBENCH = "writing-toolkit-workbench";

/** 章纲自动保存延迟（毫秒） */
const OUTLINE_AUTOSAVE_DELAY = 800;
/** 后台统计每处理多少篇刷新一次聚合数字 */
const AGGREGATE_EVERY = 8;
/** 外部（AI/脚本）改动后的统计防抖 */
const MODIFY_DEBOUNCE = 1500;

export type WorkbenchMode = "chapters" | "resources";

/** 作品连载状态（存在插件数据里，按作品根目录记录） */
export type WorkbenchStatus = "ongoing" | "completed" | "hiatus";

export const STATUS_LABEL: Record<WorkbenchStatus, string> = {
  ongoing: "连载中",
  completed: "已完结",
  hiatus: "暂停更新",
};

/** 文件统计缓存（跨视图重建复用；按 mtime + size 失效） */
interface CachedFileStat {
  mtime: number;
  size: number;
  words: number;
  outline: boolean;
}
const statCache = new Map<string, CachedFileStat>();

/** 供其它视图（主页的作品库页）只读复用的文件字数缓存 */
export const fileStatCache = statCache;

/** 卷折叠状态（会话内跨视图重建保留）：true = 折叠 */
const volumeCollapse = new Map<string, boolean>();

/** 设定分类折叠状态；默认全部展开 */
const resourceGroupCollapse = new Map<string, boolean>();

/** 卷数超过这个值时，默认只展开「当前卷」和「最后一卷」 */
const AUTO_COLLAPSE_VOLUMES = 3;

/** 存档类作品：在作品切换菜单里排到后面 */
export const ARCHIVE_RE = /存档|归档|完结|archive/i;

interface RowRef {
  entry: ChapterEntry;
  rowEl: HTMLElement;
  wordsEl: HTMLElement;
  dotEl: HTMLElement;
  outlineBtn: HTMLElement;
  known: boolean;
  words: number;
  outline: boolean;
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

/** 总字数拆成「数字 + 单位」：超过一万用「万字」。 */
export function splitWords(n: number): [string, string] {
  if (n >= 10000) return [(n / 10000).toFixed(1), "万字"];
  return [formatNumber(n), "字"];
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}

/** 目录名开头的排序码（如「1-1-5-2 」「P3.2-」）只是用来排顺序，展示时去掉。 */
export function displayFolderName(name: string): string {
  const cleaned = name
    .replace(/^[A-Za-z]{0,2}\d+(?:[.-]\d+)*[\s.-]+\s*/, "")
    .trim();
  return cleaned || name;
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
export function displayProjectName(name: string): string {
  const m = /^《(.+)》$/.exec(name.trim());
  return m ? m[1] : name;
}

/**
 * 资料文件名拆分：`【资料】0713-李仪` → 标签「资料」+ 名称「李仪」。
 * 只做显示用，搜索仍匹配完整文件名。
 */
export function parseResourceName(base: string): { tag: string | null; name: string } {
  let tag: string | null = null;
  let rest = base;
  const m = /^[【[]([^】\]]{1,8})[】\]]\s*(.*)$/.exec(base);
  if (m) {
    tag = m[1];
    rest = m[2];
  }
  // 去掉 `0713-` 这类日期前缀（修改时间已单独显示）
  rest = rest.replace(/^\d{4}\s*[-_－—·]\s*/, "").trim();
  return { tag, name: rest || base };
}

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
 * 1. 书头 —— 点击书名切换作品、连载状态胶囊、全书字数与卷数概览、正文/设定切换与轻量新建按钮
 * 2. 台面 —— 搜索框（含清空与一键复制正文）+ 正文章节（分卷可折叠、卷头快速+章、当前章高亮）或设定资料
 * 3. 今日状态 —— 紧凑的今日码字进度细条 + 番茄 / 时长 / 快照速览（可点击交互）
 */
export class WritingToolkitWorkbench extends ItemView {
  private readonly plugin: WritingToolkitPlugin;

  private headEl!: HTMLElement;
  private searchEl!: HTMLElement;
  private searchInputEl: HTMLInputElement | null = null;
  private searchClearBtn: HTMLButtonElement | null = null;
  private noticeEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private footEl!: HTMLElement;
  /** 手机版右下角主操作按钮（新章节 / 新分类） */
  private fabEl!: HTMLButtonElement;

  private projects: NovelProject[] = [];
  private project: NovelProject | null = null;
  private mode: WorkbenchMode = "chapters";
  /** 搜索关键字（章节标题 / 章号 / 资料文件名） */
  private searchQuery = "";

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
  private outlineSaveTimer = 0;
  private copyFeedbackTimer = 0;
  private pendingModify = new Set<string>();

  private openOutlinePath: string | null = null;
  private outlineEditorEl: HTMLElement | null = null;
  private outlineLoadedText = "";
  private outlineFile: TFile | null = null;

  private snapshotCount: number | null = null;
  private snapshotCountPath: string | null = null;
  private footSignature = "";

  constructor(leaf: WorkspaceLeaf, plugin: WritingToolkitPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return WRITING_TOOLKIT_WORKBENCH;
  }

  getDisplayText(): string {
    return "编辑台";
  }

  getIcon(): string {
    return "library-big";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("wt-wb");
    this.mode = this.plugin.getWorkbenchMode();

    this.headEl = this.contentEl.createDiv({ cls: "wt-wb-head" });
    this.searchEl = this.contentEl.createDiv({ cls: "wt-wb-searchbar" });
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
    setIcon(this.fabEl, "plus");
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
    this.registerEvent(
      // 只同步高亮，不重建列表：滚动位置、展开的章纲编辑框都保持不动
      this.app.workspace.on("active-leaf-change", () => this.syncActive())
    );

    this.footTimer = window.setInterval(() => this.renderFoot(), 1000);
    this.render();
  }

  async onClose(): Promise<void> {
    await this.flushOutline();
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    if (this.footTimer) window.clearInterval(this.footTimer);
    if (this.modifyTimer) window.clearTimeout(this.modifyTimer);
    if (this.outlineSaveTimer) window.clearTimeout(this.outlineSaveTimer);
    if (this.copyFeedbackTimer) window.clearTimeout(this.copyFeedbackTimer);
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
   * 手动触发「全书章节重编号」（命令面板 / 卷菜单入口）。
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
    const path = this.plugin.getLastKnownFilePath();
    const text = this.plugin.getLastKnownText();
    if (path && text !== null) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const words = getWordCount(text, this.plugin.settings.wordCountMode);
        const ref = this.rows.get(path);
        const resRef = this.resourceRows.get(path);
        statCache.set(path, {
          mtime: file.stat.mtime,
          size: file.stat.size,
          words,
          outline: ref?.outline ?? false,
        });
        if (ref) this.applyChapterStats(ref, words, ref.outline);
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
    if (file.path === this.plugin.getLastKnownFilePath()) return;
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
        const words = getWordCount(content, this.plugin.settings.wordCountMode);
        const ref = this.rows.get(path);
        statCache.set(path, {
          mtime: file.stat.mtime,
          size: file.stat.size,
          words,
          outline: ref?.outline ?? false,
        });
        const chapterRef = this.rows.get(path);
        if (chapterRef) this.applyChapterStats(chapterRef, words, chapterRef.outline);
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
    this.projects = discoverProjects(this.app, {
      draftKeywords: this.plugin.settings.draftKeywords,
      excludeNames: this.plugin.settings.chapterExcludeNames,
      extraExcluded: [this.plugin.settings.snapshotFolder],
    });
    this.project = this.pickProject();
    this.updateCurrentPath();
    this.keyboardIndex = null;

    this.renderHead();
    this.renderBody();
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

    const remembered = this.plugin.getWorkbenchProject();
    if (remembered) {
      const hit = this.projects.find((p) => p.root === remembered);
      if (hit) return hit;
    }

    const active =
      this.app.workspace.getActiveFile()?.path ??
      this.plugin.getLastKnownFilePath();
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
      this.plugin.getLastKnownFilePath();
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
    setIcon(icon, "info");
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
      this.plugin.setWorkbenchProject(other.root);
      this.render();
      this.plugin.refreshHome();
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
    // 书名：左键可切换作品，右键弹管理菜单，保留窄栏呼吸感
    const bookBtn = top.createEl("button", {
      cls: "wt-wb-book",
      attr: {
        type: "button",
        title: `${this.project.name}（点击切换作品，右键更多操作）`,
      },
    });
    bookBtn.createSpan({
      cls: "wt-wb-book-name",
      text: displayFolderName(displayProjectName(this.project.name)),
    });
    const bookChevron = bookBtn.createSpan({ cls: "wt-wb-book-chevron" });
    setIcon(bookChevron, "chevron-down");

    bookBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = bookBtn.getBoundingClientRect();
      this.showProjectSwitcherMenu({ x: rect.left, y: rect.bottom + 4 });
    });

    bindContextMenu(bookBtn, (pt) => {
      const menu = new Menu();
      if (this.mode === "chapters") {
        menu.addItem((item) =>
          item.setTitle("写新章节").onClick(() => void this.createNextChapter())
        );
        menu.addItem((item) =>
          item.setTitle("新建一卷").onClick(() => this.createVolume())
        );
      } else {
        menu.addItem((item) =>
          item.setTitle("新建分类").onClick(() => this.createResourceCategory())
        );
      }
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle("打开书房主页").onClick(() => void this.plugin.openHome())
      );
      menu.addItem((item) =>
        item.setTitle("在系统文件管理器中显示").onClick(() => {
          if (this.project) this.plugin.revealPathInSystem(this.project.root);
        })
      );
      menu.addItem((item) =>
        item.setTitle("重新扫描作品").onClick(() => this.render())
      );
      showMenuAt(menu, pt);
    });

    // 连载状态放标题行右侧
    this.renderStatusChip(top);

    // 标题下方一行紧凑说明：全书字数 · 卷数 · 最近更新
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

  /** 作品切换菜单：在编辑台内直接切换作品或前往书房主页。 */
  private showProjectSwitcherMenu(pt: MenuPoint): void {
    const menu = new Menu();
    const visible = this.projects.filter(
      (p) => !this.plugin.isProjectHidden(p.root) || p.root === this.project?.root
    );
    const activeList = visible.filter((p) => !ARCHIVE_RE.test(p.name));
    const archiveList = visible.filter((p) => ARCHIVE_RE.test(p.name));

    const addProjectItem = (proj: NovelProject): void => {
      const label = displayFolderName(displayProjectName(proj.name));
      const meta = proj.chapterCount > 0 ? ` (${proj.chapterCount}章)` : "";
      menu.addItem((item) =>
        item
          .setTitle(`${label}${meta}`)
          .setChecked(proj.root === this.project?.root)
          .onClick(() => {
            if (proj.root === this.project?.root) return;
            this.plugin.setWorkbenchProject(proj.root);
            this.render();
            this.plugin.refreshHome();
          })
      );
    };

    for (const proj of activeList) addProjectItem(proj);
    if (archiveList.length > 0) {
      if (activeList.length > 0) menu.addSeparator();
      for (const proj of archiveList) addProjectItem(proj);
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("新建作品…").onClick(() => this.plugin.openNewProjectDialog())
    );
    menu.addItem((item) =>
      item.setTitle("打开书房主页").onClick(() => void this.plugin.openHome())
    );
    showMenuAt(menu, pt);
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

  /** 书头说明行：全书字数 · 卷数 · 最近更新。 */
  private updateHeadInfo(): void {
    const refs = this.headRefs;
    if (!this.project || !refs) return;
    const chapters = allChapters(this.project);
    let latest = 0;
    let totalWords = 0;
    for (const chapter of chapters) {
      latest = Math.max(latest, chapter.file.stat.mtime);
      const row = this.rows.get(chapter.file.path);
      if (row && row.known) {
        totalWords += row.words;
      } else {
        const cached = statCache.get(chapter.file.path);
        if (cached) totalWords += cached.words;
      }
    }
    const info: string[] = [];
    if (totalWords > 0) {
      const [num, unit] = splitWords(totalWords);
      info.push(`${num} ${unit}`);
    }
    // 卷数只数显式分卷目录（第N卷…）；「正文草稿」是容器，不算一卷
    const volumes = this.project.volumes.filter((v) =>
      looksLikeVolumeFolder(v.name)
    ).length;
    if (volumes > 0) info.push(`${volumes} 卷`);
    if (latest > 0) info.push(`更新于 ${relativeTime(latest)}`);
    refs.infoEl.setText(info.join(" · "));
    refs.infoEl.toggleClass("is-empty", info.length === 0);
  }

  /** 连载状态按钮：未标注时也显示，点一下即可设置。 */
  private renderStatusChip(parent: HTMLElement): void {
    if (!this.project) return;
    const status = this.plugin.getWorkbenchStatus(this.project.root);
    const btn = parent.createEl("button", {
      cls: `wt-wb-status is-${status ?? "unset"}`,
      attr: { type: "button", title: "设置连载状态" },
    });
    btn.createSpan({ cls: "wt-wb-status-dot" });
    btn.createSpan({
      cls: "wt-wb-status-text",
      text: status ? STATUS_LABEL[status] : "未标注",
    });
    const chevron = btn.createSpan({ cls: "wt-wb-status-chevron" });
    setIcon(chevron, "chevron-down");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showStatusMenu({ x: e.clientX, y: e.clientY });
    });
  }

  private showStatusMenu(pt: MenuPoint): void {
    const root = this.project?.root;
    if (!root) return;
    const current = this.plugin.getWorkbenchStatus(root);
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
    this.plugin.setWorkbenchStatus(root, status);
    this.renderHead();
    this.plugin.refreshHome();
  }

  private switchMode(mode: WorkbenchMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.plugin.setWorkbenchMode(mode);
    this.keyboardIndex = null;
    this.renderHead();
    this.renderSearchBar();
    this.renderBody();
    this.updateFab();
  }

  // ---------- 搜索栏 ----------

  /** 搜索栏内嵌清空按钮与右侧一键复制按钮，不额外挤占横向宽度。 */
  private renderSearchBar(): void {
    this.searchEl.empty();
    const wrap = this.searchEl.createDiv({ cls: "wt-wb-search-wrap" });
    const icon = wrap.createSpan({ cls: "wt-wb-search-icon" });
    setIcon(icon, "search");
    const input = wrap.createEl("input", {
      cls: "wt-wb-search",
      type: "search",
      placeholder: this.mode === "chapters" ? "搜索章节标题 / 章号" : "搜索资料",
      attr: { title: "↑↓ 选择结果，回车打开，esc 清空" },
    });
    this.searchInputEl = input;
    input.value = this.searchQuery;

    const clearBtn = wrap.createEl("button", {
      cls: `wt-wb-search-clear${this.searchQuery ? "" : " is-hidden"}`,
      attr: { type: "button", "aria-label": "清空搜索", title: "清空搜索 (esc)" },
    });
    setIcon(clearBtn, "x");
    this.searchClearBtn = clearBtn;
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      input.value = "";
      this.searchQuery = "";
      clearBtn.addClass("is-hidden");
      this.keyboardIndex = null;
      this.renderBody();
      input.focus();
    });

    input.addEventListener("input", () => {
      this.searchQuery = input.value.trim();
      this.searchClearBtn?.toggleClass("is-hidden", !this.searchQuery);
      this.keyboardIndex = null;
      this.renderBody();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        input.value = "";
        this.searchQuery = "";
        this.searchClearBtn?.addClass("is-hidden");
        this.keyboardIndex = null;
        this.renderBody();
        input.blur();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.moveKeyboard(e.key);
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.openKeyboardTarget(e.metaKey || e.ctrlKey);
      }
      e.stopPropagation();
    });

    // 搜索框右侧：一键复制本章干净正文（点击后显示 √ 反馈）
    const copyBtn = wrap.createEl("button", {
      cls: "wt-wb-search-copy",
      attr: {
        type: "button",
        "aria-label": "一键复制本章正文",
        title:
          "一键复制本章正文（不含批注标记、批注文件内容；文档没开着也能复制）",
      },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = this.currentPath ?? this.firstChapterPath();
      if (!target) {
        new Notice("先打开一章，或在这篇作品里建一章");
        return;
      }
      void this.plugin.copyCleanChapter(target);
      copyBtn.addClass("is-copied");
      setIcon(copyBtn, "check");
      if (this.copyFeedbackTimer) window.clearTimeout(this.copyFeedbackTimer);
      this.copyFeedbackTimer = window.setTimeout(() => {
        this.copyFeedbackTimer = 0;
        copyBtn.removeClass("is-copied");
        setIcon(copyBtn, "copy");
      }, 1300);
    });
    copyBtn.addEventListener("keydown", (e) => e.stopPropagation());
  }

  /** 当前作品的第一章（没打开任何文档时，复制按钮兜底用）。 */
  private firstChapterPath(): string | null {
    if (!this.project) return null;
    return allChapters(this.project)[0]?.file?.path ?? null;
  }

  private matchesSearch(entry: ChapterEntry): boolean {
    const q = this.searchQuery.toLowerCase();
    if (!q) return true;
    if (entry.title.toLowerCase().includes(q)) return true;
    if (entry.file.basename.toLowerCase().includes(q)) return true;
    if (entry.number !== null && String(entry.number).includes(q)) return true;
    return false;
  }

  // ---------- ② 台面 ----------

  private renderBody(): void {
    // 重建前先把章纲输入内容落盘（同步取出文本，再异步写入）
    if (this.outlineEditorEl) void this.flushOutline();

    this.updateCurrentPath();
    this.bodyEl.empty();
    this.rows.clear();
    this.resourceRows.clear();
    this.volumeRefs = [];
    this.volumeViews = [];
    this.resourceGroupEls = [];
    this.listPaths = [];
    this.outlineEditorEl = null;
    this.openOutlinePath = null;
    this.outlineFile = null;

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
        setIcon(chevron, "chevron-down");
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
      item.setTitle("只展开本卷").setIcon("fold-vertical").onClick(() => {
        for (const view of this.volumeViews) {
          this.setVolumeCollapsed(view.path, view.path !== volume.path);
        }
        this.afterCollapseChange();
      })
    );
    menu.addItem((item) =>
      item.setTitle("展开全部卷").setIcon("unfold-vertical").onClick(() => {
        for (const view of this.volumeViews) this.setVolumeCollapsed(view.path, false);
        this.afterCollapseChange();
      })
    );
    menu.addItem((item) =>
      item.setTitle("折叠全部卷").setIcon("fold-vertical").onClick(() => {
        for (const view of this.volumeViews) this.setVolumeCollapsed(view.path, true);
        this.afterCollapseChange();
      })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("全书章节重编号…")
        .setIcon("list-ordered")
        .onClick(() => this.renumberBookNow())
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("在系统文件管理器中显示").setIcon("folder-open").onClick(() => {
        this.plugin.revealPathInSystem(volume.path);
      })
    );
    if (this.canDeleteVolume(volume)) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("删除卷（移到废纸篓）")
          .setIcon("trash-2")
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

    const titleEl = row.createSpan({ cls: "wt-wb-ch-title" });
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

    const wordsEl = row.createSpan({ cls: "wt-wb-ch-words", text: "…" });

    const outlineBtn = row.createEl("button", {
      cls: "wt-wb-ch-outline",
      attr: { type: "button", title: "写本章章纲" },
    });
    setIcon(outlineBtn, "pen-line");
    outlineBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggleOutline(entry, row);
    });

    const dotEl = row.createSpan({ cls: "wt-wb-ch-dot" });
    dotEl.setAttr("title", "状态");

    const ref: RowRef = {
      entry,
      rowEl: row,
      wordsEl,
      dotEl,
      outlineBtn,
      known: false,
      words: 0,
      outline: false,
    };
    this.rows.set(entry.file.path, ref);

    if (entry.file.path === this.currentPath) row.addClass("is-current");

    row.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      if (e.ctrlKey && Platform.isMacOS) return;
      const idx = this.listPaths.indexOf(entry.file.path);
      if (idx >= 0) this.keyboardIndex = idx;
      this.renderKeyboardFocus();
      this.openFile(entry.file, e.metaKey || (e.ctrlKey && !Platform.isMacOS));
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
    const q = this.searchQuery.toLowerCase();
    const matchedGroups: Array<{ group: ResourceGroup; files: TFile[] }> = [];
    for (const group of project.resources) {
      const files = q
        ? group.files.filter((f) => f.basename.toLowerCase().includes(q))
        : group.files;
      if (files.length === 0 && q) continue;
      matchedGroups.push({ group, files });
    }

    if (matchedGroups.length === 0) {
      this.renderEmpty(`没有找到「${this.searchQuery}」`);
      this.listPaths = [];
      this.keyboardIndex = null;
      return;
    }

    const filtering = q.length > 0;
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
      setIcon(chevron, "chevron-down");
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
      setIcon(addBtn, "plus");
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
          item.setTitle("新建笔记").setIcon("file-plus").onClick(() => {
            this.createNoteIn(group.path);
          })
        );
        menu.addItem((item) =>
          item.setTitle("在系统文件管理器中显示").setIcon("folder-open").onClick(() => {
            this.plugin.revealPathInSystem(group.path);
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
    const titleEl = row.createSpan({ cls: "wt-wb-res-title", text: name });
    titleEl.setAttr("title", file.basename);
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
      this.openFile(file, e.metaKey || (e.ctrlKey && !Platform.isMacOS));
    });

    bindContextMenu(row, (pt) => this.showFileMenu(file, pt, null));
  }

  // ---------- 后台统计 ----------

  /** 重建后立即用缓存回填已知字数。 */
  private hydrateFromCache(): void {
    for (const ref of this.rows.values()) {
      const cached = statCache.get(ref.entry.file.path);
      if (cached) this.applyChapterStats(ref, cached.words, cached.outline);
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
        this.applyByPath(file.path, cached.words, cached.outline);
      } else {
        pending.push(file);
      }
    }
    this.recomputeTotals();

    let done = 0;
    for (const file of pending) {
      if (token !== this.statsToken) return;
      let words = 0;
      let outline = false;
      try {
        const content = await this.app.vault.cachedRead(file);
        words = getWordCount(content, this.plugin.settings.wordCountMode);
        outline =
          (await this.hasOutline(file)) ||
          readOutlineFromContent(content).value.trim().length > 0;
      } catch {
        /* 读取失败按空处理 */
      }
      if (token !== this.statsToken) return;
      statCache.set(file.path, {
        mtime: file.stat.mtime,
        size: file.stat.size,
        words,
        outline,
      });
      this.applyByPath(file.path, words, outline);
      if (++done % AGGREGATE_EVERY === 0) this.recomputeTotals();
    }
    this.recomputeTotals();
  }

  private applyByPath(path: string, words: number, outline: boolean): void {
    const chapterRef = this.rows.get(path);
    if (chapterRef) this.applyChapterStats(chapterRef, words, outline);
    const resRef = this.resourceRows.get(path);
    if (resRef) this.applyResourceStats(resRef, words);
  }

  private async hasOutline(file: TFile): Promise<boolean> {
    try {
      const stat = await this.app.vault.adapter.stat(getOutlinePath(file.path));
      return !!stat && stat.size > 0;
    } catch {
      return false;
    }
  }

  private applyChapterStats(ref: RowRef, words: number, outline: boolean): void {
    ref.known = true;
    ref.words = words;
    ref.outline = outline;
    ref.wordsEl.setText(words > 0 ? formatNumber(words) : "—");
    ref.wordsEl.toggleClass("is-empty", words === 0);
    ref.dotEl.toggleClass("is-written", words > 0);
    ref.dotEl.toggleClass("is-blank", words === 0);
    ref.dotEl.setAttr("title", words > 0 ? `已写 ${formatNumber(words)} 字` : "还没写");
    ref.outlineBtn.toggleClass("is-on", outline);
    ref.outlineBtn.setAttr("title", outline ? "查看 / 编辑本章章纲（已写）" : "写本章章纲");
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
    void this.ensureSnapshotCount();

    const pomo = this.plugin.getTodayPomodoroSummary();
    const duration = Math.round(this.plugin.dailyDurationSeconds || 0);
    const todayWords = Math.max(0, this.plugin.dailyGross || 0);
    const dailyGoal = Math.max(1, this.plugin.settings.dailyGoal || 2000);

    const signature = [
      !!this.project,
      todayWords,
      dailyGoal,
      pomo?.count ?? 0,
      duration,
      this.snapshotCount ?? -1,
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
    if (todayWords > 0) {
      details.push({
        text: `今日 ${formatNumber(todayWords)} 字`,
        title: `今日目标 ${formatNumber(dailyGoal)} 字（点击查看明细）`,
        onClick: () => this.plugin.showDailyBreakdown(),
      });
    }
    if (pomo && pomo.count > 0) {
      details.push({
        text: `${pomo.count} 番茄`,
        title: "点击打开工具箱侧栏",
        onClick: () => void this.plugin.openSidebar(),
      });
    }
    if (duration > 0) {
      details.push({
        text: `码字 ${formatDuration(duration)}`,
        title: "点击打开工具箱侧栏",
        onClick: () => void this.plugin.openSidebar(),
      });
    }
    if (this.snapshotCount !== null && this.snapshotCount > 0) {
      details.push({
        text: `${this.snapshotCount} 快照`,
        title: "点击对比当前章节最近快照",
        onClick: () => {
          if (this.currentPath) {
            void this.plugin.openSnapshotDiffFor(this.currentPath);
          }
        },
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

  private async ensureSnapshotCount(): Promise<void> {
    const path = this.currentPath;
    if (!path || this.snapshotCountPath === path) return;
    this.snapshotCountPath = path;
    this.snapshotCount = null;
    try {
      const entries = await this.plugin.listSnapshotEntries(path);
      if (this.snapshotCountPath !== path) return;
      this.snapshotCount = entries.length;
      this.renderFoot();
    } catch {
      this.snapshotCount = 0;
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
    if (file instanceof TFile) this.openFile(file, newTab);
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
        item.setTitle("编辑章纲").onClick(() => {
          const ref = this.rows.get(entry.file.path);
          if (ref) void this.toggleOutline(entry, ref.rowEl);
        })
      );
      menu.addItem((item) =>
        item.setTitle("对比最近快照").onClick(() => {
          void this.plugin.openSnapshotDiffFor(entry.file.path);
        })
      );
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
        this.plugin.revealPathInSystem(file.path);
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

  /** 打开文件。 */
  private openFile(file: TFile, newTab: boolean): void {
    const workspace = this.app.workspace;
    const leaf = newTab
      ? workspace.getLeaf("tab")
      : Platform.isMobile
      ? workspace.getMostRecentLeaf(workspace.rootSplit) ??
        workspace.getLeaf("tab")
      : workspace.getLeaf(false);
    void leaf.openFile(file, { active: true });
    if (Platform.isMobile && !newTab) workspace.leftSplit.collapse();
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
      looksLikeDraftFolder(volume.name, this.plugin.settings.draftKeywords)
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
    const keywords = this.plugin.settings.draftKeywords;
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

  // ---------- 章纲就地编辑 ----------

  private async toggleOutline(
    entry: ChapterEntry,
    rowEl: HTMLElement
  ): Promise<void> {
    if (this.openOutlinePath === entry.file.path) {
      await this.flushOutline();
      this.closeOutlineEditor();
      return;
    }
    await this.flushOutline();
    this.closeOutlineEditor();

    this.openOutlinePath = entry.file.path;
    this.outlineFile = entry.file;
    this.outlineLoadedText = "";

    const ref = this.rows.get(entry.file.path);
    ref?.outlineBtn.addClass("is-open");

    const box = this.bodyEl.createDiv({ cls: "wt-wb-outline-box" });
    rowEl.after(box);
    this.outlineEditorEl = box;

    const ta = box.createEl("textarea", { cls: "wt-wb-outline-input" });
    ta.placeholder = "本章章纲：剧情梗概、场景要点…";
    ta.spellcheck = false;
    const foot = box.createDiv({ cls: "wt-wb-outline-foot" });
    const stats = foot.createSpan({ cls: "wt-wb-outline-stats", text: "读取中…" });
    const footRight = foot.createDiv({ cls: "wt-wb-outline-foot-right" });
    const state = footRight.createSpan({ cls: "wt-wb-outline-state", text: "" });
    const closeBtn = footRight.createEl("button", {
      cls: "wt-wb-outline-close",
      text: "收起",
      attr: { type: "button", title: "保存并收起 (esc)" },
    });

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.flushOutline(ta, state).then(() => {
        this.closeOutlineEditor();
        this.bodyEl.focus();
      });
    });

    const mode = this.plugin.settings.outlineStorageMode ?? "sidecar";
    let loaded = "";
    try {
      const res = await loadOutline(this.app, entry.file, mode);
      loaded = res.value;
    } catch {
      loaded = "";
    }
    if (this.openOutlinePath !== entry.file.path) return;
    this.outlineLoadedText = loaded;
    ta.value = loaded;
    this.updateOutlineStats(ta.value, stats);
    state.setText(loaded.trim() ? "已保存" : "未填写");

    ta.addEventListener("input", () => {
      this.updateOutlineStats(ta.value, stats);
      state.setText("未保存");
      state.addClass("is-dirty");
      if (this.outlineSaveTimer) window.clearTimeout(this.outlineSaveTimer);
      this.outlineSaveTimer = window.setTimeout(() => {
        this.outlineSaveTimer = 0;
        void this.saveOutlineValue(ta.value, state);
      }, OUTLINE_AUTOSAVE_DELAY);
    });
    ta.addEventListener("blur", () => void this.flushOutline(ta, state));
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
        e.preventDefault();
        void this.flushOutline(ta, state).then(() => {
          this.closeOutlineEditor();
          this.bodyEl.focus();
        });
      }
    });

    ta.focus();
  }

  private updateOutlineStats(value: string, el: HTMLElement): void {
    const chars = countChars(value);
    const paragraphs = value.split("\n").filter((l) => l.trim().length > 0).length;
    el.setText(paragraphs === 0 ? "未填写" : `${paragraphs} 段 · ${chars} 字`);
  }

  private async saveOutlineValue(
    value: string,
    stateEl?: HTMLElement
  ): Promise<void> {
    const file = this.outlineFile;
    if (!file) return;
    if (value === this.outlineLoadedText) return;
    this.outlineLoadedText = value;
    const mode = this.plugin.settings.outlineStorageMode ?? "sidecar";
    try {
      const skip =
        mode === "sidecar" &&
        !value.trim() &&
        !(await this.app.vault.adapter.exists(getOutlinePath(file.path)));
      if (!skip) await saveOutline(this.app, file, value, mode);
      stateEl?.setText(value.trim() ? "已保存" : "未填写");
      stateEl?.removeClass("is-dirty");
      const ref = this.rows.get(file.path);
      const hasContent = value.trim().length > 0;
      if (ref) {
        ref.outline = hasContent;
        ref.outlineBtn.toggleClass("is-on", hasContent);
      }
      const cached = statCache.get(file.path);
      if (cached) cached.outline = hasContent;
      else if (ref && ref.known) {
        statCache.set(file.path, {
          mtime: file.stat.mtime,
          size: file.stat.size,
          words: ref.words,
          outline: hasContent,
        });
      }
    } catch (err) {
      console.error("写作工作台：保存章纲失败", err);
      stateEl?.setText("保存失败");
      new Notice("章纲保存失败");
    }
  }

  private async flushOutline(
    ta?: HTMLTextAreaElement,
    stateEl?: HTMLElement
  ): Promise<void> {
    if (this.outlineSaveTimer) window.clearTimeout(this.outlineSaveTimer);
    this.outlineSaveTimer = 0;
    const box = this.outlineEditorEl;
    if (!box) return;
    const input =
      ta ?? (box.querySelector<HTMLTextAreaElement>("textarea"));
    if (!input) return;
    const state =
      stateEl ??
      box.querySelector<HTMLElement>(".wt-wb-outline-state");
    await this.saveOutlineValue(input.value, state ?? undefined);
  }

  private closeOutlineEditor(): void {
    if (this.openOutlinePath) {
      this.rows.get(this.openOutlinePath)?.outlineBtn.removeClass("is-open");
    }
    this.outlineEditorEl?.remove();
    this.outlineEditorEl = null;
    this.openOutlinePath = null;
    this.outlineFile = null;
  }
}
