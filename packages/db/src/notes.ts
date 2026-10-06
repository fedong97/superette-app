import type { Fcfa } from '@superette/core';
import type { AccountingService } from './accounting';
import type { FinancialStatementsService } from './statements';
import type { TaxService } from './tax';
import { AppError, Base } from './util';

/** Une note annexe : tableau de montants, avec ses colonnes et une remarque éventuelle. */
export interface Note {
  id: string;
  title: string;
  columns: string[];
  rows: { label: string; values: Fcfa[]; total?: boolean }[];
  comment?: string;
}

export interface FinancialNotes {
  from: string;
  to: string;
  notes: Note[];
}

/** Soldes et mouvements d'un compte (ou d'un tiers) sur l'exercice. Les à-nouveaux comptent dans l'ouverture. */
interface Movement {
  account: string;
  aux: string | null;
  auxName: string | null;
  opening: number;
  debit: number;
  credit: number;
}

const starts = (account: string, prefixes: string[], except: string[] = []) =>
  prefixes.some((p) => account.startsWith(p)) && !except.some((p) => account.startsWith(p));

/**
 * Notes annexes du SYSCOHADA révisé (système normal) que l'application sait établir à partir
 * des écritures : tableaux de mouvements (immobilisations, amortissements, dettes financières),
 * détail des postes du bilan et du compte de résultat, fiche de synthèse et passage au résultat
 * fiscal. Les notes purement déclaratives (engagements, effectifs, informations sociales) restent
 * à rédiger par le comptable.
 */
export class NotesService extends Base {
  constructor(
    db: ConstructorParameters<typeof Base>[0],
    clock: ConstructorParameters<typeof Base>[1],
    private readonly accounting: AccountingService,
    private readonly statements: FinancialStatementsService,
    private readonly tax: TaxService,
  ) {
    super(db, clock);
  }

