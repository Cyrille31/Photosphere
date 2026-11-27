// Traitements par lot depuis la bibliothèque : redressement automatique et relief (IA) de plusieurs
// photos, sur un rendu hors écran (aucune fenêtre d'édition n'est ouverte).
import * as db from './db.js';
import { PanoRenderer } from './renderer.js';
import { autoLevel } from './autolevel.js';
import { computeDepth } from './depth-ai.js';
import { reliefKey, loadDepthImage } from './depth.js';
import { reliefWithRoomScale } from './room.js';
import { relevelRelief, reliefTiltChange, RELIEF_RECOMPUTE_DEG, level } from './relevel.js';
import { remapHotspot, wrapDeg } from './math.js';
import { DEFAULT_LENS_PARAMS } from './gl-source.js';

const DEFAULT_CAMERA_HEIGHT = 1.6;

async function withRenderer(fn) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  canvas.style.cssText = 'position:fixed;left:-10000px;top:0;width:64px;height:64px';
  document.body.appendChild(canvas);
  const renderer = new PanoRenderer(canvas, { maxHalf: 4096 });
  try {
    return await fn(renderer);
  } finally {
    renderer.dispose();
    canvas.remove();
  }
}

// Photo d'origine chargée dans le rendu, avec ses réglages (redressement, objectifs).
async function loadPhoto(renderer, p) {
  const orig = await db.getBlob(p.id + ':orig');
  if (!orig) throw new Error('image d’origine introuvable');
  const params = { yaw: 0, pitch: 0, roll: 0, ...JSON.parse(JSON.stringify(DEFAULT_LENS_PARAMS)), ...p.params };
  await renderer.load(orig, p.srcType, params);
  return params;
}

// ids : photos à traiter ; onProgress(i, n, nom, détail) ; isCancelled() : arrêt demandé.
// Renvoie [{ id, name, ok, message }].
export async function batchAutoLevel(ids, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const out = [];
  await withRenderer(async (renderer) => {
    for (let i = 0; i < ids.length && !isCancelled(); i++) {
      const p = await db.getPhoto(ids[i]);
      if (!p) continue;
      // Photo déjà redressée (à la main ou automatiquement) : on n'y touche pas. Le cap (nord) seul
      // ne compte pas comme un redressement.
      const pr = p.params || {};
      if (Math.abs(pr.pitch || 0) + Math.abs(pr.roll || 0) > 0.05) {
        out.push({ id: p.id, name: p.name, ok: true, skipped: true, message: 'déjà redressée, ignorée' });
        continue;
      }
      onProgress(i, ids.length, p.name, 'recherche des verticales');
      try {
        const params = await loadPhoto(renderer, p);
        const r = await autoLevel(renderer, params, p.srcType);
        if (!r.ok) {
          out.push({ id: p.id, name: p.name, ok: false, message: r.reason });
        } else if (r.total < 0.05) {
          out.push({ id: p.id, name: p.name, ok: true, message: 'déjà droite' });
        } else {
          const old = { yaw: params.yaw, pitch: params.pitch, roll: params.roll };
          const next = { yaw: wrapDeg(r.level.yaw), pitch: r.level.pitch, roll: r.level.roll };
          // Le relief tourne avec la photo (pas de nouveau calcul).
          let relief = p.relief;
          try {
            relief = await relevelRelief(p.id, p.relief, p.params, { ...p.params, ...next });
          } catch (e) {
            // relief non réutilisable : il faudra le recalculer
          }
          // Liens, coins de la pièce et bouton vidéo restent sur le même point de la scène ; la photo
          // sera reconvertie.
          const rm = (h) => remapHotspot(h, old, next);
          await db.updatePhoto(p.id, (cur) => ({
            ...cur,
            params: { ...cur.params, ...next },
            hotspots: (cur.hotspots || []).map(rm),
            ...(cur.room ? { room: { ...cur.room, corners: (cur.room.corners || []).map(rm), ...(cur.room.floor ? { floor: rm(cur.room.floor) } : {}) } } : {}),
            ...(cur.video ? { video: { ...cur.video, cues: (cur.video.cues || (cur.video.cue ? [cur.video.cue] : [])).map(rm), cue: undefined } } : {}),
            ...(relief ? { relief } : {}),
            status: 'pending',
          }));
          out.push({ id: p.id, name: p.name, ok: true, message: `redressée de ${r.total.toFixed(1)}°` });
        }
      } catch (e) {
        out.push({ id: p.id, name: p.name, ok: false, message: e.message });
      }
    }
  });
  return out;
}

// Relief calé sur la pièce de la photo (voir reliefWithRoomScale), ou null.
async function roomScale(p, depth = null) {
  if (!p.room || p.room.none || !(p.room.corners || []).length) return null;
  if (!depth) {
    const blob = await db.getBlob(p.id + ':depth');
    if (!blob) return null;
    depth = (await loadDepthImage(blob)).depth;
  }
  return reliefWithRoomScale(p, depth, (await db.getPlanDrawing()).ceilingH);
}
const scaleNote = (cal) => (cal ? ` ; distances calées sur la pièce (× ${cal.scale.toFixed(2).replace('.', ',')}, ${Math.round(cal.scaleAgree * 100)} % des points d’accord)` : '');

export async function batchRelief(ids, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const out = [];
  await withRenderer(async (renderer) => {
    for (let i = 0; i < ids.length && !isCancelled(); i++) {
      const p = await db.getPhoto(ids[i]);
      if (!p) continue;
      // Relief à jour (calculé pour ce redressement, ou tourné avec la photo après un redressement de
      // moins d'un degré) : inutile de le refaire.
      if (p.relief && p.relief.kind === 'ai' && p.relief.key === reliefKey(p.params) && reliefTiltChange(p) <= RELIEF_RECOMPUTE_DEG) {
        // Seules les distances sont recalées sur la pièce (si elle est définie).
        const cal = await roomScale(p).catch(() => null);
        if (cal) await db.updatePhoto(p.id, (cur) => ({ ...cur, relief: cal }));
        out.push({ id: p.id, name: p.name, ok: true, skipped: !cal, message: 'relief à jour, ignoré' + scaleNote(cal) });
        continue;
      }
      onProgress(i, ids.length, p.name, 'chargement');
      try {
        const params = await loadPhoto(renderer, p);
        const r = await computeDepth(renderer, (txt) => onProgress(i, ids.length, p.name, txt));
        await db.putBlob(p.id + ':depth', r.png);
        await db.putBlob(p.id + ':depthbg', r.bgImage);
        const relief = { kind: 'ai', h: (p.relief && p.relief.h) || DEFAULT_CAMERA_HEIGHT, key: reliefKey(params), floor: r.floorOk, basis: level(params) };
        const cal = await roomScale({ ...p, relief }, r.depth).catch(() => null);
        await db.updatePhoto(p.id, (cur) => ({ ...cur, relief: cal || relief }));
        out.push({ id: p.id, name: p.name, ok: true, message: (r.floorOk || cal ? 'relief calculé' : 'relief calculé (sol peu visible : échelle approximative)') + scaleNote(cal) });
      } catch (e) {
        out.push({ id: p.id, name: p.name, ok: false, message: e.message });
        // Moteur ou modèle indisponible (pas de connexion…) : inutile d'insister photo par photo.
        if (/téléchargement|moteur|modèle|fetch|import/i.test(e.message)) break;
      }
    }
  });
  return out;
}
