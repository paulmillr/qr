import { should } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import { GifReader } from 'omggif';
import encodeQR, { _tests } from '../src/index.ts';
const { Bitmap } = _tests;

const strip = (str) => str.replace(/^\n+/g, '').replace(/\n+$/g, '');
const verifyDebug = (b, val, msg) => deepStrictEqual(strip(b.toString()), strip(val), msg);

should('Basic', () => {
  const b = new Bitmap({ height: 4, width: 5 });
  verifyDebug(
    b,
    `
?????
?????
?????
?????`,
    'dimensions'
  );
  // Draw small rect
  b.rect({ x: 0, y: 0 }, { height: 3, width: 4 }, true);
  verifyDebug(
    b,
    `
XXXX?
XXXX?
XXXX?
?????
`,
    'rect'
  );
  // Clone
  verifyDebug(
    b.clone(),
    `
XXXX?
XXXX?
XXXX?
?????
`,
    'clone'
  );
  // Use function as value
  b.rect({ x: 0, y: 0 }, { height: 4, width: 4 }, ({ x, y }) => x & 1 || y & 1);
  verifyDebug(
    b,
    `
 X X?
XXXX?
 X X?
XXXX?`,
    'rect fn'
  );
  // Clean && check that overflow is handled correctly
  b.rect({ x: 0, y: 0 }, { height: 10, width: 10 }, false);
  verifyDebug(
    b,
    `
     
     
     
     `,
    'rect overflow'
  );
  // Negative positions (2x2 box in bottom-right corner)
  b.rect({ x: -2, y: -2 }, { height: 2, width: 2 }, true);
  verifyDebug(
    b,
    `
     
     
   XX
   XX`,
    'rect negative'
  );
  // Odd rows
  b.rect({ x: 0, y: 0 }, { height: 10, width: 10 }, ({ x, y }) => y & 1);
  verifyDebug(
    b,
    `
     
XXXXX
     
XXXXX`,
    'rect odd'
  );
  // Inverse
  verifyDebug(
    b.transpose(),
    `
 X X
 X X
 X X
 X X
 X X`,
    'rect odd inverse'
  );
  // Diagonal
  b.rect({ x: 0, y: 0 }, { height: Infinity, width: Infinity }, ({ x, y }) => x === y);
  verifyDebug(
    b,
    `
X    
 X   
  X  
   X `,
    'rect diagonal'
  );
  verifyDebug(
    b.transpose(),
    `
X   
 X  
  X 
   X
    `,
    'rect diagonal inverse'
  );
});

should('Bitmap rejects zero dimensions', () => {
  throws(
    () => new Bitmap(0),
    new Error('Bitmap: invalid height=0, expected positive safe integer dimension')
  );
  throws(
    () => new Bitmap({ height: 0, width: 1 }),
    new Error('Bitmap: invalid height=0, expected positive safe integer dimension')
  );
  throws(
    () => new Bitmap({ height: 1, width: 0 }),
    new Error('Bitmap: invalid width=0, expected positive safe integer dimension')
  );
  throws(
    () => Bitmap.fromString(''),
    new Error('Bitmap: invalid width=0, expected positive safe integer dimension')
  );
});

should('Bitmap rejects non-positive and unsafe dimensions', () => {
  throws(
    () => new Bitmap({ height: 1, width: -1 }),
    new Error('Bitmap: invalid width=-1, expected positive safe integer dimension')
  );
  throws(
    () => new Bitmap({ height: -1, width: 1 }),
    new Error('Bitmap: invalid height=-1, expected positive safe integer dimension')
  );
  throws(
    () => new Bitmap(Infinity),
    new Error('Bitmap: invalid height=Infinity, expected positive safe integer dimension')
  );
  throws(
    () => new Bitmap({ height: 1, width: Infinity }),
    new Error('Bitmap: invalid width=Infinity, expected positive safe integer dimension')
  );
  throws(
    () => new Bitmap({ height: Infinity, width: 1 }),
    new Error('Bitmap: invalid height=Infinity, expected positive safe integer dimension')
  );
  throws(
    () => new Bitmap({ height: 1, width: NaN }),
    new Error('Bitmap: invalid width=NaN (number)')
  );
  throws(
    () => new Bitmap({ height: NaN, width: 1 }),
    new Error('Bitmap: invalid height=NaN (number)')
  );
  throws(
    () => new Bitmap({ height: 1, width: 1.5 }),
    new Error('Bitmap: invalid width=1.5 (number)')
  );
  throws(
    () => new Bitmap({ height: 1.5, width: 1 }),
    new Error('Bitmap: invalid height=1.5 (number)')
  );
  throws(
    () => new Bitmap({ height: 1, width: Number.MAX_SAFE_INTEGER + 1 }),
    new Error('Bitmap: invalid width=9007199254740992 (number)')
  );
  throws(
    () => new Bitmap({ height: Number.MAX_SAFE_INTEGER + 1, width: 1 }),
    new Error('Bitmap: invalid height=9007199254740992 (number)')
  );
});

