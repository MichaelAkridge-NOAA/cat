/* ============================================================
 * CAT - Site details drawer
 *
 * The project drawer (project-drawer.js) proved a docked-detail view is a
 * better fit than a modal or a navigation for "tell me more about this row
 * without losing my place in the list." The Site Browser has the same
 * shape of problem — a card is one line of badges, and a click currently
 * did nothing more than open the (Oracle-only) create-project modal — so
 * this reuses the same shell markup and CSS (.pd-drawer / .pd-overlay /
 * .pd-map / .pd-map-controls / .pd-facts, all from project-drawer.css)
 * rather than inventing a second drawer look.
 *
 * Unlike a project, a bare site has no annotations of its own — those
 * belong to whatever projects were later created against it — so this
 * drawer is intentionally lighter: a COG/DEM preview with the same
 * raster-switcher control, imagery facts read live from the tiler
 * (/info?url=), and the visit metadata the card already summarizes in
 * badges, spelled out in full.
 *
 * Data sources:
 *   The site object itself (region, depth_bin, cog_uri, dem_uri, visit) —
 *   already fetched for the grid by loadSiteBrowser() in
 *   project_creator.html, so opening the drawer costs no extra request.
 *   GET /info?url=   TiTiler: CRS, size, bands — same call the project
 *                    drawer makes, so the two "Imagery" sections read the
 *                    same way for the same COG.
 * ============================================================ */
