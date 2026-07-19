// Morse alphabet (A–Z, digits, ITU punctuation) + the binary-tree view of it.
// Pure data/functions — imported by keyer, decoder, UI tree and tests.

export type MorseElement = '.' | '-';

export const MORSE: Readonly<Record<string, string>> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
  G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
  '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....',
  '6': '-....', '7': '--...', '8': '---..', '9': '----.', '0': '-----',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.',
  '=': '-...-', '+': '.-.-.', '-': '-....-', '@': '.--.-.',
};

const CODE_TO_CHAR: ReadonlyMap<string, string> = new Map(
  Object.entries(MORSE).map(([ch, code]) => [code, ch]),
);

// Глубина обучающего дерева — только A–Z, как на латунной карточке. Коды
// длиннее (цифры/знаки) подсвечивают путь до этой глубины, дальше символ
// виден только в строке кода.
export const TREE_DEPTH = 4;
// Самый длинный код таблицы (знаки — до 6) — НЕ равен глубине дерева.
export const MAX_CODE_LENGTH = Math.max(...Object.values(MORSE).map((c) => c.length));

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
