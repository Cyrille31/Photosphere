// Vérification dans Chromium du redressement automatique par les verticales : une « pièce »
// synthétique (murs à arêtes verticales, plinthes horizontales, texture) photographiée penchée.
// Usage : node tests/autolevel-check.mjs [dossier-captures]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from './serve.mjs';
import { levelMatrix, mat3Apply, mat3Transpose, vecDot } from '../src/math.js';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-auto-'));
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

// Image équirectangulaire d'une pièce vue par une caméra penchée : direction monde w = Rt · s.
async function makeRoom(name, tilt) {
  const Rt = levelMatrix(tilt.yaw, tilt.pitch, tilt.roll);
  const b64 = await page.evaluate(
    async ({ Rt }) => {
      const W = 2048, H = 1024;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      const img = g.createImageData(W, H);
      let seed = 3;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const noise = new Float32Array(W * H).map(() => rnd() * 18);
      for (let y = 0; y < H; y++) {
        const lat = (0.5 - (y + 0.5) / H) * Math.PI;
        for (let x = 0; x < W; x++) {
          const lon = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
          const s = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
          const w = [Rt[0] * s[0] + Rt[1] * s[1] + Rt[2] * s[2], Rt[3] * s[0] + Rt[4] * s[1] + Rt[5] * s[2], Rt[6] * s[0] + Rt[7] * s[1] + Rt[8] * s[2]];
          const az = Math.atan2(w[0], w[2]) / Math.PI * 180 + 180;
          const el = Math.asin(Math.max(-1, Math.min(1, w[1]))) / Math.PI * 180;
          // Murs et meubles : bandes verticales de largeurs variées ; plinthe et plafond horizontaux.
          const band = Math.floor(az / 11) % 4;
          let v = [210, 120, 170, 90][band];
          if (el < -25) v = 70;
          if (el > 35) v = 235;
          const i = (y * W + x) * 4;
          const n = noise[y * W + x];
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
    },
    { Rt }
  );
  const file = path.join(shots, name);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  // Verticale vraie, exprimée dans la photo d'origine.
  return { file, up: mat3Apply(mat3Transpose(Rt), [0, 1, 0]) };
}

try {
  await page.goto(base);
  await page.evaluate(async () => (await import('./src/db.js')).putSetting('app', { outWidth: 4096, quality: 85 }));
  await page.reload();
  const cases = [
    { name: 'piece_penchee.jpg', tilt: { yaw: 20, pitch: 6, roll: -5 }, expectOk: true },
    { name: 'piece_tres_penchee.jpg', tilt: { yaw: 0, pitch: 22, roll: 12 }, expectOk: false },
  ];
  for (const c of cases) {
    const room = await makeRoom(c.name, c.tilt);
    c.up = room.up;
    await page.locator('input[type=file][accept^="image"]').setInputFiles(room.file);
  }
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 2, null, { timeout: 300000 });
  for (const c of cases) {
    const id = await page.evaluate(async (n) => (await (await import('./src/db.js')).listPhotos()).find((p) => p.fileName === n).id, c.name);
    await page.goto(base + '#/edit/' + id);
    await page.waitForFunction(() => document.querySelector('.ed-hint') && document.querySelector('.ed-hint').hidden, null, { timeout: 60000 });
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    const t0 = Date.now();
    await page.click('[data-autolevel]');
    await page.waitForFunction(() => !document.querySelector('[data-autolevel]').disabled, null, { timeout: 60000 });
    const ms = Date.now() - t0;
    const msg = (await page.locator('.toast').allTextContents()).join(' | ');
    if (c.expectOk) {
      await page.click('[data-save]');
      await page.waitForSelector('.grid');
      const params = await page.evaluate(async (id) => (await (await import('./src/db.js')).getPhoto(id)).params, id);
      const got = mat3Apply(levelMatrix(params.yaw, params.pitch, params.roll), [0, 1, 0]);
      const err = Math.acos(Math.min(1, vecDot(got, c.up))) * 180 / Math.PI;
      check(err < 0.6, `auto : pièce penchée de ~7,8° redressée à ${err.toFixed(2)}° près en ${(ms / 1000).toFixed(1)} s (${msg.slice(0, 80)}…)`);
    } else {
      check(/impossible/.test(msg) && /trop forte|concordantes|trop peu/.test(msg), `auto : inclinaison de ~25° refusée (« ${msg.slice(0, 110)}… »)`);
      await page.click('[data-cancel]');
      await page.waitForSelector('.grid');
    }
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
