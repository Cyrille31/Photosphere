// Relief pour le casque : estimation de la forme de la pièce à partir d'une seule photo 360°.
// Une photo seule ne contient pas de vraie mesure de distance ; on s'appuie sur la géométrie la plus
// courante : un sol horizontal à la hauteur de l'objectif sous la caméra, des murs verticaux et
// (souvent) un plafond horizontal. Pour chaque direction horizontale (1° par 1°), on cherche la
// distance du mur dont la jonction avec le sol (et le plafond) tombe sur un bord net de l'image,
// avec une programmation dynamique qui privilégie des murs continus. Les distances sont exprimées
// en hauteurs d'objectif (sol à 1) : la hauteur réelle (en mètres) ne fait que mettre à l'échelle.
// Fonctions pures, testables hors navigateur.

export const RELIEF_BINS = 360;
export const RELIEF_FAR = 30; // « pas de mur trouvé » : au loin (extérieur, grande salle)
const LEVELS = 48;
const R_MIN = 0.45, R_MAX = 12;
const CEIL_OPTIONS = [0];
for (let c = 0.3; c <= 1.6001; c += 0.05) CEIL_OPTIONS.push(+c.toFixed(2));

// Clé du redressement : le relief est calculé sur l'image redressée et doit être refait s'il change.
export function reliefKey(params) {
  const p = params || {};
  return [p.yaw || 0, p.pitch || 0, p.roll || 0].map((v) => (+v).toFixed(2)).join(',');
}

