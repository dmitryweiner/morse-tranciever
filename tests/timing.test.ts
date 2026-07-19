import { unitMs, classifyMark, classifyGap } from '../src/morse/timing';

describe('timing', () => {
  it('unitMs follows the PARIS standard', () => {
    expect(unitMs(20)).toBe(60);
    expect(unitMs(12)).toBe(100);
    expect(unitMs(5)).toBe(240);
  });

  it('classifyMark splits dot/dash at 2 units', () => {
    expect(classifyMark(60, 60)).toBe('.');
    expect(classifyMark(119, 60)).toBe('.');
    expect(classifyMark(120, 60)).toBe('-');
    expect(classifyMark(180, 60)).toBe('-');
  });

  it('classifyGap splits at 2 and 5 units', () => {
    expect(classifyGap(60, 60)).toBe('element');
    expect(classifyGap(119, 60)).toBe('element');
    expect(classifyGap(180, 60)).toBe('letter');
    expect(classifyGap(299, 60)).toBe('letter');
    expect(classifyGap(301, 60)).toBe('word');
  });
});
