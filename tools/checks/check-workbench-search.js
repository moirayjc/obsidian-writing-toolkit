/**
 * 编辑台搜索检查（源码级，SPEC-004：只保留全书搜索，摘掉替换）。
 *
 * 产品决定：编辑台的搜索面板当前是两行（搜索 + 替换），现在只保留「全书搜索」，
 * 把两行里的「替换」整体摘掉。这个检查把判断固定成一对，缺一不可：
 *
 *   A. 保留项——全书搜索能力仍在：
 *      搜索输入 / 清空、全文扫描与命中模型、命中摘要与上下定位、跳到命中处、
 *      书头搜索按钮与面板开合、搜索相关样式。
 *   B. 移除项——替换功能彻底消失：
 *      替换逻辑符号、替换面板类名、「全部替换」文案、替换样式都不允许残留。
 *
 * 为什么必须成对：只查「替换没了」的话，一个把搜索面板一起误删的改动也能骗过检查；
 * 只查「搜索还在」则抓不住替换没摘干净。按 specs/README.md §7 的要求，新检查必须做
 * 一次反向验证——本检查是在实现改动之前先跑的，移除项为红，证明它真的抓得住替换功能。
 *
 * 扫描范围只有 src/workbench.ts 与 styles.css。不要对 src/** 做「替换为」这类全仓
 * 字面量断言：src/hemingway.ts、src/snapshotDiff.ts 里合法地含「替换为」等字样。
 * 本脚本在 tools/ 下，不参与扫描。
 *
 * 不启动 Obsidian、不依赖 main.js、不联网。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

/** 读取插件根目录下的源文件。 */
function source(relPath) {
  return fs.readFileSync(path.join(H.ROOT, relPath), "utf8");
}

/** 返回 needle 出现的行号（1 起），用于失败时定位。 */
function findLines(text, needle) {
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) hits.push(i + 1);
  }
  return hits;
}

/** 把行号列表压成一句可读详情（最多列 10 个）。 */
function where(lines) {
  const shown = lines.slice(0, 10).join("、");
  return "仍出现在第 " + shown + (lines.length > 10 ? " 等" : "") + " 行";
}

/** 断言某个字面量已不存在（移除项）。 */
function expectsAbsent(r, label, text, needle) {
  const lines = findLines(text, needle);
  r.check(label, lines.length === 0, lines.length ? where(lines) : "");
}

/** 断言某个正则仍能在源码里匹配到（保留项）。 */
function expectsPresent(r, label, text, regex) {
  r.check(label, regex.test(text), "找不到 " + regex);
}

/**
 * 从 marker 匹配处起，按花括号配平抽出一个方法的完整方法体。
 * 找不到 marker 或花括号不配平返回 null（调用方按「缺失」处理）。
 */
