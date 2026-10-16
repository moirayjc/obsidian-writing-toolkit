// 本地复刻 Obsidian 社区插件审查的静态检查（eslint-plugin-obsidianmd recommended，
// 与官方审核后台一致）。用途：release 前自测，提前发现官方会报的问题。
//
// 用法：npm run lint:review（已接进 tools/release.sh 的发布自检）
//
// 说明：
// - eslint-plugin-obsidianmd 在 package.json 里固定版本；升级前先对照官方审查结果。
// - obsidianmd/no-unsupported-api 会读 manifest.json 的 minAppVersion 检查 API 的
//   @since（如显示 "requires Obsidian v1.13.0" 报错，那就是真的不兼容旧版，不是误报）。
// - 官方审查还包含 CSS lint（styles.css 的部分不支持特性 / !important 统计等），
//   本地 eslint 不覆盖，见 docs/插件设计文档.md §6.6。
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
  },
]);
