/*!
 * Copyright (c) 2023 Paul Miller (paulmillr.com)
 * SPDX-License-Identifier: MIT OR Apache-2.0
 */
/**
 * Minimal QR decoder budgeted for live camera frames. Source conversion and
 * conversion writes directly into reusable native luma storage.
 * The scanner builds a four-level grayscale pyramid, then lazily binarizes and
 * searches from the coarsest useful layer toward native resolution. Sampling
 * can return to native luma after cheaper low-resolution finder detection.
 * @module
 */
import type { Size } from './index.ts';
import {
  _ALPHANUMERIC as ALPHANUMERIC,
  _BYTES as BYTES,
  _ECC_BLOCKS as ECC_BLOCKS,
  _ECC_LEVELS as ECC_LEVELS,
  _GF256 as GF256,
  _WORDS_PER_BLOCK as WORDS_PER_BLOCK,
  _formatBits as formatBits,
  _maskBits as maskBits,
  _popcnt as popcnt,
  _versionBits as versionBits,
} from './index.ts';

export type { Size } from './index.ts';
export type Image = Size & { data: Uint8Array | Uint8ClampedArray };
export type Point = { x: number; y: number };
export type Quad = [Point, Point, Point, Point];
export type FinderPoint = Point & { moduleSize: number; corners: Quad };
export type FinderPoints = {
  tl: FinderPoint;
  tr: FinderPoint;
  /** Projected virtual fourth finder-center position. */
  br: Point;
  bl: FinderPoint;
  /** Alignment patterns actually located during this sampling attempt. */
  aligners: FinderPoint[];
  /** Projected outer QR edges, clockwise from top-left. */
  bounds: Quad;
  /** Projected QR edges plus one module of overlay padding. */
  outline: Quad;
  /** Axis-aligned bounds of the finder-derived QR square. */
  boundingBox: { x: number; y: number; width: number; height: number };
};
export type DecodeFormat =
  | 'RGB'
  | 'I420'
  | 'I420P10'
  | 'I420P12'
  | 'I420A'
  | 'I422'
  | 'I444'
  | 'NV12'
  | 'RGBA'
  | 'RGBX'
  | 'BGRA'
  | 'BGRX';
export type DecodeOpts = {
  /**
   * Source pixel format. Planar formats read a tight Y plane at offset zero;
   * following chroma/alpha planes are ignored. RGB/RGBA is detected by exact
   * data length when omitted.
   */
  format?: DecodeFormat;
  /** Retry-effort tier; one keeps only mandatory work, larger values admit more hypotheses. */
  effort?: number;
  /** Milliseconds available to optional retries; defaults to one 60-FPS frame budget. */
  timeLimit?: number;
  /** Custom byte-to-text decoder used for byte segments; receives the active ECI designator. */
  textDecoder?: (bytes: Uint8Array, eci?: number) => string;
  /**
   * Fired once when a QR search succeeds or terminally fails with finder/alignment points in
   * input-image coordinates and its decoded string or failure.
   */
  pointsOnDetect?: (points: FinderPoints, result: string | Error) => void;
  /**
   * Fired with the final sampled module grid as a 1px-per-module RGBA image after a successful
   * decode.
   */
  imageOnResult?: (img: Image) => void;
  /**
   * Debug: fired with each binarized plane as an RGBA image, right before
   * detection runs on it — exactly what the pipeline sees. Fires once per
   * active layer reached before success; each call allocates a fresh W*H*4
   * buffer the caller owns. Costs nothing when unset.
   */
  imageOnBitmap?: (img: Image) => void;
};
export type QRScannerOpts = DecodeOpts & {
  maxSize: Size;
  /** Bytes reserved per maximum-size input pixel for direct external writes. */
  stride?: number;
};
/** Internal row layout used by DOM VideoFrame ingestion. */
export type _QRLayout = { offset: number; stride: number };
export type _QRLayer = {
  bitmap: Uint32Array;
  blockHeight: number;
  blockWidth: number;
  blocks: Uint8Array;
  cuts: Int16Array;
  height: number;
  luma: Uint8Array;
  patternCount: number;
  patterns: Float64Array;
  used: boolean;
  width: number;
  words: number;
};
const cap = (value: number, min?: number, max?: number) => {
  let result = value;
  if (max !== undefined) result = Math.min(result, max);
  if (min !== undefined) result = Math.max(result, min);
  return result;
};

// --- Reed-Solomon decoding (Berlekamp-Massey) over the encoder's shared GF(2^8) ---
const { exp: EXP, log: LOG } = GF256;
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const inv = (a: number) => EXP[255 - LOG[a]];

type Luma = { width: number; height: number; data: Uint8Array };
export type _QRPlane = readonly [xShift: 0 | 1, yShift: 0 | 1, bytes: 1 | 2 | 3 | 4];
export type _QRInputFormat = { step: 1 | 2 | 3 | 4; bits: 8 | 10 | 12 };
type InputFormat = _QRInputFormat;

// RGBA image from a per-pixel dark predicate (dark -> black).
function darkToImage(width: number, height: number, dk: (x: number, y: number) => number): Image {
  const data = new Uint8Array(width * height * 4);
  let i = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const color = dk(x, y) ? 0 : 255;
      data[i] = color;
      data[i + 1] = color;
      data[i + 2] = color;
      data[i + 3] = 255;
      i += 4;
    }
  return { width, height, data };
}

// Projection reads luma through the threshold grid computed during binarization.
// `sh` is 3 for the layer that owns the grid and grows when native luma reuses
// a lower-resolution layer's thresholds.
type Plane = {
  d: Uint8Array;
  cut: Int16Array;
  W: number;
  H: number;
  bw: number;
  sh: number;
};

// --- finder patterns ---
type Pattern = { x: number; y: number; ms: number };

type Triple = { tl: Pattern; tr: Pattern; bl: Pattern };
type LocatedAligner = { point: Point; x: number; y: number };

