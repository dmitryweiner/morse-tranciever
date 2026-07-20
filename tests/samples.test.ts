// Регрессия на РЕАЛЬНЫХ записях (samples/): в TEST*.wav отстучано TEST,
// в SOS*.wav — SOS. Файлы не в git — без них тесты просто пропускаются.
import { existsSync, readFileSync } from 'node:fs';
import { decodeWavPcm16, runRxChain } from '../src/analysis/wavlab';

const SEED_WPM = 5; // пищалка медленная — слайдер на минимуме

function decode(path: string): string {
  const wav = decodeWavPcm16(new Uint8Array(readFileSync(path)));
  // Паузы между буквами у отправителя словесного масштаба — пробелы убираем.
  return runRxChain(wav, SEED_WPM).text.split(' ').join('');
}

const has = (p: string) => existsSync(p);

describe('real beeper recordings (ground truth: TEST)', () => {
  it.skipIf(!has('samples/TEST1.wav'))('TEST1.wav (1.4 kHz)', () => {
    expect(decode('samples/TEST1.wav')).toBe('TEST');
  });

  it.skipIf(!has('samples/TEST2.wav'))('TEST2.wav (600 Hz)', () => {
    expect(decode('samples/TEST2.wav')).toBe('TEST');
  });

  it.skipIf(!has('samples/TEST3.wav'))('TEST3.wav (1 kHz)', () => {
    expect(decode('samples/TEST3.wav')).toBe('TEST');
  });

  it.skipIf(!has('samples/TEST.wav'))('TEST.wav (3 kHz) — известный предел', () => {
    // Точки S слиплись в 495 мс — ровно длина тире этой пищалки; по одним
    // таймингам S↔N неразличимы (нужна словарная коррекция, см. бэклог).
    // Тест фиксирует текущее поведение, чтобы заметить любое изменение.
    expect(decode('samples/TEST.wav')).toBe('TENT');
  });

  it.skipIf(!has('samples/SOS3.wav'))('SOS3.wav (3 kHz)', () => {
    expect(decode('samples/SOS3.wav')).toBe('SOS');
  });

  it.skipIf(!has('samples/SOS1.wav'))('SOS1.wav — известный предел', () => {
    // Пары точек слиплись в ~2 юнита = тире этой пищалки (у неё тире всего
    // ~1.9 точки) — SOS и NON по таймингам одна и та же запись.
    expect(decode('samples/SOS1.wav')).toBe('NON');
  });

  it.skipIf(!has('samples/SOS2.wav'))('SOS2.wav — известный предел', () => {
    expect(decode('samples/SOS2.wav')).toBe('AOT');
  });
});

// Автоматическая передача (кнопка Send, 15 WPM, 600 Гц) с одного телефона,
// запись микрофоном другого: бытовой гул 300–700 Гц, реверберация комнаты.
// Пробелы здесь настоящие (словесные паузы отправителя) — сохраняем.
function decodeAir(path: string): string {
  const wav = decodeWavPcm16(new Uint8Array(readFileSync(path)));
  return runRxChain(wav, 15).text;
}

describe('over-the-air recordings (phone speaker → phone mic, 15 WPM)', () => {
  it.skipIf(!has('samples/ABCDEFGH.wav'))('ABCDEFGH.wav', () => {
    expect(decodeAir('samples/ABCDEFGH.wav')).toBe('ABCDEFGH');
  });

  it.skipIf(!has('samples/TEST DMITRY MAMA.wav'))('TEST DMITRY MAMA.wav — известный предел', () => {
    // Мусорный префикс «I T EEE» — гул до захвата несущей + первая T,
    // изрезанная шумом (замка ещё нет — когерентный детектор не работает).
    // До доработок читалось «E T MEST DZTR?AMA».
    expect(decodeAir('samples/TEST DMITRY MAMA.wav')).toBe('I T EEEST DMITRY MAMA');
  });

  it.skipIf(!has('samples/TEST DMITRY MAMA1.wav'))('TEST DMITRY MAMA1.wav — известный предел', () => {
    // R→G: гул откусил первую точку R прямо в метке; хвостовая E — осколок
    // шума. До доработок читалось «TEST DMITRY ET TAT» (замок крала помеха).
    expect(decodeAir('samples/TEST DMITRY MAMA1.wav')).toBe('TEST DMITGY MAMAE');
  });
});
