import { setIcon } from "obsidian";

interface DailyHistory {
  [date: string]: number;
}

type DisplayMode = "words" | "duration";

export interface CalendarDataProvider {
  /** 全部作品的每日净增字数 */
  history: () => DailyHistory;
  /** 全部作品的每日写作时长 */
  durationHistory: () => DailyHistory;
  /** 指定作品的每日净增字数 */
  projectHistory: (key: string) => DailyHistory;
  /** 指定作品的每日写作时长 */
  projectDurationHistory: (key: string) => DailyHistory;
  displayMode: () => DisplayMode;
  dailyGoal: () => number;
}

/** 热力图固定 7 行：周一 -> 周日 */
const ROWS = 7;
const MS_PER_DAY = 86400000;
/** 行刻度：与 GitHub 一致，只标注周一 / 周三 / 周五 */
const WEEKDAY_TICKS: Record<number, string> = { 0: "一", 2: "三", 4: "五" };
/** 星期标签列宽与列间距，需与 styles.css 中的 --wt-heat-wd 保持一致 */
const WEEKDAY_COL = 12;
const BODY_GAP = 5;
const MIN_CELL = 3;
const MAX_CELL = 14;

/**
 * 写作打卡热力图：GitHub 贡献图形式的整年网格。
 * 每列一周、每行一天，格子按当日热度着色，悬停查看当日明细。
 */
export class WritingCalendar {
  private readonly containerEl: HTMLElement;
  private readonly provider: CalendarDataProvider;
  private year: number;
  private projectKey: string | null = null;
  private summaryEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private monthsEl: HTMLElement | null = null;
  private todayCell: HTMLElement | null = null;
  private monthLabels: Array<{ el: HTMLElement; col: number; full: string; short: string }> = [];
  private weekCount = 0;
  private renderedMode: DisplayMode | null = null;
  private renderedGoal: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastWidth = -1;