// --- sampling + symbol decoding ---
type Part = string | [bytes: Uint8Array, eci: number];
type Decoded = string | Part[];
export type DecodeResult = string | Error;
type Attempt = DecodeResult;
const FAIL = Object.freeze({
  data: Object.freeze(new Error('data')),
  dimension: Object.freeze(new Error('dimension')),
  finder: Object.freeze(new Error('finder')),
  format: Object.freeze(new Error('format')),
  alignment: Object.freeze(new Error('alignment')),
  rs: Object.freeze(new Error('rs')),
  timing: Object.freeze(new Error('timing')),
  version: Object.freeze(new Error('version')),
});
// ISO/IEC 18004:2024 §7.4.3.2 defines six-digit ECI assignment numbers, and
// §7.4.3.4 keeps an ECI active until another ECI changes it. Unsupported
// platform labels may throw; callers needing them can provide textDecoder.
const ECI_ENCODINGS: Record<number, string> = {
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
const ECI_DECODERS: Record<number, TextDecoder | undefined> = {};
for (const [id, name] of Object.entries(ECI_ENCODINGS)) {
  try {
    ECI_DECODERS[+id] = new TextDecoder(name);
  } catch {
    ECI_DECODERS[+id] = undefined;
  }
}
const NUMERIC_LENGTH_BITS = Uint8Array.of(10, 12, 14);
const ALPHANUMERIC_LENGTH_BITS = Uint8Array.of(9, 11, 13);
const BYTE_LENGTH_BITS = Uint8Array.of(8, 16, 16);
type PayloadState = {
  position: number;
  data: Uint8Array;
  dataLen: number;
  bytes: Uint8Array;
  read(bits: number): number;
  views: Uint8Array[];
};
const Payload = {
  create(capacity: number): PayloadState {
    const bytes = new Uint8Array(capacity);
    const views = new Array<Uint8Array>(capacity + 1);
    for (let i = 0; i < views.length; i++) views[i] = new Uint8Array(bytes.buffer, 0, i);
    let state: PayloadState;
    const read = (bits: number) => {
      const start = state.position;
      if (start + bits > state.dataLen * 8) return -1;
      let value = 0;
      let pos = start;
      for (let i = 0; i < bits; i++) {
        value = (value << 1) | ((state.data[pos >> 3] >> (7 - (pos & 7))) & 1);
        pos++;
      }
      state.position = pos;
      return value;
    };
    state = { position: 0, data: new Uint8Array(0), dataLen: 0, bytes, read, views };
    return state;
  },
  decode(
    state: PayloadState,
    data: Uint8Array,
    dataLen: number,
    version: number,
    deferText = false
  ): Decoded | Error {
    state.position = 0;
    state.data = data;
    state.dataLen = dataLen;
    const read = state.read;
    const cls = version < 10 ? 0 : version < 27 ? 1 : 2;
    let eci = 26;
    let res = '';
    const parts: Part[] | undefined = deferText ? [] : undefined;
    while (state.position + 4 <= dataLen * 8) {
      const mode = read(4);
      if (!mode) break;
      if (mode === 7) {
        const b0 = read(8);
        if (b0 < 0) return FAIL.data;
        if ((b0 & 0x80) === 0) eci = b0;
        else {
          const len = (b0 & 0xc0) === 0x80 ? 8 : 16;
          const value = read(len);
          if (value < 0) return FAIL.data;
          eci = (b0 & (len === 8 ? 0x3f : 0x1f)) << len;
          eci |= value;
        }
        continue;
      }
      if (mode === 1) {
        let length = read(NUMERIC_LENGTH_BITS[cls]);
        if (length < 0) return FAIL.data;
        for (; length >= 3; length -= 3) {
          const value = read(10);
          if (value < 0 || value >= 1000) return FAIL.data;
          res += String(value).padStart(3, '0');
        }
        if (length) {
          const value = read(length === 2 ? 7 : 4);
          if (value < 0 || value >= 10 ** length) return FAIL.data;
          res += String(value).padStart(length, '0');
        }
      } else if (mode === 2) {
        let length = read(ALPHANUMERIC_LENGTH_BITS[cls]);
        if (length < 0) return FAIL.data;
        for (; length >= 2; length -= 2) {
          const value = read(11);
          if (value < 0 || value >= 45 * 45) return FAIL.data;
          res += ALPHANUMERIC[(value / 45) | 0] + ALPHANUMERIC[value % 45];
        }
        if (length) {
          const value = read(6);
          if (value < 0 || value >= 45) return FAIL.data;
          res += ALPHANUMERIC[value];
        }
      } else if (mode === 4) {
        const length = read(BYTE_LENGTH_BITS[cls]);
        if (length < 0 || state.position + 8 * length > dataLen * 8) return FAIL.data;
        if (parts) {
          const segment = new Uint8Array(length);
          for (let i = 0; i < length; i++) segment[i] = read(8);
          if (res) parts.push(res);
          parts.push([segment, eci]);
          res = '';
        } else {
          const encoding = ECI_ENCODINGS[eci];
          if (!encoding || length >= state.views.length) return FAIL.data;
          const decoder = ECI_DECODERS[eci] || new TextDecoder(encoding);
          for (let i = 0; i < length; i++) state.bytes[i] = read(8);
          res += decoder.decode(state.views[length]);
        }
      } else return FAIL.data;
    }
    if (!parts) return res;
    if (res) parts.push(res);
    return parts;
  },
  finish(decoded: Decoded, textDecoder?: (bytes: Uint8Array, eci?: number) => string): string {
    if (typeof decoded === 'string') return decoded;
    if (!textDecoder) throw new Error('text decoder');
    let res = '';
    for (const part of decoded)
      res += typeof part === 'string' ? part : textDecoder(part[0], part[1]);
    return res;
  },
};
// Squared center distance between two stride-4 pattern records (element offsets, not indices);
// the triple-geometry scans in makeTriple/prepareSets/pickPolarity share this shape.
const dist2 = (pts: Float64Array, a: number, b: number) =>
  (pts[a] - pts[b]) ** 2 + (pts[a + 1] - pts[b + 1]) ** 2;
const distance = (first: Point, second: Point) =>
  Math.hypot(second.x - first.x, second.y - first.y);
const checkVersion = (m: Uint8Array, size: number) => {
  const ver = (size - 17) / 4;
  if (ver < 7) return true;
  let v1 = 0;
  let v2 = 0;
  for (let i = 0; i < 18; i++) {
    const x = size - 11 + (i % 3);
    const y = (i / 3) | 0;
    v1 |= m[y * size + x] << i;
    v2 |= m[x * size + y] << i;
  }
  const expected = versionBits(ver);
  const d1 = popcnt(expected ^ v1);
  const d2 = popcnt(expected ^ v2);
  // Version 7+ carries two redundant BCH words; at least one must identify
  // the version implied by the sampled dimension within its radius-3 budget.
  return d1 <= 3 || d2 <= 3;
};

// 3x3 projective transform in row-major layout,
// row-major in a Float64Array: [a11 a12 a13 a21 a22 a23 a31 a32 a33],
// applied to column vectors [u, v, 1] with a perspective divide.
function squareToQuad(out: Float64Array, points: Float64Array): void {
  const x1 = points[0];
  const y1 = points[1];
  const x2 = points[2];
  const y2 = points[3];
  const x3 = points[4];
  const y3 = points[5];
  const x4 = points[6];
  const y4 = points[7];
  const dx3 = x1 - x2 + x3 - x4;
  const dy3 = y1 - y2 + y3 - y4;
  if (dx3 === 0 && dy3 === 0) {
    out[0] = x2 - x1;
    out[1] = x3 - x2;
    out[2] = x1;
    out[3] = y2 - y1;
    out[4] = y3 - y2;
    out[5] = y1;
    out[6] = 0;
    out[7] = 0;
    out[8] = 1;
    return;
  }
  const dx1 = x2 - x3;
  const dx2 = x4 - x3;
  const dy1 = y2 - y3;
  const dy2 = y4 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const a31 = (dx3 * dy2 - dx2 * dy3) / den;
  const a32 = (dx1 * dy3 - dx3 * dy1) / den;
  out[0] = x2 - x1 + a31 * x2;
  out[1] = x4 - x1 + a32 * x4;
  out[2] = x1;
  out[3] = y2 - y1 + a31 * y2;
  out[4] = y4 - y1 + a32 * y4;
  out[5] = y1;
  out[6] = a31;
  out[7] = a32;
  out[8] = 1;
}
// adj[r][c] is the (c, r) cofactor: products commute exactly in IEEE 754, so
// the loop matches a hand-unrolled adjugate bit for bit.
const adjugate = (o: Float64Array, m: Float64Array): void => {
  for (let i = 0; i < 9; i++) {
    const r = (i / 3) | 0;
    const c = i % 3;
    const r1 = ((c + 1) % 3) * 3;
    const r2 = ((c + 2) % 3) * 3;
    const c1 = (r + 1) % 3;
    const c2 = (r + 2) % 3;
    o[i] = m[r1 + c1] * m[r2 + c2] - m[r1 + c2] * m[r2 + c1];
  }
};
const ptMul = (o: Float64Array, a: Float64Array, b: Float64Array): void => {
  // Cache one input row so the product may replace its left operand.
  for (let r = 0; r < 9; r += 3) {
    const a0 = a[r];
    const a1 = a[r + 1];
    const a2 = a[r + 2];
    for (let c = 0; c < 3; c++) o[r + c] = a0 * b[c] + a1 * b[c + 3] + a2 * b[c + 6];
  }
};

// Threaded through projection so callbacks can be mapped back into the
// caller's original-image coordinates.
type Ctx = {
  opts: DecodeOpts;
  scale: number;
  ox: number;
  oy: number;
  // Finest luma plane offered to downscaled sampling; `r` = layer index (scale factor 2^r).
  fine?: { luma: Luma; r: number };
};

type ScannerTriple = Triple & {
  inverted: boolean;
  tlIndex: number;
  trIndex: number;
  blIndex: number;
};
// A fractional initial value establishes unboxed-double fields before per-frame writes.
const makePattern = (): Pattern => ({ x: 0.1, y: 0.1, ms: 0.1 });
type ScannerLayer = _QRLayer & {
  readonly plane: Plane;
  readonly context: Ctx;
  found: boolean;
  readonly inverted: Uint8Array;
  readonly sets: Float64Array;
  setCount: number;
  setCursor: number;
  setsReady: boolean;
  // Round-0 pick as an id bag (sum/min/max identify the unordered id multiset); retry pops
  // skip a matching set instead of re-attempting the mandatory triple.
  pickSum: number;
  pickLo: number;
  pickHi: number;
};
const LUMA8: InputFormat = { step: 1, bits: 8 };
const LUMA10: InputFormat = { step: 2, bits: 10 };
const LUMA12: InputFormat = { step: 2, bits: 12 };
const RGB: InputFormat = { step: 3, bits: 8 };
// Packed four-byte inputs intentionally ignore the fourth byte: the raw decoder consumes RGB
// channels and does not composite alpha, while X formats use the same storage shape.
const RGBA: InputFormat = { step: 4, bits: 8 };
const FORMATS: Record<DecodeFormat, InputFormat> = {
  RGB,
  RGBA,
  RGBX: RGBA,
  BGRA: RGBA,
  BGRX: RGBA,
  I420: LUMA8,
  I420A: LUMA8,
  I422: LUMA8,
  I444: LUMA8,
  NV12: LUMA8,
  I420P10: LUMA10,
  I420P12: LUMA12,
};
// Runtime-invalid formats fall through to undefined for the option guard below.
const inputFormat = (format: DecodeFormat): InputFormat | undefined => FORMATS[format];
const validateOpts = (opts: DecodeOpts): void => {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts))
    throw new TypeError(`"opts" expected object, got type=${typeof opts}`);
  if (opts.format !== undefined && !inputFormat(opts.format))
    throw new TypeError(`invalid opts.format=${opts.format} (${typeof opts.format})`);
  if (
    opts.effort !== undefined &&
    opts.effort !== Infinity &&
    (!Number.isSafeInteger(opts.effort) || opts.effort < 1)
  )
    throw new TypeError(`invalid opts.effort=${opts.effort} (${typeof opts.effort})`);
  if (
    opts.timeLimit !== undefined &&
    opts.timeLimit !== Infinity &&
    (typeof opts.timeLimit !== 'number' || !Number.isFinite(opts.timeLimit) || opts.timeLimit < 0)
  )
    throw new TypeError(`invalid opts.timeLimit=${opts.timeLimit} (${typeof opts.timeLimit})`);
  for (const name of ['textDecoder', 'pointsOnDetect', 'imageOnResult', 'imageOnBitmap'] as const)
    if (opts[name] !== undefined && typeof opts[name] !== 'function')
      throw new TypeError(`invalid opts.${name}=${opts[name]} (${typeof opts[name]})`);
};
const validateImage = (
  img: Image,
  named?: DecodeFormat,
  layout?: _QRLayout,
  capacity = Infinity
): InputFormat => {
  if (!Number.isSafeInteger(img.width) || !Number.isSafeInteger(img.height))
    throw new TypeError('"img" expected safe integer width and height');
  const px = img.width * img.height;
  if (px > capacity) throw new TypeError(`"img" expected area <= ${capacity}, got ${px}`);
  const data = img.data as unknown;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw new TypeError(`"img.data" expected Uint8Array or Uint8ClampedArray, got ${typeof data}`);
  const bytes = data as Image['data'];
  let format: InputFormat | undefined;
  if (named !== undefined) {
    format = inputFormat(named);
    if (!format) throw new TypeError(`invalid opts.format=${named} (${typeof named})`);
    if (layout) {
      const { offset, stride } = layout;
      const row = format.step * img.width;
      const end = offset + (img.height - 1) * stride + row;
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(stride) ||
        offset < 0 ||
        stride < row ||
        end > bytes.length
      )
        throw new RangeError(
          `"img.data" expected valid offset/stride for format=${named}, ` +
            `got offset=${offset}, stride=${stride}, length=${bytes.length}`
        );
    } else {
      const expected = format.step * px;
      const planar = format.step <= 2;
      if ((planar && bytes.length < expected) || (!planar && bytes.length !== expected))
        throw new RangeError(
          `"img.data" expected ${planar ? 'at least ' : ''}${expected} bytes ` +
            `for format=${named}, got ${bytes.length}`
        );
    }
  } else if (bytes.length === 3 * px) format = RGB;
  else if (bytes.length === 4 * px) format = RGBA;
  else
    throw new RangeError(
      `"img.data" expected ${3 * px} or ${4 * px} bytes without opts.format, got ${bytes.length}`
    );
  return format;
};
const copyLuma = (
  out: Uint8Array,
  maxPixels: number,
  img: Image,
  named?: DecodeFormat,
  layout?: _QRLayout
): void => {
  const { step, bits } = validateImage(img, named, layout, maxPixels);
  const { width, height, data } = img;
  const stride = layout?.stride || width * step;
  const offset = layout?.offset || 0;
  // Native luma may already be the decoder arena. Preserve that zero-copy path while sharing
  // every packed/planar conversion with alternate generated scanner backends.
  if (data === out && !offset && stride === width && step === 1) return;
  for (let y = 0; y < height; y++) {
    let src = offset + y * stride;
    let dst = y * width;
    if (step === 1)
      for (let x = 0; x < width; x++) {
        out[dst++] = data[src];
        src++;
      }
    else if (step === 2)
      for (let x = 0; x < width; x++) {
        out[dst++] = (data[src] | (data[src + 1] << 8)) >>> (bits - 8);
        src += step;
      }
    else
      for (let x = 0; x < width; x++) {
        out[dst++] = (data[src] + 2 * data[src + 1] + data[src + 2]) >> 2;
        src += step;
      }
  }
};
export type DecodeQR = (img: Image, opts?: DecodeOpts) => string;
// Store a clockwise quadrilateral as interleaved x/y coordinates without allocating points.
const packQuad = (
  quad: Float64Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number
): void => {
  quad[0] = x0;
  quad[1] = y0;
  quad[2] = x1;
  quad[3] = y1;
  quad[4] = x2;
  quad[5] = y2;
  quad[6] = x3;
  quad[7] = y3;
};
// Read one packed bitmap bit; -1 is an out-of-bounds sentinel distinct from either polarity.
const bit = (layer: ScannerLayer, x: number, y: number) => {
  if (x < 0 || y < 0 || x >= layer.width || y >= layer.height) return -1;
  return (layer.bitmap[y * layer.words + (x >>> 5)] >>> (x & 31)) & 1;
};
// Return the module pitch of a tolerant 1:1:3:1:1 finder run, or zero when it does not fit.
const ratio = (a: number, b: number, c: number, d: number, e: number) => {
  const total = a + b + c + d + e;
  if (total < 7) return 0;
  const ms = total / 7;
  // Half-module tolerance accommodates sampling noise around the three-module center.
  const tol = ms * 0.5;
  return Math.abs(ms - a) < tol &&
    Math.abs(ms - b) < tol &&
    Math.abs(3 * ms - c) < 3 * tol &&
    Math.abs(ms - d) < tol &&
    Math.abs(ms - e) < tol
    ? ms
    : 0;
};
// Consecutive `color` bits from (x,y) inclusive stepping (dx,dy); stops on mismatch, border,
// or once the count passes `cap` (bit-walk semantics: at most floor(cap)+1 bits count).
// Horizontal runs consume whole bitmap words through clz32; vertical runs must step per bit.
const run = (
  layer: ScannerLayer,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: number,
  cap: number
): number => {
  let n = 0;
  if (dy) {
    while (bit(layer, x, y) === color && n <= cap) {
      n++;
      y += dy;
    }
    return n;
  }
  if (y < 0 || y >= layer.height) return 0;
  const row = y * layer.words;
  while (x >= 0 && x < layer.width && n <= cap) {
    const shift = x & 31;
    // 1-bits of `stops` mark where the run ends; windowed toward the walk direction so
    // clz32 (left) or the isolated lowest bit (right) yields the matching-bit count.
    const stops = (color ? ~layer.bitmap[row + (x >>> 5)] : layer.bitmap[row + (x >>> 5)]) >>> 0;
    const w = dx > 0 ? stops >>> shift : (stops << (31 - shift)) >>> 0;
    const span = dx > 0 ? Math.min(32 - shift, layer.width - x) : shift + 1;
    const first = !w ? 32 : dx > 0 ? 31 - Math.clz32((w & -w) >>> 0) : Math.clz32(w);
    const len = Math.min(first, span);
    n += len;
    x += dx * len;
    if (first < span) break;
  }
  return Math.min(n, Math.floor(cap) + 1);
};
// 1:1:3:1:1 cross-check from (cx,cy) along (dx,dy). Returns the refined center coordinate,
// or the measured pitch when requested, and -1 on ratio failure.
const cross = (
  layer: ScannerLayer,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  maxMs: number,
  inverted: boolean,
  measure = false
): number => {
  const center = +!inverted;
  const side = +inverted;
  let r2 = run(layer, cx, cy, -dx, -dy, center, Infinity);
  let back = r2;
  const r1 = run(layer, cx - dx * back, cy - dy * back, -dx, -dy, side, maxMs);
  back += r1;
  const r0 = run(layer, cx - dx * back, cy - dy * back, -dx, -dy, center, maxMs);
  back += r0;
  const start = (dx ? cx : cy) - back;
  const forward = run(layer, cx + dx, cy + dy, dx, dy, center, Infinity);
  r2 += forward;
  let ahead = 1 + forward;
  const r3 = run(layer, cx + dx * ahead, cy + dy * ahead, dx, dy, side, maxMs);
  ahead += r3;
  const r4 = run(layer, cx + dx * ahead, cy + dy * ahead, dx, dy, center, maxMs);
  if (!ratio(r0, r1, r2, r3, r4)) return -1;
  return measure ? (r0 + r1 + r2 + r3 + r4) / 7 : start + 1 + r0 + r1 + r2 / 2;
};
// Vertical 1:1:3:1:1 cross at a pattern center, capped by its module size — the shared
// entry for center refinement and pitch measurement.
const vertical = (layer: ScannerLayer, pattern: Pattern, inverted: boolean, measure = false) => {
  const limit = 3 * pattern.ms;
  return cross(layer, Math.round(pattern.x), Math.round(pattern.y), 0, 1, limit, inverted, measure);
};
// Recenter a finder vertically then horizontally; return total movement or -1 on cross failure.
const refinePattern = (layer: ScannerLayer, pattern: Pattern, inverted: boolean) => {
  const y = vertical(layer, pattern, inverted);
  if (y < 0) return -1;
  const limit = 3 * pattern.ms;
  const x = cross(layer, Math.round(pattern.x), Math.round(y), 1, 0, limit, inverted);
  if (x < 0) return -1;
  const movement = Math.abs(x - pattern.x) + Math.abs(y - pattern.y);
  pattern.x = x;
  pattern.y = y;
  return movement;
};
// Refine all finder centers in place and require at least one to move.
const refineTriple = (layer: ScannerLayer, triple: ScannerTriple) => {
  const tl = refinePattern(layer, triple.tl, triple.inverted);
  if (tl < 0) return false;
  const tr = refinePattern(layer, triple.tr, triple.inverted);
  if (tr < 0) return false;
  const bl = refinePattern(layer, triple.bl, triple.inverted);
  return bl >= 0 && tl + tr + bl > 0;
};
// Fit a grayscale finder template independently on each axis around a binary finder center.
const fitPattern = (layer: ScannerLayer, pattern: Pattern, inverted: boolean) => {
  // Tenths of horizontal pitch; includes measured perspective squeeze.
  const luma = layer.luma;
  const fit = (axis: number) => {
    const center = axis ? pattern.y : pattern.x;
    const other = axis ? pattern.x : pattern.y;
    const radius = Math.ceil(pattern.ms);
    const lo = Math.round(center) - radius;
    const hi = Math.round(center) + radius;
    let best = center;
    let bestScore = -Infinity;
    for (let candidate = lo; candidate <= hi; candidate++)
      for (let scale = 5; scale <= 15; scale += 2) {
        const pitch = (pattern.ms * scale) / 10;
        const crossRadius = Math.round(pitch / 2);
        const side = Math.ceil(3.5 * pitch);
        let dark = 0;
        let darkCount = 0;
        let light = 0;
        let lightCount = 0;
        for (let along = -side; along <= side; along++) {
          const module = Math.abs(along / pitch);
          const expectedDark = module < 1.5 || module >= 2.5;
          for (let across = -crossRadius; across <= crossRadius; across++) {
            const x = Math.round(axis ? other + across : candidate + along);
            const y = Math.round(axis ? candidate + along : other + across);
            if (x < 0 || y < 0 || x >= layer.width || y >= layer.height) continue;
            const value = luma[y * layer.width + x];
            if (expectedDark) {
              dark += value;
              darkCount++;
            } else {
              light += value;
              lightCount++;
            }
          }
        }
        let score = light / lightCount - dark / darkCount;
        if (inverted) score = -score;
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
    return best;
  };
  pattern.x = fit(0);
  pattern.y = fit(1);
};
// Apply the projective map at (x,y). The returned pair is scalar-replaced at inlined call
// sites (verified via --trace-gc + TFEscapeAnalysis), so hot callers stay allocation-free.
const mapPoint = (map: Float64Array, x: number, y: number): Point => {
  const den = map[6] * x + map[7] * y + map[8];
  return {
    x: (map[0] * x + map[1] * y + map[2]) / den,
    y: (map[3] * x + map[4] * y + map[5]) / den,
  };
};
// Vertical run pitch at a finder center: mean 1:1:3:1:1 run height, or 0 on ratio failure.
const crossPitch = (layer: ScannerLayer, pattern: Pattern, inverted: boolean) => {
  const pitch = vertical(layer, pattern, inverted, true);
  return pitch < 0 ? 0 : pitch;
};
// Combine horizontal and vertical finder runs into one perspective-tolerant pitch.
const finderPitch = (layer: ScannerLayer, pattern: Pattern) => {
  const vertical = crossPitch(layer, pattern, false);
  return vertical ? Math.sqrt(pattern.ms * vertical) : 0;
};
// Average the endpoint pitches after projecting horizontal/vertical runs onto their shared edge.
const edgePitch = (layer: ScannerLayer, first: Pattern, second: Pattern, inverted: boolean) => {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const length = distance(first, second);
  if (!length) return 0;
  const pitch = (pattern: Pattern) => {
    const vertical = crossPitch(layer, pattern, inverted);
    if (!vertical) return 0;
    return Math.sqrt(((dx / length) * pattern.ms) ** 2 + ((dy / length) * vertical) ** 2);
  };
  const firstPitch = pitch(first);
  const secondPitch = pitch(second);
  return firstPitch && secondPitch ? (firstPitch + secondPitch) / 2 : 0;
};
// Confidence (slot 3) stays behind: every consumer reads it straight from the record.
const copyPattern = (layer: ScannerLayer, index: number, out: Pattern) => {
  const pos = index * 4;
  out.x = layer.patterns[pos];
  out.y = layer.patterns[pos + 1];
  out.ms = layer.patterns[pos + 2];
};
// Swap two stride-5 retry records: [rank, inverted, finder0, finder1, finder2].
const swapSet = (layer: ScannerLayer, a: number, b: number) => {
  const sets = layer.sets;
  const ap = a * 5;
  const bp = b * 5;
  for (let i = 0; i < 5; i++) {
    const value = sets[ap + i];
    sets[ap + i] = sets[bp + i];
    sets[bp + i] = value;
  }
};
// Max-heap sift-down of the root over the first `end` set records.
const siftDown = (layer: ScannerLayer, end: number) => {
  const sets = layer.sets;
  for (let index = 0; ;) {
    const left = index * 2 + 1;
    if (left >= end) return;
    const right = left + 1;
    const child = right < end && sets[right * 5] > sets[left * 5] ? right : left;
    if (sets[index * 5] >= sets[child * 5]) return;
    swapSet(layer, index, child);
    index = child;
  }
};
// Evaluate a low-degree-first GF(256) polynomial slice with Horner's method.
const evalLow = (poly: Uint8Array, offset: number, length: number, x: number): number => {
  let value = 0;
  for (let i = length - 1; i >= 0; i--) value = mul(value, x) ^ poly[offset + i];
  return value;
};
// Row-ranged stages let the async scanner yield between bounded chunks without duplicating loops.
const scanRows = {
  // Downsample two source rows into one pyramid row with a 2x2 box filter.
  resize(
    src: Uint8Array,
    dst: Uint8Array,
    width: number,
    dstWidth: number,
    from: number,
    to: number
  ) {
    for (let y = from; y < to; y++) {
      let srcPos = (y << 1) * width;
      let dstPos = y * dstWidth;
      for (let x = 0; x < dstWidth; x++) {
        dst[dstPos++] =
          (src[srcPos] + src[srcPos + 1] + src[srcPos + width] + src[srcPos + width + 1] + 2) >> 2;
        srcPos += 2;
      }
    }
  },
  // Compute one local threshold per 8x8 block, including low-contrast predecessor propagation.
  blocks(layer: ScannerLayer, from: number, to: number) {
    const brightness = layer.luma;
    const block = 8;
    const bWidth = layer.blockWidth;
    const maxY = layer.height - block;
    const maxX = layer.width - block;
    const blocks = layer.blocks;
    for (let y = from; y < to; y++) {
      const yPos = cap(y * block, 0, maxY);
      for (let x = 0; x < bWidth; x++) {
        const xPos = cap(x * block, 0, maxX);
        let sum = 0;
        let min = 0xff;
        let max = 0;
        let pos = yPos * layer.width + xPos;
        for (let yy = 0; yy < block; yy++) {
          for (let xx = 0; xx < block; xx++) {
            const pixel = brightness[pos + xx];
            sum += pixel;
            min = Math.min(min, pixel);
            max = Math.max(max, pixel);
          }
          pos += layer.width;
        }
        let average = Math.floor(sum / block ** 2);
        // Low-contrast blocks use the darkest sample to avoid erasing faint modules.
        if (max - min <= 24) {
          average = min / 2;
          if (y > 0 && x > 0) {
            const top = blocks[(y - 1) * bWidth + x];
            const left = blocks[y * bWidth + x - 1];
            const topLeft = blocks[(y - 1) * bWidth + x - 1];
            // The top weight is paired with the restored 5x5 smoother.
            const previous = (2 * top + left + topLeft) / 4;
            if (min < previous) average = previous;
          }
        }
        blocks[bWidth * y + x] = average >>> 0;
      }
    }
  },
  // Smooth block thresholds and write their 8x8 binary pixels into the packed bitmap.
  bitmap(layer: ScannerLayer, from: number, to: number) {
    const brightness = layer.luma;
    const block = 8;
    const bWidth = layer.blockWidth;
    const bHeight = layer.blockHeight;
    const maxY = layer.height - block;
    const maxX = layer.width - block;
    const blocks = layer.blocks;
    for (let y = from; y < to; y++) {
      const yPos = cap(y * block, 0, maxY);
      // The historical 5x5 smoother improves perspective coverage.
      const top = cap(y, 2, bHeight - 3);
      for (let x = 0; x < bWidth; x++) {
        const xPos = cap(x * block, 0, maxX);
        const left = cap(x, 2, bWidth - 3);
        let sum = 0;
        for (let yy = -2; yy <= 2; yy++) {
          const row = bWidth * (top + yy) + left;
          for (let xx = -2; xx <= 2; xx++) sum += blocks[row + xx];
        }
        const average = sum / 25;
        layer.cuts[y * bWidth + x] = Math.floor(average);
        let pos = yPos * layer.width + xPos;
        for (let yy = 0; yy < block; yy++) {
          let value = 0;
          for (let xx = 0; xx < block; xx++) value |= +(brightness[pos + xx] <= average) << xx;
          const shift = xPos & 31;
          const word = (yPos + yy) * layer.words + (xPos >>> 5);
          const lowMask = (0xff << shift) >>> 0;
          layer.bitmap[word] = ((layer.bitmap[word] & ~lowMask) | ((value << shift) >>> 0)) >>> 0;
          if (shift > 24) {
            const highMask = (1 << (shift - 24)) - 1;
            layer.bitmap[word + 1] =
              ((layer.bitmap[word + 1] & ~highMask) | (value >>> (32 - shift))) >>> 0;
          }
          pos += layer.width;
        }
      }
    }
  },
  // Find and merge horizontally seeded finder crosses in every second row.
  find(layer: ScannerLayer, from: number, to: number) {
    // Rolling window over each row's run-length encoding (no per-row arrays):
    // check every 5-run window that starts, centers, and ends on a black run.
    // run() always advances (previous matches the bit at x by construction).
    for (let y = from; y < to; y += 2) {
      let r0 = 0;
      let r1 = 0;
      let r2 = 0;
      let r3 = 0;
      let r4 = 0;
      let runs = 0;
      let previous = !!bit(layer, 0, y | 0);
      for (let x = 0; x < layer.width;) {
        const length = run(layer, x, y, 1, 0, +previous, Infinity);
        x += length;
        r0 = r1;
        r1 = r2;
        r2 = r3;
        r3 = r4;
        r4 = length;
        runs++;
        const black = previous;
        previous = !previous;
        candidate: {
          if ((runs | 0) < 5) break candidate;
          const inverted = !black;
          const ms = ratio(r0, r1, r2, r3, r4);
          if (!ms) break candidate;
          const start = (x | 0) - r0 - r1 - r2 - r3 - r4;
          const cx = Math.round(start + r0 + r1 + r2 / 2);
          const limit = ms * 3;
          const cy = cross(layer, cx, y | 0, 0, 1, limit, inverted);
          if (cy < 0) break candidate;
          const refinedX = cross(layer, cx, Math.round(cy), 1, 0, limit, inverted);
          if (refinedX < 0) break candidate;
          const patterns = layer.patterns;
          const polarity = +inverted;
          for (let i = 0; i < layer.patternCount; i++) {
            const pos = i * 4;
            if (
              (layer.inverted[i] & 1) !== polarity ||
              // Merge observations within two modules of the same finder center.
              Math.abs(patterns[pos] - refinedX) >= 2 * ms ||
              Math.abs(patterns[pos + 1] - cy) >= 2 * ms
            )
              continue;
            const count = patterns[pos + 3] + 1;
            patterns[pos] = (patterns[pos] * patterns[pos + 3] + refinedX) / count;
            patterns[pos + 1] = (patterns[pos + 1] * patterns[pos + 3] + cy) / count;
            patterns[pos + 2] = (patterns[pos + 2] * patterns[pos + 3] + ms) / count;
            patterns[pos + 3] = count;
            break candidate;
          }
          const index = layer.patternCount++;
          const pos = index * 4;
          if (pos + 3 >= patterns.length)
            throw new Error(`finder storage exhausted at ${layer.width}x${layer.height}`);
          patterns[pos] = refinedX;
          patterns[pos + 1] = cy;
          patterns[pos + 2] = ms;
          patterns[pos + 3] = 1;
          layer.inverted[index] = polarity;
        }
      }
    }
  },
};
// Legal QR sides are 17 + 4 * version. Non-finite estimates coerce to zero and fail the
// caller's dimension bounds rather than reaching projection.
const snapSize = (estimate: number) => (Math.round((estimate - 17) / 4) * 4 + 17) | 0;
type DecodeWalk<T> = Generator<void, T, number>;
// Drain the shared work generator without host yields for the synchronous API.
const runDecode = <T>(walk: DecodeWalk<T>): T => {
  let step = walk.next();
  while (!step.done) step = walk.next(0);
  return step.value;
};
// Prefer the host's prioritized scheduler; a zero-delay task is the portable fallback.
const nextTick = (): Promise<void> => {
  const host = globalThis as any;
  if (typeof host.scheduler?.yield === 'function') return host.scheduler.yield();
  return new Promise((resolve) => host.setTimeout(resolve, 0));
};
// Drain bounded generator work, yielding to the host after each scheduling quantum.
const runDecodeAsync = async <T>(walk: DecodeWalk<T>, timeLimit: number): Promise<T> => {
  const tick = Math.min(timeLimit, 8);
  let started = Date.now();
  try {
    let step = walk.next();
    for (;;) {
      if (step.done) return step.value;
      let waited = 0;
      if (Date.now() - started >= tick) {
        const waiting = Date.now();
        await nextTick();
        waited = Date.now() - waiting;
        started = Date.now();
      }
      step = walk.next(waited);
    }
  } catch (error) {
    walk.return(undefined as T);
    throw error;
  }
};
/**
 * Reusable decode state for DOM helpers and advanced integrations.
 * Most users should call {@link decodeQR} or use the utilities from `qr/dom.js`.
 */
export class _QRScanner {
  readonly layers: _QRLayer[];
  readonly opts: Readonly<QRScannerOpts>;
  width: number;
  height: number;
  luma: Uint8Array;
  private grid = new Uint8Array(177 * 177);
  private readonly tmp8 = new Uint8Array(177 * 177);
  private readonly codewords = new Uint8Array(BYTES[40 - 1]);
  private readonly tmp32 = new Uint32Array(4 * 16 * 3 + 16);
  private readonly tmp64 = new Float64Array(7 * 7 * 2 + (7 * 7 - 3) * 4);
  private readonly payload = Payload.create(BYTES[40 - 1]);
  private readonly image: Luma;
  private readonly input: Image;
  private readonly maxPixels: number;
  private staged = false;
  private resized = false;
  // Finder selection and projection reuse the same typed temporaries by phase. Three homographies
  // stay separate because decode fallbacks retain them across a failed payload attempt.
  private readonly triple: ScannerTriple = {
    tl: makePattern(),
    tr: makePattern(),
    bl: makePattern(),
    inverted: false,
    tlIndex: 0,
    trIndex: 0,
    blIndex: 0,
  };
  private blocked = 0;
  private readonly effort: number;
  private readonly timeLimit: number;
  private retryStart = 0;
  private retries = 0;
  private points?: FinderPoints;
  // Homography phases do not overlap: `map` holds the active result while `from` and `to` are
  // scratch; `to` doubles as the fine-plane map until the next homography build.
  private readonly map = new Float64Array(9);
  private readonly from = new Float64Array(9);
  private readonly to = new Float64Array(9);
  private readonly alignPoint: Point = { x: 0.1, y: 0.1 };
  private readonly finePlane: Plane = {
    d: new Uint8Array(0),
    cut: new Int16Array(0),
    W: 0,
    H: 0,
    bw: 0,
    sh: 0,
  };
  private invertedProjection = false;
  private decodedSize = 0;

  constructor(init: QRScannerOpts) {
    validateOpts(init);
    if (!Number.isSafeInteger(init.maxSize.width) || !Number.isSafeInteger(init.maxSize.height))
      throw new TypeError('"maxSize" expected safe integer width and height');
    const maxPixels = init.maxSize.width * init.maxSize.height;
    const maxSize = Object.freeze({ ...init.maxSize });
    const maxSide = Math.max(maxSize.width, maxSize.height);
    const pixels = maxSide * maxSide;
    const stride = init.stride === undefined ? 1 : init.stride;
    if (!Number.isSafeInteger(stride) || stride < 1)
      throw new RangeError(`"stride" expected positive safe integer, got ${stride}`);
    const bytes = pixels * stride;
    if (!Number.isSafeInteger(bytes))
      throw new Error(`expected safe maxSide byte count, got ${maxSide}²*${stride}`);
    this.maxPixels = maxPixels;
    this.effort = init.effort === undefined ? 1 : init.effort;
    this.timeLimit = init.timeLimit === undefined ? 1000 / 60 : init.timeLimit;
    this.opts = Object.freeze({
      ...init,
      effort: this.effort,
      maxSize,
      timeLimit: this.timeLimit,
    });
    this.width = 0;
    this.height = 0;
    this.luma = new Uint8Array(bytes);
    this.image = { data: this.luma, height: 0, width: 0 };
    this.input = { data: this.luma, height: 0, width: 0 };
    const layers: ScannerLayer[] = [];
    let capacity = maxSide;
    let width = maxSize.width;
    let height = maxSize.height;
    for (let i = 0; i < 4; i++) {
      if (i && capacity < 64) break;
      const blockSide = Math.ceil(capacity / 8);
      const centers = Math.ceil(capacity / 7) ** 2;
      const luma = i ? new Uint8Array(capacity * capacity) : this.luma;
      const blocks = new Uint8Array(blockSide * blockSide);
      const cuts = new Int16Array(blockSide * blockSide);
      // Native-resolution descriptor for fine re-sampling from this layer (undefined on layer 0).
      const fine = i ? { luma: this.image, r: i } : undefined;
      layers.push({
        bitmap: new Uint32Array(Math.ceil(capacity / 32) * capacity),
        blockHeight: 0,
        blockWidth: 0,
        blocks,
        cuts,
        height: 0,
        luma,
        patternCount: 0,
        patterns: new Float64Array(centers * 4),
        used: false,
        width: 0,
        words: 0,
        plane: {
          d: luma,
          cut: cuts,
          W: width,
          H: height,
          bw: Math.ceil(width / 8),
          sh: Math.log2(8),
        },
        context: {
          opts: this.opts,
          scale: 1 << i,
          ox: 0,
          oy: 0,
          fine,
        },
        found: false,
        inverted: new Uint8Array(centers),
        setCount: 0,
        setCursor: 0,
        sets: new Float64Array(256 * 5),
        setsReady: false,
        pickSum: -1,
        pickLo: 0,
        pickHi: 0,
      });
      capacity >>= 1;
      width >>= 1;
      height >>= 1;
    }
    this.layers = layers;
  }

  // Decode corrected bytes through the shared QR payload/ECI parser; Awasm overrides this hook.
  protected decodePayload(data: Uint8Array, dataLen: number, version: number): DecodeResult {
    const decoded = Payload.decode(this.payload, data, dataLen, version, !!this.opts.textDecoder);
    return decoded instanceof Error ? decoded : Payload.finish(decoded, this.opts.textDecoder);
  }

  // Compose the square-to-output and input-to-square homographies from `from` and `to`.
  private mapQuad(out: Float64Array): void {
    squareToQuad(out, this.to);
    squareToQuad(this.to, this.from);
    adjugate(this.from, this.to);
    ptMul(out, out, this.from);
  }

  // Build the module-to-plane map from the finder-center square (BR is the alignment inset).
  private mapFinderQuad(
    out: Float64Array,
    size: number,
    t: Triple,
    brX: number,
    brY: number
  ): void {
    const c = 3.5;
    packQuad(this.from, c, c, size - c, c, size - 6.5, size - 6.5, c, size - c);
    packQuad(this.to, t.tl.x, t.tl.y, t.tr.x, t.tr.y, brX, brY, t.bl.x, t.bl.y);
    this.mapQuad(out);
  }

  // Fill the reusable alignment-position prefix for one QR version and return its length.
  private setAlignments(ver: number): number {
    if (ver === 1) return 0;
    const last = 17 + 4 * ver - 7;
    const count = Math.ceil((last - 6) / 28);
    let interval = Math.floor((last - 6) / count);
    if (interval & 1) interval++;
    else if (((last - 6) % count) * 2 >= count) interval += 2;
    const positions = this.tmp8;
    positions[0] = 6;
    for (let i = 1; i < count; i++) positions[i] = last - (count - i) * interval;
    positions[count] = last;
    return count + 1;
  }

  /** Convert one source image into the preallocated native luma layer. */
  addImage(img: Image, format: DecodeFormat | undefined = this.opts.format): void {
    copyLuma(this.luma, this.maxPixels, img, format);
    this.stage(img);
  }

  // Reset every per-image field after copied or direct-written pixels become active.
  private stage({ width, height }: Size): void {
    this.width = width;
    this.image.width = width;
    this.height = height;
    this.image.height = height;
    // Indexed loop: staging runs per frame and its for-of array iterator was the one
    // allocation escape analysis kept (V8.TFEscapeAnalysis showed 3 surviving Allocate nodes).
    let aw = width;
    let ah = height;
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i] as ScannerLayer;
      const used = !i || Math.min(aw, ah) >= 64;
      layer.used = used;
      layer.width = used ? aw : 0;
      layer.height = used ? ah : 0;
      layer.words = used ? Math.ceil(aw / 32) : 0;
      layer.blockWidth = used ? Math.ceil(aw / 8) : 0;
      layer.blockHeight = used ? Math.ceil(ah / 8) : 0;
      layer.patternCount = 0;
      layer.plane.W = layer.width;
      layer.plane.H = layer.height;
      layer.plane.bw = layer.blockWidth;
      layer.context.ox = 0;
      layer.context.oy = 0;
      layer.found = false;
      layer.setCount = 0;
      layer.setCursor = 0;
      layer.setsReady = false;
      layer.pickSum = -1;
      aw >>= 1;
      ah >>= 1;
    }
    this.staged = true;
    this.resized = false;
    this.blocked = 0;
    this.retryStart = 0;
    this.retries = 0;
  }

  clean(): void {
    this.payload.position = 0;
    this.payload.bytes.fill(0);
    // Lifecycle wipe, not per-frame: every typed-array field on the scanner and its layers is
    // a zero-target arena, so sweep them reflectively — new arenas cannot be forgotten here.
    // Object.values allocates; acceptable outside the frame loop. Layer zero's luma aliases
    // the scanner's, so the double fill is harmless.
    for (const v of Object.values(this)) if (ArrayBuffer.isView(v)) (v as Uint8Array).fill(0);
    for (const layer of this.layers as ScannerLayer[]) {
      for (const v of Object.values(layer)) if (ArrayBuffer.isView(v)) (v as Uint8Array).fill(0);
      layer.blockHeight = 0;
      layer.blockWidth = 0;
      layer.height = 0;
      layer.width = 0;
      layer.words = 0;
      layer.patternCount = 0;
      layer.setCount = 0;
      layer.setCursor = 0;
      layer.used = false;
      layer.found = false;
      layer.setsReady = false;
    }
    this.width = 0;
    this.image.width = 0;
    this.height = 0;
    this.image.height = 0;
    this.staged = false;
    this.resized = false;
    this.blocked = 0;
    this.points = undefined;
  }

  /** Process pixels that an integration wrote directly into {@link luma}. */
  processImage(
    size: Size,
    format: DecodeFormat = 'I420',
    layout: _QRLayout = { offset: 0, stride: size.width * (inputFormat(format)?.step || 0) }
  ): void {
    this.input.width = size.width;
    this.input.height = size.height;
    copyLuma(this.luma, this.maxPixels, this.input, format, layout);
    this.stage(size);
  }

  // Project a module center, then classify its source pixel against the owning threshold block.
  private read(s: Plane, map: Float64Array, mx: number, my: number): number {
    const point = mapPoint(map, mx, my);
    // Module coordinates describe cell centers; floor maps projected boundary
    // values to the containing source pixel instead of crossing into its neighbor.
    const px = Math.floor(point.x);
    const py = Math.floor(point.y);
    if (px < 0 || py < 0 || px >= s.W || py >= s.H) return 0;
    const dark = s.d[py * s.W + px] <= s.cut[(py >> s.sh) * s.bw + (px >> s.sh)];
    return dark !== this.invertedProjection ? 1 : 0;
  }

  // Recover the fourth corner of a projective finder square from its three local pitches.
  private perspective(t: Triple, p0: number, p1: number, p2: number) {
    const { tl, tr, bl } = t;
    // Under a homography local pitch changes with the inverse 3/2 power of
    // its denominator, so the 2/3 pitch ratio recovers each corner weight.
    const wx = Math.cbrt(p0 / p1) ** 2;
    const wy = Math.cbrt(p0 / p2) ** 2;
    const cornerDen = wx + wy - 1;
    if (!cornerDen) return false;
    const brX = (wx * tr.x + wy * bl.x - tl.x) / cornerDen;
    const brY = (wx * tr.y + wy * bl.y - tl.y) / cornerDen;
    const dx3 = tl.x - tr.x + brX - bl.x;
    const dy3 = tl.y - tr.y + brY - bl.y;
    // The projective body is squareToQuad on (tl,tr,br,bl); keep the den!=0 guard the shared
    // helper omits (it would divide by zero where this caller must report failure instead).
    if ((dx3 || dy3) && !((tr.x - brX) * (bl.y - brY) - (bl.x - brX) * (tr.y - brY))) return false;
    packQuad(this.to, tl.x, tl.y, tr.x, tr.y, brX, brY, bl.x, bl.y);
    squareToQuad(this.map, this.to);
    return true;
  }

  // Best 5x5-template placement on a 7x7 offset lattice around (bx,by): offsets are sx*mul
  // (grid: half-module steps, ties broken toward the smallest offset; perspective: unit
  // steps — the c6 doubled pixel offsets -6..6 step 2 pre-divided — first best wins).
  private searchAlign(
    s: Plane,
    map: Float64Array,
    scale: number,
    side: number,
    bx: number,
    by: number,
    mul: number,
    tie: boolean
  ): boolean {
    let bestX = 0;
    let bestY = 0;
    let bestErrors = tie ? Infinity : 5 + 1;
    for (let sy = -3; sy <= 3; sy++)
      for (let sx = -3; sx <= 3; sx++) {
        const dx = sx * mul;
        const dy = sy * mul;
        const cap = bestErrors + +tie;
        // Count capped 5x5 alignment-template mismatches at this mapped module offset.
        let errors = 0;
        for (let y = -2; y <= 2 && errors < cap; y++)
          for (let x = -2; x <= 2; x++) {
            const dark = !!this.read(
              s,
              map,
              scale + (bx + dx + x) / side,
              scale + (by + dy + y) / side
            );
            const edge = Math.abs(x) === 2 || Math.abs(y) === 2;
            if (dark !== (edge || (x === 0 && y === 0)) && ++errors >= cap) break;
          }
        if (errors > bestErrors || (!tie && errors === bestErrors)) continue;
        if (errors === bestErrors && dx * dx + dy * dy >= bestX * bestX + bestY * bestY) continue;
        bestX = dx;
        bestY = dy;
        bestErrors = errors;
      }
    if (bestErrors > 5) return false;
    const p = mapPoint(map, scale + (bx + bestX) / side, scale + (by + bestY) / side);
    this.alignPoint.x = p.x;
    this.alignPoint.y = p.y;
    return true;
  }

  // Test whether a finder lies inside an affine QR region already decoded on any pyramid layer.
  private excluded(layer: ScannerLayer, index: number): boolean {
    if (!this.blocked) return false;
    const scale = layer.context.scale;
    const offset = (scale - 1) / 2;
    const pos = 4 * index;
    const x = scale * layer.patterns[pos] + offset;
    const y = scale * layer.patterns[pos + 1] + offset;
    for (const source of this.layers as ScannerLayer[]) {
      if (!source.found) continue;
      const sourceScale = source.context.scale;
      const sourceOffset = (sourceScale - 1) / 2;
      const s = source.patterns;
      for (let i = 0; i < source.patternCount; i++) {
        const state = source.inverted[i];
        if (!(state & 2)) continue;
        if (!(state & 4)) continue;
        const tl = 4 * i;
        const tr = 4 * s[tl + 2];
        const bl = 4 * s[tl + 3];
        const ux = sourceScale * (s[tr] - s[tl]);
        const uy = sourceScale * (s[tr + 1] - s[tl + 1]);
        const vx = sourceScale * (s[bl] - s[tl]);
        const vy = sourceScale * (s[bl + 1] - s[tl + 1]);
        const determinant = ux * vy - uy * vx;
        const dx = x - (sourceScale * s[tl] + sourceOffset);
        const dy = y - (sourceScale * s[tl + 1] + sourceOffset);
        const across = (dx * vy - dy * vx) / determinant;
        const down = (dy * ux - dx * uy) / determinant;
        const padding = s[tr + 2];
        if (across >= -padding && across <= 1 + padding && down >= -padding && down <= 1 + padding)
          return true;
      }
    }
    return false;
  }

  // Mark this layer's finders that fall inside any already decoded QR region.
  private exclude(layer: ScannerLayer): void {
    for (let i = 0; i < layer.patternCount; i++) {
      if (layer.inverted[i] & 2 || !this.excluded(layer, i)) continue;
      layer.inverted[i] |= 2;
      this.blocked++;
    }
  }

  // Bounded candidate retention is identical for mandatory and retry selection; they differ only
  // in their rank expression and capacity. Equal ranks keep the earlier slot.
  private retain(index: number, rank: number, count: number, capacity: number, offset = 0): number {
    const ranks = this.tmp64;
    if (count < capacity) {
      this.tmp32[count] = index;
      ranks[offset + count] = rank;
      return count + 1;
    }
    let worst = 0;
    for (let i = 1; i < count; i++) if (ranks[offset + worst] < ranks[offset + i]) worst = i;
    if (rank >= ranks[offset + worst]) return count;
    this.tmp32[worst] = index;
    ranks[offset + worst] = rank;
    return count;
  }

  // Assign three finder records to TL/TR/BL by longest side, then enforce clockwise orientation.
  private makeTriple(layer: ScannerLayer, i0: number, i1: number, i2: number) {
    const pts = layer.patterns;
    const p0 = i0 * 4;
    const p1 = i1 * 4;
    const p2 = i2 * 4;
    const d01 = dist2(pts, p0, p1);
    const d12 = dist2(pts, p1, p2);
    const d02 = dist2(pts, p0, p2);
    let tl = i2;
    let bl = i0;
    let tr = i1;
    if (d12 >= d01 && d12 >= d02) {
      tl = i0;
      bl = i1;
      tr = i2;
    } else if (d02 >= d12 && d02 >= d01) {
      tl = i1;
      bl = i0;
      tr = i2;
    }
    copyPattern(layer, tl, this.triple.tl);
    copyPattern(layer, bl, this.triple.bl);
    copyPattern(layer, tr, this.triple.tr);
    const { tl: topLeft, tr: topRight, bl: bottomLeft } = this.triple;
    if (
      (topRight.x - topLeft.x) * (bottomLeft.y - topLeft.y) -
        (topRight.y - topLeft.y) * (bottomLeft.x - topLeft.x) <
      0
    ) {
      // The copies are untouched since copyPattern, so swapping roles is a re-copy from the
      // swapped source records — no scratch pattern needed.
      const index = tr;
      tr = bl;
      bl = index;
      copyPattern(layer, tr, topRight);
      copyPattern(layer, bl, bottomLeft);
    }
    this.triple.tlIndex = tl;
    this.triple.trIndex = tr;
    this.triple.blIndex = bl;
    return this.triple;
  }

  // Best triple of one polarity for the mandatory attempt, into tmp64[polarity * 4..] as
  // (i0, i1, i2, relative error). Raw error rejects square cross-symbol mixes in dense grids;
  // sparse scenes use relative error minus row confidence to reject small data pseudo-squares.
  private pickPolarity(layer: ScannerLayer, polarity: number): boolean {
    const pts = layer.patterns;
    const candidates = this.tmp32;
    let confirmed = 0;
    for (let i = 0; i < layer.patternCount; i++) {
      const state = layer.inverted[i];
      if ((state & 1) !== polarity || state & 2) continue;
      if (pts[i * 4 + 3] >= 2) confirmed++;
    }
    // Once three centers exist, require two row hits to reject one-row data patterns.
    const minimum = confirmed >= 3 ? 2 : 1;
    let count = 0;
    for (let i = 0; i < layer.patternCount; i++) {
      const state = layer.inverted[i];
      if ((state & 1) !== polarity || state & 2) continue;
      const confidence = pts[i * 4 + 3];
      if (confidence < minimum) continue;
      // Retain the strongest 16 centers per polarity to keep cubic geometry bounded.
      count = this.retain(i, -confidence, count, 16, 8);
    }
    if (count < 3) return false;
    // Cache the nearest scale-consistent upper-layer centers. Without this rescue, perspective
    // squeeze made the module-ratio gate lose 46 of 168 perspective decodes.
    const found = this.tmp32;
    found.fill(0, 16);
    const lowerIndex = this.layers.indexOf(layer);
    for (let upperIndex = lowerIndex + 1; upperIndex < this.layers.length; upperIndex++) {
      const upper = this.layers[upperIndex] as ScannerLayer;
      if (!upper.used || !upper.found) continue;
      const scale = upper.context.scale / layer.context.scale;
      const offset = (scale - 1) / 2;
      for (let slot = 0; slot < count; slot++) {
        const at = 4 * candidates[slot];
        const ms = pts[at + 2];
        let b0 = -1;
        let b1 = -1;
        let b2 = -1;
        let d0 = Infinity;
        let d1 = Infinity;
        let d2 = Infinity;
        for (let i = 0; i < upper.patternCount; i++) {
          if ((upper.inverted[i] & 1) !== polarity) continue;
          if (upper.inverted[i] & 2) continue;
          const pos = 4 * i;
          const mappedMs = scale * upper.patterns[pos + 2];
          const smallest = Math.min(ms, mappedMs);
          const largest = Math.max(ms, mappedMs);
          // Reject unrelated scales above 2:1; this and the distance gate added +27/-0 rasters.
          if (largest > 2 * smallest) continue;
          const dx = scale * upper.patterns[pos] + offset - pts[at];
          const dy = scale * upper.patterns[pos + 1] + offset - pts[at + 1];
          const distance = dx * dx + dy * dy;
          if (distance >= 4 * largest ** 2 || distance >= d2) continue;
          if (distance < d0) {
            b2 = b1;
            d2 = d1;
            b1 = b0;
            d1 = d0;
            b0 = i;
            d0 = distance;
          } else if (distance < d1) {
            b2 = b1;
            d2 = d1;
            b1 = i;
            d1 = distance;
          } else {
            b2 = i;
            d2 = distance;
          }
        }
        const base = 16 + (upperIndex * 16 + slot) * 3;
        found[base] = b0 + 1;
        found[base + 1] = b1 + 1;
        found[base + 2] = b2 + 1;
      }
    }
    // 1.4 is the zero-loss ambiguous-set choice; isolated 1.8 retained all 7,178 rasters.
    const moduleRatioMax = count === 3 ? 1.8 : 1.4;
    let best0 = -1;
    let best1 = -1;
    let best2 = -1;
    let bestScale = 0;
    let bestScore = Infinity;
    let bestConfidence = 0;
    let rankedScore = Infinity;
    let rankedConfidence = 0;
    let ranked0 = -1;
    let ranked1 = -1;
    let ranked2 = -1;
    let rankedRelative = Infinity;
    for (let i = 0; i < count - 2; i++) {
      const i0 = candidates[i];
      const p0 = i0 * 4;
      for (let j = i + 1; j < count - 1; j++) {
        const i1 = candidates[j];
        const p1 = i1 * 4;
        const d01 = dist2(pts, p0, p1);
        for (let k = j + 1; k < count; k++) {
          const i2 = candidates[k];
          const p2 = i2 * 4;
          const minMs = Math.min(pts[p0 + 2], pts[p1 + 2], pts[p2 + 2]);
          const maxMs = Math.max(pts[p0 + 2], pts[p1 + 2], pts[p2 + 2]);
          const nativeConfidence = Math.min(pts[p0 + 3], pts[p1 + 3], pts[p2 + 3]);
          if (
            maxMs > moduleRatioMax * minMs &&
            // The measured sparse ambiguity has eight eligible centers.
            (count !== 8 || nativeConfidence < 4)
          ) {
            let matched = false;
            // Check whether an upper layer confirms all three slots with distinct centers.
            upper: for (
              let upperIndex = lowerIndex + 1;
              upperIndex < this.layers.length;
              upperIndex++
            ) {
              let first = 0;
              let second = 0;
              for (let role = 0; role < 3; role++) {
                const slot = role ? (role === 1 ? j : k) : i;
                const base = 16 + (upperIndex * 16 + slot) * 3;
                let selected = 0;
                for (let rank = 0; rank < 3; rank++) {
                  const candidate = found[base + rank];
                  if (!candidate || candidate === first || candidate === second) continue;
                  selected = candidate;
                  break;
                }
                if (!selected) continue upper;
                if (!role) first = selected;
                else if (role === 1) second = selected;
              }
              matched = true;
              break;
            }
            if (!matched) continue;
          }
          const d12 = dist2(pts, p1, p2);
          const d02 = dist2(pts, p0, p2);
          const a = Math.min(d01, d12, d02);
          const c = Math.max(d01, d12, d02);
          const b = d01 + d12 + d02 - a - c;
          const geometry = Math.abs(c - 2 * b) + Math.abs(c - 2 * a);
          const confidence = pts[p0 + 3] + pts[p1 + 3] + pts[p2 + 3];
          if (geometry < bestScore) {
            bestScore = geometry;
            bestScale = c;
            bestConfidence = confidence;
            best0 = i0;
            best1 = i1;
            best2 = i2;
          }
          if (count > 8) continue;
          // A small row-hit weight breaks near-equal geometry scores toward stronger evidence.
          const score = geometry / c - 0.01 * confidence;
          if (score >= rankedScore) continue;
          rankedScore = score;
          rankedConfidence = confidence;
          rankedRelative = geometry / c;
          ranked0 = i0;
          ranked1 = i1;
          ranked2 = i2;
        }
      }
    }
    if (best0 < 0) return false;
    let relative = bestScore / bestScale;
    // Small candidate sets describe one symbol; crowded scenes keep raw geometry
    // so finder centers from adjacent symbols cannot be mixed.
    if (
      (count <= 7 &&
        // 0.08..0.12 isolates the measured ambiguous-triplet band.
        relative >= 0.08 &&
        relative <= 0.12) ||
      (count > 7 &&
        count <= 8 &&
        rankedConfidence >= 2 * bestConfidence &&
        rankedConfidence <= 4 * bestConfidence)
    ) {
      best0 = ranked0;
      best1 = ranked1;
      best2 = ranked2;
      relative = rankedRelative;
    }
    const base = polarity * 4;
    const state = this.tmp64;
    state[base] = best0;
    state[base + 1] = best1;
    state[base + 2] = best2;
    state[base + 3] = relative;
    return true;
  }

  // Reject wrong triples/dimensions from their alternating timing tracks before full sampling.
  private timing(s: Plane, map: Float64Array, size: number): boolean {
    // Require 75% agreement across the horizontal and vertical tracks.
    let gh = 0;
    let gv = 0;
    let n = 0;
    const N = size - 2 * 8;
    const track = 6 + 0.5;
    for (let i = 8; i < size - 8; i++) {
      const c = i + 0.5;
      const e = 1 - (i & 1);
      if (this.read(s, map, c, track) === e) gh++;
      if (this.read(s, map, track, c) === e) gv++;
      n++;
      // A wrong triple or dimension reads timing noise and dies before the
      // size² projection and Reed-Solomon work.
      if (100 * (gh + gv + 2 * (N - n)) < 150 * N && gh !== n && gv !== n) return false;
    }
    return 100 * (gh + gv) >= 150 * N || gh === N || gv === N;
  }

  // Search a window around the expected bottom-right alignment pattern center for a dark run
  // of ~1 module flanked by light, cross-checked vertically. Alignment detection is finder
  // detection with a [1] pattern instead of 1:1:3:1:1, so it shares run(); keep the layer explicit
  // because this search reads the native bitmap even when projection later samples a fine plane.
  private findBasicAlign(layer: ScannerLayer, ex: number, ey: number, ms: number): boolean {
    const R = Math.max(Math.round(5 * ms), 8);
    let found = false;
    let bestD = Infinity;
    const yLo = Math.max(1, Math.round(ey - R));
    const yHi = Math.min(layer.height - 2, Math.round(ey + R));
    const xLo = Math.max(1, Math.round(ex - R));
    const xHi = Math.min(layer.width - 2, Math.round(ex + R));
    const dark = +!this.invertedProjection;
    // Integer cap: run() counts at most cap+1 bits, reproducing the historical while-loop's
    // ceil(3 * ms) maximum for integer and fractional pitches alike.
    const capV = Math.ceil(3 * ms) - 1;
    for (let y = yLo; y <= yHi; y++) {
      // A dark run continuing from before the window is not a start; skip past it first.
      let x = xLo;
      if (bit(layer, x - 1, y) === dark) x += run(layer, x, y, 1, 0, dark, Infinity);
      while (x <= xHi) {
        x += run(layer, x, y, 1, 0, 1 - dark, Infinity);
        if (x > xHi) break;
        // Cap xHi + 1 - x truncates like the historical end <= xHi + 1 scan bound.
        const w = run(layer, x, y, 1, 0, dark, xHi + 1 - x);
        const cx = x + w / 2;
        const cxi = Math.round(cx);
        x += w + 1; // rejected runs contain no starts; the pixel after a full run is light
        if (w < 0.4 * ms || w > 2.5 * ms) continue;
        const up = run(layer, cxi, y - 1, 0, -1, dark, capV);
        const down = run(layer, cxi, y + 1, 0, 1, dark, capV);
        const h = up + down + 1;
        if (h < 0.4 * ms || h > 2.5 * ms) continue;
        const cy = y - up + h / 2;
        const dist = (cx - ex) * (cx - ex) + (cy - ey) * (cy - ey);
        if (dist < bestD) {
          bestD = dist;
          found = true;
          this.alignPoint.x = cx;
          this.alignPoint.y = cy;
        }
      }
    }
    return found;
  }

  // Map detected geometry into caller coordinates and cache the one terminal callback payload.
  private report(
    t: Triple,
    br: Point,
    aligners: LocatedAligner[],
    ms: number,
    size: number,
    ctx: Ctx
  ): void {
    if (!ctx.opts.pointsOnDetect) return;
    const { tl, tr, bl } = t;
    const { scale, ox, oy } = ctx;
    const pt = (point: Point, moduleSize?: number) => {
      const mapped: Point & { moduleSize?: number } = {
        x: point.x * scale + ox,
        y: point.y * scale + oy,
      };
      if (moduleSize !== undefined) mapped.moduleSize = moduleSize * scale;
      return mapped;
    };
    // The located alignment center is inset from the fourth finder position.
    // Keep it in `aligners`, while BR completes the logical finder-center
    // square through the same homography used to sample the symbol.
    const map = this.map;
    this.mapFinderQuad(map, size, t, br.x, br.y);
    const project = (x: number, y: number) => pt(mapPoint(map, x, y));
    const quad = (left: number, top: number, right: number, bottom: number): Quad => [
      project(left, top),
      project(right, top),
      project(right, bottom),
      project(left, bottom),
    ];
    const marker = (point: Point, moduleSize: number, x: number, y: number, radius: number) => {
      const center = pt(point, moduleSize) as Point & { moduleSize: number };
      const expected = project(x, y);
      const corners = quad(x - radius, y - radius, x + radius, y + radius);
      // Tiled high-version alignment searches can move a center away from the
      // global homography; retain that local correction for its marker too.
      const dx = center.x - expected.x;
      const dy = center.y - expected.y;
      if (dx || dy)
        for (const corner of corners) {
          corner.x += dx;
          corner.y += dy;
        }
      return { ...center, corners };
    };
    const c = 3.5;
    const pad = 1; // Keep overlays one module outside the sampled symbol.
    const bounds = quad(0, 0, size, size);
    const xs = bounds.map((point) => point.x);
    const ys = bounds.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    this.points = {
      tl: marker(tl, tl.ms, c, c, c),
      tr: marker(tr, tr.ms, size - c, c, c),
      br: project(size - c, size - c),
      bl: marker(bl, bl.ms, c, size - c, c),
      aligners: aligners.map(({ point, x, y }) => marker(point, ms, x, y, 5 / 2)),
      bounds,
      outline: quad(-pad, -pad, size + pad, size + pad),
      boundingBox: {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      },
    };
  }

  // Retarget a coarse-layer homography and threshold grid to its native-resolution luma.
  private upgrade(p: Plane, map: Float64Array, ctx: Ctx): number {
    const fine = ctx.fine;
    if (!fine) return 0;
    const sc = 1 << fine.r;
    const off = (sc - 1) / 2;
    // A layer pixel x sits at 2^r*x + (2^r-1)/2 in native coordinates.
    const scaled = this.to;
    for (let i = 0; i < 6; i++) scaled[i] = sc * map[i] + off * map[6 + (i % 3)];
    scaled[6] = map[6];
    scaled[7] = map[7];
    scaled[8] = map[8];
    const plane = this.finePlane;
    const sh = p.sh + fine.r;
    plane.d = fine.luma.data;
    plane.cut = p.cut;
    plane.W = Math.min(fine.luma.width, p.bw << sh);
    plane.H = Math.min(fine.luma.height, ((p.cut.length / p.bw) | 0) << sh);
    plane.bw = p.bw;
    plane.sh = sh;
    return sc;
  }

  // Parse format/function bits, deinterleave and correct codewords, then decode the payload.
  private decodeGrid(size: number, _ctx: Ctx): Attempt {
    let decoded: Attempt = FAIL.format;
    if (!checkVersion(this.grid, size)) decoded = FAIL.version;
    else {
      const m = this.grid;
      let f1 = 0;
      let f2 = 0;
      for (let i = 0; i < 15; i++) {
        const b1 =
          i < 6
            ? m[i * size + 8]
            : i < 8
              ? m[(i + 1) * size + 8]
              : i === 8
                ? m[8 * size + 7]
                : m[8 * size + 14 - i];
        const b2 = i < 8 ? m[8 * size + size - 1 - i] : m[(size - 15 + i) * size + 8];
        f1 |= b1 << i;
        f2 |= b2 << i;
      }
      // Last in-radius (ecc,mask) wins per copy, matching the original overwrite scan.
      let aEcc = -1;
      let bEcc = -1;
      let aMask = 0;
      let bMask = 0;
      let aDistance = 0;
      let bDistance = 0;
      for (let ecc = 0; ecc < ECC_LEVELS.length; ecc++)
        for (let mask = 0; mask < 8; mask++) {
          const bits = formatBits(ECC_LEVELS[ecc], mask);
          const d1 = popcnt(bits ^ f1);
          const d2 = popcnt(bits ^ f2);
          if (d1 <= 3) {
            aEcc = ecc;
            aMask = mask;
            aDistance = d1;
          }
          if (d2 <= 3) {
            bEcc = ecc;
            bMask = mask;
            bDistance = d2;
          }
        }
      const same = aEcc === bEcc && aMask === bMask;
      // Store copy B first when it is the only candidate or strictly closer.
      const firstB = bEcc >= 0 && (aEcc < 0 || (!same && bDistance < aDistance));
      const aFormat = aEcc < 0 ? -1 : (aEcc << 3) | aMask;
      const bFormat = bEcc < 0 ? -1 : (bEcc << 3) | bMask;
      const first = firstB ? bFormat : aFormat;
      const second = firstB ? aFormat : bEcc >= 0 && !same ? bFormat : -1;
      for (let formatValue = first; formatValue >= 0;) {
        format: {
          const eccIndex = formatValue >> 3;
          const mask = formatValue & 7;
          const ver = (size - 17) / 4;
          const fun = this.tmp8;
          fun.fill(0, 0, size * size);
          for (let finder = 0; finder < 3; finder++) {
            const fx = finder === 1 ? size - 7 : 0;
            const fy = finder === 2 ? size - 7 : 0;
            for (let dy = -1; dy < 8; dy++)
              for (let dx = -1; dx < 8; dx++) {
                const x = fx + dx;
                const y = fy + dy;
                if (x >= 0 && y >= 0 && x < size && y < size) fun[y * size + x] = 1;
              }
          }
          const count = this.setAlignments(ver);
          const align = this.tmp8;
          for (let yi = 0; yi < count; yi++)
            for (let xi = 0; xi < count; xi++) {
              const ax = align[xi];
              const ay = align[yi];
              if (fun[ay * size + ax]) continue;
              for (let dy = -2; dy <= 2; dy++)
                for (let dx = -2; dx <= 2; dx++) fun[(ay + dy) * size + ax + dx] = 1;
            }
          for (let i = 0; i < size; i++) {
            fun[6 * size + i] = 1;
            fun[i * size + 6] = 1;
          }
          for (let i = 0; i <= 8; i++) {
            fun[i * size + 8] = 1;
            fun[8 * size + i] = 1;
            if (i < 8) {
              fun[8 * size + size - 1 - i] = 1;
              fun[(size - 1 - i) * size + 8] = 1;
            }
          }
          if (ver >= 7)
            for (let i = 0; i < 18; i++) {
              const x = size - 11 + (i % 3);
              const y = (i / 3) | 0;
              fun[y * size + x] = 1;
              fun[x * size + y] = 1;
            }
          const bytes = this.codewords;
          const total = BYTES[ver - 1];
          bytes.fill(0, 0, total);
          let bit = 0;
          let dir = -1;
          let y = size - 1;
          for (let xOffset = size - 1; xOffset > 0; xOffset -= 2) {
            if (xOffset === 6) xOffset = 6 - 1;
            for (;;) {
              for (let j = 0; j < 2; j++) {
                const x = xOffset - j;
                if (fun[y * size + x]) continue;
                if (
                  bit < 8 * total &&
                  (this.grid[y * size + x] ^ ((maskBits(x, y) >> mask) & 1)) === 1
                )
                  bytes[bit >> 3] |= 0x80 >> (bit & 7);
                bit++;
              }
              if (y + dir < 0 || y + dir >= size) break;
              y += dir;
            }
            dir = -dir;
          }
          const ecc = ECC_LEVELS[eccIndex];
          const words = WORDS_PER_BLOCK[ecc][ver - 1];
          const blocks = ECC_BLOCKS[ecc][ver - 1];
          const shortLen = Math.floor(total / blocks) - words;
          const shortBlocks = blocks - (total % blocks);
          // Extraction is tmp8's final function-map read. Derived block lengths/offsets stay
          // scalar; its prefix holds RS polynomials and its dead tail holds deinterleaved blocks.
          const syndromes = 0;
          const sigma = words;
          const previous = 2 * words + 1;
          const next = 3 * words + 2;
          const blockBase = 4 * words + 3;
          const blockLen = shortLen + words;
          const blockBytes = fun;
          let pos = 0;
          // QR interleaving writes every data column before every ECC column; both share the same
          // block walk, with only the column count and destination base changing by phase.
          for (let ecc = 0; ecc < 2; ecc++)
            for (let i = 0; i < (ecc ? words : shortLen + 1); i++)
              for (let block = 0; block < blocks; block++) {
                const length = blockLen + +(block >= shortBlocks);
                if (!ecc && i >= length - words) continue;
                const offset = blockBase + block * blockLen + Math.max(0, block - shortBlocks);
                blockBytes[offset + (ecc ? length - words : 0) + i] = bytes[pos++];
              }
          const dataLen = total - words * blocks;
          // Deinterleaving has copied every codeword into blockBytes, so corrected payload bytes
          // can replace the now-dead interleaved stream in the same arena.
          const data = bytes;
          pos = 0;
          for (let block = 0; block < blocks; block++) {
            const offset = blockBase + block * blockLen + Math.max(0, block - shortBlocks);
            const length = blockLen + +(block >= shortBlocks);
            let corrected = false;
            correct: {
              // Byte offsets in tmp8: syndromes, sigma, previous, and next. All four are live
              // during Berlekamp-Massey; previous/next become omega/locations afterward.
              let hasError = false;
              for (let i = 0; i < words; i++) {
                let value = 0;
                for (let j = 0; j < length; j++)
                  value = mul(value, EXP[i]) ^ blockBytes[offset + j];
                fun[syndromes + i] = value;
                if (value) hasError = true;
              }
              if (!hasError) {
                corrected = true;
                break correct;
              }
              fun.fill(0, sigma, sigma + words + 1);
              fun.fill(0, previous, previous + words + 1);
              fun[sigma] = 1;
              fun[previous] = 1;
              let sigmaLength = 1;
              let previousLength = 1;
              let degree = 0;
              let shift = 1;
              let discrepancy = 1;
              for (let n = 0; n < words; n++) {
                let delta = fun[syndromes + n];
                for (let i = 1; i <= degree; i++)
                  delta ^= mul(fun[sigma + i], fun[syndromes + n - i]);
                if (!delta) {
                  shift++;
                  continue;
                }
                const coefficient = mul(delta, inv(discrepancy));
                // The copy loops overwrite every exposed slot in [0, nextLength).
                const nextLength = Math.max(sigmaLength, previousLength + shift);
                for (let i = 0; i < nextLength; i++)
                  fun[next + i] =
                    (i < sigmaLength ? fun[sigma + i] : 0) ^
                    (i >= shift && i - shift < previousLength
                      ? mul(coefficient, fun[previous + i - shift])
                      : 0);
                if (2 * degree <= n) {
                  fun.copyWithin(previous, sigma, sigma + sigmaLength);
                  previousLength = sigmaLength;
                  degree = n + 1 - degree;
                  discrepancy = delta;
                  shift = 1;
                } else shift++;
                fun.copyWithin(sigma, next, next + nextLength);
                sigmaLength = nextLength;
              }
              while (sigmaLength > 1 && !fun[sigma + sigmaLength - 1]) sigmaLength--;
              const errors = sigmaLength - 1;
              if (!errors || 2 * errors > words) break correct;
              // Berlekamp-Massey no longer needs its previous/next polynomials. Reuse them for the
              // simultaneously live evaluator and error-location arrays instead of retaining two.
              const omega = previous;
              fun.fill(0, omega, omega + words);
              for (let i = 0; i < sigmaLength; i++)
                for (let j = 0; i + j < words; j++)
                  fun[omega + i + j] ^= mul(fun[sigma + i], fun[syndromes + j]);
              const locations = next;
              let locationCount = 0;
              for (let i = 1; i < 256 && locationCount < errors; i++)
                if (!evalLow(fun, sigma, sigmaLength, i)) fun[locations + locationCount++] = inv(i);
              if (locationCount !== errors) break correct;
              for (let i = 0; i < locationCount; i++) {
                const location = fun[locations + i];
                const blockPos = length - 1 - LOG[location];
                if (blockPos < 0) break correct;
                const inverse = inv(location);
                let denominator = 1;
                for (let j = 0; j < locationCount; j++)
                  if (i !== j) denominator = mul(denominator, 1 ^ mul(fun[locations + j], inverse));
                blockBytes[offset + blockPos] ^= mul(
                  evalLow(fun, omega, words, inverse),
                  inv(denominator)
                );
              }
              corrected = true;
            }
            if (!corrected) {
              decoded = FAIL.rs;
              break format;
            }
            const end = offset + length - words;
            for (let i = offset; i < end; i++) data[pos++] = blockBytes[i];
          }
          decoded = this.decodePayload(data, dataLen, ver);
        }
        if (!(decoded instanceof Error)) break;
        formatValue = formatValue === first ? second : -1;
      }
    }
    return decoded;
  }

  // Project one global symbol or one alignment-lattice tile directly into
  // the scanner-owned maximum-version grid; adjacent tile regions never overlap.
  private projectQuad(
    s: Plane,
    map: Float64Array,
    size: number,
    left = 0,
    right = size,
    top = 0,
    bottom = size
  ): void {
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) {
        this.grid[y * size + x] = this.read(s, map, x + 0.5, y + 0.5);
      }
  }

  // Timing prefilter + global grid projection against one plane.
  private projectMap(s: Plane, map: Float64Array, size: number, ctx: Ctx): Attempt {
    const ok = this.timing(s, map, size);
    if (ok) this.projectQuad(s, map, size);
    return ok ? this.decodeGrid(size, ctx) : FAIL.timing;
  }

  // Sample only timing and redundant version bits to gate expensive Version 7+ tiled projection.
  private confirm(s: Plane, map: Float64Array, size: number): boolean {
    let ok = this.timing(s, map, size);
    if (ok) {
      for (let i = 0; i < 18; i++) {
        const x = size - 11 + (i % 3);
        const y = (i / 3) | 0;
        this.grid[y * size + x] = this.read(s, map, x + 0.5, y + 0.5);
        this.grid[x * size + y] = this.read(s, map, y + 0.5, x + 0.5);
      }
      ok = checkVersion(this.grid, size);
    }
    return ok;
  }

  // One path for both polarities: inverted sampling flips read() and the aligner's dark color;
  // perspective state is cleared after every value-returning projection path.
  private projectWith(layer: ScannerLayer, triple: ScannerTriple, pitch: number): Attempt {
    const inverted = triple.inverted;
    this.invertedProjection = inverted;
    const p = layer.plane;
    const t = triple;
    const ctx = layer.context;
    let failed: Attempt = FAIL.dimension;
    project: {
      const { tl, tr, bl } = t;
      const ms = (tl.ms + tr.ms + bl.ms) / 3;
      const minMs = Math.min(tl.ms, tr.ms, bl.ms);
      const maxMs = Math.max(tl.ms, tr.ms, bl.ms);
      // Perspective changes apparent pitch across finders; use the matching edge's
      // endpoint pitches only when that variation is material.
      const ax = tr.x - tl.x;
      const ay = tr.y - tl.y;
      const bx = bl.x - tl.x;
      const by = bl.y - tl.y;
      const area = Math.abs(ax * by - ay * bx);
      const span = Math.max(Math.abs(ay), Math.abs(by));
      const medianMs = tl.ms + tr.ms + bl.ms - minMs - maxMs;
      const medianEst = span > 0 && medianMs > 0 ? area / (span * medianMs) + 7 : Infinity;
      const length = distance(tl, tr);
      const est = pitch
        ? length / pitch + 7
        : // 1.105, 10/9, 1.125, and 1.15 were tested; 10/9 is the best gain plateau.
          maxMs > (10 / 9) * minMs
          ? (length * 2) / (tl.ms + tr.ms) + 7
          : medianEst;
      const snapped = snapSize(est);
      const meanEst = span > 0 && ms > 0 ? area / (span * ms) + 7 : Infinity;
      const mean = snapSize(meanEst);
      // Module-size estimates drift under rotation and blur; try the neighbor
      // dimensions before giving up on the triple.
      for (let i = 0; i < 4; i++) {
        const size = i === 0 ? snapped : i === 1 ? mean : i === 2 ? snapped - 4 : snapped + 4;
        const estimate = i === 1 ? meanEst : est;
        if ((i > 0 && size === snapped) || (i > 1 && size === mean)) continue;
        if (
          size < 21 ||
          size > 177 ||
          // Reject estimates more than six modules from their snapped QR size.
          Math.abs(size - estimate) > 6
        )
          continue;
        this.decodedSize = size;
        // A located bottom-right alignment pattern upgrades the affine BR estimate to perspective.
        const f = 1 - (3.5 - 0.5) / (size - 7);
        const brEstX = tl.x + (tr.x - tl.x + bl.x - tl.x) * f;
        const brEstY = tl.y + (tr.y - tl.y + bl.y - tl.y) * f;
        let found = false;
        if (size >= 21 + 4) {
          if (inverted || !this.perspective(t, t.tl.ms, t.tr.ms, t.bl.ms))
            found = this.findBasicAlign(layer, brEstX, brEstY, ms);
          else {
            const ax = tr.x + bl.x - 2 * tl.x;
            const ay = tr.y + bl.y - 2 * tl.y;
            const scale = (ax * (brEstX - tl.x) + ay * (brEstY - tl.y)) / (ax * ax + ay * ay);
            const map = this.map;
            const predictedDen = (map[6] + map[7]) * scale + map[8];
            const dx = ((map[0] + map[1]) * scale + map[2]) / predictedDen - brEstX;
            const dy = ((map[3] + map[4]) * scale + map[5]) / predictedDen - brEstY;
            // Treat disagreement within three modules as measurement noise.
            if (dx * dx + dy * dy <= 9 * ms * ms)
              found = this.findBasicAlign(layer, brEstX, brEstY, ms);
            else {
              const tlMs = finderPitch(layer, tl);
              const trMs = finderPitch(layer, tr);
              const blMs = finderPitch(layer, bl);
              if (tlMs && trMs && blMs && this.perspective(t, tlMs, trMs, blMs)) {
                const side = (3.5 - 0.5) / (1 - scale);
                found = this.searchAlign(p, map, scale, side, 0, 0, 1, false);
              }
            }
          }
        }
        // Data can resemble an aligner; let Reed-Solomon try the affine estimate too.
        failed = FAIL.alignment;
        const attempts = found ? 2 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
          const align = !attempt && found;
          const brX = align ? this.alignPoint.x : brEstX;
          const brY = align ? this.alignPoint.y : brEstY;
          const brPoint = ctx.opts.pointsOnDetect ? { x: brX, y: brY } : undefined;
          if (ctx.opts.pointsOnDetect) {
            const inset = size - 6.5;
            const aligners = align ? [{ point: this.alignPoint, x: inset, y: inset }] : [];
            this.report(t, brPoint!, aligners, ms, size, ctx);
          }
          const map = this.map;
          this.mapFinderQuad(map, size, t, brX, brY);
          const version = (size - 17) / 4;
          if (version < 7) {
            failed = this.projectMap(p, map, size, ctx);
            if (!(failed instanceof Error)) break project;
            // Blurred Versions 1--6 still require fine-plane sampling; tiled high-version logic
            // must not bypass it.
            if (this.upgrade(p, map, ctx)) {
              failed = this.projectMap(this.finePlane, this.to, size, ctx);
              // Keep the labeled exit success-gated; the pre-inline return was one statement.
              if (!(failed instanceof Error)) break project;
            }
          } else {
            const fine = this.upgrade(p, map, ctx);
            const sp = fine ? this.finePlane : p;
            const sm = fine ? this.to : map;
            // Confirm Version 7+'s redundant BCH word before paying for local alignment searches.
            let confirmed = this.confirm(sp, sm, size);
            if (!confirmed && fine) confirmed = this.confirm(p, map, size);
            if (confirmed) {
              tiles: {
                const tileFine = sp === this.finePlane;
                const sc = tileFine ? fine : 1;
                const off = (sc - 1) / 2;
                const count = this.setAlignments(version);
                const positions = this.tmp8;
                const nodes = this.tmp64;
                const located = this.tmp64;
                const last = positions[count - 1];
                const c = 0.5;
                let locatedCount = 0;
                let tileBrX = 0;
                let tileBrY = 0;
                let hasTileBr = false;
                for (let yi = 0; yi < count; yi++)
                  for (let xi = 0; xi < count; xi++) {
                    const x = positions[xi];
                    const y = positions[yi];
                    const overlapsFinder =
                      (x === 6 && (y === 6 || y === last)) || (x === last && y === 6);
                    // scale=c, side=1 preserves x + dx + q + 0.5 bit for bit.
                    const node = (yi * count + xi) * 2;
                    if (!overlapsFinder && this.searchAlign(sp, sm, c, 1, x, y, c, true)) {
                      const pos = 7 * 7 * 2 + locatedCount * 4;
                      located[pos] = this.alignPoint.x;
                      located[pos + 1] = this.alignPoint.y;
                      located[pos + 2] = x + c;
                      located[pos + 3] = y + c;
                      locatedCount++;
                      if (x === last && y === last) {
                        hasTileBr = true;
                        tileBrX = this.alignPoint.x;
                        tileBrY = this.alignPoint.y;
                      }
                      nodes[node] = this.alignPoint.x;
                      nodes[node + 1] = this.alignPoint.y;
                    } else {
                      const q = mapPoint(sm, x + c, y + c);
                      nodes[node] = q.x;
                      nodes[node + 1] = q.y;
                    }
                  }
                if (!locatedCount) {
                  failed = FAIL.alignment;
                  break tiles;
                }
                for (let yi = 0; yi < count - 1; yi++)
                  for (let xi = 0; xi < count - 1; xi++) {
                    const left = positions[xi];
                    const right = positions[xi + 1];
                    const top = positions[yi];
                    const bottom = positions[yi + 1];
                    const tlNode = (yi * count + xi) * 2;
                    const trNode = tlNode + 2;
                    const blNode = ((yi + 1) * count + xi) * 2;
                    const brNode = blNode + 2;
                    const tile = this.map;
                    packQuad(
                      this.from,
                      left + c,
                      top + c,
                      right + c,
                      top + c,
                      right + c,
                      bottom + c,
                      left + c,
                      bottom + c
                    );
                    packQuad(
                      this.to,
                      nodes[tlNode],
                      nodes[tlNode + 1],
                      nodes[trNode],
                      nodes[trNode + 1],
                      nodes[brNode],
                      nodes[brNode + 1],
                      nodes[blNode],
                      nodes[blNode + 1]
                    );
                    this.mapQuad(tile);
                    this.projectQuad(
                      sp,
                      tile,
                      size,
                      xi ? left : 0,
                      xi === count - 2 ? size : right,
                      yi ? top : 0,
                      yi === count - 2 ? size : bottom
                    );
                  }
                if (ctx.opts.pointsOnDetect) {
                  const reportAligners: LocatedAligner[] = [];
                  for (let i = 0; i < locatedCount; i++) {
                    const pos = 7 * 7 * 2 + i * 4;
                    reportAligners.push({
                      point: { x: (located[pos] - off) / sc, y: (located[pos + 1] - off) / sc },
                      x: located[pos + 2],
                      y: located[pos + 3],
                    });
                  }
                  this.report(
                    t,
                    hasTileBr ? { x: (tileBrX - off) / sc, y: (tileBrY - off) / sc } : brPoint!,
                    reportAligners,
                    ms,
                    size,
                    ctx
                  );
                }
                failed = this.decodeGrid(size, ctx);
              }
              if (!(failed instanceof Error)) {
                break project;
              }
              // A false local alignment can corrupt a valid global projection; rebuild that grid.
              failed = this.projectMap(sp, sm, size, ctx);
              if (!(failed instanceof Error)) break project;
              if (fine) {
                failed = this.projectMap(p, map, size, ctx);
                if (!(failed instanceof Error)) break project;
              }
            } else failed = FAIL.version;
          }
        }
      }
    }
    this.invertedProjection = false;
    return failed;
  }

  // Lazily build pyramid stages, then try one mandatory and any budgeted retry triples.
  private *scan(cooperative: boolean): DecodeWalk<DecodeResult> {
    if (!this.staged) throw new Error('expected addImage before decode');
    const layers = this.layers as ScannerLayer[];
    this.points = undefined;
    let failed = FAIL.finder;
    if (!this.resized) {
      for (let i = 1; i < layers.length; i++) {
        const layer = layers[i];
        if (!layer.used) break;
        const src = layers[i - 1].luma;
        const dst = layer.luma;
        const width = layers[i - 1].width;
        const rows = cooperative ? 64 : layer.height;
        for (let y = 0; y < layer.height; y += rows) {
          scanRows.resize(src, dst, width, layer.width, y, Math.min(layer.height, y + rows));
          if (cooperative && y + rows < layer.height) this.retryStart += yield;
        }
      }
      this.resized = true;
    }
    // One walk, cheap coarse layers before native. Round 0 is the mandatory pass: budget-free
    // and committed to pickSet's triple (a layer without a pickable set gets no mandatory
    // attempt. Later rounds pop scheduled retries — nextSet skips
    // the pick's id bag, so first-attempt dedup needs no schedule bookkeeping — and only
    // they consume effort or the wall-time budget.
    walk: for (let mandatory = true; ; mandatory = false) {
      let attempted = false;
      for (let i = layers.length - 1; i >= 0; i--) {
        if (
          !mandatory &&
          (!this.retries ||
            (this.timeLimit !== Infinity && Date.now() - this.retryStart >= this.timeLimit))
        )
          break walk;
        const layer = layers[i];
        if (!layer.used) continue;
        /**
         * The frame reader has already written grayscale luma. Keeping thresholding on that plane
         * avoids packed-color conversion in the dominant camera path.
         */
        if (!layer.found) {
          const bHeight = layer.blockHeight;
          const blockRows = cooperative ? 16 : bHeight;
          for (let y = 0; y < bHeight; y += blockRows) {
            scanRows.blocks(layer, y, Math.min(bHeight, y + blockRows));
            if (cooperative && y + blockRows < bHeight) this.retryStart += yield;
          }
          const matrix = layer.bitmap;
          matrix.fill(0, 0, layer.words * layer.height);
          for (let y = 0; y < bHeight; y += blockRows) {
            scanRows.bitmap(layer, y, Math.min(bHeight, y + blockRows));
            if (cooperative && y + blockRows < bHeight) this.retryStart += yield;
          }
          if (this.opts.imageOnBitmap)
            this.opts.imageOnBitmap(
              darkToImage(layer.width, layer.height, (x, y) => bit(layer, x, y))
            );
          layer.patternCount = 0;
          // Scan every other row; cross-checking recovers the center on both axes.
          const finderRows = cooperative ? 32 : layer.height;
          for (let y = 0; y < layer.height; y += finderRows) {
            scanRows.find(layer, y, Math.min(layer.height, y + finderRows));
            if (cooperative && y + finderRows < layer.height) this.retryStart += yield;
          }
          layer.found = true;
        }
        let triple: ScannerTriple | undefined;
        if (mandatory) {
          // Rank both polarities independently of the retry schedule: a shared score lost ~30%
          // of video decodes, and bounded neighbor selection can omit a large symbol's triple.
          this.exclude(layer);
          const ordinary = this.pickPolarity(layer, 0);
          const inverted = this.pickPolarity(layer, 1);
          if (ordinary || inverted) {
            const state = this.tmp64;
            const pts = layer.patterns;
            let polarity = 0;
            if (inverted) {
              const ordConfidence = ordinary
                ? pts[state[0] * 4 + 3] + pts[state[1] * 4 + 3] + pts[state[2] * 4 + 3]
                : 0;
              const invConfidence =
                pts[state[4] * 4 + 3] + pts[state[5] * 4 + 3] + pts[state[6] * 4 + 3];
              // Geometry alone favors well-formed false crosses; a small evidence prior keeps
              // weak true crosses competitive.
              if (!ordinary || (state[7] + 0.1) * ordConfidence < (state[3] + 0.1) * invConfidence)
                polarity = 1;
            }
            const base = polarity * 4;
            const w0 = state[base] | 0;
            const w1 = state[base + 1] | 0;
            const w2 = state[base + 2] | 0;
            layer.pickSum = w0 + w1 + w2;
            layer.pickLo = Math.min(w0, w1, w2);
            layer.pickHi = Math.max(w0, w1, w2);
            triple = this.makeTriple(layer, w0, w1, w2);
            triple.inverted = polarity === 1;
          }
        } else {
          schedule: {
            if (layer.setsReady) break schedule;
            layer.setsReady = true;
            layer.setCount = 0;
            layer.setCursor = 0;
            let eligible = 0;
            for (let i = 0; i < layer.patternCount; i++) {
              if (layer.inverted[i] & 2) continue;
              eligible++;
            }
            if (eligible < 3) break schedule;
            const pts = layer.patterns;
            const neighbors = this.tmp32;
            const useFilters = eligible > 5;
            for (let i = 0; i < layer.patternCount - 2; i++) {
              if (cooperative && i && !(i & 7)) this.retryStart += yield;
              const state = layer.inverted[i];
              if (state & 2) continue;
              const inverted = !!(state & 1);
              const p0 = i * 4;
              // A 1.5 scale allowance retains the largest legal perspective dimension.
              const maxDistance = pts[p0 + 2] * 177 * 1.5;
              const maxDistance2 = maxDistance * maxDistance;
              let count = 0;
              for (let index = i + 1; index < layer.patternCount; index++) {
                const otherState = layer.inverted[index];
                if (otherState & 2 || !!(otherState & 1) !== inverted) continue;
                const pos = index * 4;
                const smallest = Math.min(pts[p0 + 2], pts[pos + 2]);
                const largest = Math.max(pts[p0 + 2], pts[pos + 2]);
                // The measured pitch is fractional; two pixels of full-finder slack keep an exact
                // 2:1 perspective ratio inside the floating-point boundary.
                if (
                  useFilters &&
                  // The 2.4 ratio preserves upper-layer-confirmed perspective triples.
                  largest > 2.4 * smallest + 2 / 7
                )
                  continue;
                const dx = pts[p0] - pts[pos];
                const dy = pts[p0 + 1] - pts[pos + 1];
                const distance = dx * dx + dy * dy;
                if (distance > maxDistance2) continue;
                // A distant high-confidence finder can be the squeezed leg of a perspective QR;
                // prefer evidence-adjusted distance when bounding the local neighborhood.
                const rank = distance / pts[pos + 3];
                count = this.retain(index, rank, count, 15);
              }
              for (let u = 0; u < count - 1; u++) {
                const i1 = neighbors[u];
                const p1 = i1 * 4;
                const d01 = dist2(pts, p0, p1);
                for (let v = u + 1; v < count; v++) {
                  const i2 = neighbors[v];
                  const p2 = i2 * 4;
                  const d12 = dist2(pts, p1, p2);
                  const d02 = dist2(pts, p0, p2);
                  const a = Math.min(d01, d12, d02);
                  const c = Math.max(d01, d12, d02);
                  const b = d01 + d12 + d02 - a - c;
                  if (!a || !b || (useFilters && (a > 4 * b || b > 4 * a))) continue;
                  const da = Math.sqrt(a);
                  const db = Math.sqrt(b);
                  const moduleCount =
                    (da + db) / (2 * ((pts[p0 + 2] + pts[p1 + 2] + pts[p2 + 2]) / 3)) + 7;
                  if (
                    // Center-line pitch can overestimate small finders; allow 0.8..1.5 scaling.
                    moduleCount < 21 * 0.8 ||
                    moduleCount > 177 * 1.5
                  )
                    continue;
                  const cosine = (a + b - c) / (2 * Math.sqrt(a * b));
                  // Accept finder legs spanning 60 through 120 degrees.
                  if (useFilters && Math.abs(cosine) > 0.5) continue;
                  // Row hits grow with finder size. Normalize distance by that evidence so
                  // a large perspective symbol survives the fixed set cap.
                  // This compactness rank orders RETRIES only; pickSet() chooses the mandatory
                  // attempt (compactness alone commits to dense-data pseudo-triples).
                  const confidence = pts[p0 + 3] + pts[p1 + 3] + pts[p2 + 3];
                  const score = (da + db + Math.abs(da - db)) / confidence;
                  retain: {
                    const sets = layer.sets;
                    let index = layer.setCount;
                    if (index < 256) layer.setCount++;
                    else {
                      if (score >= sets[0]) break retain;
                      index = 0;
                    }
                    const pos = index * 5;
                    sets[pos] = score;
                    sets[pos + 1] = +inverted;
                    sets[pos + 2] = i;
                    sets[pos + 3] = i1;
                    sets[pos + 4] = i2;
                    // A completed sift-up satisfies the root comparison. Falling through to the
                    // root sift-down acts like an early return and keeps both exits in one loop.
                    while (index) {
                      const parent = (index - 1) >> 1;
                      if (sets[parent * 5] >= sets[index * 5]) break retain;
                      swapSet(layer, parent, index);
                      index = parent;
                    }
                    siftDown(layer, layer.setCount);
                  }
                }
              }
            }
            for (let end = layer.setCount - 1; end > 0; end--) {
              swapSet(layer, 0, end);
              siftDown(layer, end);
            }
          }
          const sets = layer.sets;
          while (layer.setCursor < layer.setCount) {
            const pos = layer.setCursor++ * 5;
            const i0 = sets[pos + 2] | 0;
            const i1 = sets[pos + 3] | 0;
            const i2 = sets[pos + 4] | 0;
            if (layer.inverted[i0] & 2 || layer.inverted[i1] & 2 || layer.inverted[i2] & 2)
              continue;
            // The round-0 pick may sit anywhere in the schedule (or nowhere); skip its id bag.
            if (
              i0 + i1 + i2 === layer.pickSum &&
              Math.min(i0, i1, i2) === layer.pickLo &&
              Math.max(i0, i1, i2) === layer.pickHi
            )
              continue;
            triple = this.makeTriple(layer, i0, i1, i2);
            triple.inverted = !!sets[pos + 1];
            break;
          }
        }
        if (!triple) {
          if (cooperative) this.retryStart += yield;
          continue;
        }
        if (!mandatory && this.retries !== Infinity) this.retries--;
        attempted = true;
        // Large blurred symbols get template-fit refinement first; other projection failures
        // retry once after a cross refinement pass.
        let pitch =
          !this.blocked && Math.abs(triple.tr.y - triple.tl.y) > Math.abs(triple.tr.x - triple.tl.x)
            ? edgePitch(layer, triple.tl, triple.tr, triple.inverted)
            : 0;
        const fit = !!(pitch && distance(triple.tl, triple.tr) / pitch + 7 >= 21 + (7 - 1) * 4);
        if (fit) {
          fitPattern(layer, triple.tl, triple.inverted);
          fitPattern(layer, triple.tr, triple.inverted);
          fitPattern(layer, triple.bl, triple.inverted);
          refineTriple(layer, triple);
          pitch = edgePitch(layer, triple.tl, triple.tr, triple.inverted);
        }
        let done = this.projectWith(layer, triple, pitch);
        if (done instanceof Error && !fit && refineTriple(layer, triple))
          done = this.projectWith(layer, triple, pitch);
        const opts = layer.context.opts;
        const result = done;
        if (!(done instanceof Error)) {
          // Error values below decode() avoid a try/finally ladder; the parts path implies the
          // text decoder exists, so payload finishing cannot throw.
          if (opts.imageOnResult)
            opts.imageOnResult(
              darkToImage(
                this.decodedSize,
                this.decodedSize,
                (x, y) => this.grid[y * this.decodedSize + x]
              )
            );
          const padding = 3.5 / (this.decodedSize - 7);
          const p = layer.patterns;
          const tl = 4 * triple.tlIndex;
          const tr = 4 * triple.trIndex;
          const bl = 4 * triple.blIndex;
          // Retain the projected QR region in its dead finder records instead of allocating.
          p[tl] = triple.tl.x;
          p[tl + 1] = triple.tl.y;
          p[tl + 2] = triple.trIndex;
          p[tl + 3] = triple.blIndex;
          p[tr] = triple.tr.x;
          p[tr + 1] = triple.tr.y;
          p[tr + 2] = padding;
          p[bl] = triple.bl.x;
          p[bl + 1] = triple.bl.y;
          if (!(layer.inverted[triple.tlIndex] & 2)) this.blocked++;
          if (!(layer.inverted[triple.trIndex] & 2)) this.blocked++;
          if (!(layer.inverted[triple.blIndex] & 2)) this.blocked++;
          layer.inverted[triple.tlIndex] |= 2 | 4;
          layer.inverted[triple.trIndex] |= 2 | 8;
          layer.inverted[triple.blIndex] |= 2 | 8;
          for (const source of layers) {
            if (!source.found) continue;
            this.exclude(source);
          }
          if (this.points) this.opts.pointsOnDetect?.(this.points, result);
        }
        if (!(result instanceof Error)) return result;
        failed = result;
        if (cooperative) this.retryStart += yield;
      }
      if (!mandatory && !attempted) break;
    }
    if (this.points) this.opts.pointsOnDetect?.(this.points, failed);
    return failed;
  }

  // Re-run the scan after each success for decode-all while sharing one retry deadline/budget.
  private *walk(cooperative: boolean, all: boolean): DecodeWalk<DecodeResult[]> {
    this.retryStart = Date.now();
    this.retries = this.effort === Infinity ? Infinity : this.effort - 1;
    const results: DecodeResult[] = [];
    for (;;) {
      const result = yield* this.scan(cooperative);
      results.push(result);
      if (!all) return results;
      if (result instanceof Error) return results;
      if (cooperative) this.retryStart += yield;
    }
  }

  decode(all = false): DecodeResult[] {
    return runDecode(this.walk(false, all));
  }

  decodeAsync(all = false): Promise<DecodeResult[]> {
    return runDecodeAsync(this.walk(true, all), this.timeLimit);
  }
}

