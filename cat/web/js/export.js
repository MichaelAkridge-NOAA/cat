/**
 * Export page: region/year filtered multi-project data export.
 * Consumes GET /api/db/projects/filter-options, GET /api/db/projects
 * (region/year query params), and triggers a download from
 * GET /api/db/projects/export/{geojson,csv}. No chart library and no
 * external network requests — offline / gov-network constraint, same as
 * report.js.
 */
(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showError(message) {
    const el = $('exportError');
    if (el) {
      el.textContent = message;
      el.style.display = message ? 'block' : 'none';
    }
  }

  var currentProjects = [];

  function selectedProjectIds() {
    return currentProjects
      .filter(p => {
        const cb = document.getElementById('exportCb_' + p.project_id);
        return cb && cb.checked;
      })
      .map(p => p.project_id);
  }

  function updateSelectedCount() {
    const count = selectedProjectIds().length;
    const el = $('exportSelectedCount');
    if (el) el.textContent = count + ' selected';
    const selectAll = $('exportSelectAll');
    if (selectAll) selectAll.checked = count > 0 && count === currentProjects.length;
  }

  function renderProjects(projects) {
    currentProjects = projects || [];
    const tbody = $('exportProjectRows');
    const empty = $('exportEmpty');
    if (!tbody) return;

    if (!currentProjects.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      updateSelectedCount();
      return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = currentProjects.map(p => `
      <tr>
        <td class="checkbox-cell">
          <input type="checkbox" id="exportCb_${p.project_id}" onchange="window._catExportUpdateCount()">
        </td>
        <td>${escapeHtml(p.project_name)}</td>
        <td>${escapeHtml(p.region) || '—'}</td>
        <td>${p.year != null ? p.year : '—'}</td>
        <td>${escapeHtml(p.owner_display_name || p.owner_username) || '—'}</td>
      </tr>
    `).join('');
    updateSelectedCount();
  }

  async function loadFilterOptions() {
    try {
      const resp = await fetch('/api/db/projects/filter-options');
      if (!resp.ok) return;
      const data = await resp.json();
      const regionSel = $('exportRegion');
      const yearSel = $('exportYear');
      if (regionSel) {
        (data.regions || []).forEach(r => {
          const opt = document.createElement('option');
          opt.value = r;
          opt.textContent = r;
          regionSel.appendChild(opt);
        });
      }
      if (yearSel) {
        (data.years || []).forEach(y => {
          const opt = document.createElement('option');
          opt.value = y;
          opt.textContent = y;
          yearSel.appendChild(opt);
        });
      }
    } catch (e) {
      console.error('Failed to load filter options:', e);
    }
  }

  async function loadProjects() {
    showError('');
    const region = $('exportRegion') ? $('exportRegion').value : '';
    const year = $('exportYear') ? $('exportYear').value : '';
    const scope = $('exportScope') ? $('exportScope').value : 'mine';

    const params = new URLSearchParams();
    params.set('limit', '500');
    params.set('scope', scope);
    if (region) params.set('region', region);
    if (year) params.set('year', year);

    try {
      const resp = await fetch('/api/db/projects?' + params.toString());
      if (!resp.ok) throw new Error('Failed to load projects (' + resp.status + ')');
      const data = await resp.json();
      renderProjects(data.projects || []);
    } catch (e) {
      console.error('Error loading projects:', e);
      showError('Failed to load projects: ' + e.message);
      renderProjects([]);
    }
  }

  function buildExportUrl(format) {
    const ids = selectedProjectIds();
    const params = new URLSearchParams();

    if (ids.length) {
      params.set('project_ids', ids.join(','));
    } else {
      const region = $('exportRegion') ? $('exportRegion').value : '';
      const year = $('exportYear') ? $('exportYear').value : '';
      const scope = $('exportScope') ? $('exportScope').value : 'mine';
      // "My projects" alone is already a meaningful, bounded filter; "All
      // projects" with nothing else set would mean "the whole database in
      // one click" and still needs a region/year to narrow it, same as before.
      if (!region && !year && scope !== 'mine') return null;
      if (region) params.set('region', region);
      if (year) params.set('year', year);
      params.set('scope', scope);
    }

    return '/api/db/projects/export/' + format + '?' + params.toString();
  }

  function triggerExport(format) {
    const url = buildExportUrl(format);
    if (!url) {
      showError('Select at least one project, or set a Region/Year filter, before exporting.');
      return;
    }
    showError('');
    // A GET to an endpoint that sends Content-Disposition: attachment
    // downloads without navigating away from this page.
    window.location.href = url;
  }

  function init() {
    loadFilterOptions();
    loadProjects();

    const regionSel = $('exportRegion');
    const yearSel = $('exportYear');
    const scopeSel = $('exportScope');
    if (regionSel) regionSel.addEventListener('change', loadProjects);
    if (yearSel) yearSel.addEventListener('change', loadProjects);
    if (scopeSel) scopeSel.addEventListener('change', loadProjects);

    const selectAll = $('exportSelectAll');
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        currentProjects.forEach(p => {
          const cb = document.getElementById('exportCb_' + p.project_id);
          if (cb) cb.checked = selectAll.checked;
        });
        updateSelectedCount();
      });
    }

    const geojsonBtn = $('exportGeojsonBtn');
    if (geojsonBtn) geojsonBtn.addEventListener('click', () => triggerExport('geojson'));
    const csvBtn = $('exportCsvBtn');
    if (csvBtn) csvBtn.addEventListener('click', () => triggerExport('csv'));
  }

  // Row checkboxes are rendered via innerHTML (see renderProjects), so their
  // onchange can't reach a closure — expose the count updater on window.
  window._catExportUpdateCount = updateSelectedCount;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
