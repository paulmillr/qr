import { describe, should } from 'micro-should';
import { deepStrictEqual } from 'node:assert';
import { _tests } from '../esm/index.js';

const ALIGNMENT_PATTERN_POSITIONS = [
  [], // Version 1
  [6, 18], // Version 2
  [6, 22], // Version 3
  [6, 26], // Version 4
  [6, 30], // Version 5
  [6, 34], // Version 6
  [6, 22, 38], // Version 7
  [6, 24, 42], // Version 8
  [6, 26, 46], // Version 9
  [6, 28, 50], // Version 10
  [6, 30, 54], // Version 11
  [6, 32, 58], // Version 12
  [6, 34, 62], // Version 13
  [6, 26, 46, 66], // Version 14
  [6, 26, 48, 70], // Version 15
  [6, 26, 50, 74], // Version 16
  [6, 30, 54, 78], // Version 17
  [6, 30, 56, 82], // Version 18
  [6, 30, 58, 86], // Version 19
  [6, 34, 62, 90], // Version 20
  [6, 28, 50, 72, 94], // Version 21
  [6, 26, 50, 74, 98], // Version 22
  [6, 30, 54, 78, 102], // Version 23
  [6, 28, 54, 80, 106], // Version 24
  [6, 32, 58, 84, 110], // Version 25
  [6, 30, 58, 86, 114], // Version 26
  [6, 34, 62, 90, 118], // Version 27
  [6, 26, 50, 74, 98, 122], // Version 28
  [6, 30, 54, 78, 102, 126], // Version 29
  [6, 26, 52, 78, 104, 130], // Version 30
  [6, 30, 56, 82, 108, 134], // Version 31
  [6, 34, 60, 86, 112, 138], // Version 32
  [6, 30, 58, 86, 114, 142], // Version 33
  [6, 34, 62, 90, 118, 146], // Version 34
  [6, 30, 54, 78, 102, 126, 150], // Version 35
  [6, 24, 50, 76, 102, 128, 154], // Version 36
  [6, 28, 54, 80, 106, 132, 158], // Version 37
  [6, 32, 58, 84, 110, 136, 162], // Version 38
  [6, 26, 54, 82, 110, 138, 166], // Version 39
  [6, 30, 58, 86, 114, 142, 170], // Version 40
];

