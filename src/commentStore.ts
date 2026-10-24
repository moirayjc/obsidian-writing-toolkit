/**
 * 批注存储：批注文件（`.wt-comments/<正文相对路径>.批注.md`）的读写与缓存。
 *
 * 缓存按「源文档路径」维度；批注文件被 Agent 或用户从外部改写时，
 * 由 main 里注册的 vault 事件调用 handleModified / handleDeleted 让缓存失效。
 *
 * 旧版把批注放在正文同目录；首次读取（或启动时统一迁移）会把旧文件搬到
 * `.wt-comments/` 的镜像位置。迁移失败时退回旧路径继续读写，绝不丢批注。
 */
import { App, DataAdapter, TFile } from "obsidian";
import {
  WtComment,
  commentsFolder,
  docPathForSidecar,
  isLegacySidecarPath,
  isSidecarPath,
  legacySidecarPathFor,
  otherSidecarPathFor,
  parseCommentFileData,
  serializeCommentFile,
  sidecarPathFor,
} from "./comments";
import {
  commentError,
  commentIoDiag,
  commentLoaded,
  commentSidecarDeleted,
  commentWrote,
} from "./diagnostics";
import { sidecarFoldersOf } from "./sidecarLocation";

/** 文件路径的父目录；根目录文件返回空字符串。 */
function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}

/** 隐藏目录里的路径（任意一段以 `.` 开头）：Obsidian 不索引，读写走 adapter。 */
function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

export class CommentStore {
  private cache = new Map<string, WtComment[]>();
  /** 「已否决」区：随批注一起读入；保存时没指定就原样写回，不会被批注操作冲掉 */
  private rejected = new Map<string, string[]>();
  /** 读取中的任务：同一文档并发 load 时复用（标记与面板可能同时触发） */
  private inflight = new Map<string, Promise<WtComment[]>>();
  /** 代数：写入/失效使其 +1，迟到的旧读取结果不再回写缓存 */
  private generation = new Map<string, number>();

  constructor(private app: App) {}

  /** 已缓存的批注（尚未加载过返回 undefined）。 */
  getCached(docPath: string): WtComment[] | undefined {
    return this.cache.get(docPath);
  }

  /** 最近一次读到 / 写下的「已否决」区（未加载过返回空列表）。 */
  getRejected(docPath: string): string[] {
    return [...(this.rejected.get(docPath) ?? [])];
  }

  /** 绕过缓存，从磁盘重新读取（写入前用，避免覆盖 Agent 刚写下的改动）。 */
  reload(docPath: string): Promise<WtComment[]> {
    this.invalidate(docPath);
    return this.load(docPath);
  }

  /** 读取某文档的批注（带缓存；批注文件不存在则视为空列表）。 */
  load(docPath: string): Promise<WtComment[]> {
    const cached = this.cache.get(docPath);
    if (cached) return Promise.resolve(cached);
    const inflight = this.inflight.get(docPath);
    if (inflight) return inflight;
    const gen = this.generation.get(docPath) ?? 0;
    const task = this.readFromVault(docPath, gen);
    this.inflight.set(docPath, task);
    const clear = (): void => {
      // 失效会删除旧任务并允许新读取启动；旧任务落地时不能误删新任务。
      if (this.inflight.get(docPath) === task) this.inflight.delete(docPath);
    };
    void task.then(clear, clear);
    return task;
  }

  private async readFromVault(
    docPath: string,
    gen: number
  ): Promise<WtComment[]> {
    const t0 = performance.now();
    const sidecar = await this.resolveSidecarPath(docPath);
    const text = await this.readText(sidecar);
    const data =
      text === null ? { comments: [], rejected: [] } : parseCommentFileData(text);
    const comments = data.comments;
    // 等待期间批注被改写/保存过（代数变了）：不要用旧结果覆盖缓存
    if ((this.generation.get(docPath) ?? 0) === gen) {
      this.cache.set(docPath, comments);
      this.rejected.set(docPath, data.rejected);
    }
    commentLoaded(docPath, comments.length, performance.now() - t0, text !== null);
    return comments;
  }

