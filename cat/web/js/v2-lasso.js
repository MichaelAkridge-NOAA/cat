// ============================================================
//  CAT v2 — Lasso Selection Tool
//  Freehand drag on the map to select annotations for bulk update.
//  Uses raw mouse events (not L.Draw) to avoid bulk-mode conflicts.
// ============================================================

(function () {
  'use strict';

  let lassoActive = false;
  let drawing = false;
  let lassoPoints = [];      // L.LatLng[] collected during drag
  let lassoOverlay = null;   // L.Polygon shown while drawing
  let lassoBtn = null;

  // ── Ray-casting point-in-polygon ──────────────────────────
  function _pip(point, polygon) {
    // polygon: L.LatLng[]  point: L.LatLng
    let inside = false;
    const px = point.lng, py = point.lat;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lng, yi = polygon[i].lat;
      const xj = polygon[j].lng, yj = polygon[j].lat;
      if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // ── Get the representative centroid of a Leaflet layer ────
  function _centroid(layer) {
    if (typeof layer.getLatLng === 'function') return layer.getLatLng();
    if (typeof layer.getBounds === 'function') return layer.getBounds().getCenter();
    if (typeof layer.getLatLngs === 'function') {
      const flat = layer.getLatLngs().flat(Infinity);
      if (!flat.length) return null;
      return L.latLng(
        flat.reduce((s, p) => s + p.lat, 0) / flat.length,
        flat.reduce((s, p) => s + p.lng, 0) / flat.length
      );
    }
    return null;
  }

  // ── Select all annotations whose centroid falls inside the lasso ──
  function _applyLasso(polygon) {
    if (typeof drawnItems === 'undefined' || typeof annotations === 'undefined') return 0;
    if (!window.v2Table) return 0;

    let count = 0;
    // Index once instead of annotations.indexOf() per layer (O(layers x
    // annotations) — very slow on large projects).
    const idxByData = new Map();
    annotations.forEach((a, i) => idxByData.set(a, i));
    drawnItems.eachLayer(layer => {
      if (!layer.annotationData) return;
      const c = _centroid(layer);
      if (!c) return;
      const idx = idxByData.has(layer.annotationData) ? idxByData.get(layer.annotationData) : -1;
      if (idx < 0) return;
      if (_pip(c, polygon)) {
        window.v2Table.addToSelection(idx);
        count++;
      }
    });
    return count;
  }

  // ── Lasso toggle ──────────────────────────────────────────
  function _activateLasso() {
    // Block if bulk draw mode is on
    if (window.v2BulkMode && window.v2BulkMode.enabled) {
      if (typeof showStatus === 'function') showStatus('Exit bulk draw mode before using lasso', 'warning');
      return;
    }
    lassoActive = true;
    lassoBtn.classList.add('active');
    map.getContainer().style.cursor = 'crosshair';
    if (typeof showStatus === 'function') showStatus('Lasso: drag to select annotations', 'info');
  }

  function _deactivateLasso() {
    // Escape (or a tool switch) mid-drag: mousedown disabled map panning, and
    // the mouseup that would re-enable it may never be handled now.
    const wasDrawing = drawing;
    lassoActive = false;
    drawing = false;
    if (wasDrawing && map && map.dragging) map.dragging.enable();
    lassoPoints = [];
    if (lassoBtn) lassoBtn.classList.remove('active');
    if (map) map.getContainer().style.cursor = '';
    _clearOverlay();
  }

  function _clearOverlay() {
    if (lassoOverlay && typeof map !== 'undefined') {
      map.removeLayer(lassoOverlay);
      lassoOverlay = null;
    }
  }

  // ── Mouse event handlers on the map container ────────────
  function _onMouseDown(e) {
    if (!lassoActive) return;
    if (e.button !== 0) return; // left-click only
    drawing = true;
    lassoPoints = [];
    map.dragging.disable();
    e.preventDefault();
  }

  function _onMouseMove(e) {
    if (!lassoActive || !drawing) return;
    // e.offsetX/offsetY are relative to e.target, not the map container —
    // while dragging over an interactive overlay feature (a shapefile
    // transect/segment line, which carries an invisible ~18px hit-stroke
    // for easier clicking) e.target becomes that <path> element instead
    // of the container, so offsetX/Y suddenly measure from the path's own
    // tiny bounding box. That made the lasso polygon warp/jump right at
    // shapefile borders. mouseEventToContainerPoint uses clientX/clientY
    // against the container's own bounding rect, independent of e.target.
    const latlng = map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
    lassoPoints.push(latlng);

    // Throttle overlay updates to every 5 points for performance
    if (lassoPoints.length % 5 !== 0) return;
    _clearOverlay();
    if (lassoPoints.length >= 3) {
      lassoOverlay = L.polygon(lassoPoints, {
        color: '#3b82f6',
        weight: 2,
        fillColor: '#3b82f6',
        fillOpacity: 0.12,
        dashArray: '6 4',
        interactive: false,
      }).addTo(map);
    }
  }

  function _onMouseUp(e) {
    if (!lassoActive || !drawing) return;
    drawing = false;
    map.dragging.enable();
    _clearOverlay();

    if (lassoPoints.length < 3) {
      _deactivateLasso();
      return;
    }

    const selected = _applyLasso(lassoPoints);
    _deactivateLasso();

    if (!window.v2Table) return;
    window.v2Table.refreshUI();

    if (selected === 0) {
      if (typeof showStatus === 'function') showStatus('No annotations inside lasso', 'info');
    } else {
      if (typeof showStatus === 'function') showStatus(`Lasso selected ${selected} annotation${selected !== 1 ? 's' : ''}`, 'success');
      // Scroll table into view so user sees the selection bar
      const bar = document.getElementById('v2SelectionBar');
      if (bar) bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // Cancel lasso on Escape
  function _onKeyDown(e) {
    if (e.key === 'Escape' && lassoActive) _deactivateLasso();
  }

  // ── Inject toolbar button ─────────────────────────────────
  function _injectButton() {
    const toolbar = document.querySelector('.v2-toolbar-inline');
    if (!toolbar) return;
    if (document.getElementById('v2LassoBtn')) return;

    lassoBtn = document.createElement('button');
    lassoBtn.id = 'v2LassoBtn';
    lassoBtn.className = 'v2-tool-btn';
    lassoBtn.title = 'Lasso select (drag to select annotations)';
    lassoBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round" style="display:block;">
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10"/>
        <path d="M22 12c0-2.5-1-4.8-2.5-6.5"/>
        <path d="M16 22c2-1 4-3 4-5l-4-1-1-4c-2 0-4 2-4 4s2 6 5 6z"/>
      </svg>`;
    lassoBtn.style.cssText = 'display:flex; align-items:center; justify-content:center;';

    lassoBtn.addEventListener('click', () => {
      if (lassoActive) _deactivateLasso();
      else _activateLasso();
    });

    // Insert after the undo button
    const undoBtn = document.getElementById('v2UndoBtn');
    if (undoBtn && undoBtn.nextSibling) {
      toolbar.insertBefore(lassoBtn, undoBtn.nextSibling);
    } else {
      toolbar.appendChild(lassoBtn);
    }
  }

  // ── Inject CSS ────────────────────────────────────────────
  function _injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      #v2LassoBtn.active {
        background: #eff6ff !important;
        color: #2563eb !important;
        border-color: #2563eb !important;
        box-shadow: 0 0 0 2px rgba(37,99,235,0.25);
      }
    `;
    document.head.appendChild(s);
  }

  // ── Public API ───────────────────────────────────────────
  window.v2Lasso = {
    get active() { return lassoActive; },
    toggle() { if (lassoActive) _deactivateLasso(); else _activateLasso(); },
    deactivate() { _deactivateLasso(); },
  };

  // ── Init ─────────────────────────────────────────────────
  function init() {
    // A popout window has no map — `map` there is a no-op stub whose
    // getContainer() returns null, so this used to die on the line below with
    // "Cannot read properties of null", skipping the rest of init (including
    // the toggleBulkMode wrapper) on every popout open. Lasso selection is a
    // drag-on-the-map tool; there is nothing here for it to attach to.
    if (window._catPopoutMode) return;

    _injectStyles();

    // Wait for the v2 toolbar to be injected by v2-bulk.js. Give up after ~30s
    // rather than polling forever if the toolbar never appears.
    let polls = 0;
    const poll = setInterval(() => {
      if (++polls > 200) { clearInterval(poll); return; }
      if (document.querySelector('.v2-toolbar-inline')) {
        clearInterval(poll);
        _injectButton();

        // Attach mouse events to the map container
        const container = map.getContainer();
        if (!container) { console.warn('v2-lasso: no map container; lasso disabled'); return; }
        container.addEventListener('mousedown', _onMouseDown);
        container.addEventListener('mousemove', _onMouseMove);
        // mouseup on document (capture): a release outside the map container
        // (easy with the docked sidebar) never reached a container listener,
        // leaving the lasso mid-draw with map panning disabled.
        document.addEventListener('mouseup', _onMouseUp, true);
        document.addEventListener('keydown', _onKeyDown);

        // Deactivate lasso when bulk mode turns on
        const _origToggle = window.toggleBulkMode;
        if (typeof _origToggle === 'function') {
          window.toggleBulkMode = function () {
            if (lassoActive) _deactivateLasso();
            return _origToggle.apply(this, arguments);
          };
        }
      }
    }, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 200);
  }

})();
