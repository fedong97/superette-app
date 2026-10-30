import { useEffect, useState } from 'react';
import { SALE_FLOWS, type SaleFlow } from '@superette/core';
import { call, type Result } from '../api';
import { Field, Mascot, askConfirm, useToast } from '../ui';
import { DossierPicker } from './Dossiers';

/** Premier démarrage : création du premier magasin et du compte administrateur. */
export function Setup({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'new' | 'join'>('new');
  if (mode === 'join') return <Join onDone={onDone} onBack={() => setMode('new')} />;
  return <NewStore onDone={onDone} onJoin={() => setMode('join')} />;
}

/**
 * PC supplémentaire : rejoint un magasin déjà déclaré sur le serveur central.
 * Seule l'adresse du serveur est demandée, puis la connexion au magasin avec
 * l'identifiant et le code d'un utilisateur déjà créé (vendeur, magasinier,
 * caissier…). La caisse vient de l'utilisateur, pas du PC. L'ancien code
 * d'activation d'une caisse reste possible pour un PC dédié à une caisse.
 */
function Join({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<'server' | 'login' | 'code'>('server');
  const [url, setUrl] = useState('');
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const back = (
    <button type="button" onClick={() => (step === 'server' ? onBack() : setStep('server'))} disabled={busy}>
      Retour
    </button>
  );
  if (step === 'server') {
    return (
      <div className="center-page">
        <form className="card setup" onSubmit={(e) => (e.preventDefault(), void run(async () => (await call('setup.ping', url), setStep('login'))))}>
          <h1>Rejoindre un magasin</h1>
          <p>Indiquez l'adresse du serveur central du magasin. Vous vous connecterez ensuite avec votre identifiant, quel que soit votre rôle (vendeur, caissier, magasinier…).</p>
          <Field label="Adresse du serveur central" hint="ex. http://192.168.1.20:3000 (affichée dans ONIX 360 Serveur)">
            <input value={url} onChange={(e) => setUrl(e.target.value)} required autoFocus />
          </Field>
          <div className="actions">
            {back}
            <button className="primary big" type="submit" disabled={busy || !url.trim()}>
              {busy ? 'Recherche du serveur…' : 'Continuer'}
            </button>
          </div>
          <p className="muted small">
            PC réservé à une seule caisse ?{' '}
            <button type="button" className="link" onClick={() => (url.trim() ? setStep('code') : toast.error("Indiquez d'abord l'adresse du serveur"))}>
              J'ai un code d'activation de caisse
            </button>
          </p>
        </form>
      </div>
    );
  }
  if (step === 'code') {
    return (
      <div className="center-page">
        <form
          className="card setup"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const station = await call('setup.join', url, code);
              toast.ok(`PC relié : ${station?.store.name}, ${station?.register?.name}`);
              onDone();
            });
          }}
        >
          <h1>PC d'une caisse</h1>
          <p>Sur le PC principal, dans Administration › Caisses, notez le code d'activation de la caisse : ce PC lui sera réservé.</p>
          <Field label="Code d'activation de la caisse" hint="6 chiffres">
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={6} required autoFocus />
          </Field>
          <div className="actions">
            {back}
            <button className="primary big" type="submit" disabled={busy || code.length !== 6}>
              {busy ? 'Récupération des données…' : 'Rejoindre'}
            </button>
          </div>
        </form>
      </div>
    );
  }
  return (
    <div className="center-page">
      <form
        className="card setup"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await call('setup.joinAsUser', url, login, pin);
            toast.ok(`PC relié à ${r.store?.name ?? 'votre magasin'} : bienvenue ${r.user.name}`);
            onDone();
          });
        }}
      >
        <h1>Connexion au magasin</h1>
        <p>
          Serveur trouvé : <b>{url}</b>. Connectez-vous avec l'identifiant et le code créés pour vous dans Administration › Utilisateurs. Ce PC récupère
          ensuite le catalogue, les utilisateurs et le stock du magasin.
        </p>
        <div className="grid2">
          <Field label="Identifiant">
            <input value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" required autoFocus />
          </Field>
          <Field label="Code">
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} required />
          </Field>
        </div>
        <div className="actions">
          {back}
          <button className="primary big" type="submit" disabled={busy || !login.trim() || pin.length < 4}>
            {busy ? 'Récupération des données…' : 'Se connecter'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** PC du client : la boutique préparée au bureau (Administration › Fiches boutique) s'installe telle quelle. */
async function installPrepared(toast: ReturnType<typeof useToast>) {
  try {
    const info = await call('dossier.chooseFile');
    if (!info) return;
    if (!info.ok) return toast.error(info.error ?? 'Fichier illisible');
    if (info.fiche?.kind !== 'installation') return toast.error("Ce fichier n'est pas une installation préparée : au bureau, faites Administration › Fiches boutique › Préparer l'installation");
    if (!(await askConfirm(`Installer sur ce PC la boutique « ${info.store_name} » (${info.articles} articles) ? ONIX 360 redémarre dessus ; connectez-vous avec les utilisateurs créés au bureau.`))) return;
    await call('setup.installFiche', info.file);
    toast.ok('Installation… ONIX 360 redémarre');
  } catch (err) {
    toast.error(err);
  }
}

/** Nouveau PC après une panne ou un vol : la boutique revient de la sauvegarde gardée sur la clé USB. */
async function restoreBackup(toast: ReturnType<typeof useToast>) {
  try {
    const info = await call('setup.chooseBackup');
    if (!info) return;
    if (!info.ok) return toast.error(`${info.name} : ${info.error ?? 'sauvegarde inutilisable'}. Choisissez une sauvegarde plus ancienne.`);
    const when = new Date(info.created_at).toLocaleString('fr-FR');
    const last = info.last_sale_at ? `, dernière vente le ${new Date(info.last_sale_at).toLocaleString('fr-FR')}` : '';
    const ok = await askConfirm(
      `Restaurer sur ce PC la sauvegarde du ${when}${info.store_name ? ` (${info.store_name})` : ''} : ${info.articles} articles, ${info.sales} tickets${last} ? ONIX 360 redémarre dessus ; connectez-vous avec vos identifiants habituels. Ce qui a été fait après cette sauvegarde est à ressaisir.`,
    );
    if (!ok) return;
    await call('setup.restoreBackup', info.file);
    toast.ok('Restauration… ONIX 360 redémarre');
  } catch (err) {
    toast.error(err);
  }
}

function NewStore({ onDone, onJoin }: { onDone: () => void; onJoin: () => void }) {
  const toast = useToast();
  const [dossiers, setDossiers] = useState(false);
  const [f, setF] = useState({ storeCode: '', storeName: '', address: '', phone: '', taxpayerNumber: '', adminName: '', adminLogin: '', adminPin: '', pin2: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  /** Beaucoup de superettes sont au régime simplifié : pas de TVA tant qu'on ne la coche pas. */
  const [vatEnabled, setVatEnabled] = useState(false);
  /** Organisation de la vente : vendeur-caissier (comme avant) ou vendeur et caissier séparés. */
  const [saleFlow, setSaleFlow] = useState<SaleFlow>('combined');
  /** Métier de départ : rayons, familles et réglages déjà prêts. */
  const [templates, setTemplates] = useState<Result<'template.list'>>([]);
  const [template, setTemplate] = useState('');
  useEffect(() => {
    call('template.list').then(setTemplates, () => undefined);
  }, []);
  const chooseTemplate = async () => {
    try {
      const t = await call('template.choose');
      if (!t) return;
      setTemplates((l) => [...l.filter((x) => x.id !== t.id), t]);
      setTemplate(t.id);
    } catch (err) {
      toast.error(err);
    }
  };
  const picked = templates.find((t) => t.id === template);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.adminPin !== f.pin2) return toast.error('Les deux codes ne correspondent pas');
    try {
      const { pin2: _, ...input } = f;
      await call('setup.bootstrap', { ...input, vatEnabled, template: template || null, saleFlow });
      toast.ok('Magasin créé');
      onDone();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <div className="center-page">
      <form className="card setup" onSubmit={submit}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Mascot mood="bonjour" who="paul" size={64} />
          Bienvenue dans ONIX 360
        </h1>
        <p>Première installation : renseignez votre magasin et le compte administrateur. Vous pourrez ajouter d'autres magasins et caisses ensuite.</p>
        <p className="muted">
          Ancien PC en panne ou volé ?{' '}
          <button type="button" className="link" onClick={() => void restoreBackup(toast)}>
            Restaurer une sauvegarde (clé USB, OneDrive…)
          </button>
        </p>
        <p className="muted">
          Boutique préparée au bureau ? <button type="button" className="link" onClick={() => void installPrepared(toast)}>Installer une boutique préparée…</button> · Fiche apportée par le technicien ou le
          comptable ? <button type="button" className="link" onClick={() => setDossiers(true)}>Ouvrir une boutique…</button>
        </p>
        <h3>Magasin</h3>
        <div className="grid2">
          <Field label="Code magasin" hint="2 à 6 caractères, ex. DLA1">
            <input value={f.storeCode} onChange={set('storeCode')} required maxLength={6} />
          </Field>
          <Field label="Nom du magasin">
            <input value={f.storeName} onChange={set('storeName')} required />
          </Field>
          <Field label="Adresse">
            <input value={f.address} onChange={set('address')} />
          </Field>
          <Field label="Téléphone">
            <input value={f.phone} onChange={set('phone')} />
          </Field>
          <Field label="NIU (numéro contribuable)">
            <input value={f.taxpayerNumber} onChange={set('taxpayerNumber')} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={vatEnabled} onChange={(e) => setVatEnabled(e.target.checked)} /> Magasin assujetti à la TVA (régime du réel)
        </label>
        <p className="muted">
          {vatEnabled
            ? 'Les prix sont TTC : la TVA (19,25 %) est calculée et imprimée sur les tickets et les factures.'
            : 'Régime simplifié : aucune TVA sur les ventes, les achats ni les dépenses. Les tickets portent « TVA non applicable ». Un administrateur pourra l’activer plus tard.'}
        </p>
        <h3>Organisation de la vente</h3>
        <div className="layout-cards" role="radiogroup" aria-label="Organisation de la vente">
          {(Object.keys(SALE_FLOWS) as SaleFlow[]).map((k) => (
            <label key={k} className={`layout-card ${saleFlow === k ? 'on' : ''}`}>
              <span className="layout-name">
                <input type="radio" name="saleFlow" checked={saleFlow === k} onChange={() => setSaleFlow(k)} />
                {k === 'combined' ? 'Vendeur-caissier' : 'Vendeur et caissier séparés'}
              </span>
              <small className="muted">
                {k === 'combined'
                  ? 'La même personne facture et encaisse sur son poste, avec sa caisse. C’est le fonctionnement habituel.'
                  : 'Le vendeur facture sur son PC et envoie la facture à la caisse ; le client paie au caissier, qui ne voit que les factures à encaisser. Les PC sont reliés au serveur central.'}
              </small>
            </label>
          ))}
        </div>
        <p className="muted">Modifiable ensuite par l’administrateur dans Administration › Paramètres › Écran de caisse.</p>
        <Field label="Métier" hint="Rayons, familles et réglages de départ, modifiables ensuite">
          <div className="row">
            <select value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">Aucun : je crée mes rayons moi-même</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.builtin ? '' : ' (fichier)'}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void chooseTemplate()}>
              Modèle sur clé…
            </button>
          </div>
        </Field>
        {picked && (
          <p className="muted">
            {picked.description} {picked.departments} rayons, {picked.families} familles{picked.articles ? `, ${picked.articles} articles` : ''}.
          </p>
        )}
        <h3>Administrateur</h3>
        <div className="grid2">
          <Field label="Nom complet">
            <input value={f.adminName} onChange={set('adminName')} required />
          </Field>
          <Field label="Identifiant">
            <input value={f.adminLogin} onChange={set('adminLogin')} required />
          </Field>
          <Field label="Code secret" hint="4 à 8 chiffres">
            <input type="password" inputMode="numeric" value={f.adminPin} onChange={set('adminPin')} required />
          </Field>
          <Field label="Confirmer le code">
            <input type="password" inputMode="numeric" value={f.pin2} onChange={set('pin2')} required />
          </Field>
        </div>
        <div className="actions">
          <button type="button" onClick={onJoin}>
            Rejoindre un magasin existant
          </button>
          <button className="primary big" type="submit">
            Créer le magasin
          </button>
        </div>
      </form>
      {dossiers && <DossierPicker onClose={() => setDossiers(false)} />}
    </div>
  );
}
