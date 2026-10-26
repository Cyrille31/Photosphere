// Vérification de bout en bout dans Chromium : génère une fausse photo Gear 360 (double fisheye),
// l'importe, vérifie l'assemblage 7776 x 3888, l'éditeur, la visionneuse (dont le mode casque)
// et la visite autonome exportée. Usage : node tests/browser-check.mjs [dossier-captures]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from './serve.mjs';
import { levelMatrix, mat3Apply, mat3Transpose, dirFromLonLat, lonLatFromDir } from '../src/math.js';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-'));
fs.mkdirSync(shots, { recursive: true });

const server = await serve(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) failures++;
};

// Scène de test : 8 secteurs colorés en longitude, plus clair en haut, plus sombre en bas.
const SCENE = `
  const PAL = [[230,40,40],[240,150,30],[230,230,40],[60,200,60],[40,200,220],[50,80,230],[150,60,220],[230,60,170]];
  function scene(lon, lat) {
    const k = Math.min(7, Math.floor((lon + Math.PI) / (Math.PI / 4)));
    const c = PAL[k];
    const f = lat > 0.6 ? 1.25 : lat < -0.6 ? 0.55 : 1;
    return c.map((v) => Math.min(255, v * f));
  }`;

async function makeFisheye(w) {
  return page.evaluate(
    async ({ w, SCENE }) => {
      eval(SCENE + ';window.scene = scene;');
      const h = w / 2, S = h, fovHalf = (195 / 2) * Math.PI / 180;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const back = x >= S;
          const dx = ((x % S) + 0.5 - S / 2) / (S / 2), dy = (y + 0.5 - S / 2) / (S / 2);
          const r = Math.hypot(dx, dy);
          const i = (y * w + x) * 4;
          img.data[i + 3] = 255;
          if (r > 1) continue;
          const th = r * fovHalf, a = Math.atan2(-dy, dx);
          const st = Math.sin(th);
          const d = back ? [-st * Math.cos(a), st * Math.sin(a), -Math.cos(th)] : [st * Math.cos(a), st * Math.sin(a), Math.cos(th)];
          const col = window.scene(Math.atan2(d[0], d[2]), Math.asin(d[1]));
          img.data.set(col, i);
        }
      }
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { w, SCENE }
  );
}

