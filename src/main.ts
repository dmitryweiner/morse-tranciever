// Сборка UI и связка событий: кеер (TX) и декодер (RX) шлют одинаковые
// MorseEvent'ы — дерево, текущий символ и строка текста обновляются одним
// applyEvents. Логика таймингов/декодирования — чистые модули src/morse/*.

import './style.css';
import { type MorseElement, type MorseEvent } from './morse/code';
import { unitMs } from './morse/timing';
import { Keyer } from './morse/keyer';
import { PaddleKeyer } from './morse/paddle';
import { AdaptiveDecoder } from './morse/decoder';
import { SignalGate } from './morse/envelope';
import { Sidetone } from './audio/tone';
import { MicAnalyser } from './audio/mic';
import { TreeView } from './ui/tree';
import { el, buttonEl, inputEl, svgRootEl } from './ui/dom';

const WPM_KEY = 'morse_transceiver_wpm';
const TONE_KEY = 'morse_transceiver_tone';
const KEYMODE_KEY = 'morse_transceiver_keymode';
const TEXT_CAP = 400;
const TICK_MS = 15;

const tree = new TreeView(svgRootEl('tree'));
const tone = new Sidetone();
const mic = new MicAnalyser();

const bigChar = el('bigChar');
const codeNow = el('codeNow');
const outText = el('outText');
const textLine = el('textLine');
const statusEl = el('status');
const meterBar = el('meterBar');
const rxInfo = el('rxInfo');
const txPanel = el('txPanel');
const rxPanel = el('rxPanel');
const keyBtn = buttonEl('keyBtn');
const paddleRow = el('paddleRow');
const dotBtn = buttonEl('dotBtn');
const dashBtn = buttonEl('dashBtn');
const straightModeBtn = buttonEl('straightModeBtn');
const paddleModeBtn = buttonEl('paddleModeBtn');
const txHint = el('txHint');
const micBtn = buttonEl('micBtn');
const txModeBtn = buttonEl('txModeBtn');
const rxModeBtn = buttonEl('rxModeBtn');
const wpmSlider = inputEl('wpmSlider');
const wpmVal = el('wpmVal');
const toneSlider = inputEl('toneSlider');
const toneVal = el('toneVal');

let wpm = clampInt(localStorage.getItem(WPM_KEY), 5, 30, 15);
let toneHz = clampInt(localStorage.getItem(TONE_KEY), 400, 3400, 600);
let mode: 'tx' | 'rx' = 'tx';
let keyMode: 'straight' | 'paddle' =
  localStorage.getItem(KEYMODE_KEY) === 'paddle' ? 'paddle' : 'straight';
let text = '';
let keyIsDown = false;
let paddleToneOn = false;

const keyer = new Keyer(() => unitMs(wpm));
const paddle = new PaddleKeyer(() => unitMs(wpm));
const decoder = new AdaptiveDecoder(unitMs(wpm));
let gate = new SignalGate();

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  // Number(null) и Number('') — это 0, а не NaN: пустое значение отсекаем явно.
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const now = () => performance.now();

// Глифы кода раскрашены как узлы дерева: точки — патина, тире — латунь.
function renderCodeNow(code: string): void {
  codeNow.textContent = '';
  for (const c of code) {
    const span = document.createElement('span');
    span.className = c === '.' ? 'cdot' : 'cdash';
    span.textContent = c === '.' ? '·' : '−';
    codeNow.append(span);
  }
}

function renderText(): void {
  if (text.length > TEXT_CAP) text = text.slice(text.length - TEXT_CAP);
  outText.textContent = text;
  textLine.scrollLeft = textLine.scrollWidth;
}

function applyEvents(events: MorseEvent[]): void {
  for (const e of events) {
    if (e.kind === 'element') {
      tree.setPath(e.code);
      renderCodeNow(e.code);
    } else if (e.kind === 'letter') {
      tree.flash(e.code);
      tree.setPath('');
      codeNow.textContent = '';
      bigChar.textContent = e.char ?? '?';
      text += e.char ?? '?';
      renderText();
    } else {
      text += ' ';
      renderText();
    }
  }
}

// ---------- передача ----------

