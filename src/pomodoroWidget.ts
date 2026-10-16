import { setIcon } from "obsidian";
import type { PomodoroPhase, PomodoroState } from "./pomodoro";

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

const CIRCLE_RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS; // ~339.292

export class PomodoroWidget {
  private readonly containerEl: HTMLElement;
  private readonly plugin: any;

  private cardEl!: HTMLElement;
  private statusDotEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private todayStatEl!: HTMLElement;
  private progressCircle!: SVGCircleElement;
  private timeEl!: HTMLElement;
  private actionsEl!: HTMLElement;

  private lastPhase: PomodoroPhase | null = null;
  private lastPaused: boolean | null = null;

  constructor(containerEl: HTMLElement, plugin: any) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.render();
  }

  destroy(): void {
    this.cardEl?.remove();
  }

  private render(): void {
    this.cardEl = this.containerEl.createDiv({ cls: "wt-pomo-card" });

    // 1. 卡头：标题 + 今日番茄小结（与主页卡片标题同一套）
    const headEl = this.cardEl.createDiv({ cls: "wt-tb-card-title" });
    headEl.createSpan({ text: "专注" });
    this.todayStatEl = headEl.createSpan({ cls: "wt-tb-card-aside" });

    // 2. 环形进度圈与正中倒计时
    const ringWrap = this.cardEl.createDiv({ cls: "wt-pomo-ring-wrap" });

    // 原生 SVG 环
    // 用 Obsidian 的全局 createSvg()（不自动 append，只建元素）；官方审查 prefer-create-el 要求
    const svg = createSvg("svg");
    svg.setAttribute("class", "wt-pomo-ring-svg");
    svg.setAttribute("viewBox", "0 0 130 130");

    // 背景底环
    const bgCircle = createSvg("circle");
    bgCircle.setAttribute("class", "wt-pomo-ring-bg");
    bgCircle.setAttribute("cx", "65");
    bgCircle.setAttribute("cy", "65");
    bgCircle.setAttribute("r", String(CIRCLE_RADIUS));
    svg.appendChild(bgCircle);

    // 进度环
    this.progressCircle = createSvg("circle");
    this.progressCircle.setAttribute("class", "wt-pomo-ring-progress");
    this.progressCircle.setAttribute("cx", "65");
    this.progressCircle.setAttribute("cy", "65");
    this.progressCircle.setAttribute("r", String(CIRCLE_RADIUS));
    this.progressCircle.setAttribute("stroke-dasharray", String(CIRCUMFERENCE));
    this.progressCircle.setAttribute("stroke-dashoffset", "0");
    svg.appendChild(this.progressCircle);

    ringWrap.appendChild(svg);

    // 环中央：大倒计时 + 状态（色点 + 文字）
    const centerEl = ringWrap.createDiv({ cls: "wt-pomo-ring-center" });
    this.timeEl = centerEl.createDiv({ cls: "wt-pomo-time", text: "25:00" });
    const stateEl = centerEl.createDiv({ cls: "wt-pomo-state" });
    this.statusDotEl = stateEl.createSpan({ cls: "wt-pomo-status-dot" });
    this.statusTextEl = stateEl.createSpan({ cls: "wt-pomo-subtitle", text: "空闲" });

    // 3. 操作按钮区
    this.actionsEl = this.cardEl.createDiv({ cls: "wt-pomo-actions" });

    // 初始渲染当前状态
    this.update();
  }

  update(state?: PomodoroState): void {
    const s = state ?? this.plugin.getPomodoroState?.() ?? {
      phase: "idle",
      totalMs: 25 * 60000,
      remainingMs: 25 * 60000,
      words: 0,
      paused: false,
    };

    // 1. 进度圈更新
    const total = s.totalMs > 0 ? s.totalMs : 25 * 60000;
    const progress = Math.max(0, Math.min(1, s.remainingMs / total));

    // 计算 dashoffset（从完全充满到耗尽）
    let offset: number;
    if (s.phase === "idle") {
      offset = 0;
    } else {
      offset = CIRCUMFERENCE * (1 - progress);
    }
    this.progressCircle.style.strokeDashoffset = String(offset);

    // 2. 状态标签与色彩更新
    this.cardEl.removeClass("is-focus", "is-break", "is-long-break", "is-idle", "is-paused");
    this.cardEl.addClass(`is-${s.phase === "longBreak" ? "long-break" : s.phase}`);
    if (s.paused) this.cardEl.addClass("is-paused");

    // 状态文字：环内只留状态本身，字数并进同一行
    let statusText = "空闲";

    if (s.phase === "focus") {
      statusText = s.paused
        ? "已暂停"
        : s.words > 0
          ? `专注中 · +${formatNumber(s.words)}`
          : "专注中";
    } else if (s.phase === "break") {
      statusText = s.paused ? "休息暂停" : "休息中";
    } else if (s.phase === "longBreak") {
      statusText = s.paused ? "休息暂停" : "深度休息";
    }

    this.statusTextEl.setText(statusText);
    this.timeEl.setText(formatDuration(s.remainingMs));

    // 3. 今日番茄汇总统计（卡头右侧）
    const summary = this.plugin.getTodayPomodoroSummary?.() ?? null;
    if (summary && summary.count > 0) {
      this.todayStatEl.setText(`今日 ${summary.count} 个 · ${formatNumber(summary.words)} 字`);
    } else {
      this.todayStatEl.setText("今日 0 个");
    }

    // 4. 按钮状态切换（若状态或暂停有变化，或按钮区尚未挂载）
    if (this.lastPhase !== s.phase || this.lastPaused !== s.paused || this.actionsEl.children.length === 0) {
      this.lastPhase = s.phase;
      this.lastPaused = s.paused;
      this.renderActions(s);
    }
  }

  private renderActions(state: PomodoroState): void {
    this.actionsEl.empty();

    if (state.phase === "idle") {
      const startBtn = this.actionsEl.createEl("button", {
        cls: "wt-pomo-btn wt-pomo-btn-primary wt-pomo-start-full",
      });
      const iconSpan = startBtn.createSpan({ cls: "wt-pomo-btn-icon" });
      setIcon(iconSpan, "play");
      startBtn.createSpan({ text: "开始专注" });
      startBtn.addEventListener("click", () => {
        this.plugin.startPomodoro?.();
      });
    } else if (state.phase === "focus") {
      const pauseBtn = this.actionsEl.createEl("button", {
        cls: "wt-pomo-btn wt-pomo-btn-secondary",
      });
      const pauseIcon = pauseBtn.createSpan({ cls: "wt-pomo-btn-icon" });
      setIcon(pauseIcon, state.paused ? "play" : "pause");
      pauseBtn.createSpan({ text: state.paused ? "继续" : "暂停" });
      pauseBtn.addEventListener("click", () => {
        this.plugin.togglePomodoroPause?.();
      });

      const stopBtn = this.actionsEl.createEl("button", {
        cls: "wt-pomo-btn wt-pomo-btn-danger",
      });
      const stopIcon = stopBtn.createSpan({ cls: "wt-pomo-btn-icon" });
      setIcon(stopIcon, "square");
      stopBtn.createSpan({ text: "结束" });
      stopBtn.addEventListener("click", () => {
        this.plugin.stopPomodoro?.();
      });
    } else {
      const skipBtn = this.actionsEl.createEl("button", {
        cls: "wt-pomo-btn wt-pomo-btn-secondary",
      });
      const skipIcon = skipBtn.createSpan({ cls: "wt-pomo-btn-icon" });
      setIcon(skipIcon, "skip-forward");
      skipBtn.createSpan({ text: "跳过休息" });
      skipBtn.addEventListener("click", () => {
        this.plugin.skipPomodoroBreak?.();
      });

      const stopBtn = this.actionsEl.createEl("button", {
        cls: "wt-pomo-btn wt-pomo-btn-danger",
      });
      const stopIcon = stopBtn.createSpan({ cls: "wt-pomo-btn-icon" });
      setIcon(stopIcon, "square");
      stopBtn.createSpan({ text: "结束" });
      stopBtn.addEventListener("click", () => {
        this.plugin.stopPomodoro?.();
      });
    }
  }
}