/**
 * Decodes the first QR through the fixed coarse-to-fine pyramid scan.
 */
export const decodeQR: DecodeQR = (img, opts = {}) => {
  validateOpts(opts);
  validateImage(img, opts.format);
  const scanner = new _QRScanner({ ...opts, maxSize: { height: img.height, width: img.width } });
  try {
    scanner.addImage(img, opts.format);
    const result = scanner.decode()[0];
    if (result instanceof Error) throw new Error(result.message);
    return result;
  } finally {
    // One-shot calls leave no source image data resident after return;
    // reusable DOM scanners instead clean when their source is released.
    scanner.clean();
  }
};

/** Decode every QR in each image through one cooperatively scheduled maximum-capacity scanner. */
export const decodeQRBatch = async (
  images: readonly Image[],
  opts: DecodeOpts & { maxSize?: Size } = {}
): Promise<DecodeResult[][]> => {
  // The default reusable 4K-square capacity is an API choice.
  const maxSize = opts.maxSize || { width: 3840, height: 3840 };
  const scanner = new _QRScanner({ ...opts, maxSize });
  const results: DecodeResult[][] = [];
  try {
    for (const image of images) {
      try {
        scanner.addImage(image, opts.format);
        results.push(await scanner.decodeAsync(true));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        // A failed image must not discard successful results before or after it.
        results.push([error]);
      }
    }
  } finally {
    scanner.clean();
  }
  return results;
};

