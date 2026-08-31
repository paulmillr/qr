import { it } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import { cpus } from 'node:os';
import { runInNewContext } from 'node:vm';
import * as _enc2 from '../src/index.ts';
import encodeQR, { _tests as _enc } from '../src/index.ts';
import { bmToASCII, bmToRaw, jsonGZItems, normalizeWorkerCount } from './utils.ts';

// Minimal boolean bit-matrix, standing in for decode.ts's (now-removed)
// Bitmap class: this file only ever needs get/set/border to visualize and
// compare the encoder's internal Mat output, nothing decode-specific.
class Bitmap {
  width: number;
  height: number;
  data: boolean[];
  constructor(size: number | { width: number; height: number }) {
    const { width, height } = typeof size === 'number' ? { width: size, height: size } : size;
    this.width = width;
    this.height = height;
    this.data = new Array(width * height).fill(false);
  }
  get(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.data[y * this.width + x];
  }
  set(x: number, y: number, v: boolean): void {
    this.data[y * this.width + x] = v;
  }
  border(size: number, value = false): Bitmap {
    const out = new Bitmap({ width: this.width + 2 * size, height: this.height + 2 * size });
    if (value) out.data.fill(true);
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) out.set(x + size, y + size, this.get(x, y));
    return out;
  }
}

// Adapters over the rewritten encoder's internals: it works on packed square
// bit matrices (Mat) instead of Bitmap, so convert for the vector tests.
const matToBitmap = (m) => {
  const b = new Bitmap(m.size);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) b.set(x, y, _enc.matGet(m, x, y) === 1);
  }
  return b;
};
const bitmapToMat = (b) => {
  if (b.width !== b.height) throw new Error('square only');
  const m = _enc.mat(b.width);
  for (let y = 0; y < b.width; y++) {
    for (let x = 0; x < b.width; x++)
      if (b.get(x, y)) m.v[y * m.words + (x >>> 5)] |= 1 << (x & 31);
  }
  return m;
};
const _tests = {
  Bitmap,
  detectType: _enc.detectType,
  encode: (ver, ecc, text, type) =>
    _enc.encodeData(
      ver,
      ecc,
      text,
      type,
      type === 'byte' ? new TextEncoder().encode(text) : undefined
    ),
  drawQR: (ver, ecc, data, mask, test = false) =>
    matToBitmap(_enc.drawSymbol(ver, ecc, data, mask, test)),
  penalty: (bm) => {
    const m = bm instanceof Bitmap ? bitmapToMat(bm) : bm;
    return _enc.penalty(m, _enc.mat(m.size));
  },
};

it('qr v1', () => {
  const v1_data = new Uint8Array([
    32, 9, 64, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 203, 10, 29,
    40, 162, 45, 18,
  ]);
  const v1 = _tests.drawQR(1, 'low', v1_data, 0).border(2);
  deepStrictEqual(
    bmToASCII(v1),
    `
█████████████████████████
██ ▄▄▄▄▄ ██ ▀ ▄█ ▄▄▄▄▄ ██
██ █   █ █▄ █ ▄█ █   █ ██
██ █▄▄▄█ ███▄█ █ █▄▄▄█ ██
██▄▄▄▄▄▄▄█ ▀▄▀ █▄▄▄▄▄▄▄██
██▄  ▀▄▄▄ ▄▄ ▄█▄ ███ ▀███
███▀█▄▄ ▄▀▀▀ █▄█▀█▄█▀▀▄██
██▄▄▄█▄▄▄█  █▀▄▀▄▀▄▀▄▄▄██
██ ▄▄▄▄▄ █ ▀  ▀ ▄ ▀ ▄▀███
██ █   █ █▄▀█▄█▄ ▄█▄ ▀▄██
██ █▄▄▄█ █ ▄ █▄█▀█▄█▀▀ ██
██▄▄▄▄▄▄▄█▄▄▄█▄█▄█▄█▄█▄██
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`.replace('\n', '')
  );
});

it('qr v5', () => {
  const v5_data = new Uint8Array([
    32, 9, 64, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17,
    236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236,
    17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17,
    236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236,
    17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17,
    236, 17, 236, 70, 127, 85, 241, 187, 169, 44, 239, 53, 251, 49, 213, 252, 27, 247, 26, 174,
    115, 28, 158, 228, 203, 151, 46, 173, 141,
  ]);
  const v5 = _tests.drawQR(5, 'low', v5_data, 0).border(2);
  deepStrictEqual(
    bmToASCII(v5),
    `
█████████████████████████████████████████
██ ▄▄▄▄▄ ██▀▄██▀▄██▀▄██▀▄██▀▄███ ▄▄▄▄▄ ██
██ █   █ █▄▀█▄▀▀█▄▀▀█▄▀▀█▄▀▀█▄▀█ █   █ ██
██ █▄▄▄█ ██▄▀▀ ▄▀▀ ▄▀▀ ▄▀▀ ▄▀▀ █ █▄▄▄█ ██
██▄▄▄▄▄▄▄█ █▄▀▄█▄▀▄█▄▀▄█▄▀▄█▄▀▄█▄▄▄▄▄▄▄██
██ ▄ ▀ ▄▄  ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀  ▄█▀█ ████
██▄███▀▄▄▀▀▀█▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ █▄█▀█▀█▄██
███▄██▄ ▄ █ █ ██  ██  ██  ██  ██▄ ▄▀▄▀▄██
██▀▀ █ █▄██▄▀▀█▄█▀█▄█▀█▄█▀█▄█▀█ ▀ ▄ ▄ ▀██
██▀ ▀█▀█▄██ ▀▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀  ██ ▄ ▄███
██▀▀█ █▄▄▄▀▀▀▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ █▄█▀█▀█▄██
██ ▄███▄▄ ▀█▀ ██  ██  ██  ██  ██▄ ▄▀▄▀▄██
██ ▀█  █▄██ ▀▀█▄█▀█▄█▀█▄█▀█▄█▀█ ▀ ▄ ▄ ▀██
██▄▄  ▀▀▄█▀█ ▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀  ██ ▄  ███
██▄▀ ▄▀▀▄▄ ▄ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ █▄█▀█▀▀▄██
██▄█▄██▄▄▄ ▄  ██  ██  ██  ██ ▄ ▄▄▄ ▀▄▄▄██
██ ▄▄▄▄▄ █ ▄▄▀█▄█▀█▄█▀█▄█▀█▄█▀ █▄█  ▄▀███
██ █   █ █▄▀ ▀ ▀█▀ ▀█▀ ▀█▀ ▀██▄ ▄▄▄▄ ▀▄██
██ █▄▄▄█ █ ▄▄▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▀▄▄ █▄█▀▀ ██
██▄▄▄▄▄▄▄█▄██▄██▄▄██▄▄██▄▄██▄▄████▄█▄█▄██
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`.replace('\n', '')
  );
});

