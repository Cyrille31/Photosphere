import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/math.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const closeVec = (a, b, eps = 1e-6) => a.forEach((v, i) => close(v, b[i], eps));

test('levelMatrix / matToLevel aller-retour', () => {
  for (const l of [{ yaw: 10, pitch: 5, roll: -7 }, { yaw: -170, pitch: -30, roll: 20 }, { yaw: 0, pitch: 0, roll: 0 }]) {
    const r = m.matToLevel(m.levelMatrix(l.yaw, l.pitch, l.roll));
    close(r.yaw, l.yaw, 1e-9);
    close(r.pitch, l.pitch, 1e-9);
    close(r.roll, l.roll, 1e-9);
  }
});

test('lon/lat <-> direction', () => {
  closeVec(m.dirFromLonLat(0, 0), [0, 0, 1]);
  closeVec(m.dirFromLonLat(Math.PI / 2, 0), [1, 0, 0]);
  const ll = m.lonLatFromDir(m.dirFromLonLat(1.2, -0.4));
  close(ll.lon, 1.2);
  close(ll.lat, -0.4);
});

test('alignUpMatrix envoie le zénith sur u', () => {
  const u = m.vecNormalize([0.2, 0.9, -0.3]);
  closeVec(m.mat3Apply(m.alignUpMatrix(u), [0, 1, 0]), u);
});

// Simule une photo penchée : le vrai vertical, vu dans l'image, est "tilt * (0,1,0)".
function tiltedScene(level) {
  const R = m.levelMatrix(level.yaw, level.pitch, level.roll);
  // direction vue dans la sortie actuelle (identité) d'un point du monde w : R^T... ici on considère
  // que la source a été prise avec la rotation T = R^-1, et on vérifie que la correction retrouve R.
  return (w) => m.mat3Apply(m.mat3Transpose(R), w);
}

test('redressement par deux points d’horizon', () => {
  const truth = { yaw: 0, pitch: 8, roll: -5 };
  const view = tiltedScene(truth);
  const a = view(m.dirFromLonLat(0.3, 0));
  const b = view(m.dirFromLonLat(1.9, 0));
  const up = m.upFromHorizon(a, b);
  const lvl = m.applyUpCorrection({ yaw: 0, pitch: 0, roll: 0 }, up);
  // Après correction, la direction source du zénith de sortie doit être le vrai vertical vu dans l'image.
  const zen = m.mat3Apply(m.levelMatrix(lvl.yaw, lvl.pitch, lvl.roll), [0, 1, 0]);
  closeVec(zen, view([0, 1, 0]), 1e-9);
});

test('redressement par deux verticales', () => {
  const truth = { yaw: 30, pitch: -6, roll: 11 };
  const view = tiltedScene(truth);
  const line = (lon) => [view(m.dirFromLonLat(lon, 0.5)), view(m.dirFromLonLat(lon, -0.6))];
  const up = m.upFromVerticals([line(0.4), line(2.2)]);
  const lvl = m.applyUpCorrection({ yaw: 0, pitch: 0, roll: 0 }, up);
  const zen = m.mat3Apply(m.levelMatrix(lvl.yaw, lvl.pitch, lvl.roll), [0, 1, 0]);
  closeVec(zen, view([0, 1, 0]), 1e-9);
});

test('remapHotspot garde le lien sur le même point de la source', () => {
  const h = { yaw: 40, pitch: -10 };
  const a = { yaw: 0, pitch: 0, roll: 0 }, b = { yaw: 15, pitch: 7, roll: -3 };
  const h2 = m.remapHotspot(h, a, b);
  const s1 = m.mat3Apply(m.levelMatrix(0, 0, 0), m.dirFromLonLat(h.yaw * m.DEG, h.pitch * m.DEG));
  const s2 = m.mat3Apply(m.levelMatrix(b.yaw, b.pitch, b.roll), m.dirFromLonLat(h2.yaw * m.DEG, h2.pitch * m.DEG));
  closeVec(s1, s2);
});

test('orientation du téléphone : debout face au nord, regard horizontal', () => {
  const M = m.deviceOrientationMatrix(0, 90, 0, 0);
  closeVec([M[2], M[5], M[8]], [0, 0, 1]); // regard vers le nord (z)
  closeVec([M[1], M[4], M[7]], [0, 1, 0]); // haut de l'écran vers le haut
  const L = m.deviceOrientationMatrix(0, 90, 0, 90); // paysage
  closeVec([L[2], L[5], L[8]], [0, 0, 1]);
});

test('matrice caméra : lacet / tangage', () => {
  const c = m.cameraMatrix(Math.PI / 2, 0);
  closeVec([c[2], c[5], c[8]], [1, 0, 0]);
  const up = m.cameraMatrix(0, 0.5);
  close(up[5], Math.sin(0.5));
});
