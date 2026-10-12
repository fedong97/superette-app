/** Images importées par Vite : leur adresse dans l'application. */
declare module '*.svg' {
  const url: string;
  export default url;
}

/** Textes importés tels quels par Vite (contrat de licence). */
declare module '*?raw' {
  const text: string;
  export default text;
}
