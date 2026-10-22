import { useState } from 'react';
import { TAKEOVER_KINDS, TAKEOVER_TEMPLATES, type TakeoverKind, readXlsxRows } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, askConfirm, dateFr, fcfa, readTextFile, useLoad, useToast } from '../ui';
import { saveXlsx } from './Controls';

type Outcome = Result<'takeover.run'>;

const STEPS: Record<TakeoverKind, string> = {
  customers:
    'Une ligne par client : nom, téléphone, plafond, délai de paiement (jours), tarif (détail, gros, super gros) et ce qu’il doit aujourd’hui. Un avoir s’écrit en négatif. Le n° et la date de la facture d’origine, et son échéance, gardent la balance âgée juste. Un client déjà saisi (même nom ou même téléphone) est complété, pas recréé.',
  suppliers:
    'Une ligne par fournisseur : nom, téléphone, NIU, délai de paiement et ce que vous lui devez aujourd’hui, avec le n° de sa facture et l’échéance. La dette reprise se paie ensuite comme une facture d’achat, mais ce n’est pas un achat : ni charge, ni TVA déductible.',
  stock:
    'Une ligne par article : code-barres (ou code interne, ou désignation exacte), quantité et coût de revient unitaire. Le code-barres d’un carton compte en cartons, au prix du carton. Lot et date de péremption pour les articles périssables. Importez d’abord le catalogue (Produit › Importer).',
};

/** Lit un fichier CSV (point-virgule, virgule ou tabulation) ou Excel en cellules texte. */
async function readCells(file: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(file.name)) return readXlsxRows(new Uint8Array(await file.arrayBuffer()));
  const text = (await readTextFile(file)).replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim()) ?? '';
  const sep = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
  return lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, '')));
}

/**
 * Reprise d'un magasin qui passe à ONIX 360 : un fichier par sujet, vérifié
 * en aperçu avant d'être importé d'un bloc, avec les écritures d'à-nouveaux
 * passées toutes seules.
 */
