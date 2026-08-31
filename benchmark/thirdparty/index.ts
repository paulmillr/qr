// Speed comparison vs other JS/WASM QR libraries. Mirrors the workloads of
// benchmark/index.ts — same synthetic images and the same three 20-photo
// buckets in the same seeded-random order — so rows line up with the main
// benchmark. Run `npm ci` in this directory first.
import { bench } from '@paulmillr/jsbt/benchmark.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import decodeQR052 from 'qr-0.5.2/decode.js';
import decodeQR060 from 'qr-0.6.0/decode.js';
import decodeQR from '../../src/decode.ts';
import { encodeQR } from '../../src/index.ts';
import {
  benchRotating,
  encodeVersion,
  hasVectors,
  isAlnum,
  loadBuckets,
  section,
  SUBMODULE_HINT,
  syntheticImages,
  TEXTS,
} from '../_utils.ts';
// Other libraries
import * as nuintun from '@nuintun/qrcode';
import { scanImageData } from '@undecaf/zbar-wasm';
import zxing from '@zxing/library';
import * as instascan from 'instascan/src/zxing.js';
import jsqr from 'jsqr';
import { correction, generate } from 'lean-qr';
import { toPngDataURL } from 'lean-qr/extras/node_export';
import { toSvgSource } from 'lean-qr/extras/svg';
import QRCode from 'qrcode';
import qrcodeGenerator from 'qrcode-generator';
import * as uqr from 'uqr';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

// All encoders use ECC level M. A library missing a format is skipped in that
// section, never emulated with wrapper glue.
const qrcodeGen = (txt) => {
  const code = qrcodeGenerator(0, 'M');
  code.addData(txt, isAlnum(txt) ? 'Alphanumeric' : 'Byte');
  code.make();
  return code;
};
const nuintunSegment = (txt) =>
  isAlnum(txt) ? new nuintun.Alphanumeric(txt) : new nuintun.Byte(txt);
const nuintunEncode = (txt) => new nuintun.Encoder({ level: 'M' }).encode(nuintunSegment(txt));
// lean-qr defaults to minimal-that-fits ECC, so M must be pinned on both bounds
const leanQr = (txt) =>
  generate(txt, { minCorrectionLevel: correction.M, maxCorrectionLevel: correction.M });

const ENCODE = {
  qr: {
    raw: (txt) => encodeQR(txt, 'raw', { ecc: 'medium' }),
    ascii: (txt) => encodeQR(txt, 'ascii', { ecc: 'medium' }),
    'data-url': (txt) => encodeQR(txt, 'data-url', { ecc: 'medium' }),
    svg: (txt) => encodeQR(txt, 'svg', { ecc: 'medium' }),
  },
  qrcode: {
    raw: (txt) => QRCode.create(txt, { errorCorrectionLevel: 'M' }),
    ascii: (txt) => QRCode.toString(txt, { type: 'utf8', errorCorrectionLevel: 'M' }),
    'data-url': (txt) => QRCode.toDataURL(txt, { errorCorrectionLevel: 'M' }),
    svg: (txt) => QRCode.toString(txt, { type: 'svg', errorCorrectionLevel: 'M' }),
  },
  'lean-qr': {
    raw: (txt) => leanQr(txt),
    ascii: (txt) => leanQr(txt).toString(),
    'data-url': (txt) => toPngDataURL(leanQr(txt)),
    svg: (txt) => toSvgSource(leanQr(txt)),
  },
  uqr: {
    raw: (txt) => uqr.encode(txt, { ecc: 'M' }),
    ascii: (txt) => uqr.renderANSI(txt, { ecc: 'M' }),
    svg: (txt) => uqr.renderSVG(txt, { ecc: 'M' }),
  },
  'qrcode-generator': {
    raw: (txt) => qrcodeGen(txt),
    ascii: (txt) => qrcodeGen(txt).createASCII(1),
    'data-url': (txt) => qrcodeGen(txt).createDataURL(1, 0),
    svg: (txt) => qrcodeGen(txt).createSvgTag(1, 0),
  },
  nuintun: {
    raw: (txt) => nuintunEncode(txt),
    'data-url': (txt) => nuintunEncode(txt).toDataURL(4),
  },
};

// zxing-wasm needs its WASM binary handed over explicitly under Node (no
// fetch of file:// URLs); initialized lazily on first decode.
const WASM_OPTS = { formats: ['QRCode'], maxNumberOfSymbols: 1, tryHarder: true };
let wasmReady;
const ensureWasm = () =>
  (wasmReady ??= prepareZXingModule({
    overrides: {
      wasmBinary: readFileSync(
        fileURLToPath(import.meta.resolve('zxing-wasm/reader/zxing_reader.wasm'))
      ),
    },
    fireImmediately: true,
  }));

