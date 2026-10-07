import { type Fcfa, formatFcfa } from '@superette/core';
import type { Note } from './notes';
import { AppError, Base, type Context } from './util';

/**
 * Notes déclaratives de la DSF : ce que les écritures ne disent pas et que l'entreprise
 * déclare elle-même (sûretés et engagements hors bilan, méthodes comptables, associés,
 * effectifs, informations sociales et environnementales). Saisies une fois par exercice et
 * par magasin, puis jointes aux notes calculées.
 */

export const SECURITY_KINDS = {
  mortgage: 'Hypothèque',
  pledge: 'Nantissement',
  lien: 'Gage',
  other: 'Autre sûreté',
} as const;
export type SecurityKind = keyof typeof SECURITY_KINDS;

export const COMMITMENT_KINDS = {
  guarantees: 'Avals, cautions et garanties',
  securities: 'Hypothèques, nantissements et gages',
  discounted_bills: 'Effets escomptés non échus',
  leasing: 'Crédit-bail et location : redevances restant dues',
  debt_waivers: 'Abandons de créances conditionnels',
  other: 'Autres engagements',
} as const;
export type CommitmentKind = keyof typeof COMMITMENT_KINDS;

export const STAFF_CATEGORIES = {
  managers: 'Cadres',
  supervisors: 'Agents de maîtrise et techniciens',
  employees: 'Employés et ouvriers',
  temporary: 'Saisonniers et temporaires',
} as const;
export type StaffCategory = keyof typeof STAFF_CATEGORIES;

/** Effectif d'une catégorie : [hommes, femmes] par origine, et masse salariale de l'exercice. */
export interface StaffLine {
  national: [number, number];
  cemac: [number, number];
  other: [number, number];
  payroll: Fcfa;
}

export interface Disclosures {
  year: number;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Note 1 : dettes garanties par des sûretés réelles. */
  securedDebts: { label: string; creditor: string; security: SecurityKind; amount: Fcfa }[];
  /** Note 1 : engagements financiers donnés et reçus. */
  commitments: { direction: 'given' | 'received'; kind: CommitmentKind; party: string; amount: Fcfa }[];
  /** Note 2 : informations obligatoires sur les règles comptables. */
  accounting: { compliance: string; methods: string; derogations: string; changes: string };
  /** Répartition du capital entre associés (sociétés). */
  shareholders: { name: string; nationality: string; shares: number; nominal: Fcfa }[];
  /** Note 27B : effectifs et masse salariale. */
  staff: Record<StaffCategory, StaffLine>;
  external: { count: number; cost: Fcfa };
  /** Note 35 : informations sociales, environnementales et sociétales. */
  social: string;
}

export type DisclosuresInput = Partial<Omit<Disclosures, 'year' | 'updatedAt' | 'updatedBy'>>;

/** Textes proposés par défaut : ils décrivent ce que fait réellement l'application. */
export const DEFAULT_ACCOUNTING_TEXTS: Disclosures['accounting'] = {
  compliance:
    "Les états financiers sont établis conformément à l'Acte uniforme OHADA relatif au droit comptable et à l'information financière (SYSCOHADA révisé), système normal.",
  methods: [
    'Stocks de marchandises évalués au coût moyen unitaire pondéré (CMUP), sorties en premier périmé, premier sorti (FEFO).',
    "Ventes comptabilisées hors taxes à la date du ticket ou de la facture ; TVA collectée et déductible suivie par taux.",
    'Immobilisations inscrites au coût d’acquisition hors taxes récupérables, amorties selon le mode linéaire sur leur durée probable d’utilisation.',
    'Créances et dettes libellées en francs CFA.',
  ].join('\n'),
  derogations: 'Néant.',
  changes: 'Néant.',
};

const emptyStaff = (): StaffLine => ({ national: [0, 0], cemac: [0, 0], other: [0, 0], payroll: 0 });

function empty(year: number): Disclosures {
  return {
    year,
    updatedAt: null,
    updatedBy: null,
    securedDebts: [],
    commitments: [],
    accounting: { ...DEFAULT_ACCOUNTING_TEXTS },
    shareholders: [],
    staff: Object.fromEntries(Object.keys(STAFF_CATEGORIES).map((k) => [k, emptyStaff()])) as Record<StaffCategory, StaffLine>,
    external: { count: 0, cost: 0 },
    social: '',
  };
}

const text = (v: unknown, label: string, max = 4000): string => {
  if (typeof v !== 'string') throw new AppError(`${label} : texte attendu`, 'INVALID');
  const t = v.trim();
  if (t.length > max) throw new AppError(`${label} : ${max} caractères au plus`, 'INVALID');
  return t;
};
const amount = (v: unknown, label: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new AppError(`${label} : montant invalide`, 'INVALID');
  return v;
};
const count = (v: unknown, label: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100_000) throw new AppError(`${label} : nombre invalide`, 'INVALID');
  return v;
};
const pair = (v: unknown, label: string): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2) throw new AppError(`${label} : hommes et femmes attendus`, 'INVALID');
  return [count(v[0], label), count(v[1], label)];
};

