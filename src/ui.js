// Petits composants d'interface partagés.

export function toast(msg, isError = false, ms = 4000) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' err' : '');
  t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function dialog(html, setup) {
  const d = document.createElement('dialog');
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  if (setup) setup(d);
  d.showModal();
  return d;
}
