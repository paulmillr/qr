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

const R1_RUN_LENGTH_THRESHOLD = 5;
const R2_BLOCK_PENALTY = 3;
const R3_FINDER_PATTERN_LENGTH = 11;
const R3_FINDER_PENALTY = 40;
const R4_BALANCE_STEP_PERCENT = 5;
const R4_BALANCE_STEP_POINTS = 10;

// We do not use newline escape code directly in strings because it's not parser-friendly
const chCodes = { newline: 10, reset: 27 };

export interface Coder<F, T> {
  encode(from: F): T;
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
  return new Array(length).fill(val);
}

/**
 * Interleaves byte blocks.
 * @param blocks [[1, 2, 3], [4, 5, 6]]
 * @returns [1, 4, 2, 5, 3, 6]
 */
function interleaveBytes(blocks: Uint8Array[]): Uint8Array {
  let maxLen = 0;
  let totalLen = 0;
  for (const block of blocks) {
    maxLen = Math.max(maxLen, block.length);
    totalLen += block.length;
  }

  const result = new Uint8Array(totalLen);
  let idx = 0;
  for (let i = 0; i < maxLen; i++) {
    for (const block of blocks) {
      if (i < block.length) result[idx++] = block[i];
    }
  }

  return result;
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
  return {
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
  };
}

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
export type Point = { x: number; y: number };
export type Size = { height: number; width: number };
export type Image = Size & { data: Uint8Array | Uint8ClampedArray | number[] };
type DrawValue = boolean | undefined; // undefined=not written, true=foreground, false=background
// value or fn returning value based on coords
type DrawFn = DrawValue | ((c: Point, curr: DrawValue) => DrawValue);
type ReadFn = (c: Point, curr: DrawValue) => void;
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
    s = s.replace(/^\n+/g, '').replace(/\n+$/g, '');
    const lines = s.split(String.fromCharCode(chCodes.newline));
    const height = lines.length;
    const data = new Array(height);
    let width: number | undefined;
    for (const line of lines) {
      const row = line.split('').map((i) => {
        if (i === 'X') return true;
        if (i === ' ') return false;
        if (i === '?') return undefined;
        throw new Error(`Bitmap.fromString: unknown symbol=${i}`);
      });
      if (width && row.length !== width)
        throw new Error(`Bitmap.fromString different row sizes: width=${width} cur=${row.length}`);
      width = row.length;
      data.push(row);
    }
    if (!width) width = 0;
    return new Bitmap({ height, width }, data);
  }

  data: DrawValue[][];
  height: number;
  width: number;
  constructor(size: Size | number, data?: DrawValue[][]) {
    const { height, width } = Bitmap.size(size);
    this.data = data || Array.from({ length: height }, () => fillArr(width, undefined));
    this.height = height;
    this.width = width;
  }
  point(p: Point): DrawValue {
    return this.data[p.y][p.x];
  }
  isInside(p: Point): boolean {
    return 0 <= p.x && p.x < this.width && 0 <= p.y && p.y < this.height;
  }
  size(offset?: Point | number): {
    height: number;
    width: number;
  } {
    if (!offset) return { height: this.height, width: this.width };
    const { x, y } = this.xy(offset);
    return { height: this.height - y, width: this.width - x };
  }
  private xy(c: Point | number) {
    if (typeof c === 'number') c = { x: c, y: c };
    if (!Number.isSafeInteger(c.x)) throw new Error(`Bitmap: invalid x=${c.x}`);
    if (!Number.isSafeInteger(c.y)) throw new Error(`Bitmap: invalid y=${c.y}`);
    // Do modulo, so we can use negative positions
    c.x = mod(c.x, this.width);
    c.y = mod(c.y, this.height);
    return c;
  }
  // Basically every operation can be represented as rect
  rect(c: Point | number, size: Size | number, value: DrawFn): this {
    const { x, y } = this.xy(c);
    const { height, width } = Bitmap.size(size, this.size({ x, y }));
    for (let yPos = 0; yPos < height; yPos++) {
      for (let xPos = 0; xPos < width; xPos++) {
        // NOTE: we use give function relative coordinates inside box
        this.data[y + yPos][x + xPos] =
          typeof value === 'function'
            ? value({ x: xPos, y: yPos }, this.data[y + yPos][x + xPos])
            : value;
      }
    }
    return this;
  }
  // returns rectangular part of bitmap
  rectRead(c: Point | number, size: Size | number, fn: ReadFn): this {
    return this.rect(c, size, (c, cur) => {
      fn(c, cur);
      return cur;
    });
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
    const height = this.height + 2 * border;
    const width = this.width + 2 * border;
    const v = fillArr(border, value);
    const h: DrawValue[][] = Array.from({ length: border }, () => fillArr(width, value));
    return new Bitmap({ height, width }, [...h, ...this.data.map((i) => [...v, ...i, ...v]), ...h]);
  }
  // Embed another bitmap on coordinates
  embed(c: Point | number, bm: Bitmap): this {
    return this.rect(c, bm.size(), ({ x, y }) => bm.data[y][x]);
  }
  // returns rectangular part of bitmap
  rectSlice(c: Point | number, size: Size | number = this.size()): Bitmap {
    const rect = new Bitmap(Bitmap.size(size, this.size(this.xy(c))));
    this.rect(c, size, ({ x, y }, cur) => (rect.data[y][x] = cur));
    return rect;
  }
  // Change shape, replace rows with columns (data[y][x] -> data[x][y])
  inverse(): Bitmap {
    const { height, width } = this;
    const res = new Bitmap({ height: width, width: height });
    return res.rect({ x: 0, y: 0 }, Infinity, ({ x, y }) => this.data[x][y]);
  }
  // Each pixel size is multiplied by factor
  scale(factor: number): Bitmap {
    if (!Number.isSafeInteger(factor) || factor > 1024)
      throw new Error(`invalid scale factor: ${factor}`);
    const { height, width } = this;
    const res = new Bitmap({ height: factor * height, width: factor * width });
    return res.rect(
      { x: 0, y: 0 },
      Infinity,
      ({ x, y }) => this.data[Math.floor(y / factor)][Math.floor(x / factor)]
    );
  }
  clone(): Bitmap {
    const res = new Bitmap(this.size());
    return res.rect({ x: 0, y: 0 }, this.size(), ({ x, y }) => this.data[y][x]);
  }
  // Ensure that there is no undefined values left
  assertDrawn(): void {
    this.rectRead(0, Infinity, (_, cur) => {
      if (typeof cur !== 'boolean') throw new Error(`Invalid color type=${typeof cur}`);
    });
  }
  // Simple string representation for debugging
  toString(): string {
    return this.data
      .map((i) => i.map((j) => (j === undefined ? '?' : j ? 'X' : ' ')).join(''))
      .join(String.fromCharCode(chCodes.newline));
  }
  toASCII(): string {
    const { height, width, data } = this;
    let out = '';
    // Terminal character height is x2 of character width, so we process two rows of bitmap
    // to produce one row of ASCII
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x++) {
        const first = data[y][x];
        const second = y + 1 >= height ? true : data[y + 1][x]; // if last row outside bitmap, make it black
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
    return this.data
      .map((i) => i.map((j) => (j ? darkBG : whiteBG)).join(''))
      .join(String.fromCharCode(chCodes.newline));
  }
  toSVG(optimize = true): string {
    let out = `<svg viewBox="0 0 ${this.width} ${this.height}" xmlns="http://www.w3.org/2000/svg">`;
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
    this.rectRead(0, Infinity, (_, cur) => data.push(+(cur === true)));
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
        const value = !!this.data[y][x] ? 0 : 255;
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
/** Error correction mode. low: 7%, medium: 15%, quartile: 25%, high: 30% */
export const ECMode = ['low', 'medium', 'quartile', 'high'] as const;
/** Error correction mode. */
export type ErrorCorrection = (typeof ECMode)[number];
/** QR Code version. */
export type Version = number; // 1..40
/** QR Code mask type */
export type Mask = (0 | 1 | 2 | 3 | 4 | 5 | 6 | 7) & keyof typeof PATTERNS; // 0..7
/** QR Code encoding */
export const Encoding = ['numeric', 'alphanumeric', 'byte', 'kanji', 'eci'] as const;
/** QR Code encoding type */
export type EncodingType = (typeof Encoding)[number];

// Various constants & tables
// prettier-ignore
const BYTES = [
// 1,  2,  3,   4,   5,   6,   7,   8,   9,  10,  11,  12,  13,  14,  15,  16,  17,  18,  19,   20,
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
//  21,   22,   23,   24,   25,   26,   27,   28,   29,   30,   31,   32,   33,   34,   35,   36,   37,   38,   39,   40
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];
// prettier-ignore
const WORDS_PER_BLOCK = {
  // Version 1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
  low:      [7,  10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  medium:   [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  quartile: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  high:    [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
// prettier-ignore
const ECC_BLOCKS = {
	// Version   1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
	low:      [  1, 1, 1, 1, 1, 2, 2, 2, 2, 4,  4,  4,  4,  4,  6,  6,  6,  6,  7,  8,  8,  9,  9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	medium:   [  1, 1, 1, 2, 2, 4, 4, 4, 5, 5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
	quartile: [  1, 1, 2, 2, 4, 4, 6, 6, 8, 8,  8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
	high:    [  1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const info = {
  size: {
    encode: (ver: Version) => 21 + 4 * (ver - 1), // ver1 = 21, ver40=177 blocks
    decode: (size: number) => (size - 17) / 4,
  } as Coder<Version, number>,
  sizeType: (ver: Version) => Math.floor((ver + 7) / 17),
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
  ECCode: {
    low: 0b01,
    medium: 0b00,
    quartile: 0b11,
    high: 0b10,
  } as Record<ErrorCorrection, number>,
  formatMask: 0b101010000010010,
  formatBits(ecc: ErrorCorrection, maskIdx: Mask) {
    const data = (info.ECCode[ecc] << 3) | maskIdx;
    let d = data;
    for (let i = 0; i < 10; i++) d = (d << 1) ^ ((d >> 9) * 0b10100110111);
    return ((data << 10) | d) ^ info.formatMask;
  },
  versionBits(ver: Version) {
    let d = ver;
    for (let i = 0; i < 12; i++) d = (d << 1) ^ ((d >> 11) * 0b1111100100101);
    return (ver << 12) | d;
  },
  alphabet: {
    numeric: alphabet('0123456789'),
    alphanumerc: alphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'),
  }, // as Record<EncodingType, ReturnType<typeof alphabet>>,
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
  modeBits: {
    numeric: '0001',
    alphanumeric: '0010',
    byte: '0100',
    kanji: '1000',
    eci: '0111',
  },
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
};

const PATTERNS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 == 0,
  (_x, y) => y % 2 == 0,
  (x, _y) => x % 3 == 0,
  (x, y) => (x + y) % 3 == 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 == 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) == 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 == 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 == 0,
] as const;

// Galois field && reed-solomon encoding
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
    return { exp, log };
  })(0x11d),
  exp: (x: number) => GF.tables.exp[x],
  log(x: number) {
    if (x === 0) throw new Error(`GF.log: invalid arg=${x}`);
    return GF.tables.log[x] % 255;
  },
  mul(x: number, y: number) {
    if (x === 0 || y === 0) return 0;
    return GF.tables.exp[(GF.tables.log[x] + GF.tables.log[y]) % 255];
  },
  add: (x: number, y: number) => x ^ y,
  pow: (x: number, e: number) => GF.tables.exp[(GF.tables.log[x] * e) % 255],
  inv(x: number) {
    if (x === 0) throw new Error(`GF.inverse: invalid arg=${x}`);
    return GF.tables.exp[255 - GF.tables.log[x]];
  },
  polynomial(poly: number[]) {
    if (poly.length == 0) throw new Error('GF.polymomial: invalid length');
    if (poly[0] !== 0) return poly;
    // Strip leading zeros
    let i = 0;
    for (; i < poly.length - 1 && poly[i] == 0; i++);
    return poly.slice(i);
  },
  monomial(degree: number, coefficient: number) {
    if (degree < 0) throw new Error(`GF.monomial: invalid degree=${degree}`);
    if (coefficient == 0) return [0];
    let coefficients = fillArr(degree + 1, 0);
    coefficients[0] = coefficient;
    return GF.polynomial(coefficients);
  },
  degree: (a: number[]) => a.length - 1,
  coefficient: (a: any, degree: number) => a[GF.degree(a) - degree],
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
  mulPolyScalar(a: number[], scalar: number) {
    if (scalar == 0) return [0];
    if (scalar == 1) return a;
    const res = fillArr(a.length, 0);
    for (let i = 0; i < a.length; i++) res[i] = GF.mul(a[i], scalar);
    return GF.polynomial(res);
  },
  mulPolyMonomial(a: number[], degree: number, coefficient: number) {
    if (degree < 0) throw new Error('GF.mulPolyMonomial: invalid degree');
    if (coefficient == 0) return [0];
    const res = fillArr(a.length + degree, 0);
    for (let i = 0; i < a.length; i++) res[i] = GF.mul(a[i], coefficient);
    return GF.polynomial(res);
  },
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
  divisorPoly(degree: number) {
    let g = [1];
    for (let i = 0; i < degree; i++) g = GF.mulPoly(g, [1, GF.pow(2, i)]);
    return g;
  },
  evalPoly(poly: any, a: number) {
    if (a == 0) return GF.coefficient(poly, 0); // Just return the x^0 coefficient
    let res = poly[0];
    for (let i = 1; i < poly.length; i++) res = GF.add(GF.mul(a, res), poly[i]);
    return res;
  },
  // TODO: cleanup
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

function RS(eccWords: number): Coder<Uint8Array, Uint8Array> {
  return {
    encode(from: Uint8Array) {
      const d = GF.divisorPoly(eccWords);
      const pol = Array.from(from);
      pol.push(...d.slice(0, -1).fill(0));
      return Uint8Array.from(GF.remainderPoly(pol, d));
    },
    decode(to: Uint8Array) {
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
      return res;
    },
  };
}

// Interleaves blocks
function interleave(ver: Version, ecc: ErrorCorrection): Coder<Uint8Array, Uint8Array> {
  const { words, shortBlocks, numBlocks, blockLen, total } = info.capacity(ver, ecc);
  const rs = RS(words);
  return {
    encode(bytes: Uint8Array) {
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
      return res;
    },
    decode(data: Uint8Array) {
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
      return Uint8Array.from(res);
    },
  };
}

// Draw
// Generic template per version+ecc+mask. Can be cached, to speedup calculations.
function drawTemplate(
  ver: Version,
  ecc: ErrorCorrection,
  maskIdx: Mask,
  test: boolean = false
): Bitmap {
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
      if (b.data[y][x] !== undefined) continue;
      b.embed({ x: x - 2, y: y - 2 }, align); // center of pattern should be at position
    }
  }
  // Timing patterns
  b = b
    .hLine({ x: 0, y: 6 }, Infinity, ({ x }, cur) => (cur === undefined ? x % 2 == 0 : cur))
    .vLine({ x: 6, y: 0 }, Infinity, ({ y }, cur) => (cur === undefined ? y % 2 == 0 : cur));
  // Format information
  {
    const bits = info.formatBits(ecc, maskIdx);
    const getBit = (i: number) => !test && ((bits >> i) & 1) == 1;
    // vertical
    for (let i = 0; i < 6; i++) b.data[i][8] = getBit(i); // right of top-left finder
    // TODO: re-write as lines, like:
    // b.vLine({ x: 8, y: 0 }, 6, ({ x, y }) => getBit(y));
    for (let i = 6; i < 8; i++) b.data[i + 1][8] = getBit(i); // after timing pattern
    for (let i = 8; i < 15; i++) b.data[size - 15 + i][8] = getBit(i); // right of bottom-left finder
    // horizontal
    for (let i = 0; i < 8; i++) b.data[8][size - i - 1] = getBit(i); // under top-right finder
    for (let i = 8; i < 9; i++) b.data[8][15 - i - 1 + 1] = getBit(i); // VVV, after timing
    for (let i = 9; i < 15; i++) b.data[8][15 - i - 1] = getBit(i); // under top-left finder
    b.data[size - 8][8] = !test; // bottom-left finder, right
  }
  // Version information
  if (ver >= 7) {
    const bits = info.versionBits(ver);
    for (let i = 0; i < 18; i += 1) {
      const bit = !test && ((bits >> i) & 1) == 1;
      const x = Math.floor(i / 3);
      const y = (i % 3) + size - 8 - 3;
      // two copies
      b.data[x][y] = bit;
      b.data[y][x] = bit;
    }
  }
  return b;
}
// zigzag: bottom->top && top->bottom
function zigzag(
  tpl: Bitmap,
  maskIdx: Mask,
  fn: (x: number, y: number, mask: boolean) => void
): void {
  const size = tpl.height;
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
        if (tpl.data[y][x] !== undefined) continue; // skip already written elements
        fn(x, y, pattern(x, y));
      }
      if (y + dir < 0 || y + dir >= size) break;
    }
    dir = -dir; // change direction
  }
}

// NOTE: byte encoding is just representation, QR works with strings only. Most decoders will fail on raw byte array,
// since they expect unicode or other text encoding inside bytes
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
 * @example utf8ToBytes('abc') // new Uint8Array([97, 98, 99])
 */
export function utf8ToBytes(str: string): Uint8Array {
  if (typeof str !== 'string') throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
  return new Uint8Array(new TextEncoder().encode(str)); // https://bugzil.la/1681809
}

function encode(
  ver: Version,
  ecc: ErrorCorrection,
  data: string,
  type: EncodingType,
  encoder: (value: string) => Uint8Array = utf8ToBytes
): Uint8Array {
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
  return interleave(ver, ecc).encode(bytes);
}

// DRAW

function drawQR(
  ver: Version,
  ecc: ErrorCorrection,
  data: Uint8Array,
  maskIdx: Mask,
  test: boolean = false
): Bitmap {
  const b = drawTemplate(ver, ecc, maskIdx, test);
  let i = 0;
  const need = 8 * data.length;
  zigzag(b, maskIdx, (x, y, mask) => {
    let value = false;
    if (i < need) {
      value = ((data[i >>> 3] >> ((7 - i) & 7)) & 1) !== 0;
      i++;
    }
    b.data[y][x] = value !== mask; // !== as xor
  });
  if (i !== need) throw new Error('QR: bytes left after draw');
  return b;
}

function calculateRowRunPenalty(rowBits: readonly boolean[]): number {
  const moduleCount = rowBits.length;
  if (moduleCount <= 1) return 0;

  let penalty = 0;
  let runLength = 1;
  let previousColor = rowBits[0];

  for (let i = 1; i < moduleCount; i++) {
    const currentColor = rowBits[i];
    if (currentColor === previousColor) {
      runLength++;
    } else {
      if (runLength >= R1_RUN_LENGTH_THRESHOLD) penalty += runLength - 2;
      runLength = 1;
      previousColor = currentColor;
    }
  }

  if (runLength >= R1_RUN_LENGTH_THRESHOLD) penalty += runLength - 2;

  return penalty;
}

function calculateColumnRunPenalty(
  bitmap: readonly boolean[][],
  columnIndex: number,
  columnHeight: number
): number {
  if (columnHeight <= 1) return 0;

  let penalty = 0;
  let runLength = 1;
  let previousColor = bitmap[0][columnIndex];

  for (let y = 1; y < columnHeight; y++) {
    const currentColor = bitmap[y][columnIndex];
    if (currentColor === previousColor) {
      runLength++;
    } else {
      if (runLength >= R1_RUN_LENGTH_THRESHOLD) penalty += runLength - 2;
      runLength = 1;
      previousColor = currentColor;
    }
  }

  if (runLength >= R1_RUN_LENGTH_THRESHOLD) penalty += runLength - 2;

  return penalty;
}

function calculateRowFinderPenalty(rowBits: readonly boolean[]): number {
  const rowLength = rowBits.length;
  if (rowLength < R3_FINDER_PATTERN_LENGTH) return 0;

  let penalty = 0;
  const lastStart = rowLength - R3_FINDER_PATTERN_LENGTH;

  for (let i = 0; i <= lastStart; i++) {
    // Case A: L L L L + 1 0 1 1 1 0 1
    const light4ThenFinder7 =
      !rowBits[i] &&
      !rowBits[i + 1] &&
      !rowBits[i + 2] &&
      !rowBits[i + 3] &&
      rowBits[i + 4] &&
      !rowBits[i + 5] &&
      rowBits[i + 6] &&
      rowBits[i + 7] &&
      rowBits[i + 8] &&
      !rowBits[i + 9] &&
      rowBits[i + 10];

    // Case B: 1 0 1 1 1 0 1 + L L L L
    const finder7ThenLight4 =
      rowBits[i] &&
      !rowBits[i + 1] &&
      rowBits[i + 2] &&
      rowBits[i + 3] &&
      rowBits[i + 4] &&
      !rowBits[i + 5] &&
      rowBits[i + 6] &&
      !rowBits[i + 7] &&
      !rowBits[i + 8] &&
      !rowBits[i + 9] &&
      !rowBits[i + 10];

    if (light4ThenFinder7 || finder7ThenLight4) penalty += R3_FINDER_PENALTY;
  }
  return penalty;
}

function calculateColumnFinderPenalty(
  matrix: readonly boolean[][],
  rowIndex: number,
  width: number
): number {
  if (width < R3_FINDER_PATTERN_LENGTH) return 0;

  let penalty = 0;
  const y = rowIndex;
  const lastStart = width - R3_FINDER_PATTERN_LENGTH;

  for (let x = 0; x <= lastStart; x++) {
    // Case A: L L L L + 1 0 1 1 1 0 1
    const light4ThenFinder7 =
      !matrix[x][y] &&
      !matrix[x + 1][y] &&
      !matrix[x + 2][y] &&
      !matrix[x + 3][y] &&
      matrix[x + 4][y] &&
      !matrix[x + 5][y] &&
      matrix[x + 6][y] &&
      matrix[x + 7][y] &&
      matrix[x + 8][y] &&
      !matrix[x + 9][y] &&
      matrix[x + 10][y];

    // Case B: 1 0 1 1 1 0 1 + L L L L
    const finder7ThenLight4 =
      matrix[x][y] &&
      !matrix[x + 1][y] &&
      matrix[x + 2][y] &&
      matrix[x + 3][y] &&
      matrix[x + 4][y] &&
      !matrix[x + 5][y] &&
      matrix[x + 6][y] &&
      !matrix[x + 7][y] &&
      !matrix[x + 8][y] &&
      !matrix[x + 9][y] &&
      !matrix[x + 10][y];

    if (light4ThenFinder7 || finder7ThenLight4) penalty += R3_FINDER_PENALTY;
  }
  return penalty;
}

function penalty(bitmap: Bitmap): number {
  const matrix = bitmap.data as boolean[][];
  const width = bitmap.width | 0;
  const height = bitmap.height | 0;

  if (width === 0 || height === 0) return 0;

  // Rule 1: same-color runs
  let runPenalty = 0;
  for (let x = 0; x < width; x++) runPenalty += calculateRowRunPenalty(matrix[x]);
  for (let y = 0; y < height; y++) runPenalty += calculateColumnRunPenalty(matrix, y, width);

  // Rule 2: 2×2 blocks of the same color
  let blockPenalty = 0;
  const lastCol = width - 1;
  const lastRow = height - 1;
  for (let x = 0; x < lastCol; x++) {
    const col = matrix[x];
    const nextCol = matrix[x + 1];
    for (let y = 0; y < lastRow; y++) {
      const cell = col[y];
      if (cell === nextCol[y] && cell === col[y + 1] && cell === nextCol[y + 1]) {
        blockPenalty += R2_BLOCK_PENALTY;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 with 4-light padding
  let finderPenalty = 0;
  for (let x = 0; x < width; x++) finderPenalty += calculateRowFinderPenalty(matrix[x]);
  for (let y = 0; y < height; y++) finderPenalty += calculateColumnFinderPenalty(matrix, y, width);

  // Rule 4: dark-module balance vs 50%
  let darkCount = 0;
  for (let x = 0; x < width; x++) {
    const col = matrix[x];
    for (let y = 0; y < height; y++) if (col[y]) darkCount++;
  }
  const moduleCount = width * height;
  const darkPercent = (darkCount * 100) / moduleCount;
  const deviation = Math.abs(darkPercent - 50);
  const balancePenalty = R4_BALANCE_STEP_POINTS * Math.floor(deviation / R4_BALANCE_STEP_PERCENT);

  return runPenalty + blockPenalty + finderPenalty + balancePenalty;
}

// Selects best mask according to penalty, if no mask is provided
function drawQRBest(ver: Version, ecc: ErrorCorrection, data: Uint8Array, maskIdx?: Mask) {
  if (maskIdx === undefined) {
    const bestMask = best<Mask>();
    for (let mask = 0; mask < PATTERNS.length; mask++)
      bestMask.add(penalty(drawQR(ver, ecc, data, mask as Mask, true)), mask as Mask);
    maskIdx = bestMask.get();
  }
  if (maskIdx === undefined) throw new Error('Cannot find mask'); // Should never happen
  return drawQR(ver, ecc, data, maskIdx);
}

/** QR Code generation options. */
export type QrOpts = {
  ecc?: ErrorCorrection | undefined;
  encoding?: EncodingType | undefined;
  textEncoder?: (text: string) => Uint8Array;
  version?: Version | undefined;
  mask?: number | undefined;
  border?: number | undefined;
  scale?: number | undefined;
};
export type SvgQrOpts = {
  /**
   * Controls how cells are generated within the SVG.
   *
   * If `true`:
   *   - Cells are drawn using a single `path` element.
   *   - Pro: significantly reduces the size of the QR code (>70% smaller than
   *     unoptimized).
   *   - Con: less flexible with visually customizing cell shapes.
   *
   * If `false`:
   *   - Each cell is drawn with its own `rect` element.
   *   - Pro: allows more flexibility with visually customizing cells shapes.
   *   - Con: significantly increases the QR code size (>230% larger than
   *     optimized).
   *
   * @default true
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
export type Output = 'raw' | 'ascii' | 'term' | 'gif' | 'svg';

/**
 * Encodes (creates / generates) QR code.
 * @param text text that would be encoded
 * @param output output type: raw, ascii, svg, gif, or term
 * @param opts
 * @example
```js
const txt = 'Hello world';
const ascii = encodeQR(txt, 'ascii'); // Not all fonts are supported
const terminalFriendly = encodeQR(txt, 'term'); // 2x larger, all fonts are OK
const gifBytes = encodeQR(txt, 'gif'); // Uncompressed GIF
const svgElement = encodeQR(txt, 'svg'); // SVG vector image element
const array = encodeQR(txt, 'raw'); // 2d array for canvas or other libs
```
 */
export function encodeQR(text: string, output: 'raw', opts?: QrOpts): boolean[][];
export function encodeQR(text: string, output: 'ascii' | 'term', opts?: QrOpts): string;
export function encodeQR(text: string, output: 'svg', opts?: QrOpts & SvgQrOpts): string;
export function encodeQR(text: string, output: 'gif', opts?: QrOpts): Uint8Array;
export function encodeQR(text: string, output: Output = 'raw', opts: QrOpts & SvgQrOpts = {}) {
  const ecc = opts.ecc !== undefined ? opts.ecc : 'medium';
  validateECC(ecc);
  const encoding = opts.encoding !== undefined ? opts.encoding : detectType(text);
  validateEncoding(encoding);
  if (opts.mask !== undefined) validateMask(opts.mask as Mask);
  let ver = opts.version;
  let data,
    err = new Error('Unknown error');
  if (ver !== undefined) {
    validateVersion(ver);
    data = encode(ver, ecc, text, encoding, opts.textEncoder);
  } else {
    // If no version is provided, try to find smallest one which fits
    // Currently just scans all version, can be significantly speedup if needed
    for (let i = 1; i <= 40; i++) {
      try {
        data = encode(i, ecc, text, encoding, opts.textEncoder);
        ver = i;
        break;
      } catch (e) {
        err = e as Error;
      }
    }
  }
  if (!ver || !data) throw err;
  let res = drawQRBest(ver, ecc, data, opts.mask as Mask);
  res.assertDrawn();
  const border = opts.border === undefined ? 2 : opts.border;
  if (!Number.isSafeInteger(border)) throw new Error(`invalid border type=${typeof border}`);
  res = res.border(border, false); // Add border
  if (opts.scale !== undefined) res = res.scale(opts.scale); // Scale image
  if (output === 'raw') return res.data;
  else if (output === 'ascii') return res.toASCII();
  else if (output === 'svg') return res.toSVG(opts.optimize);
  else if (output === 'gif') return res.toGIF();
  else if (output === 'term') return res.toTerm();
  else throw new Error(`Unknown output: ${output}`);
}

export default encodeQR;

export const utils: {
  best: typeof best;
  bin: typeof bin;
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
} = {
  best,
  bin,
  drawTemplate,
  fillArr,
  info,
  interleave,
  validateVersion,
  zigzag,
};

// Unsafe API utils, exported only for tests
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
} = {
  Bitmap,
  info,
  detectType,
  encode,
  drawQR,
  penalty,
  PATTERNS,
};
// Type tests
// const o1 = qr('test', 'ascii');
// const o2 = qr('test', 'raw');
// const o3 = qr('test', 'gif');
// const o4 = qr('test', 'svg');
// const o5 = qr('test', 'term');
