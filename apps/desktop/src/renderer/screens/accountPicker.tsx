import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, useCan, useLoad, useToast } from '../ui';

type Account = Result<'accounting.accounts'>[number];

const CLASSES: [string, string][] = [
  ['1', 'Ressources durables'],
  ['2', 'Actif immobilisé'],
  ['3', 'Stocks'],
  ['4', 'Tiers'],
  ['5', 'Trésorerie'],
  ['6', 'Charges'],
  ['7', 'Produits'],
  ['8', 'Autres charges et produits'],
];

/**
 * Plan comptable à feuilleter : recherche par numéro ou intitulé, classe par
 * classe, double-clic (ou Entrée) pour choisir. Avec le droit « Modifier le plan
 * comptable », on y crée un sous-compte (6052 → 60521) sans quitter la saisie.
 * `only` limite le choix à une classe (6 pour une catégorie de dépense).
 */
export function AccountPicker({ only, initialClass, value, onPick, onClose }: { only?: string; initialClass?: string; value?: string; onPick: (a: Account) => void; onClose: () => void }) {
  const can = useCan();
  const toast = useToast();
  const accounts = useLoad(() => call('accounting.accounts'), []);
  const [cls, setCls] = useState(only ?? initialClass ?? value?.[0] ?? '');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(value || null);
  const [creating, setCreating] = useState<{ id: string; label: string } | null>(null);
  const q = search.trim().toLowerCase();
  const rows = (accounts.data ?? []).filter((a) => (!cls || a.id.startsWith(cls)) && (!q || a.id.startsWith(q) || a.label.toLowerCase().includes(q)));
  const pick = (id: string | null) => {
    const a = accounts.data?.find((x) => x.id === id);
    if (!a) return;
    if (only && !a.id.startsWith(only)) return toast.error(`Choisissez un compte de la classe ${only}`);
    onPick(a);
  };
  return (
    <Modal title="Plan comptable" onClose={onClose} wide>
      <div className="filters">
        <input
          className="search"
          autoFocus
          placeholder="Numéro ou intitulé (ex. 624, entretien)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              pick(selected && rows.some((r) => r.id === selected) ? selected : (rows[0]?.id ?? null));
            }
          }}
        />
        {!only && (
          <select value={cls} onChange={(e) => setCls(e.target.value)}>
            <option value="">Toutes les classes</option>
            {CLASSES.map(([k, v]) => (
              <option key={k} value={k}>
                Classe {k} · {v}
              </option>
            ))}
          </select>
        )}
        {only && <span className="muted">Classe {only} · {CLASSES.find(([k]) => k === only)?.[1]}</span>}
      </div>
      <div className="account-picker">
        {accounts.data && rows.length === 0 ? (
          <Empty>Aucun compte ne correspond.</Empty>
        ) : (
          <table className="list compact">
            <tbody>
              {rows.map((a) => (
                <tr
                  key={a.id}
                  className={`clickable ${selected === a.id ? 'selected' : ''} ${a.id.length <= 2 ? 'b' : ''}`}
                  onClick={() => setSelected(a.id)}
                  onDoubleClick={() => pick(a.id)}
                >
                  <td style={{ paddingLeft: 8 + Math.max(0, a.id.length - 2) * 14, width: 110 }}>{a.id}</td>
                  <td>{a.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <form
          className="grid3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const a = await call('accounting.saveAccount', { id: creating.id, label: creating.label });
              toast.ok(`Compte ${a.id} créé`);
              if (only && !a.id.startsWith(only)) {
                accounts.reload();
                setCreating(null);
                return toast.error(`Choisissez un compte de la classe ${only}`);
              }
              onPick(a);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <Field label="Numéro du sous-compte">
            <input autoFocus value={creating.id} onChange={(e) => setCreating({ ...creating, id: e.target.value.trim() })} required />
          </Field>
          <Field label="Intitulé">
            <input value={creating.label} onChange={(e) => setCreating({ ...creating, label: e.target.value })} required />
          </Field>
          <div className="actions" style={{ alignSelf: 'end' }}>
            <button type="button" onClick={() => setCreating(null)}>
              Annuler
            </button>
            <button type="submit" className="primary">
              Créer et choisir
            </button>
          </div>
        </form>
      )}
      <div className="actions">
        {can('chart_accounts') && !creating && (
          <button
            type="button"
            style={{ marginRight: 'auto' }}
            title="Nouveau compte sous le compte sélectionné"
            onClick={() => {
              const parent = selected ?? cls;
              const used = new Set((accounts.data ?? []).map((a) => a.id));
              let id = parent;
              for (let n = 1; n < 100; n++) {
                const candidate = `${parent}${n}`;
                if (!used.has(candidate)) {
                  id = candidate;
                  break;
                }
              }
              setCreating({ id, label: '' });
            }}
          >
            Créer un sous-compte
          </button>
        )}
        <button type="button" onClick={onClose}>
          Annuler
        </button>
        <button type="button" className="primary" disabled={!selected} onClick={() => pick(selected)}>
          Choisir
        </button>
      </div>
    </Modal>
  );
}
