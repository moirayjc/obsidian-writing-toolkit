import {
  pathBasename,
  type SnapshotEntry,
  type SnapshotOperations,
} from "./snapshot";
import {
  showSnapshotDiff,
  type SnapshotDiffHost,
} from "./snapshotDiff";
import { setIcon } from "obsidian";
import type { WordCountMode } from "./wordcount";

interface RowRef {
  deltaEl: HTMLElement;
  count: number;
}

export interface SnapshotPanelRuntime extends SnapshotDiffHost {
  getActiveText(): string | null;
  getWordCountMode(): WordCountMode;
  getSnapshotMaxPerFile(): number;
}

export interface SnapshotPanelHandle {
  refresh(): void;
  updateLive(text?: string | null): void;
  destroy(): void;
}

/**
 * 侧栏「草稿快照」操作面板：
 * 保存当前快照、按时间列出快照、对比（diff）、恢复、复制内容用于粘贴修文。
 */
export class SnapshotOperationPanel implements SnapshotPanelHandle {
  private readonly el: HTMLElement;
  private readonly operations: SnapshotOperations;
  private readonly runtime: SnapshotPanelRuntime;

  private currentFilePath: string | null = null;
  private currentCount = 0;
  private currentNumEl: HTMLElement | null = null;
  private rowRefs: RowRef[] = [];
  private renderTimer: number = 0;
  private renderSeq = 0;

  constructor(
    el: HTMLElement,
    operations: SnapshotOperations,
    runtime: SnapshotPanelRuntime
  ) {
    this.el = el;
    this.operations = operations;
    this.runtime = runtime;
  }

  /** 全量刷新（切换文件 / 保存快照后调用，内部防抖）。 */
  refresh(): void {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = 0;
      void this.render();
    }, 120);
  }

  /** 轻量更新：只刷新当前字数与各快照差值（打字时调用，不读盘）。 */
  updateCurrentCount(text?: string | null): void {
    if (!this.currentFilePath) return;
    if (text === null || text === undefined) return;
    this.currentCount = text ? this.runtime.countWords(text) : 0;
    if (this.currentNumEl) {
      this.currentNumEl.setText(formatNumber(this.currentCount));
    }
    for (const ref of this.rowRefs) {
      this.updateDelta(ref.deltaEl, ref.count - this.currentCount);
    }
  }

  updateLive(text?: string | null): void {
    this.updateCurrentCount(text);
  }

  destroy(): void {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderSeq++;
    this.el.empty();
  }

  private async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const el = this.el;
    el.empty();
    this.rowRefs = [];
    this.currentNumEl = null;
    this.currentFilePath = null;

    const path = this.runtime.getActiveFilePath();
    this.currentFilePath = path;

    const toolbar = el.createDiv({ cls: "wt-snap-toolbar" });
    toolbar.createSpan({
      cls: "wt-snap-file",
      text: path ? pathBasename(path) : "无活动文件",
    });
    const saveBtn = toolbar.createEl("button", {
      cls: "wt-snap-btn wt-snap-primary wt-snap-save",
    });
    setIcon(saveBtn, "wt-save");
    saveBtn.createSpan({ text: "保存快照" });
    saveBtn.addEventListener("click", () => {
      void this.operations.saveSnapshotNow().then(() => this.refresh());
    });

    const currentText = this.runtime.getActiveText();
    this.currentCount = currentText ? this.runtime.countWords(currentText) : 0;
    const currentWrap = el.createDiv({ cls: "wt-snap-current" });
    currentWrap.createDiv({ cls: "wt-snap-current-dot" });
    currentWrap.createSpan({ cls: "wt-snap-current-label", text: "当前" });
    this.currentNumEl = currentWrap.createSpan({ cls: "wt-snap-current-num" });
    currentWrap.createSpan({ cls: "wt-snap-current-unit", text: "字" });

    if (!path) {
      const empty = el.createDiv({ cls: "wt-snap-empty" });
      const iconEl = empty.createDiv({ cls: "wt-snap-empty-icon" });
      setIcon(iconEl, "wt-history");
      empty.createDiv({
        text: "打开一个笔记后，可在此保存、对比、恢复和复制草稿快照。",
      });
      return;
    }

    const list = el.createDiv({ cls: "wt-snap-list" });
    let entries: SnapshotEntry[] = [];
    try {
      entries = await this.operations.listSnapshots(
        path,
        this.runtime.getWordCountMode()
      );
    } catch {
      entries = [];
    }
    if (seq !== this.renderSeq) return;

    if (entries.length === 0) {
      const empty = list.createDiv({ cls: "wt-snap-empty" });
      const iconEl = empty.createDiv({ cls: "wt-snap-empty-icon" });
      setIcon(iconEl, "wt-history");
      empty.createDiv({
        text: "当前文件还没有快照。写作会话结束、连续写作超过设定时间，或点击「保存快照」都会自动生成。",
      });
    } else {
      const sourcePath = path;
      for (const entry of entries) {
        const row = list.createDiv({ cls: "wt-snap-row" });
        // 版本圆点：一眼看出这是历史版本
        row.createDiv({ cls: "wt-snap-dot" });
        const timeEl = row.createDiv({
          cls: "wt-snap-time",
          text: relativeTime(entry.at),
        });
        timeEl.setAttr(
          "title",
          `${entry.name}\n${new Date(entry.at).toLocaleString("zh-CN")}`
        );
        row.createDiv({ cls: "wt-snap-count", text: `${formatNumber(entry.wordCount)} 字` });
        const deltaEl = row.createDiv({ cls: "wt-snap-delta" });
        this.rowRefs.push({ deltaEl, count: entry.wordCount });
        // 行尾淡色箭头：提示整行可点击进入对比
        const openEl = row.createDiv({ cls: "wt-snap-open" });
        setIcon(openEl, "wt-chevron-right");
        // 点击整行 → 直接进入对比界面（编辑/恢复都在那里完成）
        row.addEventListener("click", () => {
          showSnapshotDiff(
            this.runtime,
            this.operations,
            sourcePath,
            entry.path,
            entry.name,
            () => this.refresh()
          );
        });
      }
    }
    this.updateCurrentCount(currentText);

    const footer = el.createDiv({ cls: "wt-snap-footer" });
    const max = this.runtime.getSnapshotMaxPerFile();
    footer.createSpan({
      cls: "wt-snap-meta",
      text: `共 ${entries.length} 份${max > 0 ? ` / 上限 ${max}` : ""}`,
    });
    const openBtn = footer.createEl("button", {
      cls: "wt-snap-btn wt-snap-folder-btn",
    });
    setIcon(openBtn, "wt-folder");
    openBtn.createSpan({ text: "打开文件夹" });
    openBtn.addEventListener("click", () =>
      void this.operations.openSnapshotFolder()
    );
  }

  private updateDelta(el: HTMLElement, delta: number): void {
    el.setText(formatDelta(delta));
    el.toggleClass("is-pos", delta > 0);
    el.toggleClass("is-neg", delta < 0);
  }

}

export function createSnapshotPanel(
  el: HTMLElement,
  operations: SnapshotOperations,
  runtime: SnapshotPanelRuntime
): SnapshotPanelHandle {
  return new SnapshotOperationPanel(el, operations, runtime);
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDelta(n: number): string {
  if (n > 0) return `+${formatNumber(n)}`;
  if (n < 0) return `-${formatNumber(Math.abs(n))}`;
  return "±0";
}

function relativeTime(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
