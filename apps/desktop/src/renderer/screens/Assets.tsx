import { useState } from 'react';
import { ASSET_CATEGORIES, ASSET_FUNDINGS, type AssetFunding } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, askConfirm, dateFr, fcfa, parseAmount, today, useCan, useLoad, useToast } from '../ui';

type Asset = Result<'assets.list'>[number];

const duration = (months: number) => (!months ? 'Non amortissable' : months % 12 === 0 ? `${months / 12} an${months > 12 ? 's' : ''}` : `${months} mois`);

/**
 * Registre des immobilisations : une fiche par bien, son plan d'amortissement,
 * et les écritures (acquisition, dotation de fin d'exercice, sortie) passées
 * toutes seules dans les journaux.
 */
export function Assets() {
  const toast = useToast();
  const can = useCan();
  const [at, setAt] = useState(today());
  const [all, setAll] = useState(false);
  const list = useLoad(() => call('assets.list', { at, includeDisposed: all }), [at, all]);
  const [editing, setEditing] = useState<Asset | 'new' | null>(null);
  const [open, setOpen] = useState<Asset | null>(null);
  const rows = list.data ?? [];
  const sum = (k: 'cost' | 'year_charge' | 'cumulated' | 'net') => rows.reduce((t, a) => t + a[k], 0);
  const edit = can('fixed_asset_edit');

  return (
    <div>
      <p>
        Une fiche par bien durable : réfrigérateur, congélateur, véhicule, PC de caisse, agencements. L’amortissement est linéaire, au prorata des jours. La dotation de chaque exercice se
        passe toute seule à sa date de fin (débit 681, crédit 28…), comme la sortie d’un bien vendu ou mis au rebut.
      </p>
      <div className="filters">
        <label className="inline">
          Situation au <input type="date" value={at} onChange={(e) => setAt(e.target.value || today())} />
        </label>
        <label className="inline">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Biens sortis
        </label>
        <button style={{ marginLeft: 'auto' }} onClick={() => call('assets.print', at, null).catch(toast.error)} disabled={!rows.length}>
          Imprimer le registre et les plans
        </button>
        {edit && (
          <button className="primary" onClick={() => setEditing('new')}>
            Nouvelle immobilisation
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty action={edit ? { label: 'Nouvelle immobilisation', onClick: () => setEditing('new') } : undefined}>Aucune immobilisation enregistrée.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Code</th>
              <th>Bien</th>
              <th>Compte</th>
              <th>Mise en service</th>
              <th>Durée</th>
              <th className="num">Valeur d’origine</th>
              <th className="num">Dotation de l’exercice</th>
              <th className="num">Amort. cumulés</th>
              <th className="num">Valeur nette</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => setOpen(a)}>
                <td>{a.code}</td>
                <td>
                  {a.label}
                  {a.disposed_on && <span className="muted"> · sorti le {dateFr(a.disposed_on)}</span>}
                </td>
                <td>{a.account}</td>
                <td>{dateFr(a.in_service_on)}</td>
                <td>{duration(a.duration_months)}</td>
                <td className="num">{fcfa(a.cost)}</td>
                <td className="num">{a.year_charge ? fcfa(a.year_charge) : ''}</td>
                <td className="num">{fcfa(a.cumulated)}</td>
                <td className="num">
                  <strong>{fcfa(a.net)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>Totaux</td>
              <td className="num">{fcfa(sum('cost'))}</td>
              <td className="num">{fcfa(sum('year_charge'))}</td>
              <td className="num">{fcfa(sum('cumulated'))}</td>
              <td className="num">{fcfa(sum('net'))}</td>
            </tr>
          </tfoot>
        </table>
      )}
      {editing && (
        <AssetForm
          asset={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setOpen(null);
            list.reload();
          }}
        />
      )}
      {open && !editing && (
        <AssetDetail
          asset={open}
          canEdit={edit}
          onClose={() => setOpen(null)}
          onEdit={() => setEditing(open)}
          onChanged={() => {
            setOpen(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function AssetForm({ asset, onClose, onSaved }: { asset: Asset | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState(() => ASSET_CATEGORIES.find((c) => c.account === asset?.account)?.key ?? (asset ? '' : 'equipment'));
  const [label, setLabel] = useState(asset?.label ?? '');
  const [account, setAccount] = useState(asset?.account ?? '241');
  const [inService, setInService] = useState(asset?.in_service_on ?? today());
  const [recorded, setRecorded] = useState(asset?.recorded_on ?? '');
  const [cost, setCost] = useState(asset ? String(asset.cost) : '');
  const [years, setYears] = useState(asset ? String(asset.duration_months / 12) : '5');
  const [funding, setFunding] = useState<AssetFunding>(asset?.funding ?? 'supplier');
  const [supplier, setSupplier] = useState(asset?.supplier ?? '');
  const [notes, setNotes] = useState(asset?.notes ?? '');
  const pick = (key: string) => {
    setCategory(key);
    const c = ASSET_CATEGORIES.find((x) => x.key === key);
    if (c) {
      setAccount(c.account);
      setYears(String(c.years));
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseAmount(cost);
    const months = Math.round(Number(years.replace(',', '.')) * 12);
    if (value === null) return toast.error('Valeur d’origine invalide');
    if (!Number.isFinite(months)) return toast.error('Durée invalide');
    try {
      await call(
        'assets.save',
        {
          label,
          account,
          inServiceOn: inService,
          recordedOn: funding === 'opening' ? recorded || today() : inService,
          cost: value,
          durationMonths: months,
          funding,
          supplier,
          notes,
        },
        asset?.id,
      );
      toast.ok(asset ? 'Immobilisation modifiée' : 'Immobilisation enregistrée');
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={asset ? `Modifier ${asset.code}` : 'Nouvelle immobilisation'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Catégorie" hint="Propose le compte et la durée d’usage courante">
          <select value={category} onChange={(e) => pick(e.target.value)}>
            <option value="">Autre (compte à saisir)</option>
            {ASSET_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label} · {c.account}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bien">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Congélateur coffre 400 L" required autoFocus />
        </Field>
        <div className="row">
          <Field label="Compte">
            <input value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, ''))} required style={{ width: 90 }} />
          </Field>
          <Field label="Valeur d’origine HT (FCFA)">
            <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="numeric" required />
          </Field>
          <Field label="Durée (années)">
            <input value={years} onChange={(e) => setYears(e.target.value)} inputMode="decimal" style={{ width: 70 }} />
          </Field>
        </div>
        <Field label="Comptabilisation de l’achat">
          <select value={funding} onChange={(e) => setFunding(e.target.value as AssetFunding)}>
            {(Object.keys(ASSET_FUNDINGS) as AssetFunding[]).map((k) => (
              <option key={k} value={k}>
                {ASSET_FUNDINGS[k]}
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Field label="Mise en service">
            <input type="date" value={inService} onChange={(e) => setInService(e.target.value)} required />
          </Field>
          {funding === 'opening' && (
            <Field label="Repris dans FEDONIX 360 le" hint="Les amortissements d’avant cette date sont repris tels quels">
              <input type="date" value={recorded || today()} onChange={(e) => setRecorded(e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="Fournisseur">
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        <Field label="Notes" hint="N° de série, n° de facture, emplacement">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Fermer
          </button>
          <button type="submit" className="primary">
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AssetDetail({ asset, canEdit, onClose, onEdit, onChanged }: { asset: Asset; canEdit: boolean; onClose: () => void; onEdit: () => void; onChanged: () => void }) {
  const toast = useToast();
  const plan = useLoad(() => call('assets.schedule', asset.id), [asset.id]);
  const [disposing, setDisposing] = useState(false);
  const remove = async () => {
    if (!(await askConfirm(`Supprimer la fiche « ${asset.label} » saisie par erreur ? Ses écritures disparaissent.`))) return;
    try {
      await call('assets.remove', asset.id);
      toast.ok('Fiche supprimée');
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={`${asset.code} · ${asset.label}`} onClose={onClose} wide>
      <p>
        {fcfa(asset.cost)} sur le compte {asset.account}, mis en service le {dateFr(asset.in_service_on)}
        {asset.recorded_on > asset.in_service_on && `, repris le ${dateFr(asset.recorded_on)}`}. {duration(asset.duration_months)}
        {asset.ends_on && `, jusqu’au ${dateFr(asset.ends_on)}`}. Amortissements sur le {asset.depreciation_account}.
        {asset.supplier && ` Fournisseur : ${asset.supplier}.`}
        {asset.notes && ` ${asset.notes}`}
        {asset.disposed_on && (
          <strong>
            {' '}
            {asset.disposal_kind === 'sale' ? `Vendu ${fcfa(asset.disposal_price ?? 0)}` : 'Mis au rebut'} le {dateFr(asset.disposed_on)}.
          </strong>
        )}
      </p>
      {(plan.data ?? []).length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th>Exercice</th>
              <th className="num">Base</th>
              <th className="num">Dotation</th>
              <th className="num">Cumul</th>
              <th className="num">Valeur nette</th>
            </tr>
          </thead>
          <tbody>
            {plan.data!.map((r) => (
              <tr key={r.to} className={r.prior ? 'muted' : undefined}>
                <td>
                  {dateFr(r.from)} au {dateFr(r.to)}
                  {r.prior && ' (avant la reprise)'}
                </td>
                <td className="num">{fcfa(r.opening)}</td>
                <td className="num">{fcfa(r.charge)}</td>
                <td className="num">{fcfa(r.cumulated)}</td>
                <td className="num">{fcfa(r.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <button onClick={() => call('assets.print', today(), asset.id).catch(toast.error)}>Imprimer le plan</button>
        {canEdit && !asset.disposed_on && (
          <>
            <button className="danger" onClick={() => void remove()}>
              Supprimer
            </button>
            <button onClick={() => setDisposing(true)}>Vendre ou mettre au rebut…</button>
            <button className="primary" onClick={onEdit}>
              Modifier
            </button>
          </>
        )}
      </div>
      {disposing && <DisposeForm asset={asset} onClose={() => setDisposing(false)} onDone={onChanged} />}
    </Modal>
  );
}

function DisposeForm({ asset, onClose, onDone }: { asset: Asset; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [kind, setKind] = useState<'sale' | 'scrap'>('sale');
  const [price, setPrice] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await call('assets.dispose', asset.id, { date, kind, price: kind === 'sale' ? parseAmount(price) : null });
      toast.ok(kind === 'sale' ? 'Vente du bien enregistrée' : 'Mise au rebut enregistrée');
      onDone();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={`Sortie de ${asset.label}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">La dotation court jusqu’à ce jour ; le bien sort du registre avec sa valeur nette (812) et, s’il est vendu, son prix de cession (822).</p>
        <div className="row">
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Motif">
            <select value={kind} onChange={(e) => setKind(e.target.value as 'sale' | 'scrap')}>
              <option value="sale">Vendu</option>
              <option value="scrap">Mis au rebut</option>
            </select>
          </Field>
          {kind === 'sale' && (
            <Field label="Prix de vente (FCFA)">
              <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" required />
            </Field>
          )}
        </div>
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Fermer
          </button>
          <button type="submit" className="primary">
            Enregistrer la sortie
          </button>
        </div>
      </form>
    </Modal>
  );
}