function pressKey(): void {
  if (keyIsDown || mode !== 'tx') return;
  keyIsDown = true;
  keyBtn.classList.add('down');
  tone.keyDown();
  applyEvents(keyer.keyDown(now()));
}

function releaseKey(): void {
  if (!keyIsDown) return;
  keyIsDown = false;
  keyBtn.classList.remove('down');
  tone.keyUp();
  applyEvents(keyer.keyUp(now()));
}

keyBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  keyBtn.setPointerCapture(e.pointerId);
  pressKey();
});
keyBtn.addEventListener('pointerup', (e) => {
  e.preventDefault();
  releaseKey();
});
keyBtn.addEventListener('pointercancel', () => releaseKey());
keyBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- paddle-режим ----------

function paddlePress(element: MorseElement): void {
  if (mode !== 'tx' || keyMode !== 'paddle') return;
  tone.ensure(); // синхронно в жесте — важно для iOS
  (element === '.' ? dotBtn : dashBtn).classList.add('down');
  applyEvents(paddle.press(element, now()));
  syncPaddleTone();
}

function paddleRelease(element: MorseElement): void {
  (element === '.' ? dotBtn : dashBtn).classList.remove('down');
  paddle.release(element);
}

function syncPaddleTone(): void {
  if (paddle.isToneOn !== paddleToneOn) {
    paddleToneOn = paddle.isToneOn;
    if (paddleToneOn) tone.keyDown();
    else tone.keyUp();
  }
}

function bindPaddle(btn: HTMLButtonElement, element: MorseElement): void {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    paddlePress(element);
  });
  btn.addEventListener('pointerup', (e) => {
    e.preventDefault();
    paddleRelease(element);
  });
  btn.addEventListener('pointercancel', () => paddleRelease(element));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindPaddle(dotBtn, '.');
bindPaddle(dashBtn, '-');

// Клавиатура: пробел — straight-ключ; в paddle-режиме стрелки ←/→ (и -/.)
// повторяют раскладку дерева и кнопок: тире слева, точка справа.
function paddleKeyFor(e: KeyboardEvent): MorseElement | null {
  if (e.code === 'ArrowLeft' || e.key === '-') return '-';
  if (e.code === 'ArrowRight' || e.key === '.') return '.';
  return null;
}

window.addEventListener('keydown', (e) => {
  if (mode !== 'tx' || e.target instanceof HTMLInputElement) return;
  if (keyMode === 'straight' && e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) pressKey();
    return;
  }
  if (keyMode === 'paddle') {
    const element = paddleKeyFor(e);
    if (element) {
      e.preventDefault();
      if (!e.repeat) paddlePress(element);
    }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') releaseKey();
  const element = paddleKeyFor(e);
  if (element) paddleRelease(element);
});
window.addEventListener('blur', () => {
  releaseKey();
  paddle.releaseAll();
});

function setKeyMode(next: 'straight' | 'paddle'): void {
  if (keyMode === next) return;
  keyMode = next;
  localStorage.setItem(KEYMODE_KEY, next);
  releaseKey();
  paddle.reset();
  keyer.reset();
  syncPaddleTone();
  tone.keyUp();
  tree.setPath('');
  codeNow.textContent = '';
  straightModeBtn.classList.toggle('active', next === 'straight');
  paddleModeBtn.classList.toggle('active', next === 'paddle');
  straightModeBtn.setAttribute('aria-selected', String(next === 'straight'));
  paddleModeBtn.setAttribute('aria-selected', String(next === 'paddle'));
  keyBtn.hidden = next !== 'straight';
  paddleRow.hidden = next !== 'paddle';
  txHint.textContent = next === 'straight'
    ? 'Hold the key (or Space): short press — dot, long — dash. ' +
      'Pause to finish a letter, pause longer for a word gap.'
    : 'Tap − or · (or ←/→): element length is automatic. Hold to repeat, ' +
      'hold both to alternate. Pause to finish a letter.';
}

straightModeBtn.addEventListener('click', () => setKeyMode('straight'));
paddleModeBtn.addEventListener('click', () => setKeyMode('paddle'));

// ---------- приём ----------

