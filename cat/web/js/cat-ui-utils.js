/* ================================================
   CAT - UI Utilities
   Styled confirm modal, keyboard shortcuts overlay,
   map view persistence, field validation helpers
   ================================================ */

// ─── Styled Confirm Modal ───────────────────────────────────────────────────
// Drop-in async replacement for window.confirm()
// Usage:  const ok = await catConfirm('Delete this?');
//         const ok = await catConfirm('Really delete?', { danger: true, ok: 'Delete' });

(function () {
  // Inject modal HTML once
  const _modalHTML = `
    <div id="catConfirmOverlay" style="
      display:none; position:fixed; inset:0; z-index:12000;
      background:rgba(0,0,0,0.5); align-items:center; justify-content:center;">
      <div style="
        background:#fff; border-radius:10px; box-shadow:0 8px 30px rgba(0,0,0,0.25);
        max-width:420px; width:92%; padding:0; overflow:hidden;">
        <div id="catConfirmBody" style="padding:22px 24px 14px; font-size:14px; line-height:1.5; color:#333;"></div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding:12px 20px 16px; border-top:1px solid #eee;">
          <button id="catConfirmCancel" style="
            padding:7px 18px; border:1px solid #d1d5db; border-radius:6px; background:#fff;
            color:#374151; font-size:13px; cursor:pointer;">Cancel</button>
          <button id="catConfirmOk" style="
            padding:7px 18px; border:none; border-radius:6px; color:#fff;
            font-size:13px; font-weight:600; cursor:pointer;">OK</button>
        </div>
      </div>
    </div>`;

  document.addEventListener('DOMContentLoaded', () => {
    document.body.insertAdjacentHTML('beforeend', _modalHTML);
  });

  window.catConfirm = function (message, opts = {}) {
    return new Promise(resolve => {
      const overlay = document.getElementById('catConfirmOverlay');
      const body = document.getElementById('catConfirmBody');
      const okBtn = document.getElementById('catConfirmOk');
      const cancelBtn = document.getElementById('catConfirmCancel');
      if (!overlay) { resolve(confirm(message)); return; } // fallback

      body.textContent = '';
      // Support multiline with \n
      message.split('\n').forEach((line, i) => {
        if (i > 0) body.appendChild(document.createElement('br'));
        body.appendChild(document.createTextNode(line));
      });

      okBtn.textContent = opts.ok || 'OK';
      cancelBtn.textContent = opts.cancel || 'Cancel';
      okBtn.style.background = opts.danger ? '#dc2626' : '#667eea';

      overlay.style.display = 'flex';
      okBtn.focus();

      function cleanup(result) {
        overlay.style.display = 'none';
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        if (e.key === 'Enter') { e.stopPropagation(); onOk(); }
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey, { capture: true });
    });
  };
})();


// ─── Species Color Map ─────────────────────────────────────────────────────
// Assigns a consistent, distinct color to each species code.
// Colors are visually distinct on both light and dark map backgrounds.
(function () {
  // 20 hand-picked colors that are distinguishable on satellite imagery
  const PALETTE = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#42d4f4',
    '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff',
    '#9A6324', '#fffac8', '#800000', '#aaffc3', '#000075',
    '#a9a9a9', '#e6beff', '#ffd8b1', '#ffe119', '#00b4d8',
  ];
  const map = {};   // spcode → color
  let nextIdx = 0;

  /**
   * Get a consistent color for a species code.
   * Same species always returns the same color within a session.
   * @param {string} spcode - Species code (case-insensitive)
   * @returns {string} Hex color
   */
  window.catSpeciesColor = function (spcode) {
    if (!spcode || spcode === '-' || spcode === 'Unknown' || spcode === 'Line' || spcode === 'Ann') return '#667eea'; // default purple
    const key = spcode.toUpperCase().trim();
    if (!key) return '#667eea';
    if (!map[key]) {
      map[key] = PALETTE[nextIdx % PALETTE.length];
      nextIdx++;
    }
    return map[key];
  };

  /** Get the full species→color map (for legend rendering) */
  window.catSpeciesColorMap = function () {
    return { ...map };
  };

  /** Reset the color assignments (call when loading a new project) */
  window.catSpeciesColorReset = function () {
    Object.keys(map).forEach(k => delete map[k]);
    nextIdx = 0;
  };
})();


