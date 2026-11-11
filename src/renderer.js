// Rendu interactif d'une photosphère (vue perspective, vue à plat, stéréo pour casque).
import { VERT_SRC, VIEW_FRAG_SRC, MAX_HOTSPOTS } from './shaders.js';
import { compileProgram, createQuad, decodeImage, splitHalves, uploadHalves, deleteSource, setSourceUniforms } from './gl-source.js';
import { mat3Apply, mat3Transpose, mat3Identity, vecNormalize, dirFromLonLat, lonLatFromDir, DEG } from './math.js';

const MAX_RENDER_PIXELS = 4.2e6;

export class PanoRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, xrCompatible: !!options.xr, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 n’est pas disponible sur cet appareil.');
    this.gl = gl;
    // Perte du contexte (mémoire graphique saturée, pilote réinitialisé) : on prévient l'appelant.
    this.disposed = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (!this.disposed && options.onLost) options.onLost();
    });
    const { prog, uniforms } = compileProgram(gl, VERT_SRC, VIEW_FRAG_SRC);
    this.prog = prog;
    this.u = uniforms;
    this.vao = createQuad(gl);
    this.source = null;
    this.srcType = 'equirect';
    this.params = {};
    this.hotspots = [];
    this.maxHalf = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), options.maxHalf || 4096);
    this.loadToken = 0;
  }

  async load(src, srcType = 'equirect', params = {}) {
    const token = ++this.loadToken;
    const img = await decodeImage(src, this.maxHalf * 2);
    if (token !== this.loadToken) return false;
    const split = splitHalves(img, this.maxHalf);
    if (img.close) img.close();
    const gl = this.gl;
    const next = uploadHalves(gl, split, true);
    deleteSource(gl, this.source);
    this.source = next;
    this.srcType = srcType;
    this.params = params;
    return true;
  }

  setParams(params, srcType) {
    this.params = params;
    if (srcType) this.srcType = srcType;
  }

  // hotspots : [{ yaw, pitch }] en degrés (repère de sortie).
  setHotspots(list) {
    this.hotspots = list.slice(0, MAX_HOTSPOTS).map((h) => dirFromLonLat(h.yaw * DEG, h.pitch * DEG));
  }

  resize() {
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Plafond de pixels rendus : sur un très grand écran, la fluidité prime sur la définition.
    const cssPx = (this.canvas.clientWidth || 1) * (this.canvas.clientHeight || 1);
    dpr = Math.min(dpr, Math.sqrt(MAX_RENDER_PIXELS / cssPx));
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h, dpr };
  }

  // frame : { eyes: [{ vp, cam, proj, distort }], mode, flat, hotSel, dwell, reticle, grid, framebuffer }
  draw(frame) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.framebuffer || null);
    if (!this.source) {
      gl.clearColor(0.06, 0.07, 0.1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const u = this.u;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    setSourceUniforms(gl, u, this.source, this.srcType, this.params);
    gl.uniform1i(u.uViewMode, frame.mode === 'flat' ? 1 : 0);
    const f = frame.flat || [0, 0, 1, 1];
    gl.uniform4f(u.uFlat, f[0], f[1], f[2], f[3]);
    // frame.hotAlpha : opacité de chaque lien (1 par défaut, toujours visible).
    const flatHot = new Float32Array(MAX_HOTSPOTS * 4);
    this.hotspots.forEach((d, i) => {
      flatHot.set(d, i * 4);
      flatHot[i * 4 + 3] = frame.hotAlpha ? frame.hotAlpha[i] ?? 1 : 1;
    });
    gl.uniform4fv(u.uHot, flatHot);
    gl.uniform1i(u.uHotCount, this.hotspots.length);
    gl.uniform1i(u.uHotSel, frame.hotSel ?? -1);
    gl.uniform1f(u.uHotSize, frame.hotSize || 0.07);
    gl.uniform1f(u.uDwell, frame.dwell || 0);
    gl.uniform1f(u.uReticle, frame.reticle || 0);
    gl.uniform1f(u.uGrid, frame.grid ? 1 : 0);
    this.bindRelief();
    gl.uniform1f(u.uDepthView, frame.depthView ? 1 : 0);
    for (const eye of frame.eyes) {
      const [x, y, w, h] = eye.vp;
      gl.viewport(x, y, w, h);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x, y, w, h);
      gl.uniform4f(u.uVp, x, y, w, h);
      const p = eye.proj || [1, 0, 1, 0];
      gl.uniform4f(u.uProj, p[0], p[1], p[2], p[3]);
      gl.uniformMatrix3fv(u.uCam, false, new Float32Array(mat3Transpose(eye.cam || mat3Identity())));
      const d = eye.distort || [0, 0];
      gl.uniform2f(u.uDistort, d[0], d[1]);
      const e = (this.depth && eye.offset) || [0, 0, 0];
      gl.uniform3f(u.uEye, e[0], e[1], e[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  // Carte de profondeur (voir depth.js) : depth et bg, Float32Array w × h (ligne 0 = latitude +90°,
  // distances en hauteurs d'objectif, bg : fond caché derrière les objets proches), ou null.
  setDepth(depth, bg = null, w = 1024, h = 512) {
    const gl = this.gl;
    if (!this.depthTex) {
      this.depthTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else if (depth === this.depth && bg === this.depthBg) return;
    this.depth = depth || null;
    this.depthBg = bg || null;
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    if (depth) {
      const rg = new Float32Array(w * h * 2);
      for (let i = 0; i < w * h; i++) {
        rg[2 * i] = depth[i];
        rg[2 * i + 1] = bg ? bg[i] : depth[i];
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, w, h, 0, gl.RG, gl.FLOAT, rg);
    } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, 1, 1, 0, gl.RG, gl.FLOAT, new Float32Array([1, 1]));
  }

  // Couleurs du fond extrapolées derrière les objets proches (image équirectangulaire) ou null.
  setBackgroundColor(image) {
    const gl = this.gl;
    if (!this.bgTex) {
      this.bgTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else if (image === this.bgImage) return;
    this.bgImage = image || null;
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (image) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  bindRelief() {
    const gl = this.gl, u = this.u;
    if (!this.depthTex) this.setDepth(null);
    if (!this.bgTex) this.setBackgroundColor(null);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.uniform1i(u.uDepthTex, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.uniform1i(u.uBgTex, 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(u.uRelief, this.depth ? 1 : 0, this.bgImage ? 1 : 0);
  }

  // Image équirectangulaire redressée w × h, lignes de bas en haut (latitude -90° en ligne 0).
  readFlat(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.draw({ mode: 'flat', flat: [0, 0, w, h], eyes: [{ vp: [0, 0, w, h] }], framebuffer: fbo, hotAlpha: this.hotspots.map(() => 0), hotSel: -1 });
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return px;
  }

  // Direction (repère de sortie) sous un point écran en pixels canvas (origine en haut à gauche).
  pick(px, py, frame) {
    const h = this.canvas.height;
    const gy = h - py;
    if (frame.mode === 'flat') {
      const f = frame.flat;
      const ux = (px - f[0]) / f[2];
      const uy = (gy - f[1]) / f[3];
      if (ux < 0 || ux > 1 || uy < 0 || uy > 1) return null;
      return dirFromLonLat((ux - 0.5) * 2 * Math.PI, (uy - 0.5) * Math.PI);
    }
    const eye = frame.eyes.find((e) => px >= e.vp[0] && px <= e.vp[0] + e.vp[2]) || frame.eyes[0];
    const [x, y, w, hh] = eye.vp;
    const nx = ((px - x) / w) * 2 - 1;
    const ny = ((gy - y) / hh) * 2 - 1;
    const p = eye.proj;
    return vecNormalize(mat3Apply(eye.cam, [nx * p[0] + p[1], ny * p[2] + p[3], 1]));
  }

  // Projection inverse : pixels canvas (origine en haut à gauche) ou null si hors champ.
  project(dir, frame) {
    const h = this.canvas.height;
    if (frame.mode === 'flat') {
      const { lon, lat } = lonLatFromDir(dir);
      const f = frame.flat;
      return { x: f[0] + (lon / (2 * Math.PI) + 0.5) * f[2], y: h - (f[1] + (lat / Math.PI + 0.5) * f[3]) };
    }
    const eye = frame.eyes[0];
    const c = mat3Apply(mat3Transpose(eye.cam), dir);
    if (c[2] <= 0.01) return null;
    const p = eye.proj;
    const nx = (c[0] / c[2] - p[1]) / p[0];
    const ny = (c[1] / c[2] - p[3]) / p[2];
    if (Math.abs(nx) > 1.2 || Math.abs(ny) > 1.2) return null;
    const [x, y, w, hh] = eye.vp;
    return { x: x + ((nx + 1) / 2) * w, y: h - (y + ((ny + 1) / 2) * hh) };
  }

  // Rend une vue perspective carrée hors écran et renvoie ses pixels (RGBA, lignes de bas en haut).
  // Sert à l'analyse de l'image (redressement automatique) ; les cibles de liens sont masquées.
  readView(cam, fovDeg, size) {
    const gl = this.gl;
    if (!this.viewFbo || this.viewFboSize !== size) {
      if (this.viewFbo) {
        gl.deleteFramebuffer(this.viewFbo);
        gl.deleteTexture(this.viewTex);
      }
      this.viewTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.viewTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
      this.viewFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.viewFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.viewTex, 0);
      this.viewFboSize = size;
    }
    const t = Math.tan(((fovDeg / 2) * Math.PI) / 180);
    this.draw({
      mode: 'persp',
      eyes: [{ vp: [0, 0, size, size], cam, proj: [t, 0, t, 0] }],
      framebuffer: this.viewFbo,
      hotAlpha: this.hotspots.map(() => 0),
      hotSel: -1,
    });
    const px = new Uint8Array(size * size * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.viewFbo);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px;
  }

  dispose() {
    this.disposed = true;
    deleteSource(this.gl, this.source);
    this.source = null;
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
