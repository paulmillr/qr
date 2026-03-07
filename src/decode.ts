/*!
Copyright (c) 2023 Paul Miller (paulmillr.com)
The library paulmillr-qr is dual-licensed under the Apache 2.0 OR MIT license.
You can select a license of your choice.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
/**
 * Methods for decoding (reading) QR code patterns.
 * @module
 * @example
```js

```
 */

import type { EncodingType, ErrorCorrection, Image, Mask, Point } from './index.ts';
import { Bitmap, utils } from './index.ts';
const { best, bin, drawTemplate, fillArr, info, interleave, validateVersion, zigzag, popcnt } =
  utils;

// Constants
const MAX_BITS_ERROR = 3; // Up to 3 bit errors in version/format
const GRAYSCALE_BLOCK_SIZE = 8;
const GRAYSCALE_RANGE = 24;
const PATTERN_VARIANCE = 2;
const PATTERN_VARIANCE_DIAGONAL = 1.333;
const PATTERN_MIN_CONFIRMATIONS = 2;
const DETECT_MIN_ROW_SKIP = 3;
// Pair LUTs for the 8x8 block-stat fast path: each 16-bit lane holds two
// brightness bytes, so we can accumulate sum/min/max four pixels at a time.
const SUM16 = new Uint16Array(1 << 16);
const MIN16 = new Uint8Array(1 << 16);
const MAX16 = new Uint8Array(1 << 16);
for (let i = 0; i < SUM16.length; i++) {
  const lo = i & 0xff;
  const hi = i >>> 8;
  SUM16[i] = lo + hi;
  MIN16[i] = lo < hi ? lo : hi;
  MAX16[i] = lo > hi ? lo : hi;
}

// TODO: move to index, nearby with bitmap and other graph related stuff?
const int = (n: number) => n >>> 0;

type Point4 = [Point, Point, Point, Point];
export type FinderPoints = [Pattern, Pattern, Point, Pattern];
// distance ^ 2
const distance2 = (p1: Point, p2: Point) => {
  const x = p1.x - p2.x;
  const y = p1.y - p2.y;
  return x * x + y * y;
};
const distance = (p1: Point, p2: Point) => Math.sqrt(distance2(p1, p2));
const sum = (lst: number[]) => lst.reduce((acc, i) => acc + i);
const pointIncr = (p: Point, incr: Point) => {
  p.x += incr.x;
  p.y += incr.y;
};
const pointNeg = (p: Point) => ({ x: -p.x, y: -p.y });
const pointMirror = (p: Point) => ({ x: p.y, y: p.x });
const pointClone = (p: Point) => ({ x: p.x, y: p.y });
const pointInt = (p: Point) => ({ x: int(p.x), y: int(p.y) });
const pointAdd = (a: Point, b: Point) => ({ x: a.x + b.x, y: a.y + b.y });
// Count trailing zeroes in a packed bitmap word so scanLine can skip whole
// runs instead of testing one bit at a time.
const ctz32 = (v: number) => {
  v = v >>> 0;
  if (v === 0) return 32;
  return 31 - Math.clz32((v & -v) >>> 0);
};
function cap(value: number, min?: number, max?: number) {
  return Math.max(Math.min(value, max || value), min || value);
}
function getBytesPerPixel(img: Image): number {
  const perPixel = img.data.length / (img.width * img.height);
  if (perPixel === 3 || perPixel === 4) return perPixel; // RGB or RGBA
  throw new Error(`Unknown image format, bytes per pixel=${perPixel}`);
}
function isBytes(data: unknown): data is Uint8Array {
  return data instanceof Uint8Array || data instanceof Uint8ClampedArray;
}
/**
 * Convert to grayscale. The function is the most expensive part of decoding:
 * it takes up to 90% of time.
 *
 * Binarization pipeline:
 * 1. Convert RGB/RGBA image to one luma byte per pixel.
 * 2. Split the image into 8x8 blocks and collect per-block mean/min/max.
 * 3. Build a 5x5 neighborhood mean over those block means.
 * 4. Turn each 8x8 block into bitmap bits using a local cut derived from:
 *    - the neighborhood mean,
 *    - the current block statistics,
 *    - a cheap whole-image color-spread estimate,
 *    - and, on risky scenes, a local variance field over block means.
 *
 * Instead of producing "best looking" thresholding: we produce a
 * bitmap where finder patterns survive perspective / blur / highlights while
 * keeping false dark regions low enough for downstream finder selection.
 */
