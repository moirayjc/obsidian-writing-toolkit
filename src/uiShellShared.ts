/**
 * 阶段 5：UI Shell 之间共享的纯展示工具与只读缓存。
 *
 * 主页、编辑台、工具箱曾经互相 import 这些符号（home → workbench / sidebar），
 * 形成 Shell 之间的直接依赖。把与具体视图无关的部分集中到这里，
 * 三个 Shell 都只依赖本文件，不再互相 import。
 *
 * 这里不放业务状态：`fileStatCache` 只是跨视图复用的字数缓存，
 * 失效规则仍由使用方按 mtime + size 决定。
 */
import type { WordCountMode } from "./wordcount";

/** 作品连载状态（存在插件数据里，按作品根目录记录）。 */
export type WorkbenchStatus = "ongoing" | "completed" | "hiatus";

export const STATUS_LABEL: Record<WorkbenchStatus, string> = {
  ongoing: "连载中",
  completed: "已完结",
  hiatus: "暂停更新",
};

/** 文件统计缓存（跨视图重建复用；按 mtime + size 失效）。 */
export interface CachedFileStat {
  mtime: number;
  size: number;
  words: number;
}

/** 供主页 / 编辑台共享的只读字数缓存。 */
export const fileStatCache = new Map<string, CachedFileStat>();

/** 存档类作品：在作品切换菜单里排到后面。 */
export const ARCHIVE_RE = /存档|归档|完结|archive/i;

/** 字数模式显示名（侧栏、主页、统计设置共用）。 */
export const WORD_COUNT_MODE_LABELS: Record<WordCountMode, string> = {
  webnovel: "番茄模式（含标点）",
  standard: "标准模式（汉字+字母+数字）",
  native: "原生模式（分词计数）",
};

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** 总字数拆成「数字 + 单位」：超过一万用「万字」。 */
export function splitWords(n: number): [string, string] {
  if (n >= 10000) return [(n / 10000).toFixed(1), "万字"];
  return [formatNumber(n), "字"];
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}

/** 目录名开头的排序码（如「1-1-5-2 」「P3.2-」）只是用来排顺序，展示时去掉。 */
export function displayFolderName(name: string): string {
  const cleaned = name
    .replace(/^[A-Za-z]{0,2}\d+(?:[.-]\d+)*[\s.-]+\s*/, "")
    .trim();
  return cleaned || name;
}

/** 书名显示：去掉外层《》，过长时交给 CSS 省略号。 */
export function displayProjectName(name: string): string {
  const m = /^《(.+)》$/.exec(name.trim());
  return m ? m[1] : name;
}

/**
 * 资料文件名拆分：`【资料】0713-李仪` → 标签「资料」+ 名称「李仪」。
 * 只做显示用，搜索仍匹配完整文件名。
 */
export function parseResourceName(base: string): {
  tag: string | null;
  name: string;
} {
  let tag: string | null = null;
  let rest = base;
  const m = /^[【[]([^】\]]{1,8})[】\]]\s*(.*)$/.exec(base);
  if (m) {
    tag = m[1];
    rest = m[2];
  }
  // 去掉 `0713-` 这类日期前缀（修改时间已单独显示）
  rest = rest.replace(/^\d{4}\s*[-_－—·]\s*/, "").trim();
  return { tag, name: rest || base };
}
