import { Editor, Modal, Notice, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import { pathBasename } from "./snapshot";
import { getWordCount, WordCountMode } from "./wordcount";
import { isHemingwayActive, setHemingway } from "./hemingway";
import { ConfirmModal } from "./promptModal";

export type DiffKind = "same" | "del" | "add" | "replace";

export interface DiffRow {
  kind: DiffKind;
  /** 左侧（快照）内容 */
  left: string | null;
  /** 右侧（当前）内容 */
  right: string | null;
}

/** 基于 LCS 的行级 diff（a=快照，b=当前）。超大文本回退到朴素逐行对比。 */
export function diffLines(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return naiveDiff(a, b);

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", left: a[i], right: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", left: a[i], right: null });
      i++;
    } else {
      out.push({ kind: "add", left: null, right: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: "del", left: a[i], right: null });
    i++;
  }
  while (j < m) {
    out.push({ kind: "add", left: null, right: b[j] });
    j++;
  }
  return out;
}

function naiveDiff(a: string[], b: string[]): DiffRow[] {
  const len = Math.max(a.length, b.length);
  const out: DiffRow[] = [];
  for (let k = 0; k < len; k++) {
    if (k < a.length && k < b.length) {
      if (a[k] === b[k]) {
        out.push({ kind: "same", left: a[k], right: b[k] });
      } else {
        out.push({ kind: "del", left: a[k], right: null });
        out.push({ kind: "add", left: null, right: b[k] });
      }
    } else if (k < a.length) {
      out.push({ kind: "del", left: a[k], right: null });
    } else {
      out.push({ kind: "add", left: null, right: b[k] });
    }
  }
  return out;
}

/** 把相邻的 del+add 合并成左右对齐的「修改」行，便于对照阅读。 */
function mergeReplacements(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const cur = rows[i];
    const next = rows[i + 1];
    if (cur.kind === "del" && next && next.kind === "add") {
      out.push({ kind: "replace", left: cur.left, right: next.right });
      i += 2;
    } else if (cur.kind === "add" && next && next.kind === "del") {
      out.push({ kind: "replace", left: next.left, right: cur.right });
      i += 2;
    } else {
      out.push(cur);
      i++;
    }
  }
  return out;
}

/** 字符级差异：标记两侧各自需要高亮的字符位置。 */
function charDiff(
  a: string,
  b: string
): { left: boolean[]; right: boolean[] } | null {
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) return null;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const left = new Array<boolean>(n).fill(true);
  const right = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left[i] = false;
      right[j] = false;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { left, right };
}

/** 把字符差异渲染成高亮片段。 */
function renderLineWithMarks(
  el: HTMLElement,
  text: string,
  marks: boolean[] | null
): void {
  el.empty();
  if (!marks || marks.length !== text.length) {
    el.setText(text);
    return;
  }
  let current: HTMLElement | null = null;
  let currentChanged: boolean | null = null;
  for (let k = 0; k < text.length; k++) {
    const changed = marks[k];
    if (current === null || changed !== currentChanged) {
      current = el.createSpan({ cls: changed ? "wt-diff-chg" : undefined });
      currentChanged = changed;
    }
    current.appendText(text[k]);
  }
}

/**
 * 打开「快照 vs 当前」对比弹窗（右侧可直接编辑）。
 * plugin 为 WritingToolkitPlugin：通过其记录的最近活动文件信息工作，
 * 不依赖当前焦点（点击侧栏后 workspace 的活动文件会变成侧栏视图）。
 */
export function showSnapshotDiff(
  plugin: any,
  sourcePath: string,
  snapshotPath: string,
  snapshotName: string,
  onChanged: () => void
): void {
  void (async () => {
    const editor = plugin.getLastEditor();
    if (
      plugin.getLastKnownFilePath() !== sourcePath ||
      !editor ||
      !plugin.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：当前没有可对比的活动文件（文件可能已关闭，请重新打开）");
      return;
    }
    const current = editor.getValue();
    let snapshot = "";
    try {
      snapshot = await plugin.snapshotManager.readSnapshot(snapshotPath);
    } catch (e) {
      new Notice(`写作工具箱：读取快照失败：${String(e)}`);
      return;
    }
    if (
      plugin.getLastKnownFilePath() !== sourcePath ||
      plugin.getLastEditor() !== editor ||
      !plugin.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：活动文件已切换，请重新打开对比");
      return;
    }
    if (editor.getValue() !== current) {
      new Notice("写作工具箱：文档内容已变化，请重新打开对比");
      return;
    }
    new SnapshotDiffModal(
      plugin,
      sourcePath,
      snapshotPath,
      snapshotName,
      current,
      snapshot,
      onChanged
    ).open();
  })();
}

