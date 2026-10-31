import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { type Db, PG } from './database';
import type { MobileCaller } from './mobile.service';
import { activeDelegation } from './rights';

type Json = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => Number(v ?? 0) || 0;

/**
 * Actions du gérant faites sur le téléphone. Le téléphone passe par le serveur
 * et ce sont les PC qui tiennent les ventes, le stock et la caisse : l'action est
 * enregistrée ici tout de suite, puis le premier PC allumé du magasin l'exécute
 * au nom du gérant, avec les mêmes contrôles qu'à son poste, et rend la réponse.
 */
export const ACTION_KINDS = {
  'edit.decide': 'Demande de modification de facture',
  'stock.decide': 'Demande de correction de stock',
  'expense.decide': 'Dépense à approuver',
  'sale.cancel': 'Annuler une facture',
  'customer.limit': 'Plafond de crédit d’un client',
  delegate: 'Confier ses pouvoirs',
  'delegate.end': 'Fin de délégation',
} as const;
export type ActionKind = keyof typeof ACTION_KINDS;

interface ActionRow {
  id: string;
  store_id: string;
  user_id: string;
  user_name: string;
  kind: ActionKind;
  label: string;
  payload: Json;
  status: 'pending' | 'done' | 'failed' | 'expired';
  message: string | null;
  claimed_by: string | null;
  created_at: Date;
  done_at: Date | null;
}

const view = (r: ActionRow) => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  userName: r.user_name,
  status: r.status,
  message: r.message,
  at: new Date(r.created_at).toISOString(),
  doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
});

@Injectable()
export class ManagerActionsService {
  constructor(@Inject(PG) private readonly pg: Db) {}

  private async latest(entity: string, storeId: string, filter: (p: Json) => boolean): Promise<{ id: string; payload: Json }[]> {
    const { rows } = await this.pg.query<{ entity_id: string; op: string; payload: Json | null; store_id: string | null }>(
      `SELECT DISTINCT ON (entity_id) entity_id, op, payload, store_id FROM events WHERE entity = $1 ORDER BY entity_id, seq DESC`,
      [entity],
    );
    return rows
      .filter((r) => r.op !== 'delete' && r.payload && (r.store_id ?? str(r.payload['store_id'])) === storeId && filter(r.payload))
      .map((r) => ({ id: r.entity_id, payload: r.payload! }));
  }

  private async names(): Promise<Map<string, string>> {
    const { rows } = await this.pg.query<{ entity_id: string; name: string | null }>(
      "SELECT DISTINCT ON (entity_id) entity_id, payload->>'name' AS name FROM events WHERE entity = 'user' ORDER BY entity_id, seq DESC",
    );
    return new Map(rows.map((r) => [r.entity_id, str(r.name)]));
  }

  /**
   * Ce qui attend le gérant : demandes de modification de facture, corrections
   * de stock, dépenses à approuver (reçues des PC), et ses actions récentes.
   */
  async inbox(caller: MobileCaller) {
    const storeId = caller.device.store_id;
    const who = await this.names();
    const articles = new Map(
      (
        await this.pg.query<{ entity_id: string; name: string | null }>(
          "SELECT DISTINCT ON (entity_id) entity_id, payload->>'name' AS name FROM events WHERE entity = 'article' ORDER BY entity_id, seq DESC",
        )
      ).rows.map((r) => [r.entity_id, str(r.name)]),
    );
    const sales = new Map<string, Json>();
    const edits = await this.latest('sale_edit_request', storeId, (p) => p['status'] === 'pending');
    if (edits.length) {
      const { rows } = await this.pg.query<{ entity_id: string; payload: Json }>(
        `SELECT DISTINCT ON (entity_id) entity_id, payload FROM events WHERE entity = 'sale' AND entity_id = ANY($1) ORDER BY entity_id, seq DESC`,
        [edits.map((e) => str(e.payload['sale_id']))],
      );
      for (const r of rows) sales.set(r.entity_id, r.payload);
    }
    const stock = await this.latest('stock_request', storeId, (p) => p['status'] === 'pending');
    const expenses = await this.latest('expense', storeId, (p) => p['approval'] === 'pending' && p['status'] !== 'cancelled');
    return {
      edits: edits.map((e) => {
        const sale = sales.get(str(e.payload['sale_id']));
        return {
          id: e.id,
          number: str(e.payload['number']),
          sale: sale ? str(sale['number']) : '',
          total: sale ? num(sale['total_ttc']) : null,
          by: who.get(str(e.payload['requested_by'])) ?? '',
          reason: str(e.payload['reason']),
          at: str(e.payload['created_at']),
        };
      }),
      stock: stock.map((r) => ({
        id: r.id,
        number: num(r.payload['number']),
        article: articles.get(str(r.payload['article_id'])) ?? '',
        before: num(r.payload['before_qty']),
        requested: num(r.payload['requested_qty']),
        reason: str(r.payload['reason']),
        by: who.get(str(r.payload['requested_by'])) ?? '',
        at: str(r.payload['requested_at']),
      })),
      expenses: expenses.map((r) => ({
        id: r.id,
        number: str(r.payload['number']),
        label: str(r.payload['label']),
        amount: num(r.payload['amount']),
        beneficiary: (r.payload['beneficiary'] as string | null) ?? null,
        by: who.get(str(r.payload['user_id'])) ?? '',
        at: str(r.payload['created_at'] ?? r.payload['date']),
      })),
      actions: await this.mine(caller),
    };
  }

