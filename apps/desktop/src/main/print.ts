import { BrowserWindow, dialog, nativeImage } from 'electron';
import { writeFile } from 'node:fs/promises';
import {
  PAYMENT_METHODS,
  PAYROLL_LABELS,
  type Codepage,
  type Receipt,
  describeInPacks,
  drawerKick,
  formatFcfa,
  formatQty,
  formatRate,
  BARCODE_LABEL_FORMATS,
  type BarcodeLabelFormatId,
  LABEL_FORMATS,
  type LabelFormatId,
  numberToWordsFr,
  type DocData,
  type DocTemplate,
  pageSize,
  renderDocTicket,
  receiptToEscPos,
  receiptToHtml,
  renderDocHtml,
  splitTtc,
} from '@superette/core';
import { CUSTOMER_PAYMENT_METHODS, EXPENSE_PAYMENT_METHODS, SUPPLIER_PAYMENT_METHODS, INVENTORY_SHEET_MODELS, JOURNALS, type InventorySheetModel } from '@superette/db';
import type { Services } from '@superette/db';
import type { Printer } from './api';
import { sendNetwork, sendWindowsRaw } from './rawPrint';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (v: number) => formatFcfa(v, false);
const dateFr = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Douala', dateStyle: 'short', timeStyle: 'short' });
/** Libellé sans « HT » ni « TTC » pour un magasin sans TVA (« Total HT » devient « Total »). */
const tx = (label: string, store: { vat_enabled: number }) => (store.vat_enabled === 1 ? label : label.replace(/\s*\b(?:HT|TTC)\b/g, ''));
/** Remise et gratuits d'une ligne d'achat (« 12 achetés, 10 payés » rappelé sous les gratuits). */
const termCells = (l: { discount_bp: number; free_qty: number; promo_buy: number | null; promo_pay: number | null; unit: 'piece' | 'kg' | 'litre' }) =>
  `<td class="r">${l.discount_bp ? `${(l.discount_bp / 100).toLocaleString('fr-FR')} %` : ''}</td><td class="r">${
    l.free_qty ? `${formatQty(l.free_qty, l.unit)}${l.promo_buy && l.promo_pay !== null ? `<br><small>${l.promo_buy} achetés, ${l.promo_pay} payés</small>` : ''}` : ''
  }</td>`;
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
 * Fenêtre cachée qui sert à imprimer. À sa fermeture, la fenêtre du logiciel
 * reprend le clavier : sinon, sous Windows, après une impression les champs
 * (recherche de la caisse, des clients…) ne prennent plus la saisie.
 */
function renderWindow(back = BrowserWindow.getFocusedWindow(), measure = false): BrowserWindow {
  // Le JavaScript ne sert qu'à mesurer la hauteur d'un document sur papier continu (nos pages n'ont pas de script).
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: measure, sandbox: true } });
  win.once('closed', () => giveFocusBack(back));
  return win;
}

function giveFocusBack(back: BrowserWindow | null): void {
  if (!back || back.isDestroyed()) return;
  back.focus();
  back.webContents.focus();
}

