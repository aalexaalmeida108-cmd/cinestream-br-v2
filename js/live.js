// CineStream — free live TV, three sources.
//
// Local (same-origin HLS originators from /api/tv/channels; no CORS, no token):
//   GET /api/tv/channels -> [{ id, name, streamUrl }] with streamUrl under /live/*.
//
// Plex (all hops CORS-open; token travels in the query string so no preflight
// is needed after the first anonymous-user call):
//   1. POST clients.plex.tv/api/v2/users/anonymous  -> authToken + client id
//   2. GET  epg.provider.plex.tv/lineups/plex/channels?X-Plex-Token=…  -> channels
//   3. POST epg.provider.plex.tv/channels/<channelId>/tune  -> current program
//   4. GET  epg.provider.plex.tv/library/parts/<channelId>.m3u8?X-Plex-Token=…
//      -> master playlist; variant playlists already carry signed segment URLs
//      (Amagi SSAI, 240p..1080p) so hls.js needs nothing else.
//
// Pluto TV (boot issues a JWT that the stitcher now requires — without it every
// channel returns the looping takedown slate):
//   1. GET boot.pluto.tv/v4/start?…            -> sessionToken (JWT), stitcher, stitcherParams
//   2. GET api.pluto.tv/v2/channels?start=…&stop=…   (CORS pinned to pluto.tv)
//   3. GET <stitcher>/v2/stitch/hls/channel/<id>/master.m3u8?jwt=…&masterJWTPassthrough=true&<stitcherParams>
//   4. segments + AES keys live on siloh-ns1.plutotv.net and are CORS `*`.
// All three hops go through the path-style proxy; see PLUTO.proxy.
// Boot is cached until refreshInSec (~8h) and force-refreshed on fatal errors.

'use strict';

const PLEX = {
  api: 'https://clients.plex.tv',
  epg: 'https://epg.provider.plex.tv',
  luma: 'https://luma.plex.tv',
  product: 'Plex Web',
  version: '4.140.0',
  platform: 'Chrome',
  // Used only when creating a fresh anonymous session fails (rate limit, offline DNS).
  fallbackToken: 'yGAXbikxzzg9vLvcZxRw',
  fallbackClientId: '5154213f-d6e3-4ab9-b7fb-c6e890d5d971'
};

// Set by live.html (`window.CINESTREAM_PLUTO_PROXY`) or `?proxy=` for testing.
const PLUTO_PROXY = String(
  new URLSearchParams(location.search).get('proxy') || window.CINESTREAM_PLUTO_PROXY || ''
).replace(/\/+$/, '');

const PLUTO = {
  api: 'https://api.pluto.tv',
  boot: 'https://boot.pluto.tv',
  proxy: PLUTO_PROXY,
  enabled: !!PLUTO_PROXY
};

// Boot session (JWT + stitcher base + stitcherParams). Refreshed before it
// expires; force-refresh retries clear it so the next plutoUrl re-boots.
let plutoSession = null;

// Stable anonymous client id so boot does not mint a new device every play.
function plutoClientId() {
  try {
    const key = 'cinestream:pluto:device';
    let id = localStorage.getItem(key);
    if (!id) {
      id =
        (crypto.randomUUID && crypto.randomUUID()) ||
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return '00000000-0000-4000-8000-000000000000';
  }
}

const STORE_KEY = 'cinestream:plex:v1';
const GENRE_KEY = 'cinestream:genres:v1';
const AIRING_KEY = 'cinestream:airings:v1';
const AIRING_TTL = 15 * 60 * 1000;
const GENRE_TTL = 12 * 60 * 60 * 1000;
const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

const GENRES = [
  ['all', 'All'],
  ['movies', 'Movies'],
  ['sports', 'Sports'],
  ['news', 'News'],
  ['comedy', 'Comedy'],
  ['crime', 'Crime'],
  ['reality', 'Reality'],
  ['classic-tv', 'Classic TV'],
  ['binge-worthy', 'Binge-worthy'],
  ['adrenaline-sci-fi', 'Sci-Fi & Action'],
  ['kids-family', 'Kids & Family'],
  ['explore', 'Explore'],
  ['food-home-culture', 'Food & Home'],
  ['music', 'Music'],
  ['daytime-tv-games', 'Daytime & Games'],
  ['en-espanol', 'En Español'],
  ['global', 'Global']
];

const LANGS = [
  ['all', 'Any language'],
  ['pt', 'Português'],
  ['en', 'English'],
  ['es', 'Español']
];

const state = {
  source: 'local',
  session: null,
  channels: [],
  localChannels: [],
  plexChannels: [],
  plutoChannels: [],
  categories: [],
  counts: { local: 0, plex: 0, pluto: 0 },
  loaded: { local: false, plex: false, pluto: false },
  byId: new Map(),
  genreMap: null,
  airings: new Map(),
  genre: 'all',
  lang: 'all',
  query: '',
  channel: null,
  hls: null,
  retuneAt: 0,
  program: null,
  retuneTimer: 0,
  progressTimer: 0,
  recoveries: 0,
  airingTimer: 0,
  observer: null
};

const el = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  el.grid = document.getElementById('liveGrid');
  el.notice = document.getElementById('liveNotice');
  el.count = document.getElementById('liveCount');
  el.sources = document.getElementById('liveSources');
  el.search = document.getElementById('liveSearch');
  el.searchClear = document.getElementById('liveSearchClear');
  el.genreBar = document.getElementById('liveGenres');
  el.langBar = document.getElementById('liveLangs');
  el.refresh = document.getElementById('liveRefresh');
  el.overlay = document.getElementById('liveOverlay');
  el.video = document.getElementById('liveVideo');
  el.overlayTitle = document.getElementById('liveOverlayTitle');
  el.overlayChannel = document.getElementById('liveOverlayChannel');
  el.overlayLogo = document.getElementById('liveOverlayLogo');
  el.overlayProgram = document.getElementById('liveOverlayProgram');
  el.overlaySub = document.getElementById('liveOverlaySub');
  el.overlayProgress = document.getElementById('liveOverlayProgress');
  el.overlayQuality = document.getElementById('liveOverlayQuality');
  el.overlayClose = document.getElementById('liveOverlayClose');
  el.overlayRetry = document.getElementById('liveOverlayRetry');
  el.overlayError = document.getElementById('liveOverlayError');
  el.overlayNext = document.getElementById('liveOverlayNext');
  el.unmute = document.getElementById('liveUnmute');

  buildSources();
  buildFilters();
  bindEvents();
  await boot();
}

