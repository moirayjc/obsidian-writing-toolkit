import { App, Menu, Notice } from "obsidian";
import type { WordCountService } from "./services/wordCountService";
import type { StatusBarState } from "./services/statsService";
import type { PomodoroPhase, PomodoroState } from "./pomodoro";
import { TextPromptModal } from "./promptModal";

/** 锁定菜单里的说明行（Esc 是键名，保持原样大小写）。 */
const LOCKED_MENU_HINT = "锁定中 · 长按 Esc 紧急退出";

/** 状态栏番茄钟入口需要的动作回调（由插件提供，避免状态栏直接持有插件）。 */
export interface PomodoroActions {
  onStart: () => void;
  onTogglePause: () => void;
  onSkipBreak: () => void;
  onStop: () => void;
  /** 锁定中打开当前章的章纲弹窗。 */
  onOpenOutline: () => void;
}

export class WritingStatusBar {
  private container: HTMLElement;
  private wordCountEl: HTMLElement;
  private goalEl: HTMLElement;
  private pomoSepEl: HTMLElement;
  private pomoEl: HTMLElement;
  private pomodoroPhase: PomodoroPhase = "idle";
  private pomodoroPaused = false;
  private pomodoroLocked = false;

  /** 单次超过 120 字视为粘贴/整章导入，不算「写下的字」。 */
  private readonly MAX_TYPED_DELTA = 120;
  /**
   * 最近一次「落定」（没有在输入法拼字）时的字数。写下的字只在落定时刻按与它的差
   * 结算：拼字期间拼音字母真的在文档里（先插 `n` 再换成 `ni`），逐次累加会把
   * 按键数当成字数。
   */
  private typedRefCount = -1;
  private lastDocCount: number = -1;
  private selectedCount: number = 0;

  /** 基线上限（会随插件数据持久化，留足整本书的章节数） */
  private readonly MAX_BASELINES = 400;
  private fileBaselines: Map<string, number> = new Map();
  private currentFilePath: string = "";

  private state: StatusBarState;
  private app: App;
  private wordCount: WordCountService;
  private onGoalChange: () => void;
  private pomodoroActions: PomodoroActions;

  /**
   * 基线变化通知：插件据此把基线写进插件数据（跨会话保留）。
   * words 为 null 表示该路径的基线被丢弃。
   */
  baselineListener: ((path: string, words: number | null) => void) | null = null;
  /** 首次为某个路径建立基础字数时的通知。 */
  baselineSeedListener: ((path: string) => void) | null = null;
  /** 文件改名后迁移已有基线时的通知。 */
  baselineMigrateListener:
    | ((oldPath: string, newPath: string) => void)
    | null = null;
  /** 删除已有基线时的通知。 */
  baselineDropListener: ((path: string) => void) | null = null;

  constructor(
    app: App,
    wordCount: WordCountService,
    addStatusBarItem: () => HTMLElement,
    state: StatusBarState,
    onGoalChange: () => void,
    pomodoroActions: PomodoroActions
  ) {
    this.app = app;
    this.wordCount = wordCount;
    this.state = state;
    this.onGoalChange = onGoalChange;
    this.pomodoroActions = pomodoroActions;

    this.container = addStatusBarItem();
    this.container.addClass("wt-status-bar");

    this.wordCountEl = this.container.createSpan({ cls: "wt-stat" });
    this.container.createSpan({ cls: "wt-sep", text: "|" });

    this.goalEl = this.container.createSpan({ cls: "wt-stat wt-goal" });
    this.goalEl.addEventListener("click", () => this.promptGoal());

    this.pomoSepEl = this.container.createSpan({ cls: "wt-sep", text: "|" });
    this.pomoEl = this.container.createSpan({ cls: "wt-stat wt-pomo-btn" });
    this.pomoEl.addEventListener("click", (event) =>
      this.handlePomodoroClick(event)
    );
  }

  setState(state: StatusBarState): void {
    this.state = state;
    if (this.lastDocCount >= 0) this.refresh(this.lastDocCount);
  }

