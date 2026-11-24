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
      const before = await page.evaluate(() => [...document.querySelectorAll('.ed-room-corner:not(.floor)')].map((e) => e.textContent + ':' + e.style.left + ',' + e.style.top));
      const c1 = await page.locator('.ed-room-corner:not(.floor)').first().boundingBox();
      await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2);
      await page.mouse.down();
      await page.mouse.move(c1.x + c1.width / 2 + 40, c1.y + c1.height / 2 + 15, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => [...document.querySelectorAll('.ed-room-corner:not(.floor)')].map((e) => e.textContent + ':' + e.style.left + ',' + e.style.top));
      const movedOnly = before.filter((x, i) => x !== after[i]);
      check(movedOnly.length === 1, `éditeur : glisser un coin ne déplace que lui (${movedOnly.length} coin déplacé)`);
      await page.click('[data-undo]');
      await page.waitForTimeout(300);
      // Coins au sol (bleus) : un par coin du plafond ; en glisser un déplace le coin rouge correspondant.
      const nFloor = await page.locator('.ed-room-corner.floor').count();
      const reds0 = await page.evaluate(() => [...document.querySelectorAll('.ed-room-corner:not(.floor)')].map((e) => e.textContent + ':' + e.style.left + ',' + e.style.top));
      const vis = await page.evaluate(() => [...document.querySelectorAll('.ed-room-corner.floor')].findIndex((e) => {
        const r = e.getBoundingClientRect();
        return r.x > 60 && r.x < innerWidth - 400 && r.y > 120 && r.y < innerHeight - 60;
      }));
      if (vis >= 0) {
        const fb = await page.locator('.ed-room-corner.floor').nth(vis).boundingBox();
        await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
        await page.mouse.down();
        await page.mouse.move(fb.x + fb.width / 2 + 35, fb.y + fb.height / 2 + 10, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(300);
      }
      const reds1 = await page.evaluate(() => [...document.querySelectorAll('.ed-room-corner:not(.floor)')].map((e) => e.textContent + ':' + e.style.left + ',' + e.style.top));
      const redMoved = reds0.filter((x, i) => x !== reds1[i]);
      check(nFloor === reds0.length && nFloor > 0 && vis >= 0 && redMoved.length === 1 && redMoved[0].startsWith(String(vis + 1) + ':'), `éditeur : un coin au sol (bleu) sous chaque coin du plafond ; en glisser un déplace son coin du plafond (${redMoved.map((x) => x.split(':')[0]).join(', ') || 'aucun'})`);
      await page.click('[data-undo]');
      await page.waitForTimeout(300);
    }
    await page.click('[data-save]');
    await page.waitForSelector('.grid');
  }
  // Photo suivante depuis l'onglet Pièce : on reste sur l'onglet Pièce.
  await page.goto(base + '#/edit/' + ids['salon-a.jpg']);
  await page.waitForSelector('[data-tab=room]');
  await page.waitForTimeout(800);
  await page.click('[data-tab=room]');
  await page.click('[data-nav="1"]');
  await page.waitForFunction((id) => location.hash === '#/edit/' + id, ids['salon-b.jpg']);
  await page.waitForSelector('[data-tab=room]');
  await page.waitForTimeout(1500);
  check(await page.evaluate(() => document.querySelector('[data-tab=room]').classList.contains('active') && !document.querySelector('[data-panel=room]').hidden), 'éditeur : photo suivante → toujours sur l’onglet Pièce');
  // « Pas dans une pièce » : réglages et coins de la pièce masqués ; décoché, tout revient.
  await page.check('[name=noRoom]');
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => ({ hidden: document.querySelector('.room-fields').hidden, marks: document.querySelectorAll('.ed-room-corner').length }));
  await page.uncheck('[name=noRoom]');
  await page.waitForTimeout(300);
  const on = await page.evaluate(() => ({ hidden: document.querySelector('.room-fields').hidden, marks: document.querySelectorAll('.ed-room-corner').length, name: document.querySelector('[name=roomName]').value }));
  check(off.hidden && off.marks === 0 && !on.hidden && on.marks > 0 && on.name === 'Salon', `éditeur : « Pas dans une pièce » masque la pièce (${off.marks} coin affiché), décoché tout revient (« ${on.name} », ${on.marks} coins)`);
  await page.goto(base + '#/');
  await page.waitForSelector('.grid');
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
    const n = document.querySelector('.plan-node .plan-pic');
    return { a: a.mapPos, b: b.mapPos, room: d.rooms && d.rooms[0], capA: a.params.yaw || 0, statusA: a.status, yawAB: a.hotspots[0].yaw, north: d.north || 0, nodeW: n ? Math.round(n.getBoundingClientRect().width) : 0 };
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
  // Relief de test sur la photo A : un objet proche dans la direction de son lien vers B.
  await page.evaluate(async (id) => {
    const db = await import('./src/db.js');
    const { reliefKey } = await import('./src/depth.js');
    const { depthToPng } = await import('./src/depth-ai.js');
    const p = await db.getPhoto(id);
    const yaw = p.hotspots[0].yaw;
    const W = 2048, H = 1024, depth = new Float32Array(W * H).fill(4);
    const cx = Math.round(((yaw / 360 + 0.5) % 1) * W);
    for (let y = 480; y < 544; y++) for (let k = -20; k <= 20; k++) depth[y * W + ((cx + k + W) % W)] = 0.7;
    await db.putBlob(id + ':depth', await depthToPng(depth));
    await db.updatePhoto(id, (cur) => ({ ...cur, relief: { kind: 'ai', h: 1.6, key: reliefKey(cur.params) } }));
  }, ids['salon-a.jpg']);
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
  await page.waitForTimeout(3000);
  const s3 = await state();
  const dAng = ((s3.room.ang - s2.room.ang) * 180) / Math.PI;
  const dCap = ((s3.capA - s2.capA + 540) % 360) - 180;
  const rel = await page.evaluate(async (id) => {
    const db = await import('./src/db.js');
    const { reliefKey, loadDepthImage, depthAt } = await import('./src/depth.js');
    const { dirFromLonLat } = await import('./src/math.js');
    const p = await db.getPhoto(id);
    const m = await loadDepthImage(await db.getBlob(id + ':depth'));
    const at = (yaw) => depthAt(m.depth, dirFromLonLat((yaw * Math.PI) / 180, 0));
    return { valid: !!p.relief && p.relief.key === reliefKey(p.params), onLink: at(p.hotspots[0].yaw), away: at(p.hotspots[0].yaw + 90) };
  }, ids['salon-a.jpg']);
  check(rel.valid && rel.onLink < 1 && rel.away > 3, `plan : pièce tournée → relief conservé et tourné avec elle (objet proche toujours dans la direction du lien : ${rel.onLink.toFixed(2)} ; à côté : ${rel.away.toFixed(2)})`);
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

  // ---------- rotation avec Maj : côtés sur des angles de 15 en 15° ----------
  {
    const rh2 = await page.locator('.plan-roomsel .room-rot').boundingBox();
    const c2 = await page.evaluate(() => {
      const r = document.querySelector('.plan-roomsel .room-hit').getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
    const q0 = [rh2.x + rh2.width / 2, rh2.y + rh2.height / 2];
    const ux = q0[0] - c2[0], uy = q0[1] - c2[1];
    await page.mouse.move(q0[0], q0[1]);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    for (let k = 1; k <= 6; k++) {
      const a = ((-11 * k) / 6) * (Math.PI / 180);
      await page.mouse.move(c2[0] + ux * Math.cos(a) - uy * Math.sin(a), c2[1] + ux * Math.sin(a) + uy * Math.cos(a));
    }
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(3000);
    const s5 = await state();
    const deg = (((s5.room.ang * 180) / Math.PI) % 15 + 15) % 15;
    check(Math.min(deg, 15 - deg) < 0.01, `plan : Maj + rotation → côtés à un multiple de 15° (${((s5.room.ang * 180) / Math.PI).toFixed(2)}°)`);
  }

  // ---------- nom de la pièce : petit, dans un coin, déplaçable ----------
  {
    const lab = page.locator('.plan-roomsel .room-label-hit').first();
    const lb = await lab.boundingBox();
    const d0 = await db(async (db) => (await db.getPlanDrawing()).texts.find((t) => t.room === 'salon'));
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
    await page.mouse.down();
    await page.mouse.move(lb.x + lb.width / 2 + 40, lb.y + lb.height / 2 - 30, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const d1 = await db(async (db) => (await db.getPlanDrawing()).texts.find((t) => t.room === 'salon'));
    check(d0.size <= 12 && d0.text === 'Salon' && d1.x > d0.x + 10 && d1.y < d0.y - 8, `plan : nom de la pièce en petit (${d0.size}) et déplaçable (${d0.x},${d0.y} → ${d1.x},${d1.y})`);
  }

  // ---------- fenêtre de la pièce : nom et dimensions ----------
  {
    const pv = await page.evaluate(() => {
      const p = document.querySelector('.plan-roompanel');
      return p && !p.hidden ? [p.querySelector('[data-rp=name]').value, +p.querySelector('[data-rp=w]').value, +p.querySelector('[data-rp=l]').value] : null;
    });
    const sA = await state();
    check(pv && pv[0] === 'Salon' && Math.abs(pv[1] - sA.room.w) < 0.01 && Math.abs(pv[2] - sA.room.l) < 0.01, `plan : pièce sélectionnée → fenêtre avec son nom et ses dimensions (${pv && pv.join(' ; ')})`);
    await page.fill('.plan-roompanel [data-rp=w]', '6');
    await page.press('.plan-roompanel [data-rp=w]', 'Enter');
    await page.waitForTimeout(800);
    const sB = await state();
    check(Math.abs(sB.room.w - 6) < 0.01 && Math.abs(sB.room.l - sA.room.l) < 0.01, `plan : largeur saisie → pièce de ${sB.room.w.toFixed(2)} × ${sB.room.l.toFixed(2)} m`);
    // Redimensionner à la souris avec Maj : mêmes proportions, et la fenêtre suit.
    const hc = await page.locator('.plan-roomsel .room-corner').nth(2).boundingBox();
    const ctr2 = await page.evaluate(() => {
      const r = document.querySelector('.plan-roomsel .room-hit').getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
    const hx = hc.x + hc.width / 2, hy = hc.y + hc.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(hx + (hx - ctr2[0]) * 0.3 + 25, hy + (hy - ctr2[1]) * 0.3 - 10, { steps: 8 });
    const live = +(await page.inputValue('.plan-roompanel [data-rp=w]'));
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(800);
    const sC = await state();
    check(Math.abs(sC.room.w / sC.room.l - sB.room.w / sB.room.l) < 0.01 && sC.room.w > sB.room.w + 0.3 && Math.abs(live - sC.room.w) < 0.05, `plan : Maj + poignée → proportions gardées (${sB.room.w.toFixed(2)} × ${sB.room.l.toFixed(2)} → ${sC.room.w.toFixed(2)} × ${sC.room.l.toFixed(2)} m), fenêtre mise à jour (${live})`);
    // Renommer dans la fenêtre : le plan et les photos suivent.
    await page.fill('.plan-roompanel [data-rp=name]', 'Séjour');
    await page.press('.plan-roompanel [data-rp=name]', 'Enter');
    await page.waitForTimeout(800);
    const rn = await db(async (db) => ({ names: (await db.listPhotos()).map((p) => p.room.name), label: (await db.getPlanDrawing()).texts.filter((t) => t.room).map((t) => t.text) }));
    check(rn.names.every((n) => n === 'Séjour') && rn.label.join() === 'Séjour', `plan : pièce renommée dans la fenêtre → photos (${rn.names.join(', ')}) et plan (${rn.label.join(', ')})`);
  }

  // ---------- échelle ----------
  {
    const s6 = await state();
    const d0 = await db(async (db) => db.getPlanDrawing());
    const se = await page.locator('.plan-roomsel .scale-end').boundingBox();
    const label0 = await page.locator('.plan-roomsel .scale-label').textContent();
    const sx = se.x + se.width / 2, sy = se.y + se.height / 2;
    const bar = await page.evaluate(() => {
      const p = document.querySelector('.plan-roomsel .scale-line').getBoundingClientRect();
      return p.width;
    });
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + bar, sy, { steps: 8 }); // longueur doublée
    await page.mouse.up();
    await page.waitForTimeout(1000);
    const s7 = await state();
    const d1 = await db(async (db) => db.getPlanDrawing());
    const fA = Math.hypot(s7.b.x - s7.a.x, s7.b.y - s7.a.y) / Math.hypot(s6.b.x - s6.a.x, s6.b.y - s6.a.y);
    const wall = (d) => { const l = d.lines.find((x) => x.room); return Math.hypot(l.x2 - l.x1, l.y2 - l.y1); };
    const fW = wall(d1) / wall(d0);
    const nodeW0 = s6.nodeW, nodeW1 = s7.nodeW;
    check(Math.abs((d1.pxPerM || 50) / (d0.pxPerM || 50) - 2) < 0.15 && Math.abs(fA - 2) < 0.15 && Math.abs(fW - 2) < 0.15 && Math.abs(s7.room.w - s6.room.w) < 1e-6 && Math.abs(nodeW1 - nodeW0) < 0.5,
      `plan : échelle ${label0} doublée → ${d1.pxPerM} px/m, distances ×${fA.toFixed(2)}, murs ×${fW.toFixed(2)}, pièce ${s7.room.w.toFixed(1)} m, photos de même taille (${nodeW0} → ${nodeW1} px)`);
    await page.screenshot({ path: path.join(shots, '05-plan-echelle.png') });
    await page.click('[data-room-done]').catch(() => {});
    await page.click('[data-fit]');
    await page.waitForTimeout(6000); // messages refermés
    await page.screenshot({ path: path.join(shots, '06-plan-vue.png') });
  }

  // ---------- photo de départ ----------
  {
    const nb = await page.locator('.plan-node[data-id="' + ids['salon-b.jpg'] + '"] .plan-pic').boundingBox();
    await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2);
    await page.waitForTimeout(400);
    await page.click('.plan-node.selected [data-act=start]');
    await page.waitForTimeout(600);
    const st2 = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const { buildSettings } = await import('./src/settings-file.js');
      const s = buildSettings(await db.listPhotos(), await db.getPlanDrawing());
      return { start: s.start, planStart: s.plan && s.plan.start, marker: document.querySelectorAll('.plan-start').length, on: !!document.querySelector('.plan-node[data-id] .plan-start')?.closest('.plan-node').dataset.id };
    });
    const markerOn = await page.evaluate(() => document.querySelector('.plan-start') && document.querySelector('.plan-start').closest('.plan-node').dataset.id);
    check(st2.start === 'salon-b.jpg' && st2.marker === 1 && markerOn === ids['salon-b.jpg'] && st2.planStart === undefined, `plan : photo de départ choisie → repère « Départ » sur le plan, « ${st2.start} » dans photosphere.json`);
    // Sens d'arrivée : la flèche verte autour de la photo de départ, tournée d'un quart de tour.
    const hb = await page.locator('.plan-startdir [data-start-dir]').boundingBox();
    const nc = await page.locator('.plan-node[data-id="' + ids['salon-b.jpg'] + '"] .plan-pic').boundingBox();
    const cx = nc.x + nc.width / 2, cy = nc.y + nc.height / 2, hx = hb.x + hb.width / 2, hy = hb.y + hb.height / 2;
    const yawBefore = await db(async (db) => (await db.getPlanDrawing()).startYaw || 0);
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) {
      const a = (Math.PI / 2) * (k / 8), vx = hx - cx, vy = hy - cy;
      await page.mouse.move(cx + vx * Math.cos(a) - vy * Math.sin(a), cy + vx * Math.sin(a) + vy * Math.cos(a));
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
    const sy = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const { buildSettings } = await import('./src/settings-file.js');
      const d = await db.getPlanDrawing();
      return { yaw: d.startYaw, file: buildSettings(await db.listPhotos(), d).startYaw };
    });
    const turned = ((sy.yaw - yawBefore + 540) % 360) - 180;
    check(Math.abs(turned - 90) < 4 && sy.file === sy.yaw, `plan : flèche de départ tournée de ${turned.toFixed(1)}° → sens d’arrivée ${sy.yaw}° (repris dans photosphere.json)`);
    await page.screenshot({ path: path.join(shots, '07-plan-depart.png') });
  }

  // ---------- pièce renommée dans l'éditeur puis « Placer les pièces » : pas de doublon ----------
  {
    await db(async (db) => {
      for (const p of await db.listPhotos()) await db.updatePhoto(p.id, (cur) => ({ ...cur, room: { ...cur.room, name: 'Grand salon' } }));
    });
    await page.goto(base + '#/');
    await page.goto(base + '#/plan');
    await page.waitForSelector('.plan-node');
    await page.waitForTimeout(500);
    await page.click('[data-place-rooms]');
    await page.waitForTimeout(1200);
    const d = await db(async (db) => db.getPlanDrawing());
    check(d.rooms.length === 1 && d.rooms[0].name === 'Grand salon' && d.texts.filter((t) => t.room).map((t) => t.text).join() === 'Grand salon' && d.lines.filter((l) => l.room).length === 4, `plan : pièce renommée dans l’éditeur → « Placer les pièces » la remplace (${d.rooms.map((r) => r.name).join(', ')})`);

    // Retirer une photo du plan : retour dans la zone des photos non placées, liens gardés, hors de sa pièce.
    const na = await page.locator('.plan-node[data-id="' + ids['salon-a.jpg'] + '"] .plan-pic').boundingBox();
    await page.mouse.click(na.x + na.width / 2, na.y + na.height / 2);
    await page.waitForTimeout(400);
    await page.click('.plan-node.selected [data-act=unplace]');
    await page.waitForTimeout(800);
    const un = await db(async (db, id) => ({ p: await db.getPhoto(id), d: await db.getPlanDrawing() }), ids['salon-a.jpg']);
    const pooled = await page.evaluate(() => (document.querySelector('.plan-pool span') || {}).textContent || '');
    check(un.p.mapHidden && !un.p.mapPos && un.p.hotspots.length === 1 && !un.d.rooms[0].ids.includes(ids['salon-a.jpg']) && /\(1\)/.test(pooled), `plan : photo retirée du plan (zone : « ${pooled.slice(0, 30)}… », lien gardé)`);
    await page.click('[data-place-rooms]');
    await page.waitForTimeout(1200);
    const still = await db(async (db, id) => (await db.getPhoto(id)).mapHidden, ids['salon-a.jpg']);
    check(still === true, 'plan : « Placer les pièces » laisse de côté la photo retirée');

    // Navigation : plus de lien vers la photo retirée (visionneuse et parcours partagé) ; bouton Plan.
    const labels = async () => {
      await page.goto(base + '#/');
      await page.goto(base + '#/view/' + ids['salon-b.jpg']);
      await page.waitForSelector('.ps-player canvas');
      await page.waitForTimeout(800);
      return page.locator('.ps-labels > *').count();
    };
    const nHidden = await labels();
    const tour = await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const { buildSettings } = await import('./src/settings-file.js');
      const { tourFromSettings } = await import('./src/parcours.js');
      const t = tourFromSettings(buildSettings(await db.listPhotos(), await db.getPlanDrawing()), () => true);
      return t.find((p) => p.id === 'salon-b.jpg').hotspots.length;
    });
    await page.click('.ps-plan');
    await page.waitForSelector('.plan-node');
    const toPlan = page.url().endsWith('#/plan');
    await db(async (db, id) => db.updatePhoto(id, (cur) => ({ ...cur, mapHidden: false, mapPlaced: true, mapPos: { x: 0, y: 0 } })), ids['salon-a.jpg']);
    const nBack = await labels();
    check(nHidden === 0 && tour === 0 && nBack === 1 && toPlan, `navigation : lien vers la photo retirée masqué (visionneuse ${nHidden}, parcours ${tour}), revenu une fois remise (${nBack}) ; bouton « Plan » de la visionneuse → plan (${toPlan})`);
  }

  // ---------- redressement dans l'éditeur : le relief tourne avec la photo ----------
  {
    // Avant : l'objet proche de la carte de test est repéré (cap où la distance est faible, à l'horizon).
    const r0 = await page.evaluate(async (id) => {
      const db = await import('./src/db.js');
      const { reliefKey, loadDepthImage, depthAt } = await import('./src/depth.js');
      const { dirFromLonLat } = await import('./src/math.js');
      const p = await db.getPhoto(id);
      const m = await loadDepthImage(await db.getBlob(id + ':depth'));
      let yaw = null;
      for (let a = -180; a < 180; a += 0.5) if (depthAt(m.depth, dirFromLonLat((a * Math.PI) / 180, 0)) < 1) yaw = yaw ?? a;
      return { valid: !!p.relief && p.relief.key === reliefKey(p.params), yaw: yaw + 2, params: p.params };
    }, ids['salon-a.jpg']);
    await page.goto(base + '#/');
    await page.goto(base + '#/edit/' + ids['salon-a.jpg']);
    await page.waitForSelector('.slider input[type=number][name=tiltSide]');
    await page.waitForTimeout(800);
    await page.fill('.slider input[type=number][name=tiltSide]', '6');
    await page.dispatchEvent('.slider input[type=number][name=tiltSide]', 'input');
    await page.fill('.slider input[type=number][name=tiltForward]', '-4');
    await page.dispatchEvent('.slider input[type=number][name=tiltForward]', 'input');
    await page.waitForTimeout(300);
    await page.click('[data-save]');
    await page.waitForSelector('.grid');
    await page.waitForTimeout(500);
    // Après : l'objet doit être là où le redressement a emmené ce point de la scène.
    const r1 = await page.evaluate(async ({ id, r0 }) => {
      const db = await import('./src/db.js');
      const { reliefKey, loadDepthImage, depthAt } = await import('./src/depth.js');
      const { dirFromLonLat, remapHotspot } = await import('./src/math.js');
      const p = await db.getPhoto(id);
      const m = await loadDepthImage(await db.getBlob(id + ':depth'));
      const q = remapHotspot({ yaw: r0.yaw, pitch: 0 }, r0.params, p.params);
      const at = (yaw, pitch) => depthAt(m.depth, dirFromLonLat((yaw * Math.PI) / 180, (pitch * Math.PI) / 180));
      return { valid: !!p.relief && p.relief.key === reliefKey(p.params), there: at(q.yaw, q.pitch), away: at(q.yaw + 90, q.pitch), params: p.params };
    }, { id: ids['salon-a.jpg'], r0 });
    const moved = Math.abs((r1.params.pitch || 0) - (r0.params.pitch || 0)) + Math.abs((r1.params.roll || 0) - (r0.params.roll || 0));
    // Onglet Relief : le nouveau calcul est conseillé.
    await page.goto(base + '#/edit/' + ids['salon-a.jpg']);
    await page.waitForSelector('[data-tab=relief]');
    await page.waitForTimeout(1500);
    await page.click('[data-tab=relief]');
    await page.waitForTimeout(1500);
    const info = await page.textContent('.relief-info');
    await page.click('[data-cancel]');
    await page.waitForSelector('.grid');
    check(/redressée de [5-9]\.\d°/.test(info) && /Recalculer/.test(info), `onglet Relief : nouveau calcul conseillé après le redressement (« ${info.slice(0, 90)}… »)`);
    check(r0.valid && r0.yaw !== null && r1.valid && moved > 3 && r1.there < 1 && r1.away > 3, `éditeur : photo redressée (${moved.toFixed(1)}° de changement) → relief conservé et tourné avec elle (objet proche retrouvé à sa nouvelle place : ${r1.there.toFixed(2)} ; à côté : ${r1.away.toFixed(2)})`);
  }

  // ---------- supprimer une pièce ----------
  {
    await page.goto(base + '#/');
    await page.goto(base + '#/plan');
    await page.waitForSelector('.plan-node');
    await page.waitForTimeout(600);
    await page.click('[data-fit]');
    await page.waitForTimeout(400);
    const roomsNow = async () => db(async (db) => {
      const d = await db.getPlanDrawing();
      return { rooms: d.rooms.length, walls: d.lines.filter((l) => l.room).length, photoRooms: (await db.listPhotos()).filter((p) => p.room && p.room.corners && p.room.corners.length).length };
    });
    const pick = async () => {
      const [x, y] = await edgeMid();
      await page.mouse.click(x, y);
      await page.waitForTimeout(400);
    };
    const r0 = await roomsNow();
    await pick();
    await page.click('.plan-roompanel [data-room-delete]');
    await page.click('dialog [data-del=plan]');
    await page.waitForTimeout(800);
    const r1 = await roomsNow();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(800);
    const r2 = await roomsNow();
    await pick();
    await page.keyboard.press('Delete');
    await page.click('dialog [data-del=all]');
    await page.waitForTimeout(1200);
    const r3 = await roomsNow();
    check(r0.rooms === 1 && r1.rooms === 0 && r1.walls === 0 && r1.photoRooms === r0.photoRooms && r2.rooms === 1 && r3.rooms === 0 && r3.photoRooms < r1.photoRooms,
      `plan : pièce supprimée du plan (${r0.rooms} → ${r1.rooms}, murs ${r1.walls}, photos gardant leurs coins ${r1.photoRooms}), Ctrl + Z la rétablit (${r2.rooms}), Suppr « du plan et des photos » (${r3.rooms} pièce, ${r3.photoRooms} photo avec coins)`);
  }
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}
check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
