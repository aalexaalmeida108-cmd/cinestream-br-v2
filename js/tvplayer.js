// CineStream — player de filmes para a TV.
//
// O embed do VidSrc roda em ES5 e foi verificado compatível com o Chrome 47
// da TV, então a página só precisa montar a URL e colocar o embed num iframe.
// Tudo aqui é ES5: sem arrow, sem async, sem URLSearchParams.

(function () {
  'use strict';

  var CATALOG = 'data/tv-catalog.json';
  var SOURCES = [
    {
      id: 'vidsrc',
      label: 'VidSrc',
      url: function (item, season, episode) {
        if (item.ty === 'movie') {
          return 'https://vidsrc.buzz/embed/movie/' + encodeURIComponent(item.tm || item.im);
        }
        return 'https://vidsrc.buzz/embed/tv/' + encodeURIComponent(item.tm) +
          '/' + (season || 1) + '/' + (episode || 1);
      }
    },
    {
      id: 'vidlink',
      label: 'VidLink',
      url: function (item, season, episode) {
        if (item.ty === 'movie') {
          return 'https://vidlink.pro/movie/' + encodeURIComponent(item.tm || item.im);
        }
        return 'https://vidlink.pro/tv/' + encodeURIComponent(item.tm) +
          '/' + (season || 1) + '/' + (episode || 1);
      }
    }
  ];

  var state = {
    items: [],
    filtered: [],
    query: '',
    type: 'all'
  };

  var el = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function request(url, onDone, onFail) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          onDone(JSON.parse(xhr.responseText));
        } catch (error) {
          if (onFail) onFail('Resposta inválida');
        }
      } else if (onFail) {
        onFail('HTTP ' + xhr.status);
      }
    };
    xhr.onerror = function () {
      if (onFail) onFail('Sem conexão');
    };
    xhr.send(null);
  }

  function queryParam(name) {
    var match = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
  }

  function addClass(node, name) {
    if ((' ' + node.className + ' ').indexOf(' ' + name + ' ') === -1) {
      node.className = node.className ? node.className + ' ' + name : name;
    }
  }

  function loadCatalog() {
    request(CATALOG, function (payload) {
      var items = (payload && payload.items) || [];
      if (!items.length) return;
      state.items = items;
      buildChips();
      applyFilter();
    });
  }

  function buildChips() {
    var chips = el.chips;
    while (chips.firstChild) chips.removeChild(chips.firstChild);
    var kinds = [
      ['all', 'Todos'],
      ['movie', 'Filmes'],
      ['series', 'Séries'],
      ['anime', 'Anime']
    ];
    for (var i = 0; i < kinds.length; i += 1) {
      (function (value, label) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tv-chip';
        chip.textContent = label;
        if (value === state.type) addClass(chip, 'is-active');
        chip.onclick = function () {
          state.type = value;
          var all = chips.getElementsByTagName('button');
          for (var j = 0; j < all.length; j += 1) {
            all[j].className = all[j].className.replace(' is-active', '');
          }
          addClass(chip, 'is-active');
          applyFilter();
        };
        chips.appendChild(chip);
      })(kinds[i][0], kinds[i][1]);
    }
  }

  function applyFilter() {
    var query = state.query.toLowerCase();
    var list = [];
    for (var i = 0; i < state.items.length; i += 1) {
      var item = state.items[i];
      if (state.type !== 'all' && item.ty !== state.type) continue;
      if (query && item.t.toLowerCase().indexOf(query) === -1) continue;
      list.push(item);
    }
    state.filtered = list;
    render();
  }

  function render() {
    var grid = el.grid;
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    var limit = Math.min(state.filtered.length, 120);
    for (var i = 0; i < limit; i += 1) {
      grid.appendChild(buildCard(state.filtered[i]));
    }
    if (!limit) {
      var empty = document.createElement('p');
      empty.className = 'tv-empty';
      empty.textContent = 'Nada encontrado.';
      grid.appendChild(empty);
    }
  }

  function buildCard(item) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'tv-card';

    var art = document.createElement('span');
    art.className = 'tv-card-art';
    if (item.p) {
      var poster = document.createElement('img');
      poster.className = 'tv-card-poster';
      poster.src = 'https://image.tmdb.org/t/p/w500' + item.p;
      poster.alt = '';
      art.appendChild(poster);
    }

    var meta = document.createElement('span');
    meta.className = 'tv-card-meta';
    var name = document.createElement('span');
    name.className = 'tv-card-title';
    name.textContent = item.t;
    var info = document.createElement('span');
    info.className = 'tv-card-cat';
    info.textContent = item.y + (item.r ? ' · ' + item.r : '') +
      (item.ty === 'series' && item.s ? ' · ' + item.s + ' temporadas' : '');
    meta.appendChild(name);
    meta.appendChild(info);

    card.appendChild(art);
    card.appendChild(meta);
    card.onclick = function () { openTitle(item); };
    return card;
  }

  function openTitle(item) {
    el.overlay.className = 'tv-overlay is-open';
    el.overlay.setAttribute('aria-hidden', 'false');
    el.stageName.textContent = item.t;
    el.stageTitle.textContent = item.t;
    el.stageNote.textContent = 'Escolha a fonte';
    el.error.hidden = true;

    el.frame.src = SOURCES[0].url(item, 1, 1);
    el.source = SOURCES[0];
    el.item = item;

    // Seletor de fonte e, para séries, de temporada e episódio.
    var foot = el.stageNote;
    while (foot.firstChild) foot.removeChild(foot.firstChild);

    var sources = document.createElement('span');
    sources.className = 'tv-source-row';
    for (var i = 0; i < SOURCES.length; i += 1) {
      (function (source) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'tv-source-btn' + (source === SOURCES[0] ? ' is-active' : '');
        button.textContent = source.label;
        button.onclick = function () {
          el.source = source;
          var all = sources.getElementsByTagName('button');
          for (var j = 0; j < all.length; j += 1) {
            all[j].className = all[j].className.replace(' is-active', '');
          }
          addClass(button, 'is-active');
          el.frame.src = source.url(el.item, el.season || 1, el.episode || 1);
        };
        sources.appendChild(button);
      })(SOURCES[i]);
    }
    foot.appendChild(sources);

    if (item.ty !== 'movie') {
      var season = document.createElement('select');
      season.className = 'tv-mini-select';
      season.onchange = function () {
        el.season = parseInt(season.value, 10) || 1;
        el.frame.src = el.source.url(el.item, el.season, el.episode || 1);
      };
      var max = Math.min(item.s || 1, 30);
      for (var s = 1; s <= max; s += 1) {
        var option = document.createElement('option');
        option.value = String(s);
        option.textContent = 'Temporada ' + s;
        season.appendChild(option);
      }
      el.season = 1;
      foot.appendChild(season);

      var episode = document.createElement('select');
      episode.className = 'tv-mini-select';
      for (var e = 1; e <= 30; e += 1) {
        var ep = document.createElement('option');
        ep.value = String(e);
        ep.textContent = 'Episódio ' + e;
        episode.appendChild(ep);
      }
      episode.onchange = function () {
        el.episode = parseInt(episode.value, 10) || 1;
        el.frame.src = el.source.url(el.item, el.season || 1, el.episode);
      };
      foot.appendChild(episode);
    }
  }

  function init() {
    el.chips = byId('tvPlayerChips');
    el.grid = byId('tvPlayerGrid');
    el.search = byId('tvPlayerSearch');
    el.overlay = byId('tvOverlay');
    el.frame = byId('tvFrame');
    el.stageName = byId('tvStageName');
    el.stageTitle = byId('tvStageTitle');
    el.stageNote = byId('tvStageNote');
    el.error = byId('tvError');
    el.close = byId('tvClose');
    el.source = SOURCES[0];
    el.season = 1;
    el.episode = 1;

    el.close.onclick = function () {
      el.frame.src = 'about:blank';
      el.overlay.className = 'tv-overlay';
      el.overlay.setAttribute('aria-hidden', 'true');
    };

    byId('tvPlayerForm').onsubmit = function (event) {
      event.preventDefault();
      return false;
    };

    var timer = null;
    el.search.oninput = function () {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        state.query = el.search.value || '';
        applyFilter();
      }, 300);
    };

    loadCatalog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
