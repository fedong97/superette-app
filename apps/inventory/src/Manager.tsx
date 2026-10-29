import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { type Article, formatQty, search } from './logic';
import * as S from './state';

/**
 * Espace du gérant sur le téléphone (ONIX 360 Mobile) : la journée du
 * magasin, la semaine et le mois, les vendeurs, les caisses et leurs écarts,
 * le stock (ruptures, fiche d'un article, changement de prix), les commandes
 * fournisseurs, les crédits clients et les demandes d'accord des caisses.
 * En boutique sur le Wi-Fi, ou à l'extérieur par le serveur internet.
 */

const useStore = () => useSyncExternalStore(S.subscribe, S.getState);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fcfa = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} FCFA`;
const heure = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
const jour = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

interface Register {
  id: string;
  name: string;
  state: 'open' | 'closed' | 'idle';
  cashier: string | null;
  openedAt: string | null;
  closedAt: string | null;
  sales: number;
  total: number;
  silent: boolean;
}

interface StoreBoard {
  id: string;
  name: string;
  sales: number;
  total: number;
  returns: number;
  net: number;
  average: number;
  yesterday: number;
  byMethod: { method: string; label: string; amount: number }[];
  byHour: number[];
  top: { label: string; qty: number; total: number }[];
  sellers?: { id: string; name: string; tickets: number; total: number }[];
  registers: Register[];
  gaps: { register: string; cashier: string | null; closedAt: string | null; expected: number; counted: number; difference: number; reason: string | null }[];
  outOfStock: { name: string; qty: number; alert: number; unit: string }[];
  outOfStockCount: number;
  lowStock: { name: string; qty: number; alert: number; unit: string }[];
  lowStockCount: number;
}

interface Home {
  day: string;
  today: boolean;
  generatedAt: string;
  store: StoreBoard | null;
  alerts: { level: 'erreur' | 'alerte'; text: string }[];
  periods: { today: string; week: { day: string; total: number; tickets: number }[]; month: { total: number; tickets: number }; lastMonth: { total: number; tickets: number } };
  floor: {
    carts: { seller: string; count: number; total: number }[];
    invoices: { status: string; count: number; total: number }[];
    missed: { label: string; times: number; qty: number; reason: string; last: string }[];
  };
  approvals: number;
  write: boolean;
}

interface Approval {
  id: string;
  register: string | null;
  action: string;
  requestedBy: string | null;
  at: string;
  expiresAt: string;
}

interface Order {
  id: string;
  number: string;
  supplier: string;
  orderDate: string;
  expectedDate: string | null;
  late: boolean;
  lines: number;
  partial: boolean;
}

interface Receivables {
  total: number;
  overdue: number;
  count: number;
  customers: { id: string; name: string; phone: string | null; balance: number; overdue: number; limit: number }[];
}

interface ArticleFile {
  id: string;
  name: string;
  price: number;
  basePrice: number;
  storePrice: number | null;
  wholesale: number | null;
  superWholesale: number | null;
  cost: number;
  margin: number | null;
  alertQty: number;
  stock: { warehouseId: string; warehouse: string; store: string; here: boolean; qty: number }[];
  nextDelivery: { number: string; expectedDate: string; qty: number } | null;
}

type Tab = 'jour' | 'vendeurs' | 'caisses' | 'stock' | 'clients';

const TABS: [Tab, string][] = [
  ['jour', 'Journée'],
  ['vendeurs', 'Vendeurs'],
  ['caisses', 'Caisses'],
  ['stock', 'Stock'],
  ['clients', 'Clients'],
];

const INVOICE_STATUS: Record<string, string> = { waiting: 'à encaisser', editing: 'en modification', returned: 'rendues au vendeur', paying: 'en cours d’encaissement' };
const MISSED: Record<string, string> = { absent: 'pas en magasin', rupture: 'en rupture', prix: 'trop cher', autre: 'autre' };

export function Manager({ onBack }: { onBack: (() => void) | null }) {
  const s = useStore();
  const [tab, setTab] = useState<Tab>('jour');
  const [yesterday, setYesterday] = useState(false);
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState('');
  const [approvals, setApprovals] = useState(false);

  const load = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const day = yesterday ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
    S.call<Home>(`/manager${day ? `?day=${day}` : ''}`).then(
      (h) => (setHome(h), setError('')),
      (e) => setError(message(e)),
    );
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yesterday]);

  const st = home?.store ?? null;
  return (
    <div className="page">
      <header className="bar">
        {onBack ? (
          <button className="ghost" onClick={onBack} aria-label="Retour">
            ‹
          </button>
        ) : null}
        <div className="grow">
          <b>Gérant · {s.config?.storeName}</b>
          <small>{home ? `${home.today ? 'Mis à jour' : 'Journée d’hier'} à ${heure(home.generatedAt)}` : s.session?.user.name}</small>
        </div>
        <button className="ghost" onClick={load} aria-label="Actualiser">
          ⟳
        </button>
        {!onBack ? (
          <button className="ghost" onClick={() => void S.logout()} aria-label="Changer d'utilisateur">
            ⎋
          </button>
        ) : null}
      </header>
      <main>
        <div className="tabs">
          {TABS.map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        {error ? <div className="notice erreur">{error}</div> : null}
        {!home && !error ? <div className="card muted">Chargement…</div> : null}
        {home && home.approvals ? (
          <button className="big primary" onClick={() => setApprovals(true)}>
            {home.approvals} demande(s) d’accord des caisses
          </button>
        ) : null}
        {home && st && tab === 'jour' ? <DayTab home={home} st={st} yesterday={yesterday} onDay={setYesterday} /> : null}
        {home && st && tab === 'vendeurs' ? <SellersTab home={home} st={st} /> : null}
        {home && st && tab === 'caisses' ? <RegistersTab st={st} /> : null}
        {home && st && tab === 'stock' ? <StockTab home={home} st={st} /> : null}
        {home && tab === 'clients' ? <CustomersTab /> : null}
        {home && !st ? <div className="card muted">Aucune donnée de ce magasin sur le serveur pour l’instant : les PC l’envoient à leur prochaine synchronisation.</div> : null}
      </main>
      {approvals ? <ApprovalsSheet write={Boolean(home?.write)} onClose={() => (setApprovals(false), load())} /> : null}
    </div>
  );
}

function Bars({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="bars">
      {values.map((v, i) => (
        <div key={i} title={`${labels[i]} : ${fcfa(v)}`}>
          <span style={{ height: `${Math.max(2, Math.round((v / max) * 100))}%` }} />
          <small>{labels[i]}</small>
        </div>
      ))}
    </div>
  );
}

function DayTab({ home, st, yesterday, onDay }: { home: Home; st: StoreBoard; yesterday: boolean; onDay: (y: boolean) => void }) {
  const p = home.periods;
  const vsYesterday = pct(st.net, st.yesterday);
  const vsMonth = pct(p.month.total, p.lastMonth.total);
  const hours = st.byHour.map((v, h) => ({ v, h })).filter((x) => x.v > 0 || (x.h >= 7 && x.h <= 21));
  return (
    <>
      <div className="segmented">
        <button className={!yesterday ? 'on' : ''} onClick={() => onDay(false)}>
          Aujourd’hui
        </button>
        <button className={yesterday ? 'on' : ''} onClick={() => onDay(true)}>
          Hier
        </button>
      </div>
      <div className="kpis">
        <div>
          <b>{fcfa(st.net)}</b>
          <small>ventes nettes{vsYesterday !== null && !yesterday ? ` · ${vsYesterday >= 0 ? '+' : ''}${vsYesterday} % / hier` : ''}</small>
        </div>
        <div>
          <b>{st.sales}</b>
          <small>tickets · {fcfa(st.average)} en moyenne</small>
        </div>
        <div>
          <b>{fcfa(p.month.total)}</b>
          <small>
            ce mois-ci{vsMonth !== null ? ` · ${vsMonth >= 0 ? '+' : ''}${vsMonth} % / mois dernier à la même date` : ''}
          </small>
        </div>
        <div>
          <b>{fcfa(st.returns)}</b>
          <small>retours clients</small>
        </div>
      </div>
      {home.alerts.length ? (
        <div className="list">
          {home.alerts.map((a, i) => (
            <div key={i} className={`notice ${a.level === 'erreur' ? 'erreur' : 'attention'}`}>
              {a.text}
            </div>
          ))}
        </div>
      ) : null}
      <h3>Les 7 derniers jours</h3>
      <Bars values={p.week.map((d) => d.total)} labels={p.week.map((d) => jour(d.day))} />
      <h3>Par heure</h3>
      <Bars values={hours.map((x) => x.v)} labels={hours.map((x) => `${x.h}h`)} />
      <h3>Paiements</h3>
      <div className="list">
        {st.byMethod.map((m) => (
          <div key={m.method} className="row item">
            <span className="grow">{m.label}</span>
            <b>{fcfa(m.amount)}</b>
          </div>
        ))}
        {!st.byMethod.length ? <div className="empty">Aucun paiement.</div> : null}
      </div>
      <h3>En ce moment au magasin</h3>
      <div className="list">
        {home.floor.carts.map((c) => (
          <div key={c.seller} className="row item">
            <span className="grow">
              Paniers de {c.seller}
              <small>en attente d’une caisse</small>
            </span>
            <b>
              {c.count} · {fcfa(c.total)}
            </b>
          </div>
        ))}
        {home.floor.invoices.map((i) => (
          <div key={i.status} className="row item">
            <span className="grow">Factures {INVOICE_STATUS[i.status] ?? i.status}</span>
            <b>
              {i.count} · {fcfa(i.total)}
            </b>
          </div>
        ))}
        {!home.floor.carts.length && !home.floor.invoices.length ? <div className="empty">Aucun panier ni facture en attente.</div> : null}
      </div>
      <h3>Meilleures ventes</h3>
      <div className="list">
        {st.top.map((t) => (
          <div key={t.label} className="row item">
            <span className="grow">{t.label}</span>
            <b>{fcfa(t.total)}</b>
          </div>
        ))}
        {!st.top.length ? <div className="empty">Aucune vente.</div> : null}
      </div>
    </>
  );
}

function SellersTab({ home, st }: { home: Home; st: StoreBoard }) {
  const sellers = st.sellers ?? [];
  const max = Math.max(1, ...sellers.map((x) => x.total));
  return (
    <>
      <p className="muted small">Ventes encaissées {home.today ? 'aujourd’hui' : 'ce jour-là'} au nom de chaque vendeur (le vendeur du panier ou de la facture, sinon le caissier).</p>
      <div className="list">
        {sellers.map((x) => (
          <div key={x.id} className="card">
            <div className="row">
              <b className="grow">{x.name}</b>
              <b>{fcfa(x.total)}</b>
            </div>
            <div className="gauge">
              <div style={{ width: `${Math.round((x.total / max) * 100)}%` }} />
            </div>
            <small className="muted">
              {x.tickets} ticket(s) · {fcfa(x.tickets ? x.total / x.tickets : 0)} en moyenne
              {st.total ? ` · ${Math.round((x.total / st.total) * 100)} % du magasin` : ''}
            </small>
          </div>
        ))}
        {!sellers.length ? <div className="empty">Aucune vente encore.</div> : null}
      </div>
      {home.floor.carts.length ? (
        <>
          <h3>Paniers au rayon en attente</h3>
          <div className="list">
            {home.floor.carts.map((c) => (
              <div key={c.seller} className="row item">
                <span className="grow">{c.seller}</span>
                <b>
                  {c.count} · {fcfa(c.total)}
                </b>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function RegistersTab({ st }: { st: StoreBoard }) {
  return (
    <>
      <div className="list">
        {st.registers.map((r) => (
          <div key={r.id} className="card">
            <div className="row">
              <b className="grow">{r.name}</b>
              <span className={`pill ${r.state === 'open' ? (r.silent ? 'ko' : 'ok') : r.state === 'closed' ? 'off' : 'off'}`}>
                {r.state === 'open' ? (r.silent ? 'Ouverte, PC muet' : 'Ouverte') : r.state === 'closed' ? 'Fermée' : 'Pas ouverte'}
              </span>
            </div>
            <small className="muted">
              {r.cashier ? `${r.cashier} · ` : ''}
              {r.state === 'open' ? `depuis ${heure(r.openedAt)}` : r.closedAt ? `fermée à ${heure(r.closedAt)}` : ''}
              {` · ${r.sales} ticket(s) · ${fcfa(r.total)}`}
            </small>
          </div>
        ))}
        {!st.registers.length ? <div className="empty">Aucune caisse.</div> : null}
      </div>
      <h3>Écarts de caisse</h3>
      <div className="list">
        {st.gaps.map((g, i) => (
          <div key={i} className="row item">
            <span className="grow">
              {g.register}
              {g.cashier ? ` · ${g.cashier}` : ''}
              <small>
                attendu {fcfa(g.expected)} · compté {fcfa(g.counted)}
                {g.reason ? ` · ${g.reason}` : ' · pas encore justifié'}
              </small>
            </span>
            <b className={g.difference < 0 ? 'discount' : ''}>
              {g.difference > 0 ? '+' : ''}
              {fcfa(g.difference)}
            </b>
          </div>
        ))}
        {!st.gaps.length ? <div className="empty">Aucun écart.</div> : null}
      </div>
    </>
  );
}

function StockTab({ home, st }: { home: Home; st: StoreBoard }) {
  const s = useStore();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Article | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  useEffect(() => {
    S.call<{ orders: Order[] }>('/manager/orders').then(
      (r) => setOrders(r.orders),
      () => setOrders([]),
    );
  }, []);
  const results = useMemo(() => (query.trim().length >= 2 ? search(s.catalog?.articles ?? [], query, 30) : []), [query, s.catalog]);
  const byName = (name: string) => (s.catalog?.articles ?? []).find((a) => a.name === name) ?? null;
  const row = (r: { name: string; qty: number; alert: number; unit: string }) => {
    const a = byName(r.name);
    return (
      <div key={r.name} className="row item" onClick={a ? () => setOpen(a) : undefined}>
        <span className="grow">
          {r.name}
          {r.alert ? <small>seuil {a ? formatQty(r.alert, a) : r.alert / 1000}</small> : null}
        </span>
        <b className={r.qty <= 0 ? 'discount' : 'warn'}>{a ? formatQty(r.qty, a) : r.qty / 1000}</b>
      </div>
    );
  };
  return (
    <>
      <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Chercher un article (nom ou code)" enterKeyHint="search" />
      {query.trim().length >= 2 ? (
        <div className="list">
          {results.map((a) => (
            <div key={a.id} className="row item" onClick={() => setOpen(a)}>
              <span className="grow">
                {a.name}
                <small>
                  {a.code}
                  {a.price ? ` · ${fcfa(a.price)}` : ''}
                </small>
              </span>
              <span className="chev">›</span>
            </div>
          ))}
          {!results.length ? <div className="empty">Aucun article trouvé.</div> : null}
        </div>
      ) : (
        <>
          <h3>Ruptures ({st.outOfStockCount})</h3>
          <div className="list">
            {st.outOfStock.slice(0, 40).map(row)}
            {!st.outOfStock.length ? <div className="empty">Aucune rupture.</div> : null}
          </div>
          <h3>Stock bas ({st.lowStockCount})</h3>
          <div className="list">
            {st.lowStock.slice(0, 40).map(row)}
            {!st.lowStock.length ? <div className="empty">Rien sous le seuil d’alerte.</div> : null}
          </div>
          <h3>Ce que les clients demandaient (7 jours)</h3>
          <div className="list">
            {home.floor.missed.map((m) => (
              <div key={m.label} className="row item">
                <span className="grow">
                  {m.label}
                  <small>{MISSED[m.reason] ?? m.reason}</small>
                </span>
                <b>{m.times} fois</b>
              </div>
            ))}
            {!home.floor.missed.length ? <div className="empty">Aucune demande notée par les vendeurs.</div> : null}
          </div>
          <h3>Commandes fournisseurs en cours</h3>
          <div className="list">
            {(orders ?? []).map((o) => (
              <div key={o.id} className="row item">
                <span className="grow">
                  {o.number} · {o.supplier}
                  <small>
                    {o.lines} ligne(s){o.partial ? ' · reçue en partie' : ''}
                  </small>
                </span>
                <span className={`pill ${o.late ? 'ko' : 'info'}`}>{o.expectedDate ? `${o.late ? 'En retard, ' : ''}${o.expectedDate.split('-').reverse().join('/')}` : 'Sans date'}</span>
              </div>
            ))}
            {orders && !orders.length ? <div className="empty">Aucune commande en attente de livraison.</div> : null}
            {!orders ? <div className="empty">Chargement…</div> : null}
          </div>
        </>
      )}
      {open ? <ArticleSheet article={open} write={home.write} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function ArticleSheet({ article, write, onClose }: { article: Article; write: boolean; onClose: () => void }) {
  const [file, setFile] = useState<ArticleFile | null>(null);
  const [error, setError] = useState('');
  const [price, setPrice] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const load = () =>
    S.call<ArticleFile>(`/manager/articles/${encodeURIComponent(article.id)}`).then(
      (f) => (setFile(f), setPrice(String(f.price))),
      (e) => setError(message(e)),
    );
  useEffect(() => void load(), [article.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const wanted = Number(price.replace(/\s/g, ''));
  const changed = file && Number.isSafeInteger(wanted) && wanted > 0 && wanted !== file.price;
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <h2>{article.name}</h2>
        {error ? <div className="notice erreur">{error}</div> : null}
        {!file && !error ? <div className="muted">Recherche…</div> : null}
        {file ? (
          <>
            <div className="facts">
              <div>
                <small className="muted">Prix de détail</small>
                <br />
                {fcfa(file.price)}
              </div>
              <div>
                <small className="muted">Coût d’achat</small>
                <br />
                {file.cost ? fcfa(file.cost) : '—'}
              </div>
              <div>
                <small className="muted">Marge</small>
                <br />
                {file.margin !== null ? `${file.margin.toLocaleString('fr-FR')} %` : '—'}
              </div>
              <div>
                <small className="muted">Gros · super gros</small>
                <br />
                {file.wholesale ? fcfa(file.wholesale) : '—'} · {file.superWholesale ? fcfa(file.superWholesale) : '—'}
              </div>
            </div>
            <h3>Stock</h3>
            <div className="list">
              {file.stock.map((w) => (
                <div key={w.warehouseId} className="row item">
                  <span className="grow">
                    {w.warehouse}
                    <small>{w.here ? 'ce magasin' : w.store}</small>
                  </span>
                  <b className={w.qty > 0 ? '' : 'muted'}>{formatQty(w.qty, article)}</b>
                </div>
              ))}
              {!file.stock.length ? <div className="empty">Aucun stock connu.</div> : null}
            </div>
            <p className="muted small">
              {file.nextDelivery
                ? `Prochaine livraison : ${formatQty(file.nextDelivery.qty, article)} le ${file.nextDelivery.expectedDate.split('-').reverse().join('/')} (bon ${file.nextDelivery.number}).`
                : 'Aucune commande en cours pour cet article.'}
            </p>
            {write ? (
              <>
                <h3>Changer le prix de détail de ce magasin</h3>
                <input inputMode="numeric" value={price} onChange={(e) => (setPrice(e.target.value.replace(/[^\d]/g, '')), setDone(''))} aria-label="Nouveau prix" />
                {changed ? (
                  <>
                    <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="Votre code pour confirmer" />
                    <button
                      className="big primary"
                      disabled={busy || pin.length < 4}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          const r = await S.call<{ price: number }>(`/manager/articles/${encodeURIComponent(article.id)}/price`, { price: wanted, pin });
                          setDone(`Nouveau prix : ${fcfa(r.price)}. Les caisses le reçoivent à leur prochaine synchronisation.`);
                          setPin('');
                          await load();
                        } catch (e) {
                          setError(message(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {busy ? 'Envoi…' : `Passer à ${fcfa(wanted)}`}
                    </button>
                  </>
                ) : null}
                {done ? <div className="notice info">{done}</div> : null}
              </>
            ) : null}
          </>
        ) : null}
        <button className="link" onClick={onClose}>
          Fermer
        </button>
      </div>
    </div>
  );
}

function CustomersTab() {
  const [data, setData] = useState<{ receivables: Receivables | null; at: string | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    S.call<{ receivables: Receivables | null; at: string | null }>('/manager/receivables').then(setData, (e) => setError(message(e)));
  }, []);
  const r = data?.receivables;
  const digits = (phone: string) => {
    const d = phone.replace(/\D/g, '');
    return d.length === 9 ? `237${d}` : d;
  };
  return (
    <>
      {error ? <div className="notice erreur">{error}</div> : null}
      {!data && !error ? <div className="card muted">Chargement…</div> : null}
      {data && !r ? <div className="card muted">Les crédits clients arrivent avec l’état des PC (toutes les 5 minutes). Mettez les PC du magasin en version 0.98.0 ou plus.</div> : null}
      {r ? (
        <>
          <div className="kpis">
            <div>
              <b>{fcfa(r.total)}</b>
              <small>dus par {r.count} client(s)</small>
            </div>
            <div>
              <b className={r.overdue ? 'discount' : ''}>{fcfa(r.overdue)}</b>
              <small>en retard</small>
            </div>
          </div>
          <p className="muted small">D’après les PC, à {heure(data!.at)}. Appelez ou écrivez au client pour le relancer.</p>
          <div className="list">
            {r.customers.map((c) => (
              <div key={c.id} className="card">
                <div className="row">
                  <b className="grow">{c.name}</b>
                  <b>{fcfa(c.balance)}</b>
                </div>
                <small className="muted">
                  {c.overdue ? <span className="discount">{fcfa(c.overdue)} en retard · </span> : null}
                  {c.limit ? `plafond ${fcfa(c.limit)}` : 'sans plafond'}
                </small>
                {c.phone ? (
                  <div className="row">
                    <a className="small-btn" href={`tel:${c.phone.replace(/\s/g, '')}`}>
                      Appeler
                    </a>
                    <a
                      className="small-btn"
                      href={`https://wa.me/${digits(c.phone)}?text=${encodeURIComponent(`Bonjour ${c.name}, votre solde chez nous est de ${fcfa(c.balance)}. Merci de passer le régler.`)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      WhatsApp
                    </a>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function ApprovalsSheet({ write, onClose }: { write: boolean; onClose: () => void }) {
  const [list, setList] = useState<Approval[] | null>(null);
  const [error, setError] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState('');
  const load = () =>
    S.call<{ approvals: Approval[] }>('/manager/approvals').then(
      (r) => setList(r.approvals),
      (e) => setError(message(e)),
    );
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, []);
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    setError('');
    try {
      await S.call(`/manager/approvals/${encodeURIComponent(id)}`, approve ? { approve, pin } : { approve });
      setPin('');
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <h2>Demandes d’accord</h2>
        {!write ? <p className="muted">Téléphone en consultation seule : répondez depuis un PC ou demandez à passer le téléphone du gérant en « Gestion ».</p> : null}
        {error ? <div className="notice erreur">{error}</div> : null}
        {write ? (
          <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="Votre code (pour accepter)" />
        ) : null}
        <div className="list">
          {(list ?? []).map((a) => (
            <div key={a.id} className="card">
              <b>{a.action}</b>
              <small className="muted">
                {a.requestedBy ?? 'Caisse'}
                {a.register ? ` · ${a.register}` : ''} · {heure(a.at)} (expire à {heure(a.expiresAt)})
              </small>
              {write ? (
                <div className="row">
                  <button className="small-btn primary grow" disabled={busy === a.id || pin.length < 4} onClick={() => void decide(a.id, true)}>
                    Accepter
                  </button>
                  <button className="small-btn grow" disabled={busy === a.id} onClick={() => void decide(a.id, false)}>
                    Refuser
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {list && !list.length ? <div className="empty">Aucune demande en attente.</div> : null}
        </div>
        <button className="link" onClick={onClose}>
          Fermer
        </button>
      </div>
    </div>
  );
}
