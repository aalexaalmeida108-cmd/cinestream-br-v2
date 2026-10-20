// Watch page. Reads the title data from the query string, builds the
// WatchPlay URL, and exposes season/episode controls for series and anime.

'use strict';

const params = new URLSearchParams(window.location.search);
const WATCHPLAY_ORIGIN = 'https://v2.watchplay.shop';
const EPISODE_INDEX_URL = 'data/episodes.json';
const el = {};
let config = null;
let loadTimer = 0;
let lastRecentKey = '';
let episodeIndex = null;

document.addEventListener('DOMContentLoaded', init);

function init() {
  el.title = document.getElementById('watchTitle');
  el.kind = document.getElementById('watchKind');
  el.meta = document.getElementById('watchMeta');
  el.externalLink = document.getElementById('externalLink');
  el.episodeBar = document.getElementById('episodeBar');
  el.seasonSelect = document.getElementById('seasonSelect');
  el.episodeInput = document.getElementById('episodeInput');
  el.episodeCounter = document.getElementById('episodeCounter');
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
  bindEvents();
  loadEpisodeIndex();
}

// Loads the per-season episode counts, then applies the configuration. The
// counts come first so the page never opens an episode that does not exist.
function loadEpisodeIndex() {
  if (config.type === 'movie') {
    applyConfig();
    return;
  }

  fetch(EPISODE_INDEX_URL, { cache: 'force-cache' })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((payload) => {
      const items = payload && payload.items;
      if (items) {
        const counts = items[String(config.tmdb)];
        if (counts && counts.length) episodeIndex = counts;
      }
      applyConfig();
    });
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
    season: clampInt(params.get('se'), 1, 200, 1),
    episode: clampInt(params.get('ep'), 1, 999, 1),
    overview: cleanText(params.get('o'), 1200)
  };
}

function applyConfig() {
  document.title = config.title + ' \u2014 CineStream';
  el.title.textContent = config.title;
  el.kind.textContent = kindLabel(config.type);

  clampToKnownEpisodes();

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

  if (config.type !== 'movie' && knownSeasons().length) {
    setupEpisodeControls();
  }
  if (el.nextEpisode) el.nextEpisode.hidden = config.type === 'movie';
  updateNextEpisodeButton();

  applyBackLink();
  loadPlayer(url);
  rememberCurrent();
}

// Keeps the requested season and episode inside what actually exists.
function clampToKnownEpisodes() {
  if (config.type === 'movie' || !episodeIndex) return;

  const seasons = knownSeasons();
  if (!seasons.length) return;

  const lastSeason = seasons[seasons.length - 1];
  if (config.season > lastSeason) config.season = lastSeason;
  if (!seasons.includes(config.season)) config.season = seasons[0];

  const count = seasonEpisodeCount(config.season);
  if (count && config.episode > count) config.episode = count;
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

  const seasons = knownSeasons();
  el.seasonSelect.replaceChildren();
  for (const season of seasons) {
    const option = document.createElement('option');
    option.value = String(season);
    const count = seasonEpisodeCount(season);
    option.textContent = count ? 'Season ' + season + ' (' + count + ')' : 'Season ' + season;
    el.seasonSelect.appendChild(option);
  }

  el.seasonSelect.value = String(config.season);
  el.episodeInput.value = String(config.episode);
  el.episodeInput.max = String(seasonEpisodeCount(config.season) || 999);
  updateEpisodeCounter();
  updateNextEpisodeButton();
}

function knownSeasons() {
  const counts = episodeIndex || [];
  const seasons = [];
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] > 0) seasons.push(index + 1);
  }
  if (seasons.length) return seasons;

  const fallback = [];
  for (let season = 1; season <= Math.max(1, config.seasons); season += 1) {
    fallback.push(season);
  }
  return fallback;
}

function seasonEpisodeCount(season) {
  if (!episodeIndex) return 0;
  return Number(episodeIndex[season - 1]) || 0;
}

