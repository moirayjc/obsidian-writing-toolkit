/**
 * 海明威 ⇄ 沉浸联动检查。
 *
 * 约定（2026-10-20 作者确认）：开海明威必进沉浸；关海明威一并退出沉浸；
 * 退出沉浸（侧栏开关或 Esc）一并关海明威；onload 按存盘值分别恢复，不联动。
 *
 * 做法：从 src/main.ts 抽出真实的 switchHemingwayMode / switchImmersiveMode，
 * 配桩跑各条路径；再在源码层确认侧栏入口与 Esc 都走联动方法。
 *
 * 反向验证：删掉 switchImmersiveMode 里关海明威的分支，场景 3 变红；
 * 把 editorOptions 改回直连 setHemingwayMode，源码断言变红。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function loadLink(mainSource) {
  const bodies = [
    "private switchHemingwayMode(on: boolean): void",
    "private switchImmersiveMode(on: boolean): void",
  ].map((sig) => H.extractMethod(mainSource, sig));
  const ts = `export class FocusLink {\n${bodies.join("\n\n")}\n}`;
  const js = H.transpileTs(ts, "focus-link", "WtFocusLink");
  // eslint-disable-next-line no-new-func
  return new Function(js + "\nreturn WtFocusLink;")();
}

function createPlugin(Mod, settings) {
  const p = new Mod.FocusLink();
  Object.assign(p, {
    settings: { ...settings },
    calls: [],
    refreshes: 0,
    setHemingwayMode(on) { this.calls.push("hemingway:" + on); },
    setImmersiveMode(on) { this.calls.push("immersive:" + on); },
    refreshImmersiveControls() { this.refreshes++; },
    locked: false,
    reasserts: 0,
    rejectWhileLocked() {
      if (!this.locked) return false;
      this.reasserts++;
      return true;
    },
  });
  return p;
}

function main() {
  const mainSource = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const Mod = loadLink(mainSource);
  const r = H.createReporter("海明威 ⇄ 沉浸联动");

  let p = createPlugin(Mod, { hemingwayMode: false, immersiveMode: false });
  p.switchHemingwayMode(true);
  r.check(
    "1. 开海明威 → 同时进入沉浸，并刷新控件",
    p.settings.hemingwayMode && p.settings.immersiveMode &&
      p.calls.includes("immersive:true") && p.refreshes === 1
  );

  p = createPlugin(Mod, { hemingwayMode: true, immersiveMode: true });
  p.switchHemingwayMode(false);
  r.check(
    "2. 关海明威 → 一并退出沉浸",
    !p.settings.hemingwayMode && !p.settings.immersiveMode &&
      p.calls.includes("immersive:false")
  );

  p = createPlugin(Mod, { hemingwayMode: true, immersiveMode: true });
  p.switchImmersiveMode(false);
  r.check(
    "3. 退出沉浸 → 一并关闭海明威",
    !p.settings.immersiveMode && !p.settings.hemingwayMode &&
      p.calls.includes("hemingway:false")
  );

  p = createPlugin(Mod, { hemingwayMode: false, immersiveMode: false });
  p.switchImmersiveMode(true);
  r.check(
    "4. 单独开沉浸 → 不带开海明威、不额外刷新",
    p.settings.immersiveMode && !p.settings.hemingwayMode &&
      !p.calls.some((c) => c.startsWith("hemingway")) && p.refreshes === 0
  );

  p = createPlugin(Mod, { hemingwayMode: false, immersiveMode: true });
  p.switchHemingwayMode(true);
  r.check(
    "5. 已在沉浸时开海明威 → 不重复进入沉浸",
    p.settings.hemingwayMode && !p.calls.includes("immersive:true") && p.refreshes === 0
  );

  p = createPlugin(Mod, { hemingwayMode: true, immersiveMode: true });
  p.locked = true;
  p.switchImmersiveMode(false);
  p.switchHemingwayMode(false);
  r.check(
    "8. 番茄钟锁定中：两个开关都被拒绝，并按锁定方式套回",
    p.settings.immersiveMode && p.settings.hemingwayMode &&
      p.calls.length === 0 && p.reasserts === 2
  );

  const escBlock = mainSource.slice(
    mainSource.indexOf('event.key === "Escape" && this.settings.immersiveMode'),
    mainSource.indexOf('event.key === "Escape" && this.settings.immersiveMode') + 300
  );
  const escListener = mainSource.slice(
    mainSource.indexOf('this.eventScope.onDom(document, "keydown"'),
    mainSource.indexOf('event.key === "Escape" && this.settings.immersiveMode')
  );
  r.check(
    "6a. 输入法拼字中按 Esc（取消候选）不退出沉浸",
    /if \(event\.isComposing\) return;/.test(escListener)
  );
  r.check(
    "6. 侧栏入口与 Esc 都走联动方法，锁定中短按 Esc 不退出",
    /!this\.isPomodoroLocked\(\)/.test(
      mainSource.slice(mainSource.indexOf("锁定中短按 Esc 不退出"), mainSource.indexOf("锁定中短按 Esc 不退出") + 200)
    ) &&
      /setImmersiveMode: \(on\) => this\.switchImmersiveMode\(on\)/.test(mainSource) &&
      /setHemingwayMode: \(on\) => this\.switchHemingwayMode\(on\)/.test(mainSource) &&
      /this\.switchImmersiveMode\(false\)/.test(escBlock)
  );
  r.check(
    "7. onload 仍按存盘值直接恢复，不走联动",
    /this\.setHemingwayMode\(this\.settings\.hemingwayMode\);\s*this\.setImmersiveMode\(this\.settings\.immersiveMode\);/.test(mainSource)
  );

  return r.finish();
}

try {
  const ok = main();
  H.cleanup();
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error("运行失败：" + error.stack);
  H.cleanup();
  process.exit(2);
}
