import { BrowserWindow } from 'electron';
import { PAYMENT_METHODS, formatFcfa, formatQty, formatRate, numberToWordsFr, splitTtc } from '@superette/core';
import { CUSTOMER_PAYMENT_METHODS, EXPENSE_PAYMENT_METHODS, JOURNALS } from '@superette/db';
import type { Services } from '@superette/db';
import type { Printer } from './api';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (v: number) => formatFcfa(v, false);
const dateFr = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Douala', dateStyle: 'short', timeStyle: 'short' });
const dayFr = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR');

const STYLE = `
  @page { size: 80mm auto; margin: 0; }
  body { width: 72mm; margin: 0 4mm; font: 11px/1.35 'Consolas', 'Courier New', monospace; color: #000; }
  h1 { font-size: 14px; text-align: center; margin: 4px 0 0; }
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: bold; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 0; }
  hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
  .big { font-size: 15px; font-weight: bold; }
`;

const A4_STYLE = `
  @page { size: A4; margin: 15mm; }
  body { font: 12px/1.4 'Segoe UI', Arial, sans-serif; color: #111; }
  .head { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
  .box { border: 1px solid #999; padding: 8px 12px; min-width: 240px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #bbb; padding: 5px 7px; text-align: left; }
  th { background: #e8eef7; }
  .r { text-align: right; }
  .total td { font-weight: bold; }
  .sign { margin-top: 40px; display: flex; justify-content: space-between; }
  .totals { width: 45%; margin-left: auto; }
  .muted { color: #555; }
`;

