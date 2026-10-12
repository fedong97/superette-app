import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { useToast } from '../ui';

export interface ArticlePhoto {
  photo: string;
  thumb: string;
}

/** Image lue et réduite à `max` points au plus, en JPEG sur fond blanc. */
function shrink(img: HTMLImageElement, max: number, quality: number): string {
  const scale = Math.min(1, max / img.width, max / img.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Photo choisie sur l'ordinateur : environ 400 points pour la fiche, 96 pour les listes. */
export function readPhoto(file: File): Promise<ArticlePhoto> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Image illisible'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Image illisible : choisissez une photo JPEG ou PNG'));
      img.onload = () => resolve({ photo: shrink(img, 400, 0.82), thumb: shrink(img, 96, 0.75) });
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Zone « Photo » de la fiche article. `value` : undefined tant qu'on n'a rien
 * changé, null pour retirer la photo, sinon la nouvelle photo.
 */
export function PhotoField({ articleId, value, onChange }: { articleId: string | null; value: ArticlePhoto | null | undefined; onChange: (v: ArticlePhoto | null) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (articleId) call('catalogue.photo', articleId).then(setSaved).catch(() => setSaved(null));
  }, [articleId]);
  const shown = value === undefined ? saved : (value?.photo ?? null);
  return (
    <div className="photo-field">
      <div className="photo-box">{shown ? <img src={shown} alt="Photo de l'article" /> : <span className="muted">Pas de photo</span>}</div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            onChange(await readPhoto(file));
          } catch (err) {
            toast.error(err);
          }
        }}
      />
      <div className="inline">
        <button type="button" onClick={() => input.current?.click()}>
          {shown ? 'Changer…' : 'Choisir une image…'}
        </button>
        {shown && (
          <button type="button" className="ghost" onClick={() => onChange(null)}>
            Retirer
          </button>
        )}
      </div>
    </div>
  );
}

/** Photo d'un article chargée à la demande (fenêtre de recherche de la caisse). */
export function ArticlePhotoView({ articleId }: { articleId: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!articleId) return;
    let live = true;
    call('catalogue.photo', articleId)
      .then((p) => live && setSrc(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [articleId]);
  return <div className="photo-box">{src ? <img src={src} alt="" /> : <span className="muted">Pas de photo</span>}</div>;
}
