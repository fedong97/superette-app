/** Alertes de péremption : J-7, J-3, J-1, et périmé. */
export type ExpiryAlert = 'perime' | 'J-1' | 'J-3' | 'J-7' | null;

export function daysUntil(expiry: string, today: string): number {
  const ms = Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function expiryAlert(expiry: string | null, today: string): ExpiryAlert {
  if (expiry === null) return null;
  const days = daysUntil(expiry, today);
  if (days < 0) return 'perime';
  if (days <= 1) return 'J-1';
  if (days <= 3) return 'J-3';
  if (days <= 7) return 'J-7';
  return null;
}
