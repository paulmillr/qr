/*!
 * Copyright (c) 2023 Paul Miller (paulmillr.com)
 * SPDX-License-Identifier: MIT OR Apache-2.0
 */
/**
 * Animated QR bulk-transfer fountain codec.
 * @module
 */

import type { Output, QrOpts, SvgQrOpts } from './index.ts';
import { _isBytes, encodeQR } from './index.ts';

const MAGIC_0 = 0x51;
const MAGIC_1 = 0x76;
const VERSION = 1;
const HEADER_SIZE = 17;
const CRC_SIZE = 4;
const DEFAULT_BLOCK_SIZE = 256;
const MIN_BLOCK_SIZE = 16;
const MAX_QR_BYTE_CAPACITY = 2953; // Version 40-low byte-mode payload.
// Base64url expands the complete header/block/CRC frame before QR encoding.
const MAX_BLOCK_SIZE = Math.floor((MAX_QR_BYTE_CAPACITY * 3) / 4) - HEADER_SIZE - CRC_SIZE;
const MAX_FRAME_SIZE = HEADER_SIZE + MAX_BLOCK_SIZE + CRC_SIZE;
const MAX_FRAME_TEXT_SIZE = Math.ceil(MAX_FRAME_SIZE / 3) * 4;
const U32_MAX = 0xffffffff;
const U32_RANGE = 0x100000000;
const SOLITON_C = 0.03;
const SOLITON_DELTA = 0.5;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const BASE64URL_VALUES = /* @__PURE__ */ (() => {
  const values = new Int8Array(128);
  values.fill(-1);
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) values[BASE64URL_ALPHABET.charCodeAt(i)] = i;
  return values;
})();

const CRC32_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

type Rng = { state: number };
type ParsedFrame = {
  sessionId: number;
  dataLength: number;
  blockSize: number;
  seed: number;
  payload: Uint8Array;
};
type PendingFrame = {
  payload: Uint8Array;
  indices: number[];
};

export type VideoEncodeOpts = {
  /** Source-block size in bytes. Default: 256. */
  blockSize?: number | undefined;
  /** Base seed for reproducible frame streams. */
  seed?: number | undefined;
};

export type VideoProgress = {
  /** Source blocks recovered so far. */
  decodedBlocks: number;
  /** Total source blocks, or 0 until the first valid frame locks the session. */
  totalBlocks: number;
  /** Valid, non-duplicate frames fed into the decoder. */
  framesSeen: number;
  /** True once every source block has been recovered. */
  done: boolean;
};

function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = U32_MAX;
  for (let i = start; i < end; i++) crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ U32_MAX) >>> 0;
}

function readU16BE(data: Uint8Array, pos: number): number {
  return (data[pos] << 8) | data[pos + 1];
}

function readU32BE(data: Uint8Array, pos: number): number {
  return ((data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]) >>> 0;
}

function writeU16BE(data: Uint8Array, pos: number, value: number): void {
  data[pos] = value >>> 8;
  data[pos + 1] = value;
}

function writeU32BE(data: Uint8Array, pos: number, value: number): void {
  data[pos] = value >>> 24;
  data[pos + 1] = value >>> 16;
  data[pos + 2] = value >>> 8;
  data[pos + 3] = value;
}

function createRng(seed: number): Rng {
  return { state: seed >>> 0 };
}

