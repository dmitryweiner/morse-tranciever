import { MORSE, decodeCode, isElement, MAX_CODE_LENGTH, TREE_DEPTH } from '../src/morse/code';

describe('morse table', () => {
  it('covers A–Z, digits 0–9 and ITU punctuation', () => {
    const keys = Object.keys(MORSE);
    for (let c = 65; c <= 90; c++) expect(keys).toContain(String.fromCharCode(c));
    for (let d = 0; d <= 9; d++) expect(keys).toContain(String(d));
    for (const p of ['.', ',', '?', '/', '=', '+', '-', '@']) expect(keys).toContain(p);
    expect(keys).toHaveLength(26 + 10 + 8);
  });

  it('codes are unique, non-empty, made of dots/dashes, depth ≤ max', () => {
    const codes = Object.values(MORSE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code.length).toBeGreaterThan(0);
      expect(code.length).toBeLessThanOrEqual(MAX_CODE_LENGTH);
      for (const el of code) expect(isElement(el)).toBe(true);
    }
  });

  it('tree depth stays 4 (A–Z card); longer codes exist beyond it', () => {
    expect(TREE_DEPTH).toBe(4);
    expect(MAX_CODE_LENGTH).toBe(6);
    for (let c = 65; c <= 90; c++) {
      expect(MORSE[String.fromCharCode(c)].length).toBeLessThanOrEqual(TREE_DEPTH);
    }
  });

  it('decodeCode round-trips every symbol and rejects junk', () => {
    for (const [ch, code] of Object.entries(MORSE)) {
      expect(decodeCode(code)).toBe(ch);
    }
    expect(decodeCode('')).toBeNull();
    expect(decodeCode('.-.-')).toBeNull();
    expect(decodeCode('......')).toBeNull();
  });

  it('spot checks against ITU-R M.1677', () => {
    expect(MORSE.S).toBe('...');
    expect(MORSE.O).toBe('---');
    expect(MORSE['1']).toBe('.----');
    expect(MORSE['5']).toBe('.....');
    expect(MORSE['0']).toBe('-----');
    expect(MORSE['?']).toBe('..--..');
    expect(MORSE['/']).toBe('-..-.');
    expect(MORSE['+']).toBe('.-.-.');
    expect(MORSE['@']).toBe('.--.-.');
  });
});
