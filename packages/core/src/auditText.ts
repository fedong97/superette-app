import { formatFcfa } from './money';
import { PAYMENT_METHODS } from './payment';
import { formatQty } from './quantity';
import { MOVEMENT_TYPES } from './stock';

/**
 * Journal d'audit en français courant : chaque action enregistrée
 * (« cash.close », « counter.pay »…) devient une phrase lisible par
 * quelqu'un qui ne connaît pas l'informatique, avec une couleur et un thème.
 * Les données enregistrées ne changent pas : seule leur lecture change.
 */

/** alert = rouge (écart, annulation, suppression) ; watch = orange (remise, prix) ; login = connexion. */
export type AuditLevel = 'alert' | 'watch' | 'normal' | 'login';
export type AuditTheme = 'cash' | 'sales' | 'prices' | 'stock' | 'partners' | 'staff' | 'accounting' | 'settings' | 'logins';

export interface AuditEventInput {
  action: string;
  details: string | null;
  user_name: string | null;
  entity_name: string | null;
}

export interface AuditText {
  /** Nom court de l'action (« Clôture de caisse »). */
  label: string;
  /** La phrase complète (« ANGE a fermé la caisse « Caisse 1 » (clôture n° 26). »). */
  text: string;
  /** Précision sous la phrase (écart, motif…), ou null. */
  note: string | null;
  level: AuditLevel;
  theme: AuditTheme;
  /** Détail en clair, intitulé par intitulé. */
  fields: [string, string][];
}

export const AUDIT_THEMES: Record<AuditTheme, { label: string; patterns: string[] }> = {
  cash: {
    label: 'Caisse et argent',
    patterns: ['cash.*', 'central.*', 'entry.*', 'drawer.*', 'emoney.*', 'treasury_entry.*', 'cheque*', 'mobilepay.*', 'courier.*', 'agent.*', 'outage.*'],
  },
  sales: {
    label: 'Ventes',
    patterns: ['sale.*', 'counter.*', 'quote.*', 'order.*', 'recurring_order.*', 'summary_invoice.*', 'voucher.*', 'exit.*', 'missed.*', 'consignment.*', 'delivery.*'],
  },
  prices: {
    label: 'Prix et articles',
    patterns: ['article*', 'price.*', 'promotion.*', 'promo_code.*', 'department.*', 'family.*', 'barcode.*', 'book_codes.*'],
  },
  stock: { label: 'Stock', patterns: ['stock.*', 'inventory.*', 'transfer.*', 'store_transfer.*', 'container.*', 'production.*', 'recipe.*', 'recall.*'] },
  partners: { label: 'Clients et fournisseurs', patterns: ['customer*', 'loyalty.*', 'rebate.*', 'offset.*', 'supplier*', 'field_rep.*'] },
  staff: { label: 'Personnel et droits', patterns: ['user.*', 'admin.*', 'staff*', 'attendance.*', 'entrance.*'] },
  accounting: {
    label: 'Comptabilité et dépenses',
    patterns: ['expense.*', 'charge.*', 'accounting.*', 'account.*', 'bank.*', 'budget.*', 'fiscal_year.*', 'tax.*', 'dsf.*', 'asset.*'],
  },
  settings: {
    label: 'Réglages',
    patterns: ['store.*', 'register.*', 'warehouse.*', 'company.*', 'template.*', 'digest.*', 'backup.*', 'repair.*', 'integrity.*', 'data.*', 'sync.*', 'fiche.*', 'license*', 'report_preset.*', 'takeover.*', 'relay.*'],
  },
  logins: { label: 'Connexions', patterns: ['auth.*', 'supervisor.*'] },
};

/** Même règle que le GLOB de SQLite pour les motifs ci-dessus (« * » seulement). */
const globMatch = (pattern: string, action: string) => (pattern.endsWith('*') ? action.startsWith(pattern.slice(0, -1)) : action === pattern);

export function auditTheme(action: string): AuditTheme {
  for (const [theme, def] of Object.entries(AUDIT_THEMES) as [AuditTheme, { patterns: string[] }][]) {
    if (def.patterns.some((p) => globMatch(p, action))) return theme;
  }
  return 'settings';
}

