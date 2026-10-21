import type { Api, ApiName } from '../main/api';

/** Solution proposée avec une erreur : ouvrir un écran ou lancer une action. */
export interface ErrorFix {
  label: string;
  open?: [string, string?];
  run?: { api: string; args: unknown[] };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly fixes: ErrorFix[] = [],
  ) {
    super(message);
  }
}

/** Appel typé vers le processus principal. */
export async function call<K extends ApiName>(name: K, ...args: Parameters<Api[K]>): Promise<Awaited<ReturnType<Api[K]>>> {
  const res = await window.superette.invoke(name, args);
  if (!res.ok) throw new ApiError(res.error.message, res.error.code, res.error.fixes ?? []);
  return res.data as Awaited<ReturnType<Api[K]>>;
}

export type Result<K extends ApiName> = Awaited<ReturnType<Api[K]>>;
