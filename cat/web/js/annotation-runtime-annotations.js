// Extracted from annotation-file-mode-runtime.js (Phase 2d: annotation editing/table)
    function updateAnnotationTable() {
      const tbody = document.getElementById('annotationTableBody');
      const countSpan = document.getElementById('annotationCount');
      
      if (!tbody) return;
      
      // Update count
      if (countSpan) {
        countSpan.textContent = annotations.length;
      }
      
      // Clear table
      tbody.innerHTML = '';
      
      if (annotations.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="12" style="text-align: center; padding: 20px; color: #6c757d;">
              No annotations yet - draw on the map to create one
            </td>
          </tr>
        `;
        return;
      }
      
      // Populate table with annotations
      annotations.forEach((ann, index) => {
        const row = document.createElement('tr');
        row.dataset.index = index;
        

        
        // Get the colony ID (try multiple field name variations, fallback to row number)
        const colonyId = ann.colony_id || ann.COLONY_ID || ann.id || ann.ID || ann.no_colony || (index + 1);
        
        row.innerHTML = `
          <td><strong>${colonyId}</strong></td>
          <td style="display: none;">${ann.geometry.type || 'Polygon'}</td>
          <td class="editable" data-field="site" data-index="${index}">${ann.site || '-'}</td>
          <td class="editable" data-field="spcode" data-index="${index}">${ann.spcode || ann.species_code || ann.SPCODE || ann.SPECIES_CODE || '-'}</td>
          <td class="editable" data-field="juvenile" data-index="${index}">${ann.juvenile == -1 ? 'Yes' : (ann.juvenile == 0 ? 'No' : '-')}</td>
          <td class="editable" data-field="juv_substrate" data-index="${index}">${ann.juv_substrate || '-'}</td>
          <td class="editable" data-field="analyst" data-index="${index}" style="display: none;">${ann.analyst || '-'}</td>
          <td class="editable" data-field="obs_year" data-index="${index}" style="display: none;">${ann.obs_year || '-'}</td>
          <td class="editable" data-field="mission_id" data-index="${index}" style="display: none;">${ann.mission_id || '-'}</td>
          <td class="editable" data-field="segment" data-index="${index}">${ann.segment || '-'}</td>
          <td class="editable" data-field="transect" data-index="${index}">${ann.transect || '-'}</td>
          <td class="editable" data-field="morph_code" data-index="${index}">${ann.morph_code || '-'}</td>
          <td class="editable" data-field="old_dead" data-index="${index}" style="display: none;">${ann.old_dead !== undefined ? ann.old_dead + '%' : '-'}</td>
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
      } else if (field === 'old_dead') {
        // Number input for percentage
        inputElement = document.createElement('input');
        inputElement.type = 'number';
        inputElement.min = '0';
        inputElement.max = '100';
        inputElement.value = currentValue;
      } else {
        // Text input for other fields
        inputElement = document.createElement('input');
        inputElement.type = 'text';
        inputElement.value = currentValue;
        
        // Set max length for specific fields
        if (field === 'analyst' || field === 'spcode') {
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
      
      // Save function
      const saveEdit = () => {
        let newValue = inputElement.value.trim();
        
        // Convert empty string to appropriate default
        if (newValue === '' || newValue === '-') {
          newValue = '';
        }
        
        // Convert to number for numeric fields
        if (field === 'obs_year' || field === 'old_dead' || field === 'segment' || field === 'juvenile') {
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
        
        // Remove editing class
        cell.classList.remove('editing');
        
        // Update cell display
        if (field === 'old_dead' && newValue !== '') {
          cell.textContent = newValue + '%';
        } else if (field === 'juvenile') {
          cell.textContent = newValue == -1 ? 'Yes' : (newValue == 0 ? 'No' : '-');
        } else if (newValue === '') {
          cell.textContent = '-';
        } else {
          cell.textContent = newValue;
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
      
      // Save function
      const saveTableEdit = () => {
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
      
      // Build the form HTML
      const formHTML = `
        <div class="modal-form-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; max-height: 60vh; overflow-y: auto;">
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Analyst *</label>
            <input type="text" id="edit_analyst" value="${annotation.analyst || ''}" maxlength="10" required style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Year *</label>
            <input type="number" id="edit_obs_year" value="${annotation.obs_year || ''}" min="2000" max="2100" required style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Mission ID *</label>
            <input type="text" id="edit_mission_id" value="${annotation.mission_id || ''}" required style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Site *</label>
            <input type="text" id="edit_site" value="${annotation.site || ''}" required style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Transect</label>
            <select id="edit_transect" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
              <option value="">-</option>
              <option value="A" ${annotation.transect === 'A' ? 'selected' : ''}>A</option>
              <option value="B" ${annotation.transect === 'B' ? 'selected' : ''}>B</option>
            </select>
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Segment</label>
            <select id="edit_segment" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
              <option value="">-</option>
              <option value="0" ${annotation.segment == 0 ? 'selected' : ''}>0</option>
              <option value="5" ${annotation.segment == 5 ? 'selected' : ''}>5</option>
              <option value="10" ${annotation.segment == 10 ? 'selected' : ''}>10</option>
              <option value="15" ${annotation.segment == 15 ? 'selected' : ''}>15</option>
            </select>
          </div>
          <div class="modal-form-field" style="position: relative;">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Species Code</label>
            <input type="text" id="edit_spcode" value="${annotation.spcode || ''}" maxlength="10" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" autocomplete="off" />
            <div id="edit-species-autocomplete" class="species-autocomplete-dropdown" style="position: absolute; z-index: 10000; display: none; background: white; border: 1px solid #ddd; border-radius: 4px; max-height: 200px; overflow-y: auto; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,0.15);"></div>
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Morphology Code</label>
            <select id="edit_morph_code" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
              <option value="">-</option>
              <option value="BR" ${annotation.morph_code === 'BR' ? 'selected' : ''}>BR - Branching</option>
              <option value="CO" ${annotation.morph_code === 'CO' ? 'selected' : ''}>CO - Columnar</option>
              <option value="EN" ${annotation.morph_code === 'EN' ? 'selected' : ''}>EN - Encrusting</option>
              <option value="FO" ${annotation.morph_code === 'FO' ? 'selected' : ''}>FO - Foliaceous</option>
              <option value="FL" ${annotation.morph_code === 'FL' ? 'selected' : ''}>FL - Free-living</option>
              <option value="LA" ${annotation.morph_code === 'LA' ? 'selected' : ''}>LA - Laminar</option>
              <option value="MD" ${annotation.morph_code === 'MD' ? 'selected' : ''}>MD - Mounding</option>
              <option value="MA" ${annotation.morph_code === 'MA' ? 'selected' : ''}>MA - Massive</option>
              <option value="PL" ${annotation.morph_code === 'PL' ? 'selected' : ''}>PL - Plating</option>
              <option value="SM" ${annotation.morph_code === 'SM' ? 'selected' : ''}>SM - Submassive</option>
              <option value="SO" ${annotation.morph_code === 'SO' ? 'selected' : ''}>SO - Solitary</option>
              <option value="TB" ${annotation.morph_code === 'TB' ? 'selected' : ''}>TB - Tabular</option>
            </select>
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Old Dead %</label>
            <input type="number" id="edit_old_dead" value="${annotation.old_dead || ''}" min="0" max="100" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Juvenile</label>
            <input type="number" id="edit_juvenile" value="${annotation.juvenile || 0}" min="0" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">JUV_SUBSTRATE</label>
            <input type="text" id="edit_juv_substrate" value="${annotation.juv_substrate || ''}" maxlength="50" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
          </div>
          <div class="modal-form-field">
            <label style="font-weight: bold; display: block; margin-bottom: 5px;">Remnant</label>
            <input type="number" id="edit_remnant" value="${annotation.remnant || 0}" min="0" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
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
      
      // Update annotation with form values
      annotation.analyst = document.getElementById('edit_analyst').value;
      annotation.obs_year = parseInt(document.getElementById('edit_obs_year').value);
      annotation.mission_id = document.getElementById('edit_mission_id').value;
      annotation.site = document.getElementById('edit_site').value;
      annotation.transect = document.getElementById('edit_transect').value;
      annotation.segment = document.getElementById('edit_segment').value;
      annotation.spcode = document.getElementById('edit_spcode').value;
      annotation.morph_code = document.getElementById('edit_morph_code').value;
      annotation.old_dead = document.getElementById('edit_old_dead').value;
      annotation.juvenile = parseInt(document.getElementById('edit_juvenile').value) || 0;
      annotation.juv_substrate = document.getElementById('edit_juv_substrate').value;
      annotation.remnant = parseInt(document.getElementById('edit_remnant').value) || 0;
      
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
      
      // Update the annotation table
      updateAnnotationTable();
      
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
      
      // Disable editing
      if (layerToSave.editing) {
        layerToSave.editing.disable();
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
      
      // Disable editing without saving
      if (currentEditingLayer.editing) {
        currentEditingLayer.editing.disable();
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
    
    function deleteAnnotation(index) {
      if (!confirm('Delete this annotation?')) return;
      
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
      
      // Remove from annotations array
      annotations.splice(index, 1);
      
      // Update table
      updateAnnotationTable();
      
      showStatus('🗑️ Annotation deleted', 'success');
      hasUnsavedChanges = true;
      if (isOracleProjectMode()) setAutoSaveBadge('pending', '🔵 Unsaved changes');
    }
    
    // Auto-save logic extracted to js/annotation-runtime-autosave.js
