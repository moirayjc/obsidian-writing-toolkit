/**
 * 诊断计数器：给「静默不生效」的功能留下可查的痕迹。
 *
 * 背景：批注、字数统计这类功能出问题时，界面上往往什么都看不出来
 * （标记没出现、数字没动），只能靠人描述现象。这套计数器把**每条
 * 「为什么没走到那一步」的判据都记下来**，再由一条自检命令汇总成报告落盘。
 *
 * 这是照 `formatToolbar.ts` 的 `formatToolbarDiag` 复制的模式——那个模式
 * 当初正是因为「气泡不出现且无法定位」才加的，事实证明有效。
 *
 * 本模块只做记录与成文，不依赖 Obsidian 运行时状态；需要读库/读缓存的
 * 部分由 main.ts 传进来（见 `buildCommentDiagReport` 的 ctx 参数）。
 */
import {
  LocateVia,
  WtComment,
  isSidecarPath,
  sidecarPathFor,
} from "./comments";

/* ---------- 批注痕迹 ---------- */

export interface CommentDecorDiag {
  /** create 回调触发次数 */
  createCalls: number;
  /** 达到「可以重建」条件的次数（composing 会推迟） */
  eligible: number;
  /** 因输入法拼字中而推迟 dispatch 的次数 */
  composingDeferred: number;
  /** 实际构建装饰的次数 */
  builds: number;
  /** 控制流各分支次数（键是原因短句） */
  skip: Record<string, number>;
  /** 最近一次的控制流结论 */
  lastDecision: string;
  /** 最近一次涉及的文件路径 */
  lastPath: string | null;
  /** 定位方式分布（present/exact/fuzzy/residue/paragraph） */
  via: Record<string, number>;
  /** locateAll 返回 0 条的次数 */
  locatedNone: number;
  /** 画出的原文标记数 / 脚注序号数（累计） */
  marks: number;
  chips: number;
  /** 最近一次异常 */
  lastError: string;
  lastErrorTime: number;
  /** 最近一次构建耗时（毫秒）与历史最大 */
  lastBuildMs: number;
  maxBuildMs: number;
}

export const commentDecorDiag: CommentDecorDiag = {
  createCalls: 0,
  eligible: 0,
  composingDeferred: 0,
  builds: 0,
  skip: {},
  lastDecision: "（还没有构建记录）",
  lastPath: null,
  via: {},
  locatedNone: 0,
  marks: 0,
  chips: 0,
  lastError: "",
  lastErrorTime: 0,
  lastBuildMs: 0,
  maxBuildMs: 0,
};

export function commentSkip(reason: string, path: string | null): void {
  commentDecorDiag.skip[reason] = (commentDecorDiag.skip[reason] ?? 0) + 1;
  commentDecorDiag.lastDecision = "跳过：" + reason;
  commentDecorDiag.lastPath = path;
}

export function commentBuilt(sample: {
  path: string;
  via: Record<string, number>;
  marks: number;
  chips: number;
  located: number;
  ms: number;
}): void {
  commentDecorDiag.builds++;
  commentDecorDiag.lastPath = sample.path;
  commentDecorDiag.lastBuildMs = sample.ms;
  if (sample.ms > commentDecorDiag.maxBuildMs) commentDecorDiag.maxBuildMs = sample.ms;
  commentDecorDiag.marks += sample.marks;
  commentDecorDiag.chips += sample.chips;
  if (sample.located === 0) commentDecorDiag.locatedNone++;
  for (const [k, v] of Object.entries(sample.via)) {
    commentDecorDiag.via[k] = (commentDecorDiag.via[k] ?? 0) + v;
  }
  const parts = Object.entries(sample.via).map(([k, v]) => `${k}×${v}`);
  commentDecorDiag.lastDecision =
    `已构建：定位 ${sample.located} 条${parts.length ? `（${parts.join("、")}）` : ""}，` +
    `标记 ${sample.marks} / 序号 ${sample.chips}，耗时 ${sample.ms.toFixed(1)}ms`;
}

