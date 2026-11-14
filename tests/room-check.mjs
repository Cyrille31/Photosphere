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
      // Déplacer un coin ne déplace que lui (puis on le remet en place avec Défaire).
      const before = await page.evaluate(() => [...document.querySelectorAll('.ed-room-corner')].map((e) => e.textContent + ':' + e.style.left + ',' + e.style.top));
      const c1 = await page.locator('.ed-room-corner').first().boundingBox();
      await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2);
      await page.mouse.down();
      await page.mouse.move(c1.x + c1.width / 2 + 40, c1.y + c1.height / 2 + 15, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => [...document.querySelectorAll('.ed-room-corner')].map((e) => e.textContent + ':' + e.style.left + ',' + e.style.top));
      const movedOnly = before.filter((x, i) => x !== after[i]);
      check(movedOnly.length === 1, `éditeur : glisser un coin ne déplace que lui (${movedOnly.length} coin déplacé)`);
      await page.click('[data-undo]');
      await page.waitForTimeout(300);
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

  // ---------- plan : sélectionner, déplacer, agrandir, tourner une pièce ----------
  const edgeMid = () => page.evaluate(() => {
    const pg = document.querySelector('.plan-roomsel .room-hit');
    const m = pg.getScreenCTM();
    const pts = pg.getAttribute('points').trim().split(/\s+/).map((t) => t.split(',').map(Number));
    const P = ([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    const a = P(pts[1]), b = P(pts[2]);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  });
  const state = () => db(async (db, ids) => {
    const a = await db.getPhoto(ids['salon-a.jpg']), b = await db.getPhoto(ids['salon-b.jpg']);
    const d = await db.getPlanDrawing();
    return { a: a.mapPos, b: b.mapPos, room: d.rooms && d.rooms[0], capA: a.params.yaw || 0, statusA: a.status, yawAB: a.hotspots[0].yaw, north: d.north || 0 };
  }, ids);
  let [mx, my] = await edgeMid();
  await page.mouse.click(mx, my);
  await page.waitForTimeout(300);
  check((await page.locator('.plan-roomsel .room-sel').count()) === 1 && (await page.locator('.plan-roomsel .room-corner').count()) === 4, 'plan : clic sur un mur → pièce sélectionnée (poignées de taille et de rotation)');
  let s0 = await state();
  await page.mouse.move(mx, my);
  await page.mouse.down();
  await page.mouse.move(mx + 60, my + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  let s1 = await state();
  const z = await page.evaluate(() => {
    const t = document.querySelector('.plan-world').style.transform.match(/scale\(([\d.]+)\)/);
    return t ? +t[1] : 1;
  });
  const exp = [60 / z, 40 / z];
  check(Math.abs(s1.a.x - s0.a.x - exp[0]) < 3 && Math.abs(s1.a.y - s0.a.y - exp[1]) < 3 && Math.abs(s1.b.x - s0.b.x - exp[0]) < 3 && Math.abs(s1.room.cx - s0.room.cx - exp[0]) < 3, `plan : pièce déplacée avec ses photos (${(s1.a.x - s0.a.x).toFixed(0)} ; ${(s1.a.y - s0.a.y).toFixed(0)} px)`);
  const h = await page.locator('.plan-roomsel .room-corner').nth(2).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  // Vers l'extérieur : dans le prolongement centre → coin.
  const rc = await page.evaluate(() => {
    const r = document.querySelector('.plan-roomsel .room-hit').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  const hx = h.x + h.width / 2, hy = h.y + h.height / 2, hn = Math.hypot(hx - rc[0], hy - rc[1]);
  await page.mouse.move(hx + ((hx - rc[0]) / hn) * 60, hy + ((hy - rc[1]) / hn) * 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const s2 = await state();
  check(s2.room.w + s2.room.l > s1.room.w + s1.room.l + 0.5, `plan : pièce agrandie par une poignée (${s1.room.w.toFixed(1)} × ${s1.room.l.toFixed(1)} → ${s2.room.w.toFixed(1)} × ${s2.room.l.toFixed(1)} m)`);
  // Rotation : la poignée ronde tourne de ~30° autour du centre de la pièce.
  const rh = await page.locator('.plan-roomsel .room-rot').boundingBox();
  const ctr = await page.evaluate(() => {
    const pg = document.querySelector('.plan-roomsel .room-hit');
    const r = pg.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  const r0 = [rh.x + rh.width / 2, rh.y + rh.height / 2];
  const ang = (30 * Math.PI) / 180, vx = r0[0] - ctr[0], vy = r0[1] - ctr[1];
  await page.mouse.move(r0[0], r0[1]);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) {
    const a = (ang * k) / 10;
    await page.mouse.move(ctr[0] + vx * Math.cos(a) - vy * Math.sin(a), ctr[1] + vx * Math.sin(a) + vy * Math.cos(a));
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const s3 = await state();
  const dAng = ((s3.room.ang - s2.room.ang) * 180) / Math.PI;
  const dCap = ((s3.capA - s2.capA + 540) % 360) - 180;
  check(Math.abs(dAng - 30) < 3 && Math.abs(dCap + dAng) < 1.5 && s3.statusA === 'pending', `plan : pièce tournée de ${dAng.toFixed(1)}°, nord de ses photos corrigé de ${dCap.toFixed(1)}° (reconversion prévue)`);
  await page.screenshot({ path: path.join(shots, '03-plan-piece-tournee.png') });

  // ---------- flèche nord-sud ----------
  const ct = await page.locator('.plan-roomsel .compass-rot').boundingBox();
  const cb = await page.locator('.plan-roomsel .compass-base').boundingBox();
  const cc = [cb.x + cb.width / 2, cb.y + cb.height / 2];
  const t0 = [ct.x + ct.width / 2, ct.y + ct.height / 2];
  const R = Math.hypot(t0[0] - cc[0], t0[1] - cc[1]);
  await page.mouse.move(t0[0], t0[1]);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) {
    const a = ((20 * k) / 8) * (Math.PI / 180);
    await page.mouse.move(cc[0] + R * Math.sin(a), cc[1] - R * Math.cos(a));
  }
  await page.mouse.up();
  await page.waitForTimeout(800);
  const s4 = await state();
  const dYaw = ((s4.yawAB - s3.yawAB + 540) % 360) - 180;
  check(Math.abs(s4.north - 20) < 2 && Math.abs(dYaw + 20) < 2, `flèche nord orientée à ${s4.north}° : lien automatique réorienté de ${dYaw.toFixed(1)}°`);
  await page.screenshot({ path: path.join(shots, '04-plan-nord.png') });
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}
check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
