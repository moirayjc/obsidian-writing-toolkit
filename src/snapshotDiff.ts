import { Editor, Modal, Notice, Setting, type App } from "obsidian";
import { EditorView } from "@codemirror/view";
import { pathBasename, type SnapshotOperations } from "./snapshot";
import { isHemingwayActive, setHemingway } from "./hemingway";
import { ConfirmModal } from "./promptModal";

export type DiffKind = "same" | "change";

/** Snapshot UI needs this narrow editor surface, not the plugin instance. */
export interface SnapshotDiffHost {
  readonly app: App;
  getEditor(): Editor | null;
  getActiveFilePath(): string | null;
  isEditorValid(editor: Editor): boolean;
  countWords(text: string): number;
  markProgrammaticEdit?(editor: Editor, text: string): void;
}

/** 一个非空行，以及它后面属于同一段的空行。 */
export interface TextUnit {
  body: string;
  lineNo: number;
  tailLines: string[];
  unitIndex: number;
}

export interface TextStructure {
  leadingLines: string[];
  units: TextUnit[];
}

/**
 * 一次连续改写。左右各自保留整段原文，不再把无关段落强行配成「修改」。
 */
export interface DiffBlock {
  kind: DiffKind;
  left: TextUnit[];
  right: TextUnit[];
}

const MAX_DIFF_CELLS = 4_000_000;

function isBlankLine(line: string): boolean {
  return line.trim() === "";
}

/**
 * 空行只作为段落间隔保存，不参与对齐。
 * 真实数据里两版可能句句都改过，但空行处处相同；把空行当 LCS 锚点会让
 * 所有正文段落按位置硬配对，正是旧版「右边全空 / 后半段乱配」的来源。
 */
export function parseTextStructure(text: string): TextStructure {
  const lines = text.split("\n");
  const leadingLines: string[] = [];
  let i = 0;
  while (i < lines.length && isBlankLine(lines[i])) {
    leadingLines.push(lines[i]);
    i++;
  }

  const units: TextUnit[] = [];
  while (i < lines.length) {
    const body = lines[i];
    const lineNo = i + 1;
    i++;
    const tailLines: string[] = [];
    while (i < lines.length && isBlankLine(lines[i])) {
      tailLines.push(lines[i]);
      i++;
    }
    units.push({
      body,
      lineNo,
      tailLines,
      unitIndex: units.length,
    });
  }
  return { leadingLines, units };
}

function unitKey(unit: TextUnit): string {
  // 行尾空格不算正文变化；行首缩进仍保留（代码块、列表等依赖它）。
  return unit.body.trimEnd();
}

function sameBlock(left: TextUnit, right: TextUnit): DiffBlock {
  return { kind: "same", left: [left], right: [right] };
}

/**
 * 先对齐完全相同的非空行，再把每个连续改动区作为一个整体。
 *
 * 关键约束：改动区内部不再按位置逐行配对。旧稿 40 段、新稿 13 段时，
 * 整块左右并列显示即可；强行两两合并只会制造虚假的「修改」。
 */
