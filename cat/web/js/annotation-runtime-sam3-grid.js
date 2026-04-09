// Extracted from annotation-file-mode-runtime.js (Phase 2h: sam3 grid)
    async function runSAM3SmartGrid(layer) {
      try {
        showLoading(true);
        showStatus('🎯 Smart Grid: Analyzing area...', 'info');
        
        // Load SAM3 model
        const loadResponse = await fetch(`${serverUrl}/api/sam/load-model`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_size: sam3ModelSize })
        });
        
        if (!loadResponse.ok) {
          throw new Error('Failed to load SAM3 model');
        }
        
        // Get rectangle bounds
        const bounds = layer.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        
        // Get map info
        const mapBounds = map.getBounds();
        const mapSize = map.getSize();
        
        // Capture map image once
        showStatus('📸 Capturing map...', 'info');
        const mapContainer = map.getContainer();
        const mapCanvas = await html2canvas(mapContainer, {
          useCORS: true,
          allowTaint: true,
          logging: false,
          width: mapSize.x,
          height: mapSize.y
        });
        
        const imageData = mapCanvas.toDataURL('image/png');
        
        // Convert bounds to pixel coordinates
        const swPoint = map.latLngToContainerPoint(sw);
        const nePoint = map.latLngToContainerPoint(ne);
        
        const boxX1 = Math.min(swPoint.x, nePoint.x);
        const boxY1 = Math.min(swPoint.y, nePoint.y);
        const boxX2 = Math.max(swPoint.x, nePoint.x);
        const boxY2 = Math.max(swPoint.y, nePoint.y);
        
        const boxWidth = boxX2 - boxX1;
        const boxHeight = boxY2 - boxY1;
        const boxArea = boxWidth * boxHeight;
        
        // 1. ADAPTIVE GRID DENSITY: Use selected density or auto-adapt
        const densitySetting = document.getElementById('sam3GridDensity')?.value || 'auto';
        let gridSize;
        let isMultiPass = false;
        let multiPassSizes = [];
        
        if (densitySetting === 'multipass') {
          // Multi-Pass Mode: Coarse pass (10x10) for large corals, then fine pass (25x25) for small ones
          isMultiPass = true;
          multiPassSizes = [10, 25];
          console.log(`🎯 Multi-Pass Mode: First ${multiPassSizes[0]}×${multiPassSizes[0]} (large items), then ${multiPassSizes[1]}×${multiPassSizes[1]} (small items)`);
        } else if (densitySetting === 'auto') {
          // Adaptive based on box area
          if (boxArea < 40000) {
            gridSize = 3; // Small box: 3x3 = 9 points
          } else if (boxArea < 100000) {
            gridSize = 5; // Medium box: 5x5 = 25 points
          } else if (boxArea < 200000) {
            gridSize = 7; // Large box: 7x7 = 49 points
          } else {
            gridSize = 10; // Extra-large box: 10x10 = 100 points
          }
          console.log(`📐 Box area: ${boxArea.toFixed(0)} px², auto-selected ${gridSize}x${gridSize} grid`);
        } else {
          // Use manually selected density
          gridSize = parseInt(densitySetting);
          console.log(`📐 Manual grid density: ${gridSize}x${gridSize} grid (${gridSize * gridSize} points)`);
        }
        
        if (!isMultiPass) {
          console.log(`🎯 Processing ${gridSize * gridSize} sample points...`);
        }
        
        // Generate grid of sample points (handles both single-pass and multi-pass)
        let allPassPoints = [];
        
        if (isMultiPass) {
          // Multi-Pass: Generate grids for each pass with different sizes
          for (let passIdx = 0; passIdx < multiPassSizes.length; passIdx++) {
            const passGridSize = multiPassSizes[passIdx];
            const passPoints = [];
            
            for (let row = 0; row < passGridSize; row++) {
              for (let col = 0; col < passGridSize; col++) {
                const px = boxX1 + (boxWidth / (passGridSize + 1)) * (col + 1);
                const py = boxY1 + (boxHeight / (passGridSize + 1)) * (row + 1);
                passPoints.push({ 
                  x: Math.round(px), 
                  y: Math.round(py),
                  pass: passIdx + 1,
                  passName: passIdx === 0 ? 'large' : 'small'
                });
              }
            }
            allPassPoints.push({
              pass: passIdx + 1,
              size: passGridSize,
              points: passPoints,
              name: passIdx === 0 ? 'Large Coral Pass' : 'Small Coral Pass'
            });
          }
          
          const totalPoints = allPassPoints.reduce((sum, p) => sum + p.points.length, 0);
          console.log(`🎯 Multi-Pass: ${totalPoints} total points (${multiPassSizes[0]}×${multiPassSizes[0]}=${multiPassSizes[0]*multiPassSizes[0]} + ${multiPassSizes[1]}×${multiPassSizes[1]}=${multiPassSizes[1]*multiPassSizes[1]})`);
          showStatus(`🎯 Multi-Pass: ${totalPoints} points in ${allPassPoints.length} passes...`, 'info');
        } else {
          // Single-pass: Generate one grid
          const samplePoints = [];
          
          for (let row = 0; row < gridSize; row++) {
            for (let col = 0; col < gridSize; col++) {
              const px = boxX1 + (boxWidth / (gridSize + 1)) * (col + 1);
              const py = boxY1 + (boxHeight / (gridSize + 1)) * (row + 1);
              samplePoints.push({ x: Math.round(px), y: Math.round(py) });
            }
          }
          
          allPassPoints = [{
            pass: 1,
            size: gridSize,
            points: samplePoints,
            name: 'Single Pass'
          }];
          
          console.log(`🎯 Smart Grid: Testing ${samplePoints.length} sample points`);
          showStatus(`🎯 Processing ${samplePoints.length} points...`, 'info');
        }
        
        // 5. PROGRESS VISUALIZATION: Create marker layer for dots
        const progressMarkers = L.layerGroup().addTo(map);
        
        // Process points in batches for parallel processing
        const allPolygons = [];
        let successCount = 0;
        let skippedLowConf = 0;
        let skippedTooLarge = 0;
        let skippedTooSmall = 0;
        let skippedDuplicate = 0;
        
        // 7. BATCH PROCESSING: Process 5 points at a time
        const batchSize = 5;
        
        // Process each pass sequentially
        for (let passInfo of allPassPoints) {
          const samplePoints = passInfo.points;
          const passName = passInfo.name;
          
          if (isMultiPass) {
            console.log(`\n🎯 Starting ${passName} (${passInfo.size}×${passInfo.size} = ${samplePoints.length} points)`);
            showStatus(`🎯 ${passName}: ${samplePoints.length} points...`, 'info');
          }
          
          for (let batchStart = 0; batchStart < samplePoints.length; batchStart += batchSize) {
            const batch = samplePoints.slice(batchStart, Math.min(batchStart + batchSize, samplePoints.length));
            
            const statusMsg = isMultiPass 
              ? `🎯 ${passName}: ${batchStart + 1}-${Math.min(batchStart + batchSize, samplePoints.length)}/${samplePoints.length}...`
              : `🎯 Points ${batchStart + 1}-${Math.min(batchStart + batchSize, samplePoints.length)}/${samplePoints.length}...`;
            
            showStatus(statusMsg, 'info');
          
          // Process batch in parallel
          const batchPromises = batch.map(async (point, idx) => {
            const globalIdx = batchStart + idx;
            
            try {
              const response = await fetch(`${serverUrl}/api/sam/click-segment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  image_data: imageData,
                  click_x: point.x,
                  click_y: point.y,
                  return_polygon: true,
                  confidence_threshold: sam3ConfidenceThreshold
                })
              });
              
              if (response.ok) {
                const data = await response.json();
                
                // 5. PROGRESS VISUALIZATION: Show red dot for tested point
                const dotLatLng = map.containerPointToLatLng([point.x, point.y]);
                
                if (data.success && data.polygon) {
                  // 2. CONFIDENCE-BASED FILTERING
                  if (data.confidence < 0.70) {
                    console.warn(`Point ${globalIdx}: Low confidence (${(data.confidence * 100).toFixed(1)}%), skipping`);
                    L.circleMarker(dotLatLng, { radius: 3, color: 'orange', fillOpacity: 0.7 }).addTo(progressMarkers);
                    return { skippedLowConf: true };
                  }
                  
                  // Calculate polygon area
                  const polyArea = calculatePolygonArea(data.polygon);
                  const areaRatio = polyArea / boxArea;
                  
                  // 8. SIZE RANGE FILTER: Too large
                  if (areaRatio > 0.6) {
                    console.warn(`Point ${globalIdx}: Mask too large (${(areaRatio * 100).toFixed(1)}% of box), skipping`);
                    L.circleMarker(dotLatLng, { radius: 3, color: 'red', fillOpacity: 0.7 }).addTo(progressMarkers);
                    return { skippedTooLarge: true };
                  }
                  
                  // 8. SIZE RANGE FILTER: Too small (noise)
                  if (polyArea < 50) {
                    console.warn(`Point ${globalIdx}: Mask too small (${polyArea.toFixed(0)} px²), skipping`);
                    L.circleMarker(dotLatLng, { radius: 3, color: 'gray', fillOpacity: 0.7 }).addTo(progressMarkers);
                    return { skippedTooSmall: true };
                  }
                  
                  // Valid coral found!
                  L.circleMarker(dotLatLng, { radius: 4, color: 'green', fillOpacity: 0.8 }).addTo(progressMarkers);
                  
                  return {
                    polygon: data.polygon,
                    confidence: data.confidence,
                    point: point,
                    area: polyArea,
                    success: true
                  };
                } else {
                  // No detection
                  L.circleMarker(dotLatLng, { radius: 3, color: 'red', fillOpacity: 0.7 }).addTo(progressMarkers);
                }
              }
            } catch (err) {
              console.warn(`Point ${globalIdx} failed:`, err);
            }
            
            return null;
          });
          
          const batchResults = await Promise.all(batchPromises);
          
          // Collect results
          for (const result of batchResults) {
            if (result) {
              if (result.success) {
                allPolygons.push(result);
                successCount++;
              } else if (result.skippedLowConf) skippedLowConf++;
              else if (result.skippedTooLarge) skippedTooLarge++;
              else if (result.skippedTooSmall) skippedTooSmall++;
            }
          }
        }
        
        // End of pass processing
        if (isMultiPass) {
          console.log(`✅ ${passName} complete: ${allPolygons.length} detections so far`);
        }
      }
        
        console.log(`✅ ${successCount} segments, skipped: ${skippedLowConf} low-conf, ${skippedTooLarge} too-large, ${skippedTooSmall} too-small`);
        
        if (allPolygons.length === 0) {
          showStatus('⚠️ No corals found in area', 'warning');
          showLoading(false);
          drawnItems.removeLayer(layer);
          setTimeout(() => progressMarkers.remove(), 3000);
          return;
        }
        
        // 3. BETTER OVERLAP DETECTION: Use IoU instead of distance
        if (isMultiPass) {
          showStatus('🔄 Multi-Pass: Removing duplicates between passes with IoU...', 'info');
          console.log(`🔄 Before deduplication: ${allPolygons.length} detections from ${allPassPoints.length} passes`);
        } else {
          showStatus('🔄 Removing duplicates with IoU...', 'info');
        }
        
        const uniquePolygons = removeDuplicatePolygonsAdvanced(allPolygons);
        
        if (isMultiPass) {
          const removed = allPolygons.length - uniquePolygons.length;
          console.log(`🎯 Multi-Pass complete: ${uniquePolygons.length} unique corals (removed ${removed} duplicates)`);
        } else {
          console.log(`🎯 ${uniquePolygons.length} unique corals after IoU deduplication`);
        }
        
        // Remove the rectangle and progress markers
        drawnItems.removeLayer(layer);
        setTimeout(() => progressMarkers.remove(), 2000);
        
        // Create polygons on map
        const boundsNorth = mapBounds.getNorth();
        const boundsSouth = mapBounds.getSouth();
        const boundsEast = mapBounds.getEast();
        const boundsWest = mapBounds.getWest();
        const canvasWidth = mapCanvas.width;
        const canvasHeight = mapCanvas.height;
        
        const createdPolygons = [];
        
        for (let idx = 0; idx < uniquePolygons.length; idx++) {
          const polyData = uniquePolygons[idx];
          const geoCoords = [];
          
          // Convert flat array to geo coordinates
          for (let i = 0; i < polyData.polygon.length; i += 2) {
            const px = polyData.polygon[i];
            const py = polyData.polygon[i + 1];
            const lng = boundsWest + (px / canvasWidth) * (boundsEast - boundsWest);
            const lat = boundsNorth - (py / canvasHeight) * (boundsNorth - boundsSouth);
            geoCoords.push([lat, lng]);
          }
          
          // 2. CONFIDENCE-BASED COLOR CODING
          let color, fillColor;
          if (polyData.confidence >= 0.90) {
            color = '#10b981'; // Green for high confidence
            fillColor = '#10b981';
          } else if (polyData.confidence >= 0.80) {
            color = '#8b5cf6'; // Purple for medium-high
            fillColor = '#8b5cf6';
          } else {
            color = '#f59e0b'; // Orange for medium
            fillColor = '#f59e0b';
          }
          
          const polygon = L.polygon(geoCoords, {
            color: color,
            weight: 3,
            fillOpacity: 0.4,
            fillColor: fillColor,
            pane: 'annotationsPane'
          });
          
          // 2. CONFIDENCE TOOLTIP
          polygon.bindTooltip(`#${idx + 1} - ${(polyData.confidence * 100).toFixed(1)}% confidence`, {
            permanent: false,
            direction: 'top'
          });
          
          drawnItems.addLayer(polygon);
          polygon.addTo(map);
          
          createdPolygons.push({
            polygon: polyData.polygon,
            confidence: polyData.confidence,
            area: polyData.area,
            geoCoords: geoCoords
          });
        }
        
        // Store for export functionality
        window.lastGridResults = createdPolygons;
        
        // 9. AUTO-SAVE OPTION: Save all detections if enabled
        const autoSave = document.getElementById('sam3AutoSave')?.checked;
        if (autoSave) {
          showStatus('💾 Auto-saving all detections...', 'info');
          await autoSaveGridDetections(createdPolygons);
        } else {
          showStatus(`✅ Found ${uniquePolygons.length} unique corals! (Green=High conf, Purple=Med, Orange=Lower)`, 'success');
        }
        
        showLoading(false);
        
      } catch (error) {
        console.error('Smart Grid error:', error);
        showStatus(`Smart Grid error: ${error.message}`, 'error');
        showLoading(false);
        drawnItems.removeLayer(layer);
      }
    }
    
    // 3. ADVANCED DUPLICATE REMOVAL: Use IoU (Intersection over Union)
    function removeDuplicatePolygonsAdvanced(polygons) {
      if (polygons.length === 0) return [];
      
      // Sort by confidence (highest first) so we keep best versions
      polygons.sort((a, b) => b.confidence - a.confidence);
      
      const unique = [polygons[0]];
      
      for (let i = 1; i < polygons.length; i++) {
        const poly1 = polygons[i];
        let isDuplicate = false;
        
        for (const existing of unique) {
          // Calculate IoU (Intersection over Union)
          const iou = calculatePolygonIoU(poly1.polygon, existing.polygon);
          
          // If IoU > 0.5, consider it a duplicate
          if (iou > 0.5) {
            console.log(`Duplicate detected: IoU=${(iou * 100).toFixed(1)}%, keeping higher confidence (${(existing.confidence * 100).toFixed(1)}% vs ${(poly1.confidence * 100).toFixed(1)}%)`);
            isDuplicate = true;
            break;
          }
        }
        
        if (!isDuplicate) {
          unique.push(polygons[i]);
        }
      }
      
      return unique;
    }
    
    // Calculate Intersection over Union for two polygons
    function calculatePolygonIoU(poly1, poly2) {
      // Quick center-distance check first (optimization)
      const center1 = getPolygonCenter(poly1);
      const center2 = getPolygonCenter(poly2);
      const distance = Math.sqrt(Math.pow(center1.x - center2.x, 2) + Math.pow(center1.y - center2.y, 2));
      
      // If centers are far apart, IoU is definitely 0
      if (distance > 100) return 0;
      
      // Convert to coordinate arrays for intersection calculation
      const coords1 = [];
      const coords2 = [];
      
      for (let i = 0; i < poly1.length; i += 2) {
        coords1.push([poly1[i], poly1[i + 1]]);
      }
      for (let i = 0; i < poly2.length; i += 2) {
        coords2.push([poly2[i], poly2[i + 1]]);
      }
      
      // Calculate bounding box overlap as approximation
      const bbox1 = getPolygonBBox(poly1);
      const bbox2 = getPolygonBBox(poly2);
      
      const overlapX = Math.max(0, Math.min(bbox1.maxX, bbox2.maxX) - Math.max(bbox1.minX, bbox2.minX));
      const overlapY = Math.max(0, Math.min(bbox1.maxY, bbox2.maxY) - Math.max(bbox1.minY, bbox2.minY));
      const overlapArea = overlapX * overlapY;
      
      if (overlapArea === 0) return 0;
      
      const area1 = calculatePolygonArea(poly1);
      const area2 = calculatePolygonArea(poly2);
      
      // Use bbox overlap as approximation for IoU
      // This is faster than true polygon intersection
      const unionArea = area1 + area2 - overlapArea;
      const iou = overlapArea / unionArea;
      
      return iou;
    }
    
    function getPolygonBBox(flatPolygon) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      for (let i = 0; i < flatPolygon.length; i += 2) {
        const x = flatPolygon[i];
        const y = flatPolygon[i + 1];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      
      return { minX, minY, maxX, maxY };
    }
    
    function getPolygonCenter(flatPolygon) {
      let sumX = 0, sumY = 0, count = 0;
      for (let i = 0; i < flatPolygon.length; i += 2) {
        sumX += flatPolygon[i];
        sumY += flatPolygon[i + 1];
        count++;
      }
      return { x: sumX / count, y: sumY / count };
    }
    
    // Calculate polygon area using Shoelace formula
    function calculatePolygonArea(flatPolygon) {
      let area = 0;
      const n = flatPolygon.length / 2;
      
      for (let i = 0; i < n; i++) {
        const x1 = flatPolygon[i * 2];
        const y1 = flatPolygon[i * 2 + 1];
        const x2 = flatPolygon[((i + 1) % n) * 2];
        const y2 = flatPolygon[((i + 1) % n) * 2 + 1];
        area += (x1 * y2) - (x2 * y1);
      }
      
      return Math.abs(area) / 2;
    }
    
    // 9. AUTO-SAVE GRID DETECTIONS: Save all with default species
    async function autoSaveGridDetections(detections) {
      let savedCount = 0;
      let failedCount = 0;
      
      for (let i = 0; i < detections.length; i++) {
        const det = detections[i];
        
        try {
          const annotationData = {
            site: currentSite,
            cog_url: currentCOG,
            visit_id: currentVisitId || null,
            annotation_type: 'coral',
            geometry: {
              type: 'Polygon',
              coordinates: [det.geoCoords]
            },
            properties: {
              species: 'Unknown Coral',
              confidence: det.confidence,
              notes: `Smart Grid auto-detection (${(det.confidence * 100).toFixed(1)}% confidence)`,
              sam3_auto: true,
              detection_method: 'SAM3_SmartGrid'
            }
          };
          
          let response;
          if (isOracleProjectMode()) {
            const projectId = currentProject.project_id;
            const analyst = document.getElementById('analyst')?.value || null;
            response = await fetch(`${serverUrl}/api/db/projects/${projectId}/annotations`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                feature: {
                  type: 'Feature',
                  geometry: annotationData.geometry,
                  properties: {}
                },
                properties: {
                  SHAPE: 'Polygon',
                  SPCODE: 'Unknown Coral',
                  SITE: currentProject?.site || currentSite || null,
                  ANALYST: analyst,
                  CONFIDENCE: det.confidence,
                  NOTES: annotationData.properties.notes,
                  SAM3_AUTO: true,
                  DETECTION_METHOD: 'SAM3_SmartGrid'
                },
                created_by: analyst
              })
            });
          } else {
            response = await fetch(`${serverUrl}/api/annotations`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
              },
              body: JSON.stringify(annotationData)
            });
          }
          
          if (response.ok) {
            savedCount++;
            showStatus(`💾 Auto-saved ${savedCount}/${detections.length}...`, 'info');
          } else {
            failedCount++;
          }
        } catch (err) {
          console.error(`Failed to auto-save detection ${i + 1}:`, err);
          failedCount++;
        }
      }
      
      if (failedCount === 0) {
        showStatus(`✅ Auto-saved all ${savedCount} detections!`, 'success');
      } else {
        showStatus(`⚠️ Saved ${savedCount}, failed ${failedCount}`, 'warning');
      }
      
      // Reload annotations to show saved items
      if (savedCount > 0) {
        await loadAnnotations();
      }
    }
    
    // 10. EXPORT GRID RESULTS: Download JSON with all detections
    function exportGridResults() {
      if (!window.lastGridResults || window.lastGridResults.length === 0) {
        showStatus('⚠️ No grid results to export. Run Smart Grid first!', 'warning');
        return;
      }
      
      const exportData = {
        timestamp: new Date().toISOString(),
        site: currentSite || 'Unknown',
        cog_url: currentCOG || 'Unknown',
        total_detections: window.lastGridResults.length,
        detections: window.lastGridResults.map((det, idx) => ({
          id: idx + 1,
          confidence: det.confidence,
          area_pixels: det.area,
          polygon_points: det.polygon.length / 2,
          coordinates: det.geoCoords
        }))
      };
      
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `smart_grid_results_${currentSite || 'unknown'}_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showStatus(`✅ Exported ${window.lastGridResults.length} detections to JSON`, 'success');
    }
    
    // Handle drawing events
    map.on(L.Draw.Event.CREATED, async function (event) {
      // In bulk mode, v2-bulk.js handles everything — skip normal flow
      if (window.v2BulkMode && window.v2BulkMode.enabled) return;

      const layer = event.layer;
      const type = event.layerType;
      
      console.log(`🎨 Draw event: type=${type}, magicWandActive=${magicWandActive}, sam3Mode=${sam3Mode}, currentCOG=${currentCOG}`);
      
      // Set the layer to use the annotations pane for proper z-index
      if (layer.options) {
        layer.options.pane = 'annotationsPane';
      }
      
      // Check if SAM3 Smart Grid segmentation should be triggered
      if (type === 'rectangle' && magicWandActive && sam3Mode === 'grid' && currentCOG) {
        console.log('🎯 SAM3 Smart Grid segmentation triggered!');
        await runSAM3SmartGrid(layer);
        return; // Don't continue with normal flow
      }
      
      // Check if SAM3 box segmentation should be triggered (Single Box Mode only)
      if (type === 'rectangle' && magicWandActive && sam3Mode === 'box' && currentCOG) {
        console.log('📦 SAM3 box segmentation triggered!');

        try {
          showLoading(true);
          showStatus('Running SAM3 box segmentation...', 'info');
          
          // Load model with selected size
          const loadResponse = await fetch(`${serverUrl}/api/sam/load-model`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_size: sam3ModelSize })
          });
          
          if (!loadResponse.ok) {
            throw new Error('Failed to load SAM3 model');
          }
          
          // Get rectangle bounds
          const bounds = layer.getBounds();
          const sw = bounds.getSouthWest();
          const ne = bounds.getNorthEast();
          
          // Get map info for coordinate conversion
          const mapBounds = map.getBounds();
          const mapSize = map.getSize();
          
          // Capture map
          const mapContainer = map.getContainer();
          const mapCanvas = await html2canvas(mapContainer, {
            useCORS: true,
            allowTaint: true,
            logging: false,
            width: mapSize.x,
            height: mapSize.y
          });
          
          const imageData = mapCanvas.toDataURL('image/png');
          
          // Convert rectangle bounds to pixel coordinates
          const swPoint = map.latLngToContainerPoint(sw);
          const nePoint = map.latLngToContainerPoint(ne);
          
          const box_x1 = Math.min(swPoint.x, nePoint.x);
          const box_y1 = Math.min(swPoint.y, nePoint.y);
          const box_x2 = Math.max(swPoint.x, nePoint.x);
          const box_y2 = Math.max(swPoint.y, nePoint.y);
          
          console.log(`📦 SAM3 box: [${box_x1}, ${box_y1}, ${box_x2}, ${box_y2}]`);
          
          // Call SAM3 box API
          const response = await fetch(`${serverUrl}/api/sam/box-segment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image_data: imageData,
              box_x1: box_x1,
              box_y1: box_y1,
              box_x2: box_x2,
              box_y2: box_y2,
              return_polygon: true,
              confidence_threshold: sam3ConfidenceThreshold
            })
          });
          
          if (!response.ok) {
            throw new Error(`SAM3 box API error: ${response.statusText}`);
          }
          
          const data = await response.json();
          
          if (data.success && data.polygon) {
            // Convert pixel polygon to geographic coordinates
            const boundsNorth = mapBounds.getNorth();
            const boundsSouth = mapBounds.getSouth();
            const boundsEast = mapBounds.getEast();
            const boundsWest = mapBounds.getWest();
            const canvasWidth = mapCanvas.width;
            const canvasHeight = mapCanvas.height;
            
            console.log(`📦 Box conversion params:`, {
              canvas: { width: canvasWidth, height: canvasHeight },
              bounds: { north: boundsNorth, south: boundsSouth, east: boundsEast, west: boundsWest },
              polygonLength: data.polygon?.length,
              isFlat: typeof data.polygon?.[0] === 'number'
            });
            
            const geoCoords = [];
            
            // SAM3 returns flat array: [x1, y1, x2, y2, x3, y3, ...]
            if (typeof data.polygon[0] === 'number') {
              for (let i = 0; i < data.polygon.length; i += 2) {
                const px = data.polygon[i];
                const py = data.polygon[i + 1];
                
                if (px === undefined || py === undefined || isNaN(px) || isNaN(py)) {
                  console.error(`Invalid pixel coordinates at index ${i}: px=${px}, py=${py}`);
                  continue;
                }
                
                const lng = boundsWest + (px / canvasWidth) * (boundsEast - boundsWest);
                const lat = boundsNorth - (py / canvasHeight) * (boundsNorth - boundsSouth);
                
                geoCoords.push([lat, lng]);
              }
            } else {
              // Handle array of pairs format
              for (let idx = 0; idx < data.polygon.length; idx++) {
                const point = data.polygon[idx];
                let px, py;
                
                if (Array.isArray(point) && point.length >= 2) {
                  px = point[0];
                  py = point[1];
                } else if (typeof point === 'object' && point !== null) {
                  px = point.x;
                  py = point.y;
                } else {
                  continue;
                }
                
                if (px === undefined || py === undefined || isNaN(px) || isNaN(py)) {
                  continue;
                }
                
                const lng = boundsWest + (px / canvasWidth) * (boundsEast - boundsWest);
                const lat = boundsNorth - (py / canvasHeight) * (boundsNorth - boundsSouth);
                
                geoCoords.push([lat, lng]);
              }
            }
            
            // Remove the rectangle box
            drawnItems.removeLayer(layer);
            
            // Create refined polygon
            const refinedPolygon = L.polygon(geoCoords, {
              color: '#8b5cf6',
              weight: 3,
              fillOpacity: 0.4,
              fillColor: '#8b5cf6',
              pane: 'annotationsPane'
            });
            
            drawnItems.addLayer(refinedPolygon);
            
            // Force map to show the polygon
            refinedPolygon.addTo(map);
            map.fitBounds(refinedPolygon.getBounds(), { 
              padding: [50, 50],
              maxZoom: map.getZoom()
            });
            
            // Store as current annotation
            currentAnnotation = {
              type: 'polygon',
              layer: refinedPolygon,
              geometry: getFullPrecisionGeometry(refinedPolygon),
              createdBy: 'SAM3-box',
              confidence: data.confidence
            };
            
            console.log(`✅ SAM3 box polygon added to map with ${geoCoords.length} points`);
            console.log(`Polygon bounds:`, refinedPolygon.getBounds());
            showStatus(`✅ SAM3 refined! ${(data.confidence * 100).toFixed(1)}% confidence - Fill in details`, 'success');
            showLoading(false);
            
            // Auto-focus on species field for quick data entry
            setTimeout(() => {
              const speciesField = document.getElementById('spcode');
              if (speciesField) {
                speciesField.focus();
                console.log('✅ Auto-focused on species field after SAM3');
              }
            }, 150); // Small delay to ensure form is ready
            
            return; // Don't continue with normal draw flow
          } else {
            showStatus('SAM3 box segmentation failed', 'warning');
            showLoading(false);
            
            // Remove any previous unsaved annotation
            if (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData) {
              console.log('🧹 Removing previous unsaved annotation (SAM3 failed)');
              drawnItems.removeLayer(currentAnnotation.layer);
            }
            
            // Keep the rectangle and continue normally
            drawnItems.addLayer(layer);
            currentAnnotation = {
              type: type,
              layer: layer,
              geometry: getFullPrecisionGeometry(layer)
            };
          }
        } catch (error) {
          console.error('SAM3 box error:', error);
          showStatus(`SAM3 error: ${error.message}`, 'error');
          showLoading(false);
          
          // Remove any previous unsaved annotation
          if (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData) {
            console.log('🧹 Removing previous unsaved annotation (SAM3 error)');
            drawnItems.removeLayer(currentAnnotation.layer);
          }
          
          // Keep the rectangle and continue normally
          drawnItems.addLayer(layer);
          currentAnnotation = {
            type: type,
            layer: layer,
            geometry: getFullPrecisionGeometry(layer)
          };
        }
      } else {
        // Normal drawing (no SAM3)
        
        // IMPORTANT: Remove any previous unsaved annotation to prevent "ghost" shapes
        if (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData) {
          console.log('🧹 Removing previous unsaved annotation');
          drawnItems.removeLayer(currentAnnotation.layer);
        }
        
        drawnItems.addLayer(layer);
        
        // Store the current drawing with full precision geometry
        currentAnnotation = {
          type: type,
          layer: layer,
          geometry: getFullPrecisionGeometry(layer),
          replacedUnsaved: (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData)
        };
      }
      
      // Auto-start timer on first annotation draw
      if (!timerState.isRunning) {
        console.log('🎬 First annotation drawn - starting timer');
        startTimer();
      } else if (timerState.isPaused) {
        console.log('▶️ Annotation drawn - resuming timer');
        startTimer();
      }
      
      // Debug: Log the drawn coordinates with pixel positions
      const bounds = layer.getBounds ? layer.getBounds() : null;
      const center = bounds ? bounds.getCenter() : (layer.getLatLng ? layer.getLatLng() : null);
      console.log('🖊️ Drew annotation:', {
        type: type,
        geometry: currentAnnotation.geometry,
        coordinates: currentAnnotation.geometry.coordinates,
        visualCenter: center,
        visualBounds: bounds,
        layerType: layer.constructor.name
      });
      
      // Show appropriate status message
      if (currentAnnotation.replacedUnsaved) {
        showStatus('⚠️ Previous unsaved annotation was replaced! Fill out the form and click Save.', 'warning');
      } else {
        showStatus('Draw created! Fill out the form and click Save.', 'info');
      }
      
      // Calculate shape length for the form
      // seglength/segwidth are user-entered fields — don't auto-fill them.
      // line_length_m is computed at save time from the drawn geometry.
      
      // Auto-focus on species field for quick data entry
      const speciesField = document.getElementById('spcode');
      if (speciesField) {
        setTimeout(() => {
          speciesField.focus();
          console.log('✅ Auto-focused on species field');
          
          // Don't re-enable drawing tool here - wait until after Save button is clicked
          // This prevents interference with form focus and user input
        }, 100); // Small delay to ensure form is ready
      }
    });
    
    // Helper function to extract full-precision geometry from Leaflet layer
    // IMPORTANT: Leaflet's toGeoJSON() truncates coordinates to 6 decimal places by default,
    // which causes ~1 meter precision loss. This function extracts coordinates directly
    // from the layer's internal LatLng objects to preserve full floating-point precision.
    // Operations/utilities runtime extracted to js/annotation-runtime-operations.js
