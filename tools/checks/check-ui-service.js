/**
 * UI Service 检查。
 *
 * 用真实 DefaultUiService 验证视图注册、标签页查找、侧栏展开、
 * 视图挂载、手机抽屉迁移和插件设置页入口，并检查 main.ts 的调用边界。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function createLeaf(label, root) {
  return {
    label,
    view: {},
    detached: false,
    viewState: null,
    getRoot() {
      return root;
    },
    async setViewState(state) {
      this.viewState = state;
    },
    detach() {
      this.detached = true;
    },
  };
}

async function main() {
  const leftSplit = {
    collapsed: false,
    expanded: 0,
    expand() {
      this.collapsed = false;
      this.expanded++;
    },
  };
  const rightSplit = {
    collapsed: true,
    expanded: 0,
    expand() {
      this.collapsed = false;
      this.expanded++;
    },
  };
  const rootSplit = { kind: "root" };
  const leftLeaf = createLeaf("left", leftSplit);
  const rightLeaf = createLeaf("right", rightSplit);
  const rightOther = createLeaf("right-other", rightSplit);
  const tabLeaf = createLeaf("tab", rootSplit);
  const strayLeaf = createLeaf("stray", rootSplit);

  const byType = new Map();
  let activeLeaf = null;
  const workspace = {
    leftSplit,
    rightSplit,
    rootSplit,
    getLeavesOfType(type) {
      return byType.get(type) ?? [];
    },
    getLeaf(location) {
      return location === "tab" ? tabLeaf : null;
    },
    getLeftLeaf() {
      return leftLeaf;
    },
    getRightLeaf() {
      return rightLeaf;
    },
    setActiveLeaf(leaf, options) {
      activeLeaf = { leaf, options };
    },
  };
  const app = { workspace };

  const registered = [];
  const registration = {
    registerView(type, creator) {
      registered.push({ type, creator });
    },
  };

  const { DefaultUiService } = H.compile(
    "src/services/uiService.ts",
    "ui-service"
  );
  const service = new DefaultUiService(app, registration);
  const r = H.createReporter("UI Service");

  const creator = () => ({ getViewType: () => "test-view" });
  service.registerView("test-view", creator);
  r.check(
    "视图注册委托给插件入口",
    registered.length === 1 &&
      registered[0].type === "test-view" &&
      registered[0].creator === creator
  );

  const panelCalls = [];
  const unregisterA = service.registerPanel("sidebar-target", (container) => {
    const panel = {
      container,
      refreshCount: 0,
      liveText: null,
      destroyed: 0,
      refresh() {
        this.refreshCount++;
      },
      updateLive(text) {
        this.liveText = text;
      },
      destroy() {
        this.destroyed++;
      },
    };
    panelCalls.push(panel);
    return panel;
  });
  service.registerPanel("sidebar-target", (container) => {
    const panel = {
      container,
      refreshCount: 0,
      liveText: null,
      destroyed: 0,
      refresh() {
        this.refreshCount++;
      },
      destroy() {
        this.destroyed++;
      },
    };
    panelCalls.push(panel);
    return panel;
  });
  const panelContainer = { kind: "panel-container" };
  const panelGroup = service.mountPanels("sidebar-target", panelContainer);
  r.check(
    "UI 插槽可组合多个功能面板",
    panelCalls.length === 2 &&
      panelCalls.every((panel) => panel.container === panelContainer)
  );
  panelGroup.refresh();
  r.check(
    "刷新插槽时逐面板刷新",
    panelCalls.every((panel) => panel.refreshCount === 1)
  );
  panelGroup.updateLive("正文");
  r.check(
    "实时更新只调用支持的面板",
    panelCalls[0].liveText === "正文" && panelCalls[1].liveText === null
  );
  unregisterA();
  r.check(
    "注销面板工厂会销毁已挂载实例",
    panelCalls[0].destroyed === 1 && panelCalls[1].destroyed === 0
  );
  panelGroup.destroy();
  r.check(
    "销毁插槽组会清理剩余面板且保持幂等",
    panelCalls[0].destroyed === 1 && panelCalls[1].destroyed === 1
  );
  panelGroup.destroy();
  r.check("重复销毁插槽组不会重复清理", panelCalls[1].destroyed === 1);
  const remounted = service.mountPanels("sidebar-target", panelContainer);
  remounted.refresh();
  r.check(
    "注销后的面板工厂不再参与后续挂载",
    panelCalls.length === 3 &&
      panelCalls[2].container === panelContainer &&
      panelCalls[2].refreshCount === 1
  );
  remounted.destroy();

  byType.set("demo", [leftLeaf, rightLeaf]);
  r.check("按类型读取全部 leaf", service.leaves("demo").length === 2);
  r.check("按类型读取第一个 leaf", service.firstLeaf("demo") === leftLeaf);
  r.check("没有匹配 leaf 时返回 null", service.firstLeaf("missing") === null);
  r.check("左侧位置返回左抽屉", service.getLeaf("left") === leftLeaf);
  r.check("右侧位置返回右抽屉", service.getLeaf("right") === rightLeaf);
  r.check("主区位置返回标签页", service.getLeaf("tab") === tabLeaf);

  rightSplit.collapsed = true;
  service.reveal(rightLeaf);
  r.check("展开收起的右侧栏", rightSplit.collapsed === false);
  r.check(
    "显示 leaf 时聚焦它",
    activeLeaf?.leaf === rightLeaf && activeLeaf?.options?.focus === true
  );

  await service.showView(leftLeaf, "demo");
  r.check(
    "挂载视图时设置类型并激活",
    leftLeaf.viewState?.type === "demo" && leftLeaf.viewState?.active === true
  );
  r.check("挂载后自动聚焦视图", activeLeaf?.leaf === leftLeaf);

  byType.set("drawer", [strayLeaf, rightOther]);
  const drawerTarget = await service.openInDrawer("drawer", "right");
  r.check("手机抽屉返回目标 leaf", drawerTarget === rightLeaf);
  r.check("手机抽屉清理主区中的同类型视图", strayLeaf.detached === true);
  r.check("手机抽屉不误删侧栏里的其他视图", rightOther.detached === false);
  r.check(
    "手机抽屉设置视图并激活",
    rightLeaf.viewState?.type === "drawer" &&
      rightLeaf.viewState?.active === true
  );

  const moveStray = createLeaf("move-stray", rootSplit);
  byType.set("move-me", [moveStray]);
  const moved = await service.moveToDrawer("move-me", "left");
  r.check("启动自愈能把主区视图移到抽屉", moved === true);
  r.check(
    "启动自愈保持后台挂载",
    leftLeaf.viewState?.type === "move-me" &&
      leftLeaf.viewState?.active === false
  );
  r.check("启动自愈移除主区旧视图", moveStray.detached === true);
  byType.set("already-clean", []);
  r.check(
    "没有主区旧视图时不做迁移",
    (await service.moveToDrawer("already-clean", "left")) === false
  );

  let settingsOpened = 0;
  let openedTab = null;
  app.setting = {
    open() {
      settingsOpened++;
    },
    openTabById(id) {
      openedTab = id;
    },
  };
  r.check("能打开插件设置页", service.openPluginSettings("writing-toolkit"));
  r.check(
    "设置页打开后切到插件标签",
    settingsOpened === 1 && openedTab === "writing-toolkit"
  );

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const hostSource = fs.readFileSync(
    path.join(H.ROOT, "src/host/pluginHost.ts"),
    "utf8"
  );
  r.check("HostServices 暴露 ui", /readonly ui: UiService;/.test(hostSource));
  r.check(
    "Host 的视图注册委托给 UI Service",
    /registerView\(type: string, viewCreator: ViewCreator\): void \{[\s\S]*?this\.services\.ui\.registerView\(type, viewCreator\);/.test(
      hostSource
    )
  );
  r.check(
    "main.ts 创建 UI Service",
    /ui: new DefaultUiService\(this\.app, this\)/.test(mainSource)
  );
  r.check(
    "main.ts 不直接查询 workspace leaf",
    !/workspace\.getLeavesOfType\(/.test(mainSource)
  );
  r.check(
    "main.ts 不直接创建 workspace leaf",
    !/workspace\.getLeaf\(|workspace\.getLeftLeaf\(|workspace\.getRightLeaf\(/.test(
      mainSource
    )
  );
  r.check(
    "main.ts 不直接操作视图状态",
    !/\.setViewState\(|\.detach\(|workspace\.setActiveLeaf\(/.test(mainSource)
  );
  r.check(
    "main.ts 不直接展开或收起侧栏",
    !/workspace\.leftSplit|workspace\.rightSplit/.test(mainSource)
  );
  r.check(
    "main.ts 不直接访问内部设置窗口",
    !/\(this\.app as unknown as \{ setting\?:/.test(mainSource)
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
