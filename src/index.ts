/*!
 * Copyright (c) 2023 Paul Miller (paulmillr.com)
 * SPDX-License-Identifier: MIT OR Apache-2.0
 */
/**
 * QR code generator (encoder). Self-contained (no imports); the decoder and
 * its shared machinery (Bitmap, tables, GF/RS) live in `decode.ts`.
 *
 * What was deliberately dropped vs the full encoder: the tri-state Bitmap
 * drawing DSL, the shared decoder utilities, and verbose validation messages.
 * What was deliberately kept: word-parallel mask penalty scoring over packed
 * bit rows — it is the one optimization whose absence would make
 * large-payload encodes ~5-10x slower while costing only a few hundred
 * bytes — plus a single-slot per-version cache of the symbol template,
 * zigzag order and mask planes (see SymCache).
 * @module
 */

/** Error correction mode. low: 7%, medium: 15%, quartile: 25%, high: 30%. */
export type ErrorCorrection = 'low' | 'medium' | 'quartile' | 'high';
/** QR payload encoding name. */
export type EncodingType = 'numeric' | 'alphanumeric' | 'byte';
/** Supported encoder outputs. */
export type Output = 'raw' | 'ascii' | 'term' | 'gif' | 'svg' | 'data-url';
const MAX_OUTPUT_SIZE = 1024;
const MAX_COMPACT_OUTPUT_SIZE = MAX_OUTPUT_SIZE * 4;
/** QR version: 1..40, determines symbol size. */
export type Version = number;
/** QR mask pattern index. */
export type Mask = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** Width and height pair. */
export type Size = {
  /** Pixel height. */
  height: number;
  /** Pixel width. */
  width: number;
};
/** SVG-specific QR output options. */
export type SvgQrOpts = { optimize?: boolean | undefined };
/** QR Code generation options. */
export type QrOpts = {
  ecc?: ErrorCorrection | undefined;
  encoding?: EncodingType | undefined;
  textEncoder?: (text: string) => Uint8Array;
  version?: number | undefined;
  mask?: number | undefined;
  border?: number | undefined;
  scale?: number | undefined;
  optimize?: boolean | undefined;
};

/**
 * ISO/IEC 18004:2024 Table 1: total codewords by version (shared with the
 * decoder). Computed as data modules / 8: symbol area minus function
 * patterns (finders+separators+format 191+timing, alignment grid overlaps
 * removed) minus version info for ver >= 7.
 */
