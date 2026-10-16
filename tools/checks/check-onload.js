/**
 * 检查：onload 的体量守卫（源码级）。
 *
 * 背景：`onload` 曾经是 **478 行**——加载主题、建状态栏、注册视图、注册命令、
 * 挂五组事件、恢复初始文档，全挤在一个方法里。改任何一处都得先读完整个加载流程，
 * 这是实实在在的摩擦。2026-10-16 按「注册面」拆成 5 个 `registerXxx()`，降到 177 行。
 *
 * 这个守卫做两件事：
 *   1. **onload 别再涨回去**——超过阈值就失败，提示"新功能请抽成 registerXxx()"；
 *   2. 拆出去的方法与调用点都还在——防止有人删了调用（那会静默少注册一整组功能，
 *      TypeScript 不会报错，因为方法存在、只是没人调）。
 *
 * 这是文本级检查（不跑行为）。`onload` 里的初始化顺序**不能在检查里验证**，
 * 所以拆方法时务必"在原位置调用"，不要重排。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

/** onload 的行数上限。当前 177 行，留出余量；改大之前先想想能不能抽方法。 */
const ONLOAD_MAX_LINES = 220;

/** 从 onload 里拆出去的方法：必须「有定义」且「被调用」。 */
const EXTRACTED = [
  "registerCommands",
  "registerCommentInteractions",
  "registerWorkspaceEvents",
  "registerVaultEvents",
  "restoreInitialDocument",
];

/** 取出 onload 的方法体（按花括号配平）。 */
function readOnload(src) {
  const start = src.indexOf("  async onload() {");
  if (start < 0) throw new Error("找不到 onload");
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("onload 花括号未配平");
}

function main() {
  const r = H.createReporter("onload 体量守卫（源码级）");
  const src = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const onload = readOnload(src);
  const lines = onload.split("\n").length;

  r.check(
    `onload 不超过 ${ONLOAD_MAX_LINES} 行（当前 ${lines} 行）`,
    lines <= ONLOAD_MAX_LINES,
    lines > ONLOAD_MAX_LINES
      ? `超了 ${lines - ONLOAD_MAX_LINES} 行 —— 新功能请抽成 private registerXxx()，` +
        `并在 onload 的**原位置**调用（初始化顺序不能重排）`
      : ""
  );

  for (const name of EXTRACTED) {
    const defined = new RegExp(`^  private ${name}\\(\\): void \\{`, "m").test(src);
    const called = new RegExp(`^\\s+this\\.${name}\\(\\);$`, "m").test(onload);
    r.check(`${name}() 有定义`, defined);
    r.check(`${name}() 被 onload 调用`, called, called ? "" : "方法在、但没人调 = 静默少注册一整组功能");
  }

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