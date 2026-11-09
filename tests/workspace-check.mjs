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
  // Deux liens : un placé à la main (a → b, vers l'est) et son retour automatique (b → a).
  const ids = await page.evaluate(async () => {
    const db = await import('./src/db.js');
    const [a, b] = (await db.listPhotos()).sort((x, y) => x.name.localeCompare(y.name));
    await db.putPhoto({ ...a, hotspots: [{ id: 'h1', target: b.id, yaw: 90, pitch: 0, label: '' }], mapPos: undefined });
    await db.putPhoto({ ...b, hotspots: [{ id: 'h2', target: a.id, yaw: -90, pitch: 0, label: '', auto: true }], mapPos: undefined });
    return { a: a.id, b: b.id };
  });
  await page.goto(base + '#/plan');
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(800);
  check((await page.locator('.plan-node').count()) === 2 && (await page.locator('.plan-links line.auto').count()) === 1, 'plan : deux photos et leurs liens');
  const na = await page.locator(`.plan-node[data-id="${ids.a}"] .plan-ball`).boundingBox();
  const nb = await page.locator(`.plan-node[data-id="${ids.b}"] .plan-ball`).boundingBox();
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
  const nb2 = await page.locator(`.plan-node[data-id="${ids.a}"] .plan-ball`).boundingBox();
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
