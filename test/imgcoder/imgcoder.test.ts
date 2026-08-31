import { it } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import decodeQR from '../../src/decode.ts';
import { encodeQR } from '../../src/index.ts';
import { decodeGIF } from '../misc/gif.ts';
import { JPG_FIXTURES } from '../misc/jpg-fixtures.ts';
import { decodeJPG } from '../misc/jpg.ts';
import { decodePNG } from '../misc/png.ts';
import { _dirname } from '../utils.ts';
import { decodeGIFLuma, GIF } from './gif.ts';
import { decodeJPEGLuma, JPEG } from './jpeg.ts';
import { decodePNGLuma, PNG } from './png.ts';

const rgbaLuma = (image: { width: number; height: number; data: Uint8Array }) => {
  const data = new Uint8Array(image.width * image.height);
  for (let src = 0, dst = 0; dst < data.length; src += 4, dst++)
    data[dst] = (image.data[src] + 2 * image.data[src + 1] + image.data[src + 2]) >>> 2;
  return { width: image.width, height: image.height, data };
};

// prettier-ignore
const jpeg = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xdb, 0, 67, 0,
  ...Array.from({ length: 64 }, (_, i) => i + 1),
  0xff, 0xc0, 0, 17, 8, 0, 2, 0, 3, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda,
  0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0x11, 0xff, 0, 0x22, 0xff, 0xd0, 0x33, 0xff, 0xd9
]);

// prettier-ignore
const png = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68,
  82, 0, 0, 0, 3, 0, 0, 0, 2, 8, 0, 0, 0, 0, 0x11, 0x22, 0x33, 0x44, 0, 0, 0,
  3, 73, 68, 65, 84, 1, 2, 3, 0x55, 0x66, 0x77, 0x88, 0, 0, 0, 0, 73, 69, 78, 68, 0x99, 0xaa, 0xbb, 0xcc
]);

// prettier-ignore
const gif = Uint8Array.from([
  71, 73, 70, 56, 57, 97, 2, 0,
  1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0,
  2, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b
]);

it('imgcoder: JPEG exposes tables, frame, scan, and luma component without RGBA', () => {
  deepStrictEqual(JPEG.decode(jpeg), {
    quantization: [
      {
        id: 0,
        precision: 8,
        values: Array.from({ length: 64 }, (_, i) => i + 1),
      },
    ],
    huffman: [],
    frames: [
      {
        kind: 'baseline',
        precision: 8,
        height: 2,
        width: 3,
        components: [
          { id: 1, horizontal: 2, vertical: 2, quantization: 0 },
          { id: 2, horizontal: 1, vertical: 1, quantization: 1 },
          { id: 3, horizontal: 1, vertical: 1, quantization: 1 },
        ],
      },
    ],
    scans: [
      {
        components: [
          { id: 1, dc: 0, ac: 0 },
          { id: 2, dc: 1, ac: 1 },
          { id: 3, dc: 1, ac: 1 },
        ],
        spectralStart: 0,
        spectralEnd: 63,
        successiveHigh: 0,
        successiveLow: 0,
        entropy: Uint8Array.of(0x11, 0xff, 0, 0x22, 0xff, 0xd0, 0x33),
      },
    ],
    restartInterval: undefined,
    metadata: [],
    luma: { kind: 'ycbcr', component: 1 },
  });
});

it('imgcoder: PNG exposes chunks and compressed scanlines without RGBA', () => {
  const value = PNG.decode(png);
  deepStrictEqual(value, {
    header: {
      width: 3,
      height: 2,
      bitDepth: 8,
      color: 'grayscale',
      compression: 0,
      filter: 0,
      interlace: 0,
    },
    palette: undefined,
    transparency: undefined,
    idat: [Uint8Array.of(1, 2, 3)],
    chunks: [
      {
        type: 'IHDR',
        data: png.subarray(16, 29),
        crc: 0x11223344,
      },
      {
        type: 'IDAT',
        data: Uint8Array.of(1, 2, 3),
        crc: 0x55667788,
      },
      { type: 'IEND', data: new Uint8Array(), crc: 0x99aabbcc },
    ],
    luma: { kind: 'grayscale', bits: 8 },
  });
  deepStrictEqual(PNG.encode(value), png);
});

