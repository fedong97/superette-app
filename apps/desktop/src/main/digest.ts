import { safeStorage } from 'electron';
import { createTransport } from 'nodemailer';
import { AppError, type Services } from '@superette/db';

const CHECK_MS = 5 * 60_000;
const frDate = (d: string) => d.split('-').reverse().join('/');

/**
 * Résumé du soir par e-mail : toutes les 5 minutes, le PC où l'envoi est réglé
 * vérifie si le résumé du jour (ou de la veille, PC éteint le soir) doit partir.
 * Le mot de passe du compte d'envoi est chiffré par Windows pour ce PC.
 */
export function createDigestMailer(s: Services) {
  const seal = (password: string) => {
    if (!safeStorage.isEncryptionAvailable()) throw new AppError('Windows ne peut pas protéger le mot de passe sur ce PC', 'INVALID');
    return safeStorage.encryptString(password).toString('base64');
  };

  const send = async (date: string): Promise<string> => {
    const station = s.admin.station();
    if (!station) throw new AppError("Ce poste n'est pas configuré", 'NO_STATION');
    const c = s.digest.config();
    const sealed = s.digest.sealedPassword();
    if (!c.emails) throw new AppError('Indiquez au moins une adresse e-mail', 'INVALID');
    if (!c.smtpHost || !c.smtpUser || !sealed) throw new AppError("Renseignez le serveur d'envoi, le compte e-mail et son mot de passe", 'INVALID');
    const digest = s.digest.build(station.store.id, date);
    const transport = createTransport({
      host: c.smtpHost,
      port: c.smtpPort,
      secure: c.smtpPort === 465,
      auth: { user: c.smtpUser, pass: safeStorage.decryptString(Buffer.from(sealed, 'base64')) },
      connectionTimeout: 20_000,
    });
    try {
      await transport.sendMail({
        from: `ONIX 360 <${c.smtpUser}>`,
        to: c.emails,
        subject: `Résumé du ${frDate(date)} · ${digest.storeName}`,
        // Le texte est mis en forme pour WhatsApp : les étoiles du gras n'ont pas de sens dans un e-mail.
        text: digest.text.replace(/\*/g, ''),
      });
    } catch (e) {
      throw new AppError(`Envoi impossible : ${e instanceof Error ? e.message : String(e)}`, 'MAIL');
    }
    s.digest.markSent(date);
    return `Résumé du ${frDate(date)} envoyé à ${c.emails}`;
  };

  let busy = false;
  const tick = async () => {
    if (busy) return;
    const date = s.digest.due();
    if (!date || !s.admin.station()) return;
    busy = true;
    try {
      await send(date);
    } catch (e) {
      console.warn('[résumé]', e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  };
  const start = setTimeout(() => void tick(), 90_000);
  const timer = setInterval(() => void tick(), CHECK_MS);

  return {
    seal,
    sendNow: () => send(s.digest.day(0)),
    stop: () => {
      clearTimeout(start);
      clearInterval(timer);
    },
  };
}

export type DigestMailer = ReturnType<typeof createDigestMailer>;
