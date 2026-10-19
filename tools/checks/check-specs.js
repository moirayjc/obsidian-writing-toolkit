/**
 * 检查：SPEC 规格结构与流程一致性（文档级）。
 *
 * 这是 specs/README.md 里那套流程的机器闸门。它**不能**判断需求写得好不好，
 * 但能拦住「结构上不可能被验收」和「验收证据是空话」的规格：
 *   · 目录名 / frontmatter 的 id、slug、size、status、真实日期、owners 不合法或不一致；
 *   · `related` 指向仓库外、目录，或不存在的文件；
 *   · done / dropped 却没有移入 `specs/archive/`；draft / approved 混进 archive；
 *   · approved 之后仍残留占位符（注释先剥掉，避免模板注释被当成正文）；
 *   · 需求表没有 FR，或 FR / NFR 内容为空；验收表没有 AC；
 *   · AC 的验证方式没有按「自动：/ 人工：」分段，自动项指向不存在或未被 verify 执行的检查；
 *   · 人工项写成「检查一下是否正常」这类无法照做的空话；
 *   · 任务没有覆盖某个 FR / AC，或引用了不存在的 ID；CHORE 也不许夹带不存在的 ID；
 *   · verifying 一条验收证据都没勾（空勾选也算没勾）；
 *   · done 还有未勾选的任务 / 证据 / 文档更新，或证据是「随便」「好像没问题」这类空话；
 *   · 编号重复、从 0 开始、目录名非法、specs/ 根下散装文档。
 *
 * 另外会打印一条**提示**（不影响退出码）：工作区有未提交的源码改动、但没有处于
 * implementing / verifying 的规格——提醒你可能漏了 spec。
 *
 * 反向验证（本检查必须能变红，改完任何规则都重跑一遍）：
 *   1. 把 AC 的自动验证改成一个不存在的 check-xxx.js → 应失败；
 *   2. 把某个 done 规格移回根目录 → 应失败；
 *   3. 让一条任务引用 FR-999（包括 `[CHORE FR-999]`）→ 应失败；
 *   4. 在 approved 规格里留一个占位符（含小写 todo）→ 应失败；
 *   5. 把 verifying 规格的证据全部取消勾选 / 改成「随便」→ 应失败；
 *   6. 把 `related` 改成仓库外路径 → 应失败；
 *   7. 在注释里塞一张 `| AC-009 | … |` 表格 → 应仍然通过（假阳性回归）。
 *
 * 用 WT_SPECS_ROOT 指向一份临时副本即可做反向验证：
 *   cp -R specs /tmp/specs-bad
 *   WT_SPECS_ROOT=/tmp/specs-bad node tools/checks/check-specs.js
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const SPECS_ROOT = process.env.WT_SPECS_ROOT
  ? path.resolve(process.env.WT_SPECS_ROOT)
  : path.join(H.ROOT, "specs");
const ARCHIVE = "archive";
const TEMPLATE = "_template";

const STATUSES = ["draft", "approved", "implementing", "verifying", "done", "dropped"];
const SIZES = ["M", "L"];
const SPEC_SECTIONS = [
  "问题与动机",
  "用户场景",
  "需求",
  "验收标准",
  "非目标",
  "影响面与约束",
  "开放问题",
  "评审记录",
];
/** 章节非空门槛（剥掉 HTML 注释后的可见字符数）。「无」类章节给 1 即可。 */
const SECTION_MIN = {
  问题与动机: 30,
  用户场景: 20,
  非目标: 1,
  影响面与约束: 20,
  开放问题: 1,
  评审记录: 10,
};
/** plan.md 只强制三节；多写不拦，少写必红。 */
const PLAN_REQUIRED = ["方案概述", "影响与兼容", "实施与验证顺序"];
const TASK_SECTIONS = ["任务", "验收证据", "文档更新"];
const DIR_RE = /^(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\b(todo|tbd|fixme)\b|待补|待填/i;
/** 人工验收 / 验收证据里的空话。命中最少一条即判不合格。 */
const VAGUE_RE = /检查一下|是否正常|正常即可|随便|好像|确认无误|看看就行|一切正常|没有问题|没问题|符合预期|应该可以|大概可以/;
/** AC 自动验收允许引用的 npm 脚本（dev 常驻、release 会打包，都不许当验收）。 */
const AUTO_SCRIPTS = ["check", "verify", "spec:check", "lint:gate"];
/** 验收证据里可以出现的自动命令（比 AC 多 build / spec:list，它们不常驻、不打包）。 */
const EVIDENCE_SCRIPTS = AUTO_SCRIPTS.concat(["build", "spec:list"]);
/** 自动验收里 check 脚本必须写完整相对路径（前后不能再接字符，防 .bak / .exe / 前缀目录）。 */
const CHECK_PATH_RE = /(?:^|[^\w/.-])tools\/checks\/check-[a-z0-9-]+\.js(?![\w.-])/g;
/** 结果必须是「正面的」结论：出现否定词就不算通过。 */
const RESULT_RE = /\d|通过|干净|成功|变红|全绿|一致|无报错|归档/;
const NEGATIVE_RE = /未通过|不通过|失败|不一致|不干净|不成功|没有通过|异常/;
const MANUAL_MIN = 20; // 人工验收步骤最少字数（去掉「人工：」前缀后）
const EVIDENCE_MIN = 12; // 验收证据最少字数（去掉「自动：/人工：」前缀后）

/* ── 解析工具 ─────────────────────────────────────────────── */

function stripComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, "");
}

