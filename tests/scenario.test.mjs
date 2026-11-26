import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder, scenarioAt, scenarioDuration, scenarioFor, encodeScenario, decodeScenario } from '../src/scenario.js';

test('scénario : enregistrement, interpolation du regard, changement de photo', () => {
  const r = createRecorder();
  r.sample(0, 'a.jpg', 170, 0);
  r.sample(0.05, 'a.jpg', 175, 0); // trop tôt après la précédente : ignorée
  for (let t = 0.2; t <= 1.01; t += 0.2) r.sample(t, 'a.jpg', 170 + 20 * t, 5 * t); // passe par 180° → -170°
  r.sample(3, 'a.jpg', 190, 5); // reprise après une pause : la vue est restée immobile jusque-là
  r.sample(3.5, 'B.JPG', 10, 0);
  const s = r.finish('Essai', 5);
  assert.deepEqual(s.files, ['a.jpg', 'B.JPG']);
  assert.equal(scenarioDuration(s), 5);
  const mid = scenarioAt(s, 0.5);
  assert.equal(mid.file, 'a.jpg');
  assert.ok(Math.abs(((mid.yaw - 180 + 540) % 360) - 180) < 0.6, `cap ${mid.yaw}`);
  const still = scenarioAt(s, 2);
  assert.ok(Math.abs(((still.yaw - 190 + 540) % 360) - 180) < 0.6, `immobile pendant la pause (${still.yaw})`);
  assert.equal(scenarioAt(s, 3.2).file, 'a.jpg'); // pas d'interpolation entre deux photos
  assert.equal(scenarioAt(s, 4).file, 'B.JPG');
  assert.equal(scenarioFor(s, (f) => f !== 'B.JPG').steps.every((x) => x[1] === 0), true);
  assert.equal(scenarioFor(s, () => false), null);
});

test('scénario : lien compressé et retour', async () => {
  const r = createRecorder();
  for (let i = 0; i < 300; i++) r.sample(i * 0.2, i < 150 ? '360_0001 salon.JPG' : '360_0002 cuisine.JPG', (i * 7) % 360, 0);
  const s = r.finish('Tour « complet »', 61);
  const code = await encodeScenario(s);
  assert.match(code, /^[zj][A-Za-z0-9_-]+$/);
  const back = await decodeScenario(code);
  assert.deepEqual(back, s);
  assert.ok(code.length < JSON.stringify(s).length, `compressé : ${code.length} caractères`);
});
