export interface Track {
  id: string;
  path: string;
  folder: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  year: number;
  track: number;
  disc: number;
  duration: number;
  format: string;
  sampleRate: number;
  bitDepth: number;
  artwork: string | null;
  favorite: boolean;
  missing: boolean;
  playCount: number;
  lastPlayed: number;
  added: number;
  size: number;
  /** Year the song was first released (tag or MusicBrainz); 0 when unknown. */
  originalYear: number;
}
export interface Playback {
  queue: string[];
  cursor: number;
  currentId: string | null;
  position: number;
  duration: number;
  playing: boolean;
  volume: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  crossfade: number;
  error: string | null;
  engineReady: boolean;
  /** Sleep timer deadline in Unix milliseconds. */
  sleepAt: number | null;
  sleepEndOfTrack: boolean;
}
export interface Entry {
  trackId: string | null;
  title: string;
  artist: string;
  duration: number;
  status: 'available' | 'uncertain' | 'missing';
  candidates?: { id: string; score: number; reason: string }[];
  spotifyId?: string;
  /** The user chose "Leave this song missing"; updates keep it unmatched. */
  rejected?: boolean;
}
export interface Collection {
  id: string;
  name: string;
  kind: 'playlist' | 'virtual';
  entries: Entry[];
  created: number;
  sourceUrl?: string;
  artist?: string;
  year?: number;
  /** Imported from Spotify: refresh when the app opens (default on). */
  autoUpdate?: boolean;
  /** Add songs to Favorites when they are matched (Liked Songs). */
  heartMatches?: boolean;
  /** Spotify's fingerprint of the contents when last read; unchanged sources are skipped. */
  revision?: string | null;
}
export interface Settings {
  autoCheck: boolean;
  autoDownload: boolean;
  showListening: boolean;
  /** Look up original release years on MusicBrainz. */
  lookupYears: boolean;
}
export interface Scan {
  scanning: boolean;
  processed: number;
  changed: number;
  errors: string[];
  lastScan: number;
}
export interface Snapshot {
  tracks: Track[];
  collections: Collection[];
  folders: string[];
  settings: Settings | null;
  scan: Scan;
  playback: Playback;
  spotify: {
    connected: boolean;
    playlistAccess: boolean;
    likedAccess: boolean;
    topAccess: boolean;
    clientId: string | null;
    redirectUri: string;
  };
}
export interface Album {
  key: string;
  name: string;
  artist: string;
  year: number;
  tracks: Track[];
  artwork: string | null;
}
export interface SpotifyTrack {
  /** Null for local files that were added to a Spotify playlist. */
  id: string | null;
  name: string;
  artists: { name: string }[];
  album?: string;
  duration_ms: number;
}
export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  owner: string;
  total: number | null;
  /** Spotify only shares the songs of playlists the user owns or collaborates on. */
  readable: boolean;
}
export interface SpotifyPlaylist {
  id: string;
  name: string;
  owner: string;
  url: string;
  tracks: SpotifyTrack[];
  /** Podcast episodes and removed or unavailable entries. */
  skipped: number;
  revision?: string | null;
}