function rngNext(rng: Rng): number {
  // mulberry32: Weyl-counter state update plus avalanche finalizer, period 2**32.
  let t = (rng.state = (rng.state + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

function rngFloat(rng: Rng): number {
  return rngNext(rng) / U32_RANGE;
}

function rngInt(rng: Rng, n: number): number {
  return Math.floor(rngFloat(rng) * n);
}

function validateObject(object: unknown, title: string): void {
  if (object === null || typeof object !== 'object' || Array.isArray(object))
    throw new TypeError(`"${title}" expected object, got type=${typeof object}`);
}

function validateData(data: Uint8Array): void {
  if (!_isBytes(data)) throw new TypeError(`"data" expected Uint8Array, got type=${typeof data}`);
  if (data.length === 0) throw new TypeError('"data" expected non-empty Uint8Array');
  if (data.length > U32_MAX) throw new TypeError(`"data" length exceeds u32: ${data.length}`);
}

function validBlockSize(blockSize: number): boolean {
  return (
    typeof blockSize === 'number' &&
    Number.isInteger(blockSize) &&
    blockSize >= MIN_BLOCK_SIZE &&
    blockSize <= MAX_BLOCK_SIZE
  );
}

function validateBlockSize(blockSize: number): number {
  if (!validBlockSize(blockSize))
    throw new TypeError(
      `"opts.blockSize" expected integer [${MIN_BLOCK_SIZE}..${MAX_BLOCK_SIZE}], got ${blockSize}`
    );
  return blockSize;
}

function validateSeed(seed: number): number {
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > U32_MAX)
    throw new TypeError(`"opts.seed" expected u32 integer, got ${seed}`);
  return seed >>> 0;
}

function validateVideoOpts(opts: VideoEncodeOpts | undefined): {
  blockSize: number;
  seed: number;
} {
  if (opts !== undefined) validateObject(opts, 'opts');
  const blockSize = validateBlockSize(
    opts?.blockSize === undefined ? DEFAULT_BLOCK_SIZE : opts.blockSize
  );
  const seed =
    opts?.seed === undefined
      ? typeof globalThis.crypto?.getRandomValues === 'function'
        ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
        : (Date.now() ^ (Math.random() * U32_RANGE)) >>> 0
      : validateSeed(opts.seed);
  return { blockSize, seed };
}

function robustSolitonCdf(k: number): Float64Array {
  const cdf = new Float64Array(k);
  const r = SOLITON_C * Math.log(k / SOLITON_DELTA) * Math.sqrt(k);
  const m = Math.floor(k / r);
  let total = 0;
  for (let d = 1; d <= k; d++) {
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    let tau = 0;
    if (m > 0) {
      if (d < m) tau = r / (d * k);
      else if (d === m) tau = (r * Math.log(r / SOLITON_DELTA)) / k;
    }
    total += rho + tau;
    cdf[d - 1] = total;
  }
  for (let i = 0; i < cdf.length; i++) cdf[i] /= total;
  cdf[cdf.length - 1] = 1;
  return cdf;
}

function sampleDegree(rng: Rng, cdf: Float64Array): number {
  const value = rngFloat(rng);
  for (let i = 0; i < cdf.length; i++) if (value < cdf[i]) return i + 1;
  return cdf.length;
}

function sampleBlocks(
  seed: number,
  cdf: Float64Array,
  scratch: Uint32Array,
  cb: (index: number) => void
): void {
  const rng = createRng(seed);
  const k = scratch.length;
  const degree = sampleDegree(rng, cdf);
  for (let i = 0; i < k; i++) scratch[i] = i;
  for (let i = 0; i < degree; i++) {
    const j = i + rngInt(rng, k - i);
    const index = scratch[j];
    scratch[j] = scratch[i];
    scratch[i] = index;
    cb(index);
  }
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}

function xorSourceBlock(
  target: Uint8Array,
  data: Uint8Array,
  index: number,
  blockSize: number
): void {
  const start = index * blockSize;
  const end = Math.min(start + blockSize, data.length);
  for (let i = start, j = 0; i < end; i++, j++) target[j] ^= data[i];
}

function base64urlValue(text: string, pos: number): number {
  const code = text.charCodeAt(pos);
  return code < BASE64URL_VALUES.length ? BASE64URL_VALUES[code] : -1;
}

const base64url = {
  encode(bytes: Uint8Array): string {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out +=
        BASE64URL_ALPHABET[n >>> 18] +
        BASE64URL_ALPHABET[(n >>> 12) & 63] +
        BASE64URL_ALPHABET[(n >>> 6) & 63] +
        BASE64URL_ALPHABET[n & 63];
    }
    if (i < bytes.length) {
      const b0 = bytes[i];
      out += BASE64URL_ALPHABET[b0 >>> 2];
      if (i + 1 < bytes.length) {
        const b1 = bytes[i + 1];
        out += BASE64URL_ALPHABET[((b0 & 3) << 4) | (b1 >>> 4)];
        out += BASE64URL_ALPHABET[(b1 & 15) << 2];
      } else {
        out += BASE64URL_ALPHABET[(b0 & 3) << 4];
      }
    }
    return out;
  },

  decode(text: string): Uint8Array | undefined {
    const rem = text.length & 3;
    if (rem === 1) return undefined;
    const full = text.length >>> 2;
    const outLen = full * 3 + (rem === 0 ? 0 : rem - 1);
    const out = new Uint8Array(outLen);
    let pos = 0;
    let outPos = 0;
    for (let i = 0; i < full; i++, pos += 4) {
      const c0 = base64urlValue(text, pos);
      const c1 = base64urlValue(text, pos + 1);
      const c2 = base64urlValue(text, pos + 2);
      const c3 = base64urlValue(text, pos + 3);
      if ((c0 | c1 | c2 | c3) < 0) return undefined;
      out[outPos++] = (c0 << 2) | (c1 >>> 4);
      out[outPos++] = ((c1 & 15) << 4) | (c2 >>> 2);
      out[outPos++] = ((c2 & 3) << 6) | c3;
    }
    if (rem === 2) {
      const c0 = base64urlValue(text, pos);
      const c1 = base64urlValue(text, pos + 1);
      if ((c0 | c1) < 0 || (c1 & 15) !== 0) return undefined;
      out[outPos++] = (c0 << 2) | (c1 >>> 4);
    } else if (rem === 3) {
      const c0 = base64urlValue(text, pos);
      const c1 = base64urlValue(text, pos + 1);
      const c2 = base64urlValue(text, pos + 2);
      if ((c0 | c1 | c2) < 0 || (c2 & 3) !== 0) return undefined;
      out[outPos++] = (c0 << 2) | (c1 >>> 4);
      out[outPos++] = ((c1 & 15) << 4) | (c2 >>> 2);
    }
    return out;
  },
};

function parseFrame(text: string): ParsedFrame | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_FRAME_TEXT_SIZE)
    return undefined;
  const frame = base64url.decode(text);
  if (frame === undefined || frame.length < HEADER_SIZE + CRC_SIZE) return undefined;
  if (frame[0] !== MAGIC_0 || frame[1] !== MAGIC_1 || frame[2] !== VERSION) return undefined;
  const dataLength = readU32BE(frame, 7);
  const blockSize = readU16BE(frame, 11);
  if (dataLength === 0 || !validBlockSize(blockSize)) return undefined;
  const frameLength = HEADER_SIZE + blockSize + CRC_SIZE;
  if (frame.length !== frameLength) return undefined;
  if (readU32BE(frame, frameLength - CRC_SIZE) !== crc32(frame, 0, frameLength - CRC_SIZE))
    return undefined;
  return {
    sessionId: readU32BE(frame, 3),
    dataLength,
    blockSize,
    seed: readU32BE(frame, 13),
    payload: frame.subarray(HEADER_SIZE, HEADER_SIZE + blockSize),
  };
}

