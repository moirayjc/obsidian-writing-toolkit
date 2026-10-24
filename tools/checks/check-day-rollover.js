/**
 * 跨午夜统计检查：零点前后的字数与时长各归各天。
 *
 * 2026-10-24 起今日净增 = 书稿字数 − 今日起点（specs/cross-device-stats.md）：
 * 跨过零点时，昨天的结果按那一刻的书稿字数定下来，今天以那一刻为起点。
 * 写作时长仍按 activeDay 记：内存里的 dailyDurationSeconds 只在 ensureCurrentDay()
 * 里切天，零点后、跨天结算前的保存不能把昨天的时长写进今天。
 *
 * 做法：从 src/main.ts 按符号抽出**真实方法**，连同 src/deviceStats.ts 的真实实现
 * 拼成一个最小类，在假时钟下跑：
 *
 *   1. 昨天写了字 → 零点后、结算前保存 → 时长留在昨天，今天的键不拿昨天的数
 *   2. 跨过零点：昨天的净增按零点那一刻定下，今天从 0 起算；之后的字记今天
 *   3. 起点由别的设备更早记下时，今天按那份起点算（多设备取最早）
 *
 * 反向验证：把 savePluginData 的时长回填改回 `this.todayStr` 作键，场景 1 变红；
 * 去掉 recomputeToday 里「本机今天还没有起点就以此刻为起点」，场景 2 变红。
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
  "private async savePluginData()",
  "private updateBookCount(",
  "private recomputeToday(): void",
  "private onDayRollover(",
  "private snapshotBook(): DayStart",
];

/** 把 main.ts 的真实方法拼进一个只带桩的类，编译后返回模块。 */
function loadDayStats(mainSource) {
  const bodies = METHODS.map((sig) => H.extractMethod(mainSource, sig));
  // 时长阈值常量照搬 main.ts，不在检查里写死
  const gapConst = mainSource.match(/^const BREAK_GAP_MS = .*;$/m);
  if (!gapConst) throw new Error("main.ts 里找不到 BREAK_GAP_MS");
  const deviceStats = fs.readFileSync(path.join(H.ROOT, "src", "deviceStats.ts"), "utf8");
  const ts = `
${deviceStats}
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
function createPlugin(mod) {
  const p = new mod.DayStats();
  Object.assign(p, {
    activeDay: "",
    dailyTotal: 0,
    dailyDurationSeconds: 0,
    lastDurationTotal: 0,
    lastWritingActivityAt: 0,
    dailyDurationHistory: {},
    projectDurationHistory: {},
    knownProjects: new Set(["作品甲"]),
    settings: { wordCountMode: "chars" },
    bookCounts: new Map(),
    bookCountsReady: true,
    ownStarts: {},
    ownResults: {},
    statsBook: new mod.DeviceStatsBook("dpc"),
    saved: [],
    getProjectForPath: () => "作品甲",
    refreshSidebarSettings() {},
    scheduleDailySave() {},
    writeOwnLedger() {
      return Promise.resolve();
    },
    persistPluginData() {
      p.saved.push(
        JSON.parse(
          JSON.stringify({
            dailyDurationHistory: p.dailyDurationHistory,
            results: p.ownResults,
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
  const ch1 = "作品甲/正文/第1章.md";
  const chapter = new mod.TFile(ch1, { ctime: 0 });

  try {
    // 1) 昨天写了字，零点后、跨天结算前触发保存：时长留在昨天
    {
      const p = createPlugin(mod);
      clock.set(2026, 3, 1, 23, 59, 50);
      p.bookCounts.set(ch1, 100);
      p.ensureCurrentDay();
      p.updateBookCount(ch1, 200);
      p.applyDailyStats(chapter, 100, true);
      clock.set(2026, 3, 1, 23, 59, 58);
      p.updateBookCount(ch1, 220);
      p.applyDailyStats(chapter, 20, true);
      clock.set(2026, 3, 2, 0, 0, 1);
      await p.savePluginData();
      const disk = p.saved[p.saved.length - 1];
      r.check(
        "零点后保存：时长记在昨天、不写进今天",
        disk.dailyDurationHistory[D1] === 8 && !disk.dailyDurationHistory[D2],
        JSON.stringify(disk.dailyDurationHistory)
      );
      r.check(
        "零点后保存：今天还没有结果（昨天的净增 120 不会挪到今天）",
        disk.results[D1].total === 120 && !disk.results[D2],
        JSON.stringify(Object.fromEntries(Object.entries(disk.results).map(([d, v]) => [d, v.total])))
      );

      // 2) 跨过零点
      p.ensureCurrentDay();
      r.check(
        "跨天结算：昨天定在 120，今天从 0 起算，今天的起点是零点那一刻的书稿",
        p.activeDay === D2 && p.dailyTotal === 0 && p.dailyDurationSeconds === 0 &&
          p.ownResults[D1].total === 120 && p.ownStarts[D2].files[ch1] === 220,
        `activeDay=${p.activeDay} total=${p.dailyTotal} D1=${p.ownResults[D1]?.total} start=${JSON.stringify(p.ownStarts[D2]?.files)}`
      );
      clock.set(2026, 3, 2, 0, 0, 5);
      p.updateBookCount(ch1, 250);
      r.check(
        "跨天后写的字记今天，昨天的数不再变",
        p.dailyTotal === 30 && p.ownResults[D2].total === 30 && p.ownResults[D1].total === 120,
        `today=${p.dailyTotal} D1=${p.ownResults[D1].total}`
      );
      r.check(
        "作品统计同样分在两天",
        p.ownResults[D1].projects["作品甲"] === 120 && p.ownResults[D2].projects["作品甲"] === 30
      );
    }

    // 3) 别的设备更早记了今天的起点：按那份算
    {
      const p = createPlugin(mod);
      clock.set(2026, 3, 2, 9, 0, 0);
      p.bookCounts.set(ch1, 1000);
      const phoneStart = {
        at: clock.at(2026, 3, 2, 7, 0, 0),
        mode: "chars",
        files: { [ch1]: 900 },
      };
      p.statsBook.setOthers([
        mod.buildLedger(
          { deviceId: "dphone", deviceName: "手机", now: 0 },
          mod.emptyStatsMaps(),
          { [D2]: phoneStart },
          {}
        ),
      ]);
      p.ensureCurrentDay();
      r.check(
        "多设备：用最早记的起点（手机 7 点记的 900），今天 = 1000 − 900 = 100",
        p.dailyTotal === 100,
        `total=${p.dailyTotal}`
      );
    }

    // 4) 源码级兜底：不许再出现「实时日期键 = 今日时长」的回填
    r.check(
      "main.ts 不用 todayStr 作键回填 dailyDurationSeconds",
      !/\[this\.todayStr\]\s*=\s*this\.dailyDurationSeconds\b/.test(mainSource)
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
