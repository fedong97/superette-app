import {
  BADGE_MODELS,
  BADGE_PARTS,
  BADGE_SIZES,
  badgeIsPortrait,
  BRAND_PRESETS,
  type BadgeLayout,
  DEFAULT_BRAND_COLOR,
  DEFAULT_BRAND_COLOR2,
  brandPalette,
  contrast,
  isHexColor,
} from '@superette/core';
import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { applyBrand } from '../theme';
import { Field, Modal, useLoad, useToast } from '../ui';

/** Photo d'identité recadrée au format 3 × 4 (300 × 400 points), en JPEG : elle reste légère. */
function portrait(source: CanvasImageSource, w: number, h: number): string {
  const ratio = 3 / 4;
  const [sw, sh] = w / h > ratio ? [h * ratio, h] : [w, w / ratio];
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 400;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 300, 400);
  g.drawImage(source, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, 300, 400);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function readPortrait(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Image illisible'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Image illisible : choisissez une photo JPEG ou PNG'));
      img.onload = () => resolve(portrait(img, img.width, img.height));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** Prise de la photo avec la caméra du PC (webcam). */
function CameraDialog({ onClose, onTaken }: { onClose: () => void; onTaken: (photo: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let alive = true;
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: 1280, height: 720 }, audio: false })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
      })
      .catch(() => setError("Aucune caméra n'est disponible sur ce PC : importez plutôt une photo."));
    if (!navigator.mediaDevices) setError("Aucune caméra n'est disponible sur ce PC : importez plutôt une photo.");
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  const take = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    onTaken(portrait(v, v.videoWidth, v.videoHeight));
  };
  return (
    <Modal title="Prendre la photo" onClose={onClose}>
      {error ? (
        <p className="error">{error}</p>
      ) : (
        <div className="camera">
          <video ref={video} muted playsInline />
          <div className="camera-frame" />
        </div>
      )}
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={Boolean(error)} onClick={take}>
          📸 Prendre la photo
        </button>
      </div>
    </Modal>
  );
}