try {
  console.log('Chargement de l’application');
  await page.goto(base);
  await page.waitForSelector('.empty');
  await page.screenshot({ path: path.join(shots, '01-accueil.png') });
  check(await page.locator('text=Bienvenue dans PhotoSphère').isVisible(), 'écran d’accueil affiché');

  console.log('Import d’une photo Gear 360 simulée (double fisheye 3888 x 1944)');
  const fishFile = path.join(shots, 'SAM_0001.JPG');
  fs.writeFileSync(fishFile, Buffer.from(await makeFisheye(3888), 'base64'));
  await page.locator('input[type=file][accept^="image"]').setInputFiles(fishFile);
  await page.waitForSelector('.card', { timeout: 60000 });
  check((await page.locator('.card .badge').first().textContent()).includes('Double fisheye'), 'double fisheye détecté');
  await page.waitForSelector('.badge.ok', { timeout: 180000 });
  check((await page.locator('.badge.ok').first().textContent()).includes('7776 × 3888'), 'converti en 7776 × 3888');

  const result = await page.evaluate(async (SCENE) => {
    eval(SCENE + ';window.scene = scene;');
    const db = await import('./src/db.js');
    const meta = await import('./src/metadata.js');
    const [p] = await db.listPhotos();
    const out = await db.getBlob(p.id + ':out');
    const bytes = new Uint8Array(await out.arrayBuffer());
    const bmp = await createImageBitmap(out);
    const c = document.createElement('canvas');
    c.width = 1944;
    c.height = 972;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    let bad = 0, total = 0, maxErr = 0;
    for (let k = 0; k < 8; k++) {
      for (const lat of [-1.0, -0.3, 0, 0.3, 1.0]) {
        const lon = -Math.PI + (k + 0.5) * (Math.PI / 4);
        const x = Math.round((lon / (2 * Math.PI) + 0.5) * c.width);
        const y = Math.round((0.5 - lat / Math.PI) * c.height);
        const px = ctx.getImageData(x, y, 1, 1).data;
        const exp = window.scene(lon, lat);
        const err = Math.max(...exp.map((v, i) => Math.abs(v - px[i])));
        maxErr = Math.max(maxErr, err);
        total++;
        if (err > 30) bad++;
      }
    }
    return { w: bmp.width, h: bmp.height, bad, total, maxErr, xmp: meta.readXmp(bytes), size: out.size, id: p.id, lens: p.params.lensA };
  }, SCENE);
  check(result.w === 7776 && result.h === 3888, `JPEG décodable, ${result.w} × ${result.h}, ${(result.size / 1e6).toFixed(1)} Mo`);
  check(result.bad === 0, `assemblage fidèle à la scène (${result.total - result.bad}/${result.total} points, écart max ${result.maxErr})`);
  check(/GPano:ProjectionType="equirectangular"/.test(result.xmp || ''), 'métadonnées XMP photosphère présentes');
  check(Math.abs(result.lens.r - 0.5) < 0.02, `cercle de l’objectif détecté (r = ${result.lens.r.toFixed(3)})`);

  console.log('Import d’une photo déjà équirectangulaire (téléphone)');
  const eqFile = path.join(shots, 'phone_360.jpg');
  const eqB64 = await page.evaluate(async (SCENE) => {
    eval(SCENE);
    const c = document.createElement('canvas');
    c.width = 2048;
    c.height = 1024;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 2048; x += 4)
      for (let y = 0; y < 1024; y += 4) {
        const col = scene((x / 2048 - 0.5) * 2 * Math.PI, (0.5 - y / 1024) * Math.PI);
        ctx.fillStyle = `rgb(${col.join(',')})`;
        ctx.fillRect(x, y, 4, 4);
      }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, SCENE);
  fs.writeFileSync(eqFile, Buffer.from(eqB64, 'base64'));
  await page.locator('input[type=file][accept^="image"]').setInputFiles(eqFile);
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 180000 });
  check((await page.locator('.card').nth(1).locator('.badge').first().textContent()).includes('Équirectangulaire'), 'photo équirectangulaire reconnue et convertie');
  await page.screenshot({ path: path.join(shots, '02-bibliotheque.png') });

  console.log('Éditeur');
  await page.goto(base + '#/edit/' + result.id);
  await page.waitForSelector('.editor canvas');
  await page.waitForFunction(() => document.querySelector('.ed-hint').hidden, null, { timeout: 30000 });
  await page.fill('.slider input[type=number][name=roll]', '6');
  await page.dispatchEvent('.slider input[type=number][name=roll]', 'input');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '03-editeur-3d.png') });
  await page.click('[data-view=flat]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '04-editeur-plat.png') });
  // Outil horizon : deux clics sur la ligne médiane de la vue à plat (horizon actuel penché de 6°).
  await page.click('[data-tool=horizon]');
  const box = await page.locator('.editor canvas').boundingBox();
  const fw = Math.min(box.width, box.height * 2), fh = fw / 2;
  const top = box.y + (box.height - fh) / 2, left = box.x + (box.width - fw) / 2;
  // Le vrai horizon (équateur de la source) vu dans la sortie actuelle penchée de 6°.
  const Rt = mat3Transpose(levelMatrix(0, 0, 6));
  for (const lon of [-0.4, 1.2]) {
    const ll = lonLatFromDir(mat3Apply(Rt, dirFromLonLat(lon, 0)));
    await page.mouse.click(left + fw * (ll.lon / (2 * Math.PI) + 0.5), top + fh * (0.5 - ll.lat / Math.PI));
  }
  await page.waitForTimeout(200);
  const roll = await page.inputValue('.slider input[type=number][name=roll]');
  const pitch = await page.inputValue('.slider input[type=number][name=pitch]');
  check(Math.abs(+roll) < 0.6 && Math.abs(+pitch) < 0.6, `outil horizon : roulis ${roll}°, bascule ${pitch}° (attendu ≈ 0)`);
  // Lien vers la deuxième photo
  await page.click('[data-tab=links]');
  await page.click('[data-add-link]');
  await page.mouse.click(left + fw * 0.6, top + fh * 0.55);
  await page.click('dialog [data-ok]');
  check((await page.locator('.link-item').count()) === 1, 'lien créé');
  await page.click('[data-save]');
  await page.waitForSelector('.grid');
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 180000 });
  const links = await page.evaluate(async () => {
    const db = await import('./src/db.js');
    return (await db.listPhotos()).map((p) => p.hotspots.length);
  });
  check(links.join() === '1,1', 'lien aller et lien retour enregistrés');

  console.log('Visionneuse');
  await page.goto(base + '#/view/' + result.id);
  await page.waitForSelector('.ps-player canvas');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, '05-visionneuse.png') });
  // Simule un téléphone tenu en mode paysage (capteurs d'orientation).
  await page.evaluate(() => {
    window.__orient = setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 20, beta: 90, gamma: 0 })), 50);
  });
  await page.click('.ps-mode[data-mode=cardboard]');
  await page.waitForTimeout(1200);
  check(await page.locator('.ps-player.stereo').count() === 1, 'mode casque VR (écran partagé) activé');
  await page.screenshot({ path: path.join(shots, '06-casque-vr.png') });
  await page.click('.ps-exit-vr');
  await page.click('.ps-mode[data-mode=gyro]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, '07-bout-de-bras.png') });

  console.log('Visite autonome');
  const html = await page.evaluate(async (startId) => {
    const db = await import('./src/db.js');
    const { exportTourHtml } = await import('./src/tour-export.js');
    const photos = await db.listPhotos();
    const blob = await exportTourHtml(photos, { title: 'Test', startId, maxWidth: 2048 });
    return blob.text();
  }, result.id);
  const tourFile = path.join(shots, 'visite.html');
  fs.writeFileSync(tourFile, html);
  const tour = await ctx.newPage();
  const tourErrors = [];
  tour.on('pageerror', (e) => tourErrors.push(e.message));
  await tour.goto('file://' + tourFile);
  await tour.waitForSelector('.ps-player canvas');
  await tour.waitForTimeout(1500);
  await tour.screenshot({ path: path.join(shots, '08-visite-autonome.png') });
  const before = await tour.textContent('.ps-title');
  await tour.click('.ps-label');
  await tour.waitForTimeout(1200);
  const after = await tour.textContent('.ps-title');
  check(tourErrors.length === 0, 'visite autonome ouverte en file:// sans erreur ' + tourErrors.join(' | '));
  check(before !== after, `navigation par lien : « ${before} » → « ${after} »`);
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}

check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
console.log(`Captures : ${shots}`);
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
