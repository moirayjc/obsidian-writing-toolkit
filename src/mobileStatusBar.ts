import { MarkdownView, Menu, Notice } from "obsidian";
import { TextPromptModal } from "./promptModal";
import { isMobileUI, showMenuAt } from "./mobile";
import type { PomodoroState } from "./pomodoro";
import type { UiShellContext } from "./uiShellContext";
import type { EventScope, TimerHandle } from "./services/eventsService";

/**
 * 手机端常驻状态条。
 *
 * Obsidian 手机版没有桌面那样的状态栏，写正文时看不到今日进度与番茄钟。
 * 这里在屏幕底部放一枚轻量药丸（只在手机端、且正在看正文时出现）：
 * 进度条 + 「今日/目标」+ 番茄数；点一下弹出操作菜单。
 * 阅读 / 编辑正文以外的界面（主页、编辑台、工具箱）不显示，避免和那些界面自带的数字重复。
 */
export class MobileStatusBar {
  private readonly host: UiShellContext;
  private readonly events: EventScope;
  private el!: HTMLElement;
  private fillEl!: HTMLElement;
  private goalEl!: HTMLElement;
  private pomoEl!: HTMLElement;
  private timer: TimerHandle | null = null;
  private shown = false;

  constructor(host: UiShellContext, events: EventScope) {
    this.host = host;
    this.events = events;
  }

  mount(): void {
    this.el = document.body.createDiv({ cls: "wt-mbar" });
    this.el.addEventListener("click", () => this.openMenu());

    const track = this.el.createDiv({ cls: "wt-mbar-track" });
    this.fillEl = track.createDiv({ cls: "wt-mbar-fill" });
    this.goalEl = this.el.createSpan({ cls: "wt-mbar-goal" });
    this.pomoEl = this.el.createSpan({ cls: "wt-mbar-pomo" });

    this.events.onWorkspace("active-leaf-change", () => this.sync());
    this.events.onWorkspace("layout-change", () => this.sync());
    // 数字每秒跟着番茄钟 / 今日统计走；`sync` 里会顺带决定要不要显示。
    this.timer = this.events.setInterval(() => this.sync(), 1000);
    this.sync();
  }

  destroy(): void {
    this.timer?.dispose();
    this.timer = null;
    this.events.dispose();
    this.el?.remove();
  }

  /** 设置里关掉后立即隐藏。 */
  syncVisibility(): void {
    this.sync();
  }

  private shouldShow(): boolean {
    if (!isMobileUI()) return false;
    if (this.host.settings.mobileStatusBar === false) return false;
    // 只在看正文时出现：其余界面（主页 / 编辑台 / 工具箱）自己就有这些数字。
    return !!this.host.app.workspace.getActiveViewOfType(MarkdownView);
  }

  private sync(): void {
    const show = this.shouldShow();
    if (show !== this.shown) {
      this.shown = show;
      this.el.toggleClass("is-on", show);
    }
    if (!show) return;

    const goal = Math.max(1, this.host.settings.dailyGoal);
    const net = this.host.stats.total();
    const pct = Math.min(100, Math.max(0, (net / goal) * 100));
    this.fillEl.style.width = `${pct}%`;
    this.el.toggleClass("is-done", net >= goal);
    this.goalEl.setText(`${formatNumber(net)} / ${formatNumber(goal)}`);

    const state = this.host.caps.pomodoro.getPomodoroState();
    const pomoText = this.pomodoroText(state);
    this.pomoEl.setText(pomoText);
    this.pomoEl.toggleClass("is-hidden", !pomoText);

    const entry = this.host.stats.getTodayPomodoroSummary();
    this.el.setAttr(
      "title",
      `今日净增 ${formatNumber(net)} 字 · 目标 ${formatNumber(goal)} 字` +
        (entry ? ` · 番茄 ${entry.count} 个 / ${formatNumber(entry.words)} 字` : "")
    );
  }

  /** 药丸上的番茄段：空闲且今天写过番茄就显示个数，计时中显示倒计时。 */
  private pomodoroText(state: PomodoroState | null): string {
    if (state && state.phase !== "idle") {
      const mark = state.paused ? "⏸" : "";
      if (state.phase === "focus") {
        return `🍅${mark}${clock(state.remainingMs)}`;
      }
      return `${state.phase === "longBreak" ? "长休" : "休"}${mark}${clock(
        state.remainingMs
      )}`;
    }
    const entry = this.host.stats.getTodayPomodoroSummary();
    return entry && entry.count > 0 ? `🍅 ${entry.count}` : "";
  }

  private openMenu(): void {
    const rect = this.el.getBoundingClientRect();
    const pt = { x: rect.left + rect.width / 2, y: rect.top };
    const state = this.host.caps.pomodoro.getPomodoroState();
    const entry = this.host.stats.getTodayPomodoroSummary();

    const menu = new Menu();
    const net = Math.max(0, this.host.stats.total());
    menu.addItem((item) =>
      item
        .setTitle(
          `今日净增 ${formatNumber(net)} 字（新增为正，删除为负）`
        )
        .setDisabled(true)
    );
    if (entry) {
      menu.addItem((item) =>
        item
          .setTitle(`今日 ${entry.count} 个番茄 · ${formatNumber(entry.words)} 字`)
          .setDisabled(true)
      );
    }
    menu.addSeparator();

    if (!state || state.phase === "idle") {
      menu.addItem((item) =>
        item
          .setTitle("开始番茄钟")
          .onClick(() => this.host.caps.pomodoro.startPomodoro())
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle(state.paused ? "继续番茄钟" : "暂停番茄钟")
          .onClick(() => this.host.caps.pomodoro.togglePomodoroPause())
      );
      if (state.phase === "break" || state.phase === "longBreak") {
        menu.addItem((item) =>
          item
            .setTitle("跳过休息")
            .onClick(() => this.host.caps.pomodoro.skipPomodoroBreak())
        );
      }
      menu.addItem((item) =>
        item
          .setTitle("结束番茄钟")
          .onClick(() => this.host.caps.pomodoro.stopPomodoro())
      );
    }
    menu.addItem((item) =>
      item.setTitle("修改每日目标…").onClick(() => this.promptGoal())
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("打开书桌")
        .onClick(() => void this.host.nav.openHome())
    );
    menu.addItem((item) =>
      item
        .setTitle("打开工具箱")
        .onClick(() => void this.host.nav.openSidebar())
    );
    showMenuAt(menu, pt);
  }

  private promptGoal(): void {
    const current = this.host.settings.dailyGoal;
    new TextPromptModal(
      this.host.app,
      "设置每日目标字数",
      String(current),
      (input) => {
        const num = parseInt(input, 10);
        if (Number.isNaN(num) || num <= 0) {
          new Notice("请输入大于 0 的数字");
          return;
        }
        this.host.settings.dailyGoal = num;
        void this.host.actions.saveSettings();
        this.host.nav.refreshHome();
        this.sync();
      }
    ).open();
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
