import { bench } from '@paulmillr/jsbt/bench.js';
import * as jpeg from 'jpeg-js';
import { deepStrictEqual } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join as pjoin } from 'node:path';
import decodeQR from '../../src/decode.ts';
import encodeQR from '../../src/index.ts';
// Other libraries
import * as nuintun from '@nuintun/qrcode';
import * as instascan from 'instascan/src/zxing.js';
import jsqr from 'jsqr';
import { readBarcodes } from 'zxing-wasm/reader';
import zxing from '@zxing/library';
import { scanImageData } from '@undecaf/zbar-wasm';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';
import QRCode from 'qrcode';
import * as uqr from 'uqr';
import { generate, correction } from 'lean-qr';
import { toSvgSource } from 'lean-qr/extras/svg';
import { toPngDataURL } from 'lean-qr/extras/node_export';

const _dirname = dirname(fileURLToPath(import.meta.url));
const decodeExp = 'https://www.surveymonkey.com/s/TheClubatLAS_T3';
const decodeJPG = jpeg.decode(
  readFileSync(_dirname + '/../../test/vectors/boofcv-v3/detection/blurred/image007.jpg')
);

// Compared to other JS libraries:
// - Don't work: [qr-scanner](https://github.com/nimiq/qr-scanner/) uses jsQR, doesn't work outside of browser, [qcode-decoder](https://github.com/cirocosta/qcode-decoder) broken version of jsQR, doesn't work outside of browser
// - Benched anyway: [jsQR](https://github.com/cozmo/jsQR) unmaintained since 2021 but still the baseline, [zxing-js](https://github.com/zxing-js/library) is NOT dead (shipped 0.23.0 in 2026-04, self-declared maintenance mode), [instascan](https://github.com/schmich/instascan) is 1MB+ (zxing compiled to js via emscripten), [qrcode](https://github.com/nuintun/qrcode) modern refactor of jsQR
// - WASM engines: [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) is ZXing-C++ via WASM, [@undecaf/zbar-wasm](https://github.com/undecaf/zbar-wasm) is the only maintained ZBar (LGPL-2.1)

const DECODE = {
  '@paulmillr/qr': (jpg) => decodeQR(jpg),
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
  'zxing-wasm': async (jpg) => (await readBarcodes(jpg, { formats: ['QRCode'] }))[0].text,
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
    return new zxing.MultiFormatReader().decode(bitmap, hints).getText();
  },
  'zbar-wasm': async (jpg) => (await scanImageData(jpg))[0].decode(),
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
};

// All encoders use ECC level M. A library missing a format is skipped in that
// section, never emulated with wrapper glue.
const isAlnum = (txt) => /^[0-9A-Z $%*+\-./:]*$/.test(txt);
const qrcodeGen = (txt) => {
  const code = qrcode(0, 'M');
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
  '@paulmillr/qr': {
    raw: (txt) => encodeQR(txt, 'raw', { ecc: 'medium' }),
    ascii: (txt) => encodeQR(txt, 'ascii', { ecc: 'medium' }),
    svg: (txt) => encodeQR(txt, 'svg', { ecc: 'medium' }),
  },
  'qrcode-generator': {
    raw: (txt) => qrcodeGen(txt),
    ascii: (txt) => qrcodeGen(txt).createASCII(1),
    svg: (txt) => qrcodeGen(txt).createSvgTag(1, 0),
    'data-url': (txt) => qrcodeGen(txt).createDataURL(1, 0),
  },
  nuintun: {
    raw: (txt) => nuintunEncode(txt),
    'data-url': (txt) => nuintunEncode(txt).toDataURL(4),
  },
  qrcode: {
    raw: (txt) => QRCode.create(txt, { errorCorrectionLevel: 'M' }),
    ascii: (txt) => QRCode.toString(txt, { type: 'utf8', errorCorrectionLevel: 'M' }),
    svg: (txt) => QRCode.toString(txt, { type: 'svg', errorCorrectionLevel: 'M' }),
    'data-url': (txt) => QRCode.toDataURL(txt, { errorCorrectionLevel: 'M' }),
  },
  uqr: {
    raw: (txt) => uqr.encode(txt, { ecc: 'M' }),
    ascii: (txt) => uqr.renderANSI(txt, { ecc: 'M' }),
    svg: (txt) => uqr.renderSVG(txt, { ecc: 'M' }),
  },
  'lean-qr': {
    raw: (txt) => leanQr(txt),
    ascii: (txt) => leanQr(txt).toString(),
    svg: (txt) => toSvgSource(leanQr(txt)),
    'data-url': (txt) => toPngDataURL(leanQr(txt)),
  },
};

const listFiles = (path, isDir = false) =>
  readdirSync(path).filter((i) => statSync(`${path}/${i}`).isDirectory() === isDir);

const percent = (a, b) => `${('' + (a / b) * 100).slice(0, 5)}%`;
const section = (name) => console.log(`\n# ${name}`);

async function main() {
  for (const type of ['raw', 'ascii', 'svg', 'data-url']) {
    const inputs =
      type === 'raw' ? ['HELLO WORLD', 'https://github.com/paulmillr/qr'] : ['HELLO WORLD'];
    for (const txt of inputs) {
      section(`encode format=${type} (${isAlnum(txt) ? 'alphanumeric' : 'byte'})`);
      for (const name in ENCODE) {
        const fn = ENCODE[name][type];
        if (!fn) continue;
        await bench(`${name}`, () => fn(txt));
      }
    }
  }
  section('encode of large qr (raw)');
  for (const name in ENCODE) {
    const fn = ENCODE[name].raw;
    if (!fn) continue;
    await bench(`${name}`, () => fn('H'.repeat(768)));
  }

  section('decode');
  for (const name in DECODE) {
    const fn = DECODE[name];
    // keep sync decoders promise-free so their timings aren't inflated
    await bench(`${name}`, () => {
      const out = fn(decodeJPG);
      return out instanceof Promise
        ? out.then((v) => deepStrictEqual(v, decodeExp))
        : deepStrictEqual(out, decodeExp);
    });
  }

  section('Decoding quality');
  const _dirname = dirname(fileURLToPath(import.meta.url));
  const DETECTION_PATH = pjoin(_dirname, '..', '..', 'test', 'vectors', 'boofcv-v3', 'detection');

  // @zxing/library 0.23.0 console.warns a stack trace on every decode miss;
  // silence just that line so per-category counts stay readable
  const origWarn = console.warn;
  console.warn = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('MultiFormatReader:')) return;
    origWarn(...args);
  };
  try {
    for (const category of listFiles(DETECTION_PATH, true)) {
      const DIR_PATH = `${DETECTION_PATH}/${category}`;
      const files = listFiles(DIR_PATH).filter((f) => f.endsWith('.jpg'));
      const jpg = files.map((f) => jpeg.decode(readFileSync(`${DIR_PATH}/${f}`)));
      const res = {};
      for (const name in DECODE) {
        if (!res[name]) res[name] = 0;
        for (const img of jpg) {
          const fn = DECODE[name];
          try {
            await fn(img);
            res[name]++;
          } catch (e) {}
        }
      }
      console.log(
        `${category}(${files.length}): `,
        Object.keys(res)
          .map((i) => `${i}=${res[i]} (${percent(res[i], files.length)})`)
          .join(' ')
      );
    }
  } finally {
    console.warn = origWarn;
  }
}

main();
