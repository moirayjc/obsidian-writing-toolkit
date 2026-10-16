/**
 * 检查：行内格式的包裹与还原（src/formatWrap.ts），以及它与字数统计的联动。
 *
 * 为什么值得单独立一项检查：工具条只有「点一下」这一个反馈，
 * changes 的范围错一个字，表现就是「点了没反应」或「正文被吃掉一段」——
 * 编辑器里试错成本很高。对应文档 §3.2「格式工具条」最后一条与 §4.9。
 *
 * 覆盖：
 *   1. 六种格式的包裹 / 再切一次还原（两种方向都断言 changes 与 selFrom/selTo）
 *   2. 选区留在正文文字上（刻意设计，便于接着加别的格式）
 *   3. 单星斜体只认奇数层：`**`=粗、`***`=粗+斜、`****`=粗
 *   4. 空光标：夹在一对记号中间 → 删整对；否则插一对、光标停中间
 *   5. 字色：无标签 → 包裹；同色 → 摘掉开闭标签（两段改动）；异色 → 只换开始标签
 *   6. stripInlineFormatting 不虚增字数，且刻意不剥 `* * *` 与 `* 列表项`
 *   7. 端到端：getWordCount("**粗体**") 与「粗体」一致
 *
 * formatWrap.ts / wordcount.ts 都不 import Obsidian（纯函数），直接编译即可，不需要桩。
 */
const H = require("./_harness");

/** 把 computeToggle 返回的改动应用到文档上，得到新文档（改动互不重叠、已在源码里按序给出）。 */
function applyChanges(doc, changes) {
  const list = changes.slice().sort((a, b) => a.from - b.from);
  let out = "";
  let at = 0;
  for (const ch of list) {
    if (ch.from < at) throw new Error("改动区间重叠，无法应用：" + JSON.stringify(changes));
    out += doc.slice(at, ch.from) + ch.insert;
    at = ch.to;
  }
  return out + doc.slice(at);
}

