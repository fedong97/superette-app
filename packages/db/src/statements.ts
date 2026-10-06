import type { Fcfa } from '@superette/core';
import type { AccountingService } from './accounting';
import type { StockService } from './stock';
import { AppError, Base } from './util';

/** Ligne d'un état : référence SYSCOHADA (AD, TA, XA…), libellé et montants N et N-1. */
export interface StatementRow {
  ref: string;
  label: string;
  /** Ligne de total ou de solde intermédiaire. */
  total?: boolean;
  /** Bilan actif : brut, amortissements et dépréciations, net. */
  gross?: Fcfa;
  depreciation?: Fcfa;
  net: Fcfa;
  previous: Fcfa;
}

export interface FinancialStatements {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  assets: StatementRow[];
  liabilities: StatementRow[];
  income: StatementRow[];
  result: Fcfa;
  /** Stock au dernier jour, valorisé au CMUP, et variation passée en charge (compte 6031). */
  stock: { opening: Fcfa; closing: Fcfa; variation: Fcfa };
  /** Comptes qu'aucune ligne de l'état ne reprend (à vérifier dans le plan comptable). */
  unmapped: { account: string; balance: Fcfa }[];
}

/** Tableau des flux de trésorerie (TFT) du SYSCOHADA révisé, méthode indirecte. */
export interface CashFlowStatement {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  rows: StatementRow[];
  /**
   * Trésorerie nette au dernier jour d'après le bilan (trésorerie-actif moins trésorerie-passif)
   * et écart avec la ligne ZH : non nul seulement si des écritures sortent du schéma habituel.
   */
  check: { treasury: Fcfa; gap: Fcfa; previousTreasury: Fcfa; previousGap: Fcfa };
}

type Side = 'debit' | 'credit' | 'any';
interface Rule {
  prefixes: string[];
  except?: string[];
  /** debit : soldes débiteurs seulement (actif) ; credit : créditeurs (passif) ; any : solde signé. */
  side: Side;
}
const rule = (side: Side, prefixes: string[], except: string[] = []): Rule => ({ side, prefixes, except });

// --- Bilan (système normal SYSCOHADA révisé) -------------------------------------

const ASSETS: { ref: string; label: string; gross?: Rule; dep?: Rule; total?: string[] }[] = [
  { ref: 'AD', label: 'Immobilisations incorporelles', gross: rule('any', ['21']), dep: rule('any', ['281', '291']) },
  { ref: 'AI', label: 'Immobilisations corporelles', gross: rule('any', ['22', '23', '24', '25']), dep: rule('any', ['282', '283', '284', '292', '293', '294']) },
  { ref: 'AQ', label: 'Immobilisations financières', gross: rule('any', ['26', '27']), dep: rule('any', ['296', '297']) },
  { ref: 'AZ', label: 'TOTAL ACTIF IMMOBILISÉ', total: ['AD', 'AI', 'AQ'] },
  { ref: 'BA', label: 'Actif circulant HAO', gross: rule('debit', ['485', '488']) },
  { ref: 'BB', label: 'Stocks et encours', gross: rule('any', ['31', '32', '33', '34', '35', '36', '37', '38']), dep: rule('any', ['39']) },
  { ref: 'BH', label: 'Fournisseurs, avances versées', gross: rule('debit', ['40']) },
  { ref: 'BI', label: 'Clients', gross: rule('debit', ['41']), dep: rule('any', ['491']) },
  { ref: 'BJ', label: 'Autres créances', gross: rule('debit', ['42', '43', '44', '45', '46', '47', '185'], ['478']), dep: rule('any', ['49'], ['491', '499']) },
  { ref: 'BK', label: 'TOTAL ACTIF CIRCULANT', total: ['BA', 'BB', 'BH', 'BI', 'BJ'] },
  { ref: 'BQ', label: 'Titres de placement', gross: rule('any', ['50']), dep: rule('any', ['590']) },
  { ref: 'BR', label: 'Valeurs à encaisser', gross: rule('debit', ['51']) },
  { ref: 'BS', label: 'Banques, chèques postaux, caisse et assimilés', gross: rule('debit', ['52', '53', '54', '55', '56', '57', '58']), dep: rule('any', ['59'], ['590']) },
  { ref: 'BT', label: 'TOTAL TRÉSORERIE-ACTIF', total: ['BQ', 'BR', 'BS'] },
  { ref: 'BU', label: 'Écart de conversion-Actif', gross: rule('debit', ['478']) },
  { ref: 'BZ', label: 'TOTAL GÉNÉRAL', total: ['AZ', 'BK', 'BT', 'BU'] },
];

