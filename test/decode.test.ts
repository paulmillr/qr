import { it } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import { readdirSync, statSync } from 'node:fs';
import * as decoder from '../src/decode.ts';
import readQR, { _QRScanner, decodeQRBatch, type FinderPoints } from '../src/decode.ts';
import {
  _tests,
  encodeQR,
  _formatBits as formatBits,
  type ErrorCorrection,
} from '../src/index.ts';
import { DETECTION_PATH, isDecodeImage, matrixToImage, readImage, readLuma } from './utils.ts';

const symbolImage = (
  version: number,
  ecc: ErrorCorrection,
  words: Uint8Array,
  mask = 0,
  border = 4,
  scale = 4
) => {
  const symbol = _tests.drawSymbol(version, ecc, words, mask);
  const size = symbol.size + 2 * border;
  const raw = Array.from({ length: size }, (_, y) =>
    Array.from(
      { length: size },
      (_, x) =>
        x >= border &&
        y >= border &&
        x < border + symbol.size &&
        y < border + symbol.size &&
        _tests.matGet(symbol, x - border, y - border) === 1
    )
  );
  return matrixToImage(raw, scale);
};

it('decode exports only the requested runtime surface', () => {
  deepStrictEqual(
    {
      named: Object.keys(decoder).filter((name) => name !== 'default'),
      default: decoder.default === decoder.decodeQR,
    },
    { named: ['BarcodeDetector', '_QRScanner', 'decodeQR', 'decodeQRBatch'], default: true }
  );
});

it('decodeQR accepts single-channel grayscale images', () => {
  // Photographic path: the luma plane goes straight through the binarizer
  // (it is what the downscale retry ladder feeds internally).
  const f = 'detection/blurred/image007.jpg';
  const img = readImage(f);
  const bytesPerPixel = img.data.length / (img.width * img.height);
  const luma = new Uint8Array(img.width * img.height);
  for (let i = 0, j = 0; i < img.data.length; i += bytesPerPixel) {
    luma[j++] = (img.data[i] + 2 * img.data[i + 1] + img.data[i + 2]) >>> 2;
  }
  deepStrictEqual(
    {
      luma: readQR({ width: img.width, height: img.height, data: luma }, { format: 'I420' }),
      rgba: readQR(img, { format: 'RGBA' }),
      rgbaChannels: img.data.length / (img.width * img.height),
    },
    {
      luma: 'https://www.surveymonkey.com/s/TheClubatLAS_T3',
      rgba: 'https://www.surveymonkey.com/s/TheClubatLAS_T3',
      rgbaChannels: 4,
    }
  );

  // Grayscale rasters decode the same as their RGBA rendering.
  const raw = encodeQR('HELLO WORLD', 'raw', { version: 1, border: 2 });
  const rgba = matrixToImage(raw, 4);
  const gray = new Uint8Array(rgba.width * rgba.height);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba.data[4 * i];
  deepStrictEqual(
    readQR({ width: rgba.width, height: rgba.height, data: gray }, { format: 'I420' }),
    'HELLO WORLD'
  );
  throws(() => readQR({ width: rgba.width, height: rgba.height, data: gray }));
});

it('decodeQR accepts a real RGB image with an explicit format', () => {
  const img = readImage('detection/pathological/image005.png');
  deepStrictEqual(
    {
      channels: img.data.length / (img.width * img.height),
      result: readQR(img, { format: 'RGB' }),
    },
    { channels: 3, result: 'MAILTO:name@myemail.com' }
  );
});

it('decodeQR copies an uncropped single-channel image into native luma', () => {
  const rgba = matrixToImage(encodeQR('BORROWED LUMA', 'raw', { border: 4 }), 4);
  const gray = new Uint8Array(rgba.width * rgba.height);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba.data[4 * i];
  const before = gray.slice();
  const scanner = new _QRScanner({
    format: 'I420',
    maxSize: { width: rgba.width, height: rgba.height },
  });
  scanner.addImage({ width: rgba.width, height: rgba.height, data: gray }, 'I420');
  deepStrictEqual(
    {
      result: scanner.decode(),
      source: gray,
      native: scanner.luma.slice(0, gray.length),
      owned: scanner.luma !== gray,
    },
    { result: ['BORROWED LUMA'], source: before, native: before, owned: true }
  );
});

it('_QRScanner reuses owned luma and supports explicit input formats', () => {
  const rgba = matrixToImage(encodeQR('SCANNER FORMAT', 'raw', { border: 4 }), 4);
  const luma = new Uint8Array(rgba.width * rgba.height);
  const rgb = new Uint8Array(luma.length * 3);
  for (let i = 0; i < luma.length; i++) {
    const value = rgba.data[4 * i];
    luma[i] = value;
    rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = value;
  }
  const image = { width: rgba.width, height: rgba.height, data: rgb };
  const i420 = new Uint8Array(luma.length + luma.length / 2).fill(128);
  i420.set(luma);
  const scanner = new _QRScanner({
    maxSize: { width: image.width, height: image.height },
  });
  const owned = scanner.luma;
  scanner.addImage(image, 'RGB');
  const explicit = scanner.decode()[0];
  scanner.addImage(image);
  const implicit = scanner.decode()[0];
  const actual = {
    explicit,
    implicit,
    reused: scanner.luma === owned,
    populated: owned.some((value) => value !== 0),
    layouts: [
      readQR({ ...image, data: i420 }, { format: 'I420' }),
      readQR(image, { format: 'RGB' }),
      readQR(rgba, { format: 'RGBA' }),
    ],
  };
  scanner.clean();
  deepStrictEqual(
    { ...actual, zeroized: owned.every((value) => value === 0) },
    {
      explicit: 'SCANNER FORMAT',
      implicit: 'SCANNER FORMAT',
      reused: true,
      populated: true,
      layouts: ['SCANNER FORMAT', 'SCANNER FORMAT', 'SCANNER FORMAT'],
      zeroized: true,
    }
  );
  throws(
    () => readQR(image, { format: 'RGBA' }),
    new RegExp(`"img.data" expected ${4 * luma.length} bytes for format=RGBA, got ${rgb.length}`)
  );
  throws(() => readQR(image, { format: 'rgb' } as never), /invalid opts.format=rgb/);
  throws(() => readQR(image, { format: 'bgr' } as never), /invalid opts.format=bgr/);
});

it('_QRScanner addImage exposes reusable luma conversion', () => {
  const image = {
    width: 2,
    height: 2,
    data: Uint8Array.of(4, 8, 12, 20, 24, 28, 36, 40, 44, 52, 56, 60),
  };
  const scanner = new _QRScanner({ maxSize: { width: 4, height: 4 } });
  const owned = scanner.luma;
  scanner.addImage(image, 'RGB');
  deepStrictEqual(
    {
      width: scanner.width,
      height: scanner.height,
      data: scanner.luma.slice(0, scanner.width * scanner.height),
    },
    { width: 2, height: 2, data: Uint8Array.of(8, 24, 40, 56) }
  );
  deepStrictEqual(scanner.luma === owned, true);
  const values = Uint8Array.of(4, 8, 12, 16, 20, 24, 28, 32);
  const wide = new Uint8Array(3 * values.length);
  for (let i = 0; i < values.length; i++)
    wide[3 * i] = wide[3 * i + 1] = wide[3 * i + 2] = values[i];
  const paddedScanner = new _QRScanner({ maxSize: { width: 4, height: 4 }, stride: 4 });
  paddedScanner.addImage({ width: 4, height: 2, data: wide }, 'RGB');
  deepStrictEqual(
    {
      width: paddedScanner.width,
      height: paddedScanner.height,
      data: paddedScanner.luma.slice(0, paddedScanner.width * paddedScanner.height),
    },
    { width: 4, height: 2, data: values }
  );
  const padded = new Uint8Array([
    99, 99, 4, 8, 12, 0, 20, 24, 28, 0, 99, 36, 40, 44, 0, 52, 56, 60, 0, 99,
  ]);
  paddedScanner.luma.set(padded);
  paddedScanner.processImage({ width: 2, height: 2 }, 'RGBA', { offset: 2, stride: 9 });
  deepStrictEqual(
    {
      width: paddedScanner.width,
      height: paddedScanner.height,
      data: paddedScanner.luma.slice(0, paddedScanner.width * paddedScanner.height),
    },
    { width: 2, height: 2, data: Uint8Array.of(8, 24, 40, 56) }
  );
});