function toBitmap(img: Image): Bitmap {
  const width = img.width;
  const height = img.height;
  const data = img.data;
  const bytesPerPixel = getBytesPerPixel(img);
  const pixLen = height * width;
  const brightness = new Uint8Array(pixLen);
  if (bytesPerPixel === 4 && isBytes(data) && (data.byteOffset & 3) === 0) {
    // Little-endian RGBA: compute four grayscale bytes and commit as one u32 store.
    // Unaligned RGBA subarray views are still valid inputs; they fall back to
    // the scalar path because Uint32Array would throw on a misaligned offset.
    const pixels = new Uint32Array(data.buffer, data.byteOffset, pixLen);
    const bright32 = new Uint32Array(
      brightness.buffer,
      brightness.byteOffset,
      brightness.length >>> 2
    );
    const n4 = pixels.length & ~3;
    for (let i = 0, j = 0; i < n4; i += 4, j++) {
      const v0 = pixels[i] >>> 0;
      const v1 = pixels[i + 1] >>> 0;
      const v2 = pixels[i + 2] >>> 0;
      const v3 = pixels[i + 3] >>> 0;
      // RGBA words are little-endian here, so this is `(r + 2*g + b) / 4`
      // computed from the packed byte lanes for four pixels at once.
      const b0 = ((v0 & 0xff) + (((v0 >>> 8) & 0xff) << 1) + ((v0 >>> 16) & 0xff)) >>> 2;
      const b1 = ((v1 & 0xff) + (((v1 >>> 8) & 0xff) << 1) + ((v1 >>> 16) & 0xff)) >>> 2;
      const b2 = ((v2 & 0xff) + (((v2 >>> 8) & 0xff) << 1) + ((v2 >>> 16) & 0xff)) >>> 2;
      const b3 = ((v3 & 0xff) + (((v3 >>> 8) & 0xff) << 1) + ((v3 >>> 16) & 0xff)) >>> 2;
      bright32[j] = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    }
    for (let i = n4; i < pixels.length; i++) {
      const v = pixels[i] >>> 0;
      brightness[i] = ((v & 0xff) + (((v >>> 8) & 0xff) << 1) + ((v >>> 16) & 0xff)) >>> 2;
    }
  } else {
    for (let i = 0, j = 0, d = data; i < d.length; i += bytesPerPixel) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      brightness[j++] = int((r + 2 * g + b) / 4) & 0xff;
    }
  }
  // Sampled color spread is a cheap "scene type" signal:
  // grayscale / flat lighting scenes want conservative cuts, while colorful or
  // high-spread scenes benefit from a slightly darker threshold.
  let spreadSum = 0;
  let spreadCnt = 0;
  const spreadStep = bytesPerPixel * 16;
  for (let i = 0; i < data.length; i += spreadStep) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // hi=max(r,g,b), lo=min(r,g,b): this sampled channel spread is a cheap
    // scene-level proxy for "how colorful / highlighty is this frame?".
    const hi = r > g ? (r > b ? r : b) : g > b ? g : b;
    const lo = r < g ? (r < b ? r : b) : g < b ? g : b;
    spreadSum += hi - lo;
    spreadCnt++;
  }
  const spreadMean = spreadSum / spreadCnt;
  // Convert to bitmap
  const block = GRAYSCALE_BLOCK_SIZE;
  if (width < block * 5 || height < block * 5) throw new Error('image too small');
  const bWidth = Math.ceil(width / block);
  const bHeight = Math.ceil(height / block);
  const maxY = height - block;
  const maxX = width - block;
  const blockLen = bWidth * bHeight;
  const blockState = new Uint32Array(blockLen);
  // Each 8x8 block stores packed:
  // - bits 0..7: block baseline brightness used by the threshold field
  // - bits 8..15: block min
  // - bits 16..23: block max
  let hiRangeCnt = 0;
  let veryLowCnt = 0;
  const padW = (width + 3) & ~3;
  let statStride = width;
  let stat32: Uint32Array;
  if ((width & 3) !== 0) {
    const padLen = padW * height;
    const brightPad = new Uint8Array(padLen);
    for (let y = 0; y < height; y++) {
      const src = y * width;
      const dst = y * padW;
      brightPad.set(brightness.subarray(src, src + width), dst);
    }
    // Misaligned widths are padded only for the block-stat fast path.
    statStride = padW;
    stat32 = new Uint32Array(brightPad.buffer, brightPad.byteOffset, (padW * height) >>> 2);
  } else
    stat32 = new Uint32Array(brightness.buffer, brightness.byteOffset, brightness.length >>> 2);
  for (let y = 0; y < bHeight; y++) {
    const yPos = cap(y * block, 0, maxY);
    for (let x = 0; x < bWidth; x++) {
      const xPos = cap(x * block, 0, maxX);
      let sum = 0;
      let min = 0xff;
      let max = 0;
      // The stat-LUT fast path needs the 8-pixel row start to be 32-bit aligned
      // so each row can be read as two full u32 words without any shifts.
      if ((xPos & 3) === 0) {
        for (let yy = 0, pos = yPos * statStride + xPos; yy < block; yy++, pos += statStride) {
          const p = pos >>> 2;
          const w0 = stat32[p] >>> 0;
          const w1 = stat32[p + 1] >>> 0;
          const a0 = w0 & 0xffff;
          const a1 = w0 >>> 16;
          const b0 = w1 & 0xffff;
          const b1 = w1 >>> 16;
          sum += SUM16[a0] + SUM16[a1] + SUM16[b0] + SUM16[b1];
          const min0 = MIN16[a0];
          const min1 = MIN16[a1];
          const min2 = MIN16[b0];
          const min3 = MIN16[b1];
          if (min0 < min) min = min0;
          if (min1 < min) min = min1;
          if (min2 < min) min = min2;
          if (min3 < min) min = min3;
          const max0 = MAX16[a0];
          const max1 = MAX16[a1];
          const max2 = MAX16[b0];
          const max3 = MAX16[b1];
          if (max0 > max) max = max0;
          if (max1 > max) max = max1;
          if (max2 > max) max = max2;
          if (max3 > max) max = max3;
        }
      } else {
        for (let yy = 0, pos = yPos * width + xPos; yy < block; yy++, pos += width) {
          for (let xx = 0; xx < block; xx++) {
            const pixel = brightness[pos + xx];
            sum += pixel;
            if (pixel < min) min = pixel;
            if (pixel > max) max = pixel;
          }
        }
      }
      const bIdx = bWidth * y + x;
      const range = max - min;
      // Average brightness of block
      let average = sum >>> 6;
      if (range <= GRAYSCALE_RANGE) {
        // Low-contrast blocks are unstable if we threshold from their raw mean.
        // Bias toward the local dark floor, then smooth with already-seen
        // neighbors so finder rings don't disappear in washed-out regions.
        average = min / 2;
        if (y > 0 && x > 0) {
          const idx = (x: number, y: number) => y * bWidth + x;
          const neighborNumerator =
            (blockState[idx(x, y - 1)] & 0xff) +
            2 * (blockState[idx(x - 1, y)] & 0xff) +
            (blockState[idx(x - 1, y - 1)] & 0xff);
          if (min * 4 < neighborNumerator) average = neighborNumerator / 4;
        }
      }
      blockState[bIdx] = int(average) | (min << 8) | (max << 16);
      if (range > 40 && average < 224) hiRangeCnt++;
      if (range <= 10) veryLowCnt++;
    }
  }
  const hiRangeFrac = hiRangeCnt / blockLen;
  const veryLowFrac = veryLowCnt / blockLen;
  // These two scene gates are the main "policy" layer on top of the local cut:
  // - `spotBias` darkens globally flat, slightly colorful scenes that otherwise
  //   miss bright-spot / washed-out QR modules.
  // - `useVarField` avoids paying the variance-field cost on scenes where the
  //   plain 5x5 mean is already stable enough.
  const spotBias =
    veryLowFrac > 0.55 &&
    veryLowFrac < 0.66 &&
    hiRangeFrac < 0.02 &&
    spreadMean > 10 &&
    spreadMean < 20
      ? -1
      : 0;
  const useVarField = veryLowFrac < 0.62 || spreadMean > 30;
  const iWidth = bWidth + 1;
  const iHeight = bHeight + 1;
  const integLen = iHeight * iWidth;
  // `integ` is the standard summed-area table of block means.
  const integ = new Uint32Array(integLen);
  // `integSqr` is the square-integral / summed-area table of `v * v` over the
  // same block means, not a u8 pixel buffer. Those prefix sums can overflow
  // 32-bit integer storage on large images, and Float32 was the measured
  // faster compromise vs Float64 for this heuristic field.
  const integSqr = useVarField ? new Float32Array(integLen) : undefined;
  for (let y = 0; y < bHeight; y++) {
    let rowSum = 0;
    let rowSq = 0;
    const bRow = y * bWidth;
    const iRow = (y + 1) * iWidth;
    const iPrev = y * iWidth;
    for (let x = 0; x < bWidth; x++) {
      const v = blockState[bRow + x] & 0xff;
      rowSum += v;
      if (integSqr) rowSq += v * v;
      integ[iRow + x + 1] = integ[iPrev + x + 1] + rowSum;
      if (integSqr) integSqr[iRow + x + 1] = integSqr[iPrev + x + 1] + rowSq;
    }
  }
  const matrix = new Bitmap({ width, height });
  const rows = Math.ceil(width / 32);
  // Decode intentionally writes the packed bitmap words directly here. The
  // per-pixel Bitmap API is too expensive on this hot path, so this must stay
  // in sync with Bitmap's internal `value` layout.
  const bm = (matrix as unknown as { value: Uint32Array }).value;
  const rad = 2;
  const win = rad * 2 + 1;
  const area = win * win;
  for (let y = 0; y < bHeight; y++) {
    const yPos = cap(y * block, 0, maxY);
    const top = cap(y, rad, bHeight - rad - 1);
    const y0 = top - rad;
    const y1 = top + rad;
    const r0 = y0 * iWidth;
    const r1 = (y1 + 1) * iWidth;
    for (let x = 0; x < bWidth; x++) {
      const xPos = cap(x * block, 0, maxX);
      const shift = xPos & 31;
      const col = xPos >>> 5;
      const left = cap(x, rad, bWidth - rad - 1);
      const x0 = left - rad;
      const x1 = left + rad;
      // 5x5 blocks average
      const sum = integ[r1 + (x1 + 1)] - integ[r0 + (x1 + 1)] - integ[r1 + x0] + integ[r0 + x0];
      // `average` is the coarse threshold surface: a 5x5 neighborhood mean of
      // the 8x8 block means. The adjustments below decide when to move away
      // from that surface for the current block.
      const average = (sum / area) | 0;
      let cut = average;
      const bIdx = bWidth * y + x;
      const blk = blockState[bIdx];
      const blockAvg = blk & 0xff;
      const min = (blk >>> 8) & 0xff;
      const max = blk >>> 16;
      const range = max - min;
      if (average < min) continue;
      if (average >= max) {
        const m = 0xff;
        for (let yy = 0, row = yPos * rows + col; yy < block; yy++, row += rows) {
          const lo = (m << shift) >>> 0;
          bm[row] |= lo;
          if (shift > 24) bm[row + 1] |= m >>> (32 - shift);
        }
        continue;
      }
      // `localAdj`: nudge toward the current block when it is darker than
      // its neighborhood. This helps preserve dark rings / modules that are
      // locally meaningful but diluted by the 5x5 field.
      let localAdj = (blockAvg - average) >> 4;
      if (localAdj < 0) localAdj = 0;
      if (localAdj > 1) localAdj = 1;
      // `chromaAdj`: in colorful, mid-tone blocks, slight extra darkening
      // helps where luma alone underestimates QR structure.
      let chromaAdj = 0;
      if (range > 6 && average > 48 && average < 232) {
        const spreadBoost = spreadMean > 8 ? spreadMean - 8 : 0;
        const mid = 128 - Math.abs(average - 128);
        chromaAdj = int((spreadBoost * (range - 6) * mid) / 2200000);
        if (chromaAdj > 1) chromaAdj = 1;
      }
      // `varAdj`: if the surrounding block field has real variance, darken
      // more aggressively when the local mean still sits far above the
      // block minimum. This is what rescues many weak finder cases.
      let varAdj = 0;
      if (integSqr && range >= 6 && range <= 128) {
        const sq =
          integSqr[r1 + (x1 + 1)] - integSqr[r0 + (x1 + 1)] - integSqr[r1 + x0] + integSqr[r0 + x0];
        const meanSq = sq / area;
        let variance = meanSq - average * average;
        if (variance < 0) variance = 0;
        const gap = average - min;
        const num = gap * (variance - 196);
        const den = (variance + 832) * 9;
        // `variance` is clamped non-negative, so `den` stays strictly positive.
        varAdj = int(num / den);
        if (varAdj < -1) varAdj = -1;
        if (varAdj > 4) varAdj = 4;
      }
      cut = average + localAdj + chromaAdj + varAdj;
      // Small scene-level nudges are intentionally separate from the three
      // local terms above: they are cheap and only target known whole-scene
      // failure modes such as washed-out bright-spot images.
      if (spreadMean > 10 && range >= 8 && range <= 96 && average > min + 8 && average < 192) cut++;
      if (veryLowFrac > 0.68 && veryLowFrac < 0.86 && range >= 6 && range <= 20 && average < 196)
        cut++;
      cut += spotBias;
      if (cut < min) cut = min;
      if (cut > max) cut = max;
      // Emit one 8-pixel row of the current 8x8 block: compare against the
      // block cut, pack the 8 black/white decisions into one byte, then OR
      // that byte into the bitmap word(s) at the current x-bit offset.
      for (
        let yy = 0, pos = yPos * width + xPos, row = yPos * rows + col;
        yy < block;
        yy++, pos += width, row += rows
      ) {
        let m = 0;
        if (brightness[pos] <= cut) m |= 1;
        if (brightness[pos + 1] <= cut) m |= 2;
        if (brightness[pos + 2] <= cut) m |= 4;
        if (brightness[pos + 3] <= cut) m |= 8;
        if (brightness[pos + 4] <= cut) m |= 16;
        if (brightness[pos + 5] <= cut) m |= 32;
        if (brightness[pos + 6] <= cut) m |= 64;
        if (brightness[pos + 7] <= cut) m |= 128;
        if (m === 0) continue;
        const lo = (m << shift) >>> 0;
        bm[row] |= lo;
        if (shift > 24) bm[row + 1] |= m >>> (32 - shift);
      }
    }
  }
  return matrix;
}

