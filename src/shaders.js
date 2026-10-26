// Shaders WebGL2. La source est toujours chargée en deux moitiés (gauche / droite) pour
// rester sous les limites de taille de texture des smartphones.

export const VERT_SRC = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const SOURCE_GLSL = `
precision highp float;
const float PI = 3.14159265358979;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform vec2 uTexSize;      // taille d'une moitié, en pixels
uniform int uSrcMode;       // 0 = équirectangulaire, 1 = double fisheye
uniform mat3 uRot;          // sortie -> source (redressement)
uniform float uFovHalf;     // demi-champ des objectifs fisheye (radians)
uniform float uBlend;       // demi-largeur de la couture (radians)
uniform vec4 uLensA;        // cx, cy, rayon, rotation (objectif avant)
uniform vec4 uLensB;        // idem objectif arrière

vec2 lensUv(vec4 lens, vec2 p, float theta) {
  float r = lens.z * theta / uFovHalf;
  float a = atan(p.y, p.x) + lens.w;
  return lens.xy + r * vec2(cos(a), -sin(a));
}

vec4 sampleSource(vec3 dOut, float pixAng) {
  vec3 d = normalize(uRot * dOut);
  if (uSrcMode == 0) {
    float u = atan(d.x, d.z) / (2.0 * PI) + 0.5;
    float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI;
    float lod = log2(max(pixAng * uTexSize.x / PI, 1.0));
    if (u < 0.5) return textureLod(uTexA, vec2(u * 2.0, v), lod);
    return textureLod(uTexB, vec2(u * 2.0 - 1.0, v), lod);
  }
  float lod = log2(max(pixAng * uLensA.z * uTexSize.x / uFovHalf, 1.0));
  float tf = acos(clamp(d.z, -1.0, 1.0));
  float tb = PI - tf;
  float wf = 1.0 - smoothstep(PI * 0.5 - uBlend, PI * 0.5 + uBlend, tf);
  if (tf >= uFovHalf) wf = 0.0;
  if (tb >= uFovHalf) wf = 1.0;
  vec4 cf = wf > 0.0 ? textureLod(uTexA, lensUv(uLensA, d.xy, tf), lod) : vec4(0.0);
  vec4 cb = wf < 1.0 ? textureLod(uTexB, lensUv(uLensB, vec2(-d.x, d.y), tb), lod) : vec4(0.0);
  return mix(cb, cf, wf);
}
`;

export const EXPORT_FRAG_SRC = `#version 300 es
${SOURCE_GLSL}
uniform vec2 uOutSize;
uniform vec2 uTileOrigin;
out vec4 outColor;
void main() {
  // La ligne 0 du tampon correspond au haut de la tuile : readPixels renvoie donc l'image à l'endroit.
  vec2 p = uTileOrigin + gl_FragCoord.xy;
  vec2 uv = p / uOutSize;
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (0.5 - uv.y) * PI;
  vec3 d = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  outColor = vec4(sampleSource(d, 2.0 * PI / uOutSize.x).rgb, 1.0);
}`;

export const MAX_HOTSPOTS = 32;

