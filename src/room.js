// Plan d'une pièce à partir d'une photo 360° et de sa carte de profondeur (IA) : on reconstitue les
// murs en ignorant meubles et personnes (dans chaque direction, le point le plus lointain dans la
// bande de hauteur où l'on voit les murs), puis on ajuste un quadrilatère (le sol). Les distances sont
// en hauteurs d'objectif (sol à y = -1 sous la caméra). Fonctions pures, testables hors navigateur.
import { mapWidth } from './depth.js';

const DEG = Math.PI / 180;
const BINS = 360;

// Points des murs, direction par direction (repère de la photo redressée : x à droite / est,
// z devant / nord, y en haut). Renvoie { walls: [{ a, r, x, z, w }], ceil } (r : distance
// horizontale ; ceil : hauteur du plafond au-dessus de l'objectif, ou null).
export function wallProfile(depth, { w = mapWidth(depth), h = w / 2, step = 2 } = {}) {
  // Plafond : hauteur des points vus nettement vers le haut (médiane).
  const ups = [];
  for (let r = 0; r < h * 0.22; r += step) {
    const lat = (0.5 - (r + 0.5) / h) * Math.PI;
    if (lat < 35 * DEG) continue;
    for (let c = 0; c < w; c += step * 2) ups.push(depth[r * w + c] * Math.sin(lat));
  }
  ups.sort((a, b) => a - b);
  const ceil = ups.length ? ups[ups.length >> 1] : null;
  // Bande des murs : au-dessus des meubles (dessus de table, dossier ~ 0,55 hauteur d'objectif au-dessus
  // du sol) et sous le plafond.
  const yLo = -0.45, yHi = ceil ? Math.min(ceil - 0.12, 0.9) : 0.9;
  const bins = Array.from({ length: BINS }, () => []);
  for (let r = 0; r < h; r += step) {
    const lat = (0.5 - (r + 0.5) / h) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let c = 0; c < w; c += step) {
      const D = depth[r * w + c];
      const y = D * sl;
      if (y < yLo || y > yHi) continue;
      const lon = ((c + 0.5) / w - 0.5) * 2 * Math.PI;
      bins[Math.min(BINS - 1, Math.floor(((lon / (2 * Math.PI)) + 0.5) * BINS))].push(D * cl);
    }
  }
  const walls = [];
  bins.forEach((b, i) => {
    if (b.length < 3) return;
    b.sort((x, y) => x - y);
    const r = b[Math.floor(b.length * 0.85)]; // le mur est derrière les meubles : quantile haut
    const a = ((i + 0.5) / BINS - 0.5) * 2 * Math.PI;
    walls.push({ a, r, x: r * Math.sin(a), z: r * Math.cos(a), w: Math.min(1, b.length / 20) });
  });
  return { walls, ceil };
}

// Orientation dominante des murs (pièces à angles droits) : angle φ dans [0, 90°) tel que les murs
// soient parallèles aux axes une fois tournés de -φ.
export function dominantOrientation(walls) {
  const hist = new Float64Array(90);
  for (let i = 0; i < walls.length; i++) {
    const p = walls[i], q = walls[(i + 3) % walls.length];
    const dx = q.x - p.x, dz = q.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05 || len > 1.5) continue; // saut (porte, angle) : ignoré
    const ang = ((Math.atan2(dz, dx) / DEG) % 90 + 90) % 90;
    hist[Math.floor(ang)] += len;
  }
  // Lissage circulaire, puis maximum.
  let best = 0, bv = -1;
  for (let k = 0; k < 90; k++) {
    let v = 0;
    for (let d = -3; d <= 3; d++) v += hist[(k + d + 90) % 90] * (4 - Math.abs(d));
    if (v > bv) (bv = v), (best = k);
  }
  return (best + 0.5) * DEG;
}

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

