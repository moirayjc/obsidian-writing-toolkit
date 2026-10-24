/**
 * 跨设备字数统计检查（specs/cross-device-stats.md）。
 *
 * 2026-10-24 起：**今日净增 = 现在所有正文章节的字数 − 今日起点**。只看书稿本身，
 * 文件同步完以后每台设备算出来的一样，天然不会因为同步重复计数。
 * 之前按「事件」计数 + 指纹认领的做法在真机上接连出错：手机删 22 字、电脑也记 −22
 * 显示 −44；同步把第 4 章的创建时间刷成今天，启动校正把 −22 改成全文 3270 字。
 *
 * 跑的都是真实实现：
 *   A. 编译 src/deviceStats.ts，两台模拟设备走 spec 的场景（设备的计算流程照 main.ts 的
 *      recomputeToday：本机今天没起点就以现在为起点，起点取各设备里最早的）；
 *   B. 真实 CodeMirror：编辑器里「作者改的」和「Obsidian 重载的」分得清（editorOrigin.ts）；
 *   C. 源码级：main.ts 的输入 / 保存 / 同步都只更新书稿字数，净增不再按事件累加。
 *
 * 反向验证（每条都实际跑过）：
 *   · effectiveStart 改成取最晚的起点 → A3 变红（电脑后打开时把手机写的字吞掉）；
 *   · computeDay 不计「起点里有、现在没有」的章节 → A4 变红（移出正文不减）；
 *   · applyDailyStats 恢复 `this.dailyTotal += delta` → C 变红；
 *   · isNonAuthorDoc 永远返回 false → B 变红。
 *
 * 不启动 Obsidian、不依赖 main.js、不联网。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const D1 = "2026-10-23";
const DAY = "2026-10-24";
const T = (h, m = 0) => Date.parse(`2026-10-24T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
const MODE = "chars";

/**
 * 一台模拟设备，计算流程照 main.ts：
 * - counts：本机看到的各正文章节字数（编辑器输入、保存、同步进来都只是改这里）；
 * - open(day, at)：本机今天第一次运行，记今日起点；
 * - recompute(day, at)：今日净增 = counts − 各设备里最早的起点，写进本机结果。
 */
function makeDevice(M, id, name) {
  const dev = {
    id,
    name,
    counts: new Map(),
    starts: {},
    results: {},
    activity: M.emptyStatsMaps(),
    book: new M.DeviceStatsBook(id),
    today: 0,
    open(day, at) {
      if (!this.starts[day]) this.starts[day] = { at, mode: MODE, files: Object.fromEntries(this.counts) };
      return this.recompute(day, at);
    },
    recompute(day, at) {
      const start = this.book.effectiveStart(day, MODE, this.starts[day]) ?? this.starts[day];
      const result = M.computeDay(start.files, this.counts, (p) => p.split("/")[0]);
      this.results[day] = { at, ...result };
      this.today = result.total;
      return this.today;
    },
    set(p, words, day, at) {
      this.counts.set(p, words);
      return this.recompute(day, at);
    },
    remove(p, day, at) {
      this.counts.delete(p);
      return this.recompute(day, at);
    },
    ledger(now) {
      return M.buildLedger({ deviceId: id, deviceName: name, now }, this.activity, this.starts, this.results);
    },
    /** 同步工具把别的设备的统计文件带过来（main.ts 的 reloadOtherLedgers）。 */
    receive(ledgers, day, at) {
      this.book.setOthers(ledgers.map((l) => M.parseLedger(JSON.stringify(l), l.deviceId)));
      return this.recompute(day, at);
    },
  };
  return dev;
}

const ch = (n) => `作品甲/第${n}章.md`;