  /** Factures du jour (ou d'une date) du magasin, les plus récentes d'abord. */
  async sales(caller: MobileCaller, day?: string) {
    const storeId = caller.device.store_id;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(day ?? '') ? new Date(`${day}T00:00:00`) : new Date();
    d.setHours(0, 0, 0, 0);
    const end = new Date(d.getTime() + 86_400_000);
    const { rows } = await this.pg.query<{ entity_id: string; payload: Json }>(
      `SELECT entity_id, payload FROM (
         SELECT DISTINCT ON (entity_id) entity_id, payload FROM events
         WHERE entity = 'sale' AND payload IS NOT NULL AND COALESCE(store_id, payload->>'store_id') = $1 AND payload->>'created_at' >= $2 AND payload->>'created_at' < $3
         ORDER BY entity_id, seq DESC
       ) s ORDER BY payload->>'created_at' DESC LIMIT 300`,
      [storeId, d.toISOString(), end.toISOString()],
    );
    const who = await this.names();
    const customers = new Map(
      (
        await this.pg.query<{ entity_id: string; name: string | null }>(
          "SELECT DISTINCT ON (entity_id) entity_id, payload->>'name' AS name FROM events WHERE entity = 'customer' ORDER BY entity_id, seq DESC",
        )
      ).rows.map((r) => [r.entity_id, str(r.name)]),
    );
    const list = rows.map((r) => {
      const p = r.payload;
      const payments = Array.isArray(p['payments']) ? (p['payments'] as Json[]) : [];
      return {
        id: r.entity_id,
        number: str(p['number']),
        kind: str(p['kind']) === 'return' ? ('return' as const) : ('sale' as const),
        cancelled: p['status'] === 'cancelled',
        total: num(p['total_ttc']),
        discount: num(p['total_discount']),
        seller: who.get(str(p['seller_id'] || p['user_id'])) ?? '',
        cashier: who.get(str(p['user_id'])) ?? '',
        customer: p['customer_id'] ? (customers.get(str(p['customer_id'])) ?? '') : ((p['customer_name'] as string | null) ?? null),
        credit: payments.some((x) => x['method'] === 'CUSTOMER_CREDIT'),
        at: str(p['created_at']),
        cancelReason: (p['cancel_reason'] as string | null) ?? null,
      };
    });
    const kept = list.filter((x) => !x.cancelled);
    return {
      day: d.toISOString().slice(0, 10),
      sales: list,
      total: kept.reduce((t, x) => t + (x.kind === 'return' ? -Math.abs(x.total) : x.total), 0),
      count: kept.filter((x) => x.kind === 'sale').length,
    };
  }