export const VIEW_FRAG_SRC = `#version 300 es
${SOURCE_GLSL}
uniform vec4 uVp;           // fenêtre de l'œil (pixels)
uniform vec4 uProj;         // sx, ox, sy, oy (espace tangente)
uniform mat3 uCam;          // caméra -> monde
uniform int uViewMode;      // 0 perspective, 1 plan équirectangulaire
uniform vec4 uFlat;         // rectangle de l'image en mode plan (pixels, origine en bas)
uniform vec2 uDistort;      // k1, k2 (lentilles du casque)
uniform vec3 uHot[${MAX_HOTSPOTS}];
uniform int uHotCount;
uniform int uHotSel;
uniform float uHotSize;
uniform float uDwell;
uniform float uReticle;
uniform float uGrid;
out vec4 outColor;

vec3 dirFromLonLat(float lon, float lat) {
  return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec3 dir;
  float inside = 1.0;
  vec2 ndc = (frag - uVp.xy) / uVp.zw * 2.0 - 1.0;
  if (uViewMode == 1) {
    vec2 uv = (frag - uFlat.xy) / uFlat.zw;
    inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    uv = clamp(uv, 0.0, 1.0);
    dir = dirFromLonLat((uv.x - 0.5) * 2.0 * PI, (uv.y - 0.5) * PI);
  } else {
    vec2 t = vec2(ndc.x * uProj.x + uProj.y, ndc.y * uProj.z + uProj.w);
    float r2 = dot(t, t);
    t *= 1.0 + uDistort.x * r2 + uDistort.y * r2 * r2;
    dir = normalize(uCam * vec3(t, 1.0));
  }
  float pixAng = length(fwidth(dir));
  vec3 col = sampleSource(dir, pixAng).rgb;

  if (uGrid > 0.0) {
    float lat = asin(clamp(dir.y, -1.0, 1.0)) / PI * 180.0;
    float lon = atan(dir.x, dir.z) / PI * 180.0;
    float wLat = max(fwidth(lat), 1e-4);
    float wLon = wLat / max(cos(radians(lat)), 0.05);
    float gLat = abs(fract(lat / 10.0 + 0.5) - 0.5) * 10.0 / wLat;
    float gLon = abs(fract(lon / 15.0 + 0.5) - 0.5) * 15.0 / wLon;
    float line = 1.0 - clamp(min(gLat, gLon) - 0.5, 0.0, 1.0);
    float horizon = 1.0 - clamp(abs(lat) / wLat - 1.0, 0.0, 1.0);
    col = mix(col, vec3(1.0), line * 0.35 * uGrid);
    col = mix(col, vec3(1.0, 0.75, 0.1), horizon * uGrid);
  }

  for (int i = 0; i < ${MAX_HOTSPOTS}; i++) {
    if (i >= uHotCount) break;
    vec3 h = uHot[i];
    float ang = acos(clamp(dot(dir, h), -1.0, 1.0));
    float s = uHotSize * (i == uHotSel ? 1.25 : 1.0);
    if (ang < s * 1.45) {
      float aa = max(pixAng * 1.5, 1e-5);
      float disc = 1.0 - smoothstep(s - aa, s, ang);
      float ring = disc * smoothstep(s * 0.72 - aa, s * 0.72, ang);
      float dot0 = 1.0 - smoothstep(s * 0.22 - aa, s * 0.22, ang);
      vec3 accent = i == uHotSel ? vec3(1.0, 0.62, 0.15) : vec3(0.25, 0.8, 1.0);
      col = mix(col, accent * 0.35, disc * 0.45);
      col = mix(col, vec3(1.0), ring * 0.95 + dot0);
      if (i == uHotSel && uDwell > 0.0) {
        vec3 t1 = normalize(cross(vec3(0.0, 1.0, 0.0), h) + vec3(1e-6, 0.0, 0.0));
        vec3 t2 = cross(h, t1);
        float a = atan(dot(dir, t2), dot(dir, t1)) / (2.0 * PI) + 0.5;
        float arc = step(s * 1.1, ang) * (1.0 - step(s * 1.4, ang)) * step(a, uDwell);
        col = mix(col, accent, arc);
      }
    }
  }

  if (uReticle > 0.0 && uViewMode == 0) {
    vec2 px = (ndc * uVp.zw * 0.5);
    float d = length(px);
    float rr = uReticle;
    float ring = smoothstep(rr * 0.55, rr * 0.7, d) * (1.0 - smoothstep(rr * 0.85, rr, d));
    col = mix(col, vec3(1.0), ring * 0.9);
  }

  outColor = vec4(col * inside + vec3(0.06, 0.07, 0.1) * (1.0 - inside), 1.0);
}`;