it('_QRScanner processes pixels written directly into its constructor-sized buffer', () => {
  const size = { width: 2, height: 2 };
  const scanner = new _QRScanner({ maxSize: { width: 4, height: 3 }, stride: 4 });
  deepStrictEqual(scanner.luma.length, 4 * 3 * 4);
  scanner.luma.set(Uint8Array.of(4, 8, 12, 255, 20, 24, 28, 0, 36, 40, 44, 255, 52, 56, 60, 0));
  scanner.processImage(size, 'RGBA', { offset: 0, stride: 4 * size.width });
  deepStrictEqual(
    {
      size: { width: scanner.width, height: scanner.height },
      luma: scanner.luma.slice(0, size.width * size.height),
    },
    { size, luma: Uint8Array.of(8, 24, 40, 56) }
  );
});

it('decodeQR converts every explicit WebCodecs pixel format', () => {
  const rgba = matrixToImage(encodeQR('PIXEL FORMATS', 'raw', { border: 4 }), 4);
  const { width, height } = rgba;
  const pixels = width * height;
  const luma = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) luma[i] = rgba.data[4 * i];
  const halfWidth = Math.ceil(width / 2);
  const halfHeight = Math.ceil(height / 2);
  const samples = {
    I420: pixels + 2 * halfWidth * halfHeight,
    I420P10: pixels + 2 * halfWidth * halfHeight,
    I420P12: pixels + 2 * halfWidth * halfHeight,
    I420A: 2 * pixels + 2 * halfWidth * halfHeight,
    I422: pixels + 2 * halfWidth * height,
    I444: 3 * pixels,
    NV12: pixels + 2 * halfWidth * halfHeight,
  } as const;
  const planar = (format: keyof typeof samples) => {
    const bits = format === 'I420P10' ? 10 : format === 'I420P12' ? 12 : 8;
    const data = new Uint8Array(samples[format] * (bits === 8 ? 1 : 2)).fill(128);
    if (bits === 8) data.set(luma);
    else
      for (let i = 0; i < pixels; i++) {
        const sample = luma[i] << (bits - 8);
        data[2 * i] = sample & 255;
        data[2 * i + 1] = sample >>> 8;
      }
    return data;
  };
  const packed = (format: 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX') => {
    const data = new Uint8Array(4 * pixels);
    for (let i = 0; i < pixels; i++) {
      data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = luma[i];
      data[4 * i + 3] = i & 255;
    }
    return data;
  };
  const packedFormats: readonly string[] = ['RGBA', 'RGBX', 'BGRA', 'BGRX'];
  const formats = [
    'I420',
    'I420P10',
    'I420P12',
    'I420A',
    'I422',
    'I444',
    'NV12',
    'RGBA',
    'RGBX',
    'BGRA',
    'BGRX',
  ] as const;
  deepStrictEqual(
    formats.map((format) => {
      const data = packedFormats.includes(format)
        ? packed(format as 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX')
        : planar(format as keyof typeof samples);
      return readQR({ width, height, data }, { format });
    }),
    formats.map(() => 'PIXEL FORMATS')
  );
});

it('decodeQR validates callback options before decoding', () => {
  const img = matrixToImage(
    encodeQR('12345', 'raw', { version: 1, encoding: 'numeric', border: 4 }),
    4
  );
  const callbacks = ['textDecoder', 'pointsOnDetect', 'imageOnResult', 'imageOnBitmap'] as const;
  const actual = callbacks.map((name) => {
    try {
      readQR(img, { [name]: 1 } as never);
      return { name, error: undefined };
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : error };
    }
  });
  deepStrictEqual(
    actual,
    callbacks.map((name) => ({
      name,
      error: `invalid opts.${name}=1 (number)`,
    }))
  );
});

it('decodeQR validates its complete public image and option surface', () => {
  const img = matrixToImage(
    encodeQR('VALIDATE', 'raw', {
      version: 1,
      ecc: 'low',
      mask: 0,
      border: 4,
    }),
    4
  );
  const invalid: [string, unknown, unknown][] = [
    ['array image', [], {}],
    ['array options', img, []],
    ['function options', img, () => {}],
    ['effort zero', img, { effort: 0 }],
    ['effort fractional', img, { effort: 1.5 }],
    ['timeLimit negative', img, { timeLimit: -1 }],
    ['width type', { ...img, width: String(img.width) }, {}],
    ['width range', { ...img, width: 0 }, {}],
    ['height integer', { ...img, height: img.height + 0.5 }, {}],
    ['data array', { ...img, data: Array.from(img.data) }, {}],
    ['data element type', { ...img, data: Uint16Array.from(img.data) }, {}],
    ['data length', { ...img, data: img.data.subarray(1) }, {}],
  ];
  const actual = invalid.map(([name, image, opts]) => {
    try {
      readQR(image as never, opts as never);
      return { name, error: false };
    } catch {
      return { name, error: true };
    }
  });
  deepStrictEqual(
    actual,
    invalid.map(([name]) => ({ name, error: true }))
  );

  deepStrictEqual(readQR(img, { futureOption: true } as never), 'VALIDATE');
});

it('decodeQR does not reuse mutable failure objects across calls', () => {
  const raw = encodeQR('A', 'raw', {
    version: 1,
    ecc: 'low',
    mask: 0,
    border: 4,
  });
  for (let y = 12; y < 16; y++) {
    for (let x = 12; x < 16; x++) raw[y][x] = !raw[y][x];
  }
  const img = matrixToImage(raw, 4);
  const failures: Error[] = [];
  for (let i = 0; i < 2; i++) {
    try {
      readQR(img);
    } catch (error) {
      if (error instanceof Error) failures.push(error);
    }
  }
  deepStrictEqual(failures.length, 2);
  const first = failures[0] as Error & { reviewMarker?: number };
  const second = failures[1] as Error & { reviewMarker?: number };
  const message = first.message;
  const stack = first.stack;
  first.message = 'caller mutation';
  first.stack = 'caller stack';
  first.reviewMarker = 17;
  const actual = {
    same: first === second,
    message: second.message,
    stack: second.stack,
    marker: second.reviewMarker,
  };
  // Restore a cached object before the assertion so this regression test does
  // not contaminate later failures in the same process.
  first.message = message;
  first.stack = stack;
  delete first.reviewMarker;
  deepStrictEqual(actual, {
    same: false,
    message,
    stack,
    marker: undefined,
  });
});

it('decodeQR: imageOnResult fires a 1px-per-module RGBA image on success', () => {
  const raw = encodeQR('result image', 'raw', { version: 3, border: 4 });
  const img = matrixToImage(raw, 4);
  let result;
  const res = readQR(img, {
    imageOnResult: (i) => {
      result = i;
    },
  });
  deepStrictEqual(res, 'result image');
  // imageOnResult reports the bare symbol grid (no quiet-zone border): v3 = 29.
  const symbolSize = 17 + 4 * 3;
  deepStrictEqual([result.width, result.height], [symbolSize, symbolSize]);
  deepStrictEqual(result.data.length, symbolSize * symbolSize * 4);
});

it('decodeQR: max effort escalates to native resolution', () => {
  // A sharp 2px/module symbol inside a 9MP canvas: the pre-scale would
  // halve it twice into aliased noise, so it only exists at native
  // resolution — reachable exclusively through the upscale chain, given an
  // unbounded retry budget.
  const raw = encodeQR('NATIVE ONLY', 'raw', { version: 2, border: 4 });
  const qr = matrixToImage(raw, 2);
  const W = 3000;
  const H = 3000;
  const data = new Uint8Array(W * H * 4).fill(255);
  for (let y = 0; y < qr.height; y++) {
    for (let x = 0; x < qr.width; x++) {
      const s = (y * qr.width + x) * 4;
      const t = ((y + 1200) * W + (x + 1400)) * 4;
      data[t] = qr.data[s];
      data[t + 1] = qr.data[s + 1];
      data[t + 2] = qr.data[s + 2];
      data[t + 3] = 255;
    }
  }
  deepStrictEqual(
    readQR({ width: W, height: H, data }, { effort: Infinity, timeLimit: Infinity }),
    'NATIVE ONLY'
  );
  // The strict-pass guarantee needs no retry budget: clean synthetics decode
  // with defaults too.
  deepStrictEqual(readQR(qr), 'NATIVE ONLY');
});

