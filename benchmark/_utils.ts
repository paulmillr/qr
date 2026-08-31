import { bench } from '@paulmillr/jsbt/benchmark.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join as pjoin, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { encodeQR } from '../src/index.ts';
import { DETECTION_PATH, isDecodeImage, matrixToImage, readImage } from '../test/utils.ts';

export { DETECTION_PATH };

const _dirname = dirname(fileURLToPath(import.meta.url));

export async function loadDecoder() {
  const path = resolve(process.env.DECODER || pjoin(_dirname, '..', 'src', 'decode.ts'));
  const { default: decodeQR, _QRScanner } = await import(pathToFileURL(path).href);
  return { decodeQR, _QRScanner, path, isDefault: !process.env.DECODER };
}

export const section = (name: string) => console.log(`\n# ${name}`);

export const percent = (value: number, total: number) =>
  total === 0 ? 'n/a' : `${((100 * value) / total).toFixed(1)}%`;

export const listFiles = (path: string, isDir = false) =>
  readdirSync(path)
    .filter((i) => statSync(`${path}/${i}`).isDirectory() === isDir)
    .sort();

// Comma-separated env filter over a known value set (e.g. QR_QUALITY_CATEGORIES).
export const select = (envName: string, values: string[]) => {
  const raw = process.env[envName];
  if (!raw) return values;
  const selected = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const value of selected) {
    if (!values.includes(value)) throw new Error(`unknown ${envName} value=${value}`);
  }
  return selected;
};

// BoofCV vectors of one category with curated expectations attached.
export function vectorFiles(
  category: string,
  expected: Record<string, Record<string, string[]>>,
  exclude: string[]
) {
  return listFiles(pjoin(DETECTION_PATH, category))
    .filter(isDecodeImage)
    .filter((file) => !exclude.includes(`${category}/${file}`))
    .map((file) => ({
      category,
      file,
      path: `detection/${category}/${file}`,
      expected: expected[category]?.[file],
    }));
}

export const hasVectors = () => existsSync(DETECTION_PATH);
export const SUBMODULE_HINT = 'photo benchmarks skipped: run `git submodule update --init` first';

// Encode payloads shared by benchmark/index.ts and thirdparty/index.ts.
// `url` is the one byte-mode payload; the rest are alphanumeric.
export const TEXTS = {
  small: 'HELLO WORLD',
  url: 'https://github.com/paulmillr/qr',
  medium: 'H'.repeat(192),
  large: 'H'.repeat(768),
};

// QR alphanumeric-mode alphabet check, used to label encode payloads and to
// pick segment modes for third-party encoders.
export const isAlnum = (txt: string): boolean => /^[0-9A-Z $%*+\-./:]*$/.test(txt);

// Version of a TEXTS payload at the encode benchmarks' settings (medium ECC),
// derived from the matrix so row labels can't silently go stale.
export const encodeVersion = (text: string) =>
  (encodeQR(text, 'raw', { border: 4, ecc: 'medium' }).length - 8 - 17) / 4;

// Clean generated rasters, decode-asserted in index.ts and reused as-is by
// thirdparty; `text` is the expected payload. `raster v1` measures fixed
// pipeline overhead on the minimal symbol; `raster v18` the per-module costs
// (dense sampling, RS over many codewords). Versions in the labels are derived
// from the encoded matrix — the large symbol's version is emergent from
// TEXTS.large + medium ECC, so a hardcoded label could silently go stale.
export const syntheticImages = () => {
  const make = (text: string, scale: number, qrOpts: Record<string, any> = {}) => {
    const raw = encodeQR(text, 'raw', { border: 4, ecc: 'medium', ...qrOpts });
    const version = (raw.length - 8 - 17) / 4; // matrix width minus 2x4 border
    return { name: `raster v${version}`, text, image: matrixToImage(raw, scale) };
  };
  return [make(TEXTS.small, 4, { version: 1 }), make(TEXTS.large, 2)];
};

// `bench` times one call at a time; rotating through the bucket makes a per-op
// number a mean over photo variety instead of one image's quirks.
export function benchRotating<T>(label: string, images: T[], fn: (img: T) => unknown) {
  let i = 0;
  return bench(label, () => fn(images[i++ % images.length]));
}

