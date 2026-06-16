import { decode as jpegDecode } from 'jpeg-js';
import { createReadStream, readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, gunzipSync } from 'node:zlib';

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
    if (index >= start && (index - start) % step === 0)
      yield { index, value: JSON.parse(source) };
    index++;
  }
}

const vectorPath = joinPath(_dirname, 'vectors', 'boofcv-v3');
export const DETECTION_PATH = joinPath(vectorPath, 'detection');
export function readJPEG(path) {
  // console.log('readJPEG', vectorPath, path);
  return jpegDecode(readFileSync(joinPath(vectorPath, path)));
}
