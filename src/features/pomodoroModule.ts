import { Notice } from "obsidian";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import {
  PomodoroTimer,
  type FocusResult,
  type FocusSnapshot,
  type PomodoroConfig,
  type PomodoroLockMode,
  type PomodoroPhase,
  type PomodoroState,
} from "../pomodoro";

export interface PomodoroHistoryEntry {
  count: number;
  words: number;
}

export type PomodoroHistory = Record<string, PomodoroHistoryEntry>;

/** 沉浸 / 海明威两个开关的状态；锁定前记下，解锁时原样恢复。 */
export interface FocusModes {
  immersive: boolean;
  hemingway: boolean;
}

/** data.json 里的 `pomodoroSession`：专注中的番茄钟与锁定，跨重启恢复。 */
export interface PomodoroSession {
  focus: FocusSnapshot;
  lock: PomodoroLockMode;
  lockPath: string | null;
  previousModes: FocusModes | null;
}

/** 长按 Esc 多久触发紧急出口。 */
export const EMERGENCY_HOLD_MS = 1500;

/**
 * 锁定需要的宿主能力（Obsidian 界面、编辑器开关、章纲弹窗）。
 * 由插件注入，模块本身不碰 Workspace / Modal，便于在 Node 里检查。
 */
export interface PomodoroLockEnv {
  /** 最近的正文路径：从侧栏开始番茄时活动视图不是编辑器。 */
  recentMarkdownPath(): string | null;
  getModes(): FocusModes;
  applyModes(modes: FocusModes): void;
  /** 弹出「开始番茄钟」选择；选中后回调。 */
  chooseStart(onPick: (mode: PomodoroLockMode) => void): void;
  /** 二次确认紧急退出。 */
  confirmEmergencyExit(onConfirm: () => void): void;
  /** 活动文档不是 path 时切回去；真的切了返回 true。 */
  enforceFile(path: string): boolean;
  openOutline(path: string): void;
}

/** 校验 data.json 里读到的会话；结构不对就当没有。 */
export function parsePomodoroSession(raw: unknown): PomodoroSession | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const focus = value.focus as Record<string, unknown> | undefined;
  if (
    !focus ||
    typeof focus.deadline !== "number" ||
    typeof focus.pausedRemaining !== "number" ||
    typeof focus.words !== "number" ||
    typeof focus.consecutive !== "number"
  ) {
    return null;
  }
  const lock: PomodoroLockMode =
    value.lock === "immersive" || value.lock === "hemingway" ? value.lock : "none";
  const modes = value.previousModes as Record<string, unknown> | null | undefined;
  return {
    focus: {
      deadline: focus.deadline,
      pausedRemaining: focus.pausedRemaining,
      words: focus.words,
      consecutive: focus.consecutive,
    },
    lock,
    lockPath: typeof value.lockPath === "string" ? value.lockPath : null,
    previousModes:
      modes && typeof modes.immersive === "boolean" && typeof modes.hemingway === "boolean"
        ? { immersive: modes.immersive, hemingway: modes.hemingway }
        : null,
  };
}

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
  /** 桌面端才有锁定与跨重启恢复；手机 / 平板返回 false。 */
  supportsLock(): boolean;
  /** 启动时从 data.json 读到的会话（已校验）。 */
  loadSession(): PomodoroSession | null;
  /** 会话有变化（开始 / 暂停 / 结束 / 锁定变化），请插件择机写盘。 */
  requestSave(): void;
  lockEnv: PomodoroLockEnv;
}