it('qr v10', () => {
  const v10_data = new Uint8Array([
    32, 236, 236, 17, 2, 17, 17, 236, 80, 236, 236, 17, 0, 17, 17, 236, 236, 236, 236, 17, 17, 17,
    17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236,
    17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236,
    236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17,
    17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236,
    236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17,
    236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17,
    17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236,
    236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17,
    17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236,
    17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236,
    236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17,
    17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 236, 236, 17, 17, 17, 17, 236, 236, 17,
    72, 86, 39, 17, 6, 191, 118, 111, 152, 83, 190, 181, 29, 81, 145, 123, 225, 59, 99, 65, 203,
    59, 213, 241, 60, 236, 119, 29, 20, 136, 195, 197, 97, 83, 226, 109, 151, 173, 240, 239, 161,
    10, 21, 196, 53, 183, 189, 219, 2, 26, 47, 234, 144, 127, 51, 136, 245, 248, 234, 111, 113, 52,
    253, 151, 77, 143, 120, 17, 130, 234, 89, 223,
  ]);
  const v10 = _tests.drawQR(10, 'low', v10_data, 0).border(2);
  deepStrictEqual(
    bmToASCII(v10),
    `
█████████████████████████████████████████████████████████████
██ ▄▄▄▄▄ ██▄ ▄▄ ▄█▄█  ▀ ▄█▄ ██▀█▄ ▄ ██▀█▄ ▄ ██▀█▄ ██ ▄▄▄▄▄ ██
██ █   █ █▄ █▄▀ ▄█▄█▀ █ ▄█▄█▄█ █▄ ▄ ▀█ █▄ ▄ ▀█ ▀▄ ██ █   █ ██
██ █▄▄▄█ ██ ▄█▀ ▄█▄█  ▀ ▄█▄▀ ▄▄▄  ▄ ██▀█▄ ▄ ██▀█▀▄██ █▄▄▄█ ██
██▄▄▄▄▄▄▄█ █ ▀▄█▄▀▄▀ █ █▄▀▄▀ █▄█ █▄▀▄▀▄█ █▄▀▄▀▄█ ▀▄█▄▄▄▄▄▄▄██
██   █  ▄▄  █ ▀█▄█  █ ▄█▄█  ▄   ▄█▄ ▄ ▀█▀█▄ ▄ ▀█▀ ▄▄ ▀▀▀▄████
██  ▀▄█▄▄██ ▀█  ▀█▀█▄ ▄ ▀█▀ ▄ █▄ ▀▄ ▄▄██ ▀▄ ▄▄██  ▄█  █▀▄█▄██
██▀█ ▀▀▄▄▄  █ ▄ ██ █▄ ▄ ██  ▄ ▀█▀ ▀ ▄█▄█▀ ▀ ▄█▄█▀ ▄█▀ ▀▀▄▀▄██
███▀█ ▀█▄▀▄▄ █▄ ▀█▀█▄ ▄ ▀█▀ ▄ ██  █ ▄█▄█  █ ▄█▄█  ▄▀▄ █ ▄ ▀██
██▀ █▀██▄ ▄▄  █ ██ █▄ ▄ ██  ▄ ▀█▀ ▀ ▄█▄█▀ ▀ ▄█▄█▀ ▄ ▄ ▀ ▄ ███
██▄ ▀ █ ▄▄██▄███▄█▀█▄ ▄ ▀█▀ ▄▄██  █ ▄█▄█  █ ▄█▄█  ▄ ▄▄█ ▄ ▀██
██▀▄▀▄▄▀▄▄▄▄█ ▀█▄█ █▄ ▄ ██ ▄ █▄█▀ ▀ ▄█▄█▀ ▀ ▄█▄█▀█  ▄█▄▄  ███
██▀█  ▄ ▄▀ █▄ █ ▄█▀█▄ ▄ ▀█▀█▀█▄█  █▄ █▄▀▄ █▄ █▄▀▄█▀ ▄█▄█▀█▄██
██▄ ▄▄██▄▀█ ▄ ▄▀█ ▄█▄█  █ ▄█ █▄█▀ ▀█▀█▄ ▄ ▀█▀█▄ ▄█  ▄█▄█  ▄██
██ ▀ ▄ ▄▄▄ ▀██▀▄▄ ▄ ▀█▀█▄ ▄  ▄▄▄ ▄██ ▀▄ ▄▄██ ▀▄ ▄█ ▄▄▄ █▀ ▀██
██ ▀▄█ █▄█ ▀█ ▀   ▄ ██ █▄ ▄▄ █▄█ █▄█▀ ▀ ▄█▄█▀ ▀ ▄▄ █▄█ █ ▄███
██▄ ▀▄▄▄▄ ▄ █▄█▀  ▄ ▀█▀█▄ ▄█▄ ▄ ▄█▄█  █ ▄█▄█  █ ▄▀ ▄▄ ▄█▀█▄██
██▄█▀▀▄█▄ ▄█  ▄▄  ▄ ██ █▄ ▄▄█ ▄█▄█▄█▀ ▀ ▄█▄█▀ ▀ ▄▄ █▄ ▄█ █▄██
███▄▀▄▀▄▄▀▀ █  █▄ ▄ ▀█▀█▄ ▄██ ▄█▄█▄█  █ ▄█▄█  █ ▄  █▄ ▄█▀█▄██
██▄▄▄██▄▄▄▀▄▄ ▄█▄ ▄ ██ █▄ ▄▄█ ▄█▄█▄█▀ ▀ ▄█▄█▀ ▀ ▄▄  ▀ ▄▀▄▀ ██
██▀▀▄█▄▄▄█▀  ▄▄▀▄ ▄ ▀█▀█▄ ▄▀█ ▄█▄█▄▀▄ █▄ █▄▀▄ █▄  █ █ ▄ ▄▀▄██
██  █   ▄▀▄█▄▄   █  █ ▄█▄█ ▀ █ █▄█▄ ▄ ▀█▀█▄ ▄ ▀█▀▀█ ▀█  ▄█▄██
██▀ █ ▄▀▄▄▀▄▄ ▄█▀█▀█▄ ▄ ▀█▀▀ █▀█▄▀▄ ▄▄██ ▀▄ ▄▄██ ▀█ ██▀ ▄█▄██
██▀▄▀▄▀█▄▄ █ ▄▄▄▀█ █▄ ▄ ██ ▀ █ █▄ ▀ ▄█▄█▀ ▀ ▄█▄█▀▀█ ▀█  ▄▀▄██
██ ▀ ▀▀▄▄▀▀ ▀ ▀▄ █▀█▄ ▄ ▀█▀▀ █▀█▄ █ ▄█▄█  █ ▄█▄█ ▀█ ██▀ ▄ ▀██
████████▄▄▀▀ █▀  █ █▄ ▄ ██ ▀ ▄▄▄  ▀ ▄█▄█▀ ▀ ▄█▄█▀█ ▄▄▄  ▄ ███
██ ▄▄▄▄▄ █    ▀  █▀█▄ ▄ ▀█▀  █▄█  █ ▄█▄█  █ ▄█▄█ ▀ █▄█  ▄ ▀██
██ █   █ █▄▄█ █▄▀█ █▄ ▄ ██ █▄ ▄▄  ▀ ▄█▄█▀ ▀ ▄█▄█▀█▄▄  ▄▄  ███
██ █▄▄▄█ █ ██▄▄███▀█▄ ▄ ▀█▀█▄ ▀█▀ █▄ █▄▀▄ █▄ █▄▀▄█▄█▀ ▀█▀▀ ██
██▄▄▄▄▄▄▄█▄▄▄█▄██▄▄█▄█▄▄█▄▄█▄▄██▄▄████▄▄▄▄████▄▄▄█▄█▄▄██▄█▄██
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`.replace('\n', '')
  );
  const v10_6 = _tests.drawQR(10, 'low', v10_data, 6).border(2);
  // console.log(bmToASCII(v10_6));
  deepStrictEqual(
    bmToASCII(v10_6),
    `
█████████████████████████████████████████████████████████████
██ ▄▄▄▄▄ █▄▀ ▀ ▀  ▄ ▄▀██▄  ▀▀ ▀  ▀ ██ █▄ █▄█▀▄█ ▄ ██ ▄▄▄▄▄ ██
██ █   █ ███▀ ██▀  ▀██ █ ▀  ▀ ▄▀ █▀██▀▄ ▀█ ▄█ █▄▄ ██ █   █ ██
██ █▄▄▄█ ███▀▄█▄▄ ▀▄▄▄▀█▀▄ █ ▄▄▄ ▄▄█ ▄█▀▄█▀▀▀▀▀ ▀▄██ █▄▄▄█ ██
██▄▄▄▄▄▄▄█ ▀ █ █ █▄█▄█▄▀▄█ ▀ █▄█ █ █▄█ █▄▀▄█ ▀ ▀ █ █▄▄▄▄▄▄▄██
██▄▄█ ▄█▄▀██▀▄█ ▀ ▄▄▀█▀  ▀▄█ ▄▄▄  ▀█ ▄█ ▄  ▄ █▄ █▄ ▀▄███▀▀ ██
██▄▄▀▀ █▄▀██▄▄▄▄▀ ▄▄ ▄▄█▄▄█▄▄█ █▄█▄█▀█▀▀ ▄▀▀  █ █▀ ▀ █   ▀▄██
███▄▄▄▀▀▄█▄███ ▀▀    ▀ ██ ▄▀ █▀ █▀██▄  ▄██▀█ ▄  ▀█ ▄██▀▄   ██
██▀▄ ██▀▄▄▀▀▄▀ █▄ █▀ █▀██▀██▀█▀▀▄█ █ ▀  ██▀▄  ▀ ▄▄ ▄▀█▀▄ █▄██
███▄█▄ ▄▄▄▄▀█▀▀▄█ █▄ ▄▄█ ▄▄▄▄█▄▄█▄▀█▀▄ ▀▀█▄▀ ▀▄ ▄▀ ▄▄█▄▀ ▄███
██ ▀████▄█▀ ▄ ▀▄  ▀  ▀ █▀ █▀ ▀█ ▄▀▀█▄  ▄▄███ ▄   █ ▀ ▀██ ▀███
███▀▄▀ █▄▀▀▀▀▄█ ▀ ▄▀ █▀█▀▀▄▀█  ▀██▄█ ▀  ▄██▄  ▀ █▀▄█▀   ▄█ ██
███▀ █▀▀▄█  ▀▀▀▄▄ ▄▄ ▄▄█▄▄█▀▀ ▀▄▄▄█▀█▄ █▄█ █▄▀▄▄▀▄█▄▄ ▀▄█▀▄██
██ ▀ ▀█ ▄ ▀█▄█  ▀█▄  ▄▄███ ▄▄ ▄ █▀█ ▀  ▀ █▀ █▄ █▄ ▄▀  ▄ ▄▀ ██
██▄▄█▀ ▄▄▄ ▄▀▀█▀▀█ ▄█ ▄  ▄ █ ▄▄▄ ▀  ▄█ █▀▀▀▀▄▄▀█ ▀ ▄▄▄ ▀██▄██
██▄█▄  █▄█ ▄ ▀█▄ █▀▀▀▀  ▀▀   █▄█ ▀▄ ▄▀█▄▄ ▀▄█▄▀█▀█ █▄█ ▄▄ ███
██ ▀█▀▄ ▄  ██▀▀ ▄█▄██▄█ ▄█ ▄ ▄▄▄ ▄   █▀▀  ▄ ▄▀▀█▄▄▄▄ ▄▄ █▄ ██
██  ▄▄ ▀▄█▀ ▄▄ ▀██ ▄▀ █  ▄ ▀ █ ▀  ▀ █▄██▀  ▀██▄█  ▄ ▀█ ▀▄ ▀██
██▀ ▀▀▄█▄█▀█ ▀▄▀▄█▀▀█▀▀ ▀▀ ▀██▀▄ ▀▄ █▀▀▄▄ ▀▄▄▄██▀▀▄▀▄█▀▄█▀▄██
██ █  █▀▄██▀▄█ ▄ █▄█▀▄▄ ▄█ █▀█▄  ▄  ▀██▀  ▄ █▀██▄▀▄▀██▄▄  ▄██
███▄▀   ▄ ▄█▄  ▄▀█ ▄█ ▄  ▄ ▄ █ ▀  ▀▄ ▄▀▀█  █ █ ▀▄▄▀█ █ ▄ ▄▀██
██▄▄███▀▄█▄ ▀█▄▄  █▀▀▄▄ ▀▄▄█  █▄ ▀▄█▀▀█▀▀ ▀▀ ▄▀ ▄ ▀▄▀ █▀ ▀▄██
███▀▀█▄▄▄██▀▄█ ▄█ ▀  ▀ █▀ █ ▄ ▀    █▄▀▀▄▄▄▄█ █▀  ▄▀▀▀ ▀█ ▄ ██
███▀▄▀█▀▄▀█ ▄  ▀▄ ▄▀ █▀█▀▀▄▄█ ▄▀ █▄█ ▀  ▄██▄  ▀ ██▀█▄ ▄▄ ▄▀██
██ ▀ ▀▀▄▄█▀█▄▀█   ▄▄ ▄▄█▄▄██  ▄▄ ▄██▀▄ ▀ █ ▀ ▀▄ █ ▀▄█ ▄▀ ▄▀██
████████▄█▀▄  █▀▄    ▀ ██ ▄  ▄▄▄ ▀██▄  ▄██▀█ ▄  ▀  ▄▄▄ █ ▀▀██
██ ▄▄▄▄▄ ███▄▄███ █▀ █▀██▀██ █▄█ █ █ ▀  ██▀▄  ▀ ▄█ █▄█ ▄ █▄██
██ █   █ █ ▀ ▀▀ ▀ █▄ ▄▄█ ▄▄▀▄▄ ▄▄▄▀█▀▄ ▀▀█▄▀ ▀▄ ▄▄   ▄ █▄▄███
██ █▄▄▄█ █▀ █▀ ▄▀ ▀  ▀ █▀ █▄ █▀ █▀▀▀     ██▀▄▄ ▄▄  ▄██▀ █ ▄██
██▄▄▄▄▄▄▄█▄█▄█▄▄▄█▄█▄▄███▄▄▄████▄█▄▄██▄██████▄██▄█▄▄████▄▄███
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`.replace('\n', '')
  );
  const v10_1 = _tests.drawQR(10, 'low', v10_data, 1).border(2);
  // console.log(bmToASCII(v10_1));
  deepStrictEqual(
    bmToASCII(v10_1),
    `
█████████████████████████████████████████████████████████████
██ ▄▄▄▄▄ █ ▀ ▀▄█▄ ▄  █▀█▄ ▄██ ▀ ▄█▄██ ▀ ▄█▄██ ▀ ▄ ██ ▄▄▄▄▄ ██
██ █   █ ████▀▀█▄ ▄ ▀███▄ ▄ ▄   ▄█▄█▀   ▄█▄█▀  ▄▄ ██ █   █ ██
██ █▄▄▄█ █ █▄ ▀█▄ ▄  █▀█▄ ▄▄ ▄▄▄ █▄██ ▀ ▄█▄██ ▀ ▀▄██ █▄▄▄█ ██
██▄▄▄▄▄▄▄█ ▀ █▄▀▄█▄█ ▀ ▀▄█▄█ █▄█ ▀▄█▄█▄▀ ▀▄█▄█▄▀ █▄█▄▄▄▄▄▄▄██
██ ▄ ▀▀▄▄▀ ███▀ ▄  ███▄ ▄  █▄▄ ▄▄ ▄█▄█▀ ▀ ▄█▄█▀ ▀█▄  ▄ ██ ▄██
██ █▀▀█▀▄ ██▀  █▀ ▀ ▄█▄█▀ ▀█▄██▀ ▄▄█▄▀█  ▄▄█▄▀█  █▄  ██▄▄ ▄██
██▀  ▄▀▀▄▀ ███▄██   ▄█▄██  █▄█▀ ▀█▀█▄ ▄ ▀█▀█▄ ▄ ▀█▄ ▀█▀▄▄▄▄██
███▄██▀ ▄▄▄▀  ▄█▀ ▀ ▄█▄█▀ ▀█▄██  ███▄ ▄  ███▄ ▄  █▄▄▄███▄█▀██
██▀██▄█ ▄█▄▀ ████   ▄█▄██  █▄█▀ ▀█▀█▄ ▄ ▀█▀█▄ ▄ ▀█▄█▄█▀█▄████
██▄█▀███▄▀█ ▄ █ ▄ ▀ ▄█▄█▀ ▀█▄▀█  ███▄ ▄  ███▄ ▄  █▄█▄▀██▄█▀██
██▀▀▀▀▄▄▄▀▄▀██▀ ▄   ▄█▄██  ▀  ▄ ▀█▀█▄ ▄ ▀█▀█▄ ▄ ▀  █▄ ▄▀ ████
██▀  █▄█▄▄  ▄███▄ ▀ ▄█▄█▀ ▀ ▀ ▄  ██▀  ▄▄▄██▀  ▄▄▄ ▀█▄ ▄ ▀ ▄██
██▄█▄▀█ ▄▄██▄█▄▄██▄ ▄  ███▄   ▄ ▀█▀ ▀ ▄█▄█▀ ▀ ▄█▄  █▄ ▄  █▄██
██ ▄ ▀ ▄▄▄ ▄█ ▀▀▄█▄█▀ ▀ ▄█▄█ ▄▄▄ ▀█  ▄▄█▄▀█  ▄▄█▄  ▄▄▄  ▀█▀██
██ ▄▄  █▄█ ▄██▀█ █▄██   ▄█▄▀ █▄█  ▄ ▀█▀█▄ ▄ ▀█▀█▄▀ █▄█   ▀███
██▄█▀▀▄ ▄▄▄██▀█▄ █▄█▀ ▀ ▄█▄ ▄▄▄▄▄ ▄  ███▄ ▄  ███▄▄  ▄▄▄ ▀ ▄██
██▄ ▀▄▄ ▄█▄  █▄▀ █▄██   ▄█▄▀██▄ ▄ ▄ ▀█▀█▄ ▄ ▀█▀█▄▀  ▄█▄   ▄██
███▀▀▀▀▀▄▄▀███  ▄█▄█▀ ▀ ▄█▄ ██▄ ▄ ▄  ███▄ ▄  ███▄█  ▄█▄ ▀ ▄██
██▄▀▄ █▀▄▀▀▀▄█▄ ▄█▄██   ▄█▄▀██▄ ▄ ▄ ▀█▀█▄ ▄ ▀█▀█▄▀ █▀█▄▄▄▄ ██
██▀▄▄ ▄▀▄ ▀█ ▀▄▄▄█▄█▀ ▀ ▄█▄▄██▄ ▄ ▄▄▄██▀  ▄▄▄██▀ █████▄█▄▄▄██
██ ███ █▄▄▄ ▄▀ █   ███▄ ▄  ▄    ▄ ▄█▄█▀ ▀ ▄█▄█▀ ▀▄██▀  █▄ ▄██
██▀███▄▄▄▀▀▀▄█▄ ▀ ▀ ▄█▄█▀ ▀▄  ▀ ▄▄▄█▄▀█  ▄▄█▄▀█  ▄███ ▀█▄ ▄██
██▀▀▀▀▀ ▄▀   ▀▄▀▀   ▄█▄██  ▄    ▄█▀█▄ ▄ ▀█▀█▄ ▄ ▀▄██▀  █▄▄▄██
██ ▀ ▀▀▄▄▄▀█▀█▀▀  ▀ ▄█▄█▀ ▀▄  ▀ ▄███▄ ▄  ███▄ ▄  ▄███ ▀█▄█▀██
████████▄█▀▄  ▀█    ▄█▄██  ▄ ▄▄▄ █▀█▄ ▄ ▀█▀█▄ ▄ ▀  ▄▄▄ █▄████
██ ▄▄▄▄▄ █▀█ █▀█  ▀ ▄█▄█▀ ▀█ █▄█ ███▄ ▄  ███▄ ▄  ▄ █▄█ █▄█▀██
██ █   █ ██▀███▀▀   ▄█▄██   ▄▄▄  █▀█▄ ▄ ▀█▀█▄ ▄ ▀ ▄  ▄▄▀ ████
██ █▄▄▄█ █  █▀▄ █ ▀ ▄█▄█▀ ▀ ▄█▀ ▀██▀  ▄▄▄██▀  ▄▄▄ ▄ ▀█▀ ▀▄ ██
██▄▄▄▄▄▄▄█▄█▄▄▄▄██▄▄▄▄▄███▄▄▄██▄▄██▄█▄▄█▄██▄█▄▄█▄▄▄▄▄██▄▄▄▄██
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`.replace('\n', '')
  );
});

