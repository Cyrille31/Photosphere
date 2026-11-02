// Calibrage automatique d'un double fisheye : aligne les deux objectifs sur la zone de
// recouvrement (autour de 90° de l'axe optique) et calcule une correction d'exposition le long
// de la couture. Fonctions pures, utilisables hors navigateur (tests).

const DEG = Math.PI / 180;
const GAIN_BINS = 36;

// half : { data: Float32Array RGB, size } (moitié carrée de l'image)
function bilinear(half, x, y, out, o) {
  const S = half.size, d = half.data;
  x = Math.min(Math.max(x, 0), S - 1.001);
  y = Math.min(Math.max(y, 0), S - 1.001);
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i00 = (y0 * S + x0) * 3, i10 = i00 + 3, i01 = i00 + S * 3, i11 = i01 + 3;
  for (let c = 0; c < 3; c++) {
    out[o + c] = (d[i00 + c] * (1 - fx) + d[i10 + c] * fx) * (1 - fy) + (d[i01 + c] * (1 - fx) + d[i11 + c] * fx) * fy;
  }
}

// Pixel (en pixels de la moitié) vu par un objectif : k = rayon normalisé par radian.
function lensPixel(lens, k, px, py, theta, S) {
  const r = k * theta;
  const a = Math.atan2(py, px) + lens.rot;
  return [(lens.cx + r * Math.cos(a)) * S, (lens.cy - r * Math.sin(a)) * S];
}

// Directions de la couronne de recouvrement, dans le repère de l'objectif A (axe +z).
function ringDirections(thetasDeg, nAz) {
  const dirs = [];
  for (const t of thetasDeg) {
    const th = t * DEG;
    for (let i = 0; i < nAz; i++) {
      const az = -Math.PI + (i / nAz) * 2 * Math.PI;
      dirs.push([Math.sin(th) * Math.cos(az), Math.sin(th) * Math.sin(az), Math.cos(th), az]);
    }
  }
  return dirs;
}

function sampleBoth(A, B, lensA, kA, lensB, kB, dirs) {
  const n = dirs.length;
  const ca = new Float32Array(n * 3), cb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [x, y, z, , disp = 0] = dirs[i];
    const tf = Math.acos(Math.max(-1, Math.min(1, z)));
    const pa = lensPixel(lensA, kA, x, y, tf - disp / 2, A.size);
    const pb = lensPixel(lensB, kB, -x, y, Math.PI - tf - disp / 2, B.size);
    bilinear(A, pa[0], pa[1], ca, i * 3);
    bilinear(B, pb[0], pb[1], cb, i * 3);
  }
  return [ca, cb];
}

function normalizedLuma(c) {
  const n = c.length / 3;
  const l = new Float32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) m += l[i] = (c[i * 3] + c[i * 3 + 1] + c[i * 3 + 2]) / 3;
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (l[i] - m) ** 2;
  const s = Math.sqrt(v / n) + 1e-6;
  for (let i = 0; i < n; i++) l[i] = (l[i] - m) / s;
  return l;
}

// Écart photométrique robuste (on ignore les 30 % de points les plus mauvais : parallaxe, bras…).
function seamCost(A, B, lensA, kA, lensB, kB, dirs) {
  const [ca, cb] = sampleBoth(A, B, lensA, kA, lensB, kB, dirs);
  const la = normalizedLuma(ca), lb = normalizedLuma(cb);
  const e = new Float32Array(la.length);
  for (let i = 0; i < e.length; i++) e[i] = (la[i] - lb[i]) ** 2;
  e.sort();
  const keep = Math.floor(e.length * 0.7);
  let s = 0;
  for (let i = 0; i < keep; i++) s += e[i];
  return s / keep;
}

