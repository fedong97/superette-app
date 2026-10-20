import { useState } from 'react';
import { type Result, call } from '../api';
import { Field, Modal, askConfirm, useLoad, useToast } from '../ui';

type Template = Result<'template.list'>[number];

const contents = (t: Template) => `${t.departments} rayons, ${t.families} familles${t.articles ? `, ${t.articles} articles` : ''}`;

/**
 * Modèles de boutique : un métier tout prêt
 * (rayons, familles, réglages, droits) à appliquer, ou la boutique ouverte
 * enregistrée comme modèle pour les prochaines installations.
 */
export function ShopTemplates() {
  const toast = useToast();
  const list = useLoad(() => call('template.list'));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = async (t: Pick<Template, 'id' | 'name'> & Partial<Template>) => {
    if (!(await askConfirm(`Appliquer le modèle « ${t.name} » à cette boutique ? Les rayons et familles qui manquent sont ajoutés, les réglages et les droits du modèle remplacent les vôtres. Rien n'est supprimé.`))) return;
    setBusy(true);
    try {
      const r = await call('template.apply', t.id);
      toast.ok(
        `Modèle appliqué : ${r.departments} rayon${r.departments > 1 ? 's' : ''} et ${r.families} famille${r.families > 1 ? 's' : ''} ajoutés, ${r.settings} réglage${r.settings > 1 ? 's' : ''}${r.articles.created + r.articles.updated ? `, ${r.articles.created} articles créés et ${r.articles.updated} mis à jour` : ''}`,
      );
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const fromFile = async () => {
    try {
      const t = await call('template.choose');
      if (t) await apply(t);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div>
      <p>
        Un modèle prépare une boutique pour son métier : rayons et familles, marge par défaut, alerte de péremption, droits des rôles et, au choix, un catalogue d'articles. On le choisit à la création de la
        boutique, ou on l'applique ici. Les modèles enregistrés se copient sur une clé pour les installations chez d'autres clients.
      </p>
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button className="primary" onClick={() => setSaving(true)}>
          Enregistrer cette boutique comme modèle…
        </button>
        <button disabled={busy} onClick={() => void fromFile()}>
          Appliquer un modèle sur clé…
        </button>
        <button onClick={() => void call('template.openFolder').catch(toast.error)}>Ouvrir le dossier des modèles</button>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Modèle</th>
            <th>Contenu</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((t) => (
            <tr key={t.id}>
              <td>
                <strong>{t.name}</strong>
                {!t.builtin && <span className="muted"> (enregistré sur ce PC)</span>}
                <div className="muted">{t.description}</div>
              </td>
              <td>{contents(t)}</td>
              <td>
                <button disabled={busy} onClick={() => void apply(t)}>
                  Appliquer…
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {saving && (
        <SaveTemplate
          onClose={() => setSaving(false)}
          onDone={(file) => {
            setSaving(false);
            list.reload();
            toast.ok(`Modèle enregistré : ${file}`);
          }}
        />
      )}
    </div>
  );
}

function SaveTemplate({ onClose, onDone }: { onClose: () => void; onDone: (file: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [articles, setArticles] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await call('template.save', { name, description, articles });
      onDone(r.file);
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title="Enregistrer comme modèle" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Nom du modèle">
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Description" hint="Pour qui est ce modèle">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={articles} onChange={(e) => setArticles(e.target.checked)} /> Joindre le catalogue (articles, codes-barres et prix)
        </label>
        <p className="muted">Le logo, l'en-tête du ticket et le RCCM de la boutique ne partent pas dans le modèle. Les utilisateurs, ventes et stocks non plus.</p>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button className="primary" type="submit">
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}