should('Bitmap.border rejects non-positive and unsafe sizes', () => {
  const b = new Bitmap({ height: 2, width: 2 });
  throws(() => b.border(0, false), new Error('Bitmap.border: invalid size=0'));
  throws(() => b.border(-1, false), new Error('Bitmap.border: invalid size=-1'));
  throws(() => b.border(0.5, false), new Error('Bitmap.border: invalid size=0.5'));
  throws(() => b.border(NaN, false), new Error('Bitmap.border: invalid size=NaN'));
  throws(() => b.border(Infinity, false), new Error('Bitmap.border: invalid size=Infinity'));
});

should('Bitmap.countPatternInRow validates scan inputs', () => {
  const b = new Bitmap({ height: 1, width: 4 }, [[false, false, false, false]]);
  deepStrictEqual(
    {
      valid: b.countPatternInRow(0, 2, 0),
      negativeRow: b.countPatternInRow(-1, 2, 0),
      pastEndRow: b.countPatternInRow(1, 2, 0),
      fractionalRow: b.countPatternInRow(0.5, 2, 0),
      nanRow: b.countPatternInRow(NaN, 2, 0),
    },
    { valid: 3, negativeRow: 0, pastEndRow: 0, fractionalRow: 0, nanRow: 0 }
  );
  throws(() => b.countPatternInRow(0, 1.5, 0), new Error('wrong patternLen'));
  throws(() => b.countPatternInRow(0, NaN, 0), new Error('wrong patternLen'));
});

should('Bitmap.getRuns validates row input', () => {
  const b = new Bitmap({ height: 2, width: 6 }, [
    [false, false, true, true, true, false],
    [true, false, true, false, false, false],
  ]);
  const runs = (y) => {
    const out = [];
    b.getRuns(y, (len, value) => out.push([len, value]));
    return out;
  };
  deepStrictEqual(
    {
      validFirst: runs(0),
      validSecond: runs(1),
      negativeRow: runs(-1),
      pastEndRow: runs(2),
      fractionalRow: runs(0.5),
      nanRow: runs(NaN),
    },
    {
      validFirst: [
        [2, false],
        [3, true],
        [1, false],
      ],
      validSecond: [
        [1, true],
        [1, false],
        [1, true],
        [3, false],
      ],
      negativeRow: [],
      pastEndRow: [],
      fractionalRow: [],
      nanRow: [],
    }
  );
});

should('Bitmap.countBoxes2x2 validates row input', () => {
  const b = new Bitmap({ height: 3, width: 4 }, [
    [true, true, true, true],
    [true, true, false, false],
    [false, false, false, false],
  ]);
  deepStrictEqual(
    {
      validFirst: b.countBoxes2x2(0),
      validSecond: b.countBoxes2x2(1),
      negativeRow: b.countBoxes2x2(-1),
      pastEndRow: b.countBoxes2x2(2),
      negativeFractional: b.countBoxes2x2(-0.5),
      positiveFractional: b.countBoxes2x2(0.5),
      nanRow: b.countBoxes2x2(NaN),
    },
    {
      validFirst: 1,
      validSecond: 1,
      negativeRow: 0,
      pastEndRow: 0,
      negativeFractional: 0,
      positiveFractional: 0,
      nanRow: 0,
    }
  );
});

should('Square size/coordinates', () => {
  const b = new Bitmap(5);
  verifyDebug(
    b,
    `
?????
?????
?????
?????
?????`,
    'dimensions'
  );
  // Draw small rect
  b.rect(1, 3, true);
  verifyDebug(
    b,
    `
?????
?XXX?
?XXX?
?XXX?
?????
`,
    'rect'
  );
});

should('toASCII', () => {
  // Finder pattern
  const b = new Bitmap(3).rect(0, 3, true).border(1, false).border(1, true);
  verifyDebug(
    b,
    `
XXXXXXX
X     X
X XXX X
X XXX X
X XXX X
X     X
XXXXXXX`,
    'basic finder'
  );
  // console.log(b.toASCII());
  const ascii = strip(`
 ▄▄▄▄▄ 
 █   █ 
 █▄▄▄█ 
       `);
  deepStrictEqual(strip(b.toASCII()), ascii, 'ascii');
});

should('rectSlice', () => {
  // Finder pattern
  const b = new Bitmap(3).rect(0, 3, true).border(1, false).border(1, true);
  verifyDebug(
    b,
    `
XXXXXXX
X     X
X XXX X
X XXX X
X XXX X
X     X
XXXXXXX`,
    'basic finder, before'
  );
  verifyDebug(
    b.rectSlice(1),
    `
     X
 XXX X
 XXX X
 XXX X
     X
XXXXXX`,
    'slice(1)'
  );
  verifyDebug(
    b.rectSlice(0, 6),
    `
XXXXXX
X     
X XXX 
X XXX 
X XXX 
X     `,
    'slice(0, 6)'
  );

  verifyDebug(
    b,
    `
XXXXXXX
X     X
X XXX X
X XXX X
X XXX X
X     X
XXXXXXX`,
    'basic finder, after'
  );
});