  constructor(containerEl: HTMLElement, provider: CalendarDataProvider, initialYear?: number) {
    this.containerEl = containerEl;
    this.provider = provider;
    // 可浏览上限就是今年：未来年份没有数据，不该翻得过去
    const currentYear = new Date().getFullYear();
    this.year = Math.min(initialYear ?? currentYear, currentYear);
    this.render();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.containerEl);
    }
  }

  /** 当前查看的年份（供侧栏重建时恢复，避免跳回今年）。 */
  getYear(): number {
    return this.year;
  }

  /** 切换统计范围：null 表示全部作品。 */
  setProject(key: string | null): void {
    this.projectKey = key;
    this.render();
  }

  getProjectKey(): string | null {
    return this.projectKey;
  }

  refresh(): void {
    if (!this.summaryEl) {
      this.render();
      return;
    }
    const mode = this.mode();
    const goal = this.goal();
    // 设置变化会影响整年格子的内容与热度，不能只增量更新今天
    if (mode !== this.renderedMode || goal !== this.renderedGoal) {
      this.render();
      return;
    }
    const history = this.history();
    const durationHistory = this.durationHistory();
    this.updateSummary(history, durationHistory, goal, mode);
    const now = new Date();
    // 仅当年视图下才增量更新今日格子；历史/未来年份只刷新摘要
    if (this.todayCell && now.getFullYear() === this.year) {
      const key = dateKey(now);
      this.updateCell(this.todayCell, history[key] || 0, durationHistory[key] || 0, goal, mode, key);
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private history(): DailyHistory {
    if (this.projectKey) return this.provider.projectHistory(this.projectKey) ?? {};
    return this.provider.history();
  }

  private durationHistory(): DailyHistory {
    if (this.projectKey) {
      return this.provider.projectDurationHistory(this.projectKey) ?? {};
    }
    return this.provider.durationHistory();
  }

  private mode(): DisplayMode {
    return this.provider.displayMode();
  }

  private goal(): number {
    return this.provider.dailyGoal();
  }

  private projectLabel(): string {
    return this.projectKey ? (this.projectKey.split("/").pop() || this.projectKey) : "";
  }

  private handleResize(): void {
    const width = this.bodyEl ? this.bodyEl.clientWidth : this.containerEl.clientWidth;
    if (width === this.lastWidth) return;
    this.fit();
  }

  private render(): void {
    const contentEl = this.containerEl;
    contentEl.empty();
    contentEl.addClass("wt-calendar-view");
    contentEl.addClass("wt-heatmap");

    const year = this.year;
    const history = this.history();
    const durationHistory = this.durationHistory();
    const mode = this.mode();
    const dailyGoal = this.goal();
    this.renderedMode = mode;
    this.renderedGoal = dailyGoal;
    const today = new Date();
    const currentYear = today.getFullYear();

    // 头部：‹ 年份 › 一行，年度统计放在年份下面一行
    const header = contentEl.createDiv({ cls: "wt-calendar-header" });
    const navGroup = header.createDiv({ cls: "wt-calendar-nav-group" });
    const previous = navGroup.createEl("button", { cls: "wt-calendar-nav" });
    setIcon(previous, "chevron-left");
    previous.setAttr("aria-label", "上一年");
    previous.onclick = () => {
      this.year = year - 1;
      this.render();
    };
    navGroup.createEl("h2", { text: `${year}年` });
    const next = navGroup.createEl("button", { cls: "wt-calendar-nav" });
    setIcon(next, "chevron-right");
    next.setAttr("aria-label", "下一年");
    const canGoNext = year < currentYear;
    next.disabled = !canGoNext;
    next.onclick = () => {
      if (!canGoNext) return;
      this.year = year + 1;
      this.render();
    };

    const summary = header.createDiv({ cls: "wt-calendar-summary" });
    this.summaryEl = summary;
    this.updateSummary(history, durationHistory, dailyGoal, mode);

    // 热力网格：以「包含 1 月 1 日的那一周」开头，整周整周地铺满全年
    const start = startOfWeek(new Date(year, 0, 1));
    const totalDays = Math.ceil((dayOffset(start, new Date(year, 11, 31)) + 1) / ROWS) * ROWS;
    this.weekCount = totalDays / ROWS;
    this.monthLabels = [];
    this.todayCell = null;

    const body = contentEl.createDiv({ cls: "wt-heatmap-body" });
    this.bodyEl = body;

    const weekdays = body.createDiv({ cls: "wt-heatmap-weekdays" });
    for (let row = 0; row < ROWS; row++) {
      weekdays.createDiv({ cls: "wt-heatmap-weekday", text: WEEKDAY_TICKS[row] ?? "" });
    }

    const main = body.createDiv({ cls: "wt-heatmap-main" });
    this.monthsEl = main.createDiv({ cls: "wt-heatmap-months" });
    const grid = main.createDiv({ cls: "wt-heatmap-grid" });

    const todayKey = dateKey(today);
    for (let i = 0; i < totalDays; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const cell = grid.createDiv({ cls: "wt-heat-cell" });
      if (date.getFullYear() !== year) {
        // 补足整周的日期（上一年年末 / 下一年年初），不参与统计
        cell.addClass("is-outside");
        continue;
      }
      const key = dateKey(date);
      if (key === todayKey) {
        cell.addClass("is-today");
        this.todayCell = cell;
      }
      this.updateCell(cell, history[key] || 0, durationHistory[key] || 0, dailyGoal, mode, key);
    }

    this.buildMonthLabels(year, start);
    this.fit();
  }

  private updateCell(
    cell: HTMLElement,
    count: number,
    duration: number,
    goal: number,
    mode: DisplayMode,
    key: string
  ): void {
    cell.removeClass("l0", "l1", "l2", "l3", "l4");
    const level = mode === "duration"
      ? durationHeatLevel(duration)
      : heatLevel(count, goal);
    cell.addClass(`l${level}`);
    const title = mode === "duration"
      ? duration > 0 ? `${key}：${formatDuration(duration)}` : `${key}：未写作`
      : count > 0
        ? `${key}：${formatNumber(count)} 字${count >= goal ? "（已达标）" : `（目标 ${formatNumber(goal)} 字）`}`
        : `${key}：未写作`;
    cell.setAttr("title", title);
    cell.setAttr("aria-label", title);
  }

  private buildMonthLabels(year: number, start: Date): void {
    if (!this.monthsEl) return;
    for (let month = 0; month < 12; month++) {
      const col = Math.floor(dayOffset(start, new Date(year, month, 1)) / ROWS);
      const el = this.monthsEl.createDiv({ cls: "wt-heatmap-month" });
      this.monthLabels.push({
        el,
        col,
        full: `${month + 1}月`,
        short: `${month + 1}`,
      });
    }
  }

  /** 按容器宽度计算格子尺寸，让整年刚好铺满一行；窄到极限时退回最小尺寸。 */
  private fit(): void {
    const body = this.bodyEl;
    if (!body || this.weekCount <= 0) return;
    const width = body.clientWidth;
    if (width <= 0) return;
    this.lastWidth = width;

    const pitch = Math.max(
      MIN_CELL + 1,
      (width - WEEKDAY_COL - BODY_GAP) / this.weekCount
    );
    const gap = pitch >= 12 ? 3 : pitch >= 6 ? 2 : 1;
    const cell = Math.min(MAX_CELL, Math.max(MIN_CELL, pitch - gap));

    this.containerEl.style.setProperty("--wt-heat-cell", `${cell}px`);
    this.containerEl.style.setProperty("--wt-heat-gap", `${gap}px`);
    this.containerEl.style.setProperty("--wt-heat-wd", `${WEEKDAY_COL}px`);
    this.layoutMonthLabels(cell + gap);
  }

  /**
   * 月份标签：优先「1月」这种完整写法；只要有一个放不下，就整行统一改
   * 成纯数字（GitHub 的 Jan/Feb 同理），再放不下的直接隐藏，避免互相压字。
   */
  private layoutMonthLabels(step: number): void {
    const place = (useShort: boolean): boolean => {
      let previousRight = -Infinity;
      let allFit = true;
      for (let i = 0; i < this.monthLabels.length; i++) {
        const entry = this.monthLabels[i];
        const x = entry.col * step;
        const nextX = i + 1 < this.monthLabels.length
          ? this.monthLabels[i + 1].col * step
          : Number.POSITIVE_INFINITY;
        const room = nextX - x - 1.5;

        entry.el.style.display = "";
        entry.el.style.left = `${x}px`;
        entry.el.setText(useShort ? entry.short : entry.full);
        const used = entry.el.getBoundingClientRect().width;
        if (used > room || x < previousRight + 0.5) {
          entry.el.style.display = "none";
          allFit = false;
          continue;
        }
        previousRight = x + used;
      }
      return allFit;
    };

    if (!place(false)) place(true);
  }

  private updateSummary(
    history: DailyHistory,
    durationHistory: DailyHistory,
    goal: number,
    mode: DisplayMode
  ): void {
    if (!this.summaryEl) return;
    this.summaryEl.empty();
    const stats = computeStats(this.year, history, durationHistory, goal, mode);

    const pillsRow = this.summaryEl.createDiv({ cls: "wt-cal-pills" });

    // 1. 全年净增字数 / 时长（不带标签，紧跟年份读作「2026年 18,570字」）
    const primaryPill = pillsRow.createDiv({ cls: "wt-cal-pill is-primary" });
    primaryPill.createSpan({
      cls: "wt-cal-pill-val",
      text: mode === "duration" ? formatDuration(stats.durationTotal) : `${formatNumber(stats.wordTotal)}字`,
    });

    // 2. 写作天数
    const daysPill = pillsRow.createDiv({ cls: "wt-cal-pill" });
    daysPill.createSpan({ cls: "wt-cal-pill-label", text: "打卡" });
    daysPill.createSpan({ cls: "wt-cal-pill-val", text: `${stats.days}天` });

    // 3. 达标天数（字数模式下）
    if (mode === "words" && goal > 0) {
      const goalPill = pillsRow.createDiv({ cls: "wt-cal-pill" });
      goalPill.createSpan({ cls: "wt-cal-pill-label", text: "达标" });
      goalPill.createSpan({ cls: "wt-cal-pill-val", text: `${stats.goalDays}天` });
    }

    // 4. 连续天数
    if (stats.streak > 0) {
      const streakPill = pillsRow.createDiv({ cls: "wt-cal-pill is-streak" });
      streakPill.createSpan({ cls: "wt-cal-pill-val", text: `🔥 ${stats.streak}天` });
    }

    // 若限定了作品，显示微标签
    if (this.projectLabel()) {
      const tag = this.summaryEl.createDiv({ cls: "wt-cal-project-tag" });
      tag.setText(`范围：${this.projectLabel()}`);
    }
  }
}

function computeStats(
  year: number,
  history: DailyHistory,
  durationHistory: DailyHistory,
  goal: number,
  mode: DisplayMode
): { wordTotal: number; durationTotal: number; days: number; goalDays: number; streak: number } {
  const prefix = `${year}-`;
  const entries = Object.entries(history).filter(([date, count]) =>
    date.startsWith(prefix) && count !== 0
  );
  const durationEntries = Object.entries(durationHistory).filter(([date, seconds]) =>
    date.startsWith(prefix) && seconds !== 0
  );
  const wordTotal = entries.reduce((sum, [, count]) => sum + count, 0);
  const durationTotal = durationEntries.reduce((sum, [, seconds]) => sum + seconds, 0);
  const goalDays = entries.filter(([, count]) => count >= goal).length;
  return {
    wordTotal,
    durationTotal,
    days: mode === "duration" ? durationEntries.length : entries.length,
    goalDays,
    streak: computeStreak(mode === "duration" ? durationHistory : history),
  };
}

function computeStreak(history: DailyHistory): number {
  let streak = 0;
  const d = new Date();
  if (!(history[dateKey(d)] > 0)) d.setDate(d.getDate() - 1); // 今天还没写，从昨天开始算
  while (history[dateKey(d)] > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

/** 热度 0-4（GitHub 贡献图只有 4 档绿），0 表示当天没写。 */
function heatLevel(count: number, goal: number): number {
  if (count <= 0) return 0;
  if (goal <= 0) return 1;
  const ratio = count / goal;
  if (ratio >= 1) return 4;
  if (ratio >= 0.66) return 3;
  if (ratio >= 0.33) return 2;
  return 1;
}

function durationHeatLevel(seconds: number): number {
  const minutes = seconds / 60;
  if (minutes <= 0) return 0;
  if (minutes <= 30) return 1;
  if (minutes <= 75) return 2;
  if (minutes <= 180) return 3;
  return 4;
}

/** 周一作为一周的第一天 */
function startOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** 以「天」为单位计算间隔，避开夏令时导致的小时误差 */
function dayOffset(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / MS_PER_DAY);
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}小时${minutes}分` : `${minutes}分钟`;
}
