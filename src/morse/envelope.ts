// Amplitude gate: turns a stream of per-frame band levels (dB) into clean
// tone-on/tone-off decisions. Tracks noise floor and signal peak adaptively,
// switches with hysteresis so flutter near the threshold does not chatter.
// Pure — the mic layer polls the analyser and feeds levels in.

// Кадр спектрального анализа (готовит src/analysis/spectrum.ts): пик в
// CW-полосе, его превышение над медианой полосы и частота пика. Опционально —
// весь спектр полосы (bandDb от bandStartHz с шагом bandStepHz): с ним гейт
// после захвата несущей меряет сигнал прямо НА ней (когерентный детектор),
// и громкий шум на других частотах не рвёт метки и не рождает ложных.
export interface SpectralFrame {
  levelDb: number;
  contrastDb: number;
  peakHz: number;
  bandDb?: number[];
  bandStartHz?: number;
  bandStepHz?: number;
}

// Кадровые EMA-коэффициенты откалиброваны на опросе раз в 15 мс; при другом
// хопе пересчитываются на эквивалент по ВРЕМЕНИ (1-(1-α)^(hop/15)), иначе
// хоп 5 мс втрое ускоряет посекундную адаптацию и пол съедает длинное тире.
const REF_HOP_MS = 15;
const FLOOR_FALL = 0.5;    // floor chases quiet frames fast…
const FLOOR_RISE = 0.01;   // …and creeps up very slowly
const PEAK_RISE = 0.5;     // peak chases loud frames fast…
const PEAK_FALL = 0.002;   // …and decays very slowly
const MIN_SNR_DB = 12;     // below this spread there is no signal at all

function alphaForHop(alphaRef: number, hopMs: number): number {
  return 1 - Math.pow(1 - alphaRef, hopMs / REF_HOP_MS);
}
// Пороги почти симметричны относительно ~57% фронта FFT-магнитуды: удлинение
// метки на включении компенсируется на выключении, измеренные длительности
// близки к реальным. Зазор 15% — гистерезис. Порог включения поднят до 65%
// размаха сознательно: тихая «возня» с ключом перед посылкой (реальные
// записи samples/) сидит около половины размаха и при пороге 50% лезла в
// декодер дот-масштабными склейками.
const ON_FRAC = 0.65;      // turn on above floor + 65% of the spread
const OFF_FRAC = 0.5;      // turn off below floor + 50%

export class EnvelopeGate {
  private floor: number;
  private peak: number;
  private state = false;
  // Until the first frame arrives, floor/peak hold a placeholder: anchoring
  // to the first real frame keeps a too-low initial floor from turning the
  // ambient noise level itself into "signal".
  private anchored = false;
  private floorFall: number;
  private floorRise: number;
  private peakRise: number;
  private peakFall: number;

  constructor(initialDb = -90, hopMs = REF_HOP_MS) {
    this.floor = initialDb;
    this.peak = initialDb;
    this.floorFall = alphaForHop(FLOOR_FALL, hopMs);
    this.floorRise = alphaForHop(FLOOR_RISE, hopMs);
    this.peakRise = alphaForHop(PEAK_RISE, hopMs);
    this.peakFall = alphaForHop(PEAK_FALL, hopMs);
  }

  get isOn(): boolean {
    return this.state;
  }

  // Diagnostic for the UI level meter: 0..1 position between floor and peak.
  get spreadDb(): number {
    return this.peak - this.floor;
  }

  normalize(levelDb: number): number {
    const spread = Math.max(1, this.peak - this.floor);
    return Math.min(1, Math.max(0, (levelDb - this.floor) / spread));
  }

  // Feed one frame; returns the (possibly unchanged) gate state.
  // noiseDb — отдельная опора для пола (у когерентного детектора сигнал —
  // бин несущей, а шум — пик полосы: в паузах бин несущей проваливается
  // сильно ниже фона, пол оседал за ним и пороги съезжали — метки
  // растягивались и микро-паузы пищалок уходили под анти-дребезг).
  update(levelDb: number, noiseDb = levelDb): boolean {
    if (!this.anchored) {
      this.floor = noiseDb;
      this.peak = levelDb;
      this.anchored = true;
    }
    this.floor += (noiseDb - this.floor) * (noiseDb < this.floor ? this.floorFall : this.floorRise);
    this.peak += (levelDb - this.peak) * (levelDb > this.peak ? this.peakRise : this.peakFall);

    const spread = this.peak - this.floor;
    if (spread < MIN_SNR_DB) {
      this.state = false;
      return this.state;
    }
    const onThr = this.floor + ON_FRAC * spread;
    const offThr = this.floor + OFF_FRAC * spread;
    if (!this.state && levelDb > onThr) this.state = true;
    else if (this.state && levelDb < offThr) this.state = false;
    return this.state;
  }
}

