/**
 * Lecture minimale d'un classeur Excel (.xlsx) : la première feuille, en
 * tableau de lignes de texte. Suffit pour réimporter une fiche de comptage
 * remplie dans Excel (chaînes partagées ou en ligne, nombres, compression
 * « deflate » ou fichiers stockés).
 */

/** Fichiers d'une archive zip (méthodes 0 stockée et 8 deflate). */
export async function unzip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Ce fichier n'est pas un classeur Excel (.xlsx)");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = data.subarray(start, start + size);
    files.set(name, method === 0 ? raw : await inflate(raw));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

/** Texte d'un élément <si> ou <is> : concatène les <t>, y compris en texte enrichi. */
const textOf = (xml: string) => unescape([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

const columnIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

/** Première feuille d'un .xlsx en lignes de cellules texte ('' pour une cellule vide). */
export async function readXlsxRows(data: Uint8Array): Promise<string[][]> {
  const files = await unzip(data);
  const dec = new TextDecoder();
  const shared = files.has('xl/sharedStrings.xml') ? [...dec.decode(files.get('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!)) : [];
  const sheetName = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()))[0];
  if (!sheetName) throw new Error('Aucune feuille dans ce classeur');
  const xml = dec.decode(files.get(sheetName));
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="(\w+)"/)?.[1];
      const body = c[2] ?? '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const value = type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? textOf(body) : v !== undefined ? unescape(v) : '';
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    rows.push(cells);
  }
  return rows;
}
