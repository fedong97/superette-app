import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateFr, dateTime, fcfa, parseAmount, parseQty, qty, today, useLoad, useToast } from '../ui';
import { hasVat, tx } from '../tax';
import { ArticlePicker, SupplierSelect, WarehouseSelect } from './pickers';

type Article = Result<'catalogue.get'>;
type ReturnRow = Result<'supplierReturns.list'>[number];

/**
 * Retours au fournisseur (casse, périmés, erreur de livraison) : le bon fait
 * sortir la marchandise du stock et attend l'avoir du fournisseur.
 */
export function SupplierReturns({ canCredit }: { canCredit: boolean }) {
  const [openOnly, setOpenOnly] = useState(true);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(() => call('supplierReturns.list', { open: openOnly }), [openOnly, creating, open]);
  const pending = useLoad(() => call('supplierReturns.pending'), [creating, open]);
  const waiting = (pending.data ?? []).reduce((t, p) => t + p.total_ttc, 0);
  return (
    <>
      <div className="toolbar">
        <button className="primary" onClick={() => setCreating(true)}>
          Nouveau retour fournisseur
        </button>
        <label className="inline">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Avoirs attendus seulement
        </label>
      </div>
      {waiting > 0 && (
        <div className="kpis">
          <div className="neg">
            <small>Avoirs attendus</small>
            <strong>{fcfa(waiting)}</strong>
          </div>
          {(pending.data ?? []).map((p) => (
            <div key={p.supplier_id}>
              <small>
                {p.supplier_name} ({p.count})
              </small>
              <strong>{fcfa(p.total_ttc)}</strong>
            </div>
          ))}
        </div>
      )}
      {(list.data ?? []).length === 0 ? (
        <Empty>Aucun retour. Un retour fait sortir du stock la marchandise rendue au fournisseur (casse, périmés, erreur de livraison) en attendant son avoir.</Empty>
      ) : (
        <ReturnTable rows={list.data ?? []} onOpen={setOpen} />
      )}
      {creating && <ReturnForm onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), setOpen(id))} />}
      {open && <ReturnDetail id={open} canCredit={canCredit} onClose={() => setOpen(null)} />}
    </>
  );
}

