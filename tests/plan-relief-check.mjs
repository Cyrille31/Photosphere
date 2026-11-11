// Vérification dans Chromium : éditeur de plan (traits, textes, gomme, défaire, enregistrement) et
// relief pour le casque par IA (pièce synthétique connue, deux yeux différents).
// Usage : node tests/plan-relief-check.mjs [dossier-captures]
// Le relief par IA n'est testé que si PS_DEPTH_ASSETS désigne un dossier contenant
// node_modules/onnxruntime-web/dist (version 1.20.1) et model/model_quantized.onnx (Depth Anything V2
// Small) : les requêtes vers le CDN et Hugging Face y sont servies sans réseau. PS_DEPTH_PHOTO :
// photo réelle (équirectangulaire) à analyser en plus, pour une capture.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from './serve.mjs';
import { syntheticRoom } from './synthetic-room.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-plan-'));
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

// Pièce synthétique en JPEG (lignes de l'image du haut vers le bas).
async function roomJpeg(name, opt) {
  const room = syntheticRoom({ w: 2048, h: 1024, ...opt });
  const rgb = Buffer.alloc(room.w * room.h * 3);
  for (let r = 0; r < room.h; r++) {
    for (let c = 0; c < room.w; c++) {
      const s = ((room.h - 1 - r) * room.w + c) * 4, d = (r * room.w + c) * 3;
      rgb[d] = room.px[s] * 0.95;
      rgb[d + 1] = room.px[s + 1] * 0.88;
      rgb[d + 2] = room.px[s + 2] * 0.78;
    }
  }
  const b64 = await page.evaluate(
    async ({ b64, w, h }) => {
      const bin = atob(b64);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      const img = g.createImageData(w, h);
      for (let i = 0, j = 0; i < w * h; i++, j += 3) {
        img.data[i * 4] = bin.charCodeAt(j);
        img.data[i * 4 + 1] = bin.charCodeAt(j + 1);
        img.data[i * 4 + 2] = bin.charCodeAt(j + 2);
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      const u = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { b64: rgb.toString('base64'), w: room.w, h: room.h }
  );
  const file = path.join(shots, name);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return { file, room };
}

// Écart moyen entre les deux moitiés (yeux) d'une capture d'écran.
async function eyeDifference() {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + png;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const hw = Math.floor(img.width / 2);
    const a = g.getImageData(0, 150, hw, img.height - 300).data;
    const b = g.getImageData(hw, 150, hw, img.height - 300).data;
    let s = 0;
    for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]);
    return s / (a.length / 2);
  }, png);
}

