// Exports : visite autonome en un seul fichier HTML, ZIP de JPEG, sauvegarde / restauration du projet.
import * as db from './db.js';
import { createZip, readZip } from './zip.js';
import { decodeImage } from './gl-source.js';

// Modules de la visionneuse, concaténés dans la page exportée (pas d'import possible en file://).
const PLAYER_MODULES = ['math.js', 'shaders.js', 'gl-source.js', 'renderer.js', 'controls.js', 'player.js'];

export async function bundlePlayer() {
  const sources = await Promise.all(PLAYER_MODULES.map((m) => fetch(new URL(m, import.meta.url)).then((r) => r.text())));
  const code = sources
    .map((s, i) => `// --- ${PLAYER_MODULES[i]} ---\n` + s.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, ''))
    .join('\n');
  const css = await fetch(new URL('../player.css', import.meta.url)).then((r) => r.text());
  return { code, css };
}

async function downscale(blob, maxWidth, quality) {
  const img = await decodeImage(blob);
  const w = Math.min(maxWidth, img.width);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = w / 2;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (img.close) img.close();
  const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  c.width = c.height = 1;
  return out;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Visite autonome : un seul fichier .html qui s'ouvre sur n'importe quel smartphone ou ordinateur.
export async function exportTourHtml(photos, { title, startId, maxWidth = 4096, onProgress }) {
  const { code, css } = await bundlePlayer();
  const items = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (onProgress) onProgress(i, photos.length, p.name);
    const out = await db.getBlob(p.id + ':out');
    if (!out) throw new Error(`« ${p.name} » n’est pas encore convertie.`);
    const small = await downscale(out, maxWidth, 0.85);
    items.push({
      id: p.id,
      name: p.name,
      src: await blobToDataUrl(small),
      hotspots: (p.hotspots || []).map(({ target, yaw, pitch, label }) => ({ target, yaw, pitch, label })),
    });
  }
  const ids = new Set(items.map((p) => p.id));
  items.forEach((p) => (p.hotspots = p.hotspots.filter((h) => ids.has(h.target))));
  const data = JSON.stringify({ title, startId, photos: items }).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1020">
<title>${escapeHtml(title)}</title>
<style>html,body{margin:0;height:100%;background:#0b1020;overflow:hidden;font-family:system-ui,sans-serif}
${css}</style>
</head>
<body>
<script id="tour-data" type="application/json">${data}</script>
<script>
(function () {
'use strict';
${code}
const data = JSON.parse(document.getElementById('tour-data').textContent);
createPlayer(document.body, { photos: data.photos, startId: data.startId, title: data.title });
})();
</script>
</body>
</html>`;
  if (onProgress) onProgress(photos.length, photos.length, '');
  return new Blob([html], { type: 'text/html' });
}

function safeName(s) {
  return s.replace(/[\\/:*?"<>|]+/g, '_');
}

export async function exportJpegZip(photos, onProgress) {
  const files = [];
  const used = new Set();
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (onProgress) onProgress(i, photos.length, p.name);
    const out = await db.getBlob(p.id + ':out');
    if (!out) continue;
    let name = safeName(p.name) + '.jpg';
    for (let n = 2; used.has(name); n++) name = `${safeName(p.name)}_${n}.jpg`;
    used.add(name);
    files.push({ name, data: out });
  }
  return createZip(files);
}

// Sauvegarde complète (originaux + conversions + liens) pour passer du PC au téléphone.
export async function exportProject(photos, onProgress) {
  const files = [{ name: 'photosphere-project.json', data: JSON.stringify({ version: 1, photos }, null, 1) }];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (onProgress) onProgress(i, photos.length, p.name);
    for (const kind of ['orig', 'out', 'thumb']) {
      const b = await db.getBlob(`${p.id}:${kind}`);
      if (b) files.push({ name: `${p.id}/${kind}.jpg`, data: b });
    }
  }
  return createZip(files);
}

export async function importProject(file, onProgress) {
  const entries = await readZip(file);
  const index = entries.find((e) => e.name === 'photosphere-project.json');
  if (!index) throw new Error('Ce fichier n’est pas une sauvegarde PhotoSphère.');
  const project = JSON.parse(await index.blob.text());
  const byName = new Map(entries.map((e) => [e.name, e.blob]));
  const existing = new Set((await db.listPhotos()).map((p) => p.id));
  let added = 0;
  for (let i = 0; i < project.photos.length; i++) {
    const p = project.photos[i];
    if (onProgress) onProgress(i, project.photos.length, p.name);
    for (const kind of ['orig', 'out', 'thumb']) {
      const b = byName.get(`${p.id}/${kind}.jpg`);
      if (b) await db.putBlob(`${p.id}:${kind}`, new Blob([b], { type: 'image/jpeg' }));
    }
    const hasOut = byName.has(`${p.id}/out.jpg`);
    await db.putPhoto({ ...p, status: hasOut ? p.status : 'pending' });
    if (!existing.has(p.id)) added++;
  }
  return { total: project.photos.length, added };
}
