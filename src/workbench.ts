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
  looksLikeDraftFolder,
  looksLikeVolumeFolder,
  parseChapterName,
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
    .replace(/^[A-Za-z]{0,2}\d+(?:[.\-]\d+)*[\s.\-]+\s*/, "")
    .trim();
  return cleaned || name;
}

/** 名字是否已经以排序码开头（1-1-5-4 / P3.4 / P4 这种）。 */
function startsWithOrderCode(name: string): boolean {
  return /^[A-Za-z]{0,2}\d+(?:[.\-]\d+)*(\s|[.\-·]|$)/.test(name);
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
  const m = /^[【\[]([^】\]]{1,8})[】\]]\s*(.*)$/.exec(base);
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
 * 「编辑台」：以作品为单位写作面板。
 *
 * 三段结构：
 * 1. 书头 —— 作品切换、全书信息、正文 / 设定·人设 切换
 * 2. 台面 —— 正文章节（卷可折叠）或资料（人物档案、前期准备…）
 * 3. 今日状态 —— 番茄、有效写作时长、本章快照数
 *
 * 切换标签页时只同步高亮，不重建列表，滚动位置保持不动。
 */
export class WritingToolkitWorkbench extends ItemView {
  private readonly plugin: WritingToolkitPlugin;

  private headEl!: HTMLElement;
  private searchEl!: HTMLElement;
  private searchInputEl: HTMLInputElement | null = null;
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
    // 挂在 vault 事件上，工作台菜单、文件列表、系统里删文件都能生效。
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const deletingWithVolume = [...this.deletingVolumePaths].some(
          (path) => file.path.startsWith(`${path}/`)
        );
        if (file instanceof TFile && !deletingWithVolume) {
          this.queueChapterRenumber(file.path, file.basename);
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
    // 切换作品统一在书库页里做，这里只展示当前作品名
    const bookTitle = top.createDiv({
      cls: "wt-wb-book",
      attr: { title: this.project.name },
    });
    bookTitle.createSpan({
      cls: "wt-wb-book-name",
      text: displayProjectName(this.project.name),
    });
    bindContextMenu(bookTitle, (pt) => {
      const menu = new Menu();
      if (this.mode === "chapters") {
        menu.addItem((item) =>
          item.setTitle("新建一卷").onClick(() => this.createVolume())
        );
        menu.addItem((item) =>
          item.setTitle("写新章节").onClick(() => void this.createNextChapter())
        );
      } else {
        menu.addItem((item) =>
          item
            .setTitle("新建分类")
            .onClick(() => this.createResourceCategory())
        );
      }
      menu.addSeparator();
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

    // 标题下方一行淡色说明：卷数 / 最近更新
    const infoEl = this.headEl.createDiv({ cls: "wt-wb-status-info" });
    this.headRefs = { infoEl };
    this.updateHeadInfo();

    // 正文 / 设定·人设 切换；新章节 / 新卷放这一行右侧
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
      // 标签右边的计数：正文 = 章节数，设定 = 资料数
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
      // 正文：新章节 / 新卷（卷 = 正文草稿目录里的「第N卷…」文件夹）
      this.addHeadAction(
        segActions,
        "新章节",
        this.nextChapterHint(this.project),
        true,
        () => void this.createNextChapter()
      );
      this.addHeadAction(segActions, "新卷", "在正文草稿下新建一卷", false, () =>
        this.createVolume()
      );
    } else {
      // 设定：分类就是作品文件夹下新建的资料目录
      this.addHeadAction(
        segActions,
        "新分类",
        "在作品文件夹下新建一个设定分类",
        true,
        () => this.createResourceCategory()
      );
    }
  }

  /** 头部小操作：纯文字按钮，不用图标；primary 为主操作（新章节）。 */
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

  /** 书头说明行：卷数 / 最近更新，正文 / 设定两种模式下一致。 */
  private updateHeadInfo(): void {
    const refs = this.headRefs;
    if (!this.project || !refs) return;
    let latest = 0;
    for (const chapter of allChapters(this.project)) {
      latest = Math.max(latest, chapter.file.stat.mtime);
    }
    const info: string[] = [];
    // 卷数只数显式分卷目录（第N卷…）；「正文草稿」是容器，不算一卷
    const volumes = this.project.volumes.filter((v) =>
      looksLikeVolumeFolder(v.name)
    ).length;
    if (volumes > 0) info.push(`${volumes} 卷`);
    if (latest > 0) info.push(`最近更新 ${relativeTime(latest)}`);
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

  /** 搜索栏只建一次，输入时只重建下面的列表，不会丢焦点。 */
  private renderSearchBar(): void {
    this.searchEl.empty();
    const wrap = this.searchEl.createDiv({ cls: "wt-wb-search-wrap" });
    const icon = wrap.createSpan({ cls: "wt-wb-search-icon" });
    setIcon(icon, "search");
    const input = wrap.createEl("input", {
      cls: "wt-wb-search",
      type: "search",
      placeholder: this.mode === "chapters" ? "搜索章节标题 / 章号" : "搜索资料",
      attr: { title: "↑↓ 选择结果，回车打开，Esc 清空" },
    });
    this.searchInputEl = input;
    input.value = this.searchQuery;
    input.addEventListener("input", () => {
      this.searchQuery = input.value.trim();
      this.keyboardIndex = null;
      this.renderBody();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        input.value = "";
        this.searchQuery = "";
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
        "点上方的「新章节」按钮开始写第一章。"
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
      `确定将「${name}」及其中所有文件和子目录移到系统废纸篓吗？\n本卷包含 ${volume.chapters.length} 章。`,
      "移到废纸篓",
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
      await this.app.vault.trash(folder, true);
      new Notice(`已将「${displayFolderName(volume.name)}」移到系统废纸篓`);
    } catch {
      new Notice("删除卷失败");
    } finally {
      this.deletingVolumePaths.delete(folder.path);
    }
  }

  /** 空状态：一句话 + 可选的补充说明，不配图标。 */
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
      // 和正文章节共用一套「卷」样式：点标题折叠 / 展开
      const collapsed =
        !filtering && resourceGroupCollapse.get(group.path) === true;
      const groupEl = this.bodyEl.createDiv({
        cls: `wt-wb-volume wt-wb-res-group is-${group.kind}`,
      });
      groupEl.toggleClass("is-collapsed", collapsed);
      this.resourceGroupEls.push({ path: group.path, el: groupEl, files });

      const head = groupEl.createDiv({ cls: "wt-wb-volume-head" });
      head.setAttr("title", "点击折叠 / 展开本分类");
      const chevron = head.createSpan({ cls: "wt-wb-volume-chevron" });
      setIcon(chevron, "chevron-down");
      head.createSpan({
        cls: "wt-wb-volume-name",
        text: displayFolderName(group.name),
      });
      const metaEl = head.createSpan({ cls: "wt-wb-volume-meta" });
      metaEl.setText(`${files.length} 篇`);
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
    if (tag) row.createSpan({ cls: "wt-wb-res-tag", text: tag });
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
        // 伴生文件或旧版 frontmatter 里有章纲都算「已写章纲」
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
      item.barEl.style.width = `${
        vTotal > 0 ? Math.round((vWritten / vTotal) * 100) : 0
      }%`;
    }
  }

  // ---------- ③ 今日仪表 ----------

  private renderFoot(): void {
    void this.ensureSnapshotCount();

    const pomo = this.plugin.getTodayPomodoroSummary();
    const duration = Math.round(this.plugin.dailyDurationSeconds || 0);

    const signature = [
      pomo?.count ?? 0,
      duration,
      this.snapshotCount ?? -1,
      this.currentPath ?? "",
    ].join("|");
    if (signature === this.footSignature) return;
    this.footSignature = signature;

    this.footEl.empty();

    // 一行文字：番茄 · 时长 · 快照，没有图标和芯片
    const details: string[] = [];
    if (pomo && pomo.count > 0) details.push(`${pomo.count} 个番茄`);
    if (duration > 0) details.push(`码字 ${formatDuration(duration)}`);
    if (this.snapshotCount !== null && this.snapshotCount > 0) {
      details.push(`${this.snapshotCount} 个快照`);
    }
    if (details.length > 0) {
      const detailEl = this.footEl.createDiv({ cls: "wt-wb-foot-detail" });
      for (const text of details) {
        detailEl.createSpan({ cls: "wt-wb-foot-item", text });
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
      // 搜索时默认选中第一条结果，回车即可打开
      const idx = this.currentPath ? this.listPaths.indexOf(this.currentPath) : -1;
      if (this.searchQuery) this.keyboardIndex = 0;
      // 没有当前章时不预选第一行，免得看起来像「正在打开」
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
    // 章纲编辑框等输入控件里的按键（回车换行、方向键移动光标）不能被列表抢走
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
      // 章节表的分卷管理：移到其它卷（含移回「正文草稿」，即不归卷）
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
      item.setTitle("删除（移到废纸篓）").onClick(() => {
        void this.app.vault.trash(file, true).catch(() => {
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
      // 手机端编辑台在左抽屉里：正文要开到中间去，不能顶掉抽屉自己。
      ? workspace.getMostRecentLeaf(workspace.rootSplit) ??
        workspace.getLeaf("tab")
      : workspace.getLeaf(false);
    void leaf.openFile(file, { active: true });
    // 抽屉里点完章节就收起，把中间留给正文（与自带文件列表的手感一致）。
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
   * 「新章节」该落到哪一卷。
   *
   * 1. 全书最后一章之后还有空着的「第N卷」→ 落到最靠后的那一个：
   *    建了新卷就等于有写它的意图，不必等上一卷写完；
   * 2. 否则落到最后一章所在的卷（= 接着往下写）；
   * 3. 全书还没有章节时，退回最后一个「第N卷」→ 最后一个卷 → 作品根目录。
   *
   * 只看目录结构，不记「最近动过哪一卷」，重启前后行为一致。
   */
  private pickTargetVolume(project: NovelProject): string {
    const explicitCount = project.volumes.filter((v) =>
      looksLikeVolumeFolder(v.name)
    ).length;
    // 「正文草稿」这类容器目录在有分卷时不单独成卷，选目标时也跳过
    const volumes = project.volumes.filter(
      (v) => !this.isSpareContainer(v, explicitCount)
    );

    const chapters = allChapters(project);
    const last = chapters[chapters.length - 1] ?? null;
    if (last) {
      const lastIndex = volumes.findIndex((v) => v.path === last.volumePath);
      if (lastIndex < 0) return last.volumePath;
      const trailingEmpty = volumes
        .slice(lastIndex + 1)
        .filter((v) => v.chapters.length === 0 && looksLikeVolumeFolder(v.name));
      if (trailingEmpty.length > 0) {
        return trailingEmpty[trailingEmpty.length - 1].path;
      }
      return volumes[lastIndex].path;
    }

    const numbered = volumes.filter((v) => looksLikeVolumeFolder(v.name));
    return (
      numbered[numbered.length - 1]?.path ??
      volumes[volumes.length - 1]?.path ??
      project.root
    );
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
        this.openFile(file, false);
        new Notice(`已新建「${file.basename}」`);
      }
    } catch {
      new Notice("新建章节失败");
    }
  }

  /**
   * 在指定章之后插入一章。
   *
   * 新章占用「当前章号 + 1」，它后面**连续编号**的章节整体顺延一位；
   * 遇到断号、无编号、或按卷重新编号（编号突然回退）就停手——
   * 与「删除后自动重编号」完全对称，所以整本书始终保持连号、不留空洞。
   *
   * 改名从大号往小号走（先腾出大号），而且动手之前先预演一遍：
   * 认不出的编号写法、会撞名的目标，一律在改动任何文件之前取消。
   */
  private async insertChapterAfter(entry: ChapterEntry): Promise<void> {
    const project = this.project;
    if (!project) return;
    const number = entry.number;
    if (number === null || number < 1) {
      new Notice("这一章没有章号，先改成「第N章」再插入");
      return;
    }

    const chapters = allChapters(project).filter((c) => this.isLive(c));
    const startIndex = chapters.findIndex(
      (c) => c.file.path === entry.file.path
    );
    if (startIndex < 0) return;

    // 1) 目标章之后、连续编号的那一段（断号/无编号即停）
    const tail: ChapterEntry[] = [];
    let expected = number + 1;
    for (let i = startIndex + 1; i < chapters.length; i++) {
      const c = chapters[i];
      if (c.number === null || c.number !== expected) break;
      tail.push(c);
      expected++;
    }

    // 2) 预演：从大号到小号排出改名计划，发现冲突就整个取消
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
      // 目标位置若是"等会儿会被腾出来的那一个"就正常，否则是真的被占了
      if (!moving.has(to) && this.app.vault.getAbstractFileByPath(to)) {
        new Notice(`「${targetName}」已经存在，已取消（没有改动任何文件）`);
        return;
      }
      plans.push({ from: c.file.path, to });
    }

    // 3) 执行顺延
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

    // 4) 建新章并打开（名字沿用这一卷已有的写法：「第 6 章」/「第6章」）
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
    } catch {
      new Notice("插入章节失败");
    }
  }

  /** 沿用这本书已有的命名习惯：最近一章叫「第 3 章」就新建「第 4 章」，否则「第4章」。 */
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

  /** 作品的「正文草稿」目录；没有就返回 null（新建卷退回作品根目录）。 */
  private draftFolderPath(project: NovelProject): string | null {
    const keywords = this.plugin.settings.draftKeywords;
    const hit = project.volumes
      .filter(
        (v) =>
          v.path !== project.root &&
          // 「卷」也在正文关键词里，先排掉第N卷这类卷目录
          !looksLikeVolumeFolder(v.name) &&
          looksLikeDraftFolder(v.name, keywords)
      )
      .sort((a, b) => a.path.length - b.path.length)[0];
    return hit ? hit.path : null;
  }

  /** 新建卷：建在「正文草稿」目录里（第N卷…），和正常小说的卷一致。 */
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
      // 只写「收尾篇」这类名字时，自动补成「第N卷·收尾篇」，
      // 否则目录不会被识别为卷（会跑到「设定 · 人设」里去）
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

  /** 卷名建议：只数「正文草稿」里的已有卷，顺延编号；没有就从第 1 卷开始。 */
  private suggestVolumeName(
    project: NovelProject,
    draft: string | null
  ): string {
    const base = draft ?? project.root;
    const baseDepth = base.split("/").length;
    let max = 0;
    for (const volume of project.volumes) {
      // 只看 base 目录的直接子文件夹
      if (!volume.path.startsWith(`${base}/`)) continue;
      if (volume.path.split("/").length !== baseDepth + 1) continue;
      const n = volumeNumber(volume.name);
      if (n !== null && n > max) max = n;
    }
    return `第${max + 1}卷`;
  }

  /** 新建设定分类：在作品文件夹下建一个新的资料分类目录（人物档案的兄弟目录）。 */
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
      // 沿用已有的排序码风格：只写名字时自动补成「1-1-5-4 名字」
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

  /**
   * 设定分类的排序码建议：延续作品里已有的编号习惯
   * （1-1-5-3 → 1-1-5-4、P3.3 → P3.4）。找不到可延续的编号就返回空串。
   */
  private suggestCategoryPrefix(project: NovelProject): string {
    const root = this.app.vault.getAbstractFileByPath(project.root);
    if (!(root instanceof TFolder)) return "";
    const families = new Map<
      string,
      { head: string; last: number; count: number }
    >();
    for (const child of root.children) {
      if (!(child instanceof TFolder)) continue;
      const m = /^([A-Za-z]{0,2}\d+(?:[.\-]\d+)*)[\s.\-·]/.exec(child.name);
      if (!m) continue;
      const tail = /^(.*[.\-])(\d+)$/.exec(m[1]);
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

  /**
   * 把一章移到另一卷目录。
   * 正文改名交给 Obsidian（链接、字数基线、快照镜像都会跟着走），
   * 章纲伴生文件在隐藏目录里按路径镜像，要手动一起搬。
   */
  private async moveChapterTo(
    entry: ChapterEntry,
    target: VolumeEntry
  ): Promise<void> {
    const file = entry.file;
    if (target.path === entry.volumePath) return;
    const oldPath = file.path;
    const newPath = joinPath(target.path, file.name);
    if (this.app.vault.getAbstractFileByPath(newPath)) {
      new Notice(`「${displayFolderName(target.name)}」里已有同名文件`);
      return;
    }
    try {
      // 章纲伴生文件由插件级的 rename 监听统一搬走，这里不再重复处理
      await this.app.fileManager.renameFile(file, newPath);
    } catch {
      new Notice("移动失败");
      return;
    }
    // 拖到折叠的卷里时，顺手展开，让用户看到结果
    this.setVolumeCollapsed(target.path, false);
    new Notice(
      `已把「${this.chapterLabel(entry)}」移到「${displayFolderName(
        target.name
      )}」`
    );
  }

  /** 拖拽中的章节条目（从当前作品里按路径找回）。 */
  private dragEntry(): ChapterEntry | null {
    if (!this.dragPath || !this.project) return null;
    return (
      allChapters(this.project).find((c) => c.file.path === this.dragPath) ??
      null
    );
  }

  /** 清掉拖拽期间的全部高亮。 */
  private clearDropMarks(): void {
    for (const view of this.volumeViews) {
      view.el?.removeClass("is-drop-target");
      view.el?.removeClass("is-drop-candidate");
    }
  }

  /** 让一个卷组成为拖拽落点：高亮 + 放下即移动。 */
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

  /** 章节在库里是否还活着（快照可能已被删掉或搬走）。 */
  private isLive(entry: ChapterEntry): boolean {
    return this.app.vault.getAbstractFileByPath(entry.file.path) === entry.file;
  }

  /** 删除事件先入队，重命名串行执行，避免连续删除时互相踩踏。 */
  private queueChapterRenumber(path: string, basename: string): void {
    this.renumberChain = this.renumberChain
      .then(() => this.renumberAfterDelete(path, basename))
      .catch(() => {
        // 单次失败不影响后面的删除事件
      });
  }

  /**
   * 章节被删掉后，把后面连号的章节整体前移一位：
   * 删第3章 → 原第4章→第3章、第5章→第4章……遇到断号、无编号、认不出的名字就停下。
   * 快照可能还没刷新（重绘是防抖的），所以一律以当前文件名和 vault 里的实际对象为准。
   */
  private async renumberAfterDelete(
    deletedPath: string,
    deletedBasename: string
  ): Promise<void> {
    const project = this.project;
    if (!project) return;
    const deletedNumber = parseChapterName(deletedBasename).number;
    // 序章（0）、番外、没有编号的章节不触发顺移
    if (deletedNumber === null || deletedNumber <= 0) return;
    const deletedFolder = deletedPath.slice(0, deletedPath.lastIndexOf("/"));
    const volumeIndex = new Map(
      project.volumes.map((v, i) => [v.path, i] as const)
    );
    // 章节可能位于卷目录的子目录里（如 卷/正文草稿/第2章.md），
    // 因此不能精确匹配父目录，要找路径前缀最长的那个卷。
    let deletedVolume: number | undefined;
    let bestLen = -1;
    for (const [volPath, idx] of volumeIndex) {
      if (deletedPath.startsWith(`${volPath}/`) && volPath.length > bestLen) {
        bestLen = volPath.length;
        deletedVolume = idx;
      }
    }
    // 不是卷目录里的删除（设定资料、其它文件夹）不处理
    if (deletedVolume === undefined) return;
    // 删除整卷时，卷内章节可能也触发 delete 事件；父目录已不存在，跳过逐章重编号。
    if (
      deletedFolder !== project.root &&
      !this.app.vault.getAbstractFileByPath(deletedFolder)
    ) {
      return;
    }

    const all = allChapters(project);
    // 刚被删掉、或已被改名搬走的旧条目：vault 里已经找不到这个对象了
    const live = all.filter((c) => this.isLive(c));
    const liveNumber = (c: ChapterEntry): number | null =>
      parseChapterName(c.file.basename).number;

    // 被删章节在现存列表里的起点：条目还在快照里就数它后面有几个活着的；
    // 快照已刷新就按「所在卷 + 章号」定位到第一个章号 ≥ 被删章号的现存章节。
    let start = -1;
    const snapshotIndex = all.findIndex((c) => c.file.path === deletedPath);
    if (snapshotIndex >= 0) {
      let before = 0;
      for (let i = 0; i <= snapshotIndex; i++) {
        if (this.isLive(all[i])) before++;
      }
      start = before;
    } else {
      start = live.findIndex((c) => {
        const vi = volumeIndex.get(c.volumePath);
        if (vi === undefined || vi < deletedVolume) return false;
        if (vi > deletedVolume) return true;
        const n = liveNumber(c);
        return n !== null && n >= deletedNumber;
      });
      if (start < 0) start = live.length;
    }

    let expected = -1;
    let renamed = 0;
    for (let i = start; i < live.length; i++) {
      const entry = live[i];
      const n = liveNumber(entry);
      if (n === null) break;
      if (expected < 0) {
        // 正常应从「被删章号 + 1」开始；若是上一轮顺延刚移进来的同号章节，也接着走
        if (n !== deletedNumber && n !== deletedNumber + 1) break;
        expected = n;
      } else if (n !== expected) {
        break;
      }
      const targetName = renumberChapterName(entry.file.basename, n - 1);
      if (!targetName || targetName === entry.file.basename) break;
      const targetPath = joinPath(entry.file.parent?.path ?? "", `${targetName}.md`);
      // 目标名被占着（人为放进去的同名文件），不硬来
      if (this.app.vault.getAbstractFileByPath(targetPath)) break;
      try {
        await this.app.fileManager.renameFile(entry.file, targetPath);
      } catch {
        break;
      }
      renamed++;
      expected++;
    }
    if (renamed > 0) {
      new Notice(`已删除「${deletedBasename}」，后面 ${renamed} 章已重编号`);
    }
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

    const box = this.bodyEl.createDiv({ cls: "wt-wb-outline-box" });
    rowEl.after(box);
    this.outlineEditorEl = box;

    const ta = box.createEl("textarea", { cls: "wt-wb-outline-input" });
    ta.placeholder = "本章章纲：剧情梗概、场景要点…";
    ta.spellcheck = false;
    const foot = box.createDiv({ cls: "wt-wb-outline-foot" });
    const stats = foot.createSpan({ cls: "wt-wb-outline-stats", text: "读取中…" });
    foot.createSpan({ cls: "wt-wb-outline-hint", text: "自动保存 · Esc 收起" });
    const state = foot.createSpan({ cls: "wt-wb-outline-state", text: "" });

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
      // 按键只属于输入框：回车换行、方向键移动光标，不触发列表导航
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
      // 空章纲且本来就没有伴生文件：不创建空文件
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
      ta ?? (box.querySelector("textarea") as HTMLTextAreaElement | null);
    if (!input) return;
    const state =
      stateEl ??
      (box.querySelector(".wt-wb-outline-state") as HTMLElement | null);
    await this.saveOutlineValue(input.value, state ?? undefined);
  }

  private closeOutlineEditor(): void {
    this.outlineEditorEl?.remove();
    this.outlineEditorEl = null;
    this.openOutlinePath = null;
    this.outlineFile = null;
  }
}
