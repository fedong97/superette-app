import { type AddressInfo, createServer } from 'node:net';
import { drawerKick, receiptToEscPos } from '@superette/core';
import { describe, expect, it } from 'vitest';
import { sendNetwork, sendWindowsRaw } from '../src/main/rawPrint';

/** Fausse imprimante réseau : renvoie les octets reçus sur le port 9100 simulé. */
function fakePrinter(): Promise<{ port: number; received: Promise<Buffer>; close: () => void }> {
  return new Promise((resolve) => {
    let deliver!: (b: Buffer) => void;
    const received = new Promise<Buffer>((r) => (deliver = r));
    const server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (c) => chunks.push(c));
      socket.on('end', () => deliver(Buffer.concat(chunks)));
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, received, close: () => server.close() }));
  });
}

describe('envoi direct à l’imprimante', () => {
  it('envoie le ticket et l’ouverture du tiroir par le réseau', async () => {
    const printer = await fakePrinter();
    const bytes = receiptToEscPos([{ t: 'text', text: 'Bière fraîche' }], { columns: 48, codepage: 'pc850', kick: true });
    await sendNetwork('127.0.0.1', printer.port, bytes);
    expect(Buffer.from(bytes).equals(await printer.received)).toBe(true);
    printer.close();

    const drawer = await fakePrinter();
    await sendNetwork('127.0.0.1', drawer.port, drawerKick());
    expect((await drawer.received).toString('hex')).toBe('1b700019fa');
    drawer.close();
  });

  it('explique en français quand l’imprimante est injoignable', async () => {
    const printer = await fakePrinter();
    printer.close();
    await expect(sendNetwork('127.0.0.1', printer.port, drawerKick())).rejects.toThrow(/Imprimante injoignable à 127\.0\.0\.1:\d+ \(connexion refusée\)/);
    await expect(sendNetwork('', 9100, drawerKick())).rejects.toThrow('Adresse IP');
    // Adresse non routable : délai dépassé.
    await expect(sendNetwork('10.255.255.1', 9100, drawerKick(), 300)).rejects.toThrow('Imprimante injoignable');
  });

  it.skipIf(process.platform === 'win32')('refuse l’envoi par le spouleur hors Windows', async () => {
    await expect(sendWindowsRaw('POS-80', drawerKick())).rejects.toThrow('PC Windows');
  });
});
