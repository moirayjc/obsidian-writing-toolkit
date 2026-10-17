/**
 * Settings Service 的读取、更新与变更通知检查。
 *
 * 兼容路径允许旧页面继续直接改 settings 对象，因此这里同时验证：
 *   - set / update 会立即广播
 *   - 直接修改后调用 publishChanges() 也能广播
 *   - 取消订阅、监听器异常隔离
 */
const H = require("./_harness");

function loadModules() {
  const restore = H.stubObsidian({});
  try {
    const schema = H.compile(
      "src/settingsSchema.ts",
      "settings-schema-events",
      ["electron"]
    );
    const service = H.compile(
      "src/services/settingsService.ts",
      "settings-service-events",
      ["electron"]
    );
    return { schema, service };
  } finally {
    restore();
  }
}

async function main() {
  const { schema, service } = loadModules();
  const { DEFAULT_SETTINGS } = schema;
  const { DefaultSettingsService } = service;
  const errors = [];
  const log = { error(...args) { errors.push(args); } };
  const r = H.createReporter("Settings Service 读取与变更通知");

  const settings = new DefaultSettingsService(log);
  const live = settings.get();
  const events = [];
  const unsubscribe = settings.subscribe((change) => events.push(change));

  r.check(
    "初始读取完整默认设置",
    Object.keys(DEFAULT_SETTINGS).every(
      (key) => live[key] === DEFAULT_SETTINGS[key]
    )
  );

  const loaded = settings.load({
    settings: {
      ...DEFAULT_SETTINGS,
      commentsEnabled: false,
      dailyGoal: 6500,
    },
  });
  r.check("load 不替换 Host 持有的对象", loaded === live);
  r.check(
    "load 应用新格式设置",
    live.commentsEnabled === false && live.dailyGoal === 6500
  );
  r.check("load 不触发变更通知", events.length === 0);

  const firstChange = settings.set("dailyGoal", 7000);
  r.check(
    "set 立即广播单个字段",
    firstChange?.keys.length === 1 &&
      firstChange.keys[0] === "dailyGoal" &&
      events.length === 1
  );
  r.check(
    "变更事件带前后值",
    firstChange?.previous.dailyGoal === 6500 &&
      firstChange?.current.dailyGoal === 7000
  );
  r.check("重复发布不会制造空事件", settings.publishChanges() === null);

  live.commentsEnabled = true;
  const compatibilityChange = settings.publishChanges();
  r.check(
    "兼容路径捕获直接修改",
    compatibilityChange?.keys.length === 1 &&
      compatibilityChange.keys[0] === "commentsEnabled" &&
      events.length === 2
  );

  const updateChange = settings.update({
    lineHeight: 2,
    paragraphSpacing: 0.8,
  });
  r.check(
    "update 一次广播多个字段",
    updateChange?.keys.join(",") === "lineHeight,paragraphSpacing" &&
      events.length === 3
  );

  unsubscribe();
  settings.set("showSpeed", false);
  r.check("取消订阅后不再收到通知", events.length === 3);

  let secondListenerCalls = 0;
  settings.subscribe(() => {
    throw new Error("expected listener failure");
  });
  settings.subscribe(() => {
    secondListenerCalls++;
  });
  settings.set("showSpeed", true);
  r.check("单个监听器异常不阻断其他监听器", secondListenerCalls === 1);
  r.check("监听器异常被记录", errors.length === 1);

  return r.finish();
}

main()
  .then((ok) => {
    H.cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error("运行失败：" + error.stack);
    H.cleanup();
    process.exit(2);
  });
