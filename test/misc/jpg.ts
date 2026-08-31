/*!
 * Copyright (c) 2023 Paul Miller (paulmillr.com)
 * SPDX-License-Identifier: MIT OR Apache-2.0
 */
/**
 * Minimal JPEG reader producing the RGBA `Image` shape `decodeQR` accepts.
 * Handles baseline and progressive DCT
 * (SOF0/1/2) — both occur in this library's own photo test vectors — with
 * 8-bit precision, grayscale and YCbCr color (the JFIF norm; exotic Adobe
 * RGB/YCCK transforms are not detected), any sampling factors, restart
 * intervals, and truncated streams (decodes what's there). The IDCT is the
 * AAN float factorization with quantization tables pre-scaled by the AAN
 * constants. Lossless, arithmetic-coded, hierarchical and 12-bit variants
 * are rejected. Measured ~1.5–1.8× faster than jpeg-js, matching it within
 * ±4/channel on all 510 photo vectors.
 * @module
 */
import type { Image } from '../../src/decode.ts';

// JPEG zig-zag scan order -> natural (row-major) block index.
const ZIGZAG = /* @__PURE__ */ (() => {
  const z = new Uint8Array(64);
  for (let k = 0, x = 0, y = 0; k < 64; k++) {
    z[k] = 8 * y + x;
    if ((x + y) & 1) {
      if (y === 7) x++;
      else if (x === 0) y++;
      else (x--, y++);
    } else {
      if (x === 7) y++;
      else if (y === 0) x++;
      else (x++, y--);
    }
  }
  return z;
})();

type Huff = { min: Int32Array; max: Int32Array; ptr: Int32Array; vals: Uint8Array };
type Comp = {
  id: number;
  h: number;
  v: number;
  tq: number;
  bw: number; // blocks per line (real image area)
  bh: number; // blocks per column
  pw: number; // blocks per line, padded to whole MCUs
  ph: number;
  coeffs: Int16Array;
  pred: number;
  plane: Uint8ClampedArray;
};
type ScanComp = { c: Comp; dc?: Huff; ac?: Huff };

/**
 * Decodes a JPEG into RGBA pixels (alpha always 255).
 *
 * `scale` is an integer nearest-neighbor upscale factor for tiny clean
 * rasters; photos should keep the default 1:
 *
 * ```js
 * const text = decodeQR(decodeJPG(jpgBytes));
 * ```
 */
