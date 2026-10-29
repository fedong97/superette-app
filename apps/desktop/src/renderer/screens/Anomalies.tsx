import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, dateTime, qty, useLoad, useToast } from '../ui';

type Case = Result<'anomalies.list'>[number];

const KIND_LABEL: Record<Case['kind'], string> = {
  duplicate_reception: 'Réception en double',
  lasting_negative: 'Stock négatif',
  sold_never_received: 'Vendu sans réception',
  drift: 'Stock ≠ mouvements',
};

/**
 * Anomalies de stock à vérifier : ONIX trouve les cas douteux, le gérant
 * décide. La correction passe par une correction de stock signée ; le cas
 * laissé tel quel garde son motif. Rien n'efface l'historique.
 */
export function Anomalies() {
  const [tab, setTab] = useState<'cases' | 'log'>('cases');
  const cases = useLoad(() => call('anomalies.list'), []);
  const log = useLoad(() => (tab === 'log' ? call('anomalies.decisions') : Promise.resolve([])), [tab]);
  const [open, setOpen] = useState<Case | null>(null);
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['cases', `À vérifier${cases.data?.length ? ` (${cases.data.length})` : ''}`],
          ['log', 'Décisions prises'],
        ]}
      />
      {tab === 'cases' &&
        (cases.data && cases.data.length === 0 ? (
          <Empty mood="bravo">Aucun cas douteux : réceptions, stocks négatifs et mouvements sont cohérents.</Empty>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Cas</th>
                <th>Ce qu'on voit</th>
                <th>Depuis</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(cases.data ?? []).map((c) => (
                <tr key={c.key}>
                  <td>
                    <span className="tag alerte">{KIND_LABEL[c.kind]}</span> <strong>{c.title}</strong>
                  </td>
                  <td>{c.facts}</td>
                  <td>{c.since ? dateTime(c.since) : ''}</td>
                  <td>
                    <button onClick={() => setOpen(c)}>Décider</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {tab === 'log' && (
        <table className="list">
          <thead>
            <tr>
              <th>Le</th>
              <th>Cas</th>
              <th>Décision</th>
              <th>Article</th>
              <th className="r">Avant</th>
              <th className="r">Après</th>
              <th>Motif</th>
              <th>Par</th>
            </tr>
          </thead>
          <tbody>
            {(log.data ?? []).map((d) => (
              <tr key={d.id}>
                <td>{dateTime(d.created_at)}</td>
                <td>{KIND_LABEL[d.kind]}</td>
                <td>{d.decision === 'fixed' ? 'Corrigé' : 'Laissé tel quel'}</td>
                <td>{d.article_name ?? ''}</td>
                <td className="r">{d.before_qty === null ? '' : qty(d.before_qty)}</td>
                <td className="r">{d.after_qty === null ? '' : qty(d.after_qty)}</td>
                <td>{d.note ?? ''}</td>
                <td>{d.user_name ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <DecideDialog c={open} onClose={() => setOpen(null)} onDone={() => (setOpen(null), cases.reload(), log.reload())} />}
    </>
  );
}

function DecideDialog({ c, onClose, onDone }: { c: Case; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'fixed' | 'ignored') => {
    setBusy(true);
    try {
      await call('anomalies.decide', c.key, decision, note || null);
      toast.ok(decision === 'fixed' ? 'Correction faite et gardée dans le journal' : 'Cas laissé tel quel, avec votre motif');
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={c.title} onClose={onClose} wide>
      <p>{c.facts}</p>
      <p className="muted">{c.advice}</p>
      {c.fix && (
        <>
          <h3>{c.fix.label}</h3>
          <table className="list">
            <thead>
              <tr>
                <th>Article</th>
                <th>Dépôt</th>
                <th className="r">Stock actuel</th>
                <th className="r">Après correction</th>
              </tr>
            </thead>
            <tbody>
              {c.fix.lines.map((l) => (
                <tr key={`${l.article_id}|${l.warehouse_id}`}>
                  <td>{l.article_name}</td>
                  <td>{l.warehouse_name}</td>
                  <td className="r">{qty(l.before)}</td>
                  <td className="r">
                    <strong>{qty(l.after)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <Field label="Motif ou remarque" hint="Obligatoire pour laisser le cas tel quel.">
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="actions">
        <button className="ghost" onClick={onClose}>
          Plus tard
        </button>
        <button disabled={busy || !note.trim()} onClick={() => void decide('ignored')}>
          {c.fix ? 'Laisser tel quel' : "C'est vu"}
        </button>
        {c.fix && (
          <button className="primary" disabled={busy} onClick={() => void decide('fixed')}>
            Corriger
          </button>
        )}
      </div>
    </Modal>
  );
}
