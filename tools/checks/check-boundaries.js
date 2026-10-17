/**
 * 边界与入口守卫（阶段 6，源码级）。
 *
 * 防止插件化迁移后的边界被悄悄破坏：
 * - Feature Module / Services / Host 不 import main.ts；
 * - 没有第二入口、运行时外部加载或 app.plugins 当加载器；
 * - 除 main.ts 外没有命令注册；
 * - features / services / host 不直接使用全局监听器与定时器（必须走 EventScope）；
 * - 版本号在 manifest / package / versions.json 三处同步。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function listTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function main() {
  const r = H.createReporter("边界与入口守卫（源码级）");
  const srcRoot = path.join(H.ROOT, "src");
  const allTs = listTs(srcRoot);
  const rel = (file) => path.relative(H.ROOT, file).replace(/\\/g, "/");
  const read = (file) => fs.readFileSync(file, "utf8");
  const inDir = (prefix) =>
    allTs.filter((file) => rel(file).startsWith(prefix));
  const modFiles = [
    ...inDir("src/features/"),
    ...inDir("src/services/"),
    ...inDir("src/host/"),
  ];

  // 1. Feature Module / Services / Host 不 import main.ts
  const mainImporters = modFiles.filter((file) =>
    /from "\.\.?\/main"/.test(read(file))
  );
  r.check(
    "Feature Module / Services / Host 不 import main.ts",
    mainImporters.length === 0,
    mainImporters.map(rel).join(", ")
  );

  // 2. 不使用 app.plugins 当加载器、无 eval / new Function / 动态 import
  const loaderPatterns = [
    [/app\.plugins/, "app.plugins"],
    [/\beval\s*\(/, "eval("],
    [/new Function\s*\(/, "new Function("],
    [/import\s*\(/, "动态 import("],
  ];
  for (const [re, label] of loaderPatterns) {
    const hits = allTs.filter((file) => re.test(read(file))).map(rel);
    r.check(`src 内不使用 ${label} 做运行时加载`, hits.length === 0, hits.join(", "));
  }

  // 3. 仓库根只有一份 manifest / main.js；src 内没有第二份入口
  const rootEntries = fs.readdirSync(H.ROOT);
  const manifestCount = rootEntries.filter((name) => name === "manifest.json").length;
  const mainCount = rootEntries.filter((name) => name === "main.js").length;
  const srcEntryHits = allTs.filter((file) =>
    /(?:^|\/)(manifest\.json|main\.js)$/.test(rel(file))
  );
  r.check(
    "唯一安装入口：根目录一份 manifest.json + 一份 main.js，src 无第二入口",
    manifestCount === 1 && mainCount === 1 && srcEntryHits.length === 0
  );

  // 4. 命令只在 main.ts 注册；addCommand 总量仍为 4
  const commandFiles = allTs
    .filter((file) => /\.addCommand\s*\(/.test(read(file)))
    .map(rel);
  const mainSource = read(path.join(srcRoot, "main.ts"));
  const mainCommandCount = (mainSource.match(/this\.host\.addCommand\s*\(/g) || []).length;
  r.check(
    "命令只在 main.ts 注册且恰好 4 条",
    commandFiles.length === 2 &&
      commandFiles.includes("src/main.ts") &&
      commandFiles.includes("src/host/pluginHost.ts") &&
      mainCommandCount === 4,
    commandFiles.join(", ") + " / count=" + mainCommandCount
  );

  // 5. features / services / host 不直接使用全局监听器、定时器或 body
  const globalHits = modFiles
    .filter((file) => {
      if (rel(file) === "src/services/eventsService.ts") return false;
      return /(?:window\.(?:setTimeout|setInterval|addEventListener)|document\.addEventListener|document\.body)/.test(
        read(file)
      );
    })
    .map(rel);
  r.check(
    "features / services / host 的监听器、定时器与 body 统一走 Host 作用域",
    globalHits.length === 0,
    globalHits.join(", ")
  );

  // 6. Feature Module 不用裸定时器（必须带 events）——捕获 window 之外的写法
  const bareTimers = inDir("src/features/").filter((file) =>
    /(?:^|[^.\w])(?:setTimeout|setInterval)\s*\(/m.test(read(file))
  );
  r.check(
    "Feature Module 不直接使用裸 setTimeout / setInterval",
    bareTimers.length === 0,
    bareTimers.map(rel).join(", ")
  );

  // 7. 版本号三处同步（manifest / package / versions.json）
  const manifest = JSON.parse(read(path.join(H.ROOT, "manifest.json")));
  const pkg = JSON.parse(read(path.join(H.ROOT, "package.json")));
  const versions = JSON.parse(read(path.join(H.ROOT, "versions.json")));
  r.check(
    "manifest / package / versions.json 版本与 id 一致",
    manifest.id === "writing-toolkit" &&
      pkg.name === "obsidian-writing-toolkit" &&
      manifest.version === pkg.version &&
      Object.prototype.hasOwnProperty.call(versions, manifest.version)
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
