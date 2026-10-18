/**
 * 统计读模型 Service：今日数字、每日/作品展示用的历史、统计范围与今日明细。
 *
 * 数据本身仍由 main.ts 在编辑器/番茄事件中结算（写入链路未变），但读模型与
 * 状态栏的更新广播集中在这里：main 只调用 publish()，状态栏订阅一次即可，
 * 不再由 main 手写 7 处 setState 扇出。
 */
import { Notice } from "obsidian";
import type { WritingToolkitSettings } from "../settingsSchema";
import type { WordCountMode } from "../wordcount";

export interface StatusBarState {
  showSpeed: boolean;
  /** 今日净增（可正可负）：状态栏、今日目标与热力图显示的都是它 */
  dailyTotal: number;
  dailyGoal: number;
  wordCountMode: WordCountMode;
}

export interface StatsServiceHost {
  dailyHistory(): Record<string, number>;
  projectHistory(): Record<string, Record<string, number>>;
  projectDurationHistory(): Record<string, Record<string, number>>;
  dailyFileDeltas(): Record<string, Record<string, number>>;
  todayTotals(): {
    total: number;
    durationSeconds: number;
  };
  todayKey(): string;
  getSettings(): WritingToolkitSettings;
  getPomodoroSummary(): { count: number; words: number } | null;
  isProjectHidden(root: string): boolean;
  projectRootForFile(path: string): string | null;
  listMarkdownPaths(): string[];
  getSpeed(): number;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export class StatsService {
  private readonly listeners = new Set<(state: StatusBarState) => void>();

  constructor(private readonly host: StatsServiceHost) {}

  /** 当前状态栏需要的一屏数字。 */
  currentState(): StatusBarState {
    const totals = this.host.todayTotals();
    const settings = this.host.getSettings();
    return {
      dailyTotal: totals.total,
      dailyGoal: settings.dailyGoal,
      wordCountMode: settings.wordCountMode,
      showSpeed: settings.showSpeed,
    };
  }

  /** 通知所有订阅者（状态栏等）。 */
  publish(): void {
    const state = this.currentState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        console.error("[Writing Toolkit:stats] 统计订阅回调失败", error);
      }
    }
  }

  subscribe(listener: (state: StatusBarState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTodayDurationSeconds(): number {
    return this.host.todayTotals().durationSeconds;
  }

  getTodayPomodoroSummary(): { count: number; words: number } | null {
    return this.host.getPomodoroSummary();
  }

  statusBarSpeed(): number {
    return this.host.getSpeed();
  }

  /** 热力图 / 今日目标显示：每日净增字数（可正可负，删除会抵减）。 */
  dailyForDisplay(): Record<string, number> {
    return { ...this.host.dailyHistory() };
  }

  /** 同上，但限定某个作品。 */
  projectForDisplay(key: string): Record<string, number> {
    return { ...(this.host.projectHistory()[key] || {}) };
  }

  /**
   * 侧栏「统计范围」下拉框的作品列表。
   * keepKey 传当前选中的作品，即使它已被隐藏也保留一行，避免选中项从下拉框里消失。
   */
  getProjects(keepKey?: string | null): { key: string; label: string }[] {
    const settings = this.host.getSettings();
    const keys = new Set<string>();
    const snapshotFolder = (
      settings.snapshotFolder.trim() || ".wt-snapshots"
    ).replace(/^\/+|\/+$/g, "");
    const isSnapshotPath = (path: string): boolean =>
      !!snapshotFolder &&
      (path === snapshotFolder || path.startsWith(snapshotFolder + "/"));
    const collect = (map: Record<string, unknown>): void => {
      for (const key of Object.keys(map)) {
        if (!isSnapshotPath(key)) keys.add(key);
      }
    };
    collect(this.host.projectHistory());
    collect(this.host.projectDurationHistory());
    for (const path of this.host.listMarkdownPaths()) {
      const project = this.host.projectRootForFile(path);
      if (project) keys.add(project);
    }
    const list = [...keys].map((key) => ({
      key,
      label: key.split("/").pop() || key,
    }));
    list.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    return list.filter(
      (item) => !this.host.isProjectHidden(item.key) || item.key === keepKey
    );
  }

  /** 今日字数明细：查出"今天这个数是怎么来的"。 */
  showDailyBreakdown(): void {
    const day = this.host.todayKey();
    const deltas = this.host.dailyFileDeltas()[day] || {};
    const entries = Object.entries(deltas)
      .filter(([, value]) => value !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (entries.length === 0) {
      new Notice("今天还没有字数变化记录");
      return;
    }
    const lines = entries.slice(0, 8).map(([path, value]) => {
      const name = path.split("/").pop() ?? path;
      return `${value > 0 ? "+" : ""}${formatNumber(value)}  ${name}`;
    });
    const net = entries.reduce((sum, [, value]) => sum + value, 0);
    new Notice(
      `今日净增 ${formatNumber(net)} 字（新增为正，删除为负）\n` +
        lines.join("\n") +
        (entries.length > 8 ? `\n…另有 ${entries.length - 8} 个文件` : ""),
      12000
    );
  }
}
