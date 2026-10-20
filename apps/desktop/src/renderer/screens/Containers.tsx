export type ContainersTab = 'situation' | 'moves' | 'types';

/** Emballages consignés : situation, mouvements et types (écran en cours d'écriture). */
export function Containers(_: { initialTab?: ContainersTab }) {
  return <div className="page" />;
}
