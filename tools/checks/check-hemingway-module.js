/**
 * 海明威模式检查。
 *
 * 编译真实 CodeMirror 扩展和 Feature Module，验证末尾追加、组合输入例外、
 * 光标守卫、动画帧清理、设置订阅、动态启停与 main.ts 边界。
 */
const fs = require("fs");
const path = require("path");

// 临时编译产物位于系统临时目录；让外置的 CodeMirror 解析回仓库依赖。
process.env.NODE_PATH = [
  path.resolve(__dirname, "..", "..", "node_modules"),
  process.env.NODE_PATH,
]
  .filter(Boolean)
  .join(path.delimiter);
require("module").Module._initPaths();

const H = require("./_harness");
const { EditorState, Transaction } = require("@codemirror/state");

const CODEMIRROR_EXTERNALS = ["@codemirror/state", "@codemirror/view"];

function updateDocument(state, changes, userEvent) {
  const spec = { changes };
  if (userEvent) {
    spec.annotations = Transaction.userEvent.of(userEvent);
  }
  return state.update(spec).state;
}

function createGuardView(state) {
  return {
    state,
    dispatches: [],
    dispatch(spec) {
      this.dispatches.push(spec);
      this.state = this.state.update(spec).state;
    },
  };
}

function main() {
  const hemingway = H.compile(
    "src/hemingway.ts",
    "hemingway-runtime",
    CODEMIRROR_EXTERNALS
  );
  const { EffectScope } = H.compile(
    "src/host/effectScope.ts",
    "hemingway-effect-scope"
  );
  const { createHemingwayModule } = H.compile(
    "src/features/editorHemingwayModule.ts",
    "hemingway-module",
    CODEMIRROR_EXTERNALS
  );
  const r = H.createReporter("海明威 Feature Module");

  let active = false;
  const runtimeExtension = hemingway.buildHemingwayExtensions(() => active);
  const field = runtimeExtension[1];

  const initiallyDisabled = EditorState.create({
    doc: "abc",
    extensions: runtimeExtension,
  });
  r.check(
    "新建编辑器读取关闭状态",
    initiallyDisabled.field(field, false) === false
  );

  active = true;
  const enabledState = EditorState.create({
    doc: "abc",
    extensions: runtimeExtension,
  });
  r.check(
    "新建编辑器读取开启状态",
    enabledState.field(field, false) === true
  );
  r.check(
    "运行时查询能识别当前编辑器已开启",
    hemingway.isHemingwayActive({ state: enabledState }) === true
  );
  r.check(
    "末尾追加允许通过",
    updateDocument(enabledState, { from: 3, insert: "d" }).doc.toString() ===
      "abcd"
  );
  r.check(
    "中间插入被拒绝",
    updateDocument(enabledState, { from: 1, insert: "x" }).doc.toString() ===
      "abc"
  );
  r.check(
    "末尾删除被拒绝",
    updateDocument(enabledState, { from: 2, to: 3 }).doc.toString() === "abc"
  );
  r.check(
    "中间替换被拒绝",
    updateDocument(enabledState, { from: 1, to: 2, insert: "x" }).doc.toString() ===
      "abc"
  );
  r.check(
    "组合输入允许替换末尾区间",
    updateDocument(
      enabledState,
      { from: 2, to: 3, insert: "cd" },
      "input.compose"
    ).doc.toString() === "abcd"
  );
  r.check(
    "组合输入延伸到文档末尾时维持现有放行语义",
    updateDocument(
      enabledState,
      { from: 0, to: 3, insert: "xyz" },
      "input.compose"
    ).doc.toString() === "xyz"
  );
  r.check(
    "组合输入仍拒绝中间修改",
    updateDocument(
      enabledState,
      { from: 1, to: 2, insert: "x" },
      "input.compose"
    ).doc.toString() === "abc"
  );
  r.check(
    "撤销引起的回改被拒绝",
    updateDocument(
      enabledState,
      { from: 2, to: 3 },
      "undo"
    ).doc.toString() === "abc"
  );
  const historyBindings = runtimeExtension[4].inner.value;
  r.check(
    "历史快捷键覆盖撤销、重做与 Windows 重做",
    historyBindings.map((binding) => binding.key).join("|") ===
      "Mod-z|Mod-Shift-z|Mod-y"
  );
  r.check(
    "海明威开启时撤销和重做快捷键被最高优先级接管",
    historyBindings.every(
      (binding) => binding.run({ state: enabledState }) === true
    )
  );

  const selectedState = enabledState.update({
    selection: { anchor: 0, head: 2 },
  }).state;
  r.check(
    "不修改文本的选区事务允许通过",
    selectedState.doc.toString() === "abc" &&
      selectedState.selection.main.from === 0 &&
      selectedState.selection.main.to === 2
  );

  const disabledByEffect = enabledState.update({
    effects: hemingway.setHemingway.of(false),
  }).state;
  r.check(
    "状态效果可临时关闭海明威模式",
    disabledByEffect.field(field, false) === false
  );
  r.check(
    "关闭后中间修改恢复",
    updateDocument(disabledByEffect, {
      from: 1,
      to: 2,
      insert: "x",
    }).doc.toString() === "axc"
  );

  active = false;
  r.check(
    "模块运行时关闭后旧字段不再报告开启",
    enabledState.field(field, false) === true &&
      hemingway.isHemingwayActive({ state: enabledState }) === false
  );
  r.check(
    "模块运行时关闭后撤销和重做快捷键恢复默认",
    historyBindings.every(
      (binding) => binding.run({ state: enabledState }) === false
    )
  );
  r.check(
    "模块运行时关闭后旧字段不再拦截修改",
    updateDocument(enabledState, {
      from: 1,
      to: 2,
      insert: "x",
    }).doc.toString() === "axc"
  );
  active = true;

  const originalWindow = global.window;
  const originalHadWindow = Object.prototype.hasOwnProperty.call(
    global,
    "window"
  );
  const frames = new Map();
  const cancelledFrames = [];
  let nextFrameId = 1;
  global.window = {
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledFrames.push(id);
      frames.delete(id);
    },
  };

  try {
    const cursorState = EditorState.create({
      doc: "abc",
      selection: { anchor: 1 },
      extensions: runtimeExtension,
    });
    const cursorView = createGuardView(cursorState);
    const cursorGuard = runtimeExtension[3].create(cursorView);
    cursorGuard.update({ state: cursorView.state, view: cursorView });
    const cursorFrame = [...frames.entries()][0];
    r.check(
      "单击旧位置会安排一次延迟光标修正",
      frames.size === 1 && cursorView.dispatches.length === 0
    );
    frames.delete(cursorFrame[0]);
    cursorFrame[1]();
    r.check(
      "延迟修正把光标拉回文档末尾",
      cursorView.dispatches.length === 1 &&
        cursorView.state.selection.main.head === 3
    );

    const dragState = EditorState.create({
      doc: "abc",
      selection: { anchor: 0, head: 2 },
      extensions: runtimeExtension,
    });
    const dragView = createGuardView(dragState);
    const dragGuard = runtimeExtension[3].create(dragView);
    dragGuard.update({ state: dragView.state, view: dragView });
    r.check(
      "拖选旧正文用于查看时保留选区",
      frames.size === 0 &&
        dragView.dispatches.length === 0 &&
        dragView.state.selection.main.from === 0
    );

    const endState = EditorState.create({
      doc: "abc",
      selection: { anchor: 3 },
      extensions: runtimeExtension,
    });
    const endView = createGuardView(endState);
    const endGuard = runtimeExtension[3].create(endView);
    endGuard.update({ state: endView.state, view: endView });
    r.check(
      "光标本来就在末尾时不安排修正",
      frames.size === 0 && endView.dispatches.length === 0
    );

    const composingState = EditorState.create({
      doc: "abc",
      selection: { anchor: 1 },
      extensions: runtimeExtension,
    });
    const composingView = createGuardView(composingState);
    composingView.composing = true;
    const composingGuard = runtimeExtension[3].create(composingView);
    composingGuard.update({ state: composingView.state, view: composingView });
    r.check(
      "输入法组合期间不安排光标修正",
      frames.size === 0 && composingView.dispatches.length === 0
    );

    const cancelState = EditorState.create({
      doc: "abc",
      selection: { anchor: 1 },
      extensions: runtimeExtension,
    });
    const cancelView = createGuardView(cancelState);
    const cancelGuard = runtimeExtension[3].create(cancelView);
    cancelGuard.update({ state: cancelView.state, view: cancelView });
    const disabledState = cancelView.state.update({
      effects: hemingway.setHemingway.of(false),
    }).state;
    const pendingCancelFrame = [...frames.keys()][0];
    cancelView.state = disabledState;
    cancelGuard.update({ state: disabledState, view: cancelView });
    r.check(
      "关闭模式时取消尚未执行的光标修正",
      cancelledFrames.includes(pendingCancelFrame) &&
        frames.size === 0 &&
        cancelView.dispatches.length === 0
    );

    const destroyState = EditorState.create({
      doc: "abc",
      selection: { anchor: 1 },
      extensions: runtimeExtension,
    });
    const destroyView = createGuardView(destroyState);
    const destroyGuard = runtimeExtension[3].create(destroyView);
    destroyGuard.update({ state: destroyView.state, view: destroyView });
    const pendingDestroyFrame = [...frames.keys()][0];
    destroyGuard.destroy();
    r.check(
      "插件销毁时取消尚未执行的光标修正",
      cancelledFrames.includes(pendingDestroyFrame) &&
        frames.size === 0 &&
        destroyView.dispatches.length === 0
    );
  } finally {
    if (originalHadWindow) global.window = originalWindow;
    else delete global.window;
  }

  let currentSettings = { hemingwayMode: false, dailyGoal: 3000 };
  let listener = null;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  let registerCount = 0;
  let refreshCount = 0;
  let registeredExtension = null;
  const fakeViews = Array.from({ length: 2 }, () => ({
    dispatches: [],
    dispatch(spec) {
      this.dispatches.push(spec);
    },
  }));
  const settings = {
    get() {
      return currentSettings;
    },
    subscribe(next) {
      subscribeCount++;
      listener = next;
      return () => {
        unsubscribeCount++;
      };
    },
  };
  const editorService = {
    getMarkdownEditorViews() {
      return fakeViews;
    },
    refresh() {
      refreshCount++;
    },
  };
  const effects = new EffectScope("hemingway-test");
  const context = {
    services: { settings, editor: editorService },
    registrations: {
      registerEditorExtension(extension) {
        registerCount++;
        registeredExtension = extension;
      },
    },
    effects,
  };
  const module = createHemingwayModule();

  r.check("模块 id 稳定", module.id === "editor.hemingway");
  r.check("启动前模块保持关闭", module.isEnabled() === false);
  module.setEnabled(true);
  r.check(
    "启动前不能绕过生命周期启用",
    module.isEnabled() === false &&
      fakeViews.every((view) => view.dispatches.length === 0)
  );

  module.activate(context);
  r.check(
    "启动时读取初始设置",
    module.isEnabled() === false &&
      registerCount === 1 &&
      subscribeCount === 1 &&
      refreshCount === 1
  );
  r.check(
    "启动时刷新现有编辑器并同步初始关闭状态",
    fakeViews.every(
      (view) =>
        view.dispatches.length === 1 &&
        view.dispatches[0].effects?.value === false
    )
  );
  const moduleDisabledState = EditorState.create({
    doc: "abc",
    extensions: registeredExtension,
  });
  r.check(
    "模块注册的真实扩展遵循初始关闭设置",
    moduleDisabledState.field(registeredExtension[1], false) === false
  );

  module.setEnabled(true);
  r.check(
    "开启后向所有 Markdown 编辑器派发状态",
    module.isEnabled() === true &&
      fakeViews.every(
        (view) =>
          view.dispatches.length === 2 &&
          view.dispatches[1].effects?.value === true
      )
  );
  const moduleEnabledState = EditorState.create({
    doc: "abc",
    extensions: registeredExtension,
  });
  r.check(
    "开关开启后新建编辑器直接生效",
    moduleEnabledState.field(registeredExtension[1], false) === true
  );

  module.setEnabled(true);
  r.check(
    "重复开启不重复派发",
    fakeViews.every((view) => view.dispatches.length === 2)
  );

  currentSettings = { hemingwayMode: false, dailyGoal: 3000 };
  listener({
    keys: ["hemingwayMode"],
    previous: { hemingwayMode: true, dailyGoal: 3000 },
    current: currentSettings,
  });
  r.check(
    "设置变更同步到模块并向现有编辑器下发",
    module.isEnabled() === false &&
      fakeViews.every(
        (view) =>
          view.dispatches.length === 3 &&
          view.dispatches[2].effects?.value === false
      )
  );

  listener({
    keys: ["dailyGoal"],
    previous: { hemingwayMode: false, dailyGoal: 3000 },
    current: { hemingwayMode: false, dailyGoal: 4000 },
  });
  r.check(
    "无关设置变更不触碰海明威模式",
    module.isEnabled() === false &&
      fakeViews.every((view) => view.dispatches.length === 3)
  );

  module.setEnabled(true);
  const beforeDispose = fakeViews.map((view) => view.dispatches.length);
  effects.dispose();
  r.check(
    "模块清理后关闭状态并取消订阅",
    module.isEnabled() === false &&
      unsubscribeCount === 1 &&
      fakeViews.every(
        (view, index) =>
          view.dispatches.length === beforeDispose[index] + 1 &&
          view.dispatches.at(-1).effects?.value === false
      )
  );
  const disposedState = EditorState.create({
    doc: "abc",
    extensions: registeredExtension,
  });
  r.check(
    "模块清理后旧扩展对新编辑器保持惰性",
    disposedState.field(registeredExtension[1], false) === false
  );

  listener({
    keys: ["hemingwayMode"],
    previous: { hemingwayMode: false, dailyGoal: 4000 },
    current: { hemingwayMode: true, dailyGoal: 4000 },
  });
  module.setEnabled(true);
  r.check(
    "模块清理后旧监听器和兼容桥不能重新唤醒",
    module.isEnabled() === false &&
      fakeViews.every(
        (view, index) => view.dispatches.length === beforeDispose[index] + 1
      )
  );

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/editorHemingwayModule.ts"),
    "utf8"
  );
  const hemingwaySource = fs.readFileSync(
    path.join(H.ROOT, "src/hemingway.ts"),
    "utf8"
  );
  const editorServiceSource = fs.readFileSync(
    path.join(H.ROOT, "src/services/editorService.ts"),
    "utf8"
  );
  const activationMatch = mainSource.match(
    /activateModules\(\[([\s\S]*?)\]\)/
  );
  const activationList = activationMatch?.[1] ?? "";
  const instanceCount = (
    mainSource.match(/this\.hemingwayModule = createHemingwayModule\(\);/g) ??
    []
  ).length;
  const activationCount = (
    activationList.match(/this\.hemingwayModule\b/g) ?? []
  ).length;
  const mainCompatibilityMethod = H.extractMethod(
    mainSource,
    "setHemingwayMode(on: boolean)"
  );

  r.check(
    "主入口只保留一次模块实例",
    instanceCount === 1 && activationCount === 1
  );
  r.check(
    "主入口兼容桥只委托模块",
    /this\.hemingwayModule\?\.setEnabled\(on\)/.test(
      mainCompatibilityMethod
    ) &&
      !/iterateAllLeaves|\.dispatch\(|setHemingway\b|\.refresh\(/.test(
        mainCompatibilityMethod
      )
  );
  r.check(
    "主入口不再直接导入海明威运行时",
    !/from "\.\/hemingway"/.test(mainSource)
  );
  r.check(
    "模块自己读取并订阅设置",
    /settings\.get\(\)\.hemingwayMode/.test(moduleSource) &&
      /settings\.subscribe\(/.test(moduleSource)
  );
  r.check(
    "模块自己注册扩展并接入 EffectScope",
    /registerEditorExtension\(/.test(moduleSource) &&
      /effects\.add\(/.test(moduleSource)
  );
  r.check(
    "模块不反向依赖 main.ts",
    !/from "\.\.\/main"/.test(moduleSource)
  );
  r.check(
    "海明威运行时不再使用模块级期望状态",
    !/let hemingwayDesired/.test(hemingwaySource) &&
      !/setHemingwayDesired/.test(hemingwaySource) &&
      /Facet\.define/.test(hemingwaySource)
  );
  r.check(
    "Editor Service 提供 Markdown 编辑器窄接口",
    /getMarkdownEditorViews\(\): EditorView\[\]/.test(editorServiceSource)
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
