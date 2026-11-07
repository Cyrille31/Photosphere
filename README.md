<p align="center"><img src="assets/logo.svg" width="128" alt="Logo PhotoSphère"></p>

# PhotoSphère

Traitement et organisation de photosphères, pensé pour la **Samsung Gear 360**.
Application web installable (PWA) qui fonctionne sur ordinateur comme sur smartphone, hors connexion, sans aucune dépendance.

## Fonctions

- **Import** depuis la carte micro SD (fichiers ou dossier `DCIM/100PHOTO`, glisser-déposer), ou depuis la galerie du téléphone.
- **Conversion** en équirectangulaire **7776 × 3888**, ou **7200 × 3600** comme le logiciel Samsung (réglable) :
  - les photos brutes **double fisheye** de la Gear 360 (2016 : 7776 × 3888, 2017 : 5472 × 2736) sont détectées et assemblées, avec la même orientation que le logiciel Samsung ;
  - **calibrage automatique** de chaque photo : alignement des deux objectifs sur la zone de recouvrement, **correction du vignettage** (bords des objectifs plus sombres, profil mesuré sur la Gear 360 et cohérent avec le logiciel Samsung, sans saturer le ciel), **égalisation de l’exposition** le long de la couture, **correction de parallaxe** le long de la couture (les objets proches, vus sous un angle légèrement différent par chaque objectif, sont recalés) et **couture optimale** qui passe là où les deux images concordent. Réglages manuels possibles dans l’éditeur ;
  - les photos déjà assemblées (application Samsung) sont remises à la bonne taille ;
  - le JPEG produit contient les métadonnées **XMP GPano** (reconnu comme photosphère par Google Photos, Facebook, les visionneuses VR…) et conserve l’EXIF d’origine (date, GPS).
- **Redressement** des photos prises de travers : curseurs de bascule avant/arrière et gauche/droite **relatifs à la vue affichée**, cap (rotation horizontale qui ne modifie pas le redressement), ou outils automatiques en cliquant **2 points de l’horizon** ou **1 à 2 lignes verticales**. Grille et vue à plat pour vérifier.
- **Nord** : points cardinaux sur l'horizon de l'éditeur ; « Indiquer le nord » puis un clic dans l'image règle le cap.
- **Défaire** (bouton ou Ctrl+Z) la dernière action de l'éditeur ; renommage des photos directement dans la bibliothèque.
- **Liens** entre photos : on touche l’endroit (porte, passage) qui mène à une autre photo ; lien retour créé automatiquement.
- **Visionneuse** (bouton ✏ Éditer pour redresser la photo affichée ou y ajouter un lien, puis revenir au même endroit) :
  - *Tactile* : doigt / souris, pincer ou molette pour zoomer ;
  - *Bout de bras* : on bouge le téléphone (gyroscope) ;
  - *Casque VR* : écran partagé avec correction des lentilles pour casques type Cardboard ; on fixe un lien 1,5 s pour y aller (ou bouton du casque) ;
  - *WebXR* natif quand le navigateur le propose.
- **Fichier de réglages** `photosphere.json` (≈ 11 ko par photo) : à ranger avec les photos d'origine, jamais modifiées. En réimportant le dossier (ou les photos avec ce fichier), redressement, nord, calibrage, liens et noms sont retrouvés.
- **Exports** : visite autonome en un seul fichier `.html` (s’ouvre partout, même en local), ZIP des JPEG, sauvegarde/restauration du projet pour passer du PC au téléphone.

## Et le Bluetooth ?

La Gear 360 n’utilise le Bluetooth que pour l’appairage et la télécommande : les photos passent ensuite par **Wi-Fi Direct** avec un protocole propriétaire Samsung, inaccessible depuis un navigateur. Deux solutions : la carte micro SD (meilleure qualité), ou transférer avec l’application Samsung Gear 360 puis importer depuis la galerie.

## Utilisation

Publication automatique sur GitHub Pages à chaque push sur `main` (activer *Settings → Pages → Source : GitHub Actions*). Sur le téléphone, ouvrir le site puis « Ajouter à l’écran d’accueil ».

En local :

```sh
npm start            # http://localhost:8080/
npm test             # tests unitaires (maths, JPEG, ZIP, EXIF/XMP)
npm run test:browser # test de bout en bout dans Chromium (nécessite playwright)
```

Le gyroscope et WebXR exigent une page servie en HTTPS (ou `localhost`).

## Architecture

| Fichier | Rôle |
| --- | --- |
| `src/app.js`, `src/ui.js` | Bibliothèque, file de conversion, navigation |
| `src/importer.js` | Import, détection fisheye / équirectangulaire |
| `src/calibrate.js` | Calibrage automatique : objectifs, exposition, tracé de la couture |
| `src/exporter.js`, `src/jpeg-encoder.js`, `src/jpeg-worker.js` | Rendu WebGL par tuiles et encodage JPEG par bandes (pas de canvas géant : compatible iPhone) |
| `src/shaders.js`, `src/gl-source.js` | Projection fisheye → équirectangulaire, redressement, rendu de la vue |
| `src/renderer.js`, `src/controls.js`, `src/player.js` | Visionneuse (perspective, plat, stéréo, WebXR, gyroscope, liens) |
| `src/editor.js` | Redressement, calibrage, liens |
| `src/math.js` | Rotations, orientation du téléphone, calculs d’horizon/verticales |
| `src/metadata.js`, `src/zip.js`, `src/tour-export.js`, `src/db.js` | EXIF/XMP, ZIP, exports, stockage IndexedDB |
