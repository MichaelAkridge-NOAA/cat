// Time & Activity report page (/activity).
(function () {
  'use strict';

  const API = window.location.origin + '/api/db';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function dur(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m`;
    return s ? `${s}s` : '0m';
  }
  function when(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmt(value, kind) {
    if (value == null) return '—';
    if (kind === 'duration') return dur(value);
    if (kind === 'rate') return `${value}/h`;
    return String(value);
  }

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function loadFilters() {
    try {
      const sites = await getJson(`${API}/compare/sites`);
      $('fSite').innerHTML = '<option value="">All sites</option>' +
        (sites.sites || []).map(s => `<option value="${esc(s.site)}">${esc(s.site)}</option>`).join('');
    } catch (e) { /* filters are optional */ }
    try {
      const pr = await getJson(`${API}/projects?scope=all&limit=500&sort_by=project_name&sort_dir=asc`);
      $('fProject').innerHTML = '<option value="">All projects</option>' +
        (pr.projects || []).map(p => `<option value="${p.project_id}">${esc(p.project_name)}${p.site ? ' — ' + esc(p.site) : ''}</option>`).join('');
    } catch (e) { /* optional */ }
    const q = new URLSearchParams(location.search);
    if (q.has('days')) $('fDays').value = q.get('days');
    if (q.has('site')) $('fSite').value = q.get('site');
    if (q.has('project_id')) $('fProject').value = q.get('project_id');
  }

  async function load() {
    const params = new URLSearchParams();
    if ($('fDays').value) params.set('days', $('fDays').value);
    if ($('fSite').value) params.set('site', $('fSite').value);
    if ($('fProject').value) params.set('project_id', $('fProject').value);
    history.replaceState(null, '', `${location.pathname}${params.toString() ? '?' + params : ''}`);
    $('err').textContent = '';
    try {
      render(await getJson(`${API}/activity/report?${params}`));
    } catch (e) {
      $('err').textContent = `Could not load the report: ${e.message}`;
    }
  }

  function render(d) {
    const t = d.totals || {};
    const hours = (t.total_seconds || 0) / 3600;
    $('tiles').innerHTML = [
      ['Active time', dur(t.total_seconds)],
      ['Annotations', t.annotations || 0],
      ['Annotators', t.annotators || 0],
      ['Projects', t.projects || 0],
      ['Sessions', t.sessions || 0],
      ['Team pace', hours >= 0.25 ? `${Math.round((t.annotations || 0) / hours)}/h` : '—'],
      ['Working now', t.active_now || 0]
    ].map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('');

    const medals = ['🥇', '🥈', '🥉', '4', '5'];
    $('boards').innerHTML = (d.leaderboards || []).map(b => `
      <div class="board">
        <h3>${esc(b.label)}</h3>
        ${b.entries.length ? `<ol>${b.entries.map((e, i) => `
          <li><span class="medal">${medals[i] || i + 1}</span><span class="who">${esc(e.annotator)}</span><span class="val">${esc(fmt(e.value, b.format))}</span></li>`).join('')}</ol>`
        : '<div class="empty">No data yet</div>'}
      </div>`).join('');

    const maxSecs = Math.max(1, ...(d.annotators || []).map(a => a.total_seconds || 0));
    $('tPeople').innerHTML = (d.annotators || []).map(a => `
      <tr>
        <td>${esc(a.annotator)}</td>
        <td><div style="display:flex;align-items:center;gap:8px;"><div class="bar" style="width:${Math.round(100 * (a.total_seconds || 0) / maxSecs)}%;min-width:2px;"></div><span>${dur(a.total_seconds)}</span></div></td>
        <td class="n">${a.sessions}</td>
        <td class="n">${a.sessions ? dur(a.avg_session_seconds) : '—'}</td>
        <td class="n">${a.annotations}</td>
        <td class="n">${a.annotations_per_hour != null ? a.annotations_per_hour : '—'}</td>
        <td class="n">${a.species != null ? a.species : '—'}</td>
        <td class="n">${a.days_active || 0}</td>
        <td class="n">${a.projects}</td>
        <td>${esc(when(a.last_active))}</td>
      </tr>`).join('') || '<tr><td colspan="10" style="color:var(--cat-ink-soft);">No activity in this period.</td></tr>';

    $('tProjects').innerHTML = (d.projects || []).map(p => `
      <tr>
        <td><a href="/annotation.html?project_id=${p.project_id}">${esc(p.project_name || '#' + p.project_id)}</a></td>
        <td>${p.site ? `<a href="/compare?site=${encodeURIComponent(p.site)}" title="Compare projects at this site">${esc(p.site)}</a>` : '—'}</td>
        <td class="n">${dur(p.total_seconds)}</td>
        <td class="n">${p.sessions}</td>
        <td class="n">${p.annotations}</td>
        <td>${esc((p.annotators || []).join(', '))}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="color:var(--cat-ink-soft);">No projects in this period.</td></tr>';

    $('tSessions').innerHTML = (d.recent_sessions || []).map(s => `
      <tr>
        <td>${esc(when(s.start_time))}</td>
        <td>${esc(s.annotator)}</td>
        <td>${esc(s.project_name || '#' + s.project_id)}</td>
        <td class="n">${dur(s.total_seconds)}</td>
        <td class="n">${s.annotation_count || 0}</td>
        <td>${s.is_active === 1 ? '<span class="live">● live</span>' : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="color:var(--cat-ink-soft);">No sessions in this period.</td></tr>';
  }

  ['fDays', 'fSite', 'fProject'].forEach(id => $(id).addEventListener('change', load));
  loadFilters().then(load);
})();