it('decodeQR: decodes a clean one-pixel-per-module symbol', () => {
  // Projected module centers can land exactly on pixel boundaries at this scale.
  const raw = encodeQR('ONE PIXEL', 'raw', {
    version: 4,
    ecc: 'low',
    mask: 0,
    border: 4,
  });
  deepStrictEqual(
    readQR(matrixToImage(raw, 1), { effort: Infinity, timeLimit: Infinity }),
    'ONE PIXEL'
  );
});

it('decodeQR: handles nearest-neighbor resizing to non-integer module widths', () => {
  const raw = encodeQR('A', 'raw', {
    version: 1,
    ecc: 'low',
    mask: 0,
    border: 4,
  });
  // A 67/29 resize gives each source module an ordinary nearest-neighbor width of 2 or 3 pixels.
  const side = 67;
  const data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const value = raw[Math.floor((y * raw.length) / side)][Math.floor((x * raw.length) / side)]
        ? 0
        : 255;
      const pos = 4 * (y * side + x);
      data[pos] = data[pos + 1] = data[pos + 2] = value;
      data[pos + 3] = 255;
    }
  }
  deepStrictEqual(
    readQR({ width: side, height: side, data }, { effort: Infinity, timeLimit: Infinity }),
    'A'
  );
});

it('decodeQR: handles a clean horizontally stretched symbol', () => {
  const raw = encodeQR('ANISO', 'raw', {
    version: 1,
    ecc: 'low',
    mask: 0,
    border: 4,
  });
  const scaleX = 12;
  const scaleY = 8;
  const width = raw[0].length * scaleX;
  const height = raw.length * scaleY;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = raw[Math.floor(y / scaleY)][Math.floor(x / scaleX)] ? 0 : 255;
      const pos = 4 * (y * width + x);
      data[pos] = data[pos + 1] = data[pos + 2] = value;
      data[pos + 3] = 255;
    }
  }
  deepStrictEqual(readQR({ width, height, data }), 'ANISO');
});

it('decodeQR: tolerates limited timing-pattern damage', () => {
  const border = 4;
  const raw = encodeQR('A', 'raw', { version: 1, ecc: 'low', mask: 0, border });
  // Timing modules carry no payload; rejecting before RS makes this recoverable damage fatal.
  for (let x = 8; x <= 10; x++) raw[border + 6][border + x] = !raw[border + 6][border + x];
  const image = matrixToImage(raw, 4);
  deepStrictEqual(readQR(image), 'A');
});

it('decodeQR reports finder-derived bounds and detected aligners', () => {
  const image = matrixToImage(
    encodeQR('OVERLAY', 'raw', {
      version: 2,
      ecc: 'medium',
      border: 4,
      mask: 0,
    }),
    4
  );
  let points;
  deepStrictEqual(
    readQR(image, {
      pointsOnDetect: (value) => (points = value),
    }),
    'OVERLAY'
  );
  deepStrictEqual(points, {
    tl: {
      x: 30,
      y: 30,
      moduleSize: 4,
      corners: [
        { x: 16, y: 16 },
        { x: 44, y: 16 },
        { x: 44, y: 44 },
        { x: 16, y: 44 },
      ],
    },
    tr: {
      x: 102,
      y: 30,
      moduleSize: 4,
      corners: [
        { x: 88, y: 16 },
        { x: 116, y: 16 },
        { x: 116, y: 44 },
        { x: 88, y: 44 },
      ],
    },
    br: { x: 102, y: 102 },
    bl: {
      x: 30,
      y: 102,
      moduleSize: 4,
      corners: [
        { x: 16, y: 88 },
        { x: 44, y: 88 },
        { x: 44, y: 116 },
        { x: 16, y: 116 },
      ],
    },
    aligners: [
      {
        x: 90,
        y: 90,
        moduleSize: 4,
        corners: [
          { x: 80, y: 80 },
          { x: 100, y: 80 },
          { x: 100, y: 100 },
          { x: 80, y: 100 },
        ],
      },
    ],
    bounds: [
      { x: 16, y: 16 },
      { x: 116, y: 16 },
      { x: 116, y: 116 },
      { x: 16, y: 116 },
    ],
    outline: [
      { x: 12, y: 12 },
      { x: 120, y: 12 },
      { x: 120, y: 120 },
      { x: 12, y: 120 },
    ],
    boundingBox: { x: 16, y: 16, width: 100, height: 100 },
  });
});

it('decodeQR reports squeezed finder and outline geometry on perspective failure', () => {
  let points: FinderPoints | undefined;
  let terminal: string | Error | undefined;
  throws(
    () =>
      readQR(readImage('detection/perspective/image022.jpg'), {
        pointsOnDetect: (value, result) => {
          points = value;
          terminal = result;
        },
      }),
    (error) => error instanceof Error && error.message === 'rs'
  );
  if (!points) throw new Error('expected perspective detection points');
  const quad = (value: FinderPoints['bounds']) =>
    value.map(({ x, y }) => [Math.round(x), Math.round(y)]);
  deepStrictEqual(
    {
      result: terminal instanceof Error ? terminal.message : terminal,
      tl: quad(points.tl.corners),
      tr: quad(points.tr.corners),
      bl: quad(points.bl.corners),
      aligners: points.aligners.map(({ corners }) => quad(corners)),
      bounds: quad(points.bounds),
      outline: quad(points.outline),
      boundingBox: Object.fromEntries(
        Object.entries(points.boundingBox).map(([key, value]) => [key, Math.round(value)])
      ),
    },
    {
      result: 'rs',
      tl: [
        [438, 259],
        [467, 306],
        [433, 334],
        [404, 287],
      ],
      tr: [
        [512, 380],
        [541, 426],
        [508, 454],
        [479, 408],
      ],
      bl: [
        [352, 331],
        [381, 378],
        [347, 406],
        [318, 359],
      ],
      aligners: [],
      bounds: [
        [438, 259],
        [541, 426],
        [422, 526],
        [318, 359],
      ],
      outline: [
        [438, 248],
        [550, 429],
        [421, 537],
        [309, 356],
      ],
      boundingBox: { x: 318, y: 259, width: 223, height: 267 },
    }
  );
});

it('decodeQR samples a warped high-version symbol through alignment tiles', () => {
  const payload = 'TILED PROJECTION '.repeat(5);
  const version = 7;
  const border = 4;
  const scale = 8;
  const raw = encodeQR(payload, 'raw', {
    version,
    border,
    ecc: 'low',
    mask: 0,
  });
  const modules = 17 + 4 * version;
  const width = raw[0].length * scale;
  const height = raw.length * scale;
  const data = new Uint8Array(width * height);
  // One global homography cannot follow this smooth interior displacement;
  // the alignment lattice still provides local registration for each tile.
  for (let py = 0; py < height; py++)
    for (let px = 0; px < width; px++) {
      const x = (px + 0.5) / scale - border;
      const y = (py + 0.5) / scale - border;
      const dx = 0.75 * Math.sin((Math.PI * x) / modules) * Math.sin((Math.PI * y) / modules);
      const sx = Math.floor(x - dx) + border;
      const sy = Math.floor(y) + border;
      data[py * width + px] = raw[sy]?.[sx] ? 0 : 255;
    }
  let points: FinderPoints | undefined;
  const result = readQR(
    { width, height, data },
    {
      format: 'I420',
      pointsOnDetect: (value) => (points = value),
    }
  );
  if (!points) throw new Error('expected tiled detection points');
  const point = (value: { x: number; y: number; moduleSize?: number }) =>
    value.moduleSize === undefined
      ? [Math.round(value.x), Math.round(value.y)]
      : [Math.round(value.x), Math.round(value.y), Math.round(value.moduleSize)];
  deepStrictEqual(
    {
      result,
      points: {
        tl: point(points.tl),
        tr: point(points.tr),
        br: point(points.br),
        bl: point(points.bl),
        aligners: points.aligners.map(point),
        boundingBox: points.boundingBox,
      },
    },
    {
      result: payload,
      points: {
        tl: [60, 60, 8],
        tr: [364, 60, 8],
        br: [364, 364],
        bl: [60, 364, 8],
        aligners: [
          [212, 84, 8],
          [84, 212, 8],
          [216, 212, 8],
          [340, 212, 8],
          [212, 340, 8],
          [340, 340, 8],
        ],
        // The synthetic displacement is zero at every outer QR edge.
        boundingBox: { x: 32, y: 32, width: 360, height: 360 },
      },
    }
  );
});

