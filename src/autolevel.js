// Redressement automatique par les verticales de la scène (murs, meubles, encadrements).
// Dans une vue perspective, un bord vertical réel est un segment dont le plan (passant par l'œil)
// contient la vraie verticale u : sa normale n vérifie n · u = 0. On relève les bords nets et
// presque verticaux de plusieurs vues autour de la photo, puis on cherche u qui s'accorde au mieux
// avec eux (moindres carrés pondérés et robustes). Fonctions pures, testables hors navigateur.
import { mat3Apply, vecCross, vecNormalize, vecDot, cameraMatrix, levelMatrix, applyUpCorrection, wrapDeg } from './math.js';

const DEG = Math.PI / 180;

// pixels : RGBA (lignes de bas en haut, comme readPixels), size × size ; cam : caméra → monde ;
// fovDeg : champ de la vue. maxTiltDeg : écart maximal à la verticale de l'image.
export function edgeConstraints(pixels, size, cam, fovDeg, maxTiltDeg = 25) {
  const N = size * size;
  const lum = new Float32Array(N);
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) raw[i] = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2];
  // Léger flou (noyau binomial 5 × 5) : sans lui, un bord presque vertical pixellisé forme un escalier
  // dont chaque marche paraît parfaitement verticale, ce qui sous-estime l'inclinaison.
  const k5 = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(N);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let j = -2; j <= 2; j++) s += k5[j + 2] * raw[y * size + Math.min(size - 1, Math.max(0, x + j))];
      tmp[y * size + x] = s / 16;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let j = -2; j <= 2; j++) s += k5[j + 2] * tmp[Math.min(size - 1, Math.max(0, y + j)) * size + x];
      lum[y * size + x] = s / 16;
    }
  }
  // Bords presque verticaux : sur chaque ligne de pixels, maxima du gradient horizontal localisés au
  // dixième de pixel, enchaînés de ligne en ligne en segments, puis droite ajustée sur chaque segment
  // (une pente précise, même pour une inclinaison de quelques dixièmes de degré).
  const gx = new Float32Array(N), gy = new Float32Array(N);
  let maxG = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      gx[i] = (lum[i + 1] - lum[i - 1]) / 2;
      gy[i] = (lum[i + size] - lum[i - size]) / 2;
      maxG = Math.max(maxG, Math.abs(gx[i]));
    }
  }
  const thr = Math.max(4, maxG * 0.12);
  const maxSlope = Math.tan(maxTiltDeg * DEG);
  const t = Math.tan((fovDeg / 2) * DEG);
  const open = [], done = [];
  for (let y = 3; y < size - 3; y++) {
    const pts = [];
    for (let x = 3; x < size - 3; x++) {
      const i = y * size + x;
      const g = Math.abs(gx[i]);
      if (g < thr || g < 2 * Math.abs(gy[i]) || g < Math.abs(gx[i - 1]) || g <= Math.abs(gx[i + 1])) continue;
      const a = Math.abs(gx[i - 1]), c = Math.abs(gx[i + 1]);
      const den = a - 2 * g + c;
      pts.push({ x: x + (den < 0 ? (0.5 * (a - c)) / den : 0), s: Math.sign(gx[i]), g });
    }
    for (const q of pts) {
      let best = null, bd = 1.2;
      for (const tr of open) {
        if (tr.s !== q.s || tr.lastY !== y - 1) continue;
        const pred = tr.lastX + tr.slope;
        const d = Math.abs(pred - q.x);
        if (d < bd) {
          bd = d;
          best = tr;
        }
      }
      if (best && best.lastY === y - 1) {
        best.slope = best.pts.length > 4 ? (q.x - best.pts[best.pts.length - 5].x) / 5 : q.x - best.lastX;
        best.pts.push({ x: q.x, y });
        best.lastX = q.x;
        best.lastY = y;
        best.g += q.g;
      } else open.push({ s: q.s, pts: [{ x: q.x, y }], lastX: q.x, lastY: y, slope: 0, g: q.g });
    }
    for (let k = open.length - 1; k >= 0; k--) if (open[k].lastY < y) done.push(...open.splice(k, 1));
  }
  done.push(...open);
  const out = [];
  for (const tr of done) {
    const n = tr.pts.length;
    if (n < 40) continue;
    // Droite x = a + b·y par moindres carrés.
    let sy = 0, sx = 0, syy = 0, sxy = 0;
    for (const q of tr.pts) {
      sy += q.y;
      sx += q.x;
      syy += q.y * q.y;
      sxy += q.x * q.y;
    }
    const b = (n * sxy - sx * sy) / (n * syy - sy * sy);
    const a = (sx - b * sy) / n;
    if (Math.abs(b) > maxSlope) continue;
    let rms = 0;
    for (const q of tr.pts) rms += (q.x - a - b * q.y) ** 2;
    if (Math.sqrt(rms / n) > 0.6) continue; // pas assez rectiligne
    const ends = [tr.pts[0].y, tr.pts[n - 1].y].map((y) => {
      const px = a + b * y;
      return mat3Apply(cam, [((px + 0.5) / size) * 2 * t - t, ((y + 0.5) / size) * 2 * t - t, 1]);
    });
    out.push({ n: vecNormalize(vecCross(ends[0], ends[1])), w: n, len: n });
  }
  return out;
}

