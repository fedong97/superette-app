import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateFr, dateTime, fcfa, openScreen, parseAmount, parseQty, qty, today, useCan, useLoad, useToast } from '../ui';
import { ArticlePicker } from './pickers';

/**
 * Le magasin au quotidien (0.81.0) : tâches du jour, réassort du rayon,
 * ventes manquées, calendrier des fournisseurs, prix à revoir, tableau de
 * l'équipe, rapport mensuel du propriétaire, état des PC et « avant de clôturer ».
 */

const DAY_NAMES = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const num = (milli: number) => String(milli / 1000).replace('.', ',');
const weekday = (d: string) => DAY_NAMES[((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1];

// --- Tâches du jour -----------------------------------------------------------------

export function DayTasks({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const tasks = useLoad(() => call('tasks.today'), []);
  useEffect(() => {
    const t = setInterval(tasks.reload, 120_000);
    return () => clearInterval(t);
  }, []);
  const list = tasks.data ?? [];
  if (compact && !list.length) return null;
  const left = list.filter((t) => !t.done).length;
  return (
    <div className={compact ? 'day-tasks compact' : 'day-tasks'}>
      <h2>
        Tâches du jour {list.length > 0 && <small className="muted">· {left === 0 ? 'tout est fait' : `${left} à faire`}</small>}
      </h2>
      {!list.length && <Empty>Rien d'attendu aujourd'hui : pas de réception prévue, pas de transfert en attente, rien à monter en rayon.</Empty>}
      <ul>
        {list.map((t) => (
          <li key={t.key} className={t.done ? 'done' : ''}>
            <label>
              <input
                type="checkbox"
                checked={t.done}
                onChange={(e) =>
                  call('tasks.check', t.key, e.target.checked).then(
                    () => tasks.reload(),
                    (err) => toast.error(err),
                  )
                }
              />
              <span>
                {t.label}
                {t.detail && <small className="muted"> · {t.detail}</small>}
              </span>
            </label>
            <button type="button" className="link" onClick={() => openScreen(t.open[0], t.open[1])}>
              Ouvrir
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Réassort du rayon -----------------------------------------------------------------

export function Restock() {
  const toast = useToast();
  const plan = useLoad(() => call('restock.list'), []);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const rows = plan.data?.rows ?? [];
  useEffect(() => {
    setQtys(Object.fromEntries(rows.map((r) => [r.article_id, num(r.qty)])));
    setSkip(new Set());
  }, [plan.data]);
  if (!plan.data) return null;
  if (!plan.data.shop) return <Empty>Ce magasin n'a pas de surface de vente : déclarez-la dans Administration › Dépôts.</Empty>;
  const chosen = rows.filter((r) => !skip.has(r.article_id));
  const packText = (r: (typeof rows)[number], q: number) => (r.pack_units && q % r.pack_units === 0 && q > 0 ? ` (${q / r.pack_units} ${r.pack_name?.toLowerCase()})` : '');
  return (
    <>
      <header className="page-head">
        <h2>Réassort du rayon · {weekday(today())} {dateFr(today())}</h2>
        <button type="button" onClick={() => window.print()} className="ghost" title="Imprimer la liste pour la tournée">
          Imprimer
        </button>
      </header>
      <p className="muted">
        Ce qu'il faut monter de la réserve vers « {plan.data.shop.name} », rangé par dépôt et par emplacement. La quantité à garder en rayon se règle sur la fiche du produit ; sans réglage,
        c'est deux jours de ventes.
      </p>
      {!rows.length ? (
        <Empty>Le rayon est plein : rien à monter pour l'instant.</Empty>
      ) : (
        <>
          <table className="list">
            <thead>
              <tr>
                <th></th>
                <th>Emplacement</th>
                <th>Produit</th>
                <th>Rayon</th>
                <th className="r">En rayon</th>
                <th className="r">À garder</th>
                <th>Depuis</th>
                <th className="r">En réserve</th>
                <th>À monter</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const q = parseQty(qtys[r.article_id] ?? '') ?? 0;
                return (
                  <tr key={r.article_id} className={skip.has(r.article_id) ? 'inactive' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={!skip.has(r.article_id)}
                        onChange={(e) => {
                          const next = new Set(skip);
                          if (e.target.checked) next.delete(r.article_id);
                          else next.add(r.article_id);
                          setSkip(next);
                        }}
                      />
                    </td>
                    <td>
                      <b>{r.location ?? '—'}</b>
                    </td>
                    <td>
                      {r.name} <small className="muted">{r.code}</small>
                    </td>
                    <td>{r.department_name}</td>
                    <td className={`r ${r.shelf <= 0 ? 'neg' : ''}`}>{qty(r.shelf, r.unit)}</td>
                    <td className="r">
                      {qty(r.target, r.unit)}
                      {!r.target_set && <small className="muted block">2 jours de ventes</small>}
                    </td>
                    <td>{r.from_name}</td>
                    <td className="r">{qty(r.available, r.unit)}</td>
                    <td>
                      <input className="qty" value={qtys[r.article_id] ?? ''} onChange={(e) => setQtys({ ...qtys, [r.article_id]: e.target.value })} />
                      <small className="muted">{packText(r, q)}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="actions">
            <span className="muted">{chosen.length} produit(s) cochés</span>
            <button
              type="button"
              className="primary"
              disabled={busy || !chosen.length}
              onClick={async () => {
                setBusy(true);
                try {
                  const lines = chosen.map((r) => ({ articleId: r.article_id, fromWarehouseId: r.from_warehouse_id, qty: parseQty(qtys[r.article_id] ?? '') ?? 0 })).filter((l) => l.qty > 0);
                  const done = await call('restock.apply', lines);
                  toast.ok(`${done.lines} produit(s) montés en rayon (${done.transfers} transfert${done.transfers > 1 ? 's' : ''})`);
                  plan.reload();
                } catch (e) {
                  toast.error(e);
                }
                setBusy(false);
              }}
            >
              Transférer en rayon
            </button>
          </div>
        </>
      )}
    </>
  );
}

// --- Ventes manquées -----------------------------------------------------------------

const REASONS = { rupture: 'En rupture', absent: 'Pas vendu au magasin', prix: 'Trop cher', autre: 'Autre' } as const;
type Reason = keyof typeof REASONS;

/** « Le client voulait… » : la demande est notée en quelques secondes, à la caisse ou au comptoir. */
export function MissedSaleDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [article, setArticle] = useState<{ id: string; name: string } | null>(null);
  const [label, setLabel] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState<Reason>('rupture');
  const [note, setNote] = useState('');
  const mine = useLoad(() => call('missed.mine'), []);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const save = async () => {
    try {
      await call('missed.record', { articleId: article?.id ?? null, label: article ? null : label, qty: parseQty(quantity) ?? 1000, reason: article ? reason : reason === 'rupture' ? 'absent' : reason, note: note || null });
      toast.ok(`Noté : le client voulait ${article?.name ?? label}`);
      onClose();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title="Le client voulait…" onClose={onClose}>
      <p className="muted">Notez ce que le client a demandé et que vous n'avez pas pu lui vendre. Le gérant voit les produits les plus demandés et la commande en tient compte.</p>
      {article ? (
        <p>
          <b>{article.name}</b>{' '}
          <button type="button" className="link" onClick={() => setArticle(null)}>
            changer
          </button>
        </p>
      ) : (
        <>
          <ArticlePicker placeholder="Produit du catalogue : scanner ou rechercher" onPick={(a) => setArticle({ id: a.id, name: a.name })} />
          <Field label="Ou un produit que le magasin ne vend pas" hint="Par exemple « Lait Nido 900 g », « couches taille 5 »">
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </>
      )}
      <div className="grid3">
        <Field label="Quantité demandée">
          <input className="qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Pourquoi">
          <select value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
            {(Object.keys(REASONS) as Reason[]).filter((r) => article || r !== 'rupture').map((r) => (
              <option key={r} value={r}>
                {REASONS[r]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Remarque (facultatif)">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {Boolean(mine.data?.length) && (
        <details>
          <summary className="muted">Mes demandes notées aujourd'hui ({mine.data!.length})</summary>
          <ul className="plain">
            {mine.data!.filter((m) => !hidden.has(m.id)).map((m) => (
              <li key={m.id}>
                {m.label} × {num(m.qty)} <small className="muted">{dateTime(m.created_at)}</small>{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setHidden((h) => new Set(h).add(m.id));
                    toast.later(`Demande « ${m.label} » retirée`, () => call('missed.remove', m.id).then(mine.reload, toast.error), () => setHidden((h) => (h.delete(m.id), new Set(h))));
                  }}
                >
                  retirer
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="actions">
        <button type="button" onClick={onClose}>
          Annuler
        </button>
        <button type="button" className="primary" disabled={!article && label.trim().length < 2} onClick={() => void save()}>
          Noter la demande
        </button>
      </div>
    </Modal>
  );
}

export function MissedReport() {
  const can = useCan();
  const [days, setDays] = useState(30);
  const top = useLoad(() => call('missed.top', days), [days]);
  const recent = useLoad(() => call('missed.list', { from: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) }), [days]);
  const [noting, setNoting] = useState(false);
  return (
    <>
      <div className="filters">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 derniers jours</option>
          <option value={30}>30 derniers jours</option>
          <option value={90}>3 derniers mois</option>
        </select>
        <span className="muted">Les demandes de produits du catalogue comptent dans la proposition de commande.</span>
        {can('missed_sale') && (
          <button type="button" style={{ marginLeft: 'auto' }} onClick={() => setNoting(true)}>
            Le client voulait…
          </button>
        )}
      </div>
      <h3>Les plus demandés</h3>
      {top.data?.length === 0 ? (
        <Empty>Aucune vente manquée notée sur la période. Le bouton « Le client voulait… » de la caisse les note en 5 secondes.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Produit</th>
              <th className="r">Demandes</th>
              <th className="r">Quantité</th>
              <th>Raison principale</th>
              <th className="r">Stock actuel</th>
              <th>Dernière demande</th>
            </tr>
          </thead>
          <tbody>
            {(top.data ?? []).map((t) => (
              <tr key={t.key}>
                <td>
                  {t.label}
                  {!t.article_id && <small className="tag alerte"> hors catalogue</small>}
                </td>
                <td className="r">
                  <b>{t.times}</b>
                </td>
                <td className="r">{num(t.qty)}</td>
                <td>{REASONS[t.reason as Reason] ?? t.reason}</td>
                <td className={`r ${t.stock !== null && t.stock <= 0 ? 'neg' : ''}`}>{t.stock === null ? '' : num(t.stock)}</td>
                <td>{dateTime(t.last_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Demandes notées</h3>
      <table className="list compact">
        <thead>
          <tr>
            <th>Date</th>
            <th>Produit</th>
            <th className="r">Quantité</th>
            <th>Raison</th>
            <th>Noté par</th>
            <th>Remarque</th>
          </tr>
        </thead>
        <tbody>
          {(recent.data ?? []).map((m) => (
            <tr key={m.id}>
              <td>{dateTime(m.created_at)}</td>
              <td>{m.label}</td>
              <td className="r">{num(m.qty)}</td>
              <td>{REASONS[m.reason as Reason]}</td>
              <td>
                {m.user_name}
                {m.source === 'phone' && <small className="muted"> (téléphone)</small>}
              </td>
              <td>{m.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {noting && <MissedSaleDialog onClose={() => (setNoting(false), top.reload(), recent.reload())} />}
    </>
  );
}

// --- Calendrier des fournisseurs ----------------------------------------------------------

export function SupplierCalendar({ onReorder }: { onReorder: () => void }) {
  const toast = useToast();
  const can = useCan();
  const cal = useLoad(() => call('suppliers.calendar'), []);
  const suppliers = useLoad(() => call('suppliers.list'), []);
  const [editing, setEditing] = useState<{ id: string; name: string; days: number[] } | null>(null);
  const tomorrow = new Date(Date.parse(`${today()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return (
    <>
      <p className="muted">
        Le jour de passage de chaque fournisseur. La veille, sa proposition de commande est prête et signalée dans les tâches du jour. Les jours se règlent fournisseur par fournisseur.
      </p>
      <div className="filters">
        {can('supplier_edit', 'supplier_calendar') && (
          <select
            value=""
            onChange={(e) => {
              const f = suppliers.data?.find((x) => x.id === e.target.value);
              const known = cal.data?.find((c) => c.supplier_id === e.target.value);
              if (f) setEditing({ id: f.id, name: f.name, days: known?.days ?? [] });
            }}
          >
            <option value="">Régler les jours de passage d'un fournisseur…</option>
            {(suppliers.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {cal.data?.length === 0 ? (
        <Empty>Aucun jour de passage réglé. Choisissez un fournisseur ci-dessus et cochez ses jours.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Fournisseur</th>
              <th>Passe le</th>
              <th>Prochain passage</th>
              <th className="r">Articles à commander</th>
              <th className="r">Montant estimé</th>
              <th>Bon en cours</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(cal.data ?? []).map((v) => {
              const soon = v.next_visit === today() || v.next_visit === tomorrow;
              return (
                <tr key={v.supplier_id} className={soon ? 'selected' : ''}>
                  <td>
                    <b>{v.supplier_name}</b>
                    {v.phone && <small className="muted block">{v.phone}</small>}
                  </td>
                  <td>{v.days.length ? v.days.map((d) => DAY_NAMES[d]).join(', ') : <span className="muted">non réglé</span>}</td>
                  <td>
                    {v.next_visit ? `${weekday(v.next_visit)} ${dateFr(v.next_visit)}` : ''}
                    {v.next_visit === today() && <span className="tag alerte"> aujourd'hui</span>}
                    {v.next_visit === tomorrow && <span className="tag surstock"> demain</span>}
                  </td>
                  <td className="r">{v.to_order || ''}</td>
                  <td className="r">{v.amount ? fcfa(v.amount) : ''}</td>
                  <td>{v.open_order}</td>
                  <td>
                    {can('supplier_edit', 'supplier_calendar') && (
                      <button type="button" className="link" onClick={() => setEditing({ id: v.supplier_id, name: v.supplier_name, days: v.days })}>
                        Jours
                      </button>
                    )}{' '}
                    {v.to_order > 0 && (
                      <button type="button" className="link" onClick={onReorder}>
                        Proposition
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editing && (
        <Modal title={`Jours de passage : ${editing.name}`} onClose={() => setEditing(null)}>
          <div className="day-picks">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <label key={d}>
                <input
                  type="checkbox"
                  checked={editing.days.includes(d)}
                  onChange={(e) => setEditing({ ...editing, days: e.target.checked ? [...editing.days, d].sort() : editing.days.filter((x) => x !== d) })}
                />
                {DAY_NAMES[d]}
              </label>
            ))}
          </div>
          <div className="actions">
            <button type="button" onClick={() => setEditing(null)}>
              Annuler
            </button>
            <button
              type="button"
              className="primary"
              onClick={async () => {
                try {
                  await call('suppliers.setVisitDays', editing.id, editing.days);
                  toast.ok('Jours de passage enregistrés');
                  setEditing(null);
                  cal.reload();
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              Enregistrer
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// --- Prix à revoir ------------------------------------------------------------------------

export function PriceReview() {
  const toast = useToast();
  const can = useCan();
  const rows = useLoad(() => call('prices.review'), []);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Set<string>>(new Set());
  const list = (rows.data ?? []).filter((r) => !done.has(r.article_id));
  const total = list.reduce((t, r) => t + r.lost_30d, 0);
  return (
    <>
      <p className="muted">
        Articles dont le prix d'achat a monté à la dernière réception sans que le prix de vente bouge. Le prix proposé retrouve le taux de marque d'avant, arrondi à 5 FCFA ; les prix des
        cartons et du gros suivent dans la même proportion.
      </p>
      {rows.data && !list.length ? (
        <Empty>Aucun prix à revoir : chaque hausse d'achat a été suivie d'un nouveau prix de vente.</Empty>
      ) : (
        <>
          <p>
            Marge perdue sur les 30 derniers jours : <b className="neg">{fcfa(total)}</b>
          </p>
          <table className="list">
            <thead>
              <tr>
                <th>Produit</th>
                <th>Fournisseur</th>
                <th className="r">Achat avant</th>
                <th className="r">Achat maintenant</th>
                <th>Hausse le</th>
                <th className="r">Prix de vente</th>
                <th className="r">Marque avant</th>
                <th className="r">Marque maintenant</th>
                <th className="r">Perdu / 30 j</th>
                <th>Nouveau prix</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.article_id}>
                  <td>
                    {r.name} <small className="muted">{r.code}</small>
                  </td>
                  <td>{r.supplier_name}</td>
                  <td className="r">{fcfa(r.prev_cost)}</td>
                  <td className="r neg">{fcfa(r.last_cost)}</td>
                  <td>{dateFr(r.raised_at.slice(0, 10))}</td>
                  <td className="r">{fcfa(r.sale_price)}</td>
                  <td className="r">{String(r.prev_rate).replace('.', ',')} %</td>
                  <td className="r neg">{String(r.rate).replace('.', ',')} %</td>
                  <td className="r">{fcfa(r.lost_30d)}</td>
                  <td>
                    <input className="qty" value={prices[r.article_id] ?? String(r.suggested_price)} onChange={(e) => setPrices({ ...prices, [r.article_id]: e.target.value })} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="primary"
                      disabled={!can('article_price')}
                      title={can('article_price') ? 'Mettre ce prix de vente' : "Il faut le droit de modifier les prix"}
                      onClick={async () => {
                        const price = parseAmount(prices[r.article_id] ?? String(r.suggested_price));
                        if (!price) return toast.error('Prix invalide');
                        try {
                          await call('prices.applyReview', r.article_id, price);
                          toast.ok(`${r.name} : nouveau prix ${fcfa(price)}`);
                          setDone(new Set(done).add(r.article_id));
                        } catch (e) {
                          toast.error(e);
                        }
                      }}
                    >
                      Appliquer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

// --- Tableau de l'équipe ------------------------------------------------------------------

const ROLE = { manager: 'Gérant', cashier: 'Caissier', seller: 'Vendeur', buyer: 'Appro', stock: 'Magasinier', accountant: 'Comptable', admin: 'Administrateur' } as Record<string, string>;

function mondayOf(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  return new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function TeamBoard() {
  const [from, setFrom] = useState(() => mondayOf(today()));
  const to = addDays(from, 6);
  const rows = useLoad(() => call('team.week', from, to), [from]);
  const list = rows.data ?? [];
  const max = (pick: (r: (typeof list)[number]) => number) => Math.max(0, ...list.map(pick));
  const hi = (v: number, top: number) => (v > 0 && v === top ? 'neg' : '');
  const mmss = (s: number | null) => (s === null ? '' : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`);
  return (
    <>
      <div className="filters">
        <button type="button" onClick={() => setFrom(addDays(from, -7))}>
          ◀ Semaine d'avant
        </button>
        <b>
          Semaine du {dateFr(from)} au {dateFr(to)}
        </b>
        <button type="button" disabled={from >= mondayOf(today())} onClick={() => setFrom(addDays(from, 7))}>
          Semaine suivante ▶
        </button>
      </div>
      <p className="muted">Chaque caissier et vendeur côte à côte. En rouge : le plus haut de l'équipe pour les gestes à surveiller.</p>
      {rows.data && !list.length ? (
        <Empty>Aucune vente cette semaine.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Personne</th>
              <th className="r">Tickets encaissés</th>
              <th className="r">Montant</th>
              <th className="r">Panier moyen</th>
              <th className="r">Entre 2 tickets</th>
              <th className="r">Annulations</th>
              <th className="r">Remises</th>
              <th className="r">Retours</th>
              <th className="r">Manquants</th>
              <th className="r">Ventes comme vendeur</th>
              <th className="r">Panier vendeur</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.user_id}>
                <td>
                  <b>{r.name}</b> <small className="muted">{ROLE[r.role] ?? r.role}</small>
                </td>
                <td className="r">{r.tickets || ''}</td>
                <td className="r">{r.sales ? fcfa(r.sales) : ''}</td>
                <td className="r">{r.average ? fcfa(r.average) : ''}</td>
                <td className="r">{mmss(r.seconds_per_ticket)}</td>
                <td className={`r ${hi(r.cancellations, max((x) => x.cancellations))}`}>{r.cancellations ? `${r.cancellations} · ${fcfa(r.cancellations_amount)}` : ''}</td>
                <td className={`r ${hi(r.discounts_amount, max((x) => x.discounts_amount))}`}>{r.discounts ? `${r.discounts} · ${fcfa(r.discounts_amount)}` : ''}</td>
                <td className={`r ${hi(r.returns, max((x) => x.returns))}`}>{r.returns || ''}</td>
                <td className={`r ${r.shortage ? 'neg' : ''}`}>{r.shortage ? fcfa(r.shortage) : ''}</td>
                <td className="r">{r.seller_tickets ? `${r.seller_tickets} · ${fcfa(r.seller_sales)}` : ''}</td>
                <td className="r">{r.seller_average ? fcfa(r.seller_average) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// --- Rapport mensuel du propriétaire ---------------------------------------------------------

export function OwnerReport() {
  const toast = useToast();
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const r = useLoad(() => call('owner.report', month), [month]);
  const digest = useLoad(() => call('digest.config').catch(() => null), []);
  const [phone, setPhone] = useState('');
  useEffect(() => {
    if (!phone && digest.data?.whatsapp) setPhone(digest.data.whatsapp);
  }, [digest.data]);
  const rep = r.data;
  const evo = (a: number, b: number) => (b ? `${a >= b ? '+' : ''}${Math.round(((a - b) / Math.abs(b)) * 100)} %` : '');
  const lines: [string, keyof NonNullable<typeof rep>['current']][] = [
    ['Ventes TTC', 'sales_ttc'],
    ['Marge brute', 'margin'],
    ['Dépenses', 'expenses'],
    ['Stock', 'stock'],
    ['Crédit clients', 'receivables'],
    ['Trésorerie', 'treasury'],
    ['Dettes fournisseurs', 'payables'],
  ];
  const digits = phone.replace(/\D/g, '');
  return (
    <>
      <div className="filters">
        <Field label="Mois">
          <input type="month" value={month} max={today().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </Field>
        <Field label="WhatsApp du propriétaire">
          <input value={phone} placeholder="237 6xx xx xx xx" onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      {rep && (
        <>
          <table className="list owner-report">
            <thead>
              <tr>
                <th></th>
                <th className="r">Ce mois</th>
                <th className="r">Mois d'avant</th>
                <th className="r">Évolution</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(([label, k]) => (
                <tr key={k}>
                  <td>{label}</td>
                  <td className="r">
                    <b>{fcfa(rep.current[k] as number)}</b>
                  </td>
                  <td className="r">{fcfa(rep.previous[k] as number)}</td>
                  <td className="r">{evo(rep.current[k] as number, rep.previous[k] as number)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            {rep.current.tickets} tickets · taux de marge {String(rep.current.margin_rate).replace('.', ',')} % (mois d'avant {String(rep.previous.margin_rate).replace('.', ',')} %)
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={async () => {
                try {
                  if (await call('owner.reportPdf', month)) toast.ok('Rapport enregistré en PDF : joignez-le au message WhatsApp');
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              Enregistrer en PDF
            </button>
            <a className="button primary" href={`https://wa.me/${digits.length >= 8 ? digits : ''}?text=${encodeURIComponent(rep.text)}`} target="_blank" rel="noreferrer">
              Envoyer par WhatsApp
            </a>
          </div>
        </>
      )}
    </>
  );
}

// --- État des PC --------------------------------------------------------------------------------

export function Stations() {
  const st = useLoad(() => call('stations.all'), []);
  useEffect(() => {
    const t = setInterval(st.reload, 60_000);
    return () => clearInterval(t);
  }, []);
  const hours = (iso: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : Infinity);
  const latest = (st.data?.devices ?? []).reduce((v, d) => (d.appVersion && d.appVersion > v ? d.appVersion : v), '');
  return (
    <>
      <header className="page-head">
        <h2>État des PC</h2>
        <button type="button" onClick={st.reload}>
          Actualiser
        </button>
      </header>
      <p className="muted">
        Chaque PC donne son état au serveur toutes les 5 minutes : dernière synchronisation, version, sauvegarde, imprimante et licence. En rouge, ce qui demande d'y aller voir.
        {st.data && !st.data.linked && ' Ce PC n’est pas relié au serveur : seul son propre état est connu.'}
      </p>
      {st.error ? <Empty>{String((st.error as Error).message ?? st.error)}</Empty> : null}
      <table className="list">
        <thead>
          <tr>
            <th>PC</th>
            <th>Vu par le serveur</th>
            <th>Synchronisation</th>
            <th>Version</th>
            <th>Sauvegarde</th>
            <th>Imprimante</th>
            <th>Licence</th>
          </tr>
        </thead>
        <tbody>
          {(st.data?.devices ?? []).map((d) => {
            const s = d.status;
            const seenLate = hours(d.lastSeenAt) > 1;
            const syncLate = !s || hours(s.lastSyncAt) > 1 || Boolean(s.syncError);
            const backupLate = !s || hours(s.backupAt) > 48 || Boolean(s.backupError);
            const oldVersion = Boolean(latest && d.appVersion && d.appVersion < latest);
            return (
              <tr key={d.deviceId} className={seenLate || syncLate || backupLate || (s && !s.license.canSell) ? 'station-alert' : ''}>
                <td>
                  <b>{s?.name ?? d.name}</b>
                  {s?.register && <small className="muted block">{s.register}</small>}
                  {d.self && <small className="tag normal"> ce PC</small>}
                </td>
                <td className={seenLate ? 'neg' : ''}>{d.lastSeenAt ? dateTime(d.lastSeenAt) : 'jamais'}</td>
                <td className={syncLate ? 'neg' : ''}>
                  {s?.lastSyncAt ? dateTime(s.lastSyncAt) : 'jamais'}
                  {s && s.pending > 0 && <small className="block">{s.pending} en attente</small>}
                  {s?.syncError && <small className="block">{s.syncError}</small>}
                </td>
                <td className={oldVersion ? 'neg' : ''}>
                  {d.appVersion ?? s?.version ?? ''}
                  {oldVersion && <small className="block">à mettre à jour</small>}
                </td>
                <td className={backupLate ? 'neg' : ''}>
                  {s?.backupAt ? dateTime(s.backupAt) : 'aucune'}
                  {s?.backupError && <small className="block">{s.backupError}</small>}
                </td>
                <td className={s && (!s.printer || !s.printerEnabled) ? 'warn-text' : ''}>
                  {s?.printer ?? 'non réglée'}
                  {s && !s.printerEnabled && <small className="block">impression coupée</small>}
                </td>
                <td className={s && !s.license.canSell ? 'neg' : s?.license.daysLeft !== null && (s?.license.daysLeft ?? 99) < 15 ? 'warn-text' : ''}>
                  {s?.license.message ?? ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// --- Avant de clôturer -------------------------------------------------------------------------

/** Ce qui reste ouvert sur la caisse avant la clôture ; rien ne bloque, le caissier décide. */
export function BeforeClose({ registerId }: { registerId?: string }) {
  const items = useLoad(() => call('treasury.beforeClose', registerId), [registerId]);
  const list = items.data ?? [];
  if (!items.data) return null;
  return (
    <div className={`before-close ${list.length ? 'open' : 'clear'}`}>
      <h3>Avant de clôturer</h3>
      {!list.length ? (
        <p>Rien ne reste ouvert : pas de ticket en attente, pas de paiement Mobile Money à confirmer, pas de livraison dehors.</p>
      ) : (
        <ul>
          {list.map((i) => (
            <li key={i.key}>
              <b>
                {i.count} · {i.label}
              </b>
              <small className="block">{i.detail.slice(0, 5).join(' ; ')}{i.detail.length > 5 ? '…' : ''}</small>
              {i.open && (
                <button type="button" className="link" onClick={() => openScreen(i.open![0], i.open![1])}>
                  Ouvrir
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type DayTask = Result<'tasks.today'>[number];
