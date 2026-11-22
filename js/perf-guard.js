// Runtime guard. No dependencies; load it before app.js so the page watches
// itself from the first paint.
//
// A frozen main thread cannot be unblocked from inside the page. What this
// does instead:
//   - drops the interface to a lighter tier after a stall, so the next
//     interaction survives;
//   - steps the tier back up after a calm window, so the page is not stuck
//     degraded forever;
//   - when one stall is long enough to count as a freeze (6s by default),
//     reloads once into the lighter tier, with a cooldown so it cannot loop;
//   - keeps a short report for diagnosis.
(function () {
  'use strict';

  var cfg = window.PERF_GUARD_CONFIG || {};
  function limit(name, fallback) {
    var value = cfg[name];
    return typeof value === 'number' && value > 0 ? value : fallback;
  }

  var TIERS = ['full', 'lite', 'minimal'];
  var STALL_MS = 120;       // a measured block at or above this counts
  var FRAME_GAP_MS = 350;   // a dropped-frame gap at or above this counts
  var HARD_MS = 900;        // one stall this long forces tier 1
  var WINDOW_MS = 15000;
  var CALM_MS = limit('calmMs', 45000);      // quiet time before stepping back up
  var RELOAD_MS = limit('reloadMs', 6000);   // one stall this long is a freeze
  var COOLDOWN_MS = limit('cooldownMs', 600000);
  var RELOAD_KEY = 'cinestream:perfguard:reload';
  var REPORT_KEY = 'cinestream:perfguard:last';

  var tier = 0;
  var events = [];
  var started = false;
  var startedAt = 0;
  var observer = null;
  var longTask = false;
  var rafId = 0;
  var lastFrame = 0;
  var worker = null;
  var reloading = false;
  var ticker = 0;
  var lastStall = null;

  function clock() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  function storageGet(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (error) {
      // Storage can be unavailable in private mode; the guard still works.
    }
  }

  function recent(minMs, span) {
    var now = clock();
    var count = 0;
    for (var i = events.length - 1; i >= 0; i -= 1) {
      if (now - events[i].at > span) break;
      if (events[i].ms >= minMs) count += 1;
    }
    return count;
  }

  function setTier(next) {
    tier = next;
    if (next === 0) {
      document.documentElement.removeAttribute('data-perf');
    } else {
      document.documentElement.setAttribute('data-perf', TIERS[next]);
    }
    document.dispatchEvent(new CustomEvent('perfchange', {
      detail: { tier: next, name: TIERS[next] }
    }));
  }

  function snapshot(reason) {
    return {
      reason: reason,
      at: Date.now(),
      tier: tier,
      events: events.slice(-20)
    };
  }

  function reload() {
    if (reloading || !started) return;
    if (document.visibilityState === 'hidden') return;
    // A reload under an open dialog throws away what the reader is doing.
    if (document.body && document.body.classList.contains('has-modal')) return;
    var previous = Number(storageGet(RELOAD_KEY)) || 0;
    if (Date.now() - previous < COOLDOWN_MS) return;

    reloading = true;
    storageSet(RELOAD_KEY, String(Date.now()));
    storageSet(REPORT_KEY, JSON.stringify(snapshot('reload')));
    document.documentElement.setAttribute('data-perf', 'minimal');
    window.setTimeout(function () {
      window.location.reload();
    }, 40);
  }

  function applyStall(ms) {
    if (ms >= RELOAD_MS) {
      setTier(2);
      reload();
      return;
    }
    var next = tier;
    if (tier === 0 && (ms >= HARD_MS ||
        recent(600, WINDOW_MS) >= 2 || recent(STALL_MS, 5000) >= 6)) {
      next = 1;
    }
    if (tier === 1 && (ms >= HARD_MS * 1.7 ||
        recent(600, WINDOW_MS) >= 4 || recent(STALL_MS, 5000) >= 12)) {
      next = 2;
    }
    if (next !== tier) setTier(next);
  }

  function record(ms, source) {
    if (!(ms > 0) || reloading) return;
    var now = clock();
    var value = Math.round(ms);

    // One freeze reaches us through several channels (dropped frame, long
    // task, worker heartbeat) within a few frames. Keep a single event and
    // let the largest measurement win.
    if (lastStall && now - lastStall.at < 300) {
      if (value > lastStall.ms) {
        lastStall.ms = value;
        lastStall.source = source;
        applyStall(value);
      }
      return;
    }

    lastStall = { at: now, ms: value, source: source };
    events.push(lastStall);
    if (events.length > 60) events.shift();
    applyStall(value);

    document.dispatchEvent(new CustomEvent('perfstall', {
      detail: { ms: value, source: source }
    }));
  }

  // Back off one tier after a quiet window so a single bad minute does not
  // leave the page degraded for the rest of the session. The decision waits
  // for one frame: the guard's frame loop runs first and records the stall
  // that just ended, so recovery cannot step down on a stale count.
  function recover() {
    if (!started || reloading || tier === 0) return;
    if (document.visibilityState === 'hidden') return;
    window.requestAnimationFrame(function () {
      if (!started || reloading || tier === 0) return;
      var now = clock();
      var last = events.length ? events[events.length - 1].at : startedAt;
      if (now - last < CALM_MS) return;
      setTier(tier - 1);
    });
  }

  // A rAF loop catches frame drops (image decode, layout, long tasks).
  function frame(timestamp) {
    if (!started) return;
    if (lastFrame) {
      var gap = timestamp - lastFrame;
      if (gap >= FRAME_GAP_MS && !document.hidden) record(gap, 'frame');
    }
    lastFrame = timestamp;
    rafId = window.requestAnimationFrame(frame);
  }

  // A worker pings every second and reports when the page stops answering.
  // This is the only signal that survives a completely frozen main thread.
  var WORKER_SRC = [
    'var timer=null, iv=null, last=0;',
    'function beat(){ postMessage("ping"); if(timer) clearTimeout(timer);',
    '  timer=setTimeout(function(){ postMessage({hang: Date.now()-last}); }, 2500); }',
    'function start(){ if(iv) return; last=Date.now(); beat(); iv=setInterval(beat, 1000); }',
    'function stop(){ if(iv){ clearInterval(iv); iv=null; }',
    '  if(timer){ clearTimeout(timer); timer=null; } }',
    'onmessage=function(e){',
    '  if(e.data==="pong"){ last=Date.now(); if(timer){ clearTimeout(timer); timer=null; } }',
    '  else if(e.data==="resume"){ start(); }',
    '  else if(e.data==="pause"){ stop(); }',
    '};',
    'start();'
  ].join('');

  function startHeartbeat() {
    if (worker || typeof Worker !== 'function' || typeof Blob !== 'function') return;
    try {
      var url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = function (event) {
        if (event.data === 'ping') {
          worker.postMessage('pong');
          return;
        }
        if (event.data && typeof event.data.hang === 'number') {
          record(Math.max(event.data.hang, 2500), 'heartbeat');
        }
      };
      if (document.hidden) worker.postMessage('pause');
    } catch (error) {
      worker = null;
    }
  }

  function onVisibility() {
    lastFrame = 0;
    if (worker) worker.postMessage(document.hidden ? 'pause' : 'resume');
  }

  function start() {
    if (started) return;
    started = true;
    startedAt = clock();

    if ('PerformanceObserver' in window) {
      try {
        observer = new PerformanceObserver(function (list) {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i += 1) {
            if (entries[i].duration >= 80) record(entries[i].duration, 'longtask');
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
        longTask = true;
      } catch (error) {
        observer = null;
      }
    }

    // A reload from a freeze boots lighter; the calm timer can lift it back.
    var stamp = Number(storageGet(RELOAD_KEY)) || 0;
    if (stamp && Date.now() - stamp < COOLDOWN_MS) setTier(1);

    document.addEventListener('visibilitychange', onVisibility);
    rafId = window.requestAnimationFrame(frame);
    ticker = window.setInterval(recover, Math.max(1000, Math.min(5000, Math.floor(CALM_MS / 3))));
    startHeartbeat();
  }

  function stop() {
    started = false;
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = 0;
    if (ticker) window.clearInterval(ticker);
    ticker = 0;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    document.removeEventListener('visibilitychange', onVisibility);
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  // Time a synchronous block; record() folds it into the same stall if a
  // frame gap or long task already reported it.
  function measure(label, fn) {
    var began = clock();
    try {
      return fn();
    } finally {
      var ms = clock() - began;
      if (ms >= STALL_MS) record(ms, label);
    }
  }

  function schedule(fn) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(fn, { timeout: 800 });
    } else {
      window.setTimeout(fn, 16);
    }
  }

  // Run a list in idle slices. Resolves when every item has been visited.
  function chunk(list, step, size) {
    var index = 0;
    return new Promise(function (resolve) {
      function slice() {
        var end = Math.min(index + (size || 200), list.length);
        for (; index < end; index += 1) step(list[index], index);
        if (index < list.length) schedule(slice);
        else resolve();
      }
      slice();
    });
  }

  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) start();
  });

  window.PerfGuard = {
    start: start,
    stop: stop,
    measure: measure,
    chunk: chunk,
    clear: function () {
      events = [];
      lastStall = null;
      setTier(0);
    },
    report: function () {
      return { tier: tier, name: TIERS[tier], events: events.slice(), started: started, longTask: longTask };
    },
    last: function () {
      var raw = storageGet(REPORT_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    },
    get tier() { return tier; }
  };

  start();
})();
