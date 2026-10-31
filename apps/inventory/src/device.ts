import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Share } from '@capacitor/share';

/** Vrai dans l'application Android ; faux dans un navigateur (essais sur PC). */
export const native = Capacitor.isNativePlatform();

/** Démarre Firebase avec les réglages du serveur du magasin (FirebaseSetupPlugin.java). */
export const FirebaseSetup = registerPlugin<{ init(options: { appId: string; apiKey: string; projectId: string; senderId: string }): Promise<{ ready: boolean }> }>('FirebaseSetup');

let audio: AudioContext | null = null;

function tone(freq: number, ms: number, volume = 0.25) {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    osc.type = 'square';
    gain.gain.value = volume;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + ms / 1000);
  } catch {
    /* pas de son */
  }
}

/** Bip et vibration d'un scan reconnu. */
export function beepOk() {
  tone(1900, 90);
  if (native) void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => undefined);
}

/** Double bip grave et vibration : code inconnu ou erreur. */
export function beepError() {
  tone(420, 160, 0.3);
  setTimeout(() => tone(330, 220, 0.3), 190);
  if (native) void Haptics.notification({ type: NotificationType.Error }).catch(() => undefined);
}

const FORMATS = [
  BarcodeFormat.Ean13,
  BarcodeFormat.Ean8,
  BarcodeFormat.UpcA,
  BarcodeFormat.UpcE,
  BarcodeFormat.Code128,
  BarcodeFormat.Code39,
  BarcodeFormat.Code93,
  BarcodeFormat.Itf,
  BarcodeFormat.Codabar,
  BarcodeFormat.QrCode,
  BarcodeFormat.DataMatrix,
];

/**
 * Caméra en continu, derrière l'écran de l'application : chaque code lu est
 * passé à `onCode`. Renvoie la fonction qui arrête la caméra.
 */
export async function startCamera(onCode: (code: string) => void): Promise<() => Promise<void>> {
  if (!native) throw new Error('La caméra ne marche que dans l’application Android. Tapez le code.');
  const perm = await BarcodeScanner.requestPermissions();
  if (perm.camera !== 'granted' && perm.camera !== 'limited') {
    throw new Error('Autorisez l’appareil photo dans les réglages du téléphone pour scanner.');
  }
  document.documentElement.classList.add('camera');
  const handle = await BarcodeScanner.addListener('barcodesScanned', (e) => {
    for (const b of e.barcodes) if (b.rawValue) onCode(b.rawValue);
  });
  try {
    await BarcodeScanner.startScan({ formats: FORMATS });
  } catch (e) {
    document.documentElement.classList.remove('camera');
    await handle.remove();
    throw e;
  }
  return async () => {
    document.documentElement.classList.remove('camera');
    await handle.remove().catch(() => undefined);
    await BarcodeScanner.stopScan().catch(() => undefined);
  };
}

export async function toggleTorch() {
  if (native) await BarcodeScanner.toggleTorch().catch(() => undefined);
}

/** Photo prise avec l'appareil, réduite (800 px, JPEG) avant l'envoi. */
export function shrinkPhoto(file: File, max = 800): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Photo illisible'));
    };
    img.src = url;
  });
}

/**
 * Douchette Bluetooth ou terminal à scanner intégré (Zebra, Honeywell…) :
 * ils tapent le code très vite puis « Entrée ». Hors d'une zone de saisie,
 * ces frappes sont reconnues comme un scan.
 */
export function listenWedge(onCode: (code: string) => void): () => void {
  let buf = '';
  let last = 0;
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const now = Date.now();
    if (now - last > 80) buf = '';
    last = now;
    if (e.key === 'Enter') {
      if (buf.length >= 3) {
        e.preventDefault();
        onCode(buf);
      }
      buf = '';
    } else if (e.key.length === 1) {
      buf += e.key;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

/**
 * Fichier texte partagé depuis le téléphone (WhatsApp, e-mail, Drive…) ; dans
 * un navigateur, il est téléchargé.
 */
export async function shareFile(name: string, text: string, title: string) {
  if (!native) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  await Share.share({ title, files: [uri], dialogTitle: title }).catch((e: unknown) => {
    // Fenêtre de partage fermée sans choisir d'application : rien à signaler.
    if (!/cancel/i.test(e instanceof Error ? e.message : String(e))) throw e;
  });
}
