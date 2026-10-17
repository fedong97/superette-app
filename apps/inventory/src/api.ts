/** Appels à FEDONIX 360 Serveur (`/api/v1/mobile/…`). */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Auth {
  token?: string;
  session?: string;
}

const TIMEOUT_MS = 12_000;

export async function request<T>(base: string, path: string, options: { method?: 'GET' | 'POST'; body?: unknown; auth?: Auth; timeout?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth?.token) headers['Authorization'] = `Bearer ${options.auth.token}`;
  if (options.auth?.session) headers['X-Fedonix-Session'] = options.auth.session;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new ApiError('Le serveur ne répond pas', 0));
    }, options.timeout ?? TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([
      fetch(`${base}${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller?.signal,
      }),
      timeout,
    ]);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = (data as { message?: string | string[] } | null)?.message;
      throw new ApiError((Array.isArray(msg) ? msg.join(', ') : msg) || `Erreur du serveur (${res.status})`, res.status);
    }
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('Pas de connexion au serveur', 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Première adresse du serveur qui répond (Wi-Fi du magasin, Tailscale, Internet). */
export async function findServer(urls: string[]): Promise<string | null> {
  if (!urls.length) return null;
  return new Promise((resolve) => {
    let left = urls.length;
    for (const url of urls) {
      request<{ ok: boolean }>(url, '/api/v1/health', { timeout: 5_000 })
        .then((r) => (r?.ok ? resolve(url) : Promise.reject(new Error())))
        .catch(() => {
          if (--left === 0) resolve(null);
        });
    }
  });
}
