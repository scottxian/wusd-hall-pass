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
    installButton = el('button', 'hp-install-link');
    installButton.type = 'button';
    // A real phone outline is clearer than the old text arrow at small sizes.
    const phoneIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    phoneIcon.setAttribute('viewBox', '0 0 24 24');
    phoneIcon.setAttribute('width', '15');
    phoneIcon.setAttribute('height', '15');
    phoneIcon.setAttribute('fill', 'none');
    phoneIcon.setAttribute('stroke', 'currentColor');
    phoneIcon.setAttribute('stroke-width', '2');
    phoneIcon.setAttribute('stroke-linecap', 'round');
    phoneIcon.setAttribute('stroke-linejoin', 'round');
    phoneIcon.setAttribute('aria-hidden', 'true');
    const phoneBody = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    phoneBody.setAttribute('x', '6');
    phoneBody.setAttribute('y', '2');
    phoneBody.setAttribute('width', '12');
    phoneBody.setAttribute('height', '20');
    phoneBody.setAttribute('rx', '2');
    const phoneHome = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    phoneHome.setAttribute('d', 'M11 18h2');
    phoneIcon.append(phoneBody, phoneHome);
    installButton.append(phoneIcon, el('span', '', 'Add to Phone'));
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
    const title = el('h2', '', 'Add Hall Pilot to Your Phone');
    title.id = 'hp-install-title';
    const close = el('button', 'hp-install-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close installation instructions');
    head.append(title, close);
    dialog.appendChild(head);

    dialog.appendChild(el('p', 'hp-install-intro',
      'Open this Hall Pilot page on your phone, then add it to your Home Screen. No app store needed.'));

    // Keep instructions and the room-specific QR side by side on wider screens.
    const main = el('div', 'hp-install-content');
    const instructionList = el('div', 'hp-install-instruction-list');
    main.appendChild(instructionList);
    dialog.appendChild(main);

    function addInstructions(heading, steps, note) {
      const section = el('section', 'hp-install-platform');
      section.appendChild(el('h3', '', heading));
      const list = el('ol', 'hp-install-steps');
      for (const step of steps) list.appendChild(el('li', '', step));
      section.appendChild(list);
      if (note) section.appendChild(el('p', 'hp-install-platform-note', note));
      instructionList.appendChild(section);
    }

    addInstructions('iPhone — Safari', [
      'Open Hall Pilot in Safari.',
      'Tap Share (or open the page menu, then Share).',
      'Choose Add to Home Screen, then Add.'
    ]);
    addInstructions('iPhone — Chrome', [
      'Open Hall Pilot in Chrome.',
      'Tap Share beside the address bar.',
      'Choose Add to Home Screen, then Add.'
    ], 'Requires Chrome 112+ and iOS 16.4+; use Safari if the option is missing.');
    addInstructions('Android — Chrome', [
      'Open Hall Pilot in Chrome.',
      'Tap the three-dot menu (⋮).',
      'Select Install app or Add to Home screen and confirm.'
    ]);

    const qrPanel = el('section', 'hp-install-qr-panel');
    qrPanel.appendChild(el('h3', '', 'Scan with your phone'));
    qrPanel.appendChild(el('p', 'hp-install-qr-caption',
      'Scan to open this exact Hall Pilot page, including its classroom or school.'));
    const qrFrame = el('div', 'hp-install-qr-code');
    qrFrame.setAttribute('role', 'img');
    qrFrame.setAttribute('aria-label', 'QR code for this Hall Pilot page');
    qrPanel.appendChild(qrFrame);
    qrPanel.appendChild(el('p', 'hp-install-qr-footnote',
      'Then use the iPhone or Android steps to add it to your Home Screen.'));
    main.appendChild(qrPanel);

    // Encode only the known routing parameters; never copy unrelated query
    // values or URL fragments into a QR code. This is generated entirely on
    // the device using the bundled library, without any external QR service.
    const qrUrl = new URL(window.location.href);
    qrUrl.hash = '';
    for (const key of [...qrUrl.searchParams.keys()]) {
      if (!['org', 'school', 'room'].includes(key)) qrUrl.searchParams.delete(key);
    }
    try {
      if (typeof QRCode !== 'function') throw new Error('QR generator unavailable');
      new QRCode(qrFrame, {
        text: qrUrl.toString(),
        width: 180,
        height: 180,
        colorDark: '#111827',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (error) {
      console.warn('Hall Pilot install QR unavailable:', error);
      qrFrame.classList.add('hp-install-qr-error');
      qrFrame.textContent = 'QR code unavailable. Open this Hall Pilot page on your phone.';
    }

    if (activePage === 'student') {
      dialog.appendChild(el('p', 'hp-install-note',
        'Follow your school’s rules about student phones and personal devices.'));
    }

    const actions = el('div', 'hp-install-actions');
    // iPhone uses the Share menu. Only offer a native installation prompt on
    // Android; desktop visitors are here to read phone instructions.
    const onAndroid = /Android/i.test(navigator.userAgent || '');
    if (onAndroid && installPrompt && !inInstalledMode()) {
      const install = el('button', 'hp-install-confirm', 'Install on This Phone');
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