// ─── Keyboard Shortcuts Overlay ─────────────────────────────────────────────
// Press "?" (when no input focused) to show all shortcuts

(function () {
  const SHORTCUTS = [
    // Drawing
    ['D',          'Activate line (polyline) tool'],
    ['P',          'Activate polygon tool'],
    ['R',          'Activate rectangle tool'],
    ['Ctrl+S',     'Save annotation'],
    ['Escape',     'Cancel drawing / discard unsaved annotation'],
    ['Backspace',  'Undo last vertex while drawing'],
    // Edit
    ['Ctrl+Z',     'Undo last annotation'],
    ['Ctrl+Shift+Z','Redo'],
    ['Delete',     'Delete selected annotation (in edit mode)'],
    // Table
    ['Arrow keys', 'Navigate table cells'],
    ['Enter',      'Move down in table / confirm edit'],
    ['Tab',        'Move right in table'],
    ['Dbl-click',  'Edit a table cell inline'],
    ['Ctrl+C / V', 'Copy / paste table cells'],
    ['Ctrl+D',     'Duplicate cell value down'],
    // General
    ['?',          'Show this shortcuts panel'],
  ];

  const overlayId = 'catShortcutsOverlay';

  // Group shortcuts by section for cleaner display
  const SECTIONS = [
    { label: 'Drawing', keys: SHORTCUTS.slice(0, 6) },
    { label: 'Edit',    keys: SHORTCUTS.slice(6, 9) },
    { label: 'Table',   keys: SHORTCUTS.slice(9, 14) },
    { label: 'General', keys: SHORTCUTS.slice(14) },
  ];

  function buildOverlay() {
    const div = document.createElement('div');
    div.id = overlayId;
    div.style.cssText = 'display:none;position:fixed;inset:0;z-index:13000;background:rgba(0,0,0,0.55);align-items:center;justify-content:center;';
    const rows = SECTIONS.map(s =>
      `<tr><td colspan="2" style="padding:10px 0 4px;font-size:10px;font-weight:700;color:#667eea;text-transform:uppercase;letter-spacing:0.5px;">${s.label}</td></tr>` +
      s.keys.map(([key, desc]) => `
        <tr>
          <td style="padding:4px 12px 4px 0;white-space:nowrap;">
            <kbd style="background:#f3f4f6;padding:2px 7px;border-radius:4px;border:1px solid #d1d5db;font-size:12px;font-family:monospace;">${key}</kbd>
          </td>
          <td style="padding:4px 0;font-size:13px;color:#555;">${desc}</td>
        </tr>`).join('')
    ).join('');
    div.innerHTML = `
      <div style="background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);max-width:420px;width:92%;padding:0;overflow:hidden;">
        <div style="padding:16px 22px 10px;border-bottom:2px solid #667eea;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-size:16px;color:#333;">Keyboard Shortcuts</h3>
          <button id="catShortcutsClose" style="background:none;border:none;font-size:20px;cursor:pointer;color:#666;">&times;</button>
        </div>
        <div style="padding:14px 22px 18px;max-height:70vh;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;">
            ${rows}
          </table>
        </div>
      </div>`;
    document.body.appendChild(div);
    document.getElementById('catShortcutsClose').onclick = () => { div.style.display = 'none'; };
    div.onclick = (e) => { if (e.target === div) div.style.display = 'none'; };
    return div;
  }

  function toggleShortcuts() {
    let overlay = document.getElementById(overlayId) || buildOverlay();
    overlay.style.display = overlay.style.display === 'flex' ? 'none' : 'flex';
  }

  // Expose globally so navbar dropdown can call it
  window.catShowShortcuts = toggleShortcuts;

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (e.key !== '?') return;
    e.preventDefault();
    toggleShortcuts();
  });
})();


// ─── Map View Persistence (sessionStorage) ──────────────────────────────────
// Saves zoom + center after each moveend; restores on map init if available.