  notes(storeId: string, year: number): FinancialNotes {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AppError('Exercice invalide', 'INVALID');
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const labels = new Map(this.accounting.listAccounts(true).map((a) => [a.id, a.label]));
    const name = (m: { account: string; aux?: string | null; auxName?: string | null }) =>
      m.aux ? `${m.account} ${m.auxName ?? m.aux}` : `${m.account} ${labels.get(m.account) ?? ''}`.trim();
    const cur = this.snapshot(storeId, from, to);
    const prev = this.snapshot(storeId, `${year - 1}-01-01`, `${year - 1}-12-31`);
    const st = this.statements.statements(storeId, { from, to });
    const flows = this.statements.cashFlow(storeId, { from, to });
    const stockAccount = this.accounting.roles().stock;
    const notes: Note[] = [];

    // --- Tableaux de mouvements -------------------------------------------------------
    const movementNote = (id: string, title: string, prefixes: string[], creditSide: boolean, comment?: string) => {
      const rows = [...cur.sheet.values()]
        .filter((m) => starts(m.account, prefixes) && (m.opening || m.debit || m.credit))
        .sort((a, b) => a.account.localeCompare(b.account))
        .map((m) => {
          const sign = creditSide ? -1 : 1;
          const opening = sign * m.opening;
          const up = creditSide ? m.credit : m.debit;
          const down = creditSide ? m.debit : m.credit;
          return { label: name(m), values: [opening, up, down, opening + up - down] };
        });
      notes.push({ id, title, columns: ["Début d'exercice", 'Augmentations', 'Diminutions', "Fin d'exercice"], rows: withTotal(rows), comment });
    };
    movementNote('3A', 'Immobilisations brutes', ['21', '22', '23', '24', '25', '26', '27'], false, 'Augmentations : acquisitions de l’exercice ; diminutions : cessions et mises au rebut (valeur brute).');
    movementNote('3C', 'Amortissements et dépréciations des immobilisations', ['28', '29'], true, 'Augmentations : dotations de l’exercice ; diminutions : amortissements des biens cédés et reprises.');

    // --- Stocks ------------------------------------------------------------------------
    const stockOpening = st.stock.opening + cur.reopenedStock;
    notes.push({
      id: '6',
      title: 'Stocks et en-cours',
      columns: ['Exercice N', 'Exercice N-1', 'Variation'],
      rows: [{ label: `${stockAccount} ${labels.get(stockAccount) ?? 'Marchandises'}`, values: [st.stock.closing, stockOpening, st.stock.closing - stockOpening] }],
      comment: 'Valeur au coût moyen unitaire pondéré (CMUP) d’après les mouvements de stock de l’application. Aucune dépréciation n’est calculée.',
    });

    // --- Postes du bilan ---------------------------------------------------------------
    // Soldes de fin (N) et d'ouverture (N-1) ; « debit » ne retient que les soldes débiteurs, « credit » les créditeurs.
    const balanceNote = (id: string, title: string, prefixes: string[], side: 'debit' | 'credit', opts: { except?: string[]; comment?: string; signed?: boolean } = {}) => {
      const sign = side === 'debit' ? 1 : -1;
      const rows = [...cur.sheet.values()]
        .filter((m) => starts(m.account, prefixes, opts.except))
        .map((m) => {
          const close = sign * (m.opening + m.debit - m.credit);
          const open = sign * m.opening;
          return { label: name(m), values: opts.signed ? [close, open] : [Math.max(close, 0), Math.max(open, 0)] };
        })
        .filter((r) => r.values[0] || r.values[1])
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((r) => ({ label: r.label, values: [r.values[0]!, r.values[1]!, r.values[0]! - r.values[1]!] }));
      notes.push({ id, title, columns: ['Exercice N', 'Exercice N-1', 'Variation'], rows: withTotal(rows), comment: opts.comment });
    };
    balanceNote('7', 'Clients', ['41'], 'debit', { comment: 'Soldes débiteurs par client. Les avances reçues des clients figurent en note 19.' });
    balanceNote('8', 'Autres créances', ['42', '43', '44', '45', '46', '47', '185'], 'debit', { except: ['478'] });
    balanceNote('11', 'Disponibilités', ['52', '53', '54', '55', '56', '57', '58'], 'debit');
    balanceNote('13', 'Capital', ['101', '102', '103', '104', '109'], 'credit', { signed: true, comment: 'Pour l’entrepreneur individuel, le compte de l’exploitant (104) diminue des prélèvements.' });
    movementNote('16A', 'Dettes financières et ressources assimilées', ['16', '17', '18'], true, 'Augmentations : emprunts reçus ; diminutions : remboursements.');
    balanceNote('17', "Fournisseurs d'exploitation", ['40'], 'credit', { comment: 'Soldes créditeurs par fournisseur. Les avances versées aux fournisseurs figurent en note 8.' });
    balanceNote('18', 'Dettes fiscales et sociales', ['42', '43', '44'], 'credit');
    balanceNote('19', 'Autres dettes et provisions pour risques à court terme', ['41', '45', '46', '47', '499'], 'credit', { except: ['479'] });
    balanceNote('20', 'Banques, crédits d’escompte et de trésorerie', ['52', '53', '54', '55', '56', '57', '58'], 'credit', { comment: 'Comptes de trésorerie à solde créditeur (découverts).' });

    // --- Compte de résultat ------------------------------------------------------------
    const periodNote = (id: string, title: string, prefixes: string[], kind: 'produit' | 'charge', comment?: string) => {
      const sign = kind === 'produit' ? -1 : 1;
      const accounts = new Set([...cur.period.keys(), ...prev.period.keys()].filter((a) => starts(a, prefixes)));
      const rows = [...accounts]
        .sort()
        .map((a) => {
          const n = sign * (cur.period.get(a) ?? 0);
          const p = sign * (prev.period.get(a) ?? 0);
          return { label: name({ account: a }), values: [n, p, n - p] };
        })
        .filter((r) => r.values[0] || r.values[1]);
      notes.push({ id, title, columns: ['Exercice N', 'Exercice N-1', 'Variation'], rows: withTotal(rows), comment });
    };
    periodNote('21', "Chiffre d'affaires et autres produits", ['70', '71', '72', '73', '75'], 'produit', 'Ventes hors taxes (montants des tickets et factures diminués de la TVA).');
    periodNote('22', 'Achats', ['60'], 'charge', 'La variation de stock (6031) vient de l’inventaire au CMUP.');
    periodNote('23', 'Transports', ['61'], 'charge');
    periodNote('24', 'Services extérieurs', ['62', '63'], 'charge');
    periodNote('25', 'Impôts et taxes', ['64'], 'charge');
    periodNote('26', 'Autres charges', ['65'], 'charge');
    periodNote('27A', 'Charges de personnel', ['66'], 'charge');
    periodNote('28', 'Dotations et reprises', ['68', '69', '78', '79'], 'charge', 'Montants positifs : dotations ; négatifs : reprises et transferts de charges.');
    periodNote('29', 'Charges et revenus financiers', ['67', '77'], 'charge', 'Montants positifs : charges ; négatifs : revenus.');
    periodNote('30', 'Autres charges et produits HAO', ['81', '82', '83', '84', '85', '86', '88'], 'charge', 'Montants positifs : charges ; négatifs : produits.');

    // --- Fiche de synthèse ---------------------------------------------------------------
    const inc = (ref: string) => st.income.find((l) => l.ref === ref)!;
    const pas = (ref: string) => st.liabilities.find((l) => l.ref === ref)!;
    const act = (ref: string) => st.assets.find((l) => l.ref === ref)!;
    const cfa = flows.rows.find((r) => r.ref === 'FA')!;
    const line = (label: string, n: number, p: number) => ({ label, values: [n, p, n - p] });
    const bfr = (k: 'net' | 'previous') => act('BK')[k] - pas('DP')[k];
    notes.push({
      id: '34',
      title: 'Fiche de synthèse des principaux indicateurs financiers',
      columns: ['Exercice N', 'Exercice N-1', 'Variation'],
      rows: [
        line("Chiffre d'affaires", inc('XB').net, inc('XB').previous),
        line('Marge commerciale', inc('XA').net, inc('XA').previous),
        line('Valeur ajoutée', inc('XC').net, inc('XC').previous),
        line("Excédent brut d'exploitation", inc('XD').net, inc('XD').previous),
        line("Résultat d'exploitation", inc('XE').net, inc('XE').previous),
        line('Résultat net', inc('XI').net, inc('XI').previous),
        line("Capacité d'autofinancement globale", cfa.net, cfa.previous),
        line('Capitaux propres', pas('CP').net, pas('CP').previous),
        line('Dettes financières', pas('DD').net, pas('DD').previous),
        line('Besoin en fonds de roulement (actif circulant - passif circulant)', bfr('net'), bfr('previous')),
        line('Trésorerie nette', act('BT').net - pas('DT').net, act('BT').previous - pas('DT').previous),
      ],
    });

    // --- Passage au résultat fiscal ------------------------------------------------------
    const t = this.tax.assessment(storeId, year);
    notes.push({
      id: 'RF',
      title: 'Tableau de passage du résultat comptable au résultat fiscal',
      columns: ['Montant'],
      rows: [
        { label: 'Résultat net comptable avant impôt sur le résultat', values: [t.resultBeforeTax] },
        ...t.settings.adjustments.map((a) => ({ label: `${a.kind === 'add' ? 'Réintégration' : 'Déduction'} : ${a.label}`, values: [a.kind === 'add' ? a.amount : -a.amount] })),
        { label: 'Résultat fiscal', values: [t.fiscalResult], total: true },
        { label: 'Déficits antérieurs imputés', values: [-t.lossesUsed] },
        { label: 'Bénéfice imposable', values: [t.taxableIncome], total: true },
        { label: 'Impôt calculé (CAC compris)', values: [t.tax.total] },
        { label: 'Minimum de perception (acomptes)', values: [t.minimum] },
        { label: 'Impôt dû', values: [t.due], total: true },
      ],
      comment: t.provisional ? 'Exercice en cours : calcul provisoire.' : undefined,
    });

    for (const n of notes) for (const r of n.rows) r.values = r.values.map((v) => v + 0); // pas de « -0 »
    return { from, to, notes };
  }