// Returns the season/episode the "Next episode" button would open, or null
// when the current episode is the last one of the last season.
function nextEpisodeTarget() {
  if (!config || config.type === 'movie') return null;

  const count = seasonEpisodeCount(config.season);

  // Without a known season length there is no last episode to roll over
  // from, so the button stays inside the current season.
  if (!count) {
    return config.episode < 999
      ? { season: config.season, episode: config.episode + 1 }
      : null;
  }

  if (config.episode < count) {
    return { season: config.season, episode: config.episode + 1 };
  }

  const seasons = knownSeasons();
  const position = seasons.indexOf(config.season);
  const nextSeason = position >= 0 ? seasons[position + 1] : 0;
  if (!nextSeason) return null;
  return { season: nextSeason, episode: 1 };
}

function updateNextEpisodeButton() {
  if (!el.nextEpisode) return;
  if (!config || config.type === 'movie') return;
  const target = nextEpisodeTarget();
  if (!target) {
    el.nextEpisode.disabled = true;
    el.nextEpisode.textContent = 'No more episodes';
    el.nextEpisode.title = 'This is the last episode of the last season.';
    return;
  }
  el.nextEpisode.disabled = false;
  el.nextEpisode.textContent = 'Next episode';
  el.nextEpisode.title = target.season === config.season
    ? 'Play S' + target.season + 'E' + target.episode
    : 'Continue with S' + target.season + 'E' + target.episode;
}

function syncEpisodeControls() {
  const count = seasonEpisodeCount(config.season);
  el.episodeInput.max = String(count || 999);
  if (count && config.episode > count) {
    config.episode = count;
    el.episodeInput.value = String(count);
  }
  updateEpisodeCounter();
  updateNextEpisodeButton();
}

function updateEpisodeCounter() {
  if (!el.episodeCounter) return;
  const count = seasonEpisodeCount(config.season);
  el.episodeCounter.textContent = count
    ? 'Episode ' + config.episode + ' of ' + count
    : '';
  el.episodeCounter.hidden = !count;
}

function bindEvents() {
  el.playEpisode.addEventListener('click', applyEpisode);
  if (el.nextEpisode) el.nextEpisode.addEventListener('click', playNextEpisode);
  if (el.removeRecent) el.removeRecent.addEventListener('click', removeCurrentRecent);
  el.seasonSelect.addEventListener('change', onSeasonChange);
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

function onSeasonChange() {
  const seasons = knownSeasons();
  const lastSeason = seasons.length ? seasons[seasons.length - 1] : Math.max(1, config.seasons);
  const season = clampInt(el.seasonSelect.value, 1, lastSeason, 1);
  const changed = season !== config.season;
  config.season = season;

  // Picking another season starts it from its first episode.
  const count = seasonEpisodeCount(season);
  if (changed || !count || config.episode > count) {
    config.episode = 1;
  }
  el.episodeInput.value = String(config.episode);
  el.episodeInput.max = String(count || 999);
  updateEpisodeCounter();
  updateNextEpisodeButton();

  applyEpisode();
}

// Advances one episode. On the last episode of a season it rolls over to
// the first episode of the next season, so the button keeps working through
// the whole series.
function playNextEpisode() {
  if (!config || config.type === 'movie') return;

  const target = nextEpisodeTarget();
  if (!target) {
    updateNextEpisodeButton();
    return;
  }

  config.season = target.season;
  config.episode = target.episode;
  el.seasonSelect.value = String(target.season);
  el.episodeInput.value = String(target.episode);
  el.episodeInput.max = String(seasonEpisodeCount(target.season) || 999);
  updateEpisodeCounter();

  applyEpisode();
}

function applyEpisode() {
  const seasons = knownSeasons();
  const lastSeason = seasons.length ? seasons[seasons.length - 1] : Math.max(1, config.seasons);
  const season = clampInt(el.seasonSelect.value, 1, lastSeason, 1);
  const count = seasonEpisodeCount(season);
  const episode = clampInt(el.episodeInput.value, 1, count || 999, 1);

  el.seasonSelect.value = String(season);
  el.episodeInput.value = String(episode);
  el.episodeInput.max = String(count || 999);
  config.season = season;
  config.episode = episode;
  updateEpisodeCounter();
  updateNextEpisodeButton();

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
