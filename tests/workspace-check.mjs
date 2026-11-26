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

  // Renommage : la photo et son fichier. Un nom déjà pris par un autre fichier du dossier rend le
  // renommage impossible : le fichier d'origine doit rester intact.
  const rename = async (name) => {
    await page.locator('.card .card-title').first().click();
    await page.fill('.rename-input', name);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    return (await page.locator('.toast').allTextContents()).join(' | ');
  };
  let msg = await rename('SAM_0002');
  f = await readFolder();
  check(msg.includes('Fichier non renommé') && f.names.includes('SAM_0001.JPG') && f.names.filter((n) => n !== '_headers').length === 3 && f.names.includes('_headers'), `renommage impossible : message affiché, fichier d’origine intact (${f.names.join(', ')})`);
  await page.waitForTimeout(4000);
  msg = await rename('Salon cote jardin');
  f = await readFolder();
  check(f.names.includes('Salon cote jardin.JPG') && !f.names.includes('SAM_0001.JPG'), `fichier renommé sur le disque : ${f.names.join(', ')}`);
  check(f.json && f.json.photos.some((p) => p.file === 'Salon cote jardin.JPG' && p.name === 'Salon cote jardin'), 'photosphere.json à jour (nom et fichier)');

  // Relief calculé : sa carte est rangée dans le sous-dossier « photosphere-relief » du dossier.
  await page.evaluate(async () => {
    const db = await import('./src/db.js');
    const { reliefKey } = await import('./src/depth.js');
    const { depthToPng } = await import('./src/depth-ai.js');
    const p = (await db.listPhotos()).find((x) => x.fileName === 'Salon cote jardin.JPG');
    await db.putBlob(p.id + ':depth', await depthToPng(new Float32Array(2048 * 1024).fill(2)));
    await db.updatePhoto(p.id, (cur) => ({ ...cur, relief: { kind: 'ai', h: 1.6, key: reliefKey(cur.params) } }));
  });
  await page.waitForTimeout(3500);
  const reliefFiles = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photos');
    try {
      const sub = await dir.getDirectoryHandle('photosphere-relief');
      const out = [];
      for await (const e of sub.values()) out.push(e.name);
      return out;
    } catch (e) {
      return [];
    }
  });
  check(reliefFiles.includes('Salon cote jardin.JPG.profondeur.png'), `carte de relief rangée dans photosphere-relief (${reliefFiles.join(', ')})`);

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

  // ---------- fichier du dossier plus ancien que le travail en cours : alerte, rien n'est perdu ----------
  const countLinks = () => page.evaluate(async () => (await (await import('./src/db.js')).listPhotos()).reduce((n, p) => n + p.hotspots.length, 0));
  const writeStale = () =>
    page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photos');
      const fh = await dir.getFileHandle('photosphere.json');
      const data = JSON.parse(await (await fh.getFile()).text());
      data.photos.forEach((e) => (e.hotspots = []));
      const w = await fh.createWritable();
      await w.write(JSON.stringify(data));
      await w.close();
    });
  const reimport = async () => {
    await page.goto(base + '#/');
    await page.waitForSelector('[data-act=workspace]');
    await page.click('[data-act=workspace]');
    await page.click('[data-ws=sync]');
    await page.waitForSelector('dialog [data-choice]', { timeout: 20000 });
  };
  const n0 = await countLinks();
  await writeStale();
  await reimport();
  await page.screenshot({ path: path.join(shots, 'alerte-ecrasement.png') });
  await page.click('dialog [data-choice=keep]');
  await page.waitForTimeout(2500);
  const kept = await countLinks();
  const folderLinks = (await readFolder()).json.photos.reduce((n, e) => n + e.hotspots.length, 0);
  check(n0 > 0 && kept === n0 && folderLinks === n0, `fichier du dossier plus ancien : alerte, « Garder mon travail » → ${kept} lien(s) gardé(s), réécrits dans photosphere.json (${folderLinks})`);
  await writeStale();
  await reimport();
  await page.click('dialog [data-choice=load]');
  await page.waitForTimeout(2500);
  const loaded = await countLinks();
  // Restauration de la sauvegarde faite juste avant le chargement.
  await page.click('#btn-settings');
  await page.click('[data-backups]');
  await page.waitForSelector('[data-restore]');
  const reasons = await page.$$eval('ul.backups li', (li) => li.map((x) => x.textContent));
  const idx = reasons.findIndex((t) => t.includes('avant le chargement'));
  await page.click(`[data-restore="${idx}"]`);
  await page.waitForTimeout(2500);
  const restored = await countLinks();
  check(loaded === 0 && idx >= 0 && restored === n0, `« Charger le fichier » puis restauration de la sauvegarde automatique : ${loaded} → ${restored} lien(s)`);

  // ---------- synchronisation vers Google Drive (Drive simulé) ----------
  {
    const remote = new Map(); // id → { name, parent, size, mimeType, modifiedTime, trashed }
    const FOLDER_ID = 'dossierDriveTest1234567890';
    let n = 0, uploads = 0;
    remote.set('notes', { name: 'notes.txt', parent: FOLDER_ID, size: 5, mimeType: 'text/plain', modifiedTime: new Date().toISOString(), trashed: false });
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-upload-content-type', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, OPTIONS', 'access-control-expose-headers': 'Location' };
    const sessions = new Map();
    await page.route(/^https:\/\/(www\.googleapis\.com\/(upload\/)?drive\/v3\/files|upload\.test\/)/, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const u = new URL(req.url());
      const json = (o) => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(o) });
      if (u.host === 'upload.test') {
        const sid = u.pathname.slice(1), sess = sessions.get(sid);
        const body = req.postDataBuffer() || Buffer.alloc(0);
        const id = sess.id || 'f' + ++n;
        const prev = remote.get(id) || {};
        remote.set(id, { ...prev, ...sess.meta, name: sess.meta.name || prev.name, parent: (sess.meta.parents || [prev.parent])[0], size: body.length, mimeType: 'application/octet-stream', trashed: false });
        uploads++;
        return json({ id });
      }
      if (u.pathname.startsWith('/upload/')) {
        const m = u.pathname.match(/files\/([^/]+)$/);
        const sid = 's' + ++n;
        sessions.set(sid, { id: m && m[1], meta: JSON.parse(req.postData() || '{}') });
        return route.fulfill({ status: 200, headers: { ...cors, location: 'https://upload.test/' + sid }, body: '' });
      }
      const m = u.pathname.match(/files\/([^/]+)$/);
      if (m && req.method() === 'PATCH') {
        Object.assign(remote.get(m[1]), JSON.parse(req.postData() || '{}'));
        return json({ id: m[1] });
      }
      if (req.method() === 'POST') {
        const meta = JSON.parse(req.postData() || '{}');
        const id = 'd' + ++n;
        remote.set(id, { name: meta.name, parent: meta.parents[0], mimeType: meta.mimeType, size: 0, modifiedTime: new Date().toISOString(), trashed: false });
        return json({ id, name: meta.name });
      }
      const q = u.searchParams.get('q') || '';
      const parent = (q.match(/'([^']+)' in parents/) || [])[1];
      const files = [...remote.entries()].filter(([, f]) => f.parent === parent && !f.trashed).map(([id, f]) => ({ id, name: f.name, size: String(f.size), mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
      return json({ files });
    });
    await page.evaluate(() => {
      localStorage.setItem('ps-google-client', 'client-de-test.apps.googleusercontent.com');
      window.google = { accounts: { oauth2: { initTokenClient: (o) => ({ requestAccessToken: () => o.callback({ access_token: 'jeton-de-test', expires_in: 3600 }) }) } } };
    });
    const sync = async () => {
      await page.goto(base + '#/');
      await page.waitForSelector('[data-act=workspace]');
      await page.click('[data-act=workspace]');
      await page.fill('[name=gd-link]', `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`);
      await page.locator('[name=gd-link]').dispatchEvent('change');
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(shots, 'dossier-de-travail.png') });
      const before = uploads;
      await page.click('[data-ws=drive]');
      await page.waitForSelector('.toast:has-text("Google Drive à jour")', { timeout: 60000 });
      const msg = (await page.locator('.toast:has-text("Google Drive à jour")').last().textContent()) || '';
      await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
      return { msg, uploads: uploads - before };
    };
    const remoteNames = () => [...remote.values()].filter((f) => !f.trashed && f.mimeType !== 'application/vnd.google-apps.folder').map((f) => f.name).sort();
    await page.evaluate(() => {
      window.google = { accounts: { oauth2: { initTokenClient: (o) => ({ requestAccessToken: () => o.callback({ access_token: 'jeton-de-test', expires_in: 3600 }) }) } } };
    });
    const s1 = await sync();
    const local = (await readFolder()).names.filter((x) => x !== '_headers' && x !== 'photosphere-relief');
    const names1 = remoteNames();
    check(local.every((x) => names1.includes(x)) && names1.some((x) => /profondeur\.png$/.test(x)) && names1.includes('notes.txt'), `Google Drive : premier envoi (${s1.msg.replace(/^.*: /, '')}) → ${names1.join(', ')}`);
    const s2 = await sync();
    check(s2.uploads === 0 && /0 envoyé.*0 mis à jour.*0 à la corbeille/.test(s2.msg), `Google Drive : rien de changé → rien d’envoyé (${s2.msg.replace(/^.*: /, '')})`);
    // Modification (nom d'une photo → photosphere.json réécrit) et suppression d'une photo du dossier.
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const p = (await db.listPhotos())[0];
      await db.updatePhoto(p.id, (cur) => ({ ...cur, name: cur.name + ' bis' }));
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('photos');
      await dir.removeEntry('SAM_0002.JPG');
    });
    await page.waitForTimeout(2500);
    const s3 = await sync();
    const names3 = remoteNames();
    check(s3.uploads === 1 && /1 mis à jour/.test(s3.msg) && /1 à la corbeille/.test(s3.msg) && !names3.includes('SAM_0002.JPG') && names3.includes('notes.txt'),
      `Google Drive : seul photosphere.json renvoyé, photo supprimée mise à la corbeille, autres fichiers intacts (${s3.msg.replace(/^.*: /, '')})`);
    await page.screenshot({ path: path.join(shots, 'drive-sync.png') });
  }

  // ---------- photo renommée pendant que le dossier n'était pas relié ----------
  {
    await page.goto(base + '#/');
    await page.waitForSelector('[data-act=workspace]');
    await page.click('[data-act=workspace]');
    await page.click('[data-ws=unlink]');
    await page.waitForTimeout(500);
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const p = (await db.listPhotos()).find((x) => x.fileName === 'Salon cote jardin.JPG');
      await db.updatePhoto(p.id, (cur) => ({ ...cur, name: 'Terrasse' }));
    });
    const before = (await readFolder()).names;
    await page.reload();
    await page.waitForSelector('[data-act=workspace]');
    await page.click('[data-act=workspace]');
    await page.click('[data-ws=link]');
    const asked = await page.waitForSelector('dialog [data-choice=keep]', { timeout: 20000 }).then(() => true, () => false);
    if (asked) await page.click('dialog [data-choice=keep]');
    await page.waitForTimeout(4000);
    const f2 = await readFolder();
    const relief = await page.evaluate(async () => {
      const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('photos')).getDirectoryHandle('photosphere-relief');
      const n = [];
      for await (const e of dir.values()) n.push(e.name);
      return n;
    });
    check(before.includes('Salon cote jardin.JPG') && f2.names.includes('Terrasse.JPG') && !f2.names.includes('Salon cote jardin.JPG') && f2.json.photos.some((p) => p.file === 'Terrasse.JPG' && p.name === 'Terrasse') && relief.some((n) => n.startsWith('Terrasse.JPG.')) && !relief.some((n) => n.startsWith('Salon cote jardin.JPG.')),
      `photo renommée hors connexion, dossier relié ensuite : fichier renommé (${f2.names.join(', ')}), relief suivi (${relief.join(', ')})`);
  }

  // ---------- option « renommer aussi le fichier » non cochée : PhotoSphère propose le renommage ----------
  {
    await page.goto(base + '#/');
    await page.waitForSelector('[data-act=workspace]');
    // Option décochée dans ⚙ Réglages, puis photo renommée.
    await page.click('#btn-settings');
    await page.uncheck('dialog [name=renameFiles]');
    await page.click('dialog [data-save]');
    await page.waitForTimeout(800);
    await page.evaluate(async () => {
      const db = await import('./src/db.js');
      const p = (await db.listPhotos()).find((x) => x.fileName === 'Terrasse.JPG');
      await db.updatePhoto(p.id, (cur) => ({ ...cur, name: 'Jardin' }));
    });
    await page.waitForTimeout(2500);
    await page.click('[data-act=workspace]');
    await page.click('[data-ws=sync]');
    const keep = await page.waitForSelector('dialog [data-choice=keep]', { timeout: 15000 }).then(() => true, () => false);
    if (keep) await page.click('dialog [data-choice=keep]');
    await page.waitForSelector('dialog [data-yes]', { timeout: 15000 });
    const ask = await page.textContent('dialog h2');
    await page.screenshot({ path: path.join(shots, 'renommer-fichiers.png') });
    await page.click('dialog [data-yes]');
    await page.waitForTimeout(3000);
    const f3 = await readFolder();
    const opt = await page.evaluate(async () => (await (await import('./src/db.js')).getSetting('app')).renameFiles);
    check(/Renommer les fichiers/.test(ask) && f3.names.includes('Jardin.JPG') && !f3.names.includes('Terrasse.JPG') && opt === true, `option non cochée : PhotoSphère propose de renommer (« ${ask} »), fichier renommé (${f3.names.join(', ')}), option désormais cochée`);
  }
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
