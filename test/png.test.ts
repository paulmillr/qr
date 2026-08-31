import { it } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import decodeQR from '../src/decode.ts';
import { encodeQR } from '../src/index.ts';
import { decodePNGLuma } from './imgcoder/png.ts';
import { decodePNG } from './misc/png.ts';
import { _dirname, matrixToImage, readPNG } from './utils.ts';

// Reference PNG writer: real zlib deflate (so stored/fixed/dynamic blocks all
// appear), any color type / bit depth, per-row filter choice, Adam7.
const crcTable = /* @__PURE__ */ (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  let c = -1;
  for (let i = 4; i < 8 + body.length; i++) c = crcTable[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  dv.setUint32(8 + body.length, (c ^ -1) >>> 0);
  return out;
}
type PngOpts = {
  color: number;
  depth: number;
  interlace?: number;
  filters?: number[];
  level?: number;
  palette?: Uint8Array;
  trns?: Uint8Array;
};
// rgba is the source of truth; for palette images the red channel carries the
// palette index.
function makePng(w: number, h: number, rgba: Uint8Array, o: PngOpts): Uint8Array {
  const channels = [1, 0, 3, 1, 2, 0, 4][o.color];
  const passes = o.interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const parts: Uint8Array[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx);
    const ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rb = Math.ceil((pw * channels * o.depth) / 8);
    const bpp = Math.max(1, Math.ceil((channels * o.depth) / 8));
    const rows = new Uint8Array(ph * (rb + 1));
    let prevRow: Uint8Array | undefined;
    for (let y = 0; y < ph; y++) {
      const line = new Uint8Array(rb);
      for (let x = 0; x < pw; x++) {
        const px = (((y0 + y * dy) * w + x0 + x * dx) * 4) | 0;
        const vals =
          o.color === 0 || o.color === 3
            ? [rgba[px]]
            : o.color === 2
              ? [rgba[px], rgba[px + 1], rgba[px + 2]]
              : o.color === 4
                ? [rgba[px], rgba[px + 3]]
                : [rgba[px], rgba[px + 1], rgba[px + 2], rgba[px + 3]];
        vals.forEach((v, ci) => {
          if (o.depth === 8) line[x * channels + ci] = v;
          else if (o.depth === 16) {
            line[(x * channels + ci) * 2] = v;
            line[(x * channels + ci) * 2 + 1] = (v * 37) & 255; // junk low byte
          } else {
            const scaled = o.color === 3 ? v : Math.round((v * ((1 << o.depth) - 1)) / 255);
            const bit = x * o.depth;
            line[bit >> 3] |= scaled << (8 - o.depth - (bit & 7));
          }
        });
      }
      const f = o.filters ? o.filters[y % o.filters.length] : 0;
      rows[y * (rb + 1)] = f;
      const enc = rows.subarray(y * (rb + 1) + 1, (y + 1) * (rb + 1));
      for (let x = 0; x < rb; x++) {
        const a = x >= bpp ? line[x - bpp] : 0;
        const u = prevRow ? prevRow[x] : 0;
        const c = prevRow && x >= bpp ? prevRow[x - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = u;
        else if (f === 3) pred = (a + u) >> 1;
        else if (f === 4) {
          const pa = Math.abs(u - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + u - 2 * c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? u : c;
        }
        enc[x] = (line[x] - pred) & 255;
      }
      prevRow = line;
    }
    parts.push(rows);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const raw = new Uint8Array(total);
  for (let off = 0, i = 0; i < parts.length; off += parts[i++].length) raw.set(parts[i], off);
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = o.depth;
  ihdr[9] = o.color;
  ihdr[12] = o.interlace || 0;
  const z = deflateSync(raw, { level: (o.level ?? 6) as 0 | 6 });
  const out: Uint8Array[] = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (o.palette) out.push(chunk('PLTE', o.palette));
  if (o.trns) out.push(chunk('tRNS', o.trns));
  // Split IDAT in two to exercise chunk concatenation.
  const half = z.length >> 1;
  out.push(chunk('IDAT', z.subarray(0, half)));
  out.push(chunk('IDAT', z.subarray(half)));
  out.push(chunk('IEND', new Uint8Array(0)));
  let len = 0;
  for (const p of out) len += p.length;
  const png = new Uint8Array(len);
  for (let off = 0, i = 0; i < out.length; off += out[i++].length) png.set(out[i], off);
  return png;
}

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 12) & 255;
// Expected output: alpha composited onto white, opaque RGBA.
function composite(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4).fill(255);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    for (let c = 0; c < 3; c++)
      out[i * 4 + c] =
        a === 255 ? rgba[i * 4 + c] : ((rgba[i * 4 + c] * a + 255 * (255 - a) + 127) / 255) | 0;
  }
  return out;
}
function expectPixels(name: string, png: Uint8Array, rgba: Uint8Array, w: number, h: number) {
  const img = decodePNG(png);
  const luma = decodePNGLuma(png);
  deepStrictEqual({ w: img.width, h: img.height }, { w, h }, name);
  deepStrictEqual({ w: luma.width, h: luma.height }, { w, h }, name);
  const expected = composite(rgba, w, h);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 4; c++)
      if (img.data[4 * i + c] !== expected[4 * i + c])
        throw new Error(
          `${name}: byte ${4 * i + c}: ${img.data[4 * i + c]} != ${expected[4 * i + c]}`
        );
    const light = (expected[4 * i] + 2 * expected[4 * i + 1] + expected[4 * i + 2]) >>> 2;
    if (luma.data[i] !== light) throw new Error(`${name}: luma ${i}: ${luma.data[i]} != ${light}`);
  }
}

