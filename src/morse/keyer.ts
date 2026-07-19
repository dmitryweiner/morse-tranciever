// TX state machine: turns raw key presses (down/up timestamps in ms) into
// Morse events. Pure — time is passed in, so tests script it precisely.
// tick() must be called periodically (rAF) to commit letters/word gaps.

import { decodeCode, type MorseEvent } from './code';
import { classifyMark, LETTER_GAP_UNITS, WORD_GAP_UNITS } from './timing';

export class Keyer {
  private buffer = '';
  private downAt: number | null = null;
  private upAt: number | null = null;
  // true until the next mark: blocks duplicate word gaps in one long silence.
  private wordEmitted = true;

  constructor(private getUnitMs: () => number) {}

  get currentCode(): string {
    return this.buffer;
  }

  get isDown(): boolean {
    return this.downAt !== null;
  }

  // Смена режима ключа/выход из TX: недобитая буква отбрасывается.
  reset(): void {
    this.buffer = '';
    this.downAt = null;
    this.upAt = null;
    this.wordEmitted = true;
  }

  keyDown(t: number): MorseEvent[] {
    // A stale letter may still be pending if ticks were sparse.
    const events = this.tick(t);
    this.downAt = t;
    this.upAt = null;
    return events;
  }

  keyUp(t: number): MorseEvent[] {
    if (this.downAt === null) return [];
    const element = classifyMark(t - this.downAt, this.getUnitMs());
    this.buffer += element;
    this.downAt = null;
    this.upAt = t;
    this.wordEmitted = false;
    return [{ kind: 'element', element, code: this.buffer }];
  }

  tick(t: number): MorseEvent[] {
    if (this.downAt !== null || this.upAt === null) return [];
    const gap = t - this.upAt;
    const unit = this.getUnitMs();
    const events: MorseEvent[] = [];
    if (this.buffer && gap > LETTER_GAP_UNITS * unit) {
      events.push({ kind: 'letter', code: this.buffer, char: decodeCode(this.buffer) });
      this.buffer = '';
    }
    if (!this.buffer && !this.wordEmitted && gap > WORD_GAP_UNITS * unit) {
      events.push({ kind: 'word' });
      this.wordEmitted = true;
    }
    return events;
  }
}
