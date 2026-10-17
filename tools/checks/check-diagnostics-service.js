/**
 * Diagnostics Service check.
 *
 * Compiles the real Obsidian-independent service and verifies counters,
 * timing aggregates, latest values, bounded errors, module-state projection,
 * snapshot isolation, and reset behavior.
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function main() {
  const { DefaultDiagnosticsService } = H.compile(
    "src/services/diagnosticsService.ts",
    "diagnostics-service"
  );
  const r = H.createReporter("Diagnostics Service");

  let now = 1000;
  const diagnostics = new DefaultDiagnosticsService({
    now: () => now,
    maxErrors: 2,
  });

  let initial = diagnostics.snapshot();
  r.check(
    "初始快照为空",
    initial.generatedAt === 1000 &&
      Object.keys(initial.counters).length === 0 &&
      Object.keys(initial.timings).length === 0 &&
      Object.keys(initial.latest).length === 0 &&
      initial.errors.length === 0 &&
      initial.modules.length === 0
  );

  now = 2000;
  r.check("计数器首次加一", diagnostics.increment("editor-change") === 1);
  now = 3000;
  r.check(
    "计数器支持增量并返回总数",
    diagnostics.increment("editor-change", 3) === 4
  );
  r.check(
    "非法增量不改变计数",
    diagnostics.increment("editor-change", Number.NaN) === 4 &&
      diagnostics.increment("editor-change", -5) === 4
  );

  now = 4000;
  diagnostics.recordTiming("locate", 12.5);
  now = 5000;
  diagnostics.recordTiming("locate", 7.5);
  now = 6000;
  diagnostics.recordTiming("locate", 20);
  diagnostics.recordTiming("locate", -1);

  const withMetrics = diagnostics.snapshot();
  r.check(
    "计数器快照含总数与更新时间",
    withMetrics.counters["editor-change"]?.value === 4 &&
      withMetrics.counters["editor-change"]?.updatedAt === 3000
  );
  r.check(
    "耗时聚合 count/last/max/total",
    withMetrics.timings.locate?.count === 3 &&
      withMetrics.timings.locate?.lastMs === 20 &&
      withMetrics.timings.locate?.maxMs === 20 &&
      withMetrics.timings.locate?.totalMs === 40
  );
  r.check(
    "非法耗时不污染统计",
    withMetrics.timings.locate?.count === 3
  );

  const sourceValue = {
    path: "正文/第1章.md",
    nested: { pending: 2 },
    flags: [true, false],
  };
  now = 7000;
  diagnostics.setLatest("selection", sourceValue);
  sourceValue.nested.pending = 99;
  const latestSnapshot = diagnostics.snapshot();
  r.check(
    "最近值记录写入时的副本",
    latestSnapshot.latest.selection?.value.nested.pending === 2 &&
      latestSnapshot.latest.selection?.updatedAt === 7000
  );

  latestSnapshot.latest.selection.value.nested.pending = 77;
  latestSnapshot.counters["editor-change"].value = 999;
  latestSnapshot.errors.push({
    source: "tamper",
    message: "tamper",
    stack: null,
    at: 0,
  });
  const isolated = diagnostics.snapshot();
  r.check(
    "修改快照不会污染服务内部状态",
    isolated.latest.selection?.value.nested.pending === 2 &&
      isolated.counters["editor-change"]?.value === 4 &&
      isolated.errors.length === 0
  );

  now = 8000;
  diagnostics.recordError("module:comments:activate", new Error("expected"));
  now = 9000;
  diagnostics.recordError("module:snapshots:load", "plain failure");
  now = 10000;
  diagnostics.recordError("module:outline:render", { reason: "bad state" });
  const errors = diagnostics.snapshot().errors;
  r.check(
    "错误历史按配置上限保留最新记录",
    errors.length === 2 &&
      errors[0].source === "module:snapshots:load" &&
      errors[1].source === "module:outline:render"
  );
  r.check(
    "非 Error 值也能转成可读错误",
    errors[1].message === "[object Object]" &&
      errors[1].stack === null &&
      errors[1].at === 10000
  );

  const projectedStates = [
    { id: "comments", status: "active" },
    {
      id: "snapshots",
      status: "failed",
      error: new Error("startup rejected"),
    },
  ];
  diagnostics.setModuleStates(projectedStates);
  projectedStates[0].status = "failed";
  projectedStates[1].error = new Error("changed later");
  const modules = diagnostics.snapshot().modules;
  r.check(
    "模块状态投影保留 Host 的 active/failed",
    modules.length === 2 &&
      modules[0].status === "active" &&
      modules[1].status === "failed"
  );
  r.check(
    "失败模块保留可读错误且不引用原对象",
    modules[1].error === "startup rejected"
  );

  diagnostics.setModuleStates([{ id: "comments", status: "active" }]);
  const replacedModules = diagnostics.snapshot().modules;
  r.check(
    "重新投影模块状态会清除旧条目",
    replacedModules.length === 1 &&
      replacedModules[0].id === "comments" &&
      replacedModules[0].status === "active"
  );

  diagnostics.clear();
  now = 11000;
  const cleared = diagnostics.snapshot();
  r.check(
    "清理会重置全部诊断状态",
    cleared.generatedAt === 11000 &&
      Object.keys(cleared.counters).length === 0 &&
      Object.keys(cleared.timings).length === 0 &&
      Object.keys(cleared.latest).length === 0 &&
      cleared.errors.length === 0 &&
      cleared.modules.length === 0
  );

  const serviceSource = fs.readFileSync(
    path.join(H.ROOT, "src/services/diagnosticsService.ts"),
    "utf8"
  );
  const hostSource = fs.readFileSync(
    path.join(H.ROOT, "src/host/pluginHost.ts"),
    "utf8"
  );
  r.check(
    "服务不直接依赖 Obsidian",
    !/\bfrom\s+["']obsidian["']/.test(serviceSource) &&
      !/\brequire\(["']obsidian["']\)/.test(serviceSource)
  );
  r.check(
    "模块状态契约与 Host 三态保持结构兼容",
    serviceSource.includes(
      'export type DiagnosticModuleStatus = "inactive" | "active" | "failed";'
    ) &&
      hostSource.includes(
        'export type FeatureModuleStatus = "inactive" | "active" | "failed";'
      )
  );

  return r.finish();
}

try {
  const ok = main();
  H.cleanup();
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error("运行失败：" + error.stack);
  H.cleanup();
  process.exit(2);
}
