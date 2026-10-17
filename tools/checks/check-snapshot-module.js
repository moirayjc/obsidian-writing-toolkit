/**
 * 快照核心生命周期检查。
 *
 * 用注入的假管理器验证模块自己的事件绑定、30 秒心跳、保存回调和清理，
 * 再守住 main.ts 不再直接创建或驱动 SnapshotManager。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

class TFile {
  constructor(path, extension = "md") {
    this.path = path;
    this.extension = extension;
  }
}

function main() {
  const restoreObsidian = H.stubObsidian({
    TFile,
    Notice: class {},
    Platform: { isMobile: false },
    TAbstractFile: class {},
    TFolder: class {},
    Vault: class {},
  });
  let createSnapshotModule;
  try {
    ({ createSnapshotModule } = H.compile(
      "src/features/snapshotModule.ts",
      "snapshot-module",
      ["electron"]
    ));
  } finally {
    restoreObsidian();
  }

  const { EffectScope } = H.compile(
    "src/host/effectScope.ts",
    "snapshot-module-scope"
  );
  const r = H.createReporter("快照核心 Feature Module");
  const files = new Map();
  const workspaceEvents = new Map();
  const vaultEvents = new Map();
  const calls = {
    editorChanges: [],
    fileSwitches: 0,
    renames: [],
    ticks: 0,
    unloads: 0,
    changes: 0,
    lists: 0,
  };
  let currentEditorPath = null;
  let managerOptions = null;
  let managerContext = null;
  let savedCallback = null;
  let timer = null;
  let factoryCalls = 0;

  const manager = {
    saveSnapshotNow() {
      return Promise.resolve();
    },
    openSnapshotFolder() {
      return Promise.resolve();
    },
    listSnapshots() {
      calls.lists++;
      return Promise.resolve([]);
    },
    readSnapshot() {
      return Promise.resolve("");
    },
    copySnapshot() {
      return Promise.resolve();
    },
    snapshotFileSilently() {
      return Promise.resolve();
    },
    onEditorChange(file, text) {
      calls.editorChanges.push({ path: file.path, text });
    },
    onFileSwitch() {
      calls.fileSwitches++;
    },
    onRename(file, oldPath) {
      calls.renames.push({ oldPath, newPath: file.path });
    },
    tick() {
      calls.ticks++;
    },
    unload() {
      calls.unloads++;
    },
  };

  const context = {
    app: {
      vault: {
        getAbstractFileByPath(filePath) {
          return files.get(filePath) ?? null;
        },
      },
    },
    services: {
      settings: {
        get() {
          return {};
        },
      },
      wordcount: {},
      editor: {
        getFilePathForEditor() {
          return currentEditorPath;
        },
      },
    },
    events: {
      onWorkspace(event, listener) {
        workspaceEvents.set(event, listener);
        return () => {};
      },
      onVault(event, listener) {
        vaultEvents.set(event, listener);
        return () => {};
      },
      setInterval(listener, delay) {
        timer = { listener, delay };
        return { id: 1, dispose() {} };
      },
    },
    effects: new EffectScope("snapshot-module-test"),
  };

  const module = createSnapshotModule(
    {
      getActiveFilePath() {
        return "/last-known.md";
      },
      getActiveText() {
        return "最近正文";
      },
    },
    (nextContext, nextOptions, onSaved) => {
      factoryCalls++;
      managerContext = nextContext;
      managerOptions = nextOptions;
      savedCallback = onSaved;
      return manager;
    }
  );

  let managerBeforeActivation = false;
  try {
    void module.operations;
  } catch {
    managerBeforeActivation = true;
  }

  r.check("模块 id 稳定", module.id === "snapshots.core");
  r.check("激活前不暴露操作端口", managerBeforeActivation);

  module.activate(context);
  r.check(
    "激活时只创建一个管理器并暴露窄操作端口",
    factoryCalls === 1 &&
      module.operations !== manager &&
      !("onEditorChange" in module.operations) &&
      !("tick" in module.operations) &&
      !("subscribe" in module.operations)
  );
  module.subscribe(() => {
    calls.changes++;
  });
  void module.operations.listSnapshots("正文草稿/第一章.md", "webnovel");
  r.check("操作端口委托真实管理器", calls.lists === 1);
  r.check(
    "向管理器传入主入口的最近文档端口",
    managerContext === context &&
      managerOptions.getActiveFilePath() === "/last-known.md" &&
      managerOptions.getActiveText() === "最近正文"
  );
  r.check(
    "只注册一个编辑器变化、文件切换和重命名监听",
    workspaceEvents.has("editor-change") &&
      workspaceEvents.has("active-leaf-change") &&
      vaultEvents.has("rename")
  );
  r.check(
    "注册 30 秒快照心跳",
    timer?.delay === 30_000 && typeof timer.listener === "function"
  );

  const chapter = new TFile("正文草稿/第一章.md");
  files.set(chapter.path, chapter);
  currentEditorPath = chapter.path;
  workspaceEvents.get("editor-change")(
    { getValue: () => "第一章正文" },
    {}
  );
  r.check(
    "编辑器变化按真实文件路径交给管理器",
    calls.editorChanges.length === 1 &&
      calls.editorChanges[0].path === chapter.path &&
      calls.editorChanges[0].text === "第一章正文"
  );

  const note = new TFile("资料/笔记.txt", "txt");
  files.set(note.path, note);
  currentEditorPath = note.path;
  workspaceEvents.get("editor-change")(
    { getValue: () => "不是 Markdown" },
    {}
  );
  currentEditorPath = "不存在.md";
  workspaceEvents.get("editor-change")(
    { getValue: () => "不存在" },
    {}
  );
  r.check(
    "非 Markdown 或索引外文件不会进入快照会话",
    calls.editorChanges.length === 1
  );

  workspaceEvents.get("active-leaf-change")(null);
  r.check(
    "文件切换结束会话并刷新快照面板",
    calls.fileSwitches === 1 && calls.changes === 1
  );

  vaultEvents.get("rename")(chapter, "正文草稿/旧第一章.md");
  r.check(
    "重命名事件交给管理器迁移镜像",
    calls.renames.length === 1 &&
      calls.renames[0].oldPath === "正文草稿/旧第一章.md" &&
      calls.renames[0].newPath === chapter.path
  );

  timer.listener();
  r.check("心跳调用管理器 tick", calls.ticks === 1);

  savedCallback();
  r.check("保存完成回调刷新快照面板", calls.changes === 2);

  context.effects.dispose();
  r.check("模块销毁时结束当前快照会话", calls.unloads === 1);

  let managerAfterDispose = false;
  try {
    void module.operations;
  } catch {
    managerAfterDispose = true;
  }
  r.check("销毁后不再暴露操作端口", managerAfterDispose);

  const beforeStaleCalls =
    calls.editorChanges.length +
    calls.fileSwitches +
    calls.renames.length +
    calls.ticks;
  workspaceEvents.get("editor-change")(
    { getValue: () => "销毁后正文" },
    {}
  );
  workspaceEvents.get("active-leaf-change")(null);
  vaultEvents.get("rename")(chapter, "正文草稿/再次改名.md");
  timer.listener();
  savedCallback();
  const afterStaleCalls =
    calls.editorChanges.length +
    calls.fileSwitches +
    calls.renames.length +
    calls.ticks;
  r.check(
    "销毁后残留事件和定时回调保持惰性",
    beforeStaleCalls === afterStaleCalls && calls.changes === 2
  );

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/snapshotModule.ts"),
    "utf8"
  );
  const panelSource = fs.readFileSync(
    path.join(H.ROOT, "src/snapshotPanel.ts"),
    "utf8"
  );
  const diffSource = fs.readFileSync(
    path.join(H.ROOT, "src/snapshotDiff.ts"),
    "utf8"
  );
  const activationMatch = mainSource.match(
    /activateModules\(\[([\s\S]*?)\]\)/
  );
  const activationList = activationMatch?.[1] ?? "";
  const instanceCount = (
    mainSource.match(/this\.snapshotModule = createSnapshotModule\(/g) ?? []
  ).length;
  const activationCount = (
    activationList.match(/this\.snapshotModule\b/g) ?? []
  ).length;

  r.check(
    "主入口只保留一次模块实例和一次 Host 激活",
    instanceCount === 1 && activationCount === 1
  );
  r.check(
    "主入口不再直接创建快照管理器",
    !/new DraftSnapshotManager\(/.test(mainSource)
  );
  r.check(
    "主入口不再持有快照定时器",
    !/snapshotTickTimer/.test(mainSource)
  );
  r.check(
    "主入口不再直接驱动快照生命周期",
    !/snapshotManager/.test(mainSource)
  );
  r.check(
    "主入口只暴露面板插槽挂载入口",
    /mountSnapshotPanels\(container: HTMLElement\): UiPanelGroup \{\s*return this\.host\.services\.ui\.mountPanels\(/.test(
      mainSource
    ) &&
      !/getSnapshotOperations\(/.test(mainSource) &&
      !/showSnapshotDiff/.test(mainSource)
  );
  r.check(
    "模块自己接管编辑器变化、文件切换、重命名和心跳",
    /events\.onWorkspace\("editor-change"/.test(moduleSource) &&
      /events\.onWorkspace\("active-leaf-change"/.test(moduleSource) &&
      /events\.onVault\("rename"/.test(moduleSource) &&
      /events\.setInterval\(/.test(moduleSource) &&
      /30_000/.test(moduleSource)
  );
  r.check(
    "模块销毁时由 EffectScope 结束会话",
    /effects\.add\(/.test(moduleSource) &&
      /current\?\.unload\(\)/.test(moduleSource) &&
      /listeners\.clear\(\)/.test(moduleSource) &&
      /subscribe\(listener\)/.test(moduleSource)
  );
  r.check(
    "模块不反向依赖 main.ts",
    !/from "\.\.\/main"/.test(moduleSource)
  );
  r.check(
    "快照侧栏实现只依赖操作端口和窄运行时",
    /type SnapshotOperations/.test(panelSource) &&
      /operations: SnapshotOperations/.test(panelSource) &&
      /runtime: SnapshotPanelRuntime/.test(panelSource) &&
      !/DraftSnapshotManager/.test(panelSource) &&
      !/plugin: any/.test(panelSource)
  );
  r.check(
    "差异与恢复流程不再穿过插件读取管理器",
    /operations: SnapshotOperations/.test(diffSource) &&
      /host: SnapshotDiffHost/.test(diffSource) &&
      !/plugin\.snapshotManager/.test(diffSource) &&
      !/plugin: any/.test(diffSource)
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
