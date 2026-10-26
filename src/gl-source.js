// Outils WebGL communs : programmes, quad plein écran, chargement de la source en deux moitiés.
import { levelMatrix, mat3Transpose, DEG } from './math.js';

export const DEFAULT_LENS_PARAMS = {
  fov: 195,
  blend: 3,
  lensA: { cx: 0.5, cy: 0.5, r: 0.5, rot: 0 },
  lensB: { cx: 0.5, cy: 0.5, r: 0.5, rot: 0 },
};

export function compileProgram(gl, vsSrc, fsSrc) {
  const make = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader : ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, make(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Programme : ' + gl.getProgramInfoLog(prog));
  }
  const uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, uniforms };
}

export function createQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return vao;
}

export async function blobFromSource(src) {
  if (src instanceof Blob) return src;
  const res = await fetch(src);
  return res.blob();
}

export async function decodeImage(src) {
  const blob = await blobFromSource(src);
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch (e) {
      // repli sur <img> ci-dessous
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Découpe l'image en deux carrés (2:1) redimensionnés à maxHalf pixels de côté au maximum.
export function splitHalves(image, maxHalf) {
  const w = image.width, h = image.height;
  const half = Math.min(maxHalf, Math.round(w / 2), h);
  const out = [];
  for (let i = 0; i < 2; i++) {
    const c = document.createElement('canvas');
    c.width = half;
    c.height = half;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, (i * w) / 2, 0, w / 2, h, 0, 0, half, half);
    out.push(c);
  }
  return { halves: out, size: half };
}

export function uploadHalves(gl, split, mipmaps) {
  const textures = split.halves.map((canvas) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mipmaps) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    // Libère la mémoire du canvas intermédiaire.
    canvas.width = canvas.height = 1;
    return tex;
  });
  return { textures, size: split.size };
}

export function deleteSource(gl, source) {
  if (source) source.textures.forEach((t) => gl.deleteTexture(t));
}

// srcType : 'equirect' ou 'fisheye'. params : redressement + calibrage des objectifs.
export function setSourceUniforms(gl, u, source, srcType, params) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, source.textures[0]);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, source.textures[1]);
  gl.uniform1i(u.uTexA, 0);
  gl.uniform1i(u.uTexB, 1);
  gl.uniform2f(u.uTexSize, source.size, source.size);
  gl.uniform1i(u.uSrcMode, srcType === 'fisheye' ? 1 : 0);
  const p = { ...DEFAULT_LENS_PARAMS, ...params };
  const rot = levelMatrix(p.yaw || 0, p.pitch || 0, p.roll || 0);
  gl.uniformMatrix3fv(u.uRot, false, new Float32Array(mat3Transpose(rot)));
  gl.uniform1f(u.uFovHalf, (p.fov / 2) * DEG);
  gl.uniform1f(u.uBlend, Math.max(0.01, Math.min(p.blend, p.fov / 2 - 90.01)) * DEG);
  const la = p.lensA, lb = p.lensB;
  gl.uniform4f(u.uLensA, la.cx, la.cy, la.r, la.rot * DEG);
  gl.uniform4f(u.uLensB, lb.cx, lb.cy, lb.r, lb.rot * DEG);
}
