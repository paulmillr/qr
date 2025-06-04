import { decode as jpegDecode } from 'jpeg-js';
import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

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

const vectorPath = joinPath(_dirname, 'vectors', 'boofcv-v3');
export const DETECTION_PATH = joinPath(vectorPath, 'detection');
export function readJPEG(path) {
  // console.log('readJPEG', vectorPath, path);
  return jpegDecode(readFileSync(joinPath(vectorPath, path)));
}