function unquote(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** 极简 YAML frontmatter：只支持 scalar、内联数组、块数组。 */
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: null, body: text };
  const data = {};
  let lastKey = null;
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && lastKey) {
      if (!Array.isArray(data[lastKey])) data[lastKey] = [];
      data[lastKey].push(unquote(item[1]));
      continue;
    }
    const pair = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    lastKey = key;
    const value = rawValue.trim();
    if (!value) {
      data[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((part) => unquote(part.trim()))
        .filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function stripFences(text) {
  const out = [];
  let fence = null; // { char, len }
  for (const line of String(text).split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const seq = marker[1];
      if (fence === null) fence = { char: seq[0], len: seq.length };
      else if (seq[0] === fence.char && seq.length >= fence.len) fence = null;
      continue;
    }
    if (fence === null) out.push(line);
  }
  return out.join("\n");
}

function normalizeHeading(text) {
  return String(text)
    .replace(/^[0-9０-９]+[.、]\s*/, "")
    .trim();
}

/** 按二级标题切段（标题里的数字前缀会被去掉）。 */
function splitSections(markdown) {
  const sections = new Map();
  let current = null;
  for (const line of stripFences(stripComments(markdown)).split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = normalizeHeading(heading[1]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  return sections;
}

function sectionText(sections, name) {
  return (sections.get(name) || []).join("\n").trim();
}

/** 去掉标记后的可见字符数（中文按字算，空白不计）。 */
function visibleLength(text) {
  return String(text).replace(/\s+/g, "").length;
}

function splitRow(line) {
  const text = String(line).trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** 解析 markdown 表格：返回 [{ header, rows }]（只认带外框竖线的表）。 */
function parseTables(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const tables = [];
  for (let i = 1; i < lines.length; i++) {
    if (!/^\|[\s:|-]+\|$/.test(lines[i])) continue;
    if (!lines[i - 1].startsWith("|")) continue;
    const header = splitRow(lines[i - 1]);
    const rows = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith("|"); j++) {
      rows.push(splitRow(lines[j]));
    }
    tables.push({ header, rows });
  }
  return tables;
}

function checkboxItems(text) {
  const items = [];
  for (const line of stripFences(stripComments(text)).split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
    if (match) items.push({ checked: match[1].toLowerCase() === "x", text: match[2].trim() });
  }
  return items;
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return null;
  }
}

function listDirs(parent) {
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== TEMPLATE && name !== ARCHIVE);
}

function listSpecDirs(root) {
  const active = listDirs(root).map((name) => ({
    name,
    dir: path.join(root, name),
    archived: false,
  }));
  const archiveRoot = path.join(root, ARCHIVE);
  const archived = listDirs(archiveRoot).map((name) => ({
    name,
    dir: path.join(archiveRoot, name),
    archived: true,
  }));
  return { active, archived };
}

/** 日期必须真实存在（2026-13-45 不算）。 */
function isValidDate(text) {
  if (!DATE_RE.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** 校验一条 AC 的「验证方式」：按「；」分段，每段必须以 自动：/ 人工： 开头。 */
function parseVerification(cell) {
  const segments = String(cell)
    .split(/[；;](?=\s*(?:自动|人工)[：:])/)
    .map((part) => part.trim())
    .filter(Boolean);
  const auto = [];
  const manual = [];
  const problems = [];
  for (const segment of segments) {
    const autoMatch = segment.match(/^自动[：:]\s*(.*)$/);
    const manualMatch = segment.match(/^人工[：:]\s*(.*)$/);
    if (autoMatch) {
      if (/自动[：:]|人工[：:]/.test(autoMatch[1])) {
        problems.push("自动段里还藏着第二个「自动：/人工：」标记");
      }
      auto.push(autoMatch[1].trim());
    } else if (manualMatch) {
      if (/自动[：:]|人工[：:]/.test(manualMatch[1])) {
        problems.push("人工段里还藏着第二个「自动：/人工：」标记");
      }
      manual.push(manualMatch[1].trim());
    } else {
      problems.push("分段「" + segment.slice(0, 18) + "…」没有以「自动：」或「人工：」开头");
    }
  }
  return { auto, manual, problems };
}

/* ── 单个规格校验 ─────────────────────────────────────────── */

function validateSpec(entry, r, context) {
  const { name, dir, archived } = entry;
  const label = "[" + name.slice(0, 3) + "]";
  const dirMatch = name.match(DIR_RE);
  if (!dirMatch) {
    r.check(label + " 目录名符合 `NNN-slug`（slug 不含首尾 / 连续连字符）", false, name);
    return null;
  }
  const dirId = dirMatch[1];
  const dirSlug = dirMatch[2];
  if (dirId === "000") {
    r.check(label + " 编号从 001 起", false, name);
    return null;
  }

  const specPath = path.join(dir, "spec.md");
  const specSource = readIfExists(specPath);
  if (specSource === null) {
    r.check(label + " 存在 spec.md", false, dir);
    return null;
  }
  const { data, body } = parseFrontmatter(specSource);
  if (!data) {
    r.check(label + " spec.md 有 YAML frontmatter", false);
    return null;
  }

  const status = String(data.status || "");
  const size = String(data.size || "");
  const id = String(data.id || "");
  const slug = String(data.slug || "");
  const title = String(data.title || "");
  const created = String(data.created || "");
  const updated = String(data.updated || "");
  const owners = Array.isArray(data.owners) ? data.owners : data.owners ? [data.owners] : [];
  const related = Array.isArray(data.related) ? data.related : data.related ? [data.related] : [];

  const metaOk =
    id === dirId &&
    slug === dirSlug &&
    title.trim().length > 0 &&
    SIZES.includes(size) &&
    STATUSES.includes(status) &&
    isValidDate(created) &&
    isValidDate(updated) &&
    updated >= created &&
    owners.length > 0 &&
    owners.every((owner) => String(owner).trim().length > 0);
  r.check(
    label + " 目录 / frontmatter 合法（id、slug、title、size、status、真实日期、owners 非空）",
    metaOk,
    JSON.stringify({ id, slug, size, status, created, updated, owners })
  );

  const badRelated = related.filter((rel) => {
    const clean = String(rel).split("#")[0].trim();
    if (!clean || path.isAbsolute(clean)) return true;
    const resolved = path.resolve(H.ROOT, clean);
    if (resolved !== H.ROOT && !resolved.startsWith(H.ROOT + path.sep)) return true;
    try {
      const real = fs.realpathSync(resolved); // 仓库内符号链接指向仓库外也要拦
      if (real !== H.ROOT && !real.startsWith(H.ROOT + path.sep)) return true;
      return !fs.statSync(real).isFile();
    } catch (_) {
      return true;
    }
  });
  r.check(label + " related 都是仓库内的真实文件", badRelated.length === 0, badRelated.join(", "));

  const shouldArchive = status === "done" || status === "dropped";
  r.check(
    label + " 状态与位置一致（done/dropped 必须在 archive/，其余不得在 archive/）",
    shouldArchive === archived,
    "status=" + status + " archived=" + archived
  );

  const specSections = splitSections(body);
  const oneLiner = stripFences(stripComments(body))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("> 一句话"));
  const oneLinerText = oneLiner ? oneLiner.replace(/^>\s*一句话[：:]\s*/, "").trim() : "";

  if (status === "dropped") {
    r.check(
      label + " dropped 写明 dropped_reason",
      String(data.dropped_reason || "").trim().length > 0
    );
    return { id, dirId, slug, title, status, size, archived };
  }

  if (status === "draft") {
    const draftMotivation = visibleLength(sectionText(specSections, "问题与动机"));
    r.check(
      label + " draft：「一句话」与「问题与动机」是实写的（模板注释不算）",
      visibleLength(oneLinerText) >= 8 && draftMotivation >= 20,
      "一句话 " + visibleLength(oneLinerText) + " 字 / 问题与动机 " + draftMotivation + " 字"
    );
    return { id, dirId, slug, title, status, size, archived };
  }

  const clean = (text) => stripFences(stripComments(text));
  const placeholderSources = [clean(specSource)];
  const taskSource = readIfExists(path.join(dir, "tasks.md"));
  const planSource = readIfExists(path.join(dir, "plan.md"));
  if (taskSource) placeholderSources.push(clean(taskSource));
  if (planSource) placeholderSources.push(clean(planSource));
  const placeholderHit = placeholderSources
    .map((text) => text.match(PLACEHOLDER_RE))
    .find(Boolean);
  r.check(
    label + " 无占位符残留（{{…}} / TODO / TBD / 待补）",
    !placeholderHit,
    placeholderHit ? "命中：" + placeholderHit[0] : ""
  );

  const missingSpecSections = SPEC_SECTIONS.filter((section) => !specSections.has(section));
  const thinSpecSections = SPEC_SECTIONS.filter((section) => {
    if (!specSections.has(section)) return false;
    const min = SECTION_MIN[section];
    return min !== undefined && visibleLength(sectionText(specSections, section)) < min;
  });
  r.check(
    label + " spec.md 章节齐全且有实质内容（注释不算正文）",
    missingSpecSections.length === 0 && thinSpecSections.length === 0,
    "缺少：" + (missingSpecSections.join("、") || "无") +
      "；太空：" + (thinSpecSections.join("、") || "无")
  );

  // 只在「需求」「验收标准」两节里解析表格，避免正文里的说明表格被当成需求
  const idTables = (section) =>
    parseTables(sectionText(specSections, section))
      .filter((table) => /^id$/i.test(String(table.header[0] || "").trim()))
      .flatMap((table) => table.rows);
  const requirementRows = idTables("需求");
  const acceptanceRows = idTables("验收标准");
  const badIdRows = [
    ...requirementRows
      .filter((row) => !/^(FR|NFR)-\d{3}$/.test(row[0]))
      .map((row) => "需求表里的「" + row[0] + "」不是 FR-/NFR- 加三位数字"),
    ...acceptanceRows
      .filter((row) => !/^AC-\d{3}$/.test(row[0]))
      .map((row) => "验收表里的「" + row[0] + "」不是 AC- 加三位数字"),
  ];
  const frRows = requirementRows.filter((row) => /^FR-\d{3}$/.test(row[0]));
  const nfrRows = requirementRows.filter((row) => /^NFR-\d{3}$/.test(row[0]));
  const acRows = acceptanceRows.filter((row) => /^AC-\d{3}$/.test(row[0]));

  const duplicate = (list) => list.length !== new Set(list).size;
  const frIds = frRows.map((row) => row[0]);
  const nfrIds = nfrRows.map((row) => row[0]);
  const acIds = acRows.map((row) => row[0]);

  r.check(
    label + " 需求表：至少 1 条 FR，ID 唯一，需求内容非空；NFR 内容非空",
    frIds.length > 0 &&
      !duplicate(frIds) &&
      frRows.every((row) => visibleLength(row[1] || "") >= 4) &&
      !duplicate(nfrIds) &&
      nfrRows.every((row) => visibleLength(row[1] || "") >= 4)
  );

  r.check(
    label + " 需求 / 验收表里没有格式不合法的 ID 行",
    badIdRows.length === 0,
    badIdRows.join("；")
  );

  const acProblems = [];
  const checkFilesInSpec = [];
  const missingChecks = [];
  const unlistedChecks = [];
  const vagueManual = [];
  for (const row of acRows) {
    const [acId, text, verify] = row;
    if (!acId || visibleLength(text || "") < 4 || !verify) {
      acProblems.push((acId || "?") + " 缺验收标准或验证方式");
      continue;
    }
    const parsed = parseVerification(verify);
    acProblems.push(...parsed.problems.map((problem) => acId + " " + problem));
    if (parsed.auto.length === 0 && parsed.manual.length === 0) {
      acProblems.push(acId + " 既没有自动验收也没有人工验收");
    }
    for (const autoText of parsed.auto) {
      const checkPaths = [...autoText.matchAll(CHECK_PATH_RE)].map((match) =>
        (match[0].match(/tools\/checks\/check-[a-z0-9-]+\.js/) || [""])[0]
      );
      const npmScripts = [...autoText.matchAll(/npm run ([a-z][a-z:-]*)/g)].map((match) => match[1]);
      for (const script of npmScripts) {
        if (!AUTO_SCRIPTS.includes(script)) {
          acProblems.push(acId + " 自动验收不能引用 npm run " + script +
            "（白名单：" + AUTO_SCRIPTS.join(" / ") + "）");
        }
      }
      for (const script of npmScripts) {
        if (!context.scripts.includes(script)) {
          acProblems.push(acId + " 引用的 npm run " + script + " 在 package.json 里不存在");
        }
      }
      if (checkPaths.length === 0 && npmScripts.length === 0) {
        acProblems.push(acId + " 自动验收必须写完整路径 `tools/checks/check-*.js` 或白名单脚本");
      }
      if (NEGATIVE_RE.test(autoText)) {
        acProblems.push(acId + " 自动验收写的是否定结果（" + autoText.slice(0, 16) + "…）");
      }
      for (const checkPath of checkPaths) {
        const file = path.basename(checkPath);
        if (!checkFilesInSpec.includes(file)) checkFilesInSpec.push(file);
        if (!fs.existsSync(path.join(H.ROOT, checkPath))) {
          missingChecks.push(acId + " → " + checkPath);
        } else if (!context.runAllEntries.has(file)) {
          unlistedChecks.push(acId + " → " + file);
        }
      }
    }
    for (const manualText of parsed.manual) {
      if (visibleLength(manualText) < MANUAL_MIN) {
        acProblems.push(acId + " 人工验收缺少可照做的步骤（至少 " + MANUAL_MIN + " 字）");
      } else if (VAGUE_RE.test(manualText)) {
        vagueManual.push(acId + " → " + manualText.slice(0, 20));
      }
    }
  }
  r.check(
    label + " 验收表：至少 1 条 AC，ID 唯一，验证方式按「自动：/人工：」分段且可判定",
    acIds.length > 0 && !duplicate(acIds) && acProblems.length === 0,
    acProblems.join("；")
  );
  r.check(
    label + " 自动验收指向的检查脚本都存在",
    missingChecks.length === 0,
    missingChecks.join("；")
  );
  r.check(
    label + " 自动验收指向的检查都在 run-all.sh 里（verify 真的会跑）",
    unlistedChecks.length === 0,
    unlistedChecks.join("；")
  );
  r.check(label + " 人工验收不是空话", vagueManual.length === 0, vagueManual.join("；"));

  if (!taskSource) {
    r.check(label + " 存在 tasks.md", false, dir);
    return null;
  }
  const taskSections = splitSections(taskSource);
  const missingTaskSections = TASK_SECTIONS.filter((section) => !taskSections.has(section));
  r.check(
    label + " tasks.md 章节齐全（任务 / 验收证据 / 文档更新）",
    missingTaskSections.length === 0,
    "缺少：" + missingTaskSections.join("、")
  );

  const taskItems = checkboxItems(sectionText(taskSections, "任务"));
  const taskProblems = [];
  const taskRefs = new Set();
  const seenTaskIds = new Set();
  for (const item of taskItems) {
    const match = item.text.match(/^(T-\d{3})\s*(.*)$/);
    if (!match) {
      taskProblems.push("无法解析任务：" + item.text.slice(0, 24));
      continue;
    }
    const taskId = match[1];
    if (seenTaskIds.has(taskId)) taskProblems.push("任务 ID 重复：" + taskId);
    seenTaskIds.add(taskId);
    const rest = match[2].trim();
    const refPart = (rest.match(/^\[([^\]]*)\]/) || [null, ""])[1];
    const refs = [...refPart.matchAll(/(?:FR|AC|NFR)-\d{3}/g)].map((ref) => ref[0]);
    if (visibleLength(rest.replace(/^\[[^\]]*\]/, "")) < 4) {
      taskProblems.push(taskId + " 任务内容为空");
    }
    for (const ref of refs) {
      const known = frIds.includes(ref) || acIds.includes(ref) || nfrIds.includes(ref);
      if (!known) taskProblems.push(taskId + " 引用了不存在的 " + ref);
    }
    // 只有非 CHORE 任务才计入覆盖
    if (refPart.includes("CHORE")) continue;
    if (refs.length === 0) {
      taskProblems.push(taskId + " 没有 [FR/AC] 引用，也没有 [CHORE]");
      continue;
    }
    for (const ref of refs) taskRefs.add(ref);
  }
  r.check(
    label + " 任务格式合法、ID 唯一、引用存在、内容非空",
    taskItems.length > 0 && taskProblems.length === 0,
    taskProblems.join("；")
  );

  const uncoveredFr = frIds.filter((frId) => !taskRefs.has(frId));
  const uncoveredAc = acIds.filter((acId) => !taskRefs.has(acId));
  r.check(
    label + " 每个 FR / AC 都有（非 CHORE）任务覆盖",
    uncoveredFr.length === 0 && uncoveredAc.length === 0,
    "缺任务：" + [...uncoveredFr, ...uncoveredAc].join("、")
  );

  if (size === "L") {
    if (!planSource) {
      r.check(label + " L 级存在 plan.md", false, dir);
    } else {
      const planSections = splitSections(planSource);
      const missingPlan = PLAN_REQUIRED.filter((section) => !planSections.has(section));
      const thinPlan = PLAN_REQUIRED.filter(
        (section) =>
          planSections.has(section) && visibleLength(sectionText(planSections, section)) < 20
      );
      r.check(
        label + " L 级 plan.md 有「方案概述 / 影响与兼容 / 实施与验证顺序」且非空",
        missingPlan.length === 0 && thinPlan.length === 0,
        "缺少：" + (missingPlan.join("、") || "无") + "；太空：" + (thinPlan.join("、") || "无")
      );
    }
  }

  const evidence = checkboxItems(sectionText(taskSections, "验收证据"));
  const checkedEvidence = evidence.filter((item) => item.checked);
  const emptyChecks = checkedEvidence.filter(
    (item) => visibleLength(item.text.replace(/^(自动|人工)[：:]/, "")) < EVIDENCE_MIN
  );
  const vagueEvidence = checkedEvidence.filter((item) => VAGUE_RE.test(item.text));
  const weakEvidence = checkedEvidence.filter((item) => {
    if (!/^自动[：:]/.test(item.text)) return false;
    const body = item.text.replace(/^自动[：:]/, "");
    const checkPaths = [...body.matchAll(CHECK_PATH_RE)].map((match) =>
      (match[0].match(/tools\/checks\/check-[a-z0-9-]+\.js/) || [""])[0]
    );
    const scripts = [...body.matchAll(/npm run ([a-z][a-z:-]*)/g)].map((match) => match[1]);
    const badCheck = checkPaths.find(
      (checkPath) => !fs.existsSync(path.join(H.ROOT, checkPath))
    );
    const badScript = scripts.find(
      (script) => !EVIDENCE_SCRIPTS.includes(script) || !context.scripts.includes(script)
    );
    const hasCommand = checkPaths.length > 0 || scripts.length > 0;
    const negative = NEGATIVE_RE.test(body);
    return !hasCommand || badCheck !== undefined || badScript !== undefined ||
      negative || !RESULT_RE.test(body);
  });
  const hasAutoEvidence = checkedEvidence.some((item) => /^自动[：:]/.test(item.text));

  if (status === "verifying" || status === "done") {
    const unchecked = taskItems.filter((item) => !item.checked);
    r.check(
      label + " verifying / done：任务全部勾选",
      unchecked.length === 0,
      "未勾选：" + unchecked.map((item) => item.text.slice(0, 16)).join("；")
    );
    r.check(
      label + " verifying / done：至少 1 条自动验收证据已勾选，且写清「跑了什么 + 什么结果」",
      hasAutoEvidence && emptyChecks.length === 0 && vagueEvidence.length === 0 && weakEvidence.length === 0,
      "已勾 " + checkedEvidence.length + " 条；太空：" + emptyChecks.length +
        "；空话：" + vagueEvidence.length + "；缺命令或结果：" + weakEvidence.length
    );
  }

  if (status === "done") {
    const docs = checkboxItems(sectionText(taskSections, "文档更新"));
    r.check(
      label + " done：验收证据与文档更新全部勾选，且证据 ≥2 条",
      evidence.length >= 2 &&
        evidence.every((item) => item.checked) &&
        docs.length >= 1 &&
        docs.every((item) => item.checked),
      "证据 " + evidence.filter((item) => item.checked).length + "/" + evidence.length +
        "；文档 " + docs.filter((item) => item.checked).length + "/" + docs.length
    );
    const touchesChecks = checkFilesInSpec.length > 0;
    if (touchesChecks) {
      const hasReverse = checkedEvidence.some(
        (item) =>
          item.text.includes("反向验证") &&
          /变红|失败|不符合预期|报警/.test(item.text) &&
          !/没做|未做|没有做|仍然是全绿/.test(item.text)
      );
      r.check(
        label + " done：动过自动检查，证据里有「反向验证」",
        hasReverse,
        "AC 引用了 " + checkFilesInSpec.join(", ")
      );
    }
  }

  return { id, dirId, slug, title, status, size, archived };
}