// --- BarcodeDetector ponyfill ---

/**
 * [BarcodeDetector](https://wicg.github.io/shape-detection-api/#barcode-detection-api)
 * ponyfill on top of `decodeQR`. Ponyfill: importing it has no side effects;
 * to install as a drop-in polyfill do `globalThis.BarcodeDetector ??= BarcodeDetector`.
 *
 * Differences from native implementations:
 * - only the `qr_code` format is supported;
 * - at most one barcode per image is returned (`decodeQR` stops at the first hit);
 * - `cornerPoints` reuse the decoder-projected symbol boundary and remain estimates
 *   of the visible barcode edges.
 */

/** Barcode formats of the Shape Detection API spec enum. */
const BARCODE_FORMATS = [
  'aztec',
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'data_matrix',
  'ean_13',
  'ean_8',
  'itf',
  'pdf417',
  'qr_code',
  'unknown',
  'upc_a',
  'upc_e',
] as const;
/** A member of the spec's BarcodeFormat enum. Only `'qr_code'` is ever detected. */
export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];

/** Options accepted by the `BarcodeDetector` constructor. */
export type BarcodeDetectorOptions = {
  /** Formats to search for. Values outside the spec enum throw; only `'qr_code'` is detected. */
  formats?: BarcodeFormat[];
};

