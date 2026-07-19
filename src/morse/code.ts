// Morse alphabet (A–Z, ITU) + the binary-tree view of it.
// Pure data/functions — imported by keyer, decoder, UI tree and tests.

export type MorseElement = '.' | '-';

export const MORSE: Readonly<Record<string, string>> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
  G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
};

const CODE_TO_CHAR: ReadonlyMap<string, string> = new Map(
  Object.entries(MORSE).map(([ch, code]) => [code, ch]),
);

// Longest code in the alphabet — the depth of the tree.
export const MAX_CODE_LENGTH = 4;

export function decodeCode(code: string): string | null {
  return CODE_TO_CHAR.get(code) ?? null;
}

export function isElement(s: string): s is MorseElement {
  return s === '.' || s === '-';
}

// Events emitted by both the keyer (TX) and the decoder (RX), so the UI
// renders them identically.
export type MorseEvent =
  | { kind: 'element'; element: MorseElement; code: string }
  | { kind: 'letter'; code: string; char: string | null }
  | { kind: 'word' };
