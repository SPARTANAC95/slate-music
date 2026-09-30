import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  FolderPlus,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  X,
  Download,
  Keyboard,
  HardDrive,
} from 'lucide-react';
import { Toggle, IconButton } from './components';
import type { Snapshot, Settings, Playback } from './types';
import type { useUpdater } from './updater';
export default function SettingsPanel({
  data,
  pb,
  settings,
  onSettings,
  onPlayback,
  onRefresh,
  updater,
  onInstall,
}: {
  data: Snapshot;
  pb: Playback;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onPlayback: (a: string, v?: unknown) => void;
  onRefresh: () => void;
  updater: ReturnType<typeof useUpdater>;
  onInstall: () => void;
}) {
  const [clientId, setClientId] = useState(data.spotify.clientId || '');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const missing = data.tracks.filter((t) => t.missing).length;
  const [confirmRemove, setConfirmRemove] = useState(false),
    [removed, setRemoved] = useState<number | null>(null);
  const available = data.tracks.length - missing;
  const known = data.tracks.filter((t) => !t.missing && t.originalYear > 0).length;
  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setMessage('');
    try {
      await action();
      onRefresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="settings-content">
      <section>
        <h3>
          <HardDrive size={17} />
          Music folders
        </h3>
        <p>Files stay exactly where they are. Slate Music reads tags and watches for changes.</p>
        {data.folders.map((folder) => (
          <div className="folder-row" key={folder}>
            <span title={folder}>{folder}</span>
            <IconButton
              label={`Remove folder ${folder} from library`}
              onClick={() => run('folder', () => invoke('remove_folder', { folder }))}
            >
              <X size={16} />
            </IconButton>
          </div>
        ))}
        <div className="button-row">
          <button disabled={!!busy} onClick={() => run('folder', () => invoke('add_folder'))}>
            <FolderPlus size={16} />
            Add folder
          </button>
          <button disabled={data.scan.scanning} onClick={() => run('scan', () => invoke('rescan'))}>
            <RefreshCw size={15} className={data.scan.scanning ? 'spin' : ''} />
            {data.scan.scanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        {(missing > 0 || removed !== null) && (
          <div className="missing-songs">
            {removed !== null ? (
              <p>
                Removed {removed} unavailable song{removed === 1 ? '' : 's'}.
                {missing > 0 &&
                  ` ${missing} on a drive that isn’t connected ${missing === 1 ? 'was' : 'were'} kept.`}
              </p>
            ) : confirmRemove ? (
              <>
                <p>
                  Forget {missing} unavailable song{missing === 1 ? '' : 's'}? Their favorites, play
                  counts and history are lost; playlists show them as missing. Songs on a drive
                  that isn’t connected right now are kept. Your files are not touched.
                </p>
                <div className="button-row">
                  <button
                    className="danger"
                    disabled={!!busy}
                    onClick={() =>
                      run('missing', async () => {
                        setRemoved(await invoke<number>('remove_missing'));
                        setConfirmRemove(false);
                      })
                    }
                  >
                    Remove
                  </button>
                  <button onClick={() => setConfirmRemove(false)}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <p>
                  {missing} song{missing === 1 ? ' is' : 's are'} unavailable: deleted, or on a drive
                  that isn’t connected. Moved songs are recognized automatically and keep their
                  favorites, plays and playlist places.
                </p>
                <button
                  disabled={!!busy || data.scan.scanning}
                  onClick={() => setConfirmRemove(true)}
                >
                  Remove unavailable songs
                </button>
              </>
            )}
          </div>
        )}
        <Toggle
          label="Find each song’s original release year"
          description={
            settings.lookupYears
              ? `Known for ${known} of ${available} songs. Looks songs up on MusicBrainz, a free music database, about one per second; it sends only artists and titles and never changes your files.`
              : 'Compilations and remasters only carry the year of the album. When on, Slate Music asks MusicBrainz, a free music database, when each song first came out. Only artists and titles are sent.'
          }
          checked={!!settings.lookupYears}
          onChange={(v) => onSettings({ ...settings, lookupYears: v })}
        />
        <Toggle
          label="Find lyrics online"
          description="Songs without lyrics of their own (in the file or an .lrc file beside it) are looked up on LRCLIB, a free lyrics database, when you open Now Playing. Only the artist, title, album and length are sent; results are remembered."
          checked={!!settings.lookupLyrics}
          onChange={(v) => onSettings({ ...settings, lookupLyrics: v })}
        />
        {data.scan.errors.length > 0 && (
          <details className="scan-errors">
            <summary>
              {data.scan.errors.length} scan notice{data.scan.errors.length === 1 ? '' : 's'}
            </summary>
            {data.scan.errors.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </details>
        )}
      </section>
      <section>
        <h3>Playback</h3>
        <div className="setting-row">
          <span>
            <strong>Gapless playback</strong>
            <small>One continuous native audio stream. On when crossfade is off.</small>
          </span>
          <span className="badge">
            <CheckCircle2 size={12} />
            Enabled
          </span>
        </div>
        <label className="setting-row">
          <span>
            <strong>Crossfade</strong>
            <small>Blend the end of one track into the next.</small>
          </span>
          <select
            aria-label="Crossfade"
            value={pb.crossfade}
            onChange={(e) => onPlayback('crossfade', Number(e.target.value))}
          >
            {[0, 2, 4, 6, 8, 12].map((n) => (
              <option value={n} key={n}>
                {n === 0 ? 'Off' : `${n} seconds`}
              </option>
            ))}
          </select>
        </label>
        <Toggle
          label="Listening panel"
          description="Keep artwork and the next songs in view."
          checked={settings.showListening}
          onChange={(v) => onSettings({ ...settings, showListening: v })}
        />
        <p className="fine-print">
          FLAC, MP3, WAV, AAC/M4A, ALAC, Ogg Vorbis and AIFF. Output follows your Windows default
          device. If an output device disconnects, playback pauses and reconnects automatically.
        </p>
      </section>
      <section>
        <div className="section-heading">
          <h3>Spotify playlist import</h3>
          {data.spotify.connected && <span className="badge">Connected</span>}
        </div>
        <p>
          Bring your Spotify playlists, Liked Songs and top songs into your local library. Slate Music reads
          each song list and matches it to files you already own. Only metadata is requested.
        </p>
        {data.spotify.connected &&
          (!data.spotify.playlistAccess || !data.spotify.likedAccess || !data.spotify.topAccess) && (
            <p className="inline-error">
              This connection cannot read all of your playlists, Liked Songs and top songs yet.
              Choose Reconnect and approve the request in your browser.
            </p>
          )}
        <ol className="setup-steps">
          <li>
            Open Spotify Developer Dashboard and create an app. Development apps require an active
            Premium subscription for the owner.
          </li>
          <li>
            Add the redirect URI below, exactly as shown, and allow your Spotify account in Users
            Management.
          </li>
          <li>Paste the app’s Client ID, then connect. No client secret is needed.</li>
        </ol>
        <code className="redirect">{data.spotify.redirectUri}</code>
        <label className="field">
          Spotify Client ID
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value.trim())}
            placeholder="32-character Client ID"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="button-row">
          <button
            className="primary"
            disabled={!!busy || clientId.length !== 32}
            onClick={() => run('spotify', () => invoke('spotify_connect', { clientId }))}
          >
            {busy === 'spotify'
              ? 'Waiting for sign-in…'
              : data.spotify.connected
                ? 'Reconnect'
                : 'Connect Spotify'}
          </button>
          {data.spotify.connected && (
            <button onClick={() => run('disconnect', () => invoke('spotify_disconnect'))}>
              Disconnect
            </button>
          )}
          <button
            onClick={() =>
              run('link', () =>
                invoke('open_link', { url: 'https://developer.spotify.com/dashboard' }),
              )
            }
          >
            <ExternalLink size={14} />
            Dashboard
          </button>
        </div>
        <p className="fine-print">
          Sign-in tokens are encrypted for your Windows account. Imported playlists work offline.
          Spotify only shares playlists you created or collaborate on. Development access is
          limited to five authorized users.
        </p>
      </section>
      <section>
        <h3>
          <Download size={16} />
          Updates
        </h3>
        <Toggle
          label="Check for updates automatically"
          checked={settings.autoCheck}
          onChange={(v) => onSettings({ ...settings, autoCheck: v })}
        />
        <Toggle
          label="Download updates automatically"
          checked={settings.autoDownload}
          onChange={(v) => onSettings({ ...settings, autoDownload: v })}
        />
        <p aria-live="polite">{updater.status}</p>
        <div className="button-row">
          <button disabled={updater.busy} onClick={() => updater.checkNow(settings.autoDownload)}>
            Check now
          </button>
          {updater.available && !updater.ready && (
            <button disabled={updater.busy} onClick={updater.download}>
              Download update
            </button>
          )}
          {updater.ready && (
            <button className="primary" disabled={pb.playing || updater.busy} onClick={onInstall}>
              Install and restart
            </button>
          )}
        </div>
        <p className="fine-print">
          Updates are signature-verified. Installation requires confirmation or happens when you
          choose to exit; playback is never interrupted automatically.
        </p>
      </section>
      <section>
        <h3>
          <Keyboard size={16} />
          Keyboard shortcuts
        </h3>
        <div className="shortcuts">
          <span>
            Play / pause<kbd>Space</kbd>
          </span>
          <span>
            Previous / next<kbd>Ctrl + ← / →</kbd>
          </span>
          <span>
            Seek 5 seconds<kbd>← / →</kbd>
          </span>
          <span>
            Search<kbd>Ctrl + K</kbd>
          </span>
          <span>
            Mini-player<kbd>Ctrl + M</kbd>
          </span>
          <span>
            Go back<kbd>Alt + ←</kbd>
          </span>
          <span>
            Close dialog<kbd>Esc</kbd>
          </span>
        </div>
      </section>
      <section>
        <h3>Your data</h3>
        <p>
          Your library, playlists and listening state are saved on this computer. Updates retain
          them.
        </p>
        <button disabled={!!busy} onClick={() => run('backup', () => invoke('export_backup'))}>
          Export favorites and playlists
        </button>
        <p className="fine-print">Slate Music · Built for your own collection.</p>
      </section>
      {message && (
        <p className="inline-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
