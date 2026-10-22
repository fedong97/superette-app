import { ASSET_FUNDINGS, type AssetFunding, type Fcfa } from '@superette/core';
import type { Entry, EntryLine } from './accounting';
import type { Db } from './database';
import { SYSCOHADA_ACCOUNTS } from './syscohada';
import { AppError, Base, type Context, newId } from './util';

/**
 * Registre des immobilisations : une fiche par bien (réfrigérateur, véhicule,
 * ordinateur, agencements), son plan d'amortissement linéaire au prorata des
 * jours, et les écritures qui en découlent sans saisie : acquisition, dotation
 * à chaque fin d'exercice, sortie du bien vendu ou mis au rebut.
 *
 * Comme le reste de la comptabilité, les écritures se recalculent à partir des
 * fiches : rien n'est recopié, donc rien ne se désynchronise entre les PC.
 */

const FUNDING_ACCOUNT: Record<Exclude<AssetFunding, 'none'>, string> = { supplier: '481', bank: '521', opening: '4711' };
const DISPOSAL_KINDS = { sale: 'Vendu', scrap: 'Mis au rebut' } as const;

export interface FixedAsset {
  id: string;
  code: string;
  store_id: string;
  label: string;
  account: string;
  /** Mise en service : point de départ de l'amortissement. */
  in_service_on: string;
  /** Entrée dans ONIX 360 : achat, ou reprise d'un bien déjà amorti en partie. */
  recorded_on: string;
  cost: Fcfa;
  /** Durée d'amortissement en mois ; 0 : non amortissable (terrain). */
  duration_months: number;
  funding: AssetFunding;
  supplier: string | null;
  notes: string | null;
  disposed_on: string | null;
  disposal_kind: keyof typeof DISPOSAL_KINDS | null;
  disposal_price: Fcfa | null;
  created_at: string;
  updated_at: string;
}

export interface FixedAssetRow extends FixedAsset {
  depreciation_account: string;
  /** Amortissements cumulés à la date demandée. */
  cumulated: Fcfa;
  net: Fcfa;
  /** Dotation de l'exercice en cours (jusqu'à sa fin ou à la sortie du bien). */
  year_charge: Fcfa;
  /** Fin de l'amortissement. */
  ends_on: string | null;
}

export interface AssetInput {
  label: string;
  account: string;
  inServiceOn: string;
  recordedOn?: string | null;
  cost: Fcfa;
  durationMonths: number;
  funding: AssetFunding;
  supplier?: string | null;
  notes?: string | null;
}

export interface ScheduleRow {
  from: string;
  to: string;
  /** Exercice antérieur à l'entrée du bien dans ONIX 360 (amortissement déjà pratiqué). */
  prior: boolean;
  opening: Fcfa;
  charge: Fcfa;
  cumulated: Fcfa;
  net: Fcfa;
}

const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(t(d) + n * DAY);
function addMonths(d: string, months: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last)));
}
const validDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && iso(t(d)) === d;

/** Compte d'amortissement d'un compte d'immobilisation : 2442 → 2844, 213 → 2813, 241 → 2841. */
export const depreciationAccount = (account: string) => `28${account.slice(1, 3)}`;
/** Dotation : incorporelles (21) sur 6812, corporelles sur 6813. */
const chargeAccount = (account: string) => (account.startsWith('21') ? '6812' : '6813');
const isDepreciable = (a: Pick<FixedAsset, 'account' | 'duration_months'>) => a.duration_months > 0 && !a.account.startsWith('22');

/** Fin de l'amortissement (dernier jour), null si le bien ne s'amortit pas. */
export function depreciationEnd(a: Pick<FixedAsset, 'in_service_on' | 'duration_months' | 'account'>): string | null {
  return isDepreciable(a) ? addDays(addMonths(a.in_service_on, a.duration_months), -1) : null;
}

