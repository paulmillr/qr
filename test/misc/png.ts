/*!
 * Copyright (c) 2023 Paul Miller (paulmillr.com)
 * SPDX-License-Identifier: MIT OR Apache-2.0
 */
/**
 * Minimal PNG reader producing the RGBA `Image` shape `decodeQR` accepts.
 * Self-contained — includes a compact DEFLATE (RFC 1951) decompressor,
 * so it runs in any JS engine with no zlib dependency.
 * Handles every IHDR combination the spec allows (gray / RGB /
 * palette / gray+alpha / RGBA at bit depths 1–16), all five filters, Adam7
 * interlacing, and tRNS palette transparency. Alpha is composited onto white,
 * the QR quiet-zone color, so output pixels are always opaque. 16-bit
 * channels keep their high byte; ancillary chunks and CRCs are skipped.
 * @module
 */
import type { Image } from '../../src/decode.ts';

/**
 * Inflates a zlib-wrapped DEFLATE stream (the PNG IDAT payload) into `out`,
 * whose length must be the exact decompressed size — PNG makes it computable
 * up front, which doubles as an integrity check. Canonical-Huffman decoding in
 * the bit-at-a-time puff.c style: small and auditable over fast.
 */
function inflate(src: Uint8Array, out: Uint8Array): void {
  if ((src[0] & 0x0f) !== 8 || ((src[0] << 8) | src[1]) % 31 !== 0)
    throw new Error('PNG: invalid zlib header');
  let pos = 2;
  let acc = 0;
  let nbits = 0;
  let di = 0;
  const bits = (n: number): number => {
    while (nbits < n) {
      if (pos >= src.length) throw new Error('PNG: truncated stream');
      acc |= src[pos++] << nbits;
      nbits += 8;
    }
    const v = acc & ((1 << n) - 1);
    acc >>>= n;
    nbits -= n;
    return v;
  };
  // A canonical Huffman code is fully described by its per-length symbol
  // counts plus the symbols sorted by (length, value).
  type Huff = { count: Uint16Array; symbol: Uint16Array };
  const build = (lengths: Uint8Array): Huff => {
    const count = new Uint16Array(16);
    for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
    count[0] = 0;
    const offs = new Uint16Array(16);
    for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
    const symbol = new Uint16Array(lengths.length);
    for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
    return { count, symbol };
  };
  const decode = (h: Huff): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - first < count) return h.symbol[index + code - first];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('PNG: invalid huffman code');
  };
  // Length codes 257–285 and distance codes 0–29: each base is the previous
  // base plus 2^extra, except code 285 (length 258).
  const lext = new Uint8Array(29);
  const lbase = new Uint16Array(29);
  const dext = new Uint8Array(30);
  const dbase = new Uint16Array(30);
  for (let i = 0, b = 3; i < 29; i++, b += 1 << lext[i - 1]) {
    lext[i] = i < 8 || i === 28 ? 0 : (i - 4) >> 2;
    lbase[i] = i === 28 ? 258 : b;
  }
  for (let i = 0, b = 1; i < 30; i++, b += 1 << dext[i - 1]) {
    dext[i] = i < 4 ? 0 : (i >> 1) - 1;
    dbase[i] = b;
  }
  let fixedLit: Huff | undefined;
  let fixedDist: Huff | undefined;
  for (;;) {
    const last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored: realign to a byte boundary, then LEN + ~LEN.
      acc = nbits = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (di + len > out.length || pos + len > src.length)
        throw new Error('PNG: invalid stored block');
      out.set(src.subarray(pos, pos + len), di);
      pos += len;
      di += len;
    } else {
      let lit: Huff;
      let dist: Huff;
      if (type === 1) {
        if (!fixedLit) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
          fixedLit = build(l);
          fixedDist = build(new Uint8Array(30).fill(5));
        }
        lit = fixedLit;
        dist = fixedDist!;
      } else if (type === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const clens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clens[ORDER[i]] = bits(3);
        const ch = build(clens);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < lens.length; ) {
          const sym = decode(ch);
          if (sym < 16) lens[i++] = sym;
          else if (sym === 16) {
            if (i === 0) throw new Error('PNG: invalid code lengths');
            const prev = lens[i - 1];
            for (let r = 3 + bits(2); r > 0 && i < lens.length; r--) lens[i++] = prev;
          } else i += sym === 17 ? 3 + bits(3) : 11 + bits(7);
        }
        lit = build(lens.subarray(0, hlit));
        dist = build(lens.subarray(hlit));
      } else throw new Error('PNG: invalid block type');
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          if (di >= out.length) throw new Error('PNG: output overflow');
          out[di++] = sym;
        } else if (sym === 256) break;
        else {
          let len = lbase[sym - 257] + bits(lext[sym - 257]);
          const ds = decode(dist);
          const d = dbase[ds] + bits(dext[ds]);
          if (d > di || di + len > out.length) throw new Error('PNG: invalid backreference');
          for (; len > 0; len--, di++) out[di] = out[di - d];
        }
      }
    }
    if (last) break;
  }
  if (di !== out.length) throw new Error('PNG: length mismatch');
}

