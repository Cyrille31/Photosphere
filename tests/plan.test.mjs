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