// Various utilities for pattern
type Pattern = Point & { moduleSize: number; count: number };
function patternEquals(p: Pattern, p2: Pattern) {
  if (Math.abs(p2.y - p.y) <= p2.moduleSize && Math.abs(p2.x - p.x) <= p2.moduleSize) {
    const diff = Math.abs(p2.moduleSize - p.moduleSize);
    return diff <= 1.0 || diff <= p.moduleSize;
  }
  return false;
}

function patternMerge(a: Pattern, b: Pattern) {
  const count = a.count + b.count;
  return {
    x: (a.count * a.x + b.count * b.x) / count,
    y: (a.count * a.y + b.count * b.y) / count,
    moduleSize: (a.count * a.moduleSize + b.count * b.moduleSize) / count,
    count,
  };
}

const patternsConfirmed = (lst: Pattern[]) =>
  lst.filter((i) => i.count >= PATTERN_MIN_CONFIRMATIONS);

type Runs = number[];
/**
 * Since pattern means runs of identical color (dark or white), we cannot
 * have pattern like [true, true], because it will be hard to separate same color runs.
 * @param p boolean pattern
 * @param size size of run relative to others
 * @returns
 */
function pattern(p: boolean[], size?: number[]) {
  const _size = size || fillArr(p.length, 1);
  if (p.length !== _size.length) throw new Error('invalid pattern');
  if (!(p.length & 1)) throw new Error('invalid pattern, length should be odd');
  const res = {
    center: Math.ceil(p.length / 2) - 1,
    length: p.length,
    pattern: p,
    size: _size,
    runs: () => fillArr(p.length, 0),
    totalSize: sum(_size),
    total: (runs: Runs) => runs.reduce((acc, i) => acc + i),
    shift: (runs: Runs, n: number) => {
      for (let i = 0; i < runs.length - n; i++) runs[i] = runs[i + 2];
      for (let i = runs.length - n; i < runs.length; i++) runs[i] = 0;
    },
    checkSize(runs: Runs, moduleSize: number, v = PATTERN_VARIANCE) {
      const variance = moduleSize / v;
      for (let i = 0; i < runs.length; i++) {
        if (Math.abs(_size[i] * moduleSize - runs[i]) >= _size[i] * variance) return false;
      }
      return true;
    },
    add(out: Pattern[], x: number, y: number, total: number) {
      const moduleSize = total / FINDER.totalSize;
      const cur = { x, y, moduleSize, count: 1 };
      for (let idx = 0; idx < out.length; idx++) {
        const f = out[idx];
        if (!patternEquals(f, cur)) continue;
        return (out[idx] = patternMerge(f, cur));
      }
      out.push(cur);
      return;
    },
    toCenter(runs: Runs, end: number) {
      for (let i = p.length - 1; i > res.center; i--) end -= runs[i];
      end -= runs[res.center] / 2;
      return end;
    },
    check(b: Bitmap, runs: Runs, center: Point, incr: Point, maxCount?: number) {
      let j = 0;
      let i = pointClone(center);
      const neg = pointNeg(incr);
      const check = (p: number, step: Point) => {
        for (; b.isInside(i) && !!b.point(i) === res.pattern[p]; pointIncr(i, step)) {
          runs[p]++;
          j++;
        }
        if (runs[p] === 0) return true;
        const center = p === res.center;
        if (maxCount && !center && runs[p] > res.size[p] * maxCount) return true;
        return false;
      };
      for (let p = res.center; p >= 0; p--) if (check(p, neg)) return false;
      i = pointClone(center);
      pointIncr(i, incr);
      j = 1;
      for (let p = res.center; p < res.length; p++) if (check(p, incr)) return false;
      return j;
    },
    scanLine(
      b: Bitmap,
      y: number,
      xStart: number,
      xEnd: number,
      fn: (runs: Runs, x: number) => boolean | void
    ) {
      const runs = res.runs();
      // Finder scanning also couples to Bitmap internals so it can scan packed
      // 32-bit words directly instead of re-reading one pixel bit at a time.
      const words = (b as unknown as { words: number }).words;
      const vals = (b as unknown as { value: Uint32Array }).value;
      const row = y * words;
      const pattern = res.pattern;
      // Scan one packed bitmap row by jumping whole equal-bit runs inside 32-bit
      // words; this keeps finder scanning from degenerating into per-pixel work.
      const bitAt = (x: number) => ((vals[row + (x >>> 5)] >>> (x & 31)) & 1) === 1;
      const runLen = (x: number, want: boolean) => {
        let wi = row + (x >>> 5);
        let bit = x & 31;
        let w = (vals[wi] >>> bit) >>> 0;
        let left = xEnd - x;
        let len = 0;
        while (left > 0) {
          const room = 32 - bit;
          let n = want ? ctz32(~w >>> 0) : ctz32(w);
          if (n > room) n = room;
          if (n > left) n = left;
          len += n;
          if (n < room && n < left) break;
          left -= n;
          if (left <= 0) break;
          wi++;
          bit = 0;
          w = vals[wi] >>> 0;
        }
        return len;
      };
      let pos = 0;
      let x = xStart;
      // If we start in middle of an image, skip first pattern run,
      // since we don't know run length of pixels from left side
      if (xStart) x += runLen(x, pattern[0]);
      for (; x < xEnd; x++) {
        const cur = bitAt(x);
        // Same run, continue counting
        if (cur === pattern[pos]) {
          const n = runLen(x, cur);
          runs[pos] += n;
          x += n - 1;
          // If not last element - continue counting
          if (x !== b.width - 1) continue;
          // Last element finishes run, set x outside of run
          x++;
        }
        // Not last run: count new one
        if (pos !== res.length - 1) {
          runs[++pos]++;
          continue;
        }
        const found = fn(runs, x);
        if (found) {
          // We found pattern, reset runs counting
          pos = 0;
          runs.fill(0);
        } else if (found === false) {
          // Stop scanning
          break;
        } else {
          // Not found: shift runs by two (so pattern will continue)
          res.shift(runs, 2);
          pos = res.length - 2;
          runs[pos]++;
        }
      }
    },
  };
  return res;
}
// light/dark/light/dark/light in 1:1:3:1:1 ratio
const FINDER = pattern([true, false, true, false, true], [1, 1, 3, 1, 1]);
// dark/light/dark in 1:1:1 ratio
const ALIGNMENT = pattern([false, true, false]);

