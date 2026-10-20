// Watch page. Reads the title data from the query string, builds the
// WatchPlay URL, and exposes season/episode controls for series and anime.

'use strict';

const params = new URLSearchParams(window.location.search);
const WATCHPLAY_ORIGIN = 'https://v2.watchplay.shop';
const el = {};
let config = null;
let loadTimer = 0;
let lastRecentKey = '';

document.addEventListener('DOMContentLoaded', init);

function init() {
  el.title = document.getElementById('watchTitle');
  el.kind = document.getElementById('watchKind');
  el.meta = document.getElementById('watchMeta');
  el.externalLink = document.getElementById('externalLink');
  el.episodeBar = document.getElementById('episodeBar');
  el.seasonSelect = document.getElementById('seasonSelect');
  el.episodeInput = document.getElementById('episodeInput');
  el.playEpisode = document.getElementById('playEpisode');
  el.nextEpisode = document.getElementById('nextEpisode');
  el.playerFrame = document.getElementById('playerFrame');
  el.playerLoading = document.getElementById('playerLoading');
  el.loadingText = document.getElementById('loadingText');
  el.playerError = document.getElementById('playerError');
  el.playerErrorMessage = document.getElementById('playerErrorMessage');
  el.synopsis = document.getElementById('synopsis');
  el.synopsisText = document.getElementById('synopsisText');
  el.backLink = document.getElementById('backLink');
  el.alternateLink = document.getElementById('alternateLink');
  el.removeRecent = document.getElementById('removeRecent');

  config = readConfig();
  applyConfig();
  bindEvents();
  rememberCurrent();
}

function readConfig() {
  const rawType = (params.get('ty') || 'movie').toLowerCase();
  const type = rawType === 'serie' ? 'series' : rawType;
  const allowed = ['movie', 'series', 'anime'];
  const resolvedType = allowed.includes(type) ? type : 'movie';

  const tmdb = (params.get('tm') || '').match(/^\d{1,12}$/);
  const imdb = (params.get('im') || '').match(/^tt\d{5,12}$/);
  const seasons = clampInt(params.get('s'), 0, 200, 0);

  return {
    type: resolvedType,
    title: cleanText(params.get('title'), 300) || 'Untitled',
    tmdb: tmdb ? tmdb[0] : '',
    imdb: imdb ? imdb[0] : '',
    year: clampInt(params.get('y'), 0, 2100, 0),
    rating: clampNumber(params.get('r'), 0, 10, 0),
    seasons: seasons,
    season: clampInt(params.get('se'), 1, Math.max(1, seasons), 1),
    episode: clampInt(params.get('ep'), 1, 999, 1),
    overview: cleanText(params.get('o'), 1200)
  };
}

function applyConfig() {
  document.title = config.title + ' \u2014 CineStream';
  el.title.textContent = config.title;
  el.kind.textContent = kindLabel(config.type);

  const url = buildPlayerUrl();
  if (!url) {
    showError('This title is missing a TMDB or IMDb identifier, so the player URL could not be built.');
    updateMeta();
    updateSynopsis();
    return;
  }

  el.externalLink.href = url;
  const alternate = buildAlternateUrl();
  if (alternate) {
    el.alternateLink.href = alternate;
    el.alternateLink.hidden = false;
  } else {
    el.alternateLink.hidden = true;
  }
  updateMeta();
  updateSynopsis();

  if (config.type !== 'movie' && config.seasons > 0) {
    setupEpisodeControls();
  }
  if (el.nextEpisode) el.nextEpisode.hidden = config.type === 'movie';

  applyBackLink();
  loadPlayer(url);
}

function rememberCurrent() {
  if (!config || !window.CineStreamRecent) return;
  if (!config.tmdb && !config.imdb) return;
  if (!buildPlayerUrl()) return;

  const entry = CineStreamRecent.remember({
    type: config.type,
    title: config.title,
    tm: config.tmdb,
    im: config.imdb,
    year: config.year,
    rating: config.rating,
    seasons: config.seasons,
    poster: params.get('p') || '',
    season: config.season,
    episode: config.episode
  });

  if (!entry) return;
  lastRecentKey = CineStreamRecent.keyOf(entry);
  if (el.removeRecent) el.removeRecent.hidden = false;
}

function removeCurrentRecent() {
  if (!lastRecentKey || !window.CineStreamRecent) return;
  CineStreamRecent.removeKey(lastRecentKey);
  if (el.removeRecent) el.removeRecent.hidden = true;
}

function setupEpisodeControls() {
  el.episodeBar.hidden = false;

  for (let season = 1; season <= config.seasons; season += 1) {
    const option = document.createElement('option');
    option.value = String(season);
    option.textContent = 'Season ' + season;
    el.seasonSelect.appendChild(option);
  }

  el.seasonSelect.value = String(config.season);
  el.episodeInput.value = String(config.episode);
  el.episodeInput.max = '999';
}

