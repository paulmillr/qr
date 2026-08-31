# Changelog for qr

## 0.7.0 (2026-08-31)

- Decoder: new architecture, focusing on camera latency. 2x more accurate than previous version on BoofCV
- Decoder: with new `effort` / `timeLimit` knobs and a multi-format `_QRScanner`
- Encoder: speed-up 4-45x faster, reduce size by 30%
- Encoder: add data-url output
- Hardened for security, improved error messages and type checks

## 0.6.0 (2026-04-28)

- **April 2026 self-audit** (all files): no major issues found
  - Audited for spec compliance and security
  - Hardened all the small bits
- Fix all Byte Array types, to ensure proper work in both TypeScript 5.6 & TypeScript 5.9+
  - TS 5.6 has `Uint8Array`, while TS 5.9+ made it generic `Uint8Array<ArrayBuffer>`
  - This creates incompatibility of code between versions
  - Previously, it was hard to use and constantly emitted errors similar to `TS2345`
  - See [typescript#62240](https://github.com/microsoft/TypeScript/issues/62240) for more context
- Fix compilation issues on TypeScript v6
- Add detailed documentation everywhere

## 0.5.5 (2026-03-07)

- 4x speed-up in QR decoding (162 ops/sec @ 6ms/op => 662 ops/sec @ 1ms/op)
- Improve decoding reliability
- add `gifToPng` in DOM package by @imcotton in https://github.com/paulmillr/qr/pull/35

### New Contributors

- @imcotton made their first contribution in https://github.com/paulmillr/qr/pull/35

## 0.5.4 (2026-01-11)

- Add support for ECI encoding
- Add support for inverted QR codes
- Massive speed-up in QR generation (comparing versions 0.5.0 => 0.5.3 => 0.5.4):
  - format=ascii: 3105 => 5200 => now 9050 ops/sec
  - format=gif: 3002 => 4933 => now 8439 ops/sec
  - large qr: 147 => 249 => now 318 ops/sec

## 0.5.3 (2025-12-01)

- 70% speed-up in encode, thanks to refactor by @Pjb518 in https://github.com/paulmillr/qr/pull/32
- Add option to specify `textDecoder` by @voliva in https://github.com/paulmillr/qr/pull/30

### New Contributors

- @voliva made their first contribution in https://github.com/paulmillr/qr/pull/30
- @Pjb518 made their first contribution in https://github.com/paulmillr/qr/pull/32

## 0.5.2 (2025-09-18)

- Add back export maps for text editor autocompletion

## 0.5.1 (2025-08-20)

- Include `*.js.map` files in NPM package

### New Contributors

- @MangelMaxime made their first contribution in https://github.com/paulmillr/qr/pull/26

## 0.5.0 (2025-06-04)

- The package is now ESM-only. ESM modules can finally be loaded from common.js on node v20.19+
  - Reduces unpacked NPM package size from 363.4 kB to 232.3 kB
- Bump minimum TS compilation target from es2020 to es2022

## 0.4.2 (2025-04-25)

- Fixing buggy publish: 0.4.1 did not get to NPM.

## 0.4.1 (2025-04-25)

- perf(svg): optimize SVG output by @micah-yeager in https://github.com/paulmillr/qr/pull/19
- feat(svg): add option to export either optimized or unoptimized SVGs by @micah-yeager in https://github.com/paulmillr/qr/pull/20
- test(dom): add DOM utility testing by @micah-yeager in https://github.com/paulmillr/qr/pull/21

### New Contributors

- @micah-yeager made their first contribution in https://github.com/paulmillr/qr/pull/19

## 0.4.0 (2025-03-23)

- The package is now available as `qr` npm module!
- Make package friendly to erasable syntax in node.js v23+
- Improve types by @jxom in https://github.com/paulmillr/qr/pull/17

### New Contributors

- @jxom made their first contribution in https://github.com/paulmillr/qr/pull/17

## 0.3.0 (2024-11-22)

- Introduce hybrid package: commonjs-esm support
- Improve parser-friendliness

## 0.2.1 (2024-10-01)

- Include typescript types that were mistakenly excluded

## 0.2.0 (2024-06-16)

- Add DOM helpers in separate module `qr/dom.js`
- Decoding bugfixes
- Add single-file builds

## 0.1.1 (2023-05-01)

- Specify viewBox dimensions instead of physical by @ardislu in https://github.com/paulmillr/qr/pull/2
- Fix issue with non valid SVG shape `svg:rect` -> `rect` by @mvdschee in https://github.com/paulmillr/qr/pull/4

### New Contributors

- @ardislu made their first contribution in https://github.com/paulmillr/qr/pull/2
- @mvdschee made their first contribution in https://github.com/paulmillr/qr/pull/4

## 0.1.0 (2023-03-13)

- Initial release
