import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveUp } from '../src/autolevel.js';
import { vecCross, vecNormalize, vecDot, levelMatrix, mat3Apply } from '../src/math.js';

// Générateur pseudo-aléatoire reproductible.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function constraintsFor(up, n = 600, outliers = 0.25) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (rnd() < outliers) {
      out.push({ n: vecNormalize([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), w: 1 });
      continue;
    }
    // Un bord vertical : plan contenant la verticale et une direction horizontale quelconque.
    const a = rnd() * 2 * Math.PI;
    const h = [Math.sin(a), 0, Math.cos(a)];
    const nn = vecNormalize(vecCross(up, h));
    out.push({ n: vecNormalize(nn.map((x) => x + (rnd() - 0.5) * 0.004)), w: 1 });
  }
  return out;
}

test('redressement automatique : retrouve la verticale malgré 25 % de bords parasites', () => {
  const up = mat3Apply(levelMatrix(30, 6, -4), [0, 1, 0]);
  const r = solveUp(constraintsFor(up));
  assert.ok(r.ok, r.reason);
  const err = Math.acos(Math.min(1, vecDot(r.up, up))) / (Math.PI / 180);
  assert.ok(err < 0.3, `écart ${err.toFixed(3)}°`);
  assert.ok(Math.abs(r.tiltDeg - 7.2) < 0.5, `inclinaison ${r.tiltDeg}`);
});

test('redressement automatique : refuse une correction de plus de 15°', () => {
  const up = mat3Apply(levelMatrix(0, 25, 0), [0, 1, 0]);
  const r = solveUp(constraintsFor(up));
  assert.equal(r.ok, false);
  assert.match(r.reason, /trop forte/);
});

test('redressement automatique : refuse s’il y a trop peu de verticales', () => {
  const r = solveUp(constraintsFor([0, 1, 0], 5));
  assert.equal(r.ok, false);
});
