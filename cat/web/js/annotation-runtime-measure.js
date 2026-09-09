// Standalone measure tool: distance/area ruler independent of drawing and
// saving an annotation. Reuses Leaflet.Draw's Polyline/Polygon handlers
// directly (not through the toolbar) so the sub-meter-precision readout
// already configured in annotation-runtime-shell-init.js (L.GeometryUtil.
// readableDistance override) applies here too. The real annotation
// draw:created handler in shell-init.js checks window.catMeasureModeActive
// and bails out early so a measurement never becomes a saved annotation.
(function () {
  'use strict';

  let handler = null;
  let kind = null; // 'distance' | 'area' | null
  let listenersWired = false;

  function ringLength(latlngs, closeRing) {
    let total = 0;
    for (let i = 0; i < latlngs.length - 1; i++) {
      total += map.distance(latlngs[i], latlngs[i + 1]);
    }
    if (closeRing && latlngs.length > 2) {
      total += map.distance(latlngs[latlngs.length - 1], latlngs[0]);
    }
    return total;
  }

  function stopMeasure() {
    if (handler) {
      try { handler.disable(); } catch (_) { /* already disabled */ }
      handler = null;
    }
    kind = null;
    window.catMeasureModeActive = false;
  }

  function wireListenersOnce() {
    if (listenersWired || typeof map === 'undefined' || !map || !window.L || !L.Draw) return;
    listenersWired = true;

    map.on(L.Draw.Event.CREATED, function (e) {
      if (!kind) return; // a real annotation draw, not a measurement — ignore
      const layer = e.layer;
      const latlngs = layer.getLatLngs();
      let resultText;
      if (kind === 'area') {
        const ring = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
        const area = L.GeometryUtil.geodesicArea(ring);
        const perimeter = ringLength(ring, true);
        resultText = `Area: ${L.GeometryUtil.readableArea(area, true)} · Perimeter: ${L.GeometryUtil.readableDistance(perimeter, true)}`;
      } else {
        resultText = `Distance: ${L.GeometryUtil.readableDistance(ringLength(latlngs, false), true)}`;
      }
      if (typeof showStatus === 'function') showStatus('📏 ' + resultText, 'success');
      stopMeasure();
    });

    // Covers Escape / toolbar cancel of the ad-hoc handler itself.
    map.on(L.Draw.Event.DRAWSTOP, function () {
      if (kind) stopMeasure();
    });
  }

  function startMeasure(newKind) {
    if (typeof map === 'undefined' || !map || !window.L || !L.Draw) return;
    if (window.v2BulkMode && window.v2BulkMode.enabled) {
      if (typeof showStatus === 'function') showStatus('Exit Bulk Draw mode before measuring.', 'warning');
      return;
    }
    wireListenersOnce();
    stopMeasure();
    kind = newKind;
    window.catMeasureModeActive = true;
    const HandlerCtor = kind === 'area' ? L.Draw.Polygon : L.Draw.Polyline;
    handler = new HandlerCtor(map, {
      shapeOptions: { color: '#dc2626', weight: 3, opacity: 0.9, fillOpacity: 0.08, dashArray: '6 4' },
      metric: true,
      showLength: true,
      allowIntersection: true
    });
    handler.enable();
    if (typeof showStatus === 'function') {
      showStatus(kind === 'area'
        ? '📐 Click to trace an area, double-click to finish. Not saved as an annotation.'
        : '📏 Click to trace a distance, double-click to finish. Not saved as an annotation.', 'info');
    }
  }

  window.catStartMeasureDistance = function () { startMeasure('distance'); };
  window.catStartMeasureArea = function () { startMeasure('area'); };
  window.catCancelMeasure = stopMeasure;
})();