/**
 * Infinite generator of base64url fountain frames. Throws on empty data or bad opts.
 * The generator borrows `data` without copying; do not mutate it until the generator is discarded.
 */
export function encodeVideoFrames(
  data: Uint8Array,
  opts?: VideoEncodeOpts
): Generator<string, void> {
  validateData(data);
  const { blockSize, seed } = validateVideoOpts(opts);
  const dataLength = data.length;
  const blockCount = Math.ceil(dataLength / blockSize);
  const sessionId = crc32(data);
  const cdf = robustSolitonCdf(blockCount);
  const indexScratch = new Uint32Array(blockCount);
  const seedRng = createRng(seed);
  const frameLength = HEADER_SIZE + blockSize + CRC_SIZE;
  const frame = new Uint8Array(frameLength);
  const payload = frame.subarray(HEADER_SIZE, HEADER_SIZE + blockSize);
  frame[0] = MAGIC_0;
  frame[1] = MAGIC_1;
  frame[2] = VERSION;
  writeU32BE(frame, 3, sessionId);
  writeU32BE(frame, 7, dataLength);
  writeU16BE(frame, 11, blockSize);

  function* frames(): Generator<string, void> {
    while (true) {
      // Store the mulberry32 output as the per-frame seed, not the internal counter state.
      const frameSeed = rngNext(seedRng);
      writeU32BE(frame, 13, frameSeed);
      payload.fill(0);
      sampleBlocks(frameSeed, cdf, indexScratch, (index) =>
        xorSourceBlock(payload, data, index, blockSize)
      );
      writeU32BE(frame, frameLength - CRC_SIZE, crc32(frame, 0, frameLength - CRC_SIZE));
      yield base64url.encode(frame);
    }
  }
  return frames();
}

