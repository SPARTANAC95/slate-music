import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SlidersHorizontal } from 'lucide-react';
import type { EqSettings, Playback, Settings, Snapshot } from './types';
import { Toggle } from './components';
import { eqChanges } from './NowPlaying';
import { deviceDelay, setDeviceDelay } from './lyricTiming';

export const EQ_BANDS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
/** Equalizer presets in dB per band, with a preamp that keeps boosts from clipping. */
export const EQ_PRESETS: Record<string, { bands: number[]; preamp: number }> = {
  Flat: { bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0 },
  'Bass boost': { bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], preamp: -5 },
  'Treble boost': { bands: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6], preamp: -5 },
  Vocal: { bands: [-2, -2, -1, 0, 2, 3, 3, 2, 0, -1], preamp: -3 },
  Loudness: { bands: [5, 4, 2, 0, -1, 0, 0, 2, 4, 5], preamp: -4 },
  Acoustic: { bands: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1], preamp: -3 },
  Electronic: { bands: [4, 4, 1, 0, -2, 1, 0, 1, 4, 5], preamp: -4 },
  'Late night': { bands: [-3, -2, 0, 0, 1, 2, 2, 1, -1, -3], preamp: -2 },
};
export const flatEq = (): EqSettings => ({ enabled: false, preamp: 0, bands: EQ_PRESETS.Flat.bands, preset: 'Flat' });
/** The equalizer to use for a device: its saved one, or flat. */
export const eqFor = (settings: Settings, device: string | null) =>
  settings.eqByDevice?.[device ?? ''] ?? flatEq();

