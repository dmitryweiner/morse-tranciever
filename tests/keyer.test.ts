import { Keyer } from '../src/morse/keyer';
import { MORSE, type MorseEvent } from '../src/morse/code';

// Scripted "hand" that keys text with given timings and collects events.
function keyText(
  keyer: Keyer,
  text: string,
  unit: number,
  scale = { dot: 1, dash: 3, gap: 1, letterGap: 3, wordGap: 7 },
): MorseEvent[] {
  const events: MorseEvent[] = [];
  let t = 1000;
  for (const word of text.split(' ')) {
    for (const ch of word) {
      for (const el of MORSE[ch]) {
        events.push(...keyer.keyDown(t));
        t += (el === '.' ? scale.dot : scale.dash) * unit;
        events.push(...keyer.keyUp(t));
        t += scale.gap * unit;
      }
      t += (scale.letterGap - scale.gap) * unit;
      events.push(...keyer.tick(t));
    }
    t += (scale.wordGap - scale.letterGap) * unit;
    events.push(...keyer.tick(t));
  }
  events.push(...keyer.tick(t + 20 * unit));
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

describe('Keyer', () => {
  it('keys SOS PARIS with textbook timings', () => {
    const keyer = new Keyer(() => 60);
    expect(render(keyText(keyer, 'SOS PARIS', 60))).toBe('SOS PARIS');
  });

  it('tolerates sloppy hand timings', () => {
    const keyer = new Keyer(() => 60);
    const events = keyText(keyer, 'HELLO WORLD', 60, {
      dot: 1.4, dash: 2.5, gap: 0.6, letterGap: 2.6, wordGap: 6,
    });
    expect(render(events)).toBe('HELLO WORLD');
  });

  it('reports elements with the growing code buffer', () => {
    const keyer = new Keyer(() => 60);
    const events = keyText(keyer, 'A', 60);
    const codes = events.filter((e) => e.kind === 'element').map((e) => e.code);
    expect(codes).toEqual(['.', '.-']);
  });

  it('does not emit a second word gap in one long silence', () => {
    const keyer = new Keyer(() => 60);
    const events = keyText(keyer, 'E', 60);
    events.push(...keyer.tick(1000000));
    expect(events.filter((e) => e.kind === 'word')).toHaveLength(1);
  });

  it('keyDown commits a pending letter even without ticks', () => {
    const keyer = new Keyer(() => 60);
    const events: MorseEvent[] = [];
    events.push(...keyer.keyDown(1000));
    events.push(...keyer.keyUp(1060));       // dot → E
    events.push(...keyer.keyDown(1300));     // gap 240ms > 2u — letter must commit
    events.push(...keyer.keyUp(1480));       // dash → T
    events.push(...keyer.tick(2000));
    expect(render(events)).toBe('ET');
  });
});
