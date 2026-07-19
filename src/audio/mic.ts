// RX front end: microphone → AnalyserNode. Each poll returns a SpectralFrame:
// the loudest FFT bin in the CW band (robust to senders on a different tone
// frequency), its contrast over the band median (tonality — отличает синус от
// шума/речи) and its frequency. Thresholding lives in the pure SignalGate.

import type { SpectralFrame } from '../morse/envelope';

// Экспортируются: офлайн-стенд (src/analysis/wavlab.ts) эмулирует этот же
// анализ по тем же константам.
export const BAND_LOW_HZ = 300;
// Верх — с запасом под бытовые пищалки (типичные 2–3.2 кГц), а не только
// «радийные» 400–1000 Гц: реальный тестовый зуммер пользователя — 3000 Гц.
export const BAND_HIGH_HZ = 3400;
// 1024 @ 48 кГц ≈ 21 мс окна: больше — фронты размазываются и на быстрой
// морзянке паузы между элементами схлопываются; разрешения ~47 Гц хватает.
export const FFT_SIZE = 1024;

export class MicAnalyser {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private bins: Float32Array<ArrayBuffer> | null = null;

  get running(): boolean {
    return this.analyser !== null;
  }

  async start(): Promise<void> {
    if (this.analyser) return;
    // Speech-oriented processing mangles steady tones — ask for a raw feed.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = new AudioContext();
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0; // временное сглаживание размазало бы фронты
    src.connect(analyser);
    this.ctx = ctx;
    this.stream = stream;
    this.analyser = analyser;
    this.bins = new Float32Array(analyser.frequencyBinCount);
  }

  poll(): SpectralFrame {
    if (!this.ctx || !this.analyser || !this.bins) {
      return { levelDb: -120, contrastDb: 0, peakHz: 0 };
    }
    this.analyser.getFloatFrequencyData(this.bins);
    const hzPerBin = this.ctx.sampleRate / FFT_SIZE;
    const lo = Math.max(1, Math.floor(BAND_LOW_HZ / hzPerBin));
    const hi = Math.min(this.bins.length - 1, Math.ceil(BAND_HIGH_HZ / hzPerBin));
    const band: number[] = [];
    let max = -Infinity;
    let peakBin = lo;
    for (let i = lo; i <= hi; i++) {
      // Цифровая тишина даёт -Infinity — ломает и медиану, и EMA гейта.
      const v = Number.isFinite(this.bins[i]) ? Math.max(this.bins[i], -120) : -120;
      band.push(v);
      if (v > max) { max = v; peakBin = i; }
    }
    band.sort((a, b) => a - b);
    const median = band[Math.floor(band.length / 2)];
    return {
      levelDb: max,
      contrastDb: max - median,
      peakHz: peakBin * hzPerBin,
    };
  }

  stop(): void {
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.bins = null;
  }
}