const BYTES: number[] = /* @__PURE__ */ (() => {
  const res: number[] = [];
  for (let ver = 1; ver <= 40; ver++) {
    let bits = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const align = Math.floor(ver / 7) + 2;
      bits -= (25 * align - 10) * align - 55;
      if (ver >= 7) bits -= 36;
    }
    res.push(bits >>> 3);
  }
  return res;
})();
/** All error-correction levels, in spec table order (also the packed-table segment order). */
const ECC_LEVELS: ErrorCorrection[] = ['low', 'medium', 'quartile', 'high'];
/** ISO/IEC 18004:2024 Table 9: ECC codewords per block, by level (shared with the decoder). */
// prettier-ignore
const WORDS_PER_BLOCK: Record<ErrorCorrection, number[]> = {
  low: [
    7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  medium: [
    10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  quartile: [
    13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
    28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  high: [
    17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
    30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
};
/** ISO/IEC 18004:2024 Table 9: error-correction block count by version and level. */
// prettier-ignore
const ECC_BLOCKS: Record<ErrorCorrection, number[]> = {
  low:      [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  medium:   [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  quartile: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  high:     [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** ISO/IEC 18004:2024 §7.9.1 Table 12: error-correction-level format indicators. */
const EC_CODE: Record<ErrorCorrection, number> = { low: 1, medium: 0, quartile: 3, high: 2 };

/** ISO/IEC 18004:2024 Table 5: alphanumeric characters in value order. */
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/**
 * Alignment pattern center coordinates for a version (ISO/IEC 18004:2024
 * Annex E). Exported for custom-design renderers (qrbtf-style module
 * classification): every alignment pattern is centered on (cx, cy) for each
 * pair from this list, except where it would overlap a finder pattern.
 * Coordinates are borderless-symbol module indices.
 */
function alignmentPatterns(ver: number): number[] {
  ver = asVersion(ver);
  if (ver === 1) return [];
  const last = 21 + 4 * (ver - 1) - 7;
  const count = Math.ceil((last - 6) / 28);
  let interval = Math.floor((last - 6) / count);
  if (interval % 2) interval += 1;
  else if (((last - 6) % count) * 2 >= count) interval += 2;
  const res = [6];
  for (let m = 1; m < count; m++) res.push(last - (count - m) * interval);
  res.push(last);
  return res;
}

/** BCH-protected masked format word from ISO/IEC 18004:2024 §7.9.1 and Annex C.2. */
function formatBits(ecc: ErrorCorrection, mask: number): number {
  const data = (EC_CODE[ecc] << 3) | mask;
  let d = data;
  for (let i = 0; i < 10; i++) d = (d << 1) ^ ((d >> 9) * 0b10100110111);
  return ((data << 10) | d) ^ 0b101010000010010;
}
/** Golay-protected 18-bit version word (ISO/IEC 18004:2024 §7.10 / Annex D.2). */
function versionBits(ver: number): number {
  let d = ver;
  for (let i = 0; i < 12; i++) d = (d << 1) ^ ((d >> 11) * 0b1111100100101);
  return (ver << 12) | d;
}

const MODE_BITS: Record<EncodingType, number> = { numeric: 1, alphanumeric: 2, byte: 4 };
const LENGTH_BITS: Record<EncodingType, number[]> = {
  numeric: [10, 12, 14],
  alphanumeric: [9, 11, 13],
  byte: [8, 16, 16],
};

/**
 * GF(2^8) exp/log tables with the QR primitive polynomial 0x11d. EXP is
 * doubled so products of two logs index it without a mod. Shared with the
 * decoder (it corrects with the same field the encoder generates parity in);
 * the PURE-annotated initializer lets bundlers drop it for consumers that
 * only import the spec tables above.
 */
const GF256: { exp: Uint8Array; log: Uint8Array } = /* @__PURE__ */ (() => {
  const exp = new Uint8Array(510);
  const log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    exp[i] = exp[i + 255] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  return { exp, log };
})();

// Reed-Solomon generator polynomial (leading 1 dropped); one per symbol.
function rsGenerator(eccWords: number): Uint8Array {
  const { exp: EXP, log: LOG } = GF256;
  const gen = new Uint8Array(eccWords); // coefficients after the leading x^n
  gen[eccWords - 1] = 1;
  for (let i = 0, root = 1; i < eccWords; i++) {
    for (let j = 0; j < eccWords; j++) {
      const c = gen[j];
      gen[j] = (c ? EXP[LOG[c] + LOG[root]] : 0) ^ (j + 1 < eccWords ? gen[j + 1] : 0);
    }
    root = EXP[LOG[root] + 1]; // next power of alpha
  }
  return gen;
}

type RsCache = { gen: Uint8Array; mul: Uint8Array };
const RS_CACHE: (RsCache | undefined)[] = [];

// Generator and all coefficient*feedback products, shared by every symbol
// with the same parity length; entries are generated lazily.
function rsCached(eccWords: number): RsCache {
  let cached = RS_CACHE[eccWords];
  if (cached !== undefined) return cached;
  const gen = rsGenerator(eccWords);
  const { exp: EXP, log: LOG } = GF256;
  const mul = new Uint8Array(256 * eccWords);
  for (let f = 1; f < 256; f++) {
    const lf = LOG[f];
    const off = f * eccWords;
    for (let j = 0; j < eccWords; j++) {
      const c = gen[j];
      if (c) mul[off + j] = EXP[LOG[c] + lf];
    }
  }
  return (RS_CACHE[eccWords] = { gen, mul });
}

// Reed-Solomon parity via LFSR remainder.
function rsEcc(data: Uint8Array, gen: Uint8Array, mul?: Uint8Array): Uint8Array {
  const { exp: EXP, log: LOG } = GF256;
  const eccWords = gen.length;
  const res = new Uint8Array(eccWords);
  if (mul !== undefined) {
    const last = eccWords - 1;
    for (let i = 0; i < data.length; i++) {
      const off = (data[i] ^ res[0]) * eccWords;
      for (let j = 0; j < last; j++) res[j] = res[j + 1] ^ mul[off + j];
      res[last] = mul[off + last];
    }
    return res;
  }
  for (let i = 0; i < data.length; i++) {
    const f = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[eccWords - 1] = 0;
    if (f) {
      for (let j = 0; j < eccWords; j++) if (gen[j]) res[j] ^= EXP[LOG[gen[j]] + LOG[f]];
    }
  }
  return res;
}

function capacity(ver: number, ecc: ErrorCorrection) {
  const bytes = BYTES[ver - 1];
  const words = WORDS_PER_BLOCK[ecc][ver - 1];
  const numBlocks = ECC_BLOCKS[ecc][ver - 1];
  const blockLen = Math.floor(bytes / numBlocks) - words;
  const shortBlocks = numBlocks - (bytes % numBlocks);
  return { words, numBlocks, shortBlocks, blockLen, capacity: (bytes - words * numBlocks) * 8 };
}

const err = (msg: string): never => {
  throw new Error(msg);
};

function asVersion(ver: unknown): number {
  if (typeof ver !== 'number') throw new TypeError(`"ver" expected number, got type=${typeof ver}`);
  if (!Number.isSafeInteger(ver)) throw new RangeError(`"ver" expected safe integer, got ${ver}`);
  if (ver < 1 || ver > 40) throw new RangeError(`Invalid version=${ver}. Expected number [1..40]`);
  return ver;
}

function detectType(str: string): EncodingType {
  let type: EncodingType = 'numeric';
  for (let i = 0; i < str.length; i++) {
    const v = ALNUM_VAL[str.charCodeAt(i)]; // undefined past 127 -> byte
    if (!(v >= 0)) return 'byte';
    if (v > 9) type = 'alphanumeric';
  }
  return type;
}

// charCode -> alphanumeric value; -1 outside the Table 5 alphabet. Replaces
// a 45-char indexOf scan per character in the encode hot path.
const ALNUM_VAL: Int8Array = /* @__PURE__ */ (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHANUMERIC.length; i++) t[ALPHANUMERIC.charCodeAt(i)] = i;
  return t;
})();

// Segment bits + terminator + padding + RS interleaving.
function encodeData(
  ver: number,
  ecc: ErrorCorrection,
  text: string,
  type: EncodingType,
  utf8: Uint8Array | undefined
): Uint8Array {
  const cap = capacity(ver, ecc);
  const lengthBits = LENGTH_BITS[type][Math.floor((ver + 7) / 17)];
  const dataLen = type === 'byte' ? utf8!.length : text.length;
  if (dataLen >= 1 << lengthBits) err('Capacity overflow');
  const bytes = new Uint8Array(cap.capacity >>> 3);
  // MSB-first bit accumulator, flushed a byte at a time. Pushes are <= 16
  // bits and flushing keeps acc below 8 bits, so it never nears 32. Writes
  // past the end fall off the Uint8Array exactly like the old per-bit
  // writer's did; the overflow check below still sees the true bit count.
  let acc = 0;
  let accBits = 0;
  let bytePos = 0;
  const push = (value: number, len: number) => {
    acc = (acc << len) | value;
    for (accBits += len; accBits >= 8;) bytes[bytePos++] = (acc >>> (accBits -= 8)) & 0xff;
  };
  push(MODE_BITS[type], 4);
  push(dataLen, lengthBits);
  if (type === 'numeric') {
    for (let i = 0; i < dataLen; i += 3) {
      const n = Math.min(3, dataLen - i);
      push(Number(text.slice(i, i + n)), [0, 4, 7, 10][n]);
    }
  } else if (type === 'alphanumeric') {
    for (let i = 0; i + 1 < dataLen; i += 2)
      push(ALNUM_VAL[text.charCodeAt(i)] * 45 + ALNUM_VAL[text.charCodeAt(i + 1)], 11);
    if (dataLen & 1) push(ALNUM_VAL[text.charCodeAt(dataLen - 1)], 6);
  } else {
    for (let i = 0; i < utf8!.length; i++) push(utf8![i], 8);
  }
  let bitPos = bytePos * 8 + accBits;
  if (bitPos > cap.capacity) err('Capacity overflow');
  if (accBits) bytes[bytePos] = (acc << (8 - accBits)) & 0xff;
  // Terminator/alignment zeros come from the flush; then pad codewords.
  bitPos += Math.min(4, cap.capacity - bitPos);
  if (bitPos & 7) bitPos += 8 - (bitPos & 7);
  for (let i = bitPos >>> 3, pad = 0; i < bytes.length; i++, pad ^= 1) bytes[i] = pad ? 0x11 : 0xec;
  // Split into RS blocks (short first), compute parity, interleave both.
  const { words, numBlocks, shortBlocks, blockLen } = cap;
  const rs = rsCached(words);
  const blocks: Uint8Array[] = [];
  const eccs: Uint8Array[] = [];
  for (let i = 0, pos = 0; i < numBlocks; i++) {
    const len = blockLen + (i < shortBlocks ? 0 : 1);
    blocks.push(bytes.subarray(pos, pos + len));
    eccs.push(rsEcc(blocks[i], rs.gen, rs.mul));
    pos += len;
  }
  const res = new Uint8Array(bytes.length + words * numBlocks);
  let p = 0;
  for (let i = 0; i <= blockLen; i++) {
    for (const b of blocks) if (i < b.length) res[p++] = b[i];
  }
  for (let i = 0; i < words; i++) for (const e of eccs) res[p++] = e[i];
  return res;
}

/**
 * ISO/IEC 18004:2024 Table 10 mask predicates, evaluated arithmetically as an
 * 8-bit vector (bit m set when mask predicate m fires at x,y). Shared with
 * the decoder, which tests a single mask's bit to unmask read modules.
 */
function maskBits(x: number, y: number): number {
  const x2 = x % 2;
  const y2 = y % 2;
  const x3 = x % 3;
  const xy3 = (x3 * (y % 3)) % 3;
  const xy2 = x2 & y2;
  let bits = 0;
  if (x2 === y2) bits |= 1;
  if (y2 === 0) bits |= 2;
  if (x3 === 0) bits |= 4;
  if ((x + y) % 3 === 0) bits |= 8;
  if ((Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0) bits |= 16;
  if (xy2 + xy3 === 0) bits |= 32;
  if ((xy2 + xy3) % 2 === 0) bits |= 64;
  if (((x2 ^ y2) + xy3) % 2 === 0) bits |= 128;
  return bits;
}

const POP16: Uint8Array = /* @__PURE__ */ (() => {
  const t = new Uint8Array(1 << 16);
  for (let i = 1; i < t.length; i++) t[i] = t[i >>> 1] + (i & 1);
  return t;
})();
const popcnt = (n: number): number => POP16[n & 0xffff] + POP16[n >>> 16];

const TRANSPOSE_TMP = /* @__PURE__ */ new Uint32Array(32);
// 32x32 in-place bit-matrix transpose (butterfly network).
function transpose32(a: Uint32Array): void {
  const masks = [0x55555555, 0x33333333, 0x0f0f0f0f, 0x00ff00ff, 0x0000ffff];
  for (let stage = 0; stage < 5; stage++) {
    const m = masks[stage] >>> 0;
    const s = 1 << stage;
    for (let i = 0; i < 32; i += s << 1) {
      for (let k = 0; k < s; k++) {
        const x = a[i + k] >>> 0;
        const y = a[i + k + s] >>> 0;
        const t = ((x >>> s) ^ y) & m;
        a[i + k] = (x ^ (t << s)) >>> 0;
        a[i + k + s] = (y ^ t) >>> 0;
      }
    }
  }
}

// Packed square bit matrix: LSB-first bits, `words` u32 per row. Bits at
// x >= size are kept zero — the penalty scanners rely on that invariant.
type Mat = { size: number; words: number; v: Uint32Array };
const mat = (size: number): Mat => {
  const words = (size + 31) >>> 5;
  return { size, words, v: new Uint32Array(words * size) };
};
const matGet = (m: Mat, x: number, y: number): number =>
  (m.v[y * m.words + (x >>> 5)] >>> (x & 31)) & 1;
const matSet = (m: Mat, x: number, y: number, bit: number): void => {
  const i = y * m.words + (x >>> 5);
  const b = 1 << (x & 31);
  m.v[i] = bit ? m.v[i] | b : m.v[i] & ~b;
};

function transposeMat(src: Mat, dst: Mat): void {
  const { size, words, v } = src;
  const tmp = TRANSPOSE_TMP;
  for (let by = 0; by < size; by += 32) {
    for (let bx = 0; bx < words; bx++) {
      const rows = Math.min(32, size - by);
      for (let r = 0; r < rows; r++) tmp[r] = v[(by + r) * words + bx];
      tmp.fill(0, rows);
      transpose32(tmp);
      for (let i = 0, dstY = bx * 32; i < 32 && dstY < size; i++, dstY++) {
        dst.v[dstY * dst.words + (by >>> 5)] = tmp[i];
      }
    }
  }
}

// N1: runs >= 5 score 3 + (L-5), over all columns at once (32 per stripe).
// D_y = row^row+1 flags changes; a monochrome 5-window is 4 clear D bits, and
// each run contributes (L-4) windows plus one run-start window counted twice.
function runsPenaltyVertical(m: Mat): number {
  const { size, words, v } = m;
  const tail = size & 31 ? ((1 << (size & 31)) - 1) >>> 0 : 0xffffffff;
  let score = 0;
  for (let wi = 0; wi < words; wi++) {
    const valid = wi === words - 1 ? tail : 0xffffffff;
    let r3 = v[3 * words + wi];
    let dPrev = 0xffffffff;
    let d0 = v[wi] ^ v[words + wi];
    let d1 = v[words + wi] ^ v[2 * words + wi];
    let d2 = v[2 * words + wi] ^ r3;
    for (let y = 0, idx = 4 * words + wi; y <= size - 5; y++, idx += words) {
      const r4 = v[idx];
      const d3 = r3 ^ r4;
      const w = ~(d0 | d1 | d2 | d3) & valid;
      if (w) score += popcnt(w >>> 0) + 2 * popcnt((w & dPrev) >>> 0);
      dPrev = d0;
      d0 = d1;
      d1 = d2;
      d2 = d3;
      r3 = r4;
    }
  }
  return score;
}

// N3: count 1011101 finder ratio with 4 light modules before/after, vertical,
// both patterns at once across a 32-column stripe.
function finderPenaltyVertical(m: Mat): number {
  const { size, words, v } = m;
  const tail = size & 31 ? ((1 << (size & 31)) - 1) >>> 0 : 0xffffffff;
  let count = 0;
  for (let wi = 0; wi < words; wi++) {
    const valid = wi === words - 1 ? tail : 0xffffffff;
    for (let y = 0; y <= size - 11; y++) {
      let i = y * words + wi;
      const r0 = v[i];
      const r1 = v[(i += words)];
      const r2 = v[(i += words)];
      const r3 = v[(i += words)];
      const r4 = v[(i += words)];
      const r5 = v[(i += words)];
      const r6 = v[(i += words)];
      const r7 = v[(i += words)];
      const r8 = v[(i += words)];
      const r9 = v[(i += words)];
      const r10 = v[i + words];
      const m0 = valid & r0 & ~r1 & r2 & r3 & r4 & ~r5 & r6 & ~(r7 | r8 | r9 | r10);
      const m1 = valid & ~(r0 | r1 | r2 | r3) & r4 & ~r5 & r6 & r7 & r8 & ~r9 & r10;
      count += popcnt(m0 >>> 0) + popcnt(m1 >>> 0);
    }
  }
  return count;
}

function penalty(m: Mat, t: Mat): number {
  transposeMat(m, t);
  return penaltyScore(m, t);
}

// Score a symbol given both orientations. Split from penalty() so the 8-mask
// loop can supply a transposed candidate assembled by XOR (transposition is a
// bit permutation, so T(data^plane) = T(data)^T(plane)) instead of paying a
// butterfly transpose per mask. `limit` is the best score seen so far in that
// race: all terms are non-negative, so once a partial sum reaches it this
// mask can no longer win and the remaining scans — notably the expensive N3
// finder search — are skipped. The partial is only ever compared to `limit`.
function penaltyScore(m: Mat, t: Mat, limit: number = Infinity): number {
  const { size, words, v } = m;
  const adjacent = runsPenaltyVertical(m) + runsPenaltyVertical(t);
  if (adjacent >= limit) return adjacent;
  // N2: 3 points per 2x2 same-color box (overlapping). Valid left-edge
  // positions in the last word: one less than the bits it actually holds.
  const tail2 = ((1 << (size - 32 * (words - 1) - 1)) - 1) >>> 0;
  let boxes = 0;
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let wi = 0; wi < words; wi++) {
      const a0 = v[y * words + wi];
      dark += popcnt(a0 >>> 0);
      if (y === size - 1) continue;
      const a1 = v[(y + 1) * words + wi];
      const n0 = wi + 1 < words ? v[y * words + wi + 1] : 0;
      const n1 = wi + 1 < words ? v[(y + 1) * words + wi + 1] : 0;
      const eqV = ~(a0 ^ a1);
      const eqH0 = ~(a0 ^ ((a0 >>> 1) | (n0 << 31)));
      const eqH1 = ~(a1 ^ ((a1 >>> 1) | (n1 << 31)));
      let w = eqV & eqH0 & eqH1;
      if (wi === words - 1) w &= tail2;
      boxes += popcnt(w >>> 0);
    }
  }
  const total = size * size;
  const darkSteps = Math.ceil(
    Math.max(0, Math.abs(dark * 100 - total * 50) - total * 5) / (total * 5)
  );
  const partial = adjacent + 3 * boxes + 10 * darkSteps;
  if (partial >= limit) return partial;
  return partial + 40 * (finderPenaltyVertical(m) + finderPenaltyVertical(t));
}

function drawInfo(m: Mat, ver: number, ecc: ErrorCorrection, mask: number): void {
  const size = m.size;
  const bits = formatBits(ecc, mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    // Copy 1 around the top-left finder (skipping the timing row/column).
    if (i < 6) matSet(m, 8, i, bit);
    else if (i < 8) matSet(m, 8, i + 1, bit);
    else if (i === 8) matSet(m, 7, 8, bit);
    else matSet(m, 14 - i, 8, bit);
    // Copy 2 under the top-right / right of the bottom-left finder.
    if (i < 8) matSet(m, size - 1 - i, 8, bit);
    else matSet(m, 8, size - 15 + i, bit);
  }
  matSet(m, 8, size - 8, 1); // dark module
  if (ver >= 7) {
    const vbits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >> i) & 1;
      const x = size - 11 + (i % 3);
      const y = (i / 3) | 0;
      matSet(m, x, y, bit);
      matSet(m, y, x, bit);
    }
  }
}

// Everything the symbol layout alone determines, built once per version and
// reused across encodes: the function-pattern template (data region zero),
// the zigzag placement order as packed (wordIndex << 5 | bitOffset) pixel
// positions, and the 8 mask XOR planes plus their transposes (for scoring
// both orientations without a per-mask transpose). Single slot — workloads
// overwhelmingly encode one version repeatedly; worst case (v40) ~190KB.
type SymCache = {
  ver: number;
  tpl: Uint32Array;
  pos: Uint16Array;
  planes: Uint32Array[];
  planesT: Uint32Array[];
  work: [Mat, Mat, Mat, Mat];
};
let symCache: SymCache | undefined;

function buildSymCache(ver: number): SymCache {
  const size = 21 + 4 * (ver - 1);
  const m = mat(size);
  const fun = new Uint8Array(size * size); // 1 = function or reserved cell
  const setF = (x: number, y: number, bit: number) => {
    matSet(m, x, y, bit);
    fun[y * size + x] = 1;
  };
  // Finder patterns + separators (clipped at the edges).
  for (const [fx, fy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]) {
    for (let dy = -1; dy < 8; dy++) {
      for (let dx = -1; dx < 8; dx++) {
        const x = fx + dx;
        const y = fy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const on =
          dx >= 0 &&
          dx < 7 &&
          dy >= 0 &&
          dy < 7 &&
          (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx > 1 && dx < 5 && dy > 1 && dy < 5));
        setF(x, y, on ? 1 : 0);
      }
    }
  }
  // Alignment patterns (skip those overlapping finders).
  const align = alignmentPatterns(ver);
  for (const ay of align) {
    for (const ax of align) {
      if (fun[ay * size + ax]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          setF(ax + dx, ay + dy, on ? 1 : 0);
        }
      }
    }
  }
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    if (!fun[6 * size + i]) setF(i, 6, i % 2 === 0 ? 1 : 0);
    if (!fun[i * size + 6]) setF(6, i, i % 2 === 0 ? 1 : 0);
  }
  // Reserve format / version / dark-module cells at zero (the "test form"
  // that mask penalties are scored on, python-qrcode compatible).
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      setF(8, i, 0); // column right of the top-left finder, skip timing
      setF(i, 8, 0); // row under the top-left finder
    }
    if (i < 8) {
      setF(size - 1 - i, 8, 0); // under the top-right finder
      setF(8, size - 1 - i, 0); // right of the bottom-left finder + dark module
    }
  }
  if (ver >= 7) {
    for (let i = 0; i < 18; i++) {
      const x = size - 11 + (i % 3);
      const y = (i / 3) | 0;
      setF(x, y, 0);
      setF(y, x, 0);
    }
  }
  // Zigzag placement order + per-mask XOR planes (data region only).
  const planes: Mat[] = [];
  for (let i = 0; i < 8; i++) planes.push(mat(size));
  const posBuf = new Uint16Array(size * size);
  let n = 0;
  for (let xOffset = size - 1, dir = -1, y = size - 1; xOffset > 0; xOffset -= 2, dir = -dir) {
    if (xOffset === 6) xOffset = 5; // skip the vertical timing column
    for (; ; y += dir) {
      for (let j = 0; j < 2; j++) {
        const x = xOffset - j;
        if (fun[y * size + x]) continue;
        const wi = y * m.words + (x >>> 5);
        posBuf[n++] = (wi << 5) | (x & 31);
        for (let p = 0, mb = maskBits(x, y); mb; p++, mb >>= 1) {
          if (mb & 1) planes[p].v[wi] |= 1 << (x & 31);
        }
      }
      if (y + dir < 0 || y + dir >= size) break;
    }
  }
  const planesT = planes.map((p) => {
    const t = mat(size);
    transposeMat(p, t);
    return t.v;
  });
  return {
    ver,
    tpl: m.v,
    pos: posBuf.slice(0, n),
    planes: planes.map((p) => p.v),
    planesT,
    work: [mat(size), mat(size), mat(size), mat(size)],
  };
}

