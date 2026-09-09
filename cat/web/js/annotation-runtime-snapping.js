// Vertex snapping: after a new polygon/polyline/rectangle is drawn, pull its
// vertices onto nearby existing-annotation vertices within a pixel tolerance
// so adjacent colony boundaries share exact edges instead of leaving slivers
// or gaps. Applied once at draw:created time (annotation-runtime-shell-init.js
// calls snapNewLayerVertices right after the layer is added to drawnItems),
// not as a live snap-while-dragging indicator.
(function () {
  'use strict';

  const TOLERANCE_PX = 10;
  const MAX_CANDIDATES = 8000; // safety cap so a very large project can't freeze the draw handler

  const ENABLED_KEY = 'cat_snap_enabled';
  let enabled = true;
  try {
    const saved = localStorage.getItem(ENABLED_KEY);
    if (saved != null) enabled = saved !== 'false';
  } catch (_) { /* localStorage unavailable */ }

  function flattenLatLngs(latlngs, out) {
    out = out || [];
    latlngs.forEach(function (item) {
      if (Array.isArray(item)) flattenLatLngs(item, out);
      else out.push(item);
    });
    return out;
  }

  function collectVertexCandidates(excludeLayer) {
    const pts = [];
    if (typeof drawnItems === 'undefined' || !drawnItems || typeof drawnItems.eachLayer !== 'function') return pts;
    drawnItems.eachLayer(function (l) {
      if (l === excludeLayer || pts.length >= MAX_CANDIDATES) return;
      if (typeof l.getLatLngs !== 'function') return;
      flattenLatLngs(l.getLatLngs(), pts);
    });
    return pts.length > MAX_CANDIDATES ? pts.slice(0, MAX_CANDIDATES) : pts;
  }

  window.snapNewLayerVertices = function (layer) {
    if (!enabled) return;
    if (!layer || typeof layer.getLatLngs !== 'function' || typeof layer.setLatLngs !== 'function') return;
    if (typeof map === 'undefined' || !map) return;

    const candidates = collectVertexCandidates(layer);
    if (!candidates.length) return;

    const zoom = map.getZoom();
    const candidatePoints = candidates.map(function (c) { return { latlng: c, pt: map.project(c, zoom) }; });

    function nearestCandidate(latlng) {
      const p = map.project(latlng, zoom);
      let best = null;
      let bestDist = Infinity;
      for (let i = 0; i < candidatePoints.length; i++) {
        const d = p.distanceTo(candidatePoints[i].pt);
        if (d < bestDist) { bestDist = d; best = candidatePoints[i].latlng; }
      }
      return bestDist <= TOLERANCE_PX ? best : null;
    }

    function snapArray(arr) {
      return arr.map(function (item) {
        if (Array.isArray(item)) return snapArray(item);
        const snapped = nearestCandidate(item);
        return snapped ? L.latLng(snapped.lat, snapped.lng) : item;
      });
    }

    layer.setLatLngs(snapArray(layer.getLatLngs()));
    if (typeof layer.redraw === 'function') layer.redraw();
  };

  window.catSnapIsEnabled = function () { return enabled; };

  window.catSnapToggle = function () {
    enabled = !enabled;
    try { localStorage.setItem(ENABLED_KEY, String(enabled)); } catch (_) { /* ignore */ }
    const btn = document.getElementById('ddSnapToggle');
    if (btn) btn.textContent = (enabled ? '✓ ' : '✗ ') + 'Snap to Nearby Vertices';
    if (typeof showStatus === 'function') {
      showStatus('Vertex snapping ' + (enabled ? 'enabled' : 'disabled'), 'info');
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('ddSnapToggle');
    if (btn) btn.textContent = (enabled ? '✓ ' : '✗ ') + 'Snap to Nearby Vertices';
  });
})();
