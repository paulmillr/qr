# paulmillr-qr

Minimal 0-dep QR code generator & reader.

- 🔒 Auditable, 0-dependency
- 🏞️ Encoding (generating) supports ASCII, term, gif and svg codes
- 📷 Decoding (reading) supports camera feed input, files and non-browser environments
- 🔍 Extensive tests ensure correctness: 100MB+ of vectors
- 🪶 35KB for encoding + decoding, 18KB for encoding (1000 lines of code)

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

// import decodeQR from 'qr/decode';
// See separate README section for decoding.

const txt = 'Hello world';
const ascii = encodeQR(txt, 'ascii'); // Not all fonts are supported
const terminalFriendly = encodeQR(txt, 'term'); // 2x larger, all fonts are OK
const gifBytes = encodeQR(txt, 'gif'); // Uncompressed GIF
const svgElement = encodeQR(txt, 'svg'); // SVG vector image element
const array = encodeQR(txt, 'raw'); // 2d array for canvas or other libs

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
//   version?: number; // 1..40, QR code version
//   mask?: number; // 0..7, mask number
//   border?: number; // Border size, default 2.
//   scale?: number; // Scale to this number. Scale=2 -> each block will be 2x2 pixels
// };

console.log(ascii);
> █████████████████████████████████████
> ██ ▄▄▄▄▄ █  ▀▄▄█ ██▀▄▄▄▄█ ▀█ ▄▄▄▄▄ ██
> ██ █   █ █▀▄▀▄ ▄▄█▄█ ██▀█▀▀█ █   █ ██
> ██ █▄▄▄█ ██ ▄▄█▄▀▀ ▀ ██ ▄ ▄█ █▄▄▄█ ██
> ██▄▄▄▄▄▄▄█ ▀ ▀ █▄▀ ▀ ▀▄█ █ █▄▄▄▄▄▄▄██
> ██ █  ▀ ▄▄▀▀▀ █▀ ▄   ▀▀▄▀ ▄█ ▀█ ▀▄▄██
> ██▀▀▀  ▀▄▄██▄▀▀▄█▀ ▀▄█    ▀▀▀ ▄ █▄▄██
> █████▄▀▀▄▄██ ▀ ▀ ▄▄██▄ ▄▄ ▄ █▀█ █ ███
> ███   ▄▀▄█▄▄▄█   ▀██▄▄▄▀▀█▄▀ ▄█▀ ████
> ██▀▀ ▄ ▀▄ ▄▄██▀▄▀▀████▄▄▄ █▄ █  █▀▀██
> ██▀▀▄ ▄▀▄ ▀▀█▄▀▀▄▄▀▀ █▄▄▀█▀ ▀▄ █▄ ▀██
> ██▀▄▀██ ▄▄ ▀█▄█▀ ▀ ▀█▄▀▀ █▄▀▀ █  █ ██
> ███▀█▄▀▄▄ █  █ ██ ██ ▄ █ ▄▄▄ ▄▀▀▄▄ ██
> ██▄█▄▄▄█▄█ ▄ ▄▀█▀▀ ▄▀ █▀ ▄ ▄▄▄ ▀▄▀▄██
> ██ ▄▄▄▄▄ █ ▄█▄▀▀ ▀█   █▄█  █▄█ ▀▀▄▀██
> ██ █   █ █▀ ▄▀█ ██ ▄▄▀██   ▄▄ ▄█   ██
> ██ █▄▄▄█ █▄  ██▀ ▄▄ ▀█ ▄      ▀▄▄█▀██
> ██▄▄▄▄▄▄▄█▄███▄█▄█▄▄▄▄█▄█▄████▄▄█████
> ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

## Decoding

GIF reader is not included in the package (it would take a lot of space).
Decoding raw bitmap is still possible.

```js
import encodeQR from 'qr';
import decodeQR from 'qr/decode';
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

// c) draw gif/svg to browser DOM canvas
import { svgToPng } from 'qr/dom';
const png = svgToPng(encodeQR('Hello world', 'svg'), 512, 512);
```

### Decoding options

```ts
export type Point4 = { x: number; y: number }[];
export type Image = {
  height: number;
  width: number;
  data: Uint8Array | Uint8ClampedArray | number[];
};
export type DecodeOpts = {
  // By default we assume that image has 4 channel per pixel (RGBA). isRGB: true will force to use only one
  isRGB?: boolean;
  // Returns 4 center (3 finder pattern + 1 alignment pattern) points if detected
  detectFn?: (points: Point4) => void;
  // Returns RGBA image of detected QR code
  qrFn?: (img: Image) => void;
};
export default function decodeQR(img: Image, opts: DecodeOpts = {});
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
@JsModule("@paulmillr/qr")
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

Benchmarks measured with Apple M2 on MacOS 13 with node.js 19.

```
======== encode/ascii ========
encode/paulmillr-qr x 1,794 ops/sec @ 557μs/op
encode/qrcode-generator x 3,128 ops/sec @ 319μs/op ± 1.12% (min: 293μs, max: 3ms)
encode/nuintun x 1,872 ops/sec @ 533μs/op
======== encode/gif ========
encode/paulmillr-qr x 1,771 ops/sec @ 564μs/op
encode/qrcode-generator x 1,773 ops/sec @ 563μs/op
encode/nuintun x 1,883 ops/sec @ 530μs/op
======== encode: big ========
encode/paulmillr-qr x 87 ops/sec @ 11ms/op
encode/qrcode-generator x 124 ops/sec @ 8ms/op
encode/nuintun x 143 ops/sec @ 6ms/op
======== decode ========
decode/paulmillr-qr x 96 ops/sec @ 10ms/op ± 1.39% (min: 9ms, max: 32ms)
decode/jsqr x 34 ops/sec @ 28ms/op
decode/nuintun x 35 ops/sec @ 28ms/op
decode/instascan x 79 ops/sec @ 12ms/op ± 6.73% (min: 9ms, max: 223ms)
======== Decoding quality ========
blurred(45):  paulmillr-qr=12 (26.66%) jsqr=13 (28.88%) nuintun=13 (28.88%) instascan=11 (24.44%)
```

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
