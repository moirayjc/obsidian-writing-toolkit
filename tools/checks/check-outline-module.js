/**
 * 章纲 Feature Module 检查。
 *
 * 用注入的面板、编辑器和伴随文件操作验证：模块统一持有存储、事件、
 * 设置热更新与 UI 插槽；主入口和侧栏不再认识章纲面板/弹窗实现。
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
      const parentPath = filePath.includes("/")
        ? filePath.slice(0, filePath.lastIndexOf("/"))
        : "";
      this.parent = parentPath ? { path: parentPath } : null;
    }
  }

  class TFolder {
    constructor(folderPath) {
      this.path = folderPath;
      this.name = folderPath.split("/").pop() || folderPath;
    }
  }

  // 面板阅读态会 new Component() + MarkdownRenderer.render()：
  // 用桩记录调用参数与卸载状态，行为断言在下面的「面板双态」段落里。
  const renderedCalls = [];
  const pendingRenders = [];
  let renderDelay = false;
  const componentInstances = [];
  class Component {
    constructor() {
      this.loaded = false;
      this.unloaded = false;
      this.unloadCalls = 0;
      componentInstances.push(this);
    }
    load() {
      this.loaded = true;
    }
    unload() {
      this.unloadCalls++;
      this.unloaded = true;
    }
  }

  const restoreObsidian = H.stubObsidian({
    Modal: class {},
    Menu: class {},
    Notice: class {},
    TFile,
    TFolder,
    Component,
    MarkdownRenderer: {
      async render(app, markdown, el, sourcePath, component) {
        renderedCalls.push({ app, markdown, el, sourcePath, component });
        if (renderDelay) {
          await new Promise((resolve) => pendingRenders.push(resolve));
        }
        el.addClass("is-stub-rendered");
      },
    },
    setIcon() {},
  });
  let createOutlineModule;
  let outlineHelpers;
  let outlineTextHelpers;
  try {
    ({ createOutlineModule } = H.compile(
      "src/features/outlineModule.ts",
      "outline-module",
      ["electron"]
    ));
    outlineHelpers = H.compile(
      "src/chapterOutline.ts",
      "chapter-outline",
      ["electron"]
    );
    outlineTextHelpers = H.compile(
      "src/outlineText.ts",
      "outline-text",
      ["electron"]
    );
  } finally {
    restoreObsidian();
  }

  const { EffectScope } = H.compile(
    "src/host/effectScope.ts",
    "outline-module-scope"
  );
  const r = H.createReporter("章纲 Feature Module");

  r.check(
    "章节目录事件识别覆盖文件、目录与祖先改名",
    outlineHelpers.isOutlineFolderAffected(
      "小说/正文",
      "小说/正文/第一章.md"
    ) &&
      outlineHelpers.isOutlineFolderAffected("小说/正文", "小说/正文") &&
      outlineHelpers.isOutlineFolderAffected("小说/正文", "小说") &&
      !outlineHelpers.isOutlineFolderAffected(
        "小说/正文",
        "小说/资料/封面.png"
      )
  );

  const chapterFile = new TFile("正文/第一章.md");
  const secondChapter = new TFile("正文/第二章.md");
  const nonChapter = new TFile("资料/封面.png");
  const chapterFolder = new TFolder("正文");
  const internalFile = new TFile(".wt-outlines/正文/第一章.md");
  const chapterFiles = [chapterFile, secondChapter];

  r.check(
    "面板默认状态：有内容先渲染，空章纲直接进编辑态",
    outlineHelpers.defaultOutlineMode("## 本章要点\n\n- 剧情梗概") === "read" &&
      outlineHelpers.defaultOutlineMode("   ") === "edit" &&
      outlineHelpers.defaultOutlineMode("") === "edit"
  );
  const sidecars = new Map([
    [".wt-outlines/正文/第一章.md", "旧章纲"],
  ]);
  const outlineFolders = new Set([
    ".wt-outlines",
  ]);
  const frontmatter = new Map([
    ["正文/第一章.md", "---\n分类: 正文\n---\n正文"],
  ]);
  const writes = [];
  const mkdirs = [];
  const processed = [];
  let writesInFlight = 0;
  let maxParallelWrites = 0;

  const adapter = {
    async exists(target) {
      return outlineFolders.has(target) || sidecars.has(target);
    },
    async read(target) {
      return sidecars.get(target) ?? "";
    },
    async write(target, value) {
      writesInFlight++;
      maxParallelWrites = Math.max(maxParallelWrites, writesInFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      writes.push({ target, value });
      sidecars.set(target, value);
      writesInFlight--;
    },
    async mkdir(target) {
      mkdirs.push(target);
      outlineFolders.add(target);
    },
    async stat(target) {
      if (outlineFolders.has(target)) {
        return { type: "folder", mtime: 1, size: 0 };
      }
      if (!sidecars.has(target)) return null;
      return {
        type: "file",
        mtime: 10 + writes.filter((w) => w.target === target).length,
        size: (sidecars.get(target) ?? "").length,
      };
    },
    async remove(target) {
      sidecars.delete(target);
    },
    async rmdir(target) {
      for (const key of [...sidecars.keys()]) {
        if (key.startsWith(target + "/")) sidecars.delete(key);
      }
      for (const key of [...outlineFolders]) {
        if (key === target || key.startsWith(target + "/")) {
          outlineFolders.delete(key);
        }
      }
    },
  };
  const app = {
    vault: {
      configDir: ".obsidian",
      adapter,
      async cachedRead(file) {
        return frontmatter.get(file.path) ?? "";
      },
      async process(file, transform) {
        const before = frontmatter.get(file.path) ?? "";
        const after = transform(before);
        frontmatter.set(file.path, after);
        processed.push({ file, before, after });
        return after;
      },
    },
    workspace: {
      getActiveFile() {
        return chapterFile;
      },
    },
  };
  app.vault.getAbstractFileByPath = (target) => {
    if (target === chapterFile.path) return chapterFile;
    if (target === secondChapter.path) return secondChapter;
    if (target === nonChapter.path) return nonChapter;
    if (target === internalFile.path) return internalFile;
    return null;
  };

  const storageProbe = new TFile("正文/存储语义.md");
  sidecars.set(".wt-outlines/正文/存储语义.md", "旧 sidecar");
  frontmatter.set(
    storageProbe.path,
    "---\n章纲: |\n  当前 frontmatter\n---\n正文"
  );
  const sidecarWins = await outlineTextHelpers.loadOutline(
    app,
    storageProbe,
    "sidecar"
  );
  sidecars.set(".wt-outlines/正文/存储语义.md", "");
  const emptySidecarWins = await outlineTextHelpers.loadOutline(
    app,
    storageProbe,
    "sidecar"
  );
  frontmatter.set(
    storageProbe.path,
    '---\n章纲: ""\n---\n正文'
  );
  const emptyFrontmatterWins = await outlineTextHelpers.loadOutline(
    app,
    storageProbe,
    "frontmatter"
  );
  frontmatter.set(storageProbe.path, "---\n分类: 正文\n---\n正文");
  sidecars.set(".wt-outlines/正文/存储语义.md", "兼容旧 sidecar");
  const sidecarFallback = await outlineTextHelpers.loadOutline(
    app,
    storageProbe,
    "frontmatter"
  );
  r.check(
    "双存储模式遵循当前来源优先且支持空值防复活",
    sidecarWins.value === "旧 sidecar" &&
      emptySidecarWins.value === "" &&
      emptyFrontmatterWins.value === "" &&
      sidecarFallback.value === "兼容旧 sidecar"
  );
  sidecars.delete(".wt-outlines/正文/存储语义.md");
  frontmatter.delete(storageProbe.path);

  const settings = {
    draftKeywords: "正文",
    chapterExcludeNames: "Agent",
    snapshotFolder: ".wt-snapshots",
    outlineStorageMode: "sidecar",
  };
  const calls = {
    settingsSubscriptions: 0,
    settingsUnsubscriptions: 0,
    registrations: 0,
    unregistrations: 0,
    workspaceEvents: 0,
    vaultEvents: 0,
    panelFactory: 0,
    panelRefreshes: 0,
    panelFlushes: 0,
    outlineChanges: 0,
    panelDestroy: 0,
    activeLeaf: 0,
    creates: 0,
    renames: 0,
    deletes: 0,
    editorFactory: 0,
    editorOpens: 0,
    editorCloses: 0,
    editorFlushes: 0,
    editorRenames: 0,
    editorDeletes: 0,
    projectInvalidations: 0,
    eventOrder: [],
    migrations: [],
    removals: [],
    changes: [],
  };
  let settingsListener = null;
  let panelFactory = null;
  let panelRuntime = null;
  let panel = null;
  let editorStorage = null;
  let editorDone = null;
  let editorHandle = null;
  let panelDestroyHook = null;
  let recentMarkdownPath = null;

  const workspaceHandlers = new Map();
  const vaultHandlers = new Map();
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
            calls.settingsUnsubscriptions++;
            settingsListener = null;
          };
        },
      },
      project: {
        projects() {
          return [
            {
              root: "正文",
              name: "正文",
              volumes: [
                {
                  path: "正文",
                  name: "正文",
                  chapters: chapterFiles.map((file) => ({ file })),
                },
              ],
              resources: [],
            },
          ];
        },
        isDailyCountFile(path) {
          return chapterFiles.some((file) => file.path === path);
        },
        projectRootForPath() {
          return "正文";
        },
        invalidate() {
          calls.projectInvalidations++;
        },
      },
      ui: {
        leaves(type) {
          if (type !== "markdown" || !recentMarkdownPath) return [];
          return [{ view: { file: chapterFile } }];
        },
        registerPanel(slot, factory) {
          calls.registrations++;
          panelFactory = { slot, factory };
          return () => {
            calls.unregistrations++;
          };
        },
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
    },
    effects: new EffectScope("outline-module-test"),
  };

  const module = createOutlineModule(
    {
      getRecentMarkdownPath: () => recentMarkdownPath,
    },
    {
      createPanel(container, runtime) {
        calls.panelFactory++;
        panelRuntime = runtime;
        panel = {
          container,
          refresh() {
            calls.panelRefreshes++;
          },
          async flush() {
            calls.panelFlushes++;
          },
          destroy() {
            calls.panelDestroy++;
            panelDestroyHook?.();
          },
          onActiveLeafChange() {
            calls.activeLeaf++;
          },
          onVaultCreate() {
            calls.creates++;
          },
          async onVaultRename() {
            calls.renames++;
            calls.eventOrder.push("panel-rename");
          },
          onVaultDelete() {
            calls.deletes++;
          },
          onOutlineChanged() {
            calls.outlineChanges++;
          },
        };
        return panel;
      },
      createEditor(_app, file, chapters, storage, onDone) {
        calls.editorFactory++;
        editorStorage = storage;
        editorDone = onDone;
        editorHandle = {
          open() {
            calls.editorOpens++;
          },
          close() {
            calls.editorCloses++;
          },
          async flush() {
            calls.editorFlushes++;
          },
          getFilePath() {
            return file.path;
          },
          async onVaultRename() {
            calls.editorRenames++;
            calls.eventOrder.push("editor-rename");
          },
          onVaultDelete() {
            calls.editorDeletes++;
          },
          isAffected(path) {
            return file.path === path || file.path.startsWith(path + "/");
          },
        };
        return editorHandle;
      },
      async migrateSidecar(_app, oldPath, newPath) {
        calls.eventOrder.push("migrate");
        calls.migrations.push({ oldPath, newPath });
      },
      async removeSidecar(_app, sourcePath) {
        calls.removals.push(sourcePath);
      },
    }
  );

  async function settleVaultWork() {
    await new Promise((resolve) => setImmediate(resolve));
    await module.operations.flush();
    await Promise.resolve();
  }

  let inactiveRejected = false;
  try {
    await module.operations.load(chapterFile);
  } catch {
    inactiveRejected = true;
  }
  r.check(
    "模块 id 稳定且激活前不暴露章纲能力",
    module.id === "outlines" && inactiveRejected
  );

  await module.activate(context);
  r.check(
    "激活时订阅设置、活动文件与四类 Vault 事件",
    calls.settingsSubscriptions === 1 &&
      calls.workspaceEvents === 1 &&
      calls.vaultEvents === 4
  );
  r.check(
    "激活时只注册一个侧栏章纲插槽",
    calls.registrations === 1 &&
      panelFactory?.slot === "writing-toolkit:sidebar:outline"
  );

  const container = { kind: "outline-container" };
  const mounted = panelFactory.factory(container);
  r.check(
    "插槽工厂创建章纲面板并交给窄运行时",
    calls.panelFactory === 1 &&
      panel.container === container &&
      panelRuntime?.app === app
  );
  r.check(
    "面板通过 Project Service 识别章节与卷内顺序",
    panelRuntime.isChapter(chapterFile) &&
      !panelRuntime.isChapter(nonChapter) &&
      panelRuntime
        .chapterFiles(secondChapter)
        .map((file) => file.path)
        .join("|") === "正文/第一章.md|正文/第二章.md"
  );
  recentMarkdownPath = secondChapter.path;
  r.check(
    "侧栏失焦时通过最近章节兜底目标",
    panelRuntime.fallbackFile() === secondChapter
  );

  r.check(
    "面板读取走模块当前存储模式",
    (await panelRuntime.loadOutline(chapterFile)) === "旧章纲"
  );
  await panelRuntime.saveOutline(chapterFile, "新章纲");
  r.check(
    "sidecar 模式保存到伴随文件",
    writes.at(-1)?.target === ".wt-outlines/正文/第一章.md" &&
      writes.at(-1)?.value === "新章纲" &&
      mkdirs.includes(".wt-outlines/正文")
  );
  const firstSave = panelRuntime.saveOutline(chapterFile, "串行保存一");
  const secondSave = panelRuntime.saveOutline(chapterFile, "串行保存二");
  await module.operations.flush();
  r.check(
    "并发保存进入同一串行队列且后一次内容最终落盘",
    maxParallelWrites === 1 &&
      writes.at(-2)?.value === "串行保存一" &&
      writes.at(-1)?.value === "串行保存二" &&
      sidecars.get(".wt-outlines/正文/第一章.md") === "串行保存二"
  );
  await Promise.all([firstSave, secondSave]);

  settings.outlineStorageMode = "frontmatter";
  await panelRuntime.saveOutline(chapterFile, "Frontmatter 章纲");
  r.check(
    "存储模式热切换后保存到 frontmatter",
    processed.length === 1 &&
      processed[0].file === chapterFile &&
      processed[0].after.includes("章纲: |")
  );

  panelRuntime.openEditor(chapterFile, [chapterFile, secondChapter], () => {});
  r.check(
    "大窗口编辑器由模块创建并立即打开",
    calls.editorFactory === 1 && calls.editorOpens === 1
  );
  await editorStorage.save(chapterFile, "弹窗章纲");
  r.check(
    "编辑弹窗与侧栏共用当前存储端口",
    processed.length === 2 && processed[1].after.includes("弹窗章纲")
  );
  editorDone?.(secondChapter);

  const outlineChangesBeforeWorkbench = calls.outlineChanges;
  await module.operations.save(secondChapter, "编辑台写入的章纲");
  r.check(
    "编辑台保存（cause=workbench）会通知面板刷新",
    calls.outlineChanges === outlineChangesBeforeWorkbench + 1
  );

  settingsListener({ keys: ["draftKeywords"] });
  settingsListener({ keys: ["chapterExcludeNames"] });
  settingsListener({ keys: ["snapshotFolder"] });
  settingsListener({ keys: ["outlineStorageMode"] });
  r.check(
    "相关设置变化使 Project 索引失效并刷新章纲面板",
    calls.panelRefreshes === 4 && calls.projectInvalidations === 4
  );
  settingsListener({ keys: ["lineHeight"] });
  r.check("无关设置变化不刷新章纲面板", calls.panelRefreshes === 4);

  workspaceHandlers.get("active-leaf-change")();
  vaultHandlers.get("create")(secondChapter);
  r.check(
    "活动章节与新建章节事件转交面板",
    calls.activeLeaf === 1 && calls.creates === 1
  );

  const changes = [];
  const unsubscribeChanges = module.operations.subscribe((change) => {
    changes.push(change);
  });
  settings.outlineStorageMode = "sidecar";
  sidecars.set(".wt-outlines/正文/第一章.md", "外部写入的章纲");
  vaultHandlers.get("modify")(internalFile);
  await settleVaultWork();
  r.check(
    "外部修改 sidecar 时广播真实已写状态",
    changes.at(-1)?.kind === "external" &&
      changes.at(-1)?.paths[0] === "正文/第一章.md" &&
      changes.at(-1)?.hasContent === true
  );
  sidecars.set(".wt-outlines/正文/第一章.md", "");
  vaultHandlers.get("modify")(internalFile);
  await settleVaultWork();
  r.check(
    "外部清空 sidecar 时广播未写状态",
    changes.at(-1)?.kind === "external" &&
      changes.at(-1)?.hasContent === false
  );

  vaultHandlers.get("rename")(secondChapter, "正文/旧第二章.md");
  await settleVaultWork();
  r.check(
    "Markdown 改名先保存/通知面板再串行迁移伴随章纲",
    calls.renames === 1 &&
      calls.migrations.length === 1 &&
      calls.migrations[0].oldPath === "正文/旧第二章.md" &&
      calls.migrations[0].newPath === "正文/第二章.md" &&
      calls.eventOrder.indexOf("panel-rename") <
        calls.eventOrder.indexOf("migrate")
  );

  vaultHandlers.get("rename")(chapterFolder, "旧正文");
  await settleVaultWork();
  r.check(
    "整卷目录改名也迁移章纲树",
    calls.renames === 2 &&
      calls.migrations.length === 2 &&
      calls.migrations[1].oldPath === "旧正文" &&
      calls.migrations[1].newPath === "正文"
  );

  vaultHandlers.get("rename")(internalFile, ".wt-outlines/旧路径.md");
  vaultHandlers.get("rename")(nonChapter, "资料/旧封面.png");
  await settleVaultWork();
  r.check(
    "内部路径与非 Markdown 改名不触发章纲迁移",
    calls.renames === 4 && calls.migrations.length === 2
  );

  vaultHandlers.get("delete")(chapterFile);
  vaultHandlers.get("delete")(internalFile);
  await settleVaultWork();
  r.check(
    "删除正文清理伴随章纲且跳过内部目录",
    calls.deletes === 2 &&
      calls.removals.length === 1 &&
      calls.removals[0] === "正文/第一章.md"
  );

  await module.operations.migrateSidecar("旧.md", "新.md");
  await module.operations.removeSidecar("待删.md");
  r.check(
    "公开窄接口复用同一迁移与清理能力",
    calls.migrations.at(-1)?.oldPath === "旧.md" &&
      calls.migrations.at(-1)?.newPath === "新.md" &&
      calls.removals.at(-1) === "待删.md"
  );

  unsubscribeChanges();
  module.deactivate();
  let deactivatedRejected = false;
  try {
    await module.operations.load(chapterFile);
  } catch {
    deactivatedRejected = true;
  }
  r.check("停用后公开能力保持惰性", deactivatedRejected);

  settings.outlineStorageMode = "frontmatter";
  await panelRuntime.saveOutline(chapterFile, "停用清理中的最后一次保存");
  r.check(
    "宿主回收前仍允许面板完成未落盘保存",
    processed.at(-1)?.after.includes("停用清理中的最后一次保存")
  );

  mounted.destroy();
  mounted.destroy();
  r.check("插槽句柄重复销毁保持幂等", calls.panelDestroy === 1);

  context.effects.dispose();
  r.check(
    "销毁时撤销设置与插槽并清理模块状态",
    calls.settingsUnsubscriptions === 1 &&
      calls.unregistrations === 1 &&
      calls.panelDestroy === 1
  );

  let disposedRejected = false;
  try {
    await panelRuntime.saveOutline(chapterFile, "残留调用");
  } catch {
    disposedRejected = true;
  }
  r.check("模块销毁后残留面板调用不再写盘", disposedRejected);

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const sidebarSource = fs.readFileSync(
    path.join(H.ROOT, "src/sidebar.ts"),
    "utf8"
  );
  const panelSource = fs.readFileSync(
    path.join(H.ROOT, "src/chapterOutline.ts"),
    "utf8"
  );
  const modalSource = fs.readFileSync(
    path.join(H.ROOT, "src/outlineModal.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(H.ROOT, "src/features/outlineModule.ts"),
    "utf8"
  );
  r.check(
    "章纲模块不反向依赖 main.ts 或兄弟功能模块",
    !/from "\.\.\/main"/.test(moduleSource) &&
      !/from "\.\.\/features\//.test(moduleSource)
  );
  r.check(
    "主入口只装配章纲模块和插槽桥",
    /createOutlineModule\(/.test(mainSource) &&
      /this\.outlineModule,/.test(mainSource) &&
      /mountOutlinePanels\(/.test(mainSource) &&
      !/ChapterOutlinePanel/.test(mainSource) &&
      !/OutlineEditorModal/.test(mainSource) &&
      !/migrateOutlineSidecar/.test(mainSource)
  );
  r.check(
    "侧栏只通过 UI 插槽挂载章纲面板",
    /mountOutlinePanels\(outlineSection\)/.test(sidebarSource) &&
      !/ChapterOutlinePanel/.test(sidebarSource) &&
      !/chapterOutline"/.test(sidebarSource)
  );
  r.check(
    "章纲面板不再接受插件 any 或直接订阅文件事件",
    !/plugin: any/.test(panelSource) &&
      !/\.on\(/.test(panelSource) &&
      !/\.offref\(/.test(panelSource) &&
      /OutlinePanelRuntime/.test(panelSource) &&
      !/isDraftPath/.test(panelSource)
  );
  r.check(
    "章纲模块通过 Project Service 统一章节识别",
    /services\.project/.test(moduleSource) &&
      /isDailyCountFile\(file\.path\)/.test(moduleSource)
  );
  r.check(
    "章纲弹窗只依赖窄存储端口",
    /OutlineEditorStorage/.test(modalSource) &&
      !/loadOutline|saveOutline/.test(modalSource) &&
      !/plugin: any/.test(modalSource)
  );
  r.check(
    "UI 插槽常量集中声明",
    /UI_SLOT_SIDEBAR_OUTLINE/.test(
      fs.readFileSync(path.join(H.ROOT, "src/uiSlots.ts"), "utf8")
    )
  );
  r.check(
    "阅读态走公开 MarkdownRenderer，并按正文章节路径解析链接",
    /MarkdownRenderer\.render\(/.test(panelSource) &&
      /new Component\(\)/.test(panelSource) &&
      /this\.file\?\.path/.test(panelSource) &&
      /previewComponent/.test(panelSource) &&
      /component\.unload\(\)/.test(panelSource) &&
      !/innerHTML/.test(panelSource)
  );
  r.check(
    "阅读/编辑双态只重画主内容区，顶栏保留模式按钮",
    /wt-outline-preview/.test(panelSource) &&
      /wt-outline-mode-btn/.test(panelSource) &&
      /renderBody\(\)/.test(panelSource) &&
      /exitEditMode/.test(panelSource) &&
      /defaultOutlineMode/.test(panelSource)
  );
  r.check(
    "外部刷新不打断编辑、同内容保存去重、工具栏不抢焦点",
    /pendingReload/.test(panelSource) &&
      /inflightSave/.test(panelSource) &&
      /keepEditingFocus\(/.test(panelSource) &&
      /addEventListener\("mousedown", \(e\) => e\.preventDefault\(\)\)/.test(
        panelSource
      )
  );
  r.check(
    "阅读态拦截任务列表复选框的默认勾选（不会回写章纲）",
    /input\[type="checkbox"\]/.test(panelSource) &&
      /event\.preventDefault\(\)/.test(panelSource)
  );

  // ---- 面板阅读/编辑双态：真实 ChapterOutlinePanel + 假 DOM 跑一遍 ----
  class FakeEl {
    constructor(tag = "div") {
      this.tag = tag;
      this.children = [];
      this.classes = new Set();
      this.attrs = Object.create(null);
      this.listeners = Object.create(null);
      this.textContent = "";
      this.value = "";
      this.placeholder = "";
      this.spellcheck = true;
      this.disabled = false;
      this.focused = false;
      this.selection = null;
    }
    createDiv(opts) {
      return this.createEl("div", opts);
    }
    createSpan(opts) {
      return this.createEl("span", opts);
    }
    createEl(tag, opts = {}) {
      const el = new FakeEl(tag);
      if (opts.cls) {
        String(opts.cls)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((cls) => el.classes.add(cls));
      }
      if (opts.text !== undefined) el.textContent = String(opts.text);
      if (opts.attr) Object.assign(el.attrs, opts.attr);
      this.children.push(el);
      return el;
    }
    empty() {
      this.children = [];
      this.textContent = "";
    }
    addClass(cls) {
      String(cls)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => this.classes.add(name));
    }
    toggleClass(cls, on) {
      if (on) this.classes.add(cls);
      else this.classes.delete(cls);
    }
    setText(text) {
      this.textContent = String(text);
    }
    setAttr(key, value) {
      this.attrs[key] = value;
    }
    addEventListener(type, listener) {
      (this.listeners[type] || (this.listeners[type] = [])).push(listener);
    }
    fire(type, event = {}) {
      for (const listener of this.listeners[type] || []) listener(event);
    }
    querySelector(selector) {
      const cls = selector.startsWith(".") ? selector.slice(1) : null;
      if (!cls) return null;
      const walk = (node) => {
        for (const child of node.children) {
          if (child.classes.has(cls)) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    }
    click() {
      this.fire("click", { preventDefault() {} });
    }
    focus() {
      this.focused = true;
    }
    setSelectionRange(start, end) {
      this.selection = [start, end];
    }
  }
  function findClass(root, cls) {
    for (const child of root.children) {
      if (child.classes.has(cls)) return child;
      const found = findClass(child, cls);
      if (found) return found;
    }
    return null;
  }
  async function waitFor(predicate, timeoutMs = 800) {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
  }

  const panelRoot = new FakeEl("div");
  const savedValues = [];
  const renderedText = "## 本章定位\n\n- **核心任务**：验证渲染";
  const fakePanelRuntime = {
    app: {
      workspace: { getActiveFile: () => chapterFile },
      vault: {
        getAbstractFileByPath(target) {
          return target === chapterFile.path ? chapterFile : null;
        },
      },
    },
    isChapter(file) {
      return file === chapterFile;
    },
    fallbackFile() {
      return null;
    },
    chapterFiles() {
      return chapterFiles;
    },
    async loadOutline() {
      return renderedText;
    },
    async saveOutline(_file, value) {
      savedValues.push(value);
    },
    openEditor() {
      return null;
    },
  };

  // 面板内部用 window.setTimeout 做 60ms 的防抖刷新；Node 里把 window 指到 global。
  const hadWindow = Object.prototype.hasOwnProperty.call(global, "window");
  if (!hadWindow) global.window = global;
  renderedCalls.length = 0;
  const fakePanel = new outlineHelpers.ChapterOutlinePanel(panelRoot, fakePanelRuntime);
  const unloadedBefore = componentInstances.filter((item) => item.unloaded).length;
  fakePanel.refresh();

  const firstRendered = await waitFor(() => renderedCalls.length === 1);
  const firstRender = renderedCalls[0] || {};
  r.check(
    "有内容时默认阅读态：渲染 Markdown、隐藏源码框、章节路径作为 sourcePath",
    firstRendered &&
      firstRender.markdown === renderedText &&
      firstRender.sourcePath === chapterFile.path &&
      firstRender.el.classes.has("markdown-rendered") &&
      findClass(panelRoot, "wt-outline-textarea") === null &&
      findClass(panelRoot, "wt-outline-preview") !== null
  );
  r.check(
    "阅读态渲染使用独立 Component（已 load，切模式/销毁时要 unload）",
    firstRender.component?.loaded === true &&
      firstRender.component?.unloaded === false &&
      componentInstances.filter((item) => item.unloaded).length ===
        unloadedBefore
  );

  const modeButton = findClass(panelRoot, "wt-outline-mode-btn");
  let modeMousedownPrevented = 0;
  modeButton.fire("mousedown", {
    preventDefault() {
      modeMousedownPrevented++;
    },
  });
  modeButton.fire("click");
  const editor = findClass(panelRoot, "wt-outline-textarea");
  r.check(
    "点顶栏铅笔进编辑态：显示源码、聚焦并把光标放到末尾、卸载渲染 Component",
    editor !== null &&
      editor.value === renderedText &&
      editor.focused === true &&
      editor.selection?.[0] === renderedText.length &&
      firstRender.component.unloaded === true
  );

  r.check(
    "模式按钮按下不抢编辑框焦点（mousedown preventDefault）",
    modeMousedownPrevented === 1
  );

  const editedText = "## 改过的章纲\n\n- 新的要点";
  editor.value = editedText;
  editor.fire("input");
  editor.fire("blur");
  const secondRendered = await waitFor(() => renderedCalls.length >= 2);
  r.check(
    "编辑后失焦：先落盘再回阅读态，并用最新内容重新渲染",
    secondRendered &&
      savedValues.length === 1 &&
      savedValues[0] === editedText &&
      renderedCalls[1].markdown === editedText &&
      renderedCalls[1].sourcePath === chapterFile.path &&
      findClass(panelRoot, "wt-outline-textarea") === null &&
      findClass(panelRoot, "wt-outline-preview") !== null
  );

  // 输入后改回原文（撤销）：退出编辑时状态应回「已保存」，不能停在「未保存」
  findClass(panelRoot, "wt-outline-mode-btn").click();
  await waitFor(() => findClass(panelRoot, "wt-outline-textarea") !== null);
  const undoEditor = findClass(panelRoot, "wt-outline-textarea");
  const stateEl = findClass(panelRoot, "wt-outline-state");
  const cleanState = stateEl.textContent;
  undoEditor.value = editedText + "x";
  undoEditor.fire("input");
  const dirtyState = stateEl.textContent;
  undoEditor.value = editedText;
  undoEditor.fire("input");
  findClass(panelRoot, "wt-outline-mode-btn").click();
  await waitFor(() => findClass(panelRoot, "wt-outline-preview") !== null);
  r.check(
    "输入后撤销回原文：退出编辑时状态回到「已保存」，且不重复写盘",
    cleanState === "已保存" &&
      dirtyState === "未保存" &&
      stateEl.textContent === "已保存" &&
      savedValues.length === 1
  );

  findClass(panelRoot, "wt-outline-mode-btn").click();
  await waitFor(() => findClass(panelRoot, "wt-outline-textarea") !== null);
  const clearingEditor = findClass(panelRoot, "wt-outline-textarea");
  clearingEditor.value = "";
  clearingEditor.fire("input");
  clearingEditor.fire("blur");
  const emptyPreviewShown = await waitFor(
    () => findClass(panelRoot, "wt-outline-preview-empty") !== null
  );
  r.check(
    "清空章纲后退出编辑：阅读态显示空状态，不调用渲染器",
    emptyPreviewShown &&
      savedValues.at(-1) === "" &&
      findClass(panelRoot, "wt-outline-textarea") === null &&
      renderedCalls.length === 3
  );
  findClass(panelRoot, "wt-outline-preview-start").click();
  r.check(
    "空状态里的「开始写章纲」重新进入编辑态",
    findClass(panelRoot, "wt-outline-textarea") !== null &&
      findClass(panelRoot, "wt-outline-textarea").focused === true
  );

  fakePanel.destroy();
  r.check(
    "销毁面板时卸载最后一次渲染的 Component（不残留监听器）",
    componentInstances.length >= 2 &&
      componentInstances.every((item) => item.unloaded) &&
      renderedCalls.length === 3
  );

  // 空章纲首次打开：直接进编辑态，不先画一个空的阅读面板
  const emptyRoot = new FakeEl("div");
  const emptyRuntime = {
    ...fakePanelRuntime,
    async loadOutline() {
      return "";
    },
    async saveOutline() {},
  };
  const emptyPanel = new outlineHelpers.ChapterOutlinePanel(emptyRoot, emptyRuntime);
  emptyPanel.refresh();
  r.check(
    "空章纲首次打开直接进编辑态，不渲染空阅读面板",
    (await waitFor(() => findClass(emptyRoot, "wt-outline-textarea") !== null)) &&
      findClass(emptyRoot, "wt-outline-preview") === null &&
      renderedCalls.length === 3
  );
  emptyPanel.destroy();

  // ---- 过期渲染：延迟 resolve 后只卸载一次，且不打断当前编辑态 ----
  renderedCalls.length = 0;
  const delayedRoot = new FakeEl("div");
  renderDelay = true;
  const delayedPanel = new outlineHelpers.ChapterOutlinePanel(delayedRoot, fakePanelRuntime);
  delayedPanel.refresh();
  await waitFor(() => renderedCalls.length === 1);
  const delayedComponent = renderedCalls[0].component;
  findClass(delayedRoot, "wt-outline-mode-btn").fire("mousedown", {
    preventDefault() {},
  });
  findClass(delayedRoot, "wt-outline-mode-btn").click();
  await waitFor(() => findClass(delayedRoot, "wt-outline-textarea") !== null);
  const unloadsAfterSwitch = delayedComponent.unloadCalls;
  pendingRenders.splice(0).forEach((resolve) => resolve());
  await new Promise((resolve) => setTimeout(resolve, 20));
  r.check(
    "过期渲染晚到：Component 只卸载一次，且不会打断当前编辑态",
    unloadsAfterSwitch === 1 &&
      delayedComponent.unloadCalls === 1 &&
      findClass(delayedRoot, "wt-outline-textarea") !== null &&
      findClass(delayedRoot, "wt-outline-preview") === null
  );
  delayedPanel.destroy();
  renderDelay = false;

  // ---- 保存失败：留在编辑态，内容不丢 ----
  renderedCalls.length = 0;
  const rejectRoot = new FakeEl("div");
  let rejectCalls = 0;
  const rejectRuntime = {
    ...fakePanelRuntime,
    async loadOutline() {
      return "旧章纲";
    },
    async saveOutline() {
      rejectCalls++;
      throw new Error("disk full");
    },
  };
  const origConsoleError = console.error;
  console.error = () => {};
  const rejectPanel = new outlineHelpers.ChapterOutlinePanel(rejectRoot, rejectRuntime);
  rejectPanel.refresh();
  await waitFor(() => renderedCalls.length === 1);
  findClass(rejectRoot, "wt-outline-mode-btn").click();
  await waitFor(() => findClass(rejectRoot, "wt-outline-textarea") !== null);
  const rejectEditor = findClass(rejectRoot, "wt-outline-textarea");
  rejectEditor.value = "改了的章纲";
  rejectEditor.fire("input");
  rejectEditor.fire("blur");
  await waitFor(() => rejectCalls >= 1);
  r.check(
    "保存失败时留在编辑态：内容不丢、状态显示「保存失败」",
    rejectCalls >= 1 &&
      findClass(rejectRoot, "wt-outline-textarea") !== null &&
      findClass(rejectRoot, "wt-outline-textarea").value === "改了的章纲" &&
      findClass(rejectRoot, "wt-outline-state")?.textContent === "保存失败"
  );
  rejectPanel.destroy();
  console.error = origConsoleError;

  // ---- blur 与紧随的按钮切换并发：同一内容只写一次 ----
  renderedCalls.length = 0;
  const dedupeRoot = new FakeEl("div");
  const dedupeSaves = [];
  let dedupeActive = chapterFile;
  const dedupeRuntime = {
    ...fakePanelRuntime,
    app: {
      workspace: {
        getActiveFile: () => dedupeActive,
      },
      vault: {
        getAbstractFileByPath(target) {
          if (target === chapterFile.path) return chapterFile;
          if (target === secondChapter.path) return secondChapter;
          return null;
        },
      },
    },
    chapterFiles() {
      return [chapterFile, secondChapter];
    },
    isChapter() {
      return true;
    },
    async loadOutline(file) {
      return file.path === chapterFile.path ? "原始章纲" : "第二章章纲";
    },
    async saveOutline(_file, value) {
      dedupeSaves.push(value);
    },
  };
  const dedupePanel = new outlineHelpers.ChapterOutlinePanel(dedupeRoot, dedupeRuntime);
  dedupePanel.refresh();
  await waitFor(() => renderedCalls.length === 1);
  findClass(dedupeRoot, "wt-outline-mode-btn").click();
  await waitFor(() => findClass(dedupeRoot, "wt-outline-textarea") !== null);
  const dedupeEditor = findClass(dedupeRoot, "wt-outline-textarea");
  dedupeEditor.value = "同一笔内容";
  dedupeEditor.fire("input");
  dedupeEditor.fire("blur");
  dedupeActive = secondChapter;
  dedupePanel.onActiveLeafChange();
  await new Promise((resolve) => setTimeout(resolve, 60));
  r.check(
    "失焦与切章并发时，同一内容只写一次",
    dedupeSaves.length === 1 && dedupeSaves[0] === "同一笔内容"
  );
  dedupePanel.destroy();

  // ---- 编辑态收到外部刷新：不打断编辑，退出后补一次渲染 ----
  renderedCalls.length = 0;
  const pendingRoot = new FakeEl("div");
  let pendingLoads = 0;
  const pendingRuntime = {
    ...fakePanelRuntime,
    async loadOutline() {
      pendingLoads++;
      return "## 外部刷新后的内容";
    },
  };
  const pendingPanel = new outlineHelpers.ChapterOutlinePanel(pendingRoot, pendingRuntime);
  pendingPanel.refresh();
  await waitFor(() => renderedCalls.length === 1);
  findClass(pendingRoot, "wt-outline-mode-btn").click();
  await waitFor(() => findClass(pendingRoot, "wt-outline-textarea") !== null);
  const pendingEditor = findClass(pendingRoot, "wt-outline-textarea");
  const callsBeforeReload = renderedCalls.length;
  pendingPanel.onOutlineChanged([chapterFile.path]);
  await new Promise((resolve) => setTimeout(resolve, 140));
  const stillEditing = findClass(pendingRoot, "wt-outline-textarea") !== null;
  pendingEditor.fire("blur");
  const reloadedAfterExit = await waitFor(
    () => renderedCalls.length > callsBeforeReload
  );
  r.check(
    "编辑态收到外部刷新：先保持编辑，退出后再补渲染",
    stillEditing &&
      reloadedAfterExit &&
      findClass(pendingRoot, "wt-outline-preview") !== null &&
      pendingLoads >= 2
  );
  pendingPanel.destroy();

  if (!hadWindow) delete global.window;

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
