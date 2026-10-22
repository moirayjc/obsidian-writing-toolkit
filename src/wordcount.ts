import { stripFrontmatter, stripInlineFormatting } from "./formatWrap";

export type WordCountMode = 'webnovel' | 'standard' | 'native';

const HAN_CHAR = /\p{Script=Han}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const WORD = /[\p{L}\p{N}]+/gu;


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
  // 先剥 frontmatter，再剥行内格式记号（编辑工具条产物）：格式符号不虚增字数
  const body = stripInlineFormatting(stripFrontmatter(text));
  switch (mode) {
    case 'webnovel': return countWebnovel(body);
    case 'standard': return countStandard(body);
    case 'native': return countNative(body);
  }
}
