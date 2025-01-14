import { deepStrictEqual } from 'node:assert';
import { run, mark } from 'micro-bmark';
import * as jpeg from 'jpeg-js';
import * as fs from 'node:fs';
import encodeQR from '../esm/index.js';
import decodeQR from '../esm/decode.js';
// Other libraries
import * as qrcodeGenerator from 'qrcode-generator';
import jsqr from 'jsqr';
import * as nuintun from '@nuintun/qrcode';
import * as instascan from 'instascan/src/zxing.js';

const decodeExp = 'https://www.surveymonkey.com/s/TheClubatLAS_T3';
const decodeJPG = jpeg.decode(fs.readFileSync('../test/vectors/boofcv-v3/detection/blurred/image007.jpg'));

// Compared to other JS libraries:
// - Don't work: [jsQR](https://github.com/cozmo/jsQR) is dead, [zxing-js](https://github.com/zxing-js/) is [dead](https://github.com/zxing-js/library/commit/b797504c25454db32aa2db410e6502b6db12a401), [qr-scanner](https://github.com/nimiq/qr-scanner/) uses jsQR, doesn't work outside of browser, [qcode-decoder](https://github.com/cirocosta/qcode-decoder) broken version of jsQR, doesn't work outside of browser
// - Uncool: [instascan](https://github.com/schmich/instascan) is 1MB+ (zxing compiled to js via emscripten), [qrcode](https://github.com/nuintun/qrcode) modern refactor of jsQR (138 stars)

const DECODE = {
  paulmillr: (jpg) => decodeQR(jpg),
  jsqr: (jpg) => jsqr(jpg.data, jpg.width, jpg.height).data,
  nuintun: (jpg) => {
    // It corrupts image.data...
    return new nuintun.Decoder().decode(Uint8Array.from(jpg.data), jpg.width, jpg.height).data;
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
};

const ENCODE = {
  // paulmillr/qr doesn't support data-url, nuintun doesn't support ascii
  paulmillr: (txt, type) => encodeQR(txt, type, { ecc: 'medium' }),
  'qrcode-generator': (txt, type) => {
    const code = qrcodeGenerator.default(0, 'M');
    code.addData(txt, 'Alphanumeric');
    code.make();
    if (type === 'ascii') return code.createASCII(1);
    else if (type === 'gif') return code.createDataURL();
  },
  nuintun: (txt, type) => {
    const qrcode = new nuintun.Encoder();
    qrcode.setEncodingHint(true);
    qrcode.setErrorCorrectionLevel(nuintun.ErrorCorrectionLevel.M);
    qrcode.write('你好世界\n');
    qrcode.write(new nuintun.QRAlphanumeric(txt));
    qrcode.make();
    return qrcode.toDataURL();
  },
};

const listFiles = (path, isDir = false) =>
  fs.readdirSync(path).filter((i) => fs.statSync(`${path}/${i}`).isDirectory() === isDir);

const percent = (a, b) => `${('' + (a / b) * 100).slice(0, 5)}%`;
const section = (name) => console.log(`======== ${name} ========`);

async function main() {
  await run(async () => {
    for (const type of ['ascii', 'gif']) {
      section(`encode/${type}`);
      for (const name in ENCODE) {
        const fn = ENCODE[name];
        await mark(`encode/${name}`, 3000, () => fn('HELLO WORLD', type));
      }
    }
    section('encode: big');
    for (const name in ENCODE) {
      const fn = ENCODE[name];
      await mark(`encode/${name}`, 500, () => fn('H'.repeat(768), 'ascii'));
    }
    section('decode');
    for (const name in DECODE) {
      const fn = DECODE[name];
      await mark(`decode/${name}`, 500, () => deepStrictEqual(fn(decodeJPG), decodeExp));
    }
  });
  section('Decoding quality');
  const DETECTION_PATH = '../test/vectors/boofcv-v3/detection';

  for (const category of listFiles(DETECTION_PATH, true)) {
    const DIR_PATH = `${DETECTION_PATH}/${category}`;
    const files = listFiles(DIR_PATH).filter((f) => f.endsWith('.jpg'));
    const jpg = files.map((f) => jpeg.decode(fs.readFileSync(`${DIR_PATH}/${f}`)));
    const res = {};
    for (const name in DECODE) {
      if (!res[name]) res[name] = 0;
      for (const img of jpg) {
        const fn = DECODE[name];
        try {
          fn(img);
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
}

main();
