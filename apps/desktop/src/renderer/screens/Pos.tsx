import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CartLine, computeTotals, lineTotal } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, fcfa, parseAmount, parseQty, qty, useLoad, useToast } from '../ui';
import { CancelDialog, CashOpDialog, CloseDialog, HeldDialog, PaymentDialog, ReturnDialog } from './PosDialogs';

type Article = Result<'catalogue.get'>;
type User = NonNullable<Result<'app.state'>['user']>;

export interface PosLine extends CartLine {
  key: number;
  unit: Article['unit'];
  barcode: string | null;
}

let keySeq = 0;

function toLine(article: Article, qtyMilli: number, barcode: string | null, fixedAmount?: number): PosLine {
  return {
    key: ++keySeq,
    articleId: article.id,
    label: article.name,
    unit: article.unit,
    unitPrice: article.store_price,
    qty: qtyMilli,
    vatRate: article.vat_rate_bp,
    discount: 0,
    fixedAmount,
    barcode,
  };
}

type Dialog = null | 'pay' | 'close' | 'held' | 'cancel' | 'return' | 'cashIn' | 'cashOut' | 'search' | 'weight' | 'discount';

export function Pos({ user, hasRegister }: { user: User; hasRegister: boolean }) {
  const toast = useToast();
  const session = useLoad(() => call('pos.session'), []);
  const quickKeys = useLoad(() => call('catalogue.quickKeys'), []);
  const [lines, setLines] = useState<PosLine[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [searchResults, setSearchResults] = useState<Article[]>([]);
  const [weightFor, setWeightFor] = useState<Article | null>(null);
  const [lastSale, setLastSale] = useState<Result<'pos.sell'> | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const totals = useMemo(() => computeTotals(lines), [lines]);

  const focusScan = useCallback(() => setTimeout(() => scanRef.current?.focus(), 0), []);
  useEffect(() => {
    if (!dialog) focusScan();
  }, [dialog, focusScan]);

  const addLine = (line: PosLine) => {
    setLines((ls) => {
      // Même article à la pièce sans remise : on cumule la quantité.
      const same = line.fixedAmount === undefined && line.unit === 'piece' ? ls.find((l) => l.articleId === line.articleId && !l.discount && l.fixedAmount === undefined) : undefined;
      if (same) {
        setSelected(same.key);
        return ls.map((l) => (l === same ? { ...l, qty: l.qty + line.qty } : l));
      }
      setSelected(line.key);
      return [...ls, line];
    });
    setLastSale(null);
  };

  const addArticle = (article: Article, multiplier = 1000) => {
    if (article.unit !== 'piece' && multiplier === 1000) {
      setWeightFor(article);
      setDialog('weight');
      return;
    }
    addLine(toLine(article, multiplier, null));
  };

  const onScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = input.trim();
    if (!raw) {
      if (lines.length) setDialog('pay');
      return;
    }
    setInput('');
    // « 3*code » : multiplie la quantité scannée.
    const m = /^(\d+(?:[.,]\d+)?)\*(.*)$/.exec(raw);
    const mult = m ? parseQty(m[1]!) : null;
    const code = m ? m[2]!.trim() : raw;
    try {
      const hit = await call('catalogue.scan', code);
      if (hit) {
        if (hit.fixedAmount !== undefined || hit.article.unit === 'piece' || hit.qty !== 1000) {
          const q = mult ? Math.round((hit.qty * mult) / 1000) : hit.qty;
          addLine(toLine(hit.article, q, hit.barcode, hit.fixedAmount));
        } else {
          addArticle(hit.article, mult ?? 1000);
        }
        return;
      }
      const found = await call('catalogue.search', code);
      if (found.length === 1) addArticle(found[0]!, mult ?? 1000);
      else if (found.length === 0) toast.error(`Article introuvable : ${code}`);
      else {
        setSearchResults(found);
        setDialog('search');
      }
    } catch (err) {
      toast.error(err);
    }
  };

  const changeQty = (key: number, delta: number) =>
    setLines((ls) => ls.map((l) => (l.key === key && l.fixedAmount === undefined ? { ...l, qty: Math.max(1000, l.qty + delta) } : l)));
  const removeLine = (key: number) => {
    setLines((ls) => ls.filter((l) => l.key !== key));
    setSelected(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      if (e.key === 'F2') {
        e.preventDefault();
        setInput('');
        focusScan();
      } else if (e.key === 'F4' && lines.length) {
        e.preventDefault();
        void hold();
      } else if (e.key === 'F8' && lines.length) {
        e.preventDefault();
        setDialog('pay');
      } else if (e.key === 'Delete' && selected !== null && !input) {
        removeLine(selected);
      } else if ((e.key === '+' || e.key === '-') && selected !== null && !input) {
        e.preventDefault();
        changeQty(selected, e.key === '+' ? 1000 : -1000);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const saleInput = () => lines.map((l) => ({ articleId: l.articleId, qty: l.qty, barcode: l.barcode, discount: l.discount }));

  const hold = async () => {
    const label = `Ticket de ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} (${fcfa(totals.totalTtc)})`;
    try {
      await call('pos.hold', label, saleInput());
      setLines([]);
      toast.ok('Ticket mis en attente');
    } catch (err) {
      toast.error(err);
    }
  };

  const resume = async (id: string) => {
    try {
      const saved = await call('pos.resume', id);
      const priced = await call('pos.priceLines', saved);
      const arts = await Promise.all(priced.map((p) => call('catalogue.get', p.articleId)));
      setLines(priced.map((p, i) => ({ ...p, key: ++keySeq, unit: arts[i]!.unit, barcode: p.barcode })));
      setDialog(null);
    } catch (err) {
      toast.error(err);
    }
  };

  if (!hasRegister) return <Empty>Ce poste n'est pas activé comme caisse. Activez-le depuis Administration, Caisses.</Empty>;
  if (!session.data) return session.data === null ? <OpenSession onOpened={session.reload} /> : null;

  const sel = lines.find((l) => l.key === selected);

  return (
    <div className="pos-screen">
      <section className="pos-left">
        <form onSubmit={onScan} className="scan">
          <input
            ref={scanRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Scanner ou taper un code, un nom… (3*code pour 3 unités)"
            autoFocus
          />
          <button className="primary" type="submit">
            Ajouter
          </button>
        </form>
        <div className="cart">
          {lines.length === 0 ? (
            lastSale ? (
              <div className="last-sale">
                <div>Ticket {lastSale.number}</div>
                {lastSale.change_given > 0 && (
                  <div className="change">
                    Rendu monnaie <strong>{fcfa(lastSale.change_given)}</strong>
                  </div>
                )}
                <button className="ghost" onClick={() => call('pos.printTicket', lastSale.id).catch(toast.error)}>
                  Réimprimer le ticket
                </button>
              </div>
            ) : (
              <Empty>Scannez un article pour commencer.</Empty>
            )
          ) : (
            <table className="lines">
              <thead>
                <tr>
                  <th>Article</th>
                  <th className="r">Qté</th>
                  <th className="r">Prix</th>
                  <th className="r">Total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className={l.key === selected ? 'sel' : ''} onClick={() => setSelected(l.key)}>
                    <td>
                      {l.label}
                      {l.discount > 0 && <small className="discount"> remise {fcfa(l.discount)}</small>}
                    </td>
                    <td className="r">{qty(l.qty, l.unit)}</td>
                    <td className="r">{fcfa(l.unitPrice)}</td>
                    <td className="r">{fcfa(lineTotal(l))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="line-tools">
          <button disabled={!sel || sel.fixedAmount !== undefined} onClick={() => sel && changeQty(sel.key, 1000)}>
            + 1
          </button>
          <button disabled={!sel || sel.fixedAmount !== undefined} onClick={() => sel && changeQty(sel.key, -1000)}>
            − 1
          </button>
          <button disabled={!sel} onClick={() => setDialog('discount')}>
            Remise
          </button>
          <button className="danger" disabled={!sel} onClick={() => sel && removeLine(sel.key)}>
            Supprimer la ligne
          </button>
          <button className="danger ghost" disabled={!lines.length} onClick={() => confirm('Vider le ticket en cours ?') && setLines([])}>
            Vider le ticket
          </button>
        </div>
      </section>

      <section className="pos-right">
        <div className="total">
          <small>{totals.itemCount} article(s)</small>
          <div>{fcfa(totals.totalTtc)}</div>
          {totals.totalDiscount > 0 && <small>dont remises {fcfa(totals.totalDiscount)}</small>}
        </div>
        <button className="primary pay" disabled={!lines.length} onClick={() => setDialog('pay')}>
          Encaisser (F8)
        </button>
        <div className="quick">
          {(quickKeys.data ?? []).map((a) => (
            <button key={a.id} onClick={() => addArticle(a)}>
              {a.name}
              <small>{fcfa(a.store_price)}{a.unit !== 'piece' ? ` / ${a.unit === 'kg' ? 'kg' : 'L'}` : ''}</small>
            </button>
          ))}
        </div>
        <div className="pos-menu">
          <button onClick={hold} disabled={!lines.length}>
            Mettre en attente (F4)
          </button>
          <button onClick={() => setDialog('held')}>Tickets en attente</button>
          <button onClick={() => setDialog('cancel')}>Annuler un ticket</button>
          <button onClick={() => setDialog('return')}>Retour client</button>
          <button onClick={() => setDialog('cashIn')}>Apport espèces</button>
          <button onClick={() => setDialog('cashOut')}>Prélèvement</button>
          <button className="danger" onClick={() => (lines.length ? toast.error('Terminez ou mettez en attente le ticket en cours') : setDialog('close'))}>
            Clôture de caisse (Z)
          </button>
        </div>
        <small className="muted">
          Caisse ouverte par {session.data.user_name} · fond {fcfa(session.data.opening_float)}
        </small>
      </section>

      {dialog === 'pay' && (
        <PaymentDialog
          total={totals.totalTtc}
          needsSupervisor={totals.totalDiscount > 0 && user.role === 'cashier'}
          onClose={() => setDialog(null)}
          onPaid={async (payments, supervisorPin) => {
            const sale = await call('pos.sell', { lines: saleInput(), payments, supervisorPin });
            setLines([]);
            setLastSale(sale);
            setDialog(null);
            call('pos.printTicket', sale.id).catch((err) => toast.error(err));
          }}
        />
      )}
      {dialog === 'search' && (
        <Modal title="Choisir l'article" onClose={() => setDialog(null)}>
          <div className="pick-list">
            {searchResults.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setDialog(null);
                  addArticle(a);
                }}
              >
                <span>{a.name}</span>
                <span>{fcfa(a.store_price)}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {dialog === 'weight' && weightFor && (
        <WeightDialog
          article={weightFor}
          onClose={() => setDialog(null)}
          onDone={(q) => {
            addLine(toLine(weightFor, q, null));
            setDialog(null);
          }}
        />
      )}
      {dialog === 'discount' && sel && (
        <DiscountDialog
          line={sel}
          onClose={() => setDialog(null)}
          onDone={(discount) => {
            setLines((ls) => ls.map((l) => (l.key === sel.key ? { ...l, discount } : l)));
            setDialog(null);
          }}
        />
      )}
      {dialog === 'held' && <HeldDialog onClose={() => setDialog(null)} onResume={resume} />}
      {dialog === 'cancel' && <CancelDialog sessionId={session.data.id} onClose={() => setDialog(null)} />}
      {dialog === 'return' && <ReturnDialog onClose={() => setDialog(null)} />}
      {(dialog === 'cashIn' || dialog === 'cashOut') && (
        <CashOpDialog type={dialog === 'cashIn' ? 'IN' : 'OUT'} needsSupervisor={user.role === 'cashier'} onClose={() => setDialog(null)} />
      )}
      {dialog === 'close' && (
        <CloseDialog
          sessionId={session.data.id}
          onClose={() => setDialog(null)}
          onClosed={() => {
            setDialog(null);
            session.reload();
          }}
        />
      )}
    </div>
  );
}

function OpenSession({ onOpened }: { onOpened: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  return (
    <div className="center-page">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = parseAmount(amount || '0');
          if (v === null) return toast.error('Montant invalide');
          try {
            await call('pos.open', v);
            onOpened();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <h2>Ouverture de caisse</h2>
        <Field label="Fond de caisse (FCFA)" hint="Espèces présentes dans le tiroir à l'ouverture">
          <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        </Field>
        <button className="primary big" type="submit">
          Ouvrir la caisse
        </button>
      </form>
    </div>
  );
}

function WeightDialog({ article, onClose, onDone }: { article: Article; onClose: () => void; onDone: (qty: number) => void }) {
  const [value, setValue] = useState('');
  const q = parseQty(value);
  return (
    <Modal title={article.name} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q) onDone(q);
        }}
      >
        <Field label={`Quantité en ${article.unit === 'kg' ? 'kg' : 'litres'}`} hint={`Prix : ${fcfa(article.store_price)} / ${article.unit === 'kg' ? 'kg' : 'L'}`}>
          <input autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="1,250" />
        </Field>
        {q && <p className="big-total">{fcfa(Math.round((article.store_price * q) / 1000))}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={!q}>
            Ajouter
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DiscountDialog({ line, onClose, onDone }: { line: PosLine; onClose: () => void; onDone: (discount: number) => void }) {
  const gross = lineTotal({ ...line, discount: 0 });
  const [mode, setMode] = useState<'pct' | 'amount'>('pct');
  const [value, setValue] = useState('');
  const n = Number(value.replace(',', '.'));
  const discount = !value ? 0 : mode === 'pct' ? Math.round((gross * n) / 100) : Math.round(n);
  const valid = Number.isFinite(n) && discount >= 0 && discount <= gross;
  return (
    <Modal title={`Remise sur ${line.label}`} onClose={onClose}>
      <div className="tabs">
        <button className={mode === 'pct' ? 'active' : ''} onClick={() => setMode('pct')}>
          En %
        </button>
        <button className={mode === 'amount' ? 'active' : ''} onClick={() => setMode('amount')}>
          En FCFA
        </button>
      </div>
      <Field label={mode === 'pct' ? 'Pourcentage' : 'Montant'} hint={`Ligne : ${fcfa(gross)}. Remise validée par le gérant à l'encaissement.`}>
        <input autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      {valid && discount > 0 && <p>Nouveau total de la ligne : {fcfa(gross - discount)}</p>}
      <div className="actions">
        <button className="ghost" onClick={() => onDone(0)}>
          Retirer la remise
        </button>
        <button className="primary" disabled={!valid} onClick={() => onDone(discount)}>
          Appliquer
        </button>
      </div>
    </Modal>
  );
}
