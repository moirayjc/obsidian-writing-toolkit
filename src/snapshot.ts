import { Notice, Platform, TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import type { WordCountMode } from "./wordcount";
import type { WordCountService } from "./services/wordCountService";
import { DEFAULT_CHAPTER_EXCLUDE_NAMES, isExcludedChapterName } from "./outlineText";

// 插件在桌面端运行，Obsidian 会把 electron 注入到插件模块的 require 中。
declare const require: (id: string) => any;

export interface SnapshotSettings {
  snapshotEnabled: boolean;
  snapshotFolder: string;
  snapshotIntervalMinutes: number;
  snapshotIdleMinutes: number;
  snapshotMaxPerFile: number;
  snapshotOnlyDrafts: boolean;
}

export const DEFAULT_SNAPSHOT_SETTINGS: SnapshotSettings = {
  snapshotEnabled: true,
  snapshotFolder: ".wt-snapshots",
  snapshotIntervalMinutes: 10,
  snapshotIdleMinutes: 3,
  snapshotMaxPerFile: 20,
  snapshotOnlyDrafts: true,
};

/**
 * 与每日字数统计一致：路径任意一层包含「正文草稿」即视为草稿文件；
 * 「不算章节」的辅助文件（Agent.md 等）除外。
 */
export function isDraftPath(
  path: string,
  excludeNamesStr: string | undefined = DEFAULT_CHAPTER_EXCLUDE_NAMES
): boolean {
  if (isExcludedChapterName(path.split("/").pop() ?? "", excludeNamesStr)) {
    return false;
  }
  return path.split("/").some((part) => part.includes("正文草稿"));
}

/** 快照管理器需要的设置：快照字段 + 章节排除名单（与 WritingToolkitSettings 结构兼容） */
type SnapshotSettingsView = SnapshotSettings & { chapterExcludeNames?: string };

export interface SnapshotEntry {
  /** 快照文件在库内的完整路径 */
  path: string;
  /** 文件名 */
  name: string;
  /** 保存时间戳（毫秒） */
  at: number;
  /** 快照内容字数（按当前字数统计模式） */
  wordCount: number;
}

/** 快照 UI 与恢复流程需要的最小能力面，不暴露自动保存生命周期。 */
export interface SnapshotOperations {
  saveSnapshotNow(showNotice?: boolean): Promise<void>;
  openSnapshotFolder(): Promise<void>;
  listSnapshots(sourcePath: string, mode: WordCountMode): Promise<SnapshotEntry[]>;
  readSnapshot(snapshotPath: string): Promise<string>;
  copySnapshot(snapshotPath: string): Promise<void>;
  snapshotFileSilently(sourcePath: string, text: string): Promise<void>;
}

/**
 * 草稿版本快照管理器。
 *
 * 快照触发时机：
 * 1. 写作会话结束（切换到其他文件 / 关闭文件 / 停止输入超过 snapshotIdleMinutes 分钟）
 * 2. 连续写作超过 snapshotIntervalMinutes 分钟
 * 3. 手动命令「保存当前草稿快照」（任意 Markdown 文件）
 *
 * 快照存放于快照文件夹，镜像源文件目录结构，文件名为「原名-时间戳.md」。
 * 内容未变化时自动跳过快照；每个文件最多保留 snapshotMaxPerFile 份，超出删除最旧。
 */
export class DraftSnapshotManager implements SnapshotOperations {
  private readonly vault: Vault;
  private readonly wordCount: WordCountService;
  private readonly getSettings: () => SnapshotSettingsView;
  private readonly getActiveFilePath: () => string | null;
  private readonly getActiveText: () => string | null;
  private readonly onSaved?: () => void;

  // 当前写作会话状态（只跟踪一个活动文件，内存占用可控）
  private sessionPath: string | null = null;
  private sessionText: string | null = null;
  private sessionDirty = false;
  private lastActivityAt = 0;

  // 每个文件最近一次快照的时间与内容哈希（用于间隔判断与去重）
  private lastSnapshotAt: Map<string, number> = new Map();
  private lastSnapshotHash: Map<string, string> = new Map();

  private snapshotInFlight = false;

  constructor(
    vault: Vault,
    wordCount: WordCountService,
    getSettings: () => SnapshotSettingsView,
    getActiveFilePath: () => string | null,
    getActiveText: () => string | null,
    onSaved?: () => void
  ) {
    this.vault = vault;
    this.wordCount = wordCount;
    this.getSettings = getSettings;
    this.getActiveFilePath = getActiveFilePath;
    this.getActiveText = getActiveText;
    this.onSaved = onSaved;
  }

  /** 编辑器内容变化时调用（由 main.ts 的 editor-change 事件驱动）。 */
  onEditorChange(file: TFile, text: string): void {
    if (this.sessionPath !== null && this.sessionPath !== file.path) {
      this.finalizeSession();
    }
    this.sessionPath = file.path;
    this.sessionText = text;
    this.sessionDirty = true;
    this.lastActivityAt = Date.now();
  }

  /** 活动文件切换时调用：结束上一个写作会话。 */
  onFileSwitch(): void {
    this.finalizeSession();
  }

  /** 周期心跳（每 30 秒）：处理空闲结束会话与连续写作间隔快照。 */
  tick(): void {
    this.pruneMaps();
    if (this.sessionPath === null || !this.sessionDirty) return;
    if (!this.autoEligible(this.sessionPath)) return;

    const settings = this.getSettings();
    const now = Date.now();

    // 停止输入超过阈值 → 本次会话结束
    if (now - this.lastActivityAt >= settings.snapshotIdleMinutes * 60_000) {
      this.finalizeSession();
      return;
    }

    // 连续写作超过间隔 → 定时快照
    const intervalMs = settings.snapshotIntervalMinutes * 60_000;
    const lastAt = this.lastSnapshotAt.get(this.sessionPath) ?? 0;
    if (now - lastAt >= intervalMs) {
      void this.saveSnapshot(this.sessionPath, this.sessionText ?? "", false);
    }
  }

  /** 手动保存当前活动文件快照（任意 Markdown 文件）。 */
  async saveSnapshotNow(showNotice = true): Promise<void> {
    const path = this.getActiveFilePath();
    const text = this.getActiveText();
    if (!path || text === null) {
      if (showNotice) new Notice("写作工具箱：当前没有可快照的活动文件");
      return;
    }
    await this.saveSnapshot(path, text, showNotice);
  }

  /** 在系统文件管理器中打开快照文件夹。 */
  async openSnapshotFolder(): Promise<void> {
    const folder = this.effectiveFolder();
    try {
      await this.ensureFolder(folder);
    } catch {
      // 忽略：打开时再创建失败也无妨
    }
    if (Platform.isMobile) {
      new Notice("写作工具箱：移动端不支持打开系统文件夹");
      return;
    }
    try {
      // 桌面端 adapter 为 FileSystemAdapter，
      // 其 getFullPath 未声明在 DataAdapter 接口上，这里做一次类型断言。
      const adapter = this.vault.adapter as unknown as {
        getFullPath: (path: string) => string;
      };
      const absolute = adapter.getFullPath(folder);
      const { shell } = require("electron");
      await shell.openPath(absolute);
    } catch (e) {
      new Notice(`写作工具箱：无法打开快照文件夹：${String(e)}`);
    }
  }

  /** 插件卸载时结束当前会话（保存最后一份快照）。 */
  unload(): void {
    this.finalizeSession();
  }

  /** 列出某文件的所有快照（按时间倒序）。 */
  async listSnapshots(
    sourcePath: string,
    mode: WordCountMode
  ): Promise<SnapshotEntry[]> {
    const folder = this.effectiveFolder();
    const name = pathBasename(sourcePath).replace(/\.md$/i, "");
    const dir = snapshotDir(folder, sourcePath);

    let listed;
    try {
      listed = await this.vault.adapter.list(dir);
    } catch {
      return [];
    }

    const entries: SnapshotEntry[] = [];
    for (const f of listed.files) {
      if (!f.endsWith(".md")) continue;
      const bn = pathBasename(f);
      if (!isSnapshotFileForSource(bn, name)) continue;
      const at = parseSnapshotTimestamp(bn);
      if (at === null) continue;
      const full = f.includes("/") ? f : `${dir}/${f}`;
      let wordCount = 0;
      try {
        wordCount = this.wordCount.count(
          await this.vault.adapter.read(full),
          mode
        );
      } catch {
        // 单文件读取失败不影响列表
      }
      entries.push({ path: full, name: bn, at, wordCount });
    }
    entries.sort((x, y) => y.at - x.at);
    return entries;
  }

  /** 读取快照内容。 */
  async readSnapshot(snapshotPath: string): Promise<string> {
    return this.vault.adapter.read(snapshotPath);
  }

  /** 复制快照内容到剪贴板（粘贴到正文中修文）。 */
  async copySnapshot(snapshotPath: string): Promise<void> {
    try {
      const content = await this.readSnapshot(snapshotPath);
      await copyText(content);
      new Notice(`写作工具箱：已复制快照内容（${pathBasename(snapshotPath)}）`);
    } catch (e) {
      new Notice(`写作工具箱：复制失败：${String(e)}`);
    }
  }

  /** 静默把某文件当前内容保存为快照（恢复前备份当前状态用）。 */
  async snapshotFileSilently(sourcePath: string, text: string): Promise<void> {
    await this.saveSnapshot(sourcePath, text, false);
  }

  /**
   * 源文件/文件夹重命名或移动后调用：同步迁移快照镜像目录。
   * 快照按源路径镜像存放，不迁移会导致旧快照变成孤儿（列表/对比找不到）。
   */
  onRename(file: TAbstractFile, oldPath: string): void {
    void this.handleRename(file, oldPath);
  }

  private async handleRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    const newPath = file.path;
    // 快照文件夹内部的重命名/移动不迁移
    if (this.isSnapshotPath(oldPath) || this.isSnapshotPath(newPath)) return;

    this.migratePathKeys(oldPath, newPath);
    const folder = this.effectiveFolder();
    if (!folder) return;

    if (file instanceof TFolder) {
      const from = `${folder}/${oldPath}`;
      const to = `${folder}/${newPath}`;
      if (from === to) return;
      try {
        if (await this.vault.adapter.exists(from)) {
          await this.moveMirror(from, to);
        }
      } catch {
        // 镜像迁移失败不影响源文件
      }
    } else if (file instanceof TFile && file.extension === "md") {
      await this.renameSnapshotFiles(folder, oldPath, newPath);
    }
  }

  /** 源文件重命名/移动：把旧名前缀的快照文件改为新名前缀（保留时间戳），必要时跨目录移动。 */
  private async renameSnapshotFiles(
    folder: string,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    const oldDir = dirname(oldPath);
    const newDir = dirname(newPath);
    const oldName = pathBasename(oldPath).replace(/\.md$/i, "");
    const newName = pathBasename(newPath).replace(/\.md$/i, "");
    if (oldDir === newDir && oldName === newName) return;

    const oldMirror = oldDir ? `${folder}/${oldDir}` : folder;
    const newMirror = newDir ? `${folder}/${newDir}` : folder;

    let listed;
    try {
      listed = await this.vault.adapter.list(oldMirror);
    } catch {
      return;
    }
    for (const f of listed.files) {
      const full = f.includes("/") ? f : `${oldMirror}/${f}`;
      const bn = pathBasename(full);
      if (!isSnapshotFileForSource(bn, oldName)) continue;
      const destBase = `${newName}-${bn.slice(oldName.length + 1)}`;
      if (newMirror !== oldMirror) {
        await this.ensureFolder(newMirror);
        await this.vault.adapter.rename(full, `${newMirror}/${destBase}`);
      } else {
        await this.vault.adapter.rename(full, `${oldMirror}/${destBase}`);
      }
    }
  }

  /** 递归移动一个镜像目录：先文件后子目录，最后清理空目录。 */
  private async moveMirror(from: string, to: string): Promise<void> {
    const listed = await this.vault.adapter.list(from);
    await this.ensureFolder(to);
    for (const f of listed.files) {
      const full = f.includes("/") ? f : `${from}/${f}`;
      await this.vault.adapter.rename(full, `${to}/${pathBasename(full)}`);
    }
    for (const d of listed.folders) {
      const full = d.includes("/") ? d : `${from}/${d}`;
      await this.moveMirror(full, `${to}/${pathBasename(full)}`);
    }
    try {
      await this.vault.adapter.remove(from);
    } catch {
      // 目录删除失败时忽略（可能仍有残留，不影响使用）
    }
  }

  /** 把重命名前的会话/去重缓存迁移到新路径。 */
  private migratePathKeys(oldPath: string, newPath: string): void {
    const at = this.lastSnapshotAt.get(oldPath);
    const hash = this.lastSnapshotHash.get(oldPath);
    if (at !== undefined) this.lastSnapshotAt.set(newPath, at);
    if (hash !== undefined) this.lastSnapshotHash.set(newPath, hash);
    this.lastSnapshotAt.delete(oldPath);
    this.lastSnapshotHash.delete(oldPath);
    if (this.sessionPath === oldPath) this.sessionPath = newPath;
  }

  private autoEligible(path: string): boolean {
    const settings = this.getSettings();
    if (!settings.snapshotEnabled) return false;
    // 快照文件夹内的文件不再生成快照（镜像路径可能含「正文草稿」）
    if (this.isSnapshotPath(path)) return false;
    return (
      !settings.snapshotOnlyDrafts ||
      isDraftPath(path, settings.chapterExcludeNames)
    );
  }

  private isSnapshotPath(path: string): boolean {
    const folder = this.effectiveFolder();
    if (!folder) return false;
    return path === folder || path.startsWith(folder + "/");
  }

  private finalizeSession(): void {
    if (
      this.sessionPath !== null &&
      this.sessionDirty &&
      this.autoEligible(this.sessionPath)
    ) {
      void this.saveSnapshot(this.sessionPath, this.sessionText ?? "", false);
    }
    this.sessionPath = null;
    this.sessionText = null;
    this.sessionDirty = false;
    this.lastActivityAt = 0;
  }

  private async saveSnapshot(
    sourcePath: string,
    text: string,
    showNotice: boolean
  ): Promise<void> {
    if (this.snapshotInFlight) {
      if (showNotice) new Notice("写作工具箱：快照正在保存中，请稍候再试");
      return;
    }
    this.snapshotInFlight = true;
    try {
      if (!text.trim()) {
        if (showNotice) new Notice("写作工具箱：内容为空，未保存快照");
        return;
      }

      const hash = hashText(text);
      if (this.lastSnapshotHash.get(sourcePath) === hash) {
        if (showNotice) new Notice("写作工具箱：内容未变化，已跳过快照");
        return;
      }

      const now = new Date();
      const folder = this.effectiveFolder();
      const snapshotPath = buildSnapshotPath(folder, sourcePath, now);

      await this.ensureFolder(dirname(snapshotPath));
      await this.vault.create(snapshotPath, text);

      this.lastSnapshotAt.set(sourcePath, now.getTime());
      this.lastSnapshotHash.set(sourcePath, hash);
      if (this.sessionPath === sourcePath) this.sessionDirty = false;

      await this.cleanupRetention(folder, sourcePath);
      this.onSaved?.();
      if (showNotice) {
        new Notice(`写作工具箱：已保存快照 ${pathBasename(snapshotPath)}`);
      }
    } catch (e) {
      if (showNotice) new Notice(`写作工具箱：快照保存失败：${String(e)}`);
    } finally {
      this.snapshotInFlight = false;
    }
  }

  /** 清理同一源文件超出保留数量的最旧快照。 */
  private async cleanupRetention(folder: string, sourcePath: string): Promise<void> {
    const max = this.getSettings().snapshotMaxPerFile;
    if (max <= 0) return;

    const name = pathBasename(sourcePath).replace(/\.md$/i, "");
    const dir = snapshotDir(folder, sourcePath);

    let listed;
    try {
      listed = await this.vault.adapter.list(dir);
    } catch {
      return;
    }

    const candidates = listed.files
      .filter(
        (f) =>
          f.endsWith(".md") &&
          isSnapshotFileForSource(pathBasename(f), name)
      )
      // 兼容 adapter.list 返回裸文件名或完整路径两种行为
      .map((f) => (f.includes("/") ? f : `${dir}/${f}`))
      .sort();

    const excess = candidates.length - max;
    for (let i = 0; i < excess; i++) {
      try {
        await this.vault.adapter.remove(candidates[i]);
      } catch {
        // 文件可能已被手动删除，忽略
      }
    }
  }

  private effectiveFolder(): string {
    const folder = this.getSettings().snapshotFolder.trim();
    return (folder || DEFAULT_SNAPSHOT_SETTINGS.snapshotFolder).replace(
      /^\/+|\/+$/g,
      ""
    );
  }

  /** 递归确保文件夹存在（逐层 mkdir）。 */
  private async ensureFolder(folder: string): Promise<void> {
    const parts = folder.split("/").filter((p) => p.length > 0);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      try {
        const exists = await this.vault.adapter.exists(current);
        if (!exists) await this.vault.adapter.mkdir(current);
      } catch {
        // 忽略并发创建等错误
      }
    }
  }

  /** 定期清理超过 24 小时未使用的哈希缓存，防止内存增长。 */
  private pruneMaps(): void {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [path, at] of this.lastSnapshotAt) {
      if (at < cutoff) {
        this.lastSnapshotAt.delete(path);
        this.lastSnapshotHash.delete(path);
      }
    }
  }
}