it('decodeQR: falls back from a damaged alignment pattern', () => {
  const border = 4;
  const raw = encodeQR('A', 'raw', {
    version: 2,
    ecc: 'high',
    mask: 0,
    border,
  });
  // With the real center damaged, an unrelated data run must not replace the geometric fallback.
  raw[border + 18][border + 18] = !raw[border + 18][border + 18];
  const image = matrixToImage(raw, 4);
  deepStrictEqual(readQR(image), 'A');
});

it('decodeQR: resists one inflated finder-size estimate', () => {
  const border = 4;
  const raw = encodeQR('A', 'raw', {
    version: 24,
    ecc: 'high',
    mask: 0,
    border,
  });
  // One damaged finder must not outweigh the two intact dimension estimates.
  raw[border + 2][border + 5] = !raw[border + 2][border + 5];
  const image = matrixToImage(raw, 4);
  deepStrictEqual(readQR(image), 'A');
});

it('decodeQR: tries an intact format copy when the redundant words conflict', () => {
  const border = 4;
  const payload = 'format byte';
  const correct = formatBits('quartile', 7);
  const wrong = formatBits('low', 0);
  const conflict = (wrongCopy: 0 | 1, damagedCorrect = correct) => {
    const raw = encodeQR(payload, 'raw', {
      version: 1,
      ecc: 'quartile',
      mask: 7,
      border,
    });
    const size = raw.length - 2 * border;
    const write = (copy: 0 | 1, bits: number) => {
      for (let i = 0; i < 15; i++) {
        let x: number;
        let y: number;
        if (copy === 0) {
          x = i < 9 ? (i === 8 ? 7 : 8) : 14 - i;
          y = i < 6 ? i : i < 8 ? i + 1 : 8;
        } else {
          x = i < 8 ? size - 1 - i : 8;
          y = i < 8 ? 8 : size - 15 + i;
        }
        raw[border + y][border + x] = !!((bits >> i) & 1);
      }
    };
    // Each physical copy is BCH-corrected independently. The correct copy can
    // still carry its full three-error budget when the other is an exact word.
    write(wrongCopy, wrong);
    write(wrongCopy ? 0 : 1, damagedCorrect);
    return matrixToImage(raw, 4);
  };
  const images = [conflict(0), conflict(1), conflict(0, correct ^ 1 ^ (1 << 7) ^ (1 << 14))];
  for (const image of images) deepStrictEqual(readQR(image), payload);

  const sentinel = new Error('format callback sentinel');
  let calls = 0;
  throws(
    () =>
      readQR(images[0], {
        textDecoder: () => {
          calls++;
          throw sentinel;
        },
      }),
    (error) => error === sentinel
  );
  deepStrictEqual(calls, 1);
});

it('decodeQR: rejects a byte segment whose declared length exceeds its data', () => {
  // The codewords are RS-valid v1-low data whose byte header declares 255
  // bytes; accepting implicit zeros past the data region creates a false decode.
  const words = Uint8Array.from([
    79, 240, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 229, 147, 129, 112, 149, 181,
  ]);
  throws(() => readQR(symbolImage(1, 'low', words)));
});

for (const [mode, words] of [
  [
    'numeric',
    [
      16, 15, 232, 0, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 250, 119,
      88, 124, 205, 218, 88,
    ],
  ],
  [
    'alphanumeric',
    [
      32, 23, 233, 0, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 64, 102,
      161, 90, 11, 93, 68,
    ],
  ],
  [
    'two-digit numeric',
    [
      16, 11, 32, 0, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 199, 62,
      84, 61, 211, 36, 77,
    ],
  ],
  [
    'one-digit numeric',
    [
      16, 6, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 233, 187,
      201, 36, 145, 187, 3,
    ],
  ],
  [
    'one-character alphanumeric',
    [
      32, 13, 160, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17, 227, 12,
      130, 229, 237, 161, 73,
    ],
  ],
] as const) {
  it(`decodeQR: rejects an out-of-range ${mode} group`, () => {
    // These RS-valid v1-low streams exceed the 3/2/1-digit numeric or
    // 2/1-character alphanumeric group range for their encoded bit width.
    throws(() =>
      readQR(symbolImage(1, 'low', Uint8Array.from(words)))
    );
  });
}

it('decodeQR: validates version information for version 7 and above', () => {
  const border = 4;
  const version = 7;
  const size = 17 + 4 * version;
  const payload = 'VERSION INFO MUST BE CHECKED';
  const wrong = _tests.versionBits(version + 1);
  const make = () => encodeQR(payload, 'raw', { version, border, mask: 0, ecc: 'low' });
  const write = (raw: boolean[][], copy: 0 | 1, i: number, value?: boolean) => {
    const x = size - 11 + (i % 3);
    const y = Math.floor(i / 3);
    const row = border + (copy ? x : y);
    const col = border + (copy ? y : x);
    raw[row][col] = value === undefined ? !raw[row][col] : value;
  };
  // Either physical copy can establish the dimension, including at BCH radius 3.
  for (const good of [0, 1] as const) {
    const raw = make();
    for (let i = 0; i < 18; i++) write(raw, good ? 0 : 1, i, !!((wrong >> i) & 1));
    for (const i of [0, 7, 14]) write(raw, good, i);
    deepStrictEqual(readQR(matrixToImage(raw, 4)), payload);
  }
  // Exact words for another version cannot override the sampled dimension.
  const raw = make();
  for (let i = 0; i < 18; i++) {
    const value = !!((wrong >> i) & 1);
    write(raw, 0, i, value);
    write(raw, 1, i, value);
  }
  throws(() => readQR(matrixToImage(raw, 4)));
});

it('decodeQR: custom textDecoder receives the active ECI designator', () => {
  const raw = encodeQR('plain byte segment', 'raw', { border: 4 });
  const img = matrixToImage(raw, 4);
  let seenEci;
  const res = readQR(img, {
    textDecoder: (bytes, eci) => {
      seenEci = eci;
      return new TextDecoder().decode(bytes);
    },
  });
  deepStrictEqual(res, 'plain byte segment');
  // 26 (UTF-8) is the default when no ECI segment is present.
  deepStrictEqual(seenEci, 26);
});

it('gh-28 (eci)', () => {
  // Bun's TextDecoder does not expose all legacy ISO-8859/Windows labels required by this fixture.
  if (process.versions.bun) return;
  deepStrictEqual(
    readQR(readImage('../issues/eci.jpg')),
    'Latin1\t®ÄËÖ¶|\rCyrillic\tфДШлЮЯЩ\rGreek\tΣAβΔΦΩ\rThai\tโก๛ณ๗ฟ\rShiftJIS\t｢ﾓﾄｽｦﾊﾋﾌﾍﾎﾏ｣\rArabic\tلخأضخک\rUTF-8\t條碼字體\rBig5\t圖常用字次\rLatin1End'
  );
});

it('roundtrip: encode -> decode across versions/ecc/modes/masks', () => {
  const payloads = {
    numeric: '0123456789012345678901234567890123456789',
    alphanumeric: 'HELLO WORLD +-*/: $%.123456789',
    byte: 'vita nuova — 🌒🌓', // 23 UTF-8 bytes: fits v2-low (32-byte max)
  };
  const cases = [];
  for (const [enc, text] of Object.entries(payloads)) {
    for (const [version, ecc] of [
      [2, 'low'],
      [3, 'medium'],
      [5, 'quartile'],
      [7, 'high'], // first version with version-info blocks
      [10, 'medium'], // medium length-bits band
    ]) {
      cases.push({ text, opts: { version, ecc, encoding: enc } });
    }
  }
  // Explicit masks (0 and 7 bracket the falsy/last cases), auto version
  for (const mask of [0, 3, 7]) {
    cases.push({ text: payloads.alphanumeric, opts: { ecc: 'medium', mask } });
  }
  for (const { text, opts } of cases) {
    const raw = encodeQR(text, 'raw', { border: 4, ...opts });
    // scale(4) produces a clean monochrome raster.
    const img = matrixToImage(raw, 4);
    deepStrictEqual(readQR(img), text, JSON.stringify(opts));
    // RGB (3 bytes/pixel) input path
    const imgRGB = matrixToImage(raw, 4, true);
    deepStrictEqual(readQR(imgRGB), text, `rgb ${JSON.stringify(opts)}`);
  }
});

