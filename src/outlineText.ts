import { App, DataAdapter, TFile } from "obsidian";

/**
 * 章纲相关的纯文本与存储工具
 */

/** frontmatter 键名：章纲（兼容旧数据） */
export const OUTLINE_KEY = "章纲";

/** 独立伴生文件目录名 */
export const OUTLINES_FOLDER = ".wt-outlines";

/** 默认识别为正文章节的关键词 */
export const DEFAULT_DRAFT_KEYWORDS = "正文草稿, 正文, 章节, 草稿, 卷, draft, chapter";

/** 获取某个文档对应的独立伴生章纲文件路径 */
export function getOutlinePath(filePath: string): string {
  return `${OUTLINES_FOLDER}/${filePath}`;
}

/** 依次补齐路径上的每一级目录（adapter.mkdir 只建一层）。 */
async function ensureFolder(adapter: DataAdapter, folderPath: string): Promise<void> {
  if (!folderPath) return;
  let current = "";
  for (const part of folderPath.split("/")) {
    if (!part) continue;
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      try {
        await adapter.mkdir(current);
      } catch {
        /* 已存在或并发创建，忽略 */
      }
    }
  }
}

/** 递归列出某目录下的全部文件（相对库根的路径）。 */
async function listFilesDeep(
  adapter: DataAdapter,
  folder: string
): Promise<string[]> {
  const out: string[] = [];
  let listed: { files: string[]; folders: string[] };
  try {
    listed = await adapter.list(folder);
  } catch {
    return out;
  }
  out.push(...listed.files);
  for (const child of listed.folders) {
    out.push(...(await listFilesDeep(adapter, child)));
  }
  return out;
}

/**
 * 正文改名/移动后，把对应的章纲伴生文件一起搬走。
 *
 * 章纲在 `.wt-outlines/` 下按正文路径镜像存放，正文一改名，
 * 章纲就会"脱钩"（文件还在，但按新路径找不到了）。所以任何改名
 * —— 插件里的重命名、拖拽换卷、批量顺延，或在 Obsidian 里直接改名
 * —— 都要走这里同步一次。
 *
 * 同时支持单个文件与整个目录（改名卷目录时，整卷的章纲跟着走）。
 * 目标位置已有残留（同一路径此前被删过）时，以本次搬过去的为准。
 */
export async function migrateOutlineSidecar(
  app: App,
  oldPath: string,
  newPath: string
): Promise<void> {
  if (!oldPath || !newPath || oldPath === newPath) return;
  const adapter = app.vault.adapter;
  const from = getOutlinePath(oldPath);
  const to = getOutlinePath(newPath);
  try {
    const stat = await adapter.stat(from);
    if (!stat) return;

    if (stat.type === "file") {
      await ensureFolder(adapter, to.slice(0, to.lastIndexOf("/")));
      if (await adapter.exists(to)) await adapter.remove(to);
      await adapter.rename(from, to);
      return;
    }

    // 目录：整卷/整个文件夹的章纲跟着搬
    const files = await listFilesDeep(adapter, from);
    for (const file of files) {
      const relative = file.slice(from.length + 1);
      const target = `${to}/${relative}`;
      await ensureFolder(adapter, target.slice(0, target.lastIndexOf("/")));
      if (await adapter.exists(target)) await adapter.remove(target);
      await adapter.rename(file, target);
    }
  } catch (err) {
    console.error("写作工具箱：迁移章纲伴生文件失败", err);
  }
}