it('qr v20', () => {
  // console.log('V20');
  const v20_data = new Uint8Array([
    32, 17, 236, 17, 17, 17, 17, 17, 2, 236, 17, 236, 236, 236, 236, 236, 80, 17, 236, 17, 17, 17,
    17, 17, 0, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17,
    236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236,
    236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17,
    17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17,
    236, 17, 236, 236, 236, 236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236,
    236, 236, 236, 17, 236, 17, 17, 17, 17, 17, 17, 236, 17, 236, 236, 236, 236, 236, 236, 17, 236,
    17, 17, 17, 17, 17, 236, 236, 236, 236, 236, 40, 201, 192, 107, 107, 107, 107, 107, 21, 182,
    92, 234, 234, 234, 234, 234, 69, 250, 221, 120, 120, 120, 120, 120, 100, 179, 151, 154, 154,
    154, 154, 154, 184, 30, 161, 110, 110, 110, 110, 110, 11, 78, 183, 155, 155, 155, 155, 155,
    195, 189, 74, 86, 86, 86, 86, 86, 112, 254, 36, 60, 60, 60, 60, 60, 23, 255, 74, 245, 245, 245,
    245, 245, 52, 111, 38, 205, 205, 205, 205, 205, 22, 133, 178, 204, 204, 204, 204, 204, 165, 57,
    240, 61, 61, 61, 61, 61, 156, 249, 95, 49, 49, 49, 49, 49, 7, 105, 102, 224, 224, 224, 224,
    224, 196, 65, 186, 143, 143, 143, 143, 143, 226, 8, 15, 95, 95, 95, 95, 95, 204, 212, 126, 222,
    222, 222, 222, 222, 19, 100, 138, 97, 97, 97, 97, 97, 251, 145, 189, 122, 122, 122, 122, 122,
    145, 124, 191, 162, 162, 162, 162, 162, 239, 103, 7, 110, 110, 110, 110, 110, 111, 22, 122,
    169, 169, 169, 169, 169, 156, 92, 57, 205, 205, 205, 205, 205, 209, 214, 54, 103, 103, 103,
    103, 103, 179, 21, 33, 168, 168, 168, 168, 168, 163, 97, 158, 194, 194, 194, 194, 194, 117, 8,
    244, 39, 39, 39, 39, 39, 79, 230, 210, 115, 115, 115, 115, 115,
  ]);
  const v20 = _tests.drawQR(20, 'low', v20_data, 0).border(2);
  deepStrictEqual(
    bmToASCII(v20),
    `
█████████████████████████████████████████████████████████████████████████████████████████████████████
██ ▄▄▄▄▄ ██▄▀ ▀▀▀  ▄▄ ███▄ ██▄ ██▄  ▄█▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄██▄ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▄ █ ▄▄▄▄▄ ██
██ █   █ █▄███▀▀  ▀▄ ▄▄▄█  ▄█  ▄█   ▄▀▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄▄█  ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀  █▄ █ █   █ ██
██ █▄▄▄█ ████ ▀▄█  ▀▄ ███▄ ██▄ ██  ▄▄▄  █ ▄ █ ▄ █ ▄ █ ▄ █ ▄ █  ▄▄▄ ▀█▀▄▀█▀▄▀█▀▄▀█▀▄▀█▀▄▀█▀▄█ █▄▄▄█ ██
██▄▄▄▄▄▄▄█ ▀ ▀ ▀▄█ ▀▄█▄█ █ █ █ █ █ █▄█ ▀▄█▄▀▄█▄▀▄█▄▀▄█▄▀▄█▄▀▄▀ █▄█ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ █▄▄▄▄▄▄▄██
██▄▄ ▀▄ ▄  ▀▀▄▀▀ ██▄▀▄   ▀   ▀   ▄ ▄▄▄  ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄  ▄▄▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▀   █▀▀▄████
██ ▀█▀ ▄▄▄██ ▀▀▄██▀▄▄█▄▄ ▀▄▄ ▀▄▄ ▀ █▄█▀▄ █▄▄ █▄▄ █▄▄ █▄▄ █▄▄ █▄▀▄▄█▀  █▀  █▀  █▀  █▀  █▀ ▀  ██  ▄█▄██
████   █▄ █▄▀▄▀████▀▄▄   ██  ██  ▀▄█▄ ▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄▀███▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀  ▀█▀ ▄█▄██
██ ▀█▀▀ ▄▄█  ▀▀  █▀█▀█▄▄ ▄▀▄ ▄▀▄ ███▄ ▄█ █▄█ █▄█ █▄█ █▄█ █▄█ █▄▄▀▄█▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀▄ ██  ▄█▄██
████  ▀▀▄ █▄▀▄▀  ██▄ ▄   ▀   ▀   ▄▀█▄█ █▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄  ██▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ██ ▀█▀ ▄█▄██
██ ▀▀▄█▀▄▄█  ▀▀  ███ █ ▀▄▀ ▀▄▀ ▀▄▀ █▄█▀█ █▄█ █▄█ █▄█ █▄█ █▄█ █▄▀▄▄██   █   █   █   █   █ ▄▀ ██ ▀▄█▄██
██ █ █▀ ▄ █▄▀▄█   █▄  ▀▀█▀ ▀█▀ ▀█▀ █▄█ █▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄▀███▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▀ █▄█▀█ ▀▄██
██▄▄▄▀█▀▄▄█  ▀▄    █ █ ▄▀▀ ▄▀▀ ▄▀▀ █▄█▀█ ▀▄█ ▀▄█ ▀▄█ ▀▄█ ▀▄█ █▄▀█▄▀▀█  ▀█  ▀█  ▀█  ▀█  ▀█▀▄█▄ ▄█▀ ▀██
██▄ █▄▀ ▄ █▄▀█▄  ▄█▄     ▀   ▀   ▀ █▄█ █▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀▀▄▀█▀ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ██ ▀ ▄▀▄▄███
███▀█▀█▀▄▄█  ▀▄   ██ ▄▄▀▄▀ ▀▄▀ ▀▄▀  ▀█▀█ ▄██ ▄██ ▄██ ▄██ ▄██  ▀▀█▀▄█   █   █   █   █   █ ▄█ ██  ▄█▄██
██▀█▀▀▀ ▄ █▄▀ ▄  ▀▀▄ ▀█▀█▀ ▀█▀ ▀█▀  ██ █▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀▄█▀███▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄████▄█▀▄ ▀▄██
██▄▄ ▀█▀▄▄█  ▄▀    █  █▀█▀ ▀█▀ ▀█▀ █▄█▀█ ▀▄█ ▀▄█ ▀▄█ ▀▄█ ▀▄█ █▄▀█▄▀██  ██  ██  ██  ██  ██▄██▄ ▄█▀█▄██
██ ▀▀▀ ▄▄▄ ▄▀▄█  ▀▀▄ █ ▀█▀ ▀█▀ ▀█▀ ▄▄▄ █▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀▀ ▄▄▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄██ ▄▄▄ █  ▄██
██ █ ▀ █▄█ ▀▄█ ▄▄▄▀▀▄ █▀█▀ ▀█▀ ▀██ █▄█ ▀▄ █▀▄ █▀▄ █▀▄ █▀▄ █▀▄▀ █▄█ ██  ██  ██  ██  ██  ██  █▄█ █▀ ▀██
██  ▀▀ ▄▄▄ ██▄█▀ ▀▀▄▄█ ▀█▀ ▀█▀ ▀█▀▄ ▄ ▄ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄▄▄   ▄▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄  ▄▄▄█  ███
██ █ ▀▀▀▄█▀█▀█ ██▄▀▀▀ █▀█▀▄▀█▀▄▀█ ▄▄  ▀▄  █▄  █▄  █▄  █▄  █▄ ▄█▀ ▀███ ███ ███ ███ ███ ████  ▄█▄█▀ ▀██
██  ▀▀ █▄▀▄▀ ▄█ █▀▀▄ █ ▀███▀███▀█ ▄█▀ ██▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀██▀ ▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄██▀ ▄█▄█  ███
██ █ ▀ █▄█▀ ▄█ ▄▀▄▀▄▄ █▀█▄▀▀█▄▀▀█ ▄█  ▀▀▄ █▀▄ █▀▄ █▀▄ █▀▄ █▀▄▄█▀ ▀███▀ ██▀ ██▀ ██▀ ██▀ ███  ▄█▄█▀ ▀██
██  ▀▀▄ ▄█ ▄▄▄█▀█▀▀█▀█ ▀█▀ ▀█▀ ▀██ █▀▄█ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄██▀ ▀█▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄██▀ ▄█▄█  ███
██ █ ▀ ▄▄█▀█ █ █▄▄▀ █ █▄▀▀▄▀█▀▄▀██▀█ █▄ ▄ █ ▄ █ ▄ █ ▄ █ ▄ █ ▄▄██ ▀███ ███ ███ ███ ███ ████  ▄█▄█▀ ▀██
██  ▀█▄ ▄▄ ▀▄▄█ ▀▀▀▄██   ██▀███▀█ ▄█▀▀▄ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄██▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄██▀ ▄█▄█  ███
██ █▄▀▀█▄▄▄█▀█▄██▄█ █ ▀▄ ▄█▄▀▄█▄▀ ▄█  ▀ ▄ █ ▄ █ ▄ █ ▄ █ ▄ █ ▄▄█▀█▀█▀█▀█▀█▀█▀█▀█▀█▀█▀█▀█▀█ ▄ ▄█▄█▀ ▀██
██▄▄██ █▄█▄▀▄▄  ▀▄▄▄██▀  ██  ██  █ █▀▄█ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄██▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀  ▄ ▄█▄▀▄▄███
██▀█▄▄  ▄▄▄█▀▄ ██▀▀ ███▄ ▄█▀▄▄█▀▄█▀█ █▄ ▄▄█ ▄▄█ ▄▄█ ▄▄█ ▄▄█ ▄▄██ ▀██ ▀██ ▀██ ▀██ ▀██ ▀██ █  ▄█▄ ▄█▄██
██▀▄▄█ ▄▄█▄▀▄▀▄ ▀▄▀▄█▄   ██▀███▀██ █▀█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄██▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄██▀▄ █▄▄ ▀▄██
██ ███  ▄▄▄█▀▀███▄▀ █▄▀▄ ▄█▄▀▄█▄▀█▀█ █▄ ▄▀▄ ▄▀▄ ▄▀▄ ▄▀▄ ▄▀▄ ▄▄▀██▀█▀█▀█▀█▀█▀█▀█▀█▀█▀█▀█▀█ ▄█▀▀▄█▀ ▀██
████▀█ ▄▄▄ ▀▄▀█ ▀ ▀▄█▀█  ██  ██  ▀ ▄▄▄  ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄▀ ▄▄▄ ▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀   ▄▄▄ ▀▄ ▀██
██  █  █▄█ █▀████▀▄ █▀█▄ ▄█▄ ▄█▄ ▄ █▄█  ▄▄█ ▄▄█ ▄▄█ ▄▄█ ▄▄█ ▄█ █▄█ ▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀ █▄█  ▄▀▄██
██ ██▄▄▄▄ ▄▀▄▀▄ ▀█▀▄█▄▄  ██  ██  █    ▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄▀▄▄  ▄▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀  ▄ ▄▄  ▄█▄██
██  █ █▄▄▄▄▄▀▄█ █ ▄ ▀▄██▄▄█▄ ▄█▄    █ ▄▄ █▄▄ █▄▄ █▄▄ █▄▄ █▄▄ █   ██▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀██▄█▀ ▄█▄██
██ ▄█▄██▄ ▄▄█▀▄ ▀█▀█▄▄▄ ▄██  ██  ▄ █▄ ▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▀▄ ▄▀▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀██▄ ▄ ▄█▄██
██  █ █▄▄▄▄ █▄█▄  ▄▄█▄█  ▄▀▄ ▄▀▄   █▄ ▄▀▄█▄▀▄█▄▀▄█▄▀▄█▄▀▄█▄▀▄ ▄  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀█ ▀ ▄ ▄█▄██
██ ▄█▄██▄ ▄▀█▀▄ ██▀ ▀▄▄ ▄▀   ▀   ▄  ▀ ▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄ ▄▄ ▀▄▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▀█ ██  ▄█▄██
██  █ █▄▄▄ ▄█▄█▀▀ ▄▀▀▄█ ▀▀▄▄ ▀▄▄    █ ▄▄ █▄▄ █▄▄ █▄▄ █▄▄ █▄▄  ▄  ██▀  █▀  █▀  █▀  █▀  █▀ ▀█ ▀█▀ ▄█▄██
██ ▄█▄██▄▄▀ ▀▀▄▄▀█▀▄▄▄▄▀▄██  ██  ▄ █▄ ▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀ ▄▄ ▄█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█ ██  ▄█▄██
██  █ █▄▄▄▄█▀▄███ ▄▀ ▄██ ▄▀▄ ▄▀▄  ██▄ ▄█ █▄█ █▄█ █▄█ █▄█ █▄█  ▄  ██▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀█ ▀█▀ ▄█▄██
██ ▄█ ▄ ▄█▀▄█▀▄▀██▀█▀▄▄▄▄▀   ▀   ▀██▄ ▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀ ▄▄ ▄█▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▀█ ██  ▄█▄██
██  █▄█▄▄ ▀█ ▄███ ▄▀ ▄██▀▀ ▀▄▀ ▀▄▀ █▄█ █ █▄█ █▄█ █▄█ █▄█ █▄█  ▄  ███   █   █   █   █   █ ▀█ ▀█▀ ▄█▄██
██▄ █▀ ▄▄▀ ▄█ █▀█▀██▀█▀▄▄▀ ▀█▀ ▀█▄ █▄█▀█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀ ▄▀▄▄█▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▀  ██ ▄ ▀▄██
██▀█▀██▀▄█▄█  ▀██ ▄▀ ▀██▀▀ ▄▀▀ ▄▀ ██▄ ▄█ ▀▄█ ▀▄█ ▀▄█ ▀▄█ ▀▄█  ▄▀███▀█  ▀█  ▀█  ▀█  ▀█  ▀█▄  ▀█▀█▀ ▀██
██▄▄▄▄▄█▄▄ ▄██▄▀█▄▀█▀ ▀▄▄▀   ▀   █ ▄▄▄ █▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀ ▀█▀  ▄▄▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▀ ▄ ▄▄▄ ▀▄▄███
██ ▄▄▄▄▄ █ █  ▀██▄█▀ ▄ █▀▀ ▀▄▀ ▀▄▀ █▄█ █ ▄██ ▄██ ▄██ ▄██ ▄██ ▀ █▄█ █   █   █   █   █   █ ▀ █▄█  ▄█▄██
██ █   █ █▄▄█ █▀█▀ █▀▀▀▄▄▀ ▀█▀ ▀██▄ ▄▄▄█▀█▄█▀█▄█▀█▄█▀█▄█▀█▄█▀ ▄▄ ▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄█▄ ▄██▄▄  ▄▄ ▀▄██
██ █▄▄▄█ █ █ ▀ ██ █▀ ▀ █▀▀ ▀█▀ ▀██▄ ▄▀▄█ ▀▄█ ▀▄█ ▀▄█ ▀▄█ ▀▄█ ▀█▄█  ██  ██  ██  ██  ██  ██▀▄█  ▀█▀▀ ██
██▄▄▄▄▄▄▄█▄▄██▄██▄███▄▄▄▄█▄███▄███▄▄▄▄███▄███▄███▄███▄███▄████▄██▄▄▄█▄▄▄█▄▄▄█▄▄▄█▄▄▄█▄▄▄█▄███▄██▄█▄██
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`.replace('\n', '')
  );
});