function diffUnits(a: TextUnit[], b: TextUnit[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let start = 0;
  while (
    start < a.length &&
    start < b.length &&
    unitKey(a[start]) === unitKey(b[start])
  ) {
    blocks.push(sameBlock(a[start], b[start]));
    start++;
  }

  let endA = a.length;
  let endB = b.length;
  while (
    endA > start &&
    endB > start &&
    unitKey(a[endA - 1]) === unitKey(b[endB - 1])
  ) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > 0 || midB.length > 0) {
    if (midA.length * midB.length > MAX_DIFF_CELLS) {
      blocks.push({ kind: "change", left: midA, right: midB });
    } else {
      const n = midA.length;
      const m = midB.length;
      const dp: Uint32Array[] = Array.from(
        { length: n + 1 },
        () => new Uint32Array(m + 1)
      );
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] =
            unitKey(midA[i]) === unitKey(midB[j])
              ? dp[i + 1][j + 1] + 1
              : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }

      let i = 0;
      let j = 0;
      let changeLeft: TextUnit[] = [];
      let changeRight: TextUnit[] = [];
      const flushChange = () => {
        if (changeLeft.length === 0 && changeRight.length === 0) return;
        blocks.push({ kind: "change", left: changeLeft, right: changeRight });
        changeLeft = [];
        changeRight = [];
      };
      while (i < n && j < m) {
        if (unitKey(midA[i]) === unitKey(midB[j])) {
          flushChange();
          blocks.push(sameBlock(midA[i], midB[j]));
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          changeLeft.push(midA[i]);
          i++;
        } else {
          changeRight.push(midB[j]);
          j++;
        }
      }
      while (i < n) changeLeft.push(midA[i++]);
      while (j < m) changeRight.push(midB[j++]);
      flushChange();
    }
  }

  for (let k = 0; endA + k < a.length; k++) {
    blocks.push(sameBlock(a[endA + k], b[endB + k]));
  }
  return blocks;
}

/** 供界面和检查脚本共用的入口：空行不参与 diff。 */
export function diffSnapshotBlocks(
  snapshotText: string,
  currentText: string
): DiffBlock[] {
  return diffUnits(
    parseTextStructure(snapshotText).units,
    parseTextStructure(currentText).units
  );
}

