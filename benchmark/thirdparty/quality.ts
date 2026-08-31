import * as jpeg from 'jpeg-js';
import { readFileSync } from 'node:fs';
import { DETECTION_PATH, listFiles } from '../_utils.ts';
import { DECODE } from './index.ts'; // entry-guarded: importing runs no benchmarks

const percent = (a, b) => `${('' + (a / b) * 100).slice(0, 5)}%`;

async function main() {
  const totals = {};
  let totalFiles = 0;
  for (const category of listFiles(DETECTION_PATH, true)) {
    const DIR_PATH = `${DETECTION_PATH}/${category}`;
    const files = listFiles(DIR_PATH).filter((f) => f.endsWith('.jpg'));
    if (files.length === 0) continue;
    const jpg = files.map((f) => jpeg.decode(readFileSync(`${DIR_PATH}/${f}`)));
    const res = {};
    for (const name in DECODE) {
      if (!res[name]) res[name] = 0;
      for (const img of jpg) {
        const fn = DECODE[name];
        try {
          // zxing-wasm is async; awaiting is a no-op for the sync decoders.
          if ((await fn(img)) === undefined) throw new Error('no result');
          res[name]++;
        } catch (e) {}
      }
      totals[name] = (totals[name] || 0) + res[name];
    }
    totalFiles += files.length;
    console.log(
      `${category}(${files.length}): `,
      Object.keys(res)
        .map((i) => `${i}=${res[i]} (${percent(res[i], files.length)})`)
        .join(' ')
    );
  }
  console.log(
    `summary(${totalFiles}): `,
    Object.keys(totals)
      .map((i) => `${i}=${totals[i]} (${percent(totals[i], totalFiles)})`)
      .join(' ')
  );
}

main();
