// Vérification dans Chromium : plan des pièces d'après les coins du plafond. Deux photos d'une même
// pièce synthétique (dimensions connues) prises à 1 hauteur d'objectif d'écart : coins détectés dans
// l'éditeur (onglet Pièce), puis « 🏠 Placer les pièces » sur le plan.
// Usage : node tests/room-check.mjs [dossier-captures]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from './serve.mjs';
import { syntheticRoom } from './synthetic-room.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-room-'));
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

// Pièce de 5 × 5,6 hauteurs d'objectif (8 × 8,96 m avec l'objectif à 1,6 m), plafond 0,7 au-dessus de
// l'objectif (2,72 m). La photo B est prise 1 hauteur à l'est et 1 au nord de la photo A.
const CAM = 1.6, H = 1.7 * CAM;
async function roomJpeg(name, opt) {
  const room = syntheticRoom({ w: 2048, h: 1024, ceil: 0.7, rot: 0, ...opt });
  const rgb = Buffer.alloc(room.w * room.h * 3);
  for (let r = 0; r < room.h; r++) for (let c = 0; c < room.w; c++) {
    const s = ((room.h - 1 - r) * room.w + c) * 4, d = (r * room.w + c) * 3;
    rgb[d] = room.px[s] * 0.97;
    rgb[d + 1] = room.px[s + 1] * 0.92;
    rgb[d + 2] = room.px[s + 2] * 0.85;
  }
  const b64 = await page.evaluate(async ({ b64, w, h }) => {
    const bin = atob(b64);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    for (let i = 0, j = 0; i < w * h; i++, j += 3) img.data.set([bin.charCodeAt(j), bin.charCodeAt(j + 1), bin.charCodeAt(j + 2), 255], i * 4);
    g.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    const u = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  }, { b64: rgb.toString('base64'), w: room.w, h: room.h });
  const file = path.join(shots, name);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

try {
  await page.goto(base);
  await page.evaluate(async () => (await import('./src/db.js')).putSetting('app', { outWidth: 4096, quality: 88 }));
  await page.reload();
  const A = await roomJpeg('salon-a.jpg', { x0: -2, x1: 3, z0: -1.6, z1: 4 });
  const B = await roomJpeg('salon-b.jpg', { x0: -3, x1: 2, z0: -2.6, z1: 3, seed: 7 });
  await page.locator('input[type=file][accept^="image"]').setInputFiles([A, B]);
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 300000 });
  const ids = await db(async (db) => Object.fromEntries((await db.listPhotos()).map((p) => [p.fileName, p.id])));

  // ---------- éditeur, onglet Pièce : coins détectés ----------
  for (const f of ['salon-a.jpg', 'salon-b.jpg']) {
    await page.goto(base + '#/');
    await page.goto(base + '#/edit/' + ids[f]);
    await page.waitForSelector('[data-tab=room]');
    await page.waitForTimeout(1000);
    await page.click('[data-tab=room]');
    await page.fill('[name=roomName]', 'Salon');
    await page.fill('[name=ceilingH]', String(H));
    await page.press('[name=ceilingH]', 'Enter');
    await page.locator('[name=ceilingH]').dispatchEvent('change');
    await page.fill('[name=camH]', String(CAM));
    await page.locator('[name=camH]').dispatchEvent('change');
    await page.click('[data-room-detect]');
    await page.waitForFunction(() => !document.querySelector('[data-room-detect]').disabled, null, { timeout: 60000 });
    await page.waitForTimeout(600);
    const info = await page.textContent('.room-info');
    const m = info.match(/([\d.]+) × ([\d.]+) m/);
    const dims = m ? [+m[1], +m[2]].sort((a, b) => a - b) : null;
    check(dims && Math.abs(dims[0] / 8 - 1) < 0.08 && Math.abs(dims[1] / 8.96 - 1) < 0.08, `éditeur : coins du plafond détectés (${f}) → pièce ${m ? m[1] + ' × ' + m[2] : '?'} m (vraie : 8 × 8,96 m)`);
    if (f === 'salon-a.jpg') {
      check((await page.locator('.ed-room-corner').count()) >= 2 && (await page.locator('.ed-room-lines polyline.ceil').count()) >= 1, 'éditeur : coins numérotés et ligne plafond / mur prévue affichés sur l’image');
      await page.screenshot({ path: path.join(shots, '01-editeur-piece.png') });
    }
    await page.click('[data-save]');
    await page.waitForSelector('.grid');
  }
  const saved = await db(async (db) => (await db.listPhotos()).map((p) => p.room && p.room.corners.length));
  check(saved.every((n) => n === 4), 'coins de la pièce enregistrés avec chaque photo');

  // ---------- plan : placer les pièces ----------
  await page.goto(base + '#/plan');
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(500);
  check(+(await page.inputValue('[data-ceiling]')) === H, `plan : hauteur sous plafond commune reprise (${await page.inputValue('[data-ceiling]')} m)`);
  await page.click('[data-place-rooms]');
  await page.waitForTimeout(1200);
  const st = await db(async (db, ids) => {
    const a = await db.getPhoto(ids['salon-a.jpg']), b = await db.getPhoto(ids['salon-b.jpg']);
    const d = await db.getPlanDrawing();
    return { a: a.mapPos, b: b.mapPos, la: a.hotspots.length, lb: b.hotspots.length, yawAB: a.hotspots[0] && a.hotspots[0].yaw, walls: d.lines.filter((l) => l.room === 'salon').length, text: (d.texts.find((t) => t.room === 'salon') || {}).text };
  }, ids);
  // B est 1,6 m à l'est et 1,6 m au nord de A : 80 px à droite et 80 px plus haut sur le plan.
  const dx = st.b.x - st.a.x, dy = st.b.y - st.a.y;
  check(Math.abs(dx - 80) < 12 && Math.abs(dy + 80) < 12, `plan : photos placées l’une par rapport à l’autre (écart ${dx} ; ${dy} px, attendu 80 ; -80)`);
  check(st.walls === 4 && /Salon/.test(st.text || ''), `plan : murs de la pièce dessinés (${st.walls} traits) et nommés (« ${st.text} »)`);
  check(st.la === 1 && st.lb === 1 && Math.abs(st.yawAB - 45) < 8, `plan : photos de la pièce reliées (cap A → B ${st.yawAB}°, attendu 45°)`);
  await page.screenshot({ path: path.join(shots, '02-plan-pieces.png') });
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}
check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
