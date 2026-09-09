/**
 * Per-project report page renderer.
 * Consumes GET /api/db/projects/{project_id}/report (built in Task C1) and
 * renders summary tiles, HTML/CSS bar charts, breakdown tables, and a
 * missing-fields note. No chart library and no external network requests —
 * offline / gov-network constraint.
 */
(function () {
  'use strict';

  // Last successfully rendered report payload, kept so the Export CSV button
  // can serialize exactly what the page is showing (no re-fetch).
  var lastReport = null;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function $(id) {
    return document.getElementById(id);
  }

  function showError(message) {
    const el = $('reportError');
    if (el) {
      el.textContent = message;
      el.style.display = 'block';
    }
    const title = $('reportProjectTitle');
    if (title) title.textContent = 'Project Report';
  }

  // Build a titled group of horizontal bars for one breakdown.
  //   items: array of { label, count }
  function renderBarGroup(title, items) {
    if (!items.length) return '';
    const max = items.reduce((m, it) => Math.max(m, it.count), 0) || 1;
    const rows = items
      .map(function (it) {
        const pct = (it.count / max) * 100;
        return (
          '<div class="bar-row">' +
          '<span class="bar-label" title="' + escapeHtml(it.label) + '">' + escapeHtml(it.label) + '</span>' +
          '<span class="bar-track"><span class="bar-fill" style="width:' + pct.toFixed(1) + '%;"></span></span>' +
          '<span class="bar-count">' + it.count + '</span>' +
          '</div>'
        );
      })
      .join('');
    return (
      '<div class="chart-group">' +
      '<h3>' + escapeHtml(title) + '</h3>' +
      rows +
      '</div>'
    );
  }

  // Build a breakdown table (label + exact count).
  function renderTable(caption, headLabel, items) {
    if (!items.length) return '';
    const rows = items
      .map(function (it) {
        return (
          '<tr><td>' + escapeHtml(it.label) + '</td>' +
          '<td class="count-cell">' + it.count + '</td></tr>'
        );
      })
      .join('');
    return (
      '<div class="table-wrap">' +
      '<table class="report-table">' +
      '<caption>' + escapeHtml(caption) + '</caption>' +
      '<thead><tr><th>' + escapeHtml(headLabel) + '</th><th class="count-cell">Count</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '</div>'
    );
  }

  function statTile(label, value, sub) {
    return (
      '<div class="cat-card stat-tile">' +
      '<div class="stat-label">' + escapeHtml(label) + '</div>' +
      '<div class="stat-value">' + escapeHtml(String(value)) + '</div>' +
      (sub ? '<div class="stat-sub">' + escapeHtml(sub) + '</div>' : '') +
      '</div>'
    );
  }

  function formatArea(area) {
    if (!area || area.value === null || area.value === undefined) {
      return { value: '—', sub: 'No computable area.' };
    }
    const unit = area.unit === 'm^2' ? 'm²' : (area.unit || 'relative units');
    const valueStr = Number(area.value).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const display = area.unit === 'm^2' ? valueStr + ' m²' : valueStr + ' (' + unit + ')';
    const sub =
      (area.computable_count || 0) + ' computable · ' + (area.missing_count || 0) + ' missing area';
    return { value: display, sub: sub };
  }

  function renderMissing(missing) {
    const el = $('reportMissing');
    if (!el) return;
    const labels = { spcode: 'species', con_1: 'condition' };
    const clauses = [];
    Object.keys(missing || {}).forEach(function (key) {
      const count = missing[key];
      if (!count) return;
      const label = labels[key] || escapeHtml(key);
      const noun = count === 1 ? 'annotation' : 'annotations';
      clauses.push(count + ' ' + noun + ' missing ' + label);
    });
    if (!clauses.length) {
      el.style.display = 'none';
      return;
    }
    // clauses are numeric + known-safe words; missing keys pass through escapeHtml above.
    el.textContent = clauses.join('; ') + '.';
    el.style.display = 'block';
  }

  // ── CSV export ──────────────────────────────────────────────────────────
  // Quote a single CSV field if it contains a comma, quote, or newline.
  function csvField(value) {
    const s = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function csvRow(cells) {
    return cells.map(csvField).join(',');
  }

  function buildCsv(data) {
    const lines = [];
    lines.push(csvRow(['CAT Project Report']));
    lines.push(csvRow(['Project', '#' + data.project_id + ' — ' + (data.project_name || '')]));
    lines.push(csvRow(['Generated', new Date().toISOString()]));
    lines.push('');

    // Summary
    const area = data.total_area || {};
    const areaUnit = area.unit === 'm^2' ? 'm^2' : (area.unit || 'relative');
    lines.push(csvRow(['Summary']));
    lines.push(csvRow(['Metric', 'Value']));
    lines.push(csvRow(['Annotations', data.annotation_count]));
    lines.push(csvRow(['Distinct species', (data.by_species || []).length]));
    lines.push(csvRow(['Total area value', area.value === null || area.value === undefined ? '' : area.value]));
    lines.push(csvRow(['Total area unit', areaUnit]));
    lines.push(csvRow(['Area computable count', area.computable_count || 0]));
    lines.push(csvRow(['Area missing count', area.missing_count || 0]));
    lines.push('');

    // Breakdowns
    function block(title, headLabel, items, labelFn) {
      lines.push(csvRow([title]));
      lines.push(csvRow([headLabel, 'Count']));
      (items || []).forEach(function (it) {
        lines.push(csvRow([labelFn(it), it.count]));
      });
      lines.push('');
    }
    block('By species', 'Species', data.by_species, function (d) { return d.name || d.spcode; });
    block('By condition', 'Condition', data.by_condition, function (d) { return d.condition; });
    block('By shape type', 'Shape type', data.by_shape_type, function (d) { return d.shape_type; });

    // Missing fields
    const missing = data.missing_fields || {};
    const missingLabels = { spcode: 'species', con_1: 'condition' };
    lines.push(csvRow(['Missing fields']));
    lines.push(csvRow(['Field', 'Count']));
    Object.keys(missing).forEach(function (key) {
      lines.push(csvRow([missingLabels[key] || key, missing[key]]));
    });

    return lines.join('\r\n');
  }

  function exportCsv() {
    if (!lastReport) {
      window.alert('No report loaded yet.');
      return;
    }
    const csv = buildCsv(lastReport);
    // Prepend a UTF-8 BOM so Excel opens the accented degree text correctly.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'report_project_' + lastReport.project_id + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function render(data) {
    lastReport = data;
    const title = $('reportProjectTitle');
    if (title) {
      title.textContent = '#' + data.project_id + ' — ' + data.project_name;
    }

    const species = (data.by_species || []).map(function (d) {
      return { label: d.name || d.spcode, count: d.count };
    });
    const conditions = (data.by_condition || []).map(function (d) {
      return { label: d.condition, count: d.count };
    });
    const shapes = (data.by_shape_type || []).map(function (d) {
      return { label: d.shape_type, count: d.count };
    });

    // ── Summary tiles (always shown, even when empty) ──
    const area = formatArea(data.total_area);
    const summary = $('reportSummary');
    if (summary) {
      summary.innerHTML =
        statTile('Annotations', data.annotation_count, null) +
        statTile('Distinct species', species.length, null) +
        statTile('Total area', area.value, area.sub);
    }

    // ── Empty case: no charts/tables, keep summary + empty message ──
    if (data.annotation_count === 0) {
      const empty = $('reportEmpty');
      if (empty) empty.style.display = 'block';
      $('reportCharts').innerHTML = '';
      $('reportTables').innerHTML = '';
      $('reportMissing').style.display = 'none';
      return;
    }

    // ── Bar charts ──
    const charts = $('reportCharts');
    if (charts) {
      const groups =
        renderBarGroup('By species', species) +
        renderBarGroup('By condition', conditions) +
        renderBarGroup('By shape type', shapes);
      charts.innerHTML =
        '<div class="report-section cat-card">' +
        '<h2>Breakdowns</h2>' +
        (groups || '<p style="font-size:13px;color:var(--cat-ink-soft);">No categorized annotations.</p>') +
        '</div>';
    }

    // ── Tables ──
    const tables = $('reportTables');
    if (tables) {
      const tbls =
        renderTable('Species', 'Species', species) +
        renderTable('Condition', 'Condition', conditions) +
        renderTable('Shape type', 'Shape type', shapes);
      tables.innerHTML =
        '<div class="report-section cat-card">' +
        '<h2>Detail tables</h2>' +
        (tbls || '<p style="font-size:13px;color:var(--cat-ink-soft);">No categorized annotations.</p>') +
        '</div>';
    }

    // ── Missing-fields note ──
    renderMissing(data.missing_fields);
  }

  function load() {
    const csvBtn = $('exportCsvBtn');
    if (csvBtn) csvBtn.addEventListener('click', exportCsv);
    const printBtn = $('printBtn');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

    const params = new URLSearchParams(window.location.search);
    const raw = params.get('project_id');
    if (raw === null || raw.trim() === '' || !/^\d+$/.test(raw.trim())) {
      showError('No valid project_id provided. Open this page as /report?project_id=<id>.');
      return;
    }
    const id = raw.trim();

    fetch(window.location.origin + '/api/db/projects/' + id + '/report')
      .then(function (resp) {
        if (resp.status === 404) {
          throw { kind: 'notfound' };
        }
        if (!resp.ok) {
          throw { kind: 'http', status: resp.status };
        }
        return resp.json();
      })
      .then(function (data) {
        render(data);
      })
      .catch(function (err) {
        if (err && err.kind === 'notfound') {
          showError('Project not found (#' + id + ').');
        } else if (err && err.kind === 'http') {
          showError('Could not load report (HTTP ' + err.status + ').');
        } else {
          showError('Could not load report. Check your connection and try again.');
        }
      });
  }

  document.addEventListener('DOMContentLoaded', load);
})();
