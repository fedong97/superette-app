import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api';
import type { Permission } from '@superette/core';
import { GETTING_STARTED, type GuideStep, WHATS_NEW } from '../guide';
import { HELP } from '../help';
import { MAX_QUICK_TABS, type QuickTab, type WinKind, fold } from '../nav';
import { Mascot, Modal, fcfa, findIn, openScreen } from '../ui';

/**
 * Aide de la page affichée : à quoi elle sert, comment faire, raccourcis.
 * Seules les parties permises à l'utilisateur s'affichent ; celle de l'onglet ouvert vient en premier.
 */
export function HelpDialog({ kind, tab, rights, onClose, onGuide }: { kind: WinKind | null; tab?: string; rights: readonly Permission[]; onClose: () => void; onGuide: () => void }) {
  if (!kind) {
    return (
      <Modal title="Aide : page d'accueil" onClose={onClose}>
        <div className="help">
          <div className="mascotte-bulle">
            <Mascot mood="bonjour" size={64} />
            <p className="help-intro">Les grosses tuiles ouvrent les écrans que vous utilisez le plus. La barre verte à gauche ouvre les menus ; « Tous les menus » les montre tous d'un coup.</p>
          </div>
          <ul>
            <li>Ctrl+K : chercher un écran en tapant son nom (« clôture », « inventaire »…).</li>
            <li>Clic droit sur un onglet rapide : l'épingler, le retirer ou le déplacer.</li>
            <li>Le bouton « ? » explique chaque page ; F1 aussi, sauf à la caisse où F1 cherche un produit.</li>
          </ul>
          <div className="actions">
            <button onClick={onGuide}>Guide de démarrage</button>
            <button className="primary" onClick={onClose}>
              Compris
            </button>
          </div>
        </div>
      </Modal>
    );
  }
  const page = HELP[kind];
  const allowed = page.sections.filter((s) => !s.perm || [s.perm].flat().some((p) => rights.includes(p)));
  const sections = [...allowed.filter((s) => tab && s.tab === tab), ...allowed.filter((s) => !tab || s.tab !== tab)];
  return (
    <Modal title={`Aide : ${page.title}`} onClose={onClose} wide>
      <div className="help">
        <div className="mascotte-bulle">
          <Mascot mood="veille" size={64} />
          <p className="help-intro">{page.intro}</p>
        </div>
        {sections.map((s, i) => (
          <section key={`${s.title}-${i}`} className={tab && s.tab === tab ? 'help-current' : ''}>
            <h3>{s.title}</h3>
            <ol>
              {s.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>
        ))}
        {page.keys && (
          <section>
            <h3>Raccourcis clavier</h3>
            <table className="list compact">
              <tbody>
                {page.keys.map(([k, v]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <div className="actions">
          <button onClick={onGuide}>Guide de démarrage</button>
          <button className="primary" onClick={onClose}>
            Compris
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Un écran que la recherche de menu peut ouvrir. */
export interface PaletteEntry {
  /** Menu d'où vient l'écran, par exemple « Trésorerie ». */
  menu: string;
  label: string;
  /** Autres mots qui trouvent cet écran (synonymes, anciens noms), sans s'afficher. */
  words?: string;
  run: () => void;
}

/** Recherche de menu (Ctrl+K) : on tape quelques lettres, Entrée ouvre l'écran. */
/** Une ligne de la recherche Ctrl+K : un écran, un produit ou un client. */
interface Hit {
  group: string;
  key: string;
  label: string;
  meta?: string;
  run: () => void;
}

export function CommandPalette({ entries, onClose }: { entries: PaletteEntry[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [records, setRecords] = useState<Hit[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const found = useMemo(() => {
    const words = fold(q).split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    return entries
      .filter((e) => {
        const key = `${e.menu}›${e.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const text = fold(`${e.menu} ${e.label} ${e.words ?? ''}`);
        return words.every((w) => text.includes(w));
      })
      // Les mots trouvés dans le nom de l'écran (plutôt que dans celui du menu) passent devant.
      .map((e, n) => {
        const label = fold(e.label);
        const whole = (w: string) => label.split(/[^a-z0-9]+/).includes(w);
        const score = words.reduce((t, w) => t + (label.includes(w) ? 2 : 0) + (whole(w) ? 1 : 0) + (label.startsWith(w) ? 1 : 0), 0);
        return { e, n, score };
      })
      .sort((a, b) => b.score - a.score || a.n - b.n)
      .map((x) => x.e)
      .slice(0, q.trim() ? 6 : 12);
  }, [q, entries]);
  // Produits et clients : cherchés dès 2 lettres, un court instant après la frappe.
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) return setRecords([]);
    let live = true;
    const t = setTimeout(() => {
      void Promise.all([
        call('catalogue.search', text).catch(() => []),
        call('customers.list', { search: text }).catch(() => []),
      ]).then(([articles, customers]) => {
        if (!live) return;
        setRecords([
          ...articles.slice(0, 5).map((a) => ({
            group: 'Produits',
            key: `a-${a.id}`,
            label: a.name,
            meta: `${a.code} · ${fcfa(a.store_price || a.sale_price)}`,
            run: () => (findIn('articles', a.name), openScreen('articles', 'list')),
          })),
          ...customers.slice(0, 4).map((c) => ({
            group: 'Clients',
            key: `c-${c.id}`,
            label: c.name,
            meta: c.phone ?? undefined,
            run: () => (findIn('customers', c.name), openScreen('customers', 'list')),
          })),
        ]);
      });
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  const hits: Hit[] = [...found.map((e) => ({ group: 'Écrans et actions', key: `e-${e.menu}-${e.label}`, label: e.label, meta: e.menu, run: e.run })), ...records];
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelectorAll('button')[sel]?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const go = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    h.run();
  };
  return (
    <Modal title="Rechercher" onClose={onClose}>
      <div className="palette">
        <input
          autoFocus
          aria-label="Rechercher un écran, un produit ou un client"
          placeholder="Un écran, un produit, un client : vente, clôture, coca, Mballa…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(s + 1, hits.length - 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
            if (e.key === 'Enter') (e.preventDefault(), go(hits[sel]));
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {hits.map((h, i) => (
            <Fragment key={h.key}>
              {(i === 0 || hits[i - 1]!.group !== h.group) && <div className="palette-group">{h.group}</div>}
              <button role="option" aria-selected={i === sel} className={i === sel ? 'active' : ''} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
                {h.label}
                {h.meta && <span className="p-meta">{h.meta}</span>}
              </button>
            </Fragment>
          ))}
          {!hits.length && <p className="muted">Rien ne correspond. Essayez un autre mot.</p>}
        </div>
        <p className="muted palette-hint">
          <kbd>↑</kbd> <kbd>↓</kbd> pour choisir · <kbd>Entrée</kbd> pour ouvrir · <kbd>Échap</kbd> pour fermer
        </p>
      </div>
    </Modal>
  );
}

/** Personnaliser les onglets rapides : cocher, ranger, revenir aux onglets d'origine. */
export function QuickTabsEditor({ current, available, onSave, onClose }: { current: QuickTab[]; available: QuickTab[]; onSave: (tabs: QuickTab[] | null) => void; onClose: () => void }) {
  const [tabs, setTabs] = useState(current);
  const key = (t: QuickTab) => `${t.open[0]}:${t.open[1] ?? ''}`;
  const others = available.filter((a) => !tabs.some((t) => key(t) === key(a)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= tabs.length) return;
    const next = [...tabs];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setTabs(next);
  };
  return (
    <Modal title="Personnaliser les onglets rapides" onClose={onClose} wide>
      <div className="grid2 quick-editor">
        <div>
          <h3>
            Mes onglets ({tabs.length} sur {MAX_QUICK_TABS})
          </h3>
          <table className="list compact">
            <tbody>
              {tabs.map((t, i) => (
                <tr key={key(t)}>
                  <td>{t.label}</td>
                  <td className="r">
                    <button className="ghost" title="Vers la gauche" disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button className="ghost" title="Vers la droite" disabled={i === tabs.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                    <button className="ghost danger" title="Retirer" onClick={() => setTabs(tabs.filter((_, n) => n !== i))}>
                      Retirer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3>Écrans à ajouter</h3>
          <table className="list compact">
            <tbody>
              {others.map((t) => (
                <tr key={key(t)}>
                  <td>{t.label}</td>
                  <td className="r">
                    <button disabled={tabs.length >= MAX_QUICK_TABS} onClick={() => setTabs([...tabs, t])}>
                      Ajouter
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            {MAX_QUICK_TABS} onglets au plus, pour tenir sur deux lignes. Depuis un menu, un clic droit sur un écran l'épingle aussi dans les onglets.
          </p>
        </div>
      </div>
      <div className="actions">
        <button onClick={() => onSave(null)}>Revenir aux onglets d'origine</button>
        <button onClick={onClose}>Annuler</button>
        <button className="primary" onClick={() => onSave(tabs)}>
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

/**
 * Barre verte : menus à afficher (cochés) et leur ordre. Réglages et Aide
 * restent en bas ; « Tous les menus » retrouve un menu masqué.
 */
export function RailEditor({ menus, current, label, onSave, onClose }: { menus: string[]; current: string[]; label: (name: string) => string; onSave: (list: string[] | null) => void; onClose: () => void }) {
  const [order, setOrder] = useState(() => [...current, ...menus.filter((m) => !current.includes(m))]);
  const [shown, setShown] = useState(() => new Set(current));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOrder(next);
  };
  return (
    <Modal title="Personnaliser la barre latérale" onClose={onClose}>
      <p className="muted">Cochez les menus à afficher dans la barre latérale et rangez-les avec ↑ ↓. Réglages et Aide restent en bas ; « Tous les menus » montre toujours tout.</p>
      <table className="list compact">
        <tbody>
          {order.map((m, i) => (
            <tr key={m} className={shown.has(m) ? '' : 'inactive'}>
              <td>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={shown.has(m)}
                    onChange={(e) => {
                      const next = new Set(shown);
                      if (e.target.checked) next.add(m);
                      else next.delete(m);
                      setShown(next);
                    }}
                  />{' '}
                  {label(m)}
                </label>
              </td>
              <td className="r">
                <button className="ghost" title="Monter" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="ghost" title="Descendre" disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button onClick={() => onSave(null)}>Rétablir</button>
        <button onClick={onClose}>Annuler</button>
        <button className="primary" onClick={() => onSave(order.filter((m) => shown.has(m)))}>
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

/** Guide de démarrage : les cinq premières choses à faire pour ce rôle, chacune ouvre son écran. */
export function GettingStarted({ role, canOpen, onOpen, onClose }: { role: keyof typeof GETTING_STARTED; canOpen: (kind: WinKind) => boolean; onOpen: (o: [WinKind, string?]) => void; onClose: () => void }) {
  const steps: GuideStep[] = GETTING_STARTED[role];
  return (
    <Modal title="Guide de démarrage" onClose={onClose} wide>
      <div className="mascotte-bulle">
        <Mascot mood="bonjour" size={64} />
        <p>Bienvenue ! Voici les premières choses à faire. Chaque bouton ouvre le bon écran.</p>
      </div>
      <ol className="guide-steps">
        {steps.map((s) => (
          <li key={s.text}>
            <span>{s.text}</span>
            {s.open && canOpen(s.open[0]) && (
              <button
                onClick={() => {
                  onClose();
                  onOpen(s.open!);
                }}
              >
                Ouvrir
              </button>
            )}
          </li>
        ))}
      </ol>
      <p className="muted">Sur chaque page, le bouton « ? » en haut à droite explique comment l'utiliser.</p>
      <div className="actions">
        <button className="primary" onClick={onClose}>
          Compris
        </button>
      </div>
    </Modal>
  );
}

/** Quoi de neuf : affiché une fois après chaque mise à jour, puis dans le menu Aide. */
export function WhatsNew({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <Modal title={`Quoi de neuf dans la version ${version}`} onClose={onClose} wide>
      <div className="help">
        <div className="mascotte-bulle">
          <Mascot mood="bravo" size={64} />
          <p>Le logiciel vient d'être mis à jour. Voici ce qui change.</p>
        </div>
        {WHATS_NEW.map((v) => (
          <section key={v.version} className={v.version === version ? 'help-current' : ''}>
            <h3>Version {v.version}</h3>
            <ul>
              {v.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="actions">
        <button className="primary" onClick={onClose}>
          Compris
        </button>
      </div>
    </Modal>
  );
}
