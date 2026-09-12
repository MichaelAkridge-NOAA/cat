// Extracted from annotation-file-mode-runtime.js (Phase 2h: panel/label ui)

    // ── Annotation completeness & style helpers (used by labels, refresh, bulk, etc.) ──
    function isAnnotationComplete(ann) {
      if (!ann) return false;
      // Check flat format (file mode / normalized)
      const sp = ann.spcode || ann.species_code || ann.SPCODE || ann.SPECIES_CODE ||
                 // Check nested properties (DB/GeoJSON mode)
                 (ann.properties && (ann.properties.spcode || ann.properties.SPCODE ||
                  ann.properties.species_code || ann.properties.SPECIES_CODE));
      return sp && sp !== '-' && String(sp).trim() !== '';
    }
    window.isAnnotationComplete = isAnnotationComplete;

    // ── Annotation display settings (the Annotations layer's sliders) ──
    // These used to live only in the DOM, applied once per drag to whatever
    // layers happened to exist at that moment. Every later redraw — and in DB
    // mode refreshAnnotations() runs after *every* save — rebuilt the layers
    // straight from getAnnotationLayerStyle()'s hardcoded weight 7 / opacity
    // 0.8, so a line width the analyst had dialled down snapped back the next
    // time they saved. Holding the values here and applying them as the last
    // step of getAnnotationLayerStyle() makes them stick, because every code
    // path that (re)styles an annotation already goes through that function.
    const ANNOTATION_DISPLAY_DEFAULTS = { opacityPct: 80, lineWidth: 7 };
    const ANNOTATION_DISPLAY_KEY = 'cat_annotation_display';
    let annotationDisplay = Object.assign({}, ANNOTATION_DISPLAY_DEFAULTS);
    window.catAnnotationDisplay = annotationDisplay;

    function saveAnnotationDisplay() {
      try {
        localStorage.setItem(ANNOTATION_DISPLAY_KEY, JSON.stringify(annotationDisplay));
      } catch (e) { /* private mode / quota — the session still works */ }
    }

    // Restore before any annotation is drawn, so the very first render already
    // uses the analyst's chosen width rather than flashing the default and
    // needing a slider nudge to correct itself.
    function restoreAnnotationDisplay() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(ANNOTATION_DISPLAY_KEY) || 'null'); }
      catch (e) { saved = null; }
      if (saved && typeof saved === 'object') {
        const o = parseInt(saved.opacityPct, 10);
        const w = parseInt(saved.lineWidth, 10);
        if (!isNaN(o) && o >= 0 && o <= 100) annotationDisplay.opacityPct = o;
        if (!isNaN(w) && w >= 1 && w <= 10) annotationDisplay.lineWidth = w;
      }
      const oSlider = document.getElementById('annotationsOpacity');
      const oLabel = document.getElementById('annotationsOpacityValue');
      const wSlider = document.getElementById('lineWidth');
      const wLabel = document.getElementById('lineWidthValue');
      if (oSlider) oSlider.value = annotationDisplay.opacityPct;
      if (oLabel) oLabel.textContent = annotationDisplay.opacityPct;
      if (wSlider) wSlider.value = annotationDisplay.lineWidth;
      if (wLabel) wLabel.textContent = annotationDisplay.lineWidth;
    }

    function getAnnotationLayerStyle(ann) {
      // Flat format (file mode / normalized) or nested properties (DB/GeoJSON mode) —
      // same pattern as isAnnotationComplete() above.
      const detectionMethod = ann && (ann.detection_method ||
        (ann.properties && ann.properties.detection_method));
      const base = (detectionMethod && String(detectionMethod).indexOf('sam3-') === 0)
        ? { color: '#06b6d4', weight: 7, opacity: 0.85, fillOpacity: 0.25, dashArray: '2 6' }
        : isAnnotationComplete(ann)
          // dashArray: null, not omitted. setStyle() merges into the layer's
          // existing options, so an annotation that was dashed as incomplete
          // (or as SAM3) and has since been given a species kept its dashes
          // forever — the "complete" style simply never mentioned dashArray,
          // so there was nothing to clear it. Leaflet removes the attribute
          // for a falsy dashArray, which is exactly what's wanted here.
          ? { color: '#3388ff', weight: 7, opacity: 0.8, fillOpacity: 0.3, dashArray: null }
          : { color: '#e67e22', weight: 7, opacity: 0.9, fillOpacity: 0.25, dashArray: '6 4' };

      // Attribute-driven symbology (annotation-runtime-symbology.js): when a
      // color-by mode is active, override just the color/fillColor so the
      // dash-pattern cues above (SAM3, incomplete) still read correctly.
      let style = base;
      if (typeof window.catSymbologyColorFor === 'function') {
        const symColor = window.catSymbologyColorFor(ann);
        if (symColor) style = Object.assign({}, base, { color: symColor, fillColor: symColor });
      }

      return applyAnnotationDisplay(style);
    }
    window.getAnnotationLayerStyle = getAnnotationLayerStyle;

    // Scale a computed style by the current display sliders. Fill is kept at
    // the 0.3 ratio of stroke opacity the sliders have always used, but scaled
    // by the base style's own fill ratio so the fainter SAM3/incomplete fills
    // stay distinguishable instead of all flattening to one value.
    function applyAnnotationDisplay(style) {
      const opacity = annotationDisplay.opacityPct / 100;
      const baseOpacity = (style.opacity != null) ? style.opacity : 0.8;
      const fillRatio = (style.fillOpacity != null && baseOpacity > 0)
        ? style.fillOpacity / baseOpacity
        : 0.3;
      return Object.assign({}, style, {
        weight: annotationDisplay.lineWidth,
        opacity: opacity,
        fillOpacity: opacity * fillRatio
      });
    }

    function toggleAnnotationsLayer() {
      const checked = document.getElementById('toggleAnnotations').checked;
      if (checked) {
        map.addLayer(drawnItems);
        // Re-show labels if they were enabled
        if (labelsVisible) {
          showAllAnnotationLabels();
        }
      } else {
        map.removeLayer(drawnItems);
        // Hide labels when annotations are hidden
        hideAllAnnotationLabels();
      }
    }
    
    // Re-apply the display settings to every annotation currently on the map.
    // Restyling through getAnnotationLayerStyle() (rather than pushing a bare
    // {opacity} / {weight} patch) means a slider drag also picks up whatever
    // the layer's colour and dash pattern should currently be — symbology
    // mode, SAM3 origin, missing-species state — instead of leaving those to
    // drift until the next full redraw.
    function restyleAllAnnotations() {
      if (!drawnItems || typeof drawnItems.eachLayer !== 'function') return;
      drawnItems.eachLayer(function(layer) {
        if (!layer.setStyle) return;
        if (layer.annotationData) {
          layer.setStyle(getAnnotationLayerStyle(layer.annotationData));
        } else {
          // A shape that is still being drawn has no annotation behind it yet.
          // Keep the drawing tool's own colour (pink polyline / blue polygon /
          // amber rectangle — deliberate per-tool cues) and only follow the
          // sliders, which is what these handlers always did.
          layer.setStyle(applyAnnotationDisplay({
            opacity: layer.options && layer.options.opacity,
            fillOpacity: layer.options && layer.options.fillOpacity
          }));
        }
      });
    }
    window.catRestyleAllAnnotations = restyleAllAnnotations;

    function setAnnotationsOpacity(value) {
      const el = document.getElementById('annotationsOpacityValue');
      if (el) el.textContent = value;
      const pct = parseInt(value, 10);
      annotationDisplay.opacityPct = isNaN(pct) ? ANNOTATION_DISPLAY_DEFAULTS.opacityPct : pct;
      restyleAllAnnotations();
      saveAnnotationDisplay();
    }

    function setLineWidth(value) {
      const el = document.getElementById('lineWidthValue');
      if (el) el.textContent = value;
      const width = parseInt(value, 10);
      annotationDisplay.lineWidth = isNaN(width) ? ANNOTATION_DISPLAY_DEFAULTS.lineWidth : width;
      restyleAllAnnotations();
      saveAnnotationDisplay();
    }
    
    // Species label management
    let annotationLabels = new Map(); // Store label markers by annotation ID
    let labelsVisible = true; // Default to true to match checkbox initial state
    
    function toggleAnnotationLabels(enabled) {
      labelsVisible = enabled;
      
      if (enabled) {
        showAllAnnotationLabels();
      } else {
        hideAllAnnotationLabels();
      }
    }
    
    function showAllAnnotationLabels() {
      drawnItems.eachLayer(function(layer) {
        // File mode: check for annotationData, Database mode: check for feature.id
        if (layer.annotationData || (layer.feature && layer.feature.id)) {
          addLabelToAnnotation(layer);
        }
      });
    }
    
    function hideAllAnnotationLabels() {
      annotationLabels.forEach((labelMarker, annotationId) => {
        if (map.hasLayer(labelMarker)) {
          map.removeLayer(labelMarker);
        }
      });
      annotationLabels.clear();
    }
    
    function addLabelToAnnotation(layer) {
      // Support both file mode (annotationData) and database mode (feature)
      let annotationId, spcode, colonyId;
      
      if (layer.annotationData) {
        // File mode - use the layer's unique ID
        annotationId = layer._leaflet_id;
        
        // Try multiple field name variations for species code
        spcode = layer.annotationData.spcode || 
                 layer.annotationData.species_code || 
                 layer.annotationData.species || 
                 layer.annotationData.SPCODE ||
                 layer.annotationData.SPECIES_CODE ||
                 '';
                 
        // Try multiple field name variations for colony ID, use display index as fallback
        // NOTE: no_colony is a boolean field (-1/0), NOT an ID — do not include it here
        colonyId = layer.annotationData.colony_id || 
                   layer.annotationData.COLONY_ID ||
                   layer.annotationData.id ||
                   layer.annotationData.ID ||
                   layer.annotationData._displayIndex ||
                   (annotations ? annotations.indexOf(layer.annotationData) + 1 || annotationId : annotationId);

        // Build a useful display label (e.g. "SSID #3" or "Line #3" if no species yet)
        if (!spcode) {
          const t = layer.annotationData.type;
          spcode = (t === 'line' || t === 'polyline') ? 'Line' : 'Ann';
        }
      } else if (layer.feature && layer.feature.id) {
        // Database mode — check both uppercase (Oracle) and lowercase (app-created) property names
        annotationId = layer.feature.id;
        const props = layer.feature.properties || {};
        spcode = props.SPCODE || props.spcode || props.species_code || props.SPECIES_CODE || '';
        colonyId = props.colony_id || props.COLONY_ID || props.annotation_id || annotationId;

        // Show useful placeholder instead of 'Unknown' when no species is set
        if (!spcode) {
          const geomType = layer.feature.geometry?.type;
          spcode = (geomType === 'LineString') ? 'Line' : 'Ann';
        }
      } else {
        return; // No annotation data
      }
      
      // Remove existing label if any
      if (annotationLabels.has(annotationId)) {
        const oldLabel = annotationLabels.get(annotationId);
        if (map.hasLayer(oldLabel)) {
          map.removeLayer(oldLabel);
        }
      }
      
      // Get the center point of the annotation
      let center;
      if (layer.getCenter) {
        center = layer.getCenter();
      } else if (layer.getLatLng) {
        center = layer.getLatLng();
      } else if (layer.getBounds) {
        center = layer.getBounds().getCenter();
      } else {
        return; // Can't determine center
      }
      
      // Color label background by species
      const _labelColor = (typeof catSpeciesColor === 'function') ? catSpeciesColor(spcode) : '#667eea';

      // Create a custom div icon for the label with species and ID
      const labelIcon = L.divIcon({
        className: 'annotation-label',
        html: `<div style="
          background: ${_labelColor};
          color: #fff;
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 11px;
          font-weight: bold;
          white-space: nowrap;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
          cursor: pointer;
          text-shadow: 0 1px 2px rgba(0,0,0,0.4);
        ">${spcode} #${colonyId}</div>`,
        iconSize: null,
        iconAnchor: [0, 0]
      });

      // Create marker for label — interactive so clicking the text tag
      // itself opens the same popup as clicking the annotation's shape
      // (useful for thin lines/small shapes where the label is a much
      // easier target).
      const labelMarker = L.marker(center, {
        icon: labelIcon,
        interactive: true,
        pane: 'annotationsPane'
      });
      labelMarker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (typeof showAnnotationPopup === 'function') showAnnotationPopup(layer, center);
      });

      labelMarker.addTo(map);
      annotationLabels.set(annotationId, labelMarker);
    }

    // ── Multi-user: per-contributor visibility toggle ──────────────────────
    // Every annotation layer carries _creatorUserId/_creatorLabel (set once
    // in loadProjectAnnotations(), annotation-runtime-project-layers.js).
    // Hiding is done at the raw DOM level (display:none on the rendered
    // path/marker element) rather than via layer.setStyle()/setOpacity(),
    // so it can't be silently undone by the unrelated opacity/line-width
    // sliders (setAnnotationsOpacity/setLineWidth above, which unconditionally
    // restyle every layer) and doesn't touch drawnItems membership — Leaflet.
    // Draw's own edit/delete toolbar keeps working on hidden layers exactly
    // as before.
    let _hiddenContributorIds = new Set(); // keys: String(user_id), or 'unknown'

    function _contributorKeyFor(layer) {
      return layer._creatorUserId != null ? String(layer._creatorUserId) : 'unknown';
    }

    // Mirrors addLabelToAnnotation()'s key resolution above: every layer we
    // render (loadProjectAnnotations / refreshAnnotations) sets .annotationData,
    // so its "file mode" branch (keyed by _leaflet_id) is the one that's
    // actually always taken — the layer.feature.id branch is effectively
    // unreachable since .annotationData is checked first.
    function _labelKeyFor(layer) {
      return layer._leaflet_id;
    }

    function _escapeForContributorLabel(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function buildContributorVisibilityPanel() {
      const section = document.getElementById('annotationContributorsSection');
      const container = document.getElementById('annotationContributorsContainer');
      if (!section || !container || !drawnItems) return;

      const contributors = new Map(); // key -> { label, count }
      drawnItems.eachLayer(function (layer) {
        const key = _contributorKeyFor(layer);
        const entry = contributors.get(key) || { label: layer._creatorLabel || 'Unknown', count: 0 };
        entry.count += 1;
        contributors.set(key, entry);
      });

      // A single-author project has nothing worth toggling — keep the panel
      // out of the way. Clear any stale hide-state left over from a
      // differently-authored project viewed earlier in this tab, and
      // un-hide whatever it was hiding so annotations don't render
      // invisible with no UI left to un-hide them.
      if (contributors.size <= 1) {
        if (_hiddenContributorIds.size > 0) {
          _hiddenContributorIds.forEach(function (key) { _applyContributorVisibility(key, true); });
          _hiddenContributorIds.clear();
        }
        section.style.display = 'none';
        container.innerHTML = '';
        return;
      }

      section.style.display = 'block';
      const sorted = Array.from(contributors.entries()).sort((a, b) => a[1].label.localeCompare(b[1].label));
      const quickLinks =
        '<div style="font-size:10px; margin-bottom:4px;">' +
        '<a href="#" onclick="setAllContributorsVisible(true); return false;" style="color:#3388ff;">All</a> · ' +
        '<a href="#" onclick="setAllContributorsVisible(false); return false;" style="color:#3388ff;">None</a>' +
        '</div>';
      const rows = sorted.map(function ([key, entry]) {
        const checked = !_hiddenContributorIds.has(key);
        const safeId = 'contributorToggle_' + key.replace(/[^a-zA-Z0-9_-]/g, '_');
        return (
          '<label for="' + safeId + '" class="inline-checkbox-label" ' +
          'style="display:flex; align-items:center; gap:4px; font-size:12px; margin-top:2px;">' +
          '<input type="checkbox" id="' + safeId + '" class="inline-checkbox" ' + (checked ? 'checked' : '') +
          ' onchange="toggleContributorVisibility(\'' + key + '\', this.checked)">' +
          '<span>' + _escapeForContributorLabel(entry.label) + ' (' + entry.count + ')</span>' +
          '</label>'
        );
      }).join('');
      container.innerHTML = quickLinks + rows;

      // Re-apply any hide state that predates this rebuild (e.g. a remote
      // change-polling refresh reloaded annotations while a contributor was
      // toggled off).
      _hiddenContributorIds.forEach(function (key) { _applyContributorVisibility(key, false); });
    }
    window.buildContributorVisibilityPanel = buildContributorVisibilityPanel;

    function toggleContributorVisibility(key, visible) {
      if (visible) {
        _hiddenContributorIds.delete(key);
      } else {
        _hiddenContributorIds.add(key);
      }
      _applyContributorVisibility(key, visible);
    }
    window.toggleContributorVisibility = toggleContributorVisibility;

    function setAllContributorsVisible(visible) {
      const keys = new Set();
      drawnItems.eachLayer(function (layer) { keys.add(_contributorKeyFor(layer)); });
      keys.forEach(function (key) {
        if (visible) _hiddenContributorIds.delete(key); else _hiddenContributorIds.add(key);
      });
      keys.forEach(function (key) { _applyContributorVisibility(key, visible); });
      buildContributorVisibilityPanel();
    }
    window.setAllContributorsVisible = setAllContributorsVisible;

    function _applyContributorVisibility(key, visible) {
      drawnItems.eachLayer(function (layer) {
        if (_contributorKeyFor(layer) !== key) return;
        const el = layer._path || layer._icon;
        if (el) el.style.display = visible ? '' : 'none';
        const label = annotationLabels.get(_labelKeyFor(layer));
        if (label && label._icon) label._icon.style.display = visible ? '' : 'none';
      });
    }

    function showAnnotationPopup(layer, latlng) {
      if (!layer.annotationData) return;
      
      const data = layer.annotationData;
      
      // Find the annotation index in the annotations array
      let annotationIndex = -1;
      for (let i = 0; i < annotations.length; i++) {
        if (annotations[i] === data) {
          annotationIndex = i;
          break;
        }
      }
      
      // Build popup content with all available fields
      let popupContent = '<div style="min-width: 250px;">';
      popupContent += '<h4 style="margin: 0 0 8px 0; padding-bottom: 5px; border-bottom: 2px solid #3388ff;">Annotation Details</h4>';
      
      // Show key fields first
      const keyFields = ['spcode', 'species_code', 'SPCODE', 'SPECIES_CODE', 'species'];
      const idFields = ['colony_id', 'COLONY_ID', 'id', 'ID'];
      const sizeFields = ['size_cm', 'SIZE_CM', 'diameter', 'DIAMETER'];
      
      // Species
      const speciesValue = keyFields.map(f => data[f]).find(v => v);
      if (speciesValue) {
        popupContent += `<div style="margin: 4px 0;"><strong>Species:</strong> ${speciesValue}</div>`;
      }
      
      // ID - use display index as fallback for consistency
      const idValue = idFields.map(f => data[f]).find(v => v) || data._displayIndex || layer._leaflet_id;
      popupContent += `<div style="margin: 4px 0;"><strong>ID:</strong> ${idValue}</div>`;
      
      // Size
      const sizeValue = sizeFields.map(f => data[f]).find(v => v);
      if (sizeValue) {
        popupContent += `<div style="margin: 4px 0;"><strong>Size:</strong> ${sizeValue} cm</div>`;
      }
      
      // Add other fields (excluding geometry and already shown fields)
      const excludeFields = ['geometry', ...keyFields, ...idFields, ...sizeFields];
      const otherFields = Object.keys(data).filter(key => 
        !excludeFields.includes(key) && 
        data[key] !== null && 
        data[key] !== undefined &&
        data[key] !== ''
      );
      
      if (otherFields.length > 0) {
        popupContent += '<div style="margin-top: 8px; padding-top: 5px; border-top: 1px solid #ddd;">';
        otherFields.forEach(key => {
          const value = data[key];
          // Format the key (remove underscores, capitalize)
          const displayKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          popupContent += `<div style="margin: 2px 0; font-size: 0.9em;"><strong>${displayKey}:</strong> ${value}</div>`;
        });
        popupContent += '</div>';
      }
      
      // Add action buttons — use a data attribute and resolve index at click time
      // so the buttons stay correct even after annotations are deleted/reordered
      const layerId = layer._leaflet_id;
      const findIdx = `var lyr = drawnItems.getLayer(${layerId}); var ad = lyr && lyr.annotationData; var idx = annotations.findIndex(function(a){ return a === ad; });`;
      popupContent += `
        <div style="margin-top: 12px; padding-top: 8px; border-top: 2px solid #ddd; display: flex; gap: 6px; justify-content: center;">
          <button onclick="map.closePopup(); (function(){ ${findIdx} if(idx>=0) openEditModal(idx); })()"
                  style="padding: 6px 12px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;"
                  onmouseover="this.style.background='#1565c0'"
                  onmouseout="this.style.background='#1976d2'"
                  title="Edit Fields">
            ✏️ Edit
          </button>
          <button onclick="map.closePopup(); (function(){ ${findIdx} if(idx>=0) enableGeometryEdit(idx); })()"
                  style="padding: 6px 12px; background: #388e3c; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;"
                  onmouseover="this.style.background='#2e7d32'"
                  onmouseout="this.style.background='#388e3c'"
                  title="Edit Geometry">
            📐 Shape
          </button>
          <button onclick="catConfirm('Delete this annotation?',{danger:true,ok:'Delete'}).then(ok=>{if(ok){map.closePopup();(function(){${findIdx} if(idx>=0) deleteAnnotation(idx);})()}})"
                  style="padding: 6px 12px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;"
                  onmouseover="this.style.background='#c62828'"
                  onmouseout="this.style.background='#d32f2f'"
                  title="Delete">
            🗑️ Delete
          </button>
        </div>
      `;
      
      popupContent += '</div>';
      
      // Create and show popup
      L.popup({
        maxWidth: 300,
        closeButton: true
      })
        .setLatLng(latlng)
        .setContent(popupContent)
        .openOn(map);
    }
    
    function updateAnnotationLabel(annotationId) {
      if (!labelsVisible) return;
      
      // Find the layer for this annotation (support both file and database mode)
      drawnItems.eachLayer(function(layer) {
        let layerId;
        if (layer.annotationData) {
          // File mode
          layerId = layer.annotationData.created_at || Date.now();
        } else if (layer.feature && layer.feature.id) {
          // Database mode
          layerId = layer.feature.id;
        }
        
        if (layerId === annotationId) {
          addLabelToAnnotation(layer);
        }
      });
    }
    
    function removeAnnotationLabel(annotationId) {
      if (annotationLabels.has(annotationId)) {
        const labelMarker = annotationLabels.get(annotationId);
        if (map.hasLayer(labelMarker)) {
          map.removeLayer(labelMarker);
        }
        annotationLabels.delete(annotationId);
      }
    }
    
    // Toggle panel collapse/expand
    function togglePanel(panelId) {
      const panel = document.getElementById(panelId);
      if (!panel) return;

      // Collapse-to-title-bar is a floating-panel affordance. When the map
      // layers panel is docked as the left sidebar it is already a full-height
      // column with its own hide control, and the sidebar stylesheet forces the
      // body open regardless — so toggling here would only leave a stale
      // 'collapsed' class behind to surprise the user on the next switch back
      // to float mode. Route the click to the sidebar's own hide instead.
      if (panelId === 'mapLayersPanel' && document.body.classList.contains('layers-docked')) {
        if (typeof window.catLayersToggleSidebar === 'function') window.catLayersToggleSidebar();
        return;
      }

      const header = panel.querySelector('.panel-header');
      const content = panel.querySelector('.panel-content');

      header.classList.toggle('collapsed');
      content.classList.toggle('collapsed');
      panel.classList.toggle('collapsed');
    }
    
    // Toggle section collapse/expand (within a panel)
    function toggleSection(sectionId) {
      const section = document.getElementById(sectionId);
      section.classList.toggle('collapsed');
    }
    
    // Toggle individual layer details collapse/expand
    function toggleLayerDetails(detailsId) {
      const details = document.getElementById(detailsId);
      const icon = document.getElementById(detailsId + 'Icon');
      
      details.classList.toggle('collapsed');
      
      // Rotate icon
      if (details.classList.contains('collapsed')) {
        icon.textContent = '▶';
      } else {
        icon.textContent = '▼';
      }
    }
    
    // Toggle annotation section collapse/expand
    function toggleAnnotationSection(sectionId) {
      const content = document.getElementById(sectionId + 'Content');
      const icon = document.getElementById(sectionId + 'Icon');

      content.classList.toggle('collapsed');

      // Rotate icon
      if (content.classList.contains('collapsed')) {
        icon.textContent = '▶';
      } else {
        icon.textContent = '▼';
      }
    }

    // Task 10 de-stub fix: statsPanel (#statTotal/#statLines/#statBoxes/
    // #statPolygons + species breakdown, populated by updateStatistics() in
    // annotation-runtime-operations.js) was fully wired up and kept live on
    // every save/delete, but nothing ever showed it -- no navbar item, no
    // toggle, permanently display:none. Wired a Display-menu toggle rather
    // than deleting the panel, since the stats logic behind it is real and
    // already maintained.
    function toggleStatsPanel() {
      const panel = document.getElementById('statsPanel');
      if (!panel) return;
      const showing = panel.style.display !== 'none';
      if (showing) {
        panel.style.display = 'none';
      } else {
        if (typeof updateStatistics === 'function') updateStatistics();
        panel.style.display = 'block';
        if (typeof bringPanelToFront === 'function') bringPanelToFront('statsPanel');
      }
    }
    window.toggleStatsPanel = toggleStatsPanel;

    // ── Floating panel drag + z-order (Task 9) ──
    // uploadPanel / mapLayersPanel / statsPanel are small floating windows
    // (position:absolute, fixed width) — made freely draggable + bring-to-front here.
    // annotationFormPanel is intentionally excluded: its CSS is an anchored
    // full-width bottom bar (float mode) or full-height right sidebar (dock mode,
    // annotation-panels.css body.layout-docked rule), not a floating window, and
    // popout mode forces it to position:static — free dragging would fight all
    // three of those layouts. No call site raises it via bringPanelToFront()
    // either, so it is excluded from drag AND bring-to-front by design.
    let _panelTopZ = 1000;

    // A drag that ends with the pointer back over the drag handle (the common case,
    // since the handle tracks the cursor) would otherwise fire a native 'click' right
    // after mouseup and trigger the header's onclick (e.g. togglePanel's collapse
    // toggle) even though the user only meant to move the panel. Swallow exactly one
    // click on the handle that just finished a real drag, via a document-level
    // capturing listener (ancestor capture always runs before the target's own
    // onclick, regardless of listener registration order).
    let _suppressClickOn = null;
    document.addEventListener('click', function(e) {
      if (_suppressClickOn && (e.target === _suppressClickOn || _suppressClickOn.contains(e.target))) {
        e.stopPropagation();
        e.preventDefault();
        _suppressClickOn = null;
      }
    }, true);

    function bringPanelToFront(panelId) {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      _panelTopZ += 1;
      panel.style.zIndex = String(_panelTopZ);
    }
    window.bringPanelToFront = bringPanelToFront;

    function makePanelDraggable(panelId, handleSelector) {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      const handle = panel.querySelector(handleSelector || '.panel-header') || panel;

      let pointerDown = false;
      let dragging = false;
      let startX = 0, startY = 0, startLeft = 0, startTop = 0;
      const DRAG_THRESHOLD = 4; // px — below this, treat as a plain click (e.g. collapse toggle)

      handle.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        // Don't hijack interactive controls inside the header/handle.
        if (e.target.closest && e.target.closest('button, input, select, textarea, a')) return;
        // Popout/dock modes force position:static on these panels — dragging is meaningless there.
        if (getComputedStyle(panel).position === 'static') return;
        // A panel docked as a full-height sidebar (annotation-runtime-layers-sidebar.js
        // sets this flag) is position:fixed, so the static check above doesn't catch
        // it — dragging one would strand it mid-map with the map still reflowed
        // around the empty gutter it left behind.
        if (panel.dataset.catDocked === '1') return;

        pointerDown = true;
        dragging = false;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
      });

      document.addEventListener('mousemove', function(e) {
        if (!pointerDown) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!dragging) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
          // Movement exceeded threshold: commit to a drag. Switch the panel to
          // explicit left/top positioning (it may be anchored via right/bottom)
          // and bring it to front.
          dragging = true;
          panel.classList.add('panel-dragging');
          bringPanelToFront(panelId);
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
          document.body.style.userSelect = 'none';
        }

        let newLeft = startLeft + dx;
        let newTop = startTop + dy;
        // Clamp so the panel can't be dragged fully off-screen and become unreachable.
        const minVisible = 60;
        const maxLeft = window.innerWidth - minVisible;
        const maxTop = window.innerHeight - 40;
        newLeft = Math.max(-(panel.offsetWidth - minVisible), Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));
        panel.style.left = newLeft + 'px';
        panel.style.top = newTop + 'px';
      });

      document.addEventListener('mouseup', function() {
        if (!pointerDown) return;
        pointerDown = false;
        if (dragging) {
          dragging = false;
          panel.classList.remove('panel-dragging');
          document.body.style.userSelect = '';
          _suppressClickOn = handle;
          // Safety net: if no click follows (e.g. mouseup happened over a
          // different element), don't leave the next unrelated click suppressed.
          setTimeout(function() {
            if (_suppressClickOn === handle) _suppressClickOn = null;
          }, 0);
        }
      });

      // Raise on any interaction within the panel body too, not just the drag handle.
      panel.addEventListener('mousedown', function() {
        bringPanelToFront(panelId);
      }, true);
    }
    window.makePanelDraggable = makePanelDraggable;

    document.addEventListener('DOMContentLoaded', function() {
      restoreAnnotationDisplay();
      makePanelDraggable('uploadPanel');
      makePanelDraggable('mapLayersPanel');
      makePanelDraggable('statsPanel', 'h4');
    });

    // Smart Grid Mode: Advanced multi-coral segmentation with all enhancements
