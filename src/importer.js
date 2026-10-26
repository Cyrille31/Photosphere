// Import des photos (carte micro SD, galerie du téléphone, glisser-déposer) et file de conversion.
import { decodeImage, DEFAULT_LENS_PARAMS } from './gl-source.js';
import { readExif, extractExifSegment, buildXmpSegment } from './metadata.js';
import { renderPanorama } from './exporter.js';
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

// Détecte un double fisheye (coins noirs autour de deux cercles) et estime les cercles.
export function analyzeImage(img) {
  const W = 512, H = 256, S = 256, c = 18;
  const { data } = sample(img, W, H);
  let maxCorner = 0, minCenter = 255;
  for (const ox of [0, S]) {
    for (const [x, y] of [[0, 0], [S - c, 0], [0, H - c], [S - c, H - c]]) maxCorner = Math.max(maxCorner, meanLum(data, W, ox + x, y, c));
    minCenter = Math.min(minCenter, meanLum(data, W, ox + S / 2 - 30, H / 2 - 30, 60));
  }
  const fisheye = maxCorner < 20 && minCenter > maxCorner + 12;
  return { type: fisheye ? 'fisheye' : 'equirect', lenses: fisheye ? detectCircles(data, W, H) : null };
}

export function detectCircles(data, W, H) {
  const S = H;
  const res = [];
  for (const ox of [0, S]) {
    let minX = S, maxX = -1, minY = S, maxY = -1;
    for (let y = 0; y < S; y++) {
      let first = -1, last = -1, count = 0;
      for (let x = 0; x < S; x++) {
        if (lumAt(data, W, ox + x, y) > 22) {
          if (first < 0) first = x;
          last = x;
          count++;
        }
      }
      if (count > 4) {
        minX = Math.min(minX, first);
        maxX = Math.max(maxX, last);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < 0) return null;
    const lens = {
      cx: (minX + maxX + 1) / 2 / S,
      cy: (minY + maxY + 1) / 2 / S,
      r: Math.max(maxX - minX + 1, maxY - minY + 1) / 2 / S,
      rot: 0,
    };
    if (lens.r < 0.35 || lens.r > 0.56 || Math.abs(lens.cx - 0.5) > 0.08 || Math.abs(lens.cy - 0.5) > 0.08) return null;
    res.push(lens);
  }
  return { lensA: res[0], lensB: res[1] };
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
        params: { yaw: 0, pitch: 0, roll: 0, ...lens, ...(analysis.lenses || {}) },
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
