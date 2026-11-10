// Vérification dans Chromium du dossier de travail (enregistrement automatique de photosphere.json,
// renommage des fichiers) et du plan des photos. Le sélecteur de dossier est simulé par le stockage
// privé du navigateur (même interface que un vrai dossier).
// Usage : node tests/workspace-check.mjs [dossier-captures]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-ws-'));
fs.mkdirSync(shots, { recursive: true });

const server = await serve(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) failures++;
};

// Sélecteur de dossier simulé : un dossier « photos » dans le stockage privé du navigateur.
await page.addInitScript(() => {
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('photos', { create: true });
});

const readFolder = () =>
  page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photos');
    const names = [];
    for await (const e of dir.values()) names.push(e.name);
    let json = null;
    try {
      json = JSON.parse(await (await (await dir.getFileHandle('photosphere.json')).getFile()).text());
    } catch (e) {
      // pas encore écrit
    }
    return { names: names.sort(), json };
  });

try {
  await page.goto(base);
  // Deux photos 360 (2:1) déposées dans le dossier.
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photos', { create: true });
    for (const [name, hue] of [['SAM_0001.JPG', 20], ['SAM_0002.JPG', 200]]) {
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 512;
      const g = c.getContext('2d');
      for (let x = 0; x < 1024; x += 32) {
        g.fillStyle = `hsl(${hue + x / 8}, 70%, ${40 + (x % 64) / 4}%)`;
        g.fillRect(x, 0, 32, 512);
      }
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(blob);
      await w.close();
    }
    const db = await import('./src/db.js');
    await db.putSetting('app', { outWidth: 4096, quality: 85, renameFiles: true });
  });
  await page.reload();

  console.log('Dossier de travail');
  await page.click('[data-act=workspace]');
  await page.click('[data-ws=link]');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 2, null, { timeout: 60000 });
  check(true, 'photos du dossier importées');
  check((await page.textContent('[data-act=workspace]')).includes('photos ✓'), 'bouton : dossier lié et actif');
  await page.waitForTimeout(2500);
  let f = await readFolder();
  check(f.json && f.json.photos.length === 2, 'photosphere.json écrit automatiquement dans le dossier');

  // Renommage : la photo et son fichier. Le stockage simulé refuse les noms accentués : c'est
  // l'occasion de vérifier qu'un renommage impossible laisse le fichier d'origine intact.
  const rename = async (name) => {
    await page.locator('.card .card-title').first().click();
    await page.fill('.rename-input', name);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    return (await page.locator('.toast').allTextContents()).join(' | ');
  };
  let msg = await rename('Salon côté jardin');
  f = await readFolder();
  check(msg.includes('Fichier non renommé') && f.names.includes('SAM_0001.JPG') && f.names.length === 3, `renommage impossible : message affiché, fichier d’origine intact (${f.names.join(', ')})`);
  await page.waitForTimeout(4000);
  msg = await rename('Salon cote jardin');
  f = await readFolder();
  check(f.names.includes('Salon cote jardin.JPG') && !f.names.includes('SAM_0001.JPG'), `fichier renommé sur le disque : ${f.names.join(', ')}`);
  check(f.json && f.json.photos.some((p) => p.file === 'Salon cote jardin.JPG' && p.name === 'Salon cote jardin'), 'photosphere.json à jour (nom et fichier)');

  console.log('Plan');
  // Les deux photos, encore sans lien, sont dans la zone des photos non reliées ; on les relie
  // depuis le plan avec « 🔗 Relier ».
  await page.goto(base + '#/plan');
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(600);
  check((await page.locator('.plan-pool').count()) === 1 && (await page.textContent('.plan-pool')).includes('(2)'), 'plan : photos non reliées rangées dans leur zone');
  const firstIds = await page.$$eval('.plan-node', (ns) => ns.map((n) => n.dataset.id));
  const p0 = await page.locator(`.plan-node[data-id="${firstIds[0]}"] .plan-pic`).boundingBox();
  await page.mouse.click(p0.x + p0.width / 2, p0.y + p0.height / 2);
  await page.click(`.plan-node[data-id="${firstIds[0]}"] [data-act=link]`);
  const p1 = await page.locator(`.plan-node[data-id="${firstIds[1]}"] .plan-pic`).boundingBox();
  await page.mouse.click(p1.x + p1.width / 2, p1.y + p1.height / 2);
  await page.waitForTimeout(800);
  const made = await page.evaluate(async (ids) => {
    const db = await import('./src/db.js');
    return Promise.all(ids.map(async (id) => (await db.getPhoto(id)).hotspots.map((h) => ({ t: h.target, auto: h.auto }))));
  }, firstIds);
  check(made[0].length === 1 && made[1].length === 1 && made[0][0].t === firstIds[1] && made[1][0].t === firstIds[0] && made[0][0].auto && made[1][0].auto,
    'plan : « 🔗 Relier » crée les deux liens automatiques réciproques');
  check((await page.locator('.plan-pool').count()) === 0, 'plan : les photos reliées quittent la zone des non reliées');
  const nameH = await page.locator('.plan-name').first().evaluate((n) => getComputedStyle(n).whiteSpace);
  check(nameH === 'normal', 'plan : noms complets, sur plusieurs lignes si besoin');
  // Deux liens : un placé à la main (a → b, vers l'est) et son retour automatique (b → a).
  const ids = await page.evaluate(async () => {
    const db = await import('./src/db.js');
    const [a, b] = (await db.listPhotos()).sort((x, y) => x.name.localeCompare(y.name));
    await db.putPhoto({ ...a, hotspots: [{ id: 'h1', target: b.id, yaw: 90, pitch: 0, label: '' }], mapPos: undefined });
    await db.putPhoto({ ...b, hotspots: [{ id: 'h2', target: a.id, yaw: -90, pitch: 0, label: '', auto: true }], mapPos: undefined });
    return { a: a.id, b: b.id };
  });
  await page.goto(base + '#/');
  await page.waitForSelector('.card');
  await page.goto(base + '#/plan');
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(800);
  check((await page.locator('.plan-node').count()) === 2 && (await page.locator('.plan-links:not(.over) line.auto').count()) === 1, 'plan : deux photos et leurs liens');
  const na = await page.locator(`.plan-node[data-id="${ids.a}"] .plan-pic`).boundingBox();
  const nb = await page.locator(`.plan-node[data-id="${ids.b}"] .plan-pic`).boundingBox();
  check(nb.x > na.x + 40 && Math.abs(nb.y - na.y) < 10, 'plan : la photo liée vers l’est est placée à droite');
  await page.screenshot({ path: path.join(shots, 'plan-avant.png') });
  // On déplace b au nord de a.
  await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
  await page.mouse.down();
  const tx = na.x + na.width / 2, ty = na.y - 160;
  for (let k = 1; k <= 12; k++) await page.mouse.move(nb.x + nb.width / 2 + ((tx - nb.x - nb.width / 2) * k) / 12, nb.y + nb.height / 2 + ((ty - nb.y - nb.height / 2) * k) / 12);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, 'plan-apres.png') });
  const links = await page.evaluate(async (ids) => {
    const db = await import('./src/db.js');
    return { a: (await db.getPhoto(ids.a)).hotspots[0].yaw, b: (await db.getPhoto(ids.b)).hotspots[0].yaw };
  }, ids);
  check(Math.abs(Math.abs(links.b) - 180) < 8, `lien retour automatique réorienté vers le sud (${links.b.toFixed(1)}°)`);
  check(links.a === 90, 'lien placé à la main inchangé (90°)');
  // Double-clic sur une photo du plan : visionneuse, puis retour au plan.
  const nb2 = await page.locator(`.plan-node[data-id="${ids.a}"] .plan-pic`).boundingBox();
  await page.mouse.click(nb2.x + nb2.width / 2, nb2.y + nb2.height / 2);
  await page.mouse.click(nb2.x + nb2.width / 2, nb2.y + nb2.height / 2);
  await page.waitForSelector('.ps-player canvas', { timeout: 10000 });
  await page.click('.ps-back');
  await page.waitForSelector('.plan-node');
  check((await page.evaluate(() => location.hash)) === '#/plan', 'double-clic : visionneuse, puis retour au plan');
  await page.waitForTimeout(2500);
  f = await readFolder();
  const jb = f.json && f.json.photos.find((p) => p.name !== 'Salon cote jardin');
  check(jb && jb.mapPos && jb.hotspots[0].auto === true, 'photosphere.json : positions sur le plan et liens automatiques enregistrés');

  // Ctrl + glisser sur une sphère : elle tourne (rotation enregistrée).
  const pa = await page.locator(`.plan-node[data-id="${ids.a}"] .plan-pic`).boundingBox();
  await page.keyboard.down('Control');
  await page.mouse.move(pa.x + pa.width / 2, pa.y + pa.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(pa.x + pa.width / 2 + 3 * k, pa.y + pa.height / 2);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  const rotA = await page.evaluate(async (id) => (await (await import('./src/db.js')).getPhoto(id)).mapRot, ids.a);
  check(rotA && Math.abs(rotA) > 5, `Ctrl + glisser : la sphère tourne (rotation ${rotA}°)`);
  // Point de contact d'un lien déplacé à la main sur la sphère.
  const dot = await page.locator(`[data-contact="${ids.b}"]`).boundingBox();
  const before = await page.evaluate(async (id) => (await (await import('./src/db.js')).getPhoto(id)).hotspots[0], ids.b);
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(dot.x + dot.width / 2 + 3 * k, dot.y + dot.height / 2 + 2 * k);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(async (id) => (await (await import('./src/db.js')).getPhoto(id)).hotspots[0], ids.b);
  check(after.auto === false && (Math.abs(after.yaw - before.yaw) > 3 || Math.abs(after.pitch - before.pitch) > 3),
    `point de contact déplacé : lien placé à la main (${before.yaw.toFixed(0)}° → ${after.yaw.toFixed(0)}°, élévation ${after.pitch.toFixed(0)}°)`);
  // Affichage rectangulaire : les liens aboutissent dans l'image.
  await page.click('[data-mode=rect]');
  await page.waitForTimeout(400);
  const rectOk = await page.evaluate((id) => {
    const pic = document.querySelector(`.plan-node[data-id="${id}"] .plan-pic`).getBoundingClientRect();
    const c = document.querySelector(`[data-contact="${id}"]`).getBoundingClientRect();
    const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
    return document.querySelector('.plan-node').classList.contains('rect') && pic.width > pic.height * 1.8 && cx >= pic.left - 1 && cx <= pic.right + 1 && cy >= pic.top - 1 && cy <= pic.bottom + 1;
  }, ids.b);
  check(rectOk, 'affichage rectangulaire : le lien aboutit dans l’image de la photo');
  await page.screenshot({ path: path.join(shots, 'plan-rectangles.png') });
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
