import type { Entry, SpotifyTrack, Track } from './types';
import { normalize } from './library';
const markers = [
  'live',
  'remix',
  'acoustic',
  'instrumental',
  'demo',
  'remaster',
  'edit',
  'karaoke',
  'sped up',
  'slowed',
  'mono',
  'stereo',
];
export function recording(title: string) {
  const n = normalize(title);
  const kinds = markers.filter((v) =>
    v === 'remaster' ? /\bremaster(?:ed)?\b/.test(n) : new RegExp(`\\b${v}\\b`).test(n),
  );
  const detail = normalize(title.match(/(?:\(|\[| - )([^\])]+)[\])]?\s*$/)?.[1] || '');
  const base = normalize(
    title
      .replace(/\([^)]*\)|\[[^\]]*\]/g, (m) =>
        markers.some((k) => normalize(m).includes(k)) ? '' : m,
      )
      .replace(
        /\s+-\s+.*(?:live|remix|remaster|acoustic|edit|demo|instrumental|sped|slowed).*$/i,
        '',
      ),
  );
  return { base, kinds, detail };
}
function similarity(a: string, b: string) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const aw = new Set(a.split(' ')),
    bw = new Set(b.split(' '));
  return (2 * [...aw].filter((v) => bw.has(v)).length) / (aw.size + bw.size);
}
export function rankTrack(remote: SpotifyTrack, local: Track) {
  const a = recording(remote.name),
    b = recording(local.title);
  const title = similarity(a.base, b.base);
  const remoteArtists = remote.artists.map((a) => normalize(a.name));
  const localArtist = normalize(local.artist);
  const artist = Math.max(...remoteArtists.map((a) => similarity(a, localArtist)), 0);
  const seconds = remote.duration_ms / 1000;
  const delta = Math.abs(seconds - local.duration);
  const duration = local.duration > 0 && seconds > 0 ? Math.max(0, 1 - delta / 12) : 0.5;
  const kindsA = a.kinds.filter((v) => v !== 'remaster'),
    kindsB = b.kinds.filter((v) => v !== 'remaster');
  const conflict = kindsA.join('|') !== kindsB.join('|');
  const detailConflict = (kindsA.length > 0 || kindsB.length > 0) && a.detail !== b.detail;
  const remasterMismatch = a.kinds.includes('remaster') !== b.kinds.includes('remaster');
  let score = title * 0.58 + artist * 0.28 + duration * 0.14;
  if (conflict) score -= 0.45;
  if (detailConflict) score -= 0.12;
  if (remasterMismatch) score -= 0.07;
  if (local.missing) score = 0;
  const reason = conflict
    ? 'Different recording version'
    : detailConflict
      ? 'Check version details'
      : remasterMismatch
        ? 'Remaster differs'
        : delta > 3
          ? `Duration differs by ${Math.round(delta)}s`
          : title < 1
            ? 'Title differs'
            : artist < 1
              ? 'Artist credit differs'
              : 'Title, artist and duration agree';
  return { id: local.id, score: Math.max(0, score), reason };
}
export function matchTracks(remote: SpotifyTrack[], local: Track[]): Entry[] {
  return remote.map((r) => {
    const candidates = local
      .filter((t) => !t.missing)
      .map((t) => rankTrack(r, t))
      .filter((c) => c.score >= 0.55)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    const top = candidates[0];
    const confident =
      !!top && top.score >= 0.96 && (!candidates[1] || top.score - candidates[1].score >= 0.035);
    return {
      spotifyId: r.id,
      title: r.name,
      artist: r.artists.map((a) => a.name).join(', '),
      duration: r.duration_ms / 1000,
      trackId: confident ? top.id : null,
      status: confident ? 'available' : top ? 'uncertain' : 'missing',
      candidates,
    };
  });
}