try {
  await page.goto(base);
  await page.evaluate(async () => (await import('./src/db.js')).putSetting('app', { outWidth: 4096, quality: 88 }));
  await page.reload();
  const A = await roomJpeg('salon.jpg', {});
  const B = await roomJpeg('cuisine.jpg', { x0: -1.4, x1: 1.8, z0: -2.2, z1: 2.5, ceil: 0.9, rot: -30, seed: 11 });
  await page.locator('input[type=file][accept^="image"]').setInputFiles([A.file, B.file]);
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 300000 });
  const ids = await db(async (db) => {
    const ps = await db.listPhotos();
    return Object.fromEntries(ps.map((p) => [p.fileName, p.id]));
  });

  // ---------- relief par IA ----------
  const assets = process.env.PS_DEPTH_ASSETS;
  let aiTested = false;
  if (!assets) {
    console.log('  … relief IA non testé (PS_DEPTH_ASSETS non défini)');
  } else {
    const types = { mjs: 'text/javascript', js: 'text/javascript', wasm: 'application/wasm', onnx: 'application/octet-stream' };
    const serveLocal = (dir) => async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'absent' });
      await route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': types[name.split('.').pop()] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
    };
    await page.route(/cdn\.jsdelivr\.net\/npm\/onnxruntime-web/, serveLocal(path.join(assets, 'node_modules/onnxruntime-web/dist')));
    await page.route(/huggingface\.co\//, serveLocal(path.join(assets, 'model')));
    const computeIn = async (id, shot) => {
      await page.goto(base + '#/');
      await page.goto(base + '#/edit/' + id);
      await page.waitForSelector('[data-tab=relief]');
      await page.waitForTimeout(800);
      await page.click('[data-tab=relief]');
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      const t0 = Date.now();
      await page.click('[data-depth-compute]');
      await page.waitForFunction(() => !document.querySelector('[data-depth-compute]').disabled, null, { timeout: 600000 });
      const secs = (Date.now() - t0) / 1000;
      await page.waitForTimeout(500);
      const msg = (await page.locator('.toast').allTextContents()).join(' | ');
      if (shot) await page.screenshot({ path: path.join(shots, shot) });
      await page.click('[data-save]');
      await page.waitForSelector('.grid');
      return { secs, msg };
    };
    const r = await computeIn(ids['salon.jpg'], '01-editeur-relief-ia.png');
    // Distances lues dans la carte enregistrée, à l'horizon, comparées à la pièce synthétique.
    const horizon = await page.evaluate(async (id) => {
      const db = await import('./src/db.js');
      const { loadDepthImage, depthAt } = await import('./src/depth.js');
      const p = await db.getPhoto(id);
      const blob = await db.getBlob(id + ':depth');
      if (!blob) return null;
      const d = (await loadDepthImage(blob)).depth;
      const out = [];
      for (let b = 0; b < 360; b++) {
        const az = ((b + 0.5) / 360 - 0.5) * 2 * Math.PI;
        out.push(depthAt(d, [Math.sin(az), 0, Math.cos(az)]));
      }
      return { out, relief: p.relief };
    }, ids['salon.jpg']);
    check(horizon && horizon.relief && horizon.relief.kind === 'ai', `relief IA calculé en ${r.secs.toFixed(0)} s et enregistré (${r.msg.slice(0, 90)})`);
    if (horizon) {
      const err = horizon.out.map((v, b) => Math.abs(Math.log(v / A.room.walls[b]))).sort((x, y) => x - y);
      const med = err[180];
      // La pièce synthétique n'a rien d'une vraie photo : on vérifie l'ordre de grandeur des murs.
      check(med < 0.45, `relief IA : distance des murs de la pièce synthétique retrouvée à ${(med * 100).toFixed(0)} % près (médiane)`);
    }
    aiTested = true;
    if (process.env.PS_DEPTH_PHOTO) {
      await page.goto(base + '#/');
      await page.locator('input[type=file][accept^="image"]').setInputFiles(process.env.PS_DEPTH_PHOTO);
      await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 3, null, { timeout: 300000 });
      const realId = await db(async (db) => (await db.listPhotos()).find((p) => !/salon|cuisine/.test(p.fileName)).id);
      const rr = await computeIn(realId, '04-photo-reelle-relief-ia.png');
      console.log(`  (photo réelle : ${rr.secs.toFixed(0)} s — ${rr.msg.slice(0, 100)})`);
      ids.real = realId;
      // Carte et fond reconstitués, gardés avec les captures pour examen.
      const files = await page.evaluate(async (id) => {
        const db = await import('./src/db.js');
        const b64 = async (b) => {
          const u = new Uint8Array(await b.arrayBuffer());
          let s = '';
          for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
          return btoa(s);
        };
        const d = await db.getBlob(id + ':depth'), g = await db.getBlob(id + ':depthbg');
        return { d: d && (await b64(d)), g: g && (await b64(g)) };
      }, realId);
      if (files.d) fs.writeFileSync(path.join(shots, 'photo-reelle-profondeur.png'), Buffer.from(files.d, 'base64'));
      if (files.g) fs.writeFileSync(path.join(shots, 'photo-reelle-fond.jpg'), Buffer.from(files.g, 'base64'));
    }

    // ---------- relief : deux yeux différents dans le casque ----------
    const stereo = async (id, k, label) => {
      await page.evaluate((k) => localStorage.setItem('ps-headset', JSON.stringify({ relief: k })), k);
      await page.goto(base + '#/');
      await page.goto(base + '#/view/' + id);
      await page.waitForSelector('.ps-player canvas');
      await page.waitForTimeout(1200);
      await page.click('[data-mode=cardboard]');
      await page.waitForTimeout(1500);
      const toastText = await page.evaluate(() => {
        const t = document.querySelector('.ps-toast');
        const txt = t && !t.hidden ? t.textContent : '';
        document.querySelectorAll('.ps-toast').forEach((x) => (x.hidden = true));
        return txt;
      });
      if (label) await page.screenshot({ path: path.join(shots, label) });
      return { diff: await eyeDifference(), toastText };
    };
    const flat = await stereo(ids['salon.jpg'], 0);
    const deep = await stereo(ids['salon.jpg'], 1, '02-casque-relief-ia.png');
    check(deep.diff > flat.diff * 2 && deep.diff > 1, `casque : avec le relief IA, les deux yeux voient la pièce de points différents (écart ${deep.diff.toFixed(2)} contre ${flat.diff.toFixed(2)} sans relief)`);
    if (ids.real) {
      const real = await stereo(ids.real, 1, '05-casque-photo-reelle.png');
      const ds = await page.$eval('.ps-player', (el) => ({ conv: el.dataset.convergence, gap: el.dataset.eyeGap }));
      console.log(`  (photo réelle dans le casque : convergence à ${ds.conv} m, écart des yeux utilisé ${ds.gap} cm, écart moyen entre les images ${real.diff.toFixed(2)})`);
      await db(async (db, id) => db.deletePhoto(id), ids.real);
    }
    const none = await stereo(ids['cuisine.jpg'], 1);
    check(/Pas de relief/.test(none.toastText) && none.diff < 0.5, 'casque : photo sans relief calculé signalée, deux yeux identiques');
  }
  await page.evaluate(() => localStorage.removeItem('ps-headset'));

  // ---------- plan : dessin ----------
  await db(async (db, ids) => {
    const a = await db.getPhoto(ids['salon.jpg']), b = await db.getPhoto(ids['cuisine.jpg']);
    await db.putPhoto({ ...a, mapPos: { x: 0, y: 0 }, hotspots: [{ id: 'h1', target: b.id, yaw: 90, pitch: 0, label: '', auto: true }] });
    await db.putPhoto({ ...b, mapPos: { x: 170, y: 0 }, hotspots: [{ id: 'h2', target: a.id, yaw: -90, pitch: 0, label: '', auto: true }] });
  }, ids);
  await page.goto(base + '#/');
  await page.goto(base + '#/plan');
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(600);
  const bg = await page.$eval('.plan-view', (v) => getComputedStyle(v).backgroundColor);
  check(bg === 'rgb(255, 255, 255)', `plan sur fond blanc (${bg})`);
  check((await page.locator('.plan-links.over line').count()) >= 2, 'liens dessinés aussi en transparence au-dessus des images');
  const vb = await page.locator('.plan-view').boundingBox();
  const P = (x, y) => [vb.x + x, vb.y + y];
  await page.click('[data-tool=line]');
  // Rectangle (le dernier clic revient sur le point de départ, accroché) puis Échap.
  for (const [x, y] of [[120, 120], [620, 124], [622, 470], [118, 468], [121, 121]]) {
    await page.mouse.move(...P(x, y));
    await page.mouse.click(...P(x, y));
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Escape');
  // Cloison intérieure.
  await page.mouse.click(...P(370, 124));
  await page.waitForTimeout(400);
  await page.mouse.click(...P(372, 300));
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  let d = await db((db) => db.getPlanDrawing());
  const l = d.lines;
  const closed = l.length >= 4 && l[3].x2 === l[0].x1 && l[3].y2 === l[0].y1;
  const square = l.slice(0, 4).every((s) => s.x1 === s.x2 || s.y1 === s.y2);
  check(l.length === 5 && closed && square, `plan : murs tracés (${l.length} traits), accrochés à l’horizontale / verticale et refermés`);
  await page.click('[data-tool=text]');
  await page.mouse.click(...P(240, 300));
  await page.keyboard.type('Salon');
  await page.keyboard.press('Enter');
  await page.mouse.click(...P(500, 300));
  await page.keyboard.type('Cuisine');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  // Déplacer un texte.
  const before = (await db((db) => db.getPlanDrawing())).texts.find((t) => t.text === 'Cuisine');
  const tb = await page.locator('.plan-drawing text', { hasText: 'Cuisine' }).boundingBox();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2 + 20, tb.y + tb.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  d = await db((db) => db.getPlanDrawing());
  const moved = d.texts.find((t) => t.text === 'Cuisine');
  check(d.texts.length === 2 && d.texts[0].text === 'Salon' && moved && moved.y > before.y + 10 && moved.x > before.x, `plan : textes écrits et déplacés (${d.texts.map((t) => t.text).join(', ')})`);
  await page.click('[data-tool=photos]');
  await page.screenshot({ path: path.join(shots, '03-plan-dessin.png') });
  await page.click('[data-tool=erase]');
  await page.mouse.click(...P(371, 220));
  await page.waitForTimeout(300);
  d = await db((db) => db.getPlanDrawing());
  check(d.lines.length === 4, `plan : gomme, cloison effacée (${d.lines.length} traits)`);
  await page.click('[data-draw-undo]');
  await page.waitForTimeout(300);
  d = await db((db) => db.getPlanDrawing());
  check(d.lines.length === 5, 'plan : Défaire rétablit le trait effacé');
  // Outil Déplacer : un trait (la cloison), puis un angle (les deux murs qui s'y rejoignent suivent).
  await page.click('[data-tool=move]');
  const before2 = JSON.parse(JSON.stringify(d.lines));
  await page.mouse.move(...P(371, 220));
  await page.mouse.down();
  await page.mouse.move(...P(411, 230), { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  d = await db((db) => db.getPlanDrawing());
  const part = d.lines[4], part0 = before2[4];
  check(part.x1 - part0.x1 > 5 && Math.abs(part.x1 - part.x2 - (part0.x1 - part0.x2)) < 0.6 && d.lines.slice(0, 4).every((l, i) => JSON.stringify(l) === JSON.stringify(before2[i])), 'plan, Déplacer : trait déplacé d’un bloc, les autres inchangés');
  const corner = await page.locator('.plan-drawing circle.wall-end').evaluateAll((cs) => cs.map((c) => ({ end: c.dataset.end, ...c.getBoundingClientRect().toJSON() })));
  const c0 = before2[0];
  const tr = corner.find((c) => c.end === `${c0.x2},${c0.y2}`);
  await page.mouse.move(tr.x + tr.width / 2, tr.y + tr.height / 2);
  await page.mouse.down();
  await page.mouse.move(tr.x + tr.width / 2 + 60, tr.y + tr.height / 2 + 3, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  d = await db((db) => db.getPlanDrawing());
  check(d.lines[0].x2 > c0.x2 + 5 && d.lines[0].x2 === d.lines[1].x1 && d.lines[0].y2 === d.lines[1].y1 && d.lines[0].y2 === c0.y2, `plan, Déplacer : angle déplacé, les deux murs restent raccordés et le mur du haut horizontal`);
  await page.click('[data-draw-undo]');
  await page.waitForTimeout(300);
  d = await db((db) => db.getPlanDrawing());
  check(d.lines[0].x2 === c0.x2, 'plan, Déplacer : Défaire remet l’angle en place');
  await page.click('[data-tool=photos]');
  await page.reload();
  await page.waitForSelector('.plan-node');
  await page.waitForTimeout(500);
  check((await page.locator('.plan-drawing line.wall').count()) === 5 && (await page.locator('.plan-drawing text').count()) === 2, 'plan : dessin retrouvé après rechargement');
  const settings = await page.evaluate(async () => {
    const { buildSettings } = await import('./src/settings-file.js');
    const db = await import('./src/db.js');
    return buildSettings(await db.listPhotos(), await db.getPlanDrawing());
  });
  check(settings.plan && settings.plan.lines.length === 5 && (!aiTested || settings.photos.some((p) => p.relief && p.relief.kind === 'ai')), 'fichier de réglages : dessin du plan' + (aiTested ? ' et relief inclus' : ' inclus'));
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: path.join(shots, 'erreur.png') }).catch(() => {});
}
check(errors.length === 0, 'aucune erreur JavaScript' + (errors.length ? ' : ' + errors.join(' | ') : ''));
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