async function startMic(): Promise<void> {
  statusEl.textContent = '';
  try {
    await mic.start();
  } catch {
    statusEl.textContent = 'Microphone unavailable — check the browser permission.';
    return;
  }
  gate = new SignalGate();
  decoder.setUnitMs(unitMs(wpm));
  micBtn.classList.add('live');
  micBtn.textContent = '■ Stop listening';
}

function stopMic(): void {
  mic.stop();
  micBtn.classList.remove('live');
  micBtn.textContent = '▶ Start listening';
  meterBar.style.width = '0%';
  rxInfo.textContent = ' ';
  tree.setPath('');
  codeNow.textContent = '';
}

micBtn.addEventListener('click', () => {
  if (mic.running) stopMic();
  else void startMic();
});

// ---------- общий цикл ----------

// Отладочный хук для scripts/rx.mjs: длительности фаз сигнала on/off.
const rxEdges: Array<{ on: boolean; ms: number }> = [];
let edgeT = 0;
let edgeOn = false;
Object.assign(window, { __rxEdges: rxEdges });

setInterval(() => {
  const t = now();
  if (mode === 'tx') {
    if (keyMode === 'straight') {
      applyEvents(keyer.tick(t));
    } else {
      applyEvents(paddle.tick(t));
      syncPaddleTone();
    }
  } else if (mic.running) {
    const frame = mic.poll();
    const on = gate.update(frame);
    if (on !== edgeOn) {
      rxEdges.push({ on: edgeOn, ms: Math.round(t - edgeT) });
      if (rxEdges.length > 300) rxEdges.shift();
      edgeT = t;
      edgeOn = on;
    }
    applyEvents(decoder.signal(on, t));
    applyEvents(decoder.tick(t));
    meterBar.style.width = `${Math.round(gate.normalize(frame.levelDb) * 100)}%`;
    const est = Math.round(1200 / decoder.unitMs);
    rxInfo.textContent = `≈ ${est} WPM ${on ? '▮ tone' : '· idle'}`;
  }
}, TICK_MS);

// ---------- режимы ----------

function setMode(next: 'tx' | 'rx'): void {
  if (mode === next) return;
  mode = next;
  releaseKey();
  paddle.releaseAll();
  txModeBtn.classList.toggle('active', next === 'tx');
  rxModeBtn.classList.toggle('active', next === 'rx');
  txModeBtn.setAttribute('aria-selected', String(next === 'tx'));
  rxModeBtn.setAttribute('aria-selected', String(next === 'rx'));
  txPanel.hidden = next !== 'tx';
  rxPanel.hidden = next !== 'rx';
  tree.setPath('');
  codeNow.textContent = '';
  statusEl.textContent = '';
  if (next === 'rx') {
    tone.release();
  } else {
    stopMic();
  }
}

txModeBtn.addEventListener('click', () => setMode('tx'));
rxModeBtn.addEventListener('click', () => setMode('rx'));

// ---------- настройки ----------

function applyWpm(): void {
  wpmVal.textContent = `${wpm} WPM`;
  wpmSlider.value = String(wpm);
  decoder.setUnitMs(unitMs(wpm));
  localStorage.setItem(WPM_KEY, String(wpm));
}

function applyTone(): void {
  toneVal.textContent = `${toneHz} Hz`;
  toneSlider.value = String(toneHz);
  tone.setFrequency(toneHz);
  localStorage.setItem(TONE_KEY, String(toneHz));
}

wpmSlider.addEventListener('input', () => {
  wpm = clampInt(wpmSlider.value, 5, 30, 15);
  applyWpm();
});
toneSlider.addEventListener('input', () => {
  toneHz = clampInt(toneSlider.value, 400, 3400, 600);
  applyTone();
});

buttonEl('clearBtn').addEventListener('click', () => {
  text = '';
  bigChar.textContent = '·';
  renderText();
});

applyWpm();
applyTone();
// Применить сохранённый режим ключа (setKeyMode no-op при совпадении).
keyBtn.hidden = keyMode !== 'straight';
paddleRow.hidden = keyMode !== 'paddle';
if (keyMode === 'paddle') {
  const saved = keyMode;
  keyMode = 'straight';
  setKeyMode(saved);
}
