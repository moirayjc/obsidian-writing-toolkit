/**
 * 检查：全书章节重编号的规划（src/chapterOrder.ts 的 `planBookRenumber`）。
 *
 * 背景（用户报的真实问题）：原来删除后的重编号是从删除位置往下「连减」，
 * **遇到第一个编号间断就停**。所以只要编号不连续（第1卷 1、3；第2卷 2、4），
 * 删掉一章后后面**一章都不会动**。实测「1、3、5 删第3章」→ 重编号 0 章。
 *
 * 约定：计划里**只含真正要改名的条目**（不需要改的章节根本不出现），
 * 且按目标编号**从大到小**排列（先腾出高位，避免半路撞名）。
 *
 * 本检查钉住两件事：
 * 1. **问题被修好**：间断编号也能重排成 1..N 连续（跨卷按阅读顺序）
 * 2. **不该动的绝不乱动**：编号本来就连续时计划为空；
 *    序章/番外不参与；作者用 frontmatter `sort_index` 定制的章节整项跳过；
 *    目标名被外人占用时标 conflict 并跳过（**绝不能覆盖别人的文件**）
 */
const H = require("./_harness");

/** 造一个章节输入（跨卷：卷号用来拼路径，模拟真实目录）。 */
const ch = (volume, basename, number, sortIndex = null) => ({
  file: { path: `作品/第${volume}卷/${basename}.md`, basename },
  number,
  sortIndex,
});

/**
 * 重排后的**全书文件名单**。
 * 注意 `plan.items` 里**只有要改的条目**（不需要改的章节根本不出现），
 * 所以这里要把未出现的原文件按原地补回去，才是「重排后的完整结果」。
 */
const afterRenumber = (plan, allBasenames) => {
  const changed = new Map(plan.items.map((i) => [i.basename, i.newName]));
  return allBasenames.map((b) => changed.get(b) ?? b);
};

/** 计划里要改的条目，按目标编号正序 */
const changesInOrder = (plan) =>
  [...plan.items].sort((a, b) => a.to - b.to).map((i) => i.newName.replace(/\.md$/, ""));

