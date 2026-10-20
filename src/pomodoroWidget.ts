import { setIcon } from "obsidian";
import type { PomodoroPhase, PomodoroState } from "./pomodoro";

/**
 * 番茄钟展示组件只依赖窄操作端口，不 import main.ts 或功能模块实现。
 * 端口由工具箱的 UI Shell 上下文注入。
 *
 * 形态：**只有这一枚胶囊**（旧版「展开成环形大卡片」已按设计稿删掉，不再有两种状态）。
 * 左＝环形进度（环心是主操作按钮）· 中＝倒计时 + 细进度条 · 右＝结束当前番茄的圆按钮。
 */
export interface PomodoroWidgetHost {
  getPomodoroState?(): PomodoroState | null;
  startPomodoro?(): void;
  stopPomodoro?(): void;
  togglePomodoroPause?(): void;
  skipPomodoroBreak?(): void;
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 环形进度的几何：viewBox 100×100、半径 46.85、描边 6.3（写在 CSS 里）
 * → 环的外径正好 100，等于整个盒子。
 * 这样 CSS 里环的宽度就等于环的外径，内边距/边距可以照设计稿直接写，
 * 不必再按 viewBox 折算（旧版 130/54 就得每次乘 130/62 才不跑偏）。
 * 描边 ÷ 外径 = 6.3% 是照设计稿量的（外径 76.4、描边 4.85）。
 */
const CIRCLE_RADIUS = 46.85;
const CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS; // ≈ 294.37

export class PomodoroWidget {
  private readonly containerEl: HTMLElement;
  private readonly host: PomodoroWidgetHost;

  private cardEl!: HTMLElement;
  private progressCircle!: SVGCircleElement;
  private ringBtnEl!: HTMLButtonElement;
  private stopBtnEl!: HTMLButtonElement;
  private timeEl!: HTMLElement;
  private fillEl!: HTMLElement;

  private lastPhase: PomodoroPhase | null = null;
  private lastPaused: boolean | null = null;

  constructor(containerEl: HTMLElement, host: PomodoroWidgetHost) {
    this.containerEl = containerEl;
    this.host = host;
    this.render();
  }

  destroy(): void {
    this.cardEl?.remove();
  }

  private render(): void {
    this.cardEl = this.containerEl.createDiv({ cls: "wt-pomo-card" });

    // 1. 环形进度（环心是主操作按钮，随状态在开始/暂停/继续/跳过之间切换）
    const ringWrap = this.cardEl.createDiv({ cls: "wt-pomo-ring-wrap" });

    // 原生 SVG 环
    // 用 Obsidian 的全局 createSvg()（不自动 append，只建元素）；官方审查 prefer-create-el 要求
    const svg = createSvg("svg");
    svg.setAttribute("class", "wt-pomo-ring-svg");
    svg.setAttribute("viewBox", "0 0 100 100");

    // 背景底环
    const bgCircle = createSvg("circle");
    bgCircle.setAttribute("class", "wt-pomo-ring-bg");
    bgCircle.setAttribute("cx", "50");
    bgCircle.setAttribute("cy", "50");
    bgCircle.setAttribute("r", String(CIRCLE_RADIUS));
    svg.appendChild(bgCircle);

    // 进度环：从 12 点起顺时针，长度 = 剩余占比
    this.progressCircle = createSvg("circle");
    this.progressCircle.setAttribute("class", "wt-pomo-ring-progress");
    this.progressCircle.setAttribute("cx", "50");
    this.progressCircle.setAttribute("cy", "50");
    this.progressCircle.setAttribute("r", String(CIRCLE_RADIUS));
    this.progressCircle.setAttribute("stroke-dasharray", String(CIRCUMFERENCE));
    this.progressCircle.setAttribute("stroke-dashoffset", "0");
    svg.appendChild(this.progressCircle);

    ringWrap.appendChild(svg);

    const centerEl = ringWrap.createDiv({ cls: "wt-pomo-ring-center" });
    this.ringBtnEl = centerEl.createEl("button", {
      cls: "wt-pomo-ring-btn",
      attr: { type: "button", "aria-label": "开始专注" },
    });
    this.ringBtnEl.addEventListener("click", () => {
      this.handleRingAction();
    });

    // 2. 胶囊主体：大倒计时 + 细进度条（与环同向，显示剩余占比）
    const compactEl = this.cardEl.createDiv({ cls: "wt-pomo-compact" });
    this.timeEl = compactEl.createDiv({ cls: "wt-pomo-time", text: "25:00" });
    const barEl = compactEl.createDiv({ cls: "wt-pomo-bar" });
    this.fillEl = barEl.createDiv({ cls: "wt-pomo-bar-fill" });

    // 3. 右侧圆按钮：结束当前番茄（空闲时由 CSS 隐藏）
    const actionsEl = this.cardEl.createDiv({ cls: "wt-pomo-actions" });
    const stopBtn = actionsEl.createEl("button", {
      cls: "wt-pomo-round-btn",
      attr: { type: "button", "aria-label": "结束专注" },
    });
    this.stopBtnEl = stopBtn;
    setIcon(stopBtn, "wt-stop");
    stopBtn.addEventListener("click", () => {
      this.host.stopPomodoro?.();
    });

    // 初始渲染当前状态
    this.update();
  }

