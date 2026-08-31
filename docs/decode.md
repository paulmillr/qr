# Decoding architecture

Scope: `src/decode.ts` (`decodeQR`, `decodeQRBatch`, `_QRScanner`). The file is
self-contained except for the spec knowledge it imports from `src/index.ts` —
`BYTES`, `ECC_BLOCKS`, `ECC_LEVELS`, `WORDS_PER_BLOCK`, `ALPHANUMERIC`,
`formatBits`, `versionBits`, `popcnt`, `GF256`, `maskBits`. Those are exported
with a `_` prefix and never copied, so there is one source of spec truth. Measured
latency/accuracy/bundle numbers live in `benchmark/README.md`
(`npm run benchmark`, `benchmark:quality`). We do not repeat them here — this file
is about structure and rationale.

## Design rationale

**Video vs photo.** There are two decode workloads, and they pull in different
directions. Video — live scanners — is the main one and what this decoder is built
for. The time budget per frame is very tight, but retries are almost infinite: if a
frame fails (blur, defocus, shaking hands, sensor noise), just exit and wait for
the next frame. Spending too long retrying inside one frame means skipping the
next, possibly much better, frame that is already on its way. Photo is what most
libraries (ZXing, for example) optimize for. There is no next frame, so all
retrying has to happen inside the single image. Multi-QR matters here too — nobody
will reposition the camera after the photo is taken — and crop-to-square guidance
makes no sense for the same reason. The `effort` / `timeLimit` options cover both:
the defaults are tuned for video, `Infinity` on both is the photo shape.

**Luma-first.** QR decoding only needs luma (a grayscale image). Camera and image
feeds are rarely RGBA — if we ask for RGBA, the source converts to RGB(A) and we
convert back to grayscale, which is `4 × pixels` of work. Major formats (NV12,
I420, JPEG, …) already have a luma plane inside, so we read it directly and skip
both conversions. The same trick applies to photos: it is easier to pull luma out
of most containers than to materialize full RGB(A) — see the jpeg/png/gif readers
in `test/imgcoder`. Luma values differ slightly between formats (JPEG and NV12
weight the channels a bit differently); that is fine.

**Retry triples, not binarizations.** Everything is very sensitive to the
binarizer, which makes "passing test vectors" easy: just find a set of retry
binarizations that works for the selected photos and videos. That is wrong — we do
not control the camera, the image format, or how much conversion already happened,
so it overfits. Instead of retrying binarizations, we stay with one fixed
binarization and retry different finder triples on different pyramid layers.

The per-frame path targets **zero allocations**. Every buffer is preallocated in
the `_QRScanner` constructor for `maxSize`. Hot helpers are written so V8
scalar-replaces their return objects — we verified this with TurboFan
escape-analysis listings, and comments in the source mark the spots where an
iterator or object allocation had survived. Control-flow failures are frozen
singleton `Error` *values* (the `FAIL` map), not throws, so the hot path never
pays for stack capture. `decodeQR` throws a fresh Error only at the API boundary.

`multiPass` is kept for source compatibility but is a no-op — the fixed pyramid
scan treats every input the same way. Effort is now two orthogonal options:
`effort` (how many retry triples may be attempted; default 1 = only the mandatory
attempt; `Infinity` allowed) and `timeLimit` (wall-clock milliseconds available to
retries; default one 60-FPS frame; `Infinity` allowed).

## Pipeline

Scanner lifecycle:

```
_QRScanner(maxSize)           preallocates every arena: native luma, up to 4
  │                           pyramid layers (luma, blocks, cuts, packed bitmap,
  │                           finder records, retry-set heap), grid/tmp scratch,
  │                           RS + payload buffers
  ├─ addImage / processImage  copyLuma into the native arena (packed RGB(A),
  │                           planar Y incl. 10/12-bit, or zero-copy when the
  │                           caller wrote luma directly, e.g. QRCamera's
  │                           VideoFrame.copyTo); stage() resets per-frame state
  ├─ decode() / decodeAsync() drive the scan() generator — sync drains it,
  │                           async yields to the host scheduler
  └─ clean()                  reflective zeroize of every typed-array field
                              (lifecycle, not per-frame; decodeQR runs it in
                              `finally` — no image data survives a one-shot call)
```

