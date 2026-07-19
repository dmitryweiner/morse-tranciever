// TX sidetone: one always-running oscillator gated by a gain node. Key
// down/up ramp the gain over a few ms — a hard on/off would click.

import { IosAudioUnlock } from './iosUnlock';

const RAMP_S = 0.004;
const LEVEL = 0.5;

export class Sidetone {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private freq = 600;
  private readonly unlock = new IosAudioUnlock();

  // Must be called synchronously inside a user gesture (the first key press).
  ensure(): void {
    this.unlock.play();
    if (!this.ctx) {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = this.freq;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      this.ctx = ctx;
      this.osc = osc;
      this.gain = gain;
    }
    void this.ctx.resume();
  }

  setFrequency(hz: number): void {
    this.freq = hz;
    if (this.osc && this.ctx) {
      this.osc.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01);
    }
  }

  keyDown(): void {
    this.ensure();
    this.rampTo(LEVEL);
  }

  keyUp(): void {
    this.rampTo(0);
  }

  // Leaving TX mode: silence and release the audio session.
  release(): void {
    this.rampTo(0);
    this.unlock.stop();
    if (this.ctx) void this.ctx.suspend();
  }

  private rampTo(level: number): void {
    if (!this.ctx || !this.gain) return;
    const g = this.gain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(level, t + RAMP_S);
  }
}
