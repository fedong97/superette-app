/**
 * Personnel et pointage : jours fériés, horaires des équipes (y compris les
 * gardes de nuit qui finissent le lendemain) et rotations.
 */

export interface Holiday {
  /** AAAA-MM-JJ. */
  day: string;
  label: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Dimanche de Pâques (calendrier grégorien, algorithme de Meeus). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

/**
 * Jours fériés légaux du Cameroun qui tombent à date connue : fêtes fixes, et
 * Vendredi saint et Ascension (d'après Pâques). Les fêtes musulmanes (Aïd
 * el-Fitr, Tabaski) suivent la lune : elles s'ajoutent dans les paramètres.
 */
export function cameroonHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  return [
    { day: `${year}-01-01`, label: 'Jour de l’an' },
    { day: `${year}-02-11`, label: 'Fête de la jeunesse' },
    { day: shift(easter, -2), label: 'Vendredi saint' },
    { day: `${year}-05-01`, label: 'Fête du travail' },
    { day: `${year}-05-20`, label: 'Fête nationale' },
    { day: shift(easter, 39), label: 'Ascension' },
    { day: `${year}-08-15`, label: 'Assomption' },
    { day: `${year}-12-25`, label: 'Noël' },
  ].sort((x, y) => x.day.localeCompare(y.day));
}

/**
 * Jours fériés ajoutés dans les paramètres : un par ligne (ou séparés par « ; »),
 * « AAAA-MM-JJ Libellé », ou « MM-JJ Libellé » pour un jour fixe chaque année.
 * Lève une erreur en français sur une ligne illisible.
 */
export function parseHolidays(text: string): { date: string; label: string }[] {
  const out: { date: string; label: string }[] = [];
  for (const raw of text.split(/[\n;]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})\s*(.*)$/.exec(line);
    if (!m) throw new Error(`Jour férié illisible : « ${line} ». Écrivez par exemple 2026-03-20 Aïd el-Fitr`);
    const date = m[1]!;
    const [mm, dd] = date.length === 5 ? date.split('-').map(Number) : date.slice(5).split('-').map(Number);
    if (!mm || mm > 12 || !dd || dd > 31) throw new Error(`Date invalide : ${date}`);
    out.push({ date, label: (m[2] ?? '').trim() || 'Jour férié' });
  }
  return out;
}

/** Jours fériés d'une période (bornes comprises) : légaux si demandés, puis ceux des paramètres. */
export function holidaysBetween(from: string, to: string, opts: { cameroon: boolean; extra: string }): Map<string, string> {
  const out = new Map<string, string>();
  let extra: { date: string; label: string }[] = [];
  try {
    extra = parseHolidays(opts.extra);
  } catch {
    extra = [];
  }
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
    const days = [...(opts.cameroon ? cameroonHolidays(y) : []), ...extra.map((e) => ({ day: e.date.length === 5 ? `${y}-${e.date}` : e.date, label: e.label }))];
    for (const h of days) if (h.day >= from && h.day <= to && !out.has(h.day)) out.set(h.day, h.label);
  }
  return out;
}

/** Catégories du personnel : chacun a une fiche, qu'il se connecte au logiciel ou non. */
export const STAFF_KINDS = {
  employee: 'Employé',
  daily: 'Journalier',
  intern: 'Stagiaire',
  contractor: 'Agent d’une société prestataire',
} as const;
export type StaffKind = keyof typeof STAFF_KINDS;
/** Libellés courts (listes) et au pluriel (décomptes). */
export const STAFF_KINDS_SHORT: Record<StaffKind, string> = { employee: 'Employé', daily: 'Journalier', intern: 'Stagiaire', contractor: 'Prestataire' };
export const STAFF_KINDS_PLURAL: Record<StaffKind, string> = { employee: 'employés', daily: 'journaliers', intern: 'stagiaires', contractor: 'agents prestataires' };

/** Types de contrat. */
export const CONTRACT_TYPES = {
  cdi: 'CDI',
  cdd: 'CDD',
  trial: 'Période d’essai',
  daily: 'Journalier',
  internship: 'Stage',
  service: 'Contrat de prestation',
} as const;
export type ContractType = keyof typeof CONTRACT_TYPES;

/** Façons de pointer. */
export const PUNCH_METHODS = {
  login: 'Connexion au logiciel',
  badge: 'Badge',
  pin: 'Numéro et code',
  manual: 'Saisi par le gérant',
  fingerprint: 'Empreinte',
} as const;
export type PunchMethod = keyof typeof PUNCH_METHODS;

/** Horaire d'une journée : la fin avant le début veut dire que la garde finit le lendemain. */
export interface ShiftHours {
  start: string;
  end: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHhmm = (s: unknown): s is string => typeof s === 'string' && HHMM.test(s);
export const hhmmMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Durée prévue d'un horaire en minutes ; une garde de nuit (22:00 → 06:00) passe minuit. */
export function shiftLength(s: ShiftHours): number {
  const a = hhmmMinutes(s.start);
  const b = hhmmMinutes(s.end);
  return b > a ? b - a : b + 1440 - a;
}

/** Début et fin prévus d'un horaire pour un jour donné, à l'heure locale du poste. */
export function shiftBounds(day: string, s: ShiftHours): { start: Date; end: Date } {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y!, m! - 1, d!, Number(s.start.slice(0, 2)), Number(s.start.slice(3, 5)));
  const end = new Date(start.getTime() + shiftLength(s) * 60_000);
  return { start, end };
}

/** Rotation : les équipes se suivent, chacune pendant `weeks` semaines, à partir du lundi `start`. */
export interface Rotation {
  teams: string[];
  start: string;
  weeks: number;
}

/** Équipe de la rotation pour un jour donné ; null avant le début de la rotation. */
export function rotationTeam(rot: Rotation, day: string): string | null {
  if (!rot.teams.length || day < rot.start) return null;
  const days = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${rot.start}T12:00:00Z`)) / 86_400_000);
  const turn = Math.floor(days / (7 * Math.max(1, rot.weeks)));
  return rot.teams[turn % rot.teams.length] ?? null;
}

/** Rotation lue en base (JSON), null si absente ou illisible. */
export function parseRotation(json: string | null | undefined): Rotation | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Partial<Rotation>;
    if (!Array.isArray(r.teams) || !r.teams.length || typeof r.start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.start)) return null;
    return { teams: r.teams.map(String), start: r.start, weeks: Math.max(1, Math.min(8, Math.round(Number(r.weeks) || 1))) };
  } catch {
    return null;
  }
}