/* ── 全局校验 ─────────────────────────────────────────────── */

function validateGlobal(root, r, context) {
  r.check("SPECS 根目录存在", fs.existsSync(root), root);

  const templateDir = path.join(root, TEMPLATE);
  const templates = ["spec.md", "plan.md", "tasks.md"];
  const missingTemplates = templates.filter((file) => !fs.existsSync(path.join(templateDir, file)));
  const badPlaceholders = templates.filter((file) => {
    const source = readIfExists(path.join(templateDir, file));
    return !source || !source.includes("{{id}}");
  });
  r.check(
    "模板齐全且可被 spec:new 替换（{{id}} 占位符存在）",
    missingTemplates.length === 0 && badPlaceholders.length === 0,
    missingTemplates.concat(badPlaceholders).join(", ")
  );

  const allowedRootFiles = ["README.md", "constitution.md"];
  const strayDocs = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => !allowedRootFiles.includes(name))
    : [];
  const archiveRoot = path.join(root, ARCHIVE);
  const strayArchiveDocs = fs.existsSync(archiveRoot)
    ? fs
        .readdirSync(archiveRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name !== ".gitkeep")
        .map((entry) => ARCHIVE + "/" + entry.name)
    : [];
  r.check(
    "specs/ 根与 archive/ 里没有散装文件（只有 README.md / constitution.md / .gitkeep）",
    strayDocs.length === 0 && strayArchiveDocs.length === 0,
    strayDocs.concat(strayArchiveDocs).join(", ")
  );

  r.check(
    "check-specs.js 自己在 run-all.sh 里且未被注释（门禁必须被 verify 执行）",
    context.runAllEntries.has("check-specs.js")
  );

  const { active, archived } = listSpecDirs(root);
  const names = [...active, ...archived].map((entry) => entry.name);
  const invalid = names.filter((name) => !DIR_RE.test(name));
  const ids = names.map((name) => Number(name.slice(0, 3))).sort((a, b) => a - b);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  // 符号链接的规格目录会被 isDirectory() 跟随，等于把校验对象指到仓库外
  const symlinked = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isSymbolicLink())
        .map((entry) => entry.name)
    : [];
  r.check(
    "规格编号唯一、目录名合法（允许删号，不要求连续），且 specs/ 下没有符号链接",
    invalid.length === 0 && duplicateIds.length === 0 && symlinked.length === 0,
    [invalid.length ? "非法目录：" + invalid.join(", ") : "",
     duplicateIds.length ? "重复编号：" + duplicateIds.join(", ") : "",
     symlinked.length ? "符号链接：" + symlinked.join(", ") : ""].filter(Boolean).join("；")
  );
}

