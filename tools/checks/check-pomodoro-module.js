/**
 * 番茄钟 Feature Module 检查。
 *
 * 用模块自己的 EventScope 定时器、设置订阅和番茄历史验证：计时状态、
 * 最近文档字数适配、长休息、自动快照、设置热更新和销毁清理都由模块持有。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

async function main() {
  const notices = [];
  class Notice {
    constructor(message) {
      notices.push(message);
    }
  }

  const restoreObsidian = H.stubObsidian({ Notice });
  let createPomodoroModule;
  try {
    ({ createPomodoroModule } = H.compile(
      "src/features/pomodoroModule.ts",
      "pomodoro-module"
    ));
  } finally {
    restoreObsidian();
  }

  const r = H.createReporter("番茄钟 Feature Module");
  const settings = {
    pomodoroFocusMinutes: 1,
    pomodoroBreakMinutes: 0,
    pomodoroLongBreakEvery: 3,
    pomodoroLongBreakMinutes: 15,
    pomodoroAutoSnapshot: false,
  };
  let settingsListener = null;
  let settingsUnsubscriptions = 0;
  const publishSettings = (...keys) => {
    settingsListener?.({
      keys,
      previous: settings,
      current: settings,
    });
  };

  const cleanups = [];
  const effects = {
    add(cleanup) {
      cleanups.push(cleanup);
      return cleanup;
    },
    dispose() {
      while (cleanups.length) cleanups.pop()();
    },
  };
  const intervals = new Set();
  let latestInterval = null;
  const context = {
    app: {},
    services: {
      settings: {
        get() {
          return settings;
        },
        subscribe(listener) {
          settingsListener = listener;
          return () => {
            settingsUnsubscriptions++;
            settingsListener = null;
          };
        },
      },
    },
    events: {
      setInterval(callback, delayMs) {
        const interval = {
          callback,
          delayMs,
          disposed: false,
          dispose() {
            if (this.disposed) return;
            this.disposed = true;
            intervals.delete(this);
          },
        };
        intervals.add(interval);
        latestInterval = interval;
        return interval;
      },
    },
    effects,
  };

  const history = {};
  let wordCount = 100;
  let historyChanges = 0;
  let snapshotSaves = 0;
  const states = [];
  const module = createPomodoroModule({
    getWordCount() {
      return wordCount;
    },
    getTodayKey() {
      return "2026-10-17";
    },
    getHistory() {
      return history;
    },
    onHistoryChanged() {
      historyChanges++;
    },
    onStateChange(state) {
      states.push(state);
    },
    async saveSnapshot() {
      snapshotSaves++;
    },
  });

  let inactiveRejected = false;
  try {
    module.operations.getState();
  } catch {
    inactiveRejected = true;
  }
  r.check(
    "模块 id 稳定且激活前不暴露计时能力",
    module.id === "pomodoro" && inactiveRejected
  );

  module.activate(context);
  r.check(
    "激活后发布空闲状态并订阅番茄设置",
    states.length === 1 &&
      states[0].phase === "idle" &&
      states[0].totalMs === 60000 &&
      typeof settingsListener === "function"
  );

  r.check(
    "开始番茄后由模块 EventScope 创建秒级计时器",
    module.operations.start() === true &&
      module.operations.getPhase() === "focus" &&
      intervals.size === 1 &&
      latestInterval.delayMs === 1000 &&
      notices.some((message) => String(message).includes("专注 1 分钟"))
  );
  r.check(
    "再次开始不会创建第二个计时器",
    module.operations.start() === false && intervals.size === 1
  );

  wordCount = 130;
  r.check(
    "本番茄字数使用焦点无关的最近正文计数",
    module.operations.getState().words === 30
  );
  module.operations.captureCurrentWords();
  wordCount = 140;
  r.check(
    "正文编辑确认后立即结算增量并重设番茄基线",
    module.operations.getBaseCount() === 130 &&
      module.operations.getState().words === 40
  );
  module.operations.adjustBaseCount(20);
  wordCount = 170;
  r.check(
    "外部修改可同步调整番茄基线",
    module.operations.getState().words === 50
  );
  module.operations.rebaseBaseCount(true);
  const rebasedWords = module.operations.getState().words;
  wordCount = 180;
  r.check(
    "切换统计模式时保留已完成增量并重设基线",
    rebasedWords === 50 && module.operations.getState().words === 60
  );

  module.operations.stop();
  r.check(
    "手动结束会停止并释放计时器",
    module.operations.getPhase() === "idle" &&
      intervals.size === 0 &&
      latestInterval.disposed
  );

  settings.pomodoroFocusMinutes = 0;
  settings.pomodoroBreakMinutes = 0;
  settings.pomodoroLongBreakEvery = 3;
  settings.pomodoroAutoSnapshot = true;
  wordCount = 160;
  module.operations.start();
  wordCount = 175;
  latestInterval.callback();
  await new Promise((resolve) => setImmediate(resolve));
  r.check(
    "专注完成写入今日历史、通知持久化并自动保存快照",
    history["2026-10-17"].count === 1 &&
      history["2026-10-17"].words === 15 &&
      historyChanges === 1 &&
      snapshotSaves === 1 &&
      module.operations.getPhase() === "idle"
  );
  r.check(
    "今日番茄汇总只读取当前日期的已完成记录",
    module.operations.getTodaySummary().count === 1 &&
      module.operations.getTodaySummary().words === 15
  );

  settings.pomodoroBreakMinutes = 5;
  settings.pomodoroLongBreakEvery = 1;
  wordCount = 200;
  module.operations.start();
  wordCount = 205;
  latestInterval.callback();
  await new Promise((resolve) => setImmediate(resolve));
  r.check(
    "达到长休息间隔后进入长休息并继续计时",
    module.operations.getPhase() === "longBreak" &&
      module.operations.getState().totalMs === 15 * 60000 &&
      intervals.size === 1
  );
  module.operations.skipBreak();
  r.check(
    "跳过长休息会回到空闲并释放计时器",
    module.operations.getPhase() === "idle" && intervals.size === 0
  );

  settings.pomodoroFocusMinutes = 1;
  settings.pomodoroBreakMinutes = 0;
  module.operations.start();
  module.operations.togglePause();
  const paused = module.operations.getState();
  const pausedIntervalCount = intervals.size;
  module.operations.togglePause();
  const resumed = module.operations.getState();
  const resumedIntervalCount = intervals.size;
  r.check(
    "暂停会停止计时，继续会重新创建计时器",
    paused.paused &&
      pausedIntervalCount === 0 &&
      !resumed.paused &&
      resumedIntervalCount === 1
  );
  module.operations.stop();

  settings.pomodoroFocusMinutes = 2;
  publishSettings("pomodoroFocusMinutes");
  r.check(
    "番茄时长设置变化会重发空闲状态",
    states.at(-1).phase === "idle" &&
      states.at(-1).totalMs === 2 * 60000
  );

  const operations = module.operations;
  module.deactivate();
  effects.dispose();
  let disposedRejected = false;
  try {
    operations.start();
  } catch {
    disposedRejected = true;
  }
  r.check(
    "销毁时释放计时器、设置订阅并让残留操作失效",
    disposedRejected &&
      settingsUnsubscriptions === 1 &&
      intervals.size === 0
  );

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/pomodoroModule.ts"),
    "utf8"
  );
  const timerSource = fs.readFileSync(path.join(H.ROOT, "src/pomodoro.ts"), "utf8");
  r.check(
    "主入口只装配番茄模块与窄兼容端口",
    /createPomodoroModule\(/.test(mainSource) &&
      /this\.pomodoroModule,/.test(mainSource) &&
      /captureCurrentWords\(\)/.test(mainSource) &&
      !/rebaseBaseCount\(true\)/.test(mainSource) &&
      !/new PomodoroTimer/.test(mainSource) &&
      !/private pomodoro!: PomodoroTimer/.test(mainSource) &&
      !/handlePomodoroComplete\(/.test(mainSource)
  );
  r.check(
    "番茄模块自己接管历史、自动快照与设置订阅",
    /getHistory\(\)/.test(moduleSource) &&
      /saveSnapshot\(\)/.test(moduleSource) &&
      /services\.settings\.subscribe/.test(moduleSource) &&
      !/from "\.\.\/main"/.test(moduleSource)
  );
  r.check(
    "计时器使用注入的调度器并通过作用域释放",
    /scheduler\.setInterval/.test(timerSource) &&
      /tickHandle\.dispose\(\)/.test(timerSource) &&
      /current\.events/.test(moduleSource)
  );

  return r.finish();
}

Promise.resolve()
  .then(main)
  .then((ok) => {
    H.cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error("运行失败：" + error.stack);
    H.cleanup();
    process.exit(2);
  });
