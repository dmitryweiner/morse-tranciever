// Офлайн-стенд анализа WAV: та же цепочка, что в браузере (оконный спектр →
// пик в CW-полосе → EnvelopeGate → AdaptiveDecoder), но чистый node — без
// playwright. Здесь удобно смотреть огибающую/фронты реальных записей и
// тюнить гейт/декодер; браузерный e2e (scripts/rx.mjs) остаётся финальной
// проверкой. CLI-обёртка — scripts/wavlab.ts (npm run wav).

import { SignalGate, type SpectralFrame } from '../morse/envelope';
import { AdaptiveDecoder } from '../morse/decoder';
import { unitMs } from '../morse/timing';
import type { MorseEvent } from '../morse/code';
import { FFT_SIZE, RX_HOP_MS, SpectrumAnalyser, goertzelPowerDb, windowSizeFor } from './spectrum';

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

// Спектральная математика (Гёрцель, гребёнка, SpectralFrame) переехала в
// ./spectrum — тем же кодом теперь считает и браузерный приём.
export { goertzelPowerDb } from './spectrum';

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
// контраст над медианой полосы и частота (SpectrumAnalyser — общий код).
export function spectralFrames(wav: WavData, hopMs = RX_HOP_MS): SpectralFrame[] {
  const { samples, sampleRate } = wav;
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const frame = Math.min(windowSizeFor(sampleRate), samples.length);
  const analyser = new SpectrumAnalyser(sampleRate, frame);
  const out: SpectralFrame[] = [];
  for (let k = 0; (k * hop) + frame <= samples.length; k++) {
    out.push(analyser.frameAt(samples, k * hop));
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

// Пошаговый прогон записи через РЕАЛЬНЫЕ гейт и декодер. Единственная
// реализация цепочки для файлов: runRxChain (стенд/тесты) гоняет её залпом,
// браузерная кнопка Upload — порциями step() c паузами, чтобы не вешать UI.
export class RxChainRunner {
  readonly totalFrames: number;
  readonly edges: number[] = [];
  private readonly samples: Float32Array;
  private readonly hopSamples: number;
  private readonly analyser: SpectrumAnalyser;
  private readonly gate: SignalGate;
  private readonly decoder: AdaptiveDecoder;
  private k = 0;
  private prevOn = false;
  private edgeAt = 0;
  private finished = false;

  constructor(wav: WavData, seedWpm = 15, private hopMs = RX_HOP_MS) {
    this.samples = wav.samples;
    this.hopSamples = Math.max(1, Math.round((hopMs / 1000) * wav.sampleRate));
    const win = Math.min(windowSizeFor(wav.sampleRate), wav.samples.length);
    this.analyser = new SpectrumAnalyser(wav.sampleRate, win);
    this.gate = new SignalGate(hopMs);
    this.decoder = new AdaptiveDecoder(unitMs(seedWpm));
    this.totalFrames = Math.floor((wav.samples.length - win) / this.hopSamples) + 1;
  }

  get processedFrames(): number {
    return this.k;
  }

  get done(): boolean {
    return this.k >= this.totalFrames;
  }

  get unitMs(): number {
    return this.decoder.unitMs;
  }

  get dashDotRatio(): number {
    return this.decoder.dashDotRatio;
  }

  step(maxFrames: number): MorseEvent[] {
    const events: MorseEvent[] = [];
    const end = Math.min(this.k + maxFrames, this.totalFrames);
    for (; this.k < end; this.k++) {
      const t = this.k * this.hopMs;
      const on = this.gate.update(this.analyser.frameAt(this.samples, this.k * this.hopSamples));
      if (on !== this.prevOn) {
        this.edges.push(Math.round(t - this.edgeAt) * (this.prevOn ? 1 : -1));
        this.prevOn = on;
        this.edgeAt = t;
      }
      events.push(...this.decoder.signal(on, t));
      events.push(...this.decoder.tick(t));
    }
    return events;
  }

  // Дать хвосту закоммититься (последняя буква/слово).
  finish(): MorseEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const tEnd = this.totalFrames * this.hopMs + 10 * this.decoder.unitMs;
    return [...this.decoder.signal(false, tEnd), ...this.decoder.tick(tEnd)];
  }
}

// Прогон целиком — тот же код, что в браузерном Upload, но залпом.
export function runRxChain(wav: WavData, seedWpm = 15, hopMs = RX_HOP_MS): RxChainResult {
  const runner = new RxChainRunner(wav, seedWpm, hopMs);
  const events: MorseEvent[] = [];
  while (!runner.done) events.push(...runner.step(1000));
  events.push(...runner.finish());

  let text = '';
  for (const e of events) {
    if (e.kind === 'letter') text += e.char ?? '?';
    if (e.kind === 'word') text += ' ';
  }
  return {
    text: text.trim(),
    events,
    edges: runner.edges,
    unitMs: runner.unitMs,
    estWpm: Math.round(1200 / runner.unitMs),
  };
}
