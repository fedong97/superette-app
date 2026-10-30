/**
 * Droits d'utilisateur, rangés par groupe. Chaque rôle
 * reçoit une liste de droits que l'administrateur règle dans Administration ›
 * Droits par rôle ; un utilisateur peut en plus recevoir ou perdre des droits
 * à titre personnel (Administration › Privilèges par utilisateur).
 * L'administrateur les a tous.
 */
export type UserRole = 'admin' | 'manager' | 'cashier' | 'seller' | 'buyer' | 'stock' | 'accountant';

/** Rôles réglables (l'administrateur a toujours tout). */
export const EDITABLE_ROLES: UserRole[] = ['manager', 'cashier', 'seller', 'buyer', 'stock', 'accountant'];

/** Groupes de droits, dans l'ordre de la liste de gauche. */
export const PERMISSION_GROUPS = [
  'Facturation',
  'Trésorerie',
  'Fichier des clients',
  'Fichier des fournisseurs',
  'Achat de marchandises',
  'Configuration des produits',
  'Gestion des stocks',
  'Transferts de marchandises',
  'Inventaire',
  'Production',
  'Promotions sur les articles',
  'Suivi des charges',
  'Personnel',
  'Fiscalité',
  'Comptabilité',
  'Divers',
  'Paramétrage du système',
] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

/** Ce que le droit débloque : une entrée de menu, un bouton ou une possibilité dans un écran. */
export type PermissionType = 'Menu' | 'Bouton' | 'Fonction';

export interface PermissionDef {
  label: string;
  group: PermissionGroup;
  type: PermissionType;
  /** Rôles qui ont le droit par défaut. */
  roles?: UserRole[];
  /**
   * Droit plus large d'où vient celui-ci : tant que le droit n'a jamais été
   * réglé, il prend la valeur de son parent. Les réglages faits avant le
   * découpage des droits restent ainsi valables.
   */
  parent?: string;
}

/** Le vendeur facture comme le caissier ; le responsable d'achat (appro) tient les achats, les réceptions et le stock. */
const POS: UserRole[] = ['manager', 'cashier', 'seller'];
const STOCK: UserRole[] = ['manager', 'stock', 'buyer'];
const MANAGE: UserRole[] = ['manager'];
const ACCOUNTING: UserRole[] = ['manager', 'accountant'];
const BUYING: UserRole[] = ['manager', 'stock', 'buyer', 'accountant'];
const COUNTER: UserRole[] = ['manager', 'cashier', 'seller', 'accountant'];

