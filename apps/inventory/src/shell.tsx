import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ManagerHome, ManagerProvider, ManagerScreen, openPcManagement, useManager, useManagerAttention } from './Manager';
import { type ModuleDef, type ModuleId, bottomTabs, groupsFor, modulesFor, roleLabel, screenFor } from './modules';
import * as S from './state';
import { AppHeader, EmptyState, Icon, ListItem, QuickAction, SectionTitle, StatCard, initials, recall, remember } from './ui';

/**
 * Cadre commun de l'appli connectée : la barre du bas, l'accueil et le menu Plus
 * sont construits à partir des droits envoyés par le serveur (`session.can`).
 * Chaque rôle voit la même interface, avec seulement ses modules.
 */

const useStore = () => useSyncExternalStore(S.subscribe, S.getState);
const fcfa = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} FCFA`;
const heure = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');

export interface ShellNav {
  go: (id: ModuleId) => void;
  /** Retour à l'accueil quand le module n'est pas dans la barre du bas. */
  back: (() => void) | null;
}

type Render = (id: ModuleId, nav: ShellNav) => ReactNode;

export function Shell({ render, settings }: { render: Render; settings: (onClose: () => void) => ReactNode }) {
  const s = useStore();
  const can = s.session?.can;
  return (
    <ManagerProvider enabled={Boolean(can?.manage)}>
      <ShellBody render={render} settings={settings} />
    </ManagerProvider>
  );
}

function ShellBody({ render, settings }: { render: Render; settings: (onClose: () => void) => ReactNode }) {
  const s = useStore();
  const manager = useManager();
  const can = s.session?.can;
  const mods = useMemo(() => modulesFor(can), [can]);
  const tabs = useMemo(() => bottomTabs(mods, can), [mods, can]);
  const [current, setCurrent] = useState<ModuleId | 'plus'>(() => {
    const saved = recall('onglet');
    return saved === 'plus' || mods.some((m) => m.id === saved && !m.external) ? (saved as ModuleId | 'plus') : 'accueil';
  });
  const [menu, setMenu] = useState(false);
  const go = (id: ModuleId | 'plus') => {
    const mod = mods.find((m) => m.id === id);
    if (mod?.external) return openPcManagement();
    setCurrent(id);
    remember('onglet', id);
    window.scrollTo(0, 0);
  };
  // Un droit retiré pendant que l'écran est ouvert : retour à l'accueil.
  useEffect(() => {
    if (current !== 'plus' && !mods.some((m) => m.id === current)) go('accueil');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mods]);
  // Notification touchée : ouvrir l'écran qu'elle concerne, s'il est ouvert à la personne.
  useEffect(() => {
    if (!s.openScreen) return;
    go(screenFor(s.openScreen, mods));
    S.setOpenScreen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.openScreen, mods]);

  const inBar = tabs.some((t) => t.id === current);
  const nav: ShellNav = { go, back: inBar ? null : () => go(current === 'plus' ? 'accueil' : 'plus') };
  let page: ReactNode;
  if (current === 'plus') page = <More mods={mods} go={go} onSettings={() => setMenu(true)} />;
  else if (current === 'accueil') page = <Home mods={mods} go={go} />;
  else if (['ventes', 'valider', 'stock', 'caisses', 'clients', 'equipe'].includes(current)) page = <ManagerScreen id={current} />;
  else page = render(current, nav);

  return (
    <div className="shell">
      <div className="shell-page" key={current}>
        {page}
      </div>
      <nav className="tabbar" aria-label="Navigation">
        {tabs.map((t) => (
          <TabButton key={t.id} mod={t} on={current === t.id} onClick={() => go(t.id)} badge={t.id === 'valider' ? (manager?.home?.approvals ?? 0) : 0} />
        ))}
        <button className={`tab ${current === 'plus' || !inBar ? 'on' : ''}`} onClick={() => go('plus')}>
          <Icon name="grid" />
          <span>Plus</span>
        </button>
      </nav>
      {menu ? settings(() => setMenu(false)) : null}
    </div>
  );
}

function TabButton({ mod, on, onClick, badge }: { mod: ModuleDef; on: boolean; onClick: () => void; badge: number }) {
  return (
    <button className={`tab ${on ? 'on' : ''}`} onClick={onClick} aria-current={on ? 'page' : undefined}>
      <Icon name={mod.icon} />
      <span>{mod.short}</span>
      {badge ? <i className="badge">{badge}</i> : null}
    </button>
  );
}

// ——— Ce qui demande l'attention ———

interface Attention {
  level: 'danger' | 'warning' | 'info';
  title: string;
  text?: string;
  action?: () => void;
}

/** Points d'attention de la personne, tirés de ses vraies données (rien d'inventé). */
function useAttention(mods: readonly ModuleDef[], go: (id: ModuleId) => void): Attention[] {
  const s = useStore();
  const manager = useManagerAttention();
  const has = (id: ModuleId) => mods.some((m) => m.id === id);
  const out: Attention[] = [];
  if (s.online === false) out.push({ level: 'warning', title: 'Hors ligne', text: 'Vos saisies restent sur le téléphone et partiront au retour du réseau.' });
  if (s.catalogError) out.push({ level: 'danger', title: 'Catalogue non téléchargé', text: s.catalogError, action: () => void S.refreshCatalog() });
  if (s.pending) out.push({ level: 'info', title: `${s.pending} saisie(s) à envoyer`, text: 'Touchez pour envoyer maintenant', action: () => void S.sync() });
  out.push(...manager.map((m) => ({ ...m, action: m.action })));
  if (has('vente')) {
    for (const c of s.sentCarts.filter((x) => x.status === 'returned'))
      out.push({ level: 'warning', title: `Panier n° ${c.number} rendu par la caisse`, text: c.note ?? undefined, action: () => go('vente') });
  }
  if (has('inventaires')) {
    const recount = s.inventories.reduce((n, i) => n + i.recount.length, 0);
    if (recount) out.push({ level: 'warning', title: `${recount} produit(s) à recompter`, text: 'Demandé par le gérant', action: () => go('inventaires') });
  }
  return out;
}

const ATTENTION_ICON = { danger: 'alert', warning: 'alert', info: 'upload' } as const;

function AttentionList({ items }: { items: Attention[] }) {
  return (
    <div className="list">
      {items.map((a, i) => (
        <ListItem key={i} icon={ATTENTION_ICON[a.level]} tone={a.level} title={a.title} detail={a.text} onClick={a.action} />
      ))}
    </div>
  );
}

// ——— Accueil ———

function Home({ mods, go }: { mods: ModuleDef[]; go: (id: ModuleId) => void }) {
  const s = useStore();
  const m = useManager();
  const user = s.session!.user;
  const attention = useAttention(mods, go);
  const [bell, setBell] = useState(false);
  const has = (id: ModuleId) => mods.some((x) => x.id === id);
  useEffect(() => {
    if (has('vente')) void S.loadSentCarts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const urgent = attention.filter((a) => a.level !== 'info').length;
  const quick = QUICK.filter((q) => has(q.id)).slice(0, 4);
  const hour = new Date().getHours();
  return (
    <div className="page">
      <header className="bar home-bar">
        <img className="bar-logo" src="./icon.png" alt="" />
        <div className="grow">
          <b>ONIX 360</b>
          <small>{s.config?.storeName}</small>
        </div>
        {m ? (
          <button className="ghost" onClick={m.load} aria-label="Actualiser">
            <Icon name="refresh" />
          </button>
        ) : null}
        <button className="ghost bell" onClick={() => setBell(true)} aria-label="Notifications">
          <Icon name="bell" />
          {urgent ? <i className="badge">{urgent}</i> : null}
        </button>
      </header>
      <main className="enter">
        <div className="greet">
          <span className="avatar">{initials(user.name)}</span>
          <div className="grow">
            <span className="muted small">{hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir'},</span>
            <b>{user.name}</b>
            <span className="role">
              {roleLabel(user.role)}
              <ConnectionDot />
            </span>
          </div>
        </div>
        {attention.length ? (
          <>
            <SectionTitle>À voir maintenant</SectionTitle>
            <AttentionList items={attention} />
          </>
        ) : null}
        {quick.length ? (
          <>
            <SectionTitle>Actions rapides</SectionTitle>
            <div className="quicks">
              {quick.map((q, i) => (
                <QuickAction key={q.id} icon={q.icon} label={q.label} primary={i === 0} onClick={() => go(q.id)} />
              ))}
            </div>
          </>
        ) : null}
        {/* Le gérant voit la journée du magasin ; le vendeur, la sienne. */}
        {m ? <ManagerHome /> : has('vente') ? <SellerWidget onOpen={() => go('vente')} /> : null}
        {has('inventaires') ? <InventoryWidget onOpen={() => go('inventaires')} /> : null}
        {!quick.length && !m && !has('vente') && !has('inventaires') ? (
          <EmptyState icon="user" title="Aucun module ouvert" text="Votre compte n’a pas encore de droit sur le téléphone. Demandez au gérant de vous l’ouvrir sur un PC." />
        ) : null}
      </main>
      {bell ? (
        <div className="modal" onClick={(e) => e.target === e.currentTarget && setBell(false)}>
          <div className="sheet">
            <div className="sheet-head">
              <h2>Notifications</h2>
              <button className="icon-btn" onClick={() => setBell(false)} aria-label="Fermer">
                <Icon name="x" />
              </button>
            </div>
            {attention.length ? (
              <AttentionList items={attention.map((a) => ({ ...a, action: a.action ? () => (setBell(false), a.action!()) : undefined }))} />
            ) : (
              <EmptyState icon="check-circle" title="Rien à signaler" text="Tout est à jour. Les alertes qui vous concernent apparaîtront ici." />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Actions rapides, dans l'ordre d'importance ; seules celles du rôle apparaissent. */
const QUICK: { id: ModuleId; label: string; icon: ModuleDef['icon'] }[] = [
  { id: 'vente', label: 'Nouveau panier', icon: 'cart' },
  { id: 'valider', label: 'À valider', icon: 'check-circle' },
  { id: 'sortie', label: 'Contrôler un ticket', icon: 'scan' },
  { id: 'reception', label: 'Réceptionner', icon: 'truck' },
  { id: 'inventaires', label: 'Compter', icon: 'clipboard' },
  { id: 'gestion', label: 'Gérer la boutique', icon: 'store' },
  { id: 'caisses', label: 'Voir les caisses', icon: 'wallet' },
];

function ConnectionDot() {
  const s = useStore();
  const off = s.online === false;
  return (
    <span className={`conn ${off ? 'off' : s.pending ? 'wait' : ''}`}>
      <i />
      {off ? 'Hors ligne' : s.syncing ? 'Envoi…' : s.pending ? `${s.pending} à envoyer` : 'Connecté'}
    </span>
  );
}

function SellerWidget({ onOpen }: { onOpen: () => void }) {
  const s = useStore();
  const waiting = s.sentCarts.filter((c) => (c.status ?? (c.takenAt ? 'taken' : 'waiting')) === 'waiting').length;
  const paid = s.sentCarts.filter((c) => c.status === 'paid').length;
  return (
    <>
      <SectionTitle
        action={
          <button className="see-all" onClick={onOpen}>
            Mes paniers <Icon name="chevron" size={16} />
          </button>
        }
      >
        Ma journée
      </SectionTitle>
      <div className="kpis">
        {s.sellerDay ? <StatCard icon="trend-up" label="Vendus à mon nom" value={fcfa(s.sellerDay.net)} hint={`${s.sellerDay.tickets} ticket(s)`} /> : null}
        <StatCard icon="cart" tone="warning" label="Paniers en attente" value={waiting} onClick={onOpen} />
        <StatCard icon="check-circle" tone="success" label="Paniers encaissés" value={paid} onClick={onOpen} />
      </div>
    </>
  );
}

function InventoryWidget({ onOpen }: { onOpen: () => void }) {
  const s = useStore();
  if (!s.inventories.length) return null;
  return (
    <>
      <SectionTitle>Inventaires en cours</SectionTitle>
      <div className="list">
        {s.inventories.slice(0, 3).map((inv) => {
          const counted = new Set(inv.counted.map((c) => c.articleId));
          for (const k of Object.keys(s.counts)) if (k.startsWith(`${inv.id}|`)) counted.add(k.split('|')[1]!);
          const pct = inv.articleIds.length ? Math.round((counted.size / inv.articleIds.length) * 100) : 0;
          return (
            <ListItem
              key={inv.id}
              icon="clipboard"
              tone="brand"
              title={`N° ${inv.number}${inv.label ? ` · ${inv.label}` : ''}`}
              detail={
                <>
                  <span className="gauge thin">
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  {counted.size} / {inv.articleIds.length} produits · {inv.warehouseName}
                </>
              }
              value={`${pct} %`}
              onClick={() => (remember('inventaire', inv.id), onOpen())}
            />
          );
        })}
      </div>
    </>
  );
}

// ——— Plus ———

function More({ mods, go, onSettings }: { mods: ModuleDef[]; go: (id: ModuleId) => void; onSettings: () => void }) {
  const s = useStore();
  const user = s.session!.user;
  return (
    <div className="page">
      <AppHeader title="Plus" subtitle={s.config?.storeName} />
      <main className="enter">
        <div className="profile">
          <span className="avatar big-avatar">{initials(user.name)}</span>
          <div className="grow">
            <b>{user.name}</b>
            <span className="role">{roleLabel(user.role)}</span>
            <small>
              ONIX 360 · {s.config?.storeName}
            </small>
            <ConnectionDot />
          </div>
        </div>
        {groupsFor(mods).map((g) => (
          <section key={g.id}>
            <SectionTitle>{g.label}</SectionTitle>
            <div className="list grouped">
              {g.modules.map((m) => (
                <ListItem key={m.id} icon={m.icon} tone="brand" title={m.label} detail={m.hint} onClick={() => go(m.id)} />
              ))}
            </div>
          </section>
        ))}
        <section>
          <SectionTitle>Ce téléphone</SectionTitle>
          <div className="list grouped">
            <ListItem
              icon="refresh"
              title="Envoyer et actualiser"
              detail={s.lastSync ? `Dernier échange à ${heure(s.lastSync)}` : 'Pas encore d’échange'}
              onClick={() => void S.sync()}
            />
            <ListItem icon="sliders" title="Réglages" detail="Catalogue, adresse du serveur, délier" onClick={onSettings} />
            <ListItem icon="logout" title="Changer d’utilisateur" detail="Se déconnecter de ce téléphone" onClick={() => void S.logout()} />
          </div>
        </section>
        <p className="muted small center">ONIX 360 Mobile {__APP_VERSION__}</p>
      </main>
    </div>
  );
}
