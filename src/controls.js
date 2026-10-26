// Contrôle de la vue : glisser / pincer / molette, gyroscope, vue à plat, stéréo pour casque.
import { DEG, cameraMatrix, deviceOrientationMatrix, headingOf, mat3Mul, rotY } from './math.js';

export const DEFAULT_HEADSET = { eyeFov: 90, k1: 0.22, k2: 0.1 };

export class ViewController {
  constructor(canvas, renderer, opts = {}) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.onTap = opts.onTap || null;
    this.onChange = opts.onChange || null;
    this.mode = 'touch'; // 'touch' | 'gyro' | 'flat'
    this.stereo = false;
    this.headset = { ...DEFAULT_HEADSET, ...(opts.headset || {}) };
    this.yaw = 0;
    this.pitch = 0;
    this.fov = 75;
    this.flatZoom = 1;
    this.flatCx = 0.5;
    this.flatCy = 0.5;
    this.gyroOffset = 0;
    this.gyroMat = null;
    this.pointers = new Map();
    this.lastPinch = 0;
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    this._down = (e) => {
      c.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
      if (this.pointers.size === 2) this.lastPinch = this._pinchDist();
    };
    this._move = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 2) {
        const d = this._pinchDist();
        if (this.lastPinch > 0 && d > 0) this.zoomBy(this.lastPinch / d);
        this.lastPinch = d;
        return;
      }
      this.dragBy(dx, dy);
    };
    this._up = (e) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (!p) return;
      const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
      if (moved < 8 && performance.now() - p.t < 600 && this.onTap && this.pointers.size === 0) {
        const r = c.getBoundingClientRect();
        const sx = c.width / r.width;
        this.onTap((e.clientX - r.left) * sx, (e.clientY - r.top) * sx, e);
      }
    };
    this._wheel = (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomBy(Math.exp(e.deltaY * 0.0015), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    c.addEventListener('pointerdown', this._down);
    c.addEventListener('pointermove', this._move);
    c.addEventListener('pointerup', this._up);
    c.addEventListener('pointercancel', this._up);
    c.addEventListener('wheel', this._wheel, { passive: false });
  }

  _pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _changed() {
    if (this.onChange) this.onChange();
  }

  dragBy(dx, dy) {
    const h = this.canvas.clientHeight || 1;
    if (this.mode === 'flat') {
      const size = this._flatBase();
      this.flatCx -= dx / (size.w * this.flatZoom);
      this.flatCy -= dy / (size.h * this.flatZoom);
      this._clampFlat();
    } else {
      const radPerPx = (this.fov * DEG) / h;
      if (this.mode === 'gyro') {
        this.gyroOffset -= dx * radPerPx;
      } else {
        this.yaw -= dx * radPerPx;
        this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch + dy * radPerPx));
      }
    }
    this._changed();
  }

  zoomBy(factor, fx = 0.5, fy = 0.5) {
    if (this.mode === 'flat') {
      const old = this.flatZoom;
      this.flatZoom = Math.max(1, Math.min(16, this.flatZoom / factor));
      // Garde le point sous le curseur immobile.
      const size = this._flatBase();
      const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
      const ox = (fx * W - W / 2) / size.w, oy = (fy * H - H / 2) / size.h;
      this.flatCx += ox / old - ox / this.flatZoom;
      this.flatCy += oy / old - oy / this.flatZoom;
      this._clampFlat();
    } else {
      this.fov = Math.max(25, Math.min(110, this.fov * factor));
    }
    this._changed();
  }

  _flatBase() {
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    const w = Math.min(W, H * 2);
    return { w, h: w / 2 };
  }

  _clampFlat() {
    const size = this._flatBase();
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const hw = Math.min(0.5, W / (2 * size.w * this.flatZoom));
    const hh = Math.min(0.5, H / (2 * size.h * this.flatZoom));
    this.flatCx = Math.max(hw, Math.min(1 - hw, this.flatCx));
    this.flatCy = Math.max(hh, Math.min(1 - hh, this.flatCy));
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'flat') this._clampFlat();
    this._changed();
  }

  async enableGyro() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return false;
      } catch (e) {
        return false;
      }
    }
    const current = this.camMatrix();
    let first = true;
    this._orient = (e) => {
      if (e.alpha == null && e.beta == null) return;
      const angle = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
      this.gyroMat = deviceOrientationMatrix(e.alpha || 0, e.beta || 0, e.gamma || 0, angle);
      if (first) {
        first = false;
        this.gyroOffset = headingOf(current) - headingOf(this.gyroMat);
      }
      this._changed();
    };
    window.addEventListener('deviceorientation', this._orient);
    const ok = await new Promise((resolve) => {
      const t0 = performance.now();
      const check = () => {
        if (this.gyroMat) resolve(true);
        else if (performance.now() - t0 > 1500) resolve(false);
        else setTimeout(check, 100);
      };
      check();
    });
    if (!ok) {
      this.disableGyro();
      return false;
    }
    this.mode = 'gyro';
    return true;
  }

  disableGyro() {
    if (this._orient) window.removeEventListener('deviceorientation', this._orient);
    this._orient = null;
    if (this.gyroMat) {
      const m = this.camMatrix();
      this.yaw = headingOf(m);
      this.pitch = Math.asin(Math.max(-1, Math.min(1, m[5])));
    }
    this.gyroMat = null;
    if (this.mode === 'gyro') this.mode = 'touch';
  }

  camMatrix() {
    if (this.mode === 'gyro' && this.gyroMat) return mat3Mul(rotY(this.gyroOffset), this.gyroMat);
    return cameraMatrix(this.yaw, this.pitch);
  }

  // Direction du regard (centre de l'écran).
  gazeDir() {
    const m = this.camMatrix();
    return [m[2], m[5], m[8]];
  }

  frame() {
    const { w, h } = this.renderer.resize();
    if (this.mode === 'flat') {
      const dpr = w / (this.canvas.clientWidth || 1);
      const base = this._flatBase();
      const fw = base.w * this.flatZoom * dpr, fh = base.h * this.flatZoom * dpr;
      const left = w / 2 - this.flatCx * fw;
      const top = h / 2 - this.flatCy * fh;
      return { mode: 'flat', flat: [left, h - (top + fh), fw, fh], eyes: [{ vp: [0, 0, w, h] }] };
    }
    const cam = this.camMatrix();
    if (this.stereo) {
      const hw = Math.floor(w / 2);
      const sy = Math.tan((this.headset.eyeFov / 2) * DEG);
      const sx = sy * (hw / h);
      const distort = [this.headset.k1, this.headset.k2];
      return {
        mode: 'persp',
        stereo: true,
        eyes: [
          { vp: [0, 0, hw, h], cam, proj: [sx, 0, sy, 0], distort },
          { vp: [hw, 0, w - hw, h], cam, proj: [sx, 0, sy, 0], distort },
        ],
      };
    }
    const sy = Math.tan((this.fov / 2) * DEG);
    return { mode: 'persp', eyes: [{ vp: [0, 0, w, h], cam, proj: [sy * (w / h), 0, sy, 0] }] };
  }

  dispose() {
    this.disableGyro();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._down);
    c.removeEventListener('pointermove', this._move);
    c.removeEventListener('pointerup', this._up);
    c.removeEventListener('pointercancel', this._up);
    c.removeEventListener('wheel', this._wheel);
  }
}