/** 列表行的「恢复」确认弹窗。 */
export function confirmRestore(
  plugin: any,
  sourcePath: string,
  snapshotPath: string,
  snapshotName: string,
  onChanged: () => void
): void {
  const modal = new Modal(plugin.app);
  modal.titleEl.setText("恢复快照");
  modal.contentEl.createEl("p", {
    text: `确定把当前文件内容替换为「${snapshotName}」吗？`,
  });
  modal.contentEl.createEl("p", {
    cls: "wt-diff-hint",
    text: "恢复前会先自动保存当前内容为快照；恢复后可用 Ctrl+Z 撤销。",
  });
  const actions = modal.contentEl.createDiv({ cls: "wt-modal-actions" });
  new Setting(actions)
    .addButton((b) =>
      b.setButtonText("恢复").setCta().onClick(() => {
        void performRestore(plugin, sourcePath, snapshotPath).then((ok) => {
          if (ok) {
            modal.close();
            onChanged();
          }
        });
      })
    )
    .addButton((b) => b.setButtonText("取消").onClick(() => modal.close()));
  modal.open();
}

/** 执行恢复：先备份当前内容，再把快照内容写回编辑器（可撤销）。返回是否成功。 */
export async function performRestore(
  plugin: any,
  sourcePath: string,
  snapshotPath: string
): Promise<boolean> {
  const editor = plugin.getLastEditor();
  if (
    plugin.getLastKnownFilePath() !== sourcePath ||
    !editor ||
    !plugin.isEditorValid(editor)
  ) {
    new Notice("写作工具箱：当前没有可恢复的活动文件（文件可能已关闭，请重新打开）");
    return false;
  }
  try {
    const currentText = editor.getValue();
    await plugin.snapshotManager.snapshotFileSilently(sourcePath, currentText);
    const content = await plugin.snapshotManager.readSnapshot(snapshotPath);
    if (
      plugin.getLastKnownFilePath() !== sourcePath ||
      plugin.getLastEditor() !== editor ||
      !plugin.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：活动文件已切换，请重新执行恢复");
      return false;
    }
    if (editor.getValue() !== currentText) {
      new Notice("写作工具箱：文档内容已变化，请重新执行恢复");
      return false;
    }
    plugin.markProgrammaticEdit?.(editor, content);
    replaceEditorText(editor, content);
    new Notice(`写作工具箱：已恢复为 ${pathBasename(snapshotPath)}（Ctrl+Z 可撤销）`);
    return true;
  } catch (e) {
    new Notice(`写作工具箱：恢复失败：${String(e)}`);
    return false;
  }
}

/** 把内容写回编辑器：先静默备份当前状态，再替换（可撤销）。返回是否成功。 */
async function applyContent(
  plugin: any,
  sourcePath: string,
  content: string
): Promise<boolean> {
  const editor = plugin.getLastEditor();
  if (
    plugin.getLastKnownFilePath() !== sourcePath ||
    !editor ||
    !plugin.isEditorValid(editor)
  ) {
    new Notice("写作工具箱：当前没有可编辑的活动文件（文件可能已关闭，请重新打开）");
    return false;
  }
  const currentText = editor.getValue();
  if (content === currentText) {
    new Notice("写作工具箱：内容没有变化，未应用");
    return false;
  }
  try {
    await plugin.snapshotManager.snapshotFileSilently(sourcePath, currentText);
    if (
      plugin.getLastKnownFilePath() !== sourcePath ||
      plugin.getLastEditor() !== editor ||
      !plugin.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：活动文件已切换，请重新执行应用");
      return false;
    }
    if (editor.getValue() !== currentText) {
      new Notice("写作工具箱：文档内容已变化，请重新执行应用");
      return false;
    }
    plugin.markProgrammaticEdit?.(editor, content);
    replaceEditorText(editor, content);
    new Notice("写作工具箱：已应用到文档（Ctrl+Z 可撤销）");
    return true;
  } catch (e) {
    new Notice(`写作工具箱：应用失败：${String(e)}`);
    return false;
  }
}

