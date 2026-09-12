  (function () {
    'use strict';
    const MD_KEY = 'cat_map_display_settings';
    const MD_DEFAULTS = { zoomDelta: 1, wheelPx: 60 };

    function _loadMD() {
      try { return Object.assign({}, MD_DEFAULTS, JSON.parse(localStorage.getItem(MD_KEY) || '{}')); }
      catch (_) { return Object.assign({}, MD_DEFAULTS); }
    }

    function _applySettings(s) {
      // `map` is null until the map is built, and in a popout window it is a
      // deliberate no-op stub — neither has anything to configure.
      if (typeof map === 'undefined' || !map || !map.options) return;
      map.options.zoomDelta = s.zoomDelta;
      map.options.zoomSnap  = s.zoomDelta;
      if (map.scrollWheelZoom && map.scrollWheelZoom._wheelSpeedFactor !== undefined) {
        map.scrollWheelZoom._wheelPxPerZoomLevel = s.wheelPx;
      }
      // Works regardless of internal handler structure
      if (map.options) map.options.wheelPxPerZoomLevel = s.wheelPx;
    }

    function _renderButtons(delta) {
      document.querySelectorAll('[name="zoomDelta"]').forEach(radio => {
        const btn = radio.nextElementSibling;
        const active = parseFloat(radio.value) === delta;
        btn.style.borderColor = active ? '#2563eb' : '#e5e7eb';
        btn.style.background  = active ? '#eff6ff' : '';
        btn.style.color       = active ? '#1d4ed8' : '';
        radio.checked = active;
      });
    }

    function _syncWheelSlider(px) {
      const slider = document.getElementById('wheelPxSlider');
      const label  = document.getElementById('wheelPxLabel');
      if (slider) slider.value = px;
      if (label)  label.textContent = px + ' px';
    }

    window.openMapDisplaySettings = function () {
      const s = _loadMD();
      _renderButtons(s.zoomDelta);
      _syncWheelSlider(s.wheelPx);
      document.querySelectorAll('[name="zoomDelta"]').forEach(radio => {
        radio.onchange = () => _renderButtons(parseFloat(radio.value));
      });
      const slider = document.getElementById('wheelPxSlider');
      if (slider) slider.oninput = () => _syncWheelSlider(parseInt(slider.value));
      document.getElementById('mapDisplaySettingsModal').style.display = 'flex';
    };

    window.closeMapDisplaySettings = function () {
      document.getElementById('mapDisplaySettingsModal').style.display = 'none';
    };

    window.saveMapDisplaySettings = function () {
      const checked = document.querySelector('[name="zoomDelta"]:checked');
      const delta   = checked ? parseFloat(checked.value) : MD_DEFAULTS.zoomDelta;
      const slider  = document.getElementById('wheelPxSlider');
      const wheelPx = slider ? parseInt(slider.value) : MD_DEFAULTS.wheelPx;
      const s = { zoomDelta: delta, wheelPx };
      localStorage.setItem(MD_KEY, JSON.stringify(s));
      _applySettings(s);
      closeMapDisplaySettings();
      if (typeof showStatus === 'function') showStatus('Map display settings saved', 'success');
    };

    // Apply saved settings as soon as map is ready
    function _initOnLoad() {
      const s = _loadMD();
      let tries = 0;
      const poll = setInterval(() => {
        if (typeof map !== 'undefined' || ++tries > 20) {
          clearInterval(poll);
          _applySettings(s);
        }
      }, 200);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initOnLoad);
    } else {
      _initOnLoad();
    }
  })();
