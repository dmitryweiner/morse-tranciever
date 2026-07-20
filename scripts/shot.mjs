#!/usr/bin/env node
// Скриншоты приложения в headless-Chromium + смоук передачи: «выстукивает»
// букву A на ключе реальными таймингами и проверяет, что она попала в текст.
//
//   node scripts/shot.mjs                  # base / keying / received / receive
//   node scripts/shot.mjs --mobile         # мобильный вьюпорт 420×850
//   node scripts/shot.mjs --preview        # прод-сборка из docs (vite preview :4173)
//   node scripts/shot.mjs --out shots2     # каталог для кадров (default shots)
//
// Кадры пишутся в ./shots/*.png. Dev-сервер поднимается сам (и гасится),
// если на порту ещё ничего не слушает. Любая консольная ошибка — exit 2.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['out']);
const flags = new Map();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    flags.set(name, VALUE_FLAGS.has(name) ? args[++i] : 'true');
  }
}
const mobile = flags.has('mobile');
const preview = flags.has('preview');
const outDir = flags.get('out') ?? 'shots';
const suffix = mobile ? '-mobile' : '';

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

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage(
  mobile
    ? { viewport: { width: 420, height: 850 }, hasTouch: true, isMobile: true }
    : { viewport: { width: 1280, height: 900 } },
);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(BASE);
await page.waitForTimeout(400);

await page.screenshot({ path: `${outDir}/base${suffix}.png`, fullPage: true });
console.log(`${outDir}/base${suffix}.png`);

// Медленный темп (5 WPM: юнит 240 мс) — чтобы успеть снять кадр с
// подсвеченным путём до коммита буквы (порог паузы 480 мс).
await page.locator('#wpmSlider').fill('5');
const key = page.locator('#keyBtn');
const box = await key.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
// Буква A: точка (150 мс), пауза, тире (700 мс).
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(200);
await page.mouse.down();
await page.waitForTimeout(700);
await page.mouse.up();
await page.screenshot({ path: `${outDir}/keying${suffix}.png`, fullPage: true });
console.log(`${outDir}/keying${suffix}.png`);

await page.waitForTimeout(900);
const typed = await page.locator('#outText').textContent();
const bigChar = await page.locator('#bigChar').textContent();
await page.screenshot({ path: `${outDir}/received${suffix}.png`, fullPage: true });
console.log(`${outDir}/received${suffix}.png`);
if (typed !== 'A' || bigChar !== 'A') {
  errors.push(`ожидалась буква A, получено text='${typed}' bigChar='${bigChar}'`);
}

// Paddle-режим: тап по тире должен сам сгенерировать элемент нужной длины
// (на 5 WPM тире = 720 мс) и закоммитить букву T.
await page.locator('#paddleModeBtn').click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${outDir}/paddle${suffix}.png`, fullPage: true });
console.log(`${outDir}/paddle${suffix}.png`);
await page.locator('#dashBtn').click();
await page.waitForTimeout(1800);
const typedPaddle = await page.locator('#outText').textContent();
if (!typedPaddle || !typedPaddle.trimEnd().endsWith('T')) {
  errors.push(`paddle: ожидалась буква T в конце, получено '${typedPaddle}'`);
}

// Передача по тексту (режим Text): «5.» отстукивается сама (коды глубже
// дерева — путь подсвечивается только до 4-го уровня, живой DOM не должен
// падать); во время передачи кнопка переключается в Stop.
await page.locator('#textModeBtn').click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${outDir}/text${suffix}.png`, fullPage: true });
console.log(`${outDir}/text${suffix}.png`);
await page.locator('#wpmSlider').fill('30'); // юнит 40 мс — смоук быстрый
await page.locator('#sendInput').fill('5.');
await page.locator('#sendBtn').click();
const sendBtnLabel = await page.locator('#sendBtn').textContent();
if (sendBtnLabel !== 'Stop') {
  errors.push(`send: ожидалась кнопка Stop во время передачи, получено '${sendBtnLabel}'`);
}
await page.waitForTimeout(2000);
const typedSend = await page.locator('#outText').textContent();
if (!typedSend || !typedSend.trimEnd().endsWith('5.')) {
  errors.push(`send: ожидалось '5.' в конце, получено '${typedSend}'`);
}
const sendBtnAfter = await page.locator('#sendBtn').textContent();
if (sendBtnAfter !== 'Send') {
  errors.push(`send: кнопка не вернулась в Send, получено '${sendBtnAfter}'`);
}

// Запись передачи: Record → Send E → Stop должен скачать синтезированный WAV.
await page.locator('#recBtn').click();
await page.locator('#sendInput').fill('E');
await page.locator('#sendBtn').click();
await page.waitForTimeout(600); // E на 30 WPM — точка 40 мс + коммит
const downloadP = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await page.locator('#recBtn').click();
const download = await downloadP;
if (!download || !download.suggestedFilename().endsWith('.wav')) {
  errors.push('record: не дождались скачивания WAV передачи');
} else {
  console.log(`record: скачан ${download.suggestedFilename()}`);
}

await page.locator('#rxModeBtn').click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/receive${suffix}.png`, fullPage: true });
console.log(`${outDir}/receive${suffix}.png`);

// Загрузка записи: WAV генерится реальными модулями приложения (genwav —
// TextSender + renderToneWav) и скармливается кнопке Upload; порционный
// разбор должен дописать SOS в текст.
execFileSync('npx', [
  'vite-node', 'scripts/genwav.ts', '--',
  '--msg', 'SOS', '--out', `${outDir}/upload-test.wav`,
], { stdio: 'ignore' });
await page.locator('#wpmSlider').fill('15');
await page.locator('#uploadInput').setInputFiles(`${outDir}/upload-test.wav`);
let uploadText = '';
for (let i = 0; i < 20 && !uploadText.includes('SOS'); i++) {
  await page.waitForTimeout(500);
  uploadText = (await page.locator('#outText').textContent()) ?? '';
}
if (!uploadText.includes('SOS')) {
  errors.push(`upload: ожидалось SOS в тексте, получено '${uploadText}'`);
} else {
  console.log('upload: SOS декодирован из файла');
}

console.log('console/page errors:', errors.length ? errors : 'none');
await browser.close();
devProc?.kill();
process.exit(errors.length ? 2 : 0);
