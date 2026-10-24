/**
 * 时速检查（SPEC-006）：时速 = 今日写下的字 ÷ 今日写作时长。
 *
 * 旧实现有两个时速：编辑台只看最近 60 秒（停笔 30 秒、切换文件就清零），
 * 主页用「今日净增 ÷ 时长」（大段删除后净增 ≤ 0 就显示「—」）。
 * 新口径只有一个数，分子是「写下的字」：手动输入的 1–120 字正增量累计，
 * 删除不抵减，粘贴 / 外部同步不计；输入法拼字期间不结算（拼音字母真的在文档里），
 * 上屏后按汉字数补结算。
 *
 * 跑的都是真实实现：
 *   A. 编译 src/services/statsService.ts，测 computeTodaySpeed / todaySpeed；
 *   B. 从 src/statusbar.ts 抽出 onEditorChange，测「写下的字」与净增各自怎么算；
 *   C. 从 src/main.ts 抽出 recordTyped / ensureCurrentDay / todayStr，在假时钟下测跨午夜；
 *   D. 源码级：data.json 读写都带 dailyTypedHistory，编辑器路径先记写下的字再结算；
 *   E. 写作时长（时速的分母）：从 src/main.ts 抽 recordWritingActivity，假时钟下测
 *      「10 分钟内的停顿整段计入、超过算休息不计」，以及只有跨天会打断计时。
 *
 * 反向验证（每条都实际跑过）：
 *   · takeTyped 的 `change > 0` 改成 `change !== 0`（删除也计入）→ B 组变红；
 *   · 去掉 onEditorChange 里的 `composing ? 0 :`（拼字也逐次结算）→ 拼音组变红；
 *   · 去掉 recordTyped 开头的 ensureCurrentDay()（零点后写的字记进昨天）→ C 组变红；
 *   · BREAK_GAP_MS 改回 30_000（思考时间又不算）→ E 组变红。
 *
 * 不启动 Obsidian、不依赖 main.js、不联网。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function source(relPath) {
  return fs.readFileSync(path.join(H.ROOT, relPath), "utf8");
}

/**
 * 抽方法源码。H.extractMethod 从签名后的第一个 `{` 开始配平，返回类型是对象字面量
 * 类型时会抽错；这种方法传 [签名, 方法体开头] 两段，从第二段末尾的 `{` 开始配平。
 */
function extract(text, sig) {
  if (typeof sig === "string") return H.extractMethod(text, sig);
  const [head, bodyOpen] = sig;
  const start = text.indexOf(head);
  if (start < 0) throw new Error("找不到符号：" + head);
  const open = text.indexOf(bodyOpen, start);
  if (open < 0) throw new Error("找不到方法体：" + bodyOpen);
  const brace = open + bodyOpen.length - 1;
  let depth = 0;
  for (let i = brace; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("花括号未配平：" + head);
}

/** 把若干真实方法拼成一个最小类，编译后返回构造器。 */
function loadMethods(file, signatures, name) {
  const text = source(file);
  const bodies = signatures.map((sig) => extract(text, sig));
  const js = H.transpileTs(
    `export class Probe {\n${bodies.join("\n\n")}\n}\n`,
    name,
    "WtProbe"
  );
  // eslint-disable-next-line no-new-func
  return new Function(js + "\nreturn WtProbe.Probe;")();
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
    restore() {
      global.Date = RealDate;
    },
  };
}

