// RX decoder: turns tone on/off edges (timestamps in ms) into Morse events,
// auto-adapting to the sender's speed. Pure — the mic layer feeds it edges.
//
// Adaptation: a sliding window of recent mark durations, split into two
// clusters at the largest relative jump. When the clusters are credible, the
// dot/dash threshold is the geometric mean of the CLUSTER MEANS (robust to
// outliers), the unit re-estimates from the dot cluster, and the dash/dot
// ratio is learned too — real beepers squeeze dashes to ~1.9× a dot instead
// of the textbook 3× (samples/TEST.wav). When all marks look alike (only
// dots or only dashes so far), the current unit estimate decides, nudged
// toward whichever reading (all-dots / all-dashes at the learned ratio) is
// closer to it. The first letter of a transmission at a wildly different
// speed may garble — inherent to any adaptive CW decoder.

import { decodeCode, type MorseEvent } from './code';
import { LETTER_GAP_UNITS, WORD_GAP_UNITS } from './timing';

const WINDOW = 12;          // recent marks kept for clustering
// Разрыв СРЕДНИХ кластеров, при котором тире и точки несомненны даже по
// двум меткам (учебное 3:1 проходит с запасом).
const CLUSTER_RATIO = 2.2;
// «Сжатые» пищалки (тире ~1.9 точки) разделяем осторожнее: только когда в
// каждом кластере ≥2 метки И скачок в точке разреза заметный — иначе дрожь
// ручной манипуляции внутри одного кластера рожает ложное разбиение.
const CLUSTER_MIN_RATIO = 1.5;
const CLUSTER_MIN_GAP = 1.4;
// Отношение тире/точки: дефолт учебный, диапазон реальных ключей/пищалок.
const RATIO_DEFAULT = 3;
const RATIO_MIN = 1.5;
const RATIO_MAX = 4;
const RATIO_EMA = 0.25;
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
// Склейка разрешена только к метке, которая УЖЕ тянет на элемент (≥0.45
// юнита): реальный дребезг — мерцающий хвост большой метки. Град осколков
// 5–45 мс «возни» перед посылкой (виден на хопе 5 мс, samples/TEST*.wav)
// иначе сшивается в псевдо-метку точечного масштаба и родит ложную букву.
const GLITCH_MERGE_MS = 25;
// Метка короче 0.45 юнита — осколок дребезга/возни: не элемент, не адаптирует
// и не сдвигает таймер пауз. Реальная точка — 1 юнит; у вдвое быстрого
// отправителя (предел трекинга) — 0.5 юнита, так что запас остаётся.
// Порог поднят с 0.35 по реальным записям: склейки «возни» перед посылкой
// (~0.4 юнита) прилипали к первому тире и рожали ложные буквы.
const MIN_MARK_UNITS = 0.45;
// Метки короче этого же порога не участвуют и в адаптации: псевдо-точки
// дребезга парой формировали ложный кластер и обваливали оценку юнита
// (реальный случай: samples/SOS2.wav, 240 → 82 мс).
const ADAPT_MIN_UNITS = 0.45;

export class AdaptiveDecoder {
  private unit: number;
  private ratio = RATIO_DEFAULT; // оценка avgDash/avgDot текущего отправителя
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

  get dashDotRatio(): number {
    return this.ratio;
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
    this.ratio = RATIO_DEFAULT;
    this.marks = [];
  }

  signal(nowOn: boolean, t: number): MorseEvent[] {
    if (nowOn === this.on) return [];
    const events: MorseEvent[] = [];
    if (nowOn) {
      const acc = this.markEnd === null ? 0 : this.markEnd - (this.markStart ?? this.markEnd);
      if (this.markEnd !== null && t - this.markEnd < GLITCH_MERGE_MS
          && acc >= MIN_MARK_UNITS * this.unit) {
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
    const split = splitMarks(this.marks);
    if (split !== null && isTwoClusters(split)) {
      const threshold = Math.sqrt(split.avgDot * split.avgDash);
      // Одиночная «точка» не пере-оценивает юнит: это может быть осколок
      // дребезга (реальный случай: фрагмент 105 мс у пищалки утащил оценку
      // с 240 на 105 и рассыпал всё сообщение).
      if (split.dots.length >= 2) {
        this.unit = clampUnit(this.unit + 0.5 * (split.avgDot - this.unit));
        // Отношение тире/точки учим только на чистых окнах (≥2 метки в
        // каждом кластере) — одиночный выброс не задаёт ложное отношение.
        if (split.dashes.length >= 2) {
          this.ratio = clampRatio(this.ratio + RATIO_EMA * (split.avgDash / split.avgDot - this.ratio));
        }
      }
      return dur < threshold ? '.' : '-';
    }
    // Ambiguous window: trust the current unit, drift toward the closer
    // reading — dur as a dot vs dur/ratio as a dash of this sender.
    const asDot = Math.abs(dur - this.unit) < Math.abs(dur / this.ratio - this.unit);
    this.unit = clampUnit(this.unit + 0.25 * ((asDot ? dur : dur / this.ratio) - this.unit));
    // Порог — геометрическая середина между точкой (1u) и тире (ratio·u).
    return dur < Math.sqrt(this.ratio) * this.unit ? '.' : '-';
  }
}

// Разбиение окна меток на два кластера: сортировка и разрез по максимальному
// относительному скачку между соседями. Пороги считаются по СРЕДНИМ кластеров
// — они устойчивее min/max к выбросам (осколки и склейки не тянут порог).
interface ClusterSplit {
  dots: number[];
  dashes: number[];
  avgDot: number;
  avgDash: number;
  gap: number; // относительный скачок в точке разреза
}

function splitMarks(marks: number[]): ClusterSplit | null {
  if (marks.length < 2) return null;
  const sorted = [...marks].sort((a, b) => a - b);
  let cut = 1;
  let gap = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const r = sorted[i + 1] / sorted[i];
    if (r > gap) {
      gap = r;
      cut = i + 1;
    }
  }
  const dots = sorted.slice(0, cut);
  const dashes = sorted.slice(cut);
  return { dots, dashes, avgDot: avg(dots), avgDash: avg(dashes), gap };
}

function isTwoClusters(s: ClusterSplit): boolean {
  const ratio = s.avgDash / s.avgDot;
  if (ratio > CLUSTER_RATIO) return true;
  return s.dots.length >= 2 && s.dashes.length >= 2 && ratio >= CLUSTER_MIN_RATIO && s.gap >= CLUSTER_MIN_GAP;
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clampUnit(ms: number): number {
  return Math.min(MAX_UNIT, Math.max(MIN_UNIT, ms));
}

function clampRatio(r: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}
