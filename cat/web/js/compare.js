// Team-lead compare view: several projects from one site layered on a single
// map, coloured by annotator / species / project, one line style per project,
// with optional labels and the projects' transect/segment layers. Read-only.
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
  const NO_SPECIES = '(no species)';
  const NO_SPECIES_COLOR = '#667eea'; // the annotation page's colour for "no species yet"
  // One stroke pattern per project (cycled), so overlapping projects stay
  // distinguishable even when the same person annotated both.
  const DASHES = [null, '10 6', '2 6', '14 4 2 4', '6 3'];
  // Overlay colours when a layer has none saved (same as the annotation page's badges).
  const OVERLAY_TYPE_COLORS = { transect: '#ff8c00', segment: '#1e90ff' };
  // Labels are DOM elements; drawing thousands at once makes panning crawl.
  // Only what is on screen is labelled, up to this many.
  const LABEL_CAP = 600;

  const map = L.map('cmpMap', { zoomControl: true, maxZoom: 28 }).setView([0, 0], 2);
  map.createPane('imagery').style.zIndex = 250;
  map.createPane('overlays').style.zIndex = 350;      // transects/segments, under annotations
  const labelPane = map.createPane('cmpLabels');
  labelPane.style.zIndex = 650;
  labelPane.style.pointerEvents = 'none';
  const labelLayer = L.layerGroup().addTo(map);

  const state = {
    site: '',
    projects: [],                 // from /compare/site-projects
    selected: new Set(),          // project ids shown
    hiddenAnnotators: new Set(),  // annotator names hidden
    hiddenSpecies: new Set(),     // species codes hidden
    layers: new Map(),            // project id -> L.GeoJSON
    features: new Map(),          // project id -> features (cached)
    overlayMeta: new Map(),       // project id -> overlay layer rows
    overlayOn: new Set(),         // overlay layer ids shown
    overlayLayers: new Map(),     // overlay layer id -> L.GeoJSON
    overlayFeatures: new Map(),   // overlay layer id -> features (cached)
    colorBy: 'annotator',
    showLabels: false,
    labelMode: 'species_id',
    lineWidth: 4,
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
  function speciesOf(props) {
    const sp = props.spcode || props.SPCODE || props.species_code || props.SPECIES_CODE || '';
    return String(sp).trim().toUpperCase() || NO_SPECIES;
  }
  function speciesColor(sp) { return sp === NO_SPECIES ? NO_SPECIES_COLOR : colorFor(sp); }
  function projectIndex(pid) { return state.projects.findIndex(p => p.project_id === pid); }
  function projectColor(idx) { return PALETTE[Math.max(0, idx) % PALETTE.length]; }
  function idOf(feature) {
    const p = feature.properties || {};
    return p.colony_id || p.COLONY_ID || feature.id || p.annotation_id || '';
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
    state.overlayLayers.forEach(l => map.removeLayer(l));
    state.overlayLayers.clear();
    state.overlayFeatures.clear();
    state.overlayMeta.clear();
    state.overlayOn.clear();
    state.selected.clear();
    state.hiddenAnnotators.clear();
    state.hiddenSpecies.clear();
    labelLayer.clearLayers();
    if (!site) { renderProjects(); renderAnnotators(); renderSpecies(); renderOverlayList(); return; }
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
      const line = (dash ? 'border-top-style:dashed;' : '') +
        (state.colorBy === 'project' ? `border-top-color:${projectColor(i)};` : '');
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

  // ----------------------------------------------- annotators and species
  function countsBy(keyFn) {
    const counts = new Map();
    state.selected.forEach(pid => {
      (state.features.get(pid) || []).forEach(f => {
        const key = keyFn(f.properties || {});
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderToggleList(boxId, entries, hiddenSet, swatchFn, onChange) {
    const box = $(boxId);
    if (!entries.length) { box.className = 'cmp-empty'; box.textContent = '—'; return; }
    box.className = '';
    box.innerHTML = entries.map(([key, n]) => {
      const swatch = swatchFn(key);
      return `
      <label class="cmp-row">
        <input type="checkbox" data-key="${esc(key)}" ${hiddenSet.has(key) ? '' : 'checked'}>
        <span class="cmp-swatch" style="background:${swatch || 'transparent'};${swatch ? '' : 'border-style:dashed;'}"></span>
        <span class="grow">${esc(key)}</span>
        <span class="count">${n}</span>
      </label>`;
    }).join('');
    box.querySelectorAll('input[data-key]').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) hiddenSet.delete(cb.dataset.key); else hiddenSet.add(cb.dataset.key);
      onChange();
    }));
  }

  // Swatches show the colour on the map only for the active "Color by".
  function renderAnnotators() {
    renderToggleList('cmpAnnotators', countsBy(annotatorOf), state.hiddenAnnotators,
      who => state.colorBy === 'annotator' ? colorFor(who) : null, restyle);
  }
  function renderSpecies() {
    renderToggleList('cmpSpecies', countsBy(speciesOf), state.hiddenSpecies,
      sp => state.colorBy === 'species' ? speciesColor(sp) : null, restyle);
  }

  // --------------------------------------------------------------- layers
  function isShown(feature) {
    const p = feature.properties || {};
    return !state.hiddenAnnotators.has(annotatorOf(p)) && !state.hiddenSpecies.has(speciesOf(p));
  }

  function colorOf(feature, idx) {
    const p = feature.properties || {};
    if (state.colorBy === 'species') return speciesColor(speciesOf(p));
    if (state.colorBy === 'project') return projectColor(idx);
    return colorFor(annotatorOf(p));
  }

  function styleFor(feature, idx) {
    const shown = isShown(feature);
    return {
      color: colorOf(feature, idx),
      weight: state.lineWidth,
      opacity: shown ? 0.9 : 0,
      fillOpacity: shown ? 0.2 : 0,
      dashArray: DASHES[idx % DASHES.length]
    };
  }

  function restyle() {
    state.layers.forEach((layer, pid) => {
      const idx = projectIndex(pid);
      layer.setStyle(f => styleFor(f, idx));
    });
    scheduleLabels();
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
    renderSpecies();
    const total = wanted.reduce((n, p) => n + (state.features.get(p.project_id) || []).length, 0);
    status(`${wanted.length} project(s), ${total} annotation(s) shown`);
    if (fit) fitToData();
    await refreshOverlays();
    scheduleLabels();
  }

  function fitToData() {
    const group = L.featureGroup([...state.layers.values()]);
    const b = group.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [30, 30], maxZoom: 24 });
  }

  // ---------------------------------------------- transects and segments
  function overlayColor(meta) {
    const style = meta.style || {};
    return style.color || OVERLAY_TYPE_COLORS[meta.layer_type] || '#00b050';
  }

  // Seg_ID first: segments also carry their transect's Trans_ID.
  function overlayLabelOf(props) {
    return props.Seg_ID ?? props.Trans_ID ?? props.name ?? props.Name ?? props.id ?? '';
  }

  async function refreshOverlays() {
    // Layer lists for newly selected projects; the ones switched on in the
    // project itself (is_active) start switched on here too.
    for (const pid of state.selected) {
      if (state.overlayMeta.has(pid)) continue;
      try {
        const data = await getJson(`${API}/projects/${pid}/overlay-layers`);
        const layers = data.layers || [];
        state.overlayMeta.set(pid, layers);
        layers.forEach(l => { if (l.is_active) state.overlayOn.add(l.layer_id); });
      } catch (e) {
        state.overlayMeta.set(pid, []);
      }
    }
    // Remove overlays that are off or whose project is no longer shown.
    const wanted = new Map();
    state.selected.forEach(pid => (state.overlayMeta.get(pid) || []).forEach(meta => {
      if (state.overlayOn.has(meta.layer_id)) wanted.set(meta.layer_id, { meta, pid });
    }));
    state.overlayLayers.forEach((layer, id) => {
      if (!wanted.has(id)) { map.removeLayer(layer); state.overlayLayers.delete(id); }
    });
    for (const [id, { meta, pid }] of wanted) {
      if (state.overlayLayers.has(id)) continue;
      let features = state.overlayFeatures.get(id);
      if (!features) {
        try {
          const data = await getJson(`${API}/projects/${pid}/overlay-layers/${id}/features`);
          features = (data.features || []).filter(f => f && f.feature).map(f => {
            const feat = f.feature.type === 'Feature' ? f.feature : { type: 'Feature', geometry: f.feature, properties: {} };
            return { ...feat, properties: { ...(feat.properties || {}), ...(f.properties || {}) } };
          });
          state.overlayFeatures.set(id, features);
        } catch (e) {
          status(`Could not load layer ${meta.layer_name}: ${e.message}`);
          continue;
        }
      }
      const color = overlayColor(meta);
      const project = state.projects.find(p => p.project_id === pid) || {};
      const layer = L.geoJSON({ type: 'FeatureCollection', features }, {
        pane: 'overlays',
        style: { color, weight: (meta.style || {}).weight || 2, opacity: 0.85, fillOpacity: 0.12 },
        pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 4, pane: 'overlays' }),
        onEachFeature: (f, l) => {
          l._cmpOverlayLabel = overlayLabelOf(f.properties || {});
          l.bindPopup(() => `<div style="font-size:12px;line-height:1.5;">
            <strong>${esc(l._cmpOverlayLabel || meta.layer_name)}</strong><br>
            Layer: ${esc(meta.layer_name)}${meta.layer_type ? ` (${esc(meta.layer_type)})` : ''}<br>
            Project: ${esc(project.project_name || '#' + pid)}
          </div>`);
        }
      }).addTo(map);
      state.overlayLayers.set(id, layer);
    }
    renderOverlayList();
    scheduleLabels();
  }

  function renderOverlayList() {
    const box = $('cmpOverlays');
    const rows = [];
    state.projects.forEach(p => {
      if (!state.selected.has(p.project_id)) return;
      (state.overlayMeta.get(p.project_id) || []).forEach(meta => rows.push({ p, meta }));
    });
    if (!rows.length) { box.className = 'cmp-empty'; box.textContent = state.selected.size ? 'No layers in the shown projects.' : '—'; return; }
    box.className = '';
    box.innerHTML = rows.map(({ p, meta }) => {
      const badge = meta.layer_type
        ? `<span class="cmp-badge" style="background:${OVERLAY_TYPE_COLORS[meta.layer_type] || '#64748b'}">${esc(meta.layer_type)}</span>` : '';
      const n = (state.overlayFeatures.get(meta.layer_id) || []).length;
      return `
        <label class="cmp-row">
          <input type="checkbox" data-overlay="${meta.layer_id}" ${state.overlayOn.has(meta.layer_id) ? 'checked' : ''}>
          <span class="cmp-swatch" style="background:${overlayColor(meta)}"></span>
          <span class="grow">
            <div>${esc(meta.layer_name)} ${badge}</div>
            <div class="sub">${esc(p.project_name)}</div>
          </span>
          <span class="count">${n || ''}</span>
        </label>`;
    }).join('');
    box.querySelectorAll('input[data-overlay]').forEach(cb => cb.addEventListener('change', () => {
      const id = Number(cb.dataset.overlay);
      if (cb.checked) state.overlayOn.add(id); else state.overlayOn.delete(id);
      refreshOverlays();
    }));
  }

  // --------------------------------------------------------------- labels
  function labelText(feature) {
    const p = feature.properties || {};
    const sp = speciesOf(p);
    const spText = sp === NO_SPECIES ? (feature.geometry && /LineString/.test(feature.geometry.type) ? 'Line' : 'Ann') : sp;
    if (state.labelMode === 'species') return spText;
    if (state.labelMode === 'annotator') return annotatorOf(p);
    if (state.labelMode === 'id') return `#${idOf(feature)}`;
    return `${spText} #${idOf(feature)}`;
  }

  function centerOf(layer) {
    if (layer.getLatLng) return layer.getLatLng();
    try { return layer.getCenter(); } catch (e) { /* not on the map yet */ }
    return layer.getBounds ? layer.getBounds().getCenter() : null;
  }

  function addLabel(latlng, text, background, extraClass) {
    L.marker(latlng, {
      pane: 'cmpLabels',
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'cmp-label' + (extraClass ? ' ' + extraClass : ''),
        html: `<div${background ? ` style="background:${background}"` : ''}>${esc(text)}</div>`,
        iconSize: null
      })
    }).addTo(labelLayer);
  }

  let labelFrame = null;
  function scheduleLabels() {
    if (labelFrame) return;
    labelFrame = requestAnimationFrame(() => { labelFrame = null; renderLabels(); });
  }

  function renderLabels() {
    labelLayer.clearLayers();
    if (!state.showLabels) return;
    const view = map.getBounds().pad(0.05);
    let drawn = 0;
    let skipped = 0;
    const tryAdd = (layer, text, color, cls) => {
      const c = centerOf(layer);
      if (!c || !view.contains(c)) return;
      if (drawn >= LABEL_CAP) { skipped++; return; }
      addLabel(c, text, color, cls);
      drawn++;
    };
    state.overlayLayers.forEach(group => group.eachLayer(l => {
      if (l._cmpOverlayLabel !== '' && l._cmpOverlayLabel != null) tryAdd(l, l._cmpOverlayLabel, null, 'overlay');
    }));
    state.layers.forEach((group, pid) => {
      const idx = projectIndex(pid);
      group.eachLayer(l => {
        const f = l.feature;
        if (!f || !isShown(f)) return;
        tryAdd(l, labelText(f), colorOf(f, idx));
      });
    });
    if (skipped) status(`Showing ${LABEL_CAP} labels — zoom in to label the rest (${skipped} more in view).`);
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
  $('cmpAllSpecies').addEventListener('click', () => { state.hiddenSpecies.clear(); renderSpecies(); restyle(); });
  $('cmpNoSpecies').addEventListener('click', () => { countsBy(speciesOf).forEach(([sp]) => state.hiddenSpecies.add(sp)); renderSpecies(); restyle(); });
  $('cmpColorBy').addEventListener('change', e => {
    state.colorBy = e.target.value;
    renderProjects(); renderAnnotators(); renderSpecies(); restyle();
  });
  $('cmpShowLabels').addEventListener('change', e => { state.showLabels = e.target.checked; scheduleLabels(); });
  $('cmpLabelMode').addEventListener('change', e => { state.labelMode = e.target.value; scheduleLabels(); });
  $('cmpLineWidth').addEventListener('input', e => {
    state.lineWidth = Number(e.target.value) || 4;
    $('cmpLineWidthValue').textContent = state.lineWidth;
    restyle();
  });
  map.on('moveend', scheduleLabels);

  loadSites();
})();