/* ------------------------------------------------------------------ token */

function readSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (raw && typeof raw.token === 'string' && raw.token.length > 8) return raw;
  } catch (_) {
    /* storage disabled */
  }
  return null;
}

function writeSession(session) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(session));
  } catch (_) {
    /* storage disabled */
  }
}

function newClientId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (window.crypto || {}).getRandomValues
    ? crypto.getRandomValues(bytes)
    : bytes.forEach((_, index) => {
        bytes[index] = Math.floor(Math.random() * 256);
      });
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

async function createSession(clientId) {
  const response = await fetch(`${PLEX.api}/api/v2/users/anonymous`, {
    method: 'POST',
    headers: {
      'X-Plex-Client-Identifier': clientId,
      'X-Plex-Product': PLEX.product,
      'X-Plex-Version': PLEX.version,
      'X-Plex-Platform': PLEX.platform,
      'X-Plex-Device': 'Desktop',
      'X-Plex-Device-Name': 'CineStream',
      'X-Plex-Language': 'pt-BR',
      Accept: 'application/json'
    }
  });
  if (!response.ok) throw new Error(`anonymous session failed: HTTP ${response.status}`);
  const body = await response.json();
  if (!body || typeof body.authToken !== 'string') throw new Error('anonymous session returned no token');
  return { token: body.authToken, clientId, createdAt: Date.now() };
}

function seedAirings() {
  const cached = readAiringCache();
  const now = Date.now();
  Object.keys(cached).forEach((key) => {
    const record = cached[key];
    if (!record || !record.at || now - record.at >= AIRING_TTL) return;
    // Only hydrate what is still on air, so a cold visit paints real titles.
    if (record.now && record.now.endsAt && record.now.endsAt * 1000 > now) {
      state.airings.set(key, record);
    }
  });
}

async function boot(force) {
  seedAirings();
  showNotice('Loading local channels…', 'info');
  try {
    await loadLocal();
    hideNotice();
  } catch (error) {
    state.source = 'plex';
    buildSources();
    showNotice(`Local channels unavailable. ${error.message}.`, 'error');
  }

  // Plex stays available as a second tab; failures do not block Local.
  try {
    state.session = await resolveSession(force);
    await loadLineup();
    if (state.source === 'local') hideNotice();
  } catch (error) {
    if (state.source !== 'local') {
      showNotice(
        `Could not reach Plex Live TV. ${error.message}. Use Refresh to try again.`,
        'error'
      );
    }
  }
}

/* ------------------------------------------------------------------ local */

function normalizeLocal(raw) {
  if (!raw || !raw.id || !raw.streamUrl) return null;
  return {
    id: String(raw.id),
    epgKey: String(raw.id),
    slug: String(raw.id),
    title: raw.name || String(raw.id),
    summary: raw.summary || 'Local HLS feed',
    thumb: raw.thumb || '',
    art: raw.art || '',
    language: raw.language || 'pt',
    hd: true,
    streamKey: String(raw.streamUrl),
    playUrl: String(raw.streamUrl),
    local: true
  };
}

async function loadLocal() {
  const response = await fetch('/api/tv/channels', { cache: 'no-store' });
  if (!response.ok) throw new Error(`local HTTP ${response.status}`);
  const list = await response.json();
  const channels = (Array.isArray(list) ? list : [])
    .map(normalizeLocal)
    .filter(Boolean)
    .sort((left, right) => collator.compare(left.title, right.title));

  if (!channels.length) throw new Error('no local channels');

  state.localChannels = channels;
  state.counts.local = channels.length;
  state.loaded.local = true;
  state.categories = [];
  channels.forEach((channel) => {
    state.airings.set(channel.id, {
      at: Date.now(),
      now: {
        title: channel.title,
        subtitle: 'Local feed',
        summary: channel.summary,
        beginsAt: 0,
        endsAt: 0
      },
      next: null
    });
  });
  buildSources();

  if (state.source !== 'local') return;
  state.channels = channels;
  state.byId = new Map(channels.map((channel) => [channel.id, channel]));
  buildFilters();
  el.count.textContent = `${channels.length} channels`;
  render();
}

async function resolveSession(force) {
  if (!force && state.session) return state.session;
  if (!force) {
    const saved = readSession();
    if (saved) {
      state.session = saved;
      return saved;
    }
  }
  let session;
  try {
    session = await createSession(newClientId());
  } catch (error) {
    session = { token: PLEX.fallbackToken, clientId: PLEX.fallbackClientId, createdAt: Date.now() };
  }
  writeSession(session);
  state.session = session;
  return session;
}

function invalidateSession() {
  state.session = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch (_) {
    /* storage disabled */
  }
}

function tokenQuery(session) {
  return `X-Plex-Token=${encodeURIComponent(session.token)}`;
}

