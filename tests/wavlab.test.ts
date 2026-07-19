import { encodeWAV } from '../src/audio/wav';
import {
  decodeWavPcm16, dominantFrequencyHz, runRxChain,
} from '../src/analysis/wavlab';
import { MORSE } from '../src/morse/code';

const SR = 48000;

function toneWav(text: string, unit: number, hz: number): Uint8Array {
  const segs: Array<[number, boolean]> = [[0.5, false]];
  for (const word of text.split(' ')) {
    for (const ch of word) {
      for (const el of MORSE[ch]) {
        segs.push([((el === '.' ? 1 : 3) * unit) / 1000, true]);
        segs.push([unit / 1000, false]);
      }
      segs.push([(2 * unit) / 1000, false]);
    }
    segs.push([(4 * unit) / 1000, false]);
  }
  segs.push([1, false]);
  const total = segs.reduce((a, [d]) => a + d, 0);
  const samples = new Float32Array(Math.ceil(total * SR));
  let idx = 0;
  let phase = 0;
  for (const [durS, on] of segs) {
    const n = Math.round(durS * SR);
    for (let i = 0; i < n && idx < samples.length; i++, idx++) {
      const edge = Math.min(1, Math.min(i, n - i) / (0.004 * SR));
      samples[idx] = on ? 0.4 * Math.sin(phase) * edge : 0.001 * Math.sin(idx);
      phase += (2 * Math.PI * hz) / SR;
    }
  }
  return new Uint8Array(encodeWAV(samples, SR));
}

describe('wavlab', () => {
  it('decodeWavPcm16 round-trips samples and sample rate', () => {
    const src = new Float32Array([0, 0.5, -0.5, 0.25]);
    const wav = decodeWavPcm16(new Uint8Array(encodeWAV(src, 44100)));
    expect(wav.sampleRate).toBe(44100);
    expect(wav.samples).toHaveLength(4);
    for (let i = 0; i < 4; i++) expect(wav.samples[i]).toBeCloseTo(src[i], 3);
  });

  it('rejects non-WAV data', () => {
    expect(() => decodeWavPcm16(new Uint8Array(64))).toThrow();
  });

  it('finds the dominant frequency of a 3 kHz beeper', () => {
    const wav = decodeWavPcm16(toneWav('OOO', 100, 3000));
    expect(Math.abs(dominantFrequencyHz(wav) - 3000)).toBeLessThanOrEqual(40);
  });

  it('runs the full RX chain on a synthesized message (600 Hz, 15 WPM)', () => {
    const wav = decodeWavPcm16(toneWav('SOS PARIS', 80, 600));
    expect(runRxChain(wav, 15).text).toBe('SOS PARIS');
  });

  it('runs the full RX chain on a 3 kHz slow beeper', () => {
    const wav = decodeWavPcm16(toneWav('SOS', 240, 3000));
    const res = runRxChain(wav, 5);
    expect(res.text).toBe('SOS');
    expect(Math.abs(res.unitMs - 240)).toBeLessThan(40);
  });

  it('loud broadband noise bursts decode to nothing', () => {
    // «Морзянка» из белого шума вместо тона: амплитудно — сигнал,
    // тонально — нет; SignalGate должен всё отсечь.
    const total = 4 * SR;
    const samples = new Float32Array(total);
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff - 0.5;
    };
    for (let i = 0; i < total; i++) {
      const inBurst = Math.floor(i / (0.2 * SR)) % 2 === 1;
      samples[i] = inBurst ? 0.6 * rnd() : 0.002 * rnd();
    }
    const wav = decodeWavPcm16(new Uint8Array(encodeWAV(samples, SR)));
    expect(runRxChain(wav, 15).text).toBe('');
  });
});
