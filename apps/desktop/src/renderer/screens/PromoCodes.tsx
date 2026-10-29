import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateFr, dateTime, fcfa, parseAmount, useCan, useLoad, useToast } from '../ui';

type Code = Result<'promoCodes.list'>[number];

const offer = (c: Pick<Code, 'kind' | 'value'>) => (c.kind === 'percent' ? `−${c.value} %` : `−${fcfa(c.value)}`);

/**
 * Codes de réduction à distribuer (WhatsApp, flyer, radio) : le client donne
 * le code à la caisse, et le tableau montre ce que chaque code a rapporté.
 */
export function PromoCodes() {
  const can = useCan();
  const list = useLoad(() => call('promoCodes.list'), []);
  const stores = useLoad(() => call('admin.stores'), []);
  const [editing, setEditing] = useState<Code | 'new' | null>(null);
  const [uses, setUses] = useState<Code | null>(null);
  const toast = useToast();
  const toggle = async (c: Code) => {
    try {
      await call('promoCodes.setActive', c.id, !c.active);
      list.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  const rows = list.data ?? [];
  return (
    <>
      <div className="filters">
        <span className="muted">Le client donne le code à la caisse (bouton « Code promo ») ; la remise s'ajoute aux promotions du ticket.</span>
        <button data-new className="primary" style={{ marginLeft: 'auto' }} disabled={!can('promo_codes')} onClick={() => setEditing('new')}>
          Nouveau code
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucun code de réduction. Créez par exemple « NOEL25 » à −10 % et partagez-le par WhatsApp : vous verrez ici combien de clients l'ont utilisé.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Code</th>
              <th>Libellé</th>
              <th>Remise</th>
              <th>Conditions</th>
              <th>Période</th>
              <th className="r">Utilisations</th>
              <th className="r">Remise accordée</th>
              <th className="r">Ventes des tickets</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={c.active ? '' : 'inactive'}>
                <td>
                  <strong>{c.code}</strong>
                </td>
                <td>{c.label}</td>
                <td>{offer(c)}</td>
                <td className="muted">
                  {[c.min_total ? `dès ${fcfa(c.min_total)}` : '', c.max_uses ? `${c.max_uses} fois au plus` : '', c.once_per_customer ? 'une fois par client' : '', c.store_name ?? '']
                    .filter(Boolean)
                    .join(' · ')}
                </td>
                <td>
                  {c.starts_on ? dateFr(c.starts_on) : '…'} → {c.ends_on ? dateFr(c.ends_on) : '…'}
                </td>
                <td className="r">
                  <button className="link" disabled={!c.uses} onClick={() => setUses(c)}>
                    {c.uses}
                  </button>
                </td>
                <td className="r">{fcfa(c.discount)}</td>
                <td className="r">{fcfa(c.revenue)}</td>
                <td className="nowrap">
                  {can('promo_codes') && (
                    <>
                      <button className="link" onClick={() => setEditing(c)}>
                        Modifier
                      </button>{' '}
                      <button className="link" onClick={() => void toggle(c)}>
                        {c.active ? 'Arrêter' : 'Réactiver'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <CodeDialog code={editing === 'new' ? null : editing} stores={stores.data ?? []} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), list.reload())} />}
      {uses && <UsesDialog code={uses} onClose={() => setUses(null)} />}
    </>
  );
}

function CodeDialog({ code, stores, onClose, onSaved }: { code: Code | null; stores: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    code: code?.code ?? '',
    label: code?.label ?? '',
    kind: code?.kind ?? ('percent' as 'percent' | 'amount'),
    value: code ? String(code.value) : '',
    minTotal: code?.min_total ? String(code.min_total) : '',
    startsOn: code?.starts_on ?? '',
    endsOn: code?.ends_on ?? '',
    maxUses: code?.max_uses ? String(code.max_uses) : '',
    once: code ? code.once_per_customer === 1 : false,
    storeId: code?.store_id ?? '',
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await call(
        'promoCodes.save',
        {
          code: f.code,
          label: f.label,
          kind: f.kind,
          value: f.kind === 'percent' ? Number(f.value.replace(',', '.')) : (parseAmount(f.value) ?? 0),
          minTotal: parseAmount(f.minTotal || '0') ?? 0,
          startsOn: f.startsOn || null,
          endsOn: f.endsOn || null,
          maxUses: f.maxUses ? Number(f.maxUses) : null,
          oncePerCustomer: f.once,
          storeId: f.storeId || null,
          active: code ? code.active === 1 : true,
        },
        code?.id ?? null,
      );
      toast.ok(`Code ${f.code.toUpperCase()} enregistré`);
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={code ? `Code ${code.code}` : 'Nouveau code de réduction'} onClose={onClose}>
      <form onSubmit={save}>
        <div className="grid2">
          <Field label="Code" hint="3 à 20 lettres ou chiffres, à donner aux clients">
            <input autoFocus value={f.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} placeholder="NOEL25" />
          </Field>
          <Field label="Libellé" hint="Pour vous : d'où vient le code">
            <input value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder="Flyer de Noël" />
          </Field>
          <Field label="Remise">
            <select value={f.kind} onChange={(e) => set({ kind: e.target.value as 'percent' | 'amount' })}>
              <option value="percent">En %</option>
              <option value="amount">En FCFA</option>
            </select>
          </Field>
          <Field label={f.kind === 'percent' ? 'Pourcentage' : 'Montant (FCFA)'}>
            <input inputMode="decimal" value={f.value} onChange={(e) => set({ value: e.target.value })} />
          </Field>
          <Field label="Ticket minimum (FCFA)" hint="Vide : sans minimum">
            <input inputMode="numeric" value={f.minTotal} onChange={(e) => set({ minTotal: e.target.value })} />
          </Field>
          <Field label="Utilisations au plus" hint="Vide : sans limite">
            <input inputMode="numeric" value={f.maxUses} onChange={(e) => set({ maxUses: e.target.value })} />
          </Field>
          <Field label="Du">
            <input type="date" value={f.startsOn} onChange={(e) => set({ startsOn: e.target.value })} />
          </Field>
          <Field label="Au">
            <input type="date" value={f.endsOn} onChange={(e) => set({ endsOn: e.target.value })} />
          </Field>
          <Field label="Magasin">
            <select value={f.storeId} onChange={(e) => set({ storeId: e.target.value })}>
              <option value="">Tous les magasins</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.once} onChange={(e) => set({ once: e.target.checked })} /> Une seule fois par client (le client doit être choisi à la caisse)
        </label>
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="primary">Enregistrer</button>
        </div>
      </form>
    </Modal>
  );
}

function UsesDialog({ code, onClose }: { code: Code; onClose: () => void }) {
  const uses = useLoad(() => call('promoCodes.uses', code.id), [code.id]);
  return (
    <Modal title={`Utilisations du code ${code.code}`} onClose={onClose} wide>
      <table className="list compact">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Le</th>
            <th>Client</th>
            <th>Caissier</th>
            <th className="r">Ticket</th>
            <th className="r">Remise</th>
          </tr>
        </thead>
        <tbody>
          {(uses.data ?? []).map((u) => (
            <tr key={u.sale_id}>
              <td>{u.number}</td>
              <td>{dateTime(u.created_at)}</td>
              <td>{u.customer ?? 'Client comptoir'}</td>
              <td>{u.cashier}</td>
              <td className="r">{fcfa(u.total_ttc)}</td>
              <td className="r">{fcfa(u.discount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
