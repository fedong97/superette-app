import { type StoreSettings } from '@superette/core';
import { useState } from 'react';
import { call } from '../api';
import { fcfa, useLoad, useToast } from '../ui';

type NumKey = { [K in keyof StoreSettings]: StoreSettings[K] extends number ? K : never }[keyof StoreSettings];
type BoolKey = { [K in keyof StoreSettings]: StoreSettings[K] extends boolean ? K : never }[keyof StoreSettings];

/** Une règle : le réglage, ce qu'il change dans la journée et la valeur conseillée. */
type Rule =
  | { key: NumKey; kind: 'num'; unit: 'FCFA' | '%' | 'min' | 'j' | 'fois' | 'factures'; label: string; why: string; advised: number }
  | { key: BoolKey; kind: 'bool'; label: string; why: string; advised: boolean };

/** Les règles qui changent vraiment la journée du magasin (0.107.0), groupées par moment. */
const RULES: [string, Rule[]][] = [
  [
    'À la caisse',
    [
      { key: 'maxDiscountPct', kind: 'num', unit: '%', label: 'Remise sans le code du gérant', why: 'Au-delà, le vendeur demande le code ou l’accord par téléphone.', advised: 5 },
      { key: 'discountReasonRequired', kind: 'bool', label: 'Motif obligatoire pour une remise', why: 'Vous savez ensuite pourquoi chaque remise a été faite.', advised: true },
      { key: 'cancelMinutes', kind: 'num', unit: 'min', label: 'Délai pour annuler une vente', why: 'Passé ce délai, on fait un retour (0 : sans limite).', advised: 30 },
      { key: 'maxHeld', kind: 'num', unit: 'factures', label: 'Factures en attente par caisse', why: 'Évite les paniers oubliés en fin de journée (0 : sans limite).', advised: 5 },
      { key: 'allowBelowCost', kind: 'bool', label: 'Vendre sous le prix de revient', why: 'Toujours avec le code du gérant ; mieux vaut le laisser fermé.', advised: false },
      { key: 'customerRequiredAbove', kind: 'num', unit: 'FCFA', label: 'Nom du client obligatoire au-delà de', why: 'Pour les gros tickets : facture nominative et suivi (0 : jamais).', advised: 100000 },
    ],
  ],
  [
    'L’argent',
    [
      { key: 'cashCeiling', kind: 'num', unit: 'FCFA', label: 'Plafond d’espèces dans le tiroir', why: 'Au-delà, alerte et prélèvement proposé vers la caisse centrale (0 : pas de plafond).', advised: 200000 },
      { key: 'expenseApprovalAbove', kind: 'num', unit: 'FCFA', label: 'Dépense à approuver au-delà de', why: 'Une dépense saisie par un employé attend votre accord (0 : jamais).', advised: 10000 },
      { key: 'expenseProofRequired', kind: 'bool', label: 'Justificatif obligatoire pour approuver', why: 'Photo de la facture ou fiche signée jointe à la dépense.', advised: true },
    ],
  ],
  [
    'Le crédit',
    [
      { key: 'creditDefaultLimit', kind: 'num', unit: 'FCFA', label: 'Plafond de crédit d’un nouveau client', why: '0 : pas de crédit tant que vous ne l’avez pas accordé.', advised: 0 },
      { key: 'creditDefaultDays', kind: 'num', unit: 'j', label: 'Délai de paiement d’un nouveau client', why: 'Date d’échéance proposée sur les ventes à crédit.', advised: 30 },
      { key: 'creditBlockLate', kind: 'bool', label: 'Refuser le crédit au client en retard', why: 'Pas de nouvelle vente à crédit tant qu’une facture échue n’est pas payée.', advised: true },
    ],
  ],
  [
    'Le stock',
    [
      { key: 'expiryAlertDays', kind: 'num', unit: 'j', label: 'Alerte avant la péremption', why: 'Les lots qui périment dans ce délai sont signalés.', advised: 30 },
      { key: 'transferTwoUsers', kind: 'bool', label: 'Transfert reçu par une autre personne', why: 'Celui qui expédie ne valide pas lui-même la réception.', advised: true },
    ],
  ],
  [
    'La sécurité',
    [
      { key: 'idleMinutes', kind: 'num', unit: 'min', label: 'Déconnexion après inactivité', why: 'Une caisse laissée ouverte se verrouille (0 : jamais).', advised: 15 },
      { key: 'maxLoginAttempts', kind: 'num', unit: 'fois', label: 'Blocage après des codes faux', why: '15 minutes de blocage après ce nombre d’essais (0 : jamais).', advised: 5 },
    ],
  ],
];