it('roundtrip: all 40 versions x 4 ECC levels decode on clean synthetics', () => {
  // The finder-ratio tolerance is strict (never loosened) on the first pass
  // specifically to keep this property — see the TOL_MUL note in decode.ts.
  for (let version = 1; version <= 40; version++) {
    for (const ecc of ['low', 'medium', 'quartile', 'high']) {
      const text = 'A'.repeat(Math.min(10 + version, 60));
      let raw;
      try {
        raw = encodeQR(text, 'raw', { ecc, version, border: 4 });
      } catch {
        continue; // capacity too small for this text/version/ecc combo
      }
      const img = matrixToImage(raw, 3);
      deepStrictEqual(readQR(img), text, `v${version}/${ecc}`);
    }
  }
});

it('roundtrip: Reed-Solomon corrects damaged data modules', () => {
  const text = 'DAMAGE TEST 123';
  const raw = encodeQR(text, 'raw', { border: 4, version: 2, ecc: 'high' });
  // v2-high: 1 block, 28 ecc words -> up to 14 wrong codewords correctable.
  // Flip a strip of data modules in the bottom-right data region
  // (symbol rows 22-23, cols 18-22; +4 for the border offset).
  for (let y = 26; y < 28; y++) {
    for (let x = 22; x < 27; x++) raw[y][x] = !raw[y][x];
  }
  const img = matrixToImage(raw, 4);
  deepStrictEqual(readQR(img), text);
});

