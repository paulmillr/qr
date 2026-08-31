import { it } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import decodeQR from '../src/decode.ts';
import { encodeQR } from '../src/index.ts';
import { decodeGIFLuma } from './imgcoder/gif.ts';
import { decodeGIF } from './misc/gif.ts';
import { matrixToImage } from './utils.ts';

it('GIF: encoder output round-trips pixel-exact', () => {
  for (const [text, ecc] of [
    ['HELLO WORLD', 'medium'],
    ['H'.repeat(768), 'medium'],
    ['x'.repeat(1200), 'high'], // byte mode, high version
  ] as const) {
    const img = decodeGIF(encodeQR(text, 'gif', { ecc }));
    const expected = matrixToImage(encodeQR(text, 'raw', { ecc }), 1);
    deepStrictEqual(img.width, expected.width);
    deepStrictEqual(img.height, expected.height);
    deepStrictEqual(Uint8Array.from(img.data), Uint8Array.from(expected.data));
  }
});

it('GIF: decodes through decodeQR via scale', () => {
  // 1px-per-module output needs upscaling for run-length finder detection;
  // scale 2 is the measured minimum, 4 mirrors the README example.
  for (const scale of [2, 4]) {
    const gif = encodeQR('GIF PIPELINE', 'gif', { ecc: 'medium' });
    deepStrictEqual(decodeQR(decodeGIF(gif, scale)), 'GIF PIPELINE');
  }
  // Encoder-side scaling works without a decode-side scale.
  const gif = encodeQR('GIF PIPELINE', 'gif', { ecc: 'medium', scale: 4 });
  deepStrictEqual(decodeQR(decodeGIF(gif)), 'GIF PIPELINE');
});

// Reference LZW compressor (dictionary growth, code-size bumps one code
// later than the natural point — the decoder's dictionary lags the
// encoder's by one entry — and the 4096-entry reset). Exercises the paths
// the encoder's uncompressed literal streams never touch.
function lzwCompress(indices: Uint8Array, minCode: number): Uint8Array {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let dict = new Map<string, number>();
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < clear; i++) dict.set(String.fromCharCode(i), i);
  };
  reset();
  let next = eoi + 1;
  let codeSize = minCode + 1;
  const out: number[] = [];
  let acc = 0;
  let nbits = 0;
  const emit = (code: number) => {
    acc |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) {
      out.push(acc & 255);
      acc >>>= 8;
      nbits -= 8;
    }
  };
  emit(clear);
  let cur = '';
  for (const idx of indices) {
    const ch = String.fromCharCode(idx);
    if (dict.has(cur + ch)) {
      cur += ch;
      continue;
    }
    emit(dict.get(cur)!);
    if (next < 4096) {
      dict.set(cur + ch, next);
      if (++next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      reset();
      next = eoi + 1;
      codeSize = minCode + 1;
    }
    cur = ch;
  }
  emit(dict.get(cur)!);
  emit(eoi);
  if (nbits > 0) out.push(acc & 255);
  return Uint8Array.from(out);
}

type GifOpts = { interlace?: boolean; local?: boolean; transparent?: number };
function makeGif(
  w: number,
  h: number,
  indices: Uint8Array,
  palBits: number, // palette size = 2 << palBits
  palette: number[], // flat RGB
  o: GifOpts = {}
): Uint8Array {
  const bytes: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
  const u16 = (v: number) => bytes.push(v & 255, v >>> 8);
  u16(w);
  u16(h);
  bytes.push(o.local ? 0 : 0x80 | palBits, 0, 0);
  if (!o.local) bytes.push(...palette);
  if (o.transparent !== undefined) bytes.push(0x21, 0xf9, 4, 1, 0, 0, o.transparent, 0); // GCE
  bytes.push(0x21, 0xff, 11, ...Array(11).fill(65), 3, 1, 0, 0, 0); // app ext, must be skipped
  bytes.push(0x2c);
  u16(0);
  u16(0);
  u16(w);
  u16(h);
  bytes.push((o.local ? 0x80 | palBits : 0) | (o.interlace ? 0x40 : 0));
  if (o.local) bytes.push(...palette);
  let rows = indices;
  if (o.interlace) {
    // Interlaced GIFs store rows in 8/8/4/2 pass order.
    rows = new Uint8Array(indices.length);
    let r = 0;
    for (const [start, step] of [
      [0, 8],
      [4, 8],
      [2, 4],
      [1, 2],
    ] as const)
      for (let y = start; y < h; y += step, r++)
        rows.set(indices.subarray(y * w, (y + 1) * w), r * w);
  }
  const minCode = Math.max(2, palBits + 1);
  bytes.push(minCode);
  const lzw = lzwCompress(rows, minCode);
  for (let i = 0; i < lzw.length; i += 255) {
    const chunk = lzw.subarray(i, i + 255);
    bytes.push(chunk.length, ...chunk);
  }
  bytes.push(0, 0x3b);
  return Uint8Array.from(bytes);
}