function replaceEditorText(editor: Editor, text: string): void {
  // 海明威模式会拦截一切非「末尾追加」的修改，恢复/应用前临时关闭、
  // 写回后再恢复，避免快照恢复功能在海明威模式下静默失效。
  const cm = (editor as any).cm as EditorView | undefined;
  const wasHemingway = cm ? isHemingwayActive(cm) : false;
  if (wasHemingway && cm) {
    cm.dispatch({ effects: setHemingway.of(false) });
  }
  try {
    const end = editor.offsetToPos(editor.getValue().length);
    editor.replaceRange(text, { line: 0, ch: 0 }, end);
  } finally {
    if (wasHemingway && cm) {
      cm.dispatch({ effects: setHemingway.of(true) });
    }
  }
}

class SnapshotDiffModal extends Modal {
  private readonly plugin: any;
  private readonly sourcePath: string;
  private readonly snapshotPath: string;
  private readonly snapshotName: string;
  private readonly snapshot: string;
  private readonly onChanged: () => void;

  private current: string;
  private bodyEl!: HTMLElement;
  private metaEl!: HTMLElement;

  constructor(
    plugin: any,
    sourcePath: string,
    snapshotPath: string,
    snapshotName: string,
    current: string,
    snapshot: string,
    onChanged: () => void
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.snapshotPath = snapshotPath;
    this.snapshotName = snapshotName;
    this.current = current;
    this.snapshot = snapshot;
    this.onChanged = onChanged;
  }

  onOpen(): void {
    const { modalEl, contentEl } = this;
    modalEl.addClass("wt-diff-modal");
    // 弹窗尺寸由 styles.css 的 .wt-diff-modal 控制

    const header = contentEl.createDiv({ cls: "wt-diff-header" });
    header.createDiv({ cls: "wt-diff-title", text: `对比 · ${this.snapshotName}` });

    const actions = contentEl.createDiv({ cls: "wt-diff-actions" });
    actions.appendChild(
      this.actionButton("重新对比", () => this.renderGrid(this.collectCurrentText()))
    );
    actions.appendChild(
      this.actionButton("重置为快照", () => this.renderGrid(this.snapshot))
    );
    actions.appendChild(
      this.actionButton("复制快照", () =>
        void this.plugin.snapshotManager.copySnapshot(this.snapshotPath)
      )
    );
    const applyBtn = this.actionButton("应用到文档", () => this.apply());
    applyBtn.addClass("wt-snap-primary");
    actions.appendChild(applyBtn);
    const restoreBtn = this.actionButton("恢复", () => this.restore());
    restoreBtn.addClass("wt-diff-danger");
    actions.appendChild(restoreBtn);
    actions.appendChild(this.actionButton("关闭", () => this.close()));

    this.metaEl = contentEl.createDiv({ cls: "wt-diff-meta" });

    contentEl.createDiv({
      cls: "wt-diff-hint",
      text: "右侧可直接编辑：改完点「重新对比」更新差异，最后点「应用到文档」写回文件（写回前自动保存当前版本为快照，Ctrl+Z 可撤销）；「恢复」则直接把文档替换为快照内容。",
    });

    const legend = contentEl.createDiv({ cls: "wt-diff-legend" });
    this.legendItem(legend, "is-del", "删除");
    this.legendItem(legend, "is-add", "新增");
    this.legendItem(legend, "is-chg", "修改（高亮为改动部分）");

    this.bodyEl = contentEl.createDiv({ cls: "wt-diff-body" });
    this.renderGrid(this.current);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderGrid(current: string): void {
    this.current = current;
    const rows = mergeReplacements(
      diffLines(this.snapshot.split("\n"), current.split("\n"))
    );
    const mode: WordCountMode = this.plugin.settings.wordCountMode;

    const delCount = rows.filter((r) => r.kind === "del").length;
    const addCount = rows.filter((r) => r.kind === "add").length;
    const repCount = rows.filter((r) => r.kind === "replace").length;
    const snapCount = getWordCount(this.snapshot, mode);
    const curCount = getWordCount(current, mode);
    this.metaEl.setText(
      `快照 ${formatNumber(snapCount)} 字 · 当前 ${formatNumber(curCount)} 字 · 修改 ${repCount} 行 / 删除 ${delCount} 行 / 新增 ${addCount} 行`
    );

    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: "wt-diff-colhead is-left", text: "快照（只读）" });
    this.bodyEl.createDiv({ cls: "wt-diff-colhead is-right", text: "当前（可编辑）" });

