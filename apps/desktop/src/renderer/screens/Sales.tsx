import { useState } from 'react';
import { PAYMENT_METHODS } from '@superette/core';
import { type Result, call } from '../api';
import { Vouchers } from './Vouchers';
import { Field, Modal, Tabs, dateTime, downloadText, fcfa, qty, today, useCan, useLoad, useToast, PhoneApproval } from '../ui';
import { CashOperations, type RegisterPreset, SalesAlerts, SalesRegister } from './Controls';
import { WhatsappTicketDialog, ZView } from './PosDialogs';
import { InvoicePreview } from './docPreview';
import { tx } from '../tax';

export type SalesTab = 'tickets' | 'register' | 'returns' | 'cancelled' | 'find' | 'alerts' | 'cashops' | 'z' | 'export' | 'requests' | 'vouchers';
type ShownTab = Exclude<SalesTab, 'returns' | 'cancelled' | 'find'>;

/**
 * `rights` : sans « Voir tout le registre des factures », l'écran ne montre que
 * les trois dernières factures de l'utilisateur, pour les réimprimer.
 */
export function Sales({ initialTab = 'tickets', rights }: { initialTab?: SalesTab; rights: string[] }) {
  const wide = ['sales', 'sales_alerts', 'cash_operations', 'cash_z', 'accounting_export', 'report_export', 'sale_edit_approve', 'vouchers'].some((r) => rights.includes(r));
  return wide ? <AllSales initialTab={initialTab} rights={rights} /> : <MyLastInvoices />;
}

function AllSales({ initialTab, rights }: { initialTab: SalesTab; rights: string[] }) {
  const can = (...r: string[]) => r.some((x) => rights.includes(x));
  // Chaque onglet suit son droit ; « Mes dernières factures » reste à tous.
  const tabs: [ShownTab, string][] = [
    ['tickets', can('sales') ? 'Factures du jour' : 'Mes dernières factures'],
    ...(can('sales') ? ([['register', 'Registre des ventes']] as [ShownTab, string][]) : []),
    ...(can('sales_alerts') ? ([['alerts', 'Alertes sur les ventes']] as [ShownTab, string][]) : []),
    ...(can('cash_operations') ? ([['cashops', 'Opérations de caisse']] as [ShownTab, string][]) : []),
    ...(can('cash_amounts') && can('cash_z') ? ([['z', 'Clôtures Z']] as [ShownTab, string][]) : []),
    ...(can('accounting_export', 'report_export') ? ([['export', 'Export comptable']] as [ShownTab, string][]) : []),
    ...(can('sale_edit_approve', 'sale_edit_request') ? ([['requests', 'Demandes de modification']] as [ShownTab, string][]) : []),
    ...(can('vouchers') ? ([['vouchers', "Bons d'achat"]] as [ShownTab, string][]) : []),
  ];
  // Retours, annulés et recherche s'ouvrent sur le registre, déjà filtré.
  const preset: RegisterPreset = initialTab === 'returns' ? 'returns' : initialTab === 'cancelled' ? 'cancelled' : 'all';
  const wanted: ShownTab = initialTab === 'returns' || initialTab === 'cancelled' || initialTab === 'find' ? 'register' : initialTab;
  const [tab, setTab] = useState<ShownTab>(tabs.some(([t]) => t === wanted) ? wanted : 'tickets');
  return (
    <div className="page">
      <header className="page-head">
        <h1>Ventes et caisses</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'tickets' && (can('sales') ? <Tickets /> : <MyLastInvoices embedded />)}
      {tab === 'register' && <SalesRegister preset={preset} focusSearch={initialTab === 'find'} />}
      {tab === 'alerts' && <SalesAlerts />}
      {tab === 'cashops' && <CashOperations />}
      {tab === 'z' && <Sessions />}
      {tab === 'export' && <Export />}
      {tab === 'requests' && <EditRequests approve={can('sale_edit_approve')} />}
      {tab === 'vouchers' && <Vouchers />}
    </div>
  );
}

