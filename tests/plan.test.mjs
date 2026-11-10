import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearing, autoLayout, retargetAutoLinks } from '../src/plan.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('cap sur le plan : nord en haut, est à droite', () => {
  close(bearing({ x: 0, y: 0 }, { x: 0, y: -10 }), 0);
  close(bearing({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);
  close(Math.abs(bearing({ x: 0, y: 0 }, { x: 0, y: 10 })), 180);
  close(bearing({ x: 0, y: 0 }, { x: -10, y: 0 }), -90);
});

test('disposition automatique d’après la direction des liens', () => {
  const photos = [
    { id: 'a', hotspots: [{ target: 'b', yaw: 90 }] }, // b est à l'est de a
    { id: 'b', hotspots: [] },
    { id: 'c', hotspots: [] }, // isolée
  ];
  const pos = autoLayout(photos);
  const a = pos.get('a'), b = pos.get('b'), c = pos.get('c');
  close(bearing(a, b), 90, 1e-6);
  assert.ok(c.y > Math.max(a.y, b.y), 'photo isolée placée sous les autres');
});

test('déplacer une photo réoriente seulement les liens automatiques', () => {
  const photos = [
    { id: 'a', hotspots: [{ id: 'h1', target: 'b', yaw: 90, auto: false }] },
    { id: 'b', hotspots: [{ id: 'h2', target: 'a', yaw: 270, auto: true }] },
  ];
  const pos = new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: -100 }]]); // b désormais au nord de a
  const changed = retargetAutoLinks(photos, pos, 'b');
  assert.deepEqual([...changed], ['b']);
  close(Math.abs(photos[1].hotspots[0].yaw), 180); // depuis b, a est au sud
  assert.equal(photos[0].hotspots[0].yaw, 90, 'lien placé à la main inchangé');
});

import { poolLayout, contactOffset, contactFromOffset } from '../src/plan.js';

test('photos non reliées : en grille dans une zone, pas sur une seule ligne', () => {
  const ids = Array.from({ length: 12 }, (_, i) => 'p' + i);
  const { pos, zone } = poolLayout(ids, [{ x: 0, y: 0 }, { x: 300, y: 100 }], 'sphere');
  const ys = new Set([...pos.values()].map((q) => Math.round(q.y)));
  const xs = new Set([...pos.values()].map((q) => Math.round(q.x)));
  assert.ok(ys.size >= 3 && xs.size <= 5, `grille ${xs.size} colonnes × ${ys.size} lignes`);
  assert.ok(zone.y > 100, 'zone placée sous les photos reliées');
  pos.forEach((q) => assert.ok(q.x >= zone.x && q.x <= zone.x + zone.w && q.y >= zone.y && q.y <= zone.y + zone.h));
});

test('point de contact d’un lien sur la vignette : aller-retour', () => {
  for (const mode of ['sphere', 'rect']) {
    for (const [rot, yaw, pitch] of [[0, 30, -10], [45, 100, 20], [-120, -170, 0]]) {
      const o = contactOffset(mode, rot, yaw, pitch);
      if (o.hidden) continue;
      const back = contactFromOffset(mode, rot, o.x, o.y);
      assert.ok(Math.abs(((back.yaw - yaw + 540) % 360) - 180) < 0.05, `${mode} cap ${back.yaw} ≠ ${yaw}`);
      assert.ok(Math.abs(back.pitch - pitch) < 0.05);
    }
  }
  // Sur la sphère, un lien situé derrière est ramené au bord et signalé caché.
  const hidden = contactOffset('sphere', 0, 170, 0);
  assert.ok(hidden.hidden && Math.abs(hidden.x) <= 42.01);
});
