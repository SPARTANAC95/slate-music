const views = {
  home: {
    file: 'player-home.png',
    alt: 'Slate Music Home, showing album artwork, a local music library and the listening queue',
    caption: 'Actual app. Original demo collection.',
  },
  albums: {
    file: 'player-albums.png',
    alt: 'Slate Music Albums, showing six original demo album covers organized in a library',
    caption: 'Your albums, with room for the artwork.',
  },
  queue: {
    file: 'player-queue.png',
    alt: 'Slate Music Queue, with an ordered list of demo tracks and playback controls',
    caption: 'An editable queue. A session that stays with you.',
  },
};
const image = document.querySelector('#player-screenshot');
const caption = document.querySelector('#view-caption');
const full = document.querySelector('#full-screenshot');
const switcher = document.querySelector('.view-switcher');
if (image && caption && full && switcher) {
  switcher.hidden = false;
  for (const button of switcher.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      const view = views[button.dataset.view];
      if (!view) return;
      image.src = `assets/${view.file}`;
      image.alt = view.alt;
      caption.textContent = view.caption;
      full.href = image.src;
      for (const item of switcher.querySelectorAll('button')) {
        const selected = item === button;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-pressed', String(selected));
      }
    });
  }
}
