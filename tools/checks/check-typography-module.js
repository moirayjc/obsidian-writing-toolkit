/**
 * 排版与主题模块检查。
 *
 * 编译真实 Typography / Theme Snippet 实现和 Feature Module，用假 DOM、设置
 * Service 与 Vault Adapter 验证首帧缓存、六项设置、片段同步、动态更新和清理。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function createBody() {
  const classes = new Set();
  const props = {};
  let propWrites = 0;
  return {
    classes,
    props,
    get propWrites() {
      return propWrites;
    },
    setCssProps(values) {
      propWrites++;
      Object.assign(props, values);
    },
    toggleClass(name, enabled) {
      if (enabled) classes.add(name);
      else classes.delete(name);
    },
    removeClass(name) {
      classes.delete(name);
    },
  };
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const typography = H.compile("src/typography.ts", "typography-runtime");
  const snippets = H.compile("src/themeSnippet.ts", "theme-snippet");
  const { EffectScope } = H.compile(
    "src/host/effectScope.ts",
    "typography-effect-scope"
  );
  const { createTypographyModule } = H.compile(
    "src/features/typographyModule.ts",
    "typography-module"
  );
  const r = H.createReporter("排版与主题 Feature Module");

  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalWindowPresent = Object.prototype.hasOwnProperty.call(
    global,
    "window"
  );
  const originalDocumentPresent = Object.prototype.hasOwnProperty.call(
    global,
    "document"
  );

  const storage = new Map();
  let storageWrites = 0;
  const body = createBody();
  global.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storageWrites++;
        storage.set(key, String(value));
      },
    },
  };
  global.document = { body };

  try {
    r.check(
      "暖纸片段只含生成标记，不覆盖默认样式",
      snippets
        .buildThemeSnippet("warm")
        .startsWith("/* 由 Writing Toolkit 自动生成") &&
        !snippets.buildThemeSnippet("warm").includes("--wt-paper")
    );
    r.check(
      "冷淡片段包含令牌与背景覆盖",
      snippets.buildThemeSnippet("cool").includes("--wt-paper") &&
        snippets.buildThemeSnippet("cool").includes("background")
    );
    r.check(
      "片段声明统一提升为 important",
      snippets
        .buildThemeSnippet("contrast")
        .includes("--wt-paper: #ffffff !important;") &&
        snippets
          .buildThemeSnippet("contrast")
          .includes("background: var(--wt-paper) !important;")
    );

    let currentSettings = {
      themeTone: "cool",
      lineHeight: 1.9,
      paragraphSpacing: 0.6,
      letterPaperMode: true,
      paragraphIndent: true,
      headingStyle: true,
      dailyGoal: 3000,
    };
    let listener = null;
    let subscribeCount = 0;
    let unsubscribeCount = 0;
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

    const snippetFiles = new Map();
    const snippetDirs = [];
    const enabledStatuses = [];
    let snippetDirExists = false;
    const app = {
      vault: {
        configDir: ".obsidian",
        adapter: {
          async exists(path) {
            if (path === ".obsidian/snippets") return snippetDirExists;
            return snippetFiles.has(path);
          },
          async mkdir(path) {
            snippetDirs.push(path);
            if (path === ".obsidian/snippets") snippetDirExists = true;
          },
          async read(path) {
            return snippetFiles.get(path);
          },
          async write(path, content) {
            snippetFiles.set(path, content);
          },
        },
      },
      customCss: {
        setCssEnabledStatus(name, enabled) {
          enabledStatuses.push([name, enabled]);
        },
      },
    };

    const effects = new EffectScope("typography-test");
    const context = {
      app,
      services: { settings },
      effects,
    };
    const module = createTypographyModule();

    r.check("模块 id 稳定", module.id === "appearance.typography");

    storage.set("wt-theme-tone-cache", "contrast");
    module.applyCachedThemeTone();
    r.check(
      "设置加载前同步套用缓存主题",
      body.classes.has("wt-theme-contrast") &&
        !body.classes.has("wt-theme-cool")
    );

    body.classes.clear();
    typography.removeTypography();
    module.activate(context);
    await flushAsync();

    r.check("启动时订阅一次设置", subscribeCount === 1);
    r.check(
      "启动时应用六项排版设置",
      body.props["--wt-line-height"] === "1.9" &&
        body.props["--wt-paragraph-spacing"] === "0.6em" &&
        body.classes.has("wt-letter-paper") &&
        body.classes.has("wt-indent") &&
        body.classes.has("wt-heading-style") &&
        body.classes.has("wt-theme-cool") &&
        !body.classes.has("wt-theme-contrast")
    );
    r.check(
      "启动时缓存当前主题",
      storage.get("wt-theme-tone-cache") === "cool"
    );
    r.check(
      "启动时创建 snippets 目录并写入主题片段",
      snippetDirs.includes(".obsidian/snippets") &&
        snippetFiles
          .get(".obsidian/snippets/wt-theme-tone.css")
          ?.includes("--wt-paper")
    );
    r.check(
      "冷淡主题启用自动生成的 CSS 片段",
      enabledStatuses.at(-1)?.[0] === "wt-theme-tone" &&
        enabledStatuses.at(-1)?.[1] === true
    );

    const writesBeforeUnrelated = storageWrites;
    const propsBeforeUnrelated = body.propWrites;
    listener({
      keys: ["dailyGoal"],
      previous: currentSettings,
      current: { ...currentSettings, dailyGoal: 4000 },
    });
    r.check(
      "无关设置变更不重写排版或主题缓存",
      storageWrites === writesBeforeUnrelated &&
        body.propWrites === propsBeforeUnrelated
    );

    const previousSettings = currentSettings;
    currentSettings = {
      ...currentSettings,
      themeTone: "contrast",
      lineHeight: 2.2,
      paragraphSpacing: 0.8,
      letterPaperMode: false,
      paragraphIndent: false,
      headingStyle: false,
    };
    listener({
      keys: [
        "themeTone",
        "lineHeight",
        "paragraphSpacing",
        "letterPaperMode",
        "paragraphIndent",
        "headingStyle",
      ],
      previous: previousSettings,
      current: currentSettings,
    });
    await flushAsync();

    r.check(
      "排版设置变化即时更新 CSS 变量与 body 类",
      body.props["--wt-line-height"] === "2.2" &&
        body.props["--wt-paragraph-spacing"] === "0.8em" &&
        !body.classes.has("wt-letter-paper") &&
        !body.classes.has("wt-indent") &&
        !body.classes.has("wt-heading-style") &&
        body.classes.has("wt-theme-contrast") &&
        !body.classes.has("wt-theme-cool")
    );
    r.check(
      "主题变化更新 localStorage 缓存",
      storage.get("wt-theme-tone-cache") === "contrast"
    );
    r.check(
      "主题变化重写片段并保持启用",
      snippetFiles
        .get(".obsidian/snippets/wt-theme-tone.css")
        ?.includes("配色：contrast") &&
        enabledStatuses.at(-1)?.[1] === true
    );

    const writesBeforeWarm = storageWrites;
    currentSettings = { ...currentSettings, themeTone: "warm" };
    listener({
      keys: ["themeTone"],
      previous: { ...currentSettings, themeTone: "contrast" },
      current: currentSettings,
    });
    await flushAsync();
    r.check(
      "切回暖纸时保留排版并关闭主题片段",
      storageWrites > writesBeforeWarm &&
        body.props["--wt-line-height"] === "2.2" &&
        body.classes.has("wt-theme-contrast") === false &&
        body.classes.has("wt-theme-cool") === false &&
        enabledStatuses.at(-1)?.[1] === false
    );

    const writesBeforeDispose = storageWrites;
    effects.dispose();
    r.check(
      "模块清理时取消订阅并移除全部排版类",
      unsubscribeCount === 1 &&
        body.props["--wt-line-height"] === "" &&
        body.props["--wt-paragraph-spacing"] === "" &&
        !body.classes.has("wt-letter-paper") &&
        !body.classes.has("wt-indent") &&
        !body.classes.has("wt-heading-style") &&
        !body.classes.has("wt-theme-cool") &&
        !body.classes.has("wt-theme-contrast")
    );

    listener({
      keys: ["themeTone", "lineHeight"],
      previous: currentSettings,
      current: { ...currentSettings, themeTone: "cool", lineHeight: 2.4 },
    });
    r.check(
      "模块清理后旧监听器不能重新应用样式",
      storageWrites === writesBeforeDispose &&
        body.props["--wt-line-height"] === ""
    );

    const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
    const moduleSource = fs.readFileSync(
      path.join(H.ROOT, "src/features/typographyModule.ts"),
      "utf8"
    );
    const activationMatch = mainSource.match(
      /activateModules\(\[([\s\S]*?)\]\)/
    );
    const activationList = activationMatch?.[1] ?? "";
    const instanceCount = (
      mainSource.match(/this\.typographyModule = createTypographyModule\(\);/g) ??
      []
    ).length;
    const activationCount = (
      activationList.match(/this\.typographyModule\b/g) ?? []
    ).length;

    r.check(
      "主入口只保留一次模块实例和一次激活",
      instanceCount === 1 && activationCount === 1
    );
    r.check(
      "首帧预热仍在第一个 await 之前",
      mainSource.indexOf("this.typographyModule.applyCachedThemeTone()") >=
        0 &&
        mainSource.indexOf("this.typographyModule.applyCachedThemeTone()") <
          mainSource.indexOf("await this.loadPluginData()")
    );
    r.check(
      "主入口不再直接导入排版和主题片段实现",
      !/from "\.\/typography"/.test(mainSource) &&
        !/from "\.\/themeSnippet"/.test(mainSource)
    );
    r.check(
      "主入口保存与卸载入口不再直接应用或移除排版",
      !/injectTypography\(|removeTypography\(|syncThemeSnippet\(/.test(
        mainSource
      )
    );
    r.check(
      "模块自己读取并订阅六项排版设置",
      /settings\.get\(\)/.test(moduleSource) &&
        /settings\.subscribe\(/.test(moduleSource) &&
        [
          "themeTone",
          "lineHeight",
          "paragraphSpacing",
          "letterPaperMode",
          "paragraphIndent",
          "headingStyle",
        ].every((key) => moduleSource.includes(`"${key}"`))
    );
    const css = fs.readFileSync(path.join(H.ROOT, "styles.css"), "utf8");
    r.check(
      "信纸横线在段间空行上也画线（作者刻意如此，不要排除空行）",
      !/body\.wt-letter-paper[^{]*:(empty|has)/.test(css)
    );
    r.check(
      "段首缩进在阅读视图也生效，只作用于正文顶层段落",
      /body\.wt-indent \.markdown-preview-view \.markdown-preview-sizer > div > p[^{]*\{\s*text-indent: 2em;/.test(css)
    );
    r.check(
      "模块不反向依赖 main.ts",
      !/from "\.\.\/main"/.test(moduleSource)
    );
  } finally {
    if (originalWindowPresent) global.window = originalWindow;
    else delete global.window;
    if (originalDocumentPresent) global.document = originalDocument;
    else delete global.document;
  }

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
