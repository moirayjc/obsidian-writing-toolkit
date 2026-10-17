/**
 * 检查：快照对比的段落块对齐（src/snapshotDiff.ts）。
 *
 * 旧实现把空行也塞进逐行 LCS。两版正文全部改过时，空行成了唯一锚点，
 * 结果是不相关段落被强制配对、后半段左侧旧稿和右侧新稿错位。
 *
 * 这里固定三条行为：
 *   1. 空行不参与 diff，只保留为段落间隔；
 *   2. 连续改写整块展示，不按位置硬配成多行「修改」；
 *   3. 末尾换行/空行差异不算正文改动，编辑回写时仍原样保留。
 */
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

  const r = H.createReporter("快照对比块对齐（src/snapshotDiff.ts 真实实现）");
  const changes = (blocks) => blocks.filter((block) => block.kind === "change");

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

  {
    const original = "题\n\n第一段\n\n第二段\n";
    const structure = S.parseTextStructure(original);
    const bodies = new Map([[structure.units[2].unitIndex, "第二段改"]]);
    const output = S.composeEditedText(structure, bodies);
    r.check(
      "右侧编辑回写：保留段落空行与末尾换行",
      output === "题\n\n第一段\n\n第二段改\n",
      JSON.stringify(output)
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
