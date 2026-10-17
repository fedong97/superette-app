import { EDITABLE_ROLES, type Permission, type StoreSettings } from '@superette/core';
import type { AdminService, Role } from './admin';
import type { CatalogueService } from './catalogue';
import type { Db } from './database';
import { AppError, Base, type Clock } from './util';

/**
 * Modèle de boutique, comme les fichiers modèles de Sage (G_MODEL, C_MODEL) :
 * une nouvelle boutique part d'un métier déjà paramétré (rayons et familles,
 * réglages, droits des rôles, et au besoin un catalogue d'articles).
 */
export interface ShopTemplate {
  v: 1;
  id: string;
  name: string;
  description: string;
  departments: { name: string; families: string[] }[];
  settings?: Partial<StoreSettings>;
  options?: { ignoreStock?: boolean };
  rights?: Partial<Record<Role, Permission[]>>;
  articles?: { name: string; barcode?: string; salePrice: number; purchasePrice?: number; vatRateBp?: number; unit?: 'piece' | 'kg' | 'litre'; department?: string; family?: string }[];
}

export const TEMPLATE_EXTENSION = 'fedonix-modele';

/** Réglages propres à une boutique précise : ils ne partent jamais dans un modèle. */
const OWN_SETTINGS: (keyof StoreSettings)[] = ['logo', 'rccm', 'ticketHeader', 'emoneyCentralRegisterId'];

const dep = (name: string, ...families: string[]) => ({ name, families });

export const BUILTIN_TEMPLATES: ShopTemplate[] = [
  {
    v: 1,
    id: 'superette',
    name: 'Superette / alimentation générale',
    description: 'Épicerie, boissons, produits frais, hygiène et entretien ; vente au détail et au carton.',
    departments: [
      dep('Épicerie', 'Riz et céréales', 'Huiles', 'Conserves', 'Pâtes', 'Sucre et farine', 'Condiments et épices', 'Petit-déjeuner'),
      dep('Boissons', 'Eaux', 'Jus et sodas', 'Bières', 'Vins et spiritueux'),
      dep('Produits frais', 'Laitiers', 'Charcuterie', 'Surgelés'),
      dep('Hygiène', 'Savons', 'Soins du corps', 'Bébé'),
      dep('Entretien', 'Lessive', 'Ménage'),
    ],
    settings: { expiryAlertDays: 30, defaultMarginPct: 15, labelAfterReception: true },
  },
  {
    v: 1,
    id: 'quincaillerie',
    name: 'Quincaillerie / matériaux',
    description: 'Outillage, plomberie, électricité, peinture ; ventes à crédit aux artisans.',
    departments: [
      dep('Outillage', 'Outils à main', 'Outils électriques', 'Visserie et clous'),
      dep('Plomberie', 'Tuyaux et raccords', 'Robinetterie', 'Sanitaires'),
      dep('Électricité', 'Câbles', 'Appareillage', 'Éclairage'),
      dep('Peinture', 'Peintures', 'Accessoires'),
      dep('Matériaux', 'Ciment', 'Fer', 'Tôles', 'Bois'),
    ],
    settings: { defaultMarginPct: 25, creditDefaultLimit: 200_000, creditDefaultDays: 30, creditBlockLate: true },
  },
  {
    v: 1,
    id: 'pharmacie',
    name: 'Pharmacie / parapharmacie',
    description: 'Lots et dates de péremption suivis de près, alerte trois mois avant.',
    departments: [
      dep('Médicaments', 'Antalgiques', 'Antipaludiques', 'Antibiotiques', 'Vitamines'),
      dep('Parapharmacie', 'Soins de la peau', 'Hygiène bucco-dentaire', 'Bébé et maman'),
      dep('Matériel médical', 'Pansements', 'Diagnostic'),
    ],
    settings: { expiryAlertDays: 90, defaultMarginPct: 30, cancelMinutes: 30 },
  },
  {
    v: 1,
    id: 'boulangerie',
    name: 'Boulangerie / pâtisserie',
    description: 'Production du jour, vente au poids, péremption courte.',
    departments: [dep('Boulangerie', 'Pains', 'Viennoiseries'), dep('Pâtisserie', 'Gâteaux', 'Entremets'), dep('Matières premières', 'Farines', 'Levures', 'Sucres et beurres'), dep('Boissons', 'Jus', 'Sodas')],
    settings: { expiryAlertDays: 2, defaultMarginPct: 40 },
  },
  {
    v: 1,
    id: 'habillement',
    name: 'Habillement / cosmétiques',
    description: 'Vêtements, chaussures, mèches et produits de beauté ; étiquettes avec le prix.',
    departments: [
      dep('Vêtements', 'Homme', 'Femme', 'Enfant'),
      dep('Chaussures', 'Homme', 'Femme', 'Enfant'),
      dep('Beauté', 'Mèches et perruques', 'Maquillage', 'Soins des cheveux'),
      dep('Accessoires', 'Sacs', 'Bijoux'),
    ],
    settings: { defaultMarginPct: 50, labelPrice: true, labelName: true },
  },
];

