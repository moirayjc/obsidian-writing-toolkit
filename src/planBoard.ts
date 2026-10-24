/**
 * 写作计划看板：看板文件的解析 / 写回 / 日期判断（纯函数，不碰 Obsidian）。
 *
 * 看板文件是一份人能直接读写的 Markdown，三段标题就是三列：
 *
 * ```markdown
 * ## 待写
 * - [ ] 第十二章打斗收尾 📅 2026-10-25
 * ## 在写
 * - [ ] 第三卷大纲
 * ## 完成
 * - [x] 修改第十一章节奏 ✅ 2026-10-22
 * ```
 *
 * 约定：
 * - 认得的只有「待写 / 在写 / 完成」三个标题（任意级别）和其下的 `- [ ]` / `- [x]` 行；
 *   其余行（说明文字、空行、别的标题）原样留在原处，写回时一个字不动。
 * - 条目下面缩进的行算它的附属行，挪列 / 删除时跟着条目走。
 * - 勾了 `[x]` 的条目不管在哪一段都显示在「完成」列；第一个三列标题之前的未勾条目算「待写」。
 * - 日期写法与 Tasks 插件一致：截止 `📅 YYYY-MM-DD`，完成 `✅ YYYY-MM-DD`。
 * - 作品写成 `📚 书名`；关联章节是正文后面紧跟的 `[[链接]]`（正文中间的链接不算）；
 *   备注就是条目下面缩进的行。一行的写法顺序：`正文 [[章节]] 📚 书名 📅 截止 ✅ 完成`。
 * - 整行只有一个 `[[链接]]` 的条目是「章节卡」：卡片就是这一章，点开直接写。
 * - 列内顺序就是文件里的行序（看板上拖动 = 挪行）；勾完成的排到「完成」段最上面。
 * - 每次修改都「现读文件 → 按条目原文定位 → 改 → 写回」，所以别处同时手改、
 *   网盘同步过来的内容不会被页面上的旧数据盖掉。
 */

export type PlanColumn = "todo" | "doing" | "done";

export const PLAN_COLUMNS: readonly PlanColumn[] = ["todo", "doing", "done"];

export const PLAN_COLUMN_LABEL: Record<PlanColumn, string> = {
  todo: "待写",
  doing: "在写",
  done: "完成",
};

export interface PlanItem {
  /** 定位用：条目原文 + 同原文的第几条（0 起），页面上的旧数据靠它找回文件里的这一行 */
  readonly key: string;
  /** task：普通任务卡；chapter：章节卡（整行只有一个章节链接，卡片就是这一章） */
  readonly kind: "task" | "chapter";
  /** 卡片标题；章节卡是章节名（链接的别名或文件名） */
  readonly text: string;
  /** 截止日 YYYY-MM-DD */
  readonly due: string | null;
  /** 完成日 YYYY-MM-DD（手勾的可能没有） */
  readonly doneAt: string | null;
  /** 显示在哪一列（勾了就是 done） */
  readonly column: PlanColumn;
  /** 备注：条目下面缩进的行（去掉缩进） */
  readonly notes: readonly string[];
  /** 所属作品名（📚） */
  readonly book: string | null;
  /** 关联章节的链接文字（[[…]] 里面的部分） */
  readonly chapter: string | null;
  /** 在文件里的先后（同列内没日期时按它排） */
  readonly order: number;
}

