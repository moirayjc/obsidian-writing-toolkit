/**
 * 检查：作者在编辑器里改正文时，批注位置跟着改动走（src/commentDecor.ts 真实实现 + 真实 CodeMirror）。
 *
 * 背景：原来每次按键都拿「原文」重新全文找，作者亲手改掉原文后批注就「无法定位」；
 * 删掉的原文还可能被同样的字指到别处。现在由 anchorField 按改动映射位置，
 * 停手后把现在的文字写回「现文」，整段删掉的标「原文已删除」。
 *
 * 编辑器视图（停手计时、失焦交付）在 Node 里跑不了，这里验的是跟踪表与装饰：
 * pendingAnchorEdits 读到的就是停手后会交付的内容。
 */
const path = require("path");

// 临时编译产物位于系统临时目录；让外置的 CodeMirror 解析回仓库依赖（同 check-chapter-status.js）。
process.env.NODE_PATH = [
  path.resolve(__dirname, "..", "..", "node_modules"),
  process.env.NODE_PATH,
]
  .filter(Boolean)
  .join(path.delimiter);
require("module").Module._initPaths();

const H = require("./_harness");
const { EditorState, StateField } = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");

const CODEMIRROR_EXTERNALS = ["@codemirror/state", "@codemirror/view"];
const PATH = "正文/第一章.md";

function main() {
  const r = H.createReporter("批注位置跟踪（作者改正文）");
  const editorInfoField = StateField.define({
    create: () => ({ file: { path: PATH } }),
    update: (value) => value,
  });
  const restore = H.stubObsidian({ editorInfoField });
  let decor, comments;
  try {
    decor = H.compile("src/commentDecor.ts", "anchor-tracking", CODEMIRROR_EXTERNALS);
    comments = H.compile("src/comments.ts", "anchor-tracking-comments");
  } finally {
    restore();
  }

  const doc = [
    "风停了，渡口的船都歇了。",
    "",
    "有点意思。",
    "",
    "他把灯放下，转身出门。",
  ].join("\n");
  const mk = (id, quote, paragraph) => ({
    id,
    origin: "agent",
    quote,
    paragraph,
    paragraphHint: 0,
    lineHint: 1,
    createdAt: "2026-10-22 22:16",
    messages: [{ by: "agent", text: "意见" }],
    current: "",
  });
  const list = [
    mk(1, "渡口的船都歇了", "风停了，渡口的船都歇了。"),
    mk(2, "有点意思。", "有点意思。"),
    mk(3, "转身出门", "他把灯放下，转身出门。"),
  ];
  const ext = decor.buildCommentExtensions({
    enabled: () => true,
    getComments: (p) => (p === PATH ? list : undefined),
    ensureLoaded() {},
    onRevealComment() {},
    onAnchorsEdited() {},
  });
  let state = EditorState.create({ doc, extensions: [editorInfoField, ext] });

  const edit = (from, to, insert, userEvent) => {
    state = state.update({
      changes: { from, to, insert },
      ...(userEvent ? { userEvent } : {}),
    }).state;
  };
  const marks = () => {
    const out = new Map();
    for (const set of state.facet(EditorView.decorations)) {
      const value = typeof set === "function" ? null : set;
      if (!value) continue;
      value.between(0, state.doc.length, (from, to, deco) => {
        const cid = deco.spec?.attributes?.["data-wt-cid"];
        if (cid && to > from) out.set(Number(cid), state.sliceDoc(from, to));
      });
    }
    return out;
  };

  r.check("初始：没有待写回的改动", decor.pendingAnchorEdits(state).length === 0);

  // 1) 作者改写原文中间的字：标记跟住，交付「现文」
  const at = state.doc.toString().indexOf("船都歇了");
  edit(at, at + 4, "船早就歇了", "input.type");
  const e1 = decor.pendingAnchorEdits(state).find((e) => e.id === 1);
  r.check(
    "改写原文：标记跟到改后的文字",
    marks().get(1) === "渡口的船早就歇了",
    JSON.stringify([...marks()])
  );
  r.check(
    "改写原文：交付现文与所在整段",
    e1 && !e1.gone && e1.text === "渡口的船早就歇了" &&
      e1.paragraph === "风停了，渡口的船早就歇了。",
    JSON.stringify(e1)
  );

  // 2) 在原文紧后面打字：不算进批注
  const end3 = state.doc.toString().indexOf("转身出门") + 4;
  edit(end3, end3, "，再没回头", "input.type");
  r.check(
    "原文紧后打的字不算进批注",
    !decor.pendingAnchorEdits(state).some((e) => e.id === 3) &&
      marks().get(3) === "转身出门"
  );

  // 3) 整段删掉：标「原文已删除」，不再被同样的字指到别处
  const p2 = state.doc.toString().indexOf("有点意思。");
  edit(p2, p2 + "有点意思。\n\n".length, "", "delete.backward");
  const e2 = decor.pendingAnchorEdits(state).find((e) => e.id === 2);
  r.check("整段删掉：交付「原文已删除」", e2 && e2.gone && e2.text === "", JSON.stringify(e2));
  r.check("删掉后不再画原文标记", !marks().has(2));

  // 4) 写回之后，定位器用「现文」和「原文已删除」
  const saved = list.map((c) => {
    const e = decor.pendingAnchorEdits(state).find((x) => x.id === c.id);
    if (!e) return c;
    return { ...c, current: e.text, paragraph: e.paragraph, ...(e.gone ? { gone: true } : {}) };
  });
  const docNow = state.doc.toString() + "\n\n她笑了：有点意思。";
  const byId = new Map(comments.locateAll(docNow, saved).map((x) => [x.comment.id, x]));
  r.check("写回后按现文定位", byId.get(1)?.via === "present");
  r.check(
    "原文已删除：别处出现同样的字也不指过去，只落到删除处的段落",
    byId.get(2)?.via === "paragraph" &&
      !docNow.slice(byId.get(2).from, byId.get(2).to).includes("她笑了"),
    JSON.stringify(byId.get(2))
  );

  // 5) 不是作者输入的改动（外部改文件后重载）：不映射，回到按文字定位
  let state2 = EditorState.create({ doc, extensions: [editorInfoField, ext] });
  const at2 = doc.indexOf("船都歇了");
  state2 = state2.update({ changes: { from: at2, to: at2 + 4, insert: "船早就歇了" } }).state;
  r.check(
    "外部改动不做映射（不会把整篇替换误判成删除）",
    decor.pendingAnchorEdits(state2).length === 0
  );

  // 6) 「原文已删除」往返
  const text = comments.serializeCommentFile(PATH, [{ ...list[1], gone: true }]);
  r.check(
    "「原文已删除」写进文件并能读回",
    text.includes("- 原文已删除：是") && comments.parseCommentFile(text)[0].gone === true
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
