// Vérification dans Chromium : visée au casque (rond de visée à la distance de la cible, cibles inactives
// juste après l'arrivée, mini-flèches vers les autres liens, autre couleur hors de la pièce) et scénarios
// de visite (enregistrement, lecture, reprise en main, lien à envoyer, lecture dès l'ouverture d'un
// parcours partagé).
// Usage : node tests/scenario-check.mjs [dossier-captures]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';
import { syntheticRoom } from './synthetic-room.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-scenario-'));
fs.mkdirSync(shots, { recursive: true });
const server = await serve(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) failures++;
};
const db = (fn, arg) => page.evaluate(async ({ fn, arg }) => new Function('db', 'arg', `return (${fn})(db, arg)`)(await import('./src/db.js'), arg), { fn: fn.toString(), arg });
const ds = (k) => page.evaluate((k) => document.querySelector('.ps-player') && document.querySelector('.ps-player').dataset[k], k);
const tmp = path.join(here, `.tmp-parcours-${process.pid}`);

async function roomJpeg(name, opt) {
  const room = syntheticRoom({ w: 1024, h: 512, ceil: 0.7, rot: 0, ...opt });
  const rgb = Buffer.alloc(room.w * room.h * 3);
  for (let r = 0; r < room.h; r++) for (let c = 0; c < room.w; c++) {
    const s = ((room.h - 1 - r) * room.w + c) * 4, d = (r * room.w + c) * 3;
    rgb[d] = room.px[s];
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
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
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
  await page.evaluate(async () => (await import('./src/db.js')).putSetting('app', { outWidth: 2048, quality: 85 }));
  await page.reload();
  const files = [
    await roomJpeg('360_0001 salon 1.jpg', { x0: -2, x1: 3, z0: -1.6, z1: 4 }),
    await roomJpeg('360_0002 salon 2.jpg', { x0: -3, x1: 2, z0: -2.6, z1: 3, seed: 7 }),
    await roomJpeg('360_0003 cuisine 1.jpg', { x0: -2, x1: 2, z0: -2, z1: 2, seed: 3 }),
  ];
  await page.locator('input[type=file][accept^="image"]').setInputFiles(files);
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 3, null, { timeout: 300000 });
  // Liens : salon 1 → salon 2 (à l'est) et → cuisine (à l'ouest) ; retours. Relief de synthèse sur
  // salon 1 : la distance croît avec la longitude (2 à 5 hauteurs d'objectif).
  const ids = await db(async (db) => {
    const { encodeDepth, reliefKey } = await import('./src/depth.js');
    const ps = await db.listPhotos();
    const by = Object.fromEntries(ps.map((p) => [p.fileName.split(' ')[0], p]));
    const [a, b, c] = [by['360_0001'], by['360_0002'], by['360_0003']];
    const w = 512, h = 256, depth = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) depth[r * w + x] = 2 + (3 * x) / w;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    g.putImageData(new ImageData(encodeDepth(depth), w, h), 0, 0);
    await db.putBlob(a.id + ':depth', await new Promise((r) => cv.toBlob(r, 'image/png')));
    await db.putPhoto({ ...a, room: { name: 'Salon' }, relief: { kind: 'ai', h: 1.6, key: reliefKey(a.params) }, hotspots: [{ id: 'h1', target: b.id, yaw: 90, pitch: 0, label: '' }, { id: 'h2', target: c.id, yaw: -90, pitch: 0, label: '' }, { id: 'h5', target: b.id, yaw: 150, pitch: 0, label: '' }] });
    await db.putPhoto({ ...b, room: { name: 'Salon' }, hotspots: [{ id: 'h3', target: a.id, yaw: -90, pitch: 0, label: '' }] });
    await db.putPhoto({ ...c, room: { name: 'Cuisine' }, hotspots: [{ id: 'h4', target: a.id, yaw: 90, pitch: 0, label: '' }] });
    return { a: a.id, b: b.id, c: c.id };
  });

  // ---------- casque ----------
  await page.goto(base + '#/');
  await page.goto(base + '#/view/' + ids.a);
  await page.waitForSelector('.ps-player canvas');
  await page.waitForTimeout(1200);
  check((await ds('hotOut')) === '0,1,0', `flèches : le lien vers la cuisine mène hors de la pièce (${await ds('hotOut')}), pas celui vers l’autre photo du salon`);
  // Téléphone tenu en paysage (capteurs simulés), regard vers l'est (lien vers salon 2).
  await page.evaluate(() => {
    window.__orient = setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 90, gamma: 0 })), 50);
  });
  await page.click('.ps-mode[data-mode=cardboard]');
  await page.waitForSelector('.ps-player.stereo', { timeout: 10000 });
  await page.waitForTimeout(2500);
  const hd = (await ds('hotDist')).split(',').map(Number);
  const rdist = +(await ds('reticleDist'));
  const conv = +(await ds('convergence'));
  const mini = +(await ds('retMini'));
  check(hd.length === 3 && hd.every((d) => d > 2.5 && d < 8.5) && rdist <= conv * 1.03 && (Math.abs(rdist / conv - 1) < 0.03 || hd.some((d) => Math.abs(rdist / d - 1) < 0.06)), `casque : rond de visée à la plus courte distance entre l’objet regardé (${conv} m) et la cible désignée (cibles à ${hd.join(' et ')} m) : ${rdist} m`);
  const col0 = await ds('retColor');
  // Une seule flèche de couleur par autre pièce, aucune vers les autres liens de la pièce.
  check((await ds('retDir')) !== '' && col0 === '' && mini === 1, `casque : grande flèche blanche vers le lien du salon le plus proche, une seule flèche de couleur (vers la cuisine) : ${mini}`);
  await page.screenshot({ path: path.join(shots, '01-casque-fleches.png') });
  // Regard vers l'ouest : la grande flèche désigne la cuisine, de la couleur de la cuisine ; plus de flèche de couleur.
  for (let k = 0; k < 3; k++) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(450);
  }
  await page.waitForTimeout(600);
  const col1 = await ds('retColor'), mini1 = +(await ds('retMini'));
  check(col1 !== '' && mini1 === 0, `casque : vers la cuisine, grande flèche de la couleur de la cuisine (${col1}), pas d’autre flèche de couleur (${mini1})`);
  await page.screenshot({ path: path.join(shots, '01b-casque-autre-piece.png') });
  // Arrivée sur une photo : cibles inactives un moment.
  await page.evaluate(() => [...document.querySelectorAll('.ps-label')][0].click());
  const lockedAt = await page.waitForFunction(() => document.querySelector('.ps-player').dataset.locked === '1' && /salon 2/.test(document.querySelector('.ps-title').textContent), null, { timeout: 8000 }).then(() => Date.now(), () => 0);
  const unlockedAt = lockedAt ? await page.waitForFunction(() => !document.querySelector('.ps-player').dataset.locked, null, { timeout: 5000 }).then(() => Date.now(), () => 0) : 0;
  const lockMs = unlockedAt - lockedAt;
  check(lockedAt && unlockedAt && lockMs > 700 && lockMs < 2500, `casque : en arrivant sur une photo, les cibles sont inactives ≈ ${(lockMs / 1000).toFixed(1)} s`);
  await page.evaluate(() => clearInterval(window.__orient));
  await page.click('.ps-exit-vr');
  await page.waitForTimeout(400);

  // ---------- scénario : enregistrement ----------
  await page.goto(base + '#/');
  await page.goto(base + '#/view/' + ids.a);
  await page.waitForSelector('.ps-player canvas');
  await page.waitForTimeout(1200);
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Visite test' : undefined));
  await page.click('.ps-scn-btn');
  await page.click('.ps-scn-rec');
  const cb = await page.locator('.ps-player canvas').boundingBox();
  const cx = cb.x + cb.width / 2, cy = cb.y + cb.height / 2;
  await page.waitForTimeout(500);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 300, cy, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const yawRec = +(await ds('yaw'));
  await page.evaluate(() => [...document.querySelectorAll('.ps-label')].find((b) => /salon 2/.test(b.textContent)).click());
  await page.waitForFunction(() => /salon 2/.test(document.querySelector('.ps-title').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(800);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy + 60, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const yawEnd = +(await ds('yaw'));
  await page.click('.ps-scn-stop');
  await page.waitForTimeout(500);
  const saved = await db(async (db) => (await db.getPlanDrawing()).scenarios);
  const s0 = saved && saved[0];
  check(s0 && s0.name === 'Visite test' && s0.files.length === 2 && s0.steps.length >= 4 && /salon 1/.test(s0.files[0]), `scénario enregistré avec le plan : « ${s0 && s0.name} », ${s0 && s0.files.length} photos, ${s0 && s0.steps.length} étapes, ${s0 ? (s0.steps[s0.steps.length - 1][0] / 10).toFixed(1) : '?'} s`);
  const json = await page.evaluate(async () => {
    const db = await import('./src/db.js');
    const { buildSettings } = await import('./src/settings-file.js');
    return buildSettings(await db.listPhotos(), await db.getPlanDrawing());
  });
  check(json.plan && json.plan.scenarios && json.plan.scenarios.length === 1, 'scénario rangé dans photosphere.json (avec le plan)');

  // ---------- lecture ----------
  await page.goto(base + '#/');
  await page.goto(base + '#/view/' + ids.c);
  await page.waitForSelector('.ps-player canvas');
  await page.waitForTimeout(1000);
  await page.click('.ps-scn-btn');
  await page.click('.ps-scn-play');
  const playing = await ds('scenario');
  const seen = new Set();
  const t0 = Date.now();
  let yawMid = null;
  while (Date.now() - t0 < 20000) {
    const st = await page.evaluate(() => ({ sc: document.querySelector('.ps-player').dataset.scenario, title: document.querySelector('.ps-title').textContent, yaw: +document.querySelector('.ps-player').dataset.yaw }));
    seen.add(st.title);
    if (/salon 1/.test(st.title) && yawMid === null && Date.now() - t0 > 1500) yawMid = st.yaw;
    if (!st.sc) break;
    await page.waitForTimeout(150);
  }
  const endToast = await page.evaluate(() => document.querySelector('.ps-toast').textContent);
  const yawAfter = +(await ds('yaw'));
  const d = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  check(playing === 'playing' && [...seen].some((t) => /salon 1/.test(t)) && [...seen].some((t) => /salon 2/.test(t)), `lecture : les photos s’enchaînent comme enregistré (${[...seen].join(' → ')})`);
  check(d(yawAfter, yawEnd) < 8 && yawMid !== null, `lecture : la vue suit l’enregistrement (fin à ${yawAfter.toFixed(0)}°, enregistrée à ${yawEnd.toFixed(0)}° ; à ${yawMid}° pendant salon 1, enregistrée ≈ ${yawRec.toFixed(0)}°)`);
  check(/Fin du scénario/.test(endToast) && !(await ds('scenario')), 'fin du scénario signalée ; on continue librement');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 150, cy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(d(+(await ds('yaw')), yawAfter) > 5, 'après la fin, la vue se déplace à la main');
  // Reprise en main pendant la lecture.
  await page.click('.ps-scn-btn');
  await page.click('.ps-scn-play');
  await page.waitForTimeout(1200);
  await page.mouse.click(cx + 100, cy + 100);
  await page.waitForTimeout(300);
  const taken = await page.evaluate(() => document.querySelector('.ps-toast').textContent);
  check(!(await ds('scenario')) && /repris la main/.test(taken), 'lecture interrompue en touchant la vue : on reprend la main');

  // ---------- lien à envoyer ----------
  await page.click('.ps-scn-btn');
  await page.click('.ps-scn-send');
  await page.waitForTimeout(400);
  const noFolder = await page.evaluate(() => document.querySelector('.ps-toast').textContent);
  check(/dossier Google Drive/.test(noFolder), 'lien : sans dossier Google Drive indiqué, PhotoSphère explique quoi faire');
  await db(async (db) => db.putSetting('drive-sync', { link: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345' }));
  await page.click('.ps-scn-send');
  await page.waitForSelector('.ps-scn-share input');
  const link = await page.inputValue('.ps-scn-share input');
  const back = await page.evaluate(async (l) => {
    const { decodeScenario } = await import('./src/scenario.js');
    return decodeScenario(new URLSearchParams(l.split('?')[1]).get('sc'));
  }, link);
  check(/#\/parcours\?drive=1AbCd.*&sc=z/.test(link) && back.name === 'Visite test' && back.steps.length === s0.steps.length, `lien à envoyer : parcours Google Drive + scénario compressé (${link.length} caractères)`);
  await page.screenshot({ path: path.join(shots, '02-scenarios.png') });

  // ---------- parcours partagé ouvert par le lien : lecture dès l'ouverture ----------
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'photosphere-relief'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'photosphere.json'), JSON.stringify(json));
  for (const f of files) fs.copyFileSync(f, path.join(tmp, path.basename(f)));
  const sc = new URLSearchParams(link.split('?')[1]).get('sc');
  await page.goto(base + '#/');
  await page.goto(`${base}#/parcours?url=${encodeURIComponent(base + 'tests/' + path.basename(tmp) + '/')}&sc=${sc}`);
  const autoplay = await page.waitForFunction(() => document.querySelector('.ps-player') && document.querySelector('.ps-player').dataset.scenario === 'playing', null, { timeout: 30000 }).then(() => true, () => false);
  const first = await page.textContent('.ps-title').catch(() => '');
  const done = await page.waitForFunction(() => !document.querySelector('.ps-player').dataset.scenario, null, { timeout: 30000 }).then(() => true, () => false);
  const last = await page.textContent('.ps-title').catch(() => '');
  check(autoplay && /salon 1/.test(first) && done && /salon 2/.test(last), `parcours partagé ouvert par le lien : le scénario se joue dès l’ouverture (${first} → ${last}), puis on continue librement`);
  await page.click('.ps-scn-btn');
  const listed = await page.locator('.ps-scn-item').count();
  check(listed === 1, 'parcours partagé : les scénarios du parcours sont proposés dans 🎞 Scénarios');
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}
fs.rmSync(tmp, { recursive: true, force: true });
check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
console.log(`Captures : ${shots}`);
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
