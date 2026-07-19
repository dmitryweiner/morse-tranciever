// CLI офлайн-анализа WAV: npm run wav -- file.wav [--seed 5] [--hop 15]
// Показывает параметры файла, доминирующую частоту, фронты гейта и декод
// через РЕАЛЬНУЮ цепочку приложения (см. src/analysis/wavlab.ts).
// Запускается через vite-node (идёт с vitest) — потому может импортировать TS.

import { readFileSync } from 'node:fs';
import {
  decodeWavPcm16, dominantFrequencyHz, runRxChain,
} from '../src/analysis/wavlab';

const args = process.argv.slice(2);
const files: string[] = [];
let seed = 5;
let hop = 15;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seed') seed = Number(args[++i]);
  else if (args[i] === '--hop') hop = Number(args[++i]);
  else if (!args[i].startsWith('--')) files.push(args[i]);
}
if (!files.length) {
  console.error('usage: npm run wav -- file.wav [file2.wav …] [--seed WPM] [--hop ms]');
  process.exit(1);
}

for (const path of files) {
  const wav = decodeWavPcm16(new Uint8Array(readFileSync(path)));
  const dur = wav.samples.length / wav.sampleRate;
  const freq = dominantFrequencyHz(wav);
  const res = runRxChain(wav, seed, hop);
  console.log(`\n=== ${path}`);
  console.log(`  ${wav.sampleRate} Hz, ${dur.toFixed(2)} s, dominant ≈ ${freq} Hz`);
  console.log(`  edges: ${res.edges.map((e) => (e > 0 ? `▮${e}` : `·${-e}`)).join(' ')}`);
  console.log(`  decoded (seed ${seed} WPM): "${res.text}"  unit≈${Math.round(res.unitMs)}ms (${res.estWpm} WPM)`);
}
