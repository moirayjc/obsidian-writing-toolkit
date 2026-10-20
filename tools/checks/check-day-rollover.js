/**
 * 跨午夜统计检查：零点后保存不再把昨天的字数写进今天。
 *
 * 内存里的 dailyTotal / dailyDurationSeconds 属于 activeDay，只在
 * ensureCurrentDay() 里切天。旧实现写盘时按「实时日期」回填，零点后、跨天结算前
 * 的任何一次保存（2 秒防抖、睡眠唤醒后点按钮、卸载）都会把昨天的总数写进今天，
 * 随后今天就从昨天的总数开始累计。
 *
 * 做法：从 src/main.ts 按符号抽出**真实方法**（todayStr / ensureCurrentDay /
 * recordWritingActivity / applyDailyStats / isCreatedToday / savePluginData /
 * reconcileTodayNewFileDeltas），拼成一个最小类，在假时钟下跑四个时序：
 *
 *   1. 昨天写了字 → 零点后、结算前保存 → 今天的键不能拿到昨天的数（AC-001）
 *   2. 跨天后第一笔增量记今天，昨天的数不再变（AC-002）
 *   3. 启动校正在 activeDay 还是昨天时运行，不能把 diff 加到昨天的总数上（AC-003）
 *   4. 启动校正读盘期间跨过零点 → 停手，不往旧日期上加（AC-003）
 *
 * 反向验证：把 savePluginData 的回填改回 `this.todayStr` 作键，场景 1 变红；
 * 把 reconcileTodayNewFileDeltas 开头的 ensureCurrentDay() 去掉，场景 3 变红。
 *
 * 不启动 Obsidian、不依赖 main.js、不联网。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const METHODS = [
  "private get todayStr()",
  "private ensureCurrentDay(): void",
  "private recordWritingActivity(): void",
  "private applyDailyStats(",
  "private isCreatedToday(",
  "private async savePluginData()",
  "private async reconcileTodayNewFileDeltas()",
];

/** 把 main.ts 的真实方法拼进一个只带桩的类，编译后返回构造器。 */
function loadDayStats(mainSource) {
  const bodies = METHODS.map((sig) => H.extractMethod(mainSource, sig));
  // 时长阈值常量照搬 main.ts，不在检查里写死
  const gapConst = mainSource.match(/^const BREAK_GAP_MS = .*;$/m);
  if (!gapConst) throw new Error("main.ts 里找不到 BREAK_GAP_MS");
  const ts = `
${gapConst[0]}
function statsApplied(..._args: unknown[]): void {}
export class TFile {
  constructor(public path: string, public stat: { ctime: number }) {}
}
export class DayStats {
${bodies.join("\n\n")}
}
`;
  const js = H.transpileTs(ts, "day-rollover", "WtDayStats");
  // eslint-disable-next-line no-new-func
  return new Function(js + "\nreturn WtDayStats;")();
}

/** 可拨动的假时钟：只接管无参 new Date() 与 Date.now()。 */
function installClock() {
  const RealDate = Date;
  let now = 0;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() {
      return now;
    }
  }
  global.Date = FakeDate;
  return {
    set(y, m, d, hh, mm, ss) {
      now = new RealDate(y, m - 1, d, hh, mm, ss).getTime();
    },
    at(y, m, d, hh, mm, ss) {
      return new RealDate(y, m - 1, d, hh, mm, ss).getTime();
    },
    restore() {
      global.Date = RealDate;
    },
  };
}

/** 给抽出来的方法配齐它们读写的字段与协作者。 */
function createPlugin(mod, files) {
  const p = new mod.DayStats();
  Object.assign(p, {
    activeDay: "",
    dailyTotal: 0,
    dailyDurationSeconds: 0,
    lastDurationTotal: 0,
    lastWritingActivityAt: 0,
    dailyHistory: {},
    dailyDurationHistory: {},
    projectHistory: {},
    projectDurationHistory: {},
    dailyFileDeltas: {},
    fileBaselines: {},
    knownProjects: new Set(["作品甲"]),
    saved: [],
    onRead: null,
    statusBar: { loadBaselines() {} },
    stats: { publish() {} },
    app: {
      vault: {
        getAbstractFileByPath: (path) => files[path]?.file ?? null,
        cachedRead: async (file) => {
          if (p.onRead) p.onRead();
          return files[file.path].text;
        },
      },
    },
    getProjectForPath: () => "作品甲",
    refreshSidebarSettings() {},
    scheduleDailySave() {},
    refreshWorkbench() {},
    refreshHome() {},
    countWords: (text) => text.length,
    persistPluginData() {
      p.saved.push(
        JSON.parse(
          JSON.stringify({
            dailyHistory: p.dailyHistory,
            dailyDurationHistory: p.dailyDurationHistory,
            projectHistory: p.projectHistory,
          })
        )
      );
      return Promise.resolve();
    },
  });
  return p;
}

