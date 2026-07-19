#!/usr/bin/env node
// Сквозной тест ПРИЁМА: генерируем WAV с морзянкой (тон 600 Гц), скармливаем
// его Chromium'у как фейковый микрофон (--use-file-for-fake-audio-capture),
// жмём Receive → Start listening и проверяем, что текст декодировался.
// Единственный способ объективно проверить цепочку mic → FFT → gate → decoder.
//
//   node scripts/rx.mjs                      # сообщение по умолчанию SOS SOS
//   node scripts/rx.mjs --msg "HELLO" --wpm 18 --hz 700
//   node scripts/rx.mjs --file rec.wav [--expect SOS] [--seed 5]
//                                            # реальная запись как микрофон;
//                                            # --seed — начальное WPM слайдера
//   node scripts/rx.mjs --preview            # прод-сборка из docs (:4173)

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['msg', 'wpm', 'hz', 'file', 'expect', 'seed']);
const flags = new Map();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    flags.set(name, VALUE_FLAGS.has(name) ? args[++i] : 'true');
  }
}
const MSG = (flags.get('msg') ?? 'SOS SOS').toUpperCase();
const WPM = Number(flags.get('wpm') ?? 15);
const HZ = Number(flags.get('hz') ?? 600);
const preview = flags.has('preview');

const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
  G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
};

// ---------- подготовка WAV ----------
// Стартовая тишина 4 с обязательна в обоих режимах: аудио «до начала захвата»
// Chromium отдаёт одним спрессованным всплеском — сообщение должно начаться
// позже этого момента.
const LEAD_S = 4.0;
const SR = 48000;
let samples;
let totalS;
let expectText;
let seedWpm;
let outSr = SR;

if (flags.has('file')) {
  const src = readFileSync(resolve(flags.get('file')));
  // Минимальный разбор WAV: ожидаем mono 16-bit PCM (как пишут диктофоны).
  const srcSr = src.readUInt32LE(24);
  if (src.readUInt16LE(22) !== 1 || src.readUInt16LE(34) !== 16) {
    console.error('поддерживается только mono 16-bit PCM WAV');
    process.exit(1);
  }
  const n = Math.floor((src.length - 44) / 2);
  const lead = Math.round(LEAD_S * srcSr);
  samples = new Float32Array(lead + n + Math.round(1.5 * srcSr));
  for (let i = 0; i < n; i++) samples[lead + i] = src.readInt16LE(44 + i * 2) / 32768;
  outSr = srcSr;
  totalS = samples.length / srcSr;
  expectText = flags.get('expect') ?? null;
  seedWpm = Number(flags.get('seed') ?? 5); // пищалки обычно медленные
} else {
  const unitS = 1.2 / WPM;
  const segments = []; // [durSec, on]
  segments.push([LEAD_S, false]);
  for (const word of MSG.split(' ')) {
    for (const ch of word) {
      for (const el of MORSE[ch]) {
        segments.push([(el === '.' ? 1 : 3) * unitS, true]);
        segments.push([unitS, false]);
      }
      segments.push([2 * unitS, false]); // до 3 юнитов между буквами
    }
    segments.push([4 * unitS, false]); // до 7 юнитов между словами
  }
  segments.push([1.5, false]);

  totalS = segments.reduce((a, [d]) => a + d, 0);
  samples = new Float32Array(Math.ceil(totalS * SR));
  let idx = 0;
  let phase = 0;
  for (const [durS, on] of segments) {
    const n = Math.round(durS * SR);
    for (let i = 0; i < n && idx < samples.length; i++, idx++) {
      // Короткий фейд по краям сегмента, чтобы не было щелчков на фронтах.
      const edge = Math.min(1, Math.min(i, n - i) / (0.004 * SR));
      const tone = on ? 0.5 * Math.sin(phase) * edge : 0;
      phase += (2 * Math.PI * HZ) / SR;
      // Лёгкий шумовой пол — реалистичнее для адаптивного гейта.
      samples[idx] = tone + (Math.random() - 0.5) * 0.002;
    }
  }
  expectText = MSG;
  seedWpm = Number(flags.get('seed') ?? WPM);
}

function encodeWav(f32, sr) {
  const buf = Buffer.alloc(44 + f32.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + f32.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(f32.length * 2, 40);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE(Math.round(s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

mkdirSync('shots', { recursive: true });
const wavPath = resolve('shots', 'rx-input.wav');
writeFileSync(wavPath, encodeWav(samples, outSr));
console.log(`WAV: ${wavPath} (${totalS.toFixed(1)}s, seed ${seedWpm} WPM)`);

// ---------- сервер ----------
const PORT = preview ? 4173 : 5173;
const BASE = `http://localhost:${PORT}`;

async function serverUp() {
  try {
    const res = await fetch(BASE);
    return res.ok;
  } catch {
    return false;
  }
}

let devProc = null;
if (!(await serverUp())) {
  const cmd = preview
    ? ['vite', 'preview', '--port', String(PORT), '--strictPort']
    : ['vite', '--port', String(PORT), '--strictPort'];
  devProc = spawn('npx', cmd, { stdio: 'ignore', detached: false });
  for (let i = 0; i < 30 && !(await serverUp()); i++) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!(await serverUp())) {
    console.error(`сервер не поднялся на :${PORT}`);
    process.exit(1);
  }
}

// ---------- браузер с фейковым микрофоном ----------
const browser = await chromium.launch({
  // Полный Chromium: headless-shell (дефолт Playwright) не умеет getUserMedia.
  channel: 'chromium',
  args: [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
// Разрешение на микрофон — через Playwright, а не --use-fake-ui (промпт в
// headless иначе просто висит и getUserMedia не резолвится).
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ['microphone'],
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(BASE);
await page.locator('#wpmSlider').fill(String(seedWpm));
await page.locator('#rxModeBtn').click();
// ВАЖНО: до клика не открывать других getUserMedia — фейковый «микрофон»
// начинает проигрывать WAV с первым же захватом, начало файла будет съедено.
await page.locator('#micBtn').click();
await page.waitForTimeout(2000);
console.log('status:', await page.locator('#status').textContent());
console.log('micBtn:', await page.locator('#micBtn').textContent());
// ВНИМАНИЕ (--file): фейковый захват Chromium подкачивает уровень записи
// (AGC-констрейнты на фейковое устройство не действуют), поэтому тихая возня
// перед передачей может всплыть и дать мусорные буквы в начале. Эталон
// качества декодирования реальных записей — офлайн-стенд (npm run wav).
await page.waitForTimeout(totalS * 1000);

const edges = await page.evaluate(() => window.__rxEdges);
console.log('edges:', edges.map((e) => `${e.on ? '▮' : '·'}${e.ms}`).join(' '));

const text = (await page.locator('#outText').textContent()) ?? '';
const info = await page.locator('#rxInfo').textContent();
await page.screenshot({ path: 'shots/rx-decoded.png', fullPage: true });
console.log(`decoded: "${text.trim()}"  (${info?.trim()})`);
console.log('shots/rx-decoded.png');

const ok = expectText ? text.includes(expectText) : text.trim().length > 0;
if (!ok) {
  errors.push(expectText
    ? `ожидалось вхождение "${expectText}", получено "${text.trim()}"`
    : 'ничего не декодировано');
}
console.log('console/page errors:', errors.length ? errors : 'none');
await browser.close();
devProc?.kill();
process.exit(ok && !errors.length ? 0 : 2);