const LIABILITIES: { ref: string; label: string; rule?: Rule; total?: string[] }[] = [
  { ref: 'CA', label: 'Capital', rule: rule('any', ['101', '102', '103', '104']) },
  { ref: 'CB', label: 'Apporteurs capital non appelé (-)', rule: rule('any', ['109']) },
  { ref: 'CD', label: 'Primes liées au capital social', rule: rule('any', ['105']) },
  { ref: 'CE', label: 'Écarts de réévaluation', rule: rule('any', ['106']) },
  { ref: 'CF', label: 'Réserves indisponibles', rule: rule('any', ['111', '112']) },
  { ref: 'CG', label: 'Réserves libres', rule: rule('any', ['113', '118']) },
  { ref: 'CH', label: 'Report à nouveau (+ ou -)', rule: rule('any', ['12']) },
  { ref: 'CJ', label: "Résultat net de l'exercice (bénéfice + ou perte -)", rule: rule('any', ['13']) },
  { ref: 'CL', label: "Subventions d'investissement", rule: rule('any', ['14']) },
  { ref: 'CM', label: 'Provisions réglementées', rule: rule('any', ['15']) },
  { ref: 'CP', label: 'TOTAL CAPITAUX PROPRES ET RESSOURCES ASSIMILÉES', total: ['CA', 'CB', 'CD', 'CE', 'CF', 'CG', 'CH', 'CJ', 'CL', 'CM'] },
  { ref: 'DA', label: 'Emprunts et dettes financières diverses', rule: rule('any', ['16', '18']) },
  { ref: 'DB', label: 'Dettes de location-acquisition', rule: rule('any', ['17']) },
  { ref: 'DC', label: 'Provisions pour risques et charges', rule: rule('any', ['19']) },
  { ref: 'DD', label: 'TOTAL DETTES FINANCIÈRES ET RESSOURCES ASSIMILÉES', total: ['DA', 'DB', 'DC'] },
  { ref: 'DF', label: 'TOTAL RESSOURCES STABLES', total: ['CP', 'DD'] },
  { ref: 'DH', label: 'Dettes circulantes HAO', rule: rule('credit', ['481', '482', '484']) },
  { ref: 'DI', label: 'Clients, avances reçues', rule: rule('credit', ['41']) },
  { ref: 'DJ', label: "Fournisseurs d'exploitation", rule: rule('credit', ['40']) },
  { ref: 'DK', label: 'Dettes fiscales et sociales', rule: rule('credit', ['42', '43', '44']) },
  { ref: 'DM', label: 'Autres dettes', rule: rule('credit', ['45', '46', '47', '185'], ['479']) },
  { ref: 'DN', label: 'Provisions pour risques à court terme', rule: rule('any', ['499']) },
  { ref: 'DP', label: 'TOTAL PASSIF CIRCULANT', total: ['DH', 'DI', 'DJ', 'DK', 'DM', 'DN'] },
  { ref: 'DQ', label: "Banques, crédits d'escompte", rule: rule('credit', ['565']) },
  { ref: 'DR', label: 'Banques, établissements financiers et crédits de trésorerie', rule: rule('credit', ['52', '53', '54', '55', '56', '57', '58'], ['565']) },
  { ref: 'DT', label: 'TOTAL TRÉSORERIE-PASSIF', total: ['DQ', 'DR'] },
  { ref: 'DV', label: 'Écart de conversion-Passif', rule: rule('credit', ['479']) },
  { ref: 'DZ', label: 'TOTAL GÉNÉRAL', total: ['DF', 'DP', 'DT', 'DV'] },
];

// --- Compte de résultat ------------------------------------------------------------

type IncomeLine = { ref: string; label: string; kind: 'produit' | 'charge'; prefixes: string[] } | { ref: string; label: string; formula: [string, 1 | -1][] };
const p = (ref: string, label: string, prefixes: string[]): IncomeLine => ({ ref, label, kind: 'produit', prefixes });
const c = (ref: string, label: string, prefixes: string[]): IncomeLine => ({ ref, label, kind: 'charge', prefixes });
const plus = (...refs: string[]) => refs.map((r) => [r, 1] as [string, 1]);
const minus = (...refs: string[]) => refs.map((r) => [r, -1] as [string, -1]);

