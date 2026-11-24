// Vérification dans Chromium : vidéos 360 (import, réglages de l'onglet Vidéo, lecture dans la
// visionneuse par le bouton « ▶ Vidéo » ou dès l'arrivée, en boucle ou non).
// Vidéo de test : mire de synthèse en VP9 (le Chromium de test ne lit pas le HEVC de la Gear 360).
// Usage : node tests/video-check.mjs [dossier-captures]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require('playwright'));
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'photosphere-video-'));
fs.mkdirSync(shots, { recursive: true });
const server = await serve(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) failures++;
};
const db = (fn, arg) => page.evaluate(async ({ fn, arg }) => new Function('db', 'arg', `return (${fn})(db, arg)`)(await import('./src/db.js'), arg), { fn: fn.toString(), arg });

try {
  await page.goto(base);
  await page.evaluate(async () => (await import('./src/db.js')).putSetting('app', { outWidth: 2048, quality: 85 }));
  await page.reload();
  const file = path.join(shots, '360_1044.MP4');
  fs.copyFileSync(process.env.PS_VIDEO_FILE || path.join(here, 'fixtures', 'video-360.mp4'), file);
  await page.locator('input[type=file][accept^="image"]').setInputFiles([file]);
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 1, null, { timeout: 120000 });
  const v = await db(async (db) => {
    const p = (await db.listPhotos())[0];
    return { kind: p.kind, video: p.video, hasVideo: !!(await db.getBlob(p.id + ':video')), hasPoster: !!(await db.getBlob(p.id + ':orig')), id: p.id };
  });
  const badge = await page.locator('.card .badge:has-text("Vidéo")').count();
  check(v.kind === 'video' && v.hasVideo && v.hasPoster && v.video.duration > 2.5 && badge === 1, `import d’une vidéo : affiche tirée de la vidéo, vidéo gardée, badge « 🎬 Vidéo » (durée ${v.video.duration.toFixed(1)} s)`);

  // ---------- éditeur, onglet Vidéo ----------
  await page.goto(base + '#/edit/' + v.id);
  await page.waitForSelector('[data-tab=video]');
  await page.waitForTimeout(800);
  await page.click('[data-tab=video]');
  await page.check('[name=videoLoop]');
  await page.$eval('[name=videoPoster]', (i) => {
    i.value = 1.5;
    i.dispatchEvent(new Event('input'));
    i.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(2500);
  const cueShown = await page.locator('.ed-video-cue').count();
  await page.screenshot({ path: path.join(shots, '01-editeur-video.png') });
  await page.click('[data-save]');
  await page.waitForSelector('.grid');
  const saved = await db(async (db, id) => (await db.getPhoto(id)).video, v.id);
  check(saved.loop === true && saved.autoplay === false && Math.abs(saved.posterTime - 1.5) < 0.2 && cueShown === 1, `éditeur : boucle cochée, image d’affiche à ${saved.posterTime} s, bouton « ▶ Vidéo » montré sur l’image`);
  await page.waitForFunction(() => document.querySelectorAll('.badge.ok').length === 1, null, { timeout: 120000 });

  // ---------- visionneuse : lancement par le bouton « ▶ Vidéo » ----------
  await page.goto(base + '#/view/' + v.id);
  await page.waitForSelector('.ps-player canvas');
  await page.waitForTimeout(1200);
  const labels = await page.$$eval('.ps-labels > *', (l) => l.map((x) => x.textContent));
  await page.evaluate(() => [...document.querySelectorAll('.ps-label')].find((b) => /Vidéo/.test(b.textContent)).click());
  await page.waitForFunction(() => document.querySelector('.ps-player').dataset.video === 'playing', null, { timeout: 15000 });
  const t1 = await page.textContent('.ps-video-time');
  await page.waitForTimeout(1500);
  const t2 = await page.textContent('.ps-video-time');
  const labelsPlaying = await page.$$eval('.ps-labels > *', (l) => l.map((x) => x.textContent));
  await page.screenshot({ path: path.join(shots, '02-video-en-lecture.png') });
  check(labels.includes('▶ Vidéo') && t1 !== t2 && !labelsPlaying.includes('▶ Vidéo'), `visionneuse : « ▶ Vidéo » lance la lecture (${t1} → ${t2}), le bouton disparaît pendant la lecture`);
  // Boucle : toujours en lecture après la fin (3 s).
  await page.waitForTimeout(3000);
  const looping = await page.evaluate(() => document.querySelector('.ps-player').dataset.video === 'playing');
  await page.click('.ps-video-stop');
  await page.waitForTimeout(500);
  const back = await page.$$eval('.ps-labels > *', (l) => l.map((x) => x.textContent));
  check(looping && back.includes('▶ Vidéo'), 'visionneuse : lecture en boucle ; ⏹ revient à l’image, avec le bouton « ▶ Vidéo »');

  // ---------- lancement dès l'arrivée, sans boucle ----------
  await db(async (db, id) => db.updatePhoto(id, (cur) => ({ ...cur, video: { ...cur.video, autoplay: true, loop: false } })), v.id);
  await page.goto(base + '#/');
  await page.goto(base + '#/view/' + v.id);
  await page.waitForSelector('.ps-player canvas');
  const auto = await page.waitForFunction(() => document.querySelector('.ps-player').dataset.video === 'playing', null, { timeout: 15000 }).then(() => true, () => false);
  // Sans boucle : à la fin, retour à l'image.
  const ended = await page.waitForFunction(() => !document.querySelector('.ps-player').dataset.video, null, { timeout: 15000 }).then(() => true, () => false);
  check(auto && ended, `lancement dès l’arrivée (${auto}), retour à l’image à la fin de la vidéo sans boucle (${ended})`);
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
