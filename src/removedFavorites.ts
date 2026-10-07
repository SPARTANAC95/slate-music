/** Hearts taken off songs lately, remembered on this PC (WebView storage) so a slip can be put
 * right: one click on the Favorites page can unfavorite every song picked. */
const KEY = 'slate-music.removedFavorites';
/** How long a removed heart can be restored. */
export const KEEP_DAYS = 30;
const KEEP_MS = KEEP_DAYS * 24 * 3600 * 1000;
/** Songs remembered at most; the oldest are forgotten first. */
const MOST = 5000;

interface Removed {
  id: string;
  at: number;
}
function load(now: number): Removed[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    // Anything unknown or damaged is ignored.
    return (Array.isArray(saved) ? saved : []).filter(
      (r): r is Removed => !!r && typeof r.id === 'string' && typeof r.at === 'number' && now - r.at < KEEP_MS,
    );
  } catch {
    return [];
  }
}
function save(list: Removed[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MOST)));
  } catch {
    // Storage full or unavailable: the hearts can still be undone from the message.
  }
}
/** The songs whose hearts were removed in the last 30 days, oldest first. */
export const removedFavorites = (now = Date.now()) => load(now).map((r) => r.id);
/** Remembers that these songs just lost their hearts. */
export function rememberRemoved(ids: string[], now = Date.now()) {
  const gone = new Set(ids);
  save([...load(now).filter((r) => !gone.has(r.id)), ...ids.map((id) => ({ id, at: now }))]);
}
/** Forgets songs that have their hearts again, or that you chose not to restore. */
export function forgetRemoved(ids: string[], now = Date.now()) {
  const back = new Set(ids);
  save(load(now).filter((r) => !back.has(r.id)));
}
