import { DOC_FORMATS, DOC_KINDS, DOC_VARIANTS, type DocFormat, type DocVariant } from '@superette/core';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { Modal, useLoad, useToast } from '../ui';

/** Page HTML d'un modèle avec un zoom d'écran (l'impression n'en tient pas compte). */
export function zoomed(html: string, zoom: number): string {
  return html.replace('</head>', `<style>@media screen { html { zoom: ${zoom}; } }</style></head>`);
}

/** Aperçu d'un document dans un cadre isolé, sans script. */
export function DocFrame({ html, zoom, height = '70vh' }: { html: string; zoom: number; height?: string }) {
  return <iframe className="doc-frame" title="Aperçu" sandbox="" srcDoc={zoomed(html, zoom)} style={{ height }} />;
}

export const ZOOMS: [number, string][] = [
  [0.5, '50 %'],
  [0.75, '75 %'],
  [1, '100 %'],
  [1.25, '125 %'],
];

type Preview = { templateId: string; html: string; doc: 'invoice' | 'quote'; variant: DocVariant };
type Source = { kind: 'sale'; id: string } | { kind: 'quote'; id: string };

/** Aperçu d'une vente (facture ou bon de livraison) avant impression. */
export function InvoicePreview({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  return <DocPreview source={{ kind: 'sale', id: saleId }} onClose={onClose} />;
}

/**
 * Aperçu d'un document avant impression : choix du modèle (ticket, A4,
 * listing ; facture ou bon de livraison pour une vente), puis impression ou
 * enregistrement en PDF.
 */
export function DocPreview({ source, onClose }: { source: Source; onClose: () => void }) {
  const toast = useToast();
  const list = useLoad(() => call('docs.templates'));
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.75);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const opts = templateId ? { templateId } : { format: 'a4' as const };
    (source.kind === 'sale' ? call('pos.previewInvoice', source.id, opts) : call('quotes.preview', source.id, opts))
      .then(setPreview)
      .catch((err) => (toast.error(err), onClose()));
  }, [source.id, templateId]);

  if (!preview || !list.data) return null;
  const choices = list.data.templates.filter((t) => (t.doc === preview.doc && t.variant === preview.variant) || (source.kind === 'sale' && t.doc === 'delivery'));
  const current = choices.find((t) => t.id === preview.templateId);
  const groups = [...new Set(choices.map((t) => t.doc))].flatMap((d) =>
    (Object.keys(DOC_FORMATS) as DocFormat[]).map((f) => [d, f, choices.filter((t) => t.doc === d && t.format === f)] as const),
  );
  const run = async (output: 'print' | 'pdf') => {
    setBusy(true);
    try {
      const opts = { templateId: preview.templateId, output };
      const done = await (source.kind === 'sale' ? call('pos.printInvoice', source.id, opts) : call('quotes.print', source.id, opts));
      if (done) toast.ok(output === 'pdf' ? 'PDF enregistré' : 'Document imprimé');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Aperçu avant impression · ${current?.doc === 'delivery' ? DOC_KINDS.delivery : DOC_VARIANTS[preview.variant]}`} onClose={onClose} wide>
      <div className="toolbar">
        <label className="inline">
          Modèle
          <select value={preview.templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {groups
              .filter(([, , ts]) => ts.length)
              .map(([d, f, ts]) => (
                <optgroup key={`${d}.${f}`} label={`${DOC_KINDS[d]} · ${DOC_FORMATS[f]}`}>
                  {ts.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
        </label>
        <label className="inline">
          Zoom
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {ZOOMS.map(([z, l]) => (
              <option key={z} value={z}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <DocFrame html={preview.html} zoom={zoom} />
      <div className="actions">
        {current && current.page.copies > 1 && <span className="muted">{current.page.copies} exemplaires</span>}
        <button className="ghost" onClick={onClose}>
          Fermer
        </button>
        {current?.format !== 'ticket' && (
          <button disabled={busy} onClick={() => run('pdf')}>
            Enregistrer en PDF
          </button>
        )}
        <button className="primary" disabled={busy} onClick={() => run('print')}>
          Imprimer
        </button>
      </div>
    </Modal>
  );
}