/** 是否为章节草稿路径：排除系统目录，按配置关键词匹配。 */
export function isDraftPath(
  path: string,
  snapshotFolder = ".wt-snapshots",
  keywordsStr = DEFAULT_DRAFT_KEYWORDS
): boolean {
  if (!path || !path.endsWith(".md")) return false;
  // 排除系统目录及内部目录
  const excluded = [snapshotFolder, OUTLINES_FOLDER, ".wt-snapshots", ".wt-outlines", ".obsidian", ".trash"];
  for (const ex of excluded) {
    if (ex) {
      const f = ex.replace(/^\/+|\/+$/g, "");
      if (f && (path === f || path.startsWith(f + "/"))) return false;
    }
  }

  const rawKeywords = (keywordsStr || "")
    .split(/[,，\s]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  if (rawKeywords.length === 0 || rawKeywords.includes("*")) {
    return true;
  }

  const lowerPath = path.toLowerCase();
  return rawKeywords.some((kw) => lowerPath.includes(kw));
}

export interface BeatItem {
  id: string;
  done: boolean;
  text: string;
}

/** 解析文本为节拍要点清单（支持 Markdown 任务列表 - [ ] / 列表符 - / 纯文本） */
export function parseBeats(content: string): BeatItem[] {
  const lines = content.split("\n");
  const beats: BeatItem[] = [];
  let idCounter = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 匹配 - [ ] 或 - [x]
    const checkMatch = line.match(/^(\s*[-*+]\s*\[([ xX])\]\s*)(.*)$/);
    if (checkMatch) {
      beats.push({
        id: `beat-${++idCounter}-${Math.random().toString(36).slice(2, 6)}`,
        done: checkMatch[2].toLowerCase() === "x",
        text: checkMatch[3].trim(),
      });
      continue;
    }
    // 匹配无复选框列表符号 - 或 * 或 +
    const bulletMatch = line.match(/^(\s*[-*+]\s+)(.*)$/);
    if (bulletMatch) {
      beats.push({
        id: `beat-${++idCounter}-${Math.random().toString(36).slice(2, 6)}`,
        done: false,
        text: bulletMatch[2].trim(),
      });
      continue;
    }
    // 匹配 1. 或 1)
    const numMatch = line.match(/^(\s*\d+[.)]\s+)(.*)$/);
    if (numMatch) {
      beats.push({
        id: `beat-${++idCounter}-${Math.random().toString(36).slice(2, 6)}`,
        done: false,
        text: numMatch[2].trim(),
      });
      continue;
    }
    // 纯文本行
    beats.push({
      id: `beat-${++idCounter}-${Math.random().toString(36).slice(2, 6)}`,
      done: false,
      text: trimmed,
    });
  }
  return beats;
}

/** 序列化节拍要点为 Markdown 任务列表文本 */
export function serializeBeats(beats: BeatItem[]): string {
  return beats
    .map((b) => `- [${b.done ? "x" : " "}] ${b.text}`)
    .join("\n");
}

/** 读取章纲：优先读取 .wt-outlines 伴生文件，不存在则平滑兼容读取旧 Frontmatter */
export async function loadOutline(
  app: App,
  file: TFile,
  storageMode: "sidecar" | "frontmatter" = "sidecar"
): Promise<{ value: string; hasKey: boolean; isLegacyFm: boolean }> {
  const sidecarPath = getOutlinePath(file.path);
  // 1. 如果伴生文件存在，直接读
  if (await app.vault.adapter.exists(sidecarPath)) {
    try {
      const text = await app.vault.adapter.read(sidecarPath);
      return { value: text, hasKey: true, isLegacyFm: false };
    } catch (e) {
      console.error("读取伴生章纲失败:", e);
    }
  }

  // 2. 检查旧 Frontmatter（历史数据兼容）
  try {
    const content = await app.vault.cachedRead(file);
    const parsed = readOutlineFromContent(content);
    if (parsed.hasKey && parsed.value.trim() !== "") {
      return { value: parsed.value, hasKey: true, isLegacyFm: true };
    }
  } catch {
    /* ignore */
  }

  return { value: "", hasKey: false, isLegacyFm: false };
}

/** 保存章纲：默认存为独立伴生文件，保护正文纯净；支持切换回 frontmatter */
export async function saveOutline(
  app: App,
  file: TFile,
  value: string,
  storageMode: "sidecar" | "frontmatter" = "sidecar"
): Promise<void> {
  if (storageMode === "frontmatter") {
    await app.vault.process(file, (content: string) => setOutlineKey(content, value));
    return;
  }

  const sidecarPath = getOutlinePath(file.path);
  const parentDir = sidecarPath.includes("/")
    ? sidecarPath.slice(0, sidecarPath.lastIndexOf("/"))
    : "";
  if (parentDir && !(await app.vault.adapter.exists(parentDir))) {
    const parts = parentDir.split("/");
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await app.vault.adapter.exists(cur))) {
        await app.vault.adapter.mkdir(cur);
      }
    }
  }
  await app.vault.adapter.write(sidecarPath, value);
}

/**
 * frontmatter 解析（只处理本文档自己约定的两种形态）：
 * - `章纲: 单行内容`
 * - `章纲: |` + 后续缩进两格的内容行（保留换行）
 * 返回 undefined 表示没有该键；字符串（可为空）表示该键的值。
 */
