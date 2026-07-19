// Morse timing math (PARIS standard): dot = 1 unit, dash = 3, gap inside a
// letter = 1, between letters = 3, between words = 7. Classification uses the
// midpoints (2 and 5 units) so sloppy hand keying still reads correctly.

import type { MorseElement } from './code';

export function unitMs(wpm: number): number {
  return 1200 / wpm;
}

// Marks longer than 2 units are dashes.
export const DASH_UNITS = 2;
// Silence longer than 2 units commits the letter, longer than 5 — a word gap.
export const LETTER_GAP_UNITS = 2;
export const WORD_GAP_UNITS = 5;

export function classifyMark(ms: number, unit: number): MorseElement {
  return ms < DASH_UNITS * unit ? '.' : '-';
}

export type GapKind = 'element' | 'letter' | 'word';

export function classifyGap(ms: number, unit: number): GapKind {
  if (ms < LETTER_GAP_UNITS * unit) return 'element';
  if (ms < WORD_GAP_UNITS * unit) return 'letter';
  return 'word';
}