it('GIF: compressed LZW, interlace, local palette, transparency', () => {
  // Deterministic 8-color noise: deep dictionary chains, every code-size
  // bump, and enough symbols to force a 4096-entry dictionary reset.
  const W = 200;
  const noise = new Uint8Array(W * W);
  let seed = 42;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed >> 16) & 7;
  }
  const pal = Array.from({ length: 3 * 16 }, (_, i) => (i * 37) & 255);
  const cases: GifOpts[] = [
    {},
    { interlace: true },
    { local: true },
    { interlace: true, local: true, transparent: 5 },
  ];
  for (const opts of cases) {
    const img = decodeGIF(makeGif(W, W, noise, 3, pal, opts));
    const luma = decodeGIFLuma(makeGif(W, W, noise, 3, pal, opts));
    deepStrictEqual(img.width, W);
    for (let i = 0; i < noise.length; i++) {
      const idx = noise[i];
      const expected =
        idx === opts.transparent
          ? [255, 255, 255]
          : [pal[3 * idx], pal[3 * idx + 1], pal[3 * idx + 2]];
      for (let c = 0; c < 3; c++)
        if (img.data[4 * i + c] !== expected[c])
          throw new Error(
            `${JSON.stringify(opts)} at px ${i}: ${img.data[4 * i + c]} != ${expected[c]}`
          );
      const light = (expected[0] + 2 * expected[1] + expected[2]) >>> 2;
      if (luma.data[i] !== light)
        throw new Error(`${JSON.stringify(opts)} at px ${i}: luma ${luma.data[i]} != ${light}`);
    }
  }
});

it('GIF: data-url wraps the gif bytes in base64', () => {
  const prefix = 'data:image/gif;base64,';
  // Large payload at scale 4 crosses many 8192-byte btoa chunks.
  for (const [text, scale] of [
    ['GIF PIPELINE', 4],
    ['H'.repeat(768), 4],
  ] as const) {
    const url = encodeQR(text, 'data-url', { ecc: 'medium', scale });
    deepStrictEqual(url.startsWith(prefix), true);
    const bytes = Uint8Array.from(Buffer.from(url.slice(prefix.length), 'base64'));
    deepStrictEqual(bytes, encodeQR(text, 'gif', { ecc: 'medium', scale }));
    deepStrictEqual(decodeQR(decodeGIF(bytes)), text);
  }
});

it('GIF: data-url toBase64 and btoa paths agree', () => {
  const proto = Uint8Array.prototype as { toBase64?: () => string };
  const orig = Object.getOwnPropertyDescriptor(proto, 'toBase64');
  const expected =
    'data:image/gif;base64,' + Buffer.from(encodeQR('DATA URL', 'gif')).toString('base64');
  try {
    proto.toBase64 = function (this: Uint8Array) {
      return Buffer.from(this).toString('base64');
    };
    deepStrictEqual(encodeQR('DATA URL', 'data-url'), expected);
    delete proto.toBase64;
    deepStrictEqual(encodeQR('DATA URL', 'data-url'), expected); // btoa fallback
  } finally {
    delete proto.toBase64;
    if (orig) Object.defineProperty(proto, 'toBase64', orig);
  }
});

it('GIF: rejects invalid input', () => {
  throws(() => decodeGIF(new Uint8Array([1, 2, 3])), /not a GIF/);
  throws(() => decodeGIF(encodeQR('X', 'gif'), 0), /invalid scale/);
  throws(() => decodeGIF(encodeQR('X', 'gif'), 1.5), /invalid scale/);
  // Header only, no image descriptor before the trailer.
  const empty = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]);
  throws(() => decodeGIF(empty), /no image/);
});

it.runWhen(import.meta.url);
