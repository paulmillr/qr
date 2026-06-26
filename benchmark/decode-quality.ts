import { readdirSync, statSync } from 'node:fs';
import { dirname, join as pjoin } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import decodeQR from '../src/decode.ts';
// Reuse the curated expectations from decode tests; should.runWhen keeps tests idle on import.
import { DECODED, DECODE_VECTOR_EXCLUDE } from '../test/decode.test.ts';
import { isDecodeImage, readImage } from '../test/utils.ts';

const _dirname = dirname(fileURLToPath(import.meta.url));
const DETECTION_PATH = pjoin(_dirname, '..', 'test', 'vectors', 'boofcv-v3', 'detection');

const listFiles = (path, isDir = false) =>
  readdirSync(path)
    .filter((i) => statSync(`${path}/${i}`).isDirectory() === isDir)
    .sort();

const percent = (value, total) => (total === 0 ? 'n/a' : `${((100 * value) / total).toFixed(1)}%`);
const millis = (value) => `${Math.round(value)}ms`;

const select = (envName, values) => {
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

function vectorFiles(category) {
  const dir = pjoin(DETECTION_PATH, category);
  return listFiles(dir)
    .filter(isDecodeImage)
    .filter((file) => !DECODE_VECTOR_EXCLUDE.includes(`${category}/${file}`))
    .map((file) => ({
      category,
      file,
      path: pjoin('detection', category, file),
      expected: DECODED[category]?.[file],
    }));
}

function runCategory(files) {
  const stats = {
    files: 0,
    expected: 0,
    matched: 0,
    wrong: 0,
    missed: 0,
    unknownDecoded: 0,
    errors: 0,
    ms: 0,
  };
  const started = performance.now();
  for (const vector of files) {
    stats.files++;
    if (vector.expected) stats.expected++;
    let decoded;
    try {
      decoded = decodeQR(readImage(vector.path), { moreEffort: true });
    } catch {
      stats.errors++;
    }
    if (vector.expected) {
      if (vector.expected.includes(decoded)) stats.matched++;
      else if (decoded === undefined) stats.missed++;
      else stats.wrong++;
    } else if (decoded !== undefined) {
      stats.unknownDecoded++;
    }
  }
  stats.ms = performance.now() - started;
  return stats;
}

function printRow(category, stats) {
  const msPerImage = stats.files === 0 ? 0 : stats.ms / stats.files;
  const quality = stats.matched + stats.unknownDecoded;
  console.log(`${category},${percent(quality, stats.files)},${millis(msPerImage)}`);
}

function main() {
  const categories = select('QR_QUALITY_CATEGORIES', listFiles(DETECTION_PATH, true));
  for (const category of categories) {
    const files = vectorFiles(category);
    if (files.length === 0) continue;
    printRow(category, runCategory(files));
  }
}

main();
