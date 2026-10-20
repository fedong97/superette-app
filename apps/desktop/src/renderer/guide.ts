import type { WinKind } from './nav';

type Role = 'admin' | 'manager' | 'cashier' | 'seller' | 'buyer' | 'stock' | 'accountant';

/** Grosse tuile de la page d'accueil : un geste courant du rôle. */
export interface Tile {
  icon: string;
  label: string;
  desc: string;
  open: [WinKind, string?];
}

const T = {
  vendre: { icon: '🛒', label: 'Vendre', desc: 'Fiche de facturation au comptant', open: ['cash1'] },
  credit: { icon: '📒', label: 'Vente à crédit', desc: 'Pour un client en compte', open: ['credit'] },
  caisse: { icon: '💰', label: 'Ma caisse', desc: 'Ouvrir ou clôturer la caisse', open: ['treasury', 'day'] },
  factures: { icon: '🧾', label: 'Mes factures', desc: 'Retrouver et réimprimer un ticket', open: ['sales', 'tickets'] },
  devis: { icon: '📝', label: 'Devis', desc: 'Devis et factures proforma', open: ['quotes'] },
  clients: { icon: '👥', label: 'Clients', desc: 'Fiches, comptes et règlements', open: ['customers', 'list'] },
  attention: { icon: '⚠️', label: 'Points d’attention', desc: 'Ce qui attend une action', open: ['dashboard', 'attention'] },
  tabord: { icon: '📊', label: 'Tableau de bord', desc: 'Les chiffres du jour', open: ['dashboard', 'day'] },
  journees: { icon: '🗂️', label: 'Journées de caisse', desc: 'Z, écarts à justifier', open: ['treasury', 'history'] },
  stock: { icon: '📦', label: 'Stock', desc: 'Quantités par dépôt', open: ['stock', 'state'] },
  reception: { icon: '🚚', label: 'Réception', desc: 'Entrer une livraison', open: ['stock', 'receive'] },
  transfert: { icon: '🔁', label: 'Transfert', desc: 'Entre la réserve et la surface', open: ['stock', 'transfer'] },
  inventaire: { icon: '📋', label: 'Inventaire', desc: 'Compter le stock', open: ['stock', 'inventory'] },
  pertes: { icon: '🗑️', label: 'Pertes et casse', desc: 'Sortir un produit abîmé', open: ['stock', 'loss'] },
  peremption: { icon: '⏳', label: 'Péremptions', desc: 'Lots qui périment bientôt', open: ['stock', 'expiry'] },
  produits: { icon: '🏷️', label: 'Produits', desc: 'Prix, codes-barres, conditionnements', open: ['articles', 'list'] },
  etiquettes: { icon: '🔖', label: 'Étiquettes', desc: 'Imprimer les prix des rayons', open: ['labels'] },
  proposition: { icon: '🧮', label: 'Proposition de commande', desc: 'Ce qu’il faut commander', open: ['purchases', 'reorder'] },
  commandes: { icon: '📨', label: 'Bons de commande', desc: 'Commander aux fournisseurs', open: ['purchases', 'orders'] },
  fournisseurs: { icon: '🏭', label: 'Fournisseurs', desc: 'Fiches et comptes', open: ['suppliers', 'list'] },
  echeancier: { icon: '📅', label: 'Échéancier', desc: 'Factures fournisseurs à payer', open: ['purchases', 'due'] },
  depenses: { icon: '💸', label: 'Dépenses', desc: 'Loyer, ENEO, transport…', open: ['expenses', 'list'] },
  journaux: { icon: '📚', label: 'Journaux', desc: 'Écritures comptables', open: ['accounting', 'journals'] },
  tva: { icon: '🧾', label: 'Déclaration de TVA', desc: 'Le mois à déclarer', open: ['accounting', 'vat'] },
  banque: { icon: '🏦', label: 'Rapprochement', desc: 'Pointer le relevé de banque', open: ['accounting', 'bank'] },
  bilan: { icon: '📈', label: 'États financiers', desc: 'Bilan et compte de résultat', open: ['accounting', 'statements'] },
  rapports: { icon: '📉', label: 'Rapports de ventes', desc: 'Par rayon, article, caissier', open: ['reports'] },
  admin: { icon: '⚙️', label: 'Administration', desc: 'Caisses, utilisateurs, droits', open: ['admin', 'users'] },
  sauvegardes: { icon: '💾', label: 'Sauvegardes', desc: 'Copie de sécurité des données', open: ['admin', 'backups'] },
} satisfies Record<string, Tile>;

/** Accueil par rôle : les gestes de tous les jours, dans l'ordre de la journée. */
export const ROLE_TILES: Record<Role, Tile[]> = {
  cashier: [T.vendre, T.caisse, T.factures, T.credit, T.clients, T.devis],
  seller: [T.vendre, T.caisse, T.factures, T.credit, T.clients, T.devis],
  manager: [T.attention, T.tabord, T.vendre, T.journees, T.stock, T.commandes, T.clients, T.depenses, T.rapports],
  admin: [T.attention, T.tabord, T.admin, T.journees, T.produits, T.stock, T.rapports, T.sauvegardes, T.vendre],
  stock: [T.reception, T.transfert, T.inventaire, T.stock, T.pertes, T.peremption, T.etiquettes],
  buyer: [T.proposition, T.commandes, T.reception, T.fournisseurs, T.echeancier, T.produits, T.stock],
  accountant: [T.journaux, T.tva, T.banque, T.bilan, T.depenses, T.echeancier, T.rapports],
};

