// CineStream catalog browser.
// The catalog is generated at build time by scripts/fetch_catalog.py because
// the EmbedMovies endpoint does not send CORS headers.

'use strict';

const CATEGORIES = {
  movies: {
    file: 'data/movies.json',
    label: 'Movies',
    singular: 'movie',
    placeholder: 'Search movies...'
  },
  series: {
    file: 'data/series.json',
    label: 'Series',
    singular: 'series',
    placeholder: 'Search series...'
  },
  animes: {
    file: 'data/animes.json',
    label: 'Anime',
    singular: 'anime',
    placeholder: 'Search anime...'
  }
};

const INDEX_KEYS = { movies: 'movie', series: 'series', animes: 'anime' };
const PAGE_SIZE = 60;
const PLACEHOLDER = 'assets/placeholder.svg';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const numberFormat = new Intl.NumberFormat('en-US');

const state = {
  category: 'movies',
  query: '',
  sort: 'popular',
  visible: PAGE_SIZE,
  rendered: 0,
  cache: new Map(),
  index: null,
  requestId: 0
};

const el = {};

document.addEventListener('DOMContentLoaded', init);

function init() {
  el.grid = document.getElementById('grid');
  el.notice = document.getElementById('notice');
  el.resultCount = document.getElementById('resultCount');
  el.searchForm = document.getElementById('searchForm');
  el.searchInput = document.getElementById('searchInput');
  el.searchClear = document.getElementById('searchClear');
  el.sortSelect = document.getElementById('sortSelect');
  el.loadMore = document.getElementById('loadMore');
  el.endNote = document.getElementById('endNote');
  el.tabs = Array.from(document.querySelectorAll('.tab'));

  bindEvents();
  loadIndex();

  const hash = window.location.hash.replace('#', '');
  const initial = CATEGORIES[hash] ? hash : 'movies';
  switchCategory(initial, { updateHash: false });
}

function bindEvents() {
  el.tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchCategory(tab.dataset.category));
    tab.addEventListener('keydown', onTabKeydown);
  });

  el.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    applySearch(el.searchInput.value);
  });

  el.searchInput.addEventListener('input', debounce(() => {
    applySearch(el.searchInput.value);
  }, 220));

  el.searchClear.addEventListener('click', () => {
    el.searchInput.value = '';
    applySearch('');
    el.searchInput.focus();
  });

  el.sortSelect.addEventListener('change', () => {
    state.sort = el.sortSelect.value;
    state.visible = PAGE_SIZE;
    render(true);
  });

  el.loadMore.addEventListener('click', loadMore);

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMore();
      }
    }, { rootMargin: '700px 0px' });
    observer.observe(el.loadMore);
  }

  window.addEventListener('hashchange', () => {
    const next = window.location.hash.replace('#', '');
    if (CATEGORIES[next] && next !== state.category) {
      switchCategory(next, { updateHash: false });
    }
  });
}

function onTabKeydown(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const index = el.tabs.indexOf(event.currentTarget);
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  const next = el.tabs[(index + delta + el.tabs.length) % el.tabs.length];
  next.focus();
  switchCategory(next.dataset.category);
}

async function switchCategory(key, options = {}) {
  if (!CATEGORIES[key]) return;
  if (key === state.category && state.cache.has(key) && !state.query) return;

  state.category = key;
  state.query = '';
  state.visible = PAGE_SIZE;
  state.rendered = 0;

  el.searchInput.value = '';
  el.searchInput.placeholder = CATEGORIES[key].placeholder;
  el.searchClear.hidden = true;
  el.sortSelect.value = state.sort;
  el.notice.hidden = true;
  el.endNote.hidden = true;
  updateTabs();
  updateDocumentTitle();

  if (options.updateHash !== false) {
    history.replaceState(null, '', '#' + key);
  }

  const requestId = ++state.requestId;
  const cached = state.cache.get(key);

  if (cached) {
    render(true);
    return;
  }

  showSkeletons();
  setResultCount('Loading ' + CATEGORIES[key].label.toLowerCase() + '...');

  try {
    const items = await loadCategory(key);
    if (requestId !== state.requestId) return;
    render(true, items);
  } catch (error) {
    if (requestId !== state.requestId) return;
    showLoadError(error);
  }
}

async function loadCategory(key) {
  if (state.cache.has(key)) return state.cache.get(key);

  const response = await fetch(CATEGORIES[key].file, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + ' while loading ' + CATEGORIES[key].file);
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.items)) {
    throw new Error('Malformed catalog file: ' + CATEGORIES[key].file);
  }

  const items = payload.items.map(prepareItem);
  state.cache.set(key, items);
  return items;
}

