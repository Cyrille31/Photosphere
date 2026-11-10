// Vérification dans Chromium : éditeur de plan (traits, textes, gomme, défaire, enregistrement) et
// relief pour le casque (estimation sur une pièce synthétique connue, deux yeux différents).
// Usage : node tests/plan-relief-check.mjs [dossier-captures]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from './serve.mjs';
import { syntheticRoom } from './synthetic-room.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-plan-'));
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

// Pièce synthétique en JPEG (lignes de l'image du haut vers le bas).
async function roomJpeg(name, opt) {
  const room = syntheticRoom({ w: 2048, h: 1024, ...opt });
  const rgb = Buffer.alloc(room.w * room.h * 3);
  for (let r = 0; r < room.h; r++) {
    for (let c = 0; c < room.w; c++) {
      const s = ((room.h - 1 - r) * room.w + c) * 4, d = (r * room.w + c) * 3;
      rgb[d] = room.px[s] * 0.95;
      rgb[d + 1] = room.px[s + 1] * 0.88;
      rgb[d + 2] = room.px[s + 2] * 0.78;
    }
  }
  const b64 = await page.evaluate(
    async ({ b64, w, h }) => {
      const bin = atob(b64);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      const img = g.createImageData(w, h);
      for (let i = 0, j = 0; i < w * h; i++, j += 3) {
        img.data[i * 4] = bin.charCodeAt(j);
        img.data[i * 4 + 1] = bin.charCodeAt(j + 1);
        img.data[i * 4 + 2] = bin.charCodeAt(j + 2);
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      const u = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { b64: rgb.toString('base64'), w: room.w, h: room.h }
  );
  const file = path.join(shots, name);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return { file, room };
}

// Écart moyen entre les deux moitiés (yeux) d'une capture d'écran.
async function eyeDifference() {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + png;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const hw = Math.floor(img.width / 2);
    const a = g.getImageData(0, 150, hw, img.height - 300).data;
    const b = g.getImageData(hw, 150, hw, img.height - 300).data;
    let s = 0;
    for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]);
    return s / (a.length / 2);
  }, png);
}