function main() {
  const co = H.compile("src/chapterOrder.ts", "chapterOrder");
  const { planBookRenumber: planRaw, describeRenumberPlan } = co;
  // 真实调用会传「库里全部路径」；测试里默认就用输入自身的路径集合
  const planBookRenumber = (list, extra = []) =>
    planRaw(list, new Set([...list.map((c) => c.file.path), ...extra]));
  const r = H.createReporter("全书章节重编号（src/chapterOrder.ts 真实实现）");

  // ── 1) 用户报的场景：跨卷、有间断 ──
  {
    // 第1卷 1、3；第2卷 2、4 —— 正是用户描述的前提
    const plan = planBookRenumber([
      ch(1, "第1章", 1), ch(1, "第3章", 3),
      ch(2, "第2章", 2), ch(2, "第4章", 4),
    ]);
    r.check(
      "间断编号：只改真正需要动的 2 章（第1章、第4章本来就在正确位置）",
      plan.renames === 2,
      `renames=${plan.renames}, items=${JSON.stringify(plan.items.map((i) => [i.basename, i.newName]))}`
    );
    r.check(
      "间断编号：重排后全书是 1..4 连续（跨卷拉平）",
      afterRenumber(plan, ["第1章", "第3章", "第2章", "第4章"]).join(" | ") ===
        "第1章 | 第2章 | 第3章 | 第4章",
      "实际 " + afterRenumber(plan, ["第1章", "第3章", "第2章", "第4章"]).join(" | ")
    );
    r.check(
      "间断编号：第1卷的「第3章」变成「第2章」（跨卷拉平）",
      plan.items.some((i) => i.basename === "第3章" && i.newName === "第2章")
    );
  }

  // ── 2) 删除后的典型残留：1、2、4（少了 3）──
  {
    const plan = planBookRenumber([
      ch(1, "第1章", 1), ch(1, "第2章", 2), ch(2, "第4章", 4),
    ]);
    r.check(
      "删章残留（1、2、4）：第4章补成第3章",
      changesInOrder(plan).join(" | ") === "第3章",
      "实际 " + changesInOrder(plan).join(" | ")
    );
    r.check("删章残留：只有 1 章需要改名", plan.renames === 1, `renames=${plan.renames}`);
    r.check(
      "已在正确位置的章节不出现在计划里（不会被白改一次）",
      !plan.items.some((i) => i.basename === "第1章" || i.basename === "第2章")
    );
  }

  // ── 3) 不该乱动：编号本来就连续 ──
  {
    const plan = planBookRenumber([
      ch(1, "第1章", 1), ch(1, "第2章", 2), ch(2, "第3章", 3), ch(2, "第4章", 4),
    ]);
    r.check(
      "编号连续时：计划为空（绝不去动一个本来就正确的库）",
      plan.renames === 0 && plan.items.length === 0,
      `renames=${plan.renames}, items=${JSON.stringify(plan.items.map((i) => i.basename))}`
    );
  }

  // ── 4) 特殊章节不参与编号 ──
  {
    const plan = planBookRenumber([
      ch(1, "序章", 0), ch(1, "楔子", 0),
      ch(1, "第1章", 1), ch(1, "第2章", 2),
      ch(2, "第3章", 3), ch(2, "番外", null), ch(2, "后记", null),
    ]);
    r.check(
      "序章/楔子/番外/后记都不参与重编号",
      !plan.items.some((i) => ["序章", "楔子", "番外", "后记"].includes(i.basename)),
      JSON.stringify(plan.items.map((i) => i.basename))
    );
    r.check("有特殊章节时，正文编号仍然连续 → 计划为空", plan.renames === 0);
  }

  // ── 5) 作者定制顺序（frontmatter sort_index）整项跳过 ──
  {
    const plan = planBookRenumber([
      ch(1, "第1章", 1),
      ch(1, "第9章", 9, 2), // ← 作者用 sort_index 把它钉在这个位置
      ch(2, "第2章", 2), ch(2, "第3章", 3),
    ]);
    r.check(
      "带 sort_index 的章节不参与重编号（不跟作者的定制顺序对冲）",
      !plan.items.some((i) => i.basename === "第9章")
    );
    r.check(
      "其余章节按自己的顺序连续编号 → 已是 1、2、3，计划为空",
      plan.renames === 0,
      `renames=${plan.renames}, items=${JSON.stringify(plan.items.map((i) => [i.basename, i.newName]))}`
    );
  }

  // ── 6) 认不出编号写法的不硬改 ──
  {
    const plan = planBookRenumber([
      ch(1, "第1章", 1),
      ch(1, "正文试写稿（参考版）2", null), // number 为 null
      ch(1, "第2章", 2),
    ]);
    r.check(
      "没有编号的章节不参与",
      !plan.items.some((i) => i.basename.includes("试写稿"))
    );
  }

  // ── 7) 目标名被别人占用 → 标 conflict 且不改（不覆盖文件）──
  {
    const plan = planBookRenumber([
      ch(1, "第1章", 1),
      ch(1, "第3章", 3),
      // 第 2 位本该变成「第2章」，但同目录下已存在一个**不参与编号**的「第2章.md」
      { file: { path: "作品/第1卷/第2章.md", basename: "第2章" }, number: null, sortIndex: null },
      ch(2, "第4章", 4),
    ]);
    const conflicted = plan.items.filter((i) => i.conflict);
    r.check(
      "目标名被外人占用时标 conflict",
      conflicted.length > 0,
      JSON.stringify(plan.items.map((i) => [i.basename, i.newName, i.conflict]))
    );
    r.check("conflict 不计入 renames（执行时跳过）", plan.conflicts === conflicted.length);
  }

  // ── 8) 执行顺序：从高位开始改，避免撞名 ──
  {
    const plan = planBookRenumber([
      ch(1, "第1章", 1), ch(1, "第3章", 3), ch(2, "第4章", 4),
    ]);
    const tos = plan.items.map((i) => i.to);
    const sortedDesc = [...tos].sort((a, b) => b - a);
    r.check(
      "计划按目标编号从大到小排列（先腾出高位）",
      JSON.stringify(tos) === JSON.stringify(sortedDesc),
      `实际 ${tos.join(",")}`
    );
  }

  // ── 9) 各种命名风格都保住 ──
  {
    // 注意测试数据的序号必须真实：`005 入京` 会被解析成 25 号（前导序号按数字读）
    const plan = planBookRenumber([
      ch(1, "第三章", 3), ch(1, "第5章 入京", 5), ch(2, "7-收尾", 7),
    ]);
    r.check(
      "中文数字 / 带标题 / 连字符序号都保留原写法",
      changesInOrder(plan).join(" | ") === "第一章 | 第2章 入京 | 3-收尾",
      "实际 " + changesInOrder(plan).join(" | ")
    );
  }

  // ── 10) 编号对但写法不标准 → 也要改（这是一条容易漏的边界）──
  {
    const plan = planBookRenumber([ch(1, "第1章", 1), ch(1, "第3章", 3)]);
    // 「第3章」在第 2 位：编号 3≠2 → 必然在计划里
    r.check(
      "位置与编号不符的章节一定会被改",
      plan.items.length === 1 && plan.items[0].newName === "第2章",
      JSON.stringify(plan.items.map((i) => [i.basename, i.newName]))
    );
  }

  // ── 11) 预览文案 ──
  {
    const plan = planBookRenumber([ch(1, "第1章", 1), ch(1, "第3章", 3)]);
    const text = describeRenumberPlan(plan);
    r.check(
      "预览文案写出「原编号 → 新编号」与文件名变化",
      text.includes("第 3 章 → 第 2 章") && text.includes("第3章 → 第2章"),
      text
    );
    const none = planBookRenumber([ch(1, "第1章", 1), ch(1, "第2章", 2)]);
    r.check(
      "无需改动时预览文案明确告知「已经是连续的」",
      describeRenumberPlan(none).includes("已经是连续的"),
      JSON.stringify(describeRenumberPlan(none))
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