function plexGet(path) {
  const session = state.session;
  const glue = path.includes('?') ? '&' : '?';
  return fetch(`${PLEX.epg}${path}${glue}${tokenQuery(session)}`, {
    headers: { Accept: 'application/json' }
  });
}

/* ----------------------------------------------------------------- lineup */

async function loadLineup() {
  let response = await plexGet('/lineups/plex/channels');
  if (response.status === 401) {
    invalidateSession();
    state.session = await resolveSession(true);
    response = await plexGet('/lineups/plex/channels');
  }
  if (!response.ok) throw new Error(`lineup HTTP ${response.status}`);

  const body = await response.json();
  const list = (body.MediaContainer && body.MediaContainer.Channel) || [];

  const channels = list
    .map(normalizeChannel)
    .filter((channel) => channel && channel.streamKey)
    .sort((left, right) => collator.compare(left.title, right.title));

  if (!channels.length) throw new Error('lineup was empty');

  state.plexChannels = channels;
  state.counts.plex = channels.length;
  state.loaded.plex = true;
  buildSources();

  if (state.source !== 'plex') return;
  state.channels = channels;
  state.byId = new Map(channels.map((channel) => [channel.id, channel]));
  buildFilters();
  el.count.textContent = `${channels.length} channels`;
  render();
}

function normalizeChannel(raw) {
  if (!raw || typeof raw.id !== 'string') return null;
  const media = (raw.Media && raw.Media[0]) || {};
  const part = (media.Part && media.Part[0]) || {};
  // EPG fragments are keyed by the bare channel hash (`gridKey`), not by the
  // grid-qualified `id` the tune endpoint expects.
  const epgKey = typeof raw.gridKey === 'string' && raw.gridKey
    ? raw.gridKey
    : raw.id.slice(raw.id.lastIndexOf('-') + 1);
  return {
    id: raw.id,
    epgKey,
    slug: raw.slug || raw.id,
    title: raw.title || raw.slug || 'Channel',
    summary: raw.summary || '',
    thumb: raw.thumb || raw.coverPoster || raw.art || '',
    art: raw.art || raw.coverPoster || '',
    language: raw.language || '',
    hd: !!raw.isHd,
    streamKey: part.key || '',
    protocol: media.protocol || 'hls',
    resolution: media.videoResolution || ''
  };
}

/* ------------------------------------------------------------------ pluto */

// Pluto's API, boot and stitcher pin CORS to pluto.tv, so all three go through
// the path-style proxy: https://<proxy>/p/<host>/<path>?<query>.
function proxied(target) {
  const url = new URL(target);
  return `${PLUTO.proxy}/p/${url.host}${url.pathname}${url.search}`;
}

