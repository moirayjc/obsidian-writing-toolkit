/**
 * 检查：诊断模块（src/diagnostics.ts）。
 *
 * 自检报告是排查「静默不生效」的唯一线索，所以它本身也要有回归保护：
 *   1. 计数器确实在累加（埋点没被删掉）
 *   2. 报告确实包含关键字段，且能把「原因」写出来
 *   3. 计数变化能让报告文本跟着变（不是写死的模板）
 */
const H = require("./_harness");

function main() {
  const diag = H.compile("src/diagnostics.ts", "diagnostics");
  const r = H.createReporter("诊断计数与自检报告（src/diagnostics.ts 真实实现）");

  // ── 1) 计数器 ──
  diag.commentSkip("缓存未加载（还没预加载过这篇的批注）", "正文/第1章.md");
  diag.commentSkip("缓存未加载（还没预加载过这篇的批注）", "正文/第1章.md");
  diag.commentSkip("这篇文档没有批注", "正文/第2章.md");
  r.check(
    "commentSkip 按原因累加",
    diag.commentDecorDiag.skip["缓存未加载（还没预加载过这篇的批注）"] === 2 &&
      diag.commentDecorDiag.skip["这篇文档没有批注"] === 1
  );
  r.check(
    "commentSkip 记录最近结论与路径",
    diag.commentDecorDiag.lastDecision.includes("这篇文档没有批注") &&
      diag.commentDecorDiag.lastPath === "正文/第2章.md"
  );

  diag.commentBuilt({
    path: "正文/第1章.md",
    via: { exact: 2, paragraph: 1 },
    marks: 2,
    chips: 3,
    located: 3,
    ms: 12.5,
  });
  r.check("commentBuilt 累加标记/序号/定位", diag.commentDecorDiag.marks === 2 && diag.commentDecorDiag.chips === 3);
  r.check("commentBuilt 记录定位方式分布", diag.commentDecorDiag.via.exact === 2 && diag.commentDecorDiag.via.paragraph === 1);
  r.check("commentBuilt 记录最大耗时", diag.commentDecorDiag.maxBuildMs === 12.5);

  diag.commentLoaded("正文/第1章.md", 3, 4.2, true);
  diag.commentLoaded("正文/第2章.md", 0, 1.1, false);
  r.check("commentLoaded 区分「文件不存在」", diag.commentIoDiag.sidecarMissing === 1 && diag.commentIoDiag.loads === 2);
  r.check("commentLoaded 记录最大读取耗时", diag.commentIoDiag.maxLoadMs === 4.2);

  diag.commentWrote("正文/第1章.md", 7.7);
  diag.commentSidecarDeleted("正文/第2章.md");
  r.check("写入与删除分开计数", diag.commentIoDiag.writes === 1 && diag.commentIoDiag.sidecarDeletes === 1);

  diag.recordLocate(31.2);
  diag.recordLocate(9.9);
  r.check(
    "locateAll 埋点记最近与最大",
    diag.statsDiag.locateCalls === 2 &&
      diag.statsDiag.locateLastMs === 9.9 &&
      diag.statsDiag.locateMaxMs === 31.2
  );
  diag.statsApplied("正文/第1章.md", 120, true);
  r.check("statsApplied 写出可读描述", diag.statsDiag.lastApply.includes("+120"));

  // ── 2) 批注自检报告 ──
  const ctx = {
    commentsEnabled: true,
    bubbleEverywhere: true,
    docPath: "正文/第1章.md",
    cached: [{ id: 1, status: "pending" }, { id: 2, status: "resolved" }],
    sidecarExists: true,
    sidecarPath: "正文/第1章.批注.md",
    sidecarSize: 1024,
  };
  const c1 = diag.buildCommentDiagReport(ctx);
  for (const needle of [
    "# 写作工具箱 · 批注自检报告",
    "批注总开关 commentsEnabled：是",
    "归属文档：正文/第1章.md",
    "对应批注文件：正文/第1章.批注.md",
    "批注文件状态：存在（1024 字节）",
    "缓存状态：已加载 2 条",
    "待处理 1 条",
    "## 跳过原因计数",
    "定位方式分布",
    "locateAll 定位不到任何批注",
    "## 怎么读这份报告",
  ]) {
    r.check("批注报告含「" + needle + "」", c1.includes(needle));
  }
  r.check("批注报告写出了跳过原因", c1.includes("缓存未加载（还没预加载过这篇的批注）：2 次"));

  // ── 3) 报告随状态变化（不是写死的模板）──
  // 注意：docPath 为 null 时报告不打印「缓存状态」那一行（没有可指的对象），
  // 所以缓存分支要单独用「有文档但未加载」的场景验证。
  const c2 = diag.buildCommentDiagReport({
    ...ctx,
    commentsEnabled: false,
    docPath: null,
    cached: undefined,
    sidecarExists: false,
    sidecarSize: null,
  });
  r.check("总开关关闭时报告如实反映", c2.includes("批注总开关 commentsEnabled：否"));
  r.check("无活动文档时给出去向提示", c2.includes("归属文档：（无：没有打开任何 Markdown 文档）"));
  r.check("无文档时不打印缓存行", !c2.includes("缓存状态"));

  const c3 = diag.buildCommentDiagReport({
    ...ctx,
    cached: undefined,
    sidecarExists: false,
    sidecarSize: null,
  });
  r.check("有文档但缓存未加载时如实反映", c3.includes("缓存状态：未加载"));
  r.check("批注文件不存在时如实反映", c3.includes("批注文件状态：不存在"));
  r.check("两份报告文本不同（不是模板）", c1 !== c2 && c1 !== c3);

  // ── 4) 统计自检报告 ──
  const s1 = diag.buildStatsDiagReport({
    wordCountMode: "webnovel",
    dailyGoal: 5000,
    todayStr: "2026-10-16",
    dailyTotal: 1234,
    dailyGross: 1500,
    dailyDurationSeconds: 3600,
    fileBaselineCount: 80,
    baselinesAt: 1786000000000,
    isCountedFile: true,
    currentPath: "正文/第1章.md",
    currentWords: 3210,
    pomodoroBaseCount: 3000,
    pendingExternal: 0,
  });
  for (const needle of [
    "# 写作工具箱 · 字数统计自检报告",
    "统计模式 wordCountMode：webnovel",
    "净增 dailyTotal：1234",
    "毛新增 dailyGross：1500",
    "有效写作时长：60 分钟",
    "基线条数：80",
    "算不算正文（isDailyCountFile）：是",
    "当前字数：3210",
    "locateAll（批注定位，每次输入都会跑）：2 次",
    "## 怎么读这份报告",
  ]) {
    r.check("统计报告含「" + needle + "」", s1.includes(needle));
  }
  const s2 = diag.buildStatsDiagReport({
    wordCountMode: "standard", dailyGoal: 100, todayStr: "2026-10-16",
    dailyTotal: 0, dailyGross: 0, dailyDurationSeconds: 0, fileBaselineCount: 0,
    baselinesAt: 0, isCountedFile: false, currentPath: null, currentWords: null,
    pomodoroBaseCount: null, pendingExternal: 0,
  });
  r.check("非正文时报告标出「否」", s2.includes("算不算正文（isDailyCountFile）：否"));
  r.check("番茄未运行时如实反映", s2.includes("番茄基准字数：（番茄未运行）"));
  r.check("两份统计报告文本不同", s1 !== s2);

  return r.finish();
}

try {
  const ok = main();
  H.cleanup();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error("运行失败：" + e.stack);
  H.cleanup();
  process.exit(2);
}
