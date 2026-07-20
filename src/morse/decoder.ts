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
import { LETTER_GAP_UNITS } from './timing';

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
// Адаптация порога пауз: реверберация/инерция гейта растягивают метки и на
// столько же СЖИМАЮТ паузы (TEST DMITRY MAMA1.wav: буквенная пауза 240 мс
// измерялась как ~175 при пороге 2×unit≈194 — буквы сливались). Окно
// последних пауз кластеризуется так же, как метки: порог буквы — геом.
// среднее средних кластеров, словесный порог — ×2.5 буквенного (5u/2u).
const GAP_WINDOW = 10;
const GAP_CLUSTER_MIN_RATIO = 1.8; // элемент:буква — учебные 1:3, сжатые ~1:2.5
const WORD_PER_LETTER = 2.5;

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
  private gaps: number[] = [];

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
    this.gaps = [];
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
        // Пауза перед этой меткой подтвердилась — учим пороги пауз (кроме
        // словесных: они дали бы третий кластер).
        if (this.lastEdge !== null && this.markStart !== null) {
          const gapBefore = this.markStart - this.lastEdge;
          if (gapBefore > 0 && gapBefore < WORD_PER_LETTER * this.letterGapMs()) {
            this.gaps.push(gapBefore);
            if (this.gaps.length > GAP_WINDOW) this.gaps.shift();
          }
        }
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
    const letterThr = this.letterGapMs();
    if (this.buffer && gap > letterThr) {
      events.push({ kind: 'letter', code: this.buffer, char: decodeCode(this.buffer) });
      this.buffer = '';
    }
    if (!this.buffer && !this.wordEmitted && gap > WORD_PER_LETTER * letterThr) {
      events.push({ kind: 'word' });
      this.wordEmitted = true;
    }
    return events;
  }

  // Порог буквенной паузы: по кластерам измеренных пауз (элементные против
  // буквенных), пока их нет — учебные 2 юнита. Кластерам верим только когда
  // они опрятные: по ≥3 паузы в каждом (у дребезжащей пищалки SOS3 пары
  // {50,105}/{395,860} набирались из перемешанных элементных и буквенных
  // пауз и резали букву O пополам), внутренний разброс ≤2.2× (элементные
  // паузы SOS3 гуляют 30–395 мс — такие кластеры ложные) и порог не ниже
  // 0.7×юнита (защита от разреза внутри элементных пауз).
  private letterGapMs(): number {
    const split = splitDurations(this.gaps);
    if (split !== null && split.short.length >= 3 && split.long.length >= 3
        && split.avgLong / split.avgShort >= GAP_CLUSTER_MIN_RATIO
        && split.gap >= CLUSTER_MIN_GAP
        && tight(split.short) && tight(split.long)) {
      const thr = Math.sqrt(split.avgShort * split.avgLong);
      if (thr >= 0.7 * this.unit) return thr;
    }
    return LETTER_GAP_UNITS * this.unit;
  }

  private classifyAndAdapt(dur: number): '.' | '-' {
    if (dur > Math.min(JUNK_UNITS * this.unit, MAX_MARK_MS)) return '-';
    if (dur < ADAPT_MIN_UNITS * this.unit) return '.';
    this.marks.push(dur);
    if (this.marks.length > WINDOW) this.marks.shift();
    const split = splitDurations(this.marks);
    if (split !== null && isTwoClusters(split)) {
      const threshold = Math.sqrt(split.avgShort * split.avgLong);
      // Одиночная «точка» не пере-оценивает юнит: это может быть осколок
      // дребезга (реальный случай: фрагмент 105 мс у пищалки утащил оценку
      // с 240 на 105 и рассыпал всё сообщение).
      if (split.short.length >= 2) {
        this.unit = clampUnit(this.unit + 0.5 * (split.avgShort - this.unit));
        // Отношение тире/точки учим только на чистых окнах (≥2 метки в
        // каждом кластере) — одиночный выброс не задаёт ложное отношение.
        if (split.long.length >= 2) {
          this.ratio = clampRatio(this.ratio + RATIO_EMA * (split.avgLong / split.avgShort - this.ratio));
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

// Разбиение окна длительностей (меток ИЛИ пауз) на два кластера: сортировка
// и разрез по максимальному относительному скачку между соседями. Пороги
// считаются по СРЕДНИМ кластеров — они устойчивее min/max к выбросам
// (осколки и склейки не тянут порог).
interface ClusterSplit {
  short: number[];
  long: number[];
  avgShort: number;
  avgLong: number;
  gap: number; // относительный скачок в точке разреза
}

function splitDurations(durations: number[]): ClusterSplit | null {
  if (durations.length < 2) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  let cut = 1;
  let gap = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const r = sorted[i + 1] / sorted[i];
    if (r > gap) {
      gap = r;
      cut = i + 1;
    }
  }
  const short = sorted.slice(0, cut);
  const long = sorted.slice(cut);
  return { short, long, avgShort: avg(short), avgLong: avg(long), gap };
}

function isTwoClusters(s: ClusterSplit): boolean {
  const ratio = s.avgLong / s.avgShort;
  if (ratio > CLUSTER_RATIO) return true;
  return s.short.length >= 2 && s.long.length >= 2 && ratio >= CLUSTER_MIN_RATIO && s.gap >= CLUSTER_MIN_GAP;
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// «Опрятный» кластер: внутренний разброс не больше 2.2× (иначе это свалка).
function tight(xs: number[]): boolean {
  return Math.max(...xs) / Math.min(...xs) <= 2.2;
}

function clampUnit(ms: number): number {
  return Math.min(MAX_UNIT, Math.max(MIN_UNIT, ms));
}

function clampRatio(r: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}
