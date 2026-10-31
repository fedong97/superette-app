import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { ROLE_LABELS } from '../App';
import { Empty, Field, askConfirm, dateTime, useLoad, useToast } from '../ui';

type User = NonNullable<Result<'app.state'>['user']>;
type LimitRow = Result<'admin.userLimits'>[number];

/** Demain à 20 h : fin proposée pour une délégation. */
const tomorrowEvening = () => {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(20, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Délégation et plafonds : le gérant qui s'absente confie ses pouvoirs à un
 * utilisateur jusqu'à une date, et chaque utilisateur peut avoir un plafond
 * (remise, sortie de caisse) au-delà duquel le code d'un superviseur reste
 * nécessaire. Les droits « sans le code du gérant » se règlent dans Droits par
 * rôle et Privilèges par utilisateur, groupe « Opérations sensibles ».
 */
export function Delegation({ user, onChanged }: { user: User; onChanged: () => void }) {
  const toast = useToast();
  const canDelegate = user.rights.includes('delegate');
  const canLimits = user.rights.includes('user_limits');
  const users = useLoad(() => call('admin.users'), []);
  const current = useLoad(() => call('admin.delegations'), []);
  const [to, setTo] = useState('');
  const [until, setUntil] = useState(tomorrowEvening);
  const choices = (users.data ?? []).filter((u) => u.role !== 'admin' && u.active === 1 && u.id !== user.id);

  const give = async () => {
    const target = choices.find((u) => u.id === to);
    if (!target) return toast.error('Choisissez à qui confier vos pouvoirs');
    if (!(await askConfirm(`${target.name} aura tous vos droits (code de superviseur, accords à distance, remises, annulations…) jusqu'au ${dateTime(new Date(until).toISOString())}. Continuer ?`))) return;
    try {
      await call('admin.delegate', to, new Date(until).toISOString());
      toast.ok(`Pouvoirs confiés à ${target.name} : ils valent à sa prochaine connexion, sur tous les postes et sur son téléphone`);
      current.reload();
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <>
      <h3>Confier mes pouvoirs pendant mon absence</h3>
      <p className="muted">
        La personne choisie reçoit une copie de vos droits jusqu'à la date de fin : son code vaut le vôtre sur les postes des caissiers et des vendeurs, et elle
        accorde les demandes à distance sur son téléphone. Tout revient automatiquement à la date de fin. Chaque opération reste au nom de qui l'a faite.
      </p>
      {canDelegate ? (
        <div className="filters">
          <Field label="À qui">
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choisir…</option>
              {choices.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({ROLE_LABELS[u.role]})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Jusqu'au">
            <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
          <button className="primary" disabled={!to || !until} onClick={() => void give()}>
            Confier mes pouvoirs
          </button>
        </div>
      ) : (
        <p className="muted">Vous n'avez pas le droit de confier vos pouvoirs (Opérations sensibles › Confier temporairement ses pouvoirs).</p>
      )}
      {current.data?.length ? (
        <table className="list compact">
          <thead>
            <tr>
              <th>Utilisateur</th>
              <th>Pouvoirs de</th>
              <th>Jusqu'au</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {current.data.map((d) => (
              <tr key={d.userId}>
                <td>{d.userName}</td>
                <td>{d.delegation.byName}</td>
                <td>{dateTime(d.delegation.until)}</td>
                <td className="r">
                  <button
                    onClick={async () => {
                      try {
                        await call('admin.endDelegation', d.userId);
                        toast.ok(`Délégation de ${d.userName} terminée`);
                        current.reload();
                        onChanged();
                      } catch (err) {
                        toast.error(err);
                      }
                    }}
                  >
                    Arrêter maintenant
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Aucune délégation en cours.</Empty>
      )}

      {canLimits && <Limits />}
    </>
  );
}

/** Plafonds par utilisateur : au-delà, le code d'un superviseur reste nécessaire même avec le droit « sans code ». */
function Limits() {
  const toast = useToast();
  const rows = useLoad(() => call('admin.userLimits'), []);
  return (
    <>
      <h3>Plafonds par utilisateur</h3>
      <p className="muted">
        Un utilisateur qui a le droit de faire une remise ou une sortie de caisse sans le code du gérant peut être limité : au-delà de son plafond, le code d'un
        superviseur est demandé. Laissez 0 pour ne pas limiter.
      </p>
      {rows.data?.length ? (
        <table className="list compact">
          <thead>
            <tr>
              <th>Utilisateur</th>
              <th>Rôle</th>
              <th className="r">Remise sans code jusqu'à (%)</th>
              <th className="r">Sortie de caisse sans code jusqu'à (FCFA)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.data.map((r) => (
              <LimitLine key={r.id} row={r} onSaved={() => (rows.reload(), toast.ok(`Plafonds de ${r.name} enregistrés`))} onError={toast.error} />
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Aucun utilisateur.</Empty>
      )}
    </>
  );
}

function LimitLine({ row, onSaved, onError }: { row: LimitRow; onSaved: () => void; onError: (e: unknown) => void }) {
  const [pct, setPct] = useState(String(row.limits.discountPct ?? 0));
  const [out, setOut] = useState(String(row.limits.cashOut ?? 0));
  useEffect(() => {
    setPct(String(row.limits.discountPct ?? 0));
    setOut(String(row.limits.cashOut ?? 0));
  }, [row]);
  const dirty = pct !== String(row.limits.discountPct ?? 0) || out !== String(row.limits.cashOut ?? 0);
  return (
    <tr>
      <td>{row.name}</td>
      <td>{ROLE_LABELS[row.role]}</td>
      <td className="r">
        <input type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} disabled={!row.discount} title={row.discount ? '' : "N'a pas le droit de remise sans code"} style={{ width: 80 }} />
      </td>
      <td className="r">
        <input type="number" min={0} step={1000} value={out} onChange={(e) => setOut(e.target.value)} disabled={!row.cashout} title={row.cashout ? '' : "N'a pas le droit de sortie de caisse sans code"} style={{ width: 120 }} />
      </td>
      <td className="r">
        <button
          disabled={!dirty}
          onClick={async () => {
            try {
              await call('admin.saveLimits', row.id, { discountPct: Number(pct) || 0, cashOut: Number(out) || 0 });
              onSaved();
            } catch (err) {
              onError(err);
            }
          }}
        >
          Enregistrer
        </button>
      </td>
    </tr>
  );
}