  /** 自检用：当前文档路径与字数（还没建立时 path 为空）。 */
  getCurrentDoc(): { path: string; words: number | null } {
    if (!this.currentFilePath) return { path: "", words: null };
    return {
      path: this.currentFilePath,
      words: this.lastDocCount >= 0 ? this.lastDocCount : null,
    };
  }

  onFileChange(path: string, text: string): void {
    this.currentFilePath = path;
    const docCount = this.wordCount.count(text, this.state.wordCountMode);
    this.selectedCount = 0;
    this.lastDocCount = docCount;
    this.typedRefCount = docCount;
    this.rememberBaseline(path, docCount);
    this.refresh(docCount);
  }

  rebaseCurrentDocument(text: string): void {
    const docCount = this.wordCount.count(text, this.state.wordCountMode);
    this.lastDocCount = docCount;
    this.typedRefCount = docCount;
    if (this.currentFilePath) this.rememberBaseline(this.currentFilePath, docCount);
    this.refresh(docCount);
  }

  setSelectionText(text: string): void {
    this.selectedCount = text
      ? this.wordCount.count(text, this.state.wordCountMode)
      : 0;
    if (this.lastDocCount >= 0) this.refresh(this.lastDocCount);
  }

  /**
   * 外部修改（AI 改写、其他工具）的字数增量：
   * 按文件路径的基线计算净变化，不碰当前编辑状态与时速采样。
   */
  onExternalFileChange(path: string, text: string): number {
    const docCount = this.wordCount.count(text, this.state.wordCountMode);
    const baseline = this.fileBaselines.get(path);
    let delta = 0;
    if (baseline === undefined || baseline === -1) {
      this.rememberBaseline(path, docCount);
    } else {
      delta = docCount - baseline;
      this.rememberBaseline(path, docCount);
    }
    return delta;
  }

  /** 源文件重命名/移动后迁移基线，避免改名后增量失真或旧路径基线残留。 */
  onFileRename(oldPath: string, newPath: string): boolean {
    const baseline = this.fileBaselines.get(oldPath);
    if (baseline === undefined) return false;
    this.fileBaselines.delete(oldPath);
    this.fileBaselines.set(newPath, baseline);
    if (this.currentFilePath === oldPath) this.currentFilePath = newPath;
    this.baselineMigrateListener?.(oldPath, newPath);
    return true;
  }

  /**
   * 番茄钟状态段：始终可见。
   * 空闲时显示可点击的「🍅 开始」，计时中显示倒计时（与暂停标记），
   * 点击后由 handlePomodoroClick 决定直接开始或弹出操作菜单。
   */
  setPomodoro(state: PomodoroState | null): void {
    this.pomodoroPhase = state?.phase ?? "idle";
    this.pomodoroPaused = state?.paused ?? false;
    this.pomodoroLocked = (state?.lock ?? "none") !== "none";
    this.pomoSepEl.removeClass("is-hidden");
    this.pomoEl.removeClass("is-hidden");
    if (!state || state.phase === "idle") {
      this.pomoEl.setText("🍅 开始");
      this.pomoEl.setAttr("title", "开始番茄钟");
      return;
    }
    const time = formatDuration(state.remainingMs);
    const pauseMark = state.paused ? " ⏸" : "";
    if (state.phase === "focus" && this.pomodoroLocked) {
      this.pomoEl.setText(`🔒 ${time} · ${state.words}`);
      this.pomoEl.setAttr("title", "锁定中 · 点击查看章纲");
    } else if (state.phase === "focus") {
      this.pomoEl.setText(`🍅${pauseMark} ${time} · ${state.words}`);
      this.pomoEl.setAttr("title", state.paused ? "继续番茄钟" : "暂停番茄钟");
    } else if (state.phase === "longBreak") {
      this.pomoEl.setText(`长休${pauseMark} ${time}`);
      this.pomoEl.setAttr("title", "管理番茄钟");
    } else {
      this.pomoEl.setText(`休${pauseMark} ${time}`);
      this.pomoEl.setAttr("title", "管理番茄钟");
    }
  }

