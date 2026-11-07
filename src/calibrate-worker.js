// Calibrage automatique hors du fil d'affichage (quelques secondes de calcul par photo).
import { autoCalibrate } from './calibrate.js';

self.onmessage = (e) => {
  const { A, B, size, start } = e.data;
  try {
    const patch = autoCalibrate({ size, data: new Float32Array(A) }, { size, data: new Float32Array(B) }, start);
    self.postMessage({ patch });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
