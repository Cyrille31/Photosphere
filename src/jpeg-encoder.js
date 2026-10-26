// Encodeur JPEG baseline (YCbCr 4:2:0) alimenté par bandes, pour produire de très grandes
// images (7776 x 3888) sans passer par un canvas géant (limité à ~16 Mpx sur iPhone).

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const STD_LUM_QT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

const STD_CHR_QT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

export const HUFF = {
  dcLumBits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  dcLumVals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  dcChrBits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  dcChrVals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  acLumBits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  acLumVals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1,
    0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
    0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85,
    0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
    0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
    0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
    0xfa,
  ],
  acChrBits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  acChrVals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42,
    0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19,
    0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
    0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83,
    0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
    0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
    0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
    0xfa,
  ],
};

function buildHuffman(bits, vals) {
  const code = new Uint16Array(256), len = new Uint8Array(256);
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < bits[l - 1]; i++) {
      code[vals[k]] = c;
      len[vals[k]] = l;
      k++;
      c++;
    }
    c <<= 1;
  }
  return { code, len };
}

function scaleQuant(base, quality) {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

// Matrice DCT orthonormée 8x8.
const DCT = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  const a = u === 0 ? Math.SQRT1_2 : 1;
  for (let x = 0; x < 8; x++) DCT[u * 8 + x] = 0.5 * a * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
}

class ByteSink {
  constructor() {
    this.chunks = [];
    this.buf = new Uint8Array(1 << 20);
    this.pos = 0;
  }
  byte(b) {
    if (this.pos === this.buf.length) this.flush();
    this.buf[this.pos++] = b;
  }
  bytes(arr) {
    for (let i = 0; i < arr.length; i++) this.byte(arr[i]);
  }
  word(w) {
    this.byte((w >> 8) & 0xff);
    this.byte(w & 0xff);
  }
  flush() {
    if (this.pos) this.chunks.push(this.buf.slice(0, this.pos));
    this.pos = 0;
  }
  take() {
    this.flush();
    const c = this.chunks;
    this.chunks = [];
    return c;
  }
}

export class JpegEncoder {
  // segments : segments APP déjà formés (Uint8Array, marqueur compris) à insérer après SOI.
  constructor(width, height, quality = 92, segments = []) {
    this.width = width;
    this.height = height;
    this.qLum = scaleQuant(STD_LUM_QT, quality);
    this.qChr = scaleQuant(STD_CHR_QT, quality);
    this.fLum = new Float64Array(64);
    this.fChr = new Float64Array(64);
    for (let i = 0; i < 64; i++) {
      this.fLum[i] = 1 / this.qLum[i];
      this.fChr[i] = 1 / this.qChr[i];
    }
    this.dcLum = buildHuffman(HUFF.dcLumBits, HUFF.dcLumVals);
    this.dcChr = buildHuffman(HUFF.dcChrBits, HUFF.dcChrVals);
    this.acLum = buildHuffman(HUFF.acLumBits, HUFF.acLumVals);
    this.acChr = buildHuffman(HUFF.acChrBits, HUFF.acChrVals);
    this.out = new ByteSink();
    this.bitBuf = 0;
    this.bitCnt = 0;
    this.prevDC = [0, 0, 0];
    this.rowsDone = 0;
    this.blk = new Float64Array(64);
    this.tmp = new Float64Array(64);
    this.coef = new Int32Array(64);
    this._writeHeaders(segments);
  }

