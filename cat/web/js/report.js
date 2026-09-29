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

  function pctText(share) {
    if (!isFinite(share) || share <= 0) return '0%';
    if (share < 0.01) return '<1%';
    return (share * 100).toFixed(share < 0.1 ? 1 : 0) + '%';
  }

  // Build a titled group of horizontal bars for one breakdown.
  //   items: array of { label, count, kind? ('missing' | 'other'), title? }
  //   total: what 100% means (bars used to be scaled to the LARGEST
  //          category, so the top one always filled the track whether it
  //          was 5% or 95% of the annotations).
  function renderBarGroup(title, items, total, note, fmt) {
    if (!items.length || !total) return '';
    const format = fmt || function (v) { return v.toLocaleString(); };
    const rows = items
      .map(function (it) {
        const share = it.count / total;
        const tip = (it.title || it.label) + ': ' + format(it.count) + ' (' + pctText(share) + ')';
        return (
          '<div class="bar-row' + (it.kind ? ' bar-row--' + it.kind : '') + '" title="' + escapeHtml(tip) + '">' +
          '<span class="bar-label">' + escapeHtml(it.label) + '</span>' +
          '<span class="bar-track"><span class="bar-fill" style="width:' + Math.min(100, share * 100).toFixed(2) + '%;"></span></span>' +
          '<span class="bar-count">' + escapeHtml(format(it.count)) + ' <span class="bar-pct">· ' + pctText(share) + '</span></span>' +
          '</div>'
        );
      })
      .join('');
    return (
      '<div class="chart-group">' +
      '<h3>' + escapeHtml(title) + '</h3>' +
      (note ? '<p class="chart-note">' + escapeHtml(note) + '</p>' : '') +
      rows +
      '</div>'
    );
  }

  // Long category lists: the top N as bars, the rest folded into "Other".
  function topWithOther(items, n, otherNoun) {
    if (items.length <= n + 1) return items;
    const rest = items.slice(n);
    return items.slice(0, n).concat([{
      label: 'Other (' + rest.length + ' ' + otherNoun + ')',
      count: rest.reduce(function (s, it) { return s + it.count; }, 0),
      kind: 'other',
      title: rest.map(function (it) { return it.label; }).join(', '),
    }]);
  }

  function sumCounts(items) {
    return (items || []).reduce(function (s, it) { return s + (it.count || 0); }, 0);
  }

  function withMissing(items, missing) {
    return missing ? items.concat([{ label: 'Missing', count: missing, kind: 'missing' }]) : items;
  }

  // Generic table: columns = [{ head, cell(row) -> html, num? }]
  function renderTable(caption, columns, rows) {
    if (!rows.length) return '';
    const head = columns.map(function (c) {
      return '<th' + (c.num ? ' class="count-cell"' : '') + '>' + escapeHtml(c.head) + '</th>';
    }).join('');
    const body = rows.map(function (r) {
      return '<tr>' + columns.map(function (c) {
        return '<td' + (c.num ? ' class="count-cell"' : '') + '>' + c.cell(r) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return (
      '<div class="table-wrap">' +
      '<table class="report-table">' +
      '<caption>' + escapeHtml(caption) + '</caption>' +
      '<thead><tr>' + head + '</tr></thead>' +
      '<tbody>' + body + '</tbody>' +
      '</table>' +
      '</div>'
    );
  }

  const SHAPE_LABELS = {
    Polygon: 'Polygon (outline)', MultiPolygon: 'Polygon (multi-part)',
    LineString: 'Line', MultiLineString: 'Line (multi-part)',
    Point: 'Point', MultiPoint: 'Point (multi)',
  };

  function areaUnit(data) {
    return (data.total_area || {}).unit === 'm^2' ? 'm²' : 'relative units';
  }

  function fmtNum(v, digits) {
    if (v == null) return '—';
    const n = Number(v);
    // Relative (non-georeferenced) areas are tiny numbers; 2 decimals would
    // print every one of them as 0.
    if (n !== 0 && Math.abs(n) < 0.01) return n.toPrecision(3);
    return n.toLocaleString(undefined, { maximumFractionDigits: digits == null ? 2 : digits });
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

  function formatLength(length) {
    if (!length || length.value === null || length.value === undefined) {
      return { value: '—', sub: 'No computable length.' };
    }
    const unit = length.unit === 'm' ? 'm' : (length.unit || 'relative units');
    const valueStr = Number(length.value).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const display = length.unit === 'm' ? valueStr + ' m' : valueStr + ' (' + unit + ')';
    const sub =
      (length.computable_count || 0) + ' computable · ' + (length.missing_count || 0) + ' missing length';
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
    lines.push(csvRow(['Complete (species + condition)', data.complete_count == null ? '' : data.complete_count]));
    lines.push(csvRow(['Total area value', area.value === null || area.value === undefined ? '' : area.value]));
    lines.push(csvRow(['Total area unit', areaUnit]));
    lines.push(csvRow(['Area computable count', area.computable_count || 0]));
    lines.push(csvRow(['Area missing count', area.missing_count || 0]));
    const length = data.total_length || {};
    const lengthUnit = length.unit === 'm' ? 'm' : (length.unit || 'relative');
    lines.push(csvRow(['Total length value', length.value === null || length.value === undefined ? '' : length.value]));
    lines.push(csvRow(['Total length unit', lengthUnit]));
    lines.push(csvRow(['Length computable count', length.computable_count || 0]));
    lines.push(csvRow(['Length missing count', length.missing_count || 0]));
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
    // Species with area and size (one row per species)
    const unit = areaUnit(data);
    lines.push(csvRow(['By species']));
    lines.push(csvRow(['Species code', 'Name', 'Count', 'Share of annotations', 'Area (' + unit + ')', 'Mean size (cm)']));
    (data.by_species || []).forEach(function (d) {
      lines.push(csvRow([d.spcode, d.name, d.count, pctText(d.count / (data.annotation_count || 1)),
        d.area == null ? '' : d.area, d.mean_size_cm == null ? '' : d.mean_size_cm]));
    });
    lines.push('');
    block('By condition (con_1)', 'Condition', data.by_condition, function (d) { return d.condition; });
    block('By condition (any of con_1..con_3)', 'Condition', data.by_condition_any, function (d) { return d.condition; });
    block('By severity', 'Severity', data.by_severity, function (d) { return d.severity; });
    block('By morphology', 'Morphology', data.by_morphology, function (d) { return d.morph_code; });
    block('By size class', 'Size class', data.by_size_class, function (d) { return d.size_class; });
    block('By shape type', 'Shape type', data.by_shape_type, function (d) { return d.shape_type; });
    block('By annotator', 'Annotator', data.by_annotator, function (d) { return d.annotator; });
    block('By transect / segment', 'Transect / segment', data.by_transect_segment,
      function (d) { return d.transect + ' / ' + d.segment; });
    block('Unrecognized species codes', 'Code', data.by_unrecognized_species, function (d) { return d.spcode; });
    const flags = data.colony_flags || {};
    block('Colony flags', 'Flag', Object.keys(flags).map(function (k) { return { flag: k, count: flags[k] }; }),
      function (d) { return d.flag; });

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

    const total = data.annotation_count || 0;
    const missing = data.missing_fields || {};
    const bySpecies = data.by_species || [];
    const speciesLabel = function (d) {
      return d.name && d.name !== d.spcode ? d.spcode + ' — ' + d.name : d.spcode;
    };

    // ── Summary tiles (always shown, even when empty) ──
    const area = formatArea(data.total_area);
    const length = formatLength(data.total_length);
    const summary = $('reportSummary');
    if (summary) {
      summary.innerHTML =
        statTile('Annotations', total.toLocaleString(), null) +
        statTile('Distinct species', bySpecies.length, null) +
        statTile('Complete', data.complete_count == null || !total ? '—' : pctText(data.complete_count / total),
          data.complete_count == null ? null : data.complete_count + ' of ' + total + ' have species and condition') +
        statTile('Total area', area.value, area.sub) +
        statTile('Total length', length.value, length.sub);
    }

    // ── Empty case: no charts/tables, keep summary + empty message ──
    if (total === 0) {
      const empty = $('reportEmpty');
      if (empty) empty.style.display = 'block';
      $('reportCharts').innerHTML = '';
      $('reportTables').innerHTML = '';
      $('reportMissing').style.display = 'none';
      $('reportUnrecognized').style.display = 'none';
      return;
    }

    // ── Bar charts: share of all annotations unless noted ──
    const species = topWithOther(bySpecies.map(function (d) {
      return { label: speciesLabel(d), count: d.count };
    }), 15, 'species');
    const areaItems = bySpecies.filter(function (d) { return d.area; })
      .sort(function (a, b) { return b.area - a.area; })
      .map(function (d) { return { label: speciesLabel(d), count: d.area }; });
    const areaTotal = areaItems.reduce(function (s, it) { return s + it.count; }, 0);
    const conditionsAny = (data.by_condition_any || []).map(function (d) { return { label: d.condition, count: d.count }; });
    const severity = (data.by_severity || []).map(function (d) { return { label: 'Severity ' + d.severity, count: d.count }; });
    const morph = (data.by_morphology || []).map(function (d) { return { label: d.morph_code, count: d.count }; });
    const sizes = (data.by_size_class || []).map(function (d) { return { label: d.size_class, count: d.count }; });
    const shapes = (data.by_shape_type || []).map(function (d) {
      return { label: SHAPE_LABELS[d.shape_type] || d.shape_type, count: d.count };
    });
    const annotators = (data.by_annotator || []).map(function (d) { return { label: d.annotator, count: d.count }; });
    const flags = data.colony_flags || {};
    const flagItems = [['juvenile', 'Juvenile'], ['remnant', 'Remnant'], ['no_colony', 'No colony'], ['ex_bound', 'Out of bounds']]
      .filter(function (f) { return flags[f[0]]; })
      .map(function (f) { return { label: f[1], count: flags[f[0]] }; });

    const charts = $('reportCharts');
    if (charts) {
      const groups = [
        renderBarGroup('Species', withMissing(species, missing.spcode), total),
        // Area bars are shares of the total mapped area, not of annotations.
        areaItems.length ? renderAreaGroup(topWithOther(areaItems, 15, 'species'), areaTotal, areaUnit(data)) : '',
        renderBarGroup('Morphology', withMissing(morph, data.missing_morphology), total),
        renderBarGroup('Condition (con_1)', withMissing((data.by_condition || []).map(function (d) {
          return { label: d.condition, count: d.count };
        }), missing.con_1), total),
        // Only worth a second chart when con_2/con_3 hold something.
        sumCounts(data.by_condition_any) > sumCounts(data.by_condition)
          ? renderBarGroup('Condition (any of con_1–con_3)', conditionsAny, total,
            'An annotation can have up to three conditions, so these can add up to more than 100%.')
          : '',
        renderBarGroup('Severity', severity, severity.reduce(function (s, it) { return s + it.count; }, 0),
          'Share of all severities recorded (con_1–con_3).'),
        renderBarGroup('Size class (max diameter)', withMissing(sizes, sizes.length ? data.missing_size : 0), total),
        renderBarGroup('Shape type', shapes, total),
        annotators.length > 1 ? renderBarGroup('Annotator', annotators, total) : '',
        renderBarGroup('Colony flags', flagItems, total, 'Share of annotations with each flag set.'),
      ].join('');
      charts.innerHTML =
        '<div class="report-section cat-card">' +
        '<h2>Breakdowns</h2>' +
        (groups ? '<div class="chart-grid">' + groups + '</div>'
          : '<p style="font-size:13px;color:var(--cat-ink-soft);">No categorized annotations.</p>') +
        '</div>';
    }

    // ── Tables ──
    const tables = $('reportTables');
    if (tables) {
      const unit = areaUnit(data);
      const tbls =
        renderTable('Species detail', [
          { head: 'Code', cell: function (d) { return escapeHtml(d.spcode); } },
          { head: 'Name', cell: function (d) { return escapeHtml(d.name && d.name !== d.spcode ? d.name : '—'); } },
          { head: 'Count', num: true, cell: function (d) { return d.count.toLocaleString(); } },
          { head: '% of annotations', num: true, cell: function (d) { return pctText(d.count / total); } },
          { head: 'Area (' + unit + ')', num: true, cell: function (d) { return fmtNum(d.area); } },
          { head: '% of area', num: true, cell: function (d) { return d.area && areaTotal ? pctText(d.area / areaTotal) : '—'; } },
          { head: 'Mean size (cm)', num: true, cell: function (d) { return fmtNum(d.mean_size_cm, 1); } },
        ], bySpecies) +
        renderTable('Conditions and severity (con_1–con_3)', [
          { head: 'Condition', cell: function (d) { return escapeHtml(d.condition); } },
          { head: 'Count', num: true, cell: function (d) { return d.count.toLocaleString(); } },
          { head: 'Severities recorded', cell: function (d) {
            return (d.by_severity || []).map(function (s) { return escapeHtml(s.severity) + ': ' + s.count; }).join(' · ') || '—';
          } },
        ], data.by_condition_any || []) +
        renderTable('Transect / segment', [
          { head: 'Transect', cell: function (d) { return escapeHtml(d.transect); } },
          { head: 'Segment', cell: function (d) { return escapeHtml(d.segment); } },
          { head: 'Annotations', num: true, cell: function (d) { return d.count.toLocaleString(); } },
          { head: '% of annotations', num: true, cell: function (d) { return pctText(d.count / total); } },
        ], data.by_transect_segment || []);
      tables.innerHTML =
        '<div class="report-section cat-card">' +
        '<h2>Detail tables</h2>' +
        (tbls || '<p style="font-size:13px;color:var(--cat-ink-soft);">No categorized annotations.</p>') +
        '</div>';
    }

    // ── Missing-fields and unrecognized-codes notes ──
    renderMissing(data.missing_fields);
    renderUnrecognized(data.by_unrecognized_species || [], total);
  }

  function renderAreaGroup(items, areaTotal, unit) {
    // Area values are measurements, not counts: 2 decimals.
    return renderBarGroup('Area by species', items, areaTotal,
      'Share of total outlined area (' + unit + '), polygons only.',
      function (v) { return fmtNum(v, 2); });
  }

  function renderUnrecognized(items, total) {
    const el = $('reportUnrecognized');
    if (!el) return;
    if (!items.length) { el.style.display = 'none'; return; }
    const n = items.reduce(function (s, u) { return s + u.count; }, 0);
    el.textContent = n + ' annotation' + (n === 1 ? '' : 's') + ' (' + pctText(n / (total || 1)) + ') use species codes that are not in the species list: ' +
      items.map(function (u) { return u.spcode + ' (' + u.count + ')'; }).join(', ') +
      '. Likely typos or retired codes — fix them in the annotation table.';
    el.style.display = 'block';
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
