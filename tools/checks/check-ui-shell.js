/**
 * UI Shell 解耦检查（阶段 5）。
 *
 * UI Shell（主页 / 编辑台 / 工具箱 / 状态栏 / 手机状态条）只允许依赖
 * `src/uiShellContext.ts` 的窄接口、Services 和共享纯工具：
 * - 不再 import `main.ts` 的类型；
 * - 不直接 import 功能模块实现或兄弟 Shell；
 * - 不注册命令 / 视图，不直接写 data.json；
 * - 三个视图 id、四命令白名单和手机抽屉迁移逻辑保持不变。
 *
 * 这是源码边界检查，不启动 Obsidian。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function source(name) {
  return fs.readFileSync(path.join(H.ROOT, "src", name), "utf8");
}

function main() {
  const r = H.createReporter("UI Shell 解耦（源码级）");
  const home = source("home.ts");
  const workbench = source("workbench.ts");
  const sidebar = source("sidebar.ts");
  const statusbar = source("statusbar.ts");
  const mobile = source("mobileStatusBar.ts");
  const mainSource = source("main.ts");
  const context = source("uiShellContext.ts");
  const navSource = source("services/navigationService.ts");
  const statsSource = source("services/statsService.ts");
  const prefsSource = source("services/workspacePrefsService.ts");
  const uiTypesSource = source("services/uiTypes.ts");
  const uiSlotsSource = source("uiSlots.ts");
  const shells = {
    "home.ts": home,
    "workbench.ts": workbench,
    "sidebar.ts": sidebar,
    "statusbar.ts": statusbar,
    "mobileStatusBar.ts": mobile,
  };

  // 1. Shell 不再 import main.ts 的类型。
  for (const [name, src] of Object.entries(shells)) {
    r.check(
      `${name} 不 import main.ts 的类型`,
      !/from "\.\/main"/.test(src) && !/WritingToolkitPlugin/.test(src)
    );
  }

  // 2. 宿主上下文文件存在且被四个 Shell 使用（statusbar 已走 Service，可例外）。
  r.check(
    "uiShellContext.ts 导出 UiShellContext 与分组端口",
    /export interface UiShellContext/.test(context) &&
      /readonly services: UiShellServices/.test(context) &&
      /readonly stats: UiShellStats/.test(context) &&
      /readonly prefs: UiShellPrefs/.test(context) &&
      /readonly nav: UiShellNavigation/.test(context) &&
      /readonly caps: UiShellCapabilities/.test(context)
  );
  for (const name of ["home.ts", "workbench.ts", "sidebar.ts", "mobileStatusBar.ts"]) {
    r.check(
      `${name} 只从 uiShellContext 取宿主能力`,
      /from "\.\/uiShellContext"/.test(shells[name])
    );
  }
  r.check(
    "statusbar.ts 只依赖 WordCountService 窄接口",
    /from "\.\/services\/wordCountService"/.test(statusbar) &&
      !/from "\.\/uiShellContext"/.test(statusbar)
  );

  // 3. 不 import 功能模块实现、不 import 兄弟 Shell。
  for (const [name, src] of Object.entries(shells)) {
    r.check(
      `${name} 不直接 import features/ 实现`,
      !/from "\.\/features\//.test(src)
    );
  }
  r.check(
    "home.ts 不与 workbench/sidebar 互相 import",
    !/from "\.\/workbench"/.test(home) && !/from "\.\/sidebar"/.test(home)
  );
  r.check(
    "workbench.ts 不与 home/sidebar 互相 import",
    !/from "\.\/home"/.test(workbench) && !/from "\.\/sidebar"/.test(workbench)
  );
  r.check(
    "sidebar.ts 不与 home/workbench 互相 import",
    !/from "\.\/home"/.test(sidebar) && !/from "\.\/workbench"/.test(sidebar)
  );
  r.check(
    "sidebar.ts 去掉 plugin: any 类型债",
    !/plugin:\s*any/.test(sidebar) && !/this\.plugin/.test(sidebar)
  );

  // 4. Shell 不注册命令 / 视图 / Ribbon，也不直接写 data.json。
  for (const [name, src] of Object.entries(shells)) {
    r.check(
      `${name} 不注册命令 / 视图 / Ribbon`,
      !/\.addCommand\(/.test(src) &&
        !/\.registerView\(/.test(src) &&
        !/addRibbonIcon\(/.test(src)
    );
    r.check(
      `${name} 不直接写 data.json`,
      !/\.saveData\(/.test(src) &&
        !/services\.persistence\.save\(/.test(src) &&
        !/super\.saveData/.test(src)
    );
  }

  // 5. 视图 id 与注册路径冻结。
  r.check(
    "三个视图 id 字面量未变（常量在 uiSlots，Shell 只再导出）",
    /export const WRITING_TOOLKIT_SIDEBAR = "writing-toolkit-sidebar"/.test(uiSlotsSource) &&
      /export const WRITING_TOOLKIT_WORKBENCH = "writing-toolkit-workbench"/.test(uiSlotsSource) &&
      /export const WRITING_TOOLKIT_HOME = "writing-toolkit-home"/.test(uiSlotsSource) &&
      /export \{ WRITING_TOOLKIT_SIDEBAR \} from "\.\/uiSlots"/.test(sidebar) &&
      /export \{ WRITING_TOOLKIT_WORKBENCH \} from "\.\/uiSlots"/.test(workbench) &&
      /export \{ WRITING_TOOLKIT_HOME \} from "\.\/uiSlots"/.test(home)
  );
  r.check(
    "main.ts 仍只注册三个视图并注入 Shell 上下文",
    (mainSource.match(/this\.host\.registerView\(/g) || []).length === 3 &&
      /new WritingToolkitSidebar\(leaf, this\.uiShellContext\)/.test(mainSource) &&
      /new WritingToolkitWorkbench\(leaf, this\.uiShellContext\)/.test(mainSource) &&
      /new WritingToolkitHome\(leaf, this\.uiShellContext\)/.test(mainSource)
  );
  r.check(
    "UI Shell 上下文只在 main.ts 组装一次",
    (mainSource.match(/this\.createUiShellContext\(\)/g) || []).length === 1 &&
      /this\.uiShellContext = this\.createUiShellContext\(\)/.test(mainSource)
  );

  // 6. 手机抽屉迁移与打开路径不变（真机路由 Platform.isMobile / 布局 isMobileUI 不可互换）。
  r.check(
    "NavigationService 保留手机端左右抽屉打开路径",
    /openInDrawer\(WRITING_TOOLKIT_SIDEBAR, "right"\)/.test(navSource) &&
      /openInDrawer\(WRITING_TOOLKIT_WORKBENCH, "left"\)/.test(navSource)
  );
  r.check(
    "启动自愈只在手机布局就绪时把工作台/工具箱挪回抽屉",
    /onLayoutReady\(\(\) => \{\s*if \(Platform\.isMobile\) this\.migrateMobileViewsToDrawers\(\);\s*\}\);/.test(
      mainSource
    ) &&
      /migrateMobileViewsToDrawers\(\)/.test(mainSource) &&
      /moveToDrawer\(WRITING_TOOLKIT_WORKBENCH, "left"\)/.test(navSource) &&
      /moveToDrawer\(WRITING_TOOLKIT_SIDEBAR, "right"\)/.test(navSource)
  );
  r.check(
    "主页不参与手机抽屉迁移",
    !/moveToDrawer\(WRITING_TOOLKIT_HOME/.test(navSource)
  );

  // 7. 手机状态条显示规则不变。
  r.check(
    "手机状态条仍受 isMobileUI / mobileStatusBar 设置 / 正文视图三重约束",
    /isMobileUI\(\)/.test(mobile) &&
      /mobileStatusBar === false/.test(mobile) &&
      /getActiveViewOfType\(MarkdownView\)/.test(mobile)
  );
  r.check(
    "手机状态条通过 EventScope 注册监听与计时器，销毁时释放",
    /this\.events\.onWorkspace\(/.test(mobile) &&
      /this\.events\.setInterval\(/.test(mobile) &&
      /destroy\(\): void \{[\s\S]*this\.events\.dispose\(\)[\s\S]*this\.el\?\.remove\(\)/.test(
        mobile
      )
  );
  r.check(
    "关闭 mobileBar 设置后立即隐藏",
    /syncVisibility\(\): void \{\s*this\.sync\(\);\s*\}/.test(mobile)
  );

  // 8. 阶段 6 债务收口：端口实现搬进 Service，main 只做接线。
  r.check(
    "Host Context 的 prefs / nav 端口直接由 Service 实现",
    /prefs: this\.prefs,/.test(mainSource) && /nav: this\.nav,/.test(mainSource) &&
      /class WorkspacePrefsService/.test(prefsSource) &&
      /class NavigationService/.test(navSource)
  );
  r.check(
    "统计读模型与状态栏广播由 StatsService 实现，main 不再手写 setState",
    /class StatsService/.test(statsSource) &&
      /this\.stats\.subscribe\(/.test(mainSource) &&
      !/this\.statusBar\.setState\(\{/.test(mainSource) &&
      /this\.stats\.publish\(\)/.test(mainSource)
  );
  r.check(
    "CalendarHandle 类型在 Service 层，UI Shell 不 import features 实现",
    /export interface CalendarHandle/.test(uiTypesSource) &&
      /CalendarHandle/.test(context) &&
      !/from "\.\/features\//.test(home) &&
      /from "\.\/services\/uiTypes"/.test(context)
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
