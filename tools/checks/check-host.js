/**
 * Host/模块生命周期检查。
 *
 * 这是纯逻辑检查：用一个假的 Obsidian Plugin 验证
 *   - EffectScope 逆序、失败后继续清理
 *   - 模块依赖顺序
 *   - 模块启动失败不阻断无关模块
 *   - 重复装配不会重复启动
 *   - Host 停用时按逆序停用模块
 */
const H = require("./_harness");

function createPluginStub() {
  const counts = { events: 0 };
  return {
    app: {},
    counts,
    addCommand(command) { return command; },
    addRibbonIcon() { return {}; },
    addStatusBarItem() { return {}; },
    addSettingTab() {},
    registerView() {},
    registerEditorExtension() {},
    registerEvent() {
      counts.events++;
    },
    registerDomEvent() {},
    registerInterval(id) { return id; },
  };
}

function createLogger() {
  const errors = [];
  return {
    errors,
    logger: {
      info() {},
      warn() {},
      error(...args) { errors.push(args); },
    },
  };
}

function createServices() {
  let registeredExtension = null;
  let eventsDisposed = 0;
  const eventScopes = [];
  const events = {
    createScope(owner) {
      const scope = {
        owner,
        disposed: 0,
        dispose() {
          this.disposed++;
        },
      };
      eventScopes.push(scope);
      return scope;
    },
    dispose() {
      eventsDisposed++;
      for (const scope of eventScopes) {
        if (scope.disposed === 0) scope.dispose();
      }
    },
    scopes() {
      return eventScopes;
    },
    disposeCount() {
      return eventsDisposed;
    },
  };
  const persistence = {
    load() { return Promise.resolve({}); },
    save() { return Promise.resolve(); },
    flush() { return Promise.resolve(); },
  };
  const editor = {
    registerExtension(extension) { registeredExtension = extension; },
    registeredExtension() { return registeredExtension; },
  };
  const project = {
    projects() { return []; },
    chapterPaths() { return new Set(); },
    isDailyCountFile() { return false; },
    projectRootForPath() { return null; },
    invalidate() {},
  };
  const wordcount = {
    count() { return 0; },
  };
  const diagnosticStates = [];
  const diagnosticErrors = [];
  const diagnostics = {
    setModuleStates(states) {
      diagnosticStates.push(states.map((state) => ({ ...state })));
    },
    recordError(source, error) {
      diagnosticErrors.push({ source, error });
    },
    latestStates() {
      return diagnosticStates[diagnosticStates.length - 1] ?? [];
    },
    errors() {
      return diagnosticErrors;
    },
  };
  const settings = {
    get() { return {}; },
  };
  let registeredView = null;
  const ui = {
    registerView(type, creator) {
      registeredView = { type, creator };
    },
    registeredView() {
      return registeredView;
    },
  };
  return {
    diagnostics,
    editor,
    events,
    persistence,
    project,
    settings,
    ui,
    wordcount,
  };
}

