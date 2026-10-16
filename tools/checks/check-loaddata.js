/**
 * 检查：loadPluginData 对「旧扁平格式」的恢复。
 *
 * 做法：从 src/main.ts 按符号+花括号配平抽出真实的 loadPluginData 方法体 →
 * 用本地 esbuild 做类型擦除 → 注入桩后执行。**逻辑一行不改**，所以结论可信。
 *
 * 对应设计文档 §7 第 10 条：旧扁平格式分支曾把 17 个字段硬写成 DEFAULT_SETTINGS，
 * 导致用户改过的设置被默认值顶掉、并被整文件覆盖写回 data.json（不可逆）。
 * 这个检查就是那条 bug 的回归测试。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

/** 从 settings.ts 里解出真实默认值（跳过硬编码引用其它常量的项，再补 snapshot 的）。 */
function readDefaultSettings() {
  const src = fs.readFileSync(path.join(H.ROOT, "src/settings.ts"), "utf8");
  const block = src.slice(
    src.indexOf("export const DEFAULT_SETTINGS"),
    src.indexOf("const WORD_COUNT_MODE_LABELS")
  );
  const out = {};
  for (const m of block.matchAll(/^\s{2}([a-zA-Z][\w]*):\s*(.+?),?$/gm)) {
    let v = m[2].replace(/,$/, "").trim();
    if (v === "true") v = true;
    else if (v === "false") v = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (/^".*"$/.test(v)) v = v.slice(1, -1);
    else continue; // 引用其它常量（如 DEFAULT_CHAPTER_EXCLUDE_NAMES）的项跳过
    out[m[1]] = v;
  }
  Object.assign(out, {
    snapshotEnabled: true, snapshotFolder: ".wt-snapshots", snapshotIntervalMinutes: 10,
    snapshotIdleMinutes: 3, snapshotMaxPerFile: 20, snapshotOnlyDrafts: true,
  });
  return out;
}

/** 旧扁平格式分支里曾经被硬写成默认值的字段（修复前的 bug 面）。 */
const LEGACY_FLAT_FIELDS = [
  "themeTone", "pomodoroFocusMinutes", "pomodoroBreakMinutes",
  "pomodoroLongBreakEvery", "pomodoroLongBreakMinutes", "pomodoroAutoSnapshot",
  "statusBarOnlyImmersive", "mobileStatusBar", "draftKeywords",
  "chapterExcludeNames", "formatToolbarEnabled", "formatToolbarScope",
  "commentsEnabled", "commentBubbleEverywhere", "outlineStorageMode",
  "newProjectFolder", "sharedLibraryFolder",
];

function buildRunner(defaults) {
  const mainSrc = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const method = H.extractMethod(mainSrc, "private async loadPluginData()");
  const bodyTs = [
    "export function runBody(self: any) {",
    "  const __body = async function (this: any) {",
    "    const data: any = await __loadData();",
    method
      .replace(/^\s*private async loadPluginData\(\)\s*\{/, "")
      .replace(/^\s*const data: any = await super\.loadData\(\);\s*$/m, "")
      .replace(/\}\s*$/, ""),
    "  };",
    "  return __body.call(self);",
    "}",
  ].join("\n");

  let payload = null;
  const js = H.transpileTs(bodyTs, "loadPluginData", "__bodyMod");
  const runBody = new Function(
    "DEFAULT_SETTINGS", "__loadData", "normalizeHomePage",
    js + "\nreturn __bodyMod.runBody;"
  )(defaults, async () => payload, (v) => v);

  return {
    setData(d) { payload = d; },
    async run() {
      const self = {
        settings: {},
        baselinesAt: 0,
        dailyTotal: 0, dailyGross: 0, dailyDurationSeconds: 0, lastDurationTotal: 0,
        dailyHistory: {}, dailyGrossHistory: {}, dailyDurationHistory: {},
        projectHistory: {}, projectGrossHistory: {}, projectDurationHistory: {},
        dailyFileDeltas: {}, dailyPomodoroHistory: {}, knownProjects: new Set(),
        workbenchProject: null, workbenchMode: "chapters", workbenchStatus: {},
        hiddenProjects: {}, homePage: "desk", projectCovers: {}, libraryView: "grid",
        fileBaselines: {}, activeDay: "", lastChapterExcludeNames: null,
        lastDraftKeywords: null, lastFormatToolbarSig: null, lastCommentsEnabled: null,
        sanitizeBaselines() {},
      };
      await runBody(self);
      return self;
    },
  };
}

/** 给每个字段造一个与默认值不同的值。 */
function nonDefault(defaultValue, key) {
  if (typeof defaultValue === "boolean") return !defaultValue;
  if (typeof defaultValue === "number") return defaultValue + 7;
  if (defaultValue === "warm") return "contrast";
  if (defaultValue === "all-except-chapters") return "library-only";
  if (defaultValue === "sidecar") return "frontmatter";
  return "自定义-" + key;
}

async function main() {
  const defaults = readDefaultSettings();
  const runner = buildRunner(defaults);
  const r = H.createReporter("loadPluginData 旧扁平格式恢复（src/main.ts 真实方法体）");

  // 1) 旧扁平格式：17 项非默认值必须保留（这条就是那次 bug 的回归）
  {
    const data = { lineHeight: 2.1, paragraphSpacing: 0.8 };
    for (const k of LEGACY_FLAT_FIELDS) data[k] = nonDefault(defaults[k], k);
    runner.setData(data);
    const p = await runner.run();
    const lost = LEGACY_FLAT_FIELDS.filter((k) => p.settings[k] !== data[k]);
    r.check("17 项非默认值全部保留", lost.length === 0, lost.length ? "仍丢失: " + lost.join(", ") : "");
    r.check("旧分支本就支持的字段正常",
      p.settings.lineHeight === 2.1 && p.settings.paragraphSpacing === 0.8);
  }

  // 2) 旧扁平格式：缺失字段回落默认值
  {
    runner.setData({ lineHeight: 1.8, paragraphSpacing: 0.5 });
    const p = await runner.run();
    const wrong = LEGACY_FLAT_FIELDS.filter((k) => p.settings[k] !== defaults[k]);
    r.check("缺失字段回落默认值", wrong.length === 0, wrong.join(", "));
  }

  // 3) 新格式（白名单合并分支）不受影响
  {
    runner.setData({
      settings: { ...defaults, commentsEnabled: false, dailyGoal: 8888, fontSize: 20 },
      dailyHistory: { "2026-10-15": 1234 },
    });
    const p = await runner.run();
    r.check("新格式：用户值被读回",
      p.settings.commentsEnabled === false && p.settings.dailyGoal === 8888);
    r.check("新格式：废弃字段 fontSize 被清掉", !("fontSize" in p.settings));
    r.check("新格式：历史数据保留", p.dailyHistory["2026-10-15"] === 1234);
  }

  // 4) 无数据不抛异常
  {
    runner.setData(null);
    let ok = true;
    try { await runner.run(); } catch (e) { ok = false; console.log("     " + e.message); }
    r.check("无 data 时安全通过", ok);
  }

  return r.finish();
}

main()
  .then((ok) => { H.cleanup(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error("运行失败：" + e.stack); H.cleanup(); process.exit(2); });
