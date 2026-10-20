import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AlertsService } from './alerts.service';
import { type Db, PG } from './database';
import { verifyPin } from './mobile.service';
import type { Device } from './sync.service';

/** Une demande sans réponse expire au bout de 3 minutes. */
const TTL_MS = 3 * 60_000;
/** Codes faux tolérés sur une demande avant qu'elle soit refusée. */
const MAX_TRIES = 5;

type Json = Record<string, unknown>;

/**
 * Accord du gérant à distance : la caisse demande, le gérant accepte avec son
 * code sur son téléphone (le même code qu'au PC, vérifié ici sur la fiche
 * reçue des PC) ou refuse. La caisse lit la réponse une seule fois.
 */
@Injectable()
export class ApprovalsService {
  private readonly tries = new Map<string, number>();

  constructor(
    @Inject(PG) private readonly pg: Db,
    @Inject(AlertsService) private readonly alerts: AlertsService,
  ) {}

  private async expire() {
    await this.pg.query("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND created_at < $1", [new Date(Date.now() - TTL_MS)]);
  }

  private async latest(entity: string, id: string): Promise<Json | null> {
    const { rows } = await this.pg.query<{ payload: Json | null }>('SELECT payload FROM events WHERE entity = $1 AND entity_id = $2 ORDER BY seq DESC LIMIT 1', [entity, id]);
    return rows[0]?.payload ?? null;
  }

  async request(device: Device, input: { action: string; requestedBy?: string }) {
    const action = String(input?.action ?? '').trim().slice(0, 300);
    if (!action) throw new BadRequestException('Dites ce qui est demandé');
    const id = randomUUID();
    await this.pg.query('INSERT INTO approvals (id, device_id, store_id, register_id, action, requested_by) VALUES ($1, $2, $3, $4, $5, $6)', [
      id,
      device.id,
      device.store_id,
      device.register_id,
      action,
      String(input?.requestedBy ?? '').slice(0, 80) || null,
    ]);
    const store = await this.latest('store', device.store_id);
    const register = await this.latest('register', device.register_id);
    await this.alerts
      .notify([
        {
          key: `approval:${id}`,
          kind: 'approval',
          store: store ? String(store['name'] ?? '') : null,
          title: 'Accord demandé',
          text: `${register ? `${String(register['name'] ?? '')} · ` : ''}${input?.requestedBy ? `${input.requestedBy} : ` : ''}${action}`,
          at: new Date().toISOString(),
        },
      ])
      .catch(() => 0);
    return { id, expiresInSeconds: TTL_MS / 1000 };
  }

  /** Réponse lue par la caisse : une seule fois une fois accordée. */
  async status(device: Device, id: string) {
    await this.expire();
    const { rows } = await this.pg.query<{ status: string; decided_by: string | null; decided_name: string | null; fetched_at: Date | null }>(
      'SELECT status, decided_by, decided_name, fetched_at FROM approvals WHERE id = $1 AND device_id = $2',
      [id, device.id],
    );
    const a = rows[0];
    if (!a) throw new NotFoundException('Demande introuvable');
    if (a.status !== 'approved') return { status: a.status, decidedName: a.decided_name };
    if (a.fetched_at) return { status: 'used', decidedName: a.decided_name };
    await this.pg.query('UPDATE approvals SET fetched_at = now() WHERE id = $1', [id]);
    return { status: 'approved', decidedBy: a.decided_by, decidedName: a.decided_name };
  }

  /** Demandes en attente, pour la page du gérant. */
  async pending() {
    await this.expire();
    const { rows } = await this.pg.query<{ id: string; store_id: string; register_id: string | null; action: string; requested_by: string | null; created_at: Date }>(
      "SELECT id, store_id, register_id, action, requested_by, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at",
    );
    const out = [];
    for (const r of rows) {
      const store = await this.latest('store', r.store_id);
      const register = r.register_id ? await this.latest('register', r.register_id) : null;
      out.push({
        id: r.id,
        store: store ? String(store['name'] ?? '') : null,
        register: register ? String(register['name'] ?? '') : null,
        action: r.action,
        requestedBy: r.requested_by,
        at: new Date(r.created_at).toISOString(),
        expiresAt: new Date(new Date(r.created_at).getTime() + TTL_MS).toISOString(),
      });
    }
    return out;
  }

  /** Le gérant accepte avec son code (gérant ou administrateur du magasin) ou refuse. */
  async decide(id: string, input: { approve: boolean; pin?: string }) {
    await this.expire();
    const { rows } = await this.pg.query<{ status: string; store_id: string }>('SELECT status, store_id FROM approvals WHERE id = $1', [id]);
    const a = rows[0];
    if (!a) throw new NotFoundException('Demande introuvable');
    if (a.status !== 'pending') throw new BadRequestException(a.status === 'expired' ? 'Demande expirée : la caisse doit redemander' : 'Demande déjà traitée');
    if (!input?.approve) {
      await this.pg.query("UPDATE approvals SET status = 'refused', decided_at = now() WHERE id = $1", [id]);
      return { status: 'refused' };
    }
    const { rows: users } = await this.pg.query<{ entity_id: string; payload: Json }>(
      `SELECT entity_id, payload FROM (SELECT DISTINCT ON (entity_id) entity_id, op, payload FROM events WHERE entity = 'user' ORDER BY entity_id, seq DESC) u
       WHERE op = 'upsert' AND payload->>'role' IN ('admin', 'manager') AND (payload->>'active')::int = 1 AND payload->>'deleted_at' IS NULL
         AND (payload->>'store_id' IS NULL OR payload->>'store_id' = $1)`,
      [a.store_id],
    );
    const match = users.find((u) => verifyPin(String(input.pin ?? ''), String(u.payload['pin_hash'] ?? '')));
    if (!match) {
      const n = (this.tries.get(id) ?? 0) + 1;
      this.tries.set(id, n);
      if (n >= MAX_TRIES) {
        await this.pg.query("UPDATE approvals SET status = 'refused', decided_at = now() WHERE id = $1", [id]);
        throw new HttpException('Trop de codes faux : la demande est refusée', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new ForbiddenException('Code refusé');
    }
    this.tries.delete(id);
    const name = String(match.payload['name'] ?? '');
    await this.pg.query("UPDATE approvals SET status = 'approved', decided_by = $2, decided_name = $3, decided_at = now() WHERE id = $1 AND status = 'pending'", [id, match.entity_id, name]);
    return { status: 'approved', decidedName: name };
  }
}
