import { useState } from 'react';
import { call } from '../api';
import { Field, Modal, fcfa, parseAmount, today, useToast } from '../ui';

type Party = 'customer' | 'supplier';

/** Sens du solde, dans les mots du tiers : ce que le client doit, ce qu'on doit au fournisseur. */
const SIDES: Record<Party, { plus: string; minus: string }> = {
  customer: { plus: 'Il me doit', minus: 'Il a une avance (je lui dois)' },
  supplier: { plus: 'Je lui dois', minus: 'Il me doit (avance ou avoir)' },
};

/** Montant signé saisi en deux temps : la somme, puis le sens. */
export interface OpeningDraft {
  amount: string;
  side: 'plus' | 'minus';
}
export const EMPTY_OPENING: OpeningDraft = { amount: '', side: 'plus' };
export const signedOpening = (d: OpeningDraft): number => {
  const v = parseAmount(d.amount) ?? 0;
  return d.side === 'plus' ? v : -v;
};

/** Champ « Solde d'ouverture » de la fiche d'un nouveau client ou fournisseur. */
export function OpeningField({ party, value, onChange }: { party: Party; value: OpeningDraft; onChange: (v: OpeningDraft) => void }) {
  return (
    <fieldset className="opening-field">
      <legend>Solde d'ouverture</legend>
      <div className="grid2">
        <Field label="Montant (FCFA)" hint="Laissez vide s'il n'y a rien à reprendre">
          <input inputMode="numeric" className="r" value={value.amount} onChange={(e) => onChange({ ...value, amount: e.target.value })} />
        </Field>
        <Field label="Sens">
          <select value={value.side} onChange={(e) => onChange({ ...value, side: e.target.value as OpeningDraft['side'] })}>
            <option value="plus">{SIDES[party].plus}</option>
            <option value="minus">{SIDES[party].minus}</option>
          </select>
        </Field>
      </div>
    </fieldset>
  );
}

/** Enregistre le solde d'ouverture d'une fiche qui vient d'être créée (rien si le montant est vide). */
export async function saveOpening(party: Party, id: string, d: OpeningDraft): Promise<boolean> {
  const amount = signedOpening(d);
  if (!amount) return false;
  await call(party === 'customer' ? 'customers.adjustBalance' : 'suppliers.adjustBalance', id, { amount, kind: 'opening' });
  return true;
}

/**
 * « Ajuster le solde » d'un compte client ou fournisseur : solde d'ouverture oublié
 * à la création, ou correction avec son motif. La pièce reste dans le relevé.
 */
export function BalanceDialog({ party, id, name, balance, onClose, onDone }: { party: Party; id: string; name: string; balance: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<'adjustment' | 'opening'>('adjustment');
  const [draft, setDraft] = useState<OpeningDraft>(EMPTY_OPENING);
  const [label, setLabel] = useState('');
  const [date, setDate] = useState(today());
  const amount = signedOpening(draft);
  const ready = amount !== 0 && (kind === 'opening' || label.trim());
  const side = party === 'customer' ? { plus: 'Augmenter ce qu’il doit', minus: 'Diminuer ce qu’il doit' } : { plus: 'Augmenter ce qu’on lui doit', minus: 'Diminuer ce qu’on lui doit' };
  return (
    <Modal title={`Ajuster le solde : ${name}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call(party === 'customer' ? 'customers.adjustBalance' : 'suppliers.adjustBalance', id, { amount, kind, label: label.trim() || null, date });
            toast.ok(kind === 'opening' ? "Solde d'ouverture enregistré" : 'Solde ajusté');
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <p className="muted">
          Solde actuel : <b>{fcfa(balance)}</b>. Après : <b>{fcfa(balance + amount)}</b>.
        </p>
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="adjustment">Ajustement de solde (correction, avec motif)</option>
            <option value="opening">Solde d'ouverture (ce qui était dû avant ONIX 360)</option>
          </select>
        </Field>
        <div className="grid2">
          <Field label="Montant (FCFA)">
            <input autoFocus inputMode="numeric" className="r" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
          </Field>
          <Field label="Sens">
            <select value={draft.side} onChange={(e) => setDraft({ ...draft, side: e.target.value as OpeningDraft['side'] })}>
              <option value="plus">{kind === 'opening' ? SIDES[party].plus : side.plus}</option>
              <option value="minus">{kind === 'opening' ? SIDES[party].minus : side.minus}</option>
            </select>
          </Field>
        </div>
        <div className="grid2">
          <Field label={kind === 'opening' ? 'Note (facultative)' : 'Motif'}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Date de la pièce">
            <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <p className="muted small">La pièce apparaît dans le relevé du compte et passe en comptabilité contre le compte d’attente 4711.</p>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Fermer
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}
