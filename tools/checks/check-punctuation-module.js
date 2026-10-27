/**
 * 中文标点辅助模块检查。
 *
 * 用真实输入变换和模块生命周期验证括号配对、设置订阅、动态启停与清理，
 * 再守住 main.ts 只保留兼容桥，不重新接管模块状态。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

let EditorState = null;

/**
 * 用真实 EditorState 驱动的最小视图：输入处理器只用到 state 与 dispatch。
 * 文本里的「|」标光标，「[」「]」标选区。
 */
function createView(marked) {
  const anchor = marked.indexOf("[") >= 0 ? marked.indexOf("[") : marked.indexOf("|");
  const plain = marked.replace(/[|[\]]/g, "");
  const head = marked.indexOf("]") >= 0 ? marked.indexOf("]") - 1 : anchor;
  let state = EditorState.create({ doc: plain, selection: { anchor, head } });
  return {
    get state() {
      return state;
    },
    dispatch(spec) {
      state = state.update(spec).state;
    },
    /** 当前文本，光标处插回「|」（有选区时用「[]」）。 */
    marked() {
      const { from, to, empty } = state.selection.main;
      const doc = state.doc.toString();
      if (empty) return doc.slice(0, from) + "|" + doc.slice(from);
      return doc.slice(0, from) + "[" + doc.slice(from, to) + "]" + doc.slice(to);
    },
  };
}

/** 模拟输入法提交一个字符：处理器不接管时按默认行为插入。 */
function type(handler, view, text) {
  const { from, to } = view.state.selection.main;
  if (!handler(view, from, to, text)) {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
  }
  return view;
}

function typeAll(handler, marked, chars) {
  const view = createView(marked);
  for (const ch of chars) type(handler, view, ch);
  return view.marked();
}