  /** 触发一次异步预加载（界面用到批注但还没缓存时调用）。 */
  ensureLoaded(docPath: string): void {
    if (this.cache.has(docPath)) return;
    void this.load(docPath).catch((error) => {
      console.error("写作工具箱：读取批注文件失败", error);
    });
  }

  invalidate(docPath: string): void {
    this.cache.delete(docPath);
    this.inflight.delete(docPath);
    this.generation.set(docPath, (this.generation.get(docPath) ?? 0) + 1);
  }

  /** 存放位置切换后整张缓存作废：按新位置重新读。 */
  invalidateAll(): void {
    for (const path of new Set([
      ...this.cache.keys(),
      ...this.inflight.keys(),
      ...this.generation.keys(),
    ])) {
      this.invalidate(path);
    }
  }

  /** 目录改名/删除后清掉整段缓存，避免旧路径的批注继续粘在内存里。 */
  invalidatePrefix(prefix: string): void {
    const matches = (path: string): boolean =>
      path === prefix || path.startsWith(prefix + "/");
    for (const path of new Set([
      ...this.cache.keys(),
      ...this.inflight.keys(),
      ...this.generation.keys(),
    ])) {
      if (matches(path)) this.invalidate(path);
    }
  }

  /**
   * 把批注列表写回批注文件；批注与「已否决」都为空时删除批注文件。
   * rejected 省略时沿用最近一次读到的「已否决」区（调用方应先 reload）。
   */
  async save(
    docPath: string,
    comments: readonly WtComment[],
    rejected?: readonly string[]
  ): Promise<void> {
    const rejectedToWrite = [...(rejected ?? this.rejected.get(docPath) ?? [])];
    const t0 = performance.now();
    this.inflight.delete(docPath);
    const startedAt = (this.generation.get(docPath) ?? 0) + 1;
    this.generation.set(docPath, startedAt);
    try {
      const sidecar = await this.resolveSidecarPath(docPath);
      if (comments.length === 0 && rejectedToWrite.length === 0) {
        // 新、旧两个位置都清掉，避免迁移失败留下的旧文件把批注“复活”。
        for (const path of new Set([
          sidecar,
          legacySidecarPathFor(docPath),
          otherSidecarPathFor(docPath),
        ])) {
          if (await this.exists(path)) {
            // 用 FileManager.trashFile 而不是 Vault.delete：前者尊重用户「删除到回收站」的设置
            await this.trashPath(path);
            commentSidecarDeleted(docPath);
          }
        }
        if ((this.generation.get(docPath) ?? 0) === startedAt) {
          // 写盘期间启动的读取拿到的是旧内容，提升代数让它们不能回写缓存。
          this.generation.set(docPath, startedAt + 1);
          this.cache.set(docPath, []);
          this.rejected.set(docPath, []);
        }
        return;
      }
      const text = serializeCommentFile(docPath, comments, rejectedToWrite);
      await this.writeText(sidecar, text);
      // 写盘期间若收到外部 modify 或另一次写入，代数会变化；
      // 此时不能拿本次结果覆盖更新的缓存。
      if ((this.generation.get(docPath) ?? 0) === startedAt) {
        this.generation.set(docPath, startedAt + 1);
        this.cache.set(docPath, [...comments]);
        this.rejected.set(docPath, rejectedToWrite);
      }
      commentWrote(docPath, performance.now() - t0);
    } catch (error) {
      commentIoDiag.lastWriteError = `${docPath} → ${String(error)}`;
      commentError("CommentStore.save", error);
      this.invalidate(docPath);
      throw error;
    }
  }

  /** vault "modify"：批注文件被外部（Agent / 编辑）改写 → 缓存失效。 */
  handleModified(path: string): string | null {
    if (!isSidecarPath(path)) return null;
    const docPath = docPathForSidecar(path);
    this.invalidate(docPath);
    return docPath;
  }

