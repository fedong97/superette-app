import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_THEMES, AUDIT_WATCH_ACTIONS, auditActionsMatching, auditTheme, describeAudit } from '../src/auditText';

/** Journal d'audit en clair : chaque action enregistrée devient une phrase en français. */
/** Les montants s'écrivent avec une espace fine insécable : on la lit comme une espace. */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v).replace(/\u202f/g, ' ')) as T;
const describe0 = describeAudit;
const describeAuditPlain = (...a: Parameters<typeof describeAudit>) => plain(describe0(...a));
const row = (action: string, details: unknown, entity_name: string | null = null, user_name: string | null = 'ANGE') => ({
  action,
  details: details === null ? null : JSON.stringify(details),
  user_name,
  entity_name,
});

describe('phrases du journal', () => {
  it("clôture avec manque : en rouge, avec l'écart et l'absence de motif", () => {
    const v = describeAuditPlain(row('cash.close', { zNumber: 5, kind: 'electronic', expected: 1350, counted: 0, difference: -1350, gapReason: null, deposited: {} }, 'Caisse électronique'));
    expect(v.text).toBe('ANGE a fermé la caisse « Caisse électronique » (clôture n° 5).');
    expect(v.note).toBe('Manque de 1 350 FCFA (attendu 1 350 FCFA, compté 0 FCFA) · aucun motif saisi');
    expect(v.level).toBe('alert');
    expect(v.theme).toBe('cash');
    expect(v.fields).toContainEqual(['Écart', '-1 350 FCFA']);
  });

  it('clôture juste : normale', () => {
    const v = describeAuditPlain(row('cash.close', { zNumber: 26, expected: 0, counted: 0, difference: 0, floatLeft: 0, deposit: 0, gapReason: null, gapApprovedBy: null }, 'Caisse 1'));
    expect(v.text).toBe('ANGE a fermé la caisse « Caisse 1 » (clôture n° 26).');
    expect(v.note).toBe('Tout est juste');
    expect(v.level).toBe('normal');
  });

  it('ouverture sans nom de caisse : le type de caisse est dit', () => {
    expect(describeAuditPlain(row('cash.open', { kind: 'electronic' })).text).toBe('ANGE a ouvert la caisse électronique.');
    expect(describeAuditPlain(row('cash.open', { openingFloat: 5000, carried: 0 }, 'Caisse 1')).text).toBe('ANGE a ouvert la caisse « Caisse 1 » avec un fond de caisse de 5 000 FCFA.');
  });

  it('les codes techniques ne sont plus affichés', () => {
    expect(describeAuditPlain(row('cash.count', { expected: 0, counted: 0, difference: 0 }, 'Caisse 1')).text).toBe('ANGE a compté la caisse « Caisse 1 ».');
    const pay = describeAuditPlain(row('counter.pay', { number: 'DLA01-1-000068', invoices: [1] }, 'DLA01-1-000068'));
    expect(pay.text).toBe('ANGE a encaissé le ticket DLA01-1-000068.');
    expect(pay.note).toBe('1 facture du comptoir réglée');
  });

  it('une remise dit qui l’a autorisée, par son nom', () => {
    const v = describeAuditPlain(row('sale.discount', { amount: 4500, authorizedBy: 'u-steve', quoteId: null, reason: 'Client fidèle' }, 'DLA01-1-000068'), (id) => (id === 'u-steve' ? 'Steve' : null));
    expect(v.text).toBe('ANGE a accordé une remise de 4 500 FCFA sur le ticket DLA01-1-000068.');
    expect(v.note).toBe('Autorisée par Steve · Motif : Client fidèle');
    expect(v.level).toBe('watch');
    expect(v.fields).toContainEqual(['Autorisé par', 'Steve']);
  });

  it('un code faux se lit sans nom devant', () => {
    const v = describeAuditPlain(row('auth.failed', { login: 'awa' }, null, null));
    expect(v.text).toBe("Code faux tapé pour l'identifiant « awa ».");
    expect(v.level).toBe('alert');
    expect(v.theme).toBe('logins');
  });

  it('une action inconnue ne casse rien', () => {
    const v = describeAuditPlain(row('futur.truc', { amount: 10 }));
    expect(v.label).toBe('Autre action');
    expect(v.fields).toContainEqual(['Montant', '10 FCFA']);
  });

  it('des détails abîmés ou absents ne cassent rien', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(() => describeAudit({ action, details: null, user_name: null, entity_name: null })).not.toThrow();
      expect(() => describeAudit({ action, details: '{pas du json', user_name: 'A', entity_name: 'B' })).not.toThrow();
      expect(describeAudit({ action, details: '{}', user_name: 'A', entity_name: null }).text).not.toMatch(/undefined|null|NaN|\[object/);
    }
  });
});