export class DisclosureService extends Base {
  get(storeId: string, year: number): Disclosures {
    checkYear(year);
    const row = this.db
      .prepare('SELECT d.data, d.updated_at, u.name AS user_name FROM dsf_disclosures d LEFT JOIN users u ON u.id = d.user_id WHERE d.store_id = ? AND d.year = ?')
      .get(storeId, year) as { data: string; updated_at: string; user_name: string | null } | undefined;
    const base = empty(year);
    if (!row) return base;
    const data = JSON.parse(row.data) as DisclosuresInput;
    return {
      ...base,
      ...data,
      accounting: { ...base.accounting, ...data.accounting },
      staff: { ...base.staff, ...data.staff },
      year,
      updatedAt: row.updated_at,
      updatedBy: row.user_name,
    };
  }

  save(ctx: Context, year: number, input: DisclosuresInput): Disclosures {
    checkYear(year);
    const cur = this.get(ctx.storeId, year);
    const next = { ...cur, ...input };
    const data: DisclosuresInput = {
      securedDebts: next.securedDebts.map((d, i) => {
        const label = text(d.label, `Dette garantie ${i + 1}`, 200);
        if (!label) throw new AppError(`Dette garantie ${i + 1} : indiquez la dette`, 'INVALID');
        if (!(d.security in SECURITY_KINDS)) throw new AppError(`Dette garantie ${i + 1} : sûreté inconnue`, 'INVALID');
        return { label, creditor: text(d.creditor, `Dette garantie ${i + 1}`, 200), security: d.security, amount: amount(d.amount, `Dette garantie ${i + 1}`) };
      }),
      commitments: next.commitments.map((c, i) => {
        if (c.direction !== 'given' && c.direction !== 'received') throw new AppError(`Engagement ${i + 1} : donné ou reçu ?`, 'INVALID');
        if (!(c.kind in COMMITMENT_KINDS)) throw new AppError(`Engagement ${i + 1} : nature inconnue`, 'INVALID');
        return { direction: c.direction, kind: c.kind, party: text(c.party, `Engagement ${i + 1}`, 200), amount: amount(c.amount, `Engagement ${i + 1}`) };
      }),
      accounting: {
        compliance: text(next.accounting.compliance, 'Déclaration de conformité'),
        methods: text(next.accounting.methods, 'Règles et méthodes comptables'),
        derogations: text(next.accounting.derogations, 'Dérogations'),
        changes: text(next.accounting.changes, 'Changements de méthode'),
      },
      shareholders: next.shareholders.map((s, i) => {
        const name = text(s.name, `Associé ${i + 1}`, 200);
        if (!name) throw new AppError(`Associé ${i + 1} : indiquez le nom`, 'INVALID');
        return { name, nationality: text(s.nationality, `Associé ${i + 1}`, 100), shares: count(s.shares, `Associé ${i + 1} (parts)`), nominal: amount(s.nominal, `Associé ${i + 1}`) };
      }),
      staff: Object.fromEntries(
        (Object.keys(STAFF_CATEGORIES) as StaffCategory[]).map((k) => {
          const l = next.staff[k] ?? emptyStaff();
          const label = STAFF_CATEGORIES[k];
          return [k, { national: pair(l.national, label), cemac: pair(l.cemac, label), other: pair(l.other, label), payroll: amount(l.payroll, `${label} (masse salariale)`) }];
        }),
      ) as Record<StaffCategory, StaffLine>,
      external: { count: count(next.external.count, 'Personnel extérieur'), cost: amount(next.external.cost, 'Personnel extérieur') },
      social: text(next.social, 'Informations sociales et environnementales', 8000),
    };
    const id = `${ctx.storeId}:${year}`;
    this.db
      .prepare(
        `INSERT INTO dsf_disclosures (id, store_id, year, data, user_id, updated_at) VALUES (@id, @store, @year, @data, @user, @now)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, user_id = excluded.user_id, updated_at = excluded.updated_at`,
      )
      .run({ id, store: ctx.storeId, year, data: JSON.stringify(data), user: ctx.userId, now: this.now() });
    this.enqueue(ctx, 'dsf_disclosure', id, 'upsert', {});
    this.audit(ctx.userId, 'dsf.disclosures', 'dsf_disclosure', id);
    return this.get(ctx.storeId, year);
  }

