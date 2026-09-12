/* ============================================================
 * CAT - COG thumbnail helper
 *
 * Builds the markup for a lazy-loaded COG thumbnail, used by the Project
 * Manager's project list and the Sites browser. Kept in one place so both
 * render the same frame, the same placeholder, and the same failure
 * behaviour -- a project card and the site it came from should not look
 * like two different features.
 *
 * Backed by:
 *   GET /api/thumbnails/cog?url=<cog url>&size=N   (any COG, e.g. a site's
 *                                                   scanned GCS URI)
 *   GET /api/db/projects/{id}/thumbnail?size=N     (a DB project's first
 *                                                   orthomosaic asset)
 * Both 404 when there is nothing renderable, which is the normal case for a
 * site whose imagery has not been converted yet -- so a failure here is not
 * an error state, it just leaves the placeholder showing.
 * ============================================================ */
(function () {
  'use strict';

  // Matches MIN_SIZE/MAX_SIZE in cat/api/thumbnails.py; the endpoint rejects
  // anything outside this with a 422, so clamp rather than send a bad request.
  var MIN_SIZE = 32;
  var MAX_SIZE = 512;

  function clampSize(size) {
    var n = parseInt(size, 10);
    if (isNaN(n)) return 256;
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
  }

  function escapeAttr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Rendered at ~2x the CSS box so the thumbnail stays sharp on a HiDPI
  // screen. The server caches per size, so a handful of distinct sizes across
  // the app is fine; a per-device-pixel-ratio value would not be.
  function renderSizeFor(cssWidth) {
    return clampSize(Math.round((cssWidth || 88) * 2));
  }

  function fallbackMarkup(label) {
    // aria-hidden: the placeholder is decorative. The accessible name for a
    // thumbnail that rendered comes from the <img alt>; one that didn't
    // render has nothing to say, and announcing "No imagery" per row would
    // just add noise to a screen reader walking a project list.
    return (
      '<div class="cat-thumb-fallback" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
          '<rect x="3" y="3" width="18" height="18" rx="2"></rect>' +
          '<circle cx="8.5" cy="8.5" r="1.5"></circle>' +
          '<path d="M21 15l-5-5L5 21"></path>' +
        '</svg>' +
        '<span>' + escapeAttr(label || 'No imagery') + '</span>' +
      '</div>'
    );
  }

  /**
   * Build a thumbnail element's HTML.
   *
   * opts.src       explicit image URL (wins over projectId/cogUrl)
   * opts.projectId DB project to render the first orthomosaic of
   * opts.cogUrl    any COG URL / gs:// URI
   * opts.alt       accessible description
   * opts.label     placeholder text when there is nothing to render
   * opts.badge     small corner badge, e.g. 'DEM'
   * opts.size      CSS width in px (default 88, from the stylesheet)
   * opts.className extra classes, e.g. 'cat-thumb--lg'
   */
  function thumbnailHtml(opts) {
    var o = opts || {};
    var cssWidth = o.size || 88;
    var renderSize = renderSizeFor(cssWidth);

    var src = o.src || null;
    if (!src && o.projectId != null && o.projectId !== '') {
      src = '/api/db/projects/' + encodeURIComponent(o.projectId) +
            '/thumbnail?size=' + renderSize;
    }
    if (!src && o.cogUrl) {
      src = '/api/thumbnails/cog?url=' + encodeURIComponent(o.cogUrl) +
            '&size=' + renderSize;
    }

    var classes = 'cat-thumb' + (o.className ? ' ' + o.className : '');
    var style = o.size ? ' style="--cat-thumb-size:' + cssWidth + 'px;"' : '';
    var badge = o.badge
      ? '<span class="cat-thumb-badge">' + escapeAttr(o.badge) + '</span>'
      : '';

    // No source at all: placeholder only, no request.
    if (!src) {
      return '<div class="' + classes + '"' + style + '>' +
        fallbackMarkup(o.label) + badge + '</div>';
    }

    // The <img> sits above the placeholder and starts transparent; onload
    // reveals it, onerror removes it so the placeholder stays. Inline
    // handlers because both call sites build their rows as HTML strings.
    return (
      '<div class="' + classes + '"' + style + '>' +
        fallbackMarkup(o.label) +
        '<img src="' + escapeAttr(src) + '" alt="' + escapeAttr(o.alt || '') + '" ' +
             'loading="lazy" decoding="async" ' +
             'onload="this.classList.add(\'is-loaded\')" ' +
             'onerror="this.remove()">' +
        badge +
      '</div>'
    );
  }

  window.catThumbnailHtml = thumbnailHtml;
})();