/** A 2D point in input-image coordinates. */
export interface Point2D {
  x: number;
  y: number;
}

/** A single detection result, shaped like the native `DetectedBarcode`. */
export interface DetectedBarcode {
  /** Axis-aligned rectangle enclosing the detected symbol. */
  boundingBox: DOMRectReadOnly;
  /** Decoded payload. */
  rawValue: string;
  /** Always `'qr_code'` in this ponyfill. */
  format: BarcodeFormat;
  /** Symbol corners, clockwise from top-left. */
  cornerPoints: [Point2D, Point2D, Point2D, Point2D];
}

// Cross-realm-safe brand check: `instanceof` fails for objects from iframes
// or transferred between windows, the toString tag does not.
const kindOf = (o: unknown): string => Object.prototype.toString.call(o).slice(8, -1);

const invalidState = (msg: string) => new DOMException(msg, 'InvalidStateError');

const prefixed = (e: unknown, prefix: string): Error => {
  if (e instanceof DOMException) return new DOMException(`${prefix}: ${e.message}`, e.name);
  if (e instanceof Error)
    return new (e.constructor as new (message: string) => Error)(`${prefix}: ${e.message}`);
  return new Error(`${prefix}: ${e}`);
};

const createCanvas = (width: number, height: number): OffscreenCanvas | HTMLCanvasElement => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const readPixels = (ctx: Ctx2D, width: number, height: number): ImageData => {
  try {
    return ctx.getImageData(0, 0, width, height);
  } catch (e) {
    throw new DOMException('Source would taint origin.', 'SecurityError');
  }
};

