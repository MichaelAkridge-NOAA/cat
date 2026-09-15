// Attribute-driven symbology: color annotation features by species (spcode)
// or condition (con_1) instead of the fixed complete/incomplete color, plus
// an auto-generated map legend. Mirrors getAnnotationLayerStyle()'s existing
// flat-vs-nested property lookup (annotation-runtime-panel-ui.js).
(function () {
  'use strict';

  const MODE_KEY = 'cat_symbology_mode';
  const FIELDS = {
    off:    { label: 'Off (default coloring)', get: null },
    spcode: {
      label: 'Species (spcode)',
      get: (a) => a && (a.spcode || a.species_code || a.SPCODE || a.SPECIES_CODE ||
        (a.properties && (a.properties.spcode || a.properties.SPCODE || a.properties.species_code)))
    },
    con_1: {
      label: 'Condition (con_1)',
      get: (a) => a && (a.con_1 || a.condition_1 ||
        (a.properties && (a.properties.con_1 || a.properties.condition_1)))
    }
  };
  // Distinct, colorblind-friendlier categorical palette (Okabe-Ito style extended).
  const PALETTE = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
    '#46f0f0', '#f032e6', '#bcf60c', '#008080', '#9a6324',
    '#800000', '#808000', '#000075', '#e6beff', '#fabebe'
  ];
  const MISSING_COLOR = '#9ca3af';

  // Species is the more commonly useful default view; a saved browser
  // preference (below) still wins once someone picks something else.
  let mode = 'spcode';
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved && FIELDS[saved]) mode = saved;
  } catch (_) { /* localStorage unavailable */ }

  const colorCache = {};
  let nextColorIdx = 0;

  function colorFor(value) {
    const key = String(value);
    if (!colorCache[key]) {
      colorCache[key] = PALETTE[nextColorIdx % PALETTE.length];
      nextColorIdx++;
    }
    return colorCache[key];
  }

  function normalizedValue(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    return (s === '' || s === '-') ? null : s;
  }

  window.catSymbologyColorFor = function (ann) {
    if (mode === 'off' || !ann || !FIELDS[mode].get) return null;
    const value = normalizedValue(FIELDS[mode].get(ann));
    return value ? colorFor(value) : MISSING_COLOR;
  };

  window.catSymbologyGetMode = function () { return mode; };

  window.catSymbologyOptions = Object.keys(FIELDS).map((k) => ({ value: k, label: FIELDS[k].label }));

  window.catSymbologySetMode = function (newMode) {
    mode = FIELDS[newMode] ? newMode : 'off';
    try { localStorage.setItem(MODE_KEY, mode); } catch (_) { /* ignore */ }
    // Reassign colors from scratch so a mode switch gets a clean, stable palette.
    Object.keys(colorCache).forEach((k) => delete colorCache[k]);
    nextColorIdx = 0;
    restyleAllLayers();
    refreshLegend();
  };

  function restyleAllLayers() {
    if (typeof drawnItems === 'undefined' || !drawnItems || typeof drawnItems.eachLayer !== 'function') return;
    drawnItems.eachLayer(function (layer) {
      if (layer.setStyle && layer.annotationData && typeof getAnnotationLayerStyle === 'function') {
        layer.setStyle(getAnnotationLayerStyle(layer.annotationData));
      }
    });
  }

  let legendControl = null;

  function refreshLegend() {
    // Popout windows load annotation data (loadProjectAnnotations() runs
    // there too, to populate the table) but have no real Leaflet map — `map`
    // there is a no-op stub without _controlCorners. L.Control.addTo() reads
    // that directly rather than going through any of the stub's methods, so
    // the `!map` check above never catches it: the stub is truthy. A legend
    // is a map decoration, meaningless with no map to draw it on.
    if (window._catPopoutMode) return;
    if (typeof map === 'undefined' || !map || !window.L) return;
    if (legendControl) { map.removeControl(legendControl); legendControl = null; }
    if (mode === 'off' || !FIELDS[mode].get) return;

    const getter = FIELDS[mode].get;
    const list = (typeof annotations !== 'undefined' && Array.isArray(annotations)) ? annotations : [];
    const seen = new Set();
    const rows = [];
    list.forEach(function (a) {
      const value = normalizedValue(getter(a));
      const key = value || ' none';
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ label: value || '(none)', color: value ? colorFor(value) : MISSING_COLOR });
    });
    if (rows.length === 0) return;

    legendControl = L.control({ position: 'bottomright' });
    legendControl.onAdd = function () {
      const div = L.DomUtil.create('div', 'cat-symbology-legend');
      const title = document.createElement('div');
      title.className = 'cat-symbology-legend-title';
      title.textContent = 'Colored by: ' + FIELDS[mode].label;
      div.appendChild(title);
      rows.forEach(function (r) {
        const row = document.createElement('div');
        row.className = 'cat-symbology-legend-row';
        const dot = document.createElement('span');
        dot.className = 'cat-symbology-legend-dot';
        dot.style.background = r.color;
        row.appendChild(dot);
        row.appendChild(document.createTextNode(r.label));
        div.appendChild(row);
      });
      return div;
    };
    legendControl.addTo(map);
  }

  // Re-render the legend whenever the annotation list changes (called from
  // updateAnnotationTable(), the single common hook every add/edit/load path
  // already runs through — see annotation-runtime-annotations.js).
  window.catSymbologyRefreshLegend = refreshLegend;

  // Sync the <select> in the View menu once the DOM (and this mode) is ready.
  document.addEventListener('DOMContentLoaded', function () {
    const sel = document.getElementById('symbologyModeSelect');
    if (sel) sel.value = mode;
  });
})();
