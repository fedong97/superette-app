import { useEffect, useState } from 'react';
import { PROMOTION_KINDS, type PromotionKind, formatQty, promotionLabel } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateFr, fcfa, parseAmount, today, useLoad, useToast } from '../ui';
import { ArticlePicker } from './pickers';

type Promotion = Result<'promotions.list'>[number];
type Article = Parameters<Parameters<typeof ArticlePicker>[0]['onPick']>[0];

const STATUS: Record<Promotion['status'], string> = {
  running: 'En cours',
  scheduled: 'À venir',
  ended: 'Terminée',
  stopped: 'Arrêtée',
};

const offer = (p: Promotion) =>
  promotionLabel({ id: p.id, name: p.name, articleId: p.article_id, kind: p.kind, promoPrice: p.promo_price, buyQty: p.buy_qty, payQty: p.pay_qty, lotPrice: p.lot_price }, (v) =>
    fcfa(v),
  );

/** Promotions datées appliquées d'elles-mêmes en caisse : prix promo, N achetés M payés, lot à prix fixe. */
export function Promotions({ active }: { active: boolean }) {
  const toast = useToast();
  const list = useLoad(() => call('promotions.list'), []);
  // Les ventes faites en caisse pendant que la fenêtre était cachée mettent à jour les compteurs.
  useEffect(() => {
    if (active) list.reload();
  }, [active]);
  const stores = useLoad(() => call('admin.stores'), []);
  const [filter, setFilter] = useState<'current' | 'all'>('current');
  const [editing, setEditing] = useState<Promotion | 'new' | null>(null);
  const rows = (list.data ?? []).filter((p) => filter === 'all' || p.status === 'running' || p.status === 'scheduled');
  const storeName = (id: string | null) => (id ? (stores.data?.find((s) => s.id === id)?.name ?? '?') : 'Tous les magasins');
  return (
    <div className="page">
      <header className="page-head">
        <h1>Promotions</h1>
        <span className="muted">Appliquées automatiquement en caisse pendant leur période, sans accord du gérant</span>
      </header>
      <div className="filters">
        <div className="seg">
          <button className={filter === 'current' ? 'active' : ''} onClick={() => setFilter('current')}>
            En cours et à venir
          </button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            Toutes
          </button>
        </div>
        <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>
          Nouvelle promotion
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucune promotion {filter === 'current' ? 'en cours ni à venir' : ''}</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Promotion</th>
              <th>Article</th>
              <th>Offre</th>
              <th>Période</th>
              <th>Magasin</th>
              <th>État</th>
              <th className="r">Vendus</th>
              <th className="r">Économie clients</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>
                  {p.article_name} <span className="muted">({fcfa(p.article_price)})</span>
                </td>
                <td>{offer(p)}</td>
                <td>
                  {dateFr(p.starts_on)} au {dateFr(p.ends_on)}
                </td>
                <td>{storeName(p.store_id)}</td>
                <td>
                  <span className={`tag ${p.status === 'running' ? 'normal' : p.status === 'scheduled' ? 'surstock' : ''}`}>{STATUS[p.status]}</span>
                </td>
                <td className="r">{p.sold_qty ? formatQty(p.sold_qty) : '-'}</td>
                <td className="r">{p.given ? fcfa(p.given) : '-'}</td>
                <td className="r nowrap">
                  <button onClick={() => setEditing(p)}>Modifier</button>{' '}
                  {p.status !== 'ended' && (
                    <button
                      className={p.active ? 'danger' : ''}
                      onClick={() =>
                        call('promotions.setActive', p.id, !p.active).then(() => {
                          toast.ok(p.active ? 'Promotion arrêtée' : 'Promotion relancée');
                          list.reload();
                        }, toast.error)
                      }
                    >
                      {p.active ? 'Arrêter' : 'Relancer'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <PromotionForm
          promotion={editing === 'new' ? null : editing}
          stores={stores.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function PromotionForm({
  promotion,
  stores,
  onClose,
  onSaved,
}: {
  promotion: Promotion | null;
  stores: Result<'admin.stores'>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [article, setArticle] = useState<{ id: string; name: string; price: number; unit: Article['unit'] } | null>(
    promotion ? { id: promotion.article_id, name: promotion.article_name, price: promotion.article_price, unit: promotion.article_unit } : null,
  );
  const [kind, setKind] = useState<PromotionKind>(promotion?.kind ?? 'price');
  const [name, setName] = useState(promotion?.name ?? '');
  const [storeId, setStoreId] = useState(promotion?.store_id ?? '');
  const [startsOn, setStartsOn] = useState(promotion?.starts_on ?? today());
  const [endsOn, setEndsOn] = useState(promotion?.ends_on ?? today());
  const [promoPrice, setPromoPrice] = useState(promotion?.promo_price ? String(promotion.promo_price) : '');
  const [buyQty, setBuyQty] = useState(String(promotion?.buy_qty ?? 3));
  const [payQty, setPayQty] = useState(String(promotion?.pay_qty ?? 2));
  const [lotPrice, setLotPrice] = useState(promotion?.lot_price ? String(promotion.lot_price) : '');
  const n = Number(buyQty) || 0;
  // Proposition de nom tant que l'utilisateur n'en a pas tapé un.
  const suggested = article
    ? `${article.name} ${kind === 'price' ? `à ${promoPrice || '…'}` : kind === 'x_for_y' ? `${buyQty} pour ${payQty}` : `${buyQty} pour ${lotPrice || '…'}`}`
    : '';
  const saving =
    article &&
    (kind === 'price'
      ? article.price - (parseAmount(promoPrice) ?? article.price)
      : kind === 'x_for_y'
        ? (n - (Number(payQty) || n)) * article.price
        : n * article.price - (parseAmount(lotPrice) ?? n * article.price));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!article) return toast.error('Choisissez l’article en promotion');
    try {
      await call(
        'promotions.save',
        {
          name: name.trim() || suggested,
          kind,
          articleId: article.id,
          storeId: storeId || null,
          startsOn,
          endsOn,
          promoPrice: kind === 'price' ? parseAmount(promoPrice) : null,
          buyQty: kind === 'price' ? null : n,
          payQty: kind === 'x_for_y' ? Number(payQty) : null,
          lotPrice: kind === 'lot' ? parseAmount(lotPrice) : null,
        },
        promotion?.id,
      );
      toast.ok('Promotion enregistrée');
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={promotion ? 'Modifier la promotion' : 'Nouvelle promotion'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Article">
          {article ? (
            <div className="filters">
              <strong>
                {article.name} <span className="muted">· prix normal {fcfa(article.price)}</span>
              </strong>
              <button type="button" className="ghost" onClick={() => setArticle(null)}>
                Changer
              </button>
            </div>
          ) : (
            <ArticlePicker onPick={(a) => setArticle({ id: a.id, name: a.name, price: a.store_price, unit: a.unit })} placeholder="Nom ou code-barres de l'article" />
          )}
        </Field>
        <div className="grid2">
          <Field label="Type d'offre">
            <select value={kind} onChange={(e) => setKind(e.target.value as PromotionKind)}>
              {(Object.keys(PROMOTION_KINDS) as PromotionKind[]).map((k) => (
                <option key={k} value={k} disabled={k !== 'price' && article?.unit !== undefined && article.unit !== 'piece'}>
                  {PROMOTION_KINDS[k]}
                </option>
              ))}
            </select>
          </Field>
          {kind === 'price' && (
            <Field label={article?.unit === 'kg' ? 'Prix promo au kg' : article?.unit === 'litre' ? 'Prix promo au litre' : 'Prix promo'}>
              <input inputMode="numeric" value={promoPrice} onChange={(e) => setPromoPrice(e.target.value)} placeholder="FCFA TTC" />
            </Field>
          )}
          {kind !== 'price' && (
            <Field label="Articles achetés">
              <input inputMode="numeric" value={buyQty} onChange={(e) => setBuyQty(e.target.value)} />
            </Field>
          )}
          {kind === 'x_for_y' && (
            <Field label="Articles payés">
              <input inputMode="numeric" value={payQty} onChange={(e) => setPayQty(e.target.value)} />
            </Field>
          )}
          {kind === 'lot' && (
            <Field label="Prix du lot">
              <input inputMode="numeric" value={lotPrice} onChange={(e) => setLotPrice(e.target.value)} placeholder="FCFA TTC" />
            </Field>
          )}
          <Field label="Du">
            <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Au (inclus)">
            <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
          <Field label="Magasin">
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              <option value="">Tous les magasins</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nom affiché sur le ticket">
            <input value={name} placeholder={suggested} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        {saving !== null && saving !== undefined && saving > 0 && (
          <p className="muted">
            Le client économise {fcfa(saving)} {kind === 'price' ? `par ${article?.unit === 'piece' ? 'article' : article?.unit === 'kg' ? 'kg' : 'litre'}` : `par lot de ${n}`}.
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button className="primary">Enregistrer</button>
        </div>
      </form>
    </Modal>
  );
}
