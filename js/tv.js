// CineStream — edição para TVs com navegador antigo.
//
// O motor da TV Philco roda um Chrome 47 (2015): sem async/await, sem
// URLSearchParams, sem variáveis de CSS, sem grid e sem instalação de PWA.
// Tudo aqui é ES5 puro, requisições com XMLHttpRequest e o hls.js empacotado
// em ES5. O MediaSource vem com prefixo nesse navegador, então ele é
// renomeado antes do hls.js olhar.

(function () {
  'use strict';

  var PROXY = 'https://cinestream-pluto-proxy.claudia-ingles.workers.dev';
  var CHANNEL_FILE = 'data/pluto-channels.json';
  var BOOT_QUERY = {
    appName: 'web',
    appVersion: '5.14.0-0f5ca672f515a62078d2ec0ad2',
    clientID: '33333333-3333-4333-8333-333333333333',
    clientModelNumber: '1.0.0',
    clientTime: '2026-11-10T00:00:00.000Z',
    deviceMake: 'chrome',
    deviceModel: 'web',
    deviceType: 'web',
    deviceVersion: '131.0.0.0',
    serverSideAds: 'false'
  };

  var state = {
    channels: [],
    filtered: [],
    category: 'all',
    query: '',
    session: null,
    hls: null
  };

  var el = {};

  /* ---------------------------------------------------------- ferramentas */

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
          if (onFail) onFail('Resposta inválida de ' + url);
        }
      } else if (onFail) {
        onFail('HTTP ' + xhr.status + ' em ' + url);
      }
    };
    xhr.onerror = function () {
      if (onFail) onFail('Sem conexão com ' + url);
    };
    xhr.send(null);
  }

  function queryString(fields) {
    var parts = [];
    for (var key in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      if (fields[key] === null || fields[key] === undefined) continue;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(fields[key]));
    }
    return parts.join('&');
  }

  function proxied(target) {
    var host = target.replace('https://', '').split('/')[0];
    var rest = target.replace('https://' + host, '');
    return PROXY + '/p/' + host + rest;
  }

  function addClass(node, name) {
    if ((' ' + node.className + ' ').indexOf(' ' + name + ' ') === -1) {
      node.className = node.className ? node.className + ' ' + name : name;
    }
  }

  /* -------------------------------------------------------------- dados */

  function loadChannels() {
    request(CHANNEL_FILE, function (payload) {
      var items = payload && payload.items ? payload.items : payload;
      if (!items || !items.length) {
        el.status.textContent = 'Catálogo vazio';
        return;
      }
      state.channels = items;
      state.session = null;
      buildChips();
      applyFilter();
      el.status.textContent = items.length + ' canais';
    }, function (error) {
      el.status.textContent = 'Falha ao carregar: ' + error;
    });
  }

  function categories() {
    var seen = {};
    var list = [];
    for (var i = 0; i < state.channels.length; i += 1) {
      var name = state.channels[i].category;
      if (!name || seen[name]) continue;
      seen[name] = true;
      list.push(name);
    }
    list.sort(function (a, b) { return a.localeCompare(b); });
    return list;
  }

  function buildChips() {
    var chips = el.chips;
    while (chips.firstChild) chips.removeChild(chips.firstChild);

    var names = ['all'].concat(categories());
    for (var i = 0; i < names.length; i += 1) {
      (function (value) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tv-chip';
        chip.textContent = value === 'all' ? 'Todos' : value;
        chip.setAttribute('data-category', value);
        if (value === state.category) addClass(chip, 'is-active');
        chip.onclick = function () {
          state.category = value;
          var all = chips.getElementsByTagName('button');
          for (var j = 0; j < all.length; j += 1) {
            all[j].className = all[j].className.replace(' is-active', '');
          }
          addClass(chip, 'is-active');
          applyFilter();
        };
        chips.appendChild(chip);
      })(names[i]);
    }
  }

  function applyFilter() {
    var query = state.query.toLowerCase();
    var list = [];
    for (var i = 0; i < state.channels.length; i += 1) {
      var channel = state.channels[i];
      if (state.category !== 'all' && channel.category !== state.category) continue;
      if (query && channel.name.toLowerCase().indexOf(query) === -1) continue;
      list.push(channel);
    }
    state.filtered = list;
    renderGrid();
  }

  /* ------------------------------------------------------------- grade */

  function renderGrid() {
    var grid = el.grid;
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    if (!state.filtered.length) {
      var empty = document.createElement('p');
      empty.className = 'tv-empty';
      empty.textContent = 'Nenhum canal com esse nome.';
      grid.appendChild(empty);
      return;
    }

    for (var i = 0; i < state.filtered.length; i += 1) {
      grid.appendChild(buildCard(state.filtered[i]));
    }
  }

  function buildCard(channel) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'tv-card';

    var art = document.createElement('span');
    art.className = 'tv-card-art';

    var logo = document.createElement('span');
    logo.className = 'tv-card-logo';
    var thumb = channel.colorLogoPNG && channel.colorLogoPNG.path
      ? channel.colorLogoPNG.path
      : (channel.tile && channel.tile.path ? channel.tile.path : '');
    if (thumb) {
      var image = document.createElement('img');
      image.src = thumb;
      image.alt = '';
      logo.appendChild(image);
    } else {
      logo.textContent = channel.name.substr(0, 2).toUpperCase();
    }
    art.appendChild(logo);

    var badge = document.createElement('span');
    badge.className = 'tv-badge tv-badge-art';
    var dot = document.createElement('span');
    dot.className = 'tv-dot';
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode('LIVE'));
    art.appendChild(badge);

    if (channel.audio === 'dubbed') {
      var dub = document.createElement('span');
      dub.className = 'tv-dub';
      dub.textContent = 'Dublado';
      art.appendChild(dub);
    }

    var meta = document.createElement('span');
    meta.className = 'tv-card-meta';
    var name = document.createElement('span');
    name.className = 'tv-card-title';
    name.textContent = channel.name;
    var category = document.createElement('span');
    category.className = 'tv-card-cat';
    category.textContent = channel.category || 'Canal';
    meta.appendChild(name);
    meta.appendChild(category);

    card.appendChild(art);
    card.appendChild(meta);
    card.onclick = function () { openChannel(channel); };
    return card;
  }

  /* ------------------------------------------------------------ player */

  function bootSession(onDone, onFail) {
    if (state.session) {
      onDone(state.session);
      return;
    }
    var url = PROXY + '/p/boot.pluto.tv/v4/start?' + queryString(BOOT_QUERY);
    request(url, function (data) {
      if (!data || !data.sessionToken || !data.servers || !data.servers.stitcher) {
        if (onFail) onFail('Sessão do Pluto inválida');
        return;
      }
      var params = {};
      var raw = String(data.stitcherParams || '').split('&');
      for (var i = 0; i < raw.length; i += 1) {
        if (raw[i].indexOf('=') === -1) continue;
        var pair = raw[i].split('=');
        params[pair[0]] = pair[1] ? pair[1] : 'na';
      }
      state.session = {
        token: data.sessionToken,
        stitcher: String(data.servers.stitcher).replace(/\/+$/, ''),
        params: params
      };
      onDone(state.session);
    }, onFail);
  }

  function masterUrl(session, channelId) {
    var query = queryString({
      jwt: session.token,
      masterJWTPassthrough: 'true',
      includeExtendedEvents: 'true'
    });
    var extra = queryString(session.params);
    var host = session.stitcher.replace('https://', '');
    return PROXY + '/p/' + host + '/v2/stitch/hls/channel/' +
      encodeURIComponent(channelId) + '/master.m3u8?' + query + '&' + extra;
  }

  function openChannel(channel) {
    el.overlay.setAttribute('aria-hidden', 'false');
    el.overlay.className = 'tv-overlay is-open';
    el.stageName.textContent = channel.name;
    el.stageTitle.textContent = channel.name;
    el.stageNote.textContent = channel.audio === 'dubbed'
      ? 'Áudio dublado em português'
      : 'Áudio original com legenda em português';
    el.error.hidden = true;
    el.stageNote.className = 'tv-stage-note';

    bootSession(function (session) {
      var url = masterUrl(session, channel._id);
      startPlayback(url);
    }, function (error) {
      showError(error);
    });
  }

  function startPlayback(url) {
    destroyPlayback();

    if (!window.Hls || !window.Hls.isSupported()) {
      el.video.src = url;
      el.video.play();
      return;
    }

    var hls = new window.Hls({
      enableWorker: false,
      lowLatencyMode: false,
      startLevel: 0,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 3,
      fragLoadingMaxRetry: 4
    });
    state.hls = hls;

    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      el.video.play();
    });
    hls.on(window.Hls.Events.ERROR, function (event, data) {
      if (!data || !data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      showError('Não foi possível reproduzir este canal.');
    });

    hls.loadSource(url);
    hls.attachMedia(el.video);
  }

  function destroyPlayback() {
    if (state.hls) {
      try { state.hls.destroy(); } catch (error) { /* ignore */ }
      state.hls = null;
    }
    el.video.removeAttribute('src');
    try { el.video.load(); } catch (error) { /* ignore */ }
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function closePlayer() {
    destroyPlayback();
    el.overlay.className = 'tv-overlay';
    el.overlay.setAttribute('aria-hidden', 'true');
  }

  /* -------------------------------------------------------------- init */

  function init() {
    el.status = byId('tvStatus');
    el.chips = byId('tvChips');
    el.grid = byId('tvGrid');
    el.search = byId('tvSearch');
    el.overlay = byId('tvOverlay');
    el.video = byId('tvVideo');
    el.stageName = byId('tvStageName');
    el.stageTitle = byId('tvStageTitle');
    el.stageNote = byId('tvStageNote');
    el.error = byId('tvError');
    el.close = byId('tvClose');

    // O Chrome 47 só expõe o MediaSource com prefixo.
    if (!window.MediaSource && window.webkitMediaSource) {
      window.MediaSource = window.webkitMediaSource;
    }

    el.close.onclick = closePlayer;

    byId('tvSearchForm').onsubmit = function (event) {
      event.preventDefault();
      return false;
    };

    var timer = null;
    el.search.oninput = function () {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        state.query = el.search.value || '';
        applyFilter();
      }, 250);
    };

    loadChannels();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
