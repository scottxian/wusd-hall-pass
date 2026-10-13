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
    const product = el('div', 'hp-brand-product');
    const mark = el('img', 'hp-brand-mark');
    mark.src = 'assets/hall-pilot-mark.svg';
    mark.alt = '';
    mark.width = 48;
    mark.height = 48;
    const productWords = el('div', 'hp-brand-words');
    productWords.appendChild(el('strong', 'hp-brand-name', 'Hall Pilot'));
    productWords.appendChild(el('span', 'hp-brand-tagline', 'Digital hall pass'));
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
    inner.appendChild(school);
    banner.appendChild(inner);
    document.body.insertBefore(banner, document.body.firstChild);

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

  window.HallPilotBranding = { render };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
