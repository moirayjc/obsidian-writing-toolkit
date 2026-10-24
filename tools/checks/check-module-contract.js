/**
 * 模块契约与数据键守卫（阶段 6，源码级）。
 *
 * 固定插件化的稳定契约：模块 id、依赖、Host 装配数量、模块日志带 id、
 * 设置默认键、data.json 顶层键、唯一的 localStorage 主题缓存例外。
 * 只读源码，不读用户 data.json，不启动 Obsidian。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const MODULE_FILES = {
  "agentBridgeModule.ts": "agent-bridge",
  "calendarModule.ts": "calendar",
  "chapterStatusModule.ts": "chapter-status",
  "commentsModule.ts": "comments",
  "editorHardBreakModule.ts": "editor.hard-break",
  "editorHemingwayModule.ts": "editor.hemingway",
  "editorPunctuationModule.ts": "editor.punctuation",
  "editorTypewriterModule.ts": "editor.typewriter",
  "formatToolbarModule.ts": "editor.format-toolbar",
  "outlineModule.ts": "outlines",
  "planBoardModule.ts": "plan-board",
  "sidecarLocationModule.ts": "sidecar-location",
  "pomodoroModule.ts": "pomodoro",
  "snapshotModule.ts": "snapshots.core",
  "snapshotUiModule.ts": "snapshots.ui",
  "typographyModule.ts": "appearance.typography",
};

const SETTINGS_LITERAL_KEYS = [
  "themeTone", "lineHeight", "paragraphSpacing", "letterPaperMode",
  "paragraphIndent", "headingStyle", "typewriterMode", "typewriterOffset",
  "immersiveMode", "immersiveParagraphHighlight", "hemingwayMode",
  "punctuationAssist", "hardBreakOnEnter", "formatToolbarEnabled",
  "formatToolbarScope", "commentsEnabled", "commentBubbleEverywhere",
  "dailyGoal", "dailyDisplayMode", "wordCountMode", "showSpeed",
  "statusBarOnlyImmersive", "mobileStatusBar", "pomodoroFocusMinutes",
  "pomodoroBreakMinutes", "pomodoroLongBreakEvery", "pomodoroLongBreakMinutes",
  "pomodoroAutoSnapshot", "draftKeywords", "chapterExcludeNames",
  "outlineStorageMode", "newProjectFolder", "sharedLibraryFolder",
  "planBoardFile", "commentsOnMobile",
];

const SNAPSHOT_SETTING_KEYS = [
  "snapshotEnabled", "snapshotFolder", "snapshotIntervalMinutes",
  "snapshotIdleMinutes", "snapshotMaxPerFile", "snapshotOnlyDrafts",
];

// 2026-10-23 起每日统计与字数基线按设备存在 `_写作工具箱/统计/<设备>.json`，
// 不再进 data.json（specs/cross-device-stats.md）。
const DATA_KEYS = [
  "settings", "pomodoroSession", "workbenchProject",
  "workbenchMode", "workbenchStatus", "hiddenProjects", "homePage",
  "projectCovers", "libraryView",
];
const STATS_KEYS = [
  "dailyHistory", "dailyDurationHistory", "projectHistory", "projectDurationHistory",
  "dailyPomodoroHistory", "dailyFileDeltas", "dailyTypedHistory", "fileBaselines", "baselinesAt",
];

function readFile(relPath) {
  return fs.readFileSync(path.join(H.ROOT, relPath), "utf8");
}

/** 取 `export const NAME = {` 的块内顶层键（按 2 空格缩进）。 */
function objectKeys(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const block = source.slice(open + 1, end);
  return [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*):/gm)].map(
    (match) => match[1]
  );
}

function sameSet(actual, expected) {
  return (
    actual.length === expected.length &&
    [...actual].sort().join(",") === [...expected].sort().join(",")
  );
}

