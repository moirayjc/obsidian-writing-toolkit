/**
 * 批注 Feature Module 检查。
 *
 * 用注入的存储、面板、编辑器扩展和弹窗验证：批注数据、缓存、文件事件、
 * 编辑器痕迹、侧栏插槽与管理操作都由模块持有，主入口和侧栏只保留窄端口。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

async function main() {
  class TFile {
    constructor(filePath) {
      this.path = filePath;
      this.name = filePath.split("/").pop() || filePath;
      this.basename = this.name.replace(/\.[^.]+$/, "");
      this.extension = this.name.includes(".")
        ? this.name.split(".").pop()
        : "";
      this.stat = { size: 128, mtime: 1 };
    }
  }

  class TFolder {
    constructor(folderPath) {
      this.path = folderPath;
      this.name = folderPath.split("/").pop() || folderPath;
    }
  }

  class MarkdownView {
    constructor() {
      this.file = null;
      this.editor = null;
      this.leaf = null;
    }
  }

  class Notice {
    constructor() {}
    hide() {}
  }

  class Modal {
    constructor() {}
    open() {}
    close() {}
  }

  const restoreObsidian = H.stubObsidian({
    Modal,
    Notice,
    TFile,
    TFolder,
    MarkdownView,
    editorInfoField: {},
    setIcon() {},
  });
  let createCommentsModule;
  try {
    ({ createCommentsModule } = H.compile(
      "src/features/commentsModule.ts",
      "comments-module",
      ["electron"]
    ));
  } finally {
    restoreObsidian();
  }

  const { EffectScope } = H.compile(
    "src/host/effectScope.ts",
    "comments-module-scope"
  );
  const r = H.createReporter("批注 Feature Module");

  const chapterFile = new TFile("正文/第一章.md");
  const secondChapter = new TFile("正文/第二章.md");
  const sidecarFile = new TFile(".wt-comments/正文/第一章.批注.md");
  const folder = new TFolder("正文");
  const files = new Map([
    [chapterFile.path, chapterFile],
    [secondChapter.path, secondChapter],
    [sidecarFile.path, sidecarFile],
    [folder.path, folder],
  ]);
  const docText = "第一段正文。\n\n第二段正文。";
  const fakeEditor = {
    getValue() {
      return docText;
    },
  };
  const leaf = {
    view: null,
    getRoot() {
      return null;
    },
  };
  const markdownView = new MarkdownView();
  markdownView.file = chapterFile;
  markdownView.editor = fakeEditor;
  markdownView.leaf = leaf;
  leaf.view = markdownView;

  const renameCalls = [];
  const app = {
    vault: {
      getAbstractFileByPath(target) {
        return files.get(target) ?? null;
      },
      async cachedRead(file) {
        return file === chapterFile ? docText : "";
      },
      async rename(file, target) {
        const oldPath = file.path;
        files.delete(oldPath);
        file.path = target;
        files.set(target, file);
        renameCalls.push({ oldPath, newPath: target });
      },
    },
    workspace: {
      getActiveFile() {
        return chapterFile;
      },
      getActiveViewOfType(type) {
        return type === MarkdownView ? markdownView : null;
      },
    },
  };

  const settings = {
    commentsEnabled: true,
    commentBubbleEverywhere: false,
  };
  let settingsListener = null;
  let settingsUnsubscriptions = 0;
  const calls = {
    panelFactory: 0,
    panelRefreshes: 0,
    panelReveals: [],
    panelDestroy: 0,
    registrations: 0,
    unregistrations: 0,
    extensionRegistrations: 0,
    workspaceEvents: 0,
    vaultEvents: 0,
    settingsSubscriptions: 0,
    openSidebar: 0,
    shellChanges: 0,
    decorRefreshes: 0,
    revealCalls: 0,
    menuItems: 0,
    menuClicks: 0,
    drafts: 0,
    confirms: 0,
    prefixInvalidations: 0,
    storeInvalidations: [],
    maxParallelSaves: 0,
    folderMigrations: [],
  };
  let panelFactory = null;
  let panelHost = null;
  let panelHandle = null;
  let extensionConfig = null;
  let lastDraft = null;
  let lastConfirm = null;
  let savesInFlight = 0;
  const workspaceHandlers = new Map();
  const vaultHandlers = new Map();
  const cached = new Map();
  const disk = new Map();
  const clone = (items) => items.map((item) => ({ ...item }));

  const store = {
    getCached(docPath) {
      return cached.get(docPath);
    },
    async reload(docPath) {
      cached.delete(docPath);
      return this.load(docPath);
    },
    async load(docPath) {
      if (cached.has(docPath)) return cached.get(docPath);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const items = clone(disk.get(docPath) ?? []);
      cached.set(docPath, items);
      return items;
    },
    ensureLoaded(docPath) {
      void this.load(docPath);
    },
    invalidate(docPath) {
      cached.delete(docPath);
      calls.storeInvalidations.push(docPath);
    },
    invalidatePrefix(prefix) {
      calls.prefixInvalidations++;
      for (const key of [...cached.keys()]) {
        if (key === prefix || key.startsWith(prefix + "/")) cached.delete(key);
      }
    },
    async save(docPath, comments) {
      savesInFlight++;
      calls.maxParallelSaves = Math.max(calls.maxParallelSaves, savesInFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      disk.set(docPath, clone(comments));
      cached.set(docPath, clone(comments));
      savesInFlight--;
    },
    handleModified(target) {
      if (!target.endsWith(".批注.md")) return null;
      const rel = target.startsWith(".wt-comments/")
        ? target.slice(".wt-comments/".length)
        : target;
      const docPath = rel.replace(/\.批注\.md$/, ".md");
      this.invalidate(docPath);
      return docPath;
    },
    handleDeleted(target) {
      return this.handleModified(target);
    },
    handleRenamed(oldPath, newPath) {
      const docs = new Set();
      for (const target of [oldPath, newPath]) {
        if (!target.endsWith(".批注.md")) continue;
        const rel = target.startsWith(".wt-comments/")
          ? target.slice(".wt-comments/".length)
          : target;
        docs.add(rel.replace(/\.批注\.md$/, ".md"));
      }
      for (const docPath of docs) this.invalidate(docPath);
      return [...docs];
    },
    async migrateLegacySidecars() {
      return 0;
    },
    async migrateFolderPrefix(oldFolder, newFolder) {
      calls.folderMigrations.push([oldFolder, newFolder]);
    },
  };

  const context = {
    app,
    services: {
      settings: {
        get() {
          return settings;
        },
        subscribe(listener) {
          calls.settingsSubscriptions++;
          settingsListener = listener;
          return () => {
            settingsUnsubscriptions++;
            settingsListener = null;
          };
        },
      },
      editor: {
        getFilePath(view) {
          return view.file?.path ?? null;
        },
        getViewForEditor(editor) {
          return editor.__cmView ?? null;
        },
      },
      ui: {
        leaves(type) {
          return type === "markdown" ? [leaf] : [];
        },
        getLeaf() {
          return leaf;
        },
        reveal() {},
        registerPanel(slot, factory) {
          calls.registrations++;
          panelFactory = { slot, factory };
          return () => {
            calls.unregistrations++;
          };
        },
      },
      diagnostics: {
        recordTiming() {},
      },
    },
    registrations: {
      registerEditorExtension(extension) {
        calls.extensionRegistrations++;
        return extension;
      },
    },
    events: {
      onWorkspace(name, listener) {
        calls.workspaceEvents++;
        workspaceHandlers.set(name, listener);
        return () => {};
      },
      onVault(name, listener) {
        calls.vaultEvents++;
        vaultHandlers.set(name, listener);
        return () => {};
      },
      setTimeout(callback) {
        callback();
        return 1;
      },
    },
    effects: new EffectScope("comments-module-test"),
  };

  const module = createCommentsModule(
    {
      getRecentMarkdownPath() {
        return chapterFile.path;
      },
      async openSidebar() {
        calls.openSidebar++;
      },
      isFormatScopeAllowed() {
        return false;
      },
      onChanged() {
        calls.shellChanges++;
      },
    },
    {
      createStore() {
        return store;
      },
      buildExtensions(config) {
        extensionConfig = config;
        return { extension: "comments" };
      },
      refreshDecor() {
        calls.decorRefreshes++;
      },
      createPanel(_container, host) {
        calls.panelFactory++;
        panelHost = host;
        panelHandle = {
          refresh() {
            calls.panelRefreshes++;
          },
          destroy() {
            calls.panelDestroy++;
          },
          async revealCard(id) {
            calls.panelReveals.push(id);
          },
        };
        return panelHandle;
      },
      createDraft(appArg, title, initial, onSave, onCancel) {
        calls.drafts++;
        lastDraft = { appArg, title, initial, onSave, onCancel, opens: 0 };
        return {
          open() {
            lastDraft.opens++;
          },
        };
      },
      createConfirm(appArg, title, message, cta, onConfirm) {
        calls.confirms++;
        lastConfirm = { appArg, title, message, cta, onConfirm, opens: 0 };
        return {
          open() {
            lastConfirm.opens++;
          },
        };
      },
    }
  );

  async function settle() {
    await new Promise((resolve) => setImmediate(resolve));
    await module.operations.flush();
    await new Promise((resolve) => setImmediate(resolve));
  }

  let inactiveRejected = false;
  try {
    await module.operations.getCommentPanelModel();
  } catch {
    inactiveRejected = true;
  }
  r.check(
    "模块 id 稳定且激活前不暴露批注能力",
    module.id === "comments" && inactiveRejected
  );

  disk.set(chapterFile.path, [
    {
      id: 1,
      status: "pending",
      quote: "第一段正文",
      paragraph: "第一段正文。",
      paragraphHint: 1,
      lineHint: 1,
      createdAt: "2026-10-17 10:00",
      content: "检查这一段",
      reply: "",
      current: "",
    },
  ]);

  await module.activate(context);
  r.check(
    "激活时订阅设置、三类工作区与四类 Vault 事件",
    calls.settingsSubscriptions === 1 &&
      calls.workspaceEvents === 3 &&
      calls.vaultEvents === 4
  );
  r.check(
    "激活时注册编辑器扩展与一个侧栏插槽",
    calls.extensionRegistrations === 1 &&
      calls.registrations === 1 &&
      panelFactory?.slot === "writing-toolkit:sidebar:comments"
  );
  r.check(
    "编辑器扩展绑定模块缓存、预加载与卡片定位",
    extensionConfig.enabled() === true &&
      extensionConfig.getComments(chapterFile.path) === undefined &&
      typeof extensionConfig.ensureLoaded === "function" &&
      typeof extensionConfig.onRevealComment === "function"
  );

  const container = { kind: "comments-container" };
  const mounted = panelFactory.factory(container);
  r.check(
    "插槽工厂把容器和模块操作端口交给批注面板",
    calls.panelFactory === 1 && panelHost === module.operations
  );
  const model = await panelHost.getCommentPanelModel();
  r.check(
    "面板模型读取当前文档、缓存与真实定位",
    model.docPath === chapterFile.path &&
      model.docName === "第一章" &&
      model.items.length === 1 &&
      model.items[0].locatedLine === 1 &&
      model.items[0].via === "exact"
  );

  await panelHost.toggleCommentResolved(chapterFile.path, 1);
  await settle();
  r.check(
    "标记已处理走统一读改写队列",
    disk.get(chapterFile.path)[0].status === "resolved"
  );

  await panelHost.editComment(chapterFile.path, 1);
  r.check(
    "编辑卡片打开模块注入的居中输入框",
    calls.drafts === 1 && lastDraft.title === "批注 1" && lastDraft.opens === 1
  );
  lastDraft.onSave("修改后的批注");
  await settle();
  r.check(
    "编辑内容写回同一文档且刷新装饰与面板",
    disk.get(chapterFile.path)[0].content === "修改后的批注" &&
      calls.decorRefreshes > 0 &&
      calls.panelRefreshes > 0
  );

  const cmView = {
    state: {
      selection: { main: { from: 0, to: 4, empty: false } },
      sliceDoc(from, to) {
        return docText.slice(from, to);
      },
      doc: {
        toString() {
          return docText;
        },
        lineAt() {
          return { number: 1 };
        },
      },
    },
    file: chapterFile,
  };
  panelHost.addCommentForView(cmView);
  await settle();
  r.check(
    "选区添加批注先落锚点再打开输入框",
    calls.drafts === 2 &&
      lastDraft.title === "添加批注" &&
      lastDraft.opens === 1 &&
      disk.get(chapterFile.path).some(
        (item) => item.id === 2 && item.content === ""
      )
  );
  lastDraft.onSave("新批注");
  await settle();
  r.check(
    "新增批注保存内容",
    disk.get(chapterFile.path).find((item) => item.id === 2)?.content ===
      "新批注"
  );

  panelHost.addCommentForView(cmView);
  await settle();
  lastDraft.onCancel();
  await settle();
  r.check(
    "取消新增批注只删除自己的空锚点",
    disk.get(chapterFile.path).filter((item) => item.id === 3).length === 0 &&
      disk.get(chapterFile.path).some((item) => item.id === 2)
  );

  const firstToggle = panelHost.toggleCommentResolved(
    chapterFile.path,
    2
  );
  const secondToggle = panelHost.toggleCommentResolved(
    chapterFile.path,
    2
  );
  await settle();
  r.check(
    "同一文档的并发修改串行写盘",
    calls.maxParallelSaves === 1
  );
  void firstToggle;
  void secondToggle;

  vaultHandlers.get("modify")(sidecarFile);
  await settle();
  r.check(
    "批注伴随文件外部修改使缓存失效并刷新",
    calls.storeInvalidations.includes(chapterFile.path) &&
      calls.decorRefreshes > 0
  );

  const oldSidecarFile = files.get(".wt-comments/正文/第一章.批注.md");
  const renamedChapter = new TFile("正文/改名第一章.md");
  files.set(renamedChapter.path, renamedChapter);
  vaultHandlers.get("rename")(renamedChapter, "正文/第一章.md");
  await settle();
  r.check(
    "源文档改名串行迁移批注伴随文件",
    renameCalls.some(
      (call) =>
        call.oldPath === ".wt-comments/正文/第一章.批注.md" &&
        call.newPath === ".wt-comments/正文/改名第一章.批注.md"
    ) &&
      files.get(".wt-comments/正文/改名第一章.批注.md") === oldSidecarFile
  );

  vaultHandlers.get("rename")(new TFolder("改名正文"), "正文");
  await settle();
  r.check(
    "目录改名同步搬 .wt-comments 镜像并清理缓存",
    calls.prefixInvalidations === 1 &&
      calls.folderMigrations.length === 1 &&
      calls.folderMigrations[0][0] === "正文" &&
      calls.folderMigrations[0][1] === "改名正文"
  );

  settings.commentsEnabled = false;
  settingsListener({ keys: ["commentsEnabled"] });
  r.check(
    "批注总开关变化刷新编辑器痕迹",
    calls.decorRefreshes > 0
  );

  const menu = {
    items: [],
    addItem(build) {
      calls.menuItems++;
      const item = {
        setTitle() {
          return this;
        },
        setIcon() {
          return this;
        },
        onClick(callback) {
          this.callback = (...args) => {
            calls.menuClicks++;
            callback(...args);
          };
          return this;
        },
      };
      build(item);
      this.items.push(item);
    },
  };
  const editor = {
    __cmView: cmView,
    getSelection() {
      return "第一段";
    },
  };
  settings.commentsEnabled = true;
  settings.commentBubbleEverywhere = true;
  workspaceHandlers.get("editor-menu")(menu, editor);
  const menuItem = menu.items[0];
  r.check(
    "批注开关与全库范围控制右键入口",
    calls.menuItems === 1 &&
      typeof menuItem?.callback === "function" &&
      menuItem.setTitle() === menuItem &&
      menuItem.setIcon() === menuItem
  );
  menuItem.callback();
  await settle();
  r.check(
    "右键入口复用选区添加批注流程",
    calls.menuClicks === 1 && calls.drafts === 4 && lastDraft.opens === 1
  );
  lastDraft.onCancel();
  await settle();

  void panelHost.revealInPanel(chapterFile.path, 1);
  await settle();
  r.check(
    "正文标记先打开批注页再定位卡片",
    calls.openSidebar === 1 && calls.panelReveals.includes(1)
  );

  const diagnostic = module.operations.buildDiagnosticReport();
  r.check(
    "批注诊断报告由模块基于自身状态生成",
    diagnostic.includes("批注自检报告") &&
      diagnostic.includes("批注总开关 commentsEnabled：是")
  );

  module.deactivate();
  let deactivatedRejected = false;
  try {
    module.operations.prime(chapterFile.path);
  } catch {
    deactivatedRejected = true;
  }
  r.check("停用后公开能力保持惰性", deactivatedRejected);

  mounted.destroy();
  mounted.destroy();
  r.check("插槽句柄重复销毁保持幂等", calls.panelDestroy === 1);

  context.effects.dispose();
  r.check(
    "销毁时撤销设置、插槽并清空面板",
    settingsUnsubscriptions === 1 &&
      calls.unregistrations === 1 &&
      calls.panelDestroy === 1
  );

  let disposedRejected = false;
  try {
    await panelHost.getCommentPanelModel();
  } catch {
    disposedRejected = true;
  }
  r.check("模块销毁后残留面板调用不再读数据", disposedRejected);

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(H.ROOT, "src/sidebar.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/commentsModule.ts"),
    "utf8"
  );
  const viewSource = fs.readFileSync(
    path.join(H.ROOT, "src/commentView.ts"),
    "utf8"
  );
  r.check(
    "批注模块不反向依赖 main.ts 或兄弟功能模块",
    !/from "\.\.\/main"/.test(moduleSource) &&
      !/from "\.\.\/features\//.test(moduleSource)
  );
  r.check(
    "主入口只装配批注模块与窄端口",
    /createCommentsModule\(/.test(mainSource) &&
      /this\.commentsModule,/.test(mainSource) &&
      /mountCommentsPanels\(/.test(mainSource) &&
      !/new CommentStore/.test(mainSource) &&
      !/buildCommentExtensions/.test(mainSource) &&
      !/CommentDraftModal/.test(mainSource) &&
      !/private commentStore/.test(mainSource)
  );
  r.check(
    "侧栏只通过 UI 插槽挂载批注面板",
    /mountCommentsPanels\(panelEl\)/.test(sidebarSource) &&
      !/CommentPanelBody/.test(sidebarSource) &&
      !/commentView"/.test(sidebarSource)
  );
  r.check(
    "批注面板与批注模块使用稳定窄接口",
    /CommentPanelHost/.test(viewSource) &&
      !/plugin: any/.test(viewSource)
  );
  r.check(
    "批注模块自己接管文件事件、编辑器扩展与插槽",
    /registerEditorExtension/.test(moduleSource) &&
      /onVault\("modify"/.test(moduleSource) &&
      /onVault\("rename"/.test(moduleSource) &&
      /registerPanel/.test(moduleSource)
  );
  r.check(
    "UI 插槽常量集中声明批注入口",
    /UI_SLOT_SIDEBAR_COMMENTS/.test(
      fs.readFileSync(path.join(H.ROOT, "src/uiSlots.ts"), "utf8")
    )
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
