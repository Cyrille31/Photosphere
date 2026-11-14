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
