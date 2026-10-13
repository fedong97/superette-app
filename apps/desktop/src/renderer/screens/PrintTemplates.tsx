import {
  BUILTIN_TEMPLATES,
  DOC_COLUMNS,
  DOC_FONTS,
  DOC_FORMATS,
  DOC_KIND_VARIANTS,
  DOC_KINDS,
  DOC_PAPERS,
  DOC_STYLES,
  stylesFor,
  DOC_VARIANTS,
  type DocColumn,
  type DocData,
  type DocFormat,
  type DocKind,
  type DocTemplate,
  type DocVariant,
  renderDocHtml,
  slotKey,
} from '@superette/core';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { type Result, call } from '../api';
import { askConfirm, Empty, Field, Modal, useLoad, useToast } from '../ui';
import { DocFrame, ZOOMS } from './docPreview';

type User = NonNullable<Result<'app.state'>['user']>;
type Templates = Result<'docs.templates'>;

const newId = () => `tpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isDefault = (data: Templates, t: DocTemplate) => {
  const want = data.defaults[slotKey(t.doc, t.format, t.variant)];
  const builtin = BUILTIN_TEMPLATES.find((b) => b.doc === t.doc && b.format === t.format && b.variant === t.variant)!;
  return want ? want === t.id && data.templates.some((x) => x.id === want) : t.id === builtin.id;
};

/**
 * Modèles d'impression (Administration › Modèles d'impression), comme le
 * « Paramétrage des variantes des états » de Sage ou KONTROL : une ligne par
 * modèle, un éditeur champ par champ avec l'aperçu à côté.
 */
export function PrintTemplates({ user, initialEdit }: { user: User; initialEdit?: string | null }) {
  const toast = useToast();
  const list = useLoad(() => call('docs.templates'));
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<DocTemplate | null>(null);
  const [preview, setPreview] = useState<DocTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const canEdit = user.rights.includes('print_templates');
  const data = list.data;
  // Ouvert depuis Paramètres : l'éditeur du modèle choisi s'ouvre directement.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!data || opened || !initialEdit) return;
    setOpened(true);
    const t = data.templates.find((x) => x.id === initialEdit);
    if (t && canEdit) setEditing(structuredClone(t));
    if (t) setSelected(t.id);
  }, [data, opened, initialEdit, canEdit]);
  if (!data) return null;
  const sel = data.templates.find((t) => t.id === selected) ?? null;

  /** Modèles enregistrés par le magasin après un changement. */
  const stored = () => data.templates.filter((t) => data.stored.includes(t.id));
  const save = async (templates: DocTemplate[], defaults: Record<string, string>, message: string) => {
    try {
      await call('docs.saveTemplates', templates, defaults);
      list.reload();
      toast.ok(message);
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    }
  };
  const saveTemplate = async (t: DocTemplate) => {
    const others = stored().filter((x) => x.id !== t.id);
    if (await save([...others, t], data.defaults, 'Modèle enregistré')) {
      setEditing(null);
      setSelected(t.id);
    }
  };
  const makeDefault = (t: DocTemplate) => save(stored(), { ...data.defaults, [slotKey(t.doc, t.format, t.variant)]: t.id }, `« ${t.name} » est le modèle par défaut`);
  const remove = async (t: DocTemplate) => {
    if (!(await askConfirm(t.builtin ? `Rétablir « ${t.name} » tel qu'il est livré avec le logiciel ?` : `Supprimer le modèle « ${t.name} » ?`))) return;
    const defaults = { ...data.defaults };
    const slot = slotKey(t.doc, t.format, t.variant);
    if (!t.builtin && defaults[slot] === t.id) delete defaults[slot];
    void save(
      stored().filter((x) => x.id !== t.id),
      defaults,
      t.builtin ? 'Modèle rétabli' : 'Modèle supprimé',
    );
  };
  const copy = (t: DocTemplate): DocTemplate => ({ ...structuredClone(t), id: newId(), builtin: false, name: `${t.name} (copie)` });

  if (editing) return <TemplateEditor template={editing} canEdit={canEdit} onCancel={() => setEditing(null)} onSave={saveTemplate} />;

  return (
    <div className="templates">
      <p className="muted">
        Chaque document s'imprime avec le modèle par défaut de son format et de sa variante. Modifiez un modèle champ par champ, ou copiez-le pour en créer un autre ; l'aperçu
        avant impression permet de choisir un autre modèle au moment d'imprimer.
      </p>
      <div className="templates-layout">
        <table className="list compact">
          <thead>
            <tr>
              <th>Document</th>
              <th>Format</th>
              <th>Variante</th>
              <th>Nom du modèle</th>
              <th>Papier</th>
              <th>Par défaut</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.templates.map((t) => (
              <tr key={t.id} className={`clickable ${t.id === selected ? 'selected' : ''}`} onClick={() => setSelected(t.id)} onDoubleClick={() => canEdit && setEditing(structuredClone(t))}>
                <td>{DOC_KINDS[t.doc]}</td>
                <td>{DOC_FORMATS[t.format]}</td>
                <td>{DOC_VARIANTS[t.variant]}</td>
                <td>{t.name}</td>
                <td>{DOC_PAPERS[t.page.paper]}</td>
                <td>{isDefault(data, t) ? '✔' : ''}</td>
                <td className="muted">{t.builtin ? (data.stored.includes(t.id) ? 'modifié' : 'd’origine') : 'ajouté'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="side-buttons">
          <button disabled={!canEdit} onClick={() => setCreating(true)}>
            Nouveau…
          </button>
          <button disabled={!sel} onClick={() => sel && setPreview(sel)}>
            Aperçu
          </button>
          <button className="primary" disabled={!sel || !canEdit} onClick={() => sel && setEditing(structuredClone(sel))}>
            Modifier
          </button>
          <button disabled={!sel || !canEdit} onClick={() => sel && setEditing(copy(sel))}>
            Copier
          </button>
          <button disabled={!sel || !canEdit || isDefault(data, sel)} onClick={() => sel && makeDefault(sel)}>
            Par défaut
          </button>
          <button disabled={!sel || !canEdit || (sel.builtin && !data.stored.includes(sel.id))} onClick={() => sel && remove(sel)}>
            {sel?.builtin ? 'Rétablir l’original' : 'Supprimer'}
          </button>
          {!canEdit && <small className="muted">Droit « Modifier les modèles d'impression » nécessaire pour les changer.</small>}
        </div>
      </div>
      {preview && (
        <Modal title={`Aperçu · ${preview.name}`} onClose={() => setPreview(null)} wide>
          <LivePreview template={preview} />
        </Modal>
      )}
      {creating && (
        <NewTemplate
          templates={data.templates}
          onClose={() => setCreating(false)}
          onCreate={(base) => {
            setCreating(false);
            setEditing(copy(base));
          }}
        />
      )}
    </div>
  );
}

/** Nouveau modèle : on choisit le format et la variante, puis le modèle de départ. */
function NewTemplate({ templates, onClose, onCreate }: { templates: DocTemplate[]; onClose: () => void; onCreate: (base: DocTemplate) => void }) {
  const [doc, setDoc] = useState<DocKind>('invoice');
  const [format, setFormat] = useState<DocFormat>('a4');
  const [variant, setVariant] = useState<DocVariant>('cash');
  const bases = templates.filter((t) => t.doc === doc && t.format === format && t.variant === variant);
  const [base, setBase] = useState('');
  const chosen = bases.find((t) => t.id === base) ?? bases[0];
  return (
    <Modal title="Nouveau modèle" onClose={onClose}>
      <Field label="Document">
        <select
          value={doc}
          onChange={(e) => {
            const d = e.target.value as DocKind;
            setDoc(d);
            setVariant(DOC_KIND_VARIANTS[d][0]!);
            setBase('');
          }}
        >
          {Object.entries(DOC_KINDS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid2">
        <Field label="Format">
          <select value={format} onChange={(e) => (setFormat(e.target.value as DocFormat), setBase(''))}>
            {Object.entries(DOC_FORMATS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Variante">
          <select value={variant} onChange={(e) => (setVariant(e.target.value as DocVariant), setBase(''))}>
            {DOC_KIND_VARIANTS[doc].map((k) => (
              <option key={k} value={k}>
                {DOC_VARIANTS[k]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Partir du modèle">
        <select value={chosen?.id ?? ''} onChange={(e) => setBase(e.target.value)}>
          {bases.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="actions">
        <button className="ghost" onClick={onClose}>
          Annuler
        </button>
        <button className="primary" disabled={!chosen} onClick={() => chosen && onCreate(chosen)}>
          Créer et modifier
        </button>
      </div>
    </Modal>
  );
}

/** Document servant à l'aperçu : la dernière pièce de la variante, sinon un exemple. */
function useSample(variant: DocVariant) {
  const [sample, setSample] = useState<{ real: boolean; number: string | null; data: DocData } | null>(null);
  useEffect(() => {
    call('docs.sample', variant).then(setSample, () => setSample(null));
  }, [variant]);
  return sample;
}

function LivePreview({ template }: { template: DocTemplate }) {
  const sample = useSample(template.variant);
  const [zoom, setZoom] = useState(template.format === 'ticket' ? 1 : 0.75);
  const [duplicate, setDuplicate] = useState(false);
  const html = useMemo(
    () => (sample ? renderDocHtml(template, { ...sample.data, doc: { ...sample.data.doc, duplicate } }) : ''),
    [template, sample, duplicate],
  );
  if (!sample) return <Empty>Préparation de l'aperçu…</Empty>;
  return (
    <div className="live-preview">
      <div className="toolbar">
        <span className="muted">{sample.real ? `Aperçu avec la pièce ${sample.number}` : 'Aperçu avec un document d’exemple'}</span>
        <span className="spacer" />
        <label className="inline">
          <input type="checkbox" checked={duplicate} onChange={(e) => setDuplicate(e.target.checked)} /> Réimpression
        </label>
        <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
          {ZOOMS.map(([z, l]) => (
            <option key={z} value={z}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <DocFrame html={html} zoom={zoom} height="74vh" />
    </div>
  );
}

/** Une case à cocher avec son libellé. */
function Check({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="tpl-check">
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function Section({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="tpl-section" open={open}>
      <summary>{title}</summary>
      <div className="tpl-body">{children}</div>
    </details>
  );
}

function NumberInput({ value, onChange, suffix, disabled }: { value: number; onChange: (v: number) => void; suffix?: string; disabled?: boolean }) {
  return (
    <span className="inline">
      <input className="qty" inputMode="numeric" disabled={disabled} value={String(value)} onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, '') || 0))} />
      {suffix && <span className="muted">{suffix}</span>}
    </span>
  );
}

/** Éditeur d'un modèle : réglages à gauche, aperçu en direct à droite. */
function TemplateEditor({ template, canEdit, onCancel, onSave }: { template: DocTemplate; canEdit: boolean; onCancel: () => void; onSave: (t: DocTemplate) => void }) {
  const [t, setT] = useState<DocTemplate>(template);
  const ticket = t.format === 'ticket';
  const off = !canEdit;
  const set = <K extends keyof DocTemplate>(k: K, patch: Partial<DocTemplate[K]>) => setT((cur) => ({ ...cur, [k]: { ...(cur[k] as object), ...patch } }));
  const check = <K extends 'header' | 'customer' | 'info' | 'totals' | 'footer'>(k: K, field: keyof DocTemplate[K], label: string) => (
    <Check label={label} disabled={off} value={Boolean(t[k][field])} onChange={(v) => set(k, { [field]: v } as Partial<DocTemplate[K]>)} />
  );
  const setColumn = (i: number, patch: Partial<DocColumn>) => setT((cur) => ({ ...cur, columns: cur.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const move = (i: number, by: number) =>
    setT((cur) => {
      const cols = [...cur.columns];
      const j = i + by;
      if (j < 0 || j >= cols.length) return cur;
      [cols[i], cols[j]] = [cols[j]!, cols[i]!];
      return { ...cur, columns: cols };
    });
  const papers = (Object.keys(DOC_PAPERS) as (keyof typeof DOC_PAPERS)[]).filter((p) => (ticket ? p.endsWith('mm') : !p.endsWith('mm')));
  const widthSum = t.columns.filter((c) => c.show && c.width).reduce((s, c) => s + c.width, 0);

  return (
    <div className="tpl-editor">
      <div className="filters sticky-actions">
        <strong>
          {DOC_KINDS[t.doc]} · {DOC_FORMATS[t.format]} · {DOC_VARIANTS[t.variant]}
        </strong>
        <span className="spacer" />
        <button className="ghost" onClick={onCancel}>
          Annuler
        </button>
        <button className="primary" disabled={off || !t.name.trim()} onClick={() => onSave({ ...t, name: t.name.trim() })}>
          Enregistrer le modèle
        </button>
      </div>
      <div className="tpl-split">
        <div className="tpl-form">
          <Field label="Nom du modèle">
            <input disabled={off} value={t.name} maxLength={60} onChange={(e) => setT({ ...t, name: e.target.value })} />
          </Field>

          <Section title="Page et mise en page" open>
            <div className="grid2">
              <Field label="Papier">
                <select disabled={off} value={t.page.paper} onChange={(e) => set('page', { paper: e.target.value as DocTemplate['page']['paper'] })}>
                  {papers.map((p) => (
                    <option key={p} value={p}>
                      {DOC_PAPERS[p]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Disposition" hint={ticket ? 'Encadré : nom du produit sur sa ligne, puis QTE / COND. / P.U. / TOTAL. Détaillé : colonne code et détail des taxes.' : 'Listing : cadre, cases DATE / CLIENT / RÉF., montant en lettres, NB COLIS et NET À PAYER'}>
                <select disabled={off} value={t.page.style} onChange={(e) => set('page', { style: e.target.value as DocTemplate['page']['style'] })}>
                  {stylesFor(t.format).map((k) => (
                    <option key={k} value={k}>
                      {DOC_STYLES[k]}
                    </option>
                  ))}
                </select>
              </Field>
              {!ticket && (
                <Field label="Orientation">
                  <select disabled={off} value={t.page.landscape ? '1' : '0'} onChange={(e) => set('page', { landscape: e.target.value === '1' })}>
                    <option value="0">Portrait</option>
                    <option value="1">Paysage</option>
                  </select>
                </Field>
              )}
              <Field label="Police">
                <select disabled={off} value={t.page.font} onChange={(e) => set('page', { font: e.target.value as DocTemplate['page']['font'] })}>
                  {Object.entries(DOC_FONTS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Taille du texte">
                <NumberInput disabled={off} value={t.page.fontSize} onChange={(v) => set('page', { fontSize: v })} suffix="(7 à 20)" />
              </Field>
              <Field label="Marges">
                <NumberInput disabled={off} value={t.page.margin} onChange={(v) => set('page', { margin: v })} suffix="mm" />
              </Field>
              <Field label="Exemplaires">
                <NumberInput disabled={off} value={t.page.copies} onChange={(v) => set('page', { copies: v })} suffix="(1 à 5)" />
              </Field>
              {!ticket && (
                <>
                  <Field label="Hauteur de l'en-tête" hint="0 : selon le contenu">
                    <NumberInput disabled={off} value={t.page.headerHeight} onChange={(v) => set('page', { headerHeight: v })} suffix="mm" />
                  </Field>
                  <Field label="Hauteur du pied" hint="0 : selon le contenu">
                    <NumberInput disabled={off} value={t.page.footerHeight} onChange={(v) => set('page', { footerHeight: v })} suffix="mm" />
                  </Field>
                  <Field label="Hauteur des lignes du tableau" hint="0 : selon le contenu">
                    <NumberInput disabled={off} value={t.page.lineHeight} onChange={(v) => set('page', { lineHeight: v })} suffix="mm" />
                  </Field>
                  <Field label="Cadres du tableau">
                    <select disabled={off} value={t.page.borders ? '1' : '0'} onChange={(e) => set('page', { borders: e.target.value === '1' })}>
                      <option value="1">Avec cadres</option>
                      <option value="0">Sans cadres</option>
                    </select>
                  </Field>
                </>
              )}
            </div>
          </Section>

          <Section title="En-tête : le magasin">
            <div className="checks">
              {check('header', 'logo', 'Logo')}
              {check('header', 'storeName', 'Nom du magasin')}
              {check('header', 'address', 'Adresse')}
              {check('header', 'phone', 'Téléphone')}
              {check('header', 'niu', 'NIU')}
              {check('header', 'rccm', 'RCCM')}
            </div>
            <div className="grid2">
              <Field label="Hauteur du logo">
                <NumberInput disabled={off} value={t.header.logoSize} onChange={(v) => set('header', { logoSize: v })} suffix="mm" />
              </Field>
              {!ticket && (
                <Field label="Position du logo">
                  <select disabled={off} value={t.header.logoAlign} onChange={(e) => set('header', { logoAlign: e.target.value as DocTemplate['header']['logoAlign'] })}>
                    <option value="left">À gauche, à côté du nom</option>
                    <option value="center">Au centre, au-dessus</option>
                    <option value="right">À droite, au-dessus</option>
                  </select>
                </Field>
              )}
            </div>
            <Field label="Message libre" hint="Sous l'identité du magasin. Repères possibles : {magasin}, {client}, {numero}, {date}, {echeance}">
              <textarea disabled={off} rows={2} maxLength={300} value={t.header.message} onChange={(e) => set('header', { message: e.target.value })} />
            </Field>
          </Section>

          <Section title="Client">
            <div className="checks">
              {check('customer', 'show', 'Afficher le client')}
              {check('customer', 'code', 'Code du compte')}
              {check('customer', 'address', 'Adresse')}
              {check('customer', 'phone', 'Téléphone')}
              {check('customer', 'niu', 'NIU')}
              {check('customer', 'balance', 'Solde du compte')}
            </div>
          </Section>

          <Section title="Informations du document">
            <Field label="Titre" hint={ticket ? 'Vide : « Ticket » suivi du numéro' : 'Par exemple « Facture » ou « Facture à terme »'}>
              <input disabled={off} maxLength={60} value={t.info.title} onChange={(e) => set('info', { title: e.target.value })} />
            </Field>
            <div className="checks">
              {check('info', 'number', 'Numéro')}
              {check('info', 'date', 'Date')}
              {check('info', 'time', 'Heure')}
              {check('info', 'seller', 'Vendeur ou établi par')}
              {check('info', 'register', 'Caisse')}
              {check('info', 'priceLevel', 'Tarif (gros, super gros)')}
              {check('info', 'dueDate', 'Échéance')}
              {check('info', 'validUntil', 'Validité ou livraison souhaitée')}
            </div>
          </Section>

          <Section title="Colonnes du tableau" open>
            <table className="list compact tpl-columns">
              <thead>
                <tr>
                  <th>Afficher</th>
                  <th>Colonne</th>
                  <th>Titre imprimé</th>
                  {!ticket && <th>Largeur</th>}
                  <th>Ordre</th>
                </tr>
              </thead>
              <tbody>
                {t.columns.map((c, i) => (
                  <tr key={c.key} className={c.show ? '' : 'inactive'}>
                    <td>
                      <input type="checkbox" disabled={off} checked={c.show} onChange={(e) => setColumn(i, { show: e.target.checked })} />
                    </td>
                    <td>{DOC_COLUMNS[c.key]}</td>
                    <td>
                      <input disabled={off || (ticket && t.page.style === 'plain')} maxLength={40} value={c.label} onChange={(e) => setColumn(i, { label: e.target.value })} />
                    </td>
                    {!ticket && (
                      <td>
                        <NumberInput disabled={off} value={c.width} onChange={(v) => setColumn(i, { width: Math.min(100, v) })} suffix="%" />
                      </td>
                    )}
                    <td className="nowrap">
                      <button className="ghost" disabled={off || i === 0} onClick={() => move(i, -1)} aria-label="Monter">
                        ↑
                      </button>
                      <button className="ghost" disabled={off || i === t.columns.length - 1} onClick={() => move(i, 1)} aria-label="Descendre">
                        ↓
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <small className="muted">
              {ticket && t.page.style !== 'plain'
                ? 'Ticket encadré : la désignation est sur sa ligne, les autres colonnes cochées en dessous. Ticket détaillé : les colonnes cochées côte à côte.'
                : ticket
                ? 'Sur le ticket, la désignation et le total sont sur une ligne, la quantité, le prix et la remise en dessous.'
                : `Largeur 0 : la colonne prend la place restante. Total des largeurs fixées : ${widthSum} %${widthSum > 100 ? ' (trop large, les colonnes seront réduites)' : ''}.`}
            </small>
          </Section>

          <Section title="Totaux">
            <div className="checks">
              {check('totals', 'ttc', 'Total TTC')}
              {check('totals', 'ht', 'Total HT')}
              {check('totals', 'vatDetail', 'Partie TVA (détail, ou « TVA non applicable »)')}
              {check('totals', 'discount', 'Remises accordées')}
              {check('totals', 'promo', 'Promotions')}
              {check('totals', 'rounding', 'Arrondi espèces')}
              {check('totals', 'payments', 'Règlements')}
              {check('totals', 'change', 'Rendu monnaie')}
              {check('totals', 'remaining', 'Reste à payer')}
              {check('totals', 'words', 'Montant en lettres')}
              {check('totals', 'parcels', 'Nombre de colis')}
            </div>
            <small className="muted">Magasin sans TVA : la TVA et les mots HT / TTC disparaissent d’eux-mêmes. Décochez « Total HT » et « Partie TVA » pour ne rien afficher de la TVA.</small>
          </Section>

          <Section title="Pied du document">
            <Field label="Mentions" hint="Conditions de vente, coordonnées bancaires…">
              <textarea disabled={off} rows={3} maxLength={300} value={t.footer.text} onChange={(e) => set('footer', { text: e.target.value })} />
            </Field>
            {(t.page.style === 'framed' || t.page.style === 'side') && (
              <Field label="Remarque" hint="À gauche du montant en lettres">
                <input disabled={off} maxLength={300} value={t.footer.remark} onChange={(e) => set('footer', { remark: e.target.value })} />
              </Field>
            )}
            <Field label={t.page.style === 'framed' || t.page.style === 'side' ? 'Slogan' : 'Message de remerciement'} hint={ticket ? 'Vide : le pied de ticket des paramètres' : t.page.style === 'framed' || t.page.style === 'side' ? 'En gras, centré au-dessus des mentions, par exemple « {magasin} : la qualité d’abord !!! »' : undefined}>
              <input disabled={off} maxLength={300} value={t.footer.thanks} onChange={(e) => set('footer', { thanks: e.target.value })} />
            </Field>
            <div className="checks">
              {check('footer', 'signatures', 'Zones de signature')}
              {check('footer', 'duplicate', '« DUPLICATA » sur les réimpressions')}
            </div>
            {t.footer.signatures && (
              <div className="grid2">
                <Field label="Signature à gauche">
                  <input disabled={off} maxLength={300} value={t.footer.signLeft} onChange={(e) => set('footer', { signLeft: e.target.value })} />
                </Field>
                <Field label="Signature à droite">
                  <input disabled={off} maxLength={300} value={t.footer.signRight} onChange={(e) => set('footer', { signRight: e.target.value })} />
                </Field>
                <Field label="3e signature" hint="Vide : pas de zone">
                  <input disabled={off} maxLength={300} value={t.footer.sign3 ?? ''} onChange={(e) => set('footer', { sign3: e.target.value })} />
                </Field>
                <Field label="4e signature" hint="Vide : pas de zone">
                  <input disabled={off} maxLength={300} value={t.footer.sign4 ?? ''} onChange={(e) => set('footer', { sign4: e.target.value })} />
                </Field>
              </div>
            )}
          </Section>
        </div>
        <div className="tpl-preview">
          <LivePreview template={t} />
        </div>
      </div>
    </div>
  );
}
