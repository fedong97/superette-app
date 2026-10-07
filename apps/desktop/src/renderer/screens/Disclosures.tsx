import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { Field, dateTime, fcfa, parseAmount, today, useLoad, useToast } from '../ui';

type Data = Result<'accounting.disclosures'>;
type Draft = Omit<Data, 'year' | 'updatedAt' | 'updatedBy' | 'labels'>;
type StaffKey = keyof Draft['staff'];
type Origin = 'national' | 'cemac' | 'other';

const num = (v: string) => (v.trim() === '' ? 0 : Number(v.replace(/\s/g, '')));
const amountOf = (v: string) => parseAmount(v) ?? 0;

/**
 * Notes déclaratives de la DSF : ce que l'entreprise déclare elle-même pour l'exercice
 * (sûretés et engagements, méthodes comptables, associés, effectifs, informations sociales).
 * Elles s'impriment avec les notes calculées (États financiers › Notes annexes).
 */
export function Disclosures() {
  const toast = useToast();
  const thisYear = Number(today().slice(0, 4));
  const [year, setYear] = useState(thisYear - 1);
  const data = useLoad(() => call('accounting.disclosures', year), [year]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!data.data) return;
    const { year: _y, updatedAt: _u, updatedBy: _b, labels: _l, ...rest } = data.data;
    setDraft(rest);
    setDirty(false);
  }, [data.data]);
  const d = data.data;
  if (!d || !draft) return null;
  const labels = d.labels;
  const edit = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const setAt = <K extends 'securedDebts' | 'commitments' | 'shareholders'>(key: K, i: number, patch: Partial<Draft[K][number]>) =>
    edit({ [key]: draft[key].map((x, k) => (k === i ? { ...x, ...patch } : x)) } as Partial<Draft>);
  const remove = (key: 'securedDebts' | 'commitments' | 'shareholders', i: number) => edit({ [key]: draft[key].filter((_, k) => k !== i) } as Partial<Draft>);
  const staff = (k: StaffKey, origin: Origin, sex: 0 | 1, v: string) => {
    const line = draft.staff[k];
    const p = [...line[origin]] as [number, number];
    p[sex] = num(v);
    edit({ staff: { ...draft.staff, [k]: { ...line, [origin]: p } } });
  };
  const save = () =>
    call('accounting.saveDisclosures', year, draft).then(() => {
      toast.ok('Notes déclaratives enregistrées');
      data.reload();
    }, toast.error);
  const capital = draft.shareholders.reduce((t, s) => t + s.shares * s.nominal, 0);
  const headcount = (Object.keys(draft.staff) as StaffKey[]).reduce((t, k) => {
    const l = draft.staff[k];
    return t + l.national[0] + l.national[1] + l.cemac[0] + l.cemac[1] + l.other[0] + l.other[1];
  }, 0);

  return (
    <div className="disclosures">
      <div className="filters">
        <label className="inline">
          Exercice
          <select
            value={year}
            onChange={(e) => {
              if (dirty && !confirm('Abandonner la saisie non enregistrée ?')) return;
              setYear(Number(e.target.value));
            }}
          >
            {[0, 1, 2, 3].map((k) => (
              <option key={k} value={thisYear - k}>
                {thisYear - k}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {d.updatedAt ? `Dernière saisie le ${dateTime(d.updatedAt)}${d.updatedBy ? ` par ${d.updatedBy}` : ''}` : 'Rien de saisi pour cet exercice : textes proposés par défaut.'}
        </span>
      </div>
      <p className="muted">
        Ces notes complètent celles que l'application calcule à partir des écritures. Elles s'impriment avec elles (États financiers › Notes annexes) et passent dans
        l'export CSV pour la DSF.
      </p>

      <h3>Note 1 · Dettes garanties par des sûretés réelles</h3>
      <table className="list compact">
        <thead>
          <tr>
            <th>Dette</th>
            <th>Créancier</th>
            <th>Sûreté</th>
            <th className="r">Montant restant dû</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.securedDebts.map((x, i) => (
            <tr key={i}>
              <td>
                <input value={x.label} placeholder="Prêt équipement" onChange={(e) => setAt('securedDebts', i, { label: e.target.value })} />
              </td>
              <td>
                <input value={x.creditor} placeholder="Banque" onChange={(e) => setAt('securedDebts', i, { creditor: e.target.value })} />
              </td>
              <td>
                <select value={x.security} onChange={(e) => setAt('securedDebts', i, { security: e.target.value as typeof x.security })}>
                  {Object.entries(labels.security).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </td>
              <td className="r">
                <AmountInput value={x.amount} onChange={(amount) => setAt('securedDebts', i, { amount })} />
              </td>
              <td>
                <button className="ghost" title="Retirer" onClick={() => remove('securedDebts', i)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => edit({ securedDebts: [...draft.securedDebts, { label: '', creditor: '', security: 'mortgage', amount: 0 }] })}>Ajouter une dette garantie</button>

      <h3>Note 1 · Engagements financiers donnés et reçus</h3>
      <table className="list compact">
        <thead>
          <tr>
            <th>Sens</th>
            <th>Nature</th>
            <th>Tiers ou objet</th>
            <th className="r">Montant</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.commitments.map((x, i) => (
            <tr key={i}>
              <td>
                <select value={x.direction} onChange={(e) => setAt('commitments', i, { direction: e.target.value as typeof x.direction })}>
                  <option value="given">Donné</option>
                  <option value="received">Reçu</option>
                </select>
              </td>
              <td>
                <select value={x.kind} onChange={(e) => setAt('commitments', i, { kind: e.target.value as typeof x.kind })}>
                  {Object.entries(labels.commitment).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input value={x.party} placeholder="Caution donnée à la douane" onChange={(e) => setAt('commitments', i, { party: e.target.value })} />
              </td>
              <td className="r">
                <AmountInput value={x.amount} onChange={(amount) => setAt('commitments', i, { amount })} />
              </td>
              <td>
                <button className="ghost" title="Retirer" onClick={() => remove('commitments', i)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => edit({ commitments: [...draft.commitments, { direction: 'given', kind: 'guarantees', party: '', amount: 0 }] })}>Ajouter un engagement</button>

      <h3>Note 2 · Informations obligatoires</h3>
      <div className="grid2">
        {(
          [
            ['compliance', 'Déclaration de conformité au SYSCOHADA'],
            ['methods', 'Règles et méthodes comptables'],
            ['derogations', 'Dérogations aux règles comptables'],
            ['changes', 'Changements de méthode et corrections d’erreurs'],
          ] as const
        ).map(([k, label]) => (
          <Field key={k} label={label}>
            <textarea rows={k === 'methods' ? 6 : 3} value={draft.accounting[k]} onChange={(e) => edit({ accounting: { ...draft.accounting, [k]: e.target.value } })} />
          </Field>
        ))}
      </div>

      <h3>Note 13B · Répartition du capital entre associés</h3>
      <table className="list compact">
        <thead>
          <tr>
            <th>Associé</th>
            <th>Nationalité</th>
            <th className="r">Nombre de parts</th>
            <th className="r">Valeur nominale</th>
            <th className="r">Montant</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.shareholders.map((x, i) => (
            <tr key={i}>
              <td>
                <input value={x.name} onChange={(e) => setAt('shareholders', i, { name: e.target.value })} />
              </td>
              <td>
                <input value={x.nationality} placeholder="Camerounaise" onChange={(e) => setAt('shareholders', i, { nationality: e.target.value })} />
              </td>
              <td className="r">
                <input className="qty" inputMode="numeric" value={x.shares || ''} onChange={(e) => setAt('shareholders', i, { shares: num(e.target.value) })} />
              </td>
              <td className="r">
                <AmountInput value={x.nominal} onChange={(nominal) => setAt('shareholders', i, { nominal })} />
              </td>
              <td className="r">{fcfa(x.shares * x.nominal)}</td>
              <td>
                <button className="ghost" title="Retirer" onClick={() => remove('shareholders', i)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {draft.shareholders.length > 0 && (
            <tr className="total">
              <td colSpan={4}>Capital déclaré</td>
              <td className="r">{fcfa(capital)}</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
      <button onClick={() => edit({ shareholders: [...draft.shareholders, { name: '', nationality: '', shares: 0, nominal: 10_000 }] })}>Ajouter un associé</button>
      <span className="muted"> Laissez vide pour une entreprise individuelle.</span>

      <h3>Note 27B · Effectifs au 31 décembre et masse salariale</h3>
      <table className="list compact">
        <thead>
          <tr>
            <th rowSpan={2}>Catégorie</th>
            <th colSpan={2}>Nationaux</th>
            <th colSpan={2}>Autres pays CEMAC</th>
            <th colSpan={2}>Hors CEMAC</th>
            <th rowSpan={2} className="r">
              Masse salariale de l'exercice
            </th>
          </tr>
          <tr>
            {[0, 1, 2].map((k) => (
              <th key={k} colSpan={2}>
                H / F
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(Object.keys(draft.staff) as StaffKey[]).map((k) => (
            <tr key={k}>
              <td>{labels.staff[k]}</td>
              {(['national', 'cemac', 'other'] as const).map((o) => (
                <td key={o} colSpan={2}>
                  <span className="hf">
                    {[0, 1].map((sex) => (
                      <input
                        key={sex}
                        className="count"
                        inputMode="numeric"
                        title={sex ? 'Femmes' : 'Hommes'}
                        value={draft.staff[k][o][sex] || ''}
                        placeholder="0"
                        onChange={(e) => staff(k, o, sex as 0 | 1, e.target.value)}
                      />
                    ))}
                  </span>
                </td>
              ))}
              <td className="r">
                <AmountInput value={draft.staff[k].payroll} onChange={(payroll) => edit({ staff: { ...draft.staff, [k]: { ...draft.staff[k], payroll } } })} />
              </td>
            </tr>
          ))}
          <tr>
            <td>Personnel extérieur (intérim, mis à disposition)</td>
            <td colSpan={6}>
              <input
                className="count"
                inputMode="numeric"
                value={draft.external.count || ''}
                placeholder="0"
                onChange={(e) => edit({ external: { ...draft.external, count: num(e.target.value) } })}
              />{' '}
              personnes
            </td>
            <td className="r">
              <AmountInput value={draft.external.cost} onChange={(cost) => edit({ external: { ...draft.external, cost } })} />
            </td>
          </tr>
          <tr className="total">
            <td>Effectif salarié</td>
            <td colSpan={7}>{headcount} personnes</td>
          </tr>
        </tbody>
      </table>

      <h3>Note 35 · Informations sociales, environnementales et sociétales</h3>
      <textarea
        rows={5}
        value={draft.social}
        placeholder="Formation du personnel, sécurité, gestion des déchets et emballages, consommation d'énergie, actions envers le quartier…"
        onChange={(e) => edit({ social: e.target.value })}
      />

      <div className="actions sticky">
        <button className="primary" disabled={!dirty} onClick={save}>
          Enregistrer les notes déclaratives
        </button>
        {dirty && <span className="muted">Modifications non enregistrées</span>}
      </div>
    </div>
  );
}

/** Montant FCFA saisi librement (« 1 250 000 »), remis en forme quand on quitte le champ. */
function AmountInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(value ? fcfa(value).replace(/\s*FCFA$/, '') : '');
  useEffect(() => setText(value ? fcfa(value).replace(/\s*FCFA$/, '') : ''), [value]);
  return (
    <input
      className="amount"
      inputMode="numeric"
      value={text}
      placeholder="0"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(amountOf(text))}
    />
  );
}
