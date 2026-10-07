import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderPlus, Music2, Radio } from 'lucide-react';
import { Toggle } from './components';
import type { Settings } from './types';

interface Lastfm {
  builtIn: boolean;
  own: boolean;
  connected: boolean;
  user: string | null;
  waiting: boolean;
  problem: string | null;
}

/** What a new listener sees before any music is added: where the music is, and the few
 * extras worth deciding once. Everything here is also in Settings. */
export default function Welcome({
  settings,
  onSettings,
  onAdd,
}: {
  settings: Settings;
  onSettings: (s: Settings) => void;
  /** Adds a folder: the one given, or one chosen in a dialog. */
  onAdd: (path?: string) => void;
}) {
  // Windows' own Music folder, when there is one.
  const [music, setMusic] = useState<string | null>(null);
  const [lastfm, setLastfm] = useState<Lastfm | null>(null);
  useEffect(() => {
    let live = true;
    invoke<string | null>('music_folder')
      .then((path) => live && setMusic(path))
      .catch(() => undefined);
    // Signing in to Last.fm finishes in the browser, so keep looking.
    const look = () =>
      invoke<Lastfm>('lastfm_status')
        .then((s) => live && setLastfm(s))
        .catch(() => undefined);
    look();
    const timer = setInterval(look, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <div className="welcome">
      <Music2 size={38} strokeWidth={1} />
      <h2>A home for your music.</h2>
      <p>
        Tell Slate Music where your music is. It finds your songs, albums and artwork, and leaves
        the files exactly where they are.
      </p>
      <div className="button-row">
        {music && (
          <button className="primary" onClick={() => onAdd(music)} title={music}>
            <FolderPlus size={16} />
            Use my Music folder
          </button>
        )}
        <button className={music ? '' : 'primary'} onClick={() => onAdd()}>
          {!music && <FolderPlus size={16} />}
          {music ? 'Choose another folder' : 'Choose music folder'}
        </button>
      </div>
      <section aria-label="Extras">
        <h3>A few extras, yours to decide</h3>
        <Toggle
          label="Find lyrics online"
          description="Songs without lyrics of their own are looked up on LRCLIB, a free lyrics database."
          checked={!!settings.lookupLyrics}
          onChange={(v) => onSettings({ ...settings, lookupLyrics: v })}
        />
        <Toggle
          label="Show artist photos and bios"
          description="Looked up once per artist on MusicBrainz and Wikipedia."
          checked={!!settings.lookupArtists}
          onChange={(v) => onSettings({ ...settings, lookupArtists: v })}
        />
        <Toggle
          label="Show what I’m listening to on Discord"
          description="Friends see the song and its cover while music plays."
          checked={!!settings.discordPresence}
          onChange={(v) => onSettings({ ...settings, discordPresence: v })}
        />
        {lastfm?.builtIn && !lastfm.own && (
          <div className="setting-row">
            <span>
              <strong>Scrobble to Last.fm</strong>
              <small>
                {lastfm.connected
                  ? `Connected as ${lastfm.user}.`
                  : lastfm.problem ||
                    'Last.fm opens in your browser; choose Yes, allow access there.'}
              </small>
            </span>
            {!lastfm.connected && (
              <button
                disabled={lastfm.waiting}
                onClick={() => {
                  onSettings({ ...settings, scrobble: true });
                  invoke('lastfm_connect')
                    .then(() => invoke<Lastfm>('lastfm_status'))
                    .then(setLastfm)
                    .catch(() => undefined);
                }}
              >
                <Radio size={14} />
                {lastfm.waiting ? 'Waiting for Last.fm…' : 'Connect Last.fm'}
              </button>
            )}
          </div>
        )}
        <p className="fine-print">You can change all of this later in Settings.</p>
      </section>
    </div>
  );
}
