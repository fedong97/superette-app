import { useState } from 'react';
import { LABEL_FORMATS, type LabelFormatId } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, askConfirm, dateFr, dateTime, fcfa, parseAmount, useCan, useLoad, useToast } from '../ui';
import { ArticlePicker } from './pickers';

type Schedule = Result<'priceSchedules.list'>[number];

const STATUS: Record<Schedule['status'], [string, string]> = {
  pending: ['à venir', 'alerte'],
  applied: ['appliqué', 'normal'],
  cancelled: ['annulé', ''],
};

const tomorrow = () => {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Prix programmés : une hausse ou une baisse préparée à l'avance, appliquée
 * seule à sa date. La veille, les étiquettes aux nouveaux prix s'impriment pour
 * être posées le matin.
 */
export function PriceSchedules() {
  const toast = useToast();
  const can = useCan();
  const list = useLoad(() => call('priceSchedules.list'), []);
  const next = useLoad(() => call('priceSchedules.tomorrow'), []);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [format, setFormat] = useState<LabelFormatId>('a4_24');
  const printLabels = () => call('priceSchedules.labelsPrint', format, next.data?.day).then((ok) => ok && toast.ok('Étiquettes envoyées à l’imprimante'), toast.error);
  return (
    <>
      <div className="filters">
        <span className="muted">Faites une hausse ou une baisse en masse depuis « Mise à jour des prix » et choisissez une date, ou programmez un prix article par article.</span>
        {can('price_schedule') && (
          <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            Nouveau prix à une date
          </button>
        )}
      </div>
      {Boolean(next.data?.count) && (
        <section className="card">
          <h3>
            Demain {dateFr(next.data!.day)} : {next.data!.count} prix changent
          </h3>
          <p className="muted">Imprimez les étiquettes ce soir et posez-les demain matin : la caisse prendra les nouveaux prix toute seule.</p>
          <div className="filters">
            <select value={format} onChange={(e) => setFormat(e.target.value as LabelFormatId)}>
              {(Object.keys(LABEL_FORMATS) as LabelFormatId[]).map((f) => (
                <option key={f} value={f}>
                  {LABEL_FORMATS[f].name}
                </option>
              ))}
            </select>
            <button onClick={() => void printLabels()}>Imprimer les étiquettes aux nouveaux prix</button>
          </div>
        </section>
      )}
      {list.data?.length === 0 ? (
        <Empty>Aucun prix programmé.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date d'application</th>
              <th>Changement</th>
              <th className="r">Articles</th>
              <th>Magasin</th>
              <th>Préparé par</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((p) => (
              <tr key={p.id} className="clickable" onClick={() => setOpen(p.id)}>
                <td>{dateFr(p.effective_on)}</td>
                <td>{p.label}</td>
                <td className="r">{p.articles}</td>
                <td>{p.store_name}</td>
                <td>
                  {p.user_name} <small className="muted">{dateTime(p.created_at)}</small>
                </td>
                <td>
                  <span className={`tag ${STATUS[p.status][1]}`}>{STATUS[p.status][0]}</span>
                </td>
                <td className="r" onClick={(e) => e.stopPropagation()}>
                  {p.status === 'pending' && can('price_schedule') && (
                    <button
                      className="danger"
                      onClick={async () => {
                        if (!(await askConfirm(`Annuler « ${p.label} » ? Les prix ne changeront pas le ${dateFr(p.effective_on)}.`))) return;
                        call('priceSchedules.cancel', p.id).then(list.reload, toast.error);
                      }}
                    >
                      Annuler
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <ScheduleDetail id={open} onClose={() => setOpen(null)} />}
      {creating && <FixedPriceDialog onClose={() => setCreating(false)} onDone={() => (setCreating(false), list.reload(), next.reload())} />}
    </>
  );
}

function ScheduleDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useLoad(() => call('priceSchedules.get', id), [id]);
  if (!d.data) return null;
  return (
    <Modal title={`${d.data.label} · le ${dateFr(d.data.effective_on)}`} onClose={onClose} wide>
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table className="list compact">
          <thead>
            <tr>
              <th>Article</th>
              <th>Niveau</th>
              <th className="r">Avant</th>
              <th className="r">Après</th>
            </tr>
          </thead>
          <tbody>
            {d.data.plan.articles.flatMap((a) =>
              a.lines.map((l, i) => (
                <tr key={`${a.articleId}-${i}`}>
                  <td>{i === 0 ? `${a.code} · ${a.name}` : ''}</td>
                  <td>{l.level}</td>
                  <td className="r">{fcfa(l.old)}</td>
                  <td className={`r ${l.next < l.old ? 'neg' : ''}`}>{fcfa(l.next)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button onClick={onClose}>Fermer</button>
      </div>
    </Modal>
  );
}

/** Nouveaux prix de vente fixés article par article, pour une date. */
function FixedPriceDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [day, setDay] = useState(tomorrow());
  const [rows, setRows] = useState<{ id: string; name: string; old: number; price: string }[]>([]);
  const submit = async () => {
    const prices = rows.map((r) => ({ articleId: r.id, salePrice: parseAmount(r.price) ?? 0 }));
    try {
      await call('priceSchedules.create', { label: label || `Nouveaux prix du ${dateFr(day)}`, effectiveOn: day, prices });
      toast.ok(`Prix programmés pour le ${dateFr(day)}`);
      onDone();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title="Nouveau prix à une date" onClose={onClose} wide>
      <div className="grid2">
        <Field label="Nom du changement">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Hausse du sucre" />
        </Field>
        <Field label="Appliqué le">
          <input type="date" min={tomorrow()} value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
      </div>
      <ArticlePicker
        placeholder="Ajouter un article : scanner ou rechercher"
        onPick={(a) => !rows.some((r) => r.id === a.id) && setRows([...rows, { id: a.id, name: a.name, old: a.store_price, price: '' }])}
      />
      {rows.length > 0 && (
        <table className="list compact">
          <thead>
            <tr>
              <th>Article</th>
              <th className="r">Prix actuel</th>
              <th>Nouveau prix</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="r">{fcfa(r.old)}</td>
                <td>
                  <input inputMode="numeric" className="qty" value={r.price} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                </td>
                <td>
                  <button className="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={!rows.length || rows.some((r) => !parseAmount(r.price))} onClick={() => void submit()}>
          Programmer
        </button>
      </div>
    </Modal>
  );
}