  /** vault "delete"：批注文件被删 → 缓存失效（下次读重新查盘，而不是写入空列表）。 */
  handleDeleted(path: string): string | null {
    if (!isSidecarPath(path)) return null;
    const docPath = docPathForSidecar(path);
    // 这里用 invalidate 而不是「缓存空列表」：
    //   · 缓存空数组会让这条记录一直「粘」到下一次 create/modify/rename，且没有边界
    //     （例如在 Obsidian 之外删掉批注文件后、后续事件都没触发的情况）；
    //   · 失效不改变可观察行为——文件确实不在时下一次 load 读到的仍是空列表；
    //     文件被重建时 Obsidian 会发 create，main.ts:560 的处理器同样会失效一次。
    this.invalidate(docPath);
    return docPath;
  }

  /** vault "rename"：侧车本身或源文档改名 → 返回受影响的两个文档路径。 */
  handleRenamed(oldPath: string, newPath: string): string[] {
    const docs = new Set<string>();
    if (isSidecarPath(oldPath)) docs.add(docPathForSidecar(oldPath));
    if (isSidecarPath(newPath)) docs.add(docPathForSidecar(newPath));
    for (const d of docs) this.invalidate(d);
    return [...docs];
  }

  /**
   * 启动时一次性把库里的旧版同目录批注文件搬进 `.wt-comments/`。
   * 只做 rename，不改文件内容；失败的那一个保持原样，下次读取时再试。
   */
  async migrateLegacySidecars(): Promise<number> {
    const files = this.app.vault.getFiles?.() ?? [];
    let moved = 0;
    for (const file of files) {
      if (!isLegacySidecarPath(file.path)) continue;
      const docPath = docPathForSidecar(file.path);
      const target = sidecarPathFor(docPath);
      if (await this.exists(target)) continue;
      try {
        await this.renamePath(file.path, target);
        this.invalidate(docPath);
        moved++;
      } catch (error) {
        commentError("CommentStore.migrateLegacySidecars", error);
      }
    }
    return moved;
  }

  /**
   * 正文所在目录改名时，同步搬 `.wt-comments/` 下镜像的那一段。
   * 旧版同目录批注会随文件夹一起被 Obsidian 搬走，稍后读取时再单独迁移。
   */
  async migrateFolderPrefix(oldFolder: string, newFolder: string): Promise<number> {
    const adapter = this.app.vault.adapter;
    if (!adapter) return 0;
    const from = `${commentsFolder()}/${oldFolder}`;
    const to = `${commentsFolder()}/${newFolder}`;
    const files = await this.listFilesDeep(adapter, from);
    let moved = 0;
    for (const full of files) {
      const rel = full.slice(from.length + 1);
      const target = `${to}/${rel}`;
      if (await this.exists(target)) continue;
      try {
        await this.ensureFolder(parentFolder(target));
        await adapter.rename(full, target);
        moved++;
      } catch (error) {
        commentError("CommentStore.migrateFolderPrefix", error);
      }
    }
    return moved;
  }

  /**
   * 有批注文件的文档路径（两档存放位置都看，去重）。批注工具「列出所有」用；
   * 隐藏目录不进 Obsidian 索引，所以走 adapter 递归列目录。
   */
  async listCommentDocs(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    if (!adapter) return [];
    const docs = new Set<string>();
    for (const folder of sidecarFoldersOf("comments")) {
      if (!(await this.exists(folder))) continue;
      for (const full of await this.listFilesDeep(adapter, folder)) {
        if (isSidecarPath(full)) docs.add(docPathForSidecar(full));
      }
    }
    return [...docs].sort();
  }

  /* ---------- 路径与读写 ---------- */