  _writeHeaders(segments) {
    const o = this.out;
    o.word(0xffd8);
    const hasExif = segments.some((s) => s[1] === 0xe1 && s[4] === 0x45 && s[5] === 0x78);
    if (!hasExif) o.bytes([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    segments.forEach((s) => o.bytes(s));
    o.word(0xffdb);
    o.word(132);
    o.byte(0);
    for (let k = 0; k < 64; k++) o.byte(this.qLum[ZIGZAG[k]]);
    o.byte(1);
    for (let k = 0; k < 64; k++) o.byte(this.qChr[ZIGZAG[k]]);
    o.word(0xffc0);
    o.word(17);
    o.byte(8);
    o.word(this.height);
    o.word(this.width);
    o.bytes([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const dht = (cls, bits, vals) => {
      o.word(0xffc4);
      o.word(3 + 16 + vals.length);
      o.byte(cls);
      o.bytes(bits);
      o.bytes(vals);
    };
    dht(0x00, HUFF.dcLumBits, HUFF.dcLumVals);
    dht(0x10, HUFF.acLumBits, HUFF.acLumVals);
    dht(0x01, HUFF.dcChrBits, HUFF.dcChrVals);
    dht(0x11, HUFF.acChrBits, HUFF.acChrVals);
    o.word(0xffda);
    o.word(12);
    o.bytes([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  }

  _bits(code, len) {
    this.bitBuf = (this.bitBuf << len) | code;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      const b = (this.bitBuf >>> (this.bitCnt - 8)) & 0xff;
      this.out.byte(b);
      if (b === 0xff) this.out.byte(0);
      this.bitCnt -= 8;
    }
    this.bitBuf &= (1 << this.bitCnt) - 1;
  }

  _block(fq, dcT, acT, comp) {
    const b = this.blk, t = this.tmp, C = DCT, q = this.coef;
    // DCT 2D séparable : t = C * b, puis F = t * C^T
    for (let u = 0; u < 8; u++) {
      for (let x = 0; x < 8; x++) {
        let s = 0;
        for (let k = 0; k < 8; k++) s += C[u * 8 + k] * b[k * 8 + x];
        t[u * 8 + x] = s;
      }
    }
    for (let u = 0; u < 8; u++) {
      for (let v = 0; v < 8; v++) {
        let s = 0;
        for (let k = 0; k < 8; k++) s += t[u * 8 + k] * C[v * 8 + k];
        q[u * 8 + v] = Math.round(s * fq[u * 8 + v]);
      }
    }
    const dc = q[0];
    let diff = dc - this.prevDC[comp];
    this.prevDC[comp] = dc;
    this._value(diff, dcT, 0);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = q[ZIGZAG[k]];
      if (v === 0) {
        run++;
        continue;
      }
      while (run > 15) {
        this._bits(acT.code[0xf0], acT.len[0xf0]);
        run -= 16;
      }
      this._value(v, acT, run);
      run = 0;
    }
    if (run > 0) this._bits(acT.code[0], acT.len[0]);
  }

  _value(v, table, run) {
    const a = v < 0 ? -v : v;
    let cat = 0;
    while (a >> cat) cat++;
    const sym = (run << 4) | cat;
    this._bits(table.code[sym], table.len[sym]);
    if (cat) this._bits(v < 0 ? v + (1 << cat) - 1 : v, cat);
  }

  // rgba : pixels RGBA de `rows` lignes complètes (multiple de 16 sauf pour la dernière bande).
  addRows(rgba, rows) {
    const W = this.width;
    const mcuRows = Math.ceil(rows / 16);
    const b = this.blk;
    const cb = new Float64Array(64), cr = new Float64Array(64);
    for (let my = 0; my < mcuRows; my++) {
      for (let mx = 0; mx < W; mx += 16) {
        cb.fill(0);
        cr.fill(0);
        for (let by = 0; by < 2; by++) {
          for (let bx = 0; bx < 2; bx++) {
            for (let y = 0; y < 8; y++) {
              const py = Math.min(rows - 1, my * 16 + by * 8 + y);
              for (let x = 0; x < 8; x++) {
                const px = Math.min(W - 1, mx + bx * 8 + x);
                const i = (py * W + px) * 4;
                const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
                b[y * 8 + x] = 0.299 * R + 0.587 * G + 0.114 * B - 128;
                const ci = (by * 4 + (y >> 1)) * 8 + bx * 4 + (x >> 1);
                cb[ci] += -0.168736 * R - 0.331264 * G + 0.5 * B;
                cr[ci] += 0.5 * R - 0.418688 * G - 0.081312 * B;
              }
            }
            this._block(this.fLum, this.dcLum, this.acLum, 0);
          }
        }
        for (let i = 0; i < 64; i++) b[i] = cb[i] * 0.25;
        this._block(this.fChr, this.dcChr, this.acChr, 1);
        for (let i = 0; i < 64; i++) b[i] = cr[i] * 0.25;
        this._block(this.fChr, this.dcChr, this.acChr, 2);
      }
    }
    this.rowsDone += rows;
    return this.out.take();
  }

  finish() {
    if (this.bitCnt > 0) this._bits((1 << (8 - this.bitCnt)) - 1, 8 - this.bitCnt);
    this.out.word(0xffd9);
    return this.out.take();
  }
}
