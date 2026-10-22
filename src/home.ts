import {
  App,
  FuzzySuggestModal,
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type { CalendarHandle, UiShellContext } from "./uiShellContext";
import { DAILY_DISPLAY_MODE_LABELS } from "./settings";
import {
  ChapterEntry,
  NovelProject,
  allChapters,
  isInternalPath,
} from "./project";
import {
  ARCHIVE_RE,
  STATUS_LABEL,
  WORD_COUNT_MODE_LABELS,
  displayFolderName,
  displayProjectName,
  fileStatCache,
  parseResourceName,
  relativeTime,
  splitWords,
  type WorkbenchStatus,
} from "./uiShellShared";
import {
  bindContextMenu,
  showMenuAt,
  type MenuPoint,
} from "./mobile";
import { WRITING_TOOLKIT_HOME } from "./uiSlots";
import {
  PLAN_COLUMNS,
  PLAN_COLUMN_LABEL,
  isRecentlyDone,
  planDateLabel,
  planDayKey,
  planDueState,
  planFocusItems,
  columnItems,
  type PlanColumn,
  type PlanItem,
  type PlanItemPatch,
} from "./planBoard";
import type { WordCountMode } from "./wordcount";

export { WRITING_TOOLKIT_HOME } from "./uiSlots";

/** 中间大页面的四块入口；以后想加别的，往这一列里放。 */
export type HomePage = "desk" | "board" | "library" | "stats" | "docs";

/** 书架的两种摆法：封面网格 / 紧凑列表 */
export type LibraryView = "grid" | "list";

const PAGES: Array<{ key: HomePage; label: string; icon: string }> = [
  { key: "desk", label: "书桌", icon: "wt-desk" },
  { key: "board", label: "看板", icon: "wt-board" },
  { key: "library", label: "书架", icon: "wt-shelf" },
  { key: "stats", label: "数据统计", icon: "wt-stats" },
  { key: "docs", label: "资料库", icon: "wt-archive" },
];

/** 看板：按哪本书筛选（null = 全部）、「更早完成」是否展开：会话内保留 */
const boardView: { book: string | null; olderOpen: boolean } = {
  book: null,
  olderOpen: false,
};

/** 看板上出现的一本书：名字（写在看板文件里的 📚）+ 标签色（与封面书衣同色） */
interface PlanBook {
  name: string;
  tone: string;
  project: NovelProject | null;
}

/** 书桌「计划」卡最多列几条 */
const DESK_PLAN_LIMIT = 5;

/** 书架折叠分组（存档 / 已隐藏）的展开状态：会话内保留 */
const libFoldOpen = { archive: false, hidden: false };
/** 数据统计页「统计设置」是否展开：会话内保留 */
let statsSettingsOpen = false;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"]);

/** 没有自定义封面时的书衣配色：取传统色，按作品路径固定挑一种 */
const COVER_TONES = [
  { cloth: "#2f4a5f", label: "#efe6d2" }, // 黛蓝
  { cloth: "#8a4a2c", label: "#f2e7d1" }, // 赭石
  { cloth: "#3e6650", label: "#ede6d0" }, // 松绿
  { cloth: "#922d35", label: "#f3e6d4" }, // 胭脂
  { cloth: "#2a3854", label: "#ebe3cf" }, // 藏青
  { cloth: "#83703a", label: "#f4ead2" }, // 秋香
  { cloth: "#5f3b37", label: "#efe4d3" }, // 檀色
  { cloth: "#25607a", label: "#ede6d4" }, // 石青
];

const WEEKDAY = "日一二三四五六";

interface WordEntry {
  mtime: number;
  size: number;
  words: number;
}

/** 本视图自己的字数缓存；只读复用工作台视图的缓存，绝不回写（那边还带章纲状态） */
const homeWordCache = new Map<string, WordEntry>();

/** 作品最近一次被改动的时间（章节优先，没有章节就看资料） */
function projectActivity(project: NovelProject): number {
  let latest = 0;
  for (const chapter of allChapters(project)) {
    latest = Math.max(latest, chapter.file.stat.mtime);
  }
  if (latest === 0) {
    for (const group of project.resources) {
      for (const file of group.files) latest = Math.max(latest, file.stat.mtime);
    }
  }
  return latest;
}

/** 最近改过的那一章：书桌「接着写」就打开它 */
function lastEditedChapter(project: NovelProject): ChapterEntry | null {
  let best: ChapterEntry | null = null;
  for (const chapter of allChapters(project)) {
    if (!best || chapter.file.stat.mtime > best.file.stat.mtime) best = chapter;
  }
  return best;
}

function chapterLabel(chapter: ChapterEntry): string {
  if (chapter.number === null) return chapter.file.basename;
  return chapter.title
    ? `第${chapter.number}章 ${chapter.title}`
    : `第${chapter.number}章`;
}

/** 封面题签上的书名：去掉《》和排序码 */
function coverTitle(name: string): string {
  return displayFolderName(displayProjectName(name));
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() + n);
  return out;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 柱状图头上的短数字：1.2万 / 3,456 */
function shortWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return fmt(n);
}

function formatMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 截至 today 的连续写作天数；今天还没写时从昨天往回数 */
function currentStreak(hist: Record<string, number>, today: Date): number {
  let cursor = (hist[dayKey(today)] ?? 0) > 0 ? today : addDays(today, -1);
  let n = 0;
  while ((hist[dayKey(cursor)] ?? 0) > 0) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

function longestStreak(hist: Record<string, number>): number {
  const days = Object.keys(hist)
    .filter((k) => (hist[k] ?? 0) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
  let best = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of days) {
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    run = prev && dayKey(addDays(prev, 1)) === key ? run + 1 : 1;
    best = Math.max(best, run);
    prev = date;
  }
  return best;
}

/** 给计划条目挑截止日：原生日期选择 + 今天 / 明天 / 下周一快捷键 + 清除 */
class PlanDateModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly current: string | null,
    private readonly onPick: (due: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wt-plan-date-modal");
    contentEl.createEl("h3", { text: "截止日期" });
    contentEl.createDiv({ cls: "wt-plan-date-for", text: this.title });

    const today = new Date();
    const input = contentEl.createEl("input", {
      cls: "wt-plan-date-input",
      attr: { type: "date" },
    });
    input.value = this.current ?? planDayKey(today);

    const quick = contentEl.createDiv({ cls: "wt-plan-date-quick" });
    const nextMonday = addDays(today, ((8 - today.getDay()) % 7) || 7);
    for (const [label, date] of [
      ["今天", today],
      ["明天", addDays(today, 1)],
      ["下周一", nextMonday],
    ] as const) {
      quick
        .createEl("button", { cls: "wt-btn is-quiet", text: label, attr: { type: "button" } })
        .addEventListener("click", () => this.pick(planDayKey(date)));
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("确定")
          .setCta()
          .onClick(() => this.pick(input.value || null))
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.current ? "清除日期" : "取消")
          .onClick(() => (this.current ? this.pick(null) : this.close()))
      );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.pick(input.value || null);
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private pick(due: string | null): void {
    this.close();
    this.onPick(due);
  }
}

interface PlanDetailOptions {
  /** 可选的作品（书架上未隐藏、未存档的） */
  projects: NovelProject[];
  /** 看板文件路径：章节链接按它算最短写法 */
  boardPath: string;
  onSave: (patch: PlanItemPatch) => void;
  onDelete: () => void;
}

/** 卡片详情：标题、列、作品、关联章节、截止日、备注；保存一次写回 */
class PlanDetailModal extends Modal {
  constructor(
    app: App,
    private readonly item: PlanItem,
    private readonly opts: PlanDetailOptions
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, item, opts } = this;
    contentEl.empty();
    this.modalEl.addClass("wt-plan-detail");

    const title = contentEl.createEl("textarea", {
      cls: "wt-plan-detail-title",
      attr: { rows: "2", placeholder: "卡片标题" },
    });
    title.value = item.text;

    const grid = contentEl.createDiv({ cls: "wt-plan-detail-grid" });
    const field = (label: string): HTMLElement => {
      grid.createDiv({ cls: "wt-plan-detail-label", text: label });
      return grid.createDiv({ cls: "wt-plan-detail-value" });
    };

    const columnSel = field("列").createEl("select", { cls: "dropdown" });
    for (const column of PLAN_COLUMNS) {
      columnSel.createEl("option", { value: column, text: PLAN_COLUMN_LABEL[column] });
    }
    columnSel.value = item.column;

    const bookSel = field("作品").createEl("select", { cls: "dropdown" });
    bookSel.createEl("option", { value: "", text: "不归属某本书" });
    const names = opts.projects.map((p) => p.name);
    if (item.book && !names.includes(item.book)) names.push(item.book);
    for (const name of names) {
      bookSel.createEl("option", { value: name, text: displayProjectName(name) });
    }
    bookSel.value = item.book ?? "";

    const chapterSel = field("关联章节").createEl("select", { cls: "dropdown" });
    const fillChapters = (): void => {
      const keep = chapterSel.value || item.chapter || "";
      chapterSel.empty();
      chapterSel.createEl("option", { value: "", text: "不关联章节" });
      const project = opts.projects.find((p) => p.name === bookSel.value);
      const links: string[] = [];
      for (const chapter of project ? allChapters(project) : []) {
        const link = this.app.metadataCache.fileToLinktext(chapter.file, opts.boardPath, true);
        links.push(link);
        chapterSel.createEl("option", { value: link, text: chapterLabel(chapter) });
      }
      if (keep && !links.includes(keep)) chapterSel.createEl("option", { value: keep, text: keep });
      chapterSel.value = keep;
      chapterSel.disabled = !project && !keep;
    };
    fillChapters();
    bookSel.addEventListener("change", () => {
      chapterSel.value = "";
      fillChapters();
    });

    const dueBox = field("截止日期");
    const due = dueBox.createEl("input", { cls: "wt-plan-detail-date", attr: { type: "date" } });
    due.value = item.due ?? "";
    const clearDue = dueBox.createEl("button", {
      cls: "wt-btn is-quiet",
      text: "清除",
      attr: { type: "button" },
    });
    clearDue.addEventListener("click", () => (due.value = ""));

    contentEl.createDiv({ cls: "wt-plan-detail-label is-block", text: "备注" });
    const notes = contentEl.createEl("textarea", {
      cls: "wt-plan-detail-notes",
      attr: { rows: "6", placeholder: "写点细节：要写到哪、注意什么……（写进看板文件里这张卡下面的缩进行）" },
    });
    notes.value = item.notes.join("\n");