it('PNG: every filter, both interlace modes, RGB8', () => {
  const W = 37; // odd size stresses Adam7 edge passes
  const H = 23;
  for (const interlace of [0, 1]) {
    for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
      const rgba = new Uint8Array(W * H * 4);
      for (let i = 0; i < rgba.length; i++) rgba[i] = rand();
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      const png = makePng(W, H, rgba, { color: 2, depth: 8, interlace, filters });
      expectPixels(`rgb8 i${interlace} f${filters.join('')}`, png, rgba, W, H);
    }
  }
});

it('PNG: color types, bit depths, alpha onto white, tRNS', () => {
  const W = 37;
  const H = 23;
  const noise = (opaque: boolean) => {
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = rand();
    if (opaque) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    return rgba;
  };
  // RGBA8/16 with alpha, gray+alpha
  let rgba = noise(false);
  expectPixels(
    'rgba8',
    makePng(W, H, rgba, { color: 6, depth: 8, interlace: 1, filters: [4] }),
    rgba,
    W,
    H
  );
  rgba = noise(false);
  expectPixels('rgba16', makePng(W, H, rgba, { color: 6, depth: 16 }), rgba, W, H);
  rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const g = rand();
    rgba.set([g, g, g, rand()], i * 4);
  }
  expectPixels(
    'gray-alpha8',
    makePng(W, H, rgba, { color: 4, depth: 8, filters: [4] }),
    rgba,
    W,
    H
  );
  // grayscale depths
  for (const depth of [1, 2, 4, 8, 16]) {
    const max = depth < 8 ? (1 << depth) - 1 : 255;
    rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const g = depth < 8 ? (((rand() & max) * 255) / max) | 0 : rand();
      rgba.set([g, g, g, 255], i * 4);
    }
    expectPixels(
      `gray${depth}`,
      makePng(W, H, rgba, { color: 0, depth, filters: [depth === 16 ? 1 : 0] }),
      rgba,
      W,
      H
    );
  }
  // palette depths, tRNS at depth 4, interlaced at depth 8
  for (const depth of [1, 2, 4, 8]) {
    const n = 1 << depth;
    const palette = new Uint8Array(n * 3);
    for (let i = 0; i < palette.length; i++) palette[i] = rand();
    const trns = depth === 4 ? Uint8Array.from([rand(), rand(), rand()]) : undefined;
    const src = new Uint8Array(W * H * 4); // red channel = palette index
    rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const v = rand() & (n - 1);
      src[i * 4] = v;
      const a = trns && v < trns.length ? trns[v] : 255;
      rgba.set([palette[v * 3], palette[v * 3 + 1], palette[v * 3 + 2], a], i * 4);
    }
    const png = makePng(W, H, src, {
      color: 3,
      depth,
      palette,
      trns,
      interlace: depth === 8 ? 1 : 0,
    });
    expectPixels(`pal${depth}${trns ? '+trns' : ''}`, png, rgba, W, H);
  }
  // stored (uncompressed) deflate blocks
  rgba = noise(true);
  expectPixels('rgb8 stored', makePng(W, H, rgba, { color: 2, depth: 8, level: 0 }), rgba, W, H);
});

it('PNG: decodes through decodeQR via scale', () => {
  const text = 'PNG PIPELINE';
  const raw = encodeQR(text, 'raw', { ecc: 'medium' });
  const img = matrixToImage(raw, 1);
  const png = makePng(img.width, img.height, Uint8Array.from(img.data), { color: 2, depth: 8 });
  // 1px-per-module needs upscaling for run-length finder detection.
  deepStrictEqual(decodeQR(decodePNG(png, 4)), text);
  const exact = decodePNG(png, 4);
  deepStrictEqual({ w: exact.width, h: exact.height }, { w: img.width * 4, h: img.height * 4 });
});

it('PNG: real vectors match test/utils readPNG', () => {
  const root = join(_dirname, 'vectors', 'boofcv-v3');
  if (!existsSync(root)) return; // submodule not checked out
  let count = 0;
  for (const sub of ['decoding', 'detection/curved', 'detection/pathological']) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
      const rel = join(sub.replace('detection/', ''), f);
      const bytes = new Uint8Array(readFileSync(join(dir, f)));
      const mine = decodePNG(bytes);
      const ref = sub === 'decoding' ? readPNG(rel) : readPNG(join('detection', rel));
      deepStrictEqual({ w: mine.width, h: mine.height }, { w: ref.width, h: ref.height }, f);
      for (let i = 0; i < ref.width * ref.height; i++)
        for (let c = 0; c < 3; c++)
          if (mine.data[i * 4 + c] !== ref.data[i * 3 + c])
            throw new Error(`${f}: pixel ${i} channel ${c}`);
      count++;
    }
  }
  if (count === 0) throw new Error('no PNG vectors found');
});

it('PNG: rejects invalid input', () => {
  throws(() => decodePNG(new Uint8Array([1, 2, 3])), /not a PNG/);
  const rgba = new Uint8Array(16 * 16 * 4).fill(200);
  const png = makePng(16, 16, rgba, { color: 2, depth: 8 });
  throws(() => decodePNG(png, 0), /invalid scale/);
  throws(() => decodePNG(png, 1.5), /invalid scale/);
  throws(() => decodePNG(png.subarray(0, 60)), /PNG/); // truncated IDAT
  const badFilter = makePng(16, 16, rgba, { color: 2, depth: 8, filters: [7] });
  throws(() => decodePNG(badFilter), /invalid filter/);
});

it.runWhen(import.meta.url);
