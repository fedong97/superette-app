import { useEffect, useMemo, useState } from 'react';
import { BARCODE_LABEL_FORMATS, type BarcodeLabelFormatId, isInternalBarcode } from '@superette/core';
import { type Result, call } from '../api';
import { Modal, useLoad, useStoreSettings, useToast } from '../ui';

/** Une ligne de la fenêtre : un article (unité ou carton) et son code-barres. */
export interface BarcodeRow {
  articleId: string;
  /** Conditionnement (Carton) ; null pour l'unité de détail. */
  pack: string | null;
  /** « Sachet (unité) », « Carton de 24 », ou le nom de l'article. */
  label: string;
  barcode: string | null;
  copies: number;
  /** Décochée au départ (code fabricant déjà imprimé sur le produit). */
  off?: boolean;
}

type Article = Pick<Result<'catalogue.get'>, 'id' | 'name' | 'unit' | 'unit_name' | 'barcodes' | 'packs'>;

/** Lignes d'un article : l'unité de détail puis ses conditionnements, du plus petit au plus grand. */
export function barcodeRowsOf(a: Article, copies: (pack: string | null) => number = () => 1): BarcodeRow[] {
  const packCodes = new Set(a.packs.map((p) => p.barcode).filter(Boolean));
  const unit = a.barcodes.find((b) => b.pack_qty === 1000 && !packCodes.has(b.code))?.code ?? null;
  const unitName = a.unit === 'piece' ? a.unit_name || 'Pièce' : a.unit === 'kg' ? 'kg' : 'litre';
  return [
    {
      articleId: a.id,
      pack: null,
      label: `${unitName} (unité)`,
      barcode: unit,
      copies: copies(null),
    },
    ...[...a.packs].reverse().map((p) => ({
      articleId: a.id,
      pack: p.name,
      label: `${p.name} de ${p.units / 1000}`,
      barcode: p.barcode,
      copies: copies(p.name),
    })),
  ];
}

const keyOf = (r: Pick<BarcodeRow, 'articleId' | 'pack'>) => `${r.articleId}|${r.pack ?? ''}`;

/** Petit code-barres pour les listes (aperçu, pas pour l'impression). */
export function BarcodeChip({ code }: { code: string }) {
  return <span className={`tag ${isInternalBarcode(code) ? 'internal' : ''}`}>{isInternalBarcode(code) ? 'Interne' : 'Fabricant'}</span>;
}

/**
 * Impression des étiquettes produit : nombre par ligne, format (rouleau ou
 * planche A4), ce qui figure sur l'étiquette, aperçu fidèle. Sur rouleau, avec
 * l'imprimante d'étiquettes du poste, l'impression part sans fenêtre.
 */
