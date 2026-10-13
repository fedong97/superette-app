import { useState } from 'react';
import { PAYMENT_METHODS } from '@superette/core';
import { call } from '../api';
import { askConfirm, Field, Modal, dateTime, fcfa, parseAmount, today, useLoad, useToast } from '../ui';

const METHODS = ['MTN_MOMO', 'ORANGE_MONEY'] as const;
type Method = (typeof METHODS)[number] | 'CARD';
type Nature = 'register' | 'bank' | 'owner' | 'other';

const NATURES: Record<'IN' | 'OUT', [Nature, string][]> = {
  IN: [
    ['bank', 'Retrait de la banque vers le compte'],
    ['owner', "Apport de l'exploitant"],
    ['other', 'Autre entrée (solde de départ…)'],
  ],
  OUT: [
    ['register', 'Transfert vers une autre caisse électronique'],
    ['bank', 'Dépôt à la banque'],
    ['owner', "Retrait de l'exploitant"],
    ['other', "Autre sortie (frais de l'opérateur…)"],
  ],
};

/**
 * Caisses électroniques : solde de chacune par moyen (la centrale en premier),
 * et le livre de la caisse choisie : versements reçus des caissiers, dépenses et
 * fournisseurs payés au bureau, transferts, dépôts à la banque.
 */
export function EmoneyCentral({ onSettings }: { onSettings?: () => void }) {
  const toast = useToast();
  const [registerId, setRegisterId] = useState<string | null>(null);
  const [from, setFrom] = useState(() => `${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today());
  const [dialog, setDialog] = useState<'IN' | 'OUT' | null>(null);
  const state = useLoad(() => call('emoney.state', registerId, { from, to }), [registerId, from, to]);
  const d = state.data;
  if (!d) return null;
  const shown = d.registers.find((r) => r.id === d.registerId);
  const rows = d.ledger?.rows ?? [];
  const print = (id: string) => call('emoney.print', id).catch(toast.error);

  return (
    <div className="emoney-central">
      {d.mode === 'central' && !d.centralId && (
        <p className="warn-text">
          Aucune caisse électronique centrale n'est choisie : les caissiers ne peuvent pas y verser leur recette.{' '}
          {onSettings && (
            <button className="link" onClick={onSettings}>
              Choisir la centrale dans les paramètres
            </button>
          )}
        </p>
      )}
      {d.mode === 'independent' && <p className="muted">Caisses indépendantes : chaque caisse électronique garde son solde d'un jour à l'autre.</p>}
      <table className="list compact emoney-balances">
        <thead>
          <tr>
            <th>Caisse électronique</th>
            <th>Caissier</th>
            <th>Journée</th>
            {METHODS.map((m) => (
              <th key={m} className="r">
                {PAYMENT_METHODS[m]}
              </th>
            ))}
            <th className="r">Total</th>
          </tr>
        </thead>
        <tbody>
          {d.registers.map((r) => (
            <tr key={r.id} className={`clickable ${r.id === d.registerId ? 'selected' : ''}`} onClick={() => setRegisterId(r.id)}>
              <td>
                <strong>{r.name}</strong>
                {r.central && <span className="tag kind-electronic">Centrale</span>}
              </td>
              <td>{r.central ? '—' : (r.holder ?? <span className="muted">non attribuée</span>)}</td>
              <td className={`tre-state ${r.open ? 'open' : 'closed'}`}>{r.central ? '' : r.open ? 'Ouverte' : 'Fermée'}</td>
              {METHODS.map((m) => (
                <td key={m} className={`r ${(r.balance[m] ?? 0) < 0 ? 'neg' : ''}`}>
                  {fcfa(r.balance[m] ?? 0)}
                </td>
              ))}
              <td className="r">
                <b>{fcfa(METHODS.reduce((t, m) => t + (r.balance[m] ?? 0), 0))}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Caisse ouverte : solde attendu en ce moment. Caisse fermée : reste laissé à la clôture et mouvements depuis.</p>

      <div className="tre-bar">
        <h3>Livre de {shown?.name ?? '…'}</h3>
        <span className="spacer" />
        Du <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /> au <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {d.canRecord && shown && (
          <>
            <button onClick={() => setDialog('IN')}>Entrée…</button>
            <button onClick={() => setDialog('OUT')}>Sortie ou transfert…</button>
          </>
        )}
      </div>
      <div className="tre-scroll tall">
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Pièce</th>
              <th>Nature</th>
              <th>Libellé</th>
              <th>Caisse ou tiers</th>
              <th>Moyen</th>
              <th>Référence</th>
              <th>Par</th>
              <th className="r">Entrée</th>
              <th className="r">Sortie</th>
              <th className="r">Solde du moyen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.source}-${r.id}`}>
                <td>{dateTime(r.at)}</td>
                <td>{r.number}</td>
                <td>{r.nature}</td>
                <td>{r.label}</td>
                <td>{r.party ?? ''}</td>
                <td>{r.method_label}</td>
                <td>{r.reference ?? ''}</td>
                <td>{r.user_name ?? ''}</td>
                <td className="r">{r.signed > 0 ? fcfa(r.signed) : ''}</td>
                <td className="r">{r.signed < 0 ? fcfa(-r.signed) : ''}</td>
                <td className={`r ${r.balance < 0 ? 'neg' : ''}`}>{fcfa(r.balance)}</td>
                <td>
                  {r.source === 'movement' && (
                    <button className="link" onClick={() => print(r.id)}>
                      Bon
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={12} className="muted">
                  Aucun mouvement sur la période. Les ventes et dépenses d'une journée de caissier sont dans sa journée (Opérations journalières).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {dialog && shown && (
        <EmoneyMoveDialog
          direction={dialog}
          register={shown}
          others={d.registers.filter((r) => r.id !== shown.id)}
          onClose={() => setDialog(null)}
          onDone={async (id) => {
            setDialog(null);
            state.reload();
            if (await askConfirm('Imprimer le bon ?')) print(id);
          }}
        />
      )}
    </div>
  );
}