  /** Export pour la DSF : une ligne par ligne de note. */
  exportCsv(storeId: string, year: number): string {
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = ['Note;Titre;Libelle;Valeur 1;Valeur 2;Valeur 3;Valeur 4'];
    for (const n of this.notes(storeId, year).notes) for (const r of n.rows) rows.push([n.id, q(n.title), q(r.label), ...r.values].join(';'));
    return `﻿${rows.join('\r\n')}\r\n`;
  }

  private snapshot(storeId: string, from: string, to: string) {
    const stock = this.accounting.roles().stock;
    const sheet = new Map<string, Movement>();
    const period = new Map<string, number>();
    let reopenedStock = 0;
    for (const e of this.accounting.entries(storeId, { to })) {
      const opening = e.date < from || e.journal === 'AN';
      for (const l of e.lines) {
        if (l.account[0]! >= '6') {
          if (e.date >= from) period.set(l.account, (period.get(l.account) ?? 0) + l.debit - l.credit);
          continue;
        }
        const aux = /^4[01]/.test(l.account) ? l.aux : null;
        const key = `${l.account}|${aux ?? ''}`;
        const m = sheet.get(key) ?? { account: l.account, aux, auxName: aux ? l.aux_name : null, opening: 0, debit: 0, credit: 0 };
        if (opening) m.opening += l.debit - l.credit;
        else {
          m.debit += l.debit;
          m.credit += l.credit;
        }
        if (aux && l.aux_name) m.auxName = l.aux_name;
        sheet.set(key, m);
        if (l.account === stock && e.journal === 'AN' && e.date >= from) reopenedStock += l.debit - l.credit;
      }
    }
    return { sheet, period, reopenedStock };
  }
}

function withTotal(rows: { label: string; values: number[] }[]): Note['rows'] {
  if (!rows.length) return [];
  const width = rows[0]!.values.length;
  const total = Array.from({ length: width }, (_, i) => rows.reduce((t, r) => t + (r.values[i] ?? 0), 0));
  return [...rows, { label: 'Total', values: total, total: true }];
}