export const PERMISSIONS = {
  // --- Facturation -------------------------------------------------------------
  cash: { label: 'Facturation au comptant (caisse)', group: 'Facturation', type: 'Menu', roles: POS },
  credit: { label: 'Vente à crédit', group: 'Facturation', type: 'Menu', roles: POS },
  shelf_cart: { label: 'Préparer un panier au rayon sur le téléphone, envoyé à la caisse', group: 'Facturation', type: 'Fonction', roles: POS },
  sales: { label: 'Voir tout le registre des factures (sinon ses 3 dernières factures)', group: 'Facturation', type: 'Menu', roles: ACCOUNTING },
  quotes: { label: 'Devis et proformas', group: 'Facturation', type: 'Menu', roles: COUNTER },
  quote_save: { label: 'Créer ou modifier un devis ou une proforma', group: 'Facturation', type: 'Bouton', parent: 'quotes' },
  quote_cancel: { label: 'Annuler un devis ou une proforma', group: 'Facturation', type: 'Bouton', parent: 'quotes' },
  customer_orders: { label: 'Commandes clients (téléphone, WhatsApp) : prendre, préparer', group: 'Facturation', type: 'Menu', roles: COUNTER },
  customer_order_cancel: { label: 'Annuler une commande client', group: 'Facturation', type: 'Bouton', parent: 'customer_orders' },
  back_orders: { label: 'Commander au fournisseur ce qui manque pour une commande client (contremarque)', group: 'Facturation', type: 'Bouton', parent: 'customer_orders' },
  price: { label: 'Appliquer un prix négocié à la saisie (jamais sous le revient)', group: 'Facturation', type: 'Fonction', roles: POS },
  discount: { label: 'Accorder une remise sans le code du gérant', group: 'Facturation', type: 'Fonction', roles: MANAGE },
  sale_hold: { label: 'Mettre une facture en attente', group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sale_resume: { label: 'Reprendre une facture en attente', group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sale_cancel: { label: 'Annuler une facture (avec le code du gérant)', group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sale_edit: { label: 'Modifier une facture de la journée (articles et quantités)', group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sale_edit_request: { label: 'Demander au gérant la modification d’une facture validée (avec motif)', group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sale_edit_approve: { label: 'Accorder ou refuser les demandes de modification de facture', group: 'Facturation', type: 'Fonction', roles: MANAGE },
  sale_cancel_free: { label: 'Annuler ou supprimer une facture sans le code du gérant', group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sale_return: { label: "Retour d'articles et facture d'avoir (avec le code du gérant)", group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sale_reprint: { label: 'Réimprimer un ticket ou une facture', group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sale_new_article: { label: 'Créer un produit inexistant pendant la facturation', group: 'Facturation', type: 'Fonction', parent: 'articles' },
  drawer_open: { label: 'Ouvrir le tiroir-caisse sans vente', group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sale_tariff: { label: 'Changer le tarif d’une fiche à la caisse (détail, gros, super gros) sans le code du gérant', group: 'Facturation', type: 'Fonction', roles: MANAGE },
  sale_warehouse: { label: 'Vendre depuis un autre dépôt que la surface de vente sans le code du gérant', group: 'Facturation', type: 'Fonction', roles: MANAGE },
  deliveries: { label: 'Livraisons du jour (préparer, partir, livrée)', group: 'Facturation', type: 'Menu', parent: 'cash' },
  courier_returns: { label: 'Retour des livreurs : encaisser ce qu’ils rapportent, feuille de route', group: 'Facturation', type: 'Bouton', parent: 'deliveries' },
  containers_counter: { label: 'Encaisser ou rendre la consigne des emballages à la caisse', group: 'Facturation', type: 'Bouton', parent: 'cash' },
  sales_alerts: { label: 'Alertes sur les ventes (remises, annulations, retours)', group: 'Facturation', type: 'Menu', parent: 'sales' },
  voucher_sell: { label: "Vendre un bon d'achat ou une carte cadeau en caisse", group: 'Facturation', type: 'Bouton', roles: POS },
  vouchers: { label: "Bons d'achat : liste, soldes et annulation", group: 'Facturation', type: 'Menu', roles: MANAGE },
  sale_book: { label: 'Saisir les ventes notées sur le carnet pendant une panne', group: 'Facturation', type: 'Bouton', roles: POS },
  outage_close: { label: 'Clôturer une coupure dont les ventes saisies ne font pas le total noté', group: 'Facturation', type: 'Bouton', roles: MANAGE },
  exit_check: { label: 'Contrôle des tickets à la sortie du magasin (vigile)', group: 'Facturation', type: 'Menu', roles: ['manager', 'cashier', 'seller', 'stock'] },
  exit_report: { label: 'Contrôles de sortie : historique et anomalies', group: 'Facturation', type: 'Menu', roles: MANAGE },
  recurring_orders: { label: 'Commandes répétées des clients pros (chaque semaine)', group: 'Facturation', type: 'Menu', parent: 'customer_orders' },
  missed_sale: { label: 'Noter une vente manquée : « le client voulait… » (produit absent, en rupture, trop cher)', group: 'Facturation', type: 'Bouton', roles: [...COUNTER, 'stock'] },

  // --- Trésorerie --------------------------------------------------------------
  treasury: { label: 'Opérations de trésorerie (ouverture et clôture des caisses)', group: 'Trésorerie', type: 'Menu', roles: POS },
  cash_amounts: { label: 'Voir les montants de la caisse (attendu, entrées, ventes, journées)', group: 'Trésorerie', type: 'Fonction', roles: ACCOUNTING },
  cash_history: { label: "Consulter l'historique des journées de caisse", group: 'Trésorerie', type: 'Menu', parent: 'cash_amounts' },
  cash_z: { label: 'Consulter et imprimer le Z et la synthèse d’une journée', group: 'Trésorerie', type: 'Bouton', parent: 'cash_amounts' },
  cash_open: { label: 'Compléter le fond de caisse depuis la centrale et valider un écart de clôture sans le code du gérant', group: 'Trésorerie', type: 'Fonction', roles: MANAGE },
  cash_close_other: { label: "Clôturer la caisse électronique ou banque d'un autre utilisateur", group: 'Trésorerie', type: 'Fonction', parent: 'cash_open' },
  gap_justify: { label: 'Justifier un écart de caisse après la clôture', group: 'Trésorerie', type: 'Bouton', parent: 'cash_open' },
  cash_in: { label: "Faire une entrée d'espèces en caisse", group: 'Trésorerie', type: 'Bouton', parent: 'cash' },
  cash_withdraw: { label: 'Faire un prélèvement en caisse (avec le code du gérant)', group: 'Trésorerie', type: 'Bouton', parent: 'cash' },
  cashout: { label: 'Prélèvement et dépense en caisse sans le code du gérant', group: 'Trésorerie', type: 'Fonction', roles: MANAGE },
  agent_point: { label: 'Point Mobile Money : dépôts, retraits, crédit, factures', group: 'Trésorerie', type: 'Menu', roles: POS },
  agent_accounts: { label: 'Comptes agent Mobile Money : créer, taux de commission', group: 'Trésorerie', type: 'Bouton', roles: MANAGE },
  agent_cancel: { label: 'Annuler une opération du point Mobile Money', group: 'Trésorerie', type: 'Bouton', parent: 'agent_accounts' },
  cashier_control: { label: 'Contrôle des caissiers (annulations, remises, retours, manquants)', group: 'Trésorerie', type: 'Menu', roles: MANAGE },
  cash_operations: { label: 'Consulter toutes les opérations de caisse (listing, recherche)', group: 'Trésorerie', type: 'Menu', parent: 'sales' },
  central_cash: { label: 'Caisse centrale : apports, dépôts en banque, sorties', group: 'Trésorerie', type: 'Menu', roles: MANAGE },
  cash_desk: { label: 'Encaisser et décaisser dans une caisse ouverte (une sortie demande le code du gérant)', group: 'Trésorerie', type: 'Bouton', parent: 'treasury' },
  cash_desk_edit: { label: 'Modifier, antidater ou supprimer une entrée ou une sortie de la journée, annuler l’impression d’un reçu', group: 'Trésorerie', type: 'Bouton', roles: MANAGE },
  payment_cancel: { label: 'Annuler un règlement ou un dépôt d’avance de la journée (client ou fournisseur) : l’argent est rendu', group: 'Trésorerie', type: 'Bouton', parent: 'cash_desk_edit' },
  supplier_advance: { label: 'Verser une avance à un fournisseur', group: 'Trésorerie', type: 'Bouton', parent: 'supplier_pay' },
  cash_live: { label: 'Caisses en direct : opérations de toutes les caisses, intervenir sur une caisse', group: 'Trésorerie', type: 'Menu', roles: MANAGE },

  // --- Fichier des clients -----------------------------------------------------
  customers: { label: 'Liste et fiches des clients', group: 'Fichier des clients', type: 'Menu', roles: COUNTER },
  customer_create: { label: 'Créer un nouveau client', group: 'Fichier des clients', type: 'Fonction', parent: 'customers' },
  customer_edit: { label: "Modifier la fiche d'un client", group: 'Fichier des clients', type: 'Fonction', parent: 'customers' },
  customer_deactivate: { label: 'Désactiver ou réactiver un client', group: 'Fichier des clients', type: 'Bouton', parent: 'receivables' },
  receivables: { label: 'Comptes clients : fixer les plafonds de crédit et les échéances, contrôler les retards', group: 'Fichier des clients', type: 'Fonction', roles: ACCOUNTING },
  customer_price_level: { label: "Fixer la grille tarifaire d'un client (gros, super gros)", group: 'Fichier des clients', type: 'Fonction', parent: 'receivables' },
  customer_payment: { label: 'Encaisser un règlement client', group: 'Fichier des clients', type: 'Bouton', parent: 'customers' },
  customer_statement: { label: "Consulter et imprimer l'extrait de compte d'un client", group: 'Fichier des clients', type: 'Bouton', parent: 'customers' },
  summary_invoices: { label: 'Factures récapitulatives des clients (fin de mois)', group: 'Fichier des clients', type: 'Bouton', parent: 'customers' },
  balance_adjust: { label: 'Saisir le solde d’ouverture ou ajuster le solde d’un client ou d’un fournisseur', group: 'Fichier des clients', type: 'Fonction', roles: ACCOUNTING },
  customer_lettering: { label: 'Lettrer un règlement client sur les factures choisies', group: 'Fichier des clients', type: 'Bouton', parent: 'customer_payment' },
  account_offsets: { label: 'Compenser le compte client et le compte fournisseur d’un même tiers', group: 'Fichier des clients', type: 'Fonction', roles: ACCOUNTING },
  consignment: { label: 'Dépôt-vente chez les revendeurs : envoyer, contrôler, facturer le vendu', group: 'Fichier des clients', type: 'Menu', roles: MANAGE },
  loyalty_adjust: { label: 'Corriger les points de fidélité d’un client (avec motif)', group: 'Fichier des clients', type: 'Fonction', roles: MANAGE },
  rebates: { label: 'Ristournes et bonus clients : réglages, constater, accorder et régulariser', group: 'Fichier des clients', type: 'Fonction', roles: MANAGE },
  field_reps: { label: 'Commerciaux de terrain : fiches, zones et villes', group: 'Fichier des clients', type: 'Menu', roles: MANAGE },

  // --- Fichier des fournisseurs -----------------------------------------------
  suppliers: { label: 'Liste et fiches des fournisseurs', group: 'Fichier des fournisseurs', type: 'Menu', roles: BUYING },
  supplier_edit: { label: 'Enregistrer ou modifier un fournisseur', group: 'Fichier des fournisseurs', type: 'Fonction', parent: 'suppliers' },
  supplier_articles: { label: "Produits et prix d'achat d'un fournisseur", group: 'Fichier des fournisseurs', type: 'Fonction', parent: 'suppliers' },
  supplier_statement: { label: "Consulter l'extrait de compte et la situation des fournisseurs", group: 'Fichier des fournisseurs', type: 'Menu', parent: 'purchase_invoices' },
  free_goods: { label: 'Bonus fournisseurs : unités gratuites reçues et leur valeur', group: 'Fichier des fournisseurs', type: 'Menu', parent: 'suppliers' },
  supplier_calendar: { label: 'Calendrier des fournisseurs : jours de passage et commande prête la veille', group: 'Fichier des fournisseurs', type: 'Menu', parent: 'reorder' },

  // --- Achat de marchandises ---------------------------------------------------
  purchases: { label: 'Achats : bons de commande et réceptions (consultation)', group: 'Achat de marchandises', type: 'Menu', roles: BUYING },
  purchase_orders: { label: 'Créer ou modifier un bon de commande', group: 'Achat de marchandises', type: 'Bouton', roles: STOCK },
  reorder: { label: 'Proposition de commande', group: 'Achat de marchandises', type: 'Menu', parent: 'purchase_orders' },
  order_receive: { label: 'Réceptionner un bon de commande', group: 'Achat de marchandises', type: 'Bouton', parent: 'purchase_orders' },
  order_close: { label: 'Envoyer, clôturer ou annuler un bon de commande', group: 'Achat de marchandises', type: 'Bouton', parent: 'purchase_orders' },
  group_orders: { label: 'Commandes groupées pour plusieurs magasins', group: 'Achat de marchandises', type: 'Bouton', roles: MANAGE },
  purchase_invoices: { label: 'Saisir les factures fournisseurs (à partir des bons de réception)', group: 'Achat de marchandises', type: 'Fonction', roles: [...ACCOUNTING, 'buyer'] },
  purchase_invoice_edit: { label: 'Modifier une facture ou un avoir fournisseur déjà saisi (n°, dates, montants, articles)', group: 'Achat de marchandises', type: 'Bouton', parent: 'purchase_invoices' },
  supplier_pay: { label: 'Payer une facture fournisseur', group: 'Achat de marchandises', type: 'Bouton', parent: 'purchase_invoices' },
  purchase_due: { label: 'Échéancier des fournisseurs', group: 'Achat de marchandises', type: 'Menu', parent: 'purchase_invoices' },
  supplier_returns: { label: 'Retours au fournisseur et avoirs attendus', group: 'Achat de marchandises', type: 'Menu', parent: 'purchase_invoices' },
  missed_report: { label: 'Ventes manquées : produits les plus demandés par les clients', group: 'Achat de marchandises', type: 'Menu', parent: 'reorder' },
  mobile_reception: { label: 'Réceptionner un bon de commande sur le téléphone (le PC valide)', group: 'Achat de marchandises', type: 'Fonction', parent: 'order_receive' },

  // --- Configuration des produits ----------------------------------------------
  articles: { label: 'Liste et fiches des produits', group: 'Configuration des produits', type: 'Menu', roles: STOCK },
  article_create: { label: 'Ajouter de nouveaux produits', group: 'Configuration des produits', type: 'Bouton', parent: 'articles' },
  article_edit: { label: "Modifier la fiche d'un produit (codes-barres, conditionnements, seuils)", group: 'Configuration des produits', type: 'Fonction', parent: 'articles' },
  article_rename: { label: "Changer le nom d'un produit déjà créé (bouton « Modifier le nom »)", group: 'Configuration des produits', type: 'Bouton', parent: 'article_edit' },
  article_price: { label: "Modifier les prix de vente et d'achat d'un produit", group: 'Configuration des produits', type: 'Fonction', parent: 'articles' },
  article_deactivate: { label: 'Désactiver ou réactiver un produit', group: 'Configuration des produits', type: 'Bouton', parent: 'articles' },
  article_families: { label: 'Créer, renommer et supprimer les rayons et les familles', group: 'Configuration des produits', type: 'Bouton', parent: 'articles' },
  store_price: { label: 'Prix propre au magasin', group: 'Configuration des produits', type: 'Fonction', roles: MANAGE },
  import: { label: 'Importer le catalogue (Excel, CSV)', group: 'Configuration des produits', type: 'Bouton', roles: MANAGE },
  article_export: { label: 'Exporter la liste des produits (Excel, CSV)', group: 'Configuration des produits', type: 'Bouton', parent: 'articles' },
  price_update: { label: 'Mettre à jour les prix en masse (hausse en %, coefficient)', group: 'Configuration des produits', type: 'Bouton', roles: MANAGE },
  price_review: { label: 'Prix à revoir : articles dont le prix d’achat a monté sans que le prix de vente bouge', group: 'Configuration des produits', type: 'Menu', parent: 'price_update' },
  stock_location: { label: 'Noter l’emplacement des produits dans les dépôts', group: 'Configuration des produits', type: 'Fonction', parent: 'article_edit' },
  lot_recall: { label: "Rappel d'un lot : bloquer à la caisse, retrouver les clients, rendre au fournisseur", group: 'Gestion des stocks', type: 'Menu', roles: STOCK },
  price_schedule: { label: 'Prix programmés à une date', group: 'Configuration des produits', type: 'Menu', parent: 'price_update' },
  labels: { label: 'Étiquettes de rayon', group: 'Configuration des produits', type: 'Menu', roles: STOCK },

  // --- Gestion des stocks ------------------------------------------------------
  stock: { label: 'Consulter le stock (état, dépôts, péremptions, stocks critiques)', group: 'Gestion des stocks', type: 'Menu', roles: STOCK },
  stock_moves: { label: "Consulter l'historique des mouvements de stock", group: 'Gestion des stocks', type: 'Menu', parent: 'stock' },
  stock_monitoring: { label: "Monitoring de l'évolution des stocks", group: 'Gestion des stocks', type: 'Menu', parent: 'stock' },
  stock_receive: { label: 'Saisir une réception sans commande', group: 'Gestion des stocks', type: 'Bouton', parent: 'stock' },
  reception_edit: { label: 'Corriger un bon de réception pas encore facturé (articles, quantités, prix)', group: 'Gestion des stocks', type: 'Bouton', roles: MANAGE },
  stock_loss: { label: 'Déstocker des marchandises (pertes, casse, périmés)', group: 'Gestion des stocks', type: 'Bouton', parent: 'stock' },
  containers: { label: 'Emballages consignés : types, vides, fournisseurs', group: 'Gestion des stocks', type: 'Menu', roles: STOCK },
  clearance: { label: 'Déstockage avant péremption et rapport de démarque', group: 'Gestion des stocks', type: 'Menu', roles: MANAGE },
  stock_adjust: { label: 'Corriger directement le stock (sans demande)', group: 'Gestion des stocks', type: 'Fonction', parent: 'inventory' },
  stock_request: { label: 'Demander une correction de stock', group: 'Gestion des stocks', type: 'Fonction', parent: 'inventory_count' },
  stock_decide: { label: 'Valider ou refuser les demandes de correction de stock', group: 'Gestion des stocks', type: 'Bouton', parent: 'inventory' },
  stock_anomalies: { label: 'Anomalies de stock à vérifier : voir les cas et décider de la correction', group: 'Gestion des stocks', type: 'Menu', roles: MANAGE },
  ignore_stock: { label: 'Activer « Ignorer la gestion des stocks » (vente sans stock)', group: 'Gestion des stocks', type: 'Fonction', roles: MANAGE },

  // --- Transferts de marchandises ----------------------------------------------
  transfer_view: { label: 'Consulter la situation des transferts', group: 'Transferts de marchandises', type: 'Menu', parent: 'stock' },
  store_transfers: { label: 'Équilibrer le stock entre magasins : demander, expédier, réceptionner', group: 'Transferts de marchandises', type: 'Menu', roles: STOCK },
  transfer_create: { label: 'Enregistrer ou modifier un bon de transfert', group: 'Transferts de marchandises', type: 'Bouton', parent: 'stock' },
  transfer_ship: { label: "Valider l'expédition d'un transfert", group: 'Transferts de marchandises', type: 'Bouton', parent: 'stock' },
  transfer_receive: { label: 'Réceptionner un transfert', group: 'Transferts de marchandises', type: 'Bouton', parent: 'stock' },
  transfer_cancel: { label: 'Annuler un transfert', group: 'Transferts de marchandises', type: 'Bouton', parent: 'stock' },
  transfer_direct: { label: 'Transférer directement sans bon (réserve vers surface)', group: 'Transferts de marchandises', type: 'Fonction', parent: 'stock' },
  restock: { label: 'Liste de réassort du rayon et transfert de la réserve en un clic', group: 'Transferts de marchandises', type: 'Menu', parent: 'transfer_direct' },
  day_tasks: { label: 'Tâches du jour à cocher (réceptions, transferts, inventaire, péremptions)', group: 'Gestion des stocks', type: 'Menu', roles: ['manager', 'stock', 'buyer'] },

  // --- Inventaire --------------------------------------------------------------
  inventory: { label: 'Créer un inventaire', group: 'Inventaire', type: 'Bouton', roles: MANAGE },
  inventory_count: { label: 'Saisir le stock physique dans un inventaire', group: 'Inventaire', type: 'Fonction', roles: ['manager', 'stock'] },
  inventory_edit: { label: 'Retirer des produits d’un inventaire', group: 'Inventaire', type: 'Fonction', parent: 'inventory' },
  inventory_close: { label: 'Clôturer un inventaire (corrige le stock)', group: 'Inventaire', type: 'Bouton', parent: 'inventory' },
  inventory_cancel: { label: 'Annuler un inventaire', group: 'Inventaire', type: 'Bouton', parent: 'inventory' },
  cycle_count: { label: 'Inventaire tournant de la semaine', group: 'Inventaire', type: 'Bouton', parent: 'inventory' },
  inventory_import: { label: 'Importer les quantités comptées (CSV)', group: 'Inventaire', type: 'Bouton', parent: 'inventory_count' },
  inventory_print: { label: 'Imprimer les fiches de comptage et le résultat', group: 'Inventaire', type: 'Bouton', parent: 'inventory_count' },

  // --- Production --------------------------------------------------------------
  production: { label: 'Consulter la fabrication', group: 'Production', type: 'Menu', roles: ['manager', 'stock'] },
  production_recipes: { label: 'Paramétrer les recettes (produits fabriqués)', group: 'Production', type: 'Bouton', parent: 'production' },
  production_create: { label: 'Créer un ordre de fabrication', group: 'Production', type: 'Bouton', parent: 'production' },
  production_validate: { label: 'Valider une fabrication (sort les ingrédients, entre le produit)', group: 'Production', type: 'Bouton', parent: 'production' },
  production_cancel: { label: 'Annuler un ordre de fabrication', group: 'Production', type: 'Bouton', parent: 'production' },

  // --- Promotions --------------------------------------------------------------
  promotions: { label: 'Consulter les articles en promotion', group: 'Promotions sur les articles', type: 'Menu', roles: MANAGE },
  promotion_save: { label: 'Ajouter ou modifier une promotion', group: 'Promotions sur les articles', type: 'Fonction', parent: 'promotions' },
  promotion_stop: { label: 'Mettre fin à une promotion ou la réactiver', group: 'Promotions sur les articles', type: 'Fonction', parent: 'promotions' },
  promo_codes: { label: 'Codes de réduction : créer, arrêter, suivre leur utilisation', group: 'Promotions sur les articles', type: 'Menu', roles: MANAGE },

  // --- Suivi des charges -------------------------------------------------------
  expenses: { label: 'Consulter toutes les dépenses', group: 'Suivi des charges', type: 'Menu', roles: ACCOUNTING },
  expense_record: { label: 'Saisir une dépense au bureau', group: 'Suivi des charges', type: 'Menu', parent: 'expenses' },
  expense_cancel: { label: 'Modifier ou annuler une dépense (avec le code du gérant)', group: 'Suivi des charges', type: 'Bouton', roles: COUNTER },
  expense_categories: { label: 'Fixer les types de charge', group: 'Suivi des charges', type: 'Menu', parent: 'expenses' },
  charge_plans: { label: 'Définir les charges fixes et constater les charges', group: 'Suivi des charges', type: 'Menu', parent: 'expenses' },
  expense_approve: { label: 'Approuver ou refuser les dépenses saisies par les autres', group: 'Suivi des charges', type: 'Fonction', roles: MANAGE },

  // --- Personnel ---------------------------------------------------------------
  staff: { label: 'Collaborateurs : fiches et extraits de compte', group: 'Personnel', type: 'Menu', roles: ACCOUNTING },
  staff_edit: { label: 'Ajouter ou modifier un collaborateur', group: 'Personnel', type: 'Bouton', parent: 'staff' },
  staff_salaries: { label: 'Constater les salaires du mois et les payer au bureau', group: 'Personnel', type: 'Menu', parent: 'staff' },
  staff_targets: { label: 'Objectifs de vente et commissions des vendeurs', group: 'Personnel', type: 'Menu', parent: 'staff' },
  staff_attendance: { label: 'Pointage du personnel : état du mois, retards, absences et corrections', group: 'Personnel', type: 'Menu', roles: MANAGE },
  staff_leaves: { label: 'Congés et planning du personnel', group: 'Personnel', type: 'Menu', parent: 'staff_attendance' },
  staff_presence: { label: 'Présences du jour : qui est là, retards et absents', group: 'Personnel', type: 'Menu', parent: 'staff_attendance' },
  staff_teams: { label: 'Équipes, rotations et entrées du magasin', group: 'Personnel', type: 'Menu', parent: 'staff_attendance' },
  staff_kiosk: { label: 'Ouvrir la borne de pointage sur ce PC', group: 'Personnel', type: 'Menu', roles: MANAGE },
  staff_badges: { label: 'Badges et codes de pointage du personnel', group: 'Personnel', type: 'Bouton', parent: 'staff_edit' },
  staff_agencies: { label: 'Sociétés prestataires (gardiennage, nettoyage)', group: 'Personnel', type: 'Menu', parent: 'staff_edit' },
  staff_documents: { label: 'Pièces du dossier du personnel (CNI, contrat, certificat)', group: 'Personnel', type: 'Bouton', parent: 'staff_edit' },
  team_board: { label: 'Tableau de l’équipe sur la semaine (écarts, annulations, remises, panier moyen, vitesse)', group: 'Personnel', type: 'Menu', parent: 'cashier_control' },

  // --- Fiscalité ---------------------------------------------------------------
  vat_return: { label: 'Consulter et imprimer la déclaration de TVA', group: 'Fiscalité', type: 'Fonction', parent: 'accounting' },
  tax: { label: 'Impôt sur le résultat, acomptes et notes de la DSF', group: 'Fiscalité', type: 'Fonction', parent: 'accounting' },
  tax_settings: { label: 'Préparer les déclarations fiscales (paramètres, comptabiliser l’impôt)', group: 'Fiscalité', type: 'Fonction', parent: 'accounting' },

  // --- Comptabilité ------------------------------------------------------------
  accounting: { label: 'Comptabilité : journaux, grand livre, balance', group: 'Comptabilité', type: 'Menu', roles: ACCOUNTING },
  journal_entry: { label: 'Passer une écriture manuelle', group: 'Comptabilité', type: 'Bouton', parent: 'accounting' },
  journal_edit: { label: 'Modifier, supprimer ou corriger une écriture comptable', group: 'Comptabilité', type: 'Bouton', roles: MANAGE },
  fiscal_years: { label: 'Ouvrir, clôturer et rouvrir un exercice comptable', group: 'Comptabilité', type: 'Fonction', roles: MANAGE },
  chart_accounts: { label: 'Modifier le plan comptable', group: 'Comptabilité', type: 'Bouton', parent: 'accounting' },
  bank_reconciliation: { label: 'Rapprochement bancaire', group: 'Comptabilité', type: 'Menu', parent: 'accounting' },
  statements: { label: 'États financiers (bilan, compte de résultat, flux)', group: 'Comptabilité', type: 'Menu', parent: 'accounting' },
  accounting_export: { label: 'Exporter la comptabilité et les ventes (CSV)', group: 'Comptabilité', type: 'Bouton', parent: 'accounting' },
  fixed_assets: { label: 'Registre des immobilisations et plans d’amortissement', group: 'Comptabilité', type: 'Menu', parent: 'accounting' },
  cash_forecast: { label: 'Trésorerie prévisionnelle', group: 'Comptabilité', type: 'Menu', parent: 'accounting' },
  budgets: { label: 'Budgets par compte et suivi du réel', group: 'Comptabilité', type: 'Menu', parent: 'accounting' },
  analytics: { label: 'Analytique : résultat par rayon et par magasin', group: 'Comptabilité', type: 'Menu', parent: 'accounting' },
  patrimony: { label: 'Courbe du patrimoine (trésorerie, créances, stock, dettes)', group: 'Comptabilité', type: 'Menu', parent: 'accounting' },
  cheque_deposits: { label: 'Bordereaux de remise de chèques en banque', group: 'Comptabilité', type: 'Menu', parent: 'accounting' },
  cheque_rejections: { label: 'Chèques revenus impayés', group: 'Comptabilité', type: 'Menu', parent: 'cheque_deposits' },
  fixed_asset_edit: { label: 'Ajouter, modifier, sortir ou supprimer une immobilisation', group: 'Comptabilité', type: 'Bouton', parent: 'journal_entry' },

  // --- Divers ------------------------------------------------------------------
  dashboard: { label: "Tableau de bord et points d'attention", group: 'Divers', type: 'Menu', roles: MANAGE },
  reports: { label: 'Rapports de ventes', group: 'Divers', type: 'Menu', roles: ACCOUNTING },
  report_export: { label: 'Exporter les rapports de ventes (Excel)', group: 'Divers', type: 'Bouton', parent: 'reports' },
  owner_report: { label: 'Rapport mensuel du propriétaire (PDF, WhatsApp)', group: 'Divers', type: 'Menu', parent: 'dashboard' },

  // --- Paramétrage du système ----------------------------------------------------
  admin: { label: 'Administration (consulter caisses, dépôts, utilisateurs)', group: 'Paramétrage du système', type: 'Menu', roles: MANAGE },
  training: { label: 'Ouvrir le mode formation (caisse d’entraînement sur une copie de la boutique)', group: 'Paramétrage du système', type: 'Fonction', roles: MANAGE },
  users_manage: { label: 'Créer et modifier les utilisateurs', group: 'Paramétrage du système', type: 'Fonction', parent: 'admin' },
  user_copy: { label: 'Copier un utilisateur (même poste, mêmes privilèges)', group: 'Paramétrage du système', type: 'Bouton', parent: 'users_manage' },
  stations: { label: 'État des PC : synchronisation, version, sauvegarde, imprimante, licence', group: 'Paramétrage du système', type: 'Menu', parent: 'admin' },
  warehouses_manage: { label: 'Créer, modifier et désactiver les dépôts', group: 'Paramétrage du système', type: 'Bouton', parent: 'admin' },
  companies: { label: 'Sociétés : regrouper les magasins, chiffres consolidés', group: 'Paramétrage du système', type: 'Fonction' },
  settings_edit: { label: 'Modifier les paramètres (imprimante, ventes, stock, sécurité…)', group: 'Paramétrage du système', type: 'Fonction', parent: 'admin' },
  print_templates: { label: "Modifier les modèles d'impression (factures, tickets)", group: 'Paramétrage du système', type: 'Fonction', parent: 'settings_edit' },
  backups: { label: 'Faire une sauvegarde et consulter les sauvegardes', group: 'Paramétrage du système', type: 'Fonction', parent: 'admin' },
  online_shop: { label: 'Boutique en ligne et vérificateur de prix : réglages', group: 'Paramétrage du système', type: 'Fonction', parent: 'settings_edit' },
  data_takeover: { label: 'Reprendre les données d’un magasin existant (clients, fournisseurs, stock de départ)', group: 'Paramétrage du système', type: 'Fonction', roles: MANAGE },
  audit: { label: "Consulter le journal d'audit", group: 'Paramétrage du système', type: 'Menu', parent: 'admin' },
} satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

const DEFS = PERMISSIONS as Record<Permission, PermissionDef>;

/** Droits effectifs d'un rôle : réglages enregistrés, sinon ceux du droit parent, sinon valeurs par défaut. */
export function roleRights(role: UserRole, saved: Partial<Record<Permission, boolean>> | null): Permission[] {
  if (role === 'admin') return [...PERMISSION_KEYS];
  const memo = new Map<Permission, boolean>();
  const value = (k: Permission): boolean => {
    const known = memo.get(k);
    if (known !== undefined) return known;
    const def = DEFS[k];
    const v = saved?.[k] ?? (def.parent ? value(def.parent as Permission) : (def.roles ?? []).includes(role));
    memo.set(k, v);
    return v;
  };
  return PERMISSION_KEYS.filter(value);
}

/** Privilèges personnels d'un utilisateur : droits accordés en plus de son rôle, et droits retirés. */
export interface UserPrivileges {
  grants: Permission[];
  revokes: Permission[];
}

/** Droits d'un utilisateur : ceux de son rôle, plus ses privilèges accordés, moins ceux qui lui sont retirés. */
export function userRights(role: UserRole, roleSet: readonly Permission[], privileges: UserPrivileges | null): Permission[] {
  if (role === 'admin' || !privileges) return [...roleSet];
  const set = new Set(roleSet);
  for (const p of privileges.grants) set.add(p);
  for (const p of privileges.revokes) set.delete(p);
  return PERMISSION_KEYS.filter((k) => set.has(k));
}
