import { editorInfoField, Notice, setIcon, TFile } from "obsidian";
import {
  buildChapterLockExtension,
  flashChapterLockPanels,
  syncChapterLock,
  type ChapterLockConfig,
} from "../chapterLock";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import { ConfirmModal } from "../promptModal";
import { stripFrontmatter } from "../wordcount";

/**
 * 章节定稿锁：章节分「草稿 / 定稿」，定稿章节在编辑器里改不了正文。
 *
 * - 状态存在 data.json 的 chapterStatus（路径 → "final"，草稿不存），由 main.ts
 *   统一落盘；模块只改这张表并通知保存。正文与 frontmatter 一个字不写。
 * - 临时解锁只在内存里：这章的标签页全部关闭（同一标签页跳到别的文件也算）后
 *   自动重新锁上，重载 Obsidian 后也恢复锁定。
 * - 外部工具 / Agent 改了定稿章节的正文不拦，只提示一次（同一章 1 分钟内不重复）；
 *   只改了 frontmatter（如章纲存在 frontmatter）不算，按正文指纹比对。
 * - 插件内会写正文的功能经 Editor Service 的写入守卫问「能不能写」，
 *   不需要 import 本模块。
 */
export type ChapterStatusMap = Record<string, "final">;

export interface ChapterStatusStore {
  /** main.ts 持有的状态表（每次现取：loadPluginData 会整张替换）。 */
  finals(): ChapterStatusMap;
  /** 状态表变了，请落盘。 */
  onChanged(): void;
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

/** 同一章被外部修改，多久内只提示一次。 */
const EXTERNAL_NOTICE_INTERVAL_MS = 60_000;
/** 刚重新锁上的几秒内，Obsidian 补存解锁期间的改动也会触发 modify，不算外部修改。 */
const RELOCK_GRACE_MS = 5_000;

export function createChapterStatusModule(
  store: ChapterStatusStore
): ChapterStatusModule {
  let active = false;
  let context: FeatureContext | null = null;
  const unlocked = new Set<string>();
  const relockedAt = new Map<string, number>();
  const lastExternalNotice = new Map<string, number>();
  /** 定稿章节正文（不含 frontmatter）的指纹：判断外部修改是不是真的动了正文。 */
  const bodyPrints = new Map<string, string>();
  const listeners = new Set<() => void>();

  const isFinal = (path: string): boolean => store.finals()[path] === "final";
  const isLocked = (path: string | null): boolean =>
    active && !!path && isFinal(path) && !unlocked.has(path);

  const lockConfig: ChapterLockConfig = {
    isLocked,
    pathOf: (state) => state.field(editorInfoField, false)?.file?.path ?? null,
    onUnlockRequest: (path) => requestUnlock(path),
    onBlocked: (path) => flashChapterLockPanels(path),
    setIcon: (el, icon) => setIcon(el, icon),
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

  /** 让所有打开的编辑器的提示条跟上当前锁定状态。 */
  function syncAll(): void {
    if (!context) return;
    for (const view of context.services.editor.getMarkdownEditorViews()) {
      syncChapterLock(view, lockConfig);
    }
  }

  function isOpenInAnyTab(path: string): boolean {
    if (!context) return false;
    return context.services.ui
      .leaves("markdown")
      .some((leaf) => (leaf.view as { file?: { path?: string } }).file?.path === path);
  }

  /** 临时解锁的章节，标签页全部关掉了就重新锁上。 */
  function relockClosed(): void {
    let changed = false;
    for (const path of [...unlocked]) {
      if (isOpenInAnyTab(path)) continue;
      unlocked.delete(path);
      relockedAt.set(path, Date.now());
      changed = true;
    }
    if (!changed) return;
    syncAll();
    notify();
  }

  function unlock(path: string): void {
    if (!active || !isFinal(path) || unlocked.has(path)) return;
    unlocked.add(path);
    syncAll();
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

  function setFinal(path: string, final: boolean): void {
    if (!active || isFinal(path) === final) return;
    const finals = store.finals();
    if (final) {
      finals[path] = "final";
      rememberBody(path);
    } else {
      delete finals[path];
      unlocked.delete(path);
      bodyPrints.delete(path);
    }
    store.onChanged();
    syncAll();
    notify();
  }

  /** 改名 / 移动：文件本身或它所在的目录，按路径前缀一起搬。 */
  function movePath(path: string, oldPath: string, newPath: string): string | null {
    if (path === oldPath) return newPath;
    if (path.startsWith(oldPath + "/")) return newPath + path.slice(oldPath.length);
    return null;
  }

  function handleRename(newPath: string, oldPath: string): void {
    const finals = store.finals();
    let changed = false;
    for (const key of Object.keys(finals)) {
      const moved = movePath(key, oldPath, newPath);
      if (moved === null) continue;
      delete finals[key];
      finals[moved] = "final";
      changed = true;
    }
    for (const key of [...unlocked]) {
      const moved = movePath(key, oldPath, newPath);
      if (moved === null) continue;
      unlocked.delete(key);
      unlocked.add(moved);
    }
    for (const [key, print] of [...bodyPrints]) {
      const moved = movePath(key, oldPath, newPath);
      if (moved === null) continue;
      bodyPrints.delete(key);
      bodyPrints.set(moved, print);
    }
    if (!changed) return;
    store.onChanged();
    syncAll();
    notify();
  }

  function handleDelete(path: string): void {
    const finals = store.finals();
    let changed = false;
    for (const key of Object.keys(finals)) {
      if (key !== path && !key.startsWith(path + "/")) continue;
      delete finals[key];
      unlocked.delete(key);
      bodyPrints.delete(key);
      changed = true;
    }
    if (!changed) return;
    store.onChanged();
    notify();
  }

  async function readBodyPrint(path: string): Promise<string | null> {
    const file = context?.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !context) return null;
    return bodyPrint(await context.app.vault.cachedRead(file));
  }

  /** 记下定稿章节当前的正文指纹（设为定稿、启动时各一次）。 */
  function rememberBody(path: string): void {
    void readBodyPrint(path)
      .then((print) => {
        if (print !== null && isFinal(path)) bodyPrints.set(path, print);
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
    // 临时解锁期间是作者自己在改；刚重新锁上的几秒内是 Obsidian 补存这些改动。
    if (unlocked.has(path)) return;
    const now = Date.now();
    if (now - (relockedAt.get(path) ?? 0) < RELOCK_GRACE_MS) return;
    // 正文没变（只改了 frontmatter，比如章纲存在 frontmatter 里）：不算修改。
    if (previous === print) return;
    if (now - (lastExternalNotice.get(path) ?? 0) < EXTERNAL_NOTICE_INTERVAL_MS) return;
    lastExternalNotice.set(path, now);
    new Notice(
      `「${basename}」已定稿，但正文刚被修改（可能是 Agent、外部编辑器或同步）。状态仍是定稿。`,
      8000
    );
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
        syncAll();
        context = null;
        listeners.clear();
      });

      ctx.registrations.registerEditorExtension(buildChapterLockExtension(lockConfig));
      ctx.effects.add(
        ctx.services.editor.registerWriteGuard((path) =>
          isLocked(path) ? CHAPTER_LOCKED_REASON : null
        )
      );

      ctx.events.onVault("rename", (file, oldPath) => handleRename(file.path, oldPath));
      ctx.events.onVault("delete", (file) => handleDelete(file.path));
      ctx.events.onVault("modify", (file) => {
        const name = file.name.replace(/\.md$/i, "");
        void handleModify(file.path, name).catch((error) => {
          console.error("[Writing Toolkit:chapter-status] 检查外部修改失败", error);
        });
      });
      for (const event of ["layout-change", "file-open", "active-leaf-change"] as const) {
        ctx.events.onWorkspace(event, () => relockClosed());
      }
      ctx.events.onLayoutReady(() => {
        syncAll();
        for (const path of Object.keys(store.finals())) rememberBody(path);
      });
    },
    operations,
  };
}
