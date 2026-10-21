import type { Permission } from '@superette/core';
import type { WinKind } from './nav';

/** Une partie de l'aide d'une page : souvent un onglet de la fenêtre. */
export interface HelpSection {
  /** Onglet de la fenêtre que la partie explique : l'aide s'ouvre dessus. */
  tab?: string;
  title: string;
  /** Droit nécessaire pour voir cette partie (l'un d'eux s'il y en a plusieurs). */
  perm?: Permission | Permission[];
  steps: string[];
}

export interface PageHelp {
  title: string;
  intro: string;
  sections: HelpSection[];
  keys?: [string, string][];
}

const POS_KEYS: [string, string][] = [
  ['F1', 'Rechercher un produit'],
  ['F2', 'Valider et imprimer le ticket de caisse (fiche vide : réimprimer le dernier ticket)'],
  ['F7', 'Valider et imprimer la facture listing (fiche vide : réimprimer la dernière facture en listing)'],
  ['Entrée sur saisie vide ou F4', 'Enregistrer la fiche sans imprimer'],
  ['Ctrl+E', 'Encaisser : Mobile Money, carte, chèque, paiements mixtes'],
  ['F3 / F10', 'Mettre en attente / rappeler un ticket en attente'],
  ['F5', 'Ouvrir le tiroir'],
  ['F6', 'Remise sur la ligne choisie'],
  ['F8', 'Choisir le client'],
  ['F9', 'Facture A4 du ticket'],
  ['+ / −', 'Quantité de la ligne choisie'],
  ['Suppr', 'Enlever la ligne choisie'],
  ['3*code', 'Ajouter 3 fois le produit scanné ou tapé'],
];

const POS: PageHelp = {
  title: 'Fiche de facturation (vente au comptant)',
  intro: 'C’est l’écran de vente. On scanne ou on tape les produits, puis on encaisse. La caisse doit être ouverte (Trésorerie) avant la première vente.',
  sections: [
    {
      title: 'Faire une vente',
      steps: [
        'Scannez le code-barres, ou tapez le début du nom (2 lettres suffisent) : les produits trouvés s’affichent en tuiles. Touchez une tuile, ou choisissez avec les flèches et Entrée.',
        'Sans saisie, les tuiles montrent vos touches rapides (fiche du produit › « Touche rapide en caisse »).',
        'Pour plusieurs pièces, tapez « 3*code » ou « 3*riz ». Touchez une ligne du ticket pour ses boutons − et +, Varier, Remise et Enlever (ou les touches +, −, F6 et Suppr).',
        'Touchez les billets reçus (1 000, 2 000…) ou « Exact » : « Reçu » et « À rendre » s’affichent sous le total.',
        'Pour finir : F2 valide et imprime le ticket de caisse, F7 valide et imprime la facture listing, et VALIDER (F4, ou Entrée sur la zone de saisie vide) enregistre seulement, sans imprimer. Le tiroir s’ouvre quand même pour une vente en espèces.',
        'L’administrateur choisit la présentation de cet écran dans Administration › Paramètres › Écran de caisse : Moderne, Classique ou Conventionnel. Les fonctions et les touches sont les mêmes.',
      ],
    },
    {
      title: 'Payer par Mobile Money, carte ou chèque',
      steps: [
        '« Encaisser » (Ctrl+E) ouvre l’encaissement : choisissez le moyen, le montant, puis la référence reçue par SMS.',
        'Paiement mobile réglé sur ce PC : avec MTN MoMo ou Orange Money, tapez le téléphone du client et « Demander le paiement » ; il confirme sur son téléphone et le paiement s’ajoute avec sa référence.',
        'Un paiement peut être mixte : une partie en espèces, le reste en MTN par exemple.',
        'Chaque paiement va dans la caisse de son type : MTN, Orange et carte à votre caisse électronique, virement et chèque à votre caisse banque.',
      ],
    },
    {
      title: 'Client, remise, attente',
      steps: [
        'Touchez « Client comptoir » en haut du ticket (ou F8) pour choisir un client : ses prix (gros, super gros) s’appliquent et son solde s’affiche. « Comptant » et « Crédit » passent d’une vente à l’autre.',
        'F6 fait une remise sur la ligne ; sans le droit, le code d’un gérant est demandé.',
        '« En attente » (F3) met la fiche de côté pour servir un autre client ; « Rappeler » (F10) la reprend.',
        '« Rappeler » montre aussi les paniers préparés au rayon par les vendeurs sur leur téléphone : choisissez « Panier n° … de … », ses produits arrivent sur la fiche et la vente compte pour le vendeur.',
        'Quand le code du gérant est demandé et que le gérant est absent : « Demander sur le téléphone du gérant ». Il accepte avec son code sur sa page Gérant, et la caisse continue (PC relié au serveur).',
        'WhatsApp, à côté de Facture A4 : envoie le ticket au téléphone du client, avec la facture en PDF si vous le cochez.',
      ],
    },
    {
      title: 'Tarif, dépôt et livraison',
      steps: [
        'Les boutons Tarif (Détail, Gros, Super gros) et Dépôt (Surface de vente, Réserve…) changent le tarif et le dépôt de sortie pour cette fiche seulement ; sans le droit, le code d’un gérant est demandé.',
        'Onglet « Livraison » du ticket : cochez « À livrer », vérifiez l’adresse (reprise de la fiche client), choisissez le jour, le créneau, le livreur et les frais. Au VALIDER, le bon de livraison s’imprime avec le ticket.',
        'Les livraisons se suivent dans Vente › Livraisons du jour.',
      ],
    },
    {
      title: 'Menu Actions',
      steps: [
        'Encaisser un règlement client, payer une dépense avec les espèces du tiroir, facturer un devis.',
        'Apport ou prélèvement d’espèces, retour d’articles d’un client, annulation d’un ticket (code du gérant).',
        '« Consignes (emballages) » : un client rapporte ses vides ou prend des casiers sans achat ; la consigne se rend ou s’encaisse en espèces.',
      ],
    },
    {
      title: 'Consigne des emballages',
      perm: 'containers_counter',
      steps: [
        'Après la vente d’une boisson consignée (casier, bouteille), la fenêtre de consigne s’ouvre avec le nombre d’emballages qui partent.',
        'Tapez dans « Rapportés » les vides que le client ramène : la différence s’affiche « À encaisser » ou « À rendre », en espèces.',
        'Client en compte qui garde les emballages sans payer : cochez « Le client garde les emballages sans payer la consigne ».',
        '« Passer » ferme la fenêtre sans consigne.',
      ],
    },
  ],
  keys: POS_KEYS,
};