function prepareItem(item) {
  item._search = normalize([item.t, item.tp].filter(Boolean).join(' '));
  const rating = Number(item.r) || 0;
  const votes = Number(item.v) || 0;
  // Bayesian average keeps a single 10/10 vote from topping the chart.
  item._score = (rating * votes + 6.5 * 50) / (votes + 50);
  return item;
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function currentItems() {
  const items = state.cache.get(state.category) || [];
  const query = normalize(state.query);
  if (!query) return items;

  const tokens = query.split(' ').filter(Boolean);
  return items.filter((item) => tokens.every((token) => item._search.includes(token)));
}

function sortedItems(items) {
  const list = items.slice();

  switch (state.sort) {
    case 'rating':
      list.sort((a, b) => (b._score - a._score) || ((b.v || 0) - (a.v || 0)));
      break;
    case 'newest':
      list.sort((a, b) => ((b.y || 0) - (a.y || 0)) ||
        ((b.v || 0) - (a.v || 0)) || collator.compare(a.t || '', b.t || ''));
      break;
    case 'title':
      list.sort((a, b) => collator.compare(a.t || '', b.t || ''));
      break;
    case 'popular':
    default:
      list.sort((a, b) => ((b.v || 0) - (a.v || 0)) ||
        (b._score - a._score) || collator.compare(a.t || '', b.t || ''));
      break;
  }

  return list;
}

function render(reset, providedItems) {
  const items = sortedItems(providedItems || currentItems());
  const total = items.length;

  el.grid.setAttribute('aria-busy', 'false');

  if (reset) {
    el.grid.replaceChildren();
    state.rendered = 0;
  }

  if (!total) {
    el.grid.replaceChildren(emptyState());
    setResultCount(state.query
      ? '0 results for \u201c' + state.query + '\u201d'
      : 'No titles available');
    el.loadMore.hidden = true;
    el.endNote.hidden = true;
    return;
  }

  const end = Math.min(state.visible, total);
  if (state.rendered < end) {
    const fragment = document.createDocumentFragment();
    for (let index = state.rendered; index < end; index += 1) {
      fragment.appendChild(createCard(items[index]));
    }
    el.grid.appendChild(fragment);
    state.rendered = end;
  }

  setResultCount(summaryText(total));
  const hasMore = state.rendered < total;
  el.loadMore.hidden = !hasMore;
  el.endNote.hidden = hasMore || total <= PAGE_SIZE;
}

function loadMore() {
  const items = currentItems();
  if (state.rendered >= items.length) return;
  state.visible += PAGE_SIZE;
  render(false, items);
}

function setResultCount(text) {
  el.resultCount.textContent = text;
}

function summaryText(total) {
  if (state.query) {
    return numberFormat.format(total) + (total === 1 ? ' result for ' : ' results for ') +
      '\u201c' + state.query + '\u201d';
  }
  const meta = CATEGORIES[state.category];
  return numberFormat.format(total) + ' ' + (total === 1 ? meta.singular : meta.label.toLowerCase());
}

function createCard(item) {
  const displayTitle = cardTitle(item);
  const card = document.createElement('a');
  card.className = 'card';
  card.href = playerHref(item, displayTitle);
  card.setAttribute('aria-label', 'Watch ' + displayTitle + (item.y ? ' (' + item.y + ')' : ''));
  if (displayTitle !== item.t) card.title = item.t;

  const poster = document.createElement('div');
  poster.className = 'card-poster';

  const image = document.createElement('img');
  image.loading = 'lazy';
  image.decoding = 'async';
  image.alt = '';
  image.src = posterUrl(item.p);
  image.addEventListener('error', () => {
    image.src = PLACEHOLDER;
  }, { once: true });
  poster.appendChild(image);

  const rating = Number(item.r) || 0;
  if (rating > 0) {
    poster.appendChild(ratingBadge(rating));
  }

  const play = document.createElement('span');
  play.className = 'card-play';
  play.innerHTML = '<span><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg></span>';
  poster.appendChild(play);

  const body = document.createElement('div');
  body.className = 'card-body';

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = displayTitle;
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const parts = [];

  if (item.y) parts.push(String(item.y));
  if (item.ty === 'movie' && item.rt) {
    parts.push(formatRuntime(item.rt));
  } else if (item.ty !== 'movie' && item.s) {
    parts.push(item.s === 1 ? '1 season' : item.s + ' seasons');
  }

  parts.forEach((value, index) => {
    if (index > 0) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      meta.appendChild(dot);
    }
    const span = document.createElement('span');
    span.textContent = value;
    meta.appendChild(span);
  });

  if (!parts.length) {
    const span = document.createElement('span');
    span.textContent = item.ty === 'movie' ? 'Movie' : (item.ty === 'anime' ? 'Anime' : 'Series');
    meta.appendChild(span);
  }

  body.appendChild(meta);
  card.appendChild(poster);
  card.appendChild(body);
  return card;
}