    const actions = contentEl.createDiv({ cls: "wt-plan-detail-actions" });
    const del = actions.createEl("button", { cls: "mod-warning", text: "删除卡片", attr: { type: "button" } });
    del.addEventListener("click", () => {
      this.close();
      opts.onDelete();
    });
    actions.createDiv({ cls: "wt-plan-detail-spacer" });
    actions
      .createEl("button", { text: "取消", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存", attr: { type: "button" } });

    const submit = (): void => {
      const text = title.value.trim();
      if (!text) {
        title.focus();
        return;
      }
      const patch: PlanItemPatch = {};
      if (text !== item.text) patch.text = text;
      if ((due.value || null) !== item.due) patch.due = due.value || null;
      if ((bookSel.value || null) !== item.book) patch.book = bookSel.value || null;
      if ((chapterSel.value || null) !== item.chapter) patch.chapter = chapterSel.value || null;
      const noteText = notes.value.trim();
      if (noteText !== item.notes.join("\n")) patch.notes = noteText;
      if (columnSel.value !== item.column) patch.column = columnSel.value as PlanColumn;
      this.close();
      if (Object.keys(patch).length > 0) opts.onSave(patch);
    };
    save.addEventListener("click", submit);
    contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => {
      title.focus();
      title.setSelectionRange(title.value.length, title.value.length);
    }, 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 从仓库里挑一张图片当封面 */
class CoverPickModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly images: TFile[],
    private readonly onPick: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("输入文件名，挑一张图片作为封面");
  }

  getItems(): TFile[] {
    return this.images;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}

/**
 * 「主页」：中间大页面里的内嵌小软件。
 *
 * 自带导航（书桌 / 看板 / 书架 / 数据统计 / 资料库）。书桌回答「今天写到哪、接着写哪」；
 * 书架管所有书；写作本身仍在左侧工作台，临时工具留在右侧「工具箱」。
 */
export class WritingToolkitHome extends ItemView {
  private readonly host: UiShellContext;
  private page: HomePage = "desk";
  private mainEl!: HTMLElement;
  private navEls = new Map<HomePage, HTMLElement>();
  private railTodayEl: HTMLElement | null = null;

  private calendar: CalendarHandle | null = null;
  private calendarYear: number | null = null;
  private statsProjectKey: string | null = null;

  private libQuery = "";
  private docsQuery = "";
  private docsTag: string | null = null;

  /** 字数变化时要跟着刷新的小部件（每次换页清空） */
  private liveUpdaters: Array<() => void> = [];

  /** 逐文件填字数的队列（书架整本合计、资料库单篇） */
  private wordJobs: Array<{ file: TFile; apply: (words: number) => void }> = [];
  private wordDraining = false;

  private refreshTimer = 0;
  private enterTimer = 0;
  private closed = false;
  private wasActive = false;
  /** 看板「＋ 添加」正开着输入框的那一列：写回后页面重画，靠它把输入框接着打开 */
  private boardAdding: PlanColumn | null = null;
  /** 每次重画加一；异步读完看板文件时据此丢掉过期的结果 */
  private renderSeq = 0;

  constructor(leaf: WorkspaceLeaf, host: UiShellContext) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return WRITING_TOOLKIT_HOME;
  }

  getDisplayText(): string {
    return "主页";
  }

  getIcon(): string {
    return "wt-home";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.page = this.host.prefs.getHomePage();
    if (this.page === "board" && Platform.isMobile) this.page = "desk";
    this.contentEl.empty();
    this.contentEl.addClass("wt-home");

    const rail = this.contentEl.createDiv({ cls: "wt-home-rail" });
    const brand = rail.createDiv({ cls: "wt-home-brand" });
    brand.createSpan({ cls: "wt-home-seal", text: "写" });
    brand.createSpan({ cls: "wt-home-brand-name", text: "写作台" });

    const nav = rail.createDiv({ cls: "wt-home-navs" });
    this.navEls.clear();
    for (const def of PAGES) {
      // 看板目前只做桌面端
      if (def.key === "board" && Platform.isMobile) continue;
      const btn = nav.createEl("button", {
        cls: "wt-home-nav",
        attr: { type: "button" },
      });
      setIcon(btn.createSpan({ cls: "wt-home-nav-icon" }), def.icon);
      btn.createSpan({ cls: "wt-home-nav-label", text: def.label });
      btn.addEventListener("click", () => this.switchPage(def.key));
      this.navEls.set(def.key, btn);
    }

    // 导航底部常驻的今日进度，点一下回书桌
    this.railTodayEl = rail.createDiv({ cls: "wt-rail-today" });
    this.railTodayEl.setAttr("title", "回到书桌");
    this.railTodayEl.addEventListener("click", () => this.switchPage("desk"));

    this.mainEl = this.contentEl.createDiv({ cls: "wt-home-main" });

    // 增删改名（新建作品、AI 写新章节等）后刷新数据页
    const structural = (file: TAbstractFile): void => {
      if (isInternalPath(file.path)) return;
      this.refreshSoon();
    };
    this.registerEvent(this.app.vault.on("create", structural));
    this.registerEvent(this.app.vault.on("delete", structural));
    this.registerEvent(this.app.vault.on("rename", structural));
    // 看板文件变了（本机写回、手改、网盘同步）：书桌和看板页重画
    this.register(
      this.host.caps.planBoard.subscribe(() => {
        if (this.page === "desk" || this.page === "board") this.refreshSoon();
      })
    );
    // 切回本页面时轻量刷新一次（写了一会儿再回来看，数字要是新的）
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const active = leaf === this.leaf;
        if (active && !this.wasActive) this.refreshSoon();
        this.wasActive = active;
      })
    );

    this.renderPage(true);
  }

  async onClose(): Promise<void> {
    this.closed = true;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    if (this.enterTimer) window.clearTimeout(this.enterTimer);
    this.wordJobs = [];
    this.liveUpdaters = [];
    this.calendar?.destroy();
    this.calendar = null;
    this.contentEl.empty();
  }

  // ---------- 对外刷新入口 ----------

  /** 结构性变化后的整体重建（防抖）。 */
  private refreshSoon(): void {
    if (this.closed) return;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = 0;
      if (this.closed) return;
      this.renderPage(false);
    }, 250);
  }

  /** 立即重建（外部明确要求时用）。 */
  refreshNow(): void {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = 0;
    }
    if (this.closed) return;
    this.renderPage(false);
  }

  /** 轻量刷新：字数变化 / 定时 tick 时调用，只更新数字，不重建页面。 */
  refreshLive(): void {
    if (this.closed) return;
    this.calendar?.refresh();
    this.updateRailToday();
    for (const update of this.liveUpdaters) update();
  }

  // ---------- 页面骨架 ----------

  private switchPage(page: HomePage): void {
    if (this.page === page) return;
    this.page = page;
    this.host.prefs.setHomePage(page);
    this.renderPage(true);
  }

  private renderPage(animate: boolean): void {
    if (this.calendar) {
      this.calendarYear = this.calendar.getYear();
      this.calendar.destroy();
      this.calendar = null;
    }
    this.liveUpdaters = [];
    this.renderSeq++;
    for (const [key, el] of this.navEls) {
      el.toggleClass("is-active", key === this.page);
    }
    const scroll = animate ? 0 : this.mainEl.scrollTop;
    this.mainEl.empty();
    // 换页时卡片依次浮现；后台刷新不重放动画
    if (this.enterTimer) window.clearTimeout(this.enterTimer);
    this.mainEl.toggleClass("is-entering", animate);
    if (animate) {
      this.enterTimer = window.setTimeout(() => {
        this.enterTimer = 0;
        this.mainEl.removeClass("is-entering");
      }, 1200);
    }
    if (this.page === "desk") this.renderDeskPage(this.mainEl);
    else if (this.page === "board") this.renderBoardPage(this.mainEl);
    else if (this.page === "stats") this.renderStatsPage(this.mainEl);
    else if (this.page === "docs") this.renderDocsPage(this.mainEl);
    else this.renderLibraryPage(this.mainEl);
    this.mainEl.scrollTop = scroll;
    this.updateRailToday();
  }

  private discover(): NovelProject[] {
    return [...this.host.services.project.projects()];
  }

  /** 页面块：带依次浮现动画的序号 */
  private block(parent: HTMLElement, cls: string, order: number): HTMLElement {
    const el = parent.createDiv({ cls: `${cls} wt-rise` });
    el.style.setProperty("--wt-i", String(order));
    return el;
  }

  private pageHead(page: HTMLElement, title: string, sub: string): HTMLElement {
    const head = this.block(page, "wt-home-head", 0);
    const titles = head.createDiv({ cls: "wt-home-titles" });
    titles.createEl("h2", { cls: "wt-home-title", text: title });
    titles.createDiv({ cls: "wt-home-subtitle", text: sub });
    return head;
  }

  private button(
    parent: HTMLElement,
    text: string,
    icon: string,
    extra = ""
  ): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: `wt-btn ${extra}`.trim(),
      attr: { type: "button" },
    });
    setIcon(btn.createSpan({ cls: "wt-btn-icon" }), icon);
    btn.createSpan({ text });
    return btn;
  }

  private figure(
    parent: HTMLElement,
    value: string,
    label: string
  ): { num: HTMLElement; unit: HTMLElement } {
    const fig = parent.createDiv({ cls: "wt-figure" });
    const line = fig.createDiv({ cls: "wt-figure-line" });
    const num = line.createSpan({ cls: "wt-figure-num", text: value });
    const unit = line.createSpan({ cls: "wt-figure-unit" });
    fig.createDiv({ cls: "wt-figure-label", text: label });
    return { num, unit };
  }

  private searchBox(
    parent: HTMLElement,
    placeholder: string,
    value: string,
    onInput: (value: string) => void
  ): void {
    const wrap = parent.createDiv({ cls: "wt-home-search" });
    setIcon(wrap.createSpan({ cls: "wt-home-search-icon" }), "wt-search");
    const input = wrap.createEl("input", {
      attr: { type: "text", placeholder },
    });
    input.value = value;
    input.addEventListener("input", () => onInput(input.value));
  }

  // ---------- 今日数据 ----------

  private today(): { date: Date; words: number; goal: number } {
    return {
      date: new Date(),
      words: this.host.stats.total(),
      goal: Math.max(1, this.host.settings.dailyGoal),
    };
  }

  private updateRailToday(): void {
    const el = this.railTodayEl;
    if (!el) return;
    const { words, goal } = this.today();
    const positive = Math.max(0, words);
    el.empty();
    el.toggleClass("is-done", words >= goal);
    const top = el.createDiv({ cls: "wt-rail-today-top" });
    top.createSpan({ text: "今日" });
    top.createSpan({
      cls: "wt-rail-today-pct",
      text: `${Math.min(999, Math.floor((positive / goal) * 100))}%`,
    });
    el.createDiv({ cls: "wt-rail-today-num", text: fmt(words) });
    const bar = el.createDiv({ cls: "wt-rail-today-bar" });
    bar.createDiv().style.width = `${Math.min(100, (positive / goal) * 100)}%`;
    el.createDiv({ cls: "wt-rail-today-goal", text: `目标 ${fmt(goal)} 字` });
  }

  // ---------- 逐文件填字数 ----------

  private requestWords(file: TFile, apply: (words: number) => void): void {
    const shared = fileStatCache.get(file.path);
    if (
      shared &&
      shared.mtime === file.stat.mtime &&
      shared.size === file.stat.size
    ) {
      apply(shared.words);
      return;
    }
    const mine = homeWordCache.get(file.path);
    if (
      mine &&
      mine.mtime === file.stat.mtime &&
      mine.size === file.stat.size
    ) {
      apply(mine.words);
      return;
    }
    this.wordJobs.push({ file, apply });
    void this.drainWordJobs();
  }

  private async drainWordJobs(): Promise<void> {
    if (this.wordDraining) return;
    this.wordDraining = true;
    try {
      while (this.wordJobs.length > 0) {
        if (this.closed) return;
        const job = this.wordJobs.shift()!;
        let words = 0;
        try {
          const content = await this.app.vault.cachedRead(job.file);
          words = this.host.actions.countWords(content);
        } catch {
          /* 读取失败按空处理 */
        }
        homeWordCache.set(job.file.path, {
          mtime: job.file.stat.mtime,
          size: job.file.stat.size,
          words,
        });
        job.apply(words);
      }
    } finally {
      this.wordDraining = false;
    }
  }

  /** 整本书字数：逐章合计，全部到齐后回调一次 */
  private requestProjectWords(
    project: NovelProject,
    apply: (words: number) => void
  ): void {
    const chapters = allChapters(project);
    if (chapters.length === 0) {
      apply(0);
      return;
    }
    const tally = { pending: chapters.length, sum: 0 };
    for (const chapter of chapters) {
      this.requestWords(chapter.file, (words) => {
        tally.sum += words;
        tally.pending--;
        if (tally.pending <= 0) apply(tally.sum);
      });
    }
  }

  // ---------- 共用：打开文件 / 切换作品 ----------

  /** 打开正文：已经开着就切过去，否则新开一个标签页（不顶掉主页） */
  private openForWriting(file: TFile): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as unknown as { file?: TFile | null };
      if (view.file?.path === file.path) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return;
      }
    }
    void this.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }

  /** 设为当前作品；openBench 为 true 时顺手打开左侧工作台 */
  private makeCurrent(project: NovelProject, openBench: boolean): void {
    this.host.prefs.setWorkbenchProject(project.root);
    this.host.nav.refreshWorkbenches();
    if (openBench) void this.host.nav.openWorkbench();
  }

  // ---------- 封面 ----------

  private coverFile(root: string): TFile | null {
    const path = this.host.prefs.getProjectCover(root);
    if (!path) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile && IMAGE_EXT.has(file.extension.toLowerCase())
      ? file
      : null;
  }

  /** 画一本书的封面：有自定义图片用图片，否则按书名生成一张传统书衣 */
  private renderCover(
    parent: HTMLElement,
    project: NovelProject,
    size: "lg" | "md" | "sm"
  ): HTMLElement {
    const cover = parent.createDiv({ cls: `wt-cover is-${size}` });
    const image = this.coverFile(project.root);
    if (image) {
      cover.addClass("has-image");
      cover.createEl("img", {
        attr: {
          src: this.app.vault.getResourcePath(image),
          alt: displayProjectName(project.name),
          draggable: "false",
        },
      });
      return cover;
    }
    const tone = COVER_TONES[hashString(project.root) % COVER_TONES.length];
    cover.addClass("is-generated");
    cover.style.setProperty("--wt-cloth", tone.cloth);
    cover.style.setProperty("--wt-label", tone.label);
    cover.createDiv({ cls: "wt-cover-bind" });
    const title = coverTitle(project.name);
    if (size !== "sm") {
      const label = cover.createDiv({ cls: "wt-cover-label" });
      label.createSpan({
        text: title.length > 9 ? title.slice(0, 8) + "…" : title,
      });
      cover.createDiv({ cls: "wt-cover-seal", text: title.slice(0, 1) });
    } else {
      cover.createDiv({ cls: "wt-cover-initial", text: title.slice(0, 1) });
    }
    return cover;
  }

  private addCoverMenuItems(menu: Menu, project: NovelProject): void {
    menu.addItem((item) =>
      item
        .setTitle("从仓库选择封面图片…")
        .setIcon("wt-image")
        .onClick(() => this.pickCoverFromVault(project))
    );
    menu.addItem((item) =>
      item
        .setTitle("从电脑导入封面图片…")
        .setIcon("wt-upload")
        .onClick(() => this.importCover(project))
    );
    if (this.host.prefs.getProjectCover(project.root)) {
      menu.addItem((item) =>
        item
          .setTitle("恢复默认封面")
          .setIcon("wt-reset")
          .onClick(() => this.host.prefs.setProjectCover(project.root, null))
      );
    }
  }

  private pickCoverFromVault(project: NovelProject): void {
    const images = this.app.vault
      .getFiles()
      .filter(
        (f) => IMAGE_EXT.has(f.extension.toLowerCase()) && !isInternalPath(f.path)
      )
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (images.length === 0) {
      new Notice("仓库里还没有图片，可以用「从电脑导入封面图片」");
      return;
    }
    new CoverPickModal(this.app, images, (file) =>
      this.host.prefs.setProjectCover(project.root, file.path)
    ).open();
  }

  /** 从电脑挑图片，复制成作品目录下的「封面.xxx」再设为封面 */
  private importCover(project: NovelProject): void {
    // 全局 createEl()（不自动 append；这个 input 本来就不挂进文档）
    const input = createEl("input");
    input.type = "file";
    input.accept = "image/*";
    // 事件回调返回 Promise 会被 no-misused-promises 判为问题；显式包一层 void
    input.addEventListener("change", () => {
      void (async () => {
        const picked = input.files?.[0];
      if (!picked) return;
      const ext = (picked.name.split(".").pop() || "png").toLowerCase();
      if (!IMAGE_EXT.has(ext)) {
        new Notice("只支持 PNG / JPG / webp / GIF 等图片格式");
        return;
      }
      try {
        const data = await picked.arrayBuffer();
        const base =
          project.root && project.root !== "/" ? `${project.root}/` : "";
        const path = `${base}封面.${ext}`;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, data);
        } else {
          await this.app.vault.createBinary(path, data);
        }
        this.host.prefs.setProjectCover(project.root, path);
        new Notice(`封面已保存到「${path}」`);
      } catch (err) {
        console.error(err);
        new Notice("封面导入失败");
      }
      })();
    });
    input.click();
  }

  // ---------- ⓪ 书桌 ----------

  private renderDeskPage(main: HTMLElement): void {
    const page = main.createDiv({ cls: "wt-home-page wt-desk" });

    // 页头：日期 + 一句问候
    const greet = this.block(page, "wt-desk-greet", 0);
    const { date } = this.today();
    greet.createDiv({
      cls: "wt-desk-date",
      text: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · 星期${WEEKDAY[date.getDay()]}`,
    });
    const hello = greet.createEl("h2", { cls: "wt-desk-hello" });
    const line = greet.createDiv({ cls: "wt-desk-line" });
    const updateGreeting = (): void => {
      const now = this.today();
      const h = new Date().getHours();
      if (h < 5) hello.setText("夜深了，写完这段就歇吧");
      else if (h < 11) hello.setText("早上好，今天也写一点吧");
      else if (h < 13) hello.setText("中午好，今天也写一点吧");
      else if (h < 18) hello.setText("下午好，今天也写一点吧");
      else hello.setText("晚上好，今天也写一点吧");
      if (now.words >= now.goal) {
        line.setText("今天的目标已经完成，再写的都是额外收获。");
      } else if (now.words > 0) {
        line.setText(`再写 ${fmt(now.goal - now.words)} 字，就完成今天的目标。`);
      } else {
        line.setText("今天还没落笔，从一句话开始也好。");
      }
    };
    updateGreeting();
    this.liveUpdaters.push(updateGreeting);

    const projects = this.discover();
    const currentRoot = this.host.prefs.getWorkbenchProject();
    const current = projects.find((p) => p.root === currentRoot) ?? null;

    // 宽时两列各自成列：左「在写 / 七天」，右「今日 / 计划」（计划紧跟今日，一眼能看到）；
    // 其他书占一整行。窄了两列拆开（display: contents），按「在写 → 今日 → 计划 → 七天」叠成一列
    const grid = page.createDiv({ cls: "wt-desk-grid" });
    const mainCol = grid.createDiv({ cls: "wt-desk-col is-main" });
    const sideCol = grid.createDiv({ cls: "wt-desk-col is-side" });
    this.renderDeskHero(mainCol, current);
    this.renderDeskWeek(mainCol);
    this.renderDeskToday(sideCol);
    if (!Platform.isMobile) this.renderDeskPlan(sideCol);
    this.renderDeskOthers(grid, projects, current);
  }

  private renderDeskHero(parent: HTMLElement, project: NovelProject | null): void {
    const hero = this.block(parent, "wt-card wt-desk-hero", 1);

    if (!project) {
      hero.addClass("is-empty");
      const body = hero.createDiv({ cls: "wt-desk-hero-body" });
      body.createDiv({ cls: "wt-eyebrow", text: "正在写" });
      body.createDiv({ cls: "wt-desk-hero-title", text: "还没选定在写的书" });
      body.createDiv({
        cls: "wt-desk-hero-note",
        text: "去书架挑一本，或者新开一本。选好之后，它会一直摆在这张书桌上。",
      });
      const actions = body.createDiv({ cls: "wt-desk-actions" });
      this.button(actions, "去书架挑一本", "wt-shelf", "is-primary").addEventListener(
        "click",
        () => this.switchPage("library")
      );
      this.button(actions, "新建作品", "wt-plus").addEventListener("click", () =>
        this.host.nav.openNewProjectDialog()
      );
      return;
    }

    const coverCol = hero.createDiv({ cls: "wt-desk-hero-cover" });
    const cover = this.renderCover(coverCol, project, "lg");
    cover.setAttr("title", "右键更换封面");
    bindContextMenu(cover, (pt) => {
      const menu = new Menu();
      this.addCoverMenuItems(menu, project);
      showMenuAt(menu, pt);
    });
    // 换书放在封面正下方：它是「对这本书」的操作，不和写作按钮挤在一起
    const swap = coverCol.createEl("button", {
      cls: "wt-desk-swap",
      attr: { type: "button", title: "去书架换一本正在写的书" },
    });
    setIcon(swap.createSpan({ cls: "wt-desk-swap-icon" }), "repeat");
    swap.createSpan({ text: "换一本" });
    swap.addEventListener("click", () => this.switchPage("library"));

    const body = hero.createDiv({ cls: "wt-desk-hero-body" });
    const eyebrow = body.createDiv({ cls: "wt-eyebrow" });
    eyebrow.createSpan({ text: "正在写" });
    const status = this.host.prefs.getWorkbenchStatus(project.root);
    if (status) {
      eyebrow.createSpan({ cls: `wt-pill is-${status}`, text: STATUS_LABEL[status] });
    }
    const title = body.createDiv({
      cls: "wt-desk-hero-title",
      text: displayProjectName(project.name),
    });
    title.setAttr("title", project.root);

    // 一行安静的统计：全书字数 · 章数（今日字数在右边「今日进度」里，这里不重复）
    const stats = body.createDiv({ cls: "wt-desk-stats" });
    const stat = (num: string, unit: string): { num: HTMLElement; unit: HTMLElement } => {
      const el = stats.createSpan({ cls: "wt-desk-stat" });
      return {
        num: el.createSpan({ cls: "wt-desk-stat-num", text: num }),
        unit: el.createSpan({ cls: "wt-desk-stat-unit", text: unit }),
      };
    };
    const total = stat("…", "字");
    this.requestProjectWords(project, (sum) => {
      const [num, unit] = splitWords(sum);
      total.num.setText(num);
      total.unit.setText(unit);
    });
    stats.createSpan({ cls: "wt-desk-stat-sep", text: "·" });
    stat(String(project.chapterCount), "章");

    const last = lastEditedChapter(project);
    const resume = body.createDiv({ cls: "wt-desk-resume" });
    if (last) {
      resume.createSpan({ cls: "wt-desk-resume-k", text: "上次写到" });
      resume.createSpan({ cls: "wt-desk-resume-v", text: chapterLabel(last) });
      resume.createSpan({
        cls: "wt-desk-resume-t",
        text: relativeTime(last.file.stat.mtime),
      });
    } else {
      resume.createSpan({
        cls: "wt-desk-resume-k",
        text: "还没有章节，去工作台写下第一章吧",
      });
    }

    const actions = body.createDiv({ cls: "wt-desk-actions" });
    if (last) {
      this.button(actions, "接着写", "wt-write", "is-primary").addEventListener(
        "click",
        () => {
          this.makeCurrent(project, false);
          this.openForWriting(last.file);
        }
      );
    }
    const bench = this.button(actions, "工作台", "panel-left", last ? "" : "is-primary");
    bench.setAttr("title", "打开工作台");
    bench.addEventListener("click", () => this.makeCurrent(project, true));
  }

  private renderDeskToday(parent: HTMLElement): void {
    const card = this.block(parent, "wt-card wt-desk-today", 2);
    card.createDiv({ cls: "wt-card-label", text: "今日进度" });

    const ringWrap = card.createDiv({ cls: "wt-ring" });
    const R = 54;
    const C = 2 * Math.PI * R;
    const svg = ringWrap.createSvg("svg", {
      attr: { viewBox: "0 0 128 128", "aria-hidden": "true" },
    });
    svg.createSvg("circle", {
      cls: "wt-ring-track",
      attr: { cx: 64, cy: 64, r: R },
    });
    const arc = svg.createSvg("circle", {
      cls: "wt-ring-arc",
      attr: {
        cx: 64,
        cy: 64,
        r: R,
        "stroke-dasharray": `${C}`,
        "stroke-dashoffset": `${C}`,
        transform: "rotate(-90 64 64)",
      },
    });
    const center = ringWrap.createDiv({ cls: "wt-ring-center" });
    const numEl = center.createDiv({ cls: "wt-ring-num" });
    const goalEl = center.createDiv({ cls: "wt-ring-goal" });

    const rows = card.createDiv({ cls: "wt-today-rows" });
    const row = (icon: string, label: string): HTMLElement => {
      const r = rows.createDiv({ cls: "wt-today-row" });
      setIcon(r.createSpan({ cls: "wt-today-icon" }), icon);
      r.createSpan({ cls: "wt-today-k", text: label });
      return r.createSpan({ cls: "wt-today-v" });
    };
    const streakEl = row("wt-streak", "连续写作");
    const pomoEl = row("wt-pomodoro", "番茄");
    const timeEl = row("wt-clock", "写作时长");
    const speedEl = this.host.settings.showSpeed ? row("wt-speed", "平均时速") : null;

    const detail = card.createEl("button", {
      cls: "wt-link",
      attr: { type: "button" },
      text: "今日字数明细 ›",
    });
    detail.addEventListener("click", () => this.host.stats.showDailyBreakdown());

    const update = (): void => {
      const { date, words, goal } = this.today();
      const ratio = Math.min(1, Math.max(0, words / goal));
      // 先画空，下一帧再拉到目标位置，换页时弧线会有一段生长动画
      window.requestAnimationFrame(() =>
        arc.setAttr("stroke-dashoffset", String(C * (1 - ratio)))
      );
      card.toggleClass("is-done", words >= goal);
      numEl.setText(fmt(words));
      goalEl.setText(words >= goal ? "今日已达成" : `/ ${fmt(goal)} 字`);

      const streak = currentStreak(this.host.stats.dailyForDisplay(), date);
      streakEl.setText(streak > 0 ? `${streak} 天` : "今天开始");
      const pomo = this.host.stats.getTodayPomodoroSummary();
      pomoEl.setText(pomo ? `${pomo.count} 个` : "—");
      const seconds = this.host.stats.getTodayDurationSeconds();
      timeEl.setText(seconds >= 60 ? formatMinutes(seconds) : "—");
      if (speedEl) {
        const speed = this.host.stats.todaySpeed();
        speedEl.setText(speed !== null ? `${fmt(speed)} 字/时` : "—");
      }
    };
    update();
    this.liveUpdaters.push(update);
  }

  private renderDeskWeek(page: HTMLElement): void {
    const card = this.block(page, "wt-card wt-desk-week", 4);
    const head = card.createDiv({ cls: "wt-card-head" });
    head.createDiv({ cls: "wt-card-label", text: "最近七天" });
    const summary = head.createDiv({ cls: "wt-card-aside" });
    const chart = card.createDiv({ cls: "wt-week" });

    const update = (): void => {
      const hist = this.host.stats.dailyForDisplay();
      const goal = Math.max(1, this.host.settings.dailyGoal);
      const today = new Date();
      const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
      const values = days.map((d) => Math.max(0, hist[dayKey(d)] ?? 0));
      const prevSum = Array.from({ length: 7 }, (_, i) =>
        Math.max(0, hist[dayKey(addDays(today, i - 13))] ?? 0)
      ).reduce((a, b) => a + b, 0);
      const sum = values.reduce((a, b) => a + b, 0);
      const max = Math.max(goal, ...values);

      summary.empty();
      summary.createSpan({ text: `合计 ${fmt(sum)} 字` });
      if (prevSum > 0) {
        const diff = Math.round(((sum - prevSum) / prevSum) * 100);
        summary.createSpan({
          cls: diff >= 0 ? "wt-trend is-up" : "wt-trend is-down",
          text: `${diff >= 0 ? "↑" : "↓"} ${Math.abs(diff)}% 比上周`,
        });
      }

      chart.empty();
      // 目标线：横贯七根柱子
      const goalLine = chart.createDiv({ cls: "wt-week-goal" });
      // 柱子区高度 = 总高 − 顶部留白 18px − 底部星期 22px
      goalLine.style.bottom = `calc(22px + (100% - 40px) * ${goal / max})`;
      goalLine.createSpan({ text: `目标 ${shortWords(goal)}` });
      days.forEach((d, i) => {
        const value = values[i];
        const col = chart.createDiv({ cls: "wt-week-col" });
        if (i === 6) col.addClass("is-today");
        if (value >= goal) col.addClass("is-met");
        col.setAttr("title", `${d.getMonth() + 1}月${d.getDate()}日 · ${fmt(value)} 字`);
        const track = col.createDiv({ cls: "wt-week-track" });
        const bar = track.createDiv({ cls: "wt-week-bar" });
        bar.style.height = `${Math.max(value > 0 ? 3 : 0, (value / max) * 100)}%`;
        if (value > 0) bar.createSpan({ cls: "wt-week-val", text: shortWords(value) });
        col.createDiv({
          cls: "wt-week-day",
          text: i === 6 ? "今天" : `周${WEEKDAY[d.getDay()]}`,
        });
      });
    };
    update();
    this.liveUpdaters.push(update);
  }

  /** 书桌下方：最近动过的其他几本，一键切过去 */
  private renderDeskOthers(
    page: HTMLElement,
    projects: NovelProject[],
    current: NovelProject | null
  ): void {
    const others = projects
      .filter(
        (p) =>
          p !== current &&
          !this.host.prefs.isProjectHidden(p.root) &&
          !ARCHIVE_RE.test(p.root)
      )
      .map((project) => ({ project, at: projectActivity(project) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 4);
    if (others.length === 0) return;

    const card = this.block(page, "wt-card wt-desk-others", 5);
    const head = card.createDiv({ cls: "wt-card-head" });
    head.createDiv({ cls: "wt-card-label", text: "其他在写的书" });
    const all = head.createEl("button", {
      cls: "wt-link",
      attr: { type: "button" },
      text: "整个书架 ›",
    });
    all.addEventListener("click", () => this.switchPage("library"));

    const list = card.createDiv({ cls: "wt-mini-books" });
    for (const { project, at } of others) {
      const item = list.createDiv({ cls: "wt-mini-book" });
      this.renderCover(item, project, "sm");
      const text = item.createDiv({ cls: "wt-mini-book-text" });
      text.createDiv({ cls: "wt-mini-book-name", text: displayProjectName(project.name) });
      const meta = text.createDiv({ cls: "wt-mini-book-meta" });
      const status = this.host.prefs.getWorkbenchStatus(project.root);
      meta.createSpan({ text: status ? STATUS_LABEL[status] : `${project.chapterCount} 章` });
      if (at > 0) meta.createSpan({ text: relativeTime(at) });
      item.setAttr("title", "设为正在写的书");
      item.addEventListener("click", () => {
        this.makeCurrent(project, false);
        this.renderPage(true);
      });
    }
  }

  // ---------- 计划看板（书桌摘要卡 + 看板页） ----------

  /** 看板读写出错时统一提示（文件被占用、路径非法等） */
  private planTask(job: Promise<unknown>): void {
    job.catch((error) => {
      console.error("[Writing Toolkit] 看板写入失败", error);
      new Notice(`看板没写进去：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** 异步读看板；页面这期间已经重画过就丢掉结果 */
  private loadPlan(apply: (items: PlanItem[]) => void): void {
    const seq = this.renderSeq;
    this.host.caps.planBoard
      .load()
      .then((items) => {
        if (!this.closed && seq === this.renderSeq) apply(items);
      })
      .catch((error) => console.error("[Writing Toolkit] 读取看板失败", error));
  }

  private setPlanDue(item: PlanItem): void {
    new PlanDateModal(this.app, item.text, item.due, (due) =>
      this.planTask(this.host.caps.planBoard.edit(item.key, { due }))
    ).open();
  }

  /** 书架上可以挑的书（未隐藏、未存档） */
  private planProjects(): NovelProject[] {
    return this.discover().filter(
      (p) => !this.host.prefs.isProjectHidden(p.root) && !ARCHIVE_RE.test(p.root)
    );
  }

  /** 筛选条上的书：看板里出现过的 + 正在写的那本 */
  private planBooks(items: readonly PlanItem[]): PlanBook[] {
    const projects = this.discover();
    const names = new Set<string>();
    const current = projects.find((p) => p.root === this.host.prefs.getWorkbenchProject());
    if (current) names.add(current.name);
    for (const item of items) if (item.book) names.add(item.book);
    return [...names].map((name) => {
      const project = projects.find((p) => p.name === name) ?? null;
      const tone = COVER_TONES[hashString(project?.root ?? name) % COVER_TONES.length];
      return { name, project, tone: tone.cloth };
    });
  }

  /** 关联章节的链接 → 文件（按看板文件所在位置解析，和 Obsidian 点链接一致） */
  private planChapterFile(link: string): TFile | null {
    const path = link.split("|")[0].split("#")[0];
    return this.app.metadataCache.getFirstLinkpathDest(path, this.host.caps.planBoard.path());
  }

  private openPlanDetail(item: PlanItem): void {
    const board = this.host.caps.planBoard;
    new PlanDetailModal(this.app, item, {
      projects: this.planProjects(),
      boardPath: board.path(),
      onSave: (patch) => this.planTask(board.edit(item.key, patch)),
      onDelete: () => this.removePlanItem(item),
    }).open();
  }

  /** 删除不弹确认：底部提示里给「撤销」 */
  private removePlanItem(item: PlanItem): void {
    const board = this.host.caps.planBoard;
    this.planTask(
      board.remove(item.key).then((removed) => {
        if (!removed) return;
        let notice: Notice | null = null;
        const frag = createFragment((f) => {
          f.createSpan({ text: `已删除「${item.text}」` });
          const undo = f.createEl("button", {
            cls: "wt-notice-undo",
            text: "撤销",
            attr: { type: "button" },
          });
          undo.addEventListener("click", () => {
            notice?.hide();
            this.planTask(board.restore(removed));
          });
        });
        notice = new Notice(frag, 6000);
      })
    );
  }

  private planMenu(item: PlanItem): Menu {
    const menu = new Menu();
    menu.addItem((mi) =>
      mi.setTitle("打开详情").setIcon("wt-pencil").onClick(() => this.openPlanDetail(item))
    );
    menu.addSeparator();
    for (const column of PLAN_COLUMNS) {
      if (column === item.column) continue;
      menu.addItem((mi) =>
        mi
          .setTitle(`移到「${PLAN_COLUMN_LABEL[column]}」`)
          .setIcon(column === "done" ? "wt-check" : "wt-chevron-right")
          .onClick(() => this.planTask(this.host.caps.planBoard.move(item.key, column)))
      );
    }
    menu.addSeparator();
    menu.addItem((mi) =>
      mi
        .setTitle(item.due ? "改截止日期" : "设截止日期")
        .setIcon("wt-calendar")
        .onClick(() => this.setPlanDue(item))
    );
    if (item.due) {
      menu.addItem((mi) =>
        mi
          .setTitle("清除日期")
          .setIcon("wt-close")
          .onClick(() =>
            this.planTask(this.host.caps.planBoard.edit(item.key, { due: null }))
          )
      );
    }
    menu.addSeparator();
    menu.addItem((mi) =>
      mi.setTitle("删除").setIcon("wt-trash").onClick(() => this.removePlanItem(item))
    );
    return menu;
  }

  /** 勾选框：未完成 → 完成；完成 → 退回待写 */
  private planCheck(parent: HTMLElement, item: PlanItem): void {
    const done = item.column === "done";
    const check = parent.createEl("button", {
      cls: `wt-plan-check${done ? " is-done" : ""}`,
      attr: {
        type: "button",
        "aria-label": done ? "改回未完成" : "标记完成",
        title: done ? "改回未完成（退回待写）" : "标记完成",
      },
    });
    // 未完成时框里留空，只有完成了才画勾（免得看着像已经勾上）
    if (done) setIcon(check, "wt-check");
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      (parent.closest<HTMLElement>(".wt-plan-card") ?? parent).addClass("is-leaving");
      this.planTask(this.host.caps.planBoard.move(item.key, done ? "todo" : "done"));
    });
  }

  /** 截止日 / 完成日小标签 */
  private planDate(parent: HTMLElement, item: PlanItem, today: string): void {
    if (item.column === "done") {
      if (item.doneAt) {
        parent.createSpan({
          cls: "wt-plan-due is-done",
          text: `${planDateLabel(item.doneAt, today)}完成`,
        });
      }
      return;
    }
    if (!item.due) return;
    const chip = parent.createEl("button", {
      cls: `wt-plan-due is-${planDueState(item.due, today)}`,
      attr: { type: "button", title: `截止 ${item.due}（点击修改）` },
    });
    setIcon(chip.createSpan({ cls: "wt-plan-due-icon" }), "wt-calendar");
    const state = planDueState(item.due, today);
    chip.createSpan({
      text: state === "overdue"
        ? `逾期 · ${planDateLabel(item.due, today)}`
        : planDateLabel(item.due, today),
    });
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setPlanDue(item);
    });
  }

  /** 书桌：已逾期 / 今天到期 / 在写，勾一下就完成 */
  private renderDeskPlan(parent: HTMLElement): void {
    const card = this.block(parent, "wt-card wt-desk-plan", 3);
    const head = card.createDiv({ cls: "wt-card-head" });
    head.createDiv({ cls: "wt-card-label", text: "计划" });
    const all = head.createEl("button", {
      cls: "wt-link",
      attr: { type: "button" },
      text: "看板 ›",
    });
    all.addEventListener("click", () => this.switchPage("board"));
    const list = card.createDiv({ cls: "wt-plan-rows" });

    this.loadPlan((items) => {
      const today = planDayKey(new Date());
      const focus = planFocusItems(items, today);
      if (focus.length === 0) {
        const empty = list.createDiv({ cls: "wt-plan-empty" });
        empty.createDiv({
          text: items.some((i) => i.column !== "done")
            ? "没有到期或在写的计划，今天可以专心写正文。"
            : "还没有计划。把要写的章节、要改的设定记在看板上吧。",
        });
        const go = empty.createEl("button", {
          cls: "wt-link",
          attr: { type: "button" },
          text: "去看板添加 ›",
        });
        go.addEventListener("click", () => this.switchPage("board"));
        return;
      }
      for (const item of focus.slice(0, DESK_PLAN_LIMIT)) {
        const row = list.createDiv({ cls: "wt-plan-row" });
        this.planCheck(row, item);
        const text = row.createDiv({ cls: "wt-plan-row-text", text: item.text });
        text.setAttr("title", item.text);
        const meta = row.createDiv({ cls: "wt-plan-row-meta" });
        if (item.column === "doing") {
          meta.createSpan({ cls: "wt-pill is-ongoing", text: "在写" });
        }
        this.planDate(meta, item, today);
        bindContextMenu(row, (pt) => showMenuAt(this.planMenu(item), pt));
      }
      if (focus.length > DESK_PLAN_LIMIT) {
        const more = list.createEl("button", {
          cls: "wt-link wt-plan-more",
          attr: { type: "button" },
          text: `还有 ${focus.length - DESK_PLAN_LIMIT} 条 ›`,
        });
        more.addEventListener("click", () => this.switchPage("board"));
      }
    });
  }

  private renderBoardPage(main: HTMLElement): void {
    const page = main.createDiv({ cls: "wt-home-page wt-board" });
    const board = this.host.caps.planBoard;
    const head = this.pageHead(
      page,
      "看板",
      "拖动卡片排先后、换列；点卡片看详情、改备注和关联章节。"
    );
    const toolbar = head.createDiv({ cls: "wt-home-toolbar" });
    const openBtn = this.button(toolbar, "打开看板文件", "wt-doc", "is-quiet");
    openBtn.setAttr("title", board.path());
    openBtn.addEventListener("click", () => this.planTask(board.openFile()));

    const filters = page.createDiv({ cls: "wt-board-filters" });
    const cols = page.createDiv({ cls: "wt-board-cols" });
    const lists = new Map<PlanColumn, HTMLElement>();
    const counts = new Map<PlanColumn, HTMLElement>();

    // 拖动时的插入线：全页只有一条，跟着鼠标挪到落点
    const dropLine = createDiv({ cls: "wt-board-drop-line" });
    let drag: { key: string; from: PlanColumn; card: HTMLElement } | null = null;
    const clearDrop = (): void => {
      dropLine.remove();
      cols.querySelectorAll(".is-drop").forEach((el) => el.removeClass("is-drop"));
    };
    /** 鼠标在哪张卡的上半截，就插到它前面；都不是就放列尾 */
    const dropTarget = (list: HTMLElement, y: number): HTMLElement | null => {
      const cards = Array.from(
        list.querySelectorAll<HTMLElement>(":scope > .wt-plan-card:not(.is-dragging)")
      );
      return cards.find((card) => {
        const rect = card.getBoundingClientRect();
        return y < rect.top + rect.height / 2;
      }) ?? null;
    };

    PLAN_COLUMNS.forEach((column, index) => {
      const col = this.block(cols, `wt-board-col is-${column}`, index + 1);
      const colHead = col.createDiv({ cls: "wt-board-col-head" });
      colHead.createSpan({ cls: "wt-board-col-dot" });
      colHead.createSpan({ cls: "wt-board-col-label", text: PLAN_COLUMN_LABEL[column] });
      counts.set(column, colHead.createSpan({ cls: "wt-board-col-count" }));
      const list = col.createDiv({ cls: "wt-board-list" });
      lists.set(column, list);

      col.addEventListener("dragover", (e) => {
        if (!drag) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (!col.hasClass("is-drop")) {
          clearDrop();
          col.addClass("is-drop");
        }
        const before = dropTarget(list, e.clientY);
        const anchor = before ?? list.querySelector<HTMLElement>(":scope > .wt-board-tail");
        if (dropLine.nextElementSibling !== anchor || dropLine.parentElement !== list) {
          list.insertBefore(dropLine, anchor);
        }
      });
      col.addEventListener("dragleave", (e) => {
        if (!col.contains(e.relatedTarget as Node | null)) {
          col.removeClass("is-drop");
          if (dropLine.parentElement === list) dropLine.remove();
        }
      });
      col.addEventListener("drop", (e) => {
        if (!drag) return;
        e.preventDefault();
        const before = dropTarget(list, e.clientY);
        const { key, from, card } = drag;
        clearDrop();
        // 放回原处（自己前后）不算动
        const next = card.nextElementSibling?.hasClass("wt-plan-card")
          ? (card.nextElementSibling as HTMLElement)
          : null;
        if (from === column && card.parentElement === list && before === next) return;
        card.addClass("is-leaving");
        this.planTask(
          board.move(key, column, before?.dataset.key ? { before: before.dataset.key } : "end")
        );
      });
    });

    this.loadPlan((items) => {
      const today = planDayKey(new Date());
      const books = this.planBooks(items);
      const filter = boardView.book && books.some((b) => b.name === boardView.book)
        ? boardView.book
        : null;
      if (filter !== boardView.book) boardView.book = filter;

      // 作品筛选：全部 + 有卡片的书 + 正在写的书
      if (books.length > 0) {
        const chip = (label: string, value: string | null, tone?: string): void => {
          const btn = filters.createEl("button", {
            cls: `wt-board-filter${value === filter ? " is-active" : ""}`,
            attr: { type: "button" },
          });
          if (tone) btn.createSpan({ cls: "wt-board-filter-dot" }).style.background = tone;
          btn.createSpan({ text: label });
          btn.addEventListener("click", () => {
            boardView.book = value;
            this.renderPage(false);
          });
        };
        chip("全部", null);
        for (const book of books) chip(displayProjectName(book.name), book.name, book.tone);
      } else {
        filters.remove();
      }

      const visible = items.filter((item) => !filter || item.book === filter);
      for (const column of PLAN_COLUMNS) {
        const list = lists.get(column);
        if (!list) continue;
        const cards = columnItems(visible, column);
        counts.get(column)?.setText(String(cards.length));

        const shown =
          column === "done" ? cards.filter((item) => isRecentlyDone(item, today)) : cards;
        for (const item of shown) {
          const card = this.renderPlanCard(list, item, today, books);
          card.addEventListener("dragstart", (e) => {
            drag = { key: item.key, from: column, card };
            e.dataTransfer?.setData("text/plain", item.text);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            window.requestAnimationFrame(() => card.addClass("is-dragging"));
          });
          card.addEventListener("dragend", () => {
            drag = null;
            card.removeClass("is-dragging");
            clearDrop();
          });
        }
        // 列尾锚点：插入线放到列尾时插在它前面（后面是空提示 / 折叠 / 添加）
        list.createDiv({ cls: "wt-board-tail" });

        if (cards.length === 0 && this.boardAdding !== column) {
          list.createDiv({
            cls: "wt-board-empty",
            text:
              column === "todo"
                ? "接下来要写、要改的，先记在这里"
                : column === "doing"
                  ? "把正在写的拖到这里"
                  : "勾掉的计划会出现在这里",
          });
        }
        if (column === "done") {
          const older = cards.filter((item) => !isRecentlyDone(item, today));
          if (older.length > 0) this.renderOlderDone(list, older, today, books);
        } else {
          this.renderPlanAdd(list, column, filter);
        }
      }
    });
  }

  /** 「完成」列：7 天前完成的折叠起来 */
  private renderOlderDone(
    list: HTMLElement,
    older: PlanItem[],
    today: string,
    books: PlanBook[]
  ): void {
    const fold = list.createEl("button", { cls: "wt-board-fold", attr: { type: "button" } });
    const chevron = fold.createSpan({ cls: "wt-board-fold-chevron" });
    fold.createSpan({ text: `更早完成 ${older.length} 条` });
    const box = list.createDiv({ cls: "wt-board-older" });
    const sync = (): void => {
      box.toggleClass("is-hidden", !boardView.olderOpen);
      setIcon(chevron, boardView.olderOpen ? "wt-chevron-down" : "wt-chevron-right");
    };
    for (const item of older) this.renderPlanCard(box, item, today, books).draggable = false;
    sync();
    fold.addEventListener("click", () => {
      boardView.olderOpen = !boardView.olderOpen;
      sync();
    });
  }

  private renderPlanCard(
    list: HTMLElement,
    item: PlanItem,
    today: string,
    books: PlanBook[]
  ): HTMLElement {
    const card = list.createDiv({ cls: `wt-plan-card is-${item.column}` });
    card.dataset.key = item.key;
    card.draggable = true;
    if (item.due && item.column !== "done" && planDueState(item.due, today) === "overdue") {
      card.addClass("is-overdue");
    }
    const top = card.createDiv({ cls: "wt-plan-card-top" });
    this.planCheck(top, item);
    const body = top.createDiv({ cls: "wt-plan-card-body" });
    body.createDiv({ cls: "wt-plan-card-text", text: item.text });
    if (item.notes.length > 0) {
      body.createDiv({
        cls: "wt-plan-card-notes",
        text: item.notes.map((line) => line.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")).join(" · "),
      });
    }
    const more = top.createEl("button", {
      cls: "wt-plan-more-btn",
      attr: { type: "button", "aria-label": "更多操作" },
    });
    setIcon(more, "wt-more");
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      this.planMenu(item).showAtMouseEvent(e);
    });

    const tags = card.createDiv({ cls: "wt-plan-card-tags" });
    if (item.book) {
      const book = books.find((b) => b.name === item.book);
      const tag = tags.createSpan({ cls: "wt-plan-book" });
      tag.createSpan({ cls: "wt-plan-book-dot" }).style.background =
        book?.tone ?? COVER_TONES[hashString(item.book) % COVER_TONES.length].cloth;
      tag.createSpan({ text: displayProjectName(item.book) });
    }
    if (item.chapter) {
      const file = this.planChapterFile(item.chapter);
      const chip = tags.createEl("button", {
        cls: `wt-plan-chapter${file ? "" : " is-missing"}`,
        attr: {
          type: "button",
          title: file ? `打开 ${file.path}` : `找不到「${item.chapter}」`,
        },
      });
      setIcon(chip.createSpan({ cls: "wt-plan-chapter-icon" }), "wt-doc");
      chip.createSpan({ text: item.chapter.split("|").pop()?.split("/").pop() ?? item.chapter });
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (file) this.openForWriting(file);
      });
    }
    this.planDate(tags, item, today);
    if (tags.childElementCount === 0) tags.remove();

    card.addEventListener("click", () => this.openPlanDetail(item));
    bindContextMenu(card, (pt) => showMenuAt(this.planMenu(item), pt));
    return card;
  }

  /** 列底部「＋ 添加」：回车加一条，输入框留着接着加；Esc 或空着失焦就收起 */
  private renderPlanAdd(list: HTMLElement, column: PlanColumn, book: string | null): void {
    const wrap = list.createDiv({ cls: "wt-board-add" });
    const open = (): void => {
      this.boardAdding = column;
      wrap.empty();
      const input = wrap.createEl("textarea", {
        cls: "wt-board-add-input",
        attr: { rows: "2", placeholder: "写下要做的事，回车添加，按 Esc 收起" },
      });
      let submitting = false;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          submitting = true;
          input.disabled = true;
          this.planTask(this.host.caps.planBoard.add(column, text, { book }));
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      });
      input.addEventListener("blur", () => {
        if (!submitting && !input.value.trim()) close();
      });
      window.setTimeout(() => input.focus(), 0);
    };
    const close = (): void => {
      if (this.boardAdding === column) this.boardAdding = null;
      wrap.empty();
      renderButton();
    };
    const renderButton = (): void => {
      const btn = wrap.createEl("button", {
        cls: "wt-board-add-btn",
        attr: { type: "button" },
      });
      setIcon(btn.createSpan({ cls: "wt-board-add-icon" }), "wt-plus");
      btn.createSpan({ text: "添加卡片" });
      btn.addEventListener("click", open);
    };
    if (this.boardAdding === column) open();
    else renderButton();
  }

  // ---------- ① 书架 ----------

  private renderLibraryPage(main: HTMLElement): void {
    const page = main.createDiv({ cls: "wt-home-page" });
    const view = this.host.prefs.getLibraryView();

    const head = this.pageHead(page, "书架", "所有作品都在这里；点一本就切过去写。");
    const toolbar = head.createDiv({ cls: "wt-home-toolbar" });
    this.searchBox(toolbar, "搜索书名 / 代号", this.libQuery, (value) => {
      this.libQuery = value;
      this.renderLibraryList(listEl);
    });

    // 网格 / 列表 切换
    const toggle = toolbar.createDiv({ cls: "wt-seg", attr: { role: "group" } });
    const modes: Array<{ key: LibraryView; icon: string; label: string }> = [
      { key: "grid", icon: "wt-grid", label: "封面网格" },
      { key: "list", icon: "wt-list", label: "列表" },
    ];
    for (const mode of modes) {
      const btn = toggle.createEl("button", {
        cls: `wt-seg-btn${mode.key === view ? " is-active" : ""}`,
        attr: { type: "button", "aria-label": mode.label, title: mode.label },
      });
      setIcon(btn, mode.icon);
      btn.addEventListener("click", () => {
        if (this.host.prefs.getLibraryView() === mode.key) return;
        this.host.prefs.setLibraryView(mode.key);
        this.renderPage(false);
      });
    }

    const newBtn = this.button(toolbar, "新建作品", "wt-plus", "is-primary");
    newBtn.addEventListener("click", () => this.host.nav.openNewProjectDialog());

    const listEl = this.block(
      page,
      view === "grid" ? "wt-shelf" : "wt-lib-list",
      1
    );
    this.renderLibraryList(listEl);
  }

  private renderLibraryList(listEl: HTMLElement): void {
    listEl.empty();
    const grid = this.host.prefs.getLibraryView() === "grid";
    const projects = this.discover();
    const q = this.libQuery.trim().toLowerCase();
    const matches = (project: NovelProject): boolean => {
      if (!q) return true;
      return (
        project.name.toLowerCase().includes(q) ||
        displayProjectName(project.name).toLowerCase().includes(q) ||
        project.root.toLowerCase().includes(q)
      );
    };
    const rerender = (): void => this.renderLibraryList(listEl);

    if (projects.length === 0) {
      const empty = listEl.createDiv({ cls: "wt-home-empty" });
      empty.createDiv({ cls: "wt-home-empty-title", text: "书架上还没有作品" });
      empty.createDiv({
        cls: "wt-home-empty-hint",
        text: "点右上角「新建作品」建一本；已有作品不显示时，点一下「重新扫描」。",
      });
      this.button(empty, "重新扫描作品", "refresh-cw").addEventListener(
        "click",
        () => rerender()
      );
      return;
    }

    const sorted = projects
      .map((project) => ({ project, at: projectActivity(project) }))
      .sort((a, b) => b.at - a.at);
    const hidden = sorted.filter((x) => this.host.prefs.isProjectHidden(x.project.root));
    const visible = sorted.filter((x) => !this.host.prefs.isProjectHidden(x.project.root));
    const archived = visible.filter((x) => ARCHIVE_RE.test(x.project.root));
    const active = visible.filter((x) => !ARCHIVE_RE.test(x.project.root));

    const renderItem = (
      parent: HTMLElement,
      project: NovelProject,
      at: number,
      inHidden: boolean
    ): void => {
      if (grid) this.renderBookCard(parent, project, at, inHidden, rerender);
      else this.renderBookRow(parent, project, at, inHidden, rerender);
    };
    const container = (parent: HTMLElement): HTMLElement =>
      grid ? parent.createDiv({ cls: "wt-shelf-grid" }) : parent;

    let shown = 0;
    const activeHits = active.filter((x) => matches(x.project));
    if (activeHits.length > 0) {
      const box = container(listEl);
      for (const { project, at } of activeHits) {
        shown++;
        renderItem(box, project, at, false);
      }
    }

    // 搜索时分组强制展开，命中项不会被折叠藏住
    const archiveHits = archived.filter((x) => matches(x.project));
    if (archiveHits.length > 0) {
      const open = q ? true : libFoldOpen.archive;
      const body = this.renderFoldGroup(
        listEl,
        "存档",
        `${archiveHits.length} 本 · 已完结的作品收在这里`,
        open,
        () => {
          libFoldOpen.archive = !libFoldOpen.archive;
          rerender();
        }
      );
      if (body) {
        const box = container(body);
        for (const { project, at } of archiveHits) {
          shown++;
          renderItem(box, project, at, false);
        }
      }
    }

    const hiddenHits = hidden.filter((x) => matches(x.project));
    if (hiddenHits.length > 0) {
      const open = q ? true : libFoldOpen.hidden;
      const body = this.renderFoldGroup(
        listEl,
        "已隐藏",
        `${hiddenHits.length} 本 · 默认不显示`,
        open,
        () => {
          libFoldOpen.hidden = !libFoldOpen.hidden;
          rerender();
        }
      );
      if (body) {
        const box = container(body);
        for (const { project, at } of hiddenHits) {
          shown++;
          renderItem(box, project, at, true);
        }
      }
    }

    if (q && shown === 0) {
      const empty = listEl.createDiv({ cls: "wt-home-empty" });
      empty.createDiv({ cls: "wt-home-empty-title", text: "没有匹配的作品" });
    }
  }

  /** 折叠分组标题（右侧带说明）；展开时返回可以放作品的容器，折叠时返回 null。 */
  private renderFoldGroup(
    parent: HTMLElement,
    label: string,
    desc: string,
    open: boolean,
    onToggle: () => void
  ): HTMLElement | null {
    const wrap = parent.createDiv({ cls: "wt-lib-group" });
    const head = wrap.createEl("button", {
      cls: "wt-lib-group-head",
      attr: { type: "button", "aria-expanded": String(open) },
    });
    const chevron = head.createSpan({ cls: "wt-lib-group-chevron" });
    setIcon(chevron, open ? "wt-chevron-down" : "wt-chevron-right");
    head.createSpan({ cls: "wt-lib-group-label", text: label });
    head.createSpan({ cls: "wt-lib-group-desc", text: desc });
    head.addEventListener("click", onToggle);
    if (!open) return null;
    return wrap.createDiv({ cls: "wt-lib-group-body" });
  }

  /** 点书：设为当前作品并打开工作台 */
  private activateBook(project: NovelProject, rerender: () => void): void {
    this.makeCurrent(project, true);
    rerender();
  }

  /** 书的右键菜单：网格和列表共用 */
  private showBookMenu(
    pt: MenuPoint,
    project: NovelProject,
    inHidden: boolean,
    rerender: () => void
  ): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("切到这本去写")
        .setIcon("wt-write")
        .onClick(() => this.activateBook(project, rerender))
    );
    const last = lastEditedChapter(project);
    if (last) {
      menu.addItem((item) =>
        item
          .setTitle(`接着写：${chapterLabel(last)}`)
          .setIcon("wt-doc")
          .onClick(() => {
            this.makeCurrent(project, false);
            this.openForWriting(last.file);
            rerender();
          })
      );
    }
    menu.addSeparator();
    this.addCoverMenuItems(menu, project);
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(inHidden ? "取消隐藏" : "隐藏此作品")
        .setIcon(inHidden ? "wt-eye" : "wt-eye-off")
        .onClick(() => {
          this.host.prefs.setProjectHidden(project.root, !inHidden);
          rerender();
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("在系统文件管理器中显示")
        .setIcon("wt-folder")
        .onClick(() => this.host.actions.revealPathInSystem(project.root))
    );
    showMenuAt(menu, pt);
  }

  /** 封面网格里的一本书 */
  private renderBookCard(
    parent: HTMLElement,
    project: NovelProject,
    at: number,
    inHidden: boolean,
    rerender: () => void
  ): void {
    const current = project.root === this.host.prefs.getWorkbenchProject();
    const card = parent.createDiv({
      cls: `wt-book${current ? " is-current" : ""}${inHidden ? " is-hidden" : ""}`,
    });
    card.setAttr("title", project.root);

    const coverWrap = card.createDiv({ cls: "wt-book-cover" });
    this.renderCover(coverWrap, project, "md");
    if (current) coverWrap.createDiv({ cls: "wt-book-ribbon", text: "在写" });

    // 封面右上角：隐藏 / 取消隐藏（悬停时出现）
    const eye = coverWrap.createEl("button", {
      cls: "wt-book-eye",
      attr: {
        type: "button",
        "aria-label": inHidden ? "取消隐藏" : "隐藏此作品",
        title: inHidden ? "取消隐藏，放回正常列表" : "隐藏此作品，收进「已隐藏」",
      },
    });
    setIcon(eye, inHidden ? "wt-eye" : "wt-eye-off");
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      this.host.prefs.setProjectHidden(project.root, !inHidden);
      rerender();
    });

    const info = card.createDiv({ cls: "wt-book-info" });
    info.createDiv({ cls: "wt-book-name", text: displayProjectName(project.name) });

    const meta = info.createDiv({ cls: "wt-book-meta" });
    const statusBtn = meta.createEl("button", {
      cls: "wt-lib-status",
      attr: { type: "button", title: "设置连载状态" },
    });
    this.fillStatusChip(statusBtn, project.root);
    statusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showStatusMenu(project.root, { x: e.clientX, y: e.clientY }, () =>
        rerender()
      );
    });
    const wordsEl = meta.createSpan({ cls: "wt-book-words" });
    if (project.chapterCount > 0) {
      wordsEl.setText("…");
      this.requestProjectWords(project, (sum) => {
        const [num, unit] = splitWords(sum);
        wordsEl.setText(`${num}${unit}`);
      });
    } else {
      wordsEl.setText("未开写");
    }

    const foot = info.createDiv({ cls: "wt-book-foot" });
    if (project.chapterCount > 0) foot.createSpan({ text: `${project.chapterCount} 章` });
    if (at > 0) foot.createSpan({ text: relativeTime(at) });

    card.addEventListener("click", () => this.activateBook(project, rerender));
    bindContextMenu(card, (pt) =>
      this.showBookMenu(pt, project, inHidden, rerender)
    );
  }

  /** 列表模式里的一行（沿用原来的紧凑列表） */
  private renderBookRow(
    parent: HTMLElement,
    project: NovelProject,
    at: number,
    inHidden: boolean,
    rerender: () => void
  ): void {
    const current = project.root === this.host.prefs.getWorkbenchProject();
    const row = parent.createDiv({
      cls: `wt-lib-row${current ? " is-current" : ""}`,
    });

    const main = row.createDiv({ cls: "wt-lib-main" });
    const nameWrap = main.createDiv({ cls: "wt-lib-namewrap" });
    this.renderCover(nameWrap, project, "sm");
    const nameEl = nameWrap.createSpan({
      cls: "wt-lib-name",
      text: displayProjectName(project.name),
    });
    nameEl.setAttr("title", project.root);

    const statusBtn = main.createEl("button", {
      cls: "wt-lib-status",
      attr: { type: "button", title: "设置连载状态" },
    });
    this.fillStatusChip(statusBtn, project.root);
    statusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showStatusMenu(
        project.root,
        { x: e.clientX, y: e.clientY },
        () => {
          this.fillStatusChip(statusBtn, project.root);
          rerender();
        }
      );
    });

    // 右侧元信息：字数（后台逐章补齐）· 章数 · 最近更新
    const stats = row.createDiv({ cls: "wt-lib-stats" });
    const chapters = project.chapterCount;
    if (chapters > 0) {
      const wordsEl = stats.createSpan({ cls: "wt-lib-words", text: "…" });
      this.requestProjectWords(project, (sum) => {
        const [num, unit] = splitWords(sum);
        wordsEl.setText(`${num} ${unit}`);
      });
      stats.createSpan({ cls: "wt-lib-chapters", text: `${chapters} 章` });
    } else {
      stats.createSpan({ cls: "wt-lib-words", text: "" });
      stats.createSpan({ cls: "wt-lib-chapters", text: "未开写" });
    }
    stats.createSpan({
      cls: "wt-lib-updated",
      text: at > 0 ? `最近更新 ${relativeTime(at)}` : "",
    });

    // 行尾：平时显示 ›，悬停时原位换成隐藏 / 取消隐藏按钮
    const end = row.createDiv({ cls: "wt-lib-end" });
    const chev = end.createSpan({ cls: "wt-lib-chev" });
    setIcon(chev, "wt-chevron-right");
    const eye = end.createEl("button", {
      cls: "wt-lib-eye",
      attr: {
        type: "button",
        "aria-label": inHidden ? "取消隐藏" : "隐藏此作品",
        title: inHidden
          ? "取消隐藏，放回正常列表"
          : "隐藏此作品，收进「已隐藏」",
      },
    });
    setIcon(eye, inHidden ? "wt-eye" : "wt-eye-off");
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      this.host.prefs.setProjectHidden(project.root, !inHidden);
      rerender();
    });

    row.addEventListener("click", () => this.activateBook(project, rerender));
    bindContextMenu(row, (pt) =>
      this.showBookMenu(pt, project, inHidden, rerender)
    );
  }

  /** 状态徽章内容：连载中 / 已完结 / 暂停更新 / 未标注 */
  private fillStatusChip(btn: HTMLElement, root: string): void {
    const status = this.host.prefs.getWorkbenchStatus(root);
    btn.empty();
    btn.className = `wt-lib-status is-${status ?? "unset"}`;
    btn.createSpan({ cls: "wt-lib-status-dot" });
    btn.createSpan({ text: status ? STATUS_LABEL[status] : "未标注" });
  }

  private showStatusMenu(
    root: string,
    pt: MenuPoint,
    after: () => void
  ): void {
    const current = this.host.prefs.getWorkbenchStatus(root);
    const menu = new Menu();
    const order: WorkbenchStatus[] = ["ongoing", "completed", "hiatus"];
    for (const key of order) {
      menu.addItem((item) =>
        item
          .setTitle(STATUS_LABEL[key])
          .setChecked(current === key)
          .onClick(() => {
            this.host.prefs.setWorkbenchStatus(root, key);
            this.host.nav.refreshWorkbenches();
            after();
          })
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("清除标注")
        .setDisabled(current === null)
        .onClick(() => {
          this.host.prefs.setWorkbenchStatus(root, null);
          this.host.nav.refreshWorkbenches();
          after();
        })
    );
    showMenuAt(menu, pt);
  }

  // ---------- ② 数据统计 ----------

  /** 当前统计范围下的每日字数 */
  private scopedHistory(): Record<string, number> {
    return this.statsProjectKey
      ? this.host.stats.projectForDisplay(this.statsProjectKey)
      : this.host.stats.dailyForDisplay();
  }

  private renderStatsPage(main: HTMLElement): void {
    const page = main.createDiv({ cls: "wt-home-page" });
    const head = this.pageHead(page, "数据统计", "一笔一笔写下来的，都记在这里。");

    // 统计范围放在页头：数字卡片、热力图、作品占比都跟着它走
    const toolbar = head.createDiv({ cls: "wt-home-toolbar" });
    const scope = toolbar.createEl("select", { cls: "dropdown wt-scope" });
    scope.createEl("option", { value: "", text: "全部作品" });
    for (const project of this.host.stats.getProjects(this.statsProjectKey)) {
      scope.createEl("option", {
        value: project.key,
        text: displayProjectName(project.label),
      });
    }
    scope.value = this.statsProjectKey ?? "";

    // 汇总数字
    const figCard = this.block(page, "wt-card wt-stat-figures", 1);
    const figures = figCard.createDiv({ cls: "wt-figures is-wide" });
    const monthFig = this.figure(figures, "0", "本月");
    const yearFig = this.figure(figures, "0", "今年");
    const avgFig = this.figure(figures, "0", "写作日均");
    const bestFig = this.figure(figures, "0", "单日最高");
    const streakFig = this.figure(figures, "0", "最长连续");
    const setWords = (
      fig: { num: HTMLElement; unit: HTMLElement },
      n: number
    ): void => {
      const [num, unit] = splitWords(n);
      fig.num.setText(num);
      fig.unit.setText(unit);
    };
    const updateFigures = (): void => {
      const hist = this.scopedHistory();
      const now = new Date();
      const yearPrefix = `${now.getFullYear()}-`;
      const monthPrefix = `${yearPrefix}${String(now.getMonth() + 1).padStart(2, "0")}-`;
      let month = 0;
      let year = 0;
      let yearDays = 0;
      let best = 0;
      let bestDay = "";
      for (const [day, raw] of Object.entries(hist)) {
        const v = Math.max(0, raw);
        if (day.startsWith(yearPrefix)) {
          year += v;
          if (v > 0) yearDays++;
        }
        if (day.startsWith(monthPrefix)) month += v;
        if (v > best) {
          best = v;
          bestDay = day;
        }
      }
      setWords(monthFig, month);
      setWords(yearFig, year);
      setWords(avgFig, yearDays > 0 ? Math.round(year / yearDays) : 0);
      setWords(bestFig, best);
      bestFig.num.setAttr("title", bestDay);
      streakFig.num.setText(String(longestStreak(hist)));
      streakFig.unit.setText("天");
    };
    updateFigures();
    this.liveUpdaters.push(updateFigures);

    // 热力图
    const calCard = this.block(page, "wt-card wt-home-calendar", 2);
    const calHead = calCard.createDiv({ cls: "wt-card-head" });
    calHead.createDiv({ cls: "wt-card-label", text: "写作日历" });
    const detail = calHead.createEl("button", {
      cls: "wt-link",
      attr: { type: "button" },
      text: "今日字数明细 ›",
    });
    detail.addEventListener("click", () => this.host.stats.showDailyBreakdown());
    const calendarHolder = calCard.createDiv();
    this.calendar = this.host.caps.calendar.create(
      calendarHolder,
      this.calendarYear ?? undefined
    );
    this.calendar.setProject(this.statsProjectKey);

    // 各作品今年的字数占比（只在「全部作品」时显示）
    const shareCard = this.block(page, "wt-card wt-stat-share", 3);
    const updateShare = (): void => {
      shareCard.empty();
      shareCard.toggle(!this.statsProjectKey);
      if (this.statsProjectKey) return;
      const h = shareCard.createDiv({ cls: "wt-card-head" });
      h.createDiv({ cls: "wt-card-label", text: "今年各作品" });
      const yearPrefix = `${new Date().getFullYear()}-`;
      const rows = this.host.stats
        .getProjects()
        .map((p) => {
          let sum = 0;
          for (const [day, v] of Object.entries(this.host.stats.projectForDisplay(p.key))) {
            if (day.startsWith(yearPrefix)) sum += Math.max(0, v);
          }
          return { label: displayProjectName(p.label), sum };
        })
        .filter((r) => r.sum > 0)
        .sort((a, b) => b.sum - a.sum)
        .slice(0, 6);
      if (rows.length === 0) {
        shareCard.createDiv({ cls: "wt-muted", text: "今年还没有按作品记录的字数。" });
        return;
      }
      const max = rows[0].sum;
      const list = shareCard.createDiv({ cls: "wt-share" });
      for (const r of rows) {
        const row = list.createDiv({ cls: "wt-share-row" });
        row.createSpan({ cls: "wt-share-name", text: r.label });
        const track = row.createDiv({ cls: "wt-share-track" });
        track.createDiv({ cls: "wt-share-bar" }).style.width = `${(r.sum / max) * 100}%`;
        const [num, unit] = splitWords(r.sum);
        row.createSpan({ cls: "wt-share-val", text: `${num} ${unit}` });
      }
    };
    updateShare();

    scope.addEventListener("change", () => {
      this.statsProjectKey = scope.value || null;
      this.calendar?.setProject(this.statsProjectKey);
      updateFigures();
      updateShare();
    });

    // 统计设置：默认收起
    const settings = this.block(page, "wt-card wt-fold", 4);
    const foldHead = settings.createEl("button", {
      cls: "wt-fold-head",
      attr: { type: "button", "aria-expanded": String(statsSettingsOpen) },
    });
    setIcon(foldHead.createSpan({ cls: "wt-fold-icon" }), "wt-settings");
    foldHead.createSpan({ cls: "wt-fold-label", text: "统计设置" });
    const foldDesc = foldHead.createSpan({
      cls: "wt-fold-desc",
      text: `每日目标 ${fmt(this.host.settings.dailyGoal)} 字 · ${WORD_COUNT_MODE_LABELS[this.host.settings.wordCountMode]}`,
    });
    const updateSettingsSummary = (): void => {
      foldDesc.setText(
        `每日目标 ${fmt(this.host.settings.dailyGoal)} 字 · ${WORD_COUNT_MODE_LABELS[this.host.settings.wordCountMode]}`
      );
    };
    setIcon(
      foldHead.createSpan({ cls: "wt-fold-chevron" }),
      statsSettingsOpen ? "wt-chevron-up" : "wt-chevron-down"
    );
    foldHead.addEventListener("click", () => {
      statsSettingsOpen = !statsSettingsOpen;
      this.renderPage(false);
    });
    if (statsSettingsOpen) {
      this.renderStatsSettings(
        settings.createDiv({ cls: "wt-home-settings" }),
        updateSettingsSummary
      );
    }
  }

  private renderStatsSettings(
    card: HTMLElement,
    updateSummary: () => void
  ): void {
    new Setting(card)
      .setName("每日目标")
      .setDesc("目标字数（影响热力图达标阈值与今日进度）")
      .addText((text) =>
        text.setValue(String(this.host.settings.dailyGoal)).onChange(async (value) => {
          const goal = parseInt(value, 10);
          if (goal > 0) {
            this.host.settings.dailyGoal = goal;
            await this.host.actions.saveSettings();
            this.calendar?.refresh();
            this.updateRailToday();
            updateSummary();
          }
        })
      );

    new Setting(card)
      .setName("统计模式")
      .setDesc("字数怎么数")
      .addDropdown((dropdown) => {
        for (const [key, label] of Object.entries(WORD_COUNT_MODE_LABELS)) {
          dropdown.addOption(key, label);
        }
        dropdown.setValue(this.host.settings.wordCountMode).onChange(async (value) => {
          this.host.stats.setWordCountMode(value as WordCountMode);
          await this.host.actions.saveSettings();
          updateSummary();
        });
      });

    new Setting(card)
      .setName("热力图显示方式")
      .setDesc("格子的深浅按字数或写作时长")
      .addDropdown((dropdown) => {
        for (const [key, label] of Object.entries(DAILY_DISPLAY_MODE_LABELS)) {
          dropdown.addOption(key, label);
        }
        dropdown.setValue(this.host.settings.dailyDisplayMode).onChange(async (value) => {
          this.host.settings.dailyDisplayMode =
            value as typeof this.host.settings.dailyDisplayMode;
          await this.host.actions.saveSettings();
          this.calendar?.refresh();
        });
      });

    new Setting(card)
      .setName("显示码字时速")
      .setDesc("在编辑台左下角与主页显示今日平均时速：今天写下的字 ÷ 写作时长，删除不抵减")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.showSpeed).onChange(async (value) => {
          this.host.settings.showSpeed = value;
          await this.host.actions.saveSettings();
        })
      );

    new Setting(card)
      .setName("状态栏仅在沉浸模式显示")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.statusBarOnlyImmersive).onChange(async (value) => {
          this.host.settings.statusBarOnlyImmersive = value;
          this.host.actions.updateStatusBarVisibility();
          await this.host.actions.saveSettings();
        })
      );
  }

  // ---------- ③ 资料库 ----------

  private renderDocsPage(main: HTMLElement): void {
    const page = main.createDiv({ cls: "wt-home-page" });
    const head = this.pageHead(page, "资料库", "跨作品共用的设定与参考资料。");
    const toolbar = head.createDiv({ cls: "wt-home-toolbar" });
    this.searchBox(toolbar, "搜索资料", this.docsQuery, (value) => {
      this.docsQuery = value;
      this.renderDocsList(body);
    });
    const body = this.block(page, "wt-docs", 1);
    this.renderDocsList(body);
  }

  /** 共用资料目录里的全部 Markdown（递归） */
  private sharedLibraryFiles(): TFile[] {
    const path = (this.host.settings.sharedLibraryFolder ?? "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    if (!path) return [];
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder)) return [];
    const files: TFile[] = [];
    const walk = (dir: TFolder): void => {
      for (const child of dir.children as Array<TFile | TFolder>) {
        if (child instanceof TFile) {
          if (child.extension === "md") files.push(child);
        } else if (child instanceof TFolder && !isInternalPath(child.path)) {
          walk(child);
        }
      }
    };
    walk(folder);
    files.sort((a, b) => a.basename.localeCompare(b.basename, "zh-Hans-CN"));
    return files;
  }

  private renderDocsList(body: HTMLElement): void {
    body.empty();
    const q = this.docsQuery.trim().toLowerCase();
    const hit = (name: string): boolean => !q || name.toLowerCase().includes(q);

    // 资料库只收跨作品共用的资料；单本作品的设定在各自的工作台里看
    const all = this.sharedLibraryFiles();
    const UNTAGGED = "未分类";
    const tagOf = (file: TFile): string =>
      parseResourceName(file.basename).tag ?? UNTAGGED;

    // 标签筛选：出现两种以上分类时才显示
    const tags = [...new Set(all.map(tagOf))].sort((a, b) =>
      a === UNTAGGED ? 1 : b === UNTAGGED ? -1 : a.localeCompare(b, "zh-Hans-CN")
    );
    if (this.docsTag && !tags.includes(this.docsTag)) this.docsTag = null;
    if (tags.length > 1) {
      const chips = body.createDiv({ cls: "wt-chips" });
      const chip = (label: string, value: string | null, count: number): void => {
        const btn = chips.createEl("button", {
          cls: `wt-chip${this.docsTag === value ? " is-active" : ""}`,
          attr: { type: "button" },
        });
        btn.createSpan({ text: label });
        btn.createSpan({ cls: "wt-chip-count", text: String(count) });
        btn.addEventListener("click", () => {
          this.docsTag = value;
          this.renderDocsList(body);
        });
      };
      chip("全部", null, all.length);
      for (const tag of tags) {
        chip(tag, tag, all.filter((f) => tagOf(f) === tag).length);
      }
    }

    const shown = all.filter(
      (file) => hit(file.basename) && (!this.docsTag || tagOf(file) === this.docsTag)
    );

    if (shown.length === 0) {
      const empty = body.createDiv({ cls: "wt-home-empty" });
      empty.createDiv({
        cls: "wt-home-empty-title",
        text: q || this.docsTag ? "没有匹配的资料" : "资料库还是空的",
      });
      if (!q && !this.docsTag) {
        empty.createDiv({
          cls: "wt-home-empty-hint",
          text: "把跨作品共用的资料放进「共用资料库」目录，就会出现在这里；目录位置可在设置里指定。",
        });
      }
      return;
    }

    // 按分类分区；只有一种分类时不加小标题
    const groups = new Map<string, TFile[]>();
    for (const file of shown) {
      const tag = tagOf(file);
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push(file);
    }
    const withHeads = groups.size > 1;
    for (const tag of tags) {
      const files = groups.get(tag);
      if (!files) continue;
      const section = body.createDiv({ cls: "wt-card wt-doc-section" });
      if (withHeads) {
        const h = section.createDiv({ cls: "wt-card-head" });
        h.createDiv({ cls: "wt-card-label", text: tag });
        h.createDiv({ cls: "wt-card-aside", text: `${files.length} 篇` });
      }
      const list = section.createDiv({ cls: "wt-doc-list" });
      for (const file of files) this.renderDocRow(list, file);
    }
  }

  private renderDocRow(parent: HTMLElement, file: TFile): void {
    const row = parent.createDiv({ cls: "wt-doc-row" });
    setIcon(row.createSpan({ cls: "wt-doc-icon" }), "wt-doc");
    const { tag, name } = parseResourceName(file.basename);
    const title = row.createSpan({ cls: "wt-doc-name", text: name });
    title.setAttr("title", file.path);
    if (tag) row.createSpan({ cls: "wt-doc-tag", text: tag });
    const meta = row.createSpan({ cls: "wt-doc-meta" });
    const wordsEl = meta.createSpan({ text: "…" });
    this.requestWords(file, (words) => {
      wordsEl.setText(words > 0 ? `${words.toLocaleString("en-US")} 字` : "空");
    });
    meta.createSpan({ text: relativeTime(file.stat.mtime) });

    const open = (newTab: boolean): void => {
      const leaf = newTab
        ? this.app.workspace.getLeaf("tab")
        : this.app.workspace.getLeaf(false);
      void leaf.openFile(file, { active: true });
    };
    row.addEventListener("click", () => open(false));
    bindContextMenu(row, (pt) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle("打开").setIcon("wt-doc").onClick(() => open(false))
      );
      menu.addItem((item) =>
        item.setTitle("在新标签页打开").setIcon("wt-plus").onClick(() => open(true))
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("在系统文件管理器中显示")
          .setIcon("wt-folder")
          .onClick(() => this.host.actions.revealPathInSystem(file.path))
      );
      showMenuAt(menu, pt);
    });
  }
}