export function readOutlineKey(fmInner: string): string | undefined {
  const lines = fmInner.split("\n");
  // 只匹配顶层键：行首无空白
  const topIdx = lines.findIndex(
    (l) => !/^\s/.test(l) && l.startsWith(OUTLINE_KEY + ":")
  );
  if (topIdx < 0) return undefined;
  const line = lines[topIdx];
  const rest = line.slice(OUTLINE_KEY.length + 1).trim();
  if (rest === "" || rest === "|" || rest === "|-") {
    // 块标量：收集后续缩进 >=2 的内容行（空行保留），去掉行尾连续空行
    const parts: string[] = [];
    let collecting = false;
    for (let j = topIdx + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") {
        if (collecting || parts.length > 0) parts.push("");
        continue;
      }
      if (/^ {2,}/.test(l)) {
        collecting = true;
        parts.push(l.slice(2));
      } else {
        break;
      }
    }
    while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts.join("\n");
  }
  if (
    (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) ||
    (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2)
  ) {
    return rest.slice(1, -1);
  }
  return rest;
}

/** 定位 frontmatter 内容区（不含首尾 --- 行）的 [start, end) 文本；无 frontmatter 返回 null。 */
export function findFrontmatterInner(
  text: string
): { start: number; end: number } | null {
  // frontmatter 必须以第一行 --- 开始
  if (!/^---\r?\n/.test(text)) return null;
  const bodyStart = text.indexOf("\n") + 1;
  // 找下一个恰好为 --- 的行（行首无缩进）
  let idx = bodyStart;
  while (idx < text.length) {
    const nl = text.indexOf("\n", idx);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(idx, lineEnd);
    if (line === "---") {
      return { start: bodyStart, end: idx };
    }
    idx = lineEnd + 1;
  }
  return null;
}

/** 从整篇正文里读出章纲：没有该键时 hasKey 为 false、value 为空串。 */
export function readOutlineFromContent(content: string): {
  hasKey: boolean;
  value: string;
} {
  const fm = findFrontmatterInner(content);
  if (!fm) return { hasKey: false, value: "" };
  const value = readOutlineKey(content.slice(fm.start, fm.end));
  return value === undefined
    ? { hasKey: false, value: "" }
    : { hasKey: true, value };
}

/**
 * 在全文的 frontmatter 中更新「章纲」键（保留其它键与全部正文），
 * 文件没有 frontmatter 时在文首新建。仅做行级替换，不重排其它 YAML。
 */
export function setOutlineKey(content: string, value: string): string {
  const body = value
    ? value.split("\n").map((l) => "  " + l).join("\n")
    : "";
  const newKeyLine = body ? `${OUTLINE_KEY}: |\n${body}` : `${OUTLINE_KEY}: ""`;

  const fm = findFrontmatterInner(content);
  if (!fm) {
    return `---\n${newKeyLine}\n---\n\n${content}`;
  }
  // fm.end 指向结束行 --- 的行首，inner 会带尾部换行，去掉
  const inner = content.slice(fm.start, fm.end).replace(/\n$/, "");
  const lines = inner.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s/.test(line)) {
      // 缩进行：属于上一个键；若上一个键正是被删除的章纲块，则一并跳过
      if (skipping) continue;
      kept.push(line);
      continue;
    }
    skipping = false;
    if (line.startsWith(OUTLINE_KEY + ":")) {
      skipping = true; // 删除旧键（其后续缩进行由下轮 skipping 处理）
      kept.push(newKeyLine);
      continue;
    }
    kept.push(line);
  }
  if (!kept.includes(newKeyLine)) kept.push(newKeyLine);
  // inner 原末尾换行已被移除，重组时补回，避免与结束行 --- 粘连
  return content.slice(0, fm.start) + kept.join("\n") + "\n" + content.slice(fm.end);
}

/** frontmatter 里的章纲值可能是字符串，也可能是 YAML 列表；统一成纯文本。 */
export function outlineToText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((v) => (v === null || v === undefined ? "" : String(v)))
      .join("\n");
  }
  if (raw === null || raw === undefined) return "";
  return String(raw);
}

/** 章纲要点数：忽略空行。 */
export function countPoints(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n++;
  return n;
}

