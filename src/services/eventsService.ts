import type {
  App,
  Editor,
  EventRef,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type { Disposable } from "../host/effectScope";

export interface EventsLogger {
  error(...args: unknown[]): void;
}

export interface VaultEventMap {
  create: [TAbstractFile];
  modify: [TAbstractFile];
  delete: [TAbstractFile];
  rename: [TAbstractFile, string];
}

export interface WorkspaceEventMap {
  "editor-change": [Editor, MarkdownView | MarkdownFileInfo];
  "editor-menu": [Menu, Editor, MarkdownView | MarkdownFileInfo];
  "active-leaf-change": [WorkspaceLeaf | null];
  "file-open": [TFile | null];
  "layout-change": [];
}

export interface TimerHandle {
  readonly id: number;
  dispose(): void;
}

export interface EventScope {
  readonly owner: string;
  readonly isDisposed: boolean;
  dispose(): void;
  onVault<K extends keyof VaultEventMap>(
    event: K,
    listener: (...args: VaultEventMap[K]) => unknown
  ): Disposable;
  onWorkspace<K extends keyof WorkspaceEventMap>(
    event: K,
    listener: (...args: WorkspaceEventMap[K]) => unknown
  ): Disposable;
  onDom<K extends keyof DocumentEventMap>(
    target: Document,
    event: K,
    listener: (event: DocumentEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): Disposable;
  onDom<K extends keyof WindowEventMap>(
    target: Window,
    event: K,
    listener: (event: WindowEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): Disposable;
  onDom<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    event: K,
    listener: (event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): Disposable;
  onLayoutReady(listener: () => unknown): Disposable;
  setTimeout(listener: () => unknown, delay: number): TimerHandle;
  setInterval(listener: () => unknown, delay: number): TimerHandle;
}

export interface EventsService {
  createScope(owner: string): EventScope;
  dispose(): void;
}

export interface TimerRuntime {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
}

interface ObservableEventSource {
  on(
    name: string,
    callback: (...args: unknown[]) => unknown
  ): EventRef;
  offref(ref: EventRef): void;
}

type TimerKind = "timeout" | "interval";

const browserTimers: TimerRuntime = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (callback, delay) => window.setInterval(callback, delay),
  clearInterval: (id) => window.clearInterval(id),
};

const noop = (): void => {};

export class DefaultEventScope implements EventScope {
  private readonly disposers: Disposable[] = [];
  private readonly timers = new Map<
    number,
    { kind: TimerKind; handle: TimerHandle }
  >();
  private disposed = false;

  constructor(
    private readonly app: App,
    readonly owner: string,
    private readonly logger: EventsLogger,
    private readonly timersRuntime: TimerRuntime,
    private readonly onDispose?: () => void
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  onVault<K extends keyof VaultEventMap>(
    event: K,
    listener: (...args: VaultEventMap[K]) => unknown
  ): Disposable {
    if (this.disposed) return noop;
    const source = this.app.vault as unknown as ObservableEventSource;
    const wrapped = (...args: unknown[]): unknown =>
      this.invoke(`vault:${String(event)}`, listener, args);
    try {
      const ref = source.on(String(event), wrapped);
      return this.addDisposer(() => source.offref(ref));
    } catch (error) {
      this.logger.error(
        `[Writing Toolkit] ${this.owner} 订阅 Vault 事件失败：${String(event)}`,
        error
      );
      return noop;
    }
  }

  onWorkspace<K extends keyof WorkspaceEventMap>(
    event: K,
    listener: (...args: WorkspaceEventMap[K]) => unknown
  ): Disposable {
    if (this.disposed) return noop;
    const source = this.app.workspace as unknown as ObservableEventSource;
    const wrapped = (...args: unknown[]): unknown =>
      this.invoke(`workspace:${String(event)}`, listener, args);
    try {
      const ref = source.on(String(event), wrapped);
      return this.addDisposer(() => source.offref(ref));
    } catch (error) {
      this.logger.error(
        `[Writing Toolkit] ${this.owner} 订阅 Workspace 事件失败：${String(event)}`,
        error
      );
      return noop;
    }
  }

  onDom<K extends keyof DocumentEventMap>(
    target: Document,
    event: K,
    listener: (event: DocumentEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): Disposable;
  onDom<K extends keyof WindowEventMap>(
    target: Window,
    event: K,
    listener: (event: WindowEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): Disposable;
  onDom<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    event: K,
    listener: (event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): Disposable;
  onDom(
    target: Document | Window | HTMLElement,
    event: string,
    listener: (event: Event) => unknown,
    options?: boolean | AddEventListenerOptions
  ): Disposable {
    if (this.disposed) return noop;
    const wrapped = (domEvent: Event): void => {
      this.invoke(`dom:${event}`, listener, [domEvent]);
    };
    try {
      target.addEventListener(event, wrapped, options);
      return this.addDisposer(() =>
        target.removeEventListener(event, wrapped, options)
      );
    } catch (error) {
      this.logger.error(
        `[Writing Toolkit] ${this.owner} 订阅 DOM 事件失败：${event}`,
        error
      );
      return noop;
    }
  }

  onLayoutReady(listener: () => unknown): Disposable {
    if (this.disposed) return noop;
    let active = true;
    try {
      this.app.workspace.onLayoutReady(() => {
        if (!active || this.disposed) return;
        this.invoke("workspace:onLayoutReady", listener, []);
      });
      return this.addDisposer(() => {
        active = false;
      });
    } catch (error) {
      this.logger.error(
        `[Writing Toolkit] ${this.owner} 注册布局就绪回调失败`,
        error
      );
      return noop;
    }
  }

  setTimeout(listener: () => unknown, delay: number): TimerHandle {
    return this.createTimer("timeout", listener, delay);
  }

  setInterval(listener: () => unknown, delay: number): TimerHandle {
    return this.createTimer("interval", listener, delay);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const { kind, handle } of [...this.timers.values()]) {
      this.clearTimer(handle.id, kind);
    }
    for (const disposable of this.disposers.splice(0).reverse()) {
      this.runDisposer(disposable);
    }
    this.onDispose?.();
  }

  private createTimer(
    kind: TimerKind,
    listener: () => unknown,
    delay: number
  ): TimerHandle {
    if (this.disposed) return this.createNoopTimer();

    let id = 0;
    const callback = (): void => {
      if (kind === "timeout") this.timers.delete(id);
      if (this.disposed) return;
      this.invoke(kind, listener, []);
    };
    id =
      kind === "timeout"
        ? this.timersRuntime.setTimeout(callback, delay)
        : this.timersRuntime.setInterval(callback, delay);

    const handle: TimerHandle = {
      id,
      dispose: () => {
        this.clearTimer(id, kind);
      },
    };
    this.timers.set(id, { kind, handle });
    return handle;
  }

  private createNoopTimer(): TimerHandle {
    return {
      id: 0,
      dispose: noop,
    };
  }

  private clearTimer(id: number, kind: TimerKind): void {
    const timer = this.timers.get(id);
    if (!timer || timer.kind !== kind) return;
    this.timers.delete(id);
    if (kind === "timeout") this.timersRuntime.clearTimeout(id);
    else this.timersRuntime.clearInterval(id);
  }

  private addDisposer(dispose: () => void): Disposable {
    let called = false;
    const once = (): void => {
      if (called) return;
      called = true;
      const index = this.disposers.indexOf(once);
      if (index >= 0) this.disposers.splice(index, 1);
      dispose();
    };
    this.disposers.push(once);
    return once;
  }

  private runDisposer(disposable: Disposable): void {
    try {
      disposable();
    } catch (error) {
      this.logger.error(
        `[Writing Toolkit] ${this.owner} 清理资源失败`,
        error
      );
    }
  }

  private invoke(
    label: string,
    listener: (...args: never[]) => unknown,
    args: readonly unknown[]
  ): unknown {
    if (this.disposed) return undefined;
    try {
      const result = listener(...(args as never[]));
      if (
        result &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        void Promise.resolve(result).catch((error) => {
          this.logger.error(
            `[Writing Toolkit] ${this.owner} ${label} 异步回调失败`,
            error
          );
        });
      }
      return result;
    } catch (error) {
      this.logger.error(
        `[Writing Toolkit] ${this.owner} ${label} 回调失败`,
        error
      );
      return undefined;
    }
  }
}

export class DefaultEventsService implements EventsService {
  private readonly scopes: DefaultEventScope[] = [];
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly logger: EventsLogger = console,
    private readonly timers: TimerRuntime = browserTimers
  ) {}

  createScope(owner: string): EventScope {
    const scope = new DefaultEventScope(
      this.app,
      owner,
      this.logger,
      this.timers,
      () => {
        const index = this.scopes.indexOf(scope);
        if (index >= 0) this.scopes.splice(index, 1);
      }
    );
    if (this.disposed) {
      scope.dispose();
      return scope;
    }
    this.scopes.push(scope);
    return scope;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const scope of [...this.scopes].reverse()) {
      scope.dispose();
    }
    this.scopes.length = 0;
  }
}