function main() {
  const r = H.createReporter("时速 = 写下的字 ÷ 有效写作时长（真实实现）");

  // A) 时速公式与 StatsService 接线
  {
    const restore = H.stubObsidian({ Notice: class {} });
    let stats;
    try {
      stats = H.compile("src/services/statsService.ts", "stats-service", ["electron"]);
    } finally {
      restore();
    }
    const { computeTodaySpeed, StatsService } = stats;
    r.check("写 5000 字、时长 1 小时 → 5000 字/时", computeTodaySpeed(5000, 3600) === 5000);
    r.check("取整到 10 字/时", computeTodaySpeed(1234, 3600) === 1230);
    r.check("有效时长不足 1 分钟 → 不给数", computeTodaySpeed(800, 59) === null);
    r.check("写满 1 分钟 → 给数", computeTodaySpeed(100, 60) === 6000);
    r.check("还没写下字 → 不给数", computeTodaySpeed(0, 3600) === null);

    const service = new StatsService({
      typedToday: () => 5000,
      todayTotals: () => ({ total: -1000, durationSeconds: 3600 }),
    });
    r.check(
      "todaySpeed 用写下的字，不看净增（净增 -1000 仍是 5000 字/时）",
      service.todaySpeed() === 5000
    );
  }

  // B) 状态栏：写下的字 vs 净增
  {
    const Probe = loadMethods(
      "src/statusbar.ts",
      [
        ["  onEditorChange(\n", "): { delta: number; typed: number } {"],
        "  settleTyped(text: string): number",
        "  private takeTyped(",
      ],
      "statusbar-typed"
    );
    const bar = new Probe();
    Object.assign(bar, {
      wordCount: { count: (text) => text.length },
      state: { wordCountMode: "webnovel" },
      MAX_TYPED_DELTA: 120,
      currentFilePath: "作品甲/正文/第1章.md",
      fileBaselines: new Map([["作品甲/正文/第1章.md", 0]]),
      lastDocCount: 0,
      typedRefCount: 0,
      rememberBaseline(p, count) {
        this.fileBaselines.set(p, count);
      },
      refresh() {},
    });

    let text = "";
    let typed = 0;
    let net = 0;
    for (let i = 0; i < 100; i++) {
      text += "字".repeat(50);
      const result = bar.onEditorChange(text);
      typed += result.typed;
      net += result.delta;
    }
    r.check("分 100 次各写 50 字：写下的字 5000、净增 5000", typed === 5000 && net === 5000);

    text = text.slice(0, -3000);
    let result = bar.onEditorChange(text);
    r.check(
      "一次删掉 3000 字：净增 -3000，写下的字不抵减",
      result.delta === -3000 && result.typed === 0,
      JSON.stringify(result)
    );

    text += "贴".repeat(500);
    result = bar.onEditorChange(text);
    r.check(
      "一次粘贴 500 字：进净增，不算写下的字",
      result.delta === 500 && result.typed === 0,
      JSON.stringify(result)
    );

    text += "同".repeat(30);
    result = bar.onEditorChange(text, false, false);
    r.check(
      "外部同步（countTyped=false）：不算写下的字",
      result.typed === 0,
      JSON.stringify(result)
    );

    text += "写".repeat(120);
    result = bar.onEditorChange(text);
    r.check("单次正好 120 字仍算手动输入", result.typed === 120, JSON.stringify(result));

    // 输入法拼「你好」：文档里先后出现 n → ni → nih → niha → nihao → 你好
    const before = text;
    let imeTyped = 0;
    for (const step of ["n", "ni", "nih", "niha", "nihao", "你好"]) {
      imeTyped += bar.onEditorChange(before + step, false, true, true).typed;
    }
    r.check("拼字期间（composing）不结算写下的字", imeTyped === 0, String(imeTyped));
    const settled = bar.settleTyped(before + "你好");
    r.check("拼字结束后补结算：按上屏的 2 个汉字计，不是 5 个拼音按键", settled === 2, String(settled));
    r.check("补结算只算一次", bar.settleTyped(before + "你好") === 0);

    // 上屏那次变化本身不在拼字中：直接在 onEditorChange 里结算
    const base2 = before + "你好";
    bar.onEditorChange(base2 + "x", false, true, true);
    bar.onEditorChange(base2 + "xi", false, true, true);
    result = bar.onEditorChange(base2 + "写", false, true, false);
    r.check("上屏变化不在拼字中：当场按 1 个汉字结算", result.typed === 1, JSON.stringify(result));
  }

  // C) 跨午夜：写下的字记在 activeDay
  {
    const clock = installClock();
    try {
      const Probe = loadMethods(
        "src/main.ts",
        [
          "private get todayStr()",
          "private ensureCurrentDay(): void",
          "private recordTyped(",
        ],
        "main-typed"
      );
      const p = new Probe();
      Object.assign(p, {
        activeDay: "",
        dailyTotal: 0,
        dailyDurationSeconds: 0,
        lastDurationTotal: 0,
        lastWritingActivityAt: 0,
        dailyHistory: {},
        dailyDurationHistory: {},
        dailyTypedHistory: {},
        // 今日净增的跨天结算（书稿字数 − 起点）由 check-day-rollover 测，这里只测写下的字
        onDayRollover() {},
      });
      clock.set(2026, 3, 1, 23, 59, 50);
      p.ensureCurrentDay();
      p.recordTyped(40);
      clock.set(2026, 3, 2, 0, 0, 5);
      p.recordTyped(30);
      r.check(
        "零点前写的记昨天，零点后写的记今天",
        p.dailyTypedHistory["2026-03-01"] === 40 &&
          p.dailyTypedHistory["2026-03-02"] === 30,
        JSON.stringify(p.dailyTypedHistory)
      );
    } finally {
      clock.restore();
    }
  }

  // D) 源码级接线
  {
    const mainSource = source("src/main.ts");
    // 2026-10-23 起统计按设备存在 `_写作工具箱/统计/<设备>.json`（specs/cross-device-stats.md）
    const persist = H.extractMethod(mainSource, "private currentStatsMaps(): StatsMaps");
    const load = H.extractMethod(mainSource, "private applyStatsMaps(maps: StatsMaps): void");
    const ledgerSource = source("src/deviceStats.ts");
    const change = H.extractMethod(mainSource, "private handleEditorChange(): void");
    r.check(
      "本机统计文件读写都带 dailyTypedHistory",
      /dailyTypedHistory:\s*this\.dailyTypedHistory/.test(persist) &&
        /this\.dailyTypedHistory = maps\.dailyTypedHistory/.test(load) &&
        /dailyTypedHistory:\s*numberMap\(src\.dailyTypedHistory\)/.test(ledgerSource)
    );
    r.check(
      "编辑器路径：先记写下的字，再结算今日统计",
      /recordTyped\(typed\)[\s\S]*applyDailyStats\(/.test(change)
    );
    r.check(
      "编辑器路径：把 composing 传给状态栏，拼字中安排补结算",
      /\.composing/.test(change) &&
        /onEditorChange\([\s\S]*composing\s*\)/.test(change) &&
        /scheduleTypedSettle\(/.test(change)
    );
    const settle = H.extractMethod(mainSource, "private scheduleTypedSettle(");
    r.check(
      "补结算：仍在拼字就再等，结束后经 settleTyped 记入写下的字",
      /composing[\s\S]*scheduleTypedSettle\(path\)/.test(settle) &&
        /settleTyped\(/.test(settle) &&
        /recordTyped\(typed\)/.test(settle)
    );
    r.check(
      "今日写下的字按 activeDay 取（与有效写作时长同一天）",
      // 2026-10-23 起显示的是各设备加总：本机 + 其他设备，都按 activeDay 取
      /typedToday:\s*\(\)\s*=>\s*\(this\.dailyTypedHistory\[this\.activeDay\] \|\| 0\) \+\s*this\.statsBook\.othersDay\("dailyTypedHistory", this\.activeDay\)/.test(mainSource)
    );
    const shells = ["src/home.ts", "src/workbench.ts"].map(source).join("\n");
    r.check(
      "主页与编辑台都只读 stats.todaySpeed()，不再各算各的",
      (shells.match(/stats\.todaySpeed\(\)/g) || []).length >= 2 &&
        !/statusBarSpeed|words \/ seconds/.test(shells)
    );
    r.check(
      "状态栏不再保留 60 秒采样窗口",
      !/speedSamples|SPEED_WINDOW_MS/.test(source("src/statusbar.ts"))
    );
  }

  // E) 写作时长：10 分钟内的停顿整段计入，超过算休息
  {
    const mainSource = source("src/main.ts");
    const gapConst = mainSource.match(/^const BREAK_GAP_MS = .*;$/m);
    r.check("main.ts 定义了 BREAK_GAP_MS", !!gapConst);
    const clock = installClock();
    try {
      const body = H.extractMethod(mainSource, "private recordWritingActivity(): void");
      const js = H.transpileTs(
        `${gapConst ? gapConst[0] : ""}\nexport class Probe {\n${body}\n}\n`,
        "main-duration",
        "WtProbe"
      );
      // eslint-disable-next-line no-new-func
      const Probe = new Function(js + "\nreturn WtProbe.Probe;")();
      const p = new Probe();
      Object.assign(p, { lastWritingActivityAt: 0, dailyDurationSeconds: 0 });
      clock.set(2026, 3, 1, 9, 0, 0);
      p.recordWritingActivity();
      clock.set(2026, 3, 1, 9, 5, 0);
      p.recordWritingActivity();
      r.check("停顿 5 分钟（思考 / 查资料）整段计入", p.dailyDurationSeconds === 300, String(p.dailyDurationSeconds));
      clock.set(2026, 3, 1, 9, 15, 0);
      p.recordWritingActivity();
      r.check("停顿正好 10 分钟仍计入", p.dailyDurationSeconds === 900, String(p.dailyDurationSeconds));
      clock.set(2026, 3, 1, 9, 26, 0);
      p.recordWritingActivity();
      r.check("停顿 11 分钟算休息，这段不计", p.dailyDurationSeconds === 900, String(p.dailyDurationSeconds));
      clock.set(2026, 3, 1, 9, 26, 40);
      p.recordWritingActivity();
      r.check("休息回来后，下一段停顿从回来那一刻起算", p.dailyDurationSeconds === 940, String(p.dailyDurationSeconds));
    } finally {
      clock.restore();
    }

    const resets = mainSource.match(/this\.lastWritingActivityAt = 0;/g) || [];
    const dayRoll = H.extractMethod(mainSource, "private ensureCurrentDay(): void");
    r.check(
      "只有跨天会打断写作计时（切换文件、非正文输入、程序化编辑都不打断）",
      resets.length === 1 && /this\.lastWritingActivityAt = 0;/.test(dayRoll),
      `this.lastWritingActivityAt = 0 出现 ${resets.length} 处`
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
