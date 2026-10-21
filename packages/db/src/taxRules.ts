import { TAX_DEFAULTS } from './tax';

export type RegimeCode = 'liberatoire' | 'simplifie' | 'reel';

export interface RegimeRule {
  code: RegimeCode;
  label: string;
  /** Chiffre d'affaires HT annuel : à partir de (inclus) et jusqu'à (exclu, null : sans plafond). */
  minTurnoverHt: number;
  maxTurnoverHt: number | null;
  /** Minimum de perception (acompte) en points de base du chiffre d'affaires HT, hors CAC ; null : pas d'acompte. */
  minimumRate: number | null;
  /** L'impôt est calculé sur le résultat (IS ou IRPP) ; sinon c'est un forfait. */
  resultTax: boolean;
  obligations: string;
}

/** Barème d'une période : taux, seuils et régimes, avec la date d'entrée en vigueur et la source. */
export interface TaxRuleset {
  validFrom: string;
  source: string;
  /** Date à laquelle le barème a été relu dans les textes. */
  checkedOn: string;
  cacRate: number;
  isRate: number;
  reducedRate: number;
  reducedThreshold: number;
  irppBrackets: [number, number][];
  regimes: RegimeRule[];
}

/**
 * Barèmes datés du simulateur (Code général des impôts du Cameroun). Un nouveau barème
 * s'ajoute à la fin, avec sa date d'entrée en vigueur : les anciennes années gardent le
 * leur. À relire à chaque loi de finances.
 */
export const TAX_RULESETS: TaxRuleset[] = [
  {
    validFrom: '2020-01-01',
    source: 'Code général des impôts du Cameroun, lois de finances 2020 et suivantes',
    checkedOn: '2026-10-21',
    cacRate: TAX_DEFAULTS.cacRate,
    isRate: TAX_DEFAULTS.isRate,
    reducedRate: TAX_DEFAULTS.reducedRate,
    reducedThreshold: TAX_DEFAULTS.reducedThreshold,
    irppBrackets: TAX_DEFAULTS.irppBrackets,
    regimes: [
      {
        code: 'liberatoire',
        label: 'Impôt libératoire',
        minTurnoverHt: 0,
        maxTurnoverHt: 10_000_000,
        minimumRate: null,
        resultTax: false,
        obligations: 'Forfait fixé par la commune selon l’activité, payé par trimestre.',
      },
      {
        code: 'simplifie',
        label: 'Régime simplifié',
        minTurnoverHt: 10_000_000,
        maxTurnoverHt: 50_000_000,
        minimumRate: TAX_DEFAULTS.minimumRate.simplifie,
        resultTax: true,
        obligations: 'Acompte mensuel sur le chiffre d’affaires, impôt sur le résultat, déclaration statistique et fiscale annuelle.',
      },
      {
        code: 'reel',
        label: 'Régime du réel',
        minTurnoverHt: 50_000_000,
        maxTurnoverHt: null,
        minimumRate: TAX_DEFAULTS.minimumRate.reel,
        resultTax: true,
        obligations: 'Comptabilité SYSCOHADA complète, déclarations mensuelles, acompte mensuel, impôt sur le résultat, DSF annuelle.',
      },
    ],
  },
];

/** Barème en vigueur à une date : le dernier entré en vigueur avant elle. */
export function rulesetFor(date: string): TaxRuleset {
  const sorted = [...TAX_RULESETS].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  return sorted.filter((r) => r.validFrom <= date).pop() ?? sorted[0]!;
}
