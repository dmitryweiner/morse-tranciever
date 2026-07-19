// Запись ПЕРЕДАЧИ в WAV: TxRecorder собирает фронты бокового тона (любой
// источник — straight, paddle, отправка текста), renderToneWav синтезирует
// из них чистую синусоиду с рампами — тот же сигнал, что слышит приёмник.
// Синтез вместо захвата аудиографа: чистый модуль (тестируется в node,
// round-trip через реальную RX-цепочку стенда), работает и с выключенным
// звуком, и на iOS. Кодирование — src/audio/wav.ts, скачивание — main.

export interface ToneMark {
  startMs: number;
  endMs: number;
  hz: number; // частота слайдера Tone на момент включения метки
}

// 16 кГц хватает с запасом (верх слайдера 3400 Гц < Найквиста 8 кГц), а
// файл вшестеро легче 48 кГц: ~2 МБ за минуту.
export const TX_REC_SAMPLE_RATE = 16000;
// Тишина до первой метки (длинное ожидание после нажатия Record обрезается
// до этого форшлага) и после последней.
const LEAD_MS = 500;
const TAIL_MS = 500;
const RAMP_MS = 4; // фронты как у Sidetone — без щелчков
const AMP = 0.5;

export class TxRecorder {
  private marks: ToneMark[] = [];
  private begunAt: number | null = null;
  private onSince: number | null = null;
  private onHz = 600;

  constructor(private maxMs = 120_000) {}

  get recording(): boolean {
    return this.begunAt !== null;
  }

  elapsedMs(t: number): number {
    return this.begunAt === null ? 0 : t - this.begunAt;
  }

  isFull(t: number): boolean {
    return this.begunAt !== null && this.elapsedMs(t) >= this.maxMs;
  }

  start(t: number): void {
    this.marks = [];
    this.begunAt = t;
    this.onSince = null;
  }

  toneOn(t: number, hz: number): void {
    if (this.begunAt === null || this.onSince !== null) return;
    this.onSince = t;
    this.onHz = hz;
  }

  toneOff(t: number): void {
    if (this.begunAt === null || this.onSince === null) return;
    if (t > this.onSince) this.marks.push({ startMs: this.onSince, endMs: t, hz: this.onHz });
    this.onSince = null;
  }

  // Останов: метки со сдвинутым нулём (ожидание до первой метки обрезано до
  // LEAD_MS) или null, если выстукивать так и не начали.
  stop(t: number): ToneMark[] | null {
    if (this.begunAt === null) return null;
    this.toneOff(t); // недозвучавший тон закрывается временем стопа
    const { marks, begunAt } = this;
    this.marks = [];
    this.begunAt = null;
    if (marks.length === 0) return null;
    const t0 = Math.max(begunAt, marks[0].startMs - LEAD_MS);
    return marks.map((m) => ({ startMs: m.startMs - t0, endMs: m.endMs - t0, hz: m.hz }));
  }
}

export function renderToneWav(marks: ToneMark[], sampleRate = TX_REC_SAMPLE_RATE): Float32Array {
  if (marks.length === 0) return new Float32Array(0);
  const endMs = marks[marks.length - 1].endMs + TAIL_MS;
  const out = new Float32Array(Math.ceil((endMs / 1000) * sampleRate));
  const ramp = Math.max(1, Math.round((RAMP_MS / 1000) * sampleRate));
  for (const m of marks) {
    const n0 = Math.round((m.startMs / 1000) * sampleRate);
    const len = Math.min(Math.round(((m.endMs - m.startMs) / 1000) * sampleRate), out.length - n0);
    const w = (2 * Math.PI * m.hz) / sampleRate;
    for (let i = 0; i < len; i++) {
      const edge = Math.min(1, Math.min(i, len - i) / ramp);
      out[n0 + i] = AMP * Math.sin(w * i) * edge;
    }
  }
  return out;
}
