import { it } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import decodeQR, { _QRScanner, decodeQRBatch } from '../src/decode.ts';
import { encodeQR } from '../src/index.ts';
import { matrixToImage, readImage } from './utils.ts';

const image = (text: string, scale: number) =>
  matrixToImage(encodeQR(text, 'raw', { border: 4 }), scale);

const pad = (image: ReturnType<typeof matrixToImage>, width: number) => {
  const data = new Uint8Array(width * image.height * 4).fill(255);
  const offset = (width - image.width) >> 1;
  for (let y = 0; y < image.height; y++)
    data.set(
      image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      (y * width + offset) * 4
    );
  return { data, height: image.height, width };
};

it(
  'decodeQRBatch asynchronously returns complete positional results across mixed sizes',
  async () => {
    const images = [
      pad(image('BATCH SMALL', 4), 180),
      pad(image('BATCH MEDIUM', 7), 260),
      pad(image('BATCH LARGE', 11), 420),
    ];
    let detected = 0;
    const opts = { maxSize: { width: 512, height: 512 }, pointsOnDetect: () => detected++ };
    deepStrictEqual(
      (await decodeQRBatch(images, opts)).map((results) =>
        results.map((result) => (result instanceof Error ? result.message : result))
      ),
      images.map((value) => [decodeQR(value), 'finder'])
    );
    deepStrictEqual(detected, images.length);
    deepStrictEqual(
      (await decodeQRBatch([images[0]])).map((results) =>
        results.map((result) => (result instanceof Error ? result.message : result))
      ),
      [[decodeQR(images[0]), 'finder']]
    );
    deepStrictEqual(await decodeQRBatch([]), []);
  }
);

it(
  'pointsOnDetect reports one terminal success or failure rather than projection attempts',
  () => {
    const raw = encodeQR('A', 'raw', { version: 1, ecc: 'low', mask: 0, border: 4 });
    const good = matrixToImage(raw, 4);
    const failedRaw = raw.map((row) => row.slice());
    for (let y = 12; y < 16; y++) for (let x = 12; x < 16; x++) failedRaw[y][x] = !failedRaw[y][x];
    const failed = matrixToImage(failedRaw, 4);
    const blank = { ...good, data: new Uint8Array(good.data.length).fill(255) };
    const events: Array<[unknown, unknown]> = [];
    const pointsOnDetect = (points: unknown, result?: string | Error) =>
      events.push([points, result]);
    const failures: string[] = [];
    for (const input of [failed, blank]) {
      try {
        decodeQR(input, { pointsOnDetect });
      } catch (error) {
        if (error instanceof Error) failures.push(error.message);
      }
    }
    deepStrictEqual(
      {
        decoded: decodeQR(good, { pointsOnDetect }),
        failures,
        events: events.map(([, result]) =>
          result instanceof Error ? { error: result.message } : { result }
        ),
      },
      {
        decoded: 'A',
        failures: ['timing', 'finder'],
        events: [{ error: 'timing' }, { result: 'A' }],
      }
    );
  }
);

it('decodeQRBatch returns positional result arrays and continues after misses', async () => {
  const first = image('BATCH FIRST', 4);
  const last = image('BATCH LAST', 5);
  const blank = {
    data: new Uint8Array(first.width * first.height * 4).fill(255),
    height: first.height,
    width: first.width,
  };
  const results = await decodeQRBatch([first, blank, last], {
    maxSize: { width: 256, height: 256 },
  });
  deepStrictEqual(
    results.map((values) =>
      values.map((result) =>
        result instanceof Error ? { name: result.name, message: result.message } : result
      )
    ),
    [
      ['BATCH FIRST', { name: 'Error', message: 'finder' }],
      [{ name: 'Error', message: 'finder' }],
      ['BATCH LAST', { name: 'Error', message: 'finder' }],
    ]
  );
});

it('_QRScanner stages native luma and freezes constructor-bound options', () => {
  const callback = () => {};
  const opts = {
    maxSize: { width: 512, height: 512 },
    pointsOnDetect: callback,
  };
  const scanner = new _QRScanner(opts);
  opts.maxSize.width = 1;
  deepStrictEqual(
    {
      frozen: Object.isFrozen(scanner.opts),
      frozenSize: Object.isFrozen(scanner.opts.maxSize),
      callback: scanner.opts.pointsOnDetect === callback,
      maxWidth: scanner.opts.maxSize.width,
    },
    { frozen: true, frozenSize: true, callback: true, maxWidth: 512 }
  );
  throws(() => scanner.decode(), /expected addImage before decode/);
  const source = image('STAGED NATIVE', 4);
  const wide = pad(source, 180);
  scanner.addImage(wide);
  deepStrictEqual(
    {
      result: scanner.decode(),
      size: { height: scanner.height, width: scanner.width },
      layer: {
        height: scanner.layers[0].height,
        luma: scanner.layers[0].luma === scanner.luma,
        used: scanner.layers[0].used,
        width: scanner.layers[0].width,
      },
    },
    {
      result: ['STAGED NATIVE'],
      size: { height: wide.height, width: wide.width },
      layer: { height: wide.height, luma: true, used: true, width: wide.width },
    }
  );
});