/** Ticket de caisse 80 mm et rapport Z, imprimés par le pilote Windows de l'imprimante. */
export function createPrinter(s: Services): Printer {
  async function printHtml(body: string): Promise<void> {
    if (s.admin.getSetting('printer.enabled') === '0') return;
    const deviceName = s.admin.getSetting('printer.name') || undefined;
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    try {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}</body></html>`;
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await new Promise<void>((resolve, reject) =>
        win.webContents.print({ silent: true, printBackground: false, deviceName, margins: { marginType: 'none' } }, (ok, reason) =>
          ok ? resolve() : reject(new Error(`Impression impossible : ${reason}`)),
        ),
      );
    } finally {
      win.destroy();
    }
  }

  /** Document A4 (bon de commande) : la fenêtre d'impression Windows s'ouvre pour choisir l'imprimante ou « Enregistrer en PDF ». */
  async function printA4(body: string): Promise<void> {
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    try {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${A4_STYLE}</style></head><body>${body}</body></html>`;
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await new Promise<void>((resolve, reject) =>
        win.webContents.print({ silent: false, printBackground: true, pageSize: 'A4' }, (ok, reason) =>
          ok || reason === 'cancelled' ? resolve() : reject(new Error(`Impression impossible : ${reason}`)),
        ),
      );
    } finally {
      win.destroy();
    }
  }

  function header(): string {
    const station = s.admin.station();
    if (!station) return '';
    const st = station.store;
    return `<h1>${esc(st.name)}</h1>
      <div class="c">${[st.address, st.phone].filter(Boolean).map((v) => esc(v!)).join('<br>')}</div>
      ${st.taxpayer_number ? `<div class="c">NIU : ${esc(st.taxpayer_number)}</div>` : ''}<hr>`;
  }

  function a4Head(store: { name: string; address: string | null; phone: string | null; taxpayer_number: string | null }): string {
    return `<div class="head"><div><h1>${esc(store.name)}</h1>${[store.address, store.phone].filter(Boolean).map((v) => esc(v!)).join('<br>')}</div>
      ${store.taxpayer_number ? `<div class="box">NIU : ${esc(store.taxpayer_number)}</div>` : ''}</div>`;
  }
  const periodFr = (from?: string | null, to?: string | null) =>
    `${from ? `Du ${dayFr(from)} ` : 'Depuis le début '}${to ? `au ${dayFr(to)}` : `au ${new Date().toLocaleDateString('fr-FR')}`}`;

  return {
    async ticket(saleId) {
      const sale = s.pos.getSale(saleId);
      const footer = s.admin.getSetting('ticket.footer') ?? 'Merci de votre visite !';
      const lines = sale.lines
        .map((l) => {
          const qty = l.qty === 1000 ? '' : `<tr><td colspan="2">&nbsp;&nbsp;${formatQty(Math.abs(l.qty), l.unit)} x ${money(l.unit_price)}${l.discount ? ` (remise ${money(l.discount)})` : ''}</td></tr>`;
          return `<tr><td>${esc(l.label)}</td><td class="r">${money(l.total_ttc)}</td></tr>${qty}`;
        })
        .join('');
      const byRate = new Map<number, number>();
      for (const l of sale.lines) byRate.set(l.vat_rate_bp, (byRate.get(l.vat_rate_bp) ?? 0) + l.total_ttc);
      const payments = sale.payments
        .map((p) => `<tr><td>${esc(PAYMENT_METHODS[p.method])}${p.reference ? ` ${esc(p.reference)}` : ''}</td><td class="r">${money(p.amount)}</td></tr>`)
        .join('');
      await printHtml(`${header()}
        <div>${sale.kind === 'return' ? '<b>RETOUR CLIENT</b><br>' : ''}Ticket ${esc(sale.number)}<br>${dateFr(sale.created_at)} · ${esc(sale.user_name)}${
          sale.customer_name ? `<br>Client : ${esc(sale.customer_name)}` : ''
        }</div><hr>
        <table>${lines}</table><hr>
        <table><tr><td class="big">TOTAL FCFA</td><td class="r big">${money(sale.total_ttc)}</td></tr>${payments}
        ${sale.change_given ? `<tr><td>Rendu monnaie</td><td class="r">${money(sale.change_given)}</td></tr>` : ''}</table>
        ${sale.due_date ? `<div>À régler avant le ${dayFr(sale.due_date)}</div>` : ''}<hr>
        <table>${[...byRate.entries()]
          .map(([rate, ttc]) => `<tr><td>TVA ${formatRate(rate)} sur ${money(ttc)}</td><td class="r"></td></tr>`)
          .join('')}
        <tr><td>dont TVA</td><td class="r">${money(sale.total_tva)}</td></tr></table><hr>
        <div class="c">${esc(footer)}</div>`);
    },

    async zReport(sessionId) {
      const z = s.pos.zReport(sessionId);
      const row = (label: string, v: number) => `<tr><td>${esc(label)}</td><td class="r">${money(v)}</td></tr>`;
      await printHtml(`${header()}
        <div class="c b">RAPPORT Z${z.session.z_number ? ` N° ${z.session.z_number}` : ' (provisoire)'}</div>
        <div>${esc(z.registerName)} · ${esc(z.session.user_name)}<br>Ouverture ${dateFr(z.session.opened_at)}${
          z.session.closed_at ? `<br>Clôture ${dateFr(z.session.closed_at)}` : ''
        }</div><hr>
        <table>${row('Tickets', z.ticketCount)}${row('Ventes TTC', z.salesTtc)}${row('Retours', z.returnsTtc)}
        ${row('CA net TTC', z.netTtc)}${row('Remises', z.discounts)}${row(`Annulations (${z.cancelled.count})`, z.cancelled.amount)}</table><hr>
        <div class="b">Encaissements</div><table>${z.byMethod.map((m) => row(m.label, m.amount)).join('')}</table><hr>
        ${z.customerReceipts.length ? `<div class="b">Règlements clients (crédit)</div><table>${z.customerReceipts.map((m) => row(m.label, m.amount)).join('')}</table><hr>` : ''}
        ${z.expenses.length ? `<div class="b">Dépenses payées en caisse</div><table>${z.expenses.map((e) => row(`${e.number} ${e.label}`, e.amount)).join('')}</table><hr>` : ''}
        <div class="b">TVA</div><table>${z.vat.map((v) => row(`${formatRate(v.rate)} HT ${money(v.ht)}`, v.tva)).join('')}</table><hr>
        <div class="b">Espèces</div><table>${row('Fond de caisse', z.cash.openingFloat)}${row('Ventes espèces', z.cash.cashSales)}
        ${row('Remboursements', -z.cash.cashRefunds)}${row('Apports', z.cash.cashIn)}${row('Prélèvements', -z.cash.cashOut)}
        ${z.cash.customerReceipts ? row('Règlements clients', z.cash.customerReceipts) : ''}
        ${z.cash.expenses ? row('Dépenses payées', -z.cash.expenses) : ''}
        ${row('Théorique', z.cash.expected)}${z.counted !== null ? row('Compté', z.counted) + row('Écart', z.difference ?? 0) : ''}</table>`);
    },

    async purchaseOrder(orderId) {
      const o = s.purchases.getOrder(orderId);
      const sup = s.purchases.getSupplier(o.supplier_id);
      const store = s.admin.getStore(o.store_id);
      const rows = o.lines
        .map(
          (l) => `<tr><td>${esc(l.supplier_ref ?? '')}</td><td>${esc(l.article_code)}</td><td>${esc(l.article_name)}</td>
            <td class="r">${formatQty(l.qty, l.unit)}</td><td class="r">${money(l.unit_cost)}</td><td class="r">${money(l.total_ht)}</td></tr>`,
        )
        .join('');
      await printA4(`<div class="head">
          <div><h1>${esc(store.name)}</h1>${[store.address, store.phone, store.taxpayer_number ? `NIU ${store.taxpayer_number}` : null]
            .filter(Boolean)
            .map((v) => esc(v!))
            .join('<br>')}</div>
          <div class="box"><b>${esc(sup.name)}</b><br>${[sup.contact, sup.address, sup.phone, sup.email].filter(Boolean).map((v) => esc(v!)).join('<br>')}</div>
        </div>
        <h1>Bon de commande ${esc(o.number)}</h1>
        <div>Date : ${new Date(`${o.order_date}T00:00:00`).toLocaleDateString('fr-FR')}${
          o.expected_date ? ` · Livraison souhaitée : ${new Date(`${o.expected_date}T00:00:00`).toLocaleDateString('fr-FR')}` : ''
        } · Livrer à : ${esc(o.warehouse_name)}</div>
        <table><thead><tr><th>Réf. fournisseur</th><th>Code</th><th>Désignation</th><th class="r">Quantité</th><th class="r">PU HT</th><th class="r">Total HT</th></tr></thead>
        <tbody>${rows}<tr class="total"><td colspan="5">Total HT (FCFA)</td><td class="r">${money(o.total_ht)}</td></tr></tbody></table>
        ${o.notes ? `<p>${esc(o.notes)}</p>` : ''}
        <div class="sign"><div>Établi par : ${esc(o.user_name ?? '')}</div><div>Signature et cachet</div></div>`);
    },

    async invoice(saleId) {
      const sale = s.pos.getSale(saleId);
      const store = s.admin.getStore(sale.store_id);
      const c = sale.customer_id ? s.customers.getCustomer(sale.customer_id) : null;
      const rows = sale.lines
        .map((l) => {
          const ht = splitTtc(l.total_ttc, l.vat_rate_bp).ht;
          return `<tr><td>${esc(l.label)}</td><td class="r">${formatQty(Math.abs(l.qty), l.unit)}</td><td class="r">${money(l.unit_price)}</td>
            <td class="r">${l.discount ? money(l.discount) : ''}</td><td class="r">${formatRate(l.vat_rate_bp)}</td><td class="r">${money(ht)}</td><td class="r">${money(l.total_ttc)}</td></tr>`;
        })
        .join('');
      const byRate = new Map<number, number>();
      for (const l of sale.lines) byRate.set(l.vat_rate_bp, (byRate.get(l.vat_rate_bp) ?? 0) + l.total_ttc);
      const vat = [...byRate.entries()]
        .filter(([rate]) => rate > 0)
        .map(([rate, ttc]) => `<tr><td>TVA ${formatRate(rate)}</td><td class="r">${money(splitTtc(ttc, rate).tva)}</td></tr>`)
        .join('');
      const pays = sale.payments
        .map((p) => `<tr><td>${esc(PAYMENT_METHODS[p.method])}${p.reference ? ` (${esc(p.reference)})` : ''}</td><td class="r">${money(p.amount)}</td></tr>`)
        .join('');
      const title = sale.kind === 'return' ? 'Avoir' : 'Facture';
      await printA4(`<div class="head">
          <div><h1>${esc(store.name)}</h1>${[store.address, store.phone, store.taxpayer_number ? `NIU ${store.taxpayer_number}` : null]
            .filter(Boolean)
            .map((v) => esc(v!))
            .join('<br>')}</div>
          <div class="box">${
            c
              ? `<b>${esc(c.name)}</b><br>${[c.address, c.phone, c.taxpayer_number ? `NIU ${c.taxpayer_number}` : null, `Compte ${c.code}`]
                  .filter(Boolean)
                  .map((v) => esc(v!))
                  .join('<br>')}`
              : '<b>Client comptoir</b>'
          }</div>
        </div>
        <h1>${title} ${esc(sale.number)}</h1>
        <div>Date : ${dayFr(sale.created_at)}${sale.due_date ? ` · Échéance : ${dayFr(sale.due_date)}` : ''} · Vendeur : ${esc(sale.user_name)}</div>
        <table><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">PU TTC</th><th class="r">Remise</th><th class="r">TVA</th><th class="r">Total HT</th><th class="r">Total TTC</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <table class="totals"><tr><td>Total HT</td><td class="r">${money(sale.total_ht)}</td></tr>${vat}
          <tr class="total"><td>Total TTC (FCFA)</td><td class="r">${money(sale.total_ttc)}</td></tr>${pays}</table>
        <div class="sign"><div>Le client</div><div>Pour ${esc(store.name)}</div></div>`);
    },

    async quote(quoteId) {
      const q = s.quotes.get(quoteId);
      const store = s.admin.getStore(q.store_id);
      const c = q.customer_id ? s.customers.getCustomer(q.customer_id) : null;
      const rows = q.lines
        .map((l) => {
          const ht = splitTtc(l.total_ttc, l.vat_rate_bp).ht;
          return `<tr><td>${esc(l.label)}</td><td class="r">${formatQty(l.qty, l.unit)}</td><td class="r">${money(l.unit_price)}</td>
            <td class="r">${l.discount ? money(l.discount) : ''}</td><td class="r">${formatRate(l.vat_rate_bp)}</td><td class="r">${money(ht)}</td><td class="r">${money(l.total_ttc)}</td></tr>`;
        })
        .join('');
      const byRate = new Map<number, number>();
      for (const l of q.lines) byRate.set(l.vat_rate_bp, (byRate.get(l.vat_rate_bp) ?? 0) + l.total_ttc);
      const vat = [...byRate.entries()]
        .filter(([rate]) => rate > 0)
        .map(([rate, ttc]) => `<tr><td>TVA ${formatRate(rate)}</td><td class="r">${money(splitTtc(ttc, rate).tva)}</td></tr>`)
        .join('');
      const title = q.kind === 'proforma' ? 'Facture proforma' : 'Devis';
      const words = numberToWordsFr(q.total_ttc);
      await printA4(`<div class="head">
          <div><h1>${esc(store.name)}</h1>${[store.address, store.phone, store.taxpayer_number ? `NIU ${store.taxpayer_number}` : null]
            .filter(Boolean)
            .map((v) => esc(v!))
            .join('<br>')}</div>
          <div class="box">${
            c
              ? `<b>${esc(c.name)}</b><br>${[c.address, c.phone, c.taxpayer_number ? `NIU ${c.taxpayer_number}` : null].filter(Boolean).map((v) => esc(v!)).join('<br>')}`
              : `<b>${esc(q.customer_name ?? '')}</b>`
          }</div>
        </div>
        <h1>${title} ${esc(q.number)}${q.state === 'cancelled' ? ' (annulé)' : ''}</h1>
        <div>Date : ${dayFr(q.quote_date)} · Valable jusqu'au ${dayFr(q.valid_until)}${q.user_name ? ` · Établi par ${esc(q.user_name)}` : ''}</div>
        <table><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">PU TTC</th><th class="r">Remise</th><th class="r">TVA</th><th class="r">Total HT</th><th class="r">Total TTC</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <table class="totals"><tr><td>Total HT</td><td class="r">${money(q.total_ht)}</td></tr>${vat}
          <tr class="total"><td>Net à payer TTC (FCFA)</td><td class="r">${money(q.total_ttc)}</td></tr></table>
        <p>Arrêté${q.kind === 'proforma' ? 'e la présente facture proforma' : ' le présent devis'} à la somme de <b>${esc(words)} francs CFA</b> toutes taxes comprises.</p>
        ${q.notes ? `<p>${esc(q.notes)}</p>` : ''}
        <p class="muted">Prix garantis jusqu'au ${dayFr(q.valid_until)} dans la limite des stocks disponibles. Ce document n'est pas une facture définitive.</p>
        <div class="sign"><div>Bon pour accord, le client<br><br>Date et signature</div><div>Pour ${esc(store.name)}</div></div>`);
    },

    async statement(storeId, customerId, from, to) {
      const store = s.admin.getStore(storeId);
      const c = s.customers.getCustomer(customerId);
      const acc = s.customers.account(storeId, customerId);
      const st = s.customers.statement(storeId, customerId, { from: from ?? undefined, to: to ?? undefined });
      const rows = st.lines
        .map(
          (l) => `<tr><td>${dayFr(l.date)}</td><td>${esc(l.number)}</td><td>${esc(l.label)}</td><td class="r">${l.debit ? money(l.debit) : ''}</td>
            <td class="r">${l.credit ? money(l.credit) : ''}</td><td class="r">${money(l.balance)}</td></tr>`,
        )
        .join('');
      const open = acc.openItems
        .map((i) => `<tr><td>${esc(i.number)}</td><td>${dayFr(i.created_at)}</td><td>${dayFr(i.due_date)}</td><td class="r">${money(i.remaining)}</td><td>${i.days_late ? `${i.days_late} j de retard` : ''}</td></tr>`)
        .join('');
      await printA4(`<div class="head">
          <div><h1>${esc(store.name)}</h1>${[store.address, store.phone].filter(Boolean).map((v) => esc(v!)).join('<br>')}</div>
          <div class="box"><b>${esc(c.name)}</b><br>${[c.address, c.phone, `Compte ${c.code}`].filter(Boolean).map((v) => esc(v!)).join('<br>')}</div>
        </div>
        <h1>Relevé de compte</h1>
        <div>${from ? `Du ${dayFr(from)} ` : ''}${to ? `au ${dayFr(to)}` : `au ${new Date().toLocaleDateString('fr-FR')}`}</div>
        <table><thead><tr><th>Date</th><th>Pièce</th><th>Libellé</th><th class="r">Débit</th><th class="r">Crédit</th><th class="r">Solde</th></tr></thead>
        <tbody>${from ? `<tr><td colspan="5">Solde au ${dayFr(from)}</td><td class="r">${money(st.opening)}</td></tr>` : ''}${rows}
        <tr class="total"><td colspan="5">Solde dû (FCFA)</td><td class="r">${money(st.closing)}</td></tr></tbody></table>
        ${open ? `<h3>Factures restant dues</h3><table><thead><tr><th>Pièce</th><th>Date</th><th>Échéance</th><th class="r">Reste dû</th><th></th></tr></thead><tbody>${open}</tbody></table>` : ''}
        <p class="muted">Plafond de crédit : ${money(c.credit_limit)} FCFA · Délai de paiement : ${c.payment_terms_days} jours</p>`);
    },

    async customerReceipt(paymentId) {
      const p = s.customers.getPayment(paymentId);
      const acc = s.customers.account(p.store_id, p.customer_id);
      await printHtml(`${header()}
        <div class="c b">REÇU DE RÈGLEMENT</div>
        <div>${esc(p.number)}<br>${dateFr(p.paid_at)}${p.user_name ? ` · ${esc(p.user_name)}` : ''}<br>Client : ${esc(p.customer_name)}</div><hr>
        <table><tr><td class="big">Reçu FCFA</td><td class="r big">${money(p.amount)}</td></tr>
        <tr><td>${esc(CUSTOMER_PAYMENT_METHODS[p.method])}${p.reference ? ` ${esc(p.reference)}` : ''}</td><td></td></tr>
        <tr><td>Reste dû après règlement</td><td class="r">${money(acc.balance)}</td></tr></table><hr>
        <div class="c">Merci !</div>`);
    },

    async expenseVoucher(expenseId) {
      const e = s.expenses.get(expenseId);
      await printHtml(`${header()}
        <div class="c b">${e.session_id ? 'BON DE SORTIE DE CAISSE' : 'PIÈCE DE DÉPENSE'}</div>
        <div>${esc(e.number)}${e.status === 'cancelled' ? ' · <b>ANNULÉE</b>' : ''}<br>${dayFr(e.expense_date)}${e.register_name ? ` · ${esc(e.register_name)}` : ''}${
          e.user_name ? ` · ${esc(e.user_name)}` : ''
        }</div><hr>
        <div>${esc(e.category_name)}<br><b>${esc(e.label)}</b>${e.beneficiary ? `<br>Bénéficiaire : ${esc(e.beneficiary)}` : ''}</div><hr>
        <table><tr><td class="big">Montant FCFA</td><td class="r big">${money(e.amount)}</td></tr>
        ${e.vat ? `<tr><td>dont TVA récupérable</td><td class="r">${money(e.vat)}</td></tr>` : ''}
        <tr><td>${esc(EXPENSE_PAYMENT_METHODS[e.method])}${e.reference ? ` ${esc(e.reference)}` : ''}</td><td></td></tr></table>
        ${e.authorized_by_name ? `<div>Autorisé par ${esc(e.authorized_by_name)}</div>` : ''}<hr>
        <table><tr><td>Le bénéficiaire</td><td class="r">Le responsable</td></tr></table><br><br><br>`);
    },

    async vatReturn(storeId, month) {
      const store = s.admin.getStore(storeId);
      const v = s.accounting.vatReturn(storeId, month);
      const inst = s.tax.instalment(storeId, month);
      const [y, m] = month.split('-');
      const period = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      const rates = v.sales
        .map((r) => `<tr><td>Ventes à ${formatRate(r.rate)}</td><td class="r">${money(r.ttc)}</td><td class="r">${money(r.ht)}</td><td class="r">${money(r.tva)}</td></tr>`)
        .join('');
      const rounding = v.collected - v.sales.reduce((t, r) => t + r.tva, 0);
      await printA4(`${a4Head(store)}
        <h1>Déclaration de TVA, ${esc(period)}</h1>
        <p class="muted">Document de travail pour remplir la déclaration mensuelle sur le portail de la DGI. Les précomptes et le droit d'accises ne sont pas repris ici.</p>
        <h3>Chiffre d'affaires et TVA collectée</h3>
        <table><thead><tr><th>Taux</th><th class="r">TTC</th><th class="r">HT</th><th class="r">TVA</th></tr></thead><tbody>${rates}
        ${rounding ? `<tr><td colspan="3">Arrondis de TVA ticket par ticket</td><td class="r">${money(rounding)}</td></tr>` : ''}
        <tr class="total"><td>Chiffre d'affaires HT déclaré, dont exonéré ${money(v.exemptHt)}</td><td></td><td class="r">${money(v.turnoverHt)}</td><td class="r">${money(v.collected)}</td></tr></tbody></table>
        <h3>TVA déductible</h3>
        <table><tbody><tr><td>Achats de marchandises HT (${v.invoiceCount} factures et avoirs fournisseurs)</td><td class="r">${money(v.purchasesHt)}</td></tr>
        <tr><td>TVA récupérable sur achats de marchandises</td><td class="r">${money(v.purchasesVat)}</td></tr>
        <tr><td>Autres charges HT (dépenses : ${v.expenseCount} factures avec TVA)</td><td class="r">${money(v.expensesHt)}</td></tr>
        <tr><td>TVA récupérable sur dépenses</td><td class="r">${money(v.expensesVat)}</td></tr>
        <tr><td>Crédit de TVA reporté du mois précédent</td><td class="r">${money(v.previousCredit)}</td></tr></tbody></table>
        <table class="totals"><tbody>
        <tr class="total"><td>TVA collectée</td><td class="r">${money(v.collected)}</td></tr>
        <tr><td>TVA déductible et crédit reporté</td><td class="r">${money(v.deductible + v.previousCredit)}</td></tr>
        <tr class="total"><td>${v.due ? 'TVA à payer (FCFA)' : 'Crédit de TVA à reporter (FCFA)'}</td><td class="r">${money(v.due || v.credit)}</td></tr></tbody></table>
        <h3>Acompte d'impôt sur le résultat (minimum de perception)</h3>
        <table><tbody><tr><td>Chiffre d'affaires HT × ${formatRate(inst.rate)}</td><td class="r">${money(inst.principal)}</td></tr>
        <tr><td>Centimes additionnels communaux (10 %)</td><td class="r">${money(inst.cac)}</td></tr>
        <tr class="total"><td>Acompte à payer</td><td class="r">${money(inst.total)}</td></tr></tbody></table>
        <table class="totals"><tbody><tr class="total"><td>Total à verser à la DGI (TVA et acompte)</td><td class="r">${money(v.due + inst.total)}</td></tr></tbody></table>
        <p class="muted">Écriture du paiement de l'acompte : débit 441, crédit 521 (journal de banque) ou 5521 / 5522 si payé par Mobile Money.</p>`);
    },

    async trialBalance(storeId, from, to) {
      const store = s.admin.getStore(storeId);
      const tb = s.accounting.trialBalance(storeId, { from: from ?? undefined, to: to ?? undefined });
      const cell = (v: number) => `<td class="r">${v ? money(v) : ''}</td>`;
      const rows = tb.rows
        .map((r) => `<tr><td>${esc(r.account)}</td><td>${esc(r.label)}</td>${cell(r.opening)}${cell(r.debit)}${cell(r.credit)}${cell(Math.max(r.closing, 0))}${cell(Math.max(-r.closing, 0))}</tr>`)
        .join('');
      const closingD = tb.rows.reduce((t, r) => t + Math.max(r.closing, 0), 0);
      const closingC = tb.rows.reduce((t, r) => t + Math.max(-r.closing, 0), 0);
      await printA4(`${a4Head(store)}
        <h1>Balance générale</h1><div>${periodFr(from, to)}</div>
        <table><thead><tr><th>Compte</th><th>Intitulé</th><th class="r">À-nouveau</th><th class="r">Débit</th><th class="r">Crédit</th><th class="r">Solde débiteur</th><th class="r">Solde créditeur</th></tr></thead>
        <tbody>${rows}<tr class="total"><td colspan="2">Totaux (FCFA)</td>${cell(tb.totals.opening)}${cell(tb.totals.debit)}${cell(tb.totals.credit)}${cell(closingD)}${cell(closingC)}</tr></tbody></table>`);
    },

    async statements(storeId, from, to) {
      const store = s.admin.getStore(storeId);
      const st = s.statements.statements(storeId, { from, to });
      const flows = s.statements.cashFlow(storeId, { from, to });
      const v = (n: number | undefined) => (n ? money(n) : '-');
      const years = `<th class="r">Exercice au ${dayFr(st.to)}</th><th class="r">Exercice au ${dayFr(st.previousTo)}</th>`;
      const row = (r: { ref: string; label: string; total?: boolean }, cells: string) =>
        `<tr${r.total ? ' class="total"' : ''}><td>${r.ref}</td><td>${esc(r.label)}</td>${cells}</tr>`;
      const title = (t: string) => `${a4Head(store)}<h1>${t}</h1><div>Exercice du ${dayFr(st.from)} au ${dayFr(st.to)} · montants en FCFA · SYSCOHADA révisé, système normal</div>`;
      const assets = st.assets
        .map((a) => row(a, `<td class="r">${a.total ? '' : v(a.gross)}</td><td class="r">${a.total ? '' : v(a.depreciation)}</td><td class="r">${v(a.net)}</td><td class="r">${v(a.previous)}</td>`))
        .join('');
      const lines = (rows: typeof st.liabilities) => rows.map((l) => row(l, `<td class="r">${v(l.net)}</td><td class="r">${v(l.previous)}</td>`)).join('');
      await printA4(`${title('Bilan : actif')}
        <table><thead><tr><th>Réf</th><th>Actif</th><th class="r">Brut</th><th class="r">Amort. et dépréc.</th><th class="r">Net</th><th class="r">Net N-1</th></tr></thead><tbody>${assets}</tbody></table>
        <div style="page-break-before: always"></div>${title('Bilan : passif')}
        <table><thead><tr><th>Réf</th><th>Passif</th>${years}</tr></thead><tbody>${lines(st.liabilities)}</tbody></table>
        <div style="page-break-before: always"></div>${title('Compte de résultat')}
        <table><thead><tr><th>Réf</th><th>Libellé</th>${years}</tr></thead><tbody>${lines(st.income)}</tbody></table>
        <p class="muted">Stock de marchandises valorisé au coût moyen pondéré (CMUP) d'après les mouvements de stock : ${money(st.stock.opening)} au début, ${money(st.stock.closing)} à la clôture.</p>
        <div style="page-break-before: always"></div>${title('Tableau des flux de trésorerie')}
        <table><thead><tr><th>Réf</th><th>Libellé</th>${years}</tr></thead><tbody>${lines(flows.rows)}</tbody></table>
        ${flows.check.gap ? `<p>Trésorerie au bilan : ${money(flows.check.treasury)}, écart de ${money(flows.check.gap)} avec la ligne ZH, à analyser.</p>` : ''}`);
    },

    async notes(storeId, year) {
      const store = s.admin.getStore(storeId);
      const { notes } = s.notes.notes(storeId, year);
      const v = (n: number) => (n ? (n < 0 ? `- ${money(-n)}` : money(n)) : '-');
      const body = notes
        .map((n) => {
          const rows = n.rows.length
            ? n.rows.map((r) => `<tr${r.total ? ' class="total"' : ''}><td>${esc(r.label)}</td>${r.values.map((x) => `<td class="r">${v(x)}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${n.columns.length + 1}" class="muted">Néant</td></tr>`;
          return `<div style="break-inside: avoid"><h3>Note ${esc(n.id === 'RF' ? '' : n.id)}${n.id === 'RF' ? '' : ' : '}${esc(n.title)}</h3>
            <table><thead><tr><th>Libellé</th>${n.columns.map((c) => `<th class="r">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
            ${n.comment ? `<p class="muted">${esc(n.comment)}</p>` : ''}</div>`;
        })
        .join('');
      await printA4(`${a4Head(store)}
        <h1>Notes annexes : exercice ${year}</h1><div>Montants en FCFA · SYSCOHADA révisé, système normal · notes établies à partir des écritures ; les notes déclaratives (engagements, effectifs, informations sociales) sont à compléter par le comptable</div>
        ${body}`);
    },

    async taxAssessment(storeId, year) {
      const store = s.admin.getStore(storeId);
      const a = s.tax.assessment(storeId, year);
      const signed = (v: number) => (v < 0 ? `- ${money(-v)}` : money(v));
      const company = a.settings.form === 'company';
      const adj = a.settings.adjustments
        .map((x) => `<tr><td>${x.kind === 'add' ? 'Réintégration' : 'Déduction'} : ${esc(x.label)}</td><td class="r">${x.kind === 'add' ? '' : '- '}${money(x.amount)}</td></tr>`)
        .join('');
      const months = a.instalments
        .map((i) => `<tr><td>${new Date(`${i.month}-01T00:00:00`).toLocaleDateString('fr-FR', { month: 'long' })}</td><td class="r">${money(i.turnoverHt)}</td><td class="r">${money(i.principal)}</td><td class="r">${money(i.cac)}</td><td class="r">${money(i.total)}</td></tr>`)
        .join('');
      await printA4(`${a4Head(store)}
        <h1>${company ? 'Impôt sur les sociétés' : 'Impôt sur le revenu (BIC)'} : exercice ${year}</h1>
        <div>${company ? 'Société' : 'Entreprise individuelle'}, régime ${a.settings.regime === 'reel' ? 'du réel' : 'simplifié'} · montants en FCFA${a.provisional ? ' · <strong>calcul provisoire, exercice en cours</strong>' : ''}</div>
        <h3>Du résultat comptable au résultat fiscal</h3>
        <table><tbody>
        <tr><td>Résultat net comptable avant impôt sur le résultat</td><td class="r">${signed(a.resultBeforeTax)}</td></tr>${adj}
        <tr class="total"><td>Résultat fiscal</td><td class="r">${signed(a.fiscalResult)}</td></tr>
        <tr><td>Déficits antérieurs imputés</td><td class="r">${a.lossesUsed ? `- ${money(a.lossesUsed)}` : '-'}</td></tr>
        <tr class="total"><td>Bénéfice imposable</td><td class="r">${money(a.taxableIncome)}</td></tr>
        ${a.lossCarriedForward ? `<tr><td>Déficit reportable sur les exercices suivants</td><td class="r">${money(a.lossCarriedForward)}</td></tr>` : ''}
        </tbody></table>
        <h3>Liquidation</h3>
        <table><tbody>
        <tr><td>${company ? `Impôt sur les sociétés au taux de ${formatRate(a.rateApplied)}` : `IRPP au barème (taux moyen ${formatRate(a.rateApplied)})`}</td><td class="r">${money(a.tax.principal)}</td></tr>
        <tr><td>Centimes additionnels communaux (10 %)</td><td class="r">${money(a.tax.cac)}</td></tr>
        <tr class="total"><td>Impôt calculé</td><td class="r">${money(a.tax.total)}</td></tr>
        <tr><td>Minimum de perception (acomptes de l'exercice, ${formatRate(a.settings.rates.minimumRate)} du chiffre d'affaires HT de ${money(a.turnoverHt)}, CAC compris)</td><td class="r">${money(a.minimum)}</td></tr>
        <tr class="total"><td>Impôt dû (le plus élevé des deux)</td><td class="r">${money(a.due)}</td></tr>
        <tr><td>Acomptes mensuels</td><td class="r">- ${money(a.minimum)}</td></tr>
        <tr class="total"><td>Solde à payer</td><td class="r">${money(a.balance)}</td></tr>
        </tbody></table>
        <h3>Acomptes mensuels</h3>
        <table><thead><tr><th>Mois</th><th class="r">Chiffre d'affaires HT</th><th class="r">Principal</th><th class="r">CAC</th><th class="r">Acompte</th></tr></thead><tbody>${months}</tbody></table>
        <p class="muted">Taux par défaut du Code général des impôts, modifiables dans l'application : à faire valider par votre comptable avant le dépôt de la DSF.</p>`);
    },

    async reconciliation(storeId, accountId, date, statementBalance) {
      const store = s.admin.getStore(storeId);
      const st = s.reconciliation.state(storeId, accountId, date);
      const signed = (v: number) => (v < 0 ? `- ${money(-v)}` : money(v));
      const rows = (items: { date: string; label: string; ref: string; amount: number }[], empty: string) =>
        items.length
          ? items.map((i) => `<tr><td>${dayFr(i.date)}</td><td>${esc(i.label)}</td><td>${esc(i.ref)}</td><td class="r">${signed(i.amount)}</td></tr>`).join('')
          : `<tr><td colspan="4" class="muted">${empty}</td></tr>`;
      const bookOnly = st.bookOnly.map((b) => ({ date: b.date, label: b.label, ref: b.ref, amount: b.amount }));
      const bankOnly = [...st.bankOnly, ...st.lost].map((l) => ({ date: l.op_date, label: l.label, ref: l.reference ?? '', amount: l.amount }));
      const gap = statementBalance === null ? null : statementBalance - st.expectedBankBalance;
      await printA4(`${a4Head(store)}
        <h1>État de rapprochement : ${esc(st.account.id)} ${esc(st.account.label)}</h1><div>Au ${dayFr(st.date)} · montants en FCFA</div>
        <table class="totals"><tbody><tr class="total"><td>Solde du compte en comptabilité</td><td class="r">${signed(st.bookBalance)}</td></tr></tbody></table>
        <h3>Écritures pas encore passées sur le relevé (à retrancher)</h3>
        <table><thead><tr><th>Date</th><th>Libellé</th><th>Pièce</th><th class="r">Montant</th></tr></thead><tbody>${rows(bookOnly, 'Aucune')}</tbody></table>
        <h3>Opérations du relevé pas encore comptabilisées (à ajouter)</h3>
        <table><thead><tr><th>Date</th><th>Libellé</th><th>Référence</th><th class="r">Montant</th></tr></thead><tbody>${rows(bankOnly, 'Aucune')}</tbody></table>
        <table class="totals"><tbody>
        <tr class="total"><td>Solde attendu sur le relevé</td><td class="r">${signed(st.expectedBankBalance)}</td></tr>
        ${statementBalance === null ? '' : `<tr><td>Solde affiché par le relevé</td><td class="r">${signed(statementBalance)}</td></tr><tr class="total"><td>${gap ? 'Écart à expliquer' : 'Rapprochement juste'}</td><td class="r">${signed(gap ?? 0)}</td></tr>`}
        </tbody></table>
        <p class="muted">${st.matched.length} opérations pointées.</p>
        <table><tbody><tr><td>Établi par</td><td class="r">Visa du gérant</td></tr></tbody></table>`);
    },

    async journal(storeId, from, to, journal) {
      const store = s.admin.getStore(storeId);
      const entries = s.accounting.entries(storeId, { from: from ?? undefined, to: to ?? undefined, journal: journal ?? undefined });
      let debit = 0;
      const rows = entries
        .map((e) => {
          const lines = e.lines
            .map((l) => {
              debit += l.debit;
              return `<tr><td></td><td></td><td>${esc(l.account)}${l.aux ? ` ${esc(l.aux)}` : ''}</td><td>${esc(l.label)}</td><td class="r">${l.debit ? money(l.debit) : ''}</td><td class="r">${l.credit ? money(l.credit) : ''}</td></tr>`;
            })
            .join('');
          return `<tr class="total"><td>${dayFr(e.date)}</td><td>${e.journal}</td><td>${esc(e.ref)}</td><td colspan="3">${esc(e.label)}</td></tr>${lines}`;
        })
        .join('');
      await printA4(`${a4Head(store)}
        <h1>${journal ? `Journal ${esc(JOURNALS[journal])}` : 'Journal général'}</h1><div>${periodFr(from, to)}</div>
        <table><thead><tr><th>Date</th><th>Jnl</th><th>Pièce / compte</th><th>Libellé</th><th class="r">Débit</th><th class="r">Crédit</th></tr></thead>
        <tbody>${rows}<tr class="total"><td colspan="4">Totaux (FCFA)</td><td class="r">${money(debit)}</td><td class="r">${money(debit)}</td></tr></tbody></table>`);
    },

    async list() {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return [];
      const printers = await win.webContents.getPrintersAsync();
      return printers.map((p) => ({ name: p.name, isDefault: Boolean((p as { isDefault?: boolean }).isDefault) }));
    },
  };
}
