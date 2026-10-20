import { EN, EN_PATTERNS } from './i18nEn';

/**
 * Langue des écrans. Les écrans sont écrits en français ; en anglais, chaque texte
 * affiché (texte, infobulle, indication de saisie) est remplacé par sa traduction
 * au moment où il apparaît, sans toucher au code des écrans. Ce que l'utilisateur
 * saisit (noms de produits, de clients) n'est jamais traduit : seuls les textes
 * connus du dictionnaire le sont.
 */
export type Lang = 'fr' | 'en';

const STORAGE_KEY = 'fedonix.lang';
const ATTRS = ['placeholder', 'title', 'aria-label'] as const;

let lang: Lang = 'fr';
let observer: MutationObserver | null = null;
/** Texte français d'origine de chaque nœud traduit, pour revenir au français sans recharger. */
const original = new WeakMap<Node, string>();
const originalAttr = new WeakMap<Element, Record<string, string>>();

export const currentLang = (): Lang => lang;

/** Dernière langue choisie sur ce PC : celle de l'écran de connexion. */
export function storedLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'fr';
  } catch {
    return 'fr';
  }
}

/** Traduit un texte affiché ; renvoie le texte tel quel s'il n'est pas connu. */
export function tr(text: string): string {
  if (lang === 'fr') return text;
  return translate(text) ?? text;
}

/** Traduction anglaise d'un texte, quelle que soit la langue choisie (tests). */
export const toEnglish = (text: string): string => translate(text) ?? text;

function translate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || !/[A-Za-zÀ-ÿ]/.test(trimmed)) return null;
  const found = lookup(trimmed);
  if (found === null || found === trimmed) return null;
  // Garde les espaces autour du texte (JSX : « Total : » suivi d'un montant).
  const start = text.length - text.trimStart().length;
  return text.slice(0, start) + found + text.slice(start + trimmed.length);
}

function lookup(s: string): string | null {
  const exact = EN[s];
  if (exact !== undefined) return exact;
  // Ponctuation finale : « Client : », « Ouvrir la caisse… », « Remise ? ».
  const end = /^(.*?)(\s*[:?!]|…|\.)$/.exec(s);
  if (end) {
    const base = EN[end[1]!];
    if (base !== undefined) return base + end[2]!.trim();
  }
  for (const [re, to] of EN_PATTERNS) {
    const m = re.exec(s);
    if (m) return typeof to === 'string' ? s.replace(re, to) : to(m, (fr) => lookup(fr) ?? fr);
  }
  // Chemins « Facturation › Vente au comptant 1 » et listes « Caisse 1 · Steve ».
  for (const sep of [' › ', ' · ', ' / ']) {
    if (!s.includes(sep)) continue;
    const parts = s.split(sep);
    const done = parts.map((p) => lookup(p));
    // Toutes les parties traduites, ou gardées parce que ce sont des noms ou des numéros.
    if (done.some((p) => p !== null) && done.every((p, i) => p !== null || !looksFrench(parts[i]!))) return done.map((p, i) => p ?? parts[i]).join(sep);
  }
  return pieces(s);
}

/**
 * Texte composé d'un écran (« Commande CC-1-00001 préparée ») : chaque morceau connu
 * est traduit à sa place, le reste (numéros, noms) est gardé. Un mot seul avec une
 * majuscule ne compte qu'en tête, pour ne pas traduire un nom propre.
 */
let index: Map<string, string[]> | null = null;
/** Un seul mot avec une majuscule (« Gros », « Commande ») : traduit seulement en tête d'un texte qui a un autre morceau connu. */
const proper = (k: string) => !/\s/.test(k) && /^\p{Lu}/u.test(k);
function pieces(s: string): string | null {
  if (!index) {
    index = new Map();
    for (const k of Object.keys(EN)) {
      const first = k.split(/\s/)[0]!;
      index.set(first, [...(index.get(first) ?? []), k]);
    }
    for (const list of index.values()) list.sort((a, b) => b.length - a.length);
  }
  const words = s.split(/(\s+)/);
  let out = '';
  let hit = false;
  const left: string[] = [];
  for (let i = 0; i < words.length; ) {
    const rest = words.slice(i).join('');
    const key = index
      .get(words[i]!)
      ?.find((k) => (i === 0 || !proper(k)) && rest.startsWith(k) && (rest.length === k.length || /^[\s.,;:!?)»]/.test(rest.slice(k.length))));
    if (key) {
      out += EN[key];
      hit ||= !proper(key);
      // Avance du nombre de morceaux (mots et espaces) couverts par la clé.
      i += key.split(/(\s+)/).length;
    } else {
      out += words[i];
      left.push(words[i]!);
      i++;
    }
  }
  return hit && !looksFrench(left.join(' ')) ? out : null;
}

/** Un mot en minuscules reste : la phrase n'est traduite qu'à moitié, mieux vaut la laisser entière. */
const looksFrench = (s: string) => /(^|[\s(«'’])[a-zà-ÿ]{2,}(?=$|[\s.,;:!?)»])/.test(s);

function translateNode(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    if (!parent || skip(parent)) return;
    const value = node.nodeValue ?? '';
    const known = original.get(node);
    // Texte changé par l'écran depuis la dernière traduction : c'est le nouveau français.
    const fr = known !== undefined && value === tr(known) ? known : value;
    const en = translate(fr);
    if (en === null) {
      original.delete(node);
      return;
    }
    original.set(node, fr);
    if (node.nodeValue !== en) node.nodeValue = en;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (skip(el)) return;
  translateAttrs(el);
  for (let c = el.firstChild; c; c = c.nextSibling) translateNode(c);
}

function translateAttrs(el: Element): void {
  for (const a of ATTRS) {
    const value = el.getAttribute(a);
    if (!value) continue;
    const saved = originalAttr.get(el) ?? {};
    const fr = saved[a] !== undefined && value === tr(saved[a]!) ? saved[a]! : value;
    const en = translate(fr);
    if (en === null) continue;
    saved[a] = fr;
    originalAttr.set(el, saved);
    if (value !== en) el.setAttribute(a, en);
  }
}

/** Saisies et zones marquées translate="no" (noms propres, codes) : jamais traduites. */
function skip(el: Element): boolean {
  return el.closest('textarea, [contenteditable="true"], [translate="no"], script, style') !== null;
}

function restore(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    const fr = original.get(n);
    if (fr !== undefined) n.nodeValue = fr;
    const attrs = n.nodeType === Node.ELEMENT_NODE ? originalAttr.get(n as Element) : undefined;
    if (attrs) for (const [a, v] of Object.entries(attrs)) (n as Element).setAttribute(a, v);
  }
}

/** Change la langue des écrans (choix de l'utilisateur, ou dernier choix du PC avant la connexion). */
export function setLang(next: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Stockage indisponible : la langue vaut pour cette session.
  }
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  if (next === 'fr') {
    observer?.disconnect();
    observer = null;
    restore(document.body);
    return;
  }
  translateNode(document.body);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translateNode(r.target);
      else if (r.type === 'attributes') r.target.nodeType === Node.ELEMENT_NODE && !skip(r.target as Element) && translateAttrs(r.target as Element);
      else r.addedNodes.forEach(translateNode);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
}