it('_QRScanner decodes every QR without rediscovering one across pyramid layers', async () => {
  // Equal payloads are still separate physical symbols and must not be deduplicated.
  const texts = ['MULTI ONE', 'MULTI TWO', 'MULTI ONE'];
  const symbols = texts.map((text) => image(text, 4));
  const gap = 32;
  const width =
    symbols.reduce((sum, symbol) => sum + symbol.width, 0) + gap * (symbols.length - 1);
  const height = symbols[0].height;
  const data = new Uint8Array(width * height * 4).fill(255);
  let offset = 0;
  for (const symbol of symbols) {
    for (let y = 0; y < height; y++)
      data.set(
        symbol.data.subarray(y * symbol.width * 4, (y + 1) * symbol.width * 4),
        (y * width + offset) * 4
      );
    offset += symbol.width + gap;
  }
  const combined = { data, height, width };
  const scanner = new _QRScanner({ maxSize: { height, width } });
  scanner.addImage(combined);
  deepStrictEqual(
    scanner.decode(true).map((result) => (result instanceof Error ? result.message : result)),
    [...texts, 'finder']
  );
  scanner.addImage(combined);
  deepStrictEqual([scanner.decode()[0], scanner.decode()[0], scanner.decode()[0]], texts);
  const exhausted = scanner.decode()[0];
  deepStrictEqual(exhausted instanceof Error ? exhausted.message : exhausted, 'finder');

  // A new staged image must reset the exclusion state retained for repeated
  // decode calls on the previously staged image.
  scanner.addImage(symbols[0]);
  deepStrictEqual(
    scanner.decode(true).map((result) => (result instanceof Error ? result.message : result)),
    [texts[0], 'finder']
  );
  deepStrictEqual(decodeQR(combined), texts[0]);
  deepStrictEqual(decodeQR(combined, { all: true } as never), texts[0]);
  deepStrictEqual(
    (await decodeQRBatch([combined], { maxSize: { height, width } })).map((result) =>
      result.map((value) => (value instanceof Error ? value.message : value))
    ),
    [[...texts, 'finder']]
  );
  deepStrictEqual(
    (await decodeQRBatch([{ data: new Uint8Array(data.length).fill(255), height, width }])).map(
      (result) => result.map((value) => (value instanceof Error ? value.message : value))
    ),
    [['finder']]
  );
});

it('effort retries another scheduled hypothesis within its time budget', () => {
  const input = readImage('detection/curved/image022.jpg');
  throws(() => decodeQR(input));
  deepStrictEqual(decodeQR(input, { effort: Infinity, timeLimit: Infinity }), 'Test 03');
  deepStrictEqual(
    decodeQR(image('EFFORT MANDATORY', 4), { effort: Infinity, timeLimit: 0 }),
    'EFFORT MANDATORY'
  );
});

