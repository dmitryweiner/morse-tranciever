// Сборка UI и связка событий: кеер (TX) и декодер (RX) шлют одинаковые
// MorseEvent'ы — дерево, текущий символ и строка текста обновляются одним
// applyEvents. Логика таймингов/декодирования — чистые модули src/morse/*.

import './style.css';
import { type MorseElement, type MorseEvent } from './morse/code';
import { unitMs } from './morse/timing';
import { Keyer } from './morse/keyer';
import { PaddleKeyer } from './morse/paddle';
import { TextSender } from './morse/sender';
import { AdaptiveDecoder } from './morse/decoder';
import { SignalGate, type SpectralFrame } from './morse/envelope';
import { RX_HOP_MS } from './analysis/spectrum';
import { decodeWavPcm16, RxChainRunner, type WavData } from './analysis/wavlab';
import { Sidetone } from './audio/tone';
import { MicAnalyser } from './audio/mic';
import { encodeWAV } from './audio/wav';
import { TxRecorder, renderToneWav, TX_REC_SAMPLE_RATE } from './audio/txrecord';
import { TreeView, DESKTOP_LAYOUT, MOBILE_LAYOUT } from './ui/tree';
import { el, buttonEl, inputEl, svgRootEl } from './ui/dom';

const WPM_KEY = 'morse_transceiver_wpm';
const TONE_KEY = 'morse_transceiver_tone';
const KEYMODE_KEY = 'morse_transceiver_keymode';
const TEXT_CAP = 400;
const TICK_MS = 15;

// Мобильный макет дерева (крупные буквы, шахматный нижний ряд) выбирается по
// ширине и перестраивается при её смене (поворот/ресайз).
const mobileQuery = window.matchMedia('(max-width: 600px)');
let tree = new TreeView(svgRootEl('tree'), mobileQuery.matches ? MOBILE_LAYOUT : DESKTOP_LAYOUT);
mobileQuery.addEventListener('change', () => {
  const svg = svgRootEl('tree');
  svg.replaceChildren();
  tree = new TreeView(svg, mobileQuery.matches ? MOBILE_LAYOUT : DESKTOP_LAYOUT);
});
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
const sendInput = inputEl('sendInput');
const sendBtn = buttonEl('sendBtn');
const sendLine = el('sendLine');
const micBtn = buttonEl('micBtn');
const uploadBtn = buttonEl('uploadBtn');
const uploadInput = inputEl('uploadInput');
const recBtn = buttonEl('recBtn');
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
let senderToneOn = false;

const keyer = new Keyer(() => unitMs(wpm));
const paddle = new PaddleKeyer(() => unitMs(wpm));
const sender = new TextSender(() => unitMs(wpm));
const decoder = new AdaptiveDecoder(unitMs(wpm));
let gate = new SignalGate(RX_HOP_MS);

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  // Number(null) и Number('') — это 0, а не NaN: пустое значение отсекаем явно.
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const now = () => performance.now();

// Запись передачи: фронты бокового тона (любой источник — ключ, paddle,
// отправка текста) идут через sidetoneOn/Off и попадают в TxRecorder.
const txRec = new TxRecorder();

function sidetoneOn(): void {
  tone.keyDown();
  txRec.toneOn(now(), toneHz);
}

function sidetoneOff(): void {
  tone.keyUp();
  txRec.toneOff(now());
}

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
  stopSend(); // любое нажатие ключа обрывает передачу текста
  keyIsDown = true;
  keyBtn.classList.add('down');
  sidetoneOn();
  applyEvents(keyer.keyDown(now()));
}

