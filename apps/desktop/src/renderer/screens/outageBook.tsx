import { Fragment, useMemo, useState } from 'react';
import {
  BOOK_FIRST_ROW_Y,
  BOOK_ROW_STEP,
  type BookArticle,
  DOUBT_LABEL,
  type DoubtReason,
  type PageCells,
  decodeBookPage,
  project,
  readBookCells,
  readLineAmount,
  toGray,
} from '@superette/core';
import { call } from '../api';
import { Modal, SupervisorPrompt, fcfa, useToast } from '../ui';
import type { Outage } from './posExtras';

/** Plus grand côté de la photo lue et gardée : assez pour les chiffres, assez léger pour la synchro. */
const MAX_SIDE = 1800;

interface Line {
  key: number;
  row: number;
  sale: string;
  time: string;
  code: string;
  /** Quantité écrite (unités ou conditionnements), avec virgule possible. */
  qty: string;
  price: string;
  doubts: DoubtReason[];
  checked: boolean;
  /** Bande de la photo pour cette ligne du carnet (image). */
  strip: string | null;
}

const minutesOf = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

/** Bande de la ligne du carnet, redressée, pour la montrer à côté des valeurs lues. */
function rowStrip(source: HTMLCanvasElement, cells: PageCells, row: number): string {
  const W = 760;
  const H = 42;
  const x0 = 10;
  const x1 = 200;
  const y0 = BOOK_FIRST_ROW_Y + (row - 1) * BOOK_ROW_STEP - 0.5;
  const y1 = y0 + BOOK_ROW_STEP;
  const src = source.getContext('2d')!.getImageData(0, 0, source.width, source.height);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = project(cells.pageToPhoto, { x: x0 + ((x1 - x0) * (i + 0.5)) / W, y: y0 + ((y1 - y0) * (j + 0.5)) / H });
      const xi = Math.round(p.x);
      const yi = Math.round(p.y);
      const o = (j * W + i) * 4;
      if (xi >= 0 && yi >= 0 && xi < src.width && yi < src.height) {
        const s = (yi * src.width + xi) * 4;
        img.data[o] = src.data[s]!;
        img.data[o + 1] = src.data[s + 1]!;
        img.data[o + 2] = src.data[s + 2]!;
      }
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out.toDataURL('image/jpeg', 0.8);
}

