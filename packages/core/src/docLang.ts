import type { Receipt } from './escpos';

/**
 * Langue des documents imprimés. Les documents sont composés en français ; pour un
 * client qui a choisi l'anglais (ou un utilisateur en anglais pour les bons de caisse),
 * chaque texte imprimé passe par cette traduction juste avant l'impression. Les noms
 * de produits, de clients et les numéros ne sont pas touchés.
 */
export type DocLang = 'fr' | 'en';
export const DOC_LANGS: DocLang[] = ['fr', 'en'];
export const DOC_LANG_LABELS: Record<DocLang, string> = { fr: 'Français', en: 'English' };

/** Textes imprimés, tels quels. */
const EN: Record<string, string> = {
  // Titres des documents
  Facture: 'Invoice',
  FACTURE: 'INVOICE',
  'Facture à terme': 'Credit invoice',
  'FACTURE À TERME': 'CREDIT INVOICE',
  'Facture proforma': 'Proforma invoice',
  Proforma: 'Proforma',
  PROFORMA: 'PROFORMA',
  'FACTURE PROFORMA': 'PROFORMA INVOICE',
  Devis: 'Quote',
  DEVIS: 'QUOTE',
  Avoir: 'Credit note',
  'Avoir fournisseur': 'Supplier credit note',
  'Bon de livraison': 'Delivery note',
  'BON DE LIVRAISON': 'DELIVERY NOTE',
  'Bon de commande': 'Purchase order',
  'BON DE COMMANDE': 'PURCHASE ORDER',
  'Facture d’achat': 'Purchase invoice',
  'FACTURE D’ACHAT': 'PURCHASE INVOICE',
  'RETOUR CLIENT': 'CUSTOMER RETURN',
  ANNULÉ: 'CANCELLED',
  '(annulé)': '(cancelled)',
  '(ANNULÉE)': '(CANCELLED)',
  '· ANNULÉE': '· CANCELLED',
  DUPLICATA: 'DUPLICATE',
  Ticket: 'Receipt',
  'Ticket de caisse': 'Till receipt',
  'RAPPORT Z': 'Z REPORT',
  'REÇU DE RÈGLEMENT': 'PAYMENT RECEIPT',
  'REÇU DE CAISSE': 'CASH RECEIPT',
  'Reçu de caisse': 'Cash receipt',
  'Bon de sortie de caisse': 'Cash payout slip',
  'BON DE SORTIE DE CAISSE': 'CASH PAYOUT SLIP',
  'BON DE VERSEMENT': 'DEPOSIT SLIP',
  'BON DE VERSEMENT ÉLECTRONIQUE': 'ELECTRONIC DEPOSIT SLIP',
  'BON DE REMISE DE FOND': 'FLOAT HANDOVER SLIP',
  'BON DE RISTOURNE': 'REBATE VOUCHER',
  'ENTRÉE EN CAISSE CENTRALE': 'CENTRAL CASH RECEIPT',
  'SORTIE DE CAISSE CENTRALE': 'CENTRAL CASH PAYOUT',
  'ENTRÉE CAISSE ÉLECTRONIQUE': 'ELECTRONIC REGISTER RECEIPT',
  'SORTIE CAISSE ÉLECTRONIQUE': 'ELECTRONIC REGISTER PAYOUT',
  'TRANSFERT ÉLECTRONIQUE': 'ELECTRONIC TRANSFER',
  'PIÈCE DE DÉPENSE': 'EXPENSE VOUCHER',
  'PAGE DE TEST': 'TEST PAGE',
  'Relevé de compte': 'Account statement',
  'Factures restant dues': 'Invoices still due',
  // Colonnes et cases
  'N°': 'No.',
  'Réf. fournisseur': 'Supplier ref.',
  Code: 'Code',
  CODE: 'CODE',
  'Code-barres': 'Barcode',
  Désignation: 'Description',
  DÉSIGNATION: 'DESCRIPTION',
  Qté: 'Qty',
  QTÉ: 'QTY',
  QTE: 'QTY',
  Unité: 'Unit',
  'PU TTC': 'Unit price',
  'P.U. TTC': 'Unit price',
  'P.U.': 'U.P.',
  'PU HT': 'Unit price excl. tax',
  Remise: 'Discount',
  REMISE: 'DISCOUNT',
  TVA: 'VAT',
  'Total HT': 'Total excl. tax',
  'Total TTC': 'Total incl. tax',
  Gratuits: 'Free',
  'Coût net': 'Net cost',
  'COND.': 'PACK',
  Colis: 'Parcels',
  'NB COLIS': 'PARCELS',
  MONTANT: 'AMOUNT',
  'MONTANT TTC': 'AMOUNT INCL. TAX',
  TOTAL: 'TOTAL',
  TOTAUX: 'TOTALS',
  DATE: 'DATE',
  CLIENT: 'CUSTOMER',
  'RÉF.': 'REF.',
  RÉF: 'REF',
  'MAG. DE LIVR. :': 'DELIVERY STORE:',
  'MONTANT EN LETTRES': 'AMOUNT IN WORDS',
  'N° de pièce': 'Document no.',
  'PAR :': 'BY:',
  ÉTABLI: 'ISSUED',
  FACTURÉ: 'INVOICED',
  Date: 'Date',
  Pièce: 'Document',
  Libellé: 'Label',
  Débit: 'Debit',
  Crédit: 'Credit',
  Solde: 'Balance',
  Échéance: 'Due date',
  'Reste dû': 'Balance due',
  Heure: 'Time',
  Nature: 'Type',
  'Pièce / motif': 'Document / reason',
  Tiers: 'Third party',
  Moyen: 'Method',
  Référence: 'Reference',
  Par: 'By',
  Montant: 'Amount',
  Caissier: 'Cashier',
  Vendeur: 'Seller',
  Client: 'Customer',
  Type: 'Type',
  Bénéficiaire: 'Beneficiary',
  Quantité: 'Quantity',
  Valeur: 'Value',
  Produit: 'Product',
  Article: 'Item',
  // Totaux et règlement
  'TOTAL FCFA': 'TOTAL FCFA',
  'TOTAL HT FCFA': 'TOTAL EXCL. TAX FCFA',
  'TOTAL HT': 'TOTAL EXCL. TAX',
  'Total HT (FCFA)': 'Total excl. tax (FCFA)',
  'Total TTC (FCFA)': 'Total incl. tax (FCFA)',
  'Total (FCFA)': 'Total (FCFA)',
  'Total FCFA': 'Total FCFA',
  'Net à payer': 'Net to pay',
  'Net à payer TTC': 'Net to pay incl. tax',
  'NET À PAYER': 'NET TO PAY',
  Remises: 'Discounts',
  'Remises accordées': 'Discounts given',
  'Remises accordées :': 'Discounts given:',
  Promotions: 'Promotions',
  'Arrondi espèces': 'Cash rounding',
  'dont arrondi espèces': 'of which cash rounding',
  'Vous avez économisé': 'You saved',
  'Rendu monnaie': 'Change',
  'Reste à payer': 'Balance due',
  'Solde de votre compte': 'Your account balance',
  'Points utilisés': 'Points used',
  'Points gagnés': 'Points earned',
  'Vos points fidélité': 'Your loyalty points',
  'TVA non applicable': 'VAT not applicable',
  'TVA non applicable.': 'VAT not applicable.',
  'dont TVA': 'of which VAT',
  'toutes taxes comprises': 'all taxes included',
  'Client comptoir': 'Counter customer',
  'Solde dû (FCFA)': 'Balance due (FCFA)',
  Espèces: 'Cash',
  'Carte bancaire': 'Bank card',
  Virement: 'Bank transfer',
  Chèque: 'Cheque',
  'Crédit client': 'Customer credit',
  "Bon d'achat": 'Gift voucher',
  'Points fidélité': 'Loyalty points',
  Comptant: 'Cash',
  'À terme': 'On credit',
  'Reçu FCFA': 'Received FCFA',
  'Montant FCFA': 'Amount FCFA',
  'Reste dû après règlement': 'Balance due after payment',
  // Signatures et mentions
  'Le client': 'The customer',
  'Le caissier': 'The cashier',
  'Le gérant': 'The manager',
  'Le responsable': 'The person in charge',
  'Le bénéficiaire': 'The beneficiary',
  'Le chauffeur': 'The driver',
  'Le contrôleur': 'The inspector',
  'Le gestionnaire': 'The manager',
  'Le magasinier': 'The storekeeper',
  'Livré par': 'Delivered by',
  'Reçu par': 'Received by',
  'Reçu par (nom, date et signature)': 'Received by (name, date and signature)',
  'Remis par': 'Handed over by',
  'Versé par': 'Deposited by',
  'Fait par': 'Made by',
  'Autorisé par': 'Authorised by',
  'Compté par': 'Counted by',
  'Contrôlé par': 'Checked by',
  Signature: 'Signature',
  'Signature et cachet': 'Signature and stamp',
  Visa: 'Approval',
  'Bon pour accord, le client Date et signature': 'Approved, the customer Date and signature',
  'Bon pour accord, le client': 'Approved, the customer',
  'Date et signature': 'Date and signature',
  '(nom, date et signature)': '(name, date and signature)',
  'Merci !': 'Thank you!',
  'Solde du compte': 'Account balance',
  'Merci de votre visite !': 'Thank you for your visit!',
  'Merci de votre fidélité': 'Thank you for your loyalty',
  'Chez nous, le roi c’est vous !': 'With us, you are king!',
  'Marchandises reçues en bon état et conformes à la commande.': 'Goods received in good condition and as ordered.',
  'Veuillez toujours vérifier la qualité et la quantité de vos marchandises avant de les emporter.': 'Please always check the quality and quantity of your goods before taking them away.',
  'Établi par': 'Issued by',
  // Rapport Z, bons et clôture
  'Solde de départ': 'Opening balance',
  Encaissé: 'Collected',
  'Transferts reçus': 'Transfers received',
  Sorties: 'Payouts',
  Attendu: 'Expected',
  Relevé: 'Declared',
  Écart: 'Difference',
  'Versé à la centrale': 'Deposited to central',
  'Reste sur le compte': 'Left on the account',
  'Total attendu': 'Total expected',
  'Total relevé': 'Total declared',
  'Sorties du compte': 'Account payouts',
  Tickets: 'Receipts',
  'Ventes TTC': 'Sales incl. tax',
  Retours: 'Returns',
  'CA net TTC': 'Net turnover incl. tax',
  'Chiffre d’affaires net TTC': 'Net turnover incl. tax',
  'Chiffre d’affaires net': 'Net turnover',
  'CA net': 'Net turnover',
  Encaissements: 'Collections',
  'Payé sur une autre caisse': 'Paid on another register',
  'Règlements clients (crédit)': 'Customer payments (credit)',
  'Règlements clients': 'Customer payments',
  'Règlements clients en espèces': 'Customer payments in cash',
  'Dépenses payées en caisse': 'Expenses paid at the register',
  'Dépenses payées': 'Expenses paid',
  'Fond de caisse': 'Cash float',
  'Fond à l’ouverture': 'Float at opening',
  'dont fond laissé la veille': 'of which float left the day before',
  'Ventes espèces': 'Cash sales',
  'Ventes en espèces': 'Cash sales',
  'Ventes à crédit': 'Credit sales',
  Remboursements: 'Refunds',
  Apports: 'Cash in',
  Prélèvements: 'Cash pickups',
  'Prélèvements versés à la centrale': 'Pickups deposited to central',
  'Autres entrées (Encaisser)': 'Other receipts (Collect)',
  'Autres sorties (Décaisser)': 'Other payouts (Pay out)',
  Théorique: 'Theoretical',
  Compté: 'Counted',
  'Versé à la caisse centrale': 'Deposited to the central cash',
  'Fond laissé dans le tiroir': 'Float left in the drawer',
  'Attendu à la clôture': 'Expected at closing',
  'Relevé à la clôture': 'Declared at closing',
  'Premier comptage': 'First count',
  Différentiel: 'Difference',
  Vente: 'Sale',
  Retour: 'Return',
  'Caisse centrale': 'Central cash',
  'Caisse électronique centrale': 'Central electronic register',
  'Entrées d’espèces': 'Cash receipts',
  "Entrées d'espèces": 'Cash receipts',
  "Sorties d'espèces": 'Cash payouts',
  'Total des entrées': 'Total receipts',
  'Total des sorties (hors versement de clôture)': 'Total payouts (excluding closing deposit)',
  'Écart à justifier par le gérant.': 'Difference to be justified by the manager.',
  'Écart à expliquer': 'Difference to explain',
  Apport: 'Cash in',
  Prélèvement: 'Cash pickup',
  Remboursement: 'Refund',
  Dépense: 'Expense',
  Versement: 'Deposit',
  Reste: 'Remaining',
  Ouverture: 'Opening',
  Clôture: 'Closing',
  Caisse: 'Register',
  'Règlement client': 'Customer payment',
  'Règlement fournisseur': 'Supplier payment',
  Fournisseur: 'Supplier',
  Total: 'Total',
  FCFA: 'FCFA',
};

