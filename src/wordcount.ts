export type WordCountMode = 'webnovel' | 'standard' | 'native';

const HAN_CHAR = /\p{Script=Han}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * 剥离前导 YAML frontmatter：章纲等元数据不应计入正文字数。
 * frontmatter 必须严格位于文件开头（第一行 ---，闭合行也必须是行首 ---）。
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return text; // 没有闭合的 ---：按普通文本处理
}

function isCJK(char: string): boolean {
  return HAN_CHAR.test(char);
}

export function countWebnovel(text: string): number {
  // 番茄式网文统计：所有非空白字符计数，标点也计入。
  return (text.match(/\S/gu) ?? []).length;
}

export function countStandard(text: string): number {
  let count = 0;
  for (const char of text) {
    if (isCJK(char) || LETTER_OR_NUMBER.test(char)) count++;
  }
  return count;
}

export function countNative(text: string): number {
  let cjkCount = 0;
  let nonCJK = "";
  for (const char of text) {
    if (isCJK(char)) {
      cjkCount++;
      nonCJK += " ";
    } else {
      nonCJK += char;
    }
  }
  const wordCount = nonCJK.match(WORD)?.length ?? 0;
  return cjkCount + wordCount;
}

export function getWordCount(text: string, mode: WordCountMode): number {
  const body = stripFrontmatter(text);
  switch (mode) {
    case 'webnovel': return countWebnovel(body);
    case 'standard': return countStandard(body);
    case 'native': return countNative(body);
  }
}
