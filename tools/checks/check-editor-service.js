/**
 * Editor Service 检查。
 *
 * 用真实 DefaultEditorService 验证活动编辑器读取、Editor → CodeMirror
 * 适配、文档路径读取、扩展注册和工作区刷新，并检查 main.ts 的调用边界。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

async function main() {
  const editorInfoField = { name: "editorInfoField" };
  const firstEditor = {
    getValue: () => "第一份正文",
    getSelection: () => "第一",
  };
  const secondEditor = {
    getValue: () => "第二份正文",
    getSelection: () => "第二",
  };
  const editorView = {
    state: {
      field(field) {
        return field === editorInfoField
          ? { file: { path: "正文/第1章.md" } }
          : undefined;
      },
    },
  };
  firstEditor.cm = editorView;
  const secondEditorView = {
    state: {
      field() {
        return undefined;
      },
    },
  };
  secondEditor.cm = secondEditorView;
  class MarkdownView {
    constructor(editor) {
      this.editor = editor;
    }
  }
  const firstMarkdown = new MarkdownView(firstEditor);
  const secondMarkdown = new MarkdownView(secondEditor);

  let refreshCount = 0;
  const workspace = {
    activeEditor: { editor: firstEditor },
    iterateAllLeaves(callback) {
      callback({ view: { editor: firstEditor } });
      callback({ view: { editor: secondEditor } });
    },
    getLeavesOfType(type) {
      return type === "markdown"
        ? [{ view: firstMarkdown }, { view: {} }, { view: secondMarkdown }]
        : [];
    },
    updateOptions() {
      refreshCount++;
    },
  };
  const app = { workspace };

  const registered = [];
  const registration = {
    registerEditorExtension(extension) {
      registered.push(extension);
    },
  };

  const restore = H.stubObsidian({ editorInfoField, MarkdownView });
  let DefaultEditorService;
  try {
    ({ DefaultEditorService } = H.compile(
      "src/services/editorService.ts",
      "editor-service"
    ));
  } finally {
    restore();
  }

  const service = new DefaultEditorService(app, registration);
  const r = H.createReporter("Editor Service");

  r.check("读取当前活动编辑器", service.getActiveEditor() === firstEditor);
  r.check("读取当前活动正文", service.getActiveEditorText() === "第一份正文");
  r.check("读取当前活动选区", service.getActiveEditorSelection() === "第一");
  r.check("工作区内的编辑器判定有效", service.isEditorValid(firstEditor));
  r.check(
    "已关闭编辑器判定无效",
    !service.isEditorValid({ getValue: () => "", getSelection: () => "" })
  );
  r.check(
    "Editor → CodeMirror 适配可用",
    service.getViewForEditor(firstEditor) === editorView
  );
  r.check("没有编辑器时返回 undefined", service.getViewForEditor(null) === undefined);
  r.check(
    "按稳定顺序读取所有 Markdown 编辑器视图",
    service.getMarkdownEditorViews().length === 2 &&
      service.getMarkdownEditorViews()[0] === editorView &&
      service.getMarkdownEditorViews()[1] === secondEditorView
  );
  r.check(
    "从 CodeMirror 视图读取文档路径",
    service.getFilePath(editorView) === "正文/第1章.md"
  );
  r.check(
    "从 Editor 直接读取文档路径",
    service.getFilePathForEditor(firstEditor) === "正文/第1章.md"
  );
  r.check("没有视图时路径为 null", service.getFilePath(null) === null);
  r.check("没有 DOM 时找不到编辑器视图", service.findViewFromDom(null) === null);

  const extension = { extension: "test" };
  service.registerExtension(extension);
  r.check(
    "扩展注册委托给插件入口",
    registered.length === 1 && registered[0] === extension
  );

  service.refresh();
  r.check("刷新工作区只调用一次 updateOptions", refreshCount === 1);

  workspace.activeEditor = null;
  r.check("没有活动编辑器时返回 null", service.getActiveEditor() === null);
  r.check("没有活动编辑器时正文为 null", service.getActiveEditorText() === null);
  r.check("没有活动编辑器时选区为空", service.getActiveEditorSelection() === "");

  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const hostSource = fs.readFileSync(
    path.join(H.ROOT, "src/host/pluginHost.ts"),
    "utf8"
  );
  r.check(
    "HostServices 暴露 editor",
    /readonly editor: EditorService;/.test(hostSource)
  );
  r.check(
    "Host 的编辑器扩展注册委托给 Editor Service",
    /registerEditorExtension\(extension: Extension\): void \{[\s\S]*?this\.services\.editor\.registerExtension\(extension\);/.test(
      hostSource
    )
  );
  r.check(
    "main.ts 创建 Editor Service",
    /editor: new DefaultEditorService\(this\.app, this\)/.test(mainSource)
  );
  r.check(
    "main.ts 不再直接读取 workspace.activeEditor",
    !/workspace\.activeEditor/.test(mainSource)
  );
  r.check(
    "main.ts 不再直接调用 workspace.updateOptions",
    !/workspace\.updateOptions/.test(mainSource)
  );
  const directCmAccess = mainSource
    .split("\n")
    .some((line) => /\.cm\b/.test(line) && !/[`"']/.test(line));
  r.check(
    "main.ts 不再直接适配 Editor.cm",
    !/getEditorView/.test(mainSource) && !directCmAccess
  );

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
