import { useState } from 'react';
import { call } from '../api';
import { Field, fcfa, today, useLoad } from '../ui';
import { type WinKind } from '../nav';

const VERDICT_TONE = { very_good: 'pos', good: 'pos', tight: '', loss: 'neg' } as const;
const VERDICT_LABEL = { very_good: 'Très bon mois', good: 'Bon mois', tight: 'Mois juste', loss: 'Mois à perte' } as const;

/**
 * Mon mois en clair : ce qui reste au magasin une fois tout payé, un verdict
 * et des conseils tirés de ses propres chiffres, chacun avec l'écran où agir.
 */
export function MonthClear({ onOpen }: { onOpen: (target: [WinKind, string?]) => void }) {
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const r = useLoad(() => call('owner.monthClear', month), [month]);
  const m = r.data;
  const pct = (v: number) => `${String(v).replace('.', ',')} %`;
  return (
    <>
      <header className="page-head">
        <h1>Mon mois en clair</h1>
        <Field label="Mois">
          <input type="month" value={month} max={today().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </Field>
      </header>
      {m && (
        <>
          <div className={`month-verdict ${VERDICT_TONE[m.verdict]}`}>
            <strong>{VERDICT_LABEL[m.verdict]}</strong>
            <span>{m.summary}</span>
          </div>
          <div className="kpis kpis-6">
            <div>
              <span>Ventes HT</span>
              <strong>{fcfa(m.figures.sales_ht)}</strong>
              <small>{m.figures.tickets} tickets</small>
            </div>
            <div className="pos">
              <span>Marge brute</span>
              <strong>{fcfa(m.figures.margin)}</strong>
              <small>{pct(m.figures.margin_rate)} des ventes</small>
            </div>
            <div className={m.figures.expenses ? 'neg' : ''}>
              <span>Dépenses</span>
              <strong>{fcfa(m.figures.expenses)}</strong>
            </div>
            <div className={m.losses ? 'neg' : ''}>
              <span>Pertes de stock</span>
              <strong>{fcfa(m.losses)}</strong>
              <small>Casse, vol, péremption</small>
            </div>
            <div className={m.cash_gaps < 0 ? 'neg' : ''}>
              <span>Écarts de caisse</span>
              <strong>{fcfa(m.cash_gaps)}</strong>
            </div>
            <div className={m.net > 0 ? 'pos' : 'neg'}>
              <span>Ce qui reste</span>
              <strong>{fcfa(m.net)}</strong>
              <small>{pct(m.net_rate)} des ventes</small>
            </div>
          </div>
          {m.break_even !== null && (
            <p className="muted">
              Seuil de rentabilité : avec la marge de ce mois, il faut {fcfa(m.break_even)} de ventes HT pour payer les dépenses et les pertes.{' '}
              {m.figures.sales_ht >= m.break_even
                ? `Vous l'avez dépassé de ${fcfa(m.figures.sales_ht - m.break_even)}.`
                : `Il manque ${fcfa(m.break_even - m.figures.sales_ht)} de ventes.`}
            </p>
          )}
          <h2>Ce qu'il faut faire</h2>
          {m.advice.length === 0 ? (
            <p className="muted">Rien d'urgent ce mois-ci : pas d'article vendu à perte, pas de client en retard, pas de stock qui dort.</p>
          ) : (
            <div className="month-advice">
              {m.advice.map((a) => (
                <div key={a.key} className="month-tip">
                  <strong>{a.title}</strong>
                  <span>{a.detail}</span>
                  {a.items.length > 0 && (
                    <ul>
                      {a.items.map((i) => (
                        <li key={i.name}>
                          {i.name} <b>{fcfa(i.amount)}</b>
                        </li>
                      ))}
                    </ul>
                  )}
                  {a.open && (
                    <button className="link" onClick={() => onOpen(a.open as [WinKind, string?])}>
                      Ouvrir
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