function decode(bytes: Uint8Array, scale: number, luma = false, output?: Uint8Array): Image {
  const b = bytes;
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPG');
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 1024)
    throw new RangeError(`invalid scale factor: ${scale}`);
  let p = 2;
  let w = 0;
  let h = 0;
  let progressive = false;
  let comps: Comp[] = [];
  let hmax = 1;
  let vmax = 1;
  let mcusX = 0;
  let mcusY = 0;
  let ri = 0; // restart interval, in MCUs
  const qtabs: (Int32Array | undefined)[] = [];
  const dcTabs: (Huff | undefined)[] = [];
  const acTabs: (Huff | undefined)[] = [];

  // Entropy-coded bit reader. 0xFF00 is a stuffed data byte; a real marker
  // stops the feed (zeros are supplied) and is left for the segment parser.
  let bitBuf = 0;
  let bitCnt = 0;
  const nextByte = (): number => {
    const v = b[p];
    if (v === undefined) return -1;
    if (v === 0xff) {
      if (b[p + 1] !== 0) return -1;
      p += 2;
      return 0xff;
    }
    p++;
    return v;
  };
  const readBit = (): number => {
    if (bitCnt === 0) {
      const v = nextByte();
      bitBuf = v < 0 ? 0 : v;
      bitCnt = 8;
    }
    return (bitBuf >>> --bitCnt) & 1;
  };
  const receive = (n: number): number => {
    while (bitCnt < n) {
      const v = nextByte();
      bitBuf = (bitBuf << 8) | (v < 0 ? 0 : v);
      bitCnt += 8;
    }
    bitCnt -= n;
    return (bitBuf >>> bitCnt) & ((1 << n) - 1);
  };
  const extend = (n: number): number => {
    const v = receive(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  };
  const buildHuff = (counts: Uint8Array, vals: Uint8Array): Huff => {
    const min = new Int32Array(17);
    const max = new Int32Array(17).fill(-1);
    const ptr = new Int32Array(17);
    for (let len = 1, code = 0, k = 0; len <= 16; len++) {
      const c = counts[len - 1];
      min[len] = code;
      ptr[len] = k;
      if (c > 0) max[len] = code + c - 1;
      k += c;
      code = (code + c) << 1;
    }
    return { min, max, ptr, vals };
  };
  const huffDecode = (t: Huff): number => {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit();
      if (code <= t.max[len]) return t.vals[t.ptr[len] + code - t.min[len]];
    }
    throw new Error('JPG: invalid huffman code');
  };

  const decodeScan = (scomps: ScanComp[], ss: number, se: number, ah: number, al: number) => {
    bitCnt = 0;
    let eobrun = 0;
    for (const s of scomps) s.c.pred = 0;
    const refine = (co: Int16Array, i: number, p1: number) => {
      if (readBit() && (co[i] & p1) === 0) co[i] += co[i] >= 0 ? p1 : -p1;
    };
    const block = (s: ScanComp, off: number): void => {
      const co = s.c.coeffs;
      if (!progressive) {
        const t = huffDecode(s.dc!);
        s.c.pred += t ? extend(t) : 0;
        co[off] = s.c.pred;
        for (let k = 1; k < 64; ) {
          const rs = huffDecode(s.ac!);
          const r = rs >> 4;
          if (!(rs & 15)) {
            if (r !== 15) break;
            k += 16;
            continue;
          }
          k += r;
          if (k > 63) break;
          co[off + ZIGZAG[k++]] = extend(rs & 15);
        }
      } else if (ss === 0) {
        // DC: first scan carries huffman-coded diffs, later ones a raw bit.
        if (ah === 0) {
          const t = huffDecode(s.dc!);
          s.c.pred += t ? extend(t) << al : 0;
          co[off] = s.c.pred;
        } else co[off] |= readBit() << al;
      } else if (ah === 0) {
        // AC first scan: EOB runs span whole blocks of the band.
        if (eobrun > 0) {
          eobrun--;
          return;
        }
        for (let k = ss; k <= se; ) {
          const rs = huffDecode(s.ac!);
          const r = rs >> 4;
          if (!(rs & 15)) {
            if (r < 15) {
              eobrun = (1 << r) - 1 + (r ? receive(r) : 0);
              break;
            }
            k += 16;
            continue;
          }
          k += r;
          if (k > 63) break;
          co[off + ZIGZAG[k++]] = extend(rs & 15) * (1 << al);
        }
      } else {
        // AC refinement: every already-nonzero coefficient passed over gets a
        // correction bit; zero-run counts skip only still-zero positions.
        const p1 = 1 << al;
        let k = ss;
        if (eobrun === 0) {
          while (k <= se) {
            const rs = huffDecode(s.ac!);
            let r = rs >> 4;
            let val = 0;
            if (!(rs & 15)) {
              if (r < 15) {
                // Unlike the first-scan EOB below, the current block still
                // owes correction bits: the run is consumed by the tail loop.
                eobrun = (1 << r) + (r ? receive(r) : 0);
                break;
              }
            } else val = readBit() ? p1 : -p1;
            while (k <= se) {
              const i = off + ZIGZAG[k];
              if (co[i] !== 0) refine(co, i, p1);
              else if (r === 0) {
                if (val) co[i] = val;
                k++;
                break;
              } else r--;
              k++;
            }
          }
        }
        if (eobrun > 0) {
          for (; k <= se; k++) {
            const i = off + ZIGZAG[k];
            if (co[i] !== 0) refine(co, i, p1);
          }
          eobrun--;
        }
      }
    };
    // Non-interleaved scans (all progressive AC scans, single-component
    // frames) walk the component's real blocks; interleaved ones walk MCUs.
    const one = scomps.length === 1;
    const total = one ? scomps[0].c.bw * scomps[0].c.bh : mcusX * mcusY;
    let mcu = 0;
    while (mcu < total) {
      for (let n = Math.min(ri || total, total - mcu); n > 0; n--, mcu++) {
        if (one) {
          const c = scomps[0].c;
          block(scomps[0], ((((mcu / c.bw) | 0) * c.pw + (mcu % c.bw)) * 64) | 0);
        } else {
          const my = (mcu / mcusX) | 0;
          const mx = mcu % mcusX;
          for (const s of scomps)
            for (let v = 0; v < s.c.v; v++)
              for (let hh = 0; hh < s.c.h; hh++)
                block(s, ((my * s.c.v + v) * s.c.pw + mx * s.c.h + hh) * 64);
        }
      }
      if (mcu < total) {
        // Restart boundary: byte-align, eat RSTn, reset predictors.
        bitCnt = 0;
        if (b[p] === 0xff && (b[p + 1] & 0xf8) === 0xd0) p += 2;
        else break; // corrupt: keep what decoded
        for (const s of scomps) s.c.pred = 0;
        eobrun = 0;
      }
    }
    bitCnt = 0;
  };

  while (p < b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const m = b[p + 1];
    p += 2;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9) break; // EOI
    const end = p + ((b[p] << 8) | b[p + 1]);
    let q = p + 2;
    if (m === 0xdb) {
      // DQT: one or more tables, values in zig-zag order, 8- or 16-bit.
      while (q < end) {
        const pq = b[q] >> 4;
        const t = new Int32Array(64);
        qtabs[b[q++] & 15] = t;
        for (let i = 0; i < 64; i++, q += pq ? 2 : 1)
          t[ZIGZAG[i]] = pq ? (b[q] << 8) | b[q + 1] : b[q];
      }
    } else if (m === 0xc4) {
      // DHT: one or more tables: 16 length counts, then symbols.
      while (q < end) {
        const tc = b[q] >> 4;
        const th = b[q++] & 15;
        let n = 0;
        for (let i = 0; i < 16; i++) n += b[q + i];
        const huff = buildHuff(b.subarray(q, q + 16), b.subarray(q + 16, q + 16 + n));
        (tc ? acTabs : dcTabs)[th] = huff;
        q += 16 + n;
      }
    } else if (m === 0xdd) {
      ri = (b[q] << 8) | b[q + 1]; // DRI
    } else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      if (comps.length) throw new Error('JPG: multiple frames');
      progressive = m === 0xc2;
      if (b[q] !== 8) throw new Error('JPG: only 8-bit precision supported');
      h = (b[q + 1] << 8) | b[q + 2];
      w = (b[q + 3] << 8) | b[q + 4];
      const nc = b[q + 5];
      if (!w || !h || w * h > 1 << 28) throw new Error('JPG: invalid dimensions');
      if (nc !== 1 && nc !== 3) throw new Error(`JPG: unsupported component count ${nc}`);
      q += 6;
      for (let i = 0; i < nc; i++, q += 3) {
        const ch = b[q + 1] >> 4;
        const cv = b[q + 1] & 15;
        if (!ch || !cv || ch > 4 || cv > 4) throw new Error('JPG: invalid sampling');
        comps.push({
          id: b[q],
          h: ch,
          v: cv,
          tq: b[q + 2],
          bw: 0,
          bh: 0,
          pw: 0,
          ph: 0,
          coeffs: new Int16Array(0),
          pred: 0,
          plane: new Uint8ClampedArray(0),
        });
      }
      for (const c of comps) {
        hmax = Math.max(hmax, c.h);
        vmax = Math.max(vmax, c.v);
      }
      mcusX = Math.ceil(w / (8 * hmax));
      mcusY = Math.ceil(h / (8 * vmax));
      for (const c of comps) {
        c.bw = Math.ceil(Math.ceil((w * c.h) / hmax) / 8);
        c.bh = Math.ceil(Math.ceil((h * c.v) / vmax) / 8);
        c.pw = mcusX * c.h;
        c.ph = mcusY * c.v;
        c.coeffs = new Int16Array(c.pw * c.ph * 64);
      }
    } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc8 && m !== 0xcc) {
      throw new Error('JPG: unsupported codec (lossless/arithmetic/hierarchical)');
    } else if (m === 0xda) {
      // SOS
      if (!comps.length) throw new Error('JPG: scan before frame');
      const ns = b[q++];
      const scomps: ScanComp[] = [];
      for (let i = 0; i < ns; i++, q += 2) {
        const c = comps.find((c) => c.id === b[q]);
        if (!c) throw new Error('JPG: unknown scan component');
        scomps.push({ c, dc: dcTabs[b[q + 1] >> 4], ac: acTabs[b[q + 1] & 15] });
      }
      const ss = b[q];
      const se = b[q + 1];
      const ah = b[q + 2] >> 4;
      const al = b[q + 2] & 15;
      if (se > 63 || ss > se) throw new Error('JPG: invalid spectral range');
      const needDC = ss === 0 && !(progressive && ah > 0);
      const needAC = progressive ? ss > 0 : true;
      for (const s of scomps)
        if ((needDC && !s.dc) || (needAC && !s.ac)) throw new Error('JPG: missing huffman table');
      if (progressive && ss > 0 && ns !== 1) throw new Error('JPG: invalid progressive scan');
      p = end;
      decodeScan(scomps, progressive ? ss : 0, progressive ? se : 63, ah, al);
      continue;
    }
    p = end; // everything else (APPn, COM, DNL...) is skipped
  }
  if (!comps.length) throw new Error('JPG: no frame');
  const lumaLength = w * h;
  if (output && output.length !== lumaLength)
    throw new Error(`expected ${lumaLength} luma bytes, got ${output.length}`);
  const lumaData = luma ? output || new Uint8Array(lumaLength) : undefined;
  const lumaDirect = luma && comps[0].h === hmax && comps[0].v === vmax;

  // Dequantize + IDCT every block into per-component sample planes. AAN float
  // butterflies; the AAN scale factors and the overall 1/8 are folded into the
  // quantization multipliers, the +128 level shift into the clamped store.
  const aan = new Float32Array(8).fill(1);
  for (let k = 1; k < 8; k++) aan[k] = Math.cos((k * Math.PI) / 16) * Math.SQRT2;
  const ws = new Float32Array(64);
  for (let ci = 0; ci < comps.length; ci++) {
    const c = comps[ci];
    if (luma && ci > 0) {
      c.coeffs = new Int16Array(0);
      continue;
    }
    const qt = qtabs[c.tq];
    if (!qt) throw new Error('JPG: missing quant table');
    const qs = new Float32Array(64);
    for (let i = 0; i < 64; i++) qs[i] = (qt[i] * aan[i >> 3] * aan[i & 7]) / 8;
    const stride = lumaDirect ? w : c.pw * 8;
    const plane = (c.plane = lumaDirect
      ? new Uint8ClampedArray(lumaData!.buffer, lumaData!.byteOffset, lumaData!.byteLength)
      : new Uint8ClampedArray(stride * c.ph * 8));
    const co = c.coeffs;
    for (let by = 0; by < c.ph; by++) {
      for (let bx = 0; bx < c.pw; bx++) {
        const off = (by * c.pw + bx) * 64;
        const rows = lumaDirect ? Math.min(8, h - by * 8) : 8;
        const cols = lumaDirect ? Math.min(8, w - bx * 8) : 8;
        if (rows <= 0 || cols <= 0) continue;
        let blockAC = 0;
        for (let i = 0; i < 8; i++) {
          // Column pass; constant column when every AC term is zero.
          const vertical =
            co[off + i + 8] |
            co[off + i + 16] |
            co[off + i + 24] |
            co[off + i + 32] |
            co[off + i + 40] |
            co[off + i + 48] |
            co[off + i + 56];
          blockAC |= vertical | (i ? co[off + i] : 0);
          if (!vertical) {
            const dc = co[off + i] * qs[i];
            for (let r = 0; r < 64; r += 8) ws[i + r] = dc;
            continue;
          }
          const t10 = co[off + i] * qs[i] + co[off + i + 32] * qs[i + 32];
          const t11 = co[off + i] * qs[i] - co[off + i + 32] * qs[i + 32];
          const d2 = co[off + i + 16] * qs[i + 16];
          const d6 = co[off + i + 48] * qs[i + 48];
          const t13 = d2 + d6;
          const t12 = (d2 - d6) * 1.414213562 - t13;
          const e0 = t10 + t13;
          const e3 = t10 - t13;
          const e1 = t11 + t12;
          const e2 = t11 - t12;
          const d1 = co[off + i + 8] * qs[i + 8];
          const d3 = co[off + i + 24] * qs[i + 24];
          const d5 = co[off + i + 40] * qs[i + 40];
          const d7 = co[off + i + 56] * qs[i + 56];
          const z13 = d5 + d3;
          const z10 = d5 - d3;
          const z11 = d1 + d7;
          const z12 = d1 - d7;
          const o7 = z11 + z13;
          const z5 = (z10 + z12) * 1.847759065;
          const o6 = 1.414213562 * (z11 - z13); // becomes tmp11 in jidctflt
          const t6 = -2.61312593 * z10 + z5 - o7;
          const t5 = o6 - t6;
          const t4 = 1.0823922 * z12 - z5 + t5;
          ws[i] = e0 + o7;
          ws[i + 56] = e0 - o7;
          ws[i + 8] = e1 + t6;
          ws[i + 48] = e1 - t6;
          ws[i + 16] = e2 + t5;
          ws[i + 40] = e2 - t5;
          ws[i + 32] = e3 + t4;
          ws[i + 24] = e3 - t4;
        }
        let out = by * 8 * stride + bx * 8;
        if (!blockAC) {
          const value = 128 + co[off] * qs[0];
          for (let y = 0; y < rows; y++, out += stride) plane.fill(value, out, out + cols);
          continue;
        }
        for (let r = 0; r < rows * 8; r += 8, out += stride) {
          const t10 = ws[r] + ws[r + 4];
          const t11 = ws[r] - ws[r + 4];
          const t13 = ws[r + 2] + ws[r + 6];
          const t12 = (ws[r + 2] - ws[r + 6]) * 1.414213562 - t13;
          const e0 = t10 + t13;
          const e3 = t10 - t13;
          const e1 = t11 + t12;
          const e2 = t11 - t12;
          const z13 = ws[r + 5] + ws[r + 3];
          const z10 = ws[r + 5] - ws[r + 3];
          const z11 = ws[r + 1] + ws[r + 7];
          const z12 = ws[r + 1] - ws[r + 7];
          const o7 = z11 + z13;
          const z5 = (z10 + z12) * 1.847759065;
          const t6 = -2.61312593 * z10 + z5 - o7;
          const t5 = 1.414213562 * (z11 - z13) - t6;
          const t4 = 1.0823922 * z12 - z5 + t5;
          if (cols === 8) {
            plane[out] = 128 + e0 + o7;
            plane[out + 7] = 128 + e0 - o7;
            plane[out + 1] = 128 + e1 + t6;
            plane[out + 6] = 128 + e1 - t6;
            plane[out + 2] = 128 + e2 + t5;
            plane[out + 5] = 128 + e2 - t5;
            plane[out + 4] = 128 + e3 + t4;
            plane[out + 3] = 128 + e3 - t4;
          } else {
            plane[out] = 128 + e0 + o7;
            if (cols > 1) plane[out + 1] = 128 + e1 + t6;
            if (cols > 2) plane[out + 2] = 128 + e2 + t5;
            if (cols > 3) plane[out + 3] = 128 + e3 - t4;
            if (cols > 4) plane[out + 4] = 128 + e3 + t4;
            if (cols > 5) plane[out + 5] = 128 + e2 - t5;
            if (cols > 6) plane[out + 6] = 128 + e1 - t6;
          }
        }
      }
    }
    c.coeffs = new Int16Array(0);
  }

  if (luma) {
    if (!lumaDirect) {
      const c = comps[0];
      for (let y = 0, dst = 0; y < h; y++) {
        const row = (((y * c.v) / vmax) | 0) * c.pw * 8;
        for (let x = 0; x < w; x++) lumaData![dst++] = c.plane[row + (((x * c.h) / hmax) | 0)];
      }
    }
    return { width: w, height: h, data: lumaData! };
  }

  // Upsample subsampled chroma (nearest) and convert to RGBA.
  const W = w * scale;
  const H = h * scale;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const xmaps = comps.map((c) => {
    const xm = new Int32Array(w);
    for (let x = 0; x < w; x++) xm[x] = ((x * c.h) / hmax) | 0;
    return xm;
  });
  const gray = comps.length === 1;
  const [c0, c1, c2] = comps;
  for (let y = 0; y < h; y++) {
    const o0 = (((y * c0.v) / vmax) | 0) * c0.pw * 8;
    const o1 = gray ? 0 : (((y * c1.v) / vmax) | 0) * c1.pw * 8;
    const o2 = gray ? 0 : (((y * c2.v) / vmax) | 0) * c2.pw * 8;
    for (let x = 0; x < w; x++) {
      const Y = c0.plane[o0 + xmaps[0][x]];
      let r = Y;
      let g = Y;
      let bl = Y;
      if (!gray) {
        const cb = c1.plane[o1 + xmaps[1][x]] - 128;
        const cr = c2.plane[o2 + xmaps[2][x]] - 128;
        r = Y + 1.402 * cr;
        g = Y - 0.344136 * cb - 0.714136 * cr;
        bl = Y + 1.772 * cb;
      }
      for (let sy = 0; sy < scale; sy++) {
        let o = ((y * scale + sy) * W + x * scale) * 4;
        for (let sx = 0; sx < scale; sx++, o += 4) {
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = bl;
        }
      }
    }
  }
  return { width: W, height: H, data };
}

export function decodeJPG(bytes: Uint8Array, scale = 1): Image {
  return decode(bytes, scale);
}

/** Extracts JPEG's Y component directly, skipping chroma IDCT and RGBA conversion. */
export const decodeJPEGLuma = (bytes: Uint8Array, data?: Uint8Array): Image =>
  decode(bytes, 1, true, data);

export default decodeJPG;