  /** Utilisateurs du magasin à qui confier ses pouvoirs, et délégations en cours. */
  async team(caller: MobileCaller) {
    const storeId = caller.device.store_id;
    const { rows } = await this.pg.query<{ entity_id: string; payload: Json }>(
      `SELECT entity_id, payload FROM (SELECT DISTINCT ON (entity_id) entity_id, op, payload FROM events WHERE entity = 'user' ORDER BY entity_id, seq DESC) u
       WHERE op = 'upsert' AND (payload->>'active')::int = 1 AND payload->>'deleted_at' IS NULL AND (payload->>'store_id' IS NULL OR payload->>'store_id' = $1)`,
      [storeId],
    );
    const out = [];
    for (const r of rows) {
      if (str(r.payload['role']) === 'admin' || r.entity_id === caller.user.id) continue;
      const { rows: ur } = await this.pg.query<{ payload: Json | null }>("SELECT payload FROM events WHERE entity = 'user_rights' AND entity_id = $1 ORDER BY seq DESC LIMIT 1", [r.entity_id]);
      const d = activeDelegation(ur[0]?.payload ?? null);
      out.push({ id: r.entity_id, name: str(r.payload['name']), role: str(r.payload['role']), delegation: d ? { byName: d.byName, until: d.until } : null });
    }
    return { users: out.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** Le gérant agit sur le téléphone : l'action attend le premier PC du magasin. */
  async push(caller: MobileCaller, input: { id?: string; kind?: string; payload?: Json; label?: string }) {
    const kind = str(input?.kind) as ActionKind;
    if (!(kind in ACTION_KINDS)) throw new BadRequestException('Action inconnue');
    const id = str(input?.id).trim();
    if (!/^[\w-]{8,64}$/.test(id)) throw new BadRequestException('Action invalide');
    const payload = input?.payload && typeof input.payload === 'object' ? input.payload : {};
    if (JSON.stringify(payload).length > 5_000) throw new BadRequestException('Action invalide');
    const label = str(input?.label).trim().slice(0, 160) || ACTION_KINDS[kind];
    const { rows } = await this.pg.query<ActionRow>(
      `INSERT INTO manager_actions (id, store_id, user_id, user_name, kind, label, payload) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET id = manager_actions.id RETURNING *`,
      [id, caller.device.store_id, caller.user.id, caller.user.name, kind, label, JSON.stringify(payload)],
    );
    return view(rows[0]!);
  }

  /** Actions récentes de la personne, avec où elles en sont. */
  async mine(caller: MobileCaller) {
    await this.expire();
    const { rows } = await this.pg.query<ActionRow>(
      "SELECT * FROM manager_actions WHERE user_id = $1 AND store_id = $2 AND created_at >= now() - interval '2 days' ORDER BY created_at DESC LIMIT 30",
      [caller.user.id, caller.device.store_id],
    );
    return rows.map(view);
  }

  /** Une action qu'aucun PC n'a prise en 12 heures est abandonnée : le gérant la refait. */
  private async expire() {
    await this.pg.query(
      "UPDATE manager_actions SET status = 'expired', message = 'Aucun PC du magasin ne l’a prise : refaites-la quand un PC est allumé', done_at = now() WHERE status = 'pending' AND created_at < now() - interval '12 hours'",
    );
  }

  /** Le PC prend les actions en attente de son magasin (une action n'est prise que par un PC à la fois). */
  async claim(device: { id: string; store_id: string }) {
    await this.expire();
    const { rows } = await this.pg.query<ActionRow>(
      `UPDATE manager_actions SET claimed_by = $2, claimed_at = now()
       WHERE id IN (
         SELECT id FROM manager_actions WHERE store_id = $1 AND status = 'pending' AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
         ORDER BY created_at LIMIT 10
       ) AND status = 'pending'
       RETURNING *`,
      [device.store_id, device.id],
    );
    return { actions: rows.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)).map((r) => ({ id: r.id, kind: r.kind, userId: r.user_id, payload: r.payload, label: r.label })) };
  }

  /** Le PC rend la réponse : faite, ou refusée avec la raison (affichée sur le téléphone). */
  async finish(device: { id: string; store_id: string }, id: string, input: { ok?: boolean; message?: string | null }) {
    const { rows } = await this.pg.query<ActionRow>(
      "UPDATE manager_actions SET status = $3, message = $4, done_at = now() WHERE id = $1 AND store_id = $2 AND status = 'pending' AND claimed_by = $5 RETURNING *",
      [id, device.store_id, input?.ok ? 'done' : 'failed', str(input?.message).slice(0, 300) || null, device.id],
    );
    return { ok: Boolean(rows[0]) };
  }
}