function patternSearch(f, x0, steps, maxIter) {
  let x = x0.slice(), fx = f(x);
  const st = steps.slice();
  for (let it = 0; it < maxIter; it++) {
    let improved = false;
    for (let i = 0; i < x.length; i++) {
      for (const s of [st[i], -st[i]]) {
        const y = x.slice();
        y[i] += s;
        const fy = f(y);
        if (fy < fx) {
          x = y;
          fx = fy;
          improved = true;
          break;
        }
      }
    }
    if (!improved) {
      for (let i = 0; i < st.length; i++) st[i] *= 0.5;
      if (Math.max(...st.map((s, i) => s / steps[i])) < 1e-3) break;
    }
  }
  return { x, fx };
}

// Ajuste rayon des deux objectifs, centre et rotation de l'objectif B (A sert de référence).
// Le résultat reste proche du calibrage de départ quand la scène est trop uniforme pour conclure.
export function fitLenses(A, B, start) {
  const fovHalf = (start.fov / 2) * DEG;
  const lensA = { ...start.lensA, rot: (start.lensA.rot || 0) * DEG };
  const dirs = ringDirections([86, 88, 90, 92, 94], 720).filter((d) => d[1] > -0.55);
  const q0 = [start.lensA.r / fovHalf, start.lensB.r / fovHalf, start.lensB.cx, start.lensB.cy, (start.lensB.rot || 0) * DEG];
  const scale = [0.003, 0.003, 0.01, 0.01, 1.5 * DEG];
  const lam = 0.003;
  const f = (q) => {
    let reg = 0;
    for (let i = 0; i < q.length; i++) reg += ((q[i] - q0[i]) / scale[i]) ** 2;
    return seamCost(A, B, lensA, q[0], { cx: q[2], cy: q[3], rot: q[4] }, q[1], dirs) + lam * reg;
  };
  const { x } = patternSearch(f, q0, scale, 400);
  return {
    lensA: { ...start.lensA, r: x[0] * fovHalf },
    lensB: { cx: x[2], cy: x[3], r: x[1] * fovHalf, rot: x[4] / DEG },
  };
}

// Gains de couleur (par tranche d'azimut) qui égalisent les deux objectifs sur la couture.
export function seamGains(A, B, params, disparity) {
  const fovHalf = (params.fov / 2) * DEG;
  const lensA = { ...params.lensA, rot: (params.lensA.rot || 0) * DEG };
  const lensB = { ...params.lensB, rot: (params.lensB.rot || 0) * DEG };
  const dirs = withDisparity(ringDirections([88, 90, 92], 720), disparity);
  const [ca, cb] = sampleBoth(A, B, lensA, params.lensA.r / fovHalf, lensB, params.lensB.r / fovHalf, dirs);
  const N = GAIN_BINS;
  const sa = new Float64Array(N * 3), sb = new Float64Array(N * 3);
  dirs.forEach((d, i) => {
    const bin = Math.floor(((d[3] + Math.PI) / (2 * Math.PI)) * N) % N;
    for (let c = 0; c < 3; c++) {
      sa[bin * 3 + c] += ca[i * 3 + c];
      sb[bin * 3 + c] += cb[i * 3 + c];
    }
  });
  const lr = new Float64Array(N * 3);
  for (let i = 0; i < N * 3; i++) lr[i] = Math.log(Math.min(2.5, Math.max(0.4, (sb[i] + 8) / (sa[i] + 8))));
  const a = [], b = [];
  for (let k = 0; k < N; k++) {
    const g = [];
    for (let c = 0; c < 3; c++) {
      const prev = lr[((k + N - 1) % N) * 3 + c], next = lr[((k + 1) % N) * 3 + c];
      g.push((prev + 2 * lr[k * 3 + c] + next) / 4);
    }
    a.push(g.map((v) => +Math.exp(v / 2).toFixed(4)));
    b.push(g.map((v) => +Math.exp(-v / 2).toFixed(4)));
  }
  return { a, b };
}

