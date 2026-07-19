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

const FLOOR_FALL = 0.5;    // floor chases quiet frames fast…
const FLOOR_RISE = 0.01;   // …and creeps up very slowly
const PEAK_RISE = 0.5;     // peak chases loud frames fast…
const PEAK_FALL = 0.002;   // …and decays very slowly
const MIN_SNR_DB = 12;     // below this spread there is no signal at all
// Пороги почти симметричны относительно середины фронта FFT-магнитуды: тогда
// удлинение метки на включении компенсируется удлинением на выключении и
// измеренные длительности близки к реальным. Зазор 12% — гистерезис.
const ON_FRAC = 0.5;       // turn on above floor + 50% of the spread
const OFF_FRAC = 0.38;     // turn off below floor + 38%

export class EnvelopeGate {
  private floor: number;
  private peak: number;
  private state = false;
  // Until the first frame arrives, floor/peak hold a placeholder: anchoring
  // to the first real frame keeps a too-low initial floor from turning the
  // ambient noise level itself into "signal".
  private anchored = false;

  constructor(initialDb = -90) {
    this.floor = initialDb;
    this.peak = initialDb;
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
    this.floor += (levelDb - this.floor) * (levelDb < this.floor ? FLOOR_FALL : FLOOR_RISE);
    this.peak += (levelDb - this.peak) * (levelDb > this.peak ? PEAK_RISE : PEAK_FALL);

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

// Полный детектор сигнала: амплитудный гейт И тональность.
export class SignalGate {
  private amp = new EnvelopeGate();
  private tonal = false;
  private prevHz = -1e9;

  get isOn(): boolean {
    return this.amp.isOn && this.tonal;
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
    return this.amp.update(frame.levelDb) && this.tonal;
  }
}