export function commentRefreshDispatched(ms: number): void {
  commentDecorDiag.lastDecision = `已派发刷新（${ms.toFixed(1)}ms 内完成 dispatch）`;
}

export function commentError(where: string, error: unknown): void {
  commentDecorDiag.lastError = `[${where}] ${String(
    (error as Error)?.stack ?? error
  )}`;
  commentDecorDiag.lastErrorTime = Date.now();
}

/* ---------- 批注读写 ---------- */

export interface CommentIoDiag {
  /** 从磁盘读批注文件的次数 */
  loads: number;
  /** 读取异常次数 */
  loadErrors: number;
  /** 最近一次读到的条数与文件路径 */
  lastLoadPath: string | null;
  lastLoadCount: number;
  lastLoadMs: number;
  maxLoadMs: number;
  /** 批注文件被判为「不存在」的次数 */
  sidecarMissing: number;
  /** 写入次数（保存/编辑/删除/标记已处理都会经过） */
  writes: number;
  /** 因为「原文+回复都没改」而跳过的写入次数 */
  writeSkipped: number;
  /** 删除批注文件的次数 */
  sidecarDeletes: number;
  lastWritePath: string | null;
  lastWriteMs: number;
  lastWriteError: string;
}

export const commentIoDiag: CommentIoDiag = {
  loads: 0,
  loadErrors: 0,
  lastLoadPath: null,
  lastLoadCount: 0,
  lastLoadMs: 0,
  maxLoadMs: 0,
  sidecarMissing: 0,
  writes: 0,
  writeSkipped: 0,
  sidecarDeletes: 0,
  lastWritePath: null,
  lastWriteMs: 0,
  lastWriteError: "",
};

export function commentLoaded(
  docPath: string,
  count: number,
  ms: number,
  existed: boolean
): void {
  commentIoDiag.loads++;
  commentIoDiag.lastLoadPath = docPath;
  commentIoDiag.lastLoadCount = count;
  commentIoDiag.lastLoadMs = ms;
  if (ms > commentIoDiag.maxLoadMs) commentIoDiag.maxLoadMs = ms;
  if (!existed) commentIoDiag.sidecarMissing++;
}

export function commentLoadFailed(where: string, error: unknown): void {
  commentIoDiag.loadErrors++;
  commentError(where, error);
}

export function commentWrote(docPath: string, ms: number): void {
  commentIoDiag.writes++;
  commentIoDiag.lastWritePath = docPath;
  commentIoDiag.lastWriteMs = ms;
}

export function commentWriteSkipped(docPath: string): void {
  commentIoDiag.writeSkipped++;
  commentIoDiag.lastWritePath = docPath;
}

export function commentSidecarDeleted(docPath: string): void {
  commentIoDiag.sidecarDeletes++;
  commentIoDiag.lastWritePath = docPath;
}

/* ---------- 字数统计 ---------- */

export interface StatsDiag {
  /** editor-change 进入统计的次数 */
  editorChanges: number;
  /** vault modify（外部写入）进入统计的次数 */
  vaultModifies: number;
  /** 判定为「不算正文」而跳过的次数 */
  skippedNotChapter: number;
  /** 程序化编辑被忽略的次数 */
  programmaticIgnored: number;
  /** 外部同步刷新被识别并豁免时长的次数 */
  externalSyncIgnored: number;
  /** 首次建立基线的文件数（累计） */
  baselineSeeded: number;
  /** 基线键迁移（改名）与清理（删除）次数 */
  baselineMigrated: number;
  baselineDropped: number;
  /** 最近一次统计结果描述 */
  lastApply: string;
  lastApplyTime: number;
  /** locateAll 的耗时统计 */
  locateCalls: number;
  locateLastMs: number;
  locateMaxMs: number;
  /** 状态栏刷新耗时 */
  statusRefreshCalls: number;
  statusRefreshLastMs: number;
  statusRefreshMaxMs: number;
}

