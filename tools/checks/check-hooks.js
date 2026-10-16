/**
 * 检查：诊断埋点是否还在（源码级守卫）。
 *
 * 为什么需要它：`check-diagnostics.js` 测的是 diagnostics 模块**自己**的行为，
 * 所以把 `commentSkip(...)` 这个调用从业务代码里删掉，它照样全绿——这是实测过的
 * 真实盲区。埋点一旦被顺手删掉，自检报告就永远显示 0 次，反而比没有更误导。
 *
 * 所以这里做一件朴素的事：读关键源文件，确认那些埋点调用点仍然存在。
 * 这是**文本级**检查（不跑行为），能挡住"被删掉/被重构掉"，挡不住"被改成错的参数"。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

/**
 * 每个埋点用正则匹配**调用**（而不是 `includes` 子串）。
 *
 * 两个踩过的坑，改这段前先看：
 * 1. 最初写成 `includes("commentSkip(")`，结果函数**声明** `export function commentSkip(`
 *    也命中，于是把调用删掉守卫照样通过（反向验证时发现的假绿）。
 * 2. 改用 `^\s+commentSkip\(` 后又匹配不上——**本仓库部分文件用全角空格（U+3000）缩进，
 *    而 JS 正则的 `\s` 不匹配 U+3000**。所以缩进一律写成 `[ \t\u3000]*`。
 */
const IND = "[ \\t\\u3000]*"; // 半角空格 / Tab / 全角空格
const call = (name) => new RegExp("^" + IND + name + "\\(", "m");

const REQUIRED_HOOKS = {
  "src/commentDecor.ts": [
    // 注意：这一处调用在 `if (reason) commentSkip(...)` 这一行里，不在行首
    /if \(reason\) commentSkip\(/,
    call("commentBuilt"),
    call("commentRefreshDispatched"),
    call("commentError"),
    /commentDecorDiag\.createCalls\+\+/,
    /commentDecorDiag\.eligible\+\+/,
    /commentDecorDiag\.composingDeferred\+\+/,
  ],
  "src/commentStore.ts": [
    call("commentLoaded"),
    call("commentWrote"),
    call("commentSidecarDeleted"),
    /commentIoDiag\.lastWriteError\s*=/,
  ],
  "src/main.ts": [
    /statsDiag\.editorChanges\+\+/,
    /statsDiag\.programmaticIgnored\+\+/,
    /statsDiag\.externalSyncIgnored\+\+/,
    /statsDiag\.skippedNotChapter\+\+/,
    /statsDiag\.vaultModifies\+\+/,
    call("statsApplied"),
    call("recordLocate"),
    call("recordStatusRefresh"),
    // 三条自检命令与实现
    /id:\s*"comment-selfcheck"/,
    /id:\s*"stats-selfcheck"/,
    /id:\s*"full-selfcheck"/,
    call("return buildCommentDiagReport"),
    call("return buildStatsDiagReport"),
    new RegExp("^" + IND + "(?:void )?this\\.runDiagnostic\\(", "m"),
  ],
};

function main() {
  const r = H.createReporter("诊断埋点守卫（源码级）");

  for (const [file, patterns] of Object.entries(REQUIRED_HOOKS)) {
    const full = path.join(H.ROOT, file);
    if (!fs.existsSync(full)) {
      r.check(file + " 存在", false);
      continue;
    }
    const src = fs.readFileSync(full, "utf8");
    const missing = patterns
      .filter((re) => !re.test(src))
      .map((re) => String(re).replace(/^\^?\\s\+\^?|\/m?$/g, "").slice(0, 40));
    r.check(
      file + " 的 " + patterns.length + " 个埋点都是「调用」而非声明",
      missing.length === 0,
      missing.length ? "缺失: " + missing.join(" / ") : ""
    );
  }

  // 反向提醒：诊断模块报告里必须带版本标记，否则以后分不清新旧报告
  const diagSrc = fs.readFileSync(path.join(H.ROOT, "src/diagnostics.ts"), "utf8");
  r.check(
    "两份报告都带版本标记（便于区分新旧报告）",
    diagSrc.includes("comment-diag-") && diagSrc.includes("stats-diag-")
  );

  return r.finish();
}

try {
  const ok = main();
  H.cleanup();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error("运行失败：" + e.stack);
  H.cleanup();
  process.exit(2);
}
