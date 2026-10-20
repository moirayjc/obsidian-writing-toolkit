/**
 * 番茄钟锁定检查（SPEC-007）。
 *
 * 编译真实的 pomodoroModule.ts + pomodoro.ts，用假时钟、假事件作用域和假锁定环境跑：
 * 开始锁定、拒绝暂停 / 结束、切文档切回、长按 Esc 紧急退出作废、到点解锁、
 * 停用后仍保留会话、重启恢复 / 过期结算、手机端完全不碰锁定、坏数据丢弃、改名跟随。
 *
 * 反向验证：把 handleFocusComplete 开头的 releaseLock() 去掉，场景 6 变红；
 * 把停用清理里的 finalSession 赋值去掉，场景 7 变红。
 */
const H = require("./_harness");

function createClock() {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  return {
    advance(ms) {
      now += ms;
    },
    get now() {
      return now;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

function createContext() {
  const cleanups = [];
  const timeouts = [];
  const intervals = new Set();
  const dom = {};
  const workspace = {};
  const vault = {};
  const layoutReady = [];
  const settings = {
    pomodoroFocusMinutes: 1,
    pomodoroBreakMinutes: 0,
    pomodoroLongBreakEvery: 4,
    pomodoroLongBreakMinutes: 15,
    pomodoroAutoSnapshot: false,
  };
  const context = {
    app: {},
    services: {
      settings: {
        get: () => settings,
        subscribe: () => () => undefined,
      },
    },
    events: {
      setInterval(callback) {
        const handle = { callback, dispose: () => intervals.delete(handle) };
        intervals.add(handle);
        return handle;
      },
      setTimeout(callback, delay) {
        const handle = { callback, delay, disposed: false, dispose() { this.disposed = true; } };
        timeouts.push(handle);
        return handle;
      },
      onDom(_target, event, listener) {
        dom[event] = listener;
        return { dispose() {} };
      },
      onWorkspace(event, listener) {
        workspace[event] = listener;
        return { dispose() {} };
      },
      onVault(event, listener) {
        vault[event] = listener;
        return { dispose() {} };
      },
      onLayoutReady(listener) {
        layoutReady.push(listener);
        return { dispose() {} };
      },
    },
    effects: {
      add(cleanup) {
        cleanups.push(cleanup);
        return cleanup;
      },
      dispose() {
        while (cleanups.length) cleanups.pop()();
      },
    },
  };
  return {
    context,
    dom,
    workspace,
    vault,
    /** 跑完所有到期的一次性定时器（按登记顺序）；maxDelay 以内才跑。 */
    flushTimeouts(maxDelay = Infinity) {
      for (const t of timeouts.splice(0)) {
        if (t.disposed) continue;
        if (t.delay <= maxDelay) t.callback();
        else timeouts.push(t);
      }
    },
    pendingTimeouts: () => timeouts.filter((t) => !t.disposed),
    tick() {
      for (const handle of [...intervals]) handle.callback();
    },
    ready() {
      for (const listener of layoutReady.splice(0)) listener();
    },
  };
}

function createEnv(overrides = {}) {
  const env = {
    recentPath: "作品甲/第1章.md",
    modes: { immersive: false, hemingway: false },
    applied: [],
    enforced: [],
    enforceResult: false,
    picks: null,
    confirms: [],
    outlines: [],
    recentMarkdownPath() {
      return env.recentPath;
    },
    getModes() {
      return { ...env.modes };
    },
    applyModes(modes) {
      env.modes = { ...modes };
      env.applied.push({ ...modes });
    },
    chooseStart(onPick) {
      env.picks = onPick;
    },
    confirmEmergencyExit(onConfirm) {
      env.confirms.push(onConfirm);
    },
    enforceFile(path) {
      env.enforced.push(path);
      return env.enforceResult;
    },
    openOutline(path) {
      env.outlines.push(path);
    },
    ...overrides,
  };
  return env;
}

function main() {
  const notices = [];
  class Notice {
    constructor(message) {
      notices.push(message);
    }
  }
  const restoreObsidian = H.stubObsidian({ Notice });
  let mod;
  try {
    mod = H.compile("src/features/pomodoroModule.ts", "pomodoro-lock");
  } finally {
    restoreObsidian();
  }
  const { createPomodoroModule, parsePomodoroSession, EMERGENCY_HOLD_MS } = mod;
  global.document = {};
  const clock = createClock();
  const r = H.createReporter("番茄钟锁定（SPEC-007）");

  function setup({ desktop = true, session = null, env = createEnv() } = {}) {
    const harness = createContext();
    const history = {};
    let words = 100;
    let saves = 0;
    let loads = 0;
    const module = createPomodoroModule({
      getWordCount: () => words,
      getTodayKey: () => "2026-10-20",
      getHistory: () => history,
      onHistoryChanged() {},
      onStateChange() {},
      async saveSnapshot() {},
      supportsLock: () => desktop,
      loadSession: () => {
        loads++;
        return session;
      },
      requestSave: () => {
        saves++;
      },
      lockEnv: env,
    });
    module.activate(harness.context);
    harness.ready();
    // 恢复推迟一拍：布局就绪回调里不能同步动界面（后面的模块可能还没激活）。
    const restoredSynchronously = module.operations.getPhase() !== "idle";
    harness.flushTimeouts(0);
    return {
      restoredSynchronously,
      module,
      ops: module.operations,
      env,
      harness,
      history,
      setWords: (n) => {
        words = n;
      },
      saves: () => saves,
      loads: () => loads,
    };
  }

  try {
    // 1. 桌面端开始：先弹选择，选「锁定海明威」后强制两个开关并锁住当前章节。
    let t = setup();
    t.ops.requestStart();
    const chose = typeof t.env.picks === "function" && t.ops.getPhase() === "idle";
    t.env.picks("hemingway");
    r.check(
      "1. 桌面端开始先选方式；锁定海明威 → 沉浸 + 海明威强制开启、锁住当前章节",
      chose &&
        t.ops.getPhase() === "focus" &&
        t.ops.isLocked() &&
        t.ops.getState().lock === "hemingway" &&
        t.env.modes.immersive && t.env.modes.hemingway &&
        t.env.enforced[0] === "作品甲/第1章.md" &&
        t.saves() > 0
    );

    // 2. 锁定中暂停、结束都被拒绝。
    t.ops.togglePause();
    t.ops.stop();
    r.check(
      "2. 锁定中暂停 / 结束无效",
      t.ops.getPhase() === "focus" && !t.ops.getState().paused && t.ops.isLocked()
    );

    // 3. 切文档：工作区事件推迟一拍后要求切回锁定的章节。
    t.env.enforced.length = 0;
    t.env.enforceResult = true;
    t.harness.workspace["active-leaf-change"]();
    t.harness.workspace["file-open"]();
    t.harness.flushTimeouts(0);
    r.check(
      "3. 切换文档 → 切回锁定的章节，并提示",
      t.env.enforced.length === 2 &&
        t.env.enforced.every((p) => p === "作品甲/第1章.md") &&
        notices.includes("锁定中，不能切换文档")
    );

    // 4. 长按 Esc：没按够就松开不触发；按够弹确认，确认后作废、恢复模式。
    t.harness.dom.keydown({ key: "Escape", repeat: false });
    t.harness.dom.keyup({ key: "Escape" });
    t.harness.flushTimeouts();
    const shortPressIgnored = t.env.confirms.length === 0;
    t.harness.dom.keydown({ key: "Escape", repeat: false });
    const holdDelay = t.harness.pendingTimeouts().map((x) => x.delay);
    t.harness.flushTimeouts();
    // 按住期间的重复 Esc 会关掉弹窗：按够时只提示，松开才弹确认。
    const notWhileHeld = t.env.confirms.length === 0;
    t.harness.dom.keydown({ key: "Escape", repeat: true });
    t.harness.dom.keyup({ key: "Escape" });
    const prompted = t.env.confirms.length === 1;
    t.env.confirms[0]();
    r.check(
      "4. 短按 Esc 不触发；长按 " + EMERGENCY_HOLD_MS + "ms 后松开才弹确认 → 作废并恢复锁定前模式",
      shortPressIgnored &&
        holdDelay.includes(EMERGENCY_HOLD_MS) &&
        notWhileHeld &&
        prompted &&
        t.ops.getPhase() === "idle" &&
        !t.ops.isLocked() &&
        !t.history["2026-10-20"] &&
        !t.env.modes.immersive && !t.env.modes.hemingway
    );

    // 5. 没有可锁定的章节：拒绝锁定，番茄不开始。
    t = setup({ env: createEnv({ recentPath: null }) });
    t.ops.requestStart();
    t.env.picks("immersive");
    r.check("5. 没打开章节时拒绝锁定，番茄不开始", t.ops.getPhase() === "idle" && !t.ops.isLocked());

    // 6. 到点：计入番茄、自动解锁、模式恢复（锁沉浸时保留原来的海明威状态）。
    t = setup();
    t.env.modes = { immersive: false, hemingway: false };
    t.ops.requestStart();
    t.env.picks("immersive");
    const lockedImmersiveOnly = t.env.modes.immersive && !t.env.modes.hemingway;
    t.setWords(130);
    clock.advance(61_000);
    t.harness.tick();
    r.check(
      "6. 专注到点 → 计入番茄与字数、自动解锁、模式恢复",
      lockedImmersiveOnly &&
        t.history["2026-10-20"]?.count === 1 &&
        t.history["2026-10-20"]?.words === 30 &&
        !t.ops.isLocked() &&
        !t.env.modes.immersive
    );

    // 7. 停用 / 卸载：会话留给最后一次写盘。
    t = setup();
    t.ops.requestStart();
    t.env.picks("hemingway");
    t.setWords(110);
    const live = t.module.sessionForPersistence();
    t.module.deactivate();
    t.harness.context.effects.dispose();
    const kept = t.module.sessionForPersistence();
    r.check(
      "7. 停用后仍返回停用前的会话（锁定、章节、字数、原模式都在）",
      live?.lock === "hemingway" &&
        kept?.lock === "hemingway" &&
        kept.lockPath === "作品甲/第1章.md" &&
        kept.focus.words === 10 &&
        kept.previousModes?.immersive === false
    );

    // 8. 重启恢复：布局就绪后接着锁、接着算。
    const session = parsePomodoroSession(JSON.parse(JSON.stringify(kept)));
    clock.advance(20_000);
    const env8 = createEnv({ modes: { immersive: true, hemingway: true } });
    t = setup({ session, env: env8 });
    const remaining = t.ops.getState().remainingMs;
    r.check(
      "8. 重启后恢复锁定与计时（推迟到布局就绪后一拍；剩余时间按墙钟、字数接着累计）",
      !t.restoredSynchronously &&
        t.ops.isLocked() &&
        t.ops.getPhase() === "focus" &&
        remaining <= 40_000 && remaining > 39_000 &&
        t.ops.getState().words === 10 &&
        env8.enforced[0] === "作品甲/第1章.md"
    );

    // 9. 关闭期间已到点：恢复时直接结算并解锁，模式回到锁定前。
    clock.advance(120_000);
    const env9 = createEnv({ modes: { immersive: true, hemingway: true } });
    t = setup({ session, env: env9 });
    r.check(
      "9. 关闭期间到点 → 启动即结算、解锁、恢复模式",
      t.history["2026-10-20"]?.count === 1 &&
        !t.ops.isLocked() &&
        !env9.modes.immersive && !env9.modes.hemingway
    );

    // 10. 手机端：不弹选择、不读不写会话、没有长按监听。
    t = setup({ desktop: false, session });
    t.ops.requestStart();
    r.check(
      "10. 手机 / 平板：直接开始不锁定，不读会话，写盘保留原值",
      t.env.picks === null &&
        t.ops.getPhase() === "focus" &&
        !t.ops.isLocked() &&
        t.loads() === 0 &&
        t.module.sessionForPersistence() === undefined &&
        !t.harness.dom.keydown
    );

    // 11. 坏数据丢弃。
    r.check(
      "11. data.json 里结构不对的会话被丢弃",
      parsePomodoroSession(null) === null &&
        parsePomodoroSession({ focus: { deadline: "x" } }) === null &&
        parsePomodoroSession({ lock: "hemingway" }) === null
    );

    // 12. 锁定的章节改名：跟着新路径走；锁定中可以打开本章章纲。
    t = setup();
    t.ops.requestStart();
    t.env.picks("immersive");
    t.harness.vault.rename({ path: "作品甲/第一章.md" }, "作品甲/第1章.md");
    t.ops.openLockedOutline();
    r.check(
      "12. 锁定章节改名后跟随新路径；章纲入口打开本章",
      t.module.sessionForPersistence()?.lockPath === "作品甲/第一章.md" &&
        t.env.outlines[0] === "作品甲/第一章.md"
    );

    // 13. 宿主界面抛错（切开关 / 刷新侧栏）：计时与锁定状态不能停在一半。
    const throwing = () =>
      createEnv({
        applyModes() {
          throw new Error("界面刷新失败");
        },
      });
    const consoleError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(" "));
    try {
      clock.advance(1_000);
      const fresh = parsePomodoroSession({
        focus: { deadline: clock.now + 30_000, pausedRemaining: 0, words: 5, consecutive: 0 },
        lock: "hemingway",
        lockPath: "作品甲/第1章.md",
        previousModes: { immersive: false, hemingway: false },
      });
      const restored = setup({ session: fresh, env: throwing() });
      const restoredOk = restored.ops.getPhase() === "focus" && restored.ops.isLocked();
      restored.harness.dom.keydown({ key: "Escape", repeat: false });
      restored.harness.flushTimeouts();
      restored.harness.dom.keyup({ key: "Escape" });
      restored.env.confirms[0]();
      r.check(
        "13. 宿主切换模式抛错：重启仍恢复计时与锁定；紧急退出仍结束番茄并解锁；错误带模块前缀记日志",
        restoredOk &&
          restored.ops.getPhase() === "idle" &&
          !restored.ops.isLocked() &&
          logged.some((line) => line.includes("[Writing Toolkit:pomodoro]"))
      );
    } finally {
      console.error = consoleError;
    }
  } finally {
    clock.restore();
    delete global.document;
  }

  return r.finish();
}

try {
  const ok = main();
  H.cleanup();
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error("运行失败：" + error.stack);
  H.cleanup();
  process.exit(2);
}