describe('thèmes et recherche', () => {
  it('chaque action a un thème et « À surveiller » couvre les annulations', () => {
    expect(auditTheme('sale.cancel')).toBe('sales');
    expect(auditTheme('customer_payment.cancel')).toBe('partners');
    expect(auditTheme('store_transfer.ship')).toBe('stock');
    expect(auditTheme('store.settings')).toBe('settings');
    expect(AUDIT_WATCH_ACTIONS).toEqual(expect.arrayContaining(['sale.cancel', 'cash.close', 'sale.discount', 'price.store', 'auth.failed']));
    expect(AUDIT_WATCH_ACTIONS).not.toContain('auth.login');
  });

  it('« prix » trouve les changements de prix', () => {
    expect(auditActionsMatching('prix')).toEqual(expect.arrayContaining(['price.store', 'price.bulk_update', 'sale.price_set']));
    expect(auditActionsMatching('re')).toEqual([]);
  });
});

describe('toutes les actions enregistrées par le logiciel ont leur phrase', () => {
  it('aucun code oublié', () => {
    const root = join(__dirname, '../../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    for (const d of ['packages/db/src', 'apps/desktop/src/main', 'apps/server/src']) {
      try {
        walk(join(root, d));
      } catch {
        /* dossier absent */
      }
    }
    const used = new Set<string>();
    const built = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:\.audit|\.log)\(\s*[^,()]+(?:\([^)]*\))?\s*,\s*((?:[^,]*?\?\s*)?['"][a-z_.]+['"](?:\s*:\s*['"][a-z_.]+['"])?)/g)) {
        for (const a of m[1]!.matchAll(/['"]([a-z_]+(?:\.[a-z_]+)*)['"]/g)) if (a[1]!.includes('.') || a[1] === 'license_activate') used.add(a[1]!);
      }
      // Actions composées : `central.${kind}` → au moins une phrase « central.… ».
      for (const m of src.matchAll(/\.audit\(\s*[^,()]+(?:\([^)]*\))?\s*,\s*`([^`]+)`/g)) built.add(m[1]!.replace(/\$\{[^}]*\}/g, '*'));
    }
    expect(used.size).toBeGreaterThan(200);
    expect(built.size).toBeGreaterThan(15);
    const missing = [...used].filter((a) => !AUDIT_ACTIONS.includes(a));
    expect(missing).toEqual([]);
    const glob = (p: string) => new RegExp(`^${p.replace(/[.]/g, '\\.').replace(/\*/g, '[a-z_]+')}$`);
    expect([...built].filter((p) => !AUDIT_ACTIONS.some((a) => glob(p).test(a)))).toEqual([]);
    // Chaque action a son thème de filtre, sans tomber par défaut dans « Réglages ».
    const unthemed = AUDIT_ACTIONS.filter((a) => !Object.values(AUDIT_THEMES).some((t) => t.patterns.some((p) => (p.endsWith('*') ? a.startsWith(p.slice(0, -1)) : a === p))));
    expect(unthemed).toEqual([]);
  });
});
