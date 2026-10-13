import { CODEPAGES, type Codepage, DEFAULT_STORE_SETTINGS, POS_LAYOUTS, type PosLayout, type StoreSettings } from '@superette/core';
import { type ReactNode, useState } from 'react';
import { type Result, call } from '../api';
import { fold } from '../nav';
import classicShot from '../assets/caisse/classique.png';
import conventionalShot from '../assets/caisse/conventionnel.png';
import modernShot from '../assets/caisse/moderne.png';
import { askConfirm, Empty, useLoad, useToast } from '../ui';

type User = NonNullable<Result<'app.state'>['user']>;
type StoreIdentity = { name: string; address: string; phone: string; taxpayer_number: string };

/** Un réglage : son libellé sert aussi à la recherche en haut de l'onglet. */
interface Item {
  label: string;
  hint?: string;
  render: () => ReactNode;
  /** Sur toute la largeur de la section (les cartes de l'écran de caisse). */
  wide?: boolean;
}

/** Les trois présentations de l'écran de caisse, avec leur vignette. */
const LAYOUT_CARDS: { id: PosLayout; shot: string; text: string }[] = [
  { id: 'modern', shot: modernShot, text: 'Tuiles des produits, ticket à droite, gros boutons. Idéal pour un écran tactile.' },
  { id: 'classic', shot: classicShot, text: 'Tableau des lignes, boutons à droite, touches F en bas.' },
  { id: 'conventional', shot: conventionalShot, text: 'Grand total en haut, ligne de saisie, cadre Règlement et « A rendre ».' },
];

