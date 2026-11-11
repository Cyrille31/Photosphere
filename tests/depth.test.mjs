import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPTH_VIEWS, viewCamera, pixelDir, alignViews, composeDepth, encodeDepth, decodeDepth, DEPTH_W, DEPTH_H } from '../src/depth.js';

// Pièce rectangulaire (sol à -1, plafond à 0,8) avec un meuble (boîte) près de la caméra.
function trueDist(d) {
  let t = Infinity;
  const planes = [
    [0, -1, -1], [1, 0.8, 1], // sol, plafond
    [2, 3.2, 1], [2, -2.1, -1], [0, 2.6, 1], [0, -1.8, -1], // murs (axe, position, signe)
  ];
  const dy = d[1];
  if (dy < 0) t = Math.min(t, -1 / dy);
  if (dy > 0) t = Math.min(t, 0.8 / dy);
  for (const [ax, pos] of planes.slice(2)) {
    const c = d[ax];
    if (c !== 0 && pos / c > 0) t = Math.min(t, pos / c);
  }
  // Meuble : boîte x ∈ [0,6 ; 1,2], y ∈ [-1 ; -0,2], z ∈ [0,8 ; 1,6].
  const lo = [0.6, -1, 0.8], hi = [1.2, -0.2, 1.6];
  let tn = 0, tf = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) continue;
    const a = lo[k] / d[k], b = hi[k] / d[k];
    tn = Math.max(tn, Math.min(a, b));
    tf = Math.min(tf, Math.max(a, b));
  }
  if (tn < tf && tn > 0) t = Math.min(t, tn);
  return t;
}

let seed = 5;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test('profondeur IA : vues accordées et mises à l’échelle par le sol', () => {
  const S = 96;
  const views = DEPTH_VIEWS.map((v) => {
    const cam = viewCamera(v);
    // Le modèle donne une disparité à un facteur et un décalage près, propres à chaque vue.
    const a = 0.5 + rnd() * 3, b = (rnd() - 0.5) * 0.05;
    const disp = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) disp[y * S + x] = a * (1 / trueDist(pixelDir(cam, S, x, y))) + b + (rnd() - 0.5) * 0.004;
    return { cam, size: S, disp };
  });
  const al = alignViews(views, { samples: 3000 });
  assert.ok(al.floorOk, 'sol trouvé');
  const depth = composeDepth(views, al, { w: 256, h: 128 });
  const err = [];
  for (let r = 4; r < 124; r += 3) {
    const lat = (0.5 - (r + 0.5) / 128) * Math.PI;
    for (let c = 0; c < 256; c += 3) {
      const lon = ((c + 0.5) / 256 - 0.5) * 2 * Math.PI;
      const d = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
      err.push(Math.abs(Math.log(depth[r * 256 + c] / trueDist(d))));
    }
  }
  err.sort((x, y) => x - y);
  const med = err[err.length >> 1], p90 = err[Math.floor(err.length * 0.9)];
  console.log(`  écart médian ${(med * 100).toFixed(1)} %, 90e centile ${(p90 * 100).toFixed(1)} %`);
  assert.ok(med < 0.08, 'médiane ' + med);
  assert.ok(p90 < 0.2, '90e centile ' + p90);
});

test('profondeur IA : codage 16 bits sur PNG fidèle à 0,1 % près', () => {
  const d = new Float32Array([0.12, 0.5, 1, 2.345, 10, 59]);
  const back = decodeDepth(encodeDepth(d));
  d.forEach((v, i) => assert.ok(Math.abs(back[i] / v - 1) < 1e-3, v + ' → ' + back[i]));
  assert.equal(DEPTH_W / DEPTH_H, 2);
});

test('relief : fond reconstitué derrière un objet proche (distance et couleurs)', async () => {
  const { backgroundDepth, fillMasked } = await import('../src/depth.js');
  const w = 128, h = 64;
  const depth = new Float32Array(w * h).fill(3);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const inObj = Math.hypot(x - 64, y - 32) < 8;
      if (inObj) depth[i] = 0.5;
      rgba.set(inObj ? [250, 220, 200, 255] : [20, 60, 200, 255], i * 4);
    }
  }
  const { bg, mask } = backgroundDepth(depth, { w, h, radius: 12, minEdge: 20 });
  const c = 32 * w + 64;
  assert.equal(mask[c], 1);
  assert.ok(Math.abs(bg[c] - 3) < 1e-6, 'fond derrière l’objet : ' + bg[c]);
  assert.equal(mask[5 * w + 5], 0);
  assert.equal(bg[5 * w + 5], 3);
  fillMasked(rgba, mask, w, h);
  // L'objet (clair) est remplacé par la couleur du fond (bleue), sans liseré clair.
  assert.ok(rgba[c * 4 + 2] > 150 && rgba[c * 4] < 80, 'couleur reconstituée ' + Array.from(rgba.subarray(c * 4, c * 4 + 3)));
});

test('relief : confort, convergence sur le point regardé et écart des images plafonné', async () => {
  const { stereoComfort } = await import('../src/depth.js');
  const { cameraMatrix } = await import('../src/math.js');
  const w = 256, h = 128;
  const far = new Float32Array(w * h).fill(3);
  const cam = cameraMatrix(0, 0);
  const a = stereoComfort(far, cam, 0.02, { w, h });
  assert.ok(Math.abs(a.dg - 3) < 1e-6 && Math.abs(a.half - 0.02) < 1e-9, 'pièce lointaine : écart réel conservé');
  // Objet très proche au centre de la vue (0,2), fond à 3 : l'écart est réduit pour rester confortable.
  const near = new Float32Array(far);
  for (let y = 50; y < 78; y++) for (let x = 110; x < 146; x++) near[y * w + x] = 0.2;
  const b = stereoComfort(near, cam, 0.02, { w, h, budgetDeg: 1.2 });
  assert.ok(Math.abs(b.dg - 0.2) < 1e-6, 'convergence sur l’objet regardé');
  const disp = 2 * b.half * (1 / b.dg - 1 / 3);
  assert.ok(b.half < 0.02 && disp <= 1.2 * (Math.PI / 180) + 1e-9, `écart plafonné (${(disp * 180 / Math.PI).toFixed(2)}°)`);
});

test('relief : contours de la carte alignés sur ceux de la photo (pas de marches)', async () => {
  const { refineDepth } = await import('../src/depth.js');
  // Objet proche (0,5) devant un mur (3), séparés par une diagonale ; carte grossière (cases de 4 px).
  const W = 128, H = 64, lw = 32, lh = 16;
  const inObj = (x, y) => x + 0.6 * y < 70;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set(inObj(x, y) ? [40, 30, 30, 255] : [230, 220, 200, 255], (y * W + x) * 4);
  const lo = new Float32Array(lw * lh);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) lo[y * lw + x] = inObj(x * 4 + 2, y * 4 + 2) ? 0.5 : 3;
  const hi = refineDepth(lo, lw, lh, rgba, W, H);
  let wrong = 0, edgePx = 0;
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      if (Math.abs(x + 0.6 * y - 70) > 6) continue; // près du contour seulement
      edgePx++;
      if ((hi[y * W + x] < 1.2) !== inObj(x, y)) wrong++;
    }
  }
  assert.ok(wrong / edgePx < 0.03, `pixels du mauvais côté du contour : ${wrong} / ${edgePx}`);
});
