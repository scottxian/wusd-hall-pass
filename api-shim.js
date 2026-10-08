(function () {
  'use strict';

  function getRoomKey() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      return String(params.get('room') || '').trim().toLowerCase();
    } catch (e) {
      return '';
    }
  }

  const SESSION_KEY = 'westfield_hallpass_teacher_session';

  const STAFF_ACTIONS = new Set([
    'getTeacherDashboardState',
    'getTeacherLiveState',
    'startTeacherOverridePass',
    'cancelRequest',
    'updateStudentRestroomAccessFromDashboard',
    'updateSettingsFromDashboard',
    'updateDestinationFromDashboard',
    'addDestinationFromDashboard',
    'saveScheduleRowFromDashboard',
    'deleteScheduleRowFromDashboard',
    'clearWaitingListFromDashboard',
    'setEmergencyLockFromDashboard',
    'backupPassLogFromDashboard',
    'generatePassReport'
  ]);

  function isStaffAction(action, args) {
    if (String(action || '').startsWith('admin')) return true;
    if (STAFF_ACTIONS.has(String(action || ''))) return true;

    // startPass is normally a student/public action. When a Teacher PIN is
    // supplied, it is a privileged approval/override and must go to staff.
    if (action === 'startPass' && String((args || [])[1] || '').trim()) return true;

    return false;
  }

  function configuredApiUrl(kind) {
    const config = window.HALLPASS_CONFIG || {};
    const explicitKey = kind === 'staff' ? 'staffApiUrl' : 'publicApiUrl';
    const explicit = String(config[explicitKey] || '').trim();
    if (explicit && !explicit.includes('YOUR_PROJECT_REF')) return explicit.replace(/\/+$/, '');

    // Backward compatible with the existing V1.7 config.js. A configured
    // /hallpass URL is used only to discover the project/function base.
    const legacy = String(config.apiUrl || '').trim();
    if (!legacy || legacy.includes('YOUR_PROJECT_REF')) {
      throw new Error('Hall Pass is not connected to Supabase yet. Check config.js.');
    }

    let url;
    try {
      url = new URL(legacy);
    } catch (e) {
      throw new Error('Hall Pass config.js contains an invalid Supabase URL.');
    }

    const suffix = kind === 'staff' ? 'hallpass-staff' : 'hallpass-public';
    if (/\/functions\/v1\/hallpass(?:-(?:public|staff))?\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/hallpass(?:-(?:public|staff))?\/?$/, '/' + suffix);
      return url.toString().replace(/\/$/, '');
    }

    throw new Error('Hall Pass config.js apiUrl must point to a Supabase Hall Pass Edge Function.');
  }

  async function call(action, args) {
    args = Array.isArray(args) ? args : [];
    const staff = isStaffAction(action, args);
    const roomKey = getRoomKey();

    if (!String(action || '').startsWith('admin') && !roomKey) {
      throw new Error('This Hall Pass link is missing its room. Add ?room=d4 (or the correct room key).');
    }

    const payload = {
      action,
      args,
      roomKey
    };

    // Staff session tokens never travel to the public function.
    if (staff) payload.sessionToken = sessionStorage.getItem(SESSION_KEY) || '';

    const response = await fetch(configuredApiUrl(staff ? 'staff' : 'public'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let result;
    try {
      result = await response.json();
    } catch (e) {
      throw new Error('Hall Pass server returned an invalid response.');
    }

    if (staff && result && result._teacherSessionToken) {
      sessionStorage.setItem(SESSION_KEY, result._teacherSessionToken);
      delete result._teacherSessionToken;
    }

    if (!response.ok) {
      throw new Error(result && result.message ? result.message : 'Hall Pass server error.');
    }

    return result;
  }

  function makeRunner(successHandler, failureHandler) {
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (handler) { return makeRunner(handler, failureHandler); };
        }
        if (prop === 'withFailureHandler') {
          return function (handler) { return makeRunner(successHandler, handler); };
        }
        if (prop === 'then') return undefined;

        return function (...args) {
          call(String(prop), args)
            .then(result => {
              if (typeof successHandler === 'function') successHandler(result);
            })
            .catch(error => {
              const wrapped = { message: error && error.message ? error.message : String(error) };
              if (typeof failureHandler === 'function') failureHandler(wrapped);
              else console.error(error);
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);

  window.hallpassApi = {
    call,
    get roomKey() { return getRoomKey(); },
    clearTeacherSession() { sessionStorage.removeItem(SESSION_KEY); }
  };

  document.addEventListener('DOMContentLoaded', function () {
    const roomKey = getRoomKey();
    if (roomKey) document.documentElement.dataset.room = roomKey;

    // The student kiosk must never retain a staff session. This also clears any
    // legacy V1.7 session that may have been minted by a teacher-approved pass.
    const page = String(window.location.pathname || '').split('/').pop().toLowerCase();
    if (!page || page === 'index.html') sessionStorage.removeItem(SESSION_KEY);
  });
})();