(function () {
  'use strict';

  var overlayEl = null;
  var drawerEl = null;
  var map = null;
  var lastFocused = null;

  var mapRasterList = [];       // [{label, url, isDem}] for the switcher
  var _mapTileLayer = null;
  var shownIndex = -1;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Mirrors SITE_UTM_ZONES in data_prep/convert_gcs_mos_to_cog_v3.py /
  // convert_gcs_dem_to_cog_v3.py -- keep these two in sync by hand if the
  // 2026 region list changes. Purely informational here: lets a site's
  // "expected" zone be compared at a glance against the COG's actual CRS.
  var SITE_UTM_ZONES = {
    TUT: 'UTM 2S \u00b7 EPSG:32702', OFU: 'UTM 2S \u00b7 EPSG:32702', TAU: 'UTM 2S \u00b7 EPSG:32702',
    ROS: 'UTM 2S \u00b7 EPSG:32702', SWA: 'UTM 2S \u00b7 EPSG:32702',
    HOW: 'UTM 1S \u00b7 EPSG:32701', BAK: 'UTM 1S \u00b7 EPSG:32701',
    KIN: 'UTM 3N \u00b7 EPSG:32603', PAL: 'UTM 3N \u00b7 EPSG:32603',
    JAR: 'UTM 4S \u00b7 EPSG:32704',
  };

  function expectedZoneForSite(site) {
    var region = (site && (site.region || (site.site_name || '').split('-')[0]) || '').toUpperCase();
    return SITE_UTM_ZONES[region] || null;
  }

  function $(id) { return document.getElementById(id); }

  function setHtml(id, html) {
    var el = $(id);
    if (el) el.innerHTML = html;
  }

  function skeleton(lines) {
    var out = '';
    for (var i = 0; i < (lines || 3); i++) {
      out += '<div class="pd-skel' + (i % 2 ? ' pd-skel--short' : '') + '"></div>';
    }
    return out;
  }

  function fmtNum(n) {
    return (Number(n) || 0).toLocaleString();
  }

  // Mirrors project-drawer.js / annotation-runtime-project-layers.js: GDAL
  // reads gs:// through its /vsigs/ virtual filesystem.
  function toGdalPath(path) {
    if (!path) return path;
    return path.indexOf('gs://') === 0 ? '/vsigs/' + path.slice(5) : path;
  }

  // Resolve a COG's tile base URL, swapping in the cached LOCAL_CS->EPSG:4326
  // VRT override when needed (mirrors loadTifLayer() in
  // annotation-runtime-project-layers.js) — without this, TiTiler 500s trying
  // to reproject a raster with a non-standard local-metre CRS to WebMercator.
  function resolveTileBaseUrl(cogUrl) {
    var tpl = '/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=';
    return fetch('/api/check-cog-crs?url=' + encodeURIComponent(cogUrl))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (crsData) {
        var path = (crsData && crsData.is_local_cs && crsData.vrt_path) ? crsData.vrt_path : toGdalPath(cogUrl);
        return tpl + encodeURIComponent(path);
      })
      .catch(function () { return tpl + encodeURIComponent(toGdalPath(cogUrl)); });
  }

  function getJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ── Shell ────────────────────────────────────────────────────

  function build() {
    if (drawerEl) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'pd-overlay';
    overlayEl.addEventListener('click', close);

    drawerEl = document.createElement('aside');
    drawerEl.className = 'pd-drawer';
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-modal', 'true');
    drawerEl.setAttribute('aria-labelledby', 'sdTitle');
    drawerEl.innerHTML =
      '<div class="pd-head">' +
        '<div class="pd-head-row">' +
          '<div style="min-width:0; flex:1;">' +
            '<h2 class="pd-title" id="sdTitle">Site</h2>' +
            '<p class="pd-sub" id="sdSub"></p>' +
          '</div>' +
          '<button type="button" class="pd-close" id="sdClose" aria-label="Close details">&times;</button>' +
        '</div>' +
        '<div class="pd-actions" id="sdActions"></div>' +
      '</div>' +
      '<div class="pd-body">' +
        '<div class="pd-section">' +
          '<div class="pd-section-title">Preview</div>' +
          '<div class="pd-map" id="sdMap"></div>' +
          '<div class="pd-map-controls" id="sdMapControls"></div>' +
          '<div id="sdMapNote"></div>' +
        '</div>' +
        '<div class="pd-section">' +
          '<div class="pd-section-title">Imagery <span class="pd-count" id="sdAssetCount"></span></div>' +
          '<div id="sdAssets">' + skeleton(2) + '</div>' +
        '</div>' +
        '<div class="pd-section">' +
          '<div class="pd-section-title">Site info</div>' +
          '<dl class="pd-facts" id="sdInfo"></dl>' +
        '</div>' +
        '<div class="pd-section">' +
          '<div class="pd-section-title">Visit history <span class="pd-count" id="sdVisitCount"></span></div>' +
          '<div id="sdVisits"></div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlayEl);
    document.body.appendChild(drawerEl);

    $('sdClose').addEventListener('click', close);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawerEl.classList.contains('is-open')) {
        var modalOpen = Array.prototype.some.call(
          document.querySelectorAll('.modal-overlay'),
          function (m) { return getComputedStyle(m).display !== 'none'; }
        );
        if (!modalOpen) close();
      }
    });
  }

  function close() {
    if (!drawerEl) return;
    overlayEl.classList.remove('is-open');
    drawerEl.classList.remove('is-open');

    if (map) {
      try { map.remove(); } catch (e) { /* already gone */ }
      map = null;
    }
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  }
  window.closeSiteDrawer = close;

  // ── Open ─────────────────────────────────────────────────────

  function open(site) {
    if (!site) return;
    build();
    lastFocused = document.activeElement;

    mapRasterList = [];
    _mapTileLayer = null;
    shownIndex = -1;

    renderHeader(site);
    setHtml('sdAssets', skeleton(2));
    setHtml('sdMapNote', '');
    setHtml('sdMapControls', '');
    var mapHost = $('sdMap');
    if (mapHost) mapHost.innerHTML = '';

    overlayEl.classList.add('is-open');
    drawerEl.classList.add('is-open');
    $('sdClose').focus();

    renderInfo(site);
    renderVisits(site);
    renderMap(site);
    renderAssets(site);
  }
  window.openSiteDrawer = open;

  // ── Header ───────────────────────────────────────────────────

  function renderHeader(site) {
    var title = $('sdTitle');
    if (title) title.textContent = site.site_name || 'Site';

    var v = site.visit || {};
    var bits = [];
    if (site.region) bits.push(site.region);
    var depthLabel = { S: 'Shallow', M: 'Medium', D: 'Deep' }[site.depth_bin] || site.depth_bin;
    if (depthLabel) bits.push(depthLabel);
    if (v.cruise_leg) bits.push(v.cruise_leg);
    if (v.island) bits.push(v.island);
    var sub = $('sdSub');
    if (sub) sub.textContent = bits.join(' · ') || site.site_name || '';

    var canOracle = site.has_cog && (typeof storageBackend === 'undefined' ? false : storageBackend === 'oracle');
    var canManageAssets = typeof canManageSiteAssets !== 'undefined' && canManageSiteAssets;
    var siteJson = esc(JSON.stringify(site));
    setHtml('sdActions',
      (canManageAssets
        ? '<button class="cat-btn cat-btn--outline" style="font-size:12px; padding:6px 12px;" ' +
          'onclick="openCogAssetManager(JSON.parse(this.dataset.site))" data-site=\'' + siteJson + '\'>' +
          '<svg class="cat-icon"><use href="/vendor/feather/feather-sprite.svg#cloud"/></svg> Manage COGs</button>'
        : '') +
      '<button class="cat-btn cat-btn--primary" style="font-size:12px; padding:6px 12px;" ' +
        (canOracle ? 'onclick="openOracleModal(JSON.parse(this.dataset.site))" data-site=\'' + siteJson + '\'' : 'disabled title="No cloud COG matched yet, or Oracle mode is off"') +
        '>Create Oracle Project</button>'
    );
  }

  // ── Preview map ──────────────────────────────────────────────

  function renderMap(site) {
    var host = $('sdMap');
    if (!host) return;

    if (typeof L === 'undefined') {
      host.innerHTML = '<div class="pd-empty" style="padding:14px;">Map library unavailable.</div>';
      return;
    }

    var rasters = [];
    if (site.cog_uri) rasters.push({ label: 'Ortho', url: site.cog_uri, dem: false });
    if (site.dem_uri) rasters.push({ label: 'DEM', url: site.dem_uri, dem: true });

    if (!rasters.length) {
      host.innerHTML = '<div class="pd-empty" style="padding:14px; color:#cbd5e1;">' +
        'No imagery matched to this site yet.</div>';
      return;
    }

    map = L.map(host, {
      attributionControl: false,
      zoomControl: true,
      maxZoom: 30,
    }).setView([0, 0], 2);

    mapRasterList = rasters;
    _setActiveRaster(0);

    // Fit to the raster's own real footprint rather than the site's
    // recorded visit coordinates: these COGs are in site-local
    // coordinates, not real georeference, so the recorded lat/lon can
    // point the view at a patch of ocean the raster doesn't actually
    // cover, which reads as tiles silently failing to load.
    getJson('/info?url=' + encodeURIComponent(toGdalPath(rasters[0].url)))
      .then(function (info) {
        if (map && Array.isArray(info.bounds) && info.bounds.length === 4) {
          var b = info.bounds;
          map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [14, 14], maxZoom: 26 });
        }
      })
      .catch(function () { /* tile layer still shows once loaded, just unframed */ })
      .then(function () { if (map) map.invalidateSize(); });

    setTimeout(function () { if (map) map.invalidateSize(); }, 240);

    renderMapControls();
    updateMapNote();
  }

  var _rasterSwitchId = 0;

  function _setActiveRaster(index) {
    var asset = mapRasterList[index];
    if (!asset || !map) return;
    if (_mapTileLayer) {
      map.removeLayer(_mapTileLayer);
      _mapTileLayer = null;
    }
    shownIndex = index;
    var switchId = ++_rasterSwitchId;

    resolveTileBaseUrl(asset.url).then(function (baseUrl) {
      if (!map || switchId !== _rasterSwitchId) return; // drawer closed / raster switched again

      if (!asset.dem) {
        _mapTileLayer = L.tileLayer(baseUrl, { maxZoom: 30 }).addTo(map);
        return;
      }

      // Match the main annotator's own DEM rendering (loadTifLayer() in
      // annotation-runtime-project-layers.js): viridis colormap with a
      // rescale read from the raster's actual value distribution (2nd/98th
      // percentile) rather than a fixed guess.
      getJson('/statistics?url=' + encodeURIComponent(toGdalPath(asset.url)))
        .then(function (stats) {
          var band = (stats && (stats.b1 || stats['1'] || (stats.statistics && stats.statistics[0]))) || {};
          var min = band.percentile_2 != null ? band.percentile_2 : band.min;
          var max = band.percentile_98 != null ? band.percentile_98 : band.max;
          if (min == null || max == null || isNaN(min) || isNaN(max)) { min = -10; max = 10; }
          _addDemTileLayer(switchId, baseUrl, min, max);
        })
        .catch(function () { _addDemTileLayer(switchId, baseUrl, -10, 10); });
    });
  }

  function _addDemTileLayer(switchId, baseUrl, min, max) {
    if (!map || switchId !== _rasterSwitchId) return;
    var url = baseUrl + '&bidx=1&colormap_name=viridis&rescale=' + min + ',' + max;
    _mapTileLayer = L.tileLayer(url, { maxZoom: 30 }).addTo(map);
  }

  function renderMapControls() {
    var host = $('sdMapControls');
    if (!host) return;

    if (mapRasterList.length <= 1) {
      host.innerHTML = '';
      host.style.display = 'none';
      return;
    }

    host.innerHTML = '<div class="pd-map-switcher">' + mapRasterList.map(function (asset, i) {
      var active = shownIndex === i;
      return '<button type="button" class="pd-map-switch-btn' + (active ? ' is-active' : '') + '" ' +
        'onclick="__sdSwitchRaster(' + i + ')">' + esc(asset.label) + '</button>';
    }).join('') + '</div>';
    host.style.display = 'flex';
  }

  window.__sdSwitchRaster = function (index) {
    _setActiveRaster(index);
    renderMapControls();
    updateMapNote();
  };

  // "Showing X · N other raster not shown" under the preview map. This
  // used to also flag a raster whose georeference disagreed with the
  // site's recorded visit coordinates — removed on request, since these
  // COGs are all in site-local coordinates rather than real georeference,
  // so the absolute position was never meant to mean anything.
  function updateMapNote() {
    var asset = mapRasterList[shownIndex];
    var extra = mapRasterList.length > 1
      ? ' · ' + (mapRasterList.length - 1) + ' other raster not shown'
      : '';
    var note = asset
      ? '<div class="pd-map-note"><span>📐</span><span>Showing ' + esc(asset.label) + extra + '</span></div>'
      : '';

    setHtml('sdMapNote', note);
  }

  // ── Imagery facts ────────────────────────────────────────────

  function renderAssets(site) {
    var host = $('sdAssets');
    if (!host) return;

    var countEl = $('sdAssetCount');
    var assets = [];
    if (site.cog_uri) assets.push({ name: 'Orthomosaic', dem: false, url: site.cog_uri });
    if (site.dem_uri) assets.push({ name: 'DEM', dem: true, url: site.dem_uri });

    if (countEl) countEl.textContent = assets.length ? assets.length : '';

    if (!assets.length) {
      host.innerHTML = '<div class="pd-empty">No imagery linked to this site yet.</div>';
      return;
    }

    host.innerHTML = assets.map(function (asset, i) {
      return '<div class="pd-asset">' +
        '<div class="pd-asset-head">' +
          '<span class="pd-asset-name" title="' + esc(asset.url) + '">' + esc(asset.name) + '</span>' +
          '<span class="pd-tag' + (asset.dem ? ' pd-tag--dem' : '') + '">' + esc(asset.dem ? 'DEM' : 'COG') + '</span>' +
        '</div>' +
        '<dl class="pd-facts" id="sdAssetFacts' + i + '">' +
          '<dt>Details</dt><dd class="pd-loading">reading…</dd>' +
        '</dl>' +
        '<div class="pd-uri" title="' + esc(asset.url) + '">' + esc(asset.url) + '</div>' +
      '</div>';
    }).join('');

    assets.forEach(function (asset, i) {
      getJson('/info?url=' + encodeURIComponent(toGdalPath(asset.url)))
        .then(function (info) { renderAssetFacts(i, info, expectedZoneForSite(site)); })
        .catch(function () {
          setHtml('sdAssetFacts' + i,
            '<dt>Details</dt><dd>Could not read this COG — it may be missing or unreadable.</dd>');
        });
    });
  }

  function renderAssetFacts(index, info, expectedZone) {
    var rows = [];
    if (info.width && info.height) rows.push(['Size', fmtNum(info.width) + ' × ' + fmtNum(info.height) + ' px']);
    if (info.count) rows.push(['Bands', info.count + (info.dtype ? ' · ' + info.dtype : '')]);
    if (info.crs) {
      // TiTiler returns an OGC URI; the EPSG code is the useful part. A
      // LOCAL_CS/EngineeringCRS source (not yet reconverted with a real UTM
      // zone) won't match this pattern -- flag that plainly instead of
      // dumping the raw CRS JSON/WKT blob.
      var epsg = String(info.crs).match(/EPSG\/\d+\/(\d+)/);
      rows.push(['CRS', epsg ? 'EPSG:' + epsg[1] : 'LOCAL_CS / no EPSG (not georeferenced)']);
    }
    if (expectedZone) rows.push(['Expected zone', expectedZone]);
    if (Array.isArray(info.overviews) && info.overviews.length) {
      rows.push(['Overviews', info.overviews.join(', ')]);
    } else {
      rows.push(['Overviews', 'none — tiles and thumbnails will be slow']);
    }
    if (Array.isArray(info.bounds) && info.bounds.length === 4) {
      var b = info.bounds;
      var wM = Math.abs(b[2] - b[0]) * 111320 * Math.cos((b[1] * Math.PI) / 180);
      var hM = Math.abs(b[3] - b[1]) * 110540;
      rows.push(['Extent', wM.toFixed(1) + ' × ' + hM.toFixed(1) + ' m']);
      rows.push(['Origin', b[0].toFixed(5) + ', ' + b[1].toFixed(5)]);
    }
    if (!rows.length) {
      setHtml('sdAssetFacts' + index, '<dt>Details</dt><dd>No metadata returned.</dd>');
      return;
    }
    setHtml('sdAssetFacts' + index, rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join(''));
  }

  // ── Site info ────────────────────────────────────────────────

  function renderInfo(site) {
    var v = site.visit || {};
    var rows = [
      ['Region', site.region || '—'],
      ['Depth', { S: 'Shallow', M: 'Medium', D: 'Deep' }[site.depth_bin] || site.depth_bin || '—'],
    ];
    if (v.survey_date) rows.push(['Survey date', v.survey_date]);
    if (v.mission_id) rows.push(['Mission', v.mission_id]);
    if (v.cruise_leg) rows.push(['Cruise', v.cruise_leg]);
    if (v.survey_type) rows.push(['Survey type', v.survey_type]);
    if (v.team) rows.push(['Team', v.team]);
    if (v.island) rows.push(['Island', v.island]);
    if (v.photographer) rows.push(['Photographer', v.photographer]);
    if (v.latitude != null && v.longitude != null) {
      rows.push(['Coordinates', Number(v.latitude).toFixed(5) + ', ' + Number(v.longitude).toFixed(5)]);
    }
    rows.push(['COG status', site.has_cog ? 'Ready' : 'Not matched yet']);

    setHtml('sdInfo', rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join(''));
  }

  function renderVisits(site) {
    var visits = Array.isArray(site.visits) && site.visits.length
      ? site.visits
      : (site.visit ? [site.visit] : []);
    var count = $('sdVisitCount');
    if (count) count.textContent = visits.length ? visits.length : '';
    if (!visits.length) {
      setHtml('sdVisits', '<div class="pd-empty">No visit details recorded.</div>');
      return;
    }
    setHtml('sdVisits', visits.map(function (visit) {
      var details = [visit.mission_id, visit.cruise_leg, visit.team, visit.photographer]
        .filter(Boolean).map(esc).join(' · ');
      var location = [visit.island, visit.sector, visit.reef_zone]
        .filter(Boolean).map(esc).join(' · ');
      var facts = [];
      if (visit.survey_type) facts.push(['Survey type', visit.survey_type]);
      if (visit.survey_size) facts.push(['Survey size', visit.survey_size]);
      if (visit.occ_site_id) facts.push(['OCC site ID', visit.occ_site_id]);
      if (visit.camera_number) facts.push(['Camera', visit.camera_number]);
      if (visit.total_images) facts.push(['Images', visit.total_images]);
      if (visit.processing_status) facts.push(['Processing', visit.processing_status]);
      var corrections = [
        visit.color_correct ? 'Color: ' + visit.color_correct : '',
        visit.exposure_correct ? 'Exposure: ' + visit.exposure_correct : '',
      ].filter(Boolean).join(' · ');
      if (corrections) facts.push(['Corrections', corrections]);
      if (visit.latitude != null && visit.longitude != null) {
        facts.push(['Coordinates', Number(visit.latitude).toFixed(5) + ', ' + Number(visit.longitude).toFixed(5)]);
      }
      return '<div class="pd-asset">' +
        '<div class="pd-asset-head"><span class="pd-asset-name">' +
          esc(visit.survey_date || 'Date not recorded') + '</span>' +
          (visit.depth_bin ? '<span class="pd-tag">' + esc(visit.depth_bin) + '</span>' : '') +
        '</div>' +
        (details ? '<div class="pd-sub">' + details + '</div>' : '') +
        (location ? '<div class="pd-sub">' + location + '</div>' : '') +
        (facts.length ? '<dl class="pd-facts">' + facts.map(function (fact) {
          return '<dt>' + esc(fact[0]) + '</dt><dd>' + esc(fact[1]) + '</dd>';
        }).join('') + '</dl>' : '') +
        (visit.mosaic_issues ? '<div class="pd-sub"><strong>Mosaic issues:</strong> ' + esc(visit.mosaic_issues) + '</div>' : '') +
        (visit.notes ? '<div class="pd-sub"><strong>Notes:</strong> ' + esc(visit.notes) + '</div>' : '') +
        (visit.piclea_file_path ? '<div class="pd-uri" title="' + esc(visit.piclea_file_path) + '">' + esc(visit.piclea_file_path) + '</div>' : '') +
      '</div>';
    }).join(''));
  }
})();
