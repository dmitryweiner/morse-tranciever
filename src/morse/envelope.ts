// Amplitude gate: turns a stream of per-frame band levels (dB) into clean
// tone-on/tone-off decisions. Tracks noise floor and signal peak adaptively,
// switches with hysteresis so flutter near the threshold does not chatter.
// Pure — the mic layer polls the analyser and feeds levels in.

// Кадр спектрального анализа (готовит src/audio/mic.ts или офлайн-стенд):
// пик в CW-полосе, его превышение над медианой полосы и частота пика.
export interface SpectralFrame {
  levelDb: number;
  contrastDb: number;
  peakHz: number;
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
  update(levelDb: number): boolean {
    if (!this.anchored) {
      this.floor = levelDb;
      this.peak = levelDb;
      this.anchored = true;
    }
    this.floor += (levelDb - this.floor) * (levelDb < this.floor ? this.floorFall : this.floorRise);
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
const LOCK_TTL_MS = 20000;  // ~20 с тишины — забываем несущую
// Замок ставится только после ~120 мс подряд стабильных кадров НЕПРЕРЫВНОГО
// тона: осколки «возни» (у пьезо-пищалок их пик бывает на гармонике!) короче
// и не успевают, а до установления замка гейт ничего не режет.
const LOCK_MIN_MS = 120;
const LOCK_HZ_EMA = 0.2; // сглаживание захваченной частоты (на REF_HOP_MS)

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
  private relockFrames: number;
  private lockTtlFrames: number;
  private lockMinFrames: number;
  private lockEma: number;

  constructor(hopMs = REF_HOP_MS) {
    this.amp = new EnvelopeGate(-90, hopMs);
    this.relockFrames = Math.max(1, Math.round(RELOCK_MS / hopMs));
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

  update(frame: SpectralFrame): boolean {
    const stable = Math.abs(frame.peakHz - this.prevHz) <= STABLE_HZ;
    this.prevHz = frame.peakHz;
    // Стабильность нужна и для УДЕРЖАНИЯ: иначе одно случайное совпадение
    // частот соседних кадров шума/речи защёлкивает тональность, а гистерезис
    // по контрасту её больше не отпускает.
    this.tonal = stable && (this.tonal
      ? frame.contrastDb > TONAL_OFF_DB
      : frame.contrastDb > TONAL_ON_DB);
    let on = this.amp.update(frame.levelDb) && this.tonal;
    if (on && this.lockHz !== null && Math.abs(frame.peakHz - this.lockHz) > LOCK_TOL_HZ) {
      // Тон на чужой частоте: не сигнал, но кандидат на перезахват.
      if (Math.abs(frame.peakHz - this.candHz) <= STABLE_HZ) this.candFrames++;
      else {
        this.candHz = frame.peakHz;
        this.candFrames = 1;
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
