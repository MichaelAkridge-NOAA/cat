// Extracted from annotation-file-mode-runtime.js (Phase 2h: panel/label ui)
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
    
    function setAnnotationsOpacity(value) {
      document.getElementById('annotationsOpacityValue').textContent = value;
      const opacity = value / 100;
      drawnItems.eachLayer(function(layer) {
        if (layer.setStyle) {
          const currentStyle = layer.options;
          layer.setStyle({
            opacity: opacity,
            fillOpacity: opacity * 0.3
          });
        }
      });
    }
    
    function setLineWidth(value) {
      document.getElementById('lineWidthValue').textContent = value;
      const width = parseInt(value);
      drawnItems.eachLayer(function(layer) {
        if (layer.setStyle) {
          layer.setStyle({
            weight: width
          });
        }
      });
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
        // Database mode
        annotationId = layer.feature.id;
        spcode = layer.feature.properties.SPCODE || 'Unknown';
        colonyId = layer.feature.properties.colony_id || annotationId;
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
          pointer-events: none;
          text-shadow: 0 1px 2px rgba(0,0,0,0.4);
        ">${spcode} #${colonyId}</div>`,
        iconSize: null,
        iconAnchor: [0, 0]
      });
      
      // Create marker for label
      const labelMarker = L.marker(center, {
        icon: labelIcon,
        interactive: false,
        pane: 'annotationsPane'
      });
      
      labelMarker.addTo(map);
      annotationLabels.set(annotationId, labelMarker);
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
    
    // Smart Grid Mode: Advanced multi-coral segmentation with all enhancements
