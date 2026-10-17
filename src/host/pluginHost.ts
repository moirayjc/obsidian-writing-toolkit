import type {
  App,
  Command,
  EventRef,
  IconName,
  Plugin,
  PluginSettingTab,
  ViewCreator,
} from "obsidian";
import type { Extension } from "@codemirror/state";
import { EffectScope } from "./effectScope";
import type { DiagnosticsService } from "../services/diagnosticsService";
import type { EditorService } from "../services/editorService";
import type { EventScope, EventsService } from "../services/eventsService";
import type { PersistenceService } from "../services/persistenceService";
import type { ProjectService } from "../services/projectIndexService";
import type { SettingsService } from "../services/settingsService";
import type { UiService } from "../services/uiService";
import type { WordCountService } from "../services/wordCountService";

export interface HostLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * The registration surface available to the plugin and to feature modules.
 * It mirrors the Obsidian Plugin APIs used by Writing Toolkit so migration
 * does not change registration timing or ownership semantics.
 */
export interface HostRegistrationApi {
  addCommand(command: Command): Command;
  addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
  addStatusBarItem(): HTMLElement;
  addSettingTab(settingTab: PluginSettingTab): void;
  registerView(type: string, viewCreator: ViewCreator): void;
  registerEditorExtension(extension: Extension): void;
  registerEvent(eventRef: EventRef): void;
  registerDomEvent<K extends keyof WindowEventMap>(
    el: Window,
    type: K,
    callback: (this: HTMLElement, ev: WindowEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  registerDomEvent<K extends keyof DocumentEventMap>(
    el: Document,
    type: K,
    callback: (this: HTMLElement, ev: DocumentEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    callback: (this: HTMLElement, ev: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  registerInterval(id: number): number;
}

export interface FeatureContext {
  readonly app: App;
  readonly services: HostServices;
  readonly registrations: FeatureRegistrationApi;
  readonly events: EventScope;
  readonly effects: EffectScope;
  readonly log: HostLogger;
}

/**
 * Feature Modules must use their scoped EventScope for events, DOM listeners,
 * and timers so that failed activation and deactivation can revoke them.
 */
export type FeatureRegistrationApi = Omit<
  HostRegistrationApi,
  "registerEvent" | "registerDomEvent" | "registerInterval"
>;

export interface HostServices {
  readonly diagnostics: DiagnosticsService;
  readonly editor: EditorService;
  readonly events: EventsService;
  readonly persistence: PersistenceService;
  readonly project: ProjectService;
  readonly settings: SettingsService;
  readonly ui: UiService;
  readonly wordcount: WordCountService;
}

export interface FeatureModule {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  activate(context: FeatureContext): void | Promise<void>;
  deactivate?(): void;
}

export type FeatureModuleStatus = "inactive" | "active" | "failed";

export interface FeatureModuleState {
  readonly id: string;
  readonly status: FeatureModuleStatus;
  readonly error?: unknown;
}

interface ModuleRecord {
  readonly module: FeatureModule;
  status: FeatureModuleStatus;
  scope?: EffectScope;
  error?: unknown;
}

/**
 * Internal host for the single Obsidian plugin.
 *
 * It owns the registration facade and the lifecycle of feature modules. It is
 * deliberately not a second Obsidian plugin loader: modules are static code
 * bundled into this plugin.
 */
export class PluginHost implements HostRegistrationApi {
  private readonly app: App;
  private readonly modules = new Map<string, ModuleRecord>();
  private readonly activeOrder: string[] = [];
  private disposed = false;

  constructor(
    private readonly plugin: Plugin,
    readonly services: HostServices,
    private readonly log: HostLogger = console
  ) {
    this.app = plugin.app;
  }

  async activateModules(modules: readonly FeatureModule[]): Promise<void> {
    if (this.disposed) {
      this.log.warn("[Writing Toolkit] Host 已销毁，忽略模块启动");
      return;
    }

    for (const module of modules) {
      if (this.modules.has(module.id)) {
        this.log.error(`[Writing Toolkit] 模块 id 重复：${module.id}`);
        continue;
      }
      this.modules.set(module.id, { module, status: "inactive" });
    }
    this.syncModuleDiagnostics();

    const pending = new Set(
      [...this.modules.values()]
        .filter((record) => record.status === "inactive")
        .map((record) => record.module.id)
    );

    while (pending.size > 0) {
      let activatedOne = false;

      for (const id of pending) {
        const record = this.modules.get(id);
        if (!record) continue;

        const dependencies = record.module.dependsOn ?? [];
        const ready = dependencies.every(
          (dependencyId) => this.modules.get(dependencyId)?.status === "active"
        );
        if (!ready) continue;

        pending.delete(id);
        await this.activateModule(record);
        if (this.disposed) return;
        activatedOne = true;
        // 每次启动后都从头扫描，确保依赖方先于无关模块启动。
        break;
      }

      if (activatedOne) continue;

      for (const id of pending) {
        const record = this.modules.get(id);
        if (!record) continue;
        const dependencies = record.module.dependsOn ?? [];
        const missing = dependencies.filter((dependencyId) => {
          const dependency = this.modules.get(dependencyId);
          return !dependency || dependency.status !== "active";
        });
        this.markFailed(
          record,
          new Error(`依赖未满足或存在依赖环：${missing.join(", ")}`)
        );
      }
      pending.clear();
    }
  }

  getModuleStates(): readonly FeatureModuleState[] {
    return [...this.modules.values()].map(({ module, status, error }) => ({
      id: module.id,
      status,
      error,
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const id of [...this.activeOrder].reverse()) {
      const record = this.modules.get(id);
      if (!record || record.status !== "active") continue;

      try {
        record.module.deactivate?.();
      } catch (error) {
        this.recordDiagnosticError(`module:${id}:deactivate`, error);
        this.log.error(`[Writing Toolkit] 模块 ${id} 停用失败`, error);
      }

      record.scope?.dispose();
      record.status = "inactive";
      record.error = undefined;
      this.syncModuleDiagnostics();
    }

    this.activeOrder.length = 0;
    try {
      this.services.events.dispose();
    } catch (error) {
      this.log.error("[Writing Toolkit] 事件服务销毁失败", error);
    }
  }

  addCommand(command: Command): Command {
    return this.plugin.addCommand(command);
  }

  addRibbonIcon(
    icon: IconName,
    title: string,
    callback: (evt: MouseEvent) => unknown
  ): HTMLElement {
    return this.plugin.addRibbonIcon(icon, title, callback);
  }

  addStatusBarItem(): HTMLElement {
    return this.plugin.addStatusBarItem();
  }

  addSettingTab(settingTab: PluginSettingTab): void {
    this.plugin.addSettingTab(settingTab);
  }

  registerView(type: string, viewCreator: ViewCreator): void {
    this.services.ui.registerView(type, viewCreator);
  }

  registerEditorExtension(extension: Extension): void {
    this.services.editor.registerExtension(extension);
  }

  registerEvent(eventRef: EventRef): void {
    this.plugin.registerEvent(eventRef);
  }

  registerDomEvent<K extends keyof WindowEventMap>(
    el: Window,
    type: K,
    callback: (this: HTMLElement, ev: WindowEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  registerDomEvent<K extends keyof DocumentEventMap>(
    el: Document,
    type: K,
    callback: (this: HTMLElement, ev: DocumentEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    callback: (this: HTMLElement, ev: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  registerDomEvent(
    el: Window | Document | HTMLElement,
    type: string,
    callback: (evt: Event) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void {
    this.plugin.registerDomEvent(
      el as HTMLElement,
      type as keyof HTMLElementEventMap,
      callback,
      options
    );
  }

  registerInterval(id: number): number {
    return this.plugin.registerInterval(id);
  }

  private async activateModule(record: ModuleRecord): Promise<void> {
    const { module } = record;
    const scope = new EffectScope(
      `Writing Toolkit:${module.id}`,
      (_name, error) => {
        this.recordDiagnosticError(`module:${module.id}:cleanup`, error);
        this.log.error(`[Writing Toolkit] 模块 ${module.id} 清理失败`, error);
      }
    );
    record.scope = scope;

    try {
      const eventScope = this.services.events.createScope(
        `writing-toolkit:${module.id}`
      );
      scope.add(() => eventScope.dispose());
      await module.activate({
        app: this.app,
        services: this.services,
        registrations: this,
        events: eventScope,
        effects: scope,
        log: this.log,
      });
      if (this.disposed) {
        await this.deactivateDuringDispose(record);
        return;
      }
      record.status = "active";
      this.activeOrder.push(module.id);
      this.syncModuleDiagnostics();
    } catch (error) {
      this.markFailed(record, error);
      scope.dispose();
    }
  }

  private markFailed(record: ModuleRecord, error: unknown): void {
    record.status = "failed";
    record.error = error;
    this.recordDiagnosticError(
      `module:${record.module.id}:activate`,
      error
    );
    this.syncModuleDiagnostics();
    this.log.error(`[Writing Toolkit] 模块 ${record.module.id} 启动失败`, error);
  }

  private async deactivateDuringDispose(record: ModuleRecord): Promise<void> {
    try {
      await record.module.deactivate?.();
    } catch (error) {
      this.recordDiagnosticError(
        `module:${record.module.id}:deactivate`,
        error
      );
      this.log.error(
        `[Writing Toolkit] 模块 ${record.module.id} 停用失败`,
        error
      );
    }
    record.scope?.dispose();
    record.status = "inactive";
    record.error = undefined;
    this.syncModuleDiagnostics();
  }

  private syncModuleDiagnostics(): void {
    try {
      this.services.diagnostics.setModuleStates(this.getModuleStates());
    } catch (error) {
      this.log.error("[Writing Toolkit] 模块状态写入诊断失败", error);
    }
  }

  private recordDiagnosticError(source: string, error: unknown): void {
    try {
      this.services.diagnostics.recordError(source, error);
    } catch (diagnosticError) {
      this.log.error("[Writing Toolkit] 诊断错误记录失败", diagnosticError);
    }
  }
}