// POST-free boot: /v4/start returns sessionToken (JWT), servers.stitcher and
// stitcherParams. Stitcher rejects any master.m3u8 without the JWT (returns
// only the "not available on this device" slate).
async function plutoBoot(force = false) {
  const now = Date.now();
  if (!force && plutoSession && plutoSession.expiresAt > now + 5 * 60 * 1000) {
    return plutoSession;
  }

  const clientID = plutoClientId();
  const query = new URLSearchParams({
    appName: 'web',
    appVersion: '5.14.0-0f5ca672f515a62078d2ec0ad2',
    clientID,
    clientModelNumber: '1.0.0',
    clientTime: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    deviceMake: 'chrome',
    deviceModel: 'web',
    deviceType: 'web',
    deviceVersion: '131.0.0.0',
    serverSideAds: 'false'
  });

  const response = await fetch(proxied(`${PLUTO.boot}/v4/start?${query}`), {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`pluto boot HTTP ${response.status}`);

  const data = await response.json();
  const token = data.sessionToken;
  const stitcher = String((data.servers && data.servers.stitcher) || '').replace(/\/+$/, '');
  if (!token || !stitcher) throw new Error('pluto boot missing sessionToken/stitcher');

  const refreshSec = Number(data.refreshInSec) || 6 * 60 * 60;
  plutoSession = {
    token,
    stitcher,
    params: String(data.stitcherParams || ''),
    // Refresh a few minutes early so a long watch never hits an expired JWT.
    expiresAt: now + Math.max(60, refreshSec - 300) * 1000
  };
  return plutoSession;
}

// Build the stitcher master URL for a channel: /v2/stitch/... + jwt +
// masterJWTPassthrough + stitcherParams (device/session identity from boot).
async function plutoUrl(channel, forceBoot = false) {
  const session = await plutoBoot(forceBoot);
  const path = `/v2/stitch/hls/channel/${encodeURIComponent(channel.id)}/master.m3u8`;
  const query = new URLSearchParams({
    jwt: session.token,
    masterJWTPassthrough: 'true',
    includeExtendedEvents: 'true'
  });
  const suffix = session.params ? `&${session.params}` : '';
  return proxied(`${session.stitcher}${path}?${query.toString()}${suffix}`);
}

async function loadPluto() {
  const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stop = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const target = `${PLUTO.api}/v2/channels?start=${encodeURIComponent(start)}&stop=${encodeURIComponent(stop)}`;

  const response = await fetch(proxied(target), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`pluto HTTP ${response.status}`);
  const list = await response.json();

  const channels = (Array.isArray(list) ? list : [])
    .map(normalizePluto)
    .filter(Boolean)
    .sort((left, right) => collator.compare(left.title, right.title));

  if (!channels.length) throw new Error('pluto lineup was empty');

  state.plutoChannels = channels;
  state.counts.pluto = channels.length;
  state.loaded.pluto = true;
  state.categories = [...new Set(channels.flatMap((channel) => channel.categories))].sort(collator.compare);
  seedPlutoAirings(channels);
  buildSources();

  if (state.source !== 'pluto') return;
  state.channels = channels;
  state.byId = new Map(channels.map((channel) => [channel.id, channel]));
  buildFilters();
  el.count.textContent = `${channels.length} channels`;
  render();
}

function normalizePluto(raw) {
  if (!raw || typeof raw._id !== 'string') return null;
  const urls = (raw.stitched && raw.stitched.urls) || [];
  const hls = urls.find((entry) => entry && entry.type === 'hls' && entry.url);
  if (!hls) return null;

  const logo = (raw.colorLogoPNG && raw.colorLogoPNG.path) || (raw.logo && raw.logo.path) || '';
  const art = (raw.featuredImage && raw.featuredImage.path) || (raw.tile && raw.tile.path) || logo;

  return {
    id: raw._id,
    epgKey: raw._id,
    slug: raw.slug || raw._id,
    title: raw.name || raw.slug || 'Channel',
    summary: raw.summary || '',
    thumb: logo,
    art,
    language: 'pt',
    hd: true,
    number: raw.number || 0,
    categories: [raw.category].filter(Boolean),
    playUrl: hls.url,
    timelines: Array.isArray(raw.timelines) ? raw.timelines : []
  };
}

// "Police Interceptors: Episode 7" + subtitle "Episode 7" would print the same
// fragment twice; drop a subtitle the title already contains.
function cleanSubtitle(title, subtitle) {
  const sub = String(subtitle || '').trim();
  if (!sub) return '';
  const flat = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const needle = sub.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return needle && flat.includes(needle) ? '' : sub;
}

function epgSubtitle(item) {
  const name = (item.episode && item.episode.name) || '';
  return name && name.trim().toLowerCase() !== String(item.title || '').trim().toLowerCase() ? name : '';
}

function epgSummary(item) {
  const description = (item.episode && item.episode.description) || '';
  return /^no info/i.test(description) ? '' : description;
}

// Pluto ships the guide with the lineup, so cards and the overlay can be fed
// from the same shape the Plex airing cache uses.
function seedPlutoAirings(channels) {
  const now = Date.now();
  channels.forEach((channel) => {
    const list = channel.timelines;
    if (!list.length) return;
    let index = list.findIndex(
      (item) => Date.parse(item.start) <= now && Date.parse(item.stop) > now
    );
    if (index < 0) index = 0;
    const current = list[index] || {};
    const upcoming = list[index + 1];
    if (!current.start) return;
    state.airings.set(channel.id, {
      at: now,
      now: {
        title: current.title || channel.title,
        subtitle: epgSubtitle(current),
        summary: epgSummary(current),
        beginsAt: Date.parse(current.start) / 1000 || 0,
        endsAt: Date.parse(current.stop) / 1000 || 0
      },
      next: upcoming ? { title: upcoming.title || '' } : null
    });
  });
}

/* ----------------------------------------------------------------- genres */

function readGenreCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(GENRE_KEY) || 'null');
    if (raw && raw.at && Date.now() - raw.at < GENRE_TTL && raw.map) return raw.map;
  } catch (_) {
    /* storage disabled */
  }
  return null;
}

async function genreSet(genre) {
  // `null`/`undefined`/`all` mean "no filter". Without this the lookup below
  // would request `?genre=null`, get nothing back and filter out every channel.
  if (!genre || genre === 'all') return null;
  state.genreMap = state.genreMap || readGenreCache() || {};

  const cached = state.genreMap[genre];
  if (cached && cached.length) return new Set(cached);

  let response = await plexGet(`/lineups/plex/channels?genre=${encodeURIComponent(genre)}`);
  if (response.status === 401) {
    invalidateSession();
    state.session = await resolveSession(true);
    response = await plexGet(`/lineups/plex/channels?genre=${encodeURIComponent(genre)}`);
  }
  if (!response.ok) return new Set();

  const body = await response.json();
  const ids = ((body.MediaContainer && body.MediaContainer.Channel) || []).map((channel) => channel.id);
  state.genreMap[genre] = ids;
  try {
    localStorage.setItem(GENRE_KEY, JSON.stringify({ at: Date.now(), map: state.genreMap }));
  } catch (_) {
    /* storage disabled */
  }
  return new Set(ids);
}

/* ------------------------------------------------------------------- grid */

