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

  // Experiment (annotation-layout-experiment branch): a legend for a
  // species with many distinct values could run 15+ rows tall, and it sits
  // in the same bottom-right corner the annotation form covers whenever
  // open. Unlike the minimap (glanced at constantly for orientation), the
  // legend is a "check occasionally" widget, so it collapses to a small
  // chip by default instead of fighting for permanent screen space.
  const LEGEND_COLLAPSED_KEY = 'cat_legend_collapsed';
  let legendCollapsed = true;
  try {
    const saved = localStorage.getItem(LEGEND_COLLAPSED_KEY);
    if (saved != null) legendCollapsed = saved !== '0';
  } catch (_) { /* localStorage unavailable */ }

  function refreshLegend() {
    // Experiment (annotation-layout-experiment branch): this used to be a
    // Leaflet 'bottomright' map control, which put it in exactly the corner
    // the float-mode annotation form covers -- collapsing it to a chip
    // shrank its footprint but never actually got it out from under the
    // form, since chip or full list, it stayed positioned there the whole
    // time and was invisible whenever the form was open (i.e. always). It
    // now renders into the Map Layers panel's own Legend section
    // (annotation.html) instead, same fix as the Overview/minimap section
    // above, and no longer depends on the Leaflet map at all.
    const section = document.getElementById('legendSection');
    const container = document.getElementById('catSymbologyLegendContainer');
    if (!section || !container) return; // e.g. popout window, which has neither

    if (mode === 'off' || !FIELDS[mode].get) {
      section.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    const getter = FIELDS[mode].get;
    const list = (typeof annotations !== 'undefined' && Array.isArray(annotations)) ? annotations : [];
    const byKey = new Map();
    list.forEach(function (a) {
      const value = normalizedValue(getter(a));
      const key = value || ' none';
      let entry = byKey.get(key);
      if (!entry) {
        // colorFor() is called once per newly-seen key, in first-appearance
        // order, same as before counts were tracked -- keeps colors stable
        // across a mode switch rather than reassigning them by final count.
        entry = { label: value || '(none)', color: value ? colorFor(value) : MISSING_COLOR, count: 0 };
        byKey.set(key, entry);
      }
      entry.count++;
    });
    const rows = Array.from(byKey.values());
    if (rows.length === 0) {
      section.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    section.style.display = '';
    container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'cat-symbology-legend';
    container.appendChild(div);

    function render() {
      div.innerHTML = '';
      div.classList.toggle('collapsed', legendCollapsed);

      if (legendCollapsed) {
        div.title = 'Colored by: ' + FIELDS[mode].label + ' — click to expand';
        const chipTitle = document.createElement('span');
        chipTitle.className = 'cat-symbology-legend-chip-label';
        chipTitle.textContent = FIELDS[mode].label;
        div.appendChild(chipTitle);
        // Preview: up to 4 of the actual colors, so the chip hints at the
        // palette without needing the full list.
        rows.slice(0, 4).forEach(function (r) {
          const dot = document.createElement('span');
          dot.className = 'cat-symbology-legend-dot';
          dot.style.background = r.color;
          div.appendChild(dot);
        });
        if (rows.length > 4) {
          const more = document.createElement('span');
          more.className = 'cat-symbology-legend-more';
          more.textContent = '+' + (rows.length - 4);
          div.appendChild(more);
        }
        return;
      }

      div.title = '';
      const title = document.createElement('div');
      title.className = 'cat-symbology-legend-title';
      title.textContent = 'Colored by: ' + FIELDS[mode].label + ' (click to collapse)';
      div.appendChild(title);
      rows.forEach(function (r) {
        const row = document.createElement('div');
        row.className = 'cat-symbology-legend-row';
        const dot = document.createElement('span');
        dot.className = 'cat-symbology-legend-dot';
        dot.style.background = r.color;
        row.appendChild(dot);
        row.appendChild(document.createTextNode(r.label));
        const count = document.createElement('span');
        count.className = 'cat-symbology-legend-count';
        count.textContent = String(r.count);
        row.appendChild(count);
        div.appendChild(row);
      });
    }
    render();

    div.addEventListener('click', function () {
      legendCollapsed = !legendCollapsed;
      try { localStorage.setItem(LEGEND_COLLAPSED_KEY, legendCollapsed ? '1' : '0'); } catch (_) { /* ignore */ }
      render();
    });
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
