// Le « worker » de pdf.js n'a pas de types : seul son chargement compte (voir pdfText.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
