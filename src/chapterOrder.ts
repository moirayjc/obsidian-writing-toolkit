import { App, TFile } from "obsidian";
import { naturalCompare } from "./outlineText";

/**
 * 小说章节/卷的命名解析与排序。
 *
 * 支持的章节命名：
 * - `第12章 标题` / `第 12 章` / `第十二章` / `第12回` / `第3节`
 * - `序章`、`楔子`、`引子`（视为第 0 章，排在正文之前）
 * - `番外`、`后记`、`尾声`（无编号，排在正文之后）
 * - `025 标题`、`12-标题`、`12.标题`（前导序号）
 * - `正文试写稿（参考版）2`（无编号，按文件名自然序排最后）
 *
 * 卷目录：`第3卷·南巡篇`、`第 3 卷`、`卷三`。
 */

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  贰: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};

const CN_UNITS: Record<string, number> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  千: 1000,
  仟: 1000,
  万: 10000,
};

const CN_NUM = "零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万";

/** 「第 N 章 / 回 / 节」 */
const CHAPTER_RE = new RegExp(`第\\s*(\\d+|[${CN_NUM}]+)\\s*[章回节]`);
/** 前导序号 + 空白：`025 入京` */
const LEADING_SPACE_RE = /^0*(\d{1,4})\s+/;
/** 前导序号 + 分隔符：`12-入京`、`12.入京`（4 位数多为日期如 `0825-`，不认） */
const LEADING_SEQ_RE = /^(\d{1,3})\s*[.、\-_·:：]\s*/;
/** 纯数字文件名：`12` */
const PLAIN_NUM_RE = /^0*(\d{1,4})$/;
/** 正文之前的特殊章节 */
const PRE_RE = /^(序章|序言|序幕|序|楔子|引子|引言|前言)/;
/** 正文之后的特殊章节 */
const POST_RE = /^(番外|外传|后记|尾声|终章|附录)/;
/** 卷目录 */
const VOLUME_RE = new RegExp(
  `第\\s*(\\d+|[${CN_NUM}]+)\\s*卷|^卷\\s*(\\d+|[${CN_NUM}]+)`
);

/** 中文数字转阿拉伯数字；无法解析返回 null。 */
export function chineseToNumber(input: string): number | null {
  if (!input) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  let seen = false;
  for (const ch of input) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
      seen = true;
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      seen = true;
      if (unit === 10000) {
        section = (section + number) * unit;
        total += section;
        section = 0;
      } else {
        section += (number === 0 ? 1 : number) * unit;
      }
      number = 0;
    } else {
      return null;
    }
  }
  if (!seen) return null;
  return total + section + number;
}

/** 阿拉伯数字转中文（1–9999）；超出范围返回 null。 */
export function numberToChinese(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
  const digits = "零一二三四五六七八九";
  const units = ["", "十", "百", "千"];
  const s = String(n);
  let out = "";
  let pendingZero = false;
  for (let i = 0; i < s.length; i++) {
    const d = s.charCodeAt(i) - 48;
    const pos = s.length - 1 - i;
    if (d === 0) {
      if (out) pendingZero = true;
      continue;
    }
    if (pendingZero) {
      out += "零";
      pendingZero = false;
    }
    // 「十二」而不是「一十二」；「一百一十二」里十位的「一」要保留
    if (!(d === 1 && pos === 1 && out === "")) out += digits[d];
    out += units[pos];
  }
  return out;
}

/** 「第 N 章 / 回 / 节」开头（分组版，用于替换编号时保留写法） */
const CHAPTER_HEAD_RE = new RegExp(
  `^(第)(\\s*)(\\d+|[${CN_NUM}]+)(\\s*)([章回节])`
);
/** 前导序号 + 空白：`025 标题` */
const LEAD_SPACE_RE = /^(\d{1,4})(\s+)(.*)$/;
/** 前导序号 + 分隔符：`12-标题`、`12.标题`（4 位数多为日期如 `0825-`，不认） */
const LEAD_PUNCT_RE = /^(\d{1,3})(\s*[.、\-_·:：]\s*)(.*)$/;
/** 纯数字文件名：`025` */
const PLAIN_NUM_ONLY_RE = /^(\d{1,4})$/;

/** 替换前导序号时保留补零宽度：`025` → `024`，`12` → `11`。 */
function serialText(origDigits: string, n: number): string {
  const text = String(n);
  if (/^0/.test(origDigits) && text.length < origDigits.length) {
    return text.padStart(origDigits.length, "0");
  }
  return text;
}

/**
 * 把章节文件名里的编号改成 newNumber，保留原有命名风格：
 * 「第12章」「第 12 回」「第十二章」「025 标题」「12-标题」「12.标题」「12 标题」。
 * 认不出编号写法的返回 null（调用方应跳过，不要硬改文件名）。
 */