const INCOME: IncomeLine[] = [
  p('TA', 'Ventes de marchandises', ['701']),
  c('RA', 'Achats de marchandises', ['601']),
  c('RB', 'Variation de stocks de marchandises (- ou +)', ['6031']),
  { ref: 'XA', label: 'MARGE COMMERCIALE', formula: [...plus('TA'), ...minus('RA', 'RB')] },
  p('TB', 'Ventes de produits fabriqués', ['702', '703', '704']),
  p('TC', 'Travaux, services vendus', ['705', '706']),
  p('TD', 'Produits accessoires', ['707']),
  { ref: 'XB', label: "CHIFFRE D'AFFAIRES", formula: plus('TA', 'TB', 'TC', 'TD') },
  p('TE', 'Production stockée (ou déstockage)', ['73']),
  p('TF', 'Production immobilisée', ['72']),
  p('TG', "Subventions d'exploitation", ['71']),
  p('TH', 'Autres produits', ['75']),
  p('TI', "Transferts de charges d'exploitation", ['781']),
  c('RC', 'Achats de matières premières et fournitures liées', ['602']),
  c('RD', 'Variation de stocks de matières premières (- ou +)', ['6032']),
  c('RE', 'Autres achats', ['604', '605', '608']),
  c('RF', "Variation de stocks d'autres approvisionnements (- ou +)", ['6033']),
  c('RG', 'Transports', ['61']),
  c('RH', 'Services extérieurs', ['62', '63']),
  c('RI', 'Impôts et taxes', ['64']),
  c('RJ', 'Autres charges', ['65']),
  {
    ref: 'XC',
    label: 'VALEUR AJOUTÉE',
    formula: [...plus('XB', 'TE', 'TF', 'TG', 'TH', 'TI'), ...minus('RA', 'RB', 'RC', 'RD', 'RE', 'RF', 'RG', 'RH', 'RI', 'RJ')],
  },
  c('RK', 'Charges de personnel', ['66']),
  { ref: 'XD', label: "EXCÉDENT BRUT D'EXPLOITATION", formula: [...plus('XC'), ...minus('RK')] },
  p('TJ', "Reprises d'amortissements, de provisions et dépréciations", ['791', '798', '799']),
  c('RL', 'Dotations aux amortissements, aux provisions et dépréciations', ['681', '691']),
  { ref: 'XE', label: "RÉSULTAT D'EXPLOITATION", formula: [...plus('XD', 'TJ'), ...minus('RL')] },
  p('TK', 'Revenus financiers et assimilés', ['77']),
  p('TL', 'Reprises de provisions et dépréciations financières', ['797']),
  p('TM', 'Transferts de charges financières', ['787']),
  c('RM', 'Frais financiers et charges assimilées', ['67']),
  c('RN', 'Dotations aux provisions et dépréciations financières', ['697']),
  { ref: 'XF', label: 'RÉSULTAT FINANCIER', formula: [...plus('TK', 'TL', 'TM'), ...minus('RM', 'RN')] },
  { ref: 'XG', label: 'RÉSULTAT DES ACTIVITÉS ORDINAIRES', formula: plus('XE', 'XF') },
  p('TN', "Produits des cessions d'immobilisations", ['82']),
  p('TO', 'Autres produits HAO', ['84', '86', '88']),
  c('RO', "Valeurs comptables des cessions d'immobilisations", ['81']),
  c('RP', 'Autres charges HAO', ['83', '85']),
  { ref: 'XH', label: 'RÉSULTAT HORS ACTIVITÉS ORDINAIRES', formula: [...plus('TN', 'TO'), ...minus('RO', 'RP')] },
  c('RQ', 'Participation des travailleurs', ['87']),
  c('RS', 'Impôts sur le résultat', ['89']),
  { ref: 'XI', label: 'RÉSULTAT NET', formula: [...plus('XG', 'XH'), ...minus('RQ', 'RS')] },
];

// --- Tableau des flux de trésorerie --------------------------------------------------

