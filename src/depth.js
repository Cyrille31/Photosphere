// Relief par intelligence artificielle : assemblage d'une carte de profondeur 360° à partir de vues
// perspective analysées une par une par un modèle d'estimation de profondeur (Depth Anything V2).
// Le modèle donne, pour chaque vue, une « disparité relative » (inverse de la distance, à un facteur
// et un décalage près, différents d'une vue à l'autre). On les accorde entre elles sur les zones
// communes, puis on fixe l'échelle avec le sol (à une hauteur d'objectif sous la caméra).
// Les distances sont exprimées en hauteurs d'objectif. Fonctions pures, testables hors navigateur.
import { cameraMatrix, mat3Apply, mat3Transpose, DEG } from './math.js';

export const DEPTH_FOV = 100; // champ de chaque vue (degrés)
// 8 vues autour de l'horizon, une vers le haut, une vers le bas.
export const DEPTH_VIEWS = [0, 45, 90, 135, 180, 225, 270, 315].map((y) => ({ yaw: y, pitch: 0 })).concat([{ yaw: 0, pitch: 89.9 }, { yaw: 0, pitch: -89.9 }]);
export const DEPTH_W = 1024, DEPTH_H = 512; // carte équirectangulaire
export const DEPTH_NEAR = 0.12, DEPTH_FAR = 60;

export function viewCamera(v) {
  return cameraMatrix(v.yaw * DEG, v.pitch * DEG);
}

// Direction (repère de la photo) du pixel (x, y) d'une vue size × size, ligne 0 en haut.
export function pixelDir(cam, size, x, y, fovDeg = DEPTH_FOV) {
  const t = Math.tan((fovDeg / 2) * DEG);
  const d = mat3Apply(cam, [(((x + 0.5) / size) * 2 - 1) * t, (1 - ((y + 0.5) / size) * 2) * t, 1]);
  const n = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / n, d[1] / n, d[2] / n];
}

// Coordonnées normalisées (-1..1, y vers le haut) d'une direction dans une vue, ou null derrière.
function project(camT, d, t) {
  const c = mat3Apply(camT, d);
  if (c[2] <= 1e-6) return null;
  return [c[0] / c[2] / t, c[1] / c[2] / t, c[2]];
}

// Valeur bilinéaire d'une carte size × size (ligne 0 en haut) aux coordonnées normalisées.
function sample(map, size, nx, ny) {
  const fx = ((nx + 1) / 2) * size - 0.5, fy = ((1 - ny) / 2) * size - 0.5;
  const x0 = Math.max(0, Math.min(size - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(size - 2, Math.floor(fy)));
  const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
  const i = y0 * size + x0;
  return (map[i] * (1 - ax) + map[i + 1] * ax) * (1 - ay) + (map[i + size] * (1 - ax) + map[i + size + 1] * ax) * ay;
}

// Directions réparties uniformément sur la sphère (spirale de Fibonacci).
function sphereSamples(n) {
  const out = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const r = Math.sqrt(1 - y * y);
    out.push([Math.cos(g * i) * r, y, Math.sin(g * i) * r]);
  }
  return out;
}

// Résolution d'un système linéaire (élimination de Gauss avec pivot partiel).
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

const median = (a) => {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1];
};

