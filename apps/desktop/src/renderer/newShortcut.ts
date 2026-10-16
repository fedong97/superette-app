/**
 * Ctrl+J : « Nouveau » de la fenêtre de devant (article, client, fournisseur…).
 * Dans un formulaire ouvert, Ctrl+J enregistre puis rouvre un formulaire vide ;
 * un champ obligatoire manquant est signalé et rien n'est enregistré.
 */
const NEW_LABEL = /^(\+\s*)?(Nouveau|Nouvelle|Nouvel|Ajouter un|Ajouter une)\b/;

const visible = (el: HTMLElement) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled;

/** Bouton « Nouveau » de la fenêtre, hors fenêtres de saisie : celui marqué `data-new`, sinon le premier dont le libellé commence par Nouveau. */
export function findNewButton(win: ParentNode): HTMLButtonElement | null {
  const buttons = [...win.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.closest('.modal-back') && visible(b));
  return buttons.find((b) => b.hasAttribute('data-new')) ?? buttons.find((b) => NEW_LABEL.test(b.textContent?.trim() ?? '')) ?? null;
}

export function ctrlJ(): boolean {
  const win = document.querySelector<HTMLElement>('.mdi.active') ?? document.querySelector<HTMLElement>('.window');
  if (!win) return false;
  const modals = win.querySelectorAll<HTMLElement>('.modal-back');
  const top = modals[modals.length - 1];
  if (!top) {
    const btn = findNewButton(win);
    btn?.click();
    return Boolean(btn);
  }
  const focused = document.activeElement?.closest('form');
  const form = focused && top.contains(focused) ? focused : top.querySelector('form');
  if (!form) return false;
  // Champ obligatoire manquant : le navigateur le signale, rien n'est enregistré.
  if (!form.reportValidity()) return true;
  form.requestSubmit();
  // Enregistré : la fenêtre de saisie se ferme, on rouvre un formulaire vide. Erreur : elle reste ouverte.
  const started = Date.now();
  const wait = () => {
    if (!top.isConnected) {
      findNewButton(win)?.click();
      return;
    }
    if (Date.now() - started < 5000) setTimeout(wait, 80);
  };
  setTimeout(wait, 80);
  return true;
}
