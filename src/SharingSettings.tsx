import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ExternalLink, Radio, MessageCircle } from 'lucide-react';
import { Toggle } from './components';
import { plural } from './library';
import type { Settings } from './types';

interface LastfmStatus {
  configured: boolean;
  connected: boolean;
  user: string | null;
  waiting: boolean;
  pending: number;
  problem: string | null;
}
interface DiscordStatus {
  /** The application in use: Slate Music's own, or the user's. */
  clientId: string;
  /** The user's own application, when they set one. */
  customId: string | null;
  connected: boolean;
  problem: string | null;
}
const open = (url: string) => invoke('open_link', { url }).catch(() => undefined);

/** Settings for sharing what you listen to: Last.fm scrobbling and Discord's status. */
export default function SharingSettings({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (s: Settings) => void;
}) {
  const [lastfm, setLastfm] = useState<LastfmStatus | null>(null);
  const [discord, setDiscord] = useState<DiscordStatus | null>(null);
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [editing, setEditing] = useState(false);
  const [appId, setAppId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<{ where: string; text: string } | null>(null);
  // Sign-in finishes in the browser and Discord may start later, so keep looking while open.
  useEffect(() => {
    let live = true;
    const look = () => {
      invoke<LastfmStatus>('lastfm_status')
        .then((s) => live && setLastfm(s))
        .catch(() => undefined);
      invoke<DiscordStatus>('discord_status')
        .then((s) => live && setDiscord(s))
        .catch(() => undefined);
    };
    look();
    const timer = setInterval(look, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  async function run(where: string, action: () => Promise<unknown>) {
    setBusy(where);
    setError(null);
    try {
      await action();
      setLastfm(await invoke<LastfmStatus>('lastfm_status'));
      setDiscord(await invoke<DiscordStatus>('discord_status'));
    } catch (e) {
      setError({ where, text: String(e) });
    } finally {
      setBusy('');
    }
  }
  const hex32 = (s: string) => /^[0-9a-f]{32}$/i.test(s.trim());
  const id = appId ?? discord?.customId ?? '';
  const idOk = /^\d{17,20}$/.test(id.trim());
  const problem = (where: string) =>
    error?.where === where && (
      <p className="inline-error" role="alert">
        {error.text}
      </p>
    );
  const askForKeys = lastfm && (!lastfm.configured || editing);
  return (
    <>
      <section>
        <div className="section-heading">
          <h3>
            <Radio size={16} />
            Last.fm scrobbling
          </h3>
          {lastfm?.connected && <span className="badge">Connected</span>}
        </div>
        <p>
          Keep a record of everything you listen to on your Last.fm profile. A song counts once you
          have heard half of it (or four minutes); songs heard while offline are sent later.
        </p>
        {askForKeys ? (
          <>
            <ol className="setup-steps">
              <li>Open Last.fm’s API account page with the button below and sign in.</li>
              <li>
                Enter an application name such as “Slate Music” and a short description. Callback
                URL and homepage can stay empty. Choose Submit.
              </li>
              <li>Copy the API key and shared secret it shows, paste them here and choose Save.</li>
            </ol>
            <label className="field">
              API key
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="32 letters and numbers"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              Shared secret
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="32 letters and numbers"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="button-row">
              <button
                className="primary"
                disabled={!!busy || !hex32(key) || !hex32(secret)}
                onClick={() =>
                  run('lastfm', async () => {
                    await invoke('lastfm_setup', { key, secret });
                    setEditing(false);
                    setSecret('');
                  })
                }
              >
                {busy === 'lastfm' ? 'Checking with Last.fm…' : 'Save'}
              </button>
              <button onClick={() => open('https://www.last.fm/api/account/create')}>
                <ExternalLink size={14} />
                Create an API account
              </button>
              {editing && <button onClick={() => setEditing(false)}>Cancel</button>}
            </div>
          </>
        ) : lastfm && !lastfm.connected ? (
          <>
            <p>
              Your API account is saved. Now connect your profile: Last.fm opens in your browser;
              choose <strong>Yes, allow access</strong> there, then come back here.
            </p>
            <div className="button-row">
              <button
                className="primary"
                disabled={!!busy || lastfm.waiting}
                onClick={() =>
                  run('lastfm', async () => {
                    onSettings({ ...settings, scrobble: true });
                    await invoke('lastfm_connect');
                  })
                }
              >
                {lastfm.waiting ? 'Waiting for you to allow access on Last.fm…' : 'Connect Last.fm'}
              </button>
              <button onClick={() => setEditing(true)}>Change API key</button>
              <button onClick={() => run('lastfm', () => invoke('lastfm_forget'))}>Remove</button>
            </div>
          </>
        ) : (
          lastfm && (
            <>
              <Toggle
                label={`Scrobble to Last.fm as ${lastfm.user}`}
                description={
                  lastfm.pending
                    ? `${plural(lastfm.pending, 'scrobble')} waiting to be sent.`
                    : 'Songs you listen to appear on your Last.fm profile.'
                }
                checked={!!settings.scrobble}
                onChange={(v) => onSettings({ ...settings, scrobble: v })}
              />
              <div className="button-row">
                <button
                  onClick={() =>
                    open(`https://www.last.fm/user/${encodeURIComponent(lastfm.user || '')}`)
                  }
                >
                  <ExternalLink size={14} />
                  Your profile
                </button>
                <button onClick={() => run('lastfm', () => invoke('lastfm_disconnect'))}>
                  Disconnect
                </button>
              </div>
            </>
          )
        )}
        {lastfm?.problem && <p className="inline-error">{lastfm.problem}</p>}
        {problem('lastfm')}
        <p className="fine-print">
          The shared secret and sign-in are encrypted for your Windows account. Only the artist,
          title, album, length and when you listened are sent to Last.fm.
        </p>
      </section>
      <section>
        <div className="section-heading">
          <h3>
            <MessageCircle size={16} />
            Discord status
          </h3>
          {discord?.connected && settings.discordPresence && (
            <span className="badge">Connected</span>
          )}
        </div>
        <p>
          Show friends on Discord what you are listening to, with the album cover, song, artist
          and a progress bar. Nothing shows while music is paused. Just switch it on; Discord needs
          to be open on this PC.
        </p>
        <Toggle
          label="Show what I’m listening to on Discord"
          description={
            !settings.discordPresence
              ? 'Off. Friends see nothing from Slate Music.'
              : discord?.connected
                ? discord.problem || 'On. Discord shows the song while music plays.'
                : discord?.problem || 'Looking for Discord…'
          }
          checked={!!settings.discordPresence}
          onChange={(v) => onSettings({ ...settings, discordPresence: v })}
        />
        <Toggle
          label="Show the album cover"
          description={
            settings.discordCovers === false
              ? 'Off. Discord shows the Slate Music icon beside the song.'
              : 'Finds the cover on MusicBrainz and the Cover Art Archive; the album and artist name are sent. It can differ from the cover in your files.'
          }
          checked={settings.discordCovers !== false}
          disabled={!settings.discordPresence}
          onChange={(v) => onSettings({ ...settings, discordCovers: v })}
        />
        <details className="advanced">
          <summary>Use your own Discord application (optional)</summary>
          <p>
            Slate Music shows up as “Slate Music” on its own. To show another name, create an
            application in the Discord Developer Portal, copy its <strong>Application ID</strong>{' '}
            from General Information and save it here.
          </p>
          <label className="field">
            Discord Application ID
            <input
              value={id}
              onChange={(e) => setAppId(e.target.value.trim())}
              inputMode="numeric"
              placeholder="A long number, e.g. 1234567890123456789"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              disabled={!!busy || !idOk || id === discord?.customId}
              onClick={() =>
                run('discord', async () => {
                  await invoke('discord_setup', { id });
                  setAppId(null);
                })
              }
            >
              {id && id === discord?.customId ? 'Saved' : 'Save'}
            </button>
            {discord?.customId && (
              <button
                disabled={!!busy}
                onClick={() =>
                  run('discord', async () => {
                    await invoke('discord_setup', { id: '' });
                    setAppId(null);
                  })
                }
              >
                Use Slate Music’s
              </button>
            )}
            <button onClick={() => open('https://discord.com/developers/applications')}>
              <ExternalLink size={14} />
              Developer Portal
            </button>
          </div>
        </details>
        {problem('discord')}
        <p className="fine-print">
          The status itself goes only to the Discord app on this PC. Discord must be open, with
          Activity Privacy allowing your activity to show.
        </p>
      </section>
    </>
  );
}