One scan:

```
scan()
  ├─ resize                   2x2 box-filter pyramid, layer i = 2^i downscale,
  │                           dropped below a 64px short side
  └─ rounds over layers, coarsest first
       ├─ per layer, once     blocks (8x8 stats) → bitmap (5x5-smoothed cuts +
       │                      packed 1-bit plane) → imageOnBitmap? → find
       │                      (finder candidates, both polarities)
       ├─ round 0             mandatory, budget-free: pickPolarity ×2 → best triple
       ├─ rounds 1+           pop the per-layer retry-set heap, skipping the
       │                      round-0 pick's id bag; each pop consumes `effort`,
       │                      the round loop stops at `timeLimit`
       └─ per attempted triple
            ├─ refine         template refit for large blurred symbols; else a
            │                 failed projection retries once after cross refinement
            ├─ projectWith    dimension candidates {est, mean, est±4}, then per
            │    │            candidate:
            │    ├─ BR corner    perspective 4th corner / bitmap aligner search
            │    ├─ timing gate  2·size projected samples must agree ≥75%
            │    ├─ v<7          global projection; on failure, fine-plane retry
            │    │               against native luma
            │    └─ v7+          confirm (timing + version word) → tiled
            │                    alignment-lattice projection; falls back to the
            │                    global map (fine, then coarse)
            └─ decodeGrid     format/version words → RS correction → payload
```

## Input ingestion

`copyLuma` handles three source shapes behind one validated entry:

- Packed RGB/RGBA/RGBX/BGRA/BGRX: luma = `(r + 2g + b) >> 2`. The fourth byte is
  ignored, and R/B symmetry makes the swapped formats free.
- Planar luma-first formats: I420/I420A/I422/I444/NV12 read a tight Y plane at
  offset zero; I420P10/P12 shift 16-bit samples down to 8.
- The zero-copy path, where the integration wrote luma straight into
  `scanner.luma` (`processImage` with an offset/stride layout). `QRCamera`
  arranges `VideoFrame.copyTo` so the first bytes *are* the luma plane and no
  second copy happens.

Without `opts.format`, RGB vs RGBA is detected by exact data length. `decodeQR`
builds a scanner sized to the image; `decodeQRBatch` reuses one 4K-capacity
scanner across images.

## Pyramid + binarizer (`scanRows.resize/blocks/bitmap`)

Up to four layers. Each is an exact `(a+b+c+d+2)>>2` box-filter halving of the
previous one — a x2 reduction costs 25% of the layer above, so the whole pyramid
is ~33% extra work, and it buys a fast path for large, clearly visible symbols.

Per 8x8 block we take sum/min/max of luma and derive a cut: the mean, or `min/2`
for low-contrast blocks (`max-min <= 24`). If even the darkest sample is brighter
than that, the cut is pulled up to a weighted average of already-computed neighbor
cuts — this keeps flat regions classified against their surroundings (the ZXing
hybrid rule, with predecessor propagation). Block cuts are then 5x5-smoothed, and
each block's 8x8 pixels are thresholded into a **packed 1-bit bitmap**
(`Uint32Array`, one word = 32 pixels — packing pays in word-at-a-time traversal,
not just storage). The smoothed cuts are *also* kept per block (`Int16Array`),
because projection later re-thresholds raw luma through them instead of reading
the bitmap (see "planes" below).

All stages are row-ranged, so the cooperative scanner can yield between bounded
chunks without duplicating loops.

## Finder detection (`scanRows.find`, `run`, `cross`)

