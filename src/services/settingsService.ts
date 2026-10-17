import {
  DEFAULT_SETTINGS,
  type WritingToolkitSettings,
} from "../settingsSchema";

export type SettingsKey = keyof WritingToolkitSettings;
export type SettingsChange = {
  readonly keys: readonly SettingsKey[];
  readonly previous: Readonly<WritingToolkitSettings>;
  readonly current: Readonly<WritingToolkitSettings>;
};
export type SettingsListener = (change: SettingsChange) => void;

export interface SettingsService {
  /**
   * 迁移期返回 Host 持有的实时对象。旧页面仍可直接修改它；
   * 修改后必须经过 publishChanges() 才会通知订阅者。
   */
  get(): WritingToolkitSettings;
  load(data: unknown): WritingToolkitSettings;
  set<K extends SettingsKey>(
    key: K,
    value: WritingToolkitSettings[K]
  ): SettingsChange | null;
  update(patch: Partial<WritingToolkitSettings>): SettingsChange | null;
  publishChanges(): SettingsChange | null;
  subscribe(listener: SettingsListener): () => void;
}

interface SettingsServiceLogger {
  error(...args: unknown[]): void;
}

/** 旧扁平格式里，最初就从 data 顶层直接读取的字段。 */
const OLD_TOP_LEVEL_KEYS = [
  "lineHeight",
  "paragraphSpacing",
  "letterPaperMode",
  "paragraphIndent",
  "headingStyle",
  "snapshotEnabled",
  "snapshotFolder",
  "snapshotIntervalMinutes",
  "snapshotIdleMinutes",
  "snapshotMaxPerFile",
  "snapshotOnlyDrafts",
  "immersiveMode",
  "immersiveParagraphHighlight",
  "hemingwayMode",
  "dailyDisplayMode",
  "typewriterMode",
  "typewriterOffset",
  "punctuationAssist",
  "hardBreakOnEnter",
  "dailyGoal",
  "wordCountMode",
  "showSpeed",
] as const satisfies readonly SettingsKey[];

/** 旧扁平格式里曾因漏读而丢失过的字段。 */
const LEGACY_FLAT_KEYS = [
  "themeTone",
  "pomodoroFocusMinutes",
  "pomodoroBreakMinutes",
  "pomodoroLongBreakEvery",
  "pomodoroLongBreakMinutes",
  "pomodoroAutoSnapshot",
  "statusBarOnlyImmersive",
  "mobileStatusBar",
  "draftKeywords",
  "chapterExcludeNames",
  "formatToolbarEnabled",
  "formatToolbarScope",
  "commentsEnabled",
  "commentBubbleEverywhere",
  "outlineStorageMode",
  "newProjectFolder",
  "sharedLibraryFolder",
] as const satisfies readonly SettingsKey[];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function pick(value: unknown, fallback: unknown): unknown {
  return value === undefined || value === null ? fallback : value;
}

function cloneSettings(
  settings: WritingToolkitSettings
): WritingToolkitSettings {
  return { ...settings };
}

export function mergeSettingsFromData(data: unknown): WritingToolkitSettings {
  const record = asRecord(data);
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (!record) return merged as unknown as WritingToolkitSettings;

  // 旧扁平格式：先保持当年各分支的读取范围，再补回后来修复的 17 个字段。
  if (record.lineHeight !== undefined || record.paragraphSpacing !== undefined) {
    for (const key of OLD_TOP_LEVEL_KEYS) {
      merged[key] = pick(record[key], DEFAULT_SETTINGS[key]);
    }
    const legacyFlat = {
      ...(asRecord(record.settings) ?? {}),
      ...record,
    };
    for (const key of LEGACY_FLAT_KEYS) {
      merged[key] = pick(legacyFlat[key], DEFAULT_SETTINGS[key]);
    }
    return merged as unknown as WritingToolkitSettings;
  }

  // 新格式：只认 settings 命名空间里的已知键，顺带清掉废弃字段。
  const loaded = asRecord(record.settings) ?? {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    if (loaded[key] !== undefined) merged[key] = loaded[key];
  }
  return merged as unknown as WritingToolkitSettings;
}

/**
 * Host-managed settings state.
 *
 * This service owns default merging and change notification. Disk persistence
 * stays behind the plugin compatibility save entry until the persistence
 * service takes over that responsibility.
 */
export class DefaultSettingsService implements SettingsService {
  private readonly current = cloneSettings(DEFAULT_SETTINGS);
  private readonly listeners = new Set<SettingsListener>();
  private published = cloneSettings(DEFAULT_SETTINGS);

  constructor(private readonly log: SettingsServiceLogger = console) {}

  get(): WritingToolkitSettings {
    return this.current;
  }

  load(data: unknown): WritingToolkitSettings {
    const merged = mergeSettingsFromData(data);
    replaceInPlace(this.current, merged);
    this.published = cloneSettings(this.current);
    return this.current;
  }

  set<K extends SettingsKey>(
    key: K,
    value: WritingToolkitSettings[K]
  ): SettingsChange | null {
    this.current[key] = value;
    return this.publishChanges();
  }

  update(patch: Partial<WritingToolkitSettings>): SettingsChange | null {
    Object.assign(this.current, patch);
    return this.publishChanges();
  }

  /**
   * 兼容旧页面直接修改 settings 对象的迁移路径。
   * 保存入口在写盘后调用这里，统一把变化广播给订阅者。
   */
  publishChanges(): SettingsChange | null {
    const keys = (Object.keys(DEFAULT_SETTINGS) as SettingsKey[]).filter(
      (key) => !Object.is(this.current[key], this.published[key])
    );
    if (keys.length === 0) return null;

    const previous = cloneSettings(this.published);
    const current = cloneSettings(this.current);
    this.published = current;

    const change: SettingsChange = { keys, previous, current };
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.log.error("[Writing Toolkit] 设置变更监听器失败", error);
      }
    }
    return change;
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function replaceInPlace(
  target: WritingToolkitSettings,
  source: WritingToolkitSettings
): void {
  const mutable = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, source);
}
