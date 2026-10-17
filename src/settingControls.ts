/**
 * 设置页里两件 CSS 自己做不了、必须碰一下 DOM 的小事：
 *
 * 1. **滑块的「已选比例」**（`--wt-fill`）——CSS 拿不到 range 的当前值，
 *    `attr()` 也取不到，只能算出来写进 CSS 变量。
 * 2. **给原生 `<select>` 包一层**——实测 Chrome **不会为 `<select>` 生成
 *    `::after` 伪元素**（放开 overflow 也没用），而给它自己加 mask 会把控件
 *    本身弄坏。包一层 wrapper 后，箭头画在 wrapper 上就正常了。
 *
 * 两件都做成幂等的：重复调用不会重复挂监听／重复包裹。
 */

/** 把元素当前值换算成百分比并写入 `--wt-fill`。 */
function syncFill(el: HTMLInputElement): void {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const v = Number(el.value);
  const span = max - min;
  const pct = span > 0 && Number.isFinite(v) ? ((v - min) / span) * 100 : 0;
  el.style.setProperty("--wt-fill", `${Math.max(0, Math.min(100, pct))}%`);
}

/**
 * 给容器里所有没处理过的 range 滑块接上填充同步。
 * 幂等：已处理的元素用 dataset 标记，重复调用不会重复挂监听。
 */
export function setupSliderFills(root: HTMLElement): void {
  const sliders = root.querySelectorAll<HTMLInputElement>(
    '.setting-item-control input[type="range"]'
  );
  sliders.forEach((el) => {
    if (el.dataset.wtSliderFill === "1") return;
    el.dataset.wtSliderFill = "1";
    syncFill(el);
    el.addEventListener("input", () => syncFill(el));
    new MutationObserver(() => syncFill(el)).observe(el, {
      attributes: true,
      attributeFilter: ["value", "min", "max"],
    });
  });
}

/**
 * 给原生 `<select>` 包一层 `<span class="wt-select-wrap">`，让样式层能在
 * wrapper 上画「可展开」箭头。
 *
 * 为什么不用 `::after` 直接加在 select 上：实测 Chrome 根本不为 `<select>`
 * 生成 `::after`（`appearance: none` 之后也一样），放开 `overflow: clip` 也无效。
 *
 * 包裹只在**父节点是 setting-item-control** 时进行：Obsidian 以后若换了结构，
 * 宁可没有箭头，也不要把 select 塞进不该塞的地方。
 */
export function setupSelectArrows(root: HTMLElement): void {
  const selects = root.querySelectorAll<HTMLSelectElement>(
    ".setting-item-control select"
  );
  selects.forEach((el) => {
    if (el.dataset.wtSelectWrapped === "1") return;
    const parent = el.parentElement;
    if (!parent || !parent.classList.contains("setting-item-control")) return;
    el.dataset.wtSelectWrapped = "1";
    const wrap = document.createElement("span");
    wrap.className = "wt-select-wrap";
    parent.insertBefore(wrap, el);
    wrap.appendChild(el);
  });
}
