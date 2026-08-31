# Encoding architecture

Scope: `src/index.ts` (`encodeQR`). This file also owns every spec-level table the
decoder imports. Those are exported with a `_` prefix — private API — as named
values rather than one bag object, so decode-only bundles can tree-shake per
symbol. The file imports nothing.

We optimize for bundle size and repeat-encode speed together. Every speed feature
in this file paid for its bytes in a per-change measurement; the ones that did not
are listed under "Deliberately not implemented". Bundle sizes and speed numbers
live in `benchmark/README.md` (`npm run benchmark`). We do not repeat them here —
they go stale. This file is about structure and rationale.

## Pipeline

```
encodeQR(text, output, opts)
  ├─ validate opts (ecc / encoding / mask / border / scale)
  ├─ detectType(text)            numeric ⊂ alphanumeric ⊂ byte (no kanji/ECI),
  │                              via ALNUM_VAL charCode LUT. Single segment
  │                              only — deliberate anti-fingerprinting (see
  │                              README Security); do NOT "optimize" into
  │                              mixed segments
  ├─ version pick                `encodedBits` computed arithmetically from
  │                              payload length + mode; smallest version read
  │                              straight off the capacity tables, so the
  │                              payload is never encoded speculatively
  ├─ encodeData(ver, ecc, ...)   mode+length header → payload bits (MSB-first
  │                              bit accumulator, byte-at-a-time flush) →
  │                              padding → RS parity per block (cached
  │                              256×n product table) → block interleaving
  ├─ drawSymbol(ver, ecc, data, mask?)
  │    ├─ SymCache               per-version template, zigzag order, mask
  │    │                         planes (+transposes), pooled work matrices —
  │    │                         built once, reused across encodes
  │    ├─ data scatter           template copy + data bits along the cached
  │    │                         zigzag positions
  │    ├─ mask selection         candidate = base ^ plane (wordwise XOR, both
  │    │                         orientations from cached transposed planes),
  │    │                         scored by early-aborting penaltyScore();
  │    │                         first lowest wins (python-qrcode ties)
  │    └─ drawInfo               format/version words stamped last
  └─ render dispatch             raw | ascii | term | svg | gif | data-url —
                                 one module-level function per format over a
                                 Raster context (see Renderers below)
```

`Mat` is the packed bit matrix everything above draws into:
`{ size, words, v: Uint32Array }` — LSB-first bits, `words = ceil(size/32)` u32 per
row. Invariant: bits at `x >= size` stay zero. The penalty scanners rely on that.
`matGet`/`matSet` are the readable general path; the zigzag walk and the mask XOR
touch `v` directly.

## Optimizations

### 1. SymCache: per-version symbol cache

Everything that depends only on the symbol layout is built once per version and
kept in a single module-level slot (`symCache`): the function-pattern template
(data region zero), the zigzag placement order as packed
`(wordIndex << 5 | bitOffset)` positions, the 8 mask XOR planes restricted to data
cells, their transposes, and four pooled work matrices. After that, `drawSymbol`
per encode is just a template copy plus a scatter of data bits along the cached
positions.

Why a single slot? Real workloads overwhelmingly encode one version again and
again. Worst case (v40) is ~190KB. A workload that alternates versions rebuilds
the cache on every encode — we measured that and accepted it (`test` builds
exercise alternation for correctness). This replaced rebuilding the template +
mask planes per encode and is the largest single speed win in the file.

### 2. Word-parallel penalty scoring, with early abort

Auto-mask selection scores 8 candidates per encode, and `penaltyScore()` is where
large encodes spend most of their time. So all four ISO 18004 §7.8.3.1 rules run
over packed words:

- **N1 runs** (`runsPenaltyVertical`): XOR adjacent rows — `D_y = row ^ row+1`
  flags color changes. A run of length L ≥ 5 scores 3 + (L−5). We decompose that
  as "monochrome 5-windows plus twice the run-start windows among them", which is
  4 ORs + 2 popcounts per word, 32 columns per stripe, no vertical shifts. Rows
  are scored by scoring the transpose.
- **N2 boxes + N4 dark balance**: fused into one pass over the rows. Overlapping
  2x2 same-color boxes come from shifted AND-equality words; the dark count is a
  popcount.
- **N3 finder lookalikes** (`finderPenaltyVertical`): both 11-module patterns
  (1011101 plus a quiet run on either side) are matched branch-free. The 11 row
  words are loaded once and combined into two AND/NOT expressions per window
  position.
- `popcnt` is a 16-bit LUT (`POP16`, 64KB, PURE-initialized). It measured both
  smaller gzipped *and* faster than the SWAR version it replaced.

