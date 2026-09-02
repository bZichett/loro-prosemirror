/**
 * Corpus for the change-granularity bench.
 *
 * Shape is taken from a real narrative document in the dev KG
 * (`nd_ppnrr0hw78m`, 45 non-empty `text_block`s, 7,230 characters, block
 * lengths ranging 7 → 345): a mid-size article, the kind a person actually
 * sits down and types. The TEXT is synthesised rather than committed, because
 * the measurement only depends on character count and block boundaries — the
 * op stream is one insert per keystroke regardless of what the character is —
 * and the source document is a real person's writing.
 *
 * `--corpus <file.json>` (a JSON array of strings) overrides this, which is how
 * the numbers were cross-checked against the real article's own text.
 */

/** Block lengths of the reference document, in document order. */
const BLOCK_LENGTHS = [
  24, 7, 58, 174, 246, 21, 295, 137, 88, 345, 27, 199, 262, 41, 156, 310, 72,
  228, 95, 181, 264, 33, 143, 207, 118, 289, 61, 172, 236, 104, 195, 47, 158,
  221, 83, 267, 129, 190, 55, 213, 147, 98, 176, 240, 112,
];

const WORDS = [
  "the",
  "sleep",
  "night",
  "body",
  "mind",
  "rest",
  "again",
  "wake",
  "hours",
  "quiet",
  "breathe",
  "slow",
  "light",
  "morning",
  "tired",
  "still",
  "clock",
  "thought",
  "settle",
  "return",
  "awake",
  "dark",
  "warm",
  "count",
  "drift",
];

/** Deterministic prose of exactly `len` characters, sentence-punctuated. */
function block(len: number, seed: number): string {
  let out = "";
  let n = seed;
  let sinceSentence = 0;
  while (out.length < len) {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    const word = WORDS[n % WORDS.length]!;
    out += (out.length === 0 ? "" : " ") + word;
    sinceSentence += word.length + 1;
    // Sentences of ~12 words, so the sentence-pause model has somewhere to fire.
    if (sinceSentence > 70) {
      out += ".";
      sinceSentence = 0;
    }
  }
  return out.slice(0, len);
}

export function defaultCorpus(): string[] {
  return BLOCK_LENGTHS.map((len, i) => block(len, i + 1));
}
