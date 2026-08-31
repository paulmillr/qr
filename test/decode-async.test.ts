import { deepStrictEqual, rejects, throws } from 'node:assert';
import { it } from '@paulmillr/jsbt/test.js';
import { _QRScanner, type DecodeResult } from '../src/decode.ts';
import { encodeQR } from '../src/index.ts';
import { matrixToImage } from './utils.ts';

const normalize = (result: DecodeResult): string =>
  result instanceof Error ? `Error: ${result.message}` : result;
const image = matrixToImage(encodeQR('COOPERATIVE ASYNC', 'raw', { border: 4 }), 8);
const blank = { data: new Uint8Array(512 * 512), height: 512, width: 512 };
const scanner = (input = image, timeLimit = Infinity) =>
  new _QRScanner({ effort: Infinity, maxSize: input, timeLimit });

it('sync and async scanner consumers return the same single and all results', async () => {
  const sync = scanner();
  const async = scanner(image, 0);
  sync.addImage(image);
  const single = sync.decode().map(normalize);
  async.addImage(image);
  const singleAsync = (await async.decodeAsync()).map(normalize);
  sync.addImage(image);
  const all = sync.decode(true).map(normalize);
  async.addImage(image);
  const allAsync = (await async.decodeAsync(true)).map(normalize);
  sync.clean();
  async.clean();
  // Anchor the payload literally so an identical regression in both paths
  // cannot make the differential comparison pass vacuously.
  deepStrictEqual(single, ['COOPERATIVE ASYNC']);
  deepStrictEqual({ all: allAsync, single: singleAsync }, { all, single });
});

it('a rejected scheduler yield stops async work and leaves the scanner reusable', async () => {
  const host = globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } };
  const saved = host.scheduler;
  const reason = new Error('cancelled scheduled decode');
  host.scheduler = { yield: () => Promise.reject(reason) };
  const scannerAsync = scanner(blank, 0);
  scannerAsync.addImage(blank, 'I420');
  try {
    await rejects(scannerAsync.decodeAsync(true), reason);
  } finally {
    host.scheduler = saved;
  }
  scannerAsync.addImage(image);
  const reused = normalize(scannerAsync.decode()[0]);
  scannerAsync.clean();
  deepStrictEqual(reused, 'COOPERATIVE ASYNC');
});

it('an async scan locks shared arenas until it settles', async () => {
  const host = globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } };
  const saved = host.scheduler;
  let held = true;
  let release = () => {};
  host.scheduler = {
    yield: () =>
      held
        ? new Promise<void>((resolve) => {
            release = () => {
              held = false;
              resolve();
            };
          })
        : Promise.resolve(),
  };
  const scannerAsync = scanner(image, 0);
  const tenantB = {
    data: new Uint8Array(image.width * image.height),
    height: image.height,
    width: image.width,
  };
  scannerAsync.addImage(image);
  const pending = scannerAsync.decodeAsync();
  try {
    throws(() => scannerAsync.addImage(tenantB, 'I420'), /operation already in flight/);
    throws(
      () => scannerAsync.processImage(tenantB, 'I420'),
      /operation already in flight/
    );
    throws(() => scannerAsync.decode(), /operation already in flight/);
    throws(() => scannerAsync.clean(), /operation already in flight/);
    await rejects(scannerAsync.decodeAsync(), /operation already in flight/);
    // A rejected contender must not release the operation that owns the arenas.
    throws(() => scannerAsync.addImage(tenantB, 'I420'), /operation already in flight/);
    release();
    deepStrictEqual((await pending).map(normalize), ['COOPERATIVE ASYNC']);
    scannerAsync.addImage(tenantB, 'I420');
    deepStrictEqual(scannerAsync.decode().map(normalize), ['Error: finder']);
  } finally {
    release();
    await pending.catch(() => {});
    host.scheduler = saved;
    scannerAsync.clean();
  }
});

it('a long scan exposes fine-grained cooperative work units', async () => {
  const host = globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } };
  const saved = host.scheduler;
  let yields = 0;
  host.scheduler = { yield: async () => void yields++ };
  const scannerAsync = scanner(blank, 0);
  scannerAsync.addImage(blank, 'I420');
  let result: DecodeResult[];
  try {
    result = await scannerAsync.decodeAsync();
  } finally {
    host.scheduler = saved;
    scannerAsync.clean();
  }
  deepStrictEqual(
    { cooperative: yields > 1, result: result.map(normalize) },
    { cooperative: true, result: ['Error: finder'] }
  );
});
