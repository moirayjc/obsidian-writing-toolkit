import { editorInfoField, Notice, setIcon, TFile } from "obsidian";
import { buildChapterLockExtension, type ChapterLockConfig } from "../chapterLock";
import { stripFrontmatter } from "../formatWrap";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import { ConfirmModal } from "../promptModal";

/**
 * 章节定稿锁：章节分「草稿 / 定稿」，定稿章节在编辑器里改不了正文。
 *
 * - 状态存在**这一章自己的 frontmatter**：定稿写 `wt-status: 定稿`，改回草稿删掉
 *   这个字段，别的 frontmatter 与正文一个字不动。章节文件随网盘同步，所以两端状态
 *   跟着文件走；读状态走元数据缓存，对方改了这边不用重启就跟上（2026-10-22 起；
 *   之前存 data.json，两端整份覆盖写会互相盖掉）。
 * - 临时解锁只在内存里：这章的标签页全部关闭（同一标签页跳到别的文件也算）后
 *   自动重新锁上，重载 Obsidian 后也恢复锁定。
 * - 外部工具 / Agent 改了定稿章节的正文不拦，只提示一次（同一章 1 分钟内不重复）；
 *   只改了 frontmatter（章纲、定稿状态本身）不算，按正文指纹比对。
 * - 插件内会写正文的功能经 Editor Service 的写入守卫问「能不能写」，
 *   不需要 import 本模块。
 * - 「本章已定稿」提示条挂在笔记视图上（标题栏与正文之间），不放在 CodeMirror
 *   面板里：手机端实测面板不显示；挂在视图上桌面 / 手机、编辑 / 阅读模式都看得到。
 */
export interface ChapterStatusStore {
  /** 旧版存在 data.json 的定稿表（路径 → "final"），只用于一次性搬进 frontmatter。 */
  legacyFinals(): Record<string, unknown> | null;
  /** 旧表已搬完：从 data.json 删掉并落盘。 */
  clearLegacy(): void;
}

export interface ChapterStatusOperations {
  isFinal(path: string): boolean;
  setFinal(path: string, final: boolean): void;
  /** 定稿且没有临时解锁。 */
  isLocked(path: string | null): boolean;
  /** 弹一次确认，确认后临时解锁。 */
  requestUnlock(path: string): void;
  /** 直接临时解锁（确认之后调用）。 */
  unlock(path: string): void;
  /** 状态或锁定变化时回调（编辑台刷新锁标记用）。 */
  subscribe(listener: () => void): () => void;
}

export interface ChapterStatusModule extends FeatureModule {
  readonly operations: ChapterStatusOperations;
}

/** frontmatter 里的状态字段：只认这个键、这个值，其余都当草稿。 */
export const CHAPTER_STATUS_KEY = "wt-status";
export const CHAPTER_FINAL_VALUE = "定稿";

