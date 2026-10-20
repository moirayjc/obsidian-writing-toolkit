#!/usr/bin/env node
/**
 * 新建一份 spec：取下一个编号，套 `specs/_template.md`，生成 `specs/NNN-slug.md`。
 *
 *   npm run spec:new -- <slug> "<标题>"
 *
 * 只生成 draft 模板，不替你写内容。刚生成时 `npm run spec:check` 会报红
 * （六节还只有模板注释），写完就绿。流程见 specs/README.md。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SPECS = path.join(ROOT, "specs");
const TEMPLATE = path.join(SPECS, "_template.md");

/** 与 check-specs.js 一致：小写字母、数字、单连字符。 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
  console.error("✘ " + message);
  process.exit(1);
}

/** 现有 spec 与 archive/ 里旧目录占用的编号。 */
function usedIds() {
  const ids = new Set();
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const match = name.match(/^(\d{3})-/);
      if (match) ids.add(Number(match[1]));
    }
  };
  scan(SPECS);
  scan(path.join(SPECS, "archive"));
  return ids;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) fail('用法：npm run spec:new -- <slug> "<标题>"');
  const [slug, rawTitle] = args;
  const title = rawTitle.trim();
  if (!SLUG_RE.test(slug)) {
    fail("slug 只能用小写字母、数字和单连字符（例：chapter-word-goal）：" + slug);
  }
  if (!title) fail("标题不能为空");
  if (/["\\{}\r\n]/.test(title)) fail("标题不能含引号、反斜杠、{ } 或换行（会破坏 frontmatter）");
  if (!fs.existsSync(TEMPLATE)) fail("缺少模板：specs/_template.md");

  const id = String(Math.max(0, ...usedIds()) + 1).padStart(3, "0");
  if (id.length > 3) fail("编号超过 999");
  const target = path.join(SPECS, `${id}-${slug}.md`);

  const content = fs
    .readFileSync(TEMPLATE, "utf8")
    .split("{{id}}").join(id)
    .split("{{title}}").join(title)
    .split("{{date}}").join(today());

  try {
    // wx：同名文件已存在就失败，不覆盖
    fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    fail("创建失败：" + path.relative(ROOT, target) + " — " + error.code);
  }

  console.log("✔ 已创建 " + path.relative(ROOT, target));
  console.log("  写完六节 → 请作者确认并在「记录」里补一行 → 再开始实现。");
}

main();