export function BarcodePrintDialog({ title, intro, rows, onClose }: { title: string; intro?: string; rows: BarcodeRow[]; onClose: () => void }) {
  const toast = useToast();
  const settings = useLoad(() => call('admin.storeSettings'), []);
  const local = useLoad(() => call('admin.settings'), []);
  const [copies, setCopies] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [keyOf(r), String(r.copies)])));
  const [checked, setChecked] = useState<Set<string>>(() => new Set(rows.filter((r) => r.barcode && !r.off).map(keyOf)));
  const [format, setFormat] = useState<BarcodeLabelFormatId | null>(null);
  const [opts, setOpts] = useState<{
    name: boolean;
    price: boolean;
    store: boolean;
  } | null>(null);
  const [skip, setSkip] = useState('0');
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  // Valeurs par défaut du magasin (Paramètres › Codes-barres et étiquettes).
  useEffect(() => {
    if (!settings.data) return;
    setFormat((f) => f ?? settings.data!.labelFormat);
    setOpts(
      (o) =>
        o ?? {
          name: settings.data!.labelName,
          price: settings.data!.labelPrice,
          store: settings.data!.labelStore,
        },
    );
  }, [settings.data]);

  const items = useMemo(
    () =>
      rows
        .filter((r) => r.barcode && checked.has(keyOf(r)))
        .map((r) => ({
          articleId: r.articleId,
          pack: r.pack,
          copies: Math.max(0, Math.floor(Number(copies[keyOf(r)] ?? '0') || 0)),
        }))
        .filter((i) => i.copies > 0),
    [rows, checked, copies],
  );
  const total = items.reduce((s, i) => s + i.copies, 0);
  const f = format ? BARCODE_LABEL_FORMATS[format] : null;
  const isRoll = f?.cols === 1;
  const skipN = Math.max(0, Math.floor(Number(skip) || 0));

  useEffect(() => {
    if (!format || !opts || !items.length) return setPreview('');
    // Rouleau : une étiquette agrandie suffit ; planche : la première planche.
    const shown = isRoll ? [{ ...items[0]!, copies: 1 }] : items;
    const t = setTimeout(() => call('barcode.preview', shown, format, opts, skipN).then(setPreview, (e) => toast.error(e)), 200);
    return () => clearTimeout(t);
  }, [items, format, opts, skipN]);

  const printerName = local.data?.['printer.labels'] || '';
  const print = async () => {
    if (!format || !opts) return;
    setBusy(true);
    try {
      if (await call('barcode.print', items, format, opts, skipN)) {
        toast.ok(`${total} étiquette${total > 1 ? 's' : ''} envoyée${total > 1 ? 's' : ''} à l'imprimante`);
        onClose();
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (k: string) => {
    const next = new Set(checked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setChecked(next);
  };
  const zoom = f ? Math.min(3, 300 / f.pageW) : 1;

  return (
    <Modal title={title} onClose={onClose} wide>
      {intro && <p className="muted">{intro}</p>}
      <div className="bc-print">
        <div>
          <table className="list compact">
            <thead>
              <tr>
                <th />
                <th>Étiquette</th>
                <th>Code-barres</th>
                <th className="r">Nombre</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const k = keyOf(r);
                return (
                  <tr key={k} className={checked.has(k) ? 'selected' : ''}>
                    <td>
                      <input type="checkbox" disabled={!r.barcode} checked={checked.has(k)} onChange={() => toggle(k)} />
                    </td>
                    <td>
                      <b>{r.label}</b>
                    </td>
                    <td>
                      {r.barcode ? (
                        <>
                          <span className="bc-num">{r.barcode}</span> <BarcodeChip code={r.barcode} />
                        </>
                      ) : (
                        <span className="muted">Pas de code-barres</span>
                      )}
                    </td>
                    <td className="r">
                      <input
                        className="qty small"
                        inputMode="numeric"
                        disabled={!r.barcode}
                        value={copies[k] ?? '0'}
                        onChange={(e) => {
                          setCopies({ ...copies, [k]: e.target.value });
                          if (!checked.has(k)) toggle(k);
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="bc-lbl">Format</div>
          <div className="bc-chips">
            {(Object.keys(BARCODE_LABEL_FORMATS) as BarcodeLabelFormatId[]).map((id) => (
              <button key={id} type="button" className={format === id ? 'on' : ''} onClick={() => setFormat(id)}>
                {id.startsWith('roll_') ? BARCODE_LABEL_FORMATS[id].name : `A4 · ${id.slice(3)}`}
              </button>
            ))}
          </div>
          {f && !isRoll && (
            <label className="bc-skip">
              Étiquettes déjà utilisées sur la planche
              <input className="qty small" inputMode="numeric" value={skip} onChange={(e) => setSkip(e.target.value)} />
            </label>
          )}
          <div className="bc-lbl">Sur l'étiquette</div>
          {opts && (
            <div className="bc-checks">
              <label>
                <input type="checkbox" checked disabled /> Code-barres et chiffres
              </label>
              <label>
                <input type="checkbox" checked={opts.name} onChange={(e) => setOpts({ ...opts, name: e.target.checked })} /> Nom de l'article
              </label>
              <label>
                <input type="checkbox" checked={opts.price} onChange={(e) => setOpts({ ...opts, price: e.target.checked })} /> Prix
              </label>
              <label>
                <input type="checkbox" checked={opts.store} onChange={(e) => setOpts({ ...opts, store: e.target.checked })} /> Nom du magasin
              </label>
            </div>
          )}
          <div className="bc-lbl">Imprimante</div>
          <div className="muted">
            {isRoll
              ? printerName
                ? `${printerName} · impression directe`
                : "Fenêtre d'impression de Windows (choisissez l'imprimante d'étiquettes dans Paramètres pour imprimer directement)"
              : "Fenêtre d'impression de Windows"}
          </div>
        </div>
        <div>
          <div className="bc-lbl">{isRoll ? `Aperçu (agrandi × ${zoom.toFixed(0)})` : 'Aperçu'}</div>
          <div className="bc-preview">
            {preview && f ? (
              <iframe
                title="Aperçu des étiquettes"
                srcDoc={preview}
                style={
                  isRoll
                    ? { width: `${f.pageW}mm`, height: `${f.pageH}mm`, zoom }
                    : {
                        width: `${f.pageW}mm`,
                        height: `${f.pageH * Math.max(1, Math.ceil((total + skipN) / (f.cols * f.rows)))}mm`,
                        zoom: 0.45,
                      }
                }
              />
            ) : (
              <span className="muted">Cochez une étiquette pour voir l'aperçu.</span>
            )}
          </div>
        </div>
      </div>
      <div
        className="actions"
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          marginTop: 14,
        }}
      >
        <button type="button" className="ghost" onClick={onClose}>
          {intro ? 'Plus tard' : 'Annuler'}
        </button>
        <button type="button" className="primary" disabled={!total || busy} onClick={print}>
          Imprimer {total} étiquette{total > 1 ? 's' : ''}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Après une réception : propose les étiquettes des articles reçus, une par
 * unité et une par carton reçu. Les codes internes sont cochés ; un code
 * fabricant est déjà imprimé sur le produit, il est décoché. Rien à proposer
 * (aucun code interne, ou réglage désactivé) : la fenêtre se ferme d'elle-même.
 */
export function ReceptionLabels({
  lines,
  title,
  onClose,
}: {
  lines: { articleId: string; qty: number; packUnits: number }[];
  title: string;
  onClose: () => void;
}) {
  const settings = useStoreSettings();
  const ids = [...new Set(lines.map((l) => l.articleId))];
  const articles = useLoad(() => (settings.labelAfterReception ? Promise.all(ids.map((id) => call('catalogue.get', id))) : Promise.resolve([])), []);
  const rows = useMemo(() => {
    if (!articles.data) return null;
    return articles.data.flatMap((a) => {
      const mine = lines.filter((l) => l.articleId === a.id);
      const units = mine.reduce((t, l) => t + l.qty, 0);
      const packCount = (name: string | null) => {
        if (name === null) return a.unit === 'piece' ? Math.round(units / 1000) : 0;
        const p = a.packs.find((x) => x.name === name)!;
        return mine.filter((l) => l.packUnits === p.units).reduce((t, l) => t + Math.floor(l.qty / p.units), 0);
      };
      return barcodeRowsOf(a, packCount)
        .filter((r) => r.barcode && r.copies > 0)
        .map((r) => ({
          ...r,
          label: `${a.name} · ${r.label}`,
          off: !isInternalBarcode(r.barcode!),
        }));
    });
  }, [articles.data]);
  const nothing = rows !== null && !rows.some((r) => !r.off);
  useEffect(() => {
    if (!settings.labelAfterReception || nothing || articles.error) onClose();
  }, [nothing, articles.error]);
  if (!rows || nothing) return null;
  return (
    <BarcodePrintDialog
      title={title}
      intro="Le nombre proposé est la quantité reçue. Les produits qui ont déjà un code fabricant sont décochés."
      rows={rows}
      onClose={onClose}
    />
  );
}