it('Penalty', () => {
  // python-qrcode
  const VECTORS = [
    [179, 141, 120, 0],
    [204, 195, 240, 0],
    [239, 186, 200, 0],
    [205, 207, 200, 0],
    [210, 192, 240, 0],
    [225, 192, 120, 0],
    [230, 210, 160, 0],
    [207, 189, 160, 0],
  ];
  const data = new Uint8Array([
    32, 9, 64, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 203, 10, 29,
    40, 162, 45, 18,
  ]);
  const sum = (arr) => arr.reduce((acc, i) => acc + i, 0);
  for (let i = 0; i < 8; i++) {
    const v1 = _tests.drawQR(1, 'low', data, i, true);
    deepStrictEqual(_tests.penalty(v1), sum(VECTORS[i]));
  }
});

it('Penalty 2', () => {
  // python-qrcode
  const VECTORS = [
    [289, 312, 80, 0],
    [296, 282, 80, 0],
    [317, 375, 160, 0],
    [260, 282, 120, 0],
    [305, 330, 40, 0],
    [316, 372, 200, 0],
    [321, 339, 200, 0],
    [334, 360, 200, 0],
  ];
  const data = new Uint8Array([
    66, 2, 62, 251, 136, 254, 40, 58, 63, 9, 250, 121, 206, 40, 8, 222, 41, 152, 46, 251, 136, 255,
    9, 248, 248, 239, 9, 249, 72, 223, 9, 249, 75, 176, 236, 17, 236, 17, 236, 17, 236, 17, 236,
    17, 93, 67, 254, 208, 178, 18, 210, 239, 140, 226, 100, 85, 65, 59, 208, 9, 226, 139, 169, 216,
    140, 15, 245, 233, 57, 239,
  ]);
  const sum = (arr) => arr.reduce((acc, i) => acc + i, 0);
  for (let i = 0; i < 8; i++) {
    const v1 = _tests.drawQR(3, 'medium', data, i, true);
    deepStrictEqual(_tests.penalty(v1), sum(VECTORS[i]));
  }
});

