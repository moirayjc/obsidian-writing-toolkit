/**
 * 快照 UI Feature Module 检查。
 *
 * 用注入的面板和差异窗口工厂验证：模块通过 UI 插槽挂载、只暴露窄运行时、
 * 响应快照/设置变化、列出与打开最新差异，并在停用后保持惰性。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

async function main() {
  const notices = [];
  const restoreObsidian = H.stubObsidian({
    Modal: class {
      constructor(app) {
        this.app = app;
        this.contentEl = {};
      }
    },
    Notice: class {
      constructor(text) {
        notices.push(text);
      }
    },
    Setting: class {},
    setIcon() {},
  });
  let createSnapshotUiModule;
  try {
    ({ createSnapshotUiModule } = H.compile(
      "src/features/snapshotUiModule.ts",
      "snapshot-ui-module",
      ["electron"]
    ));
  } finally {
    restoreObsidian();
  }

  const { EffectScope } = H.compile(
    "src/host/effectScope.ts",
    "snapshot-ui-scope"
  );
  const r = H.createReporter("快照 UI Feature Module");

  const calls = {
    lists: [],
    coreSubscriptions: 0,
    coreUnsubscriptions: 0,
    settingsSubscriptions: 0,
    settingsUnsubscriptions: 0,
    registrations: 0,
    unregistrations: 0,
    countWords: [],
    panelFactory: 0,
    panelRefreshes: 0,
    panelLive: [],
    panelDestroys: 0,
    diffs: [],
  };
  let coreListener = null;
  let settingsListener = null;
  let panelFactory = null;
  let panelRuntime = null;
  let panelContainer = null;
  let panelOperations = null;
  let listResult = [];
  let snapshotMaxPerFile = 20;
  let wordCountMode = "webnovel";

  const operations = {
    saveSnapshotNow() {
      return Promise.resolve();
    },
    openSnapshotFolder() {
      return Promise.resolve();
    },
    listSnapshots(sourcePath, mode) {
      calls.lists.push({ sourcePath, mode });
      return Promise.resolve(listResult);
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
  };
  const core = {
    id: "snapshots.core",
    operations,
    subscribe(listener) {
      calls.coreSubscriptions++;
      coreListener = listener;
      return () => {
        calls.coreUnsubscriptions++;
        coreListener = null;
      };
    },
  };
  const editor = { kind: "editor" };
  const context = {
    app: { kind: "app" },
    services: {
      settings: {
        get() {
          return {
            wordCountMode,
            snapshotMaxPerFile,
          };
        },
        subscribe(listener) {
          calls.settingsSubscriptions++;
          settingsListener = listener;
          return () => {
            calls.settingsUnsubscriptions++;
            settingsListener = null;
          };
        },
      },
      wordcount: {
        count(text, mode) {
          calls.countWords.push({ text, mode });
          return text.length;
        },
      },
      ui: {
        registerPanel(slot, factory) {
          calls.registrations++;
          panelFactory = { slot, factory };
          return () => {
            calls.unregistrations++;
          };
        },
      },
    },
    effects: new EffectScope("snapshot-ui-test"),
  };

  const module = createSnapshotUiModule(
    {
      core,
      getEditor() {
        return editor;
      },
      getActiveFilePath() {
        return "/正文草稿/第一章.md";
      },
      getActiveText() {
        return "第一章正文";
      },
      isEditorValid(value) {
        return value === editor;
      },
      markProgrammaticEdit(target, text) {
        calls.live = { target, text };
      },
    },
    {
      createPanel(container, operationsArg, runtime) {
        calls.panelFactory++;
        panelContainer = container;
        panelOperations = operationsArg;
        panelRuntime = runtime;
        return {
          container,
          operations: operationsArg,
          runtime,
          refresh() {
            calls.panelRefreshes++;
          },
          updateLive(text) {
            calls.panelLive.push(text);
          },
          destroy() {
            calls.panelDestroys++;
          },
        };
      },
      showDiff(host, diffOperations, sourcePath, snapshotPath, snapshotName, onChanged) {
        calls.diffs.push({
          host,
          diffOperations,
          sourcePath,
          snapshotPath,
          snapshotName,
          onChanged,
        });
      },
    }
  );

  let inactiveListRejected = false;
  try {
    await module.listSnapshots("/x.md");
  } catch {
    inactiveListRejected = true;
  }
  r.check("模块 id 与依赖稳定", module.id === "snapshots.ui" && module.dependsOn?.[0] === "snapshots.core");
  r.check("激活前不提供快照 UI 能力", inactiveListRejected);

  await module.activate(context);
  r.check(
    "激活时订阅核心变化和设置变化各一次",
    calls.coreSubscriptions === 1 && calls.settingsSubscriptions === 1
  );
  r.check(
    "激活时只注册一个侧栏快照插槽",
    calls.registrations === 1 &&
      panelFactory?.slot === "writing-toolkit:sidebar:snapshot"
  );

  const container = { kind: "snapshot-container" };
  const panel = panelFactory.factory(container);
  r.check(
    "插槽工厂把容器、操作端口和窄运行时交给面板",
    calls.panelFactory === 1 &&
      panelContainer === container &&
      panelOperations === operations &&
      panelRuntime !== null
  );
  r.check(
    "面板运行时读取最近文档信息",
    panelRuntime.getActiveFilePath() === "/正文草稿/第一章.md" &&
      panelRuntime.getActiveText() === "第一章正文" &&
      panelRuntime.getEditor() === editor &&
      panelRuntime.isEditorValid(editor)
  );
  r.check(
    "面板运行时按当前模式调用 WordCount Service",
    panelRuntime.countWords("四个字") === 3 &&
      calls.countWords[0].mode === "webnovel"
  );
  r.check(
    "面板运行时实时读取快照设置",
    panelRuntime.getWordCountMode() === "webnovel" &&
      panelRuntime.getSnapshotMaxPerFile() === 20
  );

  await module.listSnapshots("/正文草稿/第二章.md");
  r.check(
    "工作台列表走核心操作端口和当前字数模式",
    calls.lists.at(-1)?.sourcePath === "/正文草稿/第二章.md" &&
      calls.lists.at(-1)?.mode === "webnovel"
  );

  coreListener();
  r.check("核心快照变化刷新已挂载面板", calls.panelRefreshes === 1);
  settingsListener({ keys: ["snapshotMaxPerFile"] });
  r.check(
    "快照上限或目录变化刷新面板",
    calls.panelRefreshes === 2
  );
  settingsListener({ keys: ["snapshotFolder"] });
  r.check("快照目录变化刷新面板", calls.panelRefreshes === 3);
  settingsListener({ keys: ["lineHeight"] });
  r.check("无关设置变化不刷新快照面板", calls.panelRefreshes === 3);
  settingsListener({ keys: ["wordCountMode"] });
  r.check("字数模式变化刷新面板", calls.panelRefreshes === 4);

  listResult = [];
  await module.openLatestDiff("/正文草稿/第三章.md");
  r.check(
    "没有快照时给出提示且不打开差异窗口",
    notices.at(-1)?.includes("还没有快照") && calls.diffs.length === 0
  );

  listResult = [
    { path: ".wt-snapshots/doc-1.md", name: "doc-1.md", at: 1, wordCount: 10 },
  ];
  await module.openLatestDiff("/正文草稿/第三章.md");
  const diff = calls.diffs[0];
  r.check(
    "打开最新差异时传入真实快照与窄宿主",
    diff?.sourcePath === "/正文草稿/第三章.md" &&
      diff?.snapshotPath === ".wt-snapshots/doc-1.md" &&
      diff?.diffOperations === operations &&
      diff?.host.getEditor() === editor &&
      diff?.host.getActiveFilePath() === "/正文草稿/第一章.md"
  );
  diff?.onChanged();
  r.check("差异恢复后的回调刷新快照面板", calls.panelRefreshes === 5);

  panel.updateLive("最新正文");
  r.check(
    "插槽实时刷新转交面板",
    calls.panelLive.at(-1) === "最新正文"
  );

  module.deactivate();
  let deactivatedListRejected = false;
  try {
    await module.listSnapshots("/x.md");
  } catch {
    deactivatedListRejected = true;
  }
  r.check("停用后不再提供快照 UI 能力", deactivatedListRejected);

  context.effects.dispose();
  r.check(
    "销毁时撤销订阅、插槽注册并销毁面板",
    calls.coreUnsubscriptions === 1 &&
      calls.settingsUnsubscriptions === 1 &&
      calls.unregistrations === 1 &&
      calls.panelDestroys === 1
  );

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(H.ROOT, "src/sidebar.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/snapshotUiModule.ts"),
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
  r.check(
    "快照 UI 模块不反向依赖 main.ts",
    !/from "\.\.\/main"/.test(moduleSource)
  );
  r.check(
    "主入口装配快照 UI 模块但不 import 面板或差异实现",
    /createSnapshotUiModule\(/.test(mainSource) &&
      /this\.snapshotUiModule,/.test(mainSource) &&
      !/SnapshotOperationPanel/.test(mainSource) &&
      !/showSnapshotDiff/.test(mainSource)
  );
  r.check(
    "侧栏只通过 UI 插槽挂载快照面板",
    /mountSnapshotPanels\(panelEl\)/.test(sidebarSource) &&
      !/SnapshotOperationPanel/.test(sidebarSource) &&
      !/snapshotPanel"/.test(sidebarSource)
  );
  r.check(
    "快照面板和差异窗口不再接受插件 any",
    !/plugin: any/.test(panelSource) &&
      !/plugin: any/.test(diffSource) &&
      /SnapshotPanelRuntime/.test(panelSource) &&
      /SnapshotDiffHost/.test(diffSource)
  );

  return r.finish();
}

Promise.resolve()
  .then(main)
  .then((ok) => {
    H.cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error("运行失败：" + error.stack);
    H.cleanup();
    process.exit(2);
  });
