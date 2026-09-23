/**
 * Cross-project QC dashboard renderer.
 * Consumes GET /api/db/projects/filter-options (region/year dropdowns) and
 * GET /api/db/projects/qc (rollup + per-project completeness/consistency
 * flags). No chart library and no external network requests — offline /
 * gov-network constraint, same as report.js / export.js.
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
    const el = $('qcError');
    if (el) {
      el.textContent = message;
      el.style.display = message ? 'block' : 'none';
    }
  }

  function statTile(label, value, sub, hasIssues) {
    return (
      '<div class="cat-card stat-tile' + (hasIssues ? ' has-issues' : '') + '">' +
      '<div class="stat-label">' + escapeHtml(label) + '</div>' +
      '<div class="stat-value">' + escapeHtml(String(value)) + '</div>' +
      (sub ? '<div class="stat-sub">' + escapeHtml(sub) + '</div>' : '') +
      '</div>'
    );
  }

  function renderSummary(data) {
    const el = $('qcSummary');
    if (!el) return;
    const rollup = data.rollup || {};
    const missing = rollup.missing_fields || {};
    const unrecognized = rollup.by_unrecognized_species || [];
    const unrecognizedTotal = unrecognized.reduce((sum, u) => sum + u.count, 0);
    const projectsWithFlags = (data.projects || []).filter(p => p.flags && p.flags.length).length;

    el.innerHTML = [
      statTile('Projects', (data.projects || []).length),
      statTile('Total annotations', rollup.annotation_count || 0),
      statTile('Missing species', missing.spcode || 0, null, (missing.spcode || 0) > 0),
      statTile('Missing condition', missing.con_1 || 0, null, (missing.con_1 || 0) > 0),
      statTile('Unrecognized species codes', unrecognizedTotal,
        unrecognized.slice(0, 5).map(u => u.spcode + ' (' + u.count + ')').join(', ') || null,
        unrecognizedTotal > 0),
      statTile('Projects with issues', projectsWithFlags, null, projectsWithFlags > 0),
    ].join('');
  }

  function renderProjects(projects) {
    const tbody = $('qcProjectRows');
    const empty = $('qcEmpty');
    if (!tbody) return;

    if (!projects || !projects.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = projects.map(p => {
      const flagsHtml = (p.flags && p.flags.length)
        ? p.flags.map(f => '<span class="qc-flag">' + escapeHtml(f.message) + '</span>').join('')
        : '<span class="qc-flag qc-flag--clean">No issues</span>';
      return (
        '<tr class="' + (p.flags && p.flags.length ? 'has-flags' : '') + '">' +
        '<td><a href="/report?project_id=' + p.project_id + '">' + escapeHtml(p.project_name) + '</a></td>' +
        '<td>' + (escapeHtml(p.region) || '—') + '</td>' +
        '<td>' + (p.year != null ? p.year : '—') + '</td>' +
        '<td class="qc-count-cell">' + p.annotation_count + '</td>' +
        '<td>' + flagsHtml + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  async function loadFilterOptions() {
    try {
      const resp = await fetch('/api/db/projects/filter-options');
      if (!resp.ok) return;
      const data = await resp.json();
      const regionSel = $('qcRegion');
      const yearSel = $('qcYear');
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

  // Rapid filter changes used to fire overlapping requests, and whichever
  // answered LAST won — often an older filter's result. Now: a short debounce,
  // the previous request is cancelled, and only the newest response renders.
  let qcController = null;
  let qcSeq = 0;
  let qcDebounce = null;
  let qcHasData = false;

  function setLoading(on) {
    ['qcSummary', 'qcProjectRows'].forEach(id => {
      const el = $(id);
      if (el) el.style.opacity = on ? '0.45' : '';
    });
    const status = $('qcEmpty');
    if (on && !qcHasData && status) {
      status.textContent = 'Loading…';
      status.style.display = 'block';
    }
  }

  function scheduleLoad() {
    clearTimeout(qcDebounce);
    qcDebounce = setTimeout(loadQc, 250);
  }

  async function loadQc() {
    const region = $('qcRegion') ? $('qcRegion').value : '';
    const year = $('qcYear') ? $('qcYear').value : '';
    const scope = $('qcScope') ? $('qcScope').value : 'all';

    const params = new URLSearchParams();
    if (region) params.set('region', region);
    if (year) params.set('year', year);
    params.set('scope', scope);

    if (qcController) qcController.abort();
    const controller = new AbortController();
    qcController = controller;
    const seq = ++qcSeq;
    setLoading(true);

    try {
      const resp = await fetch('/api/db/projects/qc?' + params.toString(), { signal: controller.signal });
      if (!resp.ok) throw new Error('Failed to load QC data (' + resp.status + ')');
      const data = await resp.json();
      if (seq !== qcSeq) return; // a newer filter's request superseded this one
      showError('');
      const empty = $('qcEmpty');
      if (empty) empty.textContent = 'No projects match these filters.';
      renderSummary(data);
      renderProjects(data.projects || []);
      qcHasData = true;
    } catch (e) {
      if (e.name === 'AbortError' || seq !== qcSeq) return; // expected: superseded
      console.error('Error loading QC dashboard:', e);
      // Keep whatever was shown before (dimmed) rather than silently
      // rendering an empty dashboard that looks like "no problems".
      showError('Failed to load QC dashboard: ' + e.message + (qcHasData ? ' — showing the previous results.' : ''));
      if (!qcHasData) {
        renderSummary({ rollup: {}, projects: [] });
        renderProjects([]);
      }
    } finally {
      if (seq === qcSeq) {
        setLoading(false);
        qcController = null;
      }
    }
  }

  function init() {
    loadFilterOptions();
    loadQc();

    const regionSel = $('qcRegion');
    const yearSel = $('qcYear');
    const scopeSel = $('qcScope');
    if (regionSel) regionSel.addEventListener('change', scheduleLoad);
    if (yearSel) yearSel.addEventListener('change', scheduleLoad);
    if (scopeSel) scopeSel.addEventListener('change', scheduleLoad);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
