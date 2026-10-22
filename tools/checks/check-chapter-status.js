/**
 * 章节定稿锁检查（specs/chapter-final-lock.md）。
 *
 * 跑的都是真实实现：
 *   A. 编译 src/chapterLock.ts，用真实的 CodeMirror EditorState 跑过滤器：
 *      作者编辑事件（含输入法真实事件名 input.type.compose）被拦，
 *      没有作者事件标注的事务（Obsidian 加载文件、外部修改同步进编辑器）放行。
 *   B. 编译 src/features/chapterStatusModule.ts，注入假上下文：
 *      定稿 / 改回草稿、写入守卫、确认后临时解锁、标签页全部关闭才重新锁上、
 *      改名 / 移动 / 目录改名 / 删除时状态迁移、外部修改提示（只看正文、节流）、
 *      正文零写入、停用后全部放行。
 *   C. 源码级接线：data.json 读写、快照写回守卫、对比窗口只读、编辑工具条只留批注、
 *      硬换行 / 标点辅助带 userEvent、编辑台右键菜单。
 *
 * 反向验证（每条都实际跑过）：
 *   · 过滤器去掉 isAuthorEdit 判断（任何改动都拦）→「加载 / 外部同步放行」变红；
 *   · AUTHOR_EDIT_EVENTS 把 "input" 收窄成 "input.type" → 粘贴 / 拖入变红；
 *   · relockClosed 不看标签页、一有布局变化就锁 →「两个标签页只关一个仍解锁」变红；
 *   · 去掉 hardBreak 的 userEvent →「硬换行带 userEvent」变红。
 *
 * 不启动 Obsidian、不依赖 main.js、不联网。
 */
const fs = require("fs");
const path = require("path");

// 临时编译产物位于系统临时目录；让外置的 CodeMirror 解析回仓库依赖（同 check-hemingway-module.js）。
process.env.NODE_PATH = [
  path.resolve(__dirname, "..", "..", "node_modules"),
  process.env.NODE_PATH,
]
  .filter(Boolean)
  .join(path.delimiter);
require("module").Module._initPaths();

const H = require("./_harness");
const { EditorState } = require("@codemirror/state");

/** CodeMirror 外置：检查和被测代码必须用同一份 @codemirror/state，否则 instanceof 失效。 */
const CODEMIRROR_EXTERNALS = ["@codemirror/state", "@codemirror/view"];

