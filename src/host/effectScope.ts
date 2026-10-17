/**
 * A small, synchronous effect scope.
 *
 * Feature modules register every reversible effect here. Disposal is
 * intentionally reverse-ordered so a module can depend on earlier resources
 * while it is shutting down.
 */
export type Disposable = () => void;

export type EffectScopeErrorHandler = (scopeName: string, error: unknown) => void;

export class EffectScope {
  private readonly disposers: Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly name: string,
    private readonly onError: EffectScopeErrorHandler = (scopeName, error) => {
      console.error(`[${scopeName}] 清理资源失败`, error);
    }
  ) {}

  get size(): number {
    return this.disposers.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  add(disposable: Disposable): void {
    if (this.disposed) {
      this.runDisposer(disposable);
      return;
    }
    this.disposers.push(disposable);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposers.splice(0).reverse()) {
      this.runDisposer(disposable);
    }
  }

  private runDisposer(disposable: Disposable): void {
    try {
      disposable();
    } catch (error) {
      this.onError(this.name, error);
    }
  }
}