// Plus petit vecteur propre d'une matrice 3 × 3 symétrique (méthode de Jacobi).
function smallestEigenvector(m) {
  const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(tt * tt + 1), sn = tt * cs;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = cs * akp - sn * akq;
          a[k][q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = cs * apk - sn * aqk;
          a[q][k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = cs * vkp - sn * vkq;
          v[k][q] = sn * vkp + cs * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let k = 1; k < 3; k++) if (a[k][k] < a[best][best]) best = k;
  return vecNormalize([v[0][best], v[1][best], v[2][best]]);
}

// Verticale u (dans le repère de l'image affichée) la mieux accordée aux bords relevés.
// Renvoie { ok, up, tiltDeg, support, reason }.
export function solveUp(constraints, { maxTiltDeg = 15, minSupport = 8 } = {}) {
  if (constraints.length < minSupport) return { ok: false, reason: 'trop peu de verticales nettes', support: constraints.length };
  let u = [0, 1, 0];
  const sigma = Math.sin(1.5 * DEG);
  for (let it = 0; it < 12; it++) {
    const m = [0, 0, 0, 0, 0, 0];
    for (const c of constraints) {
      const r = vecDot(c.n, u);
      // Pondération robuste (Cauchy) : les bords qui ne sont pas de vraies verticales pèsent peu.
      const w = it === 0 ? c.w : c.w / (1 + (r / sigma) * (r / sigma));
      const [x, y, z] = c.n;
      m[0] += w * x * x;
      m[1] += w * x * y;
      m[2] += w * x * z;
      m[3] += w * y * y;
      m[4] += w * y * z;
      m[5] += w * z * z;
    }
    const next = smallestEigenvector(m);
    u = next[1] < 0 ? next.map((x) => -x) : next;
  }
  const support = constraints.filter((c) => Math.abs(vecDot(c.n, u)) < sigma).length;
  const tiltDeg = Math.acos(Math.max(-1, Math.min(1, u[1]))) / DEG;
  if (support < minSupport) return { ok: false, reason: 'trop peu de verticales concordantes', up: u, tiltDeg, support };
  if (tiltDeg > maxTiltDeg) return { ok: false, reason: `correction trouvée trop forte (${tiltDeg.toFixed(1)}°) : verticales peu fiables`, up: u, tiltDeg, support };
  return { ok: true, up: u, tiltDeg, support };
}

// Redressement automatique d'une photo affichée par `renderer` (PanoRenderer, image chargée) avec les
// réglages `params` : 8 vues autour de l'horizon, bords verticaux, verticale estimée ; plusieurs
// passes sur l'image déjà corrigée. Refusé au-delà de 15°.
// Renvoie { ok, level: { yaw, pitch, roll }, total (degrés), support } ou { ok: false, reason }.
export async function autoLevel(renderer, params, srcType) {
  const startUp = mat3Apply(levelMatrix(params.yaw || 0, params.pitch || 0, params.roll || 0), [0, 1, 0]);
  let lvl = { yaw: params.yaw || 0, pitch: params.pitch || 0, roll: params.roll || 0 };
  let result = null, support = 0;
  try {
    for (let pass = 0; pass < 3; pass++) {
      renderer.setParams({ ...params, ...lvl }, srcType);
      const constraints = [];
      for (let k = 0; k < 8; k++) {
        const cam = cameraMatrix(k * 45 * DEG, 0);
        constraints.push(...edgeConstraints(renderer.readView(cam, 75, 512), 512, cam, 75));
        await new Promise((r) => setTimeout(r, 0));
      }
      const r = solveUp(constraints);
      if (!r.ok) {
        if (pass === 0) result = r;
        break;
      }
      support = r.support;
      const next = applyUpCorrection(lvl, r.up);
      lvl = { ...next, yaw: lvl.yaw + wrapDeg(next.yaw - lvl.yaw) };
      result = { ok: true };
      if (r.tiltDeg < 0.1) break;
    }
  } finally {
    renderer.setParams(params, srcType);
  }
  if (!result || !result.ok) return { ok: false, reason: result ? result.reason : 'aucune mesure' };
  const endUp = mat3Apply(levelMatrix(lvl.yaw, lvl.pitch, lvl.roll), [0, 1, 0]);
  const total = Math.acos(Math.max(-1, Math.min(1, vecDot(startUp, endUp)))) / DEG;
  if (total > 15) return { ok: false, reason: `correction trouvée trop forte (${total.toFixed(1)}°) : verticales peu fiables` };
  return { ok: true, level: lvl, total, support };
}