We row-scan every 2nd row for 1:1:3:1:1 runs with a rolling 5-run window (no
per-row allocations), in **both polarities** — inverted QR support falls out of
tracking a polarity bit per candidate instead of re-binarizing. Horizontal `run()`
consumes whole bitmap words with `Math.clz32` and can skip up to 32 pixels per
step; vertical runs step per bit. Each seed is cross-checked vertically, then
horizontally (`cross`, half-module tolerance in `ratio`). Observations within two
modules of an existing center merge into it, with confidence counting. Candidates
live in a flat `Float64Array` (stride 4: x, y, moduleSize, row-hit count) plus a
per-candidate state byte (polarity | excluded | consumed-by-decode).

The half-module `ratio` tolerance is fixed. There is no loosened retry tolerance —
robustness comes from retrying *different triples on different pyramid layers*
instead. **All 40 versions × 4 ECC levels round-trip on clean synthetics** (pinned
in `test/decode.test.ts`); any selection/gate change must keep that true.

## Triple selection

**Round 0 (mandatory)** is budget-free, and its pick is committed. `pickPolarity`
ranks each polarity's triples independently (a shared score lost ~30% of video
decodes) by a side-length geometry error. Several measured guards are baked in: a
module-ratio gate that scale-consistent upper-layer confirmations can rescue
(perspective squeeze otherwise lost 46/168 perspective decodes); a relative-error
ambiguity band that switches to a confidence-weighted rank in sparse scenes; and
raw geometry in crowded scenes, so finders of adjacent symbols cannot be mixed.
The winning polarity is picked by geometry-error × evidence. We record the pick's
unordered id multiset (sum/min/max), so the retry schedule can skip it without
bookkeeping.

**Rounds 1+** pop a per-layer schedule that is built lazily, once: every plausible
same-polarity triple within scale/distance/leg-ratio/angle gates, ranked by
compactness normalized by row-hit evidence, kept in a bounded 256-entry max-heap
and then heap-sorted ascending. Only retry pops consume `effort`; the round loop
re-checks `timeLimit` before each layer. Coarse layers come first in every round —
most camera-resolution frames succeed at a fraction of the pixels.

Before projection a triple may get refinement. Large blurred symbols (detected via
edge pitch on rotated tall symbols) get a grayscale **template refit**
(`fitPattern`, an axis-independent 5x5-template scan over sub-pitch scales).
Otherwise a failed projection retries once after a plain cross-refinement pass.

## Projection + sampling (`projectWith`)

A `Plane` is luma + the block-cut grid + a shift `sh` relating pixel to block
coordinates. `read()` maps a module center through the homography and thresholds
`luma <= cut[block]` on the fly (flipped for inverted symbols). **No sampled
bitmap is materialized** for projection; the packed bitmap serves detection only.

Dimension: up to four candidates — a pitch/edge estimate snapped to a legal size,
a mean-module estimate, then ±4. Each is rejected if it lands more than six
modules from its snap. The bottom-right corner starts as the affine parallelogram
estimate and gets upgraded to a located alignment pattern: either a
perspective-predicted position (4th-corner recovery from the three finder pitches
via the 2/3-power pitch law, cross-validated against the affine estimate) driving
a projected 5x5-template search (`searchAlign`), or a direct bitmap window search
for an isolated ~1-module dark run (`findBasicAlign`). Data can look like an
aligner, so the affine estimate is also tried when the aligned attempt fails.

Every candidate homography must first pass the **timing tracks** (row/column 6):
2·size projected samples must agree with the checkerboard at ≥75%, and we abort
the moment the gate becomes unreachable. A wrong triple or dimension reads ~50%
and dies within 2·size samples instead of paying size² + zigzag + Reed-Solomon.
(The format word cannot serve as this gate: at hamming ≤3 over 64 candidates it
matches random bits almost surely.)

- **Version < 7**: global projection on the layer's plane. On failure, the **fine
  upgrade** retargets the same homography to native luma (`upgrade`: layer pixel x
  sits at `2^r·x + (2^r-1)/2`), reusing the coarse cut grid at shift `sh + r`.
  Zero extra binarization — and it is how blur that survives downscaling gets a
  second chance at native sharpness.
