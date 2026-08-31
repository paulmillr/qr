// BoofCV detection-dataset accuracy. Single pass ending with a summary row:
// category,quality%,ms/img.
//
// env:
//   DECODER               path of the decodeQR module to bench (default
//                         ../src/decode.ts; e.g. thirdparty/node_modules/qr-0.6.0/decode.js)
//   QR_QUALITY_CATEGORIES comma-separated category filter
//   QR_EFFORT             'max' runs the still-image tier (effort: Infinity,
//                         timeLimit: Infinity); unset uses library defaults.
//                         Decoders without those options ignore them.
//   JSBT_FAST             parallel workers, jsbt semantics (8, 0.5 = half the
//                         cores, -2 = cores minus two). Unset = sequential —
//                         per-image ms is only trustworthy without parallel
//                         contention; use workers when only accuracy matters.
import cluster from 'node:cluster';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
// Reuse the curated expectations from decode tests; should.runWhen keeps tests idle on import.
import { DECODED, DECODE_VECTOR_EXCLUDE } from '../test/decode.test.ts';
import { normalizeWorkerCount, readImage } from '../test/utils.ts';
import { DETECTION_PATH, listFiles, loadDecoder, percent, select, vectorFiles } from './_utils.ts';

const { decodeQR, path: decoderPath, isDefault } = await loadDecoder();

const WORKERS = normalizeWorkerCount(
  Number.parseFloat(process.env.JSBT_FAST || '0'),
  cpus().length
);

const EFFORT_MAX = process.env.QR_EFFORT === 'max';

const millis = (value) => `${Math.round(value)}ms`;

const newStats = () => ({
  files: 0,
  expected: 0,
  matched: 0,
  wrong: 0,
  missed: 0,
  unknownDecoded: 0,
  errors: 0,
  ms: 0,
});

// Decode a list of vectors (possibly spanning categories), stats per category.
function runVectors(vectors) {
  const byCategory = {};
  for (const vector of vectors) {
    const stats = byCategory[vector.category] ?? (byCategory[vector.category] = newStats());
    stats.files++;
    if (vector.expected) stats.expected++;
    let decoded;
    // Read + JPEG-decode into a buffer before the timer: ms/img measures the
    // QR decoder only, not file I/O.
    const image = readImage(vector.path);
    const started = performance.now();
    try {
      decoded = decodeQR(image, EFFORT_MAX ? { effort: Infinity, timeLimit: Infinity } : {});
    } catch {
      stats.errors++;
    }
    stats.ms += performance.now() - started;
    if (vector.expected) {
      if (vector.expected.includes(decoded)) stats.matched++;
      else if (decoded === undefined) stats.missed++;
      else stats.wrong++;
    } else if (decoded !== undefined) {
      stats.unknownDecoded++;
    }
  }
  return byCategory;
}

function printPass(categories, byCategory) {
  const summary = { files: 0, quality: 0, ms: 0 };
  for (const category of categories) {
    const stats = byCategory[category];
    if (stats === undefined) continue;
    const quality = stats.matched + stats.unknownDecoded;
    console.log(`${category},${percent(quality, stats.files)},${millis(stats.ms / stats.files)}`);
    summary.files += stats.files;
    summary.quality += quality;
    summary.ms += stats.ms;
  }
  const msPerImage = summary.files === 0 ? 0 : summary.ms / summary.files;
  console.log(`summary,${percent(summary.quality, summary.files)},${millis(msPerImage)}`);
}

// Merge a worker's per-category stats into the aggregate, field-wise.
function mergeStats(into, from) {
  for (const category in from) {
    const target = into[category] ?? (into[category] = newStats());
    for (const key in from[category]) target[key] += from[category][key];
  }
}

function runWorkers(vectors) {
  return new Promise((resolve, reject) => {
    const merged = {};
    let done = 0;
    for (let i = 0; i < WORKERS; i++) {
      const worker = cluster.fork({ QR_WORKER_INDEX: String(i) });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code) reject(new Error(`quality worker crashed with code ${code}`));
      });
      worker.on('message', (byCategory) => {
        mergeStats(merged, byCategory);
        if (++done === WORKERS) resolve(merged);
      });
    }
  });
}

async function main() {
  const categories = select('QR_QUALITY_CATEGORIES', listFiles(DETECTION_PATH, true));
  const vectors = categories.flatMap((c) => vectorFiles(c, DECODED, DECODE_VECTOR_EXCLUDE));
  if (cluster.isWorker) {
    const id = Number(process.env.QR_WORKER_INDEX);
    const subset = vectors.filter((_, i) => i % WORKERS === id);
    process.send!(runVectors(subset));
    process.disconnect();
    return;
  }
  if (!isDefault) console.log(`# decoder=${decoderPath}`);
  if (EFFORT_MAX) console.log('# effort=max');
  const byCategory = WORKERS > 1 ? await runWorkers(vectors) : runVectors(vectors);
  printPass(categories, byCategory);
}

main();
