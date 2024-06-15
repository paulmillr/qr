/*!
Copyright (c) 2023 Paul Miller (paulmillr.com)
The library @paulmillr/qr is dual-licensed under the Apache 2.0 OR MIT license.
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

import type { EncodingType, ErrorCorrection, Image, Point, Mask } from './index.js';
import { Bitmap, utils } from './index.js';
const { best, bin, drawTemplate, fillArr, info, interleave, validateVersion, zigzag } = utils;

// Methods for reading QR code patterns

// Constants
const MAX_BITS_ERROR = 3; // Up to 3 bit errors in version/format
const GRAYSCALE_BLOCK_SIZE = 8;
const GRAYSCALE_RANGE = 24;
const PATTERN_VARIANCE = 2;
const PATTERN_VARIANCE_DIAGONAL = 1.333;
const PATTERN_MIN_CONFIRMATIONS = 2;
const DETECT_MIN_ROW_SKIP = 3;

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
function cap(value: number, min?: number, max?: number) {
  return Math.max(Math.min(value, max || value), min || value);
}
const getBytesPerPixel = (img: Image) => {
  const perPixel = img.data.length / (img.width * img.height);
  if (perPixel === 3 || perPixel === 4) return perPixel; // RGB or RGBA
  throw new Error(`Unknown image format, bytes per pixel=${perPixel}`);
};

/**
 * Convert to grayscale. The function is the most expensive part of decoding:
 * it takes up to 90% of time. TODO: check gamma correction / sqr.
 */
