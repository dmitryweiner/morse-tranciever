// Электронный ключ (paddle): кнопки задают ЭЛЕМЕНТ, а длительности генерирует
// автомат точно по текущему WPM (точка — 1 юнит, тире — 3, пауза между
// элементами — 1). Удержание кнопки повторяет элемент, как у настоящих
// электронных ключей; зажаты обе — элементы чередуются (ямбический режим).
// Внутри — обычный Keyer: ему скармливаются синтетические keyDown/keyUp с
// точными временами, так что классификация, буквенные/словесные паузы и
// формат событий полностью общие со straight-режимом.

import { Keyer } from './keyer';
import type { MorseElement, MorseEvent } from './code';

export class PaddleKeyer {
  private keyer: Keyer;
  private held: MorseElement[] = []; // в порядке нажатия
  // Память на один элемент (как dot/dash memory у настоящих ключей): тап во
  // время звучащего элемента или межэлементной паузы не теряется.
  private memory: MorseElement | null = null;
  private playingUntil: number | null = null;
  private gapUntil: number | null = null;
  private lastElement: MorseElement | null = null;
  private tone = false;

  constructor(private getUnitMs: () => number) {
    this.keyer = new Keyer(getUnitMs);
  }

  // Тон ведётся отсюда: main сверяет флаг после каждого tick и рулит Sidetone.
  get isToneOn(): boolean {
    return this.tone;
  }

  press(element: MorseElement, t: number): MorseEvent[] {
    if (!this.held.includes(element)) this.held.push(element);
    if (this.playingUntil !== null || (this.gapUntil !== null && t < this.gapUntil)) {
      this.memory = element;
    }
    return this.tick(t); // элемент стартует сразу, без ожидания цикла
  }

  release(element: MorseElement): void {
    this.held = this.held.filter((e) => e !== element);
  }

  releaseAll(): void {
    this.held = [];
  }

  reset(): void {
    this.keyer.reset();
    this.held = [];
    this.memory = null;
    this.playingUntil = null;
    this.gapUntil = null;
    this.lastElement = null;
    this.tone = false;
  }

  tick(t: number): MorseEvent[] {
    const events: MorseEvent[] = [];
    if (this.playingUntil !== null && t >= this.playingUntil) {
      // Элемент дозвучал: keyUp точным временем конца, дальше — пауза 1 юнит.
      events.push(...this.keyer.keyUp(this.playingUntil));
      this.gapUntil = this.playingUntil + this.getUnitMs();
      this.playingUntil = null;
      this.tone = false;
    }
    if (this.playingUntil === null) {
      const ready = this.gapUntil === null || t >= this.gapUntil;
      const element = ready
        ? this.memory ?? (this.held.length ? this.pickElement() : null)
        : null;
      if (element !== null) {
        this.memory = null;
        events.push(...this.keyer.keyDown(t));
        this.playingUntil = t + (element === '.' ? 1 : 3) * this.getUnitMs();
        this.gapUntil = null;
        this.lastElement = element;
        this.tone = true;
      } else {
        events.push(...this.keyer.tick(t));
      }
    }
    return events;
  }

  private pickElement(): MorseElement {
    // Обе зажаты — чередование (ямбический squeeze: «di-dah-di-dah…»).
    if (this.held.length === 2 && this.lastElement !== null) {
      return this.lastElement === '.' ? '-' : '.';
    }
    return this.held[0];
  }
}