/** Guide de démarrage : les premières choses à faire, selon le rôle. */
export interface GuideStep {
  text: string;
  open?: [WinKind, string?];
}

export const GETTING_STARTED: Record<Role, GuideStep[]> = {
  admin: [
    { text: 'Vérifiez les paramètres du magasin : TVA, seuil d’écart de caisse, imprimante de tickets (page de test).', open: ['admin', 'settings'] },
    { text: 'Créez les caisses : une caisse espèces par poste, et si besoin une caisse électronique et une caisse banque.', open: ['admin', 'registers'] },
    { text: 'Créez les utilisateurs avec leur rôle et attribuez-leur leurs caisses.', open: ['admin', 'users'] },
    { text: 'Ajoutez les produits, ou importez le catalogue depuis Excel (CSV).', open: ['articles', 'list'] },
    { text: 'Choisissez un dossier de sauvegarde (clé USB ou autre disque).', open: ['admin', 'backups'] },
  ],
  manager: [
    { text: 'Le matin, regardez les Points d’attention : ruptures, écarts, factures en retard.', open: ['dashboard', 'attention'] },
    { text: 'Recevez les livraisons et transférez la marchandise de la réserve vers la surface de vente.', open: ['stock', 'receive'] },
    { text: 'Pendant la journée, suivez le Tableau de bord : chiffre d’affaires et meilleures ventes.', open: ['dashboard', 'day'] },
    { text: 'Le soir, contrôlez les clôtures de caisse et justifiez les écarts.', open: ['treasury', 'history'] },
    { text: 'Chaque semaine, lancez la Proposition de commande pour les fournisseurs.', open: ['purchases', 'reorder'] },
  ],
  cashier: [
    { text: 'Ouvrez votre caisse : le fond laissé la veille est proposé.', open: ['treasury', 'day'] },
    { text: 'Vendez : scannez ou tapez le nom du produit, puis Entrée pour valider en espèces.', open: ['cash1'] },
    { text: 'Pour MTN, Orange, carte ou chèque, appuyez sur Ctrl+E et notez la référence.' },
    { text: 'En cas de doute, le bouton « ? » en haut à droite explique la page affichée.' },
    { text: 'Le soir, clôturez la caisse en comptant les billets, puis vos caisses électronique et banque.', open: ['treasury', 'day'] },
  ],
  seller: [],
  stock: [
    { text: 'À chaque livraison, saisissez la réception avec la date limite des périssables.', open: ['stock', 'receive'] },
    { text: 'Transférez la marchandise de la réserve vers la surface de vente.', open: ['stock', 'transfer'] },
    { text: 'Sortez la casse et les produits périmés en pertes.', open: ['stock', 'loss'] },
    { text: 'Comptez les inventaires ouverts par le gérant.', open: ['stock', 'inventory'] },
    { text: 'Imprimez les étiquettes des prix qui ont changé.', open: ['labels'] },
  ],
  buyer: [
    { text: 'Ouvrez la Proposition de commande : elle calcule ce qu’il faut commander.', open: ['purchases', 'reorder'] },
    { text: 'Créez un bon de commande par fournisseur et imprimez-le.', open: ['purchases', 'orders'] },
    { text: 'À la livraison, réceptionnez le bon ; un reliquat reste en attente.', open: ['purchases', 'orders'] },
    { text: 'Saisissez la facture du fournisseur à partir des bons de réception.', open: ['purchases', 'invoices'] },
    { text: 'Suivez l’échéancier pour payer à temps.', open: ['purchases', 'due'] },
  ],
  accountant: [
    { text: 'Vérifiez le plan comptable et les comptes de banque et Mobile Money.', open: ['accounting', 'accounts'] },
    { text: 'Contrôlez les journaux : les écritures se passent toutes seules.', open: ['accounting', 'journals'] },
    { text: 'Chaque mois, faites le rapprochement bancaire avec le relevé CSV.', open: ['accounting', 'bank'] },
    { text: 'Imprimez la déclaration de TVA du mois pour la DGI.', open: ['accounting', 'vat'] },
    { text: 'En fin d’exercice, imprimez les états financiers et la DSF.', open: ['accounting', 'statements'] },
  ],
};
GETTING_STARTED.seller = GETTING_STARTED.cashier;