async function main() {
  const mainSource = fs.readFileSync(path.join(H.ROOT, "src", "main.ts"), "utf8");
  const mod = loadDayStats(mainSource);
  const clock = installClock();
  const r = H.createReporter("跨午夜统计（src/main.ts 真实方法 + 假时钟）");
  const D1 = "2026-03-01";
  const D2 = "2026-03-02";
  const D3 = "2026-03-03";
  const chapter = new mod.TFile("作品甲/正文/第1章.md", { ctime: 0 });

  try {
    // 1) 昨天写了字，零点后、跨天结算前触发保存（AC-001）
    {
      const p = createPlugin(mod, {});
      clock.set(2026, 3, 1, 23, 59, 50);
      p.ensureCurrentDay();
      p.applyDailyStats(chapter, 100, true);
      clock.set(2026, 3, 1, 23, 59, 58);
      p.applyDailyStats(chapter, 20, true);
      clock.set(2026, 3, 2, 0, 0, 1);
      await p.savePluginData();
      const disk = p.saved[p.saved.length - 1];
      r.check(
        "零点后保存：昨天的键保持 120",
        disk.dailyHistory[D1] === 120,
        JSON.stringify(disk.dailyHistory)
      );
      r.check(
        "零点后保存：今天的键没有拿到昨天的总数",
        !disk.dailyHistory[D2],
        JSON.stringify(disk.dailyHistory)
      );
      r.check(
        "零点后保存：时长同样记在昨天、不写进今天",
        disk.dailyDurationHistory[D1] === 8 && !disk.dailyDurationHistory[D2],
        JSON.stringify(disk.dailyDurationHistory)
      );
      p.ensureCurrentDay();
      r.check(
        "跨天结算后今天从 0 起算",
        p.activeDay === D2 && p.dailyTotal === 0 && p.dailyDurationSeconds === 0,
        `activeDay=${p.activeDay} total=${p.dailyTotal} duration=${p.dailyDurationSeconds}`
      );

      // 2) 跨天后第一笔增量（AC-002）
      clock.set(2026, 3, 2, 0, 0, 5);
      p.applyDailyStats(chapter, 30, true);
      await p.savePluginData();
      const after = p.saved[p.saved.length - 1];
      r.check(
        "跨天后第一笔增量记今天，昨天的数不再变",
        after.dailyHistory[D1] === 120 && after.dailyHistory[D2] === 30,
        JSON.stringify(after.dailyHistory)
      );
      r.check(
        "作品统计同样分在两天",
        after.projectHistory["作品甲"][D1] === 120 &&
          after.projectHistory["作品甲"][D2] === 30,
        JSON.stringify(after.projectHistory)
      );
    }

    // 3) 启动校正时 activeDay 还是昨天（AC-003）
    {
      const path = "作品甲/正文/第2章.md";
      const file = new mod.TFile(path, { ctime: clock.at(2026, 3, 2, 0, 0, 10) });
      const p = createPlugin(mod, { [path]: { file, text: "字".repeat(80) } });
      clock.set(2026, 3, 1, 23, 0, 0);
      p.ensureCurrentDay();
      p.applyDailyStats(chapter, 500, false);
      p.dailyFileDeltas[D2] = { [path]: -50 };
      clock.set(2026, 3, 2, 0, 0, 30);
      await p.reconcileTodayNewFileDeltas();
      r.check(
        "启动校正：今天按 0 起算加上校正量 130",
        p.dailyHistory[D2] === 130 && p.dailyTotal === 130,
        `history=${JSON.stringify(p.dailyHistory)} total=${p.dailyTotal}`
      );
      r.check(
        "启动校正：昨天的 500 保持不变",
        p.dailyHistory[D1] === 500,
        JSON.stringify(p.dailyHistory)
      );
    }

    // 4) 启动校正读盘期间跨过零点（AC-003）
    {
      const path = "作品甲/正文/第3章.md";
      const file = new mod.TFile(path, { ctime: clock.at(2026, 3, 2, 23, 0, 0) });
      const p = createPlugin(mod, { [path]: { file, text: "字".repeat(40) } });
      clock.set(2026, 3, 2, 23, 59, 59);
      p.ensureCurrentDay();
      p.applyDailyStats(chapter, 200, false);
      p.dailyFileDeltas[D2] = { [path]: -10 };
      p.onRead = () => {
        clock.set(2026, 3, 3, 0, 0, 1);
        p.ensureCurrentDay();
      };
      await p.reconcileTodayNewFileDeltas();
      r.check(
        "读盘期间跨天：不再往旧日期或新的一天上加校正量",
        p.dailyHistory[D2] === 200 && !p.dailyHistory[D3] && p.dailyTotal === 0,
        `history=${JSON.stringify(p.dailyHistory)} total=${p.dailyTotal}`
      );
    }

    // 5) 源码级兜底：不许再出现「实时日期键 = 今日总数」的回填
    r.check(
      "main.ts 不再用 todayStr 作键回填 dailyTotal / dailyDurationSeconds",
      !/\[this\.todayStr\]\s*=\s*this\.(dailyTotal|dailyDurationSeconds)\b/.test(
        mainSource
      )
    );
  } finally {
    clock.restore();
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
