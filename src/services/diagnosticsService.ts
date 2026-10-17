/**
 * Lightweight diagnostic state shared by the Host and feature modules.
 *
 * This service deliberately has no Obsidian dependency. It records facts and
 * returns isolated snapshots; formatting reports and deciding what counts as a
 * failure remain the responsibility of the Host or feature module.
 */

export type DiagnosticModuleStatus = "inactive" | "active" | "failed";

/**
 * Latest values are intended to be small JSON-like facts, such as a path,
 * selector, mode, or pause reason. They are cloned before being stored and
 * again when a snapshot is returned.
 */
export type DiagnosticValue =
  | string
  | number
  | boolean
  | null
  | readonly DiagnosticValue[]
  | { readonly [key: string]: DiagnosticValue };

/**
 * Structural subset of the Host's FeatureModuleState.
 *
 * Keeping this local avoids a service -> Host dependency while still allowing
 * the Host to project getModuleStates() directly into diagnostics.
 */
export interface DiagnosticModuleState {
  readonly id: string;
  readonly status: DiagnosticModuleStatus;
  readonly error?: unknown;
}

export interface DiagnosticCounterSnapshot {
  readonly value: number;
  readonly updatedAt: number;
}

export interface DiagnosticTimingSnapshot {
  readonly count: number;
  readonly lastMs: number;
  readonly maxMs: number;
  readonly totalMs: number;
  readonly updatedAt: number;
}

export interface DiagnosticLatestSnapshot {
  readonly value: DiagnosticValue;
  readonly updatedAt: number;
}

export interface DiagnosticErrorSnapshot {
  readonly source: string;
  readonly message: string;
  readonly stack: string | null;
  readonly at: number;
}

export interface DiagnosticModuleSnapshot {
  readonly id: string;
  readonly status: DiagnosticModuleStatus;
  readonly error: string | null;
}

export interface DiagnosticsSnapshot {
  readonly generatedAt: number;
  readonly counters: Readonly<
    Record<string, DiagnosticCounterSnapshot>
  >;
  readonly timings: Readonly<
    Record<string, DiagnosticTimingSnapshot>
  >;
  readonly latest: Readonly<
    Record<string, DiagnosticLatestSnapshot>
  >;
  readonly errors: readonly DiagnosticErrorSnapshot[];
  readonly modules: readonly DiagnosticModuleSnapshot[];
}

export interface DiagnosticsService {
  /**
   * Add a non-negative amount to a named event counter and return its total.
   * Invalid amounts are ignored so instrumentation cannot break the caller.
   */
  increment(name: string, by?: number): number;

  /**
   * Record one measured duration. The snapshot exposes count, last, max, and
   * total so both recent health and long-running costs remain visible.
   */
  recordTiming(name: string, durationMs: number): void;

  /** Replace the latest diagnostic fact for a name. */
  setLatest(name: string, value: DiagnosticValue): void;

  /** Keep a bounded, chronological history of errors. */
  recordError(source: string, error: unknown): void;

  /**
   * Replace the module-state projection with the Host's current state list.
   * Passing an empty list clears stale module entries.
   */
  setModuleStates(states: readonly DiagnosticModuleState[]): void;

  /** Return a detached snapshot that callers may read or modify safely. */
  snapshot(): DiagnosticsSnapshot;

  /** Clear all collected state, for example when starting a new report. */
  clear(): void;
}

export interface DiagnosticsServiceOptions {
  readonly now?: () => number;
  /** Defaults to 50 and is always kept at 1 or above. */
  readonly maxErrors?: number;
}

interface CounterRecord {
  value: number;
  updatedAt: number;
}

interface TimingRecord {
  count: number;
  lastMs: number;
  maxMs: number;
  totalMs: number;
  updatedAt: number;
}

interface LatestRecord {
  value: DiagnosticValue;
  updatedAt: number;
}

const DEFAULT_MAX_ERRORS = 50;