function findFinder(b: Bitmap): {
  bl: Pattern;
  tl: Pattern;
  tr: Pattern;
} {
  let found: Pattern[] = [];
  function checkRuns(runs: Runs, v = 2) {
    const total = sum(runs);
    if (total < FINDER.totalSize) return false;
    const moduleSize = total / FINDER.totalSize;
    return FINDER.checkSize(runs, moduleSize, v);
  }
  // Non-diagonal line (horizontal or vertical)
  function checkLine(center: Point, maxCount: number, total: number, incr: Point) {
    const runs = FINDER.runs();
    let i = FINDER.check(b, runs, center, incr, maxCount);
    if (i === false) return false;
    const runsTotal = sum(runs);
    if (5 * Math.abs(runsTotal - total) >= 2 * total) return false;
    if (checkRuns(runs)) return FINDER.toCenter(runs, i);
    return false;
  }

  function check(runs: Runs, i: number, j: number) {
    if (!checkRuns(runs)) return false;
    const total = sum(runs);
    let x = FINDER.toCenter(runs, j);
    // Vertical
    let y = checkLine({ x: int(x), y: i }, runs[2], total, { y: 1, x: 0 });
    if (y === false) return false;
    y += i;
    // Horizontal
    let xx = checkLine({ x: int(x), y: int(y) }, runs[2], total, { y: 0, x: 1 });
    if (xx === false) return false;
    x = xx + int(x);
    // Diagonal
    const dRuns = FINDER.runs();
    if (!FINDER.check(b, dRuns, { x: int(x), y: int(y) }, { x: 1, y: 1 })) return false;
    if (!checkRuns(dRuns, PATTERN_VARIANCE_DIAGONAL)) return false;
    FINDER.add(found, x, y, total);
    return true;
  }
  let skipped = false;
  // Start with high skip lines count until we find first pattern
  let ySkip = cap(int((3 * b.height) / (4 * 97)), DETECT_MIN_ROW_SKIP);
  let done = false;
  for (let y = ySkip - 1; y < b.height && !done; y += ySkip) {
    FINDER.scanLine(b, y, 0, b.width, (runs, x) => {
      if (!check(runs, y, x)) return;
      // Found pattern
      // Reduce row skip, since we found pattern and qr code is nearby
      ySkip = 2;
      if (skipped) {
        // Already skipped, so we have at least 2 patterns, lets check if third is ok
        let count = 0;
        let total = 0;
        for (const p of found) {
          if (p.count < PATTERN_MIN_CONFIRMATIONS) continue;
          count++;
          total += p.moduleSize;
        }
        if (count < 3) return;
        const average = total / found.length;
        let deviation = 0.0;
        for (const p of found) deviation += Math.abs(p.moduleSize - average);
        if (deviation <= 0.05 * total) {
          done = true;
          return false;
        }
      } else if (found.length > 1) {
        // We found two top patterns, lets skip to approximate location of third pattern
        const q = patternsConfirmed(found);
        if (q.length < 2) return true;
        skipped = true;
        const d = int((Math.abs(q[0].x - q[1].x) - Math.abs(q[0].y - q[1].y)) / 2);
        if (d <= runs[2] + ySkip) return true;
        y += d - runs[2] - ySkip;
        return false;
      }
      return;
    });
  }
  const flen = found.length;
  if (flen < 3) throw new Error(`Finder: len(found) = ${flen}`);
  found.sort((i, j) => i.moduleSize - j.moduleSize);
  const pBest = best<[Pattern, Pattern, Pattern]>();
  // Qubic complexity, but we stop search when we found 3 patterns, so not a problem
  for (let i = 0; i < flen - 2; i++) {
    const fi = found[i];
    for (let j = i + 1; j < flen - 1; j++) {
      const fj = found[j];
      const square0 = distance2(fi, fj);
      for (let k = j + 1; k < flen; k++) {
        const fk = found[k];
        if (fk.moduleSize > fi.moduleSize * 1.4) continue;
        const arr = [square0, distance2(fj, fk), distance2(fi, fk)].sort((a, b) => a - b);
        const a = arr[0];
        const b = arr[1];
        const c = arr[2];
        pBest.add(Math.abs(c - 2 * b) + Math.abs(c - 2 * a), [fi, fj, fk]);
      }
    }
  }
  const p = pBest.get();
  if (!p) throw new Error('cannot find finder');
  const p0 = p[0];
  const p1 = p[1];
  const p2 = p[2];
  const d01 = distance(p0, p1);
  const d12 = distance(p1, p2);
  const d02 = distance(p0, p2);
  let tl = p2;
  let bl = p0;
  let tr = p1;
  if (d12 >= d01 && d12 >= d02) {
    tl = p0;
    bl = p1;
    tr = p2;
  } else if (d02 >= d12 && d02 >= d01) {
    tl = p1;
    bl = p0;
    tr = p2;
  }
  // If cross product is negative -> flip points
  if ((tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x) < 0.0) {
    let _bl = bl;
    bl = tr;
    tr = _bl;
  }
  return { bl, tl, tr };
}

