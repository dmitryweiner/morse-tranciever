// Передача по тексту: автомат отстукивает строку точными PARIS-таймингами
// (точка 1u, тире 3u; паузы: элемент 1u, буква 3u, слово 7u). Как PaddleKeyer,
// ВНУТРИ — обычный Keyer с синтетическими keyDown/keyUp: классификация,
// буквенные/словесные паузы и формат событий полностью общие с ручными
// режимами. Чистый модуль — время параметром, тестируется скриптово.
// Неизвестные символы (и пробелы) дают словесную паузу.

import { Keyer } from './keyer';
import { MORSE, isElement, type MorseElement, type MorseEvent } from './code';

export class TextSender {
  private keyer: Keyer;
  private text = '';
  private charIdx = 0; // индекс звучащей буквы в исходной строке (для подсветки)
  private elems: MorseElement[] = []; // остаток элементов текущей буквы
  private pendingIdx: number | null = null; // буква, стартующая в nextAt
  private playingUntil: number | null = null;
  private nextAt: number | null = null; // раньше этого времени элемент не стартует
  private sending = false;
  private tone = false;

  constructor(private getUnitMs: () => number) {
    this.keyer = new Keyer(getUnitMs);
  }

  // Тон ведётся отсюда: main сверяет флаг после каждого tick и рулит Sidetone.
  get isToneOn(): boolean {
    return this.tone;
  }

  get isSending(): boolean {
    return this.sending;
  }

  // Индекс буквы исходной строки, которая передаётся сейчас (для подсветки).
  get currentIndex(): number | null {
    return this.sending ? this.charIdx : null;
  }

  start(text: string, t: number): MorseEvent[] {
    this.stop();
    this.text = text;
    const first = this.findLetter(0);
    if (first === null) return [];
    this.sending = true;
    this.beginLetter(first.idx); // словесная пауза перед первой буквой не нужна
    return this.tick(t);
  }

  // Обрыв посылки (нажатие ключа/смена режима): тон гаснет, недобитая буква
  // отбрасывается (keyer.reset), событий не остаётся.
  stop(): void {
    this.keyer.reset();
    this.text = '';
    this.elems = [];
    this.pendingIdx = null;
    this.playingUntil = null;
    this.nextAt = null;
    this.sending = false;
    this.tone = false;
  }

  tick(t: number): MorseEvent[] {
    if (!this.sending) return [];
    const events: MorseEvent[] = [];
    if (this.playingUntil !== null) {
      if (t < this.playingUntil) return events;
      // Элемент дозвучал: keyUp точным временем конца, планируем паузу.
      events.push(...this.keyer.keyUp(this.playingUntil));
      this.tone = false;
      const unit = this.getUnitMs();
      if (this.elems.length > 0) {
        this.nextAt = this.playingUntil + unit;
      } else {
        const next = this.findLetter(this.charIdx + 1);
        if (next === null) {
          this.nextAt = null; // строка кончилась — осталось закоммитить букву
        } else {
          this.nextAt = this.playingUntil + (next.wordGap ? 7 : 3) * unit;
          this.pendingIdx = next.idx;
        }
      }
      this.playingUntil = null;
    }
    if (this.nextAt !== null && t < this.nextAt) {
      // Пауза идёт: буква/слово коммитятся керером по своим порогам.
      events.push(...this.keyer.tick(t));
      return events;
    }
    if (this.elems.length === 0) {
      if (this.pendingIdx === null) {
        // Очередь пуста: дотикиваем до коммита последней буквы и выходим
        // (словесную паузу в конце посылки не досиживаем).
        const drained = this.keyer.tick(t);
        events.push(...drained);
        if (drained.some((e) => e.kind === 'letter')) this.sending = false;
        return events;
      }
      this.beginLetter(this.pendingIdx);
      this.pendingIdx = null;
    }
    const el = this.elems.shift();
    if (el === undefined) return events; // не бывает: beginLetter кладёт ≥1 элемент
    events.push(...this.keyer.keyDown(t)); // внутри дотикает зависшую букву
    this.playingUntil = t + (el === '.' ? 1 : 3) * this.getUnitMs();
    this.nextAt = null;
    this.tone = true;
    return events;
  }

  private beginLetter(idx: number): void {
    this.charIdx = idx;
    const code = MORSE[this.text[idx].toUpperCase()] ?? '';
    this.elems = [...code].filter(isElement);
  }

  // Ближайшая известная буква от позиции from; wordGap — встретился ли по
  // дороге пробел/неизвестный символ (они дают словесную паузу).
  private findLetter(from: number): { idx: number; wordGap: boolean } | null {
    let wordGap = false;
    for (let i = from; i < this.text.length; i++) {
      if (MORSE[this.text[i].toUpperCase()] !== undefined) return { idx: i, wordGap };
      wordGap = true;
    }
    return null;
  }
}
