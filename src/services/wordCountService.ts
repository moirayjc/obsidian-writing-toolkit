import {
  getWordCount,
  type WordCountMode,
} from "../wordcount";

/**
 * Host-managed entry point for all text counting.
 *
 * The pure wordcount module remains the single implementation of counting and
 * formatting-strip rules; this service gives feature modules a stable
 * dependency instead of importing that implementation directly.
 */
export interface WordCountService {
  count(text: string, mode: WordCountMode): number;
}

export class DefaultWordCountService implements WordCountService {
  count(text: string, mode: WordCountMode): number {
    return getWordCount(text, mode);
  }
}
