const views = {
  home: {
    file: 'player-home.png',
    alt: 'Slate Music Home, with Jump back in and Recently added shelves of demo albums and the listening panel',
    caption: 'Actual app. Original demo collection.',
  },
  playing: {
    file: 'player-now-playing.png',
    alt: 'Now Playing with a demo song: a large cover and synced lyrics following the music',
    caption: 'Now Playing, with lyrics that follow along.',
  },
  albums: {
    file: 'player-albums.png',
    alt: 'Slate Music Albums, showing six original demo album covers organized in a library',
    caption: 'Your albums, with room for the artwork.',
  },
  year: {
    file: 'player-year.png',
    alt: 'Your year with a demo listening history: hours listened, streak, top songs and artists',
    caption: 'Your year in music, worked out on your PC.',
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