function Tickets() {
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [open, setOpen] = useState<Result<'pos.sale'> | null>(null);
  const sales = useLoad(() => call('pos.sales', { date }), [date]);
  return (
    <>
      <div className="filters">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Heure</th>
            <th>Caissier</th>
            <th>Type</th>
            <th className="r">{tx('Total TTC')}</th>
            <th>État</th>
          </tr>
        </thead>
        <tbody>
          {(sales.data ?? []).map((s) => (
            <tr key={s.id} className="clickable" onClick={() => call('pos.sale', s.id).then(setOpen, toast.error)}>
              <td>{s.number}</td>
              <td>{dateTime(s.created_at)}</td>
              <td>{s.user_name}</td>
              <td>{s.kind === 'sale' ? 'Vente' : 'Retour'}</td>
              <td className={`r ${s.total_ttc < 0 ? 'neg' : ''}`}>{fcfa(s.total_ttc)}</td>
              <td>{s.status === 'cancelled' ? <span className="tag rupture">Annulé</span> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && <SaleDetail sale={open} onClose={() => setOpen(null)} onChanged={sales.reload} />}
    </>
  );
}

/** Les trois dernières factures du caissier, à réimprimer au besoin. */
function MyLastInvoices({ embedded }: { embedded?: boolean }) {
  const toast = useToast();
  const can = useCan();
  const [open, setOpen] = useState<Result<'pos.sale'> | null>(null);
  const sales = useLoad(() => call('pos.sales', {}));
  return (
    <div className={embedded ? '' : 'page'}>
      {!embedded && (
        <header className="page-head">
          <h1>Mes dernières factures</h1>
        </header>
      )}
      <p className="muted">Vos trois dernières factures, à réimprimer si le client le demande.</p>
      <table className="list">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Heure</th>
            <th>Client</th>
            <th>Type</th>
            <th className="r">Total</th>
            <th>État</th>
          </tr>
        </thead>
        <tbody>
          {(sales.data ?? []).map((s) => (
            <tr key={s.id} className="clickable" onClick={() => call('pos.sale', s.id).then(setOpen, toast.error)}>
              <td>{s.number}</td>
              <td>{dateTime(s.created_at)}</td>
              <td>{s.customer_name ?? ''}</td>
              <td>{s.kind === 'sale' ? 'Vente' : 'Retour'}</td>
              <td className={`r ${s.total_ttc < 0 ? 'neg' : ''}`}>{fcfa(s.total_ttc)}</td>
              <td>{s.status === 'cancelled' ? <span className="tag rupture">Annulé</span> : ''}</td>
            </tr>
          ))}
          {sales.data && !sales.data.length && (
            <tr>
              <td colSpan={6} className="muted">
                Aucune facture
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {open && <SaleDetail sale={open} onClose={() => setOpen(null)} onChanged={sales.reload} />}
      {!embedded && can('sale_edit_request') && (
        <>
          <h3>Mes demandes de modification</h3>
          <EditRequests approve={false} />
        </>
      )}
    </div>
  );
}

const REQUEST_STATUS: Record<string, [string, string]> = {
  pending: ['En attente', 'alerte'],
  approved: ['Accordée', 'normal'],
  rejected: ['Refusée', 'rupture'],
  used: ['Facture modifiée', ''],
};

/**
 * Demandes de modification de factures validées. Le gérant accorde ou refuse
 * (motif obligatoire pour un refus) ; le vendeur suit les siennes et, accordée,
 * recharge la facture dans la caisse.
 */
export function EditRequests({ approve }: { approve: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState<'' | 'pending' | 'approved' | 'rejected' | 'used'>(approve ? 'pending' : '');
  const list = useLoad(() => call('editRequests.list', status || null), [status]);
  const [refusing, setRefusing] = useState<Result<'editRequests.list'>[number] | null>(null);
  const [note, setNote] = useState('');
  const decide = async (id: string, ok: boolean, why?: string) => {
    try {
      const r = await call('editRequests.decide', id, ok, why ?? null);
      toast.ok(`${r.number} ${ok ? 'accordée' : 'refusée'}`);
      setRefusing(null);
      setNote('');
      list.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Toutes</option>
          {Object.entries(REQUEST_STATUS).map(([k, [label]]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <span className="muted">Une demande accordée permet une seule modification de la facture, par celui qui l’a demandée.</span>
      </div>
      {list.data?.length === 0 ? (
        <p className="muted">Aucune demande.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Demande</th>
              <th>Date</th>
              <th>Facture</th>
              <th>Client</th>
              <th className="r">Montant</th>
              <th>Demandée par</th>
              <th>Motif</th>
              <th>État</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.number}</td>
                <td className="nowrap">{dateTime(r.created_at)}</td>
                <td>{r.sale_number}</td>
                <td>{r.customer_name ?? ''}</td>
                <td className="r">{fcfa(r.sale_total)}</td>
                <td>{r.requester_name}</td>
                <td>{r.reason}</td>
                <td>
                  <span className={`tag ${REQUEST_STATUS[r.status]![1]}`}>{REQUEST_STATUS[r.status]![0]}</span>
                  {r.decider_name && (
                    <small className="muted">
                      {' '}
                      · {r.decider_name}
                      {r.decision_note ? ` : ${r.decision_note}` : ''}
                    </small>
                  )}
                  {r.new_sale_number && <small className="muted"> → {r.new_sale_number}</small>}
                </td>
                <td className="nowrap">
                  {approve && r.status === 'pending' && (
                    <>
                      <button onClick={() => void decide(r.id, true)}>Accorder</button>
                      <button className="danger" onClick={() => setRefusing(r)}>
                        Refuser
                      </button>
                    </>
                  )}
                  {!approve && r.status === 'approved' && <button onClick={() => editSale(r.sale_id)}>Modifier la facture</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {refusing && (
        <Modal title={`Refuser ${refusing.number}`} onClose={() => setRefusing(null)}>
          <Field label="Pourquoi la demande est refusée">
            <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="actions">
            <button onClick={() => setRefusing(null)}>Retour</button>
            <button className="primary" disabled={!note.trim()} onClick={() => void decide(refusing.id, false, note)}>
              Refuser la demande
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Le vendeur sans le droit de modifier une facture la demande au gérant, avec le motif. */
function EditRequestDialog({ sale, onClose }: { sale: Result<'pos.sale'>; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  return (
    <Modal title={`Demander la modification de ${sale.number}`} onClose={onClose}>
      <p className="muted">Le gérant reçoit la demande dans ses points d’attention. Accordée, vous pourrez modifier cette facture une fois depuis « Mes factures ».</p>
      <Field label="Ce qu’il faut changer">
        <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Le client a pris 3 cartons et non 2…" />
      </Field>
      <div className="actions">
        <button onClick={onClose}>Retour</button>
        <button
          className="primary"
          disabled={reason.trim().length < 3}
          onClick={async () => {
            try {
              const r = await call('editRequests.request', sale.id, reason);
              toast.ok(`Demande ${r.number} envoyée au gérant`);
              onClose();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Envoyer la demande
        </button>
      </div>
    </Modal>
  );
}

function Sessions() {
  const toast = useToast();
  const sessions = useLoad(() => call('pos.sessions'));
  const [z, setZ] = useState<Result<'pos.zReport'> | null>(null);
  return (
    <>
      <table className="list">
        <thead>
          <tr>
            <th>Z n°</th>
            <th>Ouverture</th>
            <th>Clôture</th>
            <th>Caissier</th>
            <th className="r">Théorique</th>
            <th className="r">Compté</th>
            <th className="r">Écart</th>
          </tr>
        </thead>
        <tbody>
          {(sessions.data ?? []).map((s) => (
            <tr key={s.id} className="clickable" onClick={() => call('pos.zReport', s.id).then(setZ, toast.error)}>
              <td>{s.z_number ?? 'en cours'}</td>
              <td>{dateTime(s.opened_at)}</td>
              <td>{s.closed_at ? dateTime(s.closed_at) : '—'}</td>
              <td>{s.user_name}</td>
              <td className="r">{s.expected_cash === null ? '—' : fcfa(s.expected_cash)}</td>
              <td className="r">{s.counted_cash === null ? '—' : fcfa(s.counted_cash)}</td>
              <td className={`r ${(s.difference ?? 0) < 0 ? 'neg' : (s.difference ?? 0) > 0 ? 'pos' : ''}`}>{s.difference === null ? '—' : fcfa(s.difference)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {z && (
        <Modal title={z.session.z_number ? `Rapport Z n° ${z.session.z_number}` : 'Rapport X (caisse ouverte)'} onClose={() => setZ(null)} wide>
          <ZView z={z} />
          <div className="actions">
            <button onClick={() => call('pos.printZ', z.session.id).then(() => toast.ok('Rapport imprimé'), toast.error)}>Imprimer</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Export() {
  const toast = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  return (
    <div className="narrow">
      <p className="muted">
        En attendant le module Comptabilité (phase 3), exportez les ventes ligne par ligne pour votre comptable ou votre logiciel actuel (CSV compatible Excel).
      </p>
      <div className="grid2">
        <Field label="Du">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <button
        className="primary"
        onClick={async () => {
          try {
            downloadText(`ventes_${from}_${to}.csv`, await call('reports.salesCsv', from, to));
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        Télécharger le CSV
      </button>
    </div>
  );
}

/** Demande à la caisse de recharger une facture pour la modifier (App ouvre la bonne fiche). */
export const EDIT_SALE_EVENT = 'fedo:edit-sale';
export const editSale = (saleId: string) => window.dispatchEvent(new CustomEvent(EDIT_SALE_EVENT, { detail: saleId }));

/** Détail d'un ticket ou d'une facture : réimpression, modification, annulation et suppression. */
export function SaleDetail({ sale, onClose, onChanged }: { sale: Result<'pos.sale'>; onClose: () => void; onChanged?: () => void }) {
  const toast = useToast();
  const can = useCan();
  const [preview, setPreview] = useState(false);
  const [voiding, setVoiding] = useState<'cancel' | 'hide' | null>(null);
  const [whatsapp, setWhatsapp] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const live = sale.kind === 'sale' && sale.status === 'completed';
  // Sans le droit de modifier : une demande accordée par le gérant pour cette facture en tient lieu.
  const asking = live && !can('sale_edit') && can('sale_edit_request');
  const requests = useLoad(() => (asking ? call('editRequests.list', 'approved') : Promise.resolve([])), [sale.id, asking]);
  const granted = (requests.data ?? []).some((r) => r.sale_id === sale.id);
  if (requesting) return <EditRequestDialog sale={sale} onClose={() => setRequesting(false)} />;
  if (preview) return <InvoicePreview saleId={sale.id} onClose={() => setPreview(false)} />;
  if (voiding)
    return (
      <VoidSaleDialog
        sale={sale}
        hide={voiding === 'hide'}
        needsPin={!can('sale_cancel_free')}
        onClose={() => setVoiding(null)}
        onDone={() => {
          onChanged?.();
          onClose();
        }}
      />
    );
  return (
    <Modal title={`Ticket ${sale.number}`} onClose={() => onClose()}>
      <p className="muted">
        {dateTime(sale.created_at)} · {sale.user_name}
        {sale.cancel_reason && ` · ${sale.status === 'cancelled' ? 'Annulé' : 'Motif'} : ${sale.cancel_reason}`}
      </p>
      <table className="list compact">
        <tbody>
          {sale.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.label}</td>
              <td className="r">{qty(l.qty, l.unit)}</td>
              <td className="r">{fcfa(l.total_ttc)}</td>
            </tr>
          ))}
          <tr className="b">
            <td>Total</td>
            <td />
            <td className="r">{fcfa(sale.total_ttc)}</td>
          </tr>
          {sale.payments.map((p, i) => (
            <tr key={i}>
              <td>
                {PAYMENT_METHODS[p.method]} {p.reference && <small>· {p.reference}</small>}
              </td>
              <td />
              <td className="r">{fcfa(p.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        {!can('sale_reprint') && <span className="muted">Réimpression non permise (droit « Réimprimer un ticket ou une facture »).</span>}
        <button disabled={!can('sale_reprint')} onClick={() => setPreview(true)} title="Aperçu avec le choix du modèle : facture ou bon de livraison, en A4, listing ou ticket">
          Facture ou BL (aperçu)…
        </button>
        {asking && !granted && (
          <button title="Le gérant accorde ou refuse ; accordée, vous modifiez la facture une fois" onClick={() => setRequesting(true)}>
            Demander la modification…
          </button>
        )}
        {live && (can('sale_edit') || granted) && (
          <button
            title="Recharge la facture dans la caisse : ajoutez ou retirez des articles, changez les quantités, puis validez"
            onClick={() => {
              editSale(sale.id);
              onClose();
            }}
          >
            Modifier
          </button>
        )}
        {live && (
          <button title="Annule la facture : le stock revient et elle sort de la caisse" onClick={() => setVoiding('cancel')}>
            Annuler
          </button>
        )}
        {live && (
          <button className="danger" title="Annule la facture et la retire du registre (toujours visible avec le filtre Annulés)" onClick={() => setVoiding('hide')}>
            Supprimer
          </button>
        )}
        <button onClick={() => setWhatsapp(true)} title="Envoyer le ticket au client par WhatsApp">
          WhatsApp
        </button>
        <button className="primary" disabled={!can('sale_reprint')} onClick={() => call('pos.printTicket', sale.id).then(() => toast.ok('Ticket réimprimé'), toast.error)}>
          Réimprimer le ticket
        </button>
        {whatsapp && <WhatsappTicketDialog saleId={sale.id} number={sale.number} onClose={() => setWhatsapp(false)} />}
      </div>
    </Modal>
  );
}

/** Motif (et code du gérant sans le droit) pour annuler ou supprimer une facture. */
function VoidSaleDialog({ sale, hide, needsPin, onClose, onDone }: { sale: Result<'pos.sale'>; hide: boolean; needsPin: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!reason.trim()) return toast.error('Indiquez le motif');
    setBusy(true);
    try {
      const r = await call('sales.cancel', sale.id, reason, { hide, supervisorPin: needsPin ? pin : undefined });
      toast.ok(r.kind === 'return' ? `Journée déjà clôturée : avoir ${r.number} fait sur la caisse du jour` : hide ? `Facture ${sale.number} supprimée` : `Facture ${sale.number} annulée`);
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`${hide ? 'Supprimer' : 'Annuler'} la facture ${sale.number}`} onClose={onClose}>
      <p className="muted">
        {fcfa(sale.total_ttc)} · la marchandise revient en stock et la vente sort de la caisse.
        {hide ? ' La facture disparaît du registre ; elle reste visible avec le filtre « Annulés » et dans le journal.' : ''}
        {' '}Si la journée de caisse est déjà clôturée, un avoir de toute la facture est fait sur la caisse du jour.
      </p>
      <Field label="Motif">
        <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Erreur de saisie, client parti…" />
      </Field>
      {needsPin && (
        <>
          <Field label="Code du gérant">
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
          </Field>
          <PhoneApproval action={`Annuler la facture ${sale.number} (${fcfa(sale.total_ttc)})${reason.trim() ? ` : ${reason.trim()}` : ''}`} onCode={setPin} />
        </>
      )}
      <div className="actions">
        <button onClick={onClose}>Retour</button>
        <button className="primary" disabled={busy} onClick={() => void submit()}>
          {hide ? 'Supprimer' : 'Annuler la facture'}
        </button>
      </div>
    </Modal>
  );
}