/** Amortissements cumulés à la fin du jour `d` : linéaire au prorata des jours, arrondis au franc sans dérive. */
export function cumulatedAt(a: Pick<FixedAsset, 'in_service_on' | 'duration_months' | 'account' | 'cost'>, d: string): Fcfa {
  const end = depreciationEnd(a);
  if (!end || d < a.in_service_on) return 0;
  if (d >= end) return a.cost;
  const life = (t(end) - t(a.in_service_on)) / DAY + 1;
  const elapsed = (t(d) - t(a.in_service_on)) / DAY + 1;
  return Math.round((a.cost * elapsed) / life);
}

export class AssetService extends Base {
  /** Exercices du magasin, complétés par des années civiles avant, entre et après. */
  periods(storeId: string, from: string, to: string): { from: string; to: string }[] {
    const years = this.db.prepare('SELECT start_date AS "from", end_date AS "to" FROM fiscal_years WHERE store_id = ? ORDER BY start_date').all(storeId) as {
      from: string;
      to: string;
    }[];
    const out: { from: string; to: string }[] = [];
    let cursor = from;
    while (cursor <= to) {
      const fy = years.find((y) => y.from <= cursor && y.to >= cursor);
      if (fy) {
        out.push({ from: fy.from, to: fy.to });
        cursor = addDays(fy.to, 1);
        continue;
      }
      // Hors exercice ouvert : année civile, coupée au début de l'exercice suivant.
      const next = years.find((y) => y.from > cursor);
      let end = `${cursor.slice(0, 4)}-12-31`;
      if (next && next.from <= end) end = addDays(next.from, -1);
      const previous = [...years].reverse().find((y) => y.to < cursor);
      const jan1 = `${cursor.slice(0, 4)}-01-01`;
      const start = previous && previous.to >= jan1 ? addDays(previous.to, 1) : jan1;
      out.push({ from: start, to: end });
      cursor = addDays(end, 1);
    }
    return out;
  }

  get(id: string): FixedAsset {
    const row = this.db.prepare('SELECT * FROM fixed_assets WHERE id = ?').get(id) as FixedAsset | undefined;
    if (!row) throw new AppError('Immobilisation introuvable', 'NOT_FOUND');
    return row;
  }

  list(storeId: string, opts: { at?: string; includeDisposed?: boolean } = {}): FixedAssetRow[] {
    const at = opts.at ?? this.today();
    const rows = this.db.prepare('SELECT * FROM fixed_assets WHERE store_id = ? ORDER BY account, in_service_on, code').all(storeId) as FixedAsset[];
    const current = this.periods(storeId, at, at)[0]!;
    return rows
      .filter((a) => opts.includeDisposed || !a.disposed_on || a.disposed_on > at)
      .map((a) => {
        const stop = a.disposed_on && a.disposed_on < current.to ? a.disposed_on : current.to;
        const cumulated = cumulatedAt(a, a.disposed_on && a.disposed_on < at ? a.disposed_on : at);
        const yearCharge = cumulatedAt(a, stop) - cumulatedAt(a, addDays(current.from > a.recorded_on ? current.from : a.recorded_on, -1));
        return {
          ...a,
          depreciation_account: depreciationAccount(a.account),
          cumulated,
          net: a.cost - cumulated,
          year_charge: Math.max(0, yearCharge),
          ends_on: depreciationEnd(a),
        };
      });
  }

  /** Plan d'amortissement par exercice, de la mise en service à la fin de l'amortissement (ou à la sortie du bien). */
  schedule(id: string): ScheduleRow[] {
    const a = this.get(id);
    const end = depreciationEnd(a);
    if (!end) return [];
    const last = a.disposed_on && a.disposed_on < end ? a.disposed_on : end;
    let previous = 0;
    return this.periods(a.store_id, a.in_service_on, last).map((p) => {
      const to = p.to < last ? p.to : last;
      const cumulated = cumulatedAt(a, to);
      const row = { from: p.from < a.in_service_on ? a.in_service_on : p.from, to, prior: to < a.recorded_on, opening: a.cost - previous, charge: cumulated - previous, cumulated, net: a.cost - cumulated };
      previous = cumulated;
      return row;
    });
  }