const drawSource = (src: CanvasImageSource, width: number, height: number): ImageData | null => {
  if (width === 0 || height === 0) return null;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (ctx === null) throw new DOMException('Canvas 2D context unavailable.', 'NotSupportedError');
  ctx.drawImage(src, 0, 0);
  return readPixels(ctx, width, height);
};

// Normalizes every ImageBitmapSource kind to ImageData; null means a
// zero-sized source, which the spec resolves to an empty detection list.
const toImageData = async (image: ImageBitmapSource): Promise<ImageData | null> => {
  const kind = kindOf(image);
  if (kind === 'Blob') {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(image as Blob);
    } catch (e) {
      throw invalidState('Failed to load or decode Blob.');
    }
    try {
      return drawSource(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }
  if (kind === 'ImageData') {
    const data = image as ImageData;
    // Detached buffers always have zero byteLength.
    if (data.data.buffer.byteLength === 0) throw invalidState('The image data has been detached.');
    if (kindOf(data.data) === 'Float16Array') {
      // The QR decoder consumes byte luma, while rgba-float16 ImageData channels use a 0..1 scale.
      const pixels = Uint8ClampedArray.from(
        data.data as unknown as ArrayLike<number>,
        (value) => value * 255
      );
      return { width: data.width, height: data.height, data: pixels } as ImageData;
    }
    return data;
  }
  if (kind === 'HTMLCanvasElement' || kind === 'OffscreenCanvas') {
    const canvas = image as HTMLCanvasElement | OffscreenCanvas;
    const { width, height } = canvas;
    if (width === 0 || height === 0) return null;
    // A canvas with a non-2d (WebGL) context returns null here; fall back to
    // drawing it onto a scratch canvas instead of reading it directly.
    const ctx = canvas.getContext('2d') as Ctx2D | null;
    return ctx !== null ? readPixels(ctx, width, height) : drawSource(canvas, width, height);
  }
  if (kind === 'HTMLImageElement') {
    const img = image as HTMLImageElement;
    try {
      await img.decode();
    } catch (e) {
      throw invalidState('Failed to load or decode HTMLImageElement.');
    }
    return drawSource(img, img.naturalWidth, img.naturalHeight);
  }
  if (kind === 'SVGImageElement') {
    const img = image as SVGImageElement & { decode?: () => Promise<void> };
    try {
      await img.decode?.(); // not implemented in Safari; drawImage still validates
    } catch (e) {
      throw invalidState('Failed to load or decode SVGImageElement.');
    }
    return drawSource(img, img.width.baseVal.value, img.height.baseVal.value);
  }
  if (kind === 'HTMLVideoElement') {
    const video = image as HTMLVideoElement;
    if (video.readyState < 2) throw invalidState('Invalid element or state.');
    return drawSource(video, video.videoWidth, video.videoHeight);
  }
  if (kind === 'ImageBitmap') {
    const bitmap = image as ImageBitmap;
    if (bitmap.width === 0 && bitmap.height === 0)
      throw invalidState('The image source is detached.');
    return drawSource(bitmap, bitmap.width, bitmap.height);
  }
  if (kind === 'VideoFrame') {
    const frame = image as VideoFrame;
    if (frame.format === null) throw invalidState('VideoFrame is closed.');
    return drawSource(frame, frame.displayWidth, frame.displayHeight);
  }
  throw new TypeError(
    "The provided value is not of type '(Blob or HTMLCanvasElement or HTMLImageElement or " +
      'HTMLVideoElement or ImageBitmap or ImageData or OffscreenCanvas or SVGImageElement or ' +
      "VideoFrame)'."
  );
};

// WPT names the sequence top-left, top-right, bottom-right, bottom-left in image space. The
// decoder already projects the symbol boundary; rotate that clockwise quad instead of rebuilding
// a less accurate affine boundary from finder centers and their noisy module-size estimates.
const symbolCorners = (p: FinderPoints): [Point2D, Point2D, Point2D, Point2D] => {
  const points = p.bounds.map(({ x, y }) => ({ x, y })) as [Point2D, Point2D, Point2D, Point2D];
  let first = 0;
  for (let i = 1; i < points.length; i++)
    if (
      points[i].y < points[first].y ||
      (points[i].y === points[first].y && points[i].x < points[first].x)
    )
      first = i;
  return points.map((_, i) => points[(first + i) % points.length]) as [
    Point2D,
    Point2D,
    Point2D,
    Point2D,
  ];
};

/**
 * QR-only `BarcodeDetector`, API-compatible with the native class.
 * @param options - Formats filter.
 * @example
 * Detect a QR code on a canvas.
 * ```ts
 * import { BarcodeDetector } from 'qr/decode.js';
 * if (typeof document !== 'undefined') {
 *   const detector = new BarcodeDetector({ formats: ['qr_code'] });
 *   const canvas = document.createElement('canvas');
 *   detector.detect(canvas).then((barcodes) => void barcodes);
 * }
 * ```
 */
export class BarcodeDetector {
  private formats: BarcodeFormat[];

  constructor(options: BarcodeDetectorOptions = {}) {
    try {
      // WebIDL dictionaries treat null as empty and reject primitives. Sequences are iterable.
      const type = typeof options;
      if (options !== null && type !== 'object' && type !== 'function')
        throw new TypeError('The provided value is not a dictionary.');
      const dictionary = (options === null ? {} : options) as BarcodeDetectorOptions;
      // TODO(https://github.com/WICG/shape-detection-api/issues/66):
      // 'unknown' is dropped rather than rejected, matching Chromium.
      const formats =
        dictionary.formats === undefined
          ? undefined
          : [...dictionary.formats].filter((f) => f !== 'unknown');
      if (formats !== undefined && formats.length === 0)
        throw new TypeError('Hint option provided, but is empty.');
      for (const format of formats || []) {
        if (!BARCODE_FORMATS.includes(format))
          throw new TypeError(
            `Failed to read the 'formats' property from 'BarcodeDetectorOptions': ` +
              `The provided value '${format}' is not a valid enum value of type BarcodeFormat.`
          );
      }
      this.formats = formats || [];
    } catch (e) {
      throw prefixed(e, "Failed to construct 'BarcodeDetector'");
    }
  }

  static async getSupportedFormats(): Promise<readonly BarcodeFormat[]> {
    return ['qr_code'];
  }

  async detect(image: ImageBitmapSource): Promise<DetectedBarcode[]> {
    try {
      const data = await toImageData(image);
      if (data === null) return []; // zero-sized source
      if (this.formats.length !== 0 && !this.formats.includes('qr_code')) return [];
      let points: FinderPoints | undefined;
      let rawValue: string;
      try {
        rawValue = decodeQR(data, {
          pointsOnDetect: (p, result) => {
            if (typeof result === 'string') points = p;
          },
        });
      } catch (e) {
        return []; // no QR code found: an empty list per spec, not an error
      }
      const cornerPoints = symbolCorners(points!);
      const box = points!.boundingBox;
      return [
        {
          boundingBox: new DOMRectReadOnly(box.x, box.y, box.width, box.height),
          rawValue,
          format: 'qr_code',
          cornerPoints,
        },
      ];
    } catch (e) {
      throw prefixed(e, "Failed to execute 'detect' on 'BarcodeDetector'");
    }
  }
}

export default decodeQR;
