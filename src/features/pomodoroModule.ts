import { Notice } from "obsidian";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import {
  PomodoroTimer,
  type FocusResult,
  type PomodoroConfig,
  type PomodoroPhase,
  type PomodoroState,
} from "../pomodoro";

export interface PomodoroHistoryEntry {
  count: number;
  words: number;
}

export type PomodoroHistory = Record<string, PomodoroHistoryEntry>;

export interface PomodoroModuleOptions {
  /** 取焦点无关的最近正文计数，避免侧栏获得焦点时把整章算成番茄增量。 */
  getWordCount(): number;
  getTodayKey(): string;
  getHistory(): PomodoroHistory;
  /** 番茄完成或历史变化后由插件持久化，并刷新依赖今日汇总的 UI。 */
  onHistoryChanged(): void;
  /** 状态栏、侧栏和手机端共享同一份实时状态。 */
  onStateChange(state: PomodoroState): void;
  saveSnapshot(): Promise<void>;
}

export interface PomodoroOperations {
  start(): boolean;
  stop(): void;
  togglePause(): void;
  skipBreak(): void;
  getState(): PomodoroState;
  getPhase(): PomodoroPhase;
  getBaseCount(): number | null;
  adjustBaseCount(delta: number): void;
  rebaseBaseCount(preserveCurrentWords?: boolean): void;
  captureCurrentWords(): void;
  getTodaySummary(): PomodoroHistoryEntry | null;
}

export interface PomodoroModule extends FeatureModule {
  readonly operations: PomodoroOperations;
}

function pomodoroConfig(context: FeatureContext): PomodoroConfig {
  const settings = context.services.settings.get();
  return {
    focusMinutes: settings.pomodoroFocusMinutes,
    breakMinutes: settings.pomodoroBreakMinutes,
    longBreakEvery: settings.pomodoroLongBreakEvery,
    longBreakMinutes: settings.pomodoroLongBreakMinutes,
  };
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * 番茄钟完整功能模块。
 *
 * 计时器、设置读取、每日番茄历史、自动快照和生命周期都在模块内；状态栏、
 * 手机状态条与侧栏只通过窄操作端口读取状态或触发动作。
 */
export function createPomodoroModule(
  options: PomodoroModuleOptions
): PomodoroModule {
  let active = false;
  let context: FeatureContext | null = null;
  let timer: PomodoroTimer | null = null;
  let operations: PomodoroOperations | null = null;

  function requireTimer(): PomodoroTimer {
    if (!active || !timer) throw new Error("番茄钟模块尚未激活");
    return timer;
  }

  function publishState(): void {
    if (!active || !timer) return;
    options.onStateChange(timer.getState());
  }

  function handleFocusComplete(result: FocusResult): void {
    if (!active || !context) return;
    const history = options.getHistory();
    const today = options.getTodayKey();
    const entry = history[today] ?? { count: 0, words: 0 };
    entry.count += 1;
    entry.words += result.words;
    history[today] = entry;
    options.onHistoryChanged();

    if (context.services.settings.get().pomodoroAutoSnapshot) {
      void options.saveSnapshot().catch((error) => {
        console.error("[Writing Toolkit:pomodoro] 番茄完成后保存快照失败", error);
      });
    }
    new Notice(
      `番茄完成！本番茄写了 ${formatNumber(result.words)} 字` +
        (context.services.settings.get().pomodoroAutoSnapshot
          ? "，已自动保存快照"
          : "")
    );
  }

  function createTimer(current: FeatureContext): PomodoroTimer {
    return new PomodoroTimer(
      () => pomodoroConfig(current),
      options.getWordCount,
      {
        onUpdate: () => publishState(),
        onFocusComplete: (result) => handleFocusComplete(result),
        onBreakComplete: () => {
          if (active) new Notice("休息结束，开始下一个番茄吧");
        },
      },
      current.events
    );
  }

  return {
    id: "pomodoro",
    activate(current) {
      active = true;
      context = current;
      timer = createTimer(current);
      operations = {
        start() {
          const started = requireTimer().start();
          new Notice(
            started
              ? `番茄钟开始：专注 ${current.services.settings.get().pomodoroFocusMinutes} 分钟`
              : "番茄钟已在进行中"
          );
          return started;
        },
        stop() {
          requireTimer().stop();
          new Notice("番茄钟已结束");
        },
        togglePause() {
          const running = requireTimer();
          const paused = running.getState().paused;
          running.togglePause();
          new Notice(paused ? "番茄钟已继续" : "番茄钟已暂停");
        },
        skipBreak() {
          requireTimer().skipBreak();
          new Notice("已跳过休息");
        },
        getState() {
          return requireTimer().getState();
        },
        getPhase() {
          return requireTimer().getState().phase;
        },
        getBaseCount() {
          return requireTimer().getBaseCount();
        },
        adjustBaseCount(delta) {
          requireTimer().adjustBaseCount(delta);
        },
        rebaseBaseCount(preserveCurrentWords = false) {
          requireTimer().rebaseBaseCount(preserveCurrentWords);
        },
        captureCurrentWords() {
          requireTimer().captureCurrentWords();
        },
        getTodaySummary() {
          const entry = options.getHistory()[options.getTodayKey()];
          return entry && entry.count > 0 ? entry : null;
        },
      };

      context.effects.add(() => {
        active = false;
        const currentTimer = timer;
        timer = null;
        operations = null;
        context = null;
        currentTimer?.stop();
      });

      context.effects.add(
        context.services.settings.subscribe((change) => {
          if (
            change.keys.some((key) =>
              [
                "pomodoroFocusMinutes",
                "pomodoroBreakMinutes",
                "pomodoroLongBreakEvery",
                "pomodoroLongBreakMinutes",
              ].includes(key)
            )
          ) {
            publishState();
          }
        })
      );

      publishState();
    },
    deactivate() {
      active = false;
      timer?.stop();
    },
    get operations() {
      if (!operations) throw new Error("番茄钟模块尚未激活");
      return operations;
    },
  };
}
