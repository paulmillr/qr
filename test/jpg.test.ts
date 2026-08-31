import { it } from '@paulmillr/jsbt/test.js';
import { decode as jpegDecode, encode as jpegEncode } from 'jpeg-js';
import { deepStrictEqual, ok, throws } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import decodeQR from '../src/decode.ts';
import { encodeQR } from '../src/index.ts';
import { decodeJPEGLuma } from './imgcoder/jpeg.ts';
import { JPG_FIXTURES } from './misc/jpg-fixtures.ts';
import { decodeJPG } from './misc/jpg.ts';
import { _dirname, matrixToImage } from './utils.ts';

// JPEG decoders are only ever bit-close, not bit-identical: jpeg-js uses a
// fixed-point IDCT with integer conversion. This decoder uses an AAN float IDCT.
// 4 is a safe envelope for rounding differences; real bugs show up as tens.
function assertClose(
  name: string,
  mine: { width: number; height: number; data: Uint8Array | Uint8ClampedArray },
  ref: { width: number; height: number; data: Uint8Array | Buffer },
  tol = 4
) {
  deepStrictEqual({ w: mine.width, h: mine.height }, { w: ref.width, h: ref.height }, name);
  let maxd = 0;
  for (let i = 0; i < ref.data.length; i += 4)
    for (let c = 0; c < 3; c++)
      maxd = Math.max(maxd, Math.abs(mine.data[i + c] - ref.data[i + c]));
  if (maxd > tol) throw new Error(`${name}: maxDiff=${maxd} > ${tol}`);
}

it('JPG: fixtures (restart intervals, progressive, grayscale, 4:2:2)', () => {
  for (const [name, b64] of Object.entries(JPG_FIXTURES)) {
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    const mine = decodeJPG(bytes);
    assertClose(name, mine, jpegDecode(bytes));
    deepStrictEqual(decodeQR(mine), 'RESTART MARKER TEST', name);
    deepStrictEqual(
      decodeQR(decodeJPEGLuma(bytes), { format: 'I420' }),
      'RESTART MARKER TEST',
      name
    );
  }
});

it('JPG: jpeg-js encoder round-trips within tolerance', () => {
  // Gradient + noise: every block carries high-frequency coefficients, which
  // is what shook out the zig-zag and IDCT bugs during development.
  const W = 130;
  const H = 97;
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 12) & 255;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = (x * 2) & 255;
      rgba[i + 1] = (y * 3) & 255;
      rgba[i + 2] = rand();
      rgba[i + 3] = 255;
    }
  for (const quality of [70, 90]) {
    const jpg = new Uint8Array(jpegEncode({ width: W, height: H, data: rgba }, quality).data);
    assertClose(`q${quality}`, decodeJPG(jpg), jpegDecode(jpg));
  }
});

it('JPG: decodes through decodeQR', () => {
  const text = 'JPG PIPELINE';
  const img = matrixToImage(encodeQR(text, 'raw', { ecc: 'medium' }), 8);
  const jpg = new Uint8Array(
    jpegEncode({ width: img.width, height: img.height, data: Uint8Array.from(img.data) }, 90).data
  );
  deepStrictEqual(decodeQR(decodeJPG(jpg)), text);
  // scale: tiny raster upscaled at decode time
  const small = matrixToImage(encodeQR(text, 'raw', { ecc: 'medium' }), 2);
  const smallJpg = new Uint8Array(
    jpegEncode(
      { width: small.width, height: small.height, data: Uint8Array.from(small.data) },
      95
    ).data
  );
  deepStrictEqual(decodeQR(decodeJPG(smallJpg, 3)), text);
});

it('JPG: real vectors match jpeg-js (sampled per class)', () => {
  const root = join(_dirname, 'vectors', 'boofcv-v3', 'detection');
  if (!existsSync(root)) return; // submodule not checked out
  // One file per (SOF type, sampling) class; the full 510-file sweep is a
  // benchmark-time job, not a unit test.
  const classify = (b: Uint8Array): string => {
    for (let p = 2; p < b.length - 4; ) {
      if (b[p] !== 0xff) {
        p++;
        continue;
      }
      const m = b[p + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        p += 2;
        continue;
      }
      if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
        const nc = b[p + 9];
        const hv = b[p + 11];
        const mode = m === 0xc2 ? 'prog' : 'base';
        const color = nc === 1 ? 'gray' : `${hv >> 4}x${hv & 15}`;
        return `${mode}-${color}`;
      }
      if (m === 0xda) break;
      p += 2 + ((b[p + 2] << 8) | b[p + 3]);
    }
    return 'unknown';
  };
  const seen = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.jpe?g$/i.test(e.name)) {
        const cls = classify(new Uint8Array(readFileSync(full)));
        if (!seen.has(cls)) seen.set(cls, full);
      }
    }
  };
  walk(root);
  ok(seen.size >= 3, `expected several JPEG classes, got ${[...seen.keys()]}`);
  for (const [cls, file] of seen) {
    const bytes = new Uint8Array(readFileSync(file));
    assertClose(
      `${cls} ${file}`,
      decodeJPG(bytes),
      jpegDecode(bytes, { maxMemoryUsageInMB: 4096 })
    );
  }
});

it('JPG: rejects invalid input, tolerates truncation', () => {
  throws(() => decodeJPG(new Uint8Array([1, 2, 3])), /not a JPG/);
  const bytes = new Uint8Array(Buffer.from(JPG_FIXTURES.dri, 'base64'));
  throws(() => decodeJPG(bytes, 0), /invalid scale/);
  throws(() => decodeJPG(bytes, 1.5), /invalid scale/);
  throws(() => decodeJPG(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), /no frame/);
  // Lossless SOF3 must be rejected: patch the fixture's SOF0 marker.
  const lossless = bytes.slice();
  for (let i = 2; i < lossless.length - 1; i++)
    if (lossless[i] === 0xff && lossless[i + 1] === 0xc0) {
      lossless[i + 1] = 0xc3;
      break;
    }
  throws(() => decodeJPG(lossless), /unsupported codec/);
  // A truncated stream decodes what it has instead of throwing.
  const trunc = decodeJPG(bytes.subarray(0, (bytes.length / 2) | 0));
  deepStrictEqual({ w: trunc.width, h: trunc.height }, { w: 100, h: 100 });
});

it.runWhen(import.meta.url);