/** 正文指纹：去掉 frontmatter 后的长度 + FNV-1a 哈希（只用来判断变没变）。 */
export function bodyPrint(text: string): string {
  const body = stripFrontmatter(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${body.length}:${(hash >>> 0).toString(16)}`;
}

export const CHAPTER_LOCKED_REASON = "本章已定稿，先在编辑器顶部点「临时解锁」";

/** 挂了提示条的笔记视图外壳：样式据此让正文区让出提示条的高度。 */
const BANNER_HOST_CLASS = "wt-has-lock-banner";

/** 同一章被外部修改，多久内只提示一次。 */
const EXTERNAL_NOTICE_INTERVAL_MS = 60_000;
/** 刚重新锁上的几秒内，Obsidian 补存解锁期间的改动也会触发 modify，不算外部修改。 */
const RELOCK_GRACE_MS = 5_000;

/** 笔记视图里本模块用到的部分（MarkdownView 的子集）。 */
interface NoteViewLike {
  file?: { path?: string } | null;
  /** 视图外壳（.workspace-leaf-content）：标题栏和正文区都在里面 */
  containerEl?: HTMLElement;
  /** 正文区（.view-content） */
  contentEl?: HTMLElement;
}

interface LockBanner {
  el: HTMLElement;
  path: string | null;
}

/** 改名 / 移动：文件本身或它所在的目录，按路径前缀一起搬。 */
function movePath(path: string, oldPath: string, newPath: string): string | null {
  if (path === oldPath) return newPath;
  if (path.startsWith(oldPath + "/")) return newPath + path.slice(oldPath.length);
  return null;
}

function moveKeys(map: Map<string, unknown>, oldPath: string, newPath: string): void {
  for (const [key, value] of [...map]) {
    const moved = movePath(key, oldPath, newPath);
    if (moved === null) continue;
    map.delete(key);
    map.set(moved, value);
  }
}

function dropKeys(map: Map<string, unknown>, path: string): void {
  for (const key of [...map.keys()]) {
    if (key === path || key.startsWith(path + "/")) map.delete(key);
  }
}

export function createChapterStatusModule(
  store: ChapterStatusStore
): ChapterStatusModule {
  let active = false;
  let context: FeatureContext | null = null;
  /** 临时解锁中的章节（值无意义，用 Map 方便和别的表一起搬路径）。 */
  const unlocked = new Map<string, true>();
  const relockedAt = new Map<string, number>();
  const lastExternalNotice = new Map<string, number>();
  /** 定稿章节正文（不含 frontmatter）的指纹：判断外部修改是不是真的动了正文。 */
  const bodyPrints = new Map<string, string>();
  /** 上次看到的定稿集合：只用来发现「状态变了」（真相永远现读 frontmatter）。 */
  const knownFinals = new Map<string, true>();
  const pathTables: Map<string, unknown>[] = [
    unlocked,
    relockedAt,
    lastExternalNotice,
    bodyPrints,
    knownFinals,
  ];
  const listeners = new Set<() => void>();
  /** 视图外壳 → 它上面的提示条 */
  const banners = new Map<HTMLElement, LockBanner>();

  function fileAt(path: string): TFile | null {
    const file = context?.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  const isFinal = (path: string): boolean => {
    const file = fileAt(path);
    if (!file || !context) return false;
    const frontmatter = context.app.metadataCache.getFileCache(file)?.frontmatter;
    return frontmatter?.[CHAPTER_STATUS_KEY] === CHAPTER_FINAL_VALUE;
  };
  const isLocked = (path: string | null): boolean =>
    active && !!path && isFinal(path) && !unlocked.has(path);

  const lockConfig: ChapterLockConfig = {
    isLocked,
    pathOf: (state) => state.field(editorInfoField, false)?.file?.path ?? null,
    onBlocked: (path) => flashBanners(path),
  };

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[Writing Toolkit:chapter-status] 状态订阅回调失败", error);
      }
    }
  }

  // ---------- 提示条 ----------

  function createBanner(view: NoteViewLike): HTMLElement {
    const el = createDiv({ cls: "wt-lock-banner" });
    setIcon(el.createSpan({ cls: "wt-lock-banner-icon" }), "wt-lock");
    el.createSpan({ cls: "wt-lock-banner-text", text: "本章已定稿" });
    const button = el.createEl("button", {
      cls: "wt-lock-banner-btn",
      text: "临时解锁",
      attr: { type: "button", title: "临时解锁本章；关闭这章的标签页后自动重新锁上" },
    });
    button.addEventListener("click", () => {
      const path = view.file?.path;
      if (path) requestUnlock(path);
    });
    el.addEventListener("animationend", () => el.removeClass("is-flash"));
    return el;
  }

  function removeBanner(host: HTMLElement, banner: LockBanner): void {
    banner.el.remove();
    host.removeClass(BANNER_HOST_CLASS);
    banners.delete(host);
  }

  /** 让每个笔记视图的提示条跟上当前锁定状态：锁定就挂上，否则摘掉。 */
  function refreshBanners(): void {
    const seen = new Set<HTMLElement>();
    for (const leaf of context?.services.ui.leaves("markdown") ?? []) {
      const view = leaf.view as NoteViewLike;
      const host = view.containerEl;
      const content = view.contentEl;
      if (!host || !content) continue;
      seen.add(host);
      const path = view.file?.path ?? null;
      const existing = banners.get(host);
      if (isLocked(path)) {
        if (existing) {
          existing.path = path;
          continue;
        }
        const el = createBanner(view);
        host.insertBefore(el, content);
        host.addClass(BANNER_HOST_CLASS);
        banners.set(host, { el, path });
      } else if (existing) {
        removeBanner(host, existing);
      }
    }
    // 关掉的标签页：视图已经不在了，提示条一并清理
    for (const [host, banner] of [...banners]) {
      if (!seen.has(host)) removeBanner(host, banner);
    }
  }

  /** 编辑被拦下时闪一下这章的提示条，告诉作者为什么打字没反应。 */
  function flashBanners(path: string): void {
    for (const banner of banners.values()) {
      if (banner.path !== path) continue;
      banner.el.removeClass("is-flash");
      // 强制重排，让同一个动画可以连续触发
      void banner.el.offsetWidth;
      banner.el.addClass("is-flash");
    }
  }

  // ---------- 解锁 / 重新锁上 ----------

  function isOpenInAnyTab(path: string): boolean {
    if (!context) return false;
    return context.services.ui
      .leaves("markdown")
      .some((leaf) => (leaf.view as NoteViewLike).file?.path === path);
  }

  /** 临时解锁的章节，标签页全部关掉了就重新锁上。 */
  function relockClosed(): void {
    let changed = false;
    for (const path of [...unlocked.keys()]) {
      if (isOpenInAnyTab(path)) continue;
      unlocked.delete(path);
      relockedAt.set(path, Date.now());
      changed = true;
    }
    if (changed) notify();
  }

  function unlock(path: string): void {
    if (!active || !isFinal(path) || unlocked.has(path)) return;
    unlocked.set(path, true);
    refreshBanners();
    notify();
  }

  function requestUnlock(path: string): void {
    if (!context || !isLocked(path)) return;
    new ConfirmModal(
      context.app,
      "临时解锁本章",
      "这章已经定稿了，确定要回去改吗？想到要改的地方，也可以先选中文字记一条批注，留到修订时一起处理。关闭这章的标签页后会自动重新锁上。",
      "临时解锁",
      () => unlock(path)
    ).open();
  }

  // ---------- 状态读写（frontmatter） ----------

  /** 只改 frontmatter 里的 wt-status 这一个字段。 */
  async function writeStatus(path: string, final: boolean): Promise<void> {
    const file = fileAt(path);
    if (!file || !context) return;
    await context.app.fileManager.processFrontMatter(
      file,
      (frontmatter: Record<string, unknown>) => {
        if (final) frontmatter[CHAPTER_STATUS_KEY] = CHAPTER_FINAL_VALUE;
        else delete frontmatter[CHAPTER_STATUS_KEY];
      }
    );
  }

  function setFinal(path: string, final: boolean): void {
    if (!active || isFinal(path) === final) return;
    void writeStatus(path, final)
      .then(() => statusMaybeChanged(path))
      .catch((error) => {
        console.error("[Writing Toolkit:chapter-status] 保存定稿状态失败", error);
        new Notice("写作工具箱：保存定稿状态失败（详见控制台）");
      });
  }

  /** 某个文件的 frontmatter 可能变了（本机写入或同步过来）：状态真变了才刷新。 */
  function statusMaybeChanged(path: string): void {
    const now = isFinal(path);
    if (now === knownFinals.has(path)) return;
    if (now) {
      knownFinals.set(path, true);
      rememberBody(path);
    } else {
      knownFinals.delete(path);
      unlocked.delete(path);
      bodyPrints.delete(path);
    }
    refreshBanners();
    notify();
  }

  /** 全库重扫一遍定稿集合（元数据缓存就绪时）。 */
  function rescanAll(): void {
    if (!context) return;
    knownFinals.clear();
    for (const file of context.app.vault.getMarkdownFiles()) {
      if (!isFinal(file.path)) continue;
      knownFinals.set(file.path, true);
      if (!bodyPrints.has(file.path)) rememberBody(file.path);
    }
    for (const path of [...unlocked.keys()]) {
      if (!knownFinals.has(path)) unlocked.delete(path);
    }
    refreshBanners();
    notify();
  }

  /** 旧版 data.json 里的定稿表：一次性搬进各章 frontmatter，然后从 data.json 删掉。 */
  async function migrateLegacy(): Promise<void> {
    const legacy = store.legacyFinals();
    if (!legacy) return;
    for (const [path, value] of Object.entries(legacy)) {
      if (value !== "final" || !fileAt(path) || isFinal(path)) continue;
      await writeStatus(path, true);
    }
    store.clearLegacy();
  }

  // ---------- 外部修改提示 ----------

  async function readBodyPrint(path: string): Promise<string | null> {
    const file = fileAt(path);
    if (!file || !context) return null;
    return bodyPrint(await context.app.vault.cachedRead(file));
  }

  /** 记下定稿章节当前的正文指纹（变成定稿时、启动时各一次）。 */
  function rememberBody(path: string): void {
    void readBodyPrint(path)
      .then((print) => {
        if (print !== null && isFinal(path) && !bodyPrints.has(path)) {
          bodyPrints.set(path, print);
        }
      })
      .catch((error) => {
        console.error("[Writing Toolkit:chapter-status] 读取定稿章节失败", error);
      });
  }

  /** 定稿章节被插件以外的程序改了正文：不拦，只提示。 */
  async function handleModify(path: string, basename: string): Promise<void> {
    if (!isFinal(path)) return;
    const print = await readBodyPrint(path);
    if (print === null || !isFinal(path)) return;
    const previous = bodyPrints.get(path);
    bodyPrints.set(path, print);
    // 还不知道原来的正文（刚变成定稿、启动时没读到）：只记下来，不猜。
    if (previous === undefined) return;
    // 临时解锁期间是作者自己在改；刚重新锁上的几秒内是 Obsidian 补存这些改动。
    if (unlocked.has(path)) return;
    const now = Date.now();
    if (now - (relockedAt.get(path) ?? 0) < RELOCK_GRACE_MS) return;
    // 正文没变（只改了 frontmatter：章纲、定稿状态本身）：不算修改。
    if (previous === print) return;
    if (now - (lastExternalNotice.get(path) ?? 0) < EXTERNAL_NOTICE_INTERVAL_MS) return;
    lastExternalNotice.set(path, now);
    new Notice(
      `「${basename}」已定稿，但正文刚被修改（可能是 Agent、外部编辑器或同步）。状态仍是定稿。`,
      8000
    );
  }

  // ---------- 改名 / 删除：只搬内存里的表（状态本身在 frontmatter，跟着文件走） ----------

  function handleRename(newPath: string, oldPath: string): void {
    for (const table of pathTables) moveKeys(table, oldPath, newPath);
    refreshBanners();
    notify();
  }

  function handleDelete(path: string): void {
    for (const table of pathTables) dropKeys(table, path);
    refreshBanners();
    notify();
  }

  const operations: ChapterStatusOperations = {
    isFinal,
    setFinal,
    isLocked,
    requestUnlock,
    unlock,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    id: "chapter-status",
    activate(ctx) {
      context = ctx;
      active = true;
      ctx.effects.add(() => {
        active = false;
        unlocked.clear();
        // 停用时把提示条收掉；过滤器随后也因 active=false 全部放行。
        for (const [host, banner] of [...banners]) removeBanner(host, banner);
        context = null;
        listeners.clear();
      });

      ctx.registrations.registerEditorExtension(buildChapterLockExtension(lockConfig));
      ctx.effects.add(
        ctx.services.editor.registerWriteGuard((path) =>
          isLocked(path) ? CHAPTER_LOCKED_REASON : null
        )
      );

      // frontmatter 解析结果更新：本机改了状态、或网盘同步来了对方的改动。
      ctx.events.onMetadata("changed", (file) => statusMaybeChanged(file.path));
      ctx.events.onMetadata("resolved", () => rescanAll());

      ctx.events.onVault("rename", (file, oldPath) => handleRename(file.path, oldPath));
      ctx.events.onVault("delete", (file) => handleDelete(file.path));
      ctx.events.onVault("modify", (file) => {
        const name = file.name.replace(/\.md$/i, "");
        void handleModify(file.path, name).catch((error) => {
          console.error("[Writing Toolkit:chapter-status] 检查外部修改失败", error);
        });
      });
      // 打开 / 切换 / 关闭标签页：先把关掉的临时解锁重新锁上，再让提示条跟上。
      for (const event of ["layout-change", "file-open", "active-leaf-change"] as const) {
        ctx.events.onWorkspace(event, () => {
          relockClosed();
          refreshBanners();
        });
      }
      ctx.events.onLayoutReady(() => {
        rescanAll();
        void migrateLegacy().catch((error) => {
          console.error("[Writing Toolkit:chapter-status] 迁移旧定稿状态失败", error);
        });
      });
    },
    operations,
  };
}
