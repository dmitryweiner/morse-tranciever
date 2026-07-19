import { EnvelopeGate, SignalGate, type SpectralFrame } from '../src/morse/envelope';

function feed(gate: EnvelopeGate, levelDb: number, frames: number): boolean {
  let s = gate.isOn;
  for (let i = 0; i < frames; i++) s = gate.update(levelDb);
  return s;
}

describe('EnvelopeGate', () => {
  it('stays off on steady noise', () => {
    const gate = new EnvelopeGate();
    expect(feed(gate, -85, 200)).toBe(false);
  });

  it('opens fast on a loud tone and closes on silence', () => {
    const gate = new EnvelopeGate();
    feed(gate, -85, 100);
    expect(feed(gate, -30, 3)).toBe(true);
    expect(feed(gate, -85, 3)).toBe(false);
  });

  it('tracks a full dot/gap train without missing edges', () => {
    const gate = new EnvelopeGate();
    feed(gate, -85, 100);
    let transitions = 0;
    let prev = gate.isOn;
    for (let k = 0; k < 10; k++) {
      for (let i = 0; i < 4; i++) {
        const s = gate.update(-30);
        if (s !== prev) transitions++;
        prev = s;
      }
      for (let i = 0; i < 4; i++) {
        const s = gate.update(-85);
        if (s !== prev) transitions++;
        prev = s;
      }
    }
    expect(transitions).toBe(20);
  });

  it('hysteresis: mid levels do not flip the state', () => {
    const gate = new EnvelopeGate();
    feed(gate, -85, 100);
    feed(gate, -30, 5); // on; peak ≈ -30, floor ≈ -85
    feed(gate, -85, 5); // off
    // Mid level sits between offThr and onThr — must stay off.
    expect(feed(gate, -62, 3)).toBe(false);
  });

  it('ignores small wobble with no real signal spread', () => {
    const gate = new EnvelopeGate();
    feed(gate, -80, 50);
    expect(feed(gate, -75, 5)).toBe(false);
  });
});

const noise = (levelDb = -85): SpectralFrame =>
  ({ levelDb, contrastDb: 3, peakHz: 500 + Math.random() * 2000 });
const tone = (levelDb = -30, hz = 3000): SpectralFrame =>
  ({ levelDb, contrastDb: 35, peakHz: hz });

function feedFrames(gate: SignalGate, frame: () => SpectralFrame, n: number): boolean {
  let s = gate.isOn;
  for (let i = 0; i < n; i++) s = gate.update(frame());
  return s;
}

describe('SignalGate (tonality filter)', () => {
  it('a steady tone opens the gate', () => {
    const gate = new SignalGate();
    feedFrames(gate, () => noise(), 100);
    expect(feedFrames(gate, () => tone(), 4)).toBe(true);
    expect(feedFrames(gate, () => noise(), 4)).toBe(false);
  });

  it('loud broadband noise stays rejected (low contrast)', () => {
    const gate = new SignalGate();
    feedFrames(gate, () => noise(-85), 100);
    // Громкий шум: амплитудный гейт открылся бы, тональность — нет.
    expect(feedFrames(gate, () => noise(-30), 30)).toBe(false);
  });

  it('a contrasty peak hopping in frequency (speech-like) stays rejected', () => {
    const gate = new SignalGate();
    feedFrames(gate, () => noise(), 100);
    let hop = 500;
    const speech = (): SpectralFrame => {
      hop = hop === 500 ? 2400 : 500; // скачет на сотни герц каждый кадр
      return { levelDb: -30, contrastDb: 14, peakHz: hop };
    };
    expect(feedFrames(gate, speech, 30)).toBe(false);
  });

  it('a tone buried in noise still opens (contrast persists)', () => {
    const gate = new SignalGate();
    feedFrames(gate, () => noise(-60), 100);
    expect(feedFrames(gate, () => tone(-35), 4)).toBe(true);
  });

  it('locks onto the carrier after a sustained mark and reports it', () => {
    const gate = new SignalGate();
    feedFrames(gate, () => noise(), 50);
    feedFrames(gate, () => tone(-30, 3000), 4);
    expect(gate.carrierHz).toBeNull(); // короткий всплеск замок не ставит
    feedFrames(gate, () => tone(-30, 3000), 8);
    expect(gate.carrierHz).not.toBeNull();
    expect(Math.abs((gate.carrierHz ?? 0) - 3000)).toBeLessThan(100);
  });

  it('after locking, a brief tone on another frequency is rejected', () => {
    const gate = new SignalGate();
    feedFrames(gate, () => noise(), 50);
    feedFrames(gate, () => tone(-30, 3000), 12);
    feedFrames(gate, () => noise(), 10);
    // Помеха на 600 Гц короче порога перезахвата (~27 кадров) — не сигнал.
    expect(feedFrames(gate, () => tone(-30, 600), 10)).toBe(false);
    expect(Math.abs((gate.carrierHz ?? 0) - 3000)).toBeLessThan(100);
    // А свой тон по-прежнему принимается.
    expect(feedFrames(gate, () => tone(-30, 3000), 3)).toBe(true);
  });

  it('a persistent new carrier re-locks the gate', () => {
    const gate = new SignalGate();
    feedFrames(gate, () => noise(), 50);
    feedFrames(gate, () => tone(-30, 3000), 12);
    feedFrames(gate, () => noise(), 10);
    // Новый отправитель на 600 Гц: держится дольше порога — перезахват.
    expect(feedFrames(gate, () => tone(-30, 600), 40)).toBe(true);
    expect(Math.abs((gate.carrierHz ?? 0) - 600)).toBeLessThan(100);
  });

  it('the lock is released after a long silence', () => {
    const gate = new SignalGate();
    feedFrames(gate, () => noise(), 50);
    feedFrames(gate, () => tone(-30, 3000), 12);
    feedFrames(gate, () => noise(), 1400);
    expect(gate.carrierHz).toBeNull();
  });

  it('tracks an on/off dot train without losing edges', () => {
    const gate = new SignalGate();
    feedFrames(gate, () => noise(), 100);
    let transitions = 0;
    let prev = gate.isOn;
    for (let k = 0; k < 10; k++) {
      for (let i = 0; i < 4; i++) {
        const s = gate.update(tone());
        if (s !== prev) transitions++;
        prev = s;
      }
      for (let i = 0; i < 4; i++) {
        const s = gate.update(noise());
        if (s !== prev) transitions++;
        prev = s;
      }
    }
    expect(transitions).toBe(20);
  });
});