export function renumberChapterName(
  basename: string,
  newNumber: number
): string | null {
  if (!Number.isInteger(newNumber) || newNumber < 1) return null;

  const head = CHAPTER_HEAD_RE.exec(basename);
  if (head) {
    const numText = /^\d+$/.test(head[3])
      ? serialText(head[3], newNumber)
      : numberToChinese(newNumber);
    if (!numText) return null;
    return (
      head[1] +
      head[2] +
      numText +
      head[4] +
      head[5] +
      basename.slice(head[0].length)
    );
  }

  const spaced = LEAD_SPACE_RE.exec(basename);
  if (spaced) return serialText(spaced[1], newNumber) + spaced[2] + spaced[3];

  const punct = LEAD_PUNCT_RE.exec(basename);
  if (punct) return serialText(punct[1], newNumber) + punct[2] + punct[3];

  const plain = PLAIN_NUM_ONLY_RE.exec(basename);
  if (plain) return serialText(plain[1], newNumber);

  return null;
}

export interface ParsedChapterName {
  /** 解析出的章号；null 表示没有编号（如「正文试写稿」） */
  number: number | null;
  /** 去掉「第N章」前缀后的标题；可能为空字符串 */
  title: string;
  /** 正文之后的排序位（番外一 → 1、番外二 → 2）；仅用于排序 */
  tail: number | null;
}

function cleanTitle(raw: string): string {
  return raw.replace(/^[\s\-_.、·:：—－）)】\]」』]+/, "").trim();
}

/** 「番外一」「外传二」里的序号 */
function tailOrder(name: string): number | null {
  const m = new RegExp(`(?:番外|外传|附录)\\s*([${CN_NUM}]+|[0-9]+)`).exec(name);
  if (!m) return null;
  const raw = m[1];
  const num = /^\d+$/.test(raw) ? parseInt(raw, 10) : chineseToNumber(raw);
  return num !== null && Number.isFinite(num) ? num : null;
}

/** 解析章节文件名。 */
export function parseChapterName(basename: string): ParsedChapterName {
  const name = basename.trim();
  const chapter = CHAPTER_RE.exec(name);
  if (chapter) {
    const raw = chapter[1];
    const num = /^\d+$/.test(raw) ? parseInt(raw, 10) : chineseToNumber(raw);
    const after = cleanTitle(name.slice(chapter.index + chapter[0].length));
    const before = name.slice(0, chapter.index);
    return {
      number: num !== null && Number.isFinite(num) ? num : null,
      // 「第133章」之前还有内容的（如「（原稿跳号，无第133章）」）保留完整文件名
      title: after || (before.trim() ? name : ""),
      tail: null,
    };
  }
  if (PRE_RE.test(name)) return { number: 0, title: name, tail: null };
  if (POST_RE.test(name)) {
    return { number: null, title: name, tail: tailOrder(name) };
  }
  const lead = LEADING_SPACE_RE.exec(name) ?? LEADING_SEQ_RE.exec(name);
  if (lead) {
    const title = cleanTitle(name.slice(lead[0].length));
    return { number: parseInt(lead[1], 10), title: title || name, tail: null };
  }
  return { number: null, title: name, tail: null };
}

/** 文件名是否像「一个章节」。 */
export function isChapterFileName(basename: string): boolean {
  return (
    CHAPTER_RE.test(basename) ||
    PRE_RE.test(basename) ||
    POST_RE.test(basename) ||
    LEADING_SPACE_RE.test(basename) ||
    LEADING_SEQ_RE.test(basename) ||
    PLAIN_NUM_RE.test(basename)
  );
}

/** 是否为卷目录名（`第3卷·南巡篇`、`卷三`）。 */
export function looksLikeVolumeFolder(name: string): boolean {
  return VOLUME_RE.test(name);
}

/** 卷号（用于排序）；解析不出返回 null。 */
export function volumeNumber(name: string): number | null {
  const m = VOLUME_RE.exec(name);
  if (!m) return null;
  const raw = m[1] ?? m[2];
  if (!raw) return null;
  const num = /^\d+$/.test(raw) ? parseInt(raw, 10) : chineseToNumber(raw);
  return num !== null && Number.isFinite(num) ? num : null;
}

/**
 * 目录名是否像「正文容器」（正文草稿 / 草稿 / 章节 …）。
 * 关键词来自插件设置 `draftKeywords`，与章纲面板共用同一套识别规则。
 */
