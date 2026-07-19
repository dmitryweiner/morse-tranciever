// CLI офлайн-анализа WAV: npm run wav -- file.wav [--seed 5] [--hop 5] [--trace]
// Показывает параметры файла, доминирующую частоту, фронты гейта и декод
// через РЕАЛЬНУЮ цепочку приложения (см. src/analysis/wavlab.ts).
// --trace — таймлайн решений декодера: каждый элемент/буква со временем и
// текущими оценками unit/ratio; главный инструмент, когда надо понять,
// ПОЧЕМУ метка классифицировалась не так (осколки, склейки, дрейф оценки).
// Запускается через vite-node (идёт с vitest) — потому может импортировать TS.

import { readFileSync } from 'node:fs';
import {
  decodeWavPcm16, dominantFrequencyHz, runRxChain, RxChainRunner,
} from '../src/analysis/wavlab';
import type { MorseEvent } from '../src/morse/code';

const args = process.argv.slice(2);
const files: string[] = [];
let seed = 5;
let hop = 5;
let trace = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seed') seed = Number(args[++i]);
  else if (args[i] === '--hop') hop = Number(args[++i]);
  else if (args[i] === '--trace') trace = true;
  else if (!args[i].startsWith('--')) files.push(args[i]);
}
if (!files.length) {
  console.error('usage: npm run wav -- file.wav [file2.wav …] [--seed WPM] [--hop ms] [--trace]');
  process.exit(1);
}

function printTrace(runner: RxChainRunner, events: MorseEvent[]): void {
  const t = ((runner.processedFrames * hop) / 1000).toFixed(2).padStart(7);
  for (const e of events) {
    const est = `unit≈${Math.round(runner.unitMs)}ms ratio≈${runner.dashDotRatio.toFixed(2)}`;
    if (e.kind === 'element') console.log(`  ${t}s  ${e.element === '.' ? '·' : '▮'}  ${e.code.padEnd(7)} ${est}`);
    else if (e.kind === 'letter') console.log(`  ${t}s  → ${e.char ?? '?'}  (${e.code})  ${est}`);
    else console.log(`  ${t}s  → (word gap)`);
  }
}

for (const path of files) {
  const wav = decodeWavPcm16(new Uint8Array(readFileSync(path)));
  const dur = wav.samples.length / wav.sampleRate;
  const freq = dominantFrequencyHz(wav);
  console.log(`\n=== ${path}`);
  console.log(`  ${wav.sampleRate} Hz, ${dur.toFixed(2)} s, dominant ≈ ${freq} Hz`);
  if (trace) {
    const runner = new RxChainRunner(wav, seed, hop);
    while (!runner.done) printTrace(runner, runner.step(1));
    printTrace(runner, runner.finish());
  }
  const res = runRxChain(wav, seed, hop);
  console.log(`  edges: ${res.edges.map((e) => (e > 0 ? `▮${e}` : `·${-e}`)).join(' ')}`);
  console.log(`  decoded (seed ${seed} WPM): "${res.text}"  unit≈${Math.round(res.unitMs)}ms (${res.estWpm} WPM)`);
}
