// Cartes de relief rangées avec les photos d'origine (dossier de travail, dossier partagé) : un
// sous-dossier « photosphere-relief » avec, pour chaque photo, sa carte de profondeur et les couleurs
// du fond reconstitué. Un parcours partagé les retrouve ainsi sans rien recalculer.
export const RELIEF_DIR = 'photosphere-relief';

// Fichier « _headers » rangé avec le parcours : sur un hébergement web (Cloudflare Pages, Netlify), il
// autorise PhotoSphère à lire les fichiers du parcours depuis son adresse (en-tête CORS).
export const HEADERS_FILE = '_headers';
export const HEADERS_CONTENT = '/*\n  Access-Control-Allow-Origin: *\n';

// poster : pour une vidéo, l'image affichée avant son lancement (une photosphère comme les autres).
export const reliefNames = (fileName) => ({ depth: `${fileName}.profondeur.png`, bg: `${fileName}.fond.jpg`, poster: `${fileName}.affiche.jpg` });

// Fichiers rangés dans « photosphere-relief » (motif de leur nom).
export const RELIEF_FILE_RE = /\.(profondeur\.png|fond\.jpe?g|affiche\.jpe?g)$/i;

// Fichier de relief ou affiche de vidéo (à ne pas importer comme une photo).
export function isReliefFile(f) {
  const path = (f.webkitRelativePath || f.name || '').split('/');
  return path.includes(RELIEF_DIR) || RELIEF_FILE_RE.test(f.name || '');
}
