// 本地复刻 Obsidian 社区插件审查的静态检查（eslint-plugin-obsidianmd recommended，
// 与官方审核后台一致）。用途：release 前自测，提前发现官方会报的问题。
//
// 用法：npm run lint:review（已接进 tools/release.sh 的发布自检）
//
// 说明：
// - eslint-plugin-obsidianmd 在 package.json 里固定版本；升级前先对照官方审查结果。
// - obsidianmd/no-unsupported-api 会读 manifest.json 的 minAppVersion 检查 API 的
//   @since（如显示 "requires Obsidian v1.13.0" 报错，那就是真的不兼容旧版，不是误报）。
//   改 API 前先把 minAppVersion 抬到位，否则这里是 error 不是 warning。
// - 官方审查还包含 CSS lint（styles.css 的部分不支持特性 / !important 统计等），
//   本地 eslint 不覆盖，见 docs/插件设计文档.md §6.6。
//
// ⚠️ 不要用 `eslint --fix` 一把梭：它的自动修复会把 `any` 改成 `unknown`、
//    把类型断言改坏（实测跑完 tsc 直接报错）。要修就逐条改并跑 npm run check。
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "release/**", "_backup/**", "tools/**"] },
  ...obsidianmd.configs.recommendedWithLocalesEn,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
    rules: {
      // 界面文案里的专有名词：规则的大小写表里没有它们，会被要求改成小写。
      // 注意：ignoreRegex 用的是 **JS 正则**，不支持 `(?i)` 内联标志——
      // 写错会让整个 eslint 崩掉（SyntaxError: Invalid group），只能用 ignoreWords。
      "obsidianmd/ui/sentence-case": ["warn", { ignoreWords: ["Agent", "MCP", "Claude", "Code", "Authorization", "Bearer"] }],
    },
  },
]);
