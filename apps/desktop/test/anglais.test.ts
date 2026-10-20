import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { toEnglish } from '../src/renderer/i18n';

/** Écrans du caissier et du vendeur : entièrement traduits. */
const CASHIER_FILES = [
  'App.tsx',
  'ui.tsx',
  'mdi.tsx',
  'screens/Login.tsx',
  'screens/Pos.tsx',
  'screens/PosDialogs.tsx',
  'screens/Treasury.tsx',
  'screens/CashDesk.tsx',
  'screens/Customers.tsx',
  'screens/customerDialogs.tsx',
  'screens/SummaryInvoices.tsx',
  'screens/Sales.tsx',
  'screens/SaleSearch.tsx',
  'screens/Orders.tsx',
  'screens/Deliveries.tsx',
  'screens/docPreview.tsx',
  'screens/pickers.tsx',
];
/** Textes identiques en anglais, ou laissés en français exprès (le choix « Français »). */
const SAME = new Set(['Administration', 'Session', 'Correction', 'Action ▾', 'Français', 'Afficher les écrans en français']);
const FRENCH = /[éèêàçùôîûœÉÀ]|\b(le|la|les|des|du|un|une|et|pour|sur|avec|aucun|aucune|est|dans|par|de|au|aux|en|ou|ce|cette|ses|son|sa|d|l|qu)\b|^[A-Z][a-z]+(er|ez|é|ée|és|ées|ion|eur|ure|ment|ité|té)\b/i;
const CODE = /^[a-z][a-zA-Z0-9_.:-]*$|^[A-Z_0-9.]+$|[{}<>;=]|^\.|^#|^\w+\(|px\b|^--|^https?:|^[a-z-]+(\s[a-z-]+)+$/;
/** Appels dont les textes ne s'affichent pas (noms d'API, réglages, classes). */
const NOT_SHOWN = /^(call|invoke|useLoad|includes|has|can|canWin|open|startsWith|endsWith|querySelector|closest|getItem|setItem|savePref|split|replace|join)$/;

function displayedTexts(file: string): string[] {
  const path = join(__dirname, '../src/renderer', file);
  const src = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t && FRENCH.test(t) && !CODE.test(t)) out.push(t);
  };
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const p = n.parent;
      const key = ts.isPropertyAssignment(p) && p.name === n;
      const compared = ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind);
      const hidden = ts.isCallExpression(p) && NOT_SHOWN.test(p.expression.getText().split('.').pop()!);
      if (!key && !compared && !hidden && !ts.isElementAccessExpression(p)) add(n.text);
    } else if (ts.isJsxText(n)) add(n.text);
    else if (ts.isTemplateExpression(n)) [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].forEach(add);
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

describe('écrans en anglais', () => {
  it('traduit les textes connus, les chemins de menu et les textes composés, sans toucher aux données', () => {
    expect(toEnglish('Ouvrir la caisse')).toBe('Open the register');
    expect(toEnglish('  Client : ')).toBe('  Customer: ');
    expect(toEnglish('Ouvrir la caisse…')).toBe('Open the register…');
    expect(toEnglish('Facturation › Vente au comptant 1')).toBe('Billing › Cash sale 1');
    expect(toEnglish('Facture DLA1-1-000001 enregistrée')).toBe('Invoice DLA1-1-000001 saved');
    expect(toEnglish('3 écarts à justifier')).toBe('3 differences to justify');
    expect(toEnglish('Commande CC-1-00001 préparée')).toBe('Order CC-1-00001 prepared');
    expect(toEnglish('Montant Espèces')).toBe('Cash amount');
    expect(toEnglish('Articles (1)')).toBe('Items (1)');
    expect(toEnglish('2 articles')).toBe('2 items');
    // Noms de produits et de clients : gardés tels quels.
    expect(toEnglish('RIZ PARFUMÉ 1 KG')).toBe('RIZ PARFUMÉ 1 KG');
    expect(toEnglish('Awa Ndiaye')).toBe('Awa Ndiaye');
    expect(toEnglish('2 000')).toBe('2 000');
    // Une phrase à moitié connue reste entière plutôt qu'en deux langues.
    expect(toEnglish('Aucun devis encore préparé')).toBe('Aucun devis encore préparé');
  });

  it('chaque texte des écrans du caissier et du vendeur a sa traduction', () => {
    const missing = CASHIER_FILES.flatMap((f) => displayedTexts(f).filter((t) => !SAME.has(t) && toEnglish(t) === t).map((t) => `${f} : ${t}`));
    expect([...new Set(missing)]).toEqual([]);
  });
});