function findAlignment(b: Bitmap, est: Pattern, allowanceFactor: number) {
  const { moduleSize } = est;
  const allowance = int(allowanceFactor * moduleSize);
  const leftX = cap(est.x - allowance, 0);
  const rightX = cap(est.x + allowance, undefined, b.width - 1);
  const x = rightX - leftX;
  const topY = cap(est.y - allowance, 0);
  const bottomY = cap(est.y + allowance, undefined, b.height - 1);
  const y = bottomY - topY;
  if (x < moduleSize * 3 || y < moduleSize * 3)
    throw new Error(`x = ${x}, y=${y} moduleSize = ${moduleSize}`);
  const xStart = leftX;
  const yStart = topY;
  const width = rightX - leftX;
  const height = bottomY - topY;
  const found: Pattern[] = [];
  const xEnd = xStart + width;
  const middleY = int(yStart + height / 2);
  for (let yGen = 0; yGen < height; yGen++) {
    const diff = int((yGen + 1) / 2);
    const y = middleY + (yGen & 1 ? -diff : diff);
    let res;
    ALIGNMENT.scanLine(b, y, xStart, xEnd, (runs, x) => {
      if (!ALIGNMENT.checkSize(runs, moduleSize)) return;
      const total = sum(runs);
      const xx = ALIGNMENT.toCenter(runs, x);
      // Vertical
      const rVert = ALIGNMENT.runs();
      let v = ALIGNMENT.check(b, rVert, { x: int(xx), y }, { y: 1, x: 0 }, 2 * runs[1]);
      if (v === false) return;
      v += y;
      const vTotal = sum(rVert);
      if (5 * Math.abs(vTotal - total) >= 2 * total) return;
      if (!ALIGNMENT.checkSize(rVert, moduleSize)) return;
      const yy = ALIGNMENT.toCenter(rVert, v);
      res = ALIGNMENT.add(found, xx, yy, total);
      if (res) return false;
      return;
    });
    if (res) return res;
  }
  if (found.length > 0) return found[0];
  throw new Error('Alignment pattern not found');
}