// Decoders: each takes { width, height, data } (RGBA) and returns the decoded
// text or throws/returns undefined on failure. zxing-wasm and zbar-wasm are
// async — callers must await results (jsbt's bench does; quality.ts awaits
// explicitly).
// 'qr@0.5.2' / 'qr@0.6.0' are npm releases (aliased in package.json).
export const DECODE = {
  qr: (jpg) => decodeQR(jpg),
  'qr@0.5.2': (jpg) => decodeQR052(jpg),
  'qr@0.6.0': (jpg) => decodeQR060(jpg),
  jsqr: (jpg) => jsqr(jpg.data, jpg.width, jpg.height).data,
  nuintun: (jpg) => {
    const luminances = nuintun.grayscale(jpg);
    const matrix = nuintun.binarize(luminances, jpg.width, jpg.height);
    for (const detected of new nuintun.Detector().detect(matrix)) {
      try {
        return new nuintun.Decoder().decode(detected.matrix).content;
      } catch (e) {}
    }
    throw new Error('nuintun: no decodable candidate');
  },
  '@zxing/library': (jpg) => {
    // RGBLuminanceSource expects 1-byte-per-pixel luminance, not RGBA
    const { data, width, height } = jpg;
    const luminances = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < data.length; i += 4, j++)
      luminances[j] = (data[i] + 2 * data[i + 1] + data[i + 2]) / 4;
    const source = new zxing.RGBLuminanceSource(luminances, width, height);
    const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(source));
    const hints = new Map();
    hints.set(zxing.DecodeHintType.POSSIBLE_FORMATS, [zxing.BarcodeFormat.QR_CODE]);
    // 0.23.0 console.warns a stack trace on every decode miss; filter it here
    // so both the bench rows and quality.ts's per-category lines stay readable
    const origWarn = console.warn;
    console.warn = (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith('MultiFormatReader:')) return;
      origWarn(...args);
    };
    try {
      return new zxing.MultiFormatReader().decode(bitmap, hints).getText();
    } finally {
      console.warn = origWarn;
    }
  },
  instascan: (jpg) => {
    const ZXing = instascan.default({ TOTAL_MEMORY: 256 * 1024 * 1024 });
    let data = jpg.data;
    let imageBuffer = ZXing._resize(jpg.width, jpg.height);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      let [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      ZXing.HEAPU8[imageBuffer + j] = Math.trunc((r + g + b) / 3);
    }
    let res = '';
    let err = ZXing._decode_qr(
      ZXing.Runtime.addFunction(function (ptr, len, resultIndex, resultCount) {
        let result = new Uint8Array(ZXing.HEAPU8.buffer, ptr, len);
        let str = String.fromCharCode.apply(null, result);
        if (resultIndex === 0) res = '';
        res += str;
      })
    );
    if (err) throw new Error('ZXing error');
    return res;
  },
  'zxing-wasm': async (jpg) => {
    await ensureWasm();
    const res = (await readBarcodes(jpg, WASM_OPTS))[0];
    if (!res || !res.text) throw new Error('no result');
    return res.text;
  },
  'zbar-wasm': async (jpg) => (await scanImageData(jpg))[0].decode(),
};

async function main() {
  // Grouped by payload (TEXTS is version-ordered), like benchmark/index.ts.
  // raw covers every TEXTS payload, byte-mode url included; the render
  // formats (ascii/svg/data-url) price serialization on top of the same raw
  // encode, so the small payload suffices for them.
  for (const txt of Object.values(TEXTS)) {
    const types = txt === TEXTS.small ? ['raw', 'ascii', 'data-url', 'svg'] : ['raw'];
    const mode = isAlnum(txt) ? 'alphanumeric' : 'byte';
    for (const type of types) {
      section(`encode ${type}: v${encodeVersion(txt)}, ${txt.length} chars (${mode})`);
      for (const name in ENCODE) {
        const fn = ENCODE[name][type];
        if (!fn) continue;
        await bench(`${name}`, () => fn(txt));
      }
    }
  }

  // Decode workloads mirror benchmark/index.ts: synthetics plus the three
  // photo buckets, every photo read into a buffer before any timing. Note
  // "ok" describes qr's outcome — other libraries succeed or fail on their
  // own terms inside the same workload.
  const decodeTests = syntheticImages().map(({ name, image }) => [name, [image]]);
  if (hasVectors()) {
    for (const bucket of await loadBuckets()) {
      decodeTests.push([bucket.name, bucket.images]);
    }
  } else {
    console.log(SUBMODULE_HINT);
  }

  for (const [label, images] of decodeTests) {
    section(`decode: ${label}`);
    for (const name in DECODE) {
      const fn = DECODE[name];
      await benchRotating(name, images, async (img) => {
        try {
          await fn(img);
        } catch {}
      });
    }
  }

  // effort/timeLimit Infinity is qr's full-quality still-image tier (every
  // retry at every resolution, no wall-time budget) — the fair peer of
  // zxing-wasm's tryHarder, which the cross-library loop above already
  // enables; the released versions (0.5.2/0.6.0) don't declare the options,
  // so it isn't part of that loop.
  for (const [label, images] of decodeTests.filter(([l]) => l.startsWith('12MP'))) {
    section(`decode: ${label}, max effort`);
    await benchRotating('qr', images, (img) => {
      try {
        decodeQR(img, { effort: Infinity, timeLimit: Infinity });
      } catch {}
    });
  }
}

// Run only when executed directly — quality.ts imports DECODE from here.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