function ReturnTable({ rows, onOpen }: { rows: ReturnRow[]; onOpen: (id: string) => void }) {
  return (
    <table className="list">
      <thead>
        <tr>
          <th>N°</th>
          <th>Date</th>
          <th>Fournisseur</th>
          <th>Motif</th>
          <th className="r">{tx('TTC')}</th>
          <th>État</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
            <td>{r.number}</td>
            <td>{dateTime(r.created_at)}</td>
            <td>{r.supplier_name}</td>
            <td>{r.reason}</td>
            <td className="r">{fcfa(r.total_ttc)}</td>
            <td>{r.status === 'credited' ? `Avoir reçu ${r.credit_note_number ?? ''}` : <span className="tag">Avoir attendu</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Line {
  article: Article;
  qty: string;
  cost: string;
}

function ReturnForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((t, l) => t + Math.round(((parseQty(l.qty) ?? 0) * (parseAmount(l.cost) ?? 0)) / 1000), 0);
  const save = async () => {
    setBusy(true);
    try {
      const r = await call('supplierReturns.create', {
        supplierId,
        warehouseId,
        reason,
        lines: lines.map((l) => ({ articleId: l.article.id, qty: parseQty(l.qty) ?? 0, unitCost: parseAmount(l.cost) })),
      });
      toast.ok(`Retour ${r.number} enregistré`);
      onCreated(r.id);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Nouveau retour fournisseur" onClose={onClose} wide>
      <div className="grid3">
        <SupplierSelect value={supplierId} onChange={setSupplierId} />
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} label="Dépôt d'où sort la marchandise" />
        <Field label="Motif">
          <input value={reason} placeholder="Casse, périmés, erreur de livraison…" onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <ArticlePicker
        placeholder="Article à rendre (code, nom ou code-barres)"
        onPick={(a) => (lines.some((l) => l.article.id === a.id) ? toast.ok(`${a.name} est déjà sur le bon`) : setLines([...lines, { article: a, qty: '1', cost: String(a.purchase_price) }]))}
      />
      {lines.length > 0 && (
        <table className="list compact">
          <thead>
            <tr>
              <th>Article</th>
              <th className="r">Quantité rendue</th>
              <th className="r">{tx("Prix d'achat HT")}</th>
              <th className="r">{tx('Total HT')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.article.id}>
                <td>
                  {l.article.code} · {l.article.name}
                </td>
                <td className="r">
                  <input className="num" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} />
                </td>
                <td className="r">
                  <input className="num" inputMode="numeric" value={l.cost} onChange={(e) => set(i, { cost: e.target.value })} />
                </td>
                <td className="r">{fcfa(Math.round(((parseQty(l.qty) ?? 0) * (parseAmount(l.cost) ?? 0)) / 1000))}</td>
                <td>
                  <button className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                    Retirer
                  </button>
                </td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={3}>{tx('Total HT')}</td>
              <td className="r">{fcfa(total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
      <p className="muted">La marchandise sort du stock dès l'enregistrement. L'avoir du fournisseur se saisit ensuite depuis le bon.</p>
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={busy || !supplierId || !warehouseId || !reason.trim() || lines.length === 0} onClick={save}>
          Enregistrer le retour
        </button>
      </div>
    </Modal>
  );
}

function ReturnDetail({ id, canCredit, onClose }: { id: string; canCredit: boolean; onClose: () => void }) {
  const toast = useToast();
  const r = useLoad(() => call('supplierReturns.get', id), [id]);
  const [credit, setCredit] = useState<{ number: string; date: string; ht: string; tva: string } | null>(null);
  if (!r.data) return null;
  const d = r.data;
  const saveCredit = async () => {
    if (!credit) return;
    try {
      const ht = parseAmount(credit.ht);
      await call('supplierReturns.credit', id, {
        supplierNumber: credit.number,
        invoiceDate: credit.date,
        totalHt: ht,
        totalTva: hasVat() ? parseAmount(credit.tva) : 0,
      });
      toast.ok('Avoir enregistré : il vient en déduction de ce que vous devez au fournisseur');
      setCredit(null);
      r.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={`Retour fournisseur ${d.number}`} onClose={onClose} wide>
      <p>
        <b>{d.supplier_name}</b> · {d.warehouse_name} · {dateTime(d.created_at)}
        {d.user_name ? ` · ${d.user_name}` : ''}
      </p>
      <p>Motif : {d.reason}</p>
      <table className="list compact">
        <thead>
          <tr>
            <th>Code</th>
            <th>Article</th>
            <th>Lot</th>
            <th className="r">Quantité</th>
            <th className="r">{tx('Prix HT')}</th>
            <th className="r">{tx('Total HT')}</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.code}</td>
              <td>{l.name}</td>
              <td>{[l.lot_number, l.expiry ? dateFr(l.expiry) : null].filter(Boolean).join(' · ')}</td>
              <td className="r">{qty(l.qty, l.unit)}</td>
              <td className="r">{fcfa(l.unit_cost)}</td>
              <td className="r">{fcfa(l.total_ht)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {tx('Total HT')} {fcfa(d.total_ht)}
        {hasVat() ? ` · TVA ${fcfa(d.total_tva)} · TTC ${fcfa(d.total_ttc)}` : ''}
      </p>
      {d.status === 'credited' ? (
        <p className="pos">
          Avoir reçu : {d.credit_note_number} pour {fcfa(d.credit_note_ttc ?? 0)}
        </p>
      ) : credit ? (
        <div className="grid3">
          <Field label="N° de l'avoir du fournisseur">
            <input value={credit.number} onChange={(e) => setCredit({ ...credit, number: e.target.value })} />
          </Field>
          <Field label="Date de l'avoir">
            <input type="date" value={credit.date} onChange={(e) => setCredit({ ...credit, date: e.target.value })} />
          </Field>
          <Field label={tx('Montant HT accordé')} hint="Par défaut : le montant du bon">
            <input inputMode="numeric" value={credit.ht} onChange={(e) => setCredit({ ...credit, ht: e.target.value })} />
          </Field>
          {hasVat() && (
            <Field label="TVA de l'avoir">
              <input inputMode="numeric" value={credit.tva} onChange={(e) => setCredit({ ...credit, tva: e.target.value })} />
            </Field>
          )}
        </div>
      ) : null}
      <div className="actions">
        <button onClick={() => call('supplierReturns.print', id).catch(toast.error)}>Imprimer le bon</button>
        {d.status === 'open' && canCredit && !credit && (
          <button className="primary" onClick={() => setCredit({ number: '', date: today(), ht: String(d.total_ht), tva: String(d.total_tva) })}>
            Saisir l'avoir reçu
          </button>
        )}
        {credit && (
          <button className="primary" disabled={!credit.number.trim()} onClick={saveCredit}>
            Enregistrer l'avoir
          </button>
        )}
        <button onClick={onClose}>Fermer</button>
      </div>
    </Modal>
  );
}