function buildSources() {
  if (!el.sources) return;
  const entries = [];
  if (state.loaded.local || state.counts.local) entries.push(['local', 'Local']);
  entries.push(['plex', 'Plex']);
  if (PLUTO.enabled) entries.push(['pluto', 'Pluto TV']);

  el.sources.replaceChildren(
    ...entries.map(([key, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'live-source' + (key === state.source ? ' is-active' : '');
      button.dataset.source = key;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', key === state.source ? 'true' : 'false');
      const count = state.counts[key];
      button.textContent = count ? `${label} · ${count}` : label;
      button.addEventListener('click', () => switchSource(key));
      return button;
    })
  );
  el.sources.hidden = entries.length < 2;
}

async function switchSource(name) {
  // Clicking the active tab retries a source that failed to load.
  if (name === state.source && state.loaded[name]) return;
  if (name === 'local' && !state.loaded.local) {
    state.source = 'local';
    state.genre = 'all';
    state.lang = 'all';
    state.query = '';
    el.search.value = '';
    el.searchClear.hidden = true;
    state.channels = [];
    state.byId = new Map();
    buildSources();
    buildFilters();
    el.count.textContent = 'Loading…';
    el.grid.replaceChildren();
    showNotice('Loading local channels…', 'info');
    try {
      await loadLocal();
      hideNotice();
    } catch (error) {
      showNotice(`Could not load local channels. ${error.message}.`, 'error');
      state.source = 'plex';
      buildSources();
      switchSource('plex');
    }
    return;
  }
  if (name === 'pluto' && !state.loaded.pluto) {
    state.source = 'pluto';
    state.genre = 'all';
    state.lang = 'all';
    state.query = '';
    el.search.value = '';
    el.searchClear.hidden = true;
    state.channels = [];
    state.byId = new Map();
    buildSources();
    buildFilters();
    el.count.textContent = 'Loading…';
    el.grid.replaceChildren();
    showNotice('Loading Pluto TV…', 'info');
    try {
      await loadPluto();
      hideNotice();
    } catch (error) {
      showNotice(`Could not reach Pluto TV. ${error.message}.`, 'error');
    }
    return;
  }

  state.source = name;
  state.genre = 'all';
  state.lang = 'all';
  state.query = '';
  el.search.value = '';
  el.searchClear.hidden = true;

  const channels = name === 'pluto'
    ? state.plutoChannels
    : name === 'local'
      ? state.localChannels
      : state.plexChannels;
  state.channels = channels;
  state.byId = new Map(channels.map((channel) => [channel.id, channel]));
  buildSources();
  buildFilters();
  render();
}

function buildFilters() {
  const pluto = state.source === 'pluto';
  const local = state.source === 'local';
  const list = pluto
    ? [['all', 'Todos']].concat(state.categories.map((category) => [category, category]))
    : local
      ? [['all', 'All']]
      : GENRES;

  el.genreBar.replaceChildren(
    ...list.map(([key, label]) => chip(key, label, key === state.genre, (value) => {
      state.genre = value;
      syncChips(el.genreBar, value);
      render();
    }))
  );

  // Pluto BR is Portuguese-only; Local has a single feed language. Neither needs a language row.
  el.langBar.hidden = pluto || local;
  if (pluto || local) {
    el.langBar.replaceChildren();
    return;
  }
  el.langBar.replaceChildren(
    ...LANGS.map(([key, label]) => chip(key, label, key === state.lang, (value) => {
      state.lang = value;
      syncChips(el.langBar, value);
      render();
    }))
  );
}

function chip(key, label, active, onPick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip' + (active ? ' is-active' : '');
  button.dataset.value = key;
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.textContent = label;
  button.addEventListener('click', () => onPick(key));
  return button;
}

function syncChips(bar, value) {
  bar.querySelectorAll('.chip').forEach((button) => {
    const active = button.dataset.value === value;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function matches(channel) {
  if (state.lang !== 'all' && channel.language !== state.lang) return false;
  if (!state.query) return true;
  const haystack = `${channel.title} ${channel.summary} ${channel.slug}`.toLowerCase();
  return state.query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

async function render() {
  let allowed = null;
  if (state.source === 'local') {
    allowed = null;
  } else if (state.source === 'pluto') {
    // The Pluto lineup already carries its own category, so filter locally
    // instead of asking the Plex genre endpoint.
    allowed = state.genre === 'all'
      ? null
      : new Set(
        state.channels
          .filter((channel) => channel.categories.includes(state.genre))
          .map((channel) => channel.id)
      );
  } else {
    try {
      allowed = await genreSet(state.genre);
    } catch (_) {
      allowed = null; // keep the full lineup rather than an empty page
    }
  }
  const visible = state.channels.filter(
    (channel) => (!allowed || allowed.has(channel.id)) && matches(channel)
  );

  el.count.textContent = visible.length === state.channels.length
    ? `${visible.length} channels`
    : `${visible.length} of ${state.channels.length} channels`;

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state live-empty';
    empty.innerHTML = '<h2>No channels</h2><p>Try a different genre, language or search term.</p>';
    el.grid.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  visible.forEach((channel) => fragment.appendChild(channelCard(channel)));
  el.grid.replaceChildren(fragment);
  // Pluto ships its guide with the lineup, so paint every card now instead of
  // waiting for the intersection observer to fetch one by one.
  if (state.source === 'pluto' || state.source === 'local') {
    visible.forEach((channel) => paintAiring(channel.id));
  }
  observeCards();
}

function channelCard(channel) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'live-card';
  card.dataset.id = channel.id;
  card.setAttribute('aria-label', `Watch ${channel.title} live`);

  const art = document.createElement('span');
  art.className = 'live-card-art';

  if (channel.art) {
    const backdrop = document.createElement('img');
    backdrop.src = channel.art;
    backdrop.alt = '';
    backdrop.loading = 'lazy';
    art.appendChild(backdrop);
  }

  const logo = document.createElement('span');
  logo.className = 'live-card-logo';
  if (channel.thumb) {
    const img = document.createElement('img');
    img.src = channel.thumb;
    img.alt = '';
    img.loading = 'lazy';
    logo.appendChild(img);
  } else {
    logo.textContent = channel.title.slice(0, 2).toUpperCase();
  }
  art.appendChild(logo);

  const badge = document.createElement('span');
  badge.className = 'live-badge';
  badge.innerHTML = '<span class="live-dot"></span>LIVE';
  art.appendChild(badge);

  if (channel.hd) {
    const hd = document.createElement('span');
    hd.className = 'live-hd';
    hd.textContent = 'HD';
    art.appendChild(hd);
  }

  const meta = document.createElement('span');
  meta.className = 'live-card-meta';
  const name = document.createElement('span');
  name.className = 'live-card-title';
  name.textContent = channel.title;
  const now = document.createElement('span');
  now.className = 'live-card-now';
  now.dataset.airing = channel.id;
  now.textContent = 'Live · 24/7';
  meta.append(name, now);

  card.append(art, meta);
  card.addEventListener('click', () => openChannel(channel));
  return card;
}

// Cards are rebuilt on every filter change, so a cached airing has to be
// repainted onto whichever card element exists now instead of being skipped.
function paintAiring(channelId) {
  const record = state.airings.get(channelId);
  if (!record || !record.now) return false;
  const channel = state.byId.get(channelId);
  const now = record.now;
  // Never advertise a program that already ended; the observer will refetch.
  if (now.endsAt && now.endsAt * 1000 < Date.now()) return false;
  const labels = el.grid.querySelectorAll(`[data-airing="${cssEscape(channelId)}"]`);
  let text = now.title || 'Live program';
  // A 24/7 channel often airs a block named after itself; show the context instead.
  if (channel && now.subtitle && text.trim().toLowerCase() === channel.title.trim().toLowerCase()) {
    text = now.subtitle;
  }
  labels.forEach((label) => {
    label.textContent = text;
    label.title = [now.title, now.summary].filter(Boolean).join(' — ');
  });
  return labels.length > 0;
}

function observeCards() {
  if (state.observer) state.observer.disconnect();
  state.observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        state.observer.unobserve(entry.target);
        const id = entry.target.dataset.id;
        if (id) loadAiring(id);
      });
    },
    { rootMargin: '240px' }
  );
  el.grid.querySelectorAll('.live-card').forEach((card) => state.observer.observe(card));
}

