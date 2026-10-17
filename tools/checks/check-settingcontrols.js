/**
 * 检查：设置页的两个小控件增强（滑块填充 / 下拉箭头）。
 *
 * 为什么是「行为级」而不是源码正则：这两件事的难点在**分支与幂等**
 * （父节点不对就不该包、重复调用不该重复包、程序化改值也要同步），
 * 正则数不出来。所以用最小 DOM 桩把真实实现跑起来。
 *
 * 同时守 CSS 侧三个**实测踩出来的**约束：
 * 1. 滑块的填充靠 `background-image` 渐变，**任何 `background:` 简写都会把它清掉**
 *    （简写会把没写的子属性重置为初始值）。
 * 2. 原生 `<select>` 上不能用 `::after`（Chrome 不生成），必须靠 wrapper。
 * 3. 包了 wrapper 之后，字段框那几条选择器要跟着带上 `.wt-select-wrap select`，
 *    否则 select 会掉回浏览器默认样式（外层的 `>` 直系选择器不再匹配）。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

/** 造一个用到的最小 DOM 桩（只实现这两段实现真正调用的方法）。 */
function makeDom() {
  const created = [];

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this._classes = new Set();
      this._attrs = {};
      this.style = {
        _vars: {},
        setProperty(k, v) { this._vars[k] = v; },
      };
      this.listeners = {};
      this.observers = [];
      this.classList = {
        contains: (c) => this._classes.has(c),
        add: (c) => this._classes.add(c),
        remove: (c) => this._classes.delete(c),
      };
    }
    get className() { return [...this._classes].join(" "); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    addClass(c) { this._classes.add(c); }
    get value() { return this._attrs.value ?? ""; }
    set value(v) { this._attrs.value = String(v); }
    get min() { return this._attrs.min ?? ""; }
    set min(v) { this._attrs.min = String(v); }
    get max() { return this._attrs.max ?? ""; }
    set max(v) { this._attrs.max = String(v); }
    getAttribute(name) { return this._attrs[name] ?? null; }
    setAttribute(name, value) { this._attrs[name] = String(value); }
    appendChild(child) {
      if (child.parentElement) {
        const i = child.parentElement.children.indexOf(child);
        if (i >= 0) child.parentElement.children.splice(i, 1);
      }
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i >= 0) this.children.splice(i, 0, node);
      else this.children.push(node);
      node.parentElement = this;
      return node;
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    /** 测试用：手动触发一次事件 */
    fire(type) { (this.listeners[type] || []).forEach((f) => f()); }
    /** 测试用：模拟 Obsidian 的 setValue —— 只改属性，不派发事件 */
    setValueSilently(v) { this._attrs.value = String(v); }
  }

  const make = (tag, cls) => {
    const el = new El(tag);
    if (cls) el.className = cls;
    created.push(el);
    return el;
  };

  /**
   * 极简选择器匹配：支持 `tag`、`.cls`、`tag.cls`、`tag.a.b`，
   * 以及**空格分隔的后代组合符**（`.a b`）。
   *
   * 两个坑都是本检查第一版踩出来的：
   * 1. `tag` 后面那段必须是 `*` 而不是 `+`，否则纯标签选择器（如 `select`）匹配不上；
   * 2. 必须处理后代组合符——实现里用的就是 `.setting-item-control select`，
   *    按整串当单个选择器解析会永远匹配不到。
   */
  function simpleMatch(el, sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)$/i.exec(sel);
    if (!m) return false;
    const [, tag, clsPart] = m;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    const classes = clsPart ? clsPart.split(".").filter(Boolean) : [];
    return classes.every((c) => el._classes.has(c));
  }

  function matches(el, sel) {
    const parts = sel.trim().split(/\s+/);
    if (!simpleMatch(el, parts[parts.length - 1])) return false;
    // 前面的部分要依次在祖先里找到（从近到远）
    let node = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      let hit = null;
      while (node) {
        if (simpleMatch(node, parts[i])) { hit = node; break; }
        node = node.parentElement;
      }
      if (!hit) return false;
      node = hit.parentElement;
    }
    return true;
  }

  function walk(root, sel, out = []) {
    for (const c of root.children) {
      if (matches(c, sel)) out.push(c);
      walk(c, sel, out);
    }
    return out;
  }

  return {
    created,
    make,
    document: {
      createElement: (tag) => make(tag),
      querySelectorAll: (sel) => [],
    },
    /** 给一个根元素挂上 querySelectorAll */
    arm(root) {
      root.querySelectorAll = (sel) => walk(root, sel);
      return root;
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe(el) { el.observers.push(this); }
      /** 测试用：模拟属性变化 */
      trigger() { this.cb(); }
    },
  };
}

