import { deepStrictEqual } from 'node:assert';
import { should } from 'micro-should';
import { GifReader } from 'omggif';
import encodeQR, { _tests } from '../esm/index.js';
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
    b.inverse(),
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
    b.inverse(),
    `
X   
 X  
  X 
   X
    `,
    'rect diagonal inverse'
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