// Current capability table. Any newly decoded or no-longer-decoded payload fails
// until reviewed here, so the complete first/all behavior cannot drift silently.
// Multi-code images list every independently confirmed selected payload.
export const DECODED = {
  blurred: {
    'image003.jpg': ['http://www.teagoetz.com/'],
    'image006.jpg': ['https://www.surveymonkey.com/s/TheClubatLAS_T3'],
    'image007.jpg': ['https://www.surveymonkey.com/s/TheClubatLAS_T3'],
    'image009.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image011.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image012.jpg': ['http://g.augme.com/1803'],
    'image013.jpg': ['http://g.augme.com/1803'],
    'image014.jpg': ['http://flydulles.com/survey'],
    'image017.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
      'Version 2 QR Code Test Image',
    ],
    'image018.jpg': ['Version 1 QR'],
    'image022.jpg': ['Version 1 QR'],
    'image023.jpg': ['Version 1 QR'],
    'image024.jpg': ['Version 1 QR'],
    'image025.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image026.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image027.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image028.jpg': ['http://goo.gl/ErBxV'],
    'image029.jpg': ['http://goo.gl/ErBxV'],
    'image030.jpg': ['http://goo.gl/ErBxV'],
    'image031.jpg': ['http://goo.gl/ErBxV'],
    'image032.jpg': ['http://www.bestekmall.com/'],
    'image033.jpg': ['http://www.bestekmall.com/'],
    'image034.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"180410194824527404022960201AZ"}}'],
    'image035.jpg': [
      'http://www.postalexperience.com/pos?mt=4&sc=840-5940-0244-002-00006-80522-02',
    ],
    'image038.jpg': ['GH69-28945C'],
    'image039.jpg': ['GH64-05708A'],
    'image041.jpg': ['GH69-28945C'],
    'image043.jpg': ['https://www.facebook.com/Lethmik/'],
    'image044.jpg': ['https://www.facebook.com/Lethmik/'],
  },
  bright_spots: {
    'image001.jpg': ['Version 2 QR Code Test Image'],
    'image002.jpg': ['Version 1 QR', 'Version 2 QR Code Test Image'],
    'image003.jpg': [
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
    ],
    'image004.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image005.jpg': ['Version 2 QR Code Test Image', 'Version 1 QR'],
    'image006.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
      'Version 2 QR Code Test Image',
    ],
    'image007.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image008.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
    ],
    'image009.jpg': ['Version 1 QR', 'Version 2 QR Code Test Image'],
    'image010.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
    ],
    'image011.jpg': ['Version 1 QR', 'Version 2 QR Code Test Image'],
    'image012.jpg': ['Version 2 QR Code Test Image', 'Version 1 QR'],
    'image013.jpg': ['Version 1 QR'],
    'image020.jpg': ['Version 2 QR Code Test Image'],
    'image025.jpg': ['Version 2 QR Code Test Image'],
    'image027.jpg': ['Version 2 QR Code Test Image'],
    'image028.jpg': ['Version 2 QR Code Test Image'],
    'image032.jpg': ['Version 2 QR Code Test Image', 'Version 1 QR'],
  },
  brightness: {
    'image001.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image002.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
      'Version 1 QR',
    ],
    'image003.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image004.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image005.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image006.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
    ],
    'image007.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
      'Version 2 QR Code Test Image',
    ],
    'image008.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image009.jpg': ['Version 1 QR', 'Version 2 QR Code Test Image'],
    'image011.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image013.jpg': ['Version 2 QR Code Test Image', 'Version 1 QR'],
    'image014.jpg': ['Version 2 QR Code Test Image', 'Version 1 QR'],
    'image015.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image016.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
      'Version 1 QR',
    ],
    'image017.jpg': ['Version 1 QR'],
    'image018.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image019.jpg': ['Version 2 QR Code Test Image', 'Version 1 QR'],
    'image022.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image024.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image025.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image027.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image028.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
  },
  close: {
    'image001.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image002.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image003.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image004.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image005.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image006.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image007.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image013.jpg': ['VERSION 2 8CM'],
    'image014.jpg': ['VERSION 2 8CM'],
    'image015.jpg': ['VERSION 2 8CM'],
    'image016.jpg': ['VERSION 2 8CM'],
    'image017.jpg': ['VERSION 2 8CM'],
    'image018.jpg': ['VERSION 2 8CM'],
    'image019.jpg': ['VERSION 2 8CM'],
    'image024.jpg': ['VERSION 2 8CM'],
    'image029.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image030.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image034.jpg': ['VERSION 2 8CM'],
    'image035.jpg': ['VERSION 2 8CM'],
    'image036.jpg': ['VERSION 2 8CM'],
  },
  curved: {
    'image002.png': ['https://www.facebook.com/elyucateco'],
    'image003.png': ['https://www.facebook.com/elyucateco'],
    'image007.jpg': ['http://www.sunmaid.com/book'],
    'image008.jpg': ['http://albtsn.com/ugtezn8'],
    'image009.jpg': ['http://albtsn.com/ugtezn8'],
    'image010.jpg': ['http://www.sunmaid.com/book'],
    'image015.jpg': ['hudson', 'Test 03'],
    'image022.jpg': ['Test 03'],
    'image025.jpg': ['正宗铁观音茶叶 乐品乐茶 \nhttp://detail.tmall.com/item.htm?id=13996190738'],
    'image027.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image028.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image029.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image030.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image031.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image033.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image037.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image038.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image039.jpg': ['http://cokeurl.com/q/2017-00776'],
    'image040.jpg': ['http://cokeurl.com/q/2017-00776'],
    'image041.jpg': ['http://cokeurl.com/q/2017-00776'],
    'image043.jpg': ['43445177'],
    'image044.jpg': ['43445177'],
    'image045.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image046.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image047.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image048.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image049.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image050.jpg': ['https://www.facebook.com/Lethmik/'],
  },
  damaged: {
    'image001.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/43597561?sku=4022-01'],
    'image002.jpg': ['are', 'kooTEK'],
    'image003.jpg': ['kooTEK', 'are', 'Enough'],
    'image004.jpg': ['kooTEK', 'are'],
    'image006.jpg': ['amzn.to/socialqr'],
    'image018.jpg': ['PETERABELES041.PremierSubaruFremont.com'],
    'image019.jpg': ['PETERABELES041.PremierSubaruFremont.com'],
    'image020.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"180418125845231163456370201AZ"}}'],
    'image032.jpg': ['43445177'],
    'image033.jpg': ['http://www.ugreen.com/'],
    'image034.jpg': ['http://www.ugreen.com/'],
  },
  glare: {
    'image003.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image006.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image007.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image008.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image018.jpg': ['http://uqr.me/acgovdehvehicles'],
    'image020.jpg': ['https://goo.gl/forms/ofwmcoJn1qN6HPb72'],
    'image021.jpg': ['https://goo.gl/forms/ofwmcoJn1qN6HPb72'],
    'image024.jpg': ['http://cokeurl.com/q/2017-00776'],
    'image027.jpg': ['http://uqr.me/acgovdehvehicles'],
    'image029.jpg': ['https://goo.gl/forms/ofwmcoJn1qN6HPb72'],
    'image035.jpg': ['http://bit.ly/l5qo2F?r=qr'],
    'image036.jpg': ['http://bit.ly/l5qo2F?r=qr'],
    'image042.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image043.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image049.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
  },
  high_version: {
    'image002.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFFFFDDDDDDDDDSVFB094856JLKSJFGS0DBIUZKL;KSFDF09846JLKSDNFGBLDKSFBHJ0SP98ASDFKthat contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or trac',
    ],
    'image003.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFFFFDDDDDDDDDSVFB094856JLKSJFGS0DBIUZKL;KSFDF09846JLKSDNFGBLDKSFBHJ0SP98ASDFKthat contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or trac',
    ],
    'image006.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFFFFDDDDDDDDDSVFB094856JLKSJFGS0DBIUZKL;KSFDF09846JLKSDNFGBLDKSFBHJ0SP98ASDFKthat contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or trac',
    ],
    'image007.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFFFFDDDDDDDDDSVFB094856JLKSJFGS0DBIUZKL;KSFDF09846JLKSDNFGBLDKSFBHJ0SP98ASDFKthat contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or trac',
    ],
    'image008.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFFFFDDDDDDDDDSVFB094856JLKSJFGS0DBIUZKL;KSFDF09846JLKSDNFGBLDKSFBHJ0SP98ASDFKthat contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or trac',
    ],
    'image011.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFFFFDDDDDDDDDSVFB094856JLKSJFGS0DBIUZKL;KSFDF09846JLKSDNFGBLDKSFBHJ0SP98ASDFKthat contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or trac',
    ],
    'image012.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFFFFDDDDDDDDDSVFB094856JLKSJFGS0DBIUZKL;KSFDF09846JLKSDNFGBLDKSFBHJ0SP98ASDFKthat contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or trac',
    ],
    'image013.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFF',
    ],
    'image014.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFF',
    ],
    'image015.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFF',
    ],
    'image016.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFF',
    ],
    'image023.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFF',
    ],
    'image029.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFFFFDDDDDDDDDSVFB094856JLKSJFGS0DBIUZKL;KSFDF09846JLKSDNFGBLDKSFBHJ0SP98ASDFKthat contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or trac',
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\nsdfgksjdflkgjsdkfgiotmbx,cmvbofghjoaasdfaERYYKLLDFGSDFFFFFFFFFFFFFFFFFFFFFF',
    ],
    'image031.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\n\nThe Quick Response system became popular outside the automotive industry due to its fast readability and greater storage capacity compared to standard UPC barcodes. Applications include product tracking, item identification, time tracking, document management, and general marketing.[3]',
    ],
    'image032.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\n\nThe Quick Response system became popular outside the automotive industry due to its fast readability and greater ',
    ],
  },
  lots: {
    'image001.jpg': [
      'Test 03',
      'Enough',
      'bayleaf',
      'Test',
      'New',
      'Test 01',
      'Test 02',
      'Words',
      'altoids',
      'are',
      'hudson',
      'kooTEK',
      'lalala',
      'nEeeDeD',
    ],
    'image002.jpg': [
      'Enough',
      'New',
      'Test',
      'Test 01',
      'Test 02',
      'Test 03',
      'Words',
      'altoids',
      'are',
      'bayleaf',
      'hudson',
      'kooTEK',
      'lalala',
      'nEeeDeD',
    ],
    'image003.jpg': [
      'are',
      'kooTEK',
      'Enough',
      'Test 01',
      'altoids',
      'bayleaf',
      'Test 02',
      'Test 03',
      'Test',
      'New',
      'hudson',
      'Words',
      'lalala',
      'nEeeDeD',
    ],
    'image004.jpg': [
      'Enough',
      'are',
      'kooTEK',
      'altoids',
      'Test 01',
      'Test 02',
      'Words',
      'lalala',
      'Test',
      'New',
      'Test 03',
      'bayleaf',
      'nEeeDeD',
      'hudson',
    ],
    'image005.jpg': [
      'are',
      'Test 02',
      'kooTEK',
      'New',
      'Enough',
      'Test',
      'altoids',
      'Test 03',
      'Words',
      'Test 01',
      'bayleaf',
      'lalala',
      'nEeeDeD',
      'hudson',
    ],
    'image006.jpg': [
      'Test 02',
      'kooTEK',
      'Test 01',
      'Words',
      'Test',
      'New',
      'Enough',
      'Test 03',
      'altoids',
      'are',
      'bayleaf',
      'hudson',
      'lalala',
      'nEeeDeD',
    ],
    'image007.jpg': [
      'kooTEK',
      'New',
      'Test 02',
      'Test 03',
      'Enough',
      'Test',
      'Test 01',
      'Words',
      'altoids',
      'are',
      'bayleaf',
      'hudson',
      'lalala',
      'nEeeDeD',
    ],
  },
  monitor: {
    'image001.jpg': ['4376471154038'],
    'image002.jpg': ['4376471154038'],
    'image003.jpg': ['This is a computer generated QR Code'],
    'image006.jpg': ['This is a computer generated QR Code'],
    'image007.jpg': ['This is a computer generated QR Code'],
    'image008.jpg': ['This is a computer generated QR Code'],
    'image009.jpg': ['This is a computer generated QR Code'],
    'image010.jpg': ['This is a computer generated QR Code'],
    'image011.jpg': ['This is a computer generated QR Code'],
    'image012.jpg': ['This is a computer generated QR Code'],
    'image013.jpg': ['This is a computer generated QR Code'],
    'image015.jpg': ['This is a computer generated QR Code'],
    'image016.jpg': ['This is a computer generated QR Code'],
    'image017.jpg': ['This is a computer generated QR Code'],
  },
  nominal: {
    'image005.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"171227103636638907587520201AZ"}}'],
    'image007.jpg': ['http://www.facebook.com/LangersJuice'],
    'image010.jpg': ['http://www.facebook.com/LangersJuice'],
    'image011.jpg': ['http://www.facebook.com/LangersJuice'],
    'image013.jpg': ['http://www.lonelyplanet.com/'],
    'image014.jpg': ['http://www.lonelyplanet.com/'],
    'image015.jpg': ['http://www.lonelyplanet.com/'],
    'image016.jpg': ['http://www.lonelyplanet.com/'],
    'image020.jpg': ['http://www.teagoetz.com/'],
    'image023.jpg': ['http://www.teagoetz.com/'],
    'image024.jpg': ['https://mobile-now.us/?l=10043659'],
    'image025.jpg': ['http://onramp.ehi.com/HYUN/ACNT/4SE/US/?v=KMHCT4AE3GU107709'],
    'image026.jpg': ['0555506635839349055557'],
    'image027.jpg': ['0555506635839349055557'],
    'image028.jpg': ['0555506635839349055557'],
    'image029.jpg': ['0555506635839349055557'],
    'image030.jpg': ['http://onramp.ehi.com/HYUN/ACNT/4SE/US/?v=KMHCT4AE3GU107709'],
    'image031.jpg': ['0555506635839349055557'],
    'image032.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image033.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image034.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image035.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image036.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image037.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image038.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image039.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image040.jpg': ['https://www.instagram.com/lethmik/'],
    'image041.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image042.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/45076039?sku=7016-01'],
    'image045.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image046.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image047.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image048.jpg': ['http://bit.ly/l5qo2F?r=qr'],
    'image049.jpg': ['65729741957'],
    'image050.jpg': ['65729741957'],
    'image051.jpg': ['http://goo.gl/ErBxV'],
    'image052.jpg': ['http://goo.gl/ErBxV'],
    'image053.jpg': ['http://goo.gl/ErBxV'],
    'image054.jpg': ['http://www.bestekmall.com/'],
    'image055.jpg': ['http://www.bestekmall.com/'],
    'image057.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"180410194824527404022960201AZ"}}'],
    'image058.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"180410194824527404022960201AZ"}}'],
    'image059.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"180410194824527404022960201AZ"}}'],
    'image060.jpg': ['http://www.bestekmall.com/'],
    'image061.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"180410194824527404022960201AZ"}}'],
    'image062.jpg': [
      'http://www.postalexperience.com/pos?mt=4&sc=840-5940-0244-002-00006-80522-02',
    ],
    'image063.jpg': [
      'http://www.postalexperience.com/pos?mt=4&sc=840-5940-0244-002-00006-80522-02',
    ],
    'image064.jpg': [
      'http://www.postalexperience.com/pos?mt=4&sc=840-5940-0244-002-00006-80522-02',
    ],
    'image065.jpg': ['GH69-28945C'],
  },
  noncompliant: {
    'image001.jpg': ['http://q-r.to/baf6RY'],
    'image002.jpg': ['http://q-r.to/bafD2I', 'http://q-r.to/baf6RY'],
    'image003.jpg': ['http://q-r.to/baf6RY', 'http://q-r.to/bafD2I'],
    'image004.jpg': ['http://q-r.to/bafD2I', 'http://q-r.to/baf6RY'],
    'image006.jpg': ['http://www.radians.com/sizing_charts/'],
    'image009.jpg': ['http://q-r.to/bafD2I', 'http://q-r.to/baf6RY'],
    'image010.jpg': ['http://q-r.to/bafD2I', 'http://q-r.to/baf6RY'],
    'image011.jpg': ['http://q-r.to/bafD2I', 'http://q-r.to/baf6RY'],
    'image012.jpg': ['http://q-r.to/baf6RY', 'http://q-r.to/bafD2I'],
    'image013.jpg': ['http://q-r.to/baf6RY', 'http://q-r.to/bafD2I'],
    'image014.jpg': ['http://q-r.to/baf6RY'],
  },
  pathological: {
    'image005.png': ['MAILTO:name@myemail.com'],
    'image007.png': ['MAILTO:name@myemail.com'],
    'image009.png': ['MAILTO:name@myemail.com'],
    'image012.png': ['MAILTO:name@myemail.com'],
    'image013.png': ['MAILTO:name@myemail.com'],
    'image015.png': ['MAILTO:name@myemail.com'],
    'image016.png': ['MAILTO:name@myemail.com'],
    'image018.png': ['MAILTO:name@myemail.com'],
    'image020.png': ['MAILTO:name@myemail.com'],
    'image021.png': ['MAILTO:name@myemail.com'],
    'image022.png': ['MAILTO:name@myemail.com'],
    'image023.png': ['MAILTO:name@myemail.com'],
  },
  perspective: {
    'image001.jpg': ['TEST 10 CM'],
    'image002.jpg': ['TEST 10 CM'],
    'image003.jpg': ['TEST 10 CM'],
    'image004.jpg': ['TEST 10 CM'],
    'image005.jpg': ['TEST 10 CM'],
    'image006.jpg': ['TEST 10 CM'],
    'image007.jpg': ['TEST 10 CM'],
    'image008.jpg': ['TEST 10 CM'],
    'image009.jpg': ['TEST 10 CM'],
    'image010.jpg': ['TEST 10 CM'],
    'image011.jpg': ['TEST 10 CM'],
    'image012.jpg': ['TEST 10 CM'],
    'image017.jpg': ['TEST 10 CM'],
    'image018.jpg': ['TEST 10 CM'],
    'image019.jpg': ['TEST 10 CM'],
    'image020.jpg': ['TEST 10 CM'],
    'image021.jpg': ['TEST 10 CM'],
    'image023.jpg': ['TEST 10 CM'],
  },
  rotations: {
    'image001.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image002.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image003.jpg': [
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
    ],
    'image004.jpg': [
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
    ],
    'image005.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
      'Version 2 QR Code Test Image',
    ],
    'image006.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image007.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
      'Version 1 QR',
    ],
    'image008.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
    ],
    'image009.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
    ],
    'image010.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image011.jpg': [
      'Version 2 QR Code Test Image',
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image012.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image013.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image014.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
      'Version 1 QR',
    ],
    'image015.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
      'Version 1 QR',
    ],
    'image016.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
      'Version 1 QR',
    ],
    'image017.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
      'Version 1 QR',
    ],
    'image018.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
      'Version 1 QR',
    ],
    'image019.jpg': [
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
    ],
    'image020.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 1 QR',
    ],
    'image021.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image022.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image023.jpg': ['Version 2 QR Code Test Image'],
    'image024.jpg': ['Version 2 QR Code Test Image'],
    'image025.jpg': ['Version 2 QR Code Test Image'],
    'image026.jpg': ['Version 2 QR Code Test Image'],
    'image027.jpg': ['Version 2 QR Code Test Image'],
    'image028.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
    ],
    'image029.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
    ],
    'image030.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
    ],
    'image031.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image032.jpg': ['Version 2 QR Code Test Image'],
    'image033.jpg': ['Version 2 QR Code Test Image'],
    'image034.jpg': ['Version 2 QR Code Test Image'],
    'image035.jpg': ['Version 2 QR Code Test Image'],
    'image036.jpg': ['Version 2 QR Code Test Image'],
    'image037.jpg': ['Version 2 QR Code Test Image'],
    'image038.jpg': ['Version 2 QR Code Test Image'],
    'image039.jpg': ['Version 2 QR Code Test Image'],
    'image040.jpg': ['Version 2 QR Code Test Image'],
    'image041.jpg': ['Version 2 QR Code Test Image', 'Version 1 QR'],
    'image042.jpg': ['Version 2 QR Code Test Image'],
    'image043.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image044.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
  },
  shadows: {
    'image001.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image002.jpg': [
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image003.jpg': [
      'Version 1 QR',
      'Version 2 QR Code Test Image',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image004.jpg': ['Version 2 QR Code Test Image', 'Version 1 QR'],
    'image005.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image006.jpg': ['Version 1 QR'],
    'image007.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image008.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image009.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image010.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image012.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/45076039?sku=7016-01'],
    'image013.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/45076039?sku=7016-01'],
    'image014.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
  },
};

