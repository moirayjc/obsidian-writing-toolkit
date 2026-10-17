/**
 * Events Service 检查。
 *
 * 用真实 DefaultEventsService 验证 Vault/Workspace/DOM/layout-ready 事件、
 * 定时器、幂等清理和异常隔离，并守住 main.ts 与 MobileStatusBar 的调用边界。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function createEventSource(source) {
  const refs = [];
  return {
    refs,
    on(name, callback) {
      const ref = {
        source,
        name,
        callback,
        removed: 0,
      };
      refs.push(ref);
      return ref;
    },
    offref(ref) {
      ref.removed++;
    },
    emit(name, ...args) {
      for (const ref of refs) {
        if (ref.name === name) ref.callback(...args);
      }
    },
  };
}

function createDomTarget() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, callback, options) {
      listeners.push({ type, callback, options, removed: false });
    },
    removeEventListener(type, callback, options) {
      const listener = listeners.find(
        (entry) =>
          entry.type === type &&
          entry.callback === callback &&
          entry.options === options
      );
      if (listener) listener.removed = true;
    },
    emit(type, event) {
      for (const listener of listeners) {
        if (listener.type === type) listener.callback(event);
      }
    },
  };
}

function createTimerRuntime() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    timeouts,
    intervals,
    setTimeout(callback, delay) {
      const id = nextId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    fireTimeout(id) {
      const timer = timeouts.get(id);
      if (!timer) return;
      timeouts.delete(id);
      timer.callback();
    },
    fireInterval(id) {
      intervals.get(id)?.callback();
    },
  };
}

function createApp() {
  const vault = createEventSource("vault");
  const readyCallbacks = [];
  const workspace = createEventSource("workspace");
  workspace.onLayoutReady = (callback) => {
    readyCallbacks.push(callback);
  };
  workspace.fireReady = () => {
    for (const callback of readyCallbacks) callback();
  };
  return {
    app: { vault, workspace },
    vault,
    workspace,
  };
}

async function main() {
  const { DefaultEventsService } = H.compile(
    "src/services/eventsService.ts",
    "events-service"
  );
  const r = H.createReporter("Events Service");
  const timers = createTimerRuntime();
  const { app, vault, workspace } = createApp();
  const errors = [];
  const service = new DefaultEventsService(
    app,
    {
      error(...args) {
        errors.push(args);
      },
    },
    timers
  );

  const scope = service.createScope("test-scope");
  let vaultPayload = null;
  scope.onVault("modify", (file) => {
    vaultPayload = file.path;
  });
  vault.emit("modify", { path: "正文/第1章.md" });
  r.check("Vault 事件保留原始参数", vaultPayload === "正文/第1章.md");

  let workspacePayload = null;
  scope.onWorkspace("active-leaf-change", (leaf) => {
    workspacePayload = leaf?.id ?? null;
  });
  workspace.emit("active-leaf-change", { id: "leaf-1" });
  r.check("Workspace 事件保留原始参数", workspacePayload === "leaf-1");

  let domPayload = null;
  const domTarget = createDomTarget();
  scope.onDom(domTarget, "selectionchange", (event) => {
    domPayload = event.kind;
  }, { capture: true });
  const domListener = domTarget.listeners[0];
  r.check(
    "DOM 事件保留原始参数与选项",
    domListener?.type === "selectionchange" &&
      domListener?.options?.capture === true
  );
  domTarget.emit("selectionchange", { kind: "selection" });
  r.check("DOM 事件回调可执行", domPayload === "selection");

  const [vaultRef] = vault.refs;
  scope.dispose();
  scope.dispose();
  r.check("作用域撤销 Vault 订阅", vaultRef.removed === 1, String(vaultRef.removed));
  r.check(
    "作用域撤销 Workspace 订阅",
    workspace.refs[0].removed === 1,
    String(workspace.refs[0].removed)
  );
  r.check("作用域撤销 DOM 订阅", domListener.removed === true);

  const before = vault.refs.length;
  scope.onVault("create", () => {});
  r.check("已销毁作用域不再挂新事件", vault.refs.length === before);

  const readyScope = service.createScope("ready-scope");
  let readyCount = 0;
  readyScope.onLayoutReady(() => {
    readyCount++;
  });
  r.check("布局就绪前不执行回调", readyCount === 0);
  workspace.fireReady();
  r.check("布局就绪后执行一次回调", readyCount === 1);

  const cancelledReadyScope = service.createScope("cancelled-ready");
  let cancelledReadyCount = 0;
  cancelledReadyScope.onLayoutReady(() => {
    cancelledReadyCount++;
  });
  cancelledReadyScope.dispose();
  workspace.fireReady();
  r.check("销毁后抑制布局就绪回调", cancelledReadyCount === 0);

  const timerScope = service.createScope("timer-scope");
  let timeoutCount = 0;
  const timeout = timerScope.setTimeout(() => {
    timeoutCount++;
  }, 100);
  timers.fireTimeout(timeout.id);
  timers.fireTimeout(timeout.id);
  r.check("timeout 只执行一次", timeoutCount === 1);
  r.check("timeout 执行后自动移除", !timers.timeouts.has(timeout.id));

  let intervalCount = 0;
  const interval = timerScope.setInterval(() => {
    intervalCount++;
  }, 100);
  timers.fireInterval(interval.id);
  interval.dispose();
  timers.fireInterval(interval.id);
  r.check("interval 暂停后不再执行", intervalCount === 1);

  const pendingTimeout = timerScope.setTimeout(() => {
    timeoutCount++;
  }, 100);
  const pendingInterval = timerScope.setInterval(() => {
    intervalCount++;
  }, 100);
  timerScope.dispose();
  r.check(
    "作用域销毁清理全部定时器",
    !timers.timeouts.has(pendingTimeout.id) &&
      !timers.intervals.has(pendingInterval.id)
  );

  const errorScope = service.createScope("error-scope");
  let laterListenerRan = false;
  errorScope.onVault("create", () => {
    throw new Error("expected");
  });
  errorScope.onVault("create", () => {
    laterListenerRan = true;
  });
  vault.emit("create", { path: "新章.md" });
  r.check("事件异常被隔离并继续通知后一个监听器", laterListenerRan);
  r.check("事件异常写入日志", errors.length > 0);
  errorScope.dispose();

  const sharedScope = service.createScope("shared-timer");
  sharedScope.setTimeout(() => {}, 1000);
  sharedScope.setInterval(() => {}, 1000);
  service.dispose();
  r.check("服务销毁后清理所有作用域定时器", timers.timeouts.size === 0 && timers.intervals.size === 0);
  const afterDisposeRefs = vault.refs.length;
  const deadScope = service.createScope("after-dispose");
  deadScope.onVault("delete", () => {});
  r.check("服务销毁后创建的作用域保持 inert", vault.refs.length === afterDisposeRefs);

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const hostSource = fs.readFileSync(
    path.join(H.ROOT, "src/host/pluginHost.ts"),
    "utf8"
  );
  const featureSources = fs
    .readdirSync(path.join(H.ROOT, "src/features"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) =>
      fs.readFileSync(path.join(H.ROOT, "src/features", name), "utf8")
    );
  const mobileSource = fs.readFileSync(
    path.join(H.ROOT, "src/mobileStatusBar.ts"),
    "utf8"
  );

  r.check("HostServices 暴露 events", /readonly events: EventsService;/.test(hostSource));
  r.check(
    "FeatureContext 暴露模块事件作用域",
    /readonly events: EventScope;/.test(hostSource) &&
      /registrations:\s*FeatureRegistrationApi;/.test(hostSource)
  );
  r.check(
    "Feature Module 不能绕过 EventScope 注册事件或定时器",
    /FeatureRegistrationApi\s*=\s*Omit<[\s\S]*?"registerEvent"[\s\S]*?"registerDomEvent"[\s\S]*?"registerInterval"/.test(
      hostSource
    ) &&
      !featureSources.some((source) =>
        /registrations\.register(?:Event|DomEvent|Interval)\(/.test(source)
      )
  );
  r.check(
    "main.ts 创建 Events Service 与主作用域",
    /events: new DefaultEventsService\(this\.app, eventsLogger\)/.test(
      mainSource
    ) &&
      /this\.host\.services\.events\.createScope\(/.test(mainSource) &&
      /diagnostics\.recordError\(\s*"events"/.test(mainSource)
  );
  r.check(
    "main.ts 不直接订阅 Vault 或 Workspace",
    !/app\.(?:vault|workspace)\.on\(/.test(mainSource)
  );
  r.check(
    "main.ts 不直接注册布局就绪回调",
    !/workspace\.onLayoutReady\(/.test(mainSource)
  );
  r.check(
    "main.ts 不绕过事件作用域注册 DOM 事件",
    !/host\.registerEvent\(|host\.registerDomEvent\(/.test(mainSource)
  );
  r.check(
    "main.ts 不直接管理插件级定时器",
    !/window\.(?:setTimeout|setInterval|clearTimeout|clearInterval)\(/.test(
      mainSource
    )
  );
  r.check(
    "MobileStatusBar 使用事件作用域",
    /events\.onWorkspace\(/.test(mobileSource) &&
      /events\.setInterval\(/.test(mobileSource) &&
      !/plugin\.registerEvent\(/.test(mobileSource) &&
      !/window\.setInterval\(/.test(mobileSource)
  );
  r.check(
    "Host 为模块创建并撤销事件作用域",
    /createScope\([\s\S]*?scope\.add\(\(\) => eventScope\.dispose\(\)\)/.test(
      hostSource
    )
  );
  r.check(
    "Host 销毁时关闭事件服务",
    /this\.services\.events\.dispose\(\)/.test(hostSource)
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