(function () {
  const KEY = 'cat_mapView';

  window.catMapSaveView = function (map) {
    if (!map) return;
    map.on('moveend', () => {
      const c = map.getCenter();
      sessionStorage.setItem(KEY, JSON.stringify({
        lat: c.lat, lng: c.lng, zoom: map.getZoom()
      }));
    });
  };

  window.catMapRestoreView = function (map) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY));
      if (saved && saved.lat !== undefined) {
        map.setView([saved.lat, saved.lng], saved.zoom);
        return true;
      }
    } catch (_) {}
    return false;
  };
})();


// ─── Field-Level Validation ─────────────────────────────────────────────────
// Highlights required fields that are empty and returns true if all valid.

window.catValidateRequired = function (fieldIds) {
  let allValid = true;
  fieldIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const val = el.value ? el.value.trim() : '';
    if (!val) {
      el.style.border = '2px solid #dc2626';
      el.style.boxShadow = '0 0 0 2px rgba(220,38,38,0.15)';
      allValid = false;
      // Clear on next input
      const clearErr = () => { el.style.border = ''; el.style.boxShadow = ''; el.removeEventListener('input', clearErr); };
      el.addEventListener('input', clearErr);
    }
  });
  return allValid;
};


// ─── Overlay State Persistence (localStorage) ───────────────────────────────

(function () {
  const KEY = 'cat_overlayState';

  window.catSaveOverlayState = function (layerId, opacity, visible) {
    try {
      const state = JSON.parse(localStorage.getItem(KEY) || '{}');
      state[layerId] = { opacity, visible };
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (_) {}
  };

  window.catGetOverlayState = function (layerId) {
    try {
      const state = JSON.parse(localStorage.getItem(KEY) || '{}');
      return state[layerId] || null;
    } catch (_) { return null; }
  };
})();


// ─── Table Sort Persistence (localStorage) ──────────────────────────────────

(function () {
  const KEY = 'cat_tableSort';

  window.catSaveTableSort = function (column, direction) {
    try { localStorage.setItem(KEY, JSON.stringify({ column, direction })); } catch (_) {}
  };

  window.catGetTableSort = function () {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (_) { return null; }
  };
})();


// ─── Minimap ────────────────────────────────────────────────────────────────
// Lightweight overview minimap showing current viewport on a zoomed-out view.
// Call catInitMinimap(mainMap) after the main map is ready.

(function () {
  let miniMap = null;
  let viewRect = null;

  window.catInitMinimap = function (mainMap) {
    if (!mainMap || !L) return;

    // Create container
    const container = document.createElement('div');
    container.id = 'catMinimap';
    container.style.cssText = `
      position:absolute; bottom:28px; left:8px; z-index:800;
      width:150px; height:120px; border:2px solid rgba(102,126,234,0.6);
      border-radius:6px; overflow:hidden; background:#e5e7eb;
      box-shadow:0 2px 8px rgba(0,0,0,0.2); opacity:0.9;
      transition: opacity 0.2s;
    `;
    container.onmouseenter = () => { container.style.opacity = '1'; };
    container.onmouseleave = () => { container.style.opacity = '0.7'; };
    container.style.opacity = '0.7';
    document.getElementById('map').appendChild(container);

    // Create mini Leaflet map (no controls)
    miniMap = L.map(container, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      touchZoom: false
    }).setView(mainMap.getCenter(), Math.max(mainMap.getZoom() - 5, 0));

    // Add a simple tile layer (OpenStreetMap as fallback background)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
      maxZoom: 20
    }).addTo(miniMap);

    // Viewport rectangle
    viewRect = L.rectangle(mainMap.getBounds(), {
      color: '#667eea', weight: 2, fillOpacity: 0.15, interactive: false
    }).addTo(miniMap);

    // Sync minimap when main map moves
    function syncMinimap() {
      const bounds = mainMap.getBounds();
      viewRect.setBounds(bounds);
      // Keep minimap centered on main view, zoomed out
      const targetZoom = Math.max(mainMap.getZoom() - 5, 0);
      miniMap.setView(mainMap.getCenter(), targetZoom, { animate: false });
    }

    mainMap.on('moveend zoomend', syncMinimap);

    // Click on minimap to pan main map
    miniMap.on('click', function (e) {
      mainMap.panTo(e.latlng);
    });
  };
})();