const CASH_FLOW: { ref: string; label: string; total?: string[] }[] = [
  { ref: 'ZA', label: 'Trésorerie nette au 1er jour de l’exercice (trésorerie-actif moins trésorerie-passif)', total: [] },
  { ref: 'FA', label: "Capacité d'autofinancement globale (CAFG)" },
  { ref: 'FB', label: '- Variation de l’actif circulant HAO' },
  { ref: 'FC', label: '- Variation des stocks' },
  { ref: 'FD', label: '- Variation des créances' },
  { ref: 'FE', label: '+ Variation du passif circulant' },
  { ref: 'ZB', label: 'FLUX DE TRÉSORERIE PROVENANT DES ACTIVITÉS OPÉRATIONNELLES', total: ['FA', 'FB', 'FC', 'FD', 'FE'] },
  { ref: 'FF', label: "- Décaissements liés aux acquisitions d'immobilisations incorporelles" },
  { ref: 'FG', label: "- Décaissements liés aux acquisitions d'immobilisations corporelles" },
  { ref: 'FH', label: "- Décaissements liés aux acquisitions d'immobilisations financières" },
  { ref: 'FI', label: "+ Encaissements liés aux cessions d'immobilisations incorporelles et corporelles" },
  { ref: 'FJ', label: "+ Encaissements liés aux cessions d'immobilisations financières" },
  { ref: 'ZC', label: "FLUX DE TRÉSORERIE PROVENANT DES ACTIVITÉS D'INVESTISSEMENT", total: ['FF', 'FG', 'FH', 'FI', 'FJ'] },
  { ref: 'FK', label: '+ Augmentations de capital par apports nouveaux' },
  { ref: 'FL', label: "+ Subventions d'investissement reçues" },
  { ref: 'FM', label: "- Prélèvements sur le capital (compte de l'exploitant)" },
  { ref: 'FN', label: '- Dividendes versés' },
  { ref: 'ZD', label: 'FLUX DE TRÉSORERIE PROVENANT DES CAPITAUX PROPRES', total: ['FK', 'FL', 'FM', 'FN'] },
  { ref: 'FO', label: '+ Emprunts' },
  { ref: 'FP', label: '+ Autres dettes financières' },
  { ref: 'FQ', label: '- Remboursements des emprunts et autres dettes financières' },
  { ref: 'ZE', label: 'FLUX DE TRÉSORERIE PROVENANT DES CAPITAUX ÉTRANGERS', total: ['FO', 'FP', 'FQ'] },
  { ref: 'ZF', label: 'FLUX DE TRÉSORERIE PROVENANT DES ACTIVITÉS DE FINANCEMENT', total: ['ZD', 'ZE'] },
  { ref: 'ZG', label: 'VARIATION DE LA TRÉSORERIE NETTE DE LA PÉRIODE', total: ['ZB', 'ZC', 'ZF'] },
  { ref: 'ZH', label: 'Trésorerie nette au dernier jour de l’exercice', total: ['ZG', 'ZA'] },
];

/** Charges et produits sans effet sur la trésorerie, retraités pour passer du résultat net à la CAFG. */
const CAFG_ADD = ['681', '691', '697', '81', '85'];
const CAFG_LESS = ['791', '797', '798', '799', '82', '86'];

const matches = (account: string, r: Rule) => r.prefixes.some((x) => account.startsWith(x)) && !r.except?.some((x) => account.startsWith(x));

/** Soldes (débit - crédit) par compte, et par tiers pour les comptes 40 et 41. */
interface Balances {
  /** Comptes de bilan (classes 1 à 5) au dernier jour. */
  sheet: Map<string, number>;
  /** Comptes de gestion (classes 6 à 8) sur l'exercice. */
  period: Map<string, number>;
  /** Résultats des exercices précédents non encore affectés. */
  prior: number;
  stock: { opening: Fcfa; closing: Fcfa; variation: Fcfa };
}

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/**
 * États financiers SYSCOHADA (bilan et compte de résultat, système normal),
 * établis à partir des écritures. Le stock de fin d'exercice est valorisé au
 * CMUP à partir des mouvements de stock : l'écart avec le compte de stock
 * passe en variation de stock (6031), comme l'écriture d'inventaire.
 */
