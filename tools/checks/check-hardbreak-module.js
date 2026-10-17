/**
 * 回车硬换行模块检查。
 *
 * 用假文档状态跑真实回车判定，并验证模块的设置订阅、动态启停与清理边界。
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
        selection: { main: { ...selection } },
      };
    },
    dispatch(spec) {
      if (spec.changes) {
        const { from, to, insert } = spec.changes;
        text = text.slice(0, from) + insert + text.slice(to);
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

  const emptyView = createView("第一段\n\n第三段", 4);
  r.check(
    "空行保留默认回车",
    handler(emptyView) === false && emptyView.text() === "第一段\n\n第三段"
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
    registeredExtension?.inner?.value?.[0] ?? null;
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
