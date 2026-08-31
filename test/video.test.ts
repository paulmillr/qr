import { should } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { encodeQR } from '../src/index.ts';
import { VideoDecoder, encodeVideoFrames, encodeVideoQR } from '../src/video.ts';

const BLOCK_SIZE = 256;
const BASE_SEED = 0x243f6a88;
const FRAME_HEADER = 17;
const CRC_SIZE = 4;
const B64URL = /^[A-Za-z0-9_-]+$/;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function mulberry32(rng: { state: number }): number {
  let t = (rng.state = (rng.state + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  const rng = { state: (0x9e3779b9 ^ seed ^ length) >>> 0 };
  for (let i = 0; i < out.length; i++) {
    out[i] = mulberry32(rng) & 0xff;
  }
  return out;
}

function nextFrame(frames: Generator<string, void>): string {
  const frame = frames.next();
  if (frame.done) throw new Error('expected another video frame');
  return frame.value;
}

function takeFrames(frames: Generator<string, void>, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(nextFrame(frames));
  return out;
}

function base64urlDecode(frame: string): Uint8Array {
  return new Uint8Array(Buffer.from(frame, 'base64url'));
}

function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const rng = { state: seed >>> 0 };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor((mulberry32(rng) / 2 ** 32) * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function completeInOrder(
  data: Uint8Array,
  blockSize = BLOCK_SIZE,
  seed = BASE_SEED
): VideoDecoder {
  const decoder = new VideoDecoder();
  const frames = encodeVideoFrames(data, { blockSize, seed });
  const totalBlocks = Math.ceil(data.length / blockSize);
  const maxFrames = totalBlocks * 8 + 64;
  for (let i = 0; i < maxFrames && !decoder.progress.done; i++) {
    deepStrictEqual(decoder.feed(nextFrame(frames)), true);
  }
  deepStrictEqual(decoder.progress.done, true);
  deepStrictEqual(decoder.progress.totalBlocks, totalBlocks);
  deepStrictEqual(decoder.result(), data);
  return decoder;
}

function assertWireFrame(frame: string, dataLength: number, blockSize: number): void {
  deepStrictEqual(B64URL.test(frame), true);
  const raw = base64urlDecode(frame);
  deepStrictEqual(raw.length, FRAME_HEADER + blockSize + CRC_SIZE);
  deepStrictEqual(Array.from(raw.subarray(0, 3)), [0x51, 0x76, 1]);
  deepStrictEqual(readU32BE(raw, 7), dataLength);
  deepStrictEqual(readU16BE(raw, 11), blockSize);
  deepStrictEqual(crc32(raw.subarray(0, raw.length - CRC_SIZE)), readU32BE(raw, raw.length - 4));
}

should('video frames round-trip in order for several sizes', () => {
  for (const size of [1, BLOCK_SIZE - 1, BLOCK_SIZE, BLOCK_SIZE + 1, 10 * 1024, 100 * 1024]) {
    completeInOrder(bytes(size, size), BLOCK_SIZE, BASE_SEED);
  }
});

should('video frames use the specified base64url wire format', () => {
  const data = bytes(BLOCK_SIZE + 1, 11);
  const frame = nextFrame(encodeVideoFrames(data, { blockSize: BLOCK_SIZE, seed: BASE_SEED }));
  assertWireFrame(frame, data.length, BLOCK_SIZE);
});

should('video frames accept zero as a base seed', () => {
  completeInOrder(bytes(1024, 13), BLOCK_SIZE, 0);
});

should('video decoder completes with deterministic 30% random frame drop', () => {
  const data = bytes(10 * 1024, 2);
  const decoder = new VideoDecoder();
  const frames = encodeVideoFrames(data, { blockSize: BLOCK_SIZE, seed: BASE_SEED });
  const dropRng = { state: 0x5eed1234 };
  let generated = 0;
  for (; generated < 4096 && !decoder.progress.done; generated++) {
    const frame = nextFrame(frames);
    if (mulberry32(dropRng) / 2 ** 32 < 0.3) continue;
    deepStrictEqual(decoder.feed(frame), true);
  }
  deepStrictEqual(decoder.progress.done, true);
  deepStrictEqual(generated > decoder.progress.framesSeen, true);
  deepStrictEqual(decoder.result(), data);
});

should('video decoder completes with shuffled frame order', () => {
  const data = bytes(10 * 1024, 3);
  const totalBlocks = Math.ceil(data.length / BLOCK_SIZE);
  const frames = takeFrames(
    encodeVideoFrames(data, { blockSize: BLOCK_SIZE, seed: BASE_SEED }),
    totalBlocks * 8
  );
  const decoder = new VideoDecoder();
  for (const frame of shuffled(frames, 0x31415926)) decoder.feed(frame);
  deepStrictEqual(decoder.progress.done, true);
  deepStrictEqual(decoder.result(), data);
});

should('video decoder rejects duplicate frames without changing framesSeen', () => {
  const decoder = new VideoDecoder();
  const frame = nextFrame(
    encodeVideoFrames(bytes(1024, 4), { blockSize: BLOCK_SIZE, seed: BASE_SEED })
  );
  deepStrictEqual(decoder.progress, {
    decodedBlocks: 0,
    totalBlocks: 0,
    framesSeen: 0,
    done: false,
  });
  deepStrictEqual(decoder.feed(frame), true);
  const framesSeen = decoder.progress.framesSeen;
  deepStrictEqual(decoder.feed(frame), false);
  deepStrictEqual(decoder.progress.framesSeen, framesSeen);
});

should('video decoder rejects corrupt and malformed frames without throwing', () => {
  const frame = nextFrame(
    encodeVideoFrames(bytes(1024, 5), { blockSize: BLOCK_SIZE, seed: BASE_SEED })
  );
  const raw = base64urlDecode(frame);
  raw[Math.floor(raw.length / 2)] ^= 1;

  const decoder = new VideoDecoder();
  deepStrictEqual(decoder.feed(base64urlEncode(raw)), false);
  deepStrictEqual(decoder.feed(frame.slice(0, 8) + '*' + frame.slice(9)), false);
  deepStrictEqual(decoder.feed(frame.slice(0, -1)), false);
  deepStrictEqual(decoder.feed(''), false);
  deepStrictEqual(decoder.progress.framesSeen, 0);
});

should('video decoder rejects frames from other sessions after lock', () => {
  const decoder = new VideoDecoder();
  const first = nextFrame(
    encodeVideoFrames(bytes(1024, 6), { blockSize: BLOCK_SIZE, seed: BASE_SEED })
  );
  const other = nextFrame(
    encodeVideoFrames(bytes(1024, 7), { blockSize: BLOCK_SIZE, seed: BASE_SEED })
  );
  deepStrictEqual(decoder.feed(first), true);
  const framesSeen = decoder.progress.framesSeen;
  deepStrictEqual(decoder.feed(other), false);
  deepStrictEqual(decoder.progress.framesSeen, framesSeen);
});

should('VideoDecoder never returns data that fails its session checksum', () => {
  const a = Uint8Array.from([
    134, 132, 106, 61, 51, 254, 41, 101, 164, 168, 64, 165, 223, 127, 175, 4, 102, 136, 137, 58,
    161, 44, 223, 149, 253, 155, 126, 137, 13, 210, 108, 104,
  ]);
  const b = Uint8Array.from([
    251, 182, 157, 64, 205, 148, 99, 35, 113, 51, 187, 227, 171, 110, 105, 63, 132, 124, 236, 231,
    8, 166, 241, 80, 208, 79, 56, 243, 196, 18, 191, 148,
  ]);
  deepStrictEqual(crc32(a), crc32(b));
  const framesA = encodeVideoFrames(a, { blockSize: 16, seed: 1 });
  const framesB = encodeVideoFrames(b, { blockSize: 16, seed: 2 });
  const decoder = new VideoDecoder();
  // Pin frame generation so a broken generator cannot pass vacuously. B's
  // frame is deliberately admissible: the engineered crc32 collision makes
  // both sessions look identical, which is the mixing attack under test.
  deepStrictEqual(decoder.feed(nextFrame(framesA)), true);
  decoder.feed(nextFrame(framesB));
  try {
    deepStrictEqual(crc32(decoder.result()), crc32(a));
  } catch (error) {
    if (!decoder.progress.done) return;
    throw error;
  }
});

should('video frame generation is deterministic for the same data and seed', () => {
  const data = bytes(2048, 8);
  const opts = { blockSize: BLOCK_SIZE, seed: BASE_SEED };
  deepStrictEqual(
    takeFrames(encodeVideoFrames(data, opts), 24),
    takeFrames(encodeVideoFrames(data, opts), 24)
  );
});

should('video decoder efficiency stays within the loose fountain overhead bound', () => {
  const data = bytes(100 * 1024, 9);
  const totalBlocks = Math.ceil(data.length / BLOCK_SIZE);
  const decoder = completeInOrder(data, BLOCK_SIZE, BASE_SEED);
  // Seed 0x243f6a88 was rechecked under mulberry32:
  // K=400 completes after 482 frames, comfortably below the K*1.4 limit of 560.
  deepStrictEqual(decoder.progress.framesSeen <= Math.floor(totalBlocks * 1.4), true);
});

should('video decoder result throws before done and returns exact bytes after', () => {
  const decoder = new VideoDecoder();
  throws(() => decoder.result());
  const data = bytes(BLOCK_SIZE + 17, 10);
  const done = completeInOrder(data, BLOCK_SIZE, BASE_SEED);
  deepStrictEqual(done.result(), data);
});

should('encodeVideoQR wraps the same seeded frame payloads as encodeVideoFrames', () => {
  const data = bytes(512, 12);
  const opts = { blockSize: 64, seed: BASE_SEED, border: 2 };
  const frame = nextFrame(encodeVideoFrames(data, opts));
  const qr = encodeVideoQR(data, 'ascii', opts).next().value;
  deepStrictEqual(typeof qr, 'string');
  deepStrictEqual(qr, encodeQR(frame, 'ascii', { ecc: 'low', border: opts.border }));
});

should('encodeVideoQR renders at the maximum block size and rejects past it', () => {
  const data = Uint8Array.of(1);
  const opts = { blockSize: 2193, seed: 0 };
  const frame = nextFrame(encodeVideoFrames(data, opts));
  deepStrictEqual(
    encodeVideoQR(data, 'raw', opts).next().value,
    encodeQR(frame, 'raw', { ecc: 'low' })
  );
  throws(
    () => nextFrame(encodeVideoFrames(data, { blockSize: 2194, seed: 0 })),
    new TypeError('"opts.blockSize" expected integer [16..2193], got 2194')
  );
});

should('encodeVideoFrames rejects null blockSize instead of selecting the default', () => {
  throws(
    () => nextFrame(encodeVideoFrames(Uint8Array.of(1), { blockSize: null as never, seed: 0 })),
    new TypeError('"opts.blockSize" expected integer [16..2193], got null')
  );
});

should('encodeVideoQR rejects null ecc instead of selecting the default', () => {
  throws(
    () =>
      encodeVideoQR(Uint8Array.of(1), 'raw', {
        blockSize: 16,
        seed: 0,
        ecc: null as never,
      }).next().value,
    new Error('invalid ecc=null')
  );
});

should('the video public module is shipped and exported by the package', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const jsr = JSON.parse(readFileSync(new URL('../jsr.json', import.meta.url), 'utf8'));
  deepStrictEqual(
    {
      npmFile: pkg.files.includes('video.js'),
      npmExport: pkg.exports['./video.js'],
      jsrExport: jsr.exports['./video.js'],
    },
    {
      npmFile: true,
      npmExport: './video.js',
      jsrExport: './src/video.ts',
    }
  );
});

should('encodeVideoFrames accepts Uint8Array values from another realm', () => {
  const opts = { blockSize: 16, seed: 0 };
  const local = Uint8Array.of(1, 2, 3);
  const foreign = runInNewContext('Uint8Array.of(1, 2, 3)') as Uint8Array;
  deepStrictEqual(
    nextFrame(encodeVideoFrames(foreign, opts)),
    nextFrame(encodeVideoFrames(local, opts))
  );
});

should.runWhen(import.meta.url);
