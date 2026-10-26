// Conversion d'une photo (double fisheye ou équirectangulaire) en JPEG équirectangulaire
// pleine résolution (7776 x 3888 par défaut) + vignette.
import { VERT_SRC, EXPORT_FRAG_SRC } from './shaders.js';
import { compileProgram, createQuad, decodeImage, splitHalves, uploadHalves, deleteSource, setSourceUniforms } from './gl-source.js';

const BAND = 256; // multiple de 16 (taille des blocs JPEG 4:2:0)

export async function renderPanorama({ src, srcType, params, width = 7776, height = 3888, quality = 92, segments = [], thumbWidth = 1024, onProgress }) {
  const img = await decodeImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) throw new Error('WebGL2 n’est pas disponible sur cet appareil.');
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const split = splitHalves(img, Math.min(maxTex, 8192));
  if (img.close) img.close();
  const source = uploadHalves(gl, split, false);
  const { prog, uniforms: u } = compileProgram(gl, VERT_SRC, EXPORT_FRAG_SRC);
  const vao = createQuad(gl);
  const maxVp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  const tileW = Math.min(width, 4096, maxVp[0], maxTex);

  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, Math.max(tileW, thumbWidth), Math.max(BAND, thumbWidth / 2));
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);

  gl.useProgram(prog);
  gl.bindVertexArray(vao);
  setSourceUniforms(gl, u, source, srcType, params);

  const renderRegion = (outW, outH, x0, y0, w, h, buf) => {
    gl.uniform2f(u.uOutSize, outW, outH);
    gl.uniform2f(u.uTileOrigin, x0, y0);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };

  // Vignette
  const tw = thumbWidth, th = thumbWidth / 2;
  const thumbPixels = new Uint8Array(tw * th * 4);
  renderRegion(tw, th, 0, 0, tw, th, thumbPixels);
  const tc = document.createElement('canvas');
  tc.width = tw;
  tc.height = th;
  tc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(thumbPixels.buffer), tw, th), 0, 0);
  const thumb = await new Promise((r) => tc.toBlob(r, 'image/jpeg', 0.82));

  // Image pleine résolution, encodée par bandes dans un worker.
  const worker = new Worker(new URL('./jpeg-worker.js', import.meta.url), { type: 'module' });
  let rowsEncoded = 0;
  let waiting = null;
  const done = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        rowsEncoded = m.rows;
        if (onProgress) onProgress(rowsEncoded / height);
        if (waiting) waiting();
      } else if (m.type === 'done') resolve(m.blob);
      else if (m.type === 'error') reject(new Error(m.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Erreur du worker JPEG'));
  });
  worker.postMessage({ type: 'start', width, height, quality, segments });
  const tile = new Uint8Array(tileW * BAND * 4);
  try {
    for (let y0 = 0; y0 < height; y0 += BAND) {
      // Limite la mémoire : au plus deux bandes en attente d'encodage.
      while (y0 - rowsEncoded > BAND * 2) await new Promise((r) => (waiting = r));
      const rows = Math.min(BAND, height - y0);
      const band = new Uint8Array(width * rows * 4);
      for (let x0 = 0; x0 < width; x0 += tileW) {
        const w = Math.min(tileW, width - x0);
        renderRegion(width, height, x0, y0, w, rows, tile);
        for (let r = 0; r < rows; r++) band.set(tile.subarray(r * w * 4, (r + 1) * w * 4), (r * width + x0) * 4);
      }
      worker.postMessage({ type: 'rows', rgba: band.buffer, rows }, [band.buffer]);
    }
    worker.postMessage({ type: 'finish' });
    const blob = await done;
    return { blob, thumb };
  } finally {
    worker.terminate();
    deleteSource(gl, source);
    gl.deleteTexture(target);
    gl.deleteFramebuffer(fbo);
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
