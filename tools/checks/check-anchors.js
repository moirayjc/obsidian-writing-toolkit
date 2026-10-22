/**
 * 检查：批注的四层锚点定位（src/comments.ts 的 AnchorLocator / locateAll / locateComment）。
 *
 * 为什么值得单独立一项检查：批注能不能跟住正文，全靠这四层。阈值写错一个数字，
 * 表现是「批注悄悄跑到别的段落上」——不报错、不崩，只是标错了地方，
 * 只有把每一层都钉住才能发现。对应文档 §3.2「锚点定位五层」表与 §4.9 的办法。
 *
 * 覆盖：
 *   1. 四层各自被命中的场景（present / exact / fuzzy / residue / paragraph）
 *   2. 失效（四层都不中 → locateAll 跳过该条，locateComment 返回 null）
 *   3. 优先级（同时满足多层时取更靠前的层）与 current 的语义
 *   4. 三个阈值：段内残余前后各 ≤28 字、头尾都不到 4 字放弃、尾部须在起点后 600 字内
 *
 * comments.ts 不 import Obsidian（纯逻辑），直接编译整个模块即可，不需要桩。
 */
const H = require("./_harness");

/** 造一条批注；只写与定位有关的字段。 */
function mk(over) {
  return Object.assign(
    {
      id: 1,
      origin: "author",
      quote: "",
      paragraph: "",
      paragraphHint: 1,
      lineHint: 1,
      createdAt: "2026-10-16 10:00",
      messages: [{ by: "author", text: "测试批注" }],
      current: "",
    },
    over
  );
}

/** 把定位结果写成一行，失败时打在 ❌ 后面，便于一眼看出「跑到了哪一层」。 */
function describe(hit, doc) {
  if (!hit) return "（没定位到）";
  const slice = doc.slice(hit.from, hit.to);
  // 失败信息里只印一小段：600 字窗口那类用例整段打出来会淹掉其它失败
  const shown = slice.length > 30 ? slice.slice(0, 30) + "…（共 " + slice.length + " 字）" : slice;
  return hit.via + " @ " + hit.from + ".." + hit.to + " " + JSON.stringify(shown);
}

/** 重复 base 直到够 n 个字，用来造「恰好 n 字」的样本。 */
function fillChars(base, n) {
  let s = "";
  while (s.length < n) s += base;
  return s.slice(0, n);
}

