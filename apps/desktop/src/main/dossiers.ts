import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AppError, type DossierInfo, FICHE_EXTENSION, inspectDossier } from '@superette/db';

/** Dossier d'une boutique tel que la liste « Ouvrir une boutique » le montre. */
export interface DossierEntry extends DossierInfo {
  current: boolean;
  /** Base historique du PC (%APPDATA%\Superette Gestion\superette.db). */
  main: boolean;
}

interface Poste {
  current: string | null;
  recent: string[];
  /** Début de la période d'essai de ce PC : une nouvelle boutique ne la fait pas recommencer. */
  trialStart?: string | null;
}

const MAX_RECENT = 12;

/**
 * Les boutiques connues de ce PC :
 * chaque boutique est un fichier, le PC retient la dernière ouverte et les récentes.
 * Les réglages du PC (licence, imprimante…) restent dans chaque fichier, côté poste.
 */
export function createDossiers(userData: string, documents: string) {
  const posteFile = join(userData, 'poste.json');
  const mainFile = join(userData, 'superette.db');
  const dir = join(documents, 'FEDONIX 360', 'Dossiers');

  const read = (): Poste => {
    try {
      const p = JSON.parse(readFileSync(posteFile, 'utf8')) as Partial<Poste>;
      return {
        current: typeof p.current === 'string' ? p.current : null,
        recent: Array.isArray(p.recent) ? p.recent.filter((f) => typeof f === 'string') : [],
        trialStart: typeof p.trialStart === 'string' ? p.trialStart : null,
      };
    } catch {
      return { current: null, recent: [] };
    }
  };
  const write = (p: Poste) => {
    mkdirSync(userData, { recursive: true });
    writeFileSync(posteFile, JSON.stringify(p, null, 2));
  };
  const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

  /** Nom de fichier libre dans le dossier des boutiques : « Boutique-Akwa.fedonix », « Boutique-Akwa-2.fedonix »… */
  const freeName = (name: string) => {
    const slug =
      name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'Boutique';
    mkdirSync(dir, { recursive: true });
    for (let i = 1; ; i++) {
      const file = join(dir, `${slug}${i > 1 ? `-${i}` : ''}.${FICHE_EXTENSION}`);
      if (!existsSync(file)) return file;
    }
  };

  return {
    dir,
    mainFile,
    /** Fichier ouvert au démarrage : SUPERETTE_DB, sinon la dernière boutique ouverte, sinon la base du PC. */
    startupFile(env?: string): string {
      if (env) return env;
      const { current } = read();
      if (current && existsSync(current)) return current;
      mkdirSync(userData, { recursive: true });
      return mainFile;
    },
    /** Retient la boutique à ouvrir au prochain démarrage. */
    remember(file: string) {
      const p = read();
      write({ ...p, current: file, recent: [file, ...p.recent.filter((f) => !same(f, file))].slice(0, MAX_RECENT) });
    },
    /** Retire une boutique de la liste (le fichier n'est pas supprimé). */
    forget(file: string, open: string) {
      if (same(file, open)) throw new AppError('Cette boutique est ouverte : ouvrez-en une autre avant de la retirer de la liste', 'INVALID');
      if (same(file, mainFile)) throw new AppError('La boutique principale de ce PC reste dans la liste', 'INVALID');
      const p = read();
      write({ ...p, current: p.current && same(p.current, file) ? null : p.current, recent: p.recent.filter((f) => !same(f, file)) });
    },
    /**
     * Essai commun à toutes les boutiques du PC : la plus ancienne date connue
     * l'emporte (renvoie celle que la boutique ouverte doit garder).
     */
    shareTrial(own: string | null): string | null {
      const p = read();
      const first = [p.trialStart, own].filter((d): d is string => Boolean(d)).sort()[0] ?? null;
      if (first && first !== p.trialStart) write({ ...p, trialStart: first });
      return first;
    },
    list(open: string): DossierEntry[] {
      const files = [open, ...read().recent];
      if (existsSync(mainFile)) files.push(mainFile);
      const seen: string[] = [];
      for (const f of files) if (!seen.some((s) => same(s, f))) seen.push(f);
      return seen.map((file) => ({ ...inspectDossier(file), current: same(file, open), main: same(file, mainFile) }));
    },
    /** Fichier vide d'une nouvelle boutique : FEDONIX 360 la crée en l'ouvrant (écran de premier démarrage). */
    newFile(name: string): string {
      const file = freeName(name);
      writeFileSync(file, '');
      return file;
    },
    /**
     * Copie une fiche (clé USB…) dans le dossier des boutiques de ce PC : on travaille
     * sur le disque, jamais sur la clé, et la fiche d'origine reste intacte.
     */
    importFile(file: string): string {
      if (same(dirname(file), dir)) return file;
      mkdirSync(dir, { recursive: true });
      const stem = basename(file).replace(/\.[^.]+$/, '');
      let target = join(dir, `${stem}.${FICHE_EXTENSION}`);
      for (let i = 2; existsSync(target); i++) target = join(dir, `${stem}-${i}.${FICHE_EXTENSION}`);
      copyFileSync(file, target);
      return target;
    },
  };
}

export type Dossiers = ReturnType<typeof createDossiers>;