// views : [{ cam, size, disp: Float32Array (ligne 0 en haut) }]. Renvoie { coef: [{ a, b }], scale, shift,
// floorOk } : inverse de la distance (en 1 / hauteurs d'objectif) = scale · (a · disp + b) + shift.
export function alignViews(views, { fovDeg = DEPTH_FOV, samples = 5000 } = {}) {
  const V = views.length;
  const t = Math.tan((fovDeg / 2) * DEG);
  const camT = views.map((v) => mat3Transpose(v.cam));
  // Normalisation de chaque vue (le modèle a sa propre échelle) : médiane 1.
  const norm = views.map((v) => 1 / Math.max(1e-6, median(Array.from(v.disp).filter((_, i) => i % 7 === 0))));
  const dirs = sphereSamples(samples);
  const obs = dirs.map((d) => {
    const list = [];
    for (let k = 0; k < V; k++) {
      const p = project(camT[k], d, t);
      if (!p || Math.abs(p[0]) > 0.97 || Math.abs(p[1]) > 0.97) continue;
      list.push({ k, D: sample(views[k].disp, views[k].size, p[0], p[1]) * norm[k] });
    }
    return { d, list };
  });
  // Accord entre vues : a_v D_v + b_v = a_w D_w + b_w là où elles se recouvrent (moindres carrés
  // robustes), avec la moyenne des a fixée à 1 et un léger rappel des b vers 0.
  const coef = views.map(() => ({ a: 1, b: 0 }));
  const pairs = [];
  for (const o of obs) for (let i = 0; i + 1 < o.list.length; i++) for (let j = i + 1; j < o.list.length; j++) pairs.push([o.list[i], o.list[j]]);
  let scaleR = null;
  for (let it = 0; it < 8; it++) {
    const n = 2 * V;
    const A = Array.from({ length: n }, () => new Float64Array(n));
    const B = new Float64Array(n);
    const add = (idx, val, w, rhs = 0) => {
      for (let i = 0; i < idx.length; i++) {
        for (let j = 0; j < idx.length; j++) A[idx[i]][idx[j]] += w * val[i] * val[j];
        B[idx[i]] += w * val[i] * rhs;
      }
    };
    const res = [];
    for (const [p, q] of pairs) {
      const r = coef[p.k].a * p.D + coef[p.k].b - coef[q.k].a * q.D - coef[q.k].b;
      res.push(r);
      const w = scaleR ? 1 / (1 + (r / scaleR) ** 2) : 1;
      add([2 * p.k, 2 * p.k + 1, 2 * q.k, 2 * q.k + 1], [p.D, 1, -q.D, -1], w);
    }
    const big = pairs.length * 0.5 + 10;
    add(Array.from({ length: V }, (_, k) => 2 * k), new Array(V).fill(1 / V), big, 1);
    for (let k = 0; k < V; k++) add([2 * k + 1], [1], big * 0.01, 0);
    const x = solve(A.map((r) => Array.from(r)), Array.from(B));
    for (let k = 0; k < V; k++) coef[k] = { a: x[2 * k], b: x[2 * k + 1] };
    scaleR = Math.max(1e-3, 1.4826 * median(res.map(Math.abs)));
  }
  // Échelle : sur le sol, l'inverse de la distance vaut sin(-élévation) (hauteur d'objectif = 1).
  // Dans une direction plongeante, tout ce qui n'est pas le sol (bras, meuble, personne) est plus
  // proche que lui : le sol correspond donc à l'enveloppe « la plus lointaine » des observations,
  // un quantile haut du rapport sin(-élévation) / disparité.
  const ratios = [];
  for (const o of obs) {
    const el = Math.asin(o.d[1]) / DEG;
    if (el > -15 || el < -70 || !o.list.length) continue;
    const R = o.list.reduce((t2, x) => t2 + coef[x.k].a * x.D + coef[x.k].b, 0) / o.list.length;
    if (R > 1e-3) ratios.push(Math.sin(-el * DEG) / R);
  }
  let s, c = 0, floorOk = false;
  if (ratios.length > 60) {
    ratios.sort((x, y) => x - y);
    s = ratios[Math.floor(ratios.length * 0.85)];
    floorOk = s > 0 && Number.isFinite(s);
  }
  if (!floorOk) {
    // Pas de sol exploitable : distances relatives, la médiane à l'horizon placée à 2,5 hauteurs.
    const hz = obs.filter((o) => Math.abs(o.d[1]) < 0.2 && o.list.length).map((o) => o.list.reduce((t2, x) => t2 + coef[x.k].a * x.D + coef[x.k].b, 0) / o.list.length);
    s = 1 / 2.5 / Math.max(1e-3, median(hz));
  }
  return { coef: coef.map((q, k) => ({ a: q.a * norm[k], b: q.b })), scale: s, shift: c, floorOk };
}

// Carte de profondeur équirectangulaire (w × h, ligne 0 = latitude +90°), en hauteurs d'objectif.
export function composeDepth(views, align, { w = DEPTH_W, h = DEPTH_H, fovDeg = DEPTH_FOV } = {}) {
  const t = Math.tan((fovDeg / 2) * DEG);
  const camT = views.map((v) => mat3Transpose(v.cam));
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const lat = (0.5 - (r + 0.5) / h) * Math.PI;
    for (let col = 0; col < w; col++) {
      const lon = ((col + 0.5) / w - 0.5) * 2 * Math.PI;
      const d = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
      let sw = 0, sv = 0;
      for (let k = 0; k < views.length; k++) {
        const p = project(camT[k], d, t);
        if (!p) continue;
        const m = Math.max(Math.abs(p[0]), Math.abs(p[1]));
        if (m >= 1) continue;
        // Poids : fort au centre de la vue, nul au bord (raccords sans couture).
        const edge = Math.min(1, (1 - m) / 0.25);
        const wt = edge * edge * p[2] ** 4 + 1e-6;
        const { a, b } = align.coef[k];
        sv += wt * (a * sample(views[k].disp, views[k].size, p[0], p[1]) + b);
        sw += wt;
      }
      const inv = align.scale * (sw ? sv / sw : 0) + align.shift;
      out[r * w + col] = Math.min(DEPTH_FAR, Math.max(DEPTH_NEAR, 1 / Math.max(1 / DEPTH_FAR, inv)));
    }
  }
  return out;
}