export interface PomodoroOperations {
  start(lock?: PomodoroLockMode): boolean;
  /** 桌面端先选锁定方式再开始；手机端直接开始。 */
  requestStart(): void;
  isLocked(): boolean;
  /** 锁定中被别处改掉了开关：按锁定方式重新套上。 */
  reassertLock(): void;
  openLockedOutline(): void;
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
  /**
   * 写盘用的会话：桌面端返回实时会话（停用后返回停用前最后一份）；
   * 手机端返回 undefined，插件应原样保留读到的值，不覆盖桌面端的会话。
   */
  sessionForPersistence(): PomodoroSession | null | undefined;
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

/** 锁定方式对应的强制开关；海明威自带沉浸。 */
function lockedModes(lock: PomodoroLockMode, previous: FocusModes): FocusModes {
  if (lock === "hemingway") return { immersive: true, hemingway: true };
  return { immersive: true, hemingway: previous.hemingway };
}

/** 锁定中被拒绝时的统一提示（Esc 是键名，保持原样大小写）。 */
export const LOCKED_NOTICE = "锁定中：长按 Esc 可紧急退出";
const RELEASE_ESC_NOTICE = "松开 Esc 打开退出确认";
const SWITCH_NOTICE_GAP_MS = 3000;

/**
 * 番茄钟完整功能模块。
 *
 * 计时器、设置读取、每日番茄历史、自动快照和生命周期都在模块内；状态栏、
 * 手机状态条与侧栏只通过窄操作端口读取状态或触发动作。
 *
 * 锁定（桌面端，SPEC-007）：专注阶段强制沉浸 / 海明威、不能切文档、不能暂停
 * 或结束；到点自动解锁，长按 Esc + 确认可紧急退出（本番茄作废）。专注中的
 * 番茄与锁定一起写进 `pomodoroSession`，重启后按墙钟接着算。
 */
export function createPomodoroModule(
  options: PomodoroModuleOptions
): PomodoroModule {
  let active = false;
  let context: FeatureContext | null = null;
  let timer: PomodoroTimer | null = null;
  let operations: PomodoroOperations | null = null;
  let lock: PomodoroLockMode = "none";
  let lockPath: string | null = null;
  let previousModes: FocusModes | null = null;
  /** 停用前最后一份会话：卸载后写盘仍要带上它，不能当成「没有番茄」。 */
  let finalSession: PomodoroSession | null | undefined = undefined;
  let lastSwitchNotice = 0;
  let escHold: { dispose(): void } | null = null;
  /** 已按够时长，等松开 Esc 再弹确认（按住时的重复 Esc 会立刻关掉弹窗）。 */
  let escArmed = false;

  function requireTimer(): PomodoroTimer {
    if (!active || !timer) throw new Error("番茄钟模块尚未激活");
    return timer;
  }

  function isLocked(): boolean {
    return lock !== "none";
  }

  function currentSession(): PomodoroSession | null {
    const focus = timer?.exportFocus() ?? null;
    if (!focus) return null;
    return { focus, lock, lockPath, previousModes };
  }

  function publishState(): void {
    if (!active || !timer) return;
    options.onStateChange({ ...timer.getState(), lock });
  }

  /**
   * 调宿主界面（切开关、刷新侧栏 / 设置页、切文档）。宿主抛错只记日志：
   * 锁定状态机不能停在一半——曾经因此出现「锁还在、计时没了」「退出锁定后番茄不停」。
   */
  function callEnv<T>(label: string, run: () => T, fallback: T): T {
    try {
      return run();
    } catch (error) {
      console.error(`[Writing Toolkit:pomodoro] ${label}失败`, error);
      return fallback;
    }
  }

  function engageLock(mode: PomodoroLockMode, path: string, previous: FocusModes): void {
    lock = mode;
    lockPath = path;
    previousModes = previous;
    // 先记锁定再切开关：沉浸提示、侧栏开关守卫都要读到「已锁定」。
    callEnv("锁定时切换模式", () => options.lockEnv.applyModes(lockedModes(mode, previous)), undefined);
    callEnv("锁定时切回章节", () => options.lockEnv.enforceFile(path), false);
  }

  function releaseLock(): void {
    if (!isLocked()) return;
    const restore = previousModes;
    lock = "none";
    lockPath = null;
    previousModes = null;
    escHold?.dispose();
    escHold = null;
    escArmed = false;
    if (restore) callEnv("解锁时恢复模式", () => options.lockEnv.applyModes(restore), undefined);
    publishState();
  }

  function reassertLock(): void {
    if (!isLocked() || !previousModes) return;
    const modes = lockedModes(lock, previousModes);
    callEnv("重新套用锁定模式", () => options.lockEnv.applyModes(modes), undefined);
  }

  function emergencyExit(): void {
    if (!active || !timer || !isLocked()) return;
    // 先停计时再解锁：解锁要刷新界面，计时必须先落定。
    // stop() 不记番茄数；正文字数由日统计照常记录。
    timer.stop();
    releaseLock();
    options.requestSave();
    new Notice("已紧急退出锁定，本番茄作废");
  }

  function startWith(mode: PomodoroLockMode): boolean {
    const running = requireTimer();
    if (running.getState().phase !== "idle") {
      new Notice("番茄钟已在进行中");
      return false;
    }
    // 空闲时不该有锁；万一残留（例如恢复失败），开新番茄前先解掉。
    releaseLock();
    const locking = mode !== "none" && options.supportsLock();
    const path = locking ? options.lockEnv.recentMarkdownPath() : null;
    if (locking && !path) {
      new Notice("先打开要写的章节，再开始锁定番茄");
      return false;
    }
    running.start();
    if (locking && path) engageLock(mode, path, options.lockEnv.getModes());
    publishState();
    options.requestSave();
    const minutes = context?.services.settings.get().pomodoroFocusMinutes;
    const label = mode === "hemingway" ? "（锁定海明威）" : mode === "immersive" ? "（锁定沉浸）" : "";
    new Notice(`番茄钟开始：专注 ${minutes} 分钟${label}`);
    return true;
  }

  function enforceLockedFile(): void {
    if (!isLocked() || !lockPath || !context) return;
    const path = lockPath;
    // 推迟到事件派发之后再切回，避免与 Obsidian 自己的切换逻辑互相打架。
    context.events.setTimeout(() => {
      if (!isLocked() || lockPath !== path) return;
      if (!callEnv("切回锁定章节", () => options.lockEnv.enforceFile(path), false)) return;
      const now = Date.now();
      if (now - lastSwitchNotice > SWITCH_NOTICE_GAP_MS) {
        lastSwitchNotice = now;
        new Notice("锁定中，不能切换文档");
      }
    }, 0);
  }

  function handleFocusComplete(result: FocusResult): void {
    if (!active || !context) return;
    releaseLock();
    options.requestSave();
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
      () => options.getWordCount(),
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

  function restoreSession(): void {
    if (!active || !timer) return;
    const session = options.loadSession();
    if (!session) return;
    // 先恢复计时再挂锁：挂锁要刷新界面，界面出错也不能丢掉计时。
    timer.restoreFocus(session.focus);
    const previous = session.previousModes;
    const lockedPath = session.lock !== "none" ? session.lockPath : null;
    if (previous && session.lock !== "none") {
      if (timer.getState().phase === "focus" && lockedPath) {
        engageLock(session.lock, lockedPath, previous);
      } else {
        // 关闭期间已到点：番茄已结算，开关回到锁定前（存盘里还是锁定时的开关）。
        callEnv("恢复锁定前模式", () => options.lockEnv.applyModes(previous), undefined);
      }
    }
    publishState();
    // 挂锁时切开关已触发过一次写盘，那时计时还没恢复；这里补一次。
    options.requestSave();
  }

  /** 长按 Esc：按满时长后提示松开，松开才弹确认；没按够就松开则取消。 */
  function registerEmergencyExit(current: FeatureContext): void {
    current.events.onDom(
      document,
      "keydown",
      (event: KeyboardEvent) => {
        if (event.key !== "Escape" || event.repeat || !isLocked()) return;
        escHold?.dispose();
        escArmed = false;
        escHold = current.events.setTimeout(() => {
          escHold = null;
          if (!isLocked()) return;
          escArmed = true;
          new Notice(RELEASE_ESC_NOTICE);
        }, EMERGENCY_HOLD_MS);
      },
      true
    );
    current.events.onDom(
      document,
      "keyup",
      (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        escHold?.dispose();
        escHold = null;
        if (!escArmed) return;
        escArmed = false;
        if (isLocked()) options.lockEnv.confirmEmergencyExit(() => emergencyExit());
      },
      true
    );
  }

  function registerLockGuards(current: FeatureContext): void {
    current.events.onWorkspace("active-leaf-change", () => enforceLockedFile());
    current.events.onWorkspace("file-open", () => enforceLockedFile());
    current.events.onVault("rename", (file, oldPath) => {
      if (lockPath === oldPath) {
        lockPath = file.path;
        options.requestSave();
      }
    });
    current.events.onVault("delete", (file) => {
      // 锁定的章节被删了：没有可回去的文档，只停掉切换守卫，计时与模式照旧。
      if (lockPath === file.path) {
        lockPath = null;
        options.requestSave();
      }
    });
  }

  return {
    id: "pomodoro",
    activate(current) {
      active = true;
      context = current;
      finalSession = undefined;
      timer = createTimer(current);
      operations = {
        start(mode = "none") {
          return startWith(mode);
        },
        requestStart() {
          if (requireTimer().getState().phase !== "idle") {
            new Notice("番茄钟已在进行中");
            return;
          }
          if (!options.supportsLock()) {
            startWith("none");
            return;
          }
          options.lockEnv.chooseStart((mode) => {
            if (active) startWith(mode);
          });
        },
        isLocked() {
          return active && isLocked();
        },
        reassertLock() {
          reassertLock();
        },
        openLockedOutline() {
          if (lockPath) options.lockEnv.openOutline(lockPath);
        },
        stop() {
          if (isLocked()) {
            new Notice(LOCKED_NOTICE);
            return;
          }
          requireTimer().stop();
          options.requestSave();
          new Notice("番茄钟已结束");
        },
        togglePause() {
          if (isLocked()) {
            new Notice(LOCKED_NOTICE);
            return;
          }
          const running = requireTimer();
          const paused = running.getState().paused;
          running.togglePause();
          options.requestSave();
          new Notice(paused ? "番茄钟已继续" : "番茄钟已暂停");
        },
        skipBreak() {
          requireTimer().skipBreak();
          new Notice("已跳过休息");
        },
        getState() {
          return { ...requireTimer().getState(), lock };
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
        // 停用 / 卸载不是「结束番茄」：先留下会话给最后一次写盘，再停计时。
        if (options.supportsLock() && finalSession === undefined) {
          finalSession = currentSession();
        }
        active = false;
        const currentTimer = timer;
        timer = null;
        operations = null;
        context = null;
        lock = "none";
        lockPath = null;
        previousModes = null;
        escHold = null;
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

      if (options.supportsLock()) {
        registerEmergencyExit(current);
        registerLockGuards(current);
        // 布局就绪后再恢复：此时才拿得到正文计数和锁定的文档。再推迟一拍：
        // 重载插件时布局早已就绪，回调会在模块激活途中同步执行，排在后面的
        // 模块（日历等）还没激活，刷新侧栏会抛错。
        current.events.onLayoutReady(() => {
          current.events.setTimeout(() => restoreSession(), 0);
        });
      }
    },
    deactivate() {
      if (active && options.supportsLock() && finalSession === undefined) {
        finalSession = currentSession();
      }
      active = false;
      timer?.stop();
    },
    get operations() {
      if (!operations) throw new Error("番茄钟模块尚未激活");
      return operations;
    },
    sessionForPersistence() {
      if (!options.supportsLock()) return undefined;
      if (active) return currentSession();
      return finalSession;
    },
  };
}
