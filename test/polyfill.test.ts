import { it } from '@paulmillr/jsbt/test.js';
import globalJsdom from 'global-jsdom';
import { deepStrictEqual } from 'node:assert';
import { createRequire } from 'node:module';
import { encodeQR } from '../src/index.ts';
import { BarcodeDetector } from '../src/decode.ts';
import { matrixToImage } from './utils.ts';

// Module-level, never cleaned up: a per-test cleanup() would tear down the
// shared jsdom that dom.test.ts installed for every other test in the process.
// Guarded manually because global-jsdom's own idempotency check only works on
// Node.js (it sniffs navigator.userAgent), so under Bun/Deno a second call
// would replace dom.test.ts's `resources: 'usable'` instance.
if (typeof document === 'undefined') globalJsdom();

// The native `canvas` binding is unavailable when install scripts are blocked
// (CI runs `npm ci --ignore-scripts`; Bun and Deno block them by default).
// Probed synchronously: top-level await makes Bun's test workers exit early.
const canvas = (() => {
  try {
    return createRequire(import.meta.url)('canvas') as typeof import('canvas');
  } catch {
    return undefined;
  }
})();

it('BarcodeDetector follows WebIDL dictionary conversion', () => {
  let nullError: unknown;
  try {
    new BarcodeDetector(null as never);
  } catch (error) {
    nullError = error;
  }
  const acceptedPrimitives: unknown[] = [];
  for (const value of [3, 'x', false]) {
    try {
      new BarcodeDetector(value as never);
      acceptedPrimitives.push(value);
    } catch {}
  }
  let iterableError: unknown;
  try {
    new BarcodeDetector({ formats: new Set(['qr_code']) as never });
  } catch (error) {
    iterableError = error;
  }
  deepStrictEqual(
    { nullError, acceptedPrimitives, iterableError },
    { nullError: undefined, acceptedPrimitives: [], iterableError: undefined }
  );
});

(typeof Float16Array === 'undefined' ? it.skip : it)('BarcodeDetector detects rgba-float16 ImageData', async () => {
  const src = matrixToImage(
    encodeQR('FLOAT16', 'raw', {
      version: 1,
      border: 4,
      scale: 4,
      mask: 0,
      ecc: 'low',
    }),
    1
  );
  // ImageDataSettings.pixelFormat='rgba-float16' exposes 0..1 RGBA values
  // in a Float16Array instead of 0..255 values in a Uint8ClampedArray.
  const image = {
    width: src.width,
    height: src.height,
    data: Float16Array.from(src.data, (value) => value / 255),
    [Symbol.toStringTag]: 'ImageData',
  } as never;
  deepStrictEqual(
    await new BarcodeDetector({ formats: ['qr_code'] }).detect(image),
    [
      {
        boundingBox: new DOMRectReadOnly(16, 16, 84, 84),
        rawValue: 'FLOAT16',
        format: 'qr_code',
        cornerPoints: [
          { x: 16, y: 16 },
          { x: 100, y: 16 },
          { x: 100, y: 100 },
          { x: 16, y: 100 },
        ],
      },
    ]
  );
});

(canvas ? it : it.skip)(
  'BarcodeDetector reports affine-accurate geometry for a flat 45-degree rotation',
  async () => {
    const { createCanvas, ImageData } = canvas!;
    const raw = encodeQR('A', 'raw', {
      version: 1,
      border: 4,
      scale: 8,
      mask: 0,
      ecc: 'low',
    });
    const src = matrixToImage(raw, 1);
    const source = createCanvas(src.width, src.height);
    source
      .getContext('2d')
      .putImageData(new ImageData(Uint8ClampedArray.from(src.data), src.width, src.height), 0, 0);
    const side = 337;
    const center = side / 2;
    const target = createCanvas(side, side);
    const context = target.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, side, side);
    context.imageSmoothingEnabled = false;
    context.translate(center, center);
    context.rotate(Math.PI / 4);
    context.drawImage(source, -src.width / 2, -src.height / 2);
    context.resetTransform();
    const detected = await new BarcodeDetector({
      formats: ['qr_code'],
    }).detect(context.getImageData(0, 0, side, side) as never);
    const rounded = detected.map(({ boundingBox, rawValue, format, cornerPoints }) => ({
      boundingBox: {
        x: Math.round(boundingBox.x),
        y: Math.round(boundingBox.y),
        width: Math.round(boundingBox.width),
        height: Math.round(boundingBox.height),
        top: Math.round(boundingBox.top),
        right: Math.round(boundingBox.right),
        bottom: Math.round(boundingBox.bottom),
        left: Math.round(boundingBox.left),
      },
      rawValue,
      format,
      cornerPoints: cornerPoints.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })),
    }));
    // The projected decoder quad is the ponyfill's geometry source. Finder-center quantization
    // makes it slightly wider than the theoretical raster transform, within WPT's QR tolerance.
    deepStrictEqual(rounded, [
      {
        boundingBox: {
          x: 48,
          y: 48,
          width: 240,
          height: 240,
          top: 48,
          right: 288,
          bottom: 288,
          left: 48,
        },
        rawValue: 'A',
        format: 'qr_code',
        cornerPoints: [
          { x: 168, y: 48 },
          { x: 288, y: 168 },
          { x: 168, y: 288 },
          { x: 48, y: 168 },
        ],
      },
    ]);
  }
);

it('BarcodeDetector orders rotated cornerPoints clockwise from image top-left', async () => {
  const source = encodeQR('A', 'raw', {
    version: 1,
    border: 4,
    scale: 4,
    mask: 0,
    ecc: 'low',
  });
  const rotated = source[0].map((_, x) => source.map((row) => row[x]).reverse());
  const src = matrixToImage(rotated, 1);
  const image = {
    width: src.width,
    height: src.height,
    data: Uint8ClampedArray.from(src.data),
    [Symbol.toStringTag]: 'ImageData',
  } as never;
  deepStrictEqual(
    await new BarcodeDetector({ formats: ['qr_code'] }).detect(image),
    [
      {
        boundingBox: new DOMRectReadOnly(16, 16, 84, 84),
        rawValue: 'A',
        format: 'qr_code',
        cornerPoints: [
          { x: 16, y: 16 },
          { x: 100, y: 16 },
          { x: 100, y: 100 },
          { x: 16, y: 100 },
        ],
      },
    ]
  );
});

it.runWhen(import.meta.url);
