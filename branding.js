/* Hall Pilot presentation only — does not make API calls or alter hall passes. */
(function () {
  'use strict';

  /* School logos are keyed by BOTH organization and school to avoid collisions.
     To onboard a new logo, upload its image and add one entry below.
     This is a static-file registry, not a school-admin upload feature. */
  const schools = Object.freeze({
    'wusd/westfield': {
      name: 'Westfield Village Elementary School',
      logo: 'assets/schools/wusd--westfield.webp'
    }
  });

  function safeKey(value) {
    const key = String(value == null ? '' : value).trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) ? key : '';
  }

  let banner = null;
  let schoolText = null;
  let schoolLogo = null;
  let currentLogo = '';
  let studentRoomTitle = null;
  let activePage = 'student';
  let installButton = null;
  let studentInstallAllowed = false; // Fail closed until this room's public settings load.
  let installPrompt = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function initialize() {
    if (banner || !document.body) return;
    banner = el('div', 'hp-brand-bar');
    banner.setAttribute('aria-label', 'Hall Pilot and school branding');

    const inner = el('div', 'hp-brand-inner');
    const middle = el('div', 'hp-brand-middle');
    const product = el('div', 'hp-brand-product');
    const mark = el('img', 'hp-brand-mark');
    mark.src = 'assets/hall-pilot-mark.svg';
    mark.alt = '';
    mark.width = 48;
    mark.height = 48;
    const productWords = el('div', 'hp-brand-words');
    productWords.appendChild(el('strong', 'hp-brand-name', 'Hall Pilot'));
    productWords.appendChild(el('span', 'hp-brand-tagline', 'Digital hall pass'));
    installButton = el('button', 'hp-install-link', '↓ Install App');
    installButton.type = 'button';
    installButton.hidden = true;
    installButton.setAttribute('aria-haspopup', 'dialog');
    installButton.addEventListener('click', showInstallPopup);
    productWords.appendChild(installButton);
    product.appendChild(mark);
    product.appendChild(productWords);

    const school = el('div', 'hp-brand-school');
    schoolLogo = el('img', 'hp-brand-school-logo');
    schoolLogo.alt = '';
    schoolLogo.hidden = true;
    schoolLogo.addEventListener('error', function () {
      this.hidden = true;
    });
    schoolText = el('span', 'hp-brand-school-name');
    school.appendChild(schoolLogo);
    school.appendChild(schoolText);

    inner.appendChild(product);
    inner.appendChild(middle);
    inner.appendChild(school);
    banner.appendChild(inner);
    document.body.insertBefore(banner, document.body.firstChild);

    // Only the teacher/admin headings belong between the logos. The student's
    // existing live OPEN/CLOSED/TEST bar stays below the entire brand header.
    const page = window.location.pathname.split('/').pop().toLowerCase();
    activePage = page === 'teacher.html' ? 'teacher' :
      (page === 'admin.html' || page === 'master-admin.html') ? 'admin' : 'student';
    document.documentElement.classList.add('hp-page-' + activePage);
    refreshInstallLink();

    if (activePage === 'student') {
      const context = el('div', 'hp-student-context');
      studentRoomTitle = el('strong', 'hp-student-room', 'Student hall pass');
      context.appendChild(studentRoomTitle);
      context.appendChild(el('span', 'hp-student-caption', 'Request a pass'));
      middle.appendChild(context);
    } else {
      const currentHeader = document.querySelector('body > .header');
      if (currentHeader) {
        middle.appendChild(currentHeader);
        const heading = currentHeader.querySelector('h1');
        if (heading) heading.textContent = activePage === 'teacher'
          ? 'Teacher Dashboard' : page === 'master-admin.html'
            ? 'Master Administration' : 'School Administration';
      }
    }

    const params = new URLSearchParams(window.location.search);
    render({ organizationKey: params.get('org'), schoolKey: params.get('school') });
  }

  function render(context) {
    if (!banner) {
      if (!document.body) return;
      initialize();
    }
    context = context || {};
    const params = new URLSearchParams(window.location.search);
    const orgKey = safeKey(context.organizationKey || params.get('org'));
    const schoolKey = safeKey(context.schoolKey || params.get('school'));
    const registration = schools[orgKey + '/' + schoolKey] || null;
    const name = String(context.schoolName || context.school ||
      (registration && registration.name) ||
      (orgKey && schoolKey ? schoolKey.replace(/[_-]+/g, ' ') : '')).trim();

    schoolText.textContent = name;
    schoolText.parentNode.hidden = !name;

    const room = String(context.key || context.roomKey || context.room ||
      params.get('room') || '').trim();
    if (activePage === 'student' && studentRoomTitle) {
      studentRoomTitle.textContent = room ? 'Room ' + room.toUpperCase() : 'Student hall pass';
    } else if (activePage === 'teacher') {
      const heading = banner.querySelector('.hp-brand-middle > .header h1');
      if (heading) heading.textContent = 'Teacher Dashboard' +
        (room ? ' — Room ' + room.toUpperCase() : '');
    }

    const logo = registration && registration.logo ? registration.logo : '';
    if (logo === currentLogo) return;
    currentLogo = logo;
    schoolLogo.hidden = true;
    schoolLogo.removeAttribute('src');
    if (logo) {
      schoolLogo.alt = name ? name + ' logo' : 'School logo';
      schoolLogo.onload = function () { this.hidden = false; };
      schoolLogo.src = logo;
      if (schoolLogo.complete && schoolLogo.naturalWidth) schoolLogo.hidden = false;
    }
  }

  function inInstalledMode() {
    return (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function refreshInstallLink() {
    if (!installButton) return;
    installButton.hidden = inInstalledMode() ||
      (activePage === 'student' && studentInstallAllowed !== true);
  }

  function setStudentInstallAllowed(enabled) {
    studentInstallAllowed = enabled === true;
    refreshInstallLink();
  }

  function showInstallPopup() {
    if (!installButton || installButton.hidden) return;
    if (document.querySelector('.hp-install-overlay')) return;

    const overlay = el('div', 'hp-install-overlay');
    const dialog = el('div', 'hp-install-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'hp-install-title');

    const head = el('div', 'hp-install-popup-head');
    const title = el('h2', '', 'Install Hall Pilot');
    title.id = 'hp-install-title';
    const close = el('button', 'hp-install-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close installation instructions');
    head.append(title, close);
    dialog.appendChild(head);

    const context = activePage === 'student' ? 'Student' :
      activePage === 'teacher' ? 'Teacher' : 'Admin';
    dialog.appendChild(el('p', '', 'Add Hall Pilot — ' + context +
      ' to your home screen or desktop for convenient access.'));

    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    const instruction = ios
      ? 'In Safari, tap Share, then Add to Home Screen. Tap Add to finish.'
      : android
        ? 'Open your browser menu (⋮) and choose Install app or Add to Home screen.'
        : 'Use the install icon in your browser address bar, or look for Install in the browser menu.';
    dialog.appendChild(el('p', 'hp-install-instructions', instruction));
    if (activePage === 'student') {
      dialog.appendChild(el('p', 'hp-install-note',
        'This option is enabled for your room. Follow school rules about personal devices.'));
    }
    const actions = el('div', 'hp-install-actions');
    if (installPrompt && !inInstalledMode()) {
      const install = el('button', 'hp-install-confirm', 'Install');
      install.type = 'button';
      install.addEventListener('click', async function () {
        const pending = installPrompt;
        installPrompt = null;
        install.disabled = true;
        try {
          await pending.prompt();
          await pending.userChoice;
        } catch (_) {
          // Browser refused native installation; manual instructions remain visible.
        }
        refreshInstallLink();
        install.remove();
      });
      actions.appendChild(install);
    }
    const done = el('button', 'hp-install-done', 'Close');
    done.type = 'button';
    actions.appendChild(done);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    function dismiss() {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      if (!installButton.hidden) installButton.focus();
    }
    function onKeydown(event) {
      if (event.key === 'Escape') dismiss();
    }
    close.addEventListener('click', dismiss);
    done.addEventListener('click', dismiss);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) dismiss();
    });
    document.addEventListener('keydown', onKeydown);
    close.focus();
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installPrompt = event;
    refreshInstallLink();
  });
  window.addEventListener('appinstalled', function () {
    installPrompt = null;
    refreshInstallLink();
  });

  window.HallPilotBranding = { render, setStudentInstallAllowed };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