function main() {
  ({ EditorState } = H.compile("node_modules/@codemirror/state/dist/index.js", "punctuation-cm-state"));
  const punctuation = H.compile("src/punctuation.ts", "punctuation");
  const { EffectScope } = H.compile("src/host/effectScope.ts", "punctuation-scope");
  const { createPunctuationModule } = H.compile(
    "src/features/editorPunctuationModule.ts",
    "punctuation-module"
  );
  const r = H.createReporter("中文标点辅助 Feature Module");

  let active = false;
  let autoClose = true;
  const handler = punctuation.createPunctuationInputHandler(() => active, {
    canAutoClose: () => autoClose,
  });
  const backspace = (marked) => {
    const view = createView(marked);
    const handled = punctuation.applyPunctuationBackspace(view);
    return { handled, marked: view.marked() };
  };

  r.check("关闭时输入处理器不接管", handler(createView("|"), 0, 0, "“") === false);

  active = true;
  r.check("多字符输入不接管", handler(createView("|"), 0, 0, "“”") === false);
  r.check("普通文字输入不接管", handler(createView("|"), 0, 0, "雪") === false);

  // —— 双引号：不管输入法给的是左还是右，都按上下文定方向 ——
  r.check("引号外输入左引号：补成一对", typeAll(handler, "|", "“") === "“|”");
  r.check("引号外输入法给了右引号：仍当开头补成一对", typeAll(handler, "他说：|", "”") === "他说：“|”");
  r.check(
    "引号里输入右引号：跳过已补的右引号",
    typeAll(handler, "|", "“好”") === "“好”|"
  );
  r.check(
    "引号里输入法给了左引号：仍当收尾跳过",
    typeAll(handler, "|", "“好“") === "“好”|"
  );
  r.check(
    "一整句对话：输入法左右错乱也打得对",
    typeAll(handler, "|", "”走吧”，他说，“快”") === "“走吧”，他说，“快”|"
  );
  r.check(
    "正文前插引号只补左边，收尾时补右引号",
    typeAll(handler, "|走吧", "”") === "“|走吧" &&
      typeAll(handler, "“走吧|", "“") === "“走吧”|"
  );
  r.check(
    "孤立右引号前输入引号：只补左边让它配上",
    typeAll(handler, "|好”", "“") === "“|好”" && typeAll(handler, "|”", "“") === "“|”"
  );
  r.check(
    "上一段没闭合的引号不影响下一段",
    typeAll(handler, "“上一段\n|", "”") === "“上一段\n“|”"
  );
  r.check(
    "有选区时用引号包裹并保持选中",
    typeAll(handler, "[雪夜]", "”") === "“[雪夜]”"
  );
  r.check(
    "单引号同样按上下文判断",
    typeAll(handler, "“他说|”", "’好’") === "“他说‘好’|”"
  );
  r.check("英文撇号不当引号", typeAll(handler, "it|", "’") === "it’|");

  // —— 方向明确的括号 ——
  r.check(
    "有选区时包裹并保持正文选中",
    typeAll(handler, "[雪夜]", "《") === "《[雪夜]》"
  );
  r.check(
    "输入已补出的右括号时只移动光标",
    typeAll(handler, "（|）", "）") === "（）|"
  );
  r.check("括号可以嵌套", typeAll(handler, "（|）", "（") === "（（|））");
  r.check(
    "孤立右括号前再输右括号照常插入",
    typeAll(handler, "甲|）", "）") === "甲）|）"
  );
  r.check("没有相邻右括号时不接管右括号输入", handler(createView("|"), 0, 0, "）") === false);
  r.check("正文前插左括号不凭空补右括号", typeAll(handler, "|雪夜", "（") === "（|雪夜");
  r.check(
    "补齐直角引号与书名号等",
    typeAll(handler, "|", "「") === "「|」" &&
      typeAll(handler, "|", "『") === "『|』" &&
      typeAll(handler, "|", "〈") === "〈|〉"
  );

  // —— 海明威模式：光标会被拉回文末，不能补右半边 ——
  autoClose = false;
  r.check(
    "不能自动补全时只插左半边，收尾照样判断方向",
    typeAll(handler, "|", "”好”") === "“好”|" && typeAll(handler, "|", "（") === "（|"
  );
  autoClose = true;

  // —— 退格 ——
  const bsPair = backspace("（|）");
  const bsQuote = backspace("说“|”");
  const bsText = backspace("“好|”");
  r.check(
    "空的一对中间退格连右半边一起删",
    bsPair.handled && bsPair.marked === "|" && bsQuote.handled && bsQuote.marked === "说|"
  );
  r.check("不是空的一对时退格不接管", bsText.handled === false && bsText.marked === "“好|”");

  const module = createPunctuationModule();
  const effects = new EffectScope("punctuation-test");
  let unsubscribeCount = 0;
  let listener = null;
  let registeredExtension = null;
  let currentEnabled = false;
  const settings = {
    get() {
      return { punctuationAssist: currentEnabled };
    },
    subscribe(next) {
      listener = next;
      return () => {
        unsubscribeCount++;
      };
    },
  };
  const context = {
    services: { settings },
    registrations: {
      registerEditorExtension(extension) {
        registeredExtension = extension;
      },
    },
    effects,
  };

  r.check("模块 id 稳定", module.id === "editor.punctuation");
  r.check("启动前模块保持关闭", module.isEnabled() === false);
  module.setEnabled(true);
  r.check("启动前不能绕过生命周期启用", module.isEnabled() === false);

  module.activate(context);
  r.check("启动后读取初始设置（关闭）", module.isEnabled() === false);
  r.check("启动后注册编辑器扩展", registeredExtension !== null);
  r.check("启动后订阅设置变更", typeof listener === "function");

  module.setEnabled(true);
  r.check("兼容桥可即时启停模块", module.isEnabled() === true);

  currentEnabled = false;
  listener({
    keys: ["punctuationAssist"],
    previous: { punctuationAssist: true },
    current: { punctuationAssist: false },
  });
  r.check("设置变更同步到模块状态", module.isEnabled() === false);

  module.setEnabled(true);
  listener({
    keys: ["dailyGoal"],
    previous: { dailyGoal: 3000, punctuationAssist: true },
    current: { dailyGoal: 4000, punctuationAssist: true },
  });
  r.check("无关设置变更不影响模块状态", module.isEnabled() === true);

  effects.dispose();
  r.check("模块清理后关闭状态", module.isEnabled() === false);
  r.check("模块清理后取消设置订阅", unsubscribeCount === 1);
  module.setEnabled(true);
  r.check("模块清理后不能被兼容桥重新唤醒", module.isEnabled() === false);

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/editorPunctuationModule.ts"),
    "utf8"
  );
  const punctuationSource = fs.readFileSync(
    path.join(H.ROOT, "src/punctuation.ts"),
    "utf8"
  );

  const activationMatch = mainSource.match(
    /activateModules\(\[([\s\S]*?)\]\)/
  );
  const activationList = activationMatch?.[1] ?? "";
  const instanceCount = (
    mainSource.match(/this\.punctuationModule = createPunctuationModule\(\);/g) ??
    []
  ).length;
  const activationCount = (
    activationList.match(/this\.punctuationModule\b/g) ?? []
  ).length;
  r.check(
    "主入口只保留一次模块实例",
    instanceCount === 1 && activationCount === 1
  );
  r.check(
    "主入口兼容桥委托模块",
    /setPunctuationAssist\(on: boolean\) \{\s*this\.punctuationModule\?\.setEnabled\(on\);\s*\}/.test(
      mainSource
    )
  );
  r.check(
    "主入口不再直接导入标点状态函数",
    !/from "\.\/punctuation"/.test(mainSource)
  );
  r.check(
    "模块自己读取并订阅设置",
    /settings\.get\(\)\.punctuationAssist/.test(moduleSource) &&
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
    "标点辅助不再使用模块级可变全局状态",
    !/let punctuationAssistActive/.test(punctuationSource)
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
