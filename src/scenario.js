// Scénarios de visite : un déplacement enregistré dans la visionneuse (photos parcourues et direction du
// regard au fil du temps), rejoué tel quel, puis on continue librement.
// Format (rangé dans le plan, donc dans photosphere.json, et transmissible dans un lien) :
//   { name, files: [nom de fichier…], steps: [[t (dixièmes de s), n° de fichier, cap ×10, site ×10]…] }
// Les photos sont désignées par leur nom de fichier : le scénario se rejoue aussi dans un parcours partagé.

export const scenarioFileKey = (n) => String(n || '').toLowerCase();
const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

// Enregistreur : sample(t en s, fichier, cap, site en degrés) à chaque image ; finish() → scénario.
export function createRecorder() {
  const files = [], steps = [];
  let last = null;
  const fileIndex = (f) => {
    let i = files.indexOf(f);
    if (i < 0) i = files.push(f) - 1;
    return i;
  };
  const push = (t, fi, y, p) => {
    steps.push([Math.round(t * 10), fi, Math.round(wrapDeg(y) * 10), Math.round(p * 10)]);
    last = { t, fi, y, p };
  };
  return {
    sample(t, file, yaw, pitch) {
      if (!file) return;
      const fi = fileIndex(file);
      if (!last || fi !== last.fi) return push(t, fi, yaw, pitch);
      const moved = Math.abs(wrapDeg(yaw - last.y)) > 0.6 || Math.abs(pitch - last.p) > 0.6;
      if (!moved || t - last.t < 0.1) return;
      // Reprise après une pause : la vue est restée immobile jusqu'ici (pas un lent glissement).
      if (t - last.t > 0.3) push(t - 0.1, fi, last.y, last.p);
      push(t, fi, yaw, pitch);
    },
    finish(name, t) {
      if (last && t - last.t > 0.1) push(t, last.fi, last.y, last.p);
      return { name, files: files.slice(), steps: steps.slice() };
    },
    get duration() {
      return last ? last.t : 0;
    },
  };
}

export const scenarioDuration = (s) => (s && s.steps && s.steps.length ? s.steps[s.steps.length - 1][0] / 10 : 0);

// Position dans le scénario à l'instant t (s) : { file, yaw, pitch, index } ; la vue est interpolée
// entre deux instants d'une même photo (cap par le plus court chemin).
export function scenarioAt(s, t) {
  const st = s.steps;
  const tt = t * 10;
  let i = 0;
  while (i + 1 < st.length && st[i + 1][0] <= tt) i++;
  const a = st[i], b = st[i + 1];
  let yaw = a[2] / 10, pitch = a[3] / 10;
  if (b && b[1] === a[1] && b[0] > a[0]) {
    const k = Math.min(1, Math.max(0, (tt - a[0]) / (b[0] - a[0])));
    yaw = wrapDeg(yaw + wrapDeg(b[2] / 10 - yaw) * k);
    pitch += (b[3] / 10 - pitch) * k;
  }
  return { file: s.files[a[1]], yaw, pitch, index: i };
}

// Garde les étapes dont la photo est disponible (has(nom de fichier)).
export function scenarioFor(s, has) {
  if (!s || !Array.isArray(s.files) || !Array.isArray(s.steps)) return null;
  const steps = s.steps.filter((x) => Array.isArray(x) && x.length >= 4 && s.files[x[1]] && has(s.files[x[1]]));
  return steps.length ? { ...s, steps } : null;
}

// Scénario → texte court pour un lien (JSON compressé, base64 « URL »), et inversement.
const scnB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const scnUnB64 = (t) => {
  const s = atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
async function scnPipe(u8, stream) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
}
export async function encodeScenario(s) {
  const json = new TextEncoder().encode(JSON.stringify({ n: s.name, f: s.files, s: s.steps }));
  if (typeof CompressionStream === 'undefined') return 'j' + scnB64(json);
  return 'z' + scnB64(await scnPipe(json, new CompressionStream('deflate-raw')));
}
export async function decodeScenario(text) {
  const t = String(text || '');
  const raw = scnUnB64(t.slice(1));
  const bytes = t[0] === 'z' ? await scnPipe(raw, new DecompressionStream('deflate-raw')) : raw;
  const o = JSON.parse(new TextDecoder().decode(bytes));
  return { name: String(o.n || 'Scénario'), files: o.f, steps: o.s };
}
