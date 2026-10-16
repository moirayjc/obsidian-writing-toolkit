import {
  App,
  FuzzySuggestModal,
  ItemView,
  Menu,
  Notice,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { WritingCalendar } from "./calendar";
import { DAILY_DISPLAY_MODE_LABELS } from "./settings";
import { getWordCount } from "./wordcount";
import {
  ChapterEntry,
  NovelProject,
  allChapters,
  discoverProjects,
  isInternalPath,
} from "./project";
import {
  ARCHIVE_RE,
  STATUS_LABEL,
  WorkbenchStatus,
  displayFolderName,
  displayProjectName,
  fileStatCache,
  parseResourceName,
  relativeTime,
  splitWords,
} from "./workbench";
import { WORD_COUNT_MODE_LABELS } from "./sidebar";
import {
  bindContextMenu,
  showMenuAt,
  type MenuPoint,
} from "./mobile";
import type { WordCountMode } from "./wordcount";
import type WritingToolkitPlugin from "./main";

export const WRITING_TOOLKIT_HOME = "writing-toolkit-home";

/** 中间大页面的四块入口；以后想加别的，往这一列里放。 */
export type HomePage = "desk" | "library" | "stats" | "docs";

/** 书架的两种摆法：封面网格 / 紧凑列表 */
export type LibraryView = "grid" | "list";

const PAGES: Array<{ key: HomePage; label: string; icon: string }> = [
  { key: "desk", label: "书桌", icon: "feather" },
  { key: "library", label: "书架", icon: "library" },
  { key: "stats", label: "数据统计", icon: "bar-chart-2" },
  { key: "docs", label: "资料库", icon: "book-open" },
];

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
 * 自带导航（书桌 / 书架 / 数据统计 / 资料库）。书桌回答「今天写到哪、接着写哪」；
 * 书架管所有书；写作本身仍在左侧工作台，临时工具留在右侧「工具箱」。
 */
export class WritingToolkitHome extends ItemView {
  private readonly plugin: WritingToolkitPlugin;
  private page: HomePage = "desk";
  private mainEl!: HTMLElement;
  private navEls = new Map<HomePage, HTMLElement>();
  private railTodayEl: HTMLElement | null = null;

  private calendar: WritingCalendar | null = null;
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

  constructor(leaf: WorkspaceLeaf, plugin: WritingToolkitPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return WRITING_TOOLKIT_HOME;
  }

  getDisplayText(): string {
    return "主页";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.page = this.plugin.getHomePage();
    this.contentEl.empty();
    this.contentEl.addClass("wt-home");

    const rail = this.contentEl.createDiv({ cls: "wt-home-rail" });
    const brand = rail.createDiv({ cls: "wt-home-brand" });
    brand.createSpan({ cls: "wt-home-seal", text: "写" });
    brand.createSpan({ cls: "wt-home-brand-name", text: "写作台" });

    const nav = rail.createDiv({ cls: "wt-home-navs" });
    this.navEls.clear();
    for (const def of PAGES) {
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
    this.plugin.setHomePage(page);
    this.renderPage(true);
  }

  private renderPage(animate: boolean): void {
    if (this.calendar) {
      this.calendarYear = this.calendar.getYear();
      this.calendar.destroy();
      this.calendar = null;
    }
    this.liveUpdaters = [];
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
    else if (this.page === "stats") this.renderStatsPage(this.mainEl);
    else if (this.page === "docs") this.renderDocsPage(this.mainEl);
    else this.renderLibraryPage(this.mainEl);
    this.mainEl.scrollTop = scroll;
    this.updateRailToday();
  }

  private discover(): NovelProject[] {
    return discoverProjects(this.app, {
      draftKeywords: this.plugin.settings.draftKeywords,
      excludeNames: this.plugin.settings.chapterExcludeNames,
      extraExcluded: [this.plugin.settings.snapshotFolder],
    });
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
    setIcon(wrap.createSpan({ cls: "wt-home-search-icon" }), "search");
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
      words: Math.max(0, this.plugin.dailyGross),
      goal: Math.max(1, this.plugin.settings.dailyGoal),
    };
  }

  private updateRailToday(): void {
    const el = this.railTodayEl;
    if (!el) return;
    const { words, goal } = this.today();
    el.empty();
    el.toggleClass("is-done", words >= goal);
    const top = el.createDiv({ cls: "wt-rail-today-top" });
    top.createSpan({ text: "今日" });
    top.createSpan({
      cls: "wt-rail-today-pct",
      text: `${Math.min(999, Math.floor((words / goal) * 100))}%`,
    });
    el.createDiv({ cls: "wt-rail-today-num", text: fmt(words) });
    const bar = el.createDiv({ cls: "wt-rail-today-bar" });
    bar.createDiv().style.width = `${Math.min(100, (words / goal) * 100)}%`;
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
          words = getWordCount(content, this.plugin.settings.wordCountMode);
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
    this.plugin.setWorkbenchProject(project.root);
    this.plugin.refreshWorkbenches();
    if (openBench) void this.plugin.openWorkbench();
  }

  // ---------- 封面 ----------

  private coverFile(root: string): TFile | null {
    const path = this.plugin.getProjectCover(root);
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
        .setIcon("image")
        .onClick(() => this.pickCoverFromVault(project))
    );
    menu.addItem((item) =>
      item
        .setTitle("从电脑导入封面图片…")
        .setIcon("upload")
        .onClick(() => this.importCover(project))
    );
    if (this.plugin.getProjectCover(project.root)) {
      menu.addItem((item) =>
        item
          .setTitle("恢复默认封面")
          .setIcon("rotate-ccw")
          .onClick(() => this.plugin.setProjectCover(project.root, null))
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
      this.plugin.setProjectCover(project.root, file.path)
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
        this.plugin.setProjectCover(project.root, path);
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
    const currentRoot = this.plugin.getWorkbenchProject();
    const current = projects.find((p) => p.root === currentRoot) ?? null;

    const top = page.createDiv({ cls: "wt-desk-top" });
    this.renderDeskHero(top, current);
    this.renderDeskToday(top);

    this.renderDeskWeek(page);
    this.renderDeskOthers(page, projects, current);
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
      this.button(actions, "去书架挑一本", "library", "is-primary").addEventListener(
        "click",
        () => this.switchPage("library")
      );
      this.button(actions, "新建作品", "plus").addEventListener("click", () =>
        this.plugin.openNewProjectDialog()
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

    const body = hero.createDiv({ cls: "wt-desk-hero-body" });
    const eyebrow = body.createDiv({ cls: "wt-eyebrow" });
    eyebrow.createSpan({ text: "正在写" });
    const status = this.plugin.getWorkbenchStatus(project.root);
    if (status) {
      eyebrow.createSpan({ cls: `wt-pill is-${status}`, text: STATUS_LABEL[status] });
    }
    const title = body.createDiv({
      cls: "wt-desk-hero-title",
      text: displayProjectName(project.name),
    });
    title.setAttr("title", project.root);

    // 三个数字：全书字数 · 章数 · 本书今日
    const figures = body.createDiv({ cls: "wt-figures" });
    const total = this.figure(figures, "…", "全书");
    this.requestProjectWords(project, (sum) => {
      const [num, unit] = splitWords(sum);
      total.num.setText(num);
      total.unit.setText(unit);
    });
    this.figure(figures, String(project.chapterCount), "章节").unit.setText("章");
    const todayFig = this.figure(figures, "0", "本书今日");
    todayFig.unit.setText("字");
    const updateBookToday = (): void => {
      const value =
        this.plugin.projectForDisplay(project.root)[dayKey(new Date())] ?? 0;
      todayFig.num.setText(fmt(Math.max(0, value)));
    };
    updateBookToday();
    this.liveUpdaters.push(updateBookToday);

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
      this.button(actions, "接着写", "pen-line", "is-primary").addEventListener(
        "click",
        () => {
          this.makeCurrent(project, false);
          this.openForWriting(last.file);
        }
      );
    }
    this.button(
      actions,
      "打开工作台",
      "panel-left",
      last ? "" : "is-primary"
    ).addEventListener("click", () => this.makeCurrent(project, true));
    this.button(actions, "换一本", "repeat", "is-quiet").addEventListener(
      "click",
      () => this.switchPage("library")
    );
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
    const streakEl = row("flame", "连续写作");
    const pomoEl = row("timer", "番茄");
    const timeEl = row("clock", "写作时长");
    const speedEl = this.plugin.settings.showSpeed ? row("gauge", "平均时速") : null;

    const detail = card.createEl("button", {
      cls: "wt-link",
      attr: { type: "button" },
      text: "今日字数明细 ›",
    });
    detail.addEventListener("click", () => this.plugin.showDailyBreakdown());

    const update = (): void => {
      const { date, words, goal } = this.today();
      const ratio = Math.min(1, words / goal);
      // 先画空，下一帧再拉到目标位置，换页时弧线会有一段生长动画
      window.requestAnimationFrame(() =>
        arc.setAttr("stroke-dashoffset", String(C * (1 - ratio)))
      );
      card.toggleClass("is-done", words >= goal);
      numEl.setText(fmt(words));
      goalEl.setText(words >= goal ? "今日已达成" : `/ ${fmt(goal)} 字`);

      const streak = currentStreak(this.plugin.dailyForDisplay(), date);
      streakEl.setText(streak > 0 ? `${streak} 天` : "今天开始");
      const pomo = this.plugin.getTodayPomodoroSummary();
      pomoEl.setText(pomo ? `${pomo.count} 个` : "—");
      const seconds = this.plugin.getTodayDurationSeconds();
      timeEl.setText(seconds >= 60 ? formatMinutes(seconds) : "—");
      if (speedEl) {
        speedEl.setText(
          seconds >= 300 && words > 0
            ? `${fmt((words / seconds) * 3600)} 字/时`
            : "—"
        );
      }
    };
    update();
    this.liveUpdaters.push(update);
  }

  private renderDeskWeek(page: HTMLElement): void {
    const card = this.block(page, "wt-card wt-desk-week", 3);
    const head = card.createDiv({ cls: "wt-card-head" });
    head.createDiv({ cls: "wt-card-label", text: "最近七天" });
    const summary = head.createDiv({ cls: "wt-card-aside" });
    const chart = card.createDiv({ cls: "wt-week" });

    const update = (): void => {
      const hist = this.plugin.dailyForDisplay();
      const goal = Math.max(1, this.plugin.settings.dailyGoal);
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
          !this.plugin.isProjectHidden(p.root) &&
          !ARCHIVE_RE.test(p.root)
      )
      .map((project) => ({ project, at: projectActivity(project) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 4);
    if (others.length === 0) return;

    const card = this.block(page, "wt-card wt-desk-others", 4);
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
      const status = this.plugin.getWorkbenchStatus(project.root);
      meta.createSpan({ text: status ? STATUS_LABEL[status] : `${project.chapterCount} 章` });
      if (at > 0) meta.createSpan({ text: relativeTime(at) });
      item.setAttr("title", "设为正在写的书");
      item.addEventListener("click", () => {
        this.makeCurrent(project, false);
        this.renderPage(true);
      });
    }
  }

  // ---------- ① 书架 ----------

  private renderLibraryPage(main: HTMLElement): void {
    const page = main.createDiv({ cls: "wt-home-page" });
    const view = this.plugin.getLibraryView();

    const head = this.pageHead(page, "书架", "所有作品都在这里；点一本就切过去写。");
    const toolbar = head.createDiv({ cls: "wt-home-toolbar" });
    this.searchBox(toolbar, "搜索书名 / 代号", this.libQuery, (value) => {
      this.libQuery = value;
      this.renderLibraryList(listEl);
    });

    // 网格 / 列表 切换
    const toggle = toolbar.createDiv({ cls: "wt-seg", attr: { role: "group" } });
    const modes: Array<{ key: LibraryView; icon: string; label: string }> = [
      { key: "grid", icon: "layout-grid", label: "封面网格" },
      { key: "list", icon: "list", label: "列表" },
    ];
    for (const mode of modes) {
      const btn = toggle.createEl("button", {
        cls: `wt-seg-btn${mode.key === view ? " is-active" : ""}`,
        attr: { type: "button", "aria-label": mode.label, title: mode.label },
      });
      setIcon(btn, mode.icon);
      btn.addEventListener("click", () => {
        if (this.plugin.getLibraryView() === mode.key) return;
        this.plugin.setLibraryView(mode.key);
        this.renderPage(false);
      });
    }

    const newBtn = this.button(toolbar, "新建作品", "plus", "is-primary");
    newBtn.addEventListener("click", () => this.plugin.openNewProjectDialog());

    const listEl = this.block(
      page,
      view === "grid" ? "wt-shelf" : "wt-lib-list",
      1
    );
    this.renderLibraryList(listEl);
  }

  private renderLibraryList(listEl: HTMLElement): void {
    listEl.empty();
    const grid = this.plugin.getLibraryView() === "grid";
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
    const hidden = sorted.filter((x) => this.plugin.isProjectHidden(x.project.root));
    const visible = sorted.filter((x) => !this.plugin.isProjectHidden(x.project.root));
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
    setIcon(chevron, open ? "chevron-down" : "chevron-right");
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
        .setIcon("pen-line")
        .onClick(() => this.activateBook(project, rerender))
    );
    const last = lastEditedChapter(project);
    if (last) {
      menu.addItem((item) =>
        item
          .setTitle(`接着写：${chapterLabel(last)}`)
          .setIcon("file-text")
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
        .setIcon(inHidden ? "eye" : "eye-off")
        .onClick(() => {
          this.plugin.setProjectHidden(project.root, !inHidden);
          rerender();
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("在系统文件管理器中显示")
        .setIcon("folder-open")
        .onClick(() => this.plugin.revealPathInSystem(project.root))
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
    const current = project.root === this.plugin.getWorkbenchProject();
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
    setIcon(eye, inHidden ? "eye" : "eye-off");
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.setProjectHidden(project.root, !inHidden);
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
    const current = project.root === this.plugin.getWorkbenchProject();
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
    setIcon(chev, "chevron-right");
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
    setIcon(eye, inHidden ? "eye" : "eye-off");
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.setProjectHidden(project.root, !inHidden);
      rerender();
    });

    row.addEventListener("click", () => this.activateBook(project, rerender));
    bindContextMenu(row, (pt) =>
      this.showBookMenu(pt, project, inHidden, rerender)
    );
  }

  /** 状态徽章内容：连载中 / 已完结 / 暂停更新 / 未标注 */
  private fillStatusChip(btn: HTMLElement, root: string): void {
    const status = this.plugin.getWorkbenchStatus(root);
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
    const current = this.plugin.getWorkbenchStatus(root);
    const menu = new Menu();
    const order: WorkbenchStatus[] = ["ongoing", "completed", "hiatus"];
    for (const key of order) {
      menu.addItem((item) =>
        item
          .setTitle(STATUS_LABEL[key])
          .setChecked(current === key)
          .onClick(() => {
            this.plugin.setWorkbenchStatus(root, key);
            this.plugin.refreshWorkbenches();
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
          this.plugin.setWorkbenchStatus(root, null);
          this.plugin.refreshWorkbenches();
          after();
        })
    );
    showMenuAt(menu, pt);
  }

  // ---------- ② 数据统计 ----------

  /** 当前统计范围下的每日字数 */
  private scopedHistory(): Record<string, number> {
    return this.statsProjectKey
      ? this.plugin.projectForDisplay(this.statsProjectKey)
      : this.plugin.dailyForDisplay();
  }

  private renderStatsPage(main: HTMLElement): void {
    const page = main.createDiv({ cls: "wt-home-page" });
    const head = this.pageHead(page, "数据统计", "一笔一笔写下来的，都记在这里。");

    // 统计范围放在页头：数字卡片、热力图、作品占比都跟着它走
    const toolbar = head.createDiv({ cls: "wt-home-toolbar" });
    const scope = toolbar.createEl("select", { cls: "dropdown wt-scope" });
    scope.createEl("option", { value: "", text: "全部作品" });
    for (const project of this.plugin.getProjects(this.statsProjectKey)) {
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
    detail.addEventListener("click", () => this.plugin.showDailyBreakdown());
    const calendarHolder = calCard.createDiv();
    this.calendar = new WritingCalendar(
      calendarHolder,
      {
        history: () => this.plugin.dailyForDisplay(),
        durationHistory: () => this.plugin.dailyDurationHistory,
        projectHistory: (key) => this.plugin.projectForDisplay(key),
        projectDurationHistory: (key) =>
          this.plugin.projectDurationHistory[key] || {},
        displayMode: () => this.plugin.settings.dailyDisplayMode,
        dailyGoal: () => this.plugin.settings.dailyGoal,
      },
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
      const rows = this.plugin
        .getProjects()
        .map((p) => {
          let sum = 0;
          for (const [day, v] of Object.entries(this.plugin.projectForDisplay(p.key))) {
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
    setIcon(foldHead.createSpan({ cls: "wt-fold-icon" }), "settings-2");
    foldHead.createSpan({ cls: "wt-fold-label", text: "统计设置" });
    foldHead.createSpan({
      cls: "wt-fold-desc",
      text: `每日目标 ${fmt(this.plugin.settings.dailyGoal)} 字 · ${WORD_COUNT_MODE_LABELS[this.plugin.settings.wordCountMode]}`,
    });
    setIcon(
      foldHead.createSpan({ cls: "wt-fold-chevron" }),
      statsSettingsOpen ? "chevron-up" : "chevron-down"
    );
    foldHead.addEventListener("click", () => {
      statsSettingsOpen = !statsSettingsOpen;
      this.renderPage(false);
    });
    if (statsSettingsOpen) {
      this.renderStatsSettings(settings.createDiv({ cls: "wt-home-settings" }));
    }
  }

  private renderStatsSettings(card: HTMLElement): void {
    new Setting(card)
      .setName("每日目标")
      .setDesc("目标字数（影响热力图达标阈值与今日进度）")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.dailyGoal)).onChange(async (value) => {
          const goal = parseInt(value, 10);
          if (goal > 0) {
            this.plugin.settings.dailyGoal = goal;
            await this.plugin.saveSettings();
            this.calendar?.refresh();
            this.updateRailToday();
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
        dropdown.setValue(this.plugin.settings.wordCountMode).onChange(async (value) => {
          this.plugin.setWordCountMode(value as WordCountMode);
          await this.plugin.saveSettings();
        });
      });

    new Setting(card)
      .setName("热力图显示方式")
      .setDesc("格子的深浅按字数或写作时长")
      .addDropdown((dropdown) => {
        for (const [key, label] of Object.entries(DAILY_DISPLAY_MODE_LABELS)) {
          dropdown.addOption(key, label);
        }
        dropdown.setValue(this.plugin.settings.dailyDisplayMode).onChange(async (value) => {
          this.plugin.settings.dailyDisplayMode =
            value as typeof this.plugin.settings.dailyDisplayMode;
          await this.plugin.saveSettings();
          this.calendar?.refresh();
        });
      });

    new Setting(card)
      .setName("显示码字时速")
      .setDesc("状态栏里显示当前时速")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showSpeed).onChange(async (value) => {
          this.plugin.settings.showSpeed = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(card)
      .setName("状态栏仅在沉浸模式显示")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.statusBarOnlyImmersive).onChange(async (value) => {
          this.plugin.settings.statusBarOnlyImmersive = value;
          this.plugin.updateStatusBarVisibility();
          await this.plugin.saveSettings();
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
    const path = (this.plugin.settings.sharedLibraryFolder ?? "")
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
    setIcon(row.createSpan({ cls: "wt-doc-icon" }), "file-text");
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
        item.setTitle("打开").setIcon("file-text").onClick(() => open(false))
      );
      menu.addItem((item) =>
        item.setTitle("在新标签页打开").setIcon("plus").onClick(() => open(true))
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("在系统文件管理器中显示")
          .setIcon("folder-open")
          .onClick(() => this.plugin.revealPathInSystem(file.path))
      );
      showMenuAt(menu, pt);
    });
  }
}