// Calibrage complet à partir des deux moitiés (RGB flottant).
export function autoCalibrate(A, B, start) {
  const lenses = fitLenses(A, B, start);
  const params = { ...start, ...lenses };
  const disparity = seamDisparity(A, B, params);
  const gains = seamGains(A, B, params, disparity);
  return { ...lenses, blend: 1, gains, disparity, seam: seamPath(A, B, params, gains, disparity), calibVersion: CALIB_VERSION };
}

// Résolution des tracés le long de la couture (tranches de 2°), identique dans le shader.
export const SEAM_BINS = 180;
export const CALIB_VERSION = 3;

// Couture optimale : pour chaque tranche d'azimut, on décale la couture (±5°) vers l'endroit où les
// deux objectifs concordent le mieux, avec un tracé régulier (programmation dynamique). Les objets
// proches (parallaxe) ne sont alors plus dédoublés par le fondu.
export function seamPath(A, B, params, gains, disparity) {
  const fovHalf = (params.fov / 2) * DEG;
  const lensA = { ...params.lensA, rot: (params.lensA.rot || 0) * DEG };
  const lensB = { ...params.lensB, rot: (params.lensB.rot || 0) * DEG };
  const kA = params.lensA.r / fovHalf, kB = params.lensB.r / fovHalf;
  const maxOff = Math.max(0, Math.min(5, params.fov / 2 - 90 - params.blend - 0.5));
  const offsets = [];
  for (let o = -maxOff; o <= maxOff + 1e-9; o += 0.5) offsets.push(o);
  const N = SEAM_BINS, M = offsets.length, PER = 4;
  const cost = new Float64Array(N * M);
  for (let k = 0; k < N; k++) {
    const g = Math.floor((k / N) * GAIN_BINS);
    const ga = gains ? gains.a[g] : [1, 1, 1], gb = gains ? gains.b[g] : [1, 1, 1];
    for (let m = 0; m < M; m++) {
      const dirs = [];
      for (let j = 0; j < PER; j++) {
        const az = -Math.PI + ((k + (j + 0.5) / PER) / N) * 2 * Math.PI;
        for (const dt of [-1, 0, 1]) {
          const th = (90 + offsets[m] + dt) * DEG;
          dirs.push([Math.sin(th) * Math.cos(az), Math.sin(th) * Math.sin(az), Math.cos(th), az, dispAt(disparity, az)]);
        }
      }
      const [ca, cb] = sampleBoth(A, B, lensA, kA, lensB, kB, dirs);
      let s = 0;
      for (let i = 0; i < dirs.length; i++) for (let c = 0; c < 3; c++) s += Math.abs(ca[i * 3 + c] * ga[c] - cb[i * 3 + c] * gb[c]);
      cost[k * M + m] = s / (dirs.length * 3) + 0.4 * Math.abs(offsets[m]);
    }
  }
  // Deux tours pour que le tracé se referme proprement ; on garde le second.
  const L = N * 2, lam = 3;
  const acc = new Float64Array(L * M), from = new Int32Array(L * M);
  for (let m = 0; m < M; m++) acc[m] = cost[m];
  for (let t = 1; t < L; t++) {
    const k = t % N;
    for (let m = 0; m < M; m++) {
      let best = Infinity, bi = 0;
      for (let q = Math.max(0, m - 2); q <= Math.min(M - 1, m + 2); q++) {
        const v = acc[(t - 1) * M + q] + lam * Math.abs(q - m);
        if (v < best) {
          best = v;
          bi = q;
        }
      }
      acc[t * M + m] = best + cost[k * M + m];
      from[t * M + m] = bi;
    }
  }
  let m = 0;
  for (let q = 1; q < M; q++) if (acc[(L - 1) * M + q] < acc[(L - 1) * M + m]) m = q;
  const path = new Array(N);
  for (let t = L - 1; t >= N; t--) {
    path[t % N] = offsets[m];
    m = from[t * M + m];
  }
  return path;
}


