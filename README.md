# Morse Transceiver

A browser Morse code trainer that transmits and receives real audio.
No backend, no runtime dependencies — pure Web Audio + SVG.

## Modes

- **Transmit** — two key types, switchable:
  - *Straight* — one big brass key (button or Space bar): short press is a
    dot, long press is a dash, exactly like a classic straight key.
  - *Paddle* — dash and dot buttons (keyboard: ←/→ or `-`/`.`): element
    length is generated automatically at the set WPM, holding a paddle repeats
    the element,
    holding both alternates them (iambic squeeze), and a tap during the
    inter-element gap is remembered — like a real electronic keyer.

  Pause to finish a letter, pause longer to insert a word gap.

  You can also type a line of text and hit **Send** — the app keys it for
  you with textbook PARIS timings at the selected speed, highlighting the
  letter being sent. Pressing any key aborts the transmission.

  **Record** captures your keying (straight, paddle or Send) and downloads
  it as a WAV file with the sidetone rendered at the selected Tone pitch —
  16-bit PCM, up to 2 minutes; the file plays anywhere and feeds straight
  back into the Receive mode or the offline tools.
- **Receive** — continuously analyses the microphone, detects a CW tone
  (300–3400 Hz band — covers radio sidetones and household 2–3 kHz beepers)
  and decodes it. The carrier frequency is detected and locked automatically
  (shown next to the WPM estimate; tones on other frequencies are ignored
  until a new carrier persists). A tonality filter (spectral contrast +
  peak-frequency stability) rejects background noise and speech; decoding
  speed adapts to the incoming signal automatically — including the sender's
  dash/dot ratio (many real beepers squeeze dashes to ~2× a dot instead of
  the textbook 3×) — and button-bounce glitches are filtered.

  Note: microphone access requires a secure context — serve the page over
  HTTPS (or open it as `localhost`, e.g. via `adb reverse` when testing on
  an Android phone).

Two phones running this page can talk to each other over the air.

Both modes drive the same **dichotomic tree diagram** (the classic brass
training card): as elements arrive, the path from the antenna lights up —
dash goes left, dot goes right — and the committed letter flashes its node.
Dashes are brass bars, dots are patina-teal circles (the paddle buttons and
the running code readout share the same shapes and colours). Decoded/keyed
text accumulates in a line below the current letter.

## Settings

- **Speed** (5–30 WPM, PARIS standard) — sets the dot/dash threshold for the
  key and seeds the receive decoder's speed estimate (it then auto-tracks the
  sender within roughly ±2×).
- **Tone** (400–3400 Hz) — sidetone pitch for transmission.

Alphabet: letters A–Z, digits 0–9 and common punctuation `. , ? / = + - @`
(ITU codes). The tree diagram shows the letters (as on the training card);
for longer codes the path lights up to the fourth level and the full code is
visible in the code readout.

## Development

```bash
npm install
npm run dev        # Vite dev server on :5173
npm run check      # typecheck + lint + unit tests
npm run shot       # headless screenshots + TX smoke (keys A on the straight
                   # key, T on the paddle)
npm run rx         # end-to-end receive test: generated Morse WAV → fake mic
npm run rx -- --file rec.wav   # feed a real recording through the browser
npm run wav -- rec.wav         # offline analysis: spectrum, envelope, decode
npm run build      # production build into ./docs
```

The DSP/decoding logic (`src/morse/*`) and the offline WAV testbench
(`src/analysis/wavlab.ts`) are pure TypeScript with no Web Audio dependencies
and are fully unit-tested; audio and DOM glue live in `src/audio/*`,
`src/ui/*`, `src/main.ts`.
