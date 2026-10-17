/**
 * 打字机模块检查。
 *
 * 编译真实 Typewriter 运行时和 Feature Module，直接实例化模块注册的三个
 * ViewPlugin，验证设置订阅、动态启停、留白、滚动、段落高亮与清理边界。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function createDoc(text) {
  const parts = text.split("\n");
  const lines = [];
  let from = 0;
  for (let index = 0; index < parts.length; index++) {
    const value = parts[index];
    lines.push({
      number: index + 1,
      text: value,
      from,
      to: from + value.length,
    });
    from += value.length + 1;
  }
  return {
    lines: lines.length,
    line(number) {
      return lines[number - 1];
    },
    lineAt(pos) {
      for (let index = lines.length - 1; index >= 0; index--) {
        if (pos >= lines[index].from) return lines[index];
      }
      return lines[0];
    },
  };
}

function createContentDOM() {
  const classes = new Set();
  const props = {};
  return {
    classes,
    props,
    addClass(name) {
      classes.add(name);
    },
    removeClass(name) {
      classes.delete(name);
    },
    setCssProps(values) {
      Object.assign(props, values);
    },
  };
}

function createView(text, head, height = 600) {
  const dispatches = [];
  return {
    state: {
      doc: createDoc(text),
      selection: { main: { head } },
    },
    dom: { clientHeight: height },
    contentDOM: createContentDOM(),
    defaultLineHeight: 24,
    dispatches,
    dispatch(spec) {
      dispatches.push(spec);
    },
  };
}

function createUpdate(view, event = "input.type") {
  return {
    view,
    docChanged: true,
    selectionSet: false,
    geometryChanged: false,
    viewportChanged: false,
    transactions: [
      {
        annotation() {
          return event;
        },
      },
    ],
  };
}

function createPassiveUpdate(view) {
  return {
    view,
    docChanged: false,
    selectionSet: false,
    geometryChanged: false,
    viewportChanged: false,
    transactions: [],
  };
}

function decorationPositions(decorations) {
  const positions = [];
  const iterator = decorations.iter();
  while (iterator.value) {
    positions.push(iterator.from);
    iterator.next();
  }
  return positions;
}

function main() {
  const typewriter = H.compile("src/typewriter.ts", "typewriter");
  const { EffectScope } = H.compile(
    "src/host/effectScope.ts",
    "typewriter-effect-scope"
  );
  const { createTypewriterModule } = H.compile(
    "src/features/editorTypewriterModule.ts",
    "typewriter-module"
  );
  const r = H.createReporter("打字机 Feature Module");

  const originalWindow = global.window;
  const originalHadWindow = Object.prototype.hasOwnProperty.call(
    global,
    "window"
  );
  const frames = new Map();
  let nextFrameId = 1;
  const cancelledFrames = [];
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
    r.check(
      "偏移下限归一为 0.2",
      typewriter.normalizeTypewriterOffset(0.1) === 0.2
    );
    r.check(
      "偏移上限归一为 0.7",
      typewriter.normalizeTypewriterOffset(0.9) === 0.7
    );
    r.check(
      "非法偏移回退默认值",
      typewriter.normalizeTypewriterOffset(Number.NaN) === 0.4 &&
        typewriter.normalizeTypewriterOffset(Number.POSITIVE_INFINITY) === 0.4
    );

    const metrics = typewriter.typewriterMetrics(1000, 30, 0.2);
    r.check(
      "底部留白与滚动位置共用同一套计算",
      metrics.margin === 185 && metrics.bottomPadding === 815
    );
    const invalidMetrics = typewriter.typewriterMetrics(-1, Number.NaN, 0.4);
    r.check(
      "非法视口尺寸不会产生负留白",
      invalidMetrics.margin === 0 && invalidMetrics.bottomPadding === 0
    );

    const blockCases = ["## 标题", "- 列表", "1. 列表", "  * 缩进列表"];
    const proseCases = ["正文", "> 引用", "#没有空格", "普通 - 连接符"];
    r.check(
      "独立 Markdown 块识别标题与列表",
      blockCases.every((text) =>
        typewriter.isStandaloneMarkdownBlock(text)
      ) &&
        proseCases.every(
          (text) => !typewriter.isStandaloneMarkdownBlock(text)
        )
    );

    const documentText =
      "第一段\n第二行\n\n第三段\n- 列表\n列表续行\n## 标题\n正文";
    const doc = createDoc(documentText);
    const secondLine = typewriter.paragraphLineRange(doc, 2);
    r.check(
      "连续正文合并成同一高亮段落",
      secondLine?.firstLine === 1 && secondLine?.lastLine === 2
    );
    r.check("空行不产生高亮段落", typewriter.paragraphLineRange(doc, 3) === null);
    const listRange = typewriter.paragraphLineRange(doc, 5);
    r.check(
      "列表行单独形成高亮段落",
      listRange?.firstLine === 5 && listRange?.lastLine === 5
    );
    const afterList = typewriter.paragraphLineRange(doc, 6);
    r.check(
      "列表后的正文在标题前单独收束",
      afterList?.firstLine === 6 && afterList?.lastLine === 6
    );
    const headingRange = typewriter.paragraphLineRange(doc, 7);
    r.check(
      "标题行单独形成高亮段落",
      headingRange?.firstLine === 7 && headingRange?.lastLine === 7
    );
    r.check(
      "越界行号不产生高亮段落",
      typewriter.paragraphLineRange(doc, 0) === null &&
        typewriter.paragraphLineRange(doc, 99) === null
    );

    let currentSettings = {
      typewriterMode: false,
      typewriterOffset: 0.8,
      immersiveParagraphHighlight: false,
    };
    let listener = null;
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    let refreshCount = 0;
    let registeredExtension = null;
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
    const context = {
      services: {
        settings,
        editor: {
          refresh() {
            refreshCount++;
          },
        },
      },
      registrations: {
        registerEditorExtension(extension) {
          registeredExtension = extension;
        },
      },
      effects: new EffectScope("typewriter-test"),
    };
    const module = createTypewriterModule();

    r.check("模块 id 稳定", module.id === "editor.typewriter");
    r.check(
      "启动前模块保持关闭且不能绕过生命周期",
      module.isEnabled() === false &&
        module.isParagraphHighlightEnabled() === false
    );
    module.setEnabled(true);
    module.setOffset(0.2);
    module.setParagraphHighlight(true);
    r.check(
      "启动前兼容桥不会修改模块或刷新编辑器",
      module.isEnabled() === false &&
        module.getOffset() === 0.4 &&
        module.isParagraphHighlightEnabled() === false &&
        refreshCount === 0
    );

    module.activate(context);
    r.check(
      "启动时读取三项初始设置并归一偏移",
      module.isEnabled() === false &&
        module.getOffset() === 0.7 &&
        module.isParagraphHighlightEnabled() === false
    );
    r.check("启动时订阅一次设置", subscribeCount === 1);
    r.check(
      "启动时注册三个真实 ViewPlugin",
      Array.isArray(registeredExtension) &&
        registeredExtension.length === 3 &&
        registeredExtension.every(
          (plugin) => plugin && typeof plugin.create === "function"
        )
    );
    r.check("启动时未重复刷新编辑器", refreshCount === 0);

    const initialPaddingView = createView("正文", 1);
    const initialPadding = registeredExtension[0].create(initialPaddingView);
    r.check(
      "初始打字机关闭时不施加底部留白",
      !initialPadding.view.contentDOM.classes.has("wt-typewriter-pad")
    );
    const initialParagraphView = createView(
      documentText,
      documentText.indexOf("第二行") + 1
    );
    const initialParagraph = registeredExtension[2].create(
      initialParagraphView
    );
    r.check(
      "初始段落高亮关闭时没有装饰",
      initialParagraph.decorations.size === 0
    );

    module.setEnabled(true);
    r.check(
      "开启打字机即时生效并刷新一次",
      module.isEnabled() === true && refreshCount === 1
    );
    initialPadding.update(createPassiveUpdate(initialPaddingView));
    r.check(
      "重新开启时旧留白插件无需等输入即恢复",
      initialPaddingView.contentDOM.classes.has("wt-typewriter-pad")
    );
    module.setEnabled(true);
    r.check("重复开启不重复刷新", refreshCount === 1);

    const paddingView = createView("正文", 1);
    const padding = registeredExtension[0].create(paddingView);
    r.check(
      "开启后真实留白插件写入底部留白",
      paddingView.contentDOM.classes.has("wt-typewriter-pad") &&
        paddingView.contentDOM.props["--wt-typewriter-pad-bottom"] ===
          "192px"
    );

    module.setEnabled(false);
    padding.update(createUpdate(paddingView, null));
    r.check(
      "关闭后旧留白插件清理 DOM 状态",
      !paddingView.contentDOM.classes.has("wt-typewriter-pad") &&
        paddingView.contentDOM.props["--wt-typewriter-pad-bottom"] === ""
    );

    module.setOffset(0.1);
    const lowerOffset = module.getOffset();
    module.setOffset(0.9);
    const upperOffset = module.getOffset();
    module.setOffset(Number.NaN);
    const invalidOffset = module.getOffset();
    module.setOffset(0.5);
    const beforeSameOffset = refreshCount;
    module.setOffset(0.5);
    r.check(
      "兼容桥对偏移执行上下限和非法值归一",
      lowerOffset === 0.2 && upperOffset === 0.7 && invalidOffset === 0.4
    );
    r.check(
      "相同偏移不重复刷新",
      module.getOffset() === 0.5 && refreshCount === beforeSameOffset
    );

    module.setParagraphHighlight(true);
    r.check(
      "段落高亮可独立于打字机开关",
      module.isParagraphHighlightEnabled() === true &&
        module.isEnabled() === false
    );
    initialParagraph.update(createPassiveUpdate(initialParagraphView));
    r.check(
      "重新开启时旧高亮插件无需等输入即恢复",
      initialParagraph.decorations.size === 2
    );
    const highlightView = createView(
      documentText,
      documentText.indexOf("第二行") + 1
    );
    const activeParagraph = registeredExtension[2].create(highlightView);
    r.check(
      "真实高亮插件覆盖当前多行段落",
      activeParagraph.decorations.size === 2
    );
    activeParagraph.update({
      ...createUpdate(highlightView, null),
      docChanged: false,
      selectionSet: true,
      view: highlightView,
    });
    r.check(
      "选区变化后重新计算高亮范围",
      activeParagraph.decorations.size === 2
    );

    currentSettings = {
      typewriterMode: true,
      typewriterOffset: 0.65,
      immersiveParagraphHighlight: false,
    };
    const beforeRelevantSettings = refreshCount;
    listener({
      keys: [
        "typewriterMode",
        "typewriterOffset",
        "immersiveParagraphHighlight",
      ],
      previous: {
        typewriterMode: false,
        typewriterOffset: 0.5,
        immersiveParagraphHighlight: true,
      },
      current: currentSettings,
    });
    r.check(
      "三项设置变更合并为一次刷新",
      module.isEnabled() === true &&
        module.getOffset() === 0.65 &&
        module.isParagraphHighlightEnabled() === false &&
        refreshCount === beforeRelevantSettings + 1
    );
    const beforeUnrelatedSettings = refreshCount;
    listener({
      keys: ["dailyGoal"],
      previous: { dailyGoal: 3000, ...currentSettings },
      current: { dailyGoal: 4000, ...currentSettings },
    });
    r.check(
      "无关设置变更不刷新打字机",
      refreshCount === beforeUnrelatedSettings
    );

    const disabledParagraph = registeredExtension[2].create(
      createView(documentText, documentText.indexOf("第二行") + 1)
    );
    r.check(
      "设置关闭后真实高亮插件立即清空",
      disabledParagraph.decorations.size === 0
    );
    activeParagraph.update(createPassiveUpdate(highlightView));
    r.check(
      "运行中关闭高亮无需等输入即清空",
      activeParagraph.decorations.size === 0
    );

    const scrollView = createView("正文", 1);
    const scroll = registeredExtension[1].create(scrollView);
    scroll.update(createUpdate(scrollView));
    r.check(
      "输入后安排一次滚动动画帧",
      frames.size === 1 && scrollView.dispatches.length === 0
    );
    const scheduledFrame = [...frames.entries()][0];
    frames.delete(scheduledFrame[0]);
    scheduledFrame[1]();
    const scrollEffect = scrollView.dispatches[0]?.effects;
    r.check(
      "滚动动画使用当前偏移计算 margin",
      scrollView.dispatches.length === 1 &&
        scrollEffect?.value?.yMargin === 378
    );

    scroll.update(createUpdate(scrollView));
    const frameBeforeDisable = [...frames.keys()][0];
    module.setEnabled(false);
    scroll.update(createUpdate(scrollView, null));
    r.check(
      "关闭后取消尚未执行的滚动帧",
      cancelledFrames.includes(frameBeforeDisable) &&
        scrollView.dispatches.length === 1
    );

    module.setEnabled(true);
    padding.update(createPassiveUpdate(paddingView));
    r.check(
      "重新开启时已挂载留白插件无需等输入即恢复",
      paddingView.contentDOM.classes.has("wt-typewriter-pad")
    );
    const paddingBeforeDisposeView = createView("正文", 1);
    const paddingBeforeDispose = registeredExtension[0].create(
      paddingBeforeDisposeView
    );
    scroll.update(createUpdate(scrollView));
    const frameBeforeDestroy = [...frames.keys()][0];
    scroll.destroy();
    r.check(
      "插件销毁时取消待执行滚动帧",
      cancelledFrames.includes(frameBeforeDestroy) && frames.size === 0
    );

    const beforeDispose = refreshCount;
    context.effects.dispose();
    r.check(
      "模块清理后关闭全部运行时状态",
      module.isEnabled() === false &&
        module.getOffset() === 0.4 &&
        module.isParagraphHighlightEnabled() === false
    );
    r.check(
      "模块清理时取消订阅并刷新一次编辑器",
      unsubscribeCount === 1 && refreshCount === beforeDispose + 1
    );
    paddingBeforeDispose.update(createUpdate(paddingBeforeDisposeView, null));
    r.check(
      "模块清理后旧留白插件保持惰性",
      !paddingBeforeDisposeView.contentDOM.classes.has("wt-typewriter-pad")
    );

    scroll.update(createUpdate(scrollView));
    r.check(
      "模块清理后旧滚动插件不再安排动画",
      frames.size === 0 && scrollView.dispatches.length === 1
    );

    const beforeRevive = refreshCount;
    module.setEnabled(true);
    module.setOffset(0.2);
    module.setParagraphHighlight(true);
    listener({
      keys: [
        "typewriterMode",
        "typewriterOffset",
        "immersiveParagraphHighlight",
      ],
      previous: {},
      current: {
        typewriterMode: true,
        typewriterOffset: 0.2,
        immersiveParagraphHighlight: true,
      },
    });
    r.check(
      "模块清理后不能被兼容桥或旧订阅重新唤醒",
      module.isEnabled() === false &&
        module.getOffset() === 0.4 &&
        module.isParagraphHighlightEnabled() === false &&
        refreshCount === beforeRevive
    );

    const mainSource = fs.readFileSync(
      path.join(H.ROOT, "src/main.ts"),
      "utf8"
    );
    const moduleSource = fs.readFileSync(
      path.join(H.ROOT, "src/features/editorTypewriterModule.ts"),
      "utf8"
    );
    const typewriterSource = fs.readFileSync(
      path.join(H.ROOT, "src/typewriter.ts"),
      "utf8"
    );
    const sidebarSource = fs.readFileSync(
      path.join(H.ROOT, "src/sidebar.ts"),
      "utf8"
    );
    const activationMatch = mainSource.match(
      /activateModules\(\[([\s\S]*?)\]\)/
    );
    const activationList = activationMatch?.[1] ?? "";
    const instanceCount = (
      mainSource.match(/this\.typewriterModule = createTypewriterModule\(\);/g) ??
      []
    ).length;
    const activationCount = (
      activationList.match(/this\.typewriterModule\b/g) ?? []
    ).length;
    const moduleOrder = [
      activationList.indexOf("this.typewriterModule"),
      activationList.indexOf("this.punctuationModule"),
      activationList.indexOf("this.hardBreakModule"),
    ];
    r.check(
      "主入口只保留一次模块实例和一次激活",
      instanceCount === 1 && activationCount === 1
    );
    r.check(
      "编辑器模块按打字机、标点、硬换行顺序激活",
      moduleOrder.every((index) => index >= 0) &&
        moduleOrder[0] < moduleOrder[1] &&
        moduleOrder[1] < moduleOrder[2]
    );
    r.check(
      "主入口不再直接导入或注册打字机运行时",
      !/from "\.\/typewriter"/.test(mainSource) &&
        !/buildTypewriterExtensions/.test(mainSource) &&
        !/setTypewriterActive\(false\)/.test(mainSource)
    );
    const modeBridge = H.extractMethod(
      mainSource,
      "setTypewriterMode(on: boolean)"
    );
    const offsetBridge = H.extractMethod(
      mainSource,
      "setTypewriterOffset(offset: number)"
    );
    const paragraphBridge = H.extractMethod(
      mainSource,
      "setParagraphHighlight(on: boolean)"
    );
    r.check(
      "三个兼容桥只委托模块，不各自刷新编辑器",
      /typewriterModule\?\.setEnabled\(on\)/.test(modeBridge) &&
        /typewriterModule\?\.setOffset\(offset\)/.test(offsetBridge) &&
        /typewriterModule\?\.setParagraphHighlight\(on\)/.test(
          paragraphBridge
        ) &&
        !/\.refresh\(/.test(
          modeBridge + offsetBridge + paragraphBridge
        )
    );
    r.check(
      "模块自己读取并订阅三项设置",
      /settings\.get\(\)/.test(moduleSource) &&
        /settings\.subscribe\(/.test(moduleSource) &&
        /typewriterMode/.test(moduleSource) &&
        /typewriterOffset/.test(moduleSource) &&
        /immersiveParagraphHighlight/.test(moduleSource)
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
      "打字机运行时不再使用模块级可变全局状态",
      !/let\s+(typewriterActive|typewriterOffset|paragraphHighlightActive)\b/.test(
        typewriterSource
      ) &&
        /buildTypewriterExtensions\(runtime: TypewriterRuntime\)/.test(
          typewriterSource
        )
    );
    r.check(
      "旧全局状态函数已移除",
      typewriter.setTypewriterActive === undefined &&
        typewriter.setTypewriterOffset === undefined &&
        typewriter.setParagraphHighlight === undefined
    );
    r.check(
      "侧栏仍通过兼容桥即时控制三项功能",
      /setTypewriterMode\(value\)/.test(sidebarSource) &&
        /setTypewriterOffset\(v \/ 100\)/.test(sidebarSource) &&
        /setParagraphHighlight\(value\)/.test(sidebarSource)
    );

    return r.finish();
  } finally {
    if (originalHadWindow) global.window = originalWindow;
    else delete global.window;
  }
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