const show = (r: Rule, v: number | boolean) => (r.kind === 'bool' ? (v ? 'Oui' : 'Non') : r.unit === 'FCFA' ? (v ? fcfa(Number(v)) : 'Non') : `${v} ${r.unit}`);

/**
 * Règles de mon magasin (0.107.0) : les quinze réglages qui changent la
 * journée, avec la valeur conseillée à côté. Les autres réglages restent dans
 * Paramètres.
 */
export function StoreRules({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const store = useLoad(() => call('admin.storeSettings'));
  const [draft, setDraft] = useState<Partial<StoreSettings>>({});
  const s = store.data;
  if (!s) return null;
  const value = (r: Rule) => (draft[r.key] ?? s[r.key]) as number | boolean;
  const set = (r: Rule, v: number | boolean) => setDraft({ ...draft, [r.key]: v });
  const all = RULES.flatMap(([, rules]) => rules);
  const apart = all.filter((r) => value(r) !== r.advised).length;
  const save = async () => {
    try {
      await call('admin.saveStoreSettings', draft);
      setDraft({});
      store.reload();
      onChanged();
      toast.ok('Règles enregistrées');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="store-rules">
      <p className="muted">
        Les réglages qui changent la journée du magasin, avec la valeur que nous conseillons pour une supérette. {apart ? `${apart} règle${apart > 1 ? 's' : ''} différente${apart > 1 ? 's' : ''} du conseil.` : 'Toutes vos règles suivent le conseil.'} Le reste est dans Paramètres.
      </p>
      {RULES.map(([title, rules]) => (
        <section key={title} className="card">
          <h2>{title}</h2>
          <table className="list rules-table">
            <thead>
              <tr>
                <th>Règle</th>
                <th>Chez vous</th>
                <th>Conseillé</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const v = value(r);
                return (
                  <tr key={r.key} className={v === r.advised ? '' : 'rule-apart'}>
                    <td>
                      <strong>{r.label}</strong>
                      <br />
                      <small className="muted">{r.why}</small>
                    </td>
                    <td>
                      {r.kind === 'bool' ? (
                        <select disabled={!canEdit} value={v ? '1' : '0'} onChange={(e) => set(r, e.target.value === '1')}>
                          <option value="1">Oui</option>
                          <option value="0">Non</option>
                        </select>
                      ) : (
                        <span className="inline">
                          <input
                            className="qty"
                            inputMode="numeric"
                            disabled={!canEdit}
                            value={String(v)}
                            onChange={(e) => set(r, Number(e.target.value.replace(/\D/g, '') || 0))}
                          />
                          <span className="muted">{r.unit}</span>
                        </span>
                      )}
                    </td>
                    <td>{show(r, r.advised)}</td>
                    <td>
                      {canEdit && v !== r.advised && (
                        <button type="button" onClick={() => set(r, r.advised)}>
                          Prendre le conseil
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
      {canEdit ? (
        <div className="actions">
          <button className="primary" disabled={!Object.keys(draft).length} onClick={() => void save()}>
            Enregistrer
          </button>
          {Object.keys(draft).length > 0 && <button onClick={() => setDraft({})}>Annuler les changements</button>}
        </div>
      ) : (
        <p className="muted">Seule une personne avec le droit « Modifier les paramètres » change ces règles.</p>
      )}
    </div>
  );
}