export const statsDiag: StatsDiag = {
  editorChanges: 0,
  vaultModifies: 0,
  skippedNotChapter: 0,
  programmaticIgnored: 0,
  externalSyncIgnored: 0,
  baselineSeeded: 0,
  baselineMigrated: 0,
  baselineDropped: 0,
  lastApply: "（还没有统计记录）",
  lastApplyTime: 0,
  locateCalls: 0,
  locateLastMs: 0,
  locateMaxMs: 0,
  statusRefreshCalls: 0,
  statusRefreshLastMs: 0,
  statusRefreshMaxMs: 0,
};

export function statsApplied(file: string, delta: number, countedDuration: boolean): void {
  statsDiag.lastApply =
    `${file} 增量 ${delta >= 0 ? "+" : ""}${delta}` + (countedDuration ? "（计入时长）" : "（不计时长）");
  statsDiag.lastApplyTime = Date.now();
}

export function recordLocate(ms: number): void {
  statsDiag.locateCalls++;
  statsDiag.locateLastMs = ms;
  if (ms > statsDiag.locateMaxMs) statsDiag.locateMaxMs = ms;
}

export function recordStatusRefresh(ms: number): void {
  statsDiag.statusRefreshCalls++;
  statsDiag.statusRefreshLastMs = ms;
  if (ms > statsDiag.statusRefreshMaxMs) statsDiag.statusRefreshMaxMs = ms;
}

/* ---------- 成文 ---------- */

export interface CommentDiagContext {
  commentsEnabled: boolean;
  bubbleEverywhere: boolean;
  /** 当前活动文档（普通文档本身；批注文件则为其源文档） */
  docPath: string | null;
  /** 该文档的批注缓存：undefined = 还没加载过 */
  cached: WtComment[] | undefined;
  /** 批注文件是否存在于库中 */
  sidecarExists: boolean;
  sidecarPath: string;
  /** 批注文件大小（字节），不存在为 null */
  sidecarSize: number | null;
}

function yn(v: boolean): string {
  return v ? "是" : "否";
}

