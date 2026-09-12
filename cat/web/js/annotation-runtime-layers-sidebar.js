/* ============================================================
 * CAT v12 — Layers Sidebar
 *
 * Turns the Map Layers panel (#mapLayersPanel) into a dockable left
 * sidebar the map reflows around, instead of a floating window that
 * covers the imagery being annotated.
 *
 * Design constraints this module works within:
 *  - Every id the dynamic layer builders write into must keep working
 *    untouched (#mapFileSection, #shapefileLayersContainer,
 *    #overlayLayersList, #annotationsDetails, .tif-layer-checkbox, ...).
 *    So this only re-styles the panel's container and prepends a toolbar;
 *    it never rewrites the layer rows themselves.
 *  - Float mode must stay exactly as it was, for anyone who prefers the
 *    old draggable panel — dock is a mode, not a replacement.
 *  - Nothing here may run in a popout window: the popout has no map.
 * ============================================================ */
(function () {
  'use strict';

  if (window._catPopoutMode) return; // popouts have no map and no layer tree

  var MODE_KEY  = 'cat_layers_dock_mode';   // 'dock' | 'float'
  var WIDTH_KEY = 'cat_layers_sidebar_width';
  var RAIL_KEY  = 'cat_layers_rail';        // '1' when collapsed to the rail
  var MIN_W = 240;
  var MAX_W = 640;
  var DEFAULT_W = 320;

  var panel = null;      // #mapLayersPanel
  var content = null;    // #mapLayersContent

  // ── State ────────────────────────────────────────────────────

  function getMode() {
    return localStorage.getItem(MODE_KEY) === 'float' ? 'float' : 'dock';
  }

  function isRailed() {
    return localStorage.getItem(RAIL_KEY) === '1';
  }

  // The panel is only "available" once a project has been loaded — before
  // that it carries an inline display:none and the upload panel is what
  // matters. Docking an invisible sidebar would push the map right by
  // 320px of nothing, so layout follows availability.
  function panelAvailable() {
    return !!panel && panel.style.display !== 'none';
  }

  function getWidth() {
    var w = parseInt(localStorage.getItem(WIDTH_KEY), 10);
    return clampWidth(isNaN(w) ? DEFAULT_W : w);
  }

  function clampWidth(w) {
    // Never wider than most of the viewport, so a width dragged out on a
    // large monitor can't leave a laptop with no map at all.
    var viewportMax = Math.max(MIN_W, Math.floor(window.innerWidth * 0.6));
    return Math.max(MIN_W, Math.min(Math.min(MAX_W, viewportMax), w));
  }

  function setWidth(w, persist) {
    var clamped = clampWidth(w);
    document.documentElement.style.setProperty('--layers-sidebar-width', clamped + 'px');
    if (persist) localStorage.setItem(WIDTH_KEY, String(clamped));
    return clamped;
  }
  window.catLayersSetWidth = setWidth;

  // ── Layout application ───────────────────────────────────────

  function applyLayout() {
    if (!panel) return;
    var docked = getMode() === 'dock' && panelAvailable();

    document.body.classList.toggle('layers-docked', docked);
    document.body.classList.toggle('layers-rail', docked && isRailed());

    if (docked) {
      setWidth(getWidth(), false);
      // The load paths reveal the panel with an inline display:'block', which
      // would beat the sidebar's display:flex and collapse the header/body
      // split. Normalising to '' lets each mode's stylesheet decide (block
      // when floating, flex when docked). Writing style here re-enters the
      // MutationObserver once, then settles — the second pass sees '' and
      // makes no further change.
      if (panel.style.display === 'block') panel.style.display = '';
      // Float mode's drag handler may have left explicit left/top/right on
      // the panel; those would fight the fixed sidebar geometry.
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
      panel.style.width = '';
      panel.style.zIndex = '';
      // A collapsed float panel would open docked with its body hidden.
      var header = panel.querySelector('.panel-header');
      if (header) header.classList.remove('collapsed');
      if (content) content.classList.remove('collapsed');
      panel.classList.remove('collapsed');
      // Read by makePanelDraggable (annotation-runtime-panel-ui.js) to opt the
      // docked sidebar out of free dragging.
      panel.dataset.catDocked = '1';
    } else {
      delete panel.dataset.catDocked;
    }

    updateModeLabels();
    invalidateMapSoon();
  }
  window.catLayersApplyLayout = applyLayout;

  function invalidateMapSoon() {
    setTimeout(function () {
      try {
        if (typeof map !== 'undefined' && map && typeof map.invalidateSize === 'function') {
          map.invalidateSize();
        }
      } catch (e) { /* map not ready yet */ }
    }, 60);
  }

  function updateModeLabels() {
    var docked = getMode() === 'dock';
    var dd = document.getElementById('ddLayersDockToggle');
    if (dd) dd.textContent = docked ? '🪟 Float Layers Panel' : '📚 Dock Layers Sidebar';
    var railBtn = document.getElementById('layersSidebarHideBtn');
    if (railBtn) railBtn.style.display = docked ? '' : 'none';
  }

  // ── Public commands (wired to the View menu + toolbar) ───────

  function toggleDockMode() {
    localStorage.setItem(MODE_KEY, getMode() === 'dock' ? 'float' : 'dock');
    // Leaving the rail behind when switching to float, otherwise the panel
    // would be hidden with no float-mode affordance to bring it back.
    localStorage.setItem(RAIL_KEY, '0');
    applyLayout();
  }
  window.catLayersToggleDockMode = toggleDockMode;

  function setRailed(railed) {
    localStorage.setItem(RAIL_KEY, railed ? '1' : '0');
    applyLayout();
  }

  function toggleSidebar() {
    // In float mode there is no rail; fall back to the panel's own
    // show/hide so the menu item still does something sensible.
    if (getMode() !== 'dock') {
      if (panel) panel.style.display = (panel.style.display === 'none') ? '' : 'none';
      applyLayout();
      return;
    }
    setRailed(!isRailed());
  }
  window.catLayersToggleSidebar = toggleSidebar;

  // ── Toolbar ──────────────────────────────────────────────────

  function buildToolbar() {
    if (!panel || document.getElementById('layersSidebarToolbar')) return;
    var host = document.getElementById('mapLayersContent');
    if (!host) return;

    var bar = document.createElement('div');
    bar.id = 'layersSidebarToolbar';
    bar.innerHTML =
      '<div class="layers-toolbar-row">' +
        '<input type="search" id="layerSearchInput" placeholder="Filter layers…" ' +
               'autocomplete="off" aria-label="Filter layers by name">' +
        '<button type="button" class="layers-tool-btn" id="layersSidebarHideBtn" ' +
                'title="Hide the sidebar (the ▤ Layers button brings it back)">◀</button>' +
      '</div>' +
      '<div class="layers-toolbar-row">' +
        '<button type="button" class="layers-tool-btn" onclick="catLayersSetAllVisible(true)" ' +
                'title="Show every raster and overlay layer (annotations are left alone)">All on</button>' +
        '<button type="button" class="layers-tool-btn" onclick="catLayersSetAllVisible(false)" ' +
                'title="Hide every raster and overlay layer (annotations are left alone)">All off</button>' +
        '<button type="button" class="layers-tool-btn" onclick="catLayersSetAllExpanded()" ' +
                'id="layersExpandAllBtn" title="Expand or collapse every layer\'s controls">Expand all</button>' +
        '<span class="layers-tool-spacer"></span>' +
        '<span id="layersCountBadge" class="layers-count-badge"></span>' +
        '<button type="button" class="layers-tool-btn" onclick="if(typeof zoomToSite===\'function\') zoomToSite()" ' +
                'title="Zoom the map to the project extent">🔍 Extent</button>' +
      '</div>';

    // Insert above the panel body so it reads as a masthead, and stays put
    // while the layer tree scrolls under it.
    panel.insertBefore(bar, host);

    var searchEmpty = document.createElement('div');
    searchEmpty.id = 'layerSearchEmpty';
    searchEmpty.textContent = 'No layers match that filter.';
    host.insertBefore(searchEmpty, host.firstChild);

    document.getElementById('layerSearchInput')
      .addEventListener('input', function (e) { filterLayers(e.target.value); });

    document.getElementById('layersSidebarHideBtn')
      .addEventListener('click', function () { setRailed(true); });
  }

  // ── Row annotation (tooltips + live counts) ──────────────────

  // Names are ellipsised in the narrow sidebar, so the full text has to stay
  // reachable somewhere — the row's own title attribute is the cheapest place
  // that costs the layer builders nothing.
  function annotateRows() {
    layerRows().forEach(function (row) {
      if (row.dataset.catTitled === '1') return;
      var nameEl = row.querySelector('.layer-name, .layer-header label');
      var text = nameEl ? (nameEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      if (text) row.title = text;
      row.dataset.catTitled = '1';
    });
  }

  function updateCounts() {
    var badge = document.getElementById('layersCountBadge');
    if (!badge) return;
    var boxes = visibilityCheckboxes({ ignoreFilter: true });
    var on = boxes.filter(function (cb) { return cb.checked; }).length;
    badge.textContent = boxes.length ? on + '/' + boxes.length : '';
    badge.title = boxes.length
      ? on + ' of ' + boxes.length + ' map layers visible (annotations excluded)'
      : '';
  }
  window.catLayersUpdateCounts = updateCounts;

  // ── Layer filtering ──────────────────────────────────────────

  function layerRows() {
    if (!content) return [];
    return Array.prototype.slice.call(content.querySelectorAll('.layer-item'));
  }

  function filterLayers(term) {
    var q = String(term || '').trim().toLowerCase();
    var rows = layerRows();
    var shown = 0;

    rows.forEach(function (row) {
      if (!q) {
        row.classList.remove('layer-filter-hidden');
        shown++;
        return;
      }
      var text = (row.textContent || '').toLowerCase();
      var match = text.indexOf(q) !== -1;
      row.classList.toggle('layer-filter-hidden', !match);
      if (match) shown++;
    });

    var empty = document.getElementById('layerSearchEmpty');
    if (empty) empty.style.display = (q && shown === 0) ? 'block' : 'none';
  }
  window.catLayersFilter = filterLayers;

  // ── Bulk visibility ──────────────────────────────────────────

  // Every visibility control in the tree, EXCEPT the annotations layer:
  // bulk-hiding the thing you are annotating is never what "All off" means,
  // and it has its own toggle a click away.
  function visibilityCheckboxes(opts) {
    if (!content) return [];
    var ignoreFilter = !!(opts && opts.ignoreFilter);
    var boxes = Array.prototype.slice.call(
      content.querySelectorAll('.tif-layer-checkbox, .layer-header .layer-toggle input[type="checkbox"]')
    );
    return boxes.filter(function (cb) {
      if (cb.id === 'toggleAnnotations') return false;
      if (cb.disabled) return false;
      // Skip rows the current filter has hidden, so "All off" acts on what
      // the user can actually see — the same way a filtered list behaves
      // everywhere else in the app.
      if (ignoreFilter) return true;
      var row = cb.closest('.layer-item');
      if (row && row.classList.contains('layer-filter-hidden')) return false;
      return true;
    });
  }

  function setAllVisible(visible) {
    var changed = 0;
    visibilityCheckboxes().forEach(function (cb) {
      if (cb.checked === visible) return;
      cb.checked = visible;
      // The layer rows wire their behaviour to 'change' (addEventListener)
      // or to an inline onchange attribute; dispatching a real event fires
      // both, whereas cb.click() would double-toggle rows whose label
      // wraps the input.
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      changed++;
    });
    if (typeof showStatus === 'function') {
      showStatus(changed
        ? (visible ? '👁️ ' : '🚫 ') + changed + ' layer' + (changed === 1 ? '' : 's') +
          (visible ? ' shown' : ' hidden')
        : 'No layers to change', 'info');
    }
  }
  window.catLayersSetAllVisible = setAllVisible;

  // ── Bulk expand / collapse ───────────────────────────────────

  var _allExpanded = false;

  function setAllExpanded(force) {
    var expand = (typeof force === 'boolean') ? force : !_allExpanded;
    _allExpanded = expand;

    layerRows().forEach(function (row) {
      var details = row.querySelector('.layer-details');
      if (!details) return;
      details.classList.toggle('collapsed', !expand);
      var icon = row.querySelector('.layer-collapse-icon');
      if (icon) icon.textContent = expand ? '▼' : '▶';
    });

    var btn = document.getElementById('layersExpandAllBtn');
    if (btn) btn.textContent = expand ? 'Collapse all' : 'Expand all';
  }
  window.catLayersSetAllExpanded = setAllExpanded;

  // ── Rail button ──────────────────────────────────────────────

  function buildRailButton() {
    if (document.getElementById('layersRailBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'layersRailBtn';
    btn.type = 'button';
    btn.title = 'Show the layers sidebar';
    btn.innerHTML = '▤ Layers';
    btn.addEventListener('click', function () { setRailed(false); });
    document.body.appendChild(btn);
  }

  // ── Resize handle ────────────────────────────────────────────

  function buildResizeHandle() {
    if (document.getElementById('layers-resize-handle')) return;
    var handle = document.createElement('div');
    handle.id = 'layers-resize-handle';
    handle.title = 'Drag to resize the layers sidebar';
    document.body.appendChild(handle);

    var dragging = false;

    handle.addEventListener('mousedown', function (e) {
      if (!document.body.classList.contains('layers-docked')) return;
      dragging = true;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      // The sidebar is flush to the left edge, so the pointer's x IS the width.
      setWidth(e.clientX, false);
      invalidateMapSoon();
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      var current = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--layers-sidebar-width'), 10);
      setWidth(isNaN(current) ? DEFAULT_W : current, true);
      invalidateMapSoon();
    });
  }

  // ── Init ─────────────────────────────────────────────────────

  function init() {
    panel = document.getElementById('mapLayersPanel');
    content = document.getElementById('mapLayersContent');
    if (!panel || !content) return;

    buildToolbar();
    buildRailButton();
    buildResizeHandle();

    // The panel is revealed by whichever project-load path ran (DB snapshot,
    // project file, or the file-mode COG flow), each of which just clears the
    // inline display. Watching the attribute means the sidebar picks that up
    // without every load path needing to know the sidebar exists.
    new MutationObserver(function () { applyLayout(); })
      .observe(panel, { attributes: true, attributeFilter: ['style'] });

    // Layer rows are injected asynchronously and repeatedly (COGs on project
    // load, overlays after upload, shapefiles on demand) by four different
    // modules. Rather than have each of them call into the sidebar, watch the
    // tree: new rows get their tooltip, the active filter is re-applied so a
    // freshly-loaded layer can't appear while the list is filtered, and the
    // visible-layer count stays honest.
    var refresh = null;
    var treeObserver = new MutationObserver(function () {
      clearTimeout(refresh);
      refresh = setTimeout(function () {
        annotateRows();
        var box = document.getElementById('layerSearchInput');
        if (box && box.value.trim()) filterLayers(box.value);
        updateCounts();
      }, 80);
    });
    treeObserver.observe(content, { childList: true, subtree: true });

    // Checkbox flips come from the rows' own handlers, so listen at the
    // container instead of patching every builder.
    content.addEventListener('change', function () { updateCounts(); });

    annotateRows();
    updateCounts();

    // A viewport that shrinks below the saved width (window resize, external
    // display unplugged) would otherwise leave a sliver of map.
    window.addEventListener('resize', function () {
      if (!document.body.classList.contains('layers-docked')) return;
      setWidth(getWidth(), false);
      invalidateMapSoon();
    });

    applyLayout();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
