/**
 * 检查：Settings Service 的旧扁平格式恢复。
 *
 * 真实实现位于 src/services/settingsService.ts。这里直接编译并执行
 * mergeSettingsFromData()，覆盖设计文档里那条会导致 17 项配置丢失的回归。
 */
const H = require("./_harness");

/** 旧扁平格式分支里曾经被硬写成默认值的字段（修复前的 bug 面）。 */
const LEGACY_FLAT_FIELDS = [
  "themeTone", "pomodoroFocusMinutes", "pomodoroBreakMinutes",
  "pomodoroLongBreakEvery", "pomodoroLongBreakMinutes", "pomodoroAutoSnapshot",
  "statusBarOnlyImmersive", "mobileStatusBar", "draftKeywords",
  "chapterExcludeNames", "formatToolbarEnabled", "formatToolbarScope",
  "commentsEnabled", "commentBubbleEverywhere", "outlineStorageMode",
  "newProjectFolder", "sharedLibraryFolder",
];

function nonDefault(defaultValue, key) {
  if (typeof defaultValue === "boolean") return !defaultValue;
  if (typeof defaultValue === "number") return defaultValue + 7;
  if (defaultValue === "warm") return "contrast";
  if (defaultValue === "all-except-chapters") return "library-only";
  if (defaultValue === "sidecar") return "frontmatter";
  return "自定义-" + key;
}

async function main() {
  const restore = H.stubObsidian({});
  let mergeSettingsFromData;
  let defaults;
  try {
    const schema = H.compile("src/settingsSchema.ts", "settings-schema", [
      "electron",
    ]);
    const settings = H.compile(
      "src/services/settingsService.ts",
      "settings-service",
      ["electron"]
    );
    mergeSettingsFromData = settings.mergeSettingsFromData;
    defaults = schema.DEFAULT_SETTINGS;
  } finally {
    restore();
  }

  const r = H.createReporter(
    "Settings Service 旧扁平格式恢复（src/services/settingsService.ts 真实实现）"
  );

  // 1) 旧扁平格式：17 项非默认值必须保留（这条就是那次 bug 的回归）
  {
    const data = {
      lineHeight: 2.1,
      paragraphSpacing: 0.8,
      headingStyle: !defaults.headingStyle,
    };
    for (const key of LEGACY_FLAT_FIELDS) {
      data[key] = nonDefault(defaults[key], key);
    }
    const merged = mergeSettingsFromData(data);
    const lost = LEGACY_FLAT_FIELDS.filter((key) => merged[key] !== data[key]);
    r.check(
      "17 项非默认值全部保留",
      lost.length === 0,
      lost.length ? "仍丢失: " + lost.join(", ") : ""
    );
    r.check(
      "旧分支本就支持的顶层字段正常",
      merged.lineHeight === 2.1 &&
        merged.paragraphSpacing === 0.8 &&
        merged.headingStyle === data.headingStyle
    );
  }

  // 2) 旧扁平格式：缺失字段回落默认值
  {
    const merged = mergeSettingsFromData({
      lineHeight: 1.8,
      paragraphSpacing: 0.5,
    });
    const wrong = LEGACY_FLAT_FIELDS.filter(
      (key) => merged[key] !== defaults[key]
    );
    r.check("缺失字段回落默认值", wrong.length === 0, wrong.join(", "));
  }

  // 3) 旧扁平格式：顶层键优先于已经收进 settings 的旧镜像
  {
    const merged = mergeSettingsFromData({
      lineHeight: 1.8,
      paragraphSpacing: 0.5,
      commentsEnabled: false,
      settings: { commentsEnabled: true, dailyGoal: 7777 },
    });
    r.check(
      "旧格式顶层值优先",
      merged.commentsEnabled === false,
      String(merged.commentsEnabled)
    );
  }

  // 4) 新格式：白名单合并，保留用户值并清理废弃字段
  {
    const merged = mergeSettingsFromData({
      settings: {
        ...defaults,
        commentsEnabled: false,
        dailyGoal: 8888,
        fontSize: 20,
      },
      dailyHistory: { "2026-10-15": 1234 },
    });
    r.check(
      "新格式：用户值被读回",
      merged.commentsEnabled === false && merged.dailyGoal === 8888
    );
    r.check("新格式：废弃字段 fontSize 被清掉", !("fontSize" in merged));
  }

  // 5) 无数据：完整回落到默认设置
  {
    const merged = mergeSettingsFromData(null);
    const wrong = Object.keys(defaults).filter(
      (key) => merged[key] !== defaults[key]
    );
    r.check("无 data 时完整使用默认值", wrong.length === 0, wrong.join(", "));
  }

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
