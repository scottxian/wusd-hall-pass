/* Hall Pilot duration display only.
 * Existing numeric minute/second fields and pass-warning thresholds are unchanged.
 * Reports: compact d h m s (omit zero units). Live student timers: m:ss.
 */
(function (root) {
  'use strict';

  function fromSeconds(value) {
    const numeric = Number(value);
    const total = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    if (total === 0) return '0s';
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const parts = [];
    if (days) parts.push(days + 'd');
    if (hours) parts.push(hours + 'h');
    if (minutes) parts.push(minutes + 'm');
    if (seconds) parts.push(seconds + 's');
    return parts.join(' ');
  }

  // Live countdowns and elapsed student pass timers intentionally use m:ss.
  // Minutes grow past 59 for long passes; report formats remain unchanged.
  function timerFromSeconds(value) {
    const numeric = Number(value);
    const total = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return String(minutes) + ':' + String(seconds).padStart(2, '0');
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