async function main() {
  const H = require("./_harness");
  const { EffectScope } = H.compile("src/host/effectScope.ts", "effect-scope");
  const { PluginHost } = H.compile("src/host/pluginHost.ts", "plugin-host");
  const r = H.createReporter("Host 与模块生命周期");

  const scopeOrder = [];
  const scope = new EffectScope("test");
  scope.add(() => scopeOrder.push("first"));
  scope.add(() => scopeOrder.push("second"));
  scope.dispose();
  r.check("EffectScope 逆序清理", scopeOrder.join(",") === "second,first");

  const continued = [];
  const errorScope = new EffectScope("error", () => {});
  errorScope.add(() => { throw new Error("boom"); });
  errorScope.add(() => continued.push("after-error"));
  errorScope.dispose();
  r.check("单个清理失败不阻断后续清理", continued.join(",") === "after-error");

  const { logger, errors } = createLogger();
  const services = createServices();
  const pluginStub = createPluginStub();
  const host = new PluginHost(pluginStub, services, logger);
  const activationOrder = [];
  const deactivationOrder = [];
  let receivedServices = false;
  let receivedProject = false;
  let receivedSettings = false;
  let receivedWordCount = false;
  let receivedEditor = false;
  let receivedEvents = false;
  let receivedDiagnostics = false;
  let receivedEventScope = false;
  let receivedPersistence = false;
  let receivedUi = false;

  const dependency = {
    id: "dependency",
    async activate(context) {
      receivedServices = context.services === services;
      receivedProject = context.services.project === services.project;
      receivedSettings = context.services.settings === services.settings;
      receivedWordCount = context.services.wordcount === services.wordcount;
      receivedEditor = context.services.editor === services.editor;
      receivedEvents = context.services.events === services.events;
      receivedDiagnostics =
        context.services.diagnostics === services.diagnostics;
      receivedEventScope = context.events.owner === "writing-toolkit:dependency";
      receivedPersistence = context.services.persistence === services.persistence;
      receivedUi = context.services.ui === services.ui;
      activationOrder.push("dependency");
    },
    deactivate() { deactivationOrder.push("dependency"); },
  };
  const feature = {
    id: "feature",
    dependsOn: ["dependency"],
    async activate() { activationOrder.push("feature"); },
    deactivate() { deactivationOrder.push("feature"); },
  };
  const broken = {
    id: "broken",
    activate() { throw new Error("expected failure"); },
  };
  const unrelated = {
    id: "unrelated",
    activate() { activationOrder.push("unrelated"); },
  };
  const blockedByBroken = {
    id: "blocked-by-broken",
    dependsOn: ["broken"],
    activate() { activationOrder.push("blocked-by-broken"); },
  };

  await host.activateModules([
    feature,
    broken,
    dependency,
    unrelated,
    blockedByBroken,
  ]);
  r.check(
    "按依赖顺序启动且失败模块不阻断无关模块",
    activationOrder.join(",") === "dependency,feature,unrelated",
    activationOrder.join(",")
  );

  const states = Object.fromEntries(host.getModuleStates().map((state) => [state.id, state.status]));
  r.check("依赖模块已激活", states.dependency === "active");
  r.check(
    "Host 向模块注入 Services",
    receivedServices &&
      receivedProject &&
      receivedSettings &&
      receivedWordCount &&
      receivedEditor &&
      receivedEvents &&
      receivedDiagnostics &&
      receivedEventScope &&
      receivedPersistence &&
      receivedUi
  );
  r.check("依赖方已激活", states.feature === "active");
  r.check("失败模块被标记", states.broken === "failed");
  r.check("无关模块继续启动", states.unrelated === "active");
  r.check("依赖失败模块的下游被标记", states["blocked-by-broken"] === "failed");
  r.check("失败有 Host 日志", errors.length > 0);
  const projectedStates = Object.fromEntries(
    services.diagnostics
      .latestStates()
      .map((state) => [state.id, state.status])
  );
  r.check(
    "Host 把模块状态投影到 Diagnostics Service",
    projectedStates.dependency === "active" &&
      projectedStates.feature === "active" &&
      projectedStates.broken === "failed" &&
      projectedStates.unrelated === "active" &&
      projectedStates["blocked-by-broken"] === "failed"
  );
  r.check(
    "Host 把模块启动失败写入 Diagnostics Service",
    services.diagnostics.errors().some(
      (entry) =>
        entry.source === "module:broken:activate" &&
        String(entry.error).includes("expected failure")
    )
  );

  const activeOrderBeforeSecondActivation = activationOrder.join(",");
  await host.activateModules([
    feature,
    broken,
    dependency,
    unrelated,
    blockedByBroken,
  ]);
  r.check(
    "重复装配不会重复启动",
    activationOrder.join(",") === activeOrderBeforeSecondActivation,
    activationOrder.join(",")
  );

  const extension = { extension: true };
  host.registerEditorExtension(extension);
  r.check(
    "编辑器扩展注册委托给 Editor Service",
    services.editor.registeredExtension() === extension
  );
  host.registerEvent({ event: true });
  r.check(
    "事件兼容入口只向底层注册一次",
    pluginStub.counts.events === 1,
    String(pluginStub.counts.events)
  );

  const creator = () => ({ getViewType: () => "test-view" });
  host.registerView("test-view", creator);
  r.check(
    "视图注册委托给 UI Service",
    services.ui.registeredView()?.type === "test-view" &&
      services.ui.registeredView()?.creator === creator
  );

  host.dispose();
  r.check(
    "停用按启动逆序",
    deactivationOrder.join(",") === "feature,dependency",
    deactivationOrder.join(",")
  );
  r.check(
    "模块事件作用域随模块生命周期撤销",
    services.events.scopes().every((scope) => scope.disposed === 1),
    services.events.scopes().map((scope) => `${scope.owner}:${scope.disposed}`).join(",")
  );
  r.check(
    "Host 最终销毁事件服务",
    services.events.disposeCount() === 1,
    String(services.events.disposeCount())
  );
  const disposedStates = Object.fromEntries(
    services.diagnostics
      .latestStates()
      .map((state) => [state.id, state.status])
  );
  r.check(
    "Host 停用后把活动模块状态更新为 inactive",
    disposedStates.dependency === "inactive" &&
      disposedStates.feature === "inactive" &&
      disposedStates.unrelated === "inactive"
  );

  const raceServices = createServices();
  const race = createLogger();
  const raceHost = new PluginHost(
    createPluginStub(),
    raceServices,
    race.logger
  );
  let resolveSlowActivation;
  let slowDeactivations = 0;
  let slowCleanupRuns = 0;
  let afterStarted = false;
  const slowModule = {
    id: "slow",
    activate(context) {
      context.effects.add(() => {
        slowCleanupRuns++;
      });
      return new Promise((resolve) => {
        resolveSlowActivation = resolve;
      });
    },
    deactivate() {
      slowDeactivations++;
    },
  };
  const afterModule = {
    id: "after",
    activate() {
      afterStarted = true;
    },
  };

  const raceActivation = raceHost.activateModules([
    slowModule,
    afterModule,
  ]);
  await Promise.resolve();
  raceHost.dispose();
  resolveSlowActivation();
  await raceActivation;
  const raceStates = Object.fromEntries(
    raceServices.diagnostics
      .latestStates()
      .map((state) => [state.id, state.status])
  );
  r.check(
    "异步启动中销毁 Host 会撤销迟到模块且不再启动后续模块",
    slowDeactivations === 1 &&
      slowCleanupRuns === 1 &&
      afterStarted === false &&
      raceStates.slow === "inactive" &&
      raceStates.after === "inactive"
  );

  return r.finish();
}

main()
  .then((ok) => {
    H.cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error("运行失败：" + error.stack);
    H.cleanup();
    process.exit(2);
  });
