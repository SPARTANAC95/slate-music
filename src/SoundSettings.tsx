import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SlidersHorizontal } from 'lucide-react';
import type { EqSettings, Playback, Settings, Snapshot } from './types';
import { Toggle } from './components';

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
  const eq = pb.eq?.bands?.length === 10 ? pb.eq : flatEq();
  const deviceKey = pb.outputDevice ?? '';
  /** Applies an equalizer and remembers it for the current output device. */
  function applyEq(next: EqSettings) {
    onPlayback('eq', next);
    onSettings({ ...settings, eqByDevice: { ...settings.eqByDevice, [deviceKey]: next } });
  }
  async function chooseDevice(name: string) {
    const device = name || null;
    await onPlayback('device', device);
    // Each device keeps its own equalizer, e.g. one for headphones and one for speakers.
    await onPlayback('eq', eqFor(settings, device));
  }
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
              onChange={(e) => applyEq({ ...eq, preamp: Number(e.target.value), preset: 'Custom' })}
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
                  applyEq({
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