/** « Enregistrer sous » rattachée à la fenêtre du logiciel, qui retrouve ainsi le clavier à la fermeture. */
function saveDialog(back: BrowserWindow | null, defaultPath: string) {
  const options = { defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
  return back ? dialog.showSaveDialog(back, options) : dialog.showSaveDialog(options);
}

/**
 * Ticket de caisse et rapport Z : par le pilote Windows (rendu HTML 80 mm) ou
 * en ESC/POS direct (USB via le spouleur Windows, ou réseau port 9100), avec
 * ouverture du tiroir-caisse. Les autres documents sont imprimés en A4.
 */
export function createPrinter(s: Services): Printer {
  async function printHtml(body: string, force = false): Promise<void> {
    if (!force && s.admin.getSetting('printer.enabled') === '0') return;
    const deviceName = s.admin.getSetting('printer.name') || undefined;
    const win = renderWindow();
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

  /** Page complète (ticket d'un modèle) envoyée sans fenêtre à l'imprimante du poste. */
  async function printPage(html: string): Promise<void> {
    const deviceName = s.admin.getSetting('printer.name') || undefined;
    const win = renderWindow();
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await new Promise<void>((resolve, reject) =>
        win.webContents.print({ silent: true, printBackground: true, deviceName, margins: { marginType: 'none' } }, (ok, reason) =>
          ok ? resolve() : reject(new Error(`Impression impossible : ${reason}`)),
        ),
      );
    } finally {
      win.destroy();
    }
  }

  /**
   * Document d'un modèle A4 ou listing : la fenêtre d'impression Windows s'ouvre au format
   * du modèle, ou la fenêtre « Enregistrer sous » pour un PDF. Renvoie false si annulé.
   */
  async function printDocument(html: string, t: DocTemplate, pdfName?: string): Promise<boolean> {
    const back = BrowserWindow.getFocusedWindow();
    const target = pdfName ? await saveDialog(back, pdfName) : null;
    if (target && (target.canceled || !target.filePath)) return (giveFocusBack(back), false);
    const { width, height } = pageSize(t);
    const win = renderWindow(back, !height);
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      // Papier continu (listing) : la page fait la hauteur du document.
      const pageHeight = height || Math.max(60, Math.ceil(((await win.webContents.executeJavaScript('document.querySelector(".sheet").getBoundingClientRect().height')) as number) * (25.4 / 96)) + 2);
      const size = { width: width * 1000, height: pageHeight * 1000 };
      if (target?.filePath) {
        await writeFile(target.filePath, await win.webContents.printToPDF(height ? { preferCSSPageSize: true, printBackground: true } : { pageSize: { width: width / 25.4, height: pageHeight / 25.4 }, margins: { top: 0, bottom: 0, left: 0, right: 0 }, printBackground: true }));
        return true;
      }
      // Facture listing : directement sur l'imprimante listing de ce PC quand elle est choisie (Paramètres).
      const listing = t.format === 'listing' ? s.admin.getSetting('printer.listing') || undefined : undefined;
      return await new Promise<boolean>((resolve, reject) =>
        win.webContents.print(
          {
            silent: Boolean(listing),
            deviceName: listing,
            printBackground: true,
            copies: t.page.copies,
            pageSize: size,
            ...(height ? {} : { margins: { marginType: 'none' as const } }),
          },
          (ok, reason) => (ok ? resolve(true) : reason === 'cancelled' ? resolve(false) : reject(new Error(`Impression impossible : ${reason}`))),
        ),
      );
    } finally {
      win.destroy();
    }
  }

  /** Document selon son modèle : ticket sur l'imprimante de caisse, A4 ou listing par la fenêtre d'impression ou en PDF. */
  async function printWithTemplate(t: DocTemplate, data: DocData, output: 'print' | 'pdf' | undefined, pdfName: string): Promise<boolean> {
    const html = renderDocHtml(t, data);
    if (t.format === 'ticket' && output !== 'pdf') {
      const receipt = renderDocTicket(t, data);
      for (let i = 0; i < t.page.copies; i++) await printReceipt(receipt, false, true, html);
      return true;
    }
    return printDocument(html, t, output === 'pdf' ? pdfName : undefined);
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
  /** Logo en noir et blanc pour l'impression ESC/POS : 384 points de large en 58 mm, 512 en 80 mm. */
  function withRaster(receipt: Receipt, columns: number): Receipt {
    return receipt.map((l) => {
      if (l.t !== 'image' || l.raster) return l;
      const img = nativeImage.createFromDataURL(l.src);
      if (img.isEmpty()) return l;
      const max = columns <= 32 ? 384 : 512;
      const size = img.getSize();
      const scaled = size.width > max ? img.resize({ width: max }) : img;
      const { width, height } = scaled.getSize();
      const px = scaled.toBitmap(); // BGRA
      const bytes = Math.ceil(width / 8);
      const data = new Uint8Array(bytes * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const alpha = px[i + 3]!;
          const lum = 0.114 * px[i]! + 0.587 * px[i + 1]! + 0.299 * px[i + 2]!;
          if (alpha >= 128 && lum < 128) data[y * bytes + (x >> 3)]! |= 0x80 >> (x & 7);
        }
      }
      return { ...l, raster: { width, height, data } };
    });
  }

  /** Le tiroir s'ouvre-t-il pour cette vente (réglage du poste : jamais, espèces, toujours) ? */
  function saleKick(saleId: string): boolean {
    const cfg = config();
    if (cfg.drawer === 'never') return false;
    const sale = s.pos.getSale(saleId);
    return cfg.drawer === 'always' || sale.change_given > 0 || sale.payments.some((p) => p.method === 'CASH');
  }

  /** `html` : page complète du modèle de ticket, imprimée telle quelle par le pilote Windows. */
  /** Renvoie false si rien n'est sorti (impression automatique coupée sur le poste). */
  async function printReceipt(receipt: Receipt, kick: boolean, force = false, html?: string): Promise<boolean> {
    const cfg = config();
    const print = cfg.enabled || force;
    if (cfg.mode === 'driver') {
      const errors: unknown[] = [];
      if (kick) await sendRaw(cfg, drawerKick()).catch((err) => errors.push(err));
      if (print) await (html ? printPage(html) : printHtml(receiptToHtml(receipt), true)).catch((err) => errors.push(err));
      if (errors.length) throw errors[0];
      return print;
    }
    if (print) await sendRaw(cfg, receiptToEscPos(withRaster(receipt, cfg.columns), { columns: cfg.columns, codepage: cfg.codepage, cut: cfg.cut, kick }));
    else if (kick) await sendRaw(cfg, drawerKick());
    return print;
  }

  /** Document A4 (bon de commande) : la fenêtre d'impression Windows s'ouvre pour choisir l'imprimante ou « Enregistrer en PDF ». */
  async function printA4(body: string): Promise<void> {
    const win = renderWindow();
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

  /** Document A4 enregistré en PDF : la fenêtre « Enregistrer sous » s'ouvre. Renvoie false si annulé. */
  async function saveA4Pdf(body: string, fileName: string): Promise<boolean> {
    const back = BrowserWindow.getFocusedWindow();
    const target = await saveDialog(back, fileName);
    if (target.canceled || !target.filePath) return (giveFocusBack(back), false);
    const win = renderWindow(back);
    try {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${A4_STYLE}</style></head><body>${body}</body></html>`;
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await writeFile(target.filePath, await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
      return true;
    } finally {
      win.destroy();
    }
  }

  /**
   * Étiquettes produit. Rouleau avec l'imprimante d'étiquettes du poste choisie
   * dans les Paramètres : impression directe, sans fenêtre. Sinon (planche A4,
   * ou pas d'imprimante choisie) : la fenêtre d'impression de Windows.
   */
  async function printBarcodeLabelsHtml(html: string, format: BarcodeLabelFormatId): Promise<boolean> {
    const f = BARCODE_LABEL_FORMATS[format];
    const device = format.startsWith('roll_') ? s.admin.getSetting('printer.labels') || undefined : undefined;
    const win = renderWindow();
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      return await new Promise<boolean>((resolve, reject) =>
        win.webContents.print(
          {
            silent: Boolean(device),
            ...(device ? { deviceName: device } : {}),
            printBackground: true,
            pageSize: { width: f.pageW * 1000, height: f.pageH * 1000 },
            margins: { marginType: 'none' },
          },
          (ok, reason) => (ok ? resolve(true) : reason === 'cancelled' ? resolve(false) : reject(new Error(`Impression impossible : ${reason}`))),
        ),
      );
    } finally {
      win.destroy();
    }
  }

  /** Planche d'étiquettes : la fenêtre d'impression s'ouvre au format de la planche ou du rouleau. Renvoie false si annulé. */
  async function printLabelsHtml(html: string, format: LabelFormatId): Promise<boolean> {
    const f = LABEL_FORMATS[format];
    const win = renderWindow();
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

  /** En-tête des documents A4 : logo, nom, adresse, NIU et RCCM du magasin. */
  function a4Head(store: { id: string; name: string; address: string | null; phone: string | null; taxpayer_number: string | null }): string {
    const set = s.admin.storeSettings(store.id);
    const ids = [store.taxpayer_number ? `NIU : ${esc(store.taxpayer_number)}` : '', set.rccm ? `RCCM : ${esc(set.rccm)}` : ''].filter(Boolean);
    return `<div class="head"><div style="display:flex;gap:12px;align-items:center">${set.logo ? `<img src="${esc(set.logo)}" style="max-height:22mm;max-width:45mm">` : ''}<div><h1>${esc(store.name)}</h1>${[
      store.address,
      store.phone,
    ]
      .filter(Boolean)
      .map((v) => esc(v!))
      .join('<br>')}</div></div>
      ${ids.length ? `<div class="box">${ids.join('<br>')}</div>` : ''}</div>`;
  }
  const periodFr = (from?: string | null, to?: string | null) =>
    `${from ? `Du ${dayFr(from)} ` : 'Depuis le début '}${to ? `au ${dayFr(to)}` : `au ${new Date().toLocaleDateString('fr-FR')}`}`;

  return {
    labels: printLabelsHtml,
    barcodeLabels: printBarcodeLabelsHtml,
    a4: printA4,

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

    async inventorySheet(inventoryId, opts) {
      const model: InventorySheetModel = opts?.model ?? 'blind';
      const output = opts?.output ?? 'a4';
      if (output === 'ticket') return void (await printReceipt(s.receipts.inventorySheet(inventoryId, model), false, true));
      const { inventory: inv, lines } = s.inventories.get(inventoryId);
      const store = s.admin.getStore(inv.store_id);
      const q = (v: number | null, unit: Parameters<typeof formatQty>[1]) => (v === null ? '' : formatQty(v, unit));
      const cols: Record<InventorySheetModel, string[]> = {
        blind: ['Compté'],
        withStock: ['Attendu', 'Compté'],
        control: ['Attendu', 'Compté', 'Écart'],
        counted: ['Compté'],
      };
      let dept: string | null | undefined;
      const rows = lines
        .map((l) => {
          const levels = l.unit === 'piece' ? [...l.packs.map((p) => p.name), l.unit_name || 'Pièce'] : [l.unit === 'kg' ? 'kg' : 'litres'];
          const blanks = `<td class="count">${levels.map((v) => `<span>……… ${esc(v)}</span>`).join('')}</td>`;
          const cells: Record<InventorySheetModel, string> = {
            blind: blanks,
            withStock: `<td class="r">${q(l.expected, l.unit)}</td>${blanks}`,
            control: `<td class="r">${q(l.expected, l.unit)}</td><td class="r">${q(l.counted, l.unit) || '—'}</td><td class="r">${q(l.difference, l.unit)}</td>`,
            counted: `<td class="r">${q(l.counted, l.unit) || '—'}</td>`,
          };
          const head = l.department_name !== dept ? `<tr><th colspan="${2 + cols[model].length}">${esc((dept = l.department_name) ?? 'Sans rayon')}</th></tr>` : '';
          return `${head}<tr><td>${esc(l.code)}</td><td>${esc(l.name)}</td>${cells[model]}</tr>`;
        })
        .join('');
      const body = `${a4Head(store)}
        <h1>Inventaire n° ${inv.number} : feuille de comptage</h1>
        <p>Dépôt : <b>${esc(inv.warehouse_name)}</b> · date d'inventaire ${new Date(`${inv.inventory_date}T12:00:00`).toLocaleDateString('fr-FR')} · ${lines.length} produits · ${esc(INVENTORY_SHEET_MODELS[model].toLowerCase())}</p>
        ${model === 'blind' || model === 'withStock' ? `<p class="muted">Comptez chaque produit en cartons, paquets et unités ; notez l'heure de fin de chaque rayon.</p>` : ''}
        <style>.count span { display: inline-block; min-width: 30mm; } th[colspan] { background: #e8eef7; text-align: left; }</style>
        <table><tr><th style="width:22mm">Code</th><th>Produit</th>${cols[model].map((c) => `<th${c === 'Compté' && (model === 'blind' || model === 'withStock') ? ' style="width:95mm"' : ' class="r"'}>${c}</th>`).join('')}</tr>${rows}</table>
        <div class="sign"><span>Compté par : ……………………</span><span>Heure de fin : ……………</span><span>Signature : ……………………</span></div>`;
      if (output === 'pdf') return void (await saveA4Pdf(body, `inventaire-${inv.number}-fiche.pdf`));
      await printA4(body);
    },

    async transferNote(transferId) {
      const { transfer: tr, lines } = s.transfers.get(transferId);
      const store = s.admin.getStore(tr.store_id);
      const received = tr.status === 'received';
      const title = received ? 'Bon de réception' : tr.status === 'draft' ? 'Bon de transfert (brouillon)' : 'Bon de route';
      const packText = (l: (typeof lines)[number]) => {
        const p = l.packs.find((x) => x.position === l.pack_position);
        return p && l.qty % p.units === 0 ? `${l.qty / p.units} ${esc(p.name)}` : '';
      };
      const rows = lines
        .map(
          (l) => `<tr><td>${esc(l.code)}</td><td>${esc(l.name)}</td><td class="r">${formatQty(l.qty, l.unit)}</td><td>${packText(l)}</td>
            ${received ? `<td class="r">${formatQty(l.received_qty ?? 0, l.unit)}</td><td class="r">${formatQty((l.received_qty ?? 0) - l.qty, l.unit)}</td>` : '<td></td>'}
            <td class="r">${money(l.unit_cost)}</td><td class="r">${money(l.value)}</td></tr>`,
        )
        .join('');
      const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR') : '');
      await printA4(`${a4Head(store)}
        <h1>${title} · transfert n° ${tr.number}</h1>
        <p>De <b>${esc(tr.from_name)}</b> vers <b>${esc(tr.to_name)}</b>${tr.label ? ` · ${esc(tr.label)}` : ''}</p>
        <p>Créé le ${when(tr.created_at)} par ${esc(tr.created_by_name)}${tr.shipped_at ? ` · expédié le ${when(tr.shipped_at)} par ${esc(tr.shipped_by_name ?? '')}` : ''}${
          tr.received_at ? ` · réceptionné le ${when(tr.received_at)} par ${esc(tr.received_by_name ?? '')}` : ''
        }${tr.route_number ? ` · bon de route ${esc(tr.route_number)}` : ''}${tr.reception_number ? ` · bon de réception ${esc(tr.reception_number)}` : ''}</p>
        <table><thead><tr><th>Code</th><th>Produit</th><th class="r">Expédié</th><th>Conditionnement</th>${received ? '<th class="r">Reçu</th><th class="r">Écart</th>' : '<th style="width:30mm">Reçu</th>'}<th class="r">CMUP</th><th class="r">Valeur</th></tr></thead>
        <tbody>${rows}<tr class="total"><td colspan="${received ? 7 : 6}">Valeur transférée</td><td class="r">${money(tr.value)}</td></tr>
        ${received && tr.gap_value ? `<tr class="total"><td colspan="7">Écart à la réception</td><td class="r">${money(tr.gap_value)}</td></tr>` : ''}</tbody></table>
        <div class="sign"><span>Expédié par : ……………………</span><span>Transporté par : ……………………</span><span>Reçu par : ……………………</span></div>`);
    },

    async reorderSheet(storeId, lines) {
      const store = s.admin.getStore(storeId);
      const art = s.db.prepare('SELECT code, name, unit, unit_name FROM articles WHERE id = ?');
      const packs = s.db.prepare('SELECT name, units FROM article_packs WHERE article_id = ? ORDER BY units DESC');
      const ref = s.db.prepare('SELECT supplier_ref FROM supplier_articles WHERE article_id = ? AND supplier_id = ?').pluck();
      const supName = s.db.prepare('SELECT name FROM suppliers WHERE id = ?').pluck();
      const groups = new Map<string, typeof lines>();
      for (const l of lines) groups.set(l.supplierId ?? '', [...(groups.get(l.supplierId ?? '') ?? []), l]);
      let grand = 0;
      const sections = [...groups]
        .map(([supplierId, ls]) => {
          let sub = 0;
          const rows = ls
            .map((l) => {
              const a = art.get(l.articleId) as { code: string; name: string; unit: Parameters<typeof formatQty>[1]; unit_name: string | null };
              const amount = Math.round((l.qty * l.unitCost) / 1000);
              sub += amount;
              const inPacks = describeInPacks(l.qty, packs.all(l.articleId) as { name: string; units: number }[], a.unit_name || 'Pièce');
              return `<tr><td>${esc(a.code)}</td><td>${esc((supplierId && (ref.get(l.articleId, supplierId) as string | null)) || '')}</td><td>${esc(a.name)}</td>
                <td class="r">${formatQty(l.qty, a.unit)}</td><td>${esc(inPacks)}</td><td class="r">${money(l.unitCost)}</td><td class="r">${money(amount)}</td></tr>`;
            })
            .join('');
          grand += sub;
          return `<h3>${esc(supplierId ? ((supName.get(supplierId) as string | undefined) ?? '') : 'Sans fournisseur')}</h3>
            <table><thead><tr><th>Code</th><th>Réf. fournisseur</th><th>Article</th><th class="r">Quantité</th><th>En conditionnements</th><th class="r">${tx('PU HT', store)}</th><th class="r">${tx('Montant HT', store)}</th></tr></thead>
            <tbody>${rows}<tr class="total"><td colspan="6">Total fournisseur</td><td class="r">${money(sub)}</td></tr></tbody></table>`;
        })
        .join('');
      await printA4(`${a4Head(store)}
        <h1>Proposition de commande</h1>
        <p>Établie le ${new Date().toLocaleString('fr-FR')} · ${lines.length} article(s) · total ${money(grand)} ${tx('FCFA HT', store)}</p>
        ${sections}`);
    },

    async productionNote(orderId) {
      const o = s.production.getOrder(orderId);
      const store = s.admin.getStore(s.db.prepare('SELECT store_id FROM production_orders WHERE id = ?').pluck().get(orderId) as string);
      const done = o.status === 'done';
      const rows = o.components
        .map(
          (c) => `<tr><td>${esc(c.code)}</td><td>${esc(c.name)}</td><td class="r">${formatQty(c.qty, c.unit as Parameters<typeof formatQty>[1])}</td>
            <td class="r">${money(c.unit_cost)}</td><td class="r">${money(Math.round((c.qty * c.unit_cost) / 1000))}</td></tr>`,
        )
        .join('');
      const total = o.total_cost ?? o.components.reduce((t, c) => t + Math.round((c.qty * c.unit_cost) / 1000), 0);
      await printA4(`${a4Head(store)}
        <h1>Ordre de fabrication ${esc(o.number)}${done ? '' : o.status === 'draft' ? ' (brouillon)' : ' (annulé)'}</h1>
        <p>Produit : <b>${esc(o.article_name)}</b> · quantité : <b>${formatQty(o.qty, o.unit as Parameters<typeof formatQty>[1])}</b> · dépôt : ${esc(o.warehouse_name)}${o.label ? ` · ${esc(o.label)}` : ''}${
          o.expiry ? ` · à consommer avant le ${new Date(`${o.expiry}T12:00:00`).toLocaleDateString('fr-FR')}` : ''
        }</p>
        <p>Créé le ${new Date(o.created_at).toLocaleString('fr-FR')} par ${esc(o.created_by_name)}${done ? ` · fabriqué le ${new Date(o.done_at!).toLocaleString('fr-FR')} par ${esc(o.done_by_name ?? '')}` : ''}</p>
        <h3>Composants ${done ? 'sortis du stock' : 'à sortir'}</h3>
        <table><thead><tr><th>Code</th><th>Composant</th><th class="r">Quantité</th><th class="r">CMUP</th><th class="r">Valeur</th></tr></thead>
        <tbody>${rows}<tr class="total"><td colspan="4">Coût de revient total</td><td class="r">${money(total)}</td></tr>
        <tr class="total"><td colspan="4">Coût de revient unitaire</td><td class="r">${money(o.unit_cost ?? Math.round((total * 1000) / o.qty))}</td></tr></tbody></table>
        <div class="sign"><span>Préparé par : ……………………</span><span>Contrôlé par : ……………………</span></div>`);
    },

    async inventoryResult(inventoryId) {
      const { inventory: inv, lines } = s.inventories.get(inventoryId);
      const store = s.admin.getStore(inv.store_id);
      const counted = lines.filter((l) => l.counted !== null);
      const rows = counted
        .map(
          (l) => `<tr><td>${esc(l.code)}</td><td>${esc(l.name)}</td><td class="r">${formatQty(l.expected, l.unit)}</td><td class="r">${formatQty(l.counted!, l.unit)}</td>
            <td class="r">${formatQty(l.difference ?? 0, l.unit)}</td><td class="r">${money(l.unit_cost)}</td><td class="r">${money(l.gap_value ?? 0)}</td><td class="r">${money(l.counted_value ?? 0)}</td></tr>`,
        )
        .join('');
      const gap = inv.gap_value;
      const status = inv.status === 'closed' ? `clôturé le ${new Date(inv.closed_at!).toLocaleString('fr-FR')} par ${esc(inv.closed_by_name ?? '')}` : inv.status === 'open' ? 'en cours (résultat provisoire)' : 'annulé';
      await printA4(`${a4Head(store)}
        <h1>Résultat de l'inventaire n° ${inv.number}</h1>
        <p>${inv.kind === 'global' ? 'Inventaire global' : `Inventaire partiel${inv.departments.length ? ` : ${esc(inv.departments.join(', '))}` : ''}`} · dépôt <b>${esc(inv.warehouse_name)}</b> ·
          date d'inventaire ${new Date(`${inv.inventory_date}T12:00:00`).toLocaleDateString('fr-FR')} · ${status}</p>
        <p>${counted.length} produits comptés sur ${lines.length}. Valeur du stock compté : <b>${money(inv.counted_value)} FCFA</b>.
          L'inventaire est <b>${gap < 0 ? `déficitaire de ${money(-gap)} FCFA` : gap > 0 ? `excédentaire de ${money(gap)} FCFA` : 'sans écart'}</b>.</p>
        <table><thead><tr><th>Code</th><th>Produit</th><th class="r">Attendu</th><th class="r">Compté</th><th class="r">Écart</th><th class="r">CMUP</th><th class="r">Montant écart</th><th class="r">Valeur comptée</th></tr></thead>
        <tbody>${rows}<tr class="total"><td colspan="6">Totaux</td><td class="r">${money(gap)}</td><td class="r">${money(inv.counted_value)}</td></tr></tbody></table>
        <div class="sign"><span>Le magasinier : ……………………</span><span>Le gérant : ……………………</span></div>`);
    },

    async ticket(saleId, opts) {
      const kick = Boolean(opts?.newSale) && saleKick(saleId);
      const t = s.receipts.saleTemplate(saleId, 'ticket', opts?.templateId);
      const ticket = t.format === 'ticket' ? t : s.receipts.saleTemplate(saleId, 'ticket');
      const duplicate = Boolean(opts?.duplicate);
      const data = s.receipts.saleDoc(saleId, { duplicate });
      const receipt = s.receipts.ticket(saleId, { templateId: ticket.id, duplicate });
      const html = renderDocHtml(ticket, data);
      // Exemplaires : ceux des paramètres ou du modèle pour une vente, un seul en réimpression ; le tiroir ne s'ouvre qu'au premier.
      const copies = opts?.newSale ? Math.max(opts.copies ?? 1, ticket.page.copies) : Math.max(1, opts?.copies ?? 1);
      let printed = false;
      for (let i = 0; i < copies; i++) printed = (await printReceipt(receipt, kick && i === 0, Boolean(opts?.force), html)) || printed;
      return printed;
    },

    async saleDrawer(saleId) {
      if (saleKick(saleId)) await sendRaw(config(), drawerKick());
    },

    async zReport(sessionId) {
      await printReceipt(s.receipts.zReport(sessionId), false);
    },

    async centralVoucher(movementId) {
      await printReceipt(s.receipts.centralVoucher(movementId), false, true);
    },

    async emoneyVoucher(movementId) {
      await printReceipt(s.receipts.emoneyVoucher(movementId), false, true);
    },

    async sessionReport(sessionId, blind = false) {
      const z = s.pos.zReport(sessionId);
      const se = z.session;
      const store = s.admin.getStore(se.store_id);
      if (z.declared) {
        // Caisse électronique ou banque : solde relevé par moyen, puis entrées et sorties avec leur référence.
        const payments = s.pos.sessionPayments(sessionId);
        const electronic = z.registerKind === 'electronic';
        type L = NonNullable<typeof z.declared>[number];
        const cols: { th: string; v: (l: L) => number | null; hide?: boolean }[] = [
          { th: 'Solde de départ', v: (l) => l.opening, hide: blind || !electronic },
          { th: 'Encaissé', v: (l) => l.received, hide: blind },
          { th: 'Sorties', v: (l) => -l.outflows, hide: !electronic },
          { th: 'Attendu', v: (l) => l.expected, hide: blind || !electronic },
          { th: 'Solde relevé', v: (l) => l.declared },
          { th: 'Écart', v: (l) => (l.declared === null ? null : l.declared - l.expected), hide: blind },
          { th: 'Versé à la centrale', v: (l) => l.deposited, hide: !electronic || !z.declared.some((l) => l.deposited) },
          { th: 'Reste', v: (l) => l.left, hide: !electronic || !z.declared.some((l) => l.deposited) },
        ];
        const shown = cols.filter((c) => !c.hide);
        const cell = (v: number | null) => `<td class="r">${v === null ? '' : money(v)}</td>`;
        const lines = z.declared.map((l) => `<tr><td>${esc(l.label)}</td>${shown.map((c) => cell(c.v(l))).join('')}</tr>`).join('');
        const totals = shown.map((c) => cell(c.th === 'Écart' ? z.difference : z.declared!.some((l) => c.v(l) === null) ? null : z.declared!.reduce((t, l) => t + (c.v(l) ?? 0), 0))).join('');
        const journalRows = (rows: { at: string; nature: string; label: string; party: string | null; method_label: string; reference: string | null; user_name: string | null; amount: number }[]) =>
          rows
            .map((r) => `<tr><td>${dateFr(r.at).slice(-5)}</td><td>${esc(r.nature)}</td><td>${esc(r.label)}</td><td>${esc(r.party ?? '')}</td><td>${esc(r.method_label)}</td><td>${esc(r.reference ?? '')}</td><td>${esc(r.user_name ?? '')}</td><td class="r">${money(r.amount)}</td></tr>`)
            .join('');
        const head = '<thead><tr><th>Heure</th><th>Nature</th><th>Pièce</th><th>Tiers</th><th>Moyen</th><th>Référence</th><th>Par</th><th class="r">Montant</th></tr></thead>';
        const j = z.emoneyJournal;
        await printA4(`${a4Head(store)}
          <h1>Bon de clôture ${esc(z.registerName)}${se.z_number ? ` · Z n° ${se.z_number}` : ' (journée en cours)'}</h1>
          <p>Ouverture le ${dateFr(se.opened_at)} par ${esc(se.user_name)}${se.closed_at ? ` · clôture le ${dateFr(se.closed_at)}${se.closed_by_name ? ` par ${esc(se.closed_by_name)}` : ''}` : ''}</p>
          <table><thead><tr><th>Moyen</th>${shown.map((c) => `<th class="r">${c.th}</th>`).join('')}</tr></thead>
          <tbody>${lines}<tr class="total"><td>Total</td>${totals}</tr></tbody></table>
          ${z.emoneyDeposit ? `<p>Versement <b>${esc(z.emoneyDeposit.number)}</b> vers ${esc(z.emoneyDeposit.centralName)}.</p>` : ''}
          ${se.gap_reason ? `<p>Motif de l'écart : <b>${esc(se.gap_reason)}</b>${se.gap_approved_by_name ? `, justifié par ${esc(se.gap_approved_by_name)}` : ''}</p>` : !blind && s.pos.gapPending(se) ? '<p><b>Écart à justifier par le gérant.</b></p>' : ''}
          ${
            j
              ? `<h3>Entrées (${j.entries.length})</h3><table>${head}<tbody>${journalRows(j.entries)}</tbody></table>
                 <h3>Sorties (${j.exits.length})</h3><table>${head}<tbody>${journalRows(j.exits)}</tbody></table>`
              : `<h3>Paiements reçus (${payments.length})</h3>
          <table><thead><tr><th>Heure</th><th>Pièce</th><th>Moyen</th><th>Référence</th><th>Caissier</th><th class="r">Montant</th></tr></thead>
          <tbody>${payments
            .map((p) => `<tr><td>${dateFr(p.at).slice(-5)}</td><td>${esc(p.number)}</td><td>${esc(p.label)}</td><td>${esc(p.reference ?? '')}</td><td>${esc(p.user_name ?? '')}</td><td class="r">${money(p.amount)}</td></tr>`)
            .join('')}</tbody></table>`
          }
          <div class="sign"><span>Le caissier : ……………………</span><span>Le gérant : ……………………</span></div>`);
        return;
      }
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
          ${z.cash.otherIn ? row('Autres entrées (Encaisser)', z.cash.otherIn) : ''}${z.cash.otherOut ? row('Autres sorties (Décaisser)', -z.cash.otherOut) : ''}
          ${row('Attendu à la clôture', z.cash.expected, true)}${row('Relevé à la clôture', z.counted)}${se.first_counted !== null && se.first_counted !== z.counted ? row('Premier comptage', se.first_counted) : ''}
          ${row('Différentiel', z.difference, true)}${se.deposit !== null ? row('Versé à la caisse centrale', se.deposit) + row('Fond laissé dans le tiroir', se.float_left) : ''}
        </table><table class="totals" style="width:50%;margin:0">
          ${row('Tickets', null)}<tr><td colspan="2">${z.ticketCount} ventes, ${z.cancelled.count} annulés</td></tr>
          ${row(tx('Chiffre d’affaires net TTC', store), z.netTtc, true)}${row('Remises', z.discounts)}${row('Promotions', z.promotions)}${row('Ventes à crédit', journal.creditSales)}
          ${z.byMethod.map((m) => row(esc(m.label), m.amount)).join('')}
          ${z.elsewhere.map((m) => row(`${esc(m.label)} (sur ${esc(m.registerName)})`, m.amount)).join('')}
        </table></div>
        ${se.gap_reason ? `<p>Motif de l'écart : <b>${esc(se.gap_reason)}</b>${se.gap_approved_by_name ? `, justifié par ${esc(se.gap_approved_by_name)}` : ''}</p>` : s.pos.gapPending(se) ? '<p><b>Écart à justifier par le gérant.</b></p>' : ''}
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

    async stockByStore(storeId, opts) {
      const store = s.admin.getStore(storeId);
      const d = s.controls.stockByStore(storeId, opts);
      const cell = (v: number | undefined, unit: 'piece' | 'kg' | 'litre') => (v === undefined ? '—' : formatQty(v, unit));
      const rows = d.rows
        .map(
          (r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td>${d.stores
            .map((st) => `<td class="r">${cell(r.byStore[st.id], r.unit)}</td>`)
            .join('')}<td class="r"><b>${formatQty(r.total, r.unit)}</b></td></tr>`,
        )
        .join('');
      await printA4(`${a4Head(store)}
        <h1>Stock multi-magasin</h1>
        <p>Imprimé le ${new Date().toLocaleString('fr-FR')} · ${d.rows.length} article(s)${opts.shortage ? ' · en rupture dans au moins un magasin' : ''}${opts.search ? ` · recherche « ${esc(opts.search)} »` : ''}</p>
        <p>${d.stores.map((st) => `${esc(st.name)} : ${st.own ? 'stock de ce poste' : st.updated_at ? `à jour au ${dateFr(st.updated_at)}` : 'jamais reçu'}`).join(' · ')}</p>
        <table><thead><tr><th>Code</th><th>Article</th>${d.stores.map((st) => `<th class="r">${esc(st.name)}</th>`).join('')}<th class="r">Total</th></tr></thead>
        <tbody>${rows}</tbody></table>`);
    },

    async purchaseInvoice(invoiceId, opts) {
      const i = s.purchases.getInvoice(invoiceId);
      const t = s.receipts.purchaseTemplate('purchaseInvoice', i.store_id, opts?.format ?? 'a4', opts?.templateId);
      return printWithTemplate(t, s.receipts.purchaseInvoiceDoc(invoiceId), opts?.output, `facture-achat-${i.number}.pdf`);
    },

    previewPurchaseInvoice(invoiceId, opts) {
      const i = s.purchases.getInvoice(invoiceId);
      const t = s.receipts.purchaseTemplate('purchaseInvoice', i.store_id, opts?.format ?? 'a4', opts?.templateId);
      return { templateId: t.id, html: renderDocHtml(t, s.receipts.purchaseInvoiceDoc(invoiceId)) };
    },

    async purchaseOrder(orderId, opts) {
      const o = s.purchases.getOrder(orderId);
      const t = s.receipts.purchaseTemplate('purchaseOrder', o.store_id, opts?.format ?? 'a4', opts?.templateId);
      return printWithTemplate(t, s.receipts.purchaseOrderDoc(orderId), opts?.output, `bon-de-commande-${o.number}.pdf`);
    },

    previewPurchaseOrder(orderId, opts) {
      const o = s.purchases.getOrder(orderId);
      const t = s.receipts.purchaseTemplate('purchaseOrder', o.store_id, opts?.format ?? 'a4', opts?.templateId);
      return { templateId: t.id, html: renderDocHtml(t, s.receipts.purchaseOrderDoc(orderId)) };
    },

    async invoice(saleId, opts) {
      const t = s.receipts.saleTemplate(saleId, opts?.format ?? 'a4', opts?.templateId, opts?.doc);
      const sale = s.pos.getSale(saleId);
      const name = t.doc === 'delivery' ? 'bon-de-livraison' : sale.kind === 'return' ? 'avoir' : 'facture';
      return printWithTemplate(t, s.receipts.saleDoc(saleId, { duplicate: opts?.duplicate }), opts?.output, `${name}-${sale.number}.pdf`);
    },

    previewInvoice(saleId, opts) {
      const t = s.receipts.saleTemplate(saleId, opts?.format ?? 'a4', opts?.templateId, opts?.doc);
      return { templateId: t.id, html: renderDocHtml(t, s.receipts.saleDoc(saleId, { duplicate: opts?.duplicate })) };
    },

    async quote(quoteId, opts) {
      const t = s.receipts.quoteTemplate(quoteId, opts?.format ?? 'a4', opts?.templateId);
      return printWithTemplate(t, s.receipts.quoteDoc(quoteId), opts?.output, `${t.variant === 'proforma' ? 'proforma' : 'devis'}-${s.quotes.get(quoteId).number}.pdf`);
    },

    previewQuote(quoteId, opts) {
      const t = s.receipts.quoteTemplate(quoteId, opts?.format ?? 'a4', opts?.templateId);
      return { templateId: t.id, html: renderDocHtml(t, s.receipts.quoteDoc(quoteId)) };
    },

    async statement(storeId, customerId, from, to, output) {
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
      const body = `<div class="head">
          <div><h1>${esc(store.name)}</h1>${[store.address, store.phone].filter(Boolean).map((v) => esc(v!)).join('<br>')}</div>
          <div class="box"><b>${esc(c.name)}</b><br>${[c.address, c.phone, `Compte ${c.code}`].filter(Boolean).map((v) => esc(v!)).join('<br>')}</div>
        </div>
        <h1>Relevé de compte</h1>
        <div>${from ? `Du ${dayFr(from)} ` : ''}${to ? `au ${dayFr(to)}` : `au ${new Date().toLocaleDateString('fr-FR')}`}</div>
        <table><thead><tr><th>Date</th><th>Pièce</th><th>Libellé</th><th class="r">Débit</th><th class="r">Crédit</th><th class="r">Solde</th></tr></thead>
        <tbody>${from ? `<tr><td colspan="5">Solde au ${dayFr(from)}</td><td class="r">${money(st.opening)}</td></tr>` : ''}${rows}
        <tr class="total"><td colspan="5">Solde dû (FCFA)</td><td class="r">${money(st.closing)}</td></tr></tbody></table>
        ${open ? `<h3>Factures restant dues</h3><table><thead><tr><th>Pièce</th><th>Date</th><th>Échéance</th><th class="r">Reste dû</th><th></th></tr></thead><tbody>${open}</tbody></table>` : ''}
        <p class="muted">Plafond de crédit : ${money(c.credit_limit)} FCFA · Délai de paiement : ${c.payment_terms_days} jours</p>`;
      if (output === 'pdf') {
        const name = `releve-${c.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || c.code}.pdf`;
        return saveA4Pdf(body, name);
      }
      await printA4(body);
      return true;
    },

    async customerReceipt(paymentId) {
      await printReceipt(s.receipts.customerReceipt(paymentId), false);
    },

    async expenseVoucher(expenseId) {
      await printReceipt(s.receipts.expenseVoucher(expenseId), false);
    },

    async rebateVoucher(entryId) {
      await printReceipt(s.receipts.rebateVoucher(entryId), false);
    },

    async deskTicket(sessionId, source, id, opts) {
      await printReceipt(s.receipts.deskTicket({ ...s.cashdesk.row(sessionId, source, id), duplicate: opts?.duplicate, authorizedBy: opts?.authorizedBy }), false);
    },

    async officeVoucher(entryId) {
      const e = s.cashdesk.get(entryId);
      await printReceipt(s.receipts.deskTicket({ ...s.cashdesk.entryRow(entryId), authorizedBy: e.authorized_by_name }), false);
    },

    async deskA4(sessionId, source, id, opts) {
      const { row: x, direction, register } = s.cashdesk.row(sessionId, source, id);
      const store = s.admin.getStore(s.pos.getSession(sessionId).store_id);
      await printA4(`${a4Head(store)}
        <h1>${direction === 'IN' ? 'Reçu de caisse' : 'Bon de sortie de caisse'}${opts?.duplicate ? ' · DUPLICATA' : ''}</h1>
        <table class="totals" style="width:100%">
          <tr><td>Pièce</td><td>${esc(x.number ?? '')}</td></tr>
          <tr><td>Date</td><td>${dateFr(x.at)}</td></tr>
          <tr><td>Caisse</td><td>${esc(register)}${x.user_name ? ` · ${esc(x.user_name)}` : ''}</td></tr>
          <tr><td>Nature</td><td>${esc(x.nature)}</td></tr>
          <tr><td>Motif</td><td>${esc(x.label)}</td></tr>
          <tr><td>${direction === 'IN' ? 'Reçu de' : 'Bénéficiaire'}</td><td>${esc(x.party ?? '')}</td></tr>
          <tr><td>Mode</td><td>${esc(x.method_label ?? PAYMENT_METHODS.CASH)}${x.reference ? ` · Réf. ${esc(x.reference)}` : ''}</td></tr>
          <tr class="total"><td>Montant</td><td>${money(x.amount)} FCFA</td></tr>
        </table>
        <p>Arrêté à la somme de <b>${esc(numberToWordsFr(x.amount))} francs CFA</b>.</p>
        <div style="display:flex;justify-content:space-between;margin-top:18mm"><div>${direction === 'IN' ? 'Le client' : 'Le bénéficiaire'}</div><div>Le caissier</div></div>`);
    },

    async discharge(sessionId, source, id) {
      const { row: x, register } = s.cashdesk.row(sessionId, source, id);
      const store = s.admin.getStore(s.pos.getSession(sessionId).store_id);
      const day = new Date(x.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
      // Collaborateur : sa CNI est sur sa fiche ; le motif sans le n° de pièce déjà en tête.
      const staffId = source === 'entry' ? s.cashdesk.get(id).staff_id : null;
      const idCard = staffId ? s.staff.get(staffId).id_card : null;
      const motif = x.number && x.label.startsWith(x.number) ? x.label.slice(x.number.length).trim() : x.label;
      await printA4(`${a4Head(store)}
        <h1 style="text-align:center;margin-top:10mm">DÉCHARGE</h1>
        <p style="text-align:center" class="muted">Pièce ${esc(x.number ?? '')} · ${esc(register)}</p>
        <p style="font-size:12pt;line-height:2;margin-top:10mm">
          Je soussigné(e), <b>${x.party ? esc(x.party) : '..............................................................'}</b>,
          CNI n° ${idCard ? `<b>${esc(idCard)}</b>` : '...............................'}, reconnais avoir reçu de <b>${esc(store.name)}</b>
          la somme de <b>${money(x.amount)} FCFA</b> (${esc(numberToWordsFr(x.amount))} francs CFA),
          ${x.method_label && x.method_label !== PAYMENT_METHODS.CASH ? `par ${esc(x.method_label)}${x.reference ? ` (réf. ${esc(x.reference)})` : ''}, ` : 'en espèces, '}
          au titre de : <b>${esc(x.nature)}${motif ? `, ${esc(motif)}` : ''}</b>.
        </p>
        <p style="font-size:12pt">Fait à ....................................., le ${esc(day)}.</p>
        <div style="display:flex;justify-content:space-between;margin-top:14mm;font-size:11pt">
          <div style="text-align:center">Le bénéficiaire<br><span class="muted">(lu et approuvé)</span></div>
          <div style="text-align:center">Le caissier<br><span class="muted">${esc(x.user_name ?? '')}</span></div>
          <div style="text-align:center">Le responsable</div>
        </div>`);
    },

    async salarySlip(salaryId) {
      const { salary: x, staff: st, payments, payroll: p, periodLabel } = s.staff.slip(salaryId);
      const legal = p
        ? (['cnps', 'irpp', 'cac', 'cfc', 'rav', 'tdl'] as const)
            .filter((k) => p[k])
            .map((k) => `<tr><td>${esc(PAYROLL_LABELS[k])}</td><td class="r">-${money(p[k])}</td></tr>`)
            .join('') + `<tr class="total"><td>Net après retenues légales</td><td class="r">${money(p.net)}</td></tr>`
        : '';
      const employer = p
        ? `<h3>Charges patronales (pour information)</h3><table class="totals" style="width:100%">${(['employerCnps', 'employerCfc', 'employerFne'] as const)
            .filter((k) => p[k])
            .map((k) => `<tr><td>${esc(PAYROLL_LABELS[k])}</td><td class="r">${money(p[k])}</td></tr>`)
            .join('')}<tr class="total"><td>Coût total pour l'employeur</td><td class="r">${money(x.gross + p.employerSocial + p.employerTax)}</td></tr></table>`
        : '';
      const store = s.admin.getStore(x.store_id);
      const pays = payments
        .map((p) => `<tr><td>${dateFr(p.at)}</td><td>${esc(p.number)}</td><td>${esc(PAYMENT_METHODS[p.method as 'CASH'] ?? p.method)}${p.reference ? ` · ${esc(p.reference)}` : ''}${p.register_name ? ` · ${esc(p.register_name)}` : ''}</td><td class="r">${money(p.amount)}</td></tr>`)
        .join('');
      await printA4(`${a4Head(store)}
        <h1>Bulletin de paie, ${esc(periodLabel)}</h1>
        <div class="box" style="margin-bottom:6mm"><b>${esc(st.name)}</b>${st.position ? ` · ${esc(st.position)}` : ''}<br>
          Matricule ${esc(st.code)}${st.cnps_number ? ` · CNPS ${esc(st.cnps_number)}` : ''}${st.id_card ? ` · CNI ${esc(st.id_card)}` : ''}${st.phone ? ` · ${esc(st.phone)}` : ''}${st.hired_on ? `<br>Entré(e) le ${dayFr(st.hired_on)}` : ''}</div>
        <table class="totals" style="width:100%">
          <tr><td>Salaire brut du mois</td><td class="r">${money(x.gross)}</td></tr>
          ${legal}
          <tr><td>Avances et acomptes retenus</td><td class="r">${x.deducted ? `-${money(x.deducted)}` : '0'}</td></tr>
          <tr class="total"><td>Net à payer</td><td class="r">${money(x.net)}</td></tr>
          <tr><td>Déjà payé</td><td class="r">${money(x.paid)}</td></tr>
          <tr class="total"><td>Reste à payer</td><td class="r">${money(x.rest)}</td></tr>
        </table>
        ${pays ? `<h3>Paiements</h3><table><thead><tr><th>Date</th><th>Pièce</th><th>Mode</th><th class="r">Montant</th></tr></thead><tbody>${pays}</tbody></table>` : ''}
        ${employer}
        <p class="muted">Avances restant à rembourser : ${money(Math.max(0, st.advances))} FCFA.${p ? '' : ' Sans retenues légales (paie non activée ou collaborateur non déclaré).'}</p>
        <div style="display:flex;justify-content:space-between;margin-top:16mm"><div>Le collaborateur</div><div>L'employeur</div></div>`);
    },

    async payrollDeclarations(storeId, period) {
      const d = s.staff.declarations(storeId, period);
      const store = s.admin.getStore(storeId);
      const rows = d.rows
        .map(
          (r) =>
            `<tr><td>${esc(r.staff_name)}</td><td class="r">${money(r.gross)}</td><td class="r">${money(r.detail.employeeCnps)}</td><td class="r">${money(r.detail.employerSocial)}</td><td class="r">${money(r.detail.irpp + r.detail.cac)}</td><td class="r">${money(r.detail.cfc + r.detail.employerCfc)}</td><td class="r">${money(r.detail.employerFne)}</td><td class="r">${money(r.detail.rav)}</td><td class="r">${money(r.detail.tdl)}</td></tr>`,
        )
        .join('');
      await printA4(`${a4Head(store)}
        <h1>Charges sociales et fiscales sur salaires, ${esc(d.label)}</h1>
        <table><thead><tr><th>Collaborateur</th><th class="r">Brut</th><th class="r">CNPS sal.</th><th class="r">CNPS pat.</th><th class="r">IRPP + CAC</th><th class="r">CFC</th><th class="r">FNE</th><th class="r">RAV</th><th class="r">TDL</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <table class="totals" style="width:100%;margin-top:6mm">
          <tr><td>Masse salariale brute</td><td class="r">${money(d.gross)}</td></tr>
          <tr class="total"><td>À verser à la CNPS (compte 4311)</td><td class="r">${money(d.cnps)}</td></tr>
          <tr class="total"><td>À verser aux impôts (compte 4471) : IRPP ${money(d.irpp)}, CAC ${money(d.cac)}, CFC ${money(d.cfc)}, FNE ${money(d.fne)}, RAV ${money(d.rav)}, TDL ${money(d.tdl)}</td><td class="r">${money(d.state)}</td></tr>
        </table>`);
    },

    async staffStatement(staffId, from, to) {
      const st = s.staff.statement(staffId, { from: from ?? undefined, to: to ?? undefined });
      const store = s.admin.getStore(st.staff.store_id);
      const rows = st.lines
        .map(
          (l) =>
            `<tr><td>${dateFr(l.at)}</td><td>${esc(l.number)}</td><td>${esc(l.label)}</td><td class="r">${l.due ? money(l.due) : ''}</td><td class="r">${money(l.dueBalance)}</td><td class="r">${l.advance ? money(l.advance) : ''}</td><td class="r">${money(l.advanceBalance)}</td></tr>`,
        )
        .join('');
      await printA4(`${a4Head(store)}
        <h1>Extrait de compte, ${esc(st.staff.name)}</h1>
        <p>${periodFr(from, to)} · comptes ${esc(st.staff.salary_account)} (rémunérations dues) et ${esc(st.staff.advance_account)} (avances)</p>
        <table><thead><tr><th>Date</th><th>Pièce</th><th>Libellé</th><th class="r">Salaire</th><th class="r">Dû au collaborateur</th><th class="r">Avance</th><th class="r">Avances à rembourser</th></tr></thead>
        <tbody>${from ? `<tr><td colspan="4">Soldes au ${dayFr(from)}</td><td class="r">${money(st.opening.due)}</td><td></td><td class="r">${money(st.opening.advances)}</td></tr>` : ''}${rows}
        <tr class="total"><td colspan="4">Soldes</td><td class="r">${money(st.staff.due)}</td><td></td><td class="r">${money(st.staff.advances)}</td></tr></tbody></table>`);
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

    async assets(storeId, at, id) {
      const store = s.admin.getStore(storeId);
      const list = s.assets.list(storeId, { at, includeDisposed: true }).filter((a) => !id || a.id === id);
      const cell = (v: number) => `<td class="r">${v ? money(v) : '-'}</td>`;
      const register = list
        .map(
          (a) =>
            `<tr><td>${esc(a.code)}</td><td>${esc(a.label)}${a.disposed_on ? ` <em>(sorti le ${dayFr(a.disposed_on)})</em>` : ''}</td><td>${esc(a.account)}</td><td>${dayFr(a.in_service_on)}</td>` +
            `<td class="r">${a.duration_months ? `${a.duration_months / 12 === Math.round(a.duration_months / 12) ? `${a.duration_months / 12} ans` : `${a.duration_months} mois`}` : '-'}</td>${cell(a.cost)}${cell(a.year_charge)}${cell(a.cumulated)}${cell(a.net)}</tr>`,
        )
        .join('');
      const sum = (k: 'cost' | 'year_charge' | 'cumulated' | 'net') => list.reduce((t, a) => t + a[k], 0);
      const plans = list
        .map((a) => {
          const rows = s.assets.schedule(a.id);
          if (!rows.length) return '';
          return `<h3>${esc(a.code)} · ${esc(a.label)}</h3>
            <div>Valeur d'origine ${money(a.cost)} FCFA · mise en service le ${dayFr(a.in_service_on)} · linéaire sur ${a.duration_months} mois · comptes ${esc(a.account)} / ${esc(a.depreciation_account)}</div>
            <table><thead><tr><th>Exercice</th><th class="r">Base</th><th class="r">Dotation</th><th class="r">Cumul</th><th class="r">Valeur nette</th></tr></thead><tbody>${rows
              .map((r) => `<tr><td>${dayFr(r.from)} au ${dayFr(r.to)}${r.prior ? ' <em>(avant la reprise)</em>' : ''}</td>${cell(r.opening)}${cell(r.charge)}${cell(r.cumulated)}${cell(r.net)}</tr>`)
              .join('')}</tbody></table>`;
        })
        .join('');
      await printA4(`${a4Head(store)}
        <h1>Registre des immobilisations</h1><div>Au ${dayFr(at)} · montants en FCFA · amortissement linéaire au prorata des jours</div>
        <table><thead><tr><th>Code</th><th>Bien</th><th>Compte</th><th>Mise en service</th><th class="r">Durée</th><th class="r">Valeur d'origine</th><th class="r">Dotation de l'exercice</th><th class="r">Amort. cumulés</th><th class="r">Valeur nette</th></tr></thead>
        <tbody>${register}<tr class="total"><td colspan="5">Totaux</td>${cell(sum('cost'))}${cell(sum('year_charge'))}${cell(sum('cumulated'))}${cell(sum('net'))}</tr></tbody></table>
        ${plans ? `<div style="page-break-before: always"></div><h2>Plans d'amortissement</h2>${plans}` : ''}`);
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
