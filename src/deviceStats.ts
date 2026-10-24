/**
 * 跨设备字数统计（specs/cross-device-stats.md）。
 *
 * **今日净增 = 现在所有正文章节的字数 − 今天开始时的字数。**
 * 只看书稿本身：文件同步完以后，每台设备算出来的一样，天然不会因为同步重复计数。
 *
 * 每台设备只写自己的统计文件 `_写作工具箱/统计/<设备ID>.json`，读的时候读全部：
 * - 今日起点（starts）：每台设备每天第一次运行时记下各章字数；多台都记了用**最早**的那份。
 * - 每日结果（results）：算出来的净增，过去某天显示**最晚**算出的那份（信息最全）。
 * - 写作时长、写下的字（时速）、番茄：本机编辑器里的活动，各设备各记，显示**加总**。
 * - 切换口径前的历史（旧 data.json 迁出的 legacy.json、第一版统计文件里的数字）原样保留，
 *   只用于还没有新口径结果的日期，按设备加总。
 *
 * 本文件只放纯逻辑（不依赖 obsidian），由 main.ts 负责读写文件与接线。
 */

export type DailyHistory = Record<string, number>;

export interface DailyPomodoro {
  count: number;
  words: number;
}

/** 统计文件里沿用旧 data.json 字段名的那部分（迁移时可直接搬）。 */
export interface StatsMaps {
  /** 旧口径（按事件计）的每日净增：切换后不再写，只读 */
  dailyHistory: DailyHistory;
  dailyDurationHistory: DailyHistory;
  /** 旧口径的按作品每日净增：只读 */
  projectHistory: Record<string, DailyHistory>;
  projectDurationHistory: Record<string, DailyHistory>;
  /** 旧口径的每日各文件明细：只读 */
  dailyFileDeltas: Record<string, DailyHistory>;
  dailyTypedHistory: DailyHistory;
  dailyPomodoroHistory: Record<string, DailyPomodoro>;
}

export const STATS_MAP_KEYS: readonly (keyof StatsMaps)[] = [
  "dailyHistory",
  "dailyDurationHistory",
  "projectHistory",
  "projectDurationHistory",
  "dailyFileDeltas",
  "dailyTypedHistory",
  "dailyPomodoroHistory",
];

/** 今日起点：当时各章字数。mode 是当时的字数统计口径，口径不同的起点不能拿来做差。 */
export interface DayStart {
  at: number;
  mode: string;
  files: Record<string, number>;
}

/** 某天算出来的净增。files 只留最近 RESULT_FILES_DAYS 天（只有「今日明细」用得到）。 */
export interface DayResult {
  at: number;
  total: number;
  projects: Record<string, number>;
  files: Record<string, number>;
}

export interface LedgerFile extends StatsMaps {
  version: 2;
  deviceId: string;
  deviceName: string;
  updatedAt: number;
  starts: Record<string, DayStart>;
  results: Record<string, DayResult>;
}

export const STATS_FOLDER = "_写作工具箱/统计";
/** 旧版 data.json 里的历史统计一次性迁到这里，加总时当成一台「旧设备」。 */
export const LEGACY_DEVICE_ID = "legacy";
export const LEGACY_FILE = `${STATS_FOLDER}/${LEGACY_DEVICE_ID}.json`;

/** 起点只留最近几天（只有今天和跨零点那一刻用得到）。 */
export const STARTS_KEEP_DAYS = 3;
/** 结果里的各章明细只留最近这么多天。 */
export const RESULT_FILES_DAYS = 60;

export function ledgerPath(deviceId: string): string {
  return `${STATS_FOLDER}/${deviceId}.json`;
}

/** 统计目录里该读的文件：*.json，排除同步冲突副本。 */
export function isLedgerFileName(name: string): boolean {
  return name.endsWith(".json") && !name.includes(".sync-conflict-");
}

