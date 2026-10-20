// Shared "Continue watching" storage used by the catalog and the player.
// Only the title identity and the last opened episode are stored; the
// cross-origin player does not expose playback progress to this page.

'use strict';

(function () {
  const KEY = 'cinestream:recent:v1';
  const LIMIT = 12;
  const TYPES = ['movie', 'series', 'anime'];

  function cleanText(value, maxLength) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  function toInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function toNumber(value, min, max, fallback) {
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const type = TYPES.includes(raw.type) ? raw.type : '';
    if (!type) return null;

    const title = cleanText(raw.title, 300);
    if (!title) return null;

    const tm = /^\d{1,12}$/.test(String(raw.tm || '')) ? String(raw.tm) : '';
    const im = /^tt\d{5,12}$/.test(String(raw.im || '')) ? String(raw.im) : '';
    if (!tm && !im) return null;

    const entry = {
      type,
      title,
      tm,
      im,
      year: toInt(raw.year, 0, 2100, 0),
      rating: toNumber(raw.rating, 0, 10, 0),
      seasons: toInt(raw.seasons, 0, 200, 0),
      poster: /^(?:\/|https:\/\/image\.tmdb\.org\/)/.test(String(raw.poster || ''))
        ? cleanText(raw.poster, 500)
        : '',
      updatedAt: toInt(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0) || Date.now()
    };

    if (type !== 'movie') {
      entry.season = toInt(raw.season, 1, 200, 1);
      entry.episode = toInt(raw.episode, 1, 999, 1);
    }

    return entry;
  }

  function keyOf(entry) {
    return entry.type + ':' + (entry.tm || entry.im);
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(raw)) return [];

      const seen = new Set();
      const list = [];

      raw.forEach((item) => {
        const entry = normalize(item);
        if (!entry) return;
        const key = keyOf(entry);
        if (seen.has(key)) return;
        seen.add(key);
        list.push(entry);
      });

      list.sort((a, b) => b.updatedAt - a.updatedAt);
      return list.slice(0, LIMIT);
    } catch (error) {
      return [];
    }
  }

  function save(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT)));
    } catch (error) {
      // Private mode or a full quota: the catalog still works without history.
    }
  }

  function remember(raw) {
    const entry = normalize({ ...raw, updatedAt: Date.now() });
    if (!entry) return null;

    const key = keyOf(entry);
    const list = load().filter((item) => keyOf(item) !== key);
    list.unshift(entry);
    save(list);
    return entry;
  }

  function removeKey(key) {
    if (!key) return;
    save(load().filter((item) => keyOf(item) !== key));
  }

  function remove(raw) {
    const entry = normalize(raw);
    if (entry) removeKey(keyOf(entry));
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch (error) {
      // Ignore storage errors.
    }
  }

  function href(entry) {
    const params = new URLSearchParams();
    params.set('ty', entry.type);
    params.set('title', entry.title);
    if (entry.tm) params.set('tm', entry.tm);
    if (entry.im) params.set('im', entry.im);
    if (entry.year) params.set('y', entry.year);
    if (entry.seasons) params.set('s', entry.seasons);
    if (entry.type !== 'movie') {
      params.set('se', entry.season || 1);
      params.set('ep', entry.episode || 1);
    }
    if (entry.poster) params.set('p', entry.poster);
    if (entry.rating) params.set('r', entry.rating);
    return 'player.html?' + params.toString();
  }

  function label(entry) {
    if (entry.type === 'movie') return 'Movie';
    return 'S' + (entry.season || 1) + 'E' + (entry.episode || 1);
  }

  window.CineStreamRecent = {
    STORAGE_KEY: KEY,
    load,
    remember,
    remove,
    removeKey,
    clear,
    href,
    label,
    keyOf
  };
})();
