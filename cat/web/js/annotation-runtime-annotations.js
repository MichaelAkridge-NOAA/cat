// Extracted from annotation-file-mode-runtime.js (Phase 2d: annotation editing/table)
    function updateAnnotationTable() {
      const tbody = document.getElementById('annotationTableBody');
      const countSpan = document.getElementById('annotationCount');
      
      if (!tbody) return;
      
      // Update count
      if (countSpan) {
        countSpan.textContent = annotations.length;
      }
      if (typeof window.updateNavAnnotationCount === 'function') window.updateNavAnnotationCount(annotations.length);

      // Update stats bar
      const statsDiv = document.getElementById('annotationStats');
      if (statsDiv && annotations.length > 0) {
        const species = new Set(annotations.map(a => a.spcode || a.species_code || a.SPCODE).filter(Boolean));
        const withSpecies = annotations.filter(a => a.spcode || a.species_code || a.SPCODE).length;
        const pct = Math.round((withSpecies / annotations.length) * 100);
        statsDiv.style.display = 'block';
        statsDiv.innerHTML =
          `<strong>${annotations.length}</strong> annotations · ` +
          `<strong>${species.size}</strong> species · ` +
          `<span style="color:${pct === 100 ? '#059669' : '#d97706'}">${pct}% with species</span>` +
          (pct < 100 ? ` · <span style="color:#d97706">${annotations.length - withSpecies} missing</span>` : '');
      } else if (statsDiv) {
        statsDiv.style.display = 'none';
      }

      // Clear table
      tbody.innerHTML = '';
      
      if (annotations.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="35" style="text-align: center; padding: 20px; color: #6c757d;">
              No annotations yet - draw on the map to create one
            </td>
          </tr>
        `;
        return;
      }

      // Helper to format yes/no/-1/0 fields
      const fmtBool = (v) => v == -1 ? 'Yes' : (v == 0 ? 'No' : '-');
      const fmtPct = (v) => (v !== undefined && v !== null && v !== '') ? v + '%' : '-';
      const fmtVal = (v) => (v !== undefined && v !== null && v !== '') ? v : '-';

      // Populate table with annotations
      annotations.forEach((ann, index) => {
        const row = document.createElement('tr');
        row.dataset.index = index;

        // Get the colony ID (try multiple field name variations, fallback to row number)
        const colonyId = ann.colony_id || ann.COLONY_ID || ann.id || ann.ID || (index + 1);

        row.innerHTML = `
          <td><strong>${colonyId}</strong></td>
          <td>${(ann.geometry && ann.geometry.type) || ann.type || 'Polygon'}</td>
          <td class="editable" data-field="site" data-index="${index}">${fmtVal(ann.site)}</td>
          <td class="editable" data-field="spcode" data-index="${index}">${fmtVal(ann.spcode || ann.species_code || ann.SPCODE || ann.SPECIES_CODE)}</td>
          <td class="editable" data-field="juvenile" data-index="${index}">${fmtBool(ann.juvenile)}</td>
          <td class="editable" data-field="juv_substrate" data-index="${index}">${fmtVal(ann.juv_substrate)}</td>
          <td class="editable" data-field="analyst" data-index="${index}">${fmtVal(ann.analyst)}</td>
          <td class="editable" data-field="obs_year" data-index="${index}">${fmtVal(ann.obs_year)}</td>
          <td class="editable" data-field="mission_id" data-index="${index}">${fmtVal(ann.mission_id)}</td>
          <td class="editable" data-field="segment" data-index="${index}">${fmtVal(ann.segment)}</td>
          <td class="editable" data-field="transect" data-index="${index}">${fmtVal(ann.transect)}</td>
          <td class="editable" data-field="morph_code" data-index="${index}">${fmtVal(ann.morph_code)}</td>
          <td class="editable" data-field="old_dead" data-index="${index}">${fmtPct(ann.old_dead)}</td>
          <td class="editable" data-field="remnant" data-index="${index}">${fmtBool(ann.remnant)}</td>
          <td class="editable" data-field="fragment" data-index="${index}">${fmtBool(ann.fragment)}</td>
          <td class="editable" data-field="ex_bound" data-index="${index}">${fmtBool(ann.ex_bound)}</td>
          <td class="editable" data-field="no_colony" data-index="${index}">${fmtBool(ann.no_colony)}</td>
          <td class="editable" data-field="seglength" data-index="${index}">${fmtVal(ann.seglength)}</td>
          <td class="editable" data-field="segwidth" data-index="${index}">${fmtVal(ann.segwidth)}</td>
          <td data-field="line_length_m" data-index="${index}" style="color:#555;font-style:italic;">${ann.line_length_m != null ? ann.line_length_m + ' m' : ''}</td>
          <td class="editable" data-field="rdcause1" data-index="${index}">${fmtVal(ann.rdcause1)}</td>
          <td class="editable" data-field="rd_1" data-index="${index}">${fmtPct(ann.rd_1)}</td>
          <td class="editable" data-field="rdcause2" data-index="${index}">${fmtVal(ann.rdcause2)}</td>
          <td class="editable" data-field="rd_2" data-index="${index}">${fmtPct(ann.rd_2)}</td>
          <td class="editable" data-field="rdcause3" data-index="${index}">${fmtVal(ann.rdcause3)}</td>
          <td class="editable" data-field="rd_3" data-index="${index}">${fmtPct(ann.rd_3)}</td>
          <td class="editable" data-field="con_1" data-index="${index}">${fmtVal(ann.con_1)}</td>
          <td class="editable" data-field="extent_1" data-index="${index}">${fmtPct(ann.extent_1)}</td>
          <td class="editable" data-field="sev_1" data-index="${index}">${fmtVal(ann.sev_1)}</td>
          <td class="editable" data-field="con_2" data-index="${index}">${fmtVal(ann.con_2)}</td>
          <td class="editable" data-field="extent_2" data-index="${index}">${fmtPct(ann.extent_2)}</td>
          <td class="editable" data-field="sev_2" data-index="${index}">${fmtVal(ann.sev_2)}</td>
          <td class="editable" data-field="con_3" data-index="${index}">${fmtVal(ann.con_3)}</td>
          <td class="editable" data-field="extent_3" data-index="${index}">${fmtPct(ann.extent_3)}</td>
          <td class="editable" data-field="sev_3" data-index="${index}">${fmtVal(ann.sev_3)}</td>
          <td>
            <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); openEditModal(${index})" title="Edit Fields">✏️</button>
            <button class="btn btn-sm btn-success" onclick="event.stopPropagation(); enableGeometryEdit(${index})" title="Edit Geometry">📐</button>
            <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteAnnotation(${index})" title="Delete">🗑️</button>
          </td>
        `;
        
        // Add click handler AFTER innerHTML (so it doesn't get wiped out)
        row.onclick = (e) => {
          if (!e.target.closest('button') && !e.target.classList.contains('editable')) {
            document.querySelectorAll('.annotation-table tbody tr').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');
            selectAnnotationForEdit(index);
          }
        };
        
        // Add double-click handlers to editable cells
        row.querySelectorAll('.editable').forEach(cell => {
          cell.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            makeTableCellEditable(cell);
          });
        });
        
        tbody.appendChild(row);
      });
    }
    
    // Select annotation for editing (zoom and highlight)
    function selectAnnotationForEdit(index) {
      console.log('Selecting annotation for edit:', index);
      
      const ann = annotations[index];
      if (!ann) {
        console.error('Annotation not found:', index);
        return;
      }
      
      // Find the layer on the map
      let selectedLayer = null;
      drawnItems.eachLayer(layer => {
        if (layer.annotationData === ann) {
          selectedLayer = layer;
        }
      });
      
      if (!selectedLayer) {
        console.error('Layer not found for annotation:', index);
        return;
      }
      
      // Highlight the selected layer
      const originalStyle = {
        color: selectedLayer.options.color || '#3388ff',
        weight: selectedLayer.options.weight || 3
      };
      
      if (selectedLayer.setStyle) {
        selectedLayer.setStyle({
          color: '#00ff00',
          weight: 4,
          fillOpacity: 0.4
        });
        
        // Reset style after 2 seconds
        setTimeout(() => {
          if (selectedLayer.setStyle) {
            selectedLayer.setStyle(originalStyle);
          }
        }, 2000);
      }
      
      // Zoom to the annotation
      if (selectedLayer.getBounds) {
        map.fitBounds(selectedLayer.getBounds(), { padding: [50, 50] });
      } else if (selectedLayer.getLatLng) {
        map.setView(selectedLayer.getLatLng(), 18);
      }
      
      // Open popup if exists
      if (selectedLayer.openPopup) {
        selectedLayer.openPopup();
      }
      
      console.log('✅ Zoomed to annotation', index);
    }
    
    // Make table cell editable inline
    function makeTableCellEditable(cell) {
      // Don't allow editing if already editing
      if (cell.classList.contains('editing')) return;
      
      const field = cell.dataset.field;
      const index = parseInt(cell.dataset.index);
      const annotation = annotations[index];
      
      if (!annotation) return;
      
      // Get current value (remove % sign if present)
      let currentValue = annotation[field];
      if (currentValue === undefined || currentValue === null) {
        currentValue = '';
      } else if (field === 'old_dead') {
        currentValue = currentValue.toString().replace('%', '');
      } else if (field === 'juvenile') {
        // Keep juvenile as numeric value for editing
        currentValue = currentValue.toString();
      } else {
        currentValue = currentValue.toString();
      }
      
      // Store original value and text
      const originalValue = currentValue;
      const originalText = cell.textContent;
      
      // Mark as editing
      cell.classList.add('editing');
      
      // For species and juv_substrate, create autocomplete-enabled input
      if (field === 'spcode' || field === 'juv_substrate') {
        createTableAutocomplete(cell, field, currentValue, index, annotation);
        return;
      }
      
      // Create input element based on field type
      let inputElement;
      
      if (field === 'segment') {
        // Dropdown for segment
        inputElement = document.createElement('select');
        inputElement.innerHTML = `
          <option value="">-</option>
          <option value="0">0</option>
          <option value="5">5</option>
          <option value="10">10</option>
          <option value="15">15</option>
        `;
        inputElement.value = currentValue;
      } else if (field === 'transect') {
        // Dropdown for transect
        inputElement = document.createElement('select');
        inputElement.innerHTML = `
          <option value="">-</option>
          <option value="A">A</option>
          <option value="B">B</option>
        `;
        inputElement.value = currentValue;
      } else if (field === 'juvenile') {
        // Dropdown for juvenile
        inputElement = document.createElement('select');
        inputElement.innerHTML = `
          <option value="0">0 (No)</option>
          <option value="-1">-1 (Yes)</option>
        `;
        inputElement.value = currentValue;
      } else if (field === 'morph_code') {
        // Dropdown for morphology code
        inputElement = document.createElement('select');
        inputElement.innerHTML = `
          <option value="">-</option>
          <option value="BR">BR - Branching</option>
          <option value="CO">CO - Columnar</option>
          <option value="EN">EN - Encrusting</option>
          <option value="FO">FO - Foliaceous</option>
          <option value="FL">FL - Free-living</option>
          <option value="LA">LA - Laminar</option>
          <option value="MD">MD - Mounding</option>
          <option value="MA">MA - Massive</option>
          <option value="PL">PL - Plating</option>
          <option value="SM">SM - Submassive</option>
          <option value="SO">SO - Solitary</option>
          <option value="TB">TB - Tabular</option>
        `;
        inputElement.value = currentValue;
      } else if (field === 'obs_year') {
        // Number input for year
        inputElement = document.createElement('input');
        inputElement.type = 'number';
        inputElement.min = '2000';
        inputElement.max = '2100';
        inputElement.value = currentValue;
      } else if (field === 'old_dead' || field === 'rd_1' || field === 'rd_2' || field === 'rd_3' ||
                 field === 'extent_1' || field === 'extent_2' || field === 'extent_3') {
        // Number input for percentage fields (0-100)
        inputElement = document.createElement('input');
        inputElement.type = 'number';
        inputElement.min = '0';
        inputElement.max = '100';
        inputElement.value = currentValue;
      } else if (field === 'sev_1' || field === 'sev_2' || field === 'sev_3') {
        // Number input for severity (1-5)
        inputElement = document.createElement('input');
        inputElement.type = 'number';
        inputElement.min = '1';
        inputElement.max = '5';
        inputElement.value = currentValue;
      } else if (field === 'seglength' || field === 'segwidth') {
        // Float input for segment dimensions
        inputElement = document.createElement('input');
        inputElement.type = 'number';
        inputElement.step = '0.1';
        inputElement.value = currentValue;
      } else if (field === 'remnant' || field === 'fragment' || field === 'ex_bound' || field === 'no_colony') {
        // Yes/No dropdown for boolean fields (0 = No, -1 = Yes)
        inputElement = document.createElement('select');
        inputElement.innerHTML = `
          <option value="0">0 (No)</option>
          <option value="-1">-1 (Yes)</option>
        `;
        inputElement.value = currentValue;
      } else {
        // Text input for other fields (rdcause1-3, con_1-3, analyst, site, etc.)
        inputElement = document.createElement('input');
        inputElement.type = 'text';
        inputElement.value = currentValue;

        // Set max length for specific fields
        if (field === 'analyst' || field === 'spcode' || field === 'rdcause1' || field === 'rdcause2' ||
            field === 'rdcause3' || field === 'con_1' || field === 'con_2' || field === 'con_3') {
          inputElement.maxLength = 10;
        }
      }
      
      // Clear cell and add input
      cell.innerHTML = '';
      cell.appendChild(inputElement);
      
      // Focus and select the input
      inputElement.focus();
      if (inputElement.select) {
        inputElement.select();
      }
      
      // Fields that should be stored as numbers
      const numericFields = ['obs_year', 'old_dead', 'segment', 'juvenile', 'remnant', 'fragment',
        'ex_bound', 'no_colony', 'rd_1', 'rd_2', 'rd_3', 'extent_1', 'extent_2', 'extent_3',
        'sev_1', 'sev_2', 'sev_3', 'seglength', 'segwidth'];
      // Fields displayed as Yes/No
      const boolFields = ['juvenile', 'remnant', 'fragment', 'ex_bound', 'no_colony'];
      // Fields displayed with % suffix
      const pctFields = ['old_dead', 'rd_1', 'rd_2', 'rd_3', 'extent_1', 'extent_2', 'extent_3'];

      // Save function
      const saveEdit = () => {
        // Snapshot for undo
        const prevAnnotation = { ...annotation };

        let newValue = inputElement.value.trim();

        // Convert empty string to appropriate default
        if (newValue === '' || newValue === '-') {
          newValue = '';
        }

        // Convert to number for numeric fields
        if (numericFields.includes(field)) {
          const num = parseFloat(newValue);
          newValue = isNaN(num) ? '' : num;
        }

        // Update annotation (flat top-level field)
        if (newValue === '') {
          delete annotation[field];
        } else {
          annotation[field] = newValue;
        }
        // Keep nested .properties in sync (used by normalizeAnnotationForDb for Oracle saves)
        if (annotation.properties) {
          if (newValue === '') {
            delete annotation.properties[field];
          } else {
            annotation.properties[field] = newValue;
          }
        }

        // Push to undo stack
        if (typeof undoPushEdit === 'function') {
          undoPushEdit(index, prevAnnotation, { ...annotation });
        }

        // Remove editing class
        cell.classList.remove('editing');

        // Update cell display
        if (pctFields.includes(field) && newValue !== '') {
          cell.textContent = newValue + '%';
        } else if (boolFields.includes(field)) {
          cell.textContent = newValue == -1 ? 'Yes' : (newValue == 0 ? 'No' : '-');
        } else if (newValue === '') {
          cell.textContent = '-';
        } else {
          cell.textContent = newValue;
        }

        // Refresh map label and layer style if species changed
        if (field === 'spcode') {
          drawnItems.eachLayer(l => {
            if (l.annotationData === annotation || l.feature === annotation) {
              if (labelsVisible && typeof addLabelToAnnotation === 'function') addLabelToAnnotation(l);
              // Update layer color when species completeness changes (orange ↔ blue)
              if (l.setStyle && typeof getAnnotationLayerStyle === 'function') {
                l.setStyle(getAnnotationLayerStyle(annotation));
              }
            }
          });
        }

        // Save to project
        saveProject();

        console.log(`✅ Updated ${field} for annotation ${index} to: ${newValue}`);
      };
      
      // Cancel function
      const cancelEdit = () => {
        cell.classList.remove('editing');
        cell.textContent = originalText;
      };
      
      // Event handlers
      inputElement.addEventListener('blur', saveEdit);
      
      inputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveEdit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        } else if (e.key === 'Tab') {
          // Allow default tab behavior which will trigger blur and save
          return;
        }
      });
      
      // Stop propagation to prevent row click
      inputElement.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
    
    // Create autocomplete for table cell editing (species and juv_substrate)
    function createTableAutocomplete(cell, field, currentValue, index, annotation) {
      const JUV_SUBSTRATE_OPTIONS = ['CCAH', 'CCAR', 'TURFH', 'TURFR', 'EMA', 'PESP', 'LOBO', 'HARD', 'CORAL', 'RUB', 'HALI'];
      
      // Create wrapper
      const wrapper = document.createElement('div');
      wrapper.style.position = 'relative';
      wrapper.style.width = '100%';
      
      // Create input
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentValue;
      input.style.width = '100%';
      input.style.padding = '4px';
      input.style.border = '1px solid #667eea';
      input.style.borderRadius = '3px';
      input.autocomplete = 'off';
      
      // Create dropdown
      const dropdown = document.createElement('div');
      dropdown.className = 'autocomplete-dropdown';
      dropdown.style.position = 'absolute';
      dropdown.style.top = '100%';
      dropdown.style.left = '0';
      dropdown.style.width = '100%';
      dropdown.style.maxHeight = '200px';
      dropdown.style.overflowY = 'auto';
      dropdown.style.background = 'white';
      dropdown.style.border = '1px solid #ddd';
      dropdown.style.borderRadius = '4px';
      dropdown.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
      dropdown.style.zIndex = '10000';
      dropdown.style.display = 'none';
      
      let tableResults = [];
      let tableSelectedIndex = -1;
      let debounceTimer;
      
      // Search function
      const search = (query) => {
        clearTimeout(debounceTimer);
        
        if (field === 'spcode') {
          if (query.length < 2) {
            dropdown.style.display = 'none';
            return;
          }
          
          debounceTimer = setTimeout(() => {
            dropdown.innerHTML = '<div style="padding: 8px; text-align: center; color: #888;">Searching...</div>';
            dropdown.style.display = 'block';
            
            fetch(`/api/coral/species/search?q=${encodeURIComponent(query)}&limit=10`)
              .then(res => res.json())
              .then(data => {
                tableResults = data.results || [];
                
                if (tableResults.length === 0) {
                  dropdown.innerHTML = '<div style="padding: 8px; text-align: center; color: #999;">No species found</div>';
                } else {
                  tableSelectedIndex = 0;
                  dropdown.innerHTML = tableResults.map((species, idx) => `
                    <div class="autocomplete-item ${idx === 0 ? 'selected' : ''}" 
                         style="padding: 8px; cursor: pointer; border-bottom: 1px solid #f0f0f0;" 
                         data-index="${idx}">
                      <div style="font-weight: 600; color: #667eea; font-size: 12px;">${species.code}</div>
                      <div style="color: #333; font-size: 11px;">${species.taxon_name || species.genus}</div>
                      ${species.scientific_name ? `<div style="color: #888; font-size: 10px; font-style: italic;">${species.scientific_name}</div>` : ''}
                    </div>
                  `).join('');
                  
                  dropdown.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
                    item.addEventListener('mousedown', (e) => {
                      e.preventDefault();
                      input.value = tableResults[idx].code;
                      dropdown.style.display = 'none';
                      saveTableEdit();
                    });
                    item.addEventListener('mouseenter', () => {
                      dropdown.querySelectorAll('.autocomplete-item').forEach(i => i.classList.remove('selected'));
                      item.classList.add('selected');
                      tableSelectedIndex = idx;
                    });
                  });
                }
              })
              .catch(err => {
                console.error('Species search error:', err);
                dropdown.innerHTML = '<div style="padding: 8px; text-align: center; color: #999;">Search failed</div>';
              });
          }, 300);
          
        } else if (field === 'juv_substrate') {
          const upperQuery = query.toUpperCase();
          
          if (query.length === 0) {
            dropdown.style.display = 'none';
            return;
          }
          
          tableResults = JUV_SUBSTRATE_OPTIONS.filter(option => option.includes(upperQuery));
          
          if (tableResults.length === 0) {
            dropdown.innerHTML = '<div style="padding: 8px; text-align: center; color: #999;">No substrate found</div>';
            dropdown.style.display = 'block';
          } else {
            tableSelectedIndex = 0;
            dropdown.innerHTML = tableResults.map((substrate, idx) => `
              <div class="autocomplete-item ${idx === 0 ? 'selected' : ''}" 
                   style="padding: 8px; cursor: pointer; border-bottom: 1px solid #f0f0f0;" 
                   data-index="${idx}">
                <div style="font-weight: 600; color: #667eea; font-size: 12px;">${substrate}</div>
              </div>
            `).join('');
            dropdown.style.display = 'block';
            
            dropdown.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
              item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                input.value = tableResults[idx];
                dropdown.style.display = 'none';
                saveTableEdit();
              });
              item.addEventListener('mouseenter', () => {
                dropdown.querySelectorAll('.autocomplete-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                tableSelectedIndex = idx;
              });
            });
          }
        }
      };
      
      // Save function (guarded to prevent double-fire from autocomplete mousedown + blur)
      let _editSaved = false;
      const saveTableEdit = () => {
        if (_editSaved) return;
        _editSaved = true;
        const newValue = input.value.trim();
        
        if (newValue === '' || newValue === '-') {
          delete annotation[field];
        } else {
          annotation[field] = newValue;
        }
        // Keep nested .properties in sync (used by normalizeAnnotationForDb for Oracle saves)
        if (annotation.properties) {
          if (newValue === '' || newValue === '-') {
            delete annotation.properties[field];
          } else {
            annotation.properties[field] = newValue;
          }
        }
        
        cell.classList.remove('editing');
        dropdown.style.display = 'none';

        // Refresh map label and layer style when species is changed via autocomplete
        if (field === 'spcode') {
          drawnItems.eachLayer(l => {
            // File mode: annotationData is the same object reference
            // DB mode: feature is the same object reference
            if (l.annotationData === annotation || l.feature === annotation) {
              if (labelsVisible && typeof addLabelToAnnotation === 'function') addLabelToAnnotation(l);
              // Update layer color when species completeness changes (orange ↔ blue)
              if (l.setStyle && typeof getAnnotationLayerStyle === 'function') {
                l.setStyle(getAnnotationLayerStyle(annotation));
              }
            }
          });
        }

        updateAnnotationTable();
        saveProject();
      };
      
      // Cancel function
      const cancelTableEdit = () => {
        cell.classList.remove('editing');
        dropdown.style.display = 'none';
        updateAnnotationTable();
      };
      
      // Input events
      input.addEventListener('input', (e) => {
        search(e.target.value.trim());
      });
      
      input.addEventListener('keydown', (e) => {
        if (dropdown.style.display === 'block') {
          const items = dropdown.querySelectorAll('.autocomplete-item');
          
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            tableSelectedIndex = Math.min(tableSelectedIndex + 1, items.length - 1);
            items.forEach((item, idx) => {
              if (idx === tableSelectedIndex) {
                item.classList.add('selected');
                item.style.background = '#f8f9fa';
                item.scrollIntoView({ block: 'nearest' });
              } else {
                item.classList.remove('selected');
                item.style.background = '';
              }
            });
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            tableSelectedIndex = Math.max(tableSelectedIndex - 1, -1);
            items.forEach((item, idx) => {
              if (idx === tableSelectedIndex) {
                item.classList.add('selected');
                item.style.background = '#f8f9fa';
                item.scrollIntoView({ block: 'nearest' });
              } else {
                item.classList.remove('selected');
                item.style.background = '';
              }
            });
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (tableSelectedIndex >= 0 && tableSelectedIndex < tableResults.length) {
              if (field === 'spcode') {
                input.value = tableResults[tableSelectedIndex].code;
              } else {
                input.value = tableResults[tableSelectedIndex];
              }
            }
            dropdown.style.display = 'none';
            saveTableEdit();
          } else if (e.key === 'Tab') {
            if (tableSelectedIndex >= 0 && tableSelectedIndex < tableResults.length) {
              e.preventDefault();
              if (field === 'spcode') {
                input.value = tableResults[tableSelectedIndex].code;
              } else {
                input.value = tableResults[tableSelectedIndex];
              }
              dropdown.style.display = 'none';
              saveTableEdit();
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelTableEdit();
          }
        } else {
          if (e.key === 'Enter') {
            e.preventDefault();
            saveTableEdit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelTableEdit();
          }
        }
      });
      
      input.addEventListener('blur', (e) => {
        setTimeout(() => {
          saveTableEdit();
        }, 200);
      });
      
      // Build
      wrapper.appendChild(input);
      wrapper.appendChild(dropdown);
      cell.innerHTML = '';
      cell.appendChild(wrapper);
      input.focus();
      if (input.select) input.select();
    }
    
    // Open edit modal with annotation data
    function openEditModal(index) {
      const annotation = annotations[index];
      if (!annotation) {
        console.error('Annotation not found:', index);
        return;
      }
      
      document.getElementById('editModalId').textContent = index + 1;
      
      // Helpers for building form fields
      const a = annotation;
      const esc = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const inp = (id, label, val, type='text', extra='') =>
        `<div class="modal-form-field">
          <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px;">${label}</label>
          <input type="${type}" id="${id}" value="${esc(val)}" ${extra} style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;" />
        </div>`;
      const sel = (id, label, val, options) =>
        `<div class="modal-form-field">
          <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px;">${label}</label>
          <select id="${id}" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
            ${options.map(o => `<option value="${o.v}" ${String(val) === String(o.v) ? 'selected' : ''}>${o.l}</option>`).join('')}
          </select>
        </div>`;
      const boolOpts = [{v:'0',l:'No'},{v:'-1',l:'Yes'}];
      const segOpts = [{v:'',l:'-'},{v:'0',l:'0'},{v:'5',l:'5'},{v:'10',l:'10'},{v:'15',l:'15'}];
      const transOpts = [{v:'',l:'-'},{v:'A',l:'A'},{v:'B',l:'B'}];
      const morphOpts = [{v:'',l:'-'},{v:'BR',l:'BR - Branching'},{v:'CO',l:'CO - Columnar'},{v:'EN',l:'EN - Encrusting'},
        {v:'FO',l:'FO - Foliaceous'},{v:'FL',l:'FL - Free-living'},{v:'LA',l:'LA - Laminar'},{v:'MD',l:'MD - Mounding'},
        {v:'MA',l:'MA - Massive'},{v:'PL',l:'PL - Plating'},{v:'SM',l:'SM - Submassive'},{v:'SO',l:'SO - Solitary'},{v:'TB',l:'TB - Tabular'}];

      // Build the form HTML
      const formHTML = `
        <div style="max-height:65vh;overflow-y:auto;padding-right:4px;">
          <div style="font-size:11px;font-weight:600;color:#667eea;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Session Fields</div>
          <div class="modal-form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
            ${inp('edit_analyst','Analyst *',a.analyst,'text','maxlength="10" required')}
            ${inp('edit_obs_year','Year *',a.obs_year,'number','min="2000" max="2100" required')}
            ${inp('edit_mission_id','Mission ID *',a.mission_id,'text','required')}
            ${inp('edit_site','Site *',a.site)}
          </div>
          <div style="font-size:11px;font-weight:600;color:#667eea;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Core Fields</div>
          <div class="modal-form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
            <div class="modal-form-field" style="position:relative;">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px;">Species Code</label>
              <input type="text" id="edit_spcode" value="${esc(a.spcode)}" maxlength="10" style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;" autocomplete="off" />
              <div id="edit-species-autocomplete" class="species-autocomplete-dropdown" style="position:absolute;z-index:10000;display:none;background:white;border:1px solid #ddd;border-radius:4px;max-height:200px;overflow-y:auto;width:100%;box-shadow:0 2px 8px rgba(0,0,0,0.15);"></div>
            </div>
            ${sel('edit_morph_code','Morphology',a.morph_code,morphOpts)}
            ${sel('edit_transect','Transect',a.transect,transOpts)}
            ${sel('edit_segment','Segment',a.segment,segOpts)}
            ${inp('edit_seglength','Seg Length',a.seglength,'number','step="0.1"')}
            ${inp('edit_segwidth','Seg Width',a.segwidth,'number','step="0.1"')}
            ${sel('edit_juvenile','Juvenile',a.juvenile || 0,boolOpts)}
            ${inp('edit_juv_substrate','JUV_SUBSTRATE',a.juv_substrate)}
            ${sel('edit_no_colony','No Colony',a.no_colony || 0,boolOpts)}
            ${sel('edit_remnant','Remnant',a.remnant || 0,boolOpts)}
            ${sel('edit_fragment','Fragment',a.fragment || 0,boolOpts)}
            ${sel('edit_ex_bound','Ex. Bound',a.ex_bound || 0,boolOpts)}
            ${inp('edit_old_dead','Old Dead %',a.old_dead,'number','min="0" max="100"')}
          </div>
          <div style="font-size:11px;font-weight:600;color:#667eea;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Recent Dead</div>
          <div class="modal-form-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px;">
            ${inp('edit_rdcause1','RD Cause 1',a.rdcause1,'text','maxlength="10"')}
            ${inp('edit_rd_1','RD 1 %',a.rd_1,'number','min="0" max="100"')}
            <div></div>
            ${inp('edit_rdcause2','RD Cause 2',a.rdcause2,'text','maxlength="10"')}
            ${inp('edit_rd_2','RD 2 %',a.rd_2,'number','min="0" max="100"')}
            <div></div>
            ${inp('edit_rdcause3','RD Cause 3',a.rdcause3,'text','maxlength="10"')}
            ${inp('edit_rd_3','RD 3 %',a.rd_3,'number','min="0" max="100"')}
            <div></div>
          </div>
          <div style="font-size:11px;font-weight:600;color:#667eea;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Condition</div>
          <div class="modal-form-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
            ${inp('edit_con_1','Condition 1',a.con_1,'text','maxlength="10"')}
            ${inp('edit_extent_1','Extent 1 %',a.extent_1,'number','min="0" max="100"')}
            ${inp('edit_sev_1','Severity 1',a.sev_1,'number','min="1" max="5"')}
            ${inp('edit_con_2','Condition 2',a.con_2,'text','maxlength="10"')}
            ${inp('edit_extent_2','Extent 2 %',a.extent_2,'number','min="0" max="100"')}
            ${inp('edit_sev_2','Severity 2',a.sev_2,'number','min="1" max="5"')}
            ${inp('edit_con_3','Condition 3',a.con_3,'text','maxlength="10"')}
            ${inp('edit_extent_3','Extent 3 %',a.extent_3,'number','min="0" max="100"')}
            ${inp('edit_sev_3','Severity 3',a.sev_3,'number','min="1" max="5"')}
          </div>
        </div>
      `;
      
      document.getElementById('editFormContainer').innerHTML = formHTML;
      document.getElementById('editModal').classList.add('active');
      
      // Store the index for saving
      document.getElementById('editModal').dataset.annotationIndex = index;
      
      // Initialize species autocomplete for the edit field
      initEditSpeciesAutocomplete();
      
      console.log('✅ Opened edit modal for annotation', index);
    }
    
    // Close edit modal
    function closeEditModal() {
      document.getElementById('editModal').classList.remove('active');
      document.getElementById('editFormContainer').innerHTML = '';
      document.getElementById('editModal').dataset.annotationIndex = '';
      
      // Hide geometry edit buttons if they're visible
      cancelGeometryEdit();
    }
    
    // Initialize species autocomplete for edit modal
    let editAutocompleteTimeout = null;
    let editAutocompleteSelectedIndex = -1;
    let editAutocompleteResults = [];
    
    function initEditSpeciesAutocomplete() {
      const input = document.getElementById('edit_spcode');
      const dropdown = document.getElementById('edit-species-autocomplete');
      
      if (!input || !dropdown) return;
      
      // Handle input typing
      input.addEventListener('input', function(e) {
        const query = e.target.value.trim();
        
        // Clear previous timeout
        if (editAutocompleteTimeout) {
          clearTimeout(editAutocompleteTimeout);
        }
        
        // Hide dropdown if query is too short
        if (query.length < 2) {
          dropdown.style.display = 'none';
          return;
        }
        
        // Show loading
        dropdown.innerHTML = '<div style="padding: 8px; color: #666;">Searching...</div>';
        dropdown.style.display = 'block';
        
        // Debounce the search
        editAutocompleteTimeout = setTimeout(() => {
          searchEditSpecies(query);
        }, 300);
      });
      
      // Handle keyboard navigation
      input.addEventListener('keydown', function(e) {
        if (dropdown.style.display === 'none') return;
        
        const items = dropdown.querySelectorAll('.autocomplete-item');
        
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          editAutocompleteSelectedIndex = Math.min(editAutocompleteSelectedIndex + 1, items.length - 1);
          updateEditAutocompleteSelection(items);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          editAutocompleteSelectedIndex = Math.max(editAutocompleteSelectedIndex - 1, -1);
          updateEditAutocompleteSelection(items);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          if (editAutocompleteSelectedIndex >= 0 && editAutocompleteSelectedIndex < editAutocompleteResults.length) {
            e.preventDefault();
            selectEditSpecies(editAutocompleteResults[editAutocompleteSelectedIndex]);
          }
        } else if (e.key === 'Escape') {
          dropdown.style.display = 'none';
          editAutocompleteSelectedIndex = -1;
        }
      });
      
      // Close dropdown when clicking outside
      document.addEventListener('click', function(e) {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
          dropdown.style.display = 'none';
          editAutocompleteSelectedIndex = -1;
        }
      });
    }
    
    function searchEditSpecies(query) {
      const dropdown = document.getElementById('edit-species-autocomplete');
      
      fetch(`/api/coral/species/search?q=${encodeURIComponent(query)}&limit=10`)
        .then(res => res.json())
        .then(data => {
          editAutocompleteResults = data.results || [];
          
          if (editAutocompleteResults.length === 0) {
            editAutocompleteSelectedIndex = -1;
            dropdown.innerHTML = '<div style="padding: 8px; color: #999;">No species found</div>';
          } else {
            editAutocompleteSelectedIndex = 0;
            
            dropdown.innerHTML = editAutocompleteResults.map((species, index) => `
              <div class="autocomplete-item ${index === 0 ? 'selected' : ''}" 
                   style="padding: 8px; cursor: pointer; ${index === 0 ? 'background: #e3f2fd;' : ''}"
                   data-index="${index}" 
                   onmouseover="this.style.background='#e3f2fd'" 
                   onmouseout="if(!this.classList.contains('selected')) this.style.background='white'"
                   onclick="selectEditSpeciesByIndex(${index})">
                <div style="font-weight: bold; color: #1976d2;">${species.code}</div>
                <div style="font-size: 0.9em; color: #666;">${species.taxon_name || species.genus}</div>
                ${species.scientific_name ? `<div style="font-size: 0.85em; color: #999; font-style: italic;">${species.scientific_name}</div>` : ''}
              </div>
            `).join('');
          }
          
          dropdown.style.display = 'block';
        })
        .catch(err => {
          console.error('Species search error:', err);
          dropdown.innerHTML = '<div style="padding: 8px; color: #d32f2f;">Search failed</div>';
        });
    }
    
    function updateEditAutocompleteSelection(items) {
      items.forEach((item, index) => {
        if (index === editAutocompleteSelectedIndex) {
          item.classList.add('selected');
          item.style.background = '#e3f2fd';
          item.scrollIntoView({ block: 'nearest' });
        } else {
          item.classList.remove('selected');
          item.style.background = 'white';
        }
      });
    }
    
    function selectEditSpeciesByIndex(index) {
      if (index >= 0 && index < editAutocompleteResults.length) {
        selectEditSpecies(editAutocompleteResults[index]);
      }
    }
    
    function selectEditSpecies(species) {
      const input = document.getElementById('edit_spcode');
      const dropdown = document.getElementById('edit-species-autocomplete');
      
      // Set the species code
      input.value = species.code;
      
      // Close dropdown
      dropdown.style.display = 'none';
      editAutocompleteSelectedIndex = -1;
      
      // Log selection
      console.log('✅ Selected species:', species.code, '-', species.taxon_name);
      
      // Focus next field (morphology)
      const morphField = document.getElementById('edit_morph_code');
      if (morphField) {
        morphField.focus();
      }
    }
    
    // Save edited annotation from modal
    function saveEditedAnnotation() {
      const index = parseInt(document.getElementById('editModal').dataset.annotationIndex);
      
      if (isNaN(index) || !annotations[index]) {
        console.error('Invalid annotation index:', index);
        return;
      }
      
      const annotation = annotations[index];

      // Snapshot for undo before applying changes
      const prevAnnotation = { ...annotation };

      // Helper to safely read a modal field value
      const getVal = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
      const getInt = (id) => { const v = getVal(id); return (v !== null && v !== '') ? parseInt(v) : null; };
      const getFloat = (id) => { const v = getVal(id); return (v !== null && v !== '') ? parseFloat(v) : null; };

      // Update annotation with all form values
      annotation.analyst = getVal('edit_analyst');
      annotation.obs_year = getInt('edit_obs_year');
      annotation.mission_id = getVal('edit_mission_id');
      annotation.site = getVal('edit_site');
      annotation.transect = getVal('edit_transect') || null;
      annotation.segment = getVal('edit_segment') || null;
      annotation.seglength = getFloat('edit_seglength');
      annotation.segwidth = getFloat('edit_segwidth');
      annotation.spcode = getVal('edit_spcode') || null;
      annotation.morph_code = getVal('edit_morph_code') || null;
      annotation.juvenile = getInt('edit_juvenile') || 0;
      annotation.juv_substrate = getVal('edit_juv_substrate') || null;
      annotation.no_colony = getInt('edit_no_colony') || 0;
      annotation.remnant = getInt('edit_remnant') || 0;
      annotation.fragment = getInt('edit_fragment') || 0;
      annotation.ex_bound = getInt('edit_ex_bound') || 0;
      annotation.old_dead = getInt('edit_old_dead');
      annotation.rdcause1 = getVal('edit_rdcause1') || null;
      annotation.rd_1 = getInt('edit_rd_1');
      annotation.rdcause2 = getVal('edit_rdcause2') || null;
      annotation.rd_2 = getInt('edit_rd_2');
      annotation.rdcause3 = getVal('edit_rdcause3') || null;
      annotation.rd_3 = getInt('edit_rd_3');
      annotation.con_1 = getVal('edit_con_1') || null;
      annotation.extent_1 = getInt('edit_extent_1');
      annotation.sev_1 = getInt('edit_sev_1');
      annotation.con_2 = getVal('edit_con_2') || null;
      annotation.extent_2 = getInt('edit_extent_2');
      annotation.sev_2 = getInt('edit_sev_2');
      annotation.con_3 = getVal('edit_con_3') || null;
      annotation.extent_3 = getInt('edit_extent_3');
      annotation.sev_3 = getInt('edit_sev_3');
      
      // Update the layer's annotationData
      drawnItems.eachLayer(layer => {
        if (layer.annotationData === annotation) {
          layer.annotationData = annotation;
          
          // Update popup if exists
          if (layer.getPopup()) {
            const popupContent = `
              <strong>Annotation #${index + 1}</strong><br>
              <strong>Species:</strong> ${annotation.spcode || 'Not set'}<br>
              <strong>Site:</strong> ${annotation.site || 'Not set'}<br>
              <strong>Analyst:</strong> ${annotation.analyst || 'Not set'}
            `;
            layer.setPopupContent(popupContent);
          }
        }
      });
      
      // Push to undo stack
      if (typeof undoPushEdit === 'function') {
        undoPushEdit(index, prevAnnotation, { ...annotation });
      }

      // Refresh map labels and layer styles
      drawnItems.eachLayer(layer => {
        if (layer.annotationData === annotation) {
          if (labelsVisible && typeof addLabelToAnnotation === 'function') {
            addLabelToAnnotation(layer);
          }
          // Update layer color when species completeness changes (orange ↔ blue)
          if (layer.setStyle && typeof getAnnotationLayerStyle === 'function') {
            layer.setStyle(getAnnotationLayerStyle(annotation));
          }
        }
      });

      // Update the annotation table
      updateAnnotationTable();

      // Mark unsaved and trigger save/sync
      hasUnsavedChanges = true;
      if (typeof isOracleProjectMode === 'function' && isOracleProjectMode()) {
        if (typeof saveProject === 'function') saveProject();
      }

      // Close modal (this will also hide geometry edit buttons)
      closeEditModal();

      showStatus('✅ Annotation updated', 'success');
      console.log('✅ Saved annotation', index, annotation);
    }
    
    // Enable geometry editing for an annotation
    let currentEditingLayer = null;
    
    function enableGeometryEdit(index) {
      const ann = annotations[index];
      if (!ann) {
        console.error('Annotation not found:', index);
        return;
      }
      
      // Find the layer on the map
      let targetLayer = null;
      drawnItems.eachLayer(layer => {
        if (layer.annotationData === ann) {
          targetLayer = layer;
        }
      });
      
      if (!targetLayer) {
        console.error('Layer not found for annotation:', index);
        return;
      }
      
      // Disable any previous editing
      if (currentEditingLayer && currentEditingLayer.editing) {
        currentEditingLayer.editing.disable();
      }
      
      // Enable editing on this layer
      if (targetLayer.editing) {
        targetLayer.editing.enable();
        currentEditingLayer = targetLayer;
        
        // Zoom to the annotation
        if (targetLayer.getBounds) {
          map.fitBounds(targetLayer.getBounds(), { padding: [50, 50] });
        } else if (targetLayer.getLatLng) {
          map.setView(targetLayer.getLatLng(), 18);
        }
        
        // Highlight the layer being edited
        if (targetLayer.setStyle) {
          targetLayer.setStyle({
            color: '#ffaa00',
            weight: 3,
            fillOpacity: 0.3
          });
        }
        
        showStatus(`📐 Editing geometry for annotation #${index + 1} - Drag vertices to modify. Click "Save Geometry" when done.`, 'info');
        
        // Store the original LatLngs with full precision (not toGeoJSON which loses precision!)
        if (targetLayer.getLatLngs) {
          const latlngs = targetLayer.getLatLngs();
          // Deep clone LatLngs to preserve full precision
          currentEditingLayer.originalLatLngs = JSON.parse(JSON.stringify(latlngs));
        } else if (targetLayer.getLatLng) {
          currentEditingLayer.originalLatLngs = JSON.parse(JSON.stringify(targetLayer.getLatLng()));
        }
        currentEditingLayer.editingIndex = index;
        
        // Add geometry edit buttons to the annotation panel header
        const annotationHeader = document.querySelector('.annotation-panel h3').parentElement;
        
        // Remove any existing buttons first
        const existingContainer = document.getElementById('geometryEditButtons');
        if (existingContainer) {
          existingContainer.remove();
        }
        
        // Create button container
        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'geometryEditButtons';
        buttonContainer.style.cssText = 'display: flex; gap: 8px; align-items: center;';
        
        // Create save button
        const saveGeomBtn = document.createElement('button');
        saveGeomBtn.className = 'btn btn-success';
        saveGeomBtn.style.cssText = 'padding: 6px 12px; font-size: 12px;';
        saveGeomBtn.innerHTML = '💾 Save Geometry';
        saveGeomBtn.onclick = () => saveGeometryEdit(index);
        
        // Create cancel button
        const cancelGeomBtn = document.createElement('button');
        cancelGeomBtn.className = 'btn btn-secondary';
        cancelGeomBtn.style.cssText = 'padding: 6px 12px; font-size: 12px;';
        cancelGeomBtn.innerHTML = '✖️ Cancel';
        cancelGeomBtn.onclick = cancelGeometryEdit;
        
        // Add editing indicator
        const editingLabel = document.createElement('span');
        editingLabel.style.cssText = 'font-size: 11px; color: #ff9800; font-weight: bold;';
        editingLabel.innerHTML = `📐 Editing #${index + 1}`;
        
        buttonContainer.appendChild(editingLabel);
        buttonContainer.appendChild(saveGeomBtn);
        buttonContainer.appendChild(cancelGeomBtn);
        
        // Insert buttons into header
        annotationHeader.appendChild(buttonContainer);
        
        console.log('✅ Geometry editing enabled for annotation', index);
      } else {
        console.error('Layer does not support editing');
        showStatus('❌ This layer type cannot be edited', 'error');
      }
    }
    
    function saveGeometryEdit(index) {
      if (!currentEditingLayer) return;
      
      // Capture reference before cleanup
      const layerToSave = currentEditingLayer;
      
      // Disable editing and clean up handles
      if (layerToSave.editing) {
        layerToSave.editing.disable();
        if (typeof _removeStaleEditHandles === 'function') _removeStaleEditHandles(layerToSave);
      }

      // Update the annotation's geometry with new coordinates
      const ann = annotations[index];
      if (ann) {
        // Use getFullPrecisionGeometry to preserve full coordinate precision
        // (toGeoJSON() truncates to 6 decimal places, losing ~1m accuracy)
        if (typeof getFullPrecisionGeometry === 'function') {
          ann.geometry = getFullPrecisionGeometry(layerToSave);
        } else {
          // Fallback to toGeoJSON if function not available
          ann.geometry = layerToSave.toGeoJSON().geometry;
        }
        
        // Update the layer's annotationData as well
        layerToSave.annotationData = ann;
        
        // Reset style to original (preserve 7px line weight)
        if (layerToSave.setStyle) {
          layerToSave.setStyle({
            color: '#3388ff',
            weight: 7,  // Preserve original 7px line weight
            opacity: 0.8,
            fillOpacity: 0.3
          });
        }
        
        // Update the label position to match new geometry
        const layerId = layerToSave._leaflet_id;
        if (layerId) {
          // Remove old label
          removeAnnotationLabel(layerId);
          // Add new label at updated position using the correct function
          // Use captured layerToSave reference (not currentEditingLayer which will be null)
          setTimeout(() => {
            if (labelsVisible && typeof addLabelToAnnotation === 'function') {
              addLabelToAnnotation(layerToSave);
            }
          }, 100);
        }
        
        // Mark unsaved changes and trigger save
        hasUnsavedChanges = true;
        if (isOracleProjectMode()) {
          setAutoSaveBadge('pending', '🔵 Unsaved changes');
        }
        
        // Persist the changes
        if (typeof saveProject === 'function') {
          saveProject();
        }
        
        console.log('✅ Geometry updated for annotation', index);
        showStatus('✅ Geometry saved', 'success');
      }
      
      // Remove button container
      const buttonContainer = document.getElementById('geometryEditButtons');
      if (buttonContainer) {
        buttonContainer.remove();
      }
      
      // Clean up
      delete layerToSave.originalLatLngs;
      delete layerToSave.editingIndex;
      currentEditingLayer = null;
    }
    
    function cancelGeometryEdit() {
      if (!currentEditingLayer) return;
      
      // Restore original geometry with full precision (revert changes)
      if (currentEditingLayer.originalLatLngs) {
        const originalLatLngs = currentEditingLayer.originalLatLngs;
        
        // Restore coordinates based on structure
        if (Array.isArray(originalLatLngs)) {
          // Check if it's a nested array (polygon) or flat array (polyline)
          if (Array.isArray(originalLatLngs[0])) {
            // Polygon - nested array
            const coords = originalLatLngs.map(ring => 
              Array.isArray(ring) ? ring.map(pt => L.latLng(pt.lat, pt.lng)) : L.latLng(ring.lat, ring.lng)
            );
            currentEditingLayer.setLatLngs(coords);
          } else {
            // Polyline - flat array
            const coords = originalLatLngs.map(pt => L.latLng(pt.lat, pt.lng));
            currentEditingLayer.setLatLngs(coords);
          }
        } else if (originalLatLngs.lat !== undefined) {
          // Single point (marker)
          currentEditingLayer.setLatLng(L.latLng(originalLatLngs.lat, originalLatLngs.lng));
        }
        
        console.log('↩️ Restored original geometry with full precision');
      }
      
      // Disable editing without saving, clean up handles
      if (currentEditingLayer.editing) {
        currentEditingLayer.editing.disable();
        if (typeof _removeStaleEditHandles === 'function') _removeStaleEditHandles(currentEditingLayer);
      }

      // Reset style (preserve 7px line weight for consistency)
      if (currentEditingLayer.setStyle) {
        currentEditingLayer.setStyle({
          color: '#3388ff',
          weight: 7,
          opacity: 0.8,
          fillOpacity: 0.3
        });
      }
      
      // Remove button container
      const buttonContainer = document.getElementById('geometryEditButtons');
      if (buttonContainer) {
        buttonContainer.remove();
      }
      
      // Clean up
      delete currentEditingLayer.originalLatLngs;
      delete currentEditingLayer.editingIndex;
      currentEditingLayer = null;
      
      showStatus('↩️ Geometry edit cancelled - changes discarded', 'info');
    }
    
    async function deleteAnnotation(index) {
      if (!await catConfirm('Delete this annotation?', { danger: true, ok: 'Delete' })) return;
      
      const ann = annotations[index];
      if (!ann) return;
      
      // Find and remove layer from map (and get its ID for label removal)
      let layerId = null;
      drawnItems.eachLayer(layer => {
        if (layer.annotationData === ann) {
          layerId = layer._leaflet_id; // Store the layer ID before removing
          drawnItems.removeLayer(layer);
        }
      });
      
      // Remove label from map if it exists (using the layer ID)
      if (layerId) {
        removeAnnotationLabel(layerId);
      }
      
      // Remove from annotations array (and projectAnnotations for poll sync)
      const removedAnn = annotations[index];
      annotations.splice(index, 1);
      if (typeof getProjectAnnotations === 'function') {
        const pa = getProjectAnnotations();
        if (pa && pa !== annotations) {
          const pi = pa.indexOf(removedAnn);
          if (pi !== -1) pa.splice(pi, 1);
        }
      }

      // Update table
      updateAnnotationTable();
      
      showStatus('🗑️ Annotation deleted', 'success');
      hasUnsavedChanges = true;
      if (typeof isOracleProjectMode === 'function' && isOracleProjectMode()) {
        setAutoSaveBadge('pending', '🔵 Unsaved changes');
        if (typeof saveProject === 'function') saveProject();
      }
    }
    
    // Auto-save logic extracted to js/annotation-runtime-autosave.js
