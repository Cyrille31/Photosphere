// Cartes de relief rangées avec les photos d'origine (dossier de travail, dossier partagé) : un
// sous-dossier « photosphere-relief » avec, pour chaque photo, sa carte de profondeur et les couleurs
// du fond reconstitué. Un parcours partagé les retrouve ainsi sans rien recalculer.
export const RELIEF_DIR = 'photosphere-relief';

export const reliefNames = (fileName) => ({ depth: `${fileName}.profondeur.png`, bg: `${fileName}.fond.jpg` });

// Fichier de relief (à ne pas importer comme une photo).
export function isReliefFile(f) {
  const path = (f.webkitRelativePath || f.name || '').split('/');
  return path.includes(RELIEF_DIR) || /\.(profondeur\.png|fond\.jpe?g)$/i.test(f.name || '');
}