function _single(b: Bitmap, from: Point, to: Point) {
  // http://en.wikipedia.org/wiki/Bresenham's_line_algorithm
  let steep = false;
  let d = { x: Math.abs(to.x - from.x), y: Math.abs(to.y - from.y) };
  if (d.y > d.x) {
    steep = true;
    from = pointMirror(from);
    to = pointMirror(to);
    d = pointMirror(d);
  }
  let error = -d.x / 2;
  let step = { x: from.x >= to.x ? -1 : 1, y: from.y >= to.y ? -1 : 1 };
  let runPos = 0;
  let xLimit = to.x + step.x;
  // TODO: re-use pattern scanLine here?
  for (let x = from.x, y = from.y; x !== xLimit; x += step.x) {
    let real = { x, y };
    if (steep) real = pointMirror(real);
    // Same as alignment pattern ([true, false, true])
    if ((runPos === 1) === !!b.point(real)) {
      if (runPos === 2) return distance({ x, y }, from);
      runPos++;
    }
    error += d.y;
    if (error <= 0) continue;
    if (y === to.y) break;
    y += step.y;
    error -= d.x;
  }
  if (runPos === 2) return distance({ x: to.x + step.x, y: to.y }, from);
  return NaN;
}

function BWBRunLength(b: Bitmap, from: Point, to: Point) {
  let result = _single(b, from, to);
  let scaleY = 1.0;
  const { x: fx, y: fy } = from;
  let otherToX = fx - (to.x - fx);
  const bw = b.width;
  if (otherToX < 0) {
    scaleY = fx / (fx - otherToX);
    otherToX = 0;
  } else if (otherToX >= bw) {
    scaleY = (bw - 1 - fx) / (otherToX - fx);
    otherToX = bw - 1;
  }
  let otherToY = int(fy - (to.y - fy) * scaleY);
  let scaleX = 1.0;
  const bh = b.height;
  if (otherToY < 0) {
    scaleX = fy / (fy - otherToY);
    otherToY = 0;
  } else if (otherToY >= bh) {
    scaleX = (bh - 1 - fy) / (otherToY - fy);
    otherToY = bh - 1;
  }
  otherToX = int(fx + (otherToX - fx) * scaleX);
  result += _single(b, from, { x: otherToX, y: otherToY });
  return result - 1.0;
}

function moduleSizeAvg(b: Bitmap, p1: Point, p2: Point) {
  const est1 = BWBRunLength(b, pointInt(p1), pointInt(p2));
  const est2 = BWBRunLength(b, pointInt(p2), pointInt(p1));
  if (Number.isNaN(est1)) return est2 / FINDER.totalSize;
  if (Number.isNaN(est2)) return est1 / FINDER.totalSize;
  return (est1 + est2) / (2 * FINDER.totalSize);
}

function detect(b: Bitmap): {
  bits: Bitmap;
  points: FinderPoints;
} {
  let bl, tl, tr;
  try {
    ({ bl, tl, tr } = findFinder(b));
  } catch (e) {
    try {
      b.negate();
      ({ bl, tl, tr } = findFinder(b));
    } catch (e) {
      b.negate(); // undo negate
      throw e;
    }
  }
  const moduleSize = (moduleSizeAvg(b, tl, tr) + moduleSizeAvg(b, tl, bl)) / 2;
  if (moduleSize < 1.0) throw new Error(`invalid moduleSize = ${moduleSize}`);
  // Estimate size
  const tltr = int(distance(tl, tr) / moduleSize + 0.5);
  const tlbl = int(distance(tl, bl) / moduleSize + 0.5);
  let size = int((tltr + tlbl) / 2 + 7);
  const rem = size % 4;
  if (rem === 0)
    size++; // -> 1
  else if (rem === 2)
    size--; // -> 1
  else if (rem === 3) size -= 2;
  const version = info.size.decode(size);
  validateVersion(version);
  let alignmentPattern;
  if (info.alignmentPatterns(version).length > 0) {
    // Bottom right estimate
    const br = { x: tr.x - tl.x + bl.x, y: tr.y - tl.y + bl.y };
    const c = 1.0 - 3.0 / (info.size.encode(version) - 7);
    // Estimated alignment pattern position
    const est = {
      x: int(tl.x + c * (br.x - tl.x)),
      y: int(tl.y + c * (br.y - tl.y)),
      moduleSize,
      count: 1,
    };
    for (let i = 4; i <= 16; i <<= 1) {
      try {
        alignmentPattern = findAlignment(b, est, i);
        break;
      } catch (e) {}
    }
  }
  const toTL = { x: 3.5, y: 3.5 };
  const toTR = { x: size - 3.5, y: 3.5 };
  const toBL = { x: 3.5, y: size - 3.5 };
  let br: Point;
  let toBR;
  if (alignmentPattern) {
    br = alignmentPattern;
    toBR = { x: size - 6.5, y: size - 6.5 };
  } else {
    br = { x: tr.x - tl.x + bl.x, y: tr.y - tl.y + bl.y };
    toBR = { x: size - 3.5, y: size - 3.5 };
  }
  const from: FinderPoints = [tl, tr, br, bl];
  const bits = transform(b, size, from, [toTL, toTR, toBR, toBL]);
  return { bits: bits, points: from };
}

// Perspective transform by 4 points
function squareToQuadrilateral(p: Point4) {
  const d3 = { x: p[0].x - p[1].x + p[2].x - p[3].x, y: p[0].y - p[1].y + p[2].y - p[3].y };
  if (d3.x === 0.0 && d3.y === 0.0) {
    return [
      [p[1].x - p[0].x, p[2].x - p[1].x, p[0].x],
      [p[1].y - p[0].y, p[2].y - p[1].y, p[0].y],
      [0.0, 0.0, 1.0],
    ];
  } else {
    const d1 = { x: p[1].x - p[2].x, y: p[1].y - p[2].y };
    const d2 = { x: p[3].x - p[2].x, y: p[3].y - p[2].y };
    const den = d1.x * d2.y - d2.x * d1.y;
    const p13 = (d3.x * d2.y - d2.x * d3.y) / den;
    const p23 = (d1.x * d3.y - d3.x * d1.y) / den;
    return [
      [p[1].x - p[0].x + p13 * p[1].x, p[3].x - p[0].x + p23 * p[3].x, p[0].x],
      [p[1].y - p[0].y + p13 * p[1].y, p[3].y - p[0].y + p23 * p[3].y, p[0].y],
      [p13, p23, 1.0],
    ];
  }
}