  private check(storeId: string, input: AssetInput): Required<Pick<AssetInput, 'recordedOn'>> & AssetInput {
    const label = input.label.trim();
    if (!label) throw new AppError("Indiquez le nom du bien (ex. : Congélateur coffre 400 L)", 'INVALID');
    const account = input.account.trim();
    if (!/^2[1-4]\d{1,6}$/.test(account)) throw new AppError("Compte d'immobilisation invalide : classe 21 à 24 (ex. 2442 matériel informatique)", 'INVALID');
    if (!validDate(input.inServiceOn)) throw new AppError('Date de mise en service invalide', 'INVALID');
    const recordedOn = input.recordedOn || input.inServiceOn;
    if (!validDate(recordedOn)) throw new AppError("Date d'entrée invalide", 'INVALID');
    if (recordedOn < input.inServiceOn) throw new AppError("Le bien ne peut pas entrer dans ONIX 360 avant sa mise en service", 'INVALID');
    if (recordedOn > this.today()) throw new AppError('Un bien futur ne s’enregistre pas encore', 'INVALID');
    if (recordedOn > input.inServiceOn && input.funding !== 'opening' && input.funding !== 'none') {
      throw new AppError('Un bien déjà en service avant son entrée se reprend en à-nouveaux (« Bien repris »)', 'INVALID');
    }
    if (!Number.isSafeInteger(input.cost) || input.cost <= 0) throw new AppError("Valeur d'origine invalide", 'INVALID');
    if (!Number.isInteger(input.durationMonths) || input.durationMonths < 0 || input.durationMonths > 600) throw new AppError("Durée d'amortissement invalide", 'INVALID');
    if (input.durationMonths === 0 && !account.startsWith('22')) throw new AppError("Indiquez une durée d'amortissement (seuls les terrains ne s'amortissent pas)", 'INVALID');
    if (!(input.funding in ASSET_FUNDINGS)) throw new AppError('Mode de financement inconnu', 'INVALID');
    this.assertPeriodOpen(storeId, recordedOn);
    return { ...input, label, account, recordedOn };
  }

  /** Une dotation a-t-elle déjà été passée (une fin d'exercice est passée depuis l'entrée du bien) ? */
  private charged(a: FixedAsset): boolean {
    return isDepreciable(a) && this.periods(a.store_id, a.recorded_on, this.today()).some((p) => p.to < this.today());
  }

  /** Crée les comptes que le plan du magasin n'a pas encore (libellé du SYSCOHADA). */
  private ensureAccounts(accounts: string[]): void {
    const labels = new Map(SYSCOHADA_ACCOUNTS);
    for (const id of accounts) {
      if (this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) continue;
      const label = labels.get(id) ?? labels.get(id.slice(0, 3)) ?? labels.get(id.slice(0, 2)) ?? `Compte ${id}`;
      this.db.prepare('INSERT INTO accounts (id, label, role, active, updated_at) VALUES (?, ?, NULL, 1, ?)').run(id, label, this.now());
      this.enqueue(null, 'account', id, 'upsert', {});
    }
  }