The mask race uses two structural facts. First, transposition is a bit
permutation, so `T(data ^ plane) = T(data) ^ T(plane)`. That means we transpose
the base matrix **once** per encode and build each candidate's transpose by XOR
with the cached transposed plane — no butterfly transpose per mask. Second, all
penalty terms are non-negative, so `penaltyScore(m, t, limit)` can return as soon
as a partial sum reaches the best score seen. The expensive N3 scan is skipped for
most losing masks. Both tricks leave the chosen mask provably identical.

### 3. Renderers: one module-level function per format

`encodeQR` ends in a dispatch over `renderRaw` / `renderAscii` / `renderTerm` /
`renderSvg` / `renderGif` / `gifDataUrl`. Each is a top-level function taking a
`Raster { m, W, map }` context. `map` is a precomputed `Int32Array` that
translates output coordinates to module indices (border and scale folded in, −1
in the quiet zone), and `dark(r, x, y)` reads through it. No scaled intermediate
bitmap exists at any output size.

They are separate functions **for JIT isolation, not organization**. As branches
of one function body, all formats share a single V8 optimization unit and
type-feedback pool, and editing one format's code measurably slowed another
format's hot loop. Do not refold them.

- `raw` builds its `boolean[][]` with plain nested loops. The previous
  `Array.from` closures cost more than the entire symbol computation.
- `gif` writes an uncompressed GIF87a directly (fixed 2-entry palette, raw LZW
  clear-code stream, 126-pixel chunks). Pixels come from a per-module-row 0/1
  buffer, rebuilt only when the module row changes — border rows and
  scale-repeated rows reuse it — and block-copied in spans bounded by the LZW
  chunk boundaries. The span copy is the load-bearing part: a row buffer with a
  per-pixel emit loop measured as no win at all.
- `data-url` wraps the same GIF via native `toBase64` (ES2026) where available,
  chunked `btoa` elsewhere. The fallback is not a hot spot: after the split,
  data-url measures within ~1 µs of gif even on fallback engines. An apparent
  ~40 µs "base64 cost" in the old monolith was really cross-format JIT coupling.
- `svg` (with `optimize`, the default) merges modules into relative-move path
  segments. The remaining cost is emitting a string per dark module, and the only
  way to reduce it is changing the emitted path format — a compatibility
  decision, not an optimization.
- `ascii` emits half-blocks two rows at a time; `term` emits two spaces per
  module.

### 4. Reed–Solomon, sized for encoding only

The encoder RS (`rsGenerator`/`rsCached`/`rsEcc`) is not shared with the decoder's
corrector — only the `GF256` field is. Its log/exp tables are built in a
`/* @__PURE__ */` IIFE, so bundlers can drop them when a consumer needs neither RS
side. The EXP table is doubled, so a product of two logs indexes it without a mod.

`rsCached(eccWords)` lazily builds, per parity length, the generator plus a 256×n
table of all coefficient×feedback products (`RS_CACHE`). Every block and every
later encode at that length shares it, and the `rsEcc` hot loop becomes a fused
shift-XOR-lookup pass with no backward pass. The table-less fallback (the original
`copyWithin` LFSR) stays for direct `_tests.rsEcc` use with arbitrary generators.
Parity runs over `subarray` views of the codeword buffer, so splitting into blocks
allocates no copies.

## Allocation and retained state

Per encode we allocate: the output value, the `raw`/gif row structures, and (byte
mode) the UTF-8 buffer. The symbol matrices are **not** allocated per encode —
`drawSymbol` works in the four matrices pooled in SymCache, and `transposeMat`
uses a shared 32-word tile (`TRANSPOSE_TMP`). Module-level retained state is all
caches: `symCache` (single version slot, ~190KB worst case), `RS_CACHE` (256×n per
parity length used), `POP16` + `GF256` + `ALNUM_VAL` (fixed LUTs).

One consequence of the pooling: the returned `raw`/string/gif outputs never alias
the pooled matrices, and `drawSymbol`'s result must be fully consumed before the
next encode reuses the pool. That holds for every call site — `encodeQR`
serializes before returning.

## Deliberately not implemented

- **Single-segment encoding only.** Mixed numeric/alphanumeric/byte segmentation
  would shave a few % off symbol size, but it fingerprints the encoder (README
  Security). Not an oversight.
- The tri-state `Bitmap` drawing DSL and verbose validation messages.
- Shared fillRow row-expansion for the string renderers, the base64 TextDecoder
  fallback, and a `TextEncoder` singleton — measured during the 0.7.0 rewrite and
  excluded: the wins did not cover their bytes.
- Known headroom: svg path emission (~70% of svg time, blocked on output-format
  compatibility, see above) and ~5–10 µs per string format from fillRow.
