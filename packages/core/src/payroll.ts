import type { Fcfa } from './money';

/**
 * Retenues légales sur salaire au Cameroun : CNPS (pension, prestations
 * familiales, accidents du travail), IRPP et centimes additionnels communaux
 * (CAC), crédit foncier (CFC), redevance audiovisuelle (RAV), taxe de
 * développement local (TDL) et FNE. Les taux sont en centièmes de pour cent
 * (420 = 4,20 %) ; tout se modifie dans Administration › Paramètres, la loi de
 * finances changeant parfois les barèmes.
 */
export interface PayrollBracket {
  /** Borne haute de la tranche (FCFA) ; null : au-delà. */
  upTo: number | null;
  /** Taux en centièmes de % (barème IRPP) ou montant fixe en FCFA (RAV, TDL). */
  value: number;
}

export interface PayrollRules {
  /** Calculer les retenues légales sur les salaires constatés. */
  enabled: boolean;
  /** Plafond mensuel de l'assiette CNPS (pension et prestations familiales). */
  cnpsCeiling: number;
  /** Pension vieillesse, part salariale. */
  cnpsEmployee: number;
  /** Pension vieillesse et prestations familiales, part patronale. */
  cnpsEmployer: number;
  /** Accidents du travail, part patronale, sur tout le brut (groupe A : 1,75 %). */
  accident: number;
  /** Abattement pour frais professionnels sur le brut, avant IRPP. */
  professional: number;
  /** Abattement annuel avant IRPP. */
  annualAbatement: number;
  /** Pas d'IRPP sous ce salaire brut mensuel. */
  irppThreshold: number;
  /** Barème annuel de l'IRPP : tranches et taux. */
  irpp: PayrollBracket[];
  /** Centimes additionnels communaux, en % de l'IRPP. */
  cac: number;
  /** Crédit foncier, part salariale et part patronale. */
  cfcEmployee: number;
  cfcEmployer: number;
  /** Fonds national de l'emploi, part patronale. */
  fne: number;
  /** Redevance audiovisuelle : montant mensuel par tranche de brut. */
  rav: PayrollBracket[];
  /** Taxe de développement local : montant mensuel par tranche de brut. */
  tdl: PayrollBracket[];
}

export const DEFAULT_PAYROLL: PayrollRules = {
  enabled: false,
  cnpsCeiling: 750_000,
  cnpsEmployee: 420,
  cnpsEmployer: 1120,
  accident: 175,
  professional: 3000,
  annualAbatement: 500_000,
  irppThreshold: 62_000,
  irpp: [
    { upTo: 2_000_000, value: 1000 },
    { upTo: 3_000_000, value: 1500 },
    { upTo: 5_000_000, value: 2500 },
    { upTo: null, value: 3500 },
  ],
  cac: 1000,
  cfcEmployee: 100,
  cfcEmployer: 150,
  fne: 100,
  rav: [
    { upTo: 50_000, value: 0 },
    { upTo: 100_000, value: 750 },
    { upTo: 200_000, value: 1950 },
    { upTo: 300_000, value: 3250 },
    { upTo: 400_000, value: 4550 },
    { upTo: 500_000, value: 5850 },
    { upTo: 600_000, value: 7150 },
    { upTo: 700_000, value: 8450 },
    { upTo: 800_000, value: 9750 },
    { upTo: 900_000, value: 11_050 },
    { upTo: 1_000_000, value: 12_350 },
    { upTo: null, value: 13_000 },
  ],
  tdl: [
    { upTo: 62_000, value: 0 },
    { upTo: 75_000, value: 250 },
    { upTo: 100_000, value: 500 },
    { upTo: 125_000, value: 750 },
    { upTo: 150_000, value: 1000 },
    { upTo: 200_000, value: 1250 },
    { upTo: 250_000, value: 1500 },
    { upTo: 300_000, value: 2000 },
    { upTo: 500_000, value: 2250 },
    { upTo: null, value: 2500 },
  ],
};

/** Détail d'un salaire : retenues du collaborateur et charges de l'employeur. */
export interface PayrollLines {
  gross: Fcfa;
  /** Retenues salariales. */
  cnps: Fcfa;
  irpp: Fcfa;
  cac: Fcfa;
  cfc: Fcfa;
  rav: Fcfa;
  tdl: Fcfa;
  /** Charges patronales. */
  employerCnps: Fcfa;
  employerCfc: Fcfa;
  employerFne: Fcfa;
}

export interface Payroll extends PayrollLines {
  /** CNPS salariale (au crédit de la CNPS, 4311). */
  employeeCnps: Fcfa;
  /** Impôts retenus (au crédit de l'État, 4471) : IRPP, CAC, CFC, RAV, TDL. */
  employeeTax: Fcfa;
  /** CNPS patronale (664 contre 4311). */
  employerSocial: Fcfa;
  /** Taxes patronales sur salaires (641 contre 4471) : CFC et FNE. */
  employerTax: Fcfa;
  /** Brut moins retenues légales, avant les avances. */
  net: Fcfa;
}

