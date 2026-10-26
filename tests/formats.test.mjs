import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZip, readZip, crc32 } from '../src/zip.js';
import { buildXmpSegment, readXmp, readExif, extractExifSegment } from '../src/metadata.js';
import { JpegEncoder, HUFF } from '../src/jpeg-encoder.js';

test('crc32 connu', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip : écriture puis lecture', async () => {
  const zip = await createZip([
    { name: 'a.txt', data: 'bonjour' },
    { name: 'dossier/é.bin', data: new Uint8Array([1, 2, 3, 255]) },
  ]);
  const entries = await readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'dossier/é.bin']);
  assert.equal(await entries[0].blob.text(), 'bonjour');
  assert.deepEqual([...new Uint8Array(await entries[1].blob.arrayBuffer())], [1, 2, 3, 255]);
});

test('tables de Huffman standard complètes', () => {
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  assert.equal(sum(HUFF.acLumBits), HUFF.acLumVals.length);
  assert.equal(sum(HUFF.acChrBits), HUFF.acChrVals.length);
  assert.equal(HUFF.acLumVals.length, 162);
  assert.equal(new Set(HUFF.acChrVals).size, 162);
});

function encode(w, h, fill, segments = []) {
  const enc = new JpegEncoder(w, h, 90, segments);
  const parts = enc.addRows(new Uint8Array(0), 0);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(fill(i % w, Math.floor(i / w)), i * 4);
  parts.push(...enc.addRows(rgba, h), ...enc.finish());
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test('JPEG : structure, dimensions et XMP photosphère', () => {
  const xmp = buildXmpSegment({ width: 64, height: 32 });
  const jpg = encode(64, 32, (x, y) => [x * 4, y * 8, 128, 255], [xmp]);
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8);
  assert.equal(jpg[jpg.length - 2], 0xff);
  assert.equal(jpg[jpg.length - 1], 0xd9);
  const sof = jpg.findIndex((b, i) => b === 0xff && jpg[i + 1] === 0xc0);
  assert.ok(sof > 0);
  assert.equal((jpg[sof + 5] << 8) | jpg[sof + 6], 32);
  assert.equal((jpg[sof + 7] << 8) | jpg[sof + 8], 64);
  const x = readXmp(jpg);
  assert.match(x, /GPano:ProjectionType="equirectangular"/);
  assert.match(x, /GPano:FullPanoWidthPixels="64"/);
});

test('EXIF : lecture du modèle et de la date, suppression de la vignette', () => {
  // TIFF little-endian minimal : IFD0 { Model, ExifIFD } -> { DateTimeOriginal }, IFD1 présent.
  const model = 'SM-C200\0';
  const date = '2024:07:14 15:30:00\0';
  const t = new Uint8Array(200);
  const dv = new DataView(t.buffer);
  t.set([0x49, 0x49, 0x2a, 0]);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, 2, true);
  const e = (off, tag, type, count, val) => {
    dv.setUint16(off, tag, true);
    dv.setUint16(off + 2, type, true);
    dv.setUint32(off + 4, count, true);
    dv.setUint32(off + 8, val, true);
  };
  e(10, 0x0110, 2, model.length, 60);
  e(22, 0x8769, 4, 1, 80);
  dv.setUint32(34, 150, true); // IFD suivant (vignette)
  t.set(new TextEncoder().encode(model), 60);
  dv.setUint16(80, 1, true);
  e(82, 0x9003, 2, date.length, 100);
  t.set(new TextEncoder().encode(date), 100);
  const seg = new Uint8Array(4 + 6 + t.length);
  seg.set([0xff, 0xe1, (seg.length - 2) >> 8, (seg.length - 2) & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(t, 10);
  const jpg = new Uint8Array([0xff, 0xd8, ...seg, 0xff, 0xda, 0, 2]);
  const info = readExif(jpg);
  assert.equal(info.model, 'SM-C200');
  assert.equal(info.dateTimeOriginal, '2024:07:14 15:30:00');
  assert.equal(new Date(info.takenAt).getFullYear(), 2024);
  const copy = extractExifSegment(jpg);
  assert.equal(new DataView(copy.buffer).getUint32(10 + 34, true), 0);
});