should('Embed', () => {
  let b = new Bitmap(21).rect(0, Infinity, true);
  // Timing patterns
  b = b
    .hLine({ x: 0, y: 6 }, Infinity, ({ x, y }) => x % 2 == 0)
    .vLine({ x: 6, y: 0 }, Infinity, ({ x, y }) => y % 2 == 0);

  const finder = new Bitmap(3).rect(0, 3, true).border(1, false).border(1, true).border(1, false);
  b = b
    .embed(0, finder.rectSlice(1)) // top left
    .embed({ x: -(finder.width - 1), y: 0 }, finder.rectSlice({ x: 0, y: 1 })) // top right
    .embed({ x: 0, y: -(finder.height - 1) }, finder.rectSlice({ x: 1, y: 0 })); // bottom left

  b = b.border(2);
  // console.log(b.toASCII());
  const exp = strip(`
█████████████████████████
██ ▄▄▄▄▄ █     █ ▄▄▄▄▄ ██
██ █   █ █     █ █   █ ██
██ █▄▄▄█ █     █ █▄▄▄█ ██
██▄▄▄▄▄▄▄█ ▀ ▀ █▄▄▄▄▄▄▄██
██      ▄              ██
██      ▄              ██
██▄▄▄▄▄▄▄▄             ██
██ ▄▄▄▄▄ █             ██
██ █   █ █             ██
██ █▄▄▄█ █             ██
██▄▄▄▄▄▄▄█▄▄▄▄▄▄▄▄▄▄▄▄▄██
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀`);
  deepStrictEqual(strip(b.toASCII()), exp);
});

should('Scale', () => {
  let b = new Bitmap(11);
  // Draw cross
  b.rect(
    0,
    Infinity,
    ({ x, y }) => Math.abs(x) === Math.abs(y) || Math.abs(b.width - x - 1) === Math.abs(y)
  );
  const cross = strip(`
X         X
 X       X 
  X     X  
   X   X   
    X X    
     X     
    X X    
   X   X   
  X     X  
 X       X 
X         X`);
  deepStrictEqual(b.toString(), cross);
  // console.log(b.toASCII());
  b = b.scale(3);
  const crossScaled = strip(`
XXX                           XXX
XXX                           XXX
XXX                           XXX
   XXX                     XXX   
   XXX                     XXX   
   XXX                     XXX   
      XXX               XXX      
      XXX               XXX      
      XXX               XXX      
         XXX         XXX         
         XXX         XXX         
         XXX         XXX         
            XXX   XXX            
            XXX   XXX            
            XXX   XXX            
               XXX               
               XXX               
               XXX               
            XXX   XXX            
            XXX   XXX            
            XXX   XXX            
         XXX         XXX         
         XXX         XXX         
         XXX         XXX         
      XXX               XXX      
      XXX               XXX      
      XXX               XXX      
   XXX                     XXX   
   XXX                     XXX   
   XXX                     XXX   
XXX                           XXX
XXX                           XXX
XXX                           XXX`);
  deepStrictEqual(b.toString(), crossScaled);
});

function GIFtoBitmap(gif) {
  const r = new GifReader(gif);
  const p = [];
  r.decodeAndBlitFrameRGBA(0, p);
  let i = 0;
  const info = r.frameInfo(0);
  const res = [];
  for (let y = 0; y < info.height; y++) {
    const row = [];
    for (let x = 0; x < info.width; x++) {
      const [r, g, b, a] = [p[i++], p[i++], p[i++], p[i++]];
      let val = false;
      if (r === 0 && g === 0 && b === 0 && a === 255) val = true;
      else if (r === 255 && g === 255 && b === 255 && a === 255) val = false;
      else throw new Error('Unknown color');
      row.push(val);
    }
    res.push(row);
  }
  return res;
}
/*
What's the best way to test exporting to SVG/GIF/PNG? We can do:

    img.src = "data:image/svg+xml;base64,"+btoa(svgContent);
    context.drawImage(img, 0, 0, width, height);

However, this requires browser with canvas, and ESM modules are broken.
Meaning, we can't load local html file as with micro-fetch tests,
need web server or other complex tools for testing :(
*/
should('GIF encode', () => {
  for (let scale = 1; scale < 8; scale++) {
    for (let ver = 1; ver <= 40; ver++) {
      const q = encodeQR('hello world?', 'gif', { version: ver, scale: scale });
      const raw = encodeQR('hello world?', 'raw', { version: ver, scale: scale });
      deepStrictEqual(GIFtoBitmap(q), raw);
    }
  }
});

should.runWhen(import.meta.url);