function toBitmap(img: Image): Bitmap {
  const bytesPerPixel = getBytesPerPixel(img);
  const brightness = new Uint8Array(img.height * img.width);
  for (let i = 0, j = 0, d = img.data; i < d.length; i += bytesPerPixel) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    brightness[j++] = int((r + 2 * g + b) / 4) & 0xff;
  }
  // Convert to bitmap
  const block = GRAYSCALE_BLOCK_SIZE;
  if (img.width < block * 5 || img.height < block * 5) throw new Error('image too small');
  const bWidth = Math.ceil(img.width / block);
  const bHeight = Math.ceil(img.height / block);
  const maxY = img.height - block;
  const maxX = img.width - block;
  const blocks = new Uint8Array(bWidth * bHeight);
  for (let y = 0; y < bHeight; y++) {
    const yPos = cap(y * block, 0, maxY);
    for (let x = 0; x < bWidth; x++) {
      const xPos = cap(x * block, 0, maxX);
      let sum = 0;
      let min = 0xff;
      let max = 0;
      for (
        let yy = 0, pos = yPos * img.width + xPos;
        yy < block;
        yy = yy + 1, pos = pos + img.width
      ) {
        for (let xx = 0; xx < block; xx++) {
          const pixel = brightness[pos + xx];
          sum += pixel;
          min = Math.min(min, pixel);
          max = Math.max(max, pixel);
        }
      }
      // Average brightness of block
      let average = Math.floor(sum / block ** 2);
      if (max - min <= GRAYSCALE_RANGE) {
        average = min / 2;
        if (y > 0 && x > 0) {
          const idx = (x: number, y: number) => y * bWidth + x;
          const prev =
            (blocks[idx(x, y - 1)] + 2 * blocks[idx(x - 1, y)] + blocks[idx(x - 1, y - 1)]) / 4;
          if (min < prev) average = prev;
        }
      }
      blocks[bWidth * y + x] = int(average);
    }
  }
  const matrix = new Bitmap({ width: img.width, height: img.height });
  for (let y = 0; y < bHeight; y++) {
    const yPos = cap(y * block, 0, maxY);
    const top = cap(y, 2, bHeight - 3);
    for (let x = 0; x < bWidth; x++) {
      const xPos = cap(x * block, 0, maxX);
      const left = cap(x, 2, bWidth - 3);
      // 5x5 blocks average
      let sum = 0;
      for (let yy = -2; yy <= 2; yy++) {
        const y2 = bWidth * (top + yy) + left;
        for (let xx = -2; xx <= 2; xx++) sum += blocks[y2 + xx];
      }
      const average = sum / 25;
      for (let y = 0, pos = yPos * img.width + xPos; y < block; y += 1, pos += img.width) {
        for (let x = 0; x < block; x++) {
          if (brightness[pos + x] <= average) matrix.data[yPos + y][xPos + x] = true;
        }
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
  if (p.length !== _size.length) throw new Error('Wrong pattern');
  if (!(p.length & 1)) throw new Error('Pattern length should be odd');
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
      let pos = 0;
      let x = xStart;
      // If we start in middle of an image, skip first pattern run,
      // since we don't know run length of pixels from left side
      if (xStart) while (x < xEnd && !!b.data[y][x] === res.pattern[0]) x++;
      for (; x < xEnd; x++) {
        // Same run, continue counting
        if (!!b.data[y][x] === res.pattern[pos]) {
          runs[pos]++;
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

function findFinder(b: Bitmap) {
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

function detect(b: Bitmap) {
  const { bl, tl, tr } = findFinder(b);
  const moduleSize = (moduleSizeAvg(b, tl, tr) + moduleSizeAvg(b, tl, bl)) / 2;
  if (moduleSize < 1.0) throw new Error(`wrong moduleSize = ${moduleSize}`);
  // Estimate size
  const tltr = int(distance(tl, tr) / moduleSize + 0.5);
  const tlbl = int(distance(tl, bl) / moduleSize + 0.5);
  let size = int((tltr + tlbl) / 2 + 7);
  const rem = size % 4;
  if (rem === 0) size++; // -> 1
  else if (rem === 2) size--; // -> 1
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
  return { bits, points: from };
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
      if (b.data[py][px]) res.data[y][i / 2] = true;
    }
  }
  return res;
}

// Same as in drawTemplate, but reading
// TODO: merge in CoderType?
function readInfoBits(b: Bitmap) {
  const readBit = (x: number, y: number, out: number) => (out << 1) | (b.data[y][x] ? 1 : 0);
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
  const popcnt = (a: number) => {
    let cnt = 0;
    while (a) {
      if (a & 1) cnt++;
      a >>= 1;
    }
    return cnt;
  };
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
  if (format === undefined) throw new Error('wrong format pattern');
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
    if (version === undefined) throw new Error('Wrong version pattern');
    if (info.size.encode(version) !== size) throw new Error('Wrong version size');
  }
  return { version, ...format };
}

// Global symbols in both browsers and Node.js since v11
// See https://github.com/microsoft/TypeScript/issues/31535
declare const TextDecoder: any;

function decodeBitmap(b: Bitmap) {
  const size = b.height;
  if (size < 21 || (size & 0b11) !== 1 || size !== b.width)
    throw new Error(`decode: wrong size=${size}`);
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
    buf |= +(!!b.data[y][x] !== m);
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
    } else if (mode === 'byte') {
      let utf8 = [];
      for (let i = 0; i < count; i++) utf8.push(Number(`0b${readBits(8)}`));
      res += new TextDecoder().decode(new Uint8Array(utf8));
    } else throw new Error(`Unknown mode=${mode}`);
  }
  return res;
}

export type DecodeOpts = {
  cropToSquare?: boolean;
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

export default function decodeQR(img: Image, opts: DecodeOpts = {}): string {
  for (const field of ['height', 'width'] as const) {
    if (!Number.isSafeInteger(img[field]) || img[field] <= 0)
      throw new Error(`Wrong img.${field}=${img[field]} (${typeof img[field]})`);
  }
  if (
    !Array.isArray(img.data) &&
    !(img.data instanceof Uint8Array) &&
    !(img.data instanceof Uint8ClampedArray)
  )
    throw new Error(`Wrong image.data=${img.data} (${typeof img.data})`);
  if (opts.cropToSquare !== undefined && typeof opts.cropToSquare !== 'boolean')
    throw new Error(`Wrong opts.cropToSquare=${opts.cropToSquare}`);
  for (const fn of ['pointsOnDetect', 'imageOnBitmap', 'imageOnDetect', 'imageOnResult'] as const) {
    if (opts[fn] !== undefined && typeof opts[fn] !== 'function')
      throw new Error(`Wrong opts.${fn}=${opts[fn]} (${typeof opts[fn]})`);
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
  const res = decodeBitmap(bits);
  if (opts.imageOnResult) opts.imageOnResult(bits.toImage());
  return res;
}

// Unsafe API utils, exported only for tests
export const _tests = {
  toBitmap,
  decodeBitmap,
  findFinder,
  detect,
};