function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function pathBasename(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** 复制文本到剪贴板：桌面端用 Electron，移动端用 Web Clipboard。 */
async function copyText(text: string): Promise<void> {
  if (Platform.isMobile) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const { clipboard } = require("electron");
  clipboard.writeText(text);
}

function snapshotDir(folder: string, sourcePath: string): string {
  const dir = dirname(sourcePath);
  return dir ? `${folder}/${dir}` : folder;
}

function buildSnapshotPath(folder: string, sourcePath: string, at: Date): string {
  const name = pathBasename(sourcePath).replace(/\.md$/i, "");
  const file = `${name}-${timestamp(at)}.md`;
  const dir = dirname(sourcePath);
  return dir ? `${folder}/${dir}/${file}` : `${folder}/${file}`;
}

const SNAPSHOT_TS_RE = /-(\d{8})-(\d{6})(\d{3})?\.md$/;

function isSnapshotFileForSource(fileName: string, sourceName: string): boolean {
  const suffix = fileName.slice(sourceName.length + 1);
  return (
    fileName.startsWith(`${sourceName}-`) &&
    /^\d{8}-\d{6}(?:\d{3})?\.md$/.test(suffix)
  );
}

function parseSnapshotTimestamp(name: string): number | null {
  const m = SNAPSHOT_TS_RE.exec(name);
  if (!m) return null;
  const y = +m[1].slice(0, 4);
  const mo = +m[1].slice(4, 6);
  const d = +m[1].slice(6, 8);
  const h = +m[2].slice(0, 2);
  const mi = +m[2].slice(2, 4);
  const sec = +m[2].slice(4, 6);
  const ms = m[3] ? +m[3] : 0;
  return new Date(y, mo - 1, d, h, mi, sec, ms).getTime();
}