function paeth(a: number, b: number, c: number): number {
  const pa = Math.abs(b - c);
  const pb = Math.abs(a - c);
  const pc = Math.abs(a + b - 2 * c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Adam7 pass geometry: x0, y0, xStep, yStep. A single full pass otherwise.
const PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/**
 * Decodes a PNG into RGBA pixels.
 *
 * `scale` is an integer nearest-neighbor upscale factor. 1px-per-module
 * rasters are too small for the QR decoder's run-length detection, so pass
 * 2+ when the source is a tiny clean raster rather than a photo:
 *
 * ```js
 * const text = decodeQR(decodePNG(pngBytes, 4));
 * ```
 */
function decode(bytes: Uint8Array, scale: number, luma = false, output?: Uint8Array): Image {
  const b = bytes;
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47)
    throw new Error('not a PNG');
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 1024)
    throw new RangeError(`invalid scale factor: ${scale}`);
  const u32 = (q: number) => ((b[q] << 24) | (b[q + 1] << 16) | (b[q + 2] << 8) | b[q + 3]) >>> 0;
  let w = 0;
  let h = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let pal: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let zlen = 0;
  for (let p = 8; p + 8 <= b.length; ) {
    const len = u32(p);
    const type = u32(p + 4);
    p += 8;
    if (type === 0x49484452) {
      // IHDR
      w = u32(p);
      h = u32(p + 4);
      depth = b[p + 8];
      color = b[p + 9];
      if (b[p + 10] || b[p + 11] || b[p + 12] > 1)
        throw new Error('PNG: unsupported compression/filter/interlace');
      interlace = b[p + 12];
    } else if (type === 0x504c5445)
      pal = b.subarray(p, p + len); // PLTE
    else if (type === 0x74524e53)
      trns = b.subarray(p, p + len); // tRNS
    else if (type === 0x49444154) {
      // IDAT
      idat.push(b.subarray(p, p + len));
      zlen += len;
    } else if (type === 0x49454e44) break; // IEND
    p += len + 4; // skip CRC
  }
  const channels = [1, 0, 3, 1, 2, 0, 4][color] || 0;
  const okDepth =
    color === 2 || color === 4 || color === 6
      ? depth === 8 || depth === 16
      : color === 3
        ? depth <= 8 && (depth & (depth - 1)) === 0
        : depth <= 16 && (depth & (depth - 1)) === 0;
  if (!w || !h || !channels || !okDepth)
    throw new Error(`PNG: unsupported colorType=${color} bitDepth=${depth}`);
  if (color === 3 && !pal) throw new Error('PNG: missing palette');
  // Every pass geometry is known, so the exact unfiltered size is too.
  const passes = (interlace ? PASSES : [[0, 0, 1, 1]])
    .map(([x0, y0, dx, dy]) => {
      const pw = Math.ceil((w - x0) / dx);
      const ph = Math.ceil((h - y0) / dy);
      const rb = Math.ceil((pw * channels * depth) / 8);
      return { x0, y0, dx, dy, pw, ph, rb };
    })
    .filter((s) => s.pw > 0 && s.ph > 0);
  const z = new Uint8Array(zlen);
  for (let o = 0, i = 0; i < idat.length; o += idat[i++].length) z.set(idat[i], o);
  const raw = new Uint8Array(passes.reduce((sum, s) => sum + s.ph * (s.rb + 1), 0));
  inflate(z, raw);
  const W = w * scale;
  const H = h * scale;
  const length = W * H;
  if (output && output.length !== length)
    throw new Error(`expected ${length} luma bytes, got ${output.length}`);
  const data = luma ? output || new Uint8Array(length) : new Uint8Array(length * 4);
  data.fill(255);
  const paletteLuma = luma && pal ? new Uint8Array(pal.length / 3) : undefined;
  if (paletteLuma)
    for (let i = 0; i < paletteLuma.length; i++) {
      const al = trns && i < trns.length ? trns[i] : 255;
      const weight = 255 - al;
      const r = al === 255 ? pal![3 * i] : ((pal![3 * i] * al + 255 * weight + 127) / 255) | 0;
      const g =
        al === 255 ? pal![3 * i + 1] : ((pal![3 * i + 1] * al + 255 * weight + 127) / 255) | 0;
      const bl =
        al === 255 ? pal![3 * i + 2] : ((pal![3 * i + 2] * al + 255 * weight + 127) / 255) | 0;
      paletteLuma[i] = (r + 2 * g + bl) >>> 2;
    }
  const bpp = Math.ceil((channels * depth) / 8); // filter distance, min 1 byte
  const mask = (1 << depth) - 1;
  const gmul = depth < 8 ? 255 / mask : 1; // expand sub-byte gray to 0..255
  const step = depth === 16 ? 2 : 1; // 16-bit: keep the high byte
  let base = 0;
  for (const { x0, y0, dx, dy, pw, ph, rb } of passes) {
    for (let y = 0; y < ph; y++, base += rb + 1) {
      const filter = raw[base];
      if (filter > 4) throw new Error(`PNG: invalid filter ${filter}`);
      const row = base + 1;
      const prev = row - rb - 1; // previous row's unfiltered data, same pass
      for (let x = 0; x < rb; x++) {
        const a = x >= bpp ? raw[row + x - bpp] : 0;
        const u = y > 0 ? raw[prev + x] : 0;
        const c = y > 0 && x >= bpp ? raw[prev + x - bpp] : 0;
        raw[row + x] =
          filter === 0
            ? raw[row + x]
            : filter === 1
              ? raw[row + x] + a
              : filter === 2
                ? raw[row + x] + u
                : filter === 3
                  ? raw[row + x] + ((a + u) >> 1)
                  : raw[row + x] + paeth(a, u, c);
      }
      for (let x = 0; x < pw; x++) {
        let r;
        let g;
        let bl;
        let light = -1;
        let al = 255;
        if (depth < 8) {
          const bit = x * depth;
          const v = (raw[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
          if (color === 3) {
            if (luma) light = paletteLuma![v];
            else {
              r = pal![3 * v];
              g = pal![3 * v + 1];
              bl = pal![3 * v + 2];
              if (trns) al = v < trns.length ? trns[v] : 255;
            }
          } else light = r = g = bl = (v * gmul) | 0;
        } else {
          const s = row + x * channels * step;
          if (color === 3) {
            if (luma) light = paletteLuma![raw[s]];
            else {
              const v = raw[s];
              r = pal![3 * v];
              g = pal![3 * v + 1];
              bl = pal![3 * v + 2];
              if (trns) al = v < trns.length ? trns[v] : 255;
            }
          } else if (color === 2 || color === 6) {
            r = raw[s];
            g = raw[s + step];
            bl = raw[s + 2 * step];
            if (color === 6) al = raw[s + 3 * step];
          } else {
            light = r = g = bl = raw[s];
            if (color === 4) al = raw[s + step];
          }
        }
        if (light < 0 && al !== 255) {
          // Composite onto white, the QR quiet-zone color.
          const wgt = 255 - al;
          r = ((r * al + 255 * wgt + 127) / 255) | 0;
          g = ((g * al + 255 * wgt + 127) / 255) | 0;
          bl = ((bl * al + 255 * wgt + 127) / 255) | 0;
        } else if (light >= 0 && al !== 255)
          light = ((light * al + 255 * (255 - al) + 127) / 255) | 0;
        if (luma && light < 0) light = (r + 2 * g + bl) >>> 2;
        else if (!luma && light >= 0) r = g = bl = light;
        for (let sy = 0; sy < scale; sy++) {
          let o = ((y0 + y * dy) * scale + sy) * W + (x0 + x * dx) * scale;
          if (!luma) o *= 4;
          for (let sx = 0; sx < scale; sx++) {
            if (luma) data[o++] = light;
            else {
              data[o++] = r;
              data[o++] = g;
              data[o++] = bl;
              o++;
            }
          }
        }
      }
    }
  }
  return { width: W, height: H, data };
}

export function decodePNG(bytes: Uint8Array, scale = 1): Image {
  return decode(bytes, scale);
}

/** Extracts PNG luma while inflating scanlines, without materializing RGBA. */
export const decodePNGLuma = (bytes: Uint8Array, data?: Uint8Array): Image =>
  decode(bytes, 1, true, data);

export default decodePNG;