it('_QRScanner retains rectangular arenas and updates only active layer state', () => {
  const scanner = new _QRScanner({ maxSize: { width: 512, height: 512 } });
  // Luma lengths are the arena contract, so a separate capacity property would be redundant.
  deepStrictEqual(
    scanner.layers.map(({ luma }) => luma.length),
    [512 * 512, 256 * 256, 128 * 128, 64 * 64]
  );
  const buffers = scanner.layers.map(({ bitmap, blocks, cuts, luma, patterns }) => ({
    bitmap,
    blocks,
    cuts,
    luma,
    patterns,
  }));
  const small = image('ACTIVE SMALL', 4);
  scanner.addImage(small);
  deepStrictEqual(
    scanner.layers.map(({ height, used, width }) => ({ height, used, width })),
    [
      { height: small.height, used: true, width: small.width },
      { height: 0, used: false, width: 0 },
      { height: 0, used: false, width: 0 },
      { height: 0, used: false, width: 0 },
    ]
  );
  const large = image('ACTIVE LARGE', 16);
  scanner.addImage(large);
  deepStrictEqual(
    {
      result: scanner.decode(),
      lowerLumaCleared: scanner.layers
        .slice(1)
        .map(({ luma }) => luma.every((value) => value === 0)),
      layers: scanner.layers.map(({ height, used, width }) => ({ height, used, width })),
      reused: scanner.layers.map(({ bitmap, blocks, cuts, luma, patterns }, at) => ({
        bitmap: bitmap === buffers[at].bitmap,
        blocks: blocks === buffers[at].blocks,
        cuts: cuts === buffers[at].cuts,
        luma: luma === buffers[at].luma,
        patterns: patterns === buffers[at].patterns,
      })),
    },
    {
      result: ['ACTIVE LARGE'],
      // Decoding populates the two active pyramid layers and leaves only the unused tail clear.
      lowerLumaCleared: [false, false, true],
      layers: [
        { height: large.height, used: true, width: large.width },
        { height: large.height >> 1, used: true, width: large.width >> 1 },
        { height: large.height >> 2, used: true, width: large.width >> 2 },
        { height: 0, used: false, width: 0 },
      ],
      reused: Array.from({ length: 4 }, () => ({
        bitmap: true,
        blocks: true,
        cuts: true,
        luma: true,
        patterns: true,
      })),
    }
  );
});

it('_QRScanner sizes every pyramid arena from its rectangular layer dimensions', () => {
  const scanner = new _QRScanner({ maxSize: { width: 512, height: 256 } });
  deepStrictEqual(
    scanner.layers.map(({ bitmap, blocks, cuts, luma, patterns }) => ({
      bitmap: bitmap.length,
      blocks: blocks.length,
      cuts: cuts.length,
      luma: luma.length,
      patterns: patterns.length,
    })),
    [
      { bitmap: 16 * 256, blocks: 64 * 32, cuts: 64 * 32, luma: 512 * 256, patterns: 74 * 37 * 4 },
      { bitmap: 8 * 128, blocks: 32 * 16, cuts: 32 * 16, luma: 256 * 128, patterns: 37 * 19 * 4 },
      { bitmap: 4 * 64, blocks: 16 * 8, cuts: 16 * 8, luma: 128 * 64, patterns: 19 * 10 * 4 },
    ]
  );
  const skinny = new _QRScanner({ maxSize: { width: 4096, height: 1 } });
  deepStrictEqual(
    skinny.layers.map(({ bitmap, blocks, cuts, luma, patterns }) => ({
      bitmap: bitmap.length,
      blocks: blocks.length,
      cuts: cuts.length,
      luma: luma.length,
      patterns: patterns.length,
    })),
    [{ bitmap: 128, blocks: 512, cuts: 512, luma: 4096, patterns: 586 * 4 }]
  );
});

it('_QRScanner reuses phase-disjoint scratch arenas by element width', () => {
  const scanner = new _QRScanner({ maxSize: { width: 512, height: 512 } });
  const state = scanner as unknown as Record<string, unknown>;
  const buffer = (name: string) => (state[name] as ArrayBufferView).buffer;
  const codewords = buffer('codewords');
  const tmp8 = buffer('tmp8');
  const maps = ['map', 'from', 'to'].map(buffer);
  // Only disjointness matters: scratch planes for different phases must not
  // alias, so one phase cannot corrupt another's live data. Sizes are tuning.
  deepStrictEqual(
    {
      widthScratch: {
        tmp32: buffer('tmp32') !== codewords && buffer('tmp32') !== tmp8,
        tmp64: buffer('tmp64') !== codewords && buffer('tmp64') !== tmp8,
      },
      mapsRemainLive:
        new Set(maps).size === maps.length &&
        maps.every(
          (value) =>
            ![codewords, tmp8, buffer('tmp32'), buffer('tmp64')].includes(value as ArrayBuffer)
        ),
    },
    {
      widthScratch: { tmp32: true, tmp64: true },
      mapsRemainLive: true,
    }
  );
});

