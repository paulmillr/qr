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
 * Methods for encoding (generating) QR code patterns.
 * Check out decode.ts for decoding (reading).
 * @module
 * @example
```js
import encodeQR from 'qr';
const txt = 'Hello world';
const ascii = encodeQR(txt, 'ascii'); // Not all fonts are supported
const terminalFriendly = encodeQR(txt, 'term'); // 2x larger, all fonts are OK
const gifBytes = encodeQR(txt, 'gif'); // Uncompressed GIF
const svgElement = encodeQR(txt, 'svg'); // SVG vector image element
const array = encodeQR(txt, 'raw'); // 2d array for canvas or other libs
// import decodeQR from 'qr/decode.js';
```
 */

/**
 * Bytes API type helpers for old + new TypeScript.
 *
 * TS 5.6 has `Uint8Array`, while TS 5.9+ made it generic `Uint8Array<ArrayBuffer>`.
 * We can't use specific return type, because TS 5.6 will error.
 * We can't use generic return type, because most TS 5.9 software will expect specific type.
 *
 * Maps typed-array input leaves to broad forms.
 * These are compatibility adapters, not ownership guarantees.
 *
 * - `TArg` keeps byte inputs broad.
 * - `TRet` marks byte outputs for TS 5.6 and TS 5.9+ compatibility.
 */
export type TypedArg<T> = T extends BigInt64Array
  ? BigInt64Array
  : T extends BigUint64Array
    ? BigUint64Array
    : T extends Float32Array
      ? Float32Array
      : T extends Float64Array
        ? Float64Array
        : T extends Int16Array
          ? Int16Array
          : T extends Int32Array
            ? Int32Array
            : T extends Int8Array
              ? Int8Array
              : T extends Uint16Array
                ? Uint16Array
                : T extends Uint32Array
                  ? Uint32Array
                  : T extends Uint8ClampedArray
                    ? Uint8ClampedArray
                    : T extends Uint8Array
                      ? Uint8Array
                      : never;
/** Maps typed-array output leaves to narrow TS-compatible forms. */
export type TypedRet<T> = T extends BigInt64Array
  ? ReturnType<typeof BigInt64Array.of>
  : T extends BigUint64Array
    ? ReturnType<typeof BigUint64Array.of>
    : T extends Float32Array
      ? ReturnType<typeof Float32Array.of>
      : T extends Float64Array
        ? ReturnType<typeof Float64Array.of>
        : T extends Int16Array
          ? ReturnType<typeof Int16Array.of>
          : T extends Int32Array
            ? ReturnType<typeof Int32Array.of>
            : T extends Int8Array
              ? ReturnType<typeof Int8Array.of>
              : T extends Uint16Array
                ? ReturnType<typeof Uint16Array.of>
                : T extends Uint32Array
                  ? ReturnType<typeof Uint32Array.of>
                  : T extends Uint8ClampedArray
                    ? ReturnType<typeof Uint8ClampedArray.of>
                    : T extends Uint8Array
                      ? ReturnType<typeof Uint8Array.of>
                      : never;
/** Recursively adapts byte-carrying API input types. See {@link TypedArg}. */
export type TArg<T> =
  | T
  | ([TypedArg<T>] extends [never]
      ? T extends (...args: infer A) => infer R
        ? ((...args: { [K in keyof A]: TRet<A[K]> }) => TArg<R>) & {
            [K in keyof T]: T[K] extends (...args: any) => any ? T[K] : TArg<T[K]>;
          }
        : T extends [infer A, ...infer R]
          ? [TArg<A>, ...{ [K in keyof R]: TArg<R[K]> }]
          : T extends readonly [infer A, ...infer R]
            ? readonly [TArg<A>, ...{ [K in keyof R]: TArg<R[K]> }]
            : T extends (infer A)[]
              ? TArg<A>[]
              : T extends readonly (infer A)[]
                ? readonly TArg<A>[]
                : T extends Promise<infer A>
                  ? Promise<TArg<A>>
                  : T extends object
                    ? { [K in keyof T]: TArg<T[K]> }
                    : T
      : TypedArg<T>);
/** Recursively adapts byte-carrying API output types. See {@link TypedArg}. */
export type TRet<T> = T extends unknown
  ? T &
      ([TypedRet<T>] extends [never]
        ? T extends (...args: infer A) => infer R
          ? ((...args: { [K in keyof A]: TArg<A[K]> }) => TRet<R>) & {
              [K in keyof T]: T[K] extends (...args: any) => any ? T[K] : TRet<T[K]>;
            }
          : T extends [infer A, ...infer R]
            ? [TRet<A>, ...{ [K in keyof R]: TRet<R[K]> }]
            : T extends readonly [infer A, ...infer R]
              ? readonly [TRet<A>, ...{ [K in keyof R]: TRet<R[K]> }]
              : T extends (infer A)[]
                ? TRet<A>[]
                : T extends readonly (infer A)[]
                  ? readonly TRet<A>[]
                  : T extends Promise<infer A>
                    ? Promise<TRet<A>>
                    : T extends object
                      ? { [K in keyof T]: TRet<T[K]> }
                      : T
        : TypedRet<T>)
  : never;

// We do not use newline escape code directly in strings because it's not parser-friendly
const chCodes = { newline: 10, reset: 27 };

/** Bidirectional codec interface. */
export interface Coder<F, T> {
  /**
   * Encodes a source value into the target representation.
   * @param from - Source value to encode.
   * @returns Encoded representation.
   */
  encode(from: F): T;
  /**
   * Decodes a target value back into the source representation.
   * @param to - Encoded representation to decode.
   * @returns Decoded source value.
   */
  decode(to: T): F;
}

function assertNumber(n: number) {
  if (!Number.isSafeInteger(n)) throw new Error(`integer expected: ${n}`);
}

function validateVersion(ver: Version): void {
  if (!Number.isSafeInteger(ver) || ver < 1 || ver > 40)
    throw new Error(`Invalid version=${ver}. Expected number [1..40]`);
}

function bin(dec: number, pad: number): string {
  return dec.toString(2).padStart(pad, '0');
}

function mod(a: number, b: number): number {
  const result = a % b;
  return result >= 0 ? result : b + result;
}

function fillArr<T>(length: number, val: T): T[] {
  // Current callers only pass primitive fill values; object fills would alias references.
  return new Array(length).fill(val);
}