  save(ctx: Context, raw: AssetInput, id?: string): FixedAsset {
    const input = this.check(ctx.storeId, raw);
    return this.tx(() => {
      const now = this.now();
      const values = {
        label: input.label,
        account: input.account,
        in_service_on: input.inServiceOn,
        recorded_on: input.recordedOn,
        cost: input.cost,
        duration_months: input.durationMonths,
        funding: input.funding,
        supplier: input.supplier?.trim() || null,
        notes: input.notes?.trim() || null,
        updated_at: now,
      };
      let assetId = id;
      if (assetId) {
        const before = this.get(assetId);
        if (before.store_id !== ctx.storeId) throw new AppError('Cette immobilisation appartient à un autre magasin', 'FORBIDDEN');
        if (before.disposed_on) throw new AppError('Ce bien est sorti du registre : il ne se modifie plus', 'INVALID_STATE');
        const financial = (['account', 'in_service_on', 'recorded_on', 'cost', 'duration_months', 'funding'] as const).some((k) => before[k] !== values[k]);
        if (financial) {
          this.assertPeriodOpen(ctx.storeId, before.recorded_on);
          if (this.charged(before)) throw new AppError('Une dotation a déjà été passée : seuls le nom, le fournisseur et les notes se modifient encore', 'INVALID_STATE');
        }
        this.db
          .prepare(
            `UPDATE fixed_assets SET label = @label, account = @account, in_service_on = @in_service_on, recorded_on = @recorded_on, cost = @cost,
               duration_months = @duration_months, funding = @funding, supplier = @supplier, notes = @notes, updated_at = @updated_at WHERE id = @id`,
          )
          .run({ ...values, id: assetId });
      } else {
        assetId = newId();
        const code = `IMMO-${this.stationPrefix()}-${String(this.nextCounter('fixed_asset.code')).padStart(5, '0')}`;
        this.db
          .prepare(
            `INSERT INTO fixed_assets (id, code, store_id, label, account, in_service_on, recorded_on, cost, duration_months, funding, supplier, notes, user_id, created_at, updated_at)
             VALUES (@id, @code, @store_id, @label, @account, @in_service_on, @recorded_on, @cost, @duration_months, @funding, @supplier, @notes, @user_id, @created_at, @updated_at)`,
          )
          .run({ ...values, id: assetId, code, store_id: ctx.storeId, user_id: ctx.userId, created_at: now });
      }
      const accounts = [input.account];
      if (isDepreciable({ account: input.account, duration_months: input.durationMonths })) accounts.push(depreciationAccount(input.account), chargeAccount(input.account));
      if (input.funding !== 'none') accounts.push(FUNDING_ACCOUNT[input.funding]);
      this.ensureAccounts(accounts);
      this.enqueue(ctx, 'fixed_asset', assetId, 'upsert', {});
      this.audit(ctx.userId, id ? 'asset.update' : 'asset.create', 'fixed_asset', assetId, { label: input.label, cost: input.cost });
      return this.get(assetId);
    });
  }

  /** Sortie du registre : vente (prix de cession) ou mise au rebut, avec la dotation jusqu'à ce jour. */
  dispose(ctx: Context, id: string, input: { date: string; kind: keyof typeof DISPOSAL_KINDS; price?: Fcfa | null }): FixedAsset {
    const a = this.get(id);
    if (a.store_id !== ctx.storeId) throw new AppError('Cette immobilisation appartient à un autre magasin', 'FORBIDDEN');
    if (a.disposed_on) throw new AppError('Ce bien est déjà sorti du registre', 'INVALID_STATE');
    if (!validDate(input.date) || input.date < a.recorded_on || input.date > this.today()) throw new AppError('Date de sortie invalide', 'INVALID');
    if (!(input.kind in DISPOSAL_KINDS)) throw new AppError('Motif de sortie inconnu', 'INVALID');
    const price = input.kind === 'sale' ? (input.price ?? 0) : 0;
    if (!Number.isSafeInteger(price) || price < 0) throw new AppError('Prix de cession invalide', 'INVALID');
    if (input.kind === 'sale' && price <= 0) throw new AppError('Indiquez le prix de vente du bien', 'INVALID');
    this.assertPeriodOpen(ctx.storeId, input.date);
    return this.tx(() => {
      this.db
        .prepare('UPDATE fixed_assets SET disposed_on = ?, disposal_kind = ?, disposal_price = ?, updated_at = ? WHERE id = ?')
        .run(input.date, input.kind, input.kind === 'sale' ? price : null, this.now(), id);
      this.ensureAccounts(['812', ...(price ? ['485', '822'] : [])]);
      this.enqueue(ctx, 'fixed_asset', id, 'upsert', {});
      this.audit(ctx.userId, 'asset.dispose', 'fixed_asset', id, { date: input.date, kind: input.kind, price });
      return this.get(id);
    });
  }

