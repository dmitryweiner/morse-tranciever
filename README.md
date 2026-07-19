# Morse Transceiver

A browser Morse code trainer that transmits and receives real audio.
No backend, no runtime dependencies — pure Web Audio + SVG.

## Modes

- **Transmit** — two key types, switchable:
  - *Straight* — one big brass key (button or Space bar): short press is a
    dot, long press is a dash, exactly like a classic straight key.
  - *Paddle* — dash and dot buttons (or ←/→): element length is generated
    automatically at the set WPM, holding a paddle repeats the element,
    holding both alternates them (iambic squeeze), and a tap during the
    inter-element gap is remembered — like a real electronic keyer.

  Pause to finish a letter, pause longer to insert a word gap.
- **Receive** — continuously analyses the microphone, detects a CW tone
  (300–3400 Hz band — covers radio sidetones and household 2–3 kHz beepers,
  sender's exact pitch doesn't matter) and decodes it. A tonality filter
  (spectral contrast + peak-frequency stability) rejects background noise and
  speech; decoding speed adapts to the incoming signal automatically and
  button-bounce glitches are filtered.

Two phones running this page can talk to each other over the air.

Both modes drive the same **dichotomic tree diagram** (the classic brass
training card): as elements arrive, the path from the antenna lights up —
dash goes left, dot goes right — and the committed letter flashes its node.
Decoded/keyed text accumulates in a line below the current letter.

## Settings

- **Speed** (5–30 WPM, PARIS standard) — sets the dot/dash threshold for the
  key and seeds the receive decoder's speed estimate (it then auto-tracks the
  sender within roughly ±2×).
- **Tone** (400–3400 Hz) — sidetone pitch for transmission.

Alphabet: letters A–Z (ITU codes), matching the training-card diagram.

## Development

```bash
npm install
npm run dev        # Vite dev server on :5173
npm run check      # typecheck + lint + unit tests
npm run shot       # headless screenshots + TX smoke (keys the letter A)
npm run rx         # end-to-end receive test: generated Morse WAV → fake mic
npm run rx -- --file rec.wav   # feed a real recording through the browser
npm run wav -- rec.wav         # offline analysis: spectrum, envelope, decode
npm run build      # production build into ./docs
```

The DSP/decoding logic (`src/morse/*`) is pure TypeScript with no Web Audio
dependencies and is fully unit-tested; audio and DOM glue live in
`src/audio/*`, `src/ui/*`, `src/main.ts`.
