import { useState } from 'react';
import { DISCOUNT_REASONS } from '@superette/core';
import { type Result, call } from '../api';
import { Field, Modal, SupervisorPrompt, askConfirm, dateTime, fcfa, parseAmount, useLoad, useToast } from '../ui';

export type Outage = NonNullable<Result<'outages.current'>>;
export type PromoApplied = Result<'promoCodes.check'>;

/** Motif d'une remise : la liste de la caisse, et une précision libre pour « Autre ». */
export function ReasonPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = (DISCOUNT_REASONS as readonly string[]).includes(value);
  const [choice, setChoice] = useState(known ? value : value ? 'Autre' : '');
  const [other, setOther] = useState(known ? '' : value.replace(/^Autre : /, ''));
  const pick = (c: string, o = other) => {
    setChoice(c);
    onChange(c === 'Autre' ? (o.trim() ? `Autre : ${o.trim()}` : 'Autre') : c);
  };
  return (
    <>
      <Field label="Motif de la remise">
        <select value={choice} onChange={(e) => pick(e.target.value)}>
          <option value="">Choisir…</option>
          {DISCOUNT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>
      {choice === 'Autre' && (
        <Field label="Précisez">
          <input
            value={other}
            maxLength={100}
            onChange={(e) => {
              setOther(e.target.value);
              pick('Autre', e.target.value);
            }}
          />
        </Field>
      )}
    </>
  );
}

/** Le serveur demande le motif des remises du ticket : on le choisit, puis la vente repart. */
export function ReasonDialog({ onClose, onDone }: { onClose: () => void; onDone: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="Motif de la remise" onClose={onClose}>
      <p className="muted">Le ticket comporte une remise : choisissez pourquoi. Le gérant le retrouve dans le contrôle des caissiers.</p>
      <ReasonPicker value={reason} onChange={setReason} />
      <div className="actions">
        <button className="ghost" onClick={onClose}>
          Annuler
        </button>
        <button className="primary" disabled={!reason} onClick={() => onDone(reason)}>
          Valider
        </button>
      </div>
    </Modal>
  );
}