/* ---------------------------------------------------------------- airings */

function readAiringCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(AIRING_KEY) || 'null');
    if (raw && raw.at && Date.now() - raw.at < AIRING_TTL && raw.map) return raw.map;
  } catch (_) {
    /* storage disabled */
  }
  return {};
}

function writeAiringCache() {
  try {
    const map = {};
    const now = Date.now();
    state.airings.forEach((value, key) => {
      if (now - value.at < AIRING_TTL) map[key] = value;
    });
    localStorage.setItem(AIRING_KEY, JSON.stringify({ at: now, map }));
  } catch (_) {
    /* storage disabled */
  }
}

async function loadAiring(channelId) {
  if (state.source === 'local') {
    paintAiring(channelId);
    const record = state.airings.get(channelId);
    return (record && record.now) || null;
  }
  if (state.source === 'pluto') {
    paintAiring(channelId);
    const record = state.airings.get(channelId);
    return (record && record.now) || null;
  }

  const cached = state.airings.get(channelId);
  if (cached && Date.now() - cached.at < AIRING_TTL) {
    paintAiring(channelId);
    return cached.now;
  }

  const session = state.session;
  if (!session) return null;

  let response;
  try {
    response = await fetch(
      `${PLEX.luma}/api/fragment/live-tv/airings/${encodeURIComponent(
        (state.byId.get(channelId) || {}).epgKey || channelId
      )}?${tokenQuery(session)}`,
      { headers: { Accept: 'application/json' } }
    );
  } catch (_) {
    return null;
  }
  if (!response.ok) return null;

  let list = [];
  try {
    list = await response.json();
  } catch (_) {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;

  const now = Date.now() / 1000;
  const current = list.find((item) => item.data && item.data.beginsAt <= now && item.data.endsAt > now) || list[0];
  const next = list.find((item) => item.data && item.data.beginsAt > (current.data ? current.data.endsAt : now));

  const record = {
    at: Date.now(),
    now: {
      title: pickTitle(current),
      subtitle: pickSubtitle(current),
      summary: pickSummary(current),
      beginsAt: current.data ? current.data.beginsAt : 0,
      endsAt: current.data ? current.data.endsAt : 0
    },
    next: next
      ? { title: pickTitle(next), beginsAt: next.data ? next.data.beginsAt : 0 }
      : null
  };
  state.airings.set(channelId, record);
  writeAiringCache();

  paintAiring(channelId);

  return record.now;
}

function pickTitle(item) {
  const preview = item.previewData || {};
  return preview.title || item.title || 'Live program';
}

function pickSubtitle(item) {
  const preview = item.previewData || {};
  return preview.subtitle || '';
}

function pickSummary(item) {
  const preview = item.previewData || {};
  return preview.summary || '';
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

/* ----------------------------------------------------------------- player */

async function openChannel(channel) {
  state.channel = channel;
  state.program = null;
  state.recoveries = 0;
  el.overlayChannel.textContent = channel.title;
  el.overlayTitle.textContent = channel.title;
  el.overlayProgram.textContent = 'Tuning in…';
  el.overlaySub.textContent = '';
  el.overlayNext.textContent = '';
  el.overlayProgress.style.width = '0%';
  el.overlayQuality.textContent = '';
  el.overlayError.hidden = true;
  el.overlay.hidden = false;
  document.body.classList.add('live-playing');

  if (!el.video.dataset.qualityBound) {
    el.video.dataset.qualityBound = '1';
    el.video.addEventListener('loadedmetadata', paintQuality);
    el.video.addEventListener('playing', paintQuality);
    el.video.addEventListener('resize', paintQuality);
  }

  if (channel.thumb) {
    el.overlayLogo.src = channel.thumb;
    el.overlayLogo.hidden = false;
  } else {
    el.overlayLogo.hidden = true;
  }

  await startPlayback(channel);
  refreshAiring(channel);
  state.airingTimer = window.setInterval(() => refreshAiring(channel), 60 * 1000);
}

function closeOverlay() {
  window.clearInterval(state.airingTimer);
  state.airingTimer = 0;
  window.clearTimeout(state.retuneTimer);
  state.retuneTimer = 0;
  destroyPlayer();
  el.overlay.hidden = true;
  el.video.removeAttribute('src');
  document.body.classList.remove('live-playing');
  state.channel = null;
}

async function startPlayback(channel) {
  // Rebuild the master URL per attempt so a forced boot retry can replace an
  // expired JWT without tearing the player down.
  const loadMaster = async (forceBoot = false) => {
    if (state.source === 'local') return channel.playUrl;
    if (state.source === 'pluto') return plutoUrl(channel, forceBoot);
    return `${PLEX.epg}/library/parts/${encodeURIComponent(channel.id)}.m3u8?${tokenQuery(
      state.session || (await resolveSession())
    )}`;
  };

  let master = await loadMaster();

  await loadHls();

  if (!window.Hls || !window.Hls.isSupported()) {
    // Safari and iOS play the master playlist natively; the token is already in it.
    el.video.src = master;
    autoplay();
    return;
  }

  destroyPlayer();
  const hls = new window.Hls({
    enableWorker: true,
    lowLatencyMode: false,
    // The master lists 240p first, so without an estimate ABR starts there and
    // takes a while to climb. Seed it and cap by the real player size.
    startLevel: -1,
    capLevelToPlayerSize: true,
    abrEwmaDefaultEstimate: 1600000,
    maxBufferLength: 24,
    backBufferLength: 30,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 8,
    manifestLoadingMaxRetry: 2,
    levelLoadingMaxRetry: 4,
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 800
  });
  state.hls = hls;

  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    el.overlayError.hidden = true;
    autoplay();
  });

  hls.on(window.Hls.Events.LEVEL_SWITCHED, (_, data) => {
    const level = hls.levels[data.level];
    if (level && level.height) el.overlayQuality.textContent = `${level.height}p`;
    else paintQuality();
  });

  hls.on(window.Hls.Events.ERROR, (_, data) => {
    if (!data.fatal) return;
    if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && state.recoveries < 5) {
      state.recoveries += 1;
      const delay = Math.min(6000, 600 * 2 ** state.recoveries);
      el.overlayError.hidden = false;
      el.overlayError.textContent = `Stream interrupted — retrying (${state.recoveries}/5)…`;
      window.setTimeout(async () => {
        if (!state.hls) return;
        try {
          // A 403/404 on the stitcher usually means the JWT expired mid-watch;
          // force a fresh boot before reloading.
          if (state.source === 'pluto') master = await loadMaster(true);
          state.hls.loadSource(master);
        } catch (error) {
          el.overlayError.hidden = false;
          el.overlayError.textContent = 'This channel stopped responding. Press Retry.';
        }
      }, delay);
      return;
    }
    if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && state.recoveries < 5) {
      state.recoveries += 1;
      state.hls.recoverMediaError();
      return;
    }
    el.overlayError.hidden = false;
    el.overlayError.textContent = 'This channel stopped responding. Press Retry.';
  });

  // Loading right after attachMedia avoids depending on MEDIA_ATTACHED, which
  // hls.js only emits once the MediaSource opens (and never does in a hidden tab).
  hls.attachMedia(el.video);
  hls.loadSource(master);

  await tune(channel);
}

