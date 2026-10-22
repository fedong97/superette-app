import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Notification } from 'electron';
import type { Services } from '@superette/db';

/** Port d'écoute proposé (celui des pointeuses ZKTeco en mode ADMS). */
export const DEFAULT_ADMS_PORT = 8081;
const MAX_BODY = 2 * 1024 * 1024;
const ALERT_MS = 60_000;

/** Adresses IPv4 de ce PC sur le réseau du magasin, à saisir dans la pointeuse. */
export function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => Boolean(i && i.family === 'IPv4' && !i.internal))
    .map((i) => i.address);
}

/**
 * Réception des pointeuses à empreinte ZKTeco (protocole ADMS, « Cloud
 * Server » dans le menu de la pointeuse) : la pointeuse envoie ses passages
 * à ce PC. Elle garde ceux d'un PC éteint et les renvoie au retour. Les
 * empreintes restent dans la pointeuse ; seuls le numéro et l'heure arrivent.
 */
export function createFingerprintReceiver(s: Services) {
  let server: Server | null = null;
  let port: number | null = null;
  let error: string | null = null;
  let lastAt: string | null = null;

  const reply = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(text);
  };

  const handle = (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = new URL(req.url ?? '/', 'http://pointeuse');
    const serial = url.searchParams.get('SN') ?? '';
    const station = s.admin.station();
    if (!station || !s.admin.storeSettings(station.store.id).fingerprint || !serial) return reply(res, 503, 'ERROR');
    const storeId = station.store.id;
    const path = url.pathname.toLowerCase();
    if (path.endsWith('/cdata') && req.method === 'GET') {
      const device = s.fingerprint.device(storeId, serial);
      if (!device.active) return reply(res, 403, 'ERROR');
      // Réglages renvoyés à la pointeuse : envoi en temps réel des passages, sans les photos ni les empreintes.
      return reply(
        res,
        200,
        [`GET OPTION FROM: ${serial}`, 'ATTLOGStamp=None', 'OPERLOGStamp=9999', 'ATTPHOTOStamp=9999', 'ErrorDelay=30', 'Delay=10', 'TransTimes=00:00;14:05', 'TransInterval=1', 'TransFlag=TransData AttLog', 'Realtime=1', 'Encrypt=None'].join('\n'),
      );
    }
    if (path.endsWith('/cdata') && req.method === 'POST') {
      if ((url.searchParams.get('table') ?? '').toUpperCase() !== 'ATTLOG') return reply(res, 200, 'OK');
      const r = s.fingerprint.record(storeId, body, { serial });
      lastAt = new Date().toISOString();
      return reply(res, 200, `OK: ${r.added + r.duplicates}`);
    }
    if (path.endsWith('/getrequest')) {
      s.fingerprint.device(storeId, serial);
      return reply(res, 200, 'OK');
    }
    if (path.endsWith('/devicecmd')) return reply(res, 200, 'OK');
    return reply(res, 404, 'ERROR');
  };

  const stop = () => {
    server?.close();
    server = null;
    port = null;
  };

  /** Écoute sur le port réglé pour ce PC (réglage local « fingerprint.port »), ou s'arrête. */
  const apply = () => {
    const wanted = Number(s.admin.getSetting('fingerprint.port') || 0) || null;
    if (wanted === port && (server || !wanted)) return;
    stop();
    error = null;
    if (!wanted) return;
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          handle(req, res, Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          console.warn('[pointeuse]', e);
          reply(res, 500, 'ERROR');
        }
      });
    });
    srv.on('error', (e: NodeJS.ErrnoException) => {
      error = e.code === 'EADDRINUSE' ? `Le port ${wanted} est déjà pris sur ce PC : choisissez-en un autre` : e.message;
      server = null;
    });
    srv.listen(wanted, '0.0.0.0');
    server = srv;
    port = wanted;
  };

  const state = () => ({ port: Number(s.admin.getSetting('fingerprint.port') || 0) || null, listening: Boolean(server?.listening), error, lastAt, addresses: localAddresses() });

  // Alertes du personnel : chaque minute, retards et absences d'après l'horaire prévu.
  const watch = setInterval(() => {
    try {
      const station = s.admin.station();
      if (!station) return;
      for (const a of s.staffWatch.scan(station.store.id)) {
        if (Notification.isSupported()) new Notification({ title: a.kind === 'absent' ? 'Absence du personnel' : 'Retard du personnel', body: a.text }).show();
      }
    } catch (e) {
      console.warn('[alertes du personnel]', e);
    }
  }, ALERT_MS);

  apply();
  return {
    apply,
    state,
    stop: () => {
      clearInterval(watch);
      stop();
    },
  };
}