/** Vérifie un modèle lu dans un fichier (structure seulement : les valeurs sont revérifiées à l'application). */
export function parseTemplate(json: string): ShopTemplate {
  let t: ShopTemplate;
  try {
    t = JSON.parse(json) as ShopTemplate;
  } catch {
    throw new AppError("Ce fichier n'est pas un modèle de boutique", 'INVALID');
  }
  if (t?.v !== 1 || typeof t.name !== 'string' || !Array.isArray(t.departments)) throw new AppError("Ce fichier n'est pas un modèle de boutique", 'INVALID');
  return t;
}

export interface TemplateResult {
  departments: number;
  families: number;
  settings: number;
  rights: number;
  articles: { created: number; updated: number; errors: number };
}

export class TemplateService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly catalogue: CatalogueService,
  ) {
    super(db, clock);
  }

  /**
   * Applique un modèle à une boutique : ajoute les rayons et familles qui manquent,
   * règle la boutique et les droits, importe les articles (un code-barres connu met
   * l'article à jour). Rien n'est supprimé.
   */
  apply(userId: string, storeId: string, t: ShopTemplate): TemplateResult {
    const result: TemplateResult = { departments: 0, families: 0, settings: 0, rights: 0, articles: { created: 0, updated: 0, errors: 0 } };
    return this.tx(() => {
      const existing = this.catalogue.listDepartments();
      for (const d of t.departments) {
        if (!d?.name?.trim()) continue;
        let found = existing.find((x) => x.name.toLowerCase() === d.name.trim().toLowerCase());
        if (!found) {
          found = { ...this.catalogue.createDepartment(d.name), families: [] };
          existing.push(found);
          result.departments++;
        }
        for (const f of d.families ?? []) {
          if (!f?.trim() || found.families.some((x) => x.name.toLowerCase() === f.trim().toLowerCase())) continue;
          found.families.push(this.catalogue.createFamily(found.id, f));
          result.families++;
        }
      }
      if (t.settings) {
        const patch = Object.fromEntries(Object.entries(t.settings).filter(([k]) => !OWN_SETTINGS.includes(k as keyof StoreSettings))) as Partial<StoreSettings>;
        if (Object.keys(patch).length) {
          this.admin.saveStoreSettings(userId, storeId, patch);
          result.settings = Object.keys(patch).length;
        }
      }
      if (t.options?.ignoreStock !== undefined) this.admin.setStoreOptions(userId, storeId, { ignoreStock: t.options.ignoreStock });
      for (const [role, rights] of Object.entries(t.rights ?? {})) {
        if (!(EDITABLE_ROLES as string[]).includes(role) || !Array.isArray(rights)) continue;
        this.admin.saveRights(userId, role as Role, rights);
        result.rights++;
      }
      if (t.articles?.length) {
        const r = this.catalogue.importArticles(userId, t.articles, { noVat: this.admin.vatDisabled(storeId) });
        result.articles = { created: r.created, updated: r.updated, errors: r.errors.length };
      }
      this.audit(userId, 'template.apply', 'store', storeId, { template: t.name, ...result });
      return result;
    });
  }

  /** Fait un modèle de la boutique : rayons, réglages, droits et, au choix, le catalogue (prix nationaux). */
  capture(storeId: string, input: { name: string; description?: string; articles?: boolean }): ShopTemplate {
    if (!input.name.trim()) throw new AppError('Donnez un nom au modèle', 'INVALID');
    const settings = this.admin.storeSettings(storeId) as unknown as Record<string, unknown>;
    for (const k of OWN_SETTINGS) delete settings[k];
    const t: ShopTemplate = {
      v: 1,
      id: `fichier-${this.clock().getTime()}`,
      name: input.name.trim(),
      description: input.description?.trim() || `Modèle fait à partir de ${this.admin.getStore(storeId).name}`,
      departments: this.catalogue.listDepartments().map((d) => ({ name: d.name, families: d.families.map((f) => f.name) })),
      settings: settings as Partial<StoreSettings>,
      options: { ignoreStock: this.admin.getStore(storeId).ignore_stock === 1 },
      rights: Object.fromEntries(this.admin.rightsMatrix().map((r) => [r.role, r.rights])),
    };
    if (input.articles) {
      t.articles = (
        this.db
          .prepare(
            `SELECT a.name, a.sale_price AS salePrice, a.purchase_price AS purchasePrice, a.unit, r.rate_bp AS vatRateBp, d.name AS department, f.name AS family,
                    (SELECT b.code FROM barcodes b WHERE b.article_id = a.id ORDER BY b.pack_qty, b.code LIMIT 1) AS barcode
             FROM articles a JOIN vat_rates r ON r.id = a.vat_rate_id
             LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id
             WHERE a.active = 1 ORDER BY a.name`,
          )
          .all() as NonNullable<ShopTemplate['articles']>
      ).map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null)) as NonNullable<ShopTemplate['articles']>[number]);
    }
    return t;
  }
}