async function tune(channel) {
  if (state.source === 'local') {
    el.overlayProgram.textContent = channel.title;
    el.overlaySub.textContent = 'Local HLS';
    el.overlayTitle.textContent = channel.title;
    state.program = null;
    return;
  }
  if (state.source === 'pluto') {
    applyPlutoProgram(channel);
    return;
  }
  try {
    const session = state.session;
    const response = await fetch(
      `${PLEX.epg}/channels/${encodeURIComponent(channel.id)}/tune?${tokenQuery(session)}`,
      { method: 'POST', headers: { Accept: 'application/json' } }
    );
    if (!response.ok) return;
    const body = await response.json();
    const subscription = body.MediaContainer && body.MediaContainer.MediaSubscription;
    const operation = subscription && subscription[0] && subscription[0].MediaGrabOperation;
    const metadata = operation && operation[0] && operation[0].Metadata;
    const item = metadata && metadata[0];
    if (!item) return;

    const media = (item.Media && item.Media[0]) || {};
    el.overlayProgram.textContent = item.title || el.overlayProgram.textContent;
    el.overlaySub.textContent = [item.grandparentTitle, item.parentIndex ? `S${item.parentIndex} E${item.index}` : '']
      .filter(Boolean)
      .join(' · ');
    el.overlayTitle.textContent = item.grandparentTitle || channel.title;

    const endsAt = media.endsAt || item.endsAt;
    const beginsAt = media.beginsAt || item.beginsAt;
    state.program = { beginsAt: beginsAt || 0, endsAt: endsAt || 0, title: item.title || '' };
    if (endsAt) {
      state.retuneAt = endsAt;
      window.clearTimeout(state.retuneTimer);
      const delay = Math.max(15000, (endsAt - Date.now() / 1000 + 5) * 1000);
      state.retuneTimer = window.setTimeout(() => {
        if (state.channel) {
          refreshAiring(state.channel);
          tune(state.channel);
        }
      }, delay);
      tickProgress();
    }
  } catch (_) {
    /* tune is informational; the master playlist already plays */
  }
}

// Pluto's guide came with the lineup, so the overlay is filled from the local
// airing record; no second request and no retune (the stream never changes).
function applyPlutoProgram(channel) {
  const record = state.airings.get(channel.id);
  const now = record && record.now;
  if (!now) return;

  const heading = (el.overlayTitle.textContent || channel.title).trim().toLowerCase();
  const duplicate = (now.title || '').trim().toLowerCase() === heading;
  const sub = cleanSubtitle(now.title, now.subtitle);
  el.overlayProgram.textContent = duplicate
    ? sub || now.title || channel.title
    : now.title || channel.title;
  el.overlaySub.textContent = duplicate ? '' : sub;
  state.program = { beginsAt: now.beginsAt, endsAt: now.endsAt, title: now.title };
  tickProgress();
}

