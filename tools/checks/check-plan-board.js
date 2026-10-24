/**
 * 检查：写作计划看板（src/planBoard.ts 纯函数 + src/features/planBoardModule.ts 真实实现）。
 *
 * - 看板文件解析 / 写回往返不丢行（认不出的行、附属行、手写的乱序段落）
 * - 新增、跨列移动、改文字 / 日期、删除与撤销
 * - 进「完成」写完成日，出「完成」去掉完成日
 * - 日期判定（逾期 / 今天 / 明天 / 一周内）、书桌摘要的筛选与排序
 * - 看板 v2：列内 / 跨列插到指定位置、同原文条目拖动不串位、作品 / 章节 / 备注的解析与写回
 * - 看板 v3：整行链接 = 章节卡（解析、写回、添加、不能清掉章节）；看板挪动与定稿联动的接线
 * - 模块：文件不存在时读为空、第一次添加才创建、写回走 vault.process、文件变动通知订阅者
 * - 新设置项按默认值加载
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const TODAY = "2026-10-22";

async function main() {
  const r = H.createReporter("写作计划看板");
  const P = H.compile("src/planBoard.ts", "plan-board");

  // ── A. 解析与往返 ────────────────────────────────────────────
  const handWritten = [
    "> 说明文字，不能丢",
    "",
    "## 在写",
    "- [ ] 第三卷大纲 📅 2026-10-30",
    "  - 附属行：先列人物",
    "随手写的一句话",
    "",
    "## 完成",
    "- [x] 修改第十一章节奏 ✅ 2026-10-21",
    "- [x] 很早以前的事",
    "",
    "### 待写",
    "- [ ] 第十二章打斗收尾 📅 2026-10-25",
    "- [ ] 整理配角设定",
    "- [x] 在待写里手勾的",
    "",
    "## 别的标题",
    "- [ ] 别的标题下的条目算在上一列",
    "",
  ].join("\n");

  {
    const items = P.parsePlanBoard(handWritten);
    const by = (col) => items.filter((i) => i.column === col).map((i) => i.text);
    r.check(
      "乱序段落按标题归列（标题级别不限）",
      by("todo").join("|") === "第十二章打斗收尾|整理配角设定|别的标题下的条目算在上一列" &&
        by("doing").join("|") === "第三卷大纲" &&
        by("done").join("|") === "修改第十一章节奏|很早以前的事|在待写里手勾的",
      JSON.stringify(items.map((i) => [i.column, i.text]))
    );
    const outline = items.find((i) => i.text === "第三卷大纲");
    r.check(
      "日期从文字里拆出来",
      outline && outline.due === "2026-10-30" && outline.doneAt === null
    );
    const done = items.find((i) => i.text === "修改第十一章节奏");
    r.check("完成日读出", done && done.doneAt === "2026-10-21");
    r.check(
      "附属行不算独立条目",
      !items.some((i) => i.text.includes("附属行"))
    );
  }

  {
    // 改一个条目，其余行一个字不动
    const items = P.parsePlanBoard(handWritten);
    const target = items.find((i) => i.text === "整理配角设定");
    const after = P.editPlanItem(handWritten, target.key, { due: "2026-10-24" });
    const before = handWritten.split("\n");
    const lines = after.split("\n");
    const changed = lines.filter((line, i) => line !== before[i]);
    r.check(
      "改日期只动那一行，认不出的行与说明原样保留",
      lines.length === before.length &&
        changed.length === 1 &&
        changed[0] === "- [ ] 整理配角设定 📅 2026-10-24",
      JSON.stringify(changed)
    );
    r.check("无改动时原样返回", P.editPlanItem(handWritten, "不存在\u00000", { due: null }) === handWritten);
  }

  // ── B. 新增 / 移动 / 删除 / 撤销 ──────────────────────────────
  {
    let doc = P.PLAN_BOARD_TEMPLATE;
    doc = P.addPlanItem(doc, "todo", "写第一章", null, TODAY);
    doc = P.addPlanItem(doc, "todo", "写第二章", "2026-10-23", TODAY);
    doc = P.addPlanItem(doc, "doing", "改设定", null, TODAY);
    r.check(
      "新增加在该列末尾，紧贴标题",
      doc.includes("## 待写\n- [ ] 写第一章\n- [ ] 写第二章 📅 2026-10-23\n\n## 在写\n- [ ] 改设定\n"),
      JSON.stringify(doc)
    );
    r.check("空文字不新增", P.addPlanItem(doc, "todo", "   ", null, TODAY) === doc);
    r.check(
      "文字里的换行和日期记号被清掉，不会写坏格式",
      P.addPlanItem("", "todo", "第一行\n第二行 📅 2020-01-01", null, TODAY).includes("- [ ] 第一行 第二行\n")
    );

    const first = P.parsePlanBoard(doc).find((i) => i.text === "写第一章");
    const moved = P.movePlanItem(doc, first.key, "done", TODAY);
    const movedItem = P.parsePlanBoard(moved).find((i) => i.text === "写第一章");
    r.check(
      "挪进「完成」：勾上并写完成日",
      movedItem.column === "done" &&
        movedItem.doneAt === TODAY &&
        moved.includes("## 完成\n- [x] 写第一章 ✅ 2026-10-22")
    );
    const back = P.movePlanItem(moved, movedItem.key, "doing", TODAY);
    const backItem = P.parsePlanBoard(back).find((i) => i.text === "写第一章");
    r.check(
      "挪出「完成」：取消勾选并去掉完成日",
      backItem.column === "doing" && backItem.doneAt === null && !back.includes("✅"),
      JSON.stringify(back)
    );

    const withChild = "## 待写\n- [ ] 父条目\n  - 子行\n## 在写\n";
    const parent = P.parsePlanBoard(withChild)[0];
    const movedChild = P.movePlanItem(withChild, parent.key, "doing", TODAY);
    r.check(
      "附属行跟着条目挪列",
      movedChild === "## 待写\n## 在写\n- [ ] 父条目\n  - 子行\n",
      JSON.stringify(movedChild)
    );

    const noDoing = "## 待写\n- [ ] 孤零零\n";
    const created = P.movePlanItem(noDoing, P.parsePlanBoard(noDoing)[0].key, "doing", TODAY);
    r.check(
      "目标列标题不存在时在文末补上",
      created === "## 待写\n\n## 在写\n- [ ] 孤零零\n",
      JSON.stringify(created)
    );

    const second = P.parsePlanBoard(doc).find((i) => i.text === "写第二章");
    const { content: removedDoc, removed } = P.removePlanItem(doc, second.key);
    r.check("删除后条目不在了", !removedDoc.includes("写第二章") && removed);
    r.check(
      "撤销删除放回原位置，文件与删除前一致",
      P.restorePlanItem(removedDoc, removed) === doc
    );

    // 同原文的两条：按出现次序定位，不会改错
    const twins = "## 待写\n- [ ] 同名\n- [ ] 同名\n";
    const [, secondTwin] = P.parsePlanBoard(twins);
    r.check(
      "同原文条目按次序定位",
      P.editPlanItem(twins, secondTwin.key, { due: "2026-11-01" }) ===
        "## 待写\n- [ ] 同名\n- [ ] 同名 📅 2026-11-01\n"
    );
    r.check(
      "保留原文末尾是否有换行（CRLF 读成 LF）",
      P.editPlanItem("## 待写\r\n- [ ] 甲", "- [ ] 甲\u00000", { text: "乙" }) === "## 待写\n- [ ] 乙"
    );
  }

  // ── C. 日期与排序 ────────────────────────────────────────────
  {
    r.check(
      "逾期 / 今天 / 两天内 / 更晚",
      P.planDueState("2026-10-21", TODAY) === "overdue" &&
        P.planDueState(TODAY, TODAY) === "today" &&
        P.planDueState("2026-10-24", TODAY) === "soon" &&
        P.planDueState("2026-10-25", TODAY) === "later"
    );
    r.check(
      "日期口语写法",
      P.planDateLabel(TODAY, TODAY) === "今天" &&
        P.planDateLabel("2026-10-23", TODAY) === "明天" &&
        P.planDateLabel("2026-10-21", TODAY) === "昨天" &&
        P.planDateLabel("2026-10-24", TODAY) === "周六" &&
        P.planDateLabel("2026-11-05", TODAY) === "11月5日" &&
        P.planDateLabel("2027-01-03", TODAY) === "2027年1月3日"
    );
    r.check(
      "跨月 / 跨年按日历日算差",
      P.planDayDiff("2026-12-31", "2027-01-01") === 1 &&
        P.planDayDiff("2026-03-28", "2026-03-30") === 2
    );

    const doc = [
      "## 待写",
      "- [ ] 无日期甲",
      "- [ ] 晚 📅 2026-11-01",
      "- [ ] 早 📅 2026-10-20",
      "- [ ] 无日期乙",
      "## 在写",
      "- [ ] 在写无日期",
      "## 完成",
      "- [x] 旧 ✅ 2026-10-01",
      "- [x] 新 ✅ 2026-10-22",
      "- [x] 手勾无日期",
    ].join("\n");
    const items = P.parsePlanBoard(doc);
    r.check(
      "列内顺序就是文件行序，日期不改变顺序",
      P.columnItems(items, "todo").map((i) => i.text).join("|") === "无日期甲|晚|早|无日期乙" &&
        P.columnItems(items, "done").map((i) => i.text).join("|") === "旧|新|手勾无日期"
    );
    const recent = items.filter((i) => P.isRecentlyDone(i, TODAY)).map((i) => i.text);
    r.check("「完成」只展开最近 7 天的", recent.join("|") === "新");
    r.check(
      "书桌摘要：逾期 / 今天到期在前，再是在写；不含未到期的待写与完成",
      P.planFocusItems(items, TODAY).map((i) => i.text).join("|") === "早|在写无日期"
    );
  }

  // ── C2. 看板 v2：拖动排序、卡片字段 ──────────────────────────
  {
    const doc = "## 待写\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n## 在写\n- [ ] 丁\n## 完成\n- [x] 戊 ✅ 2026-10-20\n";
    const k = (text) => P.parsePlanBoard(doc).find((i) => i.text === text).key;
    const order = (content, col) =>
      P.columnItems(P.parsePlanBoard(content), col).map((i) => i.text).join("");
    r.check(
      "列内上移：丙插到甲前面",
      order(P.movePlanItem(doc, k("丙"), "todo", TODAY, { before: k("甲") }), "todo") === "丙甲乙"
    );
    r.check(
      "列内下移到列尾",
      order(P.movePlanItem(doc, k("甲"), "todo", TODAY, "end"), "todo") === "乙丙甲"
    );
    const cross = P.movePlanItem(doc, k("乙"), "doing", TODAY, { before: k("丁") });
    r.check(
      "跨列插到指定卡片前面",
      order(cross, "todo") === "甲丙" && order(cross, "doing") === "乙丁"
    );
    const toDoneTop = P.movePlanItem(doc, k("甲"), "done", TODAY);
    const toDoneEnd = P.movePlanItem(doc, k("甲"), "done", TODAY, "end");
    r.check(
      "勾完成默认排到「完成」最上面；拖到列尾则在最下面",
      order(toDoneTop, "done") === "甲戊" && order(toDoneEnd, "done") === "戊甲"
    );
    r.check(
      "拖到自己前面 / 落点卡片已不在：原样不动",
      P.movePlanItem(doc, k("甲"), "todo", TODAY, { before: k("甲") }) === doc &&
        P.movePlanItem(doc, k("甲"), "todo", TODAY, { before: "不存在\u00000" }) === doc
    );
    const twins = "## 待写\n- [ ] 同\n- [ ] 中\n- [ ] 同\n";
    const [first, , second] = P.parsePlanBoard(twins);
    r.check(
      "同原文条目：把第一张拖到第二张前面，不串位",
      P.movePlanItem(twins, first.key, "todo", TODAY, { before: second.key }) ===
        "## 待写\n- [ ] 中\n- [ ] 同\n- [ ] 同\n"
    );

    const rich = [
      "## 在写",
      "- [ ] 第十二章打斗收尾 [[第十二章 夜雨]] 📚 雾港来信 📅 2026-10-25",
      "  先写主角受伤",
      "  - 再写援兵到",
      "- [ ] 看 [[人物设定]] 里的年龄",
      "- [ ] [[只有链接]]",
    ].join("\n");
    const [a, b, c] = P.parsePlanBoard(rich);
    r.check(
      "解析作品、行尾章节链接、备注",
      a.text === "第十二章打斗收尾" &&
        a.chapter === "第十二章 夜雨" &&
        a.book === "雾港来信" &&
        a.due === "2026-10-25" &&
        a.notes.join("|") === "先写主角受伤|- 再写援兵到",
      JSON.stringify(a)
    );
    r.check(
      "正文中间的链接不拆成章节，仍是普通卡",
      b.kind === "task" && b.text === "看 [[人物设定]] 里的年龄" && b.chapter === null &&
        a.kind === "task"
    );
    r.check(
      "整行只有链接：章节卡，标题取链接名",
      c.kind === "chapter" && c.chapter === "只有链接" && c.text === "只有链接"
    );
    const edited = P.editPlanItem(rich, b.key, {
      book: "雾港来信",
      chapter: "第三章",
      notes: "第一行\n\n第二行",
    });
    r.check(
      "写回顺序：正文 [[章节]] 📚 作品；备注写成缩进行（空行去掉），其他行不动",
      edited.split("\n").slice(4).join("\n") ===
        "- [ ] 看 [[人物设定]] 里的年龄 [[第三章]] 📚 雾港来信\n  第一行\n  第二行\n- [ ] [[只有链接]]" &&
        edited.split("\n").slice(0, 4).join("\n") === rich.split("\n").slice(0, 4).join("\n"),
      JSON.stringify(edited)
    );
    const cleared = P.editPlanItem(rich, a.key, { book: null, chapter: null, notes: "", due: null });
    r.check(
      "清除作品 / 章节 / 备注 / 日期",
      cleared.startsWith("## 在写\n- [ ] 第十二章打斗收尾\n- [ ] 看"),
      JSON.stringify(cleared)
    );
    const both = P.editPlanItem(rich, a.key, { text: "改了标题", column: "done" }, TODAY);
    const moved = P.parsePlanBoard(both).find((i) => i.text === "改了标题");
    r.check(
      "详情里同时改标题和换列：一次完成，备注跟着走",
      moved && moved.column === "done" && moved.doneAt === TODAY && moved.notes.length === 2,
      JSON.stringify(both)
    );
    r.check(
      "新增带作品（筛选中添加）",
      P.addPlanItem("", "todo", "整理伏笔", null, TODAY, "雾港来信").includes("- [ ] 整理伏笔 📚 雾港来信")
    );
  }

  // ── C3. 章节卡 ────────────────────────────────────────────
  {
    const doc = [
      "## 待写",
      "- [ ] [[第十二章 夜雨]] 📚 雾港来信 📅 2026-10-25",
      "  先写受伤",
      "- [ ] [[正文/第一卷/第十三章|十三章]]",
      "## 在写",
      "## 完成",
    ].join("\n");
    const [ch12, ch13] = P.parsePlanBoard(doc);
    r.check(
      "章节卡带作品 / 日期 / 备注",
      ch12.kind === "chapter" && ch12.text === "第十二章 夜雨" && ch12.chapter === "第十二章 夜雨" &&
        ch12.book === "雾港来信" && ch12.due === "2026-10-25" && ch12.notes[0] === "先写受伤"
    );
    r.check(
      "章节卡标题：有别名用别名，否则取路径最后一段",
      ch13.text === "十三章" &&
        P.planChapterName("正文/第一卷/第十四章#开头") === "第十四章"
    );
    const moved = P.movePlanItem(doc, ch12.key, "done", TODAY);
    r.check(
      "章节卡挪进完成：写回仍是整行链接，作品 / 日期 / 备注跟着走",
      moved.includes("## 完成\n- [x] [[第十二章 夜雨]] 📚 雾港来信 📅 2026-10-25 ✅ 2026-10-22\n  先写受伤"),
      JSON.stringify(moved)
    );
    const added = P.addPlanItem(doc, "doing", "", null, TODAY, "雾港来信", "第十五章");
    r.check(
      "添加章节卡（文字为空 + 章节）",
      added.includes("## 在写\n- [ ] [[第十五章]] 📚 雾港来信\n") &&
        P.parsePlanBoard(added).some((i) => i.kind === "chapter" && i.chapter === "第十五章")
    );
    r.check(
      "既没文字也没章节不添加",
      P.addPlanItem(doc, "doing", "  ", null, TODAY, "雾港来信", null) === doc
    );
    r.check(
      "章节卡不能把章节清掉（会变成空卡）；换一章可以",
      P.editPlanItem(doc, ch12.key, { chapter: null }) === doc &&
        P.editPlanItem(doc, ch12.key, { chapter: "第十二章 雨夜" }).includes("- [ ] [[第十二章 雨夜]] 📚 雾港来信")
    );
  }

  // ── D. 路径 ────────────────────────────────────────────────
  r.check(
    "看板路径：留空时放在「写作」文件夹根目录（共用资料库的上一级）",
    P.resolvePlanBoardPath("", "1-写作/1. 共用资料库") === "1-写作/写作看板.md" &&
      P.resolvePlanBoardPath("", "写作/资料库") === "写作/写作看板.md" &&
      P.resolvePlanBoardPath("", "资料库") === "写作看板.md"
  );
  r.check(
    "看板路径：自定义路径补 .md、去掉开头斜杠",
    P.resolvePlanBoardPath("/计划/看板", "x/y") === "计划/看板.md" &&
      P.resolvePlanBoardPath("计划.md", "x/y") === "计划.md"
  );

  // ── E. 模块（假 vault） ──────────────────────────────────────
  {
    class TFile {
      constructor(p) {
        this.path = p;
      }
    }
    class TFolder {
      constructor(p) {
        this.path = p;
      }
    }
    const restore = H.stubObsidian({ TFile, TFolder, normalizePath: (p) => p });
    let M;
    try {
      M = H.compile("src/features/planBoardModule.ts", "plan-board-module", ["obsidian"]);
    } finally {
      restore();
    }
    const files = new Map();
    const folders = new Set();
    let processCalls = 0;
    const vault = {
      getAbstractFileByPath(p) {
        if (files.has(p)) return new TFile(p);
        if (folders.has(p)) return new TFolder(p);
        return null;
      },
      async createFolder(p) {
        folders.add(p);
      },
      async create(p, content) {
        files.set(p, content);
        emit("create", new TFile(p));
        return new TFile(p);
      },
      async cachedRead(file) {
        return files.get(file.path);
      },
      async process(file, fn) {
        processCalls++;
        const next = fn(files.get(file.path));
        files.set(file.path, next);
        emit("modify", new TFile(file.path));
        return next;
      },
    };
    const handlers = {};
    function emit(name, ...args) {
      for (const h of handlers[name] || []) h(...args);
    }
    const settings = { planBoardFile: "", sharedLibraryFolder: "1-写作/1. 共用资料库" };
    const settingsListeners = [];
    const disposers = [];
    const ctx = {
      app: { vault, workspace: {} },
      services: {
        settings: {
          get: () => settings,
          subscribe: (fn) => {
            settingsListeners.push(fn);
            return () => {};
          },
        },
      },
      events: {
        onVault: (name, fn) => {
          (handlers[name] = handlers[name] || []).push(fn);
        },
      },
      effects: { add: (fn) => disposers.push(fn) },
    };
    const mod = M.createPlanBoardModule();
    await mod.activate(ctx);
    const ops = mod.operations;
    let notified = 0;
    ops.subscribe(() => notified++);

    r.check("模块 id 为 plan-board", mod.id === "plan-board");
    r.check("默认路径落在「1-写作」根目录", ops.path() === "1-写作/写作看板.md");
    r.check(
      "文件不存在：读为空、不创建",
      (await ops.load()).length === 0 && files.size === 0
    );
    await ops.move("不存在\u00000", "done");
    r.check("文件不存在时移动什么都不做", files.size === 0 && processCalls === 0);

    await ops.add("todo", "写第一章");
    r.check(
      "第一次添加才创建文件（含三列模板）并写进条目",
      files.has("1-写作/写作看板.md") &&
        files.get("1-写作/写作看板.md").includes("## 待写\n- [ ] 写第一章\n## 在写".replace("\n## 在写", "\n\n## 在写"))
    );
    r.check("写回走 vault.process", processCalls === 1);
    r.check("文件创建 / 修改通知订阅者", notified >= 2);

    const item = (await ops.load())[0];
    const removed = await ops.remove(item.key);
    r.check("删除返回可撤销的内容", removed && !(await ops.load()).length);
    await ops.restore(removed);
    r.check("撤销后条目回来", (await ops.load())[0].text === "写第一章");

    const before = notified;
    emit("modify", new TFile("别的文件.md"));
    r.check("别的文件变动不通知", notified === before);
    emit("rename", new TFile("改名后.md"), "1-写作/写作看板.md");
    r.check("看板文件改名（旧路径命中）通知", notified === before + 1);
    settingsListeners.forEach((fn) => fn({ keys: ["planBoardFile"] }));
    r.check("设置里的路径变了通知", notified === before + 2);
    settings.planBoardFile = "计划/我的看板";
    r.check("自定义路径生效", ops.path() === "计划/我的看板.md");

    disposers.reverse().forEach((fn) => fn());
    r.check("停用后不再通知", (emit("modify", new TFile("计划/我的看板.md")), notified === before + 2));
  }

  // ── F. 设置与接线（源码级） ───────────────────────────────────
  {
    const restore = H.stubObsidian({});
    let schema;
    let settingsService;
    try {
      schema = H.compile("src/settingsSchema.ts", "plan-board-schema", ["electron"]);
      settingsService = H.compile("src/services/settingsService.ts", "plan-board-settings", ["electron"]);
    } finally {
      restore();
    }
    r.check("planBoardFile 默认为空（自动放在写作文件夹根目录）", schema.DEFAULT_SETTINGS.planBoardFile === "");
    const merged = settingsService.mergeSettingsFromData({ settings: { planBoardFile: "计划.md" } });
    const fallback = settingsService.mergeSettingsFromData({ settings: { dailyGoal: 3000 } });
    r.check(
      "planBoardFile 读回用户值，缺失时回落默认",
      merged.planBoardFile === "计划.md" && fallback.planBoardFile === ""
    );

    const read = (p) => fs.readFileSync(path.join(H.ROOT, p), "utf8");
    const home = read("src/home.ts");
    const mod = read("src/features/planBoardModule.ts");
    r.check(
      "主页通过 caps.planBoard 使用看板，不 import 模块实现",
      /this\.host\.caps\.planBoard/.test(home) && !/features\/planBoardModule/.test(home)
    );
    r.check(
      "看板页在导航里、书桌有计划卡",
      /\{ key: "board", label: "看板"/.test(home) && /renderDeskPlan\(sideCol\)/.test(home)
    );
    r.check(
      "看板只在桌面端：手机端不显示导航项与书桌计划卡",
      /def\.key === "board" && Platform\.isMobile/.test(home) &&
        /if \(!Platform\.isMobile\) this\.renderDeskPlan\(sideCol\)/.test(home)
    );
    const sync = H.extractMethod(home, "private syncChapterFinal(");
    const move = H.extractMethod(home, "private movePlan(");
    r.check(
      "章节卡进出「完成」同步定稿：所有挪动都走 movePlan，movePlan 写完后调 syncChapterFinal",
      /\.then\(\(\) => this\.syncChapterFinal\(item, column\)\)/.test(move) &&
        /chapterStatus/.test(sync) && /setFinal\(file\.path, final\)/.test(sync) &&
        !/planBoard\.move\(/.test(home.replace(move, "")) &&
        !/board\.move\(/.test(home.replace(move, ""))
    );
    r.check(
      "详情窗改列也联动定稿",
      /if \(patch\.column\) this\.syncChapterFinal\(item, patch\.column\)/.test(home)
    );
    r.check(
      "点章节卡直接打开那一章（找不到才开详情）",
      /if \(chapterFile\) this\.openPlanChapter\(item\);\s*else this\.openPlanDetail\(item\);/.test(home)
    );
    r.check(
      "模块不写 data.json、不注册命令",
      !/saveData|persistence|addCommand/.test(mod)
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
