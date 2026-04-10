// ============================================================
//  CAT v2 — Enhanced Table Features
//  Sortable columns, resizable panel, arrow-key navigation,
//  batch/bulk column fill, column visibility manager
// ============================================================

(function () {
  'use strict';

  // ── State ──
  const _savedSort = (typeof catGetTableSort === 'function') ? catGetTableSort() : null;
  let sortColumn = _savedSort ? _savedSort.column : null;
  let sortDirection = _savedSort ? _savedSort.direction : 'asc';
  let kbRow = -1;               // keyboard-nav row index
  let kbCol = -1;               // keyboard-nav col index
  let tableSizeMode = 'md';     // 'sm' | 'md' | 'lg' | 'xl'
  let clipboard = null;         // copy/paste buffer
  let selectedCells = [];       // multi-select cells {row, col, value}
  let selectedRows = new Set(); // multi-row selection for bulk update
  let _lastCheckedIdx = -1;    // for shift+click range selection

  const TABLE_SIZES = {
    sm: 120,
    md: 200,
    lg: 350,
    xl: 550,
    max: 900
  };

  // Column definitions — field name → header display name
  // Order matches the <th> elements in the HTML
  const DEFAULT_COLUMNS = [
    { field: 'id',            label: 'ID',            sortable: true,  batchFill: false, visible: true  },
    { field: 'type',          label: 'Type',          sortable: true,  batchFill: false, visible: false },
    { field: 'site',          label: 'Site',          sortable: true,  batchFill: false, visible: true  },
    { field: 'spcode',        label: 'Species',       sortable: true,  batchFill: true,  visible: true  },
    { field: 'juvenile',      label: 'Juvenile',      sortable: true,  batchFill: true,  visible: true  },
    { field: 'juv_substrate', label: 'JUV_SUBSTRATE', sortable: true,  batchFill: true,  visible: true  },
    { field: 'analyst',       label: 'Analyst',       sortable: true,  batchFill: true,  visible: false },
    { field: 'obs_year',      label: 'Year',          sortable: true,  batchFill: true,  visible: false },
    { field: 'mission_id',    label: 'Mission',       sortable: true,  batchFill: true,  visible: false },
    { field: 'segment',       label: 'Segment',       sortable: true,  batchFill: true,  visible: true  },
    { field: 'transect',      label: 'Transect',      sortable: true,  batchFill: true,  visible: true  },
    { field: 'morph_code',    label: 'Morph',         sortable: true,  batchFill: true,  visible: true  },
    { field: 'old_dead',      label: 'Old Dead %',    sortable: true,  batchFill: true,  visible: false },
    { field: 'remnant',       label: 'Remnant',       sortable: true,  batchFill: true,  visible: false },
    { field: 'fragment',      label: 'Fragment',      sortable: true,  batchFill: true,  visible: false },
    { field: 'ex_bound',      label: 'Ex Bound',      sortable: true,  batchFill: true,  visible: false },
    { field: 'no_colony',     label: 'No Colony',     sortable: true,  batchFill: true,  visible: false },
    { field: 'seglength',     label: 'Seg Length',     sortable: true,  batchFill: true,  visible: false },
    { field: 'segwidth',      label: 'Seg Width',      sortable: true,  batchFill: true,  visible: false },
    { field: 'line_length_m', label: 'Line Length (m)', sortable: true, batchFill: false, visible: false },
    { field: 'rdcause1',      label: 'RD Cause 1',    sortable: true,  batchFill: true,  visible: false },
    { field: 'rd_1',          label: 'RD 1 %',        sortable: true,  batchFill: true,  visible: false },
    { field: 'rdcause2',      label: 'RD Cause 2',    sortable: true,  batchFill: true,  visible: false },
    { field: 'rd_2',          label: 'RD 2 %',        sortable: true,  batchFill: true,  visible: false },
    { field: 'rdcause3',      label: 'RD Cause 3',    sortable: true,  batchFill: true,  visible: false },
    { field: 'rd_3',          label: 'RD 3 %',        sortable: true,  batchFill: true,  visible: false },
    { field: 'con_1',         label: 'Condition 1',    sortable: true,  batchFill: true,  visible: false },
    { field: 'extent_1',      label: 'Extent 1',      sortable: true,  batchFill: true,  visible: false },
    { field: 'sev_1',         label: 'Severity 1',    sortable: true,  batchFill: true,  visible: false },
    { field: 'con_2',         label: 'Condition 2',    sortable: true,  batchFill: true,  visible: false },
    { field: 'extent_2',      label: 'Extent 2',      sortable: true,  batchFill: true,  visible: false },
    { field: 'sev_2',         label: 'Severity 2',    sortable: true,  batchFill: true,  visible: false },
    { field: 'con_3',         label: 'Condition 3',    sortable: true,  batchFill: true,  visible: false },
    { field: 'extent_3',      label: 'Extent 3',      sortable: true,  batchFill: true,  visible: false },
    { field: 'sev_3',         label: 'Severity 3',    sortable: true,  batchFill: true,  visible: false },
    { field: 'actions',       label: 'Actions',       sortable: false, batchFill: false, visible: true  }
  ];

  // Load saved visibility from localStorage, falling back to defaults
  const COL_VIS_KEY = 'cat_column_visibility';
  const COLUMNS = DEFAULT_COLUMNS.map(col => {
    const saved = loadColumnVisibility();
    if (saved && col.field in saved) {
      return { ...col, visible: saved[col.field] };
    }
    return { ...col };
  });

  function loadColumnVisibility() {
    try {
      const raw = localStorage.getItem(COL_VIS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveColumnVisibility() {
    const vis = {};
    COLUMNS.forEach(c => { vis[c.field] = c.visible; });
    try { localStorage.setItem(COL_VIS_KEY, JSON.stringify(vis)); } catch (e) { /* ignore */ }
  }

  // ── Checkbox column offset helper ──
  // Returns 1 when the row-select checkbox column has been injected, 0 otherwise.
  // All positional column logic (visibility, sort, headers) must add this offset.
  function _cbOff() {
    return document.querySelector('#annotationTable thead .row-select-th') ? 1 : 0;
  }

  // ===================================================================
  //  SORT — click header to sort annotation table
  // ===================================================================
  function initSortableHeaders() {
    // We hook into updateAnnotationTable to re-apply sort after table refresh
    const origUpdate = window.updateAnnotationTable;
    if (typeof origUpdate === 'function') {
      window.updateAnnotationTable = function () {
        origUpdate.apply(this, arguments);
        injectRowCheckboxes();          // add checkbox column (must be first)
        applyColumnVisibility();
        applySortableHeaders();
        applyTableSize();
        if (sortColumn) {
          sortTableByColumn(sortColumn, sortDirection, false);
        }
        updateSelectionUI();
      };
    }
  }

  function applySortableHeaders() {
    const table = document.getElementById('annotationTable');
    if (!table) return;
    const headers = table.querySelectorAll('thead th');
    const off = _cbOff();

    headers.forEach((th, idx) => {
      const col = COLUMNS[idx - off];
      if (!col || !col.sortable) return;

      th.classList.add('sortable');
      if (col.batchFill) {
        th.classList.add('batch-fillable');
        // Add batch-fill button
        if (!th.querySelector('.batch-fill-btn')) {
          const btn = document.createElement('button');
          btn.className = 'batch-fill-btn';
          btn.title = `Batch fill "${col.label}" for all rows`;
          btn.textContent = '⬇';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openBatchFillModal(col.field, col.label);
          });
          th.style.position = 'relative';
          th.appendChild(btn);
        }
      }

      // Update sort indicator
      th.classList.remove('sort-asc', 'sort-desc');
      if (sortColumn === col.field) {
        th.classList.add(sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
      }

      // Click handler
      th.onclick = () => {
        if (sortColumn === col.field) {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          sortColumn = col.field;
          sortDirection = 'asc';
        }
        sortTableByColumn(sortColumn, sortDirection, true);
        if (typeof catSaveTableSort === 'function') catSaveTableSort(sortColumn, sortDirection);
      };
    });
  }

  function sortTableByColumn(field, direction, reRender) {
    const table = document.getElementById('annotationTable');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    if (rows.length <= 1 && rows[0] && rows[0].cells.length === 1) return; // "no annotations" row

    rows.sort((a, b) => {
      const colIdx = COLUMNS.findIndex(c => c.field === field);
      if (colIdx === -1) return 0;
      const cellIdx = colIdx + _cbOff();
      const aText = (a.cells[cellIdx]?.textContent || '').trim();
      const bText = (b.cells[cellIdx]?.textContent || '').trim();

      // Try numeric sort
      const aNum = parseFloat(aText);
      const bNum = parseFloat(bText);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return direction === 'asc' ? aNum - bNum : bNum - aNum;
      }
      // String sort
      const cmp = aText.localeCompare(bText, undefined, { numeric: true, sensitivity: 'base' });
      return direction === 'asc' ? cmp : -cmp;
    });

    rows.forEach(row => tbody.appendChild(row));

    // Update header indicators
    applySortableHeaders();
  }

  // ===================================================================
  //  TABLE SIZE — resizable annotation panel
  // ===================================================================
  function injectTableSizeControls() {
    const waitForPanel = setInterval(() => {
      const listHeader = document.querySelector('#annotationsListSectionContent')?.previousElementSibling;
      if (!listHeader) return;
      clearInterval(waitForPanel);

      // Insert size buttons
      const controls = document.createElement('div');
      controls.className = 'table-size-controls';
      controls.id = 'v2TableSizeControls';
      controls.innerHTML = `
        <button class="table-size-btn" data-size="sm" title="Small table">S</button>
        <button class="table-size-btn active" data-size="md" title="Medium table">M</button>
        <button class="table-size-btn" data-size="lg" title="Large table">L</button>
        <button class="table-size-btn" data-size="xl" title="Extra-large table">XL</button>
        <button class="table-size-btn" data-size="max" title="Maximum table">MAX</button>
      `;

      // Append next to the h3
      const h3 = listHeader.querySelector('h3') || listHeader.querySelector('div');
      if (h3) {
        h3.parentElement.appendChild(controls);
      }

      controls.addEventListener('click', (e) => {
        const btn = e.target.closest('.table-size-btn');
        if (!btn) return;
        e.stopPropagation(); // Prevent parent section collapse toggle
        tableSizeMode = btn.dataset.size;
        controls.querySelectorAll('.table-size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyTableSize();
      });

      // Also add drag-resize handle to annotation panel
      const panel = document.getElementById('annotationFormPanel');
      if (panel && !panel.querySelector('.resize-handle')) {
        panel.style.position = 'absolute'; // ensure positioning
        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        handle.title = 'Drag to resize';
        panel.insertBefore(handle, panel.firstChild);

        let startY, startH;
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation(); // Prevent parent handlers
          startY = e.clientY;
          startH = panel.offsetHeight;
          handle.classList.add('dragging');
          const onMove = (ev) => {
            const delta = startY - ev.clientY;
            const newH = Math.max(80, Math.min(window.innerHeight * 0.85, startH + delta));
            panel.style.maxHeight = newH + 'px';
          };
          const onUp = () => {
            handle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
      }
    }, 300);
  }

  function applyTableSize() {
    const container = document.querySelector('.annotation-table-container');
    if (container) {
      container.style.maxHeight = TABLE_SIZES[tableSizeMode] + 'px';
      container.style.minHeight = Math.min(80, TABLE_SIZES[tableSizeMode]) + 'px';
    }
  }

  // ===================================================================
  //  COLUMN VISIBILITY — show/hide columns, persisted to localStorage
  // ===================================================================
  function applyColumnVisibility() {
    const table = document.getElementById('annotationTable');
    if (!table) return;

    const headers = table.querySelectorAll('thead th');
    const rows = table.querySelectorAll('tbody tr');
    const off = _cbOff();

    COLUMNS.forEach((col, idx) => {
      const display = col.visible ? '' : 'none';
      const cellIdx = idx + off;
      if (headers[cellIdx]) headers[cellIdx].style.display = display;
      rows.forEach(row => {
        if (row.cells[cellIdx]) row.cells[cellIdx].style.display = display;
      });
    });
  }

  function injectColumnPicker() {
    const waitForPanel = setInterval(() => {
      const listHeader = document.querySelector('#annotationsListSectionContent')?.previousElementSibling;
      if (!listHeader) return;
      clearInterval(waitForPanel);

      if (document.getElementById('v2ColPickerBtn')) return;

      // Gear button
      const btn = document.createElement('button');
      btn.id = 'v2ColPickerBtn';
      btn.className = 'v2-tool-btn';
      btn.title = 'Show/hide table columns';
      btn.textContent = '⚙ Columns';
      btn.style.cssText = 'margin-left:8px;padding:3px 8px;font-size:11px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;cursor:pointer;font-weight:600;color:#475569;';

      // Dropdown
      const dropdown = document.createElement('div');
      dropdown.id = 'v2ColPickerDropdown';
      dropdown.style.cssText = 'display:none;position:absolute;right:0;top:100%;z-index:5000;background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.15);padding:8px 0;min-width:200px;max-height:400px;overflow-y:auto;';

      // Title row
      dropdown.innerHTML = '<div style="padding:4px 12px 8px;font-size:12px;font-weight:700;color:#1e293b;border-bottom:1px solid #e2e8f0;">Visible Columns</div>';

      // Preset buttons row
      const presets = document.createElement('div');
      presets.style.cssText = 'display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid #e2e8f0;';
      presets.innerHTML = `
        <button class="col-preset-btn" data-preset="core" style="flex:1;padding:3px 6px;font-size:10px;font-weight:600;border:1px solid #cbd5e1;border-radius:3px;background:#f1f5f9;cursor:pointer;color:#475569;">Core</button>
        <button class="col-preset-btn" data-preset="all" style="flex:1;padding:3px 6px;font-size:10px;font-weight:600;border:1px solid #cbd5e1;border-radius:3px;background:#f1f5f9;cursor:pointer;color:#475569;">All</button>
        <button class="col-preset-btn" data-preset="minimal" style="flex:1;padding:3px 6px;font-size:10px;font-weight:600;border:1px solid #cbd5e1;border-radius:3px;background:#f1f5f9;cursor:pointer;color:#475569;">Minimal</button>
      `;
      dropdown.appendChild(presets);

      // Column checkboxes
      COLUMNS.forEach((col, idx) => {
        if (col.field === 'actions') return; // always visible
        const item = document.createElement('label');
        item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:12px;color:#374151;cursor:pointer;';
        item.onmouseover = () => item.style.background = '#f3f4f6';
        item.onmouseout = () => item.style.background = '';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = col.visible;
        cb.dataset.colIdx = idx;
        cb.addEventListener('change', () => {
          COLUMNS[idx].visible = cb.checked;
          saveColumnVisibility();
          applyColumnVisibility();
        });
        item.appendChild(cb);
        item.appendChild(document.createTextNode(col.label));
        dropdown.appendChild(item);
      });

      // Wrap in relative container — stop propagation so clicks inside
      // the picker don't bubble to the section header's onclick (which
      // would collapse the annotations list and hide the table).
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:relative;display:inline-block;';
      wrapper.addEventListener('click', (e) => e.stopPropagation());
      wrapper.appendChild(btn);
      wrapper.appendChild(dropdown);

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.style.display !== 'none';
        dropdown.style.display = isOpen ? 'none' : 'block';
      });

      // Close on outside click
      document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
          dropdown.style.display = 'none';
        }
      });

      // Preset handlers
      presets.addEventListener('click', (e) => {
        const presetBtn = e.target.closest('.col-preset-btn');
        if (!presetBtn) return;
        const preset = presetBtn.dataset.preset;

        const coreFields = ['id', 'site', 'spcode', 'juvenile', 'juv_substrate', 'segment', 'transect', 'morph_code', 'actions'];
        const minimalFields = ['id', 'site', 'spcode', 'morph_code', 'actions'];

        COLUMNS.forEach((col, idx) => {
          if (col.field === 'actions') { col.visible = true; return; }
          if (preset === 'all') col.visible = true;
          else if (preset === 'core') col.visible = coreFields.includes(col.field);
          else if (preset === 'minimal') col.visible = minimalFields.includes(col.field);
          // Update checkbox
          const cb = dropdown.querySelector(`input[data-col-idx="${idx}"]`);
          if (cb) cb.checked = col.visible;
        });
        saveColumnVisibility();
        applyColumnVisibility();
      });

      // Insert after size controls or into header
      const sizeControls = document.getElementById('v2TableSizeControls');
      if (sizeControls) {
        sizeControls.parentElement.appendChild(wrapper);
      } else {
        const h3 = listHeader.querySelector('h3') || listHeader.querySelector('div');
        if (h3) h3.parentElement.appendChild(wrapper);
      }
    }, 300);
  }

  // ===================================================================
  //  ARROW KEY NAV — move between editable cells with arrow keys
  // ===================================================================
  function initArrowKeyNav() {
    document.addEventListener('keydown', function (e) {
      const table = document.getElementById('annotationTable');
      if (!table) return;

      // Copy/Paste shortcuts
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        handleCopy(e);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        handlePaste(e);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        handleDuplicateDown(e);
        return;
      }

      // Arrow key navigation
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab'].includes(e.key)) return;

      // Only activate if we have a focused cell or the table is focused
      const activeCell = table.querySelector('td.kb-focus');
      if (!activeCell && document.activeElement.tagName !== 'TD') return;
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') {
        // Allow Enter/Tab to move to next cell after editing
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const td = document.activeElement.closest('td');
          if (td) {
            document.activeElement.blur();
            const row = td.parentElement;
            const cells = Array.from(row.cells);
            const colIdx = cells.indexOf(td);
            const rows = Array.from(table.querySelector('tbody').querySelectorAll('tr'));
            const rowIdx = rows.indexOf(row);
            
            if (e.key === 'Tab') {
              // Tab moves right (or to next row)
              if (e.shiftKey) {
                navigateToCell(table, rowIdx, colIdx - 1);
              } else {
                navigateToCell(table, rowIdx, colIdx + 1);
              }
            } else {
              // Enter moves down
              navigateToCell(table, rowIdx + 1, colIdx);
            }
          }
        }
        return;
      }

      e.preventDefault();
      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      const rows = Array.from(tbody.querySelectorAll('tr'));
      if (rows.length === 0) return;

      // Get editable cells
      if (activeCell) {
        kbRow = rows.indexOf(activeCell.parentElement);
        kbCol = Array.from(activeCell.parentElement.cells).indexOf(activeCell);
      }

      // Move
      if (e.key === 'ArrowUp')    kbRow = Math.max(0, kbRow - 1);
      if (e.key === 'ArrowDown')  kbRow = Math.min(rows.length - 1, kbRow + 1);
      if (e.key === 'ArrowLeft')  kbCol = Math.max(0, kbCol - 1);
      if (e.key === 'ArrowRight') kbCol = Math.min((rows[kbRow]?.cells.length || 1) - 1, kbCol + 1);

      navigateToCell(table, kbRow, kbCol);
    });

    // Click on cell to focus
    document.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (!td) return;
      const table = td.closest('table');
      if (!table || table.id !== 'annotationTable') return;

      // Clear previous focus unless Ctrl is held (multi-select)
      if (!e.ctrlKey && !e.metaKey) {
        table.querySelectorAll('td.kb-focus').forEach(cell => cell.classList.remove('kb-focus'));
      }

      td.classList.add('kb-focus');
      const row = td.parentElement;
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      kbRow = rows.indexOf(row);
      kbCol = Array.from(row.cells).indexOf(td);
    });
  }

  function navigateToCell(table, rowIdx, colIdx) {
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    
    // Wrap to next/prev row if out of bounds
    if (colIdx < 0 && rowIdx > 0) {
      rowIdx--;
      const prevRow = rows[rowIdx];
      colIdx = prevRow ? prevRow.cells.length - 1 : 0;
    } else if (colIdx >= (rows[rowIdx]?.cells.length || 0) && rowIdx < rows.length - 1) {
      rowIdx++;
      colIdx = 0;
    }

    // Clamp to valid range
    rowIdx = Math.max(0, Math.min(rows.length - 1, rowIdx));
    const targetRow = rows[rowIdx];
    if (!targetRow) return;
    colIdx = Math.max(0, Math.min(targetRow.cells.length - 1, colIdx));

    // Clear all highlights
    table.querySelectorAll('td.kb-focus').forEach(td => td.classList.remove('kb-focus'));

    // Apply new focus
    const cell = targetRow.cells[colIdx];
    if (cell) {
      cell.classList.add('kb-focus');
      cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      cell.focus();
      kbRow = rowIdx;
      kbCol = colIdx;
    }
  }

  // ===================================================================
  //  COPY / PASTE / DUPLICATE
  // ===================================================================
  function handleCopy(e) {
    const table = document.getElementById('annotationTable');
    if (!table) return;

    const focusedCells = Array.from(table.querySelectorAll('td.kb-focus'));
    if (focusedCells.length === 0) return;

    e.preventDefault();

    // Get cell values
    const values = focusedCells.map(td => {
      const input = td.querySelector('input, select');
      return input ? input.value : td.textContent.trim();
    });

    clipboard = values;
    focusedCells.forEach(td => {
      td.classList.remove('copied');
      // restart animation
      void td.offsetWidth;
      td.classList.add('copied');
    });

    // Copy to system clipboard as well
    const textToCopy = values.join('\t');
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', textToCopy);
    }
    navigator.clipboard.writeText(textToCopy).then(() => {
      showToast(`📋 Copied ${values.length} cell(s)`, 'info');
    }).catch(() => {
      showToast(`📋 Copied ${values.length} cell(s) (internal only)`, 'info');
    });
  }

  function handlePaste(e) {
    const table = document.getElementById('annotationTable');
    if (!table) return;

    const focusedCell = table.querySelector('td.kb-focus');
    if (!focusedCell) return;

    e.preventDefault();

    // Prefer clipboard payload from the current paste event
    const eventText = e.clipboardData?.getData('text/plain');
    if (eventText) {
      const values = eventText.split(/\r?\n|\t/).filter(v => v !== '');
      pasteValues(focusedCell, values.length ? values : [eventText]);
      return;
    }

    // Try to get from system clipboard first
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(text => {
      const values = text.split('\t');
      pasteValues(focusedCell, values.length === 1 ? clipboard || values : values);
      }).catch(() => {
        // Fall back to internal clipboard
        if (clipboard && clipboard.length > 0) {
          pasteValues(focusedCell, clipboard);
        }
      });
    } else if (clipboard && clipboard.length > 0) {
      pasteValues(focusedCell, clipboard);
    }
  }

  function pasteValues(startCell, values) {
    if (!values || values.length === 0) return;

    const table = startCell.closest('table');
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const startRow = startCell.parentElement;
    const startRowIdx = rows.indexOf(startRow);
    const startColIdx = Array.from(startRow.cells).indexOf(startCell);

    let pastedCount = 0;

    // If single value, paste to all focused cells
    const focusedCells = Array.from(table.querySelectorAll('td.kb-focus'));
    if (values.length === 1 && focusedCells.length > 1) {
      focusedCells.forEach(td => {
        if (setCellValue(td, values[0])) pastedCount++;
      });
    } else {
      // Paste values sequentially down the column
      for (let i = 0; i < values.length && startRowIdx + i < rows.length; i++) {
        const targetRow = rows[startRowIdx + i];
        const targetCell = targetRow.cells[startColIdx];
        if (targetCell && setCellValue(targetCell, values[i])) {
          pastedCount++;
        }
      }
    }

    if (pastedCount > 0) {
      showToast(`📥 Pasted to ${pastedCount} cell(s)`, 'success');
      // Trigger save
      if (typeof hasUnsavedChanges !== 'undefined') {
        hasUnsavedChanges = true;
      }
    }
  }

  function handleDuplicateDown(e) {
    const table = document.getElementById('annotationTable');
    if (!table) return;

    const focusedCell = table.querySelector('td.kb-focus');
    if (!focusedCell) return;

    const input = focusedCell.querySelector('input, select');
    const field = focusedCell.dataset.field;
    let value = input ? input.value : (focusedCell.textContent || '').trim();
    if (!input && field === 'old_dead') value = value.replace('%', '').trim();
    if (!input && field === 'juvenile') {
      if (value.toLowerCase() === 'yes') value = '-1';
      if (value.toLowerCase() === 'no') value = '0';
      if (value === '-') value = '';
    }
    if (!value) return;

    // Find all rows below and fill the same column
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const startRow = focusedCell.parentElement;
    const startRowIdx = rows.indexOf(startRow);
    const colIdx = Array.from(startRow.cells).indexOf(focusedCell);

    let filledCount = 0;
    for (let i = startRowIdx + 1; i < rows.length; i++) {
      const targetCell = rows[i].cells[colIdx];
      if (targetCell && setCellValue(targetCell, value)) {
        filledCount++;
      }
    }

    if (filledCount > 0) {
      showToast(`⬇ Duplicated "${value}" to ${filledCount} cell(s) below`, 'success');
      if (typeof hasUnsavedChanges !== 'undefined') {
        hasUnsavedChanges = true;
      }
    }
  }

  function setCellValue(td, value) {
    const input = td.querySelector('input');
    const select = td.querySelector('select');

    if (input) {
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } else if (select) {
      // Try to match the value or text
      const option = Array.from(select.options).find(opt => 
        opt.value === value || opt.text === value
      );
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    // Static table cell mode (most v2 cells render as text until edited)
    if (td.classList.contains('editable') && typeof window.makeTableCellEditable === 'function') {
      window.makeTableCellEditable(td);
      const editor = td.querySelector('input, select');
      if (!editor) return false;

      const rawValue = (value ?? '').toString().trim();
      if (editor.tagName === 'SELECT') {
        const option = Array.from(editor.options).find(opt => opt.value === rawValue || opt.text === rawValue);
        editor.value = option ? option.value : rawValue;
      } else {
        editor.value = rawValue === '-' ? '' : rawValue;
      }

      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    }

    return false;
  }

  function showToast(message, type) {
    if (typeof window.showStatus === 'function') {
      window.showStatus(message, type);
    } else {
      console.log(message);
    }
  }

  // ===================================================================
  //  BATCH FILL MODAL — fill a column for all (or selected) rows
  // ===================================================================
  function injectBatchFillModal() {
    const modal = document.createElement('div');
    modal.className = 'batch-fill-modal';
    modal.id = 'v2BatchFillModal';
    modal.innerHTML = `
      <div class="batch-fill-content">
        <h3>⬇ Batch Fill: <span id="batchFillColName"></span></h3>
        <div class="batch-scope">
          <label><input type="radio" name="batchScope" value="all" checked> All rows</label>
          <label><input type="radio" name="batchScope" value="empty"> Empty cells only</label>
        </div>
        <div class="batch-input-row">
          <div id="batchFillInputContainer" style="flex:1;"></div>
        </div>
        <div class="batch-fill-actions">
          <button class="btn btn-secondary" onclick="document.getElementById('v2BatchFillModal').classList.remove('active')">Cancel</button>
          <button class="btn btn-primary" id="batchFillApplyBtn">⬇ Apply to All</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });
  }

  let currentBatchField = null;

  function openBatchFillModal(field, label) {
    currentBatchField = field;
    document.getElementById('batchFillColName').textContent = label;
    const container = document.getElementById('batchFillInputContainer');

    // Build the appropriate input
    const dropdownFields = {
      morph_code: [
        { v: '', l: '- Select -' },
        { v: 'BR', l: 'BR - Branching' }, { v: 'CO', l: 'CO - Columnar' },
        { v: 'EN', l: 'EN - Encrusting' }, { v: 'FO', l: 'FO - Foliaceous' },
        { v: 'FL', l: 'FL - Free-living' }, { v: 'LA', l: 'LA - Laminar' },
        { v: 'MD', l: 'MD - Mounding' }, { v: 'MA', l: 'MA - Massive' },
        { v: 'PL', l: 'PL - Plating' }, { v: 'SM', l: 'SM - Submassive' },
        { v: 'SO', l: 'SO - Solitary' }, { v: 'TB', l: 'TB - Tabular' }
      ],
      transect: [
        { v: '', l: '- Select -' }, { v: 'A', l: 'A' }, { v: 'B', l: 'B' }
      ],
      segment: [
        { v: '', l: '- Select -' }, { v: '0', l: '0' }, { v: '5', l: '5' }, { v: '10', l: '10' }, { v: '15', l: '15' }
      ],
      juvenile: [
        { v: '0', l: 'No (0)' }, { v: '-1', l: 'Yes (-1)' }
      ]
    };

    if (dropdownFields[field]) {
      const options = dropdownFields[field].map(o => `<option value="${o.v}">${o.l}</option>`).join('');
      container.innerHTML = `<select id="batchFillValue" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">${options}</select>`;
    } else {
      container.innerHTML = `<input type="text" id="batchFillValue" placeholder="Enter value for all rows" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">`;
    }

    // Wire apply button
    document.getElementById('batchFillApplyBtn').onclick = () => applyBatchFill();

    document.getElementById('v2BatchFillModal').classList.add('active');
    setTimeout(() => document.getElementById('batchFillValue')?.focus(), 100);
  }

  function applyBatchFill() {
    if (!currentBatchField) return;
    const valueEl = document.getElementById('batchFillValue');
    if (!valueEl) return;
    let value = valueEl.value;

    // Check if uppercase mode is on (for text fields)
    const isAllCaps = document.body.classList.contains('v2-allcaps');
    if (isAllCaps && typeof value === 'string') {
      value = value.toUpperCase();
    }

    const scope = document.querySelector('input[name="batchScope"]:checked')?.value || 'all';

    if (typeof annotations === 'undefined') return;

    let count = 0;
    annotations.forEach((ann) => {
      const props = ann.properties || ann;
      const currentVal = props[currentBatchField] || '';

      if (scope === 'empty' && currentVal !== '') return; // skip non-empty

      props[currentBatchField] = value;
      // Also update flat top-level field so table display and Oracle save stay in sync
      ann[currentBatchField] = value;
      count++;
    });

    // Sync to layers
    if (typeof drawnItems !== 'undefined') {
      drawnItems.eachLayer(layer => {
        if (layer.annotationData) {
          const props = layer.annotationData.properties || layer.annotationData;
          if (scope === 'all' || !props[currentBatchField]) {
            props[currentBatchField] = value;
          }
        }
      });
    }

    // Mark unsaved
    if (typeof hasUnsavedChanges !== 'undefined') {
      hasUnsavedChanges = true;
    }

    // Update table
    if (typeof updateAnnotationTable === 'function') {
      updateAnnotationTable();
    }

    document.getElementById('v2BatchFillModal').classList.remove('active');

    // Show toast
    if (typeof showStatus === 'function') {
      showStatus(`⬇ Batch filled "${currentBatchField}" → "${value}" (${count} rows)`, 'success');
    }
  }

  // ===================================================================
  //  KEYBOARD SHORTCUTS HINT
  // ===================================================================
  function injectKeyboardHelpHint() {
    // Add small hint badge near the table
    const waitForTable = setInterval(() => {
      const table = document.getElementById('annotationTable');
      if (!table) return;
      clearInterval(waitForTable);

      if (document.getElementById('v2TableShortcutsHint')) return;

      const hint = document.createElement('div');
      hint.id = 'v2TableShortcutsHint';
      hint.className = 'kb-shortcuts-hint';
      const isCollapsed = localStorage.getItem('v2.tableShortcuts.collapsed') === '1';
      hint.innerHTML = `
        <div class="kb-shortcuts-header" style="display:flex; align-items:center; justify-content:space-between; gap:8px; cursor:pointer;">
          <div style="font-size: 11px; font-weight: 600;">⌨️ Table Shortcuts</div>
          <button type="button" id="v2TableShortcutsToggle" style="border:none; background:#fff; border-radius:4px; padding:2px 8px; font-size:11px; cursor:pointer;">${isCollapsed ? '▶' : '▼'}</button>
        </div>
        <div id="v2TableShortcutsBody" style="font-size: 10px; line-height: 1.6; color: rgba(0,0,0,0.7); margin-top:6px; ${isCollapsed ? 'display:none;' : ''}">
          <div><kbd>↑↓←→</kbd> Navigate • <kbd>Enter/Tab</kbd> Next cell</div>
          <div><kbd>Ctrl+C</kbd> Copy • <kbd>Ctrl+V</kbd> Paste • <kbd>Ctrl+D</kbd> Duplicate down</div>
          <div>Click <strong>⬇</strong> on header to batch-fill column</div>
        </div>
      `;

      // Insert above the table
      const container = table.closest('.annotation-table-container');
      if (container && container.parentElement) {
        container.parentElement.insertBefore(hint, container);
      }

      const toggleBtn = document.getElementById('v2TableShortcutsToggle');
      const body = document.getElementById('v2TableShortcutsBody');
      const setCollapsed = (collapsed) => {
        if (!toggleBtn || !body) return;
        body.style.display = collapsed ? 'none' : 'block';
        toggleBtn.textContent = collapsed ? '▶' : '▼';
        localStorage.setItem('v2.tableShortcuts.collapsed', collapsed ? '1' : '0');
      };

      hint.querySelector('.kb-shortcuts-header')?.addEventListener('click', (evt) => {
        evt.stopPropagation();
        const collapsedNow = body.style.display === 'none';
        setCollapsed(!collapsedNow);
      });

      // Expose for bulk mode automation
      window.setTableShortcutsCollapsed = setCollapsed;
    }, 300);
  }

  function initClipboardEvents() {
    document.addEventListener('copy', (e) => {
      const table = document.getElementById('annotationTable');
      if (!table || !table.querySelector('td.kb-focus')) return;
      handleCopy(e);
    });

    document.addEventListener('paste', (e) => {
      const table = document.getElementById('annotationTable');
      if (!table || !table.querySelector('td.kb-focus')) return;
      handlePaste(e);
    });
  }

  // ===================================================================
  //  ROW CHECKBOXES — multi-select for bulk update
  // ===================================================================
  function injectRowCheckboxes() {
    const table = document.getElementById('annotationTable');
    if (!table) return;
    const thead = table.querySelector('thead tr');
    if (!thead) return;

    // ── Header checkbox (only inject once — thead survives tbody rebuilds) ──
    if (!thead.querySelector('.row-select-th')) {
      const th = document.createElement('th');
      th.className = 'row-select-th';
      th.style.cssText = 'width:30px; min-width:30px; text-align:center; padding:4px;';
      const selectAllCb = document.createElement('input');
      selectAllCb.type = 'checkbox';
      selectAllCb.title = 'Select all rows';
      selectAllCb.style.cursor = 'pointer';
      selectAllCb.addEventListener('change', () => {
        const rows = table.querySelectorAll('tbody tr[data-index]');
        rows.forEach(row => {
          const idx = parseInt(row.dataset.index);
          const cb = row.querySelector('.row-select-cb');
          if (isNaN(idx) || !cb) return;
          cb.checked = selectAllCb.checked;
          if (selectAllCb.checked) { selectedRows.add(idx); row.classList.add('bulk-selected'); }
          else { selectedRows.delete(idx); row.classList.remove('bulk-selected'); }
        });
        updateSelectionUI();
      });
      th.appendChild(selectAllCb);
      thead.insertBefore(th, thead.firstChild);
    }

    // ── Body checkboxes (always re-inject — tbody is rebuilt each time) ──
    table.querySelectorAll('tbody tr[data-index]').forEach(row => {
      const idx = parseInt(row.dataset.index);
      if (isNaN(idx)) return;
      const td = document.createElement('td');
      td.style.cssText = 'text-align:center; padding:2px 4px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'row-select-cb';
      cb.dataset.index = idx;
      cb.checked = selectedRows.has(idx);
      cb.style.cursor = 'pointer';
      if (cb.checked) row.classList.add('bulk-selected');

      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey && _lastCheckedIdx >= 0) {
          // Shift+click: select visual range
          const allRows = Array.from(table.querySelectorAll('tbody tr[data-index]'));
          const lastPos = allRows.findIndex(r => parseInt(r.dataset.index) === _lastCheckedIdx);
          const currPos = allRows.findIndex(r => parseInt(r.dataset.index) === idx);
          if (lastPos >= 0 && currPos >= 0) {
            const lo = Math.min(lastPos, currPos), hi = Math.max(lastPos, currPos);
            for (let i = lo; i <= hi; i++) {
              const rIdx = parseInt(allRows[i].dataset.index);
              if (!isNaN(rIdx)) {
                selectedRows.add(rIdx);
                const rCb = allRows[i].querySelector('.row-select-cb');
                if (rCb) rCb.checked = true;
                allRows[i].classList.add('bulk-selected');
              }
            }
          }
        } else {
          if (cb.checked) { selectedRows.add(idx); row.classList.add('bulk-selected'); }
          else { selectedRows.delete(idx); row.classList.remove('bulk-selected'); }
        }
        _lastCheckedIdx = idx;
        updateSelectionUI();
      });
      td.appendChild(cb);
      row.insertBefore(td, row.firstChild);
    });

    // Handle the "no annotations" placeholder row (no data-index)
    table.querySelectorAll('tbody tr:not([data-index])').forEach(row => {
      const td = document.createElement('td');
      td.style.cssText = 'padding:0;';
      row.insertBefore(td, row.firstChild);
    });
  }

  function updateSelectionUI() {
    const bar = document.getElementById('v2SelectionBar');
    if (!bar) return;
    const count = selectedRows.size;
    const countEl = document.getElementById('v2SelectionCount');
    if (countEl) countEl.textContent = `${count} row${count !== 1 ? 's' : ''} selected`;
    bar.style.display = count > 0 ? 'flex' : 'none';

    // Update select-all checkbox
    const selectAllCb = document.querySelector('#annotationTable thead .row-select-th input');
    if (selectAllCb) {
      const total = document.querySelectorAll('#annotationTable tbody tr[data-index]').length;
      selectAllCb.checked = count > 0 && count >= total;
      selectAllCb.indeterminate = count > 0 && count < total;
    }
  }

  // ===================================================================
  //  SELECTION BAR — toolbar above table when rows are selected
  // ===================================================================
  function injectSelectionBar() {
    const waitFor = setInterval(() => {
      const tableContainer = document.querySelector('.annotation-table-container');
      if (!tableContainer) return;
      clearInterval(waitFor);
      if (document.getElementById('v2SelectionBar')) return;

      const bar = document.createElement('div');
      bar.id = 'v2SelectionBar';
      bar.style.cssText = 'display:none; align-items:center; gap:10px; padding:6px 12px; background:linear-gradient(135deg,#dbeafe,#ede9fe); border:1px solid #93c5fd; border-radius:6px; margin-bottom:6px; font-size:12px; font-weight:600; color:#1e40af;';
      bar.innerHTML = `
        <span id="v2SelectionCount">0 rows selected</span>
        <button id="v2BulkUpdateBtn" style="padding:4px 12px; background:#3b82f6; color:#fff; border:none; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer;">Bulk Update</button>
        <button id="v2ClearSelectionBtn" style="padding:4px 10px; background:#e2e8f0; color:#475569; border:1px solid #cbd5e1; border-radius:4px; font-size:11px; cursor:pointer;">Clear</button>
      `;
      tableContainer.parentElement.insertBefore(bar, tableContainer);

      document.getElementById('v2BulkUpdateBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        openBulkUpdateModal();
      });
      document.getElementById('v2ClearSelectionBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        selectedRows.clear();
        document.querySelectorAll('.row-select-cb').forEach(c => { c.checked = false; });
        document.querySelectorAll('#annotationTable tbody tr').forEach(r => r.classList.remove('bulk-selected'));
        updateSelectionUI();
      });
    }, 300);
  }

  // ===================================================================
  //  BULK UPDATE MODAL — update a field across selected rows
  // ===================================================================
  function injectBulkUpdateModal() {
    if (document.getElementById('v2BulkUpdateModal')) return;
    const modal = document.createElement('div');
    modal.className = 'batch-fill-modal';
    modal.id = 'v2BulkUpdateModal';
    modal.innerHTML = `
      <div class="batch-fill-content" style="max-width:440px;">
        <h3 style="margin:0 0 16px; font-size:16px; color:#1e293b;">
          Bulk Update <span id="bulkUpdateCount" style="color:#3b82f6;">0</span> rows
        </h3>
        <div style="margin-bottom:12px;">
          <label style="display:block; font-size:12px; font-weight:600; color:#374151; margin-bottom:4px;">Field to update:</label>
          <select id="bulkUpdateField" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;"></select>
        </div>
        <div style="margin-bottom:16px;">
          <label style="display:block; font-size:12px; font-weight:600; color:#374151; margin-bottom:4px;">New value:</label>
          <div id="bulkUpdateInputContainer"></div>
        </div>
        <div class="batch-fill-actions">
          <button class="btn btn-secondary" id="bulkUpdateCancelBtn">Cancel</button>
          <button class="btn btn-primary" id="bulkUpdateApplyBtn">Apply</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
    document.getElementById('bulkUpdateCancelBtn').addEventListener('click', () => modal.classList.remove('active'));
    document.getElementById('bulkUpdateApplyBtn').addEventListener('click', applyBulkUpdate);
    document.getElementById('bulkUpdateField').addEventListener('change', buildBulkUpdateInput);
  }

  function openBulkUpdateModal() {
    if (selectedRows.size === 0) return;
    document.getElementById('bulkUpdateCount').textContent = selectedRows.size;

    // Populate field dropdown from batchFill-able columns
    const select = document.getElementById('bulkUpdateField');
    select.innerHTML = COLUMNS
      .filter(c => c.batchFill)
      .map(c => `<option value="${c.field}">${c.label}</option>`)
      .join('');

    buildBulkUpdateInput();
    document.getElementById('bulkUpdateApplyBtn').textContent = `Apply to ${selectedRows.size} row${selectedRows.size !== 1 ? 's' : ''}`;
    document.getElementById('v2BulkUpdateModal').classList.add('active');
    setTimeout(() => document.getElementById('bulkUpdateValue')?.focus(), 100);
  }

  // ── Dropdown options shared with batch fill ──
  const _bulkDropdowns = {
    morph_code: [
      { v: '', l: '- Select -' },
      { v: 'BR', l: 'BR - Branching' }, { v: 'CO', l: 'CO - Columnar' },
      { v: 'EN', l: 'EN - Encrusting' }, { v: 'FO', l: 'FO - Foliaceous' },
      { v: 'FL', l: 'FL - Free-living' }, { v: 'LA', l: 'LA - Laminar' },
      { v: 'MD', l: 'MD - Mounding' }, { v: 'MA', l: 'MA - Massive' },
      { v: 'PL', l: 'PL - Plating' }, { v: 'SM', l: 'SM - Submassive' },
      { v: 'SO', l: 'SO - Solitary' }, { v: 'TB', l: 'TB - Tabular' }
    ],
    transect:  [{ v: '', l: '- Select -' }, { v: 'A', l: 'A' }, { v: 'B', l: 'B' }],
    segment:   [{ v: '', l: '- Select -' }, { v: '0', l: '0' }, { v: '5', l: '5' }, { v: '10', l: '10' }, { v: '15', l: '15' }],
    juvenile:  [{ v: '0', l: 'No (0)' }, { v: '-1', l: 'Yes (-1)' }],
    remnant:   [{ v: '0', l: 'No (0)' }, { v: '-1', l: 'Yes (-1)' }],
    ex_bound:  [{ v: '0', l: 'No (0)' }, { v: '-1', l: 'Yes (-1)' }],
    no_colony: [{ v: '0', l: 'No (0)' }, { v: '-1', l: 'Yes (-1)' }]
  };

  function buildBulkUpdateInput() {
    const field = document.getElementById('bulkUpdateField').value;
    const container = document.getElementById('bulkUpdateInputContainer');
    const inputStyle = 'width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;';

    if (_bulkDropdowns[field]) {
      container.innerHTML = `<select id="bulkUpdateValue" style="${inputStyle}">${
        _bulkDropdowns[field].map(o => `<option value="${o.v}">${o.l}</option>`).join('')
      }</select>`;
    } else if (field === 'spcode') {
      container.innerHTML = `
        <div style="position:relative;">
          <input type="text" id="bulkUpdateValue" placeholder="Search species code or name..." autocomplete="off" style="${inputStyle}">
          <div id="bulkUpdateSpDropdown" style="display:none; position:absolute; left:0; right:0; top:100%; z-index:10000; background:#fff; border:1px solid #d1d5db; border-radius:0 0 6px 6px; box-shadow:0 4px 12px rgba(0,0,0,0.15); max-height:200px; overflow-y:auto;"></div>
        </div>`;
      _setupBulkSpeciesAutocomplete();
    } else {
      container.innerHTML = `<input type="text" id="bulkUpdateValue" placeholder="Enter value" style="${inputStyle}">`;
    }
    setTimeout(() => document.getElementById('bulkUpdateValue')?.focus(), 50);
  }

  function _setupBulkSpeciesAutocomplete() {
    const input = document.getElementById('bulkUpdateValue');
    const dd = document.getElementById('bulkUpdateSpDropdown');
    if (!input || !dd) return;
    let timer = null, results = [], selIdx = 0;

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { dd.style.display = 'none'; return; }
      timer = setTimeout(() => {
        const fqs = typeof window.getSpeciesFilterQueryString === 'function' ? window.getSpeciesFilterQueryString() : '';
        fetch(`/api/coral/species/search?q=${encodeURIComponent(q)}&limit=10${fqs}`)
          .then(r => r.json())
          .then(data => {
            results = data.results || [];
            selIdx = 0;
            dd.innerHTML = results.length === 0
              ? '<div style="padding:8px 12px; color:#6b7280; font-size:12px;">No matches</div>'
              : results.map((sp, i) => `
                <div class="bu-sp-item${i === 0 ? ' bu-sp-sel' : ''}" data-i="${i}"
                     style="padding:6px 12px; cursor:pointer; font-size:12px; border-bottom:1px solid #f3f4f6;">
                  <strong style="color:#3b82f6;">${sp.code}</strong>
                  <span style="color:#374151;"> ${sp.taxon_name || sp.genus || ''}</span>
                  ${sp.scientific_name ? `<span style="color:#9ca3af; font-style:italic;"> ${sp.scientific_name}</span>` : ''}
                </div>`).join('');
            dd.querySelectorAll('.bu-sp-item').forEach(el => {
              el.addEventListener('click', () => { input.value = results[parseInt(el.dataset.i)].code; dd.style.display = 'none'; });
              el.addEventListener('mouseover', () => { dd.querySelectorAll('.bu-sp-item').forEach(x => x.classList.remove('bu-sp-sel')); el.classList.add('bu-sp-sel'); selIdx = parseInt(el.dataset.i); });
            });
            dd.style.display = 'block';
          }).catch(() => { dd.style.display = 'none'; });
      }, 300);
    });

    input.addEventListener('keydown', (e) => {
      if (dd.style.display === 'none') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); selIdx = Math.min(selIdx + 1, results.length - 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); selIdx = Math.max(selIdx - 1, 0); }
      else if (e.key === 'Enter' && results[selIdx]) { e.preventDefault(); input.value = results[selIdx].code; dd.style.display = 'none'; return; }
      else if (e.key === 'Escape') { dd.style.display = 'none'; return; }
      else return;
      dd.querySelectorAll('.bu-sp-item').forEach((el, i) => el.classList.toggle('bu-sp-sel', i === selIdx));
    });
  }

  function applyBulkUpdate() {
    const field = document.getElementById('bulkUpdateField').value;
    const valueEl = document.getElementById('bulkUpdateValue');
    if (!field || !valueEl) return;
    let value = valueEl.value;
    if (document.body.classList.contains('v2-allcaps') && typeof value === 'string') value = value.toUpperCase();
    if (typeof annotations === 'undefined') return;

    let count = 0;
    selectedRows.forEach(idx => {
      if (idx < 0 || idx >= annotations.length) return;
      const ann = annotations[idx];
      ann[field] = value;
      if (ann.properties) ann.properties[field] = value;
      count++;
    });

    // Sync to map layers, refresh labels, and update layer styles
    if (typeof drawnItems !== 'undefined') {
      const refreshLabels = typeof labelsVisible !== 'undefined' && labelsVisible
                         && typeof addLabelToAnnotation === 'function';
      drawnItems.eachLayer(layer => {
        if (!layer.annotationData) return;
        const annIdx = annotations.indexOf(layer.annotationData);
        if (annIdx >= 0 && selectedRows.has(annIdx)) {
          layer.annotationData[field] = value;
          if (layer.annotationData.properties) layer.annotationData.properties[field] = value;
          if (refreshLabels) addLabelToAnnotation(layer);
          // Update layer color when species completeness changes (orange ↔ blue)
          if (field === 'spcode' && layer.setStyle && typeof getAnnotationLayerStyle === 'function') {
            layer.setStyle(getAnnotationLayerStyle(layer.annotationData));
          }
        }
      });
    }

    if (typeof hasUnsavedChanges !== 'undefined') hasUnsavedChanges = true;
    if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
    document.getElementById('v2BulkUpdateModal').classList.remove('active');
    if (typeof showStatus === 'function') showStatus(`Updated "${field}" on ${count} row${count !== 1 ? 's' : ''}`, 'success');
  }

  // ===================================================================
  //  INIT
  // ===================================================================
  function init() {
    // Inject styles for multi-select and bulk update
    const style = document.createElement('style');
    style.textContent = `
      tr.bulk-selected { background: #eff6ff !important; }
      tr.bulk-selected:hover { background: #dbeafe !important; }
      .bu-sp-sel { background: #eff6ff !important; }
      .v2-row-cb { width: 16px; height: 16px; cursor: pointer; accent-color: #3b82f6; }
    `;
    document.head.appendChild(style);

    initSortableHeaders();
    injectTableSizeControls();
    injectColumnPicker();
    initArrowKeyNav();
    initClipboardEvents();
    injectBatchFillModal();
    injectSelectionBar();
    injectBulkUpdateModal();
    // Apply initial column visibility
    setTimeout(applyColumnVisibility, 150);
    console.log('🔧 v2-table.js loaded — Sort, Resize, Column Picker, Arrow Keys, Copy/Paste, Batch Fill, Multi-Select');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Delay slightly to let v1 modules register first
    setTimeout(init, 100);
  }

})();
