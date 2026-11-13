// Vérification dans Chromium : parcours partagé (dossier des photos d'origine + photosphere.json +
// photosphere-relief), ouvert sans import, préchargement des photos liées, mémoire vidée en sortant ;
// export « Parcours à partager » ; fichiers de relief jamais importés comme photos.
// Usage : node tests/parcours-check.mjs [dossier-captures]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-parcours-'));
fs.mkdirSync(shots, { recursive: true });
const server = await serve(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) failures++;
};
const db = (fn, arg) => page.evaluate(async ({ fn, arg }) => new Function('db', 'arg', `return (${fn})(db, arg)`)(await import('./src/db.js'), arg), { fn: fn.toString(), arg });
const b64ToFile = (b64, file) => fs.writeFileSync(file, Buffer.from(b64, 'base64'));

// Photo équirectangulaire de test (bandes de couleur numérotées).
async function makePhoto(name, hue) {
  const b64 = await page.evaluate(async (hue) => {
    const c = document.createElement('canvas');
    c.width = 2048;
    c.height = 1024;
    const g = c.getContext('2d');
    for (let k = 0; k < 16; k++) {
      g.fillStyle = `hsl(${hue + k * 12}, 60%, ${30 + (k % 4) * 12}%)`;
      g.fillRect(k * 128, 0, 128, 1024);
    }
    g.fillStyle = '#222';
    g.fillRect(0, 700, 2048, 324);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const u = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  }, hue);
  const file = path.join(shots, 'source', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  b64ToFile(b64, file);
  return file;
}

try {
  await page.goto(base);
  await page.evaluate(async () => (await import('./src/db.js')).putSetting('app', { outWidth: 4096, quality: 85 }));
  await page.reload();
  const files = [await makePhoto('entree.jpg', 0), await makePhoto('salon.jpg', 120), await makePhoto('cuisine.jpg', 240)];
  await page.locator('input[type=file][accept^="image"]').setInputFiles(files);
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 3, null, { timeout: 300000 });

  // Parcours préparé sur « PC » : liens entrée → salon → cuisine, relief (carte de test) sur le salon.
  const prepared = await page.evaluate(async () => {
    const db = await import('./src/db.js');
    const { reliefKey } = await import('./src/depth.js');
    const { depthToPng } = await import('./src/depth-ai.js');
    const { buildSettings } = await import('./src/settings-file.js');
    const { reliefNames } = await import('./src/relief-files.js');
    const ps = await db.listPhotos();
    const by = Object.fromEntries(ps.map((p) => [p.fileName, p]));
    const link = (a, b, yaw) => ({ id: a.id + b.id, target: b.id, yaw, pitch: 0, label: '' });
    // Ordre de prise de vue : entrée, salon, cuisine.
    ['entree.jpg', 'salon.jpg', 'cuisine.jpg'].forEach((f, i) => (by[f].takenAt = 1700000000000 + i * 60000));
    await db.putPhoto({ ...by['entree.jpg'], name: 'Entrée', hotspots: [link(by['entree.jpg'], by['salon.jpg'], 30)] });
    await db.putPhoto({ ...by['salon.jpg'], name: 'Salon', hotspots: [link(by['salon.jpg'], by['entree.jpg'], -150), link(by['salon.jpg'], by['cuisine.jpg'], 90)] });
    await db.putPhoto({ ...by['cuisine.jpg'], name: 'Cuisine', hotspots: [link(by['cuisine.jpg'], by['salon.jpg'], -90)] });
    // Carte de relief de test : pièce à 2 hauteurs d'objectif, objet proche au centre.
    const W = 2048, H = 1024, depth = new Float32Array(W * H).fill(2);
    for (let y = 450; y < 600; y++) for (let x = 900; x < 1150; x++) depth[y * W + x] = 0.6;
    const png = await depthToPng(depth);
    const s = by['salon.jpg'];
    await db.putBlob(s.id + ':depth', png);
    await db.updatePhoto(s.id, (cur) => ({ ...cur, relief: { kind: 'ai', h: 1.6, key: reliefKey(cur.params) } }));
    const b64 = async (b) => {
      const u = new Uint8Array(await b.arrayBuffer());
      let t = '';
      for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(t);
    };
    const settings = buildSettings(await db.listPhotos(), await db.getPlanDrawing());
    return { json: JSON.stringify(settings), depthName: reliefNames('salon.jpg').depth, depth: await b64(png) };
  });
  const folder = path.join(shots, 'onedrive');
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(path.join(folder, 'photosphere-relief'), { recursive: true });
  for (const f of files) fs.copyFileSync(f, path.join(folder, path.basename(f)));
  fs.writeFileSync(path.join(folder, 'photosphere.json'), prepared.json);
  b64ToFile(prepared.depth, path.join(folder, 'photosphere-relief', prepared.depthName));
  const folderFiles = [...files.map((f) => path.join(folder, path.basename(f))), path.join(folder, 'photosphere.json'), path.join(folder, 'photosphere-relief', prepared.depthName)];

  // Export « Parcours à partager » : json + reliefs dans un ZIP.
  await page.click('[data-act=menu]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act=export-parcours]')]);
  const zipPath = path.join(shots, 'parcours.zip');
  await dl.saveAs(zipPath);
  const names = await page.evaluate(async (b64) => {
    const { readZip } = await import('./src/zip.js');
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return (await readZip(new Blob([bin]))).map((e) => e.name);
  }, fs.readFileSync(zipPath).toString('base64'));
  check(names.includes('photosphere.json') && names.includes('photosphere-relief/salon.jpg.profondeur.png'), `export « Parcours à partager » : ${names.join(', ')}`);

  // Fichiers de relief jamais importés comme photos.
  const countBefore = await db(async (db) => (await db.listPhotos()).length);
  await page.locator('input[type=file][accept^="image"]').setInputFiles([path.join(folder, 'photosphere-relief', prepared.depthName)]);
  await page.waitForTimeout(1500);
  check((await db(async (db) => (await db.listPhotos()).length)) === countBefore, 'import : les cartes de relief ne sont pas prises pour des photos');

  // ---------- visualisation du parcours, sans import ----------
  await page.click('[data-act=parcours]');
  await page.waitForSelector('.parcours-page');
  await page.screenshot({ path: path.join(shots, '01-page-parcours.png') });
  const t0 = Date.now();
  await page.locator('input[type=file][multiple]:not([accept]):not([webkitdirectory])').setInputFiles(folderFiles);
  await page.waitForSelector('.ps-player canvas');
  await page.waitForFunction(() => document.querySelector('.ps-title').textContent.length > 0);
  await page.waitForTimeout(800);
  const title0 = await page.textContent('.ps-title');
  check(title0 === 'Entrée', `parcours ouvert sur la première photo du parcours (« ${title0} », ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  // Préchargement : la photo liée (salon) et sa carte de relief sont déjà en mémoire.
  await page.waitForFunction(() => window.photosphereParcours && window.photosphereParcours.cache.has('salon.jpg'), null, { timeout: 15000 }).catch(() => {});
  const pre = await page.evaluate(() => ({ salon: window.photosphereParcours.cache.has('salon.jpg'), relief: window.photosphereParcours.cache.has('salon.jpg.profondeur.png'), cuisine: window.photosphereParcours.cache.has('cuisine.jpg') }));
  check(pre.salon && pre.relief && !pre.cuisine, `préchargement des photos liées seulement : ${JSON.stringify(pre)}`);
  // Photo suivante (déjà en mémoire) : affichage rapide.
  const t1 = Date.now();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((t) => document.querySelector('.ps-title').textContent !== t, title0, { timeout: 10000 });
  const dt = Date.now() - t1;
  const title1 = await page.textContent('.ps-title');
  check(title1 === 'Salon', `photo suivante affichée (« ${title1} » en ${dt} ms)`);
  await page.waitForTimeout(800);
  const pre2 = await page.evaluate(() => window.photosphereParcours.cache.has('cuisine.jpg'));
  check(pre2, 'depuis le salon, la cuisine (liée) est préchargée à son tour');
  // Relief disponible pour le salon dans le casque.
  await page.click('[data-mode=cardboard]');
  await page.waitForTimeout(1200);
  const gap = await page.$eval('.ps-player', (el) => el.dataset.eyeGap);
  check(gap && +gap > 0, `relief du parcours utilisé dans le casque (écart des yeux ${gap} cm)`);
  await page.screenshot({ path: path.join(shots, '02-parcours-casque.png') });
  await page.click('.ps-exit-vr').catch(() => {});
  await page.waitForTimeout(300);
  // Sortie : mémoire vidée, rien d'importé.
  await page.click('.ps-back');
  await page.waitForSelector('.parcours-page');
  const after = await page.evaluate(() => window.photosphereParcours.cache.size);
  check(after === 0, 'en sortant, les photos du parcours sont oubliées (mémoire vidée)');
  check((await db(async (db) => (await db.listPhotos()).length)) === countBefore, 'aucune photo du parcours ajoutée à la bibliothèque');
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}
check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