/* ── 提示：工作区改动 ↔ 活跃规格 ──────────────────────────── */

const SOURCE_RE = /^(src\/|styles\.css$|tools\/|package\.json$|manifest\.json$|versions\.json$)/;

function workingTreeHint(root) {
  if (process.env.WT_SPECS_ROOT) return "";
  try {
    const status = require("child_process")
      .execFileSync("git", ["status", "--porcelain"], {
        cwd: H.ROOT,
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString();
    const changed = status
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter((file) => SOURCE_RE.test(file));
    if (changed.length === 0) return "";
    const { active, archived } = listSpecDirs(root);
    const inFlight = active.filter((entry) => {
      const source = readIfExists(path.join(entry.dir, "spec.md"));
      if (!source) return false;
      const data = parseFrontmatter(source).data || {};
      return ["implementing", "verifying"].includes(String(data.status || ""));
    });
    // 已归档的规格也算「这次改动有规格」——否则归档后立刻误报
    const covering = [...inFlight, ...archived];
    // 在途规格必须真的在正文里提到改动的文件，才算「这次改动有规格」
    const inFlightText = covering
      .map((entry) =>
        ["spec.md", "plan.md", "tasks.md"]
          .map((file) => readIfExists(path.join(entry.dir, file)) || "")
          .join("\n")
      )
      .map((text) => stripFences(stripComments(text)))
      .join("\n");
    const uncovered = changed.filter((file) => !inFlightText.includes(file));
    if (uncovered.length === 0) return "";
    return (
      "· 提示：工作区有 " + uncovered.length + " 个源码 / 检查文件改动（" +
      uncovered.slice(0, 3).join("、") + (uncovered.length > 3 ? " 等" : "") +
      (inFlight.length > 0 ? "）没有被任何在途规格提到" : "），且没有处于 implementing / verifying 的规格") +
      "。如果是 M / L 级改动，先按 specs/README.md 建 spec；确认是 S 级可忽略本条。"
    );
  } catch (_) {
    return "";
  }
}

/* ── 入口 ─────────────────────────────────────────────────── */

function readFrontmatterOnly(dir) {
  const source = readIfExists(path.join(dir, "spec.md"));
  return source ? parseFrontmatter(source).data : null;
}

function list(root) {
  const { active, archived } = listSpecDirs(root);
  const rows = [...active, ...archived].map((entry) => {
    const data = readFrontmatterOnly(entry.dir) || {};
    return {
      id: entry.name.slice(0, 3),
      status: String(data.status || "?"),
      size: String(data.size || "?"),
      title: String(data.title || entry.name),
      where: entry.archived ? "archive" : "active",
    };
  });
  if (rows.length === 0) {
    console.log("（还没有规格）");
    return;
  }
  console.log("编号  级别  状态          位置     标题");
  for (const row of rows) {
    console.log(
      `${row.id}   ${row.size.padEnd(4)} ${row.status.padEnd(13)} ${row.where.padEnd(8)} ${row.title}`
    );
  }
}

function main() {
  const root = SPECS_ROOT;
  if (process.argv.includes("--list") || process.argv.includes("--pending")) {
    let isDir = false;
    try {
      isDir = fs.statSync(root).isDirectory();
    } catch (_) {
      isDir = false;
    }
    const markers = ["README.md", "constitution.md", path.join(TEMPLATE, "spec.md")];
    const looksLikeSpecs = markers.some((marker) => fs.existsSync(path.join(root, marker)));
    if (!isDir || !looksLikeSpecs) {
      console.error("✘ specs 根目录形态不对（需要目录且含 README.md / constitution.md / _template/spec.md）：" + root);
      return 1;
    }
  }
  if (process.argv.includes("--list")) {
    list(root);
    return 0;
  }
  if (process.argv.includes("--pending")) {
    const { active, archived } = listSpecDirs(root);
    const pending = [...active, ...archived]
      .map((entry) => ({ entry, data: readFrontmatterOnly(entry.dir) || {} }))
      .filter(({ data }) => ["implementing", "verifying"].includes(String(data.status || "")));
    if (pending.length === 0) {
      console.log("✔ 没有处于 implementing / verifying 的规格");
      return 0;
    }
    console.log("✘ 还有未完成的规格（implementing / verifying）：");
    for (const { entry, data } of pending) {
      console.log("    " + entry.name + "  status=" + data.status + "  " + (data.title || ""));
    }
    console.log("  完成并归档后再发布；确认与本次发布无关时，加 --allow-pending-spec 显式放行。");
    return 1;
  }

  const runAll = readIfExists(path.join(H.ROOT, "tools", "checks", "run-all.sh")) || "";
  // 只认 CHECKS 数组里未被注释掉的 "file.js:label" 条目
  const checksBlock = (runAll.match(/CHECKS=\(([\s\S]*?)\n\)/) || [null, ""])[1];
  const runAllEntries = new Set(
    checksBlock
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"'))
      .map((line) => (line.match(/^"([^":]+\.js)\s*:/) || [null, null])[1])
      .filter(Boolean)
  );
  let scripts = [];
  try {
    scripts = Object.keys(JSON.parse(readIfExists(path.join(H.ROOT, "package.json")) || "{}").scripts || {});
  } catch (_) {
    scripts = [];
  }
  const context = { runAll, runAllEntries, scripts };

  const r = H.createReporter("SPEC 规格与流程（specs/）");
  validateGlobal(root, r, context);
  const { active, archived } = listSpecDirs(root);
  const ordered = [...active, ...archived].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of ordered) validateSpec(entry, r, context);
  const ok = r.finish();

  const hint = workingTreeHint(root);
  if (hint) console.log("  " + hint);
  return ok ? 0 : 1;
}

process.exit(main());
