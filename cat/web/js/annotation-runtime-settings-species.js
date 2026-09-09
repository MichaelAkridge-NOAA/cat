  // ============================================================
  //  Species Filter Settings — wired to project metadata
  // ============================================================
  (function () {
    'use strict';

    const REGION_LABELS = {
      samoa: 'Samoa', marianas: 'Marianas', hawaii: 'Hawaiʻi',
      johnston: 'Johnston', line_island: 'Line Islands',
      phoenix: 'Phoenix', wake: 'Wake',
    };
    const FLAG_LABELS = {
      hide_inactive: 'Hide inactive species',
      adu_only: 'Adult-survey species only',
      juv_only: 'Juvenile-survey species only',
    };

    // Active filters applied to autocomplete queries
    window._speciesFilters = {};

    // ── Open / close ──
    window.openSpeciesFilterSettings = function () {
      const modal = document.getElementById('speciesFilterModal');
      modal.style.display = 'flex';
      _buildToggles();
      _updatePreview();
    };
    window.closeSpeciesFilterModal = function () {
      document.getElementById('speciesFilterModal').style.display = 'none';
    };

    // ── Build toggle checkboxes ──
    function _buildToggles() {
      const saved = _loadFilters();

      // Regions
      const regionDiv = document.getElementById('sfRegionToggles');
      regionDiv.innerHTML = '';
      Object.entries(REGION_LABELS).forEach(([key, label]) => {
        const checked = saved[key] ? 'checked' : '';
        regionDiv.innerHTML += `
          <label style="display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid #e5e7eb;border-radius:6px;cursor:pointer;font-size:12px;background:#fff;">
            <input type="checkbox" class="sf-toggle" data-key="${key}" ${checked}
              onchange="document.dispatchEvent(new Event('sf-change'))" style="accent-color:#2563eb;">
            ${label}
          </label>`;
      });

      // Flags
      const flagDiv = document.getElementById('sfFlagToggles');
      flagDiv.innerHTML = '';
      Object.entries(FLAG_LABELS).forEach(([key, label]) => {
        const checked = saved[key] ? 'checked' : '';
        flagDiv.innerHTML += `
          <label style="display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid #e5e7eb;border-radius:6px;cursor:pointer;font-size:12px;background:#fff;">
            <input type="checkbox" class="sf-toggle" data-key="${key}" ${checked}
              onchange="document.dispatchEvent(new Event('sf-change'))" style="accent-color:#2563eb;">
            ${label}
          </label>`;
      });

      // Live preview on change
      document.addEventListener('sf-change', _updatePreview);
    }

    // ── Read current toggle states from modal ──
    function _readToggles() {
      const filters = {};
      document.querySelectorAll('.sf-toggle').forEach(cb => {
        if (cb.checked) filters[cb.dataset.key] = true;
      });
      return filters;
    }

    // ── Preview count ──
    async function _updatePreview() {
      const filters = _readToggles();
      const qs = _filtersToQueryString(filters);
      try {
        const resp = await fetch(`/api/coral/species?${qs}`);
        const data = await resp.json();
        const el = document.getElementById('sfPreviewCount');
        const anyFilter = Object.keys(filters).length > 0;
        el.innerHTML = anyFilter
          ? `<strong>${data.count}</strong> species match current filters (out of ~386 total)`
          : `<strong>${data.count}</strong> species (no filters — showing all)`;
      } catch (e) { console.warn('Preview fetch error', e); }
    }

    // ── Save ──
    window.saveSpeciesFilters = async function () {
      const filters = _readToggles();
      window._speciesFilters = filters;

      // Persist into project metadata
      if (typeof currentProject !== 'undefined' && currentProject) {
        if (!currentProject.metadata) currentProject.metadata = {};
        currentProject.metadata.species_filters = filters;

        // If DB project, also push to server
        if (currentProject.project_id && typeof storageBackend !== 'undefined' && storageBackend === 'oracle') {
          try {
            await catFetch(`/api/db/projects/${currentProject.project_id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ metadata: currentProject.metadata }),
            }, 'Saving species filters');
          } catch (e) {
            // Previously silent (console.warn only) — the modal still closed
            // and showed a success toast even if the DB push failed. catFetch
            // already toasted the failure; filters remain applied locally
            // (window._speciesFilters + localStorage below) so the feature
            // still works this session, just not persisted to the project.
            // Skip the success toast below so a real failure doesn't get
            // immediately overwritten by a false "saved" message.
            console.warn('Could not persist filters to DB:', e);
            try { localStorage.setItem('cat_species_filters', JSON.stringify(filters)); } catch (_) {}
            closeSpeciesFilterModal();
            return;
          }
        }

        // Mark unsaved for file-mode projects
        if (typeof hasUnsavedChanges !== 'undefined') hasUnsavedChanges = true;
      }

      // Also store in localStorage as a fallback
      try { localStorage.setItem('cat_species_filters', JSON.stringify(filters)); } catch (_) {}

      closeSpeciesFilterModal();
      if (typeof showStatus === 'function') showStatus('✅ Species filters saved', 'success');
    };

    // ── Reset ──
    window.resetSpeciesFilters = function () {
      document.querySelectorAll('.sf-toggle').forEach(cb => cb.checked = false);
      document.dispatchEvent(new Event('sf-change'));
    };

    // ── Load filters from project metadata (or localStorage fallback) ──
    function _loadFilters() {
      if (typeof currentProject !== 'undefined' && currentProject?.metadata?.species_filters) {
        window._speciesFilters = currentProject.metadata.species_filters;
        return window._speciesFilters;
      }
      try {
        const stored = localStorage.getItem('cat_species_filters');
        if (stored) {
          window._speciesFilters = JSON.parse(stored);
          return window._speciesFilters;
        }
      } catch (_) {}
      return window._speciesFilters || {};
    }

    // ── Convert filters dict to URL query string ──
    function _filtersToQueryString(filters) {
      const params = new URLSearchParams();
      Object.entries(filters || {}).forEach(([k, v]) => {
        if (v) params.set(k, '1');
      });
      return params.toString();
    }

    // Expose for use by annotation-form.js. Returns a string starting with '&' when
    // any filter is active (e.g. "&hide_inactive=1"), or '' when none are - callers
    // append it directly onto an existing query string (`...&limit=10${fqs}`) without
    // needing to know whether a separator is required. (Task 9 fix: the one existing
    // caller, v2-table.js's bulk-update species dropdown, was appending this directly
    // after `&limit=10` assuming a leading separator that was never actually there,
    // producing a malformed query string like `&limit=10hide_inactive=1` any time a
    // filter was active - silently merging the two param values into one instead of
    // filtering. Fixed here at the source so every caller gets a working string.)
    window.getSpeciesFilterQueryString = function () {
      const qs = _filtersToQueryString(window._speciesFilters || {});
      return qs ? '&' + qs : '';
    };

    // Auto-load filters when project loads
    const _origInterval = setInterval(() => {
      if (typeof currentProject !== 'undefined' && currentProject) {
        clearInterval(_origInterval);
        _loadFilters();
      }
    }, 500);
  })();