  /** 环心按钮：空闲开始、专注暂停/继续、休息跳过。 */
  private handleRingAction(): void {
    const phase = this.host.getPomodoroState?.()?.phase ?? "idle";
    if (phase === "focus") {
      this.host.togglePomodoroPause?.();
      return;
    }
    if (phase === "break" || phase === "longBreak") {
      this.host.skipPomodoroBreak?.();
      return;
    }
    this.host.startPomodoro?.();
  }

  update(state?: PomodoroState): void {
    const s = state ?? this.host.getPomodoroState?.() ?? {
      phase: "idle",
      totalMs: 25 * 60000,
      remainingMs: 25 * 60000,
      words: 0,
      paused: false,
    };

    // 1. 进度圈：长度 = 剩余占比（空闲时整圈都是底轨色）
    const total = s.totalMs > 0 ? s.totalMs : 25 * 60000;
    const progress = Math.max(0, Math.min(1, s.remainingMs / total));
    const offset = s.phase === "idle" ? 0 : CIRCUMFERENCE * (1 - progress);
    this.progressCircle.style.strokeDashoffset = String(offset);

    // 2. 状态类（颜色全在 CSS 里按 is-* 走主题令牌）
    this.cardEl.removeClass("is-focus", "is-break", "is-long-break", "is-idle", "is-paused");
    this.cardEl.addClass(`is-${s.phase === "longBreak" ? "long-break" : s.phase}`);
    if (s.paused) this.cardEl.addClass("is-paused");

    // 3. 文案与细条：时间、剩余占比
    const remainingText = formatDuration(s.remainingMs);
    this.timeEl.setText(remainingText);
    this.fillEl.style.width = `${Math.round(progress * 100)}%`;

    // 4. 无障碍：旧版的「专注中 · 已暂停」文字没了，状态改由胶囊整体播报
    let label = "番茄钟空闲";
    if (s.phase === "focus") label = s.paused ? "专注已暂停" : "专注中";
    else if (s.phase === "break") label = s.paused ? "休息暂停" : "休息中";
    else if (s.phase === "longBreak") label = s.paused ? "休息暂停" : "深度休息";
    this.cardEl.setAttr("role", "group");
    this.cardEl.setAttr("aria-label", `${label}，剩余 ${remainingText}`);

    // 5. 锁定中（SPEC-007）暂停 / 结束都不可用
    const locked = s.phase === "focus" && (s.lock ?? "none") !== "none";
    this.ringBtnEl.disabled = locked;
    this.stopBtnEl.disabled = locked;

    // 6. 环心按钮的图标与语义（只在状态真的变了时重建，避免每帧动 DOM）
    if (this.lastPhase !== s.phase || this.lastPaused !== s.paused) {
      this.lastPhase = s.phase;
      this.lastPaused = s.paused;
      this.renderRingAction(s);
    }
  }

  /** 环心图标：开始▶ / 暂停⏸ / 继续▶ / 休息跳过⏭ —— 图标语义必须与动作一致。 */
  private renderRingAction(state: PomodoroState): void {
    let icon = "wt-play";
    let label = "开始专注";
    if (state.phase === "focus") {
      icon = state.paused ? "wt-play" : "wt-pause";
      label = state.paused ? "继续专注" : "暂停专注";
    } else if (state.phase === "break" || state.phase === "longBreak") {
      icon = "wt-skip";
      label = "跳过休息";
    }
    this.ringBtnEl.empty();
    setIcon(this.ringBtnEl, icon);
    this.ringBtnEl.setAttr("aria-label", label);
  }
}
