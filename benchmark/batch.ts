import { bench } from '@paulmillr/jsbt/benchmark.js';
import { deepStrictEqual } from 'node:assert';

import decodeQR, { _QRScanner, decodeQRBatch, type Image } from '../src/decode.ts';
import { encodeQR } from '../src/index.ts';
import { matrixToImage } from '../test/utils.ts';
import { section } from './_utils.ts';

const make = (scale: number): Image =>
  matrixToImage(encodeQR('BATCH', 'raw', { border: 4 }), scale);

const run = async (name: string, scales: number[], maxSide: number) => {
  const images = scales.map(make);
  const maxSize = { width: maxSide, height: maxSide };
  const current = () => images.map((image) => decodeQR(image));
  const candidate = () => decodeQRBatch(images, { maxSize });
  const expected = current();
  deepStrictEqual(
    (await candidate()).map((results) =>
      results.map((result) => (result instanceof Error ? result.message : result))
    ),
    expected.map((result) => [result, 'finder'])
  );

  section(`${name}: ${images.length} mixed-size RGBA images`);
  await bench('images.map(decodeQR)', current);
  await bench('decodeQRBatch', candidate);

  const scanner = new _QRScanner({ maxSize });
  const lumas = images.map((image) => {
    const pixels = image.width * image.height;
    const out = new Uint8Array(pixels);
    for (let i = 0, p = 0; i < pixels; i++, p += 4)
      out[i] = (image.data[p] + 2 * image.data[p + 1] + image.data[p + 2]) >> 2;
    return out;
  });
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    scanner.addImage(image);
    deepStrictEqual(scanner.luma.slice(0, image.width * image.height), lumas[i]);
  }
  const ingest = () => {
    let checksum = 0;
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      scanner.addImage(image);
      checksum ^= scanner.luma[image.width * image.height - 1];
    }
    return checksum;
  };
  ingest();
  await bench('addImage only', ingest);
  const reused = () => {
    let result = '';
    for (const image of images) {
      scanner.addImage(image);
      const decoded = scanner.decode()[0];
      if (decoded instanceof Error) throw decoded;
      result = decoded;
    }
    return result;
  };
  deepStrictEqual(reused(), expected.at(-1));
  await bench('reused scanner', reused);
  scanner.clean();
};

await run('up to 512px', [4, 7, 11, 16], 512);
await run('up to 3840px', [8, 16, 32, 64, 128], 3840);
