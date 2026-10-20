/** Noms en français des données synchronisées, pour l'interface du serveur. */
export const ENTITY_LABELS: Record<string, string> = {
  vat_rate: 'Taux de TVA',
  store: 'Magasin',
  warehouse: 'Dépôt',
  register: 'Caisse',
  user: 'Utilisateur',
  department: 'Rayon',
  family: 'Famille',
  article: 'Article',
  store_price: 'Prix magasin',
  supplier: 'Fournisseur',
  supplier_article: 'Article fournisseur',
  customer: 'Client',
  account: 'Compte comptable',
  expense_category: 'Catégorie de dépense',
  promotion: 'Promotion',
  role_rights: 'Droits par rôle',
  user_rights: 'Privilèges',
  rebate_rules: 'Règles de ristourne',
  recipe: 'Recette de fabrication',
  stock_level: 'Stock par dépôt',
  lot: 'Lot',
  stock_movement: 'Mouvement de stock',
  cash_session: 'Journée de caisse',
  cash_operation: 'Opération de caisse',
  sale: 'Vente',
  purchase_order: 'Bon de commande',
  reception: 'Réception',
  supplier_invoice: 'Facture fournisseur',
  supplier_payment: 'Règlement fournisseur',
  customer_payment: 'Règlement client',
  manual_entry: 'Écriture comptable',
  expense: 'Dépense',
  quote: 'Devis / proforma',
  bank_line: 'Relevé bancaire',
  tax_year: 'Année fiscale',
  dsf_disclosure: 'Note DSF',
  charge_plan: 'Échéancier de charges',
  central_cash_movement: 'Caisse centrale',
  emoney_movement: 'Caisse électronique',
  inventory: 'Inventaire',
  inventory_line: "Ligne d'inventaire",
  inventory_entry: "Comptage d'inventaire",
  transfer: 'Transfert',
  stock_request: 'Demande de correction',
  rebate_entry: 'Ristourne',
  production_order: 'Fabrication',
  staff: 'Collaborateur',
  staff_salary: 'Salaire',
  treasury_entry: 'Encaissement / décaissement',
  sale_delivery: 'Livraison',
  fiscal_year: 'Exercice comptable',
  supplier_return: 'Retour fournisseur',
  summary_invoice: 'Facture récapitulative',
  cheque_deposit: 'Remise de chèques',
  budget: 'Budget',
  container: 'Emballage consigné',
  container_move: 'Mouvement de consigne',
  agent_account: 'Compte Mobile Money (point)',
  agent_operation: 'Opération Mobile Money (point)',
  staff_leave: 'Congé',
  staff_schedule: 'Horaires',
  cheque_rejection: 'Chèque impayé',
  courier_return: 'Retour de livreur',
};

/** Familles du journal d'activité. */
export const ENTITY_GROUPS: { key: string; label: string; entities: string[] }[] = [
  { key: 'ventes', label: 'Ventes', entities: ['sale', 'sale_delivery', 'customer_payment', 'quote', 'customer_order', 'customer', 'summary_invoice', 'container_move', 'courier_return'] },
  { key: 'caisse', label: 'Caisse', entities: ['cash_session', 'cash_operation', 'central_cash_movement', 'emoney_movement', 'treasury_entry', 'expense', 'agent_operation', 'agent_account'] },
  {
    key: 'stock',
    label: 'Stock',
    entities: ['stock_movement', 'lot', 'inventory', 'inventory_line', 'inventory_entry', 'transfer', 'stock_request', 'stock_level', 'reception', 'production_order'],
  },
  { key: 'achats', label: 'Achats', entities: ['purchase_order', 'supplier_invoice', 'supplier_payment', 'supplier', 'supplier_article', 'supplier_return'] },
  {
    key: 'catalogue',
    label: 'Articles et prix',
    entities: ['article', 'store_price', 'family', 'department', 'promotion', 'vat_rate', 'recipe', 'rebate_rules', 'container'],
  },
  { key: 'personnes', label: 'Utilisateurs et réglages', entities: ['store', 'warehouse', 'register', 'user', 'role_rights', 'user_rights', 'staff', 'staff_salary', 'staff_leave', 'staff_schedule', 'expense_category'] },
  {
    key: 'compta',
    label: 'Comptabilité',
    entities: ['account', 'manual_entry', 'bank_line', 'tax_year', 'dsf_disclosure', 'charge_plan', 'fiscal_year', 'rebate_entry', 'cheque_deposit', 'cheque_rejection', 'budget'],
  },
];

const fcfa = (n: unknown) => `${Math.round(Number(n)).toLocaleString('fr-FR').replace(/ | /g, ' ')} FCFA`;

/** Une ligne lisible pour une opération : numéro, nom, montant… */
export function summarize(entity: string, op: string, p: Record<string, unknown> | null): string {
  if (op === 'delete' || !p) return 'supprimé';
  const s = (k: string) => (typeof p[k] === 'string' || typeof p[k] === 'number' ? String(p[k]) : '');
  switch (entity) {
    case 'sale': {
      const parts = [s('number'), p['total_ttc'] != null ? fcfa(p['total_ttc']) : ''];
      if (p['kind'] === 'return') parts.push('retour');
      if (p['status'] === 'cancelled') parts.push('annulée');
      return parts.filter(Boolean).join(' · ');
    }
    case 'stock_level':
      return '';
  }
  const label = s('number') || s('name') || s('label') || s('reference') || s('code') || s('description');
  const amount = p['amount'] ?? p['total_ttc'] ?? p['total'];
  return [label, typeof amount === 'number' ? fcfa(amount) : ''].filter(Boolean).join(' · ');
}