it('imgcoder: GIF exposes palettes and LZW sub-blocks without RGBA', () => {
  const value = GIF.decode(gif);
  deepStrictEqual(value, {
    version: '89a',
    screen: {
      width: 2,
      height: 1,
      colorResolution: 1,
      sorted: false,
      background: 0,
      aspect: 0,
    },
    globalPalette: Uint8Array.of(0, 0, 0, 255, 255, 255),
    blocks: [
      {
        type: 'image',
        left: 0,
        top: 0,
        width: 2,
        height: 1,
        interlaced: false,
        sorted: false,
        localPalette: undefined,
        lzwMinimumCodeSize: 2,
        data: [Uint8Array.of(0x44, 1)],
      },
    ],
    luma: { kind: 'indexed' },
  });
  deepStrictEqual(GIF.encode(value), gif);
});

it('imgcoder: compressed image payloads stay zero-copy source views', () => {
  const jpg = JPEG.decode(jpeg);
  const pngValue = PNG.decode(png);
  const gifValue = GIF.decode(gif);
  const image = gifValue.blocks[0];
  if (image.type !== 'image') throw new Error('expected GIF image block');
  deepStrictEqual(
    {
      jpegEntropy: jpg.scans[0].entropy.buffer === jpeg.buffer,
      pngIdat: pngValue.idat[0].buffer === png.buffer,
      gifPalette: gifValue.globalPalette!.buffer === gif.buffer,
      gifLzw: image.data[0].buffer === gif.buffer,
    },
    {
      jpegEntropy: true,
      pngIdat: true,
      gifPalette: true,
      gifLzw: true,
    }
  );
});

it('imgcoder: rejects the wrong container magic', () => {
  throws(() => JPEG.decode(new Uint8Array()));
  throws(() => PNG.decode(new Uint8Array()));
  throws(() => GIF.decode(new Uint8Array()));
});

it('imgcoder: JPEG, PNG, and GIF extract exact luma into reusable storage', () => {
  // Uint8Array.fromBase64 is missing in Node < 25
  const jpegBytes = new Uint8Array(Buffer.from(JPG_FIXTURES.gray, 'base64'));
  const pngBytes = new Uint8Array(
    readFileSync(join(_dirname, 'vectors', 'boofcv-v3', 'decoding', 'v2Website.png'))
  );
  const gifBytes = encodeQR('IMG LUMA', 'gif', { ecc: 'medium', scale: 4 });
  const cases = [
    [decodeJPEGLuma, jpegBytes, rgbaLuma(decodeJPG(jpegBytes))],
    [decodePNGLuma, pngBytes, rgbaLuma(decodePNG(pngBytes))],
    [decodeGIFLuma, gifBytes, rgbaLuma(decodeGIF(gifBytes))],
  ] as const;
  for (const [decode, bytes, expected] of cases) {
    deepStrictEqual(decode(bytes), expected);
    const data = new Uint8Array(expected.data.length).fill(0xa5);
    const actual = decode(bytes, data);
    deepStrictEqual(actual, { width: expected.width, height: expected.height, data });
    deepStrictEqual(actual.data === data, true);
    deepStrictEqual(decodeQR(actual, { format: 'I420' }), decodeQR(expected, { format: 'I420' }));
    throws(() => decode(bytes, data.subarray(1)), /expected .* luma bytes/);
  }
});

it('imgcoder: truncated GIF luma does not invent zero-filled LZW codes', () => {
  // Keep the clear and first pixel codes, then end the sub-block before the second pixel and EOI.
  const truncated = Uint8Array.from([...gif.subarray(0, 32), 0, 0x3b]);
  truncated[30] = 1;
  truncated.fill(96, 16, 19); // Make an invented second palette index observable against white.
  deepStrictEqual(decodeGIFLuma(truncated), {
    width: 2,
    height: 1,
    data: Uint8Array.of(0, 255),
  });
});
