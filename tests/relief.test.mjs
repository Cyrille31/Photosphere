import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRelief, reliefDistance, RELIEF_BINS } from '../src/relief.js';

import { syntheticRoom } from './synthetic-room.mjs';

test('relief : forme d’une pièce retrouvée (murs à ±15 %, plafond)', () => {
  const room = syntheticRoom();
  const t0 = Date.now();
  const r = estimateRelief(room.px, room.w, room.h);
  const ms = Date.now() - t0;
  const err = r.walls.map((v, b) => Math.abs(Math.log(v / room.walls[b]))).sort((a, b) => a - b);
  const med = err[Math.floor(err.length / 2)], p90 = err[Math.floor(err.length * 0.9)];
  console.log(`  médiane ${(med * 100).toFixed(1)} %, 90e centile ${(p90 * 100).toFixed(1)} %, plafond ${r.ceil} (vrai ${room.ceil}), ${ms} ms`);
  assert.ok(med < 0.08, 'médiane ' + med);
  assert.ok(p90 < 0.15, '90e centile ' + p90);
  assert.ok(Math.abs(r.ceil - room.ceil) <= 0.1, 'plafond ' + r.ceil);
});

test('relief : distance d’un point du sol et d’un mur', () => {
  const relief = { walls: new Array(RELIEF_BINS).fill(2), ceil: 0.8 };
  // Vers le bas à 45° : sol à 1/sin(45°).
  assert.ok(Math.abs(reliefDistance([0, -Math.SQRT1_2, Math.SQRT1_2], relief) - Math.SQRT2) < 1e-6);
  // À l'horizontale : mur à 2.
  assert.ok(Math.abs(reliefDistance([1, 0, 0], relief) - 2) < 1e-6);
  // Vers le haut, au-dessus du mur : plafond.
  assert.ok(Math.abs(reliefDistance([0, 0.8, 0.6], relief) - 1) < 1e-6);
});
