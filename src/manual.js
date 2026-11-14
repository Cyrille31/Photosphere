// Manuel utilisateur : toutes les explications détaillées, à un seul endroit. Les panneaux de
// l'application n'en gardent qu'une ligne et un bouton « 📖 » qui ouvre la bonne section.
import { dialog } from './ui.js';

const SECTIONS = [
  ['demarrer', 'Démarrer'],
  ['bibliotheque', 'Bibliothèque et traitements par lot'],
  ['redresser', 'Redresser une photo'],
  ['objectifs', 'Objectifs (assemblage)'],
  ['liens', 'Liens entre photos'],
  ['relief', 'Relief (effet 3D dans le casque)'],
  ['visionneuse', 'Visionneuse et casque VR'],
  ['plan', 'Plan'],
  ['piece', 'Plan des pièces'],
  ['parcours', 'Parcours partagé'],
  ['exporter', 'Exporter, conserver, transférer'],
  ['raccourcis', 'Raccourcis'],
];

const MANUAL = `
<section id="man-demarrer"><h3>Démarrer</h3>
<ul>
  <li><b>Importer</b> : bouton « Importer » (photos), « Dossier » (tout un dossier, par exemple <code>DCIM</code> de la carte micro SD de la Gear 360) ou glisser-déposer. Les doubles fisheye de la Gear 360 sont détectés et assemblés automatiquement en équirectangulaire (7776 × 3888 par défaut, 7200 × 3600 comme Samsung dans ⚙ Réglages), avec les métadonnées « photosphère » lues par Google Photos, Facebook ou les visionneuses VR.</li>
  <li>La caméra ne transfère pas ses photos en Bluetooth : passez par la carte micro SD (lecteur USB-C sur le téléphone, ou PC).</li>
  <li><b>Dossier de travail</b> (Chrome / Edge sur PC) : PhotoSphère lit vos photos d’origine dans un dossier, sans jamais les modifier, et y enregistre automatiquement le fichier de réglages <code>photosphere.json</code>.</li>
  <li>Sur smartphone, ajoutez PhotoSphère à l’écran d’accueil : plein écran et utilisation hors connexion. Les photos restent sur l’appareil.</li>
</ul></section>

<section id="man-bibliotheque"><h3>Bibliothèque et traitements par lot</h3>
<ul>
  <li>Cliquez le nom d’une photo pour la <b>renommer</b> ; la recherche ignore majuscules et accents.</li>
  <li><b>Sélection</b> : cochez la case en haut à droite des vignettes ; <b>Maj + clic</b> sur une autre case (ou vignette) sélectionne toutes les photos entre les deux ; <b>Ctrl + clic</b> sur une vignette la coche ou la décoche sans l’ouvrir ; « ☑ Tout sélectionner » prend les photos affichées par la recherche. Avec une sélection :
    <ul>
      <li><b>✨ Redresser (auto)</b> : redressement automatique d’après les verticales (murs, portes, meubles) de chaque photo ; refusé au-delà de 15° (verticales peu fiables). Les photos déjà redressées (bascules non nulles, à la main ou automatiquement) sont ignorées ; le cap (nord) seul ne compte pas. Les photos corrigées sont ensuite reconverties.</li>
      <li><b>🧠 Calculer le relief</b> : carte de profondeur par IA pour le casque (voir <a href="#man-relief">Relief</a>). Faites-le après le redressement.</li>
      <li><b>🗑 Supprimer</b>.</li>
    </ul>
    Un bilan liste chaque photo traitée ; « Arrêter » interrompt après la photo en cours.</li>
  <li>Les badges indiquent l’état : conversion, liens (🔗), relief calculé (🧊).</li>
</ul></section>

<section id="man-redresser"><h3>Redresser une photo</h3>
<p>Une photo prise caméra penchée a un horizon ondulé et des verticales obliques. Objectif : ligne orange (horizon) plate et verticales droites ; vérifiez avec la grille et la vue à plat.</p>
<ul>
  <li><b>✨ Auto (verticales)</b> : PhotoSphère repère les bords verticaux des murs, portes et meubles et redresse la photo. Fonctionne en intérieur ; refusé au-delà de 15°.</li>
  <li><b>📏 Horizon : 2 points</b> : cliquez deux points de l’horizon réel (mer, plaine), si possible éloignés d’environ 90°.</li>
  <li><b>📐 Verticales</b> : cliquez le haut puis le bas d’un élément vertical (angle de mur, poteau, encadrement), puis d’un second, de préférence dans une autre direction. Avec une seule ligne, « Appliquer ».</li>
  <li><b>Bascules</b> : avant / arrière et gauche / droite <i>par rapport au centre de la vue affichée</i>. Tournez la vue vers un mur, basculez jusqu’à ce que ses verticales soient droites.</li>
  <li><b>Nord / cap</b> : la caméra n’a pas de boussole. « 🧭 Indiquer le nord » puis touchez sa direction dans l’image ; le « N » rouge s’y place, le curseur de cap affine. Avec le même nord sur toutes les photos, la direction est conservée en passant de l’une à l’autre, et le plan est juste.</li>
  <li><b>↶ Défaire</b> (Ctrl + Z) annule la dernière action.</li>
</ul></section>

<section id="man-objectifs"><h3>Objectifs (assemblage)</h3>
<p>Le calibrage automatique est fait à l’import : il aligne les deux objectifs sur la couture et égalise leur exposition. Relancez « 🎯 Calibrage automatique » après une modification. Si la couture reste visible, ajustez à la main le rayon et la rotation de chaque objectif. Les objets très proches de la caméra (la main) restent légèrement dédoublés : c’est la parallaxe entre les deux objectifs. « ⭐ Calibrage par défaut » mémorise les valeurs pour les prochains imports de cet appareil.</p></section>

<section id="man-liens"><h3>Liens entre photos</h3>
<ul>
  <li>Un lien est une pastille que l’on touche (ou que l’on fixe du regard dans le casque) pour passer à une autre photo. Dans la visionneuse, elle n’apparaît qu’à l’approche de la souris ou du regard ; la souris devient une flèche qui montre le lien le plus proche.</li>
  <li><b>➕ Ajouter un lien</b>, touchez l’endroit (porte, couloir…), choisissez la photo dans les vignettes (Ctrl + molette : taille ; recherche par nom). Le lien retour peut être créé dans l’autre photo.</li>
  <li><b>Cliquez un lien sur l’image</b> : il est sélectionné (orange) et la liste défile pour l’afficher en haut.</li>
  <li><b>Ctrl + glisser</b> un lien sur l’image le déplace. Sur smartphone : « ✥ Déplacer » puis touchez le nouvel endroit.</li>
  <li><b>🎯 Vue d’arrivée</b> : orientation de la photo d’arrivée. Par défaut, on arrive dos au lien qui ramène d’où l’on vient (comme en franchissant une porte).</li>
  <li><b>↩ Lien retour</b> : ouvre la photo de destination pour placer le lien qui revient ici (par exemple sur la porte vue depuis la pièce).</li>
  <li><b>Direction d’après le plan</b> : un lien « automatique » suit la position des photos sur le plan ; déplacé à la main, il ne la suit plus.</li>
</ul></section>

<section id="man-relief"><h3>Relief (effet 3D dans le casque)</h3>
<ul>
  <li>Dans le casque, chaque œil voit la photo d’un point légèrement différent. Une intelligence artificielle (Depth Anything V2, exécutée dans le navigateur, sans envoi de la photo) estime la distance de chaque point : murs, sol, plafond, meubles, personnes.</li>
  <li><b>Calcul</b> : onglet « Relief » de l’éditeur, ou par lot depuis la bibliothèque. La première fois, le modèle (27 à 50 Mo) est téléchargé puis gardé par le navigateur. Quelques secondes avec une carte graphique récente (WebGPU), jusqu’à une minute ou deux sinon. À refaire si le redressement change.</li>
  <li><b>Vérifier</b> : « Colorer selon la distance » — rouge proche, jaune moyen, vert loin, bleu très loin.</li>
  <li><b>Hauteur de l’objectif</b> : l’échelle des distances est déduite du sol ; plus la hauteur indiquée est faible, plus le relief est marqué. Si le sol est peu visible, l’échelle est approximative.</li>
  <li><b>Confort</b> : ce que vous regardez est placé sans décalage entre les yeux (comme quand les yeux convergent) et l’écart entre les deux images est limité. Autour des personnes et objets proches, le fond est prolongé plutôt que d’étirer l’objet. Intensité : ⚙ du casque, « Relief ».</li>
</ul></section>

<section id="man-visionneuse"><h3>Visionneuse et casque VR</h3>
<ul>
  <li><b>👆 Tactile</b> : doigt ou souris (molette : zoom). <b>📱 Bout de bras</b> : bougez le téléphone. <b>🥽 Casque</b> : écran partagé pour casque type Cardboard ; fixez un lien 1,5 s pour y aller, ou appuyez sur le bouton du casque. <b>WebXR</b> si le navigateur le permet.</li>
  <li><b>Réglages du casque</b> (⚙) : champ de vision ; correction des lentilles k1 / k2 (préréglages Cardboard v1 / v2, RAZ) — les lignes droites doivent rester droites jusqu’au bord ; écartement des centres des deux images — chaque œil doit voir le point de visée au centre de sa lentille ; intensité du relief.</li>
  <li>« ✏ Éditer » ouvre l’éditeur sur la photo affichée ; ☰ : liste des photos avec recherche.</li>
</ul></section>

<section id="man-plan"><h3>Plan</h3>
<ul>
  <li>Nord en haut. Photos en sphères (Ctrl + glisser : les faire tourner) ou en rectangles ; chaque lien part de son point de contact dans la photo, que l’on peut faire glisser.</li>
  <li><b>Un clic sur une photo</b> l’affiche en grand (×8 par défaut, réglable avec « 🔍 × » dans la barre du plan), avec son nom modifiable (Entrée pour valider, Échap pour annuler) ; elle reprend sa taille dès qu’on la déplace, ou par un clic dans le vide ou Échap.</li>
  <li><b>Supprimer un lien</b> : cliquez son trait (ou son point de contact) ; il passe en rouge et la barre propose de le supprimer dans les deux sens ou dans un seul. Touche Suppr : les deux sens. Les photos restent à leur place sur le plan.</li>
  <li><b>Relier</b> : « 🔗 Relier » ou déposer une photo sur une autre crée deux liens automatiques réciproques ; déplacer une photo réoriente ces liens. Double-clic : voir la photo.</li>
  <li><b>Photos non placées</b> : elles attendent dans une zone à part. Glissez-en une n’importe où sur le plan pour la placer (sans lien, à relier plus tard), ou sur une photo pour les relier. Ramenée dans la zone, une photo placée sans lien en ressort du plan.</li>
  <li><b>Dessin</b> (fond blanc) :
    <ul>
      <li><b>✏ Traits</b> : un clic par angle de mur ; double-clic ou Échap pour finir. Accroches aux extrémités et à l’horizontale / verticale (Alt : sans accroche). <b>Glissez un trait ou une extrémité</b> pour le déplacer : les murs raccordés suivent.</li>
      <li><b>✥ Déplacer</b> : déplacer des traits, extrémités et textes sans risque d’en tracer de nouveaux.</li>
      <li><b>T Texte</b> : un clic pour écrire (nom de pièce), clic sur un texte pour le modifier (vide = supprimé), glisser pour le déplacer ; quatre tailles.</li>
      <li><b>⌫ Effacer</b> un trait ou un texte ; <b>↶ Défaire</b> (Ctrl + Z).</li>
    </ul></li>
</ul></section>

<section id="man-piece"><h3>Plan des pièces</h3>
<p>PhotoSphère dessine chaque pièce (rectangulaire) sur le plan, y place ses photos à leur vraie position et les relie, d’après les <b>coins du plafond</b> : ils restent visibles même dans une pièce encombrée.</p>
<ul>
  <li><b>Nord</b> : réglez-le d’abord sur chaque photo (onglet Redresser) : c’est lui qui permet d’aligner les photos d’une même pièce.</li>
  <li><b>Éditeur, onglet « Pièce »</b> : donnez le nom de la pièce (le même pour toutes ses photos ; il est proposé d’après le nom de la photo), puis <b>« 📐 Cliquer les 4 coins du plafond »</b> (là où deux murs rencontrent le plafond, en tournant la vue), ou <b>« ✨ Détecter »</b> pour une proposition automatique. La ligne rouge en pointillés relie les coins : elle doit suivre la jonction plafond / mur ; faites glisser un coin (seul) pour le corriger. Le plan utilise le rectangle le plus proche des 4 coins.</li>
  <li><b>Hauteurs</b> : la hauteur sous plafond est commune à toutes les pièces (réglable aussi sur le plan). La hauteur de l’appareil se donne à la main, ou d’un clic sur un <b>coin au sol</b> (le pied d’un angle de mur) : la ligne bleue montre alors la jonction sol / mur prévue.</li>
  <li><b>Plan, « 🏠 Placer les pièces »</b> : chaque pièce est dessinée (murs et nom avec ses dimensions), ses photos y sont placées et reliées entre elles (liens automatiques). Relancé après une correction, il remplace les murs de la pièce. Une pièce dont une photo est déjà placée s’y raccroche ; sinon elle se met à droite. Reliez ensuite les photos d’une pièce à l’autre.</li>
  <li><b>Retoucher une pièce</b> : cliquez un de ses murs (outil ✋ Photos). Glissez son contour pour la déplacer (ses photos suivent), une poignée carrée pour changer sa taille, la poignée ronde pour la tourner (Maj : par pas de 15°). <b>Tourner une pièce corrige le nord de ses photos</b> (utile quand le nord indiqué dans les photos n’était pas fiable) ; elles sont ensuite reconverties.</li>
  <li><b>Flèche nord-sud</b> : sur le plan, glissez son centre pour la déplacer et sa pointe N pour l’orienter (Maj : pas de 15°). Les directions des liens automatiques se calculent par rapport à elle.</li>
</ul></section>

<section id="man-parcours"><h3>Parcours partagé</h3>
<p>Pour faire visiter vos photos sans exporter de gros fichier : on partage le <b>dossier des photos d’origine</b> et la personne le visualise avec PhotoSphère, sur smartphone, PC ou casque.</p>
<ul>
  <li><b>Préparer (sur PC)</b> : le dossier doit contenir les photos d’origine, <code>photosphere.json</code> et, pour le relief, le sous-dossier <code>photosphere-relief</code>. Avec le <b>dossier de travail</b>, PhotoSphère les y range tout seul. Sinon : « ⬇ Exporter → 📦 Parcours à partager », puis décompressez le ZIP dans le dossier des photos.</li>
  <li><b>Visualiser</b> : « 🔗 Parcours partagé » dans la bibliothèque, puis « Choisir le dossier » (PC) ou « Choisir les fichiers » (smartphone : sélectionnez toutes les photos, <code>photosphere.json</code> et le contenu de <code>photosphere-relief</code> ; l’application OneDrive ou Google Drive apparaît dans le sélecteur).</li>
  <li><b>Rapide</b> : la visite s’ouvre tout de suite sur la première photo ; pendant qu’on regarde, les photos liées se chargent en arrière-plan.</li>
  <li><b>Haute définition</b> : les photos d’origine sont assemblées en direct, à pleine résolution (utile dans un casque).</li>
  <li><b>Rien n’est conservé</b> : les photos restent en mémoire le temps de la visite et sont oubliées en sortant ; elles ne sont pas ajoutées à la bibliothèque.</li>
  <li><b>Par Google Drive, avec un simple lien</b> : mettez le dossier du parcours sur Google Drive, partagez-le en « Tous les utilisateurs qui ont le lien » (lecteur), collez son lien dans « 🔗 Parcours partagé » : PhotoSphère fabrique le <b>lien de visite</b> à envoyer (📋 Copier). Le visiteur l’ouvre sur son smartphone : la visite démarre, sans compte ni connexion.</li>
</ul></section>

<section id="man-exporter"><h3>Exporter, conserver, transférer</h3>
<ul>
  <li><b>Visite autonome</b> (.html) : un seul fichier à partager, qui s’ouvre sur smartphone, PC ou casque, relief compris.</li>
  <li><b>JPEG (ZIP)</b> : les photos converties, avec métadonnées photosphère.</li>
  <li><b>Réglages</b> (<code>photosphere.json</code>) : fichier léger (redressement, nord, calibrage, liens, noms, plan). Rangez-le avec vos photos d’origine, jamais modifiées ; en réimportant le dossier, tout est retrouvé. Le relief, lui, est à recalculer.</li>
  <li><b>Sauvegarde du projet</b> (ZIP) : tout, photos et reliefs compris, pour passer du PC au téléphone (« ♻ Restaurer »).</li>
</ul></section>

<section id="man-raccourcis"><h3>Raccourcis</h3>
<table class="man-keys">
  <tr><td>← / →</td><td>Photo précédente / suivante (visionneuse et éditeur)</td></tr>
  <tr><td>Ctrl + Z</td><td>Défaire (éditeur, dessin du plan)</td></tr>
  <tr><td>Ctrl + glisser</td><td>Éditeur : déplacer un lien. Plan : faire tourner une photo</td></tr>
  <tr><td>Ctrl + molette</td><td>Taille des vignettes dans le choix d’une photo</td></tr>
  <tr><td>Maj + clic</td><td>Bibliothèque : sélectionner toutes les photos entre deux</td></tr>
  <tr><td>Échap</td><td>Finir un trait, annuler une liaison, réduire la photo agrandie, oublier le lien sélectionné (plan)</td></tr>
  <tr><td>Suppr</td><td>Plan : supprimer le lien sélectionné (les deux sens)</td></tr>
  <tr><td>Alt</td><td>Tracer sans accroche sur le plan</td></tr>
</table></section>`;