function main() {
  const r = H.createReporter("设置页控件增强（滑块填充 / 下拉箭头）");

  const js = H.transpileTs(
    fs.readFileSync(path.join(H.ROOT, "src/settingControls.ts"), "utf8"),
    "settingControls",
    "SC"
  );

  const dom = makeDom();
  const sandbox = {
    document: dom.document,
    MutationObserver: dom.MutationObserver,
  };
  const factory = new Function(
    "document", "MutationObserver", js + "; return SC;"
  );
  const SC = factory(sandbox.document, sandbox.MutationObserver);
  r.check("settingControls.ts 能编译并导出两个函数",
    typeof SC.setupSliderFills === "function" &&
    typeof SC.setupSelectArrows === "function");

  // ── 滑块填充 ────────────────────────────────────────────────
  {
    const root = dom.arm(dom.make("div", "wt-settings-page"));
    const control = dom.make("div", "setting-item-control");
    const range = dom.make("input");
    range.className = "x";
    range.setAttribute = () => {};
    root.appendChild(control);
    control.appendChild(range);
    // 让选择器 `input[type=range]` 命中：我们的 matches 只认 tag.class，
    // 所以直接给 querySelectorAll 打桩按真实选择器返回。
    root.querySelectorAll = (sel) =>
      sel.includes('type="range"') ? [range] : [];

    range.min = 5; range.max = 120; range.value = 25;
    SC.setupSliderFills(root);
    r.check("滑块：初值 25 落在 [5,120] → --wt-fill ≈ 17.4%",
      Math.abs(parseFloat(range.style._vars["--wt-fill"]) - 17.39) < 0.1,
      "实得 " + range.style._vars["--wt-fill"]);


    range.value = 120; range.fire("input");
    r.check("滑块：拉到最大值 → --wt-fill 100%",
      range.style._vars["--wt-fill"] === "100%",
      "实得 " + range.style._vars["--wt-fill"]);

    // Obsidian 的 setValue() 只改属性、不派发 input → 必须靠 MutationObserver
    range.setValueSilently(62);
    range.observers.forEach((o) => o.trigger());
    r.check("滑块：程序化改值（不派发 input）也能同步 → 约 49.6%",
      Math.abs(parseFloat(range.style._vars["--wt-fill"]) - 49.56) < 0.1,
      "实得 " + range.style._vars["--wt-fill"]);

    const before = range.listeners["input"].length;
    SC.setupSliderFills(root);
    r.check("滑块：重复调用是幂等的（不会重复挂监听）",
      range.listeners["input"].length === before);

    // min 与 max 相等时不能出现 NaN / Infinity
    const r2 = dom.make("input");
    r2.min = 10; r2.max = 10; r2.value = 10;
    root.querySelectorAll = (sel) => (sel.includes('type="range"') ? [r2] : []);
    SC.setupSliderFills(root);
    r.check("滑块：min == max 时不产生 NaN",
      !/NaN|Infinity/.test(String(r2.style._vars["--wt-fill"])),
      "实得 " + r2.style._vars["--wt-fill"]);
  }

  // ── 下拉箭头：包 wrapper ───────────────────────────────────
  {
    const root = dom.arm(dom.make("div", "wt-settings-page"));
    const control = dom.make("div", "setting-item-control");
    const select = dom.make("select");
    root.appendChild(control);
    control.appendChild(select);

    SC.setupSelectArrows(root);
    r.check("select：父节点是 setting-item-control → 被包进 .wt-select-wrap",
      control.children.length === 1 &&
      control.children[0]._classes.has("wt-select-wrap") &&
      control.children[0].children[0] === select,
      "children=" + control.children.map((c) => c.className).join(","));
    r.check("select：控制区带上稳定的 wt-select-control 宽度类",
      control.classList.contains("wt-select-control"));
    r.check("select：位置正确（wrapper 取代了 select 原来的位置）",
      select.parentElement === control.children[0]);

    const snap = JSON.stringify(control.children.map((c) => c.className));
    SC.setupSelectArrows(root);
    r.check("select：重复调用是幂等的（不会套第二层 wrapper）",
      JSON.stringify(control.children.map((c) => c.className)) === snap,
      "实得 " + JSON.stringify(control.children.map((c) => c.className)));

    // Obsidian 1.14 会为下拉额外生成一个隐藏的测量副本
    // （.dropdown.is-measuring + aria-hidden）。它不能被包，否则会参与布局。
    const measureByClass = dom.make("select", "dropdown is-measuring");
    const measureByAria = dom.make("select", "dropdown");
    measureByAria.setAttribute("aria-hidden", "true");
    control.appendChild(measureByClass);
    control.appendChild(measureByAria);
    SC.setupSelectArrows(root);
    r.check("select：Obsidian 的隐藏测量副本不会被包进 wrapper",
      measureByClass.parentElement === control &&
      measureByAria.parentElement === control &&
      !measureByClass.dataset.wtSelectWrapped &&
      !measureByAria.dataset.wtSelectWrapped);

    // 父节点不是 setting-item-control → 不该包（Obsidian 换结构时宁可没有箭头）
    const root2 = dom.arm(dom.make("div"));
    const stray = dom.make("div", "somewhere-else");
    const sel2 = dom.make("select");
    root2.appendChild(stray);
    stray.appendChild(sel2);
    SC.setupSelectArrows(root2);
    r.check("select：父节点不是 setting-item-control → 不包裹（守卫生效）",
      sel2.parentElement === stray && sel2.dataset.wtSelectWrapped === undefined);
  }

  // ── CSS 侧约束 ─────────────────────────────────────────────
  const css = fs.readFileSync(path.join(H.ROOT, "styles.css"), "utf8");
  const rangeBlock = /\.wt-settings-page \.setting-item-control input\[type="range"\] \{([^}]*)\}/
    .exec(css);
  r.check("CSS：range 规则存在", !!rangeBlock);
  if (rangeBlock) {
    r.check(
      "CSS：range 用 background-image 而不是 background 简写（简写会清掉填充渐变）",
      /background-image:\s*none/.test(rangeBlock[1]) && !/(^|[\s;])background\s*:/.test(rangeBlock[1])
    );
    r.check(
      "CSS：range 清掉 Obsidian 1.14 自带的灰胶囊底（只清 background-color，不用简写）",
      /background-color:\s*transparent/.test(rangeBlock[1])
    );
  }
  r.check(
    "CSS：轨道用渐变画出已选填充（读 --wt-fill）",
    /::-webkit-slider-runnable-track \{[\s\S]{0,600}?var\(--wt-fill/.test(css)
  );
  r.check(
    "CSS：thumb 是主题纸色胶囊（不是白球，也不叠灰底）",
    /::-webkit-slider-thumb \{[\s\S]{0,500}?background:\s*var\(--wt-card-bg\)/.test(css) &&
      /::-webkit-slider-thumb \{[\s\S]{0,500}?border-radius:\s*var\(--wt-radius-pill\)/.test(css)
  );
  r.check(
    "CSS：thumb 归零原生 top（保证把手垂直居中于轨道）",
    /::-webkit-slider-thumb \{[\s\S]{0,500}?top:\s*0;/.test(css)
  );
  r.check(
    "CSS：wrapper 上有箭头，且原生 select 上**没有** ::after（Chrome 不生成）",
    /\.wt-select-wrap::after/.test(css) &&
    !/\.setting-item-control select::after/.test(css)
  );
  r.check(
    "CSS：包 wrapper 后字段框规则带上了 .wt-select-wrap select（否则 select 掉回默认样式）",
    /\.setting-item-control \.wt-select-wrap select,/.test(css)
  );
  r.check(
    "CSS：Obsidian 的隐藏测量 select 脱离布局流（否则切标签页后仍会挤掉文字）",
    /select\.is-measuring[\s\S]{0,260}?position:\s*absolute/.test(css) &&
    /select\[aria-hidden="true"\][\s\S]{0,120}?position:\s*absolute/.test(css)
  );
  r.check(
    "CSS：下拉控制区有可收缩的 260px 基准宽度（避免百分比 max-width 循环塌缩）",
    /\.setting-item-control\.wt-select-control\s*\{[^}]*flex:\s*0 1 260px;[^}]*width:\s*260px;/s
      .test(css)
  );
  r.check(
    "CSS：设置弹窗本身被加宽，而不是误写在不存在的 .modal.vertical-tab-content 节点上",
    /\.modal\.mod-settings:has\(\.wt-settings-page\)\s*\{[^}]*--dialog-width:\s*min\(820px,\s*94vw\)/s
      .test(css)
  );
  r.check(
    "CSS：设置页允许随窄窗口收缩（width: 100%; min-width: 0）",
    /\.wt-settings-page\.vertical-tab-content\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s
      .test(css)
  );

  // ── 接线 ──────────────────────────────────────────────────
  const setSrc = fs.readFileSync(path.join(H.ROOT, "src/settings.ts"), "utf8");
  r.check("settings.ts 从 ./settingControls 导入并调用两个装置",
    /from "\.\/settingControls"/.test(setSrc) &&
    /setupSliderFills\(containerEl\)/.test(setSrc) &&
    /setupSelectArrows\(containerEl\)/.test(setSrc));

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