export const HELP: Record<WinKind, PageHelp> = {
  cash1: POS,
  cash2: { ...POS, intro: `${POS.intro} La fiche 2 permet de servir un deuxième client sans fermer la première.` },
  credit: {
    title: 'Vente à crédit',
    intro: 'Pour vendre à un client en compte : le reste à payer va sur son compte avec son échéance.',
    sections: [
      {
        title: 'Faire une vente à crédit',
        steps: [
          'F8 choisit le client (obligatoire). Son solde s’affiche en couleur : rouge s’il doit, vert s’il a un avoir.',
          'Ajoutez les produits comme à la vente au comptant.',
          'Saisissez l’acompte éventuel en espèces, puis validez : le reste va au compte du client.',
          'Au-delà de son plafond de crédit, le code d’un gérant est demandé.',
        ],
      },
      { title: 'Facture', steps: ['F9 imprime la facture A4 avec le client, la TVA et l’échéance.'] },
    ],
    keys: POS_KEYS,
  },
  sales: {
    title: 'Factures et registre des ventes',
    intro: 'Retrouver une vente, la réimprimer, voir les clôtures Z et les opérations de caisse.',
    sections: [
      {
        tab: 'tickets',
        title: 'Mes dernières factures',
        steps: ['Cliquez sur une facture pour la voir, puis réimprimez le ticket ou la facture A4.', 'Sans le droit « Voir tout le registre », seules vos trois dernières factures sont visibles.'],
      },
      { tab: 'register', title: 'Registre des ventes', perm: 'sales', steps: ['Filtrez par date, caisse, caissier ou client ; cliquez une ligne pour le détail.'] },
      { tab: 'returns', title: 'Retours et annulations', perm: 'sales', steps: ['Liste des retours d’articles et des tickets annulés, avec le motif et le gérant qui a validé.'] },
      { tab: 'z', title: 'Clôtures Z', steps: ['Chaque journée de caisse clôturée, avec son numéro de Z. Cliquez pour revoir ou réimprimer le Z.'] },
      { tab: 'cashops', title: 'Opérations de caisse', perm: 'sales', steps: ['Apports, prélèvements et dépenses payées au tiroir, par caisse et par jour.'] },
      { tab: 'export', title: 'Export comptable', perm: 'sales', steps: ['Choisissez la période puis « Télécharger le CSV » : le fichier s’ouvre dans Excel.'] },
      {
        tab: 'requests',
        title: 'Demandes de modification de facture',
        perm: ['sale_edit_request', 'sale_edit_approve'],
        steps: [
          'Sans le droit « Modifier une facture », ouvrez la facture puis « Demander la modification… » avec ce qu’il faut changer.',
          'Le gérant la voit dans ses points d’attention et dans cet onglet : « Accorder » ou « Refuser » (avec le motif). Il ne décide jamais de sa propre demande.',
          'Accordée, « Modifier la facture » la recharge dans la caisse, une seule fois. L’ancienne facture reste au registre, annulée et reliée à la nouvelle.',
        ],
      },
    ],
  },
  articles: {
    title: 'Produits',
    intro: 'La liste de tous les produits avec leurs prix, codes-barres et conditionnements.',
    sections: [
      {
        tab: 'list',
        title: 'Chercher et modifier un produit',
        steps: ['Tapez une partie du nom, de la marque ou du code dans la recherche.', 'Cliquez une ligne pour ouvrir sa fiche : prix, TVA, rayon, codes-barres, conditionnements.'],
      },
      {
        tab: 'new',
        title: 'Créer un produit',
        perm: 'articles',
        steps: [
          '« Ajouter / paramétrer une marchandise » : ligne 1, le conditionnement d’achat (carton, palette) avec ses prix.',
          'Lignes 2 à 4 : les conditionnements de vente (paquet, pièce) avec leur nombre par carton ; achat et revient se calculent.',
          'Ajoutez les codes-barres : chaque conditionnement peut avoir le sien.',
          'Photo : « Choisir une image… » à droite de la fiche. Elle est réduite toute seule et s’affiche dans la liste et dans la recherche de la caisse.',
        ],
      },
      {
        tab: 'list',
        title: 'Prix par quantité',
        perm: 'article_price',
        steps: ['Dans la fiche d’un produit vendu à la pièce, « Prix par quantité » : à partir de N pièces, le prix unitaire baisse (jusqu’à 3 paliers, prix décroissants). La caisse l’applique toute seule selon la quantité de la ligne.'],
      },
      {
        tab: 'list',
        title: 'Importer des produits (Excel, CSV)',
        perm: 'import',
        steps: [
          '« Importer (Excel, CSV) » : choisissez le fichier, le format (titres de colonnes, format à colonnes fixes ou un format enregistré) et le mode (créer et mettre à jour, créer seulement, mettre à jour seulement).',
          'Le fichier peut porter les prix d’achat, de vente, de gros et de super gros, les quantités mini, alerte et maxi, et jusqu’à 3 conditionnements avec leur nombre, leurs prix et leur code-barres. « Télécharger le modèle » donne un fichier exemple.',
          '« Vérifier » montre ce qui sera créé, mis à jour ou refusé, ligne par ligne, sans rien enregistrer ; puis « Importer ». Une colonne absente ne change rien sur un produit existant.',
        ],
      },
      {
        tab: 'list',
        title: 'Exporter la liste',
        perm: 'article_export',
        steps: [
          '« Exporter Excel » ou « Exporter CSV » : choisissez un modèle (catalogue complet ré-importable, tarifs, codes-barres, comptage, terminal d’inventaire, valeur du stock) ou cochez vos colonnes et enregistrez-les comme modèle.',
          'Limitez aux produits d’un rayon, d’une famille, d’un fournisseur ou à ceux en sommeil, et choisissez le dépôt pour le stock. En CSV, réglez le séparateur et la virgule décimale.',
        ],
      },
      {
        tab: 'list',
        title: 'Mettre à jour les prix',
        perm: 'price_update',
        steps: [
          '« Mise à jour des prix… » : choisissez les produits (rayon, famille, fournisseur), le prix à changer et la méthode (pourcentage, montant ou coefficient sur l’achat), l’arrondi et les conditionnements concernés.',
          'L’aperçu montre l’ancien et le nouveau prix de chaque produit ; « Appliquer » enregistre tout d’un coup.',
        ],
      },
      {
        tab: 'list',
        title: 'Produit en sommeil, remplaçant et emplacements',
        steps: [
          'Décochez « Actif » pour mettre un produit en sommeil : il reste dans l’historique mais ne se vend plus et ne se commande plus.',
          '« Remplacé par » : la caisse propose ce produit quand le premier est en rupture ou en sommeil.',
          '« Emplacement » par dépôt (allée, étagère) : il s’affiche dans l’export de comptage et aide à retrouver le produit.',
        ],
      },
      { tab: 'shelving', title: 'Rayonnage', steps: ['Rangez les produits par rayon et famille ; ces rayons servent aux inventaires et aux rapports.'] },
    ],
  },
  stock: {
    title: 'Stock',
    intro: 'Quantités par dépôt, réceptions, pertes, transferts, inventaires et péremptions.',
    sections: [
      { tab: 'state', title: 'État du stock', steps: ['Le stock de chaque produit, en cartons, paquets et unités. Les couleurs signalent rupture, alerte et surstock.'] },
      {
        tab: 'multi',
        title: 'Stock multi-magasin (Stock MM)',
        steps: [
          'Une ligne par article, une colonne par magasin et le total : par exemple DOLAIT, 38 pièces à Akwa et 12 à Bastos.',
          'Sous la quantité, l’équivalent en cartons. En rouge : rupture ; en orange : sous le stock d’alerte.',
          'Cliquez une quantité pour voir le détail par dépôt de ce magasin.',
          'Le stock des autres magasins arrive par le serveur central à chaque synchronisation ; la date de leur dernier envoi est rappelée au-dessus du tableau.',
          'Filtrez par nom, code ou famille, ou sur les articles en rupture dans au moins un magasin. Imprimez en A4 ou exportez vers Excel.',
        ],
      },
      { tab: 'receive', title: 'Réception sans commande', steps: ['Choisissez le dépôt, puis scannez chaque produit : le panneau de gauche demande la quantité, le bonus, la remise, le prix, le transport, la manutention, le lot et la date limite des périssables. Entrée passe au champ suivant et, sur le dernier, fait descendre la ligne dans la liste.', 'Un clic sur une ligne de la liste la remonte pour la modifier. Remise en %, en FCFA ou promo « N/M » (12/10 : 12 achetés, 10 payés) : le stock entre au coût net.'] },
      { tab: 'loss', title: 'Pertes et casse', steps: ['Produit, quantité et motif (casse, vol, péremption, consommation) : le stock baisse et la perte est tracée.'] },
      {
        tab: 'transfer',
        title: 'Transfert entre dépôts',
        steps: ['Créez le bon, ajoutez les produits, puis « Expédier » : le bon de route s’imprime.', 'Au dépôt d’arrivée, « Réceptionner » en notant la quantité reçue ; un écart reste visible.'],
      },
      {
        tab: 'inventory',
        title: 'Inventaires',
        perm: ['inventory', 'inventory_count'],
        steps: [
          'Le gérant crée l’inventaire (global ou par rayons) ; la liste des produits s’affiche.',
          'Tapez les quantités comptées, Entrée passe à la ligne suivante. Les ventes faites pendant le comptage sont déduites.',
          'Sur téléphone : les compteurs installent FEDONIX 360 Inventaire (Android). Le gérant ouvre FEDONIX 360 Gérant › Inventaire, affiche le QR code et le téléphone le scanne. Les quantités comptées arrivent ici toutes seules.',
          'Le gérant clôture : le stock est corrigé et la fiche d’écarts s’imprime.',
        ],
      },
      { tab: 'expiry', title: 'Péremptions', steps: ['Les lots qui périment bientôt (J-7, J-3, J-1) ou déjà périmés : déstockez-les en perte.'] },
      { tab: 'monitoring', title: 'Monitoring', steps: ['Pour un produit, chaque mouvement avec le stock avant et après et le login.', 'Le magasinier demande une correction avec un motif ; le gérant la valide.'] },
      {
        tab: 'clearance',
        title: 'Déstockage avant péremption',
        perm: 'clearance',
        steps: [
          'La liste montre les produits dont un lot approche de sa date limite, avec la remise proposée et la valeur menacée au prix de revient.',
          'Les paliers de remise se règlent dans Administration › Paramètres (par exemple « 14:10,7:20,3:30 » : 10 % à 14 jours, 20 % à 7 jours, 30 % à 3 jours).',
          'Changez la remise ou le prix promotionnel d’une ligne si besoin ; « sous le prix de revient » signale une vente à perte, souvent moins coûteuse qu’un produit jeté.',
          'Cochez les produits puis « Créer les promotions » : chaque promotion court jusqu’à la date limite du lot, dans ce magasin seulement. Un produit déjà en promotion est laissé.',
        ],
      },
      {
        tab: 'losses',
        title: 'Démarque',
        perm: 'clearance',
        steps: [
          'Choisissez la période (le mois en cours par défaut) : pour chaque rayon, la casse, les vols, les périmés, la consommation interne et les écarts d’inventaire, au prix de revient.',
          'La dernière colonne rapporte les pertes au chiffre d’affaires du rayon : au-delà de 2 %, elle passe en rouge.',
        ],
      },
      {
        tab: 'cycle',
        title: 'Inventaire tournant',
        perm: 'cycle_count',
        steps: [
          'Choisissez le dépôt : une courte liste de produits à compter cette semaine s’affiche, avec la raison (valeur élevée, écarts passés, jamais compté…).',
          'Le nombre de produits par semaine se règle dans Administration › Paramètres ; décochez ceux à laisser pour plus tard.',
          '« Ouvrir l’inventaire de la semaine » crée un inventaire partiel : saisissez les quantités comptées dans l’onglet Inventaires, puis clôturez-le.',
        ],
      },
    ],
  },
  purchases: {
    title: 'Achats',
    intro: 'Commandes aux fournisseurs, réceptions, factures et paiements.',
    sections: [
      {
        tab: 'orders',
        title: 'Bon de commande',
        perm: 'purchase_orders',
        steps: [
          '« Nouveau bon » : fournisseur, produits et quantités (en cartons), puis « Envoyer » et imprimer.',
          'Par ligne : « Remise % » et « Promo N/M » (12/10 = 12 achetés, 10 payés ; sur 24 cartons, 4 gratuits). Le total est net.',
          'À la livraison, « Réceptionner » : remise et promo du bon sont reprises, le stock entre au coût net ; une livraison partielle laisse un reliquat.',
        ],
      },
      {
        tab: 'direct',
        title: 'Facture directe (sans bon de commande)',
        perm: 'purchase_invoices',
        steps: [
          'Fournisseur, n° de sa facture, date et dépôt, puis les articles avec quantité, prix, remise % et promo N/M.',
          'Remise globale en % ou en FCFA : elle est répartie sur les lignes. Cochez « Réglée tout de suite » pour payer (caisse centrale, MoMo/OM, virement, chèque).',
          '« Enregistrer » : le stock entre au coût net, un bon de réception est créé et la facture va au registre des achats et à l’échéancier. Imprimez-la en A4.',
        ],
      },
      {
        tab: 'reorder',
        title: 'Proposition de commande',
        perm: 'purchase_orders',
        steps: [
          'Les quantités à commander d’après les ventes des 4 dernières semaines et le stock d’alerte ; un bon par fournisseur en un clic.',
          'Calcul « même période l’an dernier (saison) » : les ventes des mêmes semaines l’an dernier, corrigées de l’évolution récente (colonne Tendance). Utile avant les fêtes, la rentrée ou le Ramadan.',
          '« Majoration % » augmente (ou baisse, jusqu’à −50 %) toutes les quantités pour un événement prévu.',
        ],
      },
      {
        tab: 'group',
        title: 'Commandes groupées',
        perm: 'group_orders',
        steps: [
          'Choisissez le fournisseur, puis ajoutez les articles : pour chaque magasin s’affichent son stock et ses ventes des 28 derniers jours.',
          'La quantité proposée couvre 14 jours de vente moins le stock ; corrigez-la magasin par magasin, ainsi que le prix d’achat négocié.',
          '« Créer la commande groupée » : chaque magasin reçoit son propre bon de commande (numéro commun « CG- ») et réceptionne lui-même la marchandise.',
          'La liste du bas montre les commandes groupées passées et combien de magasins ont reçu ; cliquez pour le détail par magasin.',
        ],
      },
      { tab: 'invoices', title: 'Factures fournisseurs', perm: 'purchase_invoices', steps: ['Saisissez la facture à partir des bons de réception, puis enregistrez les paiements.'] },
      { tab: 'due', title: 'Échéancier', perm: 'purchase_invoices', steps: ['Ce qui reste à payer à chaque fournisseur, avec les retards en rouge.'] },
      {
        tab: 'returns',
        title: 'Retours fournisseur',
        perm: 'supplier_returns',
        steps: [
          '« Nouveau retour fournisseur » : fournisseur, dépôt, motif (casse, périmés, erreur de livraison), puis les articles et quantités rendus. La marchandise sort du stock dès l’enregistrement ; imprimez le bon pour le livreur.',
          'Le retour reste « Avoir attendu » : le haut de l’écran montre ce que chaque fournisseur vous doit en avoirs.',
          'Quand l’avoir arrive, ouvrez le retour et « Saisir l’avoir reçu » (n°, date, montant accordé) : il vient en déduction de ce que vous devez au fournisseur.',
        ],
      },
    ],
  },
  suppliers: {
    title: 'Fournisseurs',
    intro: 'Fiches des fournisseurs, leurs articles et leur compte.',
    sections: [
      { tab: 'list', title: 'Fiche fournisseur', steps: ['Cliquez un fournisseur pour sa fiche : NIU, délais de paiement et de livraison, articles référencés avec prix négocié.'] },
      { tab: 'statement', title: 'Extrait de compte', steps: ['Factures, avoirs et paiements d’un fournisseur sur une période, avec le solde.'] },
      { tab: 'situation', title: 'Situation', perm: 'purchase_invoices', steps: ['Ce que l’on doit à chaque fournisseur.'] },
      {
        tab: 'bonus',
        title: 'Bonus fournisseurs',
        perm: 'free_goods',
        steps: [
          'Dans la fiche fournisseur, sur un article : « 12 achetés, 10 payés ». Le bonus est proposé tout seul sur les bons de commande de ce fournisseur.',
          'L’onglet « Bonus fournisseurs » totalise les unités gratuites reçues sur la période et leur valeur au prix d’achat.',
        ],
      },
    ],
  },
  customers: {
    title: 'Clients',
    intro: 'Fiches clients, comptes, règlements et ristournes.',
    sections: [
      { tab: 'list', title: 'Fiche client', steps: ['« Nouveau client » ou cliquez un client : téléphone, NIU, tarif (détail, gros), plafond de crédit et délai de paiement.'] },
      {
        tab: 'list',
        title: 'Carte de fidélité',
        steps: [
          'À activer dans Administration › Paramètres › Carte de fidélité (points par achat, valeur d’un point, minimum).',
          'Onglet « Fidélité » de la fiche : solde, mouvements, « Imprimer sa carte », correction avec motif (gérant).',
          'À la caisse, scannez la carte ou tapez le téléphone du client ; il paie avec « Points fidélité » dans l’encaissement.',
        ],
      },
      { tab: 'statement', title: 'Extrait de compte', steps: ['Ventes à crédit et règlements d’un client sur une période ; imprimez le relevé pour le lui remettre.'] },
      { tab: 'payments', title: 'Règlements', steps: ['Liste des règlements reçus. Pour encaisser : « Encaisser un règlement » sur le compte du client, ou à la caisse par Action.'] },
      {
        tab: 'receivables',
        title: 'Situation (balance âgée)',
        perm: 'receivables',
        steps: [
          'Ce que doit chaque client, par ancienneté du retard, avec la date de sa dernière relance.',
          '« Relancer » (ou « Relancer les clients en retard ») : le message rempli s’ouvre, modifiable ; « Ouvrir WhatsApp » l’envoie au téléphone du client, « Relevé en PDF » prépare le relevé à joindre. Chaque relance est notée.',
        ],
      },
      {
        tab: 'list',
        title: 'Remises par famille',
        perm: 'customer_price_level',
        steps: ['Dans la fiche du client, « Remises par famille » : un pourcentage par famille d’articles (0 à 50 %). La caisse l’applique toute seule à ce client, sans code du gérant, après les prix par quantité.'],
      },
      {
        tab: 'summary',
        title: 'Factures récapitulatives',
        perm: 'summary_invoices',
        steps: [
          'Choisissez le client et la période (le mois dernier par défaut) : ses tickets et factures pas encore regroupés s’affichent, cochés.',
          '« Créer la facture récapitulative » puis « Imprimer » : une seule facture avec le détail de chaque vente, la TVA par taux et ce qui est passé à son compte.',
          'Les ventes sont déjà comptabilisées à leur date : la récapitulative ne passe pas d’écriture. Une vente ne figure que sur une récapitulative ; « Annuler la facture » la libère.',
        ],
      },
      {
        tab: 'list',
        title: 'Prix négociés, zones et lettrage',
        steps: [
          'Fiche client, « Prix négociés par article » : un prix convenu par article. La caisse le prend quand il est plus bas que le prix du jour.',
          '« Zone ou tournée » range les clients par quartier ; la liste et la balance âgée se filtrent par zone pour la tournée du livreur ou du recouvreur.',
          'En encaissant un règlement, cochez les factures que le client règle : elles sont soldées en premier, le reste va aux plus anciennes.',
        ],
      },
      {
        tab: 'offsets',
        title: 'Compensations client / fournisseur',
        perm: 'account_offsets',
        steps: [
          'Un grossiste à qui l’on achète et qui nous achète : reliez sa fiche client à sa fiche fournisseur (« Aussi fournisseur »).',
          '« Compenser avec son compte fournisseur… » solde une facture fournisseur avec ce qu’il doit, sans argent. L’écriture passe en OD (401 / 411) ; une erreur s’annule avec motif.',
        ],
      },
      {
        tab: 'consignment',
        title: 'Dépôt-vente',
        perm: 'consignment',
        steps: [
          '« Ouvrir un dépôt-vente » pour un client revendeur, puis « Confier de la marchandise » : elle reste à votre stock, dans son dépôt.',
          'À chaque passage, « Fiche de contrôle » : comptez ce qui reste. Le manque est facturé à crédit au client, à son tarif, sur votre caisse ouverte ; cochez « Reprendre » pour rapporter le reste.',
        ],
      },
      { tab: 'rebates-state', title: 'Ristournes', perm: 'rebates', steps: ['Réglez les taux par famille, puis chaque mois « Constater » et « Accorder » en avoir ou en bon.', 'Payée : en espèces depuis la caisse centrale, ou par MTN MoMo / Orange Money depuis une caisse électronique (la centrale par défaut), avec la référence du transfert.'] },
    ],
  },
  expenses: {
    title: 'Dépenses et charges',
    intro: 'Loyer, ENEO, salaires, transport… avec leur compte comptable.',
    sections: [
      { tab: 'new', title: 'Saisir une dépense', steps: ['Catégorie, libellé, bénéficiaire, montant et moyen de paiement (référence hors espèces), puis Enregistrer.', 'Une dépense en espèces d’un caissier sort de sa caisse et imprime un bon de sortie.', 'Payée par MoMo ou Orange Money : le caissier paie avec son compte (sa caisse électronique) ; au bureau, choisissez la caisse électronique, la centrale par défaut.'] },
      { tab: 'plans', title: 'Charges fixes', steps: ['Déclarez le loyer, les salaires… une fois : chaque mois, le constat attendu s’affiche.'] },
      { tab: 'schedule', title: 'Constats de charges', steps: ['Les charges du mois à constater ; une charge en retard s’affiche dans la barre du bas.'] },
    ],
  },
  quotes: {
    title: 'Devis et factures proforma',
    intro: 'Préparer un devis ou une proforma pour un client, puis le facturer à la caisse.',
    sections: [
      { title: 'Faire un devis', steps: ['« Nouveau devis », puis choisissez Devis ou Facture proforma : client (ou simple nom), produits, remises et durée de validité.', 'Imprimez : le montant est écrit en lettres, avec le « Bon pour accord ».'] },
      { title: 'Facturer', steps: ['À la caisse, Action › Facturer un devis : les prix du devis sont garantis jusqu’à sa date de validité.'] },
    ],
  },
  deliveries: {
    title: 'Livraisons du jour',
    intro: 'Les ventes à porter chez le client : à préparer, en route, livrées. Elles se saisissent à la caisse, dans l’onglet Livraison du ticket.',
    sections: [
      {
        title: 'Suivre une livraison',
        steps: [
          '« Partir 🚚 » quand le livreur s’en va (l’heure est notée), puis « Livrée ✓ » à son retour.',
          '« Bon » réimprime le bon de livraison ; ✕ retire la livraison sans annuler la vente.',
          'Pour une vente à crédit, « À encaisser » montre ce que le livreur doit rapporter : à « Livrée », le logiciel propose d’enregistrer le règlement du client.',
          'À « Partir », si le client a un téléphone, le logiciel propose de le prévenir par WhatsApp : « Votre commande … est en route avec … ».',
        ],
      },
      {
        title: 'Feuille de route',
        steps: [
          'Avant le départ, « Feuille de route » à côté du nom du livreur imprime ses livraisons du jour (de demain si « Demain » est choisi) : client, téléphone, adresse et montant à encaisser.',
        ],
      },
      {
        title: 'Retour du livreur',
        perm: 'courier_returns',
        steps: [
          'Au retour, « Retour du livreur » : choisissez le livreur, ses livraisons faites et pas encore rendues s’affichent avec le montant à encaisser.',
          'Corrigez la colonne « Encaissé » si un client n’a pas tout payé (le reste demeure sur son compte), puis tapez les espèces remises : un manquant s’affiche en rouge.',
          '« Enregistrer le retour » (caisse ouverte) : l’argent entre dans le tiroir comme règlement de chaque client et l’écart reste noté dans l’historique des retours.',
        ],
      },
    ],
  },
  orders: {
    title: 'Commandes clients',
    intro: 'Les commandes prises par téléphone ou WhatsApp avant la vente : préparées, puis encaissées à la caisse à la livraison ou au retrait.',
    sections: [
      {
        title: 'Prendre une commande',
        steps: [
          '« Nouvelle commande » : origine (téléphone, WhatsApp, au magasin), client et téléphone, adresse (vide si le client vient la chercher), jour et créneau, frais de livraison, articles.',
          '« Confirmer par WhatsApp » ouvre WhatsApp avec le récapitulatif de la commande pour le client.',
        ],
      },
      {
        title: 'Commandes en ligne',
        steps: [
          'Quand la boutique en ligne est ouverte (Administration › Paramètres), les commandes passées sur internet s’affichent en haut de l’écran : « Commandes en ligne (n) ». La liste se met à jour toutes les minutes.',
          '« Prendre » enregistre la commande dans ce magasin, avec l’origine « Boutique en ligne » ; un seul PC peut la prendre. Les articles inconnus ou inactifs ne sont pas repris : leur nom s’affiche.',
          'Ensuite, la commande se prépare et s’encaisse comme les autres.',
        ],
      },
      {
        title: 'Commander ce qui manque (contremarque)',
        steps: [
          'Si le stock ne couvre pas la commande, « Commander au fournisseur ce qui manque » : les quantités manquantes partent sur le bon de commande en préparation du fournisseur habituel, ou sur un nouveau bon.',
          'La colonne « Chez le fournisseur » montre le n° du bon et ce qui est déjà reçu.',
        ],
      },
      {
        title: 'Préparer',
        steps: [
          'Mettez la marchandise de côté, puis cliquez sur « Préparée » : ces quantités sont réservées, la caisse refuse de les vendre à un autre client.',
          'Modifier une commande préparée la remet « à préparer ». « Remettre à préparer » ou « Annuler » (avec un motif) libèrent la réservation.',
        ],
      },
      {
        title: 'Encaisser',
        steps: [
          'À la caisse, Action › Charger une commande client : articles au prix du jour, client et livraison sont repris.',
          'Validez comme une vente (espèces, Mobile Money ou crédit) : la commande passe « facturée » et la livraison suit dans Vente › Livraisons du jour.',
        ],
      },
    ],
  },
  promotions: {
    title: 'Promotions',
    intro: 'Prix promotionnels et offres « 3 pour 2 » appliqués tout seuls à la caisse.',
    sections: [
      { title: 'Créer une promotion', steps: ['Produit, type (prix promo, N achetés M payés, lot à prix fixe), période et magasins.', 'La caisse applique la meilleure promotion de chaque article, sans code gérant.'] },
      { title: 'Suivre', steps: ['Quantités vendues et économie accordée ; « Arrêter » met fin à une promotion tout de suite.'] },
    ],
  },
  labels: {
    title: 'Étiquettes et codes-barres',
    intro: 'Imprimer les étiquettes des prix à jour, et les codes-barres à coller sur les articles.',
    sections: [
      { title: 'Étiquettes de rayon', steps: ['La liste « À refaire » montre les produits reçus jamais étiquetés et les prix changés.', 'Choisissez la planche (24, 40 ou 65 par page) ou le rouleau, vérifiez l’aperçu puis imprimez.'] },
      {
        title: 'Codes-barres produit',
        steps: [
          'Un article sans code fabricant reçoit un code interne EAN-8 (commence par 2) à son enregistrement, pour l’unité et pour chaque carton.',
          '« Leur donner un code interne » équipe d’un coup les articles créés avant.',
          'Cochez les articles, le nombre d’étiquettes, puis « Imprimer les codes-barres… » : rouleau 30 × 20, 40 × 25, 50 × 30 mm ou planche A4.',
          'Aussi depuis la fiche article (« Imprimer les codes-barres… ») et après chaque réception d’achat.',
        ],
      },
    ],
  },
  reports: {
    title: 'Rapports de ventes',
    intro: 'Le chiffre d’affaires par jour, rayon, article, caissier, client ou moyen de paiement.',
    sections: [
      { title: 'Lire un rapport', steps: ['Choisissez la période (hier, cette semaine, ce mois…) puis le regroupement.', 'Imprimez, ou « Exporter » en CSV pour Excel.'] },
      { title: 'Palmarès et produits sans vente', steps: ['Par article, rayon ou client, le classement donne le rang et la classe A, B ou C : A fait 80 % du chiffre, C les derniers 5 %.', '« Produits sans vente » liste les produits actifs non vendus sur la période, avec leur stock, et s’exporte en Excel.'] },
    ],
  },
  accounting: {
    title: 'Comptabilité',
    intro: 'Écritures SYSCOHADA passées toutes seules à partir des ventes, achats et dépenses.',
    sections: [
      { tab: 'journals', title: 'Journaux', steps: ['Les écritures par journal (ventes, achats, caisse, banque, Mobile Money) ; saisie d’écritures manuelles équilibrées.'] },
      { tab: 'ledger', title: 'Grand livre', steps: ['Tapez un compte (571, 411…) ou un tiers : chaque écriture avec le solde progressif.'] },
      { tab: 'balance', title: 'Balance', steps: ['Tous les comptes avec débit, crédit et solde ; cliquez un compte pour son détail.'] },
      { tab: 'vat', title: 'Déclaration de TVA', steps: ['Le mois à déclarer : CA par taux, TVA collectée et déductible, crédit reporté, plus l’acompte d’impôt. Imprimez pour la DGI.'] },
      { tab: 'statements', title: 'États financiers', steps: ['Bilan, compte de résultat et flux de trésorerie de l’exercice, avec les références de la DSF.'] },
      { tab: 'bank', title: 'Rapprochement bancaire', steps: ['Importez le relevé CSV de la banque ou de l’opérateur ; le pointage se fait tout seul, le reste à la main.'] },
      {
        tab: 'cheques',
        title: 'Remises de chèques',
        perm: 'cheque_deposits',
        steps: [
          'Les chèques reçus en caisse ou en règlement d’un client restent au compte 513 « Chèques à encaisser ».',
          'Cochez les chèques portés à la banque, la date et la banque, puis « Créer et imprimer le bordereau » : une seule écriture 521 / 513, facile à retrouver sur le relevé.',
        ],
      },
      {
        tab: 'unpaid',
        title: 'Chèques revenus impayés',
        perm: 'cheque_rejections',
        steps: [
          'La liste montre les chèques reçus ces 90 derniers jours, remis en banque ou pas encore.',
          '« Revenu impayé » : date du rejet, frais prélevés par la banque et motif. Pour un chèque de client comptoir, choisissez le client à qui le réclamer. La case « Interdire les chèques à ce client » est cochée d’office.',
          'Le montant du chèque et les frais retournent au compte du client et apparaissent sur son relevé ; l’écriture reprend la banque (ou le compte 513 si le chèque n’était pas encore remis).',
          '« Annuler » sur un impayé saisi par erreur : le chèque redevient bon.',
        ],
      },
      {
        tab: 'forecast',
        title: 'Trésorerie prévisionnelle',
        perm: 'cash_forecast',
        steps: [
          'Semaine par semaine : la trésorerie d’aujourd’hui, les échéances des clients, les factures fournisseurs et les charges fixes à payer. Ce qui est déjà en retard compte la première semaine.',
          'Cochez « Ajouter les ventes et achats comptant habituels » pour une prévision complète (moyenne des 4 dernières semaines). Une semaine en rouge annonce un manque d’argent.',
        ],
      },
      {
        tab: 'budgets',
        title: 'Budgets',
        perm: 'budgets',
        steps: [
          '« Ajouter un budget » : un compte de charges (6) ou de produits (7) et un montant par mois (ou le même pour les 12 mois).',
          'Chaque mois : budget, réel et écart, pour le mois et depuis janvier. Un écart positif est favorable.',
        ],
      },
      {
        tab: 'analytics',
        title: 'Analytique',
        perm: 'analytics',
        steps: ['Par rayon ou par magasin : chiffre d’affaires HT, marge et résultat après les charges réparties au prorata du chiffre d’affaires.'],
      },
      {
        tab: 'patrimony',
        title: 'Courbe du patrimoine',
        perm: 'patrimony',
        steps: [
          'À chaque fin de mois : trésorerie + créances clients + stock au prix de revient − dettes fournisseurs. Survolez un mois pour son détail.',
          'Avec le droit « Sociétés », la courbe se voit aussi pour tous les magasins ou pour une société.',
        ],
      },
      {
        tab: 'assets',
        title: 'Immobilisations',
        perm: 'fixed_assets',
        steps: [
          '« Nouvelle immobilisation » : choisissez la catégorie (elle propose le compte et la durée), le nom du bien, sa valeur HT et sa date de mise en service.',
          'Un bien que le magasin avait déjà avant FEDONIX 360 se saisit en « Bien repris » : ses amortissements d’avant la reprise sont comptés, sans dotation en double.',
          'La dotation de chaque exercice se passe toute seule à sa date de fin. Cliquez un bien pour son plan d’amortissement ; « Vendre ou mettre au rebut » le sort du registre.',
        ],
      },
    ],
  },
  treasury: {
    title: 'Opérations de trésorerie',
    intro: 'Ouvrir et clôturer la caisse, suivre les journées et la caisse centrale.',
    sections: [
      {
        tab: 'day',
        title: 'Ouvrir la caisse',
        steps: [
          '« Ouvrir la caisse… » : le fond laissé la veille est proposé. Validez sans code.',
          'Seul un fond plus élevé, pris dans la caisse centrale, demande le code du gérant.',
          'Vos caisses électronique et banque s’ouvrent en même temps (bloc « Mes autres caisses »).',
        ],
      },
      {
        tab: 'day',
        title: 'Clôturer la caisse',
        steps: [
          '« Fermer la caisse… » : comptez les billets et pièces par coupure.',
          'Indiquez le fond laissé dans le tiroir ; le reste est versé à la caisse centrale avec un bon à signer.',
          'Caisse électronique : « Clôturer… ». Vos sorties du jour par ce compte (dépenses, remboursements) s’affichent. Saisissez le solde lu sur chaque téléphone.',
          'Avec une caisse électronique centrale : transférez votre recette vers le numéro du magasin, notez la référence de chaque transfert, puis « Clôturer et verser ». Ce que vous gardez reste pour demain. Imprimez le bon de versement.',
        ],
      },
      {
        tab: 'day',
        title: 'Encaisser et décaisser',
        perm: 'cash_desk',
        steps: [
          '« Encaisser » (volet Entrées) : client qui règle, fournisseur qui rembourse un avoir, collaborateur qui rend une avance, ou autre recette sur un compte. Un reçu s’imprime.',
          '« Décaisser » (volet Sorties) : reversement à la caisse centrale, règlement d’une facture fournisseur, charge, avance ou salaire d’un collaborateur, avoir remboursé à un client, ou autre. Le code du gérant est demandé et un bon s’imprime.',
          'Sur une caisse électronique, le mode est MTN MoMo ou Orange Money, avec la référence de la transaction.',
          'Cliquez une ligne puis « Action » : imprimer le reçu (ticket ou A4), décharge à faire signer, antidater, convertir une sortie « Autre » en règlement fournisseur ou remboursement client, supprimer.',
          '« Totaux par nature d’entrée / sortie », sous les volets, résume la journée.',
        ],
      },
      {
        tab: 'day',
        title: 'Journal d’une caisse électronique',
        perm: 'cash_amounts',
        steps: [
          'Choisissez la caisse électronique : « Entrées et sorties du compte » liste les ventes et règlements reçus, puis les remboursements, dépenses, fournisseurs et le versement, avec la référence de chaque transfert.',
          'L’attendu = solde de départ + encaissé + transferts reçus − sorties.',
        ],
      },
      {
        tab: 'day',
        title: 'Relève d’équipe',
        steps: [
          '« Relève d’équipe… » quand un caissier en remplace un autre sans fermer la caisse.',
          'Le caissier qui part compte le tiroir par coupure, sans voir l’attendu. Celui qui arrive tape son identifiant (ou scanne son badge) et son code.',
          'Le bon de passation s’imprime avec l’attendu, le compté et l’écart de celui qui part : signez-le tous les deux.',
          'La journée continue : même fond, même Z. Le Z donne les ventes et l’écart de chaque caissier.',
        ],
      },
      { tab: 'history', title: 'Historique et écarts', perm: 'cash_amounts', steps: ['Le filtre « Type » montre les caisses espèces, électroniques ou banque.', 'Un écart au-delà du seuil se justifie avec « Justifier l’écart… ».'] },
      { tab: 'central', title: 'Caisse centrale', perm: 'central_cash', steps: ['Entrées (banque, exploitant) et sorties (dépôt en banque…) avec bon imprimé ; le livre montre le solde.'] },
      {
        tab: 'emoney',
        title: 'Caisses électroniques et centrale',
        perm: 'central_cash',
        steps: [
          'Le tableau donne le solde MTN et Orange de chaque caisse électronique ; la centrale est en premier.',
          'Cliquez une caisse pour voir son livre : versements reçus des caissiers, dépenses et fournisseurs payés au bureau, transferts, dépôts à la banque.',
          '« Sortie ou transfert… » : vers une autre caisse électronique, la banque ou l’exploitant, avec la référence de la transaction et un bon imprimé.',
        ],
      },
    ],
  },
  dashboard: {
    title: 'Tableau de bord et points d’attention',
    intro: 'Les chiffres du jour et ce qui attend une action.',
    sections: [
      { tab: 'day', title: 'La journée', steps: ['CA, tickets, panier moyen, marge par rayon, ventes par heure et meilleures ventes.'] },
      { tab: 'attention', title: 'Points d’attention', steps: ['Une tuile par point à traiter (ruptures, écarts de caisse, factures en retard…). Cliquez une tuile pour ouvrir l’écran concerné.'] },
    ],
  },
  admin: {
    title: 'Administration',
    intro: 'Magasins, caisses, utilisateurs, droits, paramètres et sauvegardes.',
    sections: [
      {
        tab: 'warehouses',
        title: 'Dépôts',
        steps: [
          '« Modifier » change le nom, le type (magasin, réserve, chambre froide…), le responsable, le téléphone et l’adresse du dépôt.',
          '« Désactiver » retire un dépôt des listes. Il faut d’abord le vider de son stock, finir ses transferts et ses inventaires, et ce ne doit pas être le dépôt des ventes. « Réactiver » le remet en service.',
          '« Dépôt des ventes » choisit le dépôt d’où sort la marchandise vendue en caisse.',
          'Usage « Avaries » : la marchandise abîmée y est mise à part ; elle ne se vend jamais et ne compte pas dans les propositions de commande.',
        ],
      },
      {
        tab: 'companies',
        title: 'Sociétés',
        perm: 'companies',
        steps: [
          '« Nouvelle société » : raison sociale, forme, NIU, RCCM. Rattachez ensuite chaque magasin à sa société.',
          '« Chiffres consolidés » : ventes du mois, trésorerie, créances, stock, dettes et patrimoine de chaque magasin et de la société.',
        ],
      },
      { tab: 'registers', title: 'Caisses', steps: ['Choisissez le type (Espèces, Électronique, Banque) puis « Ajouter une caisse ».', 'Le code d’activation d’une caisse espèces rattache un nouveau PC.'] },
      {
        tab: 'users',
        title: 'Utilisateurs',
        steps: [
          '« Ajouter un employé » ouvre la fiche « Nouvel employé » : nom, identifiant, code, rôle et caisses, puis, en une fois, sa fiche collaborateur (poste, téléphone, salaire) et son badge.',
          'Dans la fiche d’un utilisateur, l’identifiant se modifie (lettres, chiffres, point, tiret ; 2 à 30 caractères).',
          'Badge : « Créer son badge » donne un code-barres imprimé sur une carte. À la connexion, le scanner remplit l’identifiant ; il reste à taper le code. « Refaire » rend l’ancien badge inutilisable.',
          'Photo (badge) : « Prendre une photo » utilise la caméra du PC, « Importer… » une image. Elle est recadrée au format photo d’identité et s’imprime sur son badge.',
          '« Supprimer l’utilisateur » : sans aucune opération, il est effacé ; sinon il disparaît des listes et ne se connecte plus, son nom reste sur ses tickets et son identifiant redevient libre.',
          'La colonne Privilèges montre ce qui est ajouté (+) ou retiré (−) à son rôle. Un utilisateur « bloqué » après trop de codes faux se débloque avec « Débloquer ».',
        ],
      },
      {
        tab: 'brand',
        title: 'Couleurs et badges',
        steps: [
          'Choisissez la couleur principale et la couleur secondaire de l’entreprise, ou une palette toute prête : tout l’écran change aussitôt. « Enregistrer » les garde pour tous les postes et tous les magasins.',
          'Les badges, les cartes de fidélité et les en-têtes de tableau des documents A4 prennent aussi ces couleurs. Le texte posé sur une couleur claire passe en noir pour rester lisible.',
          'Badge : choisissez le modèle (Bandeau, Arcs ou Angles), la taille (carte bancaire, grand badge ou format libre en mm), le sens et les éléments imprimés : logo, nom du magasin, rôle, photo, matricule, poste, téléphone, expiration, code-barres, décor.',
          'Le matricule, le poste, le téléphone et la date d’entrée viennent de la fiche collaborateur ; la photo, de la fiche de l’utilisateur.',
          '« Imprimer aussi le verso » ajoute à côté du recto les règles du badge, les dates d’entrée et d’expiration et une ligne de signature.',
          'L’aperçu montre un exemple ou le badge d’un employé. « Imprimer tous les badges » sort ceux de tous les employés qui ont un badge, sur des feuilles A4 à découper.',
        ],
      },
      {
        tab: 'rights',
        title: 'Droits par rôle',
        steps: [
          'Choisissez un rôle, puis un groupe à gauche (Facturation, Trésorerie, Gestion des stocks…). Cherchez un droit par son nom.',
          'Chaque droit indique son type : Menu (ouvre un écran), Bouton (une action), Fonction (une règle). « Tout cocher » coche le groupe entier.',
          'Ce qui n’est pas permis disparaît des menus et des boutons.',
        ],
      },
      {
        tab: 'privileges',
        title: 'Privilèges par utilisateur',
        steps: [
          'Choisissez un utilisateur : « Via son rôle » montre ce que son rôle lui donne.',
          'Cochez « Attribué » pour lui donner un droit en plus, ou « Retiré » pour lui enlever un droit de son rôle, sans toucher aux autres utilisateurs du même rôle.',
          'En bas, « Autres utilisateurs ayant ce privilège » liste qui a déjà le droit sélectionné.',
        ],
      },
      {
        tab: 'settings',
        title: 'Paramètres',
        steps: [
          'Les paramètres sont rangés par section : identité du magasin (logo, RCCM, message du ticket), ventes et caisse, caisses électroniques (centrale ou indépendantes), crédit clients, stock, achats, sécurité, numérotation des pièces, imprimante, balance, affichage.',
          'Tapez un mot dans la recherche pour retrouver un paramètre, puis « Enregistrer ».',
          'Les sections « (ce PC) » ne valent que pour ce poste ; les autres valent pour tout le magasin.',
          'Boutique en ligne et vérificateur de prix : ouvrez la boutique, la livraison, ses frais, le montant minimal et le message, ou le vérificateur de prix. Sur un PC relié au serveur, les deux liens à partager s’affichent avec « Copier ». Les réglages parviennent au serveur avec la prochaine synchronisation.',
        ],
      },
      {
        tab: 'templates',
        title: 'Modèles d’impression',
        steps: [
          'Une ligne par modèle : document (facture client, devis et proforma, bon de livraison, bon de commande, facture d’achat), format (ticket de caisse, A4, listing), variante (comptant, à terme, devis, proforma, commande, facture fournisseur). La coche « Par défaut » désigne le modèle utilisé à l’impression.',
          '« Modifier » ouvre l’éditeur : papier, marges, police, hauteurs de l’en-tête, du pied et des lignes, champs du magasin et du client, colonnes du tableau (afficher, renommer, largeur, ordre), totaux et mentions. L’aperçu à droite suit chaque changement.',
          '« Copier » crée un autre modèle à partir de celui choisi ; « Rétablir l’original » remet un modèle du logiciel tel qu’il était livré.',
          'Dans Ventes ou la fiche d’un client, « Facture… » ouvre l’aperçu avant impression : changez de modèle (facture ou bon de livraison), imprimez ou enregistrez en PDF. Dans la fiche d’un devis, d’une commande fournisseur ou d’une facture d’achat, « Aperçu et impression… » fait de même.',
        ],
      },
      {
        tab: 'takeover',
        title: 'Reprise des données',
        perm: 'data_takeover',
        steps: [
          'Pour un magasin qui passe à FEDONIX 360 : choisissez le fichier à reprendre (clients, fournisseurs ou stock de départ) et téléchargez le modèle Excel.',
          'Remplissez-le (ou exportez la liste de l’ancien logiciel avec les mêmes en-têtes), puis « Choisir le fichier rempli » : l’aperçu montre ce qui sera fait et les lignes à corriger.',
          '« Importer » enregistre tout d’un bloc et passe les à-nouveaux contre le compte 4711. S’il reste une erreur, rien n’est importé : corrigez le fichier et recommencez.',
        ],
      },
      {
        tab: 'backups',
        title: 'Sauvegardes',
        steps: [
          'Choisissez un dossier (clé USB, autre disque) ; une sauvegarde se fait chaque jour. « Restaurer » reprend une sauvegarde.',
          'Sauvegarde en ligne (PC relié au serveur) : choisissez une phrase secrète de 8 caractères au moins et notez-la en lieu sûr, puis activez. Après chaque sauvegarde, une copie chiffrée part sur le serveur.',
          'Sans la phrase secrète, les copies en ligne ne peuvent pas être lues : l’éditeur ne la connaît pas.',
          'Sur un nouveau PC : « Voir les copies en ligne », « Récupérer » avec la phrase secrète ; la sauvegarde arrive dans la liste et se restaure comme les autres.',
        ],
      },
      {
        tab: 'server',
        title: 'Serveur central',
        steps: [
          'Adresse du serveur qui relie les PC et les magasins ; l’état s’affiche dans la barre du bas.',
          'Sur votre téléphone : ouvrez l’adresse du serveur suivie de /gerant, connectez-vous avec le mot de passe de FEDONIX 360 Serveur, puis « Ajouter à l’écran d’accueil ». Ventes du jour, caisses, écarts, ruptures et alertes de chaque magasin.',
        ],
      },
      {
        tab: 'updates',
        title: 'Mises à jour',
        steps: [
          'Le PC cherche une nouvelle version au démarrage puis toutes les 4 heures, sur le serveur central ou à l’adresse saisie ici.',
          'La version téléchargée s’installe à la fermeture du logiciel, ou tout de suite avec « Installer maintenant ».',
          'Pour proposer une version aux PC : FEDONIX 360 Serveur › Mises à jour › déposer le fichier Fedonix360-Setup-x.y.z.exe.',
        ],
      },
      {
        tab: 'mobilepay',
        title: 'Paiement mobile',
        steps: [
          'Choisissez le mode de MTN MoMo et d’Orange Money sur ce PC : Simulation pour essayer sans compte, Test MTN avec la clé d’abonnement de momodeveloper.mtn.com, ou Réel avec les clés du compte marchand.',
          'Test MTN : enregistrez la clé d’abonnement « Collections », puis « Créer l’accès de test ». Numéro de test 46733123453 (payé) ou 46733123450 (refusé).',
          'Les clés restent sur ce PC ; réglez chaque PC qui encaisse par Mobile Money. « Dernières demandes » montre chaque demande, son état et son numéro de transaction.',
        ],
      },
      {
        tab: 'license',
        title: 'Licence',
        steps: [
          'Envoyez le code machine de ce PC à votre fournisseur (bouton « Envoyer par WhatsApp »), puis collez la clé reçue et « Activer la licence ».',
          'Sans licence, le logiciel fonctionne 15 jours en essai. À la fin de la licence, la caisse vend encore 15 jours, puis s’arrête ; la consultation, la clôture et les sauvegardes restent possibles.',
          'Les autres PC reliés au serveur central reçoivent la licence tout seuls, dans la limite du nombre de PC qu’elle permet.',
          '« Lire le contrat de licence » affiche les conditions d’utilisation acceptées à l’installation.',
        ],
      },
      {
        tab: 'digest',
        title: 'Résumé du jour',
        steps: [
          'Choisissez la journée : le résumé montre les ventes, les encaissements, les caisses et leurs écarts, les meilleures ventes et ce qui demande votre attention.',
          '« Envoyer par WhatsApp » ouvre WhatsApp avec le résumé, adressé au numéro du gérant réglé à droite.',
          'Pour l’envoi automatique, l’administrateur coche « Envoyer le résumé chaque soir », choisit l’heure, les destinataires et le compte e-mail qui envoie. Ce PC doit être allumé avec FEDONIX 360 ouvert ; sinon le résumé de la veille part au démarrage suivant.',
        ],
      },
    ],
  },
  production: {
    title: 'Fabrication',
    intro: 'Produits faits maison (paniers, jus) à partir d’autres produits du stock.',
    sections: [
      { tab: 'recipes', title: 'Recette', steps: ['Le produit fini et ses composants pour un lot ; le coût de revient et la marge s’affichent.'] },
      { tab: 'orders', title: 'Ordre de fabrication', steps: ['« Nouvel ordre » : recette et quantité, puis « Fabriquer » : les composants sortent du stock, le produit fini entre.'] },
    ],
  },
  containers: {
    title: 'Emballages consignés',
    intro: 'Casiers et bouteilles consignés : la consigne encaissée, les vides au magasin, chez les clients et à rendre aux brasseries.',
    sections: [
      {
        tab: 'types',
        title: 'Types d’emballages',
        perm: 'containers',
        steps: [
          '« Nouvel emballage » : son nom (Casier 12, Bouteille 65 cl) et le montant de sa consigne en FCFA.',
          'Sur la fiche de chaque boisson, choisissez son « Emballage consigné » et le nombre d’unités par emballage (12 pour un casier de 12 bouteilles, 1 pour une bouteille).',
          'Un emballage qui ne sert plus se décoche « Actif » : son historique reste.',
        ],
      },
      {
        tab: 'situation',
        title: 'Situation',
        perm: 'containers',
        steps: [
          'Pour chaque emballage : les vides au magasin, ceux chez les clients, les consignes encaissées (à rendre aux clients, compte 4194) et ce qui est à rendre aux fournisseurs.',
          'En dessous : les clients qui gardent des emballages (avec ou sans consigne payée) et ce que chaque fournisseur attend en retour.',
          '« Reçus du fournisseur » à la livraison, « Vides rendus au fournisseur » quand la brasserie reprend les vides, « Casse ou comptage » pour corriger les vides (nombre négatif pour une casse, motif obligatoire).',
        ],
      },
      {
        tab: 'moves',
        title: 'Mouvements',
        steps: [
          'Tous les mouvements d’emballages, filtrés par emballage et par dates : sorties et retours des clients, réceptions et retours fournisseurs, casse.',
          '« Annuler » (avec un motif) annule un mouvement saisi par erreur ; la consigne encaissée ou rendue avec est annulée aussi, tant que la journée de caisse est ouverte.',
        ],
      },
      {
        title: 'Consigne au comptoir',
        perm: 'containers_counter',
        steps: [
          '« Consigne au comptoir » : choisissez le client (facultatif), puis pour chaque emballage le nombre sorti et le nombre de vides rapportés.',
          'La différence s’encaisse ou se rend en espèces dans la journée de la caisse ouverte. Un client en compte peut garder les emballages sans payer la consigne.',
          'À la caisse, la même fenêtre s’ouvre après la vente d’une boisson consignée, et dans Actions › Consignes (emballages).',
        ],
      },
    ],
  },
  agent: {
    title: 'Point Mobile Money',
    intro: 'Dépôts, retraits, crédit de communication et factures pour les clients, avec la flotte de chaque compte agent.',
    sections: [
      {
        tab: 'counter',
        title: 'Comptoir',
        perm: 'agent_point',
        steps: [
          'La caisse doit être ouverte : les espèces reçues ou données passent par sa journée et comptent dans le Z.',
          'Choisissez le compte agent (sa flotte s’affiche), puis Dépôt, Retrait, Crédit de communication ou Paiement de facture.',
          'Tapez le montant, le téléphone du client et la référence du SMS. Pour une facture : ENEO, CAMWATER, Canal+… et les frais payés par le client.',
          'La commission de l’opérateur s’affiche avant de valider. Après « Valider l’opération », le reçu du client peut s’imprimer.',
          'Les opérations de la journée sont listées en dessous ; « Annuler » (avec le droit) annule aussi leurs espèces.',
        ],
      },
      {
        tab: 'history',
        title: 'Historique',
        steps: ['Toutes les opérations par dates et par compte, avec les frais, les commissions et les opérations annulées. « Reçu » réimprime le reçu du client.'],
      },
      {
        tab: 'accounts',
        title: 'Comptes et flotte',
        perm: 'agent_accounts',
        steps: [
          '« Nouveau compte agent » : un compte par puce (MTN Mobile Money, Orange Money, autres services) et ses taux de commission en % (0,5 pour 0,5 %).',
          '« Approvisionner la flotte » achète de la flotte avec les espèces de la caisse ; « Revendre de la flotte » fait l’inverse ; « Commission reçue de l’opérateur » ajoute à la flotte la commission versée sur la puce.',
          'Le bilan de la période donne, par compte, le nombre d’opérations, les montants par type, les commissions, les frais et les espèces nettes.',
        ],
      },
    ],
  },
  control: {
    title: 'Contrôle des caissiers',
    intro: 'Pour chaque caissier : annulations, retours, remises, prix modifiés, tiroir ouvert sans vente et manquants, comparés à la moyenne de l’équipe.',
    sections: [
      {
        title: 'Lire le tableau',
        perm: 'cashier_control',
        steps: [
          'Choisissez la période (le mois en cours par défaut). Chaque ligne donne les tickets et les ventes du caissier, puis le nombre et le montant de chaque geste.',
          'Une case en rouge est nettement au-dessus de la moyenne de l’équipe, rapportée au nombre de tickets. La note va de 0 (rien à signaler) à 100.',
          'Les ouvertures de tiroir, les prix modifiés et les factures supprimées sont ceux enregistrés sur ce PC.',
          'Cliquez un caissier pour la liste de ses gestes (date, numéro, montant, motif) et vérifiez-les un par un avant toute conclusion.',
        ],
      },
    ],
  },
  staff: {
    title: 'Collaborateurs et salaires',
    intro: 'Vos employés, leurs sous-comptes en comptabilité, leurs salaires et leurs avances.',
    sections: [
      {
        tab: 'list',
        title: 'Ajouter un collaborateur',
        steps: [
          '« Nouveau collaborateur… » : nom, poste, téléphone, CNI, salaire de base et date d’entrée, n° CNPS, et s’il est déclaré (retenues légales sur ses salaires).',
          'Choisissez son compte de rattachement : Personnel (4211, par défaut), CNPS (4311), État (4471), Associés (4621) ou un autre compte de la classe 4.',
          'Deux sous-comptes sont créés à son nom : sous le compte de rattachement pour ses salaires dus (4211001…), et 4251… pour ses avances. Ils sont dans Comptabilité › Plan comptable.',
          'Le rattachement ne change plus une fois qu’il a des écritures.',
          '« Avance… » paie une avance au bureau ; à la caisse, utilisez Décaisser › Remboursement / Prêt.',
        ],
      },
      {
        tab: 'salaries',
        title: 'Salaires du mois',
        steps: [
          'Choisissez le mois : le salaire de base et les avances à retenir sont proposés. Corrigez si besoin, puis « Constater les salaires ».',
          '« Payer… » règle le net au bureau (caisse centrale, MoMo/OM ou banque). À la caisse : Décaisser › Remboursement / Prêt › Salaire.',
          'Paie activée (Administration › Paramètres › Paie) : la colonne « Retenues légales » montre la CNPS et les impôts retenus (IRPP, CAC, CFC, RAV, TDL) pour chaque collaborateur déclaré ; le net en tient compte.',
          '« Bulletin » imprime le bulletin de paie : brut, retenues ligne par ligne, avances, net, et charges patronales pour information.',
          '« Imprimer l’état du mois » donne ce qu’il faut verser à la CNPS (4311) et aux impôts (4471). Le versement se fait par Décaisser › Autre, sur le compte 4311 ou 4471.',
        ],
      },
      { tab: 'statement', title: 'Extrait de compte', steps: ['Salaires constatés et payés, avances versées, remboursées ou retenues, avec les deux soldes après chaque ligne.'] },
      {
        tab: 'attendance',
        title: 'Pointage',
        perm: 'staff_attendance',
        steps: [
          'L’arrivée se note à la première connexion du jour ; le départ à la fermeture de la caisse ou avec « Je pars » (Fichier, ou en bas de l’écran).',
          'Le tableau du mois donne pour chacun les jours de présence, les heures, les retards et les absences. Cliquez une personne pour ses journées.',
          'Un oubli se corrige avec « Corriger » : heures d’arrivée et de départ, et un motif obligatoire.',
          'L’heure d’embauche, la tolérance de retard et les jours travaillés se règlent dans Administration › Paramètres › Pointage du personnel.',
          'Les départs avant la fin prévue au planning et les jours de congé accordés apparaissent dans le tableau ; un jour de congé n’est pas une absence.',
        ],
      },
      {
        tab: 'leaves',
        title: 'Congés',
        perm: 'staff_leaves',
        steps: [
          'Le haut montre le solde de congés payés de chacun pour l’année : acquis, pris et restant.',
          '« Nouveau congé… » : collaborateur, type (payé, maladie, sans solde, permission), dates et motif. Cochez « Accordé tout de suite » ou laissez-le en demande.',
          'Une demande s’accorde ou se refuse dans la liste ; un congé accordé peut encore être annulé. Seuls les jours travaillés du planning sont décomptés.',
        ],
      },
      {
        tab: 'planning',
        title: 'Planning de la semaine',
        perm: 'staff_leaves',
        steps: [
          'Chaque ligne montre les horaires de la semaine, les congés (une demande non accordée est en orange) et les jours de repos, avec le total d’heures.',
          '‹ et › changent de semaine ; « Imprimer le planning » l’imprime pour l’afficher.',
          'Cliquez un nom pour régler ses horaires jour par jour ; « Reprendre les horaires du magasin » efface ses horaires propres.',
        ],
      },
    ],
  },
};
