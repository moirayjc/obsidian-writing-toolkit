export type PomodoroPhase = "idle" | "focus" | "break" | "longBreak";

export interface PomodoroConfig {
  focusMinutes: number;
  breakMinutes: number;
  /** 每完成 N 个番茄后进入长休息 */
  longBreakEvery: number;
  longBreakMinutes: number;
}

export interface PomodoroState {
  phase: PomodoroPhase;
  totalMs: number;
  remainingMs: number;
  /** 本番茄已写字数（专注中实时刷新） */
  words: number;
  paused: boolean;
}

export interface FocusResult {
  words: number;
  isLongBreak: boolean;
}

export interface PomodoroInterval {
  dispose(): void;
}

export interface PomodoroScheduler {
  setInterval(callback: () => void, delayMs: number): PomodoroInterval;
}

interface PomodoroEvents {
  onUpdate: (state: PomodoroState) => void;
  onFocusComplete: (result: FocusResult) => void;
  onBreakComplete: () => void;
}

const TICK_MS = 1000;
const WINDOW_SCHEDULER: PomodoroScheduler = {
  setInterval(callback, delayMs) {
    const handle = window.setInterval(callback, delayMs);
    return {
      dispose() {
        window.clearInterval(handle);
      },
    };
  },
};

export class PomodoroTimer {
  private phase: PomodoroPhase = "idle";
  private deadline = 0;
  private pausedRemaining = 0;
  private tickHandle: PomodoroInterval | null = null;
  private consecutive = 0;
  private baseCount: number | null = null;
  private words = 0;

  constructor(
    private readonly config: () => PomodoroConfig,
    private readonly getCount: () => number,
    private readonly events: PomodoroEvents,
    private readonly scheduler: PomodoroScheduler = WINDOW_SCHEDULER
  ) {}

  /** 自检用：番茄基准字数（未运行时为 null）。 */
  getBaseCount(): number | null {
    return this.baseCount;
  }

  getState(): PomodoroState {
    const cfg = this.config();
    if (this.phase === "idle") {
      const total = cfg.focusMinutes * 60000;
      return { phase: "idle", totalMs: total, remainingMs: total, words: 0, paused: false };
    }
    let total = cfg.focusMinutes * 60000;
    if (this.phase === "break") total = cfg.breakMinutes * 60000;
    else if (this.phase === "longBreak") total = cfg.longBreakMinutes * 60000;

    const remaining = this.pausedRemaining > 0
      ? this.pausedRemaining
      : Math.max(0, this.deadline - Date.now());
    return {
      phase: this.phase,
      totalMs: total,
      remainingMs: remaining,
      words: this.phase === "focus" ? this.words + this.currentFocusWords() : this.words,
      paused: this.pausedRemaining > 0,
    };
  }

  /** 空闲状态下开始一个专注番茄；已在计时中返回 false。 */
  start(): boolean {
    if (this.phase !== "idle") return false;
    this.phase = "focus";
    this.words = 0;
    this.baseCount = this.getCount();
    this.pausedRemaining = 0;
    this.deadline = Date.now() + this.config().focusMinutes * 60000;
    this.startTicking();
    return true;
  }

  togglePause(): void {
    if (this.phase === "idle") return;
    if (this.pausedRemaining > 0) {
      this.deadline = Date.now() + this.pausedRemaining;
      this.pausedRemaining = 0;
      this.startTicking();
    } else {
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) {
        this.completePhase();
        return;
      }
      this.pausedRemaining = remaining;
      this.stopTicking();
    }
    this.emit();
  }

  stop(): void {
    this.stopTicking();
    this.phase = "idle";
    this.pausedRemaining = 0;
    this.baseCount = null;
    this.words = 0;
    this.consecutive = 0;
    this.emit();
  }

  /**
   * 外部/AI 修改导致当前文档字数变化时，同步调整番茄基线，
   * 使「本番茄字数」只反映用户自己的输入增量。
   */
  adjustBaseCount(delta: number): void {
    if (this.phase !== "focus" || this.baseCount === null || delta === 0) return;
    this.baseCount += delta;
  }

  /**
   * 字数统计模式切换后调用：把基线重设为当前计数，
   * 避免「新模式计数 − 旧模式基线」产生错误的本番茄字数。
   */
  rebaseBaseCount(preserveCurrentWords = false): void {
    if (this.phase !== "focus" || this.baseCount === null) return;
    if (preserveCurrentWords) this.words += this.currentFocusWords();
    this.baseCount = this.getCount();
  }

  /** 编辑器已确认新文本后立即结算增量，避免文件切换事件顺序导致丢字。 */
  captureCurrentWords(): void {
    if (this.phase !== "focus" || this.baseCount === null) return;
    this.words += this.currentFocusWords();
    this.baseCount = this.getCount();
  }

  skipBreak(): void {
    if (this.phase !== "break" && this.phase !== "longBreak") return;
    this.stopTicking();
    this.phase = "idle";
    this.pausedRemaining = 0;
    this.emit();
  }

  private currentFocusWords(): number {
    return Math.max(0, this.getCount() - (this.baseCount ?? this.getCount()));
  }

  private startTicking(): void {
    this.stopTicking();
    this.emit();
    this.tickHandle = this.scheduler.setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.tickHandle !== null) {
      this.tickHandle.dispose();
      this.tickHandle = null;
    }
  }

  private tick(): void {
    if (this.deadline - Date.now() <= 0) {
      this.completePhase();
      return;
    }
    this.emit();
  }

  private completePhase(): void {
    this.stopTicking();
    if (this.phase === "focus") {
      const delta = this.words + this.currentFocusWords();
      this.words = delta;
      this.baseCount = null;
      this.consecutive++;

      const cfg = this.config();
      const isLong =
        cfg.longBreakEvery > 0 && this.consecutive >= cfg.longBreakEvery;
      if (isLong) {
        this.consecutive = 0;
        this.phase = "longBreak";
        this.deadline = Date.now() + cfg.longBreakMinutes * 60000;
      } else if (cfg.breakMinutes > 0) {
        this.phase = "break";
        this.deadline = Date.now() + cfg.breakMinutes * 60000;
      } else {
        this.phase = "idle";
        this.emit();
        this.events.onFocusComplete({ words: delta, isLongBreak: false });
        return;
      }
      this.emit();
      this.events.onFocusComplete({ words: delta, isLongBreak: isLong });
      this.startTicking();
    } else {
      this.phase = "idle";
      this.emit();
      this.events.onBreakComplete();
    }
  }

  private emit(): void {
    this.events.onUpdate(this.getState());
  }
}