function popcnt(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Interleaves byte blocks.
 * @param blocks [[1, 2, 3], [4, 5, 6]]
 * @returns [1, 4, 2, 5, 3, 6]
 */
function interleaveBytes(blocks: TArg<Uint8Array[]>): TRet<Uint8Array> {
  let maxLen = 0;
  let totalLen = 0;
  for (const block of blocks) {
    maxLen = Math.max(maxLen, block.length);
    totalLen += block.length;
  }

  const result = new Uint8Array(totalLen);
  let idx = 0;
  // When block lengths differ, callers must pass the shorter blocks first so
  // the interleaving order matches ISO/IEC 18004 §7.6 c).
  for (let i = 0; i < maxLen; i++) {
    for (const block of blocks) {
      if (i < block.length) result[idx++] = block[i];
    }
  }

  return result as TRet<Uint8Array>;
}

// Optimize for minimal score/penalty
function best<T>(): {
  add(score: number, value: T): void;
  get: () => T | undefined;
  score: () => number;
} {
  let best: T | undefined;
  let bestScore = Infinity;
  return {
    add(score: number, value: T): void {
      // Ties keep the first candidate so equal-score selections stay deterministic.
      if (score >= bestScore) return;
      best = value;
      bestScore = score;
    },
    get: (): T | undefined => best,
    score: (): number => bestScore,
  };
}

// Based on https://github.com/paulmillr/scure-base/blob/main/index.ts
function alphabet(
  alphabet: string
): Coder<number[], string[]> & { has: (char: string) => boolean } {
  // Character order defines the numeric values used by the target QR mode.
  return Object.freeze({
    has: (char: string) => alphabet.includes(char),
    decode: (input: string[]) => {
      if (!Array.isArray(input) || (input.length && typeof input[0] !== 'string'))
        throw new Error('alphabet.decode input should be array of strings');
      return input.map((letter) => {
        if (typeof letter !== 'string')
          throw new Error(`alphabet.decode: not string element=${letter}`);
        const index = alphabet.indexOf(letter);
        if (index === -1) throw new Error(`Unknown letter: "${letter}". Allowed: ${alphabet}`);
        return index;
      });
    },
    encode: (digits: number[]) => {
      if (!Array.isArray(digits) || (digits.length && typeof digits[0] !== 'number'))
        throw new Error('alphabet.encode input should be an array of numbers');
      return digits.map((i) => {
        assertNumber(i);
        if (i < 0 || i >= alphabet.length)
          throw new Error(`Digit index outside alphabet: ${i} (alphabet: ${alphabet.length})`);
        return alphabet[i];
      });
    },
  });
}

// Transpose 32x32 bit matrix in-place
// a[0..31] are 32 rows of 32 bits each; after transpose they become 32 columns.
function transpose32(a: TArg<Uint32Array>) {
  if (a.length !== 32) throw new Error('expects 32 element matrix');
  const masks = [0x55555555, 0x33333333, 0x0f0f0f0f, 0x00ff00ff, 0x0000ffff] as const;
  // Hello again, FFT
  for (let stage = 0; stage < 5; stage++) {
    const m = masks[stage] >>> 0;
    const s = 1 << stage; // 1,2,4,8,16
    const step = s << 1; // 2,4,8,16,32
    for (let i = 0; i < 32; i += step) {
      for (let k = 0; k < s; k++) {
        const i0 = i + k;
        const i1 = i0 + s;
        const x = a[i0] >>> 0;
        const y = a[i1] >>> 0;
        const t = ((x >>> s) ^ y) & m;
        a[i0] = (x ^ (t << s)) >>> 0;
        a[i1] = (y ^ t) >>> 0;
      }
    }
  }
}
const bitMask = (x: number): number => (1 << (x & 31)) >>> 0;
const rangeMask = (shift: number, len: number): number => {
  // len in [0..32], shift in [0..31]
  if (len === 0) return 0;
  // Callers only request len=32 for word-aligned spans; JS shift counts wrap at 32,
  // so full-word masks must bypass the generic `(1 << len)` path.
  if (len === 32) return 0xffffffff;
  return (((1 << len) - 1) << shift) >>> 0;
};
/*
Basic bitmap structure for two colors (black & white) small images.
- undefined is used as a marker whether cell was written or not
- Internal array structure:
  boolean?[y][x], where Y is row and X is column (similar to cartesian system):
     ____X
    |
  Y |
- For most `draw` calls, structure is mutable. Reason for this:
  it would be wasteful to copy full nested array structure on a single cell change
- Nested structure is easy to work with, but it can be flattened for performance
- There can be memory-efficient way to store bitmap (numbers), however, most operations
  will work on a single bit anyway. It will only reduce storage without
  significant performance impact, but will increase code complexity
*/
/** Two-dimensional point. */
export type Point = {
  /** Horizontal coordinate. */
  x: number;
  /** Vertical coordinate. */
  y: number;
};
/** Width and height pair. */
export type Size = {
  /** Pixel height. */
  height: number;
  /** Pixel width. */
  width: number;
};
/** Raster image used by the encoder and decoder. */
export type Image = Size & {
  /** Row-major RGB or RGBA pixel data. */
  data: Uint8Array | Uint8ClampedArray | number[];
};
type DrawValue = boolean | undefined; // undefined=not written, true=foreground, false=background
// value or fn returning value based on coords
type DrawFn = DrawValue | ((c: Point, curr: DrawValue) => DrawValue);
type ReadFn = (c: Point, curr: DrawValue) => void;
/**
 * Mutable monochrome bitmap used as the internal QR representation.
 * @param size - Square edge length or explicit bitmap dimensions.
 * @param data - Optional row-major pixel matrix using `true`, `false`, or `undefined`.
 * @example
 * Create a bitmap, then scale it for display.
 * ```ts
 * import { Bitmap } from 'qr';
 * const bitmap = Bitmap.fromString('X \n X');
 * bitmap.scale(2);
 * ```
 */
export class Bitmap {
  private static size(size: Size | number, limit?: Size) {
    if (typeof size === 'number') size = { height: size, width: size };
    if (!Number.isSafeInteger(size.height) && size.height !== Infinity)
      throw new Error(`Bitmap: invalid height=${size.height} (${typeof size.height})`);
    if (!Number.isSafeInteger(size.width) && size.width !== Infinity)
      throw new Error(`Bitmap: invalid width=${size.width} (${typeof size.width})`);
    if (limit !== undefined) {
      // Clamp length, so it won't overflow, also allows to use Infinity, so we draw until end
      size = {
        width: Math.min(size.width, limit.width),
        height: Math.min(size.height, limit.height),
      };
    }
    return size;
  }
  static fromString(s: string): Bitmap {
    // Remove linebreaks on start and end, so we draw in `` section
    // Fixture strings use LF-delimited rows of X / space / ? characters; callers
    // must normalize CRLF input before handing it to this debug parser.
    s = s.replace(/^\n+/g, '').replace(/\n+$/g, '');
    const lines = s.split(String.fromCharCode(chCodes.newline));
    const height = lines.length;
    let width: number | undefined;
    const rows: DrawValue[][] = [];
    for (const line of lines) {
      const row = line.split('').map((i) => {
        if (i === 'X') return true;
        if (i === ' ') return false;
        if (i === '?') return undefined;
        throw new Error(`Bitmap.fromString: unknown symbol=${i}`);
      });
      if (width !== undefined && row.length !== width)
        throw new Error(`Bitmap.fromString different row sizes: width=${width} cur=${row.length}`);
      width = row.length;
      rows.push(row);
    }
    if (width === undefined) width = 0;
    return new Bitmap({ height, width }, rows);
  }
  // Two bitsets:
  // defined=0 -> undefined
  // defined=1,value=0 -> false
  // defined=1,value=1 -> true
  private defined: Uint32Array;
  private value: Uint32Array;
  private tailMask: number;
  private words: number;
  private fullWords: number;
  height: number;
  width: number;
  constructor(size: Size | number, data?: DrawValue[][]) {
    const { height, width } = Bitmap.size(size);
    // Bitmap coordinates wrap through modulo for negative positions, so invalid
    // dimensions produce NaN, aliasing, or unsafe allocation sizes before later
    // drawing no-op guards can run. `Infinity` is only valid for rectangle sizes
    // that are clamped against an existing positive bitmap.
    if (!Number.isSafeInteger(height) || height <= 0)
      throw new Error(`Bitmap: invalid height=${height}, expected positive safe integer dimension`);
    if (!Number.isSafeInteger(width) || width <= 0)
      throw new Error(`Bitmap: invalid width=${width}, expected positive safe integer dimension`);
    this.height = height;
    this.width = width;
    this.tailMask = rangeMask(0, width & 31 || 32);
    this.words = Math.ceil(width / 32) | 0;
    this.fullWords = Math.floor(width / 32) | 0;
    this.value = new Uint32Array(this.words * height);
    this.defined = new Uint32Array(this.value.length);
    if (data) {
      // accept same semantics as old version
      if (data.length !== height)
        throw new Error(`Bitmap: data height mismatch: exp=${height} got=${data.length}`);
      for (let y = 0; y < height; y++) {
        const row = data[y];
        if (!row || row.length !== width)
          throw new Error(`Bitmap: data width mismatch at y=${y}: exp=${width} got=${row?.length}`);
        for (let x = 0; x < width; x++) this.set(x, y, row[x]);
      }
    }
  }
  point(p: Point): DrawValue {
    // The storage docs above say "undefined is used as a marker whether cell
    // was written or not"; `point()` is the detector's dark-module read and
    // intentionally treats both undefined and false as not-dark. Use
    // `isDefined()` when the written/undefined distinction matters.
    return this.get(p.x, p.y);
  }
  // Raw bounds check for scan loops; unlike `xy()`, this does not wrap or normalize coordinates.
  isInside(p: Point): boolean {
    return 0 <= p.x && p.x < this.width && 0 <= p.y && p.y < this.height;
  }
  size(offset?: Point | number): { height: number; width: number } {
    if (!offset) return { height: this.height, width: this.width };
    const { x, y } = this.xy(offset);
    return { height: this.height - y, width: this.width - x };
  }
  private xy(c: Point | number) {
    if (typeof c === 'number') c = { x: c, y: c };
    if (!Number.isSafeInteger(c.x)) throw new Error(`Bitmap: invalid x=${c.x}`);
    if (!Number.isSafeInteger(c.y)) throw new Error(`Bitmap: invalid y=${c.y}`);
    // Bitmap's class docs say "For most `draw` calls, structure is mutable";
    // coordinate objects follow that hot-path policy too and are normalized in place.
    c.x = mod(c.x, this.width);
    c.y = mod(c.y, this.height);
    return c;
  }
  /**
   * Return pixel bit index
   */
  private wordIndex(x: number, y: number): number {
    return y * this.words + (x >>> 5);
  }
  private bitIndex(x: number, y: number) {
    return { word: this.wordIndex(x, y), bit: x & 31 };
  }
  isDefined(x: number, y: number): boolean {
    // `isInside()` is the raw bounds check; keep these bitset accessors
    // bounds-check-free for hot paths. Invalid tail coordinates may observe
    // backing-word bits, so callers that accept untrusted coordinates must
    // check `isInside()` first.
    const wi = this.wordIndex(x, y);
    const m = bitMask(x);
    return (this.defined[wi] & m) !== 0;
  }
  get(x: number, y: number): boolean {
    const wi = this.wordIndex(x, y);
    const m = bitMask(x);
    return (this.value[wi] & m) !== 0;
  }
  private maskWord(wi: number, mask: number, v: boolean): void {
    const { defined, value } = this;
    defined[wi] |= mask;
    // `-v` expands the boolean to either all-zero or all-one bits before masking it into the selected lanes.
    value[wi] = (value[wi] & ~mask) | (-v & mask);
  }
  set(x: number, y: number, v: DrawValue): void {
    // `undefined` means "leave the current cell unchanged", not "clear it back to undefined".
    if (v === undefined) return;
    // Like `get()` / `isDefined()`, this is a raw in-bounds bitset accessor;
    // check `isInside()` before passing untrusted coordinates.
    this.maskWord(this.wordIndex(x, y), bitMask(x), v);
  }
  // word-span fill for constant values (fast path)
  private fillRectConst(x0: number, y0: number, w: number, h: number, v: DrawValue) {
    if (w <= 0 || h <= 0) return;
    if (v === undefined) return;
    const { value, defined, words } = this;
    const startWord = x0 >>> 5;
    const endWord = (x0 + w - 1) >>> 5;
    const startBit = x0 & 31;
    const endBit = (x0 + w - 1) & 31;
    for (let ry = 0; ry < h; ry++) {
      const rowBase = (y0 + ry) * words;
      if (startWord === endWord) {
        const mask = rangeMask(startBit, endBit - startBit + 1);
        this.maskWord(rowBase + startWord, mask, v);
        continue;
      }
      this.maskWord(rowBase + startWord, rangeMask(startBit, 32 - startBit), v);
      // Whole interior words can be written directly: every bit in the span becomes defined and equal to v.
      for (let i = startWord + 1; i < endWord; i++) {
        defined[rowBase + i] = 0xffffffff;
        value[rowBase + i] = v ? 0xffffffff : 0;
      }
      this.maskWord(rowBase + endWord, rangeMask(0, endBit + 1), v);
    }
  }
  private rectWords(
    x: number,
    y: number,
    width: number,
    height: number,
    cb: (wi: number, bitX: number, xPos: number, yPos: number, bitsInWord: number) => void
  ): void {
    for (let yPos = 0; yPos < height; yPos++) {
      const Py = y + yPos;
      for (let xPos = 0; xPos < width; ) {
        const bitX = x + xPos;
        const { bit, word } = this.bitIndex(bitX, Py);
        const bitsPerWord = Math.min(32 - bit, width - xPos);
        // bitX stays absolute for word-local masks; xPos/yPos stay rectangle-local for rect callbacks.
        cb(word, bitX, xPos, yPos, bitsPerWord);
        xPos += bitsPerWord;
      }
    }
  }
  // Basically every operation can be represented as rect
  rect(c: Point | number, size: Size | number, fn: DrawFn): this {
    const { x, y } = this.xy(c);
    const { height, width } = Bitmap.size(size, this.size({ x, y }));
    if (typeof fn !== 'function') {
      this.fillRectConst(x, y, width, height, fn);
      return this;
    }
    const { defined, value } = this;
    this.rectWords(x, y, width, height, (wi, bitX, xPos, yPos, n) => {
      let defWord = 0;
      let valWord = value[wi];
      for (let b = 0; b < n; b++) {
        const mask = bitMask(bitX + b);
        // As with `point()`, callback `cur` is a dark/not-dark read; the
        // storage-level "undefined is used as a marker whether cell was
        // written or not" distinction is checked separately with `isDefined()`.
        const res = fn({ x: xPos + b, y: yPos }, (valWord & mask) !== 0);
        // Returning undefined from the callback keeps the existing cell unchanged.
        if (res === undefined) continue;
        defWord |= mask;
        valWord = (valWord & ~mask) | (-res & mask);
      }
      defined[wi] |= defWord;
      value[wi] = valWord;
    });
    return this;
  }
  // returns rectangular part of bitmap
  rectRead(c: Point | number, size: Size | number, fn: ReadFn): this {
    const { x, y } = this.xy(c);
    const { height, width } = Bitmap.size(size, this.size({ x, y }));
    const { value } = this;
    this.rectWords(x, y, width, height, (wi, bitX, xPos, yPos, n) => {
      const valWord = value[wi];
      for (let b = 0; b < n; b++) {
        const mask = bitMask(bitX + b);
        // rectRead is non-mutating; callback coordinates are rectangle-local,
        // and `cur` is the same dark/not-dark read as `point()`.
        fn({ x: xPos + b, y: yPos }, (valWord & mask) !== 0);
      }
    });
    return this;
  }
  // Horizontal & vertical lines
  hLine(c: Point | number, len: number, value: DrawFn): this {
    return this.rect(c, { width: len, height: 1 }, value);
  }
  vLine(c: Point | number, len: number, value: DrawFn): this {
    return this.rect(c, { width: 1, height: len }, value);
  }
  // add border
  border(border = 2, value: DrawValue): Bitmap {
    // `border` is used both as output-size delta and as embed coordinate; keep
    // it a positive safe integer before those paths allocate or normalize.
    if (!Number.isSafeInteger(border) || border <= 0)
      throw new Error(`Bitmap.border: invalid size=${border}`);
    const height = this.height + 2 * border;
    const width = this.width + 2 * border;
    const out = new Bitmap({ height, width });
    // fill everything with border value, then embed original
    out.rect(0, Infinity, value);
    out.embed({ x: border, y: border }, this);
    return out;
  }
  // Embed another bitmap on coordinates
  embed(c: Point | number, src: Bitmap): this {
    const { x, y } = this.xy(c);
    const { height, width } = Bitmap.size(src.size(), this.size({ x, y }));
    if (width <= 0 || height <= 0) return this;
    const { value, defined } = this;
    const { words: srcStride, value: srcValue } = src;
    // The Bitmap storage docs say "undefined is used as a marker whether cell
    // was written or not"; `embed()` is the packed blit path for materialized
    // source bitmaps, so it flattens the source rectangle to defined dark/light
    // bits instead of treating undefined cells as transparent.
    for (let yPos = 0; yPos < height; yPos++) {
      const srcRow = yPos * srcStride;
      for (let xPos = 0; xPos < width; ) {
        const dstX = x + xPos;
        const { word: dstWord, bit: dstBit } = this.bitIndex(dstX, y + yPos);
        const { word: srcWord, bit: srcBit } = src.bitIndex(xPos, yPos);
        const len = Math.min(32 - dstBit, width - xPos);
        const w0 = srcValue[srcWord];
        const w1 = srcBit && srcWord + 1 < srcRow + srcStride ? srcValue[srcWord + 1] : 0;
        // Source and destination bit offsets may differ, so assemble the source span from up to two words.
        const sVal = srcBit ? ((w0 >>> srcBit) | (w1 << (32 - srcBit))) >>> 0 : w0;
        const dstMask = rangeMask(dstBit, len);
        const valBits = ((sVal & rangeMask(0, len)) << dstBit) >>> 0;
        defined[dstWord] |= dstMask;
        value[dstWord] = (value[dstWord] & ~dstMask) | valBits;
        xPos += len;
      }
    }
    return this;
  }
  // returns rectangular part of bitmap
  rectSlice(c: Point | number, size: Size | number = this.size()): Bitmap {
    const { x, y } = this.xy(c);
    const { height, width } = Bitmap.size(size, this.size({ x, y }));
    const rect = new Bitmap({ height, width });
    this.rectRead({ x, y }, { height, width }, (p, cur) => {
      // rectRead reports undefined cells as false, so copy only when the source defined bit is set.
      if (this.isDefined(x + p.x, y + p.y)) {
        rect.set(p.x, p.y, cur);
      }
    });
    return rect;
  }
  // Change shape, replace rows with columns (data[y][x] -> data[x][y])
  transpose(): Bitmap {
    const { height, width, value, defined, words } = this;
    const dst = new Bitmap({ height: width, width: height });
    const { words: dstStride, value: dstValue, defined: dstDefined, tailMask: dstTail } = dst;
    const tmpV = new Uint32Array(32);
    const tmpD = new Uint32Array(32);
    // Process src in blocks: y in [by..by+31], x in 32-bit words
    for (let by = 0; by < height; by += 32) {
      for (let bx = 0; bx < words; bx++) {
        const rows = Math.min(32, height - by);
        for (let r = 0; r < rows; r++) {
          const wi = this.wordIndex(32 * bx, by + r);
          tmpV[r] = value[wi];
          tmpD[r] = defined[wi];
        }
        // zero-pad remainder
        tmpV.fill(0, rows);
        tmpD.fill(0, rows);
        transpose32(tmpV);
        transpose32(tmpD);
        for (let i = 0; i < 32; i++) {
          const dstY = bx * 32 + i;
          if (dstY >= width) break;
          const dstPos = dst.wordIndex(by, dstY);
          const curMask = by >>> 5 === dstStride - 1 ? dstTail : 0xffffffff;
          dstValue[dstPos] = tmpV[i] & curMask;
          dstDefined[dstPos] = tmpD[i] & curMask;
        }
      }
    }
    return dst;
  }
  // black <-> white (inplace)
  negate(): Bitmap {
    const n = this.defined.length;
    for (let i = 0; i < n; i++) {
      // ISO/IEC 18004:2024 §12 b)5 says to "reverse the colouring of the light
      // and dark pixels"; this dense scratch-bitmap operation materializes every
      // backing bit as defined and does not preserve sparse/undefined cells.
      this.value[i] = ~this.value[i];
      this.defined[i] = 0xffffffff;
    }
    return this;
  }
  // Each pixel size is multiplied by factor
  scale(factor: number): Bitmap {
    if (!Number.isSafeInteger(factor) || factor > 1024)
      throw new Error(`invalid scale factor: ${factor}`);
    const { height, width } = this;
    // Bitmap storage docs say "undefined is used as a marker whether cell was
    // written or not"; `scale()` is an output materialization path and samples
    // with `get()`, so sparse cells become defined light cells. Positive output
    // dimensions stay validated by the Bitmap constructor instead of duplicating
    // dimension checks in every caller that computes a new bitmap size.
    const res = new Bitmap({ height: factor * height, width: factor * width });
    return res.rect({ x: 0, y: 0 }, Infinity, ({ x, y }) =>
      this.get((x / factor) | 0, (y / factor) | 0)
    );
  }
  clone(): Bitmap {
    const res = new Bitmap(this.size());
    res.defined.set(this.defined);
    res.value.set(this.value);
    return res;
  }
  // Ensure that there is no undefined values left
  assertDrawn(): void {
    const { height, width, defined, tailMask, fullWords, words } = this;
    if (!height || !width) return;
    for (let y = 0; y < height; y++) {
      const rowBase = y * words;
      for (let wi = 0; wi < fullWords; wi++) {
        if (defined[rowBase + wi] !== 0xffffffff) throw new Error(`Invalid color type=undefined`);
      }
      if (words !== fullWords && (defined[rowBase + fullWords] & tailMask) !== tailMask)
        throw new Error(`Invalid color type=undefined`);
    }
  }
  countPatternInRow(y: number, patternLen: number, ...patterns: number[]): number {
    // Penalty scanning only passes Table 11 windows over bounded symbol rows;
    // validate this public helper before JS shifts / typed-array reads coerce bad inputs.
    if (!Number.isSafeInteger(patternLen) || patternLen <= 0 || patternLen >= 32)
      throw new Error('wrong patternLen');
    const mask = (1 << patternLen) - 1;
    const { height, width, value, words } = this;
    if (!Number.isSafeInteger(y) || y < 0 || y >= height) return 0;
    let count = 0;
    const rowBase = this.wordIndex(0, y);
    for (let i = 0, window = 0; i < words; i++) {
      const w = value[rowBase + i];
      const bitEnd = i === words - 1 ? width & 31 || 32 : 32;
      for (let b = 0; b < bitEnd; b++) {
        window = ((window << 1) | ((w >>> b) & 1)) & mask;
        if (i * 32 + b + 1 < patternLen) continue;
        for (const p of patterns) {
          if (window !== p) continue;
          count++;
          break;
        }
      }
    }
    return count;
  }
  getRuns(y: number, fn: (len: number, value: boolean) => void): void {
    const { height, width, value, words } = this;
    if (width === 0) return;
    // ISO/IEC 18004:2024 §7.8.3.1 N1 scans adjacent modules in bounded rows
    // and columns; validate this public helper before missing typed-array rows
    // are coerced into all-light runs by bitwise operators.
    if (!Number.isSafeInteger(y) || y < 0 || y >= height) return;
    let runLen = 0;
    let runValue: boolean | undefined;
    const rowBase = this.wordIndex(0, y);
    for (let i = 0; i < words; i++) {
      const word = value[rowBase + i];
      const bitEnd = i === words - 1 ? width & 31 || 32 : 32;
      for (let b = 0; b < bitEnd; b++) {
        const bit = (word & (1 << b)) !== 0;
        if (bit === runValue) {
          runLen++;
          continue;
        }
        if (runValue !== undefined) fn(runLen, runValue);
        runValue = bit;
        runLen = 1;
      }
    }
    if (runValue !== undefined) fn(runLen, runValue);
  }
  popcnt(): number {
    const { height, width, words, fullWords, tailMask } = this;
    if (!height || !width) return 0;
    let count = 0;
    for (let y = 0; y < height; y++) {
      const rowBase = y * words;
      for (let wi = 0; wi < fullWords; wi++) count += popcnt(this.value[rowBase + wi]);
      if (words !== fullWords) count += popcnt(this.value[rowBase + fullWords] & tailMask);
    }
    return count;
  }
  countBoxes2x2(y: number): number {
    const { height, width, words } = this;
    // ISO/IEC 18004:2024 §7.8.3.1 N2 counts 2 x 2 module blocks in bounded
    // rows; reject non-integer scan rows before bitwise coercions truncate them.
    if (width < 2 || !Number.isSafeInteger(y) || y < 0 || y + 1 >= height) return 0;
    const base0 = this.wordIndex(0, y);
    const base1 = this.wordIndex(0, y + 1);
    // valid "left-edge" positions x in [0 .. W-2]
    const tailBits = width & 31;
    const validLast = tailBits === 0 ? 0x7fffffff : rangeMask(0, (width - 1) & 31);
    let boxes = 0;
    for (let wi = 0; wi < words; wi++) {
      const a0 = this.value[base0 + wi];
      const a1 = this.value[base1 + wi];
      // Compare bit x with bit x+1 at same bit position.
      const eqV = ~(a0 ^ a1) >>> 0; // row0[x] == row1[x]
      const n0 = wi + 1 < words ? this.value[base0 + wi + 1] >>> 0 : 0;
      const eqH0 = ~(a0 ^ (((a0 >>> 1) | ((n0 & 1) << 31)) >>> 0)) >>> 0; // row0[x] == row0[x+1]
      const n1 = wi + 1 < words ? this.value[base1 + wi + 1] >>> 0 : 0;
      const eqH1 = ~(a1 ^ (((a1 >>> 1) | ((n1 & 1) << 31)) >>> 0)) >>> 0; // row1[x] == row1[x+1]
      let m = (eqV & eqH0 & eqH1) >>> 0;
      if (wi === words - 1) m &= validLast;
      boxes += popcnt(m);
    }
    return boxes;
  }
  // Export
  toString(): string {
    const nl = String.fromCharCode(chCodes.newline);
    let out = '';
    for (let y = 0; y < this.height; y++) {
      let line = '';
      for (let x = 0; x < this.width; x++) {
        const v = this.get(x, y);
        line += !this.isDefined(x, y) ? '?' : v ? 'X' : ' ';
      }
      out += line + (y + 1 === this.height ? '' : nl);
    }
    return out;
  }
  toRaw(): DrawValue[][] {
    const out: DrawValue[][] = Array.from({ length: this.height }, () => new Array(this.width));
    for (let y = 0; y < this.height; y++) {
      const row = out[y];
      // Bitmap storage docs say "undefined is used as a marker whether cell was
      // written or not"; `toRaw()` is the materialized dark/not-dark output path
      // used after `encodeQR()` asserts the QR symbol is fully drawn.
      for (let x = 0; x < this.width; x++) row[x] = this.get(x, y);
    }
    return out;
  }
  toASCII(): string {
    const { height, width } = this;
    let out = '';
    // Terminal character height is x2 of character width, so we process two rows of bitmap
    // to produce one row of ASCII
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x++) {
        const first = this.get(x, y);
        const second = y + 1 >= height ? true : this.get(x, y + 1); // if last row outside bitmap, make it black
        if (!first && !second)
          out += '█'; // both rows white (empty)
        else if (!first && second)
          out += '▀'; // top row white
        else if (first && !second)
          out += '▄'; // down row white
        else if (first && second) out += ' '; // both rows black
      }
      out += String.fromCharCode(chCodes.newline);
    }
    return out;
  }
  toTerm(): string {
    const cc = String.fromCharCode(chCodes.reset);
    const reset = cc + '[0m';
    const whiteBG = cc + '[1;47m  ' + reset;
    const darkBG = cc + `[40m  ` + reset;
    const nl = String.fromCharCode(chCodes.newline);
    let out = '';
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const v = this.get(x, y); // undefined -> white
        out += v ? darkBG : whiteBG;
      }
      out += nl;
    }
    return out;
  }
  toSVG(optimize = true): string {
    let out = `<svg viewBox="0 0 ${this.width} ${this.height}" xmlns="http://www.w3.org/2000/svg">`;
    // ISO/IEC 18004:2024 §5.1 c) / §5.3.8: this SVG draws only dark modules;
    // callers must render it on a light background for light modules and the quiet zone.
    // Construct optimized SVG path data.
    let pathData = '';
    let prevPoint: Point | undefined;
    this.rectRead(0, Infinity, (point, val) => {
      if (!val) return;
      const { x, y } = point;

      if (!optimize) {
        out += `<rect x="${x}" y="${y}" width="1" height="1" />`;
        return;
      }

      // https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/d#path_commands

      // Determine the shortest way to represent the initial cursor movement.
      // M - Move cursor (without drawing) to absolute coordinate pair.
      let m = `M${x} ${y}`;
      // Only allow using the relative cursor move command if previous points
      // were drawn.
      if (prevPoint) {
        // m - Move cursor (without drawing) to relative coordinate pair.
        const relM = `m${x - prevPoint.x} ${y - prevPoint.y}`;
        if (relM.length <= m.length) m = relM;
      }

      // Determine the shortest way to represent the cell's bottom line draw.
      // H - Draw line from cursor position to absolute x coordinate.
      // h - Draw line from cursor position to relative x coordinate.
      const bH = x < 10 ? `H${x}` : 'h-1';

      // v - Draw line from cursor position to relative y coordinate.
      // Z - Close path (draws line from cursor position to M coordinate).
      pathData += `${m}h1v1${bH}Z`;
      prevPoint = point;
    });
    if (optimize) out += `<path d="${pathData}"/>`;
    out += `</svg>`;
    return out;
  }
  toGIF(): Uint8Array {
    // NOTE: Small, but inefficient implementation.
    // Uses 1 byte per pixel.
    const u16le = (i: number) => [i & 0xff, (i >>> 8) & 0xff];
    const dims = [...u16le(this.width), ...u16le(this.height)];
    const data: number[] = [];
    // Palette index 0 is white/light and index 1 is black/dark; rectRead maps undefined cells to light.
    this.rectRead(0, Infinity, (_, cur) => data.push(+(cur === true)));
    // Each chunk starts with an LZW clear code; 126 raw pixels keep codes at 8 bits until the next clear.
    const N = 126; // Block size
    // prettier-ignore
    const bytes = [
      0x47, 0x49, 0x46, 0x38, 0x37, 0x61, ...dims, 0xf6, 0x00, 0x00, 0xff, 0xff, 0xff,
      ...fillArr(3 * 127, 0x00), 0x2c, 0x00, 0x00, 0x00, 0x00, ...dims, 0x00, 0x07
    ];
    const fullChunks = Math.floor(data.length / N);
    // Full blocks
    for (let i = 0; i < fullChunks; i++)
      bytes.push(N + 1, 0x80, ...data.slice(N * i, N * (i + 1)).map((i) => +i));
    // Remaining bytes
    bytes.push((data.length % N) + 1, 0x80, ...data.slice(fullChunks * N).map((i) => +i));
    bytes.push(0x01, 0x81, 0x00, 0x3b);
    return new Uint8Array(bytes);
  }
  toImage(isRGB = false): Image {
    const { height, width } = this.size();
    const data = new Uint8Array(height * width * (isRGB ? 3 : 4));
    let i = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = this.get(x, y) ? 0 : 255; // undefined -> white
        data[i++] = value;
        data[i++] = value;
        data[i++] = value;
        if (!isRGB) data[i++] = 255; // alpha channel
      }
    }
    return { height, width, data };
  }
}
// End of utils

