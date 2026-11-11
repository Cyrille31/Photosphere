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
uniform vec2 uVignette;     // correction du vignettage : P, Q (log V = -(P t² + Q t⁸), t = θ / 90°)
uniform vec4 uLensA;        // cx, cy, rayon, rotation (objectif avant)
uniform vec4 uLensB;        // idem objectif arrière
uniform vec3 uGainA[36];    // correction d'exposition le long de la couture (par azimut)
uniform vec3 uGainB[36];
uniform sampler2D uSeamTex; // par tranche d'azimut : R = décalage de la couture, G = parallaxe, B = décalage le long de la couture (radians)

vec2 lensUv(vec4 lens, vec2 p, float theta, float extraRot) {
  float r = lens.z * theta / uFovHalf;
  float a = atan(p.y, p.x) + lens.w + extraRot;
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
  // Comme le logiciel Samsung : le centre de la photo correspond à la moitié droite de l'image brute.
  d = vec3(-d.x, d.y, -d.z);
  float lod = log2(max(pixAng * uLensA.z * uTexSize.x / uFovHalf, 1.0));
  float tf = acos(clamp(d.z, -1.0, 1.0));
  float tb = PI - tf;
  float az = (atan(d.y, d.x) + PI) / (2.0 * PI);
  float sbin = mod(az * 180.0 - 0.5, 180.0);
  int s0 = int(floor(sbin));
  vec3 sd = mix(texelFetch(uSeamTex, ivec2(s0, 0), 0).rgb, texelFetch(uSeamTex, ivec2((s0 + 1) % 180, 0), 0).rgb, fract(sbin));
  float seam = PI * 0.5 + sd.r;
  // Correction de parallaxe : décalage radial des deux images, maximal sur la couture et nul à 30°.
  float ramp = 1.0 - smoothstep(0.13, 0.53, abs(tf - PI * 0.5));
  float disp = 0.5 * ramp * sd.g;
  float twist = -0.5 * ramp * sd.b;
  float tfs = tf - disp;
  float tbs = tb - disp;
  float wf = 1.0 - smoothstep(seam - uBlend, seam + uBlend, tf);
  if (tfs >= uFovHalf) wf = 0.0;
  if (tbs >= uFovHalf) wf = 1.0;
  vec4 cf = wf > 0.0 ? textureLod(uTexA, lensUv(uLensA, d.xy, tfs, twist), lod) : vec4(0.0);
  vec4 cb = wf < 1.0 ? textureLod(uTexB, lensUv(uLensB, vec2(-d.x, d.y), tbs, twist), lod) : vec4(0.0);
  // Gains interpolés selon l'azimut autour de l'axe, appliqués progressivement vers la couture.
  float bin = mod(az * 36.0 - 0.5, 36.0);
  int i0 = int(floor(bin));
  int i1 = (i0 + 1) % 36;
  float fr = fract(bin);
  vec3 ga = mix(uGainA[i0], uGainA[i1], fr);
  vec3 gb = mix(uGainB[i0], uGainB[i1], fr);
  float ra = smoothstep(PI * 0.25, PI * 0.5, tf);
  float rb = smoothstep(PI * 0.25, PI * 0.5, tb);
  float ta = tfs / (PI * 0.5), tb2 = tbs / (PI * 0.5);
  ta *= ta;
  tb2 *= tb2;
  // Gain qui agit pleinement dans les ombres et tend doucement vers le blanc sans saturer
  // (comme le logiciel Samsung) : y = 1 - (1 - x)^g.
  float va = exp((uVignette.x * ta + uVignette.y * ta * ta * ta * ta) / 2.2);
  float vb = exp((uVignette.x * tb2 + uVignette.y * tb2 * tb2 * tb2 * tb2) / 2.2);
  cf.rgb = 1.0 - pow(1.0 - clamp(cf.rgb, 0.0, 1.0), vec3(va));
  cb.rgb = 1.0 - pow(1.0 - clamp(cb.rgb, 0.0, 1.0), vec3(vb));
  cf.rgb *= mix(vec3(1.0), ga, ra);
  cb.rgb *= mix(vec3(1.0), gb, rb);
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
uniform vec4 uHot[${MAX_HOTSPOTS}];   // direction (xyz) et opacité (w) des liens
uniform int uHotCount;
uniform int uHotSel;
uniform float uHotSize;
uniform float uDwell;
uniform float uReticle;
uniform float uGrid;
// Relief : carte de profondeur équirectangulaire (R : distance, G : distance du fond caché derrière les
// objets proches, en hauteurs d'objectif), couleurs de ce fond, position de l'œil.
uniform sampler2D uDepthTex;
uniform sampler2D uBgTex;
uniform vec2 uRelief;       // x : relief disponible (0 / 1), y : couleurs du fond disponibles
uniform vec3 uEye;          // position de l'œil par rapport au centre de la photo (en hauteurs d'objectif)
uniform float uDepthView;   // > 0 : colore l'image selon la distance estimée (vérification)
out vec4 outColor;

vec2 eqUv(vec3 d) {
  return vec2(atan(d.x, d.z) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
}
vec2 depth2(vec3 d) { return textureLod(uDepthTex, eqUv(d), 0.0).rg; }
float sceneDist(vec3 d) { return depth2(d).r; }

// Premier point où le rayon e + t·d passe derrière la scène (couche 0) ou le fond (couche 1) :
// pas croissants (+25 %), puis dichotomie. -1 : rien touché (au loin).
float marchLayer(vec3 e, vec3 d, int layer) {
  float lo = 0.1, t = 0.1;
  for (int i = 0; i < 29; i++) {
    vec3 x = e + t * d;
    float r = length(x);
    vec2 dd = depth2(x / r);
    if (r >= (layer == 0 ? dd.r : dd.g)) {
      float hi = t;
      for (int k = 0; k < 6; k++) {
        float m = 0.5 * (lo + hi);
        vec3 xm = e + m * d;
        float rm = length(xm);
        vec2 dm = depth2(xm / rm);
        if (rm >= (layer == 0 ? dm.r : dm.g)) hi = m; else lo = m;
      }
      return hi;
    }
    lo = t;
    t *= 1.25;
  }
  return -1.0;
}

// Rayon issu de l'œil (décalé du centre de prise de vue) : point de la scène qu'il atteint, puis
// direction de ce point vue du centre (celle où la photo l'a enregistré). Si ce point tombe sur la
// « pente » entre un objet proche et le fond (ce que la caméra n'a pas vu), on prend le fond caché,
// reconstitué : l'objet n'est pas étiré.
vec3 reliefDir(vec3 e, vec3 d, out bool useBg) {
  useBg = false;
  float t = marchLayer(e, d, 0);
  if (t < 0.0) return d;
  vec3 x = normalize(e + t * d);
  vec2 uv = eqUv(x);
  vec2 tx = 1.5 / vec2(textureSize(uDepthTex, 0));
  float c0 = textureLod(uDepthTex, uv, 0.0).r;
  float a = textureLod(uDepthTex, uv + vec2(tx.x, 0.0), 0.0).r;
  float b = textureLod(uDepthTex, uv - vec2(tx.x, 0.0), 0.0).r;
  float c = textureLod(uDepthTex, uv + vec2(0.0, tx.y), 0.0).r;
  float f = textureLod(uDepthTex, uv - vec2(0.0, tx.y), 0.0).r;
  float mn = min(min(a, b), min(c, f)), mx = max(max(a, b), max(c, f));
  // (seulement là où un fond distinct a été reconstitué : pas sur le bruit de la carte)
  float g0 = textureLod(uDepthTex, uv, 0.0).g;
  if (mx > mn * 1.15 && c0 > mn * 1.06 && c0 < mx * 0.94 && g0 > c0 * 1.08) {
    // Fond prolongé : le premier pixel du côté lointain du contour, en suivant la pente de distance
    // (couleurs réelles de la photo, à pleine résolution).
    vec2 grad = vec2(log(a) - log(b), log(c) - log(f));
    vec2 step = normalize(grad + vec2(1e-6, 0.0)) * tx;
    for (int k = 1; k <= 8; k++) {
      vec2 q = uv + step * float(k);
      if (textureLod(uDepthTex, q, 0.0).r > mx * 0.9) {
        float lon = (q.x - 0.5) * 2.0 * PI, lat = (0.5 - q.y) * PI;
        return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
      }
    }
    // Sinon : fond reconstitué (distances et couleurs extrapolées).
    useBg = true;
    float tb = marchLayer(e, d, 1);
    return tb < 0.0 ? d : normalize(e + tb * d);
  }
  return x;
}

vec3 dirFromLonLat(float lon, float lat) {
  return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec3 dir;
  float inside = 1.0;
  vec2 ndc = (frag - uVp.xy) / uVp.zw * 2.0 - 1.0;
  // Position dans l'espace des tangentes, avant correction des lentilles (0 = centre optique).
  vec2 t0 = vec2(ndc.x * uProj.x + uProj.y, ndc.y * uProj.z + uProj.w);
  if (uViewMode == 1) {
    vec2 uv = (frag - uFlat.xy) / uFlat.zw;
    inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    uv = clamp(uv, 0.0, 1.0);
    dir = dirFromLonLat((uv.x - 0.5) * 2.0 * PI, (uv.y - 0.5) * PI);
  } else {
    vec2 t = t0;
    float r2 = dot(t, t);
    t *= 1.0 + uDistort.x * r2 + uDistort.y * r2 * r2;
    dir = normalize(uCam * vec3(t, 1.0));
  }
  // Finesse de l'échantillonnage : celle du rayon de l'œil (avant le décalage du relief, qui fait
  // sauter la direction d'un pixel à l'autre au contour des objets).
  float pixAng = length(fwidth(dir));
  bool useBg = false;
  if (uViewMode == 0 && uRelief.x > 0.5 && dot(uEye, uEye) > 0.0) dir = reliefDir(uEye, dir, useBg);
  vec3 col = useBg && uRelief.y > 0.5 ? textureLod(uBgTex, eqUv(dir), 0.0).rgb : sampleSource(dir, pixAng).rgb;

  if (uDepthView > 0.0 && uRelief.x > 0.5) {
    // Proche : rouge, 2 hauteurs : jaune, 5 : vert, au loin : bleu ; lignes tous les ~25 %.
    float dist = sceneDist(dir);
    float l = clamp(log(dist / 0.5) / log(40.0), 0.0, 1.0);
    vec3 heat = clamp(vec3(1.5 - 2.0 * l, 1.0 - abs(l - 0.45) * 2.2, 2.0 * l - 0.6), 0.0, 1.0);
    float iso = fract(log(dist) / log(1.25));
    float isoW = max(fwidth(log(dist) / log(1.25)), 1e-4);
    float isoLine = 1.0 - clamp(min(iso, 1.0 - iso) / isoW - 0.5, 0.0, 1.0);
    col = mix(col, heat, 0.45 * uDepthView);
    col = mix(col, vec3(0.0), isoLine * 0.35 * uDepthView);
  }

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
    vec3 h = uHot[i].xyz;
    float alpha = uHot[i].w;
    float ang = acos(clamp(dot(dir, h), -1.0, 1.0));
    float s = uHotSize * (i == uHotSel ? 1.25 : 1.0);
    if (alpha > 0.003 && ang < s * 1.45) {
      float aa = max(pixAng * 1.5, 1e-5);
      float disc = 1.0 - smoothstep(s - aa, s, ang);
      float ring = disc * smoothstep(s * 0.72 - aa, s * 0.72, ang);
      float dot0 = 1.0 - smoothstep(s * 0.22 - aa, s * 0.22, ang);
      vec3 accent = i == uHotSel ? vec3(1.0, 0.62, 0.15) : vec3(0.25, 0.8, 1.0);
      col = mix(col, accent * 0.35, disc * 0.45 * alpha);
      col = mix(col, vec3(1.0), clamp(ring * 0.95 + dot0, 0.0, 1.0) * alpha);
      if (i == uHotSel && uDwell > 0.0) {
        vec3 t1 = normalize(cross(vec3(0.0, 1.0, 0.0), h) + vec3(1e-6, 0.0, 0.0));
        vec3 t2 = cross(h, t1);
        float a = atan(dot(dir, t2), dot(dir, t1)) / (2.0 * PI) + 0.5;
        float arc = step(s * 1.1, ang) * (1.0 - step(s * 1.4, ang)) * step(a, uDwell);
        col = mix(col, accent, arc * alpha);
      }
    }
  }

  if (uReticle > 0.0 && uViewMode == 0) {
    vec2 px = (t0 / uProj.xz) * uVp.zw * 0.5;
    float d = length(px);
    float rr = uReticle;
    float ring = smoothstep(rr * 0.55, rr * 0.7, d) * (1.0 - smoothstep(rr * 0.85, rr, d));
    col = mix(col, vec3(1.0), ring * 0.9);
  }

  outColor = vec4(col * inside + vec3(0.06, 0.07, 0.1) * (1.0 - inside), 1.0);
}`;
