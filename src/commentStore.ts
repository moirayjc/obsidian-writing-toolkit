/**
 * 批注存储：批注文件（`文档名.批注.md`）的读写与缓存。
 *
 * 缓存按「源文档路径」维度；批注文件被 Agent 或用户从外部改写时，
 * 由 main 里注册的 vault 事件调用 handleModified / handleDeleted 让缓存失效。
 */
import { App, TFile } from "obsidian";
import {
  WtComment,
  docPathForSidecar,
  isSidecarPath,
  parseCommentFile,
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

export class CommentStore {
  private cache = new Map<string, WtComment[]>();
  /** 读取中的任务：同一文档并发 load 时复用（标记与面板可能同时触发） */
  private inflight = new Map<string, Promise<WtComment[]>>();
  /** 代数：写入/失效使其 +1，迟到的旧读取结果不再回写缓存 */
  private generation = new Map<string, number>();

  constructor(private app: App) {}

  /** 已缓存的批注（尚未加载过返回 undefined）。 */
  getCached(docPath: string): WtComment[] | undefined {
    return this.cache.get(docPath);
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
    const file = this.app.vault.getAbstractFileByPath(sidecarPathFor(docPath));
    let comments: WtComment[] = [];
    if (file instanceof TFile) {
      const text = await this.app.vault.read(file);
      comments = parseCommentFile(text);
    }
    // 等待期间批注被改写/保存过（代数变了）：不要用旧结果覆盖缓存
    if ((this.generation.get(docPath) ?? 0) === gen) {
      this.cache.set(docPath, comments);
    }
    commentLoaded(docPath, comments.length, performance.now() - t0, file instanceof TFile);
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

  /** 把批注列表写回批注文件；列表为空时删除批注文件。 */
  async save(docPath: string, comments: readonly WtComment[]): Promise<void> {
    const sidecar = sidecarPathFor(docPath);
    const t0 = performance.now();
    this.inflight.delete(docPath);
    const startedAt = (this.generation.get(docPath) ?? 0) + 1;
    this.generation.set(docPath, startedAt);
    const file = this.app.vault.getAbstractFileByPath(sidecar);
    try {
      if (comments.length === 0) {
        if (file instanceof TFile) {
          // 用 FileManager.trashFile 而不是 Vault.delete：前者尊重用户「删除到回收站」的设置
          await this.app.fileManager.trashFile(file);
          commentSidecarDeleted(docPath);
        }
        if ((this.generation.get(docPath) ?? 0) === startedAt) {
          // 写盘期间启动的读取拿到的是旧内容，提升代数让它们不能回写缓存。
          this.generation.set(docPath, startedAt + 1);
          this.cache.set(docPath, []);
        }
        return;
      }
      const text = serializeCommentFile(docPath, comments);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, text);
      } else {
        await this.app.vault.create(sidecar, text);
      }
      // 写盘期间若收到外部 modify 或另一次写入，代数会变化；
      // 此时不能拿本次结果覆盖更新的缓存。
      if ((this.generation.get(docPath) ?? 0) === startedAt) {
        this.generation.set(docPath, startedAt + 1);
        this.cache.set(docPath, [...comments]);
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
}