export class FinancialStatementsService extends Base {
  constructor(
    db: ConstructorParameters<typeof Base>[0],
    clock: ConstructorParameters<typeof Base>[1],
    private readonly accounting: AccountingService,
    private readonly stockService: StockService,
  ) {
    super(db, clock);
  }

  statements(storeId: string, opts: { from?: string; to?: string } = {}): FinancialStatements {
    const year = this.today().slice(0, 4);
    const from = opts.from ?? `${year}-01-01`;
    const to = opts.to ?? `${year}-12-31`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new AppError('Période invalide', 'INVALID');
    const previousTo = shiftDays(from, -1);
    const previousFrom = shiftYear(from, -1);
    const cur = this.balances(storeId, from, to);
    const prev = this.balances(storeId, previousFrom, previousTo);
    const curSheet = this.sheet(cur);
    const prevSheet = this.sheet(prev);
    const curIncome = this.income(cur.period);
    const prevIncome = this.income(prev.period);
    const result = curIncome.get('XI') ?? 0;

    const unmapped = new Map<string, number>();
    for (const [key, v] of cur.sheet) {
      const account = key.split('|')[0]!;
      const covered =
        ASSETS.some((a) => (a.gross && matches(account, a.gross)) || (a.dep && matches(account, a.dep))) ||
        LIABILITIES.some((l) => l.rule && matches(account, l.rule));
      if (!covered && v) add(unmapped, account, v);
    }
    for (const [account, v] of cur.period) {
      if (v && !INCOME.some((l) => 'prefixes' in l && l.prefixes.some((x) => account.startsWith(x)))) add(unmapped, account, v);
    }

    return {
      from,
      to,
      previousFrom,
      previousTo,
      assets: ASSETS.map((a) => {
        const v = curSheet.assets.get(a.ref)!;
        return { ref: a.ref, label: a.label, total: !!a.total, gross: v.gross, depreciation: v.dep, net: v.gross - v.dep, previous: prevSheet.assets.get(a.ref)!.gross - prevSheet.assets.get(a.ref)!.dep };
      }),
      liabilities: LIABILITIES.map((l) => ({ ref: l.ref, label: l.label, total: !!l.total, net: curSheet.liabilities.get(l.ref)!, previous: prevSheet.liabilities.get(l.ref)! })),
      income: INCOME.map((l) => ({ ref: l.ref, label: l.label, total: 'formula' in l, net: curIncome.get(l.ref)!, previous: prevIncome.get(l.ref)! })),
      result,
      stock: cur.stock,
      unmapped: [...unmapped].filter(([, v]) => v).map(([account, balance]) => ({ account, balance })),
    };
  }

  /** Export pour la saisie de la DSF : une ligne par poste avec sa référence. */
  exportCsv(storeId: string, opts: { from?: string; to?: string } = {}): string {
    const st = this.statements(storeId, opts);
    const rows: string[] = ['Etat;Ref;Libelle;Brut;Amortissements et depreciations;Net exercice N;Net exercice N-1'];
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    for (const a of st.assets) rows.push(['Bilan actif', a.ref, q(a.label), a.gross ?? '', a.depreciation ?? '', a.net, a.previous].join(';'));
    for (const l of st.liabilities) rows.push(['Bilan passif', l.ref, q(l.label), '', '', l.net, l.previous].join(';'));
    for (const l of st.income) rows.push(['Compte de resultat', l.ref, q(l.label), '', '', l.net, l.previous].join(';'));
    for (const l of this.cashFlow(storeId, opts).rows) rows.push(['Flux de tresorerie', l.ref, q(l.label), '', '', l.net, l.previous].join(';'));
    return `﻿${rows.join('\r\n')}\r\n`;
  }

