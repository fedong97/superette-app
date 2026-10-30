/**
 * Petit réseau qui lit un chiffre écrit à la main (image 28 × 28, encre = 1),
 * calculé entièrement sur le PC, sans internet ni service extérieur.
 * Deux convolutions 3 × 3 (16 puis 32 filtres, chacune suivie d'un
 * regroupement 2 × 2), puis 64 neurones et 10 sorties. Poids appris sur les
 * chiffres manuscrits MNIST (licence CC BY-SA 3.0), avec des déformations
 * (inclinaison, épaisseur du trait, encre pâle), et rangés en entiers sur 8 bits.
 */
import { DIGIT_WEIGHTS } from './digitWeights';

interface Layer {
  shape: number[];
  data: Float32Array;
}

function decode(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const B = (globalThis as unknown as { Buffer: { from(s: string, enc: string): Uint8Array } }).Buffer;
  return new Uint8Array(B.from(b64, 'base64'));
}

let layers: Record<string, Layer> | null = null;

function load(): Record<string, Layer> {
  if (layers) return layers;
  const out: Record<string, Layer> = {};
  for (const [k, l] of Object.entries(DIGIT_WEIGHTS.layers)) {
    if ('q' in l) {
      const bytes = decode(l.q);
      const q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
      const data = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) data[i] = q[i]! * l.scale;
      out[k] = { shape: l.shape, data };
    } else {
      const bytes = decode(l.f);
      const copy = new Uint8Array(bytes); // alignement sur 4 octets
      out[k] = { shape: l.shape, data: new Float32Array(copy.buffer) };
    }
  }
  layers = out;
  return out;
}

/** Convolution 3 × 3 avec bord à zéro, puis ReLU. */
function conv(input: Float32Array, cin: number, size: number, w: Layer, b: Layer): Float32Array {
  const cout = w.shape[0]!;
  const out = new Float32Array(cout * size * size);
  for (let o = 0; o < cout; o++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = b.data[o]!;
        for (let c = 0; c < cin; c++) {
          const wo = ((o * cin + c) * 3) * 3;
          const io = c * size * size;
          for (let ky = 0; ky < 3; ky++) {
            const yy = y + ky - 1;
            if (yy < 0 || yy >= size) continue;
            for (let kx = 0; kx < 3; kx++) {
              const xx = x + kx - 1;
              if (xx < 0 || xx >= size) continue;
              s += w.data[wo + ky * 3 + kx]! * input[io + yy * size + xx]!;
            }
          }
        }
        out[(o * size + y) * size + x] = s > 0 ? s : 0;
      }
    }
  }
  return out;
}

function pool(input: Float32Array, ch: number, size: number): Float32Array {
  const half = size / 2;
  const out = new Float32Array(ch * half * half);
  for (let c = 0; c < ch; c++) {
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const i = c * size * size + 2 * y * size + 2 * x;
        out[(c * half + y) * half + x] = Math.max(input[i]!, input[i + 1]!, input[i + size]!, input[i + size + 1]!);
      }
    }
  }
  return out;
}

function dense(input: Float32Array, w: Layer, b: Layer, relu: boolean): Float32Array {
  const [n, m] = w.shape as [number, number];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = b.data[i]!;
    const o = i * m;
    for (let j = 0; j < m; j++) s += w.data[o + j]! * input[j]!;
    out[i] = relu && s < 0 ? 0 : s;
  }
  return out;
}

/** Sorties brutes du réseau pour une image 28 × 28 (ligne par ligne, encre = 1). */
export function digitLogits(img: Float32Array): Float32Array {
  const L = load();
  let x = conv(img, 1, 28, L['c1.weight']!, L['c1.bias']!);
  x = pool(x, 16, 28);
  x = conv(x, 16, 14, L['c2.weight']!, L['c2.bias']!);
  x = pool(x, 32, 14);
  x = dense(x, L['f1.weight']!, L['f1.bias']!, true);
  return dense(x, L['f2.weight']!, L['f2.bias']!, false);
}

/** Probabilité de chaque chiffre 0 à 9. */
export function readDigit(img: Float32Array): number[] {
  const z = digitLogits(img);
  const max = Math.max(...z);
  const e = Array.from(z, (v) => Math.exp(v - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}
