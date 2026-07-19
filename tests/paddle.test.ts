import { PaddleKeyer } from '../src/morse/paddle';
import type { MorseEvent } from '../src/morse/code';

const UNIT = 60;

// Гоняет tick с шагом 5 мс до отметки t, собирая события.
function runTo(p: PaddleKeyer, from: number, to: number, events: MorseEvent[]): number {
  for (let t = from; t <= to; t += 5) events.push(...p.tick(t));
  return to;
}

function render(events: MorseEvent[]): string {
  let out = '';
  for (const e of events) {
    if (e.kind === 'letter') out += e.char ?? '?';
    if (e.kind === 'word') out += ' ';
  }
  return out.trimEnd();
}

describe('PaddleKeyer', () => {
  it('a tap on the dot paddle makes exactly one dot (E)', () => {
    const p = new PaddleKeyer(() => UNIT);
    const events: MorseEvent[] = [];
    events.push(...p.press('.', 0));
    p.release('.');
    runTo(p, 5, 1000, events);
    expect(render(events)).toBe('E');
    const marks = events.filter((e) => e.kind === 'element');
    expect(marks).toHaveLength(1);
    expect(marks[0].element).toBe('.');
  });

  it('holding the dash paddle streams dashes with proper gaps (O)', () => {
    const p = new PaddleKeyer(() => UNIT);
    const events: MorseEvent[] = [];
    events.push(...p.press('-', 0));
    // 3 тире: 180+60+180+60+180 = 660 мс; отпустить в середине третьего.
    runTo(p, 5, 500, events);
    p.release('-');
    runTo(p, 505, 2000, events);
    expect(render(events)).toBe('O');
  });

  it('tone flag follows element/gap boundaries', () => {
    const p = new PaddleKeyer(() => UNIT);
    p.press('.', 0);
    expect(p.isToneOn).toBe(true);
    p.tick(UNIT + 1); // точка кончилась
    expect(p.isToneOn).toBe(false);
    p.release('.');
    p.tick(2 * UNIT + 2); // пауза прошла, но кнопка уже отпущена — тишина
    expect(p.isToneOn).toBe(false);
  });

  it('squeeze (both paddles) alternates elements', () => {
    const p = new PaddleKeyer(() => UNIT);
    const events: MorseEvent[] = [];
    events.push(...p.press('.', 0));
    events.push(...p.press('-', 10));
    runTo(p, 15, 700, events);
    p.releaseAll();
    runTo(p, 705, 2000, events);
    const marks = events.filter((e) => e.kind === 'element').map((e) => e.element);
    expect(marks.slice(0, 4)).toEqual(['.', '-', '.', '-']);
  });

  it('a tap during the inter-element gap is not lost (dot/dash memory)', () => {
    const p = new PaddleKeyer(() => UNIT);
    const events: MorseEvent[] = [];
    events.push(...p.press('.', 0));
    p.release('.');
    runTo(p, 5, 70, events); // точка кончилась на 60-й, идёт пауза до 120
    events.push(...p.press('-', 72)); // тап в паузу
    p.release('-');
    runTo(p, 75, 2000, events);
    expect(render(events)).toBe('A');
  });

  it('reset drops the unfinished letter', () => {
    const p = new PaddleKeyer(() => UNIT);
    const events: MorseEvent[] = [];
    events.push(...p.press('.', 0));
    p.release('.');
    runTo(p, 5, 70, events);
    p.reset();
    runTo(p, 75, 1000, events);
    expect(render(events)).toBe('');
  });
});