/** Image choisie réduite à 512 points de large au plus, en PNG : elle reste légère pour le ticket. */
function readLogo(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Image illisible'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Image illisible'));
      img.onload = () => {
        const scale = Math.min(1, 512 / img.width, 256 / img.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const g = canvas.getContext('2d')!;
        g.fillStyle = '#fff';
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Paramètres rangés par section, avec une recherche. Les règles du magasin
 * (ventes, crédit, stock, achats, sécurité, numérotation) valent pour tous ses
 * postes ; l'imprimante, la balance, l'affichage et l'heure de sauvegarde sont
 * propres à ce PC.
 */
export function Settings({ user, onChanged }: { user: User; onChanged: () => void }) {
  const toast = useToast();
  const state = useLoad(() => call('app.state'));
  const local = useLoad(() => call('admin.settings'));
  const store = useLoad(() => call('admin.storeSettings'));
  const printers = useLoad(() => call('admin.printers'));
  const emoney = useLoad(() => call('emoney.registers'));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [storeDraft, setStoreDraft] = useState<Partial<StoreSettings>>({});
  const [identity, setIdentity] = useState<Partial<StoreIdentity>>({});
  const [threshold, setThreshold] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const st = state.data?.station?.store;
  if (!local.data || !store.data || !st) return null;
  const isAdmin = user.role === 'admin';
  const canEdit = user.rights.includes('settings_edit');
  const canStock = user.rights.includes('ignore_stock');

  const v = (k: string, d = '') => draft[k] ?? local.data![k] ?? d;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });
  const sv = <K extends keyof StoreSettings>(k: K): StoreSettings[K] => (storeDraft[k] ?? store.data![k]) as StoreSettings[K];
  const sset = <K extends keyof StoreSettings>(k: K, value: StoreSettings[K]) => setStoreDraft({ ...storeDraft, [k]: value });
  const num = (k: keyof StoreSettings, suffix?: string) => (
    <span className="inline">
      <input
        inputMode="numeric"
        disabled={!canEdit}
        className="qty"
        value={String(sv(k))}
        onChange={(e) => sset(k, (e.target.value.replace(/\D/g, '') === '' ? 0 : Number(e.target.value.replace(/\D/g, ''))) as never)}
      />
      {suffix && <span className="muted">{suffix}</span>}
    </span>
  );
  const yes = (k: keyof StoreSettings) => (
    <select disabled={!canEdit} value={sv(k) ? '1' : '0'} onChange={(e) => sset(k, (e.target.value === '1') as never)}>
      <option value="1">Oui</option>
      <option value="0">Non</option>
    </select>
  );
  const text = (k: keyof StoreSettings, placeholder?: string) => (
    <input disabled={!canEdit} value={String(sv(k))} placeholder={placeholder} onChange={(e) => sset(k, e.target.value as never)} />
  );
  const iv = (k: keyof StoreIdentity) => identity[k] ?? (st[k] as string | null) ?? '';
  const ident = (k: keyof StoreIdentity, placeholder?: string) => (
    <input disabled={!canEdit} value={iv(k)} placeholder={placeholder} onChange={(e) => setIdentity({ ...identity, [k]: e.target.value })} />
  );
  const saveOptions = async (options: { vatEnabled?: boolean; ignoreStock?: boolean; cashGapThreshold?: number }, message: string) => {
    try {
      const store = await call('admin.storeOptions', options);
      toast.ok(store.articlesExempted ? `${message} : ${store.articlesExempted} article(s) passé(s) à « Exonéré »` : message);
      // TVA réactivée : proposer de remettre les articles exonérés au taux normal.
      if (options.vatEnabled === true && (await askConfirm('Mettre tous les articles exonérés à 19,25 % ? (Annuler : vous réglerez le taux article par article)'))) {
        const n = await call('admin.articlesStandardRate');
        toast.ok(`${n} article(s) remis à 19,25 %`);
      }
      state.reload();
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  const mode = v('printer.mode', 'driver');
  const logo = sv('logo');

  const sections: [string, string, Item[]][] = [
    [
      'Identité du magasin',
      'Imprimée en haut des tickets, des factures et des documents A4.',
      [
        { label: 'Nom commercial', render: () => ident('name') },
        { label: 'Adresse', render: () => ident('address', 'Quartier, ville') },
        { label: 'Téléphone', render: () => ident('phone') },
        { label: 'NIU (numéro d’identifiant unique)', render: () => ident('taxpayer_number') },
        { label: 'RCCM (registre du commerce)', render: () => text('rccm', 'RC/DLA/2024/B/1234') },
        { label: 'Message d’en-tête du ticket', hint: 'Sous le nom du magasin, par exemple « Ouvert 7j/7 de 7h à 22h »', render: () => text('ticketHeader') },
        {
          label: 'Logo sur le ticket et les factures',
          hint: 'Une image simple, en noir sur fond blanc, sort mieux sur le ticket',
          render: () => (
            <span className="inline">
              {logo ? <img src={logo} alt="Logo" className="logo-preview" /> : <span className="muted">Aucun logo</span>}
              <label className={`button ${canEdit ? '' : 'disabled'}`}>
                Choisir une image…
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/bmp,image/gif"
                  hidden
                  disabled={!canEdit}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    try {
                      sset('logo', await readLogo(f));
                    } catch (err) {
                      toast.error(err);
                    }
                  }}
                />
              </label>
              {logo && (
                <button className="ghost danger" disabled={!canEdit} onClick={() => sset('logo', '')}>
                  Retirer
                </button>
              )}
            </span>
          ),
        },
      ],
    ],
    [
      'Écran de caisse',
      'Le modèle choisi s’applique à toutes les caisses du magasin. Les trois ont les mêmes fonctions et les mêmes touches (F2 ticket, F7 listing, F4 enregistrer).',
      [
        {
          label: 'Modèle de l’écran de caisse moderne classique conventionnel',
          wide: true,
          render: () => (
            <div className="layout-cards" role="radiogroup" aria-label="Modèle de l’écran de caisse">
              {LAYOUT_CARDS.map((c) => (
                <label key={c.id} className={`layout-card ${sv('posLayout') === c.id ? 'on' : ''} ${isAdmin ? '' : 'disabled'}`}>
                  <img src={c.shot} alt="" />
                  <span className="layout-name">
                    <input type="radio" name="posLayout" disabled={!isAdmin} checked={sv('posLayout') === c.id} onChange={() => sset('posLayout', c.id)} />
                    {POS_LAYOUTS[c.id]}
                  </span>
                  <small className="muted">{c.text}</small>
                </label>
              ))}
            </div>
          ),
        },
        {
          label: `Exception pour ce poste (${state.data?.register?.name ?? 'ce PC'})`,
          hint: isAdmin ? 'Choisissez un autre modèle seulement pour ce PC.' : 'Seul un administrateur peut changer l’écran de caisse.',
          render: () => (
            <select disabled={!isAdmin} value={v('pos.layout')} onChange={set('pos.layout')}>
              <option value="">Comme le magasin</option>
              {(Object.keys(POS_LAYOUTS) as PosLayout[]).map((k) => (
                <option key={k} value={k}>
                  {POS_LAYOUTS[k]}
                </option>
              ))}
            </select>
          ),
        },
      ],
    ],
    [
      'TVA, stock et écart de caisse',
      'Ces réglages s’enregistrent dès qu’on les change.',
      [
        {
          label: 'Magasin assujetti à la TVA (régime du réel)',
          hint: isAdmin ? 'Ne s’applique qu’aux nouvelles pièces.' : 'Seul un administrateur peut changer ce réglage.',
          render: () => (
            <input
              type="checkbox"
              disabled={!isAdmin}
              checked={st.vat_enabled === 1}
              onChange={async (e) => {
                const on = e.target.checked;
                if (
                  !(await askConfirm(
                    on
                      ? 'Activer la TVA ? Les prochaines ventes, factures, achats et dépenses porteront la TVA (19,25 % par défaut). Les pièces déjà enregistrées ne changent pas.'
                      : 'Désactiver la TVA (régime simplifié) ? Les prochaines pièces seront sans TVA, les articles passent à « Exonéré » et la TVA disparaît des écrans et des impressions. Les pièces déjà enregistrées ne changent pas.',
                  ))
                )
                  return;
                void saveOptions({ vatEnabled: on }, on ? 'TVA activée' : 'TVA désactivée');
              }}
            />
          ),
        },
        {
          label: 'Ignorer la gestion des stocks (vendre même si le stock en machine est épuisé)',
          hint: 'À cocher quand la marchandise est arrivée mais pas encore saisie ; la prochaine réception régularise le stock.',
          render: () => (
            <input
              type="checkbox"
              disabled={!canStock}
              checked={st.ignore_stock === 1}
              onChange={(e) => void saveOptions({ ignoreStock: e.target.checked }, e.target.checked ? 'Vente sans stock autorisée' : 'Gestion des stocks rétablie')}
            />
          ),
        },
        {
          label: 'Écart de caisse toléré (FCFA)',
          hint: 'Au-delà, la clôture demande un motif et la validation du gérant',
          render: () => (
            <input
              inputMode="numeric"
              className="qty"
              disabled={!isAdmin}
              value={threshold ?? String(st.cash_gap_threshold)}
              onChange={(e) => setThreshold(e.target.value)}
              onBlur={() => {
                if (threshold === null) return;
                const n = Number(threshold.replace(/\s/g, ''));
                if (!Number.isInteger(n) || n < 0) return toast.error('Montant invalide');
                if (n !== st.cash_gap_threshold) void saveOptions({ cashGapThreshold: n }, 'Seuil d’écart enregistré');
                setThreshold(null);
              }}
            />
          ),
        },
      ],
    ],
    [
      'Ventes et caisse',
      '',
      [
        { label: 'Remise maximale sans le code du gérant', hint: 'En % du ticket. 0 : toute remise demande le code (sauf droit « remise sans code »).', render: () => num('maxDiscountPct', '%') },
        {
          label: 'Arrondi des ventes payées en espèces',
          hint: 'Le ticket payé tout en espèces descend au multiple inférieur, en faveur du client.',
          render: () => (
            <select disabled={!canEdit} value={String(sv('cashRounding'))} onChange={(e) => sset('cashRounding', Number(e.target.value) as StoreSettings['cashRounding'])}>
              <option value="1">Pas d’arrondi</option>
              {[5, 10, 25, 50].map((n) => (
                <option key={n} value={n}>
                  Au multiple de {n} FCFA
                </option>
              ))}
            </select>
          ),
        },
        {
          label: 'Nombre de tickets imprimés à chaque vente',
          render: () => (
            <select disabled={!canEdit} value={String(sv('ticketCopies'))} onChange={(e) => sset('ticketCopies', Number(e.target.value))}>
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          ),
        },
        { label: 'Nom du client obligatoire au-delà de', hint: '0 : jamais obligatoire', render: () => num('customerRequiredAbove', 'FCFA') },
        { label: 'Délai maximal pour annuler une vente', hint: 'Passé ce délai, on fait un retour client. 0 : sans limite.', render: () => num('cancelMinutes', 'minutes') },
        { label: 'Nombre maximal de factures en attente par caisse', hint: '0 : sans limite', render: () => num('maxHeld') },
        { label: 'Vente sous le prix de revient', hint: 'Non : un prix négocié ne descend jamais sous le coût. Oui : permis et noté dans le journal d’audit.', render: () => yes('allowBelowCost') },
      ],
    ],
    [
      'Caisses électroniques',
      'Comptes MTN MoMo et Orange Money des caissiers.',
      [
        {
          label: 'Fonctionnement des caisses électroniques',
          hint:
            sv('emoneyMode') === 'central'
              ? 'Le soir, chaque caissier verse sa recette vers la caisse électronique centrale et note la référence du transfert. Il peut garder un reste pour le lendemain.'
              : 'Chaque caisse électronique garde son solde d’un jour à l’autre ; le solde relevé à la clôture sert de départ le lendemain.',
          render: () => (
            <select disabled={!canEdit} value={sv('emoneyMode')} onChange={(e) => sset('emoneyMode', e.target.value as StoreSettings['emoneyMode'])}>
              <option value="central">Avec une caisse électronique centrale</option>
              <option value="independent">Caisses électroniques indépendantes</option>
            </select>
          ),
        },
        ...(sv('emoneyMode') === 'central'
          ? [
              {
                label: 'Caisse électronique centrale (le numéro du magasin)',
                hint: 'Elle reçoit les versements des caissiers et n’est attribuée à personne. Créez-la dans Administration › Caisses (type Électronique).',
                render: () => (
                  <select disabled={!canEdit} value={sv('emoneyCentralRegisterId')} onChange={(e) => sset('emoneyCentralRegisterId', e.target.value)}>
                    <option value="">Pas encore choisie</option>
                    {(emoney.data?.registers ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                ),
              },
            ]
          : []),
      ],
    ],
    [
      'Crédit clients',
      '',
      [
        { label: 'Plafond de crédit d’un nouveau client', hint: '0 : pas de crédit sans accord du gérant', render: () => num('creditDefaultLimit', 'FCFA') },
        { label: 'Délai de paiement d’un nouveau client', render: () => num('creditDefaultDays', 'jours') },
        { label: 'Bloquer le crédit d’un client qui a une facture échue', hint: 'Le gérant peut passer outre avec son code.', render: () => yes('creditBlockLate') },
      ],
    ],
    [
      'Stock',
      '',
      [
        { label: 'Alerte de péremption', hint: 'Les lots qui périment dans ce délai sont signalés', render: () => num('expiryAlertDays', 'jours avant') },
        { label: 'Stock d’alerte proposé pour un nouveau produit', hint: '0 : aucun', render: () => num('defaultAlertQty', 'unités') },
        { label: 'Un transfert est réceptionné par un autre utilisateur que celui qui l’a expédié', render: () => yes('transferTwoUsers') },
      ],
    ],
    [
      'Achats',
      '',
      [
        { label: 'Délai de paiement d’un nouveau fournisseur', render: () => num('supplierDefaultDays', 'jours') },
        { label: 'Marge proposée pour le prix de vente', hint: 'Sur la fiche produit, le prix conseillé = prix de revient + marge. 0 : pas de proposition.', render: () => num('defaultMarginPct', '%') },
      ],
    ],
    [
      'Sécurité',
      '',
      [
        { label: 'Déconnexion automatique sans activité', hint: 'Protège la caisse quand le caissier s’absente. Une vente pas encore encaissée est perdue : mettez-la en attente avant de partir. 0 : jamais.', render: () => num('idleMinutes', 'minutes') },
        {
          label: 'Longueur minimale du code des utilisateurs',
          render: () => (
            <select disabled={!canEdit} value={String(sv('pinMinLength'))} onChange={(e) => sset('pinMinLength', Number(e.target.value))}>
              {[4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>
                  {n} chiffres
                </option>
              ))}
            </select>
          ),
        },
        { label: 'Blocage après des codes faux de suite', hint: 'Bloqué 15 minutes ; l’administrateur peut débloquer. 0 : jamais.', render: () => num('maxLoginAttempts', 'essais') },
      ],
    ],
    [
      'Numérotation des pièces',
      'Préfixe ajouté devant les nouveaux numéros (6 lettres ou chiffres au plus). Les pièces déjà faites gardent leur numéro.',
      [
        { label: 'Préfixe des factures (tickets)', hint: 'Vide par défaut', render: () => text('prefixSale', 'FAC') },
        { label: 'Préfixe des avoirs (retours clients)', hint: 'Vide par défaut', render: () => text('prefixReturn', 'AV') },
        { label: 'Préfixe des devis', render: () => text('prefixQuote', DEFAULT_STORE_SETTINGS.prefixQuote) },
        { label: 'Préfixe des factures proforma', render: () => text('prefixProforma', DEFAULT_STORE_SETTINGS.prefixProforma) },
        { label: 'Préfixe des bons de commande', render: () => text('prefixOrder', DEFAULT_STORE_SETTINGS.prefixOrder) },
      ],
    ],
    [
      'Imprimante ticket et tiroir-caisse (ce PC)',
      '',
      [
        {
          label: "Mode d'impression",
          hint: 'ESC/POS : plus rapide, accents gérés, coupe du papier et tiroir',
          render: () => (
            <select disabled={!canEdit} value={mode} onChange={set('printer.mode')}>
              <option value="driver">Pilote Windows (comme une imprimante normale)</option>
              <option value="windows">ESC/POS direct, imprimante USB installée sous Windows</option>
              <option value="network">ESC/POS direct, imprimante réseau (IP)</option>
            </select>
          ),
        },
        ...(mode === 'network'
          ? [
              { label: "Adresse IP de l'imprimante", hint: "Imprimée sur la page d'autotest de l'imprimante", render: () => <input disabled={!canEdit} value={v('printer.host')} placeholder="192.168.1.100" onChange={set('printer.host')} /> },
              { label: 'Port', render: () => <input disabled={!canEdit} value={v('printer.port', '9100')} inputMode="numeric" onChange={set('printer.port')} /> },
            ]
          : [
              {
                label: 'Imprimante ticket',
                render: () => (
                  <select disabled={!canEdit} value={v('printer.name')} onChange={set('printer.name')}>
                    <option value="">Imprimante par défaut de Windows</option>
                    {(printers.data ?? []).map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ),
              },
            ]),
        ...(mode !== 'driver'
          ? [
              {
                label: 'Largeur du papier',
                render: () => (
                  <select disabled={!canEdit} value={v('printer.columns', '48')} onChange={set('printer.columns')}>
                    <option value="48">80 mm (48 caractères)</option>
                    <option value="42">80 mm (42 caractères)</option>
                    <option value="32">58 mm (32 caractères)</option>
                  </select>
                ),
              },
              {
                label: 'Table de caractères',
                hint: 'Si les accents sortent faux sur la page de test, essayez une autre table',
                render: () => (
                  <select disabled={!canEdit} value={v('printer.codepage', 'pc850')} onChange={set('printer.codepage')}>
                    {(Object.keys(CODEPAGES) as Codepage[]).map((c) => (
                      <option key={c} value={c}>
                        {CODEPAGES[c].label}
                      </option>
                    ))}
                  </select>
                ),
              },
              {
                label: 'Coupe automatique du papier',
                render: () => (
                  <select disabled={!canEdit} value={v('printer.cut', '1')} onChange={set('printer.cut')}>
                    <option value="1">Oui</option>
                    <option value="0">Non (imprimante sans massicot)</option>
                  </select>
                ),
              },
            ]
          : []),
        {
          label: 'Impression automatique du ticket',
          render: () => (
            <select disabled={!canEdit} value={v('printer.enabled', '1')} onChange={set('printer.enabled')}>
              <option value="1">Oui</option>
              <option value="0">Non</option>
            </select>
          ),
        },
        {
          label: 'Ouverture du tiroir-caisse',
          hint: "Tiroir branché sur l'imprimante (prise RJ11)",
          render: () => (
            <select disabled={!canEdit} value={v('drawer.mode', 'never')} onChange={set('drawer.mode')}>
              <option value="never">Jamais automatiquement</option>
              <option value="cash">À chaque encaissement en espèces</option>
              <option value="always">À chaque vente</option>
            </select>
          ),
        },
        {
          label: 'Imprimante listing (factures F7)',
          hint: 'Imprimante à papier continu : la facture listing y part directement, sans fenêtre Windows.',
          render: () => (
            <select disabled={!canEdit} value={v('printer.listing')} onChange={set('printer.listing')}>
              <option value="">Demander à chaque fois (fenêtre d’impression)</option>
              {(printers.data ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          ),
        },
        { label: 'Pied de ticket', render: () => <input disabled={!canEdit} value={v('ticket.footer', 'Merci de votre visite !')} onChange={set('ticket.footer')} /> },
        {
          label: 'Page de test',
          hint: Object.keys(draft).length ? "Enregistrez d'abord les paramètres" : undefined,
          render: () => (
            <span className="inline">
              <button disabled={!canEdit || Object.keys(draft).length > 0} onClick={() => call('admin.printTest', false).then(() => toast.ok('Page de test envoyée'), toast.error)}>
                Imprimer une page de test
              </button>
              <button
                disabled={!canEdit || Object.keys(draft).length > 0}
                onClick={() => call('admin.printTest', true).then(() => toast.ok('Page de test envoyée, le tiroir doit s’ouvrir'), toast.error)}
              >
                Page de test et tiroir
              </button>
            </span>
          ),
        },
      ],
    ],
    [
      'Étiquettes balance (ce PC)',
      '',
      [
        { label: 'Préfixes des étiquettes balance', hint: 'Séparés par des virgules, ex. 21,22', render: () => <input disabled={!canEdit} value={v('scale.prefixes', '21,22')} onChange={set('scale.prefixes')} /> },
        {
          label: 'La balance imprime',
          render: () => (
            <select disabled={!canEdit} value={v('scale.valueType', 'price')} onChange={set('scale.valueType')}>
              <option value="price">le prix (FCFA)</option>
              <option value="weight">le poids (grammes)</option>
            </select>
          ),
        },
      ],
    ],
    [
      'Affichage et sauvegarde (ce PC)',
      '',
      [
        {
          label: 'Taille du texte',
          render: () => (
            <select disabled={!canEdit} value={v('display.size', 'normal')} onChange={set('display.size')}>
              <option value="normal">Normale</option>
              <option value="large">Grande</option>
            </select>
          ),
        },
        {
          label: 'Sauvegarde automatique à heure fixe',
          hint: 'En plus de la sauvegarde du jour. Vide : pas de sauvegarde à heure fixe.',
          render: () => <input type="time" disabled={!canEdit} value={v('backup.autoTime')} onChange={set('backup.autoTime')} />,
        },
      ],
    ],
  ];

  const words = fold(search).split(/\s+/).filter(Boolean);
  const match = (title: string, i: Item) => !words.length || words.every((w) => fold(`${title} ${i.label} ${i.hint ?? ''}`).includes(w));
  const shown = sections.map(([title, intro, items]) => [title, intro, items.filter((i) => match(title, i))] as const).filter(([, , items]) => items.length);
  const dirty = Object.keys(draft).length + Object.keys(storeDraft).length + Object.keys(identity).length > 0;

  const save = async () => {
    try {
      if (Object.keys(identity).length) await call('admin.updateStoreIdentity', identity);
      if (Object.keys(storeDraft).length) await call('admin.saveStoreSettings', storeDraft);
      if (Object.keys(draft).length) await call('admin.saveSettings', draft);
      setDraft({});
      setStoreDraft({});
      setIdentity({});
      local.reload();
      store.reload();
      state.reload();
      onChanged();
      toast.ok('Paramètres enregistrés');
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="settings">
      <div className="filters sticky-actions">
        <input className="search" placeholder="Chercher : arrondi, logo, crédit…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {!canEdit && <span className="muted">Vous pouvez consulter les paramètres, pas les modifier.</span>}
        <span className="spacer" />
        <button className="ghost" disabled={!dirty} onClick={() => (setDraft({}), setStoreDraft({}), setIdentity({}))}>
          Annuler les changements
        </button>
        <button className="primary" disabled={!canEdit || !dirty} onClick={save}>
          Enregistrer
        </button>
      </div>
      {shown.map(([title, intro, items]) => (
        <section key={title} className="settings-section">
          <h3>{title}</h3>
          {intro && <p className="muted">{intro}</p>}
          {items.map((i) => (
            i.wide ? (
              <div key={i.label} className="settings-row wide">
                {i.render()}
              </div>
            ) : (
              <div key={i.label} className="settings-row">
                <div>
                  <div>{i.label}</div>
                  {i.hint && <small className="muted">{i.hint}</small>}
                </div>
                <div>{i.render()}</div>
              </div>
            )
          ))}
        </section>
      ))}
      {!shown.length && <Empty>Aucun paramètre ne correspond. Essayez un autre mot.</Empty>}
    </div>
  );
}
