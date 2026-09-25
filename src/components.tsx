import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Disc3,
  Heart,
  Play,
  Plus,
  Music2,
  ArrowUp,
  ArrowDown,
  X,
  Check,
  FolderOpen,
} from 'lucide-react';
import type { Track } from './types';
import { time } from './library';
export function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  className = '',
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? 'active' : ''} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Art({
  hash,
  name = '',
  className = '',
}: {
  hash?: string | null;
  name?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [hash]);
  return hash && !failed ? (
    <img
      className={`art ${className}`}
      src={`http://art.localhost/${hash}`}
      alt={name ? `${name} cover` : ''}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <div className={`art placeholder ${className}`} aria-label="No artwork">
      <Disc3 size={42} />
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Music2 size={38} strokeWidth={1} />
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, input, select, a[href]')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Tab') {
            const els = ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input,select,a[href],[tabindex="0"]',
            );
            if (!els?.length) return;
            const first = els[0],
              last = els[els.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}
export function TrackTable({
  tracks,
  currentId,
  playing,
  onPlay,
  onFavorite,
  onAdd,
  onQueue,
  onMove,
  onRemove,
  compact = false,
  queue = false,
  rowIndices,
  currentIndex,
  queueLength,
}: {
  tracks: Track[];
  currentId?: string | null;
  playing: boolean;
  onPlay: (index: number) => void;
  onFavorite: (t: Track) => void;
  onAdd: (t: Track) => void;
  onQueue: (t: Track) => void;
  onMove?: (from: number, to: number) => void;
  onRemove?: (index: number) => void;
  compact?: boolean;
  queue?: boolean;
  rowIndices?: number[];
  currentIndex?: number;
  queueLength?: number;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 64,
    overscan: 8,
  });
  return (
    <div className={`track-table ${compact ? 'compact' : ''} ${queue ? 'queue-table' : ''}`}>
      <div className="table-head">
        <span>#</span>
        <span>Title</span>
        <span>Album</span>
        <span>Time</span>
        <span />
      </div>
      <div
        className="table-scroll"
        ref={parent}
        style={{ height: compact ? Math.min(tracks.length * 64, 340) : 'min(60vh, 700px)' }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((row) => {
            const t = tracks[row.index];
            const index = rowIndices?.[row.index] ?? row.index;
            const active = queue ? currentIndex === index : currentId === t.id;
            return (
              <div
                key={`${t.id}-${row.index}`}
                className={`track-row ${active ? 'selected' : ''} ${t.missing ? 'unavailable' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: row.size,
                  transform: `translateY(${row.start}px)`,
                }}
                onDoubleClick={() => !t.missing && onPlay(index)}
              >
                <button
                  className="row-number"
                  disabled={t.missing}
                  aria-label={`Play ${t.title}`}
                  onClick={() => onPlay(index)}
                >
                  {active && playing ? (
                    <span className="equalizer">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    <>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <Play className="row-play" size={15} />
                    </>
                  )}
                </button>
                <div className="track-title">
                  <Art hash={t.artwork} />
                  <div>
                    <button
                      className="text-button song-title"
                      onClick={() => onPlay(index)}
                      disabled={t.missing}
                    >
                      {t.title}
                    </button>
                    <span className="muted ellipsis">
                      {t.artist}
                      {t.missing && <em className="missing-tag">Unavailable</em>}
                    </span>
                  </div>
                </div>
                <span className="album-cell ellipsis" title={t.album}>
                  {t.album}
                </span>
                <span className="time-cell">{time(t.duration)}</span>
                <div className="row-actions">
                  {queue ? (
                    <>
                      <IconButton
                        label={`Move ${t.title} up`}
                        onClick={() => onMove?.(index, index - 1)}
                        disabled={index === 0}
                      >
                        <ArrowUp size={15} />
                      </IconButton>
                      <IconButton
                        label={`Move ${t.title} down`}
                        onClick={() => onMove?.(index, index + 1)}
                        disabled={index === (queueLength ?? tracks.length) - 1}
                      >
                        <ArrowDown size={15} />
                      </IconButton>
                      <IconButton
                        label={`Remove ${t.title} from queue`}
                        onClick={() => onRemove?.(index)}
                      >
                        <X size={15} />
                      </IconButton>
                    </>
                  ) : (
                    <>
                      <IconButton
                        label={`${t.favorite ? 'Unfavorite' : 'Favorite'} ${t.title}`}
                        active={t.favorite}
                        onClick={() => onFavorite(t)}
                      >
                        <Heart size={16} fill={t.favorite ? 'currentColor' : 'none'} />
                      </IconButton>
                      <IconButton
                        label={`Add ${t.title} to queue`}
                        onClick={() => onQueue(t)}
                        disabled={t.missing}
                      >
                        <Plus size={17} />
                      </IconButton>
                      <IconButton label={`Add ${t.title} to playlist`} onClick={() => onAdd(t)}>
                        <FolderOpen size={16} />
                      </IconButton>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="setting-row">
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span>{checked && <Check size={10} />}</span>
      </button>
    </label>
  );
}