// Clé du redressement : la carte est calculée sur l'image redressée et doit être refaite s'il change.
export function reliefKey(params) {
  const p = params || {};
  return [p.yaw || 0, p.pitch || 0, p.roll || 0].map((v) => (+v).toFixed(2)).join(',');
}

// Carte enregistrée en PNG (URL d'objet ou data:) → { depth, bg } (Float32Array, voir decodeDepth).
export async function loadDepthImage(src) {
  const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  if (bmp.close) bmp.close();
  c.width = c.height = 1;
  return { depth: decodeDepth(px), bg: decodeBackground(px) };
}

// Image (Blob, URL ou data:) → ImageBitmap (couleurs du fond extrapolées).
export async function loadImageBitmap(src) {
  const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
  return createImageBitmap(blob);
}

// Codage : distance sur 16 bits (logarithme) dans les canaux rouge et vert, distance du fond sur 8 bits
// (même échelle logarithmique) dans le bleu. Une carte sans fond distinct a bleu = rouge.
const LN_NEAR = Math.log(DEPTH_NEAR), LN_SPAN = Math.log(DEPTH_FAR / DEPTH_NEAR);
const q16 = (d) => Math.max(0, Math.min(65535, Math.round(((Math.log(d) - LN_NEAR) / LN_SPAN) * 65535)));
export function encodeDepth(depth, bg = null) {
  const px = new Uint8ClampedArray(depth.length * 4);
  for (let i = 0; i < depth.length; i++) {
    const v = q16(depth[i]);
    px[i * 4] = v >> 8;
    px[i * 4 + 1] = v & 255;
    // Fond : arrondi vers le loin (jamais plus proche que l'objet qu'il prolonge).
    px[i * 4 + 2] = bg ? Math.max(v >> 8, Math.min(255, Math.ceil(q16(bg[i]) / 256))) : v >> 8;
    px[i * 4 + 3] = 255;
  }
  return px;
}
export function decodeDepth(px) {
  const out = new Float32Array(px.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = Math.exp(LN_NEAR + (((px[i * 4] << 8) | px[i * 4 + 1]) / 65535) * LN_SPAN);
  return out;
}
export function decodeBackground(px) {
  const out = new Float32Array(px.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = Math.exp(LN_NEAR + ((px[i * 4 + 2] * 256 + 128) / 65535) * LN_SPAN);
  return out;
}

// Couche de fond : ce qui est caché derrière les objets proches (personnes, meubles), extrapolé à
// partir du fond qui les entoure. Dans le casque, chaque œil voit un peu derrière le bord des objets
// proches : on y montre ce fond plutôt que d'étirer l'objet.
// depth : carte (w × h, ligne 0 en haut). radius : portée en pixels de la carte (~ 7°).
// Renvoie { bg: distances du fond, mask: Uint8Array (1 = objet devant le fond) }.
export function backgroundDepth(depth, { w = DEPTH_W, h = DEPTH_H, radius = 20, jump = 1.12 } = {}) {
  const N = w * h;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = Math.log(depth[i]);
  // Maximum glissant (le plus lointain) : horizontal (le tour se referme), puis vertical.
  const tmp = new Float32Array(N), far = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = -radius; k <= radius; k++) m = Math.max(m, L[row + ((x + k + w) % w)]);
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, y - radius); k <= Math.min(h - 1, y + radius); k++) m = Math.max(m, tmp[k * w + x]);
      far[y * w + x] = m;
    }
  }
  const thr = Math.log(jump);
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = L[i] < far[i] - thr ? 1 : 0;
  const bg = new Float32Array(N);
  for (let i = 0; i < N; i++) bg[i] = mask[i] ? Math.exp(far[i]) : depth[i];
  return { bg, mask };
}

