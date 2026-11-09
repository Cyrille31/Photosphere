// Choix d'une photo dans une grille de vignettes (taille réglable : curseur, ou Ctrl + molette).
import * as db from './db.js';
import { dialog, escapeHtml } from './ui.js';

const SIZE_KEY = 'ps-picker-size';
const MIN = 90, MAX = 420;

function readSize() {
  try {
    return Math.min(MAX, Math.max(MIN, +localStorage.getItem(SIZE_KEY) || 180));
  } catch (e) {
    return 180;
  }
}

function saveSize(v) {
  try {
    localStorage.setItem(SIZE_KEY, String(v));
  } catch (e) {
    // préférence non mémorisée
  }
}

// Renvoie l'identifiant de la photo choisie, ou null si l'on ferme sans choisir.
export function pickPhoto(photos, { title = 'Choisir une photo', currentId = null } = {}) {
  return new Promise((resolve) => {
    let chosen = null;
    let size = readSize();
    const urls = [];
    const d = dialog(
      `<h2>${escapeHtml(title)}</h2>
      <div class="picker-bar">
        <label>Taille des vignettes <input type="range" name="size" min="${MIN}" max="${MAX}" step="10" value="${size}"></label>
        <span class="note">ou Ctrl + molette</span>
      </div>
      <div class="picker-grid" style="--thumb:${size}px">${photos
        .map(
          (p) => `<button class="picker-item${p.id === currentId ? ' current' : ''}" data-id="${p.id}" title="${escapeHtml(p.name)}">
            <img alt=""><span>${escapeHtml(p.name)}</span></button>`
        )
        .join('')}</div>
      <div class="row"><button class="btn" data-close>Annuler</button></div>`,
      (dlg) => {
        dlg.classList.add('picker');
        const grid = dlg.querySelector('.picker-grid');
        const range = dlg.querySelector('[name=size]');
        const apply = (v) => {
          size = Math.round(Math.min(MAX, Math.max(MIN, v)));
          grid.style.setProperty('--thumb', size + 'px');
          range.value = size;
          saveSize(size);
        };
        range.addEventListener('input', () => apply(+range.value));
        dlg.addEventListener(
          'wheel',
          (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            apply(size * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
          },
          { passive: false }
        );
        dlg.querySelectorAll('.picker-item').forEach((b) =>
          b.addEventListener('click', () => {
            chosen = b.dataset.id;
            dlg.close();
          })
        );
        dlg.querySelectorAll('.picker-item').forEach(async (b) => {
          const blob = await db.getBlob(b.dataset.id + ':thumb');
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          b.querySelector('img').src = url;
        });
      }
    );
    d.addEventListener('close', () => {
      setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1000);
      resolve(chosen);
    });
  });
}
