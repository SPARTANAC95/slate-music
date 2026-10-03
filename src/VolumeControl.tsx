import { Volume2, VolumeX } from 'lucide-react';
import { IconButton } from './components';

/** Both player views control the same engine gain, including exclusive output. */
export default function VolumeControl({ volume, onChange, onMute }: {
  volume: number;
  onChange: (volume: number) => void;
  onMute: () => void;
}) {
  return (
    <div className="volume-control">
      <IconButton label={volume === 0 ? 'Unmute' : 'Mute'} onClick={onMute}>
        {volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </IconButton>
      <input type="range" aria-label="Volume" aria-valuetext={Math.round(volume * 100) + '%'}
        min={0} max={1} step={0.01} value={volume}
        style={{ '--fill': volume * 100 + '%' } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))} />
      <output aria-hidden="true">{Math.round(volume * 100)}%</output>
    </div>
  );
}
