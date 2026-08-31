import { bench } from '@paulmillr/jsbt/benchmark.js';
import { deepStrictEqual } from 'node:assert';
import { encodeQR } from '../src/index.ts';
import {
  benchRotating,
  encodeVersion,
  hasVectors,
  isAlnum,
  loadBuckets,
  loadDecoder,
  section,
  SUBMODULE_HINT,
  syntheticImages,
  TEXTS,
  type LoadedBucket,
} from './_utils.ts';

const { decodeQR, path: decoderPath, isDefault } = await loadDecoder();

const tryDecode = (img, opts?) => {
  try {
    return decodeQR(img, opts);
  } catch {
    return undefined;
  }
};

async function main() {
  if (!isDefault) console.log(`# decoder=${decoderPath}`);

  // 1.2GB of RAM (12MP set is 80%)
  const buckets: LoadedBucket[] = [];
  if (hasVectors()) {
    for (const bucket of await loadBuckets()) {
      bucket.images.forEach((img, i) => {
        const knownFailure = (bucket.knownFailures ?? []).some((p) => bucket.paths[i].endsWith(p));
        if ((tryDecode(img) !== undefined) === (bucket.expectOk && !knownFailure)) return;
        const drift = `photo bucket drift: ${bucket.name} / ${bucket.paths[i]}`;
        if (isDefault) throw new Error(drift);
        console.log(`# warning: ${drift}`);
      });
      buckets.push(bucket);
    }
  }

  const encode = encodeQR as (text: string, output: string, opts?: object) => unknown;
  for (const text of Object.values(TEXTS)) {
    const mode = isAlnum(text) ? 'alphanumeric' : 'byte';
    section(`encode v${encodeVersion(text)}, ${text.length} chars (${mode})`);
    for (const output of ['raw', 'ascii', 'gif', 'data-url', 'svg'])
      await bench(output, () => encode(text, output, { ecc: 'medium' }));
  }

  section('decode');
  for (const { name, text, image } of syntheticImages())
    await bench(name, () => deepStrictEqual(decodeQR(image), text));
  if (buckets.length === 0) {
    console.log(SUBMODULE_HINT);
    return;
  }
  for (const { name, images } of buckets) await benchRotating(name, images, tryDecode);

  for (const { name, images } of buckets.filter((b) => b.name.startsWith('12MP')))
    await benchRotating(`${name}, max`, images, (img) =>
      tryDecode(img, { effort: Infinity, timeLimit: Infinity })
    );
}

await main();
