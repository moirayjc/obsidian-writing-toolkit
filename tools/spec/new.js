#!/usr/bin/env node
/**
 * 新建一份 SPEC 规格：自动取下一个编号、套 `specs/_template/` 模板。
 *
 *   npm run spec:new -- <slug> "<标题>" [--size M|L] [--owner 名字]
 *
 * 例：
 *   npm run spec:new -- unify-draft-path "统一 isDraftPath 的三套语义" --size M
 *   npm run spec:new -- theme-tone-contrast "高对比度换 Notion 皮肤" --size L
 *
 * 它只创建空模板（status: draft），不会替你想需求，也不会推进状态。
 * ⚠️ 刚建出来的 draft **不能通过** `npm run spec:check`：draft 门槛要求
 * 「一句话」与「问题与动机」是实写的，不许留着模板注释当正文。这是有意的——
 * 半成品规格不该全绿。
 *
 * 目录规范与流程见 specs/README.md。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SPECS = path.join(ROOT, "specs");
const TEMPLATE = path.join(SPECS, "_template");
const ARCHIVE = path.join(SPECS, "archive");

/** 与 check-specs.js 的 DIR_RE 一致：不许首尾 / 连续连字符。 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
  console.error("✘ " + message);
  process.exit(1);
}

function gitUserName() {
  try {
    return execFileSync("git", ["config", "user.name"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch (_) {
    return "";
  }
}

function parseArgs(argv) {
  const args = { size: "M", owner: "", positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--size" || arg === "--owner") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(arg + " 缺少取值");
      i++;
      if (arg === "--size") args.size = value.toUpperCase();
      else args.owner = value.trim();
    } else if (arg.startsWith("--")) {
      fail("未知参数：" + arg);
    } else {
      args.positionals.push(arg);
    }
  }
  return args;
}

function usedIds() {
  const ids = new Set();
  for (const dir of [SPECS, ARCHIVE]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^(\d{3})-/);
      if (match) ids.add(Number(match[1]));
    }
  }
  return ids;
}

const LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * 原子地占住下一个编号。
 *
 * 只靠「扫描 → max+1 → mkdir」并发时三个进程会拿到同一个号（因为目录名不同，
 * mkdir 都会成功）。这里用 `fs.openSync(..., "wx")` 的排他创建做锁：
 * POSIX 上它是原子的，谁先建出 `.lock-NNN` 谁赢，其余顺延到下一个号。
 * 锁在目标目录写完后立刻删除；进程崩溃留下的旧锁超过 5 分钟视为失效。
 */
function reserveId() {
  const used = usedIds();
  for (let n = Math.max(0, ...used) + 1; n <= 999; n++) {
    const id = String(n).padStart(3, "0");
    if (used.has(n)) continue;
    const lock = path.join(SPECS, ".lock-" + id);
    let fd;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // 清理崩溃残留的旧锁，再试一次同一个号
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          fd = fs.openSync(lock, "wx");
        }
      } catch (_) {
        continue;
      }
      if (fd === undefined) continue;
    }
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return { id, lock };
  }
  fail("编号超过 999，需要调整目录规范");
}

function fillTemplate(file, values) {
  let source = fs.readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(values)) {
    source = source.split("{{" + key + "}}").join(value);
  }
  const leftover = source.match(/\{\{[^}]+\}\}/);
  if (leftover) {
    fail("模板 " + path.basename(file) + " 里还有未替换的占位符：" + leftover[0]);
  }
  return source;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.positionals.length !== 2) {
    fail('用法：npm run spec:new -- <slug> "<标题>" [--size M|L] [--owner 名字]');
  }
  const [slug, title] = args.positionals;
  if (!SLUG_RE.test(slug)) {
    fail("slug 只能用小写字母、数字和单连字符（例：unify-draft-path）：" + slug);
  }
  const cleanTitle = title.trim();
  if (!cleanTitle) fail("标题不能为空");
  if (/[{}]/.test(cleanTitle)) fail("标题里不能带 { }（会与模板占位符冲突）");
  if (/[\r\n\t\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(title)) {
    fail("标题不能含换行或控制字符");
  }
  if (/["'`\\]/.test(cleanTitle)) fail("标题不能含引号或反斜杠（会破坏 frontmatter）");
  if (!["M", "L"].includes(args.size)) fail("--size 只能是 M 或 L");
  const owner = (args.owner || gitUserName()).trim();
  if (!owner) fail("拿不到 git user.name，请显式传 --owner <名字>");
  if (/[\r\n\t\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(owner)) {
    fail("--owner 不能含换行或控制字符");
  }
  if (/[{}"'`\\]/.test(owner)) fail("--owner 不能含引号、反斜杠或 { }（会破坏 frontmatter）");

  if (!fs.existsSync(SPECS)) fail("找不到 specs/ 目录，请在插件仓库根目录下运行");
  const { id, lock } = reserveId();
  try {
    create(id, { slug, title: cleanTitle, size: args.size, owner });
  } finally {
    // 无论成功、校验失败还是写盘失败，都不许把锁留在库里
    fs.rmSync(lock, { force: true });
  }
}

function create(id, options) {
  const { slug, title: cleanTitle, size, owner } = options;
  const dirName = id + "-" + slug;
  const target = path.join(SPECS, dirName);
  if (fs.existsSync(target)) {
    fail("目录已存在：" + path.relative(ROOT, target));
  }

  const today = new Date();
  const date =
    today.getFullYear() +
    "-" +
    String(today.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(today.getDate()).padStart(2, "0");
  const values = { id, title: cleanTitle, slug, size, date, owner };

  const files = ["spec.md", "tasks.md"];
  if (size === "L") files.push("plan.md");

  // 先全部渲染到内存，任何一步失败都不要在库里留下半成品目录
  const rendered = [];
  for (const file of files) {
    const template = path.join(TEMPLATE, file);
    if (!fs.existsSync(template)) fail("缺少模板：" + path.relative(ROOT, template));
    rendered.push([file, fillTemplate(template, values)]);
  }

  try {
    fs.mkdirSync(target);
  } catch (error) {
    fail("创建目录失败：" + path.relative(ROOT, target) + " — " + error.code);
  }
  try {
    for (const [file, content] of rendered) {
      fs.writeFileSync(path.join(target, file), content, "utf8");
    }
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    fail("写入失败，已回滚 " + path.relative(ROOT, target) + "：" + error.message);
  }

  console.log("✔ 已创建 SPEC-" + id + "：" + cleanTitle);
  for (const [file] of rendered) console.log("    " + path.relative(ROOT, path.join(target, file)));
  console.log("");
  console.log("下一步：");
  console.log("  1. 写 spec.md：「一句话」→ 问题与动机 → 用户场景 → 需求 → 验收标准；");
  console.log("     ⚠️ 现在 `npm run spec:check` 是红的：draft 门槛要求这两处是实写的；");
  console.log("  2. 评审通过后把 status 改成 approved，并在评审记录补一行；");
  if (size === "L") {
    console.log("  3. 补 plan.md（方案概述 / 影响与兼容 / 实施与验证顺序）与 tasks.md；");
  } else {
    console.log("  3. 补 tasks.md（任务 / 验收证据 / 文档更新）；");
  }
  console.log("  4. npm run spec:check 转绿后开始实现；完成后按 README 推进状态。");
}

main();