// Remplit les zones masquées d'une image RGBA (w × h) en prolongeant les couleurs voisines
// (pyramide « push-pull ») ; le masque est d'abord élargi de `grow` pixels pour ne pas reprendre
// le liseré de l'objet. Modifie et renvoie rgba.
export function fillMasked(rgba, mask, w, h, grow = 3) {
  let m = mask;
  for (let g = 0; g < grow; g++) {
    const n = new Uint8Array(m);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (m[y * w + x]) continue;
        if (m[y * w + ((x + 1) % w)] || m[y * w + ((x - 1 + w) % w)] || (y > 0 && m[(y - 1) * w + x]) || (y < h - 1 && m[(y + 1) * w + x])) n[y * w + x] = 1;
      }
    }
    m = n;
  }
  // Niveau 0 : couleurs connues (poids 1) et trous (poids 0).
  const levels = [];
  let cw = w, ch = h;
  let col = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (m[i]) continue;
    wt[i] = 1;
    col[i * 3] = rgba[i * 4];
    col[i * 3 + 1] = rgba[i * 4 + 1];
    col[i * 3 + 2] = rgba[i * 4 + 2];
  }
  levels.push({ col, wt, w: cw, h: ch });
  while (cw > 8 && ch > 4) {
    const nw = cw >> 1, nh = ch >> 1;
    const ncol = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sw = 0, r = 0, g = 0, b = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const j = (2 * y + dy) * cw + 2 * x + dx;
            const q = wt[j];
            sw += q;
            r += col[j * 3] * q;
            g += col[j * 3 + 1] * q;
            b += col[j * 3 + 2] * q;
          }
        }
        const i = y * nw + x;
        if (sw > 0) {
          ncol[i * 3] = r / sw;
          ncol[i * 3 + 1] = g / sw;
          ncol[i * 3 + 2] = b / sw;
        }
        nwt[i] = Math.min(1, sw);
      }
    }
    cw = nw;
    ch = nh;
    col = ncol;
    wt = nwt;
    levels.push({ col, wt, w: cw, h: ch });
  }
  // Remontée : chaque trou prend la couleur (bilinéaire) du niveau plus grossier.
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        if (f.wt[i] >= 1) continue;
        const fx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), fy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(c.w - 1, x0 + 1), y1 = Math.min(c.h - 1, y0 + 1);
        const ax = fx - x0, ay = fy - y0;
        for (let k = 0; k < 3; k++) {
          const v =
            (c.col[(y0 * c.w + x0) * 3 + k] * (1 - ax) + c.col[(y0 * c.w + x1) * 3 + k] * ax) * (1 - ay) +
            (c.col[(y1 * c.w + x0) * 3 + k] * (1 - ax) + c.col[(y1 * c.w + x1) * 3 + k] * ax) * ay;
          f.col[i * 3 + k] = f.wt[i] * f.col[i * 3 + k] + (1 - f.wt[i]) * v;
        }
        f.wt[i] = 1;
      }
    }
  }
  const out = levels[0];
  for (let i = 0; i < w * h; i++) {
    if (!m[i]) continue;
    rgba[i * 4] = out.col[i * 3];
    rgba[i * 4 + 1] = out.col[i * 3 + 1];
    rgba[i * 4 + 2] = out.col[i * 3 + 2];
  }
  return rgba;
}

// Confort dans le casque : distance de convergence (point regardé, sans décalage entre les deux yeux)
// et demi-écart des yeux tel que l'écart entre les deux images, sur ce qui est visible autour du
// regard, ne dépasse pas `budgetDeg`. eyeHalf : demi-écart réel des yeux (en hauteurs d'objectif).
export function stereoComfort(depth, cam, eyeHalf, { budgetDeg = 1.2, fovDeg = 70, w = DEPTH_W, h = DEPTH_H } = {}) {
  const t = Math.tan((fovDeg / 2) * DEG);
  const at = (nx, ny) => {
    const d = mat3Apply(cam, [nx * t, ny * t, 1]);
    const n = Math.hypot(d[0], d[1], d[2]);
    return depthAt(depth, [d[0] / n, d[1] / n, d[2] / n], w, h);
  };
  const center = [];
  for (const [x, y] of [[0, 0], [0.03, 0], [-0.03, 0], [0, 0.03], [0, -0.03]]) center.push(at(x, y));
  center.sort((a, b) => a - b);
  const dg = center[2];
  const inv = [];
  for (let j = -4; j <= 4; j++) for (let i = -5; i <= 5; i++) inv.push(1 / at(i / 5, j / 4));
  inv.sort((a, b) => a - b);
  const lo = inv[Math.floor(inv.length * 0.03)], hi = inv[Math.floor(inv.length * 0.97)];
  const range = Math.max(hi - 1 / dg, 1 / dg - lo, 1e-6);
  const half = Math.min(eyeHalf, (budgetDeg * DEG) / 2 / range);
  return { dg, half };
}

// Distance (en hauteurs d'objectif) lue dans la carte pour une direction d (unitaire, y en haut).
export function depthAt(depth, d, w = DEPTH_W, h = DEPTH_H) {
  const u = Math.atan2(d[0], d[2]) / (2 * Math.PI) + 0.5;
  const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, d[1]))) / Math.PI;
  const x = Math.min(w - 1, Math.max(0, Math.floor(u * w))), y = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
  return depth[y * w + x];
}
