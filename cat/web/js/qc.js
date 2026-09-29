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

  // ── Grading ────────────────────────────────────────────────────────────
  // Every flag used to be the same red pill, so a project with 1 of 500
  // annotations missing a condition looked as bad as one missing half its
  // species. Each flag now gets a level from its share of the project's
  // annotations. These are defaults: adjust the percentages here.
  //   level: 'critical' | 'warning' | 'note'  ('ok' = no flags)
  const LEVELS = {
    critical: { rank: 3, icon: '✖', label: 'Critical' },
    warning:  { rank: 2, icon: '⚠', label: 'Warning' },
    note:     { rank: 1, icon: 'ℹ', label: 'Note' },
    ok:       { rank: 0, icon: '✓', label: 'OK' },
  };
  const FLAG_RULES = {
    // share of annotations affected → level (first match wins)
    missing_species:      [{ atLeast: 0.10, level: 'critical' }, { atLeast: 0, level: 'warning' }],
    missing_condition:    [{ atLeast: 0.25, level: 'critical' }, { atLeast: 0, level: 'warning' }],
    unrecognized_species: [{ atLeast: 0.05, level: 'critical' }, { atLeast: 0, level: 'warning' }],
    empty:                [{ atLeast: 0, level: 'note' }],
  };
  const FLAG_LABELS = {
    missing_species: 'missing species',
    missing_condition: 'missing condition',
    unrecognized_species: 'unrecognized species code',
    empty: 'No annotations yet',
  };

  function gradeFlag(flag, total) {
    const share = total > 0 ? (flag.count || 0) / total : 0;
    const rules = FLAG_RULES[flag.type] || [{ atLeast: 0, level: 'warning' }];
    const rule = rules.find(r => share >= r.atLeast) || rules[rules.length - 1];
    return { level: rule.level, share: share };
  }

  function pct(share) {
    if (share > 0 && share < 0.01) return '<1%';
    return Math.round(share * 100) + '%';
  }

  function flagChip(flag, total) {
    const g = gradeFlag(flag, total);
    const lv = LEVELS[g.level];
    let text;
    if (flag.type === 'empty') {
      text = FLAG_LABELS.empty;
    } else {
      text = flag.count + ' ' + (FLAG_LABELS[flag.type] || flag.type) + ' · ' + pct(g.share);
    }
    return {
      level: g.level,
      share: g.share,
      html: '<span class="qc-flag qc-flag--' + g.level + '" title="' + escapeHtml(lv.label + ': ' + flag.message) + '">' +
            '<span class="qc-flag-icon" aria-hidden="true">' + lv.icon + '</span>' +
            '<span class="qc-sr">' + lv.label + ': </span>' + escapeHtml(text) + '</span>',
    };
  }

  function gradeProject(p) {
    const chips = (p.flags || []).map(f => flagChip(f, p.annotation_count));
    let worst = 'ok';
    let worstShare = 0;
    chips.forEach(c => {
      if (LEVELS[c.level].rank > LEVELS[worst].rank) { worst = c.level; worstShare = c.share; }
      else if (c.level === worst) worstShare = Math.max(worstShare, c.share);
    });
    return { chips: chips, worst: worst, worstShare: worstShare };
  }

  function statTile(label, value, sub, level) {
    return (
      '<div class="cat-card stat-tile' + (level ? ' stat-tile--' + level : '') + '">' +
      '<div class="stat-label">' + escapeHtml(label) + '</div>' +
      '<div class="stat-value">' + (level ? '<span class="qc-flag-icon" aria-hidden="true">' + LEVELS[level].icon + '</span> ' : '') +
      escapeHtml(String(value)) + '</div>' +
      (sub ? '<div class="stat-sub">' + escapeHtml(sub) + '</div>' : '') +
      '</div>'
    );
  }

  function tileLevel(type, count, total) {
    if (!count) return null;
    return gradeFlag({ type: type, count: count }, total).level;
  }

  function renderSummary(data) {
    const el = $('qcSummary');
    if (!el) return;
    const rollup = data.rollup || {};
    const total = rollup.annotation_count || 0;
    const missing = rollup.missing_fields || {};
    const unrecognized = rollup.by_unrecognized_species || [];
    const unrecognizedTotal = unrecognized.reduce((sum, u) => sum + u.count, 0);
    const graded = (data.projects || []).map(gradeProject);
    const byLevel = { critical: 0, warning: 0, note: 0, ok: 0 };
    graded.forEach(g => { byLevel[g.worst]++; });
    const complete = rollup.complete_count;

    el.innerHTML = [
      statTile('Projects', (data.projects || []).length,
        byLevel.critical + ' critical · ' + byLevel.warning + ' warning · ' + byLevel.ok + ' OK'),
      statTile('Total annotations', total,
        complete != null && total ? pct(complete / total) + ' complete (species + condition)' : null),
      statTile('Missing species', missing.spcode || 0,
        total ? pct((missing.spcode || 0) / total) + ' of annotations' : null,
        tileLevel('missing_species', missing.spcode, total)),
      statTile('Missing condition', missing.con_1 || 0,
        total ? pct((missing.con_1 || 0) / total) + ' of annotations' : null,
        tileLevel('missing_condition', missing.con_1, total)),
      statTile('Unrecognized species codes', unrecognizedTotal,
        unrecognized.slice(0, 5).map(u => u.spcode + ' (' + u.count + ')').join(', ') || null,
        tileLevel('unrecognized_species', unrecognizedTotal, total)),
    ].join('');
  }

  function completeCell(p) {
    if (!p.annotation_count || p.complete_count == null) return '<td class="qc-complete">—</td>';
    const share = p.complete_count / p.annotation_count;
    return '<td class="qc-complete" title="' + p.complete_count + ' of ' + p.annotation_count +
      ' annotations have species and condition">' +
      '<span class="qc-meter"><span style="width:' + (share * 100).toFixed(1) + '%"></span></span>' +
      '<span class="qc-meter-value">' + pct(share) + '</span></td>';
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

    // Worst level first, then the largest affected share, then name.
    const rows = projects.map(p => ({ p: p, g: gradeProject(p) }));
    rows.sort((a, b) =>
      (LEVELS[b.g.worst].rank - LEVELS[a.g.worst].rank) ||
      (b.g.worstShare - a.g.worstShare) ||
      String(a.p.project_name || '').localeCompare(String(b.p.project_name || '')));

    tbody.innerHTML = rows.map(({ p, g }) => {
      const lv = LEVELS[g.worst];
      const flagsHtml = g.chips.length
        ? g.chips.map(c => c.html).join('')
        : '<span class="qc-flag qc-flag--ok"><span class="qc-flag-icon" aria-hidden="true">✓</span>No issues</span>';
      return (
        '<tr class="qc-row--' + g.worst + '">' +
        '<td class="qc-status"><span class="qc-status-dot qc-status-dot--' + g.worst + '" aria-hidden="true">' + lv.icon + '</span>' + lv.label + '</td>' +
        '<td><a href="/report?project_id=' + p.project_id + '">' + escapeHtml(p.project_name) + '</a></td>' +
        '<td>' + (escapeHtml(p.region) || '—') + '</td>' +
        '<td>' + (p.year != null ? p.year : '—') + '</td>' +
        '<td class="qc-count-cell">' + p.annotation_count + '</td>' +
        completeCell(p) +
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