export class DefaultDiagnosticsService implements DiagnosticsService {
  private readonly counters = new Map<string, CounterRecord>();
  private readonly timings = new Map<string, TimingRecord>();
  private readonly latest = new Map<string, LatestRecord>();
  private readonly errors: DiagnosticErrorSnapshot[] = [];
  private modules: DiagnosticModuleSnapshot[] = [];
  private readonly now: () => number;
  private readonly maxErrors: number;

  constructor(options: DiagnosticsServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    const configured = options.maxErrors;
    this.maxErrors =
      configured !== undefined && Number.isFinite(configured)
        ? Math.max(1, Math.floor(configured))
        : DEFAULT_MAX_ERRORS;
  }

  increment(name: string, by = 1): number {
    const key = diagnosticKey(name);
    const current = this.counters.get(key);
    if (!Number.isFinite(by) || by <= 0) {
      return current?.value ?? 0;
    }
    const value = (current?.value ?? 0) + by;
    this.counters.set(key, {
      value,
      updatedAt: this.now(),
    });
    return value;
  }

  recordTiming(name: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const key = diagnosticKey(name);
    const current = this.timings.get(key);
    this.timings.set(key, {
      count: (current?.count ?? 0) + 1,
      lastMs: durationMs,
      maxMs: Math.max(current?.maxMs ?? 0, durationMs),
      totalMs: (current?.totalMs ?? 0) + durationMs,
      updatedAt: this.now(),
    });
  }

  setLatest(name: string, value: DiagnosticValue): void {
    this.latest.set(diagnosticKey(name), {
      value: cloneDiagnosticValue(value),
      updatedAt: this.now(),
    });
  }

  recordError(source: string, error: unknown): void {
    const details = describeError(error);
    this.errors.push({
      source: diagnosticKey(source),
      message: details.message,
      stack: details.stack,
      at: this.now(),
    });
    if (this.errors.length > this.maxErrors) {
      this.errors.splice(0, this.errors.length - this.maxErrors);
    }
  }

  setModuleStates(states: readonly DiagnosticModuleState[]): void {
    this.modules = states.map((state) => ({
      id: diagnosticKey(state.id),
      status: state.status,
      error:
        state.error === undefined
          ? null
          : describeError(state.error).message,
    }));
  }

  snapshot(): DiagnosticsSnapshot {
    const counters: Record<string, DiagnosticCounterSnapshot> = {};
    for (const [key, value] of this.counters) {
      counters[key] = { ...value };
    }

    const timings: Record<string, DiagnosticTimingSnapshot> = {};
    for (const [key, value] of this.timings) {
      timings[key] = { ...value };
    }

    const latest: Record<string, DiagnosticLatestSnapshot> = {};
    for (const [key, value] of this.latest) {
      latest[key] = {
        value: cloneDiagnosticValue(value.value),
        updatedAt: value.updatedAt,
      };
    }

    return {
      generatedAt: this.now(),
      counters,
      timings,
      latest,
      errors: this.errors.map((error) => ({ ...error })),
      modules: this.modules.map((module) => ({ ...module })),
    };
  }

  clear(): void {
    this.counters.clear();
    this.timings.clear();
    this.latest.clear();
    this.errors.length = 0;
    this.modules = [];
  }
}

function diagnosticKey(value: string): string {
  const key = String(value).trim();
  return key || "(unnamed)";
}

function describeError(error: unknown): {
  message: string;
  stack: string | null;
} {
  if (error instanceof Error) {
    return {
      message: safeText(error.message) || safeText(error.name) || "Error",
      stack: typeof error.stack === "string" ? error.stack : null,
    };
  }
  return {
    message: safeText(error) || "(unknown error)",
    stack: null,
  };
}

function safeText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "(unprintable value)";
  }
}

function cloneDiagnosticValue(
  value: DiagnosticValue,
  seen: WeakSet<object> = new WeakSet()
): DiagnosticValue {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const copy = (value as readonly DiagnosticValue[]).map((item) =>
      cloneDiagnosticValue(item, seen)
    );
    seen.delete(value);
    return copy;
  }

  const copy: Record<string, DiagnosticValue> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = cloneDiagnosticValue(item, seen);
  }
  seen.delete(value);
  return copy;
}