export function buildCommentDiagReport(ctx: CommentDiagContext): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);
  const now = new Date().toLocaleString();

  push("# 写作工具箱 · 批注自检报告");
  push("");
  push(`- 代码版本标记：comment-diag-2026-10-16-a`);
  push(`- 生成时间：${now}`);
  push(`- 批注总开关 commentsEnabled：${yn(ctx.commentsEnabled)}`);
  push(`- 批注按钮全库可用 commentBubbleEverywhere：${yn(ctx.bubbleEverywhere)}`);

  push("");
  push("## 活动文档");
  push(`- 归属文档：${ctx.docPath ?? "（无：没有打开任何 Markdown 文档）"}`);
  if (ctx.docPath) {
    push(`- 是批注文件本身：${yn(isSidecarPath(ctx.docPath))}`);
    push(`- 对应批注文件：${ctx.sidecarPath}`);
    push(
      `- 批注文件状态：${
        ctx.sidecarExists ? `存在（${ctx.sidecarSize ?? "?"} 字节）` : "不存在（还没写过批注）"
      }`
    );
    const cached = ctx.cached;
    push(
      `- 缓存状态：${
        cached === undefined ? "未加载（尚未预加载）" : `已加载 ${cached.length} 条`
      }`
    );
    if (cached && cached.length > 0) {
      const pending = cached.filter((c) => c.status === "pending").length;
      push(`- 其中待处理 ${pending} 条 / 已处理 ${cached.length - pending} 条`);
    }
  }

  push("");
  push("## 装饰层（为什么标记没出现）");
  push("- 判定顺序：开关 → 文档路径 → 缓存未加载 → 无批注 → 定位失败 → 构建");
  push(`- create 回调触发：${commentDecorDiag.createCalls} 次`);
  push(`- 达到可重建条件：${commentDecorDiag.eligible} 次（含因拼字推迟后重试）`);
  push(`- 因输入法拼字中推迟：${commentDecorDiag.composingDeferred} 次`);
  push(`- 实际构建装饰：${commentDecorDiag.builds} 次`);
  push(`- 累计画出：原文标记 ${commentDecorDiag.marks} 个 / 脚注序号 ${commentDecorDiag.chips} 个`);
  push(`- locateAll 定位不到任何批注：${commentDecorDiag.locatedNone} 次`);
  const via = Object.entries(commentDecorDiag.via);
  push(
    `- 定位方式分布：${
      via.length ? via.map(([k, v]) => `${k} ×${v}`).join("、") : "（无）"
    }`
  );
  push(`- 构建耗时：最近 ${commentDecorDiag.lastBuildMs.toFixed(1)}ms / 最大 ${commentDecorDiag.maxBuildMs.toFixed(1)}ms`);
  push(`- 最近一次结论：${commentDecorDiag.lastDecision}`);
  push(`- 最近一次涉及文件：${commentDecorDiag.lastPath ?? "（无）"}`);
  push("");
  push("### 跳过原因计数");
  const skips = Object.entries(commentDecorDiag.skip).sort((a, b) => b[1] - a[1]);
  if (skips.length === 0) push("- （无跳过记录）");
  else for (const [reason, n] of skips) push(`- ${reason}：${n} 次`);

  push("");
  push("## 读写");
  push(`- 从磁盘读批注文件：${commentIoDiag.loads} 次（其中 ${commentIoDiag.sidecarMissing} 次文件不存在）`);
  push(`- 读取异常：${commentIoDiag.loadErrors} 次`);
  push(
    `- 最近一次读取：${
      commentIoDiag.lastLoadPath
        ? `${commentIoDiag.lastLoadPath} → ${commentIoDiag.lastLoadCount} 条（${commentIoDiag.lastLoadMs.toFixed(1)}ms）`
        : "（无）"
    }`
  );
  push(`- 读取耗时：最大 ${commentIoDiag.maxLoadMs.toFixed(1)}ms`);
  push(`- 写入：${commentIoDiag.writes} 次（因内容未变跳过 ${commentIoDiag.writeSkipped} 次）`);
  push(`- 删除批注文件：${commentIoDiag.sidecarDeletes} 次`);
  push(
    `- 最近一次写入：${commentIoDiag.lastWritePath ?? "（无）"}${
      commentIoDiag.lastWritePath ? `（${commentIoDiag.lastWriteMs.toFixed(1)}ms）` : ""
    }`
  );
  if (commentIoDiag.lastWriteError) push(`- 最近写入失败：${commentIoDiag.lastWriteError}`);

  const hasError = commentDecorDiag.lastError || commentIoDiag.lastWriteError;
  push("");
  push("## 异常");
  if (!hasError) push("- （无）");
  else {
    push(`- 最近异常时间：${new Date(commentDecorDiag.lastErrorTime).toLocaleString()}`);
    push("```");
    push(commentDecorDiag.lastError || commentIoDiag.lastWriteError);
    push("```");
  }

  push("");
  push("## 怎么读这份报告");
  push("- 「开关 = 否」→ 去设置里打开批注。");
  push("- 「活动文档 = 无」→ 焦点不在文档上（比如停在侧栏），先点回正文再跑一次。");
  push("- 「缓存未加载」→ 说明预加载没跑；切一下文档或重开这篇。");
  push("- 「批注文件 = 不存在」+ 缓存 0 条 → 这篇确实还没写过批注。");
  push("- 跳过原因里有大量「缓存为空」→ 批注文件被删/被清空过。");
  push("- 「定位不到任何批注」次数在涨 → 锚点失效：原文被改得太多，需要「重新绑定」。");
  push("- 构建耗时很大 → 长文档的 locateAll 是热点，考虑节流或视口裁剪。");
  return lines.join("\n");
}

