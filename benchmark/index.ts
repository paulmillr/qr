import { bench } from '@paulmillr/jsbt/bench.js';
import { deepStrictEqual } from 'node:assert';
import decodeQR from '../src/decode.ts';
import { Bitmap, encodeQR } from '../src/index.ts';

const section = (name) => console.log(`\n# ${name}`);

function imageFromText(text, opts = {}) {
  const { scale = 4, ...qrOpts } = opts;
  const raw = encodeQR(text, 'raw', { border: 4, ecc: 'medium', ...qrOpts });
  return new Bitmap(raw.length, raw).scale(scale).toImage();
}

const smallText = 'HELLO WORLD';
const largeText = 'H'.repeat(768);
const smallImage = imageFromText(smallText, { version: 1, scale: 4 });
const largeImage = imageFromText(largeText, { scale: 2 });

async function main() {
  section('encode');
  await bench('ascii small', () => encodeQR(smallText, 'ascii', { ecc: 'medium' }));
  await bench('gif small', () => encodeQR(smallText, 'gif', { ecc: 'medium' }));
  await bench('svg small', () => encodeQR(smallText, 'svg', { ecc: 'medium' }));

  section('encode large');
  await bench('raw large', () => encodeQR(largeText, 'raw', { ecc: 'medium' }));
  await bench('ascii large', () => encodeQR(largeText, 'ascii', { ecc: 'medium' }));

  section('decode generated');
  await bench('v1 scale4', () => deepStrictEqual(decodeQR(smallImage), smallText));
  await bench('large scale2', () => deepStrictEqual(decodeQR(largeImage), largeText));
}

main();