// Template copy + data-bit scatter along the cached zigzag order, then mask
// selection: XOR candidates wordwise (both orientations, from the cached
// transposed planes), score the test form, keep the first lowest
// (deterministic ties, python-qrcode compatible).
function drawSymbol(
  ver: number,
  ecc: ErrorCorrection,
  data: Uint8Array,
  maskIdx?: number,
  test = false
): Mat {
  if (symCache === undefined || symCache.ver !== ver) symCache = buildSymCache(ver);
  const { tpl, pos, planes, planesT, work } = symCache;
  const [m, t, cand, candT] = work;
  m.v.set(tpl);
  const need = Math.min(8 * data.length, pos.length); // trailing remainder bits stay 0
  for (let i = 0; i < need; i++) {
    if (data[i >>> 3] & (0x80 >>> (i & 7))) {
      const p = pos[i];
      m.v[p >>> 5] |= 1 << (p & 31);
    }
  }
  let mask = maskIdx;
  if (mask === undefined) {
    transposeMat(m, t); // the only transpose per encode; every mask reuses it
    let bestScore = Infinity;
    for (let p = 0; p < 8; p++) {
      const pv = planes[p];
      const ptv = planesT[p];
      for (let i = 0; i < cand.v.length; i++) {
        cand.v[i] = m.v[i] ^ pv[i];
        candT.v[i] = t.v[i] ^ ptv[i];
      }
      const score = penaltyScore(cand, candT, bestScore);
      if (score < bestScore) {
        bestScore = score;
        mask = p;
      }
    }
  }
  const pv = planes[mask!];
  for (let i = 0; i < m.v.length; i++) m.v[i] ^= pv[i];
  if (!test) drawInfo(m, ver, ecc, mask!);
  return m;
}

