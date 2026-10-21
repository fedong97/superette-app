export {};

declare global {
  interface Window {
    superette: {
      invoke(name: string, args: unknown[]): Promise<{ ok: true; data: unknown } | { ok: false; error: { message: string; code: string; fixes?: { label: string; open?: [string, string?]; run?: { api: string; args: unknown[] } }[] } }>;
    };
  }
}
