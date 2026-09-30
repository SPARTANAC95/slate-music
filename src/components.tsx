import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab' && !ref.current?.contains(document.activeElement)) {
        // Disabling a focused control can send focus to body; keep the next Tab in the dialog.
        const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]') || []).filter(el => el.getClientRects().length > 0);
        const target = event.shiftKey ? controls.at(-1) : controls[0];
        if (target) { event.preventDefault(); target.focus(); }
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose]);
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
          if (e.key === 'Tab') {
            const els = Array.from(ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]',
            ) || []).filter(el => el.getClientRects().length > 0);
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
  onContext,
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
  onContext?: (t: Track, index: number, x: number, y: number) => void;
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
                // The play buttons already handle their own clicks; a double-click on them must
                // not start the song again.
                onDoubleClick={(e) =>
                  !t.missing && !(e.target as HTMLElement).closest('button') && onPlay(index)
                }
                onContextMenu={(e) => {
                  if (!onContext) return;
                  e.preventDefault();
                  onContext(t, index, e.clientX, e.clientY);
                }}
              >
                <button
                  className="row-number"
                  disabled={t.missing}
                  aria-label={`Play ${t.title}`}
                  onClick={(e) => e.detail < 2 && onPlay(index)}
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
                      onClick={(e) => e.detail < 2 && onPlay(index)}
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
                        label={
                          index === currentIndex
                            ? 'Skip the playing song before removing it'
                            : `Remove ${t.title} from queue`
                        }
                        disabled={index === currentIndex}
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
export type MenuItem =
  | { label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean }
  | 'divider';
/** A right-click style menu at a screen point. Closes on outside click, Escape, scroll or blur. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  above = false,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** Open upward from the point, e.g. for buttons along the bottom edge. */
  above?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box)
      setPosition({
        left: Math.max(8, Math.min(x, innerWidth - box.width - 8)),
        top: Math.max(8, Math.min(above ? y - box.height : y, innerHeight - box.height - 8)),
      });
    ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [x, y, above]);
  useEffect(() => {
    // A button marked data-menu-anchor opens this menu and toggles it closed itself.
    const outside = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!ref.current?.contains(target) && !target.closest?.('[data-menu-anchor]')) onClose();
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const buttons = [
          ...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || []),
        ];
        const at = buttons.indexOf(document.activeElement as HTMLElement);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        buttons[(at + step + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      document.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="context-menu" role="menu" style={position}>
      {items.map((item, i) =>
        item === 'divider' ? (
          <div key={i} className="menu-divider" role="separator" />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ),
      )}
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