function releaseKey(): void {
  if (!keyIsDown) return;
  keyIsDown = false;
  keyBtn.classList.remove('down');
  sidetoneOff();
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
  stopSend(); // любое нажатие ключа обрывает передачу текста
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
    if (paddleToneOn) sidetoneOn();
    else sidetoneOff();
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
  stopSend();
  releaseKey();
  paddle.reset();
  keyer.reset();
  syncPaddleTone();
  sidetoneOff();
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

// ---------- передача по тексту ----------

let sendSpans: HTMLSpanElement[] = [];
let sendHighlight = -1;

function startSend(): void {
  if (mode !== 'tx' || sender.isSending) return;
  tone.ensure(); // синхронно в жесте — важно для iOS
  releaseKey();
  paddle.releaseAll();
  const value = sendInput.value;
  const events = sender.start(value, now());
  if (!sender.isSending) return; // в строке нет ни одной известной буквы
  sendLine.textContent = '';
  sendSpans = [...value.toUpperCase()].map((c) => {
    const span = document.createElement('span');
    span.textContent = c;
    sendLine.append(span);
    return span;
  });
  sendHighlight = -1;
  sendLine.hidden = false;
  sendBtn.textContent = 'Stop';
  sendBtn.classList.add('sending');
  applyEvents(events);
  syncSenderTone();
  updateSendHighlight();
}

function stopSend(): void {
  if (!sender.isSending) return;
  sender.stop();
  syncSenderTone();
  tree.setPath('');
  codeNow.textContent = '';
  finishSendUi();
}

function finishSendUi(): void {
  sendBtn.textContent = 'Send';
  sendBtn.classList.remove('sending');
  sendLine.hidden = true;
  sendLine.textContent = '';
  sendSpans = [];
  sendHighlight = -1;
}

function syncSenderTone(): void {
  if (sender.isToneOn !== senderToneOn) {
    senderToneOn = sender.isToneOn;
    if (senderToneOn) sidetoneOn();
    else sidetoneOff();
  }
}

function updateSendHighlight(): void {
  const idx = sender.currentIndex ?? -1;
  if (idx === sendHighlight) return;
  if (sendHighlight >= 0) sendSpans[sendHighlight]?.classList.remove('cur');
  if (idx >= 0) sendSpans[idx]?.classList.add('cur');
  sendHighlight = idx;
}

sendBtn.addEventListener('click', () => {
  if (sender.isSending) stopSend();
  else startSend();
});
sendInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!sender.isSending) startSend();
  }
});

// ---------- приём ----------

async function startMic(): Promise<void> {
  if (analysingFile) return; // пока разбирается файл — микрофон не включаем
  statusEl.textContent = '';
  // На http:// (кроме localhost) getUserMedia просто отсутствует — частый
  // случай при открытии dev-сервера с телефона по LAN-адресу.
  if (!navigator.mediaDevices) {
    statusEl.textContent =
      'Microphone needs a secure context — open this page over HTTPS (or localhost).';
    return;
  }
  gate = new SignalGate(RX_HOP_MS);
  decoder.setUnitMs(unitMs(wpm));
  try {
    await mic.start(onRxFrame);
  } catch (e) {
    statusEl.textContent = e instanceof DOMException && e.name === 'NotAllowedError'
      ? 'Microphone access denied — allow it in the browser site settings.'
      : 'Microphone unavailable — check the browser permission.';
    return;
  }
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

// ---------- загрузка записи ----------

// Файл гонится через ТУ ЖЕ цепочку, что и офлайн-стенд (RxChainRunner),
// порциями с паузами — счёт долгой записи не вешает UI. WAV разбирается
// бит-в-бит как в стенде; любой другой формат (m4a/mp3/ogg — диктофоны
// телефонов) декодирует сам браузер с ресемплингом к 48 кГц.
let analysingFile = false;

async function decodeAudioFile(file: File): Promise<WavData> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return decodeWavPcm16(bytes);
  } catch {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const samples = new Float32Array(buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < data.length; i++) samples[i] += data[i] / buf.numberOfChannels;
    }
    return { samples, sampleRate: buf.sampleRate };
  }
}

async function analyzeFile(file: File): Promise<void> {
  if (analysingFile) return;
  analysingFile = true;
  uploadBtn.disabled = true;
  stopMic(); // живой приём и разбор файла не смешиваем
  statusEl.textContent = '';
  try {
    const wav = await decodeAudioFile(file);
    const runner = new RxChainRunner(wav, wpm);
    tree.setPath('');
    codeNow.textContent = '';
    while (!runner.done && mode === 'rx') {
      applyEvents(runner.step(400)); // ~2 с записи за порцию
      const pct = Math.round((runner.processedFrames / runner.totalFrames) * 100);
      rxInfo.textContent = `Decoding ${file.name}… ${pct}%`;
      await new Promise((r) => setTimeout(r));
    }
    if (runner.done) {
      applyEvents(runner.finish());
      rxInfo.textContent = `${file.name} · ≈ ${Math.round(1200 / runner.unitMs)} WPM`;
    }
  } catch {
    statusEl.textContent = 'Could not decode this audio file.';
    rxInfo.textContent = ' ';
  } finally {
    analysingFile = false;
    uploadBtn.disabled = false;
  }
}

