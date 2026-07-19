import { MORSE, decodeCode, isElement, MAX_CODE_LENGTH } from '../src/morse/code';

describe('morse table', () => {
  it('covers exactly A–Z', () => {
    const letters = Object.keys(MORSE).sort();
    expect(letters).toHaveLength(26);
    expect(letters[0]).toBe('A');
    expect(letters[25]).toBe('Z');
  });

  it('codes are unique, non-empty, made of dots/dashes, depth ≤ 4', () => {
    const codes = Object.values(MORSE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code.length).toBeGreaterThan(0);
      expect(code.length).toBeLessThanOrEqual(MAX_CODE_LENGTH);
      for (const el of code) expect(isElement(el)).toBe(true);
    }
  });

  it('decodeCode round-trips every letter and rejects junk', () => {
    for (const [ch, code] of Object.entries(MORSE)) {
      expect(decodeCode(code)).toBe(ch);
    }
    expect(decodeCode('')).toBeNull();
    expect(decodeCode('.-.-')).toBeNull();
    expect(decodeCode('......')).toBeNull();
  });

  it('spot checks: SOS', () => {
    expect(MORSE.S).toBe('...');
    expect(MORSE.O).toBe('---');
  });
});