  /** 空闲时直接开始；计时中弹出操作菜单（暂停/继续、跳过休息、结束）。 */
  private handlePomodoroClick(event: MouseEvent): void {
    if (this.pomodoroPhase === "idle") {
      this.pomodoroActions.onStart();
      return;
    }
    const menu = new Menu();
    if (this.pomodoroLocked) {
      // 锁定中只能看章纲；暂停 / 结束都不给，紧急出口是长按 Esc。
      menu.addItem((item) =>
        item.setTitle("查看本章章纲").onClick(() => this.pomodoroActions.onOpenOutline())
      );
      menu.addItem((item) => item.setTitle(LOCKED_MENU_HINT).setDisabled(true));
      menu.showAtMouseEvent(event);
      return;
    }
    menu.addItem((item) =>
      item
        .setTitle(this.pomodoroPaused ? "继续番茄钟" : "暂停番茄钟")
        .onClick(() => this.pomodoroActions.onTogglePause())
    );
    if (this.pomodoroPhase === "break" || this.pomodoroPhase === "longBreak") {
      menu.addItem((item) =>
        item
          .setTitle("跳过休息")
          .onClick(() => this.pomodoroActions.onSkipBreak())
      );
    }
    menu.addItem((item) =>
      item
        .setTitle("结束番茄钟")
        .onClick(() => this.pomodoroActions.onStop())
    );
    menu.showAtMouseEvent(event);
  }

  /**
   * 编辑器里的字数变化。
   * isNewFile=true 表示这是全新文件的第一笔内容（之前视作 0 字），
   * 整份内容算作本次新增。
   *
   * 返回 delta（相对基线的净变化，进今日净增）与 typed（这次手动写下的字，
   * 只记 1–120 字的正增量，删除与粘贴都是 0，进时速）。countTyped=false
   * 用于外部同步刷新等不是作者在打字的变化；composing=true 表示输入法正在
   * 拼字，这时不结算写下的字，等拼字结束后由 settleTyped() 补上。
   */
  onEditorChange(
    text: string,
    isNewFile = false,
    countTyped = true,
    composing = false
  ): { delta: number; typed: number } {
    const docCount = this.wordCount.count(text, this.state.wordCountMode);

    const typed = composing ? 0 : this.takeTyped(docCount, countTyped);
    this.lastDocCount = docCount;

    // 还不知道当前文件时（插件刚加载、编辑器尚未就绪）不产生增量：
    // 否则会拿"上一个文档"的基线做差，凭空多出几千字。
    if (!this.currentFilePath) {
      this.refresh(docCount);
      return { delta: 0, typed: 0 };
    }

    const baseline = this.fileBaselines.get(this.currentFilePath);
    let delta = 0;
    if (isNewFile && this.currentFilePath) {
      delta = docCount;
      this.rememberBaseline(this.currentFilePath, docCount);
    } else if (baseline === undefined || baseline === -1) {
      this.rememberBaseline(this.currentFilePath, docCount);
    } else {
      // 今日统计采用净变化：新增为正，删除为负，避免删改后字数虚高。
      delta = docCount - baseline;
      this.rememberBaseline(this.currentFilePath, docCount);
    }

    this.refresh(docCount);

    return { delta, typed };
  }

  /** 输入法拼字结束后补结算写下的字（拼字期间的变化在 onEditorChange 里先不算）。 */
  settleTyped(text: string): number {
    return this.takeTyped(
      this.wordCount.count(text, this.state.wordCountMode),
      true
    );
  }

  /** 按与上一次落定字数的差结算写下的字，并把落定点前移到当前。 */
  private takeTyped(docCount: number, countTyped: boolean): number {
    const change = this.typedRefCount >= 0 ? docCount - this.typedRefCount : 0;
    this.typedRefCount = docCount;
    return countTyped && change > 0 && change <= this.MAX_TYPED_DELTA ? change : 0;
  }