it('_QRScanner addImage validates before mutation and clean wipes every arena', () => {
  throws(() => new _QRScanner({ maxSize: { width: 64, height: 64.5 } }), TypeError);
  throws(() => new _QRScanner({ maxSize: { width: 64, height: 0 } }), /positive/);
  throws(() => new _QRScanner({ maxSize: { width: 4097, height: 1 } }), /<= 4096/);
  throws(
    () => new _QRScanner({ maxSize: { width: 4096, height: 4096 }, stride: 5 }),
    /arena expected <= 67108864 bytes/
  );
  throws(
    () => decodeQR({ data: new Uint8Array(), width: 4096, height: 0 }),
    /positive width and height/
  );
  throws(() => decodeQR({ data: new Uint8Array(4097 * 3), width: 4097, height: 1 }), /<= 4096/);
  const scanner = new _QRScanner({ maxSize: { width: 128, height: 128 } });
  const valid = image('TRANSACTIONAL', 4);
  scanner.addImage(valid);
  const active = scanner.layers.map(({ height, used, width }) => ({ height, used, width }));
  throws(
    () => scanner.addImage({ data: new Uint8Array(256 * 64), width: 256, height: 64 }, 'I420'),
    /expected dimensions <= 128x128/
  );
  scanner.addImage(valid);
  throws(
    () => scanner.addImage({ data: new Uint8Array(129 * 128), width: 129, height: 128 }, 'I420'),
    RangeError
  );
  throws(
    () => scanner.addImage({ data: new Uint8Array(128 * 129), width: 128, height: 129 }, 'I420'),
    RangeError
  );
  deepStrictEqual(
    {
      active: scanner.layers.map(({ height, used, width }) => ({ height, used, width })),
      result: scanner.decode(),
    },
    { active, result: ['TRANSACTIONAL'] }
  );
  scanner.clean();
  deepStrictEqual(
    scanner.layers.map(({ bitmap, blocks, cuts, luma, patterns }) => ({
      bitmap: bitmap.every((value) => value === 0),
      blocks: blocks.every((value) => value === 0),
      cuts: cuts.every((value) => value === 0),
      luma: luma.every((value) => value === 0),
      patterns: patterns.every((value) => value === 0),
    })),
    scanner.layers.map(() => ({
      bitmap: true,
      blocks: true,
      cuts: true,
      luma: true,
      patterns: true,
    }))
  );
});

it('_QRScanner addImage converts byte formats without replacing arenas', () => {
  const scanner = new _QRScanner({ maxSize: { width: 64, height: 64 } });
  const luma = scanner.luma;
  const size = { width: 2, height: 1 };
  const rgb = Uint8Array.of(4, 8, 12, 20, 24, 28);
  const rgba = Uint8ClampedArray.of(4, 8, 12, 99, 20, 24, 28, 77);
  const actual: Array<{ format: string; luma: Uint8Array }> = [];
  for (const format of ['RGB'] as const) {
    scanner.addImage({ ...size, data: rgb }, format);
    actual.push({ format, luma: scanner.luma.slice(0, 2) });
  }
  // The luma weight (r + 2g + b) >> 2 is symmetric in r/b, so BGRA/BGRX can
  // never diverge from RGBA/RGBX here — these cases only cover the format
  // branch and its 4-byte stride, not channel order.
  for (const format of ['RGBA', 'RGBX', 'BGRA', 'BGRX'] as const) {
    scanner.addImage({ ...size, data: rgba }, format);
    actual.push({ format, luma: scanner.luma.slice(0, 2) });
  }
  for (const format of ['I420', 'I420A', 'I422', 'I444', 'NV12'] as const) {
    scanner.addImage({ ...size, data: Uint8Array.of(8, 24) }, format);
    actual.push({ format, luma: scanner.luma.slice(0, 2) });
  }
  scanner.addImage({ ...size, data: Uint8Array.of(0, 2, 0, 3) }, 'I420P10');
  actual.push({ format: 'I420P10', luma: scanner.luma.slice(0, 2) });
  scanner.addImage({ ...size, data: Uint8Array.of(0, 8, 0, 12) }, 'I420P12');
  actual.push({ format: 'I420P12', luma: scanner.luma.slice(0, 2) });
  deepStrictEqual(
    { actual, reused: scanner.luma === luma },
    {
      actual: [
        { format: 'RGB', luma: Uint8Array.of(8, 24) },
        { format: 'RGBA', luma: Uint8Array.of(8, 24) },
        { format: 'RGBX', luma: Uint8Array.of(8, 24) },
        { format: 'BGRA', luma: Uint8Array.of(8, 24) },
        { format: 'BGRX', luma: Uint8Array.of(8, 24) },
        { format: 'I420', luma: Uint8Array.of(8, 24) },
        { format: 'I420A', luma: Uint8Array.of(8, 24) },
        { format: 'I422', luma: Uint8Array.of(8, 24) },
        { format: 'I444', luma: Uint8Array.of(8, 24) },
        { format: 'NV12', luma: Uint8Array.of(8, 24) },
        { format: 'I420P10', luma: Uint8Array.of(128, 192) },
        { format: 'I420P12', luma: Uint8Array.of(128, 192) },
      ],
      reused: true,
    }
  );
});