/**
 * Infinite generator of rendered QR fountain frames.
 * The generator borrows `data` without copying; do not mutate it until the generator is discarded.
 */
export function encodeVideoQR(
  data: Uint8Array,
  output: 'raw',
  opts?: VideoEncodeOpts & QrOpts
): Generator<boolean[][], void>;
export function encodeVideoQR(
  data: Uint8Array,
  output: 'ascii' | 'term' | 'data-url',
  opts?: VideoEncodeOpts & QrOpts
): Generator<string, void>;
export function encodeVideoQR(
  data: Uint8Array,
  output: 'svg',
  opts?: VideoEncodeOpts & QrOpts & SvgQrOpts
): Generator<string, void>;
export function encodeVideoQR(
  data: Uint8Array,
  output: 'gif',
  opts?: VideoEncodeOpts & QrOpts
): Generator<Uint8Array, void>;
export function encodeVideoQR(
  data: Uint8Array,
  output: Output,
  opts?: VideoEncodeOpts & QrOpts & SvgQrOpts
): Generator<boolean[][] | string | Uint8Array, void> {
  const frames = encodeVideoFrames(data, opts);
  const qrOpts = {
    ...(opts || {}),
    ecc: opts?.ecc === undefined ? 'low' : opts.ecc,
  } as QrOpts & SvgQrOpts;
  function* qrs(): Generator<boolean[][] | string | Uint8Array, void> {
    while (true) {
      const next = frames.next();
      if (next.done) return;
      const frame = next.value;
      if (output === 'raw') yield encodeQR(frame, 'raw', qrOpts);
      else if (output === 'ascii' || output === 'term' || output === 'data-url')
        yield encodeQR(frame, output, qrOpts);
      else if (output === 'svg') yield encodeQR(frame, 'svg', qrOpts);
      else if (output === 'gif') yield encodeQR(frame, 'gif', qrOpts);
      else throw new Error(`Unknown output: ${output}`);
    }
  }
  return qrs();
}

export class VideoDecoder {
  private locked = false;
  private sessionId = 0;
  private dataLength = 0;
  private blockSize = 0;
  private total = 0;
  private decoded = 0;
  private seen = 0;
  private complete = false;
  private cdf: Float64Array = new Float64Array(0);
  private indexScratch: Uint32Array = new Uint32Array(0);
  private blocks: (Uint8Array | undefined)[] = [];
  private pending: PendingFrame[] = [];
  private seenSeeds = new Set<number>();