// pixels : RGBA d'une image équirectangulaire w × h, lignes de bas en haut (readPixels : la ligne 0
// est la latitude -90°), colonne 0 = longitude -180°. Renvoie { walls: [RELIEF_BINS], ceil, score }.
export function estimateRelief(pixels, w, h) {
  const N = w * h;
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) raw[i] = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2];
  // Flou léger (binomial 3 × 3) contre le bruit.
  const lum = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = (x - 1 + w) % w, x1 = (x + 1) % w;
      const r = (yy) => raw[yy * w + x0] + 2 * raw[yy * w + x] + raw[yy * w + x1];
      lum[y * w + x] = (r(y0) + 2 * r(y) + r(y1)) / 16;
    }
  }
  // Force des bords « horizontaux » (variation selon la hauteur) : jonctions mur / sol / plafond.
  const E = new Float32Array(N);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const gy = lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
      const gx = lum[y * w + ((x + 1) % w)] - lum[y * w + ((x - 1 + w) % w)];
      E[y * w + x] = Math.max(0, Math.abs(gy) - 0.5 * Math.abs(gx));
    }
  }
  const latRow = (lat) => Math.round(((lat / Math.PI) + 0.5) * h - 0.5);
  const bandLo = latRow(-68 * (Math.PI / 180)), bandHi = latRow(68 * (Math.PI / 180));
  // Normalisation : écart à la force moyenne des bords dans la bande utile.
  let sum = 0, sum2 = 0, cnt = 0;
  for (let y = bandLo; y <= bandHi; y++) {
    for (let x = 0; x < w; x++) {
      const v = E[y * w + x];
      sum += v;
      sum2 += v * v;
      cnt++;
    }
  }
  const mu = sum / cnt;
  const sd = Math.sqrt(Math.max(1e-6, sum2 / cnt - mu * mu));
  // Valeur d'un bord pour une tranche d'azimut et une latitude : moyenne sur la tranche du maximum
  // sur ±1 ligne, centrée et réduite, bornée.
  const B = RELIEF_BINS;
  const colsPerBin = w / B;
  const edgeAt = (bin, lat) => {
    const row = latRow(lat);
    if (row < 1 || row > h - 2) return 0;
    const c0 = Math.floor(bin * colsPerBin), c1 = Math.max(c0 + 1, Math.floor((bin + 1) * colsPerBin));
    let s = 0;
    for (let x = c0; x < c1; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) m = Math.max(m, E[(row + dy) * w + x]);
      s += m;
    }
    return Math.max(-1, Math.min(4, (s / (c1 - c0) - mu) / sd));
  };
  const levels = [];
  for (let k = 0; k < LEVELS; k++) levels.push(R_MIN * Math.pow(R_MAX / R_MIN, k / (LEVELS - 1)));
  const S = LEVELS + 1; // dernier état : pas de mur (au loin)
  const floorScore = new Float32Array(B * S);
  for (let b = 0; b < B; b++) {
    for (let k = 0; k < LEVELS; k++) floorScore[b * S + k] = edgeAt(b, -Math.atan(1 / levels[k]));
    floorScore[b * S + LEVELS] = 0.4;
  }
  // Plafond : la jonction mur / plafond pour un mur à la distance r est à la latitude atan(c / r).
  const ceilCache = new Map();
  const ceilScore = (c) => {
    if (!ceilCache.has(c)) {
      const a = new Float32Array(B * S);
      if (c > 0) {
        for (let b = 0; b < B; b++) {
          for (let k = 0; k < LEVELS; k++) {
            const lat = Math.atan(c / levels[k]);
            a[b * S + k] = lat < 68 * (Math.PI / 180) ? edgeAt(b, lat) : 0;
          }
        }
      }
      ceilCache.set(c, a);
    }
    return ceilCache.get(c);
  };
  // Programmation dynamique sur deux tours (pour raccorder le début et la fin du tour), on garde le
  // tour du milieu. Changer de distance d'un niveau ne coûte presque rien (mur vu de biais), un saut
  // (angle saillant, porte, meuble) coûte JUMP.
  const JUMP = 1.6;
  const step = (d) => (d === 0 ? 0 : d === 1 ? 0.04 : d === 2 ? 0.35 : JUMP);
  const run = (c) => {
    const cs = ceilScore(c);
    const T = 2 * B;
    let prev = new Float32Array(S);
    const back = new Uint8Array(T * S);
    for (let t = 0; t < T; t++) {
      const b = t % B;
      const cur = new Float32Array(S);
      let bestPrev = -Infinity, bestK = 0;
      for (let k = 0; k < S; k++) if (prev[k] > bestPrev) (bestPrev = prev[k]), (bestK = k);
      for (let k = 0; k < S; k++) {
        let best = bestPrev - JUMP, arg = bestK;
        const lo = k === LEVELS ? LEVELS : Math.max(0, k - 2), hi = k === LEVELS ? LEVELS : Math.min(LEVELS - 1, k + 2);
        for (let j = lo; j <= hi; j++) {
          const v = prev[j] - step(Math.abs(j - k));
          if (v > best) (best = v), (arg = j);
        }
        cur[k] = best + floorScore[b * S + k] + cs[b * S + k];
        back[t * S + k] = arg;
      }
      prev = cur;
    }
    let k = 0;
    for (let j = 1; j < S; j++) if (prev[j] > prev[k]) k = j;
    const path = new Uint8Array(T);
    for (let t = T - 1; t >= 0; t--) {
      path[t] = k;
      k = back[t * S + k];
    }
    // Score du tour du milieu (comparable d'un plafond à l'autre).
    let score = 0;
    for (let t = B / 2; t < B / 2 + B; t++) score += floorScore[(t % B) * S + path[t]] + cs[(t % B) * S + path[t]];
    return { path, score };
  };
  let best = null;
  for (const c of CEIL_OPTIONS) {
    const r = run(c);
    // Un plafond doit apporter un vrai gain pour être retenu (sinon : extérieur, ou plafond invisible).
    const s = r.score - (c > 0 ? B * 0.15 : 0);
    if (!best || s > best.s) best = { ...r, s, c };
  }
  const walls = new Array(B);
  for (let t = B / 2; t < B / 2 + B; t++) {
    const k = best.path[t];
    walls[t % B] = k === LEVELS ? RELIEF_FAR : levels[k];
  }
  // Filtre médian circulaire (5°) : supprime les accrocs isolés.
  const smooth = walls.map((_, b) => {
    const v = [];
    for (let d = -2; d <= 2; d++) v.push(walls[(b + d + B) % B]);
    return v.sort((x, y) => x - y)[2];
  });
  return { walls: smooth.map((v) => +v.toFixed(3)), ceil: best.c, score: best.s / B };
}

// Distance (en hauteurs d'objectif) du point de la pièce vu dans la direction d (unitaire, y en haut).
export function reliefDistance(d, relief) {
  const hz = Math.hypot(d[0], d[2]);
  const az = Math.atan2(d[0], d[2]);
  const u = ((az / (2 * Math.PI) + 0.5) * RELIEF_BINS - 0.5 + RELIEF_BINS) % RELIEF_BINS;
  const i0 = Math.floor(u), f = u - i0;
  const W = relief.walls[i0] * (1 - f) + relief.walls[(i0 + 1) % RELIEF_BINS] * f;
  let t = W / Math.max(hz, 1e-4);
  if (d[1] < -1e-4) t = Math.min(t, 1 / -d[1]);
  if (relief.ceil > 0 && d[1] > 1e-4) t = Math.min(t, relief.ceil / d[1]);
  return Math.min(t, 1000);
}