async function refreshAiring(channel) {
  if (state.source === 'local') {
    el.overlayProgram.textContent = channel.title;
    el.overlaySub.textContent = 'Local HLS';
    el.overlayNext.textContent = '';
    return;
  }
  if (state.source === 'pluto') {
    const record = state.airings.get(channel.id);
    if (record && record.now && record.now.endsAt * 1000 < Date.now()) {
      seedPlutoAirings([channel]);
      paintAiring(channel.id);
      if (state.channel && state.channel.id === channel.id) applyPlutoProgram(channel);
    }
  }

  const now = await loadAiring(channel.id);
  if (!now) return;
  if (!state.channel || state.channel.id !== channel.id) return;

  // Some blocks repeat the heading (channel name, or the show tune() put in the
  // h2), which would print the same string twice. Demote it to the subtitle.
  const heading = (el.overlayTitle.textContent || channel.title).trim().toLowerCase();
  const duplicate = (now.title || '').trim().toLowerCase() === heading;
  const sub = cleanSubtitle(now.title, now.subtitle);
  el.overlayProgram.textContent = duplicate
    ? sub || now.title || el.overlayProgram.textContent
    : now.title || el.overlayProgram.textContent;
  el.overlaySub.textContent = duplicate ? '' : sub || el.overlaySub.textContent;

  const record = state.airings.get(channel.id);
  const nextTitle = record && record.next && record.next.title;
  const sameAsNow = record && record.now && nextTitle === record.now.title;
  // 24/7 blocks repeat the same title; "Up next" is only useful when it differs.
  el.overlayNext.textContent = nextTitle && !sameAsNow ? `Up next: ${nextTitle}` : '';
  tickProgress();
}

function tickProgress() {
  window.clearInterval(state.progressTimer);
  const draw = () => {
    const record = state.channel && state.airings.get(state.channel.id);
    const window_ = (record && record.now && record.now.beginsAt ? record.now : null) || state.program;
    if (!window_ || !window_.beginsAt || !window_.endsAt) return;
    const span = window_.endsAt - window_.beginsAt;
    const done = Math.min(1, Math.max(0, (Date.now() / 1000 - window_.beginsAt) / span));
    el.overlayProgress.style.width = `${(done * 100).toFixed(2)}%`;
  };
  draw();
  state.progressTimer = window.setInterval(draw, 15000);
}

// Pluto's master lists bitrates without RESOLUTION, so hls.js reports height 0;
// read the decoded size from the element instead.
function paintQuality() {
  const height = el.video.videoHeight;
  if (!height) return;
  // 1216x684 is Pluto's "720p" rung; snap to the familiar ladder label.
  const ladder = [1080, 720, 576, 540, 480, 360, 240];
  const near = ladder.find((step) => Math.abs(step - height) <= 40);
  el.overlayQuality.textContent = `${near || height}p`;
}

function autoplay() {
  el.video.play().catch(() => {
    // Desktop autoplay policies block sound until a gesture; start muted and say so.
    el.video.muted = true;
    el.video.play().then(showUnmuteHint).catch(hideUnmuteHint);
  });
}

function showUnmuteHint() {
  el.unmute.hidden = false;
}

function hideUnmuteHint() {
  el.unmute.hidden = true;
}

function destroyPlayer() {
  if (state.hls) {
    try {
      state.hls.destroy();
    } catch (_) {
      /* already gone */
    }
    state.hls = null;
  }
  el.video.pause();
}

/* ---------------------------------------------------------------- hls load */

let hlsPromise = null;

function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsPromise) return hlsPromise;

  hlsPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = HLS_CDN;
    script.async = true;
    const timer = window.setTimeout(() => resolve(null), 12000);
    script.onload = () => {
      window.clearTimeout(timer);
      resolve(window.Hls || null);
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    document.head.appendChild(script);
  });

  return hlsPromise;
}

/* ------------------------------------------------------------------ wiring */

function bindEvents() {
  el.search.addEventListener('input', () => {
    state.query = el.search.value.trim();
    el.searchClear.hidden = !state.query;
    render();
  });

  el.searchClear.addEventListener('click', () => {
    el.search.value = '';
    state.query = '';
    el.searchClear.hidden = true;
    el.search.focus();
    render();
  });

  el.refresh.addEventListener('click', async () => {
    state.genreMap = null;
    state.airings.clear();
    await boot(true);
  });

  el.overlayClose.addEventListener('click', closeOverlay);

  el.video.addEventListener('volumechange', () => {
    if (!el.video.muted && el.video.volume > 0) hideUnmuteHint();
  });

  el.unmute.addEventListener('click', () => {
    el.video.muted = false;
    el.video.volume = 1;
    el.video.play().catch(() => {});
    hideUnmuteHint();
  });
  el.overlayRetry.addEventListener('click', () => {
    if (!state.channel) return;
    state.recoveries = 0;
    el.overlayError.hidden = true;
    destroyPlayer();
    startPlayback(state.channel);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.overlay.hidden) closeOverlay();
  });

  window.addEventListener('online', () => {
    if (state.channel) startPlayback(state.channel);
  });
}

function showNotice(message, tone) {
  el.notice.textContent = message;
  el.notice.className = `notice${tone === 'error' ? ' error' : ''}`;
  el.notice.hidden = false;
}

function hideNotice() {
  el.notice.hidden = true;
}
