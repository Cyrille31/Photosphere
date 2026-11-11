// Vérification dans Chromium : sélection multiple et traitements par lot dans la bibliothèque,
// liens de l'éditeur (clic sur l'image, Ctrl + glisser), manuel, plan (photo placée sans lien,
// trait déplacé avec l'outil Traits).
// Usage : node tests/selection-check.mjs [dossier-captures]
// Le relief par lot n'est testé que si PS_DEPTH_ASSETS est défini (voir plan-relief-check.mjs).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-sel-'));
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

// Pièce synthétique (bandes verticales, sol, plafond) photographiée caméra penchée de `tilt`.
async function makeRoom(name, tilt) {
  const b64 = await page.evaluate(async (tilt) => {
    const { levelMatrix } = await import('./src/math.js');
    const Rt = levelMatrix(tilt.yaw, tilt.pitch, tilt.roll);
    const W = 2048, H = 1024;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < H; y++) {
      const lat = (0.5 - (y + 0.5) / H) * Math.PI;
      for (let x = 0; x < W; x++) {
        const lon = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
        const s = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
        const w = [Rt[0] * s[0] + Rt[1] * s[1] + Rt[2] * s[2], Rt[3] * s[0] + Rt[4] * s[1] + Rt[5] * s[2], Rt[6] * s[0] + Rt[7] * s[1] + Rt[8] * s[2]];
        const az = (Math.atan2(w[0], w[2]) / Math.PI) * 180 + 180;
        const el = (Math.asin(Math.max(-1, Math.min(1, w[1]))) / Math.PI) * 180;
        let v = [210, 120, 170, 90][Math.floor(az / 11) % 4];
        if (el < -25) v = 70;
        if (el > 35) v = 235;
        const i = (y * W + x) * 4, n = rnd() * 18;
        img.data[i] = v * 0.95 + n;
        img.data[i + 1] = v * 0.85 + n;
        img.data[i + 2] = v * 0.7 + n;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    const u = new Uint8Array(await blob.arrayBuffer());
    let str = '';
    for (let i = 0; i < u.length; i += 0x8000) str += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(str);
  }, tilt);
  const file = path.join(shots, name);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

try {
  await page.goto(base);
  await page.evaluate(async () => (await import('./src/db.js')).putSetting('app', { outWidth: 4096, quality: 85 }));
  await page.reload();
  const files = [await makeRoom('salon.jpg', { yaw: 20, pitch: 6, roll: -5 }), await makeRoom('bureau.jpg', { yaw: -40, pitch: -4, roll: 7 })];
  await page.locator('input[type=file][accept^="image"]').setInputFiles(files);
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 300000 });

  // ---------- bibliothèque : sélection et redressement par lot ----------
  check(await page.isHidden('.selection-actions'), 'bibliothèque : actions groupées cachées sans sélection');
  await page.locator('.card [data-select]').first().check();
  check((await page.textContent('.selection-count')).includes('1 sélectionnée'), 'bibliothèque : une photo cochée');
  await page.click('[data-act=select-all]');
  check((await page.textContent('.selection-count')).includes('2 sélectionnée'), 'bibliothèque : « Tout sélectionner »');
  await page.screenshot({ path: path.join(shots, '01-selection.png') });
  const before = await db(async (db) => (await db.listPhotos()).map((p) => ({ id: p.id, ...p.params })));
  await page.click('[data-act=batch-level]');
  await page.waitForSelector('.batch-report', { timeout: 240000 });
  const report = await page.textContent('dialog h2');
  await page.screenshot({ path: path.join(shots, '02-bilan-redressement.png') });
  const after = await db(async (db) => (await db.listPhotos()).map((p) => ({ id: p.id, status: p.status, ...p.params })));
  const changed = after.filter((a) => {
    const b = before.find((x) => x.id === a.id);
    return Math.abs(a.pitch - b.pitch) + Math.abs(a.roll - b.roll) > 1;
  });
  check(/2 \/ 2/.test(report) && changed.length === 2, `redressement par lot : « ${report} », ${changed.length} photo(s) corrigée(s)`);
  await page.click('dialog [data-close]');
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 300000 });
  check(true, 'photos redressées reconverties');

  if (process.env.PS_DEPTH_ASSETS) {
    const assets = process.env.PS_DEPTH_ASSETS;
    const serveLocal = (dir) => async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'absent' });
      const type = name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'text/javascript' : 'application/octet-stream';
      await route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
    };
    await page.route(/cdn\.jsdelivr\.net\/npm\/onnxruntime-web/, serveLocal(path.join(assets, 'node_modules/onnxruntime-web/dist')));
    await page.route(/huggingface\.co\//, serveLocal(path.join(assets, 'model')));
    await page.click('[data-act=batch-relief]');
    await page.waitForSelector('.batch-report', { timeout: 900000 });
    const rep = await page.textContent('dialog h2');
    const reliefs = await db(async (db) => (await db.listPhotos()).filter((p) => p.relief && p.relief.kind === 'ai').length);
    check(/2 \/ 2/.test(rep) && reliefs === 2, `relief par lot : « ${rep} »`);
    await page.click('dialog [data-close]');
    check((await page.locator('.badge', { hasText: 'Relief' }).count()) === 2, 'badge « Relief » sur les photos');
  } else console.log('  … relief par lot non testé (PS_DEPTH_ASSETS non défini)');

  // ---------- éditeur : liens ----------
  const ids = await db(async (db) => (await db.listPhotos()).map((p) => p.id));
  await db(async (db, ids) => {
    const p = await db.getPhoto(ids[0]);
    const hs = [];
    for (let k = 0; k < 6; k++) hs.push({ id: 'h' + k, target: ids[1], yaw: -150 + k * 60, pitch: 0, label: 'Lien ' + k });
    await db.putPhoto({ ...p, hotspots: hs });
  }, ids);
  await page.goto(base + '#/edit/' + ids[0]);
  await page.waitForSelector('[data-tab=links]');
  await page.waitForTimeout(1200);
  // Vue tournée vers le lien 4 (cap 90°) depuis l'onglet Redresser, puis clic au centre de l'image.
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.click('[data-tab=links]');
  await page.locator('.link-item[data-i="4"] [data-look]').click();
  await page.click('[data-tab=level]');
  const box = await page.locator('.ed-stage canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(900);
  const sel = await page.evaluate(() => {
    const item = document.querySelector('.link-item.active');
    const body = document.querySelector('.ed-body');
    return item && { i: item.dataset.i, dy: item.getBoundingClientRect().top - body.getBoundingClientRect().top, tab: !document.querySelector('[data-panel=links]').hidden };
  });
  check(sel && sel.i === '4' && sel.tab && Math.abs(sel.dy) < 20, `éditeur : clic sur un lien de l’image → onglet Liens, lien sélectionné en haut de la liste (${JSON.stringify(sel)})`);
  await page.screenshot({ path: path.join(shots, '03-lien-selectionne.png') });
  await page.keyboard.down('Control');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 160, cy - 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  await page.click('[data-save]');
  await page.waitForSelector('.grid');
  const moved = await db(async (db, id) => (await db.getPhoto(id)).hotspots[4], ids[0]);
  check(Math.abs(moved.yaw - 90) > 5 && moved.pitch > 2 && moved.auto === false, `éditeur : Ctrl + glisser déplace le lien (cap 90° → ${moved.yaw.toFixed(1)}°, élévation ${moved.pitch.toFixed(1)}°)`);

  // ---------- manuel ----------
  await page.click('#btn-help');
  await page.waitForSelector('dialog.manual-dialog');
  check((await page.locator('.manual-body section').count()) >= 8, 'manuel : ouvert depuis l’en-tête, sections présentes');
  await page.click('dialog.manual-dialog [data-close]');
  await page.goto(base + '#/edit/' + ids[0]);
  await page.waitForSelector('[data-tab=links]');
  await page.click('[data-tab=links]');
  await page.click('[data-panel=links] [data-manual]');
  await page.waitForSelector('dialog.manual-dialog');
  await page.waitForTimeout(400);
  const secTop = await page.evaluate(() => {
    const s = document.querySelector('#man-liens'), b = document.querySelector('.manual-body');
    return s.getBoundingClientRect().top - b.getBoundingClientRect().top;
  });
  check(Math.abs(secTop) < 30, `manuel : le bouton 📖 de l’onglet Liens ouvre la section « Liens » (${secTop.toFixed(0)} px du haut)`);
  await page.screenshot({ path: path.join(shots, '04-manuel.png') });
  await page.click('dialog.manual-dialog [data-close]');
  await page.click('[data-cancel]');
  await page.waitForSelector('.grid');

  // ---------- plan : photo placée sans lien, trait déplacé avec l'outil Traits ----------
  await db(async (db) => {
    for (const p of await db.listPhotos()) await db.putPhoto({ ...p, hotspots: [], mapPos: undefined, mapPlaced: false });
  });
  await page.goto(base + '#/');
  await page.goto(base + '#/plan');
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(600);
  check((await page.textContent('.plan-pool')).includes('(2)'), 'plan : deux photos non placées dans leur zone');
  const node = page.locator('.plan-node .plan-pic').first();
  const nb = await node.boundingBox();
  const vb = await page.locator('.plan-view').boundingBox();
  await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
  await page.mouse.down();
  await page.mouse.move(vb.x + 200, vb.y + 120, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const placed = await db(async (db) => (await db.listPhotos()).filter((p) => p.mapPlaced && p.mapPos).length);
  check(placed === 1 && (await page.textContent('.plan-pool')).includes('(1)'), 'plan : photo glissée hors de la zone → placée sur le plan, sans lien');
  await page.reload();
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(500);
  check((await page.textContent('.plan-pool')).includes('(1)'), 'plan : photo placée retrouvée après rechargement');
  // Trait tracé puis déplacé en restant dans l'outil Traits.
  await page.click('[data-tool=line]');
  await page.mouse.click(vb.x + 500, vb.y + 200);
  await page.waitForTimeout(400);
  await page.mouse.click(vb.x + 800, vb.y + 200);
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  const l0 = (await db((db) => db.getPlanDrawing())).lines[0];
  await page.mouse.move(vb.x + 650, vb.y + 200);
  await page.mouse.down();
  await page.mouse.move(vb.x + 650, vb.y + 280, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const d1 = await db((db) => db.getPlanDrawing());
  const l1 = d1.lines[0];
  check(d1.lines.length === 1 && l1.y1 > l0.y1 + 10 && l1.y2 > l0.y2 + 10 && l1.x1 === l0.x1, `plan : trait déplacé directement avec l’outil Traits (${d1.lines.length} trait, y ${l0.y1} → ${l1.y1})`);
  await page.click('[data-tool=photos]');
  await page.screenshot({ path: path.join(shots, '05-plan.png') });
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}
check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
