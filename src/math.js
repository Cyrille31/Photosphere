// Mathématiques 3D partagées (matrices 3x3 en ligne, vecteurs [x, y, z]).
// Repère : x à droite, y en haut, z devant. Longitude 0 = centre de l'image équirectangulaire.

export const DEG = Math.PI / 180;

export function mat3Identity() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function mat3Mul(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

export function mat3Transpose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mat3Apply(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export function rotZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function vecCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function vecDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vecNormalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// Rotation de redressement (degrés) : direction source = R * direction de sortie.
export function levelMatrix(yaw, pitch, roll) {
  return mat3Mul(rotY(yaw * DEG), mat3Mul(rotX(pitch * DEG), rotZ(roll * DEG)));
}

// Inverse de levelMatrix : retrouve { yaw, pitch, roll } en degrés.
export function matToLevel(m) {
  const sp = Math.max(-1, Math.min(1, -m[5]));
  const pitch = Math.asin(sp);
  let yaw, roll;
  if (Math.abs(sp) < 0.99999) {
    yaw = Math.atan2(m[2], m[8]);
    roll = Math.atan2(m[3], m[4]);
  } else {
    yaw = Math.atan2(-m[6], m[0]);
    roll = 0;
  }
  return { yaw: yaw / DEG, pitch: pitch / DEG, roll: roll / DEG };
}

export function dirFromLonLat(lon, lat) {
  const c = Math.cos(lat);
  return [c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon)];
}

export function lonLatFromDir(d) {
  const v = vecNormalize(d);
  return { lon: Math.atan2(v[0], v[2]), lat: Math.asin(Math.max(-1, Math.min(1, v[1]))) };
}

// Rotation minimale A telle que A * (0,1,0) = u.
export function alignUpMatrix(u) {
  const n = vecNormalize(u);
  const axis = [n[2], 0, -n[0]];
  const s = Math.hypot(axis[0], axis[2]);
  const c = n[1];
  if (s < 1e-9) return c > 0 ? mat3Identity() : rotZ(Math.PI);
  const k = [axis[0] / s, 0, axis[2] / s];
  const t = 1 - c;
  return [
    t * k[0] * k[0] + c, t * k[0] * k[1] - s * k[2], t * k[0] * k[2] + s * k[1],
    t * k[0] * k[1] + s * k[2], t * k[1] * k[1] + c, t * k[1] * k[2] - s * k[0],
    t * k[0] * k[2] - s * k[1], t * k[1] * k[2] + s * k[0], t * k[2] * k[2] + c,
  ];
}

// Vertical estimé à partir de deux points de l'horizon.
export function upFromHorizon(a, b) {
  let n = vecNormalize(vecCross(a, b));
  if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
  return n;
}

// Vertical estimé à partir d'une ou deux lignes verticales (chaque ligne = 2 directions).
export function upFromVerticals(lines) {
  const normals = lines.map(([p, q]) => vecNormalize(vecCross(p, q)));
  let up;
  if (normals.length >= 2) {
    up = vecNormalize(vecCross(normals[0], normals[1]));
  } else {
    // Une seule ligne : on projette le vertical actuel sur le plan de la ligne.
    const m = normals[0];
    const d = m[1];
    up = vecNormalize([-d * m[0], 1 - d * m[1], -d * m[2]]);
  }
  if (up[1] < 0) up = [-up[0], -up[1], -up[2]];
  return up;
}

// Nouveau réglage de redressement après avoir désigné le "haut" dans la vue courante.
export function applyUpCorrection(level, up) {
  const r = mat3Mul(levelMatrix(level.yaw, level.pitch, level.roll), alignUpMatrix(up));
  return matToLevel(r);
}

// Conserve la position réelle des liens quand le redressement change.
export function remapHotspot(h, oldLevel, newLevel) {
  const src = mat3Apply(levelMatrix(oldLevel.yaw, oldLevel.pitch, oldLevel.roll), dirFromLonLat(h.yaw * DEG, h.pitch * DEG));
  const out = mat3Apply(mat3Transpose(levelMatrix(newLevel.yaw, newLevel.pitch, newLevel.roll)), src);
  const ll = lonLatFromDir(out);
  return { ...h, yaw: ll.lon / DEG, pitch: ll.lat / DEG };
}

// Matrice caméra (caméra -> monde) pour une vue définie par lacet / tangage en radians.
export function cameraMatrix(yaw, pitch) {
  return mat3Mul(rotY(yaw), rotX(-pitch));
}

// Orientation du téléphone (DeviceOrientationEvent, degrés) -> matrice caméra -> monde.
// Le monde W3C (X est, Y nord, Z haut) est ramené au repère interne (x est, y haut, z nord).
export function deviceOrientationMatrix(alpha, beta, gamma, screenAngle) {
  const r = mat3Mul(rotZ(alpha * DEG), mat3Mul(rotX(beta * DEG), rotY(gamma * DEG)));
  const rs = mat3Mul(r, rotZ(-screenAngle * DEG));
  const toWorld = (v) => [v[0], v[2], v[1]];
  const right = toWorld(mat3Apply(rs, [1, 0, 0]));
  const up = toWorld(mat3Apply(rs, [0, 1, 0]));
  const fwd = toWorld(mat3Apply(r, [0, 0, -1]));
  return [right[0], up[0], fwd[0], right[1], up[1], fwd[1], right[2], up[2], fwd[2]];
}

export function headingOf(m) {
  return Math.atan2(m[2], m[8]);
}

export function wrapDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}