const asNum = (n: unknown, title: string): number => {
  if (typeof n !== 'number')
    throw new TypeError(`"${title}" expected number, got type=${typeof n}`);
  if (!Number.isSafeInteger(n)) throw new RangeError(`"${title}" expected safe integer, got ${n}`);
  return n as number;
};
const asString = (s: unknown, title: string): string => {
  if (typeof s !== 'string')
    throw new TypeError(`"${title}" expected string, got type=${typeof s}`);
  return s;
};

// Exact byte count produced by WHATWG TextEncoder, without allocating the
// encoded buffer. Lone surrogates become the three-byte replacement character.
function utf8Length(str: string): number {
  let length = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) length++;
    else if (c < 0x800) length += 2;
    else if (c < 0xd800 || c > 0xdfff) length += 3;
    else if (c <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        i++;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

function byteCapacity(ver: number, ecc: ErrorCorrection): number {
  const lengthBits = LENGTH_BITS.byte[Math.floor((ver + 7) / 17)];
  return Math.min(
    (1 << lengthBits) - 1,
    Math.floor((capacity(ver, ecc).capacity - 4 - lengthBits) / 8)
  );
}

// Copied from noble/hashes utils.ts.
export function _isBytes(a: unknown): a is Uint8Array {
  // Plain `instanceof Uint8Array` is too strict for some Buffer / proxy / cross-realm cases.
  // The fallback still requires a real ArrayBuffer view, so plain
  // JSON-deserialized `{ constructor: ... }` spoofing is rejected, and
  // `BYTES_PER_ELEMENT === 1` keeps the fallback on byte-oriented views.
  return (
    a instanceof Uint8Array ||
    (ArrayBuffer.isView(a) &&
      a.constructor.name === 'Uint8Array' &&
      'BYTES_PER_ELEMENT' in a &&
      a.BYTES_PER_ELEMENT === 1)
  );
}

// Rendering context: the finished matrix plus output geometry; `map`
// translates an output coordinate to its module index (-1 in the border).
// One module-level function per output format, instead of branches inside
// encodeQR: as one function they would share a single V8 optimization unit
// and type-feedback pool, so editing one format's code could slow down
// another format's hot loop. Keep them split.
type Raster = { m: Mat; W: number; map: Int32Array };
const dark = (r: Raster, x: number, y: number): boolean =>
  r.map[x] >= 0 && r.map[y] >= 0 && matGet(r.m, r.map[x], r.map[y]) === 1;

// Control chars come from runtime char codes, never string literals:
// minifiers re-encode a literal '\n' — and constant-fold a bare
// fromCharCode(10) — into a template literal holding a RAW newline
// (1 byte cheaper), splitting every consumer's single-line .min.js.
// The array indirection is opaque enough that the fold is skipped.
const CTRL = [10, 27]; // [newline, ESC]
const NL = /* @__PURE__ */ String.fromCharCode(CTRL[0]);

function renderRaw(r: Raster): boolean[][] {
  const W = r.W;
  const res: boolean[][] = new Array(W);
  for (let y = 0; y < W; y++) {
    const row: boolean[] = new Array(W);
    for (let x = 0; x < W; x++) row[x] = dark(r, x, y);
    res[y] = row;
  }
  return res;
}

function renderAscii(r: Raster): string {
  const W = r.W;
  let out = '';
  for (let y = 0; y < W; y += 2) {
    for (let x = 0; x < W; x++) {
      const first = dark(r, x, y);
      const second = y + 1 >= W ? true : dark(r, x, y + 1);
      out += !first && !second ? '█' : !first && second ? '▀' : first && !second ? '▄' : ' ';
    }
    out += NL;
  }
  return out;
}

function renderTerm(r: Raster): string {
  const W = r.W;
  const esc = String.fromCharCode(CTRL[1]);
  const reset = esc + '[0m';
  let out = '';
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      out += dark(r, x, y) ? `${esc}[40m  ${reset}` : `${esc}[1;47m  ${reset}`;
    }
    out += NL;
  }
  return out;
}