/** Photo de l'employé (fiche utilisateur) : importée ou prise avec la caméra, enregistrée tout de suite. */
export function UserPhotoField({ userId, canEdit }: { userId: string; canEdit: boolean }) {
  const toast = useToast();
  const photo = useLoad(() => call('admin.userPhoto', userId), [userId]);
  const [camera, setCamera] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const save = async (p: string | null) => {
    try {
      await call('admin.setUserPhoto', userId, p);
      photo.reload();
      toast.ok(p ? 'Photo enregistrée : elle sera sur son badge' : 'Photo retirée');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    // Pas de <label> autour : un clic sur la photo ne doit pas ouvrir la caméra.
    <div className="field">
      <span>Photo (badge)</span>
      <span className="user-photo">
        <span className="user-photo-box">{photo.data ? <img src={photo.data} alt="Photo de l'employé" /> : <span className="muted">Pas de photo</span>}</span>
        {canEdit && (
          <span className="user-photo-actions">
            <button type="button" onClick={() => setCamera(true)}>
              📷 Prendre une photo
            </button>
            <button type="button" onClick={() => input.current?.click()}>
              Importer…
            </button>
            {photo.data && (
              <button type="button" className="ghost danger" onClick={() => void save(null)}>
                Retirer
              </button>
            )}
          </span>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              await save(await readPortrait(f));
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      </span>
      {camera && (
        <CameraDialog
          onClose={() => setCamera(false)}
          onTaken={(p) => {
            setCamera(false);
            void save(p);
          }}
        />
      )}
    </div>
  );
}

/** Aperçu agrandi du badge, à sa taille réelle multipliée. */
function framed(html: string, zoom: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html{background:#e9ecef}body{margin:14px;zoom:${zoom};display:flex;justify-content:center}</style></head><body>${html}</body></html>`;
}

/**
 * Administration › Couleurs et badges : les couleurs de l'entreprise (tout
 * l'écran les suit aussitôt), le format et le contenu du badge du personnel,
 * avec l'aperçu d'un vrai badge ou d'un exemple.
 */
export function BrandAndBadge({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const settings = useLoad(() => call('admin.storeSettings'));
  const users = useLoad(() => call('admin.users'));
  const [color, setColor] = useState<string | null>(null);
  const [color2, setColor2] = useState<string | null>(null);
  const [layout, setLayout] = useState<BadgeLayout | null>(null);
  const [who, setWho] = useState<string>('');
  const [preview, setPreview] = useState('');
  const saved = settings.data;

  useEffect(() => {
    if (!saved) return;
    setColor(saved.brandColor);
    setColor2(saved.brandColor2);
    setLayout(saved.badge);
  }, [saved]);
  // Les couleurs essayées s'appliquent à tout l'écran ; en quittant sans enregistrer, on revient aux couleurs enregistrées.
  useEffect(() => {
    if (color && color2) applyBrand(color, color2);
  }, [color, color2]);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => () => applyBrand(savedRef.current?.brandColor, savedRef.current?.brandColor2), []);

  useEffect(() => {
    if (!layout || !color || !color2) return;
    const t = setTimeout(() => {
      call('admin.badgePreview', { userId: who || null, layout, color, color2 })
        .then((h) => setPreview(framed(h, layout.back ? 1.3 : badgeIsPortrait(layout) ? 1.6 : 2)))
        .catch(() => setPreview(''));
    }, 200);
    return () => clearTimeout(t);
  }, [layout, color, color2, who]);

  if (!saved || !layout || !color || !color2) return <p className="muted">Chargement…</p>;

  const dirtyColors = color !== saved.brandColor || color2 !== saved.brandColor2;
  const dirtyBadge = JSON.stringify(layout) !== JSON.stringify(saved.badge);
  const withBadge = (users.data ?? []).filter((u) => u.badge && u.active);
  const set = <K extends keyof BadgeLayout>(k: K, v: BadgeLayout[K]) => setLayout({ ...layout, [k]: v });
  const palette = brandPalette(color, color2);

  const save = async () => {
    try {
      await call('admin.saveStoreSettings', { brandColor: color, brandColor2: color2, badge: layout });
      settings.reload();
      onChanged();
      toast.ok('Couleurs et badge enregistrés pour toute l’entreprise');
    } catch (e) {
      toast.error(e);
    }
  };
  const print = async (ids: string[]) => {
    if (dirtyBadge || dirtyColors) await save();
    try {
      await call('admin.printBadge', ids.length === 1 ? ids[0]! : ids);
    } catch (e) {
      toast.error(e);
    }
  };

  const colorInput = (value: string, onChange: (v: string) => void) => (
    <span className="inline">
      <input type="color" value={value} disabled={!canEdit} onChange={(e) => onChange(e.target.value)} />
      <input
        className="hex"
        value={value}
        disabled={!canEdit}
        maxLength={7}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (isHexColor(v)) onChange(v.toLowerCase());
        }}
      />
    </span>
  );

  return (
    <div className="brand-page">
      <section className="card">
        <h3>Couleurs de l'entreprise</h3>
        <p className="muted">Toute l'application, les badges, les cartes de fidélité et les documents A4 prennent ces couleurs, sur tous les postes de l'entreprise.</p>
        <div className="brand-colors">
          <Field label="Couleur principale" hint="Boutons, onglets, bandeaux et menus">
            {colorInput(color, setColor)}
          </Field>
          <Field label="Couleur secondaire" hint="Dégradés et accents">
            {colorInput(color2, setColor2)}
          </Field>
        </div>
        {contrast(color, '#ffffff') < 3 && (
          <p className="warn">Couleur principale très claire : le texte posé dessus sera noir, et les titres prendront sa version foncée pour rester lisibles.</p>
        )}
        <div className="brand-presets">
          {BRAND_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              disabled={!canEdit}
              className={p.color === color && p.color2 === color2 ? 'on' : ''}
              onClick={() => {
                setColor(p.color);
                setColor2(p.color2);
              }}
            >
              <i style={{ background: `linear-gradient(135deg, ${p.color} 50%, ${p.color2} 50%)` }} />
              {p.name}
            </button>
          ))}
        </div>
        <div className="brand-sample" style={{ background: `linear-gradient(90deg, ${palette.deep}, ${palette.brand} 55%, ${palette.brand2})` }}>
          <b>Aperçu du bandeau</b>
          <button type="button" className="primary" style={{ background: palette.brand, color: palette.ink, borderColor: palette.ink }}>
            Bouton principal
          </button>
        </div>
        {canEdit && (color !== DEFAULT_BRAND_COLOR || color2 !== DEFAULT_BRAND_COLOR2) && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setColor(DEFAULT_BRAND_COLOR);
              setColor2(DEFAULT_BRAND_COLOR2);
            }}
          >
            Revenir au vert d'origine
          </button>
        )}
      </section>

      <section className="card">
        <h3>Badge du personnel</h3>
        <div className="badge-editor">
          <div className="badge-settings">
            <Field label="Modèle">
              <select value={layout.model} disabled={!canEdit} onChange={(e) => set('model', e.target.value as BadgeLayout['model'])}>
                {Object.entries(BADGE_MODELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Taille">
              <select value={layout.size} disabled={!canEdit} onChange={(e) => set('size', e.target.value as BadgeLayout['size'])}>
                {Object.entries(BADGE_SIZES).map(([k, s]) => (
                  <option key={k} value={k}>
                    {s.label}
                  </option>
                ))}
                <option value="custom">Format libre…</option>
              </select>
            </Field>
            {layout.size === 'custom' && (
              <span className="inline">
                <Field label="Largeur (mm)">
                  <input type="number" min={40} max={150} step={0.1} value={layout.width} disabled={!canEdit} onChange={(e) => set('width', Number(e.target.value) || 0)} />
                </Field>
                <Field label="Hauteur (mm)">
                  <input type="number" min={25} max={150} step={0.1} value={layout.height} disabled={!canEdit} onChange={(e) => set('height', Number(e.target.value) || 0)} />
                </Field>
              </span>
            )}
            {layout.model === 'band' && (
              <Field label="Sens">
                <span className="inline">
                  <label>
                    <input type="radio" checked={!layout.portrait} disabled={!canEdit} onChange={() => set('portrait', false)} /> Horizontal
                  </label>
                  <label>
                    <input type="radio" checked={layout.portrait} disabled={!canEdit} onChange={() => set('portrait', true)} /> Vertical (cordon)
                  </label>
                </span>
              </Field>
            )}
            <Field label="Titre sous le nom du magasin" hint="Par exemple « Badge du personnel » ; vide : pas de titre">
              <input value={layout.title} maxLength={40} disabled={!canEdit} onChange={(e) => set('title', e.target.value)} />
            </Field>
            <Field label="Éléments imprimés">
              <span className="badge-parts">
                {BADGE_PARTS.map(([k, label]) => (
                  <label key={k}>
                    <input type="checkbox" checked={Boolean(layout[k])} disabled={!canEdit} onChange={(e) => set(k, e.target.checked as never)} /> {label}
                  </label>
                ))}
              </span>
            </Field>
            {layout.showExpiry && (
              <Field label="Validité (mois)" hint="La date d'expiration est comptée à partir du jour de l'impression">
                <input type="number" min={1} max={120} value={layout.validityMonths} disabled={!canEdit} onChange={(e) => set('validityMonths', Math.round(Number(e.target.value)) || 1)} />
              </Field>
            )}
            <label className="inline">
              <input type="checkbox" checked={layout.back} disabled={!canEdit} onChange={(e) => set('back', e.target.checked)} /> Imprimer aussi le verso (à côté du recto, à plier ou à
              coller)
            </label>
            {layout.back && (
              <>
                <Field label="Titre du verso">
                  <input value={layout.backTitle} maxLength={40} disabled={!canEdit} onChange={(e) => set('backTitle', e.target.value)} />
                </Field>
                <Field label="Règles imprimées au verso" hint="Une règle par ligne, 5 au plus">
                  <textarea rows={4} value={layout.backText} disabled={!canEdit} onChange={(e) => set('backText', e.target.value.split('\n').slice(0, 5).join('\n'))} />
                </Field>
                <Field label="Sous la signature">
                  <input value={layout.signature} maxLength={40} disabled={!canEdit} onChange={(e) => set('signature', e.target.value)} />
                </Field>
              </>
            )}
            <p className="muted small">Le matricule et le poste, le téléphone et la date d'entrée viennent de la fiche collaborateur ; la photo se prend dans la fiche de l'utilisateur.</p>
          </div>
          <div className="badge-preview">
            <Field label="Aperçu">
              <select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Exemple</option>
                {withBadge.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
            {preview ? <iframe className="badge-frame" title="Aperçu du badge" sandbox="" srcDoc={preview} /> : <p className="muted">Aperçu indisponible</p>}
            <div className="inline">
              {who && <button onClick={() => void print([who])}>🖨 Imprimer ce badge</button>}
              {withBadge.length > 0 && <button onClick={() => void print(withBadge.map((u) => u.id))}>🖨 Imprimer tous les badges ({withBadge.length})</button>}
            </div>
          </div>
        </div>
      </section>

      {canEdit && (
        <div className="actions">
          <button
            disabled={!dirtyColors && !dirtyBadge}
            onClick={() => {
              setColor(saved.brandColor);
              setColor2(saved.brandColor2);
              setLayout(saved.badge);
            }}
          >
            Annuler les changements
          </button>
          <button className="primary" disabled={!dirtyColors && !dirtyBadge} onClick={() => void save()}>
            Enregistrer
          </button>
        </div>
      )}
    </div>
  );
}
