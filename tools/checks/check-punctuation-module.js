/**
 * 中文标点辅助模块检查。
 *
 * 用真实输入变换和模块生命周期验证括号配对、设置订阅、动态启停与清理，
 * 再守住 main.ts 只保留兼容桥，不重新接管模块状态。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function createView(initialText, initialSelection) {
  let text = initialText;
  let selection = { ...initialSelection };
  return {
    state: {
      sliceDoc(from, to) {
        return text.slice(from, to);
      },
    },
    dispatch(spec) {
      if (spec.changes) {
        const { from, to, insert } = spec.changes;
        text = text.slice(0, from) + insert + text.slice(to);
      }
      if (spec.selection) selection = { ...spec.selection };
    },
    text() {
      return text;
    },
    selection() {
      return selection;
    },
  };
}

function main() {
  const punctuation = H.compile("src/punctuation.ts", "punctuation");
  const { EffectScope } = H.compile("src/host/effectScope.ts", "punctuation-scope");
  const { createPunctuationModule } = H.compile(
    "src/features/editorPunctuationModule.ts",
    "punctuation-module"
  );
  const r = H.createReporter("中文标点辅助 Feature Module");

  let active = false;
  const handler = punctuation.createPunctuationInputHandler(() => active);

  const disabledView = createView("", { anchor: 0, head: 0 });
  r.check(
    "关闭时输入处理器不接管",
    handler(disabledView, 0, 0, "“") === false &&
      disabledView.text() === ""
  );

  active = true;
  const multiView = createView("", { anchor: 0, head: 0 });
  r.check(
    "多字符输入不接管",
    handler(multiView, 0, 0, "“”") === false &&
      multiView.text() === ""
  );

  const pairView = createView("", { anchor: 0, head: 0 });
  r.check(
    "空光标输入左括号自动补右括号",
    handler(pairView, 0, 0, "“") === true &&
      pairView.text() === "“”" &&
      pairView.selection().anchor === 1
  );

  const wrapView = createView("雪夜", { anchor: 0, head: 2 });
  r.check(
    "有选区时包裹并保持正文选中",
    handler(wrapView, 0, 2, "《") === true &&
      wrapView.text() === "《雪夜》" &&
      wrapView.selection().anchor === 1 &&
      wrapView.selection().head === 3
  );

  const skipCloseView = createView("（）", { anchor: 1, head: 1 });
  r.check(
    "输入已存在的右括号时只移动光标",
    handler(skipCloseView, 1, 1, "）") === true &&
      skipCloseView.text() === "（）" &&
      skipCloseView.selection().anchor === 2
  );

  const loneCloseView = createView("", { anchor: 0, head: 0 });
  r.check(
    "没有相邻右括号时不接管右括号输入",
    handler(loneCloseView, 0, 0, "）") === false &&
      loneCloseView.text() === ""
  );

  const skipOpenView = createView("”", { anchor: 0, head: 0 });
  r.check(
    "光标后已有右括号时不重复补全",
    handler(skipOpenView, 0, 0, "“") === true &&
      skipOpenView.text() === "”" &&
      skipOpenView.selection().anchor === 1
  );

  const plainView = createView("", { anchor: 0, head: 0 });
  r.check(
    "普通文字输入不接管",
    handler(plainView, 0, 0, "雪") === false &&
      plainView.text() === ""
  );

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
