// RX front end: microphone → AudioWorklet (тонкий форвардер сырого PCM) →
// гребёнка Гёрцеля на основном потоке ТЕМ ЖЕ кодом, что офлайн-стенд
// (SpectrumAnalyser из src/analysis/spectrum.ts) — браузер и стенд считают
// одинаково. Пуш-модель: колбэк получает SpectralFrame раз в RX_HOP_MS с
// точным временем по СЭМПЛ-СЧЁТЧИКУ потока (джиттер main-потока не искажает
// длительности меток — прежний AnalyserNode+poll(15 мс) квантовал фронты
// втрое грубее). Пороговая логика — в чистом SignalGate.

import type { SpectralFrame } from '../morse/envelope';
import { FFT_SIZE, RX_HOP_MS, SpectrumAnalyser } from '../analysis/spectrum';

export type FrameCallback = (frame: SpectralFrame, tMs: number) => void;

// Код воркета — инлайн-строкой через Blob URL: воркет тривиален (копит блоки
// по 128 сэмплов, постит пачками), а отдельный TS-модуль воркета пришлось бы
// по-особому собирать Vite'ом. Расчёт спектра сознательно НЕ здесь: бюджет
// аудио-потока жёсткий, а main может позволить себе джиттер — метки времени
// всё равно сэмпловые.
const WORKLET_JS = `
class PcmForwarder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.buf.length - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf); // structured clone — buf переиспользуем
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-forwarder', PcmForwarder);
`;

export class MicAnalyser {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: SpectrumAnalyser | null = null;
  private onFrame: FrameCallback | null = null;
  // Скользящее окно PCM: buf[0] соответствует абсолютному сэмплу bufStart.
  private buf = new Float32Array(0);
  private bufStart = 0;
  private received = 0; // всего сэмплов пришло из воркета
  private pos = 0;      // абсолютный сэмпл начала следующего окна анализа
  private hop = 1;
  private win = FFT_SIZE; // окно анализа в сэмплах (~21 мс на sr контекста)

  get running(): boolean {
    return this.node !== null;
  }

  async start(onFrame: FrameCallback): Promise<void> {
    if (this.node) return;
    // Контекст создаётся СИНХРОННО, до первого await: на Android Chrome
    // активация жеста истекает после диалога разрешений, и AudioContext,
    // созданный после await, остаётся suspended — приём вечно молчит
    // («уровень сигнала нулевой»). start() должен вызываться синхронно из
    // обработчика клика.
    const ctx = new AudioContext();
    void ctx.resume();
    this.ctx = ctx;
    let stream: MediaStream;
    try {
      // Speech-oriented processing mangles steady tones — ask for a raw feed.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const blobUrl = URL.createObjectURL(
        new Blob([WORKLET_JS], { type: 'application/javascript' }),
      );
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    } catch (e) {
      void ctx.close();
      this.ctx = null;
      throw e;
    }
    await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-forwarder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    src.connect(node);
    this.analyser = new SpectrumAnalyser(ctx.sampleRate);
    this.win = this.analyser.windowSize;
    this.hop = Math.max(1, Math.round((RX_HOP_MS / 1000) * ctx.sampleRate));
    // В использовании не бывает больше ~5×FFT_SIZE (компактация ниже) —
    // фиксированной ёмкости хватает без роста.
    this.buf = new Float32Array(FFT_SIZE * 8);
    this.bufStart = 0;
    this.received = 0;
    this.pos = 0;
    this.onFrame = onFrame;
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) this.ingest(e.data);
    };
    this.stream = stream;
    this.node = node;
  }

  // Самолечение: если контекст остался/стал suspended (система отняла аудио),
  // пробуем поднять. Дёргается из UI-цикла — сообщений-то в этом случае нет.
  heal(): void {
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  private ingest(chunk: Float32Array): void {
    if (!this.analyser || !this.ctx) return;
    this.buf.set(chunk, this.received - this.bufStart);
    this.received += chunk.length;
    while (this.pos + this.win <= this.received) {
      const frame = this.analyser.frameAt(this.buf, this.pos - this.bufStart);
      // Время кадра — конец окна анализа, по аудио-клоку потока.
      const tMs = ((this.pos + this.win) / this.ctx.sampleRate) * 1000;
      this.onFrame?.(frame, tMs);
      this.pos += this.hop;
    }
    if (this.pos - this.bufStart > FFT_SIZE * 4) {
      this.buf.copyWithin(0, this.pos - this.bufStart, this.received - this.bufStart);
      this.bufStart = this.pos;
    }
  }

  stop(): void {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.analyser = null;
    this.onFrame = null;
  }
}
