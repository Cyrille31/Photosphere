// Estimation de profondeur par intelligence artificielle, dans le navigateur.
// Modèle : Depth Anything V2 Small (licence Apache 2.0), exécuté par ONNX Runtime Web : sur la carte
// graphique (WebGPU) quand c'est possible, sinon sur le processeur (WebAssembly).
// Le moteur (≈ 10 Mo) et le modèle (27 à 50 Mo) sont téléchargés à la première utilisation, puis
// gardés dans le cache du navigateur.
import { DEPTH_VIEWS, DEPTH_FOV, viewCamera, alignViews, composeDepth, encodeDepth, backgroundDepth, fillMasked, DEPTH_W, DEPTH_H } from './depth.js';

const ORT_VERSION = '1.20.1';
export const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const MODEL_BASE = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/';
const MODEL_CACHE = 'photosphere-modeles-v1';
const SIZE = 518;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

let enginePromise = null;

// Télécharge un fichier en signalant la progression ; gardé dans le cache du navigateur.
async function fetchCached(url, onBytes) {
  let cache = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch (e) {
    cache = null; // cache indisponible (navigation privée…)
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`téléchargement impossible (${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (onBytes) onBytes(got, total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  if (cache) cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
  return buf;
}

// Moteur et session du modèle, créés une seule fois. onStatus(texte).
export function loadDepthEngine(onStatus = () => {}) {
  if (!enginePromise) {
    enginePromise = (async () => {
      onStatus('Chargement du moteur d’intelligence artificielle…');
      const ort = await import(/* webpackIgnore: true */ ORT_BASE + 'ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.logLevel = 'error';
      const gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null)));
      const tries = gpu ? [['webgpu', 'model_fp16.onnx'], ['wasm', 'model_quantized.onnx']] : [['wasm', 'model_quantized.onnx']];
      let lastErr = null;
      for (const [ep, file] of tries) {
        try {
          const bytes = await fetchCached(MODEL_BASE + file, (got, total) =>
            onStatus(`Téléchargement du modèle de profondeur (une seule fois) : ${(got / 1e6).toFixed(0)}${total ? ' / ' + (total / 1e6).toFixed(0) : ''} Mo…`)
          );
          onStatus('Préparation du modèle…');
          const session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] });
          return { ort, session, ep };
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('modèle indisponible');
    })();
    enginePromise.catch(() => (enginePromise = null));
  }
  return enginePromise;
}

// Carte de profondeur 360° de l'image affichée par `renderer` (redressée selon ses réglages).
// Renvoie { depth, bg: Float32Array (DEPTH_W × DEPTH_H, ligne 0 en haut ; distances de la scène et du
// fond caché derrière les objets proches), png: Blob (carte), bgImage: Blob (couleurs du fond, JPEG),
// bgCanvas, floorOk, ep }.
export async function computeDepth(renderer, onStatus = () => {}) {
  const { ort, session, ep } = await loadDepthEngine(onStatus);
  const views = [];
  const input = new Float32Array(3 * SIZE * SIZE);
  for (let k = 0; k < DEPTH_VIEWS.length; k++) {
    onStatus(`Analyse de la scène par l’IA : vue ${k + 1} / ${DEPTH_VIEWS.length}${ep === 'wasm' ? ' (sur le processeur, patience…)' : ''}`);
    await new Promise((r) => setTimeout(r, 0));
    const cam = viewCamera(DEPTH_VIEWS[k]);
    const px = renderer.readView(cam, DEPTH_FOV, SIZE); // lignes de bas en haut
    const n = SIZE * SIZE;
    for (let y = 0; y < SIZE; y++) {
      const src = (SIZE - 1 - y) * SIZE;
      for (let x = 0; x < SIZE; x++) {
        const i = (src + x) * 4, o = y * SIZE + x;
        input[o] = (px[i] / 255 - MEAN[0]) / STD[0];
        input[n + o] = (px[i + 1] / 255 - MEAN[1]) / STD[1];
        input[2 * n + o] = (px[i + 2] / 255 - MEAN[2]) / STD[2];
      }
    }
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    const t = out[session.outputNames[0]];
    views.push({ cam, size: SIZE, disp: Float32Array.from(t.data) });
    if (t.dispose) t.dispose();
  }
  onStatus('Assemblage de la carte de profondeur…');
  await new Promise((r) => setTimeout(r, 0));
  const align = alignViews(views);
  const depth = composeDepth(views, align);
  // Fond caché derrière les objets proches : distances prolongées et couleurs extrapolées.
  onStatus('Reconstitution du fond derrière les personnes et les objets…');
  await new Promise((r) => setTimeout(r, 0));
  const { bg, mask } = backgroundDepth(depth);
  const flat = renderer.readFlat(DEPTH_W, DEPTH_H); // lignes de bas en haut
  const rgba = new Uint8ClampedArray(DEPTH_W * DEPTH_H * 4);
  for (let y = 0; y < DEPTH_H; y++) rgba.set(flat.subarray((DEPTH_H - 1 - y) * DEPTH_W * 4, (DEPTH_H - y) * DEPTH_W * 4), y * DEPTH_W * 4);
  fillMasked(rgba, mask, DEPTH_W, DEPTH_H);
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = DEPTH_W;
  bgCanvas.height = DEPTH_H;
  bgCanvas.getContext('2d').putImageData(new ImageData(rgba, DEPTH_W, DEPTH_H), 0, 0);
  const bgImage = await new Promise((r) => bgCanvas.toBlob(r, 'image/jpeg', 0.9));
  const png = await depthToPng(depth, bg);
  return { depth, bg, png, bgImage, bgCanvas, floorOk: align.floorOk, ep };
}

export async function depthToPng(depth, bg = null) {
  const c = document.createElement('canvas');
  c.width = DEPTH_W;
  c.height = DEPTH_H;
  c.getContext('2d').putImageData(new ImageData(encodeDepth(depth, bg), DEPTH_W, DEPTH_H), 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  c.width = c.height = 1;
  return blob;
}