  private refresh(wordCount: number): void {
    const wordCountText = this.selectedCount > 0
      ? `本章 ${formatNumber(this.selectedCount)}/${formatNumber(wordCount)}`
      : `本章 ${formatNumber(wordCount)}`;
    this.wordCountEl.setText(wordCountText);
    this.goalEl.setText(
      "目标 " + formatNumber(this.state.dailyTotal) +
        "/" + formatNumber(this.state.dailyGoal)
    );
    this.goalEl.setAttr(
      "title",
      `今日净增 ${formatNumber(this.state.dailyTotal)} 字（新增为正，删除为负）· 点击修改目标`
    );
  }

  private promptGoal(): void {
    new TextPromptModal(
      this.app,
      "设置每日目标字数",
      String(this.state.dailyGoal),
      (input) => {
        const num = parseInt(input, 10);
        if (Number.isNaN(num) || num <= 0) {
          new Notice("请输入大于 0 的数字");
          return;
        }
        this.state.dailyGoal = num;
        this.onGoalChange();
      }
    ).open();
  }

  /** 清空全部文件基线（切换字数统计模式后调用，避免新旧模式计数混用）。 */
  resetBaselines(): void {
    for (const path of [...this.fileBaselines.keys()]) {
      this.baselineListener?.(path, null);
    }
    this.fileBaselines.clear();
  }

  /** 启动时载入上次会话留下的基线，避免重启后把整章当成新写的。 */
  loadBaselines(entries: Record<string, number>): void {
    for (const [path, words] of Object.entries(entries)) {
      if (typeof words === "number" && Number.isFinite(words)) {
        this.fileBaselines.set(path, words);
      }
    }
  }

  /** 该文件是否已有基线（有基线才谈得上「增量」）。 */
  hasBaseline(path: string): boolean {
    return this.fileBaselines.has(path);
  }

  /** 读取某个文件的基线字数；还没建档时返回 undefined。 */
  getBaseline(path: string): number | undefined {
    return this.fileBaselines.get(path);
  }

  /** 状态栏是否已经知道「当前文件」（插件刚加载、编辑器还没就绪时会没有）。 */
  hasCurrentFile(): boolean {
    return this.currentFilePath !== "";
  }

  /** 丢弃一个可疑的基线（清掉历史脏数据时用）。 */
  forgetBaseline(path: string): void {
    this.dropBaseline(path);
  }

  /** 只记录基线，不产生增量（用于补建历史文件的档案）。 */
  seedBaseline(path: string, text: string): void {
    this.rememberBaseline(
      path,
      this.wordCount.count(text, this.state.wordCountMode)
    );
  }

  /** 丢弃某个文件的基线（文件被删除时调用）。 */
  dropBaseline(path: string): void {
    if (!this.fileBaselines.has(path)) return;
    this.fileBaselines.delete(path);
    this.baselineListener?.(path, null);
    this.baselineDropListener?.(path);
  }

  /**
   * 全新出现的文件（新建章节等）：之前的字数视作 0，
   * 整份内容算作本次新增，避免「先写后改」时只统计到删减的负值。
   */
  countAsNewFile(path: string, text: string): number {
    const docCount = this.wordCount.count(text, this.state.wordCountMode);
    this.rememberBaseline(path, docCount);
    return docCount;
  }

  destroy(): void {
    this.container.remove();
  }

  /**
   * 记录文件基线并清理最久未使用的条目，
   * 避免打开过的文件无限累积占用内存。
   *
   * 空路径一律不记：以前 currentFilePath 还没建立时会把基线写到空键上，
   * 之后又拿这个键里的（别的文档的）字数做差，凭空产出 ±几千的假数字。
   */
  private rememberBaseline(path: string, count: number): void {
    if (!path) return;
    const isNewBaseline = !this.fileBaselines.has(path);
    this.fileBaselines.delete(path);
    this.fileBaselines.set(path, count);
    this.baselineListener?.(path, count);
    if (isNewBaseline) this.baselineSeedListener?.(path);
    if (this.fileBaselines.size > this.MAX_BASELINES) {
      const excess = this.fileBaselines.size - this.MAX_BASELINES;
      let removed = 0;
      for (const key of this.fileBaselines.keys()) {
        if (removed >= excess) break;
        if (key === path) continue;
        this.fileBaselines.delete(key);
        this.baselineListener?.(key, null);
        removed++;
      }
    }
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
