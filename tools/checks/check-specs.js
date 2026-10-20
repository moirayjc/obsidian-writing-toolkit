/**
 * 检查：specs/ 下的规格只守形式，不判断内容好坏（流程见 specs/README.md）。
 *
 *   node tools/checks/check-specs.js          # 校验（verify 会跑）
 *   node tools/checks/check-specs.js --list   # 列出全部 spec 与状态
 *
 * 守的是：文件名与 frontmatter 一致、编号不重复（含 archive/ 旧目录）、六节齐全且不空、
 * 没有 {{…}} 占位符、「怎么算完」每条以「自动：/人工：」开头且自动项真的会被 verify 执行、
 * done 全部勾选、dropped 写了理由。
 *
 * archive/ 是旧流程的冻结记录，只参与编号查重，不校验结构。
 *
 * 反向验证：WT_SPECS_ROOT 指向一份临时副本（含 archive/），往里放一份坏 spec，应当变红。
 * tools/release.sh 在跑检查前会清掉这个变量。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const SPECS = process.env.WT_SPECS_ROOT
  ? path.resolve(process.env.WT_SPECS_ROOT)
  : path.join(H.ROOT, "specs");
const NAME_RE = /^(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const STATUSES = ["draft", "done", "dropped"];
const SECTIONS = ["一句话", "为什么", "做什么", "不做什么", "怎么算完", "记录"];
const NPM_SCRIPTS = ["check", "build", "verify", "lint:gate"];
const IGNORED_FILES = new Set(["README.md", "_template.md"]);

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return data;
}

/** 按「## 标题」切节；去掉 HTML 注释后再判断空不空。 */
function parseSections(text) {
  const body = text.replace(/^---[\s\S]*?\n---\r?\n/, "");
  const sections = {};
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  for (const key of Object.keys(sections)) {
    sections[key] = sections[key].join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
  }
  return sections;
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** run-all.sh 的 CHECKS 数组里未被注释掉的检查文件名。 */
function registeredChecks() {
  const runAll = fs.readFileSync(path.join(H.ROOT, "tools", "checks", "run-all.sh"), "utf8");
  const block = (runAll.match(/CHECKS=\(([\s\S]*?)\n\)/) || [null, ""])[1];
  return new Set(
    block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => (line.match(/^"([^":]+\.js)\s*:/) || [null, null])[1])
      .filter(Boolean)
  );
}

/** 校验「怎么算完」里的一条；返回问题描述，没问题返回 null。 */
function checkDoneItem(item) {
  const auto = item.text.match(/^自动[:：]\s*(.*)$/);
  const manual = item.text.match(/^人工[:：]\s*(.*)$/);
  if (!auto && !manual) return "没有以「自动：」或「人工：」开头：" + item.text;
  if (manual) {
    return manual[1].replace(/\s/g, "").length >= 15
      ? null
      : "人工项太短，写不清点哪里、看什么：" + item.text;
  }
  const scripts = [...auto[1].matchAll(/tools\/checks\/(check-[\w-]+\.js)/g)].map((m) => m[1]);
  const npm = [...auto[1].matchAll(/npm run ([\w:]+)/g)].map((m) => m[1]);
  if (scripts.length === 0 && npm.length === 0) {
    return "自动项没有指向 tools/checks/check-*.js 或 npm run check/build/verify/lint:gate：" + item.text;
  }
  const badNpm = npm.find((s) => !NPM_SCRIPTS.includes(s));
  if (badNpm) return "自动项只认 npm run " + NPM_SCRIPTS.join(" / ") + "，不认 npm run " + badNpm;
  return null;
}

function listSpecs() {
  if (!fs.existsSync(SPECS)) return { files: [], strays: [] };
  const files = [];
  const strays = [];
  for (const entry of fs.readdirSync(SPECS, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED_FILES.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (entry.name !== "archive") strays.push(entry.name + "/");
      continue;
    }
    files.push(entry.name);
  }
  return { files: files.sort(), strays };
}

