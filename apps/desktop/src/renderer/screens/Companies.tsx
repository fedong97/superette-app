import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, fcfa, today, useLoad, useToast } from '../ui';

type Company = Result<'companies.list'>[number];

/**
 * Plusieurs sociétés dans une même installation : chaque société (NIU, RCCM)
 * regroupe ses magasins, et ses chiffres sont la somme de ceux de ses magasins.
 */
export function Companies() {
  const toast = useToast();
  const list = useLoad(() => call('companies.list', true), []);
  const stores = useLoad(() => call('admin.stores'), []);
  const [editing, setEditing] = useState<Company | 'new' | null>(null);
  const [consolidated, setConsolidated] = useState<string | null>(null);
  const companyOf = (storeId: string) => (stores.data ?? []).find((s) => s.id === storeId)?.company_id ?? '';
  return (
    <>
      <div className="filters">
        <span className="muted">Chaque magasin appartient à une société ; ses ventes, son stock et ses comptes restent les siens, la société en fait la somme.</span>
        <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>
          Nouvelle société
        </button>
      </div>
      {list.data?.length === 0 ? (
        <Empty>Aucune société. Créez-en une par personne morale (NIU) si vous tenez plusieurs entreprises.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Société</th>
              <th>Forme</th>
              <th>NIU</th>
              <th>RCCM</th>
              <th>Magasins</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((c) => (
              <tr key={c.id} className={c.active ? '' : 'inactive'}>
                <td>
                  <b>{c.name}</b>
                </td>
                <td>{c.legal_form ?? ''}</td>
                <td>{c.taxpayer_number ?? ''}</td>
                <td>{c.rccm ?? ''}</td>
                <td>{c.stores.map((s) => s.name).join(', ') || '—'}</td>
                <td className="r nowrap">
                  <button onClick={() => setEditing(c)}>Modifier</button>
                  <button disabled={!c.stores.length} onClick={() => setConsolidated(c.id)}>
                    Chiffres consolidés
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Magasins</h3>
      <table className="list compact">
        <tbody>
          {(stores.data ?? []).map((s) => (
            <tr key={s.id}>
              <td>
                {s.code} · {s.name}
              </td>
              <td>
                <select
                  value={companyOf(s.id)}
                  onChange={async (e) => {
                    try {
                      await call('companies.assignStore', s.id, e.target.value || null);
                      toast.ok('Magasin rattaché');
                      stores.reload();
                      list.reload();
                    } catch (err) {
                      toast.error(err);
                    }
                  }}
                >
                  <option value="">Aucune société</option>
                  {(list.data ?? [])
                    .filter((c) => c.active || c.id === companyOf(s.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <CompanyForm
          company={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
      {consolidated && <Consolidated companyId={consolidated} onClose={() => setConsolidated(null)} />}
    </>
  );
}

function CompanyForm({ company, onClose, onSaved }: { company: Company | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: company?.name ?? '',
    legalForm: company?.legal_form ?? '',
    taxpayerNumber: company?.taxpayer_number ?? '',
    rccm: company?.rccm ?? '',
    address: company?.address ?? '',
    phone: company?.phone ?? '',
    active: company ? company.active === 1 : true,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={company ? `Société ${company.name}` : 'Nouvelle société'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('companies.save', f, company?.id);
            toast.ok('Société enregistrée');
            onSaved();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="grid2">
          <Field label="Raison sociale">
            <input autoFocus value={f.name} onChange={set('name')} required maxLength={80} />
          </Field>
          <Field label="Forme juridique">
            <input value={f.legalForm} onChange={set('legalForm')} placeholder="SARL, SA, Ets…" />
          </Field>
          <Field label="NIU">
            <input value={f.taxpayerNumber} onChange={set('taxpayerNumber')} />
          </Field>
          <Field label="RCCM">
            <input value={f.rccm} onChange={set('rccm')} />
          </Field>
          <Field label="Adresse">
            <input value={f.address} onChange={set('address')} />
          </Field>
          <Field label="Téléphone">
            <input value={f.phone} onChange={set('phone')} inputMode="tel" />
          </Field>
        </div>
        {company && (
          <label>
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Société active
          </label>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!f.name.trim()}>
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Consolidated({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const [date, setDate] = useState(today());
  const data = useLoad(() => call('companies.consolidated', companyId, date), [companyId, date]);
  const d = data.data;
  return (
    <Modal title={d ? `Chiffres consolidés · ${d.company.name}` : 'Chiffres consolidés'} onClose={onClose} wide>
      <div className="filters">
        <Field label="Au">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      {d && (
        <table className="list">
          <thead>
            <tr>
              <th>Magasin</th>
              <th className="r">Ventes du mois</th>
              <th className="r">Trésorerie</th>
              <th className="r">Créances</th>
              <th className="r">Stock</th>
              <th className="r">Dettes</th>
              <th className="r">Patrimoine</th>
            </tr>
          </thead>
          <tbody>
            {[...d.stores, { ...d.total, id: 'total', name: 'Total société' }].map((s) => (
              <tr key={s.id} className={s.id === 'total' ? 'b' : ''}>
                <td>{s.name}</td>
                <td className="r">{fcfa(s.sales)}</td>
                <td className="r">{fcfa(s.treasury)}</td>
                <td className="r">{fcfa(s.receivables)}</td>
                <td className="r">{fcfa(s.stock)}</td>
                <td className="r">{fcfa(s.payables)}</td>
                <td className="r">{fcfa(s.patrimony)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