it('Penalty 3', () => {
  // python-qrcode
  const VECTORS = [
    [251, 261, 240, 0],
    [232, 255, 240, 0],
    [297, 330, 120, 0],
    [268, 249, 200, 0],
    [244, 279, 200, 0],
    [263, 267, 160, 0],
    [270, 258, 200, 0],
    [261, 252, 240, 0],
  ];
  const data = new Uint8Array([
    17, 32, 12, 86, 106, 110, 20, 234, 141, 247, 161, 237, 200, 197, 64, 197, 102, 166, 225, 78,
    168, 223, 122, 30, 220, 140, 84, 12, 86, 106, 110, 20, 0, 236, 180, 231, 14, 109, 128, 232, 17,
    242, 86, 28,
  ]);
  const sum = (arr) => arr.reduce((acc, i) => acc + i, 0);
  for (let i = 0; i < 8; i++) {
    const v1 = _tests.drawQR(2, 'low', data, i, true);
    deepStrictEqual(_tests.penalty(v1), sum(VECTORS[i]));
  }
});

it('penalty matches scalar spec reference (incl. dark-ratio bands)', () => {
  // The rewritten encoder scores penalties word-parallel over packed square
  // matrices; cross-check against a direct scalar transcription of the
  // ISO/IEC 18004 rules N1..N4. Sizes around word boundaries (31..34, 64/65)
  // cover the packed tail-mask edge cases.
  const scalarPenalty = (g) => {
    const n = g.length;
    let adj = 0;
    const runs = (get) => {
      for (let i = 0; i < n; i++) {
        let run = 1;
        for (let j = 1; j < n; j++) {
          if (get(i, j) === get(i, j - 1)) run++;
          else {
            if (run >= 5) adj += 3 + run - 5;
            run = 1;
          }
        }
        if (run >= 5) adj += 3 + run - 5;
      }
    };
    runs((i, j) => g[i][j]);
    runs((i, j) => g[j][i]);
    let boxes = 0;
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const v = g[y][x];
        if (g[y][x + 1] === v && g[y + 1][x] === v && g[y + 1][x + 1] === v) boxes++;
      }
    }
    let finder = 0;
    const P = [
      [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
      [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
    ];
    const scan = (get) => {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j + 11 <= n; j++) {
          for (const p of P) {
            let ok = true;
            for (let k = 0; k < 11; k++) {
              if (get(i, j + k) !== !!p[k]) {
                ok = false;
                break;
              }
            }
            if (ok) finder++;
          }
        }
      }
    };
    scan((i, j) => g[i][j]);
    scan((i, j) => g[j][i]);
    let dark = 0;
    for (const row of g) for (const c of row) if (c) dark++;
    const total = n * n;
    const steps = Math.ceil(
      Math.max(0, Math.abs(dark * 100 - total * 50) - total * 5) / (total * 5)
    );
    return adj + 3 * boxes + 40 * finder + 10 * steps;
  };
  let seed = 0x5eed;
  const rnd = () => (seed = (seed * 48271) % 0x7fffffff);
  for (const size of [5, 8, 21, 31, 32, 33, 34, 40, 64, 65]) {
    for (let iter = 0; iter < 10; iter++) {
      const p = 0.2 + 0.6 * ((iter % 5) / 4); // sweep dark ratio across N4 bands
      const g = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => rnd() / 0x7fffffff < p)
      );
      const bm = new _tests.Bitmap(size);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) bm.set(x, y, g[y][x]);
      deepStrictEqual(_tests.penalty(bm), scalarPenalty(g), `size=${size} iter=${iter}`);
    }
  }
});