function main() {
  const r = H.createReporter("模块契约与数据键（源码级）");
  const featuresDir = path.join(H.ROOT, "src", "features");
  const featureFiles = fs.readdirSync(featuresDir).filter((name) => name.endsWith(".ts"));
  const sources = Object.fromEntries(
    Object.keys(MODULE_FILES).map((name) => [
      name,
      fs.readFileSync(path.join(featuresDir, name), "utf8"),
    ])
  );

  // 1. 16 个模块 id 与文件一一对应，无重复。
  const ids = Object.entries(MODULE_FILES).map(([file, id]) => {
    const defined = new RegExp(`id:\\s*"${id.replace(/\./g, "\\.")}"`).test(sources[file]);
    return defined ? id : null;
  });
  r.check(
    "16 个 Feature Module 文件都声明了约定的模块 id",
    featureFiles.length === 16 && ids.every(Boolean)
  );
  r.check(
    "模块 id 无重复且集合稳定",
    new Set(ids).size === 16 && sameSet(ids, Object.values(MODULE_FILES))
  );

  // 2. 只有 snapshots.ui → snapshots.core、agent-bridge → comments 两处依赖。
  const withDepends = Object.entries(sources)
    .filter(([, source]) => /dependsOn:/.test(source))
    .sort(([a], [b]) => a.localeCompare(b));
  r.check(
    "只有 snapshots.ui（→ snapshots.core）与 agent-bridge（→ comments）声明依赖",
    withDepends.length === 2 &&
      withDepends[0][0] === "agentBridgeModule.ts" &&
      /dependsOn:\s*\["comments"\]/.test(withDepends[0][1]) &&
      withDepends[1][0] === "snapshotUiModule.ts" &&
      /dependsOn:\s*\["snapshots\.core"\]/.test(withDepends[1][1])
  );

  // 3. main.ts 恰好创建并激活 16 个模块。
  const mainSource = readFile("src/main.ts");
  const factoryCalls = (mainSource.match(/create[A-Za-z]+Module\s*\(/g) || []).length;
  const activateBlock = mainSource.slice(
    mainSource.indexOf("await this.host.activateModules(["),
    mainSource.indexOf("]);", mainSource.indexOf("await this.host.activateModules(["))
  );
  const activated = (activateBlock.match(/this\.[A-Za-z]+Module,/g) || []).length;
  r.check(
    "main.ts 创建并激活恰好 16 个模块",
    factoryCalls === 16 && activated === 16,
    "factories=" + factoryCalls + ", activated=" + activated
  );

  // 4. Host 的错误日志带模块 id（激活/停用/清理）。
  const hostSource = readFile("src/host/pluginHost.ts");
  const hostIds = (
    hostSource.match(/module:\$\{[^}]+\}:(?:activate|deactivate|cleanup)/g) || []
  ).length;
  r.check("Host 记录模块错误时带模块 id", hostIds >= 3, "hits=" + hostIds);

  // 5. Feature Module 自己的错误日志带模块 id 前缀。
  const badLogs = [];
  for (const [file, id] of Object.entries(MODULE_FILES)) {
    const lines = sources[file].split("\n");
    lines.forEach((line, index) => {
      if (!/console\.(?:error|warn)\s*\(/.test(line)) return;
      if (!line.includes(`[Writing Toolkit:${id}]`)) {
        badLogs.push(`${file}:${index + 1}`);
      }
    });
  }
  r.check(
    "Feature Module 的错误日志都带 [Writing Toolkit:<模块 id>] 前缀",
    badLogs.length === 0,
    badLogs.join(", ")
  );

  // 6. 设置默认键 = schema 37 键 + snapshot 6 键（DEFAULT_SETTINGS 展开默认值）。
  const schemaSource = readFile("src/settingsSchema.ts");
  const schemaKeys = objectKeys(
    schemaSource,
    "export const DEFAULT_SETTINGS"
  );
  const snapshotSource = readFile("src/snapshot.ts");
  const snapshotKeys = objectKeys(
    snapshotSource,
    "export const DEFAULT_SNAPSHOT_SETTINGS"
  );
  r.check(
    "DEFAULT_SETTINGS 展开 snapshot 默认值，共 37 + 6 个键",
    /\.\.\.DEFAULT_SNAPSHOT_SETTINGS/.test(schemaSource) &&
      schemaKeys !== null &&
      sameSet(schemaKeys, SETTINGS_LITERAL_KEYS) &&
      snapshotKeys !== null &&
      sameSet(snapshotKeys, SNAPSHOT_SETTING_KEYS),
    "schema=" + (schemaKeys || []).length + ", snapshot=" + (snapshotKeys || []).length
  );

  // 7. data.json 顶层键由 pluginDataPayload + prefs 快照唯一决定，且与约定集合一致。
  const PREFS_KEYS = [
    "workbenchProject", "workbenchMode", "workbenchStatus", "hiddenProjects",
    "homePage", "projectCovers", "libraryView",
  ];
  const persistBlock = H.extractMethod(mainSource, "private pluginDataPayload()");
  const persistedKeys = [
    ...persistBlock.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9_]*):/gm),
  ].map((match) => match[1]);
  const prefsSource = readFile("src/services/workspacePrefsService.ts");
  const prefsSnapshotKeys = [
    ...prefsSource
      .slice(
        prefsSource.indexOf("export interface WorkspacePrefsSnapshot"),
        prefsSource.indexOf("export interface WorkspacePrefsServiceHost")
      )
      .matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*):/gm),
  ].map((match) => match[1]);
  r.check(
    "pluginDataPayload + prefs 快照拼出 data.json 的 9 个顶层键",
    /this\.prefs\.forPersistence\(\)/.test(persistBlock) &&
      sameSet(persistedKeys, DATA_KEYS.filter((key) => !PREFS_KEYS.includes(key))) &&
      sameSet(prefsSnapshotKeys, PREFS_KEYS),
    "persist=" + persistedKeys.join(",") + " / prefs=" + prefsSnapshotKeys.join(",")
  );
  r.check(
    "每日统计与字数基线不再写进 data.json（只在迁移失败时原样带回）",
    STATS_KEYS.every((key) => !new RegExp("\\b" + key + ":").test(persistBlock)) &&
      /\.\.\.\(this\.carryLegacyStats \?\? \{\}\)/.test(persistBlock),
    persistBlock.slice(0, 200)
  );

  // 8. Feature Module / Services / Host 不能绕过持久化入口直接写 data.json。
  const persistCallers = ["src/features", "src/services", "src/host"].flatMap(
    (dir) => {
      const base = path.join(H.ROOT, dir);
      return fs
        .readdirSync(base)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => path.join(base, name));
    }
  );
  const illegalWrites = persistCallers
    .filter((file) => {
      const text = fs.readFileSync(file, "utf8");
      return /this\.persistPluginData|host\.services\.persistence\.save/.test(
        text
      );
    })
    .map((file) => path.relative(H.ROOT, file));
  r.check(
    "Feature / Service / Host 不绕过 Host 持久化入口写 data.json",
    illegalWrites.length === 0,
    illegalWrites.join(", ")
  );

  // 9. localStorage 只有首帧主题缓存一个例外，key 固定。
  const storageFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && /localStorage/.test(fs.readFileSync(full, "utf8"))) {
        storageFiles.push(path.relative(H.ROOT, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(path.join(H.ROOT, "src"));
  r.check(
    "localStorage 只用于首帧主题缓存（wt-theme-tone-cache）",
    storageFiles.length === 1 &&
      storageFiles[0] === "src/typography.ts" &&
      /THEME_TONE_CACHE_KEY\s*=\s*"wt-theme-tone-cache"/.test(readFile("src/typography.ts"))
  );

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