function EmoneyMoveDialog({
  direction,
  register,
  others,
  onClose,
  onDone,
}: {
  direction: 'IN' | 'OUT';
  register: { id: string; name: string; balance: Record<string, number> };
  others: { id: string; name: string; central: boolean }[];
  onClose: () => void;
  onDone: (movementId: string) => void;
}) {
  const toast = useToast();
  const [nature, setNature] = useState<Nature>(NATURES[direction][0]![0]);
  const [method, setMethod] = useState<Method>('MTN_MOMO');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [label, setLabel] = useState('');
  const [toId, setToId] = useState(others[0]?.id ?? '');
  const value = parseAmount(amount);
  const needsRef = nature !== 'other';
  return (
    <Modal title={`${direction === 'IN' ? 'Entrée sur' : 'Sortie de'} ${register.name}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const m = await call('emoney.record', { registerId: register.id, direction, nature, method, amount: value ?? 0, reference, label, toRegisterId: nature === 'register' ? toId : null });
            toast.ok('Mouvement enregistré');
            onDone(m.id);
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Nature">
          <select value={nature} onChange={(e) => setNature(e.target.value as Nature)}>
            {NATURES[direction].map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {nature === 'register' && (
          <Field label="Vers la caisse électronique">
            <select value={toId} onChange={(e) => setToId(e.target.value)}>
              {others.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.central ? ' (centrale)' : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Moyen">
          <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            {[...METHODS, ...(nature === 'bank' && direction === 'OUT' ? (['CARD'] as const) : [])].map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHODS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Montant (FCFA)" hint={direction === 'OUT' ? `Solde ${PAYMENT_METHODS[method]} : ${fcfa(register.balance[method] ?? 0)}` : undefined}>
          <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label={`Référence de la transaction${needsRef ? '' : ' (facultatif)'}`}>
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Libellé (facultatif)">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Bordereau n°, motif…" />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!value || (needsRef && !reference.trim()) || (nature === 'register' && !toId)}>
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}
