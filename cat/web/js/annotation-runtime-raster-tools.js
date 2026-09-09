// Hillshade/slope generation for DEM layers (cat/api/raster_tools.py) and
// zonal statistics for a polygon annotation against the active DEM.
// Event-delegated so it doesn't need to hook into project-layers.js's DOM
// creation directly — .dem-derivative-btn buttons are rendered there.
(function () {
  'use strict';

  document.addEventListener('click', function (e) {
    const btn = e.target.closest('.dem-derivative-btn');
    if (!btn) return;
    const cogPath = btn.dataset.cogPath;
    const derivative = btn.dataset.derivative; // 'hillshade' | 'slope'
    const tifName = btn.dataset.tifName || 'DEM';
    if (!cogPath || !derivative) return;
    generateDerivative(cogPath, derivative, tifName, btn);
  });

  async function generateDerivative(cogPath, derivative, tifName, btn) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    if (typeof showStatus === 'function') {
      showStatus(`Generating ${derivative} for ${tifName} — this can take a moment on a large raster…`, 'info');
    }
    try {
      const resp = await fetch(`/api/raster/${derivative}?src=${encodeURIComponent(cogPath)}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      addDerivativeLayer(data.path, `${tifName} — ${derivative}`, derivative);
      if (typeof showStatus === 'function') {
        showStatus(`✅ ${derivative} ready${data.cached ? ' (cached)' : ''}`, 'success');
      }
    } catch (error) {
      console.error(`Error generating ${derivative}:`, error);
      if (typeof showStatus === 'function') showStatus(`Error generating ${derivative}: ${error.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  function addDerivativeLayer(path, label, derivative) {
    if (typeof map === 'undefined' || !map) return;
    if (!map.getPane('demPane')) map.createPane('demPane');
    const colormap = derivative === 'hillshade' ? 'gray' : 'inferno';
    const rescale = derivative === 'hillshade' ? '0,255' : '0,60';
    const tileUrl = `${typeof serverUrl !== 'undefined' ? serverUrl : ''}/tiles/WebMercatorQuad/{z}/{x}/{y}.png` +
      `?url=${encodeURIComponent(path)}&bidx=1&colormap_name=${colormap}&rescale=${rescale}`;
    const layer = L.tileLayer(tileUrl, {
      pane: 'demPane',
      opacity: 0.75,
      attribution: label,
      maxZoom: 2000,
      minZoom: 0,
      tileSize: 256,
      errorTileUrl: '',
      noWrap: true,
    });
    layer.addTo(map);
    if (typeof window.catDerivativeLayers === 'undefined') window.catDerivativeLayers = [];
    window.catDerivativeLayers.push({ label, layer });
  }

  function _firstDemCogPath() {
    if (typeof currentProject === 'undefined' || !currentProject || !Array.isArray(currentProject.tif_files)) return null;
    const dem = currentProject.tif_files.find(t => t.type === 'DEM' || (t.name || '').toLowerCase().includes('dem'));
    return dem ? dem.cog_path : null;
  }
  window.catFirstDemCogPath = _firstDemCogPath;

  // ── Zonal statistics: polygon annotation × active DEM ──
  window.catRunZonalStats = async function (annotationId, projectId) {
    const demCogPath = _firstDemCogPath();
    if (!demCogPath) {
      if (typeof showStatus === 'function') showStatus('No DEM layer loaded in this project for zonal statistics.', 'warning');
      return;
    }
    try {
      const resp = await fetch(
        `/api/raster/zonal-stats?src=${encodeURIComponent(demCogPath)}&project_id=${projectId}&annotation_id=${annotationId}`
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }
      const stats = await resp.json();
      if (!stats.count) {
        if (typeof showStatus === 'function') showStatus('No valid DEM pixels found within this annotation.', 'warning');
        return;
      }
      const msg = `📊 DEM stats (n=${stats.count}): min ${stats.min.toFixed(2)}, max ${stats.max.toFixed(2)}, mean ${stats.mean.toFixed(2)}, std ${stats.std.toFixed(2)}`;
      if (typeof showStatus === 'function') showStatus(msg, 'success');
    } catch (error) {
      console.error('Zonal stats error:', error);
      if (typeof showStatus === 'function') showStatus(`Zonal statistics failed: ${error.message}`, 'error');
    }
  };
})();
