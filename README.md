# paulmillr-qr

Minimal node.js & browser QR Code Pattern reader and generator.

- 0-dependency
- Creating is ~1000 lines, single file. Supports ASCII, term, gif and svg formats
- Reading is ~800 additional lines in a separate file. Supports camera feed and files
- Ability to read QR in non-browser environments
- Extensive tests: cross-testing against 100MB+ of codes
- ESM support

Other JS libraries:

- Don't work: [jsQR](https://github.com/cozmo/jsQR) is dead, [zxing-js](https://github.com/zxing-js/) is [dead](https://github.com/zxing-js/library/commit/b797504c25454db32aa2db410e6502b6db12a401), [qr-scanner](https://github.com/nimiq/qr-scanner/) uses jsQR, doesn't work outside of browser, [qcode-decoder](https://github.com/cirocosta/qcode-decoder) broken version of jsQR, doesn't work outside of browser
- Uncool: [instascan](https://github.com/schmich/instascan) is 1MB+ (zxing compiled to js via emscripten), [qrcode](https://github.com/nuintun/qrcode) modern refactor of jsQR (138 stars)

Interactive demo is available at https://paulmillr.github.io/qr/.

## Usage

Use NPM in node.js / browser:

> npm install @paulmillr/qr

```ts
import writeQR from '@paulmillr/qr';
const gifBytes = writeQR('Hello world', 'gif');

import readQR from '@paulmillr/qr/decode';
const decoded = readQR({ height: 120, width: 120, data: gifBytes });

console.log(writeQR('Hello world', 'ascii'));
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

Options:

```ts
type QrOpts = {
  ecc?: 'low', 'medium', 'quartile', 'high'; // Default: 'medium'. Low: 7%, medium: 15%, quartile: 25%, high: 30%
  encoding?: 'numeric', 'alphanumeric', 'byte', 'kanji', 'eci'; // Force specific encoding. Kanji and ECI are not supported yet
  version?: number; // 1..40, QR code version
  mask?: number; // 0..7, mask number
  border?: number; // Border size, default 2.
  scale?: number; // Scale to this number. Scale=2 -> each block will be 2x2 pixels
}
// - `raw`: 2d boolean array, to use with canvas or other image drawing libraries
// - `ascii`: ASCII symbols, not all fonts will display it properly
// - `term`: terminal color escape sequences. 2x bigger than ASCII, but works with all fonts
// - `gif`: uncompressed gif
// - `svg`: SVG vector image
type Output = 'raw' | 'ascii' | 'term' | 'gif' | 'svg';
function generateQR(text: string, output: 'raw', opts?: QrOpts): boolean[][];
function generateQR(text: string, output: 'ascii' | 'term' | 'svg', opts?: QrOpts): string;
function generateQR(text: string, output: 'gif', opts?: QrOpts): Uint8Array;
```

## Decoding

QR decoding is hard: it is basically computer vision problem. There are two main cases:

- decoding files. Can be slow, because it is supposed to handle complicated cases such as blur / rotation
- decoding camera feed. Must be fast; even if one frame fails, next frame can succeed

State-of-the-art is the same as other computer vision problems: neural networks.
Using them would make the library hard to audit. Since JS can't access accelerators, it would also likely be very slow.
We don't want to use WebGL, it is complex and exposes users to fingerprinting.
The implemented reader algorithm is inspired by [ZXing](https://github.com/zxing/zxing):

1. `toBitmap`: convert to bitmap, black & white segments. The slowest part and the most important.
2. `detect`: find 3 finder patterns and one alignment (for version > 1).
  This is tricky — they can be rotated and distorted by perspective.
  Square is not really square — it's quadrilateral, and we have no idea about its size.
  The best thing we can do is counting runs of a same color and
  selecting one which looks like pattern; same almost same ratio of runs.
3. `transform`: once patterns have been found, try to fix perspective and transform quadrilateral to square
4. `decodeBitmap`: after that, execute encoding in reverse:
  read information via zig-zag pattern, interleave bytes, correct errors,
  convert to bits and, finally, read segments from bits to create string.
5. Finished

### API

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
export default function decode(img: Image, opts: DecodeOpts = {});
```

### Vectors

To test decoding, we use awesome dataset from [BoofCV](http://boofcv.org/index.php?title=Performance:QrCode).
BoofCV decodes 73% of test cases, zxing decodes 49%. We are almost at parity with zxing (mostly because of ECI stuff not supported).
Vectors are preserved in a git repo at [github.com/paulmillr/qr-code-vectors](https://github.com/paulmillr/qr-code-vectors).

For testing: accessing camera on iOS Safari requries HTTPS. It means `file:` protocol or non-encrypted `http` can't be used.

The spec is available at [iso.org](https://www.iso.org/standard/62021.html) for 200 CHF.

## Security

There are multiple ways how single text can be encoded:

- Differences in segmentation: `abc123` can become `[{type: 'alphanum', 'abc'}, {type: 'num', '123'}]`, `[{type: 'alphanum', 'abc123'}]`
- Differences between mask selection algo in libraries
- Defaults: error correction level, how many bits are stored before upgrading versions

If an adversary is able to access multiple generated QR codes from a specific library, they can
fingerprint a user, which can be then used to exfiltrate data from air-gapped systems.
Adversary would then need to create library-specific exploit.

Currently we cross-test against python-qrcode: it is closer to spec than js implementations.
We also always use single segment, which is not too optimal, but reduces fingerprinting data.

To improve the behavior, we can cross-test against 3-4 popular libraries.

## Speed

Benchmarks measured with Apple M2 on MacOS 13 with node.js 19.

```
======== encode/ascii ========
encode/noble x 1,794 ops/sec @ 557μs/op
encode/qrcode-generator x 3,128 ops/sec @ 319μs/op ± 1.12% (min: 293μs, max: 3ms)
encode/nuintun x 1,872 ops/sec @ 533μs/op
======== encode/gif ========
encode/noble x 1,771 ops/sec @ 564μs/op
encode/qrcode-generator x 1,773 ops/sec @ 563μs/op
encode/nuintun x 1,883 ops/sec @ 530μs/op
======== encode: big ========
encode/noble x 87 ops/sec @ 11ms/op
encode/qrcode-generator x 124 ops/sec @ 8ms/op
encode/nuintun x 143 ops/sec @ 6ms/op
======== decode ========
decode/noble x 96 ops/sec @ 10ms/op ± 1.39% (min: 9ms, max: 32ms)
decode/jsqr x 34 ops/sec @ 28ms/op
decode/nuintun x 35 ops/sec @ 28ms/op
decode/instascan x 79 ops/sec @ 12ms/op ± 6.73% (min: 9ms, max: 223ms)
======== Decoding quality ========
blurred(45):  noble=12 (26.66%) jsqr=13 (28.88%) nuintun=13 (28.88%) instascan=11 (24.44%)
```

## License

Copyright (c) 2023 Paul Miller (paulmillr.com)

Copyright (c) 2019 ZXing authors

The library @paulmillr/qr is dual-licensed under the Apache 2.0 OR MIT license.
You can select a license of your choice.

The library contains code inspired by [ZXing](https://github.com/zxing/zxing), which is licensed under Apache 2.0.

The license to the use of the QR Code stipulated by JIS (Japanese Industrial Standards) and the ISO are not necessary.
The specification for QR Code has been made available for use by any person or organization. (Obtaining QR Code Specification)
The word “QR Code” is registered trademark of DENSO WAVE INCORPORATED in Japan and other countries.
To use the word “QR Code” in your publications or web site, etc, please indicate a sentence QR Code is registered trademark of DENSO WAVE INCORPORATED.
This registered trademark applies only for the word “QR Code”, and not for the QR Code pattern (image).
(https://www.qrcode.com/en/faq.html)