  private output(): Uint8Array {
    const out = new Uint8Array(this.dataLength);
    let pos = 0;
    for (const block of this.blocks) {
      if (block === undefined) throw new Error('VideoDecoder: missing recovered block');
      const len = Math.min(this.blockSize, this.dataLength - pos);
      out.set(block.subarray(0, len), pos);
      pos += len;
    }
    return out;
  }

  private lock(frame: ParsedFrame): boolean {
    if (this.locked) {
      return (
        frame.sessionId === this.sessionId &&
        frame.dataLength === this.dataLength &&
        frame.blockSize === this.blockSize
      );
    }
    const total = Math.ceil(frame.dataLength / frame.blockSize);
    if (!Number.isSafeInteger(total) || total <= 0) return false;
    this.locked = true;
    this.sessionId = frame.sessionId;
    this.dataLength = frame.dataLength;
    this.blockSize = frame.blockSize;
    this.total = total;
    this.cdf = robustSolitonCdf(total);
    this.indexScratch = new Uint32Array(total);
    this.blocks = new Array(total);
    return true;
  }

  private recover(index: number, payload: Uint8Array): void {
    const queueIndices = [index];
    const queueBlocks = [payload];
    for (let q = 0; q < queueIndices.length; q++) {
      const blockIndex = queueIndices[q];
      const block = queueBlocks[q];
      if (this.blocks[blockIndex] !== undefined) continue;
      this.blocks[blockIndex] = block;
      this.decoded++;
      if (this.decoded === this.total) {
        if (crc32(this.output()) === this.sessionId) this.complete = true;
        else {
          // CRC32 identifies a session but can collide; discard mixed recovery before exposing it.
          this.decoded = 0;
          this.blocks = new Array(this.total);
          this.pending = [];
        }
        return;
      }
      for (let p = 0; p < this.pending.length; p++) {
        const pending = this.pending[p];
        const indices = pending.indices;
        let pos = -1;
        for (let i = 0; i < indices.length; i++) {
          if (indices[i] === blockIndex) {
            pos = i;
            break;
          }
        }
        if (pos === -1) continue;
        xorInto(pending.payload, block);
        indices[pos] = indices[indices.length - 1];
        indices.pop();
        if (indices.length === 0) {
          this.pending[p] = this.pending[this.pending.length - 1];
          this.pending.pop();
          p--;
        } else if (indices.length === 1) {
          queueIndices.push(indices[0]);
          queueBlocks.push(pending.payload);
          this.pending[p] = this.pending[this.pending.length - 1];
          this.pending.pop();
          p--;
        }
      }
    }
  }

  /** Feed one base64url frame string. Invalid, duplicate, or foreign frames return false. */
  feed(frame: string): boolean {
    try {
      const parsed = parseFrame(frame);
      if (parsed === undefined || !this.lock(parsed)) return false;
      if (this.seenSeeds.has(parsed.seed)) return false;
      this.seenSeeds.add(parsed.seed);
      this.seen++;
      if (this.complete) return true;
      const payload = new Uint8Array(parsed.payload);
      const indices: number[] = [];
      sampleBlocks(parsed.seed, this.cdf, this.indexScratch, (index) => {
        const block = this.blocks[index];
        if (block === undefined) indices.push(index);
        else xorInto(payload, block);
      });
      if (indices.length === 0) return true;
      if (indices.length === 1) this.recover(indices[0], payload);
      else this.pending.push({ payload, indices });
      return true;
    } catch {
      return false;
    }
  }

  get progress(): VideoProgress {
    return {
      decodedBlocks: this.decoded,
      totalBlocks: this.total,
      framesSeen: this.seen,
      done: this.complete,
    };
  }

  /** Recovered payload with zero padding stripped. Throws until decoding is complete. */
  result(): Uint8Array {
    if (!this.complete) throw new Error('VideoDecoder: result is not ready');
    return this.output();
  }
}
