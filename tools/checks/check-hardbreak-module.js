/**
 * 回车硬换行模块检查。
 *
 * 用假文档状态跑真实回车判定，并验证模块的设置订阅、动态启停与清理边界。
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

function createView(initialText, initialFrom, initialTo = initialFrom, composing = false) {
  let text = initialText;
  let selection = {
    from: initialFrom,
    to: initialTo,
    head: initialTo,
  };
  const view = {
    composing,
    get state() {
      return {
        doc: createDoc(text),
        selection: {
          main: { ...selection },
          ranges: [{ ...selection, empty: selection.from === selection.to }],
        },
      };
    },
    dispatch(spec) {
      if (spec.changes) {
        const { from, to, insert } = spec.changes;
        text = text.slice(0, from) + (insert ?? "") + text.slice(to);
      }
      if (spec.selection) {
        selection = {
          from: spec.selection.anchor,
          to: spec.selection.head ?? spec.selection.anchor,
          head: spec.selection.head ?? spec.selection.anchor,
        };
      }
    },
    text() {
      return text;
    },
    selection() {
      return selection;
    },
  };
  return view;
}

function main() {
  const hardBreak = H.compile("src/hardBreak.ts", "hard-break");
  const { EffectScope } = H.compile("src/host/effectScope.ts", "hard-break-scope");
  const { createHardBreakModule } = H.compile(
    "src/features/editorHardBreakModule.ts",
    "hard-break-module"
  );
  const r = H.createReporter("回车硬换行 Feature Module");

  let active = false;
  const handler = hardBreak.createHardBreakInputHandler(() => active);

  const disabledView = createView("正文", 2);
  r.check(
    "关闭时回车处理器不接管",
    handler(disabledView) === false && disabledView.text() === "正文"
  );

  active = true;
  const composingView = createView("正文", 2, 2, true);
  r.check(
    "输入法组合期间不接管",
    handler(composingView) === false && composingView.text() === "正文"
  );

  const normalView = createView("第一段", 3);
  r.check(
    "普通正文回车插入段落分隔",
    handler(normalView) === true &&
      normalView.text() === "第一段\n\n" &&
      normalView.selection().from === 5
  );

  const selectedView = createView("前后", 1, 2);
  r.check(
    "有选区时用段落分隔替换选区",
    handler(selectedView) === true &&
      selectedView.text() === "前\n\n" &&
      selectedView.selection().from === 3
  );

  // 「|」标光标：回车后段与段之间永远正好一个空行
  const enter = (marked) => {
    const cursor = marked.indexOf("|");
    const view = createView(marked.replace("|", ""), cursor);
    const handled = handler(view);
    const text = view.text();
    const at = view.selection().from;
    return handled ? text.slice(0, at) + "|" + text.slice(at) : null;
  };
  const spacingCases = [
    ["行尾、下方隔着空行：开新段落", "甲|\n\n乙", "甲\n\n|\n\n乙"],
    ["行尾、下方紧贴一段：新段落上下各一个空行", "甲|\n乙", "甲\n\n|\n\n乙"],
    ["全文末尾：只在上方隔一个空行", "甲|", "甲\n\n|"],
    ["行中间：拆成两段，中间一个空行", "甲|乙", "甲\n\n|乙"],
    ["行首、上方紧贴一段：只补一个空行拆开", "甲\n|乙", "甲\n\n|乙"],
    ["行首、上方隔着空行：在上面开新段落", "甲\n\n|乙", "甲\n\n|\n\n乙"],
    ["段间空行上回车：新段落上下各一个空行", "甲\n|\n乙", "甲\n\n|\n\n乙"],
    ["已在隔好空行的空段落里：不再叠加空行", "甲\n\n|\n\n乙", "甲\n\n|\n\n乙"],
    ["紧贴在一段下面的空行：补成一个空行", "甲\n|", "甲\n\n|"],
  ];
  for (const [name, input, expected] of spacingCases) {
    const actual = enter(input);
    r.check(name, actual === expected, JSON.stringify(actual));
  }

  // 回车开出的空段落反悔：退格一次回到上一段行尾
  const backspace = (marked) => {
    const cursor = marked.indexOf("|");
    const view = createView(marked.replace("|", ""), cursor);
    const handled = hardBreak.applyHardBreakBackspace(view);
    const text = view.text();
    const at = view.selection().from;
    return handled ? text.slice(0, at) + "|" + text.slice(at) : null;
  };
  const backspaceCases = [
    ["退格撤掉段间新开的空段落，段间仍一个空行", "甲\n\n|\n\n乙", "甲|\n\n乙"],
    ["退格撤掉文末新开的空段落", "甲\n\n|", "甲|"],
    ["下方紧贴文字时退格后补回一个空行", "甲\n\n|\n乙", "甲|\n\n乙"],
    ["紧贴文字下面的空行：走默认退格", "甲\n|", null],
    ["行内退格：走默认退格", "甲乙|", null],
    ["上方连着多个空行：走默认退格", "甲\n\n\n|", null],
    ["段首退格一次合并到上一段末尾", "甲\n\n|乙\n\n丙", "甲|乙\n\n丙"],
    ["段首退格：上一段是标题时走默认", "# 标题\n\n|乙", null],
    ["段首退格：本行是列表时走默认", "甲\n\n|- 乙", null],
    ["段首退格：上方紧贴文字时走默认", "甲\n|乙", null],
  ];
  for (const [name, input, expected] of backspaceCases) {
    const actual = backspace(input);
    r.check(name, actual === expected, JSON.stringify(actual));
  }
  const forwardDelete = (marked) => {
    const cursor = marked.indexOf("|");
    const view = createView(marked.replace("|", ""), cursor);
    const handled = hardBreak.applyHardBreakDelete(view);
    const text = view.text();
    const at = view.selection().from;
    return handled ? text.slice(0, at) + "|" + text.slice(at) : null;
  };
  const deleteCases = [
    ["段尾向前删除一次把下一段接上来", "甲|\n\n乙", "甲|乙"],
    ["段尾向前删除：下一段是列表时走默认", "甲|\n\n- 乙", null],
    ["段尾向前删除：下方紧贴文字时走默认", "甲|\n乙", null],
    ["行中间向前删除走默认", "甲|乙", null],
  ];
  for (const [name, input, expected] of deleteCases) {
    const actual = forwardDelete(input);
    r.check(name, actual === expected, JSON.stringify(actual));
  }

  // 粘贴整理（纯函数）
  const pasteCases = [
    ["粘贴：紧贴的正文行之间补一个空行", "甲\n乙\n丙", "甲\n\n乙\n\n丙"],
    ["粘贴：正文之间的多个空行收成一个", "甲\n\n\n\n乙", "甲\n\n乙"],
    ["粘贴：网页小说段首的全角空格去掉并分段", "　　甲\n　　乙", "甲\n\n乙"],
    ["粘贴：段首不换行空格也去掉", "\u00a0\u00a0\u00a0\u00a0甲\n\u00a0\u00a0乙", "甲\n\n乙"],
    ["粘贴：单行段落的段首全角空格去掉", "　　甲乙", "甲乙"],
    ["粘贴：句中的全角空格保留", "甲　乙\n丙", "甲　乙\n\n丙"],
    ["粘贴：列表原样保留", "说明\n- 一\n- 二\n\n\n- 三", "说明\n- 一\n- 二\n\n\n- 三"],
    ["粘贴：表格原样保留", "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |", "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |"],
    ["粘贴：代码块内部不动", "甲\n```\n一\n二\n```\n乙", "甲\n```\n一\n二\n```\n乙"],
    ["粘贴：标题和下面的正文保持原样", "# 第一章\n正文", "# 第一章\n正文"],
    ["粘贴：列表续行不当正文", "- 一\n  续一\n  续二", "- 一\n  续一\n  续二"],
    ["粘贴：单行不动", "甲乙", "甲乙"],
    ["粘贴：首尾空行不动", "\n\n甲\n乙\n\n", "\n\n甲\n\n乙\n\n"],
  ];
  for (const [name, input, expected] of pasteCases) {
    const actual = hardBreak.normalizePastedParagraphs(input);
    r.check(name, actual === expected, JSON.stringify(actual));
  }

  // 真实 CodeMirror 事务：删除选区 / 粘贴后的整理与原事务合成一次
  const { EditorState } = require("@codemirror/state");
  const runtime = H.compile("src/hardBreak.ts", "hard-break-runtime", [
    "@codemirror/state",
    "@codemirror/view",
  ]);
  let filterActive = true;
  const extensions = runtime.buildHardBreakExtensions(() => filterActive);
  const apply = (doc, selection, spec) => {
    const state = EditorState.create({ doc, selection, extensions });
    const tr = state.update(spec);
    return { text: tr.state.doc.toString(), head: tr.state.selection.main.head };
  };
  const cutLine = apply("甲\n\n乙\n\n丙", { anchor: 3, head: 5 }, {
    changes: { from: 3, to: 5 },
    userEvent: "delete.cut",
  });
  r.check(
    "剪切整段（含换行）后段间收回一个空行，光标在上一段末尾",
    cutLine.text === "甲\n\n丙" && cutLine.head === 1,
    JSON.stringify(cutLine)
  );
  const deleteText = apply("甲\n\n乙\n\n丙", { anchor: 3, head: 4 }, {
    changes: { from: 3, to: 4 },
    userEvent: "delete.backward",
  });
  r.check(
    "选中一段文字删掉后段间收回一个空行",
    deleteText.text === "甲\n\n丙" && deleteText.head === 1,
    JSON.stringify(deleteText)
  );
  const deleteNearList = apply("- 一\n\n乙\n\n丙", { anchor: 5, head: 6 }, {
    changes: { from: 5, to: 6 },
    userEvent: "delete.backward",
  });
  r.check("列表旁边删除选区不动空行", deleteNearList.text === "- 一\n\n\n\n丙");
  const typedOver = apply("甲\n\n乙\n\n丙", { anchor: 3, head: 4 }, {
    changes: { from: 3, to: 4 },
    userEvent: "input.type",
  });
  r.check("输入替换选区不整理空行", typedOver.text === "甲\n\n\n\n丙");
  const pasted = apply("", { anchor: 0 }, {
    changes: { from: 0, insert: "甲\n乙\n\n\n丙" },
    userEvent: "input.paste",
  });
  r.check(
    "粘贴后段间统一一个空行，光标在粘贴内容末尾",
    pasted.text === "甲\n\n乙\n\n丙" && pasted.head === 7,
    JSON.stringify(pasted)
  );
  const pastedInList = apply("- ", { anchor: 2 }, {
    changes: { from: 2, insert: "甲\n乙" },
    userEvent: "input.paste",
  });
  r.check("粘贴到列表行里不整理", pastedInList.text === "- 甲\n乙");
  filterActive = false;
  const pastedInactive = apply("", { anchor: 0 }, {
    changes: { from: 0, insert: "甲\n乙" },
    userEvent: "input.paste",
  });
  r.check("硬换行关闭时粘贴不整理", pastedInactive.text === "甲\n乙");

  const fenceBackspace = "```\n甲\n\n\n```";
  r.check(
    "代码块内退格走默认",
    hardBreak.applyHardBreakBackspace(createView(fenceBackspace, 7)) === false
  );

  const blockCases = [
    ["> 引用", 4],
    ["- 列表", 4],
    ["1. 列表", 5],
    ["## 标题", 5],
    ["```", 3],
    ["| 甲 | 乙 |", 7],
  ];
  let blockCasesPassed = true;
  for (const [text, cursor] of blockCases) {
    const view = createView(text, cursor);
    if (handler(view) !== false || view.text() !== text) {
      blockCasesPassed = false;
      break;
    }
  }
  r.check("块级语法行保留默认回车", blockCasesPassed);

  const fencedText = "前文\n```\n代码\n```\n后文";
  const insideFence = createView(fencedText, 8);
  r.check(
    "围栏代码块内保留默认回车",
    handler(insideFence) === false && insideFence.text() === fencedText
  );
  const afterFence = createView(fencedText, fencedText.length);
  r.check(
    "围栏代码块结束后恢复硬换行",
    handler(afterFence) === true &&
      afterFence.text().endsWith("后文\n\n")
  );
  const frontmatterText = "---\nwt-status: draft\n---\n正文";
  const insideFrontmatter = createView(frontmatterText, 10);
  r.check(
    "frontmatter 内保留默认回车",
    handler(insideFrontmatter) === false &&
      insideFrontmatter.text() === frontmatterText
  );
  const afterFrontmatter = createView(frontmatterText, frontmatterText.length);
  r.check(
    "frontmatter 之后恢复硬换行",
    handler(afterFrontmatter) === true &&
      afterFrontmatter.text().endsWith("正文\n\n")
  );
  const nestedFenceCases = [
    "````\n```\n代码\n````\n后文",
    "~~~\n```\n代码\n~~~\n后文",
  ];
  let nestedFencesPassed = true;
  for (const text of nestedFenceCases) {
    const view = createView(text, text.indexOf("代码") + 1);
    if (handler(view) !== false || view.text() !== text) {
      nestedFencesPassed = false;
      break;
    }
  }
  r.check("更长或不同字符的围栏不会提前关闭", nestedFencesPassed);

  const module = createHardBreakModule();
  const effects = new EffectScope("hard-break-test");
  let unsubscribeCount = 0;
  let listener = null;
  let registeredExtension = null;
  let currentEnabled = false;
  const settings = {
    get() {
      return { hardBreakOnEnter: currentEnabled };
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

  r.check("模块 id 稳定", module.id === "editor.hard-break");
  r.check("启动前模块保持关闭", module.isEnabled() === false);
  module.setEnabled(true);
  r.check("启动前不能绕过生命周期启用", module.isEnabled() === false);

  module.activate(context);
  r.check("启动后读取初始设置（关闭）", module.isEnabled() === false);
  r.check("启动后注册编辑器扩展", registeredExtension !== null);
  r.check("启动后订阅设置变更", typeof listener === "function");
  const registeredKeyBinding =
    (Array.isArray(registeredExtension)
      ? registeredExtension[0]
      : registeredExtension
    )?.inner?.value?.[0] ?? null;
  const runRegisteredEnter = registeredKeyBinding?.run;
  r.check(
    "模块注册的是裸 Enter 键位",
    registeredKeyBinding?.key === "Enter" &&
      typeof runRegisteredEnter === "function"
  );
  const registeredOffView = createView("第一段", 3);
  r.check(
    "模块注册的扩展遵循初始关闭设置",
    runRegisteredEnter(registeredOffView) === false &&
      registeredOffView.text() === "第一段"
  );

  module.setEnabled(true);
  r.check("兼容桥可即时启停模块", module.isEnabled() === true);
  const registeredOnView = createView("第一段", 3);
  r.check(
    "模块注册的扩展接入兼容启停",
    runRegisteredEnter(registeredOnView) === true &&
      registeredOnView.text() === "第一段\n\n"
  );

  currentEnabled = false;
  listener({
    keys: ["hardBreakOnEnter"],
    previous: { hardBreakOnEnter: true },
    current: { hardBreakOnEnter: false },
  });
  r.check("设置变更同步到模块状态", module.isEnabled() === false);
  const registeredAfterSetting = createView("第一段", 3);
  r.check(
    "模块注册的扩展跟随设置变更",
    runRegisteredEnter(registeredAfterSetting) === false &&
      registeredAfterSetting.text() === "第一段"
  );

  module.setEnabled(true);
  listener({
    keys: ["dailyGoal"],
    previous: { dailyGoal: 3000, hardBreakOnEnter: true },
    current: { dailyGoal: 4000, hardBreakOnEnter: true },
  });
  r.check("无关设置变更不影响模块状态", module.isEnabled() === true);

  effects.dispose();
  r.check("模块清理后关闭状态", module.isEnabled() === false);
  r.check("模块清理后取消设置订阅", unsubscribeCount === 1);
  const registeredAfterDispose = createView("第一段", 3);
  r.check(
    "模块清理后注册扩展保持惰性",
    runRegisteredEnter(registeredAfterDispose) === false &&
      registeredAfterDispose.text() === "第一段"
  );
  module.setEnabled(true);
  r.check("模块清理后不能被兼容桥重新唤醒", module.isEnabled() === false);

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/editorHardBreakModule.ts"),
    "utf8"
  );
  const hardBreakSource = fs.readFileSync(
    path.join(H.ROOT, "src/hardBreak.ts"),
    "utf8"
  );
  const settingsSource = fs.readFileSync(
    path.join(H.ROOT, "src/settings.ts"),
    "utf8"
  );
  const activationMatch = mainSource.match(
    /activateModules\(\[([\s\S]*?)\]\)/
  );
  const activationList = activationMatch?.[1] ?? "";
  const instanceCount = (
    mainSource.match(/this\.hardBreakModule = createHardBreakModule\(\);/g) ?? []
  ).length;
  const activationCount = (
    activationList.match(/this\.hardBreakModule\b/g) ?? []
  ).length;

  r.check(
    "主入口只保留一次模块实例",
    instanceCount === 1 && activationCount === 1
  );
  r.check(
    "主入口兼容桥委托模块",
    /setHardBreakOnEnter\(on: boolean\) \{\s*this\.hardBreakModule\?\.setEnabled\(on\);\s*\}/.test(
      mainSource
    )
  );
  r.check(
    "主入口不再直接导入硬换行状态函数",
    !/from "\.\/hardBreak"/.test(mainSource)
  );
  r.check(
    "模块自己读取并订阅设置",
    /settings\.get\(\)\.hardBreakOnEnter/.test(moduleSource) &&
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
    "硬换行不再使用模块级可变全局状态",
    !/let hardBreakOnEnter/.test(hardBreakSource)
  );
  r.check(
    "设置页保留硬换行开关并委托模块",
    /setName\("回车即新段落"\)/.test(settingsSource) &&
      /setValue\(this\.wt\.settings\.hardBreakOnEnter\)/.test(settingsSource) &&
      /this\.wt\.setHardBreakOnEnter\(value\)/.test(settingsSource)
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
