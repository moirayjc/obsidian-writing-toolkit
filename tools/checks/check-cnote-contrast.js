/**
 * 检查：正文里批注实心序号（.wt-cnote.is-pending）的字色与底色对比度。
 *
 * 底色是 --cmp-mark-line、字色是 --cmp-mark-ink，每套配色主题各配一对（styles.css 的 body.* 块）。
 * 1.0.6 起高对比度两档配错：浅色墨底墨字（1.2:1）、深色浅灰底白字（1.3:1），序号看不清。
 * 这里把每个同时声明了两者、且都是 #rrggbb 的块挑出来，要求 ≥ 4.5:1（WCAG AA 正文字）。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function luminance(hex) {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const r = H.createReporter("批注实心序号对比度（各配色主题）");
const css = fs.readFileSync(path.join(H.ROOT, "styles.css"), "utf8");
const BLOCK = /(^|\n)(body[^{\n]*)\{([^}]*)\}/g;
let pairs = 0;
for (const m of css.matchAll(BLOCK)) {
  const line = /--cmp-mark-line:\s*#([0-9a-f]{6})\b/i.exec(m[3]);
  const ink = /--cmp-mark-ink:\s*#([0-9a-f]{6})\b/i.exec(m[3]);
  if (!line || !ink) continue;
  pairs++;
  const value = ratio(line[1], ink[1]);
  r.check(`${m[2].trim()}：${value.toFixed(1)}:1 ≥ 4.5`, value >= 4.5, `#${line[1]} 底 / #${ink[1]} 字`);
}
r.check("找到全部 6 套主题的序号配色", pairs === 6, `实际 ${pairs}`);
process.exit(r.finish() ? 0 : 1);