  /**
   * 新布局的目标路径；若目标不存在而旧版同目录文件存在，则就地迁移。
   * 迁移失败时退回旧路径——这一轮继续读写旧文件，数据不丢。
   */
  private async resolveSidecarPath(docPath: string): Promise<string> {
    const target = sidecarPathFor(docPath);
    if (await this.exists(target)) return target;
    // 另一档存放位置里还有（两台设备选得不一样、或切换迁移没搬完）：就地读写那一份，
    // 不在这里搬——否则两台设备会把文件来回搬。整体搬家只在切换设置时做。
    const other = otherSidecarPathFor(docPath);
    if (other !== target && (await this.exists(other))) return other;
    const legacy = legacySidecarPathFor(docPath);
    if (legacy === target || !(await this.exists(legacy))) return target;
    try {
      await this.renamePath(legacy, target);
      return target;
    } catch (error) {
      commentError("CommentStore.migrateLegacySidecar", error);
      return legacy;
    }
  }

  private fileAt(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  private async exists(path: string): Promise<boolean> {
    if (this.fileAt(path)) return true;
    const adapter = this.app.vault.adapter;
    if (!adapter) return false;
    try {
      return await adapter.exists(path);
    } catch {
      return false;
    }
  }

  private async readText(path: string): Promise<string | null> {
    const file = this.fileAt(path);
    if (file) return this.app.vault.read(file);
    const adapter = this.app.vault.adapter;
    if (!adapter) return null;
    if (!(await adapter.exists(path))) return null;
    return adapter.read(path);
  }

  private async writeText(path: string, text: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    // 隐藏目录（.wt-comments）：按 Obsidian 文档走 Adapter，别指望 Vault 索引。
    if (isHiddenPath(path) && adapter) {
      await this.ensureFolder(parentFolder(path));
      await adapter.write(path, text);
      return;
    }
    const file = this.fileAt(path);
    if (file) {
      await this.app.vault.modify(file, text);
      return;
    }
    if (adapter && (await adapter.exists(path))) {
      await adapter.write(path, text);
      return;
    }
    await this.ensureFolder(parentFolder(path));
    try {
      await this.app.vault.create(path, text);
    } catch (error) {
      // 并发创建或未进索引的隐藏文件：能写到磁盘就算成功
      if (adapter && (await adapter.exists(path))) {
        await adapter.write(path, text);
        return;
      }
      throw error;
    }
  }

  private async trashPath(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (isHiddenPath(path) && adapter) {
      if (await adapter.exists(path)) await adapter.remove(path);
      return;
    }
    const file = this.fileAt(path);
    if (file) {
      await this.app.fileManager.trashFile(file);
      return;
    }
    if (adapter && (await adapter.exists(path))) await adapter.remove(path);
  }

  private async renamePath(from: string, to: string): Promise<void> {
    await this.ensureFolder(parentFolder(to));
    const file = this.fileAt(from);
    if (file) {
      try {
        await this.app.vault.rename(file, to);
        return;
      } catch (error) {
        // 隐藏目录未进索引等情况下，退回 adapter 的原子 rename
        const adapter = this.app.vault.adapter;
        if (!adapter) throw error;
        await adapter.rename(from, to);
        return;
      }
    }
    const adapter = this.app.vault.adapter;
    if (!adapter) throw new Error(`找不到批注文件：${from}`);
    await adapter.rename(from, to);
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder) return;
    const adapter = this.app.vault.adapter;
    if (!adapter) return;
    let current = "";
    for (const part of folder.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      try {
        if (!(await adapter.exists(current))) await adapter.mkdir(current);
      } catch {
        /* 已存在或并发创建，忽略 */
      }
    }
  }

  private async listFilesDeep(
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
    // 不同平台/版本的 adapter.list 可能返回完整路径或裸文件名，两种都兜住。
    const join = (child: string): string =>
      child === folder || child.startsWith(`${folder}/`)
        ? child
        : `${folder}/${child}`;
    out.push(...listed.files.map(join));
    for (const child of listed.folders) {
      out.push(...(await this.listFilesDeep(adapter, join(child))));
    }
    return out;
  }
}