// Ouvre le manuel, éventuellement sur une section (« liens », « relief »…).
export function showManual(section = null) {
  const d = dialog(
    `<div class="manual">
      <div class="manual-head"><h2>📖 Manuel</h2><button class="btn small" data-close>Fermer</button></div>
      <nav class="manual-toc">${SECTIONS.map(([id, t]) => `<a href="#man-${id}" data-sec="${id}">${t}</a>`).join('')}</nav>
      <div class="manual-body">${MANUAL}</div>
    </div>`,
    (dlg) => {
      dlg.classList.add('manual-dialog');
      // Liens internes : défilement dans le manuel, sans changer l'adresse de la page.
      dlg.querySelectorAll('a[href^="#man-"]').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const t = dlg.querySelector(a.getAttribute('href'));
          if (t) t.scrollIntoView({ block: 'start', behavior: 'smooth' });
        })
      );
    }
  );
  if (section) {
    const t = d.querySelector('#man-' + section);
    if (t) requestAnimationFrame(() => t.scrollIntoView({ block: 'start' }));
  }
  return d;
}

// Bouton « 📖 » à placer dans un panneau : data-manual="section".
export function bindManualButtons(root) {
  root.querySelectorAll('[data-manual]').forEach((b) => b.addEventListener('click', () => showManual(b.dataset.manual)));
}

export const manualButton = (section, label = 'Aide') => `<button type="button" class="btn small ghost manual-btn" data-manual="${section}" title="Ouvrir le manuel">📖 ${label}</button>`;
