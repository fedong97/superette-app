import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Envoi d'octets bruts (ESC/POS) à une imprimante thermique, sans passer par
 * le rendu du pilote : par le réseau (port 9100) ou par le spouleur Windows.
 */

/** Imprimante réseau (Ethernet ou Wi-Fi) : connexion TCP directe, port 9100 en général. */
export function sendNetwork(host: string, port: number, data: Uint8Array, timeoutMs = 5000): Promise<void> {
  if (!host.trim()) return Promise.reject(new Error("Adresse IP de l'imprimante non renseignée (Paramètres)"));
  return new Promise((resolve, reject) => {
    const socket = connect({ host: host.trim(), port });
    let done = false;
    const fail = (err: Error & { code?: string }) => {
      if (done) return;
      done = true;
      socket.destroy();
      const why = err.code === 'ECONNREFUSED' ? 'connexion refusée' : err.code === 'ETIMEDOUT' || !err.code ? "pas de réponse" : err.code;
      reject(new Error(`Imprimante injoignable à ${host}:${port} (${why}). Vérifiez qu'elle est allumée et sur le même réseau.`));
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('timeout')));
    socket.on('error', fail);
    socket.on('connect', () => socket.end(Buffer.from(data)));
    socket.on('close', (hadError) => {
      if (done || hadError) return;
      done = true;
      resolve();
    });
  });
}

/**
 * Script PowerShell qui écrit les octets dans la file d'impression en type
 * « RAW » (API winspool), comme le font les logiciels de caisse : le pilote
 * Windows de l'imprimante transmet les commandes ESC/POS telles quelles.
 */
const RAW_PRINT_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$Printer = $env:SUPERETTE_PRINTER
$Path = $env:SUPERETTE_RAW_FILE
if (-not $Printer) {
  Add-Type -AssemblyName System.Drawing
  $Printer = (New-Object System.Drawing.Printing.PrinterSettings).PrinterName
}
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SuperetteRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr handle, byte[] data, int count, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      DOCINFO info = new DOCINFO();
      info.pDocName = "Ticket Superette";
      info.pDataType = "RAW";
      if (StartDocPrinter(h, 1, info) == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length) throw new Win32Exception(Marshal.GetLastWin32Error());
        EndPagePrinter(h);
      } finally {
        EndDocPrinter(h);
      }
    } finally {
      ClosePrinter(h);
    }
  }
}
"@
[SuperetteRawPrinter]::Send($Printer, [System.IO.File]::ReadAllBytes($Path))
`;

/** Imprimante USB installée sous Windows : envoi brut par le spouleur. `printer` vide = imprimante par défaut. */
export async function sendWindowsRaw(printer: string, data: Uint8Array): Promise<void> {
  if (process.platform !== 'win32') throw new Error("L'envoi direct par Windows n'est possible que sur un PC Windows");
  const base = join(tmpdir(), `superette-${randomUUID()}`);
  const script = `${base}.ps1`;
  const bin = `${base}.bin`;
  await writeFile(script, RAW_PRINT_PS1, 'utf8');
  await writeFile(bin, data);
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        // Nom et fichier passés par l'environnement : aucun souci de guillemets ni d'argument vide.
        { windowsHide: true, timeout: 20_000, env: { ...process.env, SUPERETTE_PRINTER: printer, SUPERETTE_RAW_FILE: bin } },
        (err, _stdout, stderr) => {
          if (!err) return resolve();
          const detail = String(stderr).split(/\r?\n/).find((l) => l.trim()) ?? err.message;
          reject(new Error(`Impression directe impossible sur « ${printer || 'imprimante par défaut'} » : ${detail}`));
        },
      ),
    );
  } finally {
    await Promise.all([rm(script, { force: true }), rm(bin, { force: true })]);
  }
}
