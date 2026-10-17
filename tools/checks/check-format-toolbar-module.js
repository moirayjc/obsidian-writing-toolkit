/**
 * 编辑工具条模块检查。
 *
 * 编译真实 Feature Module，验证三种生效范围、设置热更新、编辑器扩展注册、
 * 批注回调透传、生命周期清理和 main.ts 边界。
 */
const fs = require("fs");
const path = require("path");

process.env.NODE_PATH = [
  path.resolve(__dirname, "..", "..", "node_modules"),
  process.env.NODE_PATH,
]
  .filter(Boolean)
  .join(path.delimiter);
require("module").Module._initPaths();

const H = require("./_harness");

const CODEMIRROR_EXTERNALS = ["@codemirror/state", "@codemirror/view"];

async function main() {
  const { EffectScope } = H.compile(
    "src/host/effectScope.ts",
    "format-toolbar-effect-scope"
  );
  const restoreObsidian = H.stubObsidian({
    TFile: class TFile {},
    TFolder: class TFolder {},
    editorInfoField: Symbol("editorInfoField"),
    setIcon() {},
  });

  let createFormatToolbarModule;
  try {
    ({ createFormatToolbarModule } = H.compile(
      "src/features/formatToolbarModule.ts",
      "format-toolbar-module",
      CODEMIRROR_EXTERNALS
    ));
  } finally {
    restoreObsidian();
  }

  const r = H.createReporter("编辑工具条 Feature Module");
  let currentSettings = {
    formatToolbarEnabled: true,
    formatToolbarScope: "all",
    commentsEnabled: true,
    commentBubbleEverywhere: true,
    sharedLibraryFolder: "写作/资料库",
    dailyGoal: 3000,
  };
  let listener = null;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  let refreshCount = 0;
  const extensions = [];
  const chapterPaths = new Set(["作品/正文/第1章.md"]);
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
  const project = {
    chapterPaths() {
      return chapterPaths;
    },
    projectRootForPath(path) {
      return path.startsWith("作品/") ? "作品" : null;
    },
  };
  const context = {
    services: {
      settings,
      project,
      editor: {
        refresh() {
          refreshCount++;
        },
      },
    },
    registrations: {
      registerEditorExtension(extension) {
        extensions.push(extension);
      },
    },
    effects: new EffectScope("format-toolbar-test"),
  };
  const comments = [];
  const module = createFormatToolbarModule({
    onAddComment(view) {
      comments.push(view);
    },
  });

  r.check("模块 id 稳定", module.id === "editor.format-toolbar");
  r.check(
    "启动前工具条与范围均保持关闭",
    module.isEnabled() === false && module.allowsPath("任意.md") === false
  );

  module.activate(context);
  r.check(
    "启动时读取设置并注册一次真实扩展",
    module.isEnabled() === true &&
      subscribeCount === 1 &&
      extensions.length === 1 &&
      Array.isArray(extensions[0]) &&
      extensions[0].length === 2
  );
  r.check("启动时不额外刷新编辑器", refreshCount === 0);

  r.check(
    "all 范围允许所有路径",
    module.allowsPath("作品/正文/第1章.md") &&
      module.allowsPath("任意.md") &&
      module.allowsPath(null) &&
      module.allowsPath(".obsidian/plugins/x/main.js")
  );

  const previousAll = currentSettings;
  currentSettings = { ...currentSettings, formatToolbarScope: "all-except-chapters" };
  listener({
    keys: ["formatToolbarScope"],
    previous: previousAll,
    current: currentSettings,
  });
  r.check(
    "正文排除范围只拒绝章节路径",
    !module.allowsPath("作品/正文/第1章.md") &&
      module.allowsPath("作品/资料/人设.md") &&
      module.allowsPath(null) &&
      module.allowsPath(".wt-outlines/镜像.md")
  );
  r.check("范围变化刷新一次编辑器", refreshCount === 1);

  const previousExcept = currentSettings;
  currentSettings = { ...currentSettings, formatToolbarScope: "library-only" };
  listener({
    keys: ["formatToolbarScope"],
    previous: previousExcept,
    current: currentSettings,
  });
  r.check(
    "资料库范围允许作品与共用资料库",
    module.allowsPath("作品/正文/第1章.md") &&
      module.allowsPath("写作/资料库/设定.md")
  );
  r.check(
    "资料库范围拒绝作品外与内部路径",
    !module.allowsPath("临时/笔记.md") &&
      !module.allowsPath(null) &&
      !module.allowsPath(".wt-outlines/镜像.md")
  );
  r.check("资料库范围变化再次刷新编辑器", refreshCount === 2);

  const previousLibrary = currentSettings;
  currentSettings = { ...currentSettings, commentsEnabled: false };
  listener({
    keys: ["commentsEnabled"],
    previous: previousLibrary,
    current: currentSettings,
  });
  r.check(
    "批注设置变化不重建格式工具条",
    refreshCount === 2
  );

  const previousDuplicate = currentSettings;
  currentSettings = { ...currentSettings, formatToolbarScope: "library-only" };
  listener({
    keys: ["formatToolbarScope"],
    previous: previousDuplicate,
    current: currentSettings,
  });
  r.check(
    "相同工具条签名的广播不重复刷新",
    refreshCount === 2
  );

  const previousEnabled = currentSettings;
  currentSettings = { ...currentSettings, formatToolbarEnabled: false };
  listener({
    keys: ["formatToolbarEnabled"],
    previous: previousEnabled,
    current: currentSettings,
  });
  r.check(
    "关闭工具条后即时生效并刷新一次",
    module.isEnabled() === false && refreshCount === 3
  );

  const previousUnrelated = currentSettings;
  currentSettings = { ...currentSettings, dailyGoal: 5000 };
  listener({
    keys: ["dailyGoal"],
    previous: previousUnrelated,
    current: currentSettings,
  });
  r.check(
    "无关设置变化不刷新编辑器",
    refreshCount === 3
  );

  context.effects.dispose();
  r.check(
    "模块清理后关闭范围判定与订阅",
    module.isEnabled() === false &&
      module.allowsPath("任意.md") === false &&
      unsubscribeCount === 1
  );

  listener({
    keys: ["formatToolbarEnabled", "formatToolbarScope"],
    previous: currentSettings,
    current: {
      ...currentSettings,
      formatToolbarEnabled: true,
      formatToolbarScope: "all",
    },
  });
  r.check(
    "模块清理后旧监听器不能重新启用或刷新",
    module.isEnabled() === false &&
      module.allowsPath("任意.md") === false &&
      refreshCount === 3
  );
  r.check(
    "批注回调只由气泡点击触发，启动阶段不误调用",
    comments.length === 0
  );

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/formatToolbarModule.ts"),
    "utf8"
  );
  const activationMatch = mainSource.match(
    /activateModules\(\[([\s\S]*?)\]\)/
  );
  const activationList = activationMatch?.[1] ?? "";
  const instanceCount = (
    mainSource.match(
      /this\.formatToolbarModule = createFormatToolbarModule\(\{/g
    ) ?? []
  ).length;
  const activationCount = (
    activationList.match(/this\.formatToolbarModule\b/g) ?? []
  ).length;

  r.check(
    "主入口只保留一次模块实例和一次激活",
    instanceCount === 1 && activationCount === 1
  );
  r.check(
    "主入口不再直接注册编辑工具条扩展",
    !/registerEditorExtension\(\s*buildFormatToolbar\(/.test(mainSource) &&
      !/import\s*\{[^}]*buildFormatToolbar/.test(mainSource)
  );
  r.check(
    "主入口批注入口与诊断复用模块范围判定",
    (mainSource.match(/this\.formatToolbarModule\.allowsPath\(path\)/g) ?? [])
      .length === 2
  );
  r.check(
    "主入口不再保留旧范围实现和签名字段",
    !/private formatToolbarAllowed\(/.test(mainSource) &&
      !/lastFormatToolbarSig/.test(mainSource)
  );
  r.check(
    "模块自己读取并订阅工具条设置",
    /settings\.get\(\)/.test(moduleSource) &&
      /settings\.subscribe\(/.test(moduleSource) &&
      /formatToolbarEnabled/.test(moduleSource) &&
      /formatToolbarScope/.test(moduleSource)
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
    "批注按钮通过回调透传当前 EditorView",
    /onAddComment: options\.onAddComment/.test(moduleSource)
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
