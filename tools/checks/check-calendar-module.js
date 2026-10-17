/**
 * 写作日历 Feature Module 检查。
 *
 * 用可记录的日历实例验证数据源、设置读取、年份恢复、热刷新、重复销毁
 * 和模块卸载；真实 WritingCalendar 仍负责渲染，模块只持有生命周期边界。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

async function main() {
  const restoreObsidian = H.stubObsidian({
    setIcon() {},
  });
  let createCalendarModule;
  try {
    ({ createCalendarModule } = H.compile(
      "src/features/calendarModule.ts",
      "calendar-module"
    ));
  } finally {
    restoreObsidian();
  }

  const r = H.createReporter("写作日历 Feature Module");
  const allWords = { "2026-10-16": 1200 };
  const allDuration = { "2026-10-16": 45 };
  const projectWords = { "作品/长篇": { "2026-10-16": 800 } };
  const projectDuration = { "作品/长篇": { "2026-10-16": 30 } };
  const sourceReads = [];
  const sources = {
    allWords() {
      sourceReads.push("allWords");
      return allWords;
    },
    allDuration() {
      sourceReads.push("allDuration");
      return allDuration;
    },
    projectWords(key) {
      sourceReads.push(`projectWords:${key}`);
      return projectWords[key] || {};
    },
    projectDuration(key) {
      sourceReads.push(`projectDuration:${key}`);
      return projectDuration[key] || {};
    },
  };

  const settings = {
    dailyDisplayMode: "words",
    dailyGoal: 5000,
  };
  let settingsListener = null;
  let settingsSubscriptions = 0;
  let settingsUnsubscriptions = 0;
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
  const context = {
    app: {},
    services: {
      settings: {
        get() {
          return settings;
        },
        subscribe(listener) {
          settingsSubscriptions++;
          settingsListener = listener;
          return () => {
            settingsUnsubscriptions++;
            settingsListener = null;
          };
        },
      },
    },
    effects,
  };

  const containers = [];
  const factoryCalls = [];
  const instances = [];
  const factory = (container, provider, initialYear) => {
    const instance = {
      container,
      provider,
      initialYear,
      year: initialYear ?? 2026,
      projectKey: null,
      refreshCount: 0,
      destroyCount: 0,
      getYear() {
        return this.year;
      },
      setProject(key) {
        this.projectKey = key;
      },
      getProjectKey() {
        return this.projectKey;
      },
      refresh() {
        this.refreshCount++;
      },
      destroy() {
        this.destroyCount++;
      },
    };
    factoryCalls.push({ container, provider, initialYear });
    instances.push(instance);
    return instance;
  };

  const module = createCalendarModule(sources, factory);
  let inactiveRejected = false;
  try {
    module.operations.create({});
  } catch {
    inactiveRejected = true;
  }
  r.check(
    "模块 id 稳定且激活前不暴露日历能力",
    module.id === "calendar" && inactiveRejected
  );

  module.activate(context);
  r.check(
    "激活时只订阅一次设置",
    settingsSubscriptions === 1 && typeof settingsListener === "function"
  );

  const containerA = { name: "calendar-a" };
  containers.push(containerA);
  const handleA = module.operations.create(containerA, 2022);
  const instanceA = instances[0];
  const callA = factoryCalls[0];
  r.check(
    "创建实例时转发容器、数据源和恢复年份",
    callA.container === containerA &&
      callA.initialYear === 2022 &&
      instanceA.year === 2022
  );

  const provider = callA.provider;
  settings.dailyDisplayMode = "duration";
  settings.dailyGoal = 3200;
  r.check(
    "数据源按全部作品与单作品分别映射",
    provider.history() === allWords &&
      provider.durationHistory() === allDuration &&
      provider.projectHistory("作品/长篇") === projectWords["作品/长篇"] &&
      provider.projectDurationHistory("作品/长篇") ===
        projectDuration["作品/长篇"] &&
      provider.projectHistory("作品/缺失").constructor === Object &&
      sourceReads.includes("projectDuration:作品/长篇")
  );
  r.check(
    "显示模式与每日目标每次读取最新设置",
    provider.displayMode() === "duration" &&
      provider.dailyGoal() === 3200 &&
      provider.displayMode() === "duration"
  );

  handleA.setProject("作品/长篇");
  const projectKey = handleA.getProjectKey();
  const yearBeforeRefresh = handleA.getYear();
  handleA.refresh();
  r.check(
    "窄句柄转发年份、项目和刷新",
    yearBeforeRefresh === 2022 &&
      projectKey === "作品/长篇" &&
      instanceA.refreshCount === 1
  );

  handleA.destroy();
  handleA.destroy();
  const refreshesAfterDestroy = instanceA.refreshCount;
  handleA.refresh();
  r.check(
    "重复销毁保持幂等且销毁后刷新不再触达实例",
    instanceA.destroyCount === 1 &&
      instanceA.refreshCount === refreshesAfterDestroy
  );

  const containerB = { name: "calendar-b" };
  const containerC = { name: "calendar-c" };
  containers.push(containerB, containerC);
  const handleB = module.operations.create(containerB);
  const handleC = module.operations.create(containerC, 2025);
  const instanceB = instances[1];
  const instanceC = instances[2];

  settings.dailyDisplayMode = "words";
  settingsListener({
    keys: ["dailyDisplayMode"],
    previous: settings,
    current: settings,
  });
  r.check(
    "显示模式变化刷新全部存活实例",
    instanceB.refreshCount === 1 &&
      instanceC.refreshCount === 1 &&
      instanceA.destroyCount === 1
  );

  settings.dailyGoal = 6000;
  settingsListener({
    keys: ["dailyGoal"],
    previous: settings,
    current: settings,
  });
  r.check(
    "每日目标变化刷新全部存活实例",
    instanceB.refreshCount === 2 && instanceC.refreshCount === 2
  );

  settingsListener({
    keys: ["wordCountMode"],
    previous: settings,
    current: settings,
  });
  r.check(
    "无关设置变化不刷新日历",
    instanceB.refreshCount === 2 && instanceC.refreshCount === 2
  );

  const operationsBeforeDispose = module.operations;
  effects.dispose();
  r.check(
    "卸载时释放设置订阅并销毁全部存活实例",
    settingsUnsubscriptions === 1 &&
      instanceB.destroyCount === 1 &&
      instanceC.destroyCount === 1
  );

  let disposedRejected = false;
  try {
    module.operations.create({});
  } catch {
    disposedRejected = true;
  }
  let staleCreateRejected = false;
  try {
    operationsBeforeDispose.create({});
  } catch {
    staleCreateRejected = true;
  }
  const refreshesBeforeStaleCall = instanceB.refreshCount;
  handleB.refresh();
  handleB.destroy();
  handleB.destroy();
  handleC.destroy();
  r.check(
    "卸载后模块与残留句柄保持惰性或拒绝调用",
    disposedRejected &&
      staleCreateRejected &&
      instanceB.refreshCount === refreshesBeforeStaleCall &&
      instanceB.destroyCount === 1 &&
      instanceC.destroyCount === 1
  );

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const homeSource = fs.readFileSync(path.join(H.ROOT, "src/home.ts"), "utf8");
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/calendarModule.ts"),
    "utf8"
  );
  r.check(
    "主入口只装配日历模块并通过窄桥创建实例",
    /createCalendarModule\(/.test(mainSource) &&
      /this\.calendarModule,/.test(mainSource) &&
      /createCalendar\([\s\S]*this\.calendarModule\.operations\.create/.test(
        mainSource
      ) &&
      !/new WritingCalendar/.test(mainSource) &&
      !/private calendar!/.test(mainSource)
  );
  r.check(
    "主页只依赖 CalendarHandle 且不直接创建 WritingCalendar",
    /import type \{ CalendarHandle, UiShellContext \}/.test(homeSource) &&
      /this\.host\.caps\.calendar\.create\(/.test(homeSource) &&
      !/new WritingCalendar/.test(homeSource)
  );
  r.check(
    "统计设置改动后同步折叠栏摘要",
    /updateSettingsSummary/.test(homeSource) &&
      /updateSummary\(\)/.test(homeSource) &&
      /foldDesc\.setText/.test(homeSource)
  );
  r.check(
    "日历模块自己持有数据绑定、设置订阅与生命周期",
    /providerFor\(/.test(moduleSource) &&
      /services\.settings\.subscribe/.test(moduleSource) &&
      /mounted\.delete\(record\)/.test(moduleSource) &&
      !/from "\.\.\/main"/.test(moduleSource)
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
