'use strict';

/*!
Copyright (c) 2023 Paul Miller (paulmillr.com)
The library @paulmillr/qr is dual-licensed under the Apache 2.0 OR MIT license.
You can select a license of your choice.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
function assertNumber(n) {
    if (!Number.isSafeInteger(n))
        throw new Error(`Wrong integer: ${n}`);
}
function validateVersion$1(ver) {
    if (!Number.isSafeInteger(ver) || ver < 1 || ver > 40)
        throw new Error(`Invalid version=${ver}. Expected number [1..40]`);
}
function bin$1(dec, pad) {
    return dec.toString(2).padStart(pad, '0');
}
function mod(a, b) {
    const result = a % b;
    return result >= 0 ? result : b + result;
}
function fillArr$1(length, val) {
    return new Array(length).fill(val);
}
/**
 * Interleaves byte blocks.
 * @param blocks [[1, 2, 3], [4, 5, 6]]
 * @returns [1, 4, 2, 5, 3, 6]
 */
function interleaveBytes(...blocks) {
    let len = 0;
    for (const b of blocks)
        len = Math.max(len, b.length);
    const res = [];
    for (let i = 0; i < len; i++) {
        for (const b of blocks) {
            if (i >= b.length)
                continue; // outside of block, skip
            res.push(b[i]);
        }
    }
    return new Uint8Array(res);
}
// Optimize for minimal score/penalty
function best$1() {
    let best;
    let bestScore = Infinity;
    return {
        add(score, value) {
            if (score >= bestScore)
                return;
            best = value;
            bestScore = score;
        },
        get: () => best,
        score: () => bestScore,
    };
}
// Based on https://github.com/paulmillr/scure-base/blob/main/index.ts
function alphabet(alphabet) {
    return {
        has: (char) => alphabet.includes(char),
        decode: (input) => {
            if (!Array.isArray(input) || (input.length && typeof input[0] !== 'string'))
                throw new Error('alphabet.decode input should be array of strings');
            return input.map((letter) => {
                if (typeof letter !== 'string')
                    throw new Error(`alphabet.decode: not string element=${letter}`);
                const index = alphabet.indexOf(letter);
                if (index === -1)
                    throw new Error(`Unknown letter: "${letter}". Allowed: ${alphabet}`);
                return index;
            });
        },
        encode: (digits) => {
            if (!Array.isArray(digits) || (digits.length && typeof digits[0] !== 'number'))
                throw new Error('alphabet.encode input should be an array of numbers');
            return digits.map((i) => {
                assertNumber(i);
                if (i < 0 || i >= alphabet.length)
                    throw new Error(`Digit index outside alphabet: ${i} (alphabet: ${alphabet.length})`);
                return alphabet[i];
            });
        },
    };
}
class Bitmap {
    constructor(size, data) {
        const { height, width } = Bitmap.size(size);
        this.data = data || Array.from({ length: height }, () => fillArr$1(width, undefined));
        this.height = height;
        this.width = width;
    }
    static size(size, limit) {
        if (typeof size === 'number')
            size = { height: size, width: size };
        if (!Number.isSafeInteger(size.height) && size.height !== Infinity)
            throw new Error(`Bitmap: wrong height=${size.height} (${typeof size.height})`);
        if (!Number.isSafeInteger(size.width) && size.width !== Infinity)
            throw new Error(`Bitmap: wrong width=${size.width} (${typeof size.width})`);
        if (limit !== undefined) {
            // Clamp length, so it won't overflow, also allows to use Infinity, so we draw until end
            size = {
                width: Math.min(size.width, limit.width),
                height: Math.min(size.height, limit.height),
            };
        }
        return size;
    }
    static fromString(s) {
        // Remove linebreaks on start and end, so we draw in `` section
        s = s.replace(/^\n+/g, '').replace(/\n+$/g, '');
        const lines = s.split('\n');
        const height = lines.length;
        const data = new Array(height);
        let width;
        for (const line of lines) {
            const row = line.split('').map((i) => {
                if (i === 'X')
                    return true;
                if (i === ' ')
                    return false;
                if (i === '?')
                    return undefined;
                throw new Error(`Bitmap.fromString: unknown symbol=${i}`);
            });
            if (width && row.length !== width)
                throw new Error(`Bitmap.fromString different row sizes: width=${width} cur=${row.length}`);
            width = row.length;
            data.push(row);
        }
        if (!width)
            width = 0;
        return new Bitmap({ height, width }, data);
    }
    point(p) {
        return this.data[p.y][p.x];
    }
    isInside(p) {
        return 0 <= p.x && p.x < this.width && 0 <= p.y && p.y < this.height;
    }
    size(offset) {
        if (!offset)
            return { height: this.height, width: this.width };
        const { x, y } = this.xy(offset);
        return { height: this.height - y, width: this.width - x };
    }
    xy(c) {
        if (typeof c === 'number')
            c = { x: c, y: c };
        if (!Number.isSafeInteger(c.x))
            throw new Error(`Bitmap: wrong x=${c.x}`);
        if (!Number.isSafeInteger(c.y))
            throw new Error(`Bitmap: wrong y=${c.y}`);
        // Do modulo, so we can use negative positions
        c.x = mod(c.x, this.width);
        c.y = mod(c.y, this.height);
        return c;
    }
    // Basically every operation can be represented as rect
    rect(c, size, value) {
        const { x, y } = this.xy(c);
        const { height, width } = Bitmap.size(size, this.size({ x, y }));
        for (let yPos = 0; yPos < height; yPos++) {
            for (let xPos = 0; xPos < width; xPos++) {
                // NOTE: we use give function relative coordinates inside box
                this.data[y + yPos][x + xPos] =
                    typeof value === 'function'
                        ? value({ x: xPos, y: yPos }, this.data[y + yPos][x + xPos])
                        : value;
            }
        }
        return this;
    }
    // returns rectangular part of bitmap
    rectRead(c, size, fn) {
        return this.rect(c, size, (c, cur) => {
            fn(c, cur);
            return cur;
        });
    }
    // Horizontal & vertical lines
    hLine(c, len, value) {
        return this.rect(c, { width: len, height: 1 }, value);
    }
    vLine(c, len, value) {
        return this.rect(c, { width: 1, height: len }, value);
    }
    // add border
    border(border = 2, value) {
        const height = this.height + 2 * border;
        const width = this.width + 2 * border;
        const v = fillArr$1(border, value);
        const h = Array.from({ length: border }, () => fillArr$1(width, value));
        return new Bitmap({ height, width }, [...h, ...this.data.map((i) => [...v, ...i, ...v]), ...h]);
    }
    // Embed another bitmap on coordinates
    embed(c, bm) {
        return this.rect(c, bm.size(), ({ x, y }) => bm.data[y][x]);
    }
    // returns rectangular part of bitmap
    rectSlice(c, size = this.size()) {
        const rect = new Bitmap(Bitmap.size(size, this.size(this.xy(c))));
        this.rect(c, size, ({ x, y }, cur) => (rect.data[y][x] = cur));
        return rect;
    }
    // Change shape, replace rows with columns (data[y][x] -> data[x][y])
    inverse() {
        const { height, width } = this;
        const res = new Bitmap({ height: width, width: height });
        return res.rect({ x: 0, y: 0 }, Infinity, ({ x, y }) => this.data[x][y]);
    }
    // Each pixel size is multiplied by factor
    scale(factor) {
        if (!Number.isSafeInteger(factor) || factor > 1024)
            throw new Error(`Wrong scale factor: ${factor}`);
        const { height, width } = this;
        const res = new Bitmap({ height: factor * height, width: factor * width });
        return res.rect({ x: 0, y: 0 }, Infinity, ({ x, y }) => this.data[Math.floor(y / factor)][Math.floor(x / factor)]);
    }
    clone() {
        const res = new Bitmap(this.size());
        return res.rect({ x: 0, y: 0 }, this.size(), ({ x, y }) => this.data[y][x]);
    }
    // Ensure that there is no undefined values left
    assertDrawn() {
        this.rectRead(0, Infinity, (_, cur) => {
            if (typeof cur !== 'boolean')
                throw new Error(`Invalid color type=${typeof cur}`);
        });
    }
    // Simple string representation for debugging
    toString() {
        return this.data
            .map((i) => i.map((j) => (j === undefined ? '?' : j ? 'X' : ' ')).join(''))
            .join('\n');
    }
    toASCII() {
        const { height, width, data } = this;
        let out = '';
        // Terminal character height is x2 of character width, so we process two rows of bitmap
        // to produce one row of ASCII
        for (let y = 0; y < height; y += 2) {
            for (let x = 0; x < width; x++) {
                const first = data[y][x];
                const second = y + 1 >= height ? true : data[y + 1][x]; // if last row outside bitmap, make it black
                if (!first && !second)
                    out += '█'; // both rows white (empty)
                else if (!first && second)
                    out += '▀'; // top row white
                else if (first && !second)
                    out += '▄'; // down row white
                else if (first && second)
                    out += ' '; // both rows black
            }
            out += '\n';
        }
        return out;
    }
    toTerm() {
        const reset = '\x1b[0m';
        const whiteBG = `\x1b[1;47m  ${reset}`;
        const darkBG = `\x1b[40m  ${reset}`;
        return this.data.map((i) => i.map((j) => (j ? darkBG : whiteBG)).join('')).join('\n');
    }
    toSVG() {
        let out = `<svg xmlns:svg="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" version="1.1" xmlns="http://www.w3.org/2000/svg">`;
        this.rectRead(0, Infinity, ({ x, y }, val) => {
            if (val)
                out += `<svg:rect x = "${x}" y = "${y}" width="1" height="1" />`;
        });
        out += '</svg>';
        return out;
    }
    toGIF() {
        // NOTE: Small, but inefficient implementation.
        // Uses 1 byte per pixel, but still less bloated than SVG.
        const u16le = (i) => [i & 0xff, (i >>> 8) & 0xff];
        const dims = [...u16le(this.width), ...u16le(this.height)];
        const data = [];
        this.rectRead(0, Infinity, (_, cur) => data.push(+(cur === true)));
        const N = 126; // Block size
        // prettier-ignore
        const bytes = [
            0x47, 0x49, 0x46, 0x38, 0x37, 0x61, ...dims, 0xf6, 0x00, 0x00, 0xff, 0xff, 0xff,
            ...fillArr$1(3 * 127, 0x00), 0x2c, 0x00, 0x00, 0x00, 0x00, ...dims, 0x00, 0x07
        ];
        const fullChunks = Math.floor(data.length / N);
        // Full blocks
        for (let i = 0; i < fullChunks; i++)
            bytes.push(N + 1, 0x80, ...data.slice(N * i, N * (i + 1)).map((i) => +i));
        // Remaining bytes
        bytes.push((data.length % N) + 1, 0x80, ...data.slice(fullChunks * N).map((i) => +i));
        bytes.push(0x01, 0x81, 0x00, 0x3b);
        return new Uint8Array(bytes);
    }
    toImage(isRGB = false) {
        const { height, width } = this.size();
        const data = new Uint8Array(height * width * (isRGB ? 3 : 4));
        let i = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const value = !!this.data[y][x] ? 0 : 255;
                data[i++] = value;
                data[i++] = value;
                data[i++] = value;
                if (!isRGB)
                    data[i++] = 255; // alpha channel
            }
        }
        return { height, width, data };
    }
}
// Various constants & tables
// prettier-ignore
const BYTES = [
    // 1,  2,  3,   4,   5,   6,   7,   8,   9,  10,  11,  12,  13,  14,  15,  16,  17,  18,  19,   20,
    26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
    //  21,   22,   23,   24,   25,   26,   27,   28,   29,   30,   31,   32,   33,   34,   35,   36,   37,   38,   39,   40
    1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];
