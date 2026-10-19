/**
 * 检查：快照对比的双栏自由编辑（src/snapshotDiff.ts）。
 *
 * 两条历史线各固定住一半：
 *
 * A. 差异块对齐（SPEC-003 之前的回归）
 *    旧实现把空行也塞进逐行 LCS。两版正文全部改过时，空行成了唯一锚点，
 *    结果是不相关段落被强制配对、后半段左侧旧稿和右侧新稿错位。
 *
 * B. 双栏自由编辑（SPEC-003）
 *    逐块对齐与整篇连续编辑在同一 DOM 结构里互斥；用户要的是「左栏任意选中复制、
 *    右栏像编辑器一样自由改」。这里固定：
 *      1. 高亮区间由纯文本偏移算出，不往正文塞 span；
 *      2. 右栏是 plaintext-only 的单个可编辑容器，不再有逐段 data-unit-index；
 *      3. 写回前比对打开时的基线，外部改动必须拒绝；
 *      4. 样式里有 ::highlight 与 user-select: text。
 *
 * 反向验证：
 *   · 把 diffHighlightSpans 的单段字符级收窄改回整段 → 区间用例变红；
 *   · 把右栏 contenteditable 改回逐段单元 → 结构断言变红；
 *   · 删掉 styles.css 的 ::highlight 规则 → 样式断言变红。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

class Modal {
  constructor() {}
}

function main() {
  const restore = H.stubObsidian({
    App: class {},
    Editor: class {},
    Modal,
    Notice: class {},
    Setting: class {},
  });
  let S;
  try {
    // snapshot.ts 里只在「复制快照」实际执行时 require electron；纯 diff 检查外置即可。
    S = H.compile("src/snapshotDiff.ts", "snapshotDiff", ["electron"]);
  } finally {
    restore();
  }

  const r = H.createReporter("快照对比双栏自由编辑（src/snapshotDiff.ts 真实实现）");
  const changes = (blocks) => blocks.filter((block) => block.kind === "change");

  /* ── A. 差异块对齐（旧回归） ───────────────────────────── */

  {
    const oldText = ["# 旧标题", "", "第一段旧稿。", "", "第二段旧稿。", ""].join("\n");
    const newText = ["新开头。", "", "第一段新稿。", "", "第二段新稿。", ""].join("\n");
    const blocks = S.diffSnapshotBlocks(oldText, newText);
    const changed = changes(blocks);
    r.check("整篇改写只生成一个连续改动块", changed.length === 1, `实际 ${changed.length} 块`);
    r.check(
      "改写块保留左右各自全部段落",
      changed.length === 1 &&
        changed[0].left.length === 3 &&
        changed[0].right.length === 3,
      changed.length
        ? `左 ${changed[0].left.length} / 右 ${changed[0].right.length}`
        : "没有改动块"
    );
    r.check(
      "空行没有被当成相同锚点拆碎改动块",
      changed.length === 1 && blocks.filter((block) => block.kind === "same").length === 0
    );
  }

  {
    const oldText = "只有甲段。\n\n只有乙段。\n\n只有丙段。\n";
    const newText = "换成了丁段。\n\n换成了戊段。\n\n换成了己段。\n";
    const blocks = S.diffSnapshotBlocks(oldText, newText);
    const changed = changes(blocks);
    r.check(
      "空行数量相同、正文全不同：仍然只有一个改动块",
      changed.length === 1 &&
        changed[0].left.length === 3 &&
        changed[0].right.length === 3
    );
  }

  {
    const oldText = "甲\n\n乙在雨里走。\n\n丙\n";
    const newText = "甲\n\n乙在雪里走。\n\n丙\n";
    const blocks = S.diffSnapshotBlocks(oldText, newText);
    r.check(
      "局部改段：前后相同段保留，中间单独成改动块",
      blocks.length === 3 &&
        blocks[0].kind === "same" &&
        blocks[1].kind === "change" &&
        blocks[1].left.length === 1 &&
        blocks[1].right.length === 1 &&
        blocks[2].kind === "same"
    );
  }

  {
    const oldText = "甲\n\n乙\n";
    const newText = "甲\n\n新增段。\n\n乙\n";
    const blocks = S.diffSnapshotBlocks(oldText, newText);
    const changed = changes(blocks);
    r.check(
      "新增段落：左空右有，不被伪装成修改旧段",
      changed.length === 1 &&
        changed[0].left.length === 0 &&
        changed[0].right.length === 1
    );
  }

  {
    const oldText = "甲\n\n乙\n";
    const newText = "甲\n\n乙";
    const blocks = S.diffSnapshotBlocks(oldText, newText);
    r.check(
      "仅末尾换行不同：判定为内容一致",
      blocks.every((block) => block.kind === "same") && changes(blocks).length === 0
    );
  }

  /* ── B. 高亮区间（SPEC-003 新增） ─────────────────────── */

  const allSpans = (spans) => [
    ...spans.leftDeleted,
    ...spans.leftChanged,
    ...spans.rightAdded,
    ...spans.rightChanged,
  ];
  const inBounds = (text, spans) =>
    spans.every((s) => s.start >= 0 && s.end <= text.length && s.start < s.end);
  const slice = (text, span) => text.slice(span.start, span.end);
  const ordered = (spans) =>
    spans.every((s, i, arr) => i === 0 || arr[i - 1].end <= s.start);

  {
    const text = "第一段。\n\n第二段。\n";
    const spans = S.diffHighlightSpans(text, text);
    r.check(
      "完全一致时四类高亮区间都为空",
      allSpans(spans).length === 0,
      JSON.stringify(spans)
    );
  }

  {
    const oldText = "第一段。\n\n旧稿的第二段。\n\n第三段。\n";
    const newText = "第一段。\n\n新稿的第二段。\n\n第三段。\n";
    const spans = S.diffHighlightSpans(oldText, newText);
    r.check(
      "单段改写：只在一对段落上出现修改高亮，删除 / 新增都为空",
      spans.leftDeleted.length === 0 &&
        spans.rightAdded.length === 0 &&
        spans.leftChanged.length > 0 &&
        spans.rightChanged.length > 0,
      JSON.stringify(spans)
    );
    r.check(
      "单段改写：高亮收窄到字符级，不覆盖未改的邻段",
      spans.leftChanged.every((s) => !slice(oldText, s).includes("第一段。")) &&
        spans.rightChanged.every((s) => !slice(newText, s).includes("第三段。")),
      JSON.stringify({
        left: spans.leftChanged.map((s) => slice(oldText, s)),
        right: spans.rightChanged.map((s) => slice(newText, s)),
      })
    );
    r.check(
      "单段改写：高亮区间落在原文范围内且不重叠",
      inBounds(oldText, spans.leftChanged) &&
        inBounds(newText, spans.rightChanged) &&
        ordered(spans.leftChanged) &&
        ordered(spans.rightChanged)
    );
  }

  {
    const oldText = "第一段。\n\n只存在于旧稿的整段。\n\n第三段。\n";
    const newText = "第一段。\n\n第三段。\n";
    const spans = S.diffHighlightSpans(oldText, newText);
    r.check(
      "整段删除：只在左栏标删除，右栏不产生高亮",
      spans.leftDeleted.length === 1 &&
        slice(oldText, spans.leftDeleted[0]) === "只存在于旧稿的整段。" &&
        spans.leftChanged.length === 0 &&
        spans.rightAdded.length === 0 &&
        spans.rightChanged.length === 0,
      JSON.stringify(spans)
    );
  }

  {
    const oldText = "第一段。\n\n第三段。\n";
    const newText = "第一段。\n\n只在当前稿新增的整段。\n\n第三段。\n";
    const spans = S.diffHighlightSpans(oldText, newText);
    r.check(
      "整段新增：只在右栏标新增，左栏不产生高亮",
      spans.rightAdded.length === 1 &&
        slice(newText, spans.rightAdded[0]) === "只在当前稿新增的整段。" &&
        spans.leftDeleted.length === 0 &&
        spans.leftChanged.length === 0 &&
        spans.rightChanged.length === 0,
      JSON.stringify(spans)
    );
  }

  {
    const oldText = "甲段。\n\n乙段。\n\n丙段。\n";
    const newText = "完全不同的甲。\n\n完全不同的乙。\n\n完全不同的丙。\n";
    const spans = S.diffHighlightSpans(oldText, newText);
    r.check(
      "多段整块改写：两侧都按整段区间标修改，区间合法",
      spans.leftChanged.length > 0 &&
        spans.rightChanged.length > 0 &&
        inBounds(oldText, spans.leftChanged) &&
        inBounds(newText, spans.rightChanged) &&
        spans.leftDeleted.length === 0 &&
        spans.rightAdded.length === 0,
      JSON.stringify(spans)
    );
    r.check(
      "多段整块改写：区间从首段正文起、到末段正文止，不吃掉段外内容",
      spans.leftChanged.length === 1 &&
        slice(oldText, spans.leftChanged[0]) === "甲段。\n\n乙段。\n\n丙段。" &&
        slice(newText, spans.rightChanged[0]) ===
          "完全不同的甲。\n\n完全不同的乙。\n\n完全不同的丙。",
      JSON.stringify({
        left: spans.leftChanged.map((s) => slice(oldText, s)),
        right: spans.rightChanged.map((s) => slice(newText, s)),
      })
    );
  }

  {
    const oldText = "无空行第一行。\n无空行第二行。\n无空行第三行。\n";
    const newText = "无空行第一行。\n改过的第二行。\n无空行第三行。\n";
    const spans = S.diffHighlightSpans(oldText, newText);
    const leftText = spans.leftChanged.map((s) => slice(oldText, s)).join("");
    const rightText = spans.rightChanged.map((s) => slice(newText, s)).join("");
    r.check(
      "没有空行分隔的连续行：改动只在被改的那一行内，邻行不被卷进来",
      leftText === "无空行" &&
        rightText === "改过的" &&
        !leftText.includes("第一行") &&
        !leftText.includes("第三行") &&
        !rightText.includes("第一行") &&
        !rightText.includes("第三行"),
      JSON.stringify({ left: leftText, right: rightText })
    );
  }

  {
    const text = "题\n\n第一段\n\n第二段\n";
    const structure = S.parseTextStructure(text);
    r.check(
      "段落偏移可定位：每段 start/end 与原文一致",
      structure.units.length === 3 &&
        structure.units.every(
          (unit) => text.slice(unit.start, unit.end) === unit.body
        ),
      JSON.stringify(structure.units.map((u) => [u.body, u.start, u.end]))
    );
  }

  /* ── C. 结构 / 样式 / 写回保护（静态断言） ─────────────── */

  const diffSource = fs.readFileSync(path.join(H.ROOT, "src/snapshotDiff.ts"), "utf8");
  const cssSource = fs.readFileSync(path.join(H.ROOT, "styles.css"), "utf8");
  const snapshotSource = fs.readFileSync(path.join(H.ROOT, "src/snapshot.ts"), "utf8");

  r.check(
    "右栏是单个 plaintext-only 可编辑容器（纯文本，不产生块级结构）",
    /contenteditable:\s*supportsPlaintextOnly\(\)\s*\?\s*"plaintext-only"/.test(
      diffSource
    ) &&
      /function supportsPlaintextOnly\(\)/.test(diffSource) &&
      /probe\.isContentEditable/.test(diffSource)
  );
  r.check(
    "plaintext-only 不受支持时退回可编辑的 true，并按 innerText 读全文（不静默变只读）",
    /return pane\.innerText/.test(diffSource) &&
      /function readEditableText\(/.test(diffSource)
  );
  r.check("不再有逐段编辑单元 data-unit-index", !/data-unit-index/.test(diffSource));
  r.check(
    "两栏都显式声明可选中（Obsidian 在 body 上关掉了 user-select）",
    /\.wt-diff-pane\s*\{[\s\S]*?user-select:\s*text/.test(cssSource) &&
      /\.wt-diff-pane\s*\{[\s\S]*?-webkit-user-select:\s*text/.test(cssSource)
  );
  r.check(
    "高亮走 CSS Custom Highlight API（不往正文塞 span）",
    /CSS\??\.highlights/.test(diffSource) &&
      /new api\.ctor\(/.test(diffSource) &&
      !/wt-diff-chg/.test(diffSource)
  );
  const names = [
    "wt-diff-left-del",
    "wt-diff-left-chg",
    "wt-diff-right-add",
    "wt-diff-right-chg",
  ];
  r.check(
    "四个高亮注册名在样式里都有对应的 ::highlight 规则",
    names.every((name) => cssSource.includes(`::highlight(${name})`)),
    names.filter((name) => !cssSource.includes(`::highlight(${name})`)).join(", ")
  );
  r.check(
    "对比弹窗里不再出现逐行 diff 的旧结构样式",
    !/\.wt-diff-line\b/.test(cssSource) && !/\.wt-diff-lineno\b/.test(cssSource)
  );
  r.check(
    "手机端两栏改为上下叠放",
    /body\.wt-mobile\s+\.wt-diff-body\s*\{[\s\S]*?grid-template-columns:\s*1fr;/.test(
      cssSource
    )
  );
  r.check(
    "「复制选中」入口存在，且无选区时提示而不是复制全文",
    /复制选中/.test(diffSource) && /先在左栏或右栏选中要复制的文字/.test(diffSource)
  );
  r.check(
    "保留「复制快照」整份复制入口",
    /复制快照/.test(diffSource) && /copySnapshot\(/.test(diffSource)
  );
  r.check(
    "停止输入后自动保存：输入触发防抖写回，且有明确空闲阈值",
    /const AUTOSAVE_IDLE_MS = \d+/.test(diffSource) &&
      /private onRightInput\(\)/.test(diffSource) &&
      /this\.autosaveTimer = window\.setTimeout\([\s\S]*?void this\.writeBack\(false\)/.test(
        diffSource
      )
  );
  r.check(
    "自动保存不会每次写回都存备份快照（一次会话只备份一次）",
    /private backedUp = false/.test(diffSource) &&
      /const backup = !this\.backedUp/.test(diffSource) &&
      /if \(backup\) await operations\.snapshotFileSilently/.test(diffSource)
  );
  r.check(
    "保存状态可见且分色：已保存 / 未保存 / 正在保存 / 保存失败",
    /已保存/.test(diffSource) &&
      /未保存/.test(diffSource) &&
      /正在保存/.test(diffSource) &&
      /保存失败/.test(diffSource) &&
      /wt-diff-save/.test(diffSource) &&
      /\.wt-diff-save\.is-error\s*\{[\s\S]*?var\(--color-red\)/.test(cssSource)
  );
  r.check(
    "输入瞬间立即把状态改成未保存（不等高亮防抖）",
    /private onRightInput\(\): void \{[\s\S]*?this\.updateSaveStateLabel\(\)/.test(
      diffSource
    )
  );
  r.check(
    "Cmd/Ctrl+S 在弹窗内被接管为立即保存",
    /if \(key === "s"\)/.test(diffSource) && /this\.saveNow\(\)/.test(diffSource)
  );
  r.check(
    "手动入口叫「保存」而不是「应用到文档」",
    /actionButton\("保存"/.test(diffSource) && !/应用到文档/.test(diffSource)
  );
  r.check(
    "剪贴板写入统一走 snapshot.ts 的导出函数（桌面 Electron / 移动端 Web）",
    /export async function copyTextToClipboard/.test(snapshotSource) &&
      /copyTextToClipboard/.test(diffSource)
  );
  r.check(
    "写回前比对打开时的基线，外部改动拒绝写入",
    /baselineText/.test(diffSource) && /文档在对比期间已被修改/.test(diffSource)
  );
  r.check(
    "写回前仍先静默保存当前版本为快照",
    /snapshotFileSilently\(sourcePath, currentText\)/.test(diffSource)
  );
  r.check(
    "重置为快照在存在未写入修改时先确认",
    /hasUnwrittenChanges/.test(diffSource) &&
      /右栏的修改还没有写回文档，重置后这些改动会丢失/.test(diffSource)
  );
  r.check(
    "关窗先尝试保存，保存失败才问是否放弃",
    /close\(\): void \{[\s\S]*?void this\.writeBack\(false\)\.then/.test(diffSource) &&
      /未保存的修改/.test(diffSource) &&
      /关闭后这些改动会丢失/.test(diffSource)
  );

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
