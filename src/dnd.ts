import type { DragEvent } from 'react';

/** Songs being dragged: from a song list (with their rows, for reordering) or an album card. */
export interface DragSongs {
  ids: string[];
  /** Rows in the source list, for reordering within that list. */
  rows: number[];
  /** Which list they came from, e.g. "Queue" or "collection:<id>". */
  source: string;
}
// The browser only reveals dragged data on drop, so drop targets check this while hovering.
let current: DragSongs | null = null;
export const dragged = () => current;

export function startDrag(e: DragEvent, songs: DragSongs, label: string) {
  current = songs;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', label);
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = label;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 14, 14);
  setTimeout(() => ghost.remove(), 0);
}
export function endDrag() {
  current = null;
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
}
/** Props that make an element accept dropped songs, highlighted while songs hover over it. */
export function dropZone(
  onDrop: (songs: DragSongs) => void,
  accepts: (songs: DragSongs) => boolean = () => true,
) {
  const ok = () => {
    const songs = dragged();
    return songs && accepts(songs) ? songs : null;
  };
  return {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!ok()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      e.currentTarget.classList.add('drop-target');
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
        e.currentTarget.classList.remove('drop-target');
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const songs = ok();
      e.currentTarget.classList.remove('drop-target');
      if (!songs) return;
      e.preventDefault();
      endDrag();
      onDrop(songs);
    },
  };
}
