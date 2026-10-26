// Worker d'encodage JPEG : reçoit les bandes de pixels et renvoie le fichier final.
import { JpegEncoder } from './jpeg-encoder.js';

let enc = null;
let parts = [];

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'start') {
      enc = new JpegEncoder(m.width, m.height, m.quality, m.segments || []);
      parts = enc.addRows(new Uint8Array(0), 0);
    } else if (m.type === 'rows') {
      parts.push(...enc.addRows(new Uint8Array(m.rgba), m.rows));
      self.postMessage({ type: 'progress', rows: enc.rowsDone });
    } else if (m.type === 'finish') {
      parts.push(...enc.finish());
      const blob = new Blob(parts, { type: 'image/jpeg' });
      parts = [];
      enc = null;
      self.postMessage({ type: 'done', blob });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
