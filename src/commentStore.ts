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
    const task = this.readFromVault(docPath, gen).finally(() => {
      this.inflight.delete(docPath);
    });
    this.inflight.set(docPath, task);
    return task;
  }

  private async readFromVault(
    docPath: string,
    gen: number
  ): Promise<WtComment[]> {
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
    this.generation.set(docPath, (this.generation.get(docPath) ?? 0) + 1);
  }

  /** 把批注列表写回批注文件；列表为空时删除批注文件。 */
  async save(docPath: string, comments: readonly WtComment[]): Promise<void> {
    const sidecar = sidecarPathFor(docPath);
    this.generation.set(docPath, (this.generation.get(docPath) ?? 0) + 1);
    const file = this.app.vault.getAbstractFileByPath(sidecar);
    if (comments.length === 0) {
      this.cache.set(docPath, []);
      if (file instanceof TFile) {
        await this.app.vault.delete(file);
      }
      return;
    }
    const text = serializeCommentFile(docPath, comments);
    this.cache.set(docPath, [...comments]);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, text);
    } else {
      await this.app.vault.create(sidecar, text);
    }
  }

  /** vault "modify"：批注文件被外部（Agent / 编辑）改写 → 缓存失效。 */
  handleModified(path: string): string | null {
    if (!isSidecarPath(path)) return null;
    const docPath = docPathForSidecar(path);
    this.invalidate(docPath);
    return docPath;
  }

  /** vault "delete"：批注文件被删 → 视为空。 */
  handleDeleted(path: string): string | null {
    if (!isSidecarPath(path)) return null;
    const docPath = docPathForSidecar(path);
    this.generation.set(docPath, (this.generation.get(docPath) ?? 0) + 1);
    this.cache.set(docPath, []);
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
