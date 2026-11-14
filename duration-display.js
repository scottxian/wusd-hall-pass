/* Hall Pilot duration display only.
 * Existing numeric minute/second fields and pass-warning thresholds are unchanged.
 * Reports: DD:HH:MM:SS. Live student timers: MM:SS.
 */
(function (root) {
  'use strict';

  function fromSeconds(value) {
    const numeric = Number(value);
    const total = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return [days, hours, minutes, seconds].map(function (part) {
      return String(part).padStart(2, '0');
    }).join(':');
  }

  // Live countdowns and elapsed student pass timers intentionally use MM:SS.
  // Minutes grow past 59 for long passes; report formats remain unchanged.
  function timerFromSeconds(value) {
    const numeric = Number(value);
    const total = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return String(minutes).padStart(2, '0') + ':' +
      String(seconds).padStart(2, '0');
  }

  function fromMinutes(value) {
    const numeric = Number(value);
    return fromSeconds(Number.isFinite(numeric) ? Math.max(0, Math.round(numeric * 60)) : 0);
  }

  root.HallPilotDuration = Object.freeze({
    fromSeconds: fromSeconds,
    fromMinutes: fromMinutes,
    timerFromSeconds: timerFromSeconds
  });
})(window);