uploadBtn.addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => {
  const file = uploadInput.files?.[0];
  uploadInput.value = ''; // тот же файл можно загрузить повторно
  if (file) void analyzeFile(file);
});

// ---------- запись передачи в WAV ----------

function downloadWav(samples: Float32Array, sampleRate: number): void {
  const blob = new Blob([encodeWAV(samples, sampleRate)], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  a.href = url;
  a.download = `morse-tx-${ts}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function finishTxRecording(): void {
  const marks = txRec.stop(now());
  recBtn.classList.remove('rec');
  recBtn.textContent = '● Record';
  // Ни одной метки — сохранять нечего, запись просто закрывается.
  if (marks) downloadWav(renderToneWav(marks), TX_REC_SAMPLE_RATE);
}

function updateRecTimer(): void {
  if (!txRec.recording) return;
  const t = now();
  if (txRec.isFull(t)) {
    finishTxRecording(); // упёрлись в потолок — сохранить и остановиться
    return;
  }
  const s = Math.floor(txRec.elapsedMs(t) / 1000);
  const mm = String(Math.floor(s / 60));
  const ss = String(s % 60).padStart(2, '0');
  recBtn.textContent = `■ ${mm}:${ss} — save`;
}

recBtn.addEventListener('click', () => {
  if (txRec.recording) {
    finishTxRecording();
  } else {
    txRec.start(now());
    recBtn.classList.add('rec');
    recBtn.textContent = '■ 0:00 — save';
  }
});

// ---------- общий цикл ----------

// Отладочный хук для scripts/rx.mjs: длительности фаз сигнала on/off.
const rxEdges: Array<{ on: boolean; ms: number }> = [];
let edgeT = 0;
let edgeOn = false;
Object.assign(window, { __rxEdges: rxEdges });

// Кадры приёма приходят пушем из mic (раз в RX_HOP_MS, время — сэмпл-счётчик
// аудиопотока): гейт и декодер работают точным аудио-временем, а не
// performance.now с джиттером main-потока. UI обновляется реже, в 15-мс цикле.
let lastFrame: SpectralFrame = { levelDb: -120, contrastDb: 0, peakHz: 0 };
let lastOn = false;

function onRxFrame(frame: SpectralFrame, tMs: number): void {
  const on = gate.update(frame);
  if (on !== edgeOn) {
    rxEdges.push({ on: edgeOn, ms: Math.round(tMs - edgeT) });
    if (rxEdges.length > 300) rxEdges.shift();
    edgeT = tMs;
    edgeOn = on;
  }
  applyEvents(decoder.signal(on, tMs));
  applyEvents(decoder.tick(tMs));
  lastFrame = frame;
  lastOn = on;
}

setInterval(() => {
  const t = now();
  if (mode === 'tx') {
    updateRecTimer();
    if (sender.isSending) {
      applyEvents(sender.tick(t));
      syncSenderTone();
      if (sender.isSending) updateSendHighlight();
      else finishSendUi(); // посылка дозвучала
    } else if (keyMode === 'straight') {
      applyEvents(keyer.tick(t));
    } else {
      applyEvents(paddle.tick(t));
      syncPaddleTone();
    }
  } else if (mic.running) {
    mic.heal();
    meterBar.style.width = `${Math.round(gate.normalize(lastFrame.levelDb) * 100)}%`;
    const est = Math.round(1200 / decoder.unitMs);
    const carrier = gate.carrierHz;
    const lockTxt = carrier === null ? '' : ` · ${Math.round(carrier)} Hz`;
    rxInfo.textContent = `≈ ${est} WPM${lockTxt} ${lastOn ? '▮ tone' : '· idle'}`;
  }
}, TICK_MS);

// ---------- режимы ----------

function setMode(next: 'tx' | 'rx'): void {
  if (mode === next) return;
  mode = next;
  stopSend();
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
    if (txRec.recording) finishTxRecording(); // уход из TX — сохранить запись
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