export function Takeover() {
  const toast = useToast();
  const summary = useLoad(() => call('takeover.summary'));
  const warehouses = useLoad(() => call('admin.warehouses'));
  const [kind, setKind] = useState<TakeoverKind>('customers');
  const [warehouseId, setWarehouseId] = useState('');
  const [file, setFile] = useState<{ name: string; cells: string[][] } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const warehouse = warehouseId || warehouses.data?.[0]?.id || '';

  const reset = (k: TakeoverKind) => {
    setKind(k);
    setFile(null);
    setOutcome(null);
  };
  const run = async (cells: string[][], preview: boolean) => {
    setBusy(true);
    try {
      const r = await call('takeover.run', kind, cells, { preview, warehouseId: kind === 'stock' ? warehouse : null });
      setOutcome(r);
      if (!preview && !r.preview) {
        toast.ok(`Reprise terminée : ${r.lines.length} ligne${r.lines.length > 1 ? 's' : ''}, ${fcfa(r.total)}`);
        summary.reload();
      } else if (!preview) {
        toast.error('Rien n’a été importé : corrigez les lignes en erreur, puis recommencez avec le fichier entier.');
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const choose = async (f: File) => {
    try {
      const cells = await readCells(f);
      setFile({ name: f.name, cells });
      await run(cells, true);
    } catch (err) {
      toast.error(err);
    }
  };
  const confirm = async () => {
    if (!file || !outcome) return;
    const what = kind === 'stock' ? `${outcome.lines.length} articles pour ${fcfa(outcome.total)}` : `${outcome.lines.length} fiches, soldes repris ${fcfa(outcome.total)}`;
    if (!(await askConfirm(`Importer ${what} ? Les écritures d’à-nouveaux seront passées contre le compte d’attente 4711.`))) return;
    await run(file.cells, false);
  };
  const template = () =>
    saveXlsx(`reprise-${kind === 'customers' ? 'clients' : kind === 'suppliers' ? 'fournisseurs' : 'stock'}.xlsx`, {
      name: TAKEOVER_KINDS[kind].slice(0, 30),
      columns: TAKEOVER_TEMPLATES[kind][0]!.map((header) => ({ header, width: Math.max(12, header.length + 4) })),
      rows: TAKEOVER_TEMPLATES[kind].slice(1),
    });

  const done = summary.data;
  return (
    <div>
      <p>
        Pour un magasin qui tenait ses comptes dans un autre logiciel, dans Excel ou dans un cahier : reprenez ses clients et ce qu’ils doivent, ses fournisseurs et ce que vous leur devez, et son stock
        de départ. Chaque fichier se vérifie d’abord : rien n’est enregistré tant que vous n’avez pas cliqué « Importer ». S’il reste une ligne en erreur, rien n’est importé.
      </p>
      {done && (
        <table className="list" style={{ maxWidth: 720 }}>
          <thead>
            <tr>
              <th>Déjà repris</th>
              <th className="num">Lignes</th>
              <th className="num">Montant</th>
              <th>Le</th>
            </tr>
          </thead>
          <tbody>
            {(['customers', 'suppliers', 'stock'] as TakeoverKind[]).map((k) => (
              <tr key={k}>
                <td>{TAKEOVER_KINDS[k]}</td>
                <td className="num">{done[k].count}</td>
                <td className="num">{fcfa(done[k].total)}</td>
                <td>{done[k].date ? dateFr(done[k].date) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <Field label="Fichier à reprendre">
          <select value={kind} onChange={(e) => reset(e.target.value as TakeoverKind)}>
            {(Object.keys(TAKEOVER_KINDS) as TakeoverKind[]).map((k) => (
              <option key={k} value={k}>
                {TAKEOVER_KINDS[k]}
              </option>
            ))}
          </select>
        </Field>
        {kind === 'stock' && (
          <Field label="Dépôt où entre ce stock">
            <select
              value={warehouse}
              onChange={(e) => {
                setWarehouseId(e.target.value);
                setOutcome(null);
              }}
            >
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <p className="muted">{STEPS[kind]}</p>
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button onClick={template}>Télécharger le modèle Excel</button>
        <label className="button">
          Choisir le fichier rempli (Excel ou CSV)…
          <input
            type="file"
            accept=".xlsx,.csv,.txt"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void choose(f);
            }}
          />
        </label>
        {file && (
          <button disabled={busy} onClick={() => void run(file.cells, true)}>
            Vérifier à nouveau
          </button>
        )}
      </div>
      {outcome && <OutcomeView outcome={outcome} fileName={file?.name ?? ''} busy={busy} onImport={() => void confirm()} />}
    </div>
  );
}

function OutcomeView({ outcome, fileName, busy, onImport }: { outcome: Outcome; fileName: string; busy: boolean; onImport: () => void }) {
  const imported = !outcome.preview;
  return (
    <div>
      <h3>
        {imported ? 'Importé' : 'Aperçu'} · {fileName}
      </h3>
      <p>
        {outcome.kind === 'stock'
          ? `${outcome.created} article${outcome.created > 1 ? 's' : ''}, valeur ${fcfa(outcome.total)}.`
          : `${outcome.created} fiche${outcome.created > 1 ? 's' : ''} créée${outcome.created > 1 ? 's' : ''}, ${outcome.updated} complétée${outcome.updated > 1 ? 's' : ''}, soldes repris ${fcfa(outcome.total)}.`}
        {outcome.errors.length > 0 && <strong className="danger-text"> {outcome.errors.length} ligne{outcome.errors.length > 1 ? 's' : ''} à corriger dans le fichier : rien ne sera importé.</strong>}
      </p>
      {outcome.errors.length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th className="num">Ligne</th>
              <th>À corriger</th>
            </tr>
          </thead>
          <tbody>
            {outcome.errors.map((e, i) => (
              <tr key={i} className="neg">
                <td className="num">{e.line}</td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!imported && outcome.errors.length === 0 && outcome.lines.length > 0 && (
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <button className="primary" disabled={busy} onClick={onImport}>
            Importer {outcome.lines.length} ligne{outcome.lines.length > 1 ? 's' : ''}
          </button>
        </div>
      )}
      {outcome.lines.length === 0 && outcome.errors.length === 0 && <Empty>Aucune ligne à reprendre dans ce fichier.</Empty>}
      {outcome.lines.length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th className="num">Ligne</th>
              <th>{outcome.kind === 'stock' ? 'Article' : outcome.kind === 'customers' ? 'Client' : 'Fournisseur'}</th>
              <th>{imported ? 'Fait' : 'Sera fait'}</th>
              <th className="num">{outcome.kind === 'stock' ? 'Valeur' : 'Solde'}</th>
            </tr>
          </thead>
          <tbody>
            {outcome.lines.map((l) => (
              <tr key={l.line}>
                <td className="num">{l.line}</td>
                <td>{l.label}</td>
                <td>{l.action}</td>
                <td className="num">{l.amount ? fcfa(l.amount) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
