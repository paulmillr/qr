# qr (paulmillr-qr)

Minimal 0-dependency QR code generator & reader.

- 🔒 Auditable, 0-dependency
- 🏎 [Fast](#speed): up to 65x faster encoding/decoding than other JS libraries, faster than zxing-wasm
- 🔍 High-quality: decodes 58% of BoofCV photo vectors
- 🏞️ Encoding (generating) supports ASCII, term, gif, data-url and svg codes
- 📷 Decoding (reading) supports camera feed input, files and non-browser environments
- 🪶 6KB (gzipped) for encoding, 20KB for encoding + decoding

Check out [Interactive demo](https://paulmillr.com/apps/qr/); also there is [cuer React Component](https://github.com/wevm/cuer).

## Usage

> `npm install qr`

> `jsr add jsr:@paulmillr/qr`

To produce a standalone file, use **bismar**: `npx bismar -b npm:qr/index.js/encodeQR`.

Three entry points — import only what you use (sizes are esbuild-bundled, minified, gzipped):

| import           | provides                                                        | size                     |
| ---------------- | --------------------------------------------------------------- | ------------------------ |
| `qr`             | `encodeQR`                                                      | 5.4KB                    |
| `qr/decode.js`   | `decodeQR`, `BarcodeDetector`                                   | 7.3KB (11.5KB with `qr`) |
| `qr/dom.js`      | `QRCanvas`, `rearCamera`, `selfieCamera`, `frameLoop`, `svgToPng`, `gifToPng` | 9.3KB (includes decoder) |

- [Encoding](#encoding)
- [Decoding](#decoding)
  - [Scan from webcam](#scan-from-webcam)
  - [Decode image files](#decode-image-files)
  - [BarcodeDetector polyfill](#barcodedetector-polyfill)
- [Documentation](#documentation)
- [Security](#security)
- [Speed](#speed)

## Encoding

```js
import encodeQR from 'qr';

const txt = 'Hello world';
console.log(encodeQR(txt, 'term')); // print to terminal; works in every font
const svg = encodeQR(txt, 'svg'); // '<svg...' markup string for web pages
const gifBytes = encodeQR(txt, 'gif', { scale: 4 }); // Uint8Array, uncompressed GIF file
const dataUrl = encodeQR(txt, 'data-url', { scale: 4 }); // 'data:image/gif;base64,...' for <img src>
const matrix = encodeQR(txt, 'raw'); // boolean[][] for canvas or custom drawing
const ascii = encodeQR(txt, 'ascii'); // 2x denser than 'term', needs a box-drawing font
```

For PNG, render the SVG in a browser with `svgToPng` from `qr/dom.js`:
`const pngDataUrl = await svgToPng(encodeQR(txt, 'svg'), 512, 512);`

All options:

```ts
type QrOpts = {
  ecc?: 'low' | 'medium' | 'quartile' | 'high'; // error correction: 7%, 15% (default), 25%, 30%
  encoding?: 'numeric' | 'alphanumeric' | 'byte'; // smallest fit is picked automatically
  textEncoder?: (text: string) => Uint8Array; // custom text-to-bytes encoder for 'byte' mode
  version?: number; // 1..40, QR code version; smallest fit is picked automatically
  mask?: number; // 0..7, mask number; best is picked automatically
  border?: number; // border (quiet zone) size in modules, default 2
  scale?: number; // pixels per module, default 1
  optimize?: boolean; // 'svg' only: merge modules into fewer path elements, default true
};
declare function encodeQR(text: string, output: 'raw', opts?: QrOpts): boolean[][];
declare function encodeQR(
  text: string,
  output: 'ascii' | 'term' | 'svg' | 'data-url',
  opts?: QrOpts
): string;
declare function encodeQR(text: string, output: 'gif', opts?: QrOpts): Uint8Array;
```

Example output:

```text
█████████████████████████████████
██ ▄▄▄▄▄ █  ▄ ▄██▄ █▀▀▄█ ▄▄▄▄▄ ██
██ █   █ █▄ ▄▀███▄ ███▄█ █   █ ██
██ █▄▄▄█ █▄█   █▄  ▄█▄██ █▄▄▄█ ██
██▄▄▄▄▄▄▄█▄█▄▀ ▀▄▀ █▄▀▄█▄▄▄▄▄▄▄██
██ ▀▀  ▄▄  ▄█▄▀ ██▀▄▀   █▀ █  ▄██
██▀▄▀▀  ▄ ▄ ▀ ▀ █▄ ▀█▀▀▀▀▄ ▀▄█▀██
███ █▀▀▄▄█ ▄▀   ▀▄  █▄█▄ ▀▀▀▀▀ ██
██ ▀  ▄ ▄▄▀█ █▀▄█▀▄█ ▄ ██  █ █ ██
██▀█▀▄█ ▄█ █ ▄▄▀ █ ▀▀█▀███▀▄▀▀███
██  ▀▀▄ ▄▄█   ▄█▀▄██▄ ▄▄ ▀█ ▀█▄██
██▄▄▄█▄▄▄█▀▀▄▄▀▄ ▄▄██▄ ▄▄▄  ▄▄███
██ ▄▄▄▄▄ █ ▄▀▀██ ▀█ ▄  █▄█ ▄██▀██
██ █   █ █  ▄█▄ ▄██  ▄▄ ▄▄▄▄█▀███
██ █▄▄▄█ ██ ██ ▀ ▄▀ ▀█▄ ▀  ▀ ▄ ██
██▄▄▄▄▄▄▄█▄▄▄████▄█▄██▄██▄█▄█████
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

## Decoding

`decodeQR` takes raw RGBA pixels — `{ width, height, data }`, the shape a
canvas `ImageData` already has — and returns the decoded string. It **throws**
when no QR code is found: in a camera loop treat that as a frame miss and feed
it the next frame instead of retrying the failed one.

Effort is controlled by two options. `effort` sets the retry tier: `1` keeps
only mandatory work, larger values admit more hypotheses, `Infinity` runs
every retry at every resolution up to the image's native one. `timeLimit`
caps the milliseconds spent on optional retries and defaults to one 60-FPS
frame budget, so live camera frames stay fast (a failing 1080p frame returns
in ~4ms). For photos and file uploads pass
`{ effort: Infinity, timeLimit: Infinity }`, which lifts [BoofCV accuracy](#quality) from
~58% to ~61%. Successful decodes cost the same in every tier, since retries
only run after a failed strict pass.

### Scan from webcam

`qr/dom.js` ships the camera plumbing: `rearCamera` opens the rear
(environment-facing) camera into a `<video>` element, `QRCanvas` decodes frames and optionally
draws a live finder overlay and a preview of the decoded code, `frameLoop`
wraps `requestAnimationFrame`:

```js
import { QRCanvas, frameLoop, rearCamera } from 'qr/dom.js';

const video = document.querySelector('video');
const overlay = document.querySelector('canvas'); // positioned over the video; optional
const canvas = new QRCanvas({ overlay });
const camera = await rearCamera(video);
const cancel = frameLoop(() => {
  const decoded = camera.readFrame(canvas); // undefined until a frame decodes
  if (decoded !== undefined) {
    console.log(decoded);
    cancel();
    camera.stop(); // release the camera
  }
});
```

`selfieCamera` is the same helper for the user-facing camera (e.g. a code
held up to a laptop webcam); `camera.listDevices()` and
`camera.setDevice(deviceId)` switch cameras.
Camera access requires a secure context: on iOS Safari that means `https:` —
`file:` and plain `http:` won't work.

### Decode image files

In browsers, the native image decoder handles any format:

```js
import decodeQR from 'qr/decode.js';

async function decodeImageFile(file) {
  // file: e.g. from <input type="file"> or fetch(...).blob()
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return decodeQR(ctx.getImageData(0, 0, bitmap.width, bitmap.height));
}
```

Outside browsers, decode image files to RGBA with any image library and pass
`{ width, height, data }` to `decodeQR`. Clean 1px-per-module rasters (the
encoder's default `scale: 1`) are too small for run-length finder detection —
upscale them ≥2× first.

### BarcodeDetector polyfill

`qr/decode.js` ships a
[BarcodeDetector](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector)
ponyfill on top of `decodeQR`. Importing it has no side effects — use the class
directly, or install it as a drop-in polyfill:

```js
import { BarcodeDetector } from 'qr/decode.js';
globalThis.BarcodeDetector ??= BarcodeDetector;

const detector = new BarcodeDetector({ formats: ['qr_code'] });
const barcodes = await detector.detect(canvas); // [{ rawValue, boundingBox, cornerPoints, format }]
```

Differences from native implementations: only the `qr_code` format is supported,
at most one barcode per image is returned, and `cornerPoints` reuse the
decoder-projected symbol boundary, so they are estimates of the visible barcode
edges.

## Documentation

See `docs/encode.md` and `docs/decode.md` for more details.

## Security

There are multiple ways a single text can be encoded in a QR code, which can lead to potential security implications:

- **Segmentation Differences:** For example, `abc123` can be encoded as:
  `[{type: 'alphanum', data: 'abc'}, {type: 'num', data: '123'}]` or `[{type: 'alphanum', data: 'abc123'}]`
- **Mask Selection Algorithms:** Different libraries may use different algorithms for mask selection.
- **Default Settings:** Variations in error correction levels and how many bits are stored before upgrading versions.

If an adversary can access multiple QR codes generated from a specific library, they may be able to fingerprint the user. This fingerprinting could be used to exfiltrate data from air-gapped systems. In such cases, the adversary would need to create a library-specific exploit.

We mitigate these risks by:

- **Cross-Testing:** We currently cross-test against python-qrcode, which is closer to the specification
  than some JavaScript implementations.
- **Single Segment Encoding:** We always use single-segment encoding.
  While this may not be the most optimal for performance, it reduces the amount of fingerprinting data.

TODO: **Testing Against Multiple Libraries:** To further improve security and reduce fingerprinting, we can
cross-test against three to four popular libraries.

## Speed

Measured 2026-08 on one idle AMD Zen 5 core, Node 24. Reproduce with
`npm run benchmark` and `npm run benchmark:thirdparty`.

Encoding (`raw` matrix output, ECC medium), vs other JS encoders:

| payload             | qr         | qrcode | lean-qr | uqr   | qrcode-generator | nuintun |
| ------------------- | ---------- | ------ | ------- | ----- | ---------------- | ------- |
| v1, 11 chars        | **4.4µs**  | 40µs   | 40µs    | 145µs | 168µs            | 54µs    |
| v3, 31 chars        | **7.5µs**  | 90µs   | 95µs    | 302µs | 430µs            | 150µs   |
| v8, 192 chars       | **23µs**   | 296µs  | 255µs   | 983µs | 1.5ms            | 681µs   |
| v18, 768 chars      | **65µs**   | 1.2ms  | 977µs   | 3.3ms | 5.2ms            | 2.5ms   |

Encoding + rendering ("-" means library doesn't support it):

| format   | qr        | qrcode | lean-qr | uqr   | qrcode-generator | nuintun |
| -------- | --------- | ------ | ------- | ----- | ---------------- | ------- |
| ascii    | **4.6µs** | 41µs   | 44µs    | 148µs | 176µs            | —       |
| svg      | **11µs**  | 43µs   | 118µs   | 153µs | 166µs            | —       |
| data-url | **5.5µs** | 537µs  | 54µs    | —     | 194µs            | 220µs   |

Decoding, vs JS/WASM alternatives, over 20 different photos:

| workload  | qr         | zxing-wasm | @zxing/library | zbar-wasm | jsqr   |
| --------- | ---------- | ---------- | -------------- | --------- | ------ |
| raster v1 | 108µs      | 86µs       | **62µs**       | 254µs     | 417µs  |
| 720p ok   | **2.4ms**  | **2.4ms**  | 3.6ms          | 16.4ms    | 23.8ms |
| 1080p ok  | **5.3ms**  | 8.8ms      | 11ms           | 63ms      | 351ms  |
| 12MP ok   | **25.1ms** | 42ms       | 54ms           | 260ms     | 528ms  |


### Quality

We're measuring accuracy / quality via BoofCV test vectors.

Measured with `npm run benchmark:quality` on 2026-08:

- qr (this library): 57.5% default, 60.6% with `effort: Infinity, timeLimit: Infinity`
- zxing-cpp fast mode 50%, slow mode 75%

Not all of the test vectors are equal for webcam decoding:

| category     | why it matters on a webcam                                                 |
| ------------ | -------------------------------------------------------------------------- |
| blurred      | P1: focus-hunting is _the_ dominant webcam failure mode                    |
| bright_spots | P2: LED/spotlight hotspots; overlaps glare, rarer                          |
| brightness   | P1: webcam auto-exposure constantly over/undershoots                       |
| close        | P2: codes shoved inside autofocus range — huge blurry modules              |
| curved       | P2: codes on bottles/packaging held to the camera                          |
| damaged      | P2: worn prints exist, but webcam scans skew toward screens/fresh prints   |
| glare        | P1: specular reflections off glossy prints, phone screens, lamination      |
| high_version | P3: dense v20+ rarely resolves at 720p regardless of decoder               |
| lots         | P3: many codes on one sheet — a webcam session aims at _one_ code          |
| monitor      | P1: codes shown on _screens_ (login/pairing/payment) — the top desktop use |
| nominal      | P1: the baseline "code held decently in view" case                         |
| noncompliant | P3: spec-violating codes are rare in the wild                              |
| pathological | P3: synthetic stress patterns, not camera reality                          |
| perspective  | P1: nobody holds paper parallel to the lens                                |
| rotations    | P1: hand-held codes arrive at arbitrary orientation                        |
| shadows      | P1: the user's own hand/head shadows the held-up code                      |

## License

Copyright (c) 2023 Paul Miller (paulmillr.com)

Copyright (c) 2019 ZXing authors

The library paulmillr-qr is dual-licensed under the Apache 2.0 OR MIT license.
You can select a license of your choice.

The library contains code inspired by [ZXing](https://github.com/zxing/zxing), which is licensed under Apache 2.0.

The license to the use of the QR Code stipulated by JIS (Japanese Industrial Standards) and the ISO are not necessary.
The specification for QR Code has been made available for use by any person or organization. (Obtaining QR Code Specification)
The word “QR Code” is registered trademark of DENSO WAVE INCORPORATED in Japan and other countries.
To use the word “QR Code” in your publications or web site, etc, please indicate a sentence QR Code is registered trademark of DENSO WAVE INCORPORATED.
This registered trademark applies only for the word “QR Code”, and not for the QR Code pattern (image).
(https://www.qrcode.com/en/faq.html)
