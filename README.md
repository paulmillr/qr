# paulmillr-qr

Minimal 0-dependency QR code generator & reader.

- 🔒 Auditable, 0-dependency
- 🏎 [Fast](#speed): aims to be faster than all JS implementations
- 🔍 Reliable: 100MB+ of extensive test vectors ensure correctness
- 🏞️ Encoding (generating) supports ASCII, term, gif, svg and png codes
- 📷 Decoding (reading) supports camera feed input, files and non-browser environments
- 🪶 18KB (gzipped) for encoding + decoding, 9KB for encoding

Check out:

- [paulmillr.com/apps/qr/](https://paulmillr.com/apps/qr/) - interactive demo
- [qrBTF.com](https://qrbtf.com/en) - uses the library to generate custom, styled codes
- [cuer](https://github.com/wevm/cuer) - React component based on the library
- [metamask-sdk](https://github.com/MetaMask/metamask-sdk/blob/3d0ba19610853ec9259bb1aad459b1eaea799375/packages/sdk/package.json#L56) - is using the library

Why other libraries are less optimal:

- [jsQR](https://github.com/cozmo/jsQR) is dead, [zxing-js](https://github.com/zxing-js/) is [dead](https://github.com/zxing-js/library/commit/b797504c25454db32aa2db410e6502b6db12a401), [qr-scanner](https://github.com/nimiq/qr-scanner/) uses jsQR and doesn't work outside of browser, [qcode-decoder](https://github.com/cirocosta/qcode-decoder) is broken version of jsQR and doesn't work outside of browser, [qrcode](https://github.com/nuintun/qrcode) is fork of jsQR without adoption
- [instascan](https://github.com/schmich/instascan) is too big: over 1MB+ (it's zxing compiled to js via emscripten)

## Usage

A standalone file [qr.js](https://github.com/paulmillr/qr/releases) is also available.

> `npm install qr`

> `jsr add jsr:@paulmillr/qr`

- [Encoding](#encoding)
- [Decoding](#decoding)
  - [Decoding options](#decoding-options)
  - [Decoding algorithm](#decoding-algorithm)
  - [Decoding test vectors](#decoding-test-vectors)
  - [DOM helpers for web apps](#dom-helpers-for-web-apps)
- [Using with Kotlin](#using-with-kotlin)
- [Security](#security)
- [Speed](#speed)

## Encoding

```ts
import encodeQR from 'qr';

// import decodeQR from 'qr/decode.js';
// See separate README section for decoding.

const txt = 'Hello world';
const ascii = encodeQR(txt, 'ascii'); // Not all fonts are supported
const terminalFriendly = encodeQR(txt, 'term'); // 2x larger, all fonts are OK
const gifBytes = encodeQR(txt, 'gif'); // Uncompressed GIF
const svgElement = encodeQR(txt, 'svg'); // SVG vector image element
const array = encodeQR(txt, 'raw'); // 2d array for canvas or other libs
// import { svgToPng } from 'qr/dom.js';
// const png = svgToPng(svgElement, 512, 512); // .png, using DOM

// Options
// Custom error correction level
// low: 7%, medium: 15% (default), quartile: 25%, high: 30%
const highErrorCorrection = encodeQR(txt, 'gif', { ecc: 'high' });
// Custom encoding: 'numeric', 'alphanumeric' or 'byte'
const customEncoding = encodeQR(txt, 'gif', { encoding: 'byte' });
// Default scale is 2: each block is 2x2 pixels.
const larger = encodeQR(txt, 'gif', { scale: 4 });
// All options
// type QrOpts = {
//   ecc?: 'low' | 'medium' | 'quartile' | 'high';
//   encoding?: 'numeric' | 'alphanumeric' | 'byte' | 'kanji' | 'eci';
//   textEncoder?: (text: string) => Uint8Array;
//   version?: number; // 1..40, QR code version
//   mask?: number; // 0..7, mask number
//   border?: number; // Border size, default 2.
//   scale?: number; // Scale to this number. Scale=2 -> each block will be 2x2 pixels
// };

console.log(ascii);
```

Example output:

```text
█████████████████████████████████████
██ ▄▄▄▄▄ █  ▀▄▄█ ██▀▄▄▄▄█ ▀█ ▄▄▄▄▄ ██
██ █   █ █▀▄▀▄ ▄▄█▄█ ██▀█▀▀█ █   █ ██
██ █▄▄▄█ ██ ▄▄█▄▀▀ ▀ ██ ▄ ▄█ █▄▄▄█ ██
██▄▄▄▄▄▄▄█ ▀ ▀ █▄▀ ▀ ▀▄█ █ █▄▄▄▄▄▄▄██
██ █  ▀ ▄▄▀▀▀ █▀ ▄   ▀▀▄▀ ▄█ ▀█ ▀▄▄██
██▀▀▀  ▀▄▄██▄▀▀▄█▀ ▀▄█    ▀▀▀ ▄ █▄▄██
█████▄▀▀▄▄██ ▀ ▀ ▄▄██▄ ▄▄ ▄ █▀█ █ ███
███   ▄▀▄█▄▄▄█   ▀██▄▄▄▀▀█▄▀ ▄█▀ ████
██▀▀ ▄ ▀▄ ▄▄██▀▄▀▀████▄▄▄ █▄ █  █▀▀██
██▀▀▄ ▄▀▄ ▀▀█▄▀▀▄▄▀▀ █▄▄▀█▀ ▀▄ █▄ ▀██
██▀▄▀██ ▄▄ ▀█▄█▀ ▀ ▀█▄▀▀ █▄▀▀ █  █ ██
███▀█▄▀▄▄ █  █ ██ ██ ▄ █ ▄▄▄ ▄▀▀▄▄ ██
██▄█▄▄▄█▄█ ▄ ▄▀█▀▀ ▄▀ █▀ ▄ ▄▄▄ ▀▄▀▄██
██ ▄▄▄▄▄ █ ▄█▄▀▀ ▀█   █▄█  █▄█ ▀▀▄▀██
██ █   █ █▀ ▄▀█ ██ ▄▄▀██   ▄▄ ▄█   ██
██ █▄▄▄█ █▄  ██▀ ▄▄ ▀█ ▄      ▀▄▄█▀██
██▄▄▄▄▄▄▄█▄███▄█▄█▄▄▄▄█▄█▄████▄▄█████
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

## Decoding

GIF reader is not included in the package (it would take a lot of space).
Decoding raw bitmap is still possible.

```js
import encodeQR from 'qr';
import decodeQR from 'qr/decode.js';
import { Bitmap } from 'qr';

// Scale so it would be 100x100 instead of 25x25
const opts = { scale: 4 };

// a) Decode using raw bitmap, dependency-free
function decodeRawBitmap() {
  const bmBits = encodeQR('Hello world', 'raw', opts);
  const bm = new Bitmap({ width: bmBits[0].length, height: bmBits.length });
  bm.data = bmBits;
  const decoded = decodeQR(bm.toImage());
  console.log('decoded(pixels)', decoded);
}
/*
Output:
decoded(pixels) Hello world
decoded(gif) Hello world
*/

// b) Decode using external GIF decoder
import gif from 'omggif'; // npm install omggif@1.0.10
function parseGIF(image) {
  const r = new gif.GifReader(image);
  const data = [];
  r.decodeAndBlitFrameRGBA(0, data);
  const { width, height } = r.frameInfo(0);
  return { width, height, data };
}
function decodeWithExternal() {
  const gifBytes = encodeQR('Hello world', 'gif', opts);
  const decoded = decodeQR(parseGIF(gifBytes));
  console.log('decoded(gif)', decoded);
}
```

### Decoding options

```ts
type Point = { x: number; y: number };
type Pattern = Point & { moduleSize: number; count: number };
type FinderPoints = [Pattern, Pattern, Point, Pattern];
type Image = {
  height: number;
  width: number;
  data: Uint8Array | Uint8ClampedArray | number[];
};
type DecodeOpts = {
  cropToSquare?: boolean;
  textDecoder?: (bytes: Uint8Array) => string;
  pointsOnDetect?: (points: FinderPoints) => void;
  imageOnBitmap?: (img: Image) => void;
  imageOnDetect?: (img: Image) => void;
  imageOnResult?: (img: Image) => void;
};
declare function decodeQR(img: Image, opts?: DecodeOpts): string;
```

### Decoding algorithm

QR code decoding is challenging; it is essentially a computer vision problem. There are two main scenarios:

- Decoding from files: This can be slow because it needs to handle complicated cases such as blur or rotation.
- Decoding from a camera feed: This must be fast; even if one frame fails, the next frame can succeed.

The state-of-the-art approach for this, as with other computer vision problems, is using neural networks. However, using them would make the library hard to audit. Additionally, since JavaScript can't access hardware accelerators, it would likely be very slow. We also avoid using WebGL because it is complex and exposes users to fingerprinting.

The implemented reader algorithm is inspired by [ZXing](https://github.com/zxing/zxing):

1. `toBitmap`: Convert the image to a bitmap of black and white segments. This is the slowest part and the most important.
2. `detect`: Find three finder patterns and one alignment pattern (for versions > 1). This is tricky—they can be rotated and distorted by perspective. A square might appear as a quadrilateral with unknown size. The best we can do is count runs of the same color and select patterns with almost the same ratio of runs.
3. `transform`: Once patterns have been found, correct the perspective and transform the quadrilateral into a square.
4. `decodeBitmap`: Execute the encoding in reverse: read information via a zig-zag pattern, de-interleave bytes, correct errors, convert to bits, and finally, read segments from bits to create the string.
5. **Finished!**

### Decoding test vectors

To test our QR code decoding, we use an excellent dataset
from [BoofCV](http://boofcv.org/index.php?title=Performance:QrCode). BoofCV decodes 73% of the test cases,
while ZXing decodes 49%. Our implementation is nearly at parity with ZXing, primarily because ECI (Extended
Channel Interpretation) support is not yet included. The test vectors are preserved in a Git repository at
[github.com/paulmillr/qr-code-vectors](https://github.com/paulmillr/qr-code-vectors).

**Note for Testing on iOS Safari:** Accessing the camera on iOS Safari requires HTTPS. This means that the file: protocol or non-encrypted http cannot be used. Ensure your testing environment uses https:.

The QR code specification is available for purchase at [iso.org](https://www.iso.org/standard/62021.html) for 200 CHF.

### DOM helpers for web apps

Check out `dom.ts` for browser-related camera code that would make your apps simpler.

## Using with Kotlin

```kotlin
@JsModule("qr")
@JsNonModule
external object Qr {
    @JsName("default")
    fun encodeQR(text: String, output: String = definedExternally, opts: dynamic = definedExternally): Uint8Array
}

// then
val bytes = Qr.encodeQR("text", "gif", js("{ scale: 10 }"))
val blob = Blob(arrayOf(bytes), BlobPropertyBag("image/gif"))
val imgSrc = URL.createObjectURL(blob)
```

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

Future plans:

- **Testing Against Multiple Libraries:** To further improve security and reduce fingerprinting, we can
  cross-test against three to four popular libraries.

## Speed

Benchmarks measured with Apple M4 Pro with node.js 25.
All numbers are ops/sec (higher is better); 🥇 marks the fastest library in each column.
Encoders run at ECC level M; an empty cell means the library can't produce that output format natively.

Encoding. Every column encodes the string `HELLO WORLD` (alphanumeric mode), except two:
_byte_ encodes the URL `https://github.com/paulmillr/qr` — its lowercase letters force 8-bit
byte mode, since QR's alphanumeric charset only has digits, uppercase and a few symbols —
and _large_ encodes 768 alphanumeric characters. The columns differ in output format:

- **raw**: the library's native matrix / bitmap object (also used for _byte_ and _large_)
- **ascii**: text rendering for terminals
- **svg**: SVG string
- **data-url**: base64 `data:image` URL — note the image format differs per library:
  PNG for qrcode and lean-qr, GIF for qrcode-generator and nuintun

| library            |       raw | raw (byte) | raw (large) |     ascii |       svg |  data-url |
| ------------------ | --------: | ---------: | ----------: | --------: | --------: | --------: |
| @paulmillr/qr      |     9,010 |      4,613 |         287 |     9,285 |     8,635 |           |
| [qrcode-generator] |     5,433 |      2,392 |         170 |     5,272 |     5,539 |     5,042 |
| [nuintun]          |    19,268 |      8,165 |         443 |           |           |     4,280 |
| [qrcode]           |    24,417 |  🥇 11,405 |         927 | 🥇 24,421 | 🥇 23,508 |     2,129 |
| [uqr]              |     6,682 |      3,445 |         319 |     6,554 |     6,338 |           |
| [lean-qr]          | 🥇 24,492 |     11,283 |    🥇 1,155 |    24,183 |    10,487 | 🥇 20,319 |

Decoding a blurred 756×1008 photo of a QR code:

| library          | decode | avg time |
| ---------------- | -----: | -------: |
| @paulmillr/qr    | 🥇 654 |      1ms |
| [jsqr]           |     48 |     20ms |
| [nuintun]        |    195 |      5ms |
| [zxing-wasm]     |    269 |      3ms |
| [@zxing/library] |    348 |      2ms |
| [zbar-wasm]      |     65 |     15ms |
| [instascan]      |    140 |      7ms |

[qrcode-generator]: https://github.com/kazuhikoarase/qrcode-generator
[nuintun]: https://github.com/nuintun/qrcode
[qrcode]: https://github.com/soldair/node-qrcode
[uqr]: https://github.com/unjs/uqr
[lean-qr]: https://github.com/davidje13/lean-qr
[jsqr]: https://github.com/cozmo/jsQR
[zxing-wasm]: https://github.com/Sec-ant/zxing-wasm
[@zxing/library]: https://github.com/zxing-js/library
[zbar-wasm]: https://github.com/undecaf/zbar-wasm
[instascan]: https://github.com/schmich/instascan

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
