import { BrowserWindow } from 'electron';
import { PAYMENT_METHODS, formatFcfa, formatQty, formatRate } from '@superette/core';
import type { Services } from '@superette/db';
import type { Printer } from './api';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (v: number) => formatFcfa(v, false);
const dateFr = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Douala', dateStyle: 'short', timeStyle: 'short' });

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
        <div>${sale.kind === 'return' ? '<b>RETOUR CLIENT</b><br>' : ''}Ticket ${esc(sale.number)}<br>${dateFr(sale.created_at)} · ${esc(sale.user_name)}</div><hr>
        <table>${lines}</table><hr>
        <table><tr><td class="big">TOTAL FCFA</td><td class="r big">${money(sale.total_ttc)}</td></tr>${payments}
        ${sale.change_given ? `<tr><td>Rendu monnaie</td><td class="r">${money(sale.change_given)}</td></tr>` : ''}</table><hr>
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
        <div class="b">TVA</div><table>${z.vat.map((v) => row(`${formatRate(v.rate)} HT ${money(v.ht)}`, v.tva)).join('')}</table><hr>
        <div class="b">Espèces</div><table>${row('Fond de caisse', z.cash.openingFloat)}${row('Ventes espèces', z.cash.cashSales)}
        ${row('Remboursements', -z.cash.cashRefunds)}${row('Apports', z.cash.cashIn)}${row('Prélèvements', -z.cash.cashOut)}
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

    async list() {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return [];
      const printers = await win.webContents.getPrintersAsync();
      return printers.map((p) => ({ name: p.name, isDefault: Boolean((p as { isDefault?: boolean }).isDefault) }));
    },
  };
}