function ratingBadge(rating) {
  const badge = document.createElement('span');
  badge.className = 'card-rating';
  badge.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2.8 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3L3 9.5l6.4-.9L12 2.8Z"/></svg>';
  badge.appendChild(document.createTextNode(rating.toFixed(1)));
  return badge;
}

function formatRuntime(minutes) {
  const value = Number(minutes);
  if (!value || value < 1) return '';
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (!hours) return rest + 'm';
  return rest ? hours + 'h ' + rest + 'm' : hours + 'h';
}

function posterUrl(path) {
  if (!path || typeof path !== 'string') return PLACEHOLDER;
  if (path.startsWith('/')) return IMAGE_BASE + path;
  if (/^https:\/\/image\.tmdb\.org\//.test(path)) return path;
  return PLACEHOLDER;
}

function cardTitle(item) {
  if (!state.query || !item.tp) return item.t;
  const tokens = normalize(state.query).split(' ').filter(Boolean);
  if (!tokens.length) return item.t;
  const translated = normalize(item.tp);
  const original = normalize(item.t);
  const translatedMatch = tokens.every((token) => translated.includes(token));
  const originalMatch = tokens.every((token) => original.includes(token));
  // When the query only matches the localized title, show that title so the
  // result is recognizable; the original title stays available as a tooltip.
  return translatedMatch && !originalMatch ? item.tp : item.t;
}

function playerHref(item, title) {
  const params = new URLSearchParams();
  params.set('ty', item.ty || (state.category === 'movies' ? 'movie' : state.category));
  params.set('title', title || item.t || 'Untitled');
  if (item.tm) params.set('tm', item.tm);
  if (item.im) params.set('im', item.im);
  if (item.y) params.set('y', item.y);
  if (item.s) params.set('s', item.s);
  if (item.p) params.set('p', item.p);
  if (item.r) params.set('r', item.r);
  if (item.o) params.set('o', item.o);
  return 'player.html?' + params.toString();
}

function emptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.innerHTML = [
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">',
    '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>',
    '</svg>',
    '<h2>No results</h2>',
    '<p>Try a different title, check the spelling, or switch to another category.</p>'
  ].join('');
  return wrap;
}

function showSkeletons() {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 12; index += 1) {
    const card = document.createElement('div');
    card.className = 'card skeleton';
    card.innerHTML = [
      '<div class="card-poster"></div>',
      '<div class="card-body">',
      '<div class="sk-line"></div>',
      '<div class="sk-line short"></div>',
      '</div>'
    ].join('');
    fragment.appendChild(card);
  }
  el.grid.replaceChildren(fragment);
  el.grid.setAttribute('aria-busy', 'true');
  el.loadMore.hidden = true;
  el.endNote.hidden = true;
}

function updateTabs() {
  el.tabs.forEach((tab) => {
    const active = tab.dataset.category === state.category;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function updateDocumentTitle() {
  const label = CATEGORIES[state.category].label;
  document.title = label + ' \u2014 CineStream';
}

function updateTabCounts() {
  if (!state.index || !state.index.categories) return;
  el.tabs.forEach((tab) => {
    const key = INDEX_KEYS[tab.dataset.category];
    const entry = state.index.categories[key];
    const badge = tab.querySelector('.tab-count');
    if (entry && badge) badge.textContent = numberFormat.format(entry.count);
  });
}

async function loadIndex() {
  try {
    const response = await fetch('data/index.json', { cache: 'no-cache' });
    if (!response.ok) return;
    state.index = await response.json();
    updateTabCounts();
  } catch (error) {
    // Counts are a progressive enhancement; the catalog still works without them.
  }
}

function showLoadError(error) {
  console.error(error);
  el.grid.replaceChildren();
  el.grid.setAttribute('aria-busy', 'false');
  setResultCount('Catalog unavailable');

  const message = document.createElement('p');
  message.textContent = 'Could not load the catalog. If you opened index.html directly, serve the folder over HTTP ' +
    '(for example: python3 -m http.server 8080), then reload.';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => {
    el.notice.hidden = true;
    switchCategory(state.category);
  });

  el.notice.replaceChildren(message, retry);
  el.notice.className = 'notice error';
  el.notice.hidden = false;
}

function applySearch(value) {
  state.query = value.trim();
  state.visible = PAGE_SIZE;
  el.searchClear.hidden = !state.query;

  if (!state.cache.has(state.category)) return;
  render(true);
}

function debounce(fn, delay) {
  let timer = 0;
  return function debounced() {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, delay);
  };
}