try {
  await page.goto(base);
  await page.evaluate(async () => (await import('./src/db.js')).putSetting('app', { outWidth: 4096, quality: 88 }));
  await page.reload();
  const A = await roomJpeg('salon.jpg', {});
  const B = await roomJpeg('cuisine.jpg', { x0: -1.4, x1: 1.8, z0: -2.2, z1: 2.5, ceil: 0.9, rot: -30, seed: 11 });
  await page.locator('input[type=file][accept^="image"]').setInputFiles([A.file, B.file]);
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 300000 });
  const ids = await db(async (db) => {
    const ps = await db.listPhotos();
    return Object.fromEntries(ps.map((p) => [p.fileName, p.id]));
  });

  // ---------- relief : estimation dans l'éditeur ----------
  await page.goto(base + '#/edit/' + ids['salon.jpg']);
  await page.waitForSelector('[data-tab=relief]');
  await page.waitForTimeout(800);
  await page.click('[data-tab=relief]');
  await page.waitForFunction(() => /Murs trouvés/.test(document.querySelector('.relief-info').textContent), null, { timeout: 30000 });
  const info = await page.textContent('.relief-info');
  await page.screenshot({ path: path.join(shots, '01-editeur-relief.png') });
  await page.click('[data-save]');
  await page.waitForSelector('.grid');
  const relief = await db(async (db, id) => (await db.getPhoto(id)).relief, ids['salon.jpg']);
  const err = relief.walls.map((v, b) => Math.abs(Math.log(v / A.room.walls[b]))).sort((x, y) => x - y);
  const med = err[180], p90 = err[324];
  check(med < 0.1 && p90 < 0.25, `relief : murs de la pièce retrouvés (écart médian ${(med * 100).toFixed(1)} %, 90e centile ${(p90 * 100).toFixed(1)} %) — « ${info.trim().slice(0, 90)} »`);
  check(Math.abs(relief.ceil - A.room.ceil) <= 0.15, `relief : plafond retrouvé (${relief.ceil} hauteur d’objectif au-dessus, vrai ${A.room.ceil})`);

  // ---------- relief : deux yeux différents dans le casque ----------
  const stereoDiff = async (k, label) => {
    await page.evaluate((k) => localStorage.setItem('ps-headset', JSON.stringify({ relief: k })), k);
    await page.goto(base + '#/');
    await page.goto(base + '#/view/' + ids['cuisine.jpg']);
    await page.waitForSelector('.ps-player canvas');
    await page.waitForTimeout(1200);
    await page.click('[data-mode=cardboard]');
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelectorAll('.ps-toast').forEach((t) => (t.hidden = true)));
    if (label) await page.screenshot({ path: path.join(shots, label) });
    return eyeDifference();
  };
  const flat = await stereoDiff(0);
  const deep = await stereoDiff(1, '02-casque-relief.png');
  check(deep > flat * 2 && deep > 1, `casque : avec le relief, les deux yeux voient la pièce de points différents (écart ${deep.toFixed(2)} contre ${flat.toFixed(2)} sans relief)`);
  const saved = await db(async (db, id) => (await db.getPhoto(id)).relief, ids['cuisine.jpg']);
  check(saved && saved.walls && saved.walls.length === 360, 'casque : relief estimé à la volée et mémorisé pour la photo');
  await page.evaluate(() => localStorage.removeItem('ps-headset'));

  // ---------- plan : dessin ----------
  await db(async (db, ids) => {
    const a = await db.getPhoto(ids['salon.jpg']), b = await db.getPhoto(ids['cuisine.jpg']);
    await db.putPhoto({ ...a, mapPos: { x: 0, y: 0 }, hotspots: [{ id: 'h1', target: b.id, yaw: 90, pitch: 0, label: '', auto: true }] });
    await db.putPhoto({ ...b, mapPos: { x: 170, y: 0 }, hotspots: [{ id: 'h2', target: a.id, yaw: -90, pitch: 0, label: '', auto: true }] });
  }, ids);
  await page.goto(base + '#/');
  await page.goto(base + '#/plan');
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(600);
  const bg = await page.$eval('.plan-view', (v) => getComputedStyle(v).backgroundColor);
  check(bg === 'rgb(255, 255, 255)', `plan sur fond blanc (${bg})`);
  check((await page.locator('.plan-links.over line').count()) >= 2, 'liens dessinés aussi en transparence au-dessus des images');
  const vb = await page.locator('.plan-view').boundingBox();
  const P = (x, y) => [vb.x + x, vb.y + y];
  await page.click('[data-tool=line]');
  // Rectangle (le dernier clic revient sur le point de départ, accroché) puis Échap.
  for (const [x, y] of [[120, 120], [620, 124], [622, 470], [118, 468], [121, 121]]) {
    await page.mouse.move(...P(x, y));
    await page.mouse.click(...P(x, y));
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Escape');
  // Cloison intérieure.
  await page.mouse.click(...P(370, 124));
  await page.waitForTimeout(400);
  await page.mouse.click(...P(372, 300));
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  let d = await db((db) => db.getPlanDrawing());
  const l = d.lines;
  const closed = l.length >= 4 && l[3].x2 === l[0].x1 && l[3].y2 === l[0].y1;
  const square = l.slice(0, 4).every((s) => s.x1 === s.x2 || s.y1 === s.y2);
  check(l.length === 5 && closed && square, `plan : murs tracés (${l.length} traits), accrochés à l’horizontale / verticale et refermés`);
  await page.click('[data-tool=text]');
  await page.mouse.click(...P(240, 300));
  await page.keyboard.type('Salon');
  await page.keyboard.press('Enter');
  await page.mouse.click(...P(500, 300));
  await page.keyboard.type('Cuisine');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  // Déplacer un texte.
  const before = (await db((db) => db.getPlanDrawing())).texts.find((t) => t.text === 'Cuisine');
  const tb = await page.locator('.plan-drawing text', { hasText: 'Cuisine' }).boundingBox();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2 + 20, tb.y + tb.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  d = await db((db) => db.getPlanDrawing());
  const moved = d.texts.find((t) => t.text === 'Cuisine');
  check(d.texts.length === 2 && d.texts[0].text === 'Salon' && moved && moved.y > before.y + 10 && moved.x > before.x, `plan : textes écrits et déplacés (${d.texts.map((t) => t.text).join(', ')})`);
  await page.click('[data-tool=photos]');
  await page.screenshot({ path: path.join(shots, '03-plan-dessin.png') });
  await page.click('[data-tool=erase]');
  await page.mouse.click(...P(371, 220));
  await page.waitForTimeout(300);
  d = await db((db) => db.getPlanDrawing());
  check(d.lines.length === 4, `plan : gomme, cloison effacée (${d.lines.length} traits)`);
  await page.click('[data-draw-undo]');
  await page.waitForTimeout(300);
  d = await db((db) => db.getPlanDrawing());
  check(d.lines.length === 5, 'plan : Défaire rétablit le trait effacé');
  await page.reload();
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(500);
  check((await page.locator('.plan-drawing line.wall').count()) === 5 && (await page.locator('.plan-drawing text').count()) === 2, 'plan : dessin retrouvé après rechargement');
  const settings = await page.evaluate(async () => {
    const { buildSettings } = await import('./src/settings-file.js');
    const db = await import('./src/db.js');
    return buildSettings(await db.listPhotos(), await db.getPlanDrawing());
  });
  check(settings.plan && settings.plan.lines.length === 5 && settings.photos.every((p) => p.relief), 'fichier de réglages : dessin du plan et relief inclus');
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}
check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