/** 把右侧编辑后的正文行重新拼回完整 Markdown，保留空行与末尾换行。 */
export function composeEditedText(
  structure: TextStructure,
  bodies: ReadonlyMap<number, string>
): string {
  const lines = [...structure.leadingLines];
  for (const unit of structure.units) {
    const body = bodies.get(unit.unitIndex) ?? unit.body;
    lines.push(...body.split("\n"));
    lines.push(...unit.tailLines);
  }
  return lines.join("\n");
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
 * host 是快照模块的窄编辑器端口：通过最近活动文件信息工作，
 * 不依赖当前焦点（点击侧栏后 workspace 的活动文件会变成侧栏视图）。
 */
export function showSnapshotDiff(
  host: SnapshotDiffHost,
  operations: SnapshotOperations,
  sourcePath: string,
  snapshotPath: string,
  snapshotName: string,
  onChanged: () => void
): void {
  void (async () => {
    const editor = host.getEditor();
    if (
      host.getActiveFilePath() !== sourcePath ||
      !editor ||
      !host.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：当前没有可对比的活动文件（文件可能已关闭，请重新打开）");
      return;
    }
    const current = editor.getValue();
    let snapshot = "";
    try {
      snapshot = await operations.readSnapshot(snapshotPath);
    } catch (e) {
      new Notice(`写作工具箱：读取快照失败：${String(e)}`);
      return;
    }
    if (
      host.getActiveFilePath() !== sourcePath ||
      host.getEditor() !== editor ||
      !host.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：活动文件已切换，请重新打开对比");
      return;
    }
    if (editor.getValue() !== current) {
      new Notice("写作工具箱：文档内容已变化，请重新打开对比");
      return;
    }
    new SnapshotDiffModal(
      host,
      operations,
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
  host: SnapshotDiffHost,
  operations: SnapshotOperations,
  sourcePath: string,
  snapshotPath: string,
  snapshotName: string,
  onChanged: () => void
): void {
  const modal = new Modal(host.app);
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
        void performRestore(host, operations, sourcePath, snapshotPath).then((ok) => {
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
  host: SnapshotDiffHost,
  operations: SnapshotOperations,
  sourcePath: string,
  snapshotPath: string
): Promise<boolean> {
  const editor = host.getEditor();
  if (
    host.getActiveFilePath() !== sourcePath ||
    !editor ||
    !host.isEditorValid(editor)
  ) {
    new Notice("写作工具箱：当前没有可恢复的活动文件（文件可能已关闭，请重新打开）");
    return false;
  }
  try {
    const currentText = editor.getValue();
    await operations.snapshotFileSilently(sourcePath, currentText);
    const content = await operations.readSnapshot(snapshotPath);
    if (
      host.getActiveFilePath() !== sourcePath ||
      host.getEditor() !== editor ||
      !host.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：活动文件已切换，请重新执行恢复");
      return false;
    }
    if (editor.getValue() !== currentText) {
      new Notice("写作工具箱：文档内容已变化，请重新执行恢复");
      return false;
    }
    host.markProgrammaticEdit?.(editor, content);
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
  host: SnapshotDiffHost,
  operations: SnapshotOperations,
  sourcePath: string,
  content: string
): Promise<boolean> {
  const editor = host.getEditor();
  if (
    host.getActiveFilePath() !== sourcePath ||
    !editor ||
    !host.isEditorValid(editor)
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
    await operations.snapshotFileSilently(sourcePath, currentText);
    if (
      host.getActiveFilePath() !== sourcePath ||
      host.getEditor() !== editor ||
      !host.isEditorValid(editor)
    ) {
      new Notice("写作工具箱：活动文件已切换，请重新执行应用");
      return false;
    }
    if (editor.getValue() !== currentText) {
      new Notice("写作工具箱：文档内容已变化，请重新执行应用");
      return false;
    }
    host.markProgrammaticEdit?.(editor, content);
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
  private readonly host: SnapshotDiffHost;
  private readonly operations: SnapshotOperations;
  private readonly sourcePath: string;
  private readonly snapshotPath: string;
  private readonly snapshotName: string;
  private readonly snapshot: string;
  private readonly snapshotStructure: TextStructure;
  private readonly onChanged: () => void;

  private current: string;
  private rightStructure!: TextStructure;
  private bodyEl!: HTMLElement;
  private metaEl!: HTMLElement;

  constructor(
    host: SnapshotDiffHost,
    operations: SnapshotOperations,
    sourcePath: string,
    snapshotPath: string,
    snapshotName: string,
    current: string,
    snapshot: string,
    onChanged: () => void
  ) {
    super(host.app);
    this.host = host;
    this.operations = operations;
    this.sourcePath = sourcePath;
    this.snapshotPath = snapshotPath;
    this.snapshotName = snapshotName;
    this.current = current;
    this.snapshot = snapshot;
    this.snapshotStructure = parseTextStructure(snapshot);
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
        void this.operations.copySnapshot(this.snapshotPath)
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
      text: "左右按连续改动块对照，不相关段落不会硬配成一行。右侧可直接编辑：改完点「重新对比」更新差异，最后点「应用到文档」写回文件（写回前自动保存当前版本为快照，Ctrl+Z 可撤销）；「恢复」则直接把文档替换为快照内容。",
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
    this.rightStructure = parseTextStructure(current);
    const blocks = diffUnits(this.snapshotStructure.units, this.rightStructure.units);

    const changes = blocks.filter((block) => block.kind === "change");
    const oldChanged = changes.reduce((sum, block) => sum + block.left.length, 0);
    const newChanged = changes.reduce((sum, block) => sum + block.right.length, 0);
    const snapCount = this.host.countWords(this.snapshot);
    const curCount = this.host.countWords(current);
    this.metaEl.setText(
      `快照 ${formatNumber(snapCount)} 字 · 当前 ${formatNumber(curCount)} 字 · ` +
        (changes.length === 0
          ? "内容一致"
          : `改动 ${changes.length} 处（旧 ${oldChanged} 段 / 新 ${newChanged} 段）`)
    );

    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: "wt-diff-colhead is-left", text: "快照（只读）" });
    this.bodyEl.createDiv({ cls: "wt-diff-colhead is-right", text: "当前（可编辑）" });

    if (blocks.length === 0) {
      this.bodyEl.createDiv({ cls: "wt-diff-block is-left is-empty" });
      this.bodyEl.createDiv({ cls: "wt-diff-block is-right is-empty" });
      return;
    }

    for (const block of blocks) {
      const mixed = block.left.length > 0 && block.right.length > 0;
      const blockKind =
        block.kind === "same"
          ? "same"
          : mixed
            ? "replace"
            : block.left.length > 0
              ? "del"
              : "add";
      const leftMark =
        block.kind === "change" ? (block.right.length > 0 ? "~" : "−") : "";
      const rightMark =
        block.kind === "change" ? (block.left.length > 0 ? "~" : "+") : "";

      let leftMarks: boolean[] | null = null;
      let rightMarks: boolean[] | null = null;
      if (
        block.kind === "change" &&
        block.left.length === 1 &&
        block.right.length === 1
      ) {
        const marks = charDiff(block.left[0].body, block.right[0].body);
        leftMarks = marks?.left ?? null;
        rightMarks = marks?.right ?? null;
      }

      const leftPane = this.bodyEl.createDiv({
        cls: `wt-diff-block is-left ${blockKind}${
          block.left.length === 0 ? " is-empty" : ""
        }`,
      });
      this.renderUnits(
        leftPane,
        block.left,
        "left",
        blockKind,
        leftMark,
        leftMarks ? [leftMarks] : null
      );

      const rightPane = this.bodyEl.createDiv({
        cls: `wt-diff-block is-right ${blockKind}${
          block.right.length === 0 ? " is-empty" : ""
        }`,
      });
      this.renderUnits(
        rightPane,
        block.right,
        "right",
        blockKind,
        rightMark,
        rightMarks ? [rightMarks] : null
      );
    }
  }

  private collectCurrentText(): string {
    const bodies = new Map<number, string>();
    for (const el of Array.from(
      this.bodyEl.querySelectorAll<HTMLElement>(
        ".wt-diff-line.is-right .wt-diff-text[data-unit-index]"
      )
    )) {
      bodies.set(Number(el.dataset.unitIndex), el.innerText);
    }
    return composeEditedText(this.rightStructure, bodies);
  }

  private renderUnits(
    pane: HTMLElement,
    units: TextUnit[],
    side: "left" | "right",
    kind: string,
    marker: string,
    marksByUnit: Array<boolean[] | null> | null
  ): void {
    for (let k = 0; k < units.length; k++) {
      const unit = units[k];
      const editable = side === "right";
      const cell = pane.createDiv({
        cls: `wt-diff-line is-${side} ${kind}${editable ? " is-editable" : ""}`,
      });
      cell.createSpan({ cls: "wt-diff-lineno", text: String(unit.lineNo) });
      cell.createSpan({ cls: "wt-diff-marker", text: marker });
      const textEl = cell.createDiv({
        cls: "wt-diff-text",
        attr: editable
          ? {
              contenteditable: "true",
              "data-unit-index": String(unit.unitIndex),
            }
          : undefined,
      });
      renderLineWithMarks(textEl, unit.body, marksByUnit?.[k] ?? null);

      // 空行属于段落结构：不参与 diff，但在两侧保留同样的阅读间距。
      for (let i = 0; i < unit.tailLines.length; i++) {
        pane.createDiv({ cls: "wt-diff-blank" });
      }
    }
  }

  private apply(): void {
    void applyContent(
      this.host,
      this.operations,
      this.sourcePath,
      this.collectCurrentText()
    ).then((ok) => {
      if (ok) this.onChanged();
    });
  }

  /** 恢复：把文档直接替换为快照内容（恢复前自动备份当前版本）。 */
  private restore(): void {
    new ConfirmModal(
      this.host.app,
      "恢复快照",
      `确定把当前文档内容替换为「${this.snapshotName}」吗？\n恢复前会先自动保存当前内容为快照；恢复后可用 Ctrl+Z 撤销。`,
      "恢复",
      () => {
        void performRestore(
          this.host,
          this.operations,
          this.sourcePath,
          this.snapshotPath
        ).then((ok) => {
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
