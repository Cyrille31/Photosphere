// Rendu interactif d'une photosphère (vue perspective, vue à plat, stéréo pour casque).
import { VERT_SRC, VIEW_FRAG_SRC, MAX_HOTSPOTS } from './shaders.js';
import { compileProgram, createQuad, decodeImage, splitHalves, uploadHalves, deleteSource, setSourceUniforms } from './gl-source.js';
import { mat3Apply, mat3Transpose, mat3Identity, vecNormalize, dirFromLonLat, lonLatFromDir, DEG } from './math.js';

export class PanoRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, xrCompatible: !!options.xr, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 n’est pas disponible sur cet appareil.');
    this.gl = gl;
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
    const img = await decodeImage(src);
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    const flatHot = new Float32Array(MAX_HOTSPOTS * 3);
    this.hotspots.forEach((d, i) => flatHot.set(d, i * 3));
    gl.uniform3fv(u.uHot, flatHot);
    gl.uniform1i(u.uHotCount, this.hotspots.length);
    gl.uniform1i(u.uHotSel, frame.hotSel ?? -1);
    gl.uniform1f(u.uHotSize, frame.hotSize || 0.07);
    gl.uniform1f(u.uDwell, frame.dwell || 0);
    gl.uniform1f(u.uReticle, frame.reticle || 0);
    gl.uniform1f(u.uGrid, frame.grid ? 1 : 0);
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
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
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

  dispose() {
    deleteSource(this.gl, this.source);
    this.source = null;
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
