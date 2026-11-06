import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ApiError, call } from './api';
import './styles.css';
import './design.css';

// 0.116.0 : un plantage d'écran est noté sur ce PC (sans données saisies) puis envoyé au serveur central.
// Les erreurs prévues (ApiError : « stock insuffisant »…) ne sont pas des plantages.
let reported = 0;
function report(e: unknown) {
  if (e instanceof ApiError || !window.superette || reported > 20) return;
  reported++;
  const err = e instanceof Error ? e : new Error(String(e));
  void call('errors.report', { message: err.message, stack: err.stack ?? null, where: document.title || null }).catch(() => undefined);
}
window.addEventListener('error', (ev) => report(ev.error ?? ev.message));
window.addEventListener('unhandledrejection', (ev) => report(ev.reason));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