type D = Record<string, unknown>;
interface C {
  d: D;
  /** Nom de la fiche (article, client, caisse, n° de ticket…) ou null. */
  on: string | null;
  /** Nom d'un utilisateur à partir de son identifiant. */
  name: (id: unknown) => string | null;
}
interface Rule {
  l: string;
  /** Ce que la personne a fait, sans son nom (« a fermé la caisse… »). */
  t: (c: C) => string;
  n?: (c: C) => string | null | undefined | false;
  lv?: AuditLevel | ((c: C) => AuditLevel);
  /** La phrase se lit seule, sans « Untel » devant (actions du logiciel). */
  full?: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const F = (v: unknown) => (num(v) === null ? '' : formatFcfa(num(v)!));
const Q = (v: unknown) => (num(v) === null ? '' : formatQty(num(v)!));
const g = (s: unknown) => `« ${str(s) ?? '?'} »`;
const pl = (n: unknown, one: string, many = `${one}s`) => `${num(n) ?? 0} ${(num(n) ?? 0) > 1 ? many : one}`;
const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ') || null;
const dateFr = (v: unknown) => {
  const s = str(v);
  if (!s) return '';
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(t) ? s : new Date(t).toLocaleDateString('fr-FR');
};
const why = (c: C, key = 'reason') => (str(c.d[key]) ? `Motif : ${str(c.d[key])}` : null);
const method = (v: unknown) => (str(v) ? (PAYMENT_METHODS as Record<string, string>)[str(v)!] ?? str(v)! : null);
const art = (c: C) => (c.on ? `l'article ${g(c.on)}` : 'un article');
const cust = (c: C) => (c.on ? `du client ${g(c.on)}` : "d'un client");
const supp = (c: C) => (c.on ? `du fournisseur ${g(c.on)}` : "d'un fournisseur");
const person = (c: C) => (c.on ? g(c.on) : 'un employé');
const ticket = (c: C, key = 'number') => str(c.d[key]) ?? c.on ?? '';
const KIND: Record<string, string> = { cash: 'espèces', electronic: 'électronique', bank: 'banque' };
const reg = (c: C) => (c.on ? `la caisse ${g(c.on)}` : str(c.d['kind']) && KIND[str(c.d['kind'])!] ? `la caisse ${KIND[str(c.d['kind'])!]}` : 'la caisse');
const ROLES: Record<string, string> = { manager: 'Gérant', cashier: 'Caissier', seller: 'Vendeur', buyer: 'Appro', stock: 'Magasinier', accountant: 'Comptable', admin: 'Administrateur' };
const role = (v: unknown) => ROLES[str(v) ?? ''] ?? str(v) ?? '';

/** « Manque de 1 350 FCFA (attendu 1 350 FCFA, compté 0 FCFA) » ou « Aucun écart ». */
function gapNote(c: C, diffKey = 'difference'): string | null {
  const diff = num(c.d[diffKey]);
  if (diff === null) return null;
  const detail = num(c.d['expected']) !== null && num(c.d['counted']) !== null ? ` (attendu ${F(c.d['expected'])}, compté ${F(c.d['counted'])})` : '';
  if (diff === 0) return num(c.d['counted']) !== null ? `Aucun écart : ${F(c.d['counted'])} comptés` : 'Aucun écart';
  return `${diff < 0 ? 'Manque' : 'Surplus'} de ${F(Math.abs(diff))}${detail}`;
}
const gapLevel = (key = 'difference') => (c: C): AuditLevel => ((num(c.d[key]) ?? 0) !== 0 ? 'alert' : 'normal');
const by = (c: C, key = 'by', what = 'Saisi par') => (c.name(c.d[key]) ? `${what} ${c.name(c.d[key])}` : null);
const changed = (from: unknown, to: unknown, fmt: (v: unknown) => string = (v) => str(v) ?? '—') => `${fmt(from)} → ${fmt(to)}`;

const R: Record<string, Rule> = {
  // --- Connexions et codes -------------------------------------------------------
  'auth.login': { l: 'Connexion', t: () => 'a ouvert sa session', lv: 'login' },
  'auth.failed': { l: 'Code faux', t: (c) => `Code faux tapé pour l'identifiant ${g(c.d['login'])}`, full: true, lv: 'alert' },
  'auth.locked': { l: 'Compte bloqué', t: (c) => `Identifiant ${g(c.d['login'])} bloqué ${num(c.d['minutes']) ?? ''} min après plusieurs codes faux`, full: true, lv: 'alert' },
  'supervisor.failed': { l: 'Code du gérant refusé', t: (c) => `Code du gérant refusé sur ce poste (${pl(c.d['failures'], 'essai')})`, full: true, lv: 'alert' },
  'supervisor.locked': { l: 'Code du gérant bloqué', t: (c) => `Code du gérant bloqué ${num(c.d['minutes']) ?? ''} min sur ce poste après trop d'essais`, full: true, lv: 'alert' },

  // --- Caisse et argent ----------------------------------------------------------
  'cash.open': {
    l: 'Ouverture de caisse',
    t: (c) => (num(c.d['openingFloat']) !== null ? `a ouvert ${reg(c)} avec un fond de caisse de ${F(c.d['openingFloat'])}` : `a ouvert ${reg(c)}`),
    n: (c) => (num(c.d['carried']) ? `Dont ${F(c.d['carried'])} reportés de la caisse précédente` : null),
  },
  'cash.count': { l: 'Comptage de caisse', t: (c) => `a compté ${reg(c)}`, n: (c) => gapNote(c), lv: gapLevel() },
  'cash.close': {
    l: 'Clôture de caisse',
    t: (c) => `a fermé ${reg(c)}${num(c.d['zNumber']) !== null ? ` (clôture n° ${num(c.d['zNumber'])})` : ''}`,
    n: (c) =>
      join(
        (num(c.d['difference']) ?? 0) === 0 ? 'Tout est juste' : gapNote(c),
        (num(c.d['difference']) ?? 0) !== 0 && (str(c.d['gapReason']) ? `Motif : ${str(c.d['gapReason'])}` : 'aucun motif saisi'),
        c.name(c.d['gapApprovedBy']) && `Écart accepté par ${c.name(c.d['gapApprovedBy'])}`,
        num(c.d['deposit']) ? `${F(c.d['deposit'])} versés` : null,
      ),
    lv: gapLevel(),
  },
  'cash.gap_justified': {
    l: "Écart de caisse justifié",
    t: (c) => `a justifié l'écart de ${F(Math.abs(num(c.d['difference']) ?? 0))} sur ${reg(c)}${c.d['charged_to_cashier'] ? ', mis à la charge du caissier (retenu sur sa paie)' : ''}`,
    n: (c) => why(c),
    lv: 'watch',
  },
  'cash.handover': { l: 'Passage de caisse', t: (c) => `a passé ${reg(c)} à ${c.name(c.d['to']) ?? 'un collègue'}`, n: (c) => gapNote(c), lv: gapLevel() },
  'cash.in': { l: "Apport d'espèces", t: (c) => `a mis ${F(c.d['amount'])} dans ${reg(c)}`, n: (c) => why(c) },
  'cash.out': { l: "Retrait d'espèces", t: (c) => `a retiré ${F(c.d['amount'])} de ${reg(c)}`, n: (c) => why(c), lv: 'watch' },
  'cash.ceiling': { l: 'Plafond de caisse dépassé', t: (c) => `Plafond d'espèces dépassé dans ${reg(c)} : ${F(c.d['cash'])} pour un plafond de ${F(c.d['ceiling'])}`, full: true, lv: 'watch' },
  'drawer.open': { l: 'Tiroir ouvert sans vente', t: () => 'a ouvert le tiroir-caisse sans vente', lv: 'watch' },
  'emoney.transfer': { l: 'Virement entre caisses électroniques', t: (c) => `a transféré ${F(c.d['amount'])} de ${g(c.d['from'])} vers ${g(c.d['to'])}`, n: (c) => method(c.d['method']) },
  'treasury_entry.cancel': { l: 'Bon de caisse annulé', t: (c) => `a annulé le bon ${str(c.d['number']) ?? ''} de ${F(c.d['amount'])}`, n: (c) => join(why(c), by(c)), lv: 'alert' },
  'treasury_entry.update': {
    l: 'Bon de caisse modifié',
    t: (c) => `a modifié le bon ${str(c.d['number']) ?? ''}`,
    n: (c) => join(`Montant : ${changed((c.d['from'] as D)?.['amount'], (c.d['to'] as D)?.['amount'], F)}`, by(c)),
    lv: 'watch',
  },
  'treasury_entry.unprint': { l: 'Bon à réimprimer', t: (c) => `a permis de réimprimer le bon ${str(c.d['number']) ?? ''} comme un original`, lv: 'watch' },
  'cheque.reject': { l: 'Chèque rejeté', t: (c) => `a enregistré un chèque rejeté de ${F(c.d['amount'])}`, n: (c) => join(num(c.d['fees']) ? `Frais : ${F(c.d['fees'])}` : null, c.d['block'] ? 'Chèques refusés désormais pour ce client' : null), lv: 'alert' },
  'cheque.reject_cancel': { l: 'Rejet de chèque annulé', t: (c) => `a annulé le rejet de chèque ${str(c.d['number']) ?? ''}`, lv: 'watch' },
  'cheque_deposit.create': { l: 'Remise de chèques', t: (c) => `a remis ${pl(c.d['count'], 'chèque')} en banque pour ${F(c.d['total'])}` },
  'cheque_deposit.cancel': { l: 'Remise de chèques annulée', t: (c) => `a annulé la remise de chèques ${str(c.d['number']) ?? ''}`, lv: 'watch' },
  'mobilepay.request': { l: 'Paiement mobile demandé', t: (c) => `a demandé un paiement ${method(c.d['method']) ?? 'mobile'} de ${F(c.d['amount'])}`, n: (c) => (str(c.d['phone']) ? `Au ${str(c.d['phone'])}` : null) },
  'mobilepay.cancel': { l: 'Paiement mobile abandonné', t: () => 'a abandonné une demande de paiement mobile' },
  'mobilepay.late_success': { l: 'Paiement mobile arrivé en retard', t: (c) => `Un paiement mobile de ${F(c.d['amount'])} est arrivé après l'abandon de la vente`, full: true, lv: 'watch' },
  'mobilepay.late_handled': { l: 'Paiement en retard traité', t: () => 'a traité un paiement mobile arrivé en retard', n: (c) => str(c.d['note']) },
  'mobilepay.config': { l: 'Réglage paiement mobile', t: (c) => `a changé le réglage du paiement ${method(c.d['method']) ?? 'mobile'}`, lv: 'watch' },
  'mobilepay.sandbox': { l: 'Paiement mobile en essai', t: () => "a préparé le paiement mobile en mode d'essai" },
  'courier.return': {
    l: 'Retour du livreur',
    t: (c) => `a enregistré le retour du livreur ${g(c.d['courier'])}`,
    n: (c) => `Attendu ${F(c.d['expected'])}, rapporté ${F(c.d['collected'])}`,
    lv: (c) => ((num(c.d['collected']) ?? 0) < (num(c.d['expected']) ?? 0) ? 'alert' : 'normal'),
  },
  'agent.account': { l: 'Compte agent', t: (c) => `a enregistré le compte agent ${g(c.d['name'])}` },
  'agent.cancel': { l: 'Opération agent annulée', t: (c) => `a annulé l'opération agent ${str(c.d['number']) ?? ''}`, n: (c) => why(c), lv: 'alert' },
  'outage.declare': { l: 'Coupure déclarée', t: (c) => `a déclaré la coupure ${str(c.d['number']) ?? ''}`, n: (c) => (num(c.d['declared']) !== null ? `${F(c.d['declared'])} de ventes à saisir` : null) },
  'outage.page': { l: 'Page de carnet ajoutée', t: (c) => `a ajouté la page ${num(c.d['page']) ?? ''} du carnet à la coupure ${str(c.d['number']) ?? ''}` },
  'outage.page_remove': { l: 'Page de carnet retirée', t: (c) => `a retiré la page ${num(c.d['page']) ?? ''} de la coupure ${str(c.d['number']) ?? ''}` },
  'outage.close': {
    l: 'Coupure terminée',
    t: (c) => `a terminé la saisie de la coupure ${str(c.d['number']) ?? ''}`,
    n: (c) => join(`Déclaré ${F(c.d['declared'])}, saisi ${F(c.d['entered'])}`, (num(c.d['gap']) ?? 0) !== 0 ? `écart de ${F(Math.abs(num(c.d['gap'])!))}` : null, why(c)),
    lv: gapLevel('gap'),
  },
  'outage.cancel': { l: 'Coupure annulée', t: (c) => `a annulé la coupure ${str(c.d['number']) ?? ''}`, lv: 'watch' },

  'central.deposit': { l: 'Recette versée à la centrale', t: (c) => `a versé ${F(c.d['amount'])} à la caisse centrale`, n: (c) => str(c.d['label']) },
  'central.float': { l: 'Fond de caisse depuis la centrale', t: (c) => `a sorti ${F(c.d['amount'])} de la caisse centrale pour un fond de caisse`, n: (c) => str(c.d['label']) },
  'central.in': { l: 'Entrée à la centrale', t: (c) => `a mis ${F(c.d['amount'])} dans la caisse centrale`, n: (c) => str(c.d['label']) },
  'central.out': { l: 'Sortie de la centrale', t: (c) => `a sorti ${F(c.d['amount'])} de la caisse centrale`, n: (c) => str(c.d['label']), lv: 'watch' },
  'treasury_entry.in': { l: 'Entrée de caisse', t: (c) => `a enregistré une entrée de ${F(c.d['amount'])}`, n: (c) => join(method(c.d['method']), by(c)) },
  'treasury_entry.out': { l: 'Sortie de caisse', t: (c) => `a enregistré une sortie de ${F(c.d['amount'])}`, n: (c) => join(method(c.d['method']), by(c)), lv: 'watch' },
  'entry.backdate': { l: 'Bon de caisse antidaté', t: (c) => `a changé la date du bon ${str(c.d['number']) ?? ''}`, n: (c) => `Du ${dateFr(c.d['from'])} au ${dateFr(c.d['to'])}`, lv: 'alert' },
  'emoney.in': { l: 'Entrée électronique', t: (c) => `a enregistré une entrée de ${F(c.d['amount'])} sur ${g(c.d['register'])}`, n: (c) => method(c.d['method']) },
  'emoney.out': { l: 'Sortie électronique', t: (c) => `a enregistré une sortie de ${F(c.d['amount'])} de ${g(c.d['register'])}`, n: (c) => method(c.d['method']), lv: 'watch' },
  'agent.deposit': { l: 'Dépôt agent', t: (c) => `a fait un dépôt agent de ${F(c.d['amount'])} pour un client` },
  'agent.withdrawal': { l: 'Retrait agent', t: (c) => `a fait un retrait agent de ${F(c.d['amount'])} pour un client` },
  'agent.airtime': { l: 'Crédit de communication', t: (c) => `a vendu ${F(c.d['amount'])} de crédit de communication` },
  'agent.bill': { l: 'Facture payée', t: (c) => `a payé une facture de ${F(c.d['amount'])} pour un client`, n: (c) => (num(c.d['fee']) ? `Frais ${F(c.d['fee'])}` : null) },
  'agent.float_in': { l: 'Achat de flotte', t: (c) => `a acheté ${F(c.d['amount'])} de flotte avec les espèces de la caisse` },
  'agent.float_out': { l: 'Flotte revendue', t: (c) => `a revendu ${F(c.d['amount'])} de flotte contre des espèces` },
  'agent.commission': { l: "Commission de l'opérateur", t: (c) => `a enregistré une commission de l'opérateur de ${F(c.d['amount'])}` },

  // --- Ventes --------------------------------------------------------------------
  'sale.cancel': { l: 'Ticket annulé', t: (c) => `a annulé le ticket ${ticket(c)} de ${F(c.d['total'])}`, n: (c) => join(why(c), c.name(c.d['cashier']) && `Caissier : ${c.name(c.d['cashier'])}`), lv: 'alert' },
  'sale.return': { l: 'Retour client', t: (c) => `a validé un retour client de ${F(c.d['total'])} sur le ticket ${str(c.d['original']) ?? ''}`, n: (c) => join(why(c), c.name(c.d['cashier']) && `Caissier : ${c.name(c.d['cashier'])}`), lv: 'watch' },
  'sale.discount': {
    l: 'Remise',
    t: (c) => `a accordé une remise de ${F(c.d['amount'])} sur le ticket ${ticket(c)}`,
    n: (c) => join(c.d['authorizedBy'] ? `Autorisée par ${c.name(c.d['authorizedBy']) ?? 'un responsable'}` : null, why(c)),
    lv: 'watch',
  },
  'sale.edit': { l: 'Ticket modifié', t: (c) => `a modifié le ticket ${str(c.d['replaces']) ?? ''}, remplacé par ${str(c.d['number']) ?? ''}`, n: (c) => `Total : ${changed(c.d['before'], c.d['after'], F)}`, lv: 'alert' },
  'sale.edit_request': { l: 'Demande de modification', t: (c) => `a demandé à modifier le ticket ${ticket(c, 'sale')}`, n: (c) => why(c), lv: 'watch' },
  'sale.edit_request.approve': { l: 'Modification acceptée', t: (c) => `a accepté la demande de modification du ticket ${ticket(c, 'sale')}`, n: (c) => str(c.d['note']), lv: 'watch' },
  'sale.edit_request.reject': { l: 'Modification refusée', t: (c) => `a refusé la demande de modification du ticket ${ticket(c, 'sale')}`, n: (c) => str(c.d['note']) },
  'sale.hide': { l: 'Ticket masqué', t: (c) => `a masqué le ticket ${ticket(c)} de ${F(c.d['total'])}`, n: (c) => why(c), lv: 'alert' },
  'sale.price_set': {
    l: 'Prix changé à la caisse',
    t: (c) => `a changé un prix à la caisse sur le ticket ${ticket(c)}`,
    n: (c) => (Array.isArray(c.d['lines']) ? (c.d['lines'] as D[]).map((l) => `${str(l['article']) ?? '?'} à ${F(l['price'])}`).join(', ') : null),
    lv: 'watch',
  },
  'sale.promo_code': { l: 'Code promo', t: (c) => `a appliqué le code promo ${g(c.d['code'])} sur le ticket ${ticket(c)}`, n: (c) => (num(c.d['amount']) ? `${F(c.d['amount'])} déduits` : null) },
  'sale.rounding': { l: 'Arrondi', t: (c) => `a arrondi le ticket ${ticket(c)} de ${F(c.d['amount'])}` },
  'sale.without_stock': { l: 'Vente sans stock', t: (c) => `a vendu sans stock sur le ticket ${ticket(c)}`, n: (c) => (Array.isArray(c.d['lines']) ? `${pl((c.d['lines'] as unknown[]).length, 'article')} sans stock` : null), lv: 'alert' },
  'sale.change_kept': { l: 'Monnaie gardée', t: (c) => `a gardé ${F(c.d['amount'])} de monnaie${str(c.d['customer']) ? ` pour ${g(c.d['customer'])}` : ''}`, n: (c) => (str(c.d['voucher']) ? `Bon ${str(c.d['voucher'])}` : null) },
  'sale.complement': { l: 'Ticket complété depuis un autre dépôt', t: (c) => `a servi une partie du ticket ${ticket(c)} depuis le dépôt ${g(c.d['warehouse'])}` },
  'sale.options': { l: 'Vente à un autre tarif', t: (c) => `a vendu le ticket ${ticket(c)} au tarif ${g(c.d['level'])}`, n: (c) => (str(c.d['warehouse']) ? `Dépôt : ${str(c.d['warehouse'])}` : null), lv: 'watch' },
  'sale.outage': { l: 'Vente de coupure saisie', t: (c) => `a saisi le ticket ${ticket(c)} pendant une coupure`, n: (c) => (str(c.d['at']) ? `Vente du ${dateFr(c.d['at'])}` : null) },
  'sale.book': { l: 'Vente du carnet saisie', t: (c) => `a saisi le ticket ${ticket(c)} depuis le carnet n° ${str(c.d['book']) ?? ''}` },
  'exit.problem': { l: 'Problème à la sortie', t: (c) => `a signalé un problème à la sortie pour le ticket ${ticket(c)}`, n: (c) => str(c.d['note']), lv: 'alert' },
  'missed.notified': { l: 'Client prévenu', t: () => "a prévenu un client que l'article demandé est arrivé" },
  'counter.send': { l: 'Facture envoyée à la caisse', t: (c) => `a envoyé la facture ${ticket(c)} à la caisse`, n: (c) => (num(c.d['total']) !== null ? `Total ${F(c.d['total'])}` : null) },
  'counter.resend': { l: 'Facture renvoyée à la caisse', t: (c) => `a renvoyé la facture ${ticket(c)} modifiée à la caisse`, n: (c) => join(num(c.d['version']) !== null && `Version ${num(c.d['version'])}`, num(c.d['total']) !== null && `Total ${F(c.d['total'])}`) },
  'counter.pay': {
    l: 'Encaissement du comptoir',
    t: (c) => `a encaissé le ticket ${ticket(c)}`,
    n: (c) => (Array.isArray(c.d['invoices']) ? `${pl((c.d['invoices'] as unknown[]).length, 'facture')} du comptoir réglée${(c.d['invoices'] as unknown[]).length > 1 ? 's' : ''}` : null),
  },
  'counter.cancel': { l: 'Facture du comptoir annulée', t: (c) => `a annulé la facture ${ticket(c)} du comptoir`, n: (c) => why(c), lv: 'watch' },
  'counter.edit': { l: 'Facture reprise', t: (c) => `a repris la facture ${ticket(c)} pour la modifier` },
  'counter.return': { l: 'Facture rendue au vendeur', t: (c) => `a rendu la facture ${ticket(c)} au vendeur`, n: (c) => str(c.d['note']) },
  'counter.unlock': { l: 'Facture débloquée', t: (c) => `a débloqué la facture ${ticket(c)}` },
  'delivery.out': { l: 'Livraison partie', t: () => 'a fait partir une livraison' },
  'delivery.delivered': { l: 'Livraison faite', t: () => 'a noté une livraison comme faite' },
  'delivery.cancelled': { l: 'Livraison annulée', t: () => 'a annulé une livraison', lv: 'watch' },
  'quote.create': { l: 'Devis créé', t: (c) => `a fait un devis de ${F(c.d['total'])}`, n: (c) => (num(c.d['discount']) ? `Remise ${F(c.d['discount'])}` : null) },
  'quote.update': { l: 'Devis modifié', t: (c) => `a modifié un devis (${F(c.d['total'])})` },
  'quote.cancel': { l: 'Devis annulé', t: (c) => `a annulé le devis ${str(c.d['number']) ?? ''}` },
  'order.create': {
    l: 'Commande créée',
    t: (c) => (str(c.d['supplier']) ? `a passé une commande au fournisseur ${g(c.d['supplier'])} (${pl(c.d['lines'], 'ligne')})` : `a pris une commande client de ${F(c.d['total'])}`),
  },
  'order.update': { l: 'Commande modifiée', t: (c) => (str(c.d['number']) ? `a modifié la commande ${str(c.d['number'])}` : `a modifié une commande client (${F(c.d['total'])})`) },
  'order.group': { l: 'Commande groupée', t: (c) => `a groupé la commande de ${pl(c.d['stores'], 'magasin')} chez ${g(c.d['supplier'])}` },
  'order.back_order': { l: 'Reliquat commandé', t: (c) => `a recommandé le reste d'une commande client (${pl(c.d['lines'], 'ligne')})` },
  'recurring_order.create': { l: 'Commande régulière créée', t: () => 'a créé une commande régulière' },
  'recurring_order.update': { l: 'Commande régulière modifiée', t: () => 'a modifié une commande régulière' },
  'recurring_order.stop': { l: 'Commande régulière arrêtée', t: () => 'a arrêté une commande régulière' },
  'recurring_order.resume': { l: 'Commande régulière reprise', t: () => 'a repris une commande régulière' },
  'recurring_order.generated': { l: 'Commande régulière préparée', t: (c) => `Commande régulière préparée pour le ${dateFr(c.d['date'])}`, full: true },
  'summary_invoice.create': { l: 'Facture récapitulative', t: (c) => `a fait une facture récapitulative de ${pl(c.d['sales'], 'ticket')} pour ${g(c.d['customer'])}`, n: (c) => (num(c.d['ttc']) !== null ? `Total ${F(c.d['ttc'])}` : null) },
  'summary_invoice.cancel': { l: 'Facture récapitulative annulée', t: (c) => `a annulé la facture récapitulative ${str(c.d['number']) ?? ''}`, lv: 'watch' },
  'voucher.issue': { l: "Bon d'achat émis", t: (c) => `a émis un bon d'achat de ${F(c.d['amount'])}` },
  'voucher.cancel': { l: "Bon d'achat annulé", t: () => "a annulé un bon d'achat", n: (c) => why(c), lv: 'watch' },
  'consignment.open': { l: 'Dépôt-vente ouvert', t: (c) => `a ouvert un dépôt-vente pour ${g(c.d['customer'])}` },
  'consignment.send': { l: 'Marchandise en dépôt-vente', t: (c) => `a envoyé de la marchandise au dépôt-vente ${c.on ? g(c.on) : ''} (${pl(c.d['lines'], 'ligne')})` },
  'consignment.count': { l: 'Comptage du dépôt-vente', t: (c) => `a compté le dépôt-vente ${c.on ? g(c.on) : ''}`, n: (c) => join(num(c.d['total']) ? `Vendu ${F(c.d['total'])}` : null, num(c.d['takenBack']) ? `${pl(c.d['takenBack'], 'article')} repris` : null) },

  // --- Prix et articles ----------------------------------------------------------
  'article.create': { l: 'Article créé', t: (c) => `a créé ${art(c)}` },
  'article.update': { l: 'Article modifié', t: (c) => `a modifié la fiche de ${art(c)}` },
  'article.rename': { l: 'Article renommé', t: (c) => `a renommé l'article ${g(c.d['from'])} en ${g(c.d['to'])}`, n: (c) => why(c), lv: 'watch' },
  'article.photo': { l: 'Photo ajoutée', t: (c) => `a mis une photo sur ${art(c)}` },
  'article.photo_remove': { l: 'Photo retirée', t: (c) => `a retiré la photo de ${art(c)}` },
  'article.location': { l: 'Emplacement', t: (c) => (str(c.d['location']) ? `a rangé ${art(c)} à l'emplacement ${g(c.d['location'])}` : `a retiré l'emplacement de ${art(c)}`) },
  'article.net_content': { l: 'Contenance', t: (c) => `a changé la contenance de ${art(c)}` },
  'article.qty_tiers': { l: 'Prix par quantité', t: (c) => `a changé les prix par quantité de ${art(c)}`, lv: 'watch' },
  'article.shelf_qty': { l: 'Quantité en rayon', t: (c) => `a noté ${Q(c.d['qty'])} en rayon pour ${art(c)}` },
  'article.container': { l: 'Emballage consigné', t: (c) => `a changé l'emballage consigné de ${art(c)}` },
  'articles.vat_exempt': { l: 'TVA retirée', t: (c) => `a passé ${pl(c.d['count'], 'article')} sans TVA`, lv: 'watch' },
  'articles.vat_standard': { l: 'TVA remise', t: (c) => `a remis la TVA sur ${pl(c.d['count'], 'article')}`, lv: 'watch' },
  'barcode.assign': { l: 'Codes-barres attribués', t: (c) => `a attribué ${pl(c.d['created'], 'code-barre', 'codes-barres')}` },
  'book_codes.assign': { l: 'Codes du carnet', t: (c) => `a attribué ${pl(c.d['created'], 'code')} du carnet de ventes` },
  'price.store': { l: 'Prix changé', t: (c) => `a changé le prix de ${art(c)} : ${F(c.d['price'])}`, lv: 'watch' },
  'price.bulk_update': { l: 'Prix changés en lot', t: (c) => `a changé les prix de ${pl(c.d['articles'], 'article')} en une fois`, lv: 'watch' },
  'price.schedule': { l: 'Changement de prix programmé', t: (c) => `a programmé un changement de prix de ${pl(c.d['articles'], 'article')} pour le ${dateFr(c.d['effectiveOn'])}`, lv: 'watch' },
  'price.schedule_applied': { l: 'Prix programmés appliqués', t: (c) => `Les nouveaux prix programmés sont appliqués (${pl(c.d['articles'], 'article')})`, full: true, lv: 'watch' },
  'price.schedule_cancel': { l: 'Programmation de prix annulée', t: () => 'a annulé un changement de prix programmé' },
  'department.rename': { l: 'Rayon renommé', t: (c) => `a renommé le rayon ${g(c.d['from'])} en ${g(c.d['to'])}` },
  'department.delete': { l: 'Rayon supprimé', t: (c) => `a supprimé le rayon ${g(c.d['name'])}`, lv: 'watch' },
  'family.update': { l: 'Famille modifiée', t: (c) => `a modifié la famille ${g((c.d['to'] as D)?.['name'])}` },
  'family.delete': { l: 'Famille supprimée', t: (c) => `a supprimé la famille ${g(c.d['name'])}`, lv: 'watch' },
  'promotion.create': { l: 'Promotion créée', t: (c) => `a créé la promotion ${g(c.d['name'])}`, n: (c) => (str(c.d['from']) ? `Du ${dateFr(c.d['from'])}${str(c.d['to']) ? ` au ${dateFr(c.d['to'])}` : ''}` : null), lv: 'watch' },
  'promotion.update': { l: 'Promotion modifiée', t: (c) => `a modifié la promotion ${g(c.d['name'])}`, lv: 'watch' },
  'promotion.stop': { l: 'Promotion arrêtée', t: () => 'a arrêté une promotion' },
  'promotion.resume': { l: 'Promotion reprise', t: () => 'a relancé une promotion', lv: 'watch' },
  'promo_code.create': { l: 'Code promo créé', t: (c) => `a créé le code promo ${g(c.d['code'])}`, lv: 'watch' },
  'promo_code.update': { l: 'Code promo modifié', t: (c) => `a modifié le code promo ${g(c.d['code'])}`, lv: 'watch' },
  'promo_code.enable': { l: 'Code promo activé', t: (c) => `a activé le code promo ${g(c.d['code'])}` },
  'promo_code.disable': { l: 'Code promo désactivé', t: (c) => `a désactivé le code promo ${g(c.d['code'])}` },

  // --- Stock ---------------------------------------------------------------------
  'stock.receive': { l: 'Réception', t: (c) => `a enregistré la réception ${str(c.d['number']) ?? ''} (${pl(c.d['lines'], 'ligne')})`, n: (c) => (str(c.d['reference']) ? `Référence : ${str(c.d['reference'])}` : null) },
  'stock.receive.correct': { l: 'Réception corrigée', t: () => 'a corrigé une réception', n: (c) => join(`${pl(c.d['before'], 'ligne')} → ${pl(c.d['after'], 'ligne')}`, why(c)), lv: 'watch' },
  'stock.loss': {
    l: 'Sortie en perte',
    t: (c) => `a sorti ${Q(c.d['qty'])} × ${c.on ? g(c.on) : 'un article'} du stock : ${(MOVEMENT_TYPES as Record<string, string>)[str(c.d['type']) ?? '']?.toLowerCase() ?? 'perte'}`,
    n: (c) => why(c),
    lv: 'watch',
  },
  'stock.transfer': { l: 'Transfert entre dépôts', t: () => 'a transféré de la marchandise entre deux dépôts' },
  'stock.inventory': { l: 'Inventaire validé', t: (c) => `a validé un inventaire de ${pl(c.d['lines'], 'article')}`, n: (c) => (num(c.d['totalValue']) !== null ? `Valeur comptée ${F(c.d['totalValue'])}` : null) },
  'stock.regularize': { l: 'Vente sans stock régularisée', t: (c) => `a régularisé ${Q(c.d['qty'])} × ${c.on ? g(c.on) : 'un article'} vendu sans stock` },
  'stock.request': { l: 'Correction de stock demandée', t: (c) => `a demandé à corriger le stock de ${art(c)} : ${changed(c.d['before'], c.d['requested'], Q)}`, lv: 'watch' },
  'stock.request.approve': { l: 'Correction de stock acceptée', t: (c) => `a accepté la correction du stock de ${art(c)}`, lv: 'watch' },
  'stock.request.reject': { l: 'Correction de stock refusée', t: (c) => `a refusé la correction du stock de ${art(c)}` },
  'stock.restock': { l: 'Rayon réassorti', t: (c) => `a réassorti le rayon (${pl(c.d['lines'], 'article')})` },
  'inventory.open': { l: 'Inventaire ouvert', t: (c) => `a ouvert l'inventaire ${str(c.d['number']) ?? ''} (${pl(c.d['lines'], 'article')})` },
  'inventory.add': { l: "Article ajouté à l'inventaire", t: () => "a ajouté un article à l'inventaire en cours" },
  'inventory.remove': { l: "Article retiré de l'inventaire", t: () => "a retiré un article de l'inventaire en cours" },
  'inventory.import': { l: 'Comptages importés', t: (c) => `a importé ${pl(c.d['imported'], 'comptage')} dans l'inventaire`, n: (c) => (num(c.d['unknown']) ? `${pl(c.d['unknown'], 'code inconnu', 'codes inconnus')}` : null) },
  'inventory.close': {
    l: 'Inventaire clôturé',
    t: (c) => `a clôturé l'inventaire ${str(c.d['number']) ?? ''} (${pl(c.d['lines'], 'article')})`,
    n: (c) => join(num(c.d['countedValue']) !== null && `Valeur comptée ${F(c.d['countedValue'])}`, (num(c.d['gapValue']) ?? 0) !== 0 && `Écart ${F(c.d['gapValue'])}`),
    lv: (c) => ((num(c.d['gapValue']) ?? 0) !== 0 ? 'watch' : 'normal'),
  },
  'inventory.cancel': { l: 'Inventaire annulé', t: (c) => `a annulé l'inventaire ${str(c.d['number']) ?? ''}`, lv: 'watch' },
  'transfer.create': { l: 'Transfert préparé', t: (c) => `a préparé un transfert (${pl(c.d['lines'], 'ligne')})` },
  'transfer.update': { l: 'Transfert modifié', t: (c) => `a modifié un transfert (${pl(c.d['lines'], 'ligne')})` },
  'transfer.ship': { l: 'Transfert expédié', t: () => 'a expédié un transfert' },
  'transfer.receive': { l: 'Transfert reçu', t: () => 'a reçu un transfert' },
  'transfer.cancel': { l: 'Transfert annulé', t: () => 'a annulé un transfert', lv: 'watch' },
  'transfer.delete': { l: 'Transfert supprimé', t: (c) => `a supprimé le transfert ${str(c.d['number']) ?? ''}`, lv: 'watch' },
  'store_transfer.request': { l: 'Demande à un autre magasin', t: (c) => `a demandé ${Q(c.d['qty'])} articles à un autre magasin` },
  'store_transfer.ship': { l: 'Envoi à un autre magasin', t: (c) => `a envoyé ${Q(c.d['qty'])} articles à un autre magasin` },
  'store_transfer.receive': { l: "Réception d'un autre magasin", t: (c) => `a reçu ${Q(c.d['qty'])} articles d'un autre magasin`, n: (c) => (num(c.d['shipped']) !== null && num(c.d['shipped']) !== num(c.d['qty']) ? `${Q(c.d['shipped'])} envoyés` : null), lv: (c) => (num(c.d['shipped']) !== null && num(c.d['shipped']) !== num(c.d['qty']) ? 'alert' : 'normal') },
  'container.customer_out': { l: 'Emballages sortis', t: (c) => `a noté ${num(c.d['qty']) ?? ''} emballages partis chez un client` },
  'container.customer_in': { l: 'Emballages rendus', t: (c) => `a noté ${num(c.d['qty']) ?? ''} emballages rendus par un client` },
  'container.supplier_in': { l: 'Emballages reçus', t: (c) => `a noté ${num(c.d['qty']) ?? ''} emballages reçus du fournisseur` },
  'container.supplier_out': { l: 'Emballages rendus au fournisseur', t: (c) => `a noté ${num(c.d['qty']) ?? ''} emballages rendus au fournisseur` },
  'container.adjust': { l: "Stock d'emballages corrigé", t: (c) => `a corrigé le stock d'emballages (${num(c.d['qty']) ?? ''})`, lv: 'watch' },
  'stock.anomaly.fixed': { l: 'Anomalie de stock corrigée', t: (c) => `a corrigé l'anomalie de stock ${g(c.d['title'])}`, n: (c) => str(c.d['note']) },
  'stock.anomaly.ignored': { l: 'Anomalie de stock ignorée', t: (c) => `a ignoré l'anomalie de stock ${g(c.d['title'])}`, n: (c) => str(c.d['note']), lv: 'watch' },
  'store_transfer.refuse': { l: 'Demande refusée', t: () => "a refusé une demande d'un autre magasin", n: (c) => str(c.d['answer']) },
  'store_transfer.cancel': { l: 'Demande annulée', t: () => 'a annulé une demande à un autre magasin', n: (c) => str(c.d['answer']) },
  'container.save': { l: 'Emballage consigné', t: (c) => `a enregistré l'emballage ${g(c.d['name'])}`, n: (c) => (num(c.d['deposit']) !== null ? `Consigne ${F(c.d['deposit'])}` : null) },
  'container.cancel': { l: "Mouvement d'emballages annulé", t: () => "a annulé un mouvement d'emballages", n: (c) => why(c), lv: 'watch' },
  'production.create': { l: 'Fabrication lancée', t: (c) => `a lancé une fabrication de ${Q(c.d['qty'])}` },
  'production.done': { l: 'Fabrication terminée', t: (c) => `a terminé une fabrication de ${Q(c.d['qty'])}`, n: (c) => (num(c.d['total']) !== null ? `Coût ${F(c.d['total'])}` : null) },
  'production.cancel': { l: 'Fabrication annulée', t: () => 'a annulé une fabrication', lv: 'watch' },
  'recipe.create': { l: 'Recette créée', t: (c) => `a créé une recette (${pl(c.d['lines'], 'ingrédient')})` },
  'recipe.update': { l: 'Recette modifiée', t: (c) => `a modifié une recette (${pl(c.d['lines'], 'ingrédient')})` },
  'recipe.archive': { l: 'Recette archivée', t: () => 'a archivé une recette' },
  'recall.create': { l: 'Rappel de lot', t: (c) => `a lancé le rappel du lot ${g(c.d['lot'])} de ${g(c.d['article'])}`, n: (c) => why(c), lv: 'alert' },
  'recall.close': { l: 'Rappel de lot terminé', t: () => 'a terminé un rappel de lot', n: (c) => str(c.d['note']) },

  // --- Clients et fournisseurs ---------------------------------------------------
  'customer.create': { l: 'Client créé', t: (c) => `a créé le client ${g(c.d['name'] ?? c.on)}` },
  'customer.update': { l: 'Client modifié', t: (c) => `a modifié la fiche du client ${g(c.d['name'] ?? c.on)}` },
  'customer.credit_limit': { l: 'Plafond de crédit', t: (c) => `a changé le plafond de crédit ${cust(c)} : ${changed(c.d['from'], c.d['to'], F)}`, lv: 'watch' },
  'customer.credit_override': { l: 'Plafond de crédit dépassé', t: (c) => `a autorisé un crédit de ${F(c.d['amount'])} au-delà du plafond ${cust(c)}`, n: (c) => `Doit déjà ${F(c.d['balance'])} pour un plafond de ${F(c.d['limit'])}`, lv: 'alert' },
  'customer.late_override': { l: 'Crédit malgré un retard', t: (c) => `a autorisé un crédit de ${F(c.d['amount'])} ${cust(c)} malgré un retard de paiement`, lv: 'alert' },
  'customer.payment': { l: 'Règlement client', t: (c) => `a encaissé un règlement de ${F(c.d['amount'])} ${cust(c)}`, n: (c) => method(c.d['method']) },
  'customer.advance': { l: 'Avance client', t: (c) => `a encaissé une avance de ${F(c.d['amount'])} ${cust(c)}`, n: (c) => method(c.d['method']) },
  'customer.article_prices': { l: 'Prix spéciaux du client', t: (c) => `a changé les prix spéciaux ${cust(c)}`, lv: 'watch' },
  'customer.family_discounts': { l: 'Remises du client', t: (c) => `a changé les remises par famille ${cust(c)}`, lv: 'watch' },
  'customer.lettering': { l: 'Règlement affecté', t: (c) => `a affecté le règlement ${str(c.d['number']) ?? ''} aux factures du client` },
  'customer.reminder': { l: 'Client relancé', t: (c) => `a relancé ${c.on ? `le client ${g(c.on)}` : 'un client'}${str(c.d['channel']) ? ` par ${str(c.d['channel'])}` : ''}`, n: (c) => (num(c.d['balance']) !== null ? `Doit ${F(c.d['balance'])}` : null) },
  'customer_payment.cancel': { l: 'Règlement client annulé', t: (c) => `a annulé le règlement client ${str(c.d['number']) ?? ''} de ${F(c.d['amount'])}`, n: (c) => join(why(c), by(c)), lv: 'alert' },
  'loyalty.adjust': { l: 'Points fidélité ajustés', t: (c) => `a ajusté les points fidélité ${cust(c)} : ${(num(c.d['points']) ?? 0) > 0 ? '+' : ''}${num(c.d['points']) ?? ''} points`, n: (c) => why(c), lv: 'watch' },
  'rebate.customer': { l: 'Ristourne', t: (c) => `a calculé la ristourne ${cust(c)}` },
  'rebate.rules': { l: 'Règles de ristourne', t: (c) => `a changé les règles de ristourne${c.on ? ` ${cust(c)}` : ''}`, lv: 'watch' },
  'offset.create': { l: 'Compensation', t: (c) => `a compensé ${F(c.d['amount'])} entre le compte de ${g(c.d['customer'])} et la facture ${str(c.d['invoice']) ?? ''}` },
  'offset.cancel': { l: 'Compensation annulée', t: (c) => `a annulé la compensation ${str(c.d['number']) ?? ''}`, n: (c) => why(c), lv: 'watch' },
  'customer.opening_balance': { l: 'Solde de départ client', t: (c) => `a repris le solde de départ ${cust(c)} : ${F(c.d['amount'])}` },
  'customer.balance_adjustment': { l: 'Solde client ajusté', t: (c) => `a ajusté le solde ${cust(c)} de ${F(c.d['amount'])}`, n: (c) => str(c.d['label']), lv: 'watch' },
  'rebate.earned': { l: 'Ristourne gagnée', t: (c) => `a enregistré une ristourne de ${F(c.d['amount'])} ${cust(c)}` },
  'rebate.adjust': { l: 'Ristourne régularisée', t: (c) => `a régularisé la ristourne ${cust(c)} de ${F(c.d['amount'])}`, lv: 'watch' },
  'rebate.paid': { l: 'Ristourne payée', t: (c) => `a payé une ristourne de ${F(c.d['amount'])} ${cust(c)}` },
  'supplier.opening_balance': { l: 'Solde de départ fournisseur', t: (c) => `a repris le solde de départ ${supp(c)} : ${F(c.d['amount'])}` },
  'supplier.balance_adjustment': { l: 'Solde fournisseur ajusté', t: (c) => `a ajusté le solde ${supp(c)} de ${F(c.d['amount'])}`, n: (c) => str(c.d['label']), lv: 'watch' },
  'supplier_invoice.invoice': { l: 'Facture fournisseur', t: (c) => `a saisi une facture de ${g(c.d['supplier'])} de ${F(c.d['ttc'])}` },
  'supplier_invoice.credit_note': { l: 'Avoir fournisseur', t: (c) => `a saisi un avoir de ${g(c.d['supplier'])} de ${F(c.d['ttc'])}` },
  'order.sent': { l: 'Commande envoyée', t: (c) => `a envoyé la commande ${str(c.d['number']) ?? ''} au fournisseur` },
  'order.closed': { l: 'Commande soldée', t: (c) => `a soldé la commande ${str(c.d['number']) ?? ''}` },
  'order.cancelled': { l: 'Commande annulée', t: (c) => `a annulé la commande ${str(c.d['number']) ?? ''}`, lv: 'watch' },
  'supplier.create': { l: 'Fournisseur créé', t: (c) => `a créé le fournisseur ${g(c.d['name'] ?? c.on)}` },
  'supplier.update': { l: 'Fournisseur modifié', t: (c) => `a modifié la fiche du fournisseur ${g(c.d['name'] ?? c.on)}` },
  'supplier.article': { l: "Prix d'achat", t: (c) => `a noté un prix d'achat de ${F(c.d['unitCost'])} chez ${c.on ? g(c.on) : 'un fournisseur'}` },
  'supplier.article.remove': { l: 'Article retiré du fournisseur', t: () => "a retiré un article de la liste d'un fournisseur" },
  'supplier.visit_days': { l: 'Jours de passage', t: (c) => `a changé les jours de passage ${supp(c)}` },
  'supplier.payment': { l: 'Paiement fournisseur', t: (c) => `a payé ${F(c.d['amount'])} à un fournisseur`, n: (c) => method(c.d['method']) },
  'supplier_payment.cancel': { l: 'Paiement fournisseur annulé', t: (c) => `a annulé un paiement fournisseur de ${F(c.d['amount'])}`, n: (c) => join(why(c), by(c)), lv: 'alert' },
  'supplier_invoice.correct': { l: 'Facture fournisseur corrigée', t: (c) => `a corrigé la facture fournisseur ${str(c.d['number']) ?? ''}`, n: (c) => `Total : ${changed(c.d['from'], c.d['to'], F)}`, lv: 'watch' },
  'supplier_invoice.update': { l: 'Facture fournisseur modifiée', t: (c) => `a modifié la facture fournisseur ${str(c.d['number']) ?? ''}`, lv: 'watch' },
  'supplier_return.create': { l: 'Retour fournisseur', t: (c) => `a préparé un retour au fournisseur ${g(c.d['supplier'])}`, n: (c) => join(num(c.d['ht']) !== null && `${F(c.d['ht'])} HT`, why(c)) },
  'supplier_return.credit': { l: 'Avoir fournisseur', t: (c) => `a enregistré l'avoir fournisseur ${str(c.d['creditNote']) ?? ''} de ${F(c.d['ttc'])}` },
  'field_rep.create': { l: 'Commercial créé', t: (c) => `a créé le commercial ${g(c.d['name'])}` },
  'field_rep.update': { l: 'Commercial modifié', t: (c) => `a modifié le commercial ${g(c.d['name'])}` },

  // --- Comptabilité et dépenses --------------------------------------------------
  'expense.record': {
    l: 'Dépense',
    t: (c) => `a enregistré une dépense de ${F(c.d['amount'])}${c.d['atRegister'] ? ' payée depuis la caisse' : ''}`,
    n: (c) => join(method(c.d['method']), by(c), c.d['approval'] === 'pending' && 'En attente de validation'),
  },
  'expense.update': { l: 'Dépense modifiée', t: (c) => `a modifié la dépense ${str(c.d['number']) ?? ''}`, n: (c) => join(`Montant : ${changed((c.d['from'] as D)?.['amount'], (c.d['to'] as D)?.['amount'], F)}`, by(c)), lv: 'watch' },
  'expense.cancel': { l: 'Dépense annulée', t: (c) => `a annulé la dépense ${str(c.d['number']) ?? ''} de ${F(c.d['amount'])}`, n: (c) => join(why(c), by(c)), lv: 'alert' },
  'expense.attach': { l: 'Justificatif ajouté', t: (c) => `a joint un justificatif à la dépense ${str(c.d['number']) ?? ''}` },
  'expense.detach': { l: 'Justificatif retiré', t: (c) => `a retiré un justificatif de la dépense ${str(c.d['number']) ?? ''}`, lv: 'watch' },
  'expense.approve': { l: 'Dépense validée', t: (c) => `a validé la dépense ${str(c.d['number']) ?? ''} de ${F(c.d['amount'])}`, n: (c) => str(c.d['note']) },
  'expense.reject': { l: 'Dépense refusée', t: (c) => `a refusé la dépense ${str(c.d['number']) ?? ''} de ${F(c.d['amount'])}`, n: (c) => str(c.d['note']), lv: 'watch' },
  'expense.backdate': { l: 'Dépense antidatée', t: (c) => `a changé la date de la dépense ${str(c.d['number']) ?? ''}`, n: (c) => `Du ${dateFr(c.d['from'])} au ${dateFr(c.d['to'])}`, lv: 'alert' },
  'expense.category': { l: 'Catégorie de dépense', t: (c) => `a enregistré la catégorie de dépense ${g(c.d['name'])}` },
  'charge.plan': { l: 'Charge régulière', t: (c) => `a programmé la charge ${g(c.d['label'])} de ${F(c.d['amount'])}` },
  'charge.stop': { l: 'Charge régulière arrêtée', t: (c) => `a arrêté la charge ${g(c.d['label'])}` },
  'charge.delete': { l: 'Charge régulière supprimée', t: (c) => `a supprimé la charge ${g(c.d['label'])}`, lv: 'watch' },
  'accounting.manual_entry': { l: 'Écriture comptable', t: (c) => `a passé l'écriture ${str(c.d['number']) ?? ''} de ${F(c.d['debit'])}` },
  'accounting.manual_entry_update': { l: 'Écriture modifiée', t: (c) => `a modifié l'écriture ${str(c.d['number']) ?? ''}`, lv: 'watch' },
  'accounting.manual_entry_delete': { l: 'Écriture supprimée', t: (c) => `a supprimé l'écriture ${str(c.d['number']) ?? ''}`, lv: 'alert' },
  'account.save': { l: 'Compte enregistré', t: (c) => `a enregistré le compte ${g(c.d['label'])}` },
  'bank.import': { l: 'Relevé bancaire importé', t: (c) => `a importé un relevé bancaire (${pl(c.d['added'], 'ligne')})` },
  'budget.save': { l: 'Budget', t: (c) => `a enregistré un budget de ${F(c.d['total'])}` },
  'fiscal_year.open': { l: 'Exercice ouvert', t: () => 'a ouvert un exercice comptable' },
  'fiscal_year.dates': { l: "Dates d'exercice", t: () => "a changé les dates de l'exercice comptable", lv: 'watch' },
  'fiscal_year.close': { l: 'Exercice clôturé', t: (c) => `a clôturé l'exercice comptable`, n: (c) => (num(c.d['result']) !== null ? `Résultat ${F(c.d['result'])}` : null) },
  'fiscal_year.reopen': { l: 'Exercice rouvert', t: () => "a rouvert l'exercice comptable", lv: 'alert' },
  'fiscal_year.delete': { l: 'Exercice supprimé', t: () => 'a supprimé un exercice comptable', lv: 'alert' },
  'tax.settings': { l: 'Réglages fiscaux', t: () => 'a changé les réglages fiscaux', lv: 'watch' },
  'dsf.disclosures': { l: 'Notes de la DSF', t: () => 'a rempli les notes de la DSF' },
  'asset.create': { l: 'Immobilisation', t: (c) => `a enregistré l'immobilisation ${g(c.d['label'])} de ${F(c.d['cost'])}` },
  'asset.update': { l: 'Immobilisation modifiée', t: (c) => `a modifié l'immobilisation ${g(c.d['label'])}` },
  'asset.dispose': { l: 'Immobilisation sortie', t: (c) => `a sorti une immobilisation${num(c.d['price']) ? ` vendue ${F(c.d['price'])}` : ''}`, lv: 'watch' },
  'asset.delete': { l: 'Immobilisation supprimée', t: (c) => `a supprimé l'immobilisation ${g(c.d['label'])}`, lv: 'alert' },

  // --- Personnel et droits -------------------------------------------------------
  'user.create': { l: 'Compte créé', t: (c) => `a créé le compte de ${person(c)}${str(c.d['role']) ? ` (${role(c.d['role'])})` : ''}` },
  'user.copy': { l: 'Compte copié', t: (c) => `a créé le compte de ${person(c)} sur le modèle de ${c.name(c.d['from']) ?? 'un collègue'}` },
  'user.update': {
    l: 'Compte modifié',
    t: (c) => (c.d['pin'] ? `a changé le code de ${person(c)}` : `a modifié le compte de ${person(c)}`),
    n: (c) => (str(c.d['role']) ? `Nouveau rôle : ${role(c.d['role'])}` : null),
    lv: (c) => (c.d['role'] || c.d['pin'] ? 'watch' : 'normal'),
  },
  'user.delete': { l: 'Compte supprimé', t: (c) => `a supprimé le compte de ${g(c.d['name'])}`, lv: 'alert' },
  'user.unlock': { l: 'Compte débloqué', t: (c) => `a débloqué le compte de ${person(c)}` },
  'user.badge': { l: 'Badge', t: (c) => `a fait un badge pour ${person(c)}` },
  'user.photo': { l: 'Photo', t: (c) => `a mis une photo sur le compte de ${person(c)}` },
  'user.photo_remove': { l: 'Photo retirée', t: (c) => `a retiré la photo du compte de ${person(c)}` },
  'admin.rights': { l: "Droits d'un rôle", t: (c) => `a changé les droits du rôle ${g(c.on ? role(c.on) : role(c.d['role']))}`, lv: 'watch' },
  'admin.privileges': {
    l: 'Droits personnels',
    t: (c) => `a changé les droits personnels de ${person(c)}`,
    n: (c) => join(Array.isArray(c.d['grants']) && (c.d['grants'] as unknown[]).length > 0 && `${pl((c.d['grants'] as unknown[]).length, 'droit')} en plus`, Array.isArray(c.d['revokes']) && (c.d['revokes'] as unknown[]).length > 0 && `${pl((c.d['revokes'] as unknown[]).length, 'droit')} en moins`),
    lv: 'watch',
  },
  'admin.limits': { l: 'Limites personnelles', t: (c) => `a changé les limites de ${person(c)}`, lv: 'watch' },
  'admin.delegate': { l: 'Délégation', t: (c) => `a confié ${pl(c.d['rights'], 'droit')} à ${person(c)}${str(c.d['until']) ? ` jusqu'au ${dateFr(c.d['until'])}` : ''}`, lv: 'watch' },
  'admin.delegate_end': { l: 'Fin de délégation', t: (c) => `a mis fin à la délégation de ${person(c)}` },
  'staff.create': { l: 'Employé créé', t: (c) => `a créé la fiche de l'employé ${g(c.d['name'] ?? c.on)}` },
  'staff.update': { l: 'Employé modifié', t: (c) => `a modifié la fiche de l'employé ${g(c.d['name'] ?? c.on)}`, n: (c) => (num(c.d['baseSalary']) !== null ? `Salaire de base ${F(c.d['baseSalary'])}` : null) },
  'staff.badge': { l: 'Badge employé', t: (c) => `a fait un badge pour ${person(c)}` },
  'staff.photo': { l: 'Photo employé', t: (c) => `a mis une photo sur la fiche de ${person(c)}` },
  'staff.photo_remove': { l: 'Photo employé retirée', t: (c) => `a retiré la photo de ${person(c)}` },
  'staff.punch_pin': { l: 'Code de pointage', t: (c) => `a donné un code de pointage à ${person(c)}` },
  'staff.punch_pin_remove': { l: 'Code de pointage retiré', t: (c) => `a retiré le code de pointage de ${person(c)}` },
  'staff.document': { l: 'Document employé', t: (c) => `a ajouté le document ${g(c.d['label'])} à ${person(c)}` },
  'staff.document_remove': { l: 'Document employé retiré', t: (c) => `a retiré le document ${g(c.d['label'])} de ${person(c)}` },
  'staff.leave': { l: 'Congé', t: (c) => `a enregistré un congé de ${pl(c.d['days'], 'jour')}`, n: (c) => (str(c.d['from']) ? `Du ${dateFr(c.d['from'])} au ${dateFr(c.d['to'])}` : null) },
  'staff.salary': { l: 'Salaire', t: (c) => `a établi le salaire de ${person(c)} pour ${str(c.d['period']) ?? 'la période'}`, n: (c) => (num(c.d['gross']) !== null ? `Brut ${F(c.d['gross'])}` : null) },
  'staff.salary_cancel': { l: 'Salaire annulé', t: (c) => `a annulé le bulletin ${str(c.d['number']) ?? ''} de ${person(c)}`, n: (c) => why(c), lv: 'alert' },
  'staff.leave_approved': { l: 'Congé accordé', t: () => 'a accordé un congé' },
  'staff.leave_refused': { l: 'Congé refusé', t: () => 'a refusé un congé' },
  'staff.leave_cancelled': { l: 'Congé annulé', t: () => 'a annulé un congé' },
  'staff.schedule': { l: 'Horaires', t: (c) => `a changé les horaires de ${person(c)}` },
  'staff.target': { l: 'Objectifs', t: (c) => `a fixé les objectifs de vente de ${person(c)}` },
  'staff.team': { l: 'Équipe', t: (c) => `a changé l'équipe de ${person(c)}` },
  'staff.warning': { l: 'Avertissement', t: (c) => `a donné un avertissement à ${person(c)}`, n: (c) => why(c), lv: 'watch' },
  'staff.warning_cancel': { l: 'Avertissement retiré', t: (c) => `a retiré un avertissement de ${person(c)}` },
  'staff_agency.create': { l: 'Agence créée', t: (c) => `a créé l'agence ${g(c.d['name'])}` },
  'staff_agency.update': { l: 'Agence modifiée', t: (c) => `a modifié l'agence ${g(c.d['name'])}` },
  'staff_team.create': { l: 'Équipe créée', t: (c) => `a créé l'équipe ${g(c.d['name'])}` },
  'staff_team.update': { l: 'Équipe modifiée', t: (c) => `a modifié l'équipe ${g(c.d['name'])}` },
  'entrance.create': { l: 'Entrée créée', t: (c) => `a créé l'entrée de pointage ${g(c.d['name'])}` },
  'entrance.update': { l: 'Entrée modifiée', t: (c) => `a modifié l'entrée de pointage ${g(c.d['name'])}` },
  'attendance.correct': { l: 'Pointage corrigé', t: (c) => `a corrigé le pointage de ${person(c)} du ${dateFr(c.d['day'])}`, n: (c) => why(c), lv: 'watch' },
  'attendance.cancel_punch': { l: 'Pointage annulé', t: (c) => `a annulé un pointage de ${person(c)}`, n: (c) => why(c), lv: 'watch' },
  'attendance.import': { l: 'Pointages importés', t: (c) => `a importé ${pl(c.d['added'], 'pointage')} de la pointeuse` },

  // --- Réglages ------------------------------------------------------------------
  'store.create': { l: 'Magasin créé', t: (c) => `a créé le magasin ${g(c.on ?? c.d['code'])}` },
  'store.update': { l: 'Magasin modifié', t: (c) => `a modifié le magasin ${g(c.on)}` },
  'store.options': { l: 'Options du magasin', t: (c) => `a changé les options du magasin ${g(c.on)}`, lv: 'watch' },
  'store.settings': { l: 'Paramètres du magasin', t: (c) => `a changé les paramètres du magasin ${g(c.on)}`, lv: 'watch' },
  'register.create': { l: 'Caisse créée', t: (c) => `a créé la caisse ${c.on ? g(c.on) : `n° ${num(c.d['number']) ?? ''}`}` },
  'register.update': { l: 'Caisse modifiée', t: (c) => `a modifié la caisse ${g(c.on)}` },
  'register.kind': { l: 'Type de caisse', t: (c) => `a changé le type de la caisse ${g(c.on)} : ${changed(KIND[str(c.d['from']) ?? ''] ?? c.d['from'], KIND[str(c.d['to']) ?? ''] ?? c.d['to'])}`, lv: 'watch' },
  'register.delete': { l: 'Caisse supprimée', t: (c) => `a supprimé la caisse ${g(c.d['name'])}`, lv: 'alert' },
  'warehouse.update': { l: 'Dépôt modifié', t: (c) => `a modifié le dépôt ${g((c.d['to'] as D)?.['name'] ?? c.on)}` },
  'warehouse.disable': { l: 'Dépôt désactivé', t: (c) => `a désactivé le dépôt ${g(c.d['name'])}`, lv: 'watch' },
  'warehouse.enable': { l: 'Dépôt réactivé', t: (c) => `a réactivé le dépôt ${g(c.d['name'])}` },
  'warehouse.sales_default': { l: 'Dépôt des ventes', t: (c) => `a choisi le dépôt ${g(c.d['name'])} pour les ventes`, lv: 'watch' },
  'company.create': { l: 'Société créée', t: (c) => `a créé la société ${g(c.d['name'])}` },
  'company.update': { l: 'Société modifiée', t: (c) => `a modifié la société ${g(c.d['name'])}` },
  'company.assign_store': { l: 'Magasin rattaché', t: (c) => `a rattaché le magasin ${g(c.d['store'])} à une société` },
  'template.apply': { l: 'Modèle de magasin', t: (c) => `a appliqué le modèle ${g(c.d['template'])}`, lv: 'watch' },
  'digest.settings': { l: 'Résumé par e-mail', t: (c) => (c.d['enabled'] ? 'a réglé le résumé quotidien par e-mail' : 'a arrêté le résumé quotidien par e-mail') },
  'backup.configure': { l: 'Réglage des sauvegardes', t: () => 'a changé le réglage des sauvegardes' },
  'backup.create': { l: 'Sauvegarde', t: () => 'a fait une sauvegarde des données' },
  'backup.restore': { l: 'Restauration', t: () => 'a restauré une sauvegarde : les données ont été remplacées', lv: 'alert' },
  'repair.run': { l: 'Réparation de la base', t: () => 'a lancé la réparation de la base', n: (c) => (c.d['ok'] === false ? 'Des problèmes restent' : null), lv: 'watch' },
  'integrity.check': {
    l: "Contrôle d'intégrité",
    t: (c) =>
      c.d['ok'] === false
        ? `a contrôlé le journal scellé : ${pl(c.d['total'], 'pièce')} retouchée${(num(c.d['total']) ?? 0) > 1 ? 's' : ''} en dehors d'ONIX`
        : `a contrôlé le journal scellé : tout est intact (${pl(c.d['rows'], 'pièce')})`,
    lv: (c) => (c.d['ok'] === false ? 'alert' : 'normal'),
  },
  'data.reset': { l: 'Remise à zéro', t: (c) => `a remis les données à zéro${c.d['keepStock'] ? ' (stock gardé)' : ''}`, lv: 'alert' },
  'sync.conflict_ignored': { l: 'Opération ignorée', t: () => "a ignoré une opération venue d'un autre PC : elle n'est pas appliquée ici", n: (c) => why(c), lv: 'watch' },
  'sync.conflict_retried': { l: 'Opération réessayée', t: () => "a réessayé une opération venue d'un autre PC" },
  'sync.refused_untrusted': { l: 'Opérations refusées', t: (c) => `${pl(c.d['count'], 'opération')} d'un poste non reconnu refusée${(num(c.d['count']) ?? 0) > 1 ? 's' : ''}`, full: true, lv: 'alert' },
  'takeover.customers': { l: 'Reprise des clients', t: (c) => `a repris les soldes de ${pl(c.d['lines'], 'client')} de l'ancien logiciel`, n: (c) => (num(c.d['total']) !== null ? `Total ${F(c.d['total'])}` : null), lv: 'watch' },
  'takeover.suppliers': { l: 'Reprise des fournisseurs', t: (c) => `a repris les soldes de ${pl(c.d['lines'], 'fournisseur')} de l'ancien logiciel`, n: (c) => (num(c.d['total']) !== null ? `Total ${F(c.d['total'])}` : null), lv: 'watch' },
  'takeover.stock': { l: 'Reprise du stock', t: (c) => `a repris le stock de départ (${pl(c.d['lines'], 'article')})`, n: (c) => (num(c.d['total']) !== null ? `Valeur ${F(c.d['total'])}` : null), lv: 'watch' },
  'relay.remontee': { l: 'Remontée vers le siège', t: (c) => `a préparé une remontée vers le siège (${pl(c.d['events'], 'opération')})` },
  'relay.miseajour': { l: 'Mise à jour pour un magasin', t: (c) => `a préparé une mise à jour pour un magasin (${pl(c.d['events'], 'opération')})` },
  'relay.integrate.remontee': { l: "Remontée d'un magasin intégrée", t: () => "a intégré la remontée d'un magasin" },
  'relay.integrate.miseajour': { l: 'Mise à jour du siège intégrée', t: () => 'a intégré la mise à jour du siège' },
  'fiche.export': { l: 'Fiche de travail', t: () => 'a préparé une fiche de travail sur clé USB' },
  'fiche.copy': { l: 'Fiche copiée', t: () => 'Une fiche de travail a été copiée', full: true },
  'fiche.return': { l: 'Fiche rapportée', t: (c) => `a rapporté une fiche de travail (${pl(c.d['changes'], 'changement')})`, n: (c) => (Array.isArray(c.d['conflicts']) && (c.d['conflicts'] as unknown[]).length ? `${pl((c.d['conflicts'] as unknown[]).length, 'conflit')}` : null) },
  'fiche.share': { l: 'Partage de fiches', t: () => 'a changé le partage des fiches de travail' },
  license_activate: { l: 'Licence', t: (c) => `a activé la licence${str(c.d['expires']) ? ` jusqu'au ${dateFr(c.d['expires'])}` : ''}` },
  'report_preset.create': { l: 'Vue enregistrée', t: (c) => `a enregistré la vue ${g(c.d['name'])}` },
  'report_preset.update': { l: 'Vue modifiée', t: (c) => `a modifié la vue ${g(c.d['name'])}` },
  'report_preset.delete': { l: 'Vue supprimée', t: () => 'a supprimé une vue enregistrée' },
};

/** Toutes les actions connues, pour les tests et la recherche par mot. */
export const AUDIT_ACTIONS = Object.keys(R);

/** Actions qui peuvent être rouges ou orange (pour le filtre « À surveiller »). */
export const AUDIT_WATCH_ACTIONS = Object.entries(R)
  .filter(([, r]) => r.lv && r.lv !== 'normal' && r.lv !== 'login')
  .map(([a]) => a);

/** Nom court d'une action (« Clôture de caisse »), ou « Autre action » si elle est inconnue. */
export const auditLabel = (action: string) => R[action]?.l ?? 'Autre action';

/** Actions dont le nom contient le mot cherché (« prix », « remise »…). */
export function auditActionsMatching(text: string): string[] {
  const t = fold(text);
  if (t.length < 3) return [];
  return Object.entries(R)
    .filter(([, r]) => fold(r.l).includes(t))
    .map(([a]) => a);
}
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// --- Détail en clair --------------------------------------------------------------

const KEY_LABELS: Record<string, string> = {
  amount: 'Montant', total: 'Total', expected: 'Attendu', counted: 'Compté', difference: 'Écart', price: 'Prix', cost: 'Coût', unitCost: "Prix d'achat",
  deposit: 'Versé', deposited: 'Versé', floatLeft: 'Fond laissé', openingFloat: 'Fond de caisse', carried: 'Reporté', ttc: 'Total TTC', ht: 'Total HT',
  fees: 'Frais', balance: 'Solde', limit: 'Plafond', gross: 'Brut', debit: 'Montant', declared: 'Déclaré', entered: 'Saisi', gap: 'Écart', cash: 'Espèces',
  ceiling: 'Plafond', collected: 'Rapporté', countedValue: 'Valeur comptée', gapValue: 'Écart', totalValue: 'Valeur', discount: 'Remise', baseSalary: 'Salaire de base',
  deducted: 'Retenues', commission: 'Commission', cnps: 'CNPS', tax: 'Impôt', result: 'Résultat', before: 'Avant', after: 'Après', from: 'Avant', to: 'Après',
  zNumber: 'N° de clôture', number: 'Numéro', reason: 'Motif', gapReason: "Motif de l'écart", note: 'Note', kind: 'Type', type: 'Type', method: 'Moyen de paiement',
  qty: 'Quantité', lines: 'Lignes', count: 'Nombre', reference: 'Référence', login: 'Identifiant', name: 'Nom', label: 'Libellé', code: 'Code', customer: 'Client',
  supplier: 'Fournisseur', warehouse: 'Dépôt', store: 'Magasin', invoices: 'Factures', invoice: 'Facture', original: 'Ticket d’origine', replaces: 'Remplace',
  phone: 'Téléphone', minutes: 'Durée (min)', failures: 'Essais', days: 'Jours', day: 'Jour', period: 'Période', role: 'Rôle', location: 'Emplacement',
  articles: 'Articles', sales: 'Tickets', points: 'Points', channel: 'Canal', courier: 'Livreur', lot: 'Lot', article: 'Article', template: 'Modèle',
  authorizedBy: 'Autorisé par', gapApprovedBy: 'Écart accepté par', cashier: 'Caissier', by: 'Saisi par', effectiveOn: "Date d'effet", until: "Jusqu'au",
  atRegister: 'Payé depuis la caisse', version: 'Version', book: 'Carnet', level: 'Tarif', page: 'Page', expiry: 'Péremption', creditNote: 'Avoir',
  imported: 'Importés', unknown: 'Inconnus', added: 'Ajoutés', duplicates: 'Doublons', created: 'Créés', shipped: 'Envoyés', requested: 'Demandé',
};
const MONEY = new Set(['amount', 'total', 'expected', 'counted', 'difference', 'price', 'cost', 'unitCost', 'deposit', 'floatLeft', 'openingFloat', 'carried', 'ttc', 'ht', 'fees', 'balance', 'limit', 'gross', 'debit', 'declared', 'entered', 'gap', 'cash', 'ceiling', 'collected', 'countedValue', 'gapValue', 'totalValue', 'discount', 'baseSalary', 'deducted', 'commission', 'cnps', 'tax', 'result']);
const QTY = new Set(['qty', 'shipped', 'requested']);
const USER_KEYS = new Set(['authorizedBy', 'gapApprovedBy', 'cashier', 'by']);
const DATE_KEYS = new Set(['effectiveOn', 'until', 'day', 'expiry', 'expires', 'at']);
const ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-z]{20,}$/i;

function plain(key: string, v: unknown, c: C, moneyLike: boolean): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  if (typeof v === 'number') return moneyLike || MONEY.has(key) ? formatFcfa(v) : QTY.has(key) ? formatQty(v) : String(v);
  if (typeof v === 'string') {
    if (USER_KEYS.has(key)) return c.name(v);
    if (key === 'method') return method(v);
    if (key === 'kind' && KIND[v]) return KIND[v]!;
    if (key === 'type') return (MOVEMENT_TYPES as Record<string, string>)[v] ?? v;
    if (key === 'role') return role(v);
    if (DATE_KEYS.has(key)) return dateFr(v);
    if (ID_LIKE.test(v)) return null;
    return v;
  }
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.length ? v.join(', ') : null;
    return v.length ? pl(v.length, 'élément') : null;
  }
  if (typeof v === 'object') {
    const parts = Object.entries(v as D)
      .map(([k, x]) => [KEY_LABELS[k], plain(k, x, c, false)] as const)
      .filter(([l, x]) => l && x)
      .map(([l, x]) => `${l!.toLowerCase()} : ${x}`);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

/** Actions dont « avant / après » sont des montants (plafond, total d'un ticket ou d'une facture). */
const MONEY_CHANGES = new Set(['customer.credit_limit', 'sale.edit', 'supplier_invoice.correct']);

function fieldsOf(action: string, c: C): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(c.d)) {
    const label = KEY_LABELS[k];
    if (!label) continue;
    const value = plain(k, v, c, MONEY_CHANGES.has(action) && (k === 'from' || k === 'to' || k === 'before' || k === 'after'));
    if (value) out.push([label, value]);
  }
  return out;
}

