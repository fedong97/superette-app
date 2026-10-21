import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateTime, fcfa, parseQty, qty, useLoad, useToast } from '../ui';
import { InvoicePreview } from './docPreview';
import { ArticlePicker } from './pickers';

type Depot = Result<'consignment.depots'>[number];

/**
 * Dépôt-vente chez les revendeurs : marchandise confiée, toujours au stock du
 * magasin dans un dépôt au nom du client ; à chaque passage, la fiche de contrôle
 * compte ce qui reste et facture le vendu à crédit.
 */
export function Consignment() {
  const toast = useToast();
  const depots = useLoad(() => call('consignment.depots'), []);
  const customers = useLoad(() => call('customers.list', {}), []);
  const [customer, setCustomer] = useState('');
  const [open, setOpen] = useState<Depot | null>(null);
  return (
    <>
      <div className="filters">
        <select value={customer} onChange={(e) => setCustomer(e.target.value)}>
          <option value="">Client revendeur…</option>
          {(customers.data ?? [])
            .filter((c) => !(depots.data ?? []).some((d) => d.customer_id === c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <button
          disabled={!customer}
          onClick={async () => {
            try {
              const wh = await call('consignment.open', customer);
              toast.ok(`Dépôt « ${wh.name} » ouvert`);
              setCustomer('');
              depots.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Ouvrir un dépôt-vente
        </button>
      </div>
      {depots.data?.length === 0 ? (
        <Empty>Aucun dépôt-vente. Ouvrez-en un pour chaque revendeur à qui vous confiez de la marchandise.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Revendeur</th>
              <th>Dépôt</th>
              <th className="r">Articles</th>
              <th className="r">Valeur confiée (revient)</th>
              <th>Dernier contrôle</th>
            </tr>
          </thead>
          <tbody>
            {(depots.data ?? []).map((d) => (
              <tr key={d.warehouse_id} className="clickable" onClick={() => setOpen(d)}>
                <td>{d.customer_name}</td>
                <td>{d.name}</td>
                <td className="r">{d.articles}</td>
                <td className="r">{fcfa(d.value)}</td>
                <td>{d.last_count ? dateTime(d.last_count) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <History />
      {open && (
        <DepotDialog
          depot={open}
          onClose={() => {
            setOpen(null);
            depots.reload();
          }}
        />
      )}
    </>
  );
}

function History({ warehouseId }: { warehouseId?: string }) {
  const list = useLoad(() => call('consignment.history', warehouseId ?? null), [warehouseId]);
  const [preview, setPreview] = useState<string | null>(null);
  if (!list.data?.length) return null;
  return (
    <>
      <h3>Fiches de contrôle</h3>
      <table className="list compact">
        <thead>
          <tr>
            <th>Fiche</th>
            <th>Date</th>
            <th>Revendeur</th>
            <th>Facture</th>
            <th className="r">Vendu (TTC)</th>
            <th>Par</th>
          </tr>
        </thead>
        <tbody>
          {list.data.map((k) => (
            <tr key={k.id} className={k.sale_id ? 'clickable' : ''} onClick={() => k.sale_id && setPreview(k.sale_id)}>
              <td>{k.number}</td>
              <td>{dateTime(k.created_at)}</td>
              <td>{k.customer_name}</td>
              <td>{k.sale_number ?? '—'}</td>
              <td className="r">{fcfa(k.total_ttc)}</td>
              <td>{k.user_name ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview && <InvoicePreview saleId={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function DepotDialog({ depot, onClose }: { depot: Depot; onClose: () => void }) {
  const [mode, setMode] = useState<'view' | 'send' | 'count'>('view');
  const stock = useLoad(() => call('consignment.stock', depot.warehouse_id), [depot.warehouse_id, mode]);
  return (
    <Modal title={`Dépôt-vente · ${depot.customer_name}`} onClose={onClose} wide>
      {mode === 'view' && (
        <>
          {stock.data?.length === 0 ? (
            <p className="muted">Rien chez ce revendeur pour l’instant.</p>
          ) : (
            <table className="list compact">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Article</th>
                  <th className="r">Confié</th>
                  <th className="r">Valeur (revient)</th>
                </tr>
              </thead>
              <tbody>
                {(stock.data ?? []).map((l) => (
                  <tr key={l.article_id}>
                    <td>{l.code}</td>
                    <td>{l.name}</td>
                    <td className="r">{qty(l.qty, l.unit)}</td>
                    <td className="r">{fcfa(Math.round((l.qty * l.avg_cost) / 1000))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="actions">
            <button onClick={() => setMode('send')}>Confier de la marchandise…</button>
            <button className="primary" disabled={!stock.data?.length} onClick={() => setMode('count')}>
              Fiche de contrôle…
            </button>
          </div>
          <History warehouseId={depot.warehouse_id} />
        </>
      )}
      {mode === 'send' && <SendForm depot={depot} onDone={() => setMode('view')} />}
      {mode === 'count' && stock.data && <CountForm depot={depot} stock={stock.data} onDone={() => setMode('view')} />}
    </Modal>
  );
}

/** Choix d'un dépôt de stock du magasin (ni avaries ni dépôt-vente). */
function StockWarehouse({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const wh = useLoad(() => call('admin.warehouses'), []);
  const usable = (wh.data ?? []).filter((w) => w.purpose === 'stock');
  const first = usable[0]?.id;
  useEffect(() => {
    if (!value && first) onChange(first);
  }, [value, first, onChange]);
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {usable.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function SendForm({ depot, onDone }: { depot: Depot; onDone: () => void }) {
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [lines, setLines] = useState<{ articleId: string; name: string; unit: string; qty: string }[]>([]);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const parsed = lines.map((l) => {
            const q = parseQty(l.qty);
            if (!q || q <= 0) throw new Error(`Quantité invalide pour ${l.name}`);
            return { articleId: l.articleId, qty: q };
          });
          await call('consignment.send', { warehouseId: depot.warehouse_id, fromWarehouseId: from, lines: parsed });
          toast.ok('Marchandise confiée au revendeur');
          onDone();
        } catch (err) {
          toast.error(err);
        }
      }}
    >
      <StockWarehouse value={from} onChange={setFrom} label="Sort du dépôt" />
      <ArticlePicker onPick={(a) => !lines.some((l) => l.articleId === a.id) && setLines([...lines, { articleId: a.id, name: a.name, unit: a.unit, qty: '' }])} />
      <table className="list compact">
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.articleId}>
              <td>{l.name}</td>
              <td className="r">
                <input inputMode="decimal" style={{ width: 90 }} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              </td>
              <td>
                <button type="button" className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  Retirer
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button type="button" onClick={onDone}>
          Retour
        </button>
        <button type="submit" className="primary" disabled={!lines.length || !from}>
          Confier
        </button>
      </div>
    </form>
  );
}

function CountForm({ depot, stock, onDone }: { depot: Depot; stock: Result<'consignment.stock'>; onDone: () => void }) {
  const toast = useToast();
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [takeBack, setTakeBack] = useState(false);
  const [to, setTo] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  if (preview) return <InvoicePreview saleId={preview} onClose={onDone} />;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const lines = stock
            .filter((l) => counted[l.article_id]?.trim())
            .map((l) => {
              const q = parseQty(counted[l.article_id]!);
              if (q === null || q < 0) throw new Error(`Quantité comptée invalide pour ${l.name}`);
              return { articleId: l.article_id, counted: q };
            });
          const k = await call('consignment.count', { warehouseId: depot.warehouse_id, lines, takeBack: takeBack ? { toWarehouseId: to } : null, notes: notes || null });
          toast.ok(k.sale_number ? `Fiche ${k.number} : vendu facturé à crédit (${k.sale_number}, ${fcfa(k.total_ttc)})` : `Fiche ${k.number} enregistrée`);
          if (k.sale_id) setPreview(k.sale_id);
          else onDone();
        } catch (err) {
          toast.error(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted">Comptez ce qui reste chez le revendeur. Un article laissé vide est compté tel que confié (rien de vendu). Le manque est facturé à crédit au client, à son tarif, sur votre caisse ouverte.</p>
      <table className="list compact">
        <thead>
          <tr>
            <th>Article</th>
            <th className="r">Confié</th>
            <th className="r">Reste compté</th>
            <th className="r">Vendu</th>
          </tr>
        </thead>
        <tbody>
          {stock.map((l) => {
            const c = counted[l.article_id]?.trim() ? parseQty(counted[l.article_id]!) : l.qty;
            return (
              <tr key={l.article_id}>
                <td>{l.name}</td>
                <td className="r">{qty(l.qty, l.unit)}</td>
                <td className="r">
                  <input
                    inputMode="decimal"
                    style={{ width: 90 }}
                    placeholder={qty(l.qty, l.unit)}
                    value={counted[l.article_id] ?? ''}
                    onChange={(e) => setCounted({ ...counted, [l.article_id]: e.target.value })}
                  />
                </td>
                <td className="r">{c !== null && c <= l.qty ? qty(l.qty - c, l.unit) : '?'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <label>
        <input type="checkbox" checked={takeBack} onChange={(e) => setTakeBack(e.target.checked)} /> Reprendre au magasin ce qui reste
      </label>
      {takeBack && <StockWarehouse value={to} onChange={setTo} label="Revient dans le dépôt" />}
      <Field label="Notes">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="actions">
        <button type="button" onClick={onDone}>
          Retour
        </button>
        <button type="submit" className="primary" disabled={busy || (takeBack && !to)}>
          Valider la fiche de contrôle
        </button>
      </div>
    </form>
  );
}