  /**
   * Tableau des flux de trésorerie par la méthode indirecte : résultat net retraité (CAFG),
   * variations du bilan entre l'ouverture et la clôture, mouvements des immobilisations et
   * des capitaux. Les à-nouveaux (journal AN) font partie de l'ouverture, même datés dans
   * l'exercice : ce sont les soldes de reprise, pas des flux.
   */
  cashFlow(storeId: string, opts: { from?: string; to?: string } = {}): CashFlowStatement {
    const year = this.today().slice(0, 4);
    const from = opts.from ?? `${year}-01-01`;
    const to = opts.to ?? `${year}-12-31`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new AppError('Période invalide', 'INVALID');
    const previousTo = shiftDays(from, -1);
    const previousFrom = shiftYear(from, -1);
    const cur = this.flows(storeId, from, to);
    const prev = this.flows(storeId, previousFrom, previousTo);
    return {
      from,
      to,
      previousFrom,
      previousTo,
      rows: CASH_FLOW.map((l) => ({ ref: l.ref, label: l.label, total: !!l.total?.length, net: cur.rows.get(l.ref)!, previous: prev.rows.get(l.ref)! })),
      check: { treasury: cur.treasury, gap: cur.treasury - cur.rows.get('ZH')!, previousTreasury: prev.treasury, previousGap: prev.treasury - prev.rows.get('ZH')! },
    };
  }

  private flows(storeId: string, from: string, to: string) {
    const r = this.accounting.roles();
    const close = this.balances(storeId, from, to);
    // Ouverture : écritures antérieures à l'exercice et à-nouveaux de l'exercice.
    const open = new Map<string, number>();
    // Mouvements de l'exercice (hors à-nouveaux) sur les comptes de capitaux et d'immobilisations.
    const debit = new Map<string, number>();
    const credit = new Map<string, number>();
    let stockReopened = 0;
    for (const e of this.accounting.entries(storeId, { to })) {
      const opening = e.date < from || e.journal === 'AN';
      for (const l of e.lines) {
        if (l.account[0]! >= '6') continue;
        if (opening) {
          add(open, /^4[01]/.test(l.account) && l.aux ? `${l.account}|${l.aux}` : l.account, l.debit - l.credit);
          if (l.account === r.stock && e.date >= from) stockReopened += l.debit - l.credit;
        } else if (/^[12]/.test(l.account)) {
          add(debit, l.account, l.debit);
          add(credit, l.account, l.credit);
        }
      }
    }
    // Même inventaire que pour le bilan : stock au CMUP la veille de l'exercice, plus le stock repris en à-nouveaux.
    open.set(r.stock, this.stockService.valueAt(storeId, shiftDays(from, -1)) + stockReopened);
    const a = this.sheet({ sheet: open, period: new Map(), prior: 0, stock: close.stock });
    const z = this.sheet(close);
    const asset = (m: typeof a, ref: string) => m.assets.get(ref)!.gross - m.assets.get(ref)!.dep;
    const delta = (ref: string) => asset(z, ref) - asset(a, ref);
    const deltaL = (ref: string) => z.liabilities.get(ref)! - a.liabilities.get(ref)!;
    const sumOf = (m: Map<string, number>, prefixes: string[], except: string[] = []) =>
      [...m].reduce((t, [acc, v]) => (prefixes.some((x) => acc.startsWith(x)) && !except.some((x) => acc.startsWith(x)) ? t + v : t), 0);
    const signed = (m: Map<string, number>, prefixes: string[], except: string[] = []) =>
      [...m].reduce((t, [key, v]) => {
        const acc = key.split('|')[0]!;
        return prefixes.some((x) => acc.startsWith(x)) && !except.some((x) => acc.startsWith(x)) ? t + v : t;
      }, 0);
    // Variation d'un groupe de comptes de capitaux, au crédit (augmentation = ressource).
    const rise = (prefixes: string[], except: string[] = []) => -(signed(close.sheet, prefixes, except) - signed(open, prefixes, except));

    const income = this.income(close.period);
    const v = new Map<string, number>();
    v.set('ZA', asset(a, 'BT') - a.liabilities.get('DT')!);
    v.set('FA', income.get('XI')! + sumOf(close.period, CAFG_ADD) + sumOf(close.period, CAFG_LESS));
    v.set('FB', -delta('BA'));
    v.set('FC', -delta('BB'));
    v.set('FD', -(delta('BH') + delta('BI') + delta('BJ') + delta('BU')));
    v.set('FE', deltaL('DP') + deltaL('DV'));
    v.set('FF', -sumOf(debit, ['21']));
    v.set('FG', -sumOf(debit, ['22', '23', '24', '25']));
    v.set('FH', -sumOf(debit, ['26', '27']));
    v.set('FI', -sumOf(close.period, ['821', '822']));
    v.set('FJ', -sumOf(close.period, ['826']));
    v.set('FK', rise(['10'], ['104', '106']));
    v.set('FL', rise(['14']));
    v.set('FM', rise(['104']));
    v.set('FN', rise(['11', '12', '13']));
    v.set('FO', sumOf(credit, ['161', '162']));
    v.set('FP', sumOf(credit, ['16', '17', '18'], ['161', '162']));
    v.set('FQ', -sumOf(debit, ['16', '17', '18']));
    for (const [ref, x] of v) v.set(ref, x + 0); // pas de « -0 »
    for (const l of CASH_FLOW) if (l.total?.length) v.set(l.ref, l.total.reduce((t, ref) => t + v.get(ref)!, 0));
    return { rows: v, treasury: asset(z, 'BT') - z.liabilities.get('DT')! };
  }