/** 被删掉的条目：撤销时原样放回原位置 */
export interface RemovedPlanItem {
  readonly section: PlanColumn | null;
  readonly index: number;
  readonly lines: readonly string[];
}

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const TASK_RE = /^(\s*)[-*+]\s+\[( |x|X)\]\s?(.*)$/;
const DUE_RE = /\s*📅\s*(\d{4}-\d{2}-\d{2})/u;
const DONE_RE = /\s*✅\s*(\d{4}-\d{2}-\d{2})/u;
const BOOK_RE = /\s*📚\s*(.+?)(?=\s*(?:📅|✅|\[\[)|\s*$)/u;
const CHAPTER_TAIL_RE = /\s*\[\[([^\]]+)\]\]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const LABEL_TO_COLUMN: Record<string, PlanColumn> = {
  待写: "todo",
  在写: "doing",
  完成: "done",
};

/** 新建看板文件时的初始内容 */
export const PLAN_BOARD_TEMPLATE =
  "> 写作计划看板：Writing Toolkit 主页「看板」页读写这份文件，也可以直接在这里编辑。\n" +
  "\n## 待写\n\n## 在写\n\n## 完成\n";

// ---------- 文件结构 ----------

interface TaskEntry {
  kind: "task";
  /** 条目那一行 + 下面缩进的附属行 */
  lines: string[];
}

interface RawEntry {
  kind: "raw";
  line: string;
}

type Entry = TaskEntry | RawEntry;

interface Section {
  /** null：第一个三列标题之前的部分 */
  column: PlanColumn | null;
  /** 标题行原文（column 为 null 时没有） */
  heading: string | null;
  entries: Entry[];
}

interface Doc {
  sections: Section[];
  /** 原文末尾是否有换行（写回时保持） */
  trailingNewline: boolean;
}

function columnOfHeading(line: string): PlanColumn | null {
  const match = HEADING_RE.exec(line);
  if (!match) return null;
  return LABEL_TO_COLUMN[match[1].trim()] ?? null;
}

function parseDoc(content: string): Doc {
  const normalized = content.replace(/\r\n?/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.length
    ? (trailingNewline ? normalized.slice(0, -1) : normalized).split("\n")
    : [];
  const sections: Section[] = [{ column: null, heading: null, entries: [] }];
  let current = sections[0];
  let lastTask: { entry: TaskEntry; indent: number } | null = null;

  for (const line of lines) {
    const column = columnOfHeading(line);
    if (column) {
      current = { column, heading: line, entries: [] };
      sections.push(current);
      lastTask = null;
      continue;
    }
    // 比条目更深的缩进行：算这个条目的附属行
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (lastTask && line.trim() !== "" && indent > lastTask.indent) {
      lastTask.entry.lines.push(line);
      continue;
    }
    const task = TASK_RE.exec(line);
    if (task) {
      const entry: TaskEntry = { kind: "task", lines: [line] };
      current.entries.push(entry);
      lastTask = { entry, indent: task[1].length };
      continue;
    }
    current.entries.push({ kind: "raw", line });
    lastTask = null;
  }
  return { sections, trailingNewline };
}

function serializeDoc(doc: Doc): string {
  const out: string[] = [];
  for (const section of doc.sections) {
    if (section.heading !== null) out.push(section.heading);
    for (const entry of section.entries) {
      if (entry.kind === "raw") out.push(entry.line);
      else out.push(...entry.lines);
    }
  }
  const text = out.join("\n");
  return doc.trailingNewline || text === "" ? text + "\n" : text;
}

interface TaskFields {
  indent: string;
  checked: boolean;
  text: string;
  due: string | null;
  doneAt: string | null;
  book: string | null;
  chapter: string | null;
}

function readTask(line: string): TaskFields | null {
  const match = TASK_RE.exec(line);
  if (!match) return null;
  let rest = match[3];
  const due = DUE_RE.exec(rest)?.[1] ?? null;
  const doneAt = DONE_RE.exec(rest)?.[1] ?? null;
  const book = BOOK_RE.exec(rest)?.[1]?.trim() || null;
  rest = rest.replace(DUE_RE, "").replace(DONE_RE, "").replace(BOOK_RE, "").trim();
  // 行尾的链接是关联章节；整行只有一个链接时就是章节卡（正文为空、章节即卡片）
  const chapter = CHAPTER_TAIL_RE.exec(rest)?.[1]?.trim() || null;
  if (chapter) rest = rest.replace(CHAPTER_TAIL_RE, "").trim();
  return {
    indent: match[1],
    checked: match[2] !== " ",
    text: rest,
    due,
    doneAt,
    book,
    chapter,
  };
}

function writeTask(fields: TaskFields): string {
  let line = `${fields.indent}- [${fields.checked ? "x" : " "}]`;
  if (fields.text) line += ` ${fields.text}`;
  if (fields.chapter) line += ` [[${fields.chapter}]]`;
  if (fields.book) line += ` 📚 ${fields.book}`;
  if (fields.due) line += ` 📅 ${fields.due}`;
  if (fields.checked && fields.doneAt) line += ` ✅ ${fields.doneAt}`;
  return line;
}

function displayColumn(section: Section, fields: TaskFields): PlanColumn {
  if (fields.checked) return "done";
  if (section.column === null || section.column === "done") return "todo";
  return section.column;
}

/** 按原文定位：key = 原文 + "\u0000" + 同原文第几条 */
function keyFor(line: string, seen: Map<string, number>): string {
  const n = seen.get(line) ?? 0;
  seen.set(line, n + 1);
  return `${line}\u0000${n}`;
}

interface Located {
  section: Section;
  index: number;
  entry: TaskEntry;
  fields: TaskFields;
}

function locateTask(doc: Doc, key: string): Located | null {
  const seen = new Map<string, number>();
  for (const section of doc.sections) {
    for (let index = 0; index < section.entries.length; index++) {
      const entry = section.entries[index];
      if (entry.kind !== "task") continue;
      if (keyFor(entry.lines[0], seen) !== key) continue;
      const fields = readTask(entry.lines[0]);
      return fields ? { section, index, entry, fields } : null;
    }
  }
  return null;
}

/** 找某列的段落；没有就在文件末尾补一个标题 */
function sectionFor(doc: Doc, column: PlanColumn): Section {
  const existing = doc.sections.find((s) => s.column === column);
  if (existing) return existing;
  const last = doc.sections[doc.sections.length - 1];
  const tail = last.entries[last.entries.length - 1];
  const needsGap =
    last.heading !== null || last.entries.length > 0
      ? !(tail && tail.kind === "raw" && tail.line.trim() === "")
      : false;
  if (needsGap) last.entries.push({ kind: "raw", line: "" });
  const section: Section = {
    column,
    heading: `## ${PLAN_COLUMN_LABEL[column]}`,
    entries: [],
  };
  doc.sections.push(section);
  doc.trailingNewline = true;
  return section;
}

/** 插到这一段最后一个条目后面（段里还没有条目就紧跟标题）；「完成」段默认插在最前面 */
function appendToSection(section: Section, entry: TaskEntry, toEnd = false): void {
  if (section.column === "done" && !toEnd) {
    const first = section.entries.findIndex((e) => e.kind === "task");
    section.entries.splice(first < 0 ? 0 : first, 0, entry);
    return;
  }
  let at = 0;
  section.entries.forEach((e, i) => {
    if (e.kind === "task") at = i + 1;
  });
  // 段里还没有条目时 at 仍是 0：紧贴标题
  section.entries.splice(at, 0, entry);
}

// ---------- 对外：读 ----------

export function parsePlanBoard(content: string): PlanItem[] {
  const doc = parseDoc(content);
  const items: PlanItem[] = [];
  const seen = new Map<string, number>();
  let order = 0;
  for (const section of doc.sections) {
    for (const entry of section.entries) {
      if (entry.kind !== "task") continue;
      const key = keyFor(entry.lines[0], seen);
      const fields = readTask(entry.lines[0]);
      if (!fields || fields.indent.length > 0) continue;
      items.push({
        key,
        kind: fields.text ? "task" : "chapter",
        text: fields.text || planChapterName(fields.chapter ?? ""),
        due: fields.due,
        doneAt: fields.checked ? fields.doneAt : null,
        column: displayColumn(section, fields),
        notes: entry.lines
          .slice(1)
          .map((line) => line.trim())
          .filter(Boolean),
        book: fields.book,
        chapter: fields.chapter,
        order: order++,
      });
    }
  }
  return items;
}

/** 章节链接的显示名：有别名用别名，否则取路径最后一段（去掉 #标题） */
export function planChapterName(link: string): string {
  const [target, alias] = link.split("|");
  if (alias?.trim()) return alias.trim();
  return target.split("#")[0].split("/").pop()?.trim() || link;
}

/** 某一列的卡片，按文件里的行序（看板上的上下顺序就是行序） */
export function columnItems(items: readonly PlanItem[], column: PlanColumn): PlanItem[] {
  return items.filter((item) => item.column === column).sort((a, b) => a.order - b.order);
}

// ---------- 对外：改 ----------

function cleanText(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(DUE_RE, "")
    .replace(DONE_RE, "")
    .replace(/📚/gu, "")
    .trim();
}

function cleanBook(book: string | null | undefined): string | null {
  const clean = (book ?? "").replace(/[\r\n]+/g, " ").replace(/[📚📅✅]/gu, "").replace(/\[\[|\]\]/g, "").trim();
  return clean || null;
}

function cleanChapter(chapter: string | null | undefined): string | null {
  const clean = (chapter ?? "").replace(/[\r\n[\]]+/g, "").trim();
  return clean || null;
}

/** 备注写成条目下面缩进两格的行（空行去掉，空行会把备注和条目断开） */
function noteLines(notes: string): string[] {
  return notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `  ${line}`);
}

/** 新增条目（加在该列最后）。文字为空时原样返回。 */
export function addPlanItem(
  content: string,
  column: PlanColumn,
  text: string,
  due: string | null,
  today: string,
  book: string | null = null,
  chapter: string | null = null
): string {
  const clean = cleanText(text);
  const link = cleanChapter(chapter);
  // 文字为空时只有带章节才成立（章节卡）
  if (!clean && !link) return content;
  const doc = parseDoc(content);
  const checked = column === "done";
  const line = writeTask({
    indent: "",
    checked,
    text: clean,
    due: due && DATE_RE.test(due) ? due : null,
    doneAt: checked ? today : null,
    book: cleanBook(book),
    chapter: link,
  });
  appendToSection(sectionFor(doc, column), { kind: "task", lines: [line] });
  return serializeDoc(doc);
}

/**
 * 卡片落在哪：插到某张卡前面 / 该列末尾；不指定时放该列末尾，「完成」列放最前
 * （勾选完成的排在最上面）。
 */
export type PlanPlacement = { before: string } | "end";

/** 换列并放到指定位置：进「完成」勾上并记完成日，出「完成」取消勾选并去掉完成日。 */
function relocate(
  doc: Doc,
  hit: Located,
  fields: TaskFields,
  column: PlanColumn,
  today: string,
  before: Located | null,
  place?: PlanPlacement
): void {
  const checked = column === "done";
  const entry: TaskEntry = {
    kind: "task",
    lines: [
      writeTask({ ...fields, checked, doneAt: checked ? fields.doneAt ?? today : null }),
      ...hit.entry.lines.slice(1),
    ],
  };
  hit.section.entries.splice(hit.section.entries.indexOf(hit.entry), 1);
  if (before) {
    const at = before.section.entries.indexOf(before.entry);
    before.section.entries.splice(at, 0, entry);
  } else {
    appendToSection(sectionFor(doc, column), entry, place === "end");
  }
}

/** 挪动卡片：换列和 / 或换位置（拖到某张卡前面 / 列尾）。 */
export function movePlanItem(
  content: string,
  key: string,
  column: PlanColumn,
  today: string,
  place?: PlanPlacement
): string {
  const doc = parseDoc(content);
  const hit = locateTask(doc, key);
  if (!hit) return content;
  // 先在原文里找到落点那张卡（按对象记住），再摘掉被拖的那张，避免同原文条目次序串位
  const beforeKey = place && place !== "end" ? place.before : null;
  const before = beforeKey && beforeKey !== key ? locateTask(doc, beforeKey) : null;
  if (beforeKey && !before) return content;
  relocate(doc, hit, hit.fields, column, today, before, place);
  return serializeDoc(doc);
}

export interface PlanItemPatch {
  text?: string;
  /** null 清除 */
  due?: string | null;
  /** 多行文字；空串清除 */
  notes?: string;
  book?: string | null;
  chapter?: string | null;
  /** 换到另一列（放到该列末尾；「完成」放最前） */
  column?: PlanColumn;
}

/**
 * 改卡片内容（undefined 表示不动，null 表示清除）。
 * 换列也在同一次里做：先改内容再按列挪，避免改完原文变了、第二步按旧原文找不到。
 */
export function editPlanItem(
  content: string,
  key: string,
  patch: PlanItemPatch,
  today = planDayKey(new Date())
): string {
  const doc = parseDoc(content);
  const hit = locateTask(doc, key);
  if (!hit) return content;
  const fields: TaskFields = { ...hit.fields };
  if (patch.text !== undefined) {
    const clean = cleanText(patch.text);
    if (!clean && !fields.chapter) return content;
    fields.text = clean;
  }
  if (patch.due !== undefined) {
    fields.due = patch.due && DATE_RE.test(patch.due) ? patch.due : null;
  }
  if (patch.book !== undefined) fields.book = cleanBook(patch.book);
  if (patch.chapter !== undefined) fields.chapter = cleanChapter(patch.chapter);
  // 章节卡清掉章节就没有标题了：不改
  if (!fields.text && !fields.chapter) return content;
  hit.entry.lines[0] = writeTask(fields);
  if (patch.notes !== undefined) {
    hit.entry.lines = [hit.entry.lines[0], ...noteLines(patch.notes)];
  }
  if (patch.column !== undefined && patch.column !== displayColumn(hit.section, fields)) {
    relocate(doc, hit, fields, patch.column, today, null);
  }
  return serializeDoc(doc);
}

/** 删除条目（连同附属行）；返回删掉的内容，撤销时交给 restorePlanItem。 */
export function removePlanItem(
  content: string,
  key: string
): { content: string; removed: RemovedPlanItem | null } {
  const doc = parseDoc(content);
  const hit = locateTask(doc, key);
  if (!hit) return { content, removed: null };
  hit.section.entries.splice(hit.index, 1);
  return {
    content: serializeDoc(doc),
    removed: {
      section: hit.section.column,
      index: hit.index,
      lines: [...hit.entry.lines],
    },
  };
}

/** 撤销删除：放回原来那一段的原位置（文件这期间变短了就放到段尾）。 */
export function restorePlanItem(content: string, removed: RemovedPlanItem): string {
  const doc = parseDoc(content);
  const section =
    removed.section === null
      ? doc.sections[0]
      : sectionFor(doc, removed.section);
  const index = Math.min(removed.index, section.entries.length);
  section.entries.splice(index, 0, { kind: "task", lines: [...removed.lines] });
  return serializeDoc(doc);
}

// ---------- 日期 ----------

export function planDayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 两个日期相差几天（b − a，按本地日历日） */
export function planDayDiff(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

export type PlanDueState = "overdue" | "today" | "soon" | "later";

export function planDueState(due: string, today: string): PlanDueState {
  const diff = planDayDiff(today, due);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 2) return "soon";
  return "later";
}

const WEEKDAY = "日一二三四五六";

/** 日期的口语写法：今天 / 明天 / 昨天 / 周五（一周内）/ 10月25日 / 2027年1月3日 */
export function planDateLabel(date: string, today: string): string {
  const diff = planDayDiff(today, date);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  const d = parseDay(date);
  if (diff > 1 && diff < 7) return `周${WEEKDAY[d.getDay()]}`;
  const sameYear = d.getFullYear() === parseDay(today).getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 「完成」列只展开最近几天完成的 */
export const PLAN_RECENT_DONE_DAYS = 7;

export function isRecentlyDone(item: PlanItem, today: string): boolean {
  if (!item.doneAt) return false;
  const diff = planDayDiff(item.doneAt, today);
  return diff >= 0 && diff < PLAN_RECENT_DONE_DAYS;
}

/** 书桌「计划」卡：已逾期、今天到期、在写（未完成） */
export function planFocusItems(items: readonly PlanItem[], today: string): PlanItem[] {
  const urgent = (item: PlanItem): boolean =>
    !!item.due && planDayDiff(today, item.due) <= 0;
  return items
    .filter((item) => item.column !== "done" && (item.column === "doing" || urgent(item)))
    .sort((a, b) => {
      const ua = urgent(a);
      const ub = urgent(b);
      if (ua !== ub) return ua ? -1 : 1;
      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
      if (!!a.due !== !!b.due) return a.due ? -1 : 1;
      return a.order - b.order;
    });
}

/** 看板文件路径：设置为空时放在「写作」文件夹根目录（共用资料库的上一级） */
export function resolvePlanBoardPath(setting: string, sharedLibraryFolder: string): string {
  const custom = setting.trim().replace(/^\/+/, "");
  if (custom) return /\.md$/i.test(custom) ? custom : `${custom}.md`;
  const parts = sharedLibraryFolder.trim().replace(/^\/+|\/+$/g, "").split("/");
  parts.pop();
  const root = parts.filter(Boolean).join("/");
  return root ? `${root}/写作看板.md` : "写作看板.md";
}
