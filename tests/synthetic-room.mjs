import { RELIEF_BINS } from '../src/relief.js';

// Pièce rectangulaire (tournée de `rot`°) autour de la caméra : murs à x = x0 / x1, z = z0 / z1 (repère
// de la pièce), sol à y = -1 (hauteur d'objectif = 1), plafond à y = ceil. Renvoie l'image et la vérité.
export function syntheticRoom({ w = 1024, h = 512, x0 = -2, x1 = 3, z0 = -1.6, z1 = 4, ceil = 0.7, rot = 20, seed = 3 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const noise = new Float32Array(4096).map(() => rnd());
  const n2 = (a, b) => noise[(((Math.floor(a) * 73856093) ^ (Math.floor(b) * 19349663)) >>> 0) % 4096];
  const cr = Math.cos((rot * Math.PI) / 180), sr = Math.sin((rot * Math.PI) / 180);
  const px = new Uint8Array(w * h * 4);
  const hit = (d) => {
    // Direction dans le repère de la pièce.
    const x = d[0] * cr - d[2] * sr, z = d[0] * sr + d[2] * cr, y = d[1];
    let t = Infinity, kind = '';
    const tx = x > 0 ? x1 / x : x0 / x, tz = z > 0 ? z1 / z : z0 / z;
    if (tx < t) (t = tx), (kind = 'wx');
    if (tz < t) (t = tz), (kind = 'wz');
    if (y < 0 && -1 / y < t) (t = -1 / y), (kind = 'floor');
    if (y > 0 && ceil / y < t) (t = ceil / y), (kind = 'ceil');
    return { t, kind, p: [x * t, y * t, z * t] };
  };
  for (let r = 0; r < h; r++) {
    const lat = ((r + 0.5) / h - 0.5) * Math.PI;
    for (let c = 0; c < w; c++) {
      const lon = ((c + 0.5) / w - 0.5) * 2 * Math.PI;
      const d = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
      const { kind, p } = hit(d);
      let v;
      if (kind === 'floor') v = 95 + 40 * n2(p[0] * 8, p[2] * 8);
      else if (kind === 'ceil') v = 225 + 10 * n2(p[0] * 5, p[2] * 5);
      else {
        const along = kind === 'wx' ? p[2] : p[0];
        v = (p[1] < -0.95 ? 150 : 185) + 25 * n2(along * 6, p[1] * 6) + (Math.floor(along * 1.3) % 3 === 0 ? 15 : 0);
      }
      const i = (r * w + c) * 4;
      px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, v));
      px[i + 3] = 255;
    }
  }
  const walls = [];
  for (let b = 0; b < RELIEF_BINS; b++) {
    const az = ((b + 0.5) / RELIEF_BINS - 0.5) * 2 * Math.PI;
    const d = [Math.sin(az), 0, Math.cos(az)];
    walls.push(hit(d).t);
  }
  return { px, w, h, walls, ceil };
}

