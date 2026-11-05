import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ManagerHome, ManagerProvider, ManagerScreen, openPcManagement, useManager, useManagerAttention } from './Manager';
import { type Permission, type UserRole, roleRights, userRights } from '@superette/core/src/permissions';
import { type ModuleDef, type ModuleId, bottomTabs, groupsFor, modulesFor, pcLinks, quickActions, roleLabel, screenFor } from './modules';
import * as S from './state';
import { AppHeader, EmptyState, Icon, ListItem, QuickAction, SectionTitle, StatCard, initials, recall, remember } from './ui';

/**
 * Cadre commun de l'appli connectée : menu latéral, barre du bas, accueil et
 * menu Plus sont construits à partir des droits existants (téléphone et PC).
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

interface PcState {
  online: number;
  rights: string[] | null;
}

/**
 * Droits du PC de la personne (écrans de gestion), calculés comme sur les PC
 * (@superette/core) à partir de son rôle et de ses privilèges ; null si le
 * serveur ne les donne pas (ancienne version) : le menu complet reste alors là.
 */
function usePcAccess(enabled: boolean): PcState | null {
  const [pc, setPc] = useState<PcState | null>(null);
  useEffect(() => {
    if (!enabled) return setPc(null);
    let alive = true;
    const load = () =>
      S.call<{ online: number; rights?: { role: string; roleRights: Record<string, boolean>; grants: string[]; revokes: string[]; delegation: { by: string; byName: string; until: string; rights: string[] } | null } }>('/pc/status').then(
        (r) => {
          if (!alive) return;
          const x = r.rights;
          const role = x?.role as UserRole | undefined;
          const rights = x && role
            ? userRights(role, roleRights(role, x.roleRights as Partial<Record<Permission, boolean>>), {
                grants: x.grants as Permission[],
                revokes: x.revokes as Permission[],
                delegation: x.delegation ? { ...x.delegation, rights: x.delegation.rights as Permission[], at: '' } : null,
              })
            : null;
          setPc({ online: r.online, rights });
        },
        () => alive && setPc((p) => p ?? { online: 0, rights: null }),
      );
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return pc;
}

function ShellBody({ render, settings }: { render: Render; settings: (onClose: () => void) => ReactNode }) {
  const s = useStore();
  const manager = useManager();
  const can = s.session?.can;
  const pc = usePcAccess(can?.manage === 'full');
  const mods = useMemo(() => modulesFor({ can, pc: pc?.rights ?? null }), [can, pc]);
  const tabs = useMemo(() => bottomTabs(mods, can), [mods, can]);
  const [current, setCurrent] = useState<ModuleId | 'plus'>(() => {
    const saved = recall('onglet');
    return saved === 'plus' || mods.some((m) => m.id === saved && !m.pc) ? (saved as ModuleId | 'plus') : 'accueil';
  });
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [bell, setBell] = useState(false);
  const go = (id: ModuleId | 'plus') => {
    setDrawer(false);
    const mod = mods.find((m) => m.id === id);
    if (mod?.pc) return openPcManagement(mod.id === 'gestion' ? undefined : mod.pc);
    setCurrent(id);
    remember('onglet', id);
    window.scrollTo(0, 0);
  };
  const attention = useAttention(mods, go, () => setMenu(true));
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
  // Bouton « retour » d'Android : fermer le menu ouvert.
  useEffect(() => {
    if (!drawer) return;
    history.pushState({ menu: 1 }, '');
    const close = () => setDrawer(false);
    window.addEventListener('popstate', close);
    return () => window.removeEventListener('popstate', close);
  }, [drawer]);

  const urgent = attention.filter((a) => a.level !== 'info').length;
  const inBar = tabs.some((t) => t.id === current);
  const nav: ShellNav = { go, back: inBar ? null : () => go(current === 'plus' ? 'accueil' : 'plus') };
  let page: ReactNode;
  if (current === 'plus') page = <More mods={mods} pcOnline={pc?.online ?? null} go={go} onSettings={() => setMenu(true)} onBell={() => setBell(true)} urgent={urgent} />;
  else if (current === 'accueil') page = <Home mods={mods} go={go} attention={attention} urgent={urgent} onMenu={() => setDrawer(true)} onBell={() => setBell(true)} />;
  else if (['ventes', 'valider', 'stock', 'caisses', 'clients', 'equipe'].includes(current)) page = <ManagerScreen id={current} links={<PcLinks mods={pcLinks(current, mods)} go={go} />} />;
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
      {drawer ? (
        <Drawer
          mods={mods}
          current={current}
          pcOnline={pc?.online ?? null}
          urgent={urgent}
          go={go}
          onClose={() => history.back()}
          onBell={() => (setDrawer(false), setBell(true))}
          onSettings={() => (setDrawer(false), setMenu(true))}
        />
      ) : null}
      {bell ? <Notifications items={attention} onClose={() => setBell(false)} /> : null}
      {menu ? settings(() => setMenu(false)) : null}
    </div>
  );
}

/** Raccourcis vers les écrans complets du PC, depuis l'écran du téléphone qui en donne l'aperçu. */
function PcLinks({ mods, go }: { mods: ModuleDef[]; go: (id: ModuleId) => void }) {
  if (!mods.length) return null;
  return (
    <>
      <SectionTitle>Écrans complets du PC</SectionTitle>
    <div className="list grouped pc-links">
      {mods.map((m) => (
        <ListItem key={m.id} icon={m.icon} tone="brand" title={m.label} detail={m.hint} onClick={() => go(m.id)} />
      ))}
    </div>
    </>
  );
}

/** Menu latéral : tous les modules autorisés, rangés, avec le profil en tête. */
function Drawer({
  mods,
  current,
  pcOnline,
  urgent,
  go,
  onClose,
  onBell,
  onSettings,
}: {
  mods: ModuleDef[];
  current: ModuleId | 'plus';
  pcOnline: number | null;
  urgent: number;
  go: (id: ModuleId) => void;
  onClose: () => void;
  onBell: () => void;
  onSettings: () => void;
}) {
  const s = useStore();
  const user = s.session!.user;
  return (
    <div className="drawer-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" aria-label="Menu">
        <div className="drawer-head">
          <span className="avatar big-avatar">{initials(user.name)}</span>
          <div className="grow">
            <b>{user.name}</b>
            <span>{roleLabel(user.role)}</span>
            <small>{s.config?.storeName}</small>
            <ConnectionDot light />
          </div>
          <button className="ghost" onClick={onClose} aria-label="Fermer le menu">
            <Icon name="x" />
          </button>
        </div>
        <nav className="drawer-list">
          {groupsFor(mods).map((g) => (
            <section key={g.id}>
              <h4>{g.label}</h4>
              {g.id === 'gestion' && pcOnline === 0 ? <p className="drawer-note">Aucun PC du magasin n’est allumé : ces écrans s’ouvriront dès qu’un PC sera allumé.</p> : null}
              {g.modules.map((m) => (
                <button key={m.id} className={`drawer-item ${current === m.id ? 'on' : ''}`} onClick={() => go(m.id)}>
                  <Icon name={m.icon} size={21} />
                  <span className="grow">{m.label}</span>
                  {m.pc ? <Icon name="chevron" size={16} /> : null}
                </button>
              ))}
            </section>
          ))}
          <section>
            <button className="drawer-item" onClick={onBell}>
              <Icon name="bell" size={21} />
              <span className="grow">Notifications</span>
              {urgent ? <i className="count">{urgent}</i> : null}
            </button>
            <button className="drawer-item" onClick={onSettings}>
              <Icon name="sliders" size={21} />
              <span className="grow">Paramètres</span>
            </button>
            <button className="drawer-item logout" onClick={() => void S.logout()}>
              <Icon name="logout" size={21} />
              <span className="grow">Se déconnecter</span>
            </button>
          </section>
        </nav>
      </aside>
    </div>
  );
}

function Notifications({ items, onClose }: { items: Attention[]; onClose: () => void }) {
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-head">
          <h2>Notifications</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">
            <Icon name="x" />
          </button>
        </div>
        {items.length ? (
          <AttentionList items={items.map((a) => ({ ...a, action: a.action ? () => (onClose(), a.action!()) : undefined }))} cards />
        ) : (
          <EmptyState icon="check-circle" title="Rien à signaler" text="Tout est à jour. Les alertes qui vous concernent apparaîtront ici." />
        )}
      </div>
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
function useAttention(mods: readonly ModuleDef[], go: (id: ModuleId) => void, openSettings: () => void): Attention[] {
  const s = useStore();
  const manager = useManagerAttention();
  const has = (id: ModuleId) => mods.some((m) => m.id === id);
  const out: Attention[] = [];
  if (s.online === false) out.push({ level: 'warning', title: 'Hors ligne', text: 'Vos saisies restent sur le téléphone et partiront au retour du réseau.' });
  if (s.catalogError) out.push({ level: 'danger', title: 'Catalogue non téléchargé', text: s.catalogError, action: () => void S.refreshCatalog() });
  if (s.pending) out.push({ level: 'info', title: `${s.pending} saisie(s) à envoyer`, text: 'Touchez pour envoyer maintenant', action: () => void S.sync() });
  if (s.rejected.length) out.push({ level: 'danger', title: `${s.rejected.length} saisie(s) refusée(s) à vérifier`, text: 'Elles sont gardées dans les Réglages (☰ › Réglages) avec leur motif.', action: openSettings });
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

function AttentionList({ items, cards }: { items: Attention[]; cards?: boolean }) {
  return (
    <div className={`list ${cards ? 'alerts' : 'grouped'}`}>
      {items.map((a, i) => (
        <ListItem key={i} icon={ATTENTION_ICON[a.level]} tone={a.level} title={a.title} detail={a.text} onClick={a.action} />
      ))}
    </div>
  );
}

// ——— Accueil ———

function Home({ mods, go, attention, urgent, onMenu, onBell }: { mods: ModuleDef[]; go: (id: ModuleId) => void; attention: Attention[]; urgent: number; onMenu: () => void; onBell: () => void }) {
  const s = useStore();
  const m = useManager();
  const user = s.session!.user;
  const has = (id: ModuleId) => mods.some((x) => x.id === id);
  useEffect(() => {
    if (has('vente')) void S.loadSentCarts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const quick = quickActions(mods);
  const hour = new Date().getHours();
  return (
    <div className="page">
      <header className="bar home-bar">
        <button className="ghost" onClick={onMenu} aria-label="Menu">
          <Icon name="menu" />
        </button>
        <div className="grow">
          <b>ONIX 360</b>
          <small>{s.config?.storeName}</small>
        </div>
        {m ? (
          <button className="ghost" onClick={m.load} aria-label="Actualiser">
            <Icon name="refresh" />
          </button>
        ) : null}
        <button className="ghost bell" onClick={onBell} aria-label="Notifications">
          <Icon name="bell" />
          {urgent ? <i className="badge">{urgent}</i> : null}
        </button>
      </header>
      <main className="enter">
        <button className="greet" onClick={onMenu}>
          <span className="avatar">{initials(user.name)}</span>
          <span className="grow">
            <span className="muted small">{hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir'},</span>
            <b>{user.name}</b>
            <span className="role">
              {roleLabel(user.role)}
              <ConnectionDot />
            </span>
          </span>
          <Icon name="chevron" size={20} />
        </button>
        {quick.length ? (
          <div className="quicks">
            {quick.map((q, i) => (
              <QuickAction key={q.id} icon={q.icon} label={q.quick} primary={i === 0} onClick={() => go(q.id)} />
            ))}
          </div>
        ) : null}
        {attention.length ? (
          <>
            <SectionTitle
              action={
                attention.length > 3 ? (
                  <button className="see-all" onClick={onBell}>
                    Voir tout <Icon name="chevron" size={16} />
                  </button>
                ) : undefined
              }
            >
              Alertes importantes
            </SectionTitle>
            <AttentionList items={attention.slice(0, 3)} />
          </>
        ) : null}
        {/* Le gérant voit la journée du magasin ; le vendeur, la sienne. */}
        {m ? (
          <>
            <ManagerHome />
            <PcLinks mods={pcLinks('accueil', mods)} go={go} />
          </>
        ) : has('vente') ? <SellerWidget onOpen={() => go('vente')} /> : null}
        {has('inventaires') ? <InventoryWidget onOpen={() => go('inventaires')} /> : null}
        {!quick.length && !m && !has('vente') && !has('inventaires') ? (
          <EmptyState icon="user" title="Aucun module ouvert" text="Votre compte n’a pas encore de droit sur le téléphone. Demandez au gérant de vous l’ouvrir sur un PC." />
        ) : null}
      </main>
    </div>
  );
}

function ConnectionDot({ light }: { light?: boolean }) {
  const s = useStore();
  const off = s.online === false;
  return (
    <span className={`conn ${off ? 'off' : s.pending ? 'wait' : ''} ${light ? 'light' : ''}`}>
      <i />
      {off ? 'Hors ligne' : s.syncing ? 'Envoi…' : s.pending ? `${s.pending} à envoyer` : 'En ligne'}
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

function More({ mods, pcOnline, go, onSettings, onBell, urgent }: { mods: ModuleDef[]; pcOnline: number | null; go: (id: ModuleId) => void; onSettings: () => void; onBell: () => void; urgent: number }) {
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
            {g.id === 'gestion' && pcOnline === 0 ? <p className="muted small">Aucun PC du magasin n’est allumé : ces écrans s’ouvriront dès qu’un PC sera allumé.</p> : null}
            <div className="list grouped">
              {g.modules.map((m) => (
                <ListItem key={m.id} icon={m.icon} tone="brand" title={m.label} detail={m.hint} onClick={() => go(m.id)} />
              ))}
            </div>
          </section>
        ))}
        <section>
          <SectionTitle>Mon espace</SectionTitle>
          <div className="list grouped">
            <ListItem icon="bell" title="Notifications" detail={urgent ? `${urgent} alerte(s) à voir` : 'Rien à signaler'} onClick={onBell} />
            <ListItem
              icon="refresh"
              title="Envoyer et actualiser"
              detail={s.lastSync ? `Dernier échange à ${heure(s.lastSync)}` : 'Pas encore d’échange'}
              onClick={() => void S.sync()}
            />
            <ListItem icon="sliders" title="Paramètres" detail="Catalogue, adresse du serveur, délier" onClick={onSettings} />
            <ListItem icon="logout" tone="danger" title="Se déconnecter" detail="Changer d’utilisateur sur ce téléphone" onClick={() => void S.logout()} />
          </div>
        </section>
        <p className="muted small center">ONIX 360 Mobile {__APP_VERSION__}</p>
      </main>
    </div>
  );
}
