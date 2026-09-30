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
// Title parsing is the expensive part of ranking, so each side is prepared once per import
// rather than once per remote × local pair.
type Remote = { rec: ReturnType<typeof recording>; artists: string[]; album: string; seconds: number };
type Local = { track: Track; rec: ReturnType<typeof recording>; artist: string; album: string };
const prepareRemote = (r: SpotifyTrack): Remote => ({
  rec: recording(r.name),
  artists: r.artists.map((a) => normalize(a.name)),
  album: normalize(r.album || ''),
  seconds: r.duration_ms / 1000,
});
const prepareLocal = (t: Track): Local => ({
  track: t,
  rec: recording(t.title),
  artist: normalize(t.artist),
  album: normalize(t.album),
});
export const rankTrack = (remote: SpotifyTrack, local: Track) =>
  rank(prepareRemote(remote), prepareLocal(local));
function rank(r: Remote, l: Local) {
  const { rec: a, seconds } = r,
    { rec: b, track: local } = l;
  const title = similarity(a.base, b.base);
  const artist = Math.max(...r.artists.map((a) => similarity(a, l.artist)), 0);
  const delta = Math.abs(seconds - local.duration);
  const duration = local.duration > 0 && seconds > 0 ? Math.max(0, 1 - delta / 12) : 0.5;
  const kindsA = a.kinds.filter((v) => v !== 'remaster'),
    kindsB = b.kinds.filter((v) => v !== 'remaster');
  const conflict = kindsA.join('|') !== kindsB.join('|');
  const detailConflict = (a.kinds.length > 0 || b.kinds.length > 0) && a.detail !== b.detail;
  const remasterMismatch = a.kinds.includes('remaster') !== b.kinds.includes('remaster');
  let score = title * 0.58 + artist * 0.28 + duration * 0.14;
  // Playlists mix albums; the album name only breaks ties, e.g. album cut versus compilation.
  if (r.album && l.album) score += similarity(r.album, l.album) * 0.05;
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
  // A song sharing no title word scores at most 0.47, below the 0.55 candidate threshold, so
  // only songs found through a shared title word need ranking. This keeps large imports fast.
  const prepared = local.filter((t) => !t.missing).map(prepareLocal);
  const byWord = new Map<string, number[]>();
  prepared.forEach((l, i) => {
    for (const word of new Set(l.rec.base.split(' '))) {
      if (!word) continue;
      const list = byWord.get(word);
      if (list) list.push(i);
      else byWord.set(word, [i]);
    }
  });
  return remote.map((r) => {
    const features = prepareRemote(r);
    const nearby = new Set(features.rec.base.split(' ').flatMap((w) => byWord.get(w) || []));
    const candidates = [...nearby]
      .sort((a, b) => a - b)
      .map((i) => rank(features, prepared[i]))
      .filter((c) => c.score >= 0.55)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    const top = candidates[0];
    const confident =
      !!top && top.score >= 0.96 && (!candidates[1] || top.score - candidates[1].score >= 0.035);
    return {
      spotifyId: r.id ?? undefined,
      title: r.name,
      artist: r.artists.map((a) => a.name).join(', '),
      duration: r.duration_ms / 1000,
      trackId: confident ? top.id : null,
      status: confident ? 'available' : top ? 'uncertain' : 'missing',
      candidates,
    };
  });
}
/** After re-reading a playlist from Spotify, keep every song the user already matched. */
export function keepConfirmed(previous: Entry[], next: Entry[]): Entry[] {
  const confirmed = new Map(
    previous.flatMap((e): [string, string][] =>
      e.spotifyId && e.trackId && e.status === 'available' ? [[e.spotifyId, e.trackId]] : [],
    ),
  );
  return next.map((e) => {
    const trackId = e.spotifyId && confirmed.get(e.spotifyId);
    return trackId ? { ...e, trackId, status: 'available' } : e;
  });
}