export function buildStatsDiagReport(ctx: {
  wordCountMode: string;
  dailyGoal: number;
  todayStr: string;
  dailyTotal: number;
  dailyGross: number;
  dailyDurationSeconds: number;
  fileBaselineCount: number;
  baselinesAt: number;
  isCountedFile: boolean;
  currentPath: string | null;
  currentWords: number | null;
  pomodoroBaseCount: number | null;
  pendingExternal: number;
}): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push("# 写作工具箱 · 字数统计自检报告");
  push("");
  push("- 代码版本标记：stats-diag-2026-10-16-a");
  push(`- 生成时间：${new Date().toLocaleString()}`);
  push(`- 统计模式 wordCountMode：${ctx.wordCountMode}`);
  push(`- 今日目标 dailyGoal：${ctx.dailyGoal}`);

  push("");
  push("## 今日");
  push(`- 日期键：${ctx.todayStr}`);
  push(`- 净增 dailyTotal：${ctx.dailyTotal}`);
  push(`- 毛新增 dailyGross：${ctx.dailyGross}（今日目标与热力图用的是这个）`);
  push(`- 有效写作时长：${Math.round(ctx.dailyDurationSeconds / 60)} 分钟`);

  push("");
  push("## 基线");
  push(`- 基线条数：${ctx.fileBaselineCount}（内存上限 400，超出会淘汰最旧并静默漏计）`);
  push(
    `- 建档时刻 baselinesAt：${
      ctx.baselinesAt ? new Date(ctx.baselinesAt).toLocaleString() : "（0：还没有建档）"
    }`
  );

  push("");
  push("## 当前文档");
  push(`- 路径：${ctx.currentPath ?? "（无）"}`);
  push(`- 算不算正文（isDailyCountFile）：${yn(ctx.isCountedFile)}`);
  push(`- 当前字数：${ctx.currentWords ?? "（未取到）"}`);
  push(`- 该文件的基线：${ctx.currentPath && ctx.fileBaselineCount ? "见上（按路径查）" : "（无）"}`);
  push(`- 番茄基准字数：${ctx.pomodoroBaseCount ?? "（番茄未运行）"}`);

  push("");
  push("## 事件计数（为什么数字没动）");
  push(`- editor-change 进入统计：${statsDiag.editorChanges} 次`);
  push(`- vault modify（外部/AI 直接改文件）进入统计：${statsDiag.vaultModifies} 次`);
  push(`- 外部修改仍在队列里：${ctx.pendingExternal} 个`);
  push(`- 判定「不算正文」而跳过：${statsDiag.skippedNotChapter} 次`);
  push(`- 程序化编辑被忽略（快照恢复/应用格式）：${statsDiag.programmaticIgnored} 次`);
  push(`- 外部同步刷新被豁免时长：${statsDiag.externalSyncIgnored} 次`);
  push(`- 首次建立基线：${statsDiag.baselineSeeded} 个文件`);
  push(`- 基线迁移 / 清理：${statsDiag.baselineMigrated} / ${statsDiag.baselineDropped} 次`);
  push(
    `- 最近一次统计：${statsDiag.lastApply}${
      statsDiag.lastApplyTime ? `（${new Date(statsDiag.lastApplyTime).toLocaleString()}）` : ""
    }`
  );

  push("");
  push("## 性能埋点");
  push(
    `- locateAll（批注定位，每次输入都会跑）：${statsDiag.locateCalls} 次，` +
      `最近 ${statsDiag.locateLastMs.toFixed(1)}ms，最大 ${statsDiag.locateMaxMs.toFixed(1)}ms`
  );
  push(
    `- 状态栏刷新：${statsDiag.statusRefreshCalls} 次，` +
      `最近 ${statsDiag.statusRefreshLastMs.toFixed(1)}ms，最大 ${statsDiag.statusRefreshMaxMs.toFixed(1)}ms`
  );

  push("");
  push("## 怎么读这份报告");
  push("- 「算不算正文 = 否」→ 这个文件不在作品识别结果里，统计不会动（检查目录结构/设置里的关键词）。");
  push("- 「editor-change = 0」→ 输入事件没进来，可能是焦点问题或编辑器扩展没挂上。");
  push("- 「判定不算正文」次数很高 → 你可能一直在非正文文件里打字。");
  push("- 「外部修改仍在队列里」不为 0 且持续 → 队列卡住（外部写入异常）。");
  push("- 「locateAll 最大耗时」很大 → 长文档的批注定位是热点（每次输入都会重跑）。");
  push("- 数字对不上时，先看 data.json 的 `dailyFileDeltas`：它记着每天每个文件贡献了多少。");
  return lines.join("\n");
}
