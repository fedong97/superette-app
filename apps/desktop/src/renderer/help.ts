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
  ['F7', 'Valider et imprimer la facture listing (fiche vide : Mes factures)'],
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
      { tab: 'receive', title: 'Réception sans commande', steps: ['Choisissez le dépôt, ajoutez les produits reçus avec la quantité, le prix et la date limite pour les périssables, puis validez.', 'Remise % et promo « N/M » (12/10 : 12 achetés, 10 payés) par ligne : le stock entre au coût net.'] },
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
          'Le gérant clôture : le stock est corrigé et la fiche d’écarts s’imprime.',
        ],
      },
      { tab: 'expiry', title: 'Péremptions', steps: ['Les lots qui périment bientôt (J-7, J-3, J-1) ou déjà périmés : déstockez-les en perte.'] },
      { tab: 'monitoring', title: 'Monitoring', steps: ['Pour un produit, chaque mouvement avec le stock avant et après et le login.', 'Le magasinier demande une correction avec un motif ; le gérant la valide.'] },
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
      { tab: 'reorder', title: 'Proposition de commande', perm: 'purchase_orders', steps: ['Les quantités à commander d’après les ventes des 4 dernières semaines et le stock d’alerte ; un bon par fournisseur en un clic.'] },
      { tab: 'invoices', title: 'Factures fournisseurs', perm: 'purchase_invoices', steps: ['Saisissez la facture à partir des bons de réception, puis enregistrez les paiements.'] },
      { tab: 'due', title: 'Échéancier', perm: 'purchase_invoices', steps: ['Ce qui reste à payer à chaque fournisseur, avec les retards en rouge.'] },
    ],
  },
  suppliers: {
    title: 'Fournisseurs',
    intro: 'Fiches des fournisseurs, leurs articles et leur compte.',
    sections: [
      { tab: 'list', title: 'Fiche fournisseur', steps: ['Cliquez un fournisseur pour sa fiche : NIU, délais de paiement et de livraison, articles référencés avec prix négocié.'] },
      { tab: 'statement', title: 'Extrait de compte', steps: ['Factures, avoirs et paiements d’un fournisseur sur une période, avec le solde.'] },
      { tab: 'situation', title: 'Situation', perm: 'purchase_invoices', steps: ['Ce que l’on doit à chaque fournisseur.'] },
    ],
  },
  customers: {
    title: 'Clients',
    intro: 'Fiches clients, comptes, règlements et ristournes.',
    sections: [
      { tab: 'list', title: 'Fiche client', steps: ['« Nouveau client » ou cliquez un client : téléphone, NIU, tarif (détail, gros), plafond de crédit et délai de paiement.'] },
      { tab: 'statement', title: 'Extrait de compte', steps: ['Ventes à crédit et règlements d’un client sur une période ; imprimez le relevé pour le lui remettre.'] },
      { tab: 'payments', title: 'Règlements', steps: ['Liste des règlements reçus. Pour encaisser : « Encaisser un règlement » sur le compte du client, ou à la caisse par Action.'] },
      { tab: 'receivables', title: 'Situation (balance âgée)', perm: 'receivables', steps: ['Ce que doit chaque client, par ancienneté du retard.'] },
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
    title: 'Étiquettes de rayon',
    intro: 'Imprimer les étiquettes des prix à jour, avec le code-barres.',
    sections: [
      { title: 'Imprimer', steps: ['La liste « À refaire » montre les produits reçus jamais étiquetés et les prix changés.', 'Choisissez la planche (24, 40 ou 65 par page) ou le rouleau, vérifiez l’aperçu puis imprimez.'] },
    ],
  },
  reports: {
    title: 'Rapports de ventes',
    intro: 'Le chiffre d’affaires par jour, rayon, article, caissier, client ou moyen de paiement.',
    sections: [{ title: 'Lire un rapport', steps: ['Choisissez la période (hier, cette semaine, ce mois…) puis le regroupement.', 'Imprimez, ou « Exporter » en CSV pour Excel.'] }],
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
      { tab: 'registers', title: 'Caisses', steps: ['Choisissez le type (Espèces, Électronique, Banque) puis « Ajouter une caisse ».', 'Le code d’activation d’une caisse espèces rattache un nouveau PC.'] },
      {
        tab: 'users',
        title: 'Utilisateurs',
        steps: [
          '« Ajouter un utilisateur » : nom, identifiant, code, rôle, et ses caisses espèces, électronique et banque.',
          'La colonne Privilèges montre ce qui est ajouté (+) ou retiré (−) à son rôle. Un utilisateur « bloqué » après trop de codes faux se débloque avec « Débloquer ».',
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
      { tab: 'backups', title: 'Sauvegardes', steps: ['Choisissez un dossier (clé USB, autre disque) ; une sauvegarde se fait chaque jour. « Restaurer » reprend une sauvegarde.'] },
      { tab: 'server', title: 'Serveur central', steps: ['Adresse du serveur qui relie les PC et les magasins ; l’état s’affiche dans la barre du bas.'] },
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
          'Pour l’envoi automatique, l’administrateur coche « Envoyer le résumé chaque soir », choisit l’heure, les destinataires et le compte e-mail qui envoie. Ce PC doit être allumé avec FEDO Gestion ouvert ; sinon le résumé de la veille part au démarrage suivant.',
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
  staff: {
    title: 'Collaborateurs et salaires',
    intro: 'Vos employés, leurs sous-comptes en comptabilité, leurs salaires et leurs avances.',
    sections: [
      {
        tab: 'list',
        title: 'Ajouter un collaborateur',
        steps: [
          '« Nouveau collaborateur… » : nom, poste, téléphone, CNI, salaire de base et date d’entrée.',
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
          '« Bulletin » imprime le bulletin de paie simplifié. Les retenues CNPS et IRPP ne sont pas calculées dans cette version.',
        ],
      },
      { tab: 'statement', title: 'Extrait de compte', steps: ['Salaires constatés et payés, avances versées, remboursées ou retenues, avec les deux soldes après chaque ligne.'] },
    ],
  },
};
