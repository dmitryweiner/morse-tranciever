// Спектральный фронтенд приёма, ОБЩИЙ для браузера (src/audio/mic.ts) и
// офлайн-стенда (src/analysis/wavlab.ts): гребёнка Гёрцеля с окном Блэкмана
// по CW-полосе → SpectralFrame (пик, контраст над медианой, частота).
// Чистый модуль без Web Audio — браузер и стенд считают ОДНИМ кодом.

import type { SpectralFrame } from '../morse/envelope';

// Низ поднят с 300: бытовой гул/вибрации (шаги, касания телефона) сидят у
// нижней кромки полосы и на реальных записях крали замок несущей и рожали
// ложные буквы; собственный слайдер Tone всё равно начинается с 400 Гц.
export const BAND_LOW_HZ = 400;
// Верх — с запасом под бытовые пищалки (типичные 2–3.2 кГц), а не только
// «радийные» 400–1000 Гц: реальный тестовый зуммер пользователя — 3000 Гц.
export const BAND_HIGH_HZ = 3400;
// 1024 @ 48 кГц ≈ 21 мс окна: больше — фронты размазываются и на быстрой
// морзянке паузы между элементами схлопываются; разрешения ~47 Гц хватает.
// Окно масштабируется К ВРЕМЕНИ: на другой частоте дискретизации (запись с
// диктофона 16–44.1 кГц) берём столько сэмплов, чтобы остались те же ~21 мс
// и шаг гребёнки ~47 Гц — иначе на 16 кГц окно растягивалось до 64 мс.
export const FFT_SIZE = 1024;
const WINDOW_REF_SR = 48000;

export function windowSizeFor(sampleRate: number): number {
  return Math.max(64, Math.round((sampleRate * FFT_SIZE) / WINDOW_REF_SR));
}
// Шаг анализа: 5 мс против прежних 15 у AnalyserNode — фронты меток
// квантуются втрое мельче, паузы быстрой морзянки не съедаются.
export const RX_HOP_MS = 5;

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

// Гребёнка частот с шагом в FFT-бин по CW-полосе; окно FFT_SIZE (или короче,
// если запись мельче). frameAt повторяет MicAnalyser.poll доворклетной эпохи:
// пик полосы, контраст над медианой, частота пика; кламп -120 дБ (цифровая
// тишина — это -Inf, ломает медиану и EMA гейта).
export class SpectrumAnalyser {
  private freqs: number[] = [];
  readonly windowSize: number;

  constructor(readonly sampleRate: number, windowSize?: number) {
    this.windowSize = windowSize ?? windowSizeFor(sampleRate);
    const binHz = sampleRate / this.windowSize; // ~47 Гц при любом sampleRate
    for (let f = Math.max(binHz, BAND_LOW_HZ); f <= BAND_HIGH_HZ; f += binHz) {
      this.freqs.push(f);
    }
  }

  frameAt(samples: Float32Array, start: number): SpectralFrame {
    const len = Math.min(this.windowSize, samples.length - start);
    const band: number[] = [];
    let max = -Infinity;
    let peakHz = this.freqs[0];
    for (const f of this.freqs) {
      const p = Math.max(goertzelPowerDb(samples, start, len, this.sampleRate, f), -120);
      band.push(p);
      if (p > max) { max = p; peakHz = f; }
    }
    const sorted = [...band].sort((a, b) => a - b);
    return {
      levelDb: max,
      contrastDb: max - sorted[Math.floor(sorted.length / 2)],
      peakHz,
      // Полный спектр полосы — гейт после захвата несущей меряет сигнал
      // прямо на ней (когерентный детектор), см. SignalGate.
      bandDb: band,
      bandStartHz: this.freqs[0],
      bandStepHz: this.sampleRate / this.windowSize,
    };
  }
}
