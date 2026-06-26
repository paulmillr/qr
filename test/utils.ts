import { decode as jpegDecode } from 'jpeg-js';
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, gunzipSync, inflateSync } from 'node:zlib';

export const _dirname = dirname(fileURLToPath(import.meta.url));

function readRel(path, opts) {
  return readFileSync(joinPath(_dirname, path), opts);
}

export function json(path) {
  try {
    // Node.js
    return JSON.parse(readRel(path, { encoding: 'utf-8' }));
  } catch (error) {
    // Bundler
    const file = path.replace(/^\.\//, '').replace(/\.json$/, '');
    if (path !== './' + file + '.json') throw new Error('Can not load non-json file');
    // return require('./' + file + '.json'); // in this form so that bundler can glob this
  }
}

export function jsonGZ(path) {
  return JSON.parse(gunzipSync(readRel(path)).toString('utf8'));
}

async function* jsonGZItemSources(path) {
  const stream = createReadStream(joinPath(_dirname, path)).pipe(createGunzip());
  stream.setEncoding('utf8');

  let buffer = '';
  let started = false;

  for await (const chunk of stream) {
    buffer += chunk;
    if (!started) {
      const start = buffer.indexOf('[');
      if (start === -1) {
        if (buffer.trim()) throw new Error('invalid JSON gzip array: missing "["');
        buffer = '';
        continue;
      }
      if (buffer.slice(0, start).trim()) throw new Error('invalid JSON gzip array: missing "["');
      buffer = buffer.slice(start + 1);
      started = true;
    }

    // Small vectors are generated as a flat JSON array of objects.
    while (true) {
      const boundary = buffer.indexOf('}, {');
      if (boundary === -1) break;
      const item = buffer.slice(0, boundary + 1).trim();
      if (item) yield item;
      buffer = buffer.slice(boundary + 3);
    }
  }

  if (!started) throw new Error('invalid JSON gzip array: missing "["');

  buffer = buffer.trim();
  if (buffer.endsWith(']')) buffer = buffer.slice(0, -1).trim();
  if (buffer) yield buffer;
}

export async function* jsonGZItems(path, { start = 0, step = 1 } = {}) {
  if (!Number.isSafeInteger(start) || start < 0)
    throw new Error(`invalid jsonGZItems start=${start}`);
  if (!Number.isSafeInteger(step) || step < 1) throw new Error(`invalid jsonGZItems step=${step}`);

  let index = 0;
  for await (const source of jsonGZItemSources(path)) {
    if (index >= start && (index - start) % step === 0) yield { index, value: JSON.parse(source) };
    index++;
  }
}

const vectorPath = joinPath(_dirname, 'vectors', 'boofcv-v3');
export const DETECTION_PATH = joinPath(vectorPath, 'detection');
export function readJPEG(path) {
  // console.log('readJPEG', vectorPath, path);
  return jpegDecode(readFileSync(joinPath(vectorPath, path)));
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paethPredictor(left, up, upperLeft) {
  const p = left + up - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upperLeft;
}

function unfilterPNG(data, width, height, rowBytes, bytesPerPixel) {
  const out = new Uint8Array(rowBytes * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[src++];
    const row = y * rowBytes;
    const prev = y === 0 ? -1 : row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[src++];
      const left = x >= bytesPerPixel ? out[row + x - bytesPerPixel] : 0;
      const up = prev < 0 ? 0 : out[prev + x];
      const upperLeft = prev < 0 || x < bytesPerPixel ? 0 : out[prev + x - bytesPerPixel];
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + ((left + up) >>> 1);
      else if (filter === 4) value = raw + paethPredictor(left, up, upperLeft);
      else throw new Error(`unsupported PNG filter=${filter}`);
      out[row + x] = value & 0xff;
    }
  }
  return out;
}

function readIndexedPNG(unfiltered, width, height, bitDepth, palette) {
  if (!palette) throw new Error('indexed PNG missing PLTE chunk');
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const mask = (1 << bitDepth) - 1;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const bitOffset = x * bitDepth;
      const packed = unfiltered[row + (bitOffset >>> 3)];
      const shift = 8 - bitDepth - (bitOffset & 7);
      const idx = (packed >>> shift) & mask;
      const src = idx * 3;
      const dst = (y * width + x) * 3;
      data[dst] = palette[src];
      data[dst + 1] = palette[src + 1];
      data[dst + 2] = palette[src + 2];
    }
  }
  return data;
}

export function readPNG(path) {
  const bytes = readFileSync(joinPath(vectorPath, path));
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error(`invalid PNG signature: ${path}`);
  }
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  let palette;
  const idat = [];
  for (let pos = PNG_SIGNATURE.length; pos < bytes.length; ) {
    const len = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + len;
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(start);
      height = bytes.readUInt32BE(start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0)
        throw new Error(`unsupported PNG compression/filter method: ${path}`);
      interlace = bytes[start + 12];
    } else if (type === 'PLTE') {
      palette = bytes.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    pos = end + 4;
  }
  if (
    width === undefined ||
    height === undefined ||
    bitDepth === undefined ||
    colorType === undefined
  )
    throw new Error(`PNG missing IHDR: ${path}`);
  if (interlace !== 0) throw new Error(`interlaced PNG is not supported: ${path}`);
  const inflated = inflateSync(Buffer.concat(idat));
  let rowBytes;
  let bytesPerPixel;
  if (colorType === 2 && bitDepth === 8) {
    rowBytes = width * 3;
    bytesPerPixel = 3;
  } else if (colorType === 6 && bitDepth === 8) {
    rowBytes = width * 4;
    bytesPerPixel = 4;
  } else if (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) {
    rowBytes = Math.ceil((width * bitDepth) / 8);
    bytesPerPixel = 1;
  } else {
    throw new Error(`unsupported PNG colorType=${colorType} bitDepth=${bitDepth}: ${path}`);
  }
  const unfiltered = unfilterPNG(inflated, width, height, rowBytes, bytesPerPixel);
  const data =
    colorType === 3 ? readIndexedPNG(unfiltered, width, height, bitDepth, palette) : unfiltered;
  return { width, height, data };
}

export function isDecodeImage(file) {
  return /\.(?:jpe?g|png)$/i.test(file);
}

export function readImage(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return readJPEG(path);
  if (lower.endsWith('.png')) return readPNG(path);
  throw new Error(`unsupported image vector: ${path}`);
}
