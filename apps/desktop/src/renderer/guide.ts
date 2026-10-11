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