function extractMethodBody(text, markerRegex) {
  const match = markerRegex.exec(text);
  if (!match) return null;
  const open = text.indexOf("{", match.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

function main() {
  const r = H.createReporter("编辑台全书搜索（源码级）");
  const workbench = source("src/workbench.ts");
  const styles = source("styles.css");

  // ---------- A. 保留项：全书搜索能力仍在 ----------

  // A1 / A2：搜索输入框与清空按钮的类名（类名字符串字面量，避免匹配到
  // wt-wb-searchbar 之类的前缀相同的类名）。
  expectsPresent(
    r,
    "保留：搜索输入框 .wt-wb-search 仍在 workbench.ts",
    workbench,
    /["'`]wt-wb-search(?=["'`\s])/
  );
  expectsPresent(
    r,
    "保留：清空按钮 .wt-wb-search-clear 仍在 workbench.ts",
    workbench,
    /["'`]wt-wb-search-clear/
  );

  // A3：全文扫描与命中模型。
  r.check(
    "保留：全文扫描与命中模型 scanSearch / searchHits / searchMatches 仍在",
    /\bscanSearch\s*\(/.test(workbench) &&
      /\bsearchHits\b/.test(workbench) &&
      /\bsearchMatches\b/.test(workbench),
    "缺少 scanSearch / searchHits / searchMatches 之一"
  );

  // A4：扫描数据源必须是 cachedRead（落盘的章节）或已打开编辑器的实时文本，
  // 否则会漏掉未保存内容、或根本扫不到全书。只在 scanSearch 方法体里找。
  const scanBody = extractMethodBody(workbench, /private\s+(?:async\s+)?scanSearch\s*\(/);
  r.check(
    "保留：scanSearch 仍用 cachedRead 或已打开编辑器的实时文本扫描",
    scanBody !== null &&
      (/cachedRead\s*\(/.test(scanBody) || /getValue\s*\(\s*\)/.test(scanBody)),
    scanBody === null ? "找不到 scanSearch 方法体" : "方法体里既没有 cachedRead 也没有 getValue()"
  );

  // A5：命中摘要。
  r.check(
    "保留：命中摘要 renderSearchSummary / updateSearchSummaryText 仍在",
    /renderSearchSummary\s*\(/.test(workbench) &&
      /updateSearchSummaryText\s*\(/.test(workbench),
    "缺少 renderSearchSummary / updateSearchSummaryText 之一"
  );

  // A6：上下定位。
  expectsPresent(
    r,
    "保留：上下定位 stepSearchMatch 仍在",
    workbench,
    /stepSearchMatch\s*\(/
  );

  // A7：跳到命中处（选中 + 滚动到命中位置）。
  r.check(
    "保留：跳到命中处 revealSearchMatch / applyEditorSelection 仍在",
    /revealSearchMatch\s*\(/.test(workbench) &&
      /applyEditorSelection\s*\(/.test(workbench),
    "缺少 revealSearchMatch / applyEditorSelection 之一"
  );

  // A8：书头搜索按钮与面板开合。
  expectsPresent(
    r,
    "保留：书头搜索按钮与面板开合 toggleSearchPanel 仍在",
    workbench,
    /toggleSearchPanel\s*\(/
  );

  // A9 / A10 / A11：搜索相关样式仍保留。这里用「后面不能紧跟 - 或字母数字」
  // 的精确类名匹配：.wt-wb-search 不能靠 .wt-wb-searchbar 之类的规则蒙混过关。
  expectsPresent(
    r,
    "保留：styles.css 仍有 .wt-wb-search 规则",
    styles,
    /\.wt-wb-search(?![-\w])/
  );
  expectsPresent(
    r,
    "保留：styles.css 仍有 .wt-wb-search-summary 规则",
    styles,
    /\.wt-wb-search-summary(?![-\w])/
  );
  expectsPresent(
    r,
    "保留：styles.css 仍有 .wt-wb-search-nav 规则",
    styles,
    /\.wt-wb-search-nav(?![-\w])/
  );

  // ---------- B. 移除项：替换功能彻底消失 ----------

  // B1 ~ B8：替换逻辑的符号 / 属性 / 类名字面量（逐个断言，红的时候能直接看到
  // 还残留在哪几行）。B9/B10 用整段类名子串匹配，连 -btn 之类的变体也一并要求清掉。
  const removedSymbols = [
    "replaceCurrent",
    "replaceAll",
    "doReplaceAll",
    "collectMatchOffsets",
    "replaceAllInText",
    "findMatchOffset",
    "replaceQuery",
    "searchRevealAfterScan",
    "wt-wb-replace",
    "wt-wb-search-replace",
  ];
  for (const symbol of removedSymbols) {
    expectsAbsent(
      r,
      "移除：workbench.ts 不再含 " + symbol,
      workbench,
      symbol
    );
  }

  // B11 / B12：按钮、确认框与输入框占位里的中文文案也不能残留。
  // 「替换为…」单独断言：复验发现「换一套新类名、保留同样文案与写入逻辑」能绕过
  // 类名断言，所以文案本身必须自己站岗（AC-001 明确要求它消失）。
  expectsAbsent(r, "移除：workbench.ts 不再含「全部替换」", workbench, "全部替换");
  expectsAbsent(r, "移除：workbench.ts 不再含「替换为…」", workbench, "替换为…");

  // B13 / B14：替换相关样式（同样用子串匹配，-btn 等变体一起清掉）。
  expectsAbsent(r, "移除：styles.css 不再含 .wt-wb-replace", styles, ".wt-wb-replace");
  expectsAbsent(
    r,
    "移除：styles.css 不再含 .wt-wb-search-replace",
    styles,
    ".wt-wb-search-replace"
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
