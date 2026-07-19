// RX decoder: turns tone on/off edges (timestamps in ms) into Morse events,
// auto-adapting to the sender's speed. Pure — the mic layer feeds it edges.
//
// Adaptation: a sliding window of recent mark durations. When the window
// clearly contains two clusters (dashes are 3× dots), the split threshold is
// their geometric mean and the unit re-estimates from the dot cluster. When
// all marks look alike (only dots or only dashes so far), the current unit
// estimate decides, nudged toward whichever reading (all-dots / all-dashes)
// is closer to it. The first letter of a transmission at a wildly different
// speed may garble — inherent to any adaptive CW decoder.

import { decodeCode, type MorseEvent } from './code';
import { LETTER_GAP_UNITS, WORD_GAP_UNITS } from './timing';

const WINDOW = 12;          // recent marks kept for clustering
const CLUSTER_RATIO = 2.2;  // max/min above this ⇒ both dots and dashes present
const MIN_UNIT = 15;        // ~80 WPM
const MAX_UNIT = 400;       // ~3 WPM
// Метка длиннее 8 юнитов не может быть элементом ни на какой близкой
// скорости (тире вдвое медленнее текущей оценки — 6 юнитов) — это помеха;
// классифицируем как тире, но в адаптацию не пускаем, иначе один всплеск
// травит оценку скорости на десяток букв вперёд.
const JUNK_UNITS = 8;
// Абсолютный потолок метки: тире даже на минимальных 3 WPM (юнит 400 мс) —
// это 1200 мс; длиннее — гарантированно помеха при любом юните.
const MAX_MARK_MS = 3 * MAX_UNIT;
// Дребезг механической пищалки/кнопки: разрыв тона короче этого — не пауза,
// а продолжение той же метки (масштаб дребезга аппаратный, поэтому порог
// абсолютный, не в юнитах). Финализация метки откладывается на это время.
const GLITCH_MERGE_MS = 25;
// Метка короче 0.35 юнита — осколок дребезга: не элемент, не адаптирует и
// не сдвигает таймер паузы (реальная точка — 1 юнит).
const MIN_MARK_UNITS = 0.35;
// Метки короче 0.45 юнита в адаптацию не пускаем: диапазон трекинга ±2×
// (точка вдвое быстрее — 0.5 юнита), а склеенные «трели» дребезга дают
// псевдо-точки 0.3–0.45 юнита, которые парой формировали ложный кластер
// и обваливали оценку юнита (реальный случай: sample2, 240 → 82 мс).
const ADAPT_MIN_UNITS = 0.45;

export class AdaptiveDecoder {
  private unit: number;
  private buffer = '';
  private on = false;
  private markStart: number | null = null; // начало текущей (или дозвучавшей) метки
  private markEnd: number | null = null;   // конец метки, ждущий анти-дребезговой финализации
  private lastEdge: number | null = null;  // конец последней НАСТОЯЩЕЙ метки
  private wordEmitted = true;
  private marks: number[] = [];

  constructor(initialUnitMs = 60) {
    this.unit = clampUnit(initialUnitMs);
  }

  get unitMs(): number {
    return this.unit;
  }

  get currentCode(): string {
    return this.buffer;
  }

  get signalOn(): boolean {
    return this.on;
  }

  // Re-seed the speed estimate (e.g. user moved the WPM slider).
  setUnitMs(ms: number): void {
    this.unit = clampUnit(ms);
    this.marks = [];
  }

  signal(nowOn: boolean, t: number): MorseEvent[] {
    if (nowOn === this.on) return [];
    const events: MorseEvent[] = [];
    if (nowOn) {
      if (this.markEnd !== null && t - this.markEnd < GLITCH_MERGE_MS) {
        // Дребезг: тон вернулся почти сразу — продолжаем ту же метку.
        this.markEnd = null;
      } else {
        // Тишина действительно кончилась: финализировать хвост и паузы.
        events.push(...this.tick(t));
        this.markStart = t;
      }
    } else {
      this.markEnd = t; // элемент эмитится в tick, когда дребезг исключён
    }
    this.on = nowOn;
    return events;
  }

  tick(t: number): MorseEvent[] {
    if (this.on) return [];
    const events: MorseEvent[] = [];
    if (this.markEnd !== null && t - this.markEnd >= GLITCH_MERGE_MS) {
      const dur = this.markEnd - (this.markStart ?? this.markEnd);
      if (dur >= MIN_MARK_UNITS * this.unit) {
        const element = this.classifyAndAdapt(dur);
        this.buffer += element;
        this.wordEmitted = false;
        this.lastEdge = this.markEnd;
        events.push({ kind: 'element', element, code: this.buffer });
      }
      // Осколок короче порога выбрасываем: lastEdge не трогаем, паузы идут
      // от конца последней настоящей метки.
      this.markStart = null;
      this.markEnd = null;
    }
    // Пока метка не финализирована, «пауза» не подтверждена — иначе паузы
    // меряются от устаревшего lastEdge и буква коммитится прямо поверх метки.
    if (this.markEnd !== null || this.lastEdge === null) return events;
    const gap = t - this.lastEdge;
    if (this.buffer && gap > LETTER_GAP_UNITS * this.unit) {
      events.push({ kind: 'letter', code: this.buffer, char: decodeCode(this.buffer) });
      this.buffer = '';
    }
    if (!this.buffer && !this.wordEmitted && gap > WORD_GAP_UNITS * this.unit) {
      events.push({ kind: 'word' });
      this.wordEmitted = true;
    }
    return events;
  }

  private classifyAndAdapt(dur: number): '.' | '-' {
    if (dur > Math.min(JUNK_UNITS * this.unit, MAX_MARK_MS)) return '-';
    if (dur < ADAPT_MIN_UNITS * this.unit) return '.';
    this.marks.push(dur);
    if (this.marks.length > WINDOW) this.marks.shift();
    const mn = Math.min(...this.marks);
    const mx = Math.max(...this.marks);
    if (mx / mn > CLUSTER_RATIO) {
      const threshold = Math.sqrt(mn * mx);
      const dots = this.marks.filter((m) => m < threshold);
      // Одиночная «точка» не пере-оценивает юнит: это может быть осколок
      // дребезга (реальный случай: фрагмент 105 мс у пищалки утащил оценку
      // с 240 на 105 и рассыпал всё сообщение).
      if (dots.length >= 2) {
        const avgDot = dots.reduce((a, b) => a + b, 0) / dots.length;
        this.unit = clampUnit(this.unit + 0.5 * (avgDot - this.unit));
      }
      return dur < threshold ? '.' : '-';
    }
    // Ambiguous window: trust the current unit, drift toward the closer reading.
    const candidate = Math.abs(dur - this.unit) < Math.abs(dur / 3 - this.unit) ? dur : dur / 3;
    this.unit = clampUnit(this.unit + 0.25 * (candidate - this.unit));
    return dur < 2 * this.unit ? '.' : '-';
  }
}

function clampUnit(ms: number): number {
  return Math.min(MAX_UNIT, Math.max(MIN_UNIT, ms));
}
