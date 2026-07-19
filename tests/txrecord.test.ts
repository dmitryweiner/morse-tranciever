import { TxRecorder, renderToneWav, TX_REC_SAMPLE_RATE } from '../src/audio/txrecord';
import { encodeWAV } from '../src/audio/wav';
import { decodeWavPcm16, runRxChain } from '../src/analysis/wavlab';
import { MORSE } from '../src/morse/code';

describe('TxRecorder', () => {
  it('collects tone marks with their frequency', () => {
    const rec = new TxRecorder();
    rec.start(1000);
    rec.toneOn(1500, 600);
    rec.toneOff(1740);
    rec.toneOn(1820, 700); // сменили слайдер тона между метками
    rec.toneOff(1900);
    const marks = rec.stop(3000);
    expect(marks).toEqual([
      { startMs: 500, endMs: 740, hz: 600 }, // ноль сдвинут: 500 мс форшлага
      { startMs: 820, endMs: 900, hz: 700 },
    ]);
    expect(rec.recording).toBe(false);
  });

  it('trims a long idle wait before the first mark to the lead-in', () => {
    const rec = new TxRecorder();
    rec.start(0);
    rec.toneOn(30000, 600);
    rec.toneOff(30100);
    const marks = rec.stop(31000);
    expect(marks?.[0].startMs).toBe(500);
  });

  it('keeps a short natural lead-in as is', () => {
    const rec = new TxRecorder();
    rec.start(1000);
    rec.toneOn(1200, 600); // выстукивать начали через 200 мс — не растягиваем
    rec.toneOff(1300);
    expect(rec.stop(2000)?.[0].startMs).toBe(200);
  });

  it('ignores unbalanced calls and closes a hanging tone at stop', () => {
    const rec = new TxRecorder();
    rec.toneOn(500, 600); // до start — игнор
    rec.start(1000);
    rec.toneOff(1100);    // без toneOn — игнор
    rec.toneOn(1200, 600);
    rec.toneOn(1300, 700); // повторный toneOn — игнор
    const marks = rec.stop(1500); // тон ещё звучит — закрывается временем стопа
    expect(marks).toEqual([{ startMs: 200, endMs: 500, hz: 600 }]);
  });

  it('returns null when nothing was keyed', () => {
    const rec = new TxRecorder();
    rec.start(1000);
    expect(rec.stop(5000)).toBeNull();
    expect(new TxRecorder().stop(1000)).toBeNull(); // stop без start
  });

  it('reports elapsed time and the duration cap', () => {
    const rec = new TxRecorder(10_000);
    rec.start(1000);
    expect(rec.elapsedMs(4000)).toBe(3000);
    expect(rec.isFull(10_500)).toBe(false);
    expect(rec.isFull(11_000)).toBe(true);
  });

  it('renders marks that decode back through the real RX chain', () => {
    // «SOS» учебными таймингами 15 WPM (юнит 80 мс) на 600 Гц.
    const rec = new TxRecorder();
    rec.start(0);
    let t = 1000;
    for (const ch of 'SOS') {
      for (const el of MORSE[ch]) {
        rec.toneOn(t, 600);
        t += el === '.' ? 80 : 240;
        rec.toneOff(t);
        t += 80;
      }
      t += 160; // до 3 юнитов между буквами
    }
    const marks = rec.stop(t + 1000);
    expect(marks).not.toBeNull();
    const pcm = renderToneWav(marks ?? []);
    const wav = decodeWavPcm16(new Uint8Array(encodeWAV(pcm, TX_REC_SAMPLE_RATE)));
    expect(runRxChain(wav, 15).text).toBe('SOS');
  });
});
