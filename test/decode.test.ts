import { should } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual } from 'node:assert';
import { readdirSync, statSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import readQR, { _tests } from '../src/decode.ts';
import { DETECTION_PATH, readJPEG } from './utils.ts';

function parseCoordinates(c) {
  const qrSize = 4 * 2;
  if (c.length % qrSize) throw new Error('WUT?', c.length);
  const res = [];
  for (let i = 0; i < c.length; i += qrSize) {
    res.push([
      { x: c[i], y: c[i + 1] },
      { x: c[i + 2], y: c[i + 3] },
      { x: c[i + 4], y: c[i + 5] },
      { x: c[i + 6], y: c[i + 7] },
    ]);
  }
  return res;
}

should('parseCoordinates', () => {
  deepStrictEqual(
    parseCoordinates([
      369, 998, 941, 995, 971, 1532, 428, 1549, 1280, 1799, 1297, 1527, 1576, 1539, 1556, 1815,
      1441, 1298, 1446, 1046, 1689, 1052, 1684, 1301,
    ]),
    [
      [
        { x: 369, y: 998 },
        { x: 941, y: 995 },
        { x: 971, y: 1532 },
        { x: 428, y: 1549 },
      ],
      [
        { x: 1280, y: 1799 },
        { x: 1297, y: 1527 },
        { x: 1576, y: 1539 },
        { x: 1556, y: 1815 },
      ],
      [
        { x: 1441, y: 1298 },
        { x: 1446, y: 1046 },
        { x: 1689, y: 1052 },
        { x: 1684, y: 1301 },
      ],
    ]
  );
});

should('FindFinder', () => {
  const bmp = _tests.toBitmap(readJPEG('detection/blurred/image007.jpg'));
  const finder = _tests.findFinder(bmp);
  deepStrictEqual(finder, {
    bl: { x: 357.5, y: 659.5, moduleSize: 5.142857142857143, count: 2 },
    tl: { x: 361, y: 551.5, moduleSize: 5.42857142857143, count: 6 },
    tr: { x: 482, y: 559, moduleSize: 5.571428571428571, count: 2 },
  });
});

should('Detector', () => {
  const bmp = _tests.toBitmap(readJPEG('detection/blurred/image007.jpg'));
  const { bits, points } = _tests.detect(bmp);
  // console.log(bits.toASCII());
  const ascii = `
 ▄▄▄▄▄ █▀▄█▀ █▀ ▀▀ ▄▀█ ▄▄▄▄▄ 
 █   █ █▄   ▄█ ██▄▀▄██ █   █ 
 █▄▄▄█ █ ▀█▀█▄   ▄█▀▀█ █▄▄▄█ 
▄▄▄▄▄▄▄█ ▀▄█ █▄█ ▀ ▀ █▄▄▄▄▄▄▄
  █▄▀▀▄ ██ ▀█ ▄▀ █▄▄▀█ ▄▄▀▄▄▀
█▄▀▄ ▄▄▄ ▄▄██ ▄▀ ▄█▄██▀▀▀▄  █
▄▀█▄▄▄▄█▄▀▀▀ ▄▀█▄ █  ▄▄▀█▄█▄▄
 ▀▀▄▄█▄▄ █▄█ ▀▄▀▄▀ ▀ ▄▄██ ▄ ▄
 ▀▀▄ █▄▀ █▄▄▄▄▀▄▀ ██▄▄▀ █▀█▄▀
▀  ▄▀▀▄▄▄ ▀████▀▄ ▀██▀▄▄███  
█▄██▄█▄▄   ▄█▀▄▀▀██▄ ▄▄▄ █ ▀▀
 ▄▄▄▄▄ █▄█▄█  ▄█ █▀█ █▄█ ▀▀ ▀
 █   █ █▀ ▄▀▀█▀▄ ▄▄▀▄▄ ▄ ▀▀ █
 █▄▄▄█ █▀█▄▄▀ ▀██▀▀ ▀▄██ ▄▄▀▄
       ▀    ▀ ▀▀  ▀▀ ▀   ▀▀ ▀
`;
  deepStrictEqual(bits.toASCII(), ascii.replace('\n', ''));
  deepStrictEqual(points, [
    { x: 361, y: 551.5, moduleSize: 5.42857142857143, count: 6 },
    { x: 482, y: 559, moduleSize: 5.571428571428571, count: 2 },
    { x: 458, y: 652, moduleSize: 2.2857142857142856, count: 2 },
    { x: 357.5, y: 659.5, moduleSize: 5.142857142857143, count: 2 },
  ]);
});

should('Decode', () => {
  const f = 'detection/blurred/image007.jpg';
  const bmp = _tests.toBitmap(readJPEG(f));
  const { bits } = _tests.detect(bmp);
  const res = _tests.decodeBitmap(bits);
  deepStrictEqual(res, 'https://www.surveymonkey.com/s/TheClubatLAS_T3');
});

const listFiles = (path, isDir = false) =>
  readdirSync(path).filter((i) => statSync(`${path}/${i}`).isDirectory() === isDir);

const percent = (a, b) => `${((a / b) * 100).toFixed(2)}%`;

// for (const category of listFiles(DETECTION_PATH, true)) {
//   const DIR_PATH = `${DETECTION_PATH}/${category}`;
//   should(`Decoding/${category}`, () => {
//     for (const f of listFiles(DIR_PATH)) {
//       if (!f.endsWith('.jpg')) continue;
//       const p = `${DIR_PATH}/${f}`;
//       const EXCLUDE = [
//         'detection/blurred/image001.jpg',
//         'detection/blurred/image002.jpg',
//         'detection/blurred/image003.jpg',
//         'detection/blurred/image004.jpg',
//         'detection/blurred/image005.jpg',
//         'detection/blurred/image006.jpg',
//       ];
//       if (EXCLUDE.includes(p)) continue;
//       console.log('FILE', p);
//       const jpg = readJPEG(p);
//       const txt = fs
//         .readFileSync(p.replace('.jpg', '.txt'), 'utf8')
//         .split('\n')
//         .map((i) => i.trim())
//         .filter((i) => !i.startsWith('#') && !i.startsWith('SETS'))
//         .filter((i) => !!i)
//         .join(' ')
//         .split(' ')
//         .map((i) => +i >>> 0);
//       const coordinates = parseCoordinates(txt);
//       const bmp = _tests.toBitmap(jpg);
//       const { points } = _tests.detect(bmp);
//       // TODO: calculate intersection of detected patterns
//     }
//   });
// }

// How vectors were selected:
// 1. Parseable by zxing
// 2. When not parseable by zxing, but parseable by us, they were verified/added manually
const DECODED = {
  blurred: {
    'image007.jpg': ['https://www.surveymonkey.com/s/TheClubatLAS_T3'],
    'image011.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image012.jpg': ['http://g.augme.com/1803'],
    'image014.jpg': ['http://flydulles.com/survey'],
    'image018.jpg': ['Version 1 QR'],
    'image025.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image029.jpg': ['http://goo.gl/ErBxV'],
    'image030.jpg': ['http://goo.gl/ErBxV'],
    'image033.jpg': ['http://www.bestekmall.com/'],
    'image039.jpg': ['GH64-05708A'],
    'image041.jpg': ['GH69-28945C'],
    'image043.jpg': ['https://www.facebook.com/Lethmik/'],
    'image044.jpg': ['https://www.facebook.com/Lethmik/'],
  },
  bright_spots: {
    'image004.jpg': ['Version 1 QR', 'Version 2 QR Code Test Image'],
    'image007.jpg': ['Version 2 QR Code Test Image'],
    'image009.jpg': ['Version 1 QR'],
    'image011.jpg': ['Version 1 QR'],
    'image028.jpg': ['Version 2 QR Code Test Image'],
    'image029.jpg': ['Version 2 QR Code Test Image'],
  },
  brightness: {
    'image006.jpg': ['Version 2 QR Code Test Image'],
    'image007.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image009.jpg': ['Version 1 QR'],
    'image015.jpg': ['Version 1 QR'],
    'image016.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
      'Version 2 QR Code Test Image',
    ],
    'image017.jpg': ['Version 1 QR'],
    'image027.jpg': ['Version 2 QR Code Test Image'],
    'image028.jpg': ['Version 2 QR Code Test Image'],
  },
  close: {
    'image030.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image036.jpg': ['VERSION 2 8CM'],
  },
  curved: {
    'image008.jpg': ['http://albtsn.com/ugtezn8'],
    'image009.jpg': ['http://albtsn.com/ugtezn8'],
    'image015.jpg': ['hudson'],
    'image022.jpg': ['Test 03'],
    'image025.jpg': ['正宗铁观音茶叶 乐品乐茶 \nhttp://detail.tmall.com/item.htm?id=13996190738'],
    'image027.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image028.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image030.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image031.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image033.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image038.jpg': ['IPN:J68574-001 D/C:2017/10/13'],
    'image045.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image046.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image048.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image049.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image050.jpg': ['https://www.facebook.com/Lethmik/'],
  },
  damaged: {
    'image002.jpg': ['are', 'Enough'],
    'image003.jpg': ['kooTEK'],
    'image004.jpg': ['kooTEK'],
    'image019.jpg': ['PETERABELES041.PremierSubaruFremont.com'],
  },
  glare: {
    'image003.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image006.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image007.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image020.jpg': ['https://goo.gl/forms/ofwmcoJn1qN6HPb72'],
    'image022.jpg': ['https://goo.gl/forms/ofwmcoJn1qN6HPb72'],
    'image027.jpg': ['http://uqr.me/acgovdehvehicles'],
    'image029.jpg': ['https://goo.gl/forms/ofwmcoJn1qN6HPb72'],
    'image040.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image043.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image047.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image049.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
    'image050.jpg': [
      'http://www.youtube.com/watch?v=7qa6Bho4OyM&feature=share&list=PLk13TE2t32tgRCVo0q8tTB1CyZyMDQCNH&index=10',
    ],
  },
  high_version: {
    'image031.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\n\nThe Quick Response system became popular outside the automotive industry due to its fast readability and greater storage capacity compared to standard UPC barcodes. Applications include product tracking, item identification, time tracking, document management, and general marketing.[3]',
    ],
    'image032.jpg': [
      'QR code (abbreviated from Quick Response Code) is the trademark for a type of matrix barcode (or two-dimensional barcode) first designed in 1994 for the automotive industry in Japan.[1] A barcode is a machine-readable optical label that contains information about the item to which it is attached. In practice, QR codes often contain data for a locator, identifier, or tracker that points to a website or application. A QR code uses four standardized encoding modes (numeric, alphanumeric, byte/binary, and kanji) to store data efficiently; extensions may also be used.[2]\n\nThe Quick Response system became popular outside the automotive industry due to its fast readability and greater ',
    ],
  },
  lots: { 'image001.jpg': ['Test 03'], 'image005.jpg': ['are'] },
  monitor: {},
  nominal: {
    'image005.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"171227103636638907587520201AZ"}}'],
    'image006.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"171227103636638907587520201AZ"}}'],
    'image007.jpg': ['http://www.facebook.com/LangersJuice'],
    'image008.jpg': ['http://www.facebook.com/LangersJuice'],
    'image009.jpg': ['http://www.facebook.com/LangersJuice'],
    'image010.jpg': ['http://www.facebook.com/LangersJuice'],
    'image011.jpg': ['http://www.facebook.com/LangersJuice'],
    'image012.jpg': ['http://www.lonelyplanet.com/'],
    'image013.jpg': ['http://www.lonelyplanet.com/'],
    'image014.jpg': ['http://www.lonelyplanet.com/'],
    'image015.jpg': ['http://www.lonelyplanet.com/'],
    'image020.jpg': ['http://www.teagoetz.com/'],
    'image021.jpg': ['http://www.teagoetz.com/'],
    'image022.jpg': ['http://www.teagoetz.com/'],
    'image023.jpg': ['http://www.teagoetz.com/'],
    'image024.jpg': ['https://mobile-now.us/?l=10043659'],
    'image025.jpg': ['http://onramp.ehi.com/HYUN/ACNT/4SE/US/?v=KMHCT4AE3GU107709'],
    'image026.jpg': ['0555506635839349055557'],
    'image027.jpg': ['0555506635839349055557'],
    'image029.jpg': ['0555506635839349055557'],
    'image030.jpg': ['http://onramp.ehi.com/HYUN/ACNT/4SE/US/?v=KMHCT4AE3GU107709'],
    'image033.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image034.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image035.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image036.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image037.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image038.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image039.jpg': ['http://weixin.qq.com/r/FnUnPxnE2kSlrV1c9yAE'],
    'image040.jpg': ['https://www.instagram.com/lethmik/'],
    'image041.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image045.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image046.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image047.jpg': ['http://www.boschautoparts.com/qr/icon.aspx'],
    'image048.jpg': ['http://bit.ly/l5qo2F?r=qr'],
    'image049.jpg': ['65729741957'],
    'image051.jpg': ['http://goo.gl/ErBxV'],
    'image052.jpg': ['http://goo.gl/ErBxV'],
    'image053.jpg': ['http://goo.gl/ErBxV'],
    'image055.jpg': ['http://www.bestekmall.com/'],
    'image057.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"180410194824527404022960201AZ"}}'],
    'image060.jpg': ['http://www.bestekmall.com/'],
    'image061.jpg': ['{"lastNode":"OAK5","cids":{"pkey":"180410194824527404022960201AZ"}}'],
    'image062.jpg': [
      'http://www.postalexperience.com/pos?mt=4&sc=840-5940-0244-002-00006-80522-02',
    ],
    'image063.jpg': [
      'http://www.postalexperience.com/pos?mt=4&sc=840-5940-0244-002-00006-80522-02',
    ],
  },
  noncompliant: {},
  pathological: {},
  perspective: {
    'image001.jpg': ['TEST 10 CM'],
    'image002.jpg': ['TEST 10 CM'],
    'image003.jpg': ['TEST 10 CM'],
    'image004.jpg': ['TEST 10 CM'],
    'image005.jpg': ['TEST 10 CM'],
    'image006.jpg': ['TEST 10 CM'],
    'image007.jpg': ['TEST 10 CM'],
    'image017.jpg': ['TEST 10 CM'],
    'image018.jpg': ['TEST 10 CM'],
    'image019.jpg': ['TEST 10 CM'],
    'image020.jpg': ['TEST 10 CM'],
    'image021.jpg': ['TEST 10 CM'],
    'image022.jpg': ['TEST 10 CM'],
  },
  rotations: {
    'image002.jpg': ['Version 1 QR'],
    'image003.jpg': ['Version 1 QR'],
    'image004.jpg': ['Version 1 QR'],
    'image008.jpg': ['Version 2 QR Code Test Image'],
    'image009.jpg': ['Version 2 QR Code Test Image'],
    'image010.jpg': ['Version 2 QR Code Test Image'],
    'image011.jpg': ['Version 2 QR Code Test Image'],
    'image012.jpg': ['Version 1 QR'],
    'image015.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image016.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image017.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image018.jpg': [
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image019.jpg': [
      'Version 1 QR',
      'ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789 ABC 123456789',
    ],
    'image023.jpg': ['Version 2 QR Code Test Image'],
    'image024.jpg': ['Version 2 QR Code Test Image'],
    'image034.jpg': ['Version 2 QR Code Test Image'],
    'image039.jpg': ['Version 2 QR Code Test Image'],
    'image040.jpg': ['Version 2 QR Code Test Image'],
    'image044.jpg': ['Version 2 QR Code Test Image'],
  },
  shadows: {
    'image001.jpg': ['Version 1 QR'],
    'image003.jpg': ['Version 1 QR'],
    'image004.jpg': ['Version 2 QR Code Test Image'],
    'image007.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image008.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image009.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
    'image014.jpg': ['HTTPS://NUTS.COM/QR/retail_piece/51707477?sku=7030-01'],
  },
};

