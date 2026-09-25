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
}
export interface Entry {
  trackId: string | null;
  title: string;
  artist: string;
  duration: number;
  status: 'available' | 'uncertain' | 'missing';
  candidates?: { id: string; score: number; reason: string }[];
  spotifyId?: string;
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
}
export interface Settings {
  autoCheck: boolean;
  autoDownload: boolean;
  showListening: boolean;
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
  spotify: { connected: boolean; clientId: string | null; redirectUri: string };
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
  id: string;
  name: string;
  artists: { name: string }[];
  duration_ms: number;
  disc_number: number;
  track_number: number;
}
export interface SpotifyAlbum {
  id: string;
  name: string;
  artists: { name: string }[];
  release_date: string;
  url: string;
  tracks: SpotifyTrack[];
}
