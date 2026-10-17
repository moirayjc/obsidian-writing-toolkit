export interface PersistenceAdapter {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export type PersistenceData = Record<string, unknown>;

export interface PersistenceService {
  load(): Promise<unknown>;
  save(data: PersistenceData): Promise<void>;
  flush(): Promise<void>;
}

interface PersistenceServiceLogger {
  error(...args: unknown[]): void;
}

/**
 * Host-managed I/O for the single data.json file.
 *
 * The service snapshots each payload before queuing it, so later in-memory
 * mutations cannot change a write that is already pending. Writes are strictly
 * serialized; a failed write rejects its caller but does not poison the queue.
 */
export class DefaultPersistenceService implements PersistenceService {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: PersistenceAdapter,
    private readonly log: PersistenceServiceLogger = console
  ) {}

  async load(): Promise<unknown> {
    await this.tail;
    return this.adapter.loadData();
  }

  save(data: PersistenceData): Promise<void> {
    const snapshot = snapshotPersistenceData(data);
    const write = this.tail.then(() => this.adapter.saveData(snapshot));
    this.tail = write.catch((error) => {
      this.log.error("[Writing Toolkit] 数据保存失败", error);
    });
    return write;
  }

  /** Wait until every queued write has settled. */
  flush(): Promise<void> {
    return this.tail;
  }
}

/**
 * Match the JSON payload that ultimately reaches disk and detach it from the
 * mutable plugin state at call time. data.json must remain JSON-serializable.
 */
export function snapshotPersistenceData(
  data: PersistenceData
): PersistenceData {
  const json = JSON.stringify(data);
  if (json === undefined) {
    throw new Error("data.json 顶层必须是可序列化对象");
  }
  return JSON.parse(json) as PersistenceData;
}
