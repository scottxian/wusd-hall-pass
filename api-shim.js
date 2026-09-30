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

  function getApiUrl() {
    const url = window.HALLPASS_CONFIG && String(window.HALLPASS_CONFIG.apiUrl || '').trim();
    if (!url || url.includes('YOUR_PROJECT_REF')) {
      throw new Error('Hall Pass is not connected to Supabase yet. Edit web/config.js first.');
    }
    return url;
  }

  async function call(action, args) {
    const roomKey = getRoomKey();
    if (!action.startsWith('admin') && !roomKey) {
      throw new Error('This Hall Pass link is missing its room. Add ?room=d4 (or the correct room key).');
    }

    const response = await fetch(getApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        args: Array.isArray(args) ? args : [],
        roomKey,
        sessionToken: sessionStorage.getItem(SESSION_KEY) || ''
      })
    });

    let result;
    try {
      result = await response.json();
    } catch (e) {
      throw new Error('Hall Pass server returned an invalid response.');
    }

    if (result && result._teacherSessionToken) {
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
  });
})();