- **Version ≥ 7**: prefer the fine plane outright, then `confirm` — timing plus
  the redundant 18-bit BCH version word (radius ≤ 3 on either copy) — before
  paying for the expensive part: a **tiled alignment-lattice projection**. Every
  alignment position is template-searched (`searchAlign`, smallest-offset
  tie-breaking); located centers replace predicted lattice nodes, and each lattice
  cell gets its own homography. This is what lifts dense v7+ accuracy past the
  single-homography ceiling — perspective and print distortion accumulate across
  the symbol faster than one anchored corner can correct. A false local alignment
  can corrupt a valid global projection, so failures fall back to the global map
  (fine, then coarse).

## Symbol decode (`decodeGrid`)

Version word first (v7+, radius-3 BCH on either copy). Both 15-bit format copies
are matched against all 32 `(ecc, mask)` candidates at hamming ≤ 3; up to two
distinct candidates are tried, closer copy first. The function-pattern map, the RS
polynomials (syndromes/σ/previous/next), the deinterleaved blocks and the
corrected payload all live in slices of two shared scratch arrays. Their lifetimes
are staged to never overlap; comments in the source mark each phase handoff. The
zig-zag read mirrors the encoder's placement walk and unmasks via the shared
`maskBits`; Berlekamp-Massey + Chien/Forney correct each block in place.

Payload parsing (`Payload`): numeric/alphanumeric/byte modes with per-class length
bits. ECI designators are tracked per ISO/IEC 18004 §7.4.3.4 across a prebuilt
`TextDecoder` table; byte segments are staged into a reusable buffer with
length-prefix subarray views, so decoding allocates only the result string. Kanji
(mode 8) is unsupported and fails cleanly. A caller-supplied `textDecoder` gets
byte segments deferred as `[bytes, eci]` parts, delivered after RS succeeds.

## Scheduling: one generator, two drivers

`scan()` is a generator that yields between bounded work chunks (resize rows,
block rows, finder rows, retry pops). `decode()` drains it synchronously.
`decodeAsync()` awaits `scheduler.yield()` (or a zero-delay task) after each ~8ms
quantum — free cancellation, no UI blocking. Each yield reports the time spent
waiting, and that time is credited back to the retry deadline, so host scheduling
delay does not eat the `timeLimit` budget.

## Multi-QR + exclusion

`decode(all)` / `decodeQRBatch` re-run the scan after each success, sharing one
retry budget and deadline. A decoded symbol writes its projected region into its
own now-dead finder records (no allocation) and marks those finders consumed. On
every layer, finder candidates that fall inside any decoded region (an affine test
with one-module padding, coordinates mapped across layer scales) are excluded from
future picks and schedules. `decodeQRBatch` isolates per-image errors, so one bad
image cannot discard neighboring results.

## Callbacks

`pointsOnDetect` fires **once per scan**, when a search succeeds or terminally
fails. It gets the winning (or last) attempt's geometry mapped back to input
coordinates: finder centers with per-corner quads, the projected virtual BR, every
alignment pattern actually located (tiled searches included, with their local
corrections), plus `bounds`/`outline`/`boundingBox`. `imageOnResult` fires with
the sampled grid as a 1px/module RGBA image. `imageOnBitmap` (debug) fires per
binarized layer with exactly what detection sees. Precision of the reported points
varies with the winning layer.

Known gap: an exception thrown by a user callback inside the retry loop is
swallowed by the per-triple failure path instead of propagating. We accepted that
to avoid rethrow plumbing; it is irrelevant for `QRCanvas`'s fail-soft camera
loop.

## Privacy / lifecycle

`clean()` sweeps every typed-array field on the scanner and its layers
reflectively and resets all dimensions (the `Object.values` allocation is fine
outside the frame loop, and new arenas cannot be forgotten by construction).
One-shot `decodeQR` calls it in `finally`, so no image data survives the call.
Reusable DOM scanners clean when their source is released. `decodePayload` is a
`protected` hook, so alternate backends (wasm) can replace payload parsing while
keeping the scan machinery.
