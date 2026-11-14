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

// Droite (moindres carrés robustes) passant au mieux par des points : { nx, nz, c } avec nx·x + nz·z = c.
function fitLine(pts, guessN) {
  let n = guessN, c = 0, cur = pts;
  for (let it = 0; it < 4; it++) {
    if (cur.length < 3) break;
    let sw = 0, mx = 0, mz = 0;
    for (const p of cur) (sw += p.w), (mx += p.w * p.x), (mz += p.w * p.z);
    mx /= sw;
    mz /= sw;
    let sxx = 0, szz = 0, sxz = 0;
    for (const p of cur) {
      const dx = p.x - mx, dz = p.z - mz;
      sxx += p.w * dx * dx;
      szz += p.w * dz * dz;
      sxz += p.w * dx * dz;
    }
    // Normale = vecteur propre de la plus petite valeur propre.
    const t = 0.5 * Math.atan2(2 * sxz, sxx - szz); // direction de la droite
    n = [-Math.sin(t), Math.cos(t)];
    if (n[0] * guessN[0] + n[1] * guessN[1] < 0) n = [-n[0], -n[1]];
    c = n[0] * mx + n[1] * mz;
    const res = cur.map((p) => Math.abs(n[0] * p.x + n[1] * p.z - c)).sort((a, b) => a - b);
    const tol = Math.max(0.06, 2.5 * res[res.length >> 1]);
    cur = cur.filter((p) => Math.abs(n[0] * p.x + n[1] * p.z - c) < tol);
  }
  return { nx: n[0], nz: n[1], c };
}

// Quadrilatère du sol : un mur par côté (secteurs de ±40° autour des 4 directions dominantes), droite
// ajustée sur chaque mur, coins aux intersections des murs voisins. Renvoie { corners: [[x, z] ×4],
// phi, ceil, sides } (coins dans l'ordre, repère de la photo, en hauteurs d'objectif).
export function roomQuad(depth, opts = {}) {
  const { walls, ceil } = wallProfile(depth, opts);
  const phi = dominantOrientation(walls);
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const dirA = phi + (k * Math.PI) / 2; // direction (repère x/z) de la normale du mur
    const n = [Math.cos(dirA), Math.sin(dirA)];
    // Points dont la direction depuis la caméra est proche de cette normale.
    const pts = walls.filter((p) => {
      const ang = Math.atan2(p.z, p.x);
      let d = Math.abs(((ang - dirA + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      return d < 40 * DEG;
    });
    lines.push(pts.length >= 6 ? fitLine(pts, n) : null);
  }
  if (lines.some((l) => !l)) return { corners: null, phi, ceil, walls };
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