describe('utils', () => {
  should('Aligment patterns', () => {
    for (let ver = 1; ver <= 40; ver++) {
      deepStrictEqual(
        _tests.info.alignmentPatterns(ver),
        ALIGNMENT_PATTERN_POSITIONS[ver - 1],
        ver
      );
    }
  });

  should('sizeType', () => {
    const names = ['small', 'medium', 'large'];

    const exp = [];
    for (let i = 1; i <= 9; i++) exp.push('small'); // SMALL("version 1-9"),
    for (let i = 10; i <= 26; i++) exp.push('medium'); // MEDIUM("version 10-26"),
    for (let i = 27; i <= 40; i++) exp.push('large'); // LARGE("version 27-40"),

    const actual = [];
    for (let ver = 1; ver <= 40; ver++) {
      actual.push(names[_tests.info.sizeType(ver)]);
    }
    deepStrictEqual(actual, exp);
  });

  should('versionBits', () => {
    const VECTORS = {
      7: 0x07c94,
      8: 0x085bc,
      9: 0x09a99,
      10: 0x0a4d3,
      11: 0x0bbf6,
      12: 0x0c762,
      13: 0x0d847,
      14: 0x0e60d,
      15: 0x0f928,
      16: 0x10b78,
      17: 0x1145d,
      18: 0x12a17,
      19: 0x13532,
      20: 0x149a6,
      21: 0x15683,
      22: 0x168c9,
      23: 0x177ec,
      24: 0x18ec4,
      25: 0x191e1,
      26: 0x1afab,
      27: 0x1b08e,
      28: 0x1cc1a,
      29: 0x1d33f,
      30: 0x1ed75,
      31: 0x1f250,
      32: 0x209d5,
      33: 0x216f0,
      34: 0x228ba,
      35: 0x2379f,
      36: 0x24b0b,
      37: 0x2542e,
      38: 0x26a64,
      39: 0x27541,
      40: 0x28c69,
    };
    for (const ver in VECTORS) {
      deepStrictEqual(_tests.info.versionBits(ver), VECTORS[ver], ver);
    }
  });

  should('bitLimit', () => {
    const VECTORS = [
      { l: 152, m: 128, q: 104, h: 72 },
      { l: 272, m: 224, q: 176, h: 128 },
      { l: 440, m: 352, q: 272, h: 208 },
      { l: 640, m: 512, q: 384, h: 288 },
      { l: 864, m: 688, q: 496, h: 368 },
      { l: 1088, m: 864, q: 608, h: 480 },
      { l: 1248, m: 992, q: 704, h: 528 },
      { l: 1552, m: 1232, q: 880, h: 688 },
      { l: 1856, m: 1456, q: 1056, h: 800 },
      { l: 2192, m: 1728, q: 1232, h: 976 },
      { l: 2592, m: 2032, q: 1440, h: 1120 },
      { l: 2960, m: 2320, q: 1648, h: 1264 },
      { l: 3424, m: 2672, q: 1952, h: 1440 },
      { l: 3688, m: 2920, q: 2088, h: 1576 },
      { l: 4184, m: 3320, q: 2360, h: 1784 },
      { l: 4712, m: 3624, q: 2600, h: 2024 },
      { l: 5176, m: 4056, q: 2936, h: 2264 },
      { l: 5768, m: 4504, q: 3176, h: 2504 },
      { l: 6360, m: 5016, q: 3560, h: 2728 },
      { l: 6888, m: 5352, q: 3880, h: 3080 },
      { l: 7456, m: 5712, q: 4096, h: 3248 },
      { l: 8048, m: 6256, q: 4544, h: 3536 },
      { l: 8752, m: 6880, q: 4912, h: 3712 },
      { l: 9392, m: 7312, q: 5312, h: 4112 },
      { l: 10208, m: 8000, q: 5744, h: 4304 },
      { l: 10960, m: 8496, q: 6032, h: 4768 },
      { l: 11744, m: 9024, q: 6464, h: 5024 },
      { l: 12248, m: 9544, q: 6968, h: 5288 },
      { l: 13048, m: 10136, q: 7288, h: 5608 },
      { l: 13880, m: 10984, q: 7880, h: 5960 },
      { l: 14744, m: 11640, q: 8264, h: 6344 },
      { l: 15640, m: 12328, q: 8920, h: 6760 },
      { l: 16568, m: 13048, q: 9368, h: 7208 },
      { l: 17528, m: 13800, q: 9848, h: 7688 },
      { l: 18448, m: 14496, q: 10288, h: 7888 },
      { l: 19472, m: 15312, q: 10832, h: 8432 },
      { l: 20528, m: 15936, q: 11408, h: 8768 },
      { l: 21616, m: 16816, q: 12016, h: 9136 },
      { l: 22496, m: 17728, q: 12656, h: 9776 },
      { l: 23648, m: 18672, q: 13328, h: 10208 },
    ];
    for (let i = 0; i < VECTORS.length; i++) {
      const ver = i + 1;
      const v = VECTORS[i];

      for (const ecc of ['l', 'm', 'q', 'h']) {
        const eccName = { l: 'low', m: 'medium', q: 'quartile', h: 'high' }[ecc];
        deepStrictEqual(_tests.info.capacity(ver, eccName).capacity, v[ecc]);
      }
    }
  });

  describe('crosstest', () => {
    should('formatBits', () => {
      // NOTE: copy-paste from python qr-code, for verification only.
      // Remove, so we don't need to include license
      const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
      const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

      function BCH_digit(data) {
        let digit = 0;
        while (data != 0) {
          digit += 1;
          data >>>= 1;
        }
        return digit;
      }
      function BCH_type_info(data) {
        let d = data << 10;
        while (BCH_digit(d) - BCH_digit(G15) >= 0) {
          d ^= G15 << (BCH_digit(d) - BCH_digit(G15));
        }
        return ((data << 10) | d) ^ G15_MASK;
      }
      for (const ecc of ['low', 'medium', 'quartile', 'high'])
        for (let mask_pattern = 0; mask_pattern < 8; mask_pattern++) {
          const data = (_tests.info.ECCode[ecc] << 3) | mask_pattern;
          deepStrictEqual(_tests.info.formatBits(ecc, mask_pattern), BCH_type_info(data));
        }
    });

    should('versionBits', () => {
      var G18 =
        (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);

      function BCH_digit(data) {
        let digit = 0;
        while (data != 0) {
          digit += 1;
          data >>>= 1;
        }
        return digit;
      }

      function BCH_type_number(data) {
        let d = data << 12;
        while (BCH_digit(d) - BCH_digit(G18) >= 0) {
          d ^= G18 << (BCH_digit(d) - BCH_digit(G18));
        }
        return (data << 12) | d;
      }
      for (let ver = 1; ver <= 40; ver++) {
        deepStrictEqual(_tests.info.versionBits(ver), BCH_type_number(ver));
      }
    });
  });
});

should.runWhen(import.meta.url);
