/**
 * 检查脚本的公共工具。
 *
 * 项目没有测试框架，但纯逻辑层（comments/formatWrap/wordcount/project/codeStore）
 * 可以用 Node 直接跑**真实实现**，不必启动 Obsidian。这里放三件事：
 *   1. 用本地 esbuild 按需编译单个 .ts 模块（不联网）
 *   2. 从构建产物 main.js 里按 banner 注释切出某个模块的段落
 *   3. 统一的断言/报告输出
 *
 * 详见 docs/插件设计文档.md §4.9。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", ".."); // 插件根目录
const ESBUILD = path.join(ROOT, "node_modules", ".bin", "esbuild");
// 惰性创建：不编译任何东西的检查（如 check-specs）不该留下临时目录
let TMP_DIR = null;
function tmpDir() {
  if (!TMP_DIR) TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wt-check-"));
  return TMP_DIR;
}

function assertEsbuild() {
  if (!fs.existsSync(ESBUILD)) {
    console.error("找不到 esbuild：" + ESBUILD + "\n请先 npm install（离线亦可，依赖已在本仓库 node_modules）。");
    process.exit(2);
  }
}

/**
 * 把单个 .ts 编译成 CommonJS。
 * obsidian 默认始终外置；其它仅在运行时按需 require 的模块（如 electron）可追加外置，
 * 避免为了测一段纯逻辑把整个桌面端依赖打进检查产物。
 */
function compile(entry, name, externals) {
  assertEsbuild();
  const out = path.join(tmpDir(), name + ".js");
  execFileSync(
    ESBUILD,
    [path.join(ROOT, entry), "--bundle", "--format=cjs", "--target=ES2020",
     "--external:obsidian", ...(externals || []).map((dep) => "--external:" + dep),
     "--outfile=" + out, "--log-level=warning"],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  return require(out);
}

/** TypeScript 源码 → JS 文本（用于把方法体拿出来执行）。 */
function transpileTs(sourceTs, name, globalName) {
  assertEsbuild();
  const src = path.join(tmpDir(), name + ".ts");
  const out = path.join(tmpDir(), name + ".js");
  fs.writeFileSync(src, sourceTs, "utf8");
  execFileSync(
    ESBUILD,
    [src, "--format=iife", "--target=ES2020", "--global-name=" + globalName,
     "--outfile=" + out, "--log-level=warning"],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  return fs.readFileSync(out, "utf8");
}

/**
 * 从 main.js 里切出 src/<name>.ts 对应的打包段落。
 * esbuild 会写 `// src/<name>.ts` banner，段落结束于下一个 banner。
 */
function sliceBundleModule(name, bundlePath) {
  const bundle = bundlePath || path.join(ROOT, "main.js");
  if (!fs.existsSync(bundle)) {
    console.error("找不到构建产物 " + bundle + "，请先 npm run build。");
    process.exit(2);
  }
  const lines = fs.readFileSync(bundle, "utf8").split("\n");
  const banner = "// src/" + name;
  const start = lines.findIndex((l) => l.trim() === banner);
  if (start < 0) {
    console.error("main.js 里找不到 " + banner + "（构建产物可能过期，请重新构建）。");
    process.exit(2);
  }
  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith("// src/"));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  return body.join("\n");
}

/** 按符号定位 + 花括号配平，抽取一个方法的完整源码。 */
function extractMethod(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error("找不到符号：" + signature);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("花括号未配平：" + signature);
}

/** 用桩替换 require("obsidian")。返回一个还原函数。 */
function stubObsidian(moduleStub) {
  const Module = require("module");
  const orig = Module._load;
  Module._load = function (request) {
    if (request === "obsidian") return moduleStub;
    return orig.apply(this, arguments);
  };
  return () => { Module._load = orig; };
}

/** 极简断言器。 */
function createReporter(title) {
  let pass = 0;
  const failures = [];
  console.log("\n【" + title + "】");
  return {
    check(name, cond, detail) {
      if (cond) {
        console.log("  ✅ " + name);
        pass++;
      } else {
        console.log("  ❌ " + name + (detail ? " — " + detail : ""));
        failures.push(name);
      }
    },
    finish() {
      const total = pass + failures.length;
      console.log("  → " + pass + "/" + total + " 通过");
      return failures.length === 0;
    },
  };
}

function cleanup() {
  if (!TMP_DIR) return;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  TMP_DIR = null;
}

module.exports = {
  ROOT, ESBUILD, tmpDir,
  compile, transpileTs, sliceBundleModule, extractMethod,
  stubObsidian, createReporter, cleanup,
};

// 每个检查退出时自动清掉自己的临时目录（惰性创建过才需要清）
process.on("exit", cleanup);