function archivedIds() {
  const dir = path.join(SPECS, "archive");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => (name.match(/^(\d{3})-/) || [null, null])[1])
    .filter(Boolean);
}

function main() {
  const { files, strays } = listSpecs();

  if (process.argv.includes("--list")) {
    for (const name of files) {
      const data = parseFrontmatter(fs.readFileSync(path.join(SPECS, name), "utf8")) || {};
      console.log(`  ${(data.status || "?").padEnd(8)} ${name}  ${data.title || ""}`);
    }
    if (files.length === 0) console.log("  （没有进行中的 spec；旧记录在 specs/archive/）");
    return 0;
  }

  const r = H.createReporter("规格形式（specs/）");
  const checks = registeredChecks();

  r.check(
    "specs/ 下只有 README、模板、archive/ 与 NNN-slug.md",
    strays.length === 0 && files.every((name) => NAME_RE.test(name)),
    [...strays, ...files.filter((name) => !NAME_RE.test(name))].join(", ")
  );

  const ids = [...archivedIds(), ...files.map((name) => (name.match(NAME_RE) || [])[1])];
  const dupes = ids.filter((id, i) => id && ids.indexOf(id) !== i);
  r.check("编号不重复（含 archive/）", dupes.length === 0, [...new Set(dupes)].join(", "));

  for (const name of files.filter((n) => NAME_RE.test(n))) {
    const [, id] = name.match(NAME_RE);
    const text = fs.readFileSync(path.join(SPECS, name), "utf8");
    const data = parseFrontmatter(text);
    const label = `[${name}]`;

    const metaProblems = [];
    if (!data) metaProblems.push("缺 frontmatter");
    else {
      if (data.id !== id) metaProblems.push(`id=${data.id} 与文件名不一致`);
      if (!data.title) metaProblems.push("title 为空");
      if (!STATUSES.includes(data.status)) metaProblems.push(`status=${data.status} 不在 ${STATUSES.join("/")}`);
      if (!isRealDate(data.created)) metaProblems.push(`created=${data.created} 不是真实日期`);
      if (data.status === "dropped" && !data.dropped_reason) metaProblems.push("dropped 必须写 dropped_reason");
    }
    r.check(label + " frontmatter 合法", metaProblems.length === 0, metaProblems.join("；"));

    const placeholder = text.match(/\{\{[^}]*\}\}/);
    r.check(label + " 没有残留 {{…}} 占位符", !placeholder, placeholder && placeholder[0]);

    const sections = parseSections(text);
    const empty = SECTIONS.filter((s) => !sections[s]);
    r.check(label + " 六节齐全且不空（只有模板注释算空）", empty.length === 0, "缺或空：" + empty.join("、"));

    const items = (sections["怎么算完"] || "")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ done: m[1] !== " ", text: m[2].trim() }));
    const itemProblems = items.map((item) => checkDoneItem(item)).filter(Boolean);
    if (items.length === 0) itemProblems.push("至少要有一条勾选项");
    r.check(label + " 「怎么算完」每条可判定", itemProblems.length === 0, itemProblems.join("；"));

    if (data && data.status === "done") {
      const missing = items
        .flatMap((item) => [...item.text.matchAll(/tools\/checks\/(check-[\w-]+\.js)/g)].map((m) => m[1]))
        .filter((file) => !checks.has(file) || !fs.existsSync(path.join(H.ROOT, "tools", "checks", file)));
      r.check(label + " done：自动项指向的检查存在且被 run-all.sh 执行", missing.length === 0, missing.join(", "));
      const open = items.filter((item) => !item.done);
      r.check(label + " done：「怎么算完」全部勾选", open.length === 0, open.map((i) => i.text).join("；"));
    }
  }

  return r.finish() ? 0 : 1;
}

process.exit(main());
