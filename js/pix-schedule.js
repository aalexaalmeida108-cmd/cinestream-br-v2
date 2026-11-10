// PIX reminder schedule.
//
// The donation strip lives on a fixed calendar cycle: 3 days visible, then 28
// days hidden, repeating every 31 days. The anchor is a plain date, so every
// visitor sees the same window regardless of browser, cache or local storage,
// and nothing has to be stored on the device.
//
// This file is loaded synchronously in <head> on purpose: it runs before the
// first paint, so a hidden window never flashes the strip for a frame.
//
// Override for testing or a manual campaign:
//   ?pix=on    force the strip on
//   ?pix=off   force the strip off

(function () {
  'use strict';

  // First day of a visible window. Change this one line to shift the calendar.
  var ANCHOR = { year: 2026, month: 11, day: 10 };

  var VISIBLE_DAYS = 3;
  var HIDDEN_DAYS = 28;
  var CYCLE_DAYS = VISIBLE_DAYS + HIDDEN_DAYS;

  function dayNumber(now) {
    // Date-only arithmetic in UTC so daylight saving never shifts the window.
    var anchor = Date.UTC(ANCHOR.year, ANCHOR.month - 1, ANCHOR.day);
    var today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - anchor) / 86400000);
  }

  function positionInCycle(now) {
    var day = dayNumber(now);
    return ((day % CYCLE_DAYS) + CYCLE_DAYS) % CYCLE_DAYS;
  }

  function isVisible(now) {
    return positionInCycle(now || new Date()) < VISIBLE_DAYS;
  }

  function daysUntilVisible(now) {
    var position = positionInCycle(now || new Date());
    return position < VISIBLE_DAYS ? 0 : CYCLE_DAYS - position;
  }

  function forcedState() {
    try {
      var value = new URLSearchParams(window.location.search).get('pix');
      if (value === 'on' || value === '1') return true;
      if (value === 'off' || value === '0') return false;
    } catch (error) {
      // Older browsers without URLSearchParams: fall through to the schedule.
    }
    return null;
  }

  var forced = forcedState();
  var visible = forced === null ? isVisible() : forced;

  if (!visible) {
    document.documentElement.className += ' pix-off';
  }

  window.CinePix = {
    isVisible: isVisible,
    daysUntilVisible: daysUntilVisible,
    positionInCycle: positionInCycle,
    anchor: ANCHOR,
    cycleDays: CYCLE_DAYS,
    visibleDays: VISIBLE_DAYS
  };
})();