export function emptyStatsMaps(): StatsMaps {
  return {
    dailyHistory: {},
    dailyDurationHistory: {},
    projectHistory: {},
    projectDurationHistory: {},
    dailyFileDeltas: {},
    dailyTypedHistory: {},
    dailyPomodoroHistory: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberMap(value: unknown): DailyHistory {
  const out: DailyHistory = {};
  if (!isRecord(value)) return out;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

function nestedMap(value: unknown): Record<string, DailyHistory> {
  const out: Record<string, DailyHistory> = {};
  if (!isRecord(value)) return out;
  for (const [key, v] of Object.entries(value)) out[key] = numberMap(v);
  return out;
}

function pomodoroMap(value: unknown): Record<string, DailyPomodoro> {
  const out: Record<string, DailyPomodoro> = {};
  if (!isRecord(value)) return out;
  for (const [day, v] of Object.entries(value)) {
    if (!isRecord(v)) continue;
    const count = typeof v.count === "number" ? v.count : 0;
    const words = typeof v.words === "number" ? v.words : 0;
    out[day] = { count, words };
  }
  return out;
}

/** 从任意对象（旧 data.json 或统计文件）里读出统计字段；不合法的一律当空。 */
export function readStatsMaps(data: unknown): StatsMaps {
  const src = isRecord(data) ? data : {};
  return {
    dailyHistory: numberMap(src.dailyHistory),
    dailyDurationHistory: numberMap(src.dailyDurationHistory),
    projectHistory: nestedMap(src.projectHistory),
    projectDurationHistory: nestedMap(src.projectDurationHistory),
    dailyFileDeltas: nestedMap(src.dailyFileDeltas),
    dailyTypedHistory: numberMap(src.dailyTypedHistory),
    dailyPomodoroHistory: pomodoroMap(src.dailyPomodoroHistory),
  };
}

/** 旧 data.json 里有没有任何历史统计（决定要不要迁移）。 */
export function hasAnyStats(data: unknown): boolean {
  if (!isRecord(data)) return false;
  return STATS_MAP_KEYS.some((key) => {
    const value = data[key];
    return isRecord(value) && Object.keys(value).length > 0;
  });
}

function readStarts(value: unknown): Record<string, DayStart> {
  const out: Record<string, DayStart> = {};
  if (!isRecord(value)) return out;
  for (const [day, v] of Object.entries(value)) {
    if (!isRecord(v) || typeof v.at !== "number") continue;
    out[day] = {
      at: v.at,
      mode: typeof v.mode === "string" ? v.mode : "",
      files: numberMap(v.files),
    };
  }
  return out;
}

function readResults(value: unknown): Record<string, DayResult> {
  const out: Record<string, DayResult> = {};
  if (!isRecord(value)) return out;
  for (const [day, v] of Object.entries(value)) {
    if (!isRecord(v) || typeof v.at !== "number" || typeof v.total !== "number") continue;
    out[day] = {
      at: v.at,
      total: v.total,
      projects: numberMap(v.projects),
      files: numberMap(v.files),
    };
  }
  return out;
}

/**
 * 解析一份统计文件；格式不对返回 null（调用方当它不存在）。
 * 第一版（按事件计、带指纹认领）的文件也能读：没有起点和结果，旧数字当切换前历史。
 */
export function parseLedger(raw: string, fallbackId: string): LedgerFile | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  return {
    version: 2,
    deviceId: typeof data.deviceId === "string" ? data.deviceId : fallbackId,
    deviceName: typeof data.deviceName === "string" ? data.deviceName : "",
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
    ...readStatsMaps(data),
    starts: readStarts(data.starts),
    results: readResults(data.results),
  };
}

/**
 * 某天的净增：现在各章字数 − 起点各章字数。
 * 起点里有、现在没有的章节（删了、移出正文）按 0 算；新出现的章节按全文算。
 */
export function computeDay(
  start: Record<string, number>,
  current: ReadonlyMap<string, number>,
  projectOf: (path: string) => string
): Omit<DayResult, "at"> {
  const files: Record<string, number> = {};
  const projects: Record<string, number> = {};
  let total = 0;
  const add = (path: string, delta: number): void => {
    if (delta === 0) return;
    files[path] = delta;
    total += delta;
    const project = projectOf(path);
    projects[project] = (projects[project] || 0) + delta;
  };
  for (const [path, words] of current) add(path, words - (start[path] || 0));
  for (const [path, words] of Object.entries(start)) {
    if (!current.has(path)) add(path, -words);
  }
  return { total, projects, files };
}

/** 本机统计文件的内容。 */
export function buildLedger(
  meta: { deviceId: string; deviceName: string; now: number },
  maps: StatsMaps,
  starts: Record<string, DayStart>,
  results: Record<string, DayResult>
): LedgerFile {
  return {
    version: 2,
    deviceId: meta.deviceId,
    deviceName: meta.deviceName,
    updatedAt: meta.now,
    ...maps,
    starts,
    results,
  };
}

/** 清理：起点只留最近几天，结果的各章明细只留最近若干天（总数与作品数留着画日历）。 */
export function pruneLedgerDays(
  starts: Record<string, DayStart>,
  results: Record<string, DayResult>,
  today: string
): void {
  const startDays = Object.keys(starts).sort();
  for (const day of startDays.slice(0, Math.max(0, startDays.length - STARTS_KEEP_DAYS))) {
    if (day !== today) delete starts[day];
  }
  const resultDays = Object.keys(results).sort();
  for (const day of resultDays.slice(0, Math.max(0, resultDays.length - RESULT_FILES_DAYS))) {
    if (Object.keys(results[day].files).length > 0) results[day] = { ...results[day], files: {} };
  }
}

/** 本机 + 其他设备的统计：起点取最早、结果取最晚、活动量加总。 */
export class DeviceStatsBook {
  private others = new Map<string, LedgerFile>();

  constructor(readonly deviceId: string) {}

  setOthers(list: LedgerFile[]): void {
    this.others = new Map();
    for (const ledger of list) {
      if (ledger.deviceId === this.deviceId) continue;
      this.others.set(ledger.deviceId, ledger);
    }
  }

  otherLedgers(): LedgerFile[] {
    return [...this.others.values()];
  }

  /** 这一天最早记下的、口径一致的起点（本机的也参与比较）；都没有返回 null。 */
  effectiveStart(day: string, mode: string, own: DayStart | undefined): DayStart | null {
    let best: DayStart | null = own && own.mode === mode ? own : null;
    for (const ledger of this.others.values()) {
      const start = ledger.starts[day];
      if (!start || start.mode !== mode) continue;
      if (!best || start.at < best.at) best = start;
    }
    return best;
  }

  /** 这一天最晚算出的结果（本机的也参与比较）。 */
  latestResult(day: string, ownResults: Record<string, DayResult>): DayResult | null {
    let best: DayResult | null = ownResults[day] ?? null;
    for (const ledger of this.others.values()) {
      const result = ledger.results[day];
      if (result && (!best || result.at > best.at)) best = result;
    }
    return best;
  }

  /** 有新口径结果的日期（任何一台设备算过）。 */
  private resultDays(ownResults: Record<string, DayResult>): Set<string> {
    const days = new Set(Object.keys(ownResults));
    for (const ledger of this.others.values()) {
      for (const day of Object.keys(ledger.results)) days.add(day);
    }
    return days;
  }

  /** 每日净增：有新口径结果的日期用最晚的结果，其余用切换前的历史（按设备加总）。 */
  netDaily(ownResults: Record<string, DayResult>, ownLegacy: DailyHistory): DailyHistory {
    const resultDays = this.resultDays(ownResults);
    const out: DailyHistory = {};
    const addLegacy = (map: DailyHistory): void => {
      for (const [day, value] of Object.entries(map)) {
        if (!resultDays.has(day)) out[day] = (out[day] || 0) + value;
      }
    };
    addLegacy(ownLegacy);
    for (const ledger of this.others.values()) addLegacy(ledger.dailyHistory);
    for (const day of resultDays) {
      const result = this.latestResult(day, ownResults);
      if (result) out[day] = result.total;
    }
    return out;
  }

  /** 按作品的每日净增（作品 → 日 → 字数），规则同 netDaily。 */
  netProjects(
    ownResults: Record<string, DayResult>,
    ownLegacy: Record<string, DailyHistory>
  ): Record<string, DailyHistory> {
    const resultDays = this.resultDays(ownResults);
    const out: Record<string, DailyHistory> = {};
    const put = (project: string, day: string, value: number): void => {
      const target = out[project] ?? (out[project] = {});
      target[day] = (target[day] || 0) + value;
    };
    const addLegacy = (map: Record<string, DailyHistory>): void => {
      for (const [project, days] of Object.entries(map)) {
        for (const [day, value] of Object.entries(days)) {
          if (!resultDays.has(day)) put(project, day, value);
        }
      }
    };
    addLegacy(ownLegacy);
    for (const ledger of this.others.values()) addLegacy(ledger.projectHistory);
    for (const day of resultDays) {
      const result = this.latestResult(day, ownResults);
      if (!result) continue;
      for (const [project, value] of Object.entries(result.projects)) put(project, day, value);
    }
    return out;
  }

  /** 每日各章明细（日 → 文件 → 字数），规则同 netDaily。 */
  netFiles(
    ownResults: Record<string, DayResult>,
    ownLegacy: Record<string, DailyHistory>
  ): Record<string, DailyHistory> {
    const resultDays = this.resultDays(ownResults);
    const out: Record<string, DailyHistory> = {};
    const addLegacy = (map: Record<string, DailyHistory>): void => {
      for (const [day, files] of Object.entries(map)) {
        if (resultDays.has(day)) continue;
        const target = out[day] ?? (out[day] = {});
        for (const [path, value] of Object.entries(files)) target[path] = (target[path] || 0) + value;
      }
    };
    addLegacy(ownLegacy);
    for (const ledger of this.others.values()) addLegacy(ledger.dailyFileDeltas);
    for (const day of resultDays) {
      const result = this.latestResult(day, ownResults);
      if (result) out[day] = { ...result.files };
    }
    return out;
  }

  // ---------- 活动量（各设备各记，显示加总） ----------

  /** 其他设备某一天的某项数字之和。 */
  othersDay(key: "dailyDurationHistory" | "dailyTypedHistory", day: string): number {
    let sum = 0;
    for (const ledger of this.others.values()) sum += ledger[key][day] || 0;
    return sum;
  }

  othersPomodoro(day: string): DailyPomodoro {
    const out = { count: 0, words: 0 };
    for (const ledger of this.others.values()) {
      const entry = ledger.dailyPomodoroHistory[day];
      if (!entry) continue;
      out.count += entry.count;
      out.words += entry.words;
    }
    return out;
  }

  /** 本机 + 其他设备的按日活动量。 */
  mergeDaily(key: "dailyDurationHistory" | "dailyTypedHistory", local: DailyHistory): DailyHistory {
    const out: DailyHistory = { ...local };
    for (const ledger of this.others.values()) {
      for (const [day, value] of Object.entries(ledger[key])) {
        out[day] = (out[day] || 0) + value;
      }
    }
    return out;
  }

  /** 本机 + 其他设备的按作品写作时长（作品 → 日）。 */
  mergeProjectDuration(local: Record<string, DailyHistory>): Record<string, DailyHistory> {
    const out: Record<string, DailyHistory> = {};
    const add = (source: Record<string, DailyHistory>): void => {
      for (const [project, days] of Object.entries(source)) {
        const target = out[project] ?? (out[project] = {});
        for (const [day, value] of Object.entries(days)) target[day] = (target[day] || 0) + value;
      }
    };
    add(local);
    for (const ledger of this.others.values()) add(ledger.projectDurationHistory);
    return out;
  }
}

/** 新设备 ID：时间 + 随机数，够用且不依赖 crypto。 */
export function newDeviceId(now: number, random: () => number = Math.random): string {
  const rand = Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  return `d${now.toString(36)}${rand}`;
}
