// Relief et redressement : quand le redressement d'une photo change, sa carte de relief (et le fond
// reconstitué) tournent avec elle au lieu d'être abandonnés — les distances, elles, ne changent pas.
import * as db from './db.js';
import { reliefKey, relevelEquirectBlob } from './depth.js';
import { levelMatrix, DEG } from './math.js';

export const level = (p) => ({ yaw: (p && p.yaw) || 0, pitch: (p && p.pitch) || 0, roll: (p && p.roll) || 0 });

// Redressement (en degrés) intervenu depuis le calcul du relief (relief.basis : redressement d'alors).
// Un changement de nord seul ne compte pas. L'IA voit mieux une scène droite : au-delà d'un degré, un
// nouveau calcul serait un peu meilleur.
export function reliefTiltChange(photo) {
  const r = photo && photo.relief;
  if (!r || r.kind !== 'ai' || !r.basis) return 0;
  const up = (l) => {
    const m = levelMatrix(l.yaw, l.pitch, l.roll);
    return [m[1], m[4], m[7]];
  };
  const a = up(level(r.basis)), b = up(level(photo.params));
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / DEG;
}
export const RELIEF_RECOMPUTE_DEG = 1;

// relief : celui de la photo (calculé pour oldParams). Renvoie le relief à enregistrer avec newParams
// (inchangé s'il n'était déjà plus valable, ou si le redressement n'a pas changé).
export async function relevelRelief(id, relief, oldParams, newParams) {
  if (!relief || relief.kind !== 'ai' || relief.key !== reliefKey(oldParams)) return relief;
  if (reliefKey(newParams) === relief.key) return relief;
  const depth = await db.getBlob(id + ':depth');
  if (!depth) return relief;
  const o = level(oldParams), n = level(newParams);
  const bg = await db.getBlob(id + ':depthbg');
  const nd = await relevelEquirectBlob(depth, o, n, 'image/png');
  const nb = bg ? await relevelEquirectBlob(bg, o, n, 'image/jpeg') : null;
  await db.putBlob(id + ':depth', nd);
  if (nb) await db.putBlob(id + ':depthbg', nb);
  // basis : redressement au moment du calcul (pour conseiller un nouveau calcul après un fort redressement).
  return { ...relief, key: reliefKey(newParams), basis: relief.basis || o };
}