function parse(details: string | null): D {
  if (!details) return {};
  try {
    const v = JSON.parse(details) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as D) : {};
  } catch {
    return {};
  }
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** Espaces en trop quand une partie manque ; garde l'espace fine des montants (« 1 350 FCFA »). */
const tidy = (s: string) => s.replace(/\(\s*\)/g, '').replace(/ {2,}/g, ' ').replace(/ +([),.])/g, '$1').trim();

/** La phrase, la précision, la couleur, le thème et le détail en clair d'une ligne du journal. */
export function describeAudit(e: AuditEventInput, nameOf: (id: string) => string | null = () => null): AuditText {
  const d = parse(e.details);
  const c: C = { d, on: e.entity_name, name: (id) => (typeof id === 'string' && id ? nameOf(id) : null) };
  const rule = R[e.action];
  const who = e.user_name ?? "Quelqu'un";
  const theme = auditTheme(e.action);
  if (!rule) {
    return { label: 'Autre action', text: `${who} a fait une action « ${e.action} »${e.entity_name ? ` sur ${g(e.entity_name)}` : ''}.`, note: null, level: 'normal', theme, fields: fieldsOf(e.action, c) };
  }
  let body: string;
  let note: string | null;
  let level: AuditLevel;
  try {
    body = tidy(rule.t(c));
    note = rule.n ? (rule.n(c) || null) : null;
    level = typeof rule.lv === 'function' ? rule.lv(c) : rule.lv ?? 'normal';
  } catch {
    body = `a fait l'action « ${rule.l} »`;
    note = null;
    level = 'normal';
  }
  const text = rule.full ? `${capital(body)}.` : `${who} ${body}.`;
  return { label: rule.l, text, note: note ? tidy(note) : null, level, theme, fields: fieldsOf(e.action, c) };
}