function renderSvg(r: Raster, optimize: boolean): string {
  const W = r.W;
  let out = `<svg viewBox="0 0 ${W} ${W}" xmlns="http://www.w3.org/2000/svg">`;
  let pathData = '';
  let prev: { x: number; y: number } | undefined;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      if (!dark(r, x, y)) continue;
      if (!optimize) {
        out += `<rect x="${x}" y="${y}" width="1" height="1" />`;
        continue;
      }
      let mv = `M${x} ${y}`;
      if (prev) {
        const rel = `m${x - prev.x} ${y - prev.y}`;
        if (rel.length <= mv.length) mv = rel;
      }
      pathData += `${mv}h1v1${x < 10 ? `H${x}` : 'h-1'}Z`;
      prev = { x, y };
    }
  }
  if (optimize) out += `<path d="${pathData}"/>`;
  return out + '</svg>';
}

function renderGif(r: Raster): Uint8Array<ArrayBuffer> {
  const W = r.W;
  const pixels = W * W;
  const N = 126; // pixels per LZW chunk, 8-bit codes until the next clear
  const fullChunks = Math.floor(pixels / N);
  const tail = pixels % N;
  const out = new Uint8Array(408 + fullChunks * (N + 2) + 2 + tail + 4);
  let p = 0;
  const u16 = (v: number) => {
    out[p++] = v & 0xff;
    out[p++] = v >>> 8;
  };
  for (const b of [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) out[p++] = b; // 'GIF87a'
  u16(W);
  u16(W);
  out[p++] = 0xf6;
  p += 2;
  out[p++] = 0xff;
  out[p++] = 0xff;
  out[p++] = 0xff;
  p += 3 * 127; // palette: 0 = white, 1 = black
  out[p++] = 0x2c;
  p += 4;
  u16(W);
  u16(W);
  out[p++] = 0x00;
  out[p++] = 0x07;
  // Pixels are emitted from a per-module-row 0/1 buffer, rebuilt only when
  // the module row changes (border and scale-repeated output rows reuse it),
  // and block-copied in spans bounded by the LZW chunk boundaries. The span
  // copy is the load-bearing part: a per-pixel emit loop costs more than the
  // bit extraction it wraps, so a row buffer alone measures as no win.
  const { m, map } = r;
  const row = new Uint8Array(W);
  let prevMy = -2;
  for (let y = 0, i = 0; y < W; y++) {
    const my = map[y];
    if (my !== prevMy) {
      prevMy = my;
      row.fill(0);
      if (my >= 0) for (let x = 0; x < W; x++) if (map[x] >= 0) row[x] = matGet(m, map[x], my);
    }
    for (let x = 0; x < W;) {
      if (i % N === 0) {
        const rem = pixels - i;
        out[p++] = (rem < N ? rem : N) + 1;
        out[p++] = 0x80; // LZW clear code
      }
      const n = Math.min(N - (i % N), W - x);
      out.set(row.subarray(x, x + n), p);
      p += n;
      x += n;
      i += n;
    }
  }
  if (tail === 0) {
    out[p++] = 1;
    out[p++] = 0x80;
  }
  out[p++] = 0x01;
  out[p++] = 0x81; // end of information
  out[p++] = 0x00;
  out[p++] = 0x3b;
  return out;
}

// data-url: the same GIF, base64-wrapped for direct <img src> use.
// toBase64 (ES2026) where the engine has it; chunked btoa elsewhere —
// fromCharCode over the whole buffer would blow the argument-count limit.
function gifDataUrl(gif: Uint8Array): string {
  const g = gif as Uint8Array & { toBase64?: () => string };
  let b64: string;
  if (typeof g.toBase64 === 'function') b64 = g.toBase64();
  else {
    let bin = '';
    for (let i = 0; i < g.length; i += 8192) bin += String.fromCharCode(...g.subarray(i, i + 8192));
    b64 = btoa(bin);
  }
  return 'data:image/gif;base64,' + b64;
}

/**
 * Encodes (creates / generates) a QR code. Same outputs as the main module's
 * `encodeQR` for all supported inputs.
 */
export function encodeQR(text: string, output: 'raw', opts?: QrOpts): boolean[][];
export function encodeQR(
  text: string,
  output: 'ascii' | 'term' | 'svg' | 'data-url',
  opts?: QrOpts
): string;
export function encodeQR(text: string, output: 'gif', opts?: QrOpts): Uint8Array<ArrayBuffer>;
export function encodeQR(
  text: string,
  output: Output = 'raw',
  opts: QrOpts = {}
): boolean[][] | string | Uint8Array {
  // Validate public arguments, including an explicit version, before caller-controlled encoding.
  asString(text, 'text');
  asString(output, 'output');
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts))
    throw new TypeError(`"opts" expected object, got type=${typeof opts}`);
  let ver = opts.version;
  if (ver !== undefined) ver = asVersion(ver);
  const ecc = opts.ecc !== undefined ? opts.ecc : 'medium';
  if (!ECC_LEVELS.includes(ecc)) err(`invalid ecc=${ecc}`);
  const encoding = opts.encoding !== undefined ? opts.encoding : detectType(text);
  if (!LENGTH_BITS[encoding]) err(`invalid encoding=${encoding}`);
  if (encoding !== 'byte') {
    const alpha = encoding === 'numeric' ? ALPHANUMERIC.slice(0, 10) : ALPHANUMERIC;
    for (const ch of text) {
      if (!alpha.includes(ch)) err(`Unknown letter: "${ch}". Allowed: ${alpha}`);
    }
  }
  if (opts.mask !== undefined && (asNum(opts.mask, 'opts.mask') < 0 || opts.mask > 7))
    err(`invalid mask=${opts.mask}`);
  const textEncoder = opts.textEncoder;
  // Reject impossible built-in UTF-8 payloads before TextEncoder duplicates a
  // potentially huge input. A custom encoder may intentionally emit fewer
  // bytes, so its output remains the source of truth.
  if (encoding === 'byte' && textEncoder === undefined) {
    const maxBytes = byteCapacity(ver === undefined ? 40 : ver, ecc);
    if (text.length > maxBytes || utf8Length(text) > maxBytes) err('Capacity overflow');
  }
  const utf8 =
    encoding === 'byte'
      ? (textEncoder !== undefined ? textEncoder : (s: string) => new TextEncoder().encode(s))(text)
      : undefined;
  if (utf8 !== undefined && !_isBytes(utf8))
    throw new TypeError(`"opts.textEncoder" expected Uint8Array, got type=${typeof utf8}`);
  const dataLen = encoding === 'byte' ? utf8!.length : text.length;
  // Encoded payload bit count, for capacity checks without encoding.
  const encodedBits =
    encoding === 'numeric'
      ? Math.floor(dataLen / 3) * 10 + [0, 4, 7][dataLen % 3]
      : encoding === 'alphanumeric'
        ? Math.floor(dataLen / 2) * 11 + (dataLen % 2) * 6
        : dataLen * 8;
  if (ver === undefined) {
    for (ver = 1; ver <= 40; ver++) {
      const lengthBits = LENGTH_BITS[encoding][Math.floor((ver + 7) / 17)];
      if (dataLen < 1 << lengthBits && 4 + lengthBits + encodedBits <= capacity(ver, ecc).capacity)
        break;
    }
    if (ver > 40) err('Capacity overflow');
  } else {
    const lengthBits = LENGTH_BITS[encoding][Math.floor((ver + 7) / 17)];
    if (dataLen >= 1 << lengthBits || 4 + lengthBits + encodedBits > capacity(ver, ecc).capacity)
      err('Capacity overflow');
  }
  const data = encodeData(ver, ecc, text, encoding, utf8);
  const m = drawSymbol(ver, ecc, data, opts.mask);
  const border = opts.border === undefined ? 2 : asNum(opts.border, 'opts.border');
  // A quiet zone is required (ISO/IEC 18004:2024 §5.3.8). Consumers that
  // need the borderless module matrix (custom-design renderers like qrbtf /
  // cuer) should request border: 1 and slice the padding ring off — the
  // border is added after the symbol is drawn and never affects its content.
  if (border <= 0) throw new RangeError(`invalid border=${border}`);
  const scale = opts.scale === undefined ? 1 : asNum(opts.scale, 'opts.scale');
  if (scale <= 0 || scale > 1024) throw new RangeError(`invalid scale factor: ${scale}`);
  // Output dimensions with quiet zone and scaling applied on the fly; `map`
  // translates an output coordinate to its module index (-1 in the border).
  const W = (m.size + 2 * border) * scale;
  // Every renderer does O(W^2) work. Compact outputs can safely use a 4x
  // dimension limit; raw arrays and verbose terminal/SVG strings cannot.
  const maxOutputSize =
    output === 'ascii' || output === 'gif' || output === 'data-url'
      ? MAX_COMPACT_OUTPUT_SIZE
      : MAX_OUTPUT_SIZE;
  if (W > maxOutputSize)
    throw new RangeError(
      `invalid opts: output is ${W}x${W} (max ${maxOutputSize}), reduce border/scale`
    );
  const map = new Int32Array(W);
  for (let i = 0; i < W; i++) {
    const f = Math.floor(i / scale) - border;
    map[i] = f >= 0 && f < m.size ? f : -1;
  }
  const r: Raster = { m, W, map };
  if (output === 'raw') return renderRaw(r);
  if (output === 'ascii') return renderAscii(r);
  if (output === 'term') return renderTerm(r);
  if (output === 'svg') return renderSvg(r, opts.optimize === undefined ? true : opts.optimize);
  if (output === 'gif') return renderGif(r);
  if (output === 'data-url') return gifDataUrl(renderGif(r));
  return err(`Unknown output: ${output}`);
}