async function loadPhoto(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/** « 1,5 » → 1500 millièmes ; vide → 1 (comme sur le carnet). */
const parseQty = (v: string) => {
  const t = v.trim().replace(',', '.');
  if (!t) return 1000;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
};

/**
 * Lecture d'une page du carnet ONIX : la photo est lue sur ce PC, les ventes
 * proposées sont relues ligne par ligne à côté de l'écriture, puis
 * enregistrées dans la coupure. Les lignes douteuses sont en orange et
 * doivent être cochées « vérifié » (ou corrigées) avant l'enregistrement.
 */
export function BookReader({ outage, onClose, onDone }: { outage: Outage; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<BookArticle[]>([]);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [written, setWritten] = useState<number | null>(null);
  const [page, setPage] = useState<number | null>(null);
  const [pin, setPin] = useState(false);
  const byCode = useMemo(() => new Map(catalogue.map((a) => [a.code, a])), [catalogue]);

  const read = async (file: File) => {
    setBusy(true);
    try {
      const canvas = await loadPhoto(file);
      const codes = await call('outages.bookCodes');
      const cat: BookArticle[] = codes.map((c) => ({
        code: c.code,
        articleId: c.article_id,
        packId: c.pack_id,
        units: c.units,
        label: c.units === 1000 ? c.article_name : `${c.article_name} · ${c.pack_name}`,
        unit: c.unit,
        price: c.price,
      }));
      const rgba = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const cells = readBookCells(toGray(rgba.data, canvas.width, canvas.height));
      if (!cells) {
        toast.error('Les quatre carrés noirs des coins ne sont pas visibles : reprenez la photo à plat, avec toute la page');
        return;
      }
      const reading = decodeBookPage(cells, cat, { from: minutesOf(outage.started_at), to: minutesOf(outage.ended_at) });
      const data = canvas.toDataURL('image/jpeg', 0.85);
      const saved = await call('outages.addPage', outage.id, { name: file.name, mime: 'image/jpeg', data });
      setCatalogue(cat);
      setPhoto(data);
      setPage(saved.page);
      setWritten(reading.writtenTotal);
      setLines(
        reading.lines.map((l, i) => ({
          key: i,
          row: l.row,
          sale: l.sale === null ? '' : String(l.sale),
          time: l.time ?? '',
          code: l.code === null ? '' : String(l.code).padStart(4, '0'),
          qty: String((l.qty / (l.article?.units ?? 1000)).toLocaleString('fr-FR')),
          price: l.price === null ? '' : String(l.price),
          doubts: l.doubts,
          checked: l.doubts.length === 0,
          strip: rowStrip(canvas, cells, l.row),
        })),
      );
      if (reading.lines.length === 0) toast.error('Aucune ligne remplie trouvée sur cette page');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const edit = (key: number, patch: Partial<Line>) => setLines((ls) => ls!.map((l) => (l.key === key ? { ...l, ...patch, checked: true } : l)));
  const resolved = (lines ?? []).map((l) => {
    const article = byCode.get(Number(l.code)) ?? null;
    const count = parseQty(l.qty);
    const price = l.price.trim() ? Number(l.price.replace(/\s/g, '')) : (article?.price ?? null);
    const qty = count === null ? null : article && article.units !== 1000 ? (count * article.units) / 1000 : count;
    const amount = article && qty !== null && price !== null && Number.isFinite(price) ? readLineAmount({ qty, price, article }) : 0;
    const problem = !article ? 'Code inconnu' : count === null ? 'Quantité' : !price || !Number.isFinite(price) || price <= 0 ? 'Prix' : !/^\d{1,2}:\d{2}$/.test(l.time) ? 'Heure' : null;
    return { line: l, article, qty, price, amount, problem };
  });
  const total = resolved.reduce((t, r) => t + r.amount, 0);
  const unchecked = resolved.filter((r) => !r.line.checked).length;
  const blocked = resolved.some((r) => r.problem) || unchecked > 0 || resolved.length === 0;

  const save = async (supervisorPin?: string) => {
    if (!lines || page === null) return;
    const day = new Date(outage.started_at);
    const groups: { sale: string; time: string; items: typeof resolved }[] = [];
    for (const r of resolved) {
      const g = groups[groups.length - 1];
      if (g && g.sale === r.line.sale) g.items.push(r);
      else groups.push({ sale: r.line.sale, time: r.line.time, items: [r] });
    }
    const sales = groups.map((g, i) => {
      const [h, m] = g.time.split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      // Coupure qui passe minuit : une heure avant le début tombe le lendemain.
      if (at.getTime() < new Date(outage.started_at).getTime() - 60_000) at.setDate(at.getDate() + 1);
      return {
        at: at.toISOString(),
        number: `${outage.number}/${page}/${g.sale || i + 1}`.slice(0, 20),
        lines: g.items.map((r) => ({ articleId: r.article!.articleId, packId: r.article!.packId, qty: r.qty!, price: r.price === r.article!.price ? null : r.price })),
      };
    });
    setBusy(true);
    try {
      const done = await call('outages.enterSales', outage.id, sales, supervisorPin ? { supervisorPin } : undefined);
      setPin(false);
      toast.ok(`${done.length} vente(s) de la page ${page} enregistrées dans la coupure n° ${outage.number}`);
      onDone();
    } catch (err) {
      if ((err as { code?: string }).code === 'SUPERVISOR_REQUIRED' && !supervisorPin) setPin(true);
      else toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Coupure n° ${outage.number} : lire une page du carnet`} onClose={onClose} wide>
      {!lines ? (
        <>
          <p className="muted">
            Photographiez une page du carnet ONIX à plat, entière, avec les quatre carrés noirs des coins. La photo est lue sur ce PC, sans internet ; vous vérifiez ensuite chaque ligne avant d'enregistrer les ventes.
          </p>
          <label className={`button primary ${busy ? 'busy' : ''}`}>
            {busy ? 'Lecture de la page…' : 'Choisir la photo de la page'}
            <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} />
          </label>
        </>
      ) : (
        <div className="book-reader">
          {photo && <img className="book-photo" src={photo} alt={`Page ${page} du carnet`} />}
          <div>
            <table className="list compact">
              <thead>
                <tr>
                  <th>Ligne du carnet</th>
                  <th>Vente</th>
                  <th>Heure</th>
                  <th>Code</th>
                  <th>Article</th>
                  <th className="r">Qté</th>
                  <th className="r">Prix</th>
                  <th className="r">Montant</th>
                  <th>Vérifié</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {resolved.map(({ line: l, article, amount, problem }) => (
                  <Fragment key={l.key}>
                    <tr className="book-strip">
                      <td colSpan={10}>{l.strip && <img src={l.strip} alt={`Ligne ${l.row} du carnet`} />}</td>
                    </tr>
                    <tr className={!l.checked || problem ? 'warn' : ''}>
                      <td>{l.row}</td>
                      <td>
                        <input className="w4" value={l.sale} onChange={(e) => edit(l.key, { sale: e.target.value.replace(/\D/g, '') })} />
                      </td>
                      <td>
                        <input className="w5" value={l.time} placeholder="HH:MM" onChange={(e) => edit(l.key, { time: e.target.value })} />
                      </td>
                      <td>
                        <input className="w5" value={l.code} onChange={(e) => edit(l.key, { code: e.target.value.replace(/\D/g, '') })} />
                      </td>
                      <td className="book-article">
                        {article ? article.label : <span className="neg">Code inconnu</span>}
                        {l.doubts.length > 0 && !l.checked && <div className="muted small">{l.doubts.map((d) => DOUBT_LABEL[d]).join(' · ')}</div>}
                        {l.doubts.includes('price_differs') && article && <div className="muted small">Catalogue : {fcfa(article.price)}</div>}
                      </td>
                      <td className="r">
                        <input className="w4 r" value={l.qty} onChange={(e) => edit(l.key, { qty: e.target.value })} />
                      </td>
                      <td className="r">
                        <input className="w6 r" value={l.price} onChange={(e) => edit(l.key, { price: e.target.value.replace(/[^\d]/g, '') })} />
                      </td>
                      <td className="r">{fcfa(amount)}</td>
                      <td>
                        <input type="checkbox" checked={l.checked} onChange={(e) => setLines((ls) => ls!.map((x) => (x.key === l.key ? { ...x, checked: e.target.checked } : x)))} />
                      </td>
                      <td>
                        <button className="link" title="Retirer cette ligne" onClick={() => setLines((ls) => ls!.filter((x) => x.key !== l.key))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
            <table className="table">
              <tbody>
                <tr>
                  <td>Total des lignes lues</td>
                  <td className="r">
                    <strong>{fcfa(total)}</strong>
                  </td>
                </tr>
                <tr>
                  <td>Total écrit en bas de la page</td>
                  <td className={`r ${written !== null && written !== total ? 'neg' : ''}`}>{written === null ? 'non lu' : fcfa(written)}</td>
                </tr>
                <tr>
                  <td>Reste à saisir pour la coupure après cette page</td>
                  <td className="r">{fcfa(outage.declared_total - outage.entered_total - total)}</td>
                </tr>
              </tbody>
            </table>
            {unchecked > 0 && <p className="muted">Vérifiez les {unchecked} ligne(s) en orange avec la photo : corrigez-les ou cochez « Vérifié ».</p>}
            <div className="actions">
              <button onClick={onClose}>Fermer sans enregistrer</button>
              <button className={`primary ${busy ? 'busy' : ''}`} disabled={blocked || busy} onClick={() => void save()}>
                Enregistrer les ventes de la page
              </button>
            </div>
          </div>
        </div>
      )}
      {pin && <SupervisorPrompt action="Enregistrer des ventes à un prix différent du catalogue" onCancel={() => setPin(false)} onConfirm={(p) => void save(p)} />}
    </Modal>
  );
}

/** Impression du carnet ONIX : des pages à cases et la liste des codes, à préparer avant la prochaine coupure. */
export function BookPrintButtons() {
  const toast = useToast();
  const [pages, setPages] = useState('10');
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <span className="book-print">
      <input className="w4" value={pages} onChange={(e) => setPages(e.target.value.replace(/\D/g, ''))} aria-label="Nombre de pages" />
      <button onClick={() => void run(() => call('outages.bookPrint', Number(pages) || 1))} title="Pages à cases du carnet de coupure, lues ensuite sur le PC">
        Imprimer des pages de carnet
      </button>
      <button onClick={() => void run(() => call('outages.bookCodesPrint'))} title="Le code court de chaque article, à écrire dans le carnet">
        Imprimer la liste des codes
      </button>
    </span>
  );
}
