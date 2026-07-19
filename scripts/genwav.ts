// Генератор тестовых WAV с морзянкой РЕАЛЬНЫМИ модулями приложения:
// TextSender даёт тайминги (как кнопка Send), renderToneWav — звук (как
// запись передачи). Удобен для ручной проверки Upload/приёма и отладки
// декодера на синтетике с точными таймингами.
//
//   npm run gen -- --msg "SOS SOS" [--wpm 15] [--hz 600] [--sr 16000]
//                  [--out shots/gen.wav]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TextSender } from '../src/morse/sender';
import { renderToneWav, type ToneMark } from '../src/audio/txrecord';
import { encodeWAV } from '../src/audio/wav';
import { unitMs } from '../src/morse/timing';

const args = process.argv.slice(2);
let msg = 'SOS';
let wpm = 15;
let hz = 600;
let sr = 16000;
let out = 'shots/gen.wav';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--msg') msg = args[++i];
  else if (args[i] === '--wpm') wpm = Number(args[++i]);
  else if (args[i] === '--hz') hz = Number(args[++i]);
  else if (args[i] === '--sr') sr = Number(args[++i]);
  else if (args[i] === '--out') out = args[++i];
}

const LEAD_MS = 500;
const sender = new TextSender(() => unitMs(wpm));
sender.start(msg, 0);
const marks: ToneMark[] = [];
let onAt: number | null = sender.isToneOn ? 0 : null;
for (let t = 1; sender.isSending && t < 600_000; t++) {
  sender.tick(t);
  if (sender.isToneOn && onAt === null) onAt = t;
  else if (!sender.isToneOn && onAt !== null) {
    marks.push({ startMs: onAt + LEAD_MS, endMs: t + LEAD_MS, hz });
    onAt = null;
  }
}
if (!marks.length) {
  console.error(`в строке "${msg}" нет ни одного известного символа`);
  process.exit(1);
}

const pcm = renderToneWav(marks, sr);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, new Uint8Array(encodeWAV(pcm, sr)));
console.log(
  `${out}: "${msg}" @ ${wpm} WPM, ${hz} Гц, ${sr} Гц, ` +
  `${(pcm.length / sr).toFixed(1)} с, ${marks.length} меток`,
);