// Transform quadrilateral to square by 4 points
function transform(b: Bitmap, size: number, from: Point4, to: Point4): Bitmap {
  // TODO: check
  // https://math.stackexchange.com/questions/13404/mapping-irregular-quadrilateral-to-a-rectangle
  const p = squareToQuadrilateral(to);
  const qToS = [
    [
      p[1][1] * p[2][2] - p[2][1] * p[1][2],
      p[2][1] * p[0][2] - p[0][1] * p[2][2],
      p[0][1] * p[1][2] - p[1][1] * p[0][2],
    ],
    [
      p[2][0] * p[1][2] - p[1][0] * p[2][2],
      p[0][0] * p[2][2] - p[2][0] * p[0][2],
      p[1][0] * p[0][2] - p[0][0] * p[1][2],
    ],
    [
      p[1][0] * p[2][1] - p[2][0] * p[1][1],
      p[2][0] * p[0][1] - p[0][0] * p[2][1],
      p[0][0] * p[1][1] - p[1][0] * p[0][1],
    ],
  ];
  const sToQ = squareToQuadrilateral(from);
  const transform = sToQ.map((i) =>
    i.map((_, qx) => i.reduce((acc, v, j) => acc + v * qToS[j][qx], 0))
  );

  const res = new Bitmap(size);
  const points = fillArr(2 * size, 0);
  const pointsLength = points.length;
  for (let y = 0; y < size; y++) {
    const p = transform;
    for (let i = 0; i < pointsLength - 1; i += 2) {
      const x = i / 2 + 0.5;
      const y2 = y + 0.5;
      const den = p[2][0] * x + p[2][1] * y2 + p[2][2];
      points[i] = int((p[0][0] * x + p[0][1] * y2 + p[0][2]) / den);
      points[i + 1] = int((p[1][0] * x + p[1][1] * y2 + p[1][2]) / den);
    }
    for (let i = 0; i < pointsLength; i += 2) {
      const px = cap(points[i], 0, b.width - 1);
      const py = cap(points[i + 1], 0, b.height - 1);
      if (b.get(px, py)) res.set((i / 2) | 0, y, true);
    }
  }
  return res;
}

// Same as in drawTemplate, but reading
// TODO: merge in CoderType?
function readInfoBits(b: Bitmap) {
  const readBit = (x: number, y: number, out: number) => (out << 1) | (b.get(x, y) ? 1 : 0);
  const size = b.height;
  // Version information
  let version1 = 0;
  for (let y = 5; y >= 0; y--)
    for (let x = size - 9; x >= size - 11; x--) version1 = readBit(x, y, version1);
  let version2 = 0;
  for (let x = 5; x >= 0; x--)
    for (let y = size - 9; y >= size - 11; y--) version2 = readBit(x, y, version2);
  // Format information
  let format1 = 0;
  for (let x = 0; x < 6; x++) format1 = readBit(x, 8, format1);
  format1 = readBit(7, 8, format1);
  format1 = readBit(8, 8, format1);
  format1 = readBit(8, 7, format1);
  for (let y = 5; y >= 0; y--) format1 = readBit(8, y, format1);
  let format2 = 0;
  for (let y = size - 1; y >= size - 7; y--) format2 = readBit(8, y, format2);
  for (let x = size - 8; x < size; x++) format2 = readBit(x, 8, format2);
  return { version1, version2, format1, format2 };
}

function parseInfo(b: Bitmap) {
  // Population count over xor -> hamming distance
  const size = b.height;
  const { version1, version2, format1, format2 } = readInfoBits(b);
  // Guess format
  let format;
  const bestFormat = best<{ ecc: ErrorCorrection; mask: Mask }>();
  for (const ecc of ['medium', 'low', 'high', 'quartile'] as const) {
    for (let mask: Mask = 0; mask < 8; mask++) {
      const bits = info.formatBits(ecc, mask as Mask);
      const cur = { ecc, mask: mask as Mask };
      if (bits === format1 || bits === format2) {
        format = cur;
        break;
      }
      bestFormat.add(popcnt(format1 ^ bits), cur);
      if (format1 !== format2) bestFormat.add(popcnt(format2 ^ bits), cur);
    }
  }
  if (format === undefined && bestFormat.score() <= MAX_BITS_ERROR) format = bestFormat.get();
  if (format === undefined) throw new Error('invalid format pattern');
  let version: number | undefined = info.size.decode(size); // Guess version based on bitmap size
  if (version < 7) validateVersion(version);
  else {
    version = undefined;
    // Guess version
    const bestVer = best<number>();
    for (let ver = 7; ver <= 40; ver++) {
      const bits = info.versionBits(ver);
      if (bits === version1 || bits === version2) {
        version = ver;
        break;
      }
      bestVer.add(popcnt(version1 ^ bits), ver);
      if (version1 !== version2) bestVer.add(popcnt(version2 ^ bits), ver);
    }
    if (version === undefined && bestVer.score() <= MAX_BITS_ERROR) version = bestVer.get();
    if (version === undefined) throw new Error('invalid version pattern');
    if (info.size.encode(version) !== size) throw new Error('invalid version size');
  }
  return { version, ...format };
}

// Global symbols in both browsers and Node.js since v11
// See https://github.com/microsoft/TypeScript/issues/31535
declare const TextDecoder: any;

// Common encodings, please open issue if something popular missing
const eciToEncoding: Record<number, string> = {
  1: 'iso-8859-1',
  2: 'ibm437',
  3: 'iso-8859-1',
  4: 'iso-8859-2',
  5: 'iso-8859-3',
  6: 'iso-8859-4',
  7: 'iso-8859-5',
  8: 'iso-8859-6',
  9: 'iso-8859-7',
  10: 'iso-8859-8',
  11: 'iso-8859-9',
  13: 'iso-8859-11',
  15: 'iso-8859-13',
  16: 'iso-8859-14',
  17: 'iso-8859-15',
  18: 'iso-8859-16',
  20: 'shift-jis',
  21: 'windows-1250',
  22: 'windows-1251',
  23: 'windows-1252',
  24: 'windows-1256',
  25: 'utf-16be',
  26: 'utf-8',
  28: 'big5',
  29: 'gbk',
  30: 'euc-kr',
};

function decodeWithEci(bytes: Uint8Array, eci: number = 26): string {
  const encoding = eciToEncoding[eci];
  if (!encoding) throw new Error(`Unsupported ECI: ${eci}`);
  return new TextDecoder(encoding).decode(bytes);
}