/** Default export alias for {@link encodeQR}. */
export default encodeQR;

// Spec tables and bit-level helpers shared with decode.ts, plus the
// alignment-pattern table for custom-design renderers. The underscore
// marks them as private API: undocumented, may change in any release. Named
// (not bagged in _tests) so decode-only bundles tree-shake per symbol.
export {
  ALPHANUMERIC as _ALPHANUMERIC,
  alignmentPatterns as _alignmentPatterns,
  BYTES as _BYTES,
  ECC_BLOCKS as _ECC_BLOCKS,
  ECC_LEVELS as _ECC_LEVELS,
  GF256 as _GF256,
  WORDS_PER_BLOCK as _WORDS_PER_BLOCK,
  formatBits as _formatBits,
  maskBits as _maskBits,
  popcnt as _popcnt,
  versionBits as _versionBits,
};

/** Internal helpers exposed for the test suite only. */
export const _tests: {
  mat: typeof mat;
  matGet: typeof matGet;
  penalty: typeof penalty;
  drawSymbol: typeof drawSymbol;
  encodeData: typeof encodeData;
  rsEcc: typeof rsEcc;
  detectType: typeof detectType;
  EC_CODE: typeof EC_CODE;
  versionBits: typeof versionBits;
} = { mat, matGet, penalty, drawSymbol, encodeData, rsEcc, detectType, EC_CODE, versionBits };
