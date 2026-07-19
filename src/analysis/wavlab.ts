// Офлайн-стенд анализа WAV: та же цепочка, что в браузере (оконный спектр →
// пик в CW-полосе → EnvelopeGate → AdaptiveDecoder), но чистый node — без
// playwright. Здесь удобно смотреть огибающую/фронты реальных записей и
// тюнить гейт/декодер; браузерный e2e (scripts/rx.mjs) остаётся финальной
// проверкой. CLI-обёртка — scripts/wavlab.ts (npm run wav).

import { SignalGate, type SpectralFrame } from '../morse/envelope';
import { AdaptiveDecoder } from '../morse/decoder';
import { unitMs } from '../morse/timing';
import type { MorseEvent } from '../morse/code';
import { BAND_LOW_HZ, BAND_HIGH_HZ, FFT_SIZE } from '../audio/mic';

export interface WavData {
  sampleRate: number;
  samples: Float32Array;
}

// Мини-разбор WAV: идём по чанкам (не полагаемся на data строго в 44-м
// байте — диктофоны любят вставлять LIST/INFO). 16-bit PCM; стерео
// сводится в моно усреднением.
export function decodeWavPcm16(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) =>
    String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('не WAV (нет RIFF/WAVE)');

  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      const format = view.getUint16(off + 8, true);
      if (format !== 1) throw new Error(`поддерживается только PCM (format=1), получен ${format}`);
      channels = view.getUint16(off + 10, true);
      sampleRate = view.getUint32(off + 12, true);
      bits = view.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = Math.min(size, view.byteLength - dataOff);
    }
    off += 8 + size + (size % 2);
  }
  if (!sampleRate || dataOff < 0) throw new Error('в WAV нет fmt/data чанков');
  if (bits !== 16) throw new Error(`поддерживается только 16 бит, получено ${bits}`);

  const frames = Math.floor(dataLen / 2 / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let ch = 0; ch < channels; ch++) {
      acc += view.getInt16(dataOff + (i * channels + ch) * 2, true);
    }
    samples[i] = acc / channels / 32768;
  }
  return { sampleRate, samples };
}

// Мощность Гёрцеля на одной частоте (окно Блэкмана — как в AnalyserNode).
export function goertzelPowerDb(
  samples: Float32Array, start: number, len: number, sampleRate: number, hz: number,
): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    const win = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / len) + 0.08 * Math.cos((4 * Math.PI * i) / len);
    const s0 = samples[start + i] * win + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = (s1 * s1 + s2 * s2 - c * s1 * s2) / (len * len);
  return 10 * Math.log10(power + 1e-20);
}

// Доминирующая частота по самым громким кадрам файла.
export function dominantFrequencyHz(
  wav: WavData, lo = 100, hi = 8000, step = 20,
): number {
  const { samples, sampleRate } = wav;
  const frame = Math.min(FFT_SIZE, samples.length);
  // Самый громкий кадр по RMS.
  let bestStart = 0;
  let bestRms = -1;
  const hop = Math.max(1, Math.floor(sampleRate * 0.05));
  for (let s = 0; s + frame <= samples.length; s += hop) {
    let e = 0;
    for (let i = 0; i < frame; i++) e += samples[s + i] * samples[s + i];
    if (e > bestRms) { bestRms = e; bestStart = s; }
  }
  let bestF = lo;
  let bestP = -Infinity;
  for (let f = lo; f <= hi; f += step) {
    const p = goertzelPowerDb(samples, bestStart, frame, sampleRate, f);
    if (p > bestP) { bestP = p; bestF = f; }
  }
  return bestF;
}

// Кадры «как в браузере»: раз в hopMs — пик спектра в CW-полосе, его
// контраст над медианой полосы и частота (см. MicAnalyser.poll).
export function spectralFrames(wav: WavData, hopMs = 15): SpectralFrame[] {
  const { samples, sampleRate } = wav;
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const frame = Math.min(FFT_SIZE, samples.length);
  const binHz = sampleRate / FFT_SIZE;
  const freqs: number[] = [];
  for (let f = Math.max(binHz, BAND_LOW_HZ); f <= BAND_HIGH_HZ; f += binHz) freqs.push(f);
  const out: SpectralFrame[] = [];
  for (let k = 0; (k * hop) + frame <= samples.length; k++) {
    const band: number[] = [];
    let max = -Infinity;
    let peakHz = freqs[0];
    for (const f of freqs) {
      const p = Math.max(goertzelPowerDb(samples, k * hop, frame, sampleRate, f), -120);
      band.push(p);
      if (p > max) { max = p; peakHz = f; }
    }
    band.sort((a, b) => a - b);
    out.push({
      levelDb: max,
      contrastDb: max - band[Math.floor(band.length / 2)],
      peakHz,
    });
  }
  return out;
}

export interface RxChainResult {
  text: string;
  events: MorseEvent[];
  // Фронты гейта: положительное — тон (мс), отрицательное — тишина (мс).
  edges: number[];
  unitMs: number;
  estWpm: number;
}

// Прогон кадров через РЕАЛЬНЫЕ гейт и декодер — тот же код, что в main.ts.
export function runRxChain(wav: WavData, seedWpm = 15, hopMs = 15): RxChainResult {
  const frames = spectralFrames(wav, hopMs);
  const gate = new SignalGate();
  const decoder = new AdaptiveDecoder(unitMs(seedWpm));
  const events: MorseEvent[] = [];
  const edges: number[] = [];
  let prevOn = false;
  let edgeAt = 0;
  for (let k = 0; k < frames.length; k++) {
    const t = k * hopMs;
    const on = gate.update(frames[k]);
    if (on !== prevOn) {
      edges.push(Math.round(t - edgeAt) * (prevOn ? 1 : -1));
      prevOn = on;
      edgeAt = t;
    }
    events.push(...decoder.signal(on, t));
    events.push(...decoder.tick(t));
  }
  // Дать хвосту закоммититься.
  const tEnd = frames.length * hopMs + 10 * decoder.unitMs;
  events.push(...decoder.signal(false, tEnd));
  events.push(...decoder.tick(tEnd));

  let text = '';
  for (const e of events) {
    if (e.kind === 'letter') text += e.char ?? '?';
    if (e.kind === 'word') text += ' ';
  }
  return {
    text: text.trim(),
    events,
    edges,
    unitMs: decoder.unitMs,
    estWpm: Math.round(1200 / decoder.unitMs),
  };
}
