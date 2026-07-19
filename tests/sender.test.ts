import { TextSender } from '../src/morse/sender';
import { MORSE, type MorseEvent } from '../src/morse/code';

const UNIT = 100;

// Прогоняет отправку с шагом 1 мс (границы юнитов попадают в целые мс, так
// что тайминги проверяются точно); собирает события и фронты тона.
function run(text: string): {
  events: MorseEvent[];
  edges: Array<{ on: boolean; t: number }>;
  sender: TextSender;
} {
  const sender = new TextSender(() => UNIT);
  const events: MorseEvent[] = [...sender.start(text, 0)];
  const edges: Array<{ on: boolean; t: number }> = [];
  let tone = sender.isToneOn;
  if (tone) edges.push({ on: true, t: 0 });
  for (let t = 1; t <= 100000 && sender.isSending; t++) {
    events.push(...sender.tick(t));
    if (sender.isToneOn !== tone) {
      tone = sender.isToneOn;
      edges.push({ on: tone, t });
    }
  }
  return { events, edges, sender };
}

function render(events: MorseEvent[]): string {
  let out = '';
  for (const e of events) {
    if (e.kind === 'letter') out += e.char ?? '?';
    if (e.kind === 'word') out += ' ';
  }
  return out.trimEnd();
}

describe('TextSender', () => {
  it('sends a message: same events as hand-keying the same text', () => {
    const { events } = run('HELLO WORLD');
    expect(render(events)).toBe('HELLO WORLD');
    const elements = events
      .filter((e) => e.kind === 'element')
      .map((e) => (e.kind === 'element' ? e.element : ''))
      .join('');
    expect(elements).toBe([...'HELLOWORLD'].map((c) => MORSE[c]).join(''));
  });

  it('keys textbook PARIS timings: dot 1u, dash 3u, element gap 1u', () => {
    const { edges } = run('A');
    expect(edges).toEqual([
      { on: true, t: 0 },    // точка
      { on: false, t: 100 },
      { on: true, t: 200 },  // тире после паузы 1 юнит
      { on: false, t: 500 },
    ]);
  });

  it('letter gap is 3 units, word gap is 7 units', () => {
    const { edges } = run('EE E');
    expect(edges).toEqual([
      { on: true, t: 0 },
      { on: false, t: 100 },
      { on: true, t: 400 },  // буква: 100 + 3u
      { on: false, t: 500 },
      { on: true, t: 1200 }, // слово: 500 + 7u
      { on: false, t: 1300 },
    ]);
  });

  it('unknown characters act as a word gap', () => {
    const { events, edges } = run('E#E');
    expect(render(events)).toBe('E E');
    expect(edges[2]).toEqual({ on: true, t: 800 });
  });

  it('finishes after the last letter commits, without a trailing space', () => {
    const { events, sender } = run('E');
    expect(sender.isSending).toBe(false);
    expect(events.filter((e) => e.kind === 'word')).toHaveLength(0);
    expect(render(events)).toBe('E');
  });

  it('tracks the index of the letter being sent (skipping gaps)', () => {
    const sender = new TextSender(() => UNIT);
    sender.start('A B', 0);
    expect(sender.currentIndex).toBe(0);
    // A: точка 0–100, тире 200–500; B стартует в 500 + 7u = 1200.
    for (let t = 1; t <= 1150; t++) sender.tick(t);
    expect(sender.currentIndex).toBe(0);
    for (let t = 1151; t <= 1250; t++) sender.tick(t);
    expect(sender.currentIndex).toBe(2);
  });

  it('stop() aborts mid-element: tone off, partial letter discarded', () => {
    const sender = new TextSender(() => UNIT);
    sender.start('T', 0);
    sender.tick(100); // тире звучит до 300
    expect(sender.isToneOn).toBe(true);
    sender.stop();
    expect(sender.isToneOn).toBe(false);
    expect(sender.isSending).toBe(false);
    const after: MorseEvent[] = [];
    for (let t = 101; t < 2000; t++) after.push(...sender.tick(t));
    expect(after).toHaveLength(0);
  });

  it('a text with no known letters does not start', () => {
    const sender = new TextSender(() => UNIT);
    const events = sender.start('#  !', 0);
    expect(events).toHaveLength(0);
    expect(sender.isSending).toBe(false);
  });

  it('lowercase input is sent as uppercase', () => {
    const { events } = run('sos');
    expect(render(events)).toBe('SOS');
  });

  it('sends digits and punctuation from the extended table', () => {
    const { events } = run('CQ DE 73 = OK?');
    expect(render(events)).toBe('CQ DE 73 = OK?');
  });
});