  private balances(storeId: string, from: string, to: string): Balances {
    const r = this.accounting.roles();
    const sheet = new Map<string, number>();
    const period = new Map<string, number>();
    let prior = 0;
    let stockBefore = 0;
    for (const e of this.accounting.entries(storeId, { to })) {
      for (const l of e.lines) {
        const v = l.debit - l.credit;
        const cls = l.account[0]!;
        if (cls >= '6') {
          if (e.date < from) prior += v;
          else add(period, l.account, v);
        } else {
          add(sheet, /^4[01]/.test(l.account) && l.aux ? `${l.account}|${l.aux}` : l.account, v);
          if (l.account === r.stock && e.date < from) stockBefore += v;
        }
      }
    }
    // Inventaire : le compte de stock prend la valeur des mouvements au CMUP,
    // au début de l'exercice (écart dans les résultats antérieurs) puis à la fin (variation 6031).
    const opening = this.stockService.valueAt(storeId, shiftDays(from, -1));
    const closing = this.stockService.valueAt(storeId, to);
    const openingGap = opening - stockBefore;
    prior -= openingGap;
    const booked = (sheet.get(r.stock) ?? 0) + openingGap;
    const variation = booked - closing;
    sheet.set(r.stock, closing);
    add(period, r.stock_variation, variation);
    return { sheet, period, prior, stock: { opening, closing, variation } };
  }

  private sheet(b: Balances) {
    const assets = new Map<string, { gross: number; dep: number }>();
    const liabilities = new Map<string, number>();
    const sum = (rl: Rule | undefined, sign: 1 | -1) => {
      if (!rl) return 0;
      let t = 0;
      for (const [key, v] of b.sheet) {
        if (!matches(key.split('|')[0]!, rl)) continue;
        if (rl.side === 'debit') t += Math.max(v, 0);
        else if (rl.side === 'credit') t += Math.max(-v, 0);
        else t += sign * v;
      }
      return t;
    };
    // Résultat de l'exercice (classes 6 à 8) et résultats antérieurs non affectés.
    const result = -[...b.period.values()].reduce((t, v) => t + v, 0);
    for (const a of ASSETS) {
      if (a.total) {
        const g = a.total.reduce((t, ref) => t + assets.get(ref)!.gross, 0);
        const d = a.total.reduce((t, ref) => t + assets.get(ref)!.dep, 0);
        assets.set(a.ref, { gross: g, dep: d });
      } else assets.set(a.ref, { gross: sum(a.gross, 1), dep: sum(a.dep, -1) });
    }
    for (const l of LIABILITIES) {
      if (l.total) liabilities.set(l.ref, l.total.reduce((t, ref) => t + liabilities.get(ref)!, 0));
      else {
        let v = sum(l.rule, -1);
        if (l.ref === 'CH') v -= b.prior;
        if (l.ref === 'CJ') v += result;
        liabilities.set(l.ref, v);
      }
    }
    return { assets, liabilities };
  }

  private income(period: Map<string, number>) {
    const out = new Map<string, number>();
    for (const l of INCOME) {
      if ('formula' in l) out.set(l.ref, l.formula.reduce((t, [ref, sign]) => t + sign * out.get(ref)!, 0));
      else {
        let t = 0;
        for (const [account, v] of period) if (l.prefixes.some((x) => account.startsWith(x))) t += v;
        out.set(l.ref, l.kind === 'produit' ? -t : t);
      }
    }
    return out;
  }
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shiftYear(date: string, years: number): string {
  return `${Number(date.slice(0, 4)) + years}${date.slice(4)}`;
}