it('_alignmentPatterns export matches qrbtf table', () => {
  // Exported for custom-design renderers, replacing qrbtf's hardcoded
  // PATTERN_POSITION_TABLE; checked against the hardcoded Annex E rows below.
  const { _alignmentPatterns: alignmentPatterns } = _enc2;
  deepStrictEqual(alignmentPatterns(1), []);
  deepStrictEqual(alignmentPatterns(2), [6, 18]);
  deepStrictEqual(alignmentPatterns(7), [6, 22, 38]);
  deepStrictEqual(alignmentPatterns(14), [6, 26, 46, 66]);
  deepStrictEqual(alignmentPatterns(40), [6, 30, 58, 86, 114, 142, 170]);
  throws(() => alignmentPatterns(0), new RangeError('Invalid version=0. Expected number [1..40]'));
  throws(() => alignmentPatterns(41), new RangeError('Invalid version=41. Expected number [1..40]'));
  throws(() => alignmentPatterns(Infinity), new RangeError('"ver" expected safe integer, got Infinity'));
  throws(() => alignmentPatterns('2' as never), new TypeError('"ver" expected number, got type=string'));
});

it('encodeQR rejects arrays passed as options', () => {
  throws(
    () => encodeQR('x', 'raw', [] as never),
    new TypeError('"opts" expected object, got type=object')
  );
});