function main() {
  const F = H.compile("src/formatWrap.ts", "formatWrap");
  const W = H.compile("src/wordcount.ts", "wordcount");
  const r = H.createReporter("格式包裹与还原（src/formatWrap.ts 真实实现）");

  const changesText = (res) => JSON.stringify(res.changes);
  /** 断言「恰好一段改动，且范围与插入内容都对」。 */
  const one = (res, from, to, insert) =>
    res.changes.length === 1 && res.changes[0].from === from && res.changes[0].to === to && res.changes[0].insert === insert;

  /* ══════════ 1) 六种格式：包裹一层 / 再切一次还原 ══════════ */

  const PLAIN = "他抬头看雪。";
  const FROM = PLAIN.indexOf("抬头");
  const TO = FROM + 2;

  const KINDS = [
    { kind: "bold", open: "**", close: "**", label: "加粗" },
    { kind: "italic", open: "*", close: "*", label: "斜体" },
    { kind: "highlight", open: "==", close: "==", label: "高亮" },
    { kind: "strike", open: "~~", close: "~~", label: "删除线" },
    { kind: "underline", open: "<u>", close: "</u>", label: "下划线" },
  ];

  for (const { kind, open, close, label } of KINDS) {
    const L = open.length;
    const R = close.length;

    // ── 包裹 ──
    const wrap = F.computeToggle(PLAIN, FROM, TO, kind);
    const wrapped = applyChanges(PLAIN, wrap.changes);
    const wantWrapped = "他" + open + "抬头" + close + "看雪。";
    r.check(
      label + "·包裹：只改选区这一处，插入 " + open + "…" + close,
      one(wrap, FROM, TO, open + "抬头" + close),
      "实际 " + changesText(wrap)
    );
    r.check(label + "·包裹：应用后正文 = " + wantWrapped, wrapped === wantWrapped, "实际 " + JSON.stringify(wrapped));
    r.check(
      label + "·包裹：选区留在正文「抬头」上（不是落在记号里——刻意设计，便于接着加别的格式）",
      wrapped.slice(wrap.selFrom, wrap.selTo) === "抬头" && wrap.selFrom === FROM + L,
      "实际 sel=" + wrap.selFrom + ".." + wrap.selTo + " 圈住 " + JSON.stringify(wrapped.slice(wrap.selFrom, wrap.selTo))
    );

    // ── 还原（选区只覆盖正文文字）──
    const dFrom = wrapped.indexOf("抬头");
    const dTo = dFrom + 2;
    const unwrap = F.computeToggle(wrapped, dFrom, dTo, kind);
    const back = applyChanges(wrapped, unwrap.changes);
    r.check(
      label + "·还原：一段改动，把成对记号连内容一起换成纯文字",
      one(unwrap, dFrom - L, dTo + R, "抬头"),
      "实际 " + changesText(unwrap)
    );
    r.check(label + "·还原：应用后回到原样 " + JSON.stringify(PLAIN), back === PLAIN, "实际 " + JSON.stringify(back));
    r.check(
      label + "·还原：选区仍落在正文「抬头」上",
      back.slice(unwrap.selFrom, unwrap.selTo) === "抬头",
      "实际 sel=" + unwrap.selFrom + ".." + unwrap.selTo + " 圈住 " + JSON.stringify(back.slice(unwrap.selFrom, unwrap.selTo))
    );
  }

  /* ══════════ 2) 记号被一起选中时同样能还原 ══════════ */

  const boldDoc = "他**抬头**看雪。";
  const selBoth = F.computeToggle(boldDoc, boldDoc.indexOf("**"), boldDoc.indexOf("**") + 6, "bold");
  r.check(
    "加粗·还原：选区连 ** 一起选中（**抬头**）也能摘掉记号",
    one(selBoth, 1, 7, "抬头") && applyChanges(boldDoc, selBoth.changes) === PLAIN && selBoth.selFrom === 1 && selBoth.selTo === 3,
    "实际 " + changesText(selBoth) + " sel=" + selBoth.selFrom + ".." + selBoth.selTo
  );
  const uDoc = "他<u>抬头</u>看雪。";
  const uSelBoth = F.computeToggle(uDoc, uDoc.indexOf("<u>"), uDoc.indexOf("<u>") + 9, "underline");
  r.check(
    "下划线·还原：选区连 <u></u> 一起选中也能摘掉记号",
    one(uSelBoth, 1, 10, "抬头") && applyChanges(uDoc, uSelBoth.changes) === PLAIN && uSelBoth.selTo === 3,
    "实际 " + changesText(uSelBoth) + " sel=" + uSelBoth.selFrom + ".." + uSelBoth.selTo
  );

  /* ══════════ 3) 单星斜体只认奇数层 ══════════ */

  // `**` 是加粗，不是斜体 → 在粗体上点斜体应该变成 `***`（粗 + 斜），而不是把粗体摘掉
  const italicOnBold = F.computeToggle(boldDoc, 3, 5, "italic");
  const tripled = applyChanges(boldDoc, italicOnBold.changes);
  r.check(
    "层数：`**` 不算斜体 → 在粗体上点斜体得到 `***`（粗+斜）",
    tripled === "他***抬头***看雪。" && one(italicOnBold, 3, 5, "*抬头*"),
    "实际 " + JSON.stringify(tripled) + " " + changesText(italicOnBold)
  );
  r.check(
    "层数：`***` 同时算加粗与斜体（detectActiveKinds）",
    JSON.stringify([...F.detectActiveKinds("他***抬头***看雪。", 4, 6)].sort()) === JSON.stringify(["bold", "italic"]),
    "实际 " + JSON.stringify([...F.detectActiveKinds("他***抬头***看雪。", 4, 6)])
  );
  r.check(
    "层数：`****` 只算加粗，不算斜体（4 是偶数层）",
    JSON.stringify([...F.detectActiveKinds("他****抬头****看雪。", 5, 7)]) === JSON.stringify(["bold"]),
    "实际 " + JSON.stringify([...F.detectActiveKinds("他****抬头****看雪。", 5, 7)])
  );
  const boldOnFour = F.computeToggle("他****抬头****看雪。", 5, 7, "bold");
  r.check(
    "层数：`****` 上点加粗 → 只摘掉加粗那一层，剩 `**`（粗体仍在）",
    applyChanges("他****抬头****看雪。", boldOnFour.changes) === boldDoc &&
      one(boldOnFour, 3, 9, "抬头"),
    "实际 " + JSON.stringify(applyChanges("他****抬头****看雪。", boldOnFour.changes)) + " " + changesText(boldOnFour)
  );

  /* ══════════ 4) 空光标 ══════════ */

  const caretInsert = F.computeToggle(PLAIN, 1, 1, "bold");
  const caretDoc = applyChanges(PLAIN, caretInsert.changes);
  r.check(
    "空光标·不在记号对中 → 插入一对记号",
    one(caretInsert, 1, 1, "****") && caretDoc === "他****抬头看雪。",
    "实际 " + changesText(caretInsert) + " → " + JSON.stringify(caretDoc)
  );
  r.check(
    "空光标·插入后光标停在一对记号中间",
    caretInsert.selFrom === 3 && caretInsert.selTo === 3 && caretDoc.slice(0, caretInsert.selFrom) === "他**",
    "实际 sel=" + caretInsert.selFrom + ".." + caretInsert.selTo
  );

  const caretDelete = F.computeToggle("他****看雪。", 3, 3, "bold");
  r.check(
    "空光标·恰好夹在一对记号中间 → 删掉整对（加粗的 **** → 什么也不剩）",
    one(caretDelete, 1, 5, "") && applyChanges("他****看雪。", caretDelete.changes) === "他看雪。",
    "实际 " + changesText(caretDelete)
  );
  r.check(
    "空光标·删整对后光标停在原位（原记号起点）",
    caretDelete.selFrom === 1 && caretDelete.selTo === 1,
    "实际 sel=" + caretDelete.selFrom + ".." + caretDelete.selTo
  );

  // 既有语义（文档没写）：光标落在 `**` 的两个星号中间时，斜体看到左右各 1 层星号，
  // 判定为「夹在一对斜体记号中间」，于是把这对星号删掉——效果等于顺手取消了加粗。
  const caretInBold = F.computeToggle("他**看雪。", 2, 2, "italic");
  r.check(
    "空光标·夹在 ** 中间时按斜体 → 左右各 1 层星号，认定为斜体对并删掉（等于取消加粗）",
    one(caretInBold, 1, 3, "") && applyChanges("他**看雪。", caretInBold.changes) === "他看雪。",
    "实际 " + changesText(caretInBold)
  );

  /* ══════════ 5) 字色 ══════════ */

  const TAG = F.FORMAT_COLORS[0].hex; // 默认色 = 第一个色板的红
  const tagText = '<span style="color: ' + TAG + '">';
  const colorPlain = F.computeToggle(PLAIN, FROM, TO, "color");
  const colorWrapped = applyChanges(PLAIN, colorPlain.changes);
  r.check(
    "字色·无标签 → 包一层 `<span style=\"color: #hex\">…</span>`",
    one(colorPlain, FROM, TO, tagText + "抬头</span>") && colorWrapped === "他" + tagText + "抬头</span>看雪。",
    "实际 " + changesText(colorPlain) + " → " + JSON.stringify(colorWrapped)
  );
  r.check(
    "字色·包裹后选区仍落在正文「抬头」上",
    colorWrapped.slice(colorPlain.selFrom, colorPlain.selTo) === "抬头",
    "实际圈住 " + JSON.stringify(colorWrapped.slice(colorPlain.selFrom, colorPlain.selTo))
  );
  r.check(
    "字色·包裹后工具条能认出当前颜色（detectColorAt）",
    F.detectColorAt(colorWrapped, colorPlain.selFrom, colorPlain.selTo) === TAG,
    "实际 " + JSON.stringify(F.detectColorAt(colorWrapped, colorPlain.selFrom, colorPlain.selTo))
  );
  r.check(
    "字色·无标签时默认用色板第一个色（DEFAULT_FORMAT_COLOR）",
    F.DEFAULT_FORMAT_COLOR === TAG && F.FORMAT_COLORS.length >= 2,
    "实际 " + F.DEFAULT_FORMAT_COLOR
  );

  const colored = "他" + tagText + "抬头</span>看雪。";
  const cFrom = colored.indexOf("抬头");
  const cTo = cFrom + 2;
  const sameColor = F.computeToggle(colored, cFrom, cTo, "color", TAG);
  r.check(
    "字色·同色 → 摘掉开、闭两个标签，因此是**两段**连续改动（不是一段）",
    sameColor.changes.length === 2 &&
      sameColor.changes[0].from === cFrom - tagText.length &&
      sameColor.changes[0].to === cFrom &&
      sameColor.changes[0].insert === "" &&
      sameColor.changes[1].from === cTo &&
      sameColor.changes[1].to === cTo + 7 &&
      sameColor.changes[1].insert === "",
    "实际段数=" + sameColor.changes.length + " " + changesText(sameColor)
  );
  r.check(
    "字色·同色 → 两段改动应用后回到无格式正文",
    applyChanges(colored, sameColor.changes) === PLAIN,
    "实际 " + JSON.stringify(applyChanges(colored, sameColor.changes))
  );
  r.check(
    "字色·同色 → 选区落在正文「抬头」上",
    applyChanges(colored, sameColor.changes).slice(sameColor.selFrom, sameColor.selTo) === "抬头",
    "实际 sel=" + sameColor.selFrom + ".." + sameColor.selTo
  );
  r.check(
    "字色·同色判定忽略大小写与空格（sameColor 归一化）→ 仍然能摘掉",
    applyChanges(colored, F.computeToggle(colored, cFrom, cTo, "color", " #C94F4F ").changes) === PLAIN
  );

  const other = F.FORMAT_COLORS[3].hex;
  const reColor = F.computeToggle(colored, cFrom, cTo, "color", other);
  r.check(
    "字色·异色 → 只换开始标签（一段改动，闭合标签原地不动）",
    reColor.changes.length === 1 &&
      reColor.changes[0].from === cFrom - tagText.length &&
      reColor.changes[0].to === cFrom &&
      reColor.changes[0].insert === '<span style="color: ' + other + '">',
    "实际段数=" + reColor.changes.length + " " + changesText(reColor)
  );
  const recolored = applyChanges(colored, reColor.changes);
  r.check(
    "字色·异色 → 应用后颜色换了、内容与闭合标签都没动",
    recolored === "他" + '<span style="color: ' + other + '">' + "抬头</span>看雪。",
    "实际 " + JSON.stringify(recolored)
  );
  r.check(
    "字色·异色 → 选区落在正文「抬头」上",
    recolored.slice(reColor.selFrom, reColor.selTo) === "抬头",
    "实际圈住 " + JSON.stringify(recolored.slice(reColor.selFrom, reColor.selTo))
  );

  // 选区连开始标签一起选中（inside 分支）：同样认得出同色并摘掉整对
  const insideDoc = tagText + "抬头</span>看雪。";
  const insideRes = F.computeToggle(insideDoc, 0, tagText.length + 2, "color", TAG);
  r.check(
    "字色·选区连开始标签一起选中 → 仍认得出同色并摘掉整对（两段改动）",
    insideRes.changes.length === 2 && applyChanges(insideDoc, insideRes.changes) === "抬头看雪。",
    "实际 " + changesText(insideRes)
  );
  r.check(
    "字色·连标签选中并摘掉后，选区落在正文「抬头」上",
    applyChanges(insideDoc, insideRes.changes).slice(insideRes.selFrom, insideRes.selTo) === "抬头",
    "实际圈住 " + JSON.stringify(applyChanges(insideDoc, insideRes.changes).slice(insideRes.selFrom, insideRes.selTo))
  );

  const colorCaret = F.computeToggle(PLAIN, 1, 1, "color", TAG);
  r.check(
    "空光标·字色 → 插入一空对，光标停中间（接着打字就带颜色）",
    one(colorCaret, 1, 1, tagText + "</span>") &&
      colorCaret.selFrom === 1 + tagText.length &&
      colorCaret.selTo === colorCaret.selFrom,
    "实际 " + changesText(colorCaret) + " sel=" + colorCaret.selFrom + ".." + colorCaret.selTo
  );

  /* ══════════ 6) stripInlineFormatting：字数统计前的剥离 ══════════ */

  const PLAIN_SENTENCE = "他抬头看雪。";
  for (const [label, marked] of [
    ["加粗", "他**抬头**看雪。"],
    ["斜体", "他*抬头*看雪。"],
    ["高亮", "他==抬头==看雪。"],
    ["删除线", "他~~抬头~~看雪。"],
    ["下划线", "他<u>抬头</u>看雪。"],
    ["字色", "他" + tagText + "抬头</span>看雪。"],
    ["嵌套 ***", "他***抬头***看雪。"],
  ]) {
    const stripped = F.stripInlineFormatting(marked);
    r.check(
      "剥离·" + label + "：剥掉记号后与纯正文逐字相同（字数不虚增）",
      stripped === PLAIN_SENTENCE,
      "实际 " + JSON.stringify(stripped)
    );
  }
  r.check(
    "剥离·HTML 标签整体去掉（mark/font/br）",
    F.stripInlineFormatting("<mark>抬头</mark>") === "抬头" &&
      F.stripInlineFormatting('<font color="red">抬头</font>') === "抬头" &&
      F.stripInlineFormatting("抬头<br>看雪") === "抬头看雪"
  );
  r.check(
    "剥离·结果只会更短或等长，绝不变长（这是「格式不虚增字数」的核心）",
    [
      "他**抬头**看雪。",
      "他" + tagText + "抬头</span>看雪。",
      "他==抬头==看雪。",
      "他***抬头***看雪。",
    ].every((s) => F.stripInlineFormatting(s).length <= PLAIN_SENTENCE.length)
  );
  r.check(
    "剥离·嵌套 `***三个星***` 两层都剥干净",
    F.stripInlineFormatting("***三个星***") === "三个星",
    "实际 " + JSON.stringify(F.stripInlineFormatting("***三个星***"))
  );
  r.check(
    "剥离·多个独立的斜体片段都剥掉",
    F.stripInlineFormatting("*斜体*和*再斜体*") === "斜体和再斜体",
    "实际 " + JSON.stringify(F.stripInlineFormatting("*斜体*和*再斜体*"))
  );

  // —— 刻意不剥的两条（写稿人自己打的内容，剥了等于篡改正文）——
  r.check(
    "刻意不剥·场景分隔线 `* * *` 原样保留（斜体剥离要求星号后紧跟非空白非星号）",
    F.stripInlineFormatting("* * *") === "* * *",
    "实际 " + JSON.stringify(F.stripInlineFormatting("* * *"))
  );
  r.check(
    "刻意不剥·列表项 `* 列表项` 原样保留（同上：星号后是空白）",
    F.stripInlineFormatting("* 列表项") === "* 列表项",
    "实际 " + JSON.stringify(F.stripInlineFormatting("* 列表项"))
  );
  r.check(
    "刻意不剥·星号包着空白的情况 `* 抬头 *` 也原样保留",
    F.stripInlineFormatting("* 抬头 *") === "* 抬头 *",
    "实际 " + JSON.stringify(F.stripInlineFormatting("* 抬头 *"))
  );
  r.check(
    "刻意不剥·孤立的 `**` 不会被当成一对记号（否则会凭空吃掉两个星号）",
    F.stripInlineFormatting("**") === "**",
    "实际 " + JSON.stringify(F.stripInlineFormatting("**"))
  );
  // 文档没写的一条现有语义：加粗用 /s（能跨行），斜体用 [^*\n]（不跨行）。
  // 不跨行更安全（上下两行的星号不会被配成一对），这里把现状钉住。
  r.check(
    "剥离·斜体不跨行：`*斜体\\n第二行*` 原样保留",
    F.stripInlineFormatting("*斜体\n第二行*") === "*斜体\n第二行*",
    "实际 " + JSON.stringify(F.stripInlineFormatting("*斜体\n第二行*"))
  );
  r.check(
    "剥离·加粗跨行（/s 标志）：`**粗\\n跨行**` 会剥成 `粗\\n跨行`",
    F.stripInlineFormatting("**粗\n跨行**") === "粗\n跨行",
    "实际 " + JSON.stringify(F.stripInlineFormatting("**粗\n跨行**"))
  );

  /* ══════════ 7) 端到端：格式记号不计入字数统计 ══════════ */

  for (const mode of ["webnovel", "standard", "native"]) {
    const bare = W.getWordCount("粗体", mode);
    r.check(
      "端到端·" + mode + "：`**粗体**` 与「粗体」字数一致（承诺：格式记号不计入统计）",
      bare === 2 && W.getWordCount("**粗体**", mode) === bare && W.getWordCount("<u>粗体</u>", mode) === bare,
      "实际 粗体=" + bare + " **粗体**=" + W.getWordCount("**粗体**", mode) + " <u>粗体</u>=" + W.getWordCount("<u>粗体</u>", mode)
    );
  }
  r.check(
    "端到端·webnovel：字色与高亮、删除线包裹后字数同样不变",
    W.getWordCount("粗体", "webnovel") === 2 &&
      W.getWordCount(tagText + "粗体</span>", "webnovel") === 2 &&
      W.getWordCount("==粗体==", "webnovel") === 2 &&
      W.getWordCount("~~粗体~~", "webnovel") === 2
  );
  r.check(
    "端到端·webnovel：混合记号 `**粗体**与*斜体*` = 5 字（剥完正好是「粗体与斜体」）",
    W.getWordCount("**粗体**与*斜体*", "webnovel") === 5,
    "实际 " + W.getWordCount("**粗体**与*斜体*", "webnovel")
  );
  r.check(
    "端到端·webnovel：刻意不剥的 `* * *` 仍按 3 个字计（分隔线是作者写的内容，不是记号）",
    W.getWordCount("* * *", "webnovel") === 3,
    "实际 " + W.getWordCount("* * *", "webnovel")
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
