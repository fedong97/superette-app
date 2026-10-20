export type AgentTab = 'counter' | 'history' | 'accounts';

/** Point Mobile Money (écran en cours d'écriture). */
export function AgentPoint(_: { initialTab?: AgentTab }) {
  return <div className="page" />;
}