  /** Supprime une fiche saisie par erreur, tant qu'aucune dotation n'a été passée. */
  remove(ctx: Context, id: string): void {
    const a = this.get(id);
    if (a.store_id !== ctx.storeId) throw new AppError('Cette immobilisation appartient à un autre magasin', 'FORBIDDEN');
    this.assertPeriodOpen(ctx.storeId, a.recorded_on);
    if (a.disposed_on || this.charged(a)) throw new AppError('Une dotation a déjà été passée : sortez le bien du registre plutôt que de le supprimer', 'INVALID_STATE');
    this.tx(() => {
      this.db.prepare('DELETE FROM fixed_assets WHERE id = ?').run(id);
      this.enqueue(ctx, 'fixed_asset', id, 'delete', {});
      this.audit(ctx.userId, 'asset.delete', 'fixed_asset', id, { label: a.label });
    });
  }

  /** Écritures du registre : acquisition, dotations de fin d'exercice, sortie. */
  entries(storeId: string, opts: { from?: string; to?: string }): Entry[] {
    const today = this.today();
    const rows = this.db.prepare('SELECT * FROM fixed_assets WHERE store_id = ?').all(storeId) as FixedAsset[];
    const out: Entry[] = [];
    const line = (account: string, amount: number, label: string): EntryLine => ({
      account,
      aux: null,
      aux_name: null,
      label,
      debit: amount > 0 ? amount : 0,
      credit: amount < 0 ? -amount : 0,
    });
    for (const a of rows) {
      const dep = depreciationAccount(a.account);
      const charge = chargeAccount(a.account);
      // Amortissements pratiqués avant l'entrée du bien (bien repris).
      const prior = cumulatedAt(a, addDays(a.recorded_on, -1));
      if (a.funding !== 'none') {
        const label = a.funding === 'opening' ? `Reprise : ${a.label}` : `Acquisition ${a.label}`;
        out.push({
          journal: a.funding === 'opening' ? 'AN' : a.funding === 'bank' ? 'BQ' : 'OD',
          date: a.recorded_on,
          ref: a.code,
          label,
          source: 'auto',
          lines: [line(a.account, a.cost, label), line(dep, -prior, label), line(FUNDING_ACCOUNT[a.funding], -(a.cost - prior), label)].filter((l) => l.debit || l.credit),
        });
      }
      if (isDepreciable(a)) {
        const stop = a.disposed_on ?? today;
        let booked = prior;
        for (const p of this.periods(storeId, a.recorded_on, stop)) {
          // Dotation à la fin de chaque exercice terminé ; à la sortie, celle de l'exercice jusqu'à ce jour.
          const disposedHere = Boolean(a.disposed_on && a.disposed_on <= p.to);
          const at = disposedHere ? a.disposed_on! : p.to;
          if (at > today) break;
          const cumulated = cumulatedAt(a, at);
          const amount = cumulated - booked;
          booked = cumulated;
          if (amount > 0) {
            const label = `Dotation ${p.from.slice(0, 4) === at.slice(0, 4) ? at.slice(0, 4) : `${p.from.slice(0, 4)}-${at.slice(0, 4)}`} ${a.label}`;
            out.push({ journal: 'OD', date: at, ref: `${a.code}-D${at.slice(0, 4)}${at.slice(5, 7)}`, label, source: 'auto', lines: [line(charge, amount, label), line(dep, -amount, label)] });
          }
          if (disposedHere) break;
        }
      }
      if (a.disposed_on) {
        const cumulated = cumulatedAt(a, a.disposed_on);
        const label = `Sortie (${DISPOSAL_KINDS[a.disposal_kind!].toLowerCase()}) ${a.label}`;
        const lines = [line(dep, cumulated, label), line('812', a.cost - cumulated, label), line(a.account, -a.cost, label)];
        if (a.disposal_price) lines.push(line('485', a.disposal_price, label), line('822', -a.disposal_price, label));
        out.push({ journal: 'OD', date: a.disposed_on, ref: `${a.code}-S`, label, source: 'auto', lines: lines.filter((l) => l.debit || l.credit) });
      }
    }
    return out.filter((e) => (!opts.from || e.date >= opts.from) && (!opts.to || e.date <= opts.to));
  }
}

/** Pour la comptabilité : écritures du registre sans créer de dépendance circulaire. */
export function assetEntries(db: Db, clock: () => Date, storeId: string, opts: { from?: string; to?: string }): Entry[] {
  return new AssetService(db, clock).entries(storeId, opts);
}
