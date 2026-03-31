// Extracted from annotation-file-mode-runtime.js (Phase 2f: inputs/autocomplete/onload)
    function initSpeciesAutocomplete() {
      const input = document.getElementById('spcode');
      const dropdown = document.getElementById('species-autocomplete');
      
      if (!input || !dropdown) return;
      
      // Handle focus - position dropdown
      input.addEventListener('focus', function() {
        if (dropdown.classList.contains('active')) {
          positionDropdown();
        }
      });
      
      // Reposition on scroll
      const formContainer = document.querySelector('.form-container');
      if (formContainer) {
        formContainer.addEventListener('scroll', function() {
          if (dropdown.classList.contains('active')) {
            positionDropdown();
          }
        });
      }
      
      // Handle input typing
      input.addEventListener('input', function(e) {
        const query = e.target.value.trim();
        
        // Clear previous timeout
        if (autocompleteTimeout) {
          clearTimeout(autocompleteTimeout);
        }
        
        // Hide dropdown if query is too short
        if (query.length < 2) {
          dropdown.classList.remove('active');
          return;
        }
        
        // Show loading
        dropdown.innerHTML = '<div class="autocomplete-loading">Searching...</div>';
        positionDropdown();
        dropdown.classList.add('active');
        
        // Debounce the search
        autocompleteTimeout = setTimeout(() => {
          searchSpecies(query);
        }, 300);
      });
      
      // Handle keyboard navigation
      input.addEventListener('keydown', function(e) {
        if (!dropdown.classList.contains('active')) return;
        
        const items = dropdown.querySelectorAll('.autocomplete-item');
        
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          autocompleteSelectedIndex = Math.min(autocompleteSelectedIndex + 1, items.length - 1);
          updateAutocompleteSelection(items);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          autocompleteSelectedIndex = Math.max(autocompleteSelectedIndex - 1, -1);
          updateAutocompleteSelection(items);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          // Select the highlighted item on Enter or Tab
          if (autocompleteSelectedIndex >= 0 && autocompleteSelectedIndex < autocompleteResults.length) {
            e.preventDefault();
            selectSpecies(autocompleteResults[autocompleteSelectedIndex]);
          }
        } else if (e.key === 'Escape') {
          dropdown.classList.remove('active');
          autocompleteSelectedIndex = -1;
        }
      });
      
      // Close dropdown when clicking outside
      document.addEventListener('click', function(e) {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
          dropdown.classList.remove('active');
          autocompleteSelectedIndex = -1;
        }
      });
    }
    
    function positionDropdown() {
      const input = document.getElementById('spcode');
      const dropdown = document.getElementById('species-autocomplete');
      
      if (!input || !dropdown) return;
      
      const rect = input.getBoundingClientRect();
      dropdown.style.top = `${rect.bottom}px`;
      dropdown.style.left = `${rect.left}px`;
      dropdown.style.width = `${Math.max(rect.width, 200)}px`;
    }
    
    function searchSpecies(query) {
      const dropdown = document.getElementById('species-autocomplete');
      
      fetch(`/api/coral/species/search?q=${encodeURIComponent(query)}&limit=10`)
        .then(res => res.json())
        .then(data => {
          autocompleteResults = data.results || [];
          
          if (autocompleteResults.length === 0) {
            autocompleteSelectedIndex = -1;
            dropdown.innerHTML = '<div class="autocomplete-empty">No species found</div>';
          } else {
            // Auto-select first item
            autocompleteSelectedIndex = 0;
            
            dropdown.innerHTML = autocompleteResults.map((species, index) => `
              <div class="autocomplete-item ${index === 0 ? 'selected' : ''}" data-index="${index}" onclick="selectSpeciesByIndex(${index})">
                <div class="autocomplete-code">${species.code}</div>
                <div class="autocomplete-name">${species.taxon_name || species.genus}</div>
                ${species.scientific_name ? `<div class="autocomplete-sci">${species.scientific_name}</div>` : ''}
              </div>
            `).join('');
          }
          
          positionDropdown();
          dropdown.classList.add('active');
        })
        .catch(err => {
          console.error('Species search error:', err);
          dropdown.innerHTML = '<div class="autocomplete-empty">Search failed</div>';
        });
    }
    
    function updateAutocompleteSelection(items) {
      items.forEach((item, index) => {
        if (index === autocompleteSelectedIndex) {
          item.classList.add('selected');
          item.scrollIntoView({ block: 'nearest' });
        } else {
          item.classList.remove('selected');
        }
      });
    }
    
    function selectSpeciesByIndex(index) {
      if (index >= 0 && index < autocompleteResults.length) {
        selectSpecies(autocompleteResults[index]);
      }
    }
    
    function selectSpecies(species) {
      const input = document.getElementById('spcode');
      const dropdown = document.getElementById('species-autocomplete');
      
      // Set the species code
      input.value = species.code;
      
      // Close dropdown
      dropdown.classList.remove('active');
      autocompleteSelectedIndex = -1;
      
      // Log selection
      console.log('✅ Selected species:', species.code, '-', species.taxon_name);
      
      // Focus next field (morphology)
      const morphField = document.getElementById('morph_code');
      if (morphField) {
        morphField.focus();
      }
    }
    
    // =========================================================================
    // JUV_SUBSTRATE AUTOCOMPLETE
    // =========================================================================
    
    const JUV_SUBSTRATE_OPTIONS = [
      'CCAH', 'CCAR', 'TURFH', 'TURFR', 'EMA', 'PESP', 'LOBO', 'HARD', 'CORAL', 'RUB', 'HALI'
    ];
    
    let juvSubstrateAutocompleteTimeout = null;
    let juvSubstrateAutocompleteSelectedIndex = -1;
    let juvSubstrateAutocompleteResults = [];
    
    function initJuvSubstrateAutocomplete() {
      const input = document.getElementById('juv_substrate');
      const dropdown = document.getElementById('juv-substrate-autocomplete');
      
      if (!input || !dropdown) return;
      
      // Handle focus - position dropdown
      input.addEventListener('focus', function() {
        if (dropdown.classList.contains('active')) {
          positionJuvSubstrateDropdown();
        }
      });
      
      // Reposition on scroll
      const formContainer = document.querySelector('.form-container');
      if (formContainer) {
        formContainer.addEventListener('scroll', function() {
          if (dropdown.classList.contains('active')) {
            positionJuvSubstrateDropdown();
          }
        });
      }
      
      // Handle input typing
      input.addEventListener('input', function(e) {
        const query = e.target.value.trim().toUpperCase();
        
        // Clear previous timeout
        if (juvSubstrateAutocompleteTimeout) {
          clearTimeout(juvSubstrateAutocompleteTimeout);
        }
        
        // Hide dropdown if query is empty
        if (query.length === 0) {
          dropdown.classList.remove('active');
          return;
        }
        
        // Show loading
        dropdown.innerHTML = '<div class="autocomplete-loading">Searching...</div>';
        positionJuvSubstrateDropdown();
        dropdown.classList.add('active');
        
        // Debounce the search
        juvSubstrateAutocompleteTimeout = setTimeout(() => {
          searchJuvSubstrate(query);
        }, 200);
      });
      
      // Handle keyboard navigation
      input.addEventListener('keydown', function(e) {
        if (!dropdown.classList.contains('active')) return;
        
        const items = dropdown.querySelectorAll('.autocomplete-item');
        
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          juvSubstrateAutocompleteSelectedIndex = Math.min(juvSubstrateAutocompleteSelectedIndex + 1, items.length - 1);
          updateJuvSubstrateAutocompleteSelection(items);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          juvSubstrateAutocompleteSelectedIndex = Math.max(juvSubstrateAutocompleteSelectedIndex - 1, -1);
          updateJuvSubstrateAutocompleteSelection(items);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          // Select the highlighted item on Enter or Tab
          if (juvSubstrateAutocompleteSelectedIndex >= 0 && juvSubstrateAutocompleteSelectedIndex < juvSubstrateAutocompleteResults.length) {
            e.preventDefault();
            selectJuvSubstrate(juvSubstrateAutocompleteResults[juvSubstrateAutocompleteSelectedIndex]);
          }
        } else if (e.key === 'Escape') {
          dropdown.classList.remove('active');
          juvSubstrateAutocompleteSelectedIndex = -1;
        }
      });
      
      // Close dropdown when clicking outside
      document.addEventListener('click', function(e) {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
          dropdown.classList.remove('active');
          juvSubstrateAutocompleteSelectedIndex = -1;
        }
      });
    }
    
    function positionJuvSubstrateDropdown() {
      const input = document.getElementById('juv_substrate');
      const dropdown = document.getElementById('juv-substrate-autocomplete');
      
      if (!input || !dropdown) return;
      
      const rect = input.getBoundingClientRect();
      dropdown.style.top = `${rect.bottom}px`;
      dropdown.style.left = `${rect.left}px`;
      dropdown.style.width = `${Math.max(rect.width, 200)}px`;
    }
    
    function searchJuvSubstrate(query) {
      const dropdown = document.getElementById('juv-substrate-autocomplete');
      
      // Filter options based on query
      juvSubstrateAutocompleteResults = JUV_SUBSTRATE_OPTIONS.filter(option => 
        option.includes(query)
      );
      
      if (juvSubstrateAutocompleteResults.length === 0) {
        juvSubstrateAutocompleteSelectedIndex = -1;
        dropdown.innerHTML = '<div class="autocomplete-empty">No substrate found</div>';
      } else {
        // Auto-select first item
        juvSubstrateAutocompleteSelectedIndex = 0;
        
        dropdown.innerHTML = juvSubstrateAutocompleteResults.map((substrate, index) => `
          <div class="autocomplete-item ${index === 0 ? 'selected' : ''}" data-index="${index}" onclick="selectJuvSubstrateByIndex(${index})">
            <div class="autocomplete-code">${substrate}</div>
          </div>
        `).join('');
      }
      
      positionJuvSubstrateDropdown();
      dropdown.classList.add('active');
    }
    
    function updateJuvSubstrateAutocompleteSelection(items) {
      items.forEach((item, index) => {
        if (index === juvSubstrateAutocompleteSelectedIndex) {
          item.classList.add('selected');
          item.scrollIntoView({ block: 'nearest' });
        } else {
          item.classList.remove('selected');
        }
      });
    }
    
    function selectJuvSubstrateByIndex(index) {
      if (index >= 0 && index < juvSubstrateAutocompleteResults.length) {
        selectJuvSubstrate(juvSubstrateAutocompleteResults[index]);
      }
    }
    
    function selectJuvSubstrate(substrate) {
      const input = document.getElementById('juv_substrate');
      const dropdown = document.getElementById('juv-substrate-autocomplete');
      
      // Set the substrate value
      input.value = substrate;
      
      // Close dropdown
      dropdown.classList.remove('active');
      juvSubstrateAutocompleteSelectedIndex = -1;
      
      // Log selection
      console.log('✅ Selected JUV_SUBSTRATE:', substrate);
      
      // Focus next field (remnant)
      const remnantField = document.getElementById('remnant');
      if (remnantField) {
        remnantField.focus();
      }
    }
    
    // =========================================================================
    
    window.onload = function() {
      // Initialize species autocomplete
      initSpeciesAutocomplete();
      
      // Initialize JUV_SUBSTRATE autocomplete
      initJuvSubstrateAutocomplete();
      
      // Auto-fill analyst name from logged-in user
      fetchCurrentUser();
      
      // Start with all layer details collapsed except orthomosaic (most commonly used)
      ['demDetails', 'annotationsDetails'].forEach(id => {
        const details = document.getElementById(id);
        const icon = document.getElementById(id + 'Icon');
        if (details && icon) {
          details.classList.add('collapsed');
          icon.textContent = '▶';
        }
      });
      // Note: shapefile layers are collapsed by default when created dynamically
      
      // Check if site was selected (database mode) - skip for file-based mode
      const siteDataStr = sessionStorage.getItem('selectedSite');
      if (siteDataStr && !currentProject) {
        selectedSiteData = JSON.parse(siteDataStr);
        
        // Auto-populate form fields
        if (selectedSiteData.SITE_NAME) {
          const siteField = document.getElementById('site');
          siteField.value = selectedSiteData.SITE_NAME;
          markFieldAsAutofilled(siteField);
        }

        // Fetch and use visit data from the database
        if (selectedSiteData.SITE_NAME) {
          fetch(`${serverUrl}/api/sites/${selectedSiteData.SITE_NAME}/visits`)
            .then(res => res.json())
            .then(data => {
              console.log('📡 Site visit API response:', data);
              
              if (data.visits && data.visits.length > 0) {
                const visit = data.visits[0]; // Use most recent visit
                console.log('📋 Visit data:', visit);
                console.log('🔍 CRUISE_LEG value:', visit.CRUISE_LEG, 'Type:', typeof visit.CRUISE_LEG);
                console.log('🔍 MISSION_ID value:', visit.MISSION_ID, 'Type:', typeof visit.MISSION_ID);
                
                // Pre-populate mission_id from cruise (CRUISE_LEG or MISSION_ID)
                const missionField = document.getElementById('mission_id');
                if (visit.CRUISE_LEG && visit.CRUISE_LEG.trim() !== '') {
                  missionField.value = visit.CRUISE_LEG;
                  markFieldAsAutofilled(missionField);
                  console.log('✅ Auto-filled Cruise/Mission ID:', visit.CRUISE_LEG);
                } else if (visit.MISSION_ID && visit.MISSION_ID.trim() !== '') {
                  missionField.value = visit.MISSION_ID;
                  markFieldAsAutofilled(missionField);
                  console.log('✅ Auto-filled Mission ID:', visit.MISSION_ID);
                } else {
                  console.log('⚠️ No CRUISE_LEG or MISSION_ID found in visit data');
                }
                
                // Pre-populate year from survey date
                const yearField = document.getElementById('obs_year');
                if (visit.SURVEY_DATE) {
                  const yearMatch = visit.SURVEY_DATE.match(/(\d{4})/);
                  if (yearMatch) {
                    yearField.value = yearMatch[1];
                    markFieldAsAutofilled(yearField);
                    console.log('✅ Auto-filled Year from survey date:', yearMatch[1]);
                  }
                } else if (visit.OBS_YEAR) {
                  yearField.value = visit.OBS_YEAR;
                  markFieldAsAutofilled(yearField);
                  console.log('✅ Auto-filled Year:', visit.OBS_YEAR);
                }
                
                // Store visit data for use in annotations
                selectedSiteData.visitData = visit;
                
                // Update site badges
                document.getElementById('currentSiteName').textContent = selectedSiteData.SITE_NAME;
                document.getElementById('mapLayersSiteBadge').textContent = selectedSiteData.SITE_NAME;
                
                // Log what data was found
                console.log('📊 Site visit data loaded:', {
                  site: selectedSiteData.SITE_NAME,
                  cruise: visit.CRUISE_LEG || visit.MISSION_ID,
                  year: visit.OBS_YEAR,
                  survey_date: visit.SURVEY_DATE
                });
              } else {
                console.log('⚠️ No visit data found for site:', selectedSiteData.SITE_NAME);
              }
            })
            .catch(err => {
              console.warn('Could not load visit data:', err);
              // Fallback: Set current year
              document.getElementById('obs_year').value = new Date().getFullYear();
            });
        } else {
          // Fallback: Set current year
          document.getElementById('obs_year').value = new Date().getFullYear();
        }
        
        // Load the specific COG for this site
        if (selectedSiteData.ORTHO_FILE) {
          currentCOG = selectedSiteData.ORTHO_FILE;
          
          // Set the COG in dropdown
          loadCOGList().then(() => {
            const select = document.getElementById('cogSelect');
            for (let i = 0; i < select.options.length; i++) {
              if (select.options[i].value === selectedSiteData.ORTHO_FILE) {
                select.selectedIndex = i;
                break;
              }
            }
            loadSelectedCOG();
          });
          
          // Show basic site info if no visit data was loaded
          if (!selectedSiteData.visitData) {
            // Update site badges
            document.getElementById('currentSiteName').textContent = selectedSiteData.SITE_NAME;
            document.getElementById('mapLayersSiteBadge').textContent = selectedSiteData.SITE_NAME;
          }
        } else {
          loadCOGList();
        }
        
        // Load shapefile overlays if available
        console.log('🗺️ Site shapefile data:', selectedSiteData.SHAPEFILE_GEOJSON);
        
        if (selectedSiteData.SHAPEFILE_GEOJSON) {
          // Check if it's array format (multiple layers) or single geojson
          if (Array.isArray(selectedSiteData.SHAPEFILE_GEOJSON)) {
            // New format: array of {name, geojson} objects
            console.log(`✓ Loading ${selectedSiteData.SHAPEFILE_GEOJSON.length} shapefile layers`);
            selectedSiteData.SHAPEFILE_GEOJSON.forEach(shpData => {
              console.log(`  - Loading layer: ${shpData.name}`);
              if (shpData.geojson && shpData.name) {
                loadShapefileOverlay(shpData.geojson, shpData.name);
              }
            });
          } else if (selectedSiteData.SHAPEFILE_GEOJSON.type === 'FeatureCollection') {
            // Old format: single geojson FeatureCollection
            console.log('✓ Loading single shapefile (old format)');
            loadShapefileOverlay(selectedSiteData.SHAPEFILE_GEOJSON, 'Shapefile');
          }
        } else {
          console.log('ℹ️ No shapefiles to load for this site');
        }
      } else if (!currentProject) {
        // No site selected in database mode - but OK for file mode
        console.log('ℹ️ No site selected - waiting for project upload in file mode');
        // Don't redirect - user will upload a project file
      }
    };
    
    // Load shapefile overlay on map (supports multiple named layers)
    function loadShapefileOverlay(geojson, layerName = 'Shapefile') {
      try {
        const safeLayerName = layerName.replace(/[^a-zA-Z0-9_-]/g, '_');
        
        // Remove existing layer with same name if any
        if (shapefileLayers[safeLayerName]) {
          map.removeLayer(shapefileLayers[safeLayerName].layer);
        }
        
        // Shapefile pane is already created at map initialization
        // Just ensure it exists and has correct z-index
        if (!map.getPane('shapefilePane')) {
          map.createPane('shapefilePane');
          map.getPane('shapefilePane').style.zIndex = 450;
        }
        
        // Get opacity (use 90% default if control doesn't exist yet)
        let opacity = 0.9;
        const opacityControl = document.getElementById(`shapefileOpacity_${safeLayerName}`);
        if (opacityControl) {
          opacity = opacityControl.value / 100;
        }
        
        // Assign different colors to different layers for visual distinction
        const colors = ['#ff7800', '#00ff88', '#ff00ff', '#00ccff', '#ffff00', '#ff0088'];
        const colorIndex = Object.keys(shapefileLayers).length % colors.length;
        
        const layer = L.geoJSON(geojson, {
          pane: 'shapefilePane',
          style: {
            color: colors[colorIndex],
            weight: 3,
            opacity: opacity,
            fillOpacity: opacity * 0.15,
            dashArray: '10, 5',
            lineCap: 'round'
          },
          interactive: true,
          onEachFeature: function(feature, layer) {
            if (feature.properties) {
              let popup = `<strong>${layerName}</strong><br>`;
              for (let key in feature.properties) {
                popup += `<b>${key}:</b> ${feature.properties[key]}<br>`;
              }
              layer.bindPopup(popup);
            }
          }
        }).addTo(map);
        
        // Store layer data
        shapefileLayers[safeLayerName] = {
          layer: layer,
          geojson: geojson,
          name: layerName
        };
        
        // Add UI control for this layer
        addShapefileLayerControl(layerName);
        
        const featureCount = Object.keys(layer._layers).length;
        console.log(`✓ Loaded shapefile layer: ${layerName} (${featureCount} features)`);
        
        // Only check bounds if there are features
        if (featureCount > 0) {
          const bounds = layer.getBounds();
          if (bounds) {
            console.log('Shapefile coordinate details:');
            console.log('  SW corner:', bounds.getSouthWest().toString());
            console.log('  NE corner:', bounds.getNorthEast().toString());
            console.log('  Center:', bounds.getCenter().toString());
            
            // Check if coordinates look like lat/lng (should be -180 to 180, -90 to 90)
            const center = bounds.getCenter();
            if (Math.abs(center.lng) > 180 || Math.abs(center.lat) > 90) {
              console.error(`⚠️ CRS MISMATCH in ${layerName}!`);
              console.error('Coordinates are NOT in WGS84 lat/lng format');
              console.error('Shapefile might be in UTM or other projected CRS');
            }
            
            // Auto-zoom to site on page load
            setTimeout(() => {
              zoomToSite();
              console.log('🎯 Auto-zoomed to site on page load');
            }, 500);
          }
        } else {
          console.warn(`⚠️ Shapefile layer "${layerName}" has no features (may have been skipped due to data errors)`);
        }
        
      } catch (error) {
        console.error(`Error loading shapefile overlay ${layerName}:`, error);
      }
    }