/** Code de réduction donné par le client : vérifié tout de suite (dates, minimum, une fois par client). */
export function PromoCodeDialog({
  subtotal,
  customerId,
  current,
  onClose,
  onApply,
}: {
  subtotal: number;
  customerId: string | null;
  current: PromoApplied | null;
  onClose: () => void;
  onApply: (p: PromoApplied | null) => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState(current?.code ?? '');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const p = await call('promoCodes.check', code, subtotal, customerId);
      toast.ok(`Code ${p.code} : ${p.label}, remise de ${fcfa(p.amount)}`);
      onApply(p);
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title="Code de réduction" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Code donné par le client" hint="Reçu par WhatsApp, sur un flyer… La remise s'applique au ticket entier, après les promotions.">
          <input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="NOEL25" />
        </Field>
        <div className="actions">
          {current && (
            <button type="button" onClick={() => onApply(null)}>
              Retirer le code
            </button>
          )}
          <button type="button" className="ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="primary" disabled={code.trim().length < 3}>
            Appliquer
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Heure locale « AAAA-MM-JJTHH:MM » pour un champ datetime-local. */
export const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Ventes pendant une coupure : on déclare la coupure avec le total noté sur le
 * cahier, on saisit les ventes une à une, puis on clôture ; ONIX compare.
 */
export function OutageDialog({
  current,
  canClose,
  onClose,
  onChanged,
  onEnter,
}: {
  current: Outage | null;
  canClose: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** Passe la caisse en saisie des ventes de la coupure. */
  onEnter: (o: Outage) => void;
}) {
  const toast = useToast();
  const now = new Date();
  const [start, setStart] = useState(localInput(new Date(now.getTime() - 2 * 3_600_000).toISOString()));
  const [end, setEnd] = useState(localInput(now.toISOString()));
  const [total, setTotal] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState(false);

  const declare = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const o = await call('outages.declare', { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), declaredTotal: parseAmount(total) ?? 0, note: note || null });
      toast.ok(`Coupure n° ${o.number} déclarée : saisissez maintenant les ventes du cahier`);
      onChanged();
      onEnter(o);
    } catch (err) {
      toast.error(err);
    }
  };
  const close = async (supervisorPin?: string) => {
    if (!current) return;
    try {
      const o = await call('outages.close', current.id, { reason: reason || null, supervisorPin });
      setPin(false);
      toast.ok(o.gap === 0 ? `Coupure n° ${o.number} clôturée : les ventes saisies correspondent au cahier` : `Coupure n° ${o.number} clôturée avec un écart de ${fcfa(o.gap)}`);
      onChanged();
      onClose();
    } catch (err) {
      if ((err as { code?: string }).code === 'SUPERVISOR_REQUIRED' && !supervisorPin) setPin(true);
      else toast.error(err);
    }
  };
  const cancel = async () => {
    if (!current || !(await askConfirm(`Annuler la coupure n° ${current.number} ? Aucune vente n'y est saisie.`))) return;
    try {
      await call('outages.cancel', current.id);
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err);
    }
  };

  if (current)
    return (
      <Modal title={`Coupure n° ${current.number}`} onClose={onClose}>
        <p className="muted">
          Du {dateTime(current.started_at)} au {dateTime(current.ended_at)}
          {current.note ? ` · ${current.note}` : ''}
        </p>
        <table className="table">
          <tbody>
            <tr>
              <td>Total noté sur le cahier</td>
              <td className="r">{fcfa(current.declared_total)}</td>
            </tr>
            <tr>
              <td>Ventes saisies ({current.sales})</td>
              <td className="r">{fcfa(current.entered_total)}</td>
            </tr>
            <tr>
              <td>
                <strong>{current.gap > 0 ? 'Reste à saisir' : current.gap < 0 ? 'Saisi en trop' : 'Écart'}</strong>
              </td>
              <td className="r">
                <strong className={current.gap ? 'neg' : ''}>{fcfa(Math.abs(current.gap))}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        {current.gap !== 0 && current.sales > 0 && (
          <Field label="Motif de l'écart (pour clôturer quand même)" hint={canClose ? undefined : "Le code du gérant sera demandé."}>
            <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Ticket illisible, erreur d'addition sur le cahier…" />
          </Field>
        )}
        <div className="actions">
          {current.sales === 0 && (
            <button className="danger" onClick={() => void cancel()}>
              Annuler la coupure
            </button>
          )}
          <button disabled={current.sales === 0} onClick={() => void close()}>
            Clôturer la coupure
          </button>
          <button className="primary" onClick={() => (onEnter(current), onClose())}>
            Saisir les ventes
          </button>
        </div>
        {pin && <SupervisorPrompt action={`Clôturer la coupure n° ${current.number} avec un écart de ${fcfa(current.gap)}`} onCancel={() => setPin(false)} onConfirm={(p) => void close(p)} />}
      </Modal>
    );
  return (
    <Modal title="Ventes pendant une coupure" onClose={onClose}>
      <p className="muted">
        Le PC était éteint (coupure de courant, panne) et vous avez noté les ventes sur un cahier. Déclarez la coupure avec le total du cahier, puis saisissez chaque vente : ONIX vérifie que tout est bien saisi.
      </p>
      <form onSubmit={declare}>
        <div className="grid2">
          <Field label="Début de la coupure">
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Fin de la coupure">
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Total des ventes noté sur le cahier">
          <input autoFocus inputMode="numeric" value={total} onChange={(e) => setTotal(e.target.value)} />
        </Field>
        <Field label="Remarque (facultatif)">
          <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Coupure ENEO, onduleur en panne…" />
        </Field>
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="primary" disabled={!parseAmount(total)}>
            Déclarer et saisir les ventes
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Commercial de terrain de la vente (vide : celui qui suit le client, s'il y en a un). */
export function FieldRepSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const reps = useLoad(() => call('fieldReps.list'), []);
  if (!reps.data?.length) return null;
  return (
    <Field label="Commercial de terrain" hint="Vide : le commercial qui suit le client. La vente garde sa zone et sa ville du jour.">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {reps.data.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} ({r.city} › {r.zone})
          </option>
        ))}
      </select>
    </Field>
  );
}