/** 章纲字数：不计空白字符，和正文统计口径一致。 */
export function countChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/** 自然排序：让「第 2 章」排在「第 10 章」前面。 */
export function naturalCompare(a: string, b: string): number {
  const ax = a.match(/\d+|\D+/g) ?? [];
  const bx = b.match(/\d+|\D+/g) ?? [];
  const len = Math.max(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const x = ax[i];
    const y = bx[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const diff = parseInt(x, 10) - parseInt(y, 10);
      if (diff !== 0) return diff;
    } else if (x !== y) {
      const cmp = x.localeCompare(y, "zh-Hans-CN");
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/** 光标所在行的行首偏移。 */
function lineStartOf(value: string, pos: number): number {
  return value.lastIndexOf("\n", pos - 1) + 1;
}

/**
 * 按回车时的「要点续写」规则：
 * - 当前行形如 `- xxx`，回车后自动补一行同级 `- `；
 * - 当前行是空要点（只有符号、光标在行尾），回车改成清掉这一行的符号，退出列表。
 * 返回需要做的替换 [start, end) 与替换文本；不满足条件返回 null（交给默认行为）。
 */
export function bulletContinuation(
  value: string,
  start: number,
  end: number
): { start: number; end: number; text: string } | null {
  if (start !== end) return null;
  const lineStart = lineStartOf(value, start);
  const line = value.slice(lineStart, start);
  const m = line.match(/^(\s*)([-*+])(\s+)/);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  const atLineEnd = start === value.length || value[start] === "\n";
  if (rest.trim() === "" && atLineEnd) {
    return { start: lineStart, end: start, text: "" };
  }
  return { start, end: start, text: `\n${m[1]}${m[2]} ` };
}

/**
 * 退格键规则：光标停在只有符号的要点行（如 `- `）末尾时，
 * 返回整段符号的 [start, end) 供删除；否则返回 null。
 */
export function bulletPrefixRange(
  value: string,
  start: number,
  end: number
): { start: number; end: number } | null {
  if (start !== end) return null;
  const lineStart = lineStartOf(value, start);
  const line = value.slice(lineStart, start);
  if (!/^(\s*)([-*+])(\s+)$/.test(line)) return null;
  return { start: lineStart, end: start };
}

/**
 * 往 textarea 插入文本：优先走原生命令，保住撤销栈；
 * 返回是否用了原生命令（原生插入会派发 input 事件，调用方无需再通知）。
 */
export function insertTextPreservingUndo(
  ta: HTMLTextAreaElement,
  text: string
): boolean {
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, text);
  } catch {
    ok = false;
  }
  if (ok) return true;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const caret = start + text.length;
  ta.setSelectionRange(caret, caret);
  return false;
}

/** 去掉当前行的两级以内缩进（Shift+Tab）。 */
function outdent(ta: HTMLTextAreaElement, onChange: () => void): void {
  const start = ta.selectionStart;
  const lineStart = lineStartOf(ta.value, start);
  const line = ta.value.slice(lineStart);
  const m = line.match(/^ {1,2}/);
  if (!m) return;
  ta.setSelectionRange(lineStart, lineStart + m[0].length);
  if (!insertTextPreservingUndo(ta, "")) onChange();
}

/**
 * 章纲编辑框的书写手感（侧栏面板与大窗口编辑器共用）：
 * - 回车续写 `- ` 要点符号，空要点上回车自动退出列表；
 * - Tab / Shift+Tab 缩进、反缩进两级；
 * - 只有符号的空要点行上退格删掉符号。
 * 任何直接改 value 的分支都会调用 onChange，保持状态与自动保存同步。
 */
export function attachOutlineEditing(
  ta: HTMLTextAreaElement,
  onChange: () => void
): void {
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;

    if (e.key === "Enter" && plain && !e.shiftKey) {
      const act = bulletContinuation(ta.value, ta.selectionStart, ta.selectionEnd);
      if (!act) return;
      e.preventDefault();
      ta.setSelectionRange(act.start, act.end);
      if (!insertTextPreservingUndo(ta, act.text)) onChange();
      return;
    }

    if (e.key === "Tab" && plain) {
      e.preventDefault();
      if (e.shiftKey) {
        outdent(ta, onChange);
      } else if (!insertTextPreservingUndo(ta, "  ")) {
        onChange();
      }
      return;
    }

    if (e.key === "Backspace" && plain && !e.shiftKey) {
      const range = bulletPrefixRange(ta.value, ta.selectionStart, ta.selectionEnd);
      if (!range) return;
      e.preventDefault();
      ta.setSelectionRange(range.start, range.end);
      if (!insertTextPreservingUndo(ta, "")) onChange();
    }
  });
}