// prettier-ignore
const WORDS_PER_BLOCK = {
    // Version 1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
    low: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    medium: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    quartile: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    high: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
// prettier-ignore
const ECC_BLOCKS = {
    // Version   1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
    low: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    medium: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    quartile: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    high: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const info$1 = {
    size: {
        encode: (ver) => 21 + 4 * (ver - 1),
        decode: (size) => (size - 17) / 4,
    },
    sizeType: (ver) => Math.floor((ver + 7) / 17),
    // Based on https://codereview.stackexchange.com/questions/74925/algorithm-to-generate-this-alignment-pattern-locations-table-for-qr-codes
    alignmentPatterns(ver) {
        if (ver === 1)
            return [];
        const first = 6;
        const last = info$1.size.encode(ver) - first - 1;
        const distance = last - first;
        const count = Math.ceil(distance / 28);
        let interval = Math.floor(distance / count);
        if (interval % 2)
            interval += 1;
        else if ((distance % count) * 2 >= count)
            interval += 2;
        const res = [first];
        for (let m = 1; m < count; m++)
            res.push(last - (count - m) * interval);
        res.push(last);
        return res;
    },
    ECCode: {
        low: 0b01,
        medium: 0b00,
        quartile: 0b11,
        high: 0b10,
    },
    formatMask: 0b101010000010010,
    formatBits(ecc, maskIdx) {
        const data = (info$1.ECCode[ecc] << 3) | maskIdx;
        let d = data;
        for (let i = 0; i < 10; i++)
            d = (d << 1) ^ ((d >> 9) * 0b10100110111);
        return ((data << 10) | d) ^ info$1.formatMask;
    },
    versionBits(ver) {
        let d = ver;
        for (let i = 0; i < 12; i++)
            d = (d << 1) ^ ((d >> 11) * 0b1111100100101);
        return (ver << 12) | d;
    },
    alphabet: {
        numeric: alphabet('0123456789'),
        alphanumerc: alphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'),
    },
    lengthBits(ver, type) {
        const table = {
            numeric: [10, 12, 14],
            alphanumeric: [9, 11, 13],
            byte: [8, 16, 16],
            kanji: [8, 10, 12],
            eci: [0, 0, 0],
        };
        return table[type][info$1.sizeType(ver)];
    },
    modeBits: {
        numeric: '0001',
        alphanumeric: '0010',
        byte: '0100',
        kanji: '1000',
        eci: '0111',
    },
    capacity(ver, ecc) {
        const bytes = BYTES[ver - 1];
        const words = WORDS_PER_BLOCK[ecc][ver - 1];
        const numBlocks = ECC_BLOCKS[ecc][ver - 1];
        const blockLen = Math.floor(bytes / numBlocks) - words;
        const shortBlocks = numBlocks - (bytes % numBlocks);
        return {
            words,
            numBlocks,
            shortBlocks,
            blockLen,
            capacity: (bytes - words * numBlocks) * 8,
            total: (words + blockLen) * numBlocks + numBlocks - shortBlocks,
        };
    },
};
const PATTERNS = [
    (x, y) => (x + y) % 2 == 0,
    (x, y) => y % 2 == 0,
    (x, y) => x % 3 == 0,
    (x, y) => (x + y) % 3 == 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 == 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) == 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 == 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 == 0,
];
// Galois field && reed-solomon encoding
const GF = {
    tables: ((p_poly) => {
        const exp = fillArr$1(256, 0);
        const log = fillArr$1(256, 0);
        for (let i = 0, x = 1; i < 256; i++) {
            exp[i] = x;
            log[x] = i;
            x <<= 1;
            if (x & 0x100)
                x ^= p_poly;
        }
        return { exp, log };
    })(0x11d),
    exp: (x) => GF.tables.exp[x],
    log(x) {
        if (x === 0)
            throw new Error(`GF.log: wrong arg=${x}`);
        return GF.tables.log[x] % 255;
    },
    mul(x, y) {
        if (x === 0 || y === 0)
            return 0;
        return GF.tables.exp[(GF.tables.log[x] + GF.tables.log[y]) % 255];
    },
    add: (x, y) => x ^ y,
    pow: (x, e) => GF.tables.exp[(GF.tables.log[x] * e) % 255],
    inv(x) {
        if (x === 0)
            throw new Error(`GF.inverse: wrong arg=${x}`);
        return GF.tables.exp[255 - GF.tables.log[x]];
    },
    polynomial(poly) {
        if (poly.length == 0)
            throw new Error('GF.polymomial: wrong length');
        if (poly[0] !== 0)
            return poly;
        // Strip leading zeros
        let i = 0;
        for (; i < poly.length - 1 && poly[i] == 0; i++)
            ;
        return poly.slice(i);
    },
    monomial(degree, coefficient) {
        if (degree < 0)
            throw new Error(`GF.monomial: wrong degree=${degree}`);
        if (coefficient == 0)
            return [0];
        let coefficients = fillArr$1(degree + 1, 0);
        coefficients[0] = coefficient;
        return GF.polynomial(coefficients);
    },
    degree: (a) => a.length - 1,
    coefficient: (a, degree) => a[GF.degree(a) - degree],
    mulPoly(a, b) {
        if (a[0] === 0 || b[0] === 0)
            return [0];
        const res = fillArr$1(a.length + b.length - 1, 0);
        for (let i = 0; i < a.length; i++) {
            for (let j = 0; j < b.length; j++) {
                res[i + j] = GF.add(res[i + j], GF.mul(a[i], b[j]));
            }
        }
        return GF.polynomial(res);
    },
    mulPolyScalar(a, scalar) {
        if (scalar == 0)
            return [0];
        if (scalar == 1)
            return a;
        const res = fillArr$1(a.length, 0);
        for (let i = 0; i < a.length; i++)
            res[i] = GF.mul(a[i], scalar);
        return GF.polynomial(res);
    },
    mulPolyMonomial(a, degree, coefficient) {
        if (degree < 0)
            throw new Error('GF.mulPolyMonomial: wrong degree');
        if (coefficient == 0)
            return [0];
        const res = fillArr$1(a.length + degree, 0);
        for (let i = 0; i < a.length; i++)
            res[i] = GF.mul(a[i], coefficient);
        return GF.polynomial(res);
    },
    addPoly(a, b) {
        if (a[0] === 0)
            return b;
        if (b[0] === 0)
            return a;
        let smaller = a;
        let larger = b;
        if (smaller.length > larger.length)
            [smaller, larger] = [larger, smaller];
        let sumDiff = fillArr$1(larger.length, 0);
        let lengthDiff = larger.length - smaller.length;
        let s = larger.slice(0, lengthDiff);
        for (let i = 0; i < s.length; i++)
            sumDiff[i] = s[i];
        for (let i = lengthDiff; i < larger.length; i++)
            sumDiff[i] = GF.add(smaller[i - lengthDiff], larger[i]);
        return GF.polynomial(sumDiff);
    },
    remainderPoly(data, divisor) {
        const out = Array.from(data);
        for (let i = 0; i < data.length - divisor.length + 1; i++) {
            const elm = out[i];
            if (elm === 0)
                continue;
            for (let j = 1; j < divisor.length; j++) {
                if (divisor[j] !== 0)
                    out[i + j] = GF.add(out[i + j], GF.mul(divisor[j], elm));
            }
        }
        return out.slice(data.length - divisor.length + 1, out.length);
    },
    divisorPoly(degree) {
        let g = [1];
        for (let i = 0; i < degree; i++)
            g = GF.mulPoly(g, [1, GF.pow(2, i)]);
        return g;
    },
    evalPoly(poly, a) {
        if (a == 0)
            return GF.coefficient(poly, 0); // Just return the x^0 coefficient
        let res = poly[0];
        for (let i = 1; i < poly.length; i++)
            res = GF.add(GF.mul(a, res), poly[i]);
        return res;
    },
    // TODO: cleanup
    euclidian(a, b, R) {
        // Force degree(a) >= degree(b)
        if (GF.degree(a) < GF.degree(b))
            [a, b] = [b, a];
        let rLast = a;
        let r = b;
        let tLast = [0];
        let t = [1];
        // while degree of Ri ≥ t/2
        while (2 * GF.degree(r) >= R) {
            let rLastLast = rLast;
            let tLastLast = tLast;
            rLast = r;
            tLast = t;
            if (rLast[0] === 0)
                throw new Error('rLast[0] === 0');
            r = rLastLast;
            let q = [0];
            const dltInverse = GF.inv(rLast[0]);
            while (GF.degree(r) >= GF.degree(rLast) && r[0] !== 0) {
                const degreeDiff = GF.degree(r) - GF.degree(rLast);
                const scale = GF.mul(r[0], dltInverse);
                q = GF.addPoly(q, GF.monomial(degreeDiff, scale));
                r = GF.addPoly(r, GF.mulPolyMonomial(rLast, degreeDiff, scale));
            }
            q = GF.mulPoly(q, tLast);
            t = GF.addPoly(q, tLastLast);
            if (GF.degree(r) >= GF.degree(rLast))
                throw new Error(`Division failed r: ${r}, rLast: ${rLast}`);
        }
        const sigmaTildeAtZero = GF.coefficient(t, 0);
        if (sigmaTildeAtZero == 0)
            throw new Error('sigmaTilde(0) was zero');
        const inverse = GF.inv(sigmaTildeAtZero);
        return [GF.mulPolyScalar(t, inverse), GF.mulPolyScalar(r, inverse)];
    },
};
function RS(eccWords) {
    return {
        encode(from) {
            const d = GF.divisorPoly(eccWords);
            const pol = Array.from(from);
            pol.push(...d.slice(0, -1).fill(0));
            return Uint8Array.from(GF.remainderPoly(pol, d));
        },
        decode(to) {
            const res = to.slice();
            const poly = GF.polynomial(Array.from(to));
            // Find errors
            let syndrome = fillArr$1(eccWords, 0);
            let hasError = false;
            for (let i = 0; i < eccWords; i++) {
                const evl = GF.evalPoly(poly, GF.exp(i));
                syndrome[syndrome.length - 1 - i] = evl;
                if (evl !== 0)
                    hasError = true;
            }
            if (!hasError)
                return res;
            syndrome = GF.polynomial(syndrome);
            const monomial = GF.monomial(eccWords, 1);
            const [errorLocator, errorEvaluator] = GF.euclidian(monomial, syndrome, eccWords);
            // Error locations
            const locations = fillArr$1(GF.degree(errorLocator), 0);
            let e = 0;
            for (let i = 1; i < 256 && e < locations.length; i++) {
                if (GF.evalPoly(errorLocator, i) === 0)
                    locations[e++] = GF.inv(i);
            }
            if (e !== locations.length)
                throw new Error('RS.decode: wrong errors number');
            for (let i = 0; i < locations.length; i++) {
                const pos = res.length - 1 - GF.log(locations[i]);
                if (pos < 0)
                    throw new Error('RS.decode: wrong error location');
                const xiInverse = GF.inv(locations[i]);
                let denominator = 1;
                for (let j = 0; j < locations.length; j++) {
                    if (i === j)
                        continue;
                    denominator = GF.mul(denominator, GF.add(1, GF.mul(locations[j], xiInverse)));
                }
                res[pos] = GF.add(res[pos], GF.mul(GF.evalPoly(errorEvaluator, xiInverse), GF.inv(denominator)));
            }
            return res;
        },
    };
}
// Interleaves blocks
function interleave$1(ver, ecc) {
    const { words, shortBlocks, numBlocks, blockLen, total } = info$1.capacity(ver, ecc);
    const rs = RS(words);
    return {
        encode(bytes) {
            // Add error correction to bytes
            const blocks = [];
            const eccBlocks = [];
            for (let i = 0; i < numBlocks; i++) {
                const isShort = i < shortBlocks;
                const len = blockLen + (isShort ? 0 : 1);
                blocks.push(bytes.subarray(0, len));
                eccBlocks.push(rs.encode(bytes.subarray(0, len)));
                bytes = bytes.subarray(len);
            }
            const resBlocks = interleaveBytes(...blocks);
            const resECC = interleaveBytes(...eccBlocks);
            const res = new Uint8Array(resBlocks.length + resECC.length);
            res.set(resBlocks);
            res.set(resECC, resBlocks.length);
            return res;
        },
        decode(data) {
            if (data.length !== total)
                throw new Error(`interleave.decode: len(data)=${data.length}, total=${total}`);
            const blocks = [];
            for (let i = 0; i < numBlocks; i++) {
                const isShort = i < shortBlocks;
                blocks.push(new Uint8Array(words + blockLen + (isShort ? 0 : 1)));
            }
            // Short blocks
            let pos = 0;
            for (let i = 0; i < blockLen; i++) {
                for (let j = 0; j < numBlocks; j++)
                    blocks[j][i] = data[pos++];
            }
            // Long blocks
            for (let j = shortBlocks; j < numBlocks; j++)
                blocks[j][blockLen] = data[pos++];
            // ECC
            for (let i = blockLen; i < blockLen + words; i++) {
                for (let j = 0; j < numBlocks; j++) {
                    const isShort = j < shortBlocks;
                    blocks[j][i + (isShort ? 0 : 1)] = data[pos++];
                }
            }
            // Decode
            // Error-correct and copy data blocks together into a stream of bytes
            const res = [];
            for (const block of blocks)
                res.push(...Array.from(rs.decode(block)).slice(0, -words));
            return Uint8Array.from(res);
        },
    };
}
// Draw
// Generic template per version+ecc+mask. Can be cached, to speedup calculations.
function drawTemplate$1(ver, ecc, maskIdx, test = false) {
    const size = info$1.size.encode(ver);
    let b = new Bitmap(size + 2);
    // Finder patterns
    // We draw full pattern and later slice, since before addition of borders finder is truncated by one pixel on sides
    const finder = new Bitmap(3).rect(0, 3, true).border(1, false).border(1, true).border(1, false);
    b = b
        .embed(0, finder) // top left
        .embed({ x: -finder.width, y: 0 }, finder) // top right
        .embed({ x: 0, y: -finder.height }, finder); // bottom left
    b = b.rectSlice(1, size);
    // Alignment patterns
    const align = new Bitmap(1).rect(0, 1, true).border(1, false).border(1, true);
    const alignPos = info$1.alignmentPatterns(ver);
    for (const y of alignPos) {
        for (const x of alignPos) {
            if (b.data[y][x] !== undefined)
                continue;
            b.embed({ x: x - 2, y: y - 2 }, align); // center of pattern should be at position
        }
    }
    // Timing patterns
    b = b
        .hLine({ x: 0, y: 6 }, Infinity, ({ x, y }, cur) => (cur === undefined ? x % 2 == 0 : cur))
        .vLine({ x: 6, y: 0 }, Infinity, ({ x, y }, cur) => (cur === undefined ? y % 2 == 0 : cur));
    // Format information
    {
        const bits = info$1.formatBits(ecc, maskIdx);
        const getBit = (i) => !test && ((bits >> i) & 1) == 1;
        // vertical
        for (let i = 0; i < 6; i++)
            b.data[i][8] = getBit(i); // right of top-left finder
        // TODO: re-write as lines, like:
        // b.vLine({ x: 8, y: 0 }, 6, ({ x, y }) => getBit(y));
        for (let i = 6; i < 8; i++)
            b.data[i + 1][8] = getBit(i); // after timing pattern
        for (let i = 8; i < 15; i++)
            b.data[size - 15 + i][8] = getBit(i); // right of bottom-left finder
        // horizontal
        for (let i = 0; i < 8; i++)
            b.data[8][size - i - 1] = getBit(i); // under top-right finder
        for (let i = 8; i < 9; i++)
            b.data[8][15 - i - 1 + 1] = getBit(i); // VVV, after timing
        for (let i = 9; i < 15; i++)
            b.data[8][15 - i - 1] = getBit(i); // under top-left finder
        b.data[size - 8][8] = !test; // bottom-left finder, right
    }
    // Version information
    if (ver >= 7) {
        const bits = info$1.versionBits(ver);
        for (let i = 0; i < 18; i += 1) {
            const bit = !test && ((bits >> i) & 1) == 1;
            const x = Math.floor(i / 3);
            const y = (i % 3) + size - 8 - 3;
            // two copies
            b.data[x][y] = bit;
            b.data[y][x] = bit;
        }
    }
    return b;
}
// zigzag: bottom->top && top->bottom
function zigzag$1(tpl, maskIdx, fn) {
    const size = tpl.height;
    const pattern = PATTERNS[maskIdx];
    // zig-zag pattern
    let dir = -1;
    let y = size - 1;
    // two columns at time
    for (let xOffset = size - 1; xOffset > 0; xOffset -= 2) {
        if (xOffset == 6)
            xOffset = 5; // skip vertical timing pattern
        for (;; y += dir) {
            for (let j = 0; j < 2; j += 1) {
                const x = xOffset - j;
                if (tpl.data[y][x] !== undefined)
                    continue; // skip already written elements
                fn(x, y, pattern(x, y));
            }
            if (y + dir < 0 || y + dir >= size)
                break;
        }
        dir = -dir; // change direction
    }
}
const utils = {
    best: best$1,
    bin: bin$1,
    drawTemplate: drawTemplate$1,
    fillArr: fillArr$1,
    info: info$1,
    interleave: interleave$1,
    validateVersion: validateVersion$1,
    zigzag: zigzag$1,
};
// Type tests
// const o1 = qr('test', 'ascii');
// const o2 = qr('test', 'raw');
// const o3 = qr('test', 'gif');
// const o4 = qr('test', 'svg');
// const o5 = qr('test', 'term');

/*!
Copyright (c) 2023 Paul Miller (paulmillr.com)
The library @paulmillr/qr is dual-licensed under the Apache 2.0 OR MIT license.
You can select a license of your choice.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
const { best, bin, drawTemplate, fillArr, info, interleave, validateVersion, zigzag } = utils;
// Methods for reading QR code patterns
// Constants
const MAX_BITS_ERROR = 3; // Up to 3 bit errors in version/format
const GRAYSCALE_BLOCK_SIZE = 8;
const GRAYSCALE_RANGE = 24;
const PATTERN_VARIANCE = 2;
const PATTERN_VARIANCE_DIAGONAL = 1.333;
const PATTERN_MIN_CONFIRMATIONS = 2;
const DETECT_MIN_ROW_SKIP = 3;
// TODO: move to index, nearby with bitmap and other graph related stuff?
const int = (n) => n >>> 0;
// distance ^ 2
const distance2 = (p1, p2) => {
    const x = p1.x - p2.x;
    const y = p1.y - p2.y;
    return x * x + y * y;
};
const distance = (p1, p2) => Math.sqrt(distance2(p1, p2));
const sum = (lst) => lst.reduce((acc, i) => acc + i);
const pointIncr = (p, incr) => {
    p.x += incr.x;
    p.y += incr.y;
};
const pointNeg = (p) => ({ x: -p.x, y: -p.y });
const pointMirror = (p) => ({ x: p.y, y: p.x });
const pointClone = (p) => ({ x: p.x, y: p.y });
const pointInt = (p) => ({ x: int(p.x), y: int(p.y) });
function cap(value, min, max) {
    return Math.max(Math.min(value, max || value), min || value);
}
/**
 * Convert to grayscale. The function is the most expensive part of decoding:
 * it takes up to 90% of time. TODO: check gamma correction / sqr.
 */
function toBitmap(img, isRGB = false) {
    const brightness = new Uint8Array(img.height * img.width);
    for (let i = 0, j = 0, d = img.data; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        brightness[j++] = int((r + 2 * g + b) / 4) & 0xff;
    }
    // Convert to bitmap
    const block = GRAYSCALE_BLOCK_SIZE;
    if (img.width < block * 5 || img.height < block * 5)
        throw new Error('image too small');
    const bWidth = Math.ceil(img.width / block);
    const bHeight = Math.ceil(img.height / block);
    const maxY = img.height - block;
    const maxX = img.width - block;
    const blocks = new Uint8Array(bWidth * bHeight);
    for (let y = 0; y < bHeight; y++) {
        const yPos = cap(y * block, 0, maxY);
        for (let x = 0; x < bWidth; x++) {
            const xPos = cap(x * block, 0, maxX);
            let sum = 0;
            let min = 0xff;
            let max = 0;
            for (let yy = 0, pos = yPos * img.width + xPos; yy < block; yy = yy + 1, pos = pos + img.width) {
                for (let xx = 0; xx < block; xx++) {
                    const pixel = brightness[pos + xx];
                    sum += pixel;
                    min = Math.min(min, pixel);
                    max = Math.max(max, pixel);
                }
            }
            // Average brightness of block
            let average = Math.floor(sum / block ** 2);
            if (max - min <= GRAYSCALE_RANGE) {
                average = min / 2;
                if (y > 0 && x > 0) {
                    const idx = (x, y) => y * bWidth + x;
                    const prev = (blocks[idx(x, y - 1)] + 2 * blocks[idx(x - 1, y)] + blocks[idx(x - 1, y - 1)]) / 4;
                    if (min < prev)
                        average = prev;
                }
            }
            blocks[bWidth * y + x] = int(average);
        }
    }
    const matrix = new Bitmap({ width: img.width, height: img.height });
    for (let y = 0; y < bHeight; y++) {
        const yPos = cap(y * block, 0, maxY);
        const top = cap(y, 2, bHeight - 3);
        for (let x = 0; x < bWidth; x++) {
            const xPos = cap(x * block, 0, maxX);
            const left = cap(x, 2, bWidth - 3);
            // 5x5 blocks average
            let sum = 0;
            for (let yy = -2; yy <= 2; yy++) {
                const y2 = bWidth * (top + yy) + left;
                for (let xx = -2; xx <= 2; xx++)
                    sum += blocks[y2 + xx];
            }
            const average = sum / 25;
            for (let y = 0, pos = yPos * img.width + xPos; y < block; y += 1, pos += img.width) {
                for (let x = 0; x < block; x++) {
                    if (brightness[pos + x] <= average)
                        matrix.data[yPos + y][xPos + x] = true;
                }
            }
        }
    }
    return matrix;
}
function patternEquals(p, p2) {
    if (Math.abs(p2.y - p.y) <= p2.moduleSize && Math.abs(p2.x - p.x) <= p2.moduleSize) {
        const diff = Math.abs(p2.moduleSize - p.moduleSize);
        return diff <= 1.0 || diff <= p.moduleSize;
    }
    return false;
}
function patternMerge(a, b) {
    const count = a.count + b.count;
    return {
        x: (a.count * a.x + b.count * b.x) / count,
        y: (a.count * a.y + b.count * b.y) / count,
        moduleSize: (a.count * a.moduleSize + b.count * b.moduleSize) / count,
        count,
    };
}
const patternsConfirmed = (lst) => lst.filter((i) => i.count >= PATTERN_MIN_CONFIRMATIONS);
/**
 * Since pattern means runs of identical color (dark or white), we cannot
 * have pattern like [true, true], because it will be hard to separate same color runs.
 * @param p boolean pattern
 * @param size size of run relative to others
 * @returns
 */
function pattern(p, size) {
    const _size = size || fillArr(p.length, 1);
    if (p.length !== _size.length)
        throw new Error('Wrong pattern');
    if (!(p.length & 1))
        throw new Error('Pattern length should be odd');
    const res = {
        center: Math.ceil(p.length / 2) - 1,
        length: p.length,
        pattern: p,
        size: _size,
        runs: () => fillArr(p.length, 0),
        totalSize: sum(_size),
        total: (runs) => runs.reduce((acc, i) => acc + i),
        shift: (runs, n) => {
            for (let i = 0; i < runs.length - n; i++)
                runs[i] = runs[i + 2];
            for (let i = runs.length - n; i < runs.length; i++)
                runs[i] = 0;
        },
        checkSize(runs, moduleSize, v = PATTERN_VARIANCE) {
            const variance = moduleSize / v;
            for (let i = 0; i < runs.length; i++) {
                if (Math.abs(_size[i] * moduleSize - runs[i]) >= _size[i] * variance)
                    return false;
            }
            return true;
        },
        add(out, x, y, total) {
            const moduleSize = total / FINDER.totalSize;
            const cur = { x, y, moduleSize, count: 1 };
            for (let idx = 0; idx < out.length; idx++) {
                const f = out[idx];
                if (!patternEquals(f, cur))
                    continue;
                return (out[idx] = patternMerge(f, cur));
            }
            out.push(cur);
        },
        toCenter(runs, end) {
            for (let i = p.length - 1; i > res.center; i--)
                end -= runs[i];
            end -= runs[res.center] / 2;
            return end;
        },
        check(b, runs, center, incr, maxCount) {
            let j = 0;
            let i = pointClone(center);
            const neg = pointNeg(incr);
            const check = (p, step) => {
                for (; b.isInside(i) && !!b.point(i) === res.pattern[p]; pointIncr(i, step)) {
                    runs[p]++;
                    j++;
                }
                if (runs[p] === 0)
                    return true;
                const center = p === res.center;
                if (maxCount && !center && runs[p] > res.size[p] * maxCount)
                    return true;
            };
            for (let p = res.center; p >= 0; p--)
                if (check(p, neg))
                    return false;
            i = pointClone(center);
            pointIncr(i, incr);
            j = 1;
            for (let p = res.center; p < res.length; p++)
                if (check(p, incr))
                    return false;
            return j;
        },
        scanLine(b, y, xStart, xEnd, fn) {
            const runs = res.runs();
            let pos = 0;
            let x = xStart;
            // If we start in middle of an image, skip first pattern run,
            // since we don't know run length of pixels from left side
            if (xStart)
                while (x < xEnd && !!b.data[y][x] === res.pattern[0])
                    x++;
            for (; x < xEnd; x++) {
                // Same run, continue counting
                if (!!b.data[y][x] === res.pattern[pos]) {
                    runs[pos]++;
                    // If not last element - continue counting
                    if (x !== b.width - 1)
                        continue;
                    // Last element finishes run, set x outside of run
                    x++;
                }
                // Not last run: count new one
                if (pos !== res.length - 1) {
                    runs[++pos]++;
                    continue;
                }
                const found = fn(runs, x);
                if (found) {
                    // We found pattern, reset runs counting
                    pos = 0;
                    runs.fill(0);
                }
                else if (found === false) {
                    // Stop scanning
                    break;
                }
                else {
                    // Not found: shift runs by two (so pattern will continue)
                    res.shift(runs, 2);
                    pos = res.length - 2;
                    runs[pos]++;
                }
            }
        },
    };
    return res;
}
// light/dark/light/dark/light in 1:1:3:1:1 ratio
const FINDER = pattern([true, false, true, false, true], [1, 1, 3, 1, 1]);
// dark/light/dark in 1:1:1 ratio
const ALIGNMENT = pattern([false, true, false]);
function findFinder(b) {
    let found = [];
    function checkRuns(runs, v = 2) {
        const total = sum(runs);
        if (total < FINDER.totalSize)
            return false;
        const moduleSize = total / FINDER.totalSize;
        return FINDER.checkSize(runs, moduleSize, v);
    }
    // Non-diagonal line (horizontal or vertical)
    function checkLine(center, maxCount, total, incr) {
        const runs = FINDER.runs();
        let i = FINDER.check(b, runs, center, incr, maxCount);
        if (i === false)
            return false;
        const runsTotal = sum(runs);
        if (5 * Math.abs(runsTotal - total) >= 2 * total)
            return false;
        if (checkRuns(runs))
            return FINDER.toCenter(runs, i);
        return false;
    }
    function check(runs, i, j) {
        if (!checkRuns(runs))
            return false;
        const total = sum(runs);
        let x = FINDER.toCenter(runs, j);
        // Vertical
        let y = checkLine({ x: int(x), y: i }, runs[2], total, { y: 1, x: 0 });
        if (y === false)
            return false;
        y += i;
        // Horizontal
        let xx = checkLine({ x: int(x), y: int(y) }, runs[2], total, { y: 0, x: 1 });
        if (xx === false)
            return false;
        x = xx + int(x);
        // Diagonal
        const dRuns = FINDER.runs();
        if (!FINDER.check(b, dRuns, { x: int(x), y: int(y) }, { x: 1, y: 1 }))
            return false;
        if (!checkRuns(dRuns, PATTERN_VARIANCE_DIAGONAL))
            return false;
        FINDER.add(found, x, y, total);
        return true;
    }
    let skipped = false;
    // Start with high skip lines count until we find first pattern
    let ySkip = cap(int((3 * b.height) / (4 * 97)), DETECT_MIN_ROW_SKIP);
    let done = false;
    for (let y = ySkip - 1; y < b.height && !done; y += ySkip) {
        FINDER.scanLine(b, y, 0, b.width, (runs, x) => {
            if (!check(runs, y, x))
                return;
            // Found pattern
            // Reduce row skip, since we found pattern and qr code is nearby
            ySkip = 2;
            if (skipped) {
                // Already skipped, so we have at least 2 patterns, lets check if third is ok
                let count = 0;
                let total = 0;
                for (const p of found) {
                    if (p.count < PATTERN_MIN_CONFIRMATIONS)
                        continue;
                    count++;
                    total += p.moduleSize;
                }
                if (count < 3)
                    return;
                const average = total / found.length;
                let deviation = 0.0;
                for (const p of found)
                    deviation += Math.abs(p.moduleSize - average);
                if (deviation <= 0.05 * total) {
                    done = true;
                    return false;
                }
            }
            else if (found.length > 1) {
                // We found two top patterns, lets skip to approximate location of third pattern
                const q = patternsConfirmed(found);
                if (q.length < 2)
                    return true;
                skipped = true;
                const d = int((Math.abs(q[0].x - q[1].x) - Math.abs(q[0].y - q[1].y)) / 2);
                if (d <= runs[2] + ySkip)
                    return true;
                y += d - runs[2] - ySkip;
                return false;
            }
        });
    }
    const flen = found.length;
    if (flen < 3)
        throw new Error(`Finder: len(found) = ${flen}`);
    found.sort((i, j) => i.moduleSize - j.moduleSize);
    const pBest = best();
    // Qubic complexity, but we stop search when we found 3 patterns, so not a problem
    for (let i = 0; i < flen - 2; i++) {
        const fi = found[i];
        for (let j = i + 1; j < flen - 1; j++) {
            const fj = found[j];
            const square0 = distance2(fi, fj);
            for (let k = j + 1; k < flen; k++) {
                const fk = found[k];
                if (fk.moduleSize > fi.moduleSize * 1.4)
                    continue;
                const arr = [square0, distance2(fj, fk), distance2(fi, fk)].sort((a, b) => a - b);
                const a = arr[0];
                const b = arr[1];
                const c = arr[2];
                pBest.add(Math.abs(c - 2 * b) + Math.abs(c - 2 * a), [fi, fj, fk]);
            }
        }
    }
    const p = pBest.get();
    if (!p)
        throw new Error('cannot find finder');
    const p0 = p[0];
    const p1 = p[1];
    const p2 = p[2];
    const d01 = distance(p0, p1);
    const d12 = distance(p1, p2);
    const d02 = distance(p0, p2);
    let tl = p2;
    let bl = p0;
    let tr = p1;
    if (d12 >= d01 && d12 >= d02) {
        tl = p0;
        bl = p1;
        tr = p2;
    }
    else if (d02 >= d12 && d02 >= d01) {
        tl = p1;
        bl = p0;
        tr = p2;
    }
    // If cross product is negative -> flip points
    if ((tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x) < 0.0) {
        let _bl = bl;
        bl = tr;
        tr = _bl;
    }
    return { bl, tl, tr };
}
function findAlignment(b, est, allowanceFactor) {
    const { moduleSize } = est;
    const allowance = int(allowanceFactor * moduleSize);
    const leftX = cap(est.x - allowance, 0);
    const rightX = cap(est.x + allowance, undefined, b.width - 1);
    const x = rightX - leftX;
    const topY = cap(est.y - allowance, 0);
    const bottomY = cap(est.y + allowance, undefined, b.height - 1);
    const y = bottomY - topY;
    if (x < moduleSize * 3 || y < moduleSize * 3)
        throw new Error(`x = ${x}, y=${y} moduleSize = ${moduleSize}`);
    const xStart = leftX;
    const yStart = topY;
    const width = rightX - leftX;
    const height = bottomY - topY;
    const found = [];
    const xEnd = xStart + width;
    const middleY = int(yStart + height / 2);
    for (let yGen = 0; yGen < height; yGen++) {
        const diff = int((yGen + 1) / 2);
        const y = middleY + (yGen & 1 ? -diff : diff);
        let res;
        ALIGNMENT.scanLine(b, y, xStart, xEnd, (runs, x) => {
            if (!ALIGNMENT.checkSize(runs, moduleSize))
                return;
            const total = sum(runs);
            const xx = ALIGNMENT.toCenter(runs, x);
            // Vertical
            const rVert = ALIGNMENT.runs();
            let v = ALIGNMENT.check(b, rVert, { x: int(xx), y }, { y: 1, x: 0 }, 2 * runs[1]);
            if (v === false)
                return;
            v += y;
            const vTotal = sum(rVert);
            if (5 * Math.abs(vTotal - total) >= 2 * total)
                return;
            if (!ALIGNMENT.checkSize(rVert, moduleSize))
                return;
            const yy = ALIGNMENT.toCenter(rVert, v);
            res = ALIGNMENT.add(found, xx, yy, total);
            if (res)
                return false;
        });
        if (res)
            return res;
    }
    if (found.length > 0)
        return found[0];
    throw new Error('Alignment pattern not found');
}
function _single(b, from, to) {
    // http://en.wikipedia.org/wiki/Bresenham's_line_algorithm
    let steep = false;
    let d = { x: Math.abs(to.x - from.x), y: Math.abs(to.y - from.y) };
    if (d.y > d.x) {
        steep = true;
        from = pointMirror(from);
        to = pointMirror(to);
        d = pointMirror(d);
    }
    let error = -d.x / 2;
    let step = { x: from.x >= to.x ? -1 : 1, y: from.y >= to.y ? -1 : 1 };
    let runPos = 0;
    let xLimit = to.x + step.x;
    // TODO: re-use pattern scanLine here?
    for (let x = from.x, y = from.y; x !== xLimit; x += step.x) {
        let real = { x, y };
        if (steep)
            real = pointMirror(real);
        // Same as alignment pattern ([true, false, true])
        if ((runPos === 1) === !!b.point(real)) {
            if (runPos === 2)
                return distance({ x, y }, from);
            runPos++;
        }
        error += d.y;
        if (error <= 0)
            continue;
        if (y === to.y)
            break;
        y += step.y;
        error -= d.x;
    }
    if (runPos === 2)
        return distance({ x: to.x + step.x, y: to.y }, from);
    return NaN;
}
function BWBRunLength(b, from, to) {
    let result = _single(b, from, to);
    let scaleY = 1.0;
    const { x: fx, y: fy } = from;
    let otherToX = fx - (to.x - fx);
    const bw = b.width;
    if (otherToX < 0) {
        scaleY = fx / (fx - otherToX);
        otherToX = 0;
    }
    else if (otherToX >= bw) {
        scaleY = (bw - 1 - fx) / (otherToX - fx);
        otherToX = bw - 1;
    }
    let otherToY = int(fy - (to.y - fy) * scaleY);
    let scaleX = 1.0;
    const bh = b.height;
    if (otherToY < 0) {
        scaleX = fy / (fy - otherToY);
        otherToY = 0;
    }
    else if (otherToY >= bh) {
        scaleX = (bh - 1 - fy) / (otherToY - fy);
        otherToY = bh - 1;
    }
    otherToX = int(fx + (otherToX - fx) * scaleX);
    result += _single(b, from, { x: otherToX, y: otherToY });
    return result - 1.0;
}
function moduleSizeAvg(b, p1, p2) {
    const est1 = BWBRunLength(b, pointInt(p1), pointInt(p2));
    const est2 = BWBRunLength(b, pointInt(p2), pointInt(p1));
    if (Number.isNaN(est1))
        return est2 / FINDER.totalSize;
    if (Number.isNaN(est2))
        return est1 / FINDER.totalSize;
    return (est1 + est2) / (2 * FINDER.totalSize);
}
function detect(b) {
    const { bl, tl, tr } = findFinder(b);
    const moduleSize = (moduleSizeAvg(b, tl, tr) + moduleSizeAvg(b, tl, bl)) / 2;
    if (moduleSize < 1.0)
        throw new Error(`wrong moduleSize = ${moduleSize}`);
    // Estimate size
    const tltr = int(distance(tl, tr) / moduleSize + 0.5);
    const tlbl = int(distance(tl, bl) / moduleSize + 0.5);
    let size = int((tltr + tlbl) / 2 + 7);
    const rem = size % 4;
    if (rem === 0)
        size++; // -> 1
    else if (rem === 2)
        size--; // -> 1
    else if (rem === 3)
        size -= 2;
    const version = info.size.decode(size);
    validateVersion(version);
    let alignmentPattern;
    if (info.alignmentPatterns(version).length > 0) {
        // Bottom right estimate
        const br = { x: tr.x - tl.x + bl.x, y: tr.y - tl.y + bl.y };
        const c = 1.0 - 3.0 / (info.size.encode(version) - 7);
        // Estimated alignment pattern position
        const est = {
            x: int(tl.x + c * (br.x - tl.x)),
            y: int(tl.y + c * (br.y - tl.y)),
            moduleSize,
            count: 1,
        };
        for (let i = 4; i <= 16; i <<= 1) {
            try {
                alignmentPattern = findAlignment(b, est, i);
                break;
            }
            catch (e) { }
        }
    }
    const toTL = { x: 3.5, y: 3.5 };
    const toTR = { x: size - 3.5, y: 3.5 };
    const toBL = { x: 3.5, y: size - 3.5 };
    let br;
    let toBR;
    if (alignmentPattern) {
        br = alignmentPattern;
        toBR = { x: size - 6.5, y: size - 6.5 };
    }
    else {
        br = { x: tr.x - tl.x + bl.x, y: tr.y - tl.y + bl.y };
        toBR = { x: size - 3.5, y: size - 3.5 };
    }
    const from = [tl, tr, br, bl];
    const bits = transform(b, size, from, [toTL, toTR, toBR, toBL]);
    return { bits, points: from };
}
// Perspective transform by 4 points
function squareToQuadrilateral(p) {
    const d3 = { x: p[0].x - p[1].x + p[2].x - p[3].x, y: p[0].y - p[1].y + p[2].y - p[3].y };
    if (d3.x === 0.0 && d3.y === 0.0) {
        return [
            [p[1].x - p[0].x, p[2].x - p[1].x, p[0].x],
            [p[1].y - p[0].y, p[2].y - p[1].y, p[0].y],
            [0.0, 0.0, 1.0],
        ];
    }
    else {
        const d1 = { x: p[1].x - p[2].x, y: p[1].y - p[2].y };
        const d2 = { x: p[3].x - p[2].x, y: p[3].y - p[2].y };
        const den = d1.x * d2.y - d2.x * d1.y;
        const p13 = (d3.x * d2.y - d2.x * d3.y) / den;
        const p23 = (d1.x * d3.y - d3.x * d1.y) / den;
        return [
            [p[1].x - p[0].x + p13 * p[1].x, p[3].x - p[0].x + p23 * p[3].x, p[0].x],
            [p[1].y - p[0].y + p13 * p[1].y, p[3].y - p[0].y + p23 * p[3].y, p[0].y],
            [p13, p23, 1.0],
        ];
    }
}
// Transform quadrilateral to square by 4 points
function transform(b, size, from, to) {
    // TODO: check
    // https://math.stackexchange.com/questions/13404/mapping-irregular-quadrilateral-to-a-rectangle
    const p = squareToQuadrilateral(to);
    const qToS = [
        [
            p[1][1] * p[2][2] - p[2][1] * p[1][2],
            p[2][1] * p[0][2] - p[0][1] * p[2][2],
            p[0][1] * p[1][2] - p[1][1] * p[0][2],
        ],
        [
            p[2][0] * p[1][2] - p[1][0] * p[2][2],
            p[0][0] * p[2][2] - p[2][0] * p[0][2],
            p[1][0] * p[0][2] - p[0][0] * p[1][2],
        ],
        [
            p[1][0] * p[2][1] - p[2][0] * p[1][1],
            p[2][0] * p[0][1] - p[0][0] * p[2][1],
            p[0][0] * p[1][1] - p[1][0] * p[0][1],
        ],
    ];
    const sToQ = squareToQuadrilateral(from);
    const transform = sToQ.map((i, sy) => i.map((_, qx) => i.reduce((acc, v, j) => acc + v * qToS[j][qx], 0)));
    const res = new Bitmap(size);
    const points = fillArr(2 * size, 0);
    const pointsLength = points.length;
    for (let y = 0; y < size; y++) {
        const p = transform;
        for (let i = 0; i < pointsLength - 1; i += 2) {
            const x = i / 2 + 0.5;
            const y2 = y + 0.5;
            const den = p[2][0] * x + p[2][1] * y2 + p[2][2];
            points[i] = int((p[0][0] * x + p[0][1] * y2 + p[0][2]) / den);
            points[i + 1] = int((p[1][0] * x + p[1][1] * y2 + p[1][2]) / den);
        }
        for (let i = 0; i < pointsLength; i += 2) {
            const px = cap(points[i], 0, b.width - 1);
            const py = cap(points[i + 1], 0, b.height - 1);
            if (b.data[py][px])
                res.data[y][i / 2] = true;
        }
    }
    return res;
}
// Same as in drawTemplate, but reading
// TODO: merge in CoderType?
function readInfoBits(b) {
    const readBit = (x, y, out) => (out << 1) | (b.data[y][x] ? 1 : 0);
    const size = b.height;
    // Version information
    let version1 = 0;
    for (let y = 5; y >= 0; y--)
        for (let x = size - 9; x >= size - 11; x--)
            version1 = readBit(x, y, version1);
    let version2 = 0;
    for (let x = 5; x >= 0; x--)
        for (let y = size - 9; y >= size - 11; y--)
            version2 = readBit(x, y, version2);
    // Format information
    let format1 = 0;
    for (let x = 0; x < 6; x++)
        format1 = readBit(x, 8, format1);
    format1 = readBit(7, 8, format1);
    format1 = readBit(8, 8, format1);
    format1 = readBit(8, 7, format1);
    for (let y = 5; y >= 0; y--)
        format1 = readBit(8, y, format1);
    let format2 = 0;
    for (let y = size - 1; y >= size - 7; y--)
        format2 = readBit(8, y, format2);
    for (let x = size - 8; x < size; x++)
        format2 = readBit(x, 8, format2);
    return { version1, version2, format1, format2 };
}
function parseInfo(b) {
    // Population count over xor -> hamming distance
    const popcnt = (a) => {
        let cnt = 0;
        while (a) {
            if (a & 1)
                cnt++;
            a >>= 1;
        }
        return cnt;
    };
    const size = b.height;
    const { version1, version2, format1, format2 } = readInfoBits(b);
    // Guess format
    let format;
    const bestFormat = best();
    for (const ecc of ['medium', 'low', 'high', 'quartile']) {
        for (let mask = 0; mask < 8; mask++) {
            const bits = info.formatBits(ecc, mask);
            const cur = { ecc, mask: mask };
            if (bits === format1 || bits === format2) {
                format = cur;
                break;
            }
            bestFormat.add(popcnt(format1 ^ bits), cur);
            if (format1 !== format2)
                bestFormat.add(popcnt(format2 ^ bits), cur);
        }
    }
    if (format === undefined && bestFormat.score() <= MAX_BITS_ERROR)
        format = bestFormat.get();
    if (format === undefined)
        throw new Error('wrong format pattern');
    let version = info.size.decode(size); // Guess version based on bitmap size
    if (version < 7)
        validateVersion(version);
    else {
        version = undefined;
        // Guess version
        const bestVer = best();
        for (let ver = 7; ver <= 40; ver++) {
            const bits = info.versionBits(ver);
            if (bits === version1 || bits === version2) {
                version = ver;
                break;
            }
            bestVer.add(popcnt(version1 ^ bits), ver);
            if (version1 !== version2)
                bestVer.add(popcnt(version2 ^ bits), ver);
        }
        if (version === undefined && bestVer.score() <= MAX_BITS_ERROR)
            version = bestVer.get();
        if (version === undefined)
            throw new Error('Wrong version pattern');
        if (info.size.encode(version) !== size)
            throw new Error('Wrong version size');
    }
    return { version, ...format };
}
function decodeBitmap(b) {
    const size = b.height;
    if (size < 21 || (size & 0b11) !== 1 || size !== b.width)
        throw new Error(`decode: wrong size=${size}`);
    const { version, mask, ecc } = parseInfo(b);
    const tpl = drawTemplate(version, ecc, mask);
    const { total } = info.capacity(version, ecc);
    const bytes = new Uint8Array(total);
    let pos = 0;
    let buf = 0;
    let bitPos = 0;
    zigzag(tpl, mask, (x, y, m) => {
        bitPos++;
        buf <<= 1;
        buf |= +(!!b.data[y][x] !== m);
        if (bitPos !== 8)
            return;
        bytes[pos++] = buf;
        bitPos = 0;
        buf = 0;
    });
    if (pos !== total)
        throw new Error(`decode: pos=${pos}, total=${total}`);
    let bits = Array.from(interleave(version, ecc).decode(bytes))
        .map((i) => bin(i, 8))
        .join('');
    // Reverse operation of index.ts/encode working on bits
    const readBits = (n) => {
        if (n > bits.length)
            throw new Error('Not enough bits');
        const val = bits.slice(0, n);
        bits = bits.slice(n);
        return val;
    };
    const toNum = (n) => Number(`0b${n}`);
    // reverse of common.info.modebits
    const modes = {
        '0000': 'terminator',
        '0001': 'numeric',
        '0010': 'alphanumeric',
        '0100': 'byte',
        '0111': 'eci',
        '1000': 'kanji',
    };
    let res = '';
    while (true) {
        if (bits.length < 4)
            break;
        const modeBits = readBits(4);
        const mode = modes[modeBits];
        if (mode === undefined)
            throw new Error(`Unknown modeBits=${modeBits} res="${res}"`);
        if (mode === 'terminator')
            break;
        const countBits = info.lengthBits(version, mode);
        let count = toNum(readBits(countBits));
        if (mode === 'numeric') {
            while (count >= 3) {
                const v = toNum(readBits(10));
                if (v >= 1000)
                    throw new Error(`numberic(3) = ${v}`);
                res += v.toString().padStart(3, '0');
                count -= 3;
            }
            if (count === 2) {
                const v = toNum(readBits(7));
                if (v >= 100)
                    throw new Error(`numeric(2) = ${v}`);
                res += v.toString().padStart(2, '0');
            }
            else if (count === 1) {
                const v = toNum(readBits(4));
                if (v >= 10)
                    throw new Error(`Numeric(1) = ${v}`);
                res += v.toString();
            }
        }
        else if (mode === 'alphanumeric') {
            while (count >= 2) {
                const v = toNum(readBits(11));
                res += info.alphabet.alphanumerc.encode([Math.floor(v / 45), v % 45]).join('');
                count -= 2;
            }
            if (count === 1)
                res += info.alphabet.alphanumerc.encode([toNum(readBits(6))]).join('');
        }
        else if (mode === 'byte') {
            let utf8 = [];
            for (let i = 0; i < count; i++)
                utf8.push(Number(`0b${readBits(8)}`));
            res += new TextDecoder().decode(new Uint8Array(utf8));
        }
        else
            throw new Error(`Unknown mode=${mode}`);
    }
    return res;
}
function readQR(img, opts = {}) {
    for (const field of ['height', 'width']) {
        if (!Number.isSafeInteger(img[field]) || img[field] <= 0)
            throw new Error(`Wrong img.${field}=${img[field]} (${typeof img[field]})`);
    }
    if (!Array.isArray(img.data) &&
        !(img.data instanceof Uint8Array) &&
        !(img.data instanceof Uint8ClampedArray))
        throw new Error(`Wrong image.data=${img.data} (${typeof img.data})`);
    if (opts.isRGB !== undefined && typeof opts.isRGB !== 'boolean')
        throw new Error(`Wrong opts.isRGB=${opts.isRGB}  (${typeof opts.isRGB})`);
    for (const fn of ['detectFn', 'qrFn']) {
        if (opts[fn] !== undefined && typeof opts[fn] !== 'function')
            throw new Error(`Wrong opts.${fn}=${opts[fn]} (${typeof opts[fn]})`);
    }
    const bmp = toBitmap(img, opts.isRGB);
    const { bits, points } = detect(bmp);
    if (opts.detectFn)
        opts.detectFn(points);
    if (opts.qrFn)
        opts.qrFn(bits.toImage());
    return decodeBitmap(bits);
}

const pad = (n, z = 2) => ('' + n).padStart(z, '0');

const time = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(
    d.getMilliseconds(),
    3
  )}`;
};

const log = (...txt) => {
  const el = document.querySelector('#log');
  el.innerHTML = `${time()} ${txt.join(' ').replace('\n', '<br>')}<hr>` + el.innerHTML;
};
const error = (...txt) => log('[<span class="qr-error">ERROR</span>]', ...txt);
const ok = (...txt) => log('[<span class="qr-ok">OK</span>]', ...txt);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getSize = (img) => ({
  width: +getComputedStyle(img).width.split('px')[0],
  height: +getComputedStyle(img).height.split('px')[0],
});

function main() {
  const SLEEP_MS = 1; // ms to sleep between detection, to avoid 100% cpu usage
  const TIMEOUT_MS = 500; // if there was no detection for timeout ms - clear overlay

  let lastDetect = Date.now();
  let ctx;
  const canvas = document.createElement('canvas');
  ok('Started');
  const player = document.querySelector('video');
  const overlay = document.querySelector('#overlay');
  const resultTxt = document.querySelector('#resultTxt');
  const resultQr = document.querySelector('#resultQr');
  const isDrawQr = document.querySelector('#isDrawQr');
  const isLogDecoded = document.querySelector('#isLogDecoded');

  const detectFn = (points) => {
    //ok('DETECTED', JSON.stringify(points));
    try {
      lastDetect = Date.now();
      const [tl, tr, br, bl] = points;
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      ctx.fillStyle = 'green';
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.fill();
      ctx.fillStyle = 'blue';
      for (const p of points) {
        // Finder is is pixels
        let x = p.x - 3 * p.moduleSize;
        let y = p.y - 3 * p.moduleSize;
        const size = 7 * p.moduleSize;
        ctx.fillRect(x, y, size, size);
      }
    } catch (e) {
      error('detectFn', e);
    }
  };

  const qrFn = (img) => {
    try {
      if (!isDrawQr.checked) return;
      const { data, height, width } = img;
      resultQr.width = width;
      resultQr.height = height;
      const ctx = resultQr.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      //ok('qrFn', `data=${data.length} h=${height} w=${width}`);
      const imgData = new ImageData(Uint8ClampedArray.from(data), width, height);
      ctx.putImageData(imgData, 0, 0);
      resultQr.style = `image-rendering: pixelated;width: ${8 * width}px; height: ${8 * height}px`;
    } catch (e) {
      error('qrFn', e);
    }
  };

  const overlayLoop = async () => {
    while (true) {
      if (!ctx) {
        await sleep(200);
        continue;
      }
      const { context, width, height } = ctx;
      let ts = Date.now();
      context.drawImage(player, 0, 0, width, height);
      const data = context.getImageData(0, 0, height, width);
      try {
        const res = readQR(data, { detectFn, qrFn });
        if (isLogDecoded.checked) ok('Decoded', `"${res}"`, `${Date.now() - ts} ms`);
        resultTxt.innerText = res;
      } catch (e) {
        if (Date.now() - lastDetect > TIMEOUT_MS) {
          const ctx = overlay.getContext('2d');
          ctx.clearRect(0, 0, overlay.width, overlay.height);
        }
      }
      await sleep(SLEEP_MS);
    }
  };

  document.querySelector('video').addEventListener('play', () => {
    // We won't have correct size until video starts playing
    const { height, width } = getSize(player);
    ok(`Got video feed h=${height} w=${width}`);
    canvas.width = width;
    canvas.height = height;
    overlay.width = width;
    overlay.height = height;
    ctx = { context: canvas.getContext('2d'), height, width };
    overlayLoop();
  });
  document.querySelector('#startBtn').addEventListener('click', async () => {
    try {
      player.setAttribute('autoplay', '');
      player.setAttribute('muted', '');
      player.setAttribute('playsinline', '');
      // Force iOS to use front-facing camera
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // Force bigger resolution
          height: window.screen.height,
          width: window.screen.width,
          facingMode: {
            exact: 'environment',
          },
        },
      });
      player.srcObject = stream;
    } catch (e) {
      error('Media loop', e);
    }
  });
}
window.addEventListener('load', main);
