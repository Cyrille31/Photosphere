// Cartes de relief rangées avec les photos d'origine (dossier de travail, dossier partagé) : un
// sous-dossier « photosphere-relief » avec, pour chaque photo, sa carte de profondeur et les couleurs
// du fond reconstitué. Un parcours partagé les retrouve ainsi sans rien recalculer.
export const RELIEF_DIR = 'photosphere-relief';

// Fichier « _headers » rangé avec le parcours : sur un hébergement web (Cloudflare Pages, Netlify), il
// autorise PhotoSphère à lire les fichiers du parcours depuis son adresse (en-tête CORS).
export const HEADERS_FILE = '_headers';
export const HEADERS_CONTENT = '/*\n  Access-Control-Allow-Origin: *\n';

export const reliefNames = (fileName) => ({ depth: `${fileName}.profondeur.png`, bg: `${fileName}.fond.jpg` });

// Fichier de relief (à ne pas importer comme une photo).
export function isReliefFile(f) {
  const path = (f.webkitRelativePath || f.name || '').split('/');
  return path.includes(RELIEF_DIR) || /\.(profondeur\.png|fond\.jpe?g)$/i.test(f.name || '');
}