// Mur de normale proche de `dirA` (radians, repère x/z) : position (médiane robuste des points qui lui
// font face), puis petite rotation (±10°) si elle l'ajuste mieux (pièce en trapèze).
function fitWall(walls, dirA) {
  const sector = walls.filter((p) => Math.abs(((Math.atan2(p.z, p.x) - dirA + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < 32 * DEG);
  if (sector.length < 6) return null;
  let best = null;
  for (let dd = -10; dd <= 10; dd += 1) {
    const a = dirA + dd * DEG;
    const nx = Math.cos(a), nz = Math.sin(a);
    const d = sector.map((p) => nx * p.x + nz * p.z);
    const c = median(d);
    // Coût : écart médian au mur, plus une légère préférence pour les murs à angle droit.
    const cost = median(d.map((v) => Math.abs(v - c))) + 0.004 * Math.abs(dd);
    if (!best || cost < best.cost) best = { nx, nz, c, cost };
  }
  return best;
}

// Quadrilatère du sol : un mur par côté (secteurs autour des 4 directions dominantes), coins aux
// intersections des murs voisins. Renvoie { corners: [[x, z] ×4], phi, ceil, walls } (coins dans l'ordre,
// repère de la photo, en hauteurs d'objectif).
export function roomQuad(depth, opts = {}) {
  const { walls, ceil } = wallProfile(depth, opts);
  const phi = dominantOrientation(walls);
  const lines = [];
  for (let k = 0; k < 4; k++) lines.push(fitWall(walls, phi + (k * Math.PI) / 2));
  if (lines.some((l) => !l || l.c <= 0)) return { corners: null, phi, ceil, walls };
  const corners = [];
  for (let k = 0; k < 4; k++) {
    const a = lines[k], b = lines[(k + 1) % 4];
    const det = a.nx * b.nz - a.nz * b.nx;
    if (Math.abs(det) < 1e-6) return { corners: null, phi, ceil, walls };
    corners.push([(a.c * b.nz - a.nz * b.c) / det, (a.nx * b.c - a.c * b.nx) / det]);
  }
  return { corners, phi, ceil, walls, lines };
}

// Dimensions (longueurs des côtés) d'un quadrilatère.
export function quadSides(corners) {
  return corners.map((p, i) => Math.hypot(corners[(i + 1) % 4][0] - p[0], corners[(i + 1) % 4][1] - p[1]));
}

// ---------------------------------------------------------------------------------------------------
// Pièce rectangulaire d'après la ligne plafond / mur de l'image (le plafond est rarement encombré).
// Repère de la photo redressée : x à droite (est), z devant (nord), y en haut, caméra à l'origine.
// Unité : la distance de l'objectif au plafond (Hc = 1) ; la hauteur de plafond commune donne l'échelle.

// Carte des bords horizontaux (variation de luminosité selon la hauteur), image RGBA w × h, ligne 0 en
// haut ; réduite à `cols` colonnes. Renvoie { e: Float32Array, w, h } (valeurs normalisées).
export function edgeMap(rgba, w, h, cols = 720) {
  const sx = w / cols, rows = Math.round(h / sx);
  const lum = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0, n = 0;
      for (let yy = Math.floor(r * sx); yy < Math.floor((r + 1) * sx); yy++) {
        for (let xx = Math.floor(c * sx); xx < Math.floor((c + 1) * sx); xx++) {
          const i = (yy * w + xx) * 4;
          s += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          n++;
        }
      }
      lum[r * cols + c] = s / n;
    }
  }
  const e = new Float32Array(cols * rows);
  let sum = 0;
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const gy = lum[(r + 1) * cols + c] - lum[(r - 1) * cols + c];
      const gx = lum[r * cols + ((c + 1) % cols)] - lum[r * cols + ((c - 1 + cols) % cols)];
      const v = Math.max(0, Math.abs(gy) - 0.5 * Math.abs(gx));
      e[r * cols + c] = v;
      sum += v;
    }
  }
  const mean = sum / e.length || 1;
  for (let i = 0; i < e.length; i++) e[i] = Math.min(6, e[i] / mean);
  // Couleur du plafond : médiane de la calotte au-dessus de l'objectif (latitude > 60°), en
  // chrominance (peu sensible à l'éclairage) et luminosité.
  const col = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (Math.floor((r + 0.5) * sx) * w + Math.floor((c + 0.5) * sx)) * 4;
      const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2], L = R + G + B + 1;
      col.set([R / L, G / L, L / 3], (r * cols + c) * 3);
    }
  }
  const capRows = Math.max(2, Math.floor(rows * (30 / 180)));
  const med = (k) => {
    const v = [];
    for (let r = 0; r < capRows; r++) for (let c = 0; c < cols; c += 2) v.push(col[(r * cols + c) * 3 + k]);
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const ref = [med(0), med(1), med(2)];
  // Texture locale (tous sens) normalisée.
  const like = new Float32Array(cols * rows);
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const tex = Math.abs(lum[i + 1 - (c === cols - 1 ? cols : 0)] - lum[i]) + Math.abs(lum[i + cols] - lum[i]);
      const k = i * 3;
      const dc = Math.hypot((col[k] - ref[0]) / 0.03, (col[k + 1] - ref[1]) / 0.03);
      const dl = Math.abs(col[k + 2] - ref[2]) / 90;
      like[i] = Math.exp(-(dc * dc + dl * dl) / 2) * Math.exp(-tex / 10);
    }
  }
  // Cumul par colonne (de haut en bas) : moyenne d'une bande de lignes en temps constant.
  const cum = new Float32Array(cols * (rows + 1));
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) cum[(r + 1) * cols + c] = cum[r * cols + c] + like[r * cols + c];
  return { e, w: cols, h: rows, cum };
}

