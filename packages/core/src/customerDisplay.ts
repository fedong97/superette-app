/**
 * Afficheur client : ce que voit le client pendant qu'on le sert, sur un
 * deuxième écran branché au PC de caisse ou sur un petit afficheur à deux
 * lignes (VFD, port COM). L'écran de caisse envoie l'état ; le PC le dessine.
 */
import { formatFcfa } from './money';

export type CustomerDisplayMode = 'off' | 'screen' | 'vfd';

export const CUSTOMER_DISPLAY_MODES: Record<CustomerDisplayMode, string> = {
  off: 'Aucun',
  screen: 'Deuxième écran branché au PC',
  vfd: 'Afficheur à deux lignes (port COM)',
};

/** Ce qui s'affiche : l'accueil, le ticket en cours, ou le paiement avec la monnaie. */
export type CustomerDisplayState =
  | { kind: 'idle' }
  | {
      kind: 'cart';
      /** Dernier article scanné, en tête d'affichage. */
      last: { name: string; qty: string; amount: number } | null;
      lines: { name: string; qty: string; amount: number }[];
      total: number;
      /** Économies des promotions et remises. */
      savings: number;
    }
  | { kind: 'paid'; total: number; paid: number; change: number };

/** Texte en ASCII : les afficheurs VFD n'ont pas tous les accents (CP437, CP850…). */
export function displayAscii(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[  ]/g, ' ')
    .replace(/[^\x20-\x7e]/g, '');
}

const amount = (v: number) => displayAscii(formatFcfa(v, false));

/** Une ligne de `width` caractères : libellé à gauche, montant à droite, le libellé coupé si besoin. */
function spread(left: string, right: string, width: number): string {
  const r = right.slice(0, width);
  const room = Math.max(0, width - r.length - (r ? 1 : 0));
  return `${left.slice(0, room).padEnd(room)}${r ? ` ${r}` : ''}`.padEnd(width).slice(0, width);
}

/** Les deux lignes d'un afficheur VFD (20 colonnes le plus souvent). */
export function vfdLines(state: CustomerDisplayState, width = 20, welcome = 'Bienvenue'): [string, string] {
  switch (state.kind) {
    case 'idle': {
      const w = displayAscii(welcome).slice(0, width);
      const pad = Math.floor((width - w.length) / 2);
      return [' '.repeat(pad) + w.padEnd(width - pad), ' '.repeat(width)];
    }
    case 'cart': {
      const top = state.last ? spread(displayAscii(state.last.name), amount(state.last.amount), width) : ' '.repeat(width);
      return [top, spread('TOTAL', amount(state.total), width)];
    }
    case 'paid':
      return [spread('PAYE', amount(state.paid), width), spread('MONNAIE', amount(state.change), width)];
  }
}

/**
 * Trame pour un afficheur au jeu de commandes ESC/POS (Epson DM-D, CD5220 et compatibles) :
 * initialisation, effacement, puis les deux lignes, chacune à sa place.
 */
export function vfdFrame(lines: [string, string]): Uint8Array {
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0) & 0x7f);
  return new Uint8Array([
    0x1b, 0x40, // ESC @ : initialise
    0x0c, // effacer l'écran, curseur en haut à gauche
    ...text(lines[0]),
    0x1f, 0x24, 0x01, 0x02, // US $ 1 2 : curseur au début de la ligne 2
    ...text(lines[1]),
  ]);
}
