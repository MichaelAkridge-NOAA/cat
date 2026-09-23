// Team-lead compare view: several projects from one site layered on a single
// map, coloured by annotator, one line style per project. Read-only.
(function () {
  'use strict';

  const API = window.location.origin + '/api/db';

  // Same palette + hash as annotation-runtime-symbology.js, so an annotator
  // has the same colour here as with "Color by Annotator" on the map page.
  const PALETTE = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
    '#46f0f0', '#f032e6', '#bcf60c', '#008080', '#9a6324',
    '#800000', '#808000', '#000075', '#e6beff', '#fabebe',
    '#ffd8b1', '#aaffc3', '#ffe119', '#1f77b4', '#d62728',
    '#2ca02c', '#8c564b', '#17becf', '#7f7f7f'
  ];
  function colorFor(value) {
    const key = String(value || '').trim().toUpperCase();
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return PALETTE[h % PALETTE.length];
  }
  // One stroke pattern per project (cycled), so overlapping projects stay
  // distinguishable even when the same person annotated both.
  const DASHES = [null, '10 6', '2 6', '14 4 2 4', '6 3'];

  const map = L.map('cmpMap', { zoomControl: true, maxZoom: 28 }).setView([0, 0], 2);
  const imageryPane = map.createPane('imagery'); imageryPane.style.zIndex = 250;

  const state = {
    site: '',
    projects: [],                 // from /compare/site-projects
    selected: new Set(),          // project ids shown
    hiddenAnnotators: new Set(),  // annotator names hidden
    layers: new Map(),            // project id -> L.GeoJSON
    features: new Map(),          // project id -> features (cached)
    imagery: null
  };

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const status = (msg) => { $('cmpStatus').textContent = msg || ''; };

  async function getJson(url) {
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  function annotatorOf(props) {
    return props.creator_display_name || props.created_by || props.analyst || 'Unknown';
  }

  // ---------------------------------------------------------------- sites
  async function loadSites() {
    try {
      const data = await getJson(`${API}/compare/sites`);
      const sel = $('cmpSite');
      const sites = data.sites || [];
      sel.innerHTML = '<option value="">— choose a site —</option>' + sites.map(s =>
        `<option value="${esc(s.site)}">${esc(s.site)} (${s.project_count} project${s.project_count === 1 ? '' : 's'}, ${s.annotation_count} annotations)</option>`
      ).join('');
      const fromUrl = new URLSearchParams(location.search).get('site');
      if (fromUrl) { sel.value = fromUrl.toUpperCase(); if (sel.value) selectSite(sel.value); }
    } catch (e) {
      $('cmpSite').innerHTML = '<option value="">Could not load sites</option>';
      status(`Could not load sites: ${e.message}`);
    }
  }

  async function selectSite(site) {
    state.site = site;
    state.layers.forEach(l => map.removeLayer(l));
    state.layers.clear();
    state.features.clear();
    state.selected.clear();
    state.hiddenAnnotators.clear();
    if (!site) { renderProjects(); renderAnnotators(); return; }
    status('Loading projects…');
    try {
      const data = await getJson(`${API}/compare/site-projects?site=${encodeURIComponent(site)}`);
      state.projects = data.projects || [];
      state.projects.forEach(p => state.selected.add(p.project_id));
      const url = new URL(location.href); url.searchParams.set('site', site); history.replaceState(null, '', url);
      renderProjects();
      renderImageryChoices();
      await refreshLayers(true);
    } catch (e) {
      status(`Could not load projects: ${e.message}`);
    }
  }

  // ------------------------------------------------------------- projects
  function renderProjects() {
    const box = $('cmpProjects');
    if (!state.projects.length) { box.className = 'cmp-empty'; box.textContent = state.site ? 'No projects at this site.' : 'Pick a site.'; return; }
    box.className = '';
    box.innerHTML = state.projects.map((p, i) => {
      const dash = DASHES[i % DASHES.length];
      const line = dash ? `border-top-style:dashed;` : '';
      const who = (p.annotators || []).map(a => a.annotator).join(', ') || 'no annotations yet';
      return `
        <label class="cmp-row">
          <input type="checkbox" data-project="${p.project_id}" ${state.selected.has(p.project_id) ? 'checked' : ''}>
          <span class="cmp-line" style="${line}" title="Line style for this project"></span>
          <span class="grow">
            <div>${esc(p.project_name)} ${p.year ? `<span class="sub">(${esc(p.year)})</span>` : ''}</div>
            <div class="sub">${esc(who)}</div>
          </span>
          <span class="count">${p.annotation_count}</span>
          <a href="/annotation.html?project_id=${p.project_id}" target="_blank" title="Open this project" style="text-decoration:none;">↗</a>
        </label>`;
    }).join('');
    box.querySelectorAll('input[data-project]').forEach(cb => cb.addEventListener('change', () => {
      const id = Number(cb.dataset.project);
      if (cb.checked) state.selected.add(id); else state.selected.delete(id);
      refreshLayers(false);
    }));
  }

  // ----------------------------------------------------------- annotators
  function renderAnnotators() {
    const box = $('cmpAnnotators');
    const counts = new Map();
    state.selected.forEach(pid => {
      (state.features.get(pid) || []).forEach(f => {
        const who = annotatorOf(f.properties || {});
        counts.set(who, (counts.get(who) || 0) + 1);
      });
    });
    if (!counts.size) { box.className = 'cmp-empty'; box.textContent = '—'; return; }
    box.className = '';
    box.innerHTML = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([who, n]) => `
      <label class="cmp-row">
        <input type="checkbox" data-annotator="${esc(who)}" ${state.hiddenAnnotators.has(who) ? '' : 'checked'}>
        <span class="cmp-swatch" style="background:${colorFor(who)}"></span>
        <span class="grow">${esc(who)}</span>
        <span class="count">${n}</span>
      </label>`).join('');
    box.querySelectorAll('input[data-annotator]').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) state.hiddenAnnotators.delete(cb.dataset.annotator);
      else state.hiddenAnnotators.add(cb.dataset.annotator);
      restyle();
    }));
  }

  // --------------------------------------------------------------- layers
  function styleFor(feature, projectIndex) {
    const who = annotatorOf(feature.properties || {});
    const hidden = state.hiddenAnnotators.has(who);
    return {
      color: colorFor(who),
      weight: 4,
      opacity: hidden ? 0 : 0.9,
      fillOpacity: hidden ? 0 : 0.2,
      dashArray: DASHES[projectIndex % DASHES.length]
    };
  }

  function restyle() {
    state.layers.forEach((layer, pid) => {
      const idx = state.projects.findIndex(p => p.project_id === pid);
      layer.setStyle(f => styleFor(f, idx));
    });
  }

  function popupFor(feature, project) {
    const p = feature.properties || {};
    return `<div style="font-size:12px;line-height:1.5;">
      <strong>${esc(p.spcode || p.SPCODE || '(no species)')}</strong><br>
      Annotator: ${esc(annotatorOf(p))}<br>
      Project: ${esc(project.project_name)}<br>
      ${p.morph_code ? `Morph: ${esc(p.morph_code)}<br>` : ''}
      ${p.created_at ? `Created: ${esc(new Date(p.created_at).toLocaleString())}<br>` : ''}
      #${esc(feature.id || p.annotation_id)}
    </div>`;
  }

  async function refreshLayers(fit) {
    const wanted = state.projects.filter(p => state.selected.has(p.project_id));
    // Remove unticked projects
    state.layers.forEach((layer, pid) => {
      if (!state.selected.has(pid)) { map.removeLayer(layer); state.layers.delete(pid); }
    });
    status(wanted.length ? 'Loading annotations…' : '');
    for (const project of wanted) {
      if (state.layers.has(project.project_id)) continue;
      let features = state.features.get(project.project_id);
      if (!features) {
        try {
          const fc = await getJson(`${API}/projects/${project.project_id}/annotations/geojson`);
          features = (fc.features || []).filter(f => f && f.geometry);
          state.features.set(project.project_id, features);
        } catch (e) {
          status(`Could not load ${project.project_name}: ${e.message}`);
          continue;
        }
      }
      const idx = state.projects.indexOf(project);
      const layer = L.geoJSON({ type: 'FeatureCollection', features }, {
        style: f => styleFor(f, idx),
        pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 5 }),
        onEachFeature: (f, l) => l.bindPopup(() => popupFor(f, project))
      }).addTo(map);
      state.layers.set(project.project_id, layer);
    }
    renderAnnotators();
    const total = wanted.reduce((n, p) => n + (state.features.get(p.project_id) || []).length, 0);
    status(`${wanted.length} project(s), ${total} annotation(s) shown`);
    if (fit) fitToData();
  }

  function fitToData() {
    const group = L.featureGroup([...state.layers.values()]);
    const b = group.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [30, 30], maxZoom: 24 });
  }

  // -------------------------------------------------------------- imagery
  function renderImageryChoices() {
    const sel = $('cmpImagery');
    const opts = ['<option value="">None</option>'];
    state.projects.forEach(p => (p.assets || []).forEach(a => {
      opts.push(`<option value="${esc(a.cog_url)}">${esc(p.project_name)} — ${esc(a.asset_name)}</option>`);
    }));
    sel.innerHTML = opts.join('');
    // Default to the first orthomosaic (not a DEM) if there is one.
    const first = state.projects.flatMap(p => p.assets || []).find(a => !/dem/i.test(a.asset_type || '') && !/dem/i.test(a.asset_name || ''));
    sel.value = first ? first.cog_url : '';
    setImagery(sel.value);
  }

  async function setImagery(cogUrl) {
    if (state.imagery) { map.removeLayer(state.imagery); state.imagery = null; }
    if (!cogUrl) return;
    let path = cogUrl.startsWith('gs://') ? '/vsigs/' + cogUrl.slice(5) : cogUrl;
    try {
      // Same LOCAL_CS handling as the annotation page: use the server's VRT.
      const crs = await getJson(`${window.location.origin}/api/check-cog-crs?url=${encodeURIComponent(cogUrl)}`);
      if (crs && crs.is_local_cs && crs.vrt_path) path = crs.vrt_path;
    } catch (e) { /* fall back to the plain COG */ }
    state.imagery = L.tileLayer(`${window.location.origin}/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(path)}`, {
      pane: 'imagery', maxZoom: 28, maxNativeZoom: 24
    }).addTo(map);
    if (!state.layers.size) {
      try {
        const b = await getJson(`${window.location.origin}/bounds?url=${encodeURIComponent(path)}`);
        if (b && b.bounds) map.fitBounds([[b.bounds[1], b.bounds[0]], [b.bounds[3], b.bounds[2]]]);
      } catch (e) { /* no bounds — keep the view */ }
    }
  }

  // ---------------------------------------------------------------- wire
  $('cmpSite').addEventListener('change', e => selectSite(e.target.value));
  $('cmpImagery').addEventListener('change', e => setImagery(e.target.value));
  $('cmpAllProjects').addEventListener('click', () => { state.projects.forEach(p => state.selected.add(p.project_id)); renderProjects(); refreshLayers(false); });
  $('cmpNoProjects').addEventListener('click', () => { state.selected.clear(); renderProjects(); refreshLayers(false); });

  loadSites();
})();