export function looksLikeDraftFolder(
  name: string,
  keywordsStr: string
): boolean {
  const keywords = (keywordsStr || "")
    .split(/[,，\s]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  // 关键词为空时不做「正文目录」判断（只靠章节命名识别），避免把整库目录都当成正文目录
  if (keywords.length === 0) return false;
  if (keywords.includes("*")) return true;
  const lower = name.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/** 读取 frontmatter 里的 sort_index（数字或数字字符串）。 */
export function sortIndexFor(app: App, file: TFile): number | null {
  const v = app.metadataCache.getFileCache(file)?.frontmatter?.["sort_index"];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface SortableChapter {
  file: TFile;
  number: number | null;
  tail: number | null;
  sortIndex: number | null;
}

/**
 * 章节排序：sort_index 优先，其次解析出的章号，最后文件名自然序。
 * 无编号的（正文试写稿、参考资料等）排在编号章节之后；番外一/番外二按序号。
 */
export function compareChapters(a: SortableChapter, b: SortableChapter): number {
  const sa = a.sortIndex;
  const sb = b.sortIndex;
  if (sa !== null && sb !== null && sa !== sb) return sa - sb;
  if (sa !== null && sb === null) return -1;
  if (sa === null && sb !== null) return 1;

  if (a.number !== null && b.number !== null && a.number !== b.number) {
    return a.number - b.number;
  }
  if (a.number !== null && b.number === null) return -1;
  if (a.number === null && b.number !== null) return 1;

  if (a.tail !== null && b.tail !== null && a.tail !== b.tail) {
    return a.tail - b.tail;
  }
  if (a.tail !== null && b.tail === null) return -1;
  if (a.tail === null && b.tail !== null) return 1;

  return naturalCompare(a.file.basename, b.file.basename);
}

/** 卷排序：卷号优先，其次名称自然序。 */
export function compareVolumes(
  a: { name: string; path: string },
  b: { name: string; path: string }
): number {
  const na = volumeNumber(a.name);
  const nb = volumeNumber(b.name);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  if (na !== null && nb === null) return -1;
  if (na === null && nb !== null) return 1;
  return naturalCompare(a.name, b.name);
}

/* ---------- 全书章节重编号 ---------- */

export interface RenumberPlanItem {
  /** 章号 ≥1 的连续章节，按**全书阅读顺序**排列（跨卷） */
  path: string;
  basename: string;
  from: number;
  to: number;
  newName: string;
  /** 目标路径被占用且那个占用者不在本次计划内——执行时必须跳过，否则会覆盖别人的文件 */
  conflict: boolean;
}

export interface RenumberPlan {
  /** **只含真正要改名的条目**，按目标编号从大到小排列 */
  items: RenumberPlanItem[];
  /** 要改名的条数（= items 里非 conflict 的条数） */
  renames: number;
  conflicts: number;
}

/**
 * 规划「全书章节重编号」：把**章号 ≥1** 的章节按阅读顺序重新编成 1..N 连续。
 *
 * 为什么需要它：原来的重编号（`workbench.ts` 的 `renumberAfterDelete`）从删除位置
 * 往下连减，**遇到第一个编号间断就停**。所以只要编号不是连续的（比如第1卷有 1、3，
 * 第2卷有 2、4），删掉一章后后面**一章都不会动**——实测「1、3、5 删第3章」结果
 * 是「重编号 0 章，第5章纹丝不动」。
 *
 * 本函数按「全书写法」重新推导目标编号，因此天然处理间断。
 * **编号本来就连续时返回的计划里全部 `unchanged`、`renames === 0`**，
 * 所以不会去动一个本来就正确的库。
 *
 * 刻意不动的东西（都不参与编号）：
 * - 序章 / 楔子 / 引子 / 番外 / 后记 / 尾声（`parseChapterName` 给出 number 为 0 或 null）
 * - 认不出编号写法的文件名（`renumberChapterName` 返回 null）
 * - 作者用 frontmatter `sort_index` 显式定制的顺序：那只影响**排序**，
 *   重新编号会跟它对冲，所以这些章节整项跳过
 *
 * 返回的 `items` 顺序是**从大到小**（按目标编号倒序）：大批改名按这个顺序执行，
 * 才能避免「目标名已被另一章占着」的撞名（从高位腾退，低位不会回头撞上）。
 */
/** 重编号只需要这几样，刻意不依赖 `ChapterEntry`（便于单测、也避免循环依赖）。 */
export interface RenumberInput {
  file: { path: string; basename: string };
  number: number | null;
  sortIndex: number | null;
}

/** 章节改名后的目标路径（与执行侧共用同一算法，避免两处各写一遍）。 */
export function planPathFor(currentPath: string, newBasename: string): string {
  const dir = currentPath.slice(0, currentPath.lastIndexOf("/"));
  return dir ? `${dir}/${newBasename}.md` : `${newBasename}.md`;
}

export function planBookRenumber(
  chapters: readonly RenumberInput[],
  /**
   * 库里**当前存在的全部文件路径**（含不参与编号的：资料、番外、未命名稿…）。
   * 用来判断「目标路径上是否真的站着一个不参与编号的文件」。
   * 不传则退化成「只检查参与编号的章节」，会漏掉与资料撞名的情况——
   * 所以调用方**应该传**（`workbench` 传的是 `app.vault.getAllLoadedFiles()`）。
   */
  existingPaths?: ReadonlySet<string>
): RenumberPlan {
  const numbered = chapters.filter(
    (c) => typeof c.number === "number" && c.number >= 1 && c.sortIndex === null
  );
  const owners = new Map<string, number>(); // 路径 → 参与编号的章节下标
  numbered.forEach((c, i) => owners.set(c.file.path, i));

  const items: RenumberPlanItem[] = [];
  const targetTakenBy = new Map<string, number[]>(); // 目标路径 → 想要它的条目下标

  numbered.forEach((c, i) => {
    const target = i + 1;
    const from = c.number as number;
    const newName = renumberChapterName(c.file.basename, target) ?? c.file.basename;
    // 「无需改动」要同时满足：编号已在正确位置 **且** 文件名与目标名一致。
    // 只看编号会让「编号对、但写法不标准」的章节（例如第 2 位却叫「第3章」）被漏改，
    // 表现就是重排后仍然不连续。
    // 注意：`file.basename` 是**不含扩展名**的（码点实测），别拿 `${newName}.md` 去比
    if (from === target && newName === c.file.basename) return;

    const targetPath = planPathFor(c.file.path, newName);
    // 冲突的判定：目标路径上**站着一个不参与编号的文件**才算冲突。
    // - 站着另一个参与编号的章节 → 安全：它自己也要搬走（甚至可能正互补，见下）
    // - 不参与编号（手写资料、被排除的文件）→ 真冲突，跳过，绝不覆盖别人的东西
    //
    // 注意**跨卷**也要正确：例如「第1卷/第3章 → 第1卷/第2章」而「第2卷/第2章 → 第2卷/第3章」，
    // 两个目标路径看起来都被占着，但两章是互补挪位；按目标编号**从大到小**执行时，
    // 高位章节先离开，低位章节再落进去，不会撞名。
    // 目标被占用的两种情形，都要跳过（绝不覆盖别人的东西）：
    // ① 站着另一个**参与编号**的章节 → 安全（它自己也要搬走）
    // ② 站着**不参与编号**的文件（资料/番外/未命名稿）→ 冲突
    const owner = owners.get(targetPath);
    const occupiedByOutsider =
      owner === undefined && (existingPaths ? existingPaths.has(targetPath) : false);
    const conflict = targetPath !== c.file.path && occupiedByOutsider;

    items.push({
      path: c.file.path,
      basename: c.file.basename,
      from,
      to: target,
      newName,
      conflict,
    });
    const list = targetTakenBy.get(targetPath);
    if (list) list.push(items.length - 1);
    else targetTakenBy.set(targetPath, [items.length - 1]);
  });

  // 多个章节想改成**同一个**目标名（章节编号重复）→ 只能有一个成功，其余全部标冲突。
  // 不这么做的话，第二个改名会覆盖第一个，反而把用户的章节弄丢。
  //
  // ⚠️ 必须在**排序之前**标完：下面的 `items.sort()` 是原地排序，
  // 排完再用下标去改就会标错条目（踩过这个坑，症状是「无辜的章节被标成冲突」）。
  for (const [, idxs] of targetTakenBy) {
    if (idxs.length > 1) for (const k of idxs) items[k].conflict = true;
  }

  // 从高位开始改，先腾出位置（改第 N 位为 N+1 时，N+1 位刚好已腾空）
  const ordered = items.sort((a, b) => b.to - a.to);
  return {
    items: ordered,
    renames: ordered.filter((it) => !it.conflict).length,
    conflicts: ordered.filter((it) => it.conflict).length,
  };
}

/** 计划的可读预览（确认弹窗 / 自检报告共用）。 */
export function describeRenumberPlan(plan: RenumberPlan, maxLines = 12): string {
  const lines: string[] = [];
  const changed = plan.items;
  if (changed.length === 0) {
    return "全书章节编号已经是连续的，没有需要改动的地方。";
  }
  for (const it of changed.slice(0, maxLines)) {
    const mark = it.conflict ? "  ⚠️ 目标已存在，将跳过" : "";
    lines.push(`第 ${it.from} 章 → 第 ${it.to} 章：${it.basename} → ${it.newName}${mark}`);
  }
  if (changed.length > maxLines) lines.push(`…… 另外还有 ${changed.length - maxLines} 章`);
  return lines.join("\n");
}