it('encodeQR validates version before invoking textEncoder', () => {
  // Invalid public options must not trigger a caller-controlled encoder.
  let calls = 0;
  let error: unknown;
  try {
    encodeQR('x', 'raw', {
      encoding: 'byte',
      version: 0,
      textEncoder: () => {
        calls++;
        return Uint8Array.of(120);
      },
    });
  } catch (cause) {
    error = cause;
  }
  deepStrictEqual(
    {
      calls,
      error:
        error instanceof Error ? { name: error.constructor.name, message: error.message } : error,
    },
    {
      calls: 0,
      error: { name: 'RangeError', message: 'Invalid version=0. Expected number [1..40]' },
    }
  );
});

it('encodeQR retains established guard error constructors', () => {
  const cases: [string, () => unknown][] = [
    ['text', () => encodeQR(1 as never, 'raw')],
    ['version range', () => encodeQR('x', 'raw', { version: 41 })],
    ['version type', () => encodeQR('x', 'raw', { version: '1' as never })],
  ];
  const actual = cases.map(([name, run]) => {
    try {
      run();
      return { case: name, error: undefined };
    } catch (error) {
      return {
        case: name,
        error:
          error instanceof Error
            ? { name: error.constructor.name, message: error.message }
            : error,
      };
    }
  });
  deepStrictEqual(actual, [
    {
      case: 'text',
      error: { name: 'TypeError', message: '"text" expected string, got type=number' },
    },
    {
      case: 'version range',
      error: { name: 'RangeError', message: 'Invalid version=41. Expected number [1..40]' },
    },
    {
      case: 'version type',
      error: { name: 'TypeError', message: '"ver" expected number, got type=string' },
    },
  ]);
});

it('encodeQR rejects non-positive and unsafe border sizes', () => {
  throws(() => encodeQR('x', 'raw', { border: 0 }), new RangeError('invalid border=0'));
  throws(() => encodeQR('x', 'raw', { border: -1 }), new RangeError('invalid border=-1'));
  // Borderless matrices (custom-design renderers) are border: 1 plus a slice;
  // the quiet zone is pure padding, so the slice recovers the exact symbol.
  const padded = encodeQR('x', 'raw', { border: 1 });
  const sliced = padded.slice(1, -1).map((row) => row.slice(1, -1));
  deepStrictEqual(sliced.length, 21);
  deepStrictEqual(
    sliced,
    encodeQR('x', 'raw', { border: 2 })
      .slice(2, -2)
      .map((row) => row.slice(2, -2))
  );
  throws(
    () => encodeQR('x', 'raw', { border: 0.5 }),
    new RangeError('"opts.border" expected safe integer, got 0.5')
  );
  throws(
    () => encodeQR('x', 'raw', { border: NaN }),
    new RangeError('"opts.border" expected safe integer, got NaN')
  );
  throws(
    () => encodeQR('x', 'raw', { border: Infinity }),
    new RangeError('"opts.border" expected safe integer, got Infinity')
  );
});

it('encodeQR enforces output-specific dimension limits', () => {
  // A v1 symbol is 21 modules: border=502 makes the final output 1025x1025.
  const expanded = { version: 1, border: 502 };
  for (const output of ['raw', 'term', 'svg'])
    throws(
      () => encodeQR('x', output, expanded),
      new RangeError('invalid opts: output is 1025x1025 (max 1024), reduce border/scale')
    );
  deepStrictEqual(encodeQR('x', 'gif', expanded).length > 0, true);

  // Compact outputs get exactly four times the maximum dimension.
  const compact = { version: 1, border: 2038 };
  for (const output of ['ascii', 'gif', 'data-url'])
    throws(
      () => encodeQR('x', output, compact),
      new RangeError('invalid opts: output is 4097x4097 (max 4096), reduce border/scale')
    );
});

it('encodeQR validates explicit mode data before capacity', () => {
  throws(
    () => encodeQR('A'.repeat(100), 'raw', { version: 1, encoding: 'numeric' }),
    new Error('Unknown letter: "A". Allowed: 0123456789')
  );
  throws(
    () => encodeQR('a'.repeat(100), 'raw', { version: 1, encoding: 'alphanumeric' }),
    new Error('Unknown letter: "a". Allowed: 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:')
  );
});

it('auto version picks smallest fitting version', () => {
  const gen = {
    numeric: (n) => '1'.repeat(n),
    alphanumeric: (n) => 'A'.repeat(n),
    byte: (n) => 'a'.repeat(n), // 1 UTF-8 byte per char
  };
  const versionOf = (raw) => (raw.length - 4 - 17) / 4; // default border=2
  for (const ecc of ['low', 'medium', 'quartile', 'high']) {
    for (const type of Object.keys(gen)) {
      // Expected version: smallest one where the reference encoder succeeds
      // (the behavior of the historical per-version scan).
      for (const n of [0, 1, 17, 42, 100, 255, 256, 500]) {
        const text = gen[type](n);
        let expVer;
        for (let i = 1; i <= 40; i++) {
          try {
            _tests.encode(i, ecc, text, type);
            expVer = i;
            break;
          } catch {}
        }
        const raw = encodeQR(text, 'raw', { ecc, encoding: type });
        deepStrictEqual(versionOf(raw), expVer, `ecc=${ecc} type=${type} n=${n}`);
      }
    }
  }
  // Exact boundary: 41 numeric digits are the last payload fitting v1-low.
  deepStrictEqual(versionOf(encodeQR('1'.repeat(41), 'raw', { ecc: 'low' })), 1);
  deepStrictEqual(versionOf(encodeQR('1'.repeat(42), 'raw', { ecc: 'low' })), 2);
});

it('capacity overflow throws', () => {
  // Auto version: does not fit v40
  throws(() => encodeQR('1'.repeat(8000), 'raw'), new Error('Capacity overflow'));
  throws(() => encodeQR('a'.repeat(3000), 'raw', { ecc: 'low' }), new Error('Capacity overflow'));
  // Explicit version: 11 alphanumeric chars need 74 bits, v1-high has 72
  throws(
    () => encodeQR('HELLO WORLD', 'raw', { version: 1, ecc: 'high' }),
    new Error('Capacity overflow')
  );
});

it('built-in UTF-8 capacity is checked before allocating encoded bytes', () => {
  const OriginalTextEncoder = globalThis.TextEncoder;
  let calls = 0;
  class CountingTextEncoder extends OriginalTextEncoder {
    constructor() {
      calls++;
      super();
    }
  }
  globalThis.TextEncoder = CountingTextEncoder;
  try {
    // v1-low holds at most 17 byte-mode bytes. This exercises both the cheap
    // UTF-16 lower bound and the exact non-ASCII byte count.
    throws(
      () => encodeQR('a'.repeat(18), 'raw', { version: 1, ecc: 'low', encoding: 'byte' }),
      new Error('Capacity overflow')
    );
    throws(
      () => encodeQR('é'.repeat(9), 'raw', { version: 1, ecc: 'low', encoding: 'byte' }),
      new Error('Capacity overflow')
    );
    deepStrictEqual(calls, 0);
  } finally {
    globalThis.TextEncoder = OriginalTextEncoder;
  }

  let customCalls = 0;
  encodeQR('a'.repeat(18), 'raw', {
    version: 1,
    ecc: 'low',
    encoding: 'byte',
    textEncoder: () => {
      customCalls++;
      return Uint8Array.of(97);
    },
  });
  deepStrictEqual(customCalls, 1);
});

