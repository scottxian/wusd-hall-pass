/* Hall Pilot duration display only.
 * Existing numeric minute/second fields and pass-warning thresholds are unchanged.
 * Format: DD:HH:MM:SS (days:hours:minutes:seconds).
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

  function fromMinutes(value) {
    const numeric = Number(value);
    return fromSeconds(Number.isFinite(numeric) ? Math.max(0, Math.round(numeric * 60)) : 0);
  }

  root.HallPilotDuration = Object.freeze({
    fromSeconds: fromSeconds,
    fromMinutes: fromMinutes
  });
})(window);
