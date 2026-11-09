// Vérification de bout en bout dans Chromium : génère une fausse photo Gear 360 (double fisheye),
// l'importe, vérifie l'assemblage 7776 x 3888, l'éditeur, la visionneuse (dont le mode casque)
// et la visite autonome exportée. Usage : node tests/browser-check.mjs [dossier-captures]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from './serve.mjs';
import { DEFAULT_LENS_PARAMS } from '../src/gl-source.js';
import { VIGNETTE_P, VIGNETTE_Q } from '../src/calibrate.js';
import { levelMatrix, mat3Apply, mat3Transpose, dirFromLonLat, lonLatFromDir, viewTiltToLevel } from '../src/math.js';

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
    async ({ w, SCENE, lenses }) => {
      eval(SCENE + ';window.scene = scene;');
      const h = w / 2, S = h, fovHalf = (lenses.fov / 2) * Math.PI / 180;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const back = x < S; // comme Samsung : le centre de la photo = moitié droite
          const L = back ? lenses.lensA : lenses.lensB;
          const dx = ((x % S) + 0.5) / S - L.cx, dy = (y + 0.5) / S - L.cy;
          const r = Math.hypot(dx, dy) / L.r;
          const i = (y * w + x) * 4;
          img.data[i + 3] = 255;
          if (r > 1) continue;
          const th = r * fovHalf, a = Math.atan2(-dy, dx) - (L.rot * Math.PI) / 180;
          const st = Math.sin(th);
          const d = back ? [-st * Math.cos(a), st * Math.sin(a), -Math.cos(th)] : [st * Math.cos(a), st * Math.sin(a), Math.cos(th)];
          // Vignettage de la caméra (inverse de la correction appliquée à l'assemblage).
          const t2 = (th / (Math.PI / 2)) ** 2;
          const g = Math.exp((lenses.vigP * t2 + lenses.vigQ * t2 ** 4) / 2.2);
          const col = window.scene(Math.atan2(d[0], d[2]), Math.asin(d[1])).map((v) => 255 * (1 - (1 - v / 255) ** (1 / g)));
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
    { w, SCENE, lenses: { ...DEFAULT_LENS_PARAMS, vigP: VIGNETTE_P, vigQ: VIGNETTE_Q } }
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
        if (err > 12) bad++;
      }
    }
    return { w: bmp.width, h: bmp.height, bad, total, maxErr, xmp: meta.readXmp(bytes), size: out.size, id: p.id, calibrated: !!p.params.autoCalibrated };
  }, SCENE);
  check(result.w === 7776 && result.h === 3888, `JPEG décodable, ${result.w} × ${result.h}, ${(result.size / 1e6).toFixed(1)} Mo`);
  check(result.bad === 0, `assemblage fidèle à la scène (${result.total - result.bad}/${result.total} points, écart max ${result.maxErr})`);
  check(/GPano:ProjectionType="equirectangular"/.test(result.xmp || ''), 'métadonnées XMP photosphère présentes');
  check(result.calibrated, 'calibrage automatique des objectifs effectué');

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
  await page.fill('.slider input[type=number][name=tiltSide]', '6');
  await page.dispatchEvent('.slider input[type=number][name=tiltSide]', 'input');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '03-editeur-3d.png') });
  // Les bascules sont relatives à la vue : après un quart de tour, la bascule latérale devient avant / arrière.
  const cbox = await page.locator('.editor canvas').boundingBox();
  const cx = cbox.x + cbox.width / 2, cy = cbox.y + cbox.height / 2;
  const turn = async (dx) => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(cx + (dx * k) / 10, cy);
    await page.mouse.up();
    await page.waitForTimeout(150);
  };
  await turn(-cbox.height / 2);
  await turn(-cbox.height / 2);
  const fwd = +(await page.inputValue('.slider input[type=number][name=tiltForward]'));
  const side = +(await page.inputValue('.slider input[type=number][name=tiltSide]'));
  check(Math.abs(Math.abs(fwd) - 6) < 0.3 && Math.abs(side) < 0.3, `bascules relatives à la vue : après un quart de tour, avant/arrière ${fwd}°, gauche/droite ${side}°`);
  await turn(cbox.height / 2);
  await turn(cbox.height / 2);
  await page.click('[data-view=flat]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, '04-editeur-plat.png') });
  // Outil horizon : deux clics sur le vrai horizon, vu dans la sortie actuelle penchée de 6°.
  await page.click('[data-tool=horizon]');
  const box = await page.locator('.editor canvas').boundingBox();
  const fw = Math.min(box.width, box.height * 2), fh = fw / 2;
  const top = box.y + (box.height - fh) / 2, left = box.x + (box.width - fw) / 2;
  // Le vrai horizon (équateur de la source) vu dans la sortie actuelle penchée de 6°.
  const lv = viewTiltToLevel({ forward: 0, side: 6, cap: 0 }, 0);
  const Rt = mat3Transpose(levelMatrix(lv.yaw, lv.pitch, lv.roll));
  for (const lon of [-0.4, 1.2]) {
    const ll = lonLatFromDir(mat3Apply(Rt, dirFromLonLat(lon, 0)));
    await page.mouse.click(left + fw * (ll.lon / (2 * Math.PI) + 0.5), top + fh * (0.5 - ll.lat / Math.PI));
  }
  await page.waitForTimeout(200);
  const roll = await page.inputValue('.slider input[type=number][name=tiltSide]');
  const pitch = await page.inputValue('.slider input[type=number][name=tiltForward]');
  check(Math.abs(+roll) < 0.6 && Math.abs(+pitch) < 0.6, `outil horizon : bascules ${roll}° et ${pitch}° (attendu ≈ 0)`);
  // Défaire : revient à l'état d'avant l'outil horizon (bascule de 6°).
  await page.click('[data-undo]');
  await page.waitForTimeout(200);
  const undone = +(await page.inputValue('.slider input[type=number][name=tiltSide]'));
  check(Math.abs(undone - 6) < 0.3, `Défaire : bascule revenue à ${undone}° (avant l’outil horizon)`);
  // Nord : dans la vue à plat, on touche le point de l'horizon situé à +90° (est actuel).
  const capBefore = +(await page.inputValue('.slider input[type=number][name=cap]'));
  await page.click('[data-north]');
  await page.mouse.click(left + fw * 0.75, top + fh * 0.5);
  await page.waitForTimeout(300);
  const capAfter = +(await page.inputValue('.slider input[type=number][name=cap]'));
  const nBox = await page.locator('.ed-cardinal.north').boundingBox();
  check(Math.abs(Math.abs(capAfter - capBefore) - 90) < 3 && nBox && Math.abs(nBox.x + nBox.width / 2 - (box.x + box.width / 2)) < 15,
    `nord indiqué d’un clic : cap ${capBefore.toFixed(1)}° → ${capAfter.toFixed(1)}°, « N » recentré`);
  await page.click('[data-undo]');
  await page.click('[data-undo]');
  // Lien vers la deuxième photo
  await page.click('[data-tab=links]');
  await page.click('[data-add-link]');
  await page.mouse.click(left + fw * 0.6, top + fh * 0.55);
  // Choix de la destination dans la grille de vignettes (taille réglable avec Ctrl + molette).
  await page.waitForSelector('dialog.picker .picker-item img[src]');
  const thumbBefore = await page.$eval('.picker-grid', (g) => g.style.getPropertyValue('--thumb'));
  await page.hover('.picker-grid');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  const thumbAfter = await page.$eval('.picker-grid', (g) => g.style.getPropertyValue('--thumb'));
  check(parseInt(thumbAfter) > parseInt(thumbBefore), `choix par vignettes, taille réglable avec Ctrl + molette (${thumbBefore} → ${thumbAfter})`);
  // Recherche textuelle dans le choix de la photo à lier : rien ne correspond, puis la bonne photo.
  await page.fill('dialog.picker [name=search]', 'cuisine');
  check((await page.locator('dialog.picker .picker-item:visible').count()) === 0 && (await page.isVisible('.picker-empty')), 'choix du lien : recherche sans résultat signalée');
  await page.fill('dialog.picker [name=search]', 'PHONE');
  check((await page.locator('dialog.picker .picker-item:visible').count()) === 1, 'choix du lien : recherche par nom (sans tenir compte des majuscules)');
  await page.press('dialog.picker [name=search]', 'Enter');
  await page.waitForSelector('dialog [name=reverse]');
  await page.click('dialog [data-ok]');
  check((await page.locator('.link-item').count()) === 1, 'lien créé');
  // Vue d'arrivée : on tourne l'aperçu de la photo de destination puis on valide.
  await page.click('[data-arrive]');
  await page.waitForSelector('dialog.arrival canvas');
  await page.waitForTimeout(800);
  const ab = await page.locator('dialog.arrival canvas').boundingBox();
  await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(ab.x + ab.width / 2 - 25 * k, ab.y + ab.height / 2);
  await page.mouse.up();
  await page.click('dialog.arrival [data-ok]');
  await page.waitForTimeout(200);
  check((await page.textContent('.link-item')).includes('réglée'), 'vue d’arrivée réglée sur le lien');
  // Lien retour : enregistre, ouvre la photo de destination, prête à déplacer le lien qui revient.
  await page.click('[data-back]');
  await page.waitForFunction((id) => location.hash.startsWith('#/edit/') && !location.hash.endsWith(id), result.id);
  await page.waitForFunction(() => /Lien retour/.test(document.querySelector('.ed-hint').textContent || ''), null, { timeout: 30000 });
  const backBefore = await page.evaluate(async (id) => (await (await import('./src/db.js')).listPhotos()).find((p) => p.id !== id).hotspots[0], result.id);
  const eb = await page.locator('.editor canvas').boundingBox();
  await page.mouse.click(eb.x + eb.width * 0.3, eb.y + eb.height * 0.5);
  await page.click('[data-save]');
  await page.waitForSelector('.grid');
  const state2 = await page.evaluate(async (id) => {
    const photos = await (await import('./src/db.js')).listPhotos();
    const src = photos.find((p) => p.id === id), dst = photos.find((p) => p.id !== id);
    return { arrive: src.hotspots[0].arrive, back: dst.hotspots[0], counts: photos.map((p) => p.hotspots.length) };
  }, result.id);
  check(state2.arrive && Math.abs(state2.arrive.yaw) > 1, `vue d’arrivée enregistrée (cap ${state2.arrive && state2.arrive.yaw}°)`);
  check(backBefore && state2.back && state2.back.target === result.id && Math.abs(state2.back.yaw - backBefore.yaw) > 1,
    `lien retour déplacé depuis le raccourci « ↩ Lien retour » (${backBefore && backBefore.yaw.toFixed(1)}° → ${state2.back && state2.back.yaw.toFixed(1)}°)`);
  check(state2.counts.join() === '1,1', 'lien aller et lien retour enregistrés');
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 180000 });

  console.log('Renommage et fichier de réglages');
  await page.locator('.card .card-title').first().click();
  await page.fill('.rename-input', 'Entrée du jardin');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.card-title')].some((t) => t.textContent.includes('Entrée du jardin')));
  check(true, 'photo renommée depuis la bibliothèque');
  await page.fill('[name=library-search]', 'entree jardin');
  const shown = await page.locator('.card:visible').count();
  const countText = await page.textContent('.search-count');
  check(shown === 1 && countText.includes('1 photo'), `bibliothèque : recherche « entree jardin » (sans accent) → ${countText}`);
  await page.fill('[name=library-search]', '');
  check((await page.locator('.card:visible').count()) === 2, 'bibliothèque : recherche effacée, toutes les photos visibles');
  // Exporte les réglages, abîme la bibliothèque, puis recharge le fichier.
  const settingsJson = await page.evaluate(async () => {
    const { buildSettings } = await import('./src/settings-file.js');
    const db = await import('./src/db.js');
    const photos = await db.listPhotos();
    const data = buildSettings(photos);
    for (const p of photos) await db.putPhoto({ ...p, name: 'x', params: { ...p.params, yaw: 77 }, hotspots: [] });
    return JSON.stringify(data);
  });
  const settingsPath = path.join(shots, 'photosphere.json');
  fs.writeFileSync(settingsPath, settingsJson);
  check(settingsJson.length < 50000, `fichier de réglages léger (${(settingsJson.length / 1024).toFixed(1)} ko pour 2 photos)`);
  await page.locator('input[type=file][accept^=".json"]').setInputFiles(settingsPath);
  // On attend la fin de l'application des réglages (message de confirmation).
  await page.waitForSelector('.toast:has-text("appliqués à 2 photo")', { timeout: 30000 });
  const restored = await page.evaluate(async () => {
    const db = await import('./src/db.js');
    return (await db.listPhotos()).map((p) => ({ name: p.name, yaw: p.params.yaw, links: p.hotspots.length, targetOk: p.hotspots.every((h) => h.target) }));
  });
  check(restored.every((r) => r.name !== 'x' && r.yaw !== 77 && r.links === 1 && r.targetOk), 'réglages rechargés : noms, redressement et liens retrouvés ' + JSON.stringify(restored));
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 180000 });

  console.log('Visionneuse');
  await page.goto(base + '#/view/' + result.id);
  await page.waitForSelector('.ps-player canvas');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, '05-visionneuse.png') });
  // Bouton Éditer de la visionneuse, puis retour à la même photo.
  await page.click('.ps-edit');
  await page.waitForSelector('.editor canvas');
  check(page.url().endsWith('#/edit/' + result.id), 'bouton Éditer de la visionneuse : éditeur ouvert sur la photo affichée');
  await page.click('[data-cancel]');
  await page.waitForSelector('.ps-player canvas');
  check(page.url().endsWith('#/view/' + result.id), 'retour de l’éditeur vers la visionneuse');
  await page.waitForTimeout(1500);
  // Flèches du clavier : photo suivante puis retour.
  const t0 = await page.textContent('.ps-title');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1200);
  const t1 = await page.textContent('.ps-title');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(1200);
  check(t0 !== t1 && (await page.textContent('.ps-title')) === t0, `visionneuse, flèches du clavier : « ${t0} » → « ${t1} » → retour`);
  await page.click('.ps-list-btn');
  await page.fill('.ps-search', 'phone');
  await page.press('.ps-search', 'Enter');
  await page.waitForFunction(() => document.querySelector('.ps-title').textContent === 'phone_360', null, { timeout: 10000 });
  check(true, 'visionneuse : liste ☰ avec recherche, Entrée ouvre la photo trouvée');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(1200);
  // Éditeur : boutons et flèches, avec enregistrement automatique des modifications.
  await page.click('.ps-edit');
  await page.waitForSelector('.editor canvas');
  await page.waitForFunction(() => document.querySelector('.ed-hint').hidden, null, { timeout: 30000 });
  check((await page.textContent('.ed-count')).trim() === '1 / 2', 'éditeur : compteur de photos affiché');
  await page.fill('.slider input[type=number][name=tiltSide]', '3');
  await page.dispatchEvent('.slider input[type=number][name=tiltSide]', 'input');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((id) => !location.hash.endsWith(id), result.id);
  await page.waitForSelector('.editor canvas');
  const saved = await page.evaluate(async (id) => (await (await import('./src/db.js')).getPhoto(id)).params, result.id);
  check(Math.abs(saved.roll) > 1 || Math.abs(saved.pitch) > 1, 'éditeur, flèche droite : photo suivante, modifications de la précédente enregistrées');
  await page.click('.ed-nav.prev');
  await page.waitForFunction((id) => location.hash.endsWith(id), result.id);
  check(true, 'éditeur, bouton ‹ : retour à la photo précédente');
  // Annule la bascule de test pour la suite.
  await page.waitForSelector('[data-reset-level]');
  await page.click('[data-reset-level]');
  await page.click('[data-save]');
  await page.waitForSelector('.ps-player canvas');
  await page.waitForTimeout(1000);
  // Simule un téléphone tenu en mode paysage (capteurs d'orientation).
  await page.evaluate(() => {
    window.__orient = setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 20, beta: 90, gamma: 0 })), 50);
  });
  await page.click('.ps-mode[data-mode=cardboard]');
  await page.waitForTimeout(1200);
  check(await page.locator('.ps-player.stereo').count() === 1, 'mode casque VR (écran partagé) activé');
  // Réglages du casque : écartement des centres puis RAZ.
  await page.click('.ps-vr-settings');
  await page.$eval('.ps-headset [name=sep]', (i) => {
    i.value = 42;
    i.dispatchEvent(new Event('input'));
  });
  const sepSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('ps-headset')).sep);
  await page.click('.ps-headset [data-preset=v2]');
  const v2 = await page.evaluate(() => JSON.parse(localStorage.getItem('ps-headset')));
  await page.click('.ps-headset [data-preset=reset]');
  const reset = await page.evaluate(() => JSON.parse(localStorage.getItem('ps-headset')));
  check(sepSaved === 42 && v2.k1 === 0.34 && v2.k2 === 0.55 && reset.sep === 50 && reset.k1 === 0.22,
    'casque : écartement des centres réglable, préréglage Cardboard v2, RAZ');
  await page.click('.ps-headset .ps-close-panel');
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
  // Les cibles n'apparaissent qu'à l'approche de la souris : invisibles au départ, on balaie l'image.
  await tour.mouse.move(5, 400);
  await tour.waitForTimeout(400);
  const hiddenAtStart = !(await tour.isVisible('.ps-label'));
  let found = false;
  for (let y = 150; y <= 650 && !found; y += 100) {
    for (let x = 100; x <= 1180 && !found; x += 120) {
      await tour.mouse.move(x, y);
      await tour.waitForTimeout(60);
      found = await tour.isVisible('.ps-label');
    }
  }
  // On vise ensuite la cible elle-même (elle se trouve juste au-dessus de son étiquette).
  const lb = await tour.locator('.ps-label').boundingBox();
  await tour.mouse.move(lb.x + lb.width / 2, lb.y - 22);
  await tour.waitForTimeout(500);
  const opacity = await tour.$eval('.ps-label', (b) => +getComputedStyle(b).opacity);
  check(hiddenAtStart && found && opacity > 0.5, `cible d’un lien invisible au loin, apparaît à l’approche de la souris (opacité ${opacity.toFixed(2)})`);
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