function decodeBitmap(
  b: Bitmap,
  decoder: (bytes: Uint8Array, eci: number) => string = decodeWithEci
): string {
  const size = b.height;
  if (size < 21 || (size & 0b11) !== 1 || size !== b.width)
    throw new Error(`decode: invalid size=${size}`);
  const { version, mask, ecc } = parseInfo(b);
  const tpl = drawTemplate(version, ecc, mask);
  const { total } = info.capacity(version, ecc);
  const bytes = new Uint8Array(total);
  let pos = 0;
  let buf = 0;
  let bitPos = 0;
  zigzag(tpl, mask, (x, y, m) => {
    bitPos++;
    buf <<= 1;
    buf |= +(!!b.get(x, y) !== m);
    if (bitPos !== 8) return;
    bytes[pos++] = buf;
    bitPos = 0;
    buf = 0;
  });
  if (pos !== total) throw new Error(`decode: pos=${pos}, total=${total}`);
  let bits = Array.from(interleave(version, ecc).decode(bytes))
    .map((i) => bin(i, 8))
    .join('');
  // Reverse operation of index.ts/encode working on bits
  const readBits = (n: number) => {
    if (n > bits.length) throw new Error('Not enough bits');
    const val = bits.slice(0, n);
    bits = bits.slice(n);
    return val;
  };
  const toNum = (n: string) => Number(`0b${n}`);
  // reverse of common.info.modebits
  const modes: Record<string, EncodingType | 'terminator'> = {
    '0000': 'terminator',
    '0001': 'numeric',
    '0010': 'alphanumeric',
    '0100': 'byte',
    '0111': 'eci',
    '1000': 'kanji',
  };
  let res = '';
  let eci: number = 26; // Default to utf-8 for compat with old behavior
  while (true) {
    if (bits.length < 4) break;
    const modeBits = readBits(4);
    const mode = modes[modeBits];
    if (mode === undefined) throw new Error(`Unknown modeBits=${modeBits} res="${res}"`);
    if (mode === 'terminator') break;
    const countBits = info.lengthBits(version, mode);
    let count = toNum(readBits(countBits));
    if (mode === 'numeric') {
      while (count >= 3) {
        const v = toNum(readBits(10));
        if (v >= 1000) throw new Error(`numberic(3) = ${v}`);
        res += v.toString().padStart(3, '0');
        count -= 3;
      }
      if (count === 2) {
        const v = toNum(readBits(7));
        if (v >= 100) throw new Error(`numeric(2) = ${v}`);
        res += v.toString().padStart(2, '0');
      } else if (count === 1) {
        const v = toNum(readBits(4));
        if (v >= 10) throw new Error(`Numeric(1) = ${v}`);
        res += v.toString();
      }
    } else if (mode === 'alphanumeric') {
      while (count >= 2) {
        const v = toNum(readBits(11));
        res += info.alphabet.alphanumerc.encode([Math.floor(v / 45), v % 45]).join('');
        count -= 2;
      }
      if (count === 1) res += info.alphabet.alphanumerc.encode([toNum(readBits(6))]).join('');
    } else if (mode === 'eci') {
      const first = toNum(readBits(8));
      if ((first & 0x80) === 0) eci = first;
      else if ((first & 0xc0) === 0x80) eci = ((first & 0x3f) << 8) | toNum(readBits(8));
      else eci = ((first & 0x1f) << 16) | toNum(readBits(16));
      continue; // ECI doesn't carry data, just sets state
    } else if (mode === 'byte') {
      const data = new Uint8Array(count);
      for (let i = 0; i < count; i++) data[i] = toNum(readBits(8));
      res += decoder(data, eci);
    } else throw new Error(`Unknown mode=${mode}`);
  }
  return res;
}

export type DecodeOpts = {
  cropToSquare?: boolean;
  textDecoder?: (bytes: Uint8Array) => string;
  pointsOnDetect?: (points: FinderPoints) => void;
  imageOnBitmap?: (img: Image) => void;
  imageOnDetect?: (img: Image) => void;
  imageOnResult?: (img: Image) => void;
};

// Creates square from rectangle
function cropToSquare(img: Image) {
  const data = Array.isArray(img.data) ? new Uint8Array(img.data) : img.data;
  const { height, width } = img;
  const squareSize = Math.min(height, width);
  const offset = {
    x: Math.floor((width - squareSize) / 2),
    y: Math.floor((height - squareSize) / 2),
  };
  const bytesPerPixel = getBytesPerPixel(img);
  const croppedData = new Uint8Array(squareSize * squareSize * bytesPerPixel);
  for (let y = 0; y < squareSize; y++) {
    const srcPos = ((y + offset.y) * width + offset.x) * bytesPerPixel;
    const dstPos = y * squareSize * bytesPerPixel;
    const length = squareSize * bytesPerPixel;
    croppedData.set(data.subarray(srcPos, srcPos + length), dstPos);
  }
  return { offset, img: { height: squareSize, width: squareSize, data: croppedData } };
}

export function decodeQR(img: Image, opts: DecodeOpts = {}): string {
  for (const field of ['height', 'width'] as const) {
    if (!Number.isSafeInteger(img[field]) || img[field] <= 0)
      throw new Error(`invalid img.${field}=${img[field]} (${typeof img[field]})`);
  }
  const { data } = img;
  if (!Array.isArray(data) && !isBytes(data))
    throw new Error(`invalid image.data=${data} (${typeof data})`);
  if (opts.cropToSquare !== undefined && typeof opts.cropToSquare !== 'boolean')
    throw new Error(`invalid opts.cropToSquare=${opts.cropToSquare}`);
  for (const fn of ['pointsOnDetect', 'imageOnBitmap', 'imageOnDetect', 'imageOnResult'] as const) {
    if (opts[fn] !== undefined && typeof opts[fn] !== 'function')
      throw new Error(`invalid opts.${fn}=${opts[fn]} (${typeof opts[fn]})`);
  }
  let offset = { x: 0, y: 0 };
  if (opts.cropToSquare) ({ img, offset } = cropToSquare(img));
  const bmp = toBitmap(img);
  if (opts.imageOnBitmap) opts.imageOnBitmap(bmp.toImage());
  const { bits, points } = detect(bmp);
  if (opts.pointsOnDetect) {
    const p = points.map((i) => ({ ...i, ...pointAdd(i, offset) })) as FinderPoints;
    opts.pointsOnDetect(p);
  }
  if (opts.imageOnDetect) opts.imageOnDetect(bits.toImage());
  const res = decodeBitmap(bits, opts.textDecoder);
  if (opts.imageOnResult) opts.imageOnResult(bits.toImage());
  return res;
}

export default decodeQR;

// Unsafe API utils, exported only for tests
export const _tests: {
  toBitmap: typeof toBitmap;
  decodeBitmap: typeof decodeBitmap;
  findFinder: typeof findFinder;
  detect: typeof detect;
} = {
  toBitmap,
  decodeBitmap,
  findFinder,
  detect,
};
