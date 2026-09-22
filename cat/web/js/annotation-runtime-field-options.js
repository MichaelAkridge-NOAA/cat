// Team-lead annotation-form configuration, Phase 3 (docs/team-lead-config-plan.md).
//
// The dropdown/autocomplete option lists for transect, segment, morph_code,
// no_colony, juvenile, remnant, ex_bound and juv_substrate used to be
// hardcoded FOUR separate times: the main form (annotation.html), the edit
// modal (annotation-form.js), and the batch-fill + bulk-update modals
// (v2-table.js). This fetches the team-lead-configured list once from
// GET /api/config/field-options and every call site below reads from here
// instead of keeping its own copy.
//
// Invariant (see the plan doc): disabling an option must never affect an
// annotation that already has that value. This module never drops a value
// it's told is "currently selected" — see buildOptionsHtml's currentValue
// handling — it only affects what a NEW selection offers.

(function () {
  'use strict';

  // Bundled fallback: exactly today's hardcoded lists, used only if the
  // config fetch fails (offline, DB unavailable, ...) so the form still
  // works exactly as it always has.
  var FALLBACK = {
    transect: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }],
    segment: [{ value: '0', label: '0' }, { value: '5', label: '5' }, { value: '10', label: '10' }, { value: '15', label: '15' }],
    morph_code: [
      { value: 'BR', label: 'BR - Branching' }, { value: 'CO', label: 'CO - Columnar' },
      { value: 'EN', label: 'EN - Encrusting' }, { value: 'FO', label: 'FO - Foliaceous' },
      { value: 'FL', label: 'FL - Free-living' }, { value: 'LA', label: 'LA - Laminar' },
      { value: 'MD', label: 'MD - Mounding' }, { value: 'MA', label: 'MA - Massive' },
      { value: 'PL', label: 'PL - Plating' }, { value: 'SM', label: 'SM - Submassive' },
      { value: 'SO', label: 'SO - Solitary' }, { value: 'TB', label: 'TB - Tabular' }
    ],
    no_colony: [{ value: '0', label: 'No' }, { value: '-1', label: 'Yes' }],
    juvenile: [{ value: '0', label: 'No' }, { value: '-1', label: 'Yes' }],
    remnant: [{ value: '0', label: 'No' }, { value: '-1', label: 'Yes' }],
    ex_bound: [{ value: '0', label: 'No' }, { value: '-1', label: 'Yes' }],
    juv_substrate: ['CCAH', 'CCAR', 'TURFH', 'TURFR', 'EMA', 'PESP', 'LOBO', 'HARD', 'CORAL', 'RUB', 'HALI']
      .map(function (v) { return { value: v, label: v }; })
  };

  // Fields whose <select> starts with a blank "-" option today.
  var BLANK_FIRST = { transect: true, segment: true, morph_code: true };

  var _fields = null; // resolved {field: [{value,label},...]}, or null until loaded
  var _ready = fetch('/api/config/field-options', { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      _fields = {};
      Object.keys(FALLBACK).forEach(function (f) {
        var opts = (data.fields && data.fields[f]) || [];
        _fields[f] = opts.length ? opts : FALLBACK[f];
      });
    })
    .catch(function (err) {
      console.warn('Field-options config unavailable, using bundled defaults:', err);
      _fields = FALLBACK;
    });

  function getOptions(field) {
    return (_fields && _fields[field]) || FALLBACK[field] || [];
  }

  // Plain array of enabled values (no labels) — for autocomplete-style
  // fields like juv_substrate where the value IS the display text.
  function getValues(field) {
    return getOptions(field).map(function (o) { return o.value; });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Build <option> HTML for `field`. `currentValue` (a string) is always
  // included even if it's since been disabled/removed — labeled "(retired)"
  // since we don't have its original label once it's outside the enabled
  // list — so an existing annotation's saved value is never silently dropped
  // from its own edit form.
  function buildOptionsHtml(field, currentValue) {
    var opts = getOptions(field);
    var cur = currentValue === undefined || currentValue === null ? '' : String(currentValue);
    // The `selected` attribute is set directly in the markup — not left to a
    // caller's separate `.value = cur` assignment — because some call sites
    // (the edit-row modal) insert this HTML as part of a larger string via
    // innerHTML with no follow-up .value set; without `selected` in the
    // markup itself, the browser defaults to the first <option>, silently
    // losing the real selection.
    var html = '';
    if (BLANK_FIRST[field]) html += '<option value=""' + (cur === '' ? ' selected' : '') + '>-</option>';
    var found = false;
    opts.forEach(function (o) {
      var v = String(o.value);
      var isSel = v === cur && cur !== '';
      if (isSel) found = true;
      html += '<option value="' + esc(v) + '"' + (isSel ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    });
    if (cur !== '' && !found) {
      html += '<option value="' + esc(cur) + '" selected>' + esc(cur) + ' (retired)</option>';
    }
    return html;
  }

  // Replace a live <select>'s options from config, preserving currentValue
  // (falling back to the select's own current value if none is given, so a
  // page-load-time refresh doesn't reset a value the user or a default
  // already set).
  function populateSelect(selectEl, field, currentValue) {
    if (!selectEl) return;
    var cur = currentValue !== undefined && currentValue !== null ? currentValue : selectEl.value;
    selectEl.innerHTML = buildOptionsHtml(field, cur);
    selectEl.value = cur;
  }

  window.CatFieldOptions = {
    ready: _ready,
    get: getOptions,
    getValues: getValues,
    buildOptionsHtml: buildOptionsHtml,
    populateSelect: populateSelect
  };

  // Populate the main form's static selects as soon as config loads,
  // independent of which project is open (this config is deployment-wide).
  // Each field's currentValue defaults to whatever the static HTML already
  // has selected, so today's defaults (transect="A", Yes/No="0", etc.) are
  // preserved exactly when nothing has been customized.
  _ready.then(function () {
    ['transect', 'segment', 'morph_code', 'no_colony', 'juvenile', 'remnant', 'ex_bound'].forEach(function (field) {
      var el = document.getElementById(field);
      if (el && el.tagName === 'SELECT') populateSelect(el, field);
    });
  });
})();
