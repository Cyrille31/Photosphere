import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCalibrate, VIGNETTE_P, VIGNETTE_Q } from '../src/calibrate.js';
import { DEFAULT_LENS_PARAMS } from '../src/gl-source.js';

const DEG = Math.PI / 180;

// Scène texturée (fonction de la direction) vue par un double fisheye équidistant.
function scene(d) {
  const [x, y, z] = d;
  return [
    128 + 60 * Math.sin(13 * x + 7 * y) + 40 * Math.sin(17 * y - 11 * z),
    128 + 50 * Math.sin(19 * z + 5 * x) + 40 * Math.sin(9 * x - 15 * y),
    128 + 55 * Math.sin(11 * y + 21 * z) + 35 * Math.sin(23 * x),
  ];
}

function renderHalf(S, lens, fov, back, gain) {
  const data = new Float32Array(S * S * 3);
  const fovHalf = (fov / 2) * DEG;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const dx = (px + 0.5) / S - lens.cx, dy = (py + 0.5) / S - lens.cy;
      const r = Math.hypot(dx, dy);
      if (r > lens.r * 1.02) continue;
      const th = (r / lens.r) * fovHalf;
      const a = Math.atan2(-dy, dx) - lens.rot * DEG;
      const st = Math.sin(th);
      const d = back ? [-st * Math.cos(a), st * Math.sin(a), -Math.cos(th)] : [st * Math.cos(a), st * Math.sin(a), Math.cos(th)];
      // Vignettage de la caméra (inverse de la correction : x = 1 - (1 - y)^(1/g)).
      const t2 = (th / (Math.PI / 2)) ** 2;
      const g = Math.exp((VIGNETTE_P * t2 + VIGNETTE_Q * t2 ** 4) / 2.2);
      data.set(scene(d).map((v) => 255 * (1 - (1 - Math.min(255, v * gain) / 255) ** (1 / g))), (py * S + px) * 3);
    }
  }
  return { size: S, data };
}

test('le calibrage automatique retrouve le décalage des objectifs et l’écart d’exposition', () => {
  const truthA = { cx: 0.5, cy: 0.5, r: 0.503, rot: 0 };
  const truthB = { cx: 0.497, cy: 0.503, r: 0.495, rot: 0.6 };
  const A = renderHalf(500, truthA, 195, false, 1);
  const B = renderHalf(500, truthB, 195, true, 1.25);
  const start = { ...DEFAULT_LENS_PARAMS, lensA: { ...DEFAULT_LENS_PARAMS.lensA, cx: 0.5, cy: 0.5 } };
  const r = autoCalibrate(A, B, start);
  assert.ok(Math.abs(r.lensA.r - truthA.r) < 0.002, 'rayon A ' + r.lensA.r);
  assert.ok(Math.abs(r.lensB.r - truthB.r) < 0.002, 'rayon B ' + r.lensB.r);
  assert.ok(Math.abs(r.lensB.cx - truthB.cx) < 0.002, 'cx B ' + r.lensB.cx);
  assert.ok(Math.abs(r.lensB.cy - truthB.cy) < 0.002, 'cy B ' + r.lensB.cy);
  assert.ok(Math.abs(r.lensB.rot - truthB.rot) < 0.3, 'rotation B ' + r.lensB.rot);
  // B est 25 % plus lumineux : gains ≈ √1,25 pour A et 1/√1,25 pour B.
  const ga = r.gains.a.flat().reduce((s, v) => s + v, 0) / 108;
  const gb = r.gains.b.flat().reduce((s, v) => s + v, 0) / 108;
  assert.ok(Math.abs(ga - Math.sqrt(1.25)) < 0.03, 'gain A ' + ga);
  assert.ok(Math.abs(gb - 1 / Math.sqrt(1.25)) < 0.03, 'gain B ' + gb);
});
