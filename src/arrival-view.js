// Réglage de la vue d'arrivée d'un lien : on oriente un aperçu de la photo de destination comme on
// veut la découvrir en y arrivant (par exemple : comme si l'on entrait par la porte).
import * as db from './db.js';
import { PanoRenderer } from './renderer.js';
import { ViewController } from './controls.js';
import { DEG } from './math.js';
import { dialog, escapeHtml } from './ui.js';

// initial : { yaw, pitch } en degrés. Renvoie la vue choisie, ou null si l'on annule.
export async function chooseArrivalView(photoId, initial) {
  const photo = await db.getPhoto(photoId);
  if (!photo) return null;
  const out = photo.status === 'done' ? await db.getBlob(photo.id + ':out') : null;
  const blob = out || (await db.getBlob(photo.id + ':orig'));
  return new Promise((resolve) => {
    let result = null;
    let renderer = null, controller = null, raf = 0;
    const d = dialog(
      `<h2>Vue à l’arrivée dans « ${escapeHtml(photo.name)} »</h2>
      <p class="note">Faites tourner l’image pour qu’elle soit orientée comme on doit la découvrir en arrivant par ce lien (par exemple dans l’axe de la porte franchie), puis validez.</p>
      <div class="arrival-stage"><canvas></canvas><div class="arrival-cross"></div></div>
      <div class="row"><button class="btn" data-close>Annuler</button><button class="btn primary" data-ok>Valider cette vue</button></div>`,
      (dlg) => {
        dlg.classList.add('arrival');
        const canvas = dlg.querySelector('canvas');
        renderer = new PanoRenderer(canvas, { maxHalf: 2048 });
        const draw = () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            renderer.draw({ ...controller.frame(), hotSel: -1 });
          });
        };
        controller = new ViewController(canvas, renderer, { onChange: draw });
        controller.fov = 80;
        controller.yaw = (initial.yaw || 0) * DEG;
        controller.pitch = (initial.pitch || 0) * DEG;
        renderer.load(blob, out ? 'equirect' : photo.srcType, out ? {} : photo.params).then(draw);
        dlg.querySelector('[data-ok]').addEventListener('click', () => {
          result = { yaw: +((controller.yaw / DEG + 540) % 360 - 180).toFixed(2), pitch: +(controller.pitch / DEG).toFixed(2) };
          dlg.close();
        });
      }
    );
    d.addEventListener('close', () => {
      cancelAnimationFrame(raf);
      if (controller) controller.dispose();
      if (renderer) renderer.dispose();
      resolve(result);
    });
  });
}