function main() {
  const C = H.compile("src/comments.ts", "comments");
  const r = H.createReporter("四层锚点定位（src/comments.ts 真实实现）");

  /** 单条定位：返回 locateAll 的唯一结果（条数不对则返回 null）。 */
  const locate = (doc, comment) => {
    const all = C.locateAll(doc, [comment]);
    return all.length === 1 ? all[0] : null;
  };
  /** 断言一条批注落在哪一层、圈住了哪段文字。 */
  const expectHit = (name, doc, comment, via, slice) => {
    const hit = locate(doc, comment);
    r.check(
      name + "（via=" + via + "）",
      !!hit && hit.via === via && (slice === undefined || doc.slice(hit.from, hit.to) === slice),
      "实际：" + describe(hit, doc) + "，期望 via=" + via + (slice === undefined ? "" : " slice=" + JSON.stringify(slice))
    );
    return hit;
  };

  /* ══════════ 1) 四层各自被命中 ══════════ */

  // 1.1 present：批注的「现文」与文档里某段文字一致（Agent 改稿后写回的当前文字）。
  const docPresent = "第1章 雨夜\n\n她推开木门，风雪灌了进来。";
  const cmtPresent = mk({
    quote: "狂风卷着雪片涌进屋里",
    paragraph: "她推开木门，狂风卷着雪片涌进屋里。",
    paragraphHint: 2,
    lineHint: 3,
    current: "风雪灌了进来",
  });
  r.check(
    "（用例自检）present 用例的原文确实不在文档里——否则可能是被 exact 命中的",
    docPresent.indexOf(cmtPresent.quote) === -1
  );
  const hitPresent = expectHit("按现文定位：current 与文档一致 → present", docPresent, cmtPresent, "present", "风雪灌了进来");
  r.check(
    "present 定位结果同时给出正确的行号",
    !!hitPresent && hitPresent.lineFrom === 3 && hitPresent.lineTo === 3,
    "实际 lineFrom=" + (hitPresent && hitPresent.lineFrom) + " lineTo=" + (hitPresent && hitPresent.lineTo)
  );

  // 1.2 exact：quote 原文在文档里原样存在。
  const docExact = "第2章 雪停\n\n他把伞收起来，抖掉上面的雪。";
  const cmtExact = mk({
    quote: "他把伞收起来",
    paragraph: "他把伞收起来，抖掉上面的雪。",
    paragraphHint: 2,
    lineHint: 3,
  });
  expectHit("原文精确命中：quote 原样在文档里 → exact", docExact, cmtExact, "exact", "他把伞收起来");

  // 1.3 fuzzy：文档里那处文字与 quote 只差空白/换行（正文被重新折行）。
  const docFuzzyWrap = "第3章 夜话\n\n他说完这句，\n屋里安静了下来。";
  const cmtFuzzy = mk({
    quote: "他说完这句，屋里安静了下来。",
    paragraph: "他说完这句，屋里安静了下来。",
    paragraphHint: 2,
    lineHint: 3,
  });
  r.check(
    "（用例自检）换行用例里 quote 不是原样子串——只差一个换行",
    docFuzzyWrap.indexOf(cmtFuzzy.quote) === -1
  );
  const hitFuzzy = expectHit(
    "忽略空白：只差一个换行 → fuzzy",
    docFuzzyWrap,
    cmtFuzzy,
    "fuzzy",
    "他说完这句，\n屋里安静了下来。"
  );
  r.check(
    "fuzzy 命中跨行时 lineFrom / lineTo 反映真实行号",
    !!hitFuzzy && hitFuzzy.lineFrom === 3 && hitFuzzy.lineTo === 4,
    "实际 lineFrom=" + (hitFuzzy && hitFuzzy.lineFrom) + " lineTo=" + (hitFuzzy && hitFuzzy.lineTo)
  );

  const docFuzzySpace = "第3章 夜话\n\n他 说 完 这 句，屋 里 安 静 了 下 来。";
  const hitFuzzySpace = expectHit("忽略空白：只差空格 → fuzzy", docFuzzySpace, cmtFuzzy, "fuzzy");
  r.check(
    "fuzzy 圈出的是文档里那一段连续文字（去掉空白后与 quote 相同）",
    !!hitFuzzySpace &&
      docFuzzySpace.slice(hitFuzzySpace.from, hitFuzzySpace.to).replace(/\s/g, "") === cmtFuzzy.quote,
    "实际：" + describe(hitFuzzySpace, docFuzzySpace)
  );

  // 1.4 residue：quote 已被改写，但段落里原文前后的文字还在 → 夹出被改写的那一小段。
  const docResidue = "第4章 冬夜\n\n他抬起头，望向窗外的碎雪，忽然想起那年冬天。";
  const cmtResidue = mk({
    quote: "窗外的茫茫白雪",
    paragraph: "他抬起头，望向窗外的茫茫白雪，忽然想起那年冬天。",
    paragraphHint: 2,
    lineHint: 3,
  });
  r.check(
    "（用例自检）残余用例里原文已被改写掉（文档里找不到）",
    docResidue.indexOf(cmtResidue.quote) === -1
  );
  // 圈住的是「被改写掉的那一小段」，不是整段——这正是残余人手法的意义
  expectHit("段内残余：原文前后的字还在 → residue 夹出被改写处", docResidue, cmtResidue, "residue", "窗外的碎雪");

  // 1.5 paragraph：整段被大改，但整段仍然相似（相似度 ≥0.55）。
  const docParaSim = "第7章 雪\n\n雪又落下来了。";
  const cmtParaSim = mk({
    quote: "雪落下来",
    paragraph: "雪落下来了。",
    paragraphHint: 2,
    lineHint: 3,
  });
  expectHit("段落相似：原文与前后文都被大改 → paragraph 圈住整段", docParaSim, cmtParaSim, "paragraph", "雪又落下来了。");

  // 1.6 paragraph：整段紧凑匹配（批注没有「原文」时——比如整段批注）。
  const docParaWhole = "第6章 归途\n\n他推开门，屋里空荡荡的，只有炉火还在响。";
  const cmtParaWhole = mk({
    quote: "",
    paragraph: "他推开门，屋里空荡荡的，只有炉火还在响。",
    paragraphHint: 2,
    lineHint: 3,
    messages: [{ by: "author", text: "整段批注：这段节奏太慢" }],
  });
  expectHit(
    "无原文的整段批注：靠整段紧凑匹配 → paragraph",
    docParaWhole,
    cmtParaWhole,
    "paragraph",
    "他推开门，屋里空荡荡的，只有炉火还在响。"
  );

  /* ══════════ 2) 失效 ══════════ */

  const docNone = "第8章 空\n\n什么都没有。";
  const cmtNone = mk({
    quote: "她在廊下练剑",
    paragraph: "她在廊下练剑，一招一式都很慢。",
    paragraphHint: 9,
    lineHint: 30,
    current: "",
  });
  const noneHits = C.locateAll(docNone, [cmtNone]);
  r.check(
    "四层都不中：locateAll 跳过该条（不出现在结果里）",
    noneHits.length === 0,
    "实际命中 " + noneHits.length + " 条：" + describe(noneHits[0], docNone)
  );
  r.check(
    "四层都不中：locateComment 返回 null（面板据此显示「锚点失效」）",
    C.locateComment(docNone, cmtNone) === null
  );

  /* ══════════ 3) 优先级与 current 的语义 ══════════ */

  // 3.1 documents 里既有精确原文、current 也命中 → 必须取更靠前的 present。
  const docPriority = "第1章 旧\n\n他从怀里摸出那封旧信。\n\n第2章 新\n\n他把那封旧信摊在桌上。";
  const cmtPriority = mk({
    quote: "他从怀里摸出那封旧信",
    paragraph: "他从怀里摸出那封旧信。",
    paragraphHint: 2,
    lineHint: 3,
    current: "他把那封旧信摊在桌上",
  });
  r.check(
    "（用例自检）优先级用例里 quote 也能精确命中——两层同时成立的场景",
    docPriority.indexOf(cmtPriority.quote) >= 0
  );
  const hitPriority = expectHit(
    "优先级：present 与 exact 同时成立时取更靠前的 present",
    docPriority,
    cmtPriority,
    "present",
    "他把那封旧信摊在桌上"
  );
  r.check(
    "优先级：命中的是 current 那一处，不是 quote 那一处",
    !!hitPriority && hitPriority.from === docPriority.indexOf(cmtPriority.current),
    "实际 from=" + (hitPriority && hitPriority.from) + "，current 在 " + docPriority.indexOf(cmtPriority.current)
  );

  // 3.2 current 为空串 / 全空白 → 不得误判成 present。
  expectHit(
    "current 是空字符串时不算 present → 落到 exact",
    docExact,
    mk({ quote: cmtExact.quote, paragraph: cmtExact.paragraph, paragraphHint: 2, lineHint: 3, current: "" }),
    "exact",
    "他把伞收起来"
  );
  expectHit(
    "current 只有空白时不算 present → 落到 exact",
    docExact,
    mk({ quote: cmtExact.quote, paragraph: cmtExact.paragraph, paragraphHint: 2, lineHint: 3, current: "   " }),
    "exact",
    "他把伞收起来"
  );
  // 3.3 现文在文档里找不到（Agent 又改了）→ 不能因此失效，要回落到原文。
  expectHit(
    "现文在文档里找不到时不失效：回落到原文精确命中",
    docExact,
    mk({
      quote: cmtExact.quote,
      paragraph: cmtExact.paragraph,
      paragraphHint: 2,
      lineHint: 3,
      current: "他在门口站了很久",
    }),
    "exact",
    "他把伞收起来"
  );

  // 3.4 同一段原文出现多次 → 按 lineHint 就近取舍（字段注释里写明了的语义）。
  const docTwo = "雪落下来了。\n\n中间隔一段别的。\n\n雪落下来了。";
  const cmtTwo = (lineHint) =>
    mk({ quote: "雪落下来了。", paragraph: "雪落下来了。", paragraphHint: 3, lineHint });
  const hitNear = expectHit("多处相同原文：lineHint 靠后 → 取后面那一处", docTwo, cmtTwo(5), "exact", "雪落下来了。");
  r.check(
    "多处相同原文：确实取的是第二处（from=18）",
    !!hitNear && hitNear.from === docTwo.lastIndexOf("雪落下来了。"),
    "实际 from=" + (hitNear && hitNear.from)
  );
  const hitFar = expectHit("多处相同原文：lineHint 靠前 → 取前面那一处", docTwo, cmtTwo(1), "exact", "雪落下来了。");
  r.check(
    "多处相同原文：确实取的是第一处（from=0）",
    !!hitFar && hitFar.from === docTwo.indexOf("雪落下来了。"),
    "实际 from=" + (hitFar && hitFar.from)
  );

  // 3.5 批量定位：一条失效不能带倒其它条，也不能改变顺序。
  const docMix = "第1章\n\n雪落下来了。\n\n他推开门，屋里空荡荡的，只有炉火还在响。";
  const mix = [
    mk({ id: 1, quote: "雪落下来了。", paragraph: "雪落下来了。", paragraphHint: 2, lineHint: 3 }),
    mk({
      id: 2,
      quote: "她在廊下练剑",
      paragraph: "她在廊下练剑，一招一式都很慢。",
      paragraphHint: 9,
      lineHint: 30,
    }),
    mk({ id: 3, quote: "", paragraph: "他推开门，屋里空荡荡的，只有炉火还在响。", paragraphHint: 4, lineHint: 5 }),
  ];
  const mixHits = C.locateAll(docMix, mix);
  r.check(
    "批量定位：失效的那条被跳过，其余照常且保持原顺序",
    mixHits.length === 2 && mixHits[0].comment.id === 1 && mixHits[1].comment.id === 3,
    "实际：" + mixHits.map((h) => h.comment.id + ":" + h.via).join(", ")
  );
  r.check(
    "locateComment 与 locateAll 结论一致（装饰/面板/跳转共用一套实现）",
    JSON.stringify(C.locateComment(docMix, mix[1])) === "null" &&
      C.locateComment(docMix, mix[0]).via === mixHits[0].via &&
      C.locateComment(docMix, mix[0]).from === mixHits[0].from
  );

  /* ══════════ 4) 三个阈值的边界（防的是「阈值被改错」这类静默回归）══════════ */

  // 4.1 头、尾都不到 4 字 → 段内残余放弃，交给段落相似度（文档 §3.2 表里写明）。
  const docShortEnds = "雪又落下来了。";
  expectHit(
    "阈值：残余的头尾都不到 4 字 → 放弃残余，落到段落层",
    docShortEnds,
    mk({ quote: "雪落下来", paragraph: "雪落下来了。", paragraphHint: 1, lineHint: 1 }),
    "paragraph",
    "雪又落下来了。"
  );

  // 4.2 头部恰好 4 字 → 仍然算数（不是「小于等于 4 才放弃」）。
  const docHead4 = "第5章 夜\n\n他抬起头，天已经黑了，雪下得很大。";
  const cmtHead4 = mk({
    quote: "望向窗外，雪",
    paragraph: "他抬起头望向窗外，雪下得很大。",
    paragraphHint: 2,
    lineHint: 3,
  });
  r.check(
    "（用例自检）头部恰好 4 字",
    cmtHead4.paragraph.indexOf(cmtHead4.quote) === 4
  );
  expectHit("阈值：残余的头部恰好 4 字 → 仍然按残余定位", docHead4, cmtHead4, "residue", "，天已经黑了，雪");

  // 4.3 前文/后文再长也只取紧邻的 28 字：更早、更晚的文字都改掉了也要能定位。
  const oldPrefixText = "这一段更早的文字已经被整段改写过了";
  const frozenHead28 = fillChars("他把窗子推开一条缝冷风立刻灌了进来", 28);
  const frozenTail28 = fillChars("屋里一下子凉透了他缩了缩脖子", 28);
  const oldQuote = "风从门缝里钻进来吹得他打了个寒战";
  const oldSuffixText = "后面这些文字后来也全都改掉不再保留";
  const doc28 =
    "改写后的开头换成了别的内容。" + frozenHead28 + "中间被彻底重写了，" + frozenTail28 + "末尾也换了。";
  const cmt28 = mk({
    quote: oldQuote,
    paragraph: oldPrefixText + frozenHead28 + oldQuote + frozenTail28 + oldSuffixText,
    paragraphHint: 2,
    lineHint: 3,
  });
  r.check(
    "（用例自检）样本确实是「原文前长于 28 字、后也长于 28 字」",
    frozenHead28.length === 28 &&
      frozenTail28.length === 28 &&
      cmt28.paragraph.indexOf(oldQuote) > 28 &&
      cmt28.paragraph.length - cmt28.paragraph.indexOf(oldQuote) - oldQuote.length > 28
  );
  r.check(
    "（用例自检）更早与更晚的文字在文档里都已被改掉",
    doc28.indexOf(oldPrefixText) === -1 && doc28.indexOf(oldSuffixText) === -1
  );
  const hit28 = expectHit("阈值：只取紧邻原文的前后各 28 字，更早/更晚的改动不影响定位", doc28, cmt28, "residue", "中间被彻底重写了，");
  r.check(
    "阈值：28 字窗口的两端正好咬在冻结文字上",
    !!hit28 &&
      doc28.slice(0, hit28.from).endsWith(frozenHead28) &&
      doc28.slice(hit28.to).startsWith(frozenTail28),
    "实际：" + describe(hit28, doc28)
  );

  // 4.4 尾部必须在起点后 600 字内：恰好 600 字还算，601 字就放弃。
  const head600 = "他抬起头，望向";
  const tail600 = "，忽然想起那年冬天。";
  const cmt600 = mk({
    quote: "窗外的茫茫白雪",
    paragraph: "他抬起头，望向窗外的茫茫白雪，忽然想起那年冬天。",
    paragraphHint: 1,
    lineHint: 1,
  });
  const doc600 = head600 + fillChars("雪", 600) + tail600;
  const hit600 = expectHit("阈值：尾部正好在起点后 600 字 → 仍按残余定位（含 600）", doc600, cmt600, "residue");
  r.check(
    "阈值：600 字这一档圈住的正是中间那段被改写的文字",
    !!hit600 && hit600.to - hit600.from === 600 && /^雪+$/.test(doc600.slice(hit600.from, hit600.to)),
    "实际宽度=" + (hit600 && hit600.to - hit600.from)
  );
  const doc601 = head600 + fillChars("雪", 601) + tail600;
  const hits601 = C.locateAll(doc601, [cmt600]);
  r.check(
    "阈值：尾部超过 600 字 → 放弃残余；段落层也不中 → 锚点失效",
    hits601.length === 0 && C.locateComment(doc601, cmt600) === null,
    "实际：" + describe(hits601[0], doc601)
  );

  // 4.5 只有头部活着（尾部不到 4 字）→ 零宽锚点：起点=终点，落在头部的末尾。
  //     注意 commentDecor.ts:187 要求 to > from 才画底色标记，所以这种批注在正文里
  //     只有行尾脚注序号、没有底色——定位成功但看不见，容易被当成「批注没生效」。
  const docTailShort = "第9章\n\n他抬起头，天已经黑了。";
  const hitZero = expectHit(
    "阈值：残余只剩头部（尾部不到 4 字）→ 零宽锚点，落在头部末尾",
    docTailShort,
    mk({ quote: "望向窗外，雪。", paragraph: "他抬起头望向窗外，雪。", paragraphHint: 2, lineHint: 3 }),
    "residue"
  );
  r.check(
    "零宽锚点：from 与 to 相等，且紧跟在头部文字之后",
    !!hitZero && hitZero.from === hitZero.to && docTailShort.slice(0, hitZero.from).endsWith("他抬起头"),
    "实际：" + describe(hitZero, docTailShort)
  );

  // 4.6 已修复的缺陷（2026-10-16）：头部为空时起点兜底成文档开头
  //     原文贴着段首时 head 为空，locateResidue 曾经用 `headHits = [0]` 兜底，
  //     于是 `start = hit = 0`，起点落在**文档开头**；commentDecor 对 residue 且
  //     to > from 的定位照画底色 —— 一篇 3000 字的稿子会被从开头整段涂上底色。
  //     现在：head 为空时**直接放弃残余层**，落到段落层（段落层不画底色，安全）。
  //     理由：head 缺失时没有任何东西能验证 hint，赌错了就是涂错一大片。
  //
  //     断言只说「缺陷不再发生」，不规定最终落在哪一层——这一层是文档是否
  //     恰好能匹配上段落决定的，属于实现细节，钉死它会写出脆弱的用例。
  {
    const docHeadEmpty = "第5章 夜\n\n他低头收拾书桌，雪下得很大。";
    const hitHeadEmpty = locate(
      docHeadEmpty,
      mk({ quote: "抬头望向窗外", paragraph: "抬头望向窗外，雪下得很大。", paragraphHint: 2, lineHint: 3 })
    );
    r.check(
      "头部为空：不再用「文档开头」兜底（回归：曾经 residue from=0，整篇涂色）",
      !hitHeadEmpty || hitHeadEmpty.via !== "residue" || hitHeadEmpty.from > 0,
      "实际：" + describe(hitHeadEmpty, docHeadEmpty)
    );
    r.check(
      "头部为空：即使定位到，区间也不会跨越整篇前文",
      !hitHeadEmpty || hitHeadEmpty.to - hitHeadEmpty.from < docHeadEmpty.length,
      "实际：" + describe(hitHeadEmpty, docHeadEmpty)
    );
  }

  // 4.7 同一缺陷、更隐蔽的一种：行号提示落在文档开头（hint=0）
  //     此时若拿 hint 当位置，照样得到「开头 → 尾部」的巨型区间。
  {
    const filler = "无关的正文".repeat(40);
    const docLong = filler + "\n\n他抬头看雪。X外面风很大，他把手插进口袋。\n\n收尾";
    const hit = expectHit(
      "头部为空且行号提示也不可用时，退到段落层（无底色、不跨界）",
      docLong,
      mk({
        quote: "他抬头看雪，想起很多年前的事。",
        paragraph: "他抬头看雪，想起很多年前的事。外面风很大，他把手插进口袋。",
        lineHint: 1, // ← 指向文档第一行，是个错误提示
      }),
      "paragraph"
    );
    r.check(
      "行号提示失效：不再产生「从文档开头到尾部」的巨型区间",
      !!hit && hit.from > 0 && hit.to - hit.from < 60,
      "实际 " + (hit && `${hit.from}..${hit.to}（跨 ${hit.to - hit.from} 字，文档 ${docLong.length} 字）`)
    );
  }

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
