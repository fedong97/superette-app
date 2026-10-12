import { DOC_FORMATS, DOC_VARIANTS } from '@superette/core';
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

/**
 * Aperçu d'une facture avant impression : choix du modèle (ticket, A4,
 * listing), puis impression ou enregistrement en PDF.
 */
export function InvoicePreview({ saleId, format = 'a4', onClose }: { saleId: string; format?: 'ticket' | 'a4' | 'listing'; onClose: () => void }) {
  const toast = useToast();
  const list = useLoad(() => call('docs.templates'));
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.75);
  const [preview, setPreview] = useState<{ templateId: string; html: string; variant: 'cash' | 'credit' } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call('pos.previewInvoice', saleId, templateId ? { templateId } : { format })
      .then(setPreview)
      .catch((err) => (toast.error(err), onClose()));
  }, [saleId, templateId]);

  if (!preview || !list.data) return null;
  const choices = list.data.templates.filter((t) => t.doc === 'invoice' && t.variant === preview.variant);
  const current = choices.find((t) => t.id === preview.templateId);
  const run = async (output: 'print' | 'pdf') => {
    setBusy(true);
    try {
      const done = await call('pos.printInvoice', saleId, { templateId: preview.templateId, output });
      if (done) toast.ok(output === 'pdf' ? 'PDF enregistré' : 'Document imprimé');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Aperçu avant impression · ${DOC_VARIANTS[preview.variant]}`} onClose={onClose} wide>
      <div className="toolbar">
        <label className="inline">
          Modèle
          <select value={preview.templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {(Object.keys(DOC_FORMATS) as (keyof typeof DOC_FORMATS)[]).map((f) => (
              <optgroup key={f} label={DOC_FORMATS[f]}>
                {choices
                  .filter((t) => t.format === f)
                  .map((t) => (
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
