import { formatFcfa } from './money';

/** Message de relance proposé quand le magasin n'a pas écrit le sien (Paramètres › Crédit clients). */
export const DEFAULT_REMINDER_TEMPLATE =
  'Bonjour {client},\n\nSauf erreur de notre part, votre compte chez {magasin} présente un solde de {solde}, dont {echu} échu.\n\n{factures}\n\nMerci de passer régler au magasin ou de nous payer par Mobile Money. Si vous avez déjà réglé, merci de ne pas tenir compte de ce message.\n\n{magasin} {telephone}';

/** Champs utilisables dans le message de relance, avec leur explication. */
export const REMINDER_FIELDS: Record<string, string> = {
  '{client}': 'nom du client',
  '{magasin}': 'nom du magasin',
  '{telephone}': 'téléphone du magasin',
  '{solde}': 'total dû',
  '{echu}': 'part en retard',
  '{factures}': 'liste des factures dues',
};

export interface ReminderData {
  customer: string;
  store: string;
  storePhone: string | null;
  balance: number;
  overdue: number;
  items: { number: string; date: string; dueDate: string; remaining: number; daysLate: number }[];
}

const dayFr = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/** Texte de la relance : le modèle du magasin (ou celui par défaut) rempli pour ce client. */
export function reminderMessage(template: string, d: ReminderData): string {
  const items = d.items
    .map((i) => `- Facture ${i.number} du ${dayFr(i.date)} : ${formatFcfa(i.remaining)}${i.daysLate > 0 ? `, échue depuis ${i.daysLate} j` : `, à régler avant le ${dayFr(i.dueDate)}`}`)
    .join('\n');
  const values: Record<string, string> = {
    '{client}': d.customer,
    '{magasin}': d.store,
    '{telephone}': d.storePhone ?? '',
    '{solde}': formatFcfa(d.balance),
    '{echu}': formatFcfa(d.overdue),
    '{factures}': items,
  };
  const text = (template.trim() || DEFAULT_REMINDER_TEMPLATE).replace(/\{(client|magasin|telephone|solde|echu|factures)\}/g, (k) => values[k] ?? k);
  // Pas de lignes vides en trop quand un champ est vide.
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Numéro au format international pour WhatsApp (chiffres seulement). Un numéro
 * camerounais à 9 chiffres reçoit l'indicatif 237. Null si le numéro est trop court.
 */
export function whatsappNumber(phone: string | null | undefined, country = '237'): string | null {
  let digits = (phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9) digits = country + digits;
  return digits.length >= 10 ? digits : null;
}

/** Lien qui ouvre WhatsApp (application ou WhatsApp Web) avec le message prêt à envoyer. */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  const n = whatsappNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}