// These max-effort/all results are absent from ordinary first-result behavior.
// A first-result success or all-result change fails until this set/table is updated.
const DECODED_ALL_ONLY = new Set([
  'detection/curved/image022.jpg',
  'detection/high_version/image002.jpg',
  'detection/rotations/image021.jpg',
  'detection/rotations/image022.jpg',
  'detection/rotations/image025.jpg',
  'detection/rotations/image028.jpg',
  'detection/rotations/image029.jpg',
  'detection/rotations/image030.jpg',
  'detection/rotations/image031.jpg',
  'detection/rotations/image032.jpg',
  'detection/rotations/image033.jpg',
  'detection/rotations/image035.jpg',
  'detection/rotations/image036.jpg',
  'detection/rotations/image037.jpg',
  'detection/rotations/image038.jpg',
]);

it('decodeQR decodes the supplied high-density QR image', () => {
  // Source attribution lives next to the fixture in misc/README.md.
  // Assert the whole payload so a partial or corrupt decode cannot pass.
  const expected = [
    'ew0KICAicmVnaXN0cmF0aW9uX3Rva2VuIjogImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSlNVekkxTmlJc0luZzFkQ0k2',
    'SWxWcFNuSTRWRlp0WlVoTlUyaE5TRTVOWWsxVVNEWkhWRlZtVFNJc0ltdHBaQ0k2SWxWcFNuSTRWRlp0WlVoTlUyaE5TRTVO',
    'WWsxVVNEWkhWRlZtVFNKOS5leUp6WTI5d1pTSTZJazlUU0Y5SlJGQmZSSGx1UTJ4cFpXNTBVbVZuSWl3aVlYVjBiMTl5Wldk',
    'cGMzUnlZWFJwYjI0aU9pSlVjblZsSWl3aVozSmhiblJmZEhsd1pTSTZJbU5zYVdWdWRGOWpjbVZrWlc1MGFXRnNjeUlzSW5O',
    'bGNuWmxjbDlqWlhKMFgzUm9kVzFpY0hKcGJuUnpJam9pSWl3aWFYTnpJam9pVDFOSVEyOXlaVWxrWlc1MGFYUjVVMlZ5ZG1W',
    'eUlpd2lZWFZrSWpvaVQxTklRMjl5WlVsa1pXNTBhWFI1VTJWeWRtVnlMM0psYzI5MWNtTmxjeUlzSW1WNGNDSTZNVFUxTURF',
    'M056Y3hPQ3dpYm1KbUlqb3hOVFV3TURVME5UazFmUS5pc0Nlb0FCblBzU2pIYTdpX1hjdkdXWXVaRDBJanNRZ2JsQUpuY19R',
    'TFMwUmE2V29xekFZVjVYbW03a24tVGM4M2R1V3hEaXFJMEgzaWt4OXBkcGp6MC1aTjkzeGxyLTRYMjZBdFQyRzVNcHpxWDBC',
    'ZF9YT2Rva0h4aEVqTDhxY1ltUEZ0T2ZIUTY0ZUkxQW5fbEZET205NUtEVTZCUHY4WWNtckFsMlljVlk5THRHeHhrbFh5ZnNk',
    'c2tubW02WDRoUFMxV3ZDQ3Y5REF5QkpnTUNqS0paUmtndnhaV2U2d0NnMHlUM3VpekU0WGtuT21kYzBRcnEwTm1KcGxWQkVa',
    'RUptVko5TXNVZHRucG9pZGdTclh3WjltQmoxRDh3anZfZXFlaXBuNUhWTExoQ3g1Y0xiMkhGUDlyRTRnUGRQb2l6TlktNnha',
    'VjVYS3p5cDNHdy1jZXciLA0KICAic29mdHdhcmVfc3RhdGVtZW50IjogImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSlNV',
    'ekkxTmlJc0luZzFkQ0k2SWxWcFNuSTRWRlp0WlVoTlUyaE5TRTVOWWsxVVNEWkhWRlZtVFNJc0ltdHBaQ0k2SWxWcFNuSTRW',
    'Rlp0WlVoTlUyaE5TRTVOWWsxVVNEWkhWRlZtVFNKOS5leUp6WTI5d1pTSTZJazFGVWxBZ1QxTklYMGxOWDFWelpYSnpYMUps',
    'WVdRaUxDSnBjM01pT2lKUFUwaERiM0psU1dSbGJuUnBkSGxUWlhKMlpYSWlMQ0poZFdRaU9pSlBVMGhEYjNKbFNXUmxiblJw',
    'ZEhsVFpYSjJaWEl2Y21WemIzVnlZMlZ6SWl3aVpYaHdJam94TlRVd01UYzNOekU0TENKdVltWWlPakUxTlRBd05UUTFPVFY5',
    'Lk9DTzZRRW41YlJXSVh5QURnYnlNOUlXSG42SVM2RXdqLWdOcmVvV1NSdmc0Y2oxc0ExWV9TVUVNSncwREFNUTl3UVVaMlYy',
    'M0lJc1h1cUx1bmJGeEltNENvZEo2VXB2NTVPejE5Sk1oNXpzNFU3aERjMTJYXy1jTEdYbWN4M1l3SXdKQXZSa2haODF4STVQ',
    'Q2FIOXZoTkt3V2kzaExhcndMTy1KdFB1T2Etd1ZQRktFb3lTNzN1WjBtWFZWYU5xczAtaHA3TGhrcTlEc0NhdEYtNGNZUWpu',
    'REFvemp0UG1RZkNYTVBKQlcyLXhrLU9sU19Bcy1RQlhsNGV0clVRdVc0bldiLW1hOVF3UnZ0bnYwS0dZMkUtckYzQnNiY0tE',
    'aHp2QnJpRjkyMXVYQWRMVWJmOUZzZGpHZ1VaZV85cTVFVUw5cFhwNFJuNm5PczdxNXFVTnF4USIsDQogICJyZWdpc3RyYXRp',
    'b25fdXNlX3Byb3h5IjogdHJ1ZSwNCiAgInJlZ2lzdHJhdGlvbl91cmwiOiAiaHR0cHM6Ly9lZGdlLm9wYWwtaG9sZGluZy5j',
    'b20vczAzIiwNCiAgInJlZ2lzdHJhdGlvbl9wb3J0IjogMA0KfQ==',
  ].join('');
  deepStrictEqual(readQR(readImage('../../vectors/misc/user-images-53473345.png')), expected);
});