export const PAYROLL_LABELS: Record<keyof PayrollLines, string> = {
  gross: 'Salaire brut',
  cnps: 'CNPS, pension vieillesse',
  irpp: 'IRPP',
  cac: 'Centimes additionnels communaux (CAC)',
  cfc: 'Crédit foncier (CFC)',
  rav: 'Redevance audiovisuelle (RAV)',
  tdl: 'Taxe de développement local (TDL)',
  employerCnps: 'CNPS patronale (pension, prestations familiales, accidents)',
  employerCfc: 'Crédit foncier, part patronale',
  employerFne: 'Fonds national de l’emploi (FNE)',
};

const pct = (amount: number, rate: number) => Math.round((amount * rate) / 10_000);

function bracket(list: PayrollBracket[], amount: number): number {
  for (const b of list) if (b.upTo === null || amount <= b.upTo) return b.value;
  return list.length ? list[list.length - 1]!.value : 0;
}

/** IRPP annuel par tranches sur le revenu imposable annuel. */
function irppAnnual(list: PayrollBracket[], taxable: number): number {
  let tax = 0;
  let floor = 0;
  for (const b of list) {
    const top = b.upTo ?? Infinity;
    if (taxable <= floor) break;
    tax += ((Math.min(taxable, top) - floor) * b.value) / 10_000;
    floor = top;
  }
  return tax;
}

/** Calcule les retenues et charges d'un salaire brut mensuel. */
export function computePayroll(gross: Fcfa, rules: PayrollRules = DEFAULT_PAYROLL): Payroll {
  const g = Math.max(0, Math.round(gross));
  const capped = Math.min(g, rules.cnpsCeiling);
  const cnps = pct(capped, rules.cnpsEmployee);
  let irpp = 0;
  if (g >= rules.irppThreshold) {
    const taxable = Math.max(0, g * 12 - pct(g * 12, rules.professional) - cnps * 12 - rules.annualAbatement);
    irpp = Math.round(irppAnnual(rules.irpp, taxable) / 12);
  }
  const cac = pct(irpp, rules.cac);
  const cfc = pct(g, rules.cfcEmployee);
  const rav = g ? bracket(rules.rav, g) : 0;
  const tdl = g ? bracket(rules.tdl, g) : 0;
  const employerCnps = pct(capped, rules.cnpsEmployer) + pct(g, rules.accident);
  const employerCfc = pct(g, rules.cfcEmployer);
  const employerFne = pct(g, rules.fne);
  const employeeTax = irpp + cac + cfc + rav + tdl;
  return {
    gross: g,
    cnps,
    irpp,
    cac,
    cfc,
    rav,
    tdl,
    employerCnps,
    employerCfc,
    employerFne,
    employeeCnps: cnps,
    employeeTax,
    employerSocial: employerCnps,
    employerTax: employerCfc + employerFne,
    net: g - cnps - employeeTax,
  };
}

function rate(raw: unknown, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error(`Paie : taux invalide pour ${name}`);
  return n;
}

function amount(raw: unknown, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1e10) throw new Error(`Paie : montant invalide pour ${name}`);
  return n;
}

function brackets(raw: unknown, name: string, isRate: boolean): PayrollBracket[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 30) throw new Error(`Paie : barème ${name} invalide`);
  let last = -1;
  return raw.map((b: { upTo?: unknown; value?: unknown }, i) => {
    const top = b?.upTo === null || b?.upTo === undefined || b?.upTo === '' ? null : amount(b.upTo, name);
    if (top === null && i !== raw.length - 1) throw new Error(`Paie : seule la dernière tranche du barème ${name} peut être sans limite`);
    if (top !== null && top <= last) throw new Error(`Paie : les tranches du barème ${name} doivent croître`);
    if (top !== null) last = top;
    return {
      upTo: top,
      value: isRate ? rate(b?.value, name) : amount(b?.value, name),
    };
  });
}

/** Valide des règles de paie saisies (paramètres du magasin). */
export function normalizePayroll(raw: unknown): PayrollRules {
  const r = {
    ...DEFAULT_PAYROLL,
    ...((raw && typeof raw === 'object' ? raw : {}) as Partial<PayrollRules>),
  };
  return {
    enabled: Boolean(r.enabled),
    cnpsCeiling: amount(r.cnpsCeiling, 'le plafond CNPS'),
    cnpsEmployee: rate(r.cnpsEmployee, 'la CNPS salariale'),
    cnpsEmployer: rate(r.cnpsEmployer, 'la CNPS patronale'),
    accident: rate(r.accident, 'les accidents du travail'),
    professional: rate(r.professional, 'les frais professionnels'),
    annualAbatement: amount(r.annualAbatement, "l'abattement annuel"),
    irppThreshold: amount(r.irppThreshold, "le seuil de l'IRPP"),
    irpp: brackets(r.irpp, 'IRPP', true),
    cac: rate(r.cac, 'les CAC'),
    cfcEmployee: rate(r.cfcEmployee, 'le CFC salarial'),
    cfcEmployer: rate(r.cfcEmployer, 'le CFC patronal'),
    fne: rate(r.fne, 'le FNE'),
    rav: brackets(r.rav, 'RAV', false),
    tdl: brackets(r.tdl, 'TDL', false),
  };
}

/** Taux en centièmes de % affiché en pourcentage (« 4,2 % »). */
export const ratePct = (n: number) => `${(n / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