/** Textes imprimés avec un numéro, une date ou un nom. */
const EN_PATTERNS: [RegExp, string | ((m: RegExpExecArray, t: (s: string) => string) => string)][] = [
  [/^Arrêté à la somme de (.+) francs CFA$/, (m) => `Amount in words: ${wordsEn(m[1]!)} CFA francs`],
  [/^(.+) francs CFA$/, (m) => `${wordsEn(m[1]!)} CFA francs`],
  [/^Arrêté à la somme de$/, 'Amount in words:'],
  [/^Pour (.+)$/, 'For $1'],
  [/^(\d+) Colis$/, '$1 parcels'],
  [/^Prix garantis jusqu'au (.+) dans la limite des stocks disponibles\. Ce document n'est pas une facture définitive\.$/, 'Prices guaranteed until $1 while stocks last. This document is not a final invoice.'],
  [/^FACTURÉ PAR : (.+)$/, 'INVOICED BY: $1'],
  [/^ÉTABLI PAR : (.+)$/, 'ISSUED BY: $1'],
  [/^MAG\. DE LIVR\. : (.+)$/, 'DELIVERY STORE: $1'],
  [/^(.+ %) HT (.+)$/, '$1 excl. tax $2'],
  [/^toutes taxes comprises\.$/, 'all taxes included.'],
  [/^Valable jusqu'au (.+)$/, 'Valid until $1'],
  [/^À régler avant le (.+)$/, 'Due by $1'],
  [/^N° (.+)$/, 'No. $1'],
  [/^Ticket (.+)$/, 'Receipt $1'],
  [/^(Client|Fournisseur) : (.+)$/, (m) => `${m[1] === 'Client' ? 'Customer' : 'Supplier'}: ${m[2]}`],
  [/^Compte : (.+)$/, 'Account: $1'],
  [/^Compte (.+)$/, 'Account $1'],
  [/^Tél\.? ?: (.+)$/, 'Tel.: $1'],
  [/^Tél\. client : (.+)$/, 'Customer tel.: $1'],
  [/^Tarif : (.+)$/, (m, t) => `Price list: ${t(m[1]!)}`],
  [/^Date : (.+)$/, 'Date: $1'],
  [/^Échéance : (.+)$/, 'Due date: $1'],
  [/^Vendeur : (.+)$/, 'Seller: $1'],
  [/^Établi par : (.+)$/, 'Issued by: $1'],
  [/^Caisse : (.+)$/, 'Register: $1'],
  [/^Solde du compte : $/, 'Account balance: '],
  [/^Qté : (.+)$/, 'Qty: $1'],
  [/^\(remise (.+)\)$/, '(discount $1)'],
  [/^\+ (.+) gratuits$/, '+ $1 free'],
  [/^TVA (.+) sur (.+)$/, 'VAT $1 on $2'],
  [/^TVA (.+)$/, 'VAT $1'],
  [/^Promo (.+)$/, 'Promo $1'],
  [/^Livrer à : (.+)$/, 'Deliver to: $1'],
  [/^Livraison le (.+)$/, 'Delivery on $1'],
  [/^Livraison souhaitée : (.+)$/, 'Requested delivery: $1'],
  [/^Facture du fournisseur n° (.+) du (.+)$/, 'Supplier invoice no. $1 of $2'],
  [/^RAPPORT Z n° (\d+)$/, 'Z REPORT no. $1'],
  [/^RAPPORT Z \(provisoire\)$/, 'Z REPORT (provisional)'],
  [/^Ouverture (.+)$/, 'Opening $1'],
  [/^Clôture (.+)$/, 'Closing $1'],
  [/^Motif de l'écart : (.+)$/, 'Reason for the difference: $1'],
  [/^Motif de l'écart :$/, 'Reason for the difference:'],
  [/^Annulations \((\d+)\)$/, 'Cancellations ($1)'],
  [/^Versement (.+) vers (.+)$/, 'Deposit $1 to $2'],
  [/^De : caisse centrale · À : (.+)$/, 'From: central cash · To: $1'],
  [/^De : (.+) · À : caisse centrale$/, 'From: $1 · To: central cash'],
  [/^De : (.+) · À : (.+)$/, 'From: $1 · To: $2'],
  [/^Espèces comptées \(Z(\d+)\)$/, 'Cash counted (Z$1)'],
  [/^Réf\. (.+)$/, 'Ref. $1'],
  [/^(.+) : relevé (.+)$/, '$1: declared $2'],
  [/^reste (.+)$/, 'left $1'],
  [/^Du (.+) au (.+)$/, 'From $1 to $2'],
  [/^au (.+)$/, 'to $1'],
  [/^Solde au (.+)$/, 'Balance at $1'],
  [/^(\d+) j de retard$/, '$1 days overdue'],
  [/^Plafond de crédit : (.+) FCFA · Délai de paiement : (\d+) jours$/, 'Credit limit: $1 FCFA · Payment term: $2 days'],
  [/^Bon de clôture (.+)$/, 'Closing slip $1'],
  [/^Rapport de clôture (.+)$/, 'Closing report $1'],
  [/^ · Z n° (\d+)$/, ' · Z no. $1'],
  [/^Paiements reçus \((\d+)\)$/, 'Payments received ($1)'],
  [/^Entrées \((\d+)\)$/, 'Receipts ($1)'],
  [/^Sorties \((\d+)\)$/, 'Payouts ($1)'],
  [/^Historique des ventes \((\d+)\)$/, 'Sales history ($1)'],
  [/^(\d+) ventes, (\d+) annulés$/, '$1 sales, $2 cancelled'],
  [/^Annulé : (.*)$/, 'Cancelled: $1'],
  [/^(.+) \(sur (.+)\)$/, (m, t) => `${t(m[1]!)} (on ${m[2]})`],
  // Libellé connu suivi de sa valeur : « Reste à payer : 10 000 ».
  [/^([^:]+?) : (.+)$/, (m, t) => (t(m[1]!) === m[1] ? m[0] : `${t(m[1]!)}: ${m[2]}`)],
];

/**
 * Morceaux traduits à leur place dans une phrase composée. Les en-têtes du ticket
 * encadré gardent leur largeur (« COND. » → « PACK  ») pour rester alignés.
 */
const PIECES: [string, string][] = [
  ['Ouverture le', 'Opened on'],
  ['clôture le', 'closing on'],
  ['par', 'by'],
  ['(journée en cours)', '(day in progress)'],
  [', justifié par', ', justified by'],
  ['dont TVA', 'of which VAT'],
  ['Z n°', 'Z no.'],
  ['TOTAUX', 'TOTALS'],
  ['Colis', 'parcels'],
  ['QTE', 'QTY'],
  ['COND.', 'PACK '],
  ['P.U.', 'U.P.'],
  ['P.U', 'U.P'],
];

const ORDERED_PIECES = [...PIECES]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([fr, en]) => [new RegExp(`(?<![\\p{L}\\d])${fr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'gu'), en] as const);
/** Textes imprimés en majuscules (« LE CLIENT ») : même traduction, en majuscules. */
let upper: Map<string, string> | null = null;

function lookup(s: string): string | null {
  const exact = EN[s];
  if (exact !== undefined) return exact;
  if (s.startsWith('· ')) {
    const rest = lookup(s.slice(2));
    return rest === null ? null : `· ${rest}`;
  }
  if (/\p{Lu}/u.test(s) && s === s.toUpperCase()) {
    upper ??= new Map(Object.entries(EN).map(([fr, en]) => [fr.toUpperCase(), en.toUpperCase()]));
    const up = upper.get(s) ?? upper.get(s.replace(/\s*:$/, ''));
    if (up !== undefined) return s.endsWith(':') && !up.endsWith(':') ? `${up}:` : up;
  }
  const end = /^(.*?)(\s*:)$/.exec(s);
  if (end && EN[end[1]!] !== undefined) return `${EN[end[1]!]}:`;
  if (s.includes(' · ')) {
    const parts = s.split(' · ');
    const done = parts.map((p) => lookup(p));
    if (done.some((p) => p !== null)) return done.map((p, i) => p ?? parts[i]).join(' · ');
  }
  for (const [re, to] of EN_PATTERNS) {
    const m = re.exec(s);
    if (m) return typeof to === 'string' ? s.replace(re, to) : to(m, (x) => lookup(x) ?? x);
  }
  // Titre suivi de son numéro : « Facture DLA1-1-000123 (annulé) », « FACTURE N° DLA1-1-000123 ».
  const num = /^(.+?)( N°)? (\S*\d\S*)(.*)$/.exec(s);
  if (num && EN[num[1]!] !== undefined) {
    const rest = num[4]!.trim();
    return `${EN[num[1]!]}${num[2] ? (num[1] === num[1]!.toUpperCase() ? ' NO.' : ' no.') : ''} ${num[3]}${rest ? ` ${lookup(rest) ?? rest}` : ''}`;
  }
  // Montant en lettres seul (facture listing) : « Quinze-mille ».
  const amount = /^[a-zàéèêç]+(?:[- ][a-zàéèêç]+)*$/i.test(s) ? frenchWordsToNumber(s) : null;
  // Un mot seul comme « Neuf » ou « Six » peut être un nom : seulement les montants composés ou à partir de onze.
  if (amount !== null && (/[- ]/.test(s) || amount > 10)) {
    const en = numberToWordsEn(amount);
    return s[0] === s[0]!.toUpperCase() ? en[0]!.toUpperCase() + en.slice(1) : en;
  }
  let out = s;
  for (const [re, en] of ORDERED_PIECES) out = out.replace(re, en);
  return out === s ? null : out;
}

/** Traduit un texte imprimé (garde les espaces autour). */
export function translateDocText(text: string, lang: DocLang): string {
  if (lang === 'fr') return text;
  const trimmed = text.trim();
  if (!trimmed || !/[A-Za-zÀ-ÿ]/.test(trimmed)) return text;
  const found = lookup(trimmed);
  if (found === null) return text;
  const start = text.length - text.trimStart().length;
  return text.slice(0, start) + found + text.slice(start + trimmed.length);
}

/** Ticket ESC/POS ou pilote : chaque texte et chaque libellé. */
export function translateReceipt(receipt: Receipt, lang: DocLang): Receipt {
  if (lang === 'fr') return receipt;
  return receipt.map((l) =>
    l.t === 'text' ? { ...l, text: translateDocText(l.text, lang) } : l.t === 'row' ? { ...l, left: translateDocText(l.left, lang), right: translateDocText(l.right, lang) } : l,
  );
}

/** Page HTML d'un document : le texte entre les balises, jamais les styles ni les attributs. */
export function translateDocHtml(html: string, lang: DocLang): string {
  if (lang === 'fr') return html;
  const at = html.indexOf('<body');
  const head = at < 0 ? '' : html.slice(0, at);
  const body = at < 0 ? html : html.slice(at);
  // Cases en majuscules (class « up ») : noms de produits et unités, gardés tels quels.
  return head + body.replace(/(<[^>]*>)([^<]+)(?=<)/g, (all, tag: string, text: string) => (/class="[^"]*\bup\b/.test(tag) ? all : tag + translateDocText(text, lang)));
}

// --- Montant en lettres -------------------------------------------------------

const FR_VALUES: Record<string, number> = {
  zéro: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30,
  quarante: 40, cinquante: 50, soixante: 60,
};

/** « cent-treize-mille » → 113 000 ; null si le texte n'est pas un nombre en lettres. */
export function frenchWordsToNumber(words: string): number | null {
  if (!words.trim()) return null;
  let total = 0;
  let current = 0;
  for (const w of words.trim().toLowerCase().split(/[\s-]+/)) {
    if (w === 'et') continue;
    if (w === 'vingt' || w === 'vingts') {
      // quatre-vingt(s) : 4 × 20.
      current = current % 10 === 4 && current % 100 < 10 ? current - 4 + 80 : current + 20;
    } else if (w in FR_VALUES) current += FR_VALUES[w]!;
    else if (w === 'cent' || w === 'cents') current = (current || 1) * 100 + 0;
    else if (w === 'mille') (total += (current || 1) * 1000), (current = 0);
    else if (w === 'million' || w === 'millions') (total += (current || 1) * 1e6), (current = 0);
    else if (w === 'milliard' || w === 'milliards') (total += (current || 1) * 1e9), (current = 0);
    else return null;
  }
  return total + current;
}

const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enBelowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const tail = r === 0 ? '' : r < 20 ? EN_UNITS[r]! : `${EN_TENS[Math.floor(r / 10)]}${r % 10 ? `-${EN_UNITS[r % 10]}` : ''}`;
  return [h ? `${EN_UNITS[h]} hundred` : '', tail].filter(Boolean).join(' and ');
}

/** Montant en toutes lettres en anglais : 113 000 → « one hundred and thirteen thousand ». */
export function numberToWordsEn(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 1e12) throw new Error(`Number out of range: ${n}`);
  if (n === 0) return 'zero';
  const parts: string[] = [];
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as const) {
    const q = Math.floor(n / size) % 1000;
    if (q) parts.push(`${enBelowThousand(q)} ${name}`);
  }
  if (n % 1000) parts.push(enBelowThousand(n % 1000));
  return parts.join(' ');
}

function wordsEn(fr: string): string {
  const n = frenchWordsToNumber(fr);
  return n === null ? fr : numberToWordsEn(n);
}
