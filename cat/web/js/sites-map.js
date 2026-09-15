/**
 * sites-map.js — CAT Survey Sites map
 *
 * Fetches /api/sites, plots each site with coordinates as a circleMarker over
 * an OpenStreetMap tile basemap (with the vendored offline coastline as an
 * automatic fallback when external tiles are blocked), offers region/island/
 * depth/has-COG filters, and shows a popup per site with metadata + a
 * contextual action link.
 */

(function () {
  'use strict';

  // ---- theme colors (read from cat-theme.css custom properties) ----
  const rootStyle = getComputedStyle(document.documentElement);
  function themeColor(varName, fallback) {
    const v = rootStyle.getPropertyValue(varName);
    return v && v.trim() ? v.trim() : fallback;
  }
  // Filled federal blue = COG linked; hollow grey = no COG yet.
  const COLOR_HAS_COG = themeColor('--cat-primary', '#005ea2');
  const COLOR_NO_COG = themeColor('--cat-ink-soft', '#565c65');
  const COLOR_LAND_FILL = '#eef1f3';
  const COLOR_LAND_BORDER = '#c8ccd0';

  // ---- module state ----
  let map = null;
  let markersLayer = null;
  /** @type {Array<{site: object, lat: number, lng: number, marker: any}>} */
  let plotted = [];
  let allSites = [];
  let totalSites = 0;
  let missingCoordCount = 0;
  let dbApiAvailable = false;
  let storageBackend = 'file';
  /** Cache of site_name -> existing Oracle project_id (or null if none found), populated lazily. */
  const projectLookupCache = {};

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    map = L.map('sitesMap', {
      center: [10, 155],
      zoom: 4,
      worldCopyJump: true,
    });

    markersLayer = L.layerGroup().addTo(map);

    await Promise.all([loadBasemap(), loadConfig()]);
    await loadSites();

    // COG-status legend (bottom-left, styled via .sites-legend in sites.html)
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'sites-legend');
      div.innerHTML =
        '<span class="legend-dot legend-dot-cog"></span> COG linked' +
        '<span class="legend-dot legend-dot-nocog"></span> No COG';
      return div;
    };
    legend.addTo(map);

    wireFilterHandlers();

    // Exposed for QA/browser-harness verification only (not used by any app code path).
    window.__sitesMapDebug = { map, getPlotted: () => plotted };
  }

  async function loadConfig() {
    try {
      const resp = await fetch('/api/config');
      if (!resp.ok) return;
      const cfg = await resp.json();
      storageBackend = cfg?.storage_backend || 'file';
      dbApiAvailable = !!cfg?.db_api_available;
    } catch (err) {
      console.warn('Could not load /api/config:', err);
    }
  }

  async function loadBasemap() {
    // Primary basemap: OpenStreetMap tiles (external). The vendored Natural Earth
    // 1:110m land is far too coarse to show the small Pacific islands these sites
    // sit on, so OSM is used to give real coastlines/labels. This is the one place
    // the app reaches an external tile server at runtime (user-selected tradeoff).
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    let anyTileLoaded = false;
    osm.on('tileload', function () { anyTileLoaded = true; });
    osm.addTo(map);

    // Graceful degradation: if NOT A SINGLE tile loads within a few seconds — the
    // signature of an isolated / locked-down network where OSM is blocked — drop in
    // the vendored offline coastline so the map is never a blank grey void. Gated on
    // zero successful loads (not a single tileerror) so a stray 404 on a working
    // network doesn't paint the coarse coastline fill over live OSM tiles.
    setTimeout(async function () {
      if (anyTileLoaded) return;
      try {
        const resp = await fetch('/vendor/geo/world-land-110m.geojson');
        if (!resp.ok) return;
        const geojson = await resp.json();
        L.geoJSON(geojson, {
          style: { color: COLOR_LAND_BORDER, weight: 1, fillColor: COLOR_LAND_FILL, fillOpacity: 1 },
        }).addTo(map);
      } catch (err) {
        console.warn('Offline basemap fallback failed:', err);
      }
    }, 4000);
  }

  async function loadSites() {
    const readout = document.getElementById('siteCountReadout');
    if (readout) readout.textContent = 'Loading sites…';

    try {
      const resp = await fetch('/api/sites');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      allSites = data.sites || [];
      totalSites = data.total ?? allSites.length;

      populateFilterOptions(data.regions || []);
      plotSites(allSites);
      applyFilters();
    } catch (err) {
      console.error('Error loading /api/sites:', err);
      if (readout) readout.textContent = `Error loading sites: ${err.message}`;
    }
  }

  function populateFilterOptions(regions) {
    const regionSel = document.getElementById('siteFilterRegion');
    const islandSel = document.getElementById('siteFilterIsland');
    const depthSel = document.getElementById('siteFilterDepth');
    const surveyTypeSel = document.getElementById('siteFilterSurveyType');
    const cogSel = document.getElementById('siteFilterHasCog');

    if (regionSel) {
      regionSel.innerHTML = '<option value="">All Regions</option>';
      regions.forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r;
        regionSel.appendChild(opt);
      });
    }

    if (islandSel) {
      const islands = Array.from(
        new Set(allSites.flatMap((s) => siteVisits(s).map((v) => v.island)).filter((v) => v))
      ).sort();
      islandSel.innerHTML = '<option value="">All Islands</option>';
      islands.forEach((i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = i;
        islandSel.appendChild(opt);
      });
    }

    if (depthSel) {
      const depths = Array.from(
        new Set(allSites.map((s) => s.depth_bin).filter((v) => v))
      ).sort();
      const depthLabels = { S: 'Shallow (S)', M: 'Medium (M)', D: 'Deep (D)' };
      depthSel.innerHTML = '<option value="">All Depths</option>';
      depths.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = depthLabels[d] || d;
        depthSel.appendChild(opt);
      });
    }

    if (surveyTypeSel) {
      const surveyTypes = Array.from(
        new Set(allSites.flatMap((s) => siteVisits(s).map((v) => v.survey_type)).filter(Boolean))
      ).sort();
      surveyTypeSel.innerHTML = '<option value="">All Survey Types</option>';
      surveyTypes.forEach((surveyType) => {
        const opt = document.createElement('option');
        opt.value = surveyType;
        opt.textContent = surveyType;
        surveyTypeSel.appendChild(opt);
      });
    }

    if (cogSel) {
      cogSel.innerHTML = `
        <option value="">All Sites</option>
        <option value="with">With COG</option>
        <option value="without">No COG</option>
      `;
    }
  }

  function plotSites(sites) {
    markersLayer.clearLayers();
    plotted = [];
    missingCoordCount = 0;

    sites.forEach((site) => {
      const v = site.visit || {};
      // Guard null/'' explicitly: Number(null) and Number('') are both 0 (finite),
      // which would otherwise plot a coordinate-less site at [0,0] and skip the count.
      const hasLat = v.latitude != null && v.latitude !== '';
      const hasLng = v.longitude != null && v.longitude !== '';
      const lat = Number(v.latitude);
      const lng = Number(v.longitude);
      const hasCoords = hasLat && hasLng && Number.isFinite(lat) && Number.isFinite(lng);

      if (!hasCoords) {
        missingCoordCount += 1;
        return;
      }

      const marker = L.circleMarker([lat, lng], site.has_cog
        ? { radius: 6, color: '#ffffff', weight: 1.5, fillColor: COLOR_HAS_COG, fillOpacity: 0.95 }
        : { radius: 5, color: COLOR_NO_COG, weight: 1.5, fillColor: '#ffffff', fillOpacity: 0.6 });

      marker.bindPopup(() => buildPopupContent(site), { maxWidth: 320 });
      marker.on('popupopen', () => enhancePopupWithProjectLink(site, marker));
      marker.addTo(markersLayer);

      plotted.push({ site, lat, lng, marker });
    });

    if (plotted.length > 0) {
      // Fit the dense cluster, not the full extent: a lone far-flung site (Wake,
      // 166.7E vs the Marianas at ~145E) otherwise stretches the initial view so
      // wide the islands render as dots on open ocean. Exclude lng outliers
      // > 3 x the median absolute deviation, then fit what remains (fall back to
      // all sites if the filter would drop more than half of them).
      const lngs = plotted.map((p) => p.lng).sort((a, b) => a - b);
      const median = lngs[Math.floor(lngs.length / 2)];
      const devs = lngs.map((l) => Math.abs(l - median)).sort((a, b) => a - b);
      const mad = devs[Math.floor(devs.length / 2)] || 1;
      const core = plotted.filter((p) => Math.abs(p.lng - median) <= 3 * mad);
      const fitSet = core.length >= plotted.length * 0.5 ? core : plotted;
      const bounds = L.latLngBounds(fitSet.map((p) => [p.lat, p.lng]));
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 7 });
    }
  }

  function buildPopupContent(site) {
    const v = site.visit || {};
    const rows = [
      ['Region', site.region || '—'],
      ['Island', v.island || '—'],
      ['Depth', site.depth_bin || '—'],
      ['Survey date', v.survey_date || '—'],
      ['Cruise leg', v.cruise_leg || '—'],
      ['Survey type', v.survey_type || '—'],
      ['COG status', site.has_cog ? 'Available' : 'Not yet converted'],
    ];

    const rowsHtml = rows
      .map(
        ([label, val]) =>
          `<div style="display:flex; justify-content:space-between; gap:12px; font-size:12px; padding:2px 0;">
            <span style="color:var(--cat-ink-soft);">${label}</span><span>${escapeHtml(String(val))}</span>
          </div>`
      )
      .join('');

    const actionHtml = buildActionLinkHtml(site);

    // Show the site's imagery, not just the words "COG status: Available".
    // Falls back to the DEM when that's all that exists, and to a
    // placeholder when the site has no COG yet (the common case on a fresh
    // scan) — see js/cat-thumbnail.js.
    const previewUri = site.cog_uri || site.dem_uri || null;
    const thumbHtml = (typeof window.catThumbnailHtml === 'function')
      ? `<div style="margin-bottom:8px;">${window.catThumbnailHtml({
            cogUrl: previewUri,
            size: 220,
            alt: previewUri ? `Imagery for ${site.site_name}` : '',
            label: site.has_cog ? 'Preview' : 'Not yet converted',
            badge: (!site.cog_uri && site.dem_uri) ? 'DEM' : ''
          })}</div>`
      : '';

    return `
      <div style="min-width:220px; font-family:var(--cat-font);">
        <div style="font-weight:700; font-size:14px; margin-bottom:6px;">${escapeHtml(site.site_name)}</div>
        ${thumbHtml}
        ${rowsHtml}
        <div style="margin-top:10px;">
          ${actionHtml}
        </div>
      </div>
    `;
  }

  // Action link/status shown for a site's popup. Reads only from the synchronous
  // projectLookupCache — the actual network lookup is kicked off in
  // enhancePopupWithProjectLink, which re-renders the popup (via Leaflet's own
  // popup.update(), which re-invokes this content function) once the lookup
  // resolves. This avoids hand-patching the popup DOM, which Leaflet can
  // silently overwrite whenever it re-runs the content function (e.g. on
  // auto-pan) since bindPopup was given a content *function*.
  function buildActionLinkHtml(site) {
    const needsLookup = site.has_cog && dbApiAvailable && storageBackend === 'oracle';
    if (needsLookup) {
      const cached = Object.prototype.hasOwnProperty.call(projectLookupCache, site.site_name)
        ? projectLookupCache[site.site_name]
        : undefined;
      if (cached) {
        return `<a class="cat-btn cat-btn--primary" href="/annotation.html?project_id=${encodeURIComponent(cached)}" target="_blank" rel="noopener">Annotate (project #${cached})</a>`;
      }
      if (cached === null) {
        // Lookup completed, no existing Oracle project references this site yet.
        return buildCreateProjectLinkHtml(site);
      }
      return `<span style="font-size:11px; color:var(--cat-ink-soft);">Checking for an existing project…</span>`;
    }
    return buildCreateProjectLinkHtml(site);
  }

  function buildCreateProjectLinkHtml(site) {
    return `<a class="cat-btn cat-btn--primary" href="/project_creator.html" target="_blank" rel="noopener">Create project for this site</a>
      <div style="font-size:11px; color:var(--cat-ink-soft); margin-top:4px;">
        Use Site Browser → search "<strong>${escapeHtml(site.site_name)}</strong>"
      </div>`;
  }

  // On popup open: if the site has a COG, look up whether an Oracle project already
  // references this site (via the real /api/db/projects search endpoint used by
  // project_creator.html's own project list). If one exists, the next re-render
  // swaps in a direct Annotate link to that project. If none exists (or lookup
  // isn't possible), it falls back to the "create project" link — we never
  // fabricate a site->annotation URL that the app doesn't actually support.
  async function enhancePopupWithProjectLink(site, marker) {
    if (!site.has_cog || !dbApiAvailable || storageBackend !== 'oracle') return;
    if (Object.prototype.hasOwnProperty.call(projectLookupCache, site.site_name)) return;

    try {
      await resolveExistingProjectId(site.site_name);
    } catch (err) {
      console.warn('Project lookup failed for', site.site_name, err);
      projectLookupCache[site.site_name] = null;
    }
    // Force Leaflet to re-invoke the content function so it picks up the cache.
    if (marker.isPopupOpen()) marker.getPopup().update();
  }

  async function resolveExistingProjectId(siteName) {
    if (Object.prototype.hasOwnProperty.call(projectLookupCache, siteName)) {
      return projectLookupCache[siteName];
    }
    const resp = await fetch(`/api/db/projects?q=${encodeURIComponent(siteName)}&limit=25`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const projects = data.projects || [];
    const match = projects.find((p) => (p.site || '').toLowerCase() === siteName.toLowerCase());
    const projectId = match ? match.project_id : null;
    projectLookupCache[siteName] = projectId;
    return projectId;
  }

  function wireFilterHandlers() {
    ['siteFilterRegion', 'siteFilterIsland', 'siteFilterDepth', 'siteFilterSurveyType', 'siteFilterHasCog'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', applyFilters);
    });
  }

  function applyFilters() {
    const region = document.getElementById('siteFilterRegion')?.value || '';
    const island = document.getElementById('siteFilterIsland')?.value || '';
    const depth = document.getElementById('siteFilterDepth')?.value || '';
    const surveyType = document.getElementById('siteFilterSurveyType')?.value || '';
    const cogFilter = document.getElementById('siteFilterHasCog')?.value || '';

    let sites = allSites;
    if (region) sites = sites.filter((s) => s.region === region);
    if (island) sites = sites.filter((s) => siteVisits(s).some((v) => v.island === island));
    if (depth) sites = sites.filter((s) => s.depth_bin === depth);
    if (surveyType) sites = sites.filter((s) => siteVisits(s).some((v) => v.survey_type === surveyType));
    if (cogFilter === 'with') sites = sites.filter((s) => s.has_cog);
    if (cogFilter === 'without') sites = sites.filter((s) => !s.has_cog);

    plotSites(sites);
    updateReadout(sites.length);
  }

  function siteVisits(site) {
    return Array.isArray(site?.visits) && site.visits.length
      ? site.visits
      : (site?.visit ? [site.visit] : []);
  }

  function updateReadout(shownCount) {
    const readout = document.getElementById('siteCountReadout');
    if (!readout) return;
    readout.textContent = `Showing ${shownCount} of ${totalSites} sites — ${missingCoordCount} without coordinates`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