// Runtime type-checking
/** Error correction mode. low: 7%, medium: 15%, quartile: 25%, high: 30%. */
export const ECMode: readonly ['low', 'medium', 'quartile', 'high'] = /* @__PURE__ */ Object.freeze(
  ['low', 'medium', 'quartile', 'high']
);
/** Error correction mode name. */
export type ErrorCorrection = (typeof ECMode)[number];
/** QR Code version in the `[1..40]` range. */
export type Version = number; // 1..40
/** QR Code mask index. */
export type Mask = (0 | 1 | 2 | 3 | 4 | 5 | 6 | 7) & keyof typeof PATTERNS; // 0..7
/**
 * QR payload compaction mode names recognized by the type/validator.
 * `kanji` and `eci` are spec modes, but `encodeQR` currently rejects them until implemented.
 */
export const Encoding: readonly ['numeric', 'alphanumeric', 'byte', 'kanji', 'eci'] =
  /* @__PURE__ */ Object.freeze(['numeric', 'alphanumeric', 'byte', 'kanji', 'eci']);
/** QR payload encoding name. */
export type EncodingType = (typeof Encoding)[number];

// Various constants & tables
// ISO/IEC 18004:2024 Table 1: QR symbol codeword capacity by version (data plus error correction).
// prettier-ignore
const BYTES = [
// 1,  2,  3,   4,   5,   6,   7,   8,   9,  10,  11,  12,  13,  14,  15,  16,  17,  18,  19,   20,
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
//  21,   22,   23,   24,   25,   26,   27,   28,   29,   30,   31,   32,   33,   34,   35,   36,   37,   38,   39,   40
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];
// ISO/IEC 18004:2024 Table 9: error correction codewords per block by version and level.
// prettier-ignore
const WORDS_PER_BLOCK = {
  // Version 1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
  low:      [7,  10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  medium:   [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  quartile: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  high:    [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
// ISO/IEC 18004:2024 Table 9: error correction block count by version and level.
// prettier-ignore
const ECC_BLOCKS = {
	// Version   1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
	low:      [  1, 1, 1, 1, 1, 2, 2, 2, 2, 4,  4,  4,  4,  4,  6,  6,  6,  6,  7,  8,  8,  9,  9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	medium:   [  1, 1, 1, 2, 2, 4, 4, 4, 5, 5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
	quartile: [  1, 1, 2, 2, 4, 4, 6, 6, 8, 8,  8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
	high:    [  1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

// ISO/IEC 18004:2024 sections 5.3/7.4/7.5/7.9/7.10: QR layout, segment, format/version, and capacity helpers.
const info = /* @__PURE__ */ Object.freeze({
  size: /* @__PURE__ */ Object.freeze({
    encode: (ver: Version) => 21 + 4 * (ver - 1), // ver1 = 21, ver40 = 177 modules per side
    decode: (size: number) => (size - 17) / 4,
  } as Coder<Version, number>),
  // ISO/IEC 18004:2024 Table 3: map version ranges 1-9, 10-26, and 27-40 to count-width indexes.
  sizeType: (ver: Version) => Math.floor((ver + 7) / 17),
  // ISO/IEC 18004:2024 Annex E Table E.1: row/column coordinate list of alignment-pattern centres.
  // Based on https://codereview.stackexchange.com/questions/74925/algorithm-to-generate-this-alignment-pattern-locations-table-for-qr-codes
  alignmentPatterns(ver: Version) {
    if (ver === 1) return [];
    const first = 6;
    const last = info.size.encode(ver) - first - 1;
    const distance = last - first;
    const count = Math.ceil(distance / 28);
    let interval = Math.floor(distance / count);
    if (interval % 2) interval += 1;
    else if ((distance % count) * 2 >= count) interval += 2;
    const res = [first];
    for (let m = 1; m < count; m++) res.push(last - (count - m) * interval);
    res.push(last);
    return res;
  },
  // ISO/IEC 18004:2024 §7.9.1 Table 12: error-correction-level indicators for the top two format-information data bits.
  ECCode: /* @__PURE__ */ Object.freeze({
    low: 0b01,
    medium: 0b00,
    quartile: 0b11,
    high: 0b10,
  } as Record<ErrorCorrection, number>),
  // ISO/IEC 18004:2024 §7.9.1 final paragraph: XOR the 15-bit format information with mask pattern 101010000010010.
  formatMask: 0b101010000010010,
  // ISO/IEC 18004:2024 §7.9.1 / Annex C.2: append the 10-bit BCH remainder for the 5 data bits, then apply the fixed QR format mask.
  formatBits(ecc: ErrorCorrection, maskIdx: Mask) {
    const data = (info.ECCode[ecc] << 3) | maskIdx;
    let d = data;
    for (let i = 0; i < 10; i++) d = (d << 1) ^ ((d >> 9) * 0b10100110111);
    return ((data << 10) | d) ^ info.formatMask;
  },
  // ISO/IEC 18004:2024 §7.10 / Annex D.2: append the 12-bit Golay remainder to the 6-bit version word; version information is not masked.
  versionBits(ver: Version) {
    let d = ver;
    for (let i = 0; i < 12; i++) d = (d << 1) ^ ((d >> 11) * 0b1111100100101);
    return (ver << 12) | d;
  },
  // ISO/IEC 18004:2024 §7.3.3 / §7.3.4 / §7.4.5 Table 5: character-set membership and value codecs for numeric and alphanumeric QR modes.
  alphabet: /* @__PURE__ */ Object.freeze({
    // ISO/IEC 18004:2024 §7.3.3 / §7.4.4: numeric-mode digits map directly to values 0..9 before 3-digit grouping.
    numeric: alphabet('0123456789'),
    // ISO/IEC 18004:2024 §7.3.4 / §7.4.5 Table 5: 45-character alphanumeric-mode value order used for 11-bit pair packing. Keep the legacy `alphanumerc` key name in sync with existing callers.
    alphanumerc: alphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'),
  }), // as Record<EncodingType, ReturnType<typeof alphabet>>,
  // ISO/IEC 18004:2024 Table 3 gives QR character-count widths for data modes; ECI headers instead carry only the mode indicator plus the designator from §7.4.3.
  lengthBits(ver: Version, type: EncodingType) {
    const table: Record<EncodingType, [number, number, number]> = {
      numeric: [10, 12, 14],
      alphanumeric: [9, 11, 13],
      byte: [8, 16, 16],
      kanji: [8, 10, 12],
      eci: [0, 0, 0],
    };
    return table[type][info.sizeType(ver)];
  },
  // ISO/IEC 18004:2024 §7.4.2 Table 2: 4-bit QR mode indicators for the segment types this library models.
  modeBits: /* @__PURE__ */ Object.freeze({
    numeric: '0001',
    alphanumeric: '0010',
    byte: '0100',
    kanji: '1000',
    eci: '0111',
  }),
  // ISO/IEC 18004:2024 Table 1 / §7.5.1 Table 9: derive total data bits and short/long RS block layout from total codewords, ECC words per block, and block counts.
  capacity(ver: Version, ecc: ErrorCorrection) {
    const bytes = BYTES[ver - 1];
    const words = WORDS_PER_BLOCK[ecc][ver - 1];
    const numBlocks = ECC_BLOCKS[ecc][ver - 1];
    const blockLen = Math.floor(bytes / numBlocks) - words;
    const shortBlocks = numBlocks - (bytes % numBlocks);
    return {
      words,
      numBlocks,
      shortBlocks,
      blockLen,
      capacity: (bytes - words * numBlocks) * 8,
      total: (words + blockLen) * numBlocks + numBlocks - shortBlocks,
    };
  },
});

// ISO/IEC 18004:2024 Table 10: QR data-mask predicates 000..111, written here in (x column, y row) form.
const PATTERNS: readonly ((x: number, y: number) => boolean)[] = /* @__PURE__ */ Object.freeze([
  (x: number, y: number) => (x + y) % 2 == 0,
  (_x: number, y: number) => y % 2 == 0,
  (x: number, _y: number) => x % 3 == 0,
  (x: number, y: number) => (x + y) % 3 == 0,
  (x: number, y: number) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 == 0,
  (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) == 0,
  (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 == 0,
  (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 == 0,
] as const);

// Galois field && reed-solomon encoding
// ISO/IEC 18004:2024 §7.5.2 / Annex A / Annex B: GF(2^8) field and polynomial helpers shared by QR Reed-Solomon parity generation and decoding.
const GF = {
  tables: ((p_poly) => {
    const exp = fillArr(256, 0);
    const log = fillArr(256, 0);
    for (let i = 0, x = 1; i < 256; i++) {
      exp[i] = x;
      log[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= p_poly;
    }
    // Keep α^255 = 1 in exp[255]; GF.log() folds the matching log[1] = 255
    // back to 0 with `% 255`, so later helpers can wrap exponents without a special case.
    return { exp, log };
  })(0x11d),
  // Raw α^i lookup from the precomputed field table; callers are expected
  // to reduce / validate exponents before indexing it.
  exp: (x: number) => GF.tables.exp[x],
  // log(0) is undefined in GF(2^8); `% 255` also folds the wrapped table
  // entry for α^255 = 1 back to exponent 0.
  log(x: number) {
    if (x === 0) throw new Error(`GF.log: invalid arg=${x}`);
    return GF.tables.log[x] % 255;
  },
  // Zero has no logarithm in GF(2^8), so it must short-circuit here; all
  // other products are α^(log(x) + log(y) mod 255) in the reviewed field.
  mul(x: number, y: number) {
    if (x === 0 || y === 0) return 0;
    return GF.tables.exp[(GF.tables.log[x] + GF.tables.log[y]) % 255];
  },
  // In characteristic 2 fields, addition and subtraction are the same
  // bitwise XOR operation used by the QR Reed-Solomon arithmetic.
  add: (x: number, y: number) => x ^ y,
  // Raw nonzero field power helper. Current QR use is GF.pow(2, i) for the
  // Annex A generator factors; x = 0 or negative exponents are not validated.
  pow: (x: number, e: number) => GF.tables.exp[(GF.tables.log[x] * e) % 255],
  // Multiplicative inverse for nonzero field elements. Current callers only
  // use it on values already known to be nonzero; 0 has no inverse in GF(2^8).
  inv(x: number) {
    if (x === 0) throw new Error(`GF.inverse: invalid arg=${x}`);
    return GF.tables.exp[255 - GF.tables.log[x]];
  },
  // Canonicalize coefficient arrays by trimming leading zero coefficients
  // while preserving `[0]` as the zero polynomial; already-normalized inputs
  // are returned by reference.
  polynomial(poly: number[]) {
    if (poly.length == 0) throw new Error('GF.polymomial: invalid length');
    if (poly[0] !== 0) return poly;
    // Strip leading zeros
    let i = 0;
    for (; i < poly.length - 1 && poly[i] == 0; i++);
    return poly.slice(i);
  },
  // Represent c*x^degree in the descending-power coefficient layout used
  // by the QR Reed-Solomon helpers; coefficient 0 canonicalizes to `[0]`.
  monomial(degree: number, coefficient: number) {
    if (degree < 0) throw new Error(`GF.monomial: invalid degree=${degree}`);
    if (coefficient == 0) return [0];
    let coefficients = fillArr(degree + 1, 0);
    coefficients[0] = coefficient;
    return GF.polynomial(coefficients);
  },
  // Canonical polynomials keep the highest-order coefficient first and use
  // `[0]` for zero, so degree is just `length - 1`.
  degree: (a: number[]) => a.length - 1,
  // Read the coefficient for x^degree from the descending-power array layout.
  // Canonical arrays make this a direct index; out-of-range degrees return `undefined`.
  coefficient: (a: any, degree: number) => a[GF.degree(a) - degree],
  // Multiply descending-power coefficient arrays by convolution over GF(2^8).
  // Zero short-circuits here before the log-based field multiply is consulted.
  mulPoly(a: number[], b: number[]) {
    if (a[0] === 0 || b[0] === 0) return [0];
    const res = fillArr(a.length + b.length - 1, 0);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        res[i + j] = GF.add(res[i + j], GF.mul(a[i], b[j]));
      }
    }
    return GF.polynomial(res);
  },
  // Scale every coefficient by the same field element in descending-power order.
  // Scalar 0 canonicalizes to `[0]`, and scalar 1 reuses the original array.
  mulPolyScalar(a: number[], scalar: number) {
    if (scalar == 0) return [0];
    if (scalar == 1) return a;
    const res = fillArr(a.length, 0);
    for (let i = 0; i < a.length; i++) res[i] = GF.mul(a[i], scalar);
    return GF.polynomial(res);
  },
  // Multiply a polynomial by c*x^degree in descending-power coefficient form.
  // This scales existing coefficients, then appends trailing zero coefficients.
  mulPolyMonomial(a: number[], degree: number, coefficient: number) {
    if (degree < 0) throw new Error('GF.mulPolyMonomial: invalid degree');
    if (coefficient == 0) return [0];
    const res = fillArr(a.length + degree, 0);
    for (let i = 0; i < a.length; i++) res[i] = GF.mul(a[i], coefficient);
    return GF.polynomial(res);
  },
  // Add descending-power coefficient arrays with GF(2^8) XOR on the aligned
  // suffix; `[0]` short-circuits by returning the other array unchanged.
  addPoly(a: number[], b: number[]) {
    if (a[0] === 0) return b;
    if (b[0] === 0) return a;
    let smaller = a;
    let larger = b;
    if (smaller.length > larger.length) [smaller, larger] = [larger, smaller];
    let sumDiff = fillArr(larger.length, 0);
    let lengthDiff = larger.length - smaller.length;
    let s = larger.slice(0, lengthDiff);
    for (let i = 0; i < s.length; i++) sumDiff[i] = s[i];
    for (let i = lengthDiff; i < larger.length; i++)
      sumDiff[i] = GF.add(smaller[i - lengthDiff], larger[i]);
    return GF.polynomial(sumDiff);
  },
  // Synthetic division for monic divisors in descending-power coefficient form.
  // Callers are expected to append `divisor.length - 1` zero coefficients first.
  remainderPoly(data: number[], divisor: number[]) {
    const out = Array.from(data);
    for (let i = 0; i < data.length - divisor.length + 1; i++) {
      const elm = out[i];
      if (elm === 0) continue;
      for (let j = 1; j < divisor.length; j++) {
        if (divisor[j] !== 0) out[i + j] = GF.add(out[i + j], GF.mul(divisor[j], elm));
      }
    }
    return out.slice(data.length - divisor.length + 1, out.length);
  },
  // Build Annex A's monic generator polynomial g_n(x) = Π(x - 2^i).
  // degree=0 returns `[1]`; callers are expected to validate degree bounds.
  divisorPoly(degree: number) {
    let g = [1];
    for (let i = 0; i < degree; i++) g = GF.mulPoly(g, [1, GF.pow(2, i)]);
    return g;
  },
  // Evaluate a descending-power coefficient array at `a` with Horner's rule.
  // The `a == 0` fast-path returns the x^0 coefficient directly.
  evalPoly(poly: any, a: number) {
    if (a == 0) return GF.coefficient(poly, 0); // Just return the x^0 coefficient
    let res = poly[0];
    for (let i = 1; i < poly.length; i++) res = GF.add(GF.mul(a, res), poly[i]);
    return res;
  },
  // TODO: cleanup
  // Extended Euclidean RS step: derive the locator/evaluator pair from x^R
  // and the syndrome polynomial, then normalize sigma(0) to 1.
  euclidian(a: number[], b: number[], R: number) {
    // Force degree(a) >= degree(b)
    if (GF.degree(a) < GF.degree(b)) [a, b] = [b, a];
    let rLast = a;
    let r = b;
    let tLast = [0];
    let t = [1];
    // while degree of Ri ≥ t/2
    while (2 * GF.degree(r) >= R) {
      let rLastLast = rLast;
      let tLastLast = tLast;
      rLast = r;
      tLast = t;
      if (rLast[0] === 0) throw new Error('rLast[0] === 0');
      r = rLastLast;

      let q = [0];
      const dltInverse = GF.inv(rLast[0]);
      while (GF.degree(r) >= GF.degree(rLast) && r[0] !== 0) {
        const degreeDiff = GF.degree(r) - GF.degree(rLast);
        const scale = GF.mul(r[0], dltInverse);
        q = GF.addPoly(q, GF.monomial(degreeDiff, scale));
        r = GF.addPoly(r, GF.mulPolyMonomial(rLast, degreeDiff, scale));
      }
      q = GF.mulPoly(q, tLast);
      t = GF.addPoly(q, tLastLast);
      if (GF.degree(r) >= GF.degree(rLast))
        throw new Error(`Division failed r: ${r}, rLast: ${rLast}`);
    }
    const sigmaTildeAtZero = GF.coefficient(t, 0);
    if (sigmaTildeAtZero == 0) throw new Error('sigmaTilde(0) was zero');
    const inverse = GF.inv(sigmaTildeAtZero);
    return [GF.mulPolyScalar(t, inverse), GF.mulPolyScalar(r, inverse)];
  },
};

// Per-block Reed-Solomon coder: encode emits only the parity bytes for one
// data block, while decode expects data+parity bytes and returns the corrected full block.
function RS(eccWords: number): TRet<Coder<Uint8Array, Uint8Array>> {
  return {
    encode(from: TArg<Uint8Array>): TRet<Uint8Array> {
      const d = GF.divisorPoly(eccWords);
      const pol = Array.from(from);
      pol.push(...d.slice(0, -1).fill(0));
      return Uint8Array.from(GF.remainderPoly(pol, d)) as TRet<Uint8Array>;
    },
    decode(to: TArg<Uint8Array>): TRet<Uint8Array> {
      const res = to.slice();
      const poly = GF.polynomial(Array.from(to));
      // Find errors
      let syndrome = fillArr(eccWords, 0);
      let hasError = false;
      for (let i = 0; i < eccWords; i++) {
        const evl = GF.evalPoly(poly, GF.exp(i));
        syndrome[syndrome.length - 1 - i] = evl;
        if (evl !== 0) hasError = true;
      }
      if (!hasError) return res;
      syndrome = GF.polynomial(syndrome);
      const monomial = GF.monomial(eccWords, 1);
      const [errorLocator, errorEvaluator] = GF.euclidian(monomial, syndrome, eccWords);
      // Error locations
      const locations = fillArr(GF.degree(errorLocator), 0);
      let e = 0;
      for (let i = 1; i < 256 && e < locations.length; i++) {
        if (GF.evalPoly(errorLocator, i) === 0) locations[e++] = GF.inv(i);
      }
      if (e !== locations.length) throw new Error('RS.decode: invalid errors number');
      for (let i = 0; i < locations.length; i++) {
        const pos = res.length - 1 - GF.log(locations[i]);
        if (pos < 0) throw new Error('RS.decode: invalid error location');
        const xiInverse = GF.inv(locations[i]);
        let denominator = 1;
        for (let j = 0; j < locations.length; j++) {
          if (i === j) continue;
          denominator = GF.mul(denominator, GF.add(1, GF.mul(locations[j], xiInverse)));
        }
        res[pos] = GF.add(
          res[pos],
          GF.mul(GF.evalPoly(errorEvaluator, xiInverse), GF.inv(denominator))
        );
      }
      return res as TRet<Uint8Array>;
    },
  } as TRet<Coder<Uint8Array, Uint8Array>>;
}

// Interleaves blocks
// QR block interleaver / deinterleaver. Shorter data blocks stay first so
// encode matches ISO/IEC 18004 §7.6 c) and decode can reverse it via §12 z)1.
function interleave(ver: Version, ecc: ErrorCorrection): TRet<Coder<Uint8Array, Uint8Array>> {
  const { words, shortBlocks, numBlocks, blockLen, total } = info.capacity(ver, ecc);
  const rs = RS(words);
  return {
    encode(bytes: TArg<Uint8Array>): TRet<Uint8Array> {
      // Caller must pass exactly the data codewords for this version/ecc;
      // this helper only splits blocks and interleaves them with RS parity.
      // Add error correction to bytes
      const blocks: Uint8Array[] = [];
      const eccBlocks: Uint8Array[] = [];
      for (let i = 0; i < numBlocks; i++) {
        const isShort = i < shortBlocks;
        const len = blockLen + (isShort ? 0 : 1);
        blocks.push(bytes.subarray(0, len));
        eccBlocks.push(rs.encode(bytes.subarray(0, len)));
        bytes = bytes.subarray(len);
      }
      const resBlocks = interleaveBytes(blocks);
      const resECC = interleaveBytes(eccBlocks);
      const res = new Uint8Array(resBlocks.length + resECC.length);
      res.set(resBlocks);
      res.set(resECC, resBlocks.length);
      return res as TRet<Uint8Array>;
    },
    decode(data: TArg<Uint8Array>): TRet<Uint8Array> {
      if (data.length !== total)
        throw new Error(`interleave.decode: len(data)=${data.length}, total=${total}`);
      const blocks = [];
      for (let i = 0; i < numBlocks; i++) {
        const isShort = i < shortBlocks;
        blocks.push(new Uint8Array(words + blockLen + (isShort ? 0 : 1)));
      }
      // Short blocks
      let pos = 0;
      for (let i = 0; i < blockLen; i++) {
        for (let j = 0; j < numBlocks; j++) blocks[j][i] = data[pos++];
      }
      // Long blocks
      for (let j = shortBlocks; j < numBlocks; j++) blocks[j][blockLen] = data[pos++];
      // ECC
      for (let i = blockLen; i < blockLen + words; i++) {
        for (let j = 0; j < numBlocks; j++) {
          const isShort = j < shortBlocks;
          blocks[j][i + (isShort ? 0 : 1)] = data[pos++];
        }
      }
      // Decode
      // Error-correct and copy data blocks together into a stream of bytes
      const res: number[] = [];
      for (const block of blocks) res.push(...Array.from(rs.decode(block)).slice(0, -words));
      return Uint8Array.from(res) as TRet<Uint8Array>;
    },
  } as TRet<Coder<Uint8Array, Uint8Array>>;
}

// Draw
// Generic template per version+ecc+mask. Can be cached, to speedup calculations.
// Function-pattern template plus reserved format/version areas; data modules
// are filled later by zigzag placement in `drawQR`.
function drawTemplate(
  ver: Version,
  ecc: ErrorCorrection,
  maskIdx: Mask,
  test: boolean = false
): TRet<Bitmap> {
  const size = info.size.encode(ver);
  let b = new Bitmap(size + 2);
  // Finder patterns
  // We draw full pattern and later slice, since before addition of borders finder is truncated by one pixel on sides
  const finder = new Bitmap(3).rect(0, 3, true).border(1, false).border(1, true).border(1, false);
  b = b
    .embed(0, finder) // top left
    .embed({ x: -finder.width, y: 0 }, finder) // top right
    .embed({ x: 0, y: -finder.height }, finder); // bottom left
  b = b.rectSlice(1, size);
  // Alignment patterns
  const align = new Bitmap(1).rect(0, 1, true).border(1, false).border(1, true);
  const alignPos = info.alignmentPatterns(ver);
  for (const y of alignPos) {
    for (const x of alignPos) {
      if (b.isDefined(x, y)) continue;
      b.embed({ x: x - 2, y: y - 2 }, align); // center of pattern should be at position
    }
  }
  // Timing patterns
  b = b
    .hLine({ x: 0, y: 6 }, Infinity, ({ x }) => (b.isDefined(x, 6) ? undefined : x % 2 == 0))
    .vLine({ x: 6, y: 0 }, Infinity, ({ y }) => (b.isDefined(6, y) ? undefined : y % 2 == 0));
  // Format information
  {
    const bits = info.formatBits(ecc, maskIdx);
    const getBit = (i: number) => !test && ((bits >> i) & 1) == 1;
    // vertical
    for (let i = 0; i < 6; i++) b.set(8, i, getBit(i)); // right of top-left finder
    // TODO: re-write as lines, like:
    // b.vLine({ x: 8, y: 0 }, 6, ({ x, y }) => getBit(y));
    for (let i = 6; i < 8; i++) b.set(8, i + 1, getBit(i)); // after timing pattern
    for (let i = 8; i < 15; i++) b.set(8, size - 15 + i, getBit(i)); // right of bottom-left finder
    // horizontal
    for (let i = 0; i < 8; i++) b.set(size - i - 1, 8, getBit(i)); // under top-right finder
    for (let i = 8; i < 9; i++) b.set(15 - i - 1 + 1, 8, getBit(i)); // VVV, after timing
    for (let i = 9; i < 15; i++) b.set(15 - i - 1, 8, getBit(i)); // under top-left finder
    b.set(8, size - 8, !test); // bottom-left finder, right
  }
  // Version information
  if (ver >= 7) {
    const bits = info.versionBits(ver);
    for (let i = 0; i < 18; i += 1) {
      const bit = !test && ((bits >> i) & 1) == 1;
      const x = Math.floor(i / 3);
      const y = (i % 3) + size - 8 - 3;
      // two copies
      b.set(y, x, bit);
      b.set(x, y, bit);
    }
  }
  return b as TRet<Bitmap>;
}
// Walk undefined data modules in the QR two-column zigzag order from the
// lower right, skipping function patterns and the vertical timing column.
function zigzag(
  tpl: TArg<Bitmap>,
  maskIdx: Mask,
  fn: (x: number, y: number, mask: boolean) => void
): void {
  const bm = tpl as Bitmap;
  const size = bm.height;
  const pattern = PATTERNS[maskIdx];
  // zig-zag pattern
  let dir = -1;
  let y = size - 1;
  // two columns at time
  for (let xOffset = size - 1; xOffset > 0; xOffset -= 2) {
    if (xOffset == 6) xOffset = 5; // skip vertical timing pattern
    for (; ; y += dir) {
      for (let j = 0; j < 2; j += 1) {
        const x = xOffset - j;
        if (bm.isDefined(x, y)) continue; // skip already written elements
        fn(x, y, pattern(x, y));
      }
      if (y + dir < 0 || y + dir >= size) break;
    }
    dir = -dir; // change direction
  }
}

// NOTE: byte encoding is just representation, QR works with strings only. Most decoders will fail on raw byte array,
// since they expect unicode or other text encoding inside bytes
// Auto-pick among the currently supported single-segment modes only.
// Empty strings stay numeric, and any non-alphanumeric character falls back to byte.
function detectType(str: string): EncodingType {
  let type: EncodingType = 'numeric';
  for (let x of str) {
    if (info.alphabet.numeric.has(x)) continue;
    type = 'alphanumeric';
    if (!info.alphabet.alphanumerc.has(x)) return 'byte';
  }
  return type;
}

// Global symbols in both browsers and Node.js since v11
// See https://github.com/microsoft/TypeScript/issues/31535
declare const TextEncoder: any;
/**
 * Encode a string as UTF-8 bytes.
 * @param str - Text to encode into UTF-8.
 * @returns UTF-8 bytes for the provided string.
 * @throws If the input is not a string. {@link Error}
 * @example
 * Encode a string as UTF-8 bytes.
 * ```ts
 * const bytes = utf8ToBytes('abc'); // new Uint8Array([97, 98, 99])
 * ```
 */
// ISO/IEC 18004:2024 §7.3.2 says QR's default interpretation is
// "ECI 000003 representing the ISO/IEC 8859-1 character set"; §7.4.2 says
// non-default initial ECI data starts with an ECI header. Keep UTF-8 bytes
// without that header for compatibility with existing emoji/qrcode fixtures.
export function utf8ToBytes(str: string): TRet<Uint8Array> {
  if (typeof str !== 'string') throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
  return new Uint8Array(new TextEncoder().encode(str)) as TRet<Uint8Array>; // https://bugzil.la/1681809
}

// Build one QR mode/count/data segment, then append the terminator, zero padding,
// and alternating pad codewords before RS interleaving.
function encode(
  ver: Version,
  ecc: ErrorCorrection,
  data: string,
  type: EncodingType,
  encoder: TArg<(value: string) => Uint8Array> = utf8ToBytes
): TRet<Uint8Array> {
  let encoded = '';
  let dataLen = data.length;
  if (type === 'numeric') {
    const t = info.alphabet.numeric.decode(data.split(''));
    const n = t.length;
    for (let i = 0; i < n - 2; i += 3) encoded += bin(t[i] * 100 + t[i + 1] * 10 + t[i + 2], 10);
    if (n % 3 === 1) {
      encoded += bin(t[n - 1], 4);
    } else if (n % 3 === 2) {
      encoded += bin(t[n - 2] * 10 + t[n - 1], 7);
    }
  } else if (type === 'alphanumeric') {
    const t = info.alphabet.alphanumerc.decode(data.split(''));
    const n = t.length;
    for (let i = 0; i < n - 1; i += 2) encoded += bin(t[i] * 45 + t[i + 1], 11);
    if (n % 2 == 1) encoded += bin(t[n - 1], 6); // pad if odd number of chars
  } else if (type === 'byte') {
    // The default encoder is intentionally UTF-8-without-ECI; see utf8ToBytes().
    const utf8 = encoder(data);
    dataLen = utf8.length;
    encoded = Array.from(utf8)
      .map((i) => bin(i, 8))
      .join('');
  } else {
    throw new Error('encode: unsupported type');
  }
  const { capacity } = info.capacity(ver, ecc);
  const len = bin(dataLen, info.lengthBits(ver, type));
  let bits = info.modeBits[type] + len + encoded;
  if (bits.length > capacity) throw new Error('Capacity overflow');
  // Terminator
  bits += '0'.repeat(Math.min(4, Math.max(0, capacity - bits.length)));
  // Pad bits string untill full byte
  if (bits.length % 8) bits += '0'.repeat(8 - (bits.length % 8));
  // Add padding until capacity is full
  const padding = '1110110000010001';
  for (let idx = 0; bits.length !== capacity; idx++) bits += padding[idx % padding.length];
  // Convert a bitstring to array of bytes
  const bytes = Uint8Array.from(bits.match(/(.{8})/g)!.map((i) => Number(`0b${i}`)));
  return interleave(ver, ecc).encode(bytes) as TRet<Uint8Array>;
}

// DRAW
// Stream interleaved codeword bits MSB-first through zigzag; any leftover
// cells after the final codeword become zero-valued remainder bits before masking.
function drawQR(
  ver: Version,
  ecc: ErrorCorrection,
  data: TArg<Uint8Array>,
  maskIdx: Mask,
  test: boolean = false
): TRet<Bitmap> {
  const b = drawTemplate(ver, ecc, maskIdx, test) as Bitmap;
  let i = 0;
  const need = 8 * data.length;
  zigzag(b, maskIdx, (x, y, mask) => {
    let value = false;
    if (i < need) {
      value = ((data[i >>> 3] >> ((7 - i) & 7)) & 1) !== 0;
      i++;
    }
    b.set(x, y, value !== mask); // !== as xor
  });
  if (i !== need) throw new Error('QR: bytes left after draw');
  return b as TRet<Bitmap>;
}

// Pack a left-to-right row pattern for `Bitmap.countPatternInRow()`; keep the
// explicit width because leading light modules vanish from the numeric value.
const mkPattern = (pattern: boolean[]) => {
  const s = pattern.map((i) => (i ? '1' : '0')).join('');
  return { len: s.length, n: Number(`0b${s}`) };
};
// 1:1:3:1:1 ratio (dark:light:dark:light:dark) pattern in row/column, preceded or followed by light area 4 modules wide
const finderPattern = [true, false, true, true, true, false, true]; // dark:light:dark:light:dark
const lightPattern = [false, false, false, false]; // light area 4 modules wide
const P1 = /* @__PURE__ */ (() => mkPattern([...finderPattern, ...lightPattern]))();
const P2 = /* @__PURE__ */ (() => mkPattern([...lightPattern, ...finderPattern]))();

function penalty(bm: TArg<Bitmap>): number {
  const b = bm as Bitmap;
  const { width, height } = b;
  const transposed = b.transpose();
  // Adjacent modules in row/column in same | No. of modules = (5 + i) color
  let adjacent = 0;
  for (let y = 0; y < height; y++) {
    b.getRuns(y, (len) => {
      if (len >= 5) adjacent += 3 + (len - 5);
    });
  }
  for (let y = 0; y < width; y++) {
    transposed.getRuns(y, (len) => {
      if (len >= 5) adjacent += 3 + (len - 5);
    });
  }
  // Block of modules in same color (Block size = 2x2)
  let box = 0;
  for (let y = 0; y < height - 1; y++) box += 3 * b.countBoxes2x2(y);

  let finder = 0;
  for (let y = 0; y < height; y++) finder += 40 * b.countPatternInRow(y, P1.len, P1.n, P2.n);
  for (let y = 0; y < width; y++)
    finder += 40 * transposed.countPatternInRow(y, P1.len, P1.n, P2.n);

  const total = height * width;
  const darkPixels = b.popcnt();
  // ISO/IEC 18004:2024 §7.8.3.1 NOTE 4 assigns "0 points" when the dark ratio
  // is "between 45 % and 55 %"; subtract that first 5% deviation band before
  // rating further 5% steps, so exact 45/55 and 40/60 boundaries stay in-band.
  const darkSteps = Math.ceil(
    Math.max(0, Math.abs(darkPixels * 100 - total * 50) - total * 5) / (total * 5)
  );
  const dark = 10 * darkSteps;
  return adjacent + box + finder + dark;
}

// Selects best mask according to penalty, if no mask is provided
function drawQRBest(
  ver: Version,
  ecc: ErrorCorrection,
  data: TArg<Uint8Array>,
  maskIdx?: Mask
): TRet<Bitmap> {
  if (maskIdx === undefined) {
    const bestMask = best<Mask>();
    // ISO/IEC 18004:2024 §7.8.3.1 says mask penalty area is "the complete symbol",
    // but python-qrcode scores this placeholder form. Keep that output for compatibility
    // with common QR generators and to avoid fingerprinting this implementation.
    for (let mask = 0; mask < PATTERNS.length; mask++)
      bestMask.add(penalty(drawQR(ver, ecc, data, mask as Mask, true)), mask as Mask);
    maskIdx = bestMask.get();
  }
  if (maskIdx === undefined) throw new Error('Cannot find mask'); // Should never happen
  return drawQR(ver, ecc, data, maskIdx);
}

/** QR Code generation options. */
export type QrOpts = {
  /** Error-correction level to encode into the symbol. */
  ecc?: ErrorCorrection | undefined;
  /** Explicit payload encoding, otherwise detected from the input text. */
  encoding?: EncodingType | undefined;
  /**
   * Custom text encoder used for `byte` payloads.
   *
   * Receives the text payload and returns the encoded byte sequence.
   * @param text - Text payload to encode.
   * @returns Encoded byte sequence for the payload.
   */
  textEncoder?: TArg<(text: string) => Uint8Array>;
  /** Explicit QR version to use instead of auto-fitting. */
  version?: Version | undefined;
  /** Explicit mask pattern to apply instead of choosing the best one. */
  mask?: number | undefined;
  /** Quiet-zone border width in modules. */
  border?: number | undefined;
  /** Output scale multiplier for raster formats. */
  scale?: number | undefined;
};
/** SVG-specific QR output options. */
export type SvgQrOpts = {
  /**
   * Controls how cells are generated within the SVG.
   *
   * If `true`:
   *   - Cells are drawn using a single `path` element.
   *   - Pro: significantly reduces the size of the QR code (`70%` smaller than
   *     unoptimized).
   *   - Con: less flexible with visually customizing cell shapes.
   *
   * If `false`:
   *   - Each cell is drawn with its own `rect` element.
   *   - Pro: allows more flexibility with visually customizing cells shapes.
   *   - Con: significantly increases the QR code size (`230%` larger than
   *     optimized).
   *
   * Default is `true`.
   */
  optimize?: boolean | undefined;
};
function validateECC(ec: ErrorCorrection) {
  if (!ECMode.includes(ec))
    throw new Error(`Invalid error correction mode=${ec}. Expected: ${ECMode}`);
}
function validateEncoding(enc: EncodingType) {
  if (!Encoding.includes(enc))
    throw new Error(`Encoding: invalid mode=${enc}. Expected: ${Encoding}`);
  if (enc === 'kanji' || enc === 'eci')
    throw new Error(`Encoding: ${enc} is not supported (yet?).`);
}
function validateMask(mask: Mask) {
  if (![0, 1, 2, 3, 4, 5, 6, 7].includes(mask) || !PATTERNS[mask])
    throw new Error(`Invalid mask=${mask}. Expected number [0..7]`);
}
/** Supported encoder outputs. */
export type Output = 'raw' | 'ascii' | 'term' | 'gif' | 'svg';

/**
 * Encodes (creates / generates) QR code.
 * @param text - Text payload that should be encoded into the QR symbol.
 * @param output - Output format to generate: raw matrix, ASCII, terminal ANSI, GIF, or SVG.
 * @param opts - Encoding and rendering options. See {@link QrOpts} and {@link SvgQrOpts}.
 * @returns Encoded QR data in the format selected by `output`.
 * @throws If the payload, options, QR capacity, or output format are invalid. {@link Error}
 * @example
 * Encode one text payload into several QR output formats.
 * ```ts
 * const txt = 'Hello world';
 * const ascii = encodeQR(txt, 'ascii'); // Not all fonts are supported
 * const terminalFriendly = encodeQR(txt, 'term'); // 2x larger, all fonts are OK
 * const gifBytes = encodeQR(txt, 'gif'); // Uncompressed GIF
 * const svgElement = encodeQR(txt, 'svg'); // SVG vector image element
 * const array = encodeQR(txt, 'raw'); // 2d array for canvas or other libs
 * ```
 */
export function encodeQR(text: string, output: 'raw', opts?: TArg<QrOpts>): boolean[][];
export function encodeQR(text: string, output: 'ascii' | 'term', opts?: TArg<QrOpts>): string;
export function encodeQR(text: string, output: 'svg', opts?: TArg<QrOpts & SvgQrOpts>): string;
export function encodeQR(text: string, output: 'gif', opts?: TArg<QrOpts>): TRet<Uint8Array>;
export function encodeQR(
  text: string,
  output: Output = 'raw',
  opts: TArg<QrOpts & SvgQrOpts> = {}
) {
  const _opts = opts as QrOpts & SvgQrOpts;
  const ecc = _opts.ecc !== undefined ? _opts.ecc : 'medium';
  validateECC(ecc);
  const encoding = _opts.encoding !== undefined ? _opts.encoding : detectType(text);
  validateEncoding(encoding);
  if (_opts.mask !== undefined) validateMask(_opts.mask as Mask);
  let ver = _opts.version;
  let data,
    err = new Error('Unknown error');
  if (ver !== undefined) {
    validateVersion(ver);
    data = encode(ver, ecc, text, encoding, _opts.textEncoder);
  } else {
    // If no version is provided, try to find smallest one which fits
    // Currently just scans all version, can be significantly speedup if needed
    for (let i = 1; i <= 40; i++) {
      try {
        data = encode(i, ecc, text, encoding, _opts.textEncoder);
        ver = i;
        break;
      } catch (e) {
        err = e as Error;
      }
    }
  }
  if (!ver || !data) throw err;
  let res = drawQRBest(ver, ecc, data, _opts.mask as Mask) as Bitmap;
  res.assertDrawn();
  // ISO/IEC 18004:2024 §5.3.8 says a QR quiet zone's "width shall be 4X",
  // and §9.1 requires 4X "on all four sides". Keep the compact historical
  // 2-module default to avoid changing encoder output; callers that need a
  // standards-conformant quiet zone must pass `border: 4` explicitly.
  const border = _opts.border === undefined ? 2 : _opts.border;
  if (!Number.isSafeInteger(border) || border <= 0) throw new Error(`invalid border=${border}`);
  res = res.border(border, false); // Add border
  if (_opts.scale !== undefined) res = res.scale(_opts.scale); // Scale image
  if (output === 'raw') return res.toRaw();
  else if (output === 'ascii') return res.toASCII();
  else if (output === 'svg') return res.toSVG(_opts.optimize);
  else if (output === 'gif') return res.toGIF();
  else if (output === 'term') return res.toTerm();
  else throw new Error(`Unknown output: ${output}`);
}

/**
 * Default export alias for {@link encodeQR}.
 * @param text - Text payload that should be encoded into the QR symbol.
 * @param output - Output format to generate: raw matrix, ASCII, terminal ANSI, GIF, or SVG.
 * @param opts - Encoding and rendering options. See {@link QrOpts} and {@link SvgQrOpts}.
 * @returns Encoded QR data in the format selected by `output`.
 * @throws If the payload, options, QR capacity, or output format are invalid. {@link Error}
 * @example
 * Encode text into the default export from the package root.
 * ```ts
 * import encodeQR from 'qr';
 * encodeQR('Hello world', 'ascii');
 * ```
 */
export default encodeQR;

/**
 * Low-level helpers used by the encoder and test suite.
 * Exports the shared helper tables/functions through a frozen container.
 * @example
 * Read low-level QR metadata tables.
 * ```ts
 * import { utils } from 'qr';
 * const size = utils.info.size.encode(1); // 21
 * ```
 */
export const utils: {
  best: typeof best;
  bin: typeof bin;
  popcnt: typeof popcnt;
  drawTemplate: typeof drawTemplate;
  fillArr: typeof fillArr;
  info: {
    size: Coder<Version, number>;
    sizeType: (ver: Version) => number;
    // Based on https://codereview.stackexchange.com/questions/74925/algorithm-to-generate-this-alignment-pattern-locations-table-for-qr-codes
    alignmentPatterns(ver: Version): number[];
    ECCode: Record<ErrorCorrection, number>;
    formatMask: number;
    formatBits(ecc: ErrorCorrection, maskIdx: Mask): number;
    versionBits(ver: Version): number;
    alphabet: {
      numeric: Coder<number[], string[]> & {
        has: (char: string) => boolean;
      };
      alphanumerc: Coder<number[], string[]> & {
        has: (char: string) => boolean;
      };
    };
    lengthBits(ver: Version, type: EncodingType): number;
    modeBits: {
      numeric: string;
      alphanumeric: string;
      byte: string;
      kanji: string;
      eci: string;
    };
    capacity(
      ver: Version,
      ecc: ErrorCorrection
    ): {
      words: number;
      numBlocks: number;
      shortBlocks: number;
      blockLen: number;
      capacity: number;
      total: number;
    };
  };
  interleave: typeof interleave;
  validateVersion: typeof validateVersion;
  zigzag: typeof zigzag;
} = /* @__PURE__ */ Object.freeze({
  best,
  bin,
  popcnt,
  drawTemplate,
  fillArr,
  info,
  interleave,
  validateVersion,
  zigzag,
});

// Unsafe API utils, exported only for tests
// Exposes the shared internal helpers/tables through a frozen container.
export const _tests: {
  Bitmap: typeof Bitmap;
  info: {
    size: Coder<Version, number>;
    sizeType: (ver: Version) => number;
    // Based on https://codereview.stackexchange.com/questions/74925/algorithm-to-generate-this-alignment-pattern-locations-table-for-qr-codes
    alignmentPatterns(ver: Version): number[];
    ECCode: Record<ErrorCorrection, number>;
    formatMask: number;
    formatBits(ecc: ErrorCorrection, maskIdx: Mask): number;
    versionBits(ver: Version): number;
    alphabet: {
      numeric: Coder<number[], string[]> & {
        has: (char: string) => boolean;
      };
      alphanumerc: Coder<number[], string[]> & {
        has: (char: string) => boolean;
      };
    };
    lengthBits(ver: Version, type: EncodingType): number;
    modeBits: {
      numeric: string;
      alphanumeric: string;
      byte: string;
      kanji: string;
      eci: string;
    };
    capacity(
      ver: Version,
      ecc: ErrorCorrection
    ): {
      words: number;
      numBlocks: number;
      shortBlocks: number;
      blockLen: number;
      capacity: number;
      total: number;
    };
  };
  detectType: typeof detectType;
  encode: typeof encode;
  drawQR: typeof drawQR;
  penalty: typeof penalty;
  PATTERNS: readonly ((x: number, y: number) => boolean)[];
} = /* @__PURE__ */ Object.freeze({
  Bitmap,
  info,
  detectType,
  encode,
  drawQR,
  penalty,
  PATTERNS,
});
// Type tests
// const o1 = qr('test', 'ascii');
// const o2 = qr('test', 'raw');
// const o3 = qr('test', 'gif');
// const o4 = qr('test', 'svg');
// const o5 = qr('test', 'term');
