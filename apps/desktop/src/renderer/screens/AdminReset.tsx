import { useState } from 'react';
import { call } from '../api';
import { Field, Modal, useLoad, useToast } from '../ui';

/**
 * Remise à zéro après l'installation : les ventes, achats, caisses et mouvements
 * faits pendant les essais sont effacés ; réglages, utilisateurs, caisses,
 * produits, clients, fournisseurs et personnel restent.
 */
export function ResetData({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card">
      <h3>Remise à zéro des données d’essai</h3>
      <p className="muted">
        Après l’installation et la formation, effacez les ventes, achats, journées de caisse, dépenses, inventaires et mouvements de stock faits pour s’entraîner. Les
        réglages, les utilisateurs et leurs droits, les caisses, les dépôts, les produits (prix, codes-barres, conditionnements, rayons), les clients, les fournisseurs, le
        personnel et le plan comptable sont gardés.
      </p>
      <button className="danger" onClick={() => setOpen(true)}>
        Remettre à zéro…
      </button>
      {open && (
        <ResetDialog
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onDone();
          }}
        />
      )}
    </section>
  );
}

function ResetDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const preview = useLoad(() => call('reset.preview'), []);
  const [keepStock, setKeepStock] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const p = preview.data;
  if (!p) return null;
  const blocked = p.connected ? 'Ce PC est relié au serveur central : faites la remise à zéro avant de relier les PC.' : !p.backupDir ? 'Choisissez d’abord le dossier des sauvegardes ci-dessus : une sauvegarde est faite juste avant.' : null;
  const ready = !blocked && confirm.trim().toUpperCase() === 'REMETTRE A ZERO' && pin.length >= 4 && !busy;
  return (
    <Modal title="Remettre à zéro les données d’essai" onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await call('reset.run', { keepStock }, pin, confirm);
            toast.ok(`Remise à zéro faite. Sauvegarde d’avant : ${r.backup}`);
            onDone();
          } catch (err) {
            toast.error(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid2">
          <div>
            <h4>Effacé</h4>
            <ul>
              <li>{p.sales} ventes et factures, devis, commandes clients, règlements</li>
              <li>{p.receptions} réceptions, {p.supplierInvoices} factures fournisseurs, bons de commande, règlements</li>
              <li>{p.cashSessions} journées de caisse, entrées et sorties, caisse centrale</li>
              <li>{p.expenses} dépenses, salaires, avances, pointages</li>
              <li>{p.movements} mouvements de stock, inventaires, transferts</li>
              <li>Écritures comptables saisies à la main ; les numéros de tickets et de factures repartent à 1</li>
            </ul>
          </div>
          <div>
            <h4>Gardé</h4>
            <ul>
              <li>{p.articles} produits avec prix, codes-barres, conditionnements, rayons et familles</li>
              <li>
                {p.customers} clients et {p.suppliers} fournisseurs (fiches, sans les opérations d’essai)
              </li>
              <li>{p.users} utilisateurs, droits, caisses, dépôts et magasins</li>
              <li>Paramètres, modèles d’impression, personnel, plan comptable, reprise des soldes de départ</li>
            </ul>
          </div>
        </div>
        <Field label="Stock">
          <select value={keepStock ? 'keep' : 'zero'} onChange={(e) => setKeepStock(e.target.value === 'keep')}>
            <option value="zero">Remettre tout le stock à zéro (vous ferez ensuite l’inventaire de départ)</option>
            <option value="keep">Garder les quantités actuelles comme stock de départ</option>
          </select>
        </Field>
        {blocked ? (
          <p className="danger-text">{blocked}</p>
        ) : (
          <>
            <p className="warn-text">Une sauvegarde complète est faite juste avant : en cas d’erreur, restaurez-la depuis la liste des sauvegardes.</p>
            <Field label="Tapez REMETTRE A ZERO pour confirmer">
              <input autoFocus value={confirm} onChange={(e) => setConfirm(e.target.value)} onPaste={(e) => e.preventDefault()} />
            </Field>
            <Field label="Votre code d’administrateur">
              <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
            </Field>
          </>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="danger" disabled={!ready}>
            {busy ? 'Remise à zéro…' : 'Effacer les données d’essai'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
