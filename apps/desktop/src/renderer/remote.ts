/**
 * Transport du « PC sur le téléphone » : dans ONIX 360 Mobile, l'écran du PC
 * n'a pas Electron. Chaque action part au serveur du magasin, qui la fait
 * exécuter par un PC allumé du magasin au nom du gérant connecté, puis rend
 * la réponse sous la même forme qu'au PC.
 */
export interface RemoteLink {
  url: string;
  token: string;
  session: string;
}

export const LINK_KEY = 'onix.pc';

export function remoteLink(): RemoteLink | null {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    const l = raw ? (JSON.parse(raw) as Partial<RemoteLink>) : null;
    return l?.url && l.token && l.session ? (l as RemoteLink) : null;
  } catch {
    return null;
  }
}

/** Retour à l'appli ONIX 360 Mobile (son écran d'accueil). */
export function backToApp() {
  location.href = '../index.html';
}

type Reply = Awaited<ReturnType<Window['superette']['invoke']>>;

export function installRemote() {
  window.superette = {
    async invoke(name: string, args: unknown[]): Promise<Reply> {
      const link = remoteLink();
      if (!link) return { ok: false, error: { message: 'Ouvrez cet écran depuis ONIX 360 Mobile', code: 'NOT_LOGGED_IN' } };
      // La session est celle du téléphone : se déconnecter ramène à l'appli.
      if (name === 'auth.logout' || name === 'attendance.leave') {
        backToApp();
        return { ok: true, data: null };
      }
      try {
        const res = await fetch(`${link.url.replace(/\/+$/, '')}/api/v1/mobile/pc/call`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${link.token}`, 'x-fedonix-session': link.session },
          body: JSON.stringify({ name, args: args ?? [] }),
        });
        const body = (await res.json().catch(() => null)) as (Reply & { message?: string | string[] }) | null;
        if (!res.ok || !body || typeof body.ok !== 'boolean') {
          const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
          return { ok: false, error: { message: msg ?? `Erreur du serveur (${res.status})`, code: res.status === 503 ? 'PC_OFFLINE' : res.status === 401 ? 'NOT_LOGGED_IN' : 'REMOTE' } };
        }
        return body;
      } catch {
        return { ok: false, error: { message: 'Pas de connexion au serveur du magasin', code: 'OFFLINE' } };
      }
    },
  };
}