    let leftNo = 0;
    let rightNo = 0;
    for (const row of rows) {
      // 左侧
      if (row.left !== null) {
        leftNo++;
        const cell = this.bodyEl.createDiv({ cls: `wt-diff-line is-left ${row.kind}` });
        cell.createSpan({ cls: "wt-diff-lineno", text: String(leftNo) });
        cell.createSpan({
          cls: "wt-diff-marker",
          text: row.kind === "del" ? "−" : row.kind === "replace" ? "~" : "",
        });
        const textEl = cell.createDiv({ cls: "wt-diff-text" });
        if (row.kind === "replace" && row.right !== null) {
          renderLineWithMarks(textEl, row.left, charDiff(row.left, row.right)?.left ?? null);
        } else {
          textEl.setText(row.left);
        }
      } else {
        this.bodyEl.createDiv({ cls: "wt-diff-line is-left is-empty" });
      }

      // 右侧（可编辑）
      if (row.right !== null) {
        rightNo++;
        const cell = this.bodyEl.createDiv({
          cls: `wt-diff-line is-right is-editable ${row.kind}`,
        });
        cell.createSpan({ cls: "wt-diff-lineno", text: String(rightNo) });
        cell.createSpan({
          cls: "wt-diff-marker",
          text: row.kind === "add" ? "+" : row.kind === "replace" ? "~" : "",
        });
        const textEl = cell.createDiv({
          cls: "wt-diff-text",
          attr: { contenteditable: "true" },
        });
        if (row.kind === "replace" && row.left !== null) {
          renderLineWithMarks(
            textEl,
            row.right,
            charDiff(row.left, row.right)?.right ?? null
          );
        } else {
          textEl.setText(row.right);
        }
      } else {
        this.bodyEl.createDiv({ cls: "wt-diff-line is-right is-empty" });
      }
    }
  }

  private collectCurrentText(): string {
    const lines: string[] = [];
    for (const el of Array.from(
      this.bodyEl.querySelectorAll<HTMLElement>(".wt-diff-line.is-right .wt-diff-text")
    )) {
      lines.push(el.innerText);
    }
    return lines.join("\n");
  }

  private apply(): void {
    void applyContent(this.plugin, this.sourcePath, this.collectCurrentText()).then((ok) => {
      if (ok) this.onChanged();
    });
  }

  /** 恢复：把文档直接替换为快照内容（恢复前自动备份当前版本）。 */
  private restore(): void {
    new ConfirmModal(
      this.plugin.app,
      "恢复快照",
      `确定把当前文档内容替换为「${this.snapshotName}」吗？\n恢复前会先自动保存当前内容为快照；恢复后可用 Ctrl+Z 撤销。`,
      "恢复",
      () => {
        void performRestore(this.plugin, this.sourcePath, this.snapshotPath).then((ok) => {
          if (ok) {
            this.onChanged();
            this.close();
          }
        });
      },
      true
    ).open();
  }

  private actionButton(text: string, onClick: () => void): HTMLButtonElement {
    // 全局 createEl()（不自动 append；调用方负责挂载）
    const btn = createEl("button");
    btn.addClass("wt-snap-btn");
    btn.setText(text);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private legendItem(container: HTMLElement, cls: string, label: string): void {
    container.createSpan({ cls: `wt-diff-swatch ${cls}` });
    container.appendText(label);
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}