// Disparité (degrés, par tranche d'azimut) entre les deux objectifs le long de la couture, interpolée
// comme dans le shader.
function dispAt(disparity, az) {
  if (!disparity) return 0;
  const x = ((((az + Math.PI) / (2 * Math.PI)) * SEAM_BINS - 0.5) % SEAM_BINS + SEAM_BINS) % SEAM_BINS;
  const i0 = Math.floor(x), i1 = (i0 + 1) % SEAM_BINS, f = x - i0;
  return (disparity[i0] * (1 - f) + disparity[i1] * f) * DEG;
}

function withDisparity(dirs, disparity) {
  return dirs.map((d) => [d[0], d[1], d[2], d[3], dispAt(disparity, d[3])]);
}

// Parallaxe : les deux objectifs sont à quelques centimètres l'un de l'autre, un objet proche n'est
// donc pas vu sous le même angle par chacun. Pour chaque tranche d'azimut on cherche le décalage
// radial qui fait coïncider les deux images sur la couture (tracé régulier par programmation
// dynamique) ; le shader décale ensuite les deux images d'autant au voisinage de la couture.
export function seamDisparity(A, B, params) {
  const fovHalf = (params.fov / 2) * DEG;
  const lensA = { ...params.lensA, rot: (params.lensA.rot || 0) * DEG };
  const lensB = { ...params.lensB, rot: (params.lensB.rot || 0) * DEG };
  const kA = params.lensA.r / fovHalf, kB = params.lensB.r / fovHalf;
  const maxD = Math.max(0, Math.min(4, 2 * (params.fov / 2 - 95.5)));
  const cands = [];
  for (let v = -maxD; v <= maxD + 1e-9; v += 0.25) cands.push(v);
  const N = SEAM_BINS, M = cands.length, PER = 4;
  const thetas = [85, 87, 89, 91, 93, 95];
  const cost = new Float64Array(N * M);
  for (let k = 0; k < N; k++) {
    for (let m = 0; m < M; m++) {
      const dirs = [];
      for (let j = 0; j < PER; j++) {
        const az = -Math.PI + ((k + (j + 0.5) / PER) / N) * 2 * Math.PI;
        for (const t of thetas) {
          const th = t * DEG;
          dirs.push([Math.sin(th) * Math.cos(az), Math.sin(th) * Math.sin(az), Math.cos(th), az, cands[m] * DEG]);
        }
      }
      const [ca, cb] = sampleBoth(A, B, lensA, kA, lensB, kB, dirs);
      let sa = 0, sb = 0;
      for (let i = 0; i < ca.length; i++) {
        sa += ca[i];
        sb += cb[i];
      }
      const ratio = (sa + 1) / (sb + 1);
      let e = 0;
      for (let i = 0; i < ca.length; i++) e += Math.abs(ca[i] - cb[i] * ratio);
      cost[k * M + m] = e / ca.length + 0.3 * Math.abs(cands[m]);
    }
  }
  const L = N * 2, lam = 1.5;
  const acc = new Float64Array(L * M), from = new Int32Array(L * M);
  for (let m = 0; m < M; m++) acc[m] = cost[m];
  for (let t = 1; t < L; t++) {
    const k = t % N;
    for (let m = 0; m < M; m++) {
      let best = Infinity, bi = 0;
      for (let q = Math.max(0, m - 3); q <= Math.min(M - 1, m + 3); q++) {
        const v = acc[(t - 1) * M + q] + lam * Math.abs(q - m);
        if (v < best) {
          best = v;
          bi = q;
        }
      }
      acc[t * M + m] = best + cost[k * M + m];
      from[t * M + m] = bi;
    }
  }
  let m = 0;
  for (let q = 1; q < M; q++) if (acc[(L - 1) * M + q] < acc[(L - 1) * M + m]) m = q;
  const out = new Array(N);
  for (let t = L - 1; t >= N; t--) {
    out[t % N] = cands[m];
    m = from[t * M + m];
  }
  return out;
}