it('empty string encodes as v1 numeric', () => {
  const raw = encodeQR('', 'raw');
  deepStrictEqual(raw.length, 21 + 4); // v1 + default border=2
  deepStrictEqual(_tests.detectType(''), 'numeric');
});

it('custom textEncoder runs exactly once', () => {
  // Both auto-version and explicit-version paths must reuse prepared bytes
  // instead of re-running the (possibly stateful) user encoder.
  const counting = () => {
    let calls = 0;
    const enc = (s) => {
      calls++;
      return Uint8Array.from(s, (c) => c.charCodeAt(0));
    };
    return { enc, calls: () => calls };
  };
  const auto = counting();
  encodeQR('abc', 'raw', { encoding: 'byte', textEncoder: auto.enc });
  deepStrictEqual(auto.calls(), 1);
  const explicit = counting();
  encodeQR('abc', 'raw', { encoding: 'byte', version: 2, textEncoder: explicit.enc });
  deepStrictEqual(explicit.calls(), 1);
  // ASCII latin1 bytes === utf8 bytes, so output matches the default encoder
  deepStrictEqual(
    encodeQR('abc', 'raw', { encoding: 'byte', textEncoder: counting().enc }),
    encodeQR('abc', 'raw', { encoding: 'byte' })
  );
});

it('explicit mask=0 is honored', () => {
  // mask 0 is falsy; a `!mask` bug would silently fall back to auto-selection
  const withMask = (m) => _tests.drawQR(1, 'low', _tests.encode(1, 'low', 'X', 'alphanumeric'), m);
  const auto = encodeQR('X', 'raw', { ecc: 'low', mask: 0, border: 1 });
  deepStrictEqual(auto.length, 23);
  const expected = bmToRaw(withMask(0).border(1, false));
  deepStrictEqual(auto, expected);
});

it('encodeQR rejects invalid byte encoder output', () => {
  throws(
    () =>
      encodeQR('abc', 'raw', {
        encoding: 'byte',
        version: 1,
        textEncoder: (() => new Set([65, 66, 67])) as unknown as (text: string) => Uint8Array,
      }),
    new TypeError('"opts.textEncoder" expected Uint8Array, got type=object')
  );
});

it('encodeQR accepts Uint8Array values from another realm', () => {
  // A callback can belong to an iframe or VM realm; validate the intrinsic
  // byte-array brand rather than the current realm's constructor identity.
  const local = Uint8Array.of(120);
  const foreign = runInNewContext('new Uint8Array([120])') as Uint8Array;
  const opts = { encoding: 'byte' as const };
  deepStrictEqual(
    encodeQR('x', 'raw', { ...opts, textEncoder: () => foreign }),
    encodeQR('x', 'raw', { ...opts, textEncoder: () => local })
  );
});

it('Full API test', () => {
  const q = encodeQR('#️⃣🧜‍♂️🏎🔍🔻', 'ascii');
  const exp = `
█████████████████████████████████
██ ▄▄▄▄▄ █▄██▀█▀▀▄ ▀   █ ▄▄▄▄▄ ██
██ █   █ █▄█ ▀██ ▄▄██▀▀█ █   █ ██
██ █▄▄▄█ █▀▀ █ ▄▄ █▀  ▄█ █▄▄▄█ ██
██▄▄▄▄▄▄▄█▄█▄█ █ ▀ ▀▄█▄█▄▄▄▄▄▄▄██
██▄▀▄█▀▀▄ ██▄▀▄  ███▀ ▀██▄▀▀ █▄██
██▀ ▀ ▀▄▄█▄██▄█▀█▄█ ▄▀▀▄▄▄█▀▀▄███
██  █▀  ▄▀▄▄█ ▄▄█▄   █▄▄█ ▀▄█ ▀██
██▀█ ▀ ▀▄  ▄▀ █▄ ▀ ▀▀█▄▀█  ▄▀ ▀██
███▀▀▀ ▄▄██▄▀█▄  █▄▄ ▀██▀█ ▄▄█▀██
██▄▄█▄ ▄▄█▄▄█▄▀▀█ █ █▀▀▄ ▀██▀▀▀██
██▄▄▄▄▄█▄▄ ▄ ▀ ▄█▀█ ▄█ ▄▄▄ ▄█▄ ██
██ ▄▄▄▄▄ █▄▀ ▀▀▄ █  ▀▀ █▄█ ▀▀▄▄██
██ █   █ ██▀ ▀█▄ ▄██▀█ ▄ ▄ ██▄ ██
██ █▄▄▄█ █▄▄▀▄  ▀▀▀ ▄▄▄█  ▀▄ ▄▄██
██▄▄▄▄▄▄▄█▄▄▄▄█▄███▄▄▄██▄███▄█▄██
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`.replace('\n', '');
  deepStrictEqual(q, exp);
});
// JSBT_FAST accepts ratios (0.5 = half the cores) and negatives (-2 = cores minus two);
// normalize to a positive integer the same way jsbt sizes its worker pool, so the shard
// list is identical in the primary and every worker.
const SMALL_VECTOR_SHARDS = normalizeWorkerCount(it.opts.FAST, cpus().length);

for (let shard = 0; shard < SMALL_VECTOR_SHARDS; shard++) {
  it(`small vectors shard(${shard + 1}/${SMALL_VECTOR_SHARDS})`, async () => {
    let count = 0;
    for await (const { index, value: v } of jsonGZItems('vectors/small-vectors.json.gz', {
      start: shard,
      step: SMALL_VECTOR_SHARDS,
    })) {
      const { text: input, out: output, ecc } = v;
      const q = encodeQR(input, 'ascii', { ecc });
      deepStrictEqual(q, output, `small test(${index})`);
      count++;
    }
    if (shard === 0 && count === 0) throw new Error('small vector stream did not yield tests');
  });
}

it('Full API test url', () => {
  const q = encodeQR('https://www.youtube.com/watch?v=eBGIQ7ZuuiU', 'ascii');
  // console.log(q);
  const exp = `
█████████████████████████████████████
██ ▄▄▄▄▄ █  ▀▄▄█ ██▀▄▄▄▄█ ▀█ ▄▄▄▄▄ ██
██ █   █ █▀▄▀▄ ▄▄█▄█ ██▀█▀▀█ █   █ ██
██ █▄▄▄█ ██ ▄▄█▄▀▀ ▀ ██ ▄ ▄█ █▄▄▄█ ██
██▄▄▄▄▄▄▄█ ▀ ▀ █▄▀ ▀ ▀▄█ █ █▄▄▄▄▄▄▄██
██ █  ▀ ▄▄▀▀▀ █▀ ▄   ▀▀▄▀ ▄█ ▀█ ▀▄▄██
██▀▀▀  ▀▄▄██▄▀▀▄█▀ ▀▄█    ▀▀▀ ▄ █▄▄██
█████▄▀▀▄▄██ ▀ ▀ ▄▄██▄ ▄▄ ▄ █▀█ █ ███
███   ▄▀▄█▄▄▄█   ▀██▄▄▄▀▀█▄▀ ▄█▀ ████
██▀▀ ▄ ▀▄ ▄▄██▀▄▀▀████▄▄▄ █▄ █  █▀▀██
██▀▀▄ ▄▀▄ ▀▀█▄▀▀▄▄▀▀ █▄▄▀█▀ ▀▄ █▄ ▀██
██▀▄▀██ ▄▄ ▀█▄█▀ ▀ ▀█▄▀▀ █▄▀▀ █  █ ██
███▀█▄▀▄▄ █  █ ██ ██ ▄ █ ▄▄▄ ▄▀▀▄▄ ██
██▄█▄▄▄█▄█ ▄ ▄▀█▀▀ ▄▀ █▀ ▄ ▄▄▄ ▀▄▀▄██
██ ▄▄▄▄▄ █ ▄█▄▀▀ ▀█   █▄█  █▄█ ▀▀▄▀██
██ █   █ █▀ ▄▀█ ██ ▄▄▀██   ▄▄ ▄█   ██
██ █▄▄▄█ █▄  ██▀ ▄▄ ▀█ ▄      ▀▄▄█▀██
██▄▄▄▄▄▄▄█▄███▄█▄█▄▄▄▄█▄█▄████▄▄█████
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`.replace('\n', '');
  deepStrictEqual(q, exp);
});

it.runWhen(import.meta.url);