function bindEvents() {
  el.playEpisode.addEventListener('click', applyEpisode);
  if (el.nextEpisode) el.nextEpisode.addEventListener('click', playNextEpisode);
  if (el.removeRecent) el.removeRecent.addEventListener('click', removeCurrentRecent);
  el.seasonSelect.addEventListener('change', applyEpisode);
  el.episodeInput.addEventListener('change', applyEpisode);
  el.episodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyEpisode();
    }
  });

  el.playerFrame.addEventListener('load', () => {
    if (!el.playerFrame.src.startsWith(WATCHPLAY_ORIGIN + '/')) return;
    window.clearTimeout(loadTimer);
    el.playerLoading.hidden = true;
    el.playerFrame.hidden = false;
  });
}

function playNextEpisode() {
  if (!config || config.type === 'movie') return;
  config.episode = Math.min(999, config.episode + 1);
  el.episodeInput.value = String(config.episode);
  applyEpisode();
}

function applyEpisode() {
  const season = clampInt(el.seasonSelect.value, 1, Math.max(1, config.seasons), 1);
  const episode = clampInt(el.episodeInput.value, 1, 999, 1);

  el.seasonSelect.value = String(season);
  el.episodeInput.value = String(episode);
  config.season = season;
  config.episode = episode;

  const url = buildPlayerUrl();
  if (!url) {
    showError('The player URL could not be built for this episode.');
    return;
  }

  el.externalLink.href = url;
  const alternate = buildAlternateUrl();
  if (alternate) el.alternateLink.href = alternate;
  updateUrl();
  updateMeta();
  loadPlayer(url);
  rememberCurrent();
}

function loadPlayer(url) {
  window.clearTimeout(loadTimer);
  el.playerError.hidden = true;
  el.playerLoading.hidden = false;
  el.playerFrame.hidden = true;
  el.loadingText.textContent = 'Loading player...';

  el.playerFrame.src = url;

  loadTimer = window.setTimeout(() => {
    el.loadingText.textContent = 'Still loading... This source can be slow. Try “Open in new tab” if it does not start.';
  }, 12000);
}

function buildPlayerUrl() {
  if (config.type === 'movie') {
    const id = config.tmdb || config.imdb;
    return id ? WATCHPLAY_ORIGIN + '/movie/' + encodeURIComponent(id) : '';
  }

  if (!config.tmdb) return '';
  return WATCHPLAY_ORIGIN + '/tvshow/' + encodeURIComponent(config.tmdb)
    + '/' + config.season + '/' + config.episode;
}

function buildAlternateUrl() {
  if (config.type === 'movie') {
    const id = config.imdb || config.tmdb;
    return id ? 'https://myembed.biz/filme/' + encodeURIComponent(id) : '';
  }

  if (!config.tmdb) return '';
  return 'https://myembed.biz/serie/' + encodeURIComponent(config.tmdb)
    + '/' + config.season + '/' + config.episode;
}

function updateMeta() {
  const parts = [];
  if (config.year) parts.push(String(config.year));
  if (config.rating > 0) parts.push({ text: config.rating.toFixed(1) + ' / 10', className: 'rating' });
  if (config.type !== 'movie') {
    if (config.seasons > 0) {
      parts.push(config.season + 'x' + String(config.episode).padStart(2, '0'));
    } else if (config.seasons) {
      parts.push(config.seasons === 1 ? '1 season' : config.seasons + ' seasons');
    }
  }

  el.meta.replaceChildren();
  parts.forEach((part, index) => {
    if (index > 0) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      el.meta.appendChild(dot);
    }
    if (typeof part === 'string') {
      const span = document.createElement('span');
      span.textContent = part;
      el.meta.appendChild(span);
    } else {
      const span = document.createElement('span');
      span.className = part.className;
      span.textContent = part.text;
      el.meta.appendChild(span);
    }
  });
}

function updateSynopsis() {
  if (!config.overview) {
    el.synopsis.hidden = true;
    return;
  }
  el.synopsisText.textContent = config.overview;
  el.synopsis.hidden = false;
}

function updateUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('se', String(config.season));
  url.searchParams.set('ep', String(config.episode));
  history.replaceState(null, '', url);
}

function applyBackLink() {
  if (!document.referrer) return;
  try {
    const referrer = new URL(document.referrer);
    if (referrer.origin === window.location.origin) {
      el.backLink.href = referrer.pathname + referrer.search + referrer.hash;
    }
  } catch (error) {
    // Ignore malformed referrers and keep the default catalog link.
  }
}

function showError(message) {
  window.clearTimeout(loadTimer);
  el.playerLoading.hidden = true;
  el.playerFrame.hidden = true;
  el.playerErrorMessage.textContent = message;
  el.playerError.hidden = false;
  el.externalLink.hidden = true;
  el.episodeBar.hidden = true;
}

function kindLabel(type) {
  if (type === 'series') return 'Series';
  if (type === 'anime') return 'Anime';
  return 'Movie';
}

function cleanText(value, maxLength) {
  if (!value) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
