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
  // Plage : une photo, puis Maj + clic sur une autre.
  await page.click('[data-act=select-none]');
  await page.locator('.card [data-select]').nth(0).click();
  await page.locator('.card [data-select]').nth(1).click({ modifiers: ['Shift'] });
  check((await page.textContent('.selection-count')).includes('2 sélectionnée'), 'bibliothèque : Maj + clic sélectionne la plage');
  await page.click('[data-act=select-none]');
  await page.locator('.card .thumb').nth(1).click({ modifiers: ['Control'] });
  check((await page.textContent('.selection-count')).includes('1 sélectionnée') && !page.url().includes('#/view'), 'bibliothèque : Ctrl + clic sur une vignette la coche sans l’ouvrir');
  await page.locator('.card .thumb').nth(0).click({ modifiers: ['Shift'] });
  check((await page.textContent('.selection-count')).includes('2 sélectionnée'), 'bibliothèque : Maj + clic sur une vignette sélectionne la plage');
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
  // Second passage : les photos déjà redressées sont ignorées.
  const before2 = await db(async (db) => (await db.listPhotos()).map((p) => JSON.stringify(p.params)).join());
  await page.click('[data-act=select-all]');
  await page.click('[data-act=batch-level]');
  await page.waitForSelector('.batch-report', { timeout: 120000 });
  const report2 = await page.textContent('dialog h2');
  const after2 = await db(async (db) => (await db.listPhotos()).map((p) => JSON.stringify(p.params)).join());
  check(/2 ignorée/.test(report2) && before2 === after2, `redressement par lot : photos déjà redressées ignorées (« ${report2} »)`);
  await page.click('dialog [data-close]');

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
  // Photo agrandie d'un clic, nom modifiable.
  const placedId = await db(async (db) => (await db.listPhotos()).find((p) => p.mapPlaced).id);
  const small = await page.locator(`.plan-node[data-id="${placedId}"] .plan-pic`).boundingBox();
  await page.mouse.click(small.x + small.width / 2, small.y + small.height / 2);
  await page.waitForTimeout(500);
  const bigBox = await page.locator('.plan-node.selected .plan-pic').boundingBox();
  check(bigBox && Math.abs(bigBox.width / small.width - 8) < 0.4, `plan : clic sur une photo → affichée 8 fois plus grande (${small.width.toFixed(0)} → ${bigBox && bigBox.width.toFixed(0)} px)`);
  await page.selectOption('[data-zoom]', '5');
  await page.waitForTimeout(300);
  const box5 = await page.locator('.plan-node.selected .plan-pic').boundingBox();
  check(box5 && Math.abs(box5.width / small.width - 5) < 0.3, `plan : agrandissement réglable (×5 → ${box5 && box5.width.toFixed(0)} px)`);
  await page.selectOption('[data-zoom]', '8');
  await page.waitForTimeout(300);
  await page.fill('.plan-name-input', 'Salon côté jardin');
  await page.press('.plan-name-input', 'Enter');
  await page.waitForTimeout(400);
  const renamed = await db(async (db) => (await db.listPhotos()).some((p) => p.name === 'Salon côté jardin'));
  check(renamed, 'plan : nom de la photo agrandie modifié et enregistré');
  await page.screenshot({ path: path.join(shots, '05-plan-photo-agrandie.png') });
  await page.mouse.click(vb.x + vb.width - 60, vb.y + 60);
  await page.waitForTimeout(400);
  check((await page.locator('.plan-node.selected').count()) === 0 && (await page.locator('.plan-name-input').count()) === 0, 'plan : clic dans le vide → taille normale');
  // Agrandie puis déplacée : elle reprend aussitôt sa taille.
  const sm = await page.locator(`.plan-node[data-id="${placedId}"] .plan-pic`).boundingBox();
  await page.mouse.click(sm.x + sm.width / 2, sm.y + sm.height / 2);
  await page.waitForTimeout(400);
  const big2 = await page.locator('.plan-node.selected .plan-pic').boundingBox();
  await page.mouse.move(big2.x + big2.width / 2, big2.y + big2.height / 2);
  await page.mouse.down();
  await page.mouse.move(big2.x + big2.width / 2 + 40, big2.y + big2.height / 2 + 10, { steps: 4 });
  const during = await page.locator('.plan-node.selected').count();
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(during === 0, 'plan : la photo agrandie reprend sa taille dès qu’on la déplace');
  // Relier les deux photos (déposer la photo non placée sur l'autre), puis sélectionner et supprimer le lien.
  const poolId = await db(async (db) => (await db.listPhotos()).find((p) => !p.mapPlaced).id);
  await page.click('[data-fit]');
  await page.waitForTimeout(300);
  const a1 = await page.locator(`.plan-node[data-id="${poolId}"] .plan-pic`).boundingBox();
  const b1 = await page.locator(`.plan-node[data-id="${placedId}"] .plan-pic`).boundingBox();
  await page.mouse.move(a1.x + a1.width / 2, a1.y + a1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const nLinks = await db(async (db) => (await db.listPhotos()).reduce((n, p) => n + (p.hotspots || []).length, 0));
  // Milieu du trait cliquable (calculé : un trait horizontal a une boîte de hauteur nulle).
  const hit = await page.evaluate(() => {
    const l = document.querySelector('.plan-contacts line.link-hit');
    if (!l) return null;
    const m = l.getScreenCTM();
    const pt = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
    const a = pt(+l.getAttribute('x1'), +l.getAttribute('y1')), b = pt(+l.getAttribute('x2'), +l.getAttribute('y2'));
    return { x: a.x + (b.x - a.x) * 0.6, y: a.y + (b.y - a.y) * 0.6 };
  });
  await page.mouse.click(hit.x, hit.y);
  await page.waitForTimeout(300);
  const selShown = (await page.locator('.plan-links line.selected').count()) >= 2 && (await page.isVisible('[data-del-link=both]'));
  await page.screenshot({ path: path.join(shots, '05b-lien-selectionne.png') });
  await page.click('[data-del-link=both]');
  await page.waitForTimeout(600);
  const afterDel = await db(async (db) => (await db.listPhotos()).map((p) => ({ n: (p.hotspots || []).length, placed: !!(p.mapPlaced && p.mapPos) })));
  check(nLinks === 2 && selShown && afterDel.every((x) => x.n === 0 && x.placed), `plan : lien sélectionné d’un clic (en rouge) puis supprimé dans les deux sens, photos restées sur le plan (${JSON.stringify(afterDel)})`);
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
  await page.screenshot({ path: path.join(shots, '06-plan.png') });
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}
check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
