/**
 * WordCount Service 检查。
 *
 * 验证 Host 的统一计数入口仍沿用现有的 frontmatter / 格式记号剥离与三种
 * 字数模式，同时确认 main.ts 和状态栏不再绕过 Service 直接调用纯函数。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

function main() {
  const { DefaultWordCountService } = H.compile(
    "src/services/wordCountService.ts",
    "word-count-service"
  );
  const service = new DefaultWordCountService();
  const r = H.createReporter("字数统计 WordCount Service");
  const sample = "---\ntitle: 测试\n---\n**粗体** word";

  r.check(
    "webnovel 模式沿用非空白字符计数",
    service.count(sample, "webnovel") === 6,
    String(service.count(sample, "webnovel"))
  );
  r.check(
    "standard 模式沿用汉字 + 字母数字计数",
    service.count(sample, "standard") === 6,
    String(service.count(sample, "standard"))
  );
  r.check(
    "native 模式沿用汉字逐字 + 英文分词",
    service.count(sample, "native") === 3,
    String(service.count(sample, "native"))
  );
  r.check(
    "frontmatter 不计入字数",
    service.count("---\ntitle: 不应计入\n---\n正文", "webnovel") === 2
  );
  r.check(
    "编辑工具条格式记号不计入字数",
    service.count("**粗体**", "webnovel") ===
      service.count("粗体", "webnovel")
  );
  r.check(
    "场景分隔线不被误当成格式记号",
    service.count("* * *", "webnovel") === 3
  );

  const sources = Object.fromEntries(
    [
      "src/main.ts",
      "src/statusbar.ts",
      "src/home.ts",
      "src/workbench.ts",
      "src/snapshot.ts",
      "src/snapshotPanel.ts",
      "src/snapshotDiff.ts",
    ].map((file) => [file, fs.readFileSync(path.join(H.ROOT, file), "utf8")])
  );
  const directCall = /\bgetWordCount\s*\(/;
  r.check(
    "main.ts 的计数入口走 Host Service",
    !directCall.test(sources["src/main.ts"]) &&
      sources["src/main.ts"].includes("services.wordcount.count")
  );
  r.check(
    "状态栏不再直接调用纯计数函数",
    !directCall.test(sources["src/statusbar.ts"]) &&
      (sources["src/statusbar.ts"].match(/\bthis\.wordCount\.count\s*\(/g) ?? [])
        .length >= 7
  );
  r.check(
    "页面与快照模块不再直接调用纯计数函数",
    [
      "src/home.ts",
      "src/workbench.ts",
      "src/snapshot.ts",
      "src/snapshotPanel.ts",
      "src/snapshotDiff.ts",
    ].every((file) => !directCall.test(sources[file]))
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