  /**
   * Notes déclaratives prêtes à joindre aux notes calculées. `capital` est le capital au bilan
   * (comptes 101 à 104) et `wages` les rémunérations comptabilisées (661 à 663), pour contrôle.
   */
  notes(storeId: string, year: number, check: { capital: Fcfa; wages: Fcfa }): Note[] {
    const d = this.get(storeId, year);
    const notes: Note[] = [];

    const n1: Note['rows'] = [
      ...d.securedDebts.map((x) => ({ label: `${x.label}${x.creditor ? ` · ${x.creditor}` : ''} (${SECURITY_KINDS[x.security].toLowerCase()})`, values: [x.amount, 0, 0] })),
      ...d.commitments.map((c) => ({
        label: `${COMMITMENT_KINDS[c.kind]}${c.party ? ` · ${c.party}` : ''}`,
        values: c.direction === 'given' ? [0, c.amount, 0] : [0, 0, c.amount],
      })),
    ];
    notes.push({
      id: '1',
      title: 'Dettes garanties par des sûretés réelles et engagements financiers',
      columns: ['Dettes garanties', 'Engagements donnés', 'Engagements reçus'],
      rows: total(n1),
      declared: true,
    });

    const a = d.accounting;
    notes.push({
      id: '2',
      title: 'Informations obligatoires',
      columns: [],
      rows: [],
      paragraphs: [
        { heading: 'Déclaration de conformité au SYSCOHADA', text: a.compliance || 'Néant.' },
        { heading: 'Règles et méthodes comptables', text: a.methods || 'Néant.' },
        { heading: 'Dérogations aux règles comptables', text: a.derogations || 'Néant.' },
        { heading: 'Changements de méthode et corrections d’erreurs', text: a.changes || 'Néant.' },
      ],
      declared: true,
    });

    const declaredCapital = d.shareholders.reduce((t, s) => t + s.shares * s.nominal, 0);
    notes.push({
      id: '13B',
      title: 'Répartition du capital entre associés',
      columns: ['Nombre de parts', 'Valeur nominale', 'Montant'],
      units: ['number', 'fcfa', 'fcfa'],
      rows: d.shareholders.length
        ? [
            ...d.shareholders.map((s) => ({ label: `${s.name}${s.nationality ? ` (${s.nationality})` : ''}`, values: [s.shares, s.nominal, s.shares * s.nominal] })),
            { label: 'Total', values: [d.shareholders.reduce((t, s) => t + s.shares, 0), 0, declaredCapital], total: true },
          ]
        : [],
      comment: d.shareholders.length
        ? declaredCapital === check.capital
          ? 'Le total correspond au capital inscrit au bilan.'
          : `Écart avec le capital inscrit au bilan (comptes 101 à 104 : ${formatFcfa(check.capital)}).`
        : 'Entreprise individuelle ou associés non renseignés.',
      declared: true,
    });

    const sum = (p: [number, number]) => p[0] + p[1];
    const staffRows: Note['rows'] = (Object.keys(STAFF_CATEGORIES) as StaffCategory[])
      .map((k) => {
        const l = d.staff[k];
        const v = [...l.national, ...l.cemac, ...l.other];
        return { label: STAFF_CATEGORIES[k], values: [...v, sum(l.national) + sum(l.cemac) + sum(l.other), l.payroll] };
      })
      .filter((r) => r.values.some((v) => v));
    if (d.external.count || d.external.cost) staffRows.push({ label: 'Personnel extérieur (intérim, mis à disposition)', values: [0, 0, 0, 0, 0, 0, d.external.count, d.external.cost] });
    const payroll = (Object.values(d.staff) as StaffLine[]).reduce((t, l) => t + l.payroll, 0);
    notes.push({
      id: '27B',
      title: 'Effectifs et masse salariale',
      columns: ['Nationaux H', 'Nationaux F', 'CEMAC H', 'CEMAC F', 'Hors CEMAC H', 'Hors CEMAC F', 'Total', 'Masse salariale'],
      units: ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'fcfa'],
      rows: total(staffRows),
      comment:
        payroll || check.wages
          ? `Rémunérations comptabilisées (comptes 661 à 663) : ${formatFcfa(check.wages)}${payroll === check.wages ? ', égales à la masse salariale déclarée.' : '.'}`
          : undefined,
      declared: true,
    });

    notes.push({
      id: '35',
      title: 'Informations sociales, environnementales et sociétales',
      columns: [],
      rows: [],
      paragraphs: d.social ? [{ heading: '', text: d.social }] : [],
      declared: true,
    });
    return notes;
  }
}

function checkYear(year: number): void {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AppError('Exercice invalide', 'INVALID');
}

function total(rows: Note['rows']): Note['rows'] {
  if (!rows.length) return [];
  const width = rows[0]!.values.length;
  return [...rows, { label: 'Total', values: Array.from({ length: width }, (_, i) => rows.reduce((t, r) => t + (r.values[i] ?? 0), 0)), total: true }];
}