for (const category of listFiles(DETECTION_PATH, true)) {
  const DIR_PATH = `${DETECTION_PATH}/${category}`;
  should(`Decoding/${category}`, () => {
    let count = 0;
    let hadDecoded = 0;
    let currDecoded = 0;
    for (const f of listFiles(DIR_PATH)) {
      if (!f.endsWith('.jpg')) continue;
      const p = `detection/${category}/${f}`;
      const EXCLUDE = [
        'blurred/image025.jpg',
        'brightness/image006.jpg',
        'brightness/image007.jpg',
        'curved/image015.jpg',
        'curved/image022.jpg',
        'curved/image049.jpg',
        'glare/image050.jpg',
        'nominal/image015.jpg',
        'nominal/image020.jpg',
        'nominal/image021.jpg',
        'nominal/image022.jpg',
        'nominal/image023.jpg',
        'nominal/image055.jpg',
        'perspective/image001.jpg',
        'perspective/image002.jpg',
        'perspective/image003.jpg',
        'perspective/image004.jpg',
        'perspective/image005.jpg',
        'perspective/image006.jpg',
        'perspective/image007.jpg',
        'rotations/image017.jpg',
        'rotations/image018.jpg',
        'rotations/image023.jpg',
        'rotations/image040.jpg',
        'shadows/image007.jpg',
        'shadows/image008.jpg',
      ];
      if (EXCLUDE.some((end) => p.endsWith(end))) continue;
      count += 1;
      // Slow as hell, but at least doesn't force binary modules for nodejs in dev env
      const jpg = readJPEG(p);
      let decoded = DECODED[category][f];
      if (decoded !== undefined) hadDecoded++;
      // Skip files for which we don't have decoded information
      //if (decoded === undefined) continue;
      // console.log('Decoding', p.replace(DIR, ''));
      let res;
      try {
        res = readQR(jpg);
      } catch (e) {
        //console.log('TEST ERR', e);
      }
      if (res !== undefined) {
        // if (decoded === undefined) console.log('NEW DECODED', category, f, [res]);
        currDecoded++;
      }
      if (decoded !== undefined) {
        deepStrictEqual(decoded.includes(res), true, p);
        // try {
        //   deepStrictEqual(decoded.includes(res), true, p);
        // } catch (e) {
        //   console.log('FAILED', p);
        // }
      }
    }
    if (count === 0) return console.log('total: 0 for category', category);
    const p1 = percent(hadDecoded, count);
    const p2 = percent(currDecoded, count);
    const p3 = percent(currDecoded, hadDecoded);
    // console.log(
    //   `${category}
    //   total: ${count}
    //   decoded before: ${hadDecoded} (${p1} of total)
    //   decoded now: ${currDecoded} (${p2} of total, ${p3} of decoded before)`
    // );
  });
}
should('gh-28 (invert)', () => {
  const jpg = readJPEG(pjoin('..', 'issues', 'invert.jpg'));
  const res = readQR(jpg);
  deepStrictEqual(res, 'https://patreon.com/reactiive');
});

should('gh-28 (eci)', () => {
  // From: https://www.barcodefaq.com/2d/eci/
  const jpg = readJPEG(pjoin('..', 'issues', 'eci.jpg'));
  const res = readQR(jpg);
  deepStrictEqual(
    res,
    'Latin1\t®ÄËÖ¶|\rCyrillic\tфДШлЮЯЩ\rGreek\tΣAβΔΦΩ\rThai\tโก๛ณ๗ฟ\rShiftJIS\t｢ﾓﾄｽｦﾊﾋﾌﾍﾎﾏ｣\rArabic\tلخأضخک\rUTF-8\t條碼字體\rBig5\t圖常用字次\rLatin1End'
  );
});

// should.only('DEBUG', () => {
//   //const f = 'detection/high_version/image031.jpg';
//   const f = 'detection/high_version/image032.jpg';
//   const jpg = readJPEG(f);
//   const res = readQR(jpg);
//   console.log('DECODED', res);
// });

should.runWhen(import.meta.url);