// Тональность: у синусоиды пик спектра стоит на месте и возвышается над
// медианой полосы на десятки дБ; у шума/речи контраст мал, а пик скачет по
// частоте. Гистерезис — чтобы кадры на фронтах (окно частично захватило тон)
// не рвали метку.
const TONAL_ON_DB = 12;   // включение: пик над медианой минимум на 12 дБ…
const TONAL_OFF_DB = 7;   // …выключение — когда контраст упал ниже 7 дБ
const STABLE_HZ = 80;     // и частота пика между кадрами гуляет не больше этого

// Автозахват несущей: после первых посылок частота отправителя запоминается,
// тональные помехи на других частотах игнорируются. Новая несущая должна
// продержаться стабильно RELOCK_MS (~0.4 с) — тогда перезахват; после долгой
// тишины захват отпускается. Выдержки — в МИЛЛИСЕКУНДАХ и пересчитываются в
// кадры по хопу конструктора: смена хопа не должна тихо менять времена.
const LOCK_TOL_HZ = 150;
const RELOCK_MS = 400;
// Кандидатура перезахвата копится только когда захваченная несущая молчит
// дольше этого (длиннее словесной паузы на 5 WPM ≈ 1.7 с): громкий гул в
// обычных паузах крал замок и настоящий сигнал резался как «чужой»
// (реальная запись TEST DMITRY MAMA1.wav).
const RELOCK_IDLE_MS = 2500;
const LOCK_TTL_MS = 20000;  // ~20 с тишины — забываем несущую
// Замок ставится только после ~120 мс подряд стабильных кадров НЕПРЕРЫВНОГО
// тона: осколки «возни» (у пьезо-пищалок их пик бывает на гармонике!) короче
// и не успевают, а до установления замка гейт ничего не режет.
const LOCK_MIN_MS = 120;
const LOCK_HZ_EMA = 0.2; // сглаживание захваченной частоты (на REF_HOP_MS)
// Миграция замка внутри ТОГО ЖЕ сигнала: на онсете пик у пьезо бывает на
// гармонике — замок встаёт туда, а основная компонента громче на плато.
// Если во время метки пик полосы стабильно громче бина замка на этот запас,
// ~LOCK_MIN_MS подряд — переезжаем (это не «чужой» сигнал: перезахват чужих
// блокируется idle-защитой, а здесь бин замка сам активен).
const HARMONIC_MARGIN_DB = 8;

// Полный детектор сигнала: амплитудный гейт И тональность И захват несущей.
export class SignalGate {
  private amp: EnvelopeGate;
  private tonal = false;
  private prevHz = -1e9;
  private state = false;
  private lockHz: number | null = null;
  private idleFrames = 0;
  private candHz = -1e9;
  private candFrames = 0;
  private pendHz = -1e9;
  private pendFrames = 0;
  private strongHz = -1e9;
  private strongFrames = 0;
  private relockFrames: number;
  private relockIdleFrames: number;
  private lockTtlFrames: number;
  private lockMinFrames: number;
  private lockEma: number;

  constructor(hopMs = REF_HOP_MS) {
    this.amp = new EnvelopeGate(-90, hopMs);
    this.relockFrames = Math.max(1, Math.round(RELOCK_MS / hopMs));
    this.relockIdleFrames = Math.max(1, Math.round(RELOCK_IDLE_MS / hopMs));
    this.lockTtlFrames = Math.max(1, Math.round(LOCK_TTL_MS / hopMs));
    this.lockMinFrames = Math.max(1, Math.round(LOCK_MIN_MS / hopMs));
    this.lockEma = alphaForHop(LOCK_HZ_EMA, hopMs);
  }

  get isOn(): boolean {
    return this.state;
  }

  // Захваченная несущая для UI (null — ещё не поймана).
  get carrierHz(): number | null {
    return this.lockHz;
  }

  normalize(levelDb: number): number {
    return this.amp.normalize(levelDb);
  }

  // Мощность в БЛИЖАЙШЕМ к несущей бине — null, если замка нет или кадр
  // пришёл без спектра полосы (синтетические тесты, старый формат).
  // Именно ближайший бин, не max(±1): «призрак» гула в соседнем бине через
  // максимум давал ON в паузах и утаскивал замок EMA-дрейфом (584→556 на
  // TEST DMITRY MAMA1.wav); несущая точно между бинами теряет максимум 3 дБ
  // — адаптивный амплитудный гейт это переживает.
  private lockBin(frame: SpectralFrame): { db: number; hz: number } | null {
    if (this.lockHz === null || frame.bandDb === undefined
        || frame.bandStartHz === undefined || frame.bandStepHz === undefined) return null;
    const { bandDb, bandStartHz, bandStepHz } = frame;
    const mid = Math.min(
      bandDb.length - 1,
      Math.max(0, Math.round((this.lockHz - bandStartHz) / bandStepHz)),
    );
    return { db: bandDb[mid], hz: bandStartHz + mid * bandStepHz };
  }

