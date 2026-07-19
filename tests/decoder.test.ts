import { AdaptiveDecoder } from '../src/morse/decoder';
import { MORSE, type MorseEvent } from '../src/morse/code';

// Plays text as tone on/off edges with textbook timings at the given unit.
function playText(dec: AdaptiveDecoder, text: string, unit: number): MorseEvent[] {
  const events: MorseEvent[] = [];
  let t = 1000;
  for (const word of text.split(' ')) {
    for (const ch of word) {
      for (const el of MORSE[ch]) {
        events.push(...dec.signal(true, t));
        t += (el === '.' ? 1 : 3) * unit;
        events.push(...dec.signal(false, t));
        t += unit;
      }
      t += 2 * unit; // letter gap totals 3 units
      events.push(...dec.tick(t));
    }
    t += 4 * unit; // word gap totals 7 units
    events.push(...dec.tick(t));
  }
  events.push(...dec.tick(t + 20 * unit));
  return events;
}

function render(events: MorseEvent[]): string {
  let out = '';
  for (const e of events) {
    if (e.kind === 'letter') out += e.char ?? '?';
    if (e.kind === 'word') out += ' ';
  }
  return out.trimEnd();
}

describe('AdaptiveDecoder', () => {
  it('decodes at the seeded speed', () => {
    const dec = new AdaptiveDecoder(60);
    expect(render(playText(dec, 'SOS PARIS', 60))).toBe('SOS PARIS');
  });

  it('decodes without ticks between letters (edges alone commit)', () => {
    const dec = new AdaptiveDecoder(60);
    const events: MorseEvent[] = [];
    // "EE": dot, letter gap, dot — second signal(true) must commit the first E.
    events.push(...dec.signal(true, 1000));
    events.push(...dec.signal(false, 1060));
    events.push(...dec.signal(true, 1240));
    events.push(...dec.signal(false, 1300));
    events.push(...dec.tick(2000));
    expect(render(events)).toBe('EE');
  });

  it('adapts to a 2× slower sender (first letter may garble)', () => {
    const dec = new AdaptiveDecoder(60);
    const out = render(playText(dec, 'PARIS PARIS', 120));
    expect(out.endsWith('ARIS PARIS')).toBe(true);
    // Первая буква на вдвое чужой скорости может рассыпаться на 2–3 знака.
    expect(out.length).toBeLessThanOrEqual('PARIS PARIS'.length + 3);
    expect(dec.unitMs).toBeGreaterThan(100);
    expect(dec.unitMs).toBeLessThan(140);
  });

  it('adapts to a faster sender', () => {
    const dec = new AdaptiveDecoder(120);
    const out = render(playText(dec, 'PARIS PARIS', 60));
    expect(out.endsWith('ARIS PARIS')).toBe(true);
    expect(out.length).toBeLessThanOrEqual('PARIS PARIS'.length + 1);
    expect(dec.unitMs).toBeGreaterThan(50);
    expect(dec.unitMs).toBeLessThan(70);
  });

  it('holds its estimate through steady traffic', () => {
    const dec = new AdaptiveDecoder(100);
    expect(render(playText(dec, 'THE QUICK BROWN FOX JUMPS OVER A LAZY DOG', 100)))
      .toBe('THE QUICK BROWN FOX JUMPS OVER A LAZY DOG');
    expect(Math.abs(dec.unitMs - 100)).toBeLessThan(15);
  });

  it('a junk burst (way too long for any element) does not poison adaptation', () => {
    const dec = new AdaptiveDecoder(80);
    const events: MorseEvent[] = [];
    // Полуторасекундный «бип» (артефакт/помеха)…
    events.push(...dec.signal(true, 1000));
    events.push(...dec.signal(false, 2515));
    events.push(...dec.tick(5000));
    // …а затем нормальный SOS на прежней скорости.
    let t = 5000;
    for (const el of ['...', '---', '...'].join('|').split('')) {
      if (el === '|') { t += 160; events.push(...dec.tick(t)); continue; }
      events.push(...dec.signal(true, t));
      t += el === '.' ? 80 : 240;
      events.push(...dec.signal(false, t));
      t += 80;
    }
    events.push(...dec.tick(t + 2000));
    expect(render(events).endsWith('SOS')).toBe(true);
    expect(Math.abs(dec.unitMs - 80)).toBeLessThan(15);
  });

  it('survives a bouncy mechanical beeper (timings from a real recording)', () => {
    // Сегменты из samples/SOS3.wav (3 кГц пищалка, ~4 WPM): S, O с «заикающимся»
    // третьим тире (дребезг кнопки — осколки 5–95 мс), снова S с осколком.
    const segs = [
      310, -95, 315, -35, 300, -850,                    // S (точки ~300 мс)
      520, -385, 520, -380, 525,                        // O…
      -5, 10, -5, 10, -25, 45, -10, 5, -60, 45, -15, 10, -95, 5, -75, 20, // …дребезг
      -380, 310, -25, 290, -50, 305, -565, 20, -425,    // S + осколок 20 мс
    ];
    const dec = new AdaptiveDecoder(240); // слайдер на минимуме (5 WPM)
    const events: MorseEvent[] = [];
    let t = 1000;
    for (const seg of segs) {
      events.push(...dec.signal(seg > 0, t));
      t += Math.abs(seg);
      events.push(...dec.tick(t));
    }
    events.push(...dec.signal(false, t));
    events.push(...dec.tick(t + 3000));
    expect(render(events)).toBe('SOS');
  });

  it('setUnitMs re-seeds and clears history', () => {
    const dec = new AdaptiveDecoder(60);
    playText(dec, 'PARIS', 120);
    dec.setUnitMs(60);
    expect(dec.unitMs).toBe(60);
    expect(render(playText(dec, 'SOS', 60))).toBe('SOS');
  });
});
