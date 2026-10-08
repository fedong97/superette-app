import { BrowserWindow } from 'electron';
import {
  PAYMENT_METHODS,
  type Codepage,
  type Receipt,
  drawerKick,
  formatFcfa,
  formatQty,
  formatRate,
  LABEL_FORMATS,
  type LabelFormatId,
  numberToWordsFr,
  receiptToEscPos,
  splitTtc,
} from '@superette/core';
import { CUSTOMER_PAYMENT_METHODS, EXPENSE_PAYMENT_METHODS, JOURNALS } from '@superette/db';
import type { Services } from '@superette/db';
import type { Printer } from './api';
import { sendNetwork, sendWindowsRaw } from './rawPrint';

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
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .row span:last-child { white-space: nowrap; }
`;

/** Rendu HTML d'un ticket, pour l'impression par le pilote Windows. */
function receiptHtml(receipt: Receipt): string {
  return receipt
    .map((l) => {
      if (l.t === 'rule') return '<hr>';
      if (l.t === 'feed') return '<br>';
      const cls = [l.bold ? 'b' : '', l.big ? 'big' : ''];
      if (l.t === 'text') return `<div class="${[...cls, l.align === 'center' ? 'c' : l.align === 'right' ? 'r' : ''].join(' ').trim()}">${esc(l.text)}</div>`;
      const pad = l.indent ? ` style="padding-left:${l.indent}ch"` : '';
      return `<div class="row ${cls.join(' ').trim()}"><span${pad}>${esc(l.left)}</span><span>${esc(l.right)}</span></div>`;
    })
    .join('\n');
}

export type PrinterMode = 'driver' | 'windows' | 'network';
export type DrawerMode = 'never' | 'cash' | 'always';

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

/**
 * Ticket de caisse et rapport Z : par le pilote Windows (rendu HTML 80 mm) ou
 * en ESC/POS direct (USB via le spouleur Windows, ou réseau port 9100), avec
 * ouverture du tiroir-caisse. Les autres documents sont imprimés en A4.
 */
export function createPrinter(s: Services): Printer {
  async function printHtml(body: string, force = false): Promise<void> {
    if (!force && s.admin.getSetting('printer.enabled') === '0') return;
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

  /** Réglages d'impression du poste (non synchronisés : chaque caisse a son imprimante). */
  function config() {
    const get = (k: string) => s.admin.getSetting(k);
    return {
      mode: (get('printer.mode') || 'driver') as PrinterMode,
      name: get('printer.name') ?? '',
      host: get('printer.host') ?? '',
      port: Number(get('printer.port')) || 9100,
      columns: Number(get('printer.columns')) || 48,
      codepage: (get('printer.codepage') || 'pc850') as Codepage,
      cut: get('printer.cut') !== '0',
      drawer: (get('drawer.mode') || 'never') as DrawerMode,
      enabled: get('printer.enabled') !== '0',
    };
  }

  /** Octets ESC/POS bruts : par le réseau, sinon par le spouleur Windows (aussi en mode pilote, pour le tiroir). */
  function sendRaw(cfg: ReturnType<typeof config>, data: Uint8Array): Promise<void> {
    return cfg.mode === 'network' ? sendNetwork(cfg.host, cfg.port, data) : sendWindowsRaw(cfg.name, data);
  }

  /**
   * Imprime un ticket selon le mode du poste et ouvre le tiroir si demandé.
   * Le tiroir s'ouvre même quand l'impression automatique est coupée.
   */
  async function printReceipt(receipt: Receipt, kick: boolean, force = false): Promise<void> {
    const cfg = config();
    const print = cfg.enabled || force;
    if (cfg.mode === 'driver') {
      const errors: unknown[] = [];
      if (kick) await sendRaw(cfg, drawerKick()).catch((err) => errors.push(err));
      if (print) await printHtml(receiptHtml(receipt), true).catch((err) => errors.push(err));
      if (errors.length) throw errors[0];
      return;
    }
    if (print) await sendRaw(cfg, receiptToEscPos(receipt, { columns: cfg.columns, codepage: cfg.codepage, cut: cfg.cut, kick }));
    else if (kick) await sendRaw(cfg, drawerKick());
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

  /** Planche d'étiquettes : la fenêtre d'impression s'ouvre au format de la planche ou du rouleau. Renvoie false si annulé. */
  async function printLabelsHtml(html: string, format: LabelFormatId): Promise<boolean> {
    const f = LABEL_FORMATS[format];
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return await new Promise<boolean>((resolve, reject) =>
        win.webContents.print(
          { silent: false, printBackground: true, pageSize: { width: f.pageW * 1000, height: f.pageH * 1000 }, margins: { marginType: 'none' } },
          (ok, reason) => (ok ? resolve(true) : reason === 'cancelled' ? resolve(false) : reject(new Error(`Impression impossible : ${reason}`))),
        ),
      );
    } finally {
      win.destroy();
    }
  }

  function a4Head(store: { name: string; address: string | null; phone: string | null; taxpayer_number: string | null }): string {
    return `<div class="head"><div><h1>${esc(store.name)}</h1>${[store.address, store.phone].filter(Boolean).map((v) => esc(v!)).join('<br>')}</div>
      ${store.taxpayer_number ? `<div class="box">NIU : ${esc(store.taxpayer_number)}</div>` : ''}</div>`;
  }
  const periodFr = (from?: string | null, to?: string | null) =>
    `${from ? `Du ${dayFr(from)} ` : 'Depuis le début '}${to ? `au ${dayFr(to)}` : `au ${new Date().toLocaleDateString('fr-FR')}`}`;

  return {
    labels: printLabelsHtml,

    async countSheet(storeId, warehouseId, departmentId) {
      const store = s.admin.getStore(storeId);
      const wh = s.admin.listWarehouses(storeId).find((w) => w.id === warehouseId);
      const families = departmentId ? new Set(s.catalogue.listDepartments().find((d) => d.id === departmentId)?.families.map((f) => f.id) ?? []) : null;
      const articles = s.catalogue
        .searchArticles('', storeId, { limit: 100_000 })
        .filter((a) => !families || (a.family_id !== null && families.has(a.family_id)))
        .sort((a, b) => (a.department_name ?? '~').localeCompare(b.department_name ?? '~', 'fr') || a.name.localeCompare(b.name, 'fr'));
      let dept: string | null | undefined;
      const rows = articles
        .map((a) => {
          const levels = a.unit === 'piece' ? [...a.packs.map((p) => p.name), a.unit_name || 'Pièce'] : [a.unit === 'kg' ? 'kg' : 'litres'];
          const head = a.department_name !== dept ? `<tr><th colspan="3">${esc((dept = a.department_name) ?? 'Sans rayon')}</th></tr>` : '';
          return `${head}<tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td class="count">${levels.map((l) => `<span>……… ${esc(l)}</span>`).join('')}</td></tr>`;
        })
        .join('');
      await printA4(`${a4Head(store)}
        <h1>Feuille de comptage d'inventaire</h1>
        <p>Dépôt : <b>${esc(wh?.name ?? '')}</b> · imprimée le ${new Date().toLocaleDateString('fr-FR')} · ${articles.length} articles</p>
        <p class="muted">Comptez chaque article en cartons, paquets et unités ; notez l'heure de fin de chaque rayon.</p>
        <style>.count span { display: inline-block; min-width: 32mm; } th[colspan] { background: #e8eef7; text-align: left; }</style>
        <table><tr><th style="width:22mm">Code</th><th>Article</th><th style="width:105mm">Compté</th></tr>${rows}</table>
        <div class="sign"><span>Compté par : ……………………</span><span>Heure de fin : ……………</span><span>Signature : ……………………</span></div>`);
    },

    async ticket(saleId, opts) {
      const cfg = config();
      let kick = false;
      if (opts?.newSale && cfg.drawer !== 'never') {
        const sale = s.pos.getSale(saleId);
        kick = cfg.drawer === 'always' || sale.change_given > 0 || sale.payments.some((p) => p.method === 'CASH');
      }
      await printReceipt(s.receipts.ticket(saleId), kick);
    },

    async zReport(sessionId) {
      await printReceipt(s.receipts.zReport(sessionId), false);
    },

    async centralVoucher(movementId) {
      await printReceipt(s.receipts.centralVoucher(movementId), false, true);
    },

    async sessionReport(sessionId) {
      const z = s.pos.zReport(sessionId);
      const se = z.session;
      const store = s.admin.getStore(se.store_id);
      const journal = s.pos.cashJournal(sessionId);
      const sales = s.pos.listSales({ sessionId, limit: 5000 }).reverse();
      const cashRows = (rows: typeof journal.entries) =>
        rows.map((r) => `<tr><td>${dateFr(r.at).slice(-5)}</td><td>${esc(r.nature)}</td><td>${esc(r.label)}</td><td>${esc(r.party ?? '')}</td><td class="r">${money(r.amount)}</td></tr>`).join('');
      const sum = (rows: typeof journal.entries) => rows.filter((r) => !r.closing).reduce((t, r) => t + r.amount, 0);
      const saleRows = sales
        .map(
          (x) => `<tr${x.status === 'cancelled' ? ' class="muted"' : ''}><td>${esc(x.number)}</td><td>${dateFr(x.created_at).slice(-5)}</td><td>${esc(x.user_name)}</td>
            <td>${esc(x.customer_name ?? '')}</td><td>${x.kind === 'return' ? 'Retour' : x.status === 'cancelled' ? `Annulé : ${esc(x.cancel_reason ?? '')}` : 'Vente'}</td>
            <td class="r">${x.total_discount ? money(x.total_discount) : ''}</td><td class="r">${money(x.total_ttc)}</td></tr>`,
        )
        .join('');
      const row = (label: string, v: number | null, bold = false) => `<tr${bold ? ' class="total"' : ''}><td>${label}</td><td class="r">${v === null ? '' : money(v)}</td></tr>`;
      await printA4(`${a4Head(store)}
        <h1>Rapport de clôture ${esc(z.registerName)}${se.z_number ? ` · Z n° ${se.z_number}` : ' (journée en cours)'}</h1>
        <p>Ouverture le ${dateFr(se.opened_at)} par ${esc(se.user_name)}${se.closed_at ? ` · clôture le ${dateFr(se.closed_at)}${se.closed_by_name ? ` par ${esc(se.closed_by_name)}` : ''}` : ''}</p>
        <div style="display:flex;gap:16px"><table class="totals" style="width:50%;margin:0">
          ${row('Fond à l’ouverture', z.cash.openingFloat)}${se.carried_float !== null ? row('dont fond laissé la veille', se.carried_float) : ''}
          ${row('Ventes en espèces', z.cash.cashSales)}${row('Règlements clients en espèces', z.cash.customerReceipts)}${row('Apports', z.cash.cashIn)}
          ${row('Remboursements', -z.cash.cashRefunds)}${row('Prélèvements versés à la centrale', -z.cash.cashOut)}${row('Dépenses payées', -z.cash.expenses)}
          ${row('Attendu à la clôture', z.cash.expected, true)}${row('Relevé à la clôture', z.counted)}${se.first_counted !== null && se.first_counted !== z.counted ? row('Premier comptage', se.first_counted) : ''}
          ${row('Différentiel', z.difference, true)}${se.deposit !== null ? row('Versé à la caisse centrale', se.deposit) + row('Fond laissé dans le tiroir', se.float_left) : ''}
        </table><table class="totals" style="width:50%;margin:0">
          ${row('Tickets', null)}<tr><td colspan="2">${z.ticketCount} ventes, ${z.cancelled.count} annulés</td></tr>
          ${row('Chiffre d’affaires net TTC', z.netTtc, true)}${row('Remises', z.discounts)}${row('Promotions', z.promotions)}${row('Ventes à crédit', journal.creditSales)}
          ${z.byMethod.map((m) => row(esc(m.label), m.amount)).join('')}
        </table></div>
        ${se.gap_reason ? `<p>Motif de l'écart : <b>${esc(se.gap_reason)}</b></p>` : ''}
        <h3>Entrées d'espèces</h3>
        <table><thead><tr><th>Heure</th><th>Nature</th><th>Pièce / motif</th><th>Tiers</th><th class="r">Montant</th></tr></thead>
        <tbody>${cashRows(journal.entries)}<tr class="total"><td colspan="4">Total des entrées</td><td class="r">${money(sum(journal.entries))}</td></tr></tbody></table>
        <h3>Sorties d'espèces</h3>
        <table><thead><tr><th>Heure</th><th>Nature</th><th>Pièce / motif</th><th>Bénéficiaire</th><th class="r">Montant</th></tr></thead>
        <tbody>${cashRows(journal.exits)}<tr class="total"><td colspan="4">Total des sorties (hors versement de clôture)</td><td class="r">${money(sum(journal.exits))}</td></tr></tbody></table>
        <h3>Historique des ventes (${sales.length})</h3>
        <table><thead><tr><th>Ticket</th><th>Heure</th><th>Vendeur</th><th>Client</th><th>Type</th><th class="r">Remise</th><th class="r">Montant</th></tr></thead><tbody>${saleRows}</tbody></table>
        <div class="sign"><span>Le caissier : ……………………</span><span>Le gérant : ……………………</span></div>`);
    },

    async openDrawer() {
      await sendRaw(config(), drawerKick());
    },

    async testPage(withDrawer) {
      const cfg = config();
      await printReceipt(s.receipts.testPage(cfg.columns), withDrawer, true);
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
      // Magasin non assujetti : ni colonne ni total de TVA, la mention « TVA non applicable ».
      const noVat = store.vat_enabled !== 1 && sale.lines.every((l) => l.vat_rate_bp === 0);
      const rows = sale.lines
        .map((l) => {
          const ht = splitTtc(l.total_ttc, l.vat_rate_bp).ht;
          const pack = l.pack_name && l.pack_units && l.pack_price !== null;
          const q = pack ? `${Math.abs(l.qty) / l.pack_units!} ${esc(l.pack_name!)}` : formatQty(Math.abs(l.qty), l.unit);
          return `<tr><td>${esc(l.label)}</td><td class="r">${q}</td><td class="r">${money(pack ? l.pack_price! : l.unit_price)}</td>
            <td class="r">${l.discount ? money(l.discount) : ''}</td>${noVat ? '' : `<td class="r">${formatRate(l.vat_rate_bp)}</td><td class="r">${money(ht)}</td>`}<td class="r">${money(l.total_ttc)}</td></tr>`;
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
              : sale.customer_name
                ? `<b>${esc(sale.customer_name)}</b><br>Client comptoir`
                : '<b>Client comptoir</b>'
          }</div>
        </div>
        <h1>${title} ${esc(sale.number)}</h1>
        <div>Date : ${dayFr(sale.created_at)}${sale.due_date ? ` · Échéance : ${dayFr(sale.due_date)}` : ''} · Vendeur : ${esc(sale.user_name)}</div>
        <table><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">${noVat ? 'Prix unitaire' : 'PU TTC'}</th><th class="r">Remise</th>${noVat ? '' : '<th class="r">TVA</th><th class="r">Total HT</th>'}<th class="r">${noVat ? 'Total' : 'Total TTC'}</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <table class="totals">${noVat ? '' : `<tr><td>Total HT</td><td class="r">${money(sale.total_ht)}</td></tr>${vat}`}
          <tr class="total"><td>${noVat ? 'Total (FCFA)' : 'Total TTC (FCFA)'}</td><td class="r">${money(sale.total_ttc)}</td></tr>${pays}</table>
        ${noVat ? '<p class="muted">TVA non applicable.</p>' : ''}
        <div class="sign"><div>Le client</div><div>Pour ${esc(store.name)}</div></div>`);
    },

    async quote(quoteId) {
      const q = s.quotes.get(quoteId);
      const store = s.admin.getStore(q.store_id);
      const c = q.customer_id ? s.customers.getCustomer(q.customer_id) : null;
      const noVat = store.vat_enabled !== 1 && q.lines.every((l) => l.vat_rate_bp === 0);
      const rows = q.lines
        .map((l) => {
          const ht = splitTtc(l.total_ttc, l.vat_rate_bp).ht;
          return `<tr><td>${esc(l.label)}</td><td class="r">${formatQty(l.qty, l.unit)}</td><td class="r">${money(l.unit_price)}</td>
            <td class="r">${l.discount ? money(l.discount) : ''}</td>${noVat ? '' : `<td class="r">${formatRate(l.vat_rate_bp)}</td><td class="r">${money(ht)}</td>`}<td class="r">${money(l.total_ttc)}</td></tr>`;
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
        <table><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">${noVat ? 'Prix unitaire' : 'PU TTC'}</th><th class="r">Remise</th>${noVat ? '' : '<th class="r">TVA</th><th class="r">Total HT</th>'}<th class="r">${noVat ? 'Total' : 'Total TTC'}</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <table class="totals">${noVat ? '' : `<tr><td>Total HT</td><td class="r">${money(q.total_ht)}</td></tr>${vat}`}
          <tr class="total"><td>${noVat ? 'Net à payer (FCFA)' : 'Net à payer TTC (FCFA)'}</td><td class="r">${money(q.total_ttc)}</td></tr></table>
        <p>Arrêté${q.kind === 'proforma' ? 'e la présente facture proforma' : ' le présent devis'} à la somme de <b>${esc(words)} francs CFA</b>${noVat ? ' (TVA non applicable)' : ' toutes taxes comprises'}.</p>
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
      await printReceipt(s.receipts.customerReceipt(paymentId), false);
    },

    async expenseVoucher(expenseId) {
      await printReceipt(s.receipts.expenseVoucher(expenseId), false);
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
      const v = (n: number, unit?: 'fcfa' | 'number') => (n ? (unit === 'number' ? n.toLocaleString('fr-FR') : n < 0 ? `- ${money(-n)}` : money(n)) : '-');
      const body = notes
        .map((n) => {
          const title = `<h3>${n.id === 'RF' ? '' : `Note ${esc(n.id)} : `}${esc(n.title)}</h3>`;
          const comment = n.comment ? `<p class="muted">${esc(n.comment)}</p>` : '';
          if (!n.columns.length) {
            const text = n.paragraphs?.length
              ? n.paragraphs.map((p) => `${p.heading ? `<h4>${esc(p.heading)}</h4>` : ''}<p style="white-space: pre-line">${esc(p.text)}</p>`).join('')
              : '<p class="muted">Néant</p>';
            return `<div style="break-inside: avoid">${title}${text}${comment}</div>`;
          }
          const rows = n.rows.length
            ? n.rows.map((r) => `<tr${r.total ? ' class="total"' : ''}><td>${esc(r.label)}</td>${r.values.map((x, j) => `<td class="r">${v(x, n.units?.[j])}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${n.columns.length + 1}" class="muted">Néant</td></tr>`;
          return `<div style="break-inside: avoid">${title}
            <table><thead><tr><th>Libellé</th>${n.columns.map((c) => `<th class="r">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>${comment}</div>`;
        })
        .join('');
      await printA4(`${a4Head(store)}
        <h1>Notes annexes : exercice ${year}</h1><div>Montants en FCFA · SYSCOHADA révisé, système normal · notes calculées à partir des écritures, notes 1, 2, 13B, 27B et 35 déclarées par l'entreprise</div>
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
