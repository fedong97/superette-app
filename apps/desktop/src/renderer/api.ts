import type { Api, ApiName } from '../main/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Appel typé vers le processus principal. */
export async function call<K extends ApiName>(name: K, ...args: Parameters<Api[K]>): Promise<Awaited<ReturnType<Api[K]>>> {
  const res = await window.superette.invoke(name, args);
  if (!res.ok) throw new ApiError(res.error.message, res.error.code);
  return res.data as Awaited<ReturnType<Api[K]>>;
}

export type Result<K extends ApiName> = Awaited<ReturnType<Api[K]>>;