  update(frame: SpectralFrame): boolean {
    const stable = Math.abs(frame.peakHz - this.prevHz) <= STABLE_HZ;
    this.prevHz = frame.peakHz;
    const lockBin = this.lockBin(frame);
    if (lockBin !== null) {
      // КОГЕРЕНТНЫЙ детектор: несущая захвачена и спектр полосы доступен —
      // сигнал меряется на самой несущей (±1 бин). Пик полосы дальше нужен
      // только кандидату на перезахват; громкий гул на других частотах не
      // влияет ни на амплитуду, ни на тональность.
      const median = frame.levelDb - frame.contrastDb;
      const contrast = lockBin.db - median;
      this.tonal = this.tonal ? contrast > TONAL_OFF_DB : contrast > TONAL_ON_DB;
      // Пол — по пику полосы (фон), решение — по бину несущей (сигнал).
      const on = this.amp.update(lockBin.db, frame.levelDb) && this.tonal;
      if (on) {
        this.lockHz = (this.lockHz ?? lockBin.hz) + this.lockEma * (lockBin.hz - (this.lockHz ?? lockBin.hz));
        // Пик стабильно и намного громче бина замка на другой частоте —
        // мы залочились на слабую гармонику; переехать на основную.
        if (stable && frame.levelDb - lockBin.db > HARMONIC_MARGIN_DB
            && Math.abs(frame.peakHz - (this.lockHz ?? 0)) > LOCK_TOL_HZ) {
          if (Math.abs(frame.peakHz - this.strongHz) <= STABLE_HZ) this.strongFrames++;
          else {
            this.strongHz = frame.peakHz;
            this.strongFrames = 1;
          }
          if (this.strongFrames >= this.lockMinFrames) {
            this.lockHz = frame.peakHz;
            this.strongFrames = 0;
          }
        } else {
          this.strongFrames = 0;
        }
        this.idleFrames = 0;
        this.candFrames = 0;
      } else {
        this.strongFrames = 0;
        // Чужой стабильный тон — кандидат на перезахват, но только после
        // долгого молчания своей несущей (см. RELOCK_IDLE_MS).
        const alien = Math.abs(frame.peakHz - (this.lockHz ?? 0)) > LOCK_TOL_HZ;
        if (alien && stable && frame.contrastDb > TONAL_ON_DB
            && this.idleFrames >= this.relockIdleFrames) {
          if (Math.abs(frame.peakHz - this.candHz) <= STABLE_HZ) this.candFrames++;
          else {
            this.candHz = frame.peakHz;
            this.candFrames = 1;
          }
          if (this.candFrames >= this.relockFrames) {
            this.lockHz = frame.peakHz;
            this.candFrames = 0;
          }
        }
        if (++this.idleFrames > this.lockTtlFrames) {
          this.lockHz = null;
          this.idleFrames = 0;
        }
      }
      this.state = on;
      return on;
    }
    // Стабильность нужна и для УДЕРЖАНИЯ: иначе одно случайное совпадение
    // частот соседних кадров шума/речи защёлкивает тональность, а гистерезис
    // по контрасту её больше не отпускает.
    this.tonal = stable && (this.tonal
      ? frame.contrastDb > TONAL_OFF_DB
      : frame.contrastDb > TONAL_ON_DB);
    let on = this.amp.update(frame.levelDb) && this.tonal;
    if (on && this.lockHz !== null && Math.abs(frame.peakHz - this.lockHz) > LOCK_TOL_HZ) {
      // Тон на чужой частоте: не сигнал. Кандидат на перезахват — только
      // когда СВОЯ несущая молчит дольше словесной паузы: иначе громкая
      // помеха в обычных паузах крадёт замок у живого отправителя.
      if (this.idleFrames >= this.relockIdleFrames) {
        if (Math.abs(frame.peakHz - this.candHz) <= STABLE_HZ) this.candFrames++;
        else {
          this.candHz = frame.peakHz;
          this.candFrames = 1;
        }
      } else {
        this.candFrames = 0;
      }
      if (this.candFrames >= this.relockFrames) {
        this.lockHz = frame.peakHz;
        this.candFrames = 0;
      } else {
        on = false;
      }
    }
    if (on) {
      if (this.lockHz === null) {
        if (Math.abs(frame.peakHz - this.pendHz) <= STABLE_HZ) this.pendFrames++;
        else {
          this.pendHz = frame.peakHz;
          this.pendFrames = 1;
        }
        if (this.pendFrames >= this.lockMinFrames) this.lockHz = frame.peakHz;
      } else {
        this.lockHz += this.lockEma * (frame.peakHz - this.lockHz);
      }
      this.idleFrames = 0;
    } else {
      this.pendFrames = 0;
      this.pendHz = -1e9;
      if (this.lockHz !== null && ++this.idleFrames > this.lockTtlFrames) {
        this.lockHz = null;
        this.idleFrames = 0;
      }
    }
    this.state = on;
    return on;
  }
}