// Distance horizontale, depuis la caméra, au mur d'un rectangle (orientation phi, distances d[0..3] aux
// murs de normales phi, phi + 90°, …) dans la direction de cap `a` (radians, 0 = nord / z).
export function rectRange(a, phi, d) {
  const dx = Math.sin(a), dz = Math.cos(a);
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const t = phi + (k * Math.PI) / 2;
    const proj = dx * Math.cos(t) + dz * Math.sin(t); // composante vers la normale du mur k (repère x/z)
    if (proj > 1e-6) best = Math.min(best, d[k] / proj);
  }
  return best;
}

// Score d'une ligne prévue : somme, colonne par colonne, du bord le plus fort à ±1 ligne de la latitude
// prévue (lat(a) en radians), sur les latitudes utiles [latMin, latMax].
// ceiling : la ligne est celle du plafond ; on exige en plus le plafond au-dessus (lisse, de sa
// couleur) et le mur juste en dessous (différent).
function lineScore(em, latOf, latMin, latMax, ceiling = false) {
  let s = 0;
  const band = Math.max(3, Math.round(em.h * (10 / 180)));
  for (let c = 0; c < em.w; c++) {
    const a = ((c + 0.5) / em.w - 0.5) * 2 * Math.PI;
    const lat = latOf(a);
    if (!(lat > latMin && lat < latMax)) continue;
    const r = Math.round((0.5 - lat / Math.PI) * em.h - 0.5);
    let m = 0;
    for (let k = -1; k <= 1; k++) if (r + k > 0 && r + k < em.h - 1) m = Math.max(m, em.e[(r + k) * em.w + c]);
    if (ceiling && em.cum) {
      const r0 = Math.max(0, r - band), r1 = Math.min(em.h, r + band);
      const above = (em.cum[r * em.w + c] - em.cum[r0 * em.w + c]) / Math.max(1, r - r0);
      const below = (em.cum[r1 * em.w + c] - em.cum[(r + 1) * em.w + c]) / Math.max(1, r1 - r - 1);
      s += 0.35 * m + 3 * (above - below);
    } else s += m;
  }
  return s;
}

// Rectangle de la pièce d'après la ligne plafond / mur. Renvoie { phi, d: [4], score } (d en unités de
// distance objectif-plafond).
export function fitCeilingRect(em, { phiInit = null } = {}) {
  const grid = [];
  for (let k = 0; k < 64; k++) grid.push(0.25 * Math.pow(60, k / 63)); // 0,25 à 15 fois Hc
  const ceilLat = (phi, d) => (a) => Math.atan(1 / rectRange(a, phi, d));
  const lo = 4 * DEG, hi = 75 * DEG;
  const optimise = (phi) => {
    let d = [2, 2, 2, 2];
    let best = lineScore(em, ceilLat(phi, d), lo, hi, true);
    for (let it = 0; it < 4; it++) {
      for (let k = 0; k < 4; k++) {
        for (const v of grid) {
          const t = d.slice();
          t[k] = v;
          const s = lineScore(em, ceilLat(phi, t), lo, hi, true);
          if (s > best) (best = s), (d = t);
        }
      }
    }
    return { phi, d, score: best };
  };
  let res = null;
  const phis = [];
  if (phiInit != null) for (let k = -12; k <= 12; k += 2) phis.push(phiInit + k * DEG);
  else for (let k = 0; k < 90; k += 3) phis.push(k * DEG);
  for (const phi of phis) {
    const r = optimise(phi);
    if (!res || r.score > res.score) res = r;
  }
  // Affinage de l'orientation.
  for (let k = -2; k <= 2; k += 0.5) {
    const r = optimise(res.phi + k * DEG);
    if (r.score > res.score) res = r;
  }
  return res;
}

// Hauteur de l'objectif (en unités Hc) d'après la ligne sol / mur, pour un rectangle donné.
export function fitCameraRatio(em, rect) {
  let best = null;
  for (let rho = 0.5; rho <= 4; rho *= 1.03) {
    const s = lineScore(em, (a) => -Math.atan(rho / rectRange(a, rect.phi, rect.d)), -75 * DEG, -4 * DEG);
    if (!best || s > best.s) best = { rho, s };
  }
  return best.rho;
}