export default function SoundSettings({
  data,
  pb,
  settings,
  onSettings,
  onPlayback,
}: {
  data: Snapshot;
  pb: Playback;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onPlayback: (action: string, value?: unknown) => unknown;
}) {
  const [devices, setDevices] = useState<{ devices: string[]; default: string | null }>({
    devices: [],
    default: null,
  });
  useEffect(() => {
    invoke<{ devices: string[]; default: string | null }>('audio_devices').then(setDevices, () => {});
  }, []);
  // While a slider moves, its value lives here, so it follows the hand; the equalizer is
  // applied (and remembered) once the slider rests for a moment.
  const [draft, setDraft] = useState<EqSettings | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const eq = draft ?? (pb.eq?.bands?.length === 10 ? pb.eq : flatEq());
  const deviceKey = pb.outputDevice ?? '';
  // Kept for the device that is actually playing (the Windows default has its own name).
  const playing = pb.output?.device;
  const [delay, setDelay] = useState(() => deviceDelay(playing));
  useEffect(() => setDelay(deviceDelay(playing)), [playing]);
  /** Applies an equalizer and remembers it for the current output device. */
  async function applyEq(next: EqSettings) {
    window.clearTimeout(timer.current);
    onSettings({ ...settings, eqByDevice: { ...settings.eqByDevice, [deviceKey]: next } });
    await onPlayback('eq', next);
    setDraft((d) => (d === next ? null : d));
  }
  function slide(next: EqSettings) {
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => applyEq(next), 150);
  }
  async function chooseDevice(name: string) {
    const device = name || null;
    await onPlayback('device', device);
    // Each device keeps its own equalizer, e.g. one for headphones and one for speakers.
    await onPlayback('eq', eqFor(settings, device));
  }
  /** Nothing in Slate Music changes the samples: full volume, flat EQ, no levelling. */
  const untouched = pb.volume >= 1 && !eqChanges(pb) && pb.levelling === 'off';
  const total = data.tracks.filter((t) => !t.missing).length;
  const measured = Math.min(data.loudnessMeasured ?? 0, total);
  return (
    <>
      <label className="setting-row">
        <span>
          <strong>Output device</strong>
          <small>
            {pb.output?.fallback
              ? `Your chosen device isn’t connected, so ${pb.output.device} is playing.`
              : 'Where Slate Music plays. Each device keeps its own equalizer.'}
          </small>
        </span>
        <select aria-label="Output device" value={pb.outputDevice ?? ''} onChange={(e) => chooseDevice(e.target.value)}>
          <option value="">Windows default{devices.default ? ` (${devices.default})` : ''}</option>
          {devices.devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
          {pb.outputDevice && !devices.devices.includes(pb.outputDevice) && (
            <option value={pb.outputDevice}>{pb.outputDevice} (not connected)</option>
          )}
        </select>
      </label>
      <label className="setting-row">
        <span>
          <strong>Lyrics delay{playing ? ` on ${playing}` : ''}</strong>
          <small>
            Wireless speakers and headphones play a moment late. If lyrics light up before you
            hear the words, move this right until they match. {delay
              ? `Lyrics ${delay > 0 ? 'wait' : 'run ahead by'} ${Math.abs(Math.round(delay * 1000))} ms on this device.`
              : 'Each device keeps its own setting.'}
          </small>
        </span>
        <input
          type="range"
          aria-label="Lyrics delay"
          aria-valuetext={`${Math.round(delay * 1000)} milliseconds`}
          min={-0.3}
          max={0.6}
          step={0.01}
          value={delay}
          disabled={!playing}
          style={{ '--fill': `${((delay + 0.3) / 0.9) * 100}%` } as React.CSSProperties}
          onChange={(e) => {
            const next = Number(e.target.value);
            setDeviceDelay(playing, next);
            setDelay(next);
          }}
        />
      </label>
      <Toggle
        label="Exclusive mode (bit-perfect)"
        description={
          !pb.exclusive
            ? 'Sends each song to your device untouched, at its own sample rate, with no Windows mixing or conversion. Other apps can’t play sound through that device while music plays, and crossfades are skipped.'
            : !pb.output?.exclusive
              ? 'On, but the device can’t be used exclusively right now, so Slate Music plays through Windows. The message at the top of the window says why.'
              : `On: ${pb.output.device} plays each song at its own rate and is let go a few seconds after you pause.${
                  untouched
                    ? ' Songs the device takes at their own rate reach it exactly as they are in the file; Now Playing → Signal path checks each song.'
                    : ' For bit-perfect sound, set the volume to 100% and turn the equalizer and levelling off.'
                }`
        }
        checked={!!pb.exclusive}
        onChange={(v) => onPlayback('exclusive', v)}
      />
      <label className="setting-row">
        <span>
          <strong>Loudness levelling</strong>
          <small>
            Plays quiet and loud songs at a similar volume. Smart keeps an album’s own dynamics
            while you play it in order. {measured < total ? `Measuring songs: ${measured} of ${total}.` : `All ${total} songs measured.`}
          </small>
        </span>
        <select aria-label="Loudness levelling" value={pb.levelling ?? 'smart'} onChange={(e) => onPlayback('levelling', e.target.value)}>
          <option value="smart">Smart (recommended)</option>
          <option value="album">By album</option>
          <option value="track">By song</option>
          <option value="off">Off</option>
        </select>
      </label>
      <Toggle
        label="Smart crossfade"
        description="Fades where the music actually ends, skips silence between songs, and never fades between songs that run into each other on an album."
        checked={pb.smartCrossfade ?? true}
        onChange={(v) => onPlayback('smart_crossfade', v)}
      />
      <div className="eq">
        <div className="eq-head">
          <strong>
            <SlidersHorizontal size={15} />
            Equalizer
          </strong>
          <select
            aria-label="Equalizer preset"
            value={EQ_PRESETS[eq.preset] ? eq.preset : 'Custom'}
            disabled={!eq.enabled}
            onChange={(e) => {
              const p = EQ_PRESETS[e.target.value];
              if (p) applyEq({ enabled: true, preamp: p.preamp, bands: p.bands, preset: e.target.value });
            }}
          >
            {Object.keys(EQ_PRESETS).map((name) => (
              <option key={name}>{name}</option>
            ))}
            {!EQ_PRESETS[eq.preset] && <option>Custom</option>}
          </select>
          <button
            type="button"
            role="switch"
            aria-checked={eq.enabled}
            aria-label="Equalizer"
            className={`switch ${eq.enabled ? 'on' : ''}`}
            onClick={() => applyEq({ ...eq, enabled: !eq.enabled })}
          >
            <span />
          </button>
        </div>
        <div className={`eq-bands ${eq.enabled ? '' : 'off'}`}>
          <label className="eq-band preamp">
            <output>{eq.preamp > 0 ? '+' : ''}{eq.preamp}</output>
            <input
              type="range"
              aria-label="Preamp"
              min={-12}
              max={0}
              step={0.5}
              value={eq.preamp}
              disabled={!eq.enabled}
              style={{ '--fill': `${((eq.preamp + 12) / 12) * 100}%` } as React.CSSProperties}
              onChange={(e) => slide({ ...eq, preamp: Number(e.target.value), preset: 'Custom' })}
            />
            <span>Pre</span>
          </label>
          {EQ_BANDS.map((label, i) => (
            <label className="eq-band" key={label}>
              <output>{eq.bands[i] > 0 ? '+' : ''}{eq.bands[i]}</output>
              <input
                type="range"
                aria-label={`${label}Hz`}
                min={-12}
                max={12}
                step={0.5}
                value={eq.bands[i]}
                disabled={!eq.enabled}
                style={{ '--fill': `${((eq.bands[i] + 12) / 24) * 100}%` } as React.CSSProperties}
                onChange={(e) =>
                  slide({
                    ...eq,
                    bands: eq.bands.map((b, n) => (n === i ? Number(e.target.value) : b)),
                    preset: 'Custom',
                  })
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}
