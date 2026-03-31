// ============================================================
//  CAT v2 — Defaults & All-Caps
//  Adds auto-uppercase for text inputs, field defaults bar,
//  and pre-populates form fields from saved defaults.
// ============================================================

(function () {
  'use strict';

  const DEFAULTS_STORAGE_KEY = 'cat_v2_field_defaults';
  let fieldDefaults = {};

  // ===================================================================
  //  ALL-CAPS — force uppercase on text inputs
  // ===================================================================
  function initAllCaps() {
    // Add class to body so CSS can apply text-transform
    document.body.classList.add('v2-allcaps');

    // Also force JS-level uppercase on input events
    document.addEventListener('input', function (e) {
      if (e.target.tagName !== 'INPUT') return;
      if (e.target.type !== 'text') return;
      // Skip autocomplete dropdowns (they need mixed case for search)
      if (e.target.closest('.autocomplete-dropdown')) return;

      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      e.target.value = e.target.value.toUpperCase();
      e.target.setSelectionRange(start, end);
    });
  }

  // ===================================================================
  //  FIELD DEFAULTS — save/load default values for form fields
  // ===================================================================
  function loadDefaults() {
    try {
      const stored = localStorage.getItem(DEFAULTS_STORAGE_KEY);
      if (stored) {
        fieldDefaults = JSON.parse(stored);
      }
    } catch (e) { /* ignore */ }
  }

  function saveDefaults() {
    try {
      localStorage.setItem(DEFAULTS_STORAGE_KEY, JSON.stringify(fieldDefaults));
    } catch (e) { /* ignore */ }
  }

  function applyDefaultsToForm() {
    Object.keys(fieldDefaults).forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.value) {
        el.value = fieldDefaults[id];
        // Visual indicator
        el.style.background = 'linear-gradient(to right, #ecfdf5 0%, #fff 100%)';
        el.style.borderColor = '#10b981';
        el.title = '✨ Default value';
        el.addEventListener('input', function () {
          el.style.background = '';
          el.style.borderColor = '';
          el.title = '';
        }, { once: true });
      }
    });
  }

  function captureCurrentFormAsDefaults() {
    const fields = [
      'analyst', 'obs_year', 'mission_id', 'site',
      'transect', 'segment', 'seglength', 'segwidth', 'spcode'
    ];
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el && el.value.trim()) {
        fieldDefaults[id] = el.value.trim();
      }
    });
    saveDefaults();
  }

  // ===================================================================
  //  DEFAULTS BAR — show current defaults & buttons
  // ===================================================================
  function injectDefaultsBar() {
    const waitForPanel = setInterval(() => {
      const formSection = document.getElementById('formSectionContent');
      if (!formSection) return;
      clearInterval(waitForPanel);

      const bar = document.createElement('div');
      bar.className = 'v2-defaults-bar';
      bar.id = 'v2DefaultsBar';
      bar.innerHTML = `
        <span>📋 Defaults:</span>
        <span id="v2DefaultsSummary" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; color:#64748b;">None set</span>
        <button onclick="window.v2CaptureDefaults()" title="Save current form values as defaults for new annotations">💾 Set Defaults</button>
        <button onclick="window.v2ClearDefaults()" title="Clear all saved defaults">🗑️ Clear</button>
        <button onclick="window.v2ApplyDefaults()" title="Fill empty form fields with saved defaults">📥 Apply</button>
        <button id="v2ApplyBatchBtn" onclick="window.v2ApplyDefaultsBatch()" title="Apply defaults to annotations drawn in current bulk session" style="display:none; background:#dbeafe; border-color:#3b82f6;">⚡ Apply Batch</button>
      `;
      formSection.insertBefore(bar, formSection.firstChild);

      updateDefaultsSummary();
      updateApplyBatchButtonVisibility();
    }, 300);
  }

  function updateDefaultsSummary() {
    const el = document.getElementById('v2DefaultsSummary');
    if (!el) return;
    const keys = Object.keys(fieldDefaults).filter(k => fieldDefaults[k]);
    if (keys.length === 0) {
      el.textContent = 'None set';
    } else {
      el.textContent = keys.map(k => `${k}: ${fieldDefaults[k]}`).join(' · ');
    }
  }

  function updateApplyBatchButtonVisibility() {
    const btn = document.getElementById('v2ApplyBatchBtn');
    if (!btn) return;
    // Show button only if:
    // 1. Defaults are set
    // 2. Bulk mode has added annotations in current session
    const hasDefaults = Object.keys(fieldDefaults).some(k => fieldDefaults[k]);
    const hasBatchAnnotations = window.v2BulkMode && window.v2BulkMode.sessionAnnotationIndices && window.v2BulkMode.sessionAnnotationIndices.length > 0;
    btn.style.display = (hasDefaults && hasBatchAnnotations) ? 'inline-block' : 'none';
    if (hasBatchAnnotations) {
      btn.title = `Apply defaults to ${window.v2BulkMode.sessionAnnotationIndices.length} annotation(s) in this bulk session`;
    }
  }

  // Expose to global for onclick handlers
  window.v2CaptureDefaults = function () {
    captureCurrentFormAsDefaults();
    updateDefaultsSummary();
    updateApplyBatchButtonVisibility();
    if (typeof showStatus === 'function') {
      showStatus('📋 Defaults saved from current form', 'success');
    }
  };

  window.v2ClearDefaults = function () {
    fieldDefaults = {};
    saveDefaults();
    updateDefaultsSummary();
    updateApplyBatchButtonVisibility();
    if (typeof showStatus === 'function') {
      showStatus('🗑️ Defaults cleared', 'info');
    }
  };

  window.v2ApplyDefaults = function () {
    applyDefaultsToForm();
    if (typeof showStatus === 'function') {
      showStatus('📥 Defaults applied to empty fields', 'success');
    }
  };

  window.v2ApplyDefaultsBatch = function () {
    // Apply defaults to annotations in current bulk session
    if (!window.v2BulkMode || !window.v2BulkMode.sessionAnnotationIndices || window.v2BulkMode.sessionAnnotationIndices.length === 0) {
      if (typeof showStatus === 'function') {
        showStatus('❌ No bulk session annotations to apply defaults to', 'warning');
      }
      return;
    }

    if (typeof annotations === 'undefined' || !annotations) {
      if (typeof showStatus === 'function') {
        showStatus('❌ Annotations array not found', 'error');
      }
      return;
    }

    const fieldsToApply = [
      'analyst', 'obs_year', 'mission_id', 'site',
      'transect', 'segment', 'seglength', 'segwidth', 'spcode'
    ];

    const indices = window.v2BulkMode.sessionAnnotationIndices;
    let appliedCount = 0;
    let fieldCount = 0;

    // Apply each default field to each annotation in the batch
    indices.forEach(idx => {
      if (idx >= 0 && idx < annotations.length) {
        const ann = annotations[idx];
        fieldsToApply.forEach(field => {
          if (fieldDefaults[field] && !ann[field]) {
            ann[field] = fieldDefaults[field];
            if (ann.properties) {
              ann.properties[field] = fieldDefaults[field];
            }
            fieldCount++;
          }
        });
        appliedCount++;
      }
    });

    // Save the project with new values
    if (typeof saveProject === 'function') {
      saveProject();
    }

    // Refresh table
    if (typeof updateAnnotationTable === 'function') {
      updateAnnotationTable();
    }

    // Clear the batch session so next Apply works on new batch
    if (window.v2BulkMode && window.v2BulkMode.sessionAnnotationIndices) {
      window.v2BulkMode.sessionAnnotationIndices.length = 0;
    }

    updateApplyBatchButtonVisibility();

    if (typeof showStatus === 'function') {
      showStatus(`⚡ Applied defaults: ${appliedCount} annotations, ${fieldCount} fields`, 'success');
    }

    console.log(`v2-defaults: Applied batch defaults to ${appliedCount} annotations (${fieldCount} fields total)`);
  };

  // ===================================================================
  //  AUTO-APPLY DEFAULTS — after each save, re-apply defaults
  // ===================================================================
  function hookIntoSave() {
    // Hook into clearAnnotationForm to re-apply defaults after each save
    const origClear = window.clearAnnotationForm || window.clearForm;
    if (typeof origClear === 'function') {
      const wrappedClear = function () {
        origClear.apply(this, arguments);
        // After form is cleared, re-apply defaults
        setTimeout(() => applyDefaultsToForm(), 50);
      };
      // Replace both possible names
      if (typeof window.clearAnnotationForm === 'function') window.clearAnnotationForm = wrappedClear;
      if (typeof window.clearForm === 'function') window.clearForm = wrappedClear;
    }
  }

  // ===================================================================
  //  INIT
  // ===================================================================
  function init() {
    loadDefaults();
    initAllCaps();
    injectDefaultsBar();
    // Delay hookIntoSave to ensure v1 functions are defined
    setTimeout(() => {
      hookIntoSave();
      applyDefaultsToForm();
      updateApplyBatchButtonVisibility();
    }, 500);
    // Monitor bulk mode for changes to show/hide batch apply button
    const monitorBulk = setInterval(() => {
      updateApplyBatchButtonVisibility();
    }, 1000);
    console.log('🔧 v2-defaults.js loaded — All-Caps, Field Defaults, Batch Apply');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