/** Quoi de neuf : les nouveautés des dernières versions, la plus récente en premier. */
export const WHATS_NEW: { version: string; items: string[] }[] = [
  {
    version: '0.73.0',
    items: [
      'Panier préparé au rayon : dans l’application Android, le vendeur connecté touche « Préparer un panier pour un client », scanne les produits avec le client, puis « Envoyer à la caisse ». Le caissier le retrouve dans « Rappeler » (F10) sous « Paniers des vendeurs » ; la vente compte pour le vendeur (Ma journée, objectifs et commissions).',
      'Nouveau droit « Préparer un panier au rayon sur le téléphone » (Facturation), donné aux gérants, caissiers et vendeurs.',
    ],
  },
  {
    version: '0.72.0',
    items: [
      'Accord du gérant à distance : quand la caisse demande le code du gérant, « Demander sur le téléphone du gérant » envoie la demande sur sa page Gérant. Il accepte avec son code (ou refuse) et la caisse continue. Le PC doit être relié au serveur.',
      'Page Gérant › 🔔 Alertes sur ce téléphone : demandes d’accord, écarts de caisse, grosses remises (seuil réglable), tickets annulés, ruptures de stock et PC muets. Page ouverte, chaque alerte sonne ; avec un serveur en https://, le téléphone les reçoit même page fermée.',
    ],
  },
  {
    version: '0.71.0',
    items: [
      'Trésorerie › « Relève d’équipe… » : le caissier qui part compte le tiroir sans voir l’attendu, celui qui arrive se connecte, et un bon de passation s’imprime avec l’écart de celui qui part. La journée et le Z restent les mêmes ; le Z détaille les ventes et l’écart de chaque caissier.',
    ],
  },
  {
    version: '0.70.0',
    items: [
      'Bouton « WhatsApp » à la caisse (à côté de Facture A4) et dans le détail d’une vente : le ticket part sur le téléphone du client, avec la facture A4 en PDF si vous le cochez.',
      'Bons de commande › « WhatsApp au fournisseur » : la commande part sur le numéro du fournisseur, avec le bon en PDF.',
    ],
  },
  {
    version: '0.69.0',
    items: [
      'Accueil › « Ma journée » pour le caissier et le vendeur : ses ventes du jour, ses tickets, son panier moyen, la barre de son objectif et sa commission du mois.',
      'Fichier › « Mode formation… » : FEDONIX 360 s’ouvre sur une copie de la boutique avec un bandeau orange. On y vend pour s’entraîner ; rien ne compte dans la boutique ni ne part au serveur. « Quitter la formation » ramène à la boutique.',
    ],
  },
  {
    version: '0.68.0',
    items: [
      'Fiche utilisateur : l’identifiant se modifie, et « Supprimer l’utilisateur » efface un compte jamais utilisé ou retire des listes celui qui a déjà travaillé (son nom reste sur ses tickets).',
      '« Ajouter un employé » : utilisateur, rôle, caisses, fiche collaborateur (poste, téléphone, salaire) et badge en une seule fiche.',
      'Badge : une carte avec code-barres ; scannée à l’écran de connexion, elle remplit l’identifiant.',
      'Charge › Collaborateurs › Pointage : arrivée à la première connexion, départ à la fermeture de la caisse ou avec « Je pars ». Heures, retards et absences du mois ; le gérant corrige un oubli avec un motif. Horaires dans Administration › Paramètres.',
    ],
  },
  {
    version: '0.67.0',
    items: [
      'Version anglaise : le bouton « English » en bas de l’écran (et sur l’écran de connexion) passe les écrans en anglais pour l’utilisateur connecté ; « Français » revient au français. La caisse, la trésorerie, les clients, les ventes, les commandes et les livraisons sont entièrement traduits, avec les messages d’erreur ; pour les autres écrans, les menus et les titres.',
      'Fiche client › « Langue des tickets et factures » : un client en anglais reçoit ses tickets, factures, devis, bons de livraison, reçus de règlement et relevés en anglais, montant en lettres compris. Les bons de caisse et le rapport Z suivent la langue de l’utilisateur.',
    ],
  },
  {
    version: '0.66.0',
    items: [
      'FEDONIX 360 Serveur sur internet : un serveur loué (VPS) et un nom de domaine suffisent. Le paquet « serveur-internet » s’installe avec un seul script, le cadenas HTTPS se met tout seul, la page du gérant marche partout sur son téléphone et la base est sauvegardée chaque jour. Le guide pas à pas est dans le paquet.',
    ],
  },
  {
    version: '0.65.0',
    items: [
      'Charge › Collaborateurs › Objectifs et commissions : un objectif du mois et du jour par vendeur, le taux atteint, et sa commission (taux général et taux par famille d’articles). Les ventes comptées sont celles validées sous son compte, à crédit comprises, moins ses retours.',
      'Salaires du mois : la commission du mois s’ajoute au brut proposé, dans sa propre colonne.',
    ],
  },
  {
    version: '0.64.0',
    items: [
      'Commandes clients (Facturation et Vente) : le client appelle ou écrit sur WhatsApp, vous saisissez sa commande, l’envoyez en confirmation par WhatsApp, puis la préparez : la marchandise est mise de côté et la caisse ne la vend plus à un autre client. Au moment de la livraison ou du retrait, la caisse charge la commande (Action › Charger une commande client) et l’encaisse.',
    ],
  },
  {
    version: '0.63.1',
    items: [
      'Correction : la roulette de la souris fait défiler les longs menus de la barre verte (Clients, Vente…) sans les fermer.',
      'Un écran qui rencontre un problème affiche un message avec « Réessayer », sans que le reste du logiciel disparaisse.',
    ],
  },
  {
    version: '0.63.0',
    items: [
      'Produits : boutons « Exporter Excel » et « Exporter CSV » avec plusieurs modèles (catalogue complet, tarifs, codes-barres, comptage, terminal d’inventaire, valeur du stock) et vos propres modèles de colonnes.',
      'Import des produits complet : prix de gros et super gros, quantités mini et maxi, 3 conditionnements avec prix et codes-barres, vérification avant import, et les fichiers articles des autres logiciels de gestion acceptés tels quels.',
      'Dépôts : modifiez le nom et le type d’un dépôt, désactivez-le ou réactivez-le.',
      'Mise à jour des prix en masse, produit remplaçant proposé en caisse, emplacements par dépôt, codification des produits par famille, palmarès ABC et liste des produits sans vente.',
    ],
  },
  {
    version: '0.62.0',
    items: [
      'Afficheur client : le client voit l’article scanné, le total à payer puis la monnaie rendue, sur un deuxième écran (avec votre logo) ou sur un petit afficheur à deux lignes. Réglage dans Administration › Paramètres, section « Afficheur client ».',
    ],
  },
  {
    version: '0.61.0',
    items: [
      'Comptabilité › Immobilisations : enregistrez congélateurs, PC, véhicules et travaux du magasin. Le plan d’amortissement se calcule seul et s’imprime ; la dotation est passée à chaque fin d’exercice, et la vente ou la mise au rebut d’un bien passe ses écritures.',
    ],
  },
  {
    version: '0.60.0',
    items: [
      'Administration › Reprise des données : pour un magasin qui arrive d’un autre logiciel, d’Excel ou d’un cahier, importez ses clients avec ce qu’ils doivent, ses fournisseurs avec ce que vous leur devez, et son stock de départ. Chaque fichier se vérifie d’abord en aperçu ; les écritures d’à-nouveaux se passent seules.',
    ],
  },
  {
    version: '0.59.1',
    items: ['Administration : les onglets passent sur deux lignes au lieu de déborder, et la page s’affiche en entier.'],
  },
  {
    version: '0.59.0',
    items: [
      'Modèles de boutique : à la création, choisissez le métier (superette, quincaillerie, pharmacie, boulangerie, habillement) et la boutique part avec ses rayons, familles et réglages. Administration › Modèles de boutique enregistre la vôtre comme modèle (catalogue compris si vous voulez), à réutiliser chez le client suivant.',
      'Import du catalogue d’un fournisseur dans son propre format : « Nouveau format… » montre les premières lignes du fichier, vous dites quelle colonne est la désignation, le prix, le code-barres…, et le format se réutilise en un clic.',
      'Export des écritures pour le cabinet comptable dans le format du logiciel du cabinet, ou dans un format décrit une fois (ordre des colonnes, date, séparateur).',
      'Postes distants : un dépôt sans réseau ni serveur vend sur son propre PC. Administration › Postes distants prépare son installation sur une clé ; chaque soir le dépôt fait sa remontée (clé USB, e-mail ou WhatsApp) que la boutique intègre, et la boutique lui renvoie prix et catalogue.',
      'Contrôle avant clôture d’exercice : écritures déséquilibrées, journées de caisse restées ouvertes, fiches pas rapportées, stock à recalculer et opérations pas encore envoyées au serveur sont listés avant de clôturer.',
    ],
  },
  {
    version: '0.58.0',
    items: [
      'Fiches boutique : Administration › Fiches boutique sort une copie de la boutique sur une clé USB pendant que la caisse vend. La boutique n’est jamais arrêtée.',
      'Fiche d’intervention : le technicien l’ouvre sur son PC (Fichier › Ouvrir une boutique › Ouvrir une fiche), sans réinstaller ni toucher à la base, y travaille puis la rapporte. « Rapporter une fiche » ajoute ses modifications à la boutique sans rien effacer de ce qu’elle a vendu entre-temps ; si un même élément a changé des deux côtés, la modification la plus récente est gardée.',
      'Copie pour le comptable : il fait ses états chez lui pendant que la boutique tourne, et prend une nouvelle copie à sa prochaine visite.',
      'Installation préparée : paramétrez la boutique du client au bureau (magasin, utilisateurs, articles) dans une nouvelle boutique, puis « Préparer l’installation ». Sur le PC du client, au premier démarrage : « Installer une boutique préparée ».',
      'Un PC peut tenir plusieurs boutiques : l’écran de connexion propose « Changer de boutique », et chaque boutique garde ses utilisateurs, sa licence et ses réglages de PC.',
      'Envoyer une fiche sans clé USB : « Envoyer… » la compresse (5 à 10 fois plus petite) et ouvre son dossier, prête à joindre à un e-mail ou un message WhatsApp. Le technicien la renvoie de la même façon.',
      'Dossier partagé (réseau, OneDrive, Google Drive) : la copie du comptable s’y dépose seule (toutes les heures, chaque jour…), et le technicien y dépose sa fiche dans « Retours » ; la barre d’état annonce « 1 fiche à rapporter ».',
      'Administration › Réparation : vérifie le fichier de la boutique et recalcule le stock et les lots à partir des mouvements, après une sauvegarde, sans arrêter la caisse. Si la base ne s’ouvre plus au démarrage, FEDONIX 360 propose de restaurer la dernière bonne sauvegarde.',
    ],
  },
  {
    version: '0.57.0',
    items: [
      'Serveur central : le PC vérifie que le serveur a bien tous ses produits, rayons, dépôts, utilisateurs, stocks et inventaires, et lui renvoie seul ce qui manque (serveur réinstallé, sauvegarde restaurée). Le téléphone d’inventaire retrouve ainsi le catalogue.',
      'Administration › Serveur central › « Renvoyer au serveur ce qui lui manque » fait cette vérification à la demande. Rien n’est effacé ni envoyé en double.',
    ],
  },
  {
    version: '0.56.0',
    items: [
      'Inventaire sur téléphone : les codes-barres et les noms sont retrouvés même sur un gros catalogue. Les photos ne sont plus téléchargées avec le catalogue (une fiche affiche la sienne à l’ouverture), et un code ou un nom introuvable sur le téléphone est cherché sur le serveur.',
      'Mode fichier, sans serveur ni Wi-Fi : le téléphone ouvre la fiche à remplir du PC (Excel ou CSV) ou un fichier texte « code;nom (conditionnement);quantité », on compte, puis « Exporter la fiche remplie » l’envoie par WhatsApp ou e-mail ; le PC la reprend avec le bouton Importer de l’inventaire.',
      'Onglet Produits : tous les produits de l’inventaire à toucher pour les compter, avec « 120 / 450 comptés » et les filtres À compter, Comptés, Tous et par rayon.',
      'Menu ☰ de l’inventaire : remettre à 0 un endroit ou tout l’inventaire (après confirmation), et mon récapitulatif par endroit à partager en fichier.',
      'Inventaires En cours et Clôturés : quand le gérant clôture sur le PC, mes comptages restent consultables sur le téléphone.',
      'Aides sans compte (famille, intérimaires) : sur FEDONIX 360 Gérant › Inventaire, « Ajouter un aide » donne un QR code et un code à 6 chiffres. L’aide compte tout de suite, sans identifiant, seulement cet inventaire, sans prix ni stock attendu ; l’accès s’arrête à la clôture ou après 24 h, et « Couper » l’arrête aussitôt. Sur le PC ses comptages sont signés au nom du responsable choisi, le gérant voit son nom.',
    ],
  },
  {
    version: '0.55.0',
    items: [
      'Application Android FEDONIX 360 Inventaire : le compteur scanne les codes-barres avec l’appareil photo (ou une douchette Bluetooth), tape la quantité en cartons et unités, et compte même sans réseau ; tout part au serveur dès que le Wi-Fi revient.',
      'Le téléphone se relie au magasin avec le QR code de FEDONIX 360 Gérant › Inventaire ; chaque compteur se connecte avec son identifiant et son code (droit « Saisir le stock physique »).',
      'Un même produit compté au rayon et en réserve s’additionne. Mode rafale : chaque scan ajoute 1. Code inconnu : photo et nom envoyés au gérant.',
      'Le gérant suit l’avancement par rayon et par compteur (produits par heure), confie des rayons à chacun, et fait recompter par un collègue les gros écarts. La clôture reste sur le PC.',
    ],
  },
  {
    version: '0.54.0',
    items: [
      'Paiement Mobile Money automatique : à l’encaissement, MTN MoMo ou Orange Money › « Demander le paiement » envoie la demande au téléphone du client ; il confirme avec son code et la référence s’ajoute toute seule.',
      'Administration › Paiement mobile : mode Simulation (sans compte, pour essayer et former), Test MTN (sandbox, avec un compte développeur gratuit) ou Réel (clés du compte marchand MTN ou Orange). Les clés restent sur le PC.',
      'Historique des demandes avec leur état (payé, refusé avec le motif, abandonné) et le numéro de transaction.',
    ],
  },
  {
    version: '0.53.0',
    items: [
      'Page du gérant sur le téléphone : ouvrez l’adresse du serveur suivie de /gerant (par exemple http://192.168.1.10:8080/gerant), avec le mot de passe de FEDONIX 360 Serveur.',
      'Ventes du jour et comparaison avec la veille, paiements, ventes par heure, meilleures ventes, caisses ouvertes ou fermées, écarts de caisse, ruptures et stock bas, pour chaque magasin.',
      'Alertes : manque à la clôture, caisse ouverte dont le PC ne répond plus, ruptures, PC pas à jour. « Ajouter à l’écran d’accueil » l’installe comme une application.',
    ],
  },
  {
    version: '0.52.0',
    items: [
      'Paie avec retenues légales (Administration › Paramètres › Paie) : CNPS, IRPP, CAC, crédit foncier, redevance audiovisuelle et TDL au barème camerounais, tous modifiables.',
      'Salaires du mois : les retenues se calculent sur le brut des collaborateurs déclarés, avec la part patronale (CNPS, CFC, FNE) ; le bulletin les détaille avec le coût total pour l’employeur.',
      'Les écritures suivent : retenues vers la CNPS (4311) et l’État (4471), charges patronales en 664 et 641. « Imprimer l’état du mois » donne les montants à verser.',
    ],
  },
  {
    version: '0.51.0',
    items: [
      'Relances par WhatsApp : dans Client › Situation (balance âgée) ou le compte d’un client, « Relancer » ouvre WhatsApp avec un message prêt (solde, retard, factures dues), modifiable avant l’envoi.',
      '« Relancer les clients en retard » enchaîne tous les clients en retard, un par un ; « Relevé en PDF » prépare le relevé à joindre au message.',
      'Chaque relance est notée (date, auteur, montant dû) et s’affiche dans la balance âgée. Le message se règle dans Administration › Paramètres › Crédit clients.',
    ],
  },
  {
    version: '0.50.0',
    items: [
      'Carte de fidélité (Administration › Paramètres › Carte de fidélité) : le client enregistré gagne 1 point par tranche d’achat (1 000 FCFA par défaut) et paie avec ses points à l’encaissement (« Points fidélité »).',
      'À la caisse, scanner la carte du client ou taper son téléphone le choisit tout de suite ; ses points s’affichent à côté de son solde et s’impriment sur le ticket.',
      'Fiche client › Fidélité : solde, mouvements, impression de la carte à code-barres, correction avec motif (droit « Corriger les points de fidélité »).',
      'Les points valent dans tous les magasins. Mettez à jour FEDONIX 360 Serveur avant les PC.',
    ],
  },
  {
    version: '0.49.0',
    items: [
      'Mises à jour automatiques : déposez le nouvel installateur dans FEDONIX 360 Serveur (onglet « Mises à jour ») et chaque PC relié le télécharge tout seul, puis l’installe à sa fermeture.',
      'Administration › Mises à jour : version du PC, état du téléchargement, « Installer maintenant », et une adresse internet pour les boutiques sans serveur.',
      'La barre du bas annonce « Mise à jour prête » ; FEDONIX 360 Serveur montre la version de chaque PC.',
    ],
  },
  {
    version: '0.48.0',
    items: [
      'Le logiciel s’appelle maintenant FEDONIX 360, avec son nouveau logo en 3D sur l’écran de connexion, l’icône du bureau et l’installateur.',
      'Le serveur central a son propre logo : le même, avec un serveur devant (Administration › Serveur central).',
      'Vos données, vos réglages et votre licence sont gardés : rien à refaire après la mise à jour.',
    ],
  },
  {
    version: '0.43.1',
    items: [
      'Barre verte : tous les menus y sont (Fichier, Fabrication, Fournisseurs, Charges, Transferts, Comptabilité, Fiscal en plus). Si l’écran est petit, la barre défile à la molette.',
      '« ✎ Personnaliser » en bas de la barre (ou Fichier › Personnaliser la barre latérale) : cochez les menus à afficher et rangez-les avec ↑ ↓. Le choix vaut pour chaque utilisateur ; « Rétablir » revient à tous les menus.',
    ],
  },
  {
    version: '0.43.0',
    items: [
      'Bouton ⟳ dans la barre de chaque fenêtre (ou F5) : la page se recharge sans la fermer. À la caisse, F5 ouvre toujours le tiroir.',
      'Exercices comptables (Comptabilité › Exercices, ou Administration) : ouvrir un exercice, changer ses dates, le clôturer et le rouvrir. La clôture reporte les soldes en à-nouveaux sur l’exercice suivant, avec le résultat au 121 ou au 129 ; aucune écriture ne se passe plus sur un exercice clôturé.',
      'Plan comptable SYSCOHADA complet (classes 1 à 8). Bouton 📖 « Plan comptable » en créant une catégorie de dépense ou une écriture : recherche par numéro ou intitulé, et création d’un sous-compte sans quitter la saisie.',
      'Sauvegarde automatique à fréquence choisie (toutes les 15 min, 1 h, 2 h… jusqu’à 12 h) dans le dossier choisi : Administration › Sauvegardes.',
      'Menu Transfert : « Nouveau transfert » et « Liste des transferts » (par période, dépôt et état), avec Modifier et Supprimer. Un transfert reçu supprimé ou modifié remet la marchandise dans le dépôt de départ.',
      'Écritures comptables : modifier ou supprimer une écriture saisie, et corriger une écriture automatique par une écriture liée. Nouveau droit « Modifier, supprimer ou corriger une écriture comptable » à donner selon le profil.',
      'Caisse : sur une fiche vide, Listing (F7) réimprime la dernière facture en listing, comme Ticket (F2) réimprime le dernier ticket.',
      'Charges fixes : bouton « Supprimer ». Une charge déjà payée est arrêtée et garde son historique ; « Afficher les charges arrêtées » la montre.',
      'Facturation : le stock de chaque dépôt du vendeur s’affiche dans la recherche et à la saisie de la quantité. Si le dépôt choisi n’a pas assez, la vente se complète avec le stock des autres dépôts. Les dépôts de chaque utilisateur se cochent dans Administration › Utilisateurs.',
      'État du stock « Tous les dépôts » : une colonne par dépôt et le total ; un clic sur un article montre son stock par dépôt et par lot. Export Excel.',
      'Ctrl+J : « Nouveau » sur la page ouverte (article, client, fournisseur, collaborateur, dépense, charge fixe, devis, bon de commande, transfert, compte, utilisateur…). Dans le formulaire, Ctrl+J enregistre et en ouvre un nouveau ; un champ obligatoire vide est signalé et rien n’est enregistré.',
    ],
  },
  {
    version: '0.42.0',
    items: [
      'Fenêtres : chaque écran s’ouvre dans sa fenêtre, à l’intérieur du logiciel. On la déplace par sa barre verte, on l’agrandit par le coin, ▢ (ou double-clic sur la barre) la met en plein écran et ✕ la ferme. La caisse s’ouvre en plein écran ; chaque fenêtre se rouvre là où vous l’avez laissée.',
      'Barre du haut : tous les onglets sont visibles en entier (sur deux lignes si l’écran est étroit). 🔍 cherche un écran (Ctrl+K), ＋ personnalise les onglets ; l’heure est en bas à droite.',
      'Trois écrans de caisse au choix (Administration › Paramètres › Écran de caisse) : Moderne, Classique et Conventionnel, avec les mêmes fonctions et les mêmes touches. Le choix vaut pour tout le magasin, avec une exception possible pour un poste.',
      'Nouvelles touches pour finir une fiche : F2 valide et imprime le ticket de caisse, F7 valide et imprime la facture listing, F4 ou VALIDER enregistre sans imprimer. Sur une fiche vide, F2 réimprime le dernier ticket et F7 ouvre « Mes factures ».',
      'Nouveaux modèles de facture : ticket encadré (nom du produit sur sa ligne, QTE, COND., P.U., TOTAL, colis, net à payer), ticket détaillé (code, total HT, TVA, remise, colis, montant TTC) et listing sans logo (avec jusqu’à 4 signatures). Tout se modifie dans Modèles d’impression : disposition, textes, lignes à afficher, colonnes, signatures.',
      'Paramètres › « Modèle utilisé pour chaque impression » : choisissez le modèle du ticket (F2), du listing (F7), de l’A4 (F9), du bon de livraison et des devis ; « Modifier… » ouvre le modèle.',
      'Magasin sans TVA : la TVA et les mots HT / TTC disparaissent des modèles ; décochez « Total HT » et « Partie TVA » pour ne rien afficher de la TVA.',
      'Facture listing refaite pour l’imprimante à papier continu : cadre, logo, cases DATE / CLIENT / RÉF., magasin de livraison, tableau encadré, montant en lettres, nombre de colis et NET À PAYER. Les textes se changent dans Modèles d’impression ; choisissez l’imprimante listing de chaque PC dans Paramètres pour imprimer sans fenêtre Windows.',
      'Codes-barres : un article sans code fabricant reçoit tout seul un code interne EAN-8 (8 chiffres, commence par 2) à son enregistrement, pour l’unité et pour chaque carton. Paramètres › « Codes-barres et étiquettes » : code automatique, EAN-8 ou EAN-13, et « Donner un code aux articles sans code » pour les articles déjà créés.',
      'Étiquettes produit : « Imprimer les codes-barres… » sur la fiche article, dans Étiquettes › « Codes-barres produit » et après chaque réception d’achat. Rouleau 30 × 20, 40 × 25 ou 50 × 30 mm, ou planche A4 ; nom, prix et magasin au choix. Choisissez l’imprimante d’étiquettes du PC dans Paramètres pour imprimer sans fenêtre Windows.',
      'Caisse : choisissez le tarif (Détail, Gros, Super gros) et le dépôt d’où sort la marchandise pour la fiche en cours. Sans ce droit, le code d’un gérant est demandé.',
      'Livraisons : onglet « Livraison » du ticket (adresse, livreur, jour, créneau, frais ajoutés au ticket) et bon de livraison imprimé avec la vente.',
      'Nouvel écran Vente › « Livraisons du jour » : à préparer, en route, livrées, avec « Partir » et « Livrée ». Pour une vente à crédit, l’argent rapporté par le livreur s’enregistre comme règlement du client.',
    ],
  },
  {
    version: '0.41.1',
    items: [
      'Correction : la barre de recherche (caisse, clients, fournisseurs) ne se bloque plus après une question « OK / Annuler » ou une impression. Les questions s’affichent maintenant dans le logiciel.',
      'Correction : sur « Tous les menus », la barre verte de gauche répond de nouveau (le menu s’ouvrait derrière la page).',
    ],
  },
  {
    version: '0.41.0',
    items: [
      'Nouvelle présentation aux couleurs de FEDO : barre verte à gauche avec les menus, onglets arrondis en haut, et « Tous les menus » pour voir chaque écran d’un coup.',
      'Caisse tactile : les produits trouvés s’affichent en grosses tuiles avec le prix et le stock ; sans saisie, vos touches rapides.',
      'Le ticket en cours est à droite : client, Comptant ou Crédit, lignes, total, reçu et rendu. Touchez une ligne pour − et +, Varier, Remise ou Enlever.',
      'Gros boutons en bas : En attente, Rappeler, Tiroir, Ticket, Facture A4, Listing, Vider, Encaisser et VALIDER. Toutes les fonctions et tous les raccourcis clavier restent les mêmes.',
    ],
  },
  {
    version: '0.40.0',
    items: [
      'Modèles d’impression (Administration › Modèles d’impression) : la facture client en ticket de caisse, A4 ou listing, comptant ou à terme, chacune réglable champ par champ avec l’aperçu à côté.',
      'Choisissez les colonnes du tableau, leur titre, leur largeur et leur ordre, les informations du magasin et du client, les totaux, le montant en lettres, les mentions et les signatures.',
      'Aperçu avant impression dans Ventes et la fiche client : changez de modèle, imprimez ou enregistrez la facture en PDF. Les réimpressions portent « DUPLICATA ».',
      'Devis et proformas : modèles A4, listing et ticket, avec la date de validité, les observations et le montant en lettres ; « Aperçu et impression… » dans la fiche du devis.',
      'Nouveau bon de livraison d’une vente (A4, listing ou ticket) : quantités sans prix, zones « Livré par » et « Reçu par ». Il se choisit dans l’aperçu de la vente.',
      'Achats : modèles du bon de commande et de la facture d’achat (A4, listing, ticket), avec le fournisseur, sa référence, la pièce du fournisseur, les règlements et le reste à payer ; « Aperçu et impression… » dans la commande et la facture.',
    ],
  },
  {
    version: '0.39.1',
    items: [
      'Import du catalogue et des comptages : un fichier enregistré par Excel en « CSV (séparateur point-virgule) » garde ses accents.',
      'L’avertissement « Sauvegarde en retard » disparaît dès que la sauvegarde est faite.',
      'Barre d’état plus courte, toujours sur une seule ligne.',
      'États financiers : un message indique les marchandises entrées en stock sans facture fournisseur, qui gonflent le résultat tant que la facture n’est pas saisie.',
    ],
  },
  {
    version: '0.39.0',
    items: [
      'Résumé du jour (Administration › Résumé du jour) : ventes, encaissements par moyen de paiement, état des caisses et écarts, meilleures ventes et points à surveiller, à envoyer au gérant par WhatsApp en un clic.',
      'L’administrateur peut aussi faire partir ce résumé chaque soir par e-mail, à l’heure choisie, depuis le PC où il le règle.',
      'Le contrat de licence s’affiche à l’installation et dans Administration › Licence.',
    ],
  },
  {
    version: '0.38.0',
    items: [
      'Le logiciel s’appelle maintenant FEDO Gestion, avec son logo sur l’écran de connexion, l’icône du bureau et l’installateur.',
      'Vos données, vos réglages et votre licence sont gardés : rien à refaire après la mise à jour.',
    ],
  },
  {
    version: '0.37.0',
    items: [
      'Licence : Administration › Licence montre le code machine de ce PC (à copier ou envoyer par WhatsApp) et active la clé reçue de votre fournisseur.',
      'Sans licence, 15 jours d’essai ; à la fin de la licence, la caisse vend encore 15 jours puis s’arrête. Consultation, clôture et sauvegardes restent toujours possibles.',
      'Les autres PC reliés au serveur central reçoivent la licence tout seuls, dans la limite du nombre de PC qu’elle permet.',
    ],
  },
  {
    version: '0.36.0',
    items: [
      'TVA désactivée dans les paramètres : les articles passent à « Exonéré », un nouvel article est exonéré, et la TVA, le HT et le TTC disparaissent des écrans, des impressions et des exports. La déclaration de TVA est masquée.',
      'TVA réactivée : un bouton propose de remettre d’un coup les articles exonérés à 19,25 %.',
      'Stock MM devient « Stock multi-magasin » : le stock de chaque article dans chaque magasin, avec le total, le détail par dépôt, l’impression A4 et l’export Excel.',
    ],
  },
  {
    version: '0.35.0',
    items: [
      'Photo de l’article sur sa fiche, en miniature dans la liste des produits et dans la recherche de la caisse.',
      'Achats › Saisir une facture directe : la facture avec ses articles, sans bon de commande. Le stock entre, le bon de réception est créé, et la facture peut être réglée tout de suite.',
      'Remise % et promo « N achetés, M payés » sur chaque ligne du bon de commande, de la réception et de la facture directe ; remise globale sur la facture directe. Le stock entre au coût net.',
      'Collaborateurs : compte de rattachement au choix (Personnel 4211, CNPS 4311, État 4471, Associés 4621 ou autre compte de la classe 4), son sous-compte est créé dessous.',
    ],
  },
  {
    version: '0.34.0',
    items: [
      'Opérations de trésorerie : boutons « Encaisser » et « Décaisser » sur chaque volet, avec le type (client, fournisseur, personnel, charge, reversement, autre), le n° de pièce et le motif.',
      'Bouton « Action » : imprimer le reçu (ticket ou A4), décharge à faire signer, antidater, convertir une sortie en règlement fournisseur ou en remboursement client, supprimer.',
      '« Totaux par nature d’entrée / sortie » sous les volets de la journée.',
      'Charge › Collaborateurs : fiche de chaque employé, avec ses sous-comptes 4211… (salaires dus) et 4251… (avances) créés en comptabilité.',
      'Salaires du mois : constater le salaire, retenir les avances, payer le net au bureau ou à la caisse, imprimer le bulletin et l’extrait de compte.',
    ],
  },
  {
    version: '0.33.0',
    items: [
      'Le journal d’une caisse électronique montre enfin ses entrées et ses sorties, avec la référence de chaque transfert.',
      'Une dépense, un remboursement ou un règlement fournisseur payé par MoMo ou Orange Money sort de la caisse électronique : plus de faux écart à la clôture.',
      'À la caisse, « Dépense payée en caisse » se paie en espèces ou avec votre compte MoMo/OM.',
      'À la clôture, le caissier voit ses sorties par son compte électronique.',
      'Paramètres › Caisses électroniques : avec une caisse électronique centrale (chaque caissier y verse sa recette le soir, avec la référence du transfert et un bon), ou caisses indépendantes (le solde passe au lendemain).',
      'Trésorerie › Caisses électroniques (MoMo, OM) et centrale : solde de chaque caisse, livre, transferts et dépôts à la banque.',
      'Ristournes payées par MTN MoMo ou Orange Money depuis une caisse électronique, avec la référence du transfert sur le bon.',
    ],
  },
  {
    version: '0.32.0',
    items: [
      'Droits par rôle plus détaillés, rangés par groupe (Facturation, Trésorerie, Stocks…) avec recherche et « Tout cocher ».',
      'Privilèges par utilisateur : donner ou retirer un droit à une seule personne, sans changer son rôle.',
      'Paramètres plus complets : logo et RCCM sur les tickets, remise maximale, arrondi des espèces, nombre de tickets, client obligatoire au-delà d’un montant…',
      'Sécurité : déconnexion après inactivité, longueur du code, blocage après plusieurs codes faux.',
      'Préfixes des numéros (tickets, devis, bons de commande), sauvegarde à heure fixe et grand texte.',
    ],
  },
  {
    version: '0.31.0',
    items: [
      'Menus et textes en gras, plus lisibles.',
      'Bouton « ? » sur chaque page (ou F1) : comment utiliser la page.',
      'Recherche de menu : Ctrl+K, puis tapez « clôture », « inventaire »…',
      'Le chemin de la page s’affiche en haut (Trésorerie › Opérations de trésorerie) ; « Accueil » y ramène.',
      'Onglets rapides à votre goût : clic droit pour épingler, retirer ou déplacer.',
      'Page d’accueil avec de grosses tuiles adaptées à votre rôle.',
      'Aide › Guide de démarrage et Aide › Quoi de neuf.',
    ],
  },
  {
    version: '0.30.0',
    items: [
      'Caisses espèces, électronique (MTN, Orange, carte) et banque (virement, chèque) : chaque paiement va dans la caisse de son type.',
      'Clôture d’une caisse électronique par le montant lu sur chaque téléphone ou terminal, avec bon de clôture.',
    ],
  },
  {
    version: '0.29.1',
    items: ['Le caissier ouvre sa caisse sans le code du gérant.', 'Les menus et boutons non permis sont masqués.'],
  },
  {
    version: '0.29.0',
    items: ['Fabrication : recettes et ordres de fabrication.', 'Points d’attention du gérant.', 'Proposition de commande améliorée.'],
  },
];
