import { useState } from 'react';
import { call } from '../api';
import { askConfirm, askText, useCan, useLoad, useToast } from '../ui';

/**
 * Filtres enregistrés d'un écran : on garde les critères du moment sous un nom
 * (« Ventes du mois par zone ») et on les rappelle d'un clic. Le gérant peut
 * en partager avec tout le monde.
 */
export function SavedFilters<P extends Record<string, unknown>>({ screen, current, onApply }: { screen: string; current: P; onApply: (params: P) => void }) {
  const toast = useToast();
  const can = useCan();
  const list = useLoad(() => call('presets.list', screen), [screen]);
  const [chosen, setChosen] = useState('');
  const presets = list.data ?? [];
  const save = async () => {
    const name = await askText('Nom de ce filtre (exemple : Ventes du mois par zone)');
    if (!name) return;
    const shared = can('admin') || can('owner_report') ? await askConfirm('Le proposer à tous les utilisateurs ? (Non : seulement pour vous)') : false;
    try {
      const p = await call('presets.save', { screen, name, params: current, shared });
      list.reload();
      setChosen(p.id);
      toast.ok(`Filtre « ${p.name} » enregistré`);
    } catch (err) {
      toast.error(err);
    }
  };
  const remove = async () => {
    const p = presets.find((x) => x.id === chosen);
    if (!p || !(await askConfirm(`Supprimer le filtre « ${p.name} » ?`))) return;
    try {
      await call('presets.remove', p.id);
      setChosen('');
      list.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <div className="saved-filters">
      <select
        value={chosen}
        title="Filtres enregistrés"
        onChange={(e) => {
          setChosen(e.target.value);
          const p = presets.find((x) => x.id === e.target.value);
          if (p) onApply(p.params as P);
        }}
      >
        <option value="">Filtres enregistrés…</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.user_id === null ? ' (pour tous)' : ''}
          </option>
        ))}
      </select>
      <button onClick={() => void save()} title="Garder ces critères sous un nom">
        Enregistrer ce filtre
      </button>
      {chosen && (
        <button className="ghost" onClick={() => void remove()} title="Supprimer ce filtre">
          ✕
        </button>
      )}
    </div>
  );
}