export const DECODE_VECTOR_EXCLUDE: string[] = [];

const listFiles = (path, isDir = false) =>
  readdirSync(path).filter((i) => statSync(`${path}/${i}`).isDirectory() === isDir);

it('gh-28 (invert)', () => {
  // Keep this real fixture in the ordinary suite so detector rewrites cannot silently drop
  // reflectance-reversal support by deleting its regression test.
  deepStrictEqual(readQR(readImage('../issues/invert.jpg')), 'https://patreon.com/reactiive');
});

// The table locks recorded vector behavior: listed images must decode to one of
// their listed payloads, while unlisted images must remain undecoded. Checking
// the complete list at max effort ensures that bounded default effort or another
// QR in the same image cannot hide a change in the complete result set.
for (const category of listFiles(DETECTION_PATH, true)) {
  const DIR_PATH = `${DETECTION_PATH}/${category}`;
  it(`Decoding/${category} matches the result table`, async () => {
    const BATCH_SIZE = 8; // Reuse scanners without retaining a whole high-resolution category.
    const mismatches: {
      path: string;
      expected: string[] | undefined;
      actual: { first: string | undefined; all: string[] };
      failed: ('first' | 'all')[];
    }[] = [];
    const files = listFiles(DIR_PATH).filter(isDecodeImage);
    for (let offset = 0; offset < files.length; offset += BATCH_SIZE) {
      const batch = files.slice(offset, offset + BATCH_SIZE);
      const images = batch.map((file) => readLuma(`detection/${category}/${file}`));
      const maxSize = images.reduce(
        (size, image) => ({
          height: Math.max(size.height, image.height),
          width: Math.max(size.width, image.width),
        }),
        { height: 0, width: 0 }
      );
      const scanner = new _QRScanner({ format: 'I420', maxSize });
      const firstResults = images.map((image) => {
        scanner.addImage(image, 'I420');
        return scanner.decode()[0];
      });
      scanner.clean();
      const allResults = await decodeQRBatch(images, {
        effort: Infinity,
        format: 'I420',
        maxSize,
        timeLimit: Infinity,
      });
      for (let index = 0; index < batch.length; index++) {
        const f = batch[index];
        const p = `detection/${category}/${f}`;
        const decoded = DECODED[category][f];
        const firstResult = firstResults[index];
        const first = typeof firstResult === 'string' ? firstResult : undefined;
        const all = [
          ...new Set(allResults[index].filter((result) => typeof result === 'string')),
        ].sort();
        const expected = decoded ? [...decoded].sort() : [];
        const matchesAll =
          all.length === expected.length &&
          all.every((payload, expectedIndex) => payload === expected[expectedIndex]);
        const matchesFirst = DECODED_ALL_ONLY.has(p)
          ? first === undefined
          : decoded === undefined
            ? first === undefined
            : first !== undefined && decoded.includes(first);
        const failed: ('first' | 'all')[] = [];
        if (!matchesFirst) failed.push('first');
        if (!matchesAll) failed.push('all');
        if (failed.length)
          mismatches.push({ path: p, expected: decoded, actual: { first, all }, failed });
      }
    }
    deepStrictEqual(mismatches, []);
  });
}

it.runWhen(import.meta.url);