// Deterministic shuffle (mulberry32) so "random order" is reproducible.
export function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const rnd = () => {
    let t = (s = (s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const SHUFFLE_SEED = 0x5eed;

// Shuffled readImage-ready paths for a bucket. The seed and the 'detection/'
// prefix live here and only here: every suite that times a bucket must decode
// the identical photos in the identical order or its rows stop being
// comparable to the main benchmark's.
export const bucketPaths = (bucket: PhotoBucket) =>
  shuffled(bucket.paths, SHUFFLE_SEED).map((p) => `detection/${p}`);

export type PhotoBucket = {
  name: string;
  expectOk: boolean;
  paths: string[];
  /**
   * Photos the shipped decoder is known NOT to read despite the bucket's
   * expectOk — kept in the set so historical cross-version rows stay
   * comparable. The drift check pins these exactly, so an improvement
   * (or further regression) still fails the run.
   */
  knownFailures?: string[];
};
export type LoadedBucket = PhotoBucket & { images: ReturnType<typeof readImage>[] };

// Worker body for readImages: decode an assigned slice of paths with
// test/utils' readImage and transfer each RGBA buffer back (zero-copy).
const READ_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.href).then(({ readImage }) => {
  for (const [index, path] of workerData.jobs) {
    const img = readImage(path);
    parentPort.postMessage({ index, img }, [img.data.buffer]);
  }
});
`;

export function readImages(paths: string[]): Promise<ReturnType<typeof readImage>[]> {
  const threads = Math.min(availableParallelism(), 16, paths.length);
  if (threads <= 1) return Promise.resolve(paths.map((p) => readImage(p)));
  const href = new URL('../test/utils.ts', import.meta.url).href;
  const out = new Array(paths.length);
  let pending = paths.length;
  return new Promise((resolve, reject) => {
    for (let w = 0; w < threads; w++) {
      const jobs: [number, string][] = [];
      for (let i = w; i < paths.length; i += threads) jobs.push([i, paths[i]]);
      const worker = new Worker(READ_WORKER, { eval: true, workerData: { href, jobs } });
      worker.on('message', ({ index, img }) => {
        out[index] = img;
        if (--pending === 0) resolve(out);
      });
      worker.on('error', reject);
      // No unref(): the worker handle must keep the event loop alive while the
      // await is pending; each worker exits on its own once its jobs are done.
    }
  });
}

// All six buckets JPEG-decoded up front (one flat readImages call so the
// worker pool balances 12MP and 720p jobs across every bucket at once).
export async function loadBuckets(): Promise<LoadedBucket[]> {
  const perBucket = PHOTOS.map(bucketPaths);
  const images = await readImages(perBucket.flat());
  let offset = 0;
  return PHOTOS.map((bucket, b) => {
    const slice = images.slice(offset, offset + perBucket[b].length);
    offset += perBucket[b].length;
    return { ...bucket, paths: perBucket[b], images: slice };
  });
}

// Photo workloads from the BoofCV detection dataset (test/vectors submodule):
// 20 different photos per bucket, curated 2026-08 as all-readable; the current
// decoder misses six of them (`knownFailures`), and
// the sets are kept intact so historical rows stay comparable.
// Expectations are
// verified before timing — a photo drifting out of its bucket fails the run.
export const PHOTOS: PhotoBucket[] = [
  {
    name: '720p ok',
    expectOk: true,
    paths: [
      'blurred/image007.jpg',
      'blurred/image011.jpg',
      'brightness/image028.jpg',
      'curved/image008.jpg',
      'curved/image033.jpg',
      'damaged/image003.jpg',
      'damaged/image004.jpg',
      'glare/image006.jpg',
      'glare/image029.jpg',
      'nominal/image029.jpg',
      'nominal/image036.jpg',
      'nominal/image037.jpg',
      'nominal/image039.jpg',
      'nominal/image045.jpg',
      'nominal/image052.jpg',
      'perspective/image017.jpg',
      'perspective/image018.jpg',
      'perspective/image019.jpg',
      'perspective/image021.jpg',
      'perspective/image022.jpg',
    ],
    knownFailures: ['perspective/image022.jpg'],
  },
  {
    name: '1080p ok',
    expectOk: true,
    paths: [
      'blurred/image012.jpg',
      'blurred/image034.jpg',
      'curved/image007.jpg',
      'damaged/image006.jpg',
      'damaged/image029.jpg',
      'glare/image008.jpg',
      'glare/image015.jpg',
      'glare/image022.jpg',
      'monitor/image002.jpg',
      'monitor/image015.jpg',
      'monitor/image016.jpg',
      'nominal/image025.jpg',
      'nominal/image046.jpg',
      'nominal/image048.jpg',
      'nominal/image049.jpg',
      'nominal/image054.jpg',
      'nominal/image058.jpg',
      'noncompliant/image001.jpg',
      'noncompliant/image002.jpg',
      'shadows/image012.jpg',
    ],
    knownFailures: ['damaged/image029.jpg', 'glare/image015.jpg', 'glare/image022.jpg'],
  },
  {
    name: '12MP ok',
    expectOk: true,
    paths: [
      'blurred/image006.jpg',
      'blurred/image023.jpg',
      'blurred/image032.jpg',
      'bright_spots/image003.jpg',
      'bright_spots/image027.jpg',
      'brightness/image004.jpg',
      'brightness/image007.jpg',
      'close/image003.jpg',
      'close/image007.jpg',
      'close/image012.jpg',
      'close/image015.jpg',
      'close/image018.jpg',
      'curved/image025.jpg',
      'curved/image040.jpg',
      'glare/image018.jpg',
      'monitor/image001.jpg',
      'monitor/image008.jpg',
      'nominal/image026.jpg',
      'nominal/image033.jpg',
      'shadows/image009.jpg',
    ],
    knownFailures: ['bright_spots/image027.jpg', 'close/image012.jpg'],
  },
];

// --- synthetic camera-frame helpers (multiframe.ts + latency.ts) ---

// Deterministic per-image RNG so runs are reproducible and comparable.
export const hashString = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
export const makeRng = (seed: number): (() => number) => {
  let state = seed || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
};

export type LumaPlane = { width: number; height: number; data: Uint8Array };

// Grayscale plane the decoder accepts directly ({ width, height, data: u8 }).
export function toLumaPlane(img: {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}): LumaPlane {
  const { width, height, data } = img;
  const px = width * height;
  if (data.length === px) return { width, height, data: new Uint8Array(data) };
  const bpp = data.length === 3 * px ? 3 : 4;
  const out = new Uint8Array(px);
  for (let i = 0, p = 0; i < px; i++, p += bpp) {
    // Same integer luma weights as the decoder's grayscale stage.
    out[i] = (306 * data[p] + 601 * data[p + 1] + 117 * data[p + 2] + 512) >> 10;
  }
  return { width, height, data: out };
}

// Per-frame Gaussian sensor-noise tile (Box-Muller). A 256x256 tile drawn
// fresh per frame keeps synthesis cheap while making per-module noise
// independent between frames, which is what decorrelates module votes.
export const NOISE_TILE = 256;
export function makeNoiseTile(rng: () => number, sigma: number): Int16Array {
  const tile = new Int16Array(NOISE_TILE * NOISE_TILE);
  for (let i = 0; i < tile.length; i += 2) {
    const u1 = rng() || 1e-9;
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1)) * sigma;
    tile[i] = Math.round(r * Math.cos(2 * Math.PI * u2));
    if (i + 1 < tile.length) tile[i + 1] = Math.round(r * Math.sin(2 * Math.PI * u2));
  }
  return tile;
}

// Rotate/scale/translate around the image center with bilinear sampling
// (white outside).
export function warpAffine(
  luma: LumaPlane,
  dx: number,
  dy: number,
  rot: number,
  scale: number
): LumaPlane {
  const { width, height, data } = luma;
  const cos = Math.cos(rot) / scale;
  const sin = Math.sin(rot) / scale;
  const cx = width / 2;
  const cy = height / 2;
  const out = new Uint8Array(width * height);
  const maxX = width - 1;
  const maxY = height - 1;
  for (let y = 0; y < height; y++) {
    const ry = y - cy - dy;
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const rx = x - cx - dx;
      const sx = cos * rx + sin * ry + cx;
      const sy = -sin * rx + cos * ry + cy;
      if (sx < 0 || sy < 0 || sx > maxX || sy > maxY) {
        out[rowBase + x] = 255;
        continue;
      }
      const x0 = sx >>> 0;
      const y0 = sy >>> 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const r0 = y0 * width;
      const r1 = y1 * width;
      out[rowBase + x] =
        (1 - fy) * ((1 - fx) * data[r0 + x0] + fx * data[r0 + x1]) +
        fy * ((1 - fx) * data[r1 + x0] + fx * data[r1 + x1]);
    }
  }
  return { width, height, data: out };
}

// Gamma LUT for exposure drift, in place.
export function applyGamma(out: Uint8Array, gamma: number): void {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, gamma));
  for (let i = 0; i < out.length; i++) out[i] = lut[out[i]];
}

// Additive specular blob with quadratic falloff, clipped at white — the
// washed-out region moves between frames like a real reflection.
export function applyGlare(
  luma: LumaPlane,
  glareX: number,
  glareY: number,
  glareR: number,
  glareLift: number
): void {
  const { width, height, data: out } = luma;
  const r2 = glareR * glareR;
  const yLo = Math.max(0, (glareY - glareR) | 0);
  const yHi = Math.min(height, (glareY + glareR + 1) | 0);
  const xLo = Math.max(0, (glareX - glareR) | 0);
  const xHi = Math.min(width, (glareX + glareR + 1) | 0);
  for (let y = yLo; y < yHi; y++) {
    const dy2 = (y - glareY) * (y - glareY);
    const row = y * width;
    for (let x = xLo; x < xHi; x++) {
      const d2 = dy2 + (x - glareX) * (x - glareX);
      if (d2 >= r2) continue;
      const v = out[row + x] + glareLift * (1 - d2 / r2);
      out[row + x] = v > 255 ? 255 : v;
    }
  }
}

// Separable radius-1 box blur (focus hunting), in place.
export function boxBlur1(luma: LumaPlane): void {
  const { width, height, data: out } = luma;
  const maxX = width - 1;
  const maxY = height - 1;
  const tmp = new Uint8Array(out.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    tmp[row] = out[row];
    for (let x = 1; x < maxX; x++)
      tmp[row + x] = (out[row + x - 1] + out[row + x] + out[row + x + 1] + 1) / 3;
    tmp[row + maxX] = out[row + maxX];
  }
  for (let x = 0; x < width; x++) {
    out[x] = tmp[x];
    for (let y = 1; y < maxY; y++)
      out[y * width + x] =
        (tmp[(y - 1) * width + x] + tmp[y * width + x] + tmp[(y + 1) * width + x] + 1) / 3;
    out[maxY * width + x] = tmp[maxY * width + x];
  }
}

// Per-frame sensor noise (noise last: it is not blurred by optics), in place.
export function applyNoise(luma: LumaPlane, tile: Int16Array): void {
  const { width, height, data: out } = luma;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const tRow = (y & (NOISE_TILE - 1)) * NOISE_TILE;
    for (let x = 0; x < width; x++) {
      const v = out[row + x] + tile[tRow + (x & (NOISE_TILE - 1))];
      out[row + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

// Handheld-jitter frame synthesis: affine warp, exposure drift, drifting
// glare, focus-hunting blur, sensor noise. Parameter draw ORDER is part of
// the contract — multiframe.ts results are keyed to this exact rng stream.
export function synthFrame(luma: LumaPlane, rng: () => number): LumaPlane {
  const { width, height } = luma;
  const dx = (rng() - 0.5) * 4; // +-2 px
  const dy = (rng() - 0.5) * 4;
  const rot = ((rng() - 0.5) * 3 * Math.PI) / 180; // +-1.5 deg
  const scale = 0.98 + rng() * 0.04; // 0.98..1.02
  const gamma = 0.8 + rng() * 0.45; // 0.8..1.25
  const glare = rng() < 0.4;
  const glareX = rng() * width;
  const glareY = rng() * height;
  const glareR = (0.12 + rng() * 0.15) * Math.min(width, height);
  const glareLift = 40 + rng() * 60;
  const blur = rng() < 0.33 ? 1 : 0;
  const sigma = 3 + rng() * 6;

  const out = warpAffine(luma, dx, dy, rot, scale);
  applyGamma(out.data, gamma);
  if (glare) applyGlare(out, glareX, glareY, glareR, glareLift);
  if (blur) boxBlur1(out);
  // Sensor noise last, independent per frame.
  applyNoise(out, makeNoiseTile(rng, sigma));
  return out;
}

