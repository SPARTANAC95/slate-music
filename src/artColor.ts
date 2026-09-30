import { useEffect, useState } from 'react';

function hsl(r: number, g: number, b: number): [number, number, number] {
  (r /= 255), (g /= 255), (b /= 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min,
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
/** The cover's most prominent colour, adjusted to read well on Slate's dark background, as
 * an `hsl()` string. Null for black-and-white or very muted covers. Takes RGBA pixel data. */
export function pickAccent(rgba: ArrayLike<number>): string | null {
  const buckets = Array.from({ length: 12 }, () => ({ weight: 0, hue: 0, sat: 0 }));
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const [h, s, l] = hsl(rgba[i], rgba[i + 1], rgba[i + 2]);
    // Vivid mid-tones count most; greys, near-black and near-white barely count.
    const weight = s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.8);
    total += 1;
    const b = buckets[Math.floor(h / 30) % 12];
    b.weight += weight;
    b.hue += h * weight;
    b.sat += s * weight;
  }
  const best = buckets.reduce((a, b) => (b.weight > a.weight ? b : a));
  if (!total || best.weight / total < 0.04) return null;
  const hue = Math.round(best.hue / best.weight);
  const sat = Math.round(Math.min(0.62, Math.max(0.3, best.sat / best.weight)) * 100);
  return `hsl(${hue} ${sat}% 70%)`;
}

const colors = new Map<string, string | null>();
/** The accent colour of an album cover (see pickAccent), cached per cover. */
export function useArtColor(hash?: string | null): string | null {
  const [color, setColor] = useState<string | null>(hash ? colors.get(hash) ?? null : null);
  useEffect(() => {
    if (!hash) return setColor(null);
    if (colors.has(hash)) return setColor(colors.get(hash)!);
    let live = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, 32, 32);
        const accent = pickAccent(ctx.getImageData(0, 0, 32, 32).data);
        colors.set(hash, accent);
        if (live) setColor(accent);
      } catch {
        colors.set(hash, null);
      }
    };
    img.src = `http://art.localhost/${hash}`;
    return () => {
      live = false;
    };
  }, [hash]);
  return color;
}
