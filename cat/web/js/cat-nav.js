/**
 * CAT shared top navigation.
 *
 * Single source of truth for cross-page navigation on the "content" pages
 * (index, sites, report, converter, project_creator). Include with:
 *     <script src="js/cat-nav.js"></script>
 * and it prepends a consistent sticky nav bar to <body>. Styled by the
 * `.cat-topnav*` tokens in css/cat-theme.css. No dependencies, no external
 * network requests (offline / gov-network constraint).
 *
 * The annotation page keeps its own functional dropdown toolbar and does NOT
 * include this module; its cross-page links mirror the same canonical set.
 */
(function () {
  'use strict';

  // Canonical destinations — every href is a real route. Report is
  // intentionally omitted (it needs a project_id and is reached contextually).
  var PRIMARY = [
    { href: '/', label: 'Home', icon: 'home' },
    { href: '/project_creator.html', label: 'Projects', icon: 'folder' },
    { href: '/sites', label: 'Sites', icon: 'map' },
    { href: '/converter', label: 'Converter', icon: 'layers' }
  ];
  var SECONDARY = { href: '/docs', label: 'API Docs', icon: 'book-open' };

  var SPRITE = '/vendor/feather/feather-sprite.svg#';

  // Normalize a pathname to a canonical key so active-state matches robustly.
  function pageKey(pathname) {
    var p = (pathname || '/').replace(/\/+$/, '') || '/';
    if (p === '/annotate' || p === '/annotation.html') return '/annotate';
    if (p === '') return '/';
    return p;
  }

  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'cat-icon');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', SPRITE + name);
    svg.appendChild(use);
    return svg;
  }

  function makeLink(item, activeKey) {
    var a = document.createElement('a');
    a.className = 'cat-topnav-link';
    a.href = item.href;
    a.appendChild(icon(item.icon));
    a.appendChild(document.createTextNode(' ' + item.label));
    if (pageKey(item.href) === activeKey) {
      a.classList.add('is-active');
      a.setAttribute('aria-current', 'page');
    }
    return a;
  }

  function build() {
    var activeKey = pageKey(window.location.pathname);

    var header = document.createElement('header');
    header.className = 'cat-topnav';
    header.setAttribute('role', 'navigation');
    header.setAttribute('aria-label', 'Primary');

    var inner = document.createElement('div');
    inner.className = 'cat-topnav-inner';

    // Brand
    var brand = document.createElement('a');
    brand.className = 'cat-topnav-brand';
    brand.href = '/';
    var logo = document.createElement('img');
    logo.src = '/logo.png';
    logo.alt = '';
    brand.appendChild(logo);
    brand.appendChild(document.createTextNode('CAT'));
    inner.appendChild(brand);

    // Hamburger toggle (shown < 641px via CSS)
    var toggle = document.createElement('button');
    toggle.className = 'cat-topnav-toggle';
    toggle.type = 'button';
    toggle.id = 'catTopnavToggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'catTopnavLinks');
    toggle.setAttribute('aria-label', 'Toggle navigation menu');
    toggle.appendChild(icon('menu'));
    inner.appendChild(toggle);

    // Links
    var links = document.createElement('nav');
    links.className = 'cat-topnav-links';
    links.id = 'catTopnavLinks';
    PRIMARY.forEach(function (item) { links.appendChild(makeLink(item, activeKey)); });

    var spacer = document.createElement('span');
    spacer.className = 'cat-topnav-spacer';
    links.appendChild(spacer);
    links.appendChild(makeLink(SECONDARY, activeKey));

    inner.appendChild(links);
    header.appendChild(inner);

    // Toggle behavior
    function closeMenu() {
      links.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && links.classList.contains('is-open')) closeMenu();
    });

    document.body.insertBefore(header, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