function source(relPath) {
  return fs.readFileSync(path.join(H.ROOT, relPath), "utf8");
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function main() {
  const r = H.createReporter("章节定稿锁（真实实现）");

  // ── A. 过滤器（真实 CodeMirror） ─────────────────────────────
  {
    const lock = H.compile("src/chapterLock.ts", "chapter-lock", [
      "electron",
      ...CODEMIRROR_EXTERNALS,
    ]);
    let currentPath = "作品甲/正文/第1章.md";
    const lockedPaths = new Set([currentPath]);
    const blocked = [];
    const ext = lock.buildChapterLockExtension({
      isLocked: (p) => !!p && lockedPaths.has(p),
      pathOf: () => currentPath,
      onUnlockRequest() {},
      onBlocked: (p) => blocked.push(p),
    });
    const base = EditorState.create({ doc: "第一段。", extensions: [ext] });
    const tryEdit = (userEvent) =>
      base.update({
        changes: { from: base.doc.length, insert: "多写一句" },
        ...(userEvent ? { userEvent } : {}),
      }).state.doc.toString();

    const authorEvents = [
      "input.type",
      "input.type.compose",
      "input.paste",
      "input.drop",
      "input",
      "delete.backward",
      "delete.cut",
      "undo",
      "redo",
      "move.drop",
    ];
    const leaked = authorEvents.filter((ev) => tryEdit(ev) !== "第一段。");
    r.check(
      "定稿章节：打字、输入法、粘贴、拖入、回车、删除、剪切、撤销、重做、拖动都改不了正文",
      leaked.length === 0,
      "漏过：" + leaked.join(", ")
    );
    r.check("被拦时回调 onBlocked（用来闪提示条）", blocked.length === authorEvents.length);

    r.check(
      "没有作者事件标注的事务放行（Obsidian 加载文件 / 外部修改同步进编辑器）",
      tryEdit(null) === "第一段。多写一句"
    );
    r.check("选区移动等非编辑事件放行", tryEdit("select") === "第一段。多写一句");

    lockedPaths.clear();
    r.check("临时解锁（不再锁定）后可以编辑", tryEdit("input.type") === "第一段。多写一句");
    lockedPaths.add(currentPath);
    currentPath = "作品甲/正文/第2章.md";
    r.check("草稿章节不受影响", tryEdit("input.type") === "第一段。多写一句");

    const selectOnly = base.update({ selection: { anchor: 0 }, userEvent: "select" });
    r.check("isAuthorEdit 只认真的改了文档的事务", lock.isAuthorEdit(selectOnly) === false);
  }

  // ── B. 模块（注入假上下文） ──────────────────────────────────
  {
    const notices = [];
    const opened = [];
    const writes = [];
    class TFile {}
    class Modal {
      constructor(app) {
        this.app = app;
      }
      open() {
        opened.push(this);
      }
      close() {}
    }
    const restore = H.stubObsidian({
      editorInfoField: {},
      Notice: class {
        constructor(message) {
          notices.push(message);
        }
      },
      setIcon() {},
      TFile,
      Modal,
      Setting: class {},
    });
    let mod;
    try {
      mod = H.compile("src/features/chapterStatusModule.ts", "chapter-status-module", [
        "electron",
        ...CODEMIRROR_EXTERNALS,
      ]);
    } finally {
      restore();
    }

    const files = {};
    const fileAt = (p) => (p in files ? Object.assign(new TFile(), { path: p }) : null);
    const finals = {};
    let saved = 0;
    const guards = [];
    const disposers = [];
    const handlers = { vault: {}, workspace: {}, layout: [] };
    let leaves = [];
    const spy = (name) => async () => {
      writes.push(name);
    };
    const context = {
      app: {
        vault: {
          getAbstractFileByPath: fileAt,
          cachedRead: async (file) => files[file.path],
          modify: spy("vault.modify"),
          process: spy("vault.process"),
          create: spy("vault.create"),
          adapter: { write: spy("adapter.write") },
        },
      },
      services: {
        editor: {
          getMarkdownEditorViews: () => [],
          registerWriteGuard(guard) {
            guards.push(guard);
            return () => guards.splice(guards.indexOf(guard), 1);
          },
        },
        ui: { leaves: () => leaves },
      },
      registrations: { registerEditorExtension() {} },
      events: {
        onVault(name, fn) {
          handlers.vault[name] = fn;
          return () => {};
        },
        onWorkspace(name, fn) {
          (handlers.workspace[name] = handlers.workspace[name] || []).push(fn);
          return () => {};
        },
        onLayoutReady(fn) {
          handlers.layout.push(fn);
          return () => {};
        },
      },
      effects: { add: (fn) => disposers.push(fn) },
      log: console,
    };
    const fire = (name) => (handlers.workspace[name] || []).forEach((fn) => fn());
    const guardReason = (p) => guards.map((g) => g(p)).find(Boolean) || null;
    const tab = (p) => ({ view: { file: { path: p } } });

    const module = mod.createChapterStatusModule({
      finals: () => finals,
      onChanged: () => saved++,
    });
    module.activate(context);
    const ops = module.operations;
    let notified = 0;
    ops.subscribe(() => notified++);

    const ch1 = "作品甲/第1卷/第1章.md";
    files[ch1] = "---\noutline: 旧章纲\n---\n第一章正文。";
    ops.setFinal(ch1, true);
    r.check(
      "设为定稿：写进状态表并请求落盘、通知订阅者",
      finals[ch1] === "final" && saved === 1 && notified === 1
    );
    r.check(
      "定稿章节锁定，写入守卫给出原因",
      ops.isLocked(ch1) && guardReason(ch1) === mod.CHAPTER_LOCKED_REASON
    );
    r.check("草稿章节不锁、守卫放行", !ops.isLocked("作品甲/第1卷/第2章.md") && guardReason("作品甲/第1卷/第2章.md") === null);

    ops.requestUnlock(ch1);
    r.check("点临时解锁先弹一次确认，确认前仍锁定", opened.length === 1 && ops.isLocked(ch1));
    opened[0].onConfirm();
    r.check("确认后临时解锁：可编辑、守卫放行、状态仍是定稿", !ops.isLocked(ch1) && guardReason(ch1) === null && ops.isFinal(ch1));

    leaves = [tab(ch1), tab(ch1)];
    fire("layout-change");
    leaves = [tab(ch1)];
    fire("layout-change");
    r.check("两个标签页都开着这章，只关一个：仍是解锁", !ops.isLocked(ch1));
    leaves = [tab("作品甲/第1卷/第2章.md")];
    fire("file-open");
    r.check("同一标签页跳到别的文件（这章不再开着）：重新锁上", ops.isLocked(ch1));
    opened[0].onConfirm();
    leaves = [];
    fire("layout-change");
    r.check("标签页全部关闭：重新锁上", ops.isLocked(ch1));

    // 改名 / 移动 / 目录改名 / 删除
    const before = saved;
    handlers.vault.rename({ path: "作品甲/第1卷/第一章 开端.md" }, ch1);
    const renamed = "作品甲/第1卷/第一章 开端.md";
    r.check(
      "章节改名：状态跟着走，旧路径清掉",
      finals[renamed] === "final" && !(ch1 in finals) && ops.isLocked(renamed) && saved === before + 1
    );
    handlers.vault.rename({ path: "作品甲/第2卷" }, "作品甲/第1卷");
    const moved = "作品甲/第2卷/第一章 开端.md";
    r.check("所在目录改名：目录下的定稿章节一起搬", finals[moved] === "final" && !(renamed in finals));
    handlers.vault.rename({ path: "作品甲/第2卷/别的.md" }, "作品甲/第2卷/无关.md");
    r.check("无关文件改名不动状态表", Object.keys(finals).length === 1 && finals[moved] === "final");

    const ch5 = "作品乙/正文/第5章.md";
    files[ch5] = "第五章。";
    ops.setFinal(ch5, true);
    handlers.vault.delete({ path: ch5 });
    r.check("删除章节：状态一并清掉", !(ch5 in finals));
    handlers.vault.delete({ path: "作品甲" });
    r.check("删除整个目录：目录下的状态都清掉", Object.keys(finals).length === 0);

    // 外部修改提示
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const ch3 = "作品丙/正文/第3章.md";
      files[ch3] = "---\noutline: 章纲一\n---\n第三章正文。";
      ops.setFinal(ch3, true);
      await tick();
      await tick();
      files[ch3] = "---\noutline: 章纲二\n---\n第三章正文。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await tick();
      r.check("只改了 frontmatter（如章纲存在 frontmatter）：不提示", notices.length === 0, notices.join(" | "));

      files[ch3] = "---\noutline: 章纲二\n---\n第三章正文，被 Agent 改过。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await tick();
      r.check(
        "定稿章节正文被外部改了：提示一次，状态仍是定稿",
        notices.length === 1 && /第3章/.test(notices[0]) && ops.isFinal(ch3),
        notices.join(" | ")
      );
      now += 10_000;
      files[ch3] += "又改一句。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await tick();
      r.check("1 分钟内同一章再被改：不重复提示", notices.length === 1);
      now += 61_000;
      files[ch3] += "再改一句。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await tick();
      r.check("超过 1 分钟再被改：再提示一次", notices.length === 2);

      ops.unlock(ch3);
      now += 120_000;
      files[ch3] += "作者自己改。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await tick();
      r.check("临时解锁期间作者自己改（Obsidian 保存）：不提示", notices.length === 2);
      leaves = [];
      fire("layout-change");
      now += 2_000;
      files[ch3] += "关标签页时补存。";
      await handlers.vault.modify({ path: ch3, name: "第3章.md" });
      await tick();
      r.check("刚重新锁上时 Obsidian 补存解锁期间的改动：不提示", notices.length === 2);

      const draft = "作品丙/正文/第4章.md";
      files[draft] = "草稿。";
      await handlers.vault.modify({ path: draft, name: "第4章.md" });
      await tick();
      r.check("草稿章节被改：不提示", notices.length === 2);

      ops.setFinal(ch3, false);
      r.check("改回草稿：状态清掉、不再锁定", !(ch3 in finals) && !ops.isLocked(ch3));
    } finally {
      Date.now = realNow;
    }

    r.check("全程没有写过任何文件（正文、frontmatter 零写入）", writes.length === 0, writes.join(", "));

    ops.setFinal("作品丁/第9章.md", true);
    for (const dispose of disposers.splice(0).reverse()) dispose();
    r.check(
      "模块停用：不再锁定，写入守卫撤掉",
      !ops.isLocked("作品丁/第9章.md") && guards.length === 0
    );
  }

  // ── C. 源码级接线 ──────────────────────────────────────────
  {
    const mainSource = source("src/main.ts");
    const persist = H.extractMethod(mainSource, "private persistPluginData()");
    const load = H.extractMethod(mainSource, "private async loadPluginData()");
    r.check(
      "data.json 读写都带 chapterStatus，读取时只认 \"final\"",
      /chapterStatus:\s*this\.chapterStatus/.test(persist) &&
        /data\.chapterStatus/.test(load) &&
        /value === "final"/.test(load)
    );

    const lockSource = source("src/chapterLock.ts");
    r.check(
      "过滤器只拦作者编辑事件，不一刀切拦所有改动",
      /if \(!isAuthorEdit\(tr\)\) return tr;/.test(lockSource) &&
        /"input", "delete", "undo", "redo", "move\.drop"/.test(lockSource)
    );
    r.check("锁定状态每次现问 isLocked，不靠缓存拦截", /config\.isLocked\(path\)/.test(lockSource));
    r.check("顶部提示条走 CodeMirror 顶部面板（不随正文滚动）", /showPanel\.from/.test(lockSource) && /top: true/.test(lockSource));

    const diffSource = source("src/snapshotDiff.ts");
    const restoreFn = H.extractMethod(diffSource, "export async function performRestore(");
    const applyFn = H.extractMethod(diffSource, "export async function applySnapshotContent(");
    const guarded = (fn) =>
      fn.indexOf("writeBlockReason") >= 0 &&
      fn.indexOf("writeBlockReason") < fn.indexOf("replaceEditorText(");
    r.check("快照「恢复」与对比窗口写回：写之前先问写入守卫", guarded(restoreFn) && guarded(applyFn));
    r.check(
      "对比窗口：定稿锁定中右栏只读",
      /const locked = this\.host\.writeBlockReason\?\.\(this\.sourcePath\)/.test(diffSource) &&
        /setAttr\("contenteditable", "false"\)/.test(diffSource)
    );
    r.check(
      "快照 UI 把写入守卫接进 host",
      /writeBlockReason: \(path\) => context\.services\.editor\.writeBlockReason\(path\)/.test(
        source("src/features/snapshotUiModule.ts")
      )
    );

    const toolbar = source("src/formatToolbar.ts");
    r.check(
      "编辑工具条：锁定中收起格式按钮，批注照常",
      /const formatOk = scopeOk && !\(config\.isWriteBlocked\?\.\(path\) \?\? false\)/.test(toolbar) &&
        /\(scopeOk \|\| \(config\.commentBubbleEverywhere/.test(toolbar) &&
        /isWriteBlocked: \(path\) =>\s*context\.services\.editor\.writeBlockReason\(path\) !== null/.test(
          source("src/features/formatToolbarModule.ts")
        )
    );

    r.check(
      "硬换行写入带 userEvent（过滤器才认得出是作者输入）",
      /insert: "\\n\\n" \},[\s\S]{0,120}userEvent: "input"/.test(source("src/hardBreak.ts"))
    );
    const punct = source("src/punctuation.ts");
    r.check(
      "标点辅助的两处改文档写入都带 userEvent",
      (punct.match(/userEvent: "input\.type"/g) || []).length === 2
    );

    const workbench = source("src/workbench.ts");
    r.check(
      "编辑台右键菜单切换「设为定稿 / 改回草稿」，行上有锁标记",
      /isFinal \? "改回草稿" : "设为定稿"/.test(workbench) &&
        /caps\.chapterStatus\.setFinal\(/.test(workbench) &&
        /wt-wb-ch-lock/.test(workbench)
    );
    r.check(
      "定稿模块不注册命令",
      !/addCommand\(/.test(source("src/features/chapterStatusModule.ts"))
    );
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