function main() {
  const r = H.createReporter("跨设备字数统计（今日净增 = 书稿字数 − 今日起点）");
  const M = H.compile("src/deviceStats.ts", "device-stats");

  // A1 电脑写 3000，同步到手机 → 两边今日都是 3000
  {
    const pc = makeDevice(M, "dpc", "Mac");
    const phone = makeDevice(M, "dphone", "Android");
    pc.counts.set(ch(1), 5000);
    phone.counts.set(ch(1), 5000);
    pc.open(DAY, T(8));
    phone.open(DAY, T(8, 5));
    pc.set(ch(1), 8000, DAY, T(9));
    // Syncthing：章节先到手机
    phone.set(ch(1), 8000, DAY, T(9, 1));
    phone.receive([pc.ledger(T(9, 2))], DAY, T(9, 2));
    pc.receive([phone.ledger(T(9, 3))], DAY, T(9, 3));
    r.check(
      "A1 电脑写 3000 字同步到手机：两边今日都是 3000（不重复）",
      pc.today === 3000 && phone.today === 3000,
      `pc=${pc.today} phone=${phone.today}`
    );
  }

  // A2 2026-10-24 真机：手机删 22 字，电脑上该章开着（编辑器重载）→ 两边都是 −22
  {
    const pc = makeDevice(M, "dpc", "Mac");
    const phone = makeDevice(M, "dphone", "Android");
    pc.counts.set(ch(4), 3292);
    phone.counts.set(ch(4), 3292);
    phone.open(DAY, T(6, 58));
    pc.open(DAY, T(7, 10));
    phone.set(ch(4), 3270, DAY, T(7, 0));
    // 电脑：章节先到、编辑器重载（不论统计文件到没到，算的都是书稿字数）
    const before = pc.set(ch(4), 3270, DAY, T(7, 11));
    pc.receive([phone.ledger(T(7, 12))], DAY, T(7, 12));
    phone.receive([pc.ledger(T(7, 13))], DAY, T(7, 13));
    r.check(
      "A2 手机删 22 字、电脑上该章开着：电脑在手机统计到达前后都不会出现 −44",
      before === -22 && pc.today === -22 && phone.today === -22,
      `before=${before} pc=${pc.today} phone=${phone.today}`
    );
    // 电脑重启：书稿字数重新统计，起点仍取最早的那份
    const restarted = makeDevice(M, "dpc", "Mac");
    restarted.counts.set(ch(4), 3270);
    restarted.starts = pc.starts;
    restarted.receive([phone.ledger(T(7, 20))], DAY, T(7, 30));
    r.check(
      "A2 电脑重启后仍是 −22（不会因为文件创建时间被刷成今天而变成全文 3270）",
      restarted.today === -22,
      `restarted=${restarted.today}`
    );
  }

  // A3 起点取最早：电脑后打开，那时手机写的字已经同步到了
  {
    const pc = makeDevice(M, "dpc", "Mac");
    const phone = makeDevice(M, "dphone", "Android");
    phone.counts.set(ch(1), 1000);
    phone.open(DAY, T(7));
    phone.set(ch(1), 1500, DAY, T(8));
    pc.counts.set(ch(1), 1500); // 电脑打开前，章节已同步到
    const alone = pc.open(DAY, T(9));
    pc.receive([phone.ledger(T(9, 1))], DAY, T(9, 1));
    r.check(
      "A3 电脑 9 点才打开：先按自己的起点算 0，手机 7 点的起点到了改按它算 500",
      alone === 0 && pc.today === 500,
      `alone=${alone} pc=${pc.today}`
    );
  }

  // A4 章节移出正文 → 今日减少该章字数；新章节按全文计
  {
    const pc = makeDevice(M, "dpc", "Mac");
    pc.counts.set(ch(1), 2000);
    pc.counts.set(ch(2), 800);
    pc.open(DAY, T(8));
    const moved = pc.remove(ch(2), DAY, T(9));
    const added = pc.set(ch(3), 300, DAY, T(10));
    r.check(
      "A4 第 2 章移出正文：今日 −800；新写第 3 章 300 字：今日 −500",
      moved === -800 && added === -500,
      `moved=${moved} added=${added}`
    );
    r.check(
      "A4 今日明细按章节列出",
      pc.results[DAY].files[ch(2)] === -800 && pc.results[DAY].files[ch(3)] === 300 &&
        !(ch(1) in pc.results[DAY].files)
    );
  }

  // A5 过去某天：用最晚算出的结果；切换前的日期用旧历史（按设备加总）
  {
    const pc = makeDevice(M, "dpc", "Mac");
    const phone = makeDevice(M, "dphone", "Android");
    pc.results[DAY] = { at: T(20), total: 900, projects: { 作品甲: 900 }, files: {} };
    phone.results[DAY] = { at: T(23), total: 1200, projects: { 作品甲: 1200 }, files: {} };
    const legacy = M.buildLedger(
      { deviceId: M.LEGACY_DEVICE_ID, deviceName: "旧版", now: 0 },
      M.readStatsMaps({ dailyHistory: { [D1]: 3828 }, projectHistory: { 作品甲: { [D1]: 3828 } } }),
      {},
      {}
    );
    // 第一版（按事件计）的设备文件：10-23 记了 13，10-24 记了错的 3270
    const v1 = { deviceId: "dold", dailyHistory: { [D1]: 13, [DAY]: 3270 }, versions: {}, pending: [] };
    pc.book.setOthers([phone.ledger(T(23)), legacy, M.parseLedger(JSON.stringify(v1), "dold")]);
    const net = pc.book.netDaily(pc.results, {});
    const projects = pc.book.netProjects(pc.results, {});
    r.check(
      "A5 10-24：用最晚算出的结果 1200（第一版文件里错的 3270 不再参与）",
      net[DAY] === 1200,
      JSON.stringify(net)
    );
    r.check(
      "A5 10-23（切换前）：旧历史按设备加总 3828 + 13",
      net[D1] === 3841 && projects["作品甲"][D1] === 3828 && projects["作品甲"][DAY] === 1200,
      JSON.stringify({ net, projects })
    );
  }

  // A6 写作时长 / 写下的字 / 番茄：两台各记，显示加总
  {
    const pc = makeDevice(M, "dpc", "Mac");
    const phone = makeDevice(M, "dphone", "Android");
    phone.activity.dailyDurationHistory[DAY] = 741;
    phone.activity.dailyTypedHistory[DAY] = 20;
    phone.activity.dailyPomodoroHistory[DAY] = { count: 1, words: 20 };
    pc.book.setOthers([phone.ledger(T(9))]);
    const duration = pc.book.mergeDaily("dailyDurationHistory", { [DAY]: 1200 });
    r.check(
      "A6 时长 1200 + 741；写下的字 20；番茄 1 个",
      duration[DAY] === 1941 &&
        pc.book.othersDay("dailyTypedHistory", DAY) === 20 &&
        pc.book.othersPomodoro(DAY).count === 1
    );
  }

  // A7 口径不同的起点不拿来做差；同步冲突副本不读；起点只留最近几天
  {
    const pc = makeDevice(M, "dpc", "Mac");
    pc.book.setOthers([
      M.buildLedger({ deviceId: "dphone", deviceName: "手机", now: 0 }, M.emptyStatsMaps(),
        { [DAY]: { at: T(1), mode: "pomodoro", files: { [ch(1)]: 1 } } }, {}),
    ]);
    const own = { at: T(8), mode: MODE, files: {} };
    r.check(
      "A7 别的口径记的起点不用（换统计口径的那天不会算出离谱的数）",
      pc.book.effectiveStart(DAY, MODE, own) === own
    );
    r.check(
      "A7 同步冲突副本不读（*.sync-conflict-*.json）",
      M.isLedgerFileName("dpc.json") &&
        !M.isLedgerFileName("dpc.sync-conflict-20261023-120000-ABCDEFG.json")
    );
    const starts = {
      "2026-10-20": own, "2026-10-21": own, "2026-10-22": own, "2026-10-23": own, [DAY]: own,
    };
    M.pruneLedgerDays(starts, {}, DAY);
    r.check(
      "A7 起点只留最近 " + M.STARTS_KEEP_DAYS + " 天",
      Object.keys(starts).length === M.STARTS_KEEP_DAYS && DAY in starts
    );
    r.check(
      "A7 旧 data.json 有统计才迁移；格式坏的统计文件当不存在",
      M.hasAnyStats({ dailyHistory: { [DAY]: 1 } }) &&
        !M.hasAnyStats({ dailyHistory: {}, settings: {} }) &&
        M.parseLedger("{坏的", "x") === null
    );
  }

  // B) 编辑器来源判断（真实 CodeMirror）：作者的编辑带 userEvent，Obsidian 重载不带
  {
    // @codemirror/state 外置，并把它解析到仓库 node_modules 里那一份：
    // 编译产物与这里用的必须是同一个实例，否则扩展的 instanceof 判断会失败
    const cmPath = require.resolve("@codemirror/state", { paths: [H.ROOT] });
    const Module = require("module");
    const origLoad = Module._load;
    Module._load = function (request) {
      if (request === "@codemirror/state") return origLoad.call(this, cmPath, ...[].slice.call(arguments, 1));
      return origLoad.apply(this, arguments);
    };
    let O;
    try {
      O = H.compile("src/editorOrigin.ts", "editor-origin", ["@codemirror/state"]);
    } finally {
      Module._load = origLoad;
    }
    const { EditorState } = require(cmPath);
    let state = EditorState.create({ doc: "春信到了", extensions: [O.buildEditorOriginTracker()] });
    state = state.update({ changes: { from: 0, to: 1 }, userEvent: "delete.backward" }).state;
    const authored = !O.isNonAuthorDoc(state.doc);
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: "春信到了。" } }).state;
    const reloaded = O.isNonAuthorDoc(state.doc);
    state = state.update({ changes: { from: 0, insert: "啊" }, userEvent: "input.type" }).state;
    const typedAgain = !O.isNonAuthorDoc(state.doc);
    r.check(
      "B 作者删字 = 作者；不带 userEvent 的整篇替换（重载）= 非作者；再打字又回到作者",
      authored && reloaded && typedAgain,
      `authored=${authored} reloaded=${reloaded} typedAgain=${typedAgain}`
    );
  }

  // C) 源码级接线
  {
    const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
    const editor = H.extractMethod(mainSource, "private handleEditorChange(): void");
    const vaultModify = H.extractMethod(mainSource, "private async processVaultModify(file: TFile)");
    const apply = H.extractMethod(mainSource, "private applyDailyStats(");
    const recompute = H.extractMethod(mainSource, "private recomputeToday(): void");
    r.check(
      "C 编辑器输入与文件修改（保存 / 同步 / 外部工具）都只更新这一章的书稿字数",
      /updateBookCount\(file\.path, this\.countWords\(text\)\)/.test(editor) &&
        /updateBookCount\(file\.path, this\.countWords\(text\)\)/.test(vaultModify)
    );
    r.check(
      "C 净增不再按事件累加：applyDailyStats 不碰 dailyTotal / dailyHistory / dailyFileDeltas",
      !/this\.dailyTotal\s*[+-]?=/.test(apply) &&
        !/this\.dailyHistory\[/.test(apply) &&
        !/this\.dailyFileDeltas\[/.test(apply)
    );
    r.check(
      "C 今日净增 = 书稿字数 − 各设备里最早的起点；没有起点就以现在为起点",
      /effectiveStart\(day, mode, this\.ownStarts\[day\]\)/.test(recompute) &&
        /computeDay\(/.test(recompute) &&
        /this\.ownStarts\[day\] = this\.snapshotBook\(\)/.test(recompute)
    );
    r.check(
      "C 「今天新建文件不应为负」的启动校正已删除；布局就绪后统计书稿字数",
      !/reconcileTodayNewFileDeltas/.test(mainSource) &&
        /onLayoutReady\(\(\) => \{\s*void this\.rebuildBookCounts\(\);/.test(mainSource)
    );
    r.check(
      "C 非作者的变化（编辑器重载）：不算写下的字、不计时长",
      /isNonAuthorDoc\(view\.state\.doc\)/.test(editor) &&
        /!isExternalSync && !fromDisk && dailyFile/.test(editor) &&
        /!isExternalSync && !isProgrammatic && !fromDisk/.test(editor) &&
        /registerEditorExtension\(buildEditorOriginTracker\(\)\)/.test(mainSource)
    );
    r.check(
      "C 别的设备的统计文件变了 → 重读并重算今日；实现 onExternalSettingsChange",
      /isOtherLedgerPath\(file\.path\)[\s\S]{0,80}scheduleReloadOthers\(\)/.test(mainSource) &&
        /setOthers\(others\);[\s\S]{0,120}this\.recomputeToday\(\)/.test(mainSource) &&
        /async onExternalSettingsChange\(\)/.test(mainSource)
    );
    const loadStart = mainSource.indexOf("private async loadDeviceStats(");
    const loadBody = mainSource.indexOf("): Promise<void> {", loadStart);
    const load =
      mainSource.slice(loadStart, loadBody) +
      H.extractMethod(mainSource.slice(loadBody), "): Promise<void> {");
    r.check(
      "C 迁移：legacy.json 已存在就不重复迁移；迁移失败把旧统计留在 data.json",
      /exists\(LEGACY_FILE\)/.test(load) && /carryLegacyStats = readStatsMaps\(data\)/.test(load)
    );
  }

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
