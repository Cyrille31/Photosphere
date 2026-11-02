// Import des photos (carte micro SD, galerie du téléphone, glisser-déposer) et file de conversion.
import { decodeImage, DEFAULT_LENS_PARAMS } from './gl-source.js';
import { readExif, extractExifSegment, buildXmpSegment } from './metadata.js';
import { renderPanorama } from './exporter.js';
import { autoCalibrate } from './calibrate.js';
import * as db from './db.js';

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function sample(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas: c, data: ctx.getImageData(0, 0, w, h).data };
}

function lumAt(data, w, x, y) {
  const i = (y * w + x) * 4;
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

function meanLum(data, w, x0, y0, size) {
  let s = 0;
  for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) s += lumAt(data, w, x, y);
  return s / (size * size);
}

// Détecte un double fisheye (coins noirs autour de deux cercles).
export function analyzeImage(img) {
  const W = 512, H = 256, S = 256, c = 18;
  const { data } = sample(img, W, H);
  let maxCorner = 0, minCenter = 255;
  for (const ox of [0, S]) {
    for (const [x, y] of [[0, 0], [S - c, 0], [0, H - c], [S - c, H - c]]) maxCorner = Math.max(maxCorner, meanLum(data, W, ox + x, y, c));
    minCenter = Math.min(minCenter, meanLum(data, W, ox + S / 2 - 30, H / 2 - 30, 60));
  }
  return { type: maxCorner < 20 && minCenter > maxCorner + 12 ? 'fisheye' : 'equirect' };
}

// Les deux moitiés de l'image en RGB flottant, réduites à `size` pixels de côté.
function rgbHalves(img, size) {
  const { data } = sample(img, size * 2, size);
  const halves = [0, 1].map(() => ({ size, data: new Float32Array(size * size * 3) }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size * 2; x++) {
      const h = halves[x < size ? 0 : 1];
      const i = (y * size * 2 + x) * 4, o = (y * size + (x % size)) * 3;
      h.data[o] = data[i];
      h.data[o + 1] = data[i + 1];
      h.data[o + 2] = data[i + 2];
    }
  }
  return halves;
}

// Calibrage automatique (objectifs + exposition) à partir de la photo brute.
export async function calibrateFromBlob(blob, params) {
  const img = await decodeImage(blob);
  const [A, B] = rgbHalves(img, 1000);
  if (img.close) img.close();
  return autoCalibrate(A, B, { ...DEFAULT_LENS_PARAMS, ...params });
}

export async function lensDefaults(model) {
  return (await db.getSetting('lens:' + (model || 'default'))) || (await db.getSetting('lens:default')) || DEFAULT_LENS_PARAMS;
}

function isImageFile(f) {
  return /^image\/(jpeg|pjpeg)$/.test(f.type) || /\.(jpe?g)$/i.test(f.name);
}

// Renvoie { added: [...], skipped: [{ name, reason }] }
export async function importFiles(files, onProgress) {
  const existing = await db.listPhotos();
  const known = new Set(existing.map((p) => p.fileName + ':' + p.fileSize));
  const added = [], skipped = [];
  const list = [...files].filter((f) => {
    if (isImageFile(f)) return true;
    if (!/^\./.test(f.name)) skipped.push({ name: f.name, reason: 'format non pris en charge (JPEG uniquement)' });
    return false;
  });
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (onProgress) onProgress(i, list.length, f.name);
    if (known.has(f.name + ':' + f.size)) {
      skipped.push({ name: f.name, reason: 'déjà importée' });
      continue;
    }
    try {
      const bytes = new Uint8Array(await f.slice(0, 256 * 1024).arrayBuffer());
      const exif = readExif(bytes);
      const img = await decodeImage(f);
      const w = img.width, h = img.height;
      if (Math.abs(w / h - 2) > 0.03) {
        if (img.close) img.close();
        skipped.push({ name: f.name, reason: `format ${w}×${h} : une photosphère doit être au rapport 2:1` });
        continue;
      }
      const analysis = analyzeImage(img);
      const preview = sample(img, 1024, 512).canvas;
      if (img.close) img.close();
      const lens = await lensDefaults(exif.model);
      const id = newId();
      const photo = {
        id,
        name: f.name.replace(/\.[^.]+$/, ''),
        fileName: f.name,
        fileSize: f.size,
        createdAt: Date.now(),
        takenAt: exif.takenAt || f.lastModified || Date.now(),
        model: exif.model || '',
        srcType: analysis.type,
        srcWidth: w,
        srcHeight: h,
        params: { yaw: 0, pitch: 0, roll: 0, ...lens },
        layout: 2,
        hotspots: [],
        status: 'pending',
      };
      await db.putBlob(id + ':orig', f);
      await db.putBlob(id + ':thumb', await new Promise((r) => preview.toBlob(r, 'image/jpeg', 0.8)));
      await db.putPhoto(photo);
      added.push(photo);
    } catch (e) {
      skipped.push({ name: f.name, reason: e.message });
    }
  }
  if (onProgress) onProgress(list.length, list.length, '');
  return { added, skipped };
}

export async function convertPhoto(photo, settings, onProgress) {
  const orig = await db.getBlob(photo.id + ':orig');
  if (!orig) throw new Error('Fichier original introuvable');
  if (photo.srcType === 'fisheye' && !photo.params.autoCalibrated) {
    const patch = await calibrateFromBlob(orig, photo.params);
    const cur = await db.getPhoto(photo.id);
    photo = { ...cur, params: { ...cur.params, ...patch, autoCalibrated: true } };
    await db.putPhoto(photo);
  }
  const head = new Uint8Array(await orig.slice(0, 256 * 1024).arrayBuffer());
  const segments = [];
  const exif = extractExifSegment(head);
  if (exif) segments.push(exif);
  const width = settings.outWidth || 7776;
  const height = width / 2;
  segments.push(buildXmpSegment({ width, height }));
  const { blob, thumb } = await renderPanorama({
    src: orig,
    srcType: photo.srcType,
    params: photo.params,
    width,
    height,
    quality: settings.quality || 92,
    segments,
    onProgress,
  });
  await db.putBlob(photo.id + ':out', blob);
  await db.putBlob(photo.id + ':thumb', thumb);
  const cur = await db.getPhoto(photo.id);
  if (!cur) throw new Error('Photo supprimée pendant la conversion');
  // Si la photo a été modifiée pendant la conversion, elle reste à reconvertir.
  const same = cur.srcType === photo.srcType && JSON.stringify(cur.params) === JSON.stringify(photo.params);
  const updated = { ...cur, status: same ? 'done' : 'pending', outWidth: width, outSize: blob.size, convertedAt: Date.now() };
  await db.putPhoto(updated);
  return updated;
}
