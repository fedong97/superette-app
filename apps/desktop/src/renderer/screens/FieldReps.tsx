import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, openScreen, useCan, useLoad, useToast } from '../ui';

type Rep = Result<'fieldReps.list'>[number];

/**
 * Commerciaux de terrain (prévendeurs, représentants), chacun avec sa zone et
 * sa ville. Le rapport par commercial, zone ou ville se trouve dans les rapports de ventes.
 */
export function FieldReps() {
  const can = useCan();
  const list = useLoad(() => call('fieldReps.list', true), []);
  const [editing, setEditing] = useState<Rep | 'new' | null>(null);
  const rows = list.data ?? [];
  return (
    <>
      <div className="filters">
        <span className="muted">Une vente attribuée à un commercial garde sa zone et sa ville du jour : s'il change de secteur, ses anciennes ventes restent dans l'ancien.</span>
        <button style={{ marginLeft: 'auto' }} onClick={() => openScreen('reports', 'field_zone')}>
          Ventes par zone
        </button>
        <button data-new className="primary" disabled={!can('field_reps')} onClick={() => setEditing('new')}>
          Nouveau commercial
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucun commercial de terrain. Ajoutez vos prévendeurs avec leur zone (BONAMOUSSADI, AKWA…) et leur ville, puis rattachez-leur des clients.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Commercial</th>
              <th>Téléphone</th>
              <th>Ville</th>
              <th>Zone</th>
              <th className="r">Clients suivis</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.active ? '' : 'inactive'}>
                <td>{r.name}</td>
                <td>{r.phone ?? ''}</td>
                <td>{r.city}</td>
                <td>{r.zone}</td>
                <td className="r">{r.customers}</td>
                <td>
                  {can('field_reps') && (
                    <button className="link" onClick={() => setEditing(r)}>
                      Modifier
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <RepDialog rep={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), list.reload())} />}
    </>
  );
}

function RepDialog({ rep, onClose, onSaved }: { rep: Rep | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const places = useLoad(() => call('fieldReps.places'), []);
  const [f, setF] = useState({ name: rep?.name ?? '', phone: rep?.phone ?? '', zone: rep?.zone ?? '', city: rep?.city ?? '', active: rep ? rep.active === 1 : true });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await call('fieldReps.save', { name: f.name, phone: f.phone || null, zone: f.zone, city: f.city, active: f.active }, rep?.id ?? null);
      toast.ok('Commercial enregistré');
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={rep ? rep.name : 'Nouveau commercial de terrain'} onClose={onClose}>
      <form onSubmit={save}>
        <div className="grid2">
          <Field label="Nom">
            <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Téléphone">
            <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <Field label="Ville">
            <input list="rep-cities" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} placeholder="DOUALA" />
          </Field>
          <Field label="Zone" hint={rep ? 'Changer de zone ne déplace pas les ventes déjà faites' : undefined}>
            <input list="rep-zones" value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })} placeholder="BONAMOUSSADI" />
          </Field>
        </div>
        <datalist id="rep-cities">
          {(places.data?.cities ?? []).map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <datalist id="rep-zones">
          {(places.data?.zones ?? []).map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        {rep && (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Actif
          </label>
        )}
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
